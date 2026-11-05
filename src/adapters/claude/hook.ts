/**
 * Claude Code hook 的唯一入口：stdin 读一个 JSON，按 `hook_event_name` 分发，需要时向 stdout 写一行 JSON。
 * hook 是一次性进程，每次都重新读配置。回合用 `prompt_id` 标识。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { snapshotTree } from "../../core/auto.js";
import { dangerousCommand } from "../../core/danger.js";
import { loadProjectConfig, type ProjectConfig } from "../../core/config.js";
import { checkGoalPaths, checkPaths, checkScopePaths, endCheck, missingCheckNotice, pausePlan } from "../../core/flow.js";
import { repoToplevel } from "../../core/gitstate.js";
import { recordUsage } from "../../core/meter.js";
import { realpathOr } from "../../core/paths.js";
import { renderTranscript } from "../../core/pause.js";
import { goalUpdate, readGoal, rememberGoal } from "../../core/goal.js";
import { claim, endSession, loadActions, loadBase, loadPrompt, loadSeen, markSeen, recordAction, saveBase, savePrompt } from "../../core/turnstate.js";
import { sessionSection, withGoal } from "../../roles/prompts.js";
import { runRole } from "./runner.js";
import { assistantUsage, parseTranscript } from "./transcript.js";

interface HookInput {
  hook_event_name?: string;
  source?: string;
  cwd?: string;
  session_id?: string;
  prompt_id?: string;
  prompt?: string;
  agent_id?: string;
  transcript_path?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

type Output = Record<string, unknown> | null;

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as HookInput;
  const cwd = input.cwd ?? process.cwd();
  const root = await realpathOr(await repoToplevel(cwd) ?? cwd);
  let output: Output = null;
  switch (input.hook_event_name) {
    case "SessionStart": output = await sessionStart(root, input.session_id ?? "", input.source); break;
    case "PreToolUse": output = await preToolUse(root, cwd, input); break;
    case "Stop":
      await meter(root, input);
      output = await stop(root, input);
      break;
    case "UserPromptSubmit": output = await userPrompt(root, input); break;
    case "SessionEnd":
      await meter(root, input);
      await endSession(input.session_id ?? "").catch(() => {});
      break;
  }
  if (output !== null) process.stdout.write(`${JSON.stringify(output)}\n`);
}

async function userPrompt(root: string, input: HookInput): Promise<Output> {
  const session = input.session_id ?? "";
  const turn = input.prompt_id ?? "";
  await savePrompt(session, turn, input.prompt ?? "").catch(() => {});
  // 回合基线：只有审查或汇报打开时才用得上。取不到就不存，收尾时退回 HEAD。
  try {
    const project = await loadProjectConfig(root, "claude.toml");
    if (project !== null && (project.auto.review || project.auto.chronicle)) {
      const base = await snapshotTree(root);
      if (base !== null) await saveBase(session, turn, base);
    }
  } catch {
    // Without a baseline the review falls back to HEAD.
  }
  const additionalContext = await goalUpdate(root, session).catch(() => null);
  return additionalContext === null ? null : { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext } };
}

async function sessionStart(root: string, session: string, source: string | undefined): Promise<Output> {
  const notes: string[] = [];
  let project: ProjectConfig | null = null;
  try {
    project = await loadProjectConfig(root, "claude.toml");
    // 只在会话真正开始时提示；compact 是同一个会话，不再重复。
    const missing = source === "startup" || source === "clear" ? missingCheckNotice(project, "/counterweight:cw-setup") : null;
    if (missing !== null) notes.push(missing);
    for (const item of project?.autoSkipped ?? []) {
      notes.push(`[counterweight] [auto].${item} 已打开但 .cw/claude.toml 没配对应模型，该项视为关闭`);
    }
  } catch (error) {
    notes.push(`[counterweight] 配置非法：${message(error)}`);
  }
  const goal = await readGoal(root);
  await rememberGoal(session, goal);
  const output: Record<string, unknown> = {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: `${withGoal(sessionSection(project?.auto ?? { review: false, chronicle: false }), goal)}\n\nCounterweight ${await pluginVersion()} active`,
    },
  };
  if (notes.length > 0) output.systemMessage = notes.join("\n");
  return output;
}

async function pluginVersion(): Promise<string> {
  try {
    const manifest = JSON.parse(await readFile(
      path.join(process.env.CLAUDE_PLUGIN_ROOT ?? "", ".claude-plugin/plugin.json"), "utf8")) as { version?: unknown };
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
  const target = input.tool_input?.[input.tool_name === "NotebookEdit" ? "notebook_path" : "file_path"];
  const paths = typeof target === "string" && target !== "" ? [target] : [];
  // 高危命令、goal.md 和 scope.txt 不用配置也生效：goal.md 不用配置也会被注入，所以配置缺失或非法时也不许改它。
  if (input.tool_name === "Bash") {
    const command = input.tool_input?.command;
    const danger = typeof command === "string" ? dangerousCommand(command) : null;
    if (danger !== null) return deny(danger);
  } else {
    const goal = await checkGoalPaths(root, cwd, paths) ?? await checkScopePaths(root, cwd, paths);
    if (goal !== null) return deny(goal);
  }
  let project: ProjectConfig | null;
  try {
    project = await loadProjectConfig(root, "claude.toml");
  } catch {
    return null;
  }
  if (project === null) return null;
  const session = input.session_id ?? "";
  const turn = input.prompt_id ?? "";
  // 主代理的 Bash 命令只记录，不过保护和 PAUSE。
  if (input.tool_name === "Bash") {
    const command = input.tool_input?.command;
    if (input.agent_id === undefined && typeof command === "string" && command !== "") {
      await recordAction(session, turn, { tool: "bash", detail: command });
    }
    return null;
  }
  const refusal = await checkPaths(root, cwd, project, paths);
  if (refusal !== null) return deny(refusal);
  // PAUSE 只在主代理拦；子代理的调用也不记。
  if (input.agent_id !== undefined) return null;
  const plan = await pausePlan({
    root, cwd: await realpathOr(cwd), project, session, paths,
    tool: input.tool_name ?? "", input: input.tool_input ?? {},
    runner: runRole, signal: new AbortController().signal,
    claim: () => claim(session, turn, "pause"),
    transcript: async () => renderTranscript(parseTranscript(await readFile(input.transcript_path ?? "", "utf8"))),
  });
  if (plan !== null) return deny(plan);
  for (const file of paths) await recordAction(session, turn, { tool: input.tool_name ?? "", detail: file });
  return null;
}

async function stop(root: string, input: HookInput): Promise<Output> {
  let project: ProjectConfig | null;
  try {
    project = await loadProjectConfig(root, "claude.toml");
  } catch (error) {
    return { systemMessage: `[counterweight] 配置非法，未运行检查：${message(error)}` };
  }
  if (project === null) return null;
  const session = input.session_id ?? "";
  const turn = input.prompt_id ?? "";
  const result = await endCheck({
    root, project, session, runner: runRole, signal: new AbortController().signal,
    claim: (name) => claim(session, turn, name),
    prompt: () => loadPrompt(session, turn),
    actions: () => loadActions(session, turn),
    base: () => loadBase(session, turn),
  });
  if (result.continueWith !== null) {
    return { decision: "block", reason: result.continueWith, systemMessage: result.report ?? undefined };
  }
  return result.report === null ? null : { systemMessage: result.report };
}

/**
 * 没有用量 hook，所以读 transcript：每个助手消息 id 只记一次，已记的 id 存在 session 目录。
 * `Stop` 时 transcript 可能缺最后一条，它会在下一次扫描记上。失败不影响主流程，也不把 id 标成已记。
 */
async function meter(root: string, input: HookInput): Promise<void> {
  try {
    const session = input.session_id ?? "";
    const seen = await loadSeen(session);
    if (seen === null) return;
    const samples = assistantUsage(await readFile(input.transcript_path ?? "", "utf8"));
    for (const sample of samples) {
      if (seen.has(sample.id)) continue;
      try {
        await recordUsage(root, {
          time: sample.time,
          session,
          model: sample.model,
          input: sample.input,
          output: sample.output,
          cache_read: sample.cacheRead,
          cache_write: sample.cacheWrite,
          cost_total: null,
        });
        await markSeen(session, sample.id);
      } catch {
        // Observational only.
      }
    }
  } catch {
    // Observational only.
  }
}

main().then(() => process.exit(0), (error: unknown) => {
  process.stderr.write(`[counterweight] ${message(error)}\n`);
  process.exit(0);
});
