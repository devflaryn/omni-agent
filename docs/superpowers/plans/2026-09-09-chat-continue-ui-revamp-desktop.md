# Continue any chat, Codex-style UI, thinking meter, desktop window — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Omni continue or fork any pi / Claude Code chat from its own composer, rebuild the front end as a three-column Codex-style app with a live "Thinking… 11m 20s · 15k tokens · 86 tok/sec" meter, and launch it as a console-less pywebview window that other LAN devices can still open in a browser.

**Architecture:** The Node server (built-ins only) gains one `continue` route driven by a pure `planContinue` decision function, a `fork` option on the Claude runner, and `clone` on the pi RPC wrapper. The UI is rewritten as ES modules (`lib.js` pure and unit-tested; `transcript.js`, `composer.js`, `sidebar.js`, `panel.js` DOM). A Python launcher starts the server hidden and opens a pywebview window.

**Tech Stack:** Node ≥ 22 (no npm deps, `node --test`), vanilla ES modules served statically, Python 3.11 + pywebview (WebView2) for the desktop window, Windows 11 primary.

**Spec:** `docs/superpowers/specs/2026-09-09-chat-continue-ui-revamp-desktop-design.md`

## Global Constraints

- Node built-ins only; no `npm install`, no build step. UI files are served as-is from `ui/`.
- Tests run with `npm test` (`node --test`), Windows paths (`C:\...`) appear in fixtures.
- The project is not a git repo today. Task 0 initializes one so every later task can commit; if the user declines, replace each "Commit" step with "run `npm test`".
- Live-terminal threshold: `cfg.liveWindowMs` default `30000`.
- Copy: composer placeholder is exactly `Do anything`; meter formats are `Thinking… 11m 20s · 15k tokens · 86 tok/sec`, `Thought for …`, `Worked for …`, `Replied in …`.
- Desktop launcher runs the server with `--lan` and opens `http://127.0.0.1:<port>/?desktop=1`.

## File map

| File | Responsibility |
|---|---|
| `server/continue.mjs` (new) | `planContinue(session, ctx)` pure decision; no I/O |
| `server/claude-runner.mjs` | `fork` option, pending-sid re-key on `system.init`, injectable `spawn` |
| `server/pi-rpc.mjs` | `clone()`, `waitReady()` |
| `server/index.mjs` | `composePrompt`, `POST /api/sessions/:sid/continue`, `POST /api/shutdown`, static `ui/*.js`, `forkedFrom` in registry |
| `server/config.mjs` | `liveWindowMs` |
| `ui/lib.js` (new) | pure helpers: `md`, `fmtDuration`, `tokRate`, `editedFiles`, `groupToolRuns`, … |
| `ui/transcript.js` (new) | events → turns, work groups, meter, edited-files card |
| `ui/composer.js` (new) | composer card factory |
| `ui/sidebar.js` (new) | session rail |
| `ui/panel.js` (new) | right panel tabs: Tokens, Memory, Graph, Files |
| `ui/app.js` | boot, state, SSE, routing, continue flow |
| `ui/index.html`, `ui/styles.css` | shell and design |
| `desktop/omni_desktop.pyw` (new), `Omni Agent.cmd` (new) | desktop launcher |
| `test/continue.test.mjs`, `test/claude-runner.test.mjs`, `test/ui.test.mjs`, `test/desktop.test.mjs` (new), `test/server.test.mjs` | tests |

---

### Task 0: Baseline under git

**Files:** none changed.

- [ ] **Step 1: Initialize the repo and record the baseline**

```powershell
git init
git add -A
git commit -m "chore: baseline before chat-continue / UI revamp / desktop window"
```

- [ ] **Step 2: Confirm the suite is green before touching anything**

Run: `npm test`
Expected: all existing tests pass (jsonl, normalize, tokens, memory, tailer, graph, server).

---

### Task 1: `planContinue` decision function

**Files:**
- Create: `server/continue.mjs`
- Create: `test/continue.test.mjs`
- Modify: `server/config.mjs` (add `liveWindowMs`)

**Interfaces:**
- Produces: `planContinue(session, { now, liveWindowMs, piAlive, piSid, piStreaming, claudeAlive, forceFork })` returning one of
  - `{ action: "error", status, error }`
  - `{ action: "claude", resume, fork, cwd }`
  - `{ action: "pi-prompt" }` (Omni's pi is already on this session)
  - `{ action: "pi-switch", file, clone, cwd, start }`
- `isLiveInTerminal(session, now, liveWindowMs)` exported for the UI caption logic to mirror.

- [ ] **Step 1: Write the failing tests**

```js
// test/continue.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { planContinue, isLiveInTerminal } from "../server/continue.mjs";

const now = 1_800_000_000_000;
const claudeClosed = { sid: "claude:abc", harness: "claude", owned: false, streaming: false, lastActivity: now - 600_000, mtime: now - 600_000, cwd: "C:\\p", file: "C:\\c\\abc.jsonl" };
const claudeLive = { ...claudeClosed, lastActivity: now - 5_000 };
const piClosed = { sid: "pi:111", harness: "pi", owned: false, streaming: false, lastActivity: now - 600_000, mtime: now - 600_000, cwd: "C:\\p", file: "C:\\s\\x_111.jsonl" };
const piLive = { ...piClosed, streaming: true };

test("unknown session is a 404", () => {
  assert.deepEqual(planContinue(null, { now }), { action: "error", status: 404, error: "unknown session" });
});

test("closed Claude session resumes in place", () => {
  assert.deepEqual(planContinue(claudeClosed, { now }), { action: "claude", resume: "abc", fork: false, cwd: "C:\\p" });
});

test("Claude session active in a terminal is forked", () => {
  const p = planContinue(claudeLive, { now });
  assert.equal(p.action, "claude");
  assert.equal(p.fork, true);
});

test("forceFork forks even a closed Claude session", () => {
  assert.equal(planContinue(claudeClosed, { now, forceFork: true }).fork, true);
});

test("a Claude run already alive in Omni is a 409", () => {
  assert.equal(planContinue(claudeClosed, { now, claudeAlive: true }).status, 409);
});

test("Omni-owned Claude session that ended resumes in place (never forks)", () => {
  const owned = { ...claudeLive, owned: true };
  assert.equal(planContinue(owned, { now }).fork, false);
});

test("pi: Omni's pi already on this session just prompts", () => {
  assert.deepEqual(planContinue(piClosed, { now, piAlive: true, piSid: "pi:111" }), { action: "pi-prompt" });
});

test("pi: closed session switches without clone; starts pi when it is not running", () => {
  assert.deepEqual(planContinue(piClosed, { now, piAlive: false }), { action: "pi-switch", file: "C:\\s\\x_111.jsonl", clone: false, cwd: "C:\\p", start: true });
  assert.equal(planContinue(piClosed, { now, piAlive: true, piSid: "pi:999" }).start, false);
});

test("pi: session live in a terminal is cloned", () => {
  assert.equal(planContinue(piLive, { now, piAlive: true, piSid: "pi:999" }).clone, true);
});

test("pi: busy Omni pi is a 409", () => {
  assert.equal(planContinue(piClosed, { now, piAlive: true, piSid: "pi:999", piStreaming: true }).status, 409);
});

test("pi: no file is a 400", () => {
  assert.equal(planContinue({ ...piClosed, file: null }, { now }).status, 400);
});

test("isLiveInTerminal uses the newer of lastActivity and mtime", () => {
  assert.equal(isLiveInTerminal({ owned: false, streaming: false, lastActivity: now - 100_000, mtime: now - 1_000 }, now, 30_000), true);
  assert.equal(isLiveInTerminal({ owned: false, streaming: false, lastActivity: now - 100_000, mtime: now - 100_000 }, now, 30_000), false);
  assert.equal(isLiveInTerminal({ owned: true, streaming: true, lastActivity: now }, now, 30_000), false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/continue.test.mjs`
Expected: FAIL, `Cannot find module '../server/continue.mjs'`.

- [ ] **Step 3: Implement `server/continue.mjs`**

```js
/**
 * Decides how Omni attaches to a session the user typed into.
 * Pure: no I/O, so it is unit-tested cell by cell.
 *
 *   Claude Code   terminal still active → --resume --fork-session   closed → --resume
 *   pi            terminal still active → switch + clone            closed → switch
 */
const idOf = (sid) => String(sid).split(":").slice(1).join(":");

export function isLiveInTerminal(s, now = Date.now(), liveWindowMs = 30000) {
  if (!s || s.owned) return false;
  if (s.streaming) return true;
  const last = Math.max(s.lastActivity || 0, s.mtime || 0);
  return now - last < liveWindowMs;
}

export function planContinue(s, { now = Date.now(), liveWindowMs = 30000, piAlive = false, piSid = null, piStreaming = false, claudeAlive = false, forceFork = false } = {}) {
  if (!s) return { action: "error", status: 404, error: "unknown session" };
  const live = isLiveInTerminal(s, now, liveWindowMs);
  if (s.harness === "claude") {
    if (claudeAlive) return { action: "error", status: 409, error: "that Claude session is already running in Omni; stop it first" };
    return { action: "claude", resume: idOf(s.sid), fork: !!(forceFork || live), cwd: s.cwd || null };
  }
  if (s.harness === "pi") {
    if (piAlive && piSid === s.sid && !forceFork) return { action: "pi-prompt" };
    if (piAlive && piStreaming) return { action: "error", status: 409, error: "pi is busy; stop it or wait" };
    if (!s.file) return { action: "error", status: 400, error: "session file unknown" };
    return { action: "pi-switch", file: s.file, clone: !!(forceFork || live), cwd: s.cwd || null, start: !piAlive };
  }
  return { action: "error", status: 400, error: `cannot continue a ${s.harness} session` };
}
```

- [ ] **Step 4: Add `liveWindowMs` to config**

In `server/config.mjs`, inside the `CONFIG` object after `graphBudgetTokens`:

```js
  /** A non-owned session file touched within this window counts as "still open in a terminal" → fork instead of resume. */
  liveWindowMs: fc.liveWindowMs || 30000,
```

- [ ] **Step 5: Run the tests**

Run: `node --test test/continue.test.mjs`
Expected: 12 passing.

- [ ] **Step 6: Commit**

```powershell
git add server/continue.mjs server/config.mjs test/continue.test.mjs
git commit -m "feat(server): planContinue decides resume vs fork for pi and Claude sessions"
```

---

### Task 2: Claude runner `fork` option with pending-sid re-key

**Files:**
- Modify: `server/claude-runner.mjs`
- Create: `test/claude-runner.test.mjs`

**Interfaces:**
- `new ClaudeRunner({ bin, bus, spawn? })` — `spawn` defaults to `node:child_process.spawn`; tests inject a fake.
- `run({ prompt, cwd, model, resume, fork, forkedFrom, appendSystem, autonomous, maxTurns, allowedTools })` → `{ sid, sessionId, pending }`. With `fork: true`, `sid` is `claude:pending-<8 hex>` and `sessionId` is `null` until the `system.init` line arrives; then the run is re-keyed and a `session` event with `forkedFrom` is emitted.

- [ ] **Step 1: Write the failing tests**

```js
// test/claude-runner.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { Bus } from "../server/bus.mjs";
import { ClaudeRunner } from "../server/claude-runner.mjs";

function fakeSpawn(record) {
  return (bin, args, opts) => {
    const p = new EventEmitter();
    p.stdout = new PassThrough(); p.stderr = new PassThrough(); p.stdin = new PassThrough();
    p.pid = 42; p.kill = () => p.emit("exit", 0);
    record.push({ bin, args, opts, proc: p });
    return p;
  };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("resume without fork keeps the session id and passes --resume", () => {
  const calls = [], bus = new Bus();
  const r = new ClaudeRunner({ bin: "claude", bus, spawn: fakeSpawn(calls) });
  const out = r.run({ prompt: "hi", cwd: "C:\\p", resume: "abc" });
  assert.equal(out.sid, "claude:abc");
  assert.equal(out.pending, false);
  const a = calls[0].args;
  assert.ok(a.includes("--resume") && a[a.indexOf("--resume") + 1] === "abc");
  assert.ok(!a.includes("--fork-session"));
  assert.ok(!a.includes("--session-id"));
});

test("fork passes --fork-session, starts pending, re-keys on system.init and announces forkedFrom", async () => {
  const calls = [], bus = new Bus(), events = [];
  bus.on("event", (ev) => events.push(ev));
  const r = new ClaudeRunner({ bin: "claude", bus, spawn: fakeSpawn(calls) });
  const out = r.run({ prompt: "continue please", cwd: "C:\\p", resume: "abc", fork: true, forkedFrom: "claude:abc" });
  assert.match(out.sid, /^claude:pending-[0-9a-f]{8}$/);
  assert.equal(out.pending, true);
  assert.ok(calls[0].args.includes("--fork-session"));
  assert.equal(events.length, 0, "nothing announced before init");
  calls[0].proc.stdout.write(`${JSON.stringify({ type: "system", subtype: "init", session_id: "new-1", cwd: "C:\\p", model: "claude-opus-5" })}\n`);
  await sleep(20);
  assert.ok(r.runs.has("claude:new-1"), "run re-keyed");
  assert.ok(!r.runs.has(out.sid), "pending key removed");
  const sess = events.find((e) => e.kind === "session" && e.forkedFrom === "claude:abc");
  assert.ok(sess, "session event carries forkedFrom");
  assert.equal(sess.sid, "claude:new-1");
  assert.ok(events.some((e) => e.kind === "msg" && e.role === "user" && e.sid === "claude:new-1"), "user prompt echoed under the new sid");
  assert.ok(events.every((e) => !String(e.sid).includes("pending")), "no event ever uses the pending sid");
});

test("a pending fork that exits before init reports the failure on the source session", async () => {
  const calls = [], bus = new Bus(), events = [];
  bus.on("event", (ev) => events.push(ev));
  const r = new ClaudeRunner({ bin: "claude", bus, spawn: fakeSpawn(calls) });
  r.run({ prompt: "x", cwd: "C:\\p", resume: "abc", fork: true, forkedFrom: "claude:abc" });
  calls[0].proc.emit("exit", 1);
  await sleep(10);
  const err = events.find((e) => e.kind === "msg" && e.role === "system");
  assert.equal(err.sid, "claude:abc");
  assert.match(err.blocks[0].text, /fork failed/i);
});

test("owns() ignores pending runs and matches by session id", () => {
  const calls = [], bus = new Bus();
  const r = new ClaudeRunner({ bin: "claude", bus, spawn: fakeSpawn(calls) });
  r.run({ prompt: "x", cwd: "C:\\p", resume: "abc", fork: true });
  r.run({ prompt: "y", cwd: "C:\\p", resume: "def" });
  assert.equal(r.owns("C:\\c\\DEF.jsonl"), true);
  assert.equal(r.owns("C:\\c\\zzz.jsonl"), false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/claude-runner.test.mjs`
Expected: FAIL (`spawn` option ignored → real `claude` spawned or `pending` undefined).

- [ ] **Step 3: Rewrite `server/claude-runner.mjs`**

```js
/**
 * Runs Claude Code tasks from Omni:
 *   claude -p --output-format stream-json --include-partial-messages --verbose ...
 * The prompt goes in on stdin (no shell quoting). A fresh run gets a session id we
 * choose (`--session-id`). A resume keeps the id. A fork (`--resume X --fork-session`)
 * only learns its id from the `system.init` line, so it starts under a pending sid
 * and announces nothing until then.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { createLineSplitter } from "./jsonl.mjs";
import { normalizeClaudeStream } from "./normalize.mjs";

export class ClaudeRunner {
  constructor({ bin = "claude", bus, spawn = nodeSpawn }) {
    this.bin = bin;
    this.bus = bus;
    this.spawn = spawn;
    this.runs = new Map(); // sid -> run
  }

  owns(file) {
    const id = basename(String(file || ""), ".jsonl").toLowerCase();
    for (const [, r] of this.runs) if (r.sessionId && r.sessionId.toLowerCase() === id && r.alive) return true;
    return false;
  }

  list() {
    return [...this.runs.values()].map(({ proc, ...r }) => r);
  }

  run({ prompt, cwd, model, resume, fork = false, forkedFrom = null, appendSystem, autonomous = true, maxTurns, allowedTools }) {
    if (!prompt?.trim()) throw new Error("empty prompt");
    const pending = !!(resume && fork);
    const sessionId = pending ? null : resume || randomUUID();
    const sid = pending ? `claude:pending-${randomUUID().slice(0, 8)}` : `claude:${sessionId}`;
    if (!pending && this.runs.get(sid)?.alive) throw new Error("that Claude session is already running");
    const args = ["-p", "--output-format", "stream-json", "--include-partial-messages", "--verbose"];
    if (resume) { args.push("--resume", resume); if (fork) args.push("--fork-session"); }
    else args.push("--session-id", sessionId);
    if (model) args.push("--model", model);
    if (autonomous) args.push("--dangerously-skip-permissions");
    if (maxTurns) args.push("--max-turns", String(maxTurns));
    if (allowedTools) args.push("--allowedTools", allowedTools);
    if (appendSystem) args.push("--append-system-prompt", appendSystem);

    const proc = this.spawn(this.bin, args, { cwd, windowsHide: true, shell: false, env: { ...process.env, OMNI_AGENT: "1" } });
    const run = { sid, sessionId, cwd, model: model || null, resume: !!resume, fork: !!fork, forkedFrom, pending, startedAt: Date.now(), alive: true, exitCode: null, cost: 0, proc, prompt: prompt.slice(0, 500) };
    this.runs.set(sid, run);
    const ctx = { sid, harness: "claude" };
    const title = prompt.replace(/\s+/g, " ").slice(0, 80);

    const announce = () => {
      this.bus.emit({ ...ctx, kind: "session", ts: Date.now(), owned: true, cwd, sessionId: run.sessionId, model: model || null, title, forkedFrom: run.forkedFrom || undefined });
      this.bus.emit({ ...ctx, kind: "status", ts: Date.now(), streaming: true });
      this.bus.emit({ ...ctx, kind: "msg", ts: Date.now(), id: `u-${Date.now()}`, role: "user", live: true, blocks: [{ type: "text", text: prompt }] });
    };
    if (!pending) announce();

    let sawResult = false;
    const splitter = createLineSplitter((line) => {
      let obj;
      try { obj = JSON.parse(line); } catch { return run.pending ? undefined : this.bus.emit({ ...ctx, kind: "log", ts: Date.now(), level: "raw", text: line.slice(0, 2000) }); }
      if (run.pending && obj.type === "system" && obj.subtype === "init" && obj.session_id) {
        this.runs.delete(run.sid);
        run.sessionId = obj.session_id;
        run.sid = ctx.sid = `claude:${obj.session_id}`;
        run.pending = false;
        this.runs.set(run.sid, run);
        announce();
      }
      if (run.pending) return; // nothing to attribute yet
      if (obj.type === "result") { sawResult = true; run.cost = obj.total_cost_usd || 0; }
      for (const ev of normalizeClaudeStream(obj, ctx)) this.bus.emit(ev);
    });
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (c) => splitter.push(c));
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (t) => this.bus.emit({ sid: run.pending ? run.forkedFrom || sid : ctx.sid, harness: "claude", kind: "log", ts: Date.now(), level: "stderr", text: t.slice(0, 4000) }));
    const fail = (text) => this.bus.emit({ sid: run.pending ? run.forkedFrom || sid : ctx.sid, harness: "claude", kind: "msg", ts: Date.now(), id: `err-${Date.now()}`, role: "system", live: true, blocks: [{ type: "text", text }] });
    proc.on("error", (e) => fail(`claude spawn failed: ${e.message}`));
    proc.on("exit", (code) => {
      splitter.flush();
      run.alive = false;
      run.exitCode = code;
      run.endedAt = Date.now();
      if (run.pending) { fail(`Fork failed: claude exited with code ${code} before reporting a session id (see omni.log / stderr)`); return; }
      if (!sawResult) this.bus.emit({ ...ctx, kind: "run", ts: Date.now(), phase: "end", isError: code !== 0, text: `claude exited with code ${code}` });
      this.bus.emit({ ...ctx, kind: "status", ts: Date.now(), streaming: false });
    });
    proc.stdin.on("error", () => {});
    proc.stdin.end(prompt);
    return { sid, sessionId, pending };
  }

  abort(sid) {
    const r = this.runs.get(sid);
    if (!r?.alive) return false;
    try { r.proc.kill(); } catch { /* ignore */ }
    return true;
  }

  stopAll() {
    for (const [sid] of this.runs) this.abort(sid);
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/claude-runner.test.mjs`
Expected: 4 passing.

- [ ] **Step 5: Run the whole suite** (`server.test.mjs` constructs `ClaudeRunner` without `spawn`; must still pass)

Run: `npm test`
Expected: all passing.

- [ ] **Step 6: Commit**

```powershell
git add server/claude-runner.mjs test/claude-runner.test.mjs
git commit -m "feat(server): Claude runner can fork a session (--fork-session) with pending-sid re-key"
```

---

### Task 3: pi RPC `clone()` and `waitReady()`

**Files:**
- Modify: `server/pi-rpc.mjs`

**Interfaces:**
- `pi.clone()` → sends `{ type: "clone" }`, refreshes state, returns the RPC response. After it, `pi.sid` is the new session's sid.
- `pi.waitReady()` → promise resolving to the `get_state` data once the child answered; rejects if the child died first.

- [ ] **Step 1: Add the methods**

In `server/pi-rpc.mjs`, in `start()` replace

```js
    this.refreshState().catch(() => {});
    return this;
```

with

```js
    this.ready = this.refreshState();
    this.ready.catch(() => {});
    return this;
```

and add to the class, next to `switchSession`:

```js
  /** Resolves when the child has answered get_state (its session id is known). */
  waitReady() { return this.ready || Promise.reject(new Error("pi is not running")); }
  /** Copies the current session into a new file and switches to it (the original stays untouched). */
  async clone() { const r = await this.send({ type: "clone" }); await this.refreshState(); return r; }
```

- [ ] **Step 2: Run the suite** (no pi child in tests; this only checks syntax and imports)

Run: `npm test`
Expected: all passing.

- [ ] **Step 3: Commit**

```powershell
git add server/pi-rpc.mjs
git commit -m "feat(server): pi clone() and waitReady()"
```

---

### Task 4: `continue` and `shutdown` routes, shared prompt composition, static modules

**Files:**
- Modify: `server/index.mjs`
- Modify: `test/server.test.mjs`

**Interfaces:**
- `POST /api/sessions/:sid/continue` body `{ message, memory?, graph?, model?, autonomous?, images?, fork? }` → `{ sid, forked, forkedFrom, pending }`; errors carry the status from `planContinue`.
- `POST /api/shutdown` (loopback only) → `{ ok: true }` then the process exits.
- Static: any `ui/<name>.js|.mjs|.css|.svg|.png|.ico` is served.
- `createApp(overrides)` accepts `claudeSpawn` (forwarded to `ClaudeRunner`).
- `session` events' `forkedFrom` is stored in the registry and appears in `/api/state` sessions.

- [ ] **Step 1: Write the failing tests** (append to `test/server.test.mjs`; also change the `createApp` call so the runner is stubbed)

Replace the `createApp(...)` line with:

```js
const claudeCalls = [];
const fakeSpawn = (bin, args, opts) => {
  const p = new EventEmitter();
  p.stdout = new PassThrough(); p.stderr = new PassThrough(); p.stdin = new PassThrough();
  p.pid = 7; p.kill = () => p.emit("exit", 0);
  claudeCalls.push({ bin, args, opts, proc: p });
  return p;
};
// liveWindowMs: 0 — the fixture files were written a moment ago and would otherwise count as "open in a terminal".
const app = await createApp({ port: 0, vaultDir: join(base, "vault"), piSessionsDir: join(base, "pi-sessions"), claudeProjectsDir: join(base, "claude-projects"), autoStartPi: false, cwd: base, claudeSpawn: fakeSpawn, liveWindowMs: 0 });
```

and add the imports at the top:

```js
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
```

Append the tests:

```js
const post = (path, body) => api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("continue: unknown session → 404, empty message → 400", async () => {
  const r1 = await fetch(`http://127.0.0.1:${port}/api/sessions/${encodeURIComponent("claude:nope")}/continue`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "x" }) });
  assert.equal(r1.status, 404);
  const r2 = await fetch(`http://127.0.0.1:${port}/api/sessions/${encodeURIComponent("claude:eb130a94-0000-4000-8000-000000000000")}/continue`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "  " }) });
  assert.equal(r2.status, 400);
});

test("continue: a closed Claude session resumes in place with --resume", async () => {
  const r = await post(`/api/sessions/${encodeURIComponent("claude:eb130a94-0000-4000-8000-000000000000")}/continue`, { message: "go on", memory: false, graph: false });
  assert.equal(r.sid, "claude:eb130a94-0000-4000-8000-000000000000");
  assert.equal(r.forked, false);
  const a = claudeCalls.at(-1).args;
  assert.equal(a[a.indexOf("--resume") + 1], "eb130a94-0000-4000-8000-000000000000");
  assert.ok(!a.includes("--fork-session"));
  assert.equal(claudeCalls.at(-1).opts.cwd, "C:\\Users\\berat\\Desktop\\proj");
  claudeCalls.at(-1).proc.emit("exit", 0);
});

test("continue: fork:true forces --fork-session and returns a pending sid", async () => {
  const r = await post(`/api/sessions/${encodeURIComponent("claude:eb130a94-0000-4000-8000-000000000000")}/continue`, { message: "branch here", fork: true, memory: false });
  assert.equal(r.forked, true);
  assert.equal(r.forkedFrom, "claude:eb130a94-0000-4000-8000-000000000000");
  assert.match(r.sid, /pending/);
  assert.ok(claudeCalls.at(-1).args.includes("--fork-session"));
  claudeCalls.at(-1).proc.stdout.write(`${JSON.stringify({ type: "system", subtype: "init", session_id: "forked-1", cwd: "C:\\p", model: "m" })}\n`);
  await sleep(50);
  const st = await api("/api/state");
  const forked = st.sessions.find((s) => s.sid === "claude:forked-1");
  assert.equal(forked?.forkedFrom, "claude:eb130a94-0000-4000-8000-000000000000");
  claudeCalls.at(-1).proc.emit("exit", 0);
});

test("static route serves ES modules from ui/", async () => {
  const r = await fetch(`http://127.0.0.1:${port}/lib.js`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /javascript/);
});
```

(`ui/lib.js` is created in Task 5; until then the last test fails with 404, which is expected in Step 2.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/server.test.mjs`
Expected: the four new tests FAIL (404 for continue, 404 for lib.js).

- [ ] **Step 3: Implement in `server/index.mjs`**

Add the import:

```js
import { planContinue } from "./continue.mjs";
```

Change the runner construction to forward the stub:

```js
  const claude = new ClaudeRunner({ bin: cfg.claudeBin, bus, spawn: cfg.claudeSpawn });
```

In the `bus.on("event", …)` listener, extend the session upsert:

```js
    if (ev.kind === "session") registry.upsert(ev.sid, { cwd: ev.cwd, title: ev.title, model: ev.model, file: ev.file, owned: ev.owned, streaming: ev.streaming, forkedFrom: ev.forkedFrom });
```

Replace `memoryPack` with a shared composer (keep `memoryPack` too, it is used by the pack route):

```js
  /** Memory pack + repo-graph context. Claude gets them as system prompt text, pi inline before the message. */
  async function composePrompt(harness, prompt, { memory, graph, dir }) {
    const parts = [];
    if (graph) { const g = await graphContext(prompt, dir); if (g) parts.push(harness === "claude" ? `Repo knowledge graph context (graphify):\n${g}` : g); }
    if (memory) { const pack = await memoryPack(prompt); if (pack) parts.push(harness === "claude" ? `Relevant durable memory from the user's Omni vault:\n${pack}` : pack); }
    if (harness === "claude") return { text: prompt, system: parts.join("\n\n") };
    return { text: parts.length ? `${parts.join("\n\n")}\n\n${prompt}` : prompt, system: "" };
  }

  async function continueSession(sid, body) {
    const s = registry.get(sid);
    const plan = planContinue(s, { liveWindowMs: cfg.liveWindowMs, piAlive: !!pi?.proc, piSid: pi?.sid, piStreaming: !!pi?.streaming, claudeAlive: !!claude.runs.get(sid)?.alive, forceFork: !!body.fork });
    if (plan.action === "error") throw Object.assign(new Error(plan.error), { status: plan.status });
    if (!body.message?.trim()) throw Object.assign(new Error("empty message"), { status: 400 });
    const dir = s.cwd || cfg.cwd;
    if (plan.action === "claude") {
      const p = await composePrompt("claude", body.message, { memory: body.memory, graph: body.graph, dir });
      const r = claude.run({ prompt: p.text, cwd: plan.cwd || cfg.cwd, resume: plan.resume, fork: plan.fork, forkedFrom: plan.fork ? sid : null, model: body.model, appendSystem: p.system, autonomous: body.autonomous !== false });
      return { sid: r.sid, pending: r.pending, forked: plan.fork, forkedFrom: plan.fork ? sid : null };
    }
    const p = await composePrompt("pi", body.message, { memory: body.memory, graph: body.graph, dir });
    if (plan.action === "pi-prompt") { await pi.prompt(p.text, { images: body.images }); return { sid: pi.sid, pending: false, forked: false, forkedFrom: null }; }
    if (plan.start) { startPi(plan.cwd || cfg.cwd); await pi.waitReady(); }
    await pi.switchSession(plan.file);
    if (plan.clone) {
      await pi.clone();
      bus.emit({ sid: pi.sid, harness: "pi", kind: "session", ts: Date.now(), owned: true, forkedFrom: sid, cwd: pi.cwd, file: pi.state?.sessionFile });
    }
    await pi.prompt(p.text, { images: body.images });
    return { sid: pi.sid, pending: false, forked: !!plan.clone, forkedFrom: plan.clone ? sid : null };
  }
```

Replace the static-file regex line with:

```js
      if (req.method === "GET" && /^\/[\w.-]+\.(js|mjs|css|svg|png|ico)$/.test(p)) {
```

and add `".mjs": "text/javascript; charset=utf-8"` to `MIME`.

Add the routes right after the `/history` route:

```js
      if (req.method === "POST" && (m = /^\/api\/sessions\/([^/]+)\/continue$/.exec(p))) {
        return send(res, 200, await continueSession(decodeURIComponent(m[1]), await readBody(req)));
      }
      if (req.method === "POST" && p === "/api/shutdown") {
        if (!isLocal(req)) return send(res, 403, { error: "local only" });
        send(res, 200, { ok: true });
        setTimeout(() => { close(); process.exit(0); }, 100);
        return;
      }
```

Make the pi and Claude prompt routes use the shared composer:

```js
          case "/api/pi/prompt": {
            const p0 = requirePi();
            if (!body.message?.trim()) return send(res, 400, { error: "empty" });
            const c = await composePrompt("pi", body.message, { memory: body.memory, graph: body.graph, dir: graphDirFor(p0.sid) });
            return send(res, 200, await p0.prompt(c.text, { images: body.images }));
          }
```

```js
      if (req.method === "POST" && p === "/api/claude/run") {
        const body = await readBody(req);
        const c = await composePrompt("claude", body.prompt || "", { memory: body.memory, graph: body.graph, dir: body.cwd || cfg.cwd });
        const appendSystem = [body.appendSystem || "", c.system].filter(Boolean).join("\n\n");
        const r = claude.run({ prompt: body.prompt, cwd: body.cwd || cfg.cwd, model: body.model, resume: body.resume, appendSystem, autonomous: body.autonomous !== false, maxTurns: body.maxTurns });
        return send(res, 200, r);
      }
```

Change the catch-all to honor error statuses:

```js
    } catch (e) {
      return send(res, e?.status || 500, { error: String(e?.message || e) });
    }
```

- [ ] **Step 4: Run the suite**

Run: `npm test`
Expected: everything passes except `static route serves ES modules` (404 until Task 5).

- [ ] **Step 5: Commit**

```powershell
git add server/index.mjs test/server.test.mjs
git commit -m "feat(server): POST /api/sessions/:sid/continue, /api/shutdown, shared prompt composition"
```

---

### Task 5: `ui/lib.js` pure helpers with tests

**Files:**
- Create: `ui/lib.js`
- Create: `test/ui.test.mjs`

**Interfaces (produces, all named exports):**
- `el(tag, cls?, text?)`, `esc(s)`, `fmtN(n)`, `ago(ts)`, `baseName(p)`, `groupLabel(ts, now?)`, `md(src)` — moved from `ui/app.js`.
- `fmtDuration(ms)` → `"12s" | "8m 4s" | "1h 02m"`.
- `tokRate(tokens, ms)` → integer tok/sec, `0` when either is 0.
- `estimateTokens(text)` → `ceil(len/4)`.
- `editStats(name, args)` → `{ path, added, removed } | null`.
- `editedFiles(calls)` → `{ files: [{path, added, removed}], added, removed }` (`calls` = `[{ name, args }]`).
- `groupToolRuns(items, now?)` → segments `{ kind:"text", item } | { kind:"work", items, startTs, endTs, open, durationMs }` where `items` = `[{ kind:"text" } | { kind:"tool", startTs, endTs|null }]`.
- `relPath(path, cwd)` → path with the cwd prefix removed and forward slashes.

- [ ] **Step 1: Write the failing tests**

```js
// test/ui.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { fmtDuration, tokRate, estimateTokens, editStats, editedFiles, groupToolRuns, relPath, md, groupLabel } from "../ui/lib.js";

test("fmtDuration", () => {
  assert.equal(fmtDuration(0), "0s");
  assert.equal(fmtDuration(12_400), "12s");
  assert.equal(fmtDuration(8 * 60_000 + 4_000), "8m 4s");
  assert.equal(fmtDuration(62 * 60_000), "1h 02m");
});

test("tokRate", () => {
  assert.equal(tokRate(15_000, 11 * 60_000 + 20_000), 22);
  assert.equal(tokRate(0, 1000), 0);
  assert.equal(tokRate(100, 0), 0);
});

test("estimateTokens", () => { assert.equal(estimateTokens("abcdefgh"), 2); assert.equal(estimateTokens(""), 0); });

test("editStats counts lines for Edit, Write, MultiEdit and pi's edit/write; ignores other tools", () => {
  assert.deepEqual(editStats("Edit", { file_path: "a.js", old_string: "x\ny", new_string: "x\ny\nz" }), { path: "a.js", added: 3, removed: 2 });
  assert.deepEqual(editStats("Write", { file_path: "b.js", content: "1\n2\n3" }), { path: "b.js", added: 3, removed: 0 });
  assert.deepEqual(editStats("MultiEdit", { file_path: "c.js", edits: [{ old_string: "a", new_string: "b\nc" }, { old_string: "", new_string: "d" }] }), { path: "c.js", added: 3, removed: 1 });
  assert.deepEqual(editStats("edit", { path: "d.py", oldText: "a\nb", newText: "a" }), { path: "d.py", added: 1, removed: 2 });
  assert.deepEqual(editStats("write", { path: "e.py", content: "q" }), { path: "e.py", added: 1, removed: 0 });
  assert.equal(editStats("Bash", { command: "ls" }), null);
  assert.equal(editStats("Edit", null), null);
});

test("editedFiles aggregates per path and totals", () => {
  const r = editedFiles([
    { name: "Edit", args: { file_path: "a.js", old_string: "1", new_string: "1\n2" } },
    { name: "Edit", args: { file_path: "a.js", old_string: "x\ny\nz", new_string: "x" } },
    { name: "Write", args: { file_path: "b.js", content: "n\nm" } },
    { name: "Read", args: { file_path: "c.js" } },
  ]);
  assert.deepEqual(r.files, [{ path: "a.js", added: 3, removed: 4 }, { path: "b.js", added: 2, removed: 0 }]);
  assert.equal(r.added, 5); assert.equal(r.removed, 4);
});

test("groupToolRuns folds consecutive tools into work groups and text breaks them", () => {
  const segs = groupToolRuns([
    { kind: "tool", startTs: 1000, endTs: 3000 },
    { kind: "tool", startTs: 3000, endTs: 9000 },
    { kind: "text" },
    { kind: "tool", startTs: 10_000, endTs: null },
  ], 15_000);
  assert.equal(segs.length, 3);
  assert.equal(segs[0].kind, "work"); assert.equal(segs[0].items.length, 2); assert.equal(segs[0].durationMs, 8000); assert.equal(segs[0].open, false);
  assert.equal(segs[1].kind, "text");
  assert.equal(segs[2].open, true); assert.equal(segs[2].durationMs, 5000);
});

test("relPath strips the cwd and normalizes slashes", () => {
  assert.equal(relPath("C:\\Users\\b\\proj\\ui\\app.js", "C:\\Users\\b\\proj"), "ui/app.js");
  assert.equal(relPath("C:\\other\\x.js", "C:\\Users\\b\\proj"), "C:/other/x.js");
  assert.equal(relPath("ui/app.js", null), "ui/app.js");
});

test("md renders code, bold, lists and escapes html", () => {
  assert.equal(md("**hi** <b>"), "<p><b>hi</b> &lt;b&gt;</p>");
  assert.match(md("```js\nlet a = 1\n```"), /<pre><code>let a = 1<\/code><\/pre>/);
  assert.match(md("- a\n- b"), /<ul><li>a<\/li><li>b<\/li><\/ul>/);
});

test("groupLabel", () => {
  const now = new Date(2026, 8, 9, 12).getTime();
  assert.equal(groupLabel(now - 3600e3, now), "Today");
  assert.equal(groupLabel(now - 86400e3, now), "Yesterday");
  assert.equal(groupLabel(now - 3 * 86400e3, now), "This week");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/ui.test.mjs`
Expected: FAIL, `Cannot find module '../ui/lib.js'`.

- [ ] **Step 3: Create `ui/lib.js`**

```js
/* Pure helpers shared by the UI modules. No DOM access, so `node --test` can import it. */
export const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
export const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export const fmtN = (n) => (n == null ? "–" : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
export const ago = (ts) => { if (!ts) return ""; const d = Date.now() - ts; if (d < 60e3) return "just now"; if (d < 3600e3) return `${Math.floor(d / 60e3)} min ago`; if (d < 86400e3) return `${Math.floor(d / 3600e3)} h ago`; return `${Math.floor(d / 86400e3)} d ago`; };
export const baseName = (p) => String(p || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop();

export function groupLabel(ts, now = Date.now()) {
  const d = new Date(ts || 0), n = new Date(now);
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = (day(n) - day(d)) / 86400e3;
  if (diff < 1) return "Today";
  if (diff < 2) return "Yesterday";
  if (diff < 7) return "This week";
  return d.toLocaleString(undefined, { month: "long", year: d.getFullYear() === n.getFullYear() ? undefined : "numeric" });
}

export function fmtDuration(ms) {
  const s = Math.max(0, Math.round((ms || 0) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), r = s % 60;
  if (m < 60) return `${m}m ${r}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}
export function tokRate(tokens, ms) { return !tokens || !ms || ms <= 0 ? 0 : Math.round(tokens / (ms / 1000)); }
export function estimateTokens(text) { return Math.ceil(String(text || "").length / 4); }

export function relPath(path, cwd) {
  let p = String(path || "").replace(/\\/g, "/");
  if (cwd) { const c = String(cwd).replace(/\\/g, "/").replace(/\/+$/, ""); if (p.toLowerCase().startsWith(`${c.toLowerCase()}/`)) p = p.slice(c.length + 1); }
  return p;
}

// ------------------------------------------------------------ edits
const EDIT_TOOLS = /^(edit|write|multiedit|notebookedit|str_replace_editor|str_replace_based_edit_tool)$/i;
const lines = (t) => { const s = String(t ?? ""); return s ? s.split("\n").length : 0; };
export function editStats(name, args) {
  if (!EDIT_TOOLS.test(String(name || "")) || !args || typeof args !== "object") return null;
  const path = args.file_path || args.path || args.notebook_path || args.file || "";
  if (!path) return null;
  if (Array.isArray(args.edits)) {
    let added = 0, removed = 0;
    for (const e of args.edits) { added += lines(e.new_string ?? e.newText); removed += lines(e.old_string ?? e.oldText); }
    return { path, added, removed };
  }
  const oldT = args.old_string ?? args.oldText ?? args.old_str;
  const newT = args.new_string ?? args.newText ?? args.new_str ?? args.new_source;
  if (oldT != null || newT != null) return { path, added: lines(newT), removed: lines(oldT) };
  if (args.content != null || args.text != null) return { path, added: lines(args.content ?? args.text), removed: 0 };
  return { path, added: 0, removed: 0 };
}
export function editedFiles(calls) {
  const byPath = new Map();
  for (const c of calls || []) {
    const e = editStats(c?.name, c?.args);
    if (!e) continue;
    const cur = byPath.get(e.path) || { path: e.path, added: 0, removed: 0 };
    cur.added += e.added; cur.removed += e.removed;
    byPath.set(e.path, cur);
  }
  const files = [...byPath.values()];
  return { files, added: files.reduce((a, f) => a + f.added, 0), removed: files.reduce((a, f) => a + f.removed, 0) };
}

// ------------------------------------------------------- work groups
export function groupToolRuns(items, now = Date.now()) {
  const out = [];
  let work = null;
  for (const it of items || []) {
    if (it.kind !== "tool") { work = null; out.push({ kind: "text", item: it }); continue; }
    if (!work) { work = { kind: "work", items: [], startTs: it.startTs, endTs: 0 }; out.push(work); }
    work.items.push(it);
    work.startTs = Math.min(work.startTs, it.startTs);
    if (work.endTs !== null) work.endTs = it.endTs == null ? null : Math.max(work.endTs, it.endTs);
  }
  for (const w of out) if (w.kind === "work") { w.open = w.endTs === null; w.durationMs = Math.max(0, (w.endTs ?? now) - w.startTs); }
  return out;
}

// ----------------------------------------------------------- markdown
export function md(src) {
  const blocks = String(src || "").split(/(```[\s\S]*?```)/g);
  return blocks.map((b) => {
    const m = b.match(/^```(\w*)\n?([\s\S]*?)```$/);
    if (m) return `<pre><code>${esc(m[2].replace(/\n$/, ""))}</code></pre>`;
    let h = esc(b);
    h = h.replace(/`([^`\n]+)`/g, (_, c) => `<code>${c}</code>`);
    h = h.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>").replace(/(^|[^*\w])\*([^*\n]+)\*/g, "$1<i>$2</i>");
    h = h.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    h = h.replace(/^(#{1,4})\s+(.*)$/gm, (_, x, t) => `<h${x.length}>${t}</h${x.length}>`);
    h = h.replace(/(?:^|\n)((?:[ \t]*(?:[-*]|\d+\.)[ \t]+.*(?:\n|$))+)/g, (_, blk) => {
      const ordered = /^\s*\d+\./.test(blk);
      const items = blk.trim().split(/\n/).map((l) => l.replace(/^\s*(?:[-*]|\d+\.)\s+/, "")).map((t) => `<li>${t}</li>`).join("");
      return `\n<${ordered ? "ol" : "ul"}>${items}</${ordered ? "ol" : "ul"}>`;
    });
    h = h.replace(/(?:^|\n)(\|.+\|\n\|[-:| ]+\|\n(?:\|.*\|\n?)*)/g, (_, tbl) => {
      const rows = tbl.trim().split("\n").filter((r) => !/^\|[-:| ]+\|$/.test(r));
      return `\n<table>${rows.map((r, i) => `<tr>${r.split("|").slice(1, -1).map((c) => `<${i ? "td" : "th"}>${c.trim()}</${i ? "td" : "th"}>`).join("")}</tr>`).join("")}</table>`;
    });
    h = h.replace(/\n{2,}/g, "</p><p>").replace(/(?<!>)\n(?!<)/g, "<br>");
    return `<p>${h}</p>`;
  }).join("");
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/ui.test.mjs test/server.test.mjs`
Expected: all passing (including the static-route test from Task 4).

- [ ] **Step 5: Commit**

```powershell
git add ui/lib.js test/ui.test.mjs
git commit -m "feat(ui): pure helpers module (durations, tok/sec, edited files, work groups)"
```

---

### Task 6: New shell (`index.html`) and stylesheet

**Files:**
- Rewrite: `ui/index.html`
- Rewrite: `ui/styles.css`

**Interfaces (produces, DOM ids the JS modules rely on):**
`#side #btnCloseSide #btnOpenSide #btnNewChat #sessionFilter #history #piStatus #lanInfo #main #top #topTitle #btnChatMenu #chatMenu #topModel #btnPanel #view-home #homeComposer #dirChips #homeCwd #homeCards #view-chat #transcriptWrap #transcript #chatComposer #panel .ptab[data-tab] #btnPanelClose #tab-tokens #tab-memory #tab-graph #tab-files` plus the existing feature ids (`#statTitle #statTiles #ctxFill #ctxLabel #statAll #statTop #memSearch #memNew #memImport #memReindex #memOpen #memDigest #memList #memEditor #memPath #memText #memSave #memDelete #memClose #memForm #mfName #mfDesc #mfType #mfBody #mfSave #mfCancel #graphDir #graphBuild #graphRefresh #graphOpenNotes #graphFilter #graphLimit #graphTotals #graphCanvas #graphNode #graphQ #graphAsk #graphAnswer #filesRoot #tree #viewer #vpath #vref #vclose #vbody #toasts`).
Body classes: `side-open`, `panel-open`. Chat view is shown by adding `.active` to `#view-chat`.

- [ ] **Step 1: Write `ui/index.html`**

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Omni Agent</title>
<link rel="stylesheet" href="/styles.css" />
</head>
<body class="side-open">
<aside id="side">
  <div class="side-top">
    <div class="brand"><span class="mark"></span><span class="word">Omni Agent</span></div>
    <button class="icon-btn" id="btnCloseSide" title="Hide sidebar">‹</button>
  </div>
  <button class="side-btn" id="btnNewChat"><span class="plus">+</span> New chat</button>
  <input id="sessionFilter" type="search" placeholder="Search chats" />
  <div id="history"></div>
  <div class="side-foot">
    <div class="pi-status" id="piStatus">pi: starting</div>
    <div class="lan" id="lanInfo"></div>
  </div>
</aside>

<main id="main">
  <header id="top">
    <button class="icon-btn" id="btnOpenSide" title="Show sidebar">☰</button>
    <div class="top-title" id="topTitle">Omni Agent</div>
    <div class="menu-wrap"><button class="icon-btn" id="btnChatMenu" title="Chat actions" hidden>···</button><div class="menu" id="chatMenu" hidden></div></div>
    <div class="grow"></div>
    <div class="top-model" id="topModel"></div>
    <button class="icon-btn" id="btnPanel" title="Toggle side panel">▥</button>
  </header>

  <section class="view active" id="view-home">
    <div class="home">
      <h1 class="hero">What should we work on?</h1>
      <p class="hero-sub">Every pi and Claude Code chat on this machine, one memory vault, live.</p>
      <div id="homeComposer"></div>
      <div class="chips" id="dirChips"></div>
      <div class="cwd-row"><span>Working directory</span><input id="homeCwd" /></div>
      <div class="cards" id="homeCards"></div>
    </div>
  </section>

  <section class="view" id="view-chat">
    <div id="transcriptWrap"><div id="transcript"></div></div>
    <div id="chatComposer"></div>
  </section>
</main>

<aside id="panel">
  <div class="panel-tabs">
    <button class="ptab active" data-tab="tokens">Tokens</button>
    <button class="ptab" data-tab="memory">Memory</button>
    <button class="ptab" data-tab="graph">Graph</button>
    <button class="ptab" data-tab="files">Files</button>
    <span class="grow"></span>
    <button class="icon-btn" id="btnPanelClose" title="Close panel">×</button>
  </div>

  <div class="ptab-body active" id="tab-tokens">
    <div class="stat-block">
      <div class="stat-title" id="statTitle">Current chat</div>
      <div class="tiles" id="statTiles"></div>
      <div class="ctx"><div class="ctx-bar"><div id="ctxFill"></div></div><div class="ctx-label" id="ctxLabel"></div></div>
    </div>
    <div class="stat-block"><div class="stat-title">All sessions today</div><div class="tiles" id="statAll"></div></div>
    <div class="stat-block"><div class="stat-title">Costliest sessions</div><div id="statTop"></div></div>
  </div>

  <div class="ptab-body" id="tab-memory">
    <p class="lead">An Obsidian vault both harnesses read and write. One fact per note; session digests land here on their own.</p>
    <div class="row-tools">
      <input id="memSearch" type="search" placeholder="Search the vault" />
      <button class="btn" id="memNew">New</button>
    </div>
    <div class="row-tools small">
      <button class="btn quiet" id="memImport" title="Copy Claude Code's auto-memory notes into the vault">Import Claude memory</button>
      <button class="btn quiet" id="memReindex">Rebuild index</button>
      <button class="btn quiet" id="memOpen" title="Open the vault folder">Open folder</button>
      <button class="btn quiet" id="memDigest" title="Write a digest for the current chat now">Digest chat</button>
    </div>
    <div id="memList"></div>
    <div id="memEditor" hidden>
      <div class="mem-path" id="memPath"></div>
      <textarea id="memText" spellcheck="false"></textarea>
      <div class="row-tools"><button class="btn primary" id="memSave">Save note</button><button class="btn quiet" id="memDelete">Delete</button><button class="btn quiet" id="memClose">Close</button></div>
    </div>
    <div id="memForm" hidden>
      <input id="mfName" placeholder="Name (short, e.g. pi crash guard)" />
      <input id="mfDesc" placeholder="One-line description used for recall" />
      <select id="mfType"><option value="project">project</option><option value="feedback">feedback</option><option value="user">user</option><option value="reference">reference</option></select>
      <textarea id="mfBody" rows="6" placeholder="The fact. Link related notes with [[name]]."></textarea>
      <div class="row-tools"><button class="btn primary" id="mfSave">Save memory</button><button class="btn quiet" id="mfCancel">Cancel</button></div>
    </div>
  </div>

  <div class="ptab-body" id="tab-graph">
    <p class="lead" id="graphDir">Pick a chat or set a working directory on Home; that folder is the repo.</p>
    <div class="row-tools">
      <button class="btn primary" id="graphBuild" title="Run graphify (AST extraction, no LLM) and write file notes with wikilinks into the vault">Build repo graph</button>
      <button class="btn quiet" id="graphRefresh">Refresh</button>
      <button class="btn quiet" id="graphOpenNotes">Notes</button>
    </div>
    <div class="row-tools">
      <input id="graphFilter" type="search" placeholder="Filter nodes (file or symbol)" />
      <input id="graphLimit" type="number" value="150" min="20" max="600" title="Max nodes drawn" style="width:72px" />
    </div>
    <div class="lead" id="graphTotals"></div>
    <canvas id="graphCanvas"></canvas>
    <div id="graphNode"></div>
    <div class="row-tools"><input id="graphQ" type="search" placeholder="Ask the graph" /><button class="btn" id="graphAsk">Ask</button></div>
    <pre id="graphAnswer" hidden></pre>
  </div>

  <div class="ptab-body" id="tab-files">
    <div class="lead mono" id="filesRoot"></div>
    <div id="tree"></div>
  </div>
</aside>

<div id="viewer" hidden><div class="vcard">
  <div class="vhead"><span class="vpath" id="vpath"></span><button class="btn" id="vref">Reference in prompt</button><button class="btn quiet" id="vclose">Close</button></div>
  <pre id="vbody"></pre>
</div></div>

<div id="toasts"></div>
<script type="module" src="/app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Write `ui/styles.css`**

```css
:root {
  --bg: #0d0d0d; --bg-2: #171717; --bg-3: #1f1f1f; --bg-4: #262626;
  --edge: #262626; --edge-2: #343434;
  --text: #ececec; --muted: #9a9a9a; --dim: #6b6b6b;
  --pi: #f2b84b; --claude: #b39cff; --accent: #ffffff; --caret: #7cc9ff;
  --ok: #4ade80; --err: #ff6b6b; --warn: #ff8c42;
  --font: "Segoe UI Variable", "Segoe UI", system-ui, -apple-system, sans-serif;
  --mono: "Cascadia Code", Consolas, "IBM Plex Mono", monospace;
  --side: 260px; --panel: 380px;
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html, body { height: 100%; margin: 0; }
body { background: var(--bg); color: var(--text); font: 14px/1.55 var(--font); overflow: hidden; display: grid; grid-template-columns: 0 1fr 0; transition: grid-template-columns 0.18s ease; }
body.side-open { grid-template-columns: var(--side) 1fr 0; }
body.panel-open { grid-template-columns: 0 1fr var(--panel); }
body.side-open.panel-open { grid-template-columns: var(--side) 1fr var(--panel); }
button, input, textarea, select { font: inherit; color: inherit; }
::selection { background: #3a3a44; }
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-thumb { background: #2f2f2f; border-radius: 6px; border: 2px solid var(--bg); }
.grow { flex: 1; }
.mono { font-family: var(--mono); font-size: 12px; }

/* ------------------------------------------------------------ controls */
.btn { background: var(--bg-3); color: var(--text); border: 1px solid var(--edge-2); border-radius: 8px; padding: 6px 12px; cursor: pointer; font-size: 13px; line-height: 1.2; }
.btn:hover { background: var(--bg-4); }
.btn.primary { background: var(--accent); color: #111; border-color: transparent; font-weight: 600; }
.btn.primary:hover { background: #e6e6e6; }
.btn.quiet { background: transparent; border-color: transparent; color: var(--muted); }
.btn.quiet:hover { color: var(--text); background: var(--bg-3); }
.btn[disabled] { opacity: 0.45; cursor: default; }
.icon-btn { background: transparent; border: 0; color: var(--muted); font-size: 16px; cursor: pointer; width: 32px; height: 32px; border-radius: 8px; display: inline-grid; place-items: center; }
.icon-btn:hover { color: var(--text); background: var(--bg-3); }
:is(.btn, input, textarea, select, .side-btn, .hist, .send-btn, .ptab, .cbtn, .meter):focus-visible { outline: 2px solid var(--caret); outline-offset: 1px; }
input[type="search"], input[type="text"], input[type="number"], input:not([type]), select, textarea { width: 100%; background: var(--bg-2); border: 1px solid var(--edge); border-radius: 8px; padding: 7px 10px; color: var(--text); }
.menu-wrap { position: relative; }
.menu { position: absolute; top: calc(100% + 6px); left: 0; min-width: 220px; background: var(--bg-3); border: 1px solid var(--edge-2); border-radius: 12px; padding: 6px; z-index: 60; box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5); display: grid; gap: 2px; }
.menu.up { top: auto; bottom: calc(100% + 6px); }
.menu > button, .menu > label { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; background: transparent; border: 0; color: var(--text); padding: 8px 10px; border-radius: 8px; cursor: pointer; font-size: 13px; }
.menu > button:hover, .menu > label:hover { background: var(--bg-4); }
.menu > button.on::after { content: "✓"; margin-left: auto; color: var(--muted); }
.menu .mh { color: var(--dim); font-size: 11px; padding: 6px 10px 2px; text-transform: uppercase; letter-spacing: 0.04em; }
.menu label input { margin: 0; }

/* ------------------------------------------------------------ sidebar */
#side { background: var(--bg-2); border-right: 1px solid var(--edge); display: flex; flex-direction: column; min-height: 0; padding: 10px; gap: 8px; overflow: hidden; width: var(--side); }
body:not(.side-open) #side { display: none; }
.side-top { display: flex; align-items: center; justify-content: space-between; padding: 2px 4px 4px; }
.brand { display: flex; align-items: center; gap: 9px; }
.brand .mark { width: 18px; height: 18px; border-radius: 5px; background: linear-gradient(135deg, var(--pi), var(--claude)); }
.brand .word { font-weight: 600; }
.side-btn { display: flex; align-items: center; gap: 8px; width: 100%; background: transparent; border: 0; color: var(--text); padding: 8px 10px; border-radius: 8px; cursor: pointer; font-size: 13.5px; }
.side-btn:hover { background: var(--bg-3); }
.side-btn .plus { font-size: 16px; color: var(--muted); }
#sessionFilter { font-size: 12.5px; }
#history { flex: 1; overflow: auto; min-height: 0; padding-bottom: 10px; }
.hist-group { color: var(--dim); font-size: 11px; padding: 12px 10px 4px; text-transform: uppercase; letter-spacing: 0.04em; }
.hist { position: relative; display: block; width: 100%; text-align: left; background: transparent; border: 0; color: var(--text); padding: 7px 10px 7px 22px; border-radius: 8px; cursor: pointer; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hist:hover { background: var(--bg-3); }
.hist.active { background: var(--bg-4); }
.hist::before { content: ""; position: absolute; left: 9px; top: 14px; width: 6px; height: 6px; border-radius: 50%; background: var(--dim); }
.hist[data-h="pi"]::before { background: var(--pi); opacity: 0.6; }
.hist[data-h="claude"]::before { background: var(--claude); opacity: 0.6; }
.hist.live::before { opacity: 1; animation: pulse 1.6s ease-out infinite; }
@keyframes pulse { 0% { box-shadow: 0 0 0 0 currentColor; } 100% { box-shadow: 0 0 0 6px transparent; } }
.hist .own { color: var(--caret); font-size: 10.5px; margin-left: 6px; }
.side-foot { border-top: 1px solid var(--edge); padding: 10px 6px 2px; font-size: 12px; color: var(--muted); display: grid; gap: 4px; }
.pi-status.on { color: var(--pi); }
.lan { font-family: var(--mono); font-size: 11px; color: var(--dim); word-break: break-all; }

/* --------------------------------------------------------------- main */
#main { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
#top { display: flex; align-items: center; gap: 6px; height: 48px; padding: 0 10px 0 8px; flex-shrink: 0; border-bottom: 1px solid var(--edge); }
body.side-open #btnOpenSide { display: none; }
.top-title { font-weight: 600; font-size: 14px; padding: 0 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 48vw; }
.top-model { font-family: var(--mono); font-size: 11.5px; color: var(--muted); padding: 3px 8px; border: 1px solid var(--edge); border-radius: 999px; }
.view { display: none; flex: 1; min-height: 0; flex-direction: column; }
.view.active { display: flex; }

/* --------------------------------------------------------------- home */
#view-home { overflow: auto; }
.home { max-width: 720px; margin: 0 auto; padding: 12vh 24px 60px; text-align: center; }
.hero { font-weight: 600; font-size: clamp(26px, 3.4vw, 34px); line-height: 1.15; letter-spacing: -0.02em; margin: 0 0 8px; }
.hero-sub { color: var(--muted); margin: 0 0 26px; font-size: 14px; }
.chips { display: flex; gap: 6px; flex-wrap: wrap; justify-content: center; margin: 14px 0 6px; }
.chip { background: transparent; border: 1px solid var(--edge-2); border-radius: 999px; padding: 4px 11px; font-size: 12.5px; color: var(--muted); cursor: pointer; }
.chip:hover, .chip.active { color: var(--text); background: var(--bg-3); }
.cwd-row { display: flex; gap: 8px; align-items: center; font-size: 12px; color: var(--dim); margin: 4px auto 26px; max-width: 560px; }
.cwd-row input { font-family: var(--mono); font-size: 12px; padding: 5px 9px; background: transparent; border-color: transparent; text-align: center; color: var(--muted); }
.cwd-row input:hover, .cwd-row input:focus { border-color: var(--edge); }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; text-align: left; }
.card { background: var(--bg-2); border: 1px solid var(--edge); border-radius: 14px; padding: 14px 16px; cursor: pointer; min-height: 104px; display: flex; flex-direction: column; gap: 4px; }
.card:hover { border-color: var(--edge-2); background: var(--bg-3); }
.card .c-title { font-size: 12.5px; color: var(--muted); }
.card .c-big { font-size: 26px; font-weight: 600; line-height: 1.1; letter-spacing: -0.02em; }
.card .c-sub { font-size: 12px; color: var(--muted); margin-top: auto; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.card.live .c-big { color: var(--ok); }

/* ----------------------------------------------------------- composer */
.composer { background: var(--bg-3); border: 1px solid var(--edge-2); border-radius: 22px; padding: 12px 12px 10px; text-align: left; }
.composer:focus-within { border-color: #4a4a4a; }
.composer textarea { background: transparent; border: 0; padding: 4px 8px; resize: none; min-height: 42px; max-height: 260px; line-height: 1.5; font-size: 15px; outline: none; }
.composer textarea::placeholder { color: var(--dim); }
.composer-bar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
.cbtn { background: transparent; border: 1px solid transparent; color: var(--muted); cursor: pointer; font-size: 12.5px; border-radius: 999px; padding: 5px 10px; display: inline-flex; align-items: center; gap: 6px; }
.cbtn:hover { color: var(--text); background: var(--bg-4); }
.cbtn.round { width: 30px; height: 30px; padding: 0; justify-content: center; font-size: 18px; }
.cbtn.access .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--warn); }
.cbtn.access.ask .dot { background: var(--muted); }
.cbtn.access .lbl { color: var(--warn); }
.cbtn.access.ask .lbl { color: var(--muted); }
.cbtn .chev { font-size: 10px; opacity: 0.7; }
.cbtn .lbl b { font-weight: 500; color: var(--text); }
.attach-pills { display: inline-flex; gap: 4px; }
.attach-pills .ap { font-size: 11px; color: var(--muted); border: 1px solid var(--edge-2); border-radius: 999px; padding: 2px 8px; }
.seg { display: inline-flex; background: var(--bg-2); border: 1px solid var(--edge); border-radius: 999px; padding: 2px; }
.seg-btn { background: transparent; border: 0; color: var(--muted); padding: 3px 10px; border-radius: 999px; cursor: pointer; font-size: 12.5px; }
.seg-btn.active { background: var(--bg-4); color: var(--text); }
.caption { font-size: 11.5px; color: var(--dim); margin-right: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 40%; }
.send-btn { width: 32px; height: 32px; border-radius: 50%; border: 0; background: var(--accent); color: #111; font-weight: 700; cursor: pointer; font-size: 15px; display: grid; place-items: center; }
.send-btn.stop { background: var(--text); }
.send-btn.stop::before { content: ""; width: 11px; height: 11px; background: #111; border-radius: 2px; }
.send-btn[disabled] { opacity: 0.35; cursor: default; }
.model-menu { min-width: 260px; max-height: 60vh; overflow: auto; }

/* --------------------------------------------------------------- chat */
#transcriptWrap { flex: 1; overflow: auto; }
#transcript { max-width: 760px; margin: 0 auto; padding: 22px 24px 40px; }
#chatComposer { padding: 6px 24px 16px; }
#chatComposer .composer { max-width: 760px; margin: 0 auto; }
.msg.user { display: flex; justify-content: flex-end; margin: 6px 0 20px; }
.msg.user .body { background: var(--bg-3); border-radius: 18px; padding: 10px 16px; white-space: pre-wrap; max-width: 85%; word-break: break-word; }
.msg.system { color: var(--muted); font-size: 12.5px; margin: 8px 0; }
.msg.appear, .turn.appear { animation: appear 0.22s ease-out; }
@keyframes appear { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: none; } }
.turn { margin: 0 0 22px; }
.meter { display: inline-flex; align-items: center; gap: 8px; background: transparent; border: 0; color: var(--muted); font-size: 13px; padding: 2px 0; margin: 0 0 8px; cursor: pointer; border-radius: 6px; }
.meter[disabled] { cursor: default; }
.meter:hover:not([disabled]) { color: var(--text); }
.meter::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--dim); }
.meter.live::before { background: var(--caret); animation: pulse 1.4s ease-out infinite; }
.meter::after { content: "›"; color: var(--dim); font-size: 15px; }
.meter[disabled]::after { content: ""; }
.tbody { display: flex; flex-direction: column; gap: 8px; }
.text p { margin: 0.35em 0; }
.text pre, .body pre { background: #0a0a0a; border: 1px solid var(--edge); border-radius: 10px; padding: 10px 12px; overflow: auto; margin: 0.5em 0; font-family: var(--mono); font-size: 12.5px; line-height: 1.45; }
.text code, .body code { font-family: var(--mono); font-size: 12.5px; background: #0a0a0a; border: 1px solid var(--edge); border-radius: 4px; padding: 0 5px; }
.text pre code { background: none; border: 0; padding: 0; }
.text h1, .text h2, .text h3, .text h4 { margin: 0.7em 0 0.3em; line-height: 1.25; font-size: 1.02em; }
.text ul, .text ol { margin: 0.35em 0; padding-left: 22px; }
.text a { color: var(--caret); }
.text table { border-collapse: collapse; margin: 0.5em 0; font-size: 13px; }
.text td, .text th { border: 1px solid var(--edge); padding: 3px 8px; }
.stream { white-space: pre-wrap; word-break: break-word; }
.stream .tok { animation: tokIn 0.16s ease-out; }
@keyframes tokIn { from { opacity: 0; transform: translateY(2px); } to { opacity: 1; transform: none; } }
.stream.on::after { content: ""; display: inline-block; width: 7px; height: 15px; margin-left: 2px; vertical-align: -2px; background: var(--caret); animation: blink 0.9s steps(2) infinite; }
@keyframes blink { 50% { opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .stream .tok, .msg.appear, .turn.appear, .hist.live::before, .meter.live::before { animation: none; } }
details.think { color: var(--dim); font-size: 12.5px; }
details.think summary { display: none; }
details.think .stream { font-style: italic; color: var(--muted); border-left: 2px solid var(--edge-2); padding-left: 12px; margin: 2px 0 6px; }
details.work { border: 1px solid var(--edge); border-radius: 12px; background: var(--bg-2); overflow: hidden; }
details.work > summary { cursor: pointer; padding: 9px 14px; list-style: none; display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 13px; }
details.work > summary::-webkit-details-marker { display: none; }
details.work > summary .chev { margin-left: auto; color: var(--dim); transition: transform 0.15s; }
details.work[open] > summary .chev { transform: rotate(90deg); }
details.work.on > summary .wlbl { color: var(--text); }
.witems { padding: 0 8px 8px; display: grid; gap: 6px; }
.tool { border: 1px solid var(--edge); border-radius: 10px; background: var(--bg); overflow: hidden; }
.tool > summary { cursor: pointer; padding: 6px 10px; display: flex; gap: 8px; align-items: center; font-family: var(--mono); font-size: 12px; list-style: none; }
.tool > summary::-webkit-details-marker { display: none; }
.tool > summary .name { color: var(--text); font-weight: 500; }
.tool > summary .brief { color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; }
.tool > summary .st { font-size: 11px; color: var(--dim); font-family: var(--font); }
.tool.running > summary .st { color: var(--caret); }
.tool.ok > summary .st { color: var(--ok); }
.tool.err > summary .st { color: var(--err); }
.tool .io { padding: 0 10px 8px; }
.tool pre { background: #0a0a0a; border: 1px solid var(--edge); border-radius: 6px; padding: 8px 10px; margin: 6px 0 0; max-height: 320px; overflow: auto; font-family: var(--mono); font-size: 12px; white-space: pre-wrap; word-break: break-word; }
.tool pre.args { color: var(--muted); }
.edited { border: 1px solid var(--edge); border-radius: 12px; background: var(--bg-2); overflow: hidden; }
.e-head { display: flex; align-items: center; gap: 10px; padding: 10px 14px; }
.e-head::before { content: "▤"; width: 30px; height: 30px; border-radius: 8px; background: var(--bg-4); display: grid; place-items: center; color: var(--muted); font-size: 14px; }
.e-title { font-weight: 600; flex: 1; }
.e-diff .add { color: var(--ok); font-weight: 500; }
.e-diff .del { color: var(--err); font-weight: 500; margin-left: 6px; }
.e-list { border-top: 1px solid var(--edge); }
.e-row { display: flex; justify-content: space-between; gap: 10px; padding: 8px 14px; font-size: 13px; }
.e-row + .e-row { border-top: 1px solid var(--edge); }
.e-path { font-family: var(--mono); font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.e-more { width: 100%; text-align: left; background: transparent; border: 0; border-top: 1px solid var(--edge); color: var(--text); padding: 9px 14px; cursor: pointer; font-size: 13px; }
.e-more:hover { background: var(--bg-3); }
.actions { display: flex; gap: 2px; margin-top: 6px; }
.actions .icon-btn { width: 26px; height: 26px; font-size: 13px; }
.run-line { color: var(--muted); font-size: 12.5px; margin: 4px 0 0; }
.run-line.err { color: var(--err); }
.divider { text-align: center; color: var(--dim); font-size: 12px; margin: 14px 0; }
.divider span { background: var(--bg); padding: 0 10px; position: relative; }
.divider::before { content: ""; display: block; border-top: 1px dashed var(--edge); position: relative; top: 10px; }
.fork-note { font-size: 12px; color: var(--muted); text-align: center; margin: 0 0 14px; }
.fork-note button { background: none; border: 0; color: var(--caret); cursor: pointer; padding: 0; font-size: inherit; }

/* -------------------------------------------------------------- panel */
#panel { background: var(--bg); border-left: 1px solid var(--edge); display: flex; flex-direction: column; min-height: 0; width: var(--panel); overflow: hidden; }
body:not(.panel-open) #panel { display: none; }
.panel-tabs { display: flex; align-items: center; gap: 2px; padding: 8px 8px 0; border-bottom: 1px solid var(--edge); height: 48px; }
.ptab { background: transparent; border: 0; color: var(--muted); padding: 7px 12px; border-radius: 999px; cursor: pointer; font-size: 13px; }
.ptab:hover { color: var(--text); }
.ptab.active { background: var(--bg-3); color: var(--text); }
.ptab-body { display: none; flex: 1; overflow: auto; padding: 14px 16px 40px; }
.ptab-body.active { display: block; }
.lead { color: var(--muted); font-size: 12.5px; margin: 0 0 12px; }
.row-tools { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin: 0 0 10px; }
.row-tools input[type="search"] { flex: 1; min-width: 120px; width: auto; }
.row-tools.small .btn { font-size: 12px; padding: 4px 8px; }

/* memory */
#memList .note { padding: 8px 10px; border-radius: 10px; cursor: pointer; border: 1px solid transparent; }
#memList .note:hover { background: var(--bg-2); border-color: var(--edge); }
#memList .note .n-name { font-size: 13px; }
#memList .note .n-name::before { content: attr(data-type); color: var(--dim); font-size: 11px; margin-right: 8px; }
#memList .note .n-desc { color: var(--muted); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#memList .note .n-path { color: var(--dim); font-size: 11px; font-family: var(--mono); }
#memEditor, #memForm { display: grid; gap: 8px; margin-top: 10px; }
#memText { min-height: 360px; font-family: var(--mono); font-size: 12.5px; }
.mem-path { font-family: var(--mono); font-size: 12px; color: var(--muted); }

/* graph */
#graphCanvas { width: 100%; height: 340px; background: var(--bg-2); border: 1px solid var(--edge); border-radius: 12px; cursor: grab; touch-action: none; }
#graphNode { font-size: 12.5px; color: var(--muted); margin: 8px 0 12px; }
#graphNode b { color: var(--text); font-weight: 500; }
#graphNode .lk { font-family: var(--mono); font-size: 11.5px; }
#graphAnswer { white-space: pre-wrap; font-size: 12px; color: var(--muted); background: var(--bg-2); border: 1px solid var(--edge); border-radius: 10px; padding: 10px; max-height: 360px; overflow: auto; }

/* tokens */
.stat-block { margin-bottom: 20px; }
.stat-title { color: var(--muted); font-size: 12.5px; margin-bottom: 8px; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(96px, 1fr)); gap: 8px; }
.tile { background: var(--bg-2); border: 1px solid var(--edge); border-radius: 10px; padding: 10px 12px; }
.tile .v { font-size: 20px; font-weight: 600; line-height: 1.1; letter-spacing: -0.02em; }
.tile .k { font-size: 11.5px; color: var(--muted); }
.ctx { margin-top: 10px; }
.ctx-bar { height: 6px; background: var(--bg-2); border: 1px solid var(--edge); border-radius: 4px; overflow: hidden; }
#ctxFill { height: 100%; width: 0; background: var(--caret); transition: width 0.4s ease; }
#ctxFill.warn { background: var(--pi); }
#ctxFill.hot { background: var(--err); }
.ctx-label { font-size: 11.5px; color: var(--muted); margin-top: 4px; }
#statTop .row { display: flex; justify-content: space-between; gap: 8px; font-size: 12.5px; padding: 6px 0; border-bottom: 1px solid var(--edge); cursor: pointer; }
#statTop .row span:first-child { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#statTop .row span:last-child { font-family: var(--mono); color: var(--muted); white-space: nowrap; }

/* files */
.node .row { display: flex; gap: 6px; padding: 3px 6px; border-radius: 6px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 13px; }
.node .row:hover { background: var(--bg-2); }
.node .ico { width: 14px; color: var(--dim); }
.children { margin-left: 10px; border-left: 1px solid var(--edge); padding-left: 4px; }

/* viewer + toasts */
#viewer { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.7); display: flex; align-items: center; justify-content: center; z-index: 40; }
.vcard { width: min(1000px, 92vw); height: 86vh; background: var(--bg-2); border: 1px solid var(--edge); border-radius: 14px; display: flex; flex-direction: column; }
.vhead { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-bottom: 1px solid var(--edge); }
.vpath { flex: 1; font-family: var(--mono); font-size: 12.5px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#vbody { flex: 1; overflow: auto; margin: 0; padding: 14px; background: var(--bg); font-family: var(--mono); font-size: 12.5px; white-space: pre; line-height: 1.5; border-radius: 0 0 14px 14px; }
#toasts { position: fixed; right: 16px; bottom: 16px; display: grid; gap: 6px; z-index: 50; }
.toast { background: var(--bg-3); border: 1px solid var(--edge-2); border-radius: 10px; padding: 8px 12px; font-size: 12.5px; box-shadow: 0 6px 20px rgba(0, 0, 0, 0.45); animation: appear 0.2s ease-out; max-width: 380px; }
.toast.err { border-color: var(--err); }

/* ------------------------------------------------------------- narrow */
@media (max-width: 1100px) {
  body.panel-open, body.side-open.panel-open { grid-template-columns: 0 1fr 0; }
  body.side-open { grid-template-columns: var(--side) 1fr 0; }
  #panel { position: fixed; inset: 0 0 0 auto; width: min(92vw, var(--panel)); z-index: 35; box-shadow: 0 0 40px rgba(0, 0, 0, 0.6); }
}
@media (max-width: 860px) {
  body, body.side-open { grid-template-columns: 1fr; }
  #side { position: fixed; inset: 0 auto 0 0; width: min(88vw, 320px); z-index: 30; box-shadow: 0 0 40px rgba(0, 0, 0, 0.6); }
  body.side-open #btnOpenSide { display: inline-grid; }
  .home { padding-top: 6vh; }
  #transcript, #chatComposer { padding-left: 12px; padding-right: 12px; }
  .top-title { max-width: 40vw; }
}
```

- [ ] **Step 3: Load the page once to catch typos** (the old `app.js` will throw because ids moved; that is expected until Task 10)

Run: `node server/index.mjs --no-pi` then open http://127.0.0.1:4400 and confirm the new dark shell renders (sidebar, header, hero). Stop the server.

- [ ] **Step 4: Commit**

```powershell
git add ui/index.html ui/styles.css
git commit -m "feat(ui): Codex-style three-column shell and stylesheet"
```

---

### Task 7: `ui/composer.js`

**Files:**
- Create: `ui/composer.js`

**Interfaces:**
- Consumes: `el` from `ui/lib.js`.
- Produces: `createComposer(root, handlers)` where `handlers = { onSend(text, opts), onStop(), onPickFile(), onPiModel(provider, id), onPiThinking(level), showTarget }` and the returned object:
  - `setState({ harness, streaming, disabled, caption, claudeModel, piModel, piThinking })`
  - `setPiChoices({ models, levels })` — `models: [{ provider, id, name? }]`, `levels: string[]`
  - `getOptions()` → `{ target, memory, graph, autonomous, model }` (`target` only when `showTarget`)
  - `insert(text)`, `focus()`, `clear()`, `get value()`
  - `opts` passed to `onSend` equal `getOptions()`.

- [ ] **Step 1: Create `ui/composer.js`**

```js
/* The composer card: textarea, + menu (file / memory / repo graph), access pill, model pill, send/stop. */
import { el } from "./lib.js";

export const CLAUDE_MODELS = [["", "Default"], ["claude-opus-5", "Opus 5"], ["claude-fable-5-1", "Fable 5.1"], ["claude-sonnet-5", "Sonnet 5"], ["claude-haiku-4-5", "Haiku 4.5"]];

export function createComposer(root, h) {
  root.innerHTML = `
  <div class="composer">
    <textarea rows="1" placeholder="Do anything"></textarea>
    <div class="composer-bar">
      <div class="menu-wrap">
        <button class="cbtn round" data-role="plus" title="Attach">+</button>
        <div class="menu up" data-role="plusMenu" hidden>
          <button data-act="file">Reference a file…</button>
          <label><input type="checkbox" data-opt="memory" checked /> Attach relevant memory</label>
          <label><input type="checkbox" data-opt="graph" /> Attach repo graph</label>
        </div>
      </div>
      <span class="attach-pills"></span>
      <div class="seg" data-role="target" hidden><button class="seg-btn active" data-target="pi">pi</button><button class="seg-btn" data-target="claude">Claude Code</button></div>
      <button class="cbtn access" data-role="access" hidden title="Full access runs Claude Code with --dangerously-skip-permissions; Ask makes it stop for permissions"><span class="dot"></span><span class="lbl">Full access</span></button>
      <div class="menu-wrap">
        <button class="cbtn" data-role="model"><span class="lbl">Model</span><span class="chev">▾</span></button>
        <div class="menu up model-menu" data-role="modelMenu" hidden></div>
      </div>
      <span class="grow"></span>
      <span class="caption"></span>
      <button class="send-btn" data-role="send" title="Send (Enter)">↑</button>
    </div>
  </div>`;
  const q = (s) => root.querySelector(s);
  const ta = q("textarea"), plus = q('[data-role="plus"]'), plusMenu = q('[data-role="plusMenu"]'), pills = q(".attach-pills");
  const seg = q('[data-role="target"]'), access = q('[data-role="access"]'), modelBtn = q('[data-role="model"]'), modelMenu = q('[data-role="modelMenu"]');
  const caption = q(".caption"), send = q('[data-role="send"]');
  const st = { harness: "claude", streaming: false, disabled: false, caption: "", autonomous: true, claudeModel: "", piModel: null, piThinking: "", models: [], levels: [] };

  const autosize = () => { ta.style.height = "auto"; ta.style.height = `${Math.min(ta.scrollHeight, 260)}px`; };
  const closeMenus = () => { plusMenu.hidden = true; modelMenu.hidden = true; };
  document.addEventListener("click", (e) => { if (!root.contains(e.target)) closeMenus(); });

  function getOptions() {
    const o = { memory: q('[data-opt="memory"]').checked, graph: q('[data-opt="graph"]').checked, autonomous: st.autonomous, model: st.harness === "claude" ? st.claudeModel : "" };
    if (h.showTarget) o.target = seg.querySelector(".seg-btn.active").dataset.target;
    return o;
  }
  function renderPills() {
    pills.innerHTML = "";
    const o = getOptions();
    if (o.memory) pills.appendChild(el("span", "ap", "memory"));
    if (o.graph) pills.appendChild(el("span", "ap", "repo graph"));
  }
  function renderModelMenu() {
    modelMenu.innerHTML = "";
    if (st.harness === "claude") {
      modelMenu.appendChild(el("div", "mh", "Claude model"));
      for (const [id, name] of CLAUDE_MODELS) { const b = el("button", id === st.claudeModel ? "on" : "", name); b.onclick = () => { st.claudeModel = id; render(); closeMenus(); }; modelMenu.appendChild(b); }
      return;
    }
    modelMenu.appendChild(el("div", "mh", "Thinking"));
    for (const lv of st.levels) { const b = el("button", lv === st.piThinking ? "on" : "", lv); b.onclick = () => { st.piThinking = lv; h.onPiThinking?.(lv); render(); closeMenus(); }; modelMenu.appendChild(b); }
    modelMenu.appendChild(el("div", "mh", "Model"));
    if (!st.models.length) modelMenu.appendChild(el("div", "mh", "pi is not running"));
    for (const m of st.models) { const on = st.piModel && m.provider === st.piModel.provider && m.id === st.piModel.id; const b = el("button", on ? "on" : "", `${m.name || m.id} · ${m.provider}`); b.onclick = () => { st.piModel = { provider: m.provider, id: m.id }; h.onPiModel?.(m.provider, m.id); render(); closeMenus(); }; modelMenu.appendChild(b); }
  }
  function render() {
    const claude = st.harness === "claude";
    access.hidden = !claude;
    access.classList.toggle("ask", !st.autonomous);
    access.querySelector(".lbl").textContent = st.autonomous ? "Full access" : "Ask";
    seg.hidden = !h.showTarget;
    const lbl = modelBtn.querySelector(".lbl");
    if (claude) { const name = (CLAUDE_MODELS.find(([id]) => id === st.claudeModel) || CLAUDE_MODELS[0])[1]; lbl.innerHTML = `<b>${name}</b>`; }
    else lbl.innerHTML = `<b>${st.piModel?.id || "pi model"}</b>${st.piThinking ? ` <span>${st.piThinking}</span>` : ""}`;
    caption.textContent = st.caption;
    caption.title = st.caption;
    send.disabled = st.disabled;
    send.className = `send-btn${st.streaming ? " stop" : ""}`;
    send.textContent = st.streaming ? "" : "↑";
    send.title = st.streaming ? "Stop" : "Send (Enter)";
    renderPills();
    renderModelMenu();
  }
  function submit() {
    if (st.streaming && !ta.value.trim()) { h.onStop?.(); return; }
    const text = ta.value.trim();
    if (!text || st.disabled) return;
    h.onSend?.(text, getOptions());
  }

  plus.onclick = (e) => { e.stopPropagation(); modelMenu.hidden = true; plusMenu.hidden = !plusMenu.hidden; };
  plusMenu.querySelector('[data-act="file"]').onclick = () => { closeMenus(); h.onPickFile?.(); };
  plusMenu.querySelectorAll("[data-opt]").forEach((i) => i.addEventListener("change", renderPills));
  seg.addEventListener("click", (e) => { const b = e.target.closest(".seg-btn"); if (!b) return; seg.querySelectorAll(".seg-btn").forEach((x) => x.classList.toggle("active", x === b)); st.harness = b.dataset.target; render(); h.onTarget?.(st.harness); });
  access.onclick = () => { st.autonomous = !st.autonomous; render(); };
  modelBtn.onclick = (e) => { e.stopPropagation(); plusMenu.hidden = true; modelMenu.hidden = !modelMenu.hidden; };
  send.onclick = submit;
  ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } });
  ta.addEventListener("input", autosize);
  render();

  return {
    setState(patch) { Object.assign(st, patch); render(); },
    setPiChoices({ models, levels }) { if (models) st.models = models; if (levels) st.levels = levels; render(); },
    getOptions,
    insert(text) { ta.value += `${ta.value && !/\s$/.test(ta.value) ? " " : ""}${text}`; autosize(); ta.focus(); },
    focus() { ta.focus(); },
    clear() { ta.value = ""; autosize(); },
    get value() { return ta.value; },
    get harness() { return st.harness; },
  };
}
```

- [ ] **Step 2: Syntax check**

Run: `node --check ui/composer.js`
Expected: no output (exit 0).

- [ ] **Step 3: Commit**

```powershell
git add ui/composer.js
git commit -m "feat(ui): composer card with + menu, access pill and model picker"
```

---

### Task 8: `ui/transcript.js` — turns, work groups, thinking meter, edited-files card

**Files:**
- Create: `ui/transcript.js`

**Interfaces:**
- Consumes from `ui/lib.js`: `el, esc, md, fmtN, fmtDuration, tokRate, estimateTokens, editedFiles, groupToolRuns, relPath`.
- Produces:
  - `newView(root, wrap, sid, { cwd })` → `view` (also makes it the active view for the 250 ms meter ticker).
  - `applyEvent(view, ev)` — feeds one omni event.
  - `finish(view)` — closes any open turn (used when a session is deselected).
  - `forkNote(view, { fromTitle, onOpen })` — inserts the "Forked from …" note at the top.
  - `emptyNote(view, text)` — the "nothing here yet" divider.
  - `view.lastTs` is maintained like before.

- [ ] **Step 1: Create `ui/transcript.js`**

```js
/* Renders omni events into turns. A turn = one user message followed by everything the model did until it stopped. */
import { el, esc, md, fmtN, fmtDuration, tokRate, estimateTokens, editedFiles, groupToolRuns, relPath } from "./lib.js";

const active = { view: null, timer: null };

export function newView(root, wrap, sid, { cwd } = {}) {
  root.innerHTML = "";
  const view = { sid, root, wrap, cwd: cwd || "", harness: sid.split(":")[0], tools: new Map(), turn: null, stream: null, lastTs: 0, empty: null };
  active.view = view;
  if (!active.timer) active.timer = setInterval(() => {
    const v = active.view, t = v?.turn;
    if (!t || t.done) return;
    // Terminal-observed chats never send a status event: treat 30 s of silence after the last whole message as the end of the turn.
    if (!t.live && t.lastMsgTs && Date.now() - t.lastMsgTs > 30000) { closeTurn(v); return; }
    renderMeter(t); updateWorkLabels(t, false);
  }, 250);
  return view;
}
export function finish(view) { closeTurn(view); }
export function emptyNote(view, text) { view.empty = el("div", "divider"); view.empty.appendChild(el("span", null, text)); view.root.appendChild(view.empty); }
export function forkNote(view, { fromTitle, onOpen }) {
  const n = el("div", "fork-note");
  n.append("Forked from ", Object.assign(el("button", null, fromTitle || "the original chat"), { onclick: onOpen }), ". The history above was copied; the original stays untouched.");
  view.root.prepend(n);
}

function scrollBottom(view) { const w = view.wrap; if (w.scrollHeight - w.scrollTop - w.clientHeight < 200) w.scrollTop = w.scrollHeight; }

// ------------------------------------------------------------- turns
function openTurn(view, ts, live) {
  closeTurn(view);
  const t = { el: el("div", "turn"), meter: el("button", "meter"), body: el("div", "tbody"), startTs: ts || Date.now(), started: false, live: !!live, done: false, endTs: 0, lastMsgTs: 0,
    items: [], workEls: [], curWork: null, cards: [], thinkEls: [], committedOut: 0, currentOut: 0, estChars: 0, reported: false, lastGroup: null, sawThinking: false, sawTool: false };
  t.meter.hidden = true;
  t.meter.onclick = () => { const open = !t.thinkEls[0]?.open; for (const d of t.thinkEls) d.open = open; };
  t.el.append(t.meter, t.body);
  view.root.appendChild(t.el);
  view.turn = t;
  return t;
}
function turnOf(view, ts, live) {
  const t = view.turn && !view.turn.done ? view.turn : openTurn(view, ts, live);
  if (live) t.live = true;
  return t;
}
function closeTurn(view) {
  const t = view.turn;
  if (!t) return;
  closeStream(view);
  t.done = true;
  t.endTs = t.live ? Date.now() : t.lastMsgTs || Date.now();
  t.curWork = null;
  updateWorkLabels(t, true);
  const ed = editedFiles(t.cards.map((c) => c.call));
  if (ed.files.length) t.body.appendChild(editedCard(ed, view.cwd));
  if (t.body.childNodes.length) t.el.appendChild(actionRow(t)); else t.el.remove();
  renderMeter(t);
  view.turn = null;
}
function markStarted(t) {
  if (t.started) return;
  t.started = true;
  if (t.live) t.startTs = Date.now();
}

// ------------------------------------------------------------- meter
function renderMeter(t) {
  if (!t.started) return;
  const tokens = t.committedOut + (t.currentOut || Math.ceil(t.estChars / 4));
  const ms = (t.done ? t.endTs : Date.now()) - t.startTs;
  let text;
  if (!t.done) { text = `Thinking… ${fmtDuration(ms)} · ${fmtN(tokens)} tokens`; if (ms >= 2000 && tokens) text += ` · ${tokRate(tokens, ms)} tok/sec`; }
  else if (!t.live) text = `Replied in ${fmtDuration(ms)}${tokens ? ` · ${fmtN(tokens)} tokens` : ""}`;
  else text = `${t.sawThinking || !t.sawTool ? "Thought" : "Worked"} for ${fmtDuration(ms)} · ${fmtN(tokens)} tokens`;
  t.meter.textContent = text;
  t.meter.title = `${t.reported ? "Tokens reported by the provider" : "Tokens estimated from streamed text (chars ÷ 4)"}${t.thinkEls.length ? " · click to show reasoning" : ""}`;
  t.meter.classList.toggle("live", !t.done);
  t.meter.disabled = !t.thinkEls.length;
  t.meter.hidden = false;
}

// -------------------------------------------------------- work groups
function workGroup(t) {
  if (t.curWork) return t.curWork;
  const d = el("details", "work on");
  d.innerHTML = `<summary><span class="wlbl">Working…</span><span class="chev">›</span></summary><div class="witems"></div>`;
  t.body.appendChild(d);
  const w = { el: d, lbl: d.querySelector(".wlbl"), items: d.querySelector(".witems") };
  t.workEls.push(w);
  t.curWork = w;
  t.sawTool = true;
  return w;
}
function breakWork(t) { t.curWork = null; t.items.push({ kind: "text" }); }
function updateWorkLabels(t, final) {
  const segs = groupToolRuns(t.items).filter((s) => s.kind === "work");
  segs.forEach((s, i) => {
    const w = t.workEls[i]; if (!w) return;
    const n = `${s.items.length} tool${s.items.length === 1 ? "" : "s"}`;
    const live = s.open && !final;
    w.lbl.textContent = live ? `Working… ${fmtDuration(s.durationMs)} · ${n}` : `Worked for ${fmtDuration(s.durationMs)} · ${n}`;
    w.el.classList.toggle("on", live);
  });
}

// --------------------------------------------------------------- tools
function toolCard(view, t, { toolId, name, args }) {
  let c = toolId ? view.tools.get(toolId) : null;
  if (c) return c;
  const d = el("details", "tool running");
  d.innerHTML = `<summary><span class="name">${esc(name || "tool")}</span><span class="brief"></span><span class="st">running</span></summary><div class="io"><pre class="args"></pre><pre class="out" hidden></pre></div>`;
  c = { el: d, args: d.querySelector(".args"), out: d.querySelector(".out"), st: d.querySelector(".st"), brief: d.querySelector(".brief"), argText: "", call: { name: name || "tool", args: undefined }, item: { kind: "tool", startTs: Date.now(), endTs: null } };
  if (args !== undefined) setToolArgs(c, args);
  workGroup(t).items.appendChild(d);
  t.items.push(c.item);
  t.cards.push(c);
  if (toolId) view.tools.set(toolId, c);
  markStarted(t);
  return c;
}
function setToolArgs(c, args) {
  const text = typeof args === "string" ? args : JSON.stringify(args, null, 2);
  if (typeof args === "object" && args) { c.call.args = args; c.brief.textContent = String(args.command || args.file_path || args.path || args.pattern || args.query || args.task || args.description || "").replace(/\s+/g, " ").slice(0, 120); }
  c.args.textContent = text || "";
}
function setToolResult(c, text, isError) {
  c.out.hidden = false; c.out.textContent = (text || "").slice(0, 30000);
  c.el.classList.remove("running"); c.el.classList.add(isError ? "err" : "ok");
  c.st.textContent = isError ? "error" : "done";
  if (c.item.endTs == null) c.item.endTs = Date.now();
}

// -------------------------------------------------------------- blocks
function thinkEl(t) {
  const d = el("details", "think");
  d.innerHTML = `<summary></summary><div class="stream"></div>`;
  t.body.appendChild(d);
  t.thinkEls.push(d);
  t.sawThinking = true;
  return d;
}
function renderBlocks(view, t, blocks) {
  for (const b of blocks) {
    if (b.type === "text") { breakWork(t); const d = el("div", "text"); d.innerHTML = md(b.text); t.body.appendChild(d); markStarted(t); }
    else if (b.type === "thinking") { breakWork(t); thinkEl(t).querySelector(".stream").textContent = b.text; markStarted(t); }
    else if (b.type === "tool_call") { const c = toolCard(view, t, b); if (b.args !== undefined) setToolArgs(c, b.args); }
    else if (b.type === "tool_result") { const c = view.tools.get(b.toolId) || toolCard(view, t, { toolId: b.toolId, name: b.name || "result" }); setToolResult(c, b.text, b.isError); }
    else if (b.type === "image") { breakWork(t); const i = el("img"); i.src = `data:${b.mimeType};base64,${b.data}`; i.style.maxWidth = "100%"; t.body.appendChild(i); }
  }
}

// ----------------------------------------------------------- streaming
function openStream(view, t) { view.stream = { turn: t, parts: new Map() }; return view.stream; }
function streamPart(view, index, part, meta = {}) {
  const t = turnOf(view, Date.now(), true);
  if (!view.stream || view.stream.turn !== t) openStream(view, t);
  let p = view.stream.parts.get(index);
  if (p) return p;
  markStarted(t);
  if (part === "tool_call" || part === "tool_args") p = { part: "tool_call", card: toolCard(view, t, { toolId: meta.toolId, name: meta.name }), text: "" };
  else if (part === "thinking") { breakWork(t); const d = thinkEl(t); d.querySelector(".stream").classList.add("on"); p = { part, el: d, stream: d.querySelector(".stream"), text: "" }; }
  else { breakWork(t); const d = el("div", "text stream on"); t.body.appendChild(d); p = { part: "text", el: d, stream: d, text: "" }; }
  view.stream.parts.set(index, p);
  return p;
}
function finishPart(p, finalText) {
  if (!p || p.done) return;
  if (p.part === "tool_call") { try { setToolArgs(p.card, JSON.parse(p.card.argText || "{}")); } catch { p.card.args.textContent = p.card.argText; } p.done = true; return; }
  p.stream.classList.remove("on");
  const text = finalText ?? p.text;
  if (p.part === "text") { p.stream.innerHTML = md(text); p.stream.classList.remove("stream"); } else p.stream.textContent = text;
  p.done = true;
}
function closeStream(view) {
  if (!view.stream) return;
  for (const p of view.stream.parts.values()) finishPart(p);
  view.stream = null;
}

// --------------------------------------------------------------- cards
function editedCard(ed, cwd) {
  const c = el("div", "edited");
  const head = el("div", "e-head");
  head.innerHTML = `<span class="e-title">Edited ${ed.files.length} file${ed.files.length === 1 ? "" : "s"}</span><span class="e-diff"><b class="add">+${ed.added}</b><b class="del">−${ed.removed}</b></span>`;
  const list = el("div", "e-list");
  ed.files.forEach((f, i) => { const r = el("div", "e-row"); if (i >= 3) r.hidden = true; r.innerHTML = `<span class="e-path" title="${esc(f.path)}">${esc(relPath(f.path, cwd))}</span><span class="e-diff"><b class="add">+${f.added}</b><b class="del">−${f.removed}</b></span>`; list.appendChild(r); });
  c.append(head, list);
  if (ed.files.length > 3) { const more = el("button", "e-more", `Show ${ed.files.length - 3} more files ▾`); more.onclick = () => { list.querySelectorAll(".e-row[hidden]").forEach((r) => { r.hidden = false; }); more.remove(); }; c.appendChild(more); }
  return c;
}
function actionRow(t) {
  const row = el("div", "actions");
  const copy = el("button", "icon-btn", "⧉"); copy.title = "Copy reply";
  copy.onclick = () => { const text = [...t.body.querySelectorAll(".text")].map((d) => d.innerText).join("\n\n"); navigator.clipboard?.writeText(text).catch(() => {}); };
  row.appendChild(copy);
  return row;
}

// -------------------------------------------------------------- events
export function applyEvent(view, ev) {
  const animate = !!ev.live;
  if (view.empty && !["session", "status", "usage"].includes(ev.kind)) { view.empty.remove(); view.empty = null; }
  switch (ev.kind) {
    case "block": {
      if (ev.phase === "message_start") { const t = turnOf(view, Date.now(), true); closeStream(view); openStream(view, t); markStarted(t); }
      else if (ev.phase === "start") streamPart(view, ev.index, ev.part, ev);
      else if (ev.phase === "end") { const p = view.stream?.parts.get(ev.index); if (p) { if (p.part === "tool_call" && ev.args !== undefined) setToolArgs(p.card, ev.args); finishPart(p, ev.text); } }
      break;
    }
    case "delta": {
      const p = streamPart(view, ev.index, ev.part, ev);
      const t = view.turn;
      t.estChars += (ev.delta || "").length;
      if (p.part === "tool_call") { p.card.argText += ev.delta; p.card.args.textContent = p.card.argText; }
      else { p.text += ev.delta; p.stream.appendChild(el("span", "tok", ev.delta)); }
      scrollBottom(view);
      break;
    }
    case "usage": if (ev.usage && view.turn) { view.turn.currentOut = ev.usage.output || 0; view.turn.reported = true; markStarted(view.turn); } break;
    case "msg": {
      if (ev.role === "assistant") {
        const t = turnOf(view, ev.ts, ev.live);
        t.lastMsgTs = Math.max(t.lastMsgTs, ev.ts || 0);
        if (ev.usage) { const g = ev.groupId || ev.id; if (g !== t.lastGroup) { t.lastGroup = g; t.committedOut += Math.max(ev.usage.output || 0, t.currentOut); t.currentOut = 0; t.estChars = 0; t.reported = true; } }
        if (view.stream && ev.live) {
          const parts = [...view.stream.parts.values()].filter((p) => !p.done);
          for (const b of ev.blocks) {
            const p = parts.find((x) => (b.type === "tool_call" ? x.part === "tool_call" && x.card === view.tools.get(b.toolId) : x.part === b.type));
            if (p) { finishPart(p, b.text); if (b.type === "tool_call") setToolArgs(p.card, b.args); parts.splice(parts.indexOf(p), 1); }
            else renderBlocks(view, t, [b]);
          }
          if (view.harness === "pi") closeStream(view);
        } else renderBlocks(view, t, ev.blocks);
        if (!ev.live) renderMeter(t);
      } else if (ev.role === "tool") {
        const t = turnOf(view, ev.ts, ev.live);
        for (const b of ev.blocks) { const c = view.tools.get(b.toolId) || toolCard(view, t, { toolId: b.toolId, name: b.name || "result" }); setToolResult(c, b.text, b.isError); }
        t.lastMsgTs = Math.max(t.lastMsgTs, ev.ts || 0);
      } else if (ev.role === "user") {
        closeTurn(view);
        const m = el("div", `msg user${animate ? " appear" : ""}`);
        const body = el("div", "body"); body.textContent = ev.blocks.map((b) => b.text || (b.type === "image" ? "[image]" : "")).filter(Boolean).join("\n");
        m.appendChild(body); view.root.appendChild(m);
        openTurn(view, ev.ts, !!ev.live);
      } else {
        const m = el("div", `msg system${animate ? " appear" : ""}`);
        m.textContent = ev.blocks.map((b) => b.text || "").join("\n");
        (view.turn?.body || view.root).appendChild(m);
      }
      scrollBottom(view);
      break;
    }
    case "tool": {
      const t = turnOf(view, ev.ts, true);
      const c = toolCard(view, t, ev);
      if (ev.phase === "start" && ev.args !== undefined) setToolArgs(c, ev.args);
      if (ev.phase === "update") { c.out.hidden = false; c.out.textContent = (ev.text || "").slice(-30000); }
      if (ev.phase === "end") setToolResult(c, ev.text, ev.isError);
      scrollBottom(view);
      break;
    }
    case "status": if (ev.streaming === false) closeTurn(view); break;
    case "compaction": { closeTurn(view); const d = el("div", "divider"); d.appendChild(el("span", null, "context compacted")); view.root.appendChild(d); break; }
    case "run": {
      closeTurn(view);
      const line = el("div", `run-line${ev.isError ? " err" : ""}`);
      line.textContent = `${ev.isError ? "Claude Code stopped with an error" : "Finished"}${ev.turns ? ` · ${ev.turns} turn${ev.turns === 1 ? "" : "s"}` : ""}${ev.cost ? ` · $${ev.cost.toFixed(4)}` : ""}${ev.text && ev.isError ? `: ${ev.text}` : ""}`;
      view.root.appendChild(line);
      scrollBottom(view);
      break;
    }
    default: break;
  }
  if (ev.ts > view.lastTs) view.lastTs = ev.ts;
}
```

- [ ] **Step 2: Syntax check**

Run: `node --check ui/transcript.js`
Expected: exit 0.

- [ ] **Step 3: Commit**

```powershell
git add ui/transcript.js
git commit -m "feat(ui): transcript renderer with turns, work groups, thinking meter, edited-files card"
```

---

### Task 9: `ui/sidebar.js` and `ui/panel.js`

**Files:**
- Create: `ui/sidebar.js`
- Create: `ui/panel.js`

**Interfaces:**
- `createSidebar({ S, onSelect(sid), onNew() })` → `{ render(), setOpen(bool) }`. Reads `S.sessions` (Map) and `S.selected`.
- `createPanel({ S, api, toast, onSelect(sid), currentDir(), insert(text), getPiContextWindow() })` → `{ open(tab), toggle(), show(tab), renderStats(), loadMemory(q), loadGraph(), loadGraphList(), loadFiles(), resetFiles() }`. Panel state persists in `localStorage` keys `omni.panel` (`"0"|"1"`) and `omni.tab`.
- `api(path, body?, method?)` and `toast(text, err?)` come from `app.js` (Task 10) with the same signatures as today.

- [ ] **Step 1: Create `ui/sidebar.js`**

```js
/* Session rail: grouped by day, harness dot, live pulse. */
import { el, groupLabel } from "./lib.js";

export function createSidebar({ S, onSelect, onNew }) {
  const wrap = document.querySelector("#history"), filter = document.querySelector("#sessionFilter");
  const isLive = (s) => s.streaming || Date.now() - (s.lastActivity || 0) < 20000;
  function render() {
    const f = filter.value.trim().toLowerCase();
    const list = [...S.sessions.values()]
      .filter((s) => s.title && (!f || `${s.title} ${s.cwd || ""} ${s.model || ""} ${s.harness}`.toLowerCase().includes(f)))
      .sort((a, b) => (b.lastActivity || b.mtime || 0) - (a.lastActivity || a.mtime || 0))
      .slice(0, 150);
    wrap.innerHTML = "";
    let last = null;
    for (const s of list) {
      const g = groupLabel(s.lastActivity || s.mtime);
      if (g !== last) { wrap.appendChild(el("div", "hist-group", g)); last = g; }
      const b = el("button", `hist${s.sid === S.selected ? " active" : ""}${isLive(s) ? " live" : ""}`);
      b.dataset.h = s.harness;
      b.title = `${s.harness} · ${s.cwd || ""}${s.forkedFrom ? " · forked" : ""}`;
      b.textContent = s.title;
      if (s.owned) b.appendChild(el("span", "own", "in Omni"));
      b.onclick = () => onSelect(s.sid);
      wrap.appendChild(b);
    }
    if (!list.length) wrap.appendChild(el("div", "hist-group", f ? "No matches." : "No chats yet."));
  }
  function setOpen(open) { document.body.classList.toggle("side-open", open); try { localStorage.setItem("omni.side", open ? "1" : "0"); } catch { /* private mode */ } }
  filter.addEventListener("input", render);
  document.querySelector("#btnNewChat").onclick = onNew;
  document.querySelector("#btnCloseSide").onclick = () => setOpen(false);
  document.querySelector("#btnOpenSide").onclick = () => setOpen(true);
  let initial = true; try { initial = localStorage.getItem("omni.side") !== "0"; } catch { /* */ }
  if (window.innerWidth < 860) initial = false;
  setOpen(initial);
  return { render, setOpen };
}
```

- [ ] **Step 2: Create `ui/panel.js`** (the Tokens / Memory / Graph / Files features move here from the old `ui/app.js`, unchanged in behavior; the graph canvas code is the same force layout)

```js
/* Right panel: tab strip + the Tokens, Memory, Graph and Files features. */
import { el, esc, fmtN } from "./lib.js";

export function createPanel({ S, api, toast, onSelect, currentDir, insert, getPiContextWindow }) {
  const $ = (s) => document.querySelector(s);
  const TABS = ["tokens", "memory", "graph", "files"];
  let tab = "tokens";
  try { tab = TABS.includes(localStorage.getItem("omni.tab")) ? localStorage.getItem("omni.tab") : "tokens"; } catch { /* */ }

  function show(name) {
    tab = name;
    document.querySelectorAll(".ptab").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
    document.querySelectorAll(".ptab-body").forEach((b) => b.classList.toggle("active", b.id === `tab-${name}`));
    try { localStorage.setItem("omni.tab", name); } catch { /* */ }
    if (name === "tokens") renderStats();
    if (name === "memory") loadMemory($("#memSearch").value.trim());
    if (name === "graph") loadGraph();
    if (name === "files") loadFiles();
  }
  function setOpen(open) { document.body.classList.toggle("panel-open", open); try { localStorage.setItem("omni.panel", open ? "1" : "0"); } catch { /* */ } if (open) show(tab); }
  function open(name) { if (name) tab = name; setOpen(true); }
  function toggle() { setOpen(!document.body.classList.contains("panel-open")); }
  document.querySelectorAll(".ptab").forEach((b) => { b.onclick = () => show(b.dataset.tab); });
  $("#btnPanel").onclick = toggle;
  $("#btnPanelClose").onclick = () => setOpen(false);
  let initial = false; try { initial = localStorage.getItem("omni.panel") === "1"; } catch { /* */ }
  if (window.innerWidth < 1100) initial = false;
  setOpen(initial);

  // ---------------------------------------------------------------- tokens
  function tile(k, v) { const t = el("div", "tile"); t.append(el("div", "v", v), el("div", "k", k)); return t; }
  function renderStats() {
    const s = S.sessions.get(S.selected);
    const t = s?.tally;
    const tiles = $("#statTiles"); tiles.innerHTML = "";
    $("#statTitle").textContent = s ? (s.title || "Current chat") : "Current chat";
    if (t) {
      tiles.append(tile("input", fmtN(t.input)), tile("output", fmtN(t.output)), tile("cache read", fmtN(t.cacheRead)), tile("cache write", fmtN(t.cacheWrite)), tile("messages", fmtN(t.messages)), tile("cost", `$${(t.cost || 0).toFixed(3)}`));
      const win = s.harness === "claude" ? (/haiku/.test(s.model || "") ? 200000 : 1000000) : (getPiContextWindow() || 262144);
      const pct = Math.min(100, Math.round((t.context / win) * 100));
      const f = $("#ctxFill"); f.style.width = `${pct}%`; f.className = pct > 85 ? "hot" : pct > 60 ? "warn" : "";
      $("#ctxLabel").textContent = `context ${fmtN(t.context)} of ${fmtN(win)} (${pct}%)${pct > 60 ? " – consider compacting or a fresh session" : ""}`;
    } else { tiles.appendChild(el("div", "lead", "No token data for this chat yet.")); $("#ctxFill").style.width = "0"; $("#ctxLabel").textContent = ""; }
    const all = { input: 0, output: 0, cacheRead: 0, cost: 0, n: 0 };
    const today = new Date().setHours(0, 0, 0, 0);
    const ranked = [];
    for (const x of S.sessions.values()) {
      if (!x.tally) continue;
      ranked.push(x);
      if ((x.lastActivity || x.mtime || 0) < today) continue;
      all.input += x.tally.input; all.output += x.tally.output; all.cacheRead += x.tally.cacheRead; all.cost += x.tally.cost; all.n++;
    }
    const a = $("#statAll"); a.innerHTML = "";
    a.append(tile("sessions", all.n), tile("input", fmtN(all.input)), tile("output", fmtN(all.output)), tile("cache read", fmtN(all.cacheRead)), tile("cost", `$${all.cost.toFixed(2)}`), tile("cache hit", all.input + all.cacheRead ? `${Math.round((all.cacheRead / (all.input + all.cacheRead)) * 100)}%` : "–"));
    const top = $("#statTop"); top.innerHTML = "";
    for (const x of ranked.sort((p, q) => q.tally.cost - p.tally.cost || q.tally.total - p.tally.total).slice(0, 10)) {
      const r = el("div", "row"); r.append(el("span", null, `${x.harness} · ${(x.title || x.sid).slice(0, 60)}`), el("span", null, `${fmtN(x.tally.total)} tok  $${x.tally.cost.toFixed(2)}`));
      r.onclick = () => onSelect(x.sid);
      top.appendChild(r);
    }
  }

  // ---------------------------------------------------------------- memory
  async function loadMemory(q) {
    const list = $("#memList");
    try {
      const data = q ? await api(`/api/memory/search?q=${encodeURIComponent(q)}&limit=60`) : await api("/api/memory/list");
      const notes = q ? data.hits : data.notes.filter((n) => !n.path.startsWith("Graphs/"));
      if (!q) S.memCount = notes.length;
      list.innerHTML = "";
      if (!notes.length) list.appendChild(el("div", "lead", q ? "No notes match." : "The vault is empty. Save a memory, import Claude's, or let a session digest land here."));
      for (const n of notes) {
        const d = el("div", "note");
        const name = el("div", "n-name", n.name); name.dataset.type = n.type || "";
        d.append(name, el("div", "n-desc", n.description || n.preview || ""), el("div", "n-path", n.path));
        d.onclick = () => openNote(n.path);
        list.appendChild(d);
      }
    } catch (e) { toast(e.message, true); }
  }
  async function openNote(path) {
    try { const n = await api(`/api/memory/note?path=${encodeURIComponent(path)}`); $("#memPath").textContent = path; $("#memText").value = n.raw; $("#memEditor").hidden = false; $("#memForm").hidden = true; $("#memList").hidden = true; }
    catch (e) { toast(e.message, true); }
  }
  function closeNote() { $("#memEditor").hidden = true; $("#memForm").hidden = true; $("#memList").hidden = false; }
  $("#memSearch").addEventListener("input", () => { clearTimeout(window._ms); window._ms = setTimeout(() => loadMemory($("#memSearch").value.trim()), 250); });
  $("#memNew").onclick = () => { $("#memForm").hidden = false; $("#memEditor").hidden = true; $("#memList").hidden = true; $("#mfName").focus(); };
  $("#mfCancel").onclick = closeNote;
  $("#mfSave").onclick = async () => { try { const r = await api("/api/memory/save", { name: $("#mfName").value, description: $("#mfDesc").value, type: $("#mfType").value, body: $("#mfBody").value }); toast(`Saved ${r.path}`); $("#mfName").value = $("#mfDesc").value = $("#mfBody").value = ""; closeNote(); loadMemory(""); } catch (e) { toast(e.message, true); } };
  $("#memSave").onclick = async () => { try { await api("/api/memory/note", { path: $("#memPath").textContent, text: $("#memText").value }, "PUT"); toast("Note saved"); loadMemory($("#memSearch").value.trim()); } catch (e) { toast(e.message, true); } };
  $("#memDelete").onclick = async () => { const p = $("#memPath").textContent; if (!confirm(`Delete ${p}?`)) return; try { await api(`/api/memory/note?path=${encodeURIComponent(p)}`, null, "DELETE"); toast("Note deleted"); closeNote(); loadMemory(""); } catch (e) { toast(e.message, true); } };
  $("#memClose").onclick = closeNote;
  $("#memImport").onclick = async () => { try { const r = await api("/api/memory/import-claude", {}); toast(`Imported ${r.imported.length} Claude memory notes`); loadMemory(""); } catch (e) { toast(e.message, true); } };
  $("#memReindex").onclick = async () => { try { const r = await api("/api/memory/reindex", {}); toast(`Index rebuilt: ${r.notes} notes`); } catch (e) { toast(e.message, true); } };
  $("#memOpen").onclick = () => api("/api/memory/open-vault", {}).catch((e) => toast(e.message, true));
  $("#memDigest").onclick = async () => { if (!S.selected) return toast("Open a chat first", true); try { const r = await api("/api/memory/digest", { sid: S.selected }); toast(`Digest written: ${r.path}`); loadMemory(""); } catch (e) { toast(e.message, true); } };

  // ----------------------------------------------------------------- files
  let filesRoot = null;
  function resetFiles() { filesRoot = null; }
  async function loadFiles() {
    const root = currentDir();
    if (!root || root === filesRoot) return;
    filesRoot = root;
    $("#filesRoot").textContent = root;
    await loadDir(root, "", $("#tree"));
  }
  async function loadDir(root, path, container) {
    try {
      const { entries } = await api(`/api/fs/list?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`);
      container.innerHTML = "";
      for (const e of entries) {
        const node = el("div", "node"), row = el("div", "row");
        row.append(el("span", "ico", e.dir ? "▸" : "·"), el("span", null, e.name));
        node.appendChild(row);
        if (e.dir) { const kids = el("div", "children"); kids.hidden = true; node.appendChild(kids); let loaded = false; row.onclick = async () => { kids.hidden = !kids.hidden; row.querySelector(".ico").textContent = kids.hidden ? "▸" : "▾"; if (!kids.hidden && !loaded) { loaded = true; await loadDir(root, e.path, kids); } }; }
        else row.onclick = () => openFile(root, e.path);
        container.appendChild(node);
      }
    } catch (e) { container.textContent = e.message; }
  }
  async function openFile(root, path) {
    try {
      const d = await api(`/api/fs/read?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`);
      $("#vpath").textContent = path;
      $("#vbody").textContent = d.content != null ? d.content : d.tooBig ? `(file too large: ${d.size} bytes)` : d.binary ? `(binary file: ${d.ext})` : "(unreadable)";
      $("#viewer").hidden = false;
      $("#vref").onclick = () => { insert(`@${path} `); $("#viewer").hidden = true; };
    } catch (e) { toast(e.message, true); }
  }
  $("#vclose").onclick = () => { $("#viewer").hidden = true; };
  $("#viewer").onclick = (e) => { if (e.target.id === "viewer") $("#viewer").hidden = true; };

  // ----------------------------------------------------------------- graph
  const G = { dir: null, data: null, pos: new Map(), sel: null, view: { x: 0, y: 0, k: 1 }, drag: null, raf: 0, ticks: 0 };
  async function loadGraph() {
    const dir = currentDir();
    $("#graphDir").textContent = dir ? `Repo: ${dir}` : "Pick a chat or set a working directory on Home; that folder is the repo.";
    if (!dir) return;
    G.dir = dir;
    try {
      const d = await api(`/api/graph/data?dir=${encodeURIComponent(dir)}&limit=${Number($("#graphLimit").value) || 150}&q=${encodeURIComponent($("#graphFilter").value.trim())}`);
      G.data = d;
      $("#graphTotals").textContent = `${d.totals.nodes} nodes, ${d.totals.links} links, ${d.totals.communities} communities; showing the ${d.nodes.length} best-connected.`;
      layoutGraph();
    } catch (e) {
      G.data = null; drawGraph();
      $("#graphTotals").textContent = /no graph/.test(e.message) ? "No graph for this folder yet. Build one (takes seconds, no LLM)." : e.message;
    }
  }
  function layoutGraph() {
    const c = $("#graphCanvas");
    const W = c.width = c.clientWidth * devicePixelRatio, H = c.height = c.clientHeight * devicePixelRatio;
    const nodes = G.data.nodes;
    const keep = new Map();
    for (const n of nodes) keep.set(n.id, G.pos.get(n.id) || { x: W / 2 + (Math.random() - 0.5) * W * 0.6, y: H / 2 + (Math.random() - 0.5) * H * 0.6, vx: 0, vy: 0 });
    G.pos = keep; G.ticks = 0; G.view = { x: 0, y: 0, k: 1 };
    cancelAnimationFrame(G.raf);
    const step = () => {
      const pos = G.pos, k = 0.9;
      for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
        const a = pos.get(nodes[i].id), b = pos.get(nodes[j].id);
        let dx = a.x - b.x, dy = a.y - b.y; const d2 = dx * dx + dy * dy + 0.01, d = Math.sqrt(d2);
        const f = (2600 * devicePixelRatio) / d2; dx /= d; dy /= d;
        a.vx += dx * f; a.vy += dy * f; b.vx -= dx * f; b.vy -= dy * f;
      }
      for (const l of G.data.links) {
        const a = pos.get(l.source), b = pos.get(l.target); if (!a || !b) continue;
        const dx = b.x - a.x, dy = b.y - a.y, d = Math.sqrt(dx * dx + dy * dy) + 0.01, f = (d - 60 * devicePixelRatio) * 0.02;
        a.vx += (dx / d) * f; a.vy += (dy / d) * f; b.vx -= (dx / d) * f; b.vy -= (dy / d) * f;
      }
      for (const n of nodes) { const p = pos.get(n.id); p.vx += (W / 2 - p.x) * 0.002; p.vy += (H / 2 - p.y) * 0.002; p.x += p.vx *= k; p.y += p.vy *= k; }
      drawGraph();
      if (++G.ticks < 220) G.raf = requestAnimationFrame(step);
    };
    G.raf = requestAnimationFrame(step);
  }
  const COLORS = ["#7cc9ff", "#f2b84b", "#b39cff", "#57d69a", "#ff7b7b", "#ffa94d", "#7dd3fc", "#f9a8d4", "#a3e635", "#fb7185", "#c4b5fd", "#67e8f9"];
  function drawGraph() {
    const c = $("#graphCanvas"), ctx = c.getContext("2d");
    const W = c.width, H = c.height;
    ctx.clearRect(0, 0, W, H);
    if (!G.data) { ctx.fillStyle = "#6b6b6b"; ctx.font = `${13 * devicePixelRatio}px system-ui, sans-serif`; ctx.fillText("No graph loaded.", 16 * devicePixelRatio, 28 * devicePixelRatio); return; }
    ctx.save(); ctx.translate(G.view.x, G.view.y); ctx.scale(G.view.k, G.view.k);
    const selLinks = new Set();
    ctx.lineWidth = devicePixelRatio;
    for (const l of G.data.links) {
      const a = G.pos.get(l.source), b = G.pos.get(l.target); if (!a || !b) continue;
      const hot = G.sel && (l.source === G.sel || l.target === G.sel);
      if (hot) selLinks.add(l.source === G.sel ? l.target : l.source);
      ctx.strokeStyle = hot ? "rgba(124,201,255,0.9)" : "rgba(154,154,163,0.16)";
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    ctx.font = `${11 * devicePixelRatio}px system-ui, sans-serif`;
    for (const n of G.data.nodes) {
      const p = G.pos.get(n.id); const r = (3 + Math.min(10, Math.sqrt(n.degree))) * devicePixelRatio;
      const dim = G.sel && n.id !== G.sel && !selLinks.has(n.id);
      ctx.globalAlpha = dim ? 0.25 : 1;
      ctx.fillStyle = COLORS[(n.community ?? 0) % COLORS.length];
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();
      if (n.degree >= 4 || n.id === G.sel || selLinks.has(n.id)) { ctx.fillStyle = "#ececec"; ctx.fillText(n.label.slice(0, 28), p.x + r + 3, p.y + 4 * devicePixelRatio); }
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }
  function graphHit(ev) {
    const c = $("#graphCanvas"), rect = c.getBoundingClientRect();
    const x = ((ev.clientX - rect.left) * devicePixelRatio - G.view.x) / G.view.k, y = ((ev.clientY - rect.top) * devicePixelRatio - G.view.y) / G.view.k;
    let best = null, bd = 14 * devicePixelRatio;
    for (const n of G.data?.nodes || []) { const p = G.pos.get(n.id); const d = Math.hypot(p.x - x, p.y - y); if (d < bd) { bd = d; best = n; } }
    return best;
  }
  function showGraphNode(n) {
    const box = $("#graphNode");
    if (!n) { box.innerHTML = ""; return; }
    const links = G.data.links.filter((l) => l.source === n.id || l.target === n.id).map((l) => { const other = G.data.nodes.find((x) => x.id === (l.source === n.id ? l.target : l.source)); return `<span class="lk">${esc(l.relation || "")}</span> ${esc(other?.label || "")}`; });
    box.innerHTML = `<b>${esc(n.label)}</b> <span class="lk">${esc(n.file || "")} ${esc(n.loc || "")}</span> · community ${n.community} · ${n.degree} links<br>${links.slice(0, 12).join("<br>")}${links.length > 12 ? `<br>… ${links.length - 12} more` : ""}`;
  }
  (() => {
    const c = $("#graphCanvas");
    c.addEventListener("mousedown", (e) => { G.drag = { x: e.clientX, y: e.clientY, vx: G.view.x, vy: G.view.y, moved: false }; });
    window.addEventListener("mousemove", (e) => { if (!G.drag) return; const dx = (e.clientX - G.drag.x) * devicePixelRatio, dy = (e.clientY - G.drag.y) * devicePixelRatio; if (Math.abs(dx) + Math.abs(dy) > 3) G.drag.moved = true; G.view.x = G.drag.vx + dx; G.view.y = G.drag.vy + dy; drawGraph(); });
    window.addEventListener("mouseup", (e) => { if (!G.drag) return; if (!G.drag.moved && e.target === c) { const n = graphHit(e); G.sel = n?.id || null; showGraphNode(n); drawGraph(); } G.drag = null; });
    c.addEventListener("wheel", (e) => { e.preventDefault(); const f = e.deltaY < 0 ? 1.15 : 1 / 1.15; const rect = c.getBoundingClientRect(); const mx = (e.clientX - rect.left) * devicePixelRatio, my = (e.clientY - rect.top) * devicePixelRatio; G.view.x = mx - (mx - G.view.x) * f; G.view.y = my - (my - G.view.y) * f; G.view.k *= f; drawGraph(); }, { passive: false });
  })();
  async function loadGraphList() { try { S.graphs = (await api("/api/graph/list")).graphs || []; } catch { S.graphs = []; } }
  $("#graphBuild").onclick = async () => {
    const dir = currentDir(); if (!dir) return;
    $("#graphBuild").disabled = true; $("#graphTotals").textContent = "Building… (graphify update + clustering)";
    try { const r = await api("/api/graph/build", { dir }); toast(`Graph built: ${r.nodes} nodes, ${r.notes} notes in vault/${r.vault}`); await loadGraphList(); await loadGraph(); }
    catch (e) { toast(e.message, true); $("#graphTotals").textContent = e.message; }
    finally { $("#graphBuild").disabled = false; }
  };
  $("#graphRefresh").onclick = loadGraph;
  $("#graphFilter").addEventListener("input", () => { clearTimeout(window._gf); window._gf = setTimeout(loadGraph, 300); });
  $("#graphLimit").addEventListener("change", loadGraph);
  $("#graphOpenNotes").onclick = () => { $("#memSearch").value = "graph"; show("memory"); };
  $("#graphAsk").onclick = async () => {
    const q = $("#graphQ").value.trim(); const dir = currentDir(); if (!q || !dir) return;
    $("#graphAnswer").hidden = false; $("#graphAnswer").textContent = "Asking the graph…";
    try { const r = await api("/api/graph/query", { dir, question: q }); $("#graphAnswer").textContent = r.answer || "(no answer)"; } catch (e) { $("#graphAnswer").textContent = e.message; }
  };
  $("#graphQ").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#graphAsk").click(); });

  return { open, toggle, show, renderStats, loadMemory, loadGraph, loadGraphList, loadFiles, resetFiles, graphLine: (t) => { $("#graphTotals").textContent = t; } };
}
```

- [ ] **Step 3: Syntax check**

Run: `node --check ui/sidebar.js; node --check ui/panel.js`
Expected: exit 0 for both.

- [ ] **Step 4: Commit**

```powershell
git add ui/sidebar.js ui/panel.js
git commit -m "feat(ui): sidebar rail and right panel (Tokens, Memory, Graph, Files)"
```

---

### Task 10: `ui/app.js` — boot, state, SSE, routing, continue flow

**Files:**
- Rewrite: `ui/app.js` (ES module)

**Interfaces:**
- Consumes: `newView, applyEvent, finish, forkNote, emptyNote` (transcript), `createComposer` (composer), `createSidebar`, `createPanel`, helpers from `lib.js`.
- Server routes used: `/api/state`, `/events`, `/api/sessions/:sid/history`, `/api/sessions/:sid/continue`, `/api/pi/{start,new,prompt,abort,models,thinking-levels,model,thinking}`, `/api/claude/{run,abort}`.

- [ ] **Step 1: Rewrite `ui/app.js`**

```js
/* Omni Agent front end. Home + Chat in the main column, Tokens/Memory/Graph/Files in the right panel. */
import { el, esc, fmtN, baseName } from "./lib.js";
import { newView, applyEvent, finish, forkNote, emptyNote } from "./transcript.js";
import { createComposer } from "./composer.js";
import { createSidebar } from "./sidebar.js";
import { createPanel } from "./panel.js";

const $ = (s) => document.querySelector(s);
const S = { sessions: new Map(), selected: null, pi: { running: false }, runs: [], seq: 0, buffers: new Map(), view: null, page: "home", config: null, memCount: 0, graphs: [], followFork: null, forceFork: false, desktop: new URLSearchParams(location.search).get("desktop") === "1" };
const LIVE_WINDOW_MS = 30000;

async function api(path, body, method) {
  const r = await fetch(path, body ? { method: method || "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : { method: method || "GET" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error || `${r.status}`);
  return j;
}
function toast(text, err) { const t = el("div", `toast${err ? " err" : ""}`, text); $("#toasts").appendChild(t); setTimeout(() => t.remove(), err ? 7000 : 3500); }
const currentDir = () => S.sessions.get(S.selected)?.cwd || $("#homeCwd").value.trim() || S.config?.cwd || null;

// ------------------------------------------------------------- modules
const sidebar = createSidebar({ S, onSelect: (sid) => { selectSession(sid); showView("chat"); }, onNew: () => { showView("home"); home.focus(); } });
const panel = createPanel({ S, api, toast, onSelect: (sid) => { selectSession(sid); showView("chat"); }, currentDir, insert: (t) => (S.page === "chat" ? chat : home).insert(t), getPiContextWindow: () => S.pi.state?.model?.contextWindow });
const home = createComposer($("#homeComposer"), { showTarget: true, onSend: homeSend, onPickFile: () => panel.open("files"), onPiModel: setPiModel, onPiThinking: setPiThinking });
const chat = createComposer($("#chatComposer"), { onSend: chatSend, onStop: chatStop, onPickFile: () => panel.open("files"), onPiModel: setPiModel, onPiThinking: setPiThinking });
home.setState({ harness: "pi" });

async function setPiModel(provider, id) { try { await api("/api/pi/model", { provider, modelId: id }); toast(`pi model: ${id}`); } catch (e) { toast(e.message, true); } }
async function setPiThinking(level) { try { await api("/api/pi/thinking", { level }); } catch (e) { toast(e.message, true); } }
async function loadPiChoices() {
  if (!S.pi.running) return;
  try {
    const [m, l] = await Promise.all([api("/api/pi/models"), api("/api/pi/thinking-levels")]);
    const choices = { models: m.data?.models || [], levels: l.data?.levels || [] };
    home.setPiChoices(choices); chat.setPiChoices(choices);
  } catch { /* pi may still be starting */ }
}
function piModelState() { const mdl = S.pi.state?.model; return { piModel: mdl ? { provider: mdl.provider, id: mdl.id } : null, piThinking: S.pi.state?.thinkingLevel || "" }; }

// --------------------------------------------------------------- views
function showView(name) {
  S.page = name;
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${name}`));
  $("#btnChatMenu").hidden = name !== "chat";
  if (window.innerWidth < 860) sidebar.setOpen(false);
  if (name === "home") renderHome();
  if (name === "chat") { updateHeader(); updateComposer(); }
  updateTitle();
}
function updateTitle() {
  const s = S.sessions.get(S.selected);
  const title = S.page === "chat" && s?.title ? s.title : "Omni Agent";
  $("#topTitle").textContent = title;
  document.title = S.page === "chat" && s?.title ? `${s.title} · Omni Agent` : "Omni Agent";
}

// ---------------------------------------------------------------- home
function recentDirs() {
  const seen = new Map();
  for (const s of [...S.sessions.values()].sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0))) { if (s.cwd && !seen.has(s.cwd)) seen.set(s.cwd, s); if (seen.size >= 6) break; }
  return [...seen.keys()];
}
function renderHome() {
  const cwdInput = $("#homeCwd");
  if (!cwdInput.value) cwdInput.value = S.pi.cwd || S.config?.cwd || "";
  const chips = $("#dirChips"); chips.innerHTML = "";
  for (const d of recentDirs()) { const c = el("button", `chip${d === cwdInput.value ? " active" : ""}`, baseName(d) || d); c.title = d; c.onclick = () => { cwdInput.value = d; panel.resetFiles(); renderHome(); }; chips.appendChild(c); }
  const live = [...S.sessions.values()].filter((s) => s.streaming);
  const today = new Date().setHours(0, 0, 0, 0);
  let tok = 0, cost = 0, n = 0;
  for (const s of S.sessions.values()) { if (!s.tally || (s.lastActivity || s.mtime || 0) < today) continue; tok += s.tally.total; cost += s.tally.cost; n++; }
  const recent = [...S.sessions.values()].filter((s) => s.title).sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0))[0];
  const cards = $("#homeCards"); cards.innerHTML = "";
  const card = (title, big, sub, onClick, cls) => { const c = el("div", `card${cls ? ` ${cls}` : ""}`); c.append(el("div", "c-title", title), el("div", "c-big", big), el("div", "c-sub", sub)); c.onclick = onClick; cards.appendChild(c); };
  card("Working now", String(live.length), live.length ? live.map((s) => `${s.harness}: ${s.title || "…"}`).join(" · ") : recent ? `Last: ${recent.title}` : "Nothing running", () => { if (live[0]) { selectSession(live[0].sid); showView("chat"); } }, live.length ? "live" : "");
  card("Tokens today", fmtN(tok), `${n} session${n === 1 ? "" : "s"} · $${cost.toFixed(2)}`, () => panel.open("tokens"));
  card("Memory", String(S.memCount), S.config ? `vault: ${baseName(S.config.vault)}` : "", () => panel.open("memory"));
  card("Repo graphs", String(S.graphs.length), S.graphs[0] ? `${S.graphs[0].name}: ${S.graphs[0].nodes} nodes` : "Build one from a chat's folder", () => panel.open("graph"));
  $("#topModel").textContent = S.pi.state?.model?.id || "";
  home.setState({ ...piModelState() });
}
async function homeSend(text, o) {
  const cwd = $("#homeCwd").value.trim() || S.config?.cwd;
  home.setState({ disabled: true });
  try {
    if (o.target === "pi") {
      if (!S.pi.running || (S.pi.cwd || "").toLowerCase() !== cwd.toLowerCase()) await api("/api/pi/start", { cwd }); else await api("/api/pi/new", {});
      const st = await api("/api/state");
      S.pi = st.pi;
      if (!st.pi.sid) throw new Error("pi did not report a session");
      S.sessions.set(st.pi.sid, { ...(S.sessions.get(st.pi.sid) || {}), sid: st.pi.sid, harness: "pi", owned: true, cwd, model: st.pi.state?.model?.id, title: text.replace(/\s+/g, " ").slice(0, 80), lastActivity: Date.now(), streaming: true });
      home.clear(); selectSession(st.pi.sid); showView("chat");
      await api("/api/pi/prompt", { message: text, memory: o.memory, graph: o.graph });
    } else {
      const r = await api("/api/claude/run", { prompt: text, cwd, model: o.model, memory: o.memory, graph: o.graph, autonomous: o.autonomous });
      S.sessions.set(r.sid, { sid: r.sid, harness: "claude", owned: true, cwd, title: text.replace(/\s+/g, " ").slice(0, 80), lastActivity: Date.now(), streaming: true });
      home.clear(); selectSession(r.sid); showView("chat");
    }
  } catch (e) { toast(e.message, true); }
  finally { home.setState({ disabled: false }); }
}

// ---------------------------------------------------------------- chat
function target() {
  const s = S.sessions.get(S.selected);
  if (!s) return { kind: "none" };
  if (s.harness === "pi" && s.owned && S.pi.running && S.pi.sid === s.sid) return { kind: "owned-pi", s, streaming: !!s.streaming };
  if (s.harness === "claude" && S.runs.some((r) => r.sid === s.sid && r.alive)) return { kind: "owned-claude-running", s };
  const live = !s.owned && (s.streaming || Date.now() - Math.max(s.lastActivity || 0, s.mtime || 0) < LIVE_WINDOW_MS);
  return { kind: "continue", s, live };
}
function updateComposer() {
  const t = target();
  const st = { harness: t.s?.harness || "claude", streaming: false, disabled: false, caption: "", ...piModelState() };
  if (t.kind === "none") { st.caption = "Pick a chat"; st.disabled = true; }
  else if (t.kind === "owned-pi") { st.streaming = t.streaming; st.caption = t.streaming ? "Omni's pi is working · a message steers it, empty send stops it" : "Omni's pi"; }
  else if (t.kind === "owned-claude-running") { st.streaming = true; st.caption = "Claude Code is working · send to stop"; }
  else {
    const fork = S.forceFork || t.live;
    const who = t.s.harness === "claude" ? "Claude Code" : "pi";
    st.caption = fork ? `Forks ${t.live ? "the running " : "this "}${who} chat into Omni` : `Continues this ${who} chat${t.s.harness === "pi" ? " in Omni's pi" : ""}`;
  }
  chat.setState(st);
}
async function chatSend(text, o) {
  const t = target();
  try {
    if (t.kind === "owned-pi") { chat.clear(); await api("/api/pi/prompt", { message: text, memory: o.memory, graph: o.graph }); return; }
    if (t.kind === "owned-claude-running" || t.kind === "none") return;
    chat.clear();
    chat.setState({ disabled: true, caption: "Starting…" });
    const r = await api(`/api/sessions/${encodeURIComponent(t.s.sid)}/continue`, { message: text, memory: o.memory, graph: o.graph, model: o.model, autonomous: o.autonomous, fork: S.forceFork });
    S.forceFork = false;
    if (r.pending) { S.followFork = r.forkedFrom; toast("Forking the chat… Omni will switch to the new session as soon as Claude Code reports it."); }
    else if (r.sid !== S.selected) { if (r.forked) toast("Forked into a new pi session"); selectSession(r.sid); }
  } catch (e) { toast(e.message, true); }
  finally { updateComposer(); }
}
async function chatStop() {
  const t = target();
  try {
    if (t.kind === "owned-pi") await api("/api/pi/abort", {});
    else if (t.kind === "owned-claude-running") await api("/api/claude/abort", { sid: t.s.sid });
  } catch (e) { toast(e.message, true); }
}
async function selectSession(sid) {
  if (S.view) finish(S.view);
  S.selected = sid;
  S.forceFork = false;
  sidebar.render();
  const s0 = S.sessions.get(sid);
  const view = newView($("#transcript"), $("#transcriptWrap"), sid, { cwd: s0?.cwd });
  S.view = view;
  updateHeader(); updateComposer(); panel.resetFiles();
  try {
    const h = await api(`/api/sessions/${encodeURIComponent(sid)}/history`);
    if (S.selected !== sid) return;
    if (h.session) S.sessions.set(sid, { ...(S.sessions.get(sid) || {}), ...h.session, tally: h.tally || S.sessions.get(sid)?.tally });
    const s = S.sessions.get(sid);
    view.cwd = s?.cwd || view.cwd;
    for (const ev of h.events) applyEvent(view, ev);
    for (const ev of S.buffers.get(sid) || []) if (ev.ts > view.lastTs || ev.kind === "delta" || ev.kind === "block") applyEvent(view, ev);
    if (!s?.streaming) finish(view);
    if (s?.forkedFrom) forkNote(view, { fromTitle: S.sessions.get(s.forkedFrom)?.title, onOpen: () => { selectSession(s.forkedFrom); } });
    $("#transcriptWrap").scrollTop = $("#transcriptWrap").scrollHeight;
    if (!h.events.length) emptyNote(view, "nothing here yet");
  } catch (e) { toast(`Could not load history: ${e.message}`, true); }
  updateHeader(); updateComposer();
  if (document.body.classList.contains("panel-open")) panel.renderStats();
}
function updateHeader() {
  const s = S.sessions.get(S.selected);
  updateTitle();
  $("#topModel").textContent = s?.model || S.pi.state?.model?.id || "";
  $("#topModel").title = s ? `${s.harness} · ${s.cwd || ""}` : "";
}
function renderChatMenu() {
  const m = $("#chatMenu"); m.innerHTML = "";
  const s = S.sessions.get(S.selected); if (!s) return;
  const item = (label, fn, on) => { const b = el("button", on ? "on" : "", label); b.onclick = () => { m.hidden = true; fn(); }; m.appendChild(b); };
  item("Fork into a new chat with the next message", () => { S.forceFork = !S.forceFork; updateComposer(); chat.focus(); }, S.forceFork);
  item("Digest this chat to the vault", async () => { try { const r = await api("/api/memory/digest", { sid: s.sid }); toast(`Digest written: ${r.path}`); } catch (e) { toast(e.message, true); } });
  item("Copy session id", () => navigator.clipboard?.writeText(s.sid.split(":").slice(1).join(":")).then(() => toast("Session id copied")).catch(() => {}));
  item("Tokens for this chat", () => panel.open("tokens"));
  if (s.forkedFrom) item("Open the original chat", () => selectSession(s.forkedFrom));
  m.appendChild(el("div", "mh", `${s.harness} · ${s.cwd || ""}`));
}
$("#btnChatMenu").onclick = (e) => { e.stopPropagation(); const m = $("#chatMenu"); if (m.hidden) renderChatMenu(); m.hidden = !m.hidden; };
document.addEventListener("click", (e) => { if (!e.target.closest("#chatMenu, #btnChatMenu")) $("#chatMenu").hidden = true; });
$("#homeCwd").addEventListener("change", () => { panel.resetFiles(); renderHome(); });

// ------------------------------------------------------------------ SSE
function connect() {
  const es = new EventSource(`/events?since=${S.seq}`);
  es.onmessage = (m) => { let ev; try { ev = JSON.parse(m.data); } catch { return; } handle(ev); };
  es.onerror = () => { $("#piStatus").textContent = "reconnecting"; };
}
let railTimer = null;
function handle(ev) {
  S.seq = Math.max(S.seq, ev.seq || 0);
  if (ev.kind === "log") { if (ev.level === "system") toast(ev.text); else if (ev.level === "graphify" && ev.text) panel.graphLine(ev.text.split("\n").pop()); return; }
  const s = S.sessions.get(ev.sid) || { sid: ev.sid, harness: ev.harness, lastActivity: 0, tally: null };
  if (ev.kind === "session") Object.assign(s, Object.fromEntries(Object.entries({ cwd: ev.cwd, title: ev.title, model: ev.model, file: ev.file, owned: ev.owned, forkedFrom: ev.forkedFrom }).filter(([, v]) => v != null)));
  if (ev.kind === "status") s.streaming = !!ev.streaming;
  if (ev.kind === "msg" && ev.role === "user" && !s.title) s.title = (ev.blocks?.[0]?.text || "").replace(/\s+/g, " ").slice(0, 80);
  if (ev.kind === "msg" && ev.usage) { const t = s.tally || (s.tally = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, messages: 0, cost: 0, context: 0 }); if (!ev.groupId || t.lastGroup !== ev.groupId) { t.lastGroup = ev.groupId; t.input += ev.usage.input; t.output += ev.usage.output; t.cacheRead += ev.usage.cacheRead; t.cacheWrite += ev.usage.cacheWrite; t.total += ev.usage.total; t.messages++; t.context = ev.usage.input + ev.usage.cacheRead + ev.usage.cacheWrite; t.cost += ev.cost || 0; } }
  if (ev.kind !== "session") s.lastActivity = Math.max(s.lastActivity || 0, ev.ts || 0);
  if (ev.kind === "digest") toast(`Digest saved: ${ev.path}`);
  S.sessions.set(ev.sid, s);
  if (ev.harness === "pi" && s.owned) {
    S.pi.running = true;
    if (ev.kind === "session") { if (ev.cwd) S.pi.cwd = ev.cwd; if (ev.sessionId) S.pi.sid = ev.sid; if (ev.model) S.pi.state = { ...(S.pi.state || {}), model: { ...(S.pi.state?.model || {}), id: ev.model, provider: ev.provider || S.pi.state?.model?.provider }, thinkingLevel: ev.thinkingLevel || S.pi.state?.thinkingLevel }; loadPiChoices(); }
    $("#piStatus").textContent = `pi: ${s.model || "ready"}${s.streaming ? " · working" : ""}`; $("#piStatus").classList.toggle("on", !!s.streaming);
  }
  if (ev.kind === "run" && ev.harness === "claude") { const r = S.runs.find((x) => x.sid === ev.sid); if (r) r.alive = false; }
  if (ev.kind === "session" && ev.harness === "claude" && ev.owned && !S.runs.some((r) => r.sid === ev.sid)) S.runs.push({ sid: ev.sid, alive: true });
  if (ev.kind === "status" && ev.harness === "claude") { const r = S.runs.find((x) => x.sid === ev.sid); if (r) r.alive = !!ev.streaming; }
  const buf = S.buffers.get(ev.sid) || []; buf.push(ev); if (buf.length > 800) buf.splice(0, buf.length - 800); S.buffers.set(ev.sid, buf);
  if (ev.kind === "session" && ev.forkedFrom && S.followFork && ev.forkedFrom === S.followFork) { S.followFork = null; selectSession(ev.sid); showView("chat"); }
  if (ev.sid === S.selected && S.view) { applyEvent(S.view, ev); if ((ev.kind === "msg" || ev.kind === "run") && document.body.classList.contains("panel-open")) panel.renderStats(); if (ev.kind === "status" || ev.kind === "session") { updateHeader(); updateComposer(); } }
  if (!railTimer) railTimer = setTimeout(() => { railTimer = null; sidebar.render(); if (S.page === "home") renderHome(); else updateComposer(); }, 250);
}

// ----------------------------------------------------------------- init
async function init() {
  if (S.desktop) document.body.classList.add("desktop");
  const st = await api("/api/state");
  S.config = st.config; S.pi = st.pi; S.runs = st.runs || [];
  for (const s of st.sessions) S.sessions.set(s.sid, s);
  $("#piStatus").textContent = st.pi?.running ? `pi: ${st.pi.state?.model?.id || "ready"}` : "pi: off";
  if (st.config?.lanUrls?.length) { $("#lanInfo").textContent = st.config.lanUrls[0].replace(/\?token=.*/, ""); $("#lanInfo").title = "Open this on another device on your network; the first visit needs the token link from omni.config.json"; }
  await Promise.all([panel.loadMemory(""), panel.loadGraphList(), loadPiChoices()]);
  sidebar.render();
  showView("home");
  connect();
  setInterval(() => { sidebar.render(); if (S.page === "chat") updateComposer(); }, 15000);
}
init().catch((e) => toast(`Omni Agent failed to start: ${e.message}`, true));
```

- [ ] **Step 2: Syntax check and run the suite**

Run: `node --check ui/app.js; npm test`
Expected: exit 0; all tests pass.

- [ ] **Step 3: Live check with the real app**

Run `node server/index.mjs` (pi auto-starts) and open http://127.0.0.1:4400. Verify, in order:
1. Home renders with the new composer; the pi / Claude Code segment switches the access pill and model menu.
2. Send a short prompt to pi from Home. The chat view opens, the meter reads `Thinking… 3s · 120 tokens · 40 tok/sec` style text while streaming and then `Thought for …`. Clicking the meter shows the reasoning when the model produced any.
3. Pick an older Claude Code chat from the sidebar. The composer caption says "Continues this Claude Code chat". Send a message; the run starts under the same title and tools collapse into "Working… / Worked for …" rows; an "Edited N files" card appears after any Edit/Write.
4. Open a Claude Code chat that is currently running in a terminal (this session). The caption says "Forks the running Claude Code chat into Omni". Send a message; a toast says it is forking, then the sidebar shows the new chat and the view switches to it with the "Forked from …" note.
5. Toggle the right panel: Tokens shows the tiles for the selected chat; Files lists the chat's folder; "Reference in prompt" inserts `@path` into the chat composer.
6. Reload: sidebar and panel open state persist.

- [ ] **Step 4: Commit**

```powershell
git add ui/app.js
git commit -m "feat(ui): app shell wiring, continue/fork flow, fork follow, desktop title"
```

---

### Task 11: Desktop launcher (pywebview, no console)

**Files:**
- Create: `desktop/omni_desktop.pyw`
- Create: `Omni Agent.cmd`
- Create: `test/desktop.test.mjs`
- Modify: `.gitignore` (already ignores `*.log`; nothing to add) and `start.cmd` (unchanged)

**Interfaces:**
- `pythonw desktop/omni_desktop.pyw [cwd] [--port N]` opens the window. `python desktop/omni_desktop.pyw --plan [cwd]` prints the spawn plan as JSON and exits without launching anything: `{ "port", "url", "node", "args", "log", "root" }`.
- The launcher calls `POST /api/shutdown` (Task 4) on window close when it started the server.

- [ ] **Step 1: Write the failing test**

```js
// test/desktop.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const script = join(process.cwd(), "desktop", "omni_desktop.pyw");
const py = spawnSync("python", ["--version"], { encoding: "utf8" });
const havePython = py.status === 0;

test("desktop launcher --plan prints node args with --lan and --cwd", { skip: !havePython && "python not on PATH" }, () => {
  const r = spawnSync("python", [script, "--plan", "C:\\some\\project", "--port", "4567"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const plan = JSON.parse(r.stdout);
  assert.equal(plan.port, 4567);
  assert.equal(plan.url, "http://127.0.0.1:4567/?desktop=1");
  assert.ok(plan.args.includes("--lan"));
  assert.equal(plan.args[plan.args.indexOf("--cwd") + 1], "C:\\some\\project");
  assert.ok(plan.args[1].endsWith("index.mjs"));
  assert.ok(!plan.args.includes("--plan"));
});

test("desktop launcher defaults cwd to the Desktop", { skip: !havePython && "python not on PATH" }, () => {
  const r = spawnSync("python", [script, "--plan"], { encoding: "utf8" });
  const plan = JSON.parse(r.stdout);
  assert.match(plan.args[plan.args.indexOf("--cwd") + 1], /Desktop$/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/desktop.test.mjs`
Expected: FAIL (python cannot open the missing script; status ≠ 0).

- [ ] **Step 3: Create `desktop/omni_desktop.pyw`**

```python
"""Omni Agent desktop launcher.

Starts the Node server hidden (no console), then opens a pywebview window on it.
Run with pythonw so no terminal appears:  pythonw desktop\\omni_desktop.pyw [cwd] [--port N]
  --plan   print the spawn plan as JSON and exit (used by the tests)
Falls back to Edge app mode, then the default browser, when pywebview is missing.
"""
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
WIN = sys.platform.startswith("win")
CREATE_NO_WINDOW = 0x08000000


def read_config():
    try:
        with open(os.path.join(ROOT, "omni.config.json"), "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def arg_value(argv, name, default=None):
    if name in argv:
        i = argv.index(name)
        if i + 1 < len(argv):
            return argv[i + 1]
    return default


def plan(argv):
    cfg = read_config()
    port = int(arg_value(argv, "--port", os.environ.get("OMNI_PORT") or cfg.get("port") or 4400))
    desktop = os.path.join(os.path.expanduser("~"), "Desktop")
    positional = [a for i, a in enumerate(argv) if not a.startswith("--") and (i == 0 or argv[i - 1] not in ("--port",))]
    cwd = positional[0] if positional else desktop
    if cwd == ".":
        cwd = desktop
    node = os.environ.get("OMNI_NODE") or shutil.which("node")
    passthrough = [a for a in argv if a.startswith("--") and a not in ("--plan", "--lan", "--port")]
    args = [node or "node", os.path.join(ROOT, "server", "index.mjs"), "--cwd", cwd, "--port", str(port), "--lan"] + passthrough
    return {"port": port, "url": f"http://127.0.0.1:{port}/?desktop=1", "node": node, "args": args, "log": os.path.join(ROOT, "omni.log"), "root": ROOT}


def alive(port, timeout=1.0):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/state", timeout=timeout) as r:
            return r.status == 200
    except Exception:
        return False


def msgbox(title, text):
    if WIN:
        try:
            import ctypes
            ctypes.windll.user32.MessageBoxW(0, text, title, 0x40)
            return
        except Exception:
            pass
    print(f"{title}: {text}", file=sys.stderr)


def start_server(p):
    log = open(p["log"], "ab")
    kwargs = {"cwd": p["root"], "stdout": log, "stderr": subprocess.STDOUT, "stdin": subprocess.DEVNULL}
    if WIN:
        kwargs["creationflags"] = CREATE_NO_WINDOW
    proc = subprocess.Popen(p["args"], **kwargs)
    deadline = time.time() + 20
    while time.time() < deadline:
        if alive(p["port"]):
            return proc
        if proc.poll() is not None:
            break
        time.sleep(0.25)
    return None


def shutdown(p, proc):
    try:
        req = urllib.request.Request(f"http://127.0.0.1:{p['port']}/api/shutdown", method="POST", data=b"{}", headers={"content-type": "application/json"})
        urllib.request.urlopen(req, timeout=2).read()
    except Exception:
        pass
    deadline = time.time() + 3
    while proc.poll() is None and time.time() < deadline:
        time.sleep(0.1)
    if proc.poll() is None:
        if WIN:
            subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], creationflags=CREATE_NO_WINDOW, capture_output=True)
        else:
            proc.terminate()


def open_window(url):
    try:
        import webview
    except ImportError:
        return False
    window = webview.create_window("Omni Agent", url, width=1280, height=820, min_size=(720, 520))

    def sync_title():
        last = None
        while True:
            time.sleep(2)
            try:
                title = window.evaluate_js("document.title")
                if title and title != last:
                    window.set_title(title)
                    last = title
            except Exception:
                return

    threading.Thread(target=sync_title, daemon=True).start()
    webview.start()
    return True


def fallback(url):
    candidates = [shutil.which("msedge"), r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe", r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"]
    edge = next((c for c in candidates if c and os.path.exists(c)), None)
    if edge:
        subprocess.Popen([edge, f"--app={url}"])
        msgbox("Omni Agent", "pywebview is not installed for this Python, so Omni opened in an Edge app window instead.\nInstall it with:  pip install pywebview")
    else:
        webbrowser.open(url)
        msgbox("Omni Agent", "pywebview is not installed for this Python, so Omni opened in your browser instead.\nInstall it with:  pip install pywebview")


def main(argv):
    p = plan(argv)
    if "--plan" in argv:
        print(json.dumps(p))
        return 0
    if not p["node"]:
        msgbox("Omni Agent", "Node.js was not found on PATH. Install Node 22+ or set OMNI_NODE to node.exe.")
        return 1
    started = None
    if not alive(p["port"]):
        started = start_server(p)
        if started is None:
            msgbox("Omni Agent", f"The server did not start on port {p['port']}. See omni.log in the Omni Agent folder.")
            return 1
    if open_window(p["url"]):
        if started is not None:
            shutdown(p, started)
    else:
        fallback(p["url"])
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
```

- [ ] **Step 4: Create `Omni Agent.cmd`**

```bat
@echo off
REM Opens Omni Agent as a desktop window (no console). Optional first argument: the working directory for pi.
REM For a shortcut with no console flash at all, point the shortcut directly at:
REM   pythonw.exe "<this folder>\desktop\omni_desktop.pyw"
start "" pythonw "%~dp0desktop\omni_desktop.pyw" %*
```

- [ ] **Step 5: Run the tests**

Run: `node --test test/desktop.test.mjs`
Expected: 2 passing (or skipped with a message if `python` is missing).

- [ ] **Step 6: Manual check**

1. Double-click `Omni Agent.cmd`. A console flashes for under a second, then a native "Omni Agent" window opens on the Home view; no console stays open.
2. `omni.log` in the project folder contains the server's "Omni Agent on http://127.0.0.1:4400" line and the LAN link.
3. On a phone on the same Wi-Fi open the LAN link shown in the sidebar footer (first time with `?token=` from `omni.config.json`); the UI loads in the browser.
4. Close the window. Within about 3 s `netstat -ano | findstr :4400` shows nothing listening.
5. Rename the `webview` package temporarily (or run with a Python that lacks it) and confirm the Edge app-mode fallback plus its message box.

- [ ] **Step 7: Commit**

```powershell
git add desktop/omni_desktop.pyw "Omni Agent.cmd" test/desktop.test.mjs
git commit -m "feat(desktop): pywebview launcher with hidden server, LAN on, clean shutdown"
```

---

### Task 12: README and final verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Replace the "Run" section of `README.md`**

```markdown
## Run

Double-click **Omni Agent.cmd** (or a Desktop shortcut pointing at `pythonw.exe "…\desktop\omni_desktop.pyw"`).
It starts the server hidden, opens a native window, and turns LAN access on so phones and laptops on
your network can open the link shown in the sidebar footer. Needs Node 22+ and Python 3.11+ with
`pip install pywebview`; without pywebview it falls back to an Edge app window, then your browser.

Console mode is still there:

```
start.cmd                      # opens http://127.0.0.1:4400 in the browser, pi works in Desktop
start.cmd "C:\some\project"    # pi works in that folder (the Graph tab uses this folder)
start.cmd . --lan              # also reachable from other devices on your network
node server/index.mjs --no-pi  # observe only, don't start a pi child
```
```

- [ ] **Step 2: Replace the "What you get" bullets**

```markdown
## What you get

- **Sidebar**: every pi and Claude Code chat on this machine, grouped by day. A pulsing dot means it
  is working right now; "in Omni" marks chats this app controls.
- **Chat**: one renderer for four sources (pi and Claude Code run from Omni stream token by token;
  chats run in a terminal appear whole). Tool calls fold into "Worked for 8m 4s" rows, edits
  become an "Edited N files +a −b" card, and every turn shows
  `Thinking… 11m 20s · 15k tokens · 86 tok/sec` while the model works.
- **Continue any chat**: type into a chat that is closed and it resumes in place
  (`claude -p --resume`, or Omni's pi switches to that session file). Type into a chat that is still
  open in a terminal and Omni forks it (`--fork-session` / pi `clone`) so the terminal copy is
  never touched. The composer caption says which will happen. "Fork into a new chat" in the ··· menu
  forces a fork.
- **Composer**: "Do anything", + for file references, memory and repo-graph attachments, an access
  pill (Full access / Ask) for Claude Code, and a model / thinking picker.
- **Right panel**: Tokens (usage, cost, context bar), Memory (search, edit, import, digest), Graph
  (build and query a repo graph), Files (browse the chat's folder).
```

- [ ] **Step 3: Update the Layout block**

```
server/index.mjs      HTTP + SSE + routes           server/continue.mjs      resume-vs-fork decision
server/pi-rpc.mjs     pi --mode rpc child           server/claude-runner.mjs claude -p stream-json runs
server/watchers.mjs   discovery, tailing, digests   server/normalize.mjs     four sources -> one event
server/memory.mjs     the vault                     server/tokens.mjs        tally + prices
ui/                   index.html, styles.css, app.js + lib/transcript/composer/sidebar/panel modules
desktop/              pywebview launcher            integrations/            pi extension, Claude Code hook
```

- [ ] **Step 4: Full verification**

Run: `npm test`
Expected: every test file passes (continue, claude-runner, ui, desktop, server, plus the existing ones).

Then repeat the live checks from Task 10 Step 3 and Task 11 Step 6 once more on the final build.

- [ ] **Step 5: Commit**

```powershell
git add README.md
git commit -m "docs: desktop launcher, continue/fork, new UI"
```

---

## Spec coverage check

| Spec section | Tasks |
|---|---|
| 1 Decision table, endpoint, fork follow, composer state | 1, 2, 3, 4, 10 |
| 2 Files / layout / chat column / composer / home | 5, 6, 7, 8, 9, 10 |
| 3 Live thinking meter | 8 (`renderMeter`), 10 (usage events routed) |
| 4 Desktop window, shutdown route, fallbacks | 4 (`/api/shutdown`), 11 |
| Rollout / README | 12 |

Spec deviation, on purpose: the "old transcript above a divider" for forks is unnecessary because both `--fork-session` and pi `clone` copy the history into the new session file, so the forked chat already shows it. A "Forked from …" note with a link back replaces it. The action row under each turn has only Copy; "fork from here" is the chat menu's "Fork into a new chat" (whole-session fork is all either harness supports).
