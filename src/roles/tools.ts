/**
 * 五个角色工具的共享逻辑：MCP server 和 `Stop` 的自动运行都走这里。
 * 没配模型的角色调用时返回不可用。史官的子进程只读，文档由本模块写入 `.cw/HISTORY.md`。
 * 用量记入 `.cw/meter.jsonl`；记账失败不丢已经拿到的回答。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ProjectConfig } from "../core/config.js";
import { writeCwFile } from "../core/cwfile.js";
import { recordEvent, recordUsage } from "../core/meter.js";
import { gate } from "../core/router.js";
import type { RoleName } from "./prompts.js";
import { clampTimeoutS, MAX_TIMEOUT_S, MIN_TIMEOUT_S, nextTimeoutS, roleTimeoutMs, type RoleRunner } from "./run.js";

/** 一次调用所需的环境：仓库根、会话、已读好的配置，以及宿主的角色 runner。 */
export interface RoleContext {
  repo: string;
  session: string;
  project: ProjectConfig;
  runner: RoleRunner;
}

/**
 * 超时后给调用方的下一步：翻倍重试，封顶 1800；已经用满 1800 就别再加，该拆小输入。
 * 写在返回文本里，调用方不用记规则。
 */
function timeoutAdvice(tool: string, usedMs: number): string {
  const next = nextTimeoutS(usedMs);
  return next === null
    ? `已经用满 ${MAX_TIMEOUT_S} 秒上限，再加没有用：把输入拆小（分文件、分提交）后再调用 ${tool}。`
    : `下一档：用 timeout_s=${next} 重新调用 ${tool}（每次翻倍，上限 ${MAX_TIMEOUT_S}）。`;
}

export const ROLES: Array<{
  name: RoleName;
  tool: string;
  description: string;
  input: "question" | "review" | "report";
}> = [
  {
    name: "explorer",
    tool: "cw_explore",
    description: "把一个代码问题交给只读探索者。它只能读和搜，返回带来源的结论。不做修改。",
    input: "question",
  },
  {
    name: "review",
    tool: "cw_review",
    description: "把这次的要求和 diff 交给只读审查。它只报行为错误和被削弱的真实边界，不报缺测试、不提重构、不改文件。信息不够时返回 ASK 开头的问题，补充到 request 后重新调用。",
    input: "review",
  },
  {
    name: "over_review",
    tool: "cw_over_review",
    description: "把这次的要求和 diff 交给只读审查。它只报没资格留下的抽象、兜底、多余测试和防御性分支，不评对错、不改文件。信息不够时返回 ASK 开头的问题，补充到 request 后重新调用。",
    input: "review",
  },
  {
    name: "research",
    tool: "cw_research",
    description: "把主模型读代码仍定不下来的问题交给只读研究角色。结论在前，没读到的标未核实。不实现。",
    input: "question",
  },
  {
    name: "historian",
    tool: "cw_chronicle",
    description: "把阶段性成果汇报给史官（提交、决定、子 agent 的发现），它重写 .cw/HISTORY.md。写不下去时返回 ASK 开头的问题，由你回答后再汇报。",
    input: "report",
  },
];

export const TIMEOUT_DESCRIPTION = `本次调用的超时秒数（${MIN_TIMEOUT_S}–${MAX_TIMEOUT_S}，越界会被夹住）。按输入大小估：小输入不传，用默认 ${MIN_TIMEOUT_S}；明显很大（长 diff、跨很多文件）就先设长一些。超时后返回里会给下一档（每次翻倍），照着重试；已到 ${MAX_TIMEOUT_S} 还超时就拆小输入，别再加。`;

const timeoutField = { type: "integer", minimum: MIN_TIMEOUT_S, maximum: MAX_TIMEOUT_S, description: TIMEOUT_DESCRIPTION };
const string = { type: "string", minLength: 1 };

export function toolInputSchema(input: (typeof ROLES)[number]["input"]) {
  const fields = input === "question" ? { question: string }
    : input === "report" ? { report: string }
    : { request: string, diff: string };
  return {
    type: "object",
    properties: { ...fields, timeout_s: timeoutField },
    required: Object.keys(fields),
    additionalProperties: false,
  };
}

const HISTORY_FILE = "HISTORY.md";

/** 执行一个角色工具，返回给调用方的文本。 */
export async function callRole(
  ctx: RoleContext, role: (typeof ROLES)[number], params: Record<string, unknown>, signal: AbortSignal,
): Promise<string> {
  const model = ctx.project.models[role.name];
  if (model === null) return `[counterweight] 未配置 [models].${role.name}，${role.tool} 不可用。`;
  const askedS = clampTimeoutS(params.timeout_s);
  if (role.input === "report") return await chronicle(ctx, model, params.report as string, signal, askedS);
  const message = role.input === "question"
    ? params.question as string
    : reviewMessage({ request: params.request as string, diff: params.diff as string });
  const router = ctx.project.router;
  if (router !== null && (role.name === "review" || role.name === "over_review")) {
    const verdict = await gate(router, role.name, message, signal);
    await recordEvent(ctx.repo, ctx.session, "gate", {
      role: role.name, model: router.model, p: verdict.p, skipped: verdict.skip,
      audited: verdict.audited, error: verdict.error, ms: verdict.ms,
    }).catch(() => {});
    if (verdict.skip) {
      return `[counterweight] ${role.tool}（预判放行：${router.model} 判有问题的概率 ${verdict.p} ≤ ${router.skip_below}，未起审查模型）：\nnone`;
    }
  }
  const run = await runAndMeter(ctx, role.name, role.tool, model, message, signal, askedS);
  // 审查者问问题时，补充信息写进 request 再调一次；子进程是一次性的，不会记得上次。
  const asking = role.input === "review" && run.answer?.trim().startsWith("ASK:");
  return asking ? `${run.text}\n审查者需要补充信息：回答上面的问题，把答案写进 request，再调用 ${role.tool} 一次。` : run.text;
}

export function reviewMessage(params: { request: string; diff: string; actions?: string }): string {
  return `要求：\n${params.request}\n\ndiff：\n${params.diff}\n${params.actions ?? ""}`;
}

export async function runAndMeter(
  ctx: RoleContext, role: RoleName, tool: string, model: string,
  message: string, signal: AbortSignal | undefined, askedS?: number,
): Promise<{ text: string; answer: string | null }> {
  const { repo, session } = ctx;
  const started = Date.now();
  // 调用方这次要求的优先；其次是 [timeouts] 里用户配的，最后是内置默认。
  const configured = ctx.project.timeouts[role];
  const timeoutMs = askedS !== undefined ? askedS * 1000
    : configured !== undefined ? configured * 1000 : roleTimeoutMs(role);
  const run = await ctx.runner({
    role,
    workRoot: repo,
    model,
    sandbox: ctx.project.sandbox,
    message,
    signal,
    timeoutMs,
  });
  let spent = 0;
  let meterError: string | null = null;
  for (const sample of run.usage) {
    try {
      await recordUsage(repo, {
        time: new Date().toISOString(),
        session,
        model,
        input: sample.input,
        output: sample.output,
        cache_read: sample.cacheRead,
        cache_write: sample.cacheWrite,
        cost_total: sample.costTotal ?? null,
      });
    } catch (error) {
      meterError ??= error instanceof Error ? error.message : "未知错误";
    }
    spent += sample.input + sample.output + sample.cacheRead + sample.cacheWrite;
  }
  const meterNote = meterError === null ? "" : `；用量未能写入计量（${meterError}）`;
  if (run.error !== null) {
    await recordEvent(repo, session, role, {
      outcome: "failed", error: run.error, tokens: spent, ms: Date.now() - started,
      timed_out: run.timedOut, cancelled: run.cancelled,
    }).catch(() => {});
    return { answer: null, text: `[counterweight] ${tool} 未返回结果（${run.error}）；本次消耗 ${spent} token${meterNote}。${run.timedOut ? timeoutAdvice(tool, timeoutMs) : ""}` };
  }
  // result 区分白跑（none）、史官提问（ask）和有内容的回答，供判断这个角色值不值得自动跑。
  const head = run.answer!.trim();
  const result = head === "none" ? "none" : head.startsWith("ASK:") ? "ask" : "answer";
  await recordEvent(repo, session, role, {
    outcome: "answered", result, tokens: spent, ms: Date.now() - started, timed_out: false,
  }).catch(() => {});
  return {
    answer: run.answer,
    text: `[counterweight] ${tool}（模型 ${model}，消耗 ${spent} token${meterNote}）：\n${run.answer}`,
  };
}

async function readHistory(repo: string): Promise<string> {
  try {
    return await readFile(path.join(repo, ".cw", HISTORY_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

/**
 * 把汇报连同当前文档交给史官。回答以 `ASK:` 开头就原样交还主模型，不写文件；
 * 不是以 `# ` 开头的整份文档也不写，免得一句闲话覆盖掉全部历史。
 * hook 和 MCP 是不同进程，没有共享队列：写之前再读一次，文档在史官运行期间被改动就不写。
 */
export async function chronicle(
  ctx: RoleContext, model: string, report: string, signal: AbortSignal | undefined, askedS?: number,
): Promise<string> {
  let current: string;
  try {
    current = await readHistory(ctx.repo);
  } catch (error) {
    return `[counterweight] cw_chronicle 读不了 .cw/${HISTORY_FILE}：${error instanceof Error ? error.message : "未知错误"}`;
  }
  const message = `当前文档：\n${current === "" ? "（空）" : current}\n\n汇报：\n${report}\n`;
  const { text: note, answer } = await runAndMeter(ctx, "historian", "cw_chronicle", model, message, signal, askedS);
  if (answer === null) return note;
  const body = answer.trim();
  if (body.startsWith("ASK:")) return `${note}\n史官需要你协调后再汇报，文档未改动。`;
  if (!body.startsWith("# ")) return `[counterweight] cw_chronicle 史官没有返回整份文档（首行不是 # 标题），文档未改动：\n${body.slice(0, 200)}`;
  try {
    if (await readHistory(ctx.repo) !== current) {
      return `[counterweight] cw_chronicle 文档在此期间被改动，未写入，请重新汇报。`;
    }
    await writeCwFile(ctx.repo, HISTORY_FILE, `${body}\n`);
  } catch (error) {
    return `[counterweight] cw_chronicle 写入失败：${error instanceof Error ? error.message : "未知错误"}`;
  }
  return `[counterweight] cw_chronicle 已更新 .cw/${HISTORY_FILE}。`;
}
