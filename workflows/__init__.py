"""Public entry point for the workflow engine.

The order of operations matters and is the point of this module: a script is
COMPILED, its meta extracted, and then DRY-RUN to completion with schema-shaped
stubs — all before a single token is spent. Whatever model is configured has to
author correct orchestration on the first try, and a KeyError in stage 3 would
otherwise waste an entire run.
"""
import json
import os
import time
import traceback
import uuid

from . import journal as _journal
from . import sandbox as _sandbox
from .sandbox import WorkflowScriptError
# NOTE: `.runtime` is imported INSIDE the functions below, never here. It pulls in
# `subagents`, which imports `workflows.schema`, which executes this __init__ —
# a module-level import creates a real cycle that breaks `import subagents`
# app-wide. See the mandatory note in the task text.

_ACTIVE = {}        # run_id -> WorkflowRuntime


def list_library():
    from .library import list_workflows
    return list_workflows()


def _resolve_source(src, name):
    if src:
        return src
    if name:
        from .library import load_source
        return load_source(name)
    raise WorkflowScriptError("run() needs either src= or name=.")


def _dry_run(code, meta, args, concurrency):
    """Execute the whole script with agent() stubbed. Catches shape bugs, unknown
    personas, and unscoped writers for free."""
    from .runtime import WorkflowRuntime      # function-level: breaks the cycle
    import tempfile
    tmp = os.path.join(tempfile.mkdtemp(prefix="wfdry-"), "journal.jsonl")
    j = _journal.Journal(tmp)
    rt = WorkflowRuntime(j, run_dir=None, dry_run=True, concurrency=concurrency)
    ns = _sandbox.make_namespace(rt.primitives(), args)
    try:
        exec(code, ns)
        ns["__workflow__"]()
    finally:
        j.close()


def validate(src, args=None, concurrency=None):
    """compile + meta + full dry-run. Returns {"ok", "error", "meta"}."""
    try:
        meta = _sandbox.extract_meta(src)
        code = _sandbox.compile_workflow(src)
        _dry_run(code, meta, args, concurrency)
        return {"ok": True, "error": "", "meta": meta}
    except WorkflowScriptError as e:
        return {"ok": False, "error": str(e), "meta": {}}
    except Exception as e:  # noqa: BLE001 — a real bug in the script's control flow
        return {"ok": False,
                "error": f"dry-run failed: {type(e).__name__}: {e}\n"
                         + traceback.format_exc(limit=4),
                "meta": {}}


def run(src=None, name=None, args=None, run_root=".", on_event=None,
        resume_from=None, dry_run=False, concurrency=None):
    started = time.monotonic()
    warnings = []
    try:
        src = _resolve_source(src, name)
    except WorkflowScriptError as e:
        return {"ok": False, "error": str(e), "run_id": "", "name": name or "",
                "result": None, "agent_count": 0, "aborted": False,
                "elapsed_s": 0.0, "warnings": warnings}

    checked = validate(src, args, concurrency)
    if not checked["ok"]:
        return {"ok": False, "error": checked["error"], "run_id": "",
                "name": name or "", "result": None, "agent_count": 0,
                "aborted": False, "elapsed_s": round(time.monotonic() - started, 2),
                "warnings": warnings}

    meta = checked["meta"]
    if dry_run:
        return {"ok": True, "error": "", "run_id": "", "name": meta.get("name", ""),
                "result": None, "agent_count": 0, "aborted": False,
                "elapsed_s": round(time.monotonic() - started, 2),
                "warnings": ["dry run only — nothing executed"]}

    run_id = uuid.uuid4().hex[:12]
    run_dir = os.path.join(run_root, "workflows", run_id)
    os.makedirs(run_dir, exist_ok=True)
    with open(os.path.join(run_dir, "script.py"), "w", encoding="utf-8") as f:
        f.write(src)
    with open(os.path.join(run_dir, "meta.json"), "w", encoding="utf-8") as f:
        json.dump({"meta": meta, "args": args, "resume_from": resume_from},
                  f, indent=2, default=str)

    replay = None
    if resume_from:
        replay = os.path.join(run_root, "workflows", resume_from, "journal.jsonl")
        if not os.path.exists(replay):
            replay = None
            warnings.append(f"no journal found for run {resume_from}; running cold")

    j = _journal.Journal(os.path.join(run_dir, "journal.jsonl"), replay_from=replay)
    if j.had_write_agents:
        warnings.append(
            "the resumed run contained WRITE agents. Resume replays agent "
            "RESULTS, not workspace side effects — files those agents already "
            "changed stay changed, and their work will not be re-applied.")

    from .runtime import WorkflowRuntime       # function-level: breaks the cycle
    rt = WorkflowRuntime(j, on_event=on_event, run_dir=run_dir,
                         concurrency=concurrency, run_id=run_id)
    _ACTIVE[run_id] = rt

    if on_event:
        on_event({"type": "workflow_started", "run_id": run_id,
                  "name": meta.get("name", ""),
                  "description": meta.get("description", ""),
                  "phases": meta.get("phases", []),
                  "resumed": bool(replay)})

    ok, error, value = True, "", None
    try:
        from .runtime import WorkflowAborted   # function-level: breaks the cycle
        code = _sandbox.compile_workflow(src)
        ns = _sandbox.make_namespace(rt.primitives(), args)
        exec(code, ns)
        value = ns["__workflow__"]()
    except WorkflowAborted:
        ok, error = False, "aborted"
    except Exception as e:  # noqa: BLE001
        ok = False
        error = f"{type(e).__name__}: {e}\n" + traceback.format_exc(limit=6)
    finally:
        _ACTIVE.pop(run_id, None)
        try:
            with open(os.path.join(run_dir, "result.json"), "w", encoding="utf-8") as f:
                json.dump({"ok": ok, "error": error, "result": value},
                          f, indent=2, default=str)
        except OSError:
            pass
        j.close()

    out = {"ok": ok, "error": error, "run_id": run_id,
           "name": meta.get("name", ""), "result": value,
           "agent_count": rt.agent_count, "aborted": rt.aborted,
           "elapsed_s": round(time.monotonic() - started, 2),
           "warnings": warnings}
    if on_event:
        on_event({"type": "workflow_done", "run_id": run_id, "ok": ok,
                  "aborted": rt.aborted, "agent_count": rt.agent_count,
                  "elapsed_s": out["elapsed_s"], "error": error})
    return out


def abort(run_id=None):
    """Abort one run, or every active run when run_id is None."""
    targets = [_ACTIVE[run_id]] if run_id and run_id in _ACTIVE else list(_ACTIVE.values())
    for rt in targets:
        rt.abort()
    return len(targets)


def active_runs():
    return list(_ACTIVE.keys())
