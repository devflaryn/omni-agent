/**
 * Background agents for pi: the omni-agents extension (agent_* / job_* tools and the delivery poller that
 * posts a finished agent's report into the chat) and claude_task (omni-claude.ts), both driven against a
 * fake Omni server that implements the /api/agents contract on a real local http server. The shared lib
 * (omni-agents-lib.mjs) is also driven directly with fake clients and clocks. The extensions load through
 * node's type stripping; pi's own packages resolve from the installed pi (skipped when it is not installed).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { registerHooks } from "node:module";
import { ROOT, findPiCli } from "../server/config.mjs";
import * as lib from "../integrations/pi/omni-agents-lib.mjs";

const AGENTS_EXT = join(ROOT, "integrations", "pi", "omni-agents.ts");
const CLAUDE_EXT = join(ROOT, "integrations", "pi", "omni-claude.ts");
const piCli = findPiCli();
const skip = !piCli && "pi is not installed";
/** Extension tests: skipped without pi; none may hang the file. */
const ext = { skip, timeout: 20000 };
// Run from inside an Omni agent, these would point the extensions at the real server: never.
delete process.env.OMNI_AGENT_URL;
delete process.env.OMNI_AGENT_DEPTH;

if (piCli) {
  // Bare imports inside the extensions (`typebox`, `@earendil-works/pi-tui`, …) resolve as if from pi's cli.js.
  const exts = new Set([AGENTS_EXT, CLAUDE_EXT].map((f) => pathToFileURL(f).href));
  registerHooks({
    resolve(specifier, context, next) {
      if (exts.has(String(context.parentURL || "").split("?")[0]) && !specifier.startsWith(".") && !specifier.startsWith("node:") && !specifier.startsWith("file:")) {
        return next(specifier, { ...context, parentURL: pathToFileURL(piCli).href });
      }
      return next(specifier, context);
    },
  });
}

const FIN = new Set(["done", "error", "cancelled", "timeout", "interrupted", "stalled"]);
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
async function until(cond, what = "condition", ms = 5000) {
  const end = Date.now() + ms;
  while (!(await cond())) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await tick(); }
}

/** The /api/agents routes of WS-D's contract, in memory; waits are held until a selected agent finishes. */
async function fakeOmni() {
  const agents = new Map();
  const calls = [];
  const waiters = new Set();
  let n = 0;
  let abortedWaits = 0;
  let down = false;
  const kick = () => { for (const w of [...waiters]) w(); };
  const pub = (a) => ({ ...a });
  const selected = (b) => [...agents.values()].filter((a) => (b.ids?.length ? b.ids.includes(a.id) : a.parentSessionId === b.parentSessionId));
  const snapshot = (b) => {
    const sel = selected(b);
    return { finished: sel.filter((a) => FIN.has(a.status) && (!b.undeliveredOnly || !a.delivered)).map(pub), pending: sel.filter((a) => !FIN.has(a.status)).map(pub) };
  };
  /** Hold the response until `ready()` or `ms`; false when the client went away first. */
  const hold = (res, ms, ready) => new Promise((resolve) => {
    if (ready()) return resolve(true);
    const done = (v) => { clearTimeout(t); waiters.delete(w); res.off("close", onClose); resolve(v); };
    const w = () => { if (ready()) done(true); };
    const onClose = () => { if (!res.writableEnded) { abortedWaits++; done(false); } };
    const t = setTimeout(() => done(true), ms);
    waiters.add(w);
    res.on("close", onClose);
  });
  const server = http.createServer(async (req, res) => {
    if (down) { req.socket.destroy(); return; }
    const url = new URL(req.url, "http://127.0.0.1");
    const p = url.pathname;
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    calls.push({ method: req.method, path: p, query: Object.fromEntries(url.searchParams), body });
    const send = (code, j) => { if (res.destroyed) return; res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(j)); };
    const ms = Math.min(300, Number(body.timeoutSec) || 1) * 1000;
    if (req.method === "POST" && p === "/api/agents") {
      if (!body.task && !body.command) return send(400, { error: "a task is required" });
      if ((Number(body.depth) || 0) + 1 > 2) return send(400, { error: "agent depth limit reached (maxDepth 2)" });
      const id = `a-${(++n).toString(16).padStart(8, "0")}`;
      const a = { id, kind: body.kind || "pi", title: body.title, task: body.task, command: body.command, cwd: body.cwd, model: body.model, parentSid: body.parentSid, parentSessionId: body.parentSessionId, depth: body.depth, status: "running", startedAt: Date.now(), endedAt: null, sid: `pi:${id}`, sessionId: `sess-${id}`, resultText: "", activity: [], delivered: false, log: "" };
      agents.set(id, a);
      kick();
      return send(200, { agent: pub(a) });
    }
    if (req.method === "GET" && p === "/api/agents") {
      let list = [...agents.values()];
      if (url.searchParams.get("parentSession")) list = list.filter((a) => a.parentSessionId === url.searchParams.get("parentSession"));
      if (url.searchParams.get("active")) list = list.filter((a) => !FIN.has(a.status));
      return send(200, { agents: list.reverse().map(pub) });
    }
    if (req.method === "GET" && p === "/api/agents/undelivered") {
      return send(200, { agents: [...agents.values()].filter((a) => a.parentSessionId === url.searchParams.get("parentSession") && FIN.has(a.status) && !a.delivered).map(pub) });
    }
    if (req.method === "POST" && p === "/api/agents/wait") {
      const first = snapshot(body);
      if (!first.finished.length && first.pending.length && !(await hold(res, ms, () => snapshot(body).finished.length > 0))) return;
      return send(200, snapshot(body));
    }
    const m = p.match(/^\/api\/agents\/([^/]+)(?:\/([a-z-]+))?$/);
    const a = m && agents.get(decodeURIComponent(m[1]));
    if (!a) return send(404, { error: "no such agent" });
    const tail = (k) => a.log.split("\n").filter(Boolean).slice(-k).join("\n");
    if (!m[2] && req.method === "GET") return send(200, { agent: pub(a) });
    if (m[2] === "log") return send(200, { text: tail(Number(url.searchParams.get("tail")) || 80) });
    if (m[2] === "wait-log") {
      const re = body.until ? new RegExp(body.until) : null;
      const ready = () => !!(re && re.test(a.log)) || FIN.has(a.status);
      if (!(await hold(res, ms, ready))) return;
      return send(200, { matched: !!(re && re.test(a.log)), status: a.status, tail: tail(20) });
    }
    if (m[2] === "message") {
      const how = FIN.has(a.status) ? "resumed" : "followUp";
      if (how === "resumed") Object.assign(a, { status: "running", endedAt: null, delivered: false });
      kick();
      return send(200, { ok: true, how });
    }
    if (m[2] === "cancel") {
      // Like AgentManager: a finished agent is left as it is, and the held waits are answered BEFORE the
      // cancel itself (its "change" event resolves them synchronously), so a poller that is not held sees it first.
      if (!FIN.has(a.status)) Object.assign(a, { status: "cancelled", endedAt: Date.now() });
      kick();
      await tick(40);
      return send(200, { agent: pub(a) });
    }
    if (m[2] === "delivered") { a.delivered = true; return send(200, { ok: true }); }
    return send(404, { error: "unknown agents route" });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: server.address().port, agents, calls,
    get abortedWaits() { return abortedWaits; },
    set down(v) { down = v; },
    to: (path, method) => calls.filter((c) => c.path === path && (!method || c.method === method)),
    add(rec) { agents.set(rec.id, { kind: "pi", status: "running", activity: [], delivered: false, log: "", resultText: "", ...rec }); kick(); },
    finish(id, patch = {}) { Object.assign(agents.get(id), { status: "done", endedAt: Date.now(), ...patch }); kick(); },
    update(id, patch) { Object.assign(agents.get(id), patch); kick(); },
    close() { server.closeAllConnections(); return new Promise((r) => server.close(r)); },
  };
}

/** Load an extension with ~/.pi/agent/omni-agent.json pointing at `port` (and pi's own `settings`), on a scripted ExtensionAPI. */
async function loadExt(file, port, { settings } = {}) {
  const home = mkdtempSync(join(tmpdir(), "omni-agents-"));
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  writeFileSync(join(home, ".pi", "agent", "omni-agent.json"), JSON.stringify({ port }));
  if (settings) writeFileSync(join(home, ".pi", "agent", "settings.json"), JSON.stringify(settings));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
  process.env.HOME = home; process.env.USERPROFILE = home;
  delete process.env.PI_CODING_AGENT_DIR;
  const tools = new Map(), events = new Map(), sent = [];
  // Like pi: a posted custom message reaches the session (message_end) right away when the chat is idle.
  const api = {
    registerTool: (t) => tools.set(t.name, t), on: (name, fn) => events.set(name, fn),
    sendMessage: (m, options) => { sent.push({ ...m, options }); setTimeout(() => events.get("message_end")?.({ type: "message_end", message: { role: "custom", customType: m.customType, content: m.content, details: m.details } }), 0); },
  };
  try {
    const mod = await import(pathToFileURL(file).href);
    await mod.default(api);
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(home, { recursive: true, force: true });
  }
  const run = (name, params, { ctx, signal, onUpdate } = {}) => tools.get(name).execute("call-1", params, signal, onUpdate, ctx);
  const shutdown = () => events.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" });
  return { api, tools, events, sent, run, shutdown };
}

const ctxFor = (sessionId) => ({ cwd: "C:/work", sessionManager: { getSessionId: () => sessionId }, model: { provider: "openrouter", id: "deepseek/deepseek-v4-flash-0731" } });
const textOf = (r) => r.content.map((c) => c.text).join("\n");

// ---------------------------------------------------------------- the lib, no pi needed

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
  assert.equal(lib.statusLine(rec, t0 + 65000), "a-00000001 · pi agent · running · 1m05s · Scan the offsets — last: read(src/a.ts)");
  const job = { id: "a-00000002", kind: "shell", command: "npm run build", title: "npm run build", status: "error", exitCode: 2, startedAt: t0, endedAt: t0 + 9000, resultText: "x\n".repeat(10) + "error TS2304" };
  assert.match(lib.statusLine(job), /job · error \(exit 2\) · 9s · npm run build/);
  const jr = lib.agentReport(job);
  assert.match(jr, /^Background job a-00000002 "npm run build" finished: error \(exit 2\) after 9s\.\n\nLog tail:\n/);
  assert.match(jr, /error TS2304$/);
  const big = { ...rec, status: "done", endedAt: t0 + 252000, resultText: "R".repeat(50000) };
  const report = lib.agentReport(big, { max: lib.MAX_REPORT });
  assert.ok(report.length <= lib.MAX_REPORT, `report ${report.length} ≤ ${lib.MAX_REPORT}`);
  assert.match(report, /^Background pi agent a-00000001 "Scan the offsets" finished: done after 4m12s\./);
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

// ---------------------------------------------------------------- the extensions, on the fake server

test("omni-agents: registers the agent and job tools with guidance on when to use them", ext, async () => {
  const x = await loadExt(AGENTS_EXT, 1);
  assert.deepEqual([...x.tools.keys()].sort(), ["agent_cancel", "agent_message", "agent_start", "agent_status", "agent_wait", "job_kill", "job_output", "job_start", "job_wait"]);
  for (const t of x.tools.values()) { assert.ok(t.description && t.promptSnippet && t.parameters, `${t.name} documented`); }
  const g = x.tools.get("agent_start").promptGuidelines.join("\n");
  assert.match(g, /parallel/);
  assert.match(g, /kind "claude"/);
  assert.match(g, /self-contained/);
  assert.match(g, /keep working/i);
  assert.match(g, /arrives by itself/);
  assert.match(x.tools.get("job_start").promptGuidelines.join("\n"), /job_start[\s\S]*job_wait[\s\S]*never `sleep`-poll/);
  assert.ok(x.events.has("session_start") && x.events.has("session_shutdown"));
});

test("omni-agents: agent_start returns at once with the chat's identity; the poller posts the report and acks it", ext, async () => {
  const fake = await fakeOmni();
  const x = await loadExt(AGENTS_EXT, fake.port);
  const sid = "s-start";
  process.env.OMNI_AGENT_DEPTH = "1";
  try {
    const r = await x.run("agent_start", { task: "Find every caller of   decodeRecord in src/ and report file:line" }, { ctx: ctxFor(sid) });
    delete process.env.OMNI_AGENT_DEPTH;
    const id = r.details.id;
    assert.match(id, /^a-[0-9a-f]{8}$/);
    assert.match(textOf(r), new RegExp(`^Started pi agent ${id} ".+" — it runs in the background; its report arrives as a message when it finishes\\. Keep working\\.`));
    const body = fake.to("/api/agents", "POST")[0].body;
    assert.deepEqual(body, {
      kind: "pi", task: "Find every caller of   decodeRecord in src/ and report file:line", title: "Find every caller of decodeRecord in src/ and report file:l…",
      cwd: "C:/work", model: "deepseek/deepseek-v4-flash-0731", provider: "openrouter", parentSid: "pi:s-start", parentSessionId: "s-start", depth: 1,
    });
    await until(() => fake.to("/api/agents/wait").length >= 1, "the poller's wait");
    const w = fake.to("/api/agents/wait")[0].body;
    assert.deepEqual(w, { parentSessionId: "s-start", undeliveredOnly: true, timeoutSec: 240 });
    assert.equal(x.sent.length, 0);
    fake.finish(id, { resultText: "src/a.ts:12\nsrc/b.ts:40" });
    await until(() => x.sent.length === 1, "the report message");
    const m = x.sent[0];
    assert.equal(m.customType, "omni-agent-result");
    assert.equal(m.display, true);
    assert.deepEqual(m.details, { id, status: "done" });
    assert.deepEqual(m.options, { triggerTurn: true, deliverAs: "followUp" });
    assert.match(m.content, new RegExp(`^Background pi agent ${id} "Find every caller.+" finished: done`));
    assert.match(m.content, /src\/a\.ts:12\nsrc\/b\.ts:40/);
    await until(() => fake.agents.get(id).delivered, "the delivered ack");
    await until(() => !lib.pollerFor(sid), "the poller ends once nothing is running or undelivered");
    await tick(50);
    assert.equal(x.sent.length, 1, "delivered once");
  } finally { delete process.env.OMNI_AGENT_DEPTH; x.shutdown(); await fake.close(); }
});

test("omni-agents: a claude agent or a persona does not inherit the chat's model; the depth limit is the server's error", ext, async () => {
  const fake = await fakeOmni();
  const x = await loadExt(AGENTS_EXT, fake.port);
  try {
    await x.run("agent_start", { task: "refactor the parser", kind: "claude", title: "Parser refactor", cwd: "D:/repo" }, { ctx: ctxFor("s-kinds") });
    await x.run("agent_start", { task: "scout the repo", agent: "scout", thinking: "high" }, { ctx: ctxFor("s-kinds") });
    const [c, s] = fake.to("/api/agents", "POST").map((q) => q.body);
    assert.equal(c.kind, "claude");
    assert.equal(c.title, "Parser refactor");
    assert.equal(c.cwd, "D:/repo");
    assert.equal(c.model, undefined, "Claude Code picks its own default");
    assert.equal(c.thinking, undefined);
    assert.equal(s.agent, "scout");
    assert.equal(s.model, undefined, "the persona may pin its own model");
    assert.equal(s.thinking, "high");
    process.env.OMNI_AGENT_DEPTH = "2";
    await assert.rejects(x.run("agent_start", { task: "go deeper" }, { ctx: ctxFor("s-kinds") }), /depth limit/);
  } finally { delete process.env.OMNI_AGENT_DEPTH; x.shutdown(); await fake.close(); }
});

test("omni-agents: agent_wait returns the report, marks it delivered, and the poller does not post it again", ext, async () => {
  const fake = await fakeOmni();
  const x = await loadExt(AGENTS_EXT, fake.port);
  const sid = "s-wait";
  try {
    const id = (await x.run("agent_start", { task: "measure fps" }, { ctx: ctxFor(sid) })).details.id;
    await until(() => fake.to("/api/agents/wait").length >= 1, "the poller's wait");
    const p = x.run("agent_wait", {}, { ctx: ctxFor(sid) });
    await until(() => fake.abortedWaits >= 1, "the poller steps aside while agent_wait waits");
    await until(() => fake.to("/api/agents/wait").length >= 2, "agent_wait's own request");
    fake.finish(id, { resultText: "52 fps in-world" });
    const r = await p;
    assert.match(textOf(r), new RegExp(`Background pi agent ${id} "measure fps" finished: done`));
    assert.match(textOf(r), /52 fps in-world/);
    assert.deepEqual(r.details.finished, [{ id, status: "done" }]);
    const own = fake.to("/api/agents/wait")[1].body;
    assert.deepEqual(own, { parentSessionId: sid, undeliveredOnly: true, timeoutSec: 240 }, "no ids: any of this chat's unreported agents, in a 240 s chunk");
    assert.equal(fake.agents.get(id).delivered, true);
    await until(() => !lib.pollerFor(sid), "the poller ends");
    assert.equal(x.sent.length, 0, "no duplicate wake-up message");
  } finally { x.shutdown(); await fake.close(); }
});

test("omni-agents: agent_wait times out with a heartbeat and leaves the agent running; an abort stops waiting at once", ext, async () => {
  const fake = await fakeOmni();
  const x = await loadExt(AGENTS_EXT, fake.port);
  const sid = "s-wait-timeout";
  try {
    const id = (await x.run("agent_start", { task: "long scan" }, { ctx: ctxFor(sid) })).details.id;
    const beats = [];
    const r = await x.run("agent_wait", { ids: [id], timeoutSeconds: 1 }, { ctx: ctxFor(sid), onUpdate: (u) => beats.push(textOf(u)) });
    assert.equal(r.details.timedOut, true);
    assert.match(textOf(r), new RegExp(`No agent finished within 1s\\.[\\s\\S]*Still running:\\n${id} · pi agent · running`));
    assert.ok(beats.length >= 1 && beats[0].includes(id), "heartbeat while waiting");
    const own = fake.to("/api/agents/wait").find((c) => c.body.ids);
    assert.deepEqual(own.body, { ids: [id], undeliveredOnly: true, timeoutSec: 1 }, "an already-reported agent is not waited for again");
    assert.equal(fake.agents.get(id).status, "running", "a wait timeout never cancels");
    assert.equal(fake.to(`/api/agents/${id}/cancel`).length, 0);
    const ac = new AbortController();
    const before = fake.abortedWaits;
    const p = x.run("agent_wait", { ids: [id], timeoutSeconds: 3600 }, { ctx: ctxFor(sid), signal: ac.signal });
    await until(() => fake.to("/api/agents/wait").filter((c) => c.body.timeoutSec === 240 && c.body.ids).length === 1, "the long wait request");
    const t0 = Date.now();
    ac.abort();
    const ab = await p;
    assert.ok(Date.now() - t0 < 2000, "returns promptly");
    assert.equal(ab.details.aborted, true);
    assert.match(textOf(ab), /Stopped waiting/);
    await until(() => fake.abortedWaits > before, "the request was dropped");
    assert.equal(fake.agents.get(id).status, "running");
  } finally { x.shutdown(); await fake.close(); }
});

test("omni-agents: agent_wait {ids} skips the ones already reported and waits for the rest; all reported → says so at once", ext, async () => {
  const fake = await fakeOmni();
  const x = await loadExt(AGENTS_EXT, fake.port);
  const sid = "s-wait-ids";
  try {
    const fast = (await x.run("agent_start", { task: "quick check", title: "fast" }, { ctx: ctxFor(sid) })).details.id;
    const slow = (await x.run("agent_start", { task: "long scan", title: "slow" }, { ctx: ctxFor(sid) })).details.id;
    fake.finish(fast, { resultText: "fast result" });
    await until(() => x.sent.length === 1 && fake.agents.get(fast).delivered, "the poller reports fast");
    const p = x.run("agent_wait", { ids: [fast, slow], timeoutSeconds: 30 }, { ctx: ctxFor(sid) });
    await until(() => fake.to("/api/agents/wait").some((c) => c.body.ids?.length === 2), "agent_wait's request");
    await tick(100);
    let settled = false;
    p.then(() => { settled = true; }, () => { settled = true; });
    await tick(20);
    assert.equal(settled, false, "fast's report is not handed back again: it waits for slow");
    assert.deepEqual(fake.to("/api/agents/wait").find((c) => c.body.ids?.length === 2).body, { ids: [fast, slow], undeliveredOnly: true, timeoutSec: 30 });
    fake.finish(slow, { resultText: "slow result" });
    const r = await p;
    assert.deepEqual(r.details.finished, [{ id: slow, status: "done" }]);
    assert.match(textOf(r), /slow result/);
    assert.doesNotMatch(textOf(r), /fast result/);
    const t0 = Date.now();
    const again = await x.run("agent_wait", { ids: [fast, slow, "a-nope"] }, { ctx: ctxFor(sid) });
    assert.ok(Date.now() - t0 < 2000, "nothing to wait for: at once");
    assert.match(textOf(again), new RegExp(`^Nothing to wait for: already finished and reported \\(agent_status <id> shows a result again\\):\\n${fast} · pi agent · done[^\\n]*fast\\n${slow} · pi agent · done[^\\n]*slow\\nNo such agent: a-nope$`));
    assert.deepEqual(again.details, { finished: [], reported: [fast, slow], unknown: ["a-nope"] });
    assert.equal(x.sent.length, 1, "slow was reported by agent_wait, not as a message too");
  } finally { x.shutdown(); await fake.close(); }
});

test("omni-agents: agent_cancel / job_kill hold the poller, so a stop the model asked for never comes back as a wake-up message", ext, async () => {
  const fake = await fakeOmni();
  const x = await loadExt(AGENTS_EXT, fake.port);
  const sid = "s-cancel-race";
  try {
    const keep = (await x.run("job_start", { command: "sleep 600", title: "keep" }, { ctx: ctxFor(sid) })).details.id;
    const kill = (await x.run("job_start", { command: "sleep 600", title: "kill me" }, { ctx: ctxFor(sid) })).details.id;
    const agent = (await x.run("agent_start", { task: "explore", title: "explore" }, { ctx: ctxFor(sid) })).details.id;
    await until(() => fake.to("/api/agents/wait").length >= 1, "the poller's long poll");
    await tick(50);
    const k = await x.run("job_kill", { id: kill }, { ctx: ctxFor(sid) });
    assert.match(textOf(k), new RegExp(`^Stopped job ${kill} "kill me" \\(cancelled\\)\\.$`));
    const c = await x.run("agent_cancel", { id: agent }, { ctx: ctxFor(sid) });
    assert.match(textOf(c), new RegExp(`^Stopped pi agent ${agent} "explore" \\(cancelled\\)\\.$`));
    // The poller is released after agent_cancel's ack: its next long poll comes after that call.
    const ackAt = fake.calls.findLastIndex((q) => q.path === `/api/agents/${agent}/delivered`);
    assert.ok(ackAt >= 0, "agent_cancel acked it");
    await until(() => fake.calls.slice(ackAt + 1).some((q) => q.path === "/api/agents/wait" && q.body.undeliveredOnly && !q.body.ids), "the poller is back");
    await tick(100);
    assert.deepEqual(x.sent, [], "no message for either stop");
    assert.equal(fake.agents.get(kill).delivered, true);
    assert.equal(fake.agents.get(agent).delivered, true);
    assert.equal(fake.agents.get(keep).status, "running");
  } finally { x.shutdown(); await fake.close(); }
});

test("omni-agents: job_kill on a job that already ended (its report not out yet) returns the report instead of swallowing it", ext, async () => {
  const fake = await fakeOmni();
  const x = await loadExt(AGENTS_EXT, fake.port);
  const sid = "s-kill-ended";
  const hold = lib.pausePoller(sid); // another tool of this chat is waiting, so the poller does not post it
  try {
    const id = (await x.run("job_start", { command: "./compute", title: "compute" }, { ctx: ctxFor(sid) })).details.id;
    fake.finish(id, { status: "error", exitCode: 3, error: "exit code 3", resultText: "RESULT 42" });
    const k = await x.run("job_kill", { id }, { ctx: ctxFor(sid) });
    assert.match(textOf(k), new RegExp(`^Job ${id} had already ended, so nothing was stopped\\. Its report:\\n\\nBackground job ${id} "compute" finished: error \\(exit 3\\)`));
    assert.match(textOf(k), /RESULT 42/);
    assert.equal(k.details.status, "error");
    assert.equal(fake.agents.get(id).status, "error", "a finished job stays as it ended");
    hold();
    await until(() => !lib.pollerFor(sid), "the poller ends");
    assert.deepEqual(x.sent, [], "and it is not posted a second time");
  } finally { hold(); x.shutdown(); await fake.close(); }
});

test("omni-agents: every long request stays under pi's httpIdleTimeoutMs", ext, async () => {
  const fake = await fakeOmni();
  const x = await loadExt(AGENTS_EXT, fake.port, { settings: { httpIdleTimeoutMs: 60000 } });
  const sid = "s-chunk";
  try {
    const id = (await x.run("agent_start", { task: "t" }, { ctx: ctxFor(sid) })).details.id;
    await until(() => fake.to("/api/agents/wait").length >= 1, "the poller's wait");
    assert.equal(fake.to("/api/agents/wait")[0].body.timeoutSec, 45, "a 60 s pi timeout: 45 s requests");
    const p = x.run("agent_wait", { ids: [id], timeoutSeconds: 600 }, { ctx: ctxFor(sid) });
    await until(() => fake.to("/api/agents/wait").some((c) => c.body.ids), "agent_wait's request");
    assert.equal(fake.to("/api/agents/wait").find((c) => c.body.ids).body.timeoutSec, 45);
    fake.finish(id);
    await p;
  } finally { x.shutdown(); await fake.close(); }
});

test("omni-agents: agent_status, agent_message (a finished agent resumes and reports again), agent_cancel", ext, async () => {
  const fake = await fakeOmni();
  const x = await loadExt(AGENTS_EXT, fake.port);
  const sid = "s-msg";
  try {
    const id = (await x.run("agent_start", { task: "write the decoder", title: "Decoder" }, { ctx: ctxFor(sid) })).details.id;
    const other = (await x.run("agent_start", { task: "write the tests", title: "Tests" }, { ctx: ctxFor(sid) })).details.id;
    fake.update(id, { activity: ["edit(src/decoder.ts)"] });
    const all = await x.run("agent_status", {}, { ctx: ctxFor(sid) });
    assert.match(textOf(all), /^2 background agents\/jobs, 2 active:/);
    assert.match(textOf(all), new RegExp(`${id} · pi agent · running · \\d+s · Decoder — last: edit\\(src/decoder\\.ts\\)`));
    assert.equal(fake.to("/api/agents", "GET")[0].query.parentSession, sid);
    const one = await x.run("agent_status", { id }, { ctx: ctxFor(sid) });
    assert.match(textOf(one), /task: write the decoder\n[\s\S]*recent activity:\n {2}- edit\(src\/decoder\.ts\)/);
    await assert.rejects(x.run("agent_status", { id: "a-nope" }, { ctx: ctxFor(sid) }), /no such agent/);

    fake.finish(id, { resultText: "decoder v1", endedAt: 1000 });
    await until(() => x.sent.length === 1, "first report");
    const listed = await x.run("agent_status", {}, { ctx: ctxFor(sid) });
    assert.match(textOf(listed), new RegExp(`${id} · pi agent · done · [^\\n]*Decoder — last: edit\\(src/decoder\\.ts\\)\\n {4}→ decoder v1`), "a finished agent's result preview");
    const msg =await x.run("agent_message", { id, message: "also handle v2 records" }, { ctx: ctxFor(sid) });
    assert.equal(msg.details.how, "resumed");
    assert.match(textOf(msg), /had finished and is running again/);
    assert.deepEqual(fake.to(`/api/agents/${id}/message`)[0].body, { text: "also handle v2 records" });
    fake.finish(id, { resultText: "decoder v2", endedAt: 2000 });
    await until(() => x.sent.length === 2, "the resumed run reports again");
    assert.match(x.sent[1].content, /decoder v2/);

    const c = await x.run("agent_cancel", { id: other }, { ctx: ctxFor(sid) });
    assert.match(textOf(c), new RegExp(`Stopped pi agent ${other} "Tests" \\(cancelled\\)`));
    assert.equal(fake.agents.get(other).delivered, true, "a cancel the model asked for is not reported back");
    await until(() => !lib.pollerFor(sid), "the poller ends");
    assert.equal(x.sent.length, 2);
  } finally { x.shutdown(); await fake.close(); }
});

test("omni-agents: job_start / job_wait for a log line / job_output / job_kill", ext, async () => {
  const fake = await fakeOmni();
  const x = await loadExt(AGENTS_EXT, fake.port);
  const sid = "s-jobs";
  try {
    const r = await x.run("job_start", { command: "cargo build --release" }, { ctx: ctxFor(sid) });
    const id = r.details.id;
    assert.match(textOf(r), new RegExp(`^Started job ${id} "cargo build --release" in the background\\. job_wait`));
    assert.deepEqual(fake.to("/api/agents", "POST")[0].body, { kind: "shell", command: "cargo build --release", cwd: "C:/work", title: "cargo build --release", timeoutMinutes: 120, parentSid: "pi:s-jobs", parentSessionId: sid, depth: 0 });
    const p = x.run("job_wait", { id, until: "Finished|error:", timeoutSeconds: 30 }, { ctx: ctxFor(sid) });
    await until(() => fake.to(`/api/agents/${id}/wait-log`).length === 1, "the wait-log request");
    assert.deepEqual(fake.to(`/api/agents/${id}/wait-log`)[0].body, { until: "Finished|error:", timeoutSec: 30 });
    fake.update(id, { log: "Compiling a\nCompiling b\nFinished release\n" });
    const w = await p;
    assert.equal(w.details.matched, true);
    assert.match(textOf(w), new RegExp(`^Job ${id}: the log matched /Finished\\|error:/ \\(still running\\)\\.\\n\\n--- log tail ---\\nCompiling a\\nCompiling b\\nFinished release$`));
    assert.equal(fake.agents.get(id).delivered, false, "still running: nothing to mark");
    const o = await x.run("job_output", { id, tail: 1 }, { ctx: ctxFor(sid) });
    assert.equal(fake.to(`/api/agents/${id}/log`)[0].query.tail, "1");
    assert.match(textOf(o), new RegExp(`^${id} · job · running · \\d+s · cargo build --release\\n--- last 1 lines ---\\nFinished release$`));
    fake.finish(id, { status: "error", exitCode: 101, resultText: "error: linker failed" });
    const ended = await x.run("job_wait", { id, timeoutSeconds: 5 }, { ctx: ctxFor(sid) });
    assert.match(textOf(ended), new RegExp(`^Job ${id} ended: error \\(exit 101\\) after \\d+s\\.`));
    assert.equal(fake.agents.get(id).delivered, true, "the model saw the exit: no second report");
    const id2 = (await x.run("job_start", { command: "sleep 9999", title: "idle", timeoutMinutes: 5 }, { ctx: ctxFor(sid) })).details.id;
    assert.equal(fake.to("/api/agents", "POST")[1].body.timeoutMinutes, 5);
    const k = await x.run("job_kill", { id: id2 }, { ctx: ctxFor(sid) });
    assert.match(textOf(k), new RegExp(`Stopped job ${id2} "idle" \\(cancelled\\)`));
    await until(() => !lib.pollerFor(sid), "the poller ends");
    assert.equal(x.sent.length, 0);
  } finally { x.shutdown(); await fake.close(); }
});

test("omni-agents: session_start resumes delivery of reports the chat has not seen; nothing to resume starts no poller", ext, async () => {
  const fake = await fakeOmni();
  const x = await loadExt(AGENTS_EXT, fake.port);
  try {
    fake.add({ id: "a-0000aaaa", parentSessionId: "s-resume", title: "overnight scan", status: "done", startedAt: Date.now() - 60000, endedAt: Date.now(), resultText: "found it" });
    await x.events.get("session_start")({ type: "session_start", reason: "startup" }, ctxFor("s-resume"));
    await until(() => x.sent.length === 1, "the pending report");
    assert.match(x.sent[0].content, /overnight scan[\s\S]*found it/);
    await until(() => fake.agents.get("a-0000aaaa").delivered, "acked");
    await x.events.get("session_start")({ type: "session_start", reason: "startup" }, ctxFor("s-empty"));
    await until(() => fake.to("/api/agents/undelivered").length === 2, "the check");
    await tick(50);
    assert.equal(fake.to("/api/agents/wait").filter((c) => c.body.parentSessionId === "s-empty").length, 0, "no poller for a chat without agents");
  } finally { x.shutdown(); await fake.close(); }
});

test("omni-agents: session_shutdown stops the poller and drops its request; Omni down is a clear error", ext, async () => {
  const fake = await fakeOmni();
  const x = await loadExt(AGENTS_EXT, fake.port);
  const sid = "s-shutdown";
  try {
    await x.run("agent_start", { task: "t" }, { ctx: ctxFor(sid) });
    await until(() => fake.to("/api/agents/wait").length === 1, "the poller's wait");
    x.shutdown();
    await until(() => fake.abortedWaits === 1, "the request is dropped");
    assert.equal(lib.pollerFor(sid), undefined);
    fake.down = true;
    await assert.rejects(x.run("agent_start", { task: "t" }, { ctx: ctxFor(sid) }), /Omni Agent is not reachable on http:\/\/127\.0\.0\.1:\d+ .*Start it, then retry/);
  } finally { x.shutdown(); await fake.close(); }
});

test("claude_task: runs as a claude agent under this chat and returns the answer with the session footer", ext, async () => {
  const fake = await fakeOmni();
  const x = await loadExt(CLAUDE_EXT, fake.port);
  const sid = "s-claude";
  try {
    assert.deepEqual([...x.tools.keys()], ["claude_task"]);
    const p = x.run("claude_task", { task: "Fix the flaky   test in test/a.test.mjs", resume: "cs-0" }, { ctx: ctxFor(sid) });
    await until(() => fake.to("/api/agents/wait").length === 1, "the wait");
    const body = fake.to("/api/agents", "POST")[0].body;
    assert.deepEqual(body, { kind: "claude", task: "Fix the flaky   test in test/a.test.mjs", cwd: "C:/work", resume: "cs-0", title: "Task from pi: Fix the flaky test in test/a.test.mjs", memory: true, parentSid: "pi:s-claude", parentSessionId: sid, depth: 0 });
    const id = [...fake.agents.keys()][0];
    assert.deepEqual(fake.to("/api/agents/wait")[0].body, { ids: [id], undeliveredOnly: false, timeoutSec: 240 }, "≤ 240 s per request, under pi's HTTP headers timeout");
    fake.finish(id, { sessionId: "cs-1", turns: 4, cost: 0.12, resultText: "Fixed: the test awaited the wrong promise." });
    const r = await p;
    assert.equal(textOf(r), 'Fixed: the test awaited the wrong promise.\n\n[claude session cs-1 · 4 turns · $0.120 — pass resume="cs-1" to continue]');
    assert.equal(r.details.sessionId, "cs-1");
    assert.equal(r.details.isError, false);
    assert.equal(r.details.timedOut, false);
    assert.equal(fake.agents.get(id).delivered, true);
    await tick(50);
    assert.equal(x.sent.length, 0);
    const p2 = x.run("claude_task", { task: "break it" }, { ctx: ctxFor(sid) });
    await until(() => fake.agents.size === 2, "second agent");
    fake.finish([...fake.agents.keys()][1], { status: "error", sessionId: "cs-2", turns: 1, cost: 0, resultText: "API error" });
    const r2 = await p2;
    assert.match(textOf(r2), /API error\n\n\[claude session cs-2 · 1 turn · \$0\.000 · ended with an error/);
    assert.equal(r2.details.isError, true);
  } finally { x.shutdown(); await fake.close(); }
});

test("claude_task: past timeoutMinutes it returns what it has and leaves Claude running; the answer arrives later as a message", ext, async () => {
  const fake = await fakeOmni();
  const x = await loadExt(CLAUDE_EXT, fake.port);
  const sid = "s-claude-timeout";
  try {
    const p = x.run("claude_task", { task: "big refactor", timeoutMinutes: 0.02 }, { ctx: ctxFor(sid) });
    await until(() => fake.agents.size === 1, "the agent");
    const id = [...fake.agents.keys()][0];
    fake.update(id, { activity: ["Edit(src/a.ts)", "Bash(npm test)"] });
    const r = await p;
    assert.equal(r.details.timedOut, true);
    assert.equal(r.details.id, id);
    assert.match(textOf(r), /^Recent activity:\n- Edit\(src\/a\.ts\)\n- Bash\(npm test\)/);
    assert.match(textOf(r), new RegExp(`\\[Claude Code did not finish within 1s; it is still running in Omni as agent ${id} \\(session sess-${id}\\)\\. Its answer arrives as a message when it finishes — or agent_status / agent_wait ${id}`));
    assert.equal(fake.to(`/api/agents/${id}/cancel`).length, 0, "not cancelled");
    assert.equal(fake.agents.get(id).status, "running");
    await until(() => fake.to("/api/agents/wait").some((c) => c.body.undeliveredOnly), "the poller takes over");
    fake.finish(id, { sessionId: "cs-9", turns: 30, cost: 1.5, resultText: "refactor done" });
    await until(() => x.sent.length === 1, "the late answer");
    assert.equal(x.sent[0].customType, "omni-agent-result");
    assert.match(x.sent[0].content, /Background Claude agent .* finished: done[\s\S]*refactor done[\s\S]*\[claude session cs-9 · 30 turns · \$1\.500/);
    assert.deepEqual(x.sent[0].options, { triggerTurn: true, deliverAs: "followUp" });
  } finally { x.shutdown(); await fake.close(); }
});

test("claude_task: stopping the pi run cancels the Claude agent; Omni down is reported, not thrown", ext, async () => {
  const fake = await fakeOmni();
  const x = await loadExt(CLAUDE_EXT, fake.port);
  const sid = "s-claude-abort";
  try {
    const ac = new AbortController();
    const p = x.run("claude_task", { task: "long job" }, { ctx: ctxFor(sid), signal: ac.signal });
    await until(() => fake.to("/api/agents/wait").length === 1, "the wait");
    const id = [...fake.agents.keys()][0];
    ac.abort();
    const r = await p;
    assert.equal(r.details.cancelled, true);
    assert.match(textOf(r), new RegExp(`claude_task stopped; Claude Code agent ${id} was cancelled`));
    assert.equal(fake.to(`/api/agents/${id}/cancel`).length, 1);
    assert.equal(fake.agents.get(id).delivered, true, "its cancelled report does not come back");
    fake.down = true;
    const d = await x.run("claude_task", { task: "x" }, { ctx: ctxFor(sid) });
    assert.equal(d.details.error, true);
    assert.match(textOf(d), /Omni Agent is not reachable on http:\/\/127\.0\.0\.1:\d+/);
    fake.down = false;
    const bad = await x.run("claude_task", { task: "" }, { ctx: ctxFor(sid) });
    assert.equal(textOf(bad), "claude_task failed: a task is required");
    assert.equal(bad.details.error, true);
  } finally { x.shutdown(); await fake.close(); }
});

test("claude_task: an abort while this chat's poller runs cancels with the poller still held: no wake-up message for it", ext, async () => {
  const fake = await fakeOmni();
  const x = await loadExt(CLAUDE_EXT, fake.port);
  const sid = "s-claude-abort-poller";
  const posted = [];
  try {
    // An earlier agent_start of this chat left its poller long-polling.
    fake.add({ id: "a-0000bbbb", parentSessionId: sid, title: "other agent", startedAt: Date.now() });
    const poller = lib.ensurePoller({ client: new lib.AgentsClient({ base: `http://127.0.0.1:${fake.port}` }), parentSessionId: sid, pi: { sendMessage: (m) => posted.push(m) } });
    await until(() => fake.to("/api/agents/wait").length === 1, "the poller's wait");
    const ac = new AbortController();
    const p = x.run("claude_task", { task: "long job" }, { ctx: ctxFor(sid), signal: ac.signal });
    await until(() => fake.to("/api/agents/wait").some((c) => c.body.ids), "claude_task's wait");
    const id = [...fake.agents.keys()].find((k) => k !== "a-0000bbbb");
    ac.abort();
    const r = await p;
    assert.equal(r.details.cancelled, true);
    assert.equal(fake.agents.get(id).delivered, true);
    await until(() => fake.to("/api/agents/wait").filter((c) => !c.body.ids).length >= 2, "the poller is back");
    await tick(100);
    assert.deepEqual(posted, [], "the cancelled Claude agent is not reported back");
    poller.stop();
  } finally { lib.stopPollers(); x.shutdown(); await fake.close(); }
});
