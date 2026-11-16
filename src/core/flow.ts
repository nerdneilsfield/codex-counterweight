/**
 * 三个宿主共用的流程：路径保护、结束检查加自动任务、PAUSE。
 * 只抽流程，不抽事件模型：各宿主自己解析输入、翻译输出。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { baseTrees, changedFiles, chronicleReport, renderActions, snapshotRepo, workingDiff, type ActionRecord } from "./auto.js";
import type { ChronicleInput } from "./chronicle-event.js";
import { checkPassed, renderCheckReport, runEndCheck } from "./check.js";
import { parseProjectConfig, type ProjectConfig } from "./config.js";
import { recordEvent } from "./meter.js";
import { isNotFound, realpathOr, resolveWriteTarget } from "./paths.js";
import { isSourceEdit, pauseReason, plannerMessage } from "./pause.js";
import { GOAL_FILE, isProtected } from "./protect.js";
import { ownerOf, readRepos, REPOS_FILE } from "./repos.js";
import { inScope, readScope, SCOPE_FILE, scopeReason } from "./scope.js";
import type { Claim } from "./turnstate.js";
import type { RoleRunner } from "../roles/run.js";
import { chronicle, reviewMessage, runAndMeter, type RoleContext } from "../roles/tools.js";

/** 检查最多 3570 秒：Codex 和 Claude Code 的 Stop 超时都是 7200 秒，自动运行另有 3600 秒。 */
const MAX_CHECK_TIMEOUT_S = 3570;

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

const PROTECTED_REASON = (relative: string) => `[counterweight] ${relative} 是受保护路径`
  + "（.cw/project.toml、.cw/goal.md、.cw/scope.txt、.cw/repos.txt、.cw/ 下的宿主配置文件或项目配置 [protect].paths）；如需修改请由用户手动完成。";

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
    const extras = await readRepos(root);
    for (const raw of paths) {
      const routed = await routedTarget(root, realCwd, extras, raw);
      if (routed !== null) {
        const isExtra = extras.includes(routed.repo);
        const patterns = isExtra ? ((await loadExtraProject(routed.repo))?.protect.paths ?? []) : project.protect.paths;
        if (isProtected(routed.relative, patterns)) {
          reasons.push(PROTECTED_REASON(isExtra ? repoLabel(routed.repo, routed.relative) : routed.relative));
        }
        continue;
      }
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
 * 有额外仓库（`.cw/repos.txt`）时，路径该按哪个仓库判断：返回 null 表示按主仓库的老逻辑；
 * 否则是额外仓库（或经符号链接落到仓库外路径的真实归属）的根和相对路径。
 */
async function routedTarget(
  root: string, cwd: string, extras: readonly string[], raw: string,
): Promise<{ repo: string; relative: string } | null> {
  if (extras.length === 0) return null;
  const owner = await ownerOf(root, extras, path.resolve(cwd, raw));
  if (owner === null) return null;
  if (!extras.includes(owner.repo) && toRepoRelative(root, cwd, raw) !== null) return null;
  return owner;
}

/** 额外仓库自己的配置；没有 project.toml 为 null，配置非法时抛错（调用方按拒绝处理）。宿主文件不读，只要检查和保护。 */
async function loadExtraProject(repo: string): Promise<ProjectConfig | null> {
  let text: string;
  try {
    text = await readFile(path.join(repo, ".cw/project.toml"), "utf8");
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
  return parseProjectConfig(text);
}

const repoLabel = (repo: string, relative: string) => `${path.basename(repo)}/${relative}`;

const MINIMAL = [GOAL_FILE, SCOPE_FILE, REPOS_FILE];

/**
 * 没有可用配置时的最小保护：`.cw/goal.md` 不用配置也会被注入，`.cw/scope.txt` 不用配置也会生效，`.cw/repos.txt` 扩大写入范围，所以仍然拒绝写它们，
 * 包括经符号链接指向它们的路径。其他路径一律放行，`.cw/project.toml` 要留给 setup 创建。
 */
export async function checkGoalPaths(root: string, cwd: string, paths: string[]): Promise<string | null> {
  try {
    const realCwd = await realpathOr(cwd);
    const extras = await readRepos(root);
    for (const raw of paths) {
      const routed = await routedTarget(root, realCwd, extras, raw);
      if (routed !== null) {
        if (MINIMAL.includes(routed.relative)) {
          return PROTECTED_REASON(extras.includes(routed.repo) ? repoLabel(routed.repo, routed.relative) : routed.relative);
        }
        continue;
      }
      const lexical = toRepoRelative(root, realCwd, raw);
      if (lexical === null) continue;
      if (MINIMAL.includes(lexical)) return PROTECTED_REASON(lexical);
      let resolved: string;
      try {
        resolved = await resolveWriteTarget(root, lexical);
      } catch {
        continue;
      }
      if (MINIMAL.includes(resolved)) return `${PROTECTED_REASON(resolved)}（路径 ${raw} 指向该受保护文件）`;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * `.cw/scope.txt` 有内容时，写入范围外的路径被拒绝；不用配置也生效。没有文件、没有有效行时放行。
 * 范围生效时解析不出路径、路径在仓库外或无法核对都拒绝。
 */
export async function checkScopePaths(root: string, cwd: string, paths: string[]): Promise<string | null> {
  try {
    const prefixes = await readScope(root);
    const extras = await readRepos(root);
    if (prefixes === null && extras.length === 0) return null;
    if (prefixes !== null && paths.length === 0) return `[counterweight] 无法解析出写入路径，无法核对 ${SCOPE_FILE} 的范围，已拒绝。`;
    const realCwd = await realpathOr(cwd);
    for (const raw of paths) {
      const routed = await routedTarget(root, realCwd, extras, raw);
      if (routed !== null) {
        // 额外仓库按自己的 scope.txt；主仓库的 scope.txt 只管主仓库内的路径。
        const isExtra = extras.includes(routed.repo);
        const own = isExtra ? await readScope(routed.repo) : prefixes;
        if (own !== null && !inScope(routed.relative, own)) {
          return scopeReason(isExtra ? repoLabel(routed.repo, routed.relative) : routed.relative);
        }
        continue;
      }
      if (prefixes === null) continue;
      const lexical = toRepoRelative(root, realCwd, raw);
      if (lexical === null) return scopeReason(raw);
      if (!inScope(lexical, prefixes)) return scopeReason(lexical);
      try {
        const resolved = await resolveWriteTarget(root, lexical);
        if (!inScope(resolved, prefixes)) return `${scopeReason(resolved)}（路径 ${raw} 指向它）`;
      } catch (error) {
        if (!isNotFound(error)) return UNVERIFIABLE_REASON(raw);
      }
    }
    return null;
  } catch (error) {
    return `[counterweight] 范围检查出错，已拒绝：${message(error)}`;
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
  /** 这一回合的结论，写 chronicle 事件用；`continueWith` 非空时回合没有结束，不用它。 */
  settled: Pick<ChronicleInput, "outcome" | "evidence">;
}

/** 宿主 hook 的时间预算：检查和自动角色各自的上限，单位秒。 */
export interface EndCheckLimits {
  checkTimeoutS: number;
  roleTimeoutS: number;
}

export const NO_CHECK: EndCheckResult["settled"] = { outcome: "unknown", evidence: { gap: "没有配置结束检查" } };

/**
 * 额外仓库里要跑结束检查的：相对回合基线有改动、且自己的 `project.toml` 有 `[check]`。取不到多仓库基线时一个也没有。
 * 配置读不了的仓库记一条说明（gap），不静默跳过。
 */
async function extraChecks(
  root: string, base: () => Promise<string | null>,
): Promise<{ jobs: Array<{ repo: string; check: NonNullable<ProjectConfig["check"]>; extra: true }>; gaps: string[] }> {
  const jobs: Array<{ repo: string; check: NonNullable<ProjectConfig["check"]>; extra: true }> = [];
  const gaps: string[] = [];
  try {
    const extras = await readRepos(root);
    if (extras.length === 0) return { jobs, gaps };
    const trees = baseTrees(await base());
    if (trees === null) return { jobs, gaps };
    for (const repo of extras) {
      if (trees[repo] === undefined) continue;
      const now = await snapshotRepo(repo);
      if (now === null || now === trees[repo]) continue;
      try {
        const check = (await loadExtraProject(repo))?.check ?? null;
        if (check !== null) jobs.push({ repo, check, extra: true });
      } catch (error) {
        gaps.push(`[counterweight] ${path.basename(repo)} 的 .cw/project.toml 无法读取，没有运行它的结束检查：${message(error)}`);
      }
    }
  } catch {
    // Best-effort: the main repo's check is unaffected.
  }
  return { jobs, gaps };
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
  /** 宿主的 hook 超时装不下默认预算时，收紧检查和角色的上限（秒）；缺省是现有值。 */
  limits?: EndCheckLimits;
}): Promise<EndCheckResult> {
  const { root, project, session, signal } = params;
  const texts: string[] = [];
  let checkReport: string | null = null;
  let attention = false;
  let settled = NO_CHECK;
  const extra = await extraChecks(root, params.base);
  const jobs = [
    ...(project.check !== null ? [{ repo: root, check: project.check, extra: false }] : []),
    ...extra.jobs,
  ];
  if (jobs.length > 0 || extra.gaps.length > 0) {
    try {
      // 有额外仓库参与时，报告每段前标仓库名。
      const multi = extra.jobs.length > 0 || extra.gaps.length > 0;
      const gaps = [...extra.gaps];
      const budgetS = params.limits?.checkTimeoutS ?? MAX_CHECK_TIMEOUT_S;
      const begun = Date.now();
      const runs: Array<{ job: (typeof jobs)[number]; outcome: Awaited<ReturnType<typeof runEndCheck>>; timeout: number; ms: number }> = [];
      for (const job of jobs) {
        let timeout = Math.min(job.check.timeout_s, MAX_CHECK_TIMEOUT_S, budgetS);
        if (job.extra) {
          // 额外仓库的检查共用宿主 hook 的总预算：预算用完就不跑，并说明。
          const remaining = Math.floor(budgetS - (Date.now() - begun) / 1000);
          if (remaining < 1) {
            gaps.push(`[counterweight] ${path.basename(job.repo)} 的结束检查没有运行：已超出宿主 hook 的时间预算。`);
            continue;
          }
          timeout = Math.min(timeout, remaining);
        }
        const started = Date.now();
        const outcome = await runEndCheck({ repo: job.repo, check: { ...job.check, timeout_s: timeout }, signal });
        // 被取消的检查没有结论：不算失败，不用修复额度，也不跑自动任务。
        if (outcome.cancelled) {
          await recordEvent(root, session, "check", {
            exit_code: outcome.exitCode, timed_out: false, spawn_error: outcome.runnerError,
            ms: Date.now() - started, outcome: "cancelled", ...(job.extra ? { repo: path.basename(job.repo) } : {}),
          }).catch(() => {});
          return { continueWith: null, report: null, attention: false, settled: { outcome: "cancelled", evidence: { gap: "结束检查被取消" } } };
        }
        runs.push({ job, outcome, timeout, ms: Date.now() - started });
      }
      const failedAny = runs.some((run) => !checkPassed(run.outcome));
      // 修复额度全回合共用一次：任何一个失败且领到额度，就把所有失败报告合并续跑。
      const retry = failedAny && await params.claim("repair");
      const reports: Array<{ passed: boolean; text: string }> = [];
      for (const { job, outcome, timeout, ms } of runs) {
        const passed = checkPassed(outcome);
        let report = renderCheckReport(outcome, { command: job.check.cmd.join(" "), final: !passed && !retry });
        if (timeout < job.check.timeout_s) {
          report += `\n[counterweight] check.timeout_s=${job.check.timeout_s} 超过上限，实际超时 ${timeout}s`;
        }
        // A meter failure must not discard the check's conclusion.
        await recordEvent(root, session, "check", {
          exit_code: outcome.exitCode,
          timed_out: outcome.timedOut,
          spawn_error: outcome.runnerError,
          ms,
          outcome: outcome.runnerError !== null ? "spawn_error" : passed ? "passed" : retry ? "feedback" : "reported",
          ...(job.extra ? { repo: path.basename(job.repo) } : {}),
        }).catch(() => {});
        reports.push({ passed, text: multi ? `[repo: ${path.basename(job.repo)}]\n${report}` : report });
      }
      if (retry) {
        return { continueWith: reports.filter((item) => !item.passed).map((item) => item.text).join("\n\n"), report: null, attention: false, settled: NO_CHECK };
      }
      checkReport = [...reports.map((item) => item.text), ...gaps].join("\n\n");
      attention = failedAny || gaps.length > 0;
      settled = failedAny ? { outcome: "failed", evidence: { text: checkReport } }
        : gaps.length > 0 ? { outcome: "unknown", evidence: { gap: checkReport } }
        : { outcome: "ok", evidence: { text: checkReport } };
    } catch (error) {
      checkReport = `[counterweight] 结束检查未能完成，本轮没有得到检查结论：${message(error)}`;
      attention = true;
      settled = { outcome: "unknown", evidence: { gap: checkReport } };
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
  if (auto.findings !== null) return { continueWith: auto.findings, report: texts.length === 0 ? null : texts.join("\n\n"), attention, settled };
  if (auto.text !== null) {
    texts.push(auto.text);
    attention = true;
  }
  return { continueWith: null, report: texts.length === 0 ? null : texts.join("\n\n"), attention, settled };
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
    const ctx: RoleContext = {
      repo: root, session, project, runner: params.runner, failed, roleTimeoutCapS: params.limits?.roleTimeoutS,
    };
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
    const extras = await readRepos(root);
    const targets: string[] = [];
    for (const raw of params.paths) {
      const routed = await routedTarget(root, params.cwd, extras, raw);
      if (routed !== null) {
        if (isSourceEdit(routed.relative)) targets.push(extras.includes(routed.repo) ? repoLabel(routed.repo, routed.relative) : routed.relative);
        continue;
      }
      const relative = toRepoRelative(root, params.cwd, raw);
      if (relative !== null && isSourceEdit(relative)) targets.push(relative);
    }
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
