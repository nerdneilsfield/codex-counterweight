"""Counterweight for Hermes: forwards plugin hooks to dist/hook.cjs. Role sessions carry a first-line marker."""
import json, os, subprocess
from pathlib import Path

NODE = str(Path(__file__).parent / "dist" / "hook.cjs")
ROLES = {}  # session id -> tools a counterweight role may call


def _ask(module, name, default):
    try:
        return getattr(__import__(module, fromlist=[name]), name)()
    except Exception:
        return default


def _forward(hook, kw):
    sid = str(kw.get("session_id") or kw.get("task_id") or "")
    msg = kw.get("user_message")
    if hook == "pre_llm_call" and isinstance(msg, str) and msg.startswith("[counterweight-role:"):
        ROLES[sid] = ("read_file", "search_files") if msg.startswith("[counterweight-role:read]") else ()
    if hook == "pre_tool_call" and sid in ROLES:
        return None if kw.get("tool_name") in ROLES[sid] else {"action": "block", "message": "counterweight roles are read-only"}
    budget = float(_ask("hermes_cli.plugins", "_resolve_hook_callback_timeout", 30.0)) or 600.0
    cwd = str(_ask("agent.runtime_cwd", "resolve_agent_cwd", ""))
    env = dict(os.environ, CW_ROLE="1") if sid in ROLES else os.environ
    try:
        payload = json.dumps(dict(kw, hook=hook, cwd=cwd, budget_s=budget), default=str)
        out = subprocess.run(["node", NODE], input=payload, capture_output=True, text=True, env=env, timeout=budget).stdout
        return json.loads(out) if out.strip() else None
    except Exception:
        return None


def register(ctx):
    for hook in ("pre_llm_call", "pre_tool_call", "post_tool_call", "pre_verify", "post_api_request", "on_session_end"):
        ctx.register_hook(hook, lambda _h=hook, **kw: _forward(_h, kw))
