#!/usr/bin/env node
// 测试用假 kimi：按同目录的 script.json 输出 `kimi -p ... --output-format stream-json` 的行，并像真的一样在
// $KIMI_CODE_HOME/sessions/wd_fake/<会话>/agents/main/wire.jsonl 写 usage.record。
// Behavior: { answer, failure, mode: "ok" | "hang", delayMs, tools: n, toolsThenHang: n }
// 每次调用往 calls.jsonl 追加 { args, model, agent, cwRole, pid }；agent 是 --agent-file 的内容。
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const dir = path.dirname(process.argv[1]);
const args = process.argv.slice(2);
const at = (flag) => args[args.indexOf(flag) + 1];
const script = JSON.parse(readFileSync(path.join(dir, "script.json"), "utf8"));
const model = at("-m");
const behavior = { answer: "none", mode: "ok", delayMs: 0, ...script.default, ...script.byModel?.[model] };
appendFileSync(path.join(dir, "calls.jsonl"), `${JSON.stringify({
  args, model, pid: process.pid, cwRole: process.env.CW_ROLE ?? null,
  agent: readFileSync(at("--agent-file"), "utf8"),
})}\n`);
const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
out({ role: "meta", type: "system.version", version: "2.5.0" });
const toolLine = (n) => out({ role: "assistant", tool_calls: [{ type: "function", id: `c${n}`, function: { name: "Read", arguments: "{}" } }] });
for (let n = 0; n < (behavior.toolsThenHang ?? 0); n += 1) toolLine(n);
if (behavior.mode === "hang" || behavior.toolsThenHang) setInterval(() => {}, 1000);
else {
  setTimeout(() => {
    if (behavior.failure) {
      process.stderr.write(`error: failed to run prompt: ${behavior.failure}\n`);
      process.exit(1);
    }
    for (let n = 0; n < (behavior.tools ?? 0); n += 1) toolLine(n);
    const session = `session_fake_${process.pid}`;
    const home = process.env.KIMI_CODE_HOME;
    if (home) {
      const wire = path.join(home, "sessions", "wd_fake", session, "agents", "main");
      mkdirSync(wire, { recursive: true });
      writeFileSync(path.join(wire, "wire.jsonl"), `${JSON.stringify({
        type: "usage.record", agentId: "main", model, usageScope: "turn", time: 1_800_000_000_000,
        usage: { inputOther: 200, output: 40, inputCacheRead: 800, inputCacheCreation: 5 },
      })}\n`);
    }
    out({ role: "assistant", content: behavior.answer });
    out({ role: "meta", type: "session.resume_hint", session_id: session });
    process.exit(0);
  }, behavior.delayMs);
}
