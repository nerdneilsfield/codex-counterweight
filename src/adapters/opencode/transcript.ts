/**
 * OpenCode 会话消息（`session.context`）转成 PAUSE 用的 TranscriptMessage，
 * 并取出角色子会话最后一条助手消息的文字。
 */
import type { TranscriptMessage } from "../../core/pause.js";

export interface SessionMessage {
  type?: string;
  text?: string;
  content?: Array<{
    type?: string; text?: string; name?: string;
    state?: { status?: string; input?: unknown; content?: Array<{ type?: string; text?: string }> };
  }>;
  error?: unknown;
}

const text = (value: string) => [{ type: "text", text: value }];

export function toTranscript(messages: readonly SessionMessage[]): TranscriptMessage[] {
  const found: TranscriptMessage[] = [];
  for (const message of messages) {
    if (message.type === "user" && typeof message.text === "string") {
      found.push({ role: "user", content: text(message.text) });
    } else if (message.type === "assistant") {
      const blocks: unknown[] = [];
      const results: TranscriptMessage[] = [];
      for (const block of message.content ?? []) {
        if (block.type === "text" && typeof block.text === "string") blocks.push({ type: "text", text: block.text });
        if (block.type === "tool" && typeof block.name === "string") {
          const input = block.state?.input;
          blocks.push({ type: "toolCall", name: block.name, arguments: typeof input === "string" ? input : (input ?? {}) });
          if (block.state?.status === "completed") {
            const output = (block.state.content ?? []).filter((item) => item.type === "text").map((item) => item.text ?? "").join("\n");
            results.push({ role: "toolResult", toolName: block.name, content: text(output) });
          }
        }
      }
      if (blocks.length > 0) found.push({ role: "assistant", content: blocks });
      found.push(...results);
    }
  }
  return found;
}

/** 最后一条助手消息的文字；没有助手消息返回 null。 */
export function lastAnswer(messages: readonly SessionMessage[]): { text: string; failed: boolean } | null {
  const last = [...messages].reverse().find((message) => message.type === "assistant");
  if (last === undefined) return null;
  const answer = (last.content ?? [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
  return { text: answer, failed: last.error !== undefined };
}
