/**
 * Kimi Code 的会话记录 `wire.jsonl`：每行一个 JSON。用量在 `usage.record`，没有记录 id，所以按
 * `(agentId, time, model, 四个数)` 去重；PAUSE 需要的调查记录来自 `agent.message.appended`。
 * 会话目录是 `$KIMI_CODE_HOME/sessions/<工作区目录>/<会话 id>/agents/<agent>/wire.jsonl`，不设该变量时是 `~/.kimi-code`。
 */
import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { TranscriptMessage } from "../../core/pause.js";

export const kimiHome = (): string => process.env.KIMI_CODE_HOME || path.join(os.homedir(), ".kimi-code");

export interface WireUsage {
  key: string;
  time: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

function lines(text: string): Array<Record<string, any>> {
  const found: Array<Record<string, any>> = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const value = JSON.parse(line);
      if (value !== null && typeof value === "object") found.push(value);
    } catch {
      // A torn last line while the session is still writing.
    }
  }
  return found;
}

/** 同一份记录里重复的行只算一次；跨次调用的去重由调用方用 `key` 做。 */
export function wireUsage(text: string): WireUsage[] {
  const seen = new Set<string>();
  const found: WireUsage[] = [];
  const number = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? value : 0;
  for (const entry of lines(text)) {
    if (entry.type !== "usage.record" || entry.usage === null || typeof entry.usage !== "object") continue;
    const usage = entry.usage as Record<string, unknown>;
    const model = typeof entry.model === "string" ? entry.model : "";
    const record = {
      input: number(usage.inputOther), output: number(usage.output),
      cacheRead: number(usage.inputCacheRead), cacheWrite: number(usage.inputCacheCreation),
    };
    const key = [entry.agentId ?? "", entry.time ?? "", model, record.input, record.output, record.cacheRead, record.cacheWrite].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ key, time: typeof entry.time === "number" ? new Date(entry.time).toISOString() : new Date().toISOString(), model, ...record });
  }
  return found;
}

/** 一个会话的所有 agent 的 wire 文件内容；找不到会话时为空数组。 */
export async function sessionWires(session: string): Promise<Array<{ agent: string; text: string }>> {
  if (session === "" || session.includes("/") || session.includes("..")) return [];
  const root = path.join(kimiHome(), "sessions");
  const texts: Array<{ agent: string; text: string }> = [];
  let workspaces: string[];
  try {
    workspaces = await readdir(root);
  } catch {
    return [];
  }
  for (const workspace of workspaces) {
    const agents = path.join(root, workspace, session, "agents");
    let names: string[];
    try {
      names = await readdir(agents);
    } catch {
      continue;
    }
    for (const name of names) {
      try {
        texts.push({ agent: name, text: await readFile(path.join(agents, name, "wire.jsonl"), "utf8") });
      } catch {
        // An agent without a wire file yet.
      }
    }
  }
  return texts;
}

const text = (value: string) => [{ type: "text", text: value }];

function partsText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => part !== null && typeof part === "object" && (part as { type?: unknown }).type === "text"
      ? (part as { text?: unknown }).text : undefined)
    .filter((part): part is string => typeof part === "string")
    .join("\n");
}

/** `agent.message.appended`：用户、助手（文字加工具调用）和工具结果，系统提醒和 hook 结果不算调查。 */
export function parseWireTranscript(wire: string): TranscriptMessage[] {
  const messages: TranscriptMessage[] = [];
  const names = new Map<string, string>();
  for (const entry of lines(wire)) {
    if (entry.type !== "agent.message.appended") continue;
    const message = entry.message?.message;
    const origin = entry.message?.meta?.origin;
    if (message === null || typeof message !== "object") continue;
    if (message.role === "user") {
      if (origin?.kind !== undefined && origin.kind !== "user") continue;
      const body = partsText(message.content);
      if (body.trim() !== "") messages.push({ role: "user", content: text(body) });
    } else if (message.role === "assistant") {
      const blocks: unknown[] = [];
      const body = partsText(message.content);
      if (body.trim() !== "") blocks.push({ type: "text", text: body });
      for (const call of Array.isArray(message.toolCalls) ? message.toolCalls : []) {
        if (typeof call?.name !== "string") continue;
        if (typeof call.id === "string") names.set(call.id, call.name);
        let args: unknown = {};
        try {
          args = typeof call.arguments === "string" ? JSON.parse(call.arguments) : call.arguments;
        } catch {
          args = {};
        }
        blocks.push({ type: "toolCall", name: call.name, arguments: args });
      }
      if (blocks.length > 0) messages.push({ role: "assistant", content: blocks });
    } else if (message.role === "tool") {
      messages.push({ role: "toolResult", toolName: names.get(String(message.toolCallId)) ?? "", content: text(partsText(message.content)) });
    }
  }
  return messages;
}
