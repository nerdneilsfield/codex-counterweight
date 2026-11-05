import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runRole as runClaude } from "../src/adapters/claude/runner.js";
import { runRole as runCodex } from "../src/adapters/codex/runner.js";
import { budgetMessage, stepLimit, watchSteps } from "../src/core/budget.js";
import { alive, fakeCalls, installFakeClaude, installFakeCodex, until, type Sandbox } from "./support.js";

let sandbox: Sandbox;
let savedPath: string | undefined;

beforeEach(async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cw-budget-"));
  sandbox = { repo: dir, data: dir, bin: path.join(dir, "bin") };
  savedPath = process.env.PATH;
  process.env.PATH = `${sandbox.bin}${path.delimiter}${savedPath ?? ""}`;
});

afterEach(async () => {
  process.env.PATH = savedPath;
  await rm(sandbox.data, { recursive: true, force: true });
});

const request = (role: "review" | "research" | "planner", timeoutMs: number) =>
  ({ role, workRoot: sandbox.repo, model: "m1", sandbox: "read-only" as const, message: "q", timeoutMs });

describe("limits", () => {
  it("gives research 80, the planner 1 and everyone else 30", () => {
    expect(["explorer", "review", "over_review", "historian"].map(stepLimit)).toEqual([30, 30, 30, 30]);
    expect(stepLimit("research")).toBe(80);
    expect(stepLimit("planner")).toBe(1);
    expect(budgetMessage(30)).toBe("已达 30 步上限，已终止，拆小输入后重试");
  });
});

describe("watchSteps", () => {
  const lines = (n: number) => "x\n".repeat(n);
  const count = (text: string) => text.split("\n").filter((line) => line !== "").length;

  it("fires once when the count passes the limit, not at the limit", async () => {
    const file = path.join(sandbox.data, "steps.jsonl");
    await writeFile(file, lines(3));
    let fired = 0;
    const stop = watchSteps({ file, limit: 3, count, onExceed: () => { fired += 1; }, intervalMs: 10 });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(fired).toBe(0);
    await appendFile(file, lines(1));
    await until(() => fired > 0, 2_000);
    await appendFile(file, lines(5));
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(fired).toBe(1);
    stop();
  });

  it("stops polling after stop() and after the signal aborts", async () => {
    const file = path.join(sandbox.data, "steps.jsonl");
    await writeFile(file, "");
    let fired = 0;
    const stop = watchSteps({ file, limit: 0, count, onExceed: () => { fired += 1; }, intervalMs: 10 });
    stop();
    const own = new AbortController();
    watchSteps({ file, limit: 0, count, onExceed: () => { fired += 1; }, signal: own.signal, intervalMs: 10 });
    own.abort();
    await appendFile(file, lines(2));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fired).toBe(0);
  });
});

describe("Codex role budget", () => {
  async function overrun(role: "review" | "research" | "planner", tools: number) {
    await installFakeCodex(sandbox, { default: { mode: "hang", tools } });
    const run = await runCodex(request(role, 1_500));
    const [call] = await fakeCalls(sandbox);
    await until(() => !alive(call!.pid) && !alive(call!.childPid), 3_000);
    for (const pid of [call!.pid, call!.childPid].filter(alive)) process.kill(pid, "SIGKILL");
    return run;
  }

  it("aborts the 31st tool item of an ordinary role and reaps the group", async () => {
    const run = await overrun("review", 31);
    expect(run).toMatchObject({ answer: null, error: "已达 30 步上限，已终止，拆小输入后重试", budget: true, timedOut: false, cancelled: false });
    const [call] = await fakeCalls(sandbox);
    expect(alive(call!.pid) || alive(call!.childPid)).toBe(false);
  }, 20_000);

  it("lets 30 tool items through, so the hang ends as a timeout instead", async () => {
    const run = await overrun("review", 30);
    expect(run.budget).toBeUndefined();
    expect(run.timedOut).toBe(true);
  }, 20_000);

  it("gives research 80 and the planner 1", async () => {
    expect((await overrun("research", 31)).timedOut).toBe(true);
    expect((await overrun("research", 81)).budget).toBe(true);
    expect((await overrun("planner", 2)).error).toBe("已达 1 步上限，已终止，拆小输入后重试");
  }, 40_000);
});

describe("Claude Code role budget", () => {
  it("passes --max-turns per role", async () => {
    await installFakeClaude(sandbox, {});
    for (const role of ["review", "research", "planner"] as const) await runClaude(request(role, 5_000));
    const turns = (await fakeCalls(sandbox)).map((call) => call.args[call.args.indexOf("--max-turns") + 1]);
    expect(turns).toEqual(["30", "80", "1"]);
  });

  it("reports error_max_turns as a budget stop, with the usage it still spent", async () => {
    await installFakeClaude(sandbox, { default: { maxTurns: true } });
    const run = await runClaude(request("review", 5_000));
    expect(run).toMatchObject({ answer: null, error: "已达 30 步上限，已终止，拆小输入后重试", budget: true });
    expect(run.usage).toHaveLength(1);
  });
});
