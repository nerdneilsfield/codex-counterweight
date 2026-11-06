# codex-counterweight

English | [简体中文](README.zh-CN.md)

[![Version](https://img.shields.io/badge/version-0.4.0-blue)](plugins/codex-counterweight/.codex-plugin/plugin.json)
[![License: MIT](https://img.shields.io/github/license/nerdneilsfield/codex-counterweight)](LICENSE)
[![Tested with Codex CLI 0.166.0](https://img.shields.io/badge/tested%20with-Codex%20CLI%200.166.0-412991)](https://github.com/openai/codex/releases/tag/rust-v0.166.0)
[![Tested with Claude Code 2.1.318](https://img.shields.io/badge/tested%20with-Claude%20Code%202.1.318-D97757)](https://www.npmjs.com/package/@anthropic-ai/claude-code/v/2.1.318)
[![Tested with OpenCode 2.2.5](https://img.shields.io/badge/tested%20with-OpenCode%202.2.5-211E1E)](https://github.com/anomalyco/opencode/releases/tag/v2.2.5)
[![Tested with Kimi Code 2.5.0](https://img.shields.io/badge/tested%20with-Kimi%20Code%202.5.0-1783FF)](https://moonshotai.github.io/kimi-code/)
[![Tested with Hermes Agent 0.22.7](https://img.shields.io/badge/tested%20with-Hermes%20Agent%200.22.7-7B5CFA)](https://github.com/NousResearch/hermes-agent/tree/v0.22.7)
[![Node.js >= 22.19](https://img.shields.io/badge/node-%3E%3D22.19-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-7.0-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Tested on Linux](https://img.shields.io/badge/tested%20on-Linux-FCC624?logo=linux&logoColor=black)](#limitations)
[![Last commit](https://img.shields.io/github/last-commit/nerdneilsfield/codex-counterweight)](https://github.com/nerdneilsfield/codex-counterweight/commits)
[![Issues](https://img.shields.io/github/issues/nerdneilsfield/codex-counterweight)](https://github.com/nerdneilsfield/codex-counterweight/issues)

codex-counterweight is a plugin for Codex CLI, Claude Code, OpenCode, Kimi Code, and Hermes Agent that enforces a project's end-of-turn check. When a turn ends, the plugin runs the command you configured. If the command fails, the plugin returns the output to the model once, and the model gets one more turn to fix the failure. A second failure is reported to you and does not trigger another retry.

The plugin also rejects writes to paths you protect, injects a set of working instructions into each session, and records model usage. Optional role tools run a separate model for code exploration, review, research, planning, and project history. All five hosts share one core and one set of roles; they differ in how they show results, how they restrict roles, and when the check can run, as described in [Differences between hosts](#differences-between-hosts).

This plugin reduces mistakes by a cooperative model. It is not a security boundary: shell commands can still write to protected paths. See [Limitations](#limitations).

It is the Codex, Claude Code, OpenCode, Kimi Code, and Hermes Agent counterpart of [pi-counterweight](https://github.com/nerdneilsfield/pi-counterweight), and all of them can share one `.cw/project.toml`.

## Contents

- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Workflow](#workflow)
- [Differences between hosts](#differences-between-hosts)
- [What the plugin does](#what-the-plugin-does)
- [Configuration](#configuration)
- [Role tools](#role-tools)
- [Automatic runs](#automatic-runs)
- [Guards and records](#guards-and-records)
- [Sharing `.cw` with pi](#sharing-cw-with-pi)
- [Limitations](#limitations)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

## Requirements

- One of the following hosts. Each version was tested on Linux. Other versions and platforms are untested.
  - Codex CLI 0.166.0.
  - Claude Code 2.1.318.
  - OpenCode 2.2.5.
  - Kimi Code 2.5.0. Tested with one-shot runs (`kimi -p`) and a plugin installation in the terminal UI. A full interactive session was not tested.
  - Hermes Agent 0.22.7. Tested with one-shot runs (`hermes -z`). The interactive chat, the terminal UI, and messaging platforms were not tested.
- Node.js 22.19 or later, available as `node` on `PATH`. Codex, Claude Code, Kimi Code, and Hermes Agent run the hooks and the MCP server with it. For Hermes Agent, `node` must be on the `PATH` of the gateway process, which Hermes starts on demand.
- Git. The plugin uses the Git work tree root to find `.cw/`. Outside a Git repository, it uses the current directory.

## Quick start

This walkthrough runs a syntax check in a new practice directory, so it needs no existing project. Install the plugin for your host first, then follow the shared steps.

### Install

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

The Claude Code plugin is named `counterweight`, because Claude Code reserves plugin names that start with `claude-`. To try the plugin from a local clone, start Claude Code with `--plugin-dir plugins/claude-counterweight`.

**OpenCode**

```sh
opencode plugin add github:nerdneilsfield/codex-counterweight
```

The repository's `package.json` points `exports` at `plugins/opencode-counterweight/index.js`, which is the plugin entry.

**Kimi Code**

Install from a local clone. Start `kimi`, enter `/plugins`, switch to the **Custom** tab, and enter the absolute path of `plugins/kimi-counterweight`. Kimi shows a warning that the plugin is third-party. Choose **Trust and install**, then run `/new` or `/reload` to apply the change. Installing from a GitHub URL was not run. Kimi's source accepts `tree` URLs, which could point at the plugin directory, but this was not tried.

Kimi Code lists the setup skill as `counterweight:cw-setup`. The slash form `/skill:counterweight:cw-setup` was not run.

**Hermes Agent**

Copy the plugin into the plugin directory of your Hermes home, enable it, and raise the hook timeout. The hook timeout bounds the end check, so the default of 30 seconds leaves the check about 15 seconds.

```sh
cp -r plugins/hermes-counterweight ~/.hermes/plugins/counterweight
hermes plugins enable counterweight
hermes config set plugins.hook_callback_timeout 600
```

If `HERMES_HOME` is set, copy into `$HERMES_HOME/plugins/counterweight` instead. `hermes plugins install` from a Git URL was not run.

### Try it

1. Create a practice repository:

   ```sh
   mkdir -p ~/counterweight-demo/.cw
   cd ~/counterweight-demo
   git init
   ```

2. Create `.cw/project.toml` with this content:

   ```toml
   version = 1

   [check]
   cmd = ["node", "--check", "hello.js"]
   ```

3. Start your host in that directory: `codex`, `claude`, or `opencode`. For Kimi Code and Hermes Agent, the tested forms are the one-shot commands `kimi -p "<request>"` and `hermes -z "<request>"`, where `<request>` is the text of step 5.

4. Trust the plugin if the host asks. Codex shows **Hooks need review**, and the plugin does nothing until you trust its hooks. Claude Code shows its project trust dialog. OpenCode loads the plugin without a dialog. Kimi Code asked for trust only when the plugin was installed. Hermes Agent loads the plugin once `hermes plugins enable` has run.

5. Send this request to the model:

   ```text
   Create hello.js that prints Hello, Counterweight!
   ```

On Codex and Claude Code, the host shows a report similar to the following line when the turn ends. The report text is in Chinese. `结束检查通过` means that the end check passed, and `退出码 0` means exit code 0.

```text
[counterweight] 结束检查通过：`node --check hello.js` 退出码 0（0.1s）
```

OpenCode shows nothing when a check passes. Kimi Code and Hermes Agent have no display at the end of a turn, so they deliver the report with your next prompt. To confirm on any of these hosts that the check ran, look for a `check` event in `.cw/meter.jsonl`:

```sh
grep '"event":"check"' .cw/meter.jsonl
```

A passing run has `"outcome":"passed"` in the line.

To use the plugin in your own project, replace `cmd` with a command that exits on its own, such as `["npm", "test"]`. Codex, Claude Code, OpenCode, and Kimi Code have a setup command that checks that the plugin is active and helps you write the file: `$cw-setup` in Codex, `/counterweight:cw-setup` in Claude Code, `/cw-setup` in OpenCode, and the skill `counterweight:cw-setup` in Kimi Code. Claude Code and Kimi Code namespace the command with the plugin name. Hermes Agent has no setup command, so write the files by hand.

## Workflow

You do not start a task, approve a plan, or run a repair command. You send a request as usual, and the plugin acts at fixed points in the turn.

```text
You send a request
    |
    v
The model works
    |   A write to a protected path is rejected.
    |   With auto.pause, the first source edit is rejected once and returns a plan.
    v
The turn ends and the check runs
    |-- Failed, first time    -> The model gets the output and continues.
    |                            The check runs again when it stops.
    |-- Cancelled by you      -> The turn ends with no result.
    |-- Passed, or failed again
    v
Automatic runs, if enabled
    |-- Findings and file changes, first time -> The model gets the findings
    |                                            and continues.
    |-- Findings, otherwise                   -> The findings are shown.
    |-- Files changed, and the turn does
    |   not continue                          -> The historian updates the history,
    |                                            also when findings were shown.
    v
The turn ends and you see the result
```

One user turn continues at most twice: once for the check and once for review findings. Kimi Code is the exception: it runs the `Stop` hook once per turn, so the check and the review findings share one continuation and the check goes first. After that, the plugin reports what it found and the decision is yours. Changes are counted from the start of the turn, so files you left uncommitted before it do not trigger a review, and a commit made during the turn does not hide the turn's changes. The review that follows a continuation sees the whole turn.

### Add features in stages

Each stage works without the next one, so you can stop at any point. This order is a suggestion.

| Stage | What you add | What you get |
| --- | --- | --- |
| 1 | `[check]` in `.cw/project.toml` | The check runs at the end of each turn, and the model gets one repair turn. |
| 2 | `[protect]` and `.cw/goal.md` | The model cannot patch the paths you list, and it receives your goal. |
| 3 | `[models]` in the host file | The model can call the role tools when it decides to. |
| 4 | `[auto]` in `.cw/project.toml` | The plugin runs reviews, history updates, and PAUSE without waiting for the model. |

Stage 4 adds a model call to each turn that changes files, so start with one key and read `.cw/meter.jsonl` to see what it costs.

### Work with a goal

Before a larger task, write the scope in `.cw/goal.md`, for example `Only change the release order of the binding. Do not touch the public API.` The goal limits the work. It does not start any work, so you still send the request. Edit the file yourself when the scope changes, and delete it when the task is finished. The model cannot edit it.

### Read the result

- A `[counterweight]` line appears at the end of each turn when `[check]` is set. If the line is missing, the check did not run. OpenCode is the exception: a passing check shows nothing there, so read `.cw/meter.jsonl`. On Kimi Code and Hermes Agent the line appears at the start of the next prompt, as a message the plugin appends to it, and the model sees it too.
- At the start of a session (startup and clear, not compaction or resume), Codex and Claude Code show one line when there is no `.cw/project.toml` or no `[check]`, because then no check runs at the end of a turn. OpenCode has no display channel for this, so it only records `"check": false` in the `inject` event. Kimi Code and Hermes Agent send the same line with the first prompt of the session.
- When `.cw/pending.md` has entries, the end-of-turn line ends with `待批 N 条` (N lessons waiting for your approval). Without a check result it is a line of its own. OpenCode does not show it, because that would cost an extra model call.
- When an automatic review role could not finish, one line says so: `[counterweight] 自动审查未完成：<role> <reason>`. It never changes the check result and never continues the turn. OpenCode asks the model to relay it once, which costs one extra model call.
- A report that says the check failed and will not retry means that the repair turn did not fix it. Send a new request, or fix the problem yourself. A new request gets a new repair turn.
- Review findings are reports, not verdicts. The model fixes them or explains why it does not, and they never change the check result.
- `.cw/meter.jsonl` records usage, checks, role calls, and PAUSE decisions. `.cw/HISTORY.md` holds the project history that the historian writes.

## Differences between hosts

The behavior described in the rest of this document is the same on all five hosts, except for the points in the following tables. The first table covers Codex CLI, Claude Code, and OpenCode.

| | Codex CLI | Claude Code | OpenCode |
| --- | --- | --- | --- |
| Check result | A report appears at the end of every turn. | The same report appears as a system message in interactive mode. Print mode with `--output-format json` does not include it. | A passing check shows nothing. Confirm it in `.cw/meter.jsonl`. The first failure goes back to the model. If the check fails again, the model is asked to repeat the report to you. |
| Guarded tools | `apply_patch` | `Edit`, `Write`, `NotebookEdit` | `write`, `edit`, `patch` |
| Role restriction | `codex exec` with a read-only sandbox. The `planner` also has no shell and no web search. | `claude -p` with the tools `Read` and `Grep`. The `planner` has no tools. | A child session that denies `edit` and `shell`. The `planner` denies every tool. |
| How roles run | MCP server and `codex exec` | MCP server and `claude -p` | Plugin tools and child sessions |
| Usage in the meter | Tokens from each model response. `cost_total` is `null`. | Tokens from the transcript, one record per assistant message. `cost_total` is `null` for session usage and comes from `total_cost_usd` for role runs. | Tokens and `cost_total` from each finished step, including steps in role child sessions. |
| Config file | `.cw/codex.toml` | `.cw/claude.toml` | `.cw/opencode.toml` |
| Model name | A Codex model name without whitespace | A Claude Code alias or full model id without whitespace | `provider/model` |
| `[roles] sandbox` | Accepted | Rejected | Rejected |
| Setup command | `$cw-setup` | `/counterweight:cw-setup` | `/cw-setup` |

The second table covers Kimi Code and Hermes Agent, which differ more from the others. Both lack a display at the end of a turn, and both limit how long the check and the roles may run.

| | Kimi Code | Hermes Agent |
| --- | --- | --- |
| Turns that run the check | Every completed turn. | Only turns that edited code, because the check hangs on `pre_verify`. A question-only turn has no check. |
| Check result | Delivered with the next prompt, as a message appended to it. | Delivered with the next turn, in the context the plugin adds to the prompt. |
| Continuations per turn | One. The check and the review findings share it, and the check goes first. After the repair turn, Kimi runs no `Stop` hook, so the repair is not checked again. | Up to two: one for the check and one for review findings. The plugin allows none once `attempt` reaches 2. |
| Time limits | Hook timeout 600 seconds. Check at most 300 seconds, each role at most 270 seconds. | The hook timeout is `plugins.hook_callback_timeout` (default 30, at most 600 seconds). The check gets half of it (at most 300 seconds), each role 40% (at most 270 seconds). |
| Guarded tools | `Write`, `Edit` | `write_file`, `patch` (including V4A multi-file patches) |
| Commands checked | `Bash` | `terminal` |
| Role restriction | `kimi -p --agent-file` with the tools `Read`, `Grep`, `Glob`. The `planner` has no tools. | `hermes -z -t file`. The plugin blocks every tool except `read_file` and `search_files` in a role session. The `planner` gets `-t todo` and every tool is blocked. |
| How roles run | MCP server of the plugin and `kimi -p`. | Automatic runs only, through `hermes -z`. There are no role tools. |
| Step cap for roles | 30 steps (`research` 80, `planner` 1). | None. Only the timeout limits a role. |
| Usage in the meter | `usage.record` lines of the session's `wire.jsonl`, one record per line. `cost_total` is `null`. | `post_api_request`, one record per `api_request_id`. `cost_total` is `null`. |
| Config file | `.cw/kimi.toml` | `.cw/hermes.toml` |
| Model name | A model alias from Kimi's `config.toml`, without whitespace | `provider/model` (split at the first slash into `--provider` and `-m`), or a model name alone, without whitespace |
| `[roles] sandbox` | Rejected | Rejected |
| Setup command | The skill `counterweight:cw-setup` | None |

## What the plugin does

The plugin acts on the following events of each host.

| Action | Codex CLI | Claude Code | OpenCode |
| --- | --- | --- | --- |
| Injects the working instructions | Session start, `/clear`, compaction | Session start, `/clear`, compaction | Every model call of a top-level session |
| Stores the prompt, and takes the snapshot that marks the start of the turn when `auto.review` or `auto.chronicle` is on | User prompt | User prompt | Prompt |
| Rejects writes to protected paths, and optionally pauses the first source edit | `apply_patch` | `Edit`, `Write`, `NotebookEdit` | `write`, `edit`, `patch` |
| Records the turn's shell commands and file writes for `auto.review` | `Bash`, `exec_command`, `shell_command`, `apply_patch` | `Bash`, `Edit`, `Write`, `NotebookEdit` | `shell`, `write`, `edit`, `patch` |
| Appends token usage to `.cw/meter.jsonl` | Model response | Transcript scan at turn end and session end | Finished step |
| Runs the check, then any automatic runs | Turn end | Turn end | Session idle |

| Action | Kimi Code | Hermes Agent |
| --- | --- | --- |
| Injects the working instructions | The first prompt of a session (`UserPromptSubmit`) | The first turn of a session (`pre_llm_call`) |
| Stores the prompt, and takes the snapshot that marks the start of the turn when `auto.review` or `auto.chronicle` is on | `UserPromptSubmit` | `pre_llm_call` |
| Rejects writes to protected paths, and optionally pauses the first source edit | `PreToolUse` for `Write`, `Edit` | `pre_tool_call` for `write_file`, `patch` |
| Records the turn's shell commands and file writes for `auto.review` | `Bash`, `Write`, `Edit` | `terminal`, `write_file`, `patch` |
| Appends token usage to `.cw/meter.jsonl` | `wire.jsonl` scan at each prompt, `Stop`, and `SessionEnd` | `post_api_request` |
| Runs the check, then any automatic runs | `Stop` | `pre_verify` |
| Writes the chronicle event | `Stop` when the turn does not continue | `on_session_end` |

Without `.cw/project.toml`, the plugin allows every write except a write to `.cw/goal.md` or `.cw/scope.txt` (and a write outside an active scope), refuses the dangerous shell commands below, and runs no check at the end of a turn. Two actions still apply to every repository where the plugin is enabled:

- The injected instructions change how the model behaves. They ask for direct answers in Chinese and tell the model to avoid abstractions that no current requirement needs. The text is in [`src/roles/prompts.ts`](src/roles/prompts.ts).
- The plugin creates `.cw/meter.jsonl` in each repository. To keep the local files out of git but still track the shared practice notes, put this in `.gitignore`:

  ```gitignore
  /.cw/*
  !/.cw/PRACTICES.md
  !/.cw/BUGS.md
  ```

### End check

The plugin runs the check at the end of every completed turn, including turns that only answer a question, so choose a command with an acceptable duration. Hermes Agent is the exception: it runs the check only for turns that edited code. Only the exit code decides the result. The command runs from the repository root and does not go through a shell, so `npm test && npm run bundle` is not a valid single command. Put combined checks in a script.

If the check fails, the plugin sends the exit code and up to 80 lines or 16 KiB of each output stream back to the model, then the host continues the turn. Each turn gets one such retry. If the check fails again, the plugin shows the result and stops.

A check that exceeds its timeout counts as a failure. The plugin sends `SIGTERM` to the check's process group, then `SIGKILL` 5 seconds later. If you interrupt a turn while the check runs, Codex and Claude Code kill the hook, and a watchdog process kills the check. OpenCode aborts the check and sends no continuation. An interrupted check produces no result.

### Protected paths

`.cw/project.toml`, `.cw/goal.md`, `.cw/scope.txt`, `.cw/codex.toml`, `.cw/claude.toml`, `.cw/opencode.toml`, `.cw/kimi.toml`, and `.cw/hermes.toml` are always protected once configuration loads, on every host. `.cw/goal.md` and `.cw/scope.txt` are protected even when `.cw/project.toml` is missing or invalid, because the plugin acts on them without any configuration. The plugin rejects the whole call if any path in it is protected, resolves through a symbolic link to a protected path, or is outside the repository. A call whose paths cannot be parsed is also rejected.

### Goal file

`.cw/goal.md` holds a goal in your own words. When the file exists and is not blank, the plugin appends it to the injected instructions with a request to stay inside the goal and not widen it. Text beyond 4,000 characters is cut off, and the cut is marked. The file is always protected, with or without a configuration, so the model cannot edit the goal it is held to. Without the file, nothing is added. Only top-level sessions receive the goal. Role subprocesses and OpenCode child sessions do not.

How soon an edit takes effect depends on the host:

- OpenCode reads the file at every model call of a top-level session, so an edit applies to the next call.
- Kimi Code and Hermes Agent inject the goal with the first prompt of the session, and then behave as described in the next item for later prompts.
- Codex and Claude Code inject the goal at session start, `/clear`, and compaction. At each later prompt, the plugin compares the file with the version it injected last. If the file changed, it appends the new goal to the context. If you deleted the file, it tells the model that the earlier goal no longer applies. If the file did not change, it adds nothing, so the context does not grow every turn. The earlier version stays in the conversation history, followed by the newer one.

## Configuration

Configuration lives in two files under `.cw/`: the shared `project.toml` and one file for your host. The plugin reads both files on every event, so changes apply to the next event and need no restart. An unknown key in either file makes the whole configuration invalid. When configuration is invalid, the check and path protection stop. Codex and Claude Code show the error at session start and at the end of each turn. Kimi Code and Hermes Agent deliver it with the next prompt. OpenCode asks the model to relay the error at the end of a turn.

### `.cw/project.toml`

This file is shared with pi. Every section is optional except `version`.

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

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `version` | integer | Required | Must be `1`. |
| `check.cmd` | string array | Required in `[check]` | Program and arguments. Runs without a shell. |
| `check.timeout_s` | integer | `600` | Check timeout in seconds. Values above 3570 run as 3570, and the report states the value used. |
| `check.env` | string table | Empty | Extra environment variables for the check. |
| `protect.paths` | string array | Required in `[protect]` | Files or directories relative to the repository root. Wildcards, absolute paths, `..`, and paths under `.cw` are rejected. |
| `timeouts.<role>` | integer | `1800` for `research`, otherwise `300` | Default role timeout in seconds, from 300 to 1800. |
| `auto.review` | boolean | `false` | See [Automatic runs](#automatic-runs). |
| `auto.chronicle` | boolean | `false` | See [Automatic runs](#automatic-runs). |
| `auto.pause` | boolean | `false` | See [Automatic runs](#automatic-runs). |
| `router.url` | string | Required in `[router]` | Decision model endpoint. |
| `router.model` | string | Required in `[router]` | Decision model name. |
| `router.api_key_env` | string | None | Name of the variable that holds the API key. See [Limitations](#limitations). |
| `router.timeout_ms` | integer | `5000` | Request timeout in milliseconds. |
| `router.skip_below` | number | `0.1` | Skips a review when the problem probability is at or below this value. |
| `router.audit_rate` | number | `0.1` | Fraction of skipped reviews that run anyway. |

The `[models]` section of this file belongs to pi, and all five hosts ignore it.

### `.cw/codex.toml`

This optional file holds the settings that only apply to Codex.

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

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `models.<role>` | string | None | Codex model name for the role. A role without a model is unavailable. |
| `roles.sandbox` | `"read-only"` or `"none"` | `"read-only"` | Sandbox for role subprocesses. |

`"none"` runs role subprocesses with `--dangerously-bypass-approvals-and-sandbox`, so a role can write files if its model tries to. Codex shows a notice at session start when this value is set. Use `"none"` only on a machine where the Codex sandbox cannot start. The plugin does not fall back to `"none"` automatically.

The Codex sandbox needs unprivileged user namespaces on Linux. If `kernel.apparmor_restrict_unprivileged_userns` is `1`, `bubblewrap` cannot start and read-only roles cannot read files.

### `.cw/claude.toml`, `.cw/opencode.toml`, `.cw/kimi.toml`, and `.cw/hermes.toml`

These optional files hold the role models for Claude Code, OpenCode, Kimi Code, and Hermes Agent. They have the same `[models]` section as `codex.toml` and no `[roles]` section, because a role is restricted by tools or permissions rather than by a sandbox. A `[roles]` section in any of them makes the configuration invalid.

```toml
# .cw/claude.toml: an alias or a full model id, no whitespace
[models]
review = "sonnet"
over_review = "sonnet"
```

```toml
# .cw/opencode.toml: provider/model
[models]
review = "anthropic/claude-sonnet-4-5"
over_review = "anthropic/claude-sonnet-4-5"
```

```toml
# .cw/kimi.toml: an alias defined in Kimi's config.toml, no whitespace
[models]
review = "cw/terra"
over_review = "cw/terra"
```

```toml
# .cw/hermes.toml: provider/model, or a model name alone; no whitespace
[models]
review = "custom/gpt-5.6-terra"
over_review = "custom/gpt-5.6-terra"
```

OpenCode splits a model name at the first slash, so the model id after it can contain further slashes. Hermes Agent does the same and passes the part before the slash as `--provider`. A role without a model is unavailable.

## Role tools

The plugin gives the model five tools. On Codex, Claude Code, and Kimi Code, an MCP server provides them, and each call starts a one-shot `codex exec`, `claude -p`, or `kimi -p` subprocess. On OpenCode, the plugin registers the tools, and each call runs in a child session of the calling session. Hermes Agent has no role tools: its roles run only through `[auto]`. Inside a role's own session, these tools report that they are unavailable, so a role cannot start another role. Codex and Claude Code disable hooks in the subprocess. Kimi Code and Hermes Agent cannot, so the Kimi runner sets `CW_ROLE=1` in the subprocess environment, every hook of the plugin exits when it sees it, and the MCP server refuses role calls. Hermes hooks run in a shared gateway process that does not inherit the caller's environment, so the plugin recognises a role session by the marker `[counterweight-role:read]` or `[counterweight-role:none]` on the first line of its prompt, and sets `CW_ROLE=1` for the Node process itself. Each tool accepts an optional `timeout_s` from 300 to 1800. After a timeout, the result names the next value to try.

| Tool | Input | Result |
| --- | --- | --- |
| `cw_explore` | `question` | Locates code and cites `path:line`. |
| `cw_review` | `request`, `diff` | Reports what the change got wrong. |
| `cw_over_review` | `request`, `diff` | Reports what the change added without a current need. |
| `cw_research` | `question` | Answers a question that reading the code did not settle. |
| `cw_chronicle` | `report` | Rewrites `.cw/HISTORY.md` with the report folded in. |

A reviewer or the historian can reply with `ASK:` and a question instead of a result. The model then answers the question and calls the tool again. The historian writes nothing in that case.

The historian checks `.cw/HISTORY.md` again before writing. If the file changed during the run, the historian discards its result and the tool asks the model to report again. This covers concurrent runs from hooks, MCP, the OpenCode plugin, and pi.

Tool calls and role usage are recorded in `.cw/meter.jsonl`. When a role tool is called through the Claude Code MCP server, the `session` field of its lines is empty, because the server does not know the session.

## Automatic runs

By default, the model decides whether to call the role tools. The `[auto]` keys make the plugin run them instead. Each key needs models in your host file (`.cw/codex.toml`, `.cw/claude.toml`, `.cw/opencode.toml`, `.cw/kimi.toml`, or `.cw/hermes.toml`). If a model is missing, that key is turned off and the check and path protection continue to work. Codex and Claude Code show a notice at session start, and Kimi Code and Hermes Agent send it with the first prompt.

| Key | Needs | Behavior |
| --- | --- | --- |
| `auto.review` | `review`, `over_review` | At the end of a turn with changes, runs both reviewers in parallel on the diff from the start of the turn to now. The diff includes the content of new files and leaves out `.cw/`. `over_review` also receives the turn's commands (see below). Findings go back to the model once per turn. Later findings are only shown. Diffs longer than 80,000 characters are truncated. |
| `auto.chronicle` | `historian` | At the end of a turn with changes, sends a summary of the turn to the historian, unless the plugin is about to send review findings back to the model. In that case the historian runs at the end of the continued turn. Findings that are only shown do not stop it. |
| `auto.pause` | `planner` | Rejects the first source edit of each turn, once, and returns a plan from the `planner` role. Edits under `.cw/` and `tmp/` do not count. |

`over_review` receives the shell commands and file writes of the top-level agent in the current turn, listed after the diff. They are the calls, not their results. A diff does not show a command that changed no file, such as a rerun or a wider sweep. The list holds at most 40 entries. When it is longer, file writes are dropped first, and a command longer than 2,000 characters is left out. A call that path protection or `auto.pause` rejected is not listed. Commands run by sub-agents are not listed. `review` still judges the diff only.

A turn that ran commands but changed no file still runs `over_review`, without `review` or `auto.chronicle`. Its findings are shown but do not continue the turn, because the commands have already run and no file is left to change. They use up the turn's allowance for findings.

The review and the check are independent: a failed or timed-out automatic run produces no text and never changes the check result. The plan from `auto.pause` is advice. The model can disagree and resend the edit. If the planner fails, times out, or cannot read the session record, the edit goes through.

The check's repair turn and the review's repair turn have separate allowances, so one user turn can continue at most twice. On Kimi Code they share one allowance, with the check first, so a failing check suppresses the review of that turn. On OpenCode, the check and the automatic runs apply to top-level sessions only, and `auto.pause` skips child sessions.

## Guards and records

**Dangerous commands.** The shell tool of every host (`Bash` in Kimi Code, `terminal` in Hermes Agent) refuses the worst commands, with or without configuration: `rm` with recursive and force flags on `/`, `/*`, `~` or `$HOME`; `git push --force` (or `-f`, or a `+` refspec) to `main` or `master` (`--force-with-lease` is allowed); `mkfs`; and `dd` with `of=/dev/...` (except `/dev/null`). The command is split at unquoted `;`, `&&`, `||`, `|` and newlines, and each part is judged on its own. Text inside quotes is an argument, so `git commit -m "rm -rf /"` passes. `bash -c`, command substitution and variable assembly are not inspected. This is a guard against slips, not a security boundary.

**Write scope.** If `.cw/scope.txt` exists and has entries, the file-writing tools may only write paths under those entries. One repository-relative prefix per line; blank lines and lines starting with `#` are ignored; `src` covers `src` and `src/a.ts` but not `srcx`. Paths under `.cw/` are exempt. The file itself is always protected. The scope applies without a `project.toml`, follows symbolic links, and covers only the write tools, not the shell.

**Step cap for roles.** A role stops after 30 steps (`research` 80, `planner` 1). A step is one model request or tool call, counted the way each host can observe it: `--max-turns` on Claude Code (the flag is missing from `claude --help` but works), completed tool items in the `codex exec --json` output on Codex, `session.step.ended` events on OpenCode, assistant messages with tool calls in the `kimi -p --output-format stream-json` output on Kimi Code. Hermes Agent reports no steps, so its roles have no step cap. A stopped role returns `已达 <n> 步上限，已终止，拆小输入后重试`, the meter event gets `outcome: "budget"`, and nothing is retried. Tokens are not a limit, because Codex reports them only at the end. The reviewers are also told to read only the files the diff touches and their direct callers.

**Meter events.** `inject` is written when the instructions are injected: `{"host","version","goal","check"}`, at `SessionStart` on Codex and Claude Code, on the first model call of a top-level session on OpenCode, and with the first prompt of a session on Kimi Code and Hermes Agent. An evaluation can read it to tell whether injection really happened.

**Chronicle.** If `~/.agents/chronicle/` exists, the end of a turn (not a repair continuation) writes `events/<machine>/<id>.json` and `evidence/<machine>/<id>.json` there, following the steward chronicle layout. The directory is never created. `outcome` is `ok` when the check passed, `failed` when it did not, `cancelled` when it was cancelled, and `unknown` when there was no check; the evidence is the check report, or a `gap` that says why there is none. `project` is read from `projects.yaml` only for plain `/absolute/path: id` lines, and is `null` otherwise. A write failure never affects the turn. Claude Code does not run `Stop` when you press Esc, so a cancelled turn leaves no event there. On Kimi Code the event comes from `Stop`, so a turn that Kimi continues has no event, because Kimi runs no later `Stop` for it. On Hermes Agent `on_session_end` writes one event per turn; a turn without a code edit has `outcome` `unknown` and a `gap` that names the turn's exit reason, and an interrupted turn has `cancelled`.

## Sharing `.cw` with pi

A `.cw/project.toml` that is valid for pi is also valid here. `[check]`, `[protect]`, `[timeouts]`, `[auto]`, and `[router]` apply to both tools. Models differ because pi requires `provider/model` names, so pi reads `[models]` from `project.toml` and each host here reads `[models]` from its own file. Do not add host settings to `project.toml`, because pi rejects unknown keys.

All tools append to the same `.cw/meter.jsonl` and share `.cw/HISTORY.md`.

The tools treat an `[auto]` key without a model differently. Codex, Claude Code, and OpenCode turn off that key. pi rejects the whole configuration, so a project that uses pi needs models in both files.

## Limitations

Limits on every host:

- Path protection covers only the file-writing tools listed in [Differences between hosts](#differences-between-hosts). Shell commands and other tools can still write to protected paths, and the plugin does not report those writes.
- The check result depends on the exit code alone. The plugin does not detect skipped or weakened tests.
- `[router]` applies to direct `cw_review` and `cw_over_review` calls. `auto.review` always runs the reviewers.
- The role runner of each host depends on that host's output or API format. An update of the host can change it.
- The plugin does not record the commands and file writes of sub-agents, so `over_review` does not see them.
- If the snapshot at the start of the turn fails, the plugin compares against `HEAD` instead. Files that were already uncommitted then count as changes.

Codex CLI:

- If the hook process crashes before it returns a decision, Codex allows the tool call.
- `codex exec` skips untrusted hooks without a notice. The TUI asks you to review them at startup.
- After an update changes a hook, you need to trust that hook again. Version 0.4.0 of the Codex plugin changes what its hooks do (dangerous commands, scope, inject and chronicle events), so Codex asks you to review the hooks again after you update to it. Claude Code 0.3.0 changes its hooks the same way, so expect the project trust prompt again there.
- The `planner` role runs without the shell and web search. It was not verified that `apply_patch` is also unavailable to this role, so its restriction also relies on its instructions.
- `sandbox = "none"` limits a role through its instructions only.
- The MCP server receives only `HOME`, `LANG`, `LC_ALL`, `LOGNAME`, `PATH`, `SHELL`, `TERM`, `USER`, `CODEX_HOME`, and `OPENAI_API_KEY`. A key that `router.api_key_env` names under any other variable never reaches the server. The router then counts as failed, and the review runs as usual.
- The role runner depends on the `codex exec --json` event format.

Claude Code:

- Claude Code has no usage hook, so the plugin reads the transcript. At the end of a turn, the transcript can lack the last assistant message. That message is recorded at the next scan, which happens at the next turn end or at session end. Usage lines from the transcript have `cost_total` set to `null`.
- The MCP server finds the repository from `CLAUDE_PROJECT_DIR`, or from its working directory when that variable is not set. It records no session for role tools.
- The `systemMessage` report is not part of the `--output-format json` output of print mode.
- A role can read and search files but cannot edit them, because it only has the tools `Read` and `Grep`.
- The role runner depends on the JSON object that `claude -p --output-format json` prints.

OpenCode:

- OpenCode gives a plugin no way to show text to you. A passing check shows nothing, and you confirm it in `.cw/meter.jsonl`. A first failure goes back to the model for a repair. If the check fails again, the plugin sends one more message that asks the model to repeat the report to you without changing files, which costs one model call. The model might not repeat the report word for word. The same applies to a configuration error and to review findings that remain after the repair.
- The plugin sends that message once per prompt. Interrupting a turn stops a running check or role, and the plugin then sends no continuation.
- A role is restricted by denying `edit` and `shell` in its child session. Other tools stay available to it, except for the `planner`, which denies every tool.
- Each role call leaves a child session in OpenCode's session list. The plugin does not delete it.
- Usage comes from finished steps and records input, output, and cache tokens. Reasoning tokens are not recorded separately.
- The idle callback the plugin uses is named `experimental.idle` in OpenCode and may change.

Kimi Code:

- Kimi Code has no display at the end of a turn, so the plugin stores the report and appends it to the next prompt. After the last turn of a session, or in one-shot mode, nobody sees it. It is still in `.cw/meter.jsonl` as a `check` event.
- Kimi runs the `Stop` hook once per turn. After the repair turn, no hook runs, so the plugin does not check whether the repair worked, and it writes no chronicle event for that turn. The check runs again at the end of the next turn.
- The time budget of 600 seconds covers the check (at most 300 seconds), the reviewers (at most 270 seconds, in parallel), and the historian (at most 270 seconds, afterwards). When all three run long, the total exceeds 600 seconds. By reading Kimi's bundled source, Kimi then kills the hook and lets the turn end. This was not run.
- A check with the default `timeout_s = 600` always reports `check.timeout_s=600 超过上限，实际超时 300s`. Set `check.timeout_s` to 300 or less to avoid the note.
- The MCP server learns the repository from the working directory of its parent process, read from `/proc`, which exists on Linux only. Without it, the server falls back to the `PWD` variable. It records no session for role tools.
- In one-shot mode (`kimi -p`) Kimi does not run `SessionEnd`, so the plugin never removes its turn state under `$KIMI_CODE_HOME/counterweight` (`~/.kimi-code/counterweight` when the variable is not set). Usage is still recorded at each prompt and `Stop`.
- Each role call leaves a session in Kimi's session list. The plugin does not delete it. A role that the plugin aborts (step cap or timeout) leaves no usage record, because the session id arrives only at the end of the run.
- A role message above 100,000 bytes does not fit on the command line. The plugin writes it to a file and asks the role to read it. The `planner` has no tools, so a message that long fails for the `planner`, and `auto.pause` lets the edit through.
- Usage lines have `cost_total` set to `null`. A usage record has no id of its own, so the plugin identifies it by agent, time, model, and the four token counts.
- The role runner depends on the stream-json lines of `kimi -p` and on the `wire.jsonl` format.
- The slash form of the setup skill, `/skill:counterweight:cw-setup`, and the interactive terminal UI at the end of a turn were not tested.

Hermes Agent:

- Hermes Agent has no display for a plugin at the end of a turn either. The plugin appends the report to the context of the next turn. `on_session_end` fires after every turn, so it can store the pending count, but it cannot show anything.
- The check runs only in `pre_verify`, which Hermes fires when the turn edited code. A turn that only answers a question has no check, and its chronicle event has `outcome` `unknown`.
- Hermes bounds a plugin's `pre_verify` callback by `plugins.hook_callback_timeout` (default 30 seconds, at most 600) and then lets the turn finish. In a test with the default, a callback that slept 35 seconds returned a continuation that Hermes did not use. The plugin therefore shrinks the check and the roles to fit the configured value, and the report names the value used. Without raising the setting, a check of more than 15 seconds always times out.
- The plugin finds the project through `resolve_agent_cwd()` of Hermes, falls back to the repository of an absolute tool path, `workdir`, or `changed_paths`, and otherwise does not guess: it refuses a write, skips the check, and says so in the next turn. `resolve_agent_cwd()` is an internal function of Hermes and may change.
- Hooks run in the gateway process, which is shared by all sessions and does not inherit your environment. The plugin cannot read `CW_ROLE` from there, so it recognises roles by the first line of their prompt. A user message that starts with `[counterweight-role:` makes that session read-only.
- A role can read and search files only because the plugin blocks every other tool in its session, while `-t file` still offers `write_file` and `patch`. In a real `hermes -z` run whose prompt starts with the marker and asks for `write_file`, the plugin refused the call and no file was created.
- Roles have no step cap. A role that hits its timeout is killed, and its usage is lost unless Hermes already wrote the usage file.
- PAUSE gives the planner the conversation up to the start of the turn plus the tool calls and results of the turn so far.
- Usage is what Hermes reports in `post_api_request`: `input_tokens` and the cache counts as it gives them. Auxiliary calls, such as the title generation, are not recorded. Usage lines have `cost_total` set to `null`.
- The first run of Hermes in a new `HERMES_HOME` installs its Python dependencies there. This takes some time and about 400 MB.
- Interactive chat, the terminal UI, and messaging platforms were not tested, nor was installing the plugin with `hermes plugins install`.

## Troubleshooting

| Symptom | Cause | Action |
| --- | --- | --- |
| No `[counterweight]` line appears at the end of a turn on Codex | The hooks are not trusted, or `[check]` is missing | Open `/hooks` in Codex and trust the hooks. Confirm that `.cw/project.toml` has a `[check]` section. |
| No `[counterweight]` line appears at the end of a turn on Claude Code | The plugin is not enabled, the project is not trusted, or `[check]` is missing | Enable the plugin and accept the trust dialog. Confirm that the session context contains `Counterweight <version> active`, and that `.cw/project.toml` has a `[check]` section. |
| Nothing appears after a turn on Kimi Code or Hermes Agent | Neither host has a display at the end of a turn | Send the next prompt, or look for a `check` event in `.cw/meter.jsonl`. On Hermes Agent, also check that the turn edited code, because a question-only turn has no check. |
| Hermes Agent runs no check and writes nothing to `.cw/meter.jsonl` | The plugin is not enabled in the gateway, `node` is not on the gateway's `PATH`, or the session directory is not in a Git repository | Run `hermes plugins list`, put `node` on the `PATH` of the gateway (`hermes gateway restart` after changing it), and start Hermes in a Git repository. |
| The Hermes report says the actual check timeout is 15 seconds | `plugins.hook_callback_timeout` is at its default of 30 seconds | Run `hermes config set plugins.hook_callback_timeout 600`. |
| Kimi Code runs no hooks | The plugin is not installed or enabled, or Kimi has not reloaded it | Open `/plugins` to check that `counterweight` is enabled, then run `/new` or `/reload`. |
| Nothing appears at the end of a turn on OpenCode | OpenCode shows nothing for a passing check | Look for a `check` event in `.cw/meter.jsonl`. If there is none, confirm that `.cw/project.toml` has a `[check]` section and that the plugin is installed. |
| The report says `配置非法` | A file under `.cw/` has an unknown key or an invalid value | Fix the key named in the message. |
| The model cannot edit a file under a protected path | The path matches `protect.paths` | Edit the file yourself, or change `protect.paths`. |
| The model cannot edit a file under `.cw/` | `project.toml`, `goal.md`, `scope.txt`, and the five host files are always protected | Edit the file yourself. |
| A role tool reports `未配置 [models].<role>` | The role has no model | Add the role to `[models]` in your host file. |
| A role cannot read files on Codex | The Codex sandbox cannot start on this machine | Check `kernel.apparmor_restrict_unprivileged_userns`, or set `roles.sandbox = "none"`. |
| A role reports `未正常结束` | The role's turn did not complete | Read the reason in the message and call the tool again. |
| A role reports a timeout | The input took longer than `timeout_s` | Retry with the value in the message. At 1800 seconds, split the input. |
| `[auto]` does nothing | The key has no model, or the turn changed no files | Check the notice at session start, and confirm that the turn changed files. A turn without changes still runs `over_review` if it ran commands. |

## Development

```sh
npm ci
npm run typecheck
npm test
```

Files under `src/core/` named `budget.ts`, `danger.ts`, `scope.ts`, `chronicle-event.ts` and `pending.ts` are identical to the ones in [pi-counterweight](https://github.com/nerdneilsfield/pi-counterweight). Run `npm run check:sync` before a release to compare them byte for byte; it skips with a note when `../pi-counterweight` is missing. `npm test` does not call it.

`npm test` builds the bundles first. Tests put a fake `codex`, `claude`, `kimi`, or `hermes` executable first on `PATH` and drive the OpenCode plugin with a fake context object, so they need no model credentials. The Hermes plugin's Python file is tested by loading it with a stub of the Hermes API and a fake `node`. The bundles in `plugins/codex-counterweight/dist/`, `plugins/claude-counterweight/dist/`, `plugins/kimi-counterweight/dist/`, `plugins/hermes-counterweight/dist/`, and `plugins/opencode-counterweight/index.js` are committed because plugin installation does not run `npm install`. Run `npm run bundle` before you commit a source change.

The design and measured Codex behavior are recorded in [`docs/superpowers/specs/2026-11-04-codex-counterweight-design.md`](docs/superpowers/specs/2026-11-04-codex-counterweight-design.md) and [`docs/plans/2026-11-04-v2-roles.md`](docs/plans/2026-11-04-v2-roles.md). The Claude Code and OpenCode design and the measured behavior of both hosts are in [`docs/plans/2026-11-04-claude-opencode.md`](docs/plans/2026-11-04-claude-opencode.md). The Kimi Code and Hermes Agent design and the events and payloads measured on the real binaries are in [`docs/plans/2026-11-05-kimi-hermes.md`](docs/plans/2026-11-05-kimi-hermes.md).

The features of Kimi Code and Hermes Agent were run against the real binaries with a real model (`gpt-5.6-terra`, through a local OpenAI-compatible proxy and a temporary home directory for each host): the end check with one repair, protected paths, `goal.md`, `scope.txt`, the dangerous-command guard, PAUSE, `auto.review`, `auto.chronicle`, the pending count, injection, usage, a role tool (Kimi Code only), and the delivery of a report with the next prompt. Everything else in the test suite ran against fake executables, not against a model.

## License

[MIT](LICENSE) © DengQi
