import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../server/bus.mjs";
import { AgentManager } from "../server/agents.mjs";
import { handleAgentRoutes, waitMs } from "../server/agent-routes.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function send(res, code, body) { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); }
async function readBody(req) { const chunks = []; for await (const c of req) chunks.push(c); const s = Buffer.concat(chunks).toString("utf8"); return s ? JSON.parse(s) : {}; }

/** A server that mounts only the agent routes; anything they do not handle answers { fallthrough: true }. */
async function serve(agents) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const handled = await handleAgentRoutes(req, res, { p: url.pathname, q: url.searchParams, agents, send, readBody, isLocal: (r) => r.headers["x-remote"] !== "1" });
    if (!handled) send(res, 404, { fallthrough: true });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const call = async (method, path, body, headers = {}) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  return { server, port, call };
}

/** Records every manager call and answers with canned values. */
function fakeAgents() {
  const calls = [];
  const rec = { id: "a-00000001", kind: "pi", status: "running" };
  const fake = {
    calls,
    list(o) { calls.push(["list", o]); return [rec]; },
    get(id) { calls.push(["get", id]); return id === rec.id ? rec : null; },
    start(spec) { calls.push(["start", spec]); if (!spec.task) throw Object.assign(new Error("an agent needs a task"), { status: 400 }); return { ...rec, task: spec.task }; },
    undelivered(p) { calls.push(["undelivered", p]); return [rec]; },
    wait(o) {
      calls.push(["wait", { ...o, signal: !!o.signal }]);
      fake.lastSignal = o.signal;
      if (o.timeoutMs === 0) return Promise.resolve({ finished: [], pending: [rec] });
      return new Promise((resolve) => { const t = setTimeout(() => resolve({ finished: [rec], pending: [] }), Math.min(o.timeoutMs, 100)); o.signal?.addEventListener("abort", () => { clearTimeout(t); fake.aborted = true; resolve({ finished: [], pending: [] }); }); });
    },
    readLog(id, o) { calls.push(["readLog", id, o]); return "line 1\nline 2"; },
    waitFor(id, o) { calls.push(["waitFor", id, { ...o, signal: !!o.signal }]); if (o.until === "(") return Promise.reject(Object.assign(new Error("bad regex"), { status: 400 })); return Promise.resolve({ matched: true, status: "running", tail: "READY" }); },
    message(id, text, o) { calls.push(["message", id, text, o]); return Promise.resolve({ ok: true, how: "steer" }); },
    cancel(id) { calls.push(["cancel", id]); return Promise.resolve({ ...rec, status: "cancelled" }); },
    markDelivered(id) { calls.push(["markDelivered", id]); return true; },
  };
  return fake;
}

test("waitMs caps every wait at 300 s and defaults to 60 s", () => {
  assert.equal(waitMs(undefined), 60000);
  assert.equal(waitMs(""), 60000);
  assert.equal(waitMs(240), 240000);
  assert.equal(waitMs(9999), 300000);
  assert.equal(waitMs(-5), 0);
  assert.equal(waitMs("abc"), 60000);
  assert.equal(waitMs(0.5), 500);
});

test("routes: list, start, get, undelivered, log, wait-log, message, cancel, delivered call the manager with the right arguments", async () => {
  const fake = fakeAgents();
  const { server, call } = await serve(fake);
  after(() => server.close());
  assert.deepEqual(await call("GET", "/api/agents?parent=pi%3Ap1&parentSession=p1&active=1"), { status: 200, body: { agents: [{ id: "a-00000001", kind: "pi", status: "running" }] } });
  assert.deepEqual(fake.calls.at(-1), ["list", { parentSid: "pi:p1", parentSessionId: "p1", active: true }]);
  await call("GET", "/api/agents");
  assert.deepEqual(fake.calls.at(-1), ["list", { parentSid: undefined, parentSessionId: undefined, active: false }]);

  const started = await call("POST", "/api/agents", { kind: "pi", task: "find it", depth: 1 });
  assert.equal(started.status, 200);
  assert.equal(started.body.agent.task, "find it");
  assert.deepEqual(fake.calls.at(-1), ["start", { kind: "pi", task: "find it", depth: 1 }]);
  assert.deepEqual(await call("POST", "/api/agents", { kind: "pi" }), { status: 400, body: { error: "an agent needs a task" } });
  assert.equal((await call("POST", "/api/agents", "{ not json")).status, 400);
  const remote = await call("POST", "/api/agents", { task: "x" }, { "x-remote": "1" });
  assert.equal(remote.status, 403, "only the computer itself starts agents");

  assert.deepEqual((await call("GET", "/api/agents/a-00000001")).body, { agent: { id: "a-00000001", kind: "pi", status: "running" } });
  assert.deepEqual(await call("GET", "/api/agents/a-99999999"), { status: 404, body: { error: "no agent a-99999999" } });
  assert.equal((await call("GET", "/api/agents/a-99999999/log")).status, 404);

  assert.deepEqual((await call("GET", "/api/agents/undelivered?parentSession=p1")).body.agents.length, 1);
  assert.deepEqual(fake.calls.at(-1), ["undelivered", "p1"]);

  assert.deepEqual((await call("GET", "/api/agents/a-00000001/log?tail=5")).body, { text: "line 1\nline 2" });
  assert.deepEqual(fake.calls.at(-1), ["readLog", "a-00000001", { tailLines: 5 }]);
  await call("GET", "/api/agents/a-00000001/log");
  assert.deepEqual(fake.calls.at(-1), ["readLog", "a-00000001", { tailLines: 80 }]);

  assert.deepEqual((await call("POST", "/api/agents/a-00000001/wait-log", { until: "READY", timeoutSec: 1000 })).body, { matched: true, status: "running", tail: "READY" });
  assert.deepEqual(fake.calls.at(-1), ["waitFor", "a-00000001", { until: "READY", timeoutMs: 300000, signal: true }]);
  assert.equal((await call("POST", "/api/agents/a-00000001/wait-log", { until: "(" })).status, 400);

  assert.deepEqual((await call("POST", "/api/agents/a-00000001/message", { text: "focus on src/", steer: true })).body, { ok: true, how: "steer" });
  assert.deepEqual(fake.calls.at(-1), ["message", "a-00000001", "focus on src/", { steer: true }]);
  await call("POST", "/api/agents/a-00000001/message", { message: "alias" });
  assert.deepEqual(fake.calls.at(-1), ["message", "a-00000001", "alias", { steer: undefined }]);

  assert.deepEqual((await call("POST", "/api/agents/a-00000001/cancel")).body, { agent: { id: "a-00000001", kind: "pi", status: "cancelled" } });
  assert.deepEqual((await call("POST", "/api/agents/a-00000001/delivered")).body, { ok: true });
  assert.deepEqual(fake.calls.at(-1), ["markDelivered", "a-00000001"]);

  assert.equal((await call("DELETE", "/api/agents/a-00000001")).status, 405);
  assert.equal((await call("POST", "/api/agents/a-00000001/explode")).status, 404);
  assert.equal((await call("GET", "/api/agents/a-00000001/cancel")).status, 405);
  assert.deepEqual(await call("GET", "/api/other"), { status: 404, body: { fallthrough: true } }, "other paths are left to the caller");
  assert.deepEqual(await call("GET", "/api/agentsx"), { status: 404, body: { fallthrough: true } });
});

test("POST /api/agents/wait: passes the selection, caps the timeout at 300 s, and aborts when the client goes away", async () => {
  const fake = fakeAgents();
  const { server, port, call } = await serve(fake);
  after(() => server.close());
  const r = await call("POST", "/api/agents/wait", { ids: ["a-00000001"], parentSessionId: "p1", undeliveredOnly: true, timeoutSec: 5000 });
  assert.deepEqual(r.body, { finished: [{ id: "a-00000001", kind: "pi", status: "running" }], pending: [] });
  assert.deepEqual(fake.calls.at(-1), ["wait", { ids: ["a-00000001"], parentSessionId: "p1", undeliveredOnly: true, timeoutMs: 300000, signal: true }]);
  await call("POST", "/api/agents/wait", { ids: "a-00000001", timeoutSec: 0 });
  assert.deepEqual(fake.calls.at(-1)[1].ids, ["a-00000001"], "a single id is accepted too");
  assert.equal(fake.calls.at(-1)[1].timeoutMs, 0);

  fake.aborted = false;
  fake.wait = (o) => { fake.lastSignal = o.signal; return new Promise((resolve) => o.signal.addEventListener("abort", () => { fake.aborted = true; resolve({ finished: [], pending: [] }); })); };
  const req = request({ host: "127.0.0.1", port, method: "POST", path: "/api/agents/wait", headers: { "content-type": "application/json" } });
  req.on("error", () => {});
  req.end(JSON.stringify({ parentSessionId: "p1", timeoutSec: 240 }));
  await sleep(50);
  assert.equal(fake.aborted, false);
  req.destroy();
  await sleep(50);
  assert.equal(fake.aborted, true, "the long wait ends with its request");
});

test("no manager → 503 for every agents route", async () => {
  const { server, call } = await serve(null);
  after(() => server.close());
  assert.equal((await call("GET", "/api/agents")).status, 503);
  assert.equal((await call("POST", "/api/agents/a-1/cancel")).status, 503);
});

test("end to end with a real AgentManager: start over HTTP, wait, finish by the goal event, mark delivered", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omni-agent-routes-"));
  after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });
  const bus = new Bus();
  const made = [];
  const createPi = (opts) => {
    const pi = Object.assign(new EventEmitter(), { opts, sid: "pi:pending", streaming: false, state: null, proc: { pid: 9 }, prompts: [],
      start() { return this; }, waitReady() { this.sid = "pi:child1"; this.state = { sessionId: "child1", sessionFile: join(dir, "child1.jsonl") }; return Promise.resolve(this.state); },
      async prompt(t, o) { this.prompts.push({ t, o }); return { success: true }; }, stop() { this.proc = null; }, owns() { return false; } });
    made.push(pi);
    return pi;
  };
  const agents = new AgentManager({ bus, file: join(dir, "agents.json"), dir: join(dir, "logs"), createPi, keeper: { setManagedGoal() {} }, cwd: dir, killTree: () => {}, graceMs: 1, saveDelayMs: 5 });
  const { server, call } = await serve(agents);
  after(() => { server.close(); agents.dispose(); });
  const { body: { agent } } = await call("POST", "/api/agents", { kind: "pi", task: "Summarise README.md", parentSid: "pi:parent", parentSessionId: "parent", depth: 0 });
  assert.match(agent.id, /^a-[0-9a-f]{8}$/);
  await sleep(10);
  assert.equal((await call("GET", `/api/agents/${agent.id}`)).body.agent.status, "running");
  assert.deepEqual((await call("GET", "/api/agents?parent=pi:parent&active=1")).body.agents.map((a) => a.id), [agent.id]);
  const timedOut = await call("POST", "/api/agents/wait", { parentSessionId: "parent", undeliveredOnly: true, timeoutSec: 0.05 });
  assert.deepEqual(timedOut.body.finished, []);
  assert.equal(timedOut.body.pending[0].id, agent.id);
  const waiting = call("POST", "/api/agents/wait", { parentSessionId: "parent", undeliveredOnly: true, timeoutSec: 30 });
  await sleep(20);
  bus.emit({ sid: "pi:child1", harness: "pi", kind: "msg", ts: Date.now(), id: "m1", role: "assistant", live: true, blocks: [{ type: "text", text: "README says: build with npm." }] });
  bus.emit({ sid: "pi:child1", harness: "pi", kind: "goal", ts: Date.now(), done: true });
  const got = (await waiting).body;
  assert.equal(got.finished[0].id, agent.id);
  assert.equal(got.finished[0].status, "done");
  assert.equal(got.finished[0].resultText, "README says: build with npm.");
  assert.deepEqual((await call("GET", "/api/agents/undelivered?parentSession=parent")).body.agents.map((a) => a.id), [agent.id]);
  assert.deepEqual((await call("POST", `/api/agents/${agent.id}/delivered`)).body, { ok: true });
  assert.deepEqual((await call("GET", "/api/agents/undelivered?parentSession=parent")).body.agents, []);
  assert.equal((await call("POST", "/api/agents", { kind: "pi", task: "too deep", depth: 2 })).status, 400);
  assert.equal((await call("POST", `/api/agents/${agent.id}/message`, { text: "" })).status, 400);
});
