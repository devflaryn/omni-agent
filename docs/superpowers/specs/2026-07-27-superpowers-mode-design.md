# Superpowers Mode — auto-brainstorm + subagent-driven-by-default — design

- **Date:** 2026-07-27
- **Status:** Approved (user pre-authorized autonomous decision-making)
- **Author:** brainstorming session (omni-agent)

## Problem

The framework already has every primitive needed for high-quality autonomous
work — a `brainstormer` persona, an `architect` persona, planner→worker→reviewer,
auto-delegation, a `verifier` — but they are **opt-in**. The orchestrator only
reaches for them when it decides to. In practice that means:

1. **No design phase by default.** A new task usually jumps straight to
   `plan_create` (or straight to mutating the workspace, then a soft plan nudge).
   The `brainstormer`/`architect` personas that would sharpen a fuzzy goal into a
   chosen approach are rarely dispatched. Result: plans grounded in the first
   idea rather than the best one.
2. **Subagent execution is a threshold nudge, not a default.** Auto-delegate only
   fans out when a phase holds ≥2 independent research steps (`AUTO_DELEGATE_READ_MIN`),
   and even then it is framed as a nudge. Most execution still runs inline in the
   orchestrator's own (cheap-model) context.
3. **The real Superpowers plugin asks the user questions** one at a time during
   brainstorming. The user explicitly does **not** want that here — the agent
   should brainstorm and **decide itself**, surfacing assumptions rather than
   questions.

## Goal

On every **non-trivial** new task, the agent should automatically:

1. **Brainstorm first, autonomously** — turn the goal into a crisp chosen
   approach (with rationale, rejected alternatives, and explicit assumptions)
   **without asking the user any questions** — before planning.
2. **Default to subagent-driven execution** — fan the plan's ready, independent
   steps out to subagents as the normal path, not a threshold-triggered nudge.
3. **Verify before "done"** — guarantee the verifier engages on a completion
   claim.

…unless the user **clearly states they want inline execution**, in which case
execution stays in the orchestrator's context (brainstorm still happens, inline).

The whole feature is gated by one session flag and is byte-identical to today's
behavior when off.

## Non-goals (YAGNI)

- **No new personas.** Reuse `brainstormer`, `architect`, `verifier`, and the
  existing execution roster verbatim.
- **No user-facing questions.** The auto-brainstorm never surfaces open questions
  to the user; it resolves them into stated ASSUMPTIONS and proceeds.
- **No new hook events / no plugin.** Shipped as a core gate (like the existing
  strategy-brief and plan gates), because it must fire at task-start and dispatch
  synchronously — advisory-only plugin hooks can't do that, and there is no
  task-start hook event.
- **No complexity *score*.** Trivial vs non-trivial is a cheap keyword/shape
  heuristic with a safe default (when unsure → treat as non-trivial, i.e. run the
  pipeline), not a learned difficulty model.
- **No change to write-parallelism.** Writes keep serializing on the existing
  `_WORKSPACE_LOCK`.

## Decisions (locked with user)

| Question | Decision |
|---|---|
| Core feature or plugin? | **Core feature**, session-flag-gated, in `agent.py`. Reuses existing personas. |
| When does the pipeline fire? | **Non-trivial new tasks only.** Trivial one-liners run inline, no wave. |
| Does brainstorm ask the user questions? | **Never.** It decides itself; open questions become recorded ASSUMPTIONS. |
| Default execution mode? | **Subagent-driven**, unless the user clearly asks for inline-only. |
| Does inline-only disable brainstorm? | **No.** Brainstorm still runs, but **inline** (self-brainstorm steering message, not a dispatched subagent). |

## Design

### A. New session flags (`agent.py`, set in `send_message`)

- `superpowers_enabled` — master switch. Default `True`; env `OMNI_SUPERPOWERS`
  (`0`/`false` → off, byte-identical to today). Read once at session init like
  the other `*_enabled` flags.
- `needs_brainstorm` — set `True` when a **new** task (same condition as
  `needs_plan`: no active plan or the previous one is complete) is **non-trivial**
  and superpowers is on. Cleared the moment the brainstorm gate has run once.
- `inline_only` — per-task; set `True` when the user's message matches the
  inline-only intent (see D). Reset every user turn.

All three reset/re-arm in the existing per-task reset block in `send_message`.

### B. `superpowers.py` (new module — mirrors `strategy.py`)

A tiny durable store for the **Design Brief** the brainstorm produces, so it
survives a context reset and can be pinned into the system prompt.

```
class DesignBrief:
    clarified_goal: str
    chosen_approach: str
    rationale: str
    rejected: list[str]          # rejected alternatives, one line each
    assumptions: list[str]       # resolved "open questions", labeled
    risks: list[str]
    created_ts, source           # source = "subagent" | "inline"

    def render() -> str          # compact pinned block, ~15 lines max
    def to_dict()/from_dict()    # persistence

get_active() / set_active(brief) / clear()
# persisted to <memory_dir>/design_brief.json, loaded on session restore
```

`render()` produces a `## DESIGN BRIEF` block pinned into the system prompt near
the Strategic Brief (below the strategy brief, above the plan), so planning and
execution stay anchored to the chosen approach. Single-writer orchestrator state:
subagents do **not** receive the `superpowers_*` tools and get at most a one-line
read slice (chosen approach) in their context — same treatment as the strategy
brief.

### C. The auto-brainstorm gate (`agent.py`)

New method `_maybe_run_brainstorm_gate(s, tool_name)`, called from the pre-tool
gate stack **before** the strategy-brief and plan gates (so brainstorm precedes
planning). Structure mirrors `_run_strategy_review_gate` (which already runs a
synchronous subagent from inside the gate).

Behavior when `s["superpowers_enabled"]` and `s["needs_brainstorm"]` and this is
the first tool call of the task:

- **Subagent path** (default, not inline-only): synchronously
  `run_subagent(brainstormer_def, task, context=<distilled workspace context>,
  on_event=self._subagent_event_sink)`. The task text is wrapped with an
  **autonomy override**:

  > "AUTONOMOUS MODE: do NOT defer to the user and do NOT return OPEN QUESTIONS.
  > Resolve each open question yourself with your best-judgment ASSUMPTION and
  > label it. Return the brief with an ASSUMPTIONS section instead of questions."

  Parse the distilled report into a `DesignBrief` (best-effort section parse;
  on parse failure, store the whole report as `chosen_approach` — never fail the
  task). `set_active(brief)`, clear `needs_brainstorm`, inject a `[SYSTEM]`
  steering message ("Design brief ready — plan against the chosen approach:
  …") and `return "continue"` so the model re-plans grounded by the brief.

- **Inline path** (`inline_only` is set): do **not** dispatch a subagent. Instead
  inject a one-shot `[SYSTEM]` self-brainstorm steering message ("Before planning,
  brainstorm inline: state the clarified goal, 2–3 approaches with trade-offs,
  pick one with rationale, and list your assumptions — do not ask me, decide.")
  and clear `needs_brainstorm`. Quality step preserved without violating
  inline-only.

Bounded and safe: fires **once** per task (flag cleared), never raises (subagent
failure degrades to the inline path with a note), and reads are never blocked
before it — recon stays free, exactly like the strategy gate.

### D. Inline-only detection (`agent.py`)

`_detect_inline_only(text) -> bool` — case-insensitive match on clear intent:
`"inline only"`, `"inline exec"`, `"no subagent"`, `"without subagent"`,
`"don't delegate"`, `"do not delegate"`, `"no delegation"`, `"do it yourself"`,
`"inline execution"`. Conservative: only clear phrasings, so a passing mention of
the word "inline" in a code task does not trip it. Set on the session in
`send_message`.

### E. Triviality escape (`agent.py`)

`_is_trivial_task(text) -> bool` — a new task is trivial when it is short and
matches a single-edit shape: rename / typo / one-line / one-word / "bump
version" / "add a comment" / "change the string" and similar, with no multi-file
or design signal. Heuristic, tunable, and **fails safe**: when unsure, return
`False` (run the full pipeline). Trivial tasks skip the brainstorm gate and the
subagent-driven default entirely (they run inline as today).

### F. Subagent-driven execution by default (`agent.py`)

When `superpowers_enabled` and **not** `inline_only`, the existing auto-delegate
becomes the default rather than a threshold nudge:

- Lower the effective read fan-out floor to **1** (a single independent research
  step is enough to delegate) by treating `AUTO_DELEGATE_READ_MIN` as `1` in this
  mode.
- Bias `_maybe_auto_tag_delegatable_steps` / `_maybe_dispatch_delegated_steps` to
  tag and dispatch each phase's ready, independent steps as a wave by default,
  instead of only under the solo-read streak.
- Explicit `delegate=` tags and `dispatch_agents` calls are unchanged. Writes
  still serialize on `_WORKSPACE_LOCK`.

When `inline_only`: auto-tagging/auto-dispatch is suppressed (explicit
`delegate=` tags still honored), so execution stays in the orchestrator context.

This is a behavioral bias on existing machinery, not new dispatch code.

### G. Verify before done

No new code — the `verification` plugin's `on_final_answer` hook already sends an
unverified completion claim back for a verifier pass. Superpowers' contribution
is ensuring the plan/brief carry a verifiable "done when…" so that gate has
something objective to check. Documented, not re-implemented.

### H. System-prompt fold

The `DesignBrief.render()` block is folded into the system prompt at the same
place the Strategic Brief and plan are folded, pinned below the strategy brief.
Gated on `superpowers_enabled` and a present brief, so it is absent (byte-for-byte)
when off or before the brief exists.

## Data flow

```
send_message(new, non-trivial, not inline-only)
  → needs_brainstorm=True
  → first tool call → _maybe_run_brainstorm_gate
      → run_subagent(brainstormer, autonomy-override)  [synchronous]
      → DesignBrief stored + pinned in prompt
      → [SYSTEM] "plan against the chosen approach"
  → model calls plan_create (grounded by brief)
  → phase steps auto-tagged + dispatched to subagents (default)
  → final_answer → verification hook → verifier wave
```

Inline-only swaps the subagent brainstorm for an inline self-brainstorm message
and suppresses auto-dispatch; trivial tasks skip straight to today's inline flow.

## Error handling

- Brainstorm subagent failure → degrade to inline self-brainstorm message + a
  user-visible note; never fail the task, never deadlock (flag cleared regardless).
- Design-brief parse failure → store raw report as the approach; still usable.
- Missing `brainstormer` persona (plugin disabled) → skip the gate with a note.
- Everything gated: `OMNI_SUPERPOWERS=0` → all new code paths are inert.

## Testing (`tests/test_superpowers.py`, offline, no Docker/LLM)

1. `_is_trivial_task` — trivial phrasings → `True`; substantive tasks → `False`;
   ambiguous → `False` (fail-safe).
2. `_detect_inline_only` — clear inline phrasings → `True`; incidental "inline"
   mention → `False`.
3. `DesignBrief` round-trip — `to_dict`/`from_dict`, `render()` shape/length.
4. Gate fires once — `needs_brainstorm` cleared after one run; not re-run on the
   next tool call in the same task.
5. Byte-identical when off — with `superpowers_enabled=False`, the composed
   system prompt and the pre-tool gate outcome match a pre-feature baseline.
6. Inline-only path — no subagent dispatch attempted; self-brainstorm message
   injected; auto-dispatch suppressed.

(Follows the existing offline harness in `tests/test_strategy_*.py` /
`tests/test_review_gate.py`.)

## Config knobs

- `OMNI_SUPERPOWERS` — master env switch (default on).
- Session `superpowers_enabled` / `inline_only` / `needs_brainstorm`.
- Reuses `OMNI_AUTO_DELEGATE`, `AUTO_DELEGATE_READ_MIN`, the model ladder, and the
  premium budget verbatim (the brainstormer is `tier: premium`, so it obeys the
  existing premium budget/degrade path automatically).

## Docs

New "Superpowers Mode" section in `AGENTS.md` beside the evidence-based-workflow
and delegation doctrine.
