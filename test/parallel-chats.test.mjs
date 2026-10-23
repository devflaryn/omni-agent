import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/index.mjs";

// One pi child per chat that runs at once: a busy chat never blocks starting or continuing another.
const base = mkdtempSync(join(tmpdir(), "omni-par-"));
for (const d of ["pi-sessions", "claude-projects"]) mkdirSync(join(base, d), { recursive: true });
const made = [];
function createPi({ cwd }) {
  const n = made.length + 1;
  const p = {
    proc: {}, sid: `pi:c${n}-0`, cwd, streaming: false, inFlight: 0, state: { sessionFile: join(base, `c${n}-0.jsonl`) }, calls: [], sessions: 0,
    start() {}, stop() { this.calls.push(["stop"]); this.proc = null; },
    owns(f) { return f === this.state.sessionFile; },
    waitReady() { return Promise.resolve(this.state); },
    async newSession() { this.calls.push(["new"]); this.sid = `pi:c${n}-${++this.sessions}`; this.state.sessionFile = join(base, `c${n}-${this.sessions}.jsonl`); return { success: true }; },
    async switchSession(f) { this.calls.push(["switch", f]); this.state.sessionFile = f; this.sid = `pi:${f.split(/[\\/]/).pop().replace(/\.jsonl$/, "")}`; return { success: true }; },
    // A prompt starts a run that keeps the child busy until the test settles it.
    async prompt(m) { this.calls.push(["prompt", m]); this.streaming = true; return { success: true }; },
    async abort() { this.calls.push(["abort"]); this.streaming = false; return { success: true }; },
  };
  made.push(p);
  return p;
}
const app = await createApp({ relay: { host: "" }, port: 0, vaultDir: join(base, "vault"), piSessionsDir: join(base, "pi-sessions"), claudeProjectsDir: join(base, "claude-projects"), autoStartPi: false, cwd: base, liveWindowMs: 0, createPi, persistHook: false, persistPiModel: false });
await app.listen();
const port = app.server.address().port;
after(() => app.close());
const post = async (path, body) => { const r = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
const childOf = (sid) => app.pis.find((c) => c.sid === sid);

test("a second chat opens in a pi child of its own while the first one works", async () => {
  const a = await post("/api/pi/open", { cwd: base });
  assert.equal(a.status, 200);
  assert.equal((await post("/api/pi/prompt", { sid: a.json.sid, message: "long job A", memory: false })).status, 200);
  assert.equal(childOf(a.json.sid).streaming, true);
  const b = await post("/api/pi/open", { cwd: base });
  assert.equal(b.status, 200);
  assert.notEqual(b.json.sid, a.json.sid);
  assert.notEqual(childOf(b.json.sid), childOf(a.json.sid), "the busy child was not reused");
  assert.equal((await post("/api/pi/prompt", { sid: b.json.sid, message: "job B", memory: false })).status, 200);
  assert.deepEqual(childOf(a.json.sid).calls.filter((c) => c[0] === "prompt").map((c) => c[1]), ["long job A"], "B's message never reached A");
  const st = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
  assert.deepEqual(new Set(st.pis.map((c) => c.sid)), new Set([a.json.sid, b.json.sid]));
});

test("Stop in one chat aborts only that chat's child", async () => {
  const [ca, cb] = made;
  const r = await post("/api/pi/abort", { sid: cb.sid });
  assert.equal(r.status, 200);
  assert.ok(cb.calls.some((c) => c[0] === "abort"));
  assert.ok(!ca.calls.some((c) => c[0] === "abort"), "the other chat keeps working");
  assert.equal(ca.streaming, true);
});

test("continuing an older chat while another works: no 'pi is busy', it gets a child too", async () => {
  const file = join(base, "old-chat.jsonl");
  app.registry.upsert("pi:old-chat", { harness: "pi", file, cwd: base, owned: false, lastActivity: 1 });
  made[1].streaming = true; // both children busy
  const r = await post(`/api/sessions/${encodeURIComponent("pi:old-chat")}/continue`, { message: "go on", memory: false });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.sid, "pi:old-chat");
  const c = childOf("pi:old-chat");
  assert.ok(c && c !== made[0] && c !== made[1], "a third child");
  assert.deepEqual(c.calls.map((x) => x[0]), ["switch", "prompt"]);
});

test("a free child (idle, its claim over) is reused for the next new chat instead of starting another", async () => {
  const c = made[0];
  c.streaming = false;
  c.claimedAt = 0;
  const before = made.length;
  app.pis.forEach((x) => { if (x !== c) x.streaming = true; });
  const r = await post("/api/pi/open", { cwd: base });
  assert.equal(made.length, before, "no new child");
  assert.equal(childOf(r.json.sid), c);
  assert.equal(c.calls.at(-1)[0], "new");
});

test("a message to a chat whose child was closed picks the chat up again", async () => {
  const c = made[2];
  const sid = c.sid;
  assert.equal((await post("/api/pi/stop", { sid })).status, 200);
  assert.equal(childOf(sid), undefined);
  const r = await post("/api/pi/prompt", { sid, message: "still there?", memory: false });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.sid, sid);
  assert.ok(childOf(sid), "the chat has a child again");
});
