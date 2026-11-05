/**
 * OpenCode v2 插件：进程内运行，没有一次性 hook 进程，回合状态放在内存里。
 * OpenCode 没有给插件向用户显示文字的通道，所以检查通过时什么也不显示，只写 `.cw/meter.jsonl`。
 */
import { snapshotTree, type ActionRecord } from "../../core/auto.js";
import { writeChronicleEvent, type ChronicleInput } from "../../core/chronicle-event.js";
import { dangerousCommandIn } from "../../core/danger.js";
import { loadProjectConfig, type ProjectConfig } from "../../core/config.js";
import { checkGoalPaths, checkPaths, checkScopePaths, endCheck, pausePlan } from "../../core/flow.js";
import { readGoal } from "../../core/goal.js";
import { repoToplevel } from "../../core/gitstate.js";
import { recordEvent, recordUsage } from "../../core/meter.js";
import { realpathOr } from "../../core/paths.js";
import { renderTranscript } from "../../core/pause.js";
import type { Claim } from "../../core/turnstate.js";
import { goalPart, rolePrompt, sessionSection, withGoal, type RoleName } from "../../roles/prompts.js";
import { callRole, ROLES, toolInputSchema } from "../../roles/tools.js";
import { patchPaths } from "../codex/patch.js";
import { makeRunner, type SessionApi, type StepWatch } from "./runner.js";
import setup from "./setup.md";
import { toTranscript } from "./transcript.js";
import pkg from "../../../package.json" with { type: "json" };

/** 插件用到的 ctx 部分，字段名按 `@opencode/plugin` v2.2.5。 */
export interface Ctx {
  location: { directory: string };
  session: SessionApi & {
    hook(name: string, callback: (event: any) => Promise<void> | void): Promise<unknown>;
  };
  tool: {
    hook(name: string, callback: (event: any) => Promise<void> | void): Promise<unknown>;
    transform(callback: (editor: { add(tool: any): void }) => void): Promise<unknown>;
  };
  command: { transform(callback: (editor: { add(command: any): void }) => void): Promise<unknown> };
  event: { subscribe(options?: { types?: string[]; signal?: AbortSignal }): AsyncIterable<any> };
}

interface Turn { repair: boolean; findings: boolean; pause: boolean; relayed: boolean; prompt: string; actions: ActionRecord[]; base: string | null }

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

const RELAY = (report: string) =>
  `[counterweight] 下面是本轮的结束检查报告。请原样转告用户，不要修改文件，也不要再运行检查：\n\n${report}`;

async function setupPlugin(ctx: Ctx): Promise<() => void> {
  const directory = await realpathOr(ctx.location.directory);
  const root = await realpathOr(await repoToplevel(directory) ?? directory);
  const turns = new Map<string, Turn>();
  const models = new Map<string, string>();
  const parents = new Map<string, boolean>();
  const roleSessions = new Map<string, RoleName>();
  const injected = new Set<string>();
  const steps: StepWatch = new Map();
  const running = new Map<string, Set<AbortController>>();
  const lifetime = new AbortController();

  const load = (): Promise<ProjectConfig | null> => loadProjectConfig(root, "opencode.toml");
  const turnOf = (sessionID: string): Turn => {
    let turn = turns.get(sessionID);
    if (turn === undefined) {
      turn = { repair: false, findings: false, pause: false, relayed: false, prompt: "", actions: [], base: null };
      turns.set(sessionID, turn);
    }
    return turn;
  };
  const claimFor = (sessionID: string) => async (name: Claim): Promise<boolean> => {
    const turn = turnOf(sessionID);
    if (turn[name]) return false;
    turn[name] = true;
    return true;
  };
  /** 子会话：角色子会话，或 OpenCode 自己的子代理。查不到时按子会话处理，即不检查、不 PAUSE。 */
  const isChild = async (sessionID: string): Promise<boolean> => {
    if (roleSessions.has(sessionID)) return true;
    const known = parents.get(sessionID);
    if (known !== undefined) return known;
    try {
      const child = (await ctx.session.get({ sessionID })).parentID !== undefined;
      parents.set(sessionID, child);
      return child;
    } catch {
      return true;
    }
  };
  /** 登记一个可被 Esc 中止的运行；`extra` 是工具调用自带的 signal。 */
  const track = (sessionID: string, extra?: AbortSignal) => {
    const controller = new AbortController();
    const set = running.get(sessionID) ?? new Set<AbortController>();
    running.set(sessionID, set);
    set.add(controller);
    if (extra?.aborted) controller.abort();
    else extra?.addEventListener("abort", () => controller.abort(), { once: true });
    return { signal: controller.signal, done: () => { set.delete(controller); } };
  };

  await ctx.session.hook("context", async (event) => {
    models.set(event.sessionID, `${event.model.providerID}/${event.model.id}`);
    const role = roleSessions.get(event.sessionID);
    if (role !== undefined) {
      event.system.push({ type: "text", text: rolePrompt(role) });
      return;
    }
    if (await isChild(event.sessionID)) return;
    const project = await load().catch(() => null);
    const goal = await readGoal(root);
    event.system.push({
      type: "text",
      text: withGoal(sessionSection(project?.auto ?? { review: false, chronicle: false }), goal),
    });
    // 每个会话第一次注入时记一条，评测读它判断是否真的注入了。OpenCode 没有显示通道，缺 [check] 也只记在这里。
    if (!injected.has(event.sessionID)) {
      injected.add(event.sessionID);
      await recordEvent(root, event.sessionID, "inject", {
        host: "opencode", version: pkg.version, goal: goalPart(goal) !== null, check: project?.check != null,
      });
    }
  });

  await ctx.session.hook("prompt", async (event) => {
    if (roleSessions.has(event.sessionID)) return;
    const turn: Turn = { repair: false, findings: false, pause: false, relayed: false, prompt: event.prompt?.text ?? "", actions: [], base: null };
    turns.set(event.sessionID, turn);
    // 回合基线：只有审查或汇报打开时才用得上。取不到就留 null，收尾时退回 HEAD。
    try {
      const project = await load();
      if (project !== null && (project.auto.review || project.auto.chronicle)) turn.base = await snapshotTree(root);
    } catch {
      // Without a baseline the review falls back to HEAD.
    }
  });

  await ctx.tool.hook("execute.before", async (event) => {
    // 根会话的 shell 命令只记录，不过保护和 PAUSE；高危命令不用配置也拒绝。
    if (event.tool === "shell") {
      const command = (event.input as Record<string, unknown> | undefined)?.command;
      const danger = typeof command === "string" ? await dangerousCommandIn(directory, command) : null;
      if (danger !== null) throw new Error(danger);
      if (typeof command === "string" && command !== "" && !(await isChild(event.sessionID))) {
        turnOf(event.sessionID).actions.push({ tool: "bash", detail: command });
      }
      return;
    }
    if (event.tool !== "write" && event.tool !== "edit" && event.tool !== "patch") return;
    const input = (event.input ?? {}) as Record<string, unknown>;
    const target = input.path;
    const paths = event.tool === "patch"
      ? (typeof input.patchText === "string" ? patchPaths(input.patchText) : [])
      : (typeof target === "string" && target !== "" ? [target] : []);
    // goal.md 和 scope.txt 不用配置也生效：goal.md 不用配置也会被注入，所以配置缺失或非法时也不许改它。
    const goal = await checkGoalPaths(root, directory, paths) ?? await checkScopePaths(root, directory, paths);
    if (goal !== null) throw new Error(goal);
    let project: ProjectConfig | null;
    try {
      project = await load();
    } catch {
      return;
    }
    if (project === null) return;
    const refusal = await checkPaths(root, directory, project, paths);
    if (refusal !== null) throw new Error(refusal);
    if (await isChild(event.sessionID)) return;
    const tracked = track(event.sessionID);
    try {
      const plan = await pausePlan({
        root, cwd: directory, project, session: event.sessionID, paths, tool: event.tool, input,
        runner: makeRunner(ctx.session, event.sessionID, roleSessions, steps), signal: tracked.signal,
        claim: () => claimFor(event.sessionID)("pause"),
        transcript: async () => renderTranscript(toTranscript(await ctx.session.context({ sessionID: event.sessionID }))),
      });
      if (plan !== null) throw new Error(plan);
    } finally {
      tracked.done();
    }
    for (const file of paths) turnOf(event.sessionID).actions.push({ tool: event.tool, detail: file });
  });

  await ctx.session.hook("experimental.idle", async (event) => {
    const sessionID: string = event.sessionID;
    const tracked = track(sessionID);
    try {
      if (await isChild(sessionID)) return;
      const turn = turnOf(sessionID);
      if (turn.relayed) return;
      // 回合真正结束时记一条 chronicle 事件；OpenCode 没有回合 id。
      const chronicle = (settled: Pick<ChronicleInput, "outcome" | "evidence">) =>
        writeChronicleEvent({ host: "opencode", session: sessionID, turn: null, workspace: root, ...settled });
      let result;
      try {
        const project = await load();
        if (project === null) {
          await chronicle({ outcome: "unknown", evidence: { gap: "没有 .cw/project.toml，未运行检查" } });
          return;
        }
        result = await endCheck({
          root, project, session: sessionID, runner: makeRunner(ctx.session, sessionID, roleSessions, steps),
          signal: tracked.signal, claim: claimFor(sessionID), prompt: async () => turn.prompt,
          actions: async () => turn.actions, base: async () => turn.base,
        });
      } catch (error) {
        const report = `[counterweight] 配置非法，未运行检查：${message(error)}`;
        result = { continueWith: null, report, attention: true, settled: { outcome: "unknown" as const, evidence: { gap: report } } };
      }
      if (tracked.signal.aborted) {
        await chronicle({ outcome: "cancelled", evidence: { gap: "回合被中断" } });
        return;
      }
      if (result.continueWith !== null) {
        await ctx.session.synthetic({ sessionID, text: result.continueWith });
        return;
      }
      await chronicle(result.settled);
      if (result.attention && result.report !== null) {
        turn.relayed = true;
        await ctx.session.synthetic({ sessionID, text: RELAY(result.report) });
      }
    } catch {
      // A failing hook would fail the execution; the check is best-effort here.
    } finally {
      tracked.done();
    }
  });

  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({
        types: ["session.step.ended", "session.execution.interrupted"], signal: lifetime.signal,
      })) {
        if (event.type === "session.execution.interrupted") {
          for (const controller of running.get(event.data.sessionID) ?? []) controller.abort();
        } else if (event.type === "session.step.ended") {
          const { sessionID, cost, tokens } = event.data;
          const watch = steps.get(sessionID);
          if (watch !== undefined && ++watch.count > watch.limit) watch.exceed();
          await recordUsage(root, {
            time: new Date().toISOString(),
            session: sessionID,
            model: models.get(sessionID) ?? "",
            input: tokens.input,
            output: tokens.output,
            cache_read: tokens.cache.read,
            cache_write: tokens.cache.write,
            cost_total: typeof cost === "number" ? cost : null,
          }).catch(() => {});
        }
      }
    } catch {
      // The stream ends when the plugin is unloaded.
    }
  })();

  await ctx.tool.transform((editor) => {
    for (const role of ROLES) {
      editor.add({
        name: role.tool,
        description: role.description,
        input: toolInputSchema(role.input),
        options: { codemode: false },
        execute: async (input: Record<string, unknown>, context: { sessionID: string; signal: AbortSignal }) => {
          if (roleSessions.has(context.sessionID)) {
            return { content: `[counterweight] ${role.tool} 在角色子会话里不可用。` };
          }
          let project: ProjectConfig | null;
          try {
            project = await load();
          } catch (error) {
            return { content: `[counterweight] 配置非法，${role.tool} 不可用：${message(error)}` };
          }
          if (project === null) return { content: `[counterweight] 未配置 [models].${role.name}，${role.tool} 不可用。` };
          const tracked = track(context.sessionID, context.signal);
          try {
            return {
              content: await callRole({
                repo: root, session: context.sessionID, project,
                runner: makeRunner(ctx.session, context.sessionID, roleSessions, steps),
              }, role, input, tracked.signal),
            };
          } finally {
            tracked.done();
          }
        },
      });
    }
  });

  await ctx.command.transform((editor) => {
    editor.add({
      name: "cw-setup",
      description: "Set up or repair Counterweight in this repository",
      execute: async (invocation: { sessionID: string }) => {
        await ctx.session.synthetic({ sessionID: invocation.sessionID, text: setup });
      },
    });
  });

  return () => lifetime.abort();
}

export default { id: "counterweight", setup: setupPlugin };

