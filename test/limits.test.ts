import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseProjectConfig } from "../src/core/config.js";
import { endCheck } from "../src/core/flow.js";
import { inRole, roleEnv } from "../src/core/role.js";
import type { RoleRequest, RoleRun } from "../src/roles/run.js";

let repo: string;
beforeEach(async () => { repo = await mkdtemp(path.join(tmpdir(), "cw-limits-")); });
afterEach(() => rm(repo, { recursive: true, force: true }));

const project = (text: string) => parseProjectConfig(text, '[models]\nplanner = "p"\nhistorian = "h"\n');
const params = (text: string, runner: (request: RoleRequest) => Promise<RoleRun>, limits?: { checkTimeoutS: number; roleTimeoutS: number }) => ({
  root: repo, project: project(text), session: "s", runner, signal: new AbortController().signal,
  claim: async () => true, prompt: async () => "", actions: async () => [], base: async () => null, limits,
});

describe("host time budget", () => {
  it("caps the check below the global limit and says the value it ran with", async () => {
    const runner = async (): Promise<RoleRun> => { throw new Error("no role expected"); };
    const text = 'version = 1\n[check]\ncmd = ["sh", "-c", "sleep 30"]\ntimeout_s = 600\n';
    const started = Date.now();
    const result = await endCheck({ ...params(text, runner, { checkTimeoutS: 1, roleTimeoutS: 1 }), claim: async () => false });
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(result.report).toContain("check.timeout_s=600 超过上限，实际超时 1s");
  }, 30_000);

  it("keeps the old behaviour without limits", async () => {
    const text = 'version = 1\n[check]\ncmd = ["true"]\ntimeout_s = 600\n';
    const result = await endCheck(params(text, async () => { throw new Error("no role"); }));
    expect(result.report).not.toContain("超过上限");
  });

  it("caps the role timeout of an automatic run and explains a timeout", async () => {
    const seen: number[] = [];
    const runner = async (request: RoleRequest): Promise<RoleRun> => {
      seen.push(request.timeoutMs);
      return { answer: null, error: "超时，子进程组已终止", usage: [], timedOut: true, cancelled: false };
    };
    // 先让工作树有改动，自动审查才会跑。
    const { execFileSync } = await import("node:child_process");
    const { writeFile } = await import("node:fs/promises");
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo });
    git("init", "-q");
    await writeFile(path.join(repo, "a.txt"), "1\n");
    git("add", "a.txt");
    git("commit", "-qm", "init");
    await writeFile(path.join(repo, "a.txt"), "2\n");
    const text = 'version = 1\n[auto]\nreview = true\n';
    const config = parseProjectConfig(text, '[models]\nreview = "r"\nover_review = "o"\n');
    const result = await endCheck({ ...params(text, runner, { checkTimeoutS: 10, roleTimeoutS: 7 }), project: config });
    expect(seen.length).toBe(2);
    expect(seen.every((ms) => ms === 7_000)).toBe(true);
    expect(result.report).toContain("自动审查未完成");
  });
});

describe("CW_ROLE", () => {
  it("marks a role environment and reads it back", () => {
    expect(inRole({})).toBe(false);
    expect(inRole(roleEnv({ PATH: "/bin" }))).toBe(true);
    expect(roleEnv({ PATH: "/bin" }).PATH).toBe("/bin");
  });
});
