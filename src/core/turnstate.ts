/**
 * 回合状态：hook 是一次性进程，跨 hook 的“每回合一次”标记和用户原话放在 `$PLUGIN_DATA`（Claude Code 是 `$CLAUDE_PLUGIN_DATA`）下的 `sessions/<session_id>/`。
 * 任何文件系统错误都让 `claim` 返回 false，也就是不续跑、不拦截。
 */
import { appendFile, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ActionRecord } from "./auto.js";

export type Claim = "repair" | "findings" | "pause";

/** session_id 含路径分隔符或 `..` 时不可用。 */
function sessionDir(session: string): string | null {
  const data = process.env.PLUGIN_DATA ?? process.env.CLAUDE_PLUGIN_DATA;
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

/** 已记入计量的 transcript 消息 id；没有可用的数据目录时返回 null，调用方应当不记，免得重复。 */
export async function loadSeen(session: string): Promise<Set<string> | null> {
  const dir = sessionDir(session);
  if (dir === null) return null;
  try {
    return new Set((await readFile(path.join(dir, "usage.seen"), "utf8")).split("\n").filter((id) => id !== ""));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? new Set() : null;
  }
}

export async function markSeen(session: string, id: string): Promise<void> {
  const dir = sessionDir(session);
  if (dir === null) return;
  await mkdir(dir, { recursive: true });
  await appendFile(path.join(dir, "usage.seen"), `${id}\n`);
}

export async function endSession(session: string): Promise<void> {
  const dir = sessionDir(session);
  if (dir !== null) await rm(dir, { recursive: true, force: true });
}

/** 本回合的一条动作，追加成 `<turn>.actions` 的一行 JSON。写失败不影响工具调用。 */
export async function recordAction(session: string, turn: string, action: ActionRecord): Promise<void> {
  try {
    const dir = sessionDir(session);
    if (dir === null || turn === "" || turn.includes("/") || turn.includes("..")) return;
    await mkdir(dir, { recursive: true });
    await appendFile(path.join(dir, `${turn}.actions`), `${JSON.stringify(action)}\n`);
  } catch {
    // Observational only.
  }
}

/** 读不到时用空数组；坏行跳过。 */
export async function loadActions(session: string, turn: string): Promise<ActionRecord[]> {
  try {
    const dir = sessionDir(session);
    if (dir === null || turn === "" || turn.includes("/") || turn.includes("..")) return [];
    const actions: ActionRecord[] = [];
    for (const line of (await readFile(path.join(dir, `${turn}.actions`), "utf8")).split("\n")) {
      try {
        const value = JSON.parse(line) as Partial<ActionRecord> | null;
        if (typeof value?.tool === "string" && typeof value.detail === "string") {
          actions.push({ tool: value.tool, detail: value.detail });
        }
      } catch {
        // A torn or malformed line.
      }
    }
    return actions;
  } catch {
    return [];
  }
}
