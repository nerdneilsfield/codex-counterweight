#!/usr/bin/env node
// 测试用假 claude：读 stdin，按同目录的 script.json 输出 `claude -p --output-format json` 的结果对象。
// script.json: { default: Behavior, byModel: { [model]: Behavior } }
// Behavior: { answer, failure, mode: "ok" | "hang", delayMs, maxTurns }
// maxTurns: 像真的 claude 那样以 error_max_turns 结束（没有 result 字段，退出码 1）。
// 每次调用往 calls.jsonl 追加 { args, stdin, model, pid }。
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";

const dir = path.dirname(process.argv[1]);
const args = process.argv.slice(2);
let stdin = "";
for await (const chunk of process.stdin) stdin += chunk;
const script = JSON.parse(readFileSync(path.join(dir, "script.json"), "utf8"));
const model = args[args.indexOf("--model") + 1];
const behavior = { answer: "none", mode: "ok", delayMs: 0, ...script.default, ...script.byModel?.[model] };
appendFileSync(path.join(dir, "calls.jsonl"), `${JSON.stringify({ args, stdin, model, pid: process.pid })}\n`);
if (behavior.mode === "hang") setInterval(() => {}, 1000);
else {
  setTimeout(() => {
    process.stdout.write(`${JSON.stringify({
      type: "result",
      subtype: behavior.maxTurns ? "error_max_turns" : behavior.failure ? "error_during_execution" : "success",
      is_error: Boolean(behavior.failure) || Boolean(behavior.maxTurns),
      ...(behavior.maxTurns ? {} : { result: behavior.failure ?? behavior.answer }),
      total_cost_usd: 0.25,
      usage: { input_tokens: 200, output_tokens: 40, cache_read_input_tokens: 800, cache_creation_input_tokens: 5 },
    })}\n`);
    process.exit(behavior.maxTurns ? 1 : 0);
  }, behavior.delayMs);
}
