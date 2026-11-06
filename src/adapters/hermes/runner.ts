/**
 * Hermes 的角色子进程：`hermes -z` 跑一次，最终回答在 stdout，用量在 `--usage-file`。
 * Hermes 没有 `--system-prompt`，角色提示放在正文前面；正文第一行 `[counterweight-role:read|none]` 是给插件的标记：
 * 钩子在 gateway 进程里跑，拿不到调用方的环境变量，所以插件按这一行认出角色会话，对它放行除只读工具以外的一切拦截，
 * 并给 Node 入口设 `CW_ROLE=1`，使它不再检查、不再注入。工具集只给 `file`（读写都在里面，写由插件拦下）；planner 没有工具。
 * 模型写成 `provider/model` 时拆成 `--provider` 和 `-m`，没有斜杠就只传 `-m`。
 * Hermes 的 `-z` 不报步数，角色只有超时这一个上限；`-z` 的正文只能放在命令行，太长时写进文件让角色去读。
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runProcess } from "../../core/process.js";
import { rolePrompt } from "../../roles/prompts.js";
import { roleTimeoutMs, type RoleRequest, type RoleRun, type UsageSample } from "../../roles/run.js";

const INLINE_LIMIT = 100_000;

/** 角色会话正文第一行的标记；插件按它识别。 */
export const roleMarker = (role: RoleRequest["role"]): string => `[counterweight-role:${role === "planner" ? "none" : "read"}]`;

export function modelArgs(model: string): string[] {
  const slash = model.indexOf("/");
  return slash > 0 ? ["--provider", model.slice(0, slash), "-m", model.slice(slash + 1)] : ["-m", model];
}

export const runRole = async (request: Omit<RoleRequest, "timeoutMs"> & { timeoutMs?: number }): Promise<RoleRun> => {
  const scratch = await mkdtemp(path.join(tmpdir(), "cw-role-"));
  try {
    let task = request.message;
    if (Buffer.byteLength(task) > INLINE_LIMIT) {
      if (request.role === "planner") {
        return { answer: null, error: "输入超过命令行长度上限，planner 没有工具读文件", usage: [], timedOut: false, cancelled: false };
      }
      const messagePath = path.join(scratch, "message.md");
      await writeFile(messagePath, request.message);
      task = `Your task is in the file ${messagePath}. Read all of it with read_file first, then do exactly what it says and answer.`;
    }
    const prompt = `${roleMarker(request.role)}\n${rolePrompt(request.role)}\n\n---\n\n${task}`;
    const usagePath = path.join(scratch, "usage.json");
    const outcome = await runProcess({
      cwd: request.workRoot,
      cmd: ["hermes", "-z", prompt, ...modelArgs(request.model), "-t", request.role === "planner" ? "todo" : "file", "--ignore-rules", "--usage-file", usagePath],
      env: { ...process.env },
      timeoutMs: request.timeoutMs ?? roleTimeoutMs(request.role),
      stdoutPath: path.join(scratch, "stdout.txt"),
      stderrPath: path.join(scratch, "stderr.log"),
      signal: request.signal,
    });
    try {
      const report = await readFile(usagePath, "utf8").then((text) => JSON.parse(text) as Record<string, unknown>).catch(() => null);
      const number = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? value : 0;
      const usage: UsageSample[] = report === null ? [] : [{
        input: number(report.input_tokens), output: number(report.output_tokens),
        cacheRead: number(report.cache_read_tokens), cacheWrite: number(report.cache_write_tokens),
      }];
      const failure = (reason: string): RoleRun =>
        ({ answer: null, error: reason, usage, timedOut: outcome.timedOut, cancelled: outcome.cancelled });
      if (outcome.cancelled) return failure("已被取消");
      if (outcome.timedOut) return failure("超时，子进程组已终止");
      if (outcome.runnerError !== null) return failure(`无法启动 hermes：${outcome.runnerError}`);
      const answer = (await readFile(path.join(scratch, "stdout.txt"), "utf8").catch(() => "")).trim();
      if (outcome.exitCode !== 0 || report?.failed === true) {
        const stderr = await readFile(path.join(scratch, "stderr.log"), "utf8").catch(() => "");
        const detail = (typeof report?.failure === "string" ? report.failure : stderr.trim().split("\n").pop() ?? "").slice(0, 300);
        return failure(`未正常结束（退出码 ${outcome.exitCode}${detail === "" ? "" : `：${detail}`}）`);
      }
      if (answer === "") return failure("没有最终回答");
      return { answer, error: null, usage, timedOut: false, cancelled: false };
    } finally {
      outcome.dispose();
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
};
