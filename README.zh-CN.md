# codex-counterweight

[English](README.md) | 简体中文

[![Version](https://img.shields.io/badge/version-0.3.0-blue)](plugins/codex-counterweight/.codex-plugin/plugin.json)
[![License: MIT](https://img.shields.io/github/license/nerdneilsfield/codex-counterweight)](LICENSE)
[![Tested with Codex CLI 0.166.0](https://img.shields.io/badge/tested%20with-Codex%20CLI%200.166.0-412991)](https://github.com/openai/codex/releases/tag/rust-v0.166.0)
[![Tested with Claude Code 2.1.318](https://img.shields.io/badge/tested%20with-Claude%20Code%202.1.318-D97757)](https://www.npmjs.com/package/@anthropic-ai/claude-code/v/2.1.318)
[![Tested with OpenCode 2.2.5](https://img.shields.io/badge/tested%20with-OpenCode%202.2.5-211E1E)](https://github.com/anomalyco/opencode/releases/tag/v2.2.5)
[![Node.js >= 22.19](https://img.shields.io/badge/node-%3E%3D22.19-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-7.0-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Tested on Linux](https://img.shields.io/badge/tested%20on-Linux-FCC624?logo=linux&logoColor=black)](#使用限制)
[![Last commit](https://img.shields.io/github/last-commit/nerdneilsfield/codex-counterweight)](https://github.com/nerdneilsfield/codex-counterweight/commits)
[![Issues](https://img.shields.io/github/issues/nerdneilsfield/codex-counterweight)](https://github.com/nerdneilsfield/codex-counterweight/issues)

codex-counterweight 是 Codex CLI、Claude Code 和 OpenCode 的插件，用来强制执行项目的结束检查。每轮结束时，插件运行你配置的命令。命令失败时，插件把输出交回模型一次，模型再用一轮修复。第二次失败只报告给你，不再重试。

插件还会拒绝对受保护路径的写入，向每个会话注入一段工作约束，并记录模型用量。可选的角色工具用单独的模型做代码探索、审查、研究、规划和项目历史记录。三个宿主共用同一个核心和同一组角色，差别在于结果如何显示、角色如何受限，见[宿主差异](#宿主差异)。

这个插件用来减少模型的无意失误，不是安全边界：shell 命令仍然能写入受保护路径。详见[使用限制](#使用限制)。

它是 [pi-counterweight](https://github.com/nerdneilsfield/pi-counterweight) 的 Codex、Claude Code 和 OpenCode 版本，它们都可以共用一份 `.cw/project.toml`。

## 目录

- [环境要求](#环境要求)
- [快速开始](#快速开始)
- [工作流程](#工作流程)
- [宿主差异](#宿主差异)
- [插件做什么](#插件做什么)
- [配置](#配置)
- [角色工具](#角色工具)
- [自动运行](#自动运行)
- [与 pi 共用 `.cw`](#与-pi-共用-cw)
- [使用限制](#使用限制)
- [常见问题](#常见问题)
- [开发](#开发)

## 环境要求

- 以下宿主之一。各版本都在 Linux 上测试过，其他版本和平台未测试。
  - Codex CLI 0.166.0。
  - Claude Code 2.1.318。
  - OpenCode 2.2.5。
- Node.js 22.19 或更新版本，且 `PATH` 上能找到 `node`。Codex 和 Claude Code 用它运行 hook 和 MCP server。
- Git。插件用 Git 工作树根目录定位 `.cw/`；不在 Git 仓库里时，使用当前目录。

## 快速开始

下面在一个新建的练习目录里运行语法检查，不需要现成的项目。先为你的宿主安装插件，再按共同的步骤操作。

### 安装

**Codex CLI**

```sh
codex plugin marketplace add nerdneilsfield/codex-counterweight
codex plugin add codex-counterweight@codex-counterweight
```

**Claude Code**

```text
claude plugin marketplace add nerdneilsfield/codex-counterweight
claude plugin install counterweight@counterweight
```

Claude Code 版插件叫 `counterweight`，因为 Claude Code 保留了以 `claude-` 开头的插件名。想从本地克隆试用，用 `--plugin-dir plugins/claude-counterweight` 启动 Claude Code。

**OpenCode**

```sh
opencode plugin add github:nerdneilsfield/codex-counterweight
```

仓库的 `package.json` 把 `exports` 指向 `plugins/opencode-counterweight/index.js`，那是插件入口。

### 试用

1. 创建练习仓库：

   ```sh
   mkdir -p ~/counterweight-demo/.cw
   cd ~/counterweight-demo
   git init
   ```

2. 创建 `.cw/project.toml`，内容如下：

   ```toml
   version = 1

   [check]
   cmd = ["node", "--check", "hello.js"]
   ```

3. 在该目录启动你的宿主：`codex`、`claude` 或 `opencode`。

4. 宿主询问时，信任插件。Codex 显示 **Hooks need review**，信任之前插件不会运行。Claude Code 显示项目信任对话框。OpenCode 加载插件时没有对话框。

5. 向模型发送以下请求：

   ```text
   Create hello.js that prints Hello, Counterweight!
   ```

在 Codex 和 Claude Code 上，这一轮结束时宿主显示类似下面这行的报告：

```text
[counterweight] 结束检查通过：`node --check hello.js` 退出码 0（0.1s）
```

OpenCode 在检查通过时什么也不显示。要确认检查运行过，在 `.cw/meter.jsonl` 里找 `check` 事件：

```sh
grep '"event":"check"' .cw/meter.jsonl
```

检查通过的那一行含有 `"outcome":"passed"`。

用到自己的项目时，把 `cmd` 换成会自行退出的命令，例如 `["npm", "test"]`。每个宿主也有一个 setup 命令，用来检查插件是否生效并帮你写这个文件：Codex 是 `$cw-setup`，Claude Code 是 `/counterweight:cw-setup`，OpenCode 是 `/cw-setup`。Claude Code 的命令带插件名作为命名空间。

## 工作流程

你不需要开始任务、批准计划或运行修复命令。照常发送请求即可，插件在一轮中的固定位置工作。

```text
你发送请求
    |
    v
模型工作
    |   写入受保护路径时被拒绝。
    |   开启 auto.pause 时，第一次改源码被拒绝一次，并返回一份计划。
    v
回合结束，运行检查
    |-- 第一次失败        -> 模型拿到输出并继续，停下时再次运行检查。
    |-- 被你取消          -> 回合结束，不产生结果。
    |-- 通过，或再次失败
    v
自动运行（如已开启）
    |-- 有发现且改了文件，第一次 -> 模型拿到发现并继续。
    |-- 有发现的其他情况         -> 显示发现。
    |-- 改了文件，且这一轮不续跑 -> 史官更新历史，
    |                               发现只是显示时也更新。
    v
回合结束，你看到结果
```

一个用户回合最多续跑两次：检查一次，审查发现一次。之后插件只报告结果，由你决定下一步。改动从回合开始时算起：回合之前就没提交的文件不会触发审查，回合中途提交也不会让这一轮的改动消失。续跑之后的那次审查看到整个回合的改动。

### 分阶段启用

每个阶段都不依赖下一阶段，可以停在任意一步。这个顺序只是建议。

| 阶段 | 添加什么 | 得到什么 |
| --- | --- | --- |
| 1 | `.cw/project.toml` 的 `[check]` | 每轮结束运行检查，模型有一次修复机会。 |
| 2 | `[protect]` 和 `.cw/goal.md` | 模型不能用补丁改你列出的路径，并能看到你的目标。 |
| 3 | 宿主配置文件的 `[models]` | 模型可以自行决定调用角色工具。 |
| 4 | `.cw/project.toml` 的 `[auto]` | 插件自己运行审查、更新历史和 PAUSE，不等模型想起来。 |

第 4 阶段会让每个改了文件的回合多出模型调用，所以建议先开一项，再看 `.cw/meter.jsonl` 里的实际开销。

### 用目标限定范围

开始较大的任务前，把范围写进 `.cw/goal.md`，例如 `只改绑定的释放顺序，不动公开 API。` 目标只限定工作范围，不会发起工作，请求仍要你自己发。范围变化时由你修改这个文件，任务结束后删除它。模型不能修改它。

### 看懂结果

- 配了 `[check]` 后，每轮结束都有一行 `[counterweight]`。看不到这一行，就说明检查没有运行。OpenCode 例外：检查通过时不显示，要看 `.cw/meter.jsonl`。
- 报告写着未通过且不再自动重试，说明那次修复没有解决问题。你可以发新请求，也可以自己修。新请求会重新获得一次修复机会。
- 审查发现是报告，不是裁决。模型要么处理，要么说明为什么不处理，发现也不会改变检查结果。
- `.cw/meter.jsonl` 记录用量、检查、角色调用和 PAUSE 决定。`.cw/HISTORY.md` 是史官写的项目历史。

## 宿主差异

除下表列出的几点外，本文其余部分描述的行为在三个宿主上相同。

| | Codex CLI | Claude Code | OpenCode |
| --- | --- | --- | --- |
| 检查结果 | 每轮结束时显示报告。 | 交互模式下，同样的报告作为系统消息显示。`--output-format json` 的 print 模式不包含它。 | 检查通过时什么也不显示，到 `.cw/meter.jsonl` 里确认。第一次失败交回模型。再次失败时，要求模型把报告转告给你。 |
| 受保护的工具 | `apply_patch` | `Edit`、`Write`、`NotebookEdit` | `write`、`edit`、`patch` |
| 角色限制 | `codex exec` 加只读沙箱。`planner` 另外没有 shell 和联网搜索。 | `claude -p`，只有 `Read` 和 `Grep` 两个工具。`planner` 没有工具。 | 子会话，拒绝 `edit` 和 `shell`。`planner` 拒绝所有工具。 |
| 角色的运行方式 | MCP server 加 `codex exec` | MCP server 加 `claude -p` | 插件工具加子会话 |
| 计量中的用量 | 每次模型响应的 token，`cost_total` 为 `null`。 | transcript 里每条助手消息的 token。会话用量的 `cost_total` 为 `null`，角色运行的 `cost_total` 取自 `total_cost_usd`。 | 每个完成的步骤的 token 和 `cost_total`，包括角色子会话里的步骤。 |
| 配置文件 | `.cw/codex.toml` | `.cw/claude.toml` | `.cw/opencode.toml` |
| 模型写法 | 不含空白的 Codex 模型名称 | 不含空白的 Claude Code 别名或完整模型 id | `provider/model` |
| `[roles] sandbox` | 接受 | 拒绝 | 拒绝 |
| setup 命令 | `$cw-setup` | `/counterweight:cw-setup` | `/cw-setup` |

## 插件做什么

插件在各宿主的以下事件上工作。

| 动作 | Codex CLI | Claude Code | OpenCode |
| --- | --- | --- | --- |
| 注入工作约束 | 会话开始、`/clear`、压缩 | 会话开始、`/clear`、压缩 | 顶层会话的每次模型调用 |
| 保存请求原文；`auto.review` 或 `auto.chronicle` 开启时，再取一份标记回合开始的快照 | 用户提交请求 | 用户提交请求 | prompt |
| 拒绝写入受保护路径；可选地在第一次改源码前暂停 | `apply_patch` | `Edit`、`Write`、`NotebookEdit` | `write`、`edit`、`patch` |
| 记录本轮的 shell 命令和文件写入，供 `auto.review` 使用 | `Bash`、`exec_command`、`shell_command`、`apply_patch` | `Bash`、`Edit`、`Write`、`NotebookEdit` | `shell`、`write`、`edit`、`patch` |
| 把 token 用量追加到 `.cw/meter.jsonl` | 模型响应 | 回合结束和会话结束时扫描 transcript | 完成的步骤 |
| 运行检查，然后运行已开启的自动任务 | 回合结束 | 回合结束 | 会话空闲 |

没有 `.cw/project.toml` 时，插件放行所有写入，只有写 `.cw/goal.md` 除外，回合结束时不做任何事。以下两项对所有启用了插件的仓库都生效，即使没有配置文件：

- 注入的约束会改变模型的行为。它要求模型用中文直接作答，并避免添加当前需求用不到的抽象。原文在 [`src/roles/prompts.ts`](src/roles/prompts.ts)。
- 插件会在每个仓库里创建 `.cw/meter.jsonl`。如果不想跟踪这个文件，把 `.cw/` 加入该仓库的 `.gitignore`。

### 结束检查

插件在每个正常结束的回合运行检查，只回答问题的回合也会运行，所以要选耗时可以接受的命令。结果只看退出码。命令在仓库根目录运行，不经过 shell，因此 `npm test && npm run bundle` 不是一条合法的命令。需要组合多个检查时，把它们写进脚本。

检查失败时，插件把退出码和每条输出流最多 80 行或 16 KiB 的内容交回模型，宿主继续这一轮。每轮有一次这样的重试机会。再次失败时，插件显示结果并结束。

检查超时按失败处理。插件向检查的进程组发送 `SIGTERM`，5 秒后发送 `SIGKILL`。如果你在检查运行时中断回合，Codex 和 Claude Code 会杀掉 hook，看门进程随后杀掉检查进程；OpenCode 会中止检查，也不再发送续跑内容。被中断的检查不产生结果。

### 受保护路径

配置加载成功后，`.cw/project.toml`、`.cw/goal.md`、`.cw/codex.toml`、`.cw/claude.toml` 和 `.cw/opencode.toml` 在所有宿主上总是受保护。`.cw/goal.md` 即使在 `.cw/project.toml` 缺失或非法时也受保护，因为插件不需要配置就会注入它。只要调用中有一个路径受保护、通过符号链接指向受保护路径，或位于仓库之外，插件就拒绝整个调用。解析不出路径的调用也会被拒绝。

### 目标文件

`.cw/goal.md` 放你亲手写的目标。文件存在且不是空白时，插件把它附在注入的约束后面，并要求模型待在这个目标之内、不要扩大它。超过 4000 字符的部分会被截掉，并注明截断。这个文件总是受保护，有没有配置都一样，模型改不了约束它的目标。没有这个文件时，什么也不加。只有顶层会话会收到目标，角色子进程和 OpenCode 的子会话收不到。

修改多久后生效，取决于宿主：

- OpenCode 在顶层会话的每次模型调用时读取文件，所以修改从下一次调用开始生效。
- Codex 和 Claude Code 在会话开始、`/clear` 和压缩时注入目标。之后每次提交请求时，插件把文件与上次注入的版本比较。文件变了，就把新目标追加到上下文；文件被删除，就告诉模型之前的目标不再适用；文件没变，什么也不加，上下文不会每轮增长。旧版本仍留在对话历史里，新版本排在它后面。

## 配置

配置放在 `.cw/` 下的两个文件里：共用的 `project.toml`，以及你的宿主对应的一个文件。插件在每个事件上都读取这两个文件，因此改动从下一个事件开始生效，不需要重启。任一文件出现未知字段，整份配置都非法。配置非法时，检查和路径保护都会停止。Codex 和 Claude Code 在会话开始和每轮结束时显示错误，OpenCode 在每轮结束时要求模型转告这个错误。

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

这个文件的 `[models]` 小节属于 pi，三个宿主都会忽略它。

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

### `.cw/claude.toml` 和 `.cw/opencode.toml`

这两个文件可选，存放 Claude Code 和 OpenCode 的角色模型。它们的 `[models]` 小节与 `codex.toml` 相同，没有 `[roles]` 小节，因为角色靠工具或权限限制，不靠沙箱。任一文件里出现 `[roles]` 小节，配置就非法。

```toml
# .cw/claude.toml：别名或完整模型 id，不含空白
[models]
review = "sonnet"
over_review = "sonnet"
```

```toml
# .cw/opencode.toml：provider/model
[models]
review = "anthropic/claude-sonnet-4-5"
over_review = "anthropic/claude-sonnet-4-5"
```

OpenCode 按第一个斜杠切分模型名称，所以斜杠之后的模型 id 里可以再有斜杠。没有配置模型的角色不可用。

## 角色工具

插件向模型提供五个工具。在 Codex 和 Claude Code 上，由 MCP server 提供，每次调用启动一个一次性的 `codex exec` 或 `claude -p` 子进程，子进程关闭了 hook。在 OpenCode 上，由插件注册这些工具，每次调用在调用方会话的子会话里运行。在角色自己的会话里，这些工具会报告不可用，所以角色不能再启动角色。每个工具都接受可选的 `timeout_s`，范围 300 到 1800。超时后，返回结果会给出下一次可用的值。

| 工具 | 输入 | 结果 |
| --- | --- | --- |
| `cw_explore` | `question` | 定位代码，并给出 `路径:行号`。 |
| `cw_review` | `request`、`diff` | 报告这次改动做错的地方。 |
| `cw_over_review` | `request`、`diff` | 报告这次改动中没有当前需求支撑的内容。 |
| `cw_research` | `question` | 回答读代码后仍定不下来的问题。 |
| `cw_chronicle` | `report` | 把汇报并入后，重写 `.cw/HISTORY.md`。 |

审查者和史官可以不给结果，而是回复 `ASK:` 加问题。模型回答后再次调用工具。这种情况下史官不写文件。

史官写入前会再次读取 `.cw/HISTORY.md`。如果文件在运行期间发生变化，史官放弃这次结果，工具要求模型重新汇报。hook、MCP、OpenCode 插件和 pi 同时运行时都按这条规则处理。

工具调用和角色用量都记录在 `.cw/meter.jsonl`。通过 Claude Code 的 MCP server 调用角色工具时，这些行的 `session` 字段为空，因为 server 不知道会话。

## 自动运行

默认由模型决定是否调用角色工具。`[auto]` 的字段让插件自己运行这些工具。每个字段都需要你的宿主文件（`.cw/codex.toml`、`.cw/claude.toml` 或 `.cw/opencode.toml`）里有对应模型。缺少模型时，该字段会被关闭，检查和路径保护继续工作。Codex 和 Claude Code 在会话开始时提示。

| 字段 | 需要的模型 | 行为 |
| --- | --- | --- |
| `auto.review` | `review`、`over_review` | 回合结束且有改动时，用从回合开始到现在的 diff 并行运行两个审查者。diff 含新文件的内容，不含 `.cw/`。`over_review` 还会收到本轮的命令（见下）。发现的问题每轮交回模型一次，之后的发现只显示。超过 80,000 字符的 diff 会被截断。 |
| `auto.chronicle` | `historian` | 回合结束且有改动时，把本轮摘要交给史官；插件正要把审查发现交回模型时除外，这时史官在续跑后的那次回合结束时运行。发现只是显示时不影响史官。 |
| `auto.pause` | `planner` | 拒绝每轮第一次改源码的操作，只拒绝一次，并返回 `planner` 角色写的计划。`.cw/` 和 `tmp/` 下的编辑不算在内。 |

`over_review` 会收到本轮顶层代理执行的 shell 命令和文件写入，列在 diff 后面。列出的是调用，不是执行结果。diff 看不到没有改动文件的命令，例如重跑一次或扩大扫描范围。清单最多 40 条，超出时先舍弃文件写入，超过 2000 字符的命令不列出。被路径保护或 `auto.pause` 拒绝的调用不在清单里，子代理执行的命令也不在。`review` 仍然只按 diff 判断。

只跑了命令、没有改文件的回合仍会运行 `over_review`，但不运行 `review` 和 `auto.chronicle`。它的发现会显示，却不会让这一轮继续，因为命令已经执行完，没有文件可改。这些发现仍然用掉本轮交回模型的额度。

审查和检查互相独立：自动运行失败或超时只是不产生文字，不会改变检查结果。`auto.pause` 的计划只是建议，模型可以不同意并重新发起编辑。planner 失败、超时或读不到会话记录时，编辑照常执行。

检查的修复轮和审查的修复轮分开计数，所以一个用户回合最多续跑两次。在 OpenCode 上，检查和自动运行只作用于顶层会话，`auto.pause` 跳过子会话。

## 与 pi 共用 `.cw`

对 pi 合法的 `.cw/project.toml` 在这里同样合法。`[check]`、`[protect]`、`[timeouts]`、`[auto]` 和 `[router]` 对两边都生效。模型配置不同：pi 要求 `provider/model` 格式，所以 pi 读 `project.toml` 的 `[models]`，这里的每个宿主读自己文件里的 `[models]`。不要把宿主设置写进 `project.toml`，因为 pi 会拒绝未知字段。

各工具都向同一个 `.cw/meter.jsonl` 追加记录，并共用 `.cw/HISTORY.md`。

`[auto]` 字段缺少模型时，各工具的处理不同。Codex、Claude Code 和 OpenCode 只关闭该字段，pi 则拒绝整份配置，所以使用 pi 的项目要在两个文件里都配置模型。

## 使用限制

所有宿主共有的限制：

- 路径保护只覆盖[宿主差异](#宿主差异)里列出的写文件工具。shell 命令和其他工具仍然能写入受保护路径，插件也不会报告这些写入。
- 检查结果只取决于退出码。插件不检测被跳过或被削弱的测试。
- `[router]` 只作用于直接调用的 `cw_review` 和 `cw_over_review`。`auto.review` 总是运行审查者。
- 各宿主的角色运行器依赖该宿主的输出或接口格式，宿主更新可能改变它。
- 插件不记录子代理的命令和文件写入，所以 `over_review` 看不到它们。
- 回合开始时的快照失败时，插件改为和 `HEAD` 比较。这时回合之前就没提交的文件也会算作改动。

Codex CLI：

- 如果 hook 进程在返回决定前崩溃，Codex 会放行工具调用。
- `codex exec` 会直接跳过未信任的 hook，不给提示。TUI 在启动时会要求你查看。
- 更新改变了 hook 时，需要重新信任该 hook。本插件的 0.3.0 版把 `PreToolUse` 的匹配范围扩大到 shell 工具，所以更新到这个版本后，Codex 会再次要求你查看 hook。
- `planner` 角色运行时关闭了 shell 和联网搜索。`apply_patch` 对该角色是否也不可用尚未验证，所以这项限制还依赖角色提示。
- `sandbox = "none"` 时，角色只受提示约束。
- MCP server 只能收到 `HOME`、`LANG`、`LC_ALL`、`LOGNAME`、`PATH`、`SHELL`、`TERM`、`USER`、`CODEX_HOME` 和 `OPENAI_API_KEY`。如果 `router.api_key_env` 指向其他变量，key 传不到 server，闸门按失败处理，审查照常运行。
- 角色运行器依赖 `codex exec --json` 的事件格式。

Claude Code：

- Claude Code 没有用量 hook，所以插件读取 transcript。回合结束时，transcript 可能缺少最后一条助手消息，这条消息会在下一次扫描时记上，也就是下一个回合结束或会话结束时。来自 transcript 的用量行，`cost_total` 为 `null`。
- MCP server 从 `CLAUDE_PROJECT_DIR` 定位仓库，没有这个变量时用自己的工作目录。它不为角色工具记录会话。
- `systemMessage` 报告不在 print 模式的 `--output-format json` 输出里。
- 角色只有 `Read` 和 `Grep` 两个工具，所以能读和搜文件，不能改文件。
- 角色运行器依赖 `claude -p --output-format json` 打印的 JSON 对象。

OpenCode：

- OpenCode 没有给插件向你显示文字的通道。检查通过时什么也不显示，要到 `.cw/meter.jsonl` 里确认。第一次失败交回模型修复。再次失败时，插件再发一条消息，要求模型不改文件、把报告转告给你，这会多消耗一次模型调用。模型不一定逐字转述。配置错误，以及修复之后仍然存在的审查发现，也是这样处理。
- 每个 prompt 只发一次这样的消息。中断回合会停止正在运行的检查或角色，之后插件不再发送续跑内容。
- 角色靠在子会话里拒绝 `edit` 和 `shell` 来限制，其他工具对它仍然可用，`planner` 除外，它拒绝所有工具。
- 每次角色调用都会在 OpenCode 的会话列表里留下一个子会话，插件不会删除它。
- 用量来自完成的步骤，记录输入、输出和缓存 token，推理 token 不单独记录。
- 插件使用的空闲回调在 OpenCode 里叫 `experimental.idle`，以后可能改变。

## 常见问题

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| Codex 上回合结束时没有 `[counterweight]` 这一行 | hook 未被信任，或没有 `[check]` | 在 Codex 里打开 `/hooks` 并信任 hook，再确认 `.cw/project.toml` 有 `[check]` 小节。 |
| Claude Code 上回合结束时没有 `[counterweight]` 这一行 | 插件未启用、项目未被信任，或没有 `[check]` | 启用插件并接受信任对话框。确认会话上下文里有 `Counterweight <version> active`，并确认 `.cw/project.toml` 有 `[check]` 小节。 |
| OpenCode 上回合结束时什么也没出现 | OpenCode 在检查通过时什么也不显示 | 在 `.cw/meter.jsonl` 里找 `check` 事件。找不到时，确认 `.cw/project.toml` 有 `[check]` 小节，并确认插件已安装。 |
| 报告显示 `配置非法` | `.cw/` 下的文件有未知字段或非法值 | 按消息里的字段名修改。 |
| 模型改不了受保护路径下的文件 | 路径命中了 `protect.paths` | 自己修改该文件，或调整 `protect.paths`。 |
| 模型改不了 `.cw/` 下的文件 | `project.toml`、`goal.md` 和三个宿主文件总是受保护 | 自己修改。 |
| 角色工具报告 `未配置 [models].<role>` | 该角色没有配置模型 | 在你的宿主文件的 `[models]` 里添加。 |
| Codex 上角色读不了文件 | 这台机器上 Codex 沙箱无法启动 | 检查 `kernel.apparmor_restrict_unprivileged_userns`，或设置 `roles.sandbox = "none"`。 |
| 角色报告 `未正常结束` | 角色的回合没有完成 | 查看消息里的原因，然后重新调用工具。 |
| 角色报告超时 | 输入处理时间超过了 `timeout_s` | 用消息里给出的值重试。已到 1800 秒时，拆小输入。 |
| `[auto]` 没有动作 | 该字段没有模型，或这一轮没有改文件 | 查看会话开始时的提示，并确认这一轮改了文件。没有改动的回合只要跑过命令，仍会运行 `over_review`。 |

## 开发

```sh
npm ci
npm run typecheck
npm test
```

`npm test` 会先构建产物。测试把假的 `codex` 或 `claude` 可执行文件放在 `PATH` 最前面，并用假的 ctx 对象驱动 OpenCode 插件，不需要模型凭据。`plugins/codex-counterweight/dist/`、`plugins/claude-counterweight/dist/` 和 `plugins/opencode-counterweight/index.js` 下的产物要提交，因为安装插件时不会运行 `npm install`。提交源码改动前先运行 `npm run bundle`。

设计和实测的 Codex 行为记录在 [`docs/superpowers/specs/2026-11-04-codex-counterweight-design.md`](docs/superpowers/specs/2026-11-04-codex-counterweight-design.md) 和 [`docs/plans/2026-11-04-v2-roles.md`](docs/plans/2026-11-04-v2-roles.md)。Claude Code 和 OpenCode 的设计，以及两个宿主的实测行为，记录在 [`docs/plans/2026-11-04-claude-opencode.md`](docs/plans/2026-11-04-claude-opencode.md)。

## 许可证

[MIT](LICENSE) © DengQi
