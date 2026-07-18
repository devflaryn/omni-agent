---
name: deep-planning
description: A brainstorm -> design -> plan -> verify workflow for big or ambiguous tasks, with the inspect-freely, plan-when-ready discipline. Use the architect/brainstormer subagents to do the heavy planning in a fresh context.
when_to_use: Before starting a large, ambiguous, or multi-phase task — a full APK-modding campaign, a broad "make X work" request, anything where jumping straight to edits would be premature.
allowed-tools: plan_create, plan_add_task, plan_set_next_action, plan_advance_phase, dispatch_agents, ask_codebase, record_decision, record_open_question
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
PLAN PROPOSAL: MISSION, SUCCESS CRITERIA, CONSTRAINTS, 3–6 stable PHASES (each with
an exit criterion), detailed FIRST-PHASE STEPS (each with a "done when…" check and
an optional `delegate` target), and KEY RISKS/UNKNOWNS. All that exploration stays
in the architect's context — you get back just the proposal.

## 4. Commit the plan
Turn the proposal into `plan_create` (task=MISSION, success_criteria, constraints,
phases, and the first-phase steps). Tag any self-contained step with
`delegate="<agent>"` so it runs in a fresh context when you start it. Keep steps
SMALL and VERIFIABLE.

## 5. Execute in phases, verify, re-ground
Work one phase at a time, one step at a time; mark steps in_progress/completed as
you go (a delegated step auto-dispatches on in_progress). At each milestone call
`plan_advance_phase` (the runtime re-grounds you on the goal). Validate every change
with an objective check before calling it done. If an approach fails repeatedly,
`plan_replan` for a different one — don't grind a dead end.

## Why this beats winging it
- The understanding is real (you inspected first), so the plan is grounded.
- The expensive brainstorm/design thinking happened in fresh sub-contexts, so your
  main context stays lean and sharp for the actual work (see the context-hygiene
  skill).
- The plan + investigation memory are durable — they survive context resets, so a
  run can span hours or days without losing the thread.
