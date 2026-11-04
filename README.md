# codex-counterweight

给 Codex 加一个收尾动作：每轮结束前运行项目指定的检查，失败就把输出交回模型修一次；同时拦截对受保护路径的 `apply_patch` 写入，注入一段行为约束，并把模型用量记到 `.cw/meter.jsonl`。是 [pi-counterweight](../pi-counterweight) 的 Codex 版，第一版不含角色工具和 `[auto]`。

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

## 与 pi 共用

同一份 `.cw/project.toml` 在 pi 和 Codex 下都合法，未知字段照样报错。`[models]`、`[timeouts]`、`[router]` 可以写，这里接受但不使用；`[auto]` 打开时会在会话开始提示“尚未支持”。

## 限制

- 不是安全边界。bash 可以绕过文件保护，只拦 `apply_patch`。
- hook 自身崩溃时 Codex 会放行工具调用。
- 只要配了 `[check]`，每轮结束都会运行检查，包括只是问答的轮次。每轮会显示一行结果，看不到这一行就说明检查没跑，先查 `/hooks`。
- `check.timeout_s` 超过 3570 秒时按 3570 秒运行，并在结果里注明。
