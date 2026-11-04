/**
 * 把 Codex 的 rollout JSONL（`transcript_path`）转成 PAUSE 用的 TranscriptMessage。
 * 保留 user、assistant 的文字，函数调用和输出；developer、reasoning 和其他类型丢弃，解析失败的行跳过。
 */
import type { TranscriptMessage } from "../../core/pause.js";

type Payload = Record<string, unknown> & { type?: unknown };

const text = (value: string) => [{ type: "text", text: value }];

function blocksText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => block !== null && typeof block === "object" ? (block as { text?: unknown }).text : undefined)
    .filter((part): part is string => typeof part === "string")
    .join("\n");
}

export function parseTranscript(rollout: string): TranscriptMessage[] {
  const messages: TranscriptMessage[] = [];
  const names = new Map<string, string>();
  for (const line of rollout.split("\n")) {
    if (line.trim() === "") continue;
    let entry: { type?: unknown; payload?: Payload };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = entry?.payload;
    if (entry?.type !== "response_item" || payload === null || typeof payload !== "object") continue;
    switch (payload.type) {
      case "message":
        if (payload.role === "user" || payload.role === "assistant") {
          messages.push({ role: payload.role, content: text(blocksText(payload.content)) });
        }
        break;
      case "function_call":
      case "custom_tool_call": {
        const name = String(payload.name ?? "");
        if (typeof payload.call_id === "string") names.set(payload.call_id, name);
        messages.push({
          role: "assistant",
          content: [{ type: "toolCall", name, arguments: payload.type === "function_call" ? payload.arguments : payload.input }],
        });
        break;
      }
      case "function_call_output":
      case "custom_tool_call_output": {
        const output = typeof payload.output === "string" ? payload.output : JSON.stringify(payload.output ?? "");
        messages.push({
          role: "toolResult",
          toolName: names.get(String(payload.call_id)) ?? "",
          content: text(output),
        });
        break;
      }
    }
  }
  return messages;
}
