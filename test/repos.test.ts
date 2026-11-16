import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { changedFiles, snapshotTree, wantsBase, workingDiff } from "../src/core/auto.js";
import { parseProjectConfig } from "../src/core/config.js";
import { checkGoalPaths, checkPaths, checkScopePaths, endCheck, pausePlan } from "../src/core/flow.js";
import { ownerOf, readRepos } from "../src/core/repos.js";
import type { RoleRequest, RoleRun } from "../src/roles/run.js";

let A: string, B: string, C: string, D: string;
const put = async (file: string, text: string) => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
};
const initRepo = async (dir: string) => {
  await mkdir(dir, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir });
  git("init", "-q");
  await put(path.join(dir, "README"), "x\n");
  await put(path.join(dir, "src/a.ts"), "1\n");
  git("add", "README", "src/a.ts");
  git("commit", "-qm", "init");
};
const listRepos = (...lines: string[]) => put(path.join(B, ".cw/repos.txt"), `${lines.join("\n")}\n`);

beforeEach(async () => {
  A = await realpath(await mkdtemp(path.join(tmpdir(), "cw-multi-")));
  [B, C, D] = ["B", "C", "D"].map((name) => path.join(A, name)) as [string, string, string];
  for (const dir of [B, C, D]) await initRepo(dir);
});
afterEach(() => rm(A, { recursive: true, force: true }));

const project = (text: string, host = "") => parseProjectConfig(text, host);
const mainProject = project("version = 1\n");
const protectSecret = 'version = 1\n[protect]\npaths = ["secret"]\n';

describe("readRepos", () => {
  it("keeps valid repos and drops .., nested, missing, non-git, main and duplicate entries", async () => {
    await mkdir(path.join(A, "plain"));
    await initRepo(path.join(B, "nested"));
    await listRepos("# comment", "", "../C", "../C", `${D}`, "..", "nested", "../missing", "../plain", ".", "../B");
    expect(await readRepos(B)).toEqual([C, D]);
  });

  it("is empty without the file", async () => {
    expect(await readRepos(B)).toEqual([]);
  });

  it("ownerOf resolves symlinks and missing leaves", async () => {
    await symlink(C, path.join(B, "link"));
    await listRepos("../C");
    const extras = await readRepos(B);
    expect(await ownerOf(B, extras, path.join(B, "link/src/new/x.ts"))).toEqual({ repo: C, relative: "src/new/x.ts" });
    expect(await ownerOf(B, extras, path.join(B, "src/a.ts"))).toEqual({ repo: B, relative: "src/a.ts" });
    expect(await ownerOf(B, extras, path.join(D, "src/a.ts"))).toBeNull();
  });
});

describe("protection and scope across repos", () => {
  beforeEach(async () => {
    await listRepos("../C", "../D");
    await put(path.join(C, ".cw/project.toml"), protectSecret);
  });

  it("denies a protected path of C using C's own config, allows ordinary files", async () => {
    const denied = await checkPaths(B, B, mainProject, [path.join(C, "secret/k.txt")]);
    expect(denied).toContain("受保护路径");
    expect(denied).toContain("C/secret/k.txt");
    expect(await checkPaths(B, B, mainProject, [path.join(C, "src/a.ts"), "../C/src/new.ts"])).toBeNull();
    expect(await checkPaths(B, B, mainProject, ["../C/.cw/project.toml"])).toContain("受保护路径");
    // B's protect list does not leak into C.
    expect(await checkPaths(B, B, project(protectSecret), [path.join(C, "src/secret")])).toBeNull();
  });

  it("applies the minimal protection to a repo without project.toml", async () => {
    expect(await checkGoalPaths(B, B, [path.join(D, ".cw/goal.md")])).toContain("D/.cw/goal.md");
    expect(await checkGoalPaths(B, B, [path.join(D, ".cw/repos.txt")])).toContain("受保护路径");
    expect(await checkGoalPaths(B, B, [path.join(D, "src/a.ts")])).toBeNull();
    expect(await checkPaths(B, B, mainProject, [path.join(D, "secret/k")])).toBeNull();
  });

  it("uses C's scope.txt, not B's", async () => {
    await put(path.join(C, ".cw/scope.txt"), "src\n");
    expect(await checkScopePaths(B, B, [path.join(C, "lib/x.ts")])).toContain("C/lib/x.ts");
    expect(await checkScopePaths(B, B, [path.join(C, "src/x.ts")])).toBeNull();
    expect(await checkScopePaths(B, B, [path.join(D, "anything.ts")])).toBeNull();
    await put(path.join(B, ".cw/scope.txt"), "app\n");
    expect(await checkScopePaths(B, B, [path.join(C, "src/x.ts")])).toBeNull();
    expect(await checkScopePaths(B, B, [path.join(B, "src/x.ts")])).toContain("scope.txt");
    // Outside every repo stays denied while B's scope is active.
    expect(await checkScopePaths(B, B, [path.join(A, "elsewhere.ts")])).toContain("scope.txt");
  });

  it("judges a path through a symlink from B by C's rules", async () => {
    await symlink(C, path.join(B, "link"));
    await put(path.join(C, ".cw/scope.txt"), "src\n");
    expect(await checkPaths(B, B, mainProject, ["link/secret/k.txt"])).toContain("受保护路径");
    expect(await checkPaths(B, B, mainProject, ["link/src/a.ts"])).toBeNull();
    expect(await checkScopePaths(B, B, ["link/lib/x.ts"])).toContain("scope.txt");
    expect(await checkScopePaths(B, B, ["link/src/x.ts"])).toBeNull();
  });

  it("rejects writes to .cw/repos.txt with and without project.toml", async () => {
    expect(await checkGoalPaths(B, B, [".cw/repos.txt"])).toContain("受保护路径");
    expect(await checkPaths(B, B, mainProject, [".cw/repos.txt"])).toContain("受保护路径");
    expect(await checkGoalPaths(B, B, ["src/a.ts"])).toBeNull();
  });
});

describe("without repos.txt", () => {
  it("leaves outside paths unchecked for protection, denied under a scope, and the baseline a plain tree id", async () => {
    expect(await checkPaths(B, B, project(protectSecret), [path.join(C, "secret/k")])).toContain("不在仓库内");
    expect(await checkGoalPaths(B, B, [path.join(C, ".cw/goal.md")])).toBeNull();
    await put(path.join(B, ".cw/scope.txt"), "src\n");
    expect(await checkScopePaths(B, B, [path.join(C, "src/x")])).toContain("scope.txt");
    expect(await snapshotTree(B)).toMatch(/^[0-9a-f]{40,}$/);
  });
});

describe("baseline, diff, changed files", () => {
  it("covers C and ignores unchanged repos", async () => {
    await listRepos("../C", "../D");
    const base = (await snapshotTree(B))!;
    expect(JSON.parse(base)).toHaveProperty([C]);
    expect(await workingDiff(B, base)).toBe("");
    expect(await changedFiles(B, base)).toEqual([]);
    await put(path.join(C, "src/a.ts"), "2\n");
    await put(path.join(C, "new.ts"), "n\n");
    await put(path.join(B, "b.ts"), "b\n");
    const diff = (await workingDiff(B, base))!;
    expect(diff).toContain("# repo: C\n");
    expect(diff).toContain("a/C/src/a.ts");
    expect(diff).toContain("+n");
    expect(diff).toContain("b/b.ts");
    expect(diff).not.toContain("# repo: D");
    expect((await changedFiles(B, base)).sort()).toEqual(["C/new.ts", "C/src/a.ts", "b.ts"]);
  });

  it("skips a repo whose snapshot fails", async () => {
    await listRepos("../C");
    await rm(path.join(C, ".git"), { recursive: true });
    await writeFile(path.join(C, ".git"), "gitdir: /nonexistent/cw-test\n");
    const base = (await snapshotTree(B))!;
    expect(Object.keys(JSON.parse(base))).toEqual([B]);
    await put(path.join(B, "b.ts"), "b\n");
    expect(await changedFiles(B, base)).toEqual(["b.ts"]);
  });
});

describe("end-of-turn check across repos", () => {
  const marker = () => path.join(A, "ran");
  const runner = async (): Promise<RoleRun> => { throw new Error("no role expected"); };
  const run = async (base: string | null, claims: string[]) => endCheck({
    root: B, project: mainProject, session: "s", runner, signal: new AbortController().signal,
    claim: async (name) => { claims.push(name); return claims.filter((item) => item === name).length === 1; },
    prompt: async () => "", actions: async () => [], base: async () => base,
  });

  beforeEach(async () => {
    await listRepos("../C");
    await put(path.join(C, ".cw/project.toml"),
      `version = 1\n[check]\ncmd = ["sh", "-c", "echo ran >> ${marker()}; echo C-broke >&2; exit 1"]\n`);
  });

  it("runs C's failing check once with a repair, naming the repo, only when C changed", async () => {
    const base = await snapshotTree(B);
    const quiet = await run(base, []);
    expect(quiet.report).toBeNull();
    expect(quiet.continueWith).toBeNull();
    await expect(readFile(marker())).rejects.toThrow();

    await put(path.join(C, "src/a.ts"), "2\n");
    const claims: string[] = [];
    const first = await run(base, claims);
    expect(first.continueWith).toContain("[repo: C]");
    expect(first.continueWith).toContain("C-broke");
    expect(claims).toEqual(["repair"]);
    const second = await run(base, claims);
    expect(second.continueWith).toBeNull();
    expect(second.report).toContain("[repo: C]");
    expect(second.attention).toBe(true);
    expect(second.settled.outcome).toBe("failed");
    expect((await readFile(marker(), "utf8")).trim().split("\n")).toHaveLength(2);
  });

  it("does not run C's check when the baseline is unavailable", async () => {
    await put(path.join(C, "src/a.ts"), "2\n");
    const result = await run(null, []);
    expect(result.report).toBeNull();
    await expect(readFile(marker())).rejects.toThrow();
  });
});

describe("wantsBase", () => {
  const off = { review: false, chronicle: false };
  it("takes a baseline when a sibling repo is listed even with auto off, and not otherwise", async () => {
    expect(await wantsBase(B, off)).toBe(false);
    expect(await wantsBase(B, { review: true, chronicle: false })).toBe(true);
    await listRepos("../C");
    expect(await wantsBase(B, off)).toBe(true);
  });
});

describe("PAUSE targets", () => {
  it("counts a source edit in C and names it with the repo directory", async () => {
    await listRepos("../C");
    const config = parseProjectConfig("version = 1\n[auto]\npause = true\n", '[models]\nplanner = "p"\n');
    const seen: string[] = [];
    const planner = async (request: RoleRequest): Promise<RoleRun> => {
      seen.push(JSON.stringify(request));
      return { answer: "the plan", error: null, usage: [], timedOut: false, cancelled: false };
    };
    const reason = await pausePlan({
      root: B, cwd: B, project: config, session: "s", paths: [path.join(C, "src/a.ts")], tool: "write", input: {},
      runner: planner, signal: new AbortController().signal, claim: async () => true, transcript: async () => "t",
    });
    expect(reason).not.toBeNull();
    expect(seen.join()).toContain("C/src/a.ts");
  });
});
