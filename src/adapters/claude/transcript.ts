/**
 * Claude Code 的 transcript JSONL（`transcript_path`）：转成 PAUSE 用的 TranscriptMessage，
 * 并取出助手消息的用量。助手行按内容块拆分，同一条消息的多行 `message.id` 和 `usage` 相同，用量按 id 去重。
 * 解析失败的行跳过。
 */
import type { TranscriptMessage } from "../../core/pause.js";

interface Block { type?: unknown; text?: unknown; name?: unknown; input?: unknown; content?: unknown; tool_use_id?: unknown }
interface Entry {
  type?: unknown;
  timestamp?: unknown;
  message?: { id?: unknown; model?: unknown; content?: unknown; usage?: Record<string, unknown> };
}

function entries(transcript: string): Entry[] {
  const found: Entry[] = [];
  for (const line of transcript.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const entry = JSON.parse(line) as Entry;
      if (entry !== null && typeof entry === "object") found.push(entry);
    } catch {
      continue;
    }
  }
  return found;
}

const text = (value: string) => [{ type: "text", text: value }];

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => block !== null && typeof block === "object" ? (block as Block).text : undefined)
    .filter((part): part is string => typeof part === "string")
    .join("\n");
}

export function parseTranscript(transcript: string): TranscriptMessage[] {
  const messages: TranscriptMessage[] = [];
  const names = new Map<string, string>();
  for (const entry of entries(transcript)) {
    const content = entry.message?.content;
    if (entry.type === "user") {
      if (typeof content === "string") {
        messages.push({ role: "user", content: text(content) });
        continue;
      }
      for (const block of Array.isArray(content) ? content as Block[] : []) {
        if (block.type === "text" && typeof block.text === "string") {
          messages.push({ role: "user", content: text(block.text) });
        } else if (block.type === "tool_result") {
          messages.push({
            role: "toolResult",
            toolName: names.get(String(block.tool_use_id)) ?? "",
            content: text(resultText(block.content)),
          });
        }
      }
    } else if (entry.type === "assistant" && Array.isArray(content)) {
      const blocks: unknown[] = [];
      for (const block of content as Block[]) {
        if (block.type === "text" && typeof block.text === "string") blocks.push({ type: "text", text: block.text });
        if (block.type === "tool_use" && typeof block.name === "string") {
          if (typeof (block as { id?: unknown }).id === "string") names.set((block as { id: string }).id, block.name);
          blocks.push({ type: "toolCall", name: block.name, arguments: block.input });
        }
      }
      if (blocks.length > 0) messages.push({ role: "assistant", content: blocks });
    }
  }
  return messages;
}

export interface AssistantUsage {
  id: string;
  time: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** 每个 `message.id` 取第一次出现的用量。 */
export function assistantUsage(transcript: string): AssistantUsage[] {
  const seen = new Set<string>();
  const found: AssistantUsage[] = [];
  const number = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? value : 0;
  for (const entry of entries(transcript)) {
    const message = entry.message;
    if (entry.type !== "assistant" || typeof message?.id !== "string" || message.usage === undefined) continue;
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    found.push({
      id: message.id,
      time: typeof entry.timestamp === "string" ? entry.timestamp : new Date().toISOString(),
      model: typeof message.model === "string" ? message.model : "",
      input: number(message.usage.input_tokens),
      output: number(message.usage.output_tokens),
      cacheRead: number(message.usage.cache_read_input_tokens),
      cacheWrite: number(message.usage.cache_creation_input_tokens),
    });
  }
  return found;
}
