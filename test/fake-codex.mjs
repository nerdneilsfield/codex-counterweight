#!/usr/bin/env node
// 测试用假 codex：读 stdin，按同目录的 script.json 输出 `codex exec --json` 的 JSONL。
// script.json: { default: Behavior, byModel: { [model]: Behavior } }
// Behavior: { answer, usage, mode: "ok" | "hang" | "noturn", delayMs, tools }
// tools: 先发这么多条已完成的 command_execution item，用来数步。
// 每次调用往 calls.jsonl 追加 { args, stdin, pid, childPid }。
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";

const dir = path.dirname(process.argv[1]);
const args = process.argv.slice(2);
let stdin = "";
for await (const chunk of process.stdin) stdin += chunk;
const script = JSON.parse(readFileSync(path.join(dir, "script.json"), "utf8"));
const model = args[args.indexOf("-m") + 1];
const behavior = { answer: "none", mode: "ok", delayMs: 0, ...script.default, ...script.byModel?.[model] };
const usage = behavior.usage ?? {
  input_tokens: 1000, cached_input_tokens: 800, cache_write_input_tokens: 5, output_tokens: 40,
};
// 同进程组的孤儿孙进程，用来验证整组被回收。
const child = spawn("sleep", ["300"], { stdio: "ignore" });
appendFileSync(path.join(dir, "calls.jsonl"),
  `${JSON.stringify({ args, stdin, model, pid: process.pid, childPid: child.pid })}\n`);
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
emit({ type: "thread.started", thread_id: "t" });
emit({ type: "item.completed", item: { id: "i0", type: "error", message: "config warning" } });
for (let i = 0; i < (behavior.tools ?? 0); i++) {
  emit({ type: "item.completed", item: { id: `t${i}`, type: "command_execution", command: "true", exit_code: 0 } });
}
if (behavior.mode === "hang") setInterval(() => {}, 1000);
else {
  setTimeout(() => {
    emit({ type: "item.completed", item: { id: "i1", type: "agent_message", text: behavior.answer } });
    if (behavior.failure) emit({ type: "turn.failed", error: { message: behavior.failure } });
    if (behavior.mode !== "noturn") emit({ type: "turn.completed", usage });
    child.kill();
    process.exit(0);
  }, behavior.delayMs);
}
