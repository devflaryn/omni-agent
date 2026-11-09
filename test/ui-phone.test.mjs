// The iPhone app's side of the UI: its Keychain store, its way to the hub through the shell, and the account it runs, against a real
// hub and a real desktop. The shell itself (ios/) is Swift and is tested by OmniAgentTests on a simulator; here a small stand-in plays
// its `keystore` and `net` bridges with the same rules: keys read once per page load, and only the hub's /api/salt, /api/login and /ws.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startHub } from "../hub/server.mjs";
import { Account } from "../server/account.mjs";
import { PageAccount } from "../ui/page-account.js";
import { keychainStore } from "../ui/keychain-store.js";
import { nativeFetch, nativeWebSocket } from "../ui/phone-net.js";
import { readBuild } from "../hub/static.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (check, what = "condition", ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await check(); if (v) return v; await sleep(5); }
  assert.fail(`timed out waiting for ${what}`);
};
const base = mkdtempSync(join(tmpdir(), "omni-phone-"));
let serial = 0;
const freshDir = () => { const d = join(base, `t${++serial}`); mkdirSync(d, { recursive: true }); return d; };
const BOOTSTRAP = "bootstrap-token-0123456789";
const ORIGIN = "https://hub.test";
const PASSWORD = "correct horse battery";
const EMAIL = "me@example.com";
const testProtector = {
  name: "test",
  async protect(bytes) { return Buffer.concat([Buffer.from("TEST"), Buffer.from(bytes).map((b) => b ^ 0x5a)]); },
  async unprotect(bytes) { return Buffer.from(bytes).subarray(4).map((b) => b ^ 0x5a); },
};
const quickKey = async (password, salt) => {
  const part = (label) => new Uint8Array(createHash("sha256").update(label).update(password).update(salt).digest());
  return { loginKey: part("login"), anchorKey: part("anchor") };
};
const cleanups = [];
after(async () => { for (const c of cleanups.reverse()) { try { await c(); } catch { /* */ } } });

/** The Keychain bridge's rules (ios/OmniAgent/Keystore.swift), over a Map that outlives a "page load". */
function keychain(items = new Map()) {
  let answered = false;
  let atLoad;
  let written = false;
  const bridge = {
    items,
    loads: 0,
    pageLoaded() { answered = false; atLoad = undefined; written = false; bridge.loads++; },
    async get(name) {
      if (name === "keys") {
        if (answered) throw new Error("read once per page load");
        answered = true;
        atLoad = items.has("keys");
      }
      return items.get(name) ?? null;
    },
    async put(name, value) {
      if (typeof value !== "string") throw new Error("only text");
      if (name === "keys") {
        if (atLoad !== false || written || items.has("keys")) throw new Error("This phone's keys were just deleted, and new ones are made only on a fresh start.");
        written = true;
      }
      items.set(name, value);
    },
    async remove(name) { items.delete(name); },
  };
  return bridge;
}

/** The `net` bridge (ios/OmniAgent/HubLink.swift): the one hub, two POST paths and its socket, with no Origin header. */
function shellNet(hubUrl, events) {
  const sockets = new Map();
  const asked = [];
  const ask = async (message) => {
    asked.push(message);
    switch (message.op) {
      case "post": {
        if (!["/api/salt", "/api/login"].includes(message.path)) throw new Error("The app sends nothing like that to the hub.");
        const r = await fetch(new URL(message.path, hubUrl), { method: "POST", headers: { "content-type": "application/json" }, body: message.body });
        return { status: r.status, body: await r.text() };
      }
      case "open": {
        const ws = new WebSocket(`${hubUrl.replace(/^http/, "ws")}/ws`);
        sockets.set(message.id, ws);
        ws.onopen = () => events.__omniNet(message.id, "open", null);
        ws.onmessage = (e) => events.__omniNet(message.id, "message", e.data);
        ws.onclose = (e) => { if (sockets.delete(message.id)) events.__omniNet(message.id, "close", e.code); };
        return null;
      }
      case "send": sockets.get(message.id)?.send(message.text); return null;
      case "close": { const ws = sockets.get(message.id); if (ws && sockets.delete(message.id)) { ws.close(); events.__omniNet(message.id, "close", 1000); } return null; }
      default: throw new Error(`Nothing here answers ${message.op}.`);
    }
  };
  return { ask, asked, sockets };
}

async function hubFixture() {
  const hub = await startHub({ dataDir: join(freshDir(), "hub"), bootstrapToken: BOOTSTRAP, origin: ORIGIN, log: () => {}, sweepMs: 50 });
  cleanups.push(() => hub.close());
  return { hub, url: `http://127.0.0.1:${hub.port}` };
}

async function firstDesktop(fixture) {
  const dir = join(freshDir(), "account");
  mkdirSync(dir, { recursive: true });
  const account = new Account({ dir, hubUrl: fixture.url, hubOrigin: ORIGIN, name: "Desk", kind: "desktop", protector: testProtector, deriveKeys: quickKey, reconnect: { minMs: 20, maxMs: 100 }, log: () => {} });
  cleanups.push(() => account.stop());
  writeFileSync(join(dir, "bootstrap-token"), `${BOOTSTRAP}\n`);
  await account.register({ email: EMAIL, password: PASSWORD, name: "Desk" });
  await account.recoveryCodeSaved();
  await until(() => account.status().hub.connected, "the desktop's socket");
  return account;
}

/** The phone as phone.js makes it, on one page load. */
function phone(fixture, bridge) {
  bridge.pageLoaded();
  const events = {};
  const net = shellNet(fixture.url, events);
  const account = new PageAccount({
    store: keychainStore(bridge),
    hubUrl: fixture.url,
    hubOrigin: ORIGIN,
    name: "Test iPhone",
    kind: "iphone",
    self: "phone",
    deriveKeys: quickKey,
    fetchImpl: nativeFetch(net, fixture.url),
    WebSocketImpl: nativeWebSocket(net, fixture.url, events),
    reconnect: { minMs: 20, maxMs: 100 },
  });
  account.net = net;
  cleanups.push(() => account.stop());
  return account;
}

async function approve(desk, p, role) {
  await until(() => p.status().phase === "pending" && p.status().hub.connected, "the phone on the hub");
  const row = await until(() => desk.pendingSignIns().find((x) => x.signPub === p.status().device.id), "the card");
  assert.equal(row.kind, "iphone");
  const review = await desk.review(row.id);
  const code = await until(() => p.status().pending?.code, "the code on the phone");
  assert.equal(code, review.code);
  await desk.approve(row.id, { code, role });
  await until(() => p.status().phase === "approved", "approval");
}

test("the phone signs in through the shell, is approved as full with one tap, keeps no expiry, and survives a reload", async () => {
  const fixture = await hubFixture();
  const desk = await firstDesktop(fixture);
  const bridge = keychain();
  const p = phone(fixture, bridge);
  await p.start();
  await p.signIn({ email: EMAIL, password: PASSWORD, name: "Test iPhone" });
  await approve(desk, p, "full");
  const s = p.status();
  assert.equal(s.device.role, "full");
  assert.equal(s.device.kind, "iphone");
  assert.equal(s.device.expiresAt, null, "full does not run out");
  assert.ok(desk.devices().some((d) => d.id === s.device.id && d.role === "full" && d.kind === "iphone"));

  // Only the shell's calls, only to the hub: two posts and a socket.
  assert.deepEqual([...new Set(p.net.asked.filter((m) => m.op === "post").map((m) => m.path))].sort(), ["/api/login", "/api/salt"]);

  // The keys are text in the Keychain, imported here as keys that cannot be read back.
  const kept = JSON.parse(bridge.items.get("keys"));
  assert.equal(kept.signPub, s.device.id);
  const other = keychain(new Map([["keys", bridge.items.get("keys")]]));
  other.pageLoaded();
  const imported = await keychainStore(other).get("keys");
  await assert.rejects(crypto.subtle.exportKey("pkcs8", imported.sign.privateKey), "the page holds keys it cannot export");

  // A new page load: the same keys, read once, and the phone is approved again with no new tap.
  await p.stop();
  const again = phone(fixture, bridge);
  await again.start();
  await until(() => again.status().phase === "approved" && again.status().hub.connected, "back on, by itself");
  assert.equal(again.status().device.id, s.device.id);
  assert.ok(!desk.pendingSignIns().length, "nothing to approve again");
});

test("a denial reaches the phone: the hub's close code crosses the shell", async () => {
  const fixture = await hubFixture();
  const desk = await firstDesktop(fixture);
  const p = phone(fixture, keychain());
  await p.start();
  await p.signIn({ email: EMAIL, password: PASSWORD });
  await until(() => p.status().phase === "pending" && p.status().hub.connected, "pending");
  const row = await until(() => desk.pendingSignIns().find((x) => x.signPub === p.status().device.id), "the card");
  await desk.deny(row.id);
  await until(() => p.status().phase === "denied", "denied, by the 4410 close");
});

test("the phone's words say phone, not page", async () => {
  const fixture = await hubFixture();
  const p = phone(fixture, keychain());
  await p.start();
  await assert.rejects(p.signIn({ email: EMAIL, password: "wrong password here" }), /Wrong email or password/);
  const words = [p.links.selfName, ...Object.values(p.status())].filter((v) => typeof v === "string").join(" ");
  assert.doesNotMatch(words, /this page/i);
});

test("after forgetting, keys come only with a fresh page load", async () => {
  const fixture = await hubFixture();
  await firstDesktop(fixture);
  const bridge = keychain();
  const p = phone(fixture, bridge);
  await p.start();
  await p.signIn({ email: EMAIL, password: PASSWORD });
  assert.ok(bridge.items.has("keys"));
  await p.signOut({ forget: true });
  assert.equal(bridge.items.size, 0, "everything kept is gone");
  await assert.rejects(p.signIn({ email: EMAIL, password: PASSWORD }), /fresh start/, "this load cannot choose new keys");
  await p.stop();
  const fresh = phone(fixture, bridge); // phone.js reloads the page after Forget this phone
  await fresh.start();
  await fresh.signIn({ email: EMAIL, password: PASSWORD });
  assert.equal(fresh.status().phase, "pending");
});

test("the shell's fetch and socket go to the hub and nowhere else", async () => {
  const net = { ask: async () => ({ status: 200, body: "{}" }) };
  const f = nativeFetch(net, "https://tomcamp.tech");
  assert.equal((await (await f(new URL("/api/salt", "https://tomcamp.tech"), { method: "POST", body: "{}" })).json()).constructor, Object);
  await assert.rejects(f("https://evil.example/api/salt", { method: "POST" }), /only to its hub/);
  await assert.rejects(f("https://tomcamp.tech/api/salt"), /only posts/);
  const Socket = nativeWebSocket(net, "https://tomcamp.tech", {});
  assert.throws(() => new Socket("wss://evil.example/ws"), /only to its hub/);
  assert.throws(() => new Socket("wss://tomcamp.tech/other"), /only to its hub/);
  const s = new Socket("wss://tomcamp.tech/ws");
  assert.equal(s.readyState, 0);
  assert.throws(() => s.send("x"), /not open/);
});

test("the socket's states and buffer follow the shell's events, and a close is final", async () => {
  const events = {};
  const sent = [];
  let release;
  const net = { ask: async (m) => { if (m.op === "send") { sent.push(m.text); await new Promise((r) => { release = r; }); } return null; } };
  const Socket = nativeWebSocket(net, "https://tomcamp.tech", events);
  const s = new Socket("wss://tomcamp.tech/ws");
  const seen = [];
  s.onopen = () => seen.push("open");
  s.onmessage = (e) => seen.push(`message ${e.data}`);
  s.onclose = (e) => seen.push(`close ${e.code}`);
  events.__omniNet(1, "message", "early"); // nothing before open
  events.__omniNet(1, "open", null);
  assert.equal(s.readyState, 1);
  s.send("hello");
  assert.equal(s.bufferedAmount, 5);
  release();
  await sleep(0);
  assert.equal(s.bufferedAmount, 0);
  events.__omniNet(1, "message", "{\"type\":\"x\"}");
  events.__omniNet(1, "close", 4403);
  events.__omniNet(1, "message", "late");
  events.__omniNet(1, "close", 1000);
  assert.deepEqual(seen, ["open", "message {\"type\":\"x\"}", "close 4403"]);
  assert.equal(s.readyState, 3);
  assert.deepEqual(sent, ["hello"]);
});

test("the Keychain store keeps five names, as text, and a Keychain error stays an error", async () => {
  const store = keychainStore({ get: async () => { throw new Error("locked"); }, put: async () => {}, remove: async () => {} });
  await assert.rejects(store.get("keys"), /locked/, "never read as none, or new keys would replace the phone's identity");
  await assert.rejects(store.get("other"), /keeps nothing called other/);
  await assert.rejects(store.set("keys", {}), /never handed in/);
});

test("the iPhone bundle is the build less what only a server uses, and has the phone's page", () => {
  const out = spawnSync(process.execPath, [join(ROOT, "scripts", "build-ui.mjs"), "--phone"], { encoding: "utf8" });
  assert.equal(out.status, 0, out.stderr);
  const names = out.stdout.trim().split(/\r?\n/);
  const { files } = readBuild();
  assert.deepEqual(names, Object.keys(files).filter((n) => n !== "sw.js" && n !== "web.html").sort());
  for (const n of ["phone.html", "index.html"]) assert.ok(names.includes(n), n);
  for (const n of names) assert.match(n, /^[\w.-]+$/, "a plain name");
  assert.ok(!names.some((n) => /\.(br|gz)$/.test(n)));
  const page = readFileSync(join(ROOT, "dist", "ui", "phone.html"), "utf8");
  for (const [, name] of page.matchAll(/(?:href|src)="([^"]+)"/g)) assert.ok(names.includes(name), `phone.html names ${name}, which is bundled`);
  assert.doesNotMatch(page, /manifest|sw\.js|serviceWorker/, "no service worker or manifest in the app");
});

test("the hub and the desktop do not serve the phone's page", async () => {
  const fixture = await hubFixture();
  assert.equal((await fetch(`${fixture.url}/phone.html`)).status, 404);
});
