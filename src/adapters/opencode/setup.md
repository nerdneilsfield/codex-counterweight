Set up or repair Counterweight in the current repository. Follow these steps in order.

1. Ask the user for the check command (run at the end of every turn; only the exit code counts) and the paths to protect from direct edits. Suggest running the command by hand once first to confirm it passes.
2. If `.cw/project.toml` does not exist, write it. If it already exists, do not edit it and do not bypass the protection through the shell: the plugin refuses edits to it on purpose. Show the user the suggested change and let them edit the file themselves. The same holds for `.cw/opencode.toml`: write it only when it does not exist, never modify an existing one.
3. If the user wants the role tools (`cw_explore`, `cw_review`, `cw_over_review`, `cw_research`, `cw_chronicle`) or `[auto]`, ask which model each role should use, written as `provider/model`, and write `.cw/opencode.toml` (see the second example). A role without a model is unavailable, and an `[auto]` item in `project.toml` whose model is missing is switched off, not an error. Roles cannot edit files or run shell commands; the planner has no tools.
4. Suggest these lines for `.gitignore`, so the local files stay out of git while the shared practice notes can be tracked: `/.cw/*`, `!/.cw/PRACTICES.md`, `!/.cw/BUGS.md`. The user decides.
5. Tell the user the config takes effect at the next turn, with no restart needed. On OpenCode a passing check shows nothing: they confirm it in `.cw/meter.jsonl`.

Minimal file:

```toml
version = 1

[check]
cmd = ["npm", "test"]

[protect]
paths = ["tests"]
```

Optional `.cw/opencode.toml`:

```toml
[models]
review = "anthropic/claude-sonnet-4-5"
over_review = "anthropic/claude-sonnet-4-5"
```
