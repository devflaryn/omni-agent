import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { opencodeAuthFile, watchAuthStore } from "../server/auth-watch.mjs";

const fresh = () => mkdtempSync(join(tmpdir(), "omni-authw-"));
const until = async (cond, ms = 3000) => { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > ms) return false; await new Promise((r) => setTimeout(r, 20)); } return true; };

test("opencodeAuthFile is OpenCode's own login store: XDG_DATA_HOME, else ~/.local/share, then opencode/auth.json", () => {
  assert.equal(opencodeAuthFile({}, "C:\\Users\\u"), join("C:\\Users\\u", ".local", "share", "opencode", "auth.json"));
  assert.equal(opencodeAuthFile({ XDG_DATA_HOME: "D:\\data" }, "C:\\Users\\u"), join("D:\\data", "opencode", "auth.json"));
  assert.equal(opencodeAuthFile({ XDG_DATA_HOME: "  " }, "/home/u"), join("/home/u", ".local", "share", "opencode", "auth.json"));
});

test("watchAuthStore calls back once per change of the login store (a login, a logout), not for an untouched file", async () => {
  const dir = join(fresh(), "opencode");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "auth.json");
  writeFileSync(file, JSON.stringify({ openrouter: { type: "api", key: "a" } }));
  let calls = 0;
  const w = watchAuthStore(file, () => { calls++; }, { interval: 20, debounceMs: 30 });
  try {
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(calls, 0, "no change, no call");
    writeFileSync(file, JSON.stringify({ openrouter: { type: "api", key: "a" }, "opencode-go": { type: "api", key: "b" } }));
    assert.ok(await until(() => calls === 1), "a login is seen");
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(calls, 1, "one call per change");
    writeFileSync(file, JSON.stringify({ openrouter: { type: "api", key: "a" } }));
    assert.ok(await until(() => calls === 2), "a logout is seen");
  } finally { w.stop(); }
});

test("watchAuthStore sees the store created by a first login, and stop() ends the watch", async () => {
  const dir = fresh();
  const file = join(dir, "opencode", "auth.json");
  let calls = 0;
  const w = watchAuthStore(file, () => { calls++; }, { interval: 20, debounceMs: 30 });
  mkdirSync(join(dir, "opencode"));
  writeFileSync(file, "{}");
  assert.ok(await until(() => calls === 1), "the new store is seen");
  w.stop();
  writeFileSync(file, JSON.stringify({ x: { type: "api", key: "k" } }));
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(calls, 1, "nothing after stop()");
});
