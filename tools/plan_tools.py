"""Plan-and-execute tools — let the LLM create, evolve, and complete a
structured todo list for the current task. This is the backbone of the
agent's default plan-and-execute workflow (see get_full_system_prompt in
llm.py for the behavioral mandate): at the start of a non-trivial task it
must create a plan before taking other actions, then keep it in sync with
its own progress as work proceeds — adding tasks it discovers it needs,
updating status, reordering, marking things complete — rather than treating
the plan as a document written once and then ignored.

State lives in planning.py's module-level "active plan". agent.py wires up
planning.set_context(...) once per session so these tools autosave to the
right memory dir and update the GUI + live system prompt in real time
without any of that plumbing being passed as tool arguments.
"""
from tool_registry import registry
import planning


@registry.register(
    name="plan_create",
    description=(
        "Creates a fresh execution plan for the CURRENT task: a short task summary plus an ordered "
        "todo list of concrete steps. Call this FIRST, before any other tool, for any task that needs "
        "more than a one-line answer — this is a hard requirement of this agent's default workflow, "
        "not optional. Replaces any previous plan. Keep steps concrete and verifiable (e.g. 'decompile "
        "the APK and locate the signature check' rather than 'analyze the APK'). You don't need to "
        "enumerate every conceivable step up front — plan_add_task lets you extend this list later as "
        "you discover what's actually needed."
    ),
    params_schema={
        "task": "string (a one-sentence summary of what the user asked for)",
        "steps": "array of strings (the ordered todo list — each a short, concrete step description)"
    },
    output="A rendered view of the new plan (task + numbered steps with ids, all starting as 'pending'), confirming it was created.",
    when_to_use="Call this as your very FIRST action for any new non-trivial task, before calling any other tool. If you're continuing an already-planned task, use plan_add_task/plan_update_task instead of recreating the plan."
)
def plan_create(task, steps):
    plan = planning.Plan(task)
    for step in (steps or []):
        plan.add_item(step)
    planning.set_active_plan(plan)
    return {"stdout": plan.to_markdown()}


@registry.register(
    name="plan_add_task",
    description=(
        "Adds a new task to the current plan — use this when you discover, mid-execution, that "
        "additional work is needed that wasn't in the original plan (e.g. you find a second "
        "signature check while bypassing the first one). By default the new task is appended to the "
        "end; pass after_id to insert it right after a specific existing task instead."
    ),
    params_schema={
        "content": "string (short, concrete description of the new task)",
        "after_id": "string (optional — an existing task's id to insert this one right after; omit to append at the end)"
    },
    output="A rendered view of the updated plan including the new task's id.",
    when_to_use="Call this the moment you realize the plan is missing a step — don't silently do extra work outside the plan; add it as a task first so the plan stays an accurate record of what's happening."
)
def plan_add_task(content, after_id=None):
    plan = planning.get_active_plan()
    if plan is None:
        return {"error": "No active plan. Call plan_create first."}
    plan.add_item(content, after_id=after_id)
    planning.notify_updated()
    return {"stdout": plan.to_markdown()}


@registry.register(
    name="plan_update_task",
    description=(
        "Updates an existing task's status and/or text. Use status='in_progress' when you start "
        "working on a task (mark the PREVIOUS task 'completed' first if you're moving on — normally "
        "only one task is 'in_progress' at a time), status='completed' when it's genuinely done, "
        "status='skipped' if it turns out to be unnecessary (explain why via notes), or just update "
        "content/notes to refine a task's description as you learn more."
    ),
    params_schema={
        "task_id": "string (the task's id, from plan_create's/plan_add_task's/plan_view's output)",
        "status": "string (optional: 'pending', 'in_progress', 'completed', or 'skipped')",
        "content": "string (optional — replace the task's description)",
        "notes": "string (optional — a short note, e.g. why a task was skipped or what was found)"
    },
    output="A rendered view of the updated plan, or an error if the task_id doesn't exist or the status is invalid.",
    when_to_use="Call this after each concrete step of your work — mark a task 'in_progress' when you start it, 'completed' immediately once it's genuinely done. Don't batch status updates until the end; the GUI plan panel and progress tracking depend on these happening as you go."
)
def plan_update_task(task_id, status=None, content=None, notes=None):
    plan = planning.get_active_plan()
    if plan is None:
        return {"error": "No active plan. Call plan_create first."}
    item = plan.update_item(task_id, status=status, content=content, notes=notes)
    if item is None:
        return {"error": f"Task '{task_id}' not found (or invalid status). Call plan_view to see current task ids."}
    planning.notify_updated()
    return {"stdout": plan.to_markdown()}


@registry.register(
    name="plan_reorder",
    description="Reorders the current plan's tasks. Pass ALL task ids in the desired new order (not a partial list) — this replaces the whole ordering at once.",
    params_schema={"task_ids": "array of strings (every current task's id, in the new desired order)"},
    output="A rendered view of the reordered plan, or an error if the ids don't exactly match the plan's current tasks.",
    when_to_use="Call this when you realize the logical order of remaining steps should change — e.g. a dependency you hadn't noticed means one task must happen before another."
)
def plan_reorder(task_ids):
    plan = planning.get_active_plan()
    if plan is None:
        return {"error": "No active plan. Call plan_create first."}
    ok = plan.reorder(task_ids or [])
    if not ok:
        return {"error": "task_ids must contain exactly the current plan's task ids (no more, no fewer, no duplicates). Call plan_view to see them."}
    planning.notify_updated()
    return {"stdout": plan.to_markdown()}


@registry.register(
    name="plan_view",
    description="Returns the current plan: task summary, every todo item with its id/status/notes, and overall progress. Use this to re-orient yourself, or to look up a task_id before calling plan_update_task.",
    params_schema={},
    output="A rendered view of the plan, or a message saying no plan exists yet.",
    when_to_use="Call this if you're unsure what's left to do, need a task's id, or want to double check the plan reflects reality before marking something complete."
)
def plan_view():
    plan = planning.get_active_plan()
    if plan is None:
        return {"stdout": "No active plan. Call plan_create to start one."}
    return {"stdout": plan.to_markdown()}
