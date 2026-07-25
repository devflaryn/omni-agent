#!/usr/bin/env python3
"""Headless task runner for omni-agent — drive a full agent run WITHOUT the GUI.

The desktop app normally launches a pywebview window; this instead instantiates
the same `AgentApi`, mounts the Docker sandbox on the given workspace, submits one
task, streams a compact live log of what the agent does, and exits when the run
finishes (or a wall-clock cap is hit). It exercises the REAL loop, tools, guards,
skills, code-graph, and subagent telemetry — i.e. the actual model choosing and
executing actions.

  python3 run_headless.py --project /path/to/workspace --task "…" [--max-seconds 900]

⚠ A real run calls the configured LLM (llm_config.json) — it spends that provider's
quota. Point --project at a folder that already contains the APK(s) to work on.
"""
import argparse
import os
import sys
import time

import agent
import subagents


def _fmt(ev):
    """Compact one-line view of an agent event for the console."""
    t = ev.get("type")
    if t == "tool_running":
        return f"  → tool: {ev.get('tool')}  {str(ev.get('args', ''))[:120]}"
    if t == "tool_result":
        ok = "ok" if not ev.get("failed") else "FAIL"
        return f"    [{ok}] {ev.get('tool')}: {str(ev.get('result', ''))[:160]}"
    if t == "thought":
        return f"  · {str(ev.get('text', ''))[:160]}"
    if t == "system":
        return f"  [system] {str(ev.get('content', ''))[:200]}"
    if t == "plan_update":
        p = ev.get("plan") or {}
        items = p.get("items") or p.get("phases") or []
        return f"  [plan] {len(items)} item(s)"
    if t in ("wave_started",):
        return f"  ⚡ wave started ({ev.get('size')} subagents)"
    if t == "subagent_started":
        return f"    ⚡ subagent '{ev.get('agent')}' started"
    if t == "subagent_done":
        return f"    ⚡ subagent '{ev.get('agent')}' done: {ev.get('elapsed_s')}s · {ev.get('tokens')} tok"
    if t == "final_answer":
        return f"\n=== FINAL ANSWER ===\n{ev.get('content', '')}"
    if t == "error":
        return f"  [ERROR] {ev.get('content')}"
    return None


def run_task(project, task, max_seconds):
    api = agent.AgentApi()
    api._window = None  # headless: no webview

    tools_used = []
    used_graph = {"v": False}
    used_skill = {"v": False}

    def emit(ev):
        if ev.get("type") == "tool_running":
            name = ev.get("tool")
            tools_used.append(name)
            if name in ("build_code_graph", "query_code_graph", "ask_codebase"):
                used_graph["v"] = True
            if name in ("use_skill", "list_skills", "read_skill_resource"):
                used_skill["v"] = True
        line = _fmt(ev)
        if line:
            print(line, flush=True)

    api._emit = emit
    subagents.set_ui_sink(emit)  # route subagent HUD telemetry to the console too

    print(f"[headless] starting session on {project}", flush=True)
    r = api.start_session(project=project)
    if not r.get("ok"):
        print(f"[headless] start_session failed: {r.get('error')}", flush=True)
        return 2

    print(f"[headless] task: {task}\n", flush=True)
    api.send_message(task)

    deadline = time.time() + max_seconds
    while api._busy:
        if time.time() > deadline:
            print(f"\n[headless] wall-clock cap ({max_seconds}s) hit — stopping the agent.", flush=True)
            api.stop()
            break
        time.sleep(1.0)
    # give the loop a moment to unwind after stop/finish
    for _ in range(10):
        if not api._busy:
            break
        time.sleep(1.0)

    print("\n[headless] === run summary ===", flush=True)
    print(f"  tools used ({len(tools_used)}): {', '.join(tools_used) or '(none)'}", flush=True)
    print(f"  used code graph:  {used_graph['v']}", flush=True)
    print(f"  consulted a skill: {used_skill['v']}", flush=True)
    return 0


def main():
    ap = argparse.ArgumentParser(description="Run one omni-agent task headlessly (no GUI).")
    ap.add_argument("--project", required=True, help="workspace folder (already contains the APK to work on)")
    ap.add_argument("--task", required=True, help="the task/goal to give the agent")
    ap.add_argument("--max-seconds", type=int, default=900, help="wall-clock cap before auto-stop (default 900)")
    args = ap.parse_args()

    if not os.path.isdir(args.project):
        print(f"--project is not a directory: {args.project}", file=sys.stderr)
        return 2
    return run_task(args.project, args.task, args.max_seconds)


if __name__ == "__main__":
    sys.exit(main())
