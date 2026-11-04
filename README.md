# codex-counterweight

给 Codex 加一个收尾动作：每轮结束前运行项目指定的检查，失败就把输出交回模型修一次；同时拦截对受保护路径的 `apply_patch` 写入，注入一段行为约束，并把模型用量记到 `.cw/meter.jsonl`。再提供五个只读角色工具（探索、两种审查、研究、史官），以及收尾时自动审查、自动汇报和首次改源码前的 PAUSE。是 [pi-counterweight](../pi-counterweight) 的 Codex 版。

## 安装

```sh
codex plugin marketplace add nerdneilsfield/codex-counterweight
codex plugin add codex-counterweight@<marketplace>
```

装完打开 `/hooks`，确认信任 Counterweight 的 hook。TUI 启动时会提示有 hook 待信任；`codex exec` 不提示，未信任的 hook 直接跳过。插件每次更新都要重新确认。

会话里运行 `$cw-setup` 可以检查 hook 是否生效并生成配置。

## 配置

`.cw/project.toml`：

```toml
version = 1

[check]
cmd = ["npm", "test"]
timeout_s = 600

[protect]
paths = ["tests", "docs/spec.md"]
```

`.cw/project.toml` 本身总是受保护。配置每次 hook 都会重新读取，改完立即生效。

## 角色和 `[auto]`

`.cw/codex.toml` 可选，配 Codex 的模型和角色沙箱。`additionalProperties: false`，写错字段整份配置失败：

```toml
[models]                 # 六个角色：explorer review over_review research historian planner
review = "gpt-5.6-terra" # Codex 模型 slug，非空且不含空白

[roles]
sandbox = "read-only"    # 或 "none"，缺省 read-only
```

插件的 MCP server 提供五个工具：`cw_explore`、`cw_review`、`cw_over_review`、`cw_research`、`cw_chronicle`，没配模型的角色调用时返回不可用。每个工具有可选的 `timeout_s`（300 到 1800），超时后返回里给下一档。角色子进程是 `codex exec --ephemeral`，关掉 hook 和插件，默认 `-s read-only`；`sandbox = "none"` 会让角色子进程没有沙箱，`SessionStart` 会提示。

`project.toml` 的 `[auto]` 在 Codex 下生效：

- `review`：每轮结束时工作树有改动，就并行跑 review 和 over_review。有发现则续跑一次，之后只显示；额度与结束检查的续跑分开计。
- `chronicle`：没有审查发现时，把本轮摘要交给史官，更新 `.cw/HISTORY.md`。
- `pause`：每个用户回合第一次对源码的 `apply_patch`（只在根线程）会被拦下一次，planner 读完会话记录给一份计划，计划只是建议。planner 读不到记录、失败或超时都放行。

`[auto]` 打开但 `codex.toml` 没配对应模型时，该项视为关闭，`SessionStart` 提示，检查和保护照常运行。这与 pi 版不同：共用文件里合法的 `[auto]` 不应让 Codex 的检查和保护失效。`.cw/codex.toml` 本身也受保护，非法时检查和保护一起停用，`SessionStart` 和 `Stop` 显示错误。

史官不排队。hook 和 MCP 是不同进程，所以写文档前会再读一次，文档在史官运行期间被改动就不写，返回“请重新汇报”。

## 与 pi 共用

同一份 `.cw/project.toml` 在 pi 和 Codex 下都合法，未知字段照样报错。`[check]`、`[protect]`、`[timeouts]`、`[auto]`、`[router]` 共用；`[models]` 在 Codex 下忽略，模型写在 `.cw/codex.toml`。

## 限制

- 不是安全边界。bash 可以绕过文件保护，只拦 `apply_patch`。
- hook 自身崩溃时 Codex 会放行工具调用。
- 只要配了 `[check]`，每轮结束都会运行检查，包括只是问答的轮次。每轮会显示一行结果，看不到这一行就说明检查没跑，先查 `/hooks`。
- `check.timeout_s` 超过 3570 秒时按 3570 秒运行，并在结果里注明。
- 插件升到 0.2.0 后 hook 有变化，需要在 `/hooks` 里重新信任。
- planner 只关了 shell 和联网，`apply_patch` 有没有关掉没有验证。它只拿到会话记录文本，提示里写明不用工具，这是已知边界。
- MCP 进程的环境是白名单（`HOME LANG LC_ALL LOGNAME PATH SHELL TERM USER`，加上 `.mcp.json` 列出的 `CODEX_HOME`、`OPENAI_API_KEY`）。`[router].api_key_env` 指向别的变量时，闸门按失败处理，也就是照常审查，只是省不掉调用。
- `[router]` 闸门只用于手动调用的 `cw_review` 和 `cw_over_review`，`[auto]` 的审查不经过它。
