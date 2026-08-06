"""Adaptive plan-and-execute tools — let the LLM create, evolve, and complete a
LAYERED plan for the current task. This is the backbone of the agent's default
workflow (see get_full_system_prompt in llm.py for the behavioral mandate):
before other actions it lays out a mission (task + success criteria + constraints
+ phases), then works the current phase in small verifiable steps, keeps one
precise next action, and revises the affected layer as evidence arrives instead
of rewriting the whole plan or drifting from it.

State lives in planning.py's module-level "active plan". agent.py wires up
planning.set_context(...) once per session so these tools autosave to the right
memory dir and update the GUI + live system prompt in real time without any of
that plumbing being passed as tool arguments. Confirmed facts vs. assumptions
belong in the investigation_* tools (the evidence memory), not here.
"""
from tool_registry import registry
import planning

# The step-object contract, documented ONCE and reused by every tool that accepts
# steps. It deliberately leads with the parallel fields: a step list authored
# without `delegate`/`depends_on` is a serial plan, and a serial plan is the single
# biggest thing standing between this agent and a large piece of work finishing in
# reasonable time.
_STEP_SHAPE = (
    "Each element is either a short concrete string, or an OBJECT: {"
    "\"content\": short concrete description (required), "
    "\"delegate\": subagent that runs this step in its own isolated context — optionally "
    "\"<agent>@<tier>\" (cheap|standard|premium); see AVAILABLE SUBAGENTS, "
    "\"depends_on\": [ids or same-batch \"key\"s this step must WAIT for — OMIT IT unless the "
    "step genuinely needs another's result, because steps without dependencies RUN AT THE SAME "
    "TIME], "
    "\"key\": a short local name (e.g. \"decompile\") other steps in THIS SAME call may list in "
    "their depends_on — ids don't exist yet when you write the batch, so this is how you wire a "
    "batch's internal order, "
    "\"scope\": [workspace path globs this step OWNS while it runs, e.g. "
    "[\"smali/com/foo/**\"] — write steps with DISJOINT scopes execute CONCURRENTLY instead of "
    "queueing behind one another, so always scope a write step that touches only part of the tree], "
    "\"purpose\": why this step matters, \"expected\": the result that proves it worked, "
    "\"verification\": how you'll check (command/build/test/file:line/log), "
    "\"fallback\": what to try if it fails, "
    "\"explanation\": a short first-person narration shown to the user when the step starts}"
)

_PARALLEL_DOCTRINE = (
    "PLAN WIDE, NOT LONG. Steps in a phase that carry no depends_on are dispatched as ONE "
    "concurrent wave, so a phase of 12 independent steps costs about as much wall-clock as a "
    "phase of 1. Put everything that CAN happen at once in the same phase, and use phases only "
    "for real dependency stages (you can't patch what you haven't decompiled). Tag every "
    "self-contained step with a delegate so it runs in its own context and only its distilled "
    "report comes back to you."
)


@registry.register(
    name="plan_create",
    description=(
        "Creates a fresh adaptive plan for the CURRENT task. Call this FIRST, before other tools, for "
        "any task beyond a one-line answer — a hard requirement of this agent's workflow. First inspect "
        "the current state (available tools, constraints, success criteria, unknowns), THEN lay out: a "
        "one-sentence task summary; success_criteria (what 'done' objectively looks like); constraints "
        "(hard boundaries); phases (the 3-6 high-level milestones — this is the stable mission plan); and "
        "the steps for the FIRST phase. Keep steps small and verifiable (e.g. 'locate the "
        "signature check — done when I have its file:line', not 'analyze the app'). Don't over-plan or "
        "invent details you haven't confirmed; you extend the plan later with plan_add_tasks as you learn. "
        + _PARALLEL_DOCTRINE
    ),
    params_schema={
        "task": "string (a one-sentence summary of what the user asked for)",
        "steps": ("array (the FIRST phase's steps — author ALL of the independent ones here, not just the "
                  "first one, so they dispatch as a single concurrent wave). " + _STEP_SHAPE),
        "success_criteria": "array of strings (optional but recommended — the objective conditions that mean the task is done)",
        "constraints": "array of strings (optional — hard boundaries/rules the solution must respect)",
        "phases": "array of strings (optional but recommended — the high-level milestones; the first becomes the current phase)",
        "next_action": "string (optional — the single precise next thing you'll do)",
        "current_state": "array of strings (optional — what you established while inspecting the situation before planning)",
        "unknowns": "array of strings (optional — the open questions still to resolve)",
        "assumptions": "array of strings (optional — assumptions the plan rests on, to be confirmed with evidence)"
    },
    output="A rendered view of the new plan (mission, orientation, phases, first-phase steps, next action), confirming it was created.",
    when_to_use="Call this as your very FIRST action for any new non-trivial task, right after a brief inspection of the current state. If you're continuing an already-planned task, use plan_add_task/plan_update_task/plan_replan instead of recreating it."
)
def plan_create(task, steps=None, success_criteria=None, constraints=None, phases=None,
                next_action=None, current_state=None, unknowns=None, assumptions=None):
    plan = planning.Plan(task)
    plan.set_mission(success_criteria=success_criteria, constraints=constraints)
    plan.set_orientation(current_state=current_state, unknowns=unknowns, assumptions=assumptions)
    if phases:
        plan.set_phases(phases)
    plan.add_items(steps or [])
    if next_action:
        plan.set_next_action(next_action)
    planning.set_active_plan(plan)
    return {"stdout": plan.to_markdown()}


@registry.register(
    name="plan_add_task",
    description=(
        "Adds a new step to the current plan — use this when you discover mid-execution that work is "
        "needed that wasn't planned (e.g. you find a second signature check while bypassing the first). "
        "For an IMPORTANT step, fill the evidence fields so 'done' is objectively checkable: purpose (why "
        "this step), expected (what result proves it worked), verification (how you'll check — a command, "
        "build, test, file:line, or log), and fallback (what to try if it fails). By default the step is "
        "appended; pass after_id to insert it right after an existing step. New steps join the current phase."
    ),
    params_schema={
        "content": "string (short, concrete description of the new step)",
        "purpose": "string (optional — why this step matters / what it unblocks)",
        "expected": "string (optional — the concrete result that means it succeeded)",
        "verification": "string (optional — how you'll verify it: command/build/test/file:line/log)",
        "fallback": "string (optional — what to do if it fails or the expected result doesn't appear)",
        "explanation": "string (optional — a short first-person narration shown to the user when this step is started, e.g. \"Now I'll patch the license check.\")",
        "delegate": "string (optional — the name of a subagent to run this step in its own isolated context; when you mark the step in_progress the harness auto-dispatches it and folds back only the distilled report. See AVAILABLE SUBAGENTS. Use for a heavy, self-contained sub-task (deep research / analysis / a well-specified implementation) so this conversation stays lean. Append '@<tier>' to pick the model tier for this step (e.g. delegate=\"researcher@cheap\" for a lookup, \"implementer@standard\", \"verifier@premium\"); a bare name uses the subagent's own default tier.)",
        "depends_on": "array of strings (optional — ids of OTHER steps that must finish before this one. Omit for independent steps: steps without dependencies run IN PARALLEL by default, so only set this when this step truly needs another's result.)",
        "scope": "array of strings (optional — the workspace path globs this step OWNS while it runs, e.g. [\"smali/com/foo/**\"]. Write steps with disjoint scopes run CONCURRENTLY; an unscoped write step takes the whole workspace exclusively.)",
        "after_id": "string (optional — an existing step's id to insert this one right after; omit to append)"
    },
    output="A rendered view of the updated plan including the new step's id.",
    when_to_use="Call this the moment you realize the plan is missing ONE step — for two or more, use plan_add_tasks so they can dispatch as a wave. Don't silently do extra work outside the plan; add it first so the plan stays an accurate record. Tag it with delegate=<subagent> to offload a heavy, self-contained step to an isolated context."
)
def plan_add_task(content, purpose=None, expected=None, verification=None, fallback=None,
                  after_id=None, explanation=None, delegate=None, depends_on=None, scope=None):
    plan = planning.get_active_plan()
    if plan is None:
        return {"error": "No active plan. Call plan_create first."}
    plan.add_item(content, after_id=after_id, purpose=purpose, expected=expected,
                  verification=verification, fallback=fallback, explanation=explanation,
                  delegate=delegate, depends_on=depends_on, scope=scope)
    planning.notify_updated()
    return {"stdout": plan.to_markdown()}


@registry.register(
    name="plan_add_tasks",
    description=(
        "Adds MANY steps to the current plan in ONE call — the tool to reach for whenever you're about "
        "to add more than one step. Use it to lay out a whole wave of work at once: enumerate every "
        "component of a large change (each smali package, each native library, each module to port) as "
        "its own scoped, delegated step, and they dispatch CONCURRENTLY. Adding those steps one at a "
        "time instead costs a full round-trip each and produces a plan the harness can only run "
        "serially. Steps may reference each other by 'key' in depends_on to express order inside the "
        "batch. " + _PARALLEL_DOCTRINE
    ),
    params_schema={
        "steps": "array (the steps to add, in order). " + _STEP_SHAPE,
        "after_id": "string (optional — an existing step's id to insert the batch right after, in order; omit to append)",
    },
    output="A rendered view of the updated plan including every new step's id, and which steps are ready to run concurrently.",
    when_to_use=(
        "Call this instead of repeated plan_add_task whenever you have 2+ steps to add — especially "
        "right after planning a phase of a large modification, where the whole point is that the "
        "independent pieces run at the same time."),
    summary="add a whole wave of plan steps (with delegates, scopes and dependencies) in one call",
)
def plan_add_tasks(steps, after_id=None):
    plan = planning.get_active_plan()
    if plan is None:
        return {"error": "No active plan. Call plan_create first."}
    if not isinstance(steps, list) or not steps:
        return {"error": "plan_add_tasks needs a non-empty 'steps' array. For a single step, plan_add_task also works."}
    created = plan.add_items(steps, after_id=after_id)
    if not created:
        return {"error": "None of the given steps had usable content (each needs a 'content' string)."}
    planning.notify_updated()
    return {"stdout": f"Added {len(created)} step(s): "
                      + ", ".join(f"({it['id']}) {it['content'][:60]}" for it in created)
                      + "\n\n" + plan.to_markdown()}


@registry.register(
    name="plan_update_task",
    description=(
        "Updates an existing step. Use status='in_progress' when you START it (mark the previous step "
        "'completed' first — normally only one is in_progress); starting a step is ALSO what narrates it "
        "to the user (its 'explanation', or its description, becomes a chat line and opens a new action "
        "group for the tool calls that follow). Use status='completed' the moment it's genuinely done AND "
        "verified, status='skipped' if it proved unnecessary (say why in notes). You can also refine "
        "content or fill/adjust the evidence fields (purpose/expected/verification/fallback/explanation) "
        "as you learn — only the fields you pass change; the rest are preserved."
    ),
    params_schema={
        "task_id": "string (the step's id, from plan_create/plan_add_task/plan_view output)",
        "status": "string (optional: 'pending', 'in_progress', 'completed', or 'skipped')",
        "content": "string (optional — replace the step's description)",
        "notes": "string (optional — a short note, e.g. why skipped or what was found/verified)",
        "purpose": "string (optional — why this step matters)",
        "expected": "string (optional — the concrete success result)",
        "verification": "string (optional — how it's verified)",
        "fallback": "string (optional — the fallback if it fails)",
        "explanation": "string (optional — set/refine the first-person narration shown when this step starts)",
        "delegate": "string (optional — set/clear the subagent that runs this step in isolation; marking the step in_progress then auto-dispatches it. Pass an empty string to clear a previously-set delegate. Append '@<tier>' to pick the model tier for this step (e.g. delegate=\"researcher@cheap\" for a lookup, \"implementer@standard\", \"verifier@premium\"); a bare name uses the subagent's own default tier.)",
        "depends_on": "array of strings (optional — replace this step's dependencies; pass [] to clear them and make it immediately eligible for a parallel wave).",
        "scope": "array of strings (optional — replace the workspace path globs this step owns; pass [] to clear. Disjoint-scoped write steps run concurrently.)"
    },
    output="A rendered view of the updated plan, or an error if the task_id doesn't exist or the status is invalid.",
    when_to_use="Call this to START a step (status='in_progress' — this narrates the subprocess to the user, and auto-dispatches it if the step has a delegate) and again to complete it once it's DONE AND VERIFIED. Don't batch updates until the end; the GUI, the chat narration, and progress tracking all depend on these happening as you go."
)
def plan_update_task(task_id, status=None, content=None, notes=None,
                     purpose=None, expected=None, verification=None, fallback=None,
                     explanation=None, delegate=None, depends_on=None, scope=None):
    plan = planning.get_active_plan()
    if plan is None:
        return {"error": "No active plan. Call plan_create first."}
    item = plan.update_item(task_id, status=status, content=content, notes=notes,
                            purpose=purpose, expected=expected,
                            verification=verification, fallback=fallback,
                            explanation=explanation, delegate=delegate,
                            depends_on=depends_on, scope=scope)
    if item is None:
        return {"error": f"Step '{task_id}' not found (or invalid status). Call plan_view to see current step ids."}
    planning.notify_updated()
    return {"stdout": plan.to_markdown()}


@registry.register(
    name="plan_reorder",
    description="Reorders the current plan's steps. Pass ALL step ids in the desired new order (not a partial list) — this replaces the whole ordering at once.",
    params_schema={"task_ids": "array of strings (every current step's id, in the new desired order)"},
    output="A rendered view of the reordered plan, or an error if the ids don't exactly match the plan's current steps.",
    when_to_use="Call this when the logical order of remaining steps should change — e.g. a dependency you hadn't noticed means one step must happen before another."
)
def plan_reorder(task_ids):
    plan = planning.get_active_plan()
    if plan is None:
        return {"error": "No active plan. Call plan_create first."}
    ok = plan.reorder(task_ids or [])
    if not ok:
        return {"error": "task_ids must contain exactly the current plan's step ids (no more, no fewer, no duplicates). Call plan_view to see them."}
    planning.notify_updated()
    return {"stdout": plan.to_markdown()}


@registry.register(
    name="plan_set_next_action",
    description=(
        "Sets the SINGLE precise next action — the smallest concrete move that reduces uncertainty or "
        "advances the task. Keep it specific and immediately doable (a tool call you're about to make), "
        "not a vague goal. Update it whenever the next move changes, so there is always one unambiguous "
        "next step for you (and the user) to see."
    ),
    params_schema={"next_action": "string (the one concrete next thing you'll do)"},
    output="A rendered view of the plan with the updated next action.",
    when_to_use="Call this after finishing a step (to point at the next one) or whenever new evidence changes what the smallest next move should be."
)
def plan_set_next_action(next_action):
    plan = planning.get_active_plan()
    if plan is None:
        return {"error": "No active plan. Call plan_create first."}
    plan.set_next_action(next_action)
    planning.notify_updated()
    return {"stdout": plan.to_markdown()}


@registry.register(
    name="plan_advance_phase",
    description=(
        "Marks the current phase COMPLETED and moves to the next one, so the high-level mission plan "
        "tracks real progress. By default the next pending phase becomes current; pass phase_id to jump "
        "to a specific phase instead. Add a note summarizing what the finished phase established. After "
        "advancing, add the new phase's steps with plan_add_tasks — the whole wave in one call."
    ),
    params_schema={
        "phase_id": "string (optional — the phase to make current; omit to advance to the next pending phase)",
        "note": "string (optional — a short summary of what the just-completed phase accomplished)"
    },
    output="A rendered view of the plan with the phase statuses updated, or a note that there are no further phases.",
    when_to_use="Call this when every step of the current phase is done and its milestone is genuinely reached — not to skip ahead past unfinished work."
)
def plan_advance_phase(phase_id=None, note=None):
    plan = planning.get_active_plan()
    if plan is None:
        return {"error": "No active plan. Call plan_create first."}
    if not plan.phases:
        return {"error": "This plan has no phases. Add them via plan_replan (with phases=...) or keep working the flat step list."}
    nxt = plan.advance_phase(phase_id=phase_id, note=note)
    planning.notify_updated()
    tail = "" if nxt else "\n(No further phases — when the success criteria are met, call plan_set_outcome 'completed'.)"
    return {"stdout": plan.to_markdown() + tail}


@registry.register(
    name="plan_replan",
    description=(
        "Triggers a larger REPLAN after a major failure, an invalidated assumption, unexpected "
        "architecture, repeated unsuccessful attempts, or changed constraints — when small edits "
        "(plan_add_task/plan_update_task) aren't enough. Give the reason (what evidence forced it). It "
        "PRESERVES useful progress: completed/skipped steps are kept by default; only pending/in-progress "
        "steps are cleared and replaced with the new ones you provide. Optionally re-cut the phases and "
        "set the next action. Use this instead of blindly following an outdated plan — but don't replan "
        "for a minor course-correction a single plan_update_task would handle."
    ),
    params_schema={
        "reason": "string (what new evidence/failure forces the replan — recorded in the plan's history)",
        "steps": ("array (the new current-phase steps — author the whole wave, not just the next move). "
                  + _STEP_SHAPE),
        "phases": "array of strings (optional — re-cut the high-level milestones; omit to keep the existing phases)",
        "next_action": "string (optional — the new single precise next action)",
        "keep_completed": "boolean (optional, default true — keep finished steps as a record of preserved progress; false clears all steps)"
    },
    output="A rendered view of the revised plan (progress preserved), confirming the replan.",
    when_to_use="Call this when the situation changed enough that the remaining plan is wrong — a failed core approach, a bad assumption, a surprise in the architecture — so you revise deliberately instead of drifting."
)
def plan_replan(reason, steps=None, phases=None, next_action=None, keep_completed=True):
    plan = planning.get_active_plan()
    if plan is None:
        return {"error": "No active plan. Call plan_create first."}
    plan.record_replan(reason)
    # Preserve useful progress: keep finished steps, drop the stale pending/in-progress
    # ones, then lay in the new steps. keep_completed=false wipes the step list entirely.
    if keep_completed:
        plan.items = [it for it in plan.items if it["status"] in planning.DONE_STATUSES]
    else:
        plan.items = []
    if phases:
        plan.set_phases(phases)
    plan.add_items(steps or [])
    if next_action is not None:
        plan.set_next_action(next_action)
    planning.notify_updated()
    return {"stdout": plan.to_markdown()}


@registry.register(
    name="plan_set_outcome",
    description=(
        "Records the task's end state so it's explicit rather than implied: 'completed' (success criteria "
        "met and verified), 'partial' (some criteria met, note what's left), 'blocked' (can't proceed — "
        "note the blocker), or 'needs_different_approach' (the current strategy won't work — note why). "
        "Setting 'completed' is how you signal the objective is genuinely done; the others keep the plan "
        "active so work/replanning can continue. Only claim 'completed' when the verification actually passed."
    ),
    params_schema={
        "outcome": "string ('completed', 'partial', 'blocked', or 'needs_different_approach')",
        "note": "string (optional but recommended — what's left, what's blocking, or why the approach must change)"
    },
    output="A rendered view of the plan with its outcome set, or an error for an invalid outcome value.",
    when_to_use="Call this when you reach a terminal state for the task — right before a final answer for 'completed', or when you determine the work is partial/blocked/needs a different approach."
)
def plan_set_outcome(outcome, note=None):
    plan = planning.get_active_plan()
    if plan is None:
        return {"error": "No active plan. Call plan_create first."}
    result = plan.set_outcome(outcome, note=note)
    if result is None:
        return {"error": "Invalid outcome. Use one of: completed, partial, blocked, needs_different_approach."}
    planning.notify_updated()
    return {"stdout": plan.to_markdown()}


@registry.register(
    name="plan_view",
    description="Returns the current plan: mission (task + success criteria + constraints), phases with the current one marked, every step with its id/status/evidence fields, the next action, outcome, and overall progress. Use it to re-orient, or to look up a step/phase id before updating.",
    params_schema={},
    output="A rendered view of the plan, or a message saying no plan exists yet.",
    when_to_use="Call this if you're unsure what's left, need an id, or want to check the plan reflects reality before marking something complete or replanning."
)
def plan_view():
    plan = planning.get_active_plan()
    if plan is None:
        return {"stdout": "No active plan. Call plan_create to start one."}
    # plan_view is the explicit "show me everything" tool — render ALL steps across
    # phases (the live prompt only carries the current phase to stay compact).
    return {"stdout": plan.to_markdown(full=True)}
