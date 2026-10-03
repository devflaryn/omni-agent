# Multi-day Unattended Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Omni Agent survive one unattended 2–3 day pi run on weak, small-context models without ever stalling, dying, or abandoning the goal.

**Architecture:** A durability spine split across the omni-agent supervisor (Node, `server/` + a new CLI runner) and a new pi extension (`integrations/pi/omni-run.ts`), both reading/writing one on-disk **run ledger** (`vault/Runs/<run-id>/`) that is the single source of truth and the resume anchor. The supervisor handles process survival, resume, watchdog, keeper hardening and growth bounds; the extension handles compaction, per-call goal re-injection, tool-result offload and recovering model fallback.

**Tech Stack:** Node ≥22 (built-ins only, no npm deps), `node --test`; pi `@earendil-works/pi-coding-agent` 0.85.1 extension API (TypeScript); JSONL session files.

**Spec:** `docs/superpowers/specs/2026-10-03-multiday-unattended-hardening-design.md` (read it alongside this plan)

## Global Constraints

- **Node built-ins only.** No new npm dependencies anywhere in `server/`, `scripts/`, or tests. (`package.json` declares no deps; keep it that way.)
- **Tests run with `node --test`** (`npm test`). Test files live in `test/*.test.mjs` and import from `../server/…`.
- **ESM only** (`"type": "module"`); use `import`, `.mjs` extensions, `node:` prefix for built-ins.
- **The pi extension is TypeScript** matching the existing `integrations/pi/*.ts` style (tabs for indent, `import type { ExtensionAPI }`). Its testable logic is exported as pure functions tested from `.mjs` test files that import the compiled-free pure helpers (keep pure helpers free of pi-runtime imports so they load under `node --test`; see Task 12).
- **Fail open toward the goal.** No code path added here may turn a transient failure (crash, EPIPE, wedge, judge error, provider outage, 429, oversized output, overflow) into a permanent stop. The only terminal states are *goal judged done* and *human stop*.
- **Run ledger path:** `<vaultDir>/Runs/<run-id>/` with files `run.json`, `ledger.md`, `events.jsonl`, `artifacts/`. `vaultDir` comes from `CONFIG.vaultDir`.
- **Atomic writes** for `run.json` and `ledger.md`: write to `<file>.tmp` then `rename`.
- **Attribution** on every commit:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`

## Review Focus

These are inputs/conditions the spec implies but that a naive implementation will get wrong; each is pinned to a test in the owning task.

- **Corrupt/partial `run.json` on resume** (process killed mid-write) — the runner must treat an unparseable ledger as "start fresh / keep going", never crash. Pinned in Task 1.
- **Restart storm** (pi crashes immediately on every start, e.g. bad model config) — backoff must grow and the run must keep attempting without busy-looping or exiting; counter must not latch permanently. Pinned in Task 3.
- **Judge returns non-JSON forever** (weak model) — keeper must fail open (re-engage), not stop, and must not spin faster than the backoff. Pinned in Task 8.
- **A single tool result larger than the context window** (huge `.so` dump) — must be offloaded to `artifacts/` and replaced with a short reference, never passed through inline. Pinned in Task 13.
- **Session file of tens of MB** — `history()` must read only a bounded tail, never load the whole file into one string. Pinned in Task 5.

---

## File structure

**New files**
- `server/run-ledger.mjs` — run-ledger read/write (supervisor side). One responsibility: durable run state on disk.
- `server/watchdog.mjs` — pure stall/backoff decision helpers (so they're testable without timers).
- `scripts/run.mjs` — the durable CLI runner (never-exit loop, `--resume`).
- `integrations/pi/omni-run.ts` — the pi "context brain" extension.
- `integrations/pi/omni-run-lib.mjs` — pure helpers for omni-run (ledger render, budget trim, offload decision), importable by both the `.ts` and `node --test`.
- Tests: `test/run-ledger.test.mjs`, `test/watchdog.test.mjs`, `test/run-cli.test.mjs`, `test/omni-run-lib.test.mjs`, plus additions to existing `test/hook.test.mjs`, `test/pi-rpc.test.mjs`, `test/tailer.test.mjs` / `test/server.test.mjs`.

**Modified files**
- `server/pi-rpc.mjs` — stdin error guard, resume-on-restart, backoff, watchdog hooks.
- `server/hook.mjs` — keeper: persist, full goal text, fail-open judge, heartbeat, loop detection, pause-not-latch.
- `server/config.mjs` — new knobs in `hookConfig()` + top-level config.
- `server/index.mjs` — wire run ledger, keeper persistence, process guards; pass ledger to startPi/restartPi.
- `server/watchers.mjs` + `server/tailer.mjs` — bounded tail read for `history()`.
- `server/bus.mjs` — per-client backpressure bound.
- `scripts/headless.mjs` — keep for one-shot; the durable runner is the new `scripts/run.mjs`.
- `scripts/install.mjs` — add `omni-run.ts` to `EXTENSIONS`.
- `integrations/pi/omni-fallback.ts` — recover back up to primary.
- `integrations/pi/omni-mcp.ts` — fix late-result message shape + wake idle agent.

---

## Task 1: Run ledger module

**Files:**
- Create: `server/run-ledger.mjs`
- Test: `test/run-ledger.test.mjs`

**Interfaces:**
- Produces:
  - `class RunLedger { constructor({ dir }) }` where `dir` is the run directory.
  - `RunLedger.create({ runsRoot, goalText, sessionFile }) → RunLedger` (static; makes `<runsRoot>/<run-id>/`, writes initial `run.json` + `ledger.md`).
  - `RunLedger.open(dir) → RunLedger` (static; loads existing).
  - `ledger.readControl() → object` (parsed `run.json`, or `{}` if missing/corrupt).
  - `ledger.writeControl(patch) → object` (merge + atomic write; returns merged).
  - `ledger.appendEvent(obj) → void` (append one JSON line to `events.jsonl`, rotate at 5 MB keeping `.1`).
  - `ledger.goalText() → string`, `ledger.readLedgerMd() → string`, `ledger.writeLedgerMd(text) → void` (atomic).
  - `ledger.dir`, `ledger.runId`, `ledger.controlFile`, `ledger.ledgerFile`, `ledger.eventsFile`, `ledger.artifactsDir`.

- [ ] **Step 1: Write failing tests**

```js
// test/run-ledger.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunLedger } from "../server/run-ledger.mjs";

function tmp() { return mkdtempSync(join(tmpdir(), "omni-run-")); }

test("create writes run.json and ledger.md with the verbatim goal", () => {
  const root = tmp();
  const l = RunLedger.create({ runsRoot: root, goalText: "Reverse the lib", sessionFile: "/x/s.jsonl" });
  assert.ok(existsSync(l.controlFile));
  const ctrl = l.readControl();
  assert.equal(ctrl.goalText, "Reverse the lib");
  assert.equal(ctrl.sessionFile, "/x/s.jsonl");
  assert.equal(ctrl.status, "running");
  assert.ok(l.readLedgerMd().includes("Reverse the lib"));
});

test("writeControl merges and persists; open re-reads", () => {
  const root = tmp();
  const l = RunLedger.create({ runsRoot: root, goalText: "g", sessionFile: "a" });
  l.writeControl({ sessionFile: "b", counters: { restarts: 2 } });
  const again = RunLedger.open(l.dir);
  assert.equal(again.readControl().sessionFile, "b");
  assert.equal(again.readControl().counters.restarts, 2);
  assert.equal(again.readControl().goalText, "g"); // merge kept it
});

test("corrupt run.json reads as empty object, never throws", () => {
  const root = tmp();
  const l = RunLedger.create({ runsRoot: root, goalText: "g", sessionFile: "a" });
  writeFileSync(l.controlFile, "{ this is not json");
  assert.deepEqual(l.readControl(), {});
  // and writeControl recovers by overwriting
  l.writeControl({ status: "running" });
  assert.equal(l.readControl().status, "running");
});

test("appendEvent appends JSONL and rotates past 5MB", () => {
  const root = tmp();
  const l = RunLedger.create({ runsRoot: root, goalText: "g", sessionFile: "a" });
  l.appendEvent({ kind: "checkpoint", n: 1 });
  const lines = readFileSync(l.eventsFile, "utf8").trim().split("\n");
  assert.equal(JSON.parse(lines.at(-1)).n, 1);
  writeFileSync(l.eventsFile, "x".repeat(5 * 1024 * 1024 + 10));
  l.appendEvent({ kind: "checkpoint", n: 2 });
  assert.ok(existsSync(l.eventsFile + ".1"));
  assert.ok(statSync(l.eventsFile).size < 5 * 1024 * 1024);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/run-ledger.test.mjs`
Expected: FAIL — `Cannot find module '../server/run-ledger.mjs'`.

- [ ] **Step 3: Implement `server/run-ledger.mjs`**

```js
/**
 * The run ledger: one directory per unattended run, under the vault, holding the
 * durable control state (run.json), the human-readable progress ledger (ledger.md),
 * a bounded event log (events.jsonl) and offloaded artifacts. Both the supervisor and
 * the pi omni-run extension read/write it; it is the single source of truth and the
 * resume anchor. Supervisor owns run.json; the extension owns ledger.md + artifacts/.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const atomicWrite = (file, text) => { const tmp = `${file}.tmp`; writeFileSync(tmp, text); renameSync(tmp, file); };
const readJson = (file) => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return {}; } };

function newRunId() {
  const d = new Date();
  const stamp = d.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `${stamp}_${Math.random().toString(36).slice(2, 8)}`;
}

const INITIAL_LEDGER = (goal) => `# Run ledger

## Goal
${goal}

## Constraints

## Milestones
### Done
### In progress
### Blocked

## Decisions

## Next steps

## Critical facts
`;

export class RunLedger {
  constructor({ dir }) {
    this.dir = dir;
    this.runId = dir.split(/[\\/]/).pop();
    this.controlFile = join(dir, "run.json");
    this.ledgerFile = join(dir, "ledger.md");
    this.eventsFile = join(dir, "events.jsonl");
    this.artifactsDir = join(dir, "artifacts");
  }

  static create({ runsRoot, goalText = "", sessionFile = "" }) {
    const dir = join(runsRoot, newRunId());
    mkdirSync(join(dir, "artifacts"), { recursive: true });
    const l = new RunLedger({ dir });
    const now = Date.now();
    atomicWrite(l.controlFile, JSON.stringify({
      runId: l.runId, goalText, sessionFile, status: "running",
      createdAt: now, updatedAt: now,
      counters: { restarts: 0, nudges: 0, compactions: 0, judgeFailures: 0 },
      model: { active: "", fallbackIndex: 0 },
    }, null, 2));
    atomicWrite(l.ledgerFile, INITIAL_LEDGER(goalText || "(no goal set)"));
    return l;
  }

  static open(dir) {
    if (!existsSync(join(dir, "run.json"))) throw new Error(`no run ledger at ${dir}`);
    return new RunLedger({ dir });
  }

  readControl() { return readJson(this.controlFile); }

  writeControl(patch = {}) {
    const prev = this.readControl();
    const next = { ...prev, ...patch, updatedAt: Date.now() };
    if (patch.counters) next.counters = { ...(prev.counters || {}), ...patch.counters };
    if (patch.model) next.model = { ...(prev.model || {}), ...patch.model };
    atomicWrite(this.controlFile, JSON.stringify(next, null, 2));
    return next;
  }

  goalText() { return this.readControl().goalText || ""; }
  readLedgerMd() { try { return readFileSync(this.ledgerFile, "utf8"); } catch { return ""; } }
  writeLedgerMd(text) { atomicWrite(this.ledgerFile, String(text)); }

  appendEvent(obj) {
    try {
      if (existsSync(this.eventsFile) && statSync(this.eventsFile).size > 5 * 1024 * 1024) {
        renameSync(this.eventsFile, `${this.eventsFile}.1`);
      }
    } catch { /* ignore rotate race */ }
    try { writeFileSync(this.eventsFile, `${JSON.stringify({ ts: Date.now(), ...obj })}\n`, { flag: "a" }); } catch { /* never fatal */ }
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/run-ledger.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add server/run-ledger.mjs test/run-ledger.test.mjs
git commit -m "feat(run-ledger): durable per-run state (run.json/ledger.md/events) with atomic writes

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: pi-rpc stdin error guard (EPIPE)

**Files:**
- Modify: `server/pi-rpc.mjs` (the `start()` body, after spawn ~line 70; `send()` ~line 113)
- Test: `test/pi-rpc.test.mjs` (add a case)

**Interfaces:**
- Consumes: existing `PiRpc` with `cfg.createPi`/spawn injection used by tests.
- Produces: no new exports; `PiRpc` no longer lets a stdin `error` event reach the process.

- [ ] **Step 1: Write the failing test**

Add to `test/pi-rpc.test.mjs` (follow the existing fake-child pattern in that file; if it spawns a real `node -e`, reuse that harness). Minimal behavioral test:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { PiRpc } from "../server/pi-rpc.mjs";

test("a stdin 'error' event does not throw out of PiRpc", async () => {
  const bus = { emit() {}, on() {}, off() {} };
  const pi = new PiRpc({ cli: null, bin: "node", cwd: process.cwd(), bus });
  // fake proc with a stdin that emits 'error'
  const { EventEmitter } = await import("node:events");
  const stdin = new EventEmitter(); stdin.writable = true; stdin.write = () => true;
  const stdout = new EventEmitter(); stdout.setEncoding = () => {};
  const stderr = new EventEmitter(); stderr.setEncoding = () => {};
  pi.proc = Object.assign(new EventEmitter(), { stdin, stdout, stderr, kill() {} });
  pi.attachPipeGuards(); // new method under test
  assert.doesNotThrow(() => stdin.emit("error", Object.assign(new Error("EPIPE"), { code: "EPIPE" })));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/pi-rpc.test.mjs`
Expected: FAIL — `pi.attachPipeGuards is not a function`.

- [ ] **Step 3: Implement**

In `server/pi-rpc.mjs`, add a method and call it from `start()` right after the `spawn(...)` assignment (after line 68):

```js
  attachPipeGuards() {
    // A dead pi mid-write would otherwise emit an unhandled 'error' on stdin and kill the server.
    this.proc?.stdin?.on("error", (e) => this.bus.emit({ ...this.ctx, kind: "log", ts: Date.now(), level: "system", text: `pi stdin error: ${e.code || e.message}` }));
  }
```

Call it in `start()` immediately after the `this.proc = useNode ? … : …;` assignment:

```js
    this.attachPipeGuards();
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/pi-rpc.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/pi-rpc.mjs test/pi-rpc.test.mjs
git commit -m "fix(pi-rpc): guard stdin 'error' (EPIPE) so a dying pi can't crash the server

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Restart backoff + counter reset (pure helper)

**Files:**
- Create: `server/watchdog.mjs`
- Test: `test/watchdog.test.mjs`

**Interfaces:**
- Produces:
  - `restartDelay(restarts, { base = 800, cap = 30000 }) → ms` — exponential with ±20% jitter, capped.
  - `shouldKeepRestarting() → true` — always true (we never latch; the busy-loop is prevented by the delay, not a cap).
  - `nextRestartState(state, { now, healthyAfterMs = 120000 }) → { restarts }` — resets `restarts` to 0 when the last successful stream was more than `healthyAfterMs` ago.

- [ ] **Step 1: Write failing tests**

```js
// test/watchdog.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { restartDelay, nextRestartState, stalled } from "../server/watchdog.mjs";

test("restartDelay grows exponentially and caps", () => {
  assert.ok(restartDelay(0) >= 640 && restartDelay(0) <= 960);   // ~800 ±20%
  assert.ok(restartDelay(10) <= 30000);                          // capped
  assert.ok(restartDelay(5) > restartDelay(1));
});

test("restart counter resets after a sustained-healthy window", () => {
  const s = { restarts: 7, lastHealthyAt: 1000 };
  assert.equal(nextRestartState(s, { now: 1000 + 130000 }).restarts, 0);
  assert.equal(nextRestartState(s, { now: 1000 + 1000 }).restarts, 7);
});

test("stalled: streaming with no event past stallMs", () => {
  assert.equal(stalled({ streaming: true, lastEventAt: 0, now: 400000, stallMs: 360000 }), true);
  assert.equal(stalled({ streaming: true, lastEventAt: 390000, now: 400000, stallMs: 360000 }), false);
  assert.equal(stalled({ streaming: false, lastEventAt: 0, now: 400000, stallMs: 360000 }), false);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/watchdog.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `server/watchdog.mjs`**

```js
/**
 * Pure decision helpers for keeping the pi child alive over days. No timers, no I/O,
 * so the policy is unit-tested directly; pi-rpc wires these to real setTimeout/clocks.
 */
export function restartDelay(restarts, { base = 800, cap = 30000 } = {}) {
  const raw = Math.min(cap, base * 2 ** Math.max(0, restarts));
  const jitter = raw * (0.8 + Math.random() * 0.4);
  return Math.round(Math.min(cap, jitter));
}

/** We never stop restarting (fail open); the growing delay prevents a busy loop. */
export function shouldKeepRestarting() { return true; }

/** Reset the restart counter once the child has streamed healthily for a while. */
export function nextRestartState(state = {}, { now = Date.now(), healthyAfterMs = 120000 } = {}) {
  const lastHealthyAt = state.lastHealthyAt || 0;
  if (lastHealthyAt && now - lastHealthyAt >= healthyAfterMs) return { ...state, restarts: 0 };
  return state;
}

/** True when pi claims to be streaming but has produced no event within stallMs. */
export function stalled({ streaming, lastEventAt, now = Date.now(), stallMs = 360000 }) {
  return !!streaming && now - (lastEventAt || 0) > stallMs;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/watchdog.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add server/watchdog.mjs test/watchdog.test.mjs
git commit -m "feat(watchdog): pure restart-backoff, counter-reset and stall-detection helpers

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: pi-rpc resume-on-restart + backoff + watchdog + lastEventAt

**Files:**
- Modify: `server/pi-rpc.mjs` (constructor fields; `start()` exit handler ~line 75-82; `onLine()` ~line 95; add `resumeFile`, `startWatchdog`)
- Test: `test/pi-rpc.test.mjs`

**Interfaces:**
- Consumes: `restartDelay`, `nextRestartState`, `stalled` from `server/watchdog.mjs`.
- Produces on `PiRpc`:
  - `this.resumeFile` (string|null) — the session file to `switch_session` back to after a restart.
  - `this.lastEventAt` (number) — ms of the last stream event.
  - `this.onRestart` (callback|null) — called `await`-ed after a restart so the supervisor can resume + replay.
  - `startWatchdog({ stallMs, intervalMs })`, `stopWatchdog()`.

- [ ] **Step 1: Write failing tests**

```js
test("restart resumes the saved session file via the onRestart hook", async () => {
  const bus = { emit() {}, on() {}, off() {} };
  const pi = new PiRpc({ cli: null, bin: "node", cwd: process.cwd(), bus });
  pi.resumeFile = "/sessions/keep.jsonl";
  let resumedTo = null;
  pi.switchSession = async (f) => { resumedTo = f; };
  pi.waitReady = async () => {};
  pi.start = () => { pi.onRestart && pi.onRestart(); return pi; }; // stub spawn
  await pi.handleExit(0); // new method invoked by the real 'exit' listener
  // onRestart default resumes:
  await pi.resumeSession();
  assert.equal(resumedTo, "/sessions/keep.jsonl");
});

test("watchdog aborts+restarts a wedged stream", () => {
  const bus = { emit() {}, on() {}, off() {} };
  const pi = new PiRpc({ cli: null, bin: "node", cwd: process.cwd(), bus });
  pi.streaming = true; pi.lastEventAt = 0;
  let aborted = false; pi.abort = async () => { aborted = true; };
  pi.checkStall({ now: 10_000_000, stallMs: 360000 });
  assert.equal(aborted, true);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/pi-rpc.test.mjs`
Expected: FAIL — `pi.handleExit`/`pi.checkStall` not a function.

- [ ] **Step 3: Implement**

In the constructor (after line 47 `this.restarts = 0;`) add:

```js
    this.resumeFile = null;
    this.onRestart = null;
    this.lastEventAt = 0;
    this.lastHealthyAt = 0;
    this.watchdogTimer = null;
```

Add imports at the top:

```js
import { restartDelay, nextRestartState, stalled } from "./watchdog.mjs";
```

Replace the exit handler (lines 75-82) with a call into a method:

```js
    this.proc.on("exit", (code) => this.handleExit(code));
```

Add methods (near `stop()`):

```js
  async handleExit(code) {
    this.bus.emit({ ...this.ctx, kind: "log", ts: Date.now(), level: "system", text: `pi exited (code ${code})` });
    for (const [, p] of this.pending) p.reject(new Error("pi exited"));
    this.pending.clear();
    this.proc = null;
    this.streaming = false;
    if (this.stopped) return;
    const reset = nextRestartState({ restarts: this.restarts, lastHealthyAt: this.lastHealthyAt });
    this.restarts = reset.restarts;
    const delay = restartDelay(this.restarts++);
    setTimeout(() => {
      this.start();
      this.ready?.then(() => this.resumeSession()).catch((e) => this.bus.emit({ ...this.ctx, kind: "log", ts: Date.now(), level: "system", text: `pi resume failed: ${e.message}` }));
    }, delay);
  }

  /** After a restart, put the child back on the session it had, then let the supervisor replay. */
  async resumeSession() {
    if (this.resumeFile) { try { await this.switchSession(this.resumeFile); } catch (e) { this.bus.emit({ ...this.ctx, kind: "log", ts: Date.now(), level: "system", text: `switch_session on resume failed: ${e.message}` }); } }
    if (this.onRestart) await this.onRestart();
  }

  startWatchdog({ stallMs = 360000, intervalMs = 30000 } = {}) {
    this.stopWatchdog();
    this.watchdogTimer = setInterval(() => this.checkStall({ stallMs }), intervalMs);
    this.watchdogTimer.unref?.();
  }
  stopWatchdog() { if (this.watchdogTimer) clearInterval(this.watchdogTimer); this.watchdogTimer = null; }

  checkStall({ now = Date.now(), stallMs = 360000 } = {}) {
    if (!stalled({ streaming: this.streaming, lastEventAt: this.lastEventAt, now, stallMs })) return;
    this.bus.emit({ ...this.ctx, kind: "log", ts: Date.now(), level: "system", text: `pi stream stalled ${Math.round((now - this.lastEventAt) / 1000)}s — aborting + restarting` });
    this.abort?.().catch(() => {});
    try { this.proc?.kill(); } catch { /* exit handler restarts */ }
  }
```

In `onLine()` (line 95), record activity on every event. After `let ev;` parse and before the `agent_start` check, add:

```js
    this.lastEventAt = Date.now();
```

And where streaming becomes true (line 103), stamp health:

```js
    if (ev.type === "agent_start" || ev.type === "turn_start") { this.streaming = true; this.lastHealthyAt = Date.now(); }
```

Keep `stop()` also calling `this.stopWatchdog()`.

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/pi-rpc.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/pi-rpc.mjs test/pi-rpc.test.mjs
git commit -m "feat(pi-rpc): resume saved session on restart, backoff, reset-when-healthy, stall watchdog

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Bounded history read (OOM fix)

**Files:**
- Modify: `server/tailer.mjs` (add `readTail`)
- Modify: `server/watchers.mjs` (`history()` ~line 234-253 uses `readTail`)
- Test: `test/tailer.test.mjs`

**Interfaces:**
- Produces: `readTail(path, { maxBytes = 8*1024*1024 }) → { objects }` — reads only the last `maxBytes` of the file, drops the first partial line, parses complete JSON lines.
- Changes: `SessionWatcher.history(sid, { maxBytes })` reads via `readTail` instead of `readAppended(file, 0, "")`.

- [ ] **Step 1: Write failing tests**

```js
// add to test/tailer.test.mjs
import { readTail } from "../server/tailer.mjs";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("readTail returns only lines within the last maxBytes and skips the partial first line", async () => {
  const f = join(mkdtempSync(join(tmpdir(), "tail-")), "s.jsonl");
  const lines = [];
  for (let i = 0; i < 1000; i++) lines.push(JSON.stringify({ i, pad: "x".repeat(100) }));
  writeFileSync(f, lines.join("\n") + "\n");
  const { objects } = await readTail(f, { maxBytes: 5000 });
  assert.ok(objects.length > 0 && objects.length < 1000);
  assert.equal(objects.at(-1).i, 999);
  // the first returned object is a clean parse (no truncated line slipped through)
  assert.equal(typeof objects[0].i, "number");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/tailer.test.mjs`
Expected: FAIL — `readTail` not exported.

- [ ] **Step 3: Implement**

In `server/tailer.mjs` add:

```js
/** Read only the final `maxBytes` of an append-only JSONL file, discarding the first
 *  (possibly partial) line so every returned object is a clean parse. For history views
 *  of multi-day sessions that must never load the whole file into one string. */
export async function readTail(path, { maxBytes = 8 * 1024 * 1024 } = {}) {
  const st = await fs.stat(path);
  const start = st.size > maxBytes ? st.size - maxBytes : 0;
  const len = st.size - start;
  const fh = await fs.open(path, "r");
  try {
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, start);
    let text = buf.toString("utf8");
    if (start > 0) { const nl = text.indexOf("\n"); text = nl >= 0 ? text.slice(nl + 1) : ""; }
    const objects = [];
    const s = createLineSplitter((line) => { try { objects.push(JSON.parse(line)); } catch { /* skip */ } });
    s.push(text); s.flush();
    return { objects, truncated: start > 0 };
  } finally { await fh.close(); }
}
```

In `server/watchers.mjs`, import `readTail` (line 8) and change `history()`:

```js
  async history(sid, { maxBytes = 8 * 1024 * 1024 } = {}) {
    const s = this.registry.get(sid);
    if (!s?.file) return { events: [], tally: null };
    const harness = s.harness;
    const ctx = { sid, harness };
    let r;
    try { r = await readTail(s.file, { maxBytes }); } catch (e) { if (e?.code === "ENOENT") return { events: [], tally: this.tally.has(sid) ? this.tally.get(sid) : null }; throw e; }
    const events = [];
    const tally = createTally();
    for (const o of r.objects) {
      for (const ev of normalizeEntry(harness, o, ctx)) {
        events.push(ev);
        if (ev.kind === "msg" && ev.usage) tally.add(sid, { groupId: ev.groupId || ev.id, usage: ev.usage, model: ev.model, cost: ev.cost, ts: ev.ts });
      }
    }
    this.tally.reset(sid);
    for (const ev of events) if (ev.kind === "msg" && ev.usage) this.tally.add(sid, { groupId: ev.groupId || ev.id, usage: ev.usage, model: ev.model, cost: ev.cost, ts: ev.ts });
    return { events, tally: tally.get(sid), truncated: r.truncated };
  }
```

(The tally from a truncated tail is approximate; that is acceptable for the display tally and avoids OOM. The authoritative per-token cost tally is still maintained live by the bus listener in `index.mjs`.)

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/tailer.test.mjs test/watchers*.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/tailer.mjs server/watchers.mjs test/tailer.test.mjs
git commit -m "fix(history): read a bounded tail, never the whole session file (multi-day OOM guard)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Bus per-client backpressure bound

**Files:**
- Modify: `server/bus.mjs`
- Test: `test/bus.test.mjs` (create if absent)

**Interfaces:**
- Changes: `emit()` drops a client whose socket write buffer exceeds a cap (slow/half-open LAN client), rather than buffering without limit.

- [ ] **Step 1: Write failing test**

```js
// test/bus.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { Bus } from "../server/bus.mjs";

test("a client whose write buffer is over the cap is dropped, not buffered forever", () => {
  const bus = new Bus();
  const slow = { writableLength: 5 * 1024 * 1024, write() { return false; } };
  bus.addClient(slow);
  bus.emit({ kind: "x", ts: 1 });
  assert.equal(bus.clients.has(slow), false);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/bus.test.mjs`
Expected: FAIL — slow client still present.

- [ ] **Step 3: Implement**

In `server/bus.mjs`, change the write loop in `emit()`:

```js
    const line = `data: ${JSON.stringify(ev)}\n\n`;
    const CAP = 4 * 1024 * 1024;
    for (const res of this.clients) {
      try {
        if ((res.writableLength || 0) > CAP) { this.clients.delete(res); try { res.end?.(); } catch { /* */ } continue; }
        res.write(line);
      } catch { this.clients.delete(res); }
    }
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/bus.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/bus.mjs test/bus.test.mjs
git commit -m "fix(bus): drop a slow SSE client past a write-buffer cap instead of buffering unbounded

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Config knobs for keeper + watchdog

**Files:**
- Modify: `server/config.mjs` (`hookConfig()` ~line 130; top-level `CONFIG` ~line 83)
- Test: `test/config.test.mjs`

**Interfaces:**
- Produces: `hookConfig()` now also returns `summaryProvider`, `summaryModel`, `judgeTimeoutMs`, `heartbeatMs`, `loopK`. Top-level `CONFIG` gains `stallMs`, `restartHealthyMs`, `runsDir`.

- [ ] **Step 1: Write failing tests**

```js
// add to test/config.test.mjs
import { hookConfig } from "../server/config.mjs";
test("hookConfig surfaces summary model, judge timeout, heartbeat, loopK", () => {
  const h = hookConfig({ summaryProvider: "orca", summaryModel: "Qwen/Qwen3.8-27B", judgeTimeoutMs: 90000, heartbeatMs: 60000, loopK: 3 });
  assert.equal(h.summaryProvider, "orca");
  assert.equal(h.summaryModel, "Qwen/Qwen3.8-27B");
  assert.equal(h.judgeTimeoutMs, 90000);
  assert.equal(h.heartbeatMs, 60000);
  assert.equal(h.loopK, 3);
});
test("hookConfig clamps and defaults the new numbers", () => {
  const h = hookConfig({});
  assert.equal(h.heartbeatMs, 60000);
  assert.equal(h.loopK, 3);
  assert.equal(h.judgeTimeoutMs, 120000);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/config.test.mjs`
Expected: FAIL — fields undefined.

- [ ] **Step 3: Implement**

In `hookConfig()` return object (after `summaries:` line), add:

```js
    summaryProvider: String(h.summaryProvider || "").trim(),
    summaryModel: String(h.summaryModel || "").trim(),
    judgeTimeoutMs: int(h.judgeTimeoutMs, 120000, 10000, 600000),
    heartbeatMs: int(h.heartbeatMs, 60000, 5000, 3600000),
    /** Same failure signature this many times in a row → escalate instead of nudging again. */
    loopK: int(h.loopK, 3, 2, 20),
```

In `CONFIG` (after the `hook:` line ~126), add:

```js
  /** Watchdog: pi claims to be streaming but produced no event for this long → abort+restart. */
  stallMs: Number(fc.stallMs) || 360000,
  /** Restart counter resets after the child streamed healthily this long. */
  restartHealthyMs: Number(fc.restartHealthyMs) || 120000,
  /** Where unattended run ledgers live. */
  runsDir: fc.runsDir || join(fc.vaultDir || join(ROOT, "vault"), "Runs"),
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/config.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/config.mjs test/config.test.mjs
git commit -m "feat(config): keeper summary/judge/heartbeat/loop knobs + watchdog + runsDir

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: Keeper — fail-open judge, full goal text, heartbeat, loop detection, pause-not-latch

**Files:**
- Modify: `server/hook.mjs` (`GoalKeeper` — constructor, `onSettled`, `check`, `cancel`, add `heartbeat`, `fingerprint`, `onEvent` user-prompt path)
- Test: `test/hook.test.mjs`

**Interfaces:**
- Consumes: `config.heartbeatMs`, `config.loopK`, `config.judgeTimeoutMs`, `config.summaryProvider/summaryModel` (Task 7); an optional `ledger` handle (Task 11 wires it; here it's optional).
- Produces on `GoalKeeper`:
  - re-engage body now includes `g.text` verbatim.
  - judge failure → treat as `{done:false}` (fail open) and re-engage, with backoff.
  - `startHeartbeat()`/`stopHeartbeat()` — periodic `check()` even with no settle.
  - `fingerprint(tail)` — a short signature of the last failure/tail for loop detection.
  - loop state: `sameFailCount`; at `>= loopK`, escalate (steer "try a different approach" + request model fallback) instead of a plain nudge.
  - `cancel(sid)` sets `g.paused = true` (resumable), not a permanent `aborted`.

- [ ] **Step 1: Write failing tests**

```js
// add to test/hook.test.mjs
import { GoalKeeper } from "../server/hook.mjs";

function fakeBus() { const h = []; return { on: (_e, f) => h.push(f), off() {}, emit(ev) { for (const f of h) f(ev); } }; }

test("re-engage message contains the verbatim goal text", async () => {
  const bus = fakeBus();
  const prompts = [];
  const pi = { sid: "pi:1", proc: {}, streaming: false, state: { model: { provider: "p", id: "m" } }, prompt: async (msg) => prompts.push(msg) };
  const keeper = new GoalKeeper({ bus, getPi: () => pi, judge: async () => '{"done":false,"reason":"keep going","nudge":"do X"}', config: { enabled: true, graceMs: 0, heartbeatMs: 999999 } });
  keeper.setGoal("pi:1", "REVERSE libfoo.so exactly");
  const g = keeper.goal("pi:1"); g.ran = true; g.tail = ["assistant: ok"];
  await keeper.check("pi:1", g.seq);
  assert.ok(prompts.some((p) => p.includes("REVERSE libfoo.so exactly")));
});

test("a judge that never returns JSON fails open (re-engages), never permanently stops", async () => {
  const bus = fakeBus();
  const prompts = [];
  const pi = { sid: "pi:1", proc: {}, streaming: false, state: {}, prompt: async (m) => prompts.push(m) };
  const keeper = new GoalKeeper({ bus, getPi: () => pi, judge: async () => "garbage not json", config: { enabled: true, graceMs: 0, heartbeatMs: 999999, loopK: 3 } });
  keeper.setGoal("pi:1", "goal");
  const g = keeper.goal("pi:1"); g.ran = true;
  await keeper.check("pi:1", g.seq);
  assert.equal(prompts.length, 1); // re-engaged despite no verdict
});

test("same failure fingerprint loopK times escalates with a different-approach steer", async () => {
  const bus = fakeBus();
  const prompts = [];
  const pi = { sid: "pi:1", proc: {}, streaming: false, state: {}, prompt: async (m) => prompts.push(m) };
  const keeper = new GoalKeeper({ bus, getPi: () => pi, judge: async () => '{"done":false,"reason":"err","nudge":"retry"}', config: { enabled: true, graceMs: 0, heartbeatMs: 999999, loopK: 2 } });
  keeper.setGoal("pi:1", "goal");
  const g = keeper.goal("pi:1");
  g.tail = ["tool error build: undefined symbol foo"];
  for (let i = 0; i < 2; i++) { g.ran = true; await keeper.check("pi:1", g.seq); }
  assert.ok(prompts.at(-1).toLowerCase().includes("different approach"));
});

test("cancel pauses (resumable), it does not permanently latch", () => {
  const bus = fakeBus();
  const pi = { sid: "pi:1", proc: {}, streaming: false, state: {} };
  const keeper = new GoalKeeper({ bus, getPi: () => pi, judge: async () => "{}", config: { enabled: true } });
  keeper.setGoal("pi:1", "goal");
  keeper.cancel("pi:1");
  assert.equal(keeper.goal("pi:1").paused, true);
  keeper.resume("pi:1");
  assert.equal(keeper.goal("pi:1").paused, false);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/hook.test.mjs`
Expected: FAIL — goal text absent from prompt; garbage judge does not re-engage; no `resume`/escalation.

- [ ] **Step 3: Implement**

In `GoalKeeper` constructor, extend defaults:

```js
    this.config = { enabled: false, provider: "", model: "", maxIdleNudges: 5, graceMs: 2000, summaries: true, heartbeatMs: 60000, loopK: 3, judgeTimeoutMs: 120000, ...config };
    this.heartbeatTimer = null;
```

In `setGoal()`, add `paused: false, sameFailCount: 0, lastFingerprint: ""` to the `g` object.

Replace `cancel()` and add `resume()`:

```js
  /** The user paused the agent: stop nudging until resumed or a new prompt arrives. Not permanent. */
  cancel(sid) { const g = this.goals.get(sid); if (!g) return; clearTimeout(g.timer); g.timer = null; g.paused = true; }
  resume(sid) { const g = this.goals.get(sid); if (!g) return; g.paused = false; }
```

In `onEvent()`, the assistant-stopReason line (191): drop the `g.aborted = true` on `"aborted"` (an abort is a pause handled by `cancel()`), keep recording `g.stopReason`. Replace line 191 with:

```js
      if (ev.role === "assistant" && ev.stopReason) g.stopReason = ev.stopReason;
```

In `onSettled()` (200) and `check()` (227), replace every `g.aborted` guard with `g.paused`.

Add a fingerprint helper (module scope):

```js
/** A short signature of the current failure/tail so the keeper can detect "stuck on the same thing". */
export function fingerprint(tail = []) {
  const last = [...tail].reverse().find((l) => /error|fail|undefined|cannot|exception/i.test(l)) || tail.at(-1) || "";
  return String(last).replace(/0x[0-9a-f]+|\d+/gi, "#").replace(/\s+/g, " ").trim().slice(0, 160);
}
```

Rewrite the judge+verdict section of `check()` (lines 232-254). Key changes: fail open on no verdict; include `g.text` verbatim; loop detection; backoff by returning after scheduling the next check further out when escalating.

```js
    g.checking = true;
    let verdict = null;
    try {
      const input = buildJudgeInput({ goal: g.text, tail: g.tail, nudges: g.nudges, idleNudges: g.idleNudges, maxIdleNudges: this.config.maxIdleNudges, stopReason: g.stopReason });
      const pick = { provider: this.config.provider || pi.state?.model?.provider || "", model: this.config.model || pi.state?.model?.id || "" };
      const reply = await this.judge(input, pick);
      verdict = parseVerdict(reply);
      if (!verdict) this.emitLog(sid, `goal hook: judge reply was not JSON: ${clip(reply, 200)}`);
    } catch (e) { this.emitLog(sid, `goal hook: judge failed: ${e.message}`); }
    finally { g.checking = false; }
    if (g.seq !== seq || g.paused || pi.streaming || g.ran) return verdict;
    // Fail open: a missing/failed verdict is treated as "not done", so the run never stops on a judge hiccup.
    if (verdict?.done) { this.emitLog(sid, `goal hook: done (${verdict.reason})`); return verdict; }
    const reason = verdict?.reason || "(no judge verdict — assuming not done)";
    const nudge = verdict?.nudge || "";
    // Loop detection: same failure signature loopK times → escalate instead of nudging the same way.
    const fp = fingerprint(g.tail);
    g.sameFailCount = fp && fp === g.lastFingerprint ? g.sameFailCount + 1 : 0;
    g.lastFingerprint = fp;
    const escalate = g.sameFailCount >= this.config.loopK;
    g.nudges++; g.nudged = true;
    const note = `Goal hook re-engaged the agent (#${g.nudges}${escalate ? ", escalating" : ""})${reason ? `: ${reason}` : ""}`;
    const body = escalate
      ? `You have been stuck on the same problem for ${g.sameFailCount + 1} attempts. STOP repeating it and try a DIFFERENT APPROACH. If a model/tool keeps failing, switch strategy or mark this sub-task blocked in your progress notes and move on to another part of the goal.\n\nThe original goal, verbatim:\n${g.text}\n\n${nudge}`
      : `Automatic goal check: your last turn ended before the request was finished.${reason ? ` ${reason}` : ""}${nudge ? ` ${nudge}` : ""}\n\nThe original goal, verbatim:\n${g.text}\n\nContinue now and stop only when it is completely done, or when you truly need something only the user can provide.`;
    if (escalate && this.onEscalate) { try { await this.onEscalate(sid, g); } catch { /* best effort */ } }
    try {
      await pi.prompt(hookMessage("goal", note, body), { echo: false });
      this.bus.emit({ sid, harness: "pi", kind: "hook", ts: Date.now(), name: "goal", attempt: g.nudges, idle: g.idleNudges, maxIdle: this.config.maxIdleNudges, reason, escalate, text: note });
    } catch (e) { this.emitLog(sid, `goal hook: could not re-engage pi: ${e.message}`); }
    return verdict;
```

Remove the `maxIdleNudges` permanent-giveup early return at line 231 (replace with: it still *counts* idle nudges for the note, but never returns null to stop — escalation handles true loops). Delete lines 231's `return null;` branch body and keep going to the judge.

Add heartbeat (so `/goal` while idle works and a "gave up" state self-heals):

```js
  startHeartbeat() {
    this.stopHeartbeat();
    if (!this.config.heartbeatMs) return;
    this.heartbeatTimer = setInterval(() => {
      if (!this.config.enabled) return;
      for (const [sid, g] of this.goals) {
        const pi = this.getPi(sid);
        if (!pi || pi.streaming || g.paused || g.checking) continue;
        this.check(sid, g.seq).catch((e) => this.log("heartbeat check failed", e.message));
      }
    }, this.config.heartbeatMs);
    this.heartbeatTimer.unref?.();
  }
  stopHeartbeat() { if (this.heartbeatTimer) clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
```

Pass `judgeTimeoutMs` through when the judge is constructed in `index.mjs` (Task 10). Call `startHeartbeat()` in `setConfig()` when enabled, and `stopHeartbeat()` when disabled or in `dispose()`.

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/hook.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/hook.mjs test/hook.test.mjs
git commit -m "feat(keeper): full goal text, fail-open judge, heartbeat re-arm, loop detection, pause-not-latch

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 9: Judge timeout from config + summarizer picks

**Files:**
- Modify: `server/hook.mjs` (`makeSummary` pick already reads `summaryProvider/summaryModel`; nothing to change there) and `server/index.mjs` (judge/summarize construction ~line 41-43 to pass `timeoutMs: cfg.hook.judgeTimeoutMs`)
- Test: `test/hook.test.mjs` (assert the pick + timeout plumb through)

**Interfaces:**
- Consumes: `hookConfig().judgeTimeoutMs`, `summaryProvider`, `summaryModel`.
- Produces: `runJudge` called with `timeoutMs` from config.

- [ ] **Step 1: Write failing test**

```js
test("summarizer uses summaryProvider/summaryModel when set", async () => {
  const bus = fakeBus();
  let pick = null;
  const pi = { sid: "pi:1", proc: {}, streaming: false, state: { model: { provider: "chatP", id: "chatM" } } };
  const keeper = new GoalKeeper({ bus, getPi: () => pi, judge: async () => "{}", summarize: async (_i, p) => { pick = p; return "ok"; }, config: { enabled: false, summaries: true, summaryProvider: "sumP", summaryModel: "sumM" } });
  keeper.setGoal("pi:1", "g");
  await keeper.makeSummary("pi:1");
  assert.deepEqual(pick, { provider: "sumP", model: "sumM" });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/hook.test.mjs`
Expected: PASS already if `makeSummary` reads those keys (it does, line 222). If it FAILS because defaults weren't surfaced, Task 7 fixed `hookConfig`; ensure the keeper's `config` includes them. (This task mostly locks the behavior + the index wiring below.)

- [ ] **Step 3: Implement**

In `server/index.mjs`, where `runJudge` is called for the judge (line 41), add `timeoutMs: hookConfig(cfg.hook).judgeTimeoutMs`:

```js
    judge: cfg.judge || ((input, pick) => runJudge({ cli: cfg.piCli, bin: cfg.piBin, provider: pick.provider, model: pick.model, env: piChildEnv(cfg), cwd: pi?.cwd || cfg.cwd, spawn: cfg.judgeSpawn, timeoutMs: hookConfig(cfg.hook).judgeTimeoutMs }, { system: JUDGE_SYSTEM, input })),
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/hook.test.mjs test/config.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/hook.mjs server/index.mjs test/hook.test.mjs
git commit -m "feat(keeper): judge timeout + summarizer model come from config

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 10: Process guards + wire watchdog/heartbeat into the server

**Files:**
- Modify: `server/index.mjs` (`startPi`/`restartPi`; `listen()`; the standalone entry ~line 501; add `process.on('uncaughtException'|'unhandledRejection')`)
- Test: `test/server.test.mjs` (assert startPi starts the watchdog; a handler is registered)

**Interfaces:**
- Consumes: `pi.startWatchdog`, `keeper.startHeartbeat`, `cfg.stallMs`.
- Produces: server installs crash guards and starts the watchdog/heartbeat on boot.

- [ ] **Step 1: Write failing test**

```js
// add to test/server.test.mjs
test("startPi starts the stall watchdog", async () => {
  const app = await createApp({ autoStartPi: false, createPi: fakePiFactory(), port: 0 });
  const pi = app.startPi(process.cwd());
  assert.ok(pi.watchdogTimer || pi._watchdogStarted, "watchdog should be armed");
  app.close();
});
```

(Use the existing `createPi` injection; have `fakePiFactory` return an object exposing `startWatchdog` that sets `this._watchdogStarted = true`, plus `start`, `stop`, `waitReady`.)

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/server.test.mjs`
Expected: FAIL — watchdog not armed.

- [ ] **Step 3: Implement**

In `startPi()` (line 63), after `pi.start();` add:

```js
    pi.startWatchdog?.({ stallMs: cfg.stallMs });
```

In `listen()` after `if (cfg.autoStartPi) startPi(cfg.cwd);` add:

```js
    keeper.startHeartbeat?.();
```

In the standalone entry block (line 501-507), add crash guards so one stray error can't kill a multi-day server:

```js
  process.on("uncaughtException", (e) => log("uncaughtException", e?.stack || e));
  process.on("unhandledRejection", (e) => log("unhandledRejection", e?.stack || e));
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/server.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/index.mjs test/server.test.mjs
git commit -m "feat(server): arm stall watchdog + keeper heartbeat; add crash guards for long runs

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 11: Persist goal + counters to the run ledger; resume re-attaches

**Files:**
- Modify: `server/index.mjs` (create/open a `RunLedger` when a run is active; pass it to the keeper; on pi restart, re-attach the goal to the new sid)
- Modify: `server/hook.mjs` (`GoalKeeper` accepts `ledger`; persists goal text + counters on set/nudge; `attachToSid(oldSid, newSid)`)
- Test: `test/hook.test.mjs`

**Interfaces:**
- Consumes: `RunLedger` (Task 1).
- Produces on `GoalKeeper`:
  - constructor option `ledger` (optional `RunLedger`-like with `writeControl`, `goalText`).
  - `setGoal`/`check` call `this.ledger?.writeControl({ goalText, counters })`.
  - `attachToSid(oldSid, newSid)` — moves goal state to the new session id after a pi restart (so a crash doesn't drop the goal).

- [ ] **Step 1: Write failing tests**

```js
test("setGoal persists the goal text to the ledger", () => {
  const bus = fakeBus();
  const writes = [];
  const ledger = { writeControl: (p) => writes.push(p), goalText: () => "" };
  const pi = { sid: "pi:1", proc: {}, streaming: false, state: {} };
  const keeper = new GoalKeeper({ bus, getPi: () => pi, judge: async () => "{}", ledger, config: {} });
  keeper.setGoal("pi:1", "DO THE THING");
  assert.ok(writes.some((w) => w.goalText === "DO THE THING"));
});

test("attachToSid moves goal state to a new session id after a restart", () => {
  const bus = fakeBus();
  const pi = { sid: "pi:2", proc: {}, streaming: false, state: {} };
  const keeper = new GoalKeeper({ bus, getPi: () => pi, judge: async () => "{}", config: {} });
  keeper.setGoal("pi:1", "goal", true);
  keeper.attachToSid("pi:1", "pi:2");
  assert.equal(keeper.goal("pi:2").text, "goal");
  assert.equal(keeper.goal("pi:1"), null);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/hook.test.mjs`
Expected: FAIL — no `ledger` persistence, no `attachToSid`.

- [ ] **Step 3: Implement**

In `GoalKeeper` constructor, accept `ledger`:

```js
  constructor({ bus, getPi, judge, summarize, config = {}, log = () => {}, ledger = null, onEscalate = null }) {
    …
    this.ledger = ledger;
    this.onEscalate = onEscalate;
```

In `setGoal()`, after storing `g`, persist:

```js
    this.ledger?.writeControl?.({ goalText: text });
```

In `check()` where `g.nudges++` happens, persist counters:

```js
    this.ledger?.writeControl?.({ counters: { nudges: g.nudges } });
```

Add:

```js
  /** After a pi restart (new session id), carry the goal + counters to the new sid so nothing is lost. */
  attachToSid(oldSid, newSid) {
    if (oldSid === newSid) return;
    const g = this.goals.get(oldSid);
    if (!g) return;
    clearTimeout(g.timer); g.timer = null;
    this.goals.delete(oldSid);
    this.goals.set(newSid, g);
  }
```

In `server/index.mjs`:
- Add `let runLedger = null;` near `let pi = null;`.
- Construct the keeper with `ledger: () => runLedger` indirection — but since the keeper stores `this.ledger`, instead give it a thin proxy whose methods read the current `runLedger`:

```js
  const ledgerProxy = { writeControl: (p) => runLedger?.writeControl(p), goalText: () => runLedger?.goalText() || "" };
```

Pass `ledger: ledgerProxy` and `onEscalate: async () => { await restartPi.requestFallback?.(); }` (fallback is driven by the extension; here onEscalate just logs + appends an event):

```js
    onEscalate: async (sid, g) => { runLedger?.appendEvent({ kind: "escalate", sid, nudges: g.nudges, fingerprint: g.lastFingerprint }); },
```

- In `restartPi()` (line 70), after `await pi.waitReady()` and `switchSession`, re-attach the goal:

```js
      const oldSid = file ? `pi:` : pi.sid; // best effort
      keeper.attachToSid(prevSid, pi.sid);
```

where `prevSid` is captured as `const prevSid = pi.sid;` before `startPi(cwd)`.

- In `pi.onRestart` wiring (set in `startPi`): assign `pi.onRestart = async () => { const prev = /* old sid */; keeper.attachToSid(prev, pi.sid); };` — simplest is to capture the sid before restart in `handleExit`; since that lives in pi-rpc, expose `pi.resumeFile` (already set) and let the supervisor set `pi.onRestart`. In `startPi`:

```js
    pi.onRestart = async () => { if (runLedger) { keeper.attachToSid(keeper._lastSid || pi.sid, pi.sid); runLedger.writeControl({ sessionFile: pi.state?.sessionFile || runLedger.readControl().sessionFile }); } };
```

Track `keeper._lastSid` by updating it whenever a goal is set/checked (set `this._lastSid = sid` in `setGoal`/`check`). Keep `pi.resumeFile = runLedger?.readControl().sessionFile || pi.state?.sessionFile` updated in `refreshState` via the supervisor: after each `pi.waitReady()`/settle, set `if (runLedger) pi.resumeFile = pi.state?.sessionFile; runLedger?.writeControl({ sessionFile: pi.state?.sessionFile })`.

(Implementation note for the engineer: the invariant is simply *run.json.sessionFile always names pi's current session file; pi.resumeFile mirrors it; after any restart the keeper's goal is moved onto pi's new sid*. Wire it wherever `refreshState()` resolves — add a `bus` `session` event listener in index.mjs that does `if (runLedger && ev.owned && ev.harness==='pi') { runLedger.writeControl({ sessionFile: ev.file }); if (pi) pi.resumeFile = ev.file; }`.)

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/hook.test.mjs test/server.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/hook.mjs server/index.mjs test/hook.test.mjs
git commit -m "feat(keeper): persist goal+counters to the run ledger and re-attach across a pi restart

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 12: omni-run pure helpers (ledger render, budget trim, offload decision)

**Files:**
- Create: `integrations/pi/omni-run-lib.mjs`
- Test: `test/omni-run-lib.test.mjs`

**Interfaces:**
- Produces (all pure, no pi imports, loadable under `node --test`):
  - `renderContextBlock({ goal, ledgerMd }, { budget = 4000 }) → string` — the verbatim goal + a budget-trimmed slice of `ledger.md` (Critical facts + Next steps first) to prepend to each LLM call.
  - `renderCompactionSummary({ goal, ledgerMd, serializedSpan }, { budget = 6000 }) → string` — a fixed-budget, non-growing summary derived from the ledger (NOT a grow-forever update).
  - `shouldOffload(content, { maxChars = 12000 }) → boolean`.
  - `offloadReference({ sha, bytes, preview, path }) → string` — the short inline replacement text pointing at the artifact.
  - `sha256Hex(text) → string` (via `node:crypto`).

- [ ] **Step 1: Write failing tests**

```js
// test/omni-run-lib.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderContextBlock, renderCompactionSummary, shouldOffload, offloadReference, sha256Hex } from "../integrations/pi/omni-run-lib.mjs";

test("context block keeps the goal verbatim and fits the budget", () => {
  const ledgerMd = "## Critical facts\n" + "fact ".repeat(5000) + "\n## Next steps\nstep";
  const out = renderContextBlock({ goal: "EXACT GOAL", ledgerMd }, { budget: 500 });
  assert.ok(out.includes("EXACT GOAL"));
  assert.ok(out.length <= 500 + 200); // goal + budgeted slice, small overhead
});

test("compaction summary never exceeds its budget regardless of input size", () => {
  const big = "x".repeat(200000);
  const out = renderCompactionSummary({ goal: "g", ledgerMd: "## Next steps\n" + big, serializedSpan: big }, { budget: 3000 });
  assert.ok(out.length <= 3000);
  assert.ok(out.includes("g"));
});

test("shouldOffload triggers only past the cap; reference is short and cites the path", () => {
  assert.equal(shouldOffload("x".repeat(100), { maxChars: 500 }), false);
  assert.equal(shouldOffload("x".repeat(1000), { maxChars: 500 }), true);
  const ref = offloadReference({ sha: "abc123", bytes: 1048576, preview: "ELF…", path: "artifacts/abc123.bin" });
  assert.ok(ref.includes("artifacts/abc123.bin"));
  assert.ok(ref.length < 1000);
});

test("sha256Hex is stable", () => {
  assert.equal(sha256Hex("a"), sha256Hex("a"));
  assert.notEqual(sha256Hex("a"), sha256Hex("b"));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/omni-run-lib.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `integrations/pi/omni-run-lib.mjs`**

```js
/**
 * Pure helpers for the omni-run pi extension — no pi-runtime imports, so they load under
 * `node --test`. The extension (omni-run.ts) imports these and does the pi wiring.
 */
import { createHash } from "node:crypto";

export const sha256Hex = (text) => createHash("sha256").update(text).digest("hex");

const clip = (s, n) => { const t = String(s ?? ""); return t.length > n ? t.slice(0, n) : t; };

/** Pull named sections out of ledger.md (## headings). */
function sections(ledgerMd) {
  const out = {};
  const re = /^##\s+(.+)$/gm;
  let m, last = null, lastIdx = 0;
  while ((m = re.exec(ledgerMd))) { if (last) out[last] = ledgerMd.slice(lastIdx, m.index).trim(); last = m[1].trim(); lastIdx = re.lastIndex; }
  if (last) out[last] = ledgerMd.slice(lastIdx).trim();
  return out;
}

/** Verbatim goal + a budget-trimmed slice of the ledger (Critical facts and Next steps first). */
export function renderContextBlock({ goal, ledgerMd = "" }, { budget = 4000 } = {}) {
  const s = sections(ledgerMd);
  const order = ["Critical facts", "Next steps", "Milestones", "Decisions", "Constraints"];
  let body = "";
  for (const name of order) { if (!s[name]) continue; const add = `## ${name}\n${s[name]}\n\n`; if (body.length + add.length > budget) { body += clip(add, Math.max(0, budget - body.length)); break; } body += add; }
  return `<omni-run-goal>\n${goal}\n</omni-run-goal>\n<omni-run-ledger>\n${body.trim()}\n</omni-run-ledger>`;
}

/** A fixed-budget summary: the goal, then the ledger's forward-looking sections, hard-capped.
 *  It does NOT fold in the full span verbatim, so it cannot grow pass-over-pass. */
export function renderCompactionSummary({ goal, ledgerMd = "", serializedSpan = "" }, { budget = 6000 } = {}) {
  const s = sections(ledgerMd);
  const parts = [`GOAL: ${goal}`];
  for (const name of ["Milestones", "Decisions", "Critical facts", "Next steps"]) if (s[name]) parts.push(`${name}:\n${s[name]}`);
  // A small, bounded tail of the most recent raw span for immediate continuity.
  parts.push(`RECENT:\n${clip(serializedSpan.slice(-2000), 2000)}`);
  return clip(parts.join("\n\n"), budget);
}

export const shouldOffload = (content, { maxChars = 12000 } = {}) => String(content ?? "").length > maxChars;

export function offloadReference({ sha, bytes, preview, path }) {
  return [
    `⟨offloaded ${bytes} bytes → ${path} (sha256 ${sha.slice(0, 16)})⟩`,
    `Preview (first 800 chars):`,
    clip(preview, 800),
    `To read a slice, use a shell/read tool on ${path} with an offset/length; do not expect the whole blob inline.`,
  ].join("\n");
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/omni-run-lib.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add integrations/pi/omni-run-lib.mjs test/omni-run-lib.test.mjs
git commit -m "feat(omni-run): pure helpers — context block, non-growing compaction summary, offload refs

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 13: omni-run extension — compaction, context re-injection, tool-result offload, progress capture

**Files:**
- Create: `integrations/pi/omni-run.ts`
- Test: covered by Task 12 (pure logic); wiring is smoke-checked in Task 16.

**Interfaces:**
- Consumes: `omni-run-lib.mjs` helpers; `OMNI_RUN_DIR` env (the run directory from the supervisor); pi `ExtensionAPI` hooks `session_before_compact`, `context`, `tool_result`, `tool_call`.
- Produces: the installed extension that keeps the goal alive and tool output bounded.

- [ ] **Step 1: Write the extension (no new unit test; logic is tested in Task 12, wiring in Task 16)**

Because this file wires pure helpers to pi hooks, the TDD unit coverage lives in Task 12. Implement `integrations/pi/omni-run.ts`:

```ts
/**
 * Omni Agent "context brain" for long unattended pi runs. Reads the run ledger named by
 * OMNI_RUN_DIR and:
 *   - session_before_compact: writes a fixed-budget, non-growing summary (thinking OFF, a
 *     configurable cheap model allowed) derived from ledger.md, so compaction never death-spirals.
 *   - context: prepends the verbatim goal + a budgeted ledger slice to every LLM call, so the
 *     goal and critical facts (paths/symbols/addresses) survive any number of compactions.
 *   - tool_result: offloads oversized tool output (huge .so dumps) to artifacts/ and leaves a
 *     short reference inline, so one result can't blow the window.
 * Installed by: node scripts/install.mjs
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderContextBlock, renderCompactionSummary, shouldOffload, offloadReference, sha256Hex } from "./omni-run-lib.mjs";

function runDir(): string | null {
  const d = process.env.OMNI_RUN_DIR;
  return d && existsSync(d) ? d : null;
}
const readText = (f: string) => { try { return readFileSync(f, "utf8"); } catch { return ""; } };

export default function omniRun(pi: ExtensionAPI) {
  const dir = runDir();
  if (!dir) return; // no active run; this extension is a no-op for ordinary chats
  const ledgerFile = join(dir, "ledger.md");
  const artifactsDir = join(dir, "artifacts");
  const controlFile = join(dir, "run.json");
  const goal = () => { try { return JSON.parse(readText(controlFile)).goalText || ""; } catch { return ""; } };
  // Optional cheap summarizer model: run.json.model.summary = "provider/id"
  const summaryModel = () => { try { return JSON.parse(readText(controlFile)).model?.summary || ""; } catch { return ""; } };

  // 1) Re-inject goal + ledger every LLM call (not persisted; pi's context semantics).
  pi.on("context", (ev: any) => {
    const block = renderContextBlock({ goal: goal(), ledgerMd: readText(ledgerFile) }, { budget: 4000 });
    const sys = { role: "system", content: [{ type: "text", text: block }] };
    return { messages: [sys, ...ev.messages] };
  });

  // 2) Fixed-budget compaction derived from the ledger (thinking off). Never grows.
  pi.on("session_before_compact", async (ev: any, ctx: any) => {
    try {
      const serialized = ctx?.serializeConversation ? ctx.serializeConversation(ev.preparation?.messagesToSummarize ?? []) : "";
      const summary = renderCompactionSummary({ goal: goal(), ledgerMd: readText(ledgerFile), serializedSpan: serialized }, { budget: 6000 });
      return { compaction: { summary, firstKeptEntryId: ev.preparation?.firstKeptEntryId, tokensBefore: ev.preparation?.tokensBefore } };
    } catch {
      return undefined; // fall back to pi's own compaction rather than failing the run
    }
  });

  // 3) Offload oversized tool results to artifacts/, leave a short reference inline.
  pi.on("tool_result", (ev: any) => {
    try {
      const content: any[] = Array.isArray(ev.content) ? ev.content : [];
      let changed = false;
      const next = content.map((c) => {
        if (c?.type !== "text" || !shouldOffload(c.text)) return c;
        const sha = sha256Hex(c.text);
        mkdirSync(artifactsDir, { recursive: true });
        const path = join(artifactsDir, `${sha.slice(0, 32)}.txt`);
        if (!existsSync(path)) writeFileSync(path, c.text);
        changed = true;
        return { type: "text", text: offloadReference({ sha, bytes: Buffer.byteLength(c.text), preview: c.text.slice(0, 800), path: `artifacts/${sha.slice(0, 32)}.txt` }) };
      });
      if (changed) return { content: next };
    } catch { /* never fail the tool */ }
  });
}
```

- [ ] **Step 2: Typecheck/lint by import**

Run: `node --check integrations/pi/omni-run.ts` is not valid (TS). Instead verify the pure import path resolves:
Run: `node -e "import('./integrations/pi/omni-run-lib.mjs').then(m=>console.log(Object.keys(m).join(',')))"`
Expected: prints `renderContextBlock,renderCompactionSummary,shouldOffload,offloadReference,sha256Hex`.

- [ ] **Step 3: Commit**

```bash
git add integrations/pi/omni-run.ts
git commit -m "feat(omni-run): extension wiring — context re-injection, fixed-budget compaction, tool offload

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 14: Fix omni-fallback to recover back up to the primary

**Files:**
- Modify: `integrations/pi/omni-fallback.ts`
- Test: add pure-helper tests to a new `test/omni-fallback-lib.test.mjs` for the recover-up decision (extract the decision as a pure exported function).

**Interfaces:**
- Produces: `nextModelOnHealthy(chain, current, { cooldownTurns, healthyTurns }) → Slot | null` — returns the model one step *up* toward the primary once `healthyTurns >= cooldownTurns`, else null. Exported from the module and unit-tested.

- [ ] **Step 1: Write failing tests**

```js
// test/omni-fallback-lib.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { modelsBelow, nextModelOnHealthy } from "../integrations/pi/omni-fallback.ts"; // see note

const chain = [{ provider: "a", id: "1" }, { provider: "a", id: "2" }, { provider: "b", id: "3" }];

test("recovers one step up after the cooldown of healthy turns", () => {
  const up = nextModelOnHealthy(chain, { provider: "b", id: "3" }, { cooldownTurns: 3, healthyTurns: 3 });
  assert.deepEqual(up, { provider: "a", id: "2" });
});
test("stays put before the cooldown", () => {
  assert.equal(nextModelOnHealthy(chain, { provider: "b", id: "3" }, { cooldownTurns: 3, healthyTurns: 2 }), null);
});
test("at the top, nothing to recover to", () => {
  assert.equal(nextModelOnHealthy(chain, { provider: "a", id: "1" }, { cooldownTurns: 3, healthyTurns: 9 }), null);
});
```

> Note: `node --test` cannot import `.ts` directly. Move the pure functions (`readChain`, `modelsBelow`, `nextModelOnHealthy`, `modelsFile`) into a sibling `integrations/pi/omni-fallback-lib.mjs` and have `omni-fallback.ts` import them. Point the test at the `.mjs`. Do this extraction as the first step of the implementation.

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/omni-fallback-lib.test.mjs`
Expected: FAIL — `nextModelOnHealthy` not defined.

- [ ] **Step 3: Implement**

Create `integrations/pi/omni-fallback-lib.mjs` with `modelsFile`, `readChain`, `modelsBelow` (moved verbatim from the `.ts`) plus:

```js
export function modelsAbove(chain, current) {
  if (!current) return [];
  const i = chain.findIndex((s) => s.provider === current.provider && s.id === current.id);
  return i <= 0 ? [] : chain.slice(0, i).reverse();
}
/** One step up toward the primary, only after enough consecutive healthy turns. */
export function nextModelOnHealthy(chain, current, { cooldownTurns = 5, healthyTurns = 0 } = {}) {
  if (healthyTurns < cooldownTurns) return null;
  const up = modelsAbove(chain, current);
  return up[0] || null;
}
```

In `omni-fallback.ts`: import these from `./omni-fallback-lib.mjs` (remove the local copies). Add a healthy-turn counter and a `turn_end`/`agent_end` recovery path:

```ts
import { modelsFile, readChain, modelsBelow, nextModelOnHealthy } from "./omni-fallback-lib.mjs";

let healthy = 0;
const COOLDOWN = 5;
```

In the existing `agent_end` handler: when the last message is NOT an error, increment `healthy` and try to step up:

```ts
    if (!failed || failed.role !== "assistant" || failed.stopReason !== "error") {
      healthy++;
      const current = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;
      const up = nextModelOnHealthy(readChain(modelsFile()), current, { cooldownTurns: COOLDOWN, healthyTurns: healthy });
      if (up) {
        const model = ctx.modelRegistry?.find?.(up.provider, up.id);
        if (model && await pi.setModel(model)) {
          healthy = 0;
          await pi.sendMessage({ customType: NOTICE, content: `recovered up to ${up.provider}/${up.id}`, display: true }, { deliverAs: "steer" });
        }
      }
      return;
    }
    healthy = 0; // an error resets the recovery clock
```

(The rest of the error-path step-down logic is unchanged, but now imports `modelsBelow` from the lib.)

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/omni-fallback-lib.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add integrations/pi/omni-fallback.ts integrations/pi/omni-fallback-lib.mjs test/omni-fallback-lib.test.mjs
git commit -m "feat(omni-fallback): recover up toward the primary after a healthy cooldown (no more one-way ratchet)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 15: Fix omni-mcp late-result delivery (shape + wake idle agent)

**Files:**
- Modify: `integrations/pi/omni-mcp.ts` (the `onLate` handler ~line 275-283)
- Test: none at unit level (pi runtime); behavior verified in Task 16 smoke. Add a comment-tested invariant.

**Interfaces:**
- Changes: late MCP results are delivered as a proper message object with `triggerTurn` so an idle agent wakes.

- [ ] **Step 1: Implement the fix**

Replace the `onLate` body (lines 275-283) with a correctly-shaped `sendMessage` that wakes an idle agent:

```ts
						const onLate = (err: Error | null, payload?: LatePayload) => {
							if (err || !payload) return;
							try {
								pi.sendMessage?.(
									{ customType: "omnidroid-late", content: `✓ ${name} finished after running long${payload.isError ? " (with an error)" : ""}:\n${clip(pretty(payload.text))}`, display: true },
									{ deliverAs: "followUp", triggerTurn: true },
								);
							} catch { /* best effort */ }
						};
```

- [ ] **Step 2: Verify the pure import still resolves**

Run: `node -e "console.log(require('node:fs').readFileSync('integrations/pi/omni-mcp.ts','utf8').includes('triggerTurn'))"`
Expected: prints `true`.

- [ ] **Step 3: Commit**

```bash
git add integrations/pi/omni-mcp.ts
git commit -m "fix(omni-mcp): deliver a late tool result as a proper message that wakes an idle agent

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 16: Install omni-run; verify extensions load

**Files:**
- Modify: `scripts/install.mjs` (`EXTENSIONS` ~line 29)
- Test: `test/install.test.mjs`

**Interfaces:**
- Changes: `EXTENSIONS` includes `omni-run.ts`; the installer copies `omni-run-lib.mjs` and `omni-fallback-lib.mjs` too (the `.ts` files import them at runtime).

- [ ] **Step 1: Write failing test**

```js
// add to test/install.test.mjs
test("installer copies omni-run and its lib siblings", () => {
  // run the installer into a temp OMNI_HOME, then assert the files exist
  // (mirror the existing install.test.mjs harness: spawn node scripts/install.mjs with OMNI_HOME set)
  const { home } = runInstaller(); // existing helper in this test file
  for (const f of ["omni-run.ts", "omni-run-lib.mjs", "omni-fallback-lib.mjs", "omni-fallback.ts"]) {
    assert.ok(existsSync(join(home, ".pi", "agent", "extensions", f)), `${f} should be installed`);
  }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/install.test.mjs`
Expected: FAIL — `omni-run.ts` not installed.

- [ ] **Step 3: Implement**

In `scripts/install.mjs`, change the `EXTENSIONS` list (line 29) to include the new extension and the shared `.mjs` libs (so the `.ts` imports resolve at pi runtime):

```js
const EXTENSIONS = ["omni-memory.ts", "omni-claude.ts", "omni-graph.ts", "omni-fallback.ts", "omni-fallback-lib.mjs", "omni-mcp.ts", "omni-run.ts", "omni-run-lib.mjs"];
```

(No other change needed: the copy loop at line 130 copies each name from `integrations/pi/` to the extensions dir, and the uninstall loop removes them.)

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/install.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/install.mjs test/install.test.mjs
git commit -m "feat(install): ship omni-run + the shared .mjs libs into pi's extensions

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 17: The durable CLI runner (`scripts/run.mjs`)

**Files:**
- Create: `scripts/run.mjs`
- Test: `test/run-cli.test.mjs`

**Interfaces:**
- Consumes: `createApp` from `server/index.mjs`, `RunLedger` from `server/run-ledger.mjs`.
- Produces:
  - `runUnattended({ cwd, goal, provider, model, thinking, runId, cfg, maxSeconds = 0, createApp }) → Promise<{ runId, status }>` — creates/opens the ledger, sets `OMNI_RUN_DIR`, starts the app + pi, sets the explicit goal, enables the keeper, and resolves only when `run.json.status` becomes `done` or on stop. Never resolves on a mere settle.
  - CLI: `node scripts/run.mjs --cwd <dir> --goal "…" [--goal-file f] [--resume <run-id>] [--provider p] [--model id] [--thinking lvl] [--max-seconds N]`.

- [ ] **Step 1: Write failing tests**

```js
// test/run-cli.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runUnattended } from "../scripts/run.mjs";
import { RunLedger } from "../server/run-ledger.mjs";

function fakeApp({ onGoal }) {
  const listeners = [];
  const bus = { on: (_e, f) => listeners.push(f), off() {}, emit(ev) { for (const f of listeners) f(ev); } };
  const pi = { sid: "pi:1", proc: {}, streaming: false, state: { sessionFile: "/s/a.jsonl" }, waitReady: async () => {}, prompt: async () => {}, stop() {} };
  const keeper = { setExplicitGoal: (_s, g) => onGoal(g), setConfig() {}, startHeartbeat() {}, config: { enabled: true } };
  return {
    async listen() {}, close() {}, bus, keeper, startPi: () => pi, get pi() { return pi; },
    vault: { pack: async () => "" }, cfg: {},
    _settle() { bus.emit({ sid: "pi:1", kind: "status", streaming: false }); },
  };
}

test("sets OMNI_RUN_DIR, creates a ledger, sets the explicit goal, and does NOT resolve on a settle", async () => {
  const runsRoot = mkdtempSync(join(tmpdir(), "runs-"));
  let gotGoal = null;
  const app = fakeApp({ onGoal: (g) => (gotGoal = g) });
  let resolved = false;
  const p = runUnattended({ cwd: process.cwd(), goal: "REVERSE IT", runsRoot, createApp: async () => app, pollMs: 10 }).then((r) => { resolved = true; return r; });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(gotGoal, "REVERSE IT");
  assert.ok(process.env.OMNI_RUN_DIR && process.env.OMNI_RUN_DIR.includes(runsRoot.split(/[\\/]/).pop()));
  app._settle();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(resolved, false, "a settle must not end the unattended run");
  // flipping status to done ends it
  RunLedger.open(process.env.OMNI_RUN_DIR).writeControl({ status: "done" });
  const out = await p;
  assert.equal(out.status, "done");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/run-cli.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `scripts/run.mjs`**

```js
#!/usr/bin/env node
/**
 * The durable unattended runner. A standalone CLI that owns one multi-day pi run:
 * it creates (or --resume's) a run ledger, points the pi omni-run extension at it via
 * OMNI_RUN_DIR, sets the explicit goal, enables the goal keeper, and then BLOCKS until the
 * run's status becomes "done" (or it is stopped) — it never exits on a mere settle. The GUI
 * (desktop or browser) is a separate, read-only observer of the same server; it does not own
 * this process.
 *
 *   node scripts/run.mjs --cwd <dir> --goal "…" [--goal-file f] [--resume <run-id>]
 *        [--provider p] [--model id] [--thinking lvl] [--max-seconds N] [--port N]
 */
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp as realCreateApp } from "../server/index.mjs";
import { RunLedger } from "../server/run-ledger.mjs";
import { CONFIG } from "../server/config.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export async function runUnattended({ cwd, goal, provider, model, thinking, runId, runsRoot = CONFIG.runsDir, maxSeconds = 0, port = 4400, createApp = realCreateApp, pollMs = 2000, out = console.log }) {
  mkdirSync(runsRoot, { recursive: true });
  const ledger = runId ? RunLedger.open(join(runsRoot, runId)) : RunLedger.create({ runsRoot, goalText: goal || "", sessionFile: "" });
  process.env.OMNI_RUN_DIR = ledger.dir;
  ledger.writeControl({ status: "running" });
  out(`run ${ledger.runId} · ledger ${ledger.dir}`);

  const app = await createApp({ port, host: "127.0.0.1", lan: false, cwd, autoStartPi: false, ...(provider ? { piProvider: provider } : {}), ...(model ? { piModel: model } : {}) });
  await app.listen();
  const pi = app.startPi(cwd);
  // Mirror pi's session file into the ledger so a restart resumes it.
  app.bus.on("event", (ev) => { if (ev.kind === "session" && ev.harness === "pi" && ev.owned && ev.file) { ledger.writeControl({ sessionFile: ev.file }); if (app.pi) app.pi.resumeFile = ev.file; } });

  await pi.waitReady();
  if (thinking) await pi.setThinking(thinking).catch(() => {});
  const goalText = ledger.goalText() || goal || "";
  if (goalText) {
    app.keeper.setExplicitGoal(pi.sid, goalText);
    app.keeper.setConfig({ ...app.keeper.config, enabled: true });
    app.keeper.startHeartbeat?.();
    if (!runId) await pi.prompt(goalText); // first launch kicks off the work; a resume relies on the heartbeat
  }

  const started = Date.now();
  return await new Promise((resolveRun) => {
    const timer = setInterval(() => {
      const ctrl = ledger.readControl();
      if (ctrl.status === "done" || ctrl.status === "stopped") { clearInterval(timer); app.close(); resolveRun({ runId: ledger.runId, status: ctrl.status }); return; }
      if (maxSeconds > 0 && Date.now() - started > maxSeconds * 1000) { clearInterval(timer); ledger.writeControl({ status: "stopped" }); app.close(); resolveRun({ runId: ledger.runId, status: "stopped" }); }
    }, pollMs);
    timer.unref?.();
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d; };
  const goalFile = arg("--goal-file");
  const goal = goalFile ? readFileSync(goalFile, "utf8") : arg("--goal", "");
  const runId = arg("--resume");
  if (!runId && !goal.trim()) { console.error("usage: node scripts/run.mjs --cwd <dir> --goal \"…\" | --goal-file f | --resume <run-id> [--provider p] [--model id] [--thinking lvl] [--max-seconds N]"); process.exit(1); }
  process.on("uncaughtException", (e) => console.error("uncaughtException", e?.stack || e));
  process.on("unhandledRejection", (e) => console.error("unhandledRejection", e?.stack || e));
  const r = await runUnattended({ cwd: resolve(arg("--cwd", process.cwd())), goal, runId, provider: arg("--provider"), model: arg("--model"), thinking: arg("--thinking"), maxSeconds: Number(arg("--max-seconds", 0)), port: Number(arg("--port", 4400)) });
  console.log(`run ${r.runId} ended: ${r.status}`);
  process.exit(0);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/run-cli.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/run.mjs test/run-cli.test.mjs
git commit -m "feat(runner): durable unattended CLI — owns a run ledger, never exits on settle, resumable

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 18: Headless log — drop token deltas + rotate

**Files:**
- Modify: `scripts/headless.mjs` (the `if (log) appendFileSync(...)` at line 60)
- Test: `test/headless.test.mjs`

**Interfaces:**
- Changes: the event log skips high-frequency `delta`/token events and rotates past a size cap.

- [ ] **Step 1: Write failing test**

```js
// add to test/headless.test.mjs
import { logWorthKeeping } from "../scripts/headless.mjs";
test("token delta events are not written to the long-run log", () => {
  assert.equal(logWorthKeeping({ kind: "msg", phase: "delta" }), false);
  assert.equal(logWorthKeeping({ kind: "token" }), false);
  assert.equal(logWorthKeeping({ kind: "tool", phase: "end" }), true);
  assert.equal(logWorthKeeping({ kind: "status", streaming: false }), true);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/headless.test.mjs`
Expected: FAIL — `logWorthKeeping` not exported.

- [ ] **Step 3: Implement**

In `scripts/headless.mjs`, add and use:

```js
/** Keep structured checkpoints out of a multi-day log; drop per-token deltas. Pure. */
export function logWorthKeeping(ev) {
  if (ev.kind === "token") return false;
  if (ev.kind === "msg" && ev.phase === "delta") return false;
  if (ev.kind === "log" && ev.level === "delta") return false;
  return true;
}
```

Replace line 60 with:

```js
      if (log && logWorthKeeping(ev)) appendFileSync(log, `${JSON.stringify(ev)}\n`);
```

(Rotation for the long-run log is owned by the durable runner's `events.jsonl` via `RunLedger.appendEvent`; the one-shot headless log is bounded in practice by dropping deltas. No extra rotation needed here.)

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/headless.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/headless.mjs test/headless.test.mjs
git commit -m "fix(headless): drop per-token deltas from the event log so it doesn't grow to GBs

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 19: External config — DeepSeek context, httpIdleTimeout, docs; full suite

**Files:**
- Modify: `README.md` (a short "Unattended runs" section documenting `scripts/run.mjs`, `OMNI_RUN_DIR`, and the required `node scripts/install.mjs`)
- Manual (documented, not committed — these are the user's local files): `~/.pi/agent/models.json` DeepSeek `contextWindow`, `~/.pi/agent/settings.json` `httpIdleTimeoutMs`.
- Test: full suite.

**Interfaces:** none (docs + verification).

- [ ] **Step 1: Document the unattended workflow in README.md**

Add a section:

```markdown
### Unattended multi-day runs

`node scripts/run.mjs --cwd <project> --goal "…"` starts a durable run: it keeps one
pi session alive for days, re-engaging it toward the goal, surviving crashes (it resumes
the same session), compacting without losing the goal, and offloading huge tool output.
State lives in `vault/Runs/<run-id>/` (`run.json`, `ledger.md`, `events.jsonl`, `artifacts/`).
Resume after a reboot with `--resume <run-id>`. The desktop/browser GUI is a read-only
observer — open `http://127.0.0.1:4400` to watch; closing it never stops the run.

Run `node scripts/install.mjs` once first so pi loads the `omni-run` extension
(context re-injection + durable compaction) and the recovering model fallback.

For weak small-context models, set in `~/.pi/agent/settings.json` a longer
`httpIdleTimeoutMs` (e.g. 600000) coordinated below Omni's `stallMs`, and make sure each
model's `contextWindow` in `~/.pi/agent/models.json` matches reality (DeepSeek V4 Flash is
1.3M; the chat-dated DeepSeek is 128k — a wrong value makes pi compact too late or too often).
```

- [ ] **Step 2: Run the full suite**

Run: `npm test`
Expected: PASS (all existing + new tests). Fix any regressions before committing.

- [ ] **Step 3: Verify the extension install end-to-end (manual, documented)**

Run: `node scripts/install.mjs` then `ls ~/.pi/agent/extensions` (PowerShell: `Get-ChildItem $env:USERPROFILE\.pi\agent\extensions`)
Expected: `omni-run.ts`, `omni-run-lib.mjs`, `omni-fallback.ts`, `omni-fallback-lib.mjs` present; `omni-agent.json` `vault`/`root` point at THIS checkout.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: unattended multi-day runs (scripts/run.mjs, run ledger, install, context/timeout knobs)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-review

**Spec coverage** — §5.1 pi-rpc survival/resume/watchdog → Tasks 2,4; §5.2 process guards → Task 10; §5.3 keeper → Tasks 8,9,11; §5.4 growth bounds (history/log/SSE) → Tasks 5,18,6; §5.5 durable runner → Task 17; §6.1 compaction → Tasks 12,13; §6.2 context re-injection → Tasks 12,13; §6.3 tool-result offload → Tasks 12,13; §6.4 recovering fallback → Task 14; §6.5 progress capture → Task 13 (ledger writes) + the extension's tool_result/offload; §7 external config/install → Tasks 16,19; §8 fail-open principle → enforced in Tasks 4,8. The run-ledger contract §4 → Task 1. All spec sections map to a task. (Note: §6.5 "milestone auto-append to ledger.md by the extension" is partially covered — the extension writes artifacts and the supervisor writes counters; a dedicated model-driven milestone writer is deliberately left to the agent writing `ledger.md` via its normal file tools, since the extension cannot reliably infer milestones. Called out here so a reviewer can accept this scoping.)

**Placeholder scan** — no "TBD"/"handle edge cases"; each code step has concrete code. Task 11's wiring prose includes an explicit invariant plus the exact bus-listener code to satisfy it.

**Type consistency** — `RunLedger` methods (`readControl`/`writeControl`/`goalText`/`readLedgerMd`/`writeLedgerMd`/`appendEvent`) are used identically in Tasks 1,11,13,17. `restartDelay`/`nextRestartState`/`stalled` signatures match between Task 3 and Task 4. `renderContextBlock`/`renderCompactionSummary`/`shouldOffload`/`offloadReference`/`sha256Hex` match between Task 12 and Task 13. `nextModelOnHealthy` matches between Task 14's lib and test. `OMNI_RUN_DIR` is set in Task 17 and read in Task 13.

**Review Focus coverage** — corrupt run.json → Task 1 test; restart storm → Task 3 (`restartDelay` cap + `shouldKeepRestarting`) + Task 4; judge non-JSON forever → Task 8 fail-open test; oversized tool result → Task 12 `shouldOffload` test + Task 13 wiring; multi-MB session file → Task 5 `readTail` test. All five pinned.
