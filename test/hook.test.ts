import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseProjectConfig } from "../src/core/config.js";
import { alive, childEnv, fakeCalls, HOOK, installFakeCodex, runHook as runHookIn, until, writeConfig as writeConfigFile, type Sandbox } from "./support.js";

let repo: string;
let sandbox: Sandbox;

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), "cw-hook-"));
  const data = await mkdtemp(path.join(tmpdir(), "cw-data-"));
  sandbox = { repo, data, bin: path.join(data, "bin") };
  execFileSync("git", ["init", "-q"], { cwd: repo });
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
  await rm(sandbox.data, { recursive: true, force: true });
});

const writeConfig = (text: string) => writeConfigFile(repo, "project.toml", text);
const runHook = (input: Record<string, unknown>) => runHookIn(sandbox, input);

const patch = (...lines: string[]) => ["*** Begin Patch", ...lines, "*** End Patch"].join("\n");
const preTool = (command: string) => runHook({
  hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { command },
});
const denied = (out: any) => out?.hookSpecificOutput?.permissionDecision === "deny";

describe("PreToolUse", () => {
  beforeEach(() => writeConfig('version = 1\n[protect]\npaths = ["tests"]\n'));

  it("denies a patch with a protected path among others", async () => {
    const { out } = await preTool(patch("*** Add File: src/a.ts", "+x", "*** Update File: tests/a.ts", "@@"));
    expect(denied(out)).toBe(true);
    expect((out as any).hookSpecificOutput.permissionDecisionReason).toContain("tests/a.ts");
  });

  it("denies an absolute protected path", async () => {
    const { out } = await preTool(patch(`*** Delete File: ${path.join(repo, "tests/a.ts")}`));
    expect(denied(out)).toBe(true);
  });

  it("is silent for an unprotected patch", async () => {
    const { stdout } = await preTool(patch("*** Add File: src/a.ts", "+x"));
    expect(stdout).toBe("");
  });

  it("denies a patch with no parsable path", async () => {
    const { out } = await preTool("not a patch");
    expect(denied(out)).toBe(true);
  });

  it("allows when the config is missing", async () => {
    await rm(path.join(repo, ".cw"), { recursive: true });
    const { stdout } = await preTool(patch("*** Update File: .cw/project.toml", "@@"));
    expect(stdout).toBe("");
  });
});

describe("Stop", () => {
  const stop = () => runHook({ hook_event_name: "Stop" });

  it("blocks on a failing check the first time", async () => {
    await writeConfig('version = 1\n[check]\ncmd = ["sh", "-c", "echo boom; exit 3"]\n');
    const { out } = await stop();
    expect((out as any).decision).toBe("block");
    expect((out as any).reason).toContain("boom");
  });

  it("only reports a failing check the second time in the same turn", async () => {
    await writeConfig('version = 1\n[check]\ncmd = ["sh", "-c", "exit 3"]\n');
    expect((await stop()).out.decision).toBe("block");
    const { out } = await stop();
    expect((out as any).decision).toBeUndefined();
    expect((out as any).systemMessage).toContain("退出码 3");
  });

  it("reports a passing check as a system message", async () => {
    await writeConfig('version = 1\n[check]\ncmd = ["true"]\n');
    const { out } = await stop();
    expect((out as any).systemMessage).toContain("通过");
    expect((out as any).decision).toBeUndefined();
  });
});

describe("config compatibility", () => {
  it("accepts a config valid for pi", () => {
    const project = parseProjectConfig(`version = 1
[check]
cmd = ["npm", "test"]
[protect]
paths = ["tests"]
[models]
review = "openai/gpt-5"
over_review = "openai/gpt-5"
[auto]
review = true
[router]
url = "http://localhost:8000/v1"
model = "jev"
[timeouts]
review = 600
`);
    expect(project.check?.cmd).toEqual(["npm", "test"]);
    expect(project.auto.review).toBe(false);
    expect(project.autoSkipped).toEqual(["review"]);
  });

  it("rejects an unknown key", () => {
    expect(() => parseProjectConfig("version = 1\n[explorer]\nx = 1\n")).toThrow();
  });
});

describe("codex.toml", () => {
  const PI_AUTO = 'version = 1\n[check]\ncmd = ["sh", "-c", "echo ran; exit 0"]\n[auto]\nreview = true\n';
  const writeCodex = (text: string) => writeConfigFile(repo, "codex.toml", text);

  it("keeps the check running when [auto] lacks a model, and says so at SessionStart", async () => {
    await writeConfig(PI_AUTO);
    const start = await runHook({ hook_event_name: "SessionStart" });
    expect(start.out.systemMessage).toContain("[auto].review");
    const { out } = await runHook({ hook_event_name: "Stop" });
    expect(out.systemMessage).toContain("通过");
  });

  it("protects codex.toml itself", async () => {
    await writeConfig("version = 1\n");
    await writeCodex('[models]\nreview = "m"\n');
    const { out } = await preTool(patch("*** Update File: .cw/codex.toml", "@@"));
    expect(denied(out)).toBe(true);
  });

  it("stops the check and reports when codex.toml is invalid", async () => {
    await writeConfig(PI_AUTO);
    await writeCodex('[models]\nreview = "has space"\n');
    const start = await runHook({ hook_event_name: "SessionStart" });
    expect(start.out.systemMessage).toContain("codex.toml");
    const { out } = await runHook({ hook_event_name: "Stop" });
    expect(out.systemMessage).toContain("未运行检查");
    expect(out.systemMessage).toContain("codex.toml");
  });
});

describe("auto review", () => {
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo });

  beforeEach(async () => {
    await writeFile(path.join(repo, "a.txt"), "1\n");
    git("add", "a.txt");
    git("commit", "-qm", "init");
    await writeFile(path.join(repo, "a.txt"), "2\n");
    await writeConfigFile(repo, "codex.toml", '[models]\nreview = "rv"\nover_review = "ov"\n');
  });

  const findings = { byModel: { rv: { answer: "WRONG `a.txt:1`\n期望：x\n实际：y" }, ov: { answer: "none" } } };

  it("continues once on findings and passes the user's request to the reviewer", async () => {
    await writeConfig('version = 1\n[auto]\nreview = true\n');
    await installFakeCodex(sandbox, findings);
    // The baseline is taken at the prompt, so the turn's edit comes after it.
    await writeFile(path.join(repo, "a.txt"), "1\n");
    await runHook({ hook_event_name: "UserPromptSubmit", prompt: "把 a 改成 2" });
    await writeFile(path.join(repo, "a.txt"), "2\n");
    const first = await runHook({ hook_event_name: "Stop" });
    expect(first.out.decision).toBe("block");
    expect(first.out.reason).toContain("WRONG `a.txt:1`");
    expect((await fakeCalls(sandbox))[0]!.stdin).toContain("把 a 改成 2");
    const second = await runHook({ hook_event_name: "Stop" });
    expect(second.out.decision).toBeUndefined();
    expect(second.out.systemMessage).toContain("不再续跑");
  });

  it("chronicles at the final settle even though findings are shown", async () => {
    await writeConfig('version = 1\n[auto]\nreview = true\nchronicle = true\n');
    await writeConfigFile(repo, "codex.toml", '[models]\nreview = "rv"\nover_review = "ov"\nhistorian = "hs"\n');
    await installFakeCodex(sandbox, { byModel: { ...findings.byModel, hs: { answer: "# 历史\n- 记了一笔" } } });
    await writeFile(path.join(repo, "a.txt"), "1\n");
    await runHook({ hook_event_name: "UserPromptSubmit", prompt: "把 a 改成 2" });
    await writeFile(path.join(repo, "a.txt"), "2\n");
    const history = path.join(repo, ".cw", "HISTORY.md");
    expect((await runHook({ hook_event_name: "Stop" })).out.decision).toBe("block");
    await expect(readFile(history, "utf8")).rejects.toThrow();
    const second = await runHook({ hook_event_name: "Stop" });
    expect(second.out.systemMessage).toContain("不再续跑");
    expect(await readFile(history, "utf8")).toBe("# 历史\n- 记了一笔\n");
    expect((await fakeCalls(sandbox)).filter((call) => call.model === "hs")[0]!.stdin).toContain("a.txt");
  }, 30_000);

  it("says which reviewer did not finish, and why, without changing the verdict", async () => {
    await writeConfig('version = 1\n[check]\ncmd = ["true"]\n[auto]\nreview = true\n');
    await installFakeCodex(sandbox, { byModel: { rv: { mode: "noturn", failure: "model at capacity" }, ov: { answer: "none" } } });
    const { out } = await runHook({ hook_event_name: "Stop" });
    expect(out.decision).toBeUndefined();
    expect(out.systemMessage).toContain("[counterweight] 自动审查未完成：review 未正常结束");
    expect(out.systemMessage).toContain("model at capacity");
    expect(out.systemMessage).toContain("通过");
    expect(out.systemMessage).not.toContain("over_review");
  });

  it("keeps the failure line when the other reviewer's findings continue the turn", async () => {
    await writeConfig('version = 1\n[auto]\nreview = true\n');
    await installFakeCodex(sandbox, {
      byModel: { rv: { mode: "noturn", failure: "boom" }, ov: { answer: "CUT `x`\n删：a\n留：b\n因为：c" } },
    });
    const { out } = await runHook({ hook_event_name: "Stop" });
    expect(out.decision).toBe("block");
    expect(out.reason).toContain("CUT `x`");
    expect(out.systemMessage).toContain("自动审查未完成：review");
  });

  it("does not continue when the reviewers find nothing", async () => {
    await writeConfig('version = 1\n[auto]\nreview = true\n');
    await installFakeCodex(sandbox, { default: { answer: "none" } });
    expect((await runHook({ hook_event_name: "Stop" })).stdout).toBe("");
  });

  it("keeps the repair and findings allowances separate", async () => {
    await writeConfig('version = 1\n[check]\ncmd = ["sh", "-c", "echo boom; exit 3"]\n[auto]\nreview = true\n');
    await installFakeCodex(sandbox, findings);
    const stops = [];
    for (let i = 0; i < 3; i += 1) stops.push((await runHook({ hook_event_name: "Stop" })).out);
    expect(stops.map((out) => out.decision)).toEqual(["block", "block", undefined]);
    expect(stops[0].reason).toContain("boom");
    expect(stops[1].reason).toContain("自动审查有发现");
    expect(stops[1].systemMessage).toContain("退出码 3");
    // The first Stop returned before any reviewer ran.
    expect((await fakeCalls(sandbox)).length).toBe(4);
  }, 30_000);
});

describe("commands for over_review", () => {
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo });
  const shell = (command: string, extra: Record<string, unknown> = {}) => runHook({
    hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, ...extra,
  });
  const stop = () => runHook({ hook_event_name: "Stop" });

  beforeEach(async () => {
    await writeConfig('version = 1\n[protect]\npaths = ["tests"]\n[auto]\nreview = true\n');
    await writeConfigFile(repo, "codex.toml", '[models]\nreview = "rv"\nover_review = "ov"\n');
    await writeFile(path.join(repo, "a.txt"), "1\n");
    git("add", "a.txt");
    git("commit", "-qm", "init");
  });

  it("gives over_review the root thread's commands and skips review on an empty diff", async () => {
    await installFakeCodex(sandbox, { default: { answer: "none" } });
    expect((await shell("python sweep.py --all")).stdout).toBe("");
    await shell("rm -rf sub", { agent_id: "sub1" });
    expect((await stop()).stdout).toBe("");
    const calls = await fakeCalls(sandbox);
    expect(calls.map((call) => call.model)).toEqual(["ov"]);
    expect(calls[0]!.stdin).toContain("bash python sweep.py --all");
    expect(calls[0]!.stdin).toContain("共 1 条");
    expect(calls[0]!.stdin).not.toContain("rm -rf sub");
  });

  it("sends review the diff only when the diff changed", async () => {
    await installFakeCodex(sandbox, { default: { answer: "none" } });
    await writeFile(path.join(repo, "a.txt"), "2\n");
    await shell("python sweep.py");
    await stop();
    const calls = await fakeCalls(sandbox);
    expect(calls.map((call) => call.model).sort()).toEqual(["ov", "rv"]);
    expect(calls.find((call) => call.model === "rv")!.stdin).not.toContain("python sweep.py");
    expect(calls.find((call) => call.model === "ov")!.stdin).toContain("python sweep.py");
  });

  it("shows findings without a diff and does not continue, even the first time", async () => {
    await installFakeCodex(sandbox, { byModel: { ov: { answer: "CUT `sweep`\n删：重跑\n留：无\n因为：请求没要求" } } });
    await shell("python sweep.py");
    const { out } = await stop();
    expect(out.decision).toBeUndefined();
    expect(out.systemMessage).toContain("自动审查有发现，不再续跑");
    expect(out.systemMessage).toContain("CUT `sweep`");
    // 额度已用掉：之后有 diff 的发现也只显示。
    await writeFile(path.join(repo, "a.txt"), "2\n");
    const later = await stop();
    expect(later.out.decision).toBeUndefined();
  });

  it("does not record a call that protection blocked", async () => {
    await installFakeCodex(sandbox, { default: { answer: "none" } });
    const blocked = await runHook({
      hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { command: patch("*** Add File: tests/a.ts", "+x") },
    });
    expect(denied(blocked.out)).toBe(true);
    await stop();
    expect(await fakeCalls(sandbox)).toHaveLength(0);
    await runHook({
      hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { command: patch("*** Add File: src/a.ts", "+x") },
    });
    await stop();
    expect((await fakeCalls(sandbox))[0]!.stdin).toContain("apply_patch src/a.ts");
  });
});

describe("goal", () => {
  const goalFile = () => path.join(repo, ".cw/goal.md");
  const prompt = (text = "hi") => runHook({ hook_event_name: "UserPromptSubmit", prompt: text });
  const saved = () => readFile(path.join(sandbox.data, "sessions/s1/t1.prompt"), "utf8");

  beforeEach(async () => {
    await writeConfig("version = 1\n");
    await mkdir(path.join(repo, ".cw"), { recursive: true });
  });

  it("is protected", async () => {
    expect(denied((await preTool(patch("*** Update File: .cw/goal.md", "@@"))).out)).toBe(true);
  });

  it("is injected at SessionStart, then only when it changes or is removed", async () => {
    await writeFile(goalFile(), "只改绑定的释放顺序");
    const start = await runHook({ hook_event_name: "SessionStart" });
    expect(start.out.hookSpecificOutput.additionalContext).toContain("INTJ");
    expect(start.out.hookSpecificOutput.additionalContext).toContain("只改绑定的释放顺序");

    expect((await prompt("one")).stdout).toBe("");
    expect(await saved()).toBe("one");

    await writeFile(goalFile(), "只改解析器");
    const changed = await prompt("two");
    const context = changed.out.hookSpecificOutput.additionalContext as string;
    expect(changed.out.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(context).toContain("只改解析器");
    expect(context).not.toContain("INTJ");
    expect(await saved()).toBe("two");
    expect((await prompt("three")).stdout).toBe("");

    await rm(goalFile());
    const removed = await prompt("four");
    expect(removed.out.hookSpecificOutput.additionalContext)
      .toBe("The user removed .cw/goal.md. The earlier goal no longer applies.");
    expect(await saved()).toBe("four");
    expect((await prompt("five")).stdout).toBe("");
  });

  it("treats a missing stored hash as changed only when a goal exists", async () => {
    expect((await prompt()).stdout).toBe("");
    await writeFile(goalFile(), "目标");
    await rm(path.join(sandbox.data, "sessions"), { recursive: true, force: true });
    expect((await prompt()).out.hookSpecificOutput.additionalContext).toContain("目标");
  });
});

describe("goal without a usable config", () => {
  const target = (file: string) => patch(`*** Update File: ${file}`, "@@");
  beforeEach(() => mkdir(path.join(repo, ".cw"), { recursive: true }));

  it("refuses goal.md with no config, and still lets setup create project.toml", async () => {
    expect(denied((await preTool(target(".cw/goal.md"))).out)).toBe(true);
    expect((await preTool(target(".cw/project.toml"))).stdout).toBe("");
  });

  it("refuses goal.md with an invalid config", async () => {
    await writeConfig("version = 99\n");
    expect(denied((await preTool(target(".cw/goal.md"))).out)).toBe(true);
  });

  it("refuses goal.md through a symlink, with no config", async () => {
    await writeFile(path.join(repo, ".cw/goal.md"), "g");
    await symlink(".cw/goal.md", path.join(repo, "alias.md"));
    expect(denied((await preTool(target("alias.md"))).out)).toBe(true);
  });
});

describe("PAUSE", () => {
  let transcript: string;
  const line = (payload: Record<string, unknown>) => JSON.stringify({ type: "response_item", payload });

  beforeEach(async () => {
    await writeConfig('version = 1\n[protect]\npaths = ["tests"]\n[auto]\npause = true\n');
    await writeConfigFile(repo, "codex.toml", '[models]\nplanner = "pl"\n');
    transcript = path.join(repo, "rollout.jsonl");
    await writeFile(transcript, [
      line({ type: "message", role: "developer", content: [{ type: "input_text", text: "SECRET-DEV" }] }),
      line({ type: "message", role: "user", content: [{ type: "input_text", text: "修一下 a 的 bug" }] }),
      line({ type: "function_call", name: "shell", arguments: "{\"cmd\":\"cat src/a.ts\"}", call_id: "c1" }),
      line({ type: "function_call_output", call_id: "c1", output: "export const a = 1;" }),
      "not json",
    ].join("\n"));
  });

  const edit = (file: string, extra: Record<string, unknown> = {}) => runHook({
    hook_event_name: "PreToolUse", tool_name: "apply_patch", transcript_path: transcript,
    tool_input: { command: patch(`*** Update File: ${file}`, "@@") }, ...extra,
  });

  it("denies the first source edit of a turn with the plan, once", async () => {
    await installFakeCodex(sandbox, { default: { answer: "根因：x" } });
    const first = await edit("src/a.ts");
    expect(denied(first.out)).toBe(true);
    expect(first.out.hookSpecificOutput.permissionDecisionReason).toContain("根因：x");
    const [call] = await fakeCalls(sandbox);
    expect(call!.stdin).toContain("修一下 a 的 bug");
    expect(call!.stdin).toContain("export const a = 1;");
    expect(call!.stdin).not.toContain("SECRET-DEV");
    expect((await edit("src/a.ts")).stdout).toBe("");
    expect(denied((await edit("src/a.ts", { turn_id: "t2" })).out)).toBe(true);
  });

  it("lets the edit through when the planner fails, and does not ask again", async () => {
    await installFakeCodex(sandbox, { default: { mode: "noturn" } });
    expect((await edit("src/a.ts")).stdout).toBe("");
    expect((await edit("src/a.ts")).stdout).toBe("");
    expect(await fakeCalls(sandbox)).toHaveLength(1);
  });

  it("lets the edit through when there is no transcript", async () => {
    await installFakeCodex(sandbox, { default: { answer: "根因：x" } });
    expect((await edit("src/a.ts", { transcript_path: "" })).stdout).toBe("");
  });

  it("protects before it pauses", async () => {
    await installFakeCodex(sandbox, { default: { answer: "根因：x" } });
    const { out } = await edit("tests/a.ts");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("受保护路径");
    expect(await fakeCalls(sandbox)).toHaveLength(0);
  });

  it("ignores sub-agents", async () => {
    await installFakeCodex(sandbox, { default: { answer: "根因：x" } });
    expect((await edit("src/a.ts", { agent_id: "sub1" })).stdout).toBe("");
    expect(await fakeCalls(sandbox)).toHaveLength(0);
  });
});

describe("PostModelRequest", () => {
  it("records input without the cached part", async () => {
    await runHook({
      hook_event_name: "PostModelRequest", status: "completed", model: "m1",
      token_usage: {
        input_tokens: 11932, cached_input_tokens: 11776, cache_write_input_tokens: 5,
        output_tokens: 40, reasoning_output_tokens: 0,
      },
    });
    const line = JSON.parse((await readFile(path.join(repo, ".cw/meter.jsonl"), "utf8")).trim());
    expect(line).toMatchObject({
      kind: "usage", session: "s1", model: "m1", input: 156, output: 40, cache_read: 11776, cache_write: 5,
      cost_total: null,
    });
  });
});

describe("process groups", () => {
  it("kills the check when the hook's process group is SIGKILLed", async () => {
    const pidFile = path.join(repo, "sleep.pid");
    await writeConfig(`version = 1\n[check]\ncmd = ["sh", "-c", "sleep 300 & echo $! > ${pidFile}; wait"]\n`);
    const hook = spawn("node", [HOOK], { detached: true, stdio: ["pipe", "ignore", "ignore"], env: childEnv(sandbox) });
    hook.stdin.end(JSON.stringify({ cwd: repo, session_id: "s1", turn_id: "t1", hook_event_name: "Stop" }));
    let sleepPid = 0;
    await until(() => {
      try { sleepPid = Number(readFileSync(pidFile, "utf8")); } catch { /* not yet */ }
      return sleepPid > 0;
    }, 10_000);
    expect(sleepPid).toBeGreaterThan(0);
    expect(alive(sleepPid)).toBe(true);
    process.kill(-hook.pid!, "SIGKILL");
    await until(() => !alive(sleepPid), 5_000);
    const gone = !alive(sleepPid);
    if (!gone) process.kill(sleepPid, "SIGKILL");
    expect(gone).toBe(true);
  }, 20_000);

  it("reports a timeout for a check that ignores SIGTERM", async () => {
    await writeConfig(
      'version = 1\n[check]\ntimeout_s = 1\ncmd = ["sh", "-c", "trap \'\' TERM; while :; do sleep 1; done"]\n');
    const { out } = await runHook({ hook_event_name: "Stop" });
    expect((out as any).decision).toBe("block");
    expect((out as any).reason).toContain("超时");
  }, 30_000);
});

describe("missing [check] notice", () => {
  const start = (source: string) => runHook({ hook_event_name: "SessionStart", source });

  it("says so at startup and clear when there is no project.toml or no [check]", async () => {
    for (const source of ["startup", "clear"]) {
      expect((await start(source)).out.systemMessage).toContain("结束检查没有配置");
    }
    await writeConfig("version = 1\n");
    expect((await start("startup")).out.systemMessage).toContain("没有 [check]");
  });

  it("stays quiet on compact and resume, with a [check], and with an invalid config", async () => {
    expect((await start("compact")).out.systemMessage).toBeUndefined();
    expect((await start("resume")).out.systemMessage).toBeUndefined();
    await writeConfig('version = 1\n[check]\ncmd = ["true"]\n');
    expect((await start("startup")).out.systemMessage).toBeUndefined();
    await writeConfig("version = 2\n");
    const invalid = (await start("startup")).out.systemMessage as string;
    expect(invalid).toContain("配置非法");
    expect(invalid).not.toContain("结束检查没有配置");
  });
});

describe("dangerous commands and scope", () => {
  const shell = (command: string, tool = "Bash") => runHook({
    hook_event_name: "PreToolUse", tool_name: tool, tool_input: { command },
  });
  const scope = (text: string) => mkdir(path.join(repo, ".cw"), { recursive: true })
    .then(() => writeFile(path.join(repo, ".cw/scope.txt"), text));

  it("denies the worst commands on every shell tool, with no config at all", async () => {
    for (const tool of ["Bash", "exec_command", "shell_command"]) {
      const { out } = await shell("git push --force origin main", tool);
      expect(denied(out)).toBe(true);
      expect(out.hookSpecificOutput.permissionDecisionReason).toContain("强制推送 main");
    }
    expect(denied((await shell("mkfs /dev/null-cw-probe")).out)).toBe(true);
    expect(denied((await shell("ls && rm -rf ~")).out)).toBe(true);
  });

  it("lets ordinary and quoted commands through", async () => {
    for (const command of ["git push origin main", "git push --force-with-lease origin main", 'git commit -m "rm -rf /"', "rm -rf build"]) {
      expect((await shell(command)).stdout).toBe("");
    }
  });

  it("limits patches to the prefixes in scope.txt, with or without project.toml", async () => {
    await scope("# only the app\nsrc\n\n");
    expect((await preTool(patch("*** Add File: src/a.ts", "+x"))).stdout).toBe("");
    expect((await preTool(patch("*** Add File: .cw/notes.md", "+x"))).stdout).toBe("");
    const out = (await preTool(patch("*** Add File: srcx/a.ts", "+x"))).out;
    expect(denied(out)).toBe(true);
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("srcx/a.ts");
    expect(denied((await preTool(patch("*** Update File: lib/a.ts", "@@"))).out)).toBe(true);
    await writeConfig("version = 1\n");
    expect(denied((await preTool(patch("*** Update File: lib/a.ts", "@@"))).out)).toBe(true);
    expect((await preTool(patch("*** Add File: src/b.ts", "+x"))).stdout).toBe("");
  });

  it("follows symlinks out of scope, protects scope.txt itself, and ignores a file with no entries", async () => {
    await scope("src\n");
    await mkdir(path.join(repo, "lib"), { recursive: true });
    await mkdir(path.join(repo, "src"), { recursive: true });
    await symlink(path.join(repo, "lib"), path.join(repo, "src/out"));
    expect(denied((await preTool(patch("*** Add File: src/out/x.ts", "+x"))).out)).toBe(true);
    const own = await preTool(patch("*** Update File: .cw/scope.txt", "@@"));
    expect(denied(own.out)).toBe(true);
    expect(own.out.hookSpecificOutput.permissionDecisionReason).toContain("scope.txt");
    await scope("# nothing here\n\n");
    expect((await preTool(patch("*** Add File: lib/a.ts", "+x"))).stdout).toBe("");
  });
});

describe("inject event", () => {
  const events = async () => (await readFile(path.join(repo, ".cw/meter.jsonl"), "utf8").catch(() => ""))
    .split("\n").filter((line) => line !== "").map((line) => JSON.parse(line)).filter((line) => line.event === "inject");

  it("records host, plugin version, goal and check at every SessionStart that injects", async () => {
    const manifest = JSON.parse(await readFile(path.resolve("plugins/codex-counterweight/.codex-plugin/plugin.json"), "utf8"));
    await runHook({ hook_event_name: "SessionStart", source: "startup" });
    await writeConfig('version = 1\n[check]\ncmd = ["true"]\n');
    await writeFile(path.join(repo, ".cw/goal.md"), "只改 a\n");
    await runHook({ hook_event_name: "SessionStart", source: "compact" });
    const [first, second] = await events();
    expect(first.detail).toEqual({ host: "codex", version: manifest.version, goal: false, check: false });
    expect(second.detail).toEqual({ host: "codex", version: manifest.version, goal: true, check: true });
  });

  it("counts a blank goal as no goal", async () => {
    await mkdir(path.join(repo, ".cw"), { recursive: true });
    await writeFile(path.join(repo, ".cw/goal.md"), " \n\n");
    await runHook({ hook_event_name: "SessionStart", source: "startup" });
    expect((await events())[0].detail.goal).toBe(false);
  });
});

describe("chronicle event", () => {
  const chronicle = () => path.join(sandbox.data, ".agents", "chronicle");
  const events = async () => {
    const root = path.join(chronicle(), "events");
    const machines = await readdir(root).catch(() => [] as string[]);
    const out = [];
    for (const machine of machines) {
      for (const name of await readdir(path.join(root, machine))) {
        out.push(JSON.parse(await readFile(path.join(root, machine, name), "utf8")));
      }
    }
    return out;
  };
  const evidenceOf = async (id: string) => {
    const root = path.join(chronicle(), "evidence");
    for (const machine of await readdir(root)) {
      for (const name of await readdir(path.join(root, machine))) {
        const value = JSON.parse(await readFile(path.join(root, machine, name), "utf8"));
        if (value.event === id) return value;
      }
    }
    return null;
  };
  const stop = () => runHook({ hook_event_name: "Stop" });

  it("writes nothing and creates nothing when ~/.agents/chronicle does not exist", async () => {
    await writeConfig('version = 1\n[check]\ncmd = ["true"]\n');
    await stop();
    await expect(stat(path.join(sandbox.data, ".agents"))).rejects.toThrow();
  });

  it("records ok with the check report when the check passes, tagged with the session and turn", async () => {
    await mkdir(chronicle(), { recursive: true });
    await writeConfig('version = 1\n[check]\ncmd = ["true"]\n');
    await stop();
    const [event] = await events();
    expect(event).toMatchObject({ outcome: "ok", agent: "codex:s1", turn: "t1", workspace: await realpath(repo), project: null });
    expect((await evidenceOf(event.id)).text).toContain("通过");
  });

  it("records failed only at the final settle, not at the repair continuation", async () => {
    await mkdir(chronicle(), { recursive: true });
    await writeConfig('version = 1\n[check]\ncmd = ["sh", "-c", "echo boom; exit 3"]\n');
    expect((await stop()).out.decision).toBe("block");
    expect(await events()).toEqual([]);
    await stop();
    const [event] = await events();
    expect(event.outcome).toBe("failed");
    expect((await evidenceOf(event.id)).text).toContain("退出码 3");
  });

  it("records unknown with a gap when there is no check, no project.toml, or an invalid config", async () => {
    await mkdir(chronicle(), { recursive: true });
    await stop();
    await writeConfig("version = 1\n");
    await stop();
    await writeConfig("version = 2\n");
    await stop();
    const all = await events();
    expect(all.map((event) => event.outcome)).toEqual(["unknown", "unknown", "unknown"]);
    const gaps = await Promise.all(all.map(async (event) => (await evidenceOf(event.id)).gap));
    expect(gaps.every((gap) => typeof gap === "string" && gap !== "")).toBe(true);
    expect(gaps.some((gap) => gap.includes("配置非法"))).toBe(true);
  });
});
