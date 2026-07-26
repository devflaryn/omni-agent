# Premium-aware subagent expansion — design

- **Date:** 2026-07-26
- **Status:** Draft, awaiting user review
- **Author:** brainstorming session (omni-agent)

## Problem

The subagent system works but is under-used and cost-blind:

1. **Roster is under-routed.** Six personas exist on disk (`researcher`,
   `native-analyst`, `implementer`, `architect`, `brainstormer`, `verifier`),
   but auto-delegation only ever fans out to `researcher` (read waves) and
   `implementer` (self-contained RE writes). The premium personas
   (`architect`/`brainstormer`/`verifier`) are never reached automatically.
2. **No premium code-writing path.** `implementer` is `tier: standard` and its
   toolset is reverse-engineering only (`smali, native, apk`) — there is no home
   for general, complex, multi-file *source* editing, and no way to run it on a
   premium model.
3. **No premium decision path.** Per current doctrine, judgment steps are
   deliberately kept by the orchestrator ("the orchestrator keeps its own
   reasoning"). But the orchestrator runs on a *cheap* model, so high-level
   decision-making never benefits from an expensive model.
4. **Premium is scarce.** The premium model has usage limits; it must be spent
   only when it clearly lifts quality, and must degrade gracefully — never fail a
   step — when capped or rate-limited.

## Goal

Let the **cheap main orchestrator decide** to spend an expensive model inside a
subagent for (a) complex code editing, (b) hard high-level decisions, and
(c) stubborn debugging — while staying cheap by default and rationing premium to
the sweet spot: skip it when it won't change the outcome, don't hesitate when it
clearly improves quality.

## Non-goals (YAGNI)

- **No write-parallelism.** Writes keep serializing on the existing
  `_WORKSPACE_LOCK` (user's explicit decision — two agents editing one
  decompiled tree corrupts it). Delegation's payoff here is context-isolation +
  cost + quality, not raw write speed.
- **No automatic complexity scoring.** Premium is entered by explicit model
  self-tag, not by a heuristic difficulty score.
- **No new provider integrations**, no hard per-call blocking beyond the soft
  cap's graceful degrade.

## Decisions (locked with user)

| Question | Decision |
|---|---|
| How does the cheap orchestrator decide to use premium? | **Model self-tags** `@premium` explicitly when it judges the work worth it. |
| Which new purposes? | Complex code editing, hard decisions/consulting, debugging — **and** better routing to the existing roster. |
| How is premium's scarcity enforced? | **Doctrine + soft budget counter + hard fallback-down** on cap/429. |
| What does "improvement" mean? | **Quality + smart cost**; keep serialized writes; do not pursue write speed. |

## Design

### A. New personas

Three new `.md` personas in `plugins/omni-agents/agents/` (auto-discovered and
auto-advertised via `plugins.py` frontmatter parsing — no registration code):

| Persona | Mode | Toolset | Default tier | Purpose |
|---|---|---|---|---|
| **engineer** | write | full (read/write/run — not RE-scoped) | `standard` | General complex/multi-file *source* editing. The home "edit codes" never had. |
| **consultant** | read | read/search | `standard` | Orchestrator asks ONE hard decision mid-run and gets a recommendation it then executes. The sanctioned way expensive reasoning enters a cheap run. |
| **debugger** | write | full + run | `standard` | Reproduce → hypothesize → isolate root cause → fix. Typically invoked `@premium` *after* a `standard` attempt already failed. |

Rationale for a new `engineer` rather than widening `implementer`: keeps the RE
patch surface tight and safe, while general coding gets full tools. Default tier
is `standard` for all three — cheap by default; premium is opt-in per call.
`implementer`/`architect`/`brainstormer`/`verifier` are unchanged.

### B. Self-tag premium routing + doctrine

The mechanism already works technically: `delegate="engineer@premium"` on a plan
step, or `"tier":"premium"` / `"models":[...]` in a `dispatch_agents` spec, is
honored by `resolve_model_ladder`. The gap is *doctrine*. Add a **"Spending
premium"** block to `AGENTS.md`:

- **Spend premium when — and only when — at least one holds:** the change is
  cross-cutting / multi-file with non-obvious interactions; a `standard` attempt
  already failed or was reverted; the decision is high-stakes and hard to
  reverse; correctness is subtle (concurrency, security, protocol/format edges).
- **Do NOT spend premium for:** research, reads, search, summarization,
  mechanical/localized edits, formatting, or anything a `standard` attempt has
  not yet been given a shot at.
- **Default is cheap.** Premium is scarce (usage limits). When unsure, try
  `standard` first; escalate only on evidence it is insufficient.
- Judgment steps remain excluded from *auto*-delegation, but the doctrine now
  explicitly permits handing a hard decision to `consultant@premium` and acting
  on the answer.

### C. Soft budget counter (visibility + nudge)

A per-session premium counter that the orchestrator sees, so it self-rations:

- Increment on each premium **subagent dispatch** (where `effective_tier`
  resolves to `premium` in `run_subagent`).
- Inject a compact line into the refreshed system prompt
  (`_refresh_system_prompt`): `[premium budget: N/M used this session]`.
- Cap `M` is advisory and env-configurable: `OMNI_PREMIUM_BUDGET` (default
  **5**; `0` = unlimited / disabled).
- As usage nears the cap, an escalating nudge fires (same re-arming pattern as
  the existing delegation nudges): "premium nearly spent — reserve it for the
  highest-value remaining step."
- Advisory only — it shapes choices; it does not block (blocking/degrade is D).

### D. Hard fallback-down (graceful degradation)

Today the ladder only escalates **up** (`escalate_ladder` bumps a rung on
repeated parse errors; the ladder tail appends *higher* rungs). Premium needs the
opposite safety net so a capped/rate-limited premium never *fails* a step:

- When a `@premium` dispatch resolves, if the soft cap is **exceeded** OR premium
  providers return rate-limit/unavailable (429 / provider-down at request time),
  the subagent's ladder **degrades down to `standard`** instead of erroring.
- Logged as a telemetry note (`"premium unavailable → ran standard"`), surfaced
  in the subagents dock and the run event stream.
- Implementation seam: extend `resolve_model_ladder` so a premium tier's ladder
  appends the **lower** rungs as a last-resort tail (mirror of the existing
  higher-rung tail), and honor the budget / 429 signal when choosing the starting
  rung. No change to locking or dispatch flow.

### E. Better routing to the existing roster

- Wire up the idle premium personas via doctrine + light heuristics:
  `brainstormer` / `architect` when a goal is big or ambiguous *before* planning;
  `verifier` after a completion claim (align with the existing `verification`
  plugin hook). They stay premium but are naturally rare, so they fit the budget.
- `engineer` / `debugger` writes serialize on `_WORKSPACE_LOCK` exactly like
  `implementer`. No write-parallelism.

### F. Domain-knowledge access for subagents (quality win)

**The gap:** a subagent's system prompt is only `persona body + contract + tool
list` (`subagents._build_messages`). It never receives the skills index and
cannot call `use_skill`. So `native-analyst`, `implementer`, and the new personas
run *without* the repo's deep APK skill library (`android-package-anatomy`,
`apk-modding`, `apk-toolchain`, `dex-multidex-handling`,
`manifest-resource-editing`, `native-code-injection`, `native-patching`,
`signature-bypass`, `smali-code-injection`, `ssl-pinning-bypass`,
`root-detection-bypass`, `string-deobfuscation`, `anti-debug-bypass`, …). Those
skills ARE the "know exactly how APKs are structured, how to modify them, what
returns what" knowledge the agent's core mission needs — subagents just can't
reach them today. This directly serves result quality.

**The fix** (mirror how the orchestrator already uses skills — index + load on
demand, so context stays lean):

1. **Inject the skills index into subagent prompts.** Add `get_skills_prompt()`
   output to `_build_messages` (the index is compact — name/description/when —
   full bodies stay on demand). Scope it to subagents that can act on skills
   (i.e. skip `researcher` if the extra tokens aren't worth it; definitely
   include the RE + write personas).
2. **Grant `use_skill` + `read_skill_resource`** to the personas that get the
   index, so they can pull a skill's full body and bring its toolset online on
   demand — exactly like the orchestrator. (Loading a skill already folds its
   toolset's full schemas into the live tool list, per `skill_toolsets`.)
3. **Persona-pinned skills (optional preload).** Let a persona declare
   `skills:` in its `.md` frontmatter to preload 1–2 core skill bodies up front
   for that role, e.g. `native-analyst` → `android-package-anatomy`,
   `native-patching`; `implementer` → `smali-code-injection`,
   `manifest-resource-editing`; `engineer` → `apk-modding`, `apk-toolchain`;
   `debugger` → `frida-dynamic-instrumentation`, `anti-debug-bypass`. Everything
   else stays reachable on demand via the index.

**Cost note:** the index is small and load-on-demand keeps bodies out of the base
prompt, so this adds little steady-state cost while sharply raising the ceiling on
what a subagent can do correctly the first time — fewer failed attempts, which
*also* reduces premium escalations (D) and total spend.

## Testing

Extend existing offline suites (`test_subagent_routing.py`,
`test_model_ladder.py`, `test_delegation_nudges.py`, `test_subagents.py`):

1. New personas (`engineer`, `consultant`, `debugger`) are discovered and
   advertised to the orchestrator.
2. `@premium` self-tag resolves to the premium ladder.
3. Budget counter increments on premium dispatch and injects the budget line.
4. Over-budget premium dispatch degrades to `standard` (does not fail).
5. Simulated 429 on premium degrades to `standard` (does not fail).
6. `standard` default routing is unaffected when nothing tags premium.
7. Subagent prompts include the skills index and `use_skill` is in their allowed
   tools; a persona's pinned `skills:` frontmatter preloads those bodies
   (`test_skill_toolsets.py`, `test_subagents.py`).

## Adjustable defaults (flag for user review)

- `OMNI_PREMIUM_BUDGET` default = **5** per session.
- Persona names: `engineer`, `consultant`, `debugger`.
- Which roster members get auto-routing doctrine: `brainstormer`, `architect`,
  `verifier`.

## Affected files (anticipated)

- `plugins/omni-agents/agents/{engineer,consultant,debugger}.md` (new)
- `AGENTS.md` — "Spending premium" doctrine + roster-routing guidance
- `subagents.py` — `resolve_model_ladder` fallback-down tail; premium-dispatch
  counter hook; `_build_messages` skills-index injection; `AgentDef` `skills`
  field + preload
- `agent.py` — budget counter state + `_refresh_system_prompt` injection +
  re-arming premium nudge
- `llm.py` — surface a premium rate-limit / unavailable signal for the degrade
- `plugins.py` — parse `skills:` from persona frontmatter into `AgentDef`
- `skills_loader.py` — reuse `get_skills_prompt()` / body loader for subagents
- tests as listed above
