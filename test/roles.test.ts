import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runRole } from "../src/adapters/codex/runner.js";
import { renderActions } from "../src/core/auto.js";
import { nextTimeoutS } from "../src/roles/run.js";
import { alive, fakeCalls, installFakeCodex, until, type Sandbox } from "./support.js";

let sandbox: Sandbox;
let savedPath: string | undefined;

beforeEach(async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cw-roles-"));
  sandbox = { repo: dir, data: dir, bin: path.join(dir, "bin") };
  savedPath = process.env.PATH;
  process.env.PATH = `${sandbox.bin}${path.delimiter}${savedPath ?? ""}`;
});

afterEach(async () => {
  process.env.PATH = savedPath;
  await rm(sandbox.data, { recursive: true, force: true });
});

const request = (role: "review" | "planner", extra: { timeoutMs?: number } = {}) =>
  ({ role, workRoot: sandbox.repo, model: "m1", sandbox: "read-only" as const, message: "要求\n@@ diff", ...extra });

describe("runRole", () => {
  it("returns the last agent message and usage without the cached input", async () => {
    await installFakeCodex(sandbox, { default: { answer: "none" } });
    const run = await runRole(request("review"));
    expect(run).toMatchObject({ answer: "none", error: null });
    expect(run.usage).toEqual([{ input: 200, output: 40, cacheRead: 800, cacheWrite: 5 }]);
    const [call] = await fakeCalls(sandbox);
    expect(call!.stdin).toBe("要求\n@@ diff");
    expect(call!.args).toContain("read-only");
    expect(call!.args).not.toContain("shell_tool");
  });

  it("turns off the shell for the planner", async () => {
    await installFakeCodex(sandbox, {});
    await runRole(request("planner"));
    expect((await fakeCalls(sandbox))[0]!.args).toContain("shell_tool");
  });

  it("reports a run that never completed its turn", async () => {
    await installFakeCodex(sandbox, { default: { mode: "noturn", answer: "half", failure: "model at capacity" } });
    const run = await runRole(request("review"));
    expect(run.answer).toBeNull();
    expect(run.error).toContain("未正常结束");
    expect(run.error).toContain("model at capacity");
  });

  it("times out, reaps the whole process group, and suggests the next tier", async () => {
    await installFakeCodex(sandbox, { default: { mode: "hang" } });
    const run = await runRole(request("review", { timeoutMs: 600 }));
    expect(run.timedOut).toBe(true);
    expect(run.error).toContain("超时");
    const [call] = await fakeCalls(sandbox);
    await until(() => !alive(call!.pid) && !alive(call!.childPid), 3_000);
    const leaked = [call!.pid, call!.childPid].filter(alive);
    for (const pid of leaked) process.kill(pid, "SIGKILL");
    expect(leaked).toEqual([]);
    expect(nextTimeoutS(300_000)).toBe(600);
    expect(nextTimeoutS(1_800_000)).toBeNull();
  }, 20_000);
});

describe("renderActions", () => {
  it("is empty for no actions", () => {
    expect(renderActions([])).toBe("");
  });

  it("drops writes first past the cap, notes the omission, and skips an oversize command", () => {
    const writes = Array.from({ length: 40 }, (_, i) => ({ tool: "Edit", detail: `f${i}.ts` }));
    const text = renderActions([
      ...writes,
      { tool: "bash", detail: "npm test" },
      { tool: "bash", detail: "x".repeat(2_001) },
    ]);
    expect(text).toContain("共 42 条");
    expect(text).toContain("npm test");
    expect(text).not.toContain("xxxx");
    expect(text).not.toContain("f0.ts");
    expect(text).toContain("f39.ts");
    expect(text).toContain("（另有 3 条未列出）");
  });
});
