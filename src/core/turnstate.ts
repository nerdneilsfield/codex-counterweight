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

/** 回合开始时的工作树快照（树对象 id）。 */
export async function saveBase(session: string, turn: string, base: string): Promise<void> {
  const dir = sessionDir(session);
  if (dir === null || turn === "" || turn.includes("/") || turn.includes("..")) return;
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${turn}.base`), base);
}

/** 读不到时为 null，调用方退回 HEAD。 */
export async function loadBase(session: string, turn: string): Promise<string | null> {
  try {
    const dir = sessionDir(session);
    if (dir === null || turn === "" || turn.includes("/") || turn.includes("..")) return null;
    const base = (await readFile(path.join(dir, `${turn}.base`), "utf8")).trim();
    return base === "" ? null : base;
  } catch {
    return null;
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

/** 上次注入的目标的哈希；没有记录时为 null。 */
export async function loadGoalHash(session: string): Promise<string | null> {
  try {
    const dir = sessionDir(session);
    return dir === null ? null : await readFile(path.join(dir, "goal.sha256"), "utf8");
  } catch {
    return null;
  }
}

export async function saveGoalHash(session: string, hash: string): Promise<void> {
  try {
    const dir = sessionDir(session);
    if (dir === null) return;
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "goal.sha256"), hash);
  } catch {
    // Without a stored hash the next prompt re-injects the goal, which is harmless.
  }
}

/** 会话目录下的一个小文本文件，用于没有回合 id 或没有显示渠道的宿主：当前回合、待投递的报告、是否注入过。 */
type SessionText = "turn" | "note" | "injected" | "settled" | "history";
const SESSION_FILES = new Set<SessionText>(["turn", "note", "injected", "settled", "history"]);

export async function putSessionText(session: string, name: SessionText, text: string): Promise<void> {
  const dir = sessionDir(session);
  if (dir === null || !SESSION_FILES.has(name)) return;
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, name), text);
}

/** 读不到时为 null。 */
export async function getSessionText(session: string, name: SessionText): Promise<string | null> {
  try {
    const dir = sessionDir(session);
    return dir === null ? null : await readFile(path.join(dir, name), "utf8");
  } catch {
    return null;
  }
}

/** 读出并删除；读不到时为 null。 */
export async function takeSessionText(session: string, name: SessionText): Promise<string | null> {
  const text = await getSessionText(session, name);
  const dir = sessionDir(session);
  if (text !== null && dir !== null) await rm(path.join(dir, name), { force: true });
  return text;
}

/** 回合内追加一行（Hermes 的 PAUSE 调查记录：每个工具调用和结果一行）。写失败不影响工具调用。 */
export async function appendTurnLine(session: string, turn: string, kind: "log", line: string): Promise<void> {
  try {
    const dir = sessionDir(session);
    if (dir === null || turn === "" || turn.includes("/") || turn.includes("..")) return;
    await mkdir(dir, { recursive: true });
    await appendFile(path.join(dir, `${turn}.${kind}`), `${line}\n`);
  } catch {
    // Observational only.
  }
}

/** 读不到时为空数组。 */
export async function loadTurnLines(session: string, turn: string, kind: "log"): Promise<string[]> {
  try {
    const dir = sessionDir(session);
    if (dir === null || turn === "" || turn.includes("/") || turn.includes("..")) return [];
    return (await readFile(path.join(dir, `${turn}.${kind}`), "utf8")).split("\n").filter((line) => line !== "");
  } catch {
    return [];
  }
}
