# codex-counterweight

English | [简体中文](README.zh-CN.md)

[![Version](https://img.shields.io/badge/version-0.3.0-blue)](plugins/codex-counterweight/.codex-plugin/plugin.json)
[![License: MIT](https://img.shields.io/github/license/nerdneilsfield/codex-counterweight)](LICENSE)
[![Tested with Codex CLI 0.166.0](https://img.shields.io/badge/tested%20with-Codex%20CLI%200.166.0-412991)](https://github.com/openai/codex/releases/tag/rust-v0.166.0)
[![Tested with Claude Code 2.1.318](https://img.shields.io/badge/tested%20with-Claude%20Code%202.1.318-D97757)](https://www.npmjs.com/package/@anthropic-ai/claude-code/v/2.1.318)
[![Tested with OpenCode 2.2.5](https://img.shields.io/badge/tested%20with-OpenCode%202.2.5-211E1E)](https://github.com/anomalyco/opencode/releases/tag/v2.2.5)
[![Node.js >= 22.19](https://img.shields.io/badge/node-%3E%3D22.19-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-7.0-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Tested on Linux](https://img.shields.io/badge/tested%20on-Linux-FCC624?logo=linux&logoColor=black)](#limitations)
[![Last commit](https://img.shields.io/github/last-commit/nerdneilsfield/codex-counterweight)](https://github.com/nerdneilsfield/codex-counterweight/commits)
[![Issues](https://img.shields.io/github/issues/nerdneilsfield/codex-counterweight)](https://github.com/nerdneilsfield/codex-counterweight/issues)

codex-counterweight is a plugin for Codex CLI, Claude Code, and OpenCode that enforces a project's end-of-turn check. When a turn ends, the plugin runs the command you configured. If the command fails, the plugin returns the output to the model once, and the model gets one more turn to fix the failure. A second failure is reported to you and does not trigger another retry.

The plugin also rejects writes to paths you protect, injects a set of working instructions into each session, and records model usage. Optional role tools run a separate model for code exploration, review, research, planning, and project history. All three hosts share one core and one set of roles; they differ in how they show results and how they restrict roles, as described in [Differences between hosts](#differences-between-hosts).

This plugin reduces mistakes by a cooperative model. It is not a security boundary: shell commands can still write to protected paths. See [Limitations](#limitations).

It is the Codex, Claude Code, and OpenCode counterpart of [pi-counterweight](https://github.com/nerdneilsfield/pi-counterweight), and all of them can share one `.cw/project.toml`.

## Contents

- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Differences between hosts](#differences-between-hosts)
- [What the plugin does](#what-the-plugin-does)
- [Configuration](#configuration)
- [Role tools](#role-tools)
- [Automatic runs](#automatic-runs)
- [Sharing `.cw` with pi](#sharing-cw-with-pi)
- [Limitations](#limitations)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

## Requirements

- One of the following hosts. Each version was tested on Linux. Other versions and platforms are untested.
  - Codex CLI 0.166.0.
  - Claude Code 2.1.318.
  - OpenCode 2.2.5.
- Node.js 22.19 or later, available as `node` on `PATH`. Codex and Claude Code run the hooks and the MCP server with it.
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

3. Start your host in that directory: `codex`, `claude`, or `opencode`.

4. Trust the plugin if the host asks. Codex shows **Hooks need review**, and the plugin does nothing until you trust its hooks. Claude Code shows its project trust dialog. OpenCode loads the plugin without a dialog.

5. Send this request to the model:

   ```text
   Create hello.js that prints Hello, Counterweight!
   ```

On Codex and Claude Code, the host shows a report similar to the following line when the turn ends. The report text is in Chinese. `结束检查通过` means that the end check passed, and `退出码 0` means exit code 0.

```text
[counterweight] 结束检查通过：`node --check hello.js` 退出码 0（0.1s）
```

OpenCode shows nothing when a check passes. To confirm that the check ran, look for a `check` event in `.cw/meter.jsonl`:

```sh
grep '"event":"check"' .cw/meter.jsonl
```

A passing run has `"outcome":"passed"` in the line.

To use the plugin in your own project, replace `cmd` with a command that exits on its own, such as `["npm", "test"]`. Each host also has a setup command that checks that the plugin is active and helps you write the file: `$cw-setup` in Codex, `/counterweight:cw-setup` in Claude Code, and `/cw-setup` in OpenCode. Claude Code namespaces the command with the plugin name.

## Differences between hosts

The behavior described in the rest of this document is the same on all three hosts, except for the points in the following table.

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

## What the plugin does

The plugin acts on the following events of each host.

| Action | Codex CLI | Claude Code | OpenCode |
| --- | --- | --- | --- |
| Injects the working instructions | Session start, `/clear`, compaction | Session start, `/clear`, compaction | Every model call of a top-level session |
| Stores the prompt for automatic reviews | User prompt | User prompt | Prompt |
| Rejects writes to protected paths, and optionally pauses the first source edit | `apply_patch` | `Edit`, `Write`, `NotebookEdit` | `write`, `edit`, `patch` |
| Records the turn's shell commands and file writes for `auto.review` | `Bash`, `exec_command`, `shell_command`, `apply_patch` | `Bash`, `Edit`, `Write`, `NotebookEdit` | `shell`, `write`, `edit`, `patch` |
| Appends token usage to `.cw/meter.jsonl` | Model response | Transcript scan at turn end and session end | Finished step |
| Runs the check, then any automatic runs | Turn end | Turn end | Session idle |

Without `.cw/project.toml`, the plugin allows every write and does nothing at the end of a turn. Two actions still apply to every repository where the plugin is enabled:

- The injected instructions change how the model behaves. They ask for direct answers in Chinese and tell the model to avoid abstractions that no current requirement needs. The text is in [`src/roles/prompts.ts`](src/roles/prompts.ts).
- The plugin creates `.cw/meter.jsonl` in each repository. Add `.cw/` to the repository's `.gitignore` if you do not want to track this file.

### End check

The plugin runs the check at the end of every completed turn, including turns that only answer a question, so choose a command with an acceptable duration. Only the exit code decides the result. The command runs from the repository root and does not go through a shell, so `npm test && npm run bundle` is not a valid single command. Put combined checks in a script.

If the check fails, the plugin sends the exit code and up to 80 lines or 16 KiB of each output stream back to the model, then the host continues the turn. Each turn gets one such retry. If the check fails again, the plugin shows the result and stops.

A check that exceeds its timeout counts as a failure. The plugin sends `SIGTERM` to the check's process group, then `SIGKILL` 5 seconds later. If you interrupt a turn while the check runs, Codex and Claude Code kill the hook, and a watchdog process kills the check. OpenCode aborts the check and sends no continuation. An interrupted check produces no result.

### Protected paths

`.cw/project.toml`, `.cw/goal.md`, `.cw/codex.toml`, `.cw/claude.toml`, and `.cw/opencode.toml` are always protected once configuration loads, on every host. The plugin rejects the whole call if any path in it is protected, resolves through a symbolic link to a protected path, or is outside the repository. A call whose paths cannot be parsed is also rejected.

### Goal file

`.cw/goal.md` holds a goal in your own words. When the file exists and is not blank, the plugin appends it to the injected instructions with a request to stay inside the goal and not widen it. Text beyond 4,000 characters is cut off, and the cut is marked. The file is always protected, so the model cannot edit the goal it is held to. Without the file, nothing is added. Only top-level sessions receive the goal. Role subprocesses and OpenCode child sessions do not.

How soon an edit takes effect depends on the host:

- OpenCode reads the file at every model call of a top-level session, so an edit applies to the next call.
- Codex and Claude Code inject the goal at session start, `/clear`, and compaction. At each later prompt, the plugin compares the file with the version it injected last. If the file changed, it appends the new goal to the context. If you deleted the file, it tells the model that the earlier goal no longer applies. If the file did not change, it adds nothing, so the context does not grow every turn. The earlier version stays in the conversation history, followed by the newer one.

## Configuration

Configuration lives in two files under `.cw/`: the shared `project.toml` and one file for your host. The plugin reads both files on every event, so changes apply to the next event and need no restart. An unknown key in either file makes the whole configuration invalid. When configuration is invalid, the check and path protection stop. Codex and Claude Code show the error at session start and at the end of each turn. OpenCode asks the model to relay the error at the end of a turn.

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

The `[models]` section of this file belongs to pi, and the three hosts ignore it.

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

### `.cw/claude.toml` and `.cw/opencode.toml`

These optional files hold the role models for Claude Code and OpenCode. They have the same `[models]` section as `codex.toml` and no `[roles]` section, because a role is restricted by tools or permissions rather than by a sandbox. A `[roles]` section in either file makes the configuration invalid.

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

OpenCode splits a model name at the first slash, so the model id after it can contain further slashes. A role without a model is unavailable.

## Role tools

The plugin gives the model five tools. On Codex and Claude Code, an MCP server provides them, and each call starts a one-shot `codex exec` or `claude -p` subprocess with hooks disabled. On OpenCode, the plugin registers the tools, and each call runs in a child session of the calling session. Inside a role's own session, these tools report that they are unavailable, so a role cannot start another role. Each tool accepts an optional `timeout_s` from 300 to 1800. After a timeout, the result names the next value to try.

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

By default, the model decides whether to call the role tools. The `[auto]` keys make the plugin run them instead. Each key needs models in your host file (`.cw/codex.toml`, `.cw/claude.toml`, or `.cw/opencode.toml`). If a model is missing, that key is turned off and the check and path protection continue to work. Codex and Claude Code show a notice at session start.

| Key | Needs | Behavior |
| --- | --- | --- |
| `auto.review` | `review`, `over_review` | At the end of a turn with changes, runs both reviewers in parallel on the diff against `HEAD`. `over_review` also receives the turn's commands (see below). Findings go back to the model once per turn. Later findings are only shown. Diffs longer than 80,000 characters are truncated. |
| `auto.chronicle` | `historian` | At the end of a turn with changes and no findings, sends a summary of the turn to the historian. |
| `auto.pause` | `planner` | Rejects the first source edit of each turn, once, and returns a plan from the `planner` role. Edits under `.cw/` and `tmp/` do not count. |

`over_review` receives the shell commands and file writes of the top-level agent in the current turn, listed after the diff. They are the calls, not their results. A diff does not show a command that changed no file, such as a rerun or a wider sweep. The list holds at most 40 entries. When it is longer, file writes are dropped first, and a command longer than 2,000 characters is left out. A call that path protection or `auto.pause` rejected is not listed. Commands run by sub-agents are not listed. `review` still judges the diff only.

A turn that ran commands but changed no file still runs `over_review`, without `review` or `auto.chronicle`. Its findings are shown but do not continue the turn, because the commands have already run and no file is left to change. They use up the turn's allowance for findings.

The review and the check are independent: a failed or timed-out automatic run produces no text and never changes the check result. The plan from `auto.pause` is advice. The model can disagree and resend the edit. If the planner fails, times out, or cannot read the session record, the edit goes through.

The check's repair turn and the review's repair turn have separate allowances, so one user turn can continue at most twice. On OpenCode, the check and the automatic runs apply to top-level sessions only, and `auto.pause` skips child sessions.

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

Codex CLI:

- If the hook process crashes before it returns a decision, Codex allows the tool call.
- `codex exec` skips untrusted hooks without a notice. The TUI asks you to review them at startup.
- After an update changes a hook, you need to trust that hook again. Version 0.3.0 of the Codex plugin widens the `PreToolUse` matcher to shell tools, so Codex asks you to review the hooks again after you update to it.
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

## Troubleshooting

| Symptom | Cause | Action |
| --- | --- | --- |
| No `[counterweight]` line appears at the end of a turn on Codex | The hooks are not trusted, or `[check]` is missing | Open `/hooks` in Codex and trust the hooks. Confirm that `.cw/project.toml` has a `[check]` section. |
| No `[counterweight]` line appears at the end of a turn on Claude Code | The plugin is not enabled, the project is not trusted, or `[check]` is missing | Enable the plugin and accept the trust dialog. Confirm that the session context contains `Counterweight <version> active`, and that `.cw/project.toml` has a `[check]` section. |
| Nothing appears at the end of a turn on OpenCode | OpenCode shows nothing for a passing check | Look for a `check` event in `.cw/meter.jsonl`. If there is none, confirm that `.cw/project.toml` has a `[check]` section and that the plugin is installed. |
| The report says `配置非法` | A file under `.cw/` has an unknown key or an invalid value | Fix the key named in the message. |
| The model cannot edit a file under a protected path | The path matches `protect.paths` | Edit the file yourself, or change `protect.paths`. |
| The model cannot edit a file under `.cw/` | `project.toml`, `goal.md`, and the three host files are always protected | Edit the file yourself. |
| A role tool reports `未配置 [models].<role>` | The role has no model | Add the role to `[models]` in your host file. |
| A role cannot read files on Codex | The Codex sandbox cannot start on this machine | Check `kernel.apparmor_restrict_unprivileged_userns`, or set `roles.sandbox = "none"`. |
| A role reports `未正常结束` | The role's turn did not complete | Read the reason in the message and call the tool again. |
| A role reports a timeout | The input took longer than `timeout_s` | Retry with the value in the message. At 1800 seconds, split the input. |
| `[auto]` does nothing | The key has no model, or the work tree has no changes | Check the notice at session start, and confirm that the turn changed files. A turn without changes still runs `over_review` if it ran commands. |

## Development

```sh
npm ci
npm run typecheck
npm test
```

`npm test` builds the bundles first. Tests put a fake `codex` or `claude` executable first on `PATH` and drive the OpenCode plugin with a fake context object, so they need no model credentials. The bundles in `plugins/codex-counterweight/dist/`, `plugins/claude-counterweight/dist/`, and `plugins/opencode-counterweight/index.js` are committed because plugin installation does not run `npm install`. Run `npm run bundle` before you commit a source change.

The design and measured Codex behavior are recorded in [`docs/superpowers/specs/2026-11-04-codex-counterweight-design.md`](docs/superpowers/specs/2026-11-04-codex-counterweight-design.md) and [`docs/plans/2026-11-04-v2-roles.md`](docs/plans/2026-11-04-v2-roles.md). The Claude Code and OpenCode design and the measured behavior of both hosts are in [`docs/plans/2026-11-04-claude-opencode.md`](docs/plans/2026-11-04-claude-opencode.md).

## License

[MIT](LICENSE) © DengQi
