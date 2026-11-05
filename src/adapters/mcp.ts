/**
 * 五个角色工具的 MCP server：stdio 上换行分隔的 JSON-RPC，只实现 initialize、tools/list、tools/call、
 * ping 和 notifications/cancelled。每次调用重新读配置；仓库根和会话由宿主入口的 `locate` 给出。
 */
import { createInterface } from "node:readline";
import { loadProjectConfig, type HostFile } from "../core/config.js";
import { repoToplevel } from "../core/gitstate.js";
import { realpathOr } from "../core/paths.js";
import type { RoleRunner } from "../roles/run.js";
import { callRole, ROLES, toolInputSchema } from "../roles/tools.js";

type Id = string | number;
interface Request {
  id?: Id;
  method?: string;
  params?: {
    name?: string;
    arguments?: Record<string, unknown>;
    requestId?: Id;
    protocolVersion?: string;
    _meta?: Record<string, any>;
  };
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

const TOOLS = ROLES.map((role) => ({
  name: role.tool, description: role.description, inputSchema: toolInputSchema(role.input),
}));

const pending = new Map<string, AbortController>();
const inflight = new Set<Promise<void>>();

const send = (payload: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...payload })}\n`);
};
const reply = (id: Id, result: unknown) => send({ id, result });
const textResult = (text: string, isError = false) => ({ content: [{ type: "text", text }], ...(isError ? { isError } : {}) });

export interface McpHost {
  hostFile: HostFile;
  runner: RoleRunner;
  /** 从请求的 `_meta` 得到工作目录和会话；确定不了返回 null。 */
  locate(meta: Record<string, any>): { cwd: string; session: string } | null;
  /** initialize 回复里额外声明的 experimental 能力。 */
  experimental?: Record<string, unknown>;
}

export function serveMcp(host: McpHost): void {
  async function callTool(request: Request, signal: AbortSignal) {
    const params = request.params ?? {};
    const role = ROLES.find((item) => item.tool === params.name);
    if (role === undefined) return textResult(`[counterweight] 未知工具 ${params.name}`, true);
    const meta = params._meta ?? {};
    const where = host.locate(meta);
    if (where === null) return textResult("[counterweight] 请求里没有工作目录，无法确定仓库根。", true);
    const dir = await realpathOr(where.cwd);
    const repo = await realpathOr(await repoToplevel(dir) ?? dir);
    let project;
    try {
      project = await loadProjectConfig(repo, host.hostFile);
    } catch (error) {
      return textResult(`[counterweight] 配置非法，${role.tool} 不可用：${message(error)}`, true);
    }
    if (project === null) return textResult(`[counterweight] 未配置 [models].${role.name}，${role.tool} 不可用。`);
    return textResult(await callRole({
      repo,
      session: where.session,
      project,
      runner: host.runner,
    }, role, params.arguments ?? {}, signal));
  }

  function handle(request: Request): void {
    const { id, method } = request;
    if (id === undefined) {
      if (method === "notifications/cancelled" && request.params?.requestId !== undefined) {
        pending.get(JSON.stringify(request.params.requestId))?.abort();
      }
      return;
    }
    switch (method) {
      case "initialize":
        reply(id, {
          protocolVersion: request.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {}, ...(host.experimental === undefined ? {} : { experimental: host.experimental }) },
          serverInfo: { name: "counterweight", version: "0.3.0" },
        });
        return;
      case "ping": reply(id, {}); return;
      case "tools/list": reply(id, { tools: TOOLS }); return;
      case "tools/call": {
        const key = JSON.stringify(id);
        const controller = new AbortController();
        pending.set(key, controller);
        const work = callTool(request, controller.signal)
          .then((result) => reply(id, result), (error: unknown) => reply(id, textResult(`[counterweight] ${message(error)}`, true)))
          .finally(() => { pending.delete(key); inflight.delete(work); });
        inflight.add(work);
        return;
      }
      default: send({ id, error: { code: -32601, message: `method not found: ${method}` } });
    }
  }

  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    if (line.trim() === "") return;
    try {
      handle(JSON.parse(line) as Request);
    } catch (error) {
      process.stderr.write(`[counterweight] ${message(error)}\n`);
    }
  });
  // stdin 关闭就是 Codex 走了：终止所有角色子进程，等它们的进程组回收完再退出。
  lines.on("close", () => {
    for (const controller of pending.values()) controller.abort();
    void Promise.allSettled([...inflight]).then(() => process.exit(0));
  });
}
