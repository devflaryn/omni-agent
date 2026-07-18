# Omni-Agent: Orchestrator + Subagents + Plugins + Planning Fix

**Date:** 2026-07-18
**Status:** IMPLEMENTED — all 6 phases complete and green offline (subagents 11, plugins 7,
delegation 7, context-hygiene 6, planning-superpowers 3, adaptive-planning 4, + full
existing suite). New modules: `tool_policy.py`, `subagents.py`, `plugins.py`,
`tools/delegation_tools.py`; new first-party plugins: `omni-agents`, `gsd`,
`planning-superpowers`. See "Build order" at the bottom.

## Goal

Evolve omni-agent from a single big agent into an **orchestrator** that splits work
across **isolated subagents** and loads capability from a **Claude-Code-style plugin
system**, so a run can last **tens of hours to days on a 1M context** without
context rot and without dumbing down results. Fix the planning workflow so the
agent can **inspect the workspace freely before committing to a plan**, and never
has its plan force-created or silently disabled.

Model is fixed (GLM 5.2 primary, DeepSeek fallback) — every win comes from the
framework, not the model. Every new behavior is gated behind a per-session flag so
existing lightweight/test sessions and the offline test suite are unaffected (the
same safety pattern `FRAMEWORK_UPGRADE.md` established).

## Confirmed design decisions (user)

1. **Subagent power — Hybrid.** Read-only subagents (research/analysis/review) run
   in **parallel**; write-capable subagents (edit/patch/rebuild) run **one at a
   time** sharing the single Docker `/workspace`. Each returns a distilled report +
   verification status.
2. **Dispatch — plan-driven + light fan-out**, modeled on Claude Code plugins (not
   "just another tool" in the 106-tool registry). Plus: replicate GSD's context-rot
   handling.
3. **Planning — inspect freely, plan when ready.** Unlimited read-only analysis
   before any plan; the only hard gate is a one-time soft nudge on the first
   *mutating* action; the plan is never silently disabled.

## Existing foundations (reuse, don't reinvent)

- **Isolated-context subagents already exist:** `tools/reviewer.run_review` and
  `tools/codebase_qa.ask_codebase` each build a fresh `ask_llm` conversation with
  their own system prompt + filtered tool allowlist and return only a distilled
  result. **The subagent engine is a generalization of this exact pattern.**
- **Skills system** (`skills_loader.py`, `tools/skill_tools.py`, `skills/`) —
  Claude-Code-style progressive disclosure. The plugin system extends this.
- **Progressive tool disclosure** (`tool_registry.py`) — core + on-demand domain
  toolsets. Subagents filter their tool surface by toolset.
- **Context editing** (`agent.evict_old_tool_results`) — extended by GSD re-grounding.
- **Investigation memory** (`investigation.py`) + **layered plan** (`planning.py`) —
  durable, survive context resets. Delegation folds distilled reports into these.
- **System prompt composition:** `llm.get_static_system_prompt()` (intro +
  behavioral contract + skills block) + `llm.render_tools_section(active_groups)`;
  `agent._refresh_system_prompt()` re-renders `messages[0]`.

## Architecture

### 1. Subagent engine — `subagents.py`

One engine generalizing `run_review`/`ask_codebase`:

```
run_subagent(agent_def, task, context="", run_dir=None) -> SubagentResult
SubagentResult = {report, artifacts:[paths], verified:bool|None, steps, agent, ok}
```

- Builds isolated `messages`: `system = persona + render_tools_section(filtered) +
  durable-context excerpt`; loops `ask_llm`, executes only the agent's allowed
  tools, bounded by `max_steps` and a context char cap (reuse
  `codebase_qa`'s caps/temperature).
- **Only the distilled `report` (final_answer) re-enters the caller.** The
  sub-transcript is dropped (optionally written to `run_dir/<agent>.trace.md`).
- `agent_def.mode`:
  - `read` → tool surface filtered to non-mutating tools; **parallelizable**.
  - `write` → may use mutating tools; **serialized** behind a module-level
    `_WORKSPACE_LOCK` so only one writer touches `/workspace` at a time.
- `run_subagents_parallel(specs)` runs read-only specs in a bounded
  `ThreadPoolExecutor` (default 4). Write specs always run sequentially. Mixed
  lists: reads fan out, writes drain one-by-one.
- Never raises for orchestration reasons — a failed subagent returns
  `{ok:False, report:"<error>"}` so the orchestrator can decide, exactly like
  `run_review`'s non-blocking fallback.

**Relationship to the two legacy sub-agents:** `run_review` and `ask_codebase`
are the proven pattern this engine generalizes. They are **kept as-is** (their
tests monkeypatch `reviewer.ask_llm` / `codebase_qa.ask_llm` at their own call
sites, so routing them through the engine would move the patch target and break
green tests for no functional gain). The engine shares the neutral `tool_policy`
classification with them; unifying their loops is a deferred cleanup (YAGNI now).
New plugin agents and delegation use the engine.

### 2. Plugin system — `plugins.py`

A plugin is a directory `plugins/<name>/` with a manifest and contributed assets:

```
plugins/<name>/
  plugin.json            # {name, version, description, enabled?, provides:{agents,skills,commands,hooks}}
  agents/<agent>.md      # frontmatter: name, description, mode, toolsets, model?, temperature?, max_steps? + body=system prompt
  skills/<skill>/SKILL.md# reuse skills_loader (now scans plugin roots too)
  commands/<cmd>.md      # named workflow prompt (frontmatter: name, description + body); optional/light
  hooks/hooks.json       # {pre_tool, post_tool, on_phase_change, on_final_answer: [dotted.callable]}; optional
```

- `load_plugins()` discovers + parses manifests, aggregates:
  `agents` (name→AgentDef), `skills` (merged into the skills index),
  `commands`, `hooks`.
- `skills_loader` gains extra-root registration (`register_skill_root`) so it scans
  `./skills` **and** every enabled plugin's `skills/`. **Decision:** the existing
  top-level `skills/` is **kept in place** as the first-party skillset (moving 14
  live skill dirs is churn/risk for no functional gain); new plugins layer more
  skills on top. First-party subagent personas ship as the `omni-agents` plugin
  (`researcher`, `native-analyst`, `implementer`), which dogfoods the loader and
  gives delegation real targets.
- Enable/disable via `llm_config.json` `"plugins": {"<name>": {"enabled": bool}}`.
  Disabled plugins contribute nothing.
- Built-in hooks: the current validation-gate and repeat-failure guard are exposed
  as the first `pre_tool`/`post_tool` hooks (behavior unchanged; just formalized so
  plugins can add their own).

**AgentDef** (`{name, description, mode, toolsets:set, model?, temperature?,
max_steps?, system_prompt}`) resolves `toolsets` → concrete allowed-tool set via
`tool_registry` (a `read` agent additionally intersects with non-mutating tools).

### 3. Delegation — plan-driven + fan-out

**Plan-driven (primary, no tool pick):**
- `planning.Plan` steps get an optional `delegate` field (agent name) — added to
  `add_item`/`update_item`, `plan_add_task`/`plan_update_task` args, serialization,
  and markdown render (`» delegate: <agent>`).
- In `agent._run_agent_loop`, when the worker sets a step `in_progress` (via
  `plan_update_task status=in_progress`) **and that step has `delegate`**, the
  harness intercepts: it runs `run_subagent(agent, task=step.content + context)`
  **instead of** letting the main loop execute the step, then:
  - folds the distilled report into investigation memory (`record_finding` /
    a `[DELEGATE RESULT]` system message with the report + artifact paths),
  - marks the step `completed` (or leaves `in_progress` with the subagent's
    `required_actions` if not `verified`),
  - the sub-transcript never enters the main context.
- Gated by session flag `delegation_enabled` (default True in adaptive mode).

**Fan-out (secondary):** one CORE tool `dispatch_agents(specs=[{agent,task}, …],
synthesize=false)`:
- Runs read-only specs in parallel via `run_subagents_parallel`, writes each
  report to `run_dir/<agent>-<i>.md`, returns a compact index (agent, one-line
  summary, path). With `synthesize=true`, a `synthesizer` read agent distills the
  files into one summary (the GSD wave pattern). Write specs are rejected here
  (fan-out is read-only by construction; writes go through plan-driven delegation).

### 4. GSD context-hygiene — `plugins/gsd/` + `agent.py` hooks

Replicates GSD's anti-context-rot mechanism:
- **Run artifact store:** `<memory_dir>/runs/<run_id>/`. Subagents write detail
  here; orchestrator keeps summary + path. `read_artifact(path)` /
  `list_artifacts()` (thin wrappers over filesystem tools scoped to the run dir).
- **Re-grounding checkpoints:** a session counter triggers, every
  `REGROUND_EVERY` steps or on phase change, a compaction that (a) evicts stale
  tool results (existing `evict_old_tool_results`), and (b) injects a compact
  `SITUATION` user message = goal + current phase + next action + top findings +
  open questions (pulled from plan + investigation). Keeps early instructions from
  being diluted → "task 50 = task 1 quality". Gated by `context_hygiene` flag.
- **Phase discipline:** the plan's phases already model discuss→plan→execute→verify;
  GSD adds the checkpoint on `plan_advance_phase` and encourages delegating an
  execute phase to a fresh subagent context.

### 5. Planning-superpowers — `plugins/planning-superpowers/`

- Skill `deep-planning/SKILL.md`: brainstorm → design → plan → verify workflow.
- Commands: `plan-feature`, `brainstorm`.
- Agents: `architect` (read; produces a phased plan + success criteria from a goal),
  `brainstormer` (read; interrogates requirements). These are dispatch targets for
  a `delegate`-tagged planning step or `dispatch_agents`.

### 6. Planning-gate fix — `agent.py` + `llm.py`

- Introduce `is_readonly_tool(name)` (a tool is read-only iff not in
  `MUTATING_TOOLS`). **All read-only tools run with no plan, unbounded** — delete
  `ORIENTATION_MAX_STEPS` cap and the narrow `ORIENTATION_TOOLS` whitelist path.
- Replace the `needs_plan` hard block: the first time the worker calls a
  **mutating** tool while no plan exists, inject **one** nudge ("about to change the
  workspace with no plan — call `plan_create` first, or proceed if truly trivial")
  and let the call through on the next turn. Track `mutating_gate_nudged` so it
  fires at most once.
- **Remove** the `plan_gate_retries → needs_plan=False "Proceeding without an
  explicit plan"** failure mode entirely. The plan is a living document: keep the
  drift nudge (`PLAN_TOUCH_NUDGE`) but never disable planning.
- Soften the replan gate the same way (nudge, don't hard-block read-only tools).
- Update the `PLAN & EXECUTE` prose in `llm.get_static_system_prompt`: "inspect the
  workspace as much as you need first; plan_create when you understand the task —
  before you change anything," dropping "call `plan_create` FIRST — a hard
  requirement."

## Data flow (delegation)

```
main loop (lean)                         subagent (isolated, own context)
  worker sets step in_progress
   └─ step.delegate == "native-analyst"?
        └─ run_subagent(native-analyst, task) ─────► ask_llm loop w/ filtered tools
                                                       writes runs/<id>/native-analyst.md
        ◄──────── {report, artifacts, verified} ─────┘  (transcript discarded)
   └─ fold report → investigation memory + [DELEGATE RESULT] note
   └─ mark step completed / keep w/ required_actions
```

## Testing (offline, no Docker/network — matches existing `tests/`)

- `test_subagents.py` — engine dispatches an agent_def, returns distilled report;
  read agents parallelize; write agents serialize (lock held); failure is
  non-blocking. Reviewer/ask_codebase refactor keeps their old returns
  (`test_reviewer.py`, existing QA tests stay green).
- `test_planning_gate.py` — read-only tools run with no plan and no cap; first
  mutating tool nudges once then proceeds; plan is never auto-disabled.
- `test_plugins.py` — loader parses a fixture plugin (agents/skills/commands/hooks);
  disabled plugin contributes nothing; skills merge from plugin roots; bad
  agent/toolset surfaces as an authoring error.
- `test_delegation.py` — a `delegate`-tagged step auto-dispatches (monkeypatched
  `run_subagent`) and folds the report into investigation; `dispatch_agents` fans
  out read-only and rejects write specs.
- `test_context_hygiene.py` — re-grounding injects a bounded SITUATION block and
  evicts stale results; history stays bounded across many simulated steps.
- Full existing suite (`test_investigation_memory`, `test_reviewer`,
  `test_review_gate`, `test_tool_arg_validation`, `test_autonomous_loop`,
  `test_tool_limits`, `test_progressive_tools`, `test_context_editing`,
  `test_prompt_integration`) must stay green.

## Non-goals / YAGNI

- No per-subagent workspace isolation (git worktrees per writer) — writers are
  serialized instead. Revisit only if parallel writers become necessary.
- No MCP server for state (GSD's option) — durable state stays in the existing
  JSON files + run artifact store.
- No new LLM provider or model routing — one model/key, as today.
- Commands are minimal (named prompts); not a full slash-command runtime, since the
  app is a desktop UI, not a CLI.

## Rollout / flags

`adaptive_planning` (exists) now also implies the new planning-gate behavior.
New session flags: `delegation_enabled`, `context_hygiene`, `plugins_enabled`
(all default True in adaptive mode, False keeps legacy behavior). Each phase lands
+ tests green before the next.
