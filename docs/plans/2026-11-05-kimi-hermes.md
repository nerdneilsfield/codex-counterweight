# Kimi Code 和 Hermes Agent 实施计划

Plan readiness: ready。

## 结果和范围

本仓库新增两个宿主：Kimi Code 2.5.0 和 Hermes Agent 0.22.7。能力以 `src/core/flow.ts` 为准，共用逻辑不复制。不包括推送、仓库改名、改 pi。

依据：2026-11-05 用真实二进制测得的事件和载荷。Kimi 文档 `https://moonshotai.github.io/kimi-code/`，Hermes 文档在 `~/.hermes/hermes-agent/website/docs/user-guide/features/hooks.md`。

## 已实测

Kimi Code：`KIMI_CODE_HOME` 可隔离。hook 是 `config.toml` 的 `[[hooks]] event/matcher/command/timeout`，也可由插件（`.kimi-plugin/plugin.json`）携带。stdin 是 snake_case JSON。`UserPromptSubmit` 的 stdout 作为 `hook_result` 追加到提示。`Stop` 退出码 2 加 stderr 让模型续跑，每回合一次。`PreToolUse` 用 `permissionDecision:"deny"` 拒绝。工具 `Write {path,content}`、`Edit`、`Bash`。hook 超时最多 600 秒。`session_id` 在所有事件上，`turn_id` 只在 `TurnStarted`。用量在会话 `wire.jsonl` 的 `usage.record`。角色：`-p -m <alias> --output-format stream-json --agent-file`。

Hermes：`HERMES_HOME` 可隔离。三条路线：`config.yaml` 的 shell hook（需同意或 `--accept-hooks`，超时上限 300 秒）、Python 插件（`~/.hermes/plugins/<n>/`，进程内）、gateway hook。`pre_llm_call` 返回 `{"context":...}`，每回合一次。`pre_verify` 只在改过代码时触发，`{"decision":"block","reason"}` 续跑，带 `attempt`。`pre_tool_call` 的 `{"decision":"block","reason"}` 拦截。工具 `write_file {path,content}`、`patch`（含 V4A 多文件）、`terminal {command}`。`on_session_end` 每回合触发，带 `turn_exit_reason`。载荷的 `cwd` 是 Hermes 目录，不是项目目录。hook 在 gateway 进程里运行，调用方环境变量不继承。角色：`hermes -z -m --provider -t --usage-file`。

## 设计

### 共用层改动

- `endCheck` 增加可选的 `limits: {checkTimeoutS, roleTimeoutS}`，缺省是现有值。
- 宿主配置文件名单增加 `kimi.toml`、`hermes.toml`，schema 和 `claude.toml` 相同，只有 `[models]`。
- 角色子进程的递归保护：环境变量 `CW_ROLE=1`，hook 入口看到就直接退出。这是产品机制，不是测试开关。Hermes 的 gateway 不继承环境变量，要实测是否有效；无效时改用该宿主的显式关 hook 手段，都不行就在角色里不用 Hermes 子进程。

### Kimi Code

`src/adapters/kimi/`，打包到 `plugins/kimi-counterweight/`。

- 续跑只有一次，所以 `claim` 包一层：检查修复和审查发现共用一个额度，检查优先。第二个需要续跑的结果只显示。
- 时间预算：hook 超时 600 秒。检查上限 300 秒，角色超时 270 秒，超过时在结果里写明实际值。
- 目标和提示：`UserPromptSubmit` 注入。全量提示只在每会话第一次，目标用现有的变更检测。
- `TurnStarted` 记录 turn，`Stop` 读取。
- 计量：`Stop` 和 `SessionEnd` 读 `wire.jsonl`，按记录去重，方式同 Claude Code 的 transcript。
- 优先用插件打包；若插件 hook 不可用，退回文档说明的 `config.toml` 片段。

### Hermes

`src/adapters/hermes/`，打包到 `plugins/hermes-counterweight/`。

- 先实测 Python 插件路线：`plugin.yaml` 加不超过 40 行的 `__init__.py`，把事件转给 Node 入口。若它没有 300 秒上限且能 block，就用它；否则用 shell hook，检查上限 150 秒，角色超时 120 秒，写明限制。
- 项目根目录：优先取工具路径和 `terminal` 的工作目录；实现时确认插件上下文有没有更可靠的来源。拿不到时不猜，跳过检查并记 `gap`。
- 结束检查只在 `pre_verify` 运行，所以纯问答回合没有检查，写进 README。
- 额度用 `attempt` 加现有 `claim`。
- 回合结束事件和 chronicle 用 `on_session_end` 的 `turn_exit_reason`。
- 计量：实测 `post_api_request` 是否带用量；没有就不记录主模型用量，只记角色的 `--usage-file`，写明缺口。

## 验收

每个宿主跑通：检查和修复一次、路径保护、`goal.md`、高危命令、范围锁定、一个角色工具或角色运行、自动审查、PAUSE、`inject`、待批条数。优先用真实模型：把隔离配置指向本地 opencodex 代理 `http://127.0.0.1:10100/v1`，不复制任何凭据。走不通时用假端点，并在报告里标为“假模型”。TUI 没测的要标出。

## 进度

- [ ] 共用层
- [ ] Kimi Code
- [ ] Hermes
- [ ] 文档
