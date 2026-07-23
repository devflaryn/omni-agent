# Genuine Parallelism + Visibility for Subagents — Design

**Date:** 2026-07-23
**Status:** Approved design, ready for implementation planning
**Scope:** Make subagent delegation *genuinely* parallel and *observable*. Context-hygiene routing (e.g. logcat → summarizer subagent) is explicitly a **separate follow-up spec**, not this one.

## Problem

The agent already has a solid isolated-context subagent engine (`subagents.py`) and two delegation paths, but parallelism underdelivers in practice:

1. **The primary path is sequential by construction.** `agent.py:_maybe_dispatch_delegated_steps` (~line 1322) loops over `in_progress` delegated plan steps and calls `subagents.run_subagent(...)` **synchronously, one step at a time**, inside the main loop (`agent.py:1387`). The way the agent *naturally* delegates never runs two subagents at once.
2. **The one parallel path is invisible and blocking.** `dispatch_agents` → `run_subagents_parallel` (`ThreadPoolExecutor`) does fan out, but it blocks until the whole wave finishes and then returns combined text. It emits only `delegate_running` / `delegate_done` — no live per-agent token/elapsed stream. From the UI it looks like one long hang, not "N agents working."
3. **Concurrency isn't truly independent.** LLM key selection is *sticky* (`_ACTIVE_KEY`) and the active-provider state is **module globals mutated without a lock** (`llm.py:1538-1540`, `2009`). Parallel workers all prefer the *same* key and clobber shared state — so even `dispatch_agents` doesn't get real N-wide throughput, because NVIDIA NIM **queues** requests to one key under load (`llm.py:27`).
4. **The frontend has no subagent view at all.** `app.js:onEvent` (line 1055) has no `case` for `delegate_running`/`delegate_done`; those events are dropped. There is nothing like Claude Code's live "each subagent: task, tokens, elapsed."

### Backend/provider facts (verified)

- One provider: **NVIDIA NIM**, OpenAI protocol, **pool of 5 API keys** (`llm_config.json`). NIM queues under load rather than rejecting, so N parallel requests on **one** key serialize server-side.
- `plan.current()` returns the *first* `in_progress` step (`planning.py:182`), but `VALID_STATUSES` allows multiple `in_progress` and nothing forbids it — a batched wave is legal.
- Both response envelopes carry a stable `usage` object (OpenAI/NIM: `prompt_tokens`/`completion_tokens`/`total_tokens`, parsed at `llm.py:1272`; Anthropic: `input_tokens`/`output_tokens`, parsed at `llm.py:1483`). Real token accounting is available cross-provider.
- `_keys_for` (`llm.py:1687`) already orders keys starting at the sticky `_ACTIVE_KEY` — a clean hook for per-worker key pinning.

## Goals

1. **Genuinely parallel** (primary goal): multiple subagents truly run at the same time, so wall-clock time drops.
2. **Visible** (for debugging/tracking): a live view of each running subagent — task, assigned key, elapsed, tokens, step N/max.

Non-goals: a dependency-graph scheduler; per-request key switching; context-hygiene routing (separate spec).

## Architecture: one wave engine, two entry paths

`run_subagents_parallel` (in `subagents.py`) is **the single place concurrency happens**. Both delegation paths funnel into it:

- **Path A — batched plan steps (automatic):** `_maybe_dispatch_delegated_steps` gathers all `in_progress` delegated steps, splits **read** vs **write**, runs the **read** set as **one wave**, then runs **write** steps sequentially behind the workspace lock (unchanged). The model triggers a wave simply by marking several independent delegated steps `in_progress` together.
- **Path B — `dispatch_agents` (model-driven):** already fans out; gains the same key distribution + live telemetry.

Three enabling changes underneath: **(1)** balanced per-worker key distribution + thread-safe LLM state; **(2)** wave batching in the harness; **(3)** a live telemetry event stream to the UI.

---

## Component 1 — Genuine concurrency (`llm.py`)

### 1a. Balanced key allocation (`KeyAllocator`)

A thread-safe, module-level allocator holds a **per-key active-subagent counter**.

- `acquire()` → returns the **least-loaded** key (fewest active subagents right now; ties broken round-robin), increments its counter, and returns it.
- `release(key)` → decrements.
- Assignment is **per-subagent**, held for the subagent's whole run (a subagent makes many `ask_llm` calls). This is deliberate: per-*request* key switching would forfeit the provider's **prompt-cache** discount (cache is key/account-scoped), re-paying full input-token price and latency every turn. Same bytes on the wire either way; stable-key is never worse and is much cheaper where caching exists.

**Balancing property:** with N subagents and K keys, the *currently running* set is spread as evenly as possible at every instant, and over a whole run each key serves ~N/K subagents — self-correcting across overlapping waves as subagents finish and free their key for the next waiting one. (15 subagents / 5 keys → ~3 each, never 11-and-1.)

Wiring: `run_subagent` (or the wave) calls `acquire()` on entry, stores the key in a **thread-local `_PINNED_KEY`**, and `release()`s on exit (in a `finally`).

### 1b. Per-worker key pinning

- New thread-local `_PINNED_KEY`. `_keys_for` honors it — orders the key rotation to **start at the pinned key** instead of the global sticky `_ACTIVE_KEY` when one is set for the current thread.
- If a pinned key is rate-limited mid-run, the existing two-axis fallback still rotates *for that request* without disturbing the allocator's accounting (the subagent stays "assigned" to its key; only that call borrows another).

### 1c. Subagent-scoped state (thread-safety)

- New thread-local `_IS_SUBAGENT` flag (set for subagent worker threads).
- When set: threads **do not** write back the global `_ACTIVE_KEY` / `_ACTIVE_MODEL` / `_ACTIVE_CONFIG_ID` (`llm.py:2009`, `1986`) and **do not** fire the active-provider badge notifier (`_notify_active`). That badge belongs to the main thread. Per-thread fallback/rotation still works.
- This removes the global-clobber race that made "parallel" workers fight over shared state.

### 1d. Usage capture

- At both response-parse points (`llm.py:1272` OpenAI, `1483` Anthropic), normalize the response `usage` into `{prompt, completion, total}` and stash it in a **thread-local `_LAST_USAGE`**.
- `ask_llm`'s **string return is unchanged** (no compatibility break). The subagent loop reads `_LAST_USAGE` after each `ask_llm` call and accumulates it.
- **Fallback:** when a provider omits `usage`, estimate from characters (~len/4). Real usage is preferred; the estimate is only a backstop.
- **Escape hatch (per user):** real usage must never break compatibility and must be *consistent*. If, during implementation, `usage` on the configured provider (NIM) turns out flaky/inconsistent — present on some turns, absent on others, or unreliable — **drop real capture entirely and use char-estimate uniformly**. A stable estimate beats a flickering mix. Telemetry only needs to be good enough for tracking/debugging, not billing-accurate.

### 1e. Derived pool size

- Wave concurrency is **not hardcoded**. Computed live: `pool_size = max(1, num_keys - 1)`. This bounds concurrent subagents to `keys-1`, so **at least one key always has zero active subagents** — headroom for the main orchestrator so a big wave can't fully saturate every key. (It's headroom, not a hard pin of a *specific* key to main; the allocator counts subagents only. Hard-pinning main's key is a possible later refinement, not required here.) 5 keys → 4-wide waves. Add keys → wider automatically; 1 key → degrades to sequential.
- Replaces the current `POOL_SIZE = 4` constant in `subagents.py` with a function of the live key count.

---

## Component 2 — Path A: batched plan-step wave (`agent.py`)

`_maybe_dispatch_delegated_steps` changes from "run each in-progress delegated step synchronously" to:

1. Collect **all** `in_progress` delegated steps not yet dispatched.
2. Partition into **read-mode** and **write-mode** (by the resolved `AgentDef.mode`).
3. Run the **read** set as **one `run_subagents_parallel` wave**.
4. Run **write** steps **sequentially** afterward (they mutate shared `/workspace`; the workspace lock in `subagents.py` already enforces one writer).
5. Fold each result back exactly as today (`_dispatch_delegated_step`'s post-processing: distilled report into context, findings recorded, step status + verification discipline for writes). `dispatched_steps` still tracks handled ids so nothing runs twice.

Planning guidance gets a short note: independent research steps can be started **together** (multiple `in_progress`) to run as a parallel wave; dependent or write steps should be started one at a time.

---

## Component 3 — Live telemetry

- `run_subagent` takes an optional `on_event(event: dict)` callback. It fires:
  - `subagent_started` — `{agent, task_snippet, key_label, model}`
  - `subagent_progress` — heartbeat `{agent, elapsed_s, tokens, step, max_steps, last_tool}` (emitted per loop turn / tool result)
  - `subagent_done` — `{agent, ok, tokens, steps, elapsed_s}`
- `run_subagents_parallel` gives each worker a callback that pushes onto a **thread-safe queue**; the main loop **drains the queue** into the existing `_emit` between/around waves, so the UI sees all agents advancing live (not just at the end).
- Token counts come from the accumulated `_LAST_USAGE` (Component 1d).
- Existing `delegate_running` / `delegate_done` events are kept (or subsumed) so nothing regresses.

---

## Component 4 — Frontend live subagent panel

- Add `case 'subagent_started' / 'subagent_progress' / 'subagent_done'` to `app.js:onEvent` (line 1055), following the existing `tool_running`/`tool_result` renderer pattern.
- Render a compact **live panel**: one row per running subagent showing name, task snippet, key label, elapsed, tokens, step N/max; row resolves to a done state (ok/failed, totals) on `subagent_done`.
- This is net-new UI — there is currently no subagent case in the switch at all.

---

## Testing

Extend `tests/test_subagents.py` (and add `llm`-level tests where needed):

- **KeyAllocator balance:** N=15 over K=5 assigns ~3 per key; never 11-and-1. Releasing frees a key for the next acquire. Concurrent acquires from multiple threads stay balanced (no lost updates).
- **Pool size derivation:** `keys-1`, floored at 1; widens/narrows with key count.
- **Thread-safety:** subagent threads (`_IS_SUBAGENT`) do not mutate global `_ACTIVE_*` and do not fire the badge notifier; main-thread behavior unchanged.
- **Key pinning:** `_keys_for` starts rotation at `_PINNED_KEY` when set; falls back to sticky/global when not.
- **Path A batching:** multiple independent read delegated steps run as one wave; write steps run serially; `dispatched_steps` prevents double-dispatch; fold-back (findings, status, verification) matches the current single-step behavior.
- **Usage normalization:** OpenAI and Anthropic `usage` envelopes both normalize to `{prompt, completion, total}`; char-estimate fallback when absent.
- **Telemetry:** each subagent emits `started → progress(≥1) → done`; the wave drains all agents' events; token totals are populated.

## Risks / mitigations

- **Rate limits under wide waves.** With `keys-1` pool and balanced allocation, load is even; if NIM still throttles, the two-axis fallback absorbs it per-request and the user can add keys (pool widens automatically). Accepted per user.
- **Prompt caching unverified on NIM.** Stable-key-per-subagent is never worse than switching, so the decision holds regardless of whether NIM implements prefix caching.
- **Ordering of parallel results.** `run_subagents_parallel` already returns results in input order; fold-back keys off `step id`, not completion order, so batched Path A stays deterministic.
```
