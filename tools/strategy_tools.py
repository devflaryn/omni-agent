"""Strategic Brief tools — the model authors and revises the synthesized thesis
that shapes its decisions. State lives in strategy.py's module-level active brief;
agent.py wires strategy.set_context(...) once per session so these autosave and
refresh the live prompt. Orchestrator-only: these are in tool_policy.SUBAGENT_EXCLUDED,
so no subagent ever sees or calls them (single-writer guarantee)."""
from tool_registry import registry
import strategy


def _render(action):
    b = strategy.get_active()
    body = b.to_markdown() if b is not None else "(no brief)"
    missing = [f for f in strategy.REQUIRED if b is None or not getattr(b, f)]
    tail = ""
    if missing:
        tail = ("\n\nStill required before you can start CHANGING the workspace: "
                + ", ".join(missing) + ".")
    elif b is not None and not b.reviewed:
        tail = ("\n\nThe brief is complete but not yet strategy-reviewed — it will be "
                "independently reviewed automatically before your first mutating tool runs.")
    return {"stdout": f"Strategic Brief {action}:\n{body}{tail}"}


@registry.register(
    name="strategy_set",
    description=(
        "Author (or fully replace) the STRATEGIC BRIEF — the synthesized thesis that steers the whole run "
        "and stays pinned at the top of your context. Do this after enough recon to actually diagnose the "
        "target, and BEFORE you start changing the workspace: a complete brief (goal + diagnosis + strategy) "
        "must pass an independent strategy review before any mutating tool will run. Keep it tight; back each "
        "diagnosis item with an evidence pointer."
    ),
    params_schema={
        "goal": "string — the mission in one line (your drift anchor)",
        "diagnosis": "array — what protection(s) are actually present; each item a string OR {claim, evidence} where evidence is a file:line/symbol/log pointer",
        "strategy": "string — the chosen attack and the order you'll run it",
        "rationale": "string (optional) — why this strategy over the alternatives",
        "rejected": "array of strings (optional) — strategies you considered and ruled out, so you don't re-litigate them",
        "hypothesis": "string (optional) — your current top hypothesis under test",
        "kill_criteria": "array of strings (optional) — the conditions under which this strategy is wrong and you must abandon it",
    },
    output="The rendered brief and what (if anything) is still required before mutations unlock.",
    when_to_use="Call once you can diagnose the target, before your first change. To tweak one field later use strategy_update.",
)
def strategy_set(goal="", diagnosis=None, strategy=None, rationale=None,
                 rejected=None, hypothesis=None, kill_criteria=None):
    import strategy as _strat
    b = _strat.get_active() or _strat.StrategicBrief()
    b.set(goal=goal, diagnosis=diagnosis, strategy=strategy, rationale=rationale,
          rejected=rejected, hypothesis=hypothesis, kill_criteria=kill_criteria)
    _strat.set_active_brief(b)
    return _render("set")


@registry.register(
    name="strategy_update",
    description=(
        "Revise one or more fields of the STRATEGIC BRIEF as evidence arrives. Changing any strategic field "
        "(goal / diagnosis / strategy / rationale / rejected / kill_criteria) re-opens the brief for an "
        "independent strategy review before the next mutation; updating only the hypothesis does not."
    ),
    params_schema={
        "goal": "string (optional)",
        "diagnosis": "array (optional) — replaces the diagnosis list; string or {claim, evidence} items",
        "strategy": "string (optional)",
        "rationale": "string (optional)",
        "rejected": "array of strings (optional) — replaces the rejected list",
        "hypothesis": "string (optional) — refine the current top hypothesis (does not force re-review)",
        "kill_criteria": "array of strings (optional) — replaces the kill-criteria list",
    },
    output="The rendered brief and what (if anything) is still required before mutations unlock.",
    when_to_use="Use to evolve an existing brief. To create it the first time use strategy_set.",
)
def strategy_update(goal=None, diagnosis=None, strategy=None, rationale=None,
                    rejected=None, hypothesis=None, kill_criteria=None):
    import strategy as _strat
    b = _strat.get_active() or _strat.StrategicBrief()
    b.set(goal=goal, diagnosis=diagnosis, strategy=strategy, rationale=rationale,
          rejected=rejected, hypothesis=hypothesis, kill_criteria=kill_criteria)
    _strat.set_active_brief(b)
    return _render("updated")
