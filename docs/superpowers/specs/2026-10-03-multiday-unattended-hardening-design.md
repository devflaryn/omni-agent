# Multi-day unattended hardening — design

**Status:** awaiting owner review
**Date:** 2026-10-03
**Branch:** `feat/re-workbench-skills` (work will branch from here)
**Scope of this spec:** the omni-agent supervisor + a new pi extension (the
"durability spine"). The omnidroid (Rust) RE-tool additions are a **separate
follow-up spec** (see §9).

---

## 1. Goal

Make Omni Agent able to run **one unattended agent session continuously for
2–3 days** driven by weak, cheap, small-context models (DeepSeek V4 Flash at
128k; Qwen3.8-27B at 262k), writing very large amounts of code and reverse-
engineering large `.so` files, **without stalling, dying, or quietly
abandoning the goal**.

Success criteria:

1. A pi crash, EPIPE, wedged tool, judge failure, provider outage, rate-limit
   storm, oversized tool output, or context overflow **never ends the run**.
   The only terminal states are *goal judged done* or *human stop*.
2. After any crash of either layer, the run **resumes the same pi session and
   the same goal/progress**, not an empty session.
3. The original goal and critical facts (file paths, symbols, offsets,
   addresses) **survive indefinitely** across the ~60–90 compactions a multi-
   day run produces — they do not degrade into a lossy summary-of-summary.
4. Nothing in RAM or on disk grows unboundedly enough to OOM or fill the disk
   over 2–3 days.
5. One oversized tool result (e.g. a huge `.so` dump) cannot blow the context
   window or queue-block every later tool call.

Non-goals: literally testing for 72 hours (we fault-inject with accelerated
timers); an OS-level process supervisor (the durable runner must not
self-terminate, but keeping the *host* process alive across reboots is the
user's wrapper/Task Scheduler concern); the omnidroid Rust tools (§9).

---

## 2. Background — the current failure modes (grounded in code)

pi is `@earendil-works/pi-coding-agent` **0.85.1** at
`%APPDATA%\npm\node_modules\@earendil-works\pi-coding-agent\dist`. Settings
live in `C:\Users\berat\.pi\agent\` (`settings.json`, `models.json`,
`extensions/`, `sessions/`). omni-agent drives it over RPC
(`--mode rpc`). The explorations found these load-bearing failures:

**Process survival**
- Pi crash restarts into a **brand-new empty session**
  (`server/pi-rpc.mjs:75-82`): it passes no `--session`/`--continue`, so the
  old conversation and the keeper's goal (keyed by the old `sid`) are lost.
  Only `restartPi()` (`server/index.mjs:70-78`) does `switch_session`.
- `restarts++ < 20` never resets → dead after 20 crashes over the run; flat
  800 ms, no backoff.
- No `error` listener on `pi.proc.stdin` (`pi-rpc.mjs:117`) → EPIPE if pi dies
  mid-write kills the server. No `uncaughtException`/`unhandledRejection`
  anywhere in `server/`.
- No watchdog on a wedged-but-alive pi: `streaming` goes true on
  `agent_start`/`turn_start`, false only on `agent_settled`
  (`pi-rpc.mjs:103-104`). A tool that never returns leaves `streaming` true
  forever, and the keeper bails while streaming (`hook.mjs:230`) → silent
  permanent stall. pi's bash tool has no default timeout.
- `scripts/headless.mjs` runs **one turn** and exits on the first
  `streaming:false` (`:71-76`); no goal, no keeper, cannot resume, hangs
  forever if pi crashes.

**Goal keeper (`server/hook.mjs`)**
- The re-engage message carries only the judge's ≤600-char paraphrase, **not
  the goal text** (`/goal` is UI-only, `ui/app.js:154-175`). After the first
  compaction a weak model loses the goal.
- `/goal` while idle does nothing: `setGoal` makes `ran:false` (`hook.mjs:159`)
  and only a streaming→settled transition triggers `check()` (`:195-196`).
- Judge error/timeout/non-JSON = **permanent stop** (`:239-243`), no retry, no
  re-arm.
- Provider outage is fatal: judge defaults to the chat model, so errored runs
  make no tool calls, `idleNudges` hits 5 within minutes → "gave up" (`:231`),
  never reset on a timer.
- Abort latches `g.aborted=true` (`:175,:191`); with an explicit goal locked,
  later prompts skip `setGoal` (`:184`) so it stays aborted.
- No same-failure loop detection; no backoff between nudges (2 s grace).
- `goals` is an in-memory `Map` (`:147`) — lost on server restart.
- `summaryProvider`/`summaryModel` are read (`:222`) but dropped by
  `hookConfig()` (`config.mjs:130-143`), so unsettable.

**Compaction (pi's, the single biggest killer)**
- Summaries are written by the **same weak chat model with thinking on**
  (`createSummarizationOptions` passes the session thinking level), against
  `maxTokens = min(floor(0.8*reserveTokens), model.maxTokens)` ≈ **19,660**,
  and **grow every pass** (UPDATE prompt says "PRESERVE all existing
  information"; the `<read-files>`/`<modified-files>` list is never trimmed).
  Once a summary exceeds the cap it fails **deterministically** with
  `stopReason==="length"`, and failed auto-compaction has **no backoff and no
  circuit-breaker** — every subsequent turn re-attempts a 100k+ token call.
- Only a lossy summary survives the first compaction; degrades over the
  ~60–90 compactions of a multi-day run.
- pi's `session_before_compact` and `context` hooks are **completely unused**
  today — the main leverage point.
- Overflow recovery is **one** compact-and-retry per user message
  (`agent-session.js:1655-1696`); a second failure ends the run with "Context
  overflow recovery failed…".
- `models.json`: DeepSeek is wired at **128000** context (compacts above
  ~103k), not the assumed 262k. Qwen is 262144.

**Tool output / MCP (`integrations/pi/omni-mcp.ts`)**
- The timeout keep-alive's late-result follow-up is **broken**:
  `pi.sendMessage?.(string, {deliverAs:"followUp"})` (`:278-281`) passes a
  string where pi expects `{customType, content, display}`; pi turns
  `content` (undefined) into `[]`, so the late result is lost, and an idle
  agent is not woken anyway.
- A stuck call is never cleared; omni-mcp is single-threaded, so every later
  call queues behind it and also times out at 600 s. No cancel, no restart.
- Started only at `session_start` (`:314-321`); if down then, the session has
  no `omnidroid_*` tools even after recovery.
- Text capped at 12000 chars (`:47,64`) but **images are not limited** (base64
  up to 8 MB onto bus events, `normalize.mjs:59`).
- `omni-fallback.ts` is **not installed**; when installed it ratchets *down*
  on the first error (incl. transient 429) and dead-ends at the bottom of the
  list, never recovering up.

**Unbounded growth**
- `watcher.history()` (`watchers.mjs:234-253`) loads the **entire session
  JSONL into one Buffer and one string**, on every digest and every UI chat
  open (`index.mjs:270-274`) — a multi-day RE session with big tool outputs
  risks V8's ~512 MB string limit and OOM.
- `headless.mjs:60` appends **every event including every token delta** to the
  JSONL log → GBs over days.
- SSE writes ignore backpressure (`bus.mjs:23-25`); a slow LAN client buffers
  without limit.
- Each settle spawns **two** `pi -p` processes (judge + summary).
- Session JSONL reaches tens of MB and is held entirely in memory; re-parsed
  synchronously on resume.
- `omni-memory.ts` installed is stale and points `root`/`vault` at the **old**
  checkout (`C:\Users\berat\Desktop\omni-agent`), so `memory_save` and the
  server's vault diverge; it also lacks the `OMNI_MEMORY=server` guard and
  auto-injects a pack into the system prompt every `before_agent_start`,
  defeating the prompt cache.

---

## 3. Architecture (Hybrid C)

A **durability spine split by layer**, both halves reading/writing **one
shared run ledger on disk** (§4) as the single source of truth and resume
anchor.

```
                         vault/Runs/<run-id>/
                      run.json · ledger.md · events.jsonl · artifacts/
                                   ▲            ▲
             reads/writes control  │            │ writes ledger + artifacts
             + keeper state        │            │ reads ledger for re-injection
                                   │            │
   ┌───────────────────────────────┐   ┌────────────────────────────────┐
   │  Supervisor layer (omni-agent) │   │  Extension layer (pi: omni-run) │
   │  node, server/ + headless      │   │  ~/.pi/agent/extensions         │
   │  • resume same session         │   │  • custom compaction (ledger +  │
   │  • watchdog on wedged stream   │◄─►│    dedicated cheap model)       │
   │  • process guards (EPIPE etc.) │RPC│  • context hook: re-inject goal │
   │  • keeper hardening            │   │    + ledger every LLM call      │
   │  • growth bounds               │   │  • tool_result: cap + offload   │
   │  • durable never-exit runner   │   │  • recovering model fallback    │
   └───────────────────────────────┘   └────────────────────────────────┘
```

Each failure is fixed at the layer that can *see* it: the supervisor sees
process/settle boundaries; the extension sees inside the turn loop
(compaction, per-call context, tool results, model errors).

---

## 4. The shared run ledger (the contract)

One directory per run under the vault (survives everything; readable in
Obsidian). Path is resolved once and shared with the extension via
`~/.pi/agent/omni-agent.json` + an env var (`OMNI_RUN_DIR`) set on the pi
child's environment.

- **`run.json`** — control state owned by the supervisor:
  `{ runId, goalText (verbatim), sessionFile (RESUME ANCHOR), status:
  running|paused|done|failed, createdAt, updatedAt, counters:{restarts,
  nudges, compactions, judgeFailures}, model:{active, fallbackIndex},
  config snapshot }`. Written atomically (temp + rename).
- **`ledger.md`** — durable progress, owned by the extension, read by the
  supervisor. Fixed, bounded sections:
  `## Goal` (verbatim, immutable) · `## Constraints` · `## Milestones`
  (Done / In progress / Blocked, with timestamps) · `## Decisions` ·
  `## Next steps` · `## Critical facts` (paths, symbols, offsets, addresses —
  must survive verbatim). Each section has a byte budget; updates rewrite the
  file atomically.
- **`events.jsonl`** — bounded + rotated: checkpoints, errors, restarts, judge
  verdicts, compaction outcomes. Not the transcript (that is pi's session
  file). Rotates at a size cap, keeping the last K files.
- **`artifacts/<sha256>.ext`** — offloaded large tool outputs; re-readable by
  path with a byte-range.

Resume anchor: `run.json.sessionFile`. On restart the supervisor re-spawns pi
and issues `switch_session {sessionPath: sessionFile}`; the extension
re-injects `ledger.md`.

Ownership/concurrency: `run.json` is supervisor-only-write; `ledger.md` and
`artifacts/` are extension-only-write; `events.jsonl` is append-only from both
(each line self-contained). No field is written by both sides. This avoids
cross-process locking.

---

## 5. Supervisor layer (omni-agent) changes

### 5.1 `server/pi-rpc.mjs` — survival + resume + watchdog
- Add `this.proc.stdin.on('error', …)` (swallow EPIPE, trigger restart) —
  mirror `hook.mjs:125` / `claude-runner.mjs:94`.
- Restart resumes: after `start()` re-spawns pi, if `run.json.sessionFile`
  exists, issue `switch_session` to it before replaying the pending prompt.
- Backoff: exponential with jitter and a cap (e.g. 0.8s→cap 30s); reset the
  restart counter after a sustained-healthy window (e.g. N minutes of
  successful streaming) instead of latching at 20.
- Watchdog: record `lastEventAt` on every stream event; a timer checks "if
  `streaming` and now-`lastEventAt` > `stallMs`" (default above pi's
  `httpIdleTimeoutMs` so pi's own retry runs first) → `abort` then restart.
  A periodic liveness probe (`get_session_stats`/`get_state`); kill+restart on
  repeated timeout.

### 5.2 Process guards
- Add `process.on('uncaughtException' | 'unhandledRejection', …)` in the server
  entry: log to `events.jsonl`, keep the server up (restart the offending
  subsystem rather than exit).

### 5.3 `server/hook.mjs` — keeper that never abandons, never spins
- Persist goal + counters to `run.json`; on resume, re-attach the goal to the
  new `sid`/session file rather than losing it with the old key.
- Re-engage message includes the **full goal text** (from `run.json` /
  ledger `## Goal`), not just the judge paraphrase.
- Judge resilience: retry with backoff on error/timeout/non-JSON; after the
  retries, **fail open** — assume *not done* and re-engage (the point is never
  to abandon the goal). Cap judge-failure frequency with backoff; never treat a
  judge failure as terminal.
- Heartbeat: a periodic tick re-checks/re-engages even when idle with no
  settle (fixes "/goal while idle" and "gave up forever"). Keeper is driven by
  **both** settle events and the timer.
- Loop detection: fingerprint the tail + last error; if the same signature
  repeats K times, escalate — switch model via fallback, inject a "you are
  stuck on X; try a different approach" steer, or record a Blocked milestone
  and move on — with growing backoff between nudges. `idleNudges` "gave up" is
  replaced by escalate-then-continue; there is no permanent give-up.
- Abort semantics: a manual abort sets `status:paused` (resumable by timer or
  next prompt), not a permanent `aborted` latch.
- Config: surface `judge timeout`, `judge model`, `summaryProvider`/
  `summaryModel`, `stallMs`, `heartbeatMs`, loop-detection `K`, backoff caps
  through `config.mjs` (`hookConfig()` must stop dropping them).

### 5.4 Growth bounds
- `watcher.history()`: tail/stream the JSONL (last N MB or last M entries)
  instead of loading the whole file into one string; the UI chat-open and
  digest paths read the same bounded view. This is the OOM fix.
- Headless/`omni.log`: stop logging token `delta` events; log structured
  checkpoints; rotate at a size cap.
- SSE: coalesce/drop for slow clients (bounded per-client buffer).
- Process churn: gate the summary spawn behind `hook.summaries`, and reuse a
  single judge/summary invocation where possible.

### 5.5 Durable headless runner (`scripts/headless.mjs` rewrite) — a standalone CLI
- A **standalone CLI**, the thing the 2–3 day run is launched with. It creates
  or `--resume <run-id>`s a run ledger; starts pi; sets the goal; enables the
  keeper; then **blocks until `status` is `done` or stopped** — never exits on
  first settle. On pi crash, resume via §5.1. `--max-seconds` optional cap.
- **Decoupled from the GUI.** The runner owns the run; the desktop (pywebview)
  and browser UIs are **read-only observers** that attach to an already-running
  run (reading the bus/ledger over the existing HTTP/SSE surface) and **never
  launch or own** the runner. The runner does not require a window; closing or
  reopening the GUI has no effect on the run. (Concretely: the runner stands up
  the same server/bus the UI already consumes, or connects to it, so the
  existing `/api/sessions`/SSE views work unchanged against the live run.)

---

## 6. Extension layer (pi) — new `integrations/pi/omni-run.ts`

Installed into `~/.pi/agent/extensions/` and wired in `scripts/install.mjs`.
Reads `OMNI_RUN_DIR`. Extension errors are caught by pi (reported as
`extension_error`, non-fatal) — so every hook is defensive and degrades to
"do nothing" rather than throwing.

### 6.1 Custom compaction (`session_before_compact`)
- Summarize with **the session model by default, but with thinking OFF and a
  fixed output budget** — and make the model **configurable** (a cheaper
  `models.json` entry can be set as `summaryModel`). The death spiral is broken
  by three things that hold regardless of model choice: thinking off (no
  reasoning tokens eating the cap), a **fixed non-growing budget**, and the
  circuit-breaker below — not by the model being cheaper. A cheaper model is an
  optional cost/speed win, not the mechanism.
- The returned summary is a **fixed-budget rendering of `ledger.md`** — it does
  not grow pass-over-pass. The extension updates `ledger.md` from the span being
  summarized, then returns `{compaction:{summary, firstKeptEntryId,
  tokensBefore}}`.
- Circuit-breaker: on `length` failure, shrink scope (drop oldest ledger
  detail, hard-cap output) and retry once; on repeated failure, emit a blocked
  checkpoint and let pi fall back — never retry-every-turn.

### 6.2 Context re-injection (`context` hook)
- Prepend verbatim `## Goal` + a bounded rendering of `ledger.md`'s Critical
  facts / Next steps to the messages of every LLM call (not persisted to the
  session, per pi's `context` semantics). This keeps goal + paths/symbols/
  addresses alive regardless of how lossy compaction becomes.

### 6.3 Tool-result discipline (`tool_result` hook)
- Cap total result size (text **and** images); if over budget, write the full
  content to `artifacts/<sha256>` and replace the inline result with a short
  reference + instructions to re-read a byte-range. Prevents a single huge
  `.so` dump from blowing the window.

### 6.4 Recovering model fallback (fix + install `omni-fallback.ts`)
- On an errored turn, step down the chain with its own retry count + backoff;
  after a cooldown of healthy turns, **step back up toward the primary**. Not a
  one-way ratchet. Installed via `scripts/install.mjs`.

### 6.5 Progress capture
- On milestone signals (write/edit patterns, explicit markers), append to
  `ledger.md` so progress is durable even mid-turn, independent of compaction.

---

## 7. External state changes (approved)

- **`~/.pi/agent/models.json`:** correct DeepSeek's `contextWindow`; add the
  dedicated summarizer model entry. (No secrets committed; these are the
  user's local files, changed by `scripts/install.mjs` or documented as manual
  steps.)
- **`~/.pi/agent/settings.json`:** set `httpIdleTimeoutMs` (coordinated with
  `stallMs`); keep `retry.*`.
- **Extension install (`scripts/install.mjs`):** install `omni-run.ts` and
  `omni-fallback.ts`; fix the stale `omni-memory.ts` (point `root`/`vault` at
  the current checkout; add the `OMNI_MEMORY=server` guard so it stops
  auto-injecting and defeating the prompt cache). Set `OMNI_RUN_DIR`.

---

## 8. Error-handling principle

**Fail open toward the goal.** Transient failures (crash, EPIPE, wedge, judge
error, provider outage, 429 storm, oversized output, overflow) never end the
run; each degrades to retry → backoff → fallback → escalate. The only terminal
states are *goal judged done* and *human stop*. All durable state is on disk,
so any crash of either layer resumes.

---

## 9. Follow-up spec (out of scope here) — omnidroid RE tools

A separate design will add, in the omnidroid Rust repo, the RE capabilities a
weak agent needs to match large encrypted `.so` behavior:
- **dump-only-decrypted/changed pages** (built on existing
  `scan_for_copy_on_write` / CoW-privatisation tracking + `list_maps`
  committed counts) so huge packed libs are not dumped wholesale;
- **cancel/reset a stuck lab call** + MCP `notifications/cancelled` so one
  wedged call doesn't queue-block the server;
- extend `lab_diff` to compare memory-writes/syscalls (spec'd but
  unimplemented; today it diffs only `ret` + out-buffers) for stronger
  behavior-matching of the rewrite.

---

## 10. Testing

Node `--test`, fault-injection with accelerated timers:
- Resume-after-crash: kill the pi child mid-stream → supervisor re-spawns and
  `switch_session`s back to `sessionFile`; goal preserved from `run.json`.
- Watchdog: simulate `streaming` with no events past `stallMs` → abort+restart.
- Process guard: emit EPIPE on pi stdin → server stays up.
- Keeper: judge returns garbage/times out → fail-open re-engage, no permanent
  stop; same-failure fingerprint K times → escalate; heartbeat re-arms from
  idle; abort → paused, resumable.
- Ledger: round-trip run.json/ledger.md atomic writes; concurrent append to
  events.jsonl; ownership invariants.
- Extension (unit-testable in isolation): custom-compaction returns a bounded
  summary and never grows; `length` failure → shrink+retry once, not every
  turn; context hook injects goal; tool_result offloads oversized output to
  artifacts; fallback steps down then recovers up.
- Growth: `watcher.history()` never loads the whole file; headless log drops
  deltas and rotates.
- Integration smoke: a stub pi RPC that scripts crashes/stalls/errors and
  asserts the run keeps going.

---

## 11. Decisions (resolved with owner, 2026-10-03)

1. **Run-ledger location:** `vault/Runs/<run-id>/` — the durable,
   Obsidian-readable store both harnesses already share; not git-tracked, so
   operational state does not pollute the repo.
2. **Summarizer model:** the session model by default (thinking off, fixed
   budget), with a configurable `summaryModel` override for a cheaper model.
   See §6.1.
3. **Watchdog defaults:** `stallMs` 6 min / `heartbeatMs` 60 s /
   loop-detection `K` 3 — accepted.
4. **Runner vs GUI:** the durable runner is a standalone CLI; the desktop and
   browser GUIs are decoupled read-only observers. See §5.5.
