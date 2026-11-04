/**
 * 角色子进程：`codex exec` 跑一次，正文从 stdin 文件传入。只读靠 `-s read-only`（或用户显式关掉沙箱），
 * planner 另外关掉 shell 和联网；hook 和插件在子进程里都关着。
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runProcess } from "../core/process.js";
import { rolePrompt, type RoleName } from "./prompts.js";

/** explorer、review、over_review 的预算。research 单独更长。 */
export const ROLE_TIMEOUT_MS = 300_000;
export const RESEARCH_TIMEOUT_MS = 1_800_000;

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
  /** Codex 模型 slug。 */
  model: string;
  sandbox: "read-only" | "none";
  /** 交给子进程的正文，经临时文件从 stdin 传入。 */
  message: string;
  signal?: AbortSignal;
  /** codex 可执行文件；不传用 PATH 上的 `codex`。 */
  codex?: string;
  timeoutMs?: number;
}

export function roleArgs(request: Pick<RoleRequest, "role" | "model" | "sandbox">): string[] {
  return [
    "exec", "--json", "--ephemeral", "--skip-git-repo-check",
    "--disable", "hooks", "--disable", "plugins",
    "-m", request.model,
    "-c", `developer_instructions=${JSON.stringify(rolePrompt(request.role))}`,
    ...(request.sandbox === "read-only" ? ["-s", "read-only"] : ["--dangerously-bypass-approvals-and-sandbox"]),
    ...(request.role === "planner" ? ["--disable", "shell_tool", "-c", 'web_search="disabled"'] : []),
    "-",
  ];
}

export async function runRole(request: RoleRequest): Promise<RoleRun> {
  const scratch = await mkdtemp(path.join(tmpdir(), "cw-role-"));
  try {
    const messagePath = path.join(scratch, "message.md");
    await writeFile(messagePath, request.message);
    const outcome = await runProcess({
      cwd: request.workRoot,
      cmd: [request.codex ?? "codex", ...roleArgs(request)],
      env: { ...process.env },
      timeoutMs: request.timeoutMs ?? roleTimeoutMs(request.role),
      stdoutPath: path.join(scratch, "stdout.jsonl"),
      stderrPath: path.join(scratch, "stderr.log"),
      stdinPath: messagePath,
      signal: request.signal,
    });
    try {
      let stdout = "";
      try {
        stdout = await readFile(path.join(scratch, "stdout.jsonl"), "utf8");
      } catch (error) {
        return { answer: null, error: `输出不可读：${textOf(error)}`, usage: [], timedOut: outcome.timedOut, cancelled: outcome.cancelled };
      }
      const events = parseEvents(stdout);
      const failure = (reason: string): RoleRun =>
        ({ answer: null, error: reason, usage: events.usage, timedOut: outcome.timedOut, cancelled: outcome.cancelled });
      if (outcome.cancelled) return failure("已被取消");
      if (outcome.timedOut) return failure("超时，子进程组已终止");
      if (outcome.runnerError !== null) return failure(`无法启动 codex：${outcome.runnerError}`);
      if (!events.completed) return failure("未正常结束（没有 turn.completed）");
      if (events.answer === null) return failure("没有最终回答");
      if (events.answer.trim() === "") return failure("返回空回答");
      return { answer: events.answer, error: null, usage: events.usage, timedOut: false, cancelled: false };
    } finally {
      outcome.dispose();
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

interface ParsedEvents {
  answer: string | null;
  completed: boolean;
  usage: UsageSample[];
}

/** 回答是最后一条 agent_message；`error` 类 item 只是配置警告，忽略。 */
export function parseEvents(stdout: string): ParsedEvents {
  const usage: UsageSample[] = [];
  let answer: string | null = null;
  let completed = false;
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    let event: { type?: unknown; item?: { type?: unknown; text?: unknown }; usage?: Record<string, unknown> };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event === null || typeof event !== "object") continue;
    if (event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string") {
      answer = event.item.text;
    } else if (event.type === "turn.completed") {
      completed = true;
      const number = (field: unknown): number => typeof field === "number" && Number.isFinite(field) ? field : 0;
      const cached = number(event.usage?.cached_input_tokens);
      usage.push({
        input: number(event.usage?.input_tokens) - cached,
        output: number(event.usage?.output_tokens),
        cacheRead: cached,
        cacheWrite: number(event.usage?.cache_write_input_tokens),
      });
    }
  }
  return { answer, completed, usage };
}

function textOf(error: unknown): string {
  return error instanceof Error ? error.message : "unreadable";
}
