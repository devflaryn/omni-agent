# Parallel-by-default subagent execution + concurrency dock

**Date:** 2026-07-23
**Status:** Approved (brainstorm) — ready for implementation plan
**Supersedes emphasis of:** `2026-07-23-genuine-parallelism-visibility-design.md` (that spec made the
wave engine genuinely parallel; this spec makes the agent actually *use* wide parallelism, and makes it
visible/provable).

## 1. Problem

The wave engine (`subagents.run_subagents_parallel`) is genuinely concurrent, but two things stop the
user from ever seeing or benefiting from it:

1. **Work is dispatched one step at a time.** `parse_response` returns a single tool call per turn, and
   the model marks exactly one plan step `in_progress` per turn via `plan_update_task`. So
   `_maybe_dispatch_delegated_steps` almost always sees a single newly-`in_progress` delegated step and
   runs a "wave" of size 1. The batching of independent reads exists in code but effectively never fires.
   Net effect: the agent trickles helper-steps out sequentially even when they are independent.
2. **Concurrency is invisible.** The live telemetry panel is appended *inline into the chat scroll*
   (`app.js` `_subagentPanel` → `appendRow`), so it drifts away and the user has never noticed it. Even
   when seen, stacked rows do not *prove* wall-clock overlap.

Additionally, concurrency is self-capped at `keys-1` (`subagents._pool_size`), a headroom reservation
that made sense when optimizing for warm per-key prompt cache (a cost optimization).

**User priority (explicit):** API cost is irrelevant. Optimize purely for the agent finishing the job as
**fast** and as **intelligently** as possible.

## 2. Goals

- **G1 — Parallel-by-default execution:** independent delegatable steps in the active phase run
  concurrently as one wide wave instead of one at a time.
- **G2 — Uncapped concurrency:** remove the `keys-1` ceiling; run as many subagents at once as the work
  needs, up to a high safety limit, sharing keys freely (cost/cache no longer a constraint).
- **G3 — Provable visibility:** a persistent, always-visible bottom-right timeline dock whose overlapping
  bars and a "wall vs summed → N× faster" line make parallelism obvious at a glance.
- **G4 — Verifiable now:** a dev-only trigger that fires a synthetic wave so the dock can be validated
  end-to-end without contriving a real delegating task.

## 3. Non-goals (YAGNI)

- No nested/recursive delegation (subagents still get no delegation tools).
- No speculative/redundant racing of duplicate attempts (explicitly deferred; user chose "lift the limits"
  over "race duplicates").
- No multiple *simultaneous* waves across different phases — phases still run in order; only the steps
  *within* the active phase parallelize. (Keeps the "one wave holds keys at a time" invariant intact.)
- No removal of the model fallback ladder — it is a resilience/speed feature (fall through only on error
  or rate-limit), not a cost saving. Smartest configured model is already tried first.
- No change to how a single subagent runs internally (`run_subagent` / `_run_loop` unchanged).

## 4. Design

Three coordinated pieces: (A) the execution-model change, (B) the concurrency lift, (C) the dock. A and B
are the performance/intelligence win; C is the proof.

### 4.A Parallel-by-default plan execution

**Concept:** the active phase is a *batch of parallel work*. Phases still run strictly in order; within
the active phase, every delegatable step whose dependencies are satisfied runs at once.

**Data model — new optional field on a plan step (`planning.py`):**
- `depends_on: list[str]` — step ids within the same phase that must be `completed`/`skipped` before this
  step is eligible. **Default: `[]` (no dependencies → independent → eligible immediately).** Parallelism
  is therefore the default; the planner *adds* constraints where a step genuinely needs a prior step's
  output. Unknown/foreign ids are ignored (never block forever); a self-reference is dropped.

**Eligibility.** A step is *ready to dispatch* when all of the following hold:
- it belongs to the current phase (`plan.current_phase_id`),
- it has a `delegate` agent set and its id is not already in `session["dispatched_steps"]`,
- its status is `pending` or `in_progress`,
- every id in `depends_on` (restricted to same-phase ids) is `completed` or `skipped`.

**Trigger (minimal disruption).** Keep the existing trigger: the model marks a step `in_progress`, which
calls `_maybe_dispatch_delegated_steps` (agent.py:2912). Change that method so that instead of dispatching
only the just-started step, it **pulls forward every ready delegatable step in the active phase** and
dispatches the whole batch:
- Ready **read** steps → one wide parallel wave via `run_subagents_parallel` (the existing
  `_run_delegated_read_wave`, now fed the whole ready set). The harness marks each pulled-forward step
  `in_progress` itself and adds it to `dispatched_steps` before the wave, emitting the normal
  `delegate_running` narration per step so the UI still opens a group per step.
- Ready **write** steps → still serial, one at a time behind `_WORKSPACE_LOCK`, after the read wave, and
  only those whose deps are satisfied.
- After folding results, if new steps became ready (a dependency just completed), loop and dispatch the
  next ready batch within the same phase until no delegatable step is ready. Bound the loop by
  `len(plan.items)` iterations as a cycle/no-progress guard.

**Cross-phase / dependent work.** Ordering that must be sequential is expressed two ways, both planner-
controlled: put dependent work in a *later phase* (phases run in order), or set `depends_on` within a
phase. Non-delegated steps (the agent does them itself) are untouched by this batching.

**Planner prompt update (`planning.py` / static system prompt).** Teach the planner the new semantics in
one short block: "Steps in the same phase run in PARALLEL by default. Put independent research/probes in
the same phase to run them at once. If a step needs another step's result, either set its `depends_on` to
that step's id (same phase) or place it in a later phase. Writes to the workspace are always serialized
for you." This is where the *intelligence* gain comes from — the planner now reasons explicitly about
independence.

**Config gate.** `session["parallel_execution_enabled"]` (default `True`). When `False`, fall back to
today's one-step-at-a-time behavior (dispatch only the just-started step). Provides a safe kill switch.

### 4.B Uncapped concurrency

- **`subagents._pool_size`:** replace `min(keys-1, n_specs)` with `min(SUBAGENT_MAX_CONCURRENCY, n_specs)`,
  where `SUBAGENT_MAX_CONCURRENCY` is a module constant (default `16`) overridable via env
  (`OMNI_SUBAGENT_MAX_CONCURRENCY`). No longer tied to key count; floored at 1.
- **`KeyAllocator`:** unchanged — it already hands out the least-loaded key and correctly *shares* keys
  when `n_workers > n_keys` (verified: 15 workers / 5 keys → 3 each). Each subagent thread pins its
  assigned key in its llm thread-local; concurrent requests on a shared key are independent HTTP calls and
  safe. Warm-cache-per-key degrades gracefully under sharing, which is acceptable (cost irrelevant).
- **Rate-limit resilience:** because more requests now hit the same keys at once, rely on the existing
  model fallback ladder / retry path in `llm.py` for 429s. No new backoff logic in this spec; if live runs
  surface throttling, add jittered retry as a fast-follow (note it, don't build speculatively).
- **Invariant preserved:** still only one wave holds keys at a time (phases are sequential), so the
  distinct-key row-keying assumption the frontend relies on is unaffected. Row key nonetheless upgrades to
  include `wave_id` when present (see 4.C) to future-proof.

### 4.C Backend wave events

`subagents.run_subagents_parallel` emits, only when `on_event` is provided:
- `wave_started` — `{type, wave_id, size, workers}` immediately before launching the pool. `wave_id` is a
  short uuid4 hex; `size` = number of specs; `workers` = computed pool size.
- `wave_done` — `{type, wave_id}` after all results are collected (in `finally`, so a crash still closes
  the wave).

The backend computes no timing or overlap — the frontend derives everything from event arrival times.
`subagent_started/progress/done` already carry `agent`, `task`, `key_label`, `mode`, `elapsed_s`,
`tokens`, `step`, `max_steps`, `steps`, `ok`. Serial write-delegate steps that call `run_subagent`
directly (not through the wave engine) carry no wave events; the dock treats them as a singleton wave via
count inference (4.D).

### 4.D Frontend concurrency timeline dock

**Placement.** New `#concurrency-dock`, `position: fixed` bottom-right, above the chat, styled with the
existing `--term-*` theme vars (light+dark). Replaces the inline `subagent-panel` as the primary surface
(the old inline panel code is removed). Idle → collapses to a small `⚡ idle` pill; a wave auto-expands it;
clicking the header toggles collapse/expand (manual state persists until the next wave). ~380px wide,
`max-height: 40vh`, internal scroll when many bars.

**Data model (frontend).** A single live `wave` object: `{ originTs, bars, done }` where each `bar` is
`{ rowKey, name, keyLabel, mode, startOffsetMs, endOffsetMs|null, ok, steps, tokens, lastTool }`. Row key
= `${wave_id||''}::${agent}::${key_label}` (wave_id included when present).

**Time-driven bars (the proof).** All bars share one wall-clock axis anchored at `originTs`. A ~200ms
`setInterval` ticker (only while a wave is active) recomputes each *running* bar's width from real elapsed
time so bars glide and overlap on screen exactly as they overlap in reality. Bar length is driven by time,
never by step count; `subagent_progress` only updates the bar's `step/tok/tool` label. The axis span
auto-fits to `max(now - originTs)`.

**Event handling (new cases in the `app.js` `ev.type` switch ~line 1123):**
- `wave_started` → archive any finished wave to a one-line collapsed record, start a fresh wave
  (`originTs = now`), store `workers` for the header, expand the dock, start the ticker.
- `subagent_started` → if no active wave (write singleton), lazily start one; add a bar at
  `now - originTs`.
- `subagent_progress` → update that bar's label.
- `subagent_done` → freeze the bar (`endOffsetMs = now - originTs`), color ✓green/✗red, keep it.
- `wave_done` (or active running count returns to 0 with no wave_done, for singletons) → freeze the wave,
  stop the ticker, render the **summary line**.

**Summary line (money line).** On wave freeze, header shows, computed frontend-side from bar timestamps:
`⚡ wave done · {n} agents · peak {p} concurrent · {wall}s wall vs {summed}s summed → {speedup}× faster`,
where `peak` = max simultaneously-running bars, `wall` = last end − originTs, `summed` = Σ bar durations,
`speedup = summed / wall` (1 decimal). This number is the direct, readable answer to "is it concurrent?".

**CSS.** Add dock + bar styles to the inline `<style>` in `index.html` using `--term-*` vars; remove the
now-dead `.subagent-panel`/`.subagent-row` rules and the inline-panel JS.

### 4.E Dev demo trigger (G4)

`window.__demoWave(n = 3)` in `app.js` (dev-only, not surfaced in UI): synthesizes a realistic
`wave_started → n×(subagent_started, staggered subagent_progress, subagent_done at varied durations) →
wave_done` sequence through the same event handler, so the dock renders and the peak/speedup math can be
validated on a known synthetic wave. Used for visual verification and as the frontend "test".

## 5. Execution flow (happy path)

1. Model creates a plan; planner groups independent research into one phase, sets `depends_on` only where
   a step needs a prior step's output.
2. Model marks the first delegatable step of the active phase `in_progress` → `_maybe_dispatch_delegated_steps`.
3. Harness collects **all** ready delegatable read steps in the phase → one wide wave. `run_subagents_parallel`
   emits `wave_started`, fans out up to `SUBAGENT_MAX_CONCURRENCY` workers sharing the key pool, streams
   `subagent_*` telemetry, emits `wave_done`.
4. Dock renders overlapping bars live; on `wave_done` shows the `N× faster` line.
5. Harness folds each report into main context + investigation memory, marks steps completed. Ready-write
   steps run serially. If a dependency just unblocked more steps, dispatch the next ready batch.
6. When the phase's delegatable steps are all done, normal flow advances to the next phase.

## 6. Edge cases & safeguards

- **Writes stay serial** on `_WORKSPACE_LOCK` regardless of parallel-by-default — no concurrent workspace
  mutation.
- **Wave-level failure** already folds every dispatched read step as failed (existing
  `_run_delegated_read_wave` guard) so no step stalls `in_progress` forever; keep that behavior for the
  widened batch.
- **Dependency cycles / unknown ids:** foreign/self ids ignored; the per-phase dispatch loop is bounded by
  `len(plan.items)` so a pathological cycle degrades to "nothing new ready" rather than hanging.
- **`parallel_execution_enabled = False`** restores exact current behavior (dispatch only the just-started
  step).
- **Back-compat:** steps without `depends_on` default to independent; existing plans/tests that relied on
  strict sequential *delegated* execution within a phase change behavior — the planner-prompt update and
  the kill switch mitigate this; call it out in the plan's test-update step.
- **Singleton write waves** have no `wave_id`; dock infers wave boundaries from the running count.
- **Ticker teardown:** the ticker must be cleared on `wave_done`, on session switch, and on chat wipe to
  avoid leaks (mirror `_subagentRows` cleanup at app.js:224).

## 7. Testing

- **Backend (source committed; `/tests` stays gitignored):**
  - `run_subagents_parallel` emits exactly one `wave_started` (correct `size`/`workers`) and one
    `wave_done` bracketing the subagent events, even on subagent crash.
  - `_pool_size` returns `min(SUBAGENT_MAX_CONCURRENCY, n)` and honors the env override; no longer depends
    on key count.
  - `planning`: eligibility helper returns the correct ready set given `depends_on` + statuses + phase.
  - `_maybe_dispatch_delegated_steps` with a stub registry/wave: marking one step `in_progress` pulls
    forward all ready independent read steps in the phase into a single wave; a `depends_on` step is
    withheld until its dependency completes, then dispatched; writes stay serial; disabled flag restores
    single-step dispatch.
- **Frontend:** validated via `window.__demoWave` — bars overlap, peak/speedup computed correctly on a
  known synthetic wave, dock collapses to the idle pill afterward, ticker cleared.

## 8. Touchpoints (verified)

- `planning.py` — `depends_on` field, ready-set/eligibility helper, planner-prompt semantics.
- `agent.py` — `_maybe_dispatch_delegated_steps` (batch pull-forward + dependency loop), harness-initiated
  `in_progress` marking, `parallel_execution_enabled` session default (near agent.py:2125/2138).
- `subagents.py` — `_pool_size` + `SUBAGENT_MAX_CONCURRENCY`, `run_subagents_parallel` wave events.
- `llm.py` — no change (key sharing + fallback ladder already support this); confirm `active_key_pool`.
- `frontend/app.js` — dock module, new event cases, `__demoWave`, remove inline panel, ticker teardown.
- `frontend/index.html` — dock CSS in the inline `<style>`, remove dead `.subagent-*` rules.
- `api_server.py` — no change (SSE already carries arbitrary event dicts).

## 9. Success criteria

- Firing a plan whose active phase has ≥3 independent delegated read steps launches them **concurrently**
  (dock shows ≥3 overlapping bars; `peak ≥ 3`; `speedup > 1.5×`).
- The dock is visible without scrolling, expands on a wave, collapses to a pill when idle.
- With `parallel_execution_enabled = False`, behavior is identical to today.
- Full suite green except the known pre-existing baseline failures (no new failures).
