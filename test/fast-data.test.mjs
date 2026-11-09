// The first screen's data: little of it, in few round trips, and nothing visible waiting on the slow part.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/index.mjs";
import { Bus } from "../server/bus.mjs";
import { SessionRegistry, SessionWatcher } from "../server/watchers.mjs";
import { createTally } from "../server/tokens.mjs";
import { wireEvent } from "../server/wire.mjs";
import { FakeServer } from "./helpers/fake-opencode.mjs";
import { cachedModels, forgetCachedModels, keepModels } from "../ui/model-cache.js";

const base = mkdtempSync(join(tmpdir(), "omni-fast-"));
const cleanups = [];
after(async () => { for (const c of cleanups.reverse()) await c(); rmSync(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); });
const read = (f) => readFileSync(new URL(`../ui/${f}`, import.meta.url), "utf8");

// ------------------------------------------------------------------------- the event stream's replay

const sink = () => { const writes = []; return { writes, writableLength: 0, write(s) { writes.push(s); return true; } }; };
const sent = (res) => res.writes.join("").split("\n\n").filter(Boolean).map((b) => JSON.parse(b.replace(/^data: /, "")));

test("a page's first replay leaves out the stream parts of turns the file already holds, and keeps a running turn's", () => {
  const bus = new Bus();
  // A turn that finished: its parts are in the file, as its message.
  bus.emit({ sid: "pi:a", kind: "block", phase: "message_start", ts: 1 });
  bus.emit({ sid: "pi:a", kind: "delta", delta: "ol", ts: 2 });
  bus.emit({ sid: "pi:a", kind: "delta", delta: "d", ts: 3 });
  bus.emit({ sid: "pi:a", kind: "msg", role: "assistant", blocks: [{ type: "text", text: "old" }], ts: 4 });
  // The next one, still running.
  bus.emit({ sid: "pi:a", kind: "block", phase: "message_start", ts: 5 });
  bus.emit({ sid: "pi:a", kind: "delta", delta: "new", ts: 6 });
  // Another chat, with no message in the ring.
  bus.emit({ sid: "pi:b", kind: "delta", delta: "other", ts: 7 });
  bus.emit({ sid: "pi:a", kind: "status", streaming: true, ts: 8 });
  const fresh = sink();
  bus.addClient(fresh, 0);
  assert.deepEqual(sent(fresh).map((e) => e.delta ?? e.phase ?? e.kind), ["message_start", "new", "other", "status"]);
  const back = sink();
  bus.addClient(back, 1, bus.boot);
  assert.equal(sent(back).length, 7, "a reconnect still gets every event it missed");
});

test("a replay goes out as one write, not one frame per event over a channel", () => {
  const bus = new Bus();
  for (let i = 0; i < 500; i++) bus.emit({ sid: "pi:a", kind: "status", streaming: false, ts: i });
  const fresh = sink();
  bus.addClient(fresh, 0);
  assert.equal(fresh.writes.length, 1);
  assert.equal(sent(fresh).length, 500);
  const back = sink();
  bus.addClient(back, 250, bus.boot);
  assert.equal(back.writes.length, 1);
  assert.equal(sent(back).length, 250);
  const none = sink();
  bus.addClient(none, 500, bus.boot);
  assert.equal(none.writes.length, 0, "and nothing to say writes nothing");
});

// ------------------------------------------------------------------------- history pages

function chat(lines) {
  const dir = mkdtempSync(join(base, "chat-"));
  const file = join(dir, "s.jsonl");
  writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  const registry = new SessionRegistry();
  registry.upsert("pi:ses_abc", { harness: "pi", file });
  const watcher = Object.create(SessionWatcher.prototype);
  return Object.assign(watcher, { registry, tally: createTally() });
}
const turn = (i, size = 2000, extra = {}) => [
  { type: "message", id: `u${i}`, message: { role: "user", content: [{ type: "text", text: `prompt ${i}` }], timestamp: 1000 + i } },
  { type: "message", id: `a${i}`, message: { role: "assistant", content: [{ type: "text", text: `${"x".repeat(size)} ${i}` }], usage: { input: 10, output: 5, totalTokens: 15, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }, timestamp: 1000 + i }, ...extra },
];
const wireBytes = (events) => events.reduce((sum, ev) => sum + JSON.stringify(wireEvent(ev)).length, 0);

test("the first page of a chat is small, starts at a person's message, and the rest follows by the same `before` as ever", async () => {
  const w = chat(Array.from({ length: 200 }, (_, i) => turn(i)).flat());
  const whole = await w.history("pi:ses_abc", {});
  assert.equal(whole.events.filter((e) => e.kind === "msg" && e.role === "user").length, 200, "with no page asked for, what it always was");
  const page = await w.history("pi:ses_abc", { pageBytes: 20_000 });
  assert.ok(wireBytes(page.events) <= 20_000, `${wireBytes(page.events)} bytes`);
  assert.ok(page.events.length >= 2);
  assert.equal(page.events.find((e) => e.kind === "msg").role, "user");
  assert.equal(page.more, true);
  assert.ok(page.start > 0);
  const seen = [];
  let before = undefined, pages = 0, h = page;
  for (;;) {
    seen.unshift(...h.events.filter((e) => e.kind === "msg" && e.role === "user").map((e) => e.blocks[0].text));
    pages++;
    if (!h.more) break;
    before = h.start;
    h = await w.history("pi:ses_abc", { before, pageBytes: 20_000 });
  }
  assert.ok(pages > 5, `${pages} pages`);
  assert.deepEqual(seen, Array.from({ length: 200 }, (_, i) => `prompt ${i}`), "every message once, in order");
});

test("a small page still knows the chat's whole tally and its plan, from the window the server read", async () => {
  const planned = { type: "message", id: "t0", message: { role: "toolResult", toolCallId: "c0", toolName: "plan", content: [{ type: "text", text: "planned" }], details: { plan: { milestones: [{ id: 1, title: "m", steps: [] }], updatedAt: 5 } }, timestamp: 1000 } };
  const w = chat([...turn(0), planned, ...Array.from({ length: 100 }, (_, i) => turn(i + 1)).flat()]);
  const whole = await w.history("pi:ses_abc", {});
  const page = await w.history("pi:ses_abc", { pageBytes: 10_000 });
  assert.ok(page.events.length < whole.events.length);
  assert.deepEqual(page.tally, whole.tally);
  assert.equal(page.plan?.plan?.updatedAt, 5, "the plan is older than the page, and comes along by itself");
  assert.equal(whole.plan, undefined, "with the whole window there is nothing to add");
});

test("a single turn larger than a page comes whole rather than not at all", async () => {
  const w = chat(turn(0, 50_000));
  const page = await w.history("pi:ses_abc", { pageBytes: 1000 });
  assert.equal(page.events.filter((e) => e.kind === "msg").length, 2, "the person's message with its long answer");
  assert.equal(page.more, false);
});

test("a run of one long turn with no person's message nearby is cut anyway, so a page stays a page", async () => {
  const tools = Array.from({ length: 300 }, (_, i) => ({ type: "message", id: `a${i}`, message: { role: "assistant", content: [{ type: "text", text: "y".repeat(1000) }], timestamp: 1000 + i } }));
  const w = chat([...turn(0, 10), ...tools]);
  const page = await w.history("pi:ses_abc", { pageBytes: 20_000 });
  assert.ok(wireBytes(page.events) <= 21_500, `${wireBytes(page.events)} bytes`);
  assert.equal(page.more, true);
});

// ------------------------------------------------------------------------- routes

async function app(extra = {}) {
  const dir = mkdtempSync(join(base, "app-"));
  mkdirSync(join(dir, "vault"), { recursive: true });
  const created = await createApp({ port: 0, relay: { host: "" }, autoStartPi: false, hook: { enabled: false }, persistHook: false, persistPiModel: false, cwd: dir, vaultDir: join(dir, "vault"), piSessionsDir: join(dir, "pi"), claudeProjectsDir: join(dir, "claude"), projectsDir: join(dir, "projects"), tlsDir: join(dir, "tls"), remoteAuthFile: join(dir, "remote.json"), accountDir: join(dir, "account"), opencodeConfigDir: join(dir, "oc"), log: () => {}, ...extra });
  await created.listen();
  cleanups.push(() => created.close());
  return { app: created, at: `http://127.0.0.1:${created.server.address().port}` };
}

test("/api/state?first=1 carries the recent chats and what is running, and says how many there are; plain /api/state is unchanged", async () => {
  const { app: a, at } = await app();
  for (let i = 0; i < 200; i++) a.registry.upsert(`pi:s${i}`, { harness: "pi", title: `chat ${i}`, cwd: "C:/x", lastActivity: 1000 + i, file: `C:/x/${i}.jsonl` });
  a.registry.upsert("pi:old-but-live", { harness: "pi", title: "live", cwd: "C:/x", lastActivity: 1, streaming: true });
  const full = await (await fetch(`${at}/api/state`)).json();
  assert.equal(full.sessions.length, 201);
  assert.equal(full.sessionsTotal, undefined);
  const first = await (await fetch(`${at}/api/state?first=1`)).json();
  assert.equal(first.sessionsTotal, 201);
  assert.ok(first.sessions.length <= 62, `${first.sessions.length} sessions`);
  assert.ok(first.sessions.some((s) => s.sid === "pi:s199"), "the newest");
  assert.ok(first.sessions.some((s) => s.sid === "pi:old-but-live"), "and a live one, however old");
  assert.ok(!first.sessions.some((s) => s.sid === "pi:s0"));
  assert.deepEqual(Object.keys(first).filter((k) => k !== "sessionsTotal").sort(), Object.keys(full).sort(), "the same shape");
});

test("/api/state?first=1 carries the agents in brief: a long task or report is not the first screen's", async () => {
  const { app: a, at } = await app();
  const list = a.agents.list.bind(a.agents);
  const records = Array.from({ length: 150 }, (_, i) => ({ id: `ag${i}`, kind: "pi", status: i < 2 ? "running" : "done", title: `t${i}`, task: "t".repeat(9000), resultText: "r".repeat(20000), startedAt: 1000 - i }));
  a.agents.list = (o) => (o?.active ? records.slice(0, 2) : records.length ? records : list(o));
  const first = await (await fetch(`${at}/api/state?first=1`)).json();
  assert.ok(first.agents.length <= 32, `${first.agents.length} agents`);
  assert.ok(first.agents.some((x) => x.id === "ag0"), "a running one");
  for (const x of first.agents) { assert.ok(x.task.length <= 301, "task"); assert.ok(x.resultText.length <= 301, "report"); }
  assert.ok(JSON.stringify(first.agents).length < 32 * 1024);
  const full = await (await fetch(`${at}/api/state`)).json();
  assert.equal(full.agents.length, 150);
  assert.equal(full.agents[0].task.length, 9000, "the full state keeps what it had");
});

test("/history?page= is the small page, over the route; a nonsense value is the whole window", async () => {
  const dir = mkdtempSync(join(base, "route-"));
  const pi = join(dir, "pi", "proj");
  mkdirSync(pi, { recursive: true });
  const file = join(pi, "2026-01-01T00-00-00-000Z_ses_route.jsonl");
  writeFileSync(file, `${[{ type: "session", id: "ses_route", cwd: dir, timestamp: "2026-01-01T00:00:00.000Z" }, ...Array.from({ length: 200 }, (_, i) => turn(i)).flat()].map((l) => JSON.stringify(l)).join("\n")}\n`);
  const { app: a, at } = await app({ piSessionsDir: join(dir, "pi") });
  for (let i = 0; i < 100 && !a.registry.list().length; i++) await new Promise((r) => setTimeout(r, 30));
  const sid = a.registry.list()[0].sid;
  const url = `${at}/api/sessions/${encodeURIComponent(sid)}/history`;
  const whole = await (await fetch(url)).json();
  const page = await (await fetch(`${url}?page=20000`)).json();
  assert.ok(page.events.length < whole.events.length);
  assert.ok(JSON.stringify(page.events).length < 25_000);
  assert.equal(page.more, true);
  const older = await (await fetch(`${url}?before=${page.start}&page=20000`)).json();
  assert.ok(older.events.length > 0);
  assert.equal((await (await fetch(`${url}?page=nonsense`)).json()).events.length, whole.events.length);
  assert.equal((await (await fetch(`${url}?page=-5`)).json()).events.length, whole.events.length);
  assert.ok((await (await fetch(`${url}?page=1`)).json()).events.length >= 2, "the floor keeps a page useful");
});

test("/api/pi/models answers from what it has and looks again behind the scenes: it is never what a page waits on twice", async () => {
  const catalog = { connected: ["opencode"], all: [{ id: "opencode", models: { a: { id: "a", name: "A" } } }], default: {} };
  const oc = new FakeServer({ catalog, up: true });
  const clock = { now: 1_000_000 };
  const realNow = Date.now;
  Date.now = () => clock.now;
  try {
    const { at } = await app({ opencodeServer: oc });
    const providerCalls = () => oc.calls.filter((c) => c.method === "GET" && c.path === "/provider").length;
    const ask = async () => (await (await fetch(`${at}/api/pi/models`)).json()).data.models.map((m) => m.id);
    const before = providerCalls();
    assert.deepEqual(await ask(), ["a"]);
    const afterFirst = providerCalls();
    assert.ok(afterFirst > before || afterFirst >= 1);
    await ask();
    assert.equal(providerCalls(), afterFirst, "within the minute it does not ask OpenCode again");
    oc.catalog = { ...catalog, all: [{ id: "opencode", models: { a: { id: "a", name: "A" }, b: { id: "b", name: "B" } } }] };
    clock.now += 61_000;
    assert.deepEqual(await ask(), ["a"], "past the minute: what it has, at once");
    for (let i = 0; i < 100 && providerCalls() === afterFirst; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(providerCalls(), afterFirst + 1, "and it looks again behind the scenes");
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(await ask(), ["a", "b"], "so the next asks gets the news");
  } finally { Date.now = realNow; }
});

// ------------------------------------------------------------------------- the page's own cache of the model list

const memoryStorage = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; } }; };

test("the model list is kept per machine, and a broken or full store costs nothing", () => {
  const storage = memoryStorage();
  assert.equal(cachedModels("m1", storage), null);
  const choices = { models: [{ provider: "p", id: "x", name: "X" }], levels: ["off"], labels: {} };
  keepModels("m1", choices, storage);
  assert.deepEqual(cachedModels("m1", storage), choices);
  assert.equal(cachedModels("m2", storage), null, "another machine has its own");
  storage.setItem("omni.models.m3", "{not json");
  assert.equal(cachedModels("m3", storage), null);
  storage.setItem("omni.models.m4", '{"models":"not a list"}');
  assert.equal(cachedModels("m4", storage), null);
  assert.doesNotThrow(() => keepModels("m5", choices, { setItem() { throw new Error("quota"); } }));
  assert.equal(cachedModels("m1", { getItem() { throw new Error("blocked"); } }), null);
  assert.equal(cachedModels("m1", null), null);
});

test("it holds names and sizes only: whatever else a list carries is not kept", () => {
  const storage = memoryStorage();
  keepModels("m1", { models: [{ provider: "p", id: "x", name: "X", contextWindow: 5, thinking: ["off"], thinkingLabels: {}, free: true, apiKey: "sk-secret", options: { headers: { authorization: "secret" } } }], levels: [], labels: {} }, storage);
  const text = storage.getItem("omni.models.m1");
  assert.doesNotMatch(text, /secret|apiKey|headers/);
  assert.deepEqual(cachedModels("m1", storage).models[0], { provider: "p", id: "x", name: "X", contextWindow: 5, thinking: ["off"], thinkingLabels: {}, free: true });
});

test("forgetting clears every machine's list and nothing else", () => {
  const storage = memoryStorage();
  keepModels("m1", { models: [], levels: [], labels: {} }, storage);
  keepModels("m2", { models: [], levels: [], labels: {} }, storage);
  storage.setItem("omni.machine", "keep me");
  forgetCachedModels(storage);
  assert.equal(storage.length, 1);
  assert.equal(storage.getItem("omni.machine"), "keep me");
  assert.doesNotThrow(() => forgetCachedModels(null));
});

// ------------------------------------------------------------------------- the first screen

test("nothing visible waits for the model list, the memory notes or the graph list", () => {
  const app = read("app.js");
  const init = app.slice(app.indexOf("async function init()"));
  assert.doesNotMatch(init, /await Promise\.all\(\[[^\]]*loadPiChoices/, "the first screen does not wait for the models");
  assert.doesNotMatch(init, /loadMemory|loadGraphList/, "a closed drawer's data is its own to load");
  assert.match(init, /\/api\/state\?first=1/);
  assert.ok(init.indexOf('showView(') < init.indexOf("afterFirstPaint"), "the screen first");
  assert.match(read("panel.js"), /if \(name === "memory"\) loadMemory/, "the drawer loads its own");
  assert.match(app, /\/history\?page=\$\{HISTORY_PAGE\}/);
  assert.match(app, /\?before=\$\{view\.olderAt\}&page=\$\{HISTORY_PAGE\}/);
});

test("Forget this page takes the model lists with it", () => {
  assert.match(read("web.js"), /forgetCachedModels\(\);[\s\S]{0,40}account\.signOut\(\{ forget: true \}\)/);
});
