import { execFileSync, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { modelArgs, runRole } from "../src/adapters/hermes/runner.js";
import { fakeCalls, HERMES_PLUGIN_ROOT, installFakeHermes, runHermesHook, writeConfig, type Sandbox } from "./support.js";

let repo: string;
let sandbox: Sandbox;
let savedPath: string | undefined;

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), "cw-hermes-"));
  const data = await mkdtemp(path.join(tmpdir(), "cw-hermes-data-"));
  sandbox = { repo, data, bin: path.join(data, "bin") };
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  savedPath = process.env.PATH;
  process.env.PATH = `${sandbox.bin}${path.delimiter}${savedPath ?? ""}`;
});

afterEach(async () => {
  process.env.PATH = savedPath;
  await rm(repo, { recursive: true, force: true });
  await rm(sandbox.data, { recursive: true, force: true });
});

const project = (text: string) => writeConfig(repo, "project.toml", text);
const hook = (name: string, input: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = {}) =>
  runHermesHook(sandbox, { hook: name, turn_id: "turn-A", ...input }, env);
const llm = (text = "go", extra: Record<string, unknown> = {}) =>
  hook("pre_llm_call", { user_message: text, conversation_history: [{ role: "user", content: text }], ...extra });
const tool = (name: string, args: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  hook("pre_tool_call", { tool_name: name, args, ...extra });
const verify = (extra: Record<string, unknown> = {}) =>
  hook("pre_verify", { attempt: 0, final_response: "done", changed_paths: [path.join(repo, "a.txt")], ...extra });
const blocked = (out: any): string | null => out?.action === "block" ? out.message : null;
const meterLines = async () => (await readFile(path.join(repo, ".cw/meter.jsonl"), "utf8").catch(() => ""))
  .split("\n").filter((line) => line !== "").map((line) => JSON.parse(line));
const git = (...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo });

describe("protection", () => {
  beforeEach(() => project('version = 1\n[protect]\npaths = ["tests"]\n'));

  it("blocks write_file and patch on protected paths, relative to the session directory", async () => {
    expect(blocked((await tool("write_file", { path: "tests/a.ts", content: "x" })).out)).toContain("受保护路径");
    expect(blocked((await tool("patch", { path: "tests/a.ts", old_string: "a", new_string: "b" })).out)).toContain("受保护路径");
    expect(blocked((await tool("write_file", { path: ".cw/hermes.toml", content: "" })).out)).toContain("受保护路径");
    expect((await tool("write_file", { path: "src/a.ts", content: "x" })).stdout).toBe("");
  });

  it("reads every file of a V4A multi-file patch", async () => {
    const patch = "*** Begin Patch\n*** Update File: src/ok.ts\n@@\n-a\n+b\n*** Add File: tests/new.ts\n+x\n*** End Patch";
    expect(blocked((await tool("patch", { mode: "patch", patch })).out)).toContain("tests/new.ts");
  });

  it("refuses the dangerous commands and keeps the scope", async () => {
    expect(blocked((await tool("terminal", { command: "git push -f origin main", workdir: repo })).out)).toContain("强制推送");
    expect(blocked((await tool("terminal", { command: "mkfs /dev/null-cw-probe" })).out)).toContain("mkfs");
    expect((await tool("terminal", { command: "git status" })).stdout).toBe("");
    await writeFile(path.join(repo, ".cw/scope.txt"), "src\n");
    expect(blocked((await tool("write_file", { path: "docs/a.md", content: "x" })).out)).toContain("scope.txt");
    expect((await tool("write_file", { path: "src/a.ts", content: "x" })).stdout).toBe("");
  });
});

describe("repo root fallback", () => {
  it("falls back to the repository of an absolute tool path when the session directory is unknown", async () => {
    await project('version = 1\n[protect]\npaths = ["tests"]\n');
    const result = await tool("write_file", { path: path.join(repo, "tests/a.ts"), content: "x" }, { cwd: "" });
    expect(blocked(result.out)).toContain("受保护路径");
  });

  it("falls back to changed_paths when the session directory is not a repository", async () => {
    await project('version = 1\n[check]\ncmd = ["sh", "-c", "echo boom; exit 3"]\n');
    const outside = await mkdtemp(path.join(tmpdir(), "cw-hermes-out-"));
    try {
      await llm("go", { cwd: outside });
      const result = await verify({ cwd: outside });
      expect(result.out).toMatchObject({ action: "continue" });
      expect(result.out.message).toContain("boom");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("does not guess when nothing leads to a repository: refuses a relative write and says the check did not run", async () => {
    await project('version = 1\n[check]\ncmd = ["sh", "-c", "exit 3"]\n');
    const outside = await mkdtemp(path.join(tmpdir(), "cw-hermes-out-"));
    try {
      const write = await tool("write_file", { path: "tests/a.ts", content: "x" }, { cwd: outside });
      expect(blocked(write.out)).toContain("找不到项目根目录");
      expect((await verify({ cwd: outside, changed_paths: [path.join(outside, "x.txt")] })).stdout).toBe("");
      const next = await llm("again", { turn_id: "turn-B", cwd: outside });
      expect(next.out.context).toContain("没有运行结束检查");
      await expect(stat(path.join(repo, ".cw/meter.jsonl"))).rejects.toThrow();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe("pre_verify: continuations and the attempt limit", () => {
  const findings = { byModel: { rv: { answer: "WRONG `a.txt:1`\n期望：x\n实际：y" }, ov: { answer: "none" } } };

  it("repairs once, then reports; attempt 2 never continues even with a free allowance", async () => {
    await project('version = 1\n[check]\ncmd = ["sh", "-c", "echo boom; exit 3"]\n');
    await llm();
    const first = await verify({ attempt: 0 });
    expect(first.out).toMatchObject({ action: "continue" });
    expect(first.out.message).toContain("boom");
    expect((await verify({ attempt: 1 })).stdout).toBe("");
    // 新回合额度是满的，但 Hermes 的 attempt 已到 2。
    await llm("again", { turn_id: "turn-B" });
    expect((await verify({ attempt: 2 })).stdout).toBe("");
    const outcomes = (await meterLines()).filter((line) => line.event === "check").map((line) => line.detail.outcome);
    expect(outcomes).toEqual(["feedback", "reported", "reported"]);
    expect((await llm("third", { turn_id: "turn-C" })).out.context).toContain("不再自动重试");
  });

  it("gives review findings their own continuation after the check passed, then only shows them", async () => {
    await writeFile(path.join(repo, "a.txt"), "1\n");
    git("add", "a.txt");
    git("commit", "-qm", "init");
    await writeConfig(repo, "hermes.toml", '[models]\nreview = "rv"\nover_review = "ov"\n');
    await project('version = 1\n[check]\ncmd = ["true"]\n[auto]\nreview = true\n');
    await installFakeHermes(sandbox, findings);
    await llm("把 a 改成 2");
    await writeFile(path.join(repo, "a.txt"), "2\n");
    const first = await verify({ attempt: 0 });
    expect(first.out).toMatchObject({ action: "continue" });
    expect(first.out.message).toContain("WRONG `a.txt:1`");
    expect((await verify({ attempt: 1 })).stdout).toBe("");
    expect((await llm("next", { turn_id: "turn-B" })).out.context).toContain("不再续跑");
    expect(await fakeCalls(sandbox)).toHaveLength(4);
  }, 30_000);

  it("scales the check and role limits from the hook budget the plugin reports", async () => {
    await project('version = 1\n[check]\ncmd = ["sh", "-c", "exit 3"]\ntimeout_s = 600\n');
    await llm();
    expect((await verify({ budget_s: 30 })).out.message).toContain("实际超时 15s");
    await llm("again", { turn_id: "turn-B" });
    expect((await verify({ budget_s: 600 })).out.message).toContain("实际超时 300s");
  });
});

describe("usage from post_api_request", () => {
  it("records each api_request_id once, with the host's own token counts", async () => {
    await project("version = 1\n");
    const call = (id: string, input: number) => hook("post_api_request", {
      api_request_id: id, model: "m", ended_at: 1_800_000_000,
      usage: { input_tokens: input, output_tokens: 7, cache_read_tokens: 3, cache_write_tokens: 2 },
    });
    await call("r1", 100);
    await call("r1", 100);
    await call("r2", 200);
    const usage = (await meterLines()).filter((line) => line.kind === "usage");
    expect(usage.map((line) => line.input)).toEqual([100, 200]);
    expect(usage[0]).toMatchObject({ session: "h1", model: "m", output: 7, cache_read: 3, cache_write: 2, cost_total: null, time: "2027-01-15T08:00:00.000Z" });
  });
});

describe("CW_ROLE", () => {
  it("makes every hook exit without output, state or meter, while the same input works without it", async () => {
    await project('version = 1\n[check]\ncmd = ["sh", "-c", "exit 3"]\n');
    const before = await readdir(sandbox.data);
    for (const name of ["pre_llm_call", "pre_tool_call", "pre_verify", "post_api_request", "on_session_end"]) {
      const result = await hook(name, { user_message: "x", tool_name: "write_file", args: { path: "a" }, attempt: 0, api_request_id: "r", usage: { input_tokens: 1 } }, { CW_ROLE: "1" });
      expect(result).toMatchObject({ stdout: "", stderr: "", code: 0 });
    }
    expect(await readdir(sandbox.data)).toEqual(before);
    await expect(stat(path.join(repo, ".cw/meter.jsonl"))).rejects.toThrow();
    expect((await llm()).out.context).toContain("active");
  });

  it("is set by the role runner's marker line, which the plugin recognises", async () => {
    await installFakeHermes(sandbox, {});
    expect(process.env.CW_ROLE).toBeUndefined();
    await runRole({ role: "review", workRoot: repo, model: "custom/m1", sandbox: "read-only", message: "要求" });
    const [call] = await fakeCalls(sandbox);
    expect(call!.args[0]).toBe("-z");
    expect(call!.args[1]).toMatch(/^\[counterweight-role:read\]\n/);
    expect(call!.args[1]).toContain("要求");
    expect(call!.args.slice(2, 6)).toEqual(["--provider", "custom", "-m", "m1"]);
  });
});

describe("injection, reports and the chronicle", () => {
  it("injects once, then goal changes, and delivers the report and the pending count with the next turn", async () => {
    await project('version = 1\n[check]\ncmd = ["true"]\n');
    await writeFile(path.join(repo, ".cw/pending.md"), "- 2026-11-05 | one\n- 2026-11-05 | two\n  detail\n");
    const first = await llm();
    expect(first.out.context).toContain("Counterweight 0.1.0 active");
    expect((await meterLines()).filter((line) => line.event === "inject")).toHaveLength(1);
    expect((await verify()).stdout).toBe("");
    await hook("on_session_end", { completed: true, turn_exit_reason: "text_response(finish_reason=stop)" });
    const second = await llm("again", { turn_id: "turn-B" });
    expect(second.out.context).not.toContain("active");
    expect(second.out.context).toContain("结束检查通过");
    expect(second.out.context).toContain("待批 2 条");
    await writeFile(path.join(repo, ".cw/goal.md"), "只改 a.txt\n");
    expect((await llm("third", { turn_id: "turn-C" })).out.context).toContain("只改 a.txt");
    expect((await llm("fourth", { turn_id: "turn-D" })).stdout).toBe("");
  });

  it("writes one chronicle event per turn from on_session_end, with the turn's verdict or the reason there is none", async () => {
    await mkdir(path.join(sandbox.data, ".agents/chronicle"), { recursive: true });
    await project('version = 1\n[check]\ncmd = ["sh", "-c", "exit 3"]\n');
    const events = async () => {
      const dir = path.join(sandbox.data, ".agents/chronicle");
      const machine = path.join(dir, "events", os.hostname().replace(/[^A-Za-z0-9._-]/g, "_"));
      const evidence = path.join(dir, "evidence", os.hostname().replace(/[^A-Za-z0-9._-]/g, "_"));
      const read = async (d: string) => Promise.all((await readdir(d).catch(() => [])).map(async (n) => JSON.parse(await readFile(path.join(d, n), "utf8"))));
      return { events: await read(machine), evidence: await read(evidence) };
    };
    // 回合一：没改代码，pre_verify 没触发。
    await llm();
    await hook("on_session_end", { completed: true, turn_exit_reason: "text_response(finish_reason=stop)" });
    // 回合二：改了代码，检查失败，续跑用完后报告。
    await llm("edit", { turn_id: "turn-B" });
    await verify({ attempt: 0 });
    await verify({ attempt: 1 });
    await hook("on_session_end", { turn_id: "turn-B", completed: true, turn_exit_reason: "text_response(finish_reason=stop)" });
    // 回合三：被中断。
    await llm("stop me", { turn_id: "turn-C" });
    await hook("on_session_end", { turn_id: "turn-C", completed: false, interrupted: true, turn_exit_reason: "interrupted" });
    const { events: written, evidence } = await events();
    expect(written.map((event) => event.outcome).sort()).toEqual(["cancelled", "failed", "unknown"]);
    expect(written.every((event) => event.agent === "hermes:h1" && event.workspace === repo)).toBe(true);
    const gaps = evidence.map((item) => item.gap).filter((gap) => gap !== undefined).join("\n");
    expect(gaps).toContain("本回合没有改代码");
    expect(gaps).toContain("回合被中断（interrupted）");
    expect(evidence.some((item) => typeof item.text === "string" && item.text.includes("退出码 3"))).toBe(true);
  });
});

describe("runRole", () => {
  const request = (role: "review" | "planner", message = "要求") =>
    ({ role, workRoot: repo, model: "m1", sandbox: "read-only" as const, message });

  it("returns the answer and the usage file's counts, with read-only tools and no tools for the planner", async () => {
    await installFakeHermes(sandbox, { default: { answer: "none" } });
    const run = await runRole(request("review"));
    expect(run).toMatchObject({ answer: "none", error: null });
    expect(run.usage).toEqual([{ input: 200, output: 40, cacheRead: 800, cacheWrite: 5 }]);
    await runRole(request("planner"));
    const calls = await fakeCalls(sandbox);
    expect(calls[0]!.args).toContain("file");
    expect(calls[0]!.args).toContain("--ignore-rules");
    expect(calls[1]!.args[1]).toMatch(/^\[counterweight-role:none\]\n/);
    expect(calls[1]!.args).toContain("todo");
  });

  it("reports a failed run with the usage file's reason", async () => {
    await installFakeHermes(sandbox, { default: { failure: "provider refused" } });
    const run = await runRole(request("review"));
    expect(run.answer).toBeNull();
    expect(run.error).toContain("未正常结束");
    expect(run.error).toContain("provider refused");
  });

  it("times out and splits provider/model only at the first slash", async () => {
    await installFakeHermes(sandbox, { default: { mode: "hang" } });
    const run = await runRole({ ...request("review"), timeoutMs: 600 });
    expect(run.timedOut).toBe(true);
    expect(modelArgs("openrouter/anthropic/claude")).toEqual(["--provider", "openrouter", "-m", "anthropic/claude"]);
    expect(modelArgs("plain")).toEqual(["-m", "plain"]);
  }, 20_000);

  it("hands an oversize message over as a file, and refuses it for the planner", async () => {
    await installFakeHermes(sandbox, {});
    await runRole(request("review", "x".repeat(120_000)));
    const [call] = await fakeCalls(sandbox);
    expect(call!.args[1]).toContain("message.md");
    expect(call!.args[1]!.length).toBeLessThan(3_000);
    expect((await runRole(request("planner", "x".repeat(120_000)))).error).toContain("命令行长度");
  });
});

describe("the Python plugin", () => {
  /** 假 node 记录收到的环境和载荷；真插件用它代替 dist/hook.cjs 的执行。 */
  async function drive(events: Array<[string, Record<string, unknown>]>): Promise<{ results: unknown[]; calls: Array<{ role: string | null; payload: any }> }> {
    await mkdir(sandbox.bin, { recursive: true });
    const log = path.join(sandbox.data, "node-calls.jsonl");
    await writeFile(path.join(sandbox.bin, "node"),
      `#!/bin/sh\nnode_in=$(cat)\nprintf '%s\\t%s\\n' "$CW_ROLE" "$node_in" >> ${log}\nprintf '{"context":"from-node"}'\n`);
    await chmod(path.join(sandbox.bin, "node"), 0o755);
    const script = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("cwplugin", sys.argv[1] + "/__init__.py")
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
hooks = {}
class Ctx:
    def register_hook(self, name, cb): hooks[name] = cb
mod.register(Ctx())
print(json.dumps([hooks[name](**kw) for name, kw in json.loads(sys.argv[2])]))
`;
    const out = await new Promise<string>((resolve, reject) => {
      const child = spawn("python3", ["-I", "-c", script, HERMES_PLUGIN_ROOT, JSON.stringify(events)],
        { env: { ...process.env, PATH: `${sandbox.bin}${path.delimiter}${process.env.PATH ?? ""}` }, stdio: ["ignore", "pipe", "inherit"] });
      let text = "";
      child.stdout.on("data", (chunk) => { text += chunk; });
      child.once("error", reject);
      child.once("close", () => resolve(text));
    });
    const calls = (await readFile(log, "utf8").catch(() => "")).split("\n").filter((line) => line !== "")
      .map((line) => ({ role: line.split("\t")[0] || null, payload: JSON.parse(line.slice(line.indexOf("\t") + 1)) }));
    return { results: JSON.parse(out), calls };
  }

  it("forwards hooks with the hook name and the 30 second default budget when Hermes cannot be imported", async () => {
    const { results, calls } = await drive([["pre_llm_call", { session_id: "s1", user_message: "hi" }]]);
    expect(results).toEqual([{ context: "from-node" }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.role).toBeNull();
    expect(calls[0]!.payload).toMatchObject({ hook: "pre_llm_call", session_id: "s1", budget_s: 30, cwd: "" });
  });

  it("marks a role session from its first line: read-only tools, CW_ROLE for Node, nothing for other sessions", async () => {
    const { results, calls } = await drive([
      ["pre_llm_call", { session_id: "role1", user_message: "[counterweight-role:read]\nrules" }],
      ["pre_tool_call", { session_id: "role1", tool_name: "read_file", args: {} }],
      ["pre_tool_call", { session_id: "role1", tool_name: "write_file", args: {} }],
      ["pre_llm_call", { session_id: "plan1", user_message: "[counterweight-role:none]\nrules" }],
      ["pre_tool_call", { session_id: "plan1", tool_name: "read_file", args: {} }],
      ["pre_tool_call", { session_id: "user1", tool_name: "write_file", args: {} }],
    ]);
    expect(results[1]).toBeNull();
    expect(results[2]).toMatchObject({ action: "block" });
    expect(results[4]).toMatchObject({ action: "block" });
    expect(results[5]).toEqual({ context: "from-node" });
    // Node 只被调用了两次，一次是角色的 pre_llm_call 和 planner 的 pre_llm_call 之外的……逐个核对。
    expect(calls.map((call) => [call.payload.session_id, call.role])).toEqual([["role1", "1"], ["plan1", "1"], ["user1", null]]);
  });
});

describe("plugin package", () => {
  it("keeps __init__.py within 40 lines and declares the version the injected line reports", async () => {
    const init = await readFile(path.join(HERMES_PLUGIN_ROOT, "__init__.py"), "utf8");
    expect(init.trimEnd().split("\n").length).toBeLessThanOrEqual(40);
    expect(await readFile(path.join(HERMES_PLUGIN_ROOT, "plugin.yaml"), "utf8")).toMatch(/^version: "0\.1\.0"$/m);
  });
});
