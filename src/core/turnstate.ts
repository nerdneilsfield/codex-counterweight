/**
 * 回合状态：hook 是一次性进程，跨 hook 的“每回合一次”标记和用户原话放在 `$PLUGIN_DATA/sessions/<session_id>/`。
 * 任何文件系统错误都让 `claim` 返回 false，也就是不续跑、不拦截。
 */
import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

type Claim = "repair" | "findings" | "pause";

/** session_id 含路径分隔符或 `..` 时不可用。 */
function sessionDir(session: string): string | null {
  const data = process.env.PLUGIN_DATA;
  if (data === undefined || data === "") return null;
  if (session === "" || session.includes("/") || session.includes("\\") || session.includes("..")) return null;
  return path.join(data, "sessions", session);
}

/** 原子地占用本回合的一个标记；只有第一次返回 true。 */
export async function claim(session: string, turn: string, name: Claim): Promise<boolean> {
  try {
    const dir = sessionDir(session);
    if (dir === null || turn === "" || turn.includes("/") || turn.includes("..")) return false;
    await mkdir(dir, { recursive: true });
    const handle = await open(path.join(dir, `${turn}.${name}`), "wx");
    await handle.close();
    return true;
  } catch {
    return false;
  }
}

export async function savePrompt(session: string, turn: string, prompt: string): Promise<void> {
  const dir = sessionDir(session);
  if (dir === null || turn === "" || turn.includes("/") || turn.includes("..")) return;
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${turn}.prompt`), prompt);
}

/** 读不到时用空串。 */
export async function loadPrompt(session: string, turn: string): Promise<string> {
  try {
    const dir = sessionDir(session);
    if (dir === null) return "";
    return await readFile(path.join(dir, `${turn}.prompt`), "utf8");
  } catch {
    return "";
  }
}

export async function endSession(session: string): Promise<void> {
  const dir = sessionDir(session);
  if (dir !== null) await rm(dir, { recursive: true, force: true });
}
