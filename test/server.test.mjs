import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync } from "node:fs";
import { buildZip } from "./helpers/zip-fixture.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createApp } from "../server/index.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const base = mkdtempSync(join(tmpdir(), "omni-srv-"));
const piDir = join(base, "pi-sessions", "--C--x--");
const claudeDir = join(base, "claude-projects", "C--Users-berat-Desktop-proj");
mkdirSync(piDir, { recursive: true });
mkdirSync(claudeDir, { recursive: true });
const piFile = join(piDir, "2026-09-09T14-51-12-099Z_01a086a6-c763-777d-8188-9a868c6a2266.jsonl");
writeFileSync(piFile, [
  JSON.stringify({ type: "session", version: 3, id: "01a086a6-c763-777d-8188-9a868c6a2266", timestamp: "2026-09-09T14:51:12.099Z", cwd: "C:\\x\\rebuild" }),
  JSON.stringify({ type: "message", id: "a", parentId: null, timestamp: "2026-09-09T14:51:23.675Z", message: { role: "user", content: [{ type: "text", text: "Convert the APK into a source project" }], timestamp: 1 } }),
  JSON.stringify({ type: "message", id: "b", parentId: "a", timestamp: "2026-09-09T14:51:27.453Z", message: { role: "assistant", content: [{ type: "text", text: "Starting." }, { type: "toolCall", id: "c1", name: "ls", arguments: {} }], model: "Qwen", usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120, cost: { total: 0 } }, stopReason: "toolUse" } }),
  "",
].join("\n"));
const claudeFile = join(claudeDir, "eb130a94-0000-4000-8000-000000000000.jsonl");
writeFileSync(claudeFile, [
  JSON.stringify({ type: "user", uuid: "u1", timestamp: "2026-09-09T15:46:01.579Z", cwd: "C:\\Users\\berat\\Desktop\\proj", message: { role: "user", content: "build omni agent" } }),
  JSON.stringify({ type: "assistant", uuid: "a1", timestamp: "2026-09-09T15:48:25.620Z", message: { id: "msg_1", model: "claude-fable-5-1", role: "assistant", content: [{ type: "text", text: "On it." }], usage: { input_tokens: 2, cache_creation_input_tokens: 18, cache_read_input_tokens: 31, output_tokens: 4 } } }),
  JSON.stringify({ type: "ai-title", aiTitle: "Omni Agent build", sessionId: "eb130a94-0000-4000-8000-000000000000" }),
  "",
].join("\n"));

const claudeCalls = [];
const fakeSpawn = (bin, args, opts) => {
  const p = new EventEmitter();
  p.stdout = new PassThrough(); p.stderr = new PassThrough(); p.stdin = new PassThrough();
  p.pid = 7; p.kill = () => p.emit("exit", 0);
  claudeCalls.push({ bin, args, opts, proc: p });
  return p;
};
// liveWindowMs: 0 — the fixture files were written a moment ago and would otherwise count as "open in a terminal".
// `hook` is pinned so the developer's own omni.config.json (where the goal hook may be on) never leaks into the assertions.
const app = await createApp({ port: 0, vaultDir: join(base, "vault"), piSessionsDir: join(base, "pi-sessions"), claudeProjectsDir: join(base, "claude-projects"), autoStartPi: false, cwd: base, claudeSpawn: fakeSpawn, liveWindowMs: 0, persistHook: false, persistPiModel: false, hook: { enabled: false } });
await app.listen();
const port = app.server.address().port;
const api = async (path, opts) => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, opts);
  return r.json();
};
after(() => app.close());

test("state lists discovered sessions from both harnesses with titles, cwd, model", async () => {
  const s = await api("/api/state");
  const pi = s.sessions.find((x) => x.sid === "pi:01a086a6-c763-777d-8188-9a868c6a2266");
  const cl = s.sessions.find((x) => x.sid === "claude:eb130a94-0000-4000-8000-000000000000");
  assert.ok(pi, "pi session discovered");
  assert.equal(pi.cwd, "C:\\x\\rebuild");
  assert.match(pi.title, /Convert the APK/);
  assert.ok(cl, "claude session discovered");
  assert.equal(cl.title, "Omni Agent build");
  assert.equal(s.pi.running, false);
});

test("history normalizes the whole file and tallies tokens", async () => {
  const h = await api(`/api/sessions/${encodeURIComponent("pi:01a086a6-c763-777d-8188-9a868c6a2266")}/history`);
  assert.deepEqual(h.events.map((e) => e.kind), ["session", "msg", "msg"]);
  assert.equal(h.tally.input, 100);
  const hc = await api(`/api/sessions/${encodeURIComponent("claude:eb130a94-0000-4000-8000-000000000000")}/history`);
  assert.equal(hc.tally.cacheRead, 31);
  assert.ok(hc.tally.cost > 0, "claude cost estimated from the price table");
});

test("appended lines are tailed and broadcast over SSE (observed session => whole message, live:false)", async () => {
  const got = [];
  const ac = new AbortController();
  const res = await fetch(`http://127.0.0.1:${port}/events`, { signal: ac.signal });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const chunk of dec.decode(value).split("\n\n")) if (chunk.startsWith("data: ")) got.push(JSON.parse(chunk.slice(6)));
      }
    } catch { /* aborted */ }
  })();
  await sleep(100);
  appendFileSync(piFile, `${JSON.stringify({ type: "message", id: "c", parentId: "b", timestamp: "2026-09-09T14:51:28.000Z", message: { role: "toolResult", toolCallId: "c1", toolName: "ls", content: [{ type: "text", text: "a.apk" }], isError: false } })}\n`);
  await sleep(1500);
  ac.abort();
  const ev = got.find((e) => e.kind === "msg" && e.role === "tool");
  assert.ok(ev, `tool result broadcast; got ${JSON.stringify(got.map((g) => g.kind))}`);
  assert.equal(ev.live, false);
  assert.equal(ev.blocks[0].text, "a.apk");
});

test("memory routes: save, search, pack, note read, digest", async () => {
  const saved = await api("/api/memory/save", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "pi crash fix", description: "MouseRegion undefined child guard", type: "project", body: "Guarded renderer return in tool-execution." }) });
  assert.equal(saved.path, "Memory/pi-crash-fix.md");
  const s = await api("/api/memory/search?q=mouseregion");
  assert.equal(s.hits[0].path, "Memory/pi-crash-fix.md");
  const pk = await api("/api/memory/pack?q=crash+guard&budget=300");
  assert.match(pk.pack, /pi-crash-fix/);
  const n = await api("/api/memory/note?path=Memory/pi-crash-fix.md");
  assert.equal(n.frontmatter.type, "project");
  const d = await api("/api/memory/digest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sid: "pi:01a086a6-c763-777d-8188-9a868c6a2266" }) });
  assert.match(d.path, /^Sessions\/pi\//);
});

test("file browser is rooted", async () => {
  const l = await api(`/api/fs/list?root=${encodeURIComponent(base)}&path=`);
  assert.ok(l.entries.some((e) => e.name === "vault"));
  const bad = await api(`/api/fs/list?root=${encodeURIComponent(base)}&path=..`);
  assert.ok(bad.error);
});

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

test("continue: memory pack is composed before graph context, unchanged from pre-refactor ordering", async () => {
  const r = await post(`/api/sessions/${encodeURIComponent("claude:eb130a94-0000-4000-8000-000000000000")}/continue`, { message: "crash guard again", memory: true, graph: false });
  assert.ok(r.sid);
  const a = claudeCalls.at(-1).args;
  const i = a.indexOf("--append-system-prompt");
  assert.ok(i !== -1, "--append-system-prompt present");
  assert.match(a[i + 1], /Relevant durable memory from the user's Omni vault/);
  assert.match(a[i + 1], /pi-crash-fix/);
  claudeCalls.at(-1).proc.emit("exit", 0);
});

test("static route serves ES modules from ui/", async () => {
  const r = await fetch(`http://127.0.0.1:${port}/lib.js`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /javascript/);
});

test("cross-site POSTs are refused, same-origin/absent header POSTs are not", async () => {
  const cross = await fetch(`http://127.0.0.1:${port}/api/memory/reindex`, { method: "POST", headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" }, body: "{}" });
  assert.equal(cross.status, 403);
  const plain = await fetch(`http://127.0.0.1:${port}/api/memory/reindex`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(plain.status, 200);
});

// -------------------------------------------------------- stubbed-pi continue
let fakePi = null;
function makeFakePi({ cwd, model, provider, thinking }) {
  fakePi = {
    proc: {}, sid: "pi:fake", cwd, model, provider, thinking, streaming: false, state: { sessionFile: "C:\\fake.jsonl" }, calls: [], failClone: false,
    start() {}, stop() {}, owns() { return false; },
    waitReady() { return Promise.resolve(this.state); },
    async switchSession(f) { this.calls.push(["switch", f]); this.sid = "pi:01a086a6-c763-777d-8188-9a868c6a2266"; },
    async clone() { this.calls.push(["clone"]); if (this.failClone) throw new Error("clone was cancelled"); this.sid = "pi:cloned"; },
    async prompt(m) { this.calls.push(["prompt", m]); return { ok: true }; },
    async setModel(p, id) { this.calls.push(["model", p, id]); return { success: true }; },
    async setThinking(l) { this.calls.push(["thinking", l]); return { success: true }; },
  };
  return fakePi;
}
const app2 = await createApp({ port: 0, vaultDir: join(base, "vault2"), piSessionsDir: join(base, "pi-sessions"), claudeProjectsDir: join(base, "claude-projects"), autoStartPi: false, cwd: base, claudeSpawn: fakeSpawn, liveWindowMs: 0, createPi: makeFakePi, piModelsFile: join(base, "pi-agent", "models.json"), persistHook: false, persistPiModel: false });
await app2.listen();
const port2 = app2.server.address().port;
after(() => app2.close());
const post2 = async (path, body) => { const r = await fetch(`http://127.0.0.1:${port2}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => ({})) }; };

test("continue on a closed pi session (stubbed pi): switches and prompts, no clone", async () => {
  const r = await post2(`/api/sessions/${encodeURIComponent("pi:01a086a6-c763-777d-8188-9a868c6a2266")}/continue`, { message: "hi", memory: false });
  assert.equal(r.status, 200);
  assert.equal(r.json.sid, "pi:01a086a6-c763-777d-8188-9a868c6a2266");
  assert.equal(r.json.forked, false);
  assert.equal(fakePi.calls.length, 2);
  assert.equal(fakePi.calls[0][0], "switch");
  assert.equal(fakePi.calls[0][1], piFile);
  assert.deepEqual(fakePi.calls[1], ["prompt", "hi"]);
});

test("continue with fork:true (stubbed pi): clones and forks", async () => {
  fakePi.calls.length = 0;
  const r = await post2(`/api/sessions/${encodeURIComponent("pi:01a086a6-c763-777d-8188-9a868c6a2266")}/continue`, { message: "branch", memory: false, fork: true });
  assert.equal(r.status, 200);
  assert.equal(r.json.forked, true);
  assert.equal(r.json.sid, "pi:cloned");
  assert.equal(r.json.forkedFrom, "pi:01a086a6-c763-777d-8188-9a868c6a2266");
  assert.ok(fakePi.calls.some((c) => c[0] === "clone"));
});

test("continue with fork:true and a cancelled clone (stubbed pi): 409, no prompt", async () => {
  fakePi.calls.length = 0;
  fakePi.failClone = true;
  const r = await post2(`/api/sessions/${encodeURIComponent("pi:01a086a6-c763-777d-8188-9a868c6a2266")}/continue`, { message: "branch again", memory: false, fork: true });
  assert.equal(r.status, 409);
  assert.ok(!fakePi.calls.some((c) => c[0] === "prompt"), "prompt must not be called after a cancelled clone");
});

// ------------------------------------------------------------ claude task (pi → Claude delegation)
test("claude task: runs Claude Code, waits for the result, returns the final text and session id", async () => {
  const pending = post("/api/claude/task", { prompt: "count the files", cwd: "C:\p", memory: false, title: "Task from pi: count the files" });
  await sleep(120);
  const call = claudeCalls.at(-1);
  assert.ok(call.args.includes("--session-id"), "a fresh task gets its own session id");
  const sessionId = call.args[call.args.indexOf("--session-id") + 1];
  call.proc.stdout.write(`${JSON.stringify({ type: "system", subtype: "init", session_id: sessionId, cwd: "C:\p", model: "m" })}\n`);
  call.proc.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "There are 3 files.", total_cost_usd: 0.01, num_turns: 2, duration_ms: 500, session_id: sessionId })}\n`);
  call.proc.emit("exit", 0);
  const r = await pending;
  assert.equal(r.sid, `claude:${sessionId}`);
  assert.equal(r.sessionId, sessionId);
  assert.equal(r.text, "There are 3 files.");
  assert.equal(r.isError, false);
  assert.equal(r.turns, 2);
  assert.equal(r.timedOut, false);
  const st = await api("/api/state");
  assert.equal(st.sessions.find((s) => s.sid === r.sid)?.title, "Task from pi: count the files");
});

test("claude task: times out with whatever it has and reports timedOut", async () => {
  const pending = post("/api/claude/task", { prompt: "slow task", cwd: "C:\p", memory: false, timeoutSec: 0.3 });
  await sleep(50);
  const call = claudeCalls.at(-1);
  const r = await pending;
  assert.equal(r.timedOut, true);
  assert.equal(r.text, "");
  call.proc.emit("exit", 0);
});

test("claude task: empty prompt → 400", async () => {
  const r = await fetch(`http://127.0.0.1:${port}/api/claude/task`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: " " }) });
  assert.equal(r.status, 400);
});

// ------------------------------------------------------------ providers
test("providers: empty at first, PUT validates, writes models.json and restarts pi back onto its session", async () => {
  const empty = await (await fetch(`http://127.0.0.1:${port2}/api/providers`)).json();
  assert.deepEqual(empty.providers, []);
  assert.ok(empty.presets.some((p) => p.key === "openrouter"));
  const bad = await fetch(`http://127.0.0.1:${port2}/api/providers/openrouter`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ baseUrl: "nope", api: "openai-completions", models: ["a"] }) });
  assert.equal(bad.status, 400);
  // start the fake pi so the restart path is exercised
  app2.startPi(base);
  const before = fakePi;
  const put = await fetch(`http://127.0.0.1:${port2}/api/providers/openrouter`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ baseUrl: "https://openrouter.ai/api/v1", api: "openai-completions", apiKey: "sk-or-abcd1234", models: ["deepseek/deepseek-v4-flash-0731", { id: "moonshotai/kimi-k2.5", name: "Kimi" }] }) });
  const pj = await put.json();
  assert.equal(put.status, 200);
  assert.equal(pj.restarted, true);
  assert.notEqual(fakePi, before, "a new pi child was created");
  assert.deepEqual(fakePi.calls[0], ["switch", "C:\\fake.jsonl"]);
  assert.equal(pj.providers[0].name, "openrouter");
  assert.equal(pj.providers[0].hasKey, true); assert.equal(pj.providers[0].keyHint, "1234"); assert.equal("apiKey" in pj.providers[0], false);
  const onDisk = JSON.parse(readFileSync(join(base, "pi-agent", "models.json"), "utf8"));
  assert.equal(onDisk.providers.openrouter.apiKey, "sk-or-abcd1234");
  assert.equal(onDisk.providers.openrouter.models[1].name, "Kimi");
});

test("pi models: the picker lists only the models from models.json once providers exist", async () => {
  const r = await (await fetch(`http://127.0.0.1:${port2}/api/pi/models`)).json();
  assert.equal(r.data.source, "providers");
  assert.deepEqual(r.data.models.map((m) => `${m.provider}/${m.id}`), ["openrouter/deepseek/deepseek-v4-flash-0731", "openrouter/moonshotai/kimi-k2.5"]);
});

test("providers-order: POST rewrites the provider order in models.json without restarting pi", async () => {
  await fetch(`http://127.0.0.1:${port2}/api/providers/modal`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ baseUrl: "https://modal.example/v1", api: "openai-completions", apiKey: "k", models: ["Qwen/Qwen3.8-27B"] }) });
  const before = fakePi;
  const bad = await fetch(`http://127.0.0.1:${port2}/api/providers-order`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ order: "modal" }) });
  assert.equal(bad.status, 400);
  const r = await fetch(`http://127.0.0.1:${port2}/api/providers-order`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ order: ["modal", "openrouter"] }) });
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.deepEqual(j.order, ["modal", "openrouter"]);
  assert.deepEqual(j.providers.map((p) => p.name), ["modal", "openrouter"]);
  assert.equal(fakePi, before, "reordering does not relaunch pi");
  const onDisk = JSON.parse(readFileSync(join(base, "pi-agent", "models.json"), "utf8"));
  assert.deepEqual(Object.keys(onDisk.providers), ["modal", "openrouter"]);
  const models = await (await fetch(`http://127.0.0.1:${port2}/api/pi/models`)).json();
  assert.equal(models.data.models[0].provider, "modal", "the picker follows the new order");
  await fetch(`http://127.0.0.1:${port2}/api/providers/modal`, { method: "DELETE" });
});

test("providers: DELETE removes the entry; unknown → 404", async () => {
  const del = await fetch(`http://127.0.0.1:${port2}/api/providers/openrouter`, { method: "DELETE" });
  assert.equal(del.status, 200);
  assert.deepEqual((await del.json()).providers, []);
  assert.equal((await fetch(`http://127.0.0.1:${port2}/api/providers/openrouter`, { method: "DELETE" })).status, 404);
});

// ---------------------------------------------------------- file previews
test("fs/read reports a kind per file family: markdown, text, image, archive, binary", async () => {
  const dir = join(base, "proj"); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "README.md"), "# Title\n\nhello");
  writeFileSync(join(dir, "main.py"), "print(1)\n");
  writeFileSync(join(dir, "pic.png"), Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"));
  writeFileSync(join(dir, "blob.bin"), Buffer.from([0, 1, 2, 3]));
  writeFileSync(join(dir, "app.apk"), buildZip([{ name: "AndroidManifest.xml", data: "<manifest/>" }, { name: "lib/", data: "" }, { name: "assets/notes.md", data: "# inside\n".repeat(30), deflate: true }, { name: "classes.dex", data: "\u0000dex\n035" }]));
  const read = async (p) => (await fetch(`http://127.0.0.1:${port}/api/fs/read?root=${encodeURIComponent(dir)}&path=${encodeURIComponent(p)}`)).json();
  const md = await read("README.md"); assert.equal(md.kind, "markdown"); assert.match(md.content, /# Title/);
  const py = await read("main.py"); assert.equal(py.kind, "text"); assert.equal(py.content, "print(1)\n");
  const png = await read("pic.png"); assert.equal(png.kind, "image"); assert.equal(png.mime, "image/png"); assert.equal(png.size, 16);
  const bin = await read("blob.bin"); assert.equal(bin.kind, "binary");
  const apk = await read("app.apk"); assert.equal(apk.kind, "archive");
  assert.deepEqual(apk.entries.map((e) => e.path), ["AndroidManifest.xml", "lib/", "assets/notes.md", "classes.dex"]);
  assert.equal(apk.entries[1].dir, true); assert.equal(apk.entries[2].size, 270); assert.equal("offset" in apk.entries[0], false);
  const raw = await fetch(`http://127.0.0.1:${port}/api/fs/raw?root=${encodeURIComponent(dir)}&path=pic.png`);
  assert.equal(raw.headers.get("content-type"), "image/png"); assert.equal((await raw.arrayBuffer()).byteLength, 16);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/fs/raw?root=${encodeURIComponent(dir)}&path=main.py`)).status, 404);
  const entry = async (e) => (await fetch(`http://127.0.0.1:${port}/api/fs/archive-entry?root=${encodeURIComponent(dir)}&path=app.apk&entry=${encodeURIComponent(e)}`)).json();
  const notes = await entry("assets/notes.md"); assert.equal(notes.kind, "markdown"); assert.equal(notes.content, "# inside\n".repeat(30));
  const man = await entry("AndroidManifest.xml"); assert.equal(man.kind, "text"); assert.equal(man.content, "<manifest/>");
  assert.equal((await entry("classes.dex")).kind, "binary");
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/fs/archive-entry?root=${encodeURIComponent(dir)}&path=app.apk&entry=missing`)).status, 404);
});

test("goal hook settings: /api/hook reads, validates and updates the keeper", async () => {
  const before = await api("/api/hook");
  assert.deepEqual(before.hook, { enabled: false, provider: "", model: "", maxIdleNudges: 5, graceMs: 2000 });
  const st = await api("/api/state");
  assert.deepEqual(st.hook, before.hook, "state carries the same settings");
  const r = await fetch(`http://127.0.0.1:${port}/api/hook`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true, provider: "openrouter", model: "deepseek/x", maxIdleNudges: 999 }) });
  const j = await r.json();
  assert.equal(j.hook.enabled, true);
  assert.equal(j.hook.model, "deepseek/x");
  assert.equal(j.hook.maxIdleNudges, 50, "clamped");
  assert.equal(app.keeper.config.enabled, true);
  const back = await fetch(`http://127.0.0.1:${port}/api/hook`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: false }) });
  assert.equal((await back.json()).hook.model, "deepseek/x", "a partial update keeps the other fields");
  assert.equal(app.keeper.config.enabled, false);
});

test("model and thinking choices made before pi runs are remembered and handed to the next pi child", async () => {
  // `app` has no pi child at all
  const m = await fetch(`http://127.0.0.1:${port}/api/pi/model`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "openrouter", modelId: "deepseek/x" }) });
  const mj = await m.json();
  assert.equal(m.status, 200);
  assert.equal(mj.pending, true);
  assert.equal(mj.modelId, "deepseek/x");
  const t = await fetch(`http://127.0.0.1:${port}/api/pi/thinking`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ level: "low" }) });
  assert.equal((await t.json()).pending, true);
  const bad = await fetch(`http://127.0.0.1:${port}/api/pi/thinking`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ level: "turbo" }) });
  assert.equal(bad.status, 400);
  const st = await api("/api/state");
  assert.equal(st.pi.running, false);
  assert.deepEqual([st.config.piProvider, st.config.piModel, st.config.piThinking], ["openrouter", "deepseek/x", "low"]);
  // the stubbed-pi app: a live child gets the change at once, and the next child is created with the saved choices
  fakePi.calls.length = 0;
  const r = await post2("/api/pi/model", { provider: "orca", modelId: "qwen" });
  assert.equal(r.json.pending, undefined, "a live child applies the model immediately");
  await post2("/api/pi/thinking", { level: "high" });
  assert.deepEqual(fakePi.calls, [["model", "orca", "qwen"], ["thinking", "high"]]);
  await post2("/api/pi/start", { cwd: base });
  assert.deepEqual([fakePi.model, fakePi.provider, fakePi.thinking], ["qwen", "orca", "high"]);
});
