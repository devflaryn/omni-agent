/**
 * The background-agents lib (omni-agents-lib.mjs) the OpenCode plugin's agent_* / job_* / claude_task tools are
 * built on, driven directly with fake clients and clocks.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as lib from "../integrations/pi/omni-agents-lib.mjs";

// Run from inside an Omni agent, these would point the lib at the real server: never.
delete process.env.OMNI_AGENT_URL;
delete process.env.OMNI_AGENT_DEPTH;

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
async function until(cond, what = "condition", ms = 5000) {
  const end = Date.now() + ms;
  while (!(await cond())) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await tick(); }
}

const ctxFor = (sessionId) => ({ cwd: "C:/work", sessionManager: { getSessionId: () => sessionId }, model: { provider: "openrouter", id: "deepseek/deepseek-v4-flash-0731" } });

test("lib: identity comes from the session and OMNI_AGENT_DEPTH; the base URL from omni-agent.json", () => {
  assert.deepEqual(lib.identity(ctxFor("s1"), {}), { parentSessionId: "s1", parentSid: "pi:s1", depth: 0 });
  assert.deepEqual(lib.identity(ctxFor("s1"), { OMNI_AGENT_DEPTH: "2" }), { parentSessionId: "s1", parentSid: "pi:s1", depth: 2 });
  assert.equal(lib.identity(ctxFor("s1"), { OMNI_AGENT_DEPTH: "junk" }).depth, 0);
  assert.deepEqual(lib.identity({}, {}), { parentSessionId: "", parentSid: null, depth: 0 });
  assert.deepEqual(lib.identity({ sessionManager: { getSessionId: () => { throw new Error("x"); } } }, {}).parentSid, null);
  const home = mkdtempSync(join(tmpdir(), "omni-agents-base-"));
  try {
    assert.equal(lib.omniBase(home, {}), "http://127.0.0.1:4400", "default port without a config");
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(join(home, ".pi", "agent", "omni-agent.json"), JSON.stringify({ port: 4555 }));
    assert.equal(lib.omniBase(home, {}), "http://127.0.0.1:4555");
    assert.equal(lib.omniBase(home, { OMNI_AGENT_URL: "http://127.0.0.1:4999/" }), "http://127.0.0.1:4999", "the spawning server's address wins");
    assert.equal(lib.omniBase(home, { OMNI_AGENT_URL: "not a url" }), "http://127.0.0.1:4555", "a junk override is ignored");
    writeFileSync(join(home, ".pi", "agent", "omni-agent.json"), "{ not json");
    assert.equal(lib.omniBase(home, {}), "http://127.0.0.1:4400", "a malformed config falls back");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("lib: run times, status lines and reports (clipped to their limits)", () => {
  assert.equal(lib.fmtDuration(4200), "4s");
  assert.equal(lib.fmtDuration(252000), "4m12s");
  assert.equal(lib.fmtDuration(3 * 3600000 + 5 * 60000), "3h05m");
  const t0 = Date.UTC(2026, 9, 21, 12, 0, 0);
  const rec = { id: "a-00000001", kind: "pi", title: "Scan the offsets", task: "scan", status: "running", startedAt: t0, activity: ["bash(ls -la)", "read(src/a.ts)"] };
  assert.equal(lib.elapsedOf(rec, t0 + 65000), "1m05s");
  assert.equal(lib.elapsedOf({ ...rec, startedAt: new Date(t0).toISOString(), endedAt: new Date(t0 + 3000).toISOString() }), "3s", "ISO timestamps work too");
  assert.equal(lib.elapsedOf({ ...rec, startedAt: null }), "", "a queued agent has no run time");
  assert.equal(lib.statusLine(rec, t0 + 65000), "a-00000001 · OpenCode agent · running · 1m05s · Scan the offsets — last: read(src/a.ts)");
  const job = { id: "a-00000002", kind: "shell", command: "npm run build", title: "npm run build", status: "error", exitCode: 2, startedAt: t0, endedAt: t0 + 9000, resultText: "x\n".repeat(10) + "error TS2304" };
  assert.match(lib.statusLine(job), /job · error \(exit 2\) · 9s · npm run build/);
  const jr = lib.agentReport(job);
  assert.match(jr, /^Background job a-00000002 "npm run build" finished: error \(exit 2\) after 9s\.\n\nLog tail:\n/);
  assert.match(jr, /error TS2304$/);
  const big = { ...rec, status: "done", endedAt: t0 + 252000, resultText: "R".repeat(50000) };
  const report = lib.agentReport(big, { max: lib.MAX_REPORT });
  assert.ok(report.length <= lib.MAX_REPORT, `report ${report.length} ≤ ${lib.MAX_REPORT}`);
  assert.match(report, /^Background OpenCode agent a-00000001 "Scan the offsets" finished: done after 4m12s\./);
  assert.match(report, /more characters truncated/);
  assert.match(report, /agent_message a-00000001/);
  const full = lib.agentReport(big, { resultMax: lib.MAX_RESULT });
  assert.equal(full.match(/R+/)[0].length, lib.MAX_RESULT, "a tool result carries up to 20000 characters of the result");
  assert.match(full, /\(30000 more characters truncated\)/);
  const claude = { id: "a-00000003", kind: "claude", title: "t", status: "done", sessionId: "cs-1", turns: 1, cost: 0.5, resultText: "ok" };
  assert.equal(lib.claudeFooter(claude), '[claude session cs-1 · 1 turn · $0.500 — pass resume="cs-1" to continue]');
  assert.match(lib.agentReport(claude), /\[claude session cs-1 · 1 turn · \$0\.500/);
  assert.match(lib.describeAgent({ ...big, error: "", delivered: false }), /result \(not reported yet\):\nR{1500}\n… \(48500 more/);
});

/** A fake client whose wait() advances a fake clock by the requested chunk and answers from a script. */
function scriptedClient(script) {
  const clock = { t: 0 };
  const calls = [];
  const client = {
    async wait(q, signal) {
      calls.push(q.timeoutSec);
      const step = script(calls.length, q, signal);
      const r = await step;
      if (r?.throw) throw r.throw;
      clock.t += q.timeoutSec * 1000;
      return { finished: [], pending: [], ...r };
    },
  };
  return { client, clock, calls, now: () => clock.t, sleep: async (ms) => { clock.t += ms; } };
}

test("lib: waitAgents waits in ≤240 s chunks until the deadline, returns at the first finished agent", async () => {
  const running = [{ id: "a-1", status: "running" }];
  const s = scriptedClient(() => ({ pending: running }));
  const chunks = [];
  const r = await lib.waitAgents(s.client, { ids: ["a-1"], timeoutMs: 600000, now: s.now, sleep: s.sleep, onChunk: (c) => chunks.push(c.elapsedMs) });
  assert.deepEqual(s.calls, [240, 240, 120], "600 s = 240 + 240 + 120");
  assert.equal(r.timedOut, true);
  assert.deepEqual(r.finished, []);
  assert.deepEqual(r.pending, running);
  assert.deepEqual(chunks, [240000, 480000, 600000], "a heartbeat per chunk");

  const s2 = scriptedClient((n) => (n < 2 ? { pending: running } : { finished: [{ id: "a-1", status: "done" }] }));
  const r2 = await lib.waitAgents(s2.client, { ids: ["a-1"], timeoutMs: 3600000, now: s2.now, sleep: s2.sleep });
  assert.deepEqual(s2.calls, [240, 240]);
  assert.deepEqual(r2.finished.map((a) => a.id), ["a-1"]);

  const s3 = scriptedClient(() => ({}));
  assert.equal((await lib.waitAgents(s3.client, { parentSessionId: "s", timeoutMs: 60000, now: s3.now, sleep: s3.sleep })).empty, true, "nothing to wait for returns at once");
  assert.deepEqual(s3.calls, [60]);
});

test("lib: waitAgents retries a network blip, gives up after three, and returns on abort", async () => {
  const blip = Object.assign(new Error("down"), { unreachable: true });
  const s = scriptedClient((n) => (n <= 2 ? { throw: blip } : { finished: [{ id: "a-1", status: "done" }] }));
  const r = await lib.waitAgents(s.client, { ids: ["a-1"], timeoutMs: 600000, now: s.now, sleep: s.sleep });
  assert.equal(r.finished.length, 1, "two blips are retried");
  const dead = scriptedClient(() => ({ throw: blip }));
  await assert.rejects(lib.waitAgents(dead.client, { ids: ["a-1"], timeoutMs: 600000, now: dead.now, sleep: dead.sleep }), /down/);
  assert.equal(dead.calls.length, 3);
  const bad = scriptedClient(() => ({ throw: Object.assign(new Error("no such agent"), { status: 404 }) }));
  await assert.rejects(lib.waitAgents(bad.client, { ids: ["a-x"], timeoutMs: 600000, now: bad.now, sleep: bad.sleep }), /no such agent/, "an HTTP error is not retried");
  assert.equal(bad.calls.length, 1);
  const ac = new AbortController();
  const ab = scriptedClient((_n, _q, signal) => new Promise((_r, rej) => signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { aborted: true })))));
  const p = lib.waitAgents(ab.client, { ids: ["a-1"], timeoutMs: 600000, signal: ac.signal, now: ab.now, sleep: ab.sleep });
  await tick();
  ac.abort();
  assert.equal((await p).aborted, true);
});

test("lib: waitJob stops at a matching log line or the exit", async () => {
  let n = 0;
  const client = { waitLog: async (_id, q) => { n++; return n < 2 ? { matched: false, status: "running", tail: "compiling" } : { matched: true, status: "running", tail: "BUILD OK" }; } };
  let t = 0;
  const r = await lib.waitJob(client, { id: "a-1", until: "BUILD OK", timeoutMs: 600000, now: () => (t += 1500), sleep: async () => {} });
  assert.deepEqual({ matched: r.matched, status: r.status, tail: r.tail }, { matched: true, status: "running", tail: "BUILD OK" });
  const ended = await lib.waitJob({ waitLog: async () => ({ matched: false, status: "error", tail: "boom" }) }, { id: "a-1", timeoutMs: 1000 });
  assert.equal(ended.status, "error");
});

test("lib: the delivery poller backs off 5 s → 60 s while Omni is unreachable, delivers once (acked when it reaches the session), then ends", async () => {
  const blip = Object.assign(new Error("down"), { unreachable: true });
  const rec = { id: "a-00000009", kind: "pi", title: "t", status: "done", endedAt: 123, resultText: "the answer" };
  let n = 0;
  const acks = [];
  const client = {
    async wait() { n++; if (n <= 6) throw blip; if (n === 7) return { finished: [rec], pending: [] }; return { finished: [], pending: [] }; },
    async delivered(id) { acks.push(id); return true; },
  };
  const naps = [];
  const out = [];
  const p = new lib.DeliveryPoller({ client, parentSessionId: "lib-backoff", deliver: (r) => out.push(r.id), sleep: async (ms) => { naps.push(ms); } }).start();
  await p.done;
  assert.deepEqual(naps, [5000, 10000, 20000, 40000, 60000, 60000]);
  assert.deepEqual(out, ["a-00000009"]);
  assert.deepEqual(acks, [], "not acked by the poller: only its message_end in the session acks it");
  assert.ok(lib.pendingAck("a-00000009"), "posted, waiting for its message_end");
  assert.equal(lib.confirmDelivered("a-00000009"), true);
  assert.equal(p.running, false, "nothing running or undelivered: the poller ends");
  // A client error (an Omni without these routes) ends it at once.
  const p2 = new lib.DeliveryPoller({ client: { wait: async () => { throw Object.assign(new Error("unknown route"), { status: 404 }); } }, parentSessionId: "lib-404", deliver: () => {}, sleep: async () => { throw new Error("must not back off"); } }).start();
  await p2.done;
  assert.equal(p2.running, false);
});

test("lib: a paused poller holds its request; a report claimed by a tool is not delivered again", { timeout: 10000 }, async () => {
  const sid = "lib-pause";
  const rec = { id: "a-0000000a", kind: "pi", title: "t", status: "done", endedAt: 7, resultText: "r" };
  let opened = 0, aborted = 0, answer = null;
  const acks = [];
  const client = {
    wait: (_q, signal) => new Promise((resolve, reject) => {
      opened++;
      answer = resolve;
      signal.addEventListener("abort", () => { aborted++; reject(Object.assign(new Error("aborted"), { aborted: true })); });
    }),
    delivered: async (id) => { acks.push(id); return true; },
  };
  const out = [];
  const p = lib.ensurePoller({ client, parentSessionId: sid, pi: { sendMessage: (m, o) => out.push({ m, o }) }, idleMs: 20 });
  assert.equal(lib.pollerFor(sid), p);
  assert.equal(lib.ensurePoller({ client, parentSessionId: sid, pi: {} }), p, "one poller per session");
  await until(() => opened === 1, "first wait");
  const release = lib.pausePoller(sid);
  await until(() => aborted === 1, "the paused poller drops its request");
  await tick(30);
  assert.equal(opened, 1, "no request while paused");
  assert.equal(lib.claim(rec), true, "the waiting tool claims the report");
  assert.equal(lib.claim(rec), false, "only once");
  release();
  await until(() => opened === 2, "resumed after release");
  answer({ finished: [rec], pending: [] });
  await until(() => opened === 3, "the next round");
  assert.equal(out.length, 0, "the claimed report is not posted");
  assert.deepEqual(acks, [rec.id], "but it is acked");
  answer({ finished: [{ ...rec, endedAt: 8, resultText: "second run" }], pending: [] });
  await until(() => opened === 4, "the round after");
  assert.equal(out.length, 1, "a later run of the same agent is a new report");
  assert.match(out[0].m.content, /second run/);
  assert.equal(lib.claim({ ...rec, endedAt: 8 }), false);
  answer({ finished: [], pending: [] });
  await p.done;
  assert.equal(lib.pollerFor(sid), undefined, "nothing left: it ends");
});

test("lib: a report pi only queued and then lost (Stop, crash) is posted again once the chat is idle — never while it is busy", async () => {
  const rec = { id: "a-0000ab01", kind: "pi", title: "t", status: "done", endedAt: 21, resultText: "r" };
  let clock = 1000, idle = false, rounds = 0;
  const out = [], acks = [];
  const client = { wait: async () => (++rounds > 5 ? { finished: [], pending: [] } : { finished: [rec], pending: [] }), delivered: async (id) => { acks.push(id); return true; } };
  const p = new lib.DeliveryPoller({
    client, parentSessionId: "lib-lost", ackTimeoutMs: 60000, isIdle: () => idle, now: () => clock,
    deliver: (r) => out.push(r.id),
    sleep: async () => { clock += 30000; if (rounds === 3) idle = true; },
  }).start();
  await p.done;
  // round 1 posts; rounds 2-3: still pending and the chat busy (or under the timeout) → nothing; once idle and past the
  // timeout it is given back and posted again; acks only ever come from its message_end.
  assert.deepEqual(out, [rec.id, rec.id], "posted once, then again after it was lost");
  assert.deepEqual(acks, []);
  lib.confirmDelivered(rec.id);
});

test("lib: a wake-up triggers a turn only when no prompt is starting and the user did not stop the chat", () => {
  lib.resetTurn();
  const wake = { triggerTurn: true, deliverAs: "followUp" }, quiet = { triggerTurn: false };
  assert.deepEqual(lib.wakeOptions(), wake, "an idle chat is woken");
  // pi's prompt() checks it is idle, then awaits auth/compaction/before_agent_start before it claims the run: a
  // triggerTurn in that window is the second run whose cleanup clears pi's busy flag mid-run.
  lib.onTurnEvent("input", {}, {}, 1000);
  assert.deepEqual(lib.wakeOptions(1500), quiet, "a prompt is starting: the report joins that turn instead");
  lib.onTurnEvent("agent_start", {}, {}, 1600);
  assert.deepEqual(lib.wakeOptions(1700), wake, "the run streams: pi queues it as a follow-up");
  lib.onTurnEvent("agent_settled", {}, {}, 1800);
  assert.deepEqual(lib.wakeOptions(1900), wake);
  lib.onTurnEvent("input", {}, {}, 2000);
  assert.deepEqual(lib.wakeOptions(2000 + lib.PROMPT_START_MAX_MS), wake, "a prompt that never ran (a command, a failed preflight) stops counting");
  lib.onTurnEvent("agent_settled", {}, {}, 2100);
  // Stop: pi aborts the run's signal before it releases any tool (a waiting job_wait lets the poller go at once).
  const ac = new AbortController();
  lib.onTurnEvent("agent_start", {}, { signal: ac.signal }, 3000);
  ac.abort();
  assert.deepEqual(lib.wakeOptions(3001), quiet, "aborted mid-run: a report must not be queued as a follow-up, pi would run it");
  lib.onTurnEvent("agent_settled", {}, {}, 3002);
  assert.deepEqual(lib.wakeOptions(3003), quiet, "a stopped chat stays stopped: reports go in without waking it");
  lib.onTurnEvent("input", {}, {}, 4000);
  lib.onTurnEvent("agent_start", {}, {}, 4001);
  lib.onTurnEvent("agent_settled", {}, {}, 4002);
  assert.deepEqual(lib.wakeOptions(4003), wake, "the next prompt (the user's or the keeper's) un-stops it");
  // An aborted last message also counts (a context with no signal).
  lib.onTurnEvent("agent_end", { messages: [{ role: "assistant", stopReason: "aborted" }] }, {}, 5000);
  lib.onTurnEvent("agent_settled", {}, {}, 5001);
  assert.deepEqual(lib.wakeOptions(5002), quiet);
  lib.onTurnEvent("session_start", {}, {}, 6000);
  assert.deepEqual(lib.wakeOptions(6001), wake, "a new or switched session starts clean");
  lib.resetTurn();
});

test("lib: the poller posts with the wake options of the moment it delivers", async () => {
  lib.resetTurn();
  const rec = { id: "a-0000ab02", kind: "shell", title: "t", status: "done", endedAt: 31, resultText: "r" };
  let rounds = 0;
  const out = [];
  lib.onTurnEvent("input", {}, {}, Date.now());
  const p = lib.ensurePoller({
    client: { wait: async () => (++rounds === 1 ? { finished: [rec], pending: [] } : { finished: [], pending: [] }), delivered: async () => true },
    parentSessionId: "lib-wake", pi: { sendMessage: (m, o) => out.push(o) }, sleep: async () => {},
  });
  await p.done;
  assert.deepEqual(out, [{ triggerTurn: false }], "a prompt was starting: no second run");
  lib.confirmDelivered(rec.id);
  lib.resetTurn();
});

test("lib: a report that cannot be posted (a stale pi) stays unclaimed and undelivered for the next poller", async () => {
  const rec = { id: "a-0000000b", kind: "pi", title: "t", status: "done", endedAt: 11, resultText: "r" };
  const acks = [];
  let calls = 0;
  const stale = new lib.DeliveryPoller({
    client: { wait: async () => ({ finished: [rec], pending: [] }), delivered: async (id) => { acks.push(id); return true; } },
    parentSessionId: "lib-stale", sleep: async () => {},
    deliver: () => { calls++; throw new Error("This extension ctx is stale after session replacement"); },
  }).start();
  await stale.done;
  assert.equal(calls, 1, "a throwing pi ends the poller instead of spinning");
  assert.deepEqual(acks, [], "not acked: the server keeps it undelivered");
  const out = [];
  let n = 0;
  const next = new lib.DeliveryPoller({
    client: { wait: async () => (n++ ? { finished: [], pending: [] } : { finished: [rec], pending: [] }), delivered: async (id) => { acks.push(id); return true; } },
    parentSessionId: "lib-stale", deliver: (r) => out.push(r.id),
  }).start();
  await next.done;
  assert.deepEqual(out, [rec.id], "the next poller (session_start) posts it");
  assert.deepEqual(acks, [], "acked only once its message_end shows it in the session");
  lib.confirmDelivered(rec.id);

  // stop() in the middle of a batch: the rest of the batch is left for later, not posted through a dead pi.
  const a = { id: "a-0000000c", kind: "pi", status: "done", endedAt: 1 }, b = { id: "a-0000000d", kind: "pi", status: "done", endedAt: 1 };
  const got = [];
  let p3;
  p3 = new lib.DeliveryPoller({ client: { wait: async () => ({ finished: [a, b], pending: [] }), delivered: async () => true }, parentSessionId: "lib-stop-batch", deliver: (r) => { got.push(r.id); p3.stop(); } }).start();
  await p3.done;
  assert.deepEqual(got, [a.id]);
  assert.equal(lib.claim(b), true, "b was never claimed");
});

test("lib: request chunks stay under pi's httpIdleTimeoutMs (read from pi's settings.json)", async () => {
  assert.equal(lib.chunkSecFor(undefined), 240, "pi's default 300 s");
  assert.equal(lib.chunkSecFor(0), 240, "disabled");
  assert.equal(lib.chunkSecFor(600000), 240);
  assert.equal(lib.chunkSecFor(300000), 240);
  assert.equal(lib.chunkSecFor(120000), 105);
  assert.equal(lib.chunkSecFor(60000), 45);
  assert.equal(lib.chunkSecFor(30000), 15);
  assert.equal(lib.chunkSecFor(4000), 2);
  assert.equal(lib.chunkSecFor(1000), 1);
  const home = mkdtempSync(join(tmpdir(), "omni-agents-http-"));
  const cwd = mkdtempSync(join(tmpdir(), "omni-agents-proj-"));
  try {
    const at = { home, env: {}, cwd };
    assert.equal(lib.piHttpTimeoutMs(at), undefined, "no settings");
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(join(home, ".pi", "agent", "settings.json"), JSON.stringify({ httpIdleTimeoutMs: 60000 }));
    assert.equal(lib.piHttpTimeoutMs(at), 60000);
    writeFileSync(join(home, ".pi", "agent", "settings.json"), JSON.stringify({ httpIdleTimeoutMs: "disabled" }));
    assert.equal(lib.piHttpTimeoutMs(at), 0);
    writeFileSync(join(home, ".pi", "agent", "settings.json"), JSON.stringify({ httpIdleTimeoutMs: "junk" }));
    assert.equal(lib.piHttpTimeoutMs(at), undefined);
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ httpIdleTimeoutMs: 120000 }));
    assert.equal(lib.piHttpTimeoutMs(at), 120000, "the project's settings win, as in pi");
    const other = join(home, "elsewhere");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "settings.json"), JSON.stringify({ httpIdleTimeoutMs: 30000 }));
    assert.equal(lib.piHttpTimeoutMs({ home, env: { PI_CODING_AGENT_DIR: other }, cwd: home }), 30000, "PI_CODING_AGENT_DIR moves pi's settings");
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(cwd, { recursive: true, force: true }); }
  // The client carries the chunk; the waits and the poller use it.
  const s = scriptedClient(() => ({ pending: [{ id: "a-1", status: "running" }] }));
  s.client.chunkSec = 45;
  await lib.waitAgents(s.client, { ids: ["a-1"], timeoutMs: 100000, now: s.now, sleep: s.sleep });
  assert.deepEqual(s.calls, [45, 45, 10]);
  assert.equal(new lib.AgentsClient({ base: "http://127.0.0.1:1", chunkSec: 45 }).chunkSec, 45);
  assert.equal(new lib.AgentsClient({ base: "http://127.0.0.1:1" }).chunkSec, 240);
  assert.equal(new lib.DeliveryPoller({ client: { chunkSec: 45 }, parentSessionId: "x", deliver() {} }).chunkSec, 45);
});
