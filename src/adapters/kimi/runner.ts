/**
 * Kimi Code 的角色子进程：`kimi -p` 跑一次，结果是 stream-json 的行。
 * 只读靠 `--agent-file`：普通角色只有 `Read, Grep, Glob`，planner 没有工具；角色提示就是 agent 文件的正文，
 * 它取代 Kimi 自己的系统提示。子进程带 `CW_ROLE=1`，插件的 hook 和 MCP 看到就退出，所以角色里不会再跑检查或再起角色。
 * `-p` 只能从命令行取正文，太长时（Linux 单个参数 128 KiB）把正文写进文件，让角色去读。
 * 用量不在输出里，在会话的 `wire.jsonl`；会话 id 来自输出末尾的 `session.resume_hint`，被中止的运行拿不到它，用量记不上。
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { budgetMessage, stepLimit, watchSteps } from "../../core/budget.js";
import { runProcess } from "../../core/process.js";
import { roleEnv } from "../../core/role.js";
import { rolePrompt } from "../../roles/prompts.js";
import { roleTimeoutMs, type RoleRequest, type RoleRun, type UsageSample } from "../../roles/run.js";
import { sessionWires, wireUsage } from "./wire.js";

/** 超过这个字节数就不放进命令行。 */
const INLINE_LIMIT = 100_000;

export function agentFile(role: RoleRequest["role"]): string {
  const name = `cw-${role.replace("_", "-")}`;
  const tools = role === "planner" ? '""' : "Read, Grep, Glob";
  return `---\nname: ${name}\ndescription: Counterweight ${role} role\ntools: ${tools}\n---\n${rolePrompt(role)}\n`;
}

function roleArgs(request: Pick<RoleRequest, "role" | "model">, agentPath: string, prompt: string, extraDir: string | null): string[] {
  return [
    "-p", prompt, "-m", request.model,
    "--output-format", "stream-json",
    "--agent-file", agentPath,
    ...(extraDir === null ? [] : ["--add-dir", extraDir]),
  ];
}

/** 带 tool_calls 的助手行数：一次工具调用的回合算一步。 */
export function countSteps(stdout: string): number {
  let count = 0;
  for (const line of stdout.split("\n")) {
    if (!line.includes('"tool_calls"')) continue;
    try {
      const entry = JSON.parse(line) as { role?: unknown; tool_calls?: unknown };
      if (entry.role === "assistant" && Array.isArray(entry.tool_calls) && entry.tool_calls.length > 0) count += 1;
    } catch {
      // A torn last line while the file is still being written.
    }
  }
  return count;
}

interface Parsed { answer: string | null; session: string | null }

function parse(stdout: string): Parsed {
  let answer: string | null = null;
  let session: string | null = null;
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      if (entry.role === "assistant" && typeof entry.content === "string" && entry.content.trim() !== "" && entry.tool_calls === undefined) {
        answer = entry.content;
      } else if (entry.type === "session.resume_hint" && typeof entry.session_id === "string") {
        session = entry.session_id;
      }
    } catch {
      continue;
    }
  }
  return { answer, session };
}

async function usageOf(session: string | null): Promise<UsageSample[]> {
  if (session === null) return [];
  try {
    return (await sessionWires(session)).flatMap((wire) => wireUsage(wire.text)).map((item) =>
      ({ input: item.input, output: item.output, cacheRead: item.cacheRead, cacheWrite: item.cacheWrite }));
  } catch {
    return [];
  }
}

export const runRole = async (request: Omit<RoleRequest, "timeoutMs"> & { timeoutMs?: number }): Promise<RoleRun> => {
  const scratch = await mkdtemp(path.join(tmpdir(), "cw-role-"));
  try {
    const agentPath = path.join(scratch, "agent.md");
    await writeFile(agentPath, agentFile(request.role));
    let prompt = request.message;
    let extraDir: string | null = null;
    if (Buffer.byteLength(prompt) > INLINE_LIMIT) {
      if (request.role === "planner") {
        return { answer: null, error: "输入超过命令行长度上限，planner 没有工具读文件", usage: [], timedOut: false, cancelled: false };
      }
      const messagePath = path.join(scratch, "message.md");
      await writeFile(messagePath, request.message);
      prompt = `Your task is in the file ${messagePath}. Read all of it with the Read tool first, then do exactly what it says and answer.`;
      extraDir = scratch;
    }
    const limit = stepLimit(request.role);
    const own = new AbortController();
    const forward = () => own.abort();
    if (request.signal?.aborted) forward();
    else request.signal?.addEventListener("abort", forward, { once: true });
    let overBudget = false;
    const stdoutPath = path.join(scratch, "stdout.jsonl");
    const stopWatch = watchSteps({
      file: stdoutPath, limit, count: countSteps, signal: own.signal,
      onExceed: () => { overBudget = true; own.abort(); },
    });
    let outcome;
    try {
      outcome = await runProcess({
        cwd: request.workRoot,
        cmd: ["kimi", ...roleArgs(request, agentPath, prompt, extraDir)],
        env: roleEnv(),
        timeoutMs: request.timeoutMs ?? roleTimeoutMs(request.role),
        stdoutPath,
        stderrPath: path.join(scratch, "stderr.log"),
        signal: own.signal,
      });
    } finally {
      stopWatch();
      request.signal?.removeEventListener("abort", forward);
    }
    try {
      const stdout = await readFile(stdoutPath, "utf8").catch(() => "");
      const { answer, session } = parse(stdout);
      const usage = await usageOf(session);
      const failure = (reason: string): RoleRun =>
        ({ answer: null, error: reason, usage, timedOut: outcome.timedOut, cancelled: outcome.cancelled });
      if (overBudget && !(session !== null && answer !== null)) {
        return { ...failure(budgetMessage(limit)), budget: true, cancelled: false };
      }
      if (outcome.cancelled) return failure("已被取消");
      if (outcome.timedOut) return failure("超时，子进程组已终止");
      if (outcome.runnerError !== null) return failure(`无法启动 kimi：${outcome.runnerError}`);
      if (session === null) {
        const stderr = await readFile(path.join(scratch, "stderr.log"), "utf8").catch(() => "");
        const tail = [...stderr.trim().split("\n"), ...stdout.trim().split("\n")].filter((line) => line.startsWith("error:")).pop()
          ?? stderr.trim().split("\n").pop() ?? "";
        return failure(`未正常结束（退出码 ${outcome.exitCode}${tail === "" ? "" : `：${tail.slice(0, 300)}`}）`);
      }
      if (answer === null) return failure("没有最终回答");
      return { answer, error: null, usage, timedOut: false, cancelled: false };
    } finally {
      outcome.dispose();
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
};
