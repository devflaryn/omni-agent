#!/usr/bin/env python3
"""Headless task runner for omni-agent — drive a full agent run WITHOUT the GUI.

The desktop app normally launches a pywebview window; this instead instantiates
the same `AgentApi`, activates the given workspace, submits one task, streams a
compact live log of what the agent does, and exits when the run finishes (or a
wall-clock cap is hit). It exercises the REAL loop, tools, guards, skills,
code-graph, and subagent telemetry — i.e. the actual model choosing and executing
actions.

  python3 run_headless.py --project /path/to/project --task "…" \
      [--max-seconds 0] [--resume] [--max-resumes 1000] [--resume-backoff 15]

Built for LONG unattended runs (tens of hours) on weaker models:
  --max-seconds 0   no wall-clock cap — run until the task finishes (the default).
  --resume          continue a persisted session for this project instead of
                    starting the task over (start_session restores the chat, plan,
                    investigation and strategy brief from disk).
  --max-resumes N   if the loop ends WITHOUT a final answer (a crash, or its
                    consecutive-crash circuit breaker), auto-resume up to N times
                    (each waits --resume-backoff seconds first). The in-loop
                    per-turn recovery already survives transient faults; this is
                    the outer net for a whole-loop exit.

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


def _wait_until_idle(api, deadline):
    """Block while the agent loop runs. Returns "capped" if the wall-clock
    deadline passed (and stops the agent), else "idle" when the loop ended."""
    while api._busy:
        if deadline is not None and time.time() > deadline:
            print("\n[headless] wall-clock cap hit — stopping the agent.", flush=True)
            api.stop()
            # give the loop a moment to unwind after stop
            for _ in range(10):
                if not api._busy:
                    break
                time.sleep(1.0)
            return "capped"
        time.sleep(1.0)
    return "idle"


def run_task(project, task, max_seconds, resume=False, max_resumes=0,
             resume_backoff=15):
    api = agent.AgentApi()
    api._window = None  # headless: no webview

    state = {"tools": [], "graph": False, "skill": False, "final": False}

    def emit(ev):
        et = ev.get("type")
        if et == "tool_running":
            name = ev.get("tool")
            state["tools"].append(name)
            if name in ("build_code_graph", "query_code_graph", "ask_codebase"):
                state["graph"] = True
            if name in ("use_skill", "list_skills", "read_skill_resource"):
                state["skill"] = True
        elif et == "final_answer":
            state["final"] = True
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

    deadline = None if not max_seconds or max_seconds <= 0 else time.time() + max_seconds
    cap_note = "no cap" if deadline is None else f"{max_seconds}s cap"

    if resume and api.has_resumable_history():
        print(f"[headless] resuming persisted session ({cap_note})\n", flush=True)
        api.continue_session()
    else:
        if resume:
            print("[headless] --resume given but no persisted history — "
                  "starting the task fresh.", flush=True)
        if not task:
            print("[headless] no --task and nothing to resume — nothing to do.",
                  file=sys.stderr, flush=True)
            return 2
        print(f"[headless] task ({cap_note}): {task}\n", flush=True)
        api.send_message(task)

    # Supervise: wait for the loop; on an unexpected end (no final answer, not
    # capped) auto-resume up to max_resumes times.
    resumes = 0
    while True:
        outcome = _wait_until_idle(api, deadline)
        if outcome == "capped":
            break
        if state["final"]:
            break
        if resumes >= max_resumes:
            if max_resumes:
                print(f"\n[headless] loop ended without a final answer and "
                      f"{max_resumes} resume(s) exhausted — giving up.", flush=True)
            break
        resumes += 1
        # Respect the deadline during the backoff wait, too.
        wait_end = time.time() + max(0, resume_backoff)
        print(f"\n[headless] loop ended without a final answer — auto-resuming "
              f"(attempt {resumes}/{max_resumes}) in {resume_backoff}s…", flush=True)
        while time.time() < wait_end:
            if deadline is not None and time.time() > deadline:
                break
            time.sleep(1.0)
        if deadline is not None and time.time() > deadline:
            print("[headless] wall-clock cap hit during backoff — stopping.", flush=True)
            break
        rr = api.continue_session()
        if not rr.get("ok"):
            print(f"[headless] resume failed: {rr.get('error')} — giving up.", flush=True)
            break

    print("\n[headless] === run summary ===", flush=True)
    print(f"  final answer: {state['final']}", flush=True)
    print(f"  auto-resumes used: {resumes}", flush=True)
    print(f"  tools used ({len(state['tools'])}): {', '.join(state['tools']) or '(none)'}", flush=True)
    print(f"  used code graph:  {state['graph']}", flush=True)
    print(f"  consulted a skill: {state['skill']}", flush=True)
    return 0


def main():
    ap = argparse.ArgumentParser(description="Run one omni-agent task headlessly (no GUI).")
    ap.add_argument("--project", required=True, help="workspace folder (already contains the APK to work on)")
    ap.add_argument("--task", default="", help="the task/goal to give the agent (optional with --resume)")
    ap.add_argument("--max-seconds", type=int, default=0,
                    help="wall-clock cap before auto-stop; 0 = no cap (default 0, for long runs)")
    ap.add_argument("--resume", action="store_true",
                    help="continue the persisted session for this project instead of restarting the task")
    ap.add_argument("--max-resumes", type=int, default=1000,
                    help="auto-resume up to N times if the loop ends without a final answer (default 1000)")
    ap.add_argument("--resume-backoff", type=int, default=15,
                    help="seconds to wait before each auto-resume (default 15)")
    args = ap.parse_args()

    if not os.path.isdir(args.project):
        print(f"--project is not a directory: {args.project}", file=sys.stderr)
        return 2
    if not args.task and not args.resume:
        print("provide --task, or --resume to continue a persisted session", file=sys.stderr)
        return 2
    return run_task(args.project, args.task, args.max_seconds,
                    resume=args.resume, max_resumes=args.max_resumes,
                    resume_backoff=args.resume_backoff)


if __name__ == "__main__":
    sys.exit(main())
