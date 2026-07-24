# Strategic Brief — a decision-shaping strategic spine

Date: 2026-07-24
Status: design (approved for planning)
Model: fixed (GLM 5.2 primary + DeepSeek fallback) — the win must come from the
framework, not the model.

## Problem

On long APK-modding runs the agent's two recurring failure modes are **strategic**
(it aims the whole run wrong — misjudges the protection, picks the wrong attack or
order before any tool runs) and **thread-loss** (over a long run it drifts from the
goal, re-derives or contradicts earlier findings). The tactical layer is already
well-guarded — the validation gate, final-answer reviewer, and repeat-failure guard
hold there; the user does *not* see failures at that level.

The durable structures that *should* cover thread-loss already exist and are
**maintained faithfully** — `investigation.json` (atomized findings/hypotheses,
survives summarization) and the live plan (tactical task list). The gap is not
adherence. It is **shape**: neither structure is a synthesized *strategic thesis*,
so the model can have every fact on file and still mis-aim the run or drift, because
nothing forces the facts into a single coherent "what I'm doing and why" that stays
in front of it and gets challenged.

Diagnosis, in one line: **maintained-but-passive memory does not shape decisions.**
The fix is a small, synthesized, always-visible, adversarially-tested thesis — a
decision-*shaping* structure.

## Non-goals

- No change to the tactical guards (validation gate, final-answer reviewer,
  repeat-failure guard) — they work; we build one level above them.
- No auto-synthesis engine that writes the brief for the model — the model already
  maintains structures well; adherence is not the problem (see Decision 1).
- No new concurrency primitive, lock, or subagent-writable state (see §4).
- No model switch, no new provider/key.

## The artifact

A new module `strategy.py`, a sibling of `planning.py` / `investigation.py`, with
the same shape: a per-session **active brief** object exposing `to_markdown()` and a
`notify` callback wired to `AgentApi._refresh_system_prompt` (mirrors
`_on_plan_update` / `_on_investigation_update`). It is **orchestrator-session state
with exactly one writer** — the main loop. That single-writer placement is the
foundation of subagent-safety (§4).

The brief is small (target ≤ ~20 rendered lines) and structured:

| Field | Purpose |
|-------|---------|
| **Goal** | One line, restated verbatim from the mission — the drift anchor. |
| **Diagnosis** | What protection(s) are actually present; each item carries an evidence pointer into `investigation.json`. |
| **Strategy + rationale** | The chosen attack and why, in order. |
| **Rejected alternatives** | Strategies considered and ruled out — so a dead path is not silently re-litigated or forgotten. |
| **Top hypothesis** | The current best guess under test. |
| **Kill-criteria** | Explicit conditions under which this strategy is wrong and must be abandoned. |

`to_markdown()` renders these compactly; an empty/partial brief renders only the
fields present (so early recon shows a stub, not noise).

## How it is built and kept current

**Model-written via tools** (Decision 1) — new *core, orchestrator-only* tools:

- `strategy_set(goal, diagnosis, strategy, rationale, ...)` — author/replace the brief.
- `strategy_update(field=..., ...)` — revise one or more fields.

These mirror the ergonomics of `plan_*` and `record_*`. The reasoning model owns the
thesis; the tools just persist it and fire the notify → prompt-refresh.

Four framework enforcements turn "maintained" into "decision-shaping" (this is where
Approaches 2 and 3 from brainstorming are folded in). **Every one is gated by the
`strategy_brief_enabled` session flag and is a no-op when the flag is off (§5).**

1. **Diagnosis-phase gate** (Approach 3, decision-point gating). The loop refuses to
   run a **mutating** tool (`agent.MUTATING_TOOLS`) until a brief exists with its
   required fields (Goal, Diagnosis, Strategy) filled *and* it has passed one
   strategy-review. Read/recon tools are entirely unrestricted — you investigate
   freely; you just cannot start *patching* before you have committed a diagnosed,
   reviewed strategy. On block, the model gets an actionable nudge (call
   `strategy_set` / request review), never a hard error. This reuses the existing
   `MUTATING_TOOLS` classification and sits beside the current `mutating_gate_nudged`
   soft-nudge path — it does not replace it.

2. **Adversarial strategy review** (Approach 1 core). Reuse the existing reviewer
   machinery (`tools/reviewer.run_review` / the isolated read-only subagent runner),
   fired on the *brief* instead of a final answer: an independent pass that actively
   tries to find a better strategy or an evidence contradiction, returning
   approve / revise-with-feedback. Fires once before execution is unlocked, and again
   on each re-synthesis. Bounded exactly like the final-answer reviewer
   (`REVIEW_MAX_STEPS`, a max-rounds cap) so it can never deadlock.

3. **Re-synthesis triggers** (Approach 2, reconciliation). At phase boundaries (the
   existing `on_phase_change` fire point) and after N new findings, the worker is
   nudged to reconcile the brief against accumulated evidence; the strategy review
   re-fires on the revision. Nudge-only — it never rewrites the brief itself.

4. **Kill-criteria checks.** Lightweight: when the *existing* repeat-failure /
   validation-gate / watchdog signals indicate a stall, cross-reference the brief's
   kill-criteria and nudge "kill-criterion K appears met — abandon this strategy or
   justify continuing," instead of letting the run grind. No new signal source; it
   reads state the loop already tracks (`failed_sigs`, `tool_fail_streak`, etc.).

## How it shapes decisions

Pinned at the **top** of the orchestrator system prompt in `_refresh_system_prompt`,
**above** the plan and investigation memory, so it is the first thing in context
every turn. That position is what counters both failure modes: it is the stable
north-star that resists drift, and its diagnosis-then-review construction resists
mis-strategization at the source. Composition order becomes:

```
base_system_prompt + tools_section + [STRATEGIC BRIEF] + [CURRENT PLAN] + [INVESTIGATION MEMORY]
```

When the flag is off, or the brief is empty, the `[STRATEGIC BRIEF]` block is omitted
entirely and the prompt is byte-identical to today's.

## §4 Subagent-safety (hard requirement)

The orchestrator drives parallel/serial subagent waves (`subagents.py`,
`run_subagents_parallel`, plan-step delegation). The brief must not perturb that.
Safe **by construction** via three choices:

- **Single writer.** The brief is orchestrator-session state. Subagents *never*
  mutate it — they return distilled reports, and only the orchestrator folds those
  into the brief (via the model calling `strategy_update`). No new lock, no shared
  mutable state, nothing resembling the earlier row-key/key-sharing collision.
  Parallel read-waves are byte-for-byte unaffected.

- **Subagents get a read-only *slice*, not the pinned block.**
  `_compose_delegate_context` already ships mission / success-criteria / constraints
  / current-phase to each subagent. We append exactly **two lines** — the current
  **Strategy** and **Top hypothesis** — so a wave of researchers pulls the same
  direction. Subagents receive **none** of: diagnosis internals, rejected
  alternatives, kill-criteria, the pinned brief block, or any `strategy_*` tool.
  `strategy_set` / `strategy_update` are in `SUBAGENT_EXCLUDED` (or simply outside
  every subagent's resolved tool surface), so a subagent can neither see nor call
  them. Subagent prompts do not bloat; subagents execute a scoped task and do not
  re-strategize.

- **The strategy reviewer *is* a subagent.** It runs through the existing isolated
  read-only runner, inheriting all its safety (bounded steps, never-raises, key
  allocation, discarded sub-transcript). It is invoked from the single-threaded
  orchestrator loop, so it never overlaps brief mutation.

## §5 Compatibility — "the steps don't break anything"

Every integration point is guarded so that **`strategy_brief_enabled = False`
reproduces today's behavior exactly.** Enumerated:

| Integration point | Guard / invariant when flag is OFF |
|---|---|
| `strategy.py` module | Imported but inert; no active brief created. |
| `strategy_set` / `strategy_update` tools | Registered as core tools, but the model is never prompted toward them and the diagnosis gate that gives them force is off. (Optionally: only register when flag on. Planning decides; either keeps behavior identical.) |
| `_refresh_system_prompt` brief block | Block omitted → system message byte-identical to current. |
| Diagnosis-phase mutating gate | Skipped → mutating tools run exactly as today (existing `mutating_gate_nudged` path unchanged). |
| Strategy review | Never fired → reviewer machinery only serves final answers, as today. |
| Re-synthesis / kill-criteria nudges | Never fired → no `[SYSTEM]` messages added. |
| `_compose_delegate_context` slice | Two brief lines appended only when a non-empty brief exists *and* flag on → subagent context identical to today otherwise. |
| Subagents | Never receive `strategy_*` tools in any mode → `resolve_allowed_tools` output unchanged; every `test_subagents` / `test_delegation` / `test_skill_toolsets` assertion holds. |
| `get_tool_prompt(active_groups=None)` | Full-render for isolated subagents/tests untouched. |

Default: **on** for real runs (matching `context_editing` / `review_enabled`
defaulting on), off is the kill switch. The flag lives in the `start_session` flag
block beside `review_enabled` / `parallel_execution_enabled`.

Additional invariants:
- The brief never raises into the loop (persist failures degrade like
  investigation-memory persistence does today).
- The diagnosis gate blocks only `MUTATING_TOOLS`; a read-only investigation can
  never deadlock on it.
- Bounded review rounds (reuse `MAX_REVIEW_ROUNDS` / a dedicated cap) — the strategy
  review can never loop forever.

## Testing

Offline, no Docker/network — mirroring `test_investigation_memory` /
`test_reviewer`:

- `test_strategy_brief` — brief lifecycle (set/update/render, empty renders nothing).
- Diagnosis gate — a mutating tool is blocked with a nudge before a brief exists;
  allowed once a reviewed brief exists; read tools never blocked.
- Prompt composition — brief pins above plan/investigation when on; block absent when
  off or empty (byte-identical assertion).
- Subagent slice — the two-line strategy slice reaches `_compose_delegate_context`
  output when on; absent when off; `strategy_*` never in any subagent's resolved
  tools.
- Strategy review — approve accepts; revise injects feedback and re-fires; bounded by
  the round cap.
- Regression — with the flag off, existing subagent/delegation/reviewer/plan tests
  pass unchanged.

## Configuration knobs

- `strategy_brief_enabled` (session flag, default on) — master switch.
- Re-synthesis "after N findings" threshold — a module constant, default 5.
- Strategy-review round cap — reuse `MAX_REVIEW_ROUNDS` or a dedicated
  `MAX_STRATEGY_REVIEW_ROUNDS`.

## Decisions (locked in brainstorming)

1. **Model-written brief** via tools, not an auto-synthesis subagent — cheaper, and
   the model already maintains structures faithfully; the insufficiency was shape and
   position, not authorship.
2. **The diagnosis gate blocks only mutating tools**, never reads — recon stays free
   and a read-only run can't deadlock.
3. **Reuse the reviewer machinery** for strategy review rather than a new reviewer.
