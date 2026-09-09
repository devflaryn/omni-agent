import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const app = await createApp({ port: 0, vaultDir: join(base, "vault"), piSessionsDir: join(base, "pi-sessions"), claudeProjectsDir: join(base, "claude-projects"), autoStartPi: false, cwd: base });
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
