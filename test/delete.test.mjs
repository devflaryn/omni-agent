import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/index.mjs";

test("DELETE /api/sessions/:sid moves the chat to trash, refuses a live one, 404s after", async () => {
  const base = mkdtempSync(join(tmpdir(), "omni-del-"));
  const piDir = join(base, "pi"); mkdirSync(piDir, { recursive: true });
  const id = "01a086a6-c763-777d-8188-9a868c6a2266";
  const file = join(piDir, `sess_${id}.jsonl`);
  writeFileSync(file,
    JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-09-09T14:51:12.099Z", cwd: "/x/proj" }) + "\n" +
    JSON.stringify({ type: "message", id: "u1", timestamp: "2026-09-09T14:52:00Z", message: { role: "user", content: "hello there" } }) + "\n");
  const trashDir = join(base, "trash");
  const app = await createApp({ port: 0, host: "127.0.0.1", lan: false, autoStartPi: false, cwd: base, vaultDir: join(base, "vault"), piSessionsDir: piDir, claudeProjectsDir: join(base, "claude"), trashDir });
  await app.listen();
  const port = app.server.address().port;
  const sid = `pi:${id}`;
  const del = async (s) => { const r = await fetch(`http://127.0.0.1:${port}/api/sessions/${encodeURIComponent(s)}`, { method: "DELETE" }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
  try {
    assert.ok(app.registry.get(sid), "session known after peek");
    // a live chat is refused
    const s = app.registry.get(sid); s.streaming = true; s.lastActivity = Date.now();
    assert.equal((await del(sid)).status, 409);
    assert.ok(existsSync(file), "still there after a refused delete");
    s.streaming = false; s.lastActivity = 0;
    // real delete -> moved to trash, dropped from registry
    const ok = await del(sid);
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.ok(!existsSync(file), "original removed");
    assert.ok(ok.json.trashed && existsSync(ok.json.trashed), "moved to trash (recoverable)");
    assert.equal(app.registry.get(sid), undefined, "dropped from registry");
    // second delete -> 404
    assert.equal((await del(sid)).status, 404);
  } finally { app.close(); rmSync(base, { recursive: true, force: true }); }
});

test("DELETE /api/sessions/:sid 404s an unknown session", async () => {
  const base = mkdtempSync(join(tmpdir(), "omni-del2-"));
  const app = await createApp({ port: 0, host: "127.0.0.1", lan: false, autoStartPi: false, cwd: base, vaultDir: join(base, "vault"), piSessionsDir: join(base, "pi"), claudeProjectsDir: join(base, "claude"), trashDir: join(base, "trash") });
  await app.listen();
  const port = app.server.address().port;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/sessions/pi:nope`, { method: "DELETE" });
    assert.equal(r.status, 404);
  } finally { app.close(); rmSync(base, { recursive: true, force: true }); }
});
