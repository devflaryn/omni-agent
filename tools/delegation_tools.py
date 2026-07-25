"""Delegation tools — the model-facing PARALLEL fan-out primitive.

`dispatch_agents` runs a WAVE of read-only subagents at once (the GSD pattern:
several researchers in parallel, each in its own isolated context), and returns
only a compact index of their distilled reports. The heavy exploration stays in
the sub-sessions and never touches the orchestrator's conversation.

This is the deliberate SECONDARY delegation path. The PRIMARY path — a plan step's
`delegate` field — is handled by the harness in agent.py and needs no tool call at
all, which is why delegation isn't "just another tool" buried in the registry.
`dispatch_agents` exists only for ad-hoc parallel work that isn't a planned step.

Read-only by construction: write-capable agents are rejected here (a change must go
through a delegated plan step so it's tracked and serialized on the workspace).
"""
import queue as _queue
import threading as _threading

from tool_registry import registry
import llm
import plugins
import subagents
from subagents import AgentDef, run_subagents_parallel, run_subagent

# Per-agent report chars folded back inline. Phase 5 (GSD) routes full reports to
# files under the run dir and returns only summaries + paths; until then we cap.
_REPORT_CAP = 2400


def _ladder_hint():
    """One-line-per-model rendering of the LIVE cost spine, folded into the tool
    description so the model always sees the models actually configured right now
    — adding a provider never requires touching this file or the prompt."""
    lad = llm.model_ladder()
    if not lad:
        return ""
    rows = " | ".join(f"{e['model']} ({e['tier']})" for e in lad)
    return " CONFIGURED MODELS, most expensive first: " + rows + "."


def _run_with_ui_telemetry(run_fn):
    """Run `run_fn(on_event)` — which spawns subagents and calls `on_event` from
    worker threads — while streaming its telemetry LIVE to the UI.

    dispatch_agents executes on the agent-loop thread, but run_subagents_parallel
    fans work out to worker threads that fire on_event concurrently. Calling the
    UI sink straight from those workers would poke the webview from many threads
    at once; instead we run the wave in a background thread, funnel its events
    through a thread-safe queue, and drain that queue HERE on the agent-loop
    thread — so `subagents.ui_emit` is only ever called from one thread, exactly
    like agent.py's `_run_delegated_read_wave`. Returns whatever run_fn returns."""
    q = _queue.Queue()
    _SENTINEL = object()
    holder = {}

    def work():
        try:
            holder["result"] = run_fn(q.put)
        except Exception as e:  # noqa: BLE001 — surfaced to the caller below
            holder["error"] = e
        finally:
            q.put(_SENTINEL)

    t = _threading.Thread(target=work, daemon=True)
    t.start()
    while True:
        ev = q.get()
        if ev is _SENTINEL:
            break
        subagents.ui_emit(ev)
    t.join()
    if holder.get("error") is not None:
        raise holder["error"]
    return holder.get("result")


def _synthesizer():
    return AgentDef(
        name="synthesizer",
        system_prompt=(
            "You are a SYNTHESIS subagent. You are given several independent reports about the same "
            "workspace/task. Merge them into ONE tight, de-duplicated summary: the agreed findings with their "
            "evidence, any CONFLICTS between reports (call them out explicitly), and the concrete open items. "
            "Do not invent claims beyond what the reports support. Return just the summary."),
        mode="read", allowed_tools=set(), max_steps=1,
    )


@registry.register(
    name="dispatch_agents",
    description=(
        "Run a WAVE of read-only subagents IN PARALLEL, each in its own isolated context, and get back only "
        "their distilled reports — the dozens of reads/queries they make never touch your context. Use it to "
        "chase several INDEPENDENT questions at once (e.g. 'locate the root check', 'locate the signature "
        "check', 'map the license flow'). Name each subagent from AVAILABLE SUBAGENTS. Each spec may pick its "
        "own MODEL: 'tier' (cheap/standard/premium) or an explicit 'models' fallback order. Match the model to "
        "the job — a symbol lookup does NOT need your most expensive model." + _ladder_hint() +
        " Read-only by design: for an actual code change, tag a plan step with delegate=<write-agent> instead. "
        "This is the ad-hoc fan-out path; a planned, self-contained step should use the plan's delegate field."
    ),
    params_schema={
        "specs": ("array of objects, each {\"agent\": \"<subagent name>\", \"task\": \"<what to investigate>\", "
                  "\"context\": \"<optional focusing hints>\", \"tier\": \"<optional cheap|standard|premium>\", "
                  "\"models\": [\"<optional explicit model ids, best first>\"]} — the read-only subagents to "
                  "run in parallel. Omit tier/models to use the subagent's own default."),
        "synthesize": ("boolean (optional, default false) — if true, a synthesizer subagent distills all the "
                       "reports into ONE merged summary, keeping your context smallest."),
    },
    output=("A compact index: for each subagent, its name, status and distilled report (capped). With "
            "synthesize=true, a single merged summary instead of the individual reports."),
    when_to_use=(
        "Use for 2+ independent read-only investigations you want in parallel, to keep your own context lean. "
        "For one focused question use ask_codebase; for a tracked, self-contained step (research OR a change) "
        "prefer a plan step tagged with delegate=<agent>."),
    summary="run a parallel wave of read-only subagents; get back only their distilled reports",
)
def dispatch_agents(specs, synthesize=False):
    if not isinstance(specs, list) or not specs:
        return {"error": "dispatch_agents needs a non-empty 'specs' list of {agent, task[, context]} objects."}
    reg = plugins.get_registry()
    runnable = []
    problems = []
    for i, spec in enumerate(specs):
        if not isinstance(spec, dict):
            problems.append(f"spec #{i} is not an object")
            continue
        name = (spec.get("agent") or "").strip()
        task = (spec.get("task") or "").strip()
        if not name or not task:
            problems.append(f"spec #{i} needs both 'agent' and 'task'")
            continue
        ad = reg.get_agent(name)
        if ad is None:
            problems.append(f"unknown agent '{name}' — see AVAILABLE SUBAGENTS")
            continue
        if ad.is_write:
            problems.append(f"agent '{name}' is write-capable; dispatch_agents is read-only fan-out "
                            "— delegate a write agent via a plan step instead")
            continue
        runnable.append({"agent_def": ad, "task": task, "context": spec.get("context", ""),
                         "tier": spec.get("tier"), "models": spec.get("models")})

    if not runnable:
        return {"error": "No runnable read-only specs. " + "; ".join(problems)}

    results = _run_with_ui_telemetry(
        lambda on_event: run_subagents_parallel(runnable, on_event=on_event))

    if synthesize and len(runnable) > 1:
        concat = "\n\n".join(
            f"### report from {r.get('agent')}\n{(r.get('report') or '').strip()}" for r in results)
        syn = _run_with_ui_telemetry(
            lambda on_event: run_subagent(
                _synthesizer(),
                task="Synthesize the reports below into one merged summary.",
                context=concat, on_event=on_event))
        out = f"SYNTHESIZED SUMMARY of {len(runnable)} subagent reports:\n{(syn.get('report') or '').strip()}"
        if problems:
            out += "\n\n[skipped specs: " + "; ".join(problems) + "]"
        return {"stdout": out}

    lines = []
    for r in results:
        rep = (r.get("report") or "").strip()
        capped = rep[:_REPORT_CAP] + ("… [truncated — ask the agent to write to a file for more]"
                                      if len(rep) > _REPORT_CAP else "")
        status = "ok" if r.get("ok") else "FAILED"
        lines.append(f"### {r.get('agent')} [{status}, {r.get('steps', 0)} steps]\n{capped}")
    body = "\n\n".join(lines)
    if problems:
        body += "\n\n[skipped specs: " + "; ".join(problems) + "]"
    return {"stdout": body}
