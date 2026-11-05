# Harness 机制轮实施计划

Plan readiness: ready。

## 结果和范围

七项机制进入两个 harness：`pi-counterweight`（Pi）和本仓库（Codex、Claude Code、OpenCode）。skills 继续在 skills 仓库维护，harness 只提供机制。

依据：5 份真实 `meter.jsonl` 共 2053 行，`check` 事件 0 条；5 次角色调用失败 2 次；一次 review 超时花掉 125 万 token。

不包括：失控主会话检测、推送、仓库改名。Claude Code TUI 无法在这里验证的项目要标为未验证。

授权：已授权实现和本地提交。推送等验收。

## 共用逻辑

纯函数放在两个仓库的同名文件里，保持字节一致：`src/core/danger.ts`、`src/core/scope.ts`、`src/core/chronicle-event.ts`、`src/core/pending.ts`、`src/core/budget.ts`。

本仓库加 `npm run check:sync`：`../pi-counterweight` 存在时逐字节比较这五个文件，不一致就失败；不存在时跳过并说明。`npm test` 不调用它，避免在没有 pi 副本的环境失败，发布前手动运行。

## 七项设计

### 1. 缺 `[check]` 的提示

会话真正开始时（`startup`、`clear`，不含 `compact` 和 `resume`），没有 `project.toml` 或没有 `[check]`，显示一行，说明结束检查没有配置，以及怎么配置。Codex、Claude Code 用 `systemMessage`，pi 用 `ctx.ui.notify`。OpenCode 没有显示通道，只在 `inject` 事件里记录 `check: false`。

### 2. 角色成本

两层措施：

- 输入收窄：`review.md`、`over-review.md` 增加读取范围规则：只读 diff 涉及的文件和判断所需的直接调用方，不扫描仓库。两边提示保持一致。
- 步数预算：`budget.ts` 定义每个角色的步数上限，普通角色 30，`research` 80，`planner` 1。一步是一次模型请求或工具调用，以宿主能观察到的为准。

| 宿主 | 机制 |
| --- | --- |
| Claude Code | `claude -p --max-turns <n>`，验证参数行为 |
| Codex | 轮询 `--json` 输出文件，数已完成的工具 item，超限 abort |
| OpenCode | `session.step.ended` 计数，超限 `interrupt` |
| pi | 轮询 `--mode json` 输出文件，数 assistant `message_end`，超限 abort |

超限返回 `已达 <n> 步上限，已终止，拆小输入后重试`，已有的 `timed_out` 语义不变，事件新增 `outcome: "budget"`。不重试。

`token` 不作为上限：Codex 的 `turn.completed` 只在结束时给出。

### 3. `[auto]` 角色失败可见

`runAuto` 收集失败的角色，回合结束显示一行：`[counterweight] 自动审查未完成：<角色> <原因>`。不改变检查结论，不续跑。Codex、Claude Code 写入 `systemMessage`，pi 写入结算消息。OpenCode 通过 `attention` 转告一次，这会多花一次模型调用，但失败很少发生，而且不转告就完全看不见。

### 4. 高危命令和范围锁定

`danger.ts`：`dangerousCommand(command): string | null`，返回拒绝理由。只做最高危一级：

- `rm` 带递归和强制，目标是 `/`、`/*`、`~`、`$HOME`。
- `git push` 强制推送默认分支 `main`、`master`，`--force-with-lease` 不算。
- `mkfs`，`dd of=/dev/...`。

按未加引号的 `;`、`&&`、`||`、`|`、换行切分，逐段判断。引号内的文本不算命令，所以 `git commit -m "rm -rf /"` 不命中。`bash -c`、变量拼接不处理，这不是安全边界，写进 README。

`scope.ts`：`.cw/scope.txt` 每行一个仓库相对路径前缀，`#` 开头和空行忽略。文件存在且有内容时，写入范围外的路径被拒绝。`.cw/` 下的写入不受限制，这个文件本身总是受保护。和 `goal.md` 一样，没有 `project.toml` 时也生效。只拦写工具，bash 旁路和现状一致。

### 5. `inject` 事件

注入发生时写 `{"event":"inject","detail":{"host","version","goal":bool,"check":bool}}`。Codex、Claude Code 在 `SessionStart`；OpenCode 和 pi 每会话第一次。评测读这个事件判断是否真的注入。

### 6. chronicle 事件

`chronicle-event.ts` 按 `agents/steward-board/references/chronicle-layout.md` 写入。默认目录 `~/.agents/chronicle`，**目录存在才写**，不自动创建。回合结束写 `events/<machine>/<id>.json` 和 `evidence/<machine>/<id>.json`，先写临时文件再改名。

`outcome`：通过 `ok`，失败 `failed`，取消 `cancelled`，没有检查 `unknown`。证据：检查报告短文本，或者说明 `gap`。`project` 从 `projects.yaml` 读映射，读不到写 `null`。写入失败不影响主流程。

已知缺口：Claude Code 按 Esc 不触发 `Stop`，所以取消的回合没有事件。

### 7. 待批条数和 gitignore

`pending.ts`：`pendingCount(repo)` 数 `.cw/pending.md` 的条目，格式以 `project-learning` skill 为准。条数大于 0 时，回合结束行附 `待批 N 条`。没有检查结果时单独显示这一行。OpenCode 不为此多花模型调用，所以不显示。

`.gitignore` 建议从 `.cw/` 改成：

```gitignore
/.cw/*
!/.cw/PRACTICES.md
!/.cw/BUGS.md
```

`/cw-setup`、`$cw-setup` 和 README 都按这个说明。

## 验收

每项完成后，在涉及的真实宿主上验证，再提交。模型用最便宜的：Claude Code `haiku`，OpenCode `gl/oc-deepseek-v4.1-flash`，Codex `gpt-5.6-terra`，pi `cpa/claude-haiku-5-5`。全部在临时目录和隔离配置下运行。

## 进度

- [x] 1 缺 `[check]` 提示
- [x] 2 角色成本
- [x] 3 `[auto]` 失败可见
- [ ] 4 高危命令和范围锁定
- [ ] 5 `inject` 事件
- [ ] 6 chronicle 事件
- [ ] 7 待批条数和 gitignore
