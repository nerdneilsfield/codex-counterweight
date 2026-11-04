# codex-counterweight

[English](README.md) | 简体中文

[![Version](https://img.shields.io/badge/version-0.2.0-blue)](plugins/codex-counterweight/.codex-plugin/plugin.json)
[![License: MIT](https://img.shields.io/github/license/nerdneilsfield/codex-counterweight)](LICENSE)
[![Tested with Codex CLI 0.166.0](https://img.shields.io/badge/tested%20with-Codex%20CLI%200.166.0-412991)](https://github.com/openai/codex/releases/tag/rust-v0.166.0)
[![Node.js >= 22.19](https://img.shields.io/badge/node-%3E%3D22.19-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-7.0-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Tested on Linux](https://img.shields.io/badge/tested%20on-Linux-FCC624?logo=linux&logoColor=black)](#使用限制)
[![Last commit](https://img.shields.io/github/last-commit/nerdneilsfield/codex-counterweight)](https://github.com/nerdneilsfield/codex-counterweight/commits)
[![Issues](https://img.shields.io/github/issues/nerdneilsfield/codex-counterweight)](https://github.com/nerdneilsfield/codex-counterweight/issues)

codex-counterweight 是一个 Codex CLI 插件，用来强制执行项目的结束检查。每轮结束时，插件运行你配置的命令。命令失败时，插件把输出交回模型一次，模型再用一轮修复。第二次失败只报告给你，不再重试。

插件还会拒绝对受保护路径的 `apply_patch` 写入，向每个会话注入一段工作约束，并记录模型用量。可选的角色工具用单独的模型做代码探索、审查、研究、规划和项目历史记录。

这个插件用来减少模型的无意失误，不是安全边界：shell 命令仍然能写入受保护路径。详见[使用限制](#使用限制)。

它是 [pi-counterweight](https://github.com/nerdneilsfield/pi-counterweight) 的 Codex 版本，两者可以共用一份 `.cw/project.toml`。

## 目录

- [环境要求](#环境要求)
- [快速开始](#快速开始)
- [插件做什么](#插件做什么)
- [配置](#配置)
- [角色工具](#角色工具)
- [自动运行](#自动运行)
- [与 pi 共用 `.cw`](#与-pi-共用-cw)
- [使用限制](#使用限制)
- [常见问题](#常见问题)
- [开发](#开发)

## 环境要求

- Codex CLI。当前版本在 Linux 上用 0.166.0 测试过，其他版本和平台未测试。
- Node.js 22.19 或更新版本，且 `PATH` 上能找到 `node`。
- Git。插件用 Git 工作树根目录定位 `.cw/`；不在 Git 仓库里时，使用当前目录。

## 快速开始

下面在一个新建的练习目录里运行语法检查，不需要现成的项目。

1. 添加 marketplace 并安装插件：

   ```sh
   codex plugin marketplace add nerdneilsfield/codex-counterweight
   codex plugin add codex-counterweight@codex-counterweight
   ```

2. 创建练习仓库：

   ```sh
   mkdir -p ~/counterweight-demo/.cw
   cd ~/counterweight-demo
   git init
   ```

3. 创建 `.cw/project.toml`，内容如下：

   ```toml
   version = 1

   [check]
   cmd = ["node", "--check", "hello.js"]
   ```

4. 在该目录启动 Codex：

   ```sh
   codex
   ```

5. Codex 显示 **Hooks need review** 时，查看并信任这些 hook。信任之前，插件不会运行。

6. 向 Codex 发送以下请求：

   ```text
   Create hello.js that prints Hello, Counterweight!
   ```

这一轮结束时，Codex 显示类似下面这行的报告：

```text
[counterweight] 结束检查通过：`node --check hello.js` 退出码 0（0.1s）
```

用到自己的项目时，把 `cmd` 换成会自行退出的命令，例如 `["npm", "test"]`。也可以在 Codex 会话里运行 `$cw-setup`，它会检查 hook 是否生效，并帮你写这个文件。

## 插件做什么

插件在以下 Codex hook 事件上工作。

| 事件 | 动作 | 没有 `.cw/project.toml` 时 |
| --- | --- | --- |
| 会话开始、`/clear`、压缩 | 注入工作约束。 | 相同 |
| 用户提交请求 | 保存请求原文，供自动审查使用。 | 相同 |
| `apply_patch` | 拒绝写入受保护路径；可选地在第一次改源码前暂停。 | 放行所有写入 |
| 模型响应 | 把 token 用量追加到 `.cw/meter.jsonl`。 | 相同 |
| 回合结束 | 运行检查，然后运行已开启的自动任务。 | 不做任何事 |

其中两项对所有启用了插件的仓库都生效，即使没有配置文件：

- 注入的约束会改变模型的行为。它要求模型用中文直接作答，并避免添加当前需求用不到的抽象。原文在 [`src/roles/prompts.ts`](src/roles/prompts.ts)。
- 插件会在每个仓库里创建 `.cw/meter.jsonl`。如果不想跟踪这个文件，把 `.cw/` 加入该仓库的 `.gitignore`。

### 结束检查

插件在每个正常结束的回合运行检查，只回答问题的回合也会运行，所以要选耗时可以接受的命令。结果只看退出码。命令在仓库根目录运行，不经过 shell，因此 `npm test && npm run build` 不是一条合法的命令。需要组合多个检查时，把它们写进脚本。

检查失败时，插件把退出码和每条输出流最多 80 行或 16 KiB 的内容交回模型，Codex 继续这一轮。每轮有一次这样的重试机会。再次失败时，插件显示结果并结束。

检查超时按失败处理。插件向检查的进程组发送 `SIGTERM`，5 秒后发送 `SIGKILL`。如果你在检查运行时中断回合，Codex 会杀掉 hook，看门进程随后杀掉检查进程。被中断的检查不产生结果。

### 受保护路径

配置加载成功后，`.cw/project.toml` 和 `.cw/codex.toml` 总是受保护。只要补丁中有一个路径受保护、通过符号链接指向受保护路径，或位于仓库之外，插件就拒绝整个补丁。解析不出路径的补丁也会被拒绝。

## 配置

配置放在 `.cw/` 下的两个文件里。Codex hook 在每个事件上都读取这两个文件，因此改动从下一个事件开始生效，不需要重启。任一文件出现未知字段，整份配置都非法。配置非法时，检查和路径保护都会停止，Codex 在会话开始和每轮结束时显示错误。

### `.cw/project.toml`

这个文件与 pi 共用。除 `version` 外，所有小节都可选。

```toml
version = 1

[check]
cmd = ["npm", "test"]
timeout_s = 600
env = { CI = "1" }

[protect]
paths = ["tests", "vitest.config.ts"]

[timeouts]
review = 600

[auto]
review = false
chronicle = false
pause = false

[router]
url = "http://localhost:11434/v1/systemone"
model = "nimble"
```

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `version` | 整数 | 必填 | 必须为 `1`。 |
| `check.cmd` | 字符串数组 | `[check]` 中必填 | 程序及其参数，不经过 shell 运行。 |
| `check.timeout_s` | 整数 | `600` | 检查超时，单位为秒。超过 3570 时按 3570 运行，并在报告中写明实际值。 |
| `check.env` | 字符串表 | 空 | 检查使用的额外环境变量。 |
| `protect.paths` | 字符串数组 | `[protect]` 中必填 | 相对于仓库根目录的文件或目录。不接受通配符、绝对路径、`..` 和 `.cw` 下的路径。 |
| `timeouts.<role>` | 整数 | `research` 为 `1800`，其余为 `300` | 角色的默认超时，单位为秒，范围 300 到 1800。 |
| `auto.review` | 布尔值 | `false` | 见[自动运行](#自动运行)。 |
| `auto.chronicle` | 布尔值 | `false` | 见[自动运行](#自动运行)。 |
| `auto.pause` | 布尔值 | `false` | 见[自动运行](#自动运行)。 |
| `router.url` | 字符串 | `[router]` 中必填 | 决策模型的接口地址。 |
| `router.model` | 字符串 | `[router]` 中必填 | 决策模型名称。 |
| `router.api_key_env` | 字符串 | 无 | 存放 API key 的环境变量名。见[使用限制](#使用限制)。 |
| `router.timeout_ms` | 整数 | `5000` | 请求超时，单位为毫秒。 |
| `router.skip_below` | 数值 | `0.1` | 模型判定有问题的概率不高于此值时，跳过审查。 |
| `router.audit_rate` | 数值 | `0.1` | 被跳过的审查中，仍然运行的比例。 |

这个文件的 `[models]` 小节属于 pi，Codex 会忽略它。

### `.cw/codex.toml`

这个文件可选，存放只对 Codex 生效的设置。

```toml
[models]
explorer = "gpt-5.6-terra"
review = "gpt-5.6-terra"
over_review = "gpt-5.6-terra"
research = "gpt-5.6-terra"
historian = "gpt-5.6-terra"
planner = "gpt-5.6-terra"

[roles]
sandbox = "read-only"
```

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `models.<role>` | 字符串 | 无 | 该角色使用的 Codex 模型名称。没有配置模型的角色不可用。 |
| `roles.sandbox` | `"read-only"` 或 `"none"` | `"read-only"` | 角色子进程的沙箱。 |

`"none"` 让角色子进程带 `--dangerously-bypass-approvals-and-sandbox` 运行，模型如果尝试写文件，角色就能写入。设置这个值后，Codex 会在会话开始时提示。只在 Codex 沙箱无法启动的机器上使用 `"none"`。插件不会自动退回到 `"none"`。

Linux 上的 Codex 沙箱依赖非特权 user namespace。如果 `kernel.apparmor_restrict_unprivileged_userns` 为 `1`，`bubblewrap` 无法启动，只读角色也读不了文件。

## 角色工具

插件的 MCP server 向模型提供五个工具。每个工具启动一个一次性的 `codex exec` 子进程，子进程关闭了 hook 和插件。每个工具都接受可选的 `timeout_s`，范围 300 到 1800。超时后，返回结果会给出下一次可用的值。

| 工具 | 输入 | 结果 |
| --- | --- | --- |
| `cw_explore` | `question` | 定位代码，并给出 `路径:行号`。 |
| `cw_review` | `request`、`diff` | 报告这次改动做错的地方。 |
| `cw_over_review` | `request`、`diff` | 报告这次改动中没有当前需求支撑的内容。 |
| `cw_research` | `question` | 回答读代码后仍定不下来的问题。 |
| `cw_chronicle` | `report` | 把汇报并入后，重写 `.cw/HISTORY.md`。 |

审查者和史官可以不给结果，而是回复 `ASK:` 加问题。模型回答后再次调用工具。这种情况下史官不写文件。

史官写入前会再次读取 `.cw/HISTORY.md`。如果文件在运行期间发生变化，史官放弃这次结果，工具要求模型重新汇报。hook、MCP 和 pi 同时运行时都按这条规则处理。

工具调用和角色用量都记录在 `.cw/meter.jsonl`。

## 自动运行

默认由模型决定是否调用角色工具。`[auto]` 的字段让插件自己运行这些工具。每个字段都需要 `.cw/codex.toml` 里有对应模型。缺少模型时，该字段会被关闭，Codex 在会话开始时提示，检查和路径保护继续工作。

| 字段 | 需要的模型 | 行为 |
| --- | --- | --- |
| `auto.review` | `review`、`over_review` | 回合结束且有改动时，用相对 `HEAD` 的 diff 并行运行两个审查者。发现的问题每轮交回模型一次，之后的发现只显示。超过 80,000 字符的 diff 会被截断。 |
| `auto.chronicle` | `historian` | 回合结束、有改动且没有审查发现时，把本轮摘要交给史官。 |
| `auto.pause` | `planner` | 拒绝每轮第一次改源码的操作，只拒绝一次，并返回 `planner` 角色写的计划。`.cw/` 和 `tmp/` 下的编辑不算在内。 |

审查和检查互相独立：自动运行失败或超时只是不产生文字，不会改变检查结果。`auto.pause` 的计划只是建议，模型可以不同意并重新发起编辑。planner 失败、超时或读不到会话记录时，编辑照常执行。

检查的修复轮和审查的修复轮分开计数，所以一个用户回合最多续跑两次。

## 与 pi 共用 `.cw`

对 pi 合法的 `.cw/project.toml` 在这里同样合法。`[check]`、`[protect]`、`[timeouts]`、`[auto]` 和 `[router]` 对两边都生效。模型配置不同：pi 要求 `provider/model` 格式，所以 pi 读 `project.toml` 的 `[models]`，Codex 读 `codex.toml` 的 `[models]`。不要把 Codex 的设置写进 `project.toml`，因为 pi 会拒绝未知字段。

两边都向同一个 `.cw/meter.jsonl` 追加记录，并共用 `.cw/HISTORY.md`。

`[auto]` 字段缺少模型时，两边的处理不同。Codex 只关闭该字段，pi 则拒绝整份配置，所以同时使用两者的项目要在两个文件里都配置模型。

## 使用限制

- 路径保护只覆盖 `apply_patch`。shell 命令和其他工具仍然能写入受保护路径，插件也不会报告这些写入。
- 如果 hook 进程在返回决定前崩溃，Codex 会放行工具调用。
- `codex exec` 会直接跳过未信任的 hook，不给提示。TUI 在启动时会要求你查看。
- 更新改变了 hook 时，需要重新信任该 hook。
- 检查结果只取决于退出码。插件不检测被跳过或被削弱的测试。
- `planner` 角色运行时关闭了 shell 和联网搜索。`apply_patch` 对该角色是否也不可用尚未验证，所以这项限制还依赖角色提示。
- `sandbox = "none"` 时，角色只受提示约束。
- MCP server 只能收到 `HOME`、`LANG`、`LC_ALL`、`LOGNAME`、`PATH`、`SHELL`、`TERM`、`USER`、`CODEX_HOME` 和 `OPENAI_API_KEY`。如果 `router.api_key_env` 指向其他变量，key 传不到 server，闸门按失败处理，审查照常运行。
- `[router]` 只作用于直接调用的 `cw_review` 和 `cw_over_review`。`auto.review` 总是运行审查者。
- 角色运行器依赖 `codex exec --json` 的事件格式，Codex 更新可能改变这个格式。

## 常见问题

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 回合结束时没有 `[counterweight]` 这一行 | hook 未被信任，或没有 `[check]` | 在 Codex 里打开 `/hooks` 并信任 hook，再确认 `.cw/project.toml` 有 `[check]` 小节。 |
| 报告显示 `配置非法` | `.cw/` 下的文件有未知字段或非法值 | 按消息里的字段名修改。 |
| 模型改不了受保护路径下的文件 | 路径命中了 `protect.paths` | 自己修改该文件，或调整 `protect.paths`。 |
| 模型改不了 `.cw/project.toml` 或 `.cw/codex.toml` | 这两个文件总是受保护 | 自己修改。 |
| 角色工具报告 `未配置 [models].<role>` | 该角色没有配置模型 | 在 `.cw/codex.toml` 的 `[models]` 里添加。 |
| 角色读不了文件 | 这台机器上 Codex 沙箱无法启动 | 检查 `kernel.apparmor_restrict_unprivileged_userns`，或设置 `roles.sandbox = "none"`。 |
| 角色报告 `未正常结束` | `codex exec` 的回合没有完成 | 查看消息里的原因，然后重新调用工具。 |
| 角色报告超时 | 输入处理时间超过了 `timeout_s` | 用消息里给出的值重试。已到 1800 秒时，拆小输入。 |
| `[auto]` 没有动作 | 该字段没有模型，或工作树没有改动 | 查看会话开始时的提示，并确认这一轮改了文件。 |

## 开发

```sh
npm ci
npm run typecheck
npm test
```

`npm test` 会先构建产物。测试使用假的 `codex` 可执行文件，不需要模型凭据。`plugins/codex-counterweight/dist/` 下的产物要提交，因为安装插件时不会运行 `npm install`。提交源码改动前先运行 `npm run build`。

设计和实测的 Codex 行为记录在 [`docs/superpowers/specs/2026-11-04-codex-counterweight-design.md`](docs/superpowers/specs/2026-11-04-codex-counterweight-design.md) 和 [`docs/plans/2026-11-04-v2-roles.md`](docs/plans/2026-11-04-v2-roles.md)。

## 许可证

[MIT](LICENSE) © DengQi
