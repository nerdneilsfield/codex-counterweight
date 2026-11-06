import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadProjectConfig } from "../src/core/config.js";
import { isProtected } from "../src/core/protect.js";
import { writeConfig } from "./support.js";

let repo: string;
beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), "cw-config-"));
  await writeConfig(repo, "project.toml", "version = 1\n");
});
afterEach(() => rm(repo, { recursive: true, force: true }));

describe("host files", () => {
  const cases = [
    ["codex.toml", "gpt-5.6-terra"],
    ["claude.toml", "opus"],
    ["opencode.toml", "anthropic/claude-sonnet-4-5"],
    ["kimi.toml", "cw/terra"],
    ["hermes.toml", "openrouter/anthropic/claude-sonnet-4.5"],
  ] as const;

  it.each(cases)("loads %s and protects it", async (file, model) => {
    await writeConfig(repo, file, `[models]\nreview = "${model}"\n`);
    expect((await loadProjectConfig(repo, file))?.models.review).toBe(model);
    expect(isProtected(`.cw/${file}`, [])).toBe(true);
  });

  it("reads only the file of the asked host", async () => {
    await writeConfig(repo, "claude.toml", '[models]\nreview = "opus"\n');
    expect((await loadProjectConfig(repo, "codex.toml"))?.models.review).toBeNull();
  });

  it("accepts [roles] only in codex.toml", async () => {
    await writeConfig(repo, "codex.toml", '[roles]\nsandbox = "none"\n');
    expect((await loadProjectConfig(repo, "codex.toml"))?.sandbox).toBe("none");
    await writeConfig(repo, "claude.toml", '[roles]\nsandbox = "none"\n');
    await expect(loadProjectConfig(repo, "claude.toml")).rejects.toThrow();
    await writeConfig(repo, "opencode.toml", '[roles]\nsandbox = "none"\n');
    await expect(loadProjectConfig(repo, "opencode.toml")).rejects.toThrow();
    for (const file of ["kimi.toml", "hermes.toml"] as const) {
      await writeConfig(repo, file, '[roles]\nsandbox = "none"\n');
      await expect(loadProjectConfig(repo, file)).rejects.toThrow();
    }
  });

  it("requires provider/model in opencode.toml", async () => {
    await writeConfig(repo, "opencode.toml", '[models]\nreview = "opus"\n');
    await expect(loadProjectConfig(repo, "opencode.toml")).rejects.toThrow();
  });
});
