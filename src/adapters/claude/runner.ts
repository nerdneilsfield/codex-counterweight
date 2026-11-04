/**
 * Claude Code 的角色子进程：`claude -p` 跑一次，正文从 stdin 文件传入，结果是一个 JSON 对象。
 * 只读靠工具白名单：普通角色 `Read,Grep`，planner 没有工具；`--strict-mcp-config` 关掉 MCP 工具；
 * 子进程里 hook 全关。`--tools` 是变长参数，所以它后面不能放位置参数，提示走 stdin。
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runProcess } from "../../core/process.js";
import { rolePrompt } from "../../roles/prompts.js";
import type { RoleRequest, RoleRun, RoleRunner } from "../../roles/run.js";

function roleArgs(request: Pick<RoleRequest, "role" | "model">): string[] {
  return [
    "-p", "--model", request.model,
    "--settings", '{"disableAllHooks":true}',
    "--strict-mcp-config",
    "--system-prompt", rolePrompt(request.role),
    "--output-format", "json",
    "--tools", request.role === "planner" ? "" : "Read,Grep",
  ];
}

export const runRole: RoleRunner = async (request) => {
  const scratch = await mkdtemp(path.join(tmpdir(), "cw-role-"));
  try {
    const messagePath = path.join(scratch, "message.md");
    await writeFile(messagePath, request.message);
    const outcome = await runProcess({
      cwd: request.workRoot,
      cmd: ["claude", ...roleArgs(request)],
      env: { ...process.env },
      timeoutMs: request.timeoutMs,
      stdoutPath: path.join(scratch, "stdout.json"),
      stderrPath: path.join(scratch, "stderr.log"),
      stdinPath: messagePath,
      signal: request.signal,
    });
    try {
      const flags = { timedOut: outcome.timedOut, cancelled: outcome.cancelled };
      const failure = (reason: string, usage: RoleRun["usage"] = []): RoleRun =>
        ({ answer: null, error: reason, usage, ...flags });
      if (outcome.cancelled) return failure("已被取消");
      if (outcome.timedOut) return failure("超时，子进程组已终止");
      if (outcome.runnerError !== null) return failure(`无法启动 claude：${outcome.runnerError}`);
      const stdout = await readFile(path.join(scratch, "stdout.json"), "utf8").catch(() => "");
      let result: Record<string, any> | null = null;
      try {
        const parsed = JSON.parse(stdout);
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) result = parsed;
      } catch {
        // Reported below with the stderr tail.
      }
      if (result === null) {
        const stderr = await readFile(path.join(scratch, "stderr.log"), "utf8").catch(() => "");
        const detail = stderr.trim().split("\n").pop()?.slice(0, 300) ?? "";
        return failure(`输出不可解析（退出码 ${outcome.exitCode}${detail === "" ? "" : `：${detail}`}）`);
      }
      const number = (field: unknown): number => typeof field === "number" && Number.isFinite(field) ? field : 0;
      const usage = [{
        input: number(result.usage?.input_tokens),
        output: number(result.usage?.output_tokens),
        cacheRead: number(result.usage?.cache_read_input_tokens),
        cacheWrite: number(result.usage?.cache_creation_input_tokens),
        costTotal: typeof result.total_cost_usd === "number" ? result.total_cost_usd : null,
      }];
      const answer = typeof result.result === "string" ? result.result : null;
      if (result.is_error === true) {
        return failure(`未正常结束（${result.subtype ?? "error"}${answer === null || answer === "" ? "" : `：${answer.slice(0, 300)}`}）`, usage);
      }
      if (answer === null) return failure("没有最终回答", usage);
      if (answer.trim() === "") return failure("返回空回答", usage);
      return { answer, error: null, usage, timedOut: false, cancelled: false };
    } finally {
      outcome.dispose();
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
};
