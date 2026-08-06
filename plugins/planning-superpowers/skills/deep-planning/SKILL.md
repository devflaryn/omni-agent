---
name: deep-planning
description: A brainstorm -> design -> plan -> verify workflow for big or ambiguous tasks, with the inspect-freely, plan-when-ready discipline. Use the architect/brainstormer subagents to do the heavy planning in a fresh context.
when_to_use: Before starting a large, ambiguous, or multi-phase task — a full APK-modding campaign, a broad "make X work" request, anything where jumping straight to edits would be premature.
allowed-tools: plan_create, plan_add_task, plan_add_tasks, plan_set_next_action, plan_advance_phase, dispatch_agents, ask_codebase, record_decision, record_open_question
---

# Deep planning — brainstorm → design → plan → verify

For a big or fuzzy task, the failure mode is committing to a plan (or worse, to
edits) before you understand the problem. This workflow front-loads understanding
and keeps the heavy planning work OUT of your main context.

## 1. Inspect freely (no plan yet)
You are NOT required to plan before you understand. Read, search, decompile, query
the code graph — as much as you need. The runtime lets every non-mutating tool run
with no plan; use that freedom to learn what actually exists before you commit.

## 2. Brainstorm the requirements (delegate)
If the goal is ambiguous, delegate a `brainstormer` subagent (or `dispatch_agents`
with it) to turn the fuzzy goal into crisp requirements, hidden constraints, 2–3
candidate approaches with trade-offs, and the decision-changing open questions. It
runs in its OWN context and returns only the distilled result. Record the chosen
direction with `record_decision`.

## 3. Design the plan (delegate)
Delegate an `architect` subagent to inspect the workspace and return a structured
JSON PLAN PROPOSAL: MISSION, SUCCESS CRITERIA, CONSTRAINTS, 3–6 stable PHASES (each
with an exit criterion), a WIDE set of FIRST-PHASE STEPS (each with a "done when…"
check, a `delegate`, and — for change steps — the `scope` of paths it owns),
COMPONENTS for a multi-artifact build, and KEY RISKS/UNKNOWNS. All that exploration
stays in the architect's context — you get back just the proposal. In superpowers
mode the runtime installs that proposal as the live plan for you.

## 4. Commit the plan — WIDE, not long
Turn the proposal into `plan_create` (task=MISSION, success_criteria, constraints,
phases, and ALL of the first phase's steps in one call — `plan_add_tasks` adds
later waves in one call too). Keep steps SMALL and VERIFIABLE, and shape them for
concurrency:

- Independent steps have **no** `depends_on`, and they run AT THE SAME TIME. Add a
  dependency only where a step genuinely consumes another's result.
- Tag every self-contained step with `delegate="<agent>"` (optionally `@tier`) so it
  runs in a fresh context and returns only a distilled report.
- Give each change step a `scope` (e.g. `["smali/com/foo/**"]`). Disjoint-scoped
  write steps execute concurrently; an unscoped one locks the whole workspace.

Phases are dependency STAGES. If you find yourself writing a phase per step, the
plan is too narrow — collapse them into one wide phase.

## 5. Execute in waves, verify, re-ground
Work one phase at a time, but run its independent steps TOGETHER: starting a
delegated step dispatches it, and the ready steps fan out as one wave (the plan
render lists what is "Ready NOW"). Mark steps in_progress/completed as you go. At
each milestone call `plan_advance_phase` (the runtime re-grounds you on the goal).
Validate every change with an objective check before calling it done. If an
approach fails repeatedly, `plan_replan` for a different one — don't grind a dead
end.

## Why this beats winging it
- The understanding is real (you inspected first), so the plan is grounded.
- The expensive brainstorm/design thinking happened in fresh sub-contexts, so your
  main context stays lean and sharp for the actual work (see the context-hygiene
  skill).
- The plan + investigation memory are durable — they survive context resets, so a
  run can span hours or days without losing the thread.
