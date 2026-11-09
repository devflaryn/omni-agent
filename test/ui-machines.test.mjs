// P2: every machine on the account in one window. The pure parts of ui/machines.js, the per-machine handles in
// ui/transport.js, and the links' word for a machine that refuses web pages.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { HERE, machineList, sidebarGroups, applySessionEvent, newWorkspace, mergedEventsUrl, fromMerged, createDrafts, whereWords } from "../ui/machines.js";
import { at, api, machine, setMachine, setTransportEnv, setChannelTransport, onStillWaiting, setStillWaitingAfter } from "../ui/transport.js";
import { MachineLinks } from "../ui/machine-links.js";
import { AccountError } from "../ui/account-error.js";
import { CLOSE_REASONS } from "../ui/channel-frames.js";

const B = { id: "bbbbbb111/+=", name: "Studio" };
const C = { id: "cccccc222", name: "Laptop" };
const remote = (m, extra = {}) => ({ id: m.id, name: m.name, kind: "desktop", online: true, link: { state: "idle", lastError: null }, ...extra });

// ------------------------------------------------------------------------------------------- the list
test("this computer comes first, then the others; a web page has no this computer", () => {
  const list = machineList({ here: { name: "Desk" }, machines: [remote(C), remote(B)] });
  assert.equal(list.length, 3);
  assert.equal(list[0].key, HERE);
  assert.equal(list[0].label, "This computer");
  assert.equal(list[0].here, true);
  assert.deepEqual(list.slice(1).map((m) => m.label).sort(), ["Laptop", "Studio"]);
  const web = machineList({ here: null, machines: [remote(B)] });
  assert.deepEqual(web.map((m) => m.key), [B.id]);
});

test("names that collide carry the short id; unique names do not", () => {
  const list = machineList({ here: { name: "PC" }, machines: [remote({ id: "aaaaaa1", name: "PC" }), remote({ id: "aaaaab2", name: "pc " }), remote(B)] });
  const labels = Object.fromEntries(list.map((m) => [m.key, m.label]));
  assert.equal(labels.aaaaaa1, "PC (aaaaaa)");
  assert.equal(labels.aaaaab2, "pc (aaaaab)");
  assert.equal(labels[B.id], "Studio");
  assert.equal(labels[HERE], "This computer", "this computer is never confused with the others");
});

test("each machine's state: online, offline, stalled, refusing web pages", () => {
  const list = machineList({ here: null, machines: [
    remote(B), remote(C, { online: false, link: { state: "offline" } }),
    remote({ id: "r1", name: "Locked" }, { link: { state: "refusing", lastError: CLOSE_REASONS["web-access-off"] } }),
    remote({ id: "s1", name: "Slow" }, { link: { state: "stalled" } }),
  ] });
  const state = Object.fromEntries(list.map((m) => [m.name, m.state]));
  assert.deepEqual(state, { Studio: "online", Laptop: "offline", Locked: "refusing", Slow: "stalled" });
  assert.equal(list.find((m) => m.name === "Laptop").online, false);
  // Names supplied by a device are cleaned before they are shown.
  assert.equal(machineList({ here: null, machines: [remote({ id: "x", name: `Evil${String.fromCodePoint(0x202e)}gnirts` })] })[0].name, "Evilgnirts");
});

test("whereWords names the machine whenever more than one is in the window", () => {
  const one = machineList({ here: { name: "Desk" }, machines: [] });
  assert.equal(whereWords(one, HERE), "");
  const two = machineList({ here: { name: "Desk" }, machines: [remote(B)] });
  assert.equal(whereWords(two, HERE), "this computer");
  assert.equal(whereWords(two, B.id), "Studio");
  assert.equal(whereWords(machineList({ here: null, machines: [remote(B)] }), B.id), "Studio", "a web page always names it");
});

// ---------------------------------------------------------------------------------------- the sidebar
test("the sidebar groups chats by machine, this computer first; offline and refusing machines show no chats and say why", () => {
  const list = machineList({ here: { name: "Desk" }, machines: [remote(B), remote(C, { online: false, link: { state: "offline" } })] });
  const here = newWorkspace(), b = newWorkspace(), c = newWorkspace();
  here.loaded = b.loaded = true;
  here.sessions.set("s1", { sid: "s1", title: "Fix the build", lastActivity: 2, harness: "pi" });
  b.sessions.set("s1", { sid: "s1", title: "Same sid, other machine", lastActivity: 5, harness: "pi" });
  b.sessions.set("s2", { sid: "s2", title: "Tidy notes", lastActivity: 9, harness: "pi" });
  c.sessions.set("old", { sid: "old", title: "Left from before", lastActivity: 1 }); // a machine gone offline keeps nothing on show
  const groups = sidebarGroups({ machines: list, workspaces: new Map([[HERE, here], [B.id, b], [C.id, c]]) });
  assert.deepEqual(groups.map((g) => g.m.key), [HERE, B.id, C.id]);
  assert.deepEqual(groups[1].sessions.map((s) => s.sid), ["s2", "s1"], "newest first within a machine");
  assert.equal(groups[0].sessions[0].title, "Fix the build", "the same sid on two machines is two chats");
  assert.equal(groups[2].note, "offline");
  assert.deepEqual(groups[2].sessions, []);

  const filtered = sidebarGroups({ machines: list, workspaces: new Map([[HERE, here], [B.id, b], [C.id, c]]), filter: "tidy" });
  assert.deepEqual(filtered.flatMap((g) => g.sessions.map((s) => s.title)), ["Tidy notes"]);
  const only = sidebarGroups({ machines: list, workspaces: new Map([[HERE, here], [B.id, b]]), only: B.id });
  assert.deepEqual(only.map((g) => g.m.key), [B.id]);
});

test("a machine still loading, failed or refusing says so by name in its group", () => {
  const list = machineList({ here: null, machines: [remote(B), remote(C), remote({ id: "r", name: "Locked" }, { link: { state: "refusing" } })] });
  const b = newWorkspace(), c = newWorkspace();
  c.error = "Could not reach Laptop: it stopped answering. Nothing was sent to it.";
  const groups = sidebarGroups({ machines: list, workspaces: new Map([[B.id, b], [C.id, c]]) });
  const note = Object.fromEntries(groups.map((g) => [g.m.name, g.note]));
  assert.equal(note.Studio, "loading");
  assert.match(note.Laptop, /Laptop/);
  assert.equal(note.Locked, "refusing");
});

// --------------------------------------------------------------------------------------- live events
test("a machine's events update its own workspace only: titles, streaming state, new chats, removal", () => {
  const ws = newWorkspace();
  applySessionEvent(ws, { kind: "session", sid: "n1", harness: "pi", cwd: "C:/w", title: "New chat", ts: 10, seq: 1 });
  assert.equal(ws.sessions.get("n1").title, "New chat");
  applySessionEvent(ws, { kind: "status", sid: "n1", harness: "pi", streaming: true, ts: 11, seq: 2 });
  assert.equal(ws.sessions.get("n1").streaming, true);
  assert.equal(ws.sessions.get("n1").lastActivity, 11);
  applySessionEvent(ws, { kind: "msg", sid: "n2", harness: "pi", role: "user", blocks: [{ type: "text", text: "Untitled until now" }], ts: 12, seq: 3 });
  assert.equal(ws.sessions.get("n2").title, "Untitled until now");
  assert.equal(ws.buffers.get("n2").length, 1, "kept for when the chat opens mid-turn");
  applySessionEvent(ws, { kind: "removed", sid: "n1", seq: 4 });
  assert.equal(ws.sessions.has("n1"), false);
  assert.equal(applySessionEvent(ws, { kind: "log", text: "x", seq: 5 }), null, "not a chat's event");
});

// ------------------------------------------------------------------------------------- the merged stream
test("the merged stream's URL carries each machine's own resume point, and is one path of this computer's", () => {
  const url = mergedEventsUrl([{ id: B.id, seq: 4, boot: "b00t" }, { id: C.id, seq: 0, boot: "" }]);
  assert.match(url, /^\/remote\/~events\?m=/);
  const parsed = JSON.parse(new URL(url, "http://x").searchParams.get("m"));
  assert.deepEqual(parsed, [{ id: B.id, since: 4, boot: "b00t" }, { id: C.id, since: 0, boot: "" }]);
});

test("from the merged stream only a machine's chat events and its resync are taken: never approval cards", () => {
  const known = new Set([B.id]);
  assert.deepEqual(fromMerged(JSON.stringify({ id: B.id, name: "message", data: '{"seq":1}' }), known), { id: B.id, name: "message", data: '{"seq":1}' });
  assert.deepEqual(fromMerged(JSON.stringify({ id: B.id, name: "resync", data: "{}" }), known).name, "resync");
  assert.equal(fromMerged(JSON.stringify({ id: B.id, name: "approvals", data: "[]" }), known), null, "another machine cannot paint this computer's cards");
  assert.equal(fromMerged(JSON.stringify({ id: "stranger", name: "message", data: "{}" }), known), null, "a machine the window does not show");
  assert.equal(fromMerged("not json", known), null);
  assert.equal(fromMerged(JSON.stringify({ id: B.id, name: "message", data: 5 }), known), null);
});

// ------------------------------------------------------------------------------------------- drafts
test("a half-typed message is kept per chat per machine", () => {
  const d = createDrafts();
  d.save(B.id, "s1", "half a thought");
  d.save(C.id, "s1", "another");
  d.save(HERE, "s1", "");
  assert.equal(d.take(B.id, "s1"), "half a thought");
  assert.equal(d.take(B.id, "s1"), "", "taken once");
  assert.equal(d.take(C.id, "s1"), "another");
  assert.equal(d.take(HERE, "s1"), "");
});

// ------------------------------------------------------------------------------------- transport handles
function fakeStorage() { const data = new Map(); return { data, getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)), removeItem: (k) => data.delete(k) }; }
const answer = (status, body) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
let calls, realFetch, reloads, confirms;
beforeEach(() => {
  calls = []; reloads = 0; confirms = [];
  realFetch = globalThis.fetch;
  setTransportEnv({ storage: fakeStorage(), reload: () => { reloads++; }, confirm: (t) => { confirms.push(t); return false; } });
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); return answer(200, { ok: true }); };
});
afterEach(() => { globalThis.fetch = realFetch; });

test("a handle stays on its machine whatever the window is focused on", async () => {
  const onB = at(B);
  setMachine(C.id, { name: C.name });
  await onB.api("GET", "/api/state?first=1");
  await at(null).api("GET", "/api/state");
  await api("GET", "/api/x");
  assert.deepEqual(calls.map((c) => c.url), [`/remote/${encodeURIComponent(B.id)}/api/state?first=1`, "/api/state", `/remote/${C.id}/api/x`]);
  assert.equal(onB.eventSource ? typeof onB.eventSource : "", "function");
  globalThis.fetch = async () => answer(502, { error: "x", code: "machine-lost" });
  await assert.rejects(onB.api("POST", "/api/pi/prompt", {}), (e) => e.code === "machine-lost");
  globalThis.fetch = async () => { throw new TypeError("fetch failed"); };
  await assert.rejects(onB.api("POST", "/api/pi/prompt", {}), /Studio/);
});

test("changing machine never reloads the window; unsaved files are asked about first, and No changes nothing", async () => {
  assert.equal(setMachine(B.id, { name: B.name }), true);
  assert.equal(reloads, 0);
  assert.deepEqual(machine(), { id: B.id, name: B.name });
  const { onLeaveCheck } = await import("../ui/transport.js");
  const off = onLeaveCheck(() => "A file has unsaved changes.");
  try {
    assert.equal(setMachine(C.id, { name: C.name }), false, "the person said no");
    assert.equal(machine().id, B.id);
    assert.match(confirms[0], /unsaved changes/);
    assert.equal(setMachine(C.id, { name: C.name, whenClean: true }), false, "not the person's choice: it waits");
    assert.equal(setMachine(B.id, { name: B.name }), true, "the same machine is no switch, and asks nothing");
    assert.equal(confirms.length, 1);
  } finally { off(); }
  assert.equal(reloads, 0);
});

test("a web page hands each machine its own channel transport", async () => {
  const seen = [];
  const make = (m) => ({ api: async (method, path) => { seen.push([m.id, method, path]); return { from: m.id }; }, eventSource: (url) => ({ url, m: m.id }), rawUrl: async (p) => `blob:${m.id}${p}` });
  setChannelTransport({ ...make({ id: "focus" }), forMachine: make, local: { api: async () => ({}) } });
  setMachine(B.id, { name: B.name });
  assert.deepEqual(await at(C).api("GET", "/api/state?first=1"), { from: C.id });
  assert.deepEqual(at(C).eventSource("/events"), { url: "/events", m: C.id });
  assert.deepEqual(await api("GET", "/api/x"), { from: B.id }, "the focus goes to its own machine too");
  assert.equal(calls.length, 0);
});

test("past the wait, a handle on another machine says so too", async () => {
  setStillWaitingAfter(20);
  const heard = [];
  const off = onStillWaiting((n) => heard.push(n));
  let finish;
  globalThis.fetch = () => new Promise((r) => { finish = r; });
  try {
    const slow = at(B).api("POST", "/slow", {});
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(heard, [1]);
    finish(answer(200, {}));
    await slow;
    assert.deepEqual(heard, [1, 0]);
  } finally { off(); setStillWaitingAfter(30_000); }
});

// ------------------------------------------------------------------------------------ refusing web pages
test("a machine with Allow web page access off is refusing, not broken, and says so by name", async () => {
  const device = { id: "d", name: "Studio", kind: "desktop", role: "full", online: true, self: false };
  const account = { devices: () => [device], status: () => ({ phase: "approved", hub: { connected: true } }), openChannel: async () => { throw new AccountError(502, "channel-refused", CLOSE_REASONS["web-access-off"]); } };
  const links = new MachineLinks({ account, selfName: "this page", connectTimeoutMs: 200, budgetMs: 500 });
  try {
    await assert.rejects(links.request("d", { method: "GET", path: "/api/state" }), (e) => e.code === "machine-refusing" && e.status === 403 && /Studio/.test(e.message) && /Allow web page access/.test(e.message) && /Nothing was sent/.test(e.message));
    assert.equal(links.machines()[0].link.state, "refusing");
  } finally { links.close(); }
});

test("app.js reloads for no machine: every switch keeps the window", () => {
  const app = readFileSync(new URL("../ui/app.js", import.meta.url), "utf8");
  assert.doesNotMatch(app, /location\.reload\(\)/);
  assert.doesNotMatch(app, /setMachine\([^)]*reload:\s*true/);
});
