"""The model-facing entry to the workflow engine.

Registered in CORE (not an on-demand toolset) deliberately: an on-demand toolset
shows the model only a one-line catalog entry, and ultra mode's "default to a
workflow for substantive tasks" cannot work if the model cannot see the tool's
parameters. delegation_tools is core for the same reason.
"""
import json
import queue as _queue
import threading as _threading

import subagents
import workflows
from tool_registry import registry

# Indirected so tests can substitute it without patching the workflows package.
_run = workflows.run


def _run_workflow_description():
    """Built at PROMPT-RENDER time so a newly added library workflow appears
    without editing this file or the prompt."""
    lines = []
    for w in workflows.list_library():
        hint = w.get("when_to_use") or w.get("description") or ""
        schema = w.get("args_schema") or {}
        if schema:
            args = ", ".join(
                f"{k}{'' if (v or {}).get('required') else ' (optional)'}"
                for k, v in schema.items())
            hint = f"{hint} — args: {args}"
        lines.append(f"  - {w['name']}: {hint}")
    catalog = "\n".join(lines)
    return (
        "Run a WORKFLOW: deterministic multi-agent orchestration. Unlike dispatch_agents "
        "(one flat parallel wave), a workflow runs MULTIPLE STAGES — fan out, pipe each "
        "result into the next stage, verify findings adversarially, loop until a search "
        "goes dry — with the control flow decided by code rather than by you re-deciding "
        "every turn.\n"
        "PREFER a library workflow by name; only write a `script` for work none of them "
        "cover.\nAVAILABLE WORKFLOWS:\n" + catalog + "\n"
        "Authoring a script: it is Python. Start with a literal "
        "`meta = {\"name\": ..., \"description\": ...}`, then use agent(prompt, "
        "agent_type=, label=, phase=, schema=, scope=), parallel([thunks]) (a barrier), "
        "pipeline(items, *stages) (NO barrier — prefer it), phase(title), log(msg), and "
        "`args`. End with `return <value>`. A write agent MUST pass scope=[paths]. "
        "time/random/datetime are unavailable — replay determinism requires it. "
        "Every script is dry-run with stub data before it costs anything, and you get "
        "the traceback back if it fails."
    )


def _drain_to_ui(run_fn):
    """Run `run_fn(on_event)` on a background thread and drain its events HERE.

    Workflow agents fire events from many branch threads at once; poking the
    webview from all of them would be a threading bug. Same pattern as
    delegation_tools._run_with_ui_telemetry."""
    q = _queue.Queue()
    SENTINEL = object()
    holder = {}

    def work():
        try:
            holder["result"] = run_fn(q.put)
        except Exception as e:  # noqa: BLE001
            holder["error"] = e
        finally:
            q.put(SENTINEL)

    t = _threading.Thread(target=work, daemon=True)
    t.start()
    while True:
        ev = q.get()
        if ev is SENTINEL:
            break
        subagents.ui_emit(ev)
    t.join()
    if holder.get("error") is not None:
        raise holder["error"]
    return holder.get("result")


def _coerce_args(args):
    """A model routinely passes a JSON-ENCODED STRING where an object was asked
    for. Decoding it here turns a confusing downstream KeyError into the object
    the script expected."""
    if isinstance(args, str):
        text = args.strip()
        if not text:
            return None
        try:
            return json.loads(text)
        except ValueError:
            return args
    return args


@registry.register(
    name="run_workflow",
    description=_run_workflow_description,
    params_schema={
        "name": "string (optional) — a workflow from AVAILABLE WORKFLOWS. The preferred path.",
        "script": "string (optional) — a Python workflow script, when no library entry fits.",
        "args": "object (optional) — passed to the script as `args`. Pass a real object, not a JSON string.",
        "resume_from": "string (optional) — a prior run_id; unchanged agent calls replay from its journal.",
        "dry_run": "boolean (optional, default false) — validate and exercise control flow without spending tokens.",
    },
    output=("{ok, run_id, name, result, agent_count, elapsed_s, warnings} on success; "
            "{error, run_id, name, result, aborted, agent_count, elapsed_s} on failure — "
            "the traceback when validation or dry-run fails (fix the script and retry), and "
            "the counters plus any partial result when a started run failed or was aborted."),
    when_to_use=(
        "Use for multi-stage work: review-then-verify, discover-then-migrate-then-check, "
        "sweep-then-read-then-synthesize, or any hunt that should continue until it stops "
        "finding new things. For ONE flat wave of independent read-only questions, "
        "dispatch_agents is cheaper."),
    summary="run a multi-stage, multi-agent workflow (library entry or authored script)",
)
def run_workflow(name=None, script=None, args=None, resume_from=None, dry_run=False):
    if not name and not script:
        available = ", ".join(w["name"] for w in workflows.list_library())
        return {"error": f"run_workflow needs either 'name' or 'script'. Available: {available}"}
    if name and not script:
        known = [w["name"] for w in workflows.list_library()]
        if name not in known:
            return {"error": f"no workflow named '{name}'. Available: {', '.join(known)}"}

    try:
        res = _drain_to_ui(lambda emit: _run(
            src=script, name=name, args=_coerce_args(args),
            # The session's memory_dir, set by agent.start_session. NOT the
            # process CWD — that wrote run dirs into the source tree and made a
            # resume_from run_id unfindable after a relaunch.
            run_root=workflows.get_run_root(), on_event=emit,
            resume_from=resume_from, dry_run=bool(dry_run)))
    except Exception as e:  # noqa: BLE001
        return {"error": f"workflow crashed: {type(e).__name__}: {e}"}

    if not res.get("ok"):
        # An aborted or failed run still did work — return the same counters the
        # success path does, so the model can tell "nothing ran" from "eleven
        # agents finished and then I stopped it", and can resume from run_id.
        return {"error": res.get("error") or "workflow failed",
                "run_id": res.get("run_id", ""),
                "name": res.get("name", ""),
                "result": res.get("result"),
                "aborted": bool(res.get("aborted")),
                "agent_count": res.get("agent_count", 0),
                "elapsed_s": res.get("elapsed_s", 0.0),
                "warnings": res.get("warnings", [])}
    return {"ok": True, "run_id": res["run_id"], "name": res["name"],
            "result": res["result"], "agent_count": res["agent_count"],
            "elapsed_s": res["elapsed_s"], "warnings": res.get("warnings", [])}
