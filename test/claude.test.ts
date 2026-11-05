import { execFileSync } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runRole } from "../src/adapters/claude/runner.js";
import { fakeCalls, installFakeClaude, runClaudeHook, writeConfig, type Sandbox } from "./support.js";

let repo: string;
let sandbox: Sandbox;

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), "cw-claude-"));
  const data = await mkdtemp(path.join(tmpdir(), "cw-claude-data-"));
  sandbox = { repo, data, bin: path.join(data, "bin") };
  execFileSync("git", ["init", "-q"], { cwd: repo });
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
  await rm(sandbox.data, { recursive: true, force: true });
});

const project = (text: string) => writeConfig(repo, "project.toml", text);
const hook = (input: Record<string, unknown>) => runClaudeHook(sandbox, input);
const edit = (file: string, extra: Record<string, unknown> = {}) => hook({
  hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: path.join(repo, file) }, ...extra,
});
const denied = (out: any) => out?.hookSpecificOutput?.permissionDecision === "deny";
const meterLines = async () => (await readFile(path.join(repo, ".cw/meter.jsonl"), "utf8").catch(() => ""))
  .split("\n").filter((line) => line !== "").map((line) => JSON.parse(line));

describe("protection", () => {
  beforeEach(() => project('version = 1\n[protect]\npaths = ["tests"]\n'));

  it("denies Edit, Write and NotebookEdit on protected paths, and the host config", async () => {
    expect(denied((await edit("tests/a.ts")).out)).toBe(true);
    const write = await hook({
      hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: path.join(repo, ".cw/claude.toml"), content: "" },
    });
    expect(denied(write.out)).toBe(true);
    const notebook = await hook({
      hook_event_name: "PreToolUse", tool_name: "NotebookEdit", tool_input: { notebook_path: path.join(repo, "tests/n.ipynb") },
    });
    expect(denied(notebook.out)).toBe(true);
  });

  it("denies a call with no path, and is silent for an unprotected one", async () => {
    expect(denied((await hook({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: {} })).out)).toBe(true);
    expect((await edit("src/a.ts")).stdout).toBe("");
  });
});

describe("Stop", () => {
  const stop = (extra: Record<string, unknown> = {}) => hook({ hook_event_name: "Stop", ...extra });

  it("repairs once per prompt, then reports; a new prompt gets a new allowance", async () => {
    await project('version = 1\n[check]\ncmd = ["sh", "-c", "echo boom; exit 3"]\n');
    const first = await stop();
    expect(first.out.decision).toBe("block");
    expect(first.out.reason).toContain("boom");
    const second = await stop();
    expect(second.out.decision).toBeUndefined();
    expect(second.out.systemMessage).toContain("退出码 3");
    expect((await stop({ prompt_id: "p2" })).out.decision).toBe("block");
  });

  it("reports a pass as a system message and records the check event", async () => {
    await project('version = 1\n[check]\ncmd = ["true"]\n');
    expect((await stop()).out.systemMessage).toContain("通过");
    expect((await meterLines()).some((line) => line.event === "check" && line.detail.outcome === "passed")).toBe(true);
  });

  it("keeps the verdict when the meter cannot be written", async () => {
    await project('version = 1\n[check]\ncmd = ["sh", "-c", "exit 3"]\n');
    await mkdir(path.join(repo, ".cw/meter.jsonl"));
    const { out } = await stop();
    expect(out.decision).toBe("block");
  });
});

describe("auto review", () => {
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo });
  const findings = { byModel: { rv: { answer: "WRONG `a.txt:1`\n期望：x\n实际：y" }, ov: { answer: "none" } } };

  beforeEach(async () => {
    await writeFile(path.join(repo, "a.txt"), "1\n");
    git("add", "a.txt");
    git("commit", "-qm", "init");
    await writeFile(path.join(repo, "a.txt"), "2\n");
    await writeConfig(repo, "claude.toml", '[models]\nreview = "rv"\nover_review = "ov"\n');
  });

  it("keeps the repair and findings allowances separate, and gives the reviewer the user's request", async () => {
    await project('version = 1\n[check]\ncmd = ["sh", "-c", "echo boom; exit 3"]\n[auto]\nreview = true\n');
    await installFakeClaude(sandbox, findings);
    // The baseline is taken at the prompt, so the turn's edit comes after it.
    await writeFile(path.join(repo, "a.txt"), "1\n");
    await hook({ hook_event_name: "UserPromptSubmit", prompt: "把 a 改成 2" });
    await writeFile(path.join(repo, "a.txt"), "2\n");
    const stops = [];
    for (let i = 0; i < 3; i += 1) stops.push((await hook({ hook_event_name: "Stop" })).out);
    expect(stops.map((out) => out.decision)).toEqual(["block", "block", undefined]);
    expect(stops[0].reason).toContain("boom");
    expect(stops[1].reason).toContain("自动审查有发现");
    expect(stops[1].systemMessage).toContain("退出码 3");
    expect(stops[2].systemMessage).toContain("不再续跑");
    const calls = await fakeCalls(sandbox);
    expect(calls).toHaveLength(4);
    expect(calls[0]!.stdin).toContain("把 a 改成 2");
  }, 30_000);

  it("keeps the findings when the meter cannot be written", async () => {
    await project('version = 1\n[auto]\nreview = true\n');
    await installFakeClaude(sandbox, findings);
    await mkdir(path.join(repo, ".cw/meter.jsonl"));
    expect((await hook({ hook_event_name: "Stop" })).out.reason).toContain("WRONG `a.txt:1`");
  });

  it("yields no text when the reviewers fail", async () => {
    await project('version = 1\n[auto]\nreview = true\n');
    await installFakeClaude(sandbox, { default: { failure: "overloaded" } });
    expect((await hook({ hook_event_name: "Stop" })).stdout).toBe("");
  });
});

describe("commands and goal", () => {
  it("records Bash for over_review but not a blocked edit", async () => {
    await project('version = 1\n[protect]\npaths = ["tests"]\n[auto]\nreview = true\n');
    await writeConfig(repo, "claude.toml", '[models]\nreview = "rv"\nover_review = "ov"\n');
    await installFakeClaude(sandbox, { default: { answer: "none" } });
    await writeFile(path.join(repo, "a.txt"), "1\n");
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo });
    git("add", "a.txt");
    git("commit", "-qm", "init");
    expect(denied((await edit("tests/a.ts")).out)).toBe(true);
    await hook({ hook_event_name: "Stop" });
    expect(await fakeCalls(sandbox)).toHaveLength(0);
    expect((await hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "make all" } })).stdout).toBe("");
    await hook({ hook_event_name: "Stop" });
    const calls = await fakeCalls(sandbox);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.stdin).toContain("bash make all");
  });

  it("protects goal.md, injects it at SessionStart, and returns it only when it changes", async () => {
    await project("version = 1\n");
    expect(denied((await edit(".cw/goal.md")).out)).toBe(true);
    await writeFile(path.join(repo, ".cw/goal.md"), "目标一");
    const start = await hook({ hook_event_name: "SessionStart" });
    expect(start.out.hookSpecificOutput.additionalContext).toContain("目标一");
    expect((await hook({ hook_event_name: "UserPromptSubmit", prompt: "a" })).stdout).toBe("");
    await writeFile(path.join(repo, ".cw/goal.md"), "目标二");
    const changed = await hook({ hook_event_name: "UserPromptSubmit", prompt: "b" });
    expect(changed.out.hookSpecificOutput).toMatchObject({ hookEventName: "UserPromptSubmit" });
    expect(changed.out.hookSpecificOutput.additionalContext).toContain("目标二");
    expect(await readFile(path.join(sandbox.data, "sessions/s1/p1.prompt"), "utf8")).toBe("b");
    await rm(path.join(repo, ".cw/goal.md"));
    expect((await hook({ hook_event_name: "UserPromptSubmit", prompt: "c" })).out.hookSpecificOutput.additionalContext)
      .toBe("The user removed .cw/goal.md. The earlier goal no longer applies.");
  });
});

describe("goal without a usable config", () => {
  beforeEach(() => mkdir(path.join(repo, ".cw"), { recursive: true }));

  it("refuses goal.md with no config, and still lets setup create project.toml", async () => {
    expect(denied((await edit(".cw/goal.md")).out)).toBe(true);
    expect((await edit(".cw/project.toml")).stdout).toBe("");
  });

  it("refuses goal.md with an invalid config", async () => {
    await project("version = 99\n");
    expect(denied((await edit(".cw/goal.md")).out)).toBe(true);
  });

  it("refuses goal.md through a symlink, with no config", async () => {
    await writeFile(path.join(repo, ".cw/goal.md"), "g");
    await symlink(".cw/goal.md", path.join(repo, "alias.md"));
    expect(denied((await edit("alias.md")).out)).toBe(true);
  });
});

describe("PAUSE", () => {
  let transcript: string;
  const line = (entry: Record<string, unknown>) => JSON.stringify(entry);

  beforeEach(async () => {
    await project('version = 1\n[protect]\npaths = ["tests"]\n[auto]\npause = true\n');
    await writeConfig(repo, "claude.toml", '[models]\nplanner = "pl"\n');
    transcript = path.join(repo, "t.jsonl");
    await writeFile(transcript, [
      line({ type: "user", message: { role: "user", content: "修一下 a 的 bug" } }),
      line({ type: "assistant", message: { id: "m1", role: "assistant", content: [
        { type: "tool_use", id: "u1", name: "Read", input: { file_path: "src/a.ts" } }] } }),
      line({ type: "user", message: { role: "user", content: [
        { type: "tool_result", tool_use_id: "u1", content: "export const a = 1;" }] } }),
      "not json",
    ].join("\n"));
  });

  const pausedEdit = (file: string, extra: Record<string, unknown> = {}) => edit(file, { transcript_path: transcript, ...extra });

  it("denies the first source edit of a prompt with the plan, once, and the planner has no tools", async () => {
    await installFakeClaude(sandbox, { default: { answer: "根因：x" } });
    const first = await pausedEdit("src/a.ts");
    expect(denied(first.out)).toBe(true);
    expect(first.out.hookSpecificOutput.permissionDecisionReason).toContain("根因：x");
    const [call] = await fakeCalls(sandbox);
    expect(call!.stdin).toContain("修一下 a 的 bug");
    expect(call!.stdin).toContain("export const a = 1;");
    expect(call!.args.slice(call!.args.indexOf("--tools"))).toEqual(["--tools", ""]);
    expect((await pausedEdit("src/a.ts")).stdout).toBe("");
    expect(denied((await pausedEdit("src/a.ts", { prompt_id: "p2" })).out)).toBe(true);
  });

  it("lets the edit through when the planner fails, and does not ask again", async () => {
    await installFakeClaude(sandbox, { default: { failure: "overloaded" } });
    expect((await pausedEdit("src/a.ts")).stdout).toBe("");
    expect((await pausedEdit("src/a.ts")).stdout).toBe("");
    expect(await fakeCalls(sandbox)).toHaveLength(1);
  });

  it("lets the edit through without a transcript, protects first, and ignores sub-agents", async () => {
    await installFakeClaude(sandbox, { default: { answer: "根因：x" } });
    expect((await edit("src/a.ts", { transcript_path: "" })).stdout).toBe("");
    expect(denied((await pausedEdit("tests/a.ts", { prompt_id: "p3" })).out)).toBe(true);
    expect((await pausedEdit("src/a.ts", { prompt_id: "p4", agent_id: "sub" })).stdout).toBe("");
    expect(await fakeCalls(sandbox)).toHaveLength(0);
  });
});

describe("transcript metering", () => {
  const assistant = (id: string, output: number, text: string) => JSON.stringify({
    type: "assistant", timestamp: "2026-11-04T00:00:00.000Z",
    message: {
      id, model: "claude-x", content: [{ type: "text", text }],
      usage: { input_tokens: 10, output_tokens: output, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 },
    },
  });

  it("records each message id once across repeated scans", async () => {
    await project("version = 1\n");
    const transcript = path.join(repo, "t.jsonl");
    // One message split over two lines: same id, same usage.
    await writeFile(transcript, `${assistant("m1", 7, "a")}\n${assistant("m1", 7, "b")}\n`);
    await hook({ hook_event_name: "Stop", transcript_path: transcript });
    expect(await meterLines()).toHaveLength(1);
    await appendFile(transcript, `${assistant("m2", 9, "c")}\n`);
    await hook({ hook_event_name: "Stop", transcript_path: transcript });
    await hook({ hook_event_name: "SessionEnd", transcript_path: transcript });
    const usage = (await meterLines()).filter((line) => line.kind === "usage");
    expect(usage.map((line) => line.output)).toEqual([7, 9]);
    expect(usage[0]).toMatchObject({ session: "s1", model: "claude-x", input: 10, cache_read: 100, cache_write: 5, cost_total: null });
  });
});

describe("runRole", () => {
  it("gives a role Read and Grep, reads the cost, and reports a failed result", async () => {
    await installFakeClaude(sandbox, { byModel: { bad: { failure: "overloaded" } } });
    const base = { role: "review" as const, workRoot: repo, sandbox: "read-only" as const, message: "要求", timeoutMs: 20_000 };
    const saved = process.env.PATH;
    process.env.PATH = `${sandbox.bin}${path.delimiter}${saved ?? ""}`;
    try {
      const ok = await runRole({ ...base, model: "good" });
      expect(ok).toMatchObject({ answer: "none", error: null });
      expect(ok.usage).toEqual([{ input: 200, output: 40, cacheRead: 800, cacheWrite: 5, costTotal: 0.25 }]);
      const bad = await runRole({ ...base, model: "bad" });
      expect(bad.answer).toBeNull();
      expect(bad.error).toContain("overloaded");
    } finally {
      process.env.PATH = saved;
    }
    const [call] = await fakeCalls(sandbox);
    expect(call!.args).toContain("Read,Grep");
    expect(call!.args).toContain("--strict-mcp-config");
    expect(call!.stdin).toBe("要求");
  });
});
