import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin from "../src/adapters/opencode/index.js";
import { until, writeConfig } from "./support.js";

/** 假 ctx：记录调用，子会话的回答按模型脚本给出，`hang` 的模型一直等到被 interrupt。 */
function fakeCtx(directory: string, script: { answers?: Record<string, string>; hang?: string[]; fail?: string[] } = {}) {
  const hooks = new Map<string, (event: any) => any>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const sessions = new Map<string, { parentID?: string; model?: any; permissions?: any; prompts: string[]; interrupted: boolean }>();
  const synthetic: Array<{ sessionID: string; text: string }> = [];
  const interrupts: string[] = [];
  const releases = new Map<string, () => void>();
  let events: (event: any) => void = () => {};
  let nextChild = 1;
  sessions.set("root", { prompts: [], interrupted: false });
  const answerOf = (id: string) => {
    const model = `${sessions.get(id)!.model.providerID}/${sessions.get(id)!.model.id}`;
    return { model, text: script.answers?.[model] ?? "none" };
  };
  const ctx = {
    location: { directory },
    session: {
      hook: async (name: string, callback: (event: any) => any) => { hooks.set(name, callback); },
      get: async ({ sessionID }: any) => {
        const found = sessions.get(sessionID);
        if (!found) throw new Error("not found");
        return { id: sessionID, parentID: found.parentID };
      },
      create: async (input: any) => {
        const id = `child${nextChild++}`;
        sessions.set(id, { ...input, prompts: [], interrupted: false });
        return { id };
      },
      prompt: async ({ sessionID, text }: any) => { sessions.get(sessionID)!.prompts.push(text); },
      wait: async ({ sessionID }: any) => {
        const { model } = answerOf(sessionID);
        if (script.hang?.includes(model)) await new Promise<void>((resolve) => releases.set(sessionID, resolve));
      },
      context: async ({ sessionID }: any) => {
        if (sessionID === "root") {
          return [
            { type: "user", text: "修一下 a 的 bug" },
            { type: "assistant", content: [{ type: "tool", name: "read", state: { status: "completed", input: { path: "src/a.ts" }, content: [{ type: "text", text: "export const a = 1;" }] } }] },
          ];
        }
        const { model, text } = answerOf(sessionID);
        if (script.fail?.includes(model)) return [{ type: "assistant", content: [], error: { message: "boom" } }];
        return [{ type: "assistant", content: [{ type: "text", text }] }];
      },
      synthetic: async (input: any) => { synthetic.push(input); },
      interrupt: async ({ sessionID }: any) => {
        interrupts.push(sessionID);
        sessions.get(sessionID)!.interrupted = true;
        releases.get(sessionID)?.();
      },
    },
    tool: {
      hook: async (name: string, callback: (event: any) => any) => { hooks.set(name, callback); },
      transform: async (callback: (editor: any) => void) => callback({ add: (tool: any) => tools.set(tool.name, tool) }),
    },
    command: { transform: async (callback: (editor: any) => void) => callback({ add: (command: any) => commands.set(command.name, command) }) },
    event: {
      subscribe: ({ signal }: any) => ({
        async *[Symbol.asyncIterator]() {
          const queue: any[] = [];
          let wake: () => void = () => {};
          events = (event) => { queue.push(event); wake(); };
          signal?.addEventListener("abort", () => wake());
          while (!signal?.aborted) {
            if (queue.length === 0) await new Promise<void>((resolve) => { wake = resolve; });
            while (queue.length > 0) yield queue.shift();
          }
        },
      }),
    },
  };
  return {
    ctx, hooks, tools, commands, sessions, synthetic, interrupts,
    emit: (event: any) => events(event),
    fire: (name: string, event: any) => hooks.get(name)!(event),
  };
}

let repo: string;
let cleanup: (() => void) | void;
const model = (providerID: string, id: string) => ({ providerID, id });

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), "cw-opencode-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  await writeFile(path.join(repo, "a.txt"), "1\n");
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo });
  git("add", "a.txt");
  git("commit", "-qm", "init");
  await writeFile(path.join(repo, "a.txt"), "2\n");
});

afterEach(async () => {
  cleanup?.();
  await rm(repo, { recursive: true, force: true });
});

async function start(script: Parameters<typeof fakeCtx>[1] = {}) {
  const fake = fakeCtx(repo, script);
  cleanup = await plugin.setup(fake.ctx as any);
  return fake;
}
const project = (text: string) => writeConfig(repo, "project.toml", text);
const host = (text: string) => writeConfig(repo, "opencode.toml", text);
const meterLines = async () => (await readFile(path.join(repo, ".cw/meter.jsonl"), "utf8").catch(() => ""))
  .split("\n").filter((line) => line !== "").map((line) => JSON.parse(line));

describe("protection", () => {
  beforeEach(() => project('version = 1\n[protect]\npaths = ["tests"]\n'));
  const before = (fake: Awaited<ReturnType<typeof start>>, tool: string, input: Record<string, unknown>, sessionID = "root") =>
    fake.fire("execute.before", { tool, sessionID, input });

  it("refuses write, edit and patch on protected paths, and the host config", async () => {
    const fake = await start();
    await expect(before(fake, "write", { path: "tests/a.ts", content: "" })).rejects.toThrow("受保护路径");
    await expect(before(fake, "edit", { path: path.join(repo, ".cw/opencode.toml") })).rejects.toThrow("受保护路径");
    await expect(before(fake, "patch", {
      patchText: "*** Begin Patch\n*** Add File: src/a.ts\n+x\n*** Update File: tests/b.ts\n@@\n*** End Patch",
    })).rejects.toThrow("tests/b.ts");
  });

  it("refuses a call it cannot read a path from, and lets an unprotected one and other tools through", async () => {
    const fake = await start();
    await expect(before(fake, "write", {})).rejects.toThrow();
    await expect(before(fake, "patch", { patchText: "nonsense" })).rejects.toThrow();
    await expect(before(fake, "write", { path: "src/a.ts", content: "" })).resolves.toBeUndefined();
    await expect(before(fake, "read", { path: "tests/a.ts" })).resolves.toBeUndefined();
  });
});

describe("end of turn", () => {
  const idle = (fake: Awaited<ReturnType<typeof start>>, sessionID = "root") => fake.fire("experimental.idle", { sessionID, background: [] });
  const prompt = (fake: Awaited<ReturnType<typeof start>>, text = "p") => fake.fire("prompt", { sessionID: "root", prompt: { text } });

  it("repairs once, relays the failure once, then stays quiet until the next prompt", async () => {
    await project('version = 1\n[check]\ncmd = ["sh", "-c", "echo boom; exit 3"]\n');
    const fake = await start();
    await prompt(fake);
    await idle(fake);
    expect(fake.synthetic).toHaveLength(1);
    expect(fake.synthetic[0]!.text).toContain("boom");
    await idle(fake);
    expect(fake.synthetic).toHaveLength(2);
    expect(fake.synthetic[1]!.text).toContain("原样转告");
    expect(fake.synthetic[1]!.text).toContain("退出码 3");
    await idle(fake);
    expect(fake.synthetic).toHaveLength(2);
    await prompt(fake, "again");
    await idle(fake);
    expect(fake.synthetic).toHaveLength(3);
  });

  it("shows nothing for a passing check and records it in the meter", async () => {
    await project('version = 1\n[check]\ncmd = ["true"]\n');
    const fake = await start();
    await idle(fake);
    expect(fake.synthetic).toEqual([]);
    expect((await meterLines()).some((line) => line.event === "check" && line.detail.outcome === "passed")).toBe(true);
  });

  it("does not check a child session or continue after an interrupt", async () => {
    await project('version = 1\n[check]\ncmd = ["sh", "-c", "sleep 1; exit 3"]\n');
    const fake = await start();
    fake.sessions.set("sub", { parentID: "root", prompts: [], interrupted: false });
    await idle(fake, "sub");
    expect(fake.synthetic).toEqual([]);
    const running = idle(fake);
    await new Promise((resolve) => setTimeout(resolve, 200));
    fake.emit({ type: "session.execution.interrupted", data: { sessionID: "root", reason: "user" } });
    await running;
    expect(fake.synthetic).toEqual([]);
    expect((await meterLines()).filter((line) => line.event === "check").map((line) => line.detail.outcome)).toEqual(["cancelled"]);
    // 被取消的检查没有用掉修复额度。
    await project('version = 1\n[check]\ncmd = ["sh", "-c", "exit 3"]\n');
    await idle(fake);
    expect(fake.synthetic).toHaveLength(1);
  });

  describe("auto review", () => {
    const answers = { "p/rv": "WRONG `a.txt:1`\n期望：x\n实际：y", "p/ov": "none" };
    beforeEach(() => host('[models]\nreview = "p/rv"\nover_review = "p/ov"\n'));

    it("keeps the repair and findings allowances separate and gives the reviewer the user's request", async () => {
      await project('version = 1\n[check]\ncmd = ["sh", "-c", "echo boom; exit 3"]\n[auto]\nreview = true\n');
      const fake = await start({ answers });
      await prompt(fake, "把 a 改成 2");
      await idle(fake);
      await idle(fake);
      await idle(fake);
      expect(fake.synthetic.map((item) => item.text.slice(0, 40))).toEqual([
        expect.stringContaining("boom"), expect.stringContaining("自动审查有发现"), expect.stringContaining("原样转告"),
      ]);
      expect(fake.synthetic[2]!.text).toContain("不再续跑");
      const reviewer = [...fake.sessions.values()].find((session) => session.model?.id === "rv")!;
      expect(reviewer.prompts[0]).toContain("把 a 改成 2");
      // Two idle runs reached the reviewers (the first returned before them).
      expect([...fake.sessions.keys()].filter((id) => id !== "root")).toHaveLength(4);
    }, 30_000);

    it("keeps the findings when the meter cannot be written, and adds nothing when reviewers fail", async () => {
      await project('version = 1\n[auto]\nreview = true\n');
      await mkdir(path.join(repo, ".cw/meter.jsonl"));
      const fake = await start({ answers });
      await idle(fake);
      expect(fake.synthetic[0]!.text).toContain("WRONG `a.txt:1`");
      cleanup?.();
      const failing = await start({ fail: ["p/rv", "p/ov"] });
      await prompt(failing);
      await idle(failing);
      expect(failing.synthetic).toEqual([]);
    });
  });
});

describe("commands and goal", () => {
  const before = (fake: Awaited<ReturnType<typeof start>>, tool: string, input: Record<string, unknown>, sessionID = "root") =>
    fake.fire("execute.before", { tool, sessionID, input });
  const idle = (fake: Awaited<ReturnType<typeof start>>) => fake.fire("experimental.idle", { sessionID: "root", background: [] });
  const sessionsOf = (fake: Awaited<ReturnType<typeof start>>, id: string) =>
    [...fake.sessions.values()].filter((session) => session.model?.id === id);

  it("gives over_review the root session's commands, skips review on an empty diff, and does not record a blocked call", async () => {
    await project('version = 1\n[protect]\npaths = ["tests"]\n[auto]\nreview = true\n');
    await host('[models]\nreview = "p/rv"\nover_review = "p/ov"\n');
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-aqm", "two"], { cwd: repo });
    const fake = await start();
    fake.sessions.set("sub", { parentID: "root", prompts: [], interrupted: false });
    await fake.fire("prompt", { sessionID: "root", prompt: { text: "p" } });
    await expect(before(fake, "write", { path: "tests/a.ts", content: "" })).rejects.toThrow("受保护路径");
    await before(fake, "shell", { command: "python sweep.py" });
    await before(fake, "shell", { command: "rm -rf sub" }, "sub");
    await idle(fake);
    expect(sessionsOf(fake, "rv")).toHaveLength(0);
    const over = sessionsOf(fake, "ov");
    expect(over).toHaveLength(1);
    expect(over[0]!.prompts[0]).toContain("bash python sweep.py");
    expect(over[0]!.prompts[0]).toContain("共 1 条");
    expect(over[0]!.prompts[0]).not.toContain("rm -rf sub");
    expect(over[0]!.prompts[0]).not.toContain("tests/a.ts");
  });

  it("does not continue on findings without a diff", async () => {
    await project('version = 1\n[auto]\nreview = true\n');
    await host('[models]\nreview = "p/rv"\nover_review = "p/ov"\n');
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-aqm", "two"], { cwd: repo });
    const fake = await start({ answers: { "p/ov": "CUT `sweep`\n删：重跑\n留：无\n因为：请求没要求" } });
    await fake.fire("prompt", { sessionID: "root", prompt: { text: "p" } });
    await before(fake, "shell", { command: "python sweep.py" });
    await idle(fake);
    expect(fake.synthetic).toHaveLength(1);
    expect(fake.synthetic[0]!.text).toContain("原样转告");
    expect(fake.synthetic[0]!.text).toContain("自动审查有发现，不再续跑");
  });

  it("protects goal.md and pushes it for root sessions only", async () => {
    await project("version = 1\n");
    await mkdir(path.join(repo, ".cw"), { recursive: true });
    await writeFile(path.join(repo, ".cw/goal.md"), "只改绑定的释放顺序");
    const fake = await start();
    await expect(before(fake, "edit", { path: ".cw/goal.md" })).rejects.toThrow("受保护路径");
    const root: any[] = [];
    await fake.fire("context", { sessionID: "root", model: model("prov", "m"), system: root });
    expect(root[0].text).toContain("INTJ");
    expect(root[0].text).toContain("只改绑定的释放顺序");
    await writeFile(path.join(repo, ".cw/goal.md"), "改成别的");
    const again: any[] = [];
    await fake.fire("context", { sessionID: "root", model: model("prov", "m"), system: again });
    expect(again[0].text).toContain("改成别的");
    fake.sessions.set("sub", { parentID: "root", prompts: [], interrupted: false });
    const child: any[] = [];
    await fake.fire("context", { sessionID: "sub", model: model("prov", "m"), system: child });
    expect(child).toEqual([]);
  });
});

describe("PAUSE", () => {
  beforeEach(async () => {
    await project('version = 1\n[protect]\npaths = ["tests"]\n[auto]\npause = true\n');
    await host('[models]\nplanner = "p/pl"\n');
  });
  const edit = (fake: Awaited<ReturnType<typeof start>>, file: string, sessionID = "root") =>
    fake.fire("execute.before", { tool: "write", sessionID, input: { path: file, content: "" } });

  it("refuses the first source edit of a prompt with the plan, once", async () => {
    const fake = await start({ answers: { "p/pl": "根因：x" } });
    await fake.fire("prompt", { sessionID: "root", prompt: { text: "p" } });
    await expect(edit(fake, "src/a.ts")).rejects.toThrow("根因：x");
    const planner = [...fake.sessions.values()].find((session) => session.model?.id === "pl")!;
    expect(planner.prompts[0]).toContain("修一下 a 的 bug");
    expect(planner.prompts[0]).toContain("export const a = 1;");
    expect(planner.permissions).toEqual([{ action: "*", resource: "*", effect: "deny" }]);
    await expect(edit(fake, "src/a.ts")).resolves.toBeUndefined();
    await fake.fire("prompt", { sessionID: "root", prompt: { text: "p2" } });
    await expect(edit(fake, "src/a.ts")).rejects.toThrow("根因：x");
  });

  it("lets the edit through when the planner fails, protects first, and skips child sessions", async () => {
    const failing = await start({ fail: ["p/pl"] });
    await expect(edit(failing, "src/a.ts")).resolves.toBeUndefined();
    await expect(edit(failing, "src/a.ts")).resolves.toBeUndefined();
    expect(failing.sessions.size).toBe(2);
    cleanup?.();
    const fake = await start({ answers: { "p/pl": "根因：x" } });
    await expect(edit(fake, "tests/a.ts")).rejects.toThrow("受保护路径");
    fake.sessions.set("sub", { parentID: "root", prompts: [], interrupted: false });
    await expect(edit(fake, "src/a.ts", "sub")).resolves.toBeUndefined();
    expect(fake.sessions.size).toBe(2);
  });
});

describe("role tools", () => {
  beforeEach(async () => {
    await project("version = 1\n");
    await host('[models]\nexplorer = "prov/deep/model"\nreview = "prov/rv"\n');
  });

  it("runs a role in a read-only child session and refuses to run one inside a child", async () => {
    const fake = await start({ answers: { "prov/deep/model": "结论 X" } });
    const result = await fake.tools.get("cw_explore").execute({ question: "q" }, { sessionID: "root", signal: new AbortController().signal });
    expect(result.content).toContain("结论 X");
    const child = fake.sessions.get("child1")!;
    expect(child.parentID).toBe("root");
    expect(child.model).toEqual({ providerID: "prov", id: "deep/model" });
    expect(child.permissions).toEqual([
      { action: "edit", resource: "*", effect: "deny" }, { action: "shell", resource: "*", effect: "deny" },
    ]);
    cleanup?.();
    // While the role runs, its session may not start another role.
    const hang = await start({ hang: ["prov/deep/model"] });
    const outer = hang.tools.get("cw_explore").execute({ question: "q" }, { sessionID: "root", signal: new AbortController().signal });
    await until(() => hang.sessions.has("child1"), 5_000);
    const inner = await hang.tools.get("cw_review").execute({ request: "r", diff: "d" }, { sessionID: "child1", signal: new AbortController().signal });
    expect(inner.content).toContain("不可用");
    expect(hang.sessions.size).toBe(2);
    await hang.ctx.session.interrupt({ sessionID: "child1" });
    await outer;
  });

  it("interrupts the role's child session when the user interrupts", async () => {
    const fake = await start({ hang: ["prov/rv"] });
    const running = fake.tools.get("cw_review").execute({ request: "r", diff: "d" }, { sessionID: "root", signal: new AbortController().signal });
    await until(() => fake.sessions.has("child1"), 5_000);
    await new Promise((resolve) => setTimeout(resolve, 100));
    fake.emit({ type: "session.execution.interrupted", data: { sessionID: "root", reason: "user" } });
    const result = await running;
    expect(fake.interrupts).toContain("child1");
    expect(result.content).toContain("已被取消");
  });

  it("injects the role prompt into the child and the session section into the root only", async () => {
    const fake = await start({ hang: ["prov/rv"] });
    const system: any[] = [];
    await fake.fire("context", { sessionID: "root", model: model("prov", "m"), system });
    expect(system[0].text).toContain("INTJ");
    const running = fake.tools.get("cw_review").execute({ request: "r", diff: "d" }, { sessionID: "root", signal: new AbortController().signal });
    await until(() => fake.sessions.has("child1"), 5_000);
    const childSystem: any[] = [];
    await fake.fire("context", { sessionID: "child1", model: model("prov", "rv"), system: childSystem });
    expect(childSystem).toHaveLength(1);
    expect(childSystem[0].text).not.toContain("INTJ");
    await fake.ctx.session.interrupt({ sessionID: "child1" });
    await running;
  });
});

describe("metering and setup", () => {
  it("records each finished step with the model from the context hook and the reported cost", async () => {
    await project("version = 1\n");
    const fake = await start();
    await fake.fire("context", { sessionID: "root", model: model("prov", "m"), system: [] });
    fake.emit({
      type: "session.step.ended",
      data: { sessionID: "root", cost: 0.5, tokens: { input: 10, output: 4, reasoning: 0, cache: { read: 100, write: 5 } } },
    });
    await until(async () => (await meterLines()).length > 0, 5_000);
    expect((await meterLines())[0]).toMatchObject({
      kind: "usage", session: "root", model: "prov/m", input: 10, output: 4, cache_read: 100, cache_write: 5, cost_total: 0.5,
    });
  });

  it("hands the setup instructions to the model through /cw-setup", async () => {
    const fake = await start();
    await fake.commands.get("cw-setup").execute({ sessionID: "root" });
    expect(fake.synthetic[0]!.text).toContain(".cw/opencode.toml");
  });
});
