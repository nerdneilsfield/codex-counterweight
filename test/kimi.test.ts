import { execFileSync } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runRole } from "../src/adapters/kimi/runner.js";
import { fakeCalls, installFakeKimi, KIMI_PLUGIN_ROOT, runKimiHook, writeConfig, type Sandbox } from "./support.js";

let repo: string;
let sandbox: Sandbox;
let savedPath: string | undefined;
let savedHome: string | undefined;

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), "cw-kimi-"));
  const data = await mkdtemp(path.join(tmpdir(), "cw-kimi-data-"));
  sandbox = { repo, data, bin: path.join(data, "bin") };
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  // runRole 直接在测试进程里跑：假 kimi 在 PATH 最前，Kimi 主目录指向临时目录。
  savedPath = process.env.PATH;
  savedHome = process.env.KIMI_CODE_HOME;
  process.env.PATH = `${sandbox.bin}${path.delimiter}${savedPath ?? ""}`;
  process.env.KIMI_CODE_HOME = path.join(data, "kimi-home");
});

afterEach(async () => {
  process.env.PATH = savedPath;
  if (savedHome === undefined) delete process.env.KIMI_CODE_HOME;
  else process.env.KIMI_CODE_HOME = savedHome;
  await rm(repo, { recursive: true, force: true });
  await rm(sandbox.data, { recursive: true, force: true });
});

const project = (text: string) => writeConfig(repo, "project.toml", text);
const hook = (input: Record<string, unknown>, env: NodeJS.ProcessEnv = {}) => runKimiHook(sandbox, input, env);
const prompt = (text = "go", extra: Record<string, unknown> = {}) =>
  hook({ hook_event_name: "UserPromptSubmit", prompt: [{ type: "text", text }], ...extra });
const stop = (extra: Record<string, unknown> = {}) => hook({ hook_event_name: "Stop", stop_hook_active: false, ...extra });
const tool = (name: string, input: Record<string, unknown>) => hook({ hook_event_name: "PreToolUse", tool_name: name, tool_input: input });
const denial = (stdout: string): string | null => {
  if (stdout === "") return null;
  const out = JSON.parse(stdout).hookSpecificOutput;
  return out?.permissionDecision === "deny" ? out.permissionDecisionReason : null;
};
const meterLines = async () => (await readFile(path.join(repo, ".cw/meter.jsonl"), "utf8").catch(() => ""))
  .split("\n").filter((line) => line !== "").map((line) => JSON.parse(line));
const git = (...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo });

describe("plugin manifest", () => {
  it("keeps the hook timeouts inside Kimi's 600 second cap and the Stop budget inside its hook", async () => {
    const manifest = JSON.parse(await readFile(path.join(KIMI_PLUGIN_ROOT, ".kimi-plugin/plugin.json"), "utf8"));
    for (const entry of manifest.hooks) expect(entry.timeout).toBeLessThanOrEqual(600);
    const stopHook = manifest.hooks.find((entry: { event: string }) => entry.event === "Stop");
    expect(stopHook.timeout).toBe(600);
    // 检查 300 秒加一轮角色 270 秒，仍在 Stop 的 600 秒内；史官在角色之后，最坏情况另有一轮，写在 README 的限制里。
    expect(300 + 270).toBeLessThanOrEqual(stopHook.timeout);
  });
});

describe("protection", () => {
  beforeEach(() => project('version = 1\n[protect]\npaths = ["tests"]\n'));

  it("denies Write and Edit on protected paths, and the host config", async () => {
    expect(denial((await tool("Write", { path: "tests/a.ts", content: "x" })).stdout)).toContain("受保护路径");
    expect(denial((await tool("Edit", { path: "tests/a.ts", old_string: "a", new_string: "b" })).stdout)).toContain("受保护路径");
    expect(denial((await tool("Write", { path: ".cw/kimi.toml", content: "" })).stdout)).toContain("受保护路径");
    expect(denial((await tool("Write", { path: ".cw/hermes.toml", content: "" })).stdout)).toContain("受保护路径");
  });

  it("is silent for an unprotected path and denies a call with no path", async () => {
    expect((await tool("Write", { path: "src/a.ts", content: "x" })).stdout).toBe("");
    expect(denial((await tool("Write", { content: "x" })).stdout)).toContain("无法");
  });

  it("refuses the dangerous commands and keeps the scope", async () => {
    expect(denial((await tool("Bash", { command: "git push -f origin main" })).stdout)).toContain("强制推送");
    expect(denial((await tool("Bash", { command: "mkfs /dev/null-cw-probe" })).stdout)).toContain("mkfs");
    expect((await tool("Bash", { command: "git status" })).stdout).toBe("");
    await writeFile(path.join(repo, ".cw/scope.txt"), "src\n");
    expect(denial((await tool("Write", { path: "docs/a.md", content: "x" })).stdout)).toContain("scope.txt");
    expect((await tool("Write", { path: "src/a.ts", content: "x" })).stdout).toBe("");
  });
});

describe("Stop: one continuation per turn", () => {
  const findings = { byModel: { rv: { answer: "WRONG `a.txt:1`\n期望：x\n实际：y" }, ov: { answer: "none" } } };

  async function reviewRepo(check: string): Promise<void> {
    await writeFile(path.join(repo, "a.txt"), "1\n");
    git("add", "a.txt");
    git("commit", "-qm", "init");
    await writeConfig(repo, "kimi.toml", '[models]\nreview = "rv"\nover_review = "ov"\n');
    await project(`version = 1\n[check]\ncmd = ${check}\n[auto]\nreview = true\n`);
    await installFakeKimi(sandbox, findings);
    await prompt("把 a 改成 2");
    await writeFile(path.join(repo, "a.txt"), "2\n");
  }

  it("repairs once through exit code 2, shows the rest at the next prompt, and gives a new prompt a new turn", async () => {
    await project('version = 1\n[check]\ncmd = ["sh", "-c", "echo boom; exit 3"]\ntimeout_s = 600\n');
    await prompt();
    const first = await stop();
    expect(first.code).toBe(2);
    expect(first.stdout).toBe("");
    expect(first.stderr).toContain("boom");
    // 假设 Kimi 又触发了一次 Stop（实测它不会）：同一回合不再续跑。
    const second = await stop();
    expect(second.code).toBe(0);
    const next = await prompt("again");
    expect(next.stdout).toContain("退出码 3");
    expect((await stop()).code).toBe(2);
  });

  it("applies the host budget: the check's reported timeout is 300 seconds, not 600", async () => {
    await project('version = 1\n[check]\ncmd = ["sh", "-c", "exit 3"]\ntimeout_s = 600\n');
    await prompt();
    expect((await stop()).stderr).toContain("check.timeout_s=600 超过上限，实际超时 300s");
  });

  it("gives the one continuation to the check, and only shows the review findings afterwards", async () => {
    await reviewRepo('["sh", "-c", "echo boom; exit 3"]');
    const first = await stop();
    expect(first.code).toBe(2);
    expect(first.stderr).toContain("boom");
    expect(await fakeCalls(sandbox)).toHaveLength(0);
    const second = await stop();
    expect(second.code).toBe(0);
    expect(await fakeCalls(sandbox)).toHaveLength(2);
    const note = (await prompt("next")).stdout;
    expect(note).toContain("退出码 3");
    expect(note).toContain("不再续跑");
    expect(note).toContain("WRONG `a.txt:1`");
  }, 30_000);

  it("continues for review findings when the check passed, once", async () => {
    await reviewRepo('["true"]');
    const first = await stop();
    expect(first.code).toBe(2);
    expect(first.stderr).toContain("自动审查有发现");
    expect(first.stderr).toContain("WRONG `a.txt:1`");
    const second = await stop();
    expect(second.code).toBe(0);
    expect((await prompt("next")).stdout).toContain("不再续跑");
    expect(await fakeCalls(sandbox)).toHaveLength(4);
  }, 30_000);
});

describe("usage from wire.jsonl", () => {
  const wireDir = (agent: string) => path.join(sandbox.data, "kimi-home/sessions/wd_x/k1/agents", agent);
  const record = (input: number, time: number, agentId = "main") => JSON.stringify({
    type: "usage.record", agentId, model: "cw/terra", usageScope: "turn", time,
    usage: { inputOther: input, output: 1, inputCacheRead: 2, inputCacheCreation: 3 },
  });

  it("records each usage.record once across Stop, prompt and SessionEnd, including a second agent", async () => {
    await project("version = 1\n");
    await mkdir(wireDir("main"), { recursive: true });
    const main = path.join(wireDir("main"), "wire.jsonl");
    // 11 出现两次（同一行重复），22 一次。
    await writeFile(main, `${record(11, 1000)}\n${record(11, 1000)}\n${record(22, 2000)}\nnot json\n`);
    await prompt();
    await stop();
    const firstPass = (await meterLines()).filter((line) => line.kind === "usage");
    expect(firstPass.map((line) => line.input).sort()).toEqual([11, 22]);
    expect(firstPass[0]).toMatchObject({ session: "k1", model: "cw/terra", output: 1, cache_read: 2, cache_write: 3, cost_total: null });
    // 再来一条主 agent 的记录和一个子 agent 的记录；已记的不再记。
    await appendFile(main, `${record(33, 3000)}\n`);
    await mkdir(wireDir("sub1"), { recursive: true });
    await writeFile(path.join(wireDir("sub1"), "wire.jsonl"), `${record(44, 4000, "sub1")}\n`);
    await stop();
    await hook({ hook_event_name: "SessionEnd" });
    const all = (await meterLines()).filter((line) => line.kind === "usage");
    expect(all.map((line) => line.input).sort()).toEqual([11, 22, 33, 44]);
  });
});

describe("CW_ROLE", () => {
  it("makes every hook exit without output, state or meter, while the same input works without it", async () => {
    await project('version = 1\n[check]\ncmd = ["sh", "-c", "exit 3"]\n');
    const dataBefore = await readdir(sandbox.data);
    for (const event of ["UserPromptSubmit", "Stop", "PreToolUse", "SessionEnd", "TurnStarted"]) {
      const result = await hook(
        { hook_event_name: event, prompt: [{ type: "text", text: "x" }], tool_name: "Write", tool_input: { path: "a" } },
        { CW_ROLE: "1" });
      expect(result).toMatchObject({ stdout: "", stderr: "", code: 0 });
    }
    expect(await readdir(sandbox.data)).toEqual(dataBefore);
    await expect(stat(path.join(repo, ".cw/meter.jsonl"))).rejects.toThrow();
    const normal = await prompt();
    expect(normal.stdout).toContain("active");
  });

  it("is set by the role runner on the child process", async () => {
    await installFakeKimi(sandbox, {});
    expect(process.env.CW_ROLE).toBeUndefined();
    await runRole({ role: "review", workRoot: repo, model: "m1", sandbox: "read-only", message: "x" });
    expect((await fakeCalls(sandbox))[0]!.cwRole).toBe("1");
  });
});

describe("runRole", () => {
  const request = (role: "review" | "planner", message = "要求\n@@ diff") =>
    ({ role, workRoot: repo, model: "m1", sandbox: "read-only" as const, message });

  it("returns the answer and the child's usage from its wire.jsonl, with a read-only agent file", async () => {
    await installFakeKimi(sandbox, { default: { answer: "none" } });
    const run = await runRole(request("review"));
    expect(run).toMatchObject({ answer: "none", error: null });
    expect(run.usage).toEqual([{ input: 200, output: 40, cacheRead: 800, cacheWrite: 5 }]);
    const [call] = await fakeCalls(sandbox);
    expect(call!.args.slice(0, 4)).toEqual(["-p", "要求\n@@ diff", "-m", "m1"]);
    expect(call!.args).toContain("stream-json");
    expect(call!.agent).toContain("tools: Read, Grep, Glob");
    await runRole(request("planner"));
    expect((await fakeCalls(sandbox))[1]!.agent).toContain('tools: ""');
  });

  it("reports a failed run with Kimi's error line", async () => {
    await installFakeKimi(sandbox, { default: { failure: 'Model "m1" is not configured' } });
    const run = await runRole(request("review"));
    expect(run.answer).toBeNull();
    expect(run.error).toContain("未正常结束");
    expect(run.error).toContain("is not configured");
  });

  it("stops a role that exceeds the step limit", async () => {
    await installFakeKimi(sandbox, { default: { toolsThenHang: 31 } });
    const run = await runRole({ ...request("review"), timeoutMs: 20_000 });
    expect(run).toMatchObject({ answer: null, budget: true, error: "已达 30 步上限，已终止，拆小输入后重试" });
  }, 30_000);

  it("hands an oversize message over as a file, and refuses it for the planner", async () => {
    await installFakeKimi(sandbox, {});
    const big = "x".repeat(120_000);
    await runRole(request("review", big));
    const [call] = await fakeCalls(sandbox);
    expect(call!.args[1]).toContain("message.md");
    expect(call!.args[1]!.length).toBeLessThan(500);
    expect(call!.args).toContain("--add-dir");
    const planner = await runRole(request("planner", big));
    expect(planner.error).toContain("命令行长度");
    expect(await fakeCalls(sandbox)).toHaveLength(1);
  });
});

describe("injection and reports", () => {
  it("says with the first prompt that the check is not configured, and names the setup skill", async () => {
    await project("version = 1\n");
    const first = await prompt();
    expect(first.stdout).toContain("结束检查没有配置");
    expect(first.stdout).toContain("/skill:counterweight:cw-setup");
    expect((await meterLines()).find((line) => line.event === "inject")?.detail).toMatchObject({ host: "kimi", check: false });
  });

  it("injects the instructions once per session, then only changes of the goal, and delivers the pending count", async () => {
    await project('version = 1\n[check]\ncmd = ["true"]\n');
    await writeFile(path.join(repo, ".cw/pending.md"), "- 2026-11-05 | one\n- 2026-11-05 | two\n  detail\n");
    const first = await prompt();
    expect(first.stdout).toContain("Counterweight 0.1.0 active");
    expect((await meterLines()).filter((line) => line.event === "inject")).toHaveLength(1);
    await stop();
    const second = await prompt();
    expect(second.stdout).not.toContain("active");
    expect(second.stdout).toContain("结束检查通过");
    expect(second.stdout).toContain("待批 2 条");
    await writeFile(path.join(repo, ".cw/goal.md"), "只改 a.txt\n");
    const third = await prompt();
    expect(third.stdout).toContain("只改 a.txt");
    expect((await prompt()).stdout).toBe("");
  });
});
