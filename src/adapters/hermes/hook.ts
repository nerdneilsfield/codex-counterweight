/**
 * Hermes 插件的 Node 入口：`__init__.py` 把 Hermes 的插件钩子连同会话工作目录和钩子时间预算转成一个 JSON，
 * 从 stdin 交给本进程，本进程把 Hermes 的返回值写到 stdout。钩子是一次性进程，每次都重新读配置。
 * 和别的宿主的差别，都是实测的：
 * - 项目根目录：钩子在 gateway 进程里跑，进程目录是 Hermes 的目录；Python 侧用 `resolve_agent_cwd()` 给出会话目录，
 *   拿不到时退到工具路径（`changed_paths`、绝对路径、`workdir`）所在的仓库，再拿不到就不猜，记一条 gap；
 * - 结束检查只挂在 `pre_verify`（本回合改过代码才触发），纯问答回合没有检查；它被 `plugins.hook_callback_timeout`
 *   限制（默认 30 秒，最大 600），超时 Hermes 放行，所以检查和角色的时间上限按这个预算折算；
 * - `pre_verify` 带 `attempt`，续跑后会再触发一次，所以检查修复和审查发现各有一次，`attempt` 到 2 不再续跑；
 * - 没有显示渠道：回合结束的报告存下来，在下一个回合的 `pre_llm_call` 上下文里交付；
 * - 用量来自 `post_api_request`，按 `api_request_id` 去重；回合结束事件来自 `on_session_end`。
 * 环境里有 `CW_ROLE=1`（角色会话，由 Python 侧按提示首行标记）时直接退出。
 */
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { snapshotTree } from "../../core/auto.js";
import { writeChronicleEvent, type ChronicleInput } from "../../core/chronicle-event.js";
import { dangerousCommandIn } from "../../core/danger.js";
import { loadProjectConfig, type ProjectConfig } from "../../core/config.js";
import { checkGoalPaths, checkPaths, checkScopePaths, endCheck, missingCheckNotice, pausePlan, type EndCheckLimits } from "../../core/flow.js";
import { repoToplevel } from "../../core/gitstate.js";
import { goalUpdate, readGoal, rememberGoal } from "../../core/goal.js";
import { recordEvent, recordUsage } from "../../core/meter.js";
import { realpathOr } from "../../core/paths.js";
import { pendingCount, withPending } from "../../core/pending.js";
import { renderTranscript, type TranscriptMessage } from "../../core/pause.js";
import { inRole } from "../../core/role.js";
import {
  appendTurnLine, claim, endSession, getSessionText, loadActions, loadBase, loadPrompt, loadSeen, loadTurnLines, markSeen,
  putSessionText, recordAction, saveBase, savePrompt, takeSessionText,
} from "../../core/turnstate.js";
import { goalPart, sessionSection, withGoal } from "../../roles/prompts.js";
import { patchPaths } from "../codex/patch.js";
import { runRole } from "./runner.js";

interface HookInput {
  hook?: string;
  /** Python 侧 `resolve_agent_cwd()` 的结果；解析不出来是空串。 */
  cwd?: string;
  /** 钩子的时间预算（秒），即 `plugins.hook_callback_timeout`。 */
  budget_s?: number;
  session_id?: string;
  task_id?: string;
  turn_id?: string;
  user_message?: unknown;
  conversation_history?: unknown;
  is_first_turn?: boolean;
  tool_name?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  attempt?: number;
  changed_paths?: unknown;
  usage?: Record<string, unknown>;
  api_request_id?: string;
  model?: string;
  ended_at?: number;
  completed?: boolean;
  interrupted?: boolean;
  turn_exit_reason?: string;
}

type Output = Record<string, unknown> | null;

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** 检查最多取预算的一半，角色取 0.4，各自不超过 Kimi 同款的 300 和 270 秒；Hermes 的预算最大 600。 */
export function hermesLimits(budgetS: number | undefined): EndCheckLimits {
  const budget = typeof budgetS === "number" && Number.isFinite(budgetS) && budgetS > 0 ? budgetS : 30;
  return { checkTimeoutS: Math.max(1, Math.min(300, Math.floor(budget / 2))), roleTimeoutS: Math.max(1, Math.min(270, Math.floor(budget * 0.4))) };
}

async function existingDir(candidate: string): Promise<string | null> {
  let current = path.resolve(candidate);
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      if ((await stat(current)).isDirectory()) return current;
    } catch {
      // Walk up to the nearest directory that exists (a file the model is about to create).
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

/** 工具路径提示：绝对路径、`terminal` 的 `workdir`、`pre_verify` 的 `changed_paths`。相对路径没有意义，不收。 */
function pathHints(input: HookInput): string[] {
  const hints: unknown[] = [];
  if (Array.isArray(input.changed_paths)) hints.push(...input.changed_paths);
  hints.push(input.args?.path, input.args?.workdir);
  if (typeof input.args?.patch === "string") hints.push(...patchPaths(input.args.patch));
  return hints.filter((hint): hint is string => typeof hint === "string" && path.isAbsolute(hint));
}

/** 项目根目录：先取会话目录所在的仓库，再取工具路径所在的仓库；都不在仓库里就是 null，不猜。 */
export async function resolveRoot(input: HookInput): Promise<string | null> {
  const candidates = [input.cwd ?? "", ...pathHints(input)].filter((candidate) => candidate !== "" && path.isAbsolute(candidate));
  for (const candidate of candidates) {
    const dir = await existingDir(candidate);
    const top = dir === null ? null : await repoToplevel(dir);
    if (top !== null) return realpathOr(top);
  }
  return null;
}

const dataDir = () => path.join(process.env.HERMES_HOME || path.join(process.env.HOME ?? "", ".hermes"), "counterweight");

async function main(): Promise<void> {
  if (inRole()) return;
  process.env.PLUGIN_DATA = dataDir();
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as HookInput;
  const session = input.session_id || input.task_id || "";
  const root = await resolveRoot(input);
  let output: Output = null;
  switch (input.hook) {
    case "pre_llm_call": output = await preLlm(root, session, input); break;
    case "pre_tool_call": output = await preTool(root, session, input); break;
    case "post_tool_call": await postTool(session, input); break;
    case "pre_verify": output = await preVerify(root, session, input); break;
    case "post_api_request": if (root !== null) await meter(root, session, input); break;
    case "on_session_end": await sessionEnd(root, session, input); break;
  }
  if (output !== null) process.stdout.write(`${JSON.stringify(output)}\n`);
}

const textOf = (value: unknown): string => typeof value === "string" ? value
  : Array.isArray(value) ? value.map((part) => typeof part === "string" ? part : (part as { text?: unknown })?.text).filter((part): part is string => typeof part === "string").join("\n") : "";

const shortId = (value: string): string => {
  let hash = 5381;
  for (const char of value) hash = ((hash * 33) ^ char.charCodeAt(0)) >>> 0;
  return hash.toString(36);
};
const newTurn = () => `h${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const currentTurn = async (session: string) => await getSessionText(session, "turn") ?? "t0";

/** 会话历史转成 PAUSE 用的 TranscriptMessage（只在回合开始时存一次）。 */
function historyMessages(history: unknown): TranscriptMessage[] {
  const messages: TranscriptMessage[] = [];
  for (const item of Array.isArray(history) ? history : []) {
    const role = (item as { role?: unknown })?.role;
    const body = textOf((item as { content?: unknown })?.content);
    if (body.trim() === "") continue;
    if (role === "user") messages.push({ role: "user", content: [{ type: "text", text: body }] });
    else if (role === "assistant") messages.push({ role: "assistant", content: [{ type: "text", text: body }] });
  }
  return messages;
}

/** 每回合一次：存回合 id、提示和基线，首次注入工作说明，之后只注入目标的变化，并交付上一回合留下的报告。 */
async function preLlm(root: string | null, session: string, input: HookInput): Promise<Output> {
  const turn = input.turn_id ? shortId(input.turn_id) : newTurn();
  await putSessionText(session, "turn", turn).catch(() => {});
  const prompt = textOf(input.user_message);
  await savePrompt(session, turn, prompt).catch(() => {});
  await putSessionText(session, "history", renderTranscript(historyMessages(input.conversation_history))).catch(() => {});
  const parts: string[] = [];
  const note = await takeSessionText(session, "note");
  if (note !== null && note.trim() !== "") parts.push(note.trim());
  if (root === null) {
    parts.push("[counterweight] 找不到项目根目录（会话目录不在 Git 仓库里），本回合不注入、不保护、不检查。");
    return { context: parts.join("\n\n") };
  }
  const notes: string[] = [];
  let project: ProjectConfig | null = null;
  try {
    project = await loadProjectConfig(root, "hermes.toml");
    if (project !== null && (project.auto.review || project.auto.chronicle)) {
      const base = await snapshotTree(root);
      if (base !== null) await saveBase(session, turn, base);
    }
  } catch (error) {
    notes.push(`[counterweight] 配置非法：${message(error)}`);
  }
  if (await getSessionText(session, "injected") === null) {
    const missing = notes.length === 0 ? missingCheckNotice(project, "hermes.toml 与 .cw/project.toml（见 README）") : null;
    if (missing !== null) notes.push(missing);
    for (const item of project?.autoSkipped ?? []) {
      notes.push(`[counterweight] [auto].${item} 已打开但 .cw/hermes.toml 没配对应模型，该项视为关闭`);
    }
    const goal = await readGoal(root);
    await rememberGoal(session, goal);
    await putSessionText(session, "injected", "1").catch(() => {});
    const version = await pluginVersion();
    await recordEvent(root, session, "inject", { host: "hermes", version, goal: goalPart(goal) !== null, check: project?.check != null });
    parts.push(`${withGoal(sessionSection(project?.auto ?? { review: false, chronicle: false }), goal)}\n\nCounterweight ${version} active`);
  } else {
    const update = await goalUpdate(root, session).catch(() => null);
    if (update !== null) parts.push(update);
  }
  parts.push(...notes);
  return parts.length === 0 ? null : { context: parts.join("\n\n") };
}

async function pluginVersion(): Promise<string> {
  try {
    const manifest = await readFile(path.join(__dirname, "..", "plugin.yaml"), "utf8");
    return /^version:\s*"?([^"\s]+)"?/m.exec(manifest)?.[1] ?? "unknown";
  } catch {
    return "unknown";
  }
}

const block = (reason: string): Output => ({ action: "block", message: reason });

/** 受保护路径、高危命令、范围锁定、PAUSE。写路径来自 `write_file`、`patch`（含 V4A 多文件补丁）；命令来自 `terminal`。 */
async function preTool(root: string | null, session: string, input: HookInput): Promise<Output> {
  const tool = input.tool_name ?? "";
  const args = input.args ?? {};
  const isWrite = tool === "write_file" || tool === "patch";
  const paths = !isWrite ? []
    : typeof args.patch === "string" ? patchPaths(args.patch)
      : typeof args.path === "string" && args.path !== "" ? [args.path] : [];
  const command = typeof args.command === "string" ? args.command : "";
  // 没有项目根目录：命令照样按命令本身检查，写路径无从核对，如实拒绝而不是放行。
  if (root === null) {
    if (tool === "terminal") {
      const danger = await dangerousCommandIn(typeof args.workdir === "string" && path.isAbsolute(args.workdir) ? args.workdir : process.cwd(), command);
      return danger === null ? null : block(danger);
    }
    return isWrite ? block("[counterweight] 找不到项目根目录，无法核对受保护路径，已拒绝这次写入。") : null;
  }
  const cwd = input.cwd !== undefined && input.cwd !== "" ? input.cwd : root;
  if (tool === "terminal") {
    const danger = await dangerousCommandIn(typeof args.workdir === "string" && args.workdir !== "" ? args.workdir : cwd, command);
    if (danger !== null) return block(danger);
  } else if (isWrite) {
    const goal = await checkGoalPaths(root, cwd, paths) ?? await checkScopePaths(root, cwd, paths);
    if (goal !== null) return block(goal);
  }
  let project: ProjectConfig | null;
  try {
    project = await loadProjectConfig(root, "hermes.toml");
  } catch {
    return null;
  }
  if (project === null) return null;
  const turn = await currentTurn(session);
  await appendTurnLine(session, turn, "log", JSON.stringify({ role: "call", name: tool, arguments: args }));
  if (tool === "terminal") {
    if (command !== "") await recordAction(session, turn, { tool: "bash", detail: command });
    return null;
  }
  if (!isWrite) return null;
  const refusal = await checkPaths(root, cwd, project, paths);
  if (refusal !== null) return block(refusal);
  const plan = await pausePlan({
    root, cwd: await realpathOr(cwd), project, session, paths, tool, input: args,
    runner: runRole, signal: new AbortController().signal,
    claim: () => claim(session, turn, "pause"),
    transcript: async () => {
      const lines = (await loadTurnLines(session, turn, "log")).map((line) => JSON.parse(line) as { role: string; name?: string; arguments?: unknown; content?: string });
      const thisTurn: TranscriptMessage[] = lines.map((line) => line.role === "call"
        ? { role: "assistant", content: [{ type: "toolCall", name: line.name, arguments: line.arguments }] }
        : { role: "toolResult", toolName: line.name ?? "", content: [{ type: "text", text: line.content ?? "" }] });
      return `${await getSessionText(session, "history") ?? ""}\n\n${renderTranscript(thisTurn)}`.trim();
    },
  });
  if (plan !== null) return block(plan);
  for (const file of paths) await recordAction(session, turn, { tool, detail: file });
  return null;
}

/** 工具结果进 PAUSE 的调查记录。 */
async function postTool(session: string, input: HookInput): Promise<void> {
  await appendTurnLine(session, await currentTurn(session), "log",
    JSON.stringify({ role: "result", name: input.tool_name ?? "", content: textOf(input.result) || JSON.stringify(input.result ?? "") }));
}

/** 结束检查与自动任务。返回续跑的理由（`attempt` 到 2 不再续跑），否则把报告存给下一个回合。 */
async function preVerify(root: string | null, session: string, input: HookInput): Promise<Output> {
  const turn = await currentTurn(session);
  const attempt = typeof input.attempt === "number" ? input.attempt : 0;
  const deliver = async (text: string | null) => {
    if (text !== null) await putSessionText(session, "note", [await getSessionText(session, "note"), text].filter((part) => part !== null).join("\n")).catch(() => {});
  };
  const settle = async (settled: Pick<ChronicleInput, "outcome" | "evidence">) => {
    await putSessionText(session, "settled", JSON.stringify(settled)).catch(() => {});
  };
  if (root === null) {
    await settle({ outcome: "unknown", evidence: { gap: "找不到项目根目录，未运行检查" } });
    await deliver("[counterweight] 找不到项目根目录，本回合没有运行结束检查。");
    return null;
  }
  let project: ProjectConfig | null;
  try {
    project = await loadProjectConfig(root, "hermes.toml");
  } catch (error) {
    await settle({ outcome: "unknown", evidence: { gap: `配置非法，未运行检查：${message(error)}` } });
    await deliver(`[counterweight] 配置非法，未运行检查：${message(error)}`);
    return null;
  }
  if (project === null) {
    await settle({ outcome: "unknown", evidence: { gap: "没有 .cw/project.toml，未运行检查" } });
    return null;
  }
  const result = await endCheck({
    root, project, session, runner: runRole, signal: new AbortController().signal,
    // 续跑最多两次：检查一次，审查发现一次；Hermes 的 attempt 已到 2 就不再给额度。
    claim: async (name) => attempt < 2 && await claim(session, turn, name),
    prompt: () => loadPrompt(session, turn),
    actions: () => loadActions(session, turn),
    base: () => loadBase(session, turn),
    limits: hermesLimits(input.budget_s),
  });
  if (result.continueWith !== null) {
    await deliver(result.report);
    return { action: "continue", message: result.continueWith };
  }
  await settle(result.settled);
  await deliver(result.report);
  return null;
}

/** 回合结束：写 chronicle 事件（结论来自 pre_verify，没有就是没检查），并把待批条数接到要交付的报告上。 */
async function sessionEnd(root: string | null, session: string, input: HookInput): Promise<void> {
  const turn = await currentTurn(session);
  const stored = await takeSessionText(session, "settled");
  let settled: Pick<ChronicleInput, "outcome" | "evidence">;
  if (input.interrupted === true) settled = { outcome: "cancelled", evidence: { gap: `回合被中断（${input.turn_exit_reason ?? "unknown"}）` } };
  else if (stored !== null) settled = JSON.parse(stored) as typeof settled;
  else settled = { outcome: "unknown", evidence: { gap: `本回合没有改代码，Hermes 不触发结束检查（${input.turn_exit_reason ?? "unknown"}）` } };
  const workspace = root ?? input.cwd ?? "";
  if (workspace !== "") await writeChronicleEvent({ host: "hermes", session, turn, workspace, ...settled });
  if (root !== null) {
    const pending = await pendingCount(root);
    if (pending > 0) {
      const note = await takeSessionText(session, "note");
      await putSessionText(session, "note", withPending(note, pending) ?? "").catch(() => {});
    }
  }
  if (input.interrupted === true) await endSession(session).catch(() => {});
}

/** `post_api_request` 的用量：按 `api_request_id` 记一次，已记的 id 存在会话目录。 */
async function meter(root: string, session: string, input: HookInput): Promise<void> {
  try {
    const id = input.api_request_id;
    const usage = input.usage;
    if (typeof id !== "string" || id === "" || usage === undefined || usage === null) return;
    const seen = await loadSeen(session);
    if (seen === null || seen.has(id)) return;
    const number = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? value : 0;
    await recordUsage(root, {
      time: typeof input.ended_at === "number" ? new Date(input.ended_at * 1000).toISOString() : new Date().toISOString(),
      session, model: input.model ?? "",
      input: number(usage.input_tokens), output: number(usage.output_tokens),
      cache_read: number(usage.cache_read_tokens), cache_write: number(usage.cache_write_tokens), cost_total: null,
    });
    await markSeen(session, id);
  } catch {
    // Observational only.
  }
}

main().then(() => process.exit(0), (error: unknown) => {
  process.stderr.write(`[counterweight] ${message(error)}\n`);
  process.exit(0);
});
