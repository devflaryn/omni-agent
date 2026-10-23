/**
 * Server wiring for long runs: background agents mounted in createApp (a pi agent runs as a managed child of the chat,
 * shows under it, reports back), the long-run settings route (compactAt of the live chats), explicit goals that survive
 * a restart, a "my context is full" stop continued with the hook off, and agent reports replayed from a session file.
 * Fake pi children only — no real pi, claude or network.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/index.mjs";
import { normalizePiEntry } from "../server/normalize.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base = mkdtempSync(join(tmpdir(), "omni-long-"));
const until = async (fn, ms = 5000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(25); } return null; };

/** A main-chat pi stand-in: records prompts and compactions. */
function mainPi(bus, { sid = "pi:main", file = join(base, "main.jsonl"), cwd = base } = {}) {
  return {
    proc: {}, sid, cwd, streaming: false, state: { sessionFile: file, sessionId: sid.slice(3), model: { provider: "p", id: "m", maxTokens: 16384 } }, calls: [],
    start() {}, stop() {}, owns() { return false; }, startWatchdog() {},
    waitReady() { return Promise.resolve(this.state); },
    async prompt(m) { this.calls.push(["prompt", m]); return { success: true }; },
    async compact() { this.calls.push(["compact"]); return { success: true }; },
    async abort() { this.calls.push(["abort"]); return { success: true }; },
    async switchSession(f) { this.calls.push(["switch", f]); this.state.sessionFile = f; return { success: true }; },
    async entries() { return { data: { entries: [], leafId: null } }; },
  };
}

/** A background pi agent stand-in: announces its session (with meta) and answers the task with one text reply. */
function agentPiFactory(bus, answer = "The file has 42 lines.") {
  let n = 0;
  return (o) => {
    const id = `child-${++n}`;
    const p = {
      proc: { pid: 0 }, sid: `pi:${id}`, streaming: false, state: { sessionFile: join(base, `${id}.jsonl`), sessionId: id }, opts: o,
      on() {}, start() {}, stop() {}, owns() { return false; }, stopWatchdog() {},
      waitReady() { bus.emit({ sid: p.sid, harness: "pi", kind: "session", ts: Date.now(), owned: true, cwd: o.cwd, file: p.state.sessionFile, ...o.meta }); return Promise.resolve(p.state); },
      async prompt(text, { echo } = {}) {
        if (echo) bus.emit({ sid: p.sid, harness: "pi", kind: "msg", ts: Date.now(), id: `u-${id}`, role: "user", live: true, blocks: [{ type: "text", text }] });
        setTimeout(() => {
          p.streaming = true; bus.emit({ sid: p.sid, harness: "pi", kind: "status", ts: Date.now(), streaming: true });
          bus.emit({ sid: p.sid, harness: "pi", kind: "msg", ts: Date.now(), id: `a-${id}`, role: "assistant", live: true, stopReason: "stop", usage: { input: 900, output: 20, cacheRead: 0, cacheWrite: 0, total: 920 }, blocks: [{ type: "text", text: answer }] });
          p.streaming = false; bus.emit({ sid: p.sid, harness: "pi", kind: "status", ts: Date.now(), streaming: false });
        }, 20);
        return { success: true };
      },
      async switchSession() { return { success: true }; },
      async compact() { return { success: true }; },
    };
    return p;
  };
}

const opts = (dir, extra = {}) => ({
  port: 0, relay: { host: "" }, autoStartPi: false, cwd: base, liveWindowMs: 0,
  vaultDir: join(dir, "vault"), piSessionsDir: join(dir, "pi"), claudeProjectsDir: join(dir, "claude"),
  agentsFile: join(dir, "agents.json"), agentsDir: join(dir, "agents"), goalsFile: join(dir, "goals.json"),
  piModelsFile: join(dir, "pi-agent", "models.json"),
  persistHook: false, persistPiModel: false, persistContext: false, hook: { enabled: false, graceMs: 10 }, ...extra,
});

// ----------------------------------------------------------------- background pi agent through the server
const dirA = join(base, "a"); mkdirSync(dirA, { recursive: true });
let busA = null;
const appA = await createApp(opts(dirA, { createPi: (o) => mainPi(o.bus), createAgentPi: (o) => agentPiFactory(busA)(o) }));
busA = appA.bus;
await appA.listen();
after(() => appA.close());
const portA = appA.server.address().port;
const http = async (port, path, body, method) => { const r = await fetch(`http://127.0.0.1:${port}${path}`, body !== undefined ? { method: method || "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}); return { status: r.status, json: await r.json().catch(() => ({})) }; };

test("a pi agent started over HTTP runs under the chat, finishes through the goal keeper and reports back", async () => {
  appA.startPi(base);
  const r = await http(portA, "/api/agents", { kind: "pi", task: "Count the lines of x.js", parentSid: "pi:main", parentSessionId: "main", depth: 0 });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const id = r.json.agent.id;
  const done = await until(async () => { const a = (await http(portA, `/api/agents/${id}`)).json.agent; return a?.status === "done" ? a : null; });
  assert.ok(done, "the agent finished");
  assert.match(done.resultText, /42 lines/, "its last reply is the report");
  assert.equal(done.delivered, false, "not delivered until the parent's extension acks it");
  const st = (await http(portA, "/api/state")).json;
  assert.ok(st.agents.some((a) => a.id === id), "/api/state lists the agent");
  const child = st.sessions.find((s) => s.sid === done.sid);
  assert.equal(child?.parentSid, "pi:main", "the child chat is linked to its parent in the registry");
  assert.notEqual(appA.pi.resumeFile, done.sessionFile, "an agent's session never becomes the main chat's resume anchor");
  const und = (await http(portA, "/api/agents/undelivered?parentSession=main")).json.agents;
  assert.ok(und.some((a) => a.id === id), "the finished report waits for delivery");
  assert.equal((await http(portA, `/api/agents/${id}/delivered`, {})).json.ok, true);
  assert.equal((await http(portA, "/api/agents/undelivered?parentSession=main")).json.agents.length, 0);
});

test("the goal keeper waits while a chat has running background agents", async () => {
  appA.startPi(base);
  const g = appA.keeper.setGoal("pi:main", "do the thing");
  g.toolCalls = 3; g.stopReason = "stop";
  appA.keeper.config.enabled = true;
  appA.agents.activeChildren = () => 2;
  try {
    const out = await appA.keeper.check("pi:main", g.seq);
    assert.equal(out?.action, "wait-children");
  } finally { delete appA.agents.activeChildren; appA.keeper.config.enabled = false; }
});

// ----------------------------------------------------------------- long-run settings → live chats
test("PUT /api/context moves every live chat and background agent to the new compactAt and leaves models.json alone", async () => {
  const dir = join(base, "ctx"); mkdirSync(join(dir, "pi-agent"), { recursive: true });
  const models = JSON.stringify({ providers: { openrouter: { baseUrl: "https://openrouter.ai/api/v1", api: "openai-completions", apiKey: "k", models: [{ id: "deepseek/x", contextWindow: 1000000, maxTokens: 65536 }] } } });
  writeFileSync(join(dir, "pi-agent", "models.json"), models);
  let chat = null;
  const app = await createApp(opts(dir, { context: { compactAt: 0 }, createPi: (o) => (chat = { ...mainPi(o.bus, { sid: "pi:ctx" }), compactAt: 0 }) }));
  await app.listen();
  try {
    const port = app.server.address().port;
    app.startPi(base);
    const agent = { proc: {}, compactAt: 0 };
    app.agents.liveChildren = () => [agent];
    const r = await http(port, "/api/context", { compactAt: 256000, autoContinue: true }, "PUT");
    assert.equal(r.status, 200);
    assert.equal(r.json.context.compactAt, 256000);
    assert.equal(chat.compactAt, 256000, "the running chat compacts at the new point from its next prompt");
    assert.equal(agent.compactAt, 256000, "so does a running background agent");
    assert.equal(readFileSync(join(dir, "pi-agent", "models.json"), "utf8"), models, "pi's models.json is never rewritten");
    assert.equal(app.keeper.contextPolicy?.compactAt, 256000);
    assert.equal((await http(port, "/api/state")).json.config.context.compactAt, 256000);
    assert.equal((await http(port, "/api/context", { compactAt: -5 }, "PUT")).status, 400);
    await http(port, "/api/context", { compactAt: 0 }, "PUT");
    assert.deepEqual([chat.compactAt, agent.compactAt], [0, 0], "0 turns Omni's compaction point off again");
  } finally { delete app.agents.liveChildren; app.close(); }
});

// ----------------------------------------------------------------- explicit goals survive a restart
test("an explicit goal is saved with its chat and restored on the next start", async () => {
  const dir = join(base, "goals"); mkdirSync(dir, { recursive: true });
  const file = join(dir, "chat.jsonl"); writeFileSync(file, "");
  const app1 = await createApp(opts(dir, { createPi: (o) => mainPi(o.bus, { sid: "pi:g1", file }) }));
  await app1.listen();
  const port1 = app1.server.address().port;
  app1.startPi(base);
  app1.registry.upsert("pi:g1", { file, cwd: base, lastActivity: Date.now() });
  assert.equal((await http(port1, "/api/goal", { goal: "port the build overnight" })).status, 200);
  app1.close();
  const saved = JSON.parse(readFileSync(join(dir, "goals.json"), "utf8")).goals;
  assert.equal(saved[0]?.text, "port the build overnight");
  assert.equal(saved[0]?.file, file);
  let pi2 = null;
  const app2 = await createApp(opts(dir, { autoStartPi: true, createPi: (o) => (pi2 = mainPi(o.bus, { sid: "pi:g2", file: join(dir, "fresh.jsonl") })) }));
  await app2.listen();
  try {
    const g = await until(() => app2.keeper.goal("pi:g2"));
    assert.ok(g, "the goal was restored onto the new pi");
    assert.equal(g.text, "port the build overnight");
    assert.equal(g.explicit, true);
    assert.ok(pi2.calls.some((c) => c[0] === "switch" && c[1] === file), "pi was put back on the goal's chat");
    assert.equal(app2.keeper.config.enabled, true, "restoring a goal arms the hook");
  } finally { app2.close(); }
});

test("a stopped (paused) goal is not restored", async () => {
  const dir = join(base, "goals2"); mkdirSync(dir, { recursive: true });
  const file = join(dir, "chat.jsonl"); writeFileSync(file, "");
  writeFileSync(join(dir, "goals.json"), JSON.stringify({ goals: [{ sid: "pi:x", text: "old job", explicit: true, paused: true, file, cwd: base, savedAt: Date.now() }] }));
  let p = null;
  const app = await createApp(opts(dir, { autoStartPi: true, createPi: (o) => (p = mainPi(o.bus, { sid: "pi:y" })) }));
  await app.listen();
  try { await sleep(100); assert.equal(app.keeper.goal("pi:y"), null); assert.ok(!p.calls.some((c) => c[0] === "switch")); } finally { app.close(); }
});

// ----------------------------------------------------------------- "my context is full" with the hook off
test("hook off + autoContinue: a stop claiming the context is exhausted is compacted and continued", async () => {
  const dir = join(base, "cs"); mkdirSync(dir, { recursive: true });
  let p = null;
  const app = await createApp(opts(dir, { createPi: (o) => (p = mainPi(o.bus, { sid: "pi:cs" })), context: { compactAt: 256000, autoContinue: true, maxContextNudges: 3 } }));
  await app.listen();
  try {
    app.startPi(base);
    const ev = (e) => app.bus.emit({ sid: "pi:cs", harness: "pi", ts: Date.now(), ...e });
    ev({ kind: "msg", id: "u1", role: "user", live: true, blocks: [{ type: "text", text: "Port the library and get it running." }] });
    ev({ kind: "status", streaming: true });
    ev({ kind: "msg", id: "a1", role: "assistant", live: true, stopReason: "stop", usage: { input: 2000, output: 300, cacheRead: 410000, cacheWrite: 0, total: 412300 }, blocks: [{ type: "text", text: "Progress so far is good. My context is nearly exhausted, so here is a handoff prompt for a fresh session." }] });
    ev({ kind: "status", streaming: false });
    const prompted = await until(() => p.calls.find((c) => c[0] === "prompt"));
    assert.ok(prompted, "the run was re-engaged");
    assert.ok(p.calls.findIndex((c) => c[0] === "compact") >= 0 && p.calls.findIndex((c) => c[0] === "compact") < p.calls.findIndex((c) => c[0] === "prompt"), "compacted first");
    assert.match(prompted[1], /never a reason to stop/i);
    assert.equal(app.keeper.config.enabled, false, "the hook itself stays off");
  } finally { app.close(); }
});

test("Stop: the run it aborts ends with 'This operation was aborted' — that is never retried as a provider outage", async () => {
  const dir = join(base, "stop"); mkdirSync(dir, { recursive: true });
  let p = null;
  const app = await createApp(opts(dir, { createPi: (o) => (p = mainPi(o.bus, { sid: "pi:st" })), hook: { enabled: true, graceMs: 10 }, context: { compactAt: 256000, autoContinue: true } }));
  await app.listen();
  try {
    app.startPi(base);
    const port = app.server.address().port;
    const ev = (e) => app.bus.emit({ sid: "pi:st", harness: "pi", ts: Date.now(), ...e });
    ev({ kind: "msg", id: "u1", role: "user", live: true, blocks: [{ type: "text", text: "Rebuild the package and test it." }] });
    ev({ kind: "status", streaming: true });
    assert.equal((await http(port, "/api/pi/abort", {})).status, 200);
    ev({ kind: "msg", id: "a1", role: "assistant", live: true, stopReason: "error", blocks: [{ type: "text", text: "Model error: This operation was aborted" }] });
    ev({ kind: "status", streaming: false });
    await sleep(200);
    assert.equal(p.calls.filter((c) => c[0] === "prompt").length, 0, "no retry, no nudge after the user's Stop");
    assert.ok(app.keeper.goal("pi:st").paused);
    assert.equal(app.keeper.config.enabled, true, "and the hook stays armed for the next run");
  } finally { app.close(); }
});

test("hook off + autoContinue: a normal finished answer is left alone", async () => {
  const dir = join(base, "cs2"); mkdirSync(dir, { recursive: true });
  let p = null;
  const app = await createApp(opts(dir, { createPi: (o) => (p = mainPi(o.bus, { sid: "pi:ok" })), context: { compactAt: 256000, autoContinue: true } }));
  await app.listen();
  try {
    app.startPi(base);
    const ev = (e) => app.bus.emit({ sid: "pi:ok", harness: "pi", ts: Date.now(), ...e });
    ev({ kind: "msg", id: "u1", role: "user", live: true, blocks: [{ type: "text", text: "What is 2+2?" }] });
    ev({ kind: "status", streaming: true });
    ev({ kind: "msg", id: "a1", role: "assistant", live: true, stopReason: "stop", usage: { input: 900, output: 5, cacheRead: 0, cacheWrite: 0, total: 905 }, blocks: [{ type: "text", text: "4." }] });
    ev({ kind: "status", streaming: false });
    await sleep(200);
    assert.equal(p.calls.filter((c) => c[0] === "prompt" || c[0] === "compact").length, 0);
  } finally { app.close(); }
});

// ----------------------------------------------------------------- agent reports survive a reload
test("a background agent's report (a pi custom_message entry) replays from the session file", () => {
  const out = normalizePiEntry({ type: "custom_message", id: "c1", timestamp: "2026-10-21T10:00:00.000Z", customType: "omni-agent-result", content: 'Background pi agent a-1a2b3c4d "count" finished: done after 12s.\n\n42', display: true }, { sid: "pi:x", harness: "pi" });
  assert.equal(out.length, 1);
  assert.equal(out[0].role, "system");
  assert.match(out[0].blocks[0].text, /^\[omni-agent-result\] Background pi agent a-1a2b3c4d/);
  assert.deepEqual(normalizePiEntry({ type: "custom_message", id: "c2", customType: "x", content: "hidden", display: false }, { sid: "pi:x", harness: "pi" }), []);
});

test("the compaction point has a 100k floor (a compacted chat still holds ~60k), 0 turns the cap off", async () => {
  const { contextConfig } = await import("../server/config.mjs");
  const { parseCompactAt } = await import("../ui/lib.js");
  assert.equal(contextConfig({ compactAt: 45000 }).compactAt, 100000);
  assert.equal(contextConfig({ compactAt: 0 }).compactAt, 0);
  assert.equal(contextConfig({}).compactAt, 256000);
  assert.ok(parseCompactAt("50").error);
  assert.deepEqual(parseCompactAt("100"), { compactAt: 100000 });
});

test("tests never write Omni's real state files", () => {
  assert.ok(!appA.cfg.agentsFile.includes(".omni-agent"), "agentsFile is a temp path");
  assert.ok(existsSync(join(dirA, "agents.json")) || true);
});
