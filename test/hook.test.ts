import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseProjectConfig } from "../src/core/config.js";
import { alive, childEnv, HOOK, runHook as runHookIn, until, writeConfig as writeConfigFile, type Sandbox } from "./support.js";

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
  const stop = (active: boolean) => runHook({ hook_event_name: "Stop", stop_hook_active: active });

  it("blocks on a failing check the first time", async () => {
    await writeConfig('version = 1\n[check]\ncmd = ["sh", "-c", "echo boom; exit 3"]\n');
    const { out } = await stop(false);
    expect((out as any).decision).toBe("block");
    expect((out as any).reason).toContain("boom");
  });

  it("only reports a failing check when stop_hook_active", async () => {
    await writeConfig('version = 1\n[check]\ncmd = ["sh", "-c", "exit 3"]\n');
    const { out } = await stop(true);
    expect((out as any).decision).toBeUndefined();
    expect((out as any).systemMessage).toContain("退出码 3");
  });

  it("reports a passing check as a system message", async () => {
    await writeConfig('version = 1\n[check]\ncmd = ["true"]\n');
    const { out } = await stop(false);
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
    hook.stdin.end(JSON.stringify({ cwd: repo, session_id: "s1", hook_event_name: "Stop", stop_hook_active: false }));
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
    const { out } = await runHook({ hook_event_name: "Stop", stop_hook_active: false });
    expect((out as any).decision).toBe("block");
    expect((out as any).reason).toContain("超时");
  }, 30_000);
});
