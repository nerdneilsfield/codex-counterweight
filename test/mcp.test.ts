import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { alive, childEnv, fakeCalls, installFakeCodex, PLUGIN_ROOT, until, writeConfig, type Sandbox } from "./support.js";

const MCP = path.join(PLUGIN_ROOT, "dist/mcp.js");
const ALL_MODELS = '[models]\nexplorer = "m"\nreview = "m"\nover_review = "m"\nresearch = "m"\nhistorian = "m"\nplanner = "m"\n';

let sandbox: Sandbox;
let server: ChildProcess;
let nextId = 1;
const waiting = new Map<number, (value: any) => void>();

beforeEach(async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cw-mcp-"));
  sandbox = { repo: path.join(dir, "repo"), data: path.join(dir, "data"), bin: path.join(dir, "bin") };
  execFileSync("git", ["init", "-q", sandbox.repo]);
  await writeConfig(sandbox.repo, "codex.toml", ALL_MODELS);
  // The MCP environment is a whitelist in real Codex; mimic that.
  const env = childEnv(sandbox);
  server = spawn("node", [MCP], {
    stdio: ["pipe", "pipe", "inherit"],
    env: { PATH: env.PATH, HOME: env.HOME, PLUGIN_DATA: env.PLUGIN_DATA, PLUGIN_ROOT: env.PLUGIN_ROOT },
  });
  let buffer = "";
  server.stdout!.on("data", (chunk) => {
    buffer += chunk;
    for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
      const message = JSON.parse(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
      waiting.get(message.id)?.(message);
    }
  });
});

afterEach(async () => {
  server.kill("SIGKILL");
  await rm(path.dirname(sandbox.repo), { recursive: true, force: true });
});

function request(method: string, params: Record<string, unknown> = {}): { id: number; response: Promise<any> } {
  const id = nextId++;
  const response = new Promise<any>((resolve) => waiting.set(id, resolve));
  server.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return { id, response };
}

const meta = () => ({ sessionId: "s1", "codex/sandbox-state": { sandboxCwd: pathToFileURL(sandbox.repo).href } });
const call = (name: string, args: Record<string, unknown>) =>
  request("tools/call", { name, arguments: args, _meta: meta() });
const textOf = (response: any): string => response.result.content[0].text;

describe("tools", () => {
  it("lists five tools and runs each of them", async () => {
    await installFakeCodex(sandbox, { default: { answer: "# 历史" } });
    const listed = await request("tools/list").response;
    expect(listed.result.tools.map((tool: any) => tool.name)).toEqual(
      ["cw_explore", "cw_review", "cw_over_review", "cw_research", "cw_chronicle"]);
    const calls: Array<[string, Record<string, unknown>]> = [
      ["cw_explore", { question: "q" }],
      ["cw_review", { request: "r", diff: "d" }],
      ["cw_over_review", { request: "r", diff: "d" }],
      ["cw_research", { question: "q" }],
      ["cw_chronicle", { report: "r" }],
    ];
    for (const [name, args] of calls) {
      const text = textOf(await call(name, args).response);
      expect(text).toContain(name === "cw_chronicle" ? "已更新" : `[counterweight] ${name}（模型 m`);
    }
  });

  it("reports an unconfigured role as unavailable", async () => {
    await writeConfig(sandbox.repo, "codex.toml", '[models]\nreview = "m"\n');
    const text = textOf(await call("cw_research", { question: "q" }).response);
    expect(text).toBe("[counterweight] 未配置 [models].research，cw_research 不可用。");
  });

  it("kills the role's process group on notifications/cancelled", async () => {
    await installFakeCodex(sandbox, { default: { mode: "hang" } });
    const { id, response } = call("cw_explore", { question: "q" });
    await until(async () => (await fakeCalls(sandbox)).length > 0, 10_000);
    const [started] = await fakeCalls(sandbox);
    expect(alive(started!.childPid)).toBe(true);
    server.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id } })}\n`);
    await response;
    await until(() => !alive(started!.pid) && !alive(started!.childPid), 5_000);
    const leaked = [started!.pid, started!.childPid].filter(alive);
    for (const pid of leaked) process.kill(pid, "SIGKILL");
    expect(leaked).toEqual([]);
  }, 30_000);
});

describe("cw_chronicle", () => {
  const history = () => path.join(sandbox.repo, ".cw", "HISTORY.md");

  it("writes the document the historian returns", async () => {
    await installFakeCodex(sandbox, { default: { answer: "# 历史\n- 第一条" } });
    expect(textOf(await call("cw_chronicle", { report: "r" }).response)).toContain("已更新");
    expect(await readFile(history(), "utf8")).toBe("# 历史\n- 第一条\n");
  });

  it("does not write an ASK reply", async () => {
    await installFakeCodex(sandbox, { default: { answer: "ASK:\n哪天提交的？" } });
    expect(textOf(await call("cw_chronicle", { report: "r" }).response)).toContain("文档未改动");
    await expect(readFile(history(), "utf8")).rejects.toThrow();
  });

  it("does not write when the document changed during the run", async () => {
    await installFakeCodex(sandbox, { default: { answer: "# 新", delayMs: 1500 } });
    const { response } = call("cw_chronicle", { report: "r" });
    await until(async () => (await fakeCalls(sandbox)).length > 0, 10_000);
    await writeFile(history(), "# 别人写的\n");
    expect(textOf(await response)).toContain("文档在此期间被改动，未写入，请重新汇报");
    expect(await readFile(history(), "utf8")).toBe("# 别人写的\n");
  }, 20_000);
});
