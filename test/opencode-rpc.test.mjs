import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { OpencodeRpc, RUN_ONCE_TOOLS, allowTools, modelThinking, runOnce } from "../server/opencode-rpc.mjs";
import { FakeServer } from "./helpers/fake-opencode.mjs";
import { normalizePiEntry } from "../server/normalize.mjs";
import { latestPlan } from "../ui/plan.js";
import { Bus } from "../server/bus.mjs";
import { GoalKeeper } from "../server/hook.mjs";

const fx = JSON.parse(readFileSync(new URL("./fixtures/opencode-turn.json", import.meta.url), "utf8"));

const tick = () => new Promise((r) => setImmediate(r));
async function waitFor(cond, what = "condition") {
  for (let i = 0; i < 200; i++) { if (cond()) return; await tick(); }
  assert.fail(`timed out waiting for ${what}`);
}

/** An OpencodeRpc on a FakeServer with a temp mirror dir; `bus` collects every omni event. */
function setup({ reply, ...opts } = {}) {
  const server = new FakeServer({ reply });
  const events = [];
  const mirrorDir = join(mkdtempSync(join(tmpdir(), "omni-ocrpc-")), "opencode");
  const cwd = mkdtempSync(join(tmpdir(), "omni-ocrpc-cwd-"));
  const rpc = new OpencodeRpc({ server, cwd, provider: "opencode", model: "big-pickle", bus: { emit(ev) { events.push(ev); } }, mirrorDir, ...opts });
  return { server, rpc, events, mirrorDir, cwd };
}
const lines = (file) => readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const posts = (server, re) => server.calls.filter((c) => c.method === "POST" && re.test(c.path));

/** A fixture case replayed for session `sid` (its payloads rewritten to that id). */
function replay(server, c, sid) {
  const json = JSON.stringify(c.payloads).split(c.sessionID).join(sid);
  for (const p of JSON.parse(json)) server.push(p);
}

// Hand-built payloads for a plan tool turn.
const S = "ses_fake1";
const plan = { goal: "ship it", milestones: [{ id: 1, title: "build", steps: [{ id: "1.1", title: "compile", status: "active", done_when: "it builds" }] }] };
const planTurn = (sid = S) => {
  const part = (p) => ({ type: "message.part.updated", properties: { sessionID: sid, part: { sessionID: sid, ...p } } });
  const st = { input: { action: "create" }, title: "plan", time: { start: 3 } };
  return [
    { type: "message.updated", properties: { sessionID: sid, info: { id: "msg_u1", sessionID: sid, role: "user", time: { created: 1000 } } } },
    part({ id: "prt_u1", messageID: "msg_u1", type: "text", text: "make a plan" }),
    { type: "session.status", properties: { sessionID: sid, status: { type: "busy" } } },
    { type: "message.updated", properties: { sessionID: sid, info: { id: "msg_a1", sessionID: sid, role: "assistant", time: { created: 2000 }, modelID: "big-pickle", providerID: "opencode", tokens: { input: 900, output: 5, reasoning: 0, cache: { read: 200, write: 0 } }, cost: 0 } } },
    part({ id: "prt_t1", messageID: "msg_a1", type: "tool", tool: "plan", callID: "call_1", state: { status: "running", ...st } }),
    part({ id: "prt_t1", messageID: "msg_a1", type: "tool", tool: "plan", callID: "call_1", state: { status: "completed", ...st, output: "plan created", metadata: { plan, events: ["created"], ok: true }, time: { start: 3, end: 4 } } }),
    { type: "message.updated", properties: { sessionID: sid, info: { id: "msg_a1", sessionID: sid, role: "assistant", time: { created: 2000, completed: 5000 }, finish: "tool-calls", modelID: "big-pickle", providerID: "opencode", tokens: { input: 900, output: 5, reasoning: 0, cache: { read: 200, write: 0 } }, cost: 0 } } },
    { type: "session.idle", properties: { sessionID: sid } },
  ];
};

test("start creates a session, writes the mirror header and announces sid pi:<id>", async () => {
  const { server, rpc, events, mirrorDir, cwd } = setup({ thinking: "high" });
  assert.equal(rpc.sid, "pi:pending");
  assert.equal(rpc.proc, null, "no proc before start");
  rpc.start();
  await rpc.waitReady();
  assert.deepEqual({ ...server.calls[0], timeoutMs: undefined }, { method: "POST", path: "/session", directory: cwd, body: {}, timeoutMs: undefined });
  assert.equal(rpc.sid, "pi:ses_fake1");
  const [file] = readdirSync(mirrorDir);
  assert.match(file, /^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.\d{3}Z_ses_fake1\.jsonl$/);
  const head = lines(join(mirrorDir, file));
  assert.equal(head.length, 1);
  assert.deepEqual({ ...head[0], timestamp: "t" }, { type: "session", version: 3, id: "ses_fake1", cwd, timestamp: "t", harness: "opencode" });
  assert.equal(rpc.state.sessionFile, join(mirrorDir, file));
  assert.ok(rpc.owns(join(mirrorDir, file)));
  assert.deepEqual(rpc.state.model, { provider: "opencode", id: "big-pickle", name: "Big Pickle", contextWindow: 200000, maxTokens: 32000, reasoning: true, variants: ["off", "low", "medium", "high"] });
  assert.equal(rpc.state.thinkingLevel, "high");
  assert.equal(rpc.state.isStreaming, false);
  assert.equal(rpc.state.sessionName, undefined, "OpenCode's placeholder title is not a name");
  const session = events.find((e) => e.kind === "session");
  assert.equal(session.sid, "pi:ses_fake1");
  assert.equal(session.harness, "pi");
  assert.equal(session.owned, true);
  assert.equal(session.file, rpc.state.sessionFile);
  assert.equal(session.sessionId, "ses_fake1");
  assert.equal(session.model, "big-pickle");
  assert.equal(session.provider, "opencode");
  assert.equal(session.cwd, cwd);
  assert.ok(events.some((e) => e.kind === "status" && e.streaming === false && e.sid === "pi:ses_fake1"));
  assert.equal(server.listeners_("ses_fake1"), 1, "listens to its session");
});

test("prompt posts prompt_async with model, variant and echo", async () => {
  const { server, rpc, events } = setup({ thinking: "high", system: "You are an agent.", tools: { bash: false } });
  rpc.start();
  await rpc.waitReady();
  const r = await rpc.prompt("hello", { images: [{ type: "image", mimeType: "image/png", data: "QUJD" }] });
  assert.deepEqual(r, { success: true });
  const [call] = posts(server, /prompt_async$/);
  assert.equal(call.path, "/session/ses_fake1/prompt_async");
  assert.deepEqual(call.body, {
    parts: [{ type: "text", text: "hello" }, { type: "file", mime: "image/png", url: "data:image/png;base64,QUJD" }],
    model: { providerID: "opencode", modelID: "big-pickle" }, variant: "high", system: "You are an agent.", tools: { bash: false }, agent: "build",
  });
  const echo = events.find((e) => e.kind === "msg" && e.role === "user");
  assert.equal(echo.live, true);
  assert.deepEqual(echo.blocks, [{ type: "text", text: "hello" }]);
  assert.equal(echo.sid, "pi:ses_fake1");
  assert.equal(rpc.inFlight, 0);

  events.length = 0;
  await rpc.prompt("quiet", { echo: false });
  assert.ok(!events.some((e) => e.kind === "msg"), "echo:false broadcasts no user bubble");

  // off → the model's "none" variant; a model without one gets no variant at all.
  await rpc.setThinking("off");
  await rpc.prompt("a");
  assert.equal(posts(server, /prompt_async$/).at(-1).body.variant, "none");
  await rpc.setModel("opencode", "think");
  await rpc.prompt("b");
  const last = posts(server, /prompt_async$/).at(-1).body;
  assert.ok(!("variant" in last), "off without a none variant sends no variant");
  assert.deepEqual(last.model, { providerID: "opencode", modelID: "think" });
});

test("prompt resolves success:false with the server's message on an HTTP error", async () => {
  const err = Object.assign(new Error("Model not found: nope/nope"), { status: 400 });
  const { rpc } = setup({ reply: (m, p) => (/prompt_async$/.test(p) ? err : undefined) });
  rpc.start();
  await rpc.waitReady();
  const r = await rpc.prompt("hi");
  assert.deepEqual(r, { success: false, error: "Model not found: nope/nope" });
  assert.equal(rpc.inFlight, 0);
});

test("a steer while streaming posts without waiting", async () => {
  const { server, rpc } = setup();
  rpc.start();
  await rpc.waitReady();
  server.push({ type: "session.status", properties: { sessionID: S, status: { type: "busy" } } });
  assert.equal(rpc.streaming, true);
  const r = await rpc.prompt("also do this", { behavior: "steer" });
  assert.deepEqual(r, { success: true });
  const [call] = posts(server, /prompt_async$/);
  assert.ok(call, "posted while the run is still going");
  assert.ok(!("system" in call.body) && !("tools" in call.body), "no system or tools unless given");
  assert.equal(rpc.streaming, true, "still the same run");
});

test("events drive streaming and the bus (via translator)", async () => {
  const sid = fx.tool.sessionID;
  const { server, rpc, events } = setup({ reply: (m, p) => (m === "POST" && p === "/session" ? { id: sid } : undefined) });
  const raw = [];
  rpc.on("pi", (ev) => raw.push(ev.type));
  rpc.start();
  await rpc.waitReady();
  events.length = 0;
  replay(server, fx.tool, sid);
  const statuses = events.filter((e) => e.kind === "status" && "streaming" in e).map((e) => e.streaming);
  assert.deepEqual(statuses, [true, false]);
  assert.ok(events.some((e) => e.kind === "tool" && e.phase === "start" && e.name === "bash"));
  assert.ok(events.some((e) => e.kind === "tool" && e.phase === "end" && e.name === "bash"));
  assert.ok(events.some((e) => e.kind === "msg" && e.role === "assistant" && e.live));
  assert.ok(events.every((e) => e.sid === `pi:${sid}`));
  assert.equal(rpc.streaming, false);
  assert.equal(rpc.openTools.size, 0);
  assert.ok(rpc.lastEventAt > 0);
  assert.ok(raw.includes("agent_start") && raw.includes("agent_settled"), "every rpc event is re-emitted as \"pi\"");
});

test("mirror gets user/assistant/toolResult entries and the watcher's normalizePiEntry reads them back", async () => {
  const sid = fx.tool.sessionID;
  const { server, rpc, cwd } = setup({ reply: (m, p) => (m === "POST" && p === "/session" ? { id: sid } : undefined) });
  rpc.start();
  await rpc.waitReady();
  replay(server, fx.tool, sid);
  const all = lines(rpc.state.sessionFile);
  const roles = all.filter((e) => e.type === "message").map((e) => e.message.role);
  assert.ok(roles.includes("user") && roles.includes("assistant") && roles.includes("toolResult"), roles.join(","));
  for (let i = 2; i < all.length; i++) assert.equal(all[i].parentId, all[i - 1].id, "entries chain");
  const ctx = { sid: `pi:${sid}`, harness: "pi" };
  const evs = all.flatMap((e) => normalizePiEntry(e, ctx));
  assert.equal(evs[0].kind, "session");
  assert.equal(evs[0].cwd, cwd);
  const msgs = evs.filter((e) => e.kind === "msg");
  assert.deepEqual([...new Set(msgs.map((e) => e.role))].sort(), ["assistant", "tool", "user"]);
  assert.ok(msgs.every((e) => e.live === false));
  assert.ok(msgs.find((e) => e.role === "user").blocks[0].text.length > 0);
});

test("an abort's events after the settle are still mirrored", async () => {
  const sid = fx.abort.sessionID;
  const { server, rpc, events } = setup({ reply: (m, p) => (m === "POST" && p === "/session" ? { id: sid } : undefined) });
  rpc.start();
  await rpc.waitReady();
  replay(server, fx.abort, sid);
  const settled = events.findIndex((e) => e.kind === "status" && e.streaming === false && events.indexOf(e) > 2);
  const aborted = events.findIndex((e) => e.kind === "msg" && e.role === "assistant" && e.stopReason === "aborted");
  assert.ok(settled >= 0 && aborted > settled, "OpenCode settles before the aborted message ends");
  const all = lines(rpc.state.sessionFile);
  assert.equal(all.find((e) => e.message?.role === "assistant").message.stopReason, "aborted");
  assert.ok(all.some((e) => e.message?.role === "toolResult"));
  assert.equal(rpc.streaming, false);
});

test("entries() returns the mirror's entries so latestPlan finds the plan", async () => {
  const { server, rpc } = setup();
  rpc.start();
  await rpc.waitReady();
  for (const p of planTurn()) server.push(p);
  const r = await rpc.entries();
  assert.equal(r.success, true);
  assert.ok(r.data.entries.every((e) => e.type !== "session"), "the header is not an entry");
  assert.equal(r.data.leafId, r.data.entries.at(-1).id);
  assert.deepEqual(latestPlan(r.data.entries, r.data.leafId), plan);
  const m = await rpc.messages();
  assert.deepEqual(m.data.messages.map((x) => x.role), ["user", "assistant", "toolResult"]);
  const s = await rpc.stats();
  assert.equal(s.data.sessionId, "ses_fake1");
  assert.equal(s.data.userMessages, 1);
  assert.equal(s.data.assistantMessages, 1);
  assert.equal(s.data.toolCalls, 1);
  assert.equal(s.data.tokens.input, 900);
  assert.equal(s.data.tokens.cacheRead, 200);
});

test("clone forks and switches the mirror", async () => {
  const { server, rpc, events, mirrorDir } = setup();
  rpc.start();
  await rpc.waitReady();
  for (const p of planTurn()) server.push(p);
  const oldFile = rpc.state.sessionFile;
  const before = readFileSync(oldFile, "utf8");
  // OpenCode copies the history into the fork under new ids and announces the copies as new messages.
  const F = "ses_fork2";
  const copies = [
    { info: { id: "msg_cu1", sessionID: F, role: "user", time: { created: 1000 } }, parts: [{ id: "prt_cu1", sessionID: F, messageID: "msg_cu1", type: "text", text: "make a plan" }] },
    { info: { id: "msg_ca1", sessionID: F, role: "assistant", time: { created: 2000, completed: 5000 }, finish: "stop", modelID: "big-pickle", providerID: "opencode", tokens: {}, cost: 0 }, parts: [{ id: "prt_ca1", sessionID: F, messageID: "msg_ca1", type: "text", text: "done", time: { end: 5000 } }] },
  ];
  server.history.set(F, copies);
  events.length = 0;
  const r = await rpc.clone();
  for (const m of copies) {
    server.push({ type: "message.updated", properties: { sessionID: F, info: m.info } });
    for (const part of m.parts) server.push({ type: "message.part.updated", properties: { sessionID: F, part } });
  }
  assert.equal(rpc.streaming, false, "the fork's copies are not a run");
  assert.ok(!events.some((e) => e.kind === "msg" || e.kind === "status" && e.streaming), "nor news");
  assert.equal(r.success, true);
  const [fork] = posts(server, /\/fork$/);
  assert.equal(fork.path, "/session/ses_fake1/fork");
  assert.deepEqual(fork.body, {});
  assert.equal(rpc.sid, "pi:ses_fork2");
  const file = rpc.state.sessionFile;
  assert.notEqual(file, oldFile);
  assert.ok(basename(file).endsWith("_ses_fork2.jsonl"));
  assert.equal(readFileSync(oldFile, "utf8"), before, "the original stays untouched");
  const [h0, ...rest0] = lines(oldFile), [h1, ...rest1] = lines(file);
  assert.equal(h1.id, "ses_fork2");
  assert.equal(h1.harness, "opencode");
  assert.equal(h1.cwd, h0.cwd);
  const known = rest1.pop();
  assert.deepEqual(rest1, rest0, "history copied verbatim, the copies not mirrored again");
  assert.equal(known.type, "custom");
  assert.equal(known.customType, "opencode-known");
  assert.deepEqual(known.data.messageIDs, ["msg_cu1", "msg_ca1"], "the fork's copies are remembered in the mirror");
  assert.deepEqual(normalizePiEntry(known, { sid: "x", harness: "pi" }), [], "and stay invisible");
  assert.ok(events.some((e) => e.kind === "session" && e.sid === "pi:ses_fork2" && e.file === file));
  assert.equal(server.listeners_("ses_fake1"), 0, "stops listening to the old session");
  // New payloads go to the fork's mirror and chain onto the copied history.
  server.push({ type: "message.updated", properties: { sessionID: "ses_fork2", info: { id: "msg_u2", sessionID: "ses_fork2", role: "user", time: { created: 9000 } } } });
  server.push({ type: "message.part.updated", properties: { sessionID: "ses_fork2", part: { id: "prt_u2", sessionID: "ses_fork2", messageID: "msg_u2", type: "text", text: "again" } } });
  server.push({ type: "session.status", properties: { sessionID: "ses_fork2", status: { type: "busy" } } });
  server.push({ type: "session.idle", properties: { sessionID: "ses_fork2" } });
  const after = lines(file);
  assert.equal(after.at(-1).id, "msg_u2");
  assert.equal(after.at(-1).parentId, known.id);
  assert.equal(readFileSync(oldFile, "utf8"), before);
  assert.ok(existsSync(oldFile), "a session with history is kept");
  // Reopening the fork later (another chat, e.g. after an Omni restart) does not back-fill the copies either.
  const forkBefore = readFileSync(file, "utf8");
  server.history.set(F, [...copies, { info: { id: "msg_u2", sessionID: F, role: "user", time: { created: 9000 } }, parts: [{ id: "prt_u2", type: "text", text: "again" }] }]);
  const other = new OpencodeRpc({ server, cwd: rpc.cwd, provider: "opencode", model: "big-pickle", bus: { emit() {} }, mirrorDir });
  other.start();
  await other.waitReady();
  await other.switchSession(file);
  assert.equal(readFileSync(file, "utf8"), forkBefore);
});

test("a posted prompt counts as a running turn until OpenCode settles it", async () => {
  const { server, rpc, events } = setup();
  rpc.start();
  await rpc.waitReady();
  events.length = 0;
  await rpc.prompt("go");
  assert.equal(rpc.streaming, true, "busy from the accepted post, whichever socket answers first");
  assert.ok(Date.now() - rpc.lastEventAt < 1000, "the watchdog counts from the post");
  server.push({ type: "session.status", properties: { sessionID: S, status: { type: "busy" } } });
  assert.equal(events.filter((e) => e.kind === "status" && e.streaming === true).length, 1, "busy is not announced twice");
  server.push({ type: "session.idle", properties: { sessionID: S } });
  assert.equal(rpc.streaming, false);
  assert.equal(events.filter((e) => e.kind === "status" && e.streaming === false).length, 1);
});

test("a turn that settled before the post answered is not reopened", async () => {
  let server;
  const ctx = setup({ reply: (m, p) => {
    if (!/prompt_async$/.test(p)) return undefined;
    server.push({ type: "session.status", properties: { sessionID: S, status: { type: "busy" } } });
    server.push({ type: "session.idle", properties: { sessionID: S } });
    return null;
  } });
  server = ctx.server;
  const { rpc } = ctx;
  rpc.start();
  await rpc.waitReady();
  await rpc.prompt("quick");
  assert.equal(rpc.streaming, false);
});

test("switchSession back-fills messages the mirror missed while no chat was attached", async () => {
  const { server, rpc, mirrorDir, cwd } = setup();
  rpc.start();
  await rpc.waitReady();
  const T = "ses_titled";
  const file = join(mirrorDir, `2026-10-20T10-00-00.000Z_${T}.jsonl`);
  const A = { info: { id: "msg_A", sessionID: T, role: "user", time: { created: 1 } }, parts: [{ id: "prt_A", type: "text", text: "do it" }] };
  const B = { info: { id: "msg_B", sessionID: T, role: "assistant", time: { created: 2, completed: 3 }, finish: "stop", modelID: "big-pickle", providerID: "opencode", tokens: {}, cost: 0 }, parts: [{ id: "prt_B", type: "text", text: "working" }] };
  const C = { info: { id: "msg_C", sessionID: T, role: "assistant", time: { created: 4, completed: 5 }, finish: "stop", modelID: "big-pickle", providerID: "opencode", tokens: {}, cost: 0 }, parts: [{ id: "prt_C", type: "text", text: "finished" }] };
  const head = JSON.stringify({ type: "session", version: 3, id: T, cwd, timestamp: "2026-10-20T10:00:00.000Z", harness: "opencode" });
  const { historyEntries } = await import("../server/opencode-events.mjs");
  writeFileSync(file, [head, ...historyEntries([A, B]).map((e) => JSON.stringify(e))].join("\n") + "\n");
  server.history.set(T, [A, B, C]);
  await rpc.switchSession(file);
  const all = lines(file);
  assert.equal(all.filter((e) => e.id === "msg_C").length, 1, "C is mirrored once");
  assert.equal(all.filter((e) => e.id === "msg_A" || e.id === "msg_B").length, 2, "A and B are not repeated");
  assert.equal(all.at(-1).id, "msg_C");
  assert.equal(all.at(-1).parentId, all.at(-2).id);
  server.push({ type: "message.updated", properties: { sessionID: T, info: C.info } });
  assert.equal(lines(file).filter((e) => e.id === "msg_C").length, 1);
});

test("a failed start logs, reports no proc, and opens its session with the next prompt", async () => {
  let fail = true;
  const { server, rpc, events } = setup({ reply: (m, p) => (m === "POST" && p === "/session" && fail ? Object.assign(new Error("database is locked"), { status: 500 }) : undefined) });
  rpc.start();
  await assert.rejects(rpc.waitReady(), /database is locked/);
  assert.ok(events.some((e) => e.kind === "log" && e.level === "system" && /database is locked/.test(e.text)));
  assert.equal(rpc.proc, null, "no chat is routed to a chat without a session");
  assert.equal(rpc.sid, "pi:pending");
  fail = false;
  assert.deepEqual(await rpc.prompt("hi"), { success: true });
  assert.equal(rpc.sid, "pi:ses_fake1");
  assert.ok(rpc.proc);
  assert.equal(posts(server, /^\/session\/ses_fake1\/prompt_async$/).length, 1);
});

test("a start that failed while the server was down opens its session when it is back", async () => {
  let fail = true;
  const { server, rpc } = setup({ reply: (m, p) => (m === "POST" && p === "/session" && fail ? new Error("opencode server is not running") : undefined) });
  rpc.start();
  await assert.rejects(rpc.waitReady());
  server.up = false;
  server.emit("down");
  fail = false;
  server.up = true;
  server.emit("up");
  await waitFor(() => rpc.sid === "pi:ses_fake1", "the session");
  await rpc.waitReady();
  assert.ok(rpc.proc);
});

test("stop() while the session is being created leaves nothing behind", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { server, rpc, events, mirrorDir } = setup({ reply: (m, p) => (m === "POST" && p === "/session" ? gate.then(() => ({ id: "ses_late" })) : undefined) });
  rpc.start();
  rpc.stop();
  release();
  await assert.rejects(rpc.waitReady());
  await tick();
  assert.equal(server.listeners_("ses_late"), 0, "no listener leaks");
  assert.ok(!events.some((e) => e.kind === "session"), "a stopped chat announces nothing");
  assert.ok(!existsSync(mirrorDir) || readdirSync(mirrorDir).length === 0, "no mirror");
  assert.ok(server.calls.some((c) => c.method === "DELETE" && c.path === "/session/ses_late"), "the late session is removed");
});

test("stop() drops a session nobody used", async () => {
  const { server, rpc } = setup();
  rpc.start();
  await rpc.waitReady();
  const file = rpc.state.sessionFile;
  rpc.stop();
  assert.ok(!existsSync(file));
  assert.ok(server.calls.some((c) => c.method === "DELETE" && c.path === "/session/ses_fake1"));
  const { rpc: used, server: s2 } = setup();
  used.start();
  await used.waitReady();
  await used.prompt("keep me");
  const kept = used.state.sessionFile;
  used.stop();
  assert.ok(existsSync(kept));
  assert.ok(!s2.calls.some((c) => c.method === "DELETE"));
});

test("clone fails loudly when the fork's messages cannot be read", async () => {
  const { server, rpc, events } = setup({ reply: (m, p) => (m === "GET" && p === "/session/ses_fork2/message" ? Object.assign(new Error("boom"), { status: 500 }) : undefined) });
  rpc.start();
  await rpc.waitReady();
  for (const p of planTurn()) server.push(p);
  await assert.rejects(rpc.clone(), /boom/);
  assert.equal(rpc.sid, "pi:ses_fake1", "the chat stays on its session");
  assert.ok(events.some((e) => e.kind === "log" && e.level === "system" && /boom/.test(e.text)));
  assert.ok(server.calls.some((c) => c.method === "DELETE" && c.path === "/session/ses_fork2"));
});

test("down emits exit once; a chat stopped then does not reattach on up", async () => {
  const { server, rpc } = setup();
  let restarted = 0;
  rpc.onRestart = async () => { restarted++; };
  rpc.start();
  await rpc.waitReady();
  await rpc.prompt("work");
  const exits = [];
  rpc.on("exit", (c) => exits.push(c));
  server.up = false;
  server.emit("down");
  assert.deepEqual(exits, [null]);
  rpc.stop(); // what agents.onPiExit does
  assert.equal(exits.length, 1, "exit once");
  const n = server.calls.length;
  server.up = true;
  server.emit("up");
  await tick(); await tick();
  assert.equal(restarted, 0);
  // Nothing reattached: the only call is the deferred abort of the run the outage cut off.
  assert.deepEqual(server.calls.slice(n).map((c) => `${c.method} ${c.path}`), ["POST /session/ses_fake1/abort"]);
});

test("onRestart failures are logged", async () => {
  const { server, rpc, events } = setup();
  rpc.onRestart = async () => { throw new Error("goal gone"); };
  rpc.start();
  await rpc.waitReady();
  server.up = false;
  server.emit("down");
  server.up = true;
  server.emit("up");
  await waitFor(() => events.some((e) => e.kind === "log" && /resume failed: goal gone/.test(e.text)), "the log");
  await waitFor(() => !rpc.restoring, "restoring cleared");
});

test("abort without a session sends nothing", async () => {
  const { server, rpc } = setup();
  const r = await rpc.abort();
  assert.equal(r.success, false);
  assert.equal(server.calls.length, 0);
});

test("switchSession(opencode mirror) attaches to that session", async () => {
  const { server, rpc, mirrorDir, cwd } = setup();
  rpc.start();
  await rpc.waitReady();
  const empty = rpc.state.sessionFile;
  const file = join(mirrorDir, "2026-10-20T10-00-00.000Z_ses_titled.jsonl");
  writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id: "ses_titled", cwd, timestamp: "2026-10-20T10:00:00.000Z", harness: "opencode" })}\n${JSON.stringify({ type: "message", id: "msg_old", parentId: null, timestamp: "2026-10-20T10:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "old" }], timestamp: 1 } })}\n`);
  server.status = { ses_titled: { type: "busy" } };
  const r = await rpc.switchSession(file);
  assert.equal(r.success, true);
  assert.equal(rpc.sid, "pi:ses_titled");
  assert.equal(rpc.state.sessionFile, file);
  assert.equal(rpc.state.sessionName, "Fix the build");
  assert.equal(rpc.streaming, true, "a session OpenCode is still running reads as streaming");
  assert.ok(server.calls.some((c) => c.method === "GET" && c.path === "/session/ses_titled"));
  assert.equal(server.listeners_("ses_fake1"), 0);
  assert.equal(server.listeners_("ses_titled"), 1);
  // The empty session start() made is dropped, like pi never writing a session nobody used.
  assert.ok(!existsSync(empty), "the unused empty mirror is removed");
  assert.ok(server.calls.some((c) => c.method === "DELETE" && c.path === "/session/ses_fake1"));
  server.push({ type: "message.updated", properties: { sessionID: "ses_titled", info: { id: "msg_new", sessionID: "ses_titled", role: "user", time: { created: 9000 } } } });
  server.push({ type: "message.part.updated", properties: { sessionID: "ses_titled", part: { id: "prt_new", sessionID: "ses_titled", messageID: "msg_new", type: "text", text: "next" } } });
  server.push({ type: "session.idle", properties: { sessionID: "ses_titled" } });
  const all = lines(file);
  assert.equal(all.at(-1).id, "msg_new");
  assert.equal(all.at(-1).parentId, "msg_old", "continues the existing chain");
  assert.equal(rpc.streaming, false);

  const junk = join(mirrorDir, "junk.jsonl");
  writeFileSync(junk, "not json\n");
  await assert.rejects(rpc.switchSession(junk), /not a chat file/);
  assert.equal(rpc.sid, "pi:ses_titled", "a refused switch keeps the chat where it was");
});

test("continuing a pi chat seeds a noReply transcript and copies history", async () => {
  const seedId = "msg_seed1";
  const { server, rpc, mirrorDir, cwd, events } = setup({
    reply: (m, p, o) => (m === "POST" && /^\/session\/[^/]+\/message$/.test(p) ? { info: { id: seedId, role: "user" }, parts: [] } : undefined),
  });
  rpc.start();
  await rpc.waitReady();
  const empty = rpc.state.sessionFile;
  const msg = (id, parentId, message) => ({ type: "message", id, parentId, timestamp: "2026-10-20T10:00:00.000Z", message });
  const entries = [
    msg("p1", null, { role: "user", content: [{ type: "text", text: "make a plan" }] }),
    msg("p2", "p1", { role: "assistant", content: [{ type: "thinking", thinking: "SECRET-THOUGHT" }, { type: "text", text: "on it" }, { type: "toolCall", id: "t1", name: "plan", arguments: { action: "create" } }] }),
    msg("p3", "p2", { role: "toolResult", toolCallId: "t1", toolName: "plan", content: [{ type: "text", text: "plan created" }], details: { plan, events: [], ok: true } }),
  ];
  const pi = join(mirrorDir, "2026-10-20T10-00-00.000Z_0b1c0b1c-0b1c-0b1c-0b1c-0b1c0b1c0b1c.jsonl");
  writeFileSync(pi, [{ type: "session", version: 3, id: "0b1c", cwd, timestamp: "2026-10-20T10:00:00.000Z" }, ...entries].map((e) => JSON.stringify(e)).join("\n") + "\n");
  const before = readFileSync(pi, "utf8");
  const r = await rpc.switchSession(pi);
  assert.equal(r.success, true);
  assert.equal(readFileSync(pi, "utf8"), before, "the pi file is untouched");
  assert.equal(rpc.sid, "pi:ses_fake2");
  assert.notEqual(rpc.state.sessionFile, pi);
  assert.ok(!existsSync(empty));
  const seed = posts(server, /^\/session\/ses_fake2\/message$/);
  assert.equal(seed.length, 1);
  assert.equal(seed[0].body.noReply, true);
  const text = seed[0].body.parts[0].text;
  assert.ok(text.startsWith("Earlier conversation, imported from pi (most recent last):\n"));
  assert.match(text, /User: make a plan/);
  assert.match(text, /Assistant: on it/);
  assert.match(text, /plan/);
  assert.match(text, /plan created/);
  assert.ok(!text.includes("SECRET-THOUGHT"));

  const all = lines(rpc.state.sessionFile);
  assert.equal(all[0].harness, "opencode");
  assert.equal(all[0].id, "ses_fake2");
  assert.deepEqual(all.slice(1, 4), entries, "the pi entries are copied verbatim");
  const known = all[4];
  assert.equal(known.customType, "opencode-known");
  assert.deepEqual(known.data.messageIDs, [seedId]);
  assert.equal(known.parentId, "p3");

  // The transcript message never shows up as a visible user message, and the chain continues from the old tail.
  server.history.set("ses_fake2", [{ info: { id: seedId, sessionID: "ses_fake2", role: "user", time: { created: 1 } }, parts: [{ id: "prt_s", messageID: seedId, type: "text", text }] }]);
  events.length = 0;
  await rpc.reconcile();
  assert.equal(lines(rpc.state.sessionFile).length, all.length, "nothing back-filled");
  assert.ok(!events.some((e) => e.kind === "msg"));
  server.push({ type: "message.updated", properties: { sessionID: "ses_fake2", info: { id: "msg_n", sessionID: "ses_fake2", role: "user", time: { created: 9000 } } } });
  server.push({ type: "message.part.updated", properties: { sessionID: "ses_fake2", part: { id: "prt_n", sessionID: "ses_fake2", messageID: "msg_n", type: "text", text: "next" } } });
  server.push({ type: "session.idle", properties: { sessionID: "ses_fake2" } });
  const last = lines(rpc.state.sessionFile).at(-1);
  assert.equal(last.id, "msg_n");
  assert.equal(last.parentId, known.id, "chains onto the known entry, which chains onto the old tail");
  const entriesNow = lines(rpc.state.sessionFile).slice(1);
  assert.ok(latestPlan(entriesNow, entriesNow.at(-1).id), "the old chat's plan is still found");
});

test("server down → streaming false, up → reattach and onRestart", async () => {
  const { server, rpc, events } = setup();
  let restarted = 0;
  rpc.onRestart = async () => { restarted++; assert.equal(rpc.restoring, true, "still restoring while onRestart runs"); };
  rpc.start();
  await rpc.waitReady();
  server.emit("up"); // the server's first connect: nothing to restore
  await tick();
  assert.equal(restarted, 0);
  server.push({ type: "session.status", properties: { sessionID: S, status: { type: "busy" } } });
  assert.equal(rpc.streaming, true);
  events.length = 0;
  server.up = false;
  server.emit("down");
  assert.equal(rpc.streaming, false);
  assert.equal(rpc.restoring, true);
  assert.equal(rpc.crashedSid, "pi:ses_fake1");
  assert.equal(rpc.resumeFile, rpc.state.sessionFile);
  assert.equal(rpc.proc, null, "no chat is routed here while the server is down");
  assert.ok(events.some((e) => e.kind === "status" && e.streaming === false));
  // What happened while the stream was gone is in OpenCode's history: the reattach mirrors it.
  server.history.set(S, [
    { info: { id: "msg_u9", sessionID: S, role: "user", time: { created: 1 } }, parts: [{ id: "prt_u9", type: "text", text: "while down" }] },
    { info: { id: "msg_a9", sessionID: S, role: "assistant", time: { created: 2, completed: 3 }, finish: "stop", modelID: "big-pickle", providerID: "opencode", tokens: {}, cost: 0 }, parts: [{ id: "prt_a9", type: "text", text: "answer" }] },
  ]);
  server.up = true;
  server.emit("up");
  await waitFor(() => restarted === 1, "onRestart");
  await waitFor(() => !rpc.restoring, "restoring cleared");
  assert.ok(rpc.proc);
  assert.equal(rpc.sid, "pi:ses_fake1", "the same OpenCode session");
  const ids = lines(rpc.state.sessionFile).map((e) => e.id);
  assert.ok(ids.includes("msg_u9") && ids.includes("msg_a9"), ids.join(","));
  server.emit("up");
  await tick();
  assert.equal(restarted, 1, "a repeated up is not another restart");
  // A duplicate of an already mirrored message is not written twice.
  server.push({ type: "message.updated", properties: { sessionID: S, info: { id: "msg_a9", sessionID: S, role: "assistant", time: { created: 2, completed: 3 }, finish: "stop", modelID: "big-pickle", providerID: "opencode", tokens: {}, cost: 0 } } });
  assert.equal(lines(rpc.state.sessionFile).filter((e) => e.id === "msg_a9").length, 1);
});

test("proc has no pid; stop aborts a running turn and emits exit", async () => {
  const { server, rpc } = setup();
  rpc.start();
  await rpc.waitReady();
  assert.equal(rpc.proc.pid, null, "a tree-kill must never reach the shared server");
  assert.equal(typeof rpc.proc.kill, "function");
  rpc.proc.kill();
  assert.ok(!server.calls.some((c) => c.path.endsWith("/abort")), "kill() is a no-op");
  server.push({ type: "session.status", properties: { sessionID: S, status: { type: "busy" } } });
  const exits = [];
  rpc.on("exit", (code) => exits.push(code));
  rpc.stop();
  assert.equal(rpc.stopped, true);
  assert.equal(rpc.proc, null);
  rpc.stop();
  assert.equal(exits.length, 1, "exit once");
  await tick();
  assert.equal(posts(server, /\/session\/ses_fake1\/abort$/).length, 1);
  assert.equal(server.listeners_(S), 0);
  assert.equal(server.listenerCount("down") + server.listenerCount("up"), 0);
});

test("watchdog stall aborts only", async () => {
  const { server, rpc, events } = setup();
  rpc.start();
  await rpc.waitReady();
  server.push({ type: "session.status", properties: { sessionID: S, status: { type: "busy" } } });
  rpc.checkStall({ now: rpc.lastEventAt + 10_000, stallMs: 1000 });
  await tick();
  assert.equal(posts(server, /\/abort$/).length, 1);
  assert.ok(rpc.proc, "the chat stays attached");
  assert.ok(events.some((e) => e.kind === "log" && /stalled/.test(e.text)));
  // The idle event never came, but OpenCode says the session is idle: the chat settles.
  await waitFor(() => !rpc.streaming, "settle from the run state");
  assert.ok(events.some((e) => e.kind === "status" && e.streaming === false && e.ts));
});

test("permission backstop answers always", async () => {
  const { server, rpc } = setup();
  rpc.start();
  await rpc.waitReady();
  server.push({ type: "permission.asked", properties: { id: "per_1", sessionID: S, permission: "bash", patterns: ["rm x"], metadata: {}, always: ["rm *"] } });
  await tick();
  const [c] = posts(server, /permission/);
  assert.equal(c.path, "/permission/per_1/reply");
  assert.deepEqual(c.body, { reply: "always" });
});

test("compact summarizes with the chat's model; a prompt waits for it, and compactAt compacts before the next prompt", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { server, rpc } = setup({ compactAt: 1000, reply: (m, p) => (/summarize$/.test(p) ? gate.then(() => true) : undefined) });
  rpc.start();
  await rpc.waitReady();
  const c = rpc.compact();
  const pr = rpc.prompt("after");
  await tick(); await tick();
  assert.equal(posts(server, /prompt_async$/).length, 0, "the prompt waits for the compaction");
  assert.deepEqual(posts(server, /summarize$/)[0].body, { providerID: "opencode", modelID: "big-pickle" });
  release();
  assert.equal((await c).success, true);
  await pr;
  assert.equal(posts(server, /prompt_async$/).length, 1);
  // A settle with 900+200 context tokens > compactAt 1000 → the next prompt compacts first.
  for (const p of planTurn()) server.push(p);
  await rpc.prompt("next");
  const order = server.calls.filter((x) => /summarize$|prompt_async$/.test(x.path)).map((x) => x.path.split("/").pop());
  assert.deepEqual(order, ["summarize", "prompt_async", "summarize", "prompt_async"]);
  await rpc.prompt("again");
  assert.equal(posts(server, /summarize$/).length, 2, "compacted once per overflow");
});

test("thinking levels come from the model's variants", async () => {
  const { rpc } = setup();
  rpc.start();
  await rpc.waitReady();
  await rpc.models();
  assert.deepEqual(rpc.thinkingLevels({ provider: "opencode", id: "big-pickle" }).data.levels, ["off", "low", "medium", "high"]);
  assert.deepEqual(rpc.thinkingLevels({ provider: "opencode", id: "think" }).data.levels, ["high", "max"]);
  assert.deepEqual(rpc.thinkingLevels({ provider: "opencode", id: "plain" }).data, { levels: ["off"], labels: { off: "off" } });
  assert.deepEqual(rpc.thinkingLevels({ provider: "x", id: "y", reasoning: true }).data, { levels: ["off"], labels: { off: "auto" } });
  const models = (await rpc.models()).data.models;
  assert.deepEqual(models.map((m) => m.id), ["big-pickle", "plain", "think"], "connected providers only, no deprecated models");
  assert.deepEqual(models[0], { provider: "opencode", id: "big-pickle", name: "Big Pickle", contextWindow: 200000, maxTokens: 32000, reasoning: true, variants: ["off", "low", "medium", "high"], cost: { input: 0, output: 0 } });
});

test("newSession opens a fresh session and mirror", async () => {
  const { server, rpc } = setup();
  rpc.start();
  await rpc.waitReady();
  for (const p of planTurn()) server.push(p);
  const first = rpc.state.sessionFile;
  await rpc.newSession();
  assert.equal(rpc.sid, "pi:ses_fake2");
  assert.notEqual(rpc.state.sessionFile, first);
  assert.ok(existsSync(first), "a used session is kept");
  assert.equal(lines(rpc.state.sessionFile).length, 1);
});

test("modelThinking: variants as levels, else off (auto for a reasoning model, from capabilities too)", () => {
  assert.deepEqual(modelThinking({ variants: { none: {}, high: {}, low: {} } }), { levels: ["off", "low", "high"], labels: {} });
  assert.deepEqual(modelThinking({ variants: {} }), { levels: ["off"], labels: { off: "off" } });
  assert.deepEqual(modelThinking({ capabilities: { reasoning: true } }), { levels: ["off"], labels: { off: "auto" } });
  assert.deepEqual(modelThinking({ reasoning: true }), { levels: ["off"], labels: { off: "auto" } });
});

test("a catalog model's reasoning flag is read from capabilities (OpenCode's real shape)", async () => {
  const catalog = { all: [{ id: "opencode", models: { r: { id: "r", name: "R", limit: { context: 10, output: 5 }, capabilities: { reasoning: true } } } }], connected: ["opencode"] };
  const { rpc } = setup({ model: "r" });
  rpc.server.catalog = catalog;
  rpc.start();
  await rpc.waitReady();
  assert.equal(rpc.state.model.reasoning, true);
});

test("allowTools: a persona's pi tool names as an OpenCode allowlist (everything else off)", () => {
  assert.deepEqual(allowTools(["read", "grep", "find", "ls", "bash", "plan", "omnidroid_shell"]), { "*": false, read: true, grep: true, glob: true, list: true, bash: true, plan: true, omnidroid_shell: true });
  assert.equal(allowTools([]), null);
  assert.equal(allowTools(null), null);
});

test("runOnce: a throw-away session, one message with system and only the read tool, joined text, session deleted", async () => {
  const server = new FakeServer({ reply: (m, p) => (m === "POST" && /\/message$/.test(p) ? { info: { id: "msg_1", role: "assistant" }, parts: [{ type: "step-start" }, { type: "reasoning", text: "hmm" }, { type: "text", text: "{\"done\": true," }, { type: "text", text: "\"reason\": \"ok\"}" }] } : undefined) });
  const out = await runOnce({ server, provider: "opencode", model: "big-pickle", system: "Judge.", input: "is it done?", cwd: "C:\\w", timeoutMs: 5000 });
  assert.equal(out, "{\"done\": true,\n\"reason\": \"ok\"}");
  const [create, msg, del] = server.calls;
  assert.deepEqual([create.method, create.path, create.directory], ["POST", "/session", "C:\\w"]);
  assert.deepEqual([msg.method, msg.path, msg.timeoutMs], ["POST", "/session/ses_fake1/message", 5000]);
  assert.deepEqual(msg.body, { parts: [{ type: "text", text: "is it done?" }], system: "Judge.", tools: RUN_ONCE_TOOLS, model: { providerID: "opencode", modelID: "big-pickle" } });
  assert.deepEqual(RUN_ONCE_TOOLS, { "*": false, read: true }, "every tool off but read: OpenCode's free tier refuses a request with no tools at all");
  assert.deepEqual([del.method, del.path], ["DELETE", "/session/ses_fake1"]);
});

test("runOnce: a given session is reused and kept; a model error rejects and still deletes a throw-away session", async () => {
  const server = new FakeServer({ reply: (m, p) => (m === "POST" && /\/message$/.test(p) ? { info: { id: "msg_1" }, parts: [{ type: "text", text: "status" }] } : undefined) });
  assert.equal(await runOnce({ server, provider: "", model: "", system: "S", input: "i", cwd: "C:\\w", session: "ses_box" }), "status");
  assert.deepEqual(server.calls.map((c) => `${c.method} ${c.path}`), ["POST /session/ses_box/message"]);
  assert.ok(!("model" in server.calls[0].body), "no model given: none sent");
  const bad = new FakeServer({ reply: (m, p) => (m === "POST" && /\/message$/.test(p) ? { info: { id: "msg_2", error: { name: "APIError", data: { message: "403 FreeTierError" } } }, parts: [] } : undefined) });
  await assert.rejects(runOnce({ server: bad, provider: "opencode", model: "x", system: "S", input: "i", cwd: "C:\\w" }), /403 FreeTierError/);
  assert.equal(bad.calls.at(-1).method, "DELETE");
});

// ---- model errors that come only as session.error, after an earlier error or an outage
const ev = (type, properties) => ({ type, properties: { sessionID: S, ...properties } });
const busyEv = ev("session.status", { status: { type: "busy" } });
const idleEv = ev("session.idle", {});
const asstInfo = (id, extra = {}) => ({ id, sessionID: S, role: "assistant", time: { created: 2000 }, modelID: "big-pickle", providerID: "opencode", ...extra });
const sessErr = (message) => ev("session.error", { error: { name: "UnknownError", data: { message } } });
const errorMsgs = (events) => events.filter((e) => e.kind === "msg" && e.role === "assistant" && e.stopReason === "error");

test("a session.error-only failure after an earlier error turn reaches the bus and the goal hook with its own text", async () => {
  const bus = new Bus();
  const events = [];
  bus.on("event", (e) => events.push(e));
  const server = new FakeServer();
  const mirrorDir = join(mkdtempSync(join(tmpdir(), "omni-ocrpc-")), "opencode");
  const rpc = new OpencodeRpc({ server, cwd: mkdtempSync(join(tmpdir(), "omni-ocrpc-cwd-")), provider: "opencode", model: "big-pickle", bus, mirrorDir });
  const keeper = new GoalKeeper({ bus, getPi: () => rpc, config: { enabled: true }, setTimer: () => 0, clearTimer: () => {} });
  rpc.start();
  await rpc.waitReady();
  keeper.setGoal(rpc.sid, "ship it");
  // Turn 1: the provider refuses with an assistant message (403), then the session.error that repeats it.
  await rpc.prompt("one", { echo: false });
  for (const p of [busyEv, ev("message.updated", { info: asstInfo("msg_x1") }), ev("message.updated", { info: asstInfo("msg_x1", { error: { name: "APIError", data: { statusCode: 403, responseBody: "FreeTierError" } } }) }), sessErr("403"), idleEv]) server.push(p);
  assert.equal(errorMsgs(events).length, 1);
  // Turn 2: prompt_async answers before `busy` (OpencodeRpc counts the run itself); the model id is bad: session.error only.
  await rpc.prompt("two", { echo: false });
  for (const p of [busyEv, sessErr("Model not found: opencode/no-such-model."), idleEv]) server.push(p);
  const errs = errorMsgs(events);
  assert.equal(errs.length, 2, "the second failure is shown too");
  assert.equal(errs[1].blocks[0].text, "Model error: Model not found: opencode/no-such-model.");
  const g = keeper.goal(rpc.sid);
  assert.equal(g.errorStops, 2, "the hook counts both failures (it pauses/escalates instead of retrying a dead model forever)");
  assert.equal(g.lastError, "Model not found: opencode/no-such-model.");
  keeper.stop?.();
  rpc.stop();
});

test("after the server went away mid-turn, a later run's session.error reaches the bus", async () => {
  const { server, rpc, events } = setup();
  rpc.onRestart = async () => {};
  rpc.start();
  await rpc.waitReady();
  await rpc.prompt("work", { echo: false });
  server.push(busyEv);
  server.push(ev("message.updated", { info: asstInfo("msg_y1") })); // left open: the server dies before it ends
  server.up = false;
  server.emit("down");
  server.up = true;
  server.emit("up");
  await waitFor(() => !rpc.restoring, "reattached");
  await rpc.prompt("again", { echo: false });
  for (const p of [busyEv, sessErr("Model not found"), idleEv]) server.push(p);
  const errs = errorMsgs(events);
  assert.equal(errs.length, 1);
  assert.equal(errs[0].blocks[0].text, "Model error: Model not found");
});

test("a message OpenCode is still writing when the stream comes back is picked up and mirrored whole", async () => {
  const { server, rpc, events } = setup();
  rpc.onRestart = async () => {};
  rpc.start();
  await rpc.waitReady();
  await rpc.prompt("work", { echo: false });
  server.push(busyEv);
  server.push(ev("message.updated", { info: asstInfo("msg_z1") }));
  server.up = false;
  server.emit("down");
  // Only the stream was lost: OpenCode kept writing the message meanwhile.
  server.history.set(S, [{ info: asstInfo("msg_z1"), parts: [{ id: "prt_z1", sessionID: S, messageID: "msg_z1", type: "text", text: "written while away" }] }]);
  server.status = { [S]: { type: "busy" } };
  server.up = true;
  events.length = 0;
  server.emit("up");
  await waitFor(() => !rpc.restoring, "reattached");
  assert.equal(rpc.streaming, true);
  server.push(ev("message.updated", { info: asstInfo("msg_z1", { time: { created: 2000, completed: 3000 }, finish: "stop" }) }));
  server.push(idleEv);
  const msg = lines(rpc.state.sessionFile).find((e) => e.id === "msg_z1");
  assert.deepEqual(msg.message.content, [{ type: "text", text: "written while away" }]);
  assert.ok(events.some((e) => e.kind === "msg" && e.role === "assistant" && e.blocks?.[0]?.text === "written while away"));
});

test("stop() after only the event stream dropped still aborts the run OpenCode keeps going", async () => {
  const { server, rpc } = setup();
  rpc.start();
  await rpc.waitReady();
  await rpc.prompt("work", { echo: false });
  server.push(busyEv);
  const exits = [];
  rpc.on("exit", (c) => exits.push(c));
  server.emit("down"); // the SSE stream dropped; the process (and its HTTP API) lives on
  assert.deepEqual(exits, [null]);
  rpc.stop(); // agents.onPiExit
  await tick();
  assert.equal(posts(server, /\/session\/ses_fake1\/abort$/).length, 1, "the run is aborted, not left spending tokens");
});

test("stop() while the server is down aborts the run once it is back", async () => {
  const { server, rpc } = setup();
  rpc.start();
  await rpc.waitReady();
  await rpc.prompt("work", { echo: false });
  server.push(busyEv);
  server.up = false;
  server.emit("down");
  rpc.stop();
  await tick(); await tick();
  assert.equal(server.calls.filter((c) => /\/abort$/.test(c.path)).length, 1, "tried at once (and failed: the server is down)");
  server.up = true;
  server.emit("up");
  await waitFor(() => posts(server, /\/abort$/).length === 2, "the abort retried once up");
  server.emit("up");
  await tick();
  assert.equal(posts(server, /\/abort$/).length, 2, "once");
  assert.equal(server.listenerCount("up"), 0);
});

test("stop() after an outage with no run in progress aborts nothing", async () => {
  const { server, rpc } = setup();
  rpc.start();
  await rpc.waitReady();
  server.emit("down");
  rpc.stop();
  await tick();
  assert.equal(posts(server, /\/abort$/).length, 0);
});
