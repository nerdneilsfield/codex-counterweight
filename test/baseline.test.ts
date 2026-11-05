import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { changedFiles, snapshotTree, workingDiff } from "../src/core/auto.js";

let repo: string;
const git = (...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, encoding: "utf8" });
const put = async (file: string, text: string) => {
  await mkdir(path.dirname(path.join(repo, file)), { recursive: true });
  await writeFile(path.join(repo, file), text);
};

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), "cw-base-"));
  git("init", "-q");
  await put("a.txt", "1\n");
  await put("old.txt", "one\ntwo\nthree\nfour\nfive\n");
  git("add", "a.txt", "old.txt");
  git("commit", "-qm", "init");
});

afterEach(() => rm(repo, { recursive: true, force: true }));

describe("turn baseline", () => {
  it("does not count work that was already uncommitted", async () => {
    await put("a.txt", "dirty before the turn\n");
    await put("new-before.txt", "x\n");
    const base = await snapshotTree(repo);
    expect(await workingDiff(repo, base)).toBe("");
    expect(await changedFiles(repo, base)).toEqual([]);
  });

  it("counts a file committed during the turn", async () => {
    const base = await snapshotTree(repo);
    await put("b.txt", "made in the turn\n");
    git("add", "b.txt");
    git("commit", "-qm", "turn");
    expect(await changedFiles(repo, base)).toEqual(["b.txt"]);
    expect(await workingDiff(repo, base)).toContain("+made in the turn");
  });

  it("shows the content of an untracked file, and only the turn's edit of a dirty one", async () => {
    await put("a.txt", "dirty\n");
    const base = await snapshotTree(repo);
    await put("fresh.txt", "brand new line\n");
    await put("a.txt", "dirty\nmore\n");
    const diff = (await workingDiff(repo, base))!;
    expect(diff).toContain("+brand new line");
    expect(diff).toContain("+more");
    expect(diff).not.toContain("\n-1\n");
    expect(diff).not.toContain("\n+dirty\n");
    expect(diff).not.toContain("未跟踪");
    expect((await changedFiles(repo, base)).sort()).toEqual(["a.txt", "fresh.txt"]);
  });

  it("names a rename by its new path, and a Chinese filename unquoted", async () => {
    const base = await snapshotTree(repo);
    await rename(path.join(repo, "old.txt"), path.join(repo, "新名字.txt"));
    await put("说明.md", "内容\n");
    expect((await changedFiles(repo, base)).sort()).toEqual(["新名字.txt", "说明.md"]);
  });

  it("leaves the real index byte-identical and no temp index behind", async () => {
    await put("a.txt", "2\n");
    await put("untracked.txt", "u\n");
    git("add", "a.txt");
    const before = await readFile(path.join(repo, ".git/index"));
    const status = git("status", "--porcelain");
    expect(await snapshotTree(repo)).toMatch(/^[0-9a-f]{40,}$/);
    await workingDiff(repo, null);
    expect(Buffer.compare(await readFile(path.join(repo, ".git/index")), before)).toBe(0);
    expect(git("status", "--porcelain")).toBe(status);
  });

  it("ignores changes under .cw", async () => {
    const base = await snapshotTree(repo);
    await put(".cw/HISTORY.md", "# h\n");
    await put(".cw/meter.jsonl", "{}\n");
    expect(await workingDiff(repo, base)).toBe("");
    expect(await changedFiles(repo, base)).toEqual([]);
  });

  it("falls back to HEAD without a baseline, and gives no snapshot outside a repository", async () => {
    await put("a.txt", "changed\n");
    await put("new.txt", "n\n");
    expect((await changedFiles(repo, null)).sort()).toEqual(["a.txt", "new.txt"]);
    const outside = await mkdtemp(path.join(tmpdir(), "cw-nogit-"));
    try {
      expect(await snapshotTree(outside)).toBeNull();
      expect(await workingDiff(outside, null)).toBeNull();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
