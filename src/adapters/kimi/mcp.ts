/**
 * Kimi Code 的 MCP 入口。Kimi 在插件目录里启动 server，请求里没有工作目录和会话：
 * 仓库根取父进程（Kimi 本身）的当前目录，读不到就取继承来的 `PWD`，再不行取进程工作目录。
 */
import { readlinkSync } from "node:fs";
import { serveMcp } from "../mcp.js";
import { runRole } from "./runner.js";

function kimiCwd(): string {
  try {
    return readlinkSync(`/proc/${process.ppid}/cwd`);
  } catch {
    return process.env.PWD || process.cwd();
  }
}

serveMcp({
  hostFile: "kimi.toml",
  runner: runRole,
  locate: () => ({ cwd: kimiCwd(), session: "" }),
});
