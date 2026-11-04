---
name: cw-setup
description: Set up or repair Counterweight in the current repository. Checks that the plugin hooks are active, then helps write .cw/project.toml (end-of-turn check command and protected paths).
---

# Counterweight setup

Follow these steps in order.

1. Check that the hooks are trusted. Read `../../.codex-plugin/plugin.json` relative to this skill and note its `version`. Look in your context for the line `Counterweight <version> active` with that exact version. If it is missing or the version differs, tell the user the hooks are not trusted yet: they should open `/hooks`, trust the Counterweight hooks, and restart the session. Stop here until that is done. This only proves SessionStart ran, not that every hook is trusted.
2. Ask the user for the check command (run at the end of every turn; only the exit code counts) and the paths to protect from direct edits. Suggest running the command by hand once first to confirm it passes.
3. If `.cw/project.toml` does not exist, write it. If it already exists, do not edit it and do not bypass the protection through the shell: PreToolUse refuses edits to it on purpose. Show the user the suggested change and let them edit the file themselves.
4. Suggest adding `.cw/` to `.gitignore`. The user decides.
5. Tell the user the config takes effect at the next hook, with no restart needed.

Minimal file:

```toml
version = 1

[check]
cmd = ["npm", "test"]

[protect]
paths = ["tests"]
```
