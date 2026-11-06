/**
 * Kimi Code hook 的唯一入口：stdin 读一个 JSON，按 `hook_event_name` 分发。hook 是一次性进程，每次都重新读配置。
 * 和 Claude Code 的差别，都是实测的：
 * - Stop 每回合只触发一次，续跑之后的那次结束不再触发 hook，所以检查修复和审查发现共用这一次续跑，检查优先；
 * - Stop 只能续跑，没有显示渠道，回合结束的报告存下来，在下一条用户提示的 hook_result 里交付；
 * - 提示里没有回合 id，用户提示开始时生成一个；非用户触发的回合（没有 UserPromptSubmit）用 TurnStarted 的 turn_id；
 * - 数据目录取 `$KIMI_CODE_HOME/counterweight`，用量读会话的 wire.jsonl。
 * 子进程环境里有 `CW_ROLE=1` 时直接退出：角色会话里不检查、不注入。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { snapshotTree } from "../../core/auto.js";
import { writeChronicleEvent, type ChronicleInput } from "../../core/chronicle-event.js";
import { dangerousCommandIn } from "../../core/danger.js";
import { loadProjectConfig, type ProjectConfig } from "../../core/config.js";
import { checkGoalPaths, checkPaths, checkScopePaths, endCheck, missingCheckNotice, pausePlan } from "../../core/flow.js";
import { repoToplevel } from "../../core/gitstate.js";
import { goalUpdate, readGoal, rememberGoal } from "../../core/goal.js";
import { recordEvent, recordUsage } from "../../core/meter.js";
import { realpathOr } from "../../core/paths.js";
import { pendingCount, withPending } from "../../core/pending.js";
import { renderTranscript } from "../../core/pause.js";
import { inRole } from "../../core/role.js";
import {
  claim, endSession, getSessionText, loadActions, loadBase, loadPrompt, loadSeen, markSeen, putSessionText,
  recordAction, saveBase, savePrompt, takeSessionText, type Claim,
} from "../../core/turnstate.js";
import { goalPart, sessionSection, withGoal } from "../../roles/prompts.js";
import { runRole } from "./runner.js";
import { kimiHome, parseWireTranscript, sessionWires, wireUsage } from "./wire.js";

interface HookInput {
  hook_event_name?: string;
  cwd?: string;
  session_id?: string;
  prompt?: unknown;
  is_steer?: boolean;
  turn_id?: number;
  origin_kind?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

type Output = Record<string, unknown> | null;

/** Kimi 的 hook 超时最多 600 秒：检查 300，角色 270，留给 git 和收尾的余量。 */
export const KIMI_LIMITS = { checkTimeoutS: 300, roleTimeoutS: 270 };


const message = (error: unknown) => error instanceof Error ? error.message : String(error);

async function main(): Promise<void> {
  if (inRole()) return;
  // 回合状态放在 Kimi 的数据目录下，不依赖宿主给插件数据目录。
  process.env.PLUGIN_DATA = path.join(kimiHome(), "counterweight");
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as HookInput;
  const cwd = input.cwd ?? process.cwd();
  const root = await realpathOr(await repoToplevel(cwd) ?? cwd);
  const session = input.session_id ?? "";
  switch (input.hook_event_name) {
    case "UserPromptSubmit": {
      await meter(root, session);
      const text = await userPrompt(root, input);
      if (text !== null) process.stdout.write(`${text}\n`);
      break;
    }
    case "TurnStarted": await turnStarted(session, input); break;
    case "PreToolUse": {
      const output = await preToolUse(root, cwd, input);
      if (output !== null) process.stdout.write(`${JSON.stringify(output)}\n`);
      break;
    }
    case "Stop": {
      await meter(root, session);
      const reason = await stop(root, session);
      if (reason !== null) {
        process.stderr.write(reason);
        process.exitCode = 2;
      }
      break;
    }
    case "SessionEnd":
      await meter(root, session);
      await endSession(session).catch(() => {});
      break;
  }
}

const promptText = (prompt: unknown): string => typeof prompt === "string" ? prompt
  : Array.isArray(prompt)
    ? prompt.map((part) => part?.type === "text" && typeof part.text === "string" ? part.text : "").filter((part) => part !== "").join("\n")
    : "";

const newTurn = () => `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** 用户提示：生成回合 id，存提示和基线，返回要追加进提示的文字（首次注入、目标变化、上一回合的报告）。 */
async function userPrompt(root: string, input: HookInput): Promise<string | null> {
  const session = input.session_id ?? "";
  if (input.is_steer === true) return null;
  const turn = newTurn();
  await putSessionText(session, "turn", turn).catch(() => {});
  await savePrompt(session, turn, promptText(input.prompt)).catch(() => {});
  const parts: string[] = [];
  const note = await takeSessionText(session, "note");
  if (note !== null && note.trim() !== "") parts.push(note.trim());
  let project: ProjectConfig | null = null;
  const notes: string[] = [];
  try {
    project = await loadProjectConfig(root, "kimi.toml");
    if (project !== null && (project.auto.review || project.auto.chronicle)) {
      const base = await snapshotTree(root);
      if (base !== null) await saveBase(session, turn, base);
    }
  } catch (error) {
    notes.push(`[counterweight] 配置非法：${message(error)}`);
  }
  if (await getSessionText(session, "injected") === null) {
    const missing = notes.length === 0 ? missingCheckNotice(project, "/skill:counterweight:cw-setup") : null;
    if (missing !== null) notes.push(missing);
    for (const item of project?.autoSkipped ?? []) {
      notes.push(`[counterweight] [auto].${item} 已打开但 .cw/kimi.toml 没配对应模型，该项视为关闭`);
    }
    const goal = await readGoal(root);
    await rememberGoal(session, goal);
    await putSessionText(session, "injected", "1").catch(() => {});
    const version = await pluginVersion();
    await recordEvent(root, session, "inject", { host: "kimi", version, goal: goalPart(goal) !== null, check: project?.check != null });
    parts.push(`${withGoal(sessionSection(project?.auto ?? { review: false, chronicle: false }), goal)}\n\nCounterweight ${version} active`);
    parts.push(...notes);
  } else {
    parts.push(...notes);
    const update = await goalUpdate(root, session).catch(() => null);
    if (update !== null) parts.push(update);
  }
  return parts.length === 0 ? null : parts.join("\n\n");
}

/** 没有 UserPromptSubmit 的回合（目标续跑、定时任务）也要有自己的回合 id，否则会沿用上一回合已用掉的额度。 */
async function turnStarted(session: string, input: HookInput): Promise<void> {
  if (input.origin_kind === "user") return;
  await putSessionText(session, "turn", `s${input.turn_id ?? 0}-${Date.now().toString(36)}`).catch(() => {});
}

async function pluginVersion(): Promise<string> {
  try {
    const manifest = JSON.parse(await readFile(
      path.join(process.env.KIMI_PLUGIN_ROOT ?? "", ".kimi-plugin/plugin.json"), "utf8")) as { version?: unknown };
    return typeof manifest.version === "string" ? manifest.version : "unknown";
  } catch {
    return "unknown";
  }
}

const deny = (reason: string): Output => ({
  hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
});

const currentTurn = async (session: string) => await getSessionText(session, "turn") ?? "t0";

async function preToolUse(root: string, cwd: string, input: HookInput): Promise<Output> {
  const session = input.session_id ?? "";
  const target = input.tool_input?.path;
  const paths = typeof target === "string" && target !== "" ? [target] : [];
  if (input.tool_name === "Bash") {
    const command = input.tool_input?.command;
    const danger = typeof command === "string" ? await dangerousCommandIn(cwd, command) : null;
    if (danger !== null) return deny(danger);
  } else {
    const goal = await checkGoalPaths(root, cwd, paths) ?? await checkScopePaths(root, cwd, paths);
    if (goal !== null) return deny(goal);
  }
  let project: ProjectConfig | null;
  try {
    project = await loadProjectConfig(root, "kimi.toml");
  } catch {
    return null;
  }
  if (project === null) return null;
  const turn = await currentTurn(session);
  if (input.tool_name === "Bash") {
    const command = input.tool_input?.command;
    if (typeof command === "string" && command !== "") await recordAction(session, turn, { tool: "bash", detail: command });
    return null;
  }
  const refusal = await checkPaths(root, cwd, project, paths);
  if (refusal !== null) return deny(refusal);
  const plan = await pausePlan({
    root, cwd: await realpathOr(cwd), project, session, paths,
    tool: input.tool_name ?? "", input: input.tool_input ?? {},
    runner: runRole, signal: new AbortController().signal,
    claim: () => claim(session, turn, "pause"),
    transcript: async () => {
      const main = (await sessionWires(session)).find((wire) => wire.agent === "main");
      if (main === undefined) throw new Error("没有会话记录");
      return renderTranscript(parseWireTranscript(main.text));
    },
  });
  if (plan !== null) return deny(plan);
  for (const file of paths) await recordAction(session, turn, { tool: input.tool_name ?? "", detail: file });
  return null;
}

/** 返回要续跑的理由（Stop 以退出码 2 和 stderr 交给模型）；不续跑返回 null，报告存给下一条提示。 */
async function stop(root: string, session: string): Promise<string | null> {
  const turn = await currentTurn(session);
  const settle = (settled: Pick<ChronicleInput, "outcome" | "evidence">) =>
    writeChronicleEvent({ host: "kimi", session, turn, workspace: root, ...settled });
  const deliver = async (text: string | null) => {
    if (text !== null) await putSessionText(session, "note", text).catch(() => {});
  };
  let project: ProjectConfig | null;
  try {
    project = await loadProjectConfig(root, "kimi.toml");
  } catch (error) {
    await settle({ outcome: "unknown", evidence: { gap: `配置非法，未运行检查：${message(error)}` } });
    await deliver(`[counterweight] 配置非法，未运行检查：${message(error)}`);
    return null;
  }
  if (project === null) {
    await settle({ outcome: "unknown", evidence: { gap: "没有 .cw/project.toml，未运行检查" } });
    await deliver(withPending(null, await pendingCount(root)));
    return null;
  }
  // Kimi 每回合只续跑一次：检查修复和审查发现用同一个额度，检查先问，所以审查发现只在检查没占用时才能续跑。
  const shared = (name: Claim) => claim(session, turn, name === "findings" ? "repair" : name);
  const result = await endCheck({
    root, project, session, runner: runRole, signal: new AbortController().signal,
    claim: shared,
    prompt: () => loadPrompt(session, turn),
    actions: () => loadActions(session, turn),
    base: () => loadBase(session, turn),
    limits: KIMI_LIMITS,
  });
  if (result.continueWith !== null) {
    await deliver(result.report);
    return result.continueWith;
  }
  await settle(result.settled);
  await deliver(withPending(result.report, await pendingCount(root)));
  return null;
}

/** 读各 agent 的 wire.jsonl，每条 `usage.record` 只记一次，已记的 key 存在会话目录。失败不影响主流程，也不把 key 标成已记。 */
async function meter(root: string, session: string): Promise<void> {
  try {
    const seen = await loadSeen(session);
    if (seen === null) return;
    for (const wire of await sessionWires(session)) {
      for (const sample of wireUsage(wire.text)) {
        if (seen.has(sample.key)) continue;
        try {
          await recordUsage(root, {
            time: sample.time, session, model: sample.model, input: sample.input, output: sample.output,
            cache_read: sample.cacheRead, cache_write: sample.cacheWrite, cost_total: null,
          });
          await markSeen(session, sample.key);
          seen.add(sample.key);
        } catch {
          // Observational only.
        }
      }
    }
  } catch {
    // Observational only.
  }
}

main().then(() => process.exit(process.exitCode ?? 0), (error: unknown) => {
  process.stderr.write(`[counterweight] ${message(error)}\n`);
  process.exit(0);
});
