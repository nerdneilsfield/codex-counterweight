/**
 * Codex hook 的唯一入口：stdin 读一个 JSON，按 `hook_event_name` 分发，需要时向 stdout 写一行 JSON。
 * hook 是一次性进程，每次都重新读配置。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadProjectConfig, type ProjectConfig } from "../../core/config.js";
import { checkPaths, endCheck, pausePlan } from "../../core/flow.js";
import { repoToplevel } from "../../core/gitstate.js";
import { recordUsage } from "../../core/meter.js";
import { realpathOr } from "../../core/paths.js";
import { renderTranscript } from "../../core/pause.js";
import { claim, endSession, loadActions, loadPrompt, recordAction, savePrompt } from "../../core/turnstate.js";
import { sessionSection } from "../../roles/prompts.js";
import { patchPaths } from "./patch.js";
import { runRole } from "./runner.js";
import { parseTranscript } from "./transcript.js";

interface HookInput {
  hook_event_name?: string;
  cwd?: string;
  session_id?: string;
  model?: string;
  turn_id?: string;
  tool_name?: string;
  prompt?: string;
  agent_id?: string;
  transcript_path?: string;
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
    project = await loadProjectConfig(root, "codex.toml");
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

const SHELL_TOOLS = new Set(["Bash", "exec_command", "shell_command"]);

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
    project = await loadProjectConfig(root, "codex.toml");
  } catch {
    return null;
  }
  if (project === null) return null;
  const command = input.tool_input?.command;
  const session = input.session_id ?? "";
  const turn = input.turn_id ?? "";
  // 根线程的 shell 命令只记录，不过保护和 PAUSE。
  if (input.tool_name !== undefined && SHELL_TOOLS.has(input.tool_name)) {
    if (input.agent_id === undefined && typeof command === "string" && command !== "") {
      await recordAction(session, turn, { tool: "bash", detail: command });
    }
    return null;
  }
  const paths = typeof command === "string" ? patchPaths(command) : [];
  const refusal = await checkPaths(root, cwd, project, paths);
  if (refusal !== null) return deny(refusal);
  // PAUSE 只在根线程拦；子代理的调用也不记。
  if (input.agent_id !== undefined) return null;
  const plan = await pausePlan({
    root, cwd: await realpathOr(cwd), project, session, paths,
    tool: "apply_patch", input: { command },
    runner: runRole, signal: new AbortController().signal,
    claim: () => claim(session, turn, "pause"),
    transcript: async () => renderTranscript(parseTranscript(await readFile(input.transcript_path ?? "", "utf8"))),
  });
  if (plan !== null) return deny(plan);
  for (const target of paths) await recordAction(session, turn, { tool: "apply_patch", detail: target });
  return null;
}

async function stop(root: string, input: HookInput): Promise<Output> {
  let project: ProjectConfig | null;
  try {
    project = await loadProjectConfig(root, "codex.toml");
  } catch (error) {
    return { systemMessage: `[counterweight] 配置非法，未运行检查：${message(error)}` };
  }
  if (project === null) return null;
  const session = input.session_id ?? "";
  const turn = input.turn_id ?? "";
  const result = await endCheck({
    root, project, session, runner: runRole, signal: new AbortController().signal,
    claim: (name) => claim(session, turn, name),
    prompt: () => loadPrompt(session, turn),
    actions: () => loadActions(session, turn),
  });
  if (result.continueWith !== null) {
    return { decision: "block", reason: result.continueWith, systemMessage: result.report ?? undefined };
  }
  return result.report === null ? null : { systemMessage: result.report };
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
