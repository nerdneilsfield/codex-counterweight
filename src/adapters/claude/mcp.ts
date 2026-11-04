/** Claude Code 的 MCP 入口：仓库根取 `CLAUDE_PROJECT_DIR`，没有就取进程工作目录；请求里没有会话。 */
import { serveMcp } from "../mcp.js";
import { runRole } from "./runner.js";

serveMcp({
  hostFile: "claude.toml",
  runner: runRole,
  locate: () => ({ cwd: process.env.CLAUDE_PROJECT_DIR || process.cwd(), session: "" }),
});
