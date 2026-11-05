/**
 * 三个宿主共用的流程：路径保护、结束检查加自动任务、PAUSE。
 * 只抽流程，不抽事件模型：各宿主自己解析输入、翻译输出。
 */
import path from "node:path";
import { changedFiles, chronicleReport, renderActions, workingDiff, type ActionRecord } from "./auto.js";
import { checkPassed, renderCheckReport, runEndCheck } from "./check.js";
import type { ProjectConfig } from "./config.js";
import { recordEvent } from "./meter.js";
import { isNotFound, realpathOr, resolveWriteTarget } from "./paths.js";
import { isSourceEdit, pauseReason, plannerMessage } from "./pause.js";
import { GOAL_FILE, isProtected } from "./protect.js";
import type { Claim } from "./turnstate.js";
import type { RoleRunner } from "../roles/run.js";
import { chronicle, reviewMessage, runAndMeter, type RoleContext } from "../roles/tools.js";

/** 检查最多 3570 秒：Codex 和 Claude Code 的 Stop 超时都是 7200 秒，自动运行另有 3600 秒。 */
const MAX_CHECK_TIMEOUT_S = 3570;

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

const PROTECTED_REASON = (relative: string) => `[counterweight] ${relative} 是受保护路径`
  + "（.cw/project.toml、.cw/goal.md、.cw/ 下的宿主配置文件或项目配置 [protect].paths）；如需修改请由用户手动完成。";

const UNVERIFIABLE_REASON = (value: string) =>
  `[counterweight] 路径无法核对受保护集合（符号链接逃逸仓库或不可解析），已拒绝：${value}`;

/** 返回拒绝理由；放行返回 null。解析不出路径或检查出错都拒绝。 */
export async function checkPaths(
  root: string, cwd: string, project: ProjectConfig, paths: string[],
): Promise<string | null> {
  try {
    if (paths.length === 0) return "[counterweight] 无法从补丁中解析出路径，无法核对受保护集合，已拒绝。";
    const realCwd = await realpathOr(cwd);
    const reasons: string[] = [];
    for (const raw of paths) {
      const reason = await checkProtectedTarget(root, realCwd, project.protect.paths, raw);
      if (reason !== null) reasons.push(reason);
    }
    return reasons.length > 0 ? reasons.join("\n") : null;
  } catch (error) {
    return `[counterweight] 保护检查出错，已拒绝：${message(error)}`;
  }
}

/** 语义与 pi 版 checkProtectedTarget 相同。 */
async function checkProtectedTarget(
  root: string, cwd: string, patterns: readonly string[], raw: string,
): Promise<string | null> {
  const lexical = toRepoRelative(root, cwd, raw);
  if (lexical === null) return `[counterweight] 路径不在仓库内，无法核对受保护集合，已拒绝：${raw}`;
  if (isProtected(lexical, patterns)) return PROTECTED_REASON(lexical);
  let resolved: string;
  try {
    resolved = await resolveWriteTarget(root, lexical);
  } catch (error) {
    // Nothing on the path exists: a new file, already judged lexically.
    if (isNotFound(error)) return null;
    return UNVERIFIABLE_REASON(raw);
  }
  if (isProtected(resolved, patterns)) {
    const via = resolved === lexical ? "" : `（路径 ${raw} 指向该受保护文件）`;
    return `${PROTECTED_REASON(resolved)}${via}`;
  }
  return null;
}

function toRepoRelative(repoRoot: string, cwd: string, value: string): string | null {
  const relative = path.relative(repoRoot, path.resolve(cwd, value));
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join("/");
}

/**
 * 没有可用配置时的最小保护：`.cw/goal.md` 不用配置也会被注入，所以仍然拒绝写它，包括经符号链接指向它的路径。
 * 其他路径一律放行，`.cw/project.toml` 要留给 setup 创建。
 */
export async function checkGoalPaths(root: string, cwd: string, paths: string[]): Promise<string | null> {
  try {
    const realCwd = await realpathOr(cwd);
    for (const raw of paths) {
      const lexical = toRepoRelative(root, realCwd, raw);
      if (lexical === null) continue;
      if (lexical === GOAL_FILE) return PROTECTED_REASON(GOAL_FILE);
      let resolved: string;
      try {
        resolved = await resolveWriteTarget(root, lexical);
      } catch {
        continue;
      }
      if (resolved === GOAL_FILE) return `${PROTECTED_REASON(GOAL_FILE)}（路径 ${raw} 指向该受保护文件）`;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 会话真正开始时（startup、clear）的一行提示：没有 `project.toml` 或没有 `[check]`，结束检查不会运行。
 * 配置非法由宿主另行报告，不走这里。
 */
export const missingCheckNotice = (project: ProjectConfig | null, setup: string): string | null =>
  project?.check != null ? null
    : `[counterweight] 结束检查没有配置（${project === null ? "没有 .cw/project.toml" : ".cw/project.toml 里没有 [check]"}），回合结束时不会跑检查。运行 ${setup} 配置，或在 .cw/project.toml 写 [check] cmd = ["..."]。`;

export interface EndCheckResult {
  /** 非空表示要续跑，内容交给模型。 */
  continueWith: string | null;
  /** 给用户看的报告；没有则为 null。 */
  report: string | null;
  /** 报告里有用户必须看到的问题：检查没通过或没完成，或续跑之后仍有审查发现。 */
  attention: boolean;
}

/**
 * 结束检查和自动任务。检查失败时第一次让模型修，额度用完后如实报告；审查发现同理，额度独立。
 * 计量失败不改变检查结论；`[auto]` 的任何失败都只是不产生文字。
 * `claim` 取本回合的一次额度，`prompt` 取本回合用户原话，存储由宿主决定。
 */
export async function endCheck(params: {
  root: string;
  project: ProjectConfig;
  session: string;
  runner: RoleRunner;
  signal: AbortSignal;
  claim: (name: Claim) => Promise<boolean>;
  prompt: () => Promise<string>;
  /** 本回合的非只读动作，只交给 over_review。 */
  actions: () => Promise<ActionRecord[]>;
  /** 本回合开始时的工作树快照；没取到为 null。 */
  base: () => Promise<string | null>;
}): Promise<EndCheckResult> {
  const { root, project, session, signal } = params;
  const texts: string[] = [];
  let checkReport: string | null = null;
  let attention = false;
  if (project.check !== null) {
    try {
      const check = project.check;
      const timeout = Math.min(check.timeout_s, MAX_CHECK_TIMEOUT_S);
      const started = Date.now();
      const outcome = await runEndCheck({ repo: root, check: { ...check, timeout_s: timeout }, signal });
      // 被取消的检查没有结论：不算失败，不用修复额度，也不跑自动任务。
      if (outcome.cancelled) {
        await recordEvent(root, session, "check", {
          exit_code: outcome.exitCode, timed_out: false, spawn_error: outcome.runnerError,
          ms: Date.now() - started, outcome: "cancelled",
        }).catch(() => {});
        return { continueWith: null, report: null, attention: false };
      }
      const passed = checkPassed(outcome);
      const retry = !passed && await params.claim("repair");
      let report = renderCheckReport(outcome, { command: check.cmd.join(" "), final: !passed && !retry });
      if (timeout < check.timeout_s) {
        report += `\n[counterweight] check.timeout_s=${check.timeout_s} 超过上限，实际超时 ${timeout}s`;
      }
      // A meter failure must not discard the check's conclusion.
      await recordEvent(root, session, "check", {
        exit_code: outcome.exitCode,
        timed_out: outcome.timedOut,
        spawn_error: outcome.runnerError,
        ms: Date.now() - started,
        outcome: outcome.runnerError !== null ? "spawn_error" : passed ? "passed" : retry ? "feedback" : "reported",
      }).catch(() => {});
      if (retry) return { continueWith: report, report: null, attention: false };
      checkReport = report;
      attention = !passed;
    } catch (error) {
      checkReport = `[counterweight] 结束检查未能完成，本轮没有得到检查结论：${message(error)}`;
      attention = true;
    }
    texts.push(checkReport);
  }
  const auto = await runAuto(params, checkReport);
  // 角色没跑完要让用户看到，不改检查结论，也不续跑。
  if (auto.failure !== null) {
    texts.push(auto.failure);
    attention = true;
  }
  // 审查发现续跑时，检查报告留给用户，发现作为续跑内容交回模型。
  if (auto.findings !== null) return { continueWith: auto.findings, report: texts.length === 0 ? null : texts.join("\n\n"), attention };
  if (auto.text !== null) {
    texts.push(auto.text);
    attention = true;
  }
  return { continueWith: null, report: texts.length === 0 ? null : texts.join("\n\n"), attention };
}

/**
 * 收尾时的自动审查与汇报，只在 `[auto]` 打开时有动作。review 与 over_review 并行，只报告，不决定检查是否通过。
 * 有发现且本回合还没续跑过：发现作为 `findings` 交回模型续跑一次；额度用完只显示。
 * 改动按回合基线算，续跑后的那次收尾看到整个回合。不续跑的收尾才交给史官，发现照样显示。任何失败都只是不产生文字。
 */
async function runAuto(
  params: Parameters<typeof endCheck>[0], checkLine: string | null,
): Promise<{ text: string | null; findings: string | null; failure: string | null }> {
  const none = { text: null, findings: null, failure: null };
  const { root, project, session, signal } = params;
  try {
    if (!project.auto.review && !project.auto.chronicle) return none;
    const base = await params.base();
    const diff = await workingDiff(root, base);
    const changed = diff !== null && diff.trim() !== "";
    // 跑了命令但没改文件时 diff 是空的。命令只交给 over_review，review 仍按 diff 判断对错。
    const actions = renderActions(await params.actions());
    const plan = {
      review: project.auto.review && changed,
      overReview: project.auto.review && (changed || actions !== ""),
      chronicle: project.auto.chronicle && changed,
    };
    if (!plan.review && !plan.overReview && !plan.chronicle) return none;
    const failed: NonNullable<RoleContext["failed"]> = [];
    const ctx: RoleContext = { repo: root, session, project, runner: params.runner, failed };
    const failureLine = (): string | null => failed.length === 0 ? null
      : `[counterweight] 自动审查未完成：${failed.map((item) => `${item.role} ${item.reason}`).join("；")}`;
    const request = await params.prompt();
    let shown: string | null = null;
    if (plan.review || plan.overReview) {
      const empty = Promise.resolve({ answer: null });
      const [correct, over] = await Promise.all([
        plan.review
          ? runAndMeter(ctx, "review", "cw_review", project.models.review!, reviewMessage({ request, diff: diff ?? "" }), signal)
          : empty,
        plan.overReview
          ? runAndMeter(ctx, "over_review", "cw_over_review", project.models.over_review!, reviewMessage({ request, diff: diff ?? "", actions }), signal)
          : empty,
      ]);
      const findings = [correct, over]
        .map((run) => run.answer?.trim() ?? "")
        .filter((answer) => answer !== "" && answer !== "none" && !answer.startsWith("ASK:"));
      if (findings.length > 0) {
        // 没有 diff 时发现只针对已经跑完的命令，再续跑一轮无文件可改，只会把同一批调用重审一遍。
        // 额度照样用掉：发现在本回合只提示一次。
        const first = await params.claim("findings");
        if (changed && first) {
          return { text: null, findings: `[counterweight] 自动审查有发现，处理或说明为什么不处理：\n\n${findings.join("\n\n")}`, failure: failureLine() };
        }
        shown = `[counterweight] 自动审查有发现，不再续跑：\n\n${findings.join("\n\n")}`;
      }
    }
    // 走到这里就不再续跑：发现只显示，这一轮的汇报照样给史官。
    if (plan.chronicle) {
      // 史官失败不能吞掉已经拿到的审查发现。
      try {
        const report = chronicleReport(request, await changedFiles(root, base), checkLine);
        await chronicle(ctx, project.models.historian!, report, signal);
      } catch {
        // Best-effort.
      }
    }
    return { text: shown, findings: null, failure: failureLine() };
  } catch {
    return none;
  }
}

/**
 * PAUSE：本回合第一次对源码的编辑，让 planner 读完调查写一份计划，返回拒绝理由；不拦返回 null。
 * 任何失败（没有记录、planner 失败或超时）都返回 null，即放行；先 claim 再请求，失败也不会让同一回合被反复拦。
 */
export async function pausePlan(params: {
  root: string;
  cwd: string;
  project: ProjectConfig;
  session: string;
  paths: string[];
  tool: string;
  input: Record<string, unknown>;
  runner: RoleRunner;
  signal: AbortSignal;
  claim: () => Promise<boolean>;
  /** 渲染好的调查记录；取不到就抛错。 */
  transcript: () => Promise<string>;
}): Promise<string | null> {
  try {
    const { root, project, session } = params;
    const planner = project.models.planner;
    if (!project.auto.pause || planner === null) return null;
    const targets = params.paths.map((raw) => toRepoRelative(root, params.cwd, raw)).filter((relative) => isSourceEdit(relative));
    if (targets.length === 0) return null;
    if (!await params.claim()) return null;
    const started = Date.now();
    const outcome = async (result: string) => {
      await recordEvent(root, session, "pause", { outcome: result, ms: Date.now() - started, tool: params.tool }).catch(() => {});
    };
    try {
      const body = plannerMessage(await params.transcript(), targets.join(", "), params.tool, params.input);
      const run = await runAndMeter(
        { repo: root, session, project, runner: params.runner }, "planner", "cw_pause", planner, body, params.signal);
      await outcome(run.answer === null ? "failed" : "planned");
      return run.answer === null ? null : pauseReason(run.answer.trim());
    } catch {
      await outcome("failed");
      return null;
    }
  } catch {
    return null;
  }
}
