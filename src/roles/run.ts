/**
 * 角色运行的共用部分：超时规则，以及各宿主 runner 遵守的请求和结果类型。
 */
import type { RoleName } from "./prompts.js";

/** explorer、review、over_review 的预算。research 单独更长。 */
const ROLE_TIMEOUT_MS = 300_000;
const RESEARCH_TIMEOUT_MS = 1_800_000;

export function roleTimeoutMs(role: RoleName): number {
  return role === "research" ? RESEARCH_TIMEOUT_MS : ROLE_TIMEOUT_MS;
}

/** 单次调用可以要求的超时范围（秒）。下限是默认值，上限 1800。 */
export const MIN_TIMEOUT_S = 300;
export const MAX_TIMEOUT_S = 1_800;

/** 把调用方给的秒数夹进 [300, 1800]；不是有限数就当没给。 */
export function clampTimeoutS(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(MAX_TIMEOUT_S, Math.max(MIN_TIMEOUT_S, Math.round(value)));
}

/** 超时后建议的下一档：翻倍，封顶 1800；已经是 1800 返回 null，意思是该拆小而不是再加。 */
export function nextTimeoutS(usedMs: number): number | null {
  const used = Math.round(usedMs / 1000);
  if (used >= MAX_TIMEOUT_S) return null;
  return Math.min(MAX_TIMEOUT_S, used * 2);
}

export interface UsageSample {
  /** 不含缓存命中的输入。 */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** 宿主报告的费用；省略表示没有（Codex）。 */
  costTotal?: number | null;
}

export interface RoleRun {
  answer: string | null;
  error: string | null;
  usage: UsageSample[];
  timedOut: boolean;
  cancelled: boolean;
}

export interface RoleRequest {
  role: RoleName;
  workRoot: string;
  /** 宿主自己的模型写法。 */
  model: string;
  /** 交给角色的正文。 */
  message: string;
  /** 只对 Codex 有意义；其他宿主靠工具白名单或权限限制。 */
  sandbox: "read-only" | "none";
  signal?: AbortSignal;
  timeoutMs: number;
}

export type RoleRunner = (request: RoleRequest) => Promise<RoleRun>;
