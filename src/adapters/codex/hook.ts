/**
 * Codex hook 的唯一入口：stdin 读一个 JSON，按 `hook_event_name` 分发，需要时向 stdout 写一行 JSON。
 * hook 是一次性进程，每次都重新读配置。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { changedFiles, chronicleReport, workingDiff } from "../../core/auto.js";
import { checkPassed, renderCheckReport, runEndCheck } from "../../core/check.js";
import { loadProjectConfig, type ProjectConfig } from "../../core/config.js";
import { repoToplevel } from "../../core/gitstate.js";
import { recordEvent, recordUsage } from "../../core/meter.js";
import { isNotFound, realpathOr, resolveWriteTarget } from "../../core/paths.js";
import { isProtected } from "../../core/protect.js";
import { claim, endSession, loadPrompt, savePrompt } from "../../core/turnstate.js";
import { sessionSection } from "../../roles/prompts.js";
import { chronicle, reviewMessage, runAndMeter, type RoleContext } from "../../roles/tools.js";
import { patchPaths } from "./patch.js";

/** hooks.json 给 Stop 的 timeout 是 7200 秒：检查最多 3570 秒，自动运行最多 3600 秒（每个角色有自己的超时）。 */
const MAX_CHECK_TIMEOUT_S = 3570;

interface HookInput {
  hook_event_name?: string;
  cwd?: string;
  session_id?: string;
  model?: string;
  turn_id?: string;
  prompt?: string;
  agent_id?: string;
  tool_input?: { command?: unknown };
  status?: string;
  token_usage?: {
    input_tokens: number;
    cached_input_tokens: number;
    cache_write_input_tokens: number;
    output_tokens: number;
  };
}

type Output = Record<string, unknown> | null;

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

const PROTECTED_REASON = (relative: string) => `[counterweight] ${relative} 是受保护路径`
  + "（.cw/project.toml、.cw/codex.toml 或项目配置 [protect].paths）；如需修改请由用户手动完成。";

const UNVERIFIABLE_REASON = (value: string) =>
  `[counterweight] 路径无法核对受保护集合（符号链接逃逸仓库或不可解析），已拒绝：${value}`;

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as HookInput;
  const cwd = input.cwd ?? process.cwd();
  const root = await realpathOr(await repoToplevel(cwd) ?? cwd);
  let output: Output = null;
  switch (input.hook_event_name) {
    case "SessionStart": output = await sessionStart(root); break;
    case "PreToolUse": output = await preToolUse(root, cwd, input); break;
    case "Stop": output = await stop(root, input); break;
    case "UserPromptSubmit":
      await savePrompt(input.session_id ?? "", input.turn_id ?? "", input.prompt ?? "").catch(() => {});
      break;
    case "SessionEnd": await endSession(input.session_id ?? "").catch(() => {}); break;
    case "PostModelRequest": await postModelRequest(root, input); break;
  }
  if (output !== null) process.stdout.write(`${JSON.stringify(output)}\n`);
}

async function sessionStart(root: string): Promise<Output> {
  const notes: string[] = [];
  let project: ProjectConfig | null = null;
  try {
    project = await loadProjectConfig(root);
    for (const item of project?.autoSkipped ?? []) {
      notes.push(`[counterweight] [auto].${item} 已打开但 .cw/codex.toml 没配对应模型，该项视为关闭`);
    }
    if (project?.sandbox === "none") notes.push("[counterweight] 角色子进程没有沙箱（.cw/codex.toml [roles].sandbox = \"none\"）");
  } catch (error) {
    notes.push(`[counterweight] 配置非法：${message(error)}`);
  }
  const output: Record<string, unknown> = {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: `${sessionSection(project?.auto ?? { review: false, chronicle: false })}\n\nCounterweight ${await pluginVersion()} active`,
    },
  };
  if (notes.length > 0) output.systemMessage = notes.join("\n");
  return output;
}

async function pluginVersion(): Promise<string> {
  try {
    const manifest = JSON.parse(await readFile(
      path.join(process.env.PLUGIN_ROOT ?? "", ".codex-plugin/plugin.json"), "utf8")) as { version?: unknown };
    return typeof manifest.version === "string" ? manifest.version : "unknown";
  } catch {
    return "unknown";
  }
}

const deny = (reason: string): Output => ({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: reason,
  },
});

async function preToolUse(root: string, cwd: string, input: HookInput): Promise<Output> {
  let project: ProjectConfig | null;
  try {
    project = await loadProjectConfig(root);
  } catch {
    return null;
  }
  if (project === null) return null;
  try {
    const command = input.tool_input?.command;
    const paths = typeof command === "string" ? patchPaths(command) : [];
    if (paths.length === 0) return deny("[counterweight] 无法从补丁中解析出路径，无法核对受保护集合，已拒绝。");
    const realCwd = await realpathOr(cwd);
    const reasons: string[] = [];
    for (const raw of paths) {
      const reason = await checkProtectedTarget(root, realCwd, project.protect.paths, raw);
      if (reason !== null) reasons.push(reason);
    }
    return reasons.length > 0 ? deny(reasons.join("\n")) : null;
  } catch (error) {
    return deny(`[counterweight] 保护检查出错，已拒绝：${message(error)}`);
  }
}

/** 返回拒绝理由；放行返回 null。语义与 pi 版 checkProtectedTarget 相同。 */
async function checkProtectedTarget(
  root: string, cwd: string, patterns: readonly string[], raw: string,
): Promise<string | null> {
  const lexical = toRepoRelative(root, cwd, raw);
  if (lexical === null) return `[counterweight] 路径不在仓库内，无法核对受保护集合，已拒绝：${raw}`;
  if (isProtected(lexical, patterns)) return PROTECTED_REASON(lexical);
  let resolved: string;
  try {
    resolved = await resolveWriteTarget(root, lexical);
  } catch (error) {
    // Nothing on the path exists: a new file, already judged lexically.
    if (isNotFound(error)) return null;
    return UNVERIFIABLE_REASON(raw);
  }
  if (isProtected(resolved, patterns)) {
    const via = resolved === lexical ? "" : `（路径 ${raw} 指向该受保护文件）`;
    return `${PROTECTED_REASON(resolved)}${via}`;
  }
  return null;
}

function toRepoRelative(repoRoot: string, cwd: string, value: string): string | null {
  const relative = path.relative(repoRoot, path.resolve(cwd, value));
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join("/");
}

async function stop(root: string, input: HookInput): Promise<Output> {
  let project: ProjectConfig | null;
  try {
    project = await loadProjectConfig(root);
  } catch (error) {
    return { systemMessage: `[counterweight] 配置非法，未运行检查：${message(error)}` };
  }
  if (project === null) return null;
  const session = input.session_id ?? "";
  const turn = input.turn_id ?? "";
  const texts: string[] = [];
  let checkReport: string | null = null;
  if (project.check !== null) {
    try {
      const check = project.check;
      const timeout = Math.min(check.timeout_s, MAX_CHECK_TIMEOUT_S);
      const started = Date.now();
      const outcome = await runEndCheck({ repo: root, check: { ...check, timeout_s: timeout } });
      const passed = checkPassed(outcome);
      // 失败时第一次让模型修，额度用完后如实报告。
      const retry = !passed && await claim(session, turn, "repair");
      let report = renderCheckReport(outcome, { command: check.cmd.join(" "), final: !passed && !retry });
      if (timeout < check.timeout_s) {
        report += `\n[counterweight] check.timeout_s=${check.timeout_s} 超过上限，实际超时 ${timeout}s`;
      }
      // A meter failure must not discard the check's conclusion.
      await recordEvent(root, session, "check", {
        exit_code: outcome.exitCode,
        timed_out: outcome.timedOut,
        spawn_error: outcome.runnerError,
        ms: Date.now() - started,
        outcome: outcome.runnerError !== null ? "spawn_error" : passed ? "passed" : retry ? "feedback" : "reported",
      }).catch(() => {});
      if (retry) return { decision: "block", reason: report };
      checkReport = report;
    } catch (error) {
      checkReport = `[counterweight] 结束检查未能完成，本轮没有得到检查结论：${message(error)}`;
    }
    texts.push(checkReport);
  }
  const auto = await runAuto(root, project, session, turn, checkReport);
  // 审查发现续跑时，检查报告留在 systemMessage，发现作为 reason 交回模型。
  if (auto.findings !== null) return { decision: "block", reason: auto.findings, systemMessage: checkReport ?? undefined };
  if (auto.text !== null) texts.push(auto.text);
  return texts.length === 0 ? null : { systemMessage: texts.join("\n\n") };
}

/**
 * 收尾时的自动审查与汇报，只在 `[auto]` 打开时有动作。review 与 over_review 并行，只报告，不决定检查是否通过。
 * 有发现且本回合还没续跑过：发现作为 `findings` 交回模型续跑一次；额度用完只显示。任何失败都只是不产生文字，
 * 绝不改变检查结论。
 */
async function runAuto(
  root: string, project: ProjectConfig, session: string, turn: string, checkLine: string | null,
): Promise<{ text: string | null; findings: string | null }> {
  const none = { text: null, findings: null };
  try {
    if (!project.auto.review && !project.auto.chronicle) return none;
    const diff = await workingDiff(root);
    if (diff === null || diff.trim() === "") return none;
    const ctx: RoleContext = { repo: root, session, project };
    const signal = new AbortController().signal;
    if (project.auto.review) {
      const prompt = await loadPrompt(session, turn);
      const body = reviewMessage({ request: prompt, diff });
      const [correct, over] = await Promise.all([
        runAndMeter(ctx, "review", "cw_review", project.models.review!, body, signal),
        runAndMeter(ctx, "over_review", "cw_over_review", project.models.over_review!, body, signal),
      ]);
      const findings = [correct, over]
        .map((run) => run.answer?.trim() ?? "")
        .filter((answer) => answer !== "" && answer !== "none" && !answer.startsWith("ASK:"));
      if (findings.length > 0) {
        if (await claim(session, turn, "findings")) {
          return { text: null, findings: `[counterweight] 自动审查有发现，处理或说明为什么不处理：\n\n${findings.join("\n\n")}` };
        }
        return { text: `[counterweight] 自动审查（续跑之后）仍有发现，不再续跑：\n\n${findings.join("\n\n")}`, findings: null };
      }
    }
    if (project.auto.chronicle) {
      const report = chronicleReport(await loadPrompt(session, turn), changedFiles(diff), checkLine);
      await chronicle(ctx, project.models.historian!, report, signal);
    }
    return none;
  } catch {
    return none;
  }
}

async function postModelRequest(root: string, input: HookInput): Promise<void> {
  const usage = input.token_usage;
  if (input.status !== "completed" || usage === undefined) return;
  try {
    await recordUsage(root, {
      time: new Date().toISOString(),
      session: input.session_id ?? "",
      model: input.model ?? "",
      input: usage.input_tokens - usage.cached_input_tokens,
      output: usage.output_tokens,
      cache_read: usage.cached_input_tokens,
      cache_write: usage.cache_write_input_tokens,
      cost_total: null,
    });
  } catch {
    // Observational only.
  }
}

main().then(() => process.exit(0), (error: unknown) => {
  process.stderr.write(`[counterweight] ${message(error)}\n`);
  process.exit(0);
});
