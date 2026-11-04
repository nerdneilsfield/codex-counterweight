# codex-counterweight

English | [简体中文](README.zh-CN.md)

[![Version](https://img.shields.io/badge/version-0.2.0-blue)](plugins/codex-counterweight/.codex-plugin/plugin.json)
[![License: MIT](https://img.shields.io/github/license/nerdneilsfield/codex-counterweight)](LICENSE)
[![Tested with Codex CLI 0.166.0](https://img.shields.io/badge/tested%20with-Codex%20CLI%200.166.0-412991)](https://github.com/openai/codex/releases/tag/rust-v0.166.0)
[![Node.js >= 22.19](https://img.shields.io/badge/node-%3E%3D22.19-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-7.0-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Tested on Linux](https://img.shields.io/badge/tested%20on-Linux-FCC624?logo=linux&logoColor=black)](#limitations)
[![Last commit](https://img.shields.io/github/last-commit/nerdneilsfield/codex-counterweight)](https://github.com/nerdneilsfield/codex-counterweight/commits)
[![Issues](https://img.shields.io/github/issues/nerdneilsfield/codex-counterweight)](https://github.com/nerdneilsfield/codex-counterweight/issues)

codex-counterweight is a Codex CLI plugin that enforces a project's end-of-turn check. When a turn ends, the plugin runs the command you configured. If the command fails, the plugin returns the output to the model once, and the model gets one more turn to fix the failure. A second failure is reported to you and does not trigger another retry.

The plugin also rejects `apply_patch` writes to paths you protect, injects a set of working instructions into each session, and records model usage. Optional role tools run a separate model for code exploration, review, research, planning, and project history.

This plugin reduces mistakes by a cooperative model. It is not a security boundary: shell commands can still write to protected paths. See [Limitations](#limitations).

It is the Codex counterpart of [pi-counterweight](https://github.com/nerdneilsfield/pi-counterweight), and both tools can share one `.cw/project.toml`.

## Contents

- [Requirements](#requirements)
- [Quick start](#quick-start)
- [What the plugin does](#what-the-plugin-does)
- [Configuration](#configuration)
- [Role tools](#role-tools)
- [Automatic runs](#automatic-runs)
- [Sharing `.cw` with pi](#sharing-cw-with-pi)
- [Limitations](#limitations)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

## Requirements

- Codex CLI. This version was tested with 0.166.0 on Linux. Other versions and platforms are untested.
- Node.js 22.19 or later, available as `node` on `PATH`.
- Git. The plugin uses the Git work tree root to find `.cw/`. Outside a Git repository, it uses the current directory.

## Quick start

This walkthrough runs a syntax check in a new practice directory, so it needs no existing project.

1. Add the marketplace and install the plugin:

   ```sh
   codex plugin marketplace add nerdneilsfield/codex-counterweight
   codex plugin add codex-counterweight@codex-counterweight
   ```

2. Create a practice repository:

   ```sh
   mkdir -p ~/counterweight-demo/.cw
   cd ~/counterweight-demo
   git init
   ```

3. Create `.cw/project.toml` with this content:

   ```toml
   version = 1

   [check]
   cmd = ["node", "--check", "hello.js"]
   ```

4. Start Codex in that directory:

   ```sh
   codex
   ```

5. When Codex shows **Hooks need review**, review the hooks and trust them. The plugin does nothing until you trust its hooks.

6. Send this request to Codex:

   ```text
   Create hello.js that prints Hello, Counterweight!
   ```

When the turn ends, Codex shows a report similar to the following line. The report text is in Chinese. `结束检查通过` means that the end check passed, and `退出码 0` means exit code 0.

```text
[counterweight] 结束检查通过：`node --check hello.js` 退出码 0（0.1s）
```

To use the plugin in your own project, replace `cmd` with a command that exits on its own, such as `["npm", "test"]`. In a Codex session, you can also run `$cw-setup`, which checks that the hooks are active and helps you write the file.

## What the plugin does

The plugin acts on the following Codex hook events.

| Event | Action | Without `.cw/project.toml` |
| --- | --- | --- |
| Session start, `/clear`, compaction | Injects the working instructions. | Same |
| User prompt | Stores the prompt for automatic reviews. | Same |
| `apply_patch` | Rejects writes to protected paths. Optionally pauses the first source edit. | Allows every write |
| Model response | Appends token usage to `.cw/meter.jsonl`. | Same |
| Turn end | Runs the check, then any automatic runs. | Does nothing |

Two of these actions apply to every repository where the plugin is enabled, even without a configuration file:

- The injected instructions change how the model behaves. They ask for direct answers in Chinese and tell the model to avoid abstractions that no current requirement needs. The text is in [`src/roles/prompts.ts`](src/roles/prompts.ts).
- The plugin creates `.cw/meter.jsonl` in each repository. Add `.cw/` to the repository's `.gitignore` if you do not want to track this file.

### End check

The plugin runs the check at the end of every completed turn, including turns that only answer a question, so choose a command with an acceptable duration. Only the exit code decides the result. The command runs from the repository root and does not go through a shell, so `npm test && npm run build` is not a valid single command. Put combined checks in a script.

If the check fails, the plugin sends the exit code and up to 80 lines or 16 KiB of each output stream back to the model, then Codex continues the turn. Each turn gets one such retry. If the check fails again, the plugin shows the result and stops.

A check that exceeds its timeout counts as a failure. The plugin sends `SIGTERM` to the check's process group, then `SIGKILL` 5 seconds later. If you interrupt a turn while the check runs, Codex kills the hook, and a watchdog process kills the check. An interrupted check produces no result.

### Protected paths

`.cw/project.toml` and `.cw/codex.toml` are always protected once configuration loads. The plugin rejects the whole patch if any path in the patch is protected, resolves through a symbolic link to a protected path, or is outside the repository. A patch whose paths cannot be parsed is also rejected.

## Configuration

Configuration lives in two files under `.cw/`. Codex hooks read both files on every event, so changes apply to the next event and need no restart. An unknown key in either file makes the whole configuration invalid. When configuration is invalid, the check and path protection stop, and Codex shows the error at session start and at the end of each turn.

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

The `[models]` section of this file belongs to pi, and Codex ignores it.

### `.cw/codex.toml`

This optional file holds settings that only apply to Codex.

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

## Role tools

The plugin's MCP server gives the model five tools. Each tool starts a one-shot `codex exec` subprocess that has hooks and plugins disabled. Each tool accepts an optional `timeout_s` from 300 to 1800. After a timeout, the result names the next value to try.

| Tool | Input | Result |
| --- | --- | --- |
| `cw_explore` | `question` | Locates code and cites `path:line`. |
| `cw_review` | `request`, `diff` | Reports what the change got wrong. |
| `cw_over_review` | `request`, `diff` | Reports what the change added without a current need. |
| `cw_research` | `question` | Answers a question that reading the code did not settle. |
| `cw_chronicle` | `report` | Rewrites `.cw/HISTORY.md` with the report folded in. |

A reviewer or the historian can reply with `ASK:` and a question instead of a result. The model then answers the question and calls the tool again. The historian writes nothing in that case.

The historian checks `.cw/HISTORY.md` again before writing. If the file changed during the run, the historian discards its result and the tool asks the model to report again. This covers concurrent runs from hooks, MCP, and pi.

Tool calls and role usage are recorded in `.cw/meter.jsonl`.

## Automatic runs

By default, the model decides whether to call the role tools. The `[auto]` keys make the plugin run them instead. Each key needs models in `.cw/codex.toml`. If a model is missing, that key is turned off and Codex shows a notice at session start, while the check and path protection continue to work.

| Key | Needs | Behavior |
| --- | --- | --- |
| `auto.review` | `review`, `over_review` | At the end of a turn with changes, runs both reviewers in parallel on the diff against `HEAD`. Findings go back to the model once per turn. Later findings are only shown. Diffs longer than 80,000 characters are truncated. |
| `auto.chronicle` | `historian` | At the end of a turn with changes and no findings, sends a summary of the turn to the historian. |
| `auto.pause` | `planner` | Rejects the first source edit of each turn, once, and returns a plan from the `planner` role. Edits under `.cw/` and `tmp/` do not count. |

The review and the check are independent: a failed or timed-out automatic run produces no text and never changes the check result. The plan from `auto.pause` is advice. The model can disagree and resend the edit. If the planner fails, times out, or cannot read the session record, the edit goes through.

The check's repair turn and the review's repair turn have separate allowances, so one user turn can continue at most twice.

## Sharing `.cw` with pi

A `.cw/project.toml` that is valid for pi is also valid here. `[check]`, `[protect]`, `[timeouts]`, `[auto]`, and `[router]` apply to both tools. Models differ because pi requires `provider/model` names, so pi reads `[models]` from `project.toml` and Codex reads `[models]` from `codex.toml`. Do not add Codex settings to `project.toml`, because pi rejects unknown keys.

Both tools append to the same `.cw/meter.jsonl` and share `.cw/HISTORY.md`.

The two tools treat an `[auto]` key without a model differently. Codex turns off that key. pi rejects the whole configuration, so a project that uses both tools needs models in both files.

## Limitations

- Path protection covers `apply_patch` only. Shell commands and other tools can still write to protected paths, and the plugin does not report those writes.
- If the hook process crashes before it returns a decision, Codex allows the tool call.
- `codex exec` skips untrusted hooks without a notice. The TUI asks you to review them at startup.
- After an update changes a hook, you need to trust that hook again.
- The check result depends on the exit code alone. The plugin does not detect skipped or weakened tests.
- The `planner` role runs without the shell and web search. It was not verified that `apply_patch` is also unavailable to this role, so its restriction also relies on its instructions.
- `sandbox = "none"` limits a role through its instructions only.
- The MCP server receives only `HOME`, `LANG`, `LC_ALL`, `LOGNAME`, `PATH`, `SHELL`, `TERM`, `USER`, `CODEX_HOME`, and `OPENAI_API_KEY`. A key that `router.api_key_env` names under any other variable never reaches the server. The router then counts as failed, and the review runs as usual.
- `[router]` applies to direct `cw_review` and `cw_over_review` calls. `auto.review` always runs the reviewers.
- The role runner depends on the `codex exec --json` event format. A Codex update can change that format.

## Troubleshooting

| Symptom | Cause | Action |
| --- | --- | --- |
| No `[counterweight]` line appears at the end of a turn | The hooks are not trusted, or `[check]` is missing | Open `/hooks` in Codex and trust the hooks. Confirm that `.cw/project.toml` has a `[check]` section. |
| The report says `配置非法` | A file under `.cw/` has an unknown key or an invalid value | Fix the key named in the message. |
| The model cannot edit a file under a protected path | The path matches `protect.paths` | Edit the file yourself, or change `protect.paths`. |
| The model cannot edit `.cw/project.toml` or `.cw/codex.toml` | These files are always protected | Edit the file yourself. |
| A role tool reports `未配置 [models].<role>` | The role has no model | Add the role to `[models]` in `.cw/codex.toml`. |
| A role cannot read files | The Codex sandbox cannot start on this machine | Check `kernel.apparmor_restrict_unprivileged_userns`, or set `roles.sandbox = "none"`. |
| A role reports `未正常结束` | The `codex exec` turn did not complete | Read the reason in the message and call the tool again. |
| A role reports a timeout | The input took longer than `timeout_s` | Retry with the value in the message. At 1800 seconds, split the input. |
| `[auto]` does nothing | The key has no model, or the work tree has no changes | Check the notice at session start, and confirm that the turn changed files. |

## Development

```sh
npm ci
npm run typecheck
npm test
```

`npm test` builds the bundles first. Tests use a fake `codex` executable, so they need no model credentials. The bundles in `plugins/codex-counterweight/dist/` are committed because plugin installation does not run `npm install`. Run `npm run build` before you commit a source change.

The design and measured Codex behavior are recorded in [`docs/superpowers/specs/2026-11-04-codex-counterweight-design.md`](docs/superpowers/specs/2026-11-04-codex-counterweight-design.md) and [`docs/plans/2026-11-04-v2-roles.md`](docs/plans/2026-11-04-v2-roles.md).

## License

[MIT](LICENSE) © DengQi
