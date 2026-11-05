/**
 * Codex 的角色子进程：`codex exec` 跑一次，正文从 stdin 文件传入。只读靠 `-s read-only`（或用户显式关掉沙箱），
 * planner 另外关掉 shell 和联网；hook 和插件在子进程里都关着。
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { budgetMessage, stepLimit, watchSteps } from "../../core/budget.js";
import { runProcess } from "../../core/process.js";
import { rolePrompt } from "../../roles/prompts.js";
import { roleTimeoutMs, type RoleRequest, type RoleRun, type UsageSample } from "../../roles/run.js";

function roleArgs(request: Pick<RoleRequest, "role" | "model" | "sandbox">): string[] {
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

/** 单独调用时可以不给 timeoutMs，用角色默认值。 */
export async function runRole(request: Omit<RoleRequest, "timeoutMs"> & { timeoutMs?: number }): Promise<RoleRun> {
  const scratch = await mkdtemp(path.join(tmpdir(), "cw-role-"));
  try {
    const messagePath = path.join(scratch, "message.md");
    await writeFile(messagePath, request.message);
    // 超过步数上限时中止进程；中止信号同时听调用方的 signal。
    const limit = stepLimit(request.role);
    const own = new AbortController();
    const forward = () => own.abort();
    if (request.signal?.aborted) forward();
    else request.signal?.addEventListener("abort", forward, { once: true });
    let overBudget = false;
    const stdoutPath = path.join(scratch, "stdout.jsonl");
    const stopWatch = watchSteps({
      file: stdoutPath, limit, count: countToolItems, signal: own.signal,
      onExceed: () => { overBudget = true; own.abort(); },
    });
    let outcome;
    try {
      outcome = await runProcess({
        cwd: request.workRoot,
        cmd: ["codex", ...roleArgs(request)],
        env: { ...process.env },
        timeoutMs: request.timeoutMs ?? roleTimeoutMs(request.role),
        stdoutPath,
        stderrPath: path.join(scratch, "stderr.log"),
        stdinPath: messagePath,
        signal: own.signal,
      });
    } finally {
      stopWatch();
      request.signal?.removeEventListener("abort", forward);
    }
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
      if (overBudget && !(events.completed && events.answer !== null)) {
        return { ...failure(budgetMessage(limit)), budget: true, cancelled: false };
      }
      if (outcome.cancelled) return failure("已被取消");
      if (outcome.timedOut) return failure("超时，子进程组已终止");
      if (outcome.runnerError !== null) return failure(`无法启动 codex：${outcome.runnerError}`);
      if (!events.completed) {
        const stderr = await readFile(path.join(scratch, "stderr.log"), "utf8").catch(() => "");
        const detail = events.failure ?? stderr.trim().split("\n").pop()?.slice(0, 300) ?? "";
        return failure(`未正常结束（退出码 ${outcome.exitCode}${detail === "" ? "" : `：${detail}`}）`);
      }
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

/** 已完成的工具 item 数：除回答、推理、告警和待办清单之外的 `item.completed`。 */
export function countToolItems(stdout: string): number {
  let count = 0;
  for (const line of stdout.split("\n")) {
    if (!line.includes('"item.completed"')) continue;
    try {
      const type = (JSON.parse(line) as { item?: { type?: unknown } }).item?.type;
      if (typeof type === "string" && !["agent_message", "reasoning", "error", "todo_list"].includes(type)) count += 1;
    } catch {
      // A torn last line while the file is still being written.
    }
  }
  return count;
}

interface ParsedEvents {
  answer: string | null;
  completed: boolean;
  /** `turn.failed` 或顶层 `error` 事件带的原因。 */
  failure: string | null;
  usage: UsageSample[];
}

/** 回答是最后一条 agent_message；`error` 类 item 只是配置警告，忽略。 */
function parseEvents(stdout: string): ParsedEvents {
  const usage: UsageSample[] = [];
  let answer: string | null = null;
  let completed = false;
  let failure: string | null = null;
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    let event: {
      type?: unknown; item?: { type?: unknown; text?: unknown }; usage?: Record<string, unknown>;
      message?: unknown; error?: { message?: unknown };
    };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event === null || typeof event !== "object") continue;
    if (event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string") {
      answer = event.item.text;
    } else if (event.type === "turn.failed" || event.type === "error") {
      const reason = event.error?.message ?? event.message;
      if (typeof reason === "string") failure = reason;
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
  return { answer, completed, failure, usage };
}

function textOf(error: unknown): string {
  return error instanceof Error ? error.message : "unreadable";
}
