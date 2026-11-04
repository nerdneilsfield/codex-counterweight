/** Codex 的 MCP 入口：仓库根和会话来自请求 `_meta`。 */
import { fileURLToPath } from "node:url";
import { serveMcp } from "../mcp.js";
import { runRole } from "./runner.js";

serveMcp({
  hostFile: "codex.toml",
  runner: runRole,
  experimental: { "codex/sandbox-state": {} },
  locate(meta) {
    const cwd = meta["codex/sandbox-state"]?.sandboxCwd;
    if (typeof cwd !== "string") return null;
    return {
      cwd: cwd.startsWith("file://") ? fileURLToPath(cwd) : cwd,
      session: typeof meta.sessionId === "string" ? meta.sessionId : "",
    };
  },
});
