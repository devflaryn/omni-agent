---
name: context-hygiene
description: How to keep a very long run (tens of hours to days) sharp and cheap by fighting context rot — delegate to fresh contexts, keep durable state, work in phases, re-ground.
when_to_use: On any large, multi-phase, or long-running task (a full APK-modding campaign, a deep investigation), and any time the conversation is getting long or you feel you're losing the thread.
allowed-tools: dispatch_agents, plan_advance_phase, plan_update_task, record_finding, record_open_question, investigation_view, plan_view
---

# Context hygiene — beating context rot on a long run

As a conversation grows, the model's attention to the ORIGINAL goal and the early
instructions degrades — "context rot" — even before you hit the token limit. Output
quality drops, you contradict earlier decisions, you re-derive things you already
knew. The fix is not a bigger window; it's keeping each working context SMALL and
FRESH while durable state lives outside the chat. Task 50 should be as sharp as
task 1.

## The four moves

1. **Delegate heavy sub-tasks to fresh contexts.** Anything self-contained that
   would cost many tool calls — deep research, mapping an obfuscated tree, a
   well-specified patch — should run in a SUBAGENT, not inline. Two ways:
   - Tag a plan step with `delegate="<agent>"` (see AVAILABLE SUBAGENTS). When you
     mark it in_progress the harness runs it in its own context and folds back only
     the distilled report.
   - `dispatch_agents([...])` to fan out several INDEPENDENT read-only
     investigations at once and get back only their reports.
   The dozens of reads/queries stay in the sub-context and never touch yours. This
   is the single biggest anti-rot lever.

2. **Keep durable state OUTSIDE the chat.** The plan (`plan_*`) and investigation
   memory (`record_finding` / `record_hypothesis` / `record_open_question` /
   `record_decision` / `record_test_result`) survive summarization and context
   resets — the raw messages do not. Write what matters THERE the moment you learn
   it, then trust it instead of scrolling history. If a fact isn't in the plan or
   investigation memory, assume it will be lost.

3. **Work in phases, one at a time.** Discuss → plan → execute → verify. Keep the
   active context focused on the CURRENT phase; when you finish one, call
   `plan_advance_phase` (the runtime re-grounds you on the goal at that boundary).
   Don't carry five phases' worth of detail in your head at once.

4. **Re-ground when you drift.** The runtime injects a periodic SITUATION block, but
   if you notice you're unsure of the goal or repeating work, stop and read
   `plan_view` + `investigation_view` to re-anchor before continuing. Cheaper than
   grinding in the wrong direction.

## Anti-patterns (these ARE context rot setting in)

- Reading files one-by-one to "get oriented" instead of mapping with the code graph
  or delegating the exploration.
- Doing a big self-contained investigation inline, flooding your own context with
  raw tool output you'll never need again.
- Keeping findings only in the chat instead of `record_finding` — they vanish at the
  next summary and you re-derive them.
- Pushing through a long run without ever advancing phases or re-grounding.

The goal: your working context stays small and current no matter how many hours the
task runs, because the heavy lifting happens in fresh sub-contexts and the memory
lives in durable, structured state.
