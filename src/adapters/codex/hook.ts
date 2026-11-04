/**
 * Codex hook 的唯一入口：stdin 读一个 JSON，按 `hook_event_name` 分发，需要时向 stdout 写一行 JSON。
 * hook 是一次性进程，每次都重新读配置。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { checkPassed, renderCheckReport, runEndCheck } from "../../core/check.js";
import { loadProjectConfig, type ProjectConfig } from "../../core/config.js";
import { repoToplevel } from "../../core/gitstate.js";
import { recordEvent, recordUsage } from "../../core/meter.js";
import { isNotFound, realpathOr, resolveWriteTarget } from "../../core/paths.js";
import { isProtected } from "../../core/protect.js";
import { sessionSection } from "../../roles/prompts.js";
import { patchPaths } from "./patch.js";

/** hooks.json 给 Stop 的 timeout 是 3600 秒，留 30 秒给 hook 自身收尾。 */
const MAX_CHECK_TIMEOUT_S = 3570;

interface HookInput {
  hook_event_name?: string;
  cwd?: string;
  session_id?: string;
  model?: string;
  stop_hook_active?: boolean;
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
  const check = project?.check ?? null;
  if (check === null) return null;
  try {
    const timeout = Math.min(check.timeout_s, MAX_CHECK_TIMEOUT_S);
    const started = Date.now();
    const outcome = await runEndCheck({ repo: root, check: { ...check, timeout_s: timeout } });
    const passed = checkPassed(outcome);
    const final = input.stop_hook_active === true;
    let report = renderCheckReport(outcome, { command: check.cmd.join(" "), final });
    if (timeout < check.timeout_s) {
      report += `\n[counterweight] check.timeout_s=${check.timeout_s} 超过上限，实际超时 ${timeout}s`;
    }
    // A meter failure must not discard the check's conclusion.
    await recordEvent(root, input.session_id ?? "", "check", {
      exit_code: outcome.exitCode,
      timed_out: outcome.timedOut,
      spawn_error: outcome.runnerError,
      ms: Date.now() - started,
      outcome: outcome.runnerError !== null ? "spawn_error" : passed ? "passed" : !final ? "feedback" : "reported",
    }).catch(() => {});
    if (passed || final) return { systemMessage: report };
    return { decision: "block", reason: report };
  } catch (error) {
    return { systemMessage: `[counterweight] 结束检查未能完成，本轮没有得到检查结论：${message(error)}` };
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
