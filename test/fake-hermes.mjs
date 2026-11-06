#!/usr/bin/env node
// 测试用假 hermes：按同目录的 script.json 输出 `hermes -z` 的最终回答，并写 --usage-file。
// Behavior: { answer, failure, mode: "ok" | "hang", delayMs }
// 每次调用往 calls.jsonl 追加 { args, model, cwRole, pid }。
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const dir = path.dirname(process.argv[1]);
const args = process.argv.slice(2);
const at = (flag) => args[args.indexOf(flag) + 1];
const script = JSON.parse(readFileSync(path.join(dir, "script.json"), "utf8"));
const model = at("-m");
const behavior = { answer: "none", mode: "ok", delayMs: 0, ...script.default, ...script.byModel?.[model] };
appendFileSync(path.join(dir, "calls.jsonl"), `${JSON.stringify({ args, model, pid: process.pid, cwRole: process.env.CW_ROLE ?? null })}\n`);
if (behavior.mode === "hang") setInterval(() => {}, 1000);
else {
  setTimeout(() => {
    const usage = {
      input_tokens: 200, output_tokens: 40, cache_read_tokens: 800, cache_write_tokens: 5,
      failed: Boolean(behavior.failure), ...(behavior.failure ? { failure: behavior.failure } : {}),
    };
    const file = at("--usage-file");
    if (file) writeFileSync(file, JSON.stringify(usage));
    if (behavior.failure) {
      process.stderr.write(`hermes -z: agent failed: ${behavior.failure}\n`);
      process.exit(1);
    }
    process.stdout.write(`${behavior.answer}\n`);
    process.exit(0);
  }, behavior.delayMs);
}
