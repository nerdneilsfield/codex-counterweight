/**
 * `.cw/goal.md`：用户写的目标。Codex 和 Claude Code 的 hook 是一次性进程，目标只在变化时注入，
 * 免得每个回合都往历史里再追加一份；OpenCode 和 pi 每次构造系统提示时直接读。
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { goalPart } from "../roles/prompts.js";
import { GOAL_FILE } from "./protect.js";
import { loadGoalHash, saveGoalHash } from "./turnstate.js";

/** 没有这个文件、或读失败时返回 null：目标是可选的，缺了就只是不注入。 */
export async function readGoal(repo: string | null): Promise<string | null> {
  if (repo === null) return null;
  try {
    return await readFile(path.join(repo, GOAL_FILE), "utf8");
  } catch {
    return null;
  }
}

/** 空白目标等同于没有目标，哈希也按空文本算。 */
export const goalHash = (goal: string | null): string =>
  createHash("sha256").update(goalPart(goal) === null ? "" : goal!).digest("hex");

export const GOAL_REMOVED = "The user removed .cw/goal.md. The earlier goal no longer applies.";

/** SessionStart 之后记下注入过的目标。 */
export async function rememberGoal(session: string, goal: string | null): Promise<void> {
  await saveGoalHash(session, goalHash(goal));
}

/**
 * UserPromptSubmit：目标相对上次注入变了才返回要追加的上下文，并记下新哈希。
 * 没有记录时，只有目标存在才算变了。
 */
export async function goalUpdate(repo: string, session: string): Promise<string | null> {
  const goal = await readGoal(repo);
  const stored = await loadGoalHash(session);
  const hash = goalHash(goal);
  const part = goalPart(goal);
  if (stored === null ? part === null : stored === hash) return null;
  await saveGoalHash(session, hash);
  return part ?? GOAL_REMOVED;
}
