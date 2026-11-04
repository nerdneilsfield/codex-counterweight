import { spawn } from "node:child_process";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";

export const PLUGIN_ROOT = path.resolve("plugins/codex-counterweight");
export const HOOK = path.join(PLUGIN_ROOT, "dist/hook.js");

/** 带假 codex 的环境：`bin` 在 PATH 最前，hook 的 PLUGIN_DATA 和 PLUGIN_ROOT 指向临时目录。 */
export interface Sandbox {
  repo: string;
  data: string;
  bin: string;
}

export function childEnv(sandbox: Sandbox): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${sandbox.bin}${path.delimiter}${process.env.PATH ?? ""}`,
    PLUGIN_DATA: sandbox.data,
    PLUGIN_ROOT,
  };
}

export async function writeConfig(repo: string, name: "project.toml" | "codex.toml", text: string): Promise<void> {
  await mkdir(path.join(repo, ".cw"), { recursive: true });
  await writeFile(path.join(repo, ".cw", name), text);
}

export function runHook(sandbox: Sandbox, input: Record<string, unknown>): Promise<{ out: any; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [HOOK], { stdio: ["pipe", "pipe", "inherit"], env: childEnv(sandbox) });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.once("error", reject);
    child.once("close", () => resolve({ out: stdout === "" ? null : JSON.parse(stdout), stdout }));
    child.stdin.end(JSON.stringify({ cwd: sandbox.repo, session_id: "s1", turn_id: "t1", ...input }));
  });
}

export interface Behavior {
  answer?: string;
  mode?: "ok" | "hang" | "noturn";
  delayMs?: number;
  usage?: Record<string, number>;
}

/** 把假 codex 装到 `bin/codex`，行为写进 `bin/script.json`。 */
export async function installFakeCodex(
  sandbox: Sandbox, script: { default?: Behavior; byModel?: Record<string, Behavior> },
): Promise<void> {
  await mkdir(sandbox.bin, { recursive: true });
  await copyFile(path.resolve("test/fake-codex.mjs"), path.join(sandbox.bin, "codex"));
  await chmod(path.join(sandbox.bin, "codex"), 0o755);
  await writeFile(path.join(sandbox.bin, "script.json"), JSON.stringify(script));
}

export interface Call { args: string[]; stdin: string; model: string; pid: number; childPid: number }

export async function fakeCalls(sandbox: Sandbox): Promise<Call[]> {
  try {
    const text = await readFile(path.join(sandbox.bin, "calls.jsonl"), "utf8");
    return text.split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as Call);
  } catch {
    return [];
  }
}

/** 进程是否还活着（僵尸不算）。 */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return false;
  }
}

export async function until(done: () => boolean | Promise<boolean>, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (!(await done()) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
}
