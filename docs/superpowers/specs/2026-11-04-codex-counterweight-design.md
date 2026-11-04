# codex-counterweight 设计

日期：2026-11-04
目标版本：Codex CLI 0.166.0，Node.js 22.19 或更新版本
参照实现：`../pi-counterweight`（下称 pi 版）

## 意图

Counterweight 给 AI 编程助手加一个收尾动作：回答结束前运行项目指定的检查，失败就把错误交回模型修一次。同时拦截对指定路径的直接写入，注入一段行为约束，记录模型用量。

pi 版已经在用这套设计。用户也用 Codex，真实 session 都是 `danger-full-access` 加 `never`，也就是 Codex 不会替用户把关。本项目把同一套行为带到 Codex。同一个仓库可以同时用 pi 和 Codex。

## 目标

- 第一版：结束检查、文件保护、提示注入、用量计量、`$cw-setup` skill。
- 第二版：六个角色工具、`[auto]`、PAUSE、史官、审查闸门。
- 同一份 `.cw/project.toml` 对 pi 和 Codex 都合法。

## 非目标

- 不做安全边界。bash 能绕过文件保护，与 pi 版相同，只在文档里写清楚。
- 不解析测试输出，只看退出码。
- 不写项目的 `AGENTS.md`。
- 不改 pi 版代码，不抽公共包。
- 不进 OpenAI 公开插件目录。带 hook 的插件没有这个资格。
- 第一版不提供 MCP server。

## 反目标

以下任何一项发生，即使功能跑通也算失败：

- 把一份 pi 能用的 `.cw/project.toml` 改成 pi 加载失败。
- 检查没有得出结论，却报告通过。
- 用户中断或超时后，检查进程还留在后台。
- 没有运行的检查看起来像运行过。hook 未被信任时，用户必须有办法发现。
- 自动续跑超过一次。

## 约束（已实测，Codex 0.166.0，`codex exec`）

- `Stop` 返回 `{"decision":"block","reason":...}` 会续跑一轮，`reason` 成为续跑提示。第二次 `stop_hook_active` 为 `true`，`turn_id` 不变。Codex 自身不限制续跑次数。
- `PreToolUse` 在 `code_mode_only` 模型上同样触发，`tool_name` 是 `apply_patch`，补丁文本在 `tool_input.command`。`permissionDecision: "deny"` 生效。
- 补丁路径可能是相对路径，也可能是绝对路径。一个补丁可以改多个文件，deny 作用于整个补丁。
- `PostModelRequest` 带 `status` 和 `token_usage`，字段包括 `input_tokens`、`cached_input_tokens`、`cache_write_input_tokens`、`output_tokens`、`reasoning_output_tokens`。每次模型请求一条。
- 未信任的 hook 被静默跳过，输出里没有搜到提示。
- 插件 hook 里有 `PLUGIN_ROOT`、`PLUGIN_DATA`，cwd 是项目目录。
- 插件更新要改 `version`，再执行 `codex plugin marketplace upgrade` 和 `codex plugin add`。
- 这台机器 AppArmor 限制 user namespace，`read-only` 和 `workspace-write` 沙箱不可用。测试 `apply_patch` 成功路径时要绕过沙箱。
- Codex 不允许在 `/tmp` 下放 `CODEX_HOME`。

源码确认（未实测）：

- hook 进程运行在新 session 里，超时或取消时 Codex 对其进程组发 `SIGKILL`（`codex-rs/hooks/src/engine/command_runner.rs`，`codex-rs/utils/pty/src/process_group.rs`）。hook 来不及清理任何东西。
- `Stop` 只在根线程触发，子代理走 `SubagentStop`（`codex-rs/core/src/hook_runtime.rs`）。
- 插件 manifest 没有 `agents` 字段（`codex-rs/core-plugins/src/manifest.rs`）。

## 用户已决定的事

- 分两版，范围如“目标”所列。
- `review` 和 `over_review` 保持两个角色，不合并。
- PAUSE 和史官推迟到第二版，不删除。
- 共用 `.cw/project.toml`，Codex 专属配置放 `.cw/codex.toml`。
- 角色只走 MCP 加 `codex exec` 一条路，不用原生 `spawn_agent`。
- 角色沙箱是显式配置，默认 `read-only`，这台机器设 `none`，不自动降级。
- 提示放 `SessionStart`，不放 `AGENTS.md`。

## 第一版

### 仓库布局

```text
src/core/                     从 pi 版复制：config、check、process、protect、paths、meter、gitstate、cwfile
src/roles/prompts.ts          只留 sessionSection，去掉角色段落
src/adapters/codex/hook.ts    唯一入口，按 hook_event_name 分发
src/adapters/codex/patch.ts   从补丁文本取路径
test/
plugins/codex-counterweight/
  .codex-plugin/plugin.json
  hooks/hooks.json
  skills/cw-setup/SKILL.md
  dist/hook.js                打包产物，提交进仓库
.agents/plugins/marketplace.json
```

这个 marketplace 加 `plugins/<name>` 的结构已经实测能安装。

`dist/hook.js` 用 esbuild 打成单文件，依赖全部打进去。插件安装不会运行 `npm install`，所以 `dist/` 必须提交。hook 命令是 `node "$PLUGIN_ROOT/dist/hook.js"`。

### 配置

只读 `.cw/project.toml`，校验规则与 pi 版一致，未知字段照样报错，这样一份文件在 Codex 下合法，在 pi 下也合法。

有一处放宽：`[auto]` 打开时 pi 版要求对应的 `[models]` 存在，Codex 版第一版不实现 `[auto]`，所以不做这项校验，只在 `SessionStart` 提示一行“`[auto]` 尚未支持”。`[models]`、`[timeouts]`、`[router]` 接受但不使用。

项目根用 `repoToplevel(cwd)`，不是 git 仓库时用 cwd。

hook 是一次性进程，每次都重新读配置，所以改动在下一次 hook 就生效，不用重启。这和 pi 版不同，pi 版在会话开始时读一次。

配置缺失：不检查、不拦截，提示和计量照常。配置非法：同样不检查、不拦截。错误在 `SessionStart` 和 `Stop` 都用 `systemMessage` 显示。

### SessionStart

matcher 是 `^(startup|clear|compact)$`。实测 `resume` 会再注入一份，而恢复的历史里已经有这段，所以不匹配 `resume`。

- `additionalContext`：去掉角色段落后的 `sessionSection()`，加一行标记 `Counterweight <version> active`。
- `systemMessage`：配置错误或 `[auto]` 提示。

标记有两个用途：确认 hook 真的跑了，以及让 `$cw-setup` 判断信任状态。

没有配置时也注入，与 pi 版相同。

### Stop

```text
读配置 → 非法：systemMessage 显示“配置非法，未运行检查”，退出
       → 没有 [check]：退出
       → 运行检查
           通过：systemMessage 显示报告
           失败且 stop_hook_active=false：decision=block，reason=报告
           失败且 stop_hook_active=true：systemMessage 显示最终报告，不再续跑
```

每次都记一条 `check` 事件到 `.cw/meter.jsonl`，格式与 pi 版相同。

不用状态文件：第一版只有检查会续跑，`stop_hook_active` 一位就够。

只要配了 `[check]`，每轮结束都显示一行结果，通过也显示。这是用户发现检查没跑的主要办法：看不到这一行，就是没跑。插件更新后信任失效时，靠的也是它。

报告用 pi 版的 `renderCheckReport`，尾部限制不变（每条流 80 行或 16 KiB）。最后一次失败传 `final: true`。

**检查进程不能脱离 hook 的进程组。** pi 版的 `runProcess` 用 `detached: true` 单独建组，Codex 杀 hook 时杀不到它，`SIGKILL` 也让 hook 来不及转发。这里要改写，具体做法留给实现者，验收标准是：对 hook 进程组发 `SIGKILL` 后，检查命令及其子进程全部消失；到达 `check.timeout_s` 时，检查进程组先收 `SIGTERM`，5 秒后收 `SIGKILL`，hook 还能输出结果。

`hooks.json` 里的 `timeout` 是写死的，而 `check.timeout_s` 按项目配置，所以 hook 的 `timeout` 要留足。默认设 3600 秒。`check.timeout_s` 超过 3570 秒时，配置仍然合法（pi 能用的文件这里也必须能用），检查按 3570 秒运行，并在结果里写明实际超时。

`statusMessage` 设为“运行结束检查”。

### PreToolUse

matcher 是 `^apply_patch$`，超时 10 秒。

1. 配置缺失或非法：放行。
2. 从 `tool_input.command` 取出所有 `*** Add File:`、`*** Update File:`、`*** Delete File:`、`*** Move to:` 的路径。
3. 相对路径按 `input.cwd` 解析，再用 `resolveWriteTarget` 和 `isProtected` 判断，语义与 pi 版相同：符号链接跟到目标，悬空链接拒绝，仓库外路径拒绝，`.cw/project.toml` 总是受保护。
4. 任何一个路径命中，deny 整个补丁，理由里列出命中的路径。
5. 配置有效但解析不出路径：deny。解析不了的补丁无法核对。

hook 自身崩溃时，Codex 会放行工具调用。这是已知的 fail-open，写进 README。

### PostModelRequest

`status` 为 `completed` 且有 `token_usage` 时写一条 `usage`：

| meter 字段 | 来源 |
| --- | --- |
| `session` | `session_id` |
| `model` | `model` |
| `input` | `input_tokens` 减 `cached_input_tokens` |
| `output` | `output_tokens` |
| `cache_read` | `cached_input_tokens` |
| `cache_write` | `cache_write_input_tokens` |
| `cost_total` | `null` |

实测 `input_tokens` 包含缓存部分（11932 里有 11776 是缓存），所以要减，让 `input` 加 `cache_read` 等于总输入。pi 版 `input` 的语义没有核实，实现时对照 pi-ai 的 usage 处理确认。两边不一致就在这里调整。计量只供观察，这项不阻塞发布。

超时 5 秒。写失败时静默退出，不影响主流程。每次模型请求记一条，不做汇总。

### `$cw-setup`

只有 `SKILL.md`，没有配套程序。流程：

1. 看上下文里有没有 `Counterweight <version> active`，版本要和 `SKILL.md` 里写的一致（构建时写入）。没有或版本不符，就告诉用户 hook 未被信任，让用户打开 `/hooks` 确认后重开会话。这项只能证明 `SessionStart` 跑过，每个 hook 是否分别需要信任要实测。
2. 问检查命令和要保护的路径，建议先手动跑一遍命令。
3. 文件不存在：写 `.cw/project.toml`。文件已存在：`PreToolUse` 会拒绝修改，这是保护的本意，所以不改写，也不走 shell 绕过，而是把建议的改动显示给用户，由用户手动编辑。
4. 提示把 `.cw/` 加进 `.gitignore`，由用户决定。
5. 提示配置在下一次 hook 就生效，不用重启。

### 安装

```sh
codex plugin marketplace add nerdneilsfield/codex-counterweight
codex plugin add codex-counterweight@<marketplace>
```

装完到 `/hooks` 确认信任。插件每次更新都要重新确认。

### 测试

- 单元测试：`patch.ts`、hook 分发。输入用实测的 hook JSON 样本，通过 stdin 喂给 `dist/hook.js`，断言 stdout。
- 进程组：按“Stop”一节的两条验收标准写测试。
- 兼容：一份 pi 版合法的配置，在这里也合法；已确认的未知字段照样报错。
- 真实 Codex：手动脚本，用 `$HOME` 下的临时 `CODEX_HOME`，不进 CI。

## 开工前要实测

第一版动手前先验证这几项。结果不符时，改设计再继续：

1. `source=compact` 时 `additionalContext` 是否真的重新注入。
2. ~~`resume` 时提示会不会重复注入~~：会，已用 matcher 排除。
3. TUI 里 `/hooks` 的信任流程，信任是按插件还是按每个 hook；`statusMessage` 和 `Stop` 的 `systemMessage` 是否显示。后者是用户发现检查没跑的主要办法，不显示就要改设计。
4. 运行中的 `Stop` hook 被用户中断时，进程组是否被杀。
5. `Stop` hook 的 `timeout` 有没有上限，3600 秒是否有效。

## 第二版方向

这部分不是实施规格，第一版做完后另写设计。已定的方向：

- `.cw/codex.toml`：只放 `[models]`（Codex 模型 slug）和 `[roles] sandbox`。不复制共用字段。Codex 版把它和 `project.toml` 一起保护。诊断时显示哪个文件生效。
- MCP：`plugins/codex-counterweight/.mcp.json` 用 stdio，`"cwd": "."`，`tool_timeout_sec` 大于 1800。声明 `codex/sandbox-state` capability，从 `_meta` 取 `sandboxCwd`。
- 角色子进程：`codex exec --ephemeral --disable hooks --disable plugins -m <model> -c developer_instructions=...`。不能用 `--ignore-user-config`，代理配置在用户配置里。
- 取消：MCP server 处理 `notifications/cancelled`，自己管截止时间并杀子进程。
- 状态：hook 是一次性进程，额度、PAUSE 和史官队列按 `session_id` 加 `turn_id` 存到 `PLUGIN_DATA`。`stop_hook_active` 分不清检查续跑和审查续跑。
- 自动审查排在检查定稿后，与 pi 版相同，要有独立的时间预算。
- PAUSE 读 `transcript_path` 的 rollout JSONL，读不到就放行。
- 模型满载等错误如实返回。
- 已知风险：同一项目同时开 pi 和 Codex 跑史官，可能丢一次 `HISTORY.md` 更新。

## 留给实现者

- 检查进程组的具体实现，满足“Stop”一节的验收标准即可。
- `src/core` 复制后的裁剪和类型调整。
- esbuild 的具体配置，`dist/` 与源码一致的校验方式。
- 目录内部的文件拆分。

## 设计者的判断（用户没有逐条确认）

- 复制 `src/core`，不抽公共包。
- 第一版不用状态文件，`stop_hook_active` 足够。
- `.cw/codex.toml` 推迟到第二版，第一版没有字段要放。
- 砍掉 `/cw-version`，版本写在 `SessionStart` 标记里。
- hook 信任靠上下文标记和每轮的检查结果行发现，不写诊断程序。文件保护没有这种逐次可见的信号，只能靠 `$cw-setup` 和 `/hooks` 确认。
- 配置每次重读，不做会话快照。
- `$cw-setup` 不修改已存在的配置，由用户手动改。
- `check.timeout_s` 过大时夹到 3570 秒并写明，不算配置错误。
- `input` 记录不含缓存的部分。
- `Stop` hook 超时默认 3600 秒。
- 解析不出路径的补丁拒绝。
