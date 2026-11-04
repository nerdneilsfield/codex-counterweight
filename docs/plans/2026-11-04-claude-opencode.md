# Claude Code 和 OpenCode v2 实施计划

Plan readiness: ready。

## 结果和范围

本仓库成为多宿主稳定线：同一份 `src/core` 和 `src/roles`，加上 `src/adapters/{codex,claude,opencode}`。Claude Code 和 OpenCode 提供 Codex 版的全部能力：结束检查、路径保护、提示注入、计量、五个角色工具、`[auto]`、PAUSE、审查闸门、setup。

不包括：pi（独立试验田，不并入）、仓库改名（等用户试完 Codex 版）、推送。

已有改动：无，工作树干净。
授权：已授权实现和本地提交。推送另行确认。

## 已实测的事实

### Claude Code 2.1.318

- `Stop` 输入：`session_id`、`transcript_path`、`cwd`、`prompt_id`、`stop_hook_active`、`last_assistant_message`、`hook_event_name`。没有 `turn_id`，用 `prompt_id`，它在 `UserPromptSubmit` 和同一回合的多次 `Stop` 上不变。
- `{"decision":"block","reason":...}` 续跑。`systemMessage` 显示给用户，print 模式的 `--output-format json` 里看不到。
- `PreToolUse`：`Edit {file_path,old_string,new_string,replace_all}`、`Write {file_path,content}`、`NotebookEdit {notebook_path,cell_id,new_source}`，路径是绝对路径。`hookSpecificOutput.permissionDecision: "deny"` 有效。子代理的调用带 `agent_id`。
- Esc 和 hook 超时都发 `SIGTERM`，detached 子进程也消失。看门进程保留，不为这个宿主分支。
- 子进程：`claude -p --model <m> --settings '{"disableAllHooks":true}' --tools Read,Grep --output-format json`，提示走 stdin。`--tools` 是变长参数，提示放后面会被吞。210 KB 的 stdin 可用。子进程不触发 hook。
- `--system-prompt` 有效。`--tools ""` 去掉全部内置工具。`--tools` 不影响 `mcp__*` 工具，要用 `--strict-mcp-config` 关掉，这项待验证。
- JSON 输出：`result`、`is_error`、`subtype`、`total_cost_usd`、`usage.{input_tokens,output_tokens,cache_read_input_tokens,cache_creation_input_tokens}`。
- `Stop` 时 transcript 可能缺最后一条。助手行按内容块拆分，`message.id` 重复，`usage` 也重复，按 id 去重。回答用 `last_assistant_message`。
- 插件 hook 在 print 模式下运行。TUI 只有通用的项目信任对话框。

### OpenCode v2.2.5

- 插件：`export default Plugin.define({ id, async setup(ctx) {} })`，`@opencode/plugin` 由宿主解析。进程内运行。
- `ctx.session.hook("experimental.idle", ev)`，`ev = {sessionID, background[]}`；`ctx.session.synthetic({sessionID, text})` 续跑，不限次数，循环要自己防。子会话用 `ctx.session.get({sessionID}).parentID` 识别。回调没有 abort，Esc 触发事件 `session.execution.interrupted`。
- 插件文本和 synthetic 文本都不显示给用户，只显示模型的回复。
- `ctx.tool.hook("execute.before", ev)`，`ev = {tool, sessionID, agent, messageID, id, input}`，`throw new Error(msg)` 拒绝，模型看到原文。工具：`write {path,content}`、`edit {path,oldString,newString,replaceAll?}`、`patch {patchText}`。
- `ctx.session.hook("context", ev)`：`ev.system.push({type:"text", text})`，每次模型调用都要推，`ev.sessionID` 和 `ev.model` 可用。
- `ctx.event.subscribe()`：`session.step.ended`，`data: {sessionID, cost, tokens:{input,output,reasoning,cache:{read,write}}}`，没有模型字段。
- 工具：`ctx.tool.transform(ed => ed.add({name, description, input, options:{codemode:false}, execute(input, c)}))`，`c` 带 `sessionID`、`signal`。
- 子会话：`ctx.session.create({parentID, model:{providerID,id}, permissions:[...]})`、`prompt({sessionID,text})`、`wait({sessionID})`、`context({sessionID})`，取最后一条 `assistant` 的 `content[]` 里的 `text`。`create` 没有系统提示字段，用 `context` hook 按子会话 id 推。子会话不随 abort 停止，要调用 `ctx.session.interrupt({sessionID})`。子会话能看到插件工具，要防递归。
- 命令：`ctx.command.transform(ed => ed.add({name, description, execute(inv)}))`。
- 模型 id 按第一个斜杠切分，id 里可以再有斜杠。

## 设计

### 共用层

把 `src/adapters/codex/hook.ts` 里与宿主无关的流程移到 `src/core/flow.ts`，三个宿主共用：

- `checkPaths(root, cwd, project, paths)`：返回拒绝理由或 null。解析不出路径时拒绝，异常时拒绝。
- `endCheck({root, project, session, turn, runner, signal})`：运行检查和自动任务，返回 `{continueWith: string | null, report: string | null}`。`continueWith` 非空表示要续跑。各宿主把它翻译成自己的输出。
- `pausePlan({...})`：返回计划文本或 null，失败返回 null。

`RoleContext` 增加 `runner: RoleRunner`，取代 `run.ts` 里写死的 `codex exec`：

```ts
interface RoleRequest { role: RoleName; workRoot: string; model: string; message: string; sandbox: "read-only" | "none"; signal?: AbortSignal; timeoutMs: number }
interface RoleRun { answer: string | null; error: string | null; usage: UsageSample[]; timedOut: boolean; cancelled: boolean }
type RoleRunner = (request: RoleRequest) => Promise<RoleRun>;
```

`UsageSample` 增加 `costTotal: number | null`。超时规则和 `callRole`、`chronicle`、`runAndMeter` 保持共用。`run.ts` 拆成共用的超时规则和 `src/adapters/codex/runner.ts`。

这层抽象有三个现实调用方，并且只抽流程，不抽事件模型：每个宿主自己解析输入、翻译输出。

### 配置

`loadProjectConfig(repo, hostFile)`，`hostFile` 是 `codex.toml`、`claude.toml` 或 `opencode.toml`，schema 相同。`[roles] sandbox` 只对 Codex 有意义，另外两个文件不接受这个小节。`isProtected` 保护这三个文件和 `project.toml`。

模型写法：Claude Code 用别名或完整 id，OpenCode 用 `provider/model`。两者都放各自文件，不复用 `project.toml` 的 `[models]`，三个宿主规则一致。

### 回合状态

`turnstate.ts` 的数据目录改成参数或读 `PLUGIN_DATA ?? CLAUDE_PLUGIN_DATA`。Claude Code 的 turn 用 `prompt_id`。OpenCode 在进程内，用 `Map<sessionID, {repair, findings, pause, prompt}>`，在 `session.hook("prompt")` 里重置，`endCheck` 通过一个 `claim` 函数参数拿到额度，这样两种存储都能用。

### Claude Code

`src/adapters/claude/hook.ts`，打包到 `plugins/claude-counterweight/dist/hook.cjs`。

| 事件 | 动作 |
| --- | --- |
| `SessionStart`（`startup|clear|compact`） | `additionalContext`：提示和标记行 |
| `UserPromptSubmit` | 保存 `prompt` |
| `PreToolUse`（`^(Edit|Write|NotebookEdit)$`） | 路径保护，然后 PAUSE；`agent_id` 存在时跳过 PAUSE |
| `Stop` | 先计量，再 `endCheck`，翻译成 `decision`/`systemMessage` |
| `SessionEnd` | 再计量一次，然后清理 session 目录 |

计量：没有用量 hook，所以读 `transcript_path`。只取 `type == "assistant"` 的行，按 `message.id` 去重。已记录的 id 存在 session 目录，`Stop` 和 `SessionEnd` 各扫一次，所以 `Stop` 时缺的最后一条会在下一次记上。`cost_total` 为 `null`。失败不影响主流程。

`src/adapters/claude/runner.ts`：见上面的 argv，加 `--strict-mcp-config`（验收时确认）。普通角色 `--tools Read,Grep`，planner `--tools ""`，`--system-prompt` 传角色提示。`sandbox` 不适用，角色限制靠工具白名单，比 Codex 强。`is_error` 为真或输出不可解析时报失败，错误信息带 `result` 或 stderr 尾部。

**角色走 MCP 加 `claude -p`，不用插件 subagent。** 理由：subagent 的模型写死在 agent 文件，无法按项目配置 `[models]`；用量和费用拿不到；`[auto]` 本来就要 `claude -p`，用一条路径避免两套实现。`mcp.ts` 共用，仓库根目录的解析作为参数：Codex 取 `sandboxCwd`，Claude Code 取 `CLAUDE_PROJECT_DIR`，不可用时取 `process.cwd()`。实现时确认这个变量对 MCP 进程可见。

`plugins/claude-counterweight/`：`.claude-plugin/plugin.json`、`hooks/hooks.json`、`.mcp.json`、`skills/cw-setup/SKILL.md`、`dist/`。hook 命令用 `${CLAUDE_PLUGIN_ROOT}`。`Stop` 超时 7200 秒，`PreToolUse` 1830 秒。仓库根加 `.claude-plugin/marketplace.json`，用 `claude plugin validate` 校验。

### OpenCode

`src/adapters/opencode/index.ts`，ESM，`@opencode/plugin` 和 `effect` 外置。打包到 `plugins/opencode-counterweight/index.js`。

| 注册 | 动作 |
| --- | --- |
| `session.hook("context")` | 根会话推提示；角色子会话推角色提示；记下 `model` |
| `session.hook("prompt")` | 重置该会话的额度，保存请求原文 |
| `tool.hook("execute.before")` | `write`、`edit`、`patch` 的路径保护和 PAUSE，子会话跳过 |
| `session.hook("experimental.idle")` | 根会话运行 `endCheck`，`continueWith` 交给 `synthetic` |
| `event.subscribe` | `session.step.ended` 写计量，`cost_total` 用 `cost`；`session.execution.interrupted` 触发该会话的 `AbortController` |
| `tool.transform` | 五个工具，`options: {codemode:false}` |
| `command.transform` | `/cw-setup`，用 `synthetic` 把 setup 说明交给模型 |

`patch` 复用 `patchPaths`。相对路径按插件上下文的目录解析，实现时看类型确认字段名。

**用户可见性有退让。** OpenCode 插件没有给用户显示文字的通道。设计：检查失败第一次，`synthetic` 让模型修；第二次失败，`synthetic` 一次，要求模型原样转告用户，不再修改，这一轮消耗一次模型调用；通过时不显示，只写 `.cw/meter.jsonl`。README 明确写出：OpenCode 下看不到每轮通过的提示，判断检查是否运行要看 `.cw/meter.jsonl`。

`src/adapters/opencode/runner.ts`：`create` 子会话，`permissions` 普通角色拒绝 `edit`、`shell`，planner 再拒绝其余工具；`prompt`、`wait`、`context` 取回答。`signal` 中止或超时时调用 `interrupt`。工具的 `execute` 在子会话里返回不可用，防递归。用量来自事件，子会话的 `session.step.ended` 由同一个订阅记录，所以 `run.usage` 为空，不重复记账。

`[roles] sandbox` 不适用，只读由 `permissions` 强制。

安装：`opencode plugin add` 不确定支持子目录，所以根 `package.json` 的 `exports` 指向 `plugins/opencode-counterweight/index.js`，让 `github:nerdneilsfield/codex-counterweight` 直接可用。根 `package.json` 保持 `private: true`，这一点要在验收时确认不影响 Arborist 安装。

## 验收

| ID | 行为 | 任务 | 验证 | 期望 |
| --- | --- | --- | --- | --- |
| B1 | Codex 行为不变 | T1 | 现有 34 个测试，真实 Codex 冒烟 | 全过 |
| B2 | 三个宿主文件各自加载，且都受保护 | T1 | 测试 | 符合 |
| B3 | Claude 检查、保护、PAUSE、自动审查、计量去重 | T2 | 测试（假 `claude`） | 符合 |
| B4 | OpenCode 的同样行为 | T3 | 测试（假 ctx） | 符合 |
| B5 | 真实 Claude Code 全流程 | T5 | 主代理 `--plugin-dir` 验收 | 符合 |
| B6 | 真实 OpenCode 全流程，含 `opencode plugin add` | T5 | 主代理用临时 `XDG_CONFIG_HOME` 验收 | 符合 |

## 任务

每个任务完成后运行 `npm run typecheck` 和 `npm test`，检查退出码，通过后提交。

1. **T1 共用层。** `flow.ts`、`RoleRunner`、配置的 `hostFile`，Codex 改用它们，行为不变。Codex 的 `plugin.json` 版本升到 0.2.1。
2. **T2 Claude Code。** 适配层、runner、transcript、插件目录、marketplace、构建入口。
3. **T3 OpenCode。** 适配层、runner、插件目录、`exports`、构建入口。
4. **T4 文档。** 两份 README 改成多宿主：安装、宿主差异表、各宿主限制。`docs/` 里的设计文档不改。
5. **T5 真实验收。** 主代理执行。

## 进度

- [x] T1
- [x] T2
- [x] T3
- [x] T4
- [x] T5

恢复方式：看 `git log` 和本节勾选状态，从第一个未完成任务继续。

## 验收记录（2026-11-04）

Claude Code 2.1.318，`claude -p --plugin-dir`，模型 haiku：检查修复、路径保护、`cw_explore`、`cw_chronicle`、自动审查续跑一次、PAUSE、杀进程后无角色残留，全部通过。`CLAUDE_CONFIG_DIR` 隔离下 `marketplace add` 和 `install` 从本地路径成功。

OpenCode 2.2.5，`opencode run --standalone` 和 TUI：检查修复、最终失败转告一次且不循环、路径保护、角色工具、自动审查、PAUSE、Esc 无残留，全部通过。`opencode plugin add` 用 `git+file` 成功；项目配置引用 Git 规格后插件实际加载运行。

验收中修复两处：被取消的检查曾被算作失败并消耗修复额度；`build` 脚本会让 npm 在 Git 安装时跑完整构建，改名为 `bundle`。

未验证：Claude Code TUI 的中断和可见性；Claude Code 从 GitHub 安装；OpenCode 用 `github:` 规格安装（远端尚未包含这些提交）；`--strict-mcp-config` 对 `mcp__*` 工具的实际效果；OpenCode 下 role 子会话的 token 只来自事件，`tokens` 字段为 0。
