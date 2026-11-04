import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
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
    child.stdin.end(JSON.stringify({ cwd: sandbox.repo, session_id: "s1", ...input }));
  });
}
