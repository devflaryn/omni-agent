import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync } from "node:fs";
import { buildZip } from "./helpers/zip-fixture.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createApp } from "../server/index.mjs";
import { sidForFile } from "../server/watchers.mjs";
import { FakeServer } from "./helpers/fake-opencode.mjs";

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
const app = await createApp({ port: 0, relay: { host: "" }, sseKeepAliveMs: 100, vaultDir: join(base, "vault"), piSessionsDir: join(base, "pi-sessions"), claudeProjectsDir: join(base, "claude-projects"), autoStartPi: false, cwd: base, claudeSpawn: fakeSpawn, liveWindowMs: 0, persistHook: false, persistPiModel: false, hook: { enabled: false } });
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

/** The raw text of an event stream until `until` matches or ms pass. */
async function streamText(path, until, ms = 2000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  let text = "";
  try {
    const reader = (await fetch(`http://127.0.0.1:${port}${path}`, { signal: ac.signal })).body.getReader();
    const dec = new TextDecoder();
    while (!until.test(text)) { const { value, done } = await reader.read(); if (done) break; text += dec.decode(value); }
  } catch { /* aborted */ }
  clearTimeout(timer);
  ac.abort();
  return text;
}

test("the stream's keepalive is an event a page can see, so it can tell a silently dead stream from a quiet one", async () => {
  // An SSE comment (": ka") never reaches page code: a stream cut without a FIN (a phone changing networks, a NAT
  // forgetting it, the relay's far side gone) looked exactly like a quiet one, forever.
  const text = await streamText(`/events?since=${app.bus.seq}`, /event: ka\ndata: \S/);
  assert.match(text, /event: ka\ndata: \S/);
});

test("a page that goes away leaves no stream behind on the server", async () => {
  const before = app.bus.clients.size;
  await streamText(`/events?since=${app.bus.seq}`, /: omni/);
  for (let i = 0; i < 50 && app.bus.clients.size > before; i++) await sleep(10);
  assert.equal(app.bus.clients.size, before);
});

test("a page reconnecting to a restarted server is told to resync; /api/state names the server run", async () => {
  const st = await api("/api/state");
  assert.equal(st.boot, app.bus.boot);
  const text = await streamText(`/events?since=${st.seq || 1}&boot=an-earlier-run`, /event: resync/);
  assert.match(text, /event: resync\ndata: \{"boot":"[0-9a-f]+"/);
  const same = await streamText(`/events?since=${st.seq}&boot=${st.boot}`, /event: ka/);
  assert.ok(!same.includes("event: resync"), "the same run catches up from its seq");
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
const oc2 = new FakeServer();
const app2 = await createApp({ relay: { host: "" }, port: 0, vaultDir: join(base, "vault2"), piSessionsDir: join(base, "pi-sessions"), claudeProjectsDir: join(base, "claude-projects"), autoStartPi: false, cwd: base, claudeSpawn: fakeSpawn, liveWindowMs: 0, createPi: makeFakePi, piModelsFile: join(base, "pi-agent", "models.json"), piExtConfigFile: join(base, "pi-agent", "omni-agent.json"), persistHook: false, persistPiModel: false, opencodeServer: oc2, opencodeConfigDir: join(base, "oc2-config"), opencodeProvidersFile: join(base, "omni", "opencode-providers.json") });
const disposes = () => oc2.calls.filter((c) => c.method === "POST" && c.path === "/global/dispose").length;
const app2Logs = [];
app2.bus.on("event", (ev) => { if (ev.kind === "log") app2Logs.push(ev); });
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
const ocProvidersFile = join(base, "omni", "opencode-providers.json");
test("providers: OpenCode's first start copies pi's models.json providers once (one OpenCode already has only gets the models it lacks, logged)", async () => {
  mkdirSync(join(base, "pi-agent"), { recursive: true });
  writeFileSync(join(base, "pi-agent", "models.json"), JSON.stringify({ providers: {
    legacy: { baseUrl: "https://legacy.example/v1", api: "openai-completions", apiKey: "sk-legacy-5678", models: [{ id: "l/one", name: "L One", contextWindow: 64000, maxTokens: 8000, reasoning: false }] },
    opencode: { baseUrl: "https://opencode.ai/inference/openai/v1", api: "openai-completions", apiKey: "zen", models: [{ id: "big-pickle" }, { id: "zen-extra" }] },
  } }));
  const disposed = disposes();
  const j = await (await fetch(`http://127.0.0.1:${port2}/api/providers`)).json();
  assert.deepEqual(j.providers.map((p) => [p.name, !!p.builtIn]), [["legacy", false], ["opencode", true]], "copied into Omni's own store");
  assert.equal(j.file, ocProvidersFile);
  assert.deepEqual(j.opencode, [{ id: "opencode", name: "OpenCode Zen" }], "OpenCode's own connected providers are listed apart (their key stays editable)");
  const conf = JSON.parse(readFileSync(join(base, "oc2-config", "opencode.json"), "utf8"));
  assert.deepEqual(conf.provider.legacy, { npm: "@ai-sdk/openai-compatible", name: "legacy", options: { baseURL: "https://legacy.example/v1", apiKey: "sk-legacy-5678" }, models: { "l/one": { name: "L One", limit: { context: 64000, output: 8000 } } } });
  assert.deepEqual(conf.provider.opencode, { models: { "zen-extra": { name: "zen-extra", limit: { context: 128000, output: 16384 } } } }, "OpenCode's own provider only gains the model it lacked: no npm, options or key");
  assert.equal(disposes(), disposed + 1, "OpenCode re-reads its config with the copied providers");
  const line = app2Logs.find((e) => /zen-extra/.test(e.text));
  assert.ok(line, `the added model is logged: ${JSON.stringify(app2Logs.map((e) => e.text))}`);
  assert.match(line.text, /OpenCode's opencode/);
  assert.ok(!app2Logs.some((e) => /big-pickle/.test(e.text)), "a model OpenCode lists is left alone");
  assert.ok(existsSync(join(base, "omni", "opencode-providers.migrated.json")), "the marker sits next to the store");
  // a key for that provider still goes to OpenCode's auth store (it is not one of Omni's custom providers)
  const k = await fetch(`http://127.0.0.1:${port2}/api/provider-keys/opencode`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: "zen-key" }) });
  assert.equal(k.status, 200);
  assert.ok(oc2.calls.some((c) => c.method === "PUT" && c.path === "/auth/opencode"));
  // once: the marker stops a second copy
  await fetch(`http://127.0.0.1:${port2}/api/providers/legacy`, { method: "DELETE" });
  await fetch(`http://127.0.0.1:${port2}/api/providers/opencode`, { method: "DELETE" });
  assert.deepEqual((await (await fetch(`http://127.0.0.1:${port2}/api/providers`)).json()).providers, []);
});

test("providers: empty at first, PUT validates, writes Omni's provider store and opencode.json, and reloads opencode (the chats keep their sessions)", async () => {
  const empty = await (await fetch(`http://127.0.0.1:${port2}/api/providers`)).json();
  assert.deepEqual(empty.providers, []);
  assert.ok(empty.presets.some((p) => p.key === "openrouter" && p.kind === "key"));
  const bad = await fetch(`http://127.0.0.1:${port2}/api/providers/openrouter`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ baseUrl: "nope", api: "openai-completions", models: ["a"] }) });
  assert.equal(bad.status, 400);
  // a name OpenCode already has (here its own anthropic) would override that provider: refused
  const clash = await fetch(`http://127.0.0.1:${port2}/api/providers/anthropic`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ baseUrl: "https://x.example/v1", models: ["a"] }) });
  assert.equal(clash.status, 409);
  assert.match((await clash.json()).error, /OpenCode already has a provider named "anthropic"/);
  // extra models for OpenCode's own provider are fine (no URL or key: OpenCode's definition stays)
  const extra = await fetch(`http://127.0.0.1:${port2}/api/providers/anthropic`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ builtIn: true, models: ["claude-x-preview"] }) });
  assert.equal(extra.status, 200);
  assert.deepEqual(JSON.parse(readFileSync(join(base, "oc2-config", "opencode.json"), "utf8")).provider.anthropic, { models: { "claude-x-preview": { name: "claude-x-preview", limit: { context: 128000, output: 16384 } } } });
  const unknown = await fetch(`http://127.0.0.1:${port2}/api/providers/nope-provider`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ builtIn: true, models: ["m"] }) });
  assert.equal(unknown.status, 400, "extra models only for a provider OpenCode has");
  await fetch(`http://127.0.0.1:${port2}/api/providers/anthropic`, { method: "DELETE" });
  app2.startPi(base);
  const before = fakePi;
  const disposed = disposes();
  const put = await fetch(`http://127.0.0.1:${port2}/api/providers/openrouter`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ baseUrl: "https://openrouter.ai/api/v1", api: "openai-completions", apiKey: "sk-or-abcd1234", models: ["deepseek/deepseek-v4-flash-0731", { id: "moonshotai/kimi-k2.5", name: "Kimi" }] }) });
  const pj = await put.json();
  assert.equal(put.status, 200);
  assert.equal(pj.restarted, true);
  assert.equal(disposes(), disposed + 1, "opencode re-reads its config");
  assert.equal(fakePi, before, "no chat is relaunched");
  assert.equal(pj.providers[0].name, "openrouter");
  assert.equal(pj.providers[0].hasKey, true); assert.equal(pj.providers[0].keyHint, "1234"); assert.equal("apiKey" in pj.providers[0], false);
  const onDisk = JSON.parse(readFileSync(ocProvidersFile, "utf8"));
  assert.equal(onDisk.providers.openrouter.apiKey, "sk-or-abcd1234");
  assert.equal(onDisk.providers.openrouter.models[1].name, "Kimi");
  const conf = JSON.parse(readFileSync(join(base, "oc2-config", "opencode.json"), "utf8"));
  assert.deepEqual(conf.provider.openrouter.options, { baseURL: "https://openrouter.ai/api/v1", apiKey: "sk-or-abcd1234" });
  assert.deepEqual(Object.keys(conf.provider.openrouter.models), ["deepseek/deepseek-v4-flash-0731", "moonshotai/kimi-k2.5"]);
  assert.equal(JSON.parse(readFileSync(join(base, "pi-agent", "models.json"), "utf8")).providers.openrouter, undefined, "pi's models.json is not written");
});

test("providers: a key for one of OpenCode's own providers goes to PUT /auth; DELETE removes it; both reload OpenCode", async () => {
  const key = (id, method, body) => fetch(`http://127.0.0.1:${port2}/api/provider-keys/${id}`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const before = oc2.calls.length;
  const disposed = disposes();
  const r = await key("anthropic", "PUT", { key: " sk-ant-0001 " });
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
  assert.equal((await r.json()).restarted, true);
  const put = oc2.calls.slice(before).find((c) => c.path === "/auth/anthropic");
  assert.deepEqual([put.method, put.body], ["PUT", { type: "api", key: "sk-ant-0001" }]);
  assert.equal(disposes(), disposed + 1);
  assert.equal((await key("anthropic", "PUT", { key: "  " })).status, 400, "an empty key is refused");
  assert.equal((await key("no-such-provider", "PUT", { key: "k" })).status, 400, "only a provider OpenCode has");
  assert.equal((await key("openrouter", "PUT", { key: "k" })).status, 409, "one of Omni's custom providers keeps its key in its own form");
  const del = await key("anthropic", "DELETE");
  assert.equal(del.status, 200);
  assert.ok(oc2.calls.slice(before).some((c) => c.method === "DELETE" && c.path === "/auth/anthropic"));
  assert.equal(disposes(), disposed + 2);
});

test("pi models: the picker lists OpenCode's connected catalog, not models.json", async () => {
  const r = await (await fetch(`http://127.0.0.1:${port2}/api/pi/models`)).json();
  assert.deepEqual(r.data.models.map((m) => `${m.provider}/${m.id}`), ["opencode/big-pickle", "opencode/plain", "opencode/think"]);
});

test("providers-order: POST rewrites the provider order in Omni's store without reloading OpenCode", async () => {
  await fetch(`http://127.0.0.1:${port2}/api/providers/modal`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ baseUrl: "https://modal.example/v1", api: "openai-completions", apiKey: "k", models: ["Qwen/Qwen3.8-27B"] }) });
  const before = fakePi;
  const disposed = disposes();
  const bad = await fetch(`http://127.0.0.1:${port2}/api/providers-order`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ order: "modal" }) });
  assert.equal(bad.status, 400);
  const r = await fetch(`http://127.0.0.1:${port2}/api/providers-order`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ order: ["modal", "openrouter"] }) });
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.deepEqual(j.order, ["modal", "openrouter"]);
  assert.deepEqual(j.providers.map((p) => p.name), ["modal", "openrouter"]);
  assert.equal(fakePi, before, "reordering does not relaunch pi");
  assert.equal(disposes(), disposed, "nor reload opencode");
  const onDisk = JSON.parse(readFileSync(ocProvidersFile, "utf8"));
  assert.deepEqual(Object.keys(onDisk.providers), ["modal", "openrouter"]);
  await fetch(`http://127.0.0.1:${port2}/api/providers/modal`, { method: "DELETE" });
});

test("providers: DELETE removes the entry; unknown → 404", async () => {
  const del = await fetch(`http://127.0.0.1:${port2}/api/providers/openrouter`, { method: "DELETE" });
  assert.equal(del.status, 200);
  assert.deepEqual((await del.json()).providers, []);
  assert.equal((await fetch(`http://127.0.0.1:${port2}/api/providers/openrouter`, { method: "DELETE" })).status, 404);
});

// ------------------------------------------------------------ MCP servers
test("mcp servers: PUT validates, writes mcpServers beside the other keys, masks secrets, keeps them on re-save, reloads opencode with them", async () => {
  const file = join(base, "pi-agent", "omni-agent.json");
  writeFileSync(file, JSON.stringify({ autoRecall: true, omniMcp: { command: "/x/omni-mcp" } }));
  const put = (name, body) => fetch(`http://127.0.0.1:${port2}/api/mcp/${name}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.deepEqual((await (await fetch(`http://127.0.0.1:${port2}/api/mcp`)).json()).servers, []);
  assert.equal((await put("bad name", { command: "npx" })).status, 400);
  assert.equal((await put("fs", { type: "stdio" })).status, 400, "stdio needs a command");
  assert.equal((await put("gh", { type: "http", url: "ftp://x" })).status, 400, "http needs an http(s) url");
  app2.startPi(base);
  const disposed = disposes();
  const r = await put("gh", { type: "http", url: "https://api.example.com/mcp", headers: { Authorization: "Bearer secret-token-9876", "X-Ref": "${GH_TOKEN}" }, timeoutSec: 60 });
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.equal(j.restarted, true);
  assert.equal(disposes(), disposed + 1, "opencode reloads so it connects");
  const oc = JSON.parse(readFileSync(join(base, "oc2-config", "opencode.json"), "utf8"));
  assert.deepEqual(oc.mcp.gh, { type: "remote", url: "https://api.example.com/mcp", headers: { Authorization: "Bearer secret-token-9876", "X-Ref": "{env:GH_TOKEN}" } });
  assert.deepEqual(oc.mcp.omnidroid, { type: "local", command: ["/x/omni-mcp"] }, "omnidroid from omniMcp");
  assert.equal(j.servers[0].headers.Authorization, "••••••••9876", "a secret is masked");
  assert.equal(j.servers[0].headers["X-Ref"], "${GH_TOKEN}", "an env reference is shown as-is");
  let disk = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(disk.autoRecall, true); assert.equal(disk.omniMcp.command, "/x/omni-mcp", "other keys are kept");
  assert.deepEqual(disk.mcpServers.gh, { type: "http", url: "https://api.example.com/mcp", headers: { Authorization: "Bearer secret-token-9876", "X-Ref": "${GH_TOKEN}" }, timeoutSec: 60 });
  // Saving the form back with the mask keeps the stored secret; renaming keeps the position.
  await put("fs", { type: "stdio", command: "npx", args: ["-y", "pkg"], env: { TOKEN: "abc" } });
  await put("github", { rename: "gh", type: "http", url: "https://api.example.com/mcp", headers: j.servers[0].headers, disabled: true });
  disk = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(Object.keys(disk.mcpServers), ["github", "fs"]);
  assert.equal(disk.mcpServers.github.headers.Authorization, "Bearer secret-token-9876");
  assert.equal(disk.mcpServers.github.disabled, true);
  assert.deepEqual(disk.mcpServers.fs, { command: "npx", args: ["-y", "pkg"], env: { TOKEN: "abc" } });
  assert.equal((await put("github", { rename: "fs", command: "x" })).status, 409, "a rename onto another server is refused");
  const del = await fetch(`http://127.0.0.1:${port2}/api/mcp/github`, { method: "DELETE" });
  assert.deepEqual((await del.json()).servers.map((s) => s.name), ["fs"]);
  assert.equal((await fetch(`http://127.0.0.1:${port2}/api/mcp/github`, { method: "DELETE" })).status, 404);
});

test("mcp-test: connects with the pi extension's client and lists the tools, or says why not", async () => {
  const test = (body) => fetch(`http://127.0.0.1:${port2}/api/mcp-test`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
  const ok = await test({ name: "fake", type: "stdio", command: process.execPath, args: [join(process.cwd(), "test", "helpers", "fake-mcp.mjs")], env: { FAKE_MCP: "1" } });
  assert.equal(ok.ok, true, ok.error);
  assert.deepEqual(ok.tools.map((t) => t.name), ["echo", "fail", "hang"]);
  const down = await test({ name: "down", type: "http", url: "http://127.0.0.1:9/mcp" });
  assert.equal(down.ok, false);
  assert.match(down.error, /not reachable/);
  assert.match((await test({ name: "x", type: "stdio" })).error, /needs a command/);
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
  assert.deepEqual(before.hook, { enabled: false, provider: "", model: "", maxIdleNudges: 5, graceMs: 2000, summaries: true, restateEvery: 10, summaryProvider: "", summaryModel: "", judgeTimeoutMs: 120000, heartbeatMs: 60000, loopK: 3, judgeFallback: false, planlessNudges: 1, errorCompactAfter: 2, errorBackoffMs: 15000 });
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

test("goal: /api/goal reports an empty goal and rejects a set without a pi session", async () => {
  const empty = await api("/api/goal");
  assert.equal(empty.goal, "");
  const r = await api("/api/goal", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ goal: "Do the thing" }) });
  assert.match(r.error, /no active chat session/);
});

// ---------------------------------------------- goal kickoff + full-halt stop
let goalPi = null;
function makeGoalPi({ cwd, model, provider, thinking } = {}) {
  goalPi = {
    proc: {}, sid: "pi:goal", cwd, model, provider, thinking, streaming: false, state: { sessionFile: "C:\\goal.jsonl" }, calls: [],
    start() {}, stop() { this.calls.push(["stop"]); }, owns() { return false; },
    waitReady() { return Promise.resolve(this.state); },
    async prompt(m) { this.calls.push(["prompt", m]); return { ok: true }; },
    async abort() { this.calls.push(["abort"]); return { success: true }; },
  };
  return goalPi;
}
const app3 = await createApp({ relay: { host: "" }, port: 0, vaultDir: join(base, "vault3"), piSessionsDir: join(base, "pi-sessions"), claudeProjectsDir: join(base, "claude-projects"), autoStartPi: false, cwd: base, claudeSpawn: fakeSpawn, liveWindowMs: 0, createPi: makeGoalPi, persistHook: false, persistPiModel: false, hook: { enabled: false } });
await app3.listen();
const port3 = app3.server.address().port;
after(() => app3.close());
const post3 = async (path, body) => { const r = await fetch(`http://127.0.0.1:${port3}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => ({})) }; };

test("goal kickoff: POST /api/goal sends the goal as a prompt and arms the keeper", async () => {
  app3.startPi(base);
  goalPi.calls.length = 0;
  const r = await post3("/api/goal", { goal: "do X" });
  assert.equal(r.status, 200);
  assert.equal(r.json.started, true);
  const kick = goalPi.calls.find((c) => c[0] === "prompt");
  assert.ok(kick && kick[1].startsWith("do X\n\n"), "the goal was sent as a kickoff prompt");
  assert.match(kick[1], /brainstorm and plan it with the plan tool/, "the kickoff asks for a plan up front");
  const g = await (await fetch(`http://127.0.0.1:${port3}/api/goal`)).json();
  assert.equal(g.goal, "do X"); assert.equal(g.explicit, true); assert.equal(g.plan, null, "no plan until the agent writes one");
  assert.equal(app3.keeper.config.enabled, true, "setting a goal arms the keeper");
});

test("full halt: POST /api/pi/abort aborts pi and pauses that goal, but leaves the hook armed for later runs", async () => {
  app3.startPi(base);
  await fetch(`http://127.0.0.1:${port3}/api/hook`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true }) });
  assert.equal(app3.keeper.config.enabled, true);
  app3.keeper.setGoal(goalPi.sid, "the running job");
  goalPi.calls.length = 0;
  const r = await post3("/api/pi/abort", {});
  assert.equal(r.status, 200);
  assert.ok(goalPi.calls.some((c) => c[0] === "abort"), "pi.abort() was called");
  assert.equal(app3.keeper.goal(goalPi.sid).paused, true, "the stopped goal is not re-engaged");
  assert.equal(app3.keeper.config.enabled, true, "Stop no longer switches the hook off for every later run");
});

// --------------------------------------------------------- watchdog wiring
function fakePiFactory() {
  return ({ cwd, model, provider, thinking } = {}) => ({
    proc: {}, sid: "pi:watchdog", cwd, model, provider, thinking, streaming: false, state: {}, _watchdogStarted: false,
    start() {}, stop() {}, owns() { return false; },
    waitReady() { return Promise.resolve(this.state); },
    startWatchdog() { this._watchdogStarted = true; },
  });
}

test("startPi starts the stall watchdog", async () => {
  const app = await createApp({ relay: { host: "" }, autoStartPi: false, createPi: fakePiFactory(), port: 0 });
  const pi = app.startPi(process.cwd());
  assert.ok(pi.watchdogTimer || pi._watchdogStarted, "watchdog should be armed");
  app.close();
});

test("model and thinking choices made before pi runs are remembered and handed to the next pi child", async () => {
  // `app` has no pi child at all
  const m = await fetch(`http://127.0.0.1:${port}/api/pi/model`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "openrouter", modelId: "deepseek/x" }) });
  const mj = await m.json();
  assert.equal(m.status, 200);
  assert.equal(mj.pending, true);
  assert.equal(mj.modelId, "deepseek/x");
  const t = await fetch(`http://127.0.0.1:${port}/api/pi/thinking`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ level: "low" }) });
  const tj = await t.json();
  assert.equal(tj.pending, true);
  assert.equal(tj.level, "high", "a DeepSeek V3-style model only switches thinking on or off: low is on");
  const bad = await fetch(`http://127.0.0.1:${port}/api/pi/thinking`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ level: "turbo" }) });
  assert.equal(bad.status, 400);
  const st = await api("/api/state");
  assert.equal(st.pi.running, false);
  assert.deepEqual([st.config.piProvider, st.config.piModel, st.config.piThinking], ["openrouter", "deepseek/x", "high"]);
  // the stubbed-pi app: a live child gets the change at once, and the next child is created with the saved choices
  fakePi.calls.length = 0;
  const r = await post2("/api/pi/model", { provider: "orca", modelId: "qwen" });
  assert.equal(r.json.pending, undefined, "a live child applies the model immediately");
  await post2("/api/pi/thinking", { level: "high" });
  assert.deepEqual(fakePi.calls, [["model", "orca", "qwen"], ["thinking", "high"]]);
  await post2("/api/pi/start", { cwd: base });
  assert.deepEqual([fakePi.model, fakePi.provider, fakePi.thinking], ["qwen", "orca", "high"]);
});

test("thinking levels follow the model: its family's levels, and a switch moves the saved level to the nearest it has", async () => {
  const levels = async (q) => (await api(`/api/pi/thinking-levels${q}`)).data;
  assert.deepEqual((await levels("?provider=openrouter&model=deepseek/deepseek-v4.1-flash")).levels, ["off", "high", "max"]);
  assert.deepEqual((await levels("?provider=x&model=gpt-5.2")).levels, ["off", "low", "medium", "high", "xhigh"]);
  const qwen = await levels("?provider=orca&model=Qwen/Qwen3.8-27B");
  assert.deepEqual([qwen.levels, qwen.labels], [["off", "high"], { high: "on" }]);
  assert.deepEqual((await levels("?provider=x&model=some-unknown-model")).levels, ["off", "minimal", "low", "medium", "high"]);
  // the current model when none is named (`app` saved openrouter/deepseek/x above)
  assert.equal((await levels("")).model, "deepseek/x");
  // claude-opus-5-5 has max; GPT-5.2 does not: a switch moves max down to xhigh, and a live pi gets it at once
  fakePi.calls.length = 0;
  await post2("/api/pi/model", { provider: "anthropic", modelId: "claude-opus-5-5" });
  assert.equal((await post2("/api/pi/thinking", { level: "max" })).json.level, "max");
  const r = await post2("/api/pi/model", { provider: "openai", modelId: "gpt-5.2" });
  assert.equal(r.json.level, "xhigh");
  assert.deepEqual(fakePi.calls.slice(-2), [["model", "openai", "gpt-5.2"], ["thinking", "xhigh"]]);
});

test("sid for an opencode mirror file", () => {
  assert.equal(sidForFile("pi", "/x/opencode/2026-10-23T00-00-00.000Z_ses_e99eaa6e3fferGKykKmPKDLWNM.jsonl"), "pi:ses_e99eaa6e3fferGKykKmPKDLWNM");
  assert.equal(sidForFile("pi", "/x/2026-10-23T00-00-00.000Z_0b1c0b1c-0b1c-4b1c-8b1c-0b1c0b1c0b1c.jsonl"), "pi:0b1c0b1c-0b1c-4b1c-8b1c-0b1c0b1c0b1c");
  assert.equal(sidForFile("claude", "/x/abc.jsonl"), "claude:abc");
});

// ------------------------------------------------------------ chats on the shared opencode server (fake)
const OC_CATALOG = {
  all: [
    { id: "opencode", name: "OpenCode Zen", models: {
      "big-pickle": { id: "big-pickle", name: "Big Pickle", limit: { context: 200000, output: 32000 }, capabilities: { reasoning: true }, variants: {}, cost: { input: 0, output: 0 }, status: "active" },
      think: { id: "think", name: "Thinker", limit: { context: 8000, output: 1000 }, variants: { low: {}, high: {}, max: {} }, cost: { input: 1, output: 2 } },
      old: { id: "old", name: "Old", limit: { context: 1, output: 1 }, status: "deprecated", cost: { input: 0, output: 0 } },
    } },
    { id: "anthropic", name: "Anthropic", models: {
      x: { id: "x", name: "X", limit: { context: 100, output: 10 }, variants: { high: {} }, cost: { input: 3, output: 15 } },
      y: { id: "y", name: "Y", limit: { context: 100, output: 10 }, cost: { input: 3, output: 15 } },
    } },
    { id: "google", name: "Google", models: { g: { id: "g", name: "G" } } },
  ],
  connected: ["opencode", "anthropic"],
};
const ocBase = mkdtempSync(join(tmpdir(), "omni-oc-srv-"));
const personasDir = join(ocBase, "personas");
mkdirSync(personasDir, { recursive: true });
writeFileSync(join(personasDir, "scout.md"), "---\nname: scout\ndescription: Recon.\ntools: read, find\n---\nYou scout.\n");
const oc = new FakeServer({ catalog: OC_CATALOG, up: false, reply: (m, p) => (m === "POST" && /^\/session\/[^/]+\/message$/.test(p) ? { info: { id: "msg_side" }, parts: [{ type: "text", text: "side answer" }] } : undefined) });
const ocLogs = [];
const app4 = await createApp({ relay: { host: "" }, port: 0, vaultDir: join(ocBase, "vault"), piSessionsDir: join(ocBase, "pi-sessions"), claudeProjectsDir: join(ocBase, "claude-projects"), autoStartPi: false, cwd: ocBase, liveWindowMs: 0, persistHook: false, persistPiModel: false, hook: { enabled: false }, opencodeServer: oc, opencodeConfigDir: join(ocBase, "oc-config"), piExtConfigFile: join(ocBase, "pi-agent", "omni-agent.json"), piModelsFile: join(ocBase, "pi-agent", "models.json"), statusSessionsDir: join(ocBase, "status"), personasDir, piModels: ["anthropic/x"], piProvider: "opencode", piModel: "gone", piThinking: "high", context: { compactAt: 300000 } });
app4.bus.on("event", (ev) => { if (ev.kind === "log") ocLogs.push(ev); });
await app4.listen();
const port4 = app4.server.address().port;
const post4 = async (path, body) => { const r = await fetch(`http://127.0.0.1:${port4}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
const get4 = async (path) => (await fetch(`http://127.0.0.1:${port4}${path}`)).json();
let ocSid = null;

test("opencode: /api/pi/open starts the shared server, writes its config and opens an OpencodeRpc chat with compactAt", async () => {
  const r = await post4("/api/pi/open", { cwd: ocBase });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  ocSid = r.json.sid;
  assert.equal(ocSid, "pi:ses_fake1");
  assert.equal(oc.starts, 1, "the server is started for the first chat");
  const create = oc.calls.find((c) => c.method === "POST" && c.path === "/session");
  assert.equal(create.directory, ocBase);
  const chat = app4.pis.find((c) => c.sid === ocSid);
  assert.equal(chat.constructor.name, "OpencodeRpc");
  assert.equal(chat.compactAt, 300000, "compactAt comes from the context policy");
  assert.match(chat.state.sessionFile, /pi-sessions[\\/]opencode[\\/].*_ses_fake1\.jsonl$/);
  const conf = JSON.parse(readFileSync(join(ocBase, "oc-config", "opencode.json"), "utf8"));
  assert.equal(conf.permission.bash, "allow");
  assert.deepEqual(conf.tools, { question: false });
  const shim = readFileSync(join(ocBase, "oc-config", "plugin", "omni.js"), "utf8");
  assert.match(shim, /integrations\/opencode\/omni-plugin\.mjs";/, "the Omni plugin shim is written with the config");
});

test("opencode: a saved model missing from the connected catalog is reported once, the config left alone", async () => {
  for (let i = 0; i < 50 && !ocLogs.some((e) => /opencode\/gone/.test(e.text)); i++) await sleep(10);
  const lines = ocLogs.filter((e) => /opencode\/gone/.test(e.text));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].level, "system");
  assert.match(lines[0].text, /pick another model/i);
  assert.equal(app4.cfg.piModel, "gone");
});

test("opencode: /api/pi/models lists connected providers from GET /provider (deprecated skipped, piModels filter, opencode in full)", async () => {
  const r = await get4("/api/pi/models");
  assert.deepEqual(r.data.models.map((m) => `${m.provider}/${m.id}`), ["opencode/big-pickle", "opencode/think", "anthropic/x"]);
  assert.deepEqual(r.data.models[0], { provider: "opencode", id: "big-pickle", name: "Big Pickle", contextWindow: 200000, thinking: ["off"], thinkingLabels: { off: "auto" }, free: true });
  assert.deepEqual(r.data.models[1].thinking, ["low", "high", "max"]);
  assert.equal(r.data.models[1].free, false);
  const levels = await get4("/api/pi/thinking-levels?provider=opencode&model=think");
  assert.deepEqual(levels.data.levels, ["low", "high", "max"]);
});

test("opencode: /api/pi/model and /api/pi/thinking pick the model and clamp the level to its variants; /api/pi/prompt posts prompt_async with them", async () => {
  const m = await post4("/api/pi/model", { sid: ocSid, provider: "opencode", modelId: "think" });
  assert.equal(m.status, 200);
  assert.equal(m.json.success, true);
  assert.deepEqual([app4.cfg.piProvider, app4.cfg.piModel, m.json.level], ["opencode", "think", "high"]);
  const bad = await post4("/api/pi/model", { sid: ocSid, provider: "opencode", modelId: "nope" });
  assert.equal(bad.json.success, false, "a model OpenCode does not have is refused");
  assert.equal(app4.cfg.piModel, "think");
  const t = await post4("/api/pi/thinking", { sid: ocSid, level: "minimal" });
  assert.equal(t.json.level, "low", "clamped to the nearest variant the model has");
  const p = await post4("/api/pi/prompt", { sid: ocSid, message: "say hi", memory: false });
  assert.equal(p.status, 200);
  const call = oc.calls.filter((c) => c.method === "POST" && /prompt_async$/.test(c.path)).at(-1);
  assert.equal(call.path, "/session/ses_fake1/prompt_async");
  assert.deepEqual(call.body.model, { providerID: "opencode", modelID: "think" });
  assert.equal(call.body.variant, "low");
  assert.deepEqual(call.body.parts, [{ type: "text", text: "say hi" }]);
});

test("opencode: /api/pi/abort aborts the session and cancels the chat's goal", async () => {
  app4.keeper.setGoal(ocSid, "the running job");
  const r = await post4("/api/pi/abort", { sid: ocSid });
  assert.equal(r.status, 200);
  assert.ok(oc.calls.some((c) => c.method === "POST" && c.path === "/session/ses_fake1/abort"));
  assert.equal(app4.keeper.goal(ocSid).paused, true);
});

test("opencode: the status box keeps one OpenCode session per goal conversation; the judge's session is deleted", async () => {
  const before = oc.calls.length;
  assert.equal(await app4.keeper.summarizeFn("plan moved", { provider: "", model: "", conversation: "conv-1" }), "side answer");
  assert.equal(await app4.keeper.summarizeFn("plan moved again", { provider: "", model: "", conversation: "conv-1" }), "side answer");
  const calls = oc.calls.slice(before);
  const creates = calls.filter((c) => c.method === "POST" && c.path === "/session");
  assert.equal(creates.length, 1, "one session for the conversation");
  assert.equal(creates[0].directory, join(ocBase, "status"));
  const msgs = calls.filter((c) => /\/message$/.test(c.path));
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].path, msgs[1].path, "the second call continues the same session");
  assert.deepEqual(msgs[0].body.model, { providerID: "opencode", modelID: "think" }, "the chat's saved model when the hook names none");
  assert.match(msgs[0].body.system, /status/i);
  assert.ok(!calls.some((c) => c.method === "DELETE"), "a status conversation is kept");
  const saved = JSON.parse(readFileSync(join(ocBase, "status", "opencode-sessions.json"), "utf8"));
  assert.equal(saved["conv-1"].id, msgs[0].path.split("/")[2], "kept across an Omni restart");
  const mark = oc.calls.length;
  assert.equal(await app4.keeper.judge("done?", { provider: "anthropic", model: "x" }), "side answer");
  const j = oc.calls.slice(mark);
  assert.deepEqual(j.map((c) => c.method), ["POST", "POST", "DELETE"]);
  assert.deepEqual(j[1].body.model, { providerID: "anthropic", modelID: "x" });
});

test("opencode: a background agent is an OpencodeRpc with its persona's system prompt and tool allowlist (plan kept)", async () => {
  const r = await post4("/api/agents", { task: "look around", agent: "scout", parentSid: ocSid, depth: 0 });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  let call = null;
  for (let i = 0; i < 100 && !call; i++) { await sleep(10); call = oc.calls.find((c) => /prompt_async$/.test(c.path) && c.body.system); }
  assert.ok(call, "the agent prompted its session");
  assert.equal(call.body.system, "You scout.");
  assert.deepEqual(call.body.tools, { "*": false, read: true, glob: true, plan: true });
  await post4(`/api/agents/${r.json.agent.id}/cancel`, {});
});

test("opencode: a provider or MCP change rewrites opencode.json and disposes the server's instances (no chat relaunch)", async () => {
  const chat = app4.pis.find((c) => c.sid === ocSid);
  chat.streaming = false; chat.inFlight = 0;
  const before = oc.calls.length;
  const r = await fetch(`http://127.0.0.1:${port4}/api/mcp/gh`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "http", url: "https://api.example.com/mcp" }) });
  // The MCP list stays in omni-agent.json (rendered into opencode.json); the route reloads OpenCode.
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.restarted, true);
  assert.ok(oc.calls.slice(before).some((c) => c.method === "POST" && c.path === "/global/dispose"));
  assert.equal(app4.pis.find((c) => c.sid === ocSid), chat, "the chat keeps going on the same server");
});

test("opencode: a message sent while OpenCode restarts waits for its chat to reattach (no second chat on the session)", async () => {
  const chat = app4.pis.find((c) => c.sid === ocSid);
  chat.streaming = false; chat.inFlight = 0;
  const chats = app4.pis.length;
  oc.up = false; oc.proc = null; oc.emit("down");
  assert.equal(chat.proc, null, "the chat is reattaching");
  const before = oc.calls.length;
  const pending = post4("/api/pi/prompt", { sid: ocSid, message: "during the outage", memory: false });
  await sleep(80);
  oc.up = true; oc.proc = { pid: 4242 }; oc.emit("up");
  const r = await pending;
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(app4.pis.length, chats, "no second chat was opened");
  assert.equal(app4.pis.filter((c) => c.sid === ocSid).length, 1);
  const prompts = oc.calls.slice(before).filter((c) => /prompt_async$/.test(c.path));
  assert.deepEqual(prompts.map((c) => c.path), ["/session/ses_fake1/prompt_async"], "the chat itself got the message");
  oc.push({ type: "session.idle", properties: { sessionID: "ses_fake1" } });
});

test("opencode: a chat that does not come back in time answers 409 on every route that takes its sid", async () => {
  const chat = app4.pis.find((c) => c.sid === ocSid);
  chat.streaming = false; chat.inFlight = 0;
  const chats = app4.pis.length;
  app4.cfg.opencodeRestartWaitMs = 120;
  oc.up = false; oc.proc = null; oc.emit("down");
  try {
    for (const [path, body] of [["/api/pi/prompt", { message: "x", memory: false }], ["/api/pi/abort", {}], ["/api/pi/compact", {}], ["/api/pi/model", { provider: "opencode", modelId: "think" }], ["/api/pi/thinking", { level: "high" }], ["/api/pi/new", {}], [`/api/sessions/${encodeURIComponent(ocSid)}/continue`, { message: "y" }]]) {
      const r = await post4(path, { sid: ocSid, ...body });
      assert.equal(r.status, 409, `${path}: ${JSON.stringify(r.json)}`);
      assert.match(r.json.error, /OpenCode is restarting/, path);
    }
    assert.equal(app4.pis.length, chats, "no second chat was opened");
  } finally {
    delete app4.cfg.opencodeRestartWaitMs;
    oc.up = true; oc.proc = { pid: 4242 }; oc.emit("up");
  }
  for (let i = 0; i < 50 && !chat.proc; i++) await sleep(10);
  assert.ok(chat.proc, "back");
});

test("opencode: close() ends the opencode server synchronously (a script exits right after it)", async () => {
  app4.close();
  assert.equal(oc.stops, 1);
  assert.equal(oc.killSyncs, 1);
});

test("opencode: an injected server gets no process exit hooks unless asked", () => {
  // app4 opened chats on its injected server above: under test, nothing touched the real process.
  assert.equal(process.listeners("exit").some((f) => /killSync/.test(String(f))), false);
});

// ---------------------------------------------- a failed first start, and the exit guard
const failBase = mkdtempSync(join(tmpdir(), "omni-oc-fail-"));
const failOpts = (dir, extra) => ({ relay: { host: "" }, port: 0, vaultDir: join(dir, "vault"), piSessionsDir: join(dir, "pi-sessions"), claudeProjectsDir: join(dir, "claude"), autoStartPi: false, cwd: dir, liveWindowMs: 0, persistHook: false, persistPiModel: false, hook: { enabled: false }, opencodeConfigDir: join(dir, "oc-config"), piExtConfigFile: join(dir, "pi-agent", "omni-agent.json"), piModelsFile: join(dir, "pi-agent", "models.json"), piProvider: "opencode", piModel: "big-pickle", ...extra });

test("opencode: a failed first start is tried again when a chat is used, and the guard is set up once", async () => {
  const proc = new EventEmitter();
  const srv = new FakeServer({ up: false, failStarts: 1 });
  const app = await createApp(failOpts(failBase, { opencodeServer: srv, exitGuardProcess: proc }));
  await app.listen();
  const port = app.server.address().port;
  const post = async (path, body) => { const r = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
  try {
    const first = await post("/api/pi/open", { cwd: failBase });
    assert.notEqual(first.status, 200, "the server could not start");
    assert.equal(srv.starts, 1);
    const chat = app.pis[0];
    assert.ok(chat && !chat.proc, "the chat exists but has no session");
    // The chat's next prompt starts the server again and goes through.
    const r = await Promise.race([chat.prompt("again", { echo: false }), sleep(3000).then(() => "the prompt hung waiting for a server nobody starts")]);
    assert.deepEqual(r, { success: true });
    assert.equal(srv.starts, 2);
    assert.ok(srv.calls.some((c) => /prompt_async$/.test(c.path)));
    const second = await post("/api/pi/open", { cwd: failBase });
    assert.equal(second.status, 200);
    assert.equal(proc.listenerCount("exit"), 1, "one exit hook, however often the server is ensured");
    assert.equal(proc.listenerCount("SIGINT"), 1);
    proc.emit("exit", 0);
    assert.equal(srv.killSyncs, 1, "Omni's process exit ends the server");
  } finally { app.close(); }
  assert.equal(proc.listenerCount("SIGINT"), 0, "close() drops the signal handlers");
  assert.equal(proc.listenerCount("exit"), 1, "the exit kill stays");
});

test("opencode: a config change starts a server whose first start failed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omni-oc-fail2-"));
  const srv = new FakeServer({ up: false, failStarts: 1 });
  const app = await createApp(failOpts(dir, { opencodeServer: srv }));
  await app.listen();
  const port = app.server.address().port;
  try {
    const open = await fetch(`http://127.0.0.1:${port}/api/pi/open`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: dir }) });
    assert.notEqual(open.status, 200);
    assert.equal(srv.up, false);
    const r = await fetch(`http://127.0.0.1:${port}/api/mcp/fixed`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ command: "node" }) });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).restarted, true);
    for (let i = 0; i < 50 && !srv.up; i++) await sleep(10);
    assert.equal(srv.up, true, "started with the fixed config");
    assert.equal(srv.starts, 2);
    const conf = JSON.parse(readFileSync(join(dir, "oc-config", "opencode.json"), "utf8"));
    assert.deepEqual(conf.mcp.fixed, { type: "local", command: ["node"] });
    // A server that was never wanted is not started by a config change.
    const idle = new FakeServer({ up: false });
    const app2b = await createApp(failOpts(mkdtempSync(join(tmpdir(), "omni-oc-idle-")), { opencodeServer: idle }));
    await app2b.listen();
    const r2 = await fetch(`http://127.0.0.1:${app2b.server.address().port}/api/mcp/x`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ command: "node" }) });
    assert.equal((await r2.json()).restarted, false);
    assert.equal(idle.starts, 0);
    app2b.close();
  } finally { app.close(); }
});