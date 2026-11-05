/**
 * OpenCode 的角色运行：在调用方会话下建一个子会话，发正文，等它空闲，取最后一条助手消息的文字。
 * 只读靠子会话的 `permissions`；超时或取消时中断子会话（子会话不随调用方的 abort 停止）。
 * 用量由插件的事件订阅记录，所以这里的 `usage` 为空，不重复记账。
 */
import { budgetMessage, stepLimit } from "../../core/budget.js";
import type { RoleName } from "../../roles/prompts.js";
import type { RoleRunner } from "../../roles/run.js";
import { lastAnswer, type SessionMessage } from "./transcript.js";

/** 插件用到的 `ctx.session` 部分。 */
export interface SessionApi {
  get(input: { sessionID: string }): Promise<{ parentID?: string }>;
  create(input: {
    parentID: string;
    model: { providerID: string; id: string };
    permissions: Array<{ action: string; resource: string; effect: "allow" | "deny" | "ask" }>;
  }): Promise<{ id: string }>;
  prompt(input: { sessionID: string; text: string }): Promise<unknown>;
  wait(input: { sessionID: string }): Promise<unknown>;
  context(input: { sessionID: string }): Promise<SessionMessage[]>;
  synthetic(input: { sessionID: string; text: string }): Promise<unknown>;
  interrupt(input: { sessionID: string }): Promise<unknown>;
}

/** 模型 id 按第一个斜杠切分，id 里可以再有斜杠。 */
export function splitModel(model: string): { providerID: string; id: string } {
  const at = model.indexOf("/");
  return { providerID: model.slice(0, at), id: model.slice(at + 1) };
}

const permissions = (role: RoleName) => role === "planner"
  ? [{ action: "*", resource: "*", effect: "deny" as const }]
  : [{ action: "edit", resource: "*", effect: "deny" as const }, { action: "shell", resource: "*", effect: "deny" as const }];

/** 角色子会话的步数：`session.step.ended` 每来一次加一，超过上限就调用 `exceed`。 */
export type StepWatch = Map<string, { count: number; limit: number; exceed: () => void }>;

export function makeRunner(
  session: SessionApi, parentID: string, roleSessions: Map<string, RoleName>, steps: StepWatch,
): RoleRunner {
  return async (request) => {
    const failure = (error: string, flags: { timedOut?: boolean; cancelled?: boolean } = {}) =>
      ({ answer: null, error, usage: [], timedOut: flags.timedOut ?? false, cancelled: flags.cancelled ?? false });
    if (request.signal?.aborted) return failure("已被取消", { cancelled: true });
    let child: string | null = null;
    let timedOut = false;
    let cancelled = false;
    let overBudget = false;
    const limit = stepLimit(request.role);
    const stop = () => {
      if (child !== null) void session.interrupt({ sessionID: child }).catch(() => {});
    };
    const onAbort = () => { cancelled = true; stop(); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, request.timeoutMs);
    request.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const info = await session.create({ parentID, model: splitModel(request.model), permissions: permissions(request.role) });
      child = info.id;
      roleSessions.set(child, request.role);
      steps.set(child, { count: 0, limit, exceed: () => { overBudget = true; stop(); } });
      if (cancelled || timedOut) stop();
      else {
        await session.prompt({ sessionID: child, text: request.message });
        await session.wait({ sessionID: child });
      }
      if (cancelled) return failure("已被取消", { cancelled: true });
      if (timedOut) return failure("超时，子会话已中断", { timedOut: true });
      // 中断后最后一条助手消息是被打断的，不看它。
      if (overBudget) return { ...failure(budgetMessage(limit)), budget: true };
      const answer = lastAnswer(await session.context({ sessionID: child }));
      if (answer === null) return failure("没有最终回答");
      if (answer.failed) return failure("未正常结束");
      if (answer.text.trim() === "") return failure("返回空回答");
      return { answer: answer.text, error: null, usage: [], timedOut: false, cancelled: false };
    } catch (error) {
      if (cancelled) return failure("已被取消", { cancelled: true });
      if (timedOut) return failure("超时，子会话已中断", { timedOut: true });
      return failure(`子会话出错：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onAbort);
      if (child !== null) {
        roleSessions.delete(child);
        steps.delete(child);
      }
    }
  };
}

