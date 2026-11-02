// The desktop's account: keys on disk, trust in the log, approvals, recovery, and channels against a real hub.
// The hub runs on an ephemeral loopback port. A wrapper around WebSocket plays the hacked hub by changing what crosses.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHub } from "../hub/server.mjs";
import { Account, keychainProtector, plainProtector, windowsProtector } from "../server/account.mjs";
import { channelClient, serveChannel } from "../server/channel-host.mjs";
import { createApp } from "../server/index.mjs";
import { FRAME, encodeFrame, encodeJson, encodeOuter } from "../ui/channel-frames.js";
import { fromB64, newDeviceKeys, recoveryKeysFrom, startHandshake, toB64 } from "../ui/account-core.js";
import { append, createLog, verifyLog } from "../ui/device-log.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (check, what = "condition", ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await check(); if (v) return v; await sleep(5); }
  assert.fail(`timed out waiting for ${what}`);
};
const DAY = 86_400_000;
const base = mkdtempSync(join(tmpdir(), "omni-account-"));
let serial = 0;
const freshDir = () => { const d = join(base, `t${++serial}`); mkdirSync(d, { recursive: true }); return d; };

const BOOTSTRAP = "bootstrap-token-0123456789";
const ORIGIN = "https://hub.test";
const PASSWORD = "correct horse battery";
const EMAIL = "me@example.com";

/** Fast, and reversible by nobody who only sees a file: the real ones have their own tests. */
const testProtector = {
  name: "test",
  async protect(bytes) { return Buffer.concat([Buffer.from("TEST"), Buffer.from(bytes).map((b) => b ^ 0x5a)]); },
  async unprotect(bytes) { return Buffer.from(bytes).subarray(4).map((b) => b ^ 0x5a); },
};
const quickKey = async (password, salt) => {
  const { createHash } = await import("node:crypto");
  return new Uint8Array(createHash("sha256").update(password).update(salt).digest());
};

const cleanups = [];
after(async () => { for (const c of cleanups.reverse()) await c(); });

async function hubFixture(options = {}) {
  const logged = [];
  const hub = await startHub({ dataDir: join(freshDir(), "hub"), bootstrapToken: BOOTSTRAP, origin: ORIGIN, log: (l) => logged.push(l), sweepMs: 50, ...options });
  cleanups.push(() => hub.close());
  return { hub, url: `http://127.0.0.1:${hub.port}`, logged };
}

/**
 * A WebSocket whose traffic the test can change. `tap.incoming(msg)` and `tap.outgoing(msg)` get each parsed message
 * and return it (changed or not), or null to drop it.
 */
function tappedSocket(tap) {
  return class TappedSocket {
    constructor(url) {
      this.real = new WebSocket(url);
      tap.sockets?.push(this);
      this.real.onopen = (e) => this.onopen?.(e);
      this.real.onclose = (e) => this.onclose?.(e);
      this.real.onerror = (e) => this.onerror?.(e);
      this.real.onmessage = (e) => {
        const message = tap.incoming ? tap.incoming(JSON.parse(e.data)) : JSON.parse(e.data);
        if (message) this.onmessage?.({ data: JSON.stringify(message) });
      };
    }
    get readyState() { return this.real.readyState; }
    get bufferedAmount() { return this.real.bufferedAmount; }
    send(text) {
      const message = tap.outgoing ? tap.outgoing(JSON.parse(text)) : JSON.parse(text);
      if (message) this.real.send(JSON.stringify(message));
    }
    close(...a) { this.real.close(...a); }
  };
}

function makeAccount(fixture, overrides = {}) {
  const logged = [];
  const dir = overrides.dir || join(freshDir(), "account");
  const tap = { sockets: [] };
  const account = new Account({
    dir, hubUrl: fixture.url, hubOrigin: ORIGIN, name: "Device", kind: "desktop", protector: testProtector, deriveLoginKey: quickKey, WebSocketImpl: tappedSocket(tap),
    log: (...a) => logged.push(a.join(" ")), reconnect: { minMs: 20, maxMs: 100 }, ...overrides,
  });
  account.tap = tap;
  account.logged = logged;
  account.alerts = [];
  account.on("alert", (a) => account.alerts.push(a));
  cleanups.push(() => account.stop());
  return account;
}

async function registered(fixture, overrides = {}) {
  const account = makeAccount(fixture, overrides);
  writeBootstrap(account.dir);
  const out = await account.register({ email: EMAIL, password: PASSWORD, name: overrides.name || "First" });
  await until(() => account.status().hub.connected, "the first device's socket");
  account.recoveryCode = out.recoveryCode;
  return account;
}
function writeBootstrap(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "bootstrap-token"), `${BOOTSTRAP}\n`);
}

/** The whole approval, as a person would do it on both screens. */
async function approveNewDevice(approver, newcomer, role = "full") {
  await until(() => newcomer.status().phase === "pending" && newcomer.status().hub.connected, "the newcomer's socket");
  const row = await until(() => approver.pendingSignIns().find((r) => r.signPub === newcomer.status().device.id), "the card");
  const review = await approver.review(row.id);
  const code = await until(() => newcomer.status().pending?.code, "the newcomer's code");
  assert.equal(review.code, code);
  newcomer.confirmCode(code);
  await approver.approve(row.id, { code: review.code, role });
  await until(() => newcomer.status().phase === "approved", "the newcomer approved");
  return row;
}

async function joined(fixture, approver, overrides = {}) {
  const account = makeAccount(fixture, overrides);
  await account.signIn({ email: EMAIL, password: PASSWORD, name: overrides.name || "Second" });
  await approveNewDevice(approver, account, overrides.role || (account.status().device.kind === "web" ? "client" : "full"));
  await until(() => account.status().logHead === approver.status().logHead, "the same log on both");
  return account;
}

/** Something the hub says, as if it came down this device's socket. */
const inject = (account, message) => account.tap.sockets.at(-1).onmessage({ data: JSON.stringify(message) });

/** A device's signing keys, read back from its folder: what a second log would be signed with. */
async function keysOf(account) {
  const record = JSON.parse(readFileSync(join(account.dir, "keys.json"), "utf8"));
  const secret = JSON.parse(Buffer.from(await testProtector.unprotect(Buffer.from(record.data, "base64"))).toString());
  const privateKey = await globalThis.crypto.subtle.importKey("pkcs8", fromB64(secret.sign), "Ed25519", false, ["sign"]);
  return { sign: { privateKey }, signPub: record.signPub, boxPub: record.boxPub };
}

const onDisk = (dir) => readdirSync(dir).filter((f) => statSync(join(dir, f)).isFile()).map((f) => readFileSync(join(dir, f)));

// ------------------------------------------------------------------------------- key storage

test("keys on disk: never plain, and the status names how they are protected", async () => {
  const fixture = await hubFixture();
  const account = await registered(fixture);
  const file = readFileSync(join(account.dir, "keys.json"), "utf8");
  const record = JSON.parse(file);
  assert.equal(record.protection, "test");
  assert.ok(record.signPub && record.boxPub);
  assert.deepEqual(Object.keys(record).sort(), ["boxPub", "data", "protection", "signPub", "v"]);
  assert.ok(Buffer.from(record.data, "base64").subarray(0, 4).equals(Buffer.from("TEST")));
  assert.equal(account.status().keyProtection.kind, "test");
  assert.equal(account.status().keyProtection.warning, null);
});

test("keys on Windows: DPAPI through PowerShell, for this user only", { skip: process.platform !== "win32" }, async () => {
  const protector = windowsProtector();
  const secret = Buffer.from("not to be seen in any argument");
  const blob = await protector.protect(secret);
  // The fixed header of every DPAPI blob (dwVersion, then the provider GUID df9d8cd0-1501-11d1-8c7a-00c04fc297eb).
  assert.equal(blob.subarray(0, 20).toString("hex"), "01000000d08c9ddf0115d1118c7a00c04fc297eb");
  assert.ok(!blob.includes(secret));
  assert.deepEqual(Buffer.from(await protector.unprotect(blob)), secret);
  await assert.rejects(protector.unprotect(Buffer.from("garbage")));
});

test("the account folder and files: mode 0600, and a restrictive ACL on Windows", async () => {
  const fixture = await hubFixture();
  const account = await registered(fixture, { protector: process.platform === "win32" ? windowsProtector() : testProtector });
  if (process.platform === "win32") {
    const record = JSON.parse(readFileSync(join(account.dir, "keys.json"), "utf8"));
    assert.equal(record.protection, "dpapi");
    assert.equal(Buffer.from(record.data, "base64").subarray(0, 20).toString("hex"), "01000000d08c9ddf0115d1118c7a00c04fc297eb");
    const icacls = (p) => execFileSync(join(process.env.SystemRoot, "System32", "icacls.exe"), [p], { encoding: "utf8" });
    for (const p of [account.dir, join(account.dir, "keys.json"), join(account.dir, "session.json"), join(account.dir, "log.json")]) {
      const out = icacls(p);
      assert.doesNotMatch(out, /Everyone|BUILTIN\\Users|Authenticated Users|Herkes|Kullan.c.lar/i, `${p}\n${out}`);
      assert.doesNotMatch(out, /BUILTIN\\Administrators|SYSTEM/i, `${p}: only this user\n${out}`);
      const grants = out.split(/\r?\n/).filter((l) => /:\(/.test(l));
      assert.equal(grants.length, 1, `${p}: one grant\n${out}`);
    }
    assert.equal(account.status().warnings.length, 0);
  } else {
    assert.equal(statSync(account.dir).mode & 0o777, 0o700);
    for (const f of ["keys.json", "session.json", "log.json", "state.json"]) assert.equal(statSync(join(account.dir, f)).mode & 0o777, 0o600, f);
  }
});

test("Keychain: the wrapping key goes in through stdin, never in an argument", async () => {
  const calls = [];
  const keychain = new Map();
  const run = async (cmd, args, input) => {
    calls.push({ cmd, args, input });
    if (args[0] === "find-generic-password") {
      if (!keychain.size) throw new Error("not found");
      return [...keychain.values()][0];
    }
    if (args[0] === "-i") {
      const m = /-w ([0-9a-f]+)/.exec(input);
      keychain.set("key", m[1]);
      return "";
    }
    throw new Error(`unexpected ${args[0]}`);
  };
  const protector = keychainProtector({ service: "omni-test", run });
  const secret = Buffer.from("the device's private keys");
  const blob = await protector.protect(secret);
  assert.equal(protector.name, "keychain");
  assert.ok(!blob.includes(secret));
  assert.deepEqual(Buffer.from(await protector.unprotect(blob)), secret);
  for (const c of calls) assert.ok(!c.args.join(" ").match(/[0-9a-f]{64}/), "no key on a command line");
  assert.ok(calls.some((c) => c.args[0] === "-i" && /[0-9a-f]{64}/.test(c.input)));
  assert.equal(calls.filter((c) => c.args[0] === "-i").length, 1, "one wrapping key, made once");
  const again = keychainProtector({ service: "omni-test", run });
  assert.deepEqual(Buffer.from(await again.unprotect(blob)), secret, "the key outlives the process");
  const tampered = Buffer.from(blob);
  tampered[tampered.length - 1] ^= 1;
  await assert.rejects(protector.unprotect(tampered));
});

test("with nothing but file permissions, status says so plainly", async () => {
  const fixture = await hubFixture();
  const account = await registered(fixture, { protector: plainProtector() });
  const { keyProtection, warnings } = account.status();
  assert.equal(keyProtection.kind, "none");
  assert.match(keyProtection.warning, /file permissions/i);
  assert.ok(warnings.some((w) => /file permissions/i.test(w)));
});

test("a key file that cannot be opened is an alert, and no new key is quietly made", async () => {
  const fixture = await hubFixture();
  const first = await registered(fixture);
  await first.stop();
  const before = readFileSync(join(first.dir, "keys.json"), "utf8");
  const broken = makeAccount(fixture, { dir: first.dir, protector: { ...testProtector, unprotect: async () => { throw new Error("no such key"); } } });
  await broken.start();
  assert.equal(broken.status().phase, "key-unavailable");
  assert.ok(broken.alerts.some((a) => a.kind === "key-unavailable"));
  assert.equal(readFileSync(join(first.dir, "keys.json"), "utf8"), before);
  await assert.rejects(broken.signIn({ email: EMAIL, password: PASSWORD }), /key/i);
});

test("a key survives a restart: same device, same log, connected again", async () => {
  const fixture = await hubFixture();
  const first = await registered(fixture);
  const id = first.status().device.id, head = first.status().logHead;
  await first.stop();
  const again = makeAccount(fixture, { dir: first.dir });
  await again.start();
  await until(() => again.status().hub.connected, "reconnected");
  assert.equal(again.status().device.id, id);
  assert.equal(again.status().logHead, head);
  assert.equal(again.status().phase, "approved");
  assert.equal(again.status().email, EMAIL);
});

// ------------------------------------------------------------------------------- registering

test("register: takes the bootstrap token from the folder, deletes it on success, shows the recovery code once", async () => {
  const fixture = await hubFixture();
  const account = makeAccount(fixture);
  writeBootstrap(account.dir);
  const out = await account.register({ email: EMAIL, password: PASSWORD, name: "First" });
  assert.match(out.recoveryCode, /^[0-9A-Z-]+$/);
  assert.equal(existsSync(join(account.dir, "bootstrap-token")), false);
  const status = account.status();
  assert.equal(status.phase, "approved");
  assert.equal(status.logVersion, 1);
  assert.equal(account.devices().length, 1);
  assert.equal(account.devices()[0].self, true);
  assert.equal(account.devices()[0].role, "full");
  const compact = out.recoveryCode.replace(/-/g, "");
  for (const content of onDisk(account.dir)) assert.ok(!content.includes(compact) && !content.includes(out.recoveryCode), "not stored");
  assert.ok(!JSON.stringify(status).includes(out.recoveryCode));
});

test("register: a failed registration keeps the token; a short password never reaches the hub", async () => {
  const fixture = await hubFixture();
  const account = makeAccount(fixture);
  await assert.rejects(account.register({ email: EMAIL, password: "short", name: "x" }), (e) => e.status === 400);
  mkdirSync(account.dir, { recursive: true });
  writeFileSync(join(account.dir, "bootstrap-token"), "wrong-token-0123456789");
  await assert.rejects(account.register({ email: EMAIL, password: PASSWORD, name: "x" }), (e) => e.status === 403 && /registration-closed/.test(e.code));
  assert.equal(existsSync(join(account.dir, "bootstrap-token")), true);
  assert.equal(account.status().phase, "signed-out");
});

test("register: if signing in right after fails, the recovery code still reaches the person", async () => {
  const fixture = await hubFixture();
  const account = makeAccount(fixture, { fetchImpl: async (url, init) => { if (String(url).endsWith("/api/login")) throw new Error("gone"); return fetch(url, init); } });
  writeBootstrap(account.dir);
  const out = await account.register({ email: EMAIL, password: PASSWORD, name: "First" });
  assert.ok(out.recoveryCode);
  assert.equal(out.signedIn, false);
  assert.equal(account.status().phase, "signed-out");
});

test("a hub on plain http is refused unless it is on this machine", () => {
  assert.throws(() => new Account({ dir: freshDir(), hubUrl: "http://tomcamp.tech", log() {} }), /https/);
  assert.throws(() => new Account({ dir: freshDir(), hubUrl: "ftp://x", log() {} }), /https/);
  assert.equal(new Account({ dir: freshDir(), hubUrl: "https://tomcamp.tech", log() {} }).status().hub.url, "https://tomcamp.tech");
  new Account({ dir: freshDir(), hubUrl: "http://127.0.0.1:1", log() {} });
});

test("sign-in with the real key derivation does not hold up the server", async () => {
  const fixture = await hubFixture();
  const account = makeAccount(fixture, { deriveLoginKey: undefined });
  writeBootstrap(account.dir);
  let worst = 0, last = Date.now();
  const beat = setInterval(() => { const t = Date.now(); worst = Math.max(worst, t - last); last = t; }, 5);
  const out = await account.register({ email: EMAIL, password: PASSWORD, name: "First" });
  clearInterval(beat);
  assert.ok(out.recoveryCode);
  assert.ok(worst < 400, `the event loop stalled ${worst} ms`);
  const second = makeAccount(fixture, { deriveLoginKey: undefined });
  await second.signIn({ email: EMAIL, password: PASSWORD, name: "Second" });
  assert.equal(second.status().phase, "pending", "the same key derivation reaches the same account");
  const wrong = makeAccount(fixture, { deriveLoginKey: undefined });
  await assert.rejects(wrong.signIn({ email: EMAIL, password: `${PASSWORD}x`, name: "Third" }), (e) => e.status === 401);
});

test("sign-in passes the bootstrap token along when it is there, and keeps the file", async () => {
  const fixture = await hubFixture();
  const first = await registered(fixture);
  assert.ok(first);
  const seen = [];
  const account = makeAccount(fixture, { fetchImpl: async (url, init) => { seen.push({ url: String(url), body: JSON.parse(init.body) }); return fetch(url, init); } });
  writeBootstrap(account.dir);
  await account.signIn({ email: EMAIL, password: PASSWORD, name: "Second" });
  const login = seen.find((s) => s.url.endsWith("/api/login"));
  assert.equal(login.body.bootstrapToken, BOOTSTRAP);
  assert.equal(existsSync(join(account.dir, "bootstrap-token")), true);
});

// ------------------------------------------------------------------------------- approving

test("approval: the whole exchange, and the add entry comes only after the person confirmed the code", async () => {
  const fixture = await hubFixture();
  const approver = await registered(fixture);
  const approvals = [];
  approver.on("approval", (rows) => approvals.push(rows));
  const newcomer = makeAccount(fixture);
  await newcomer.signIn({ email: EMAIL, password: PASSWORD, name: "Laptop" });
  assert.equal(newcomer.status().phase, "pending");
  const row = await until(() => approver.pendingSignIns().find((r) => r.name === "Laptop"), "the card");
  assert.equal(row.kind, "desktop");
  assert.ok(approvals.length > 0, "the event fired");

  await assert.rejects(approver.approve(row.id, { code: "000000" }), (e) => e.status === 409, "no approval before a review");

  const review = await approver.review(row.id);
  assert.match(review.code, /^\d{6}$/);
  assert.equal(review.name, "Laptop");
  assert.equal(review.role, undefined, "the role is not the new device's to offer");
  assert.equal(review.kind, "desktop");
  assert.equal(approver.status().logVersion, 1, "nothing appended by a review");
  const code = await until(() => newcomer.status().pending?.code, "the code on the new device");
  assert.equal(code, review.code);

  const wrong = review.code === "000000" ? "000001" : "000000";
  await assert.rejects(approver.approve(row.id, { code: wrong }), (e) => e.status === 400);
  await assert.rejects(approver.approve(row.id, {}), (e) => e.status === 400);
  assert.equal(approver.status().logVersion, 1, "nothing appended on a wrong code");

  await assert.rejects(approver.approve(row.id, { code: review.code, role: "owner" }), (e) => e.status === 400);
  await approver.approve(row.id, { code: review.code, role: "full" });
  assert.equal(approver.status().logVersion, 2);
  const added = approver.devices().find((d) => d.name === "Laptop");
  assert.equal(added.role, "full");
  assert.equal(added.id, newcomer.status().device.id);
  assert.equal(newcomer.status().phase, "pending", "still waits for its own person");

  assert.throws(() => newcomer.confirmCode("123"), (e) => e.status === 400);
  newcomer.confirmCode(code);
  await until(() => newcomer.status().phase === "approved", "the newcomer approved");
  assert.equal(newcomer.status().logHead, approver.status().logHead);
  assert.equal(newcomer.status().pending, null);
});

test("approval: the role is the approver's choice, client unless they say otherwise, whatever the device calls itself", async () => {
  const fixture = await hubFixture();
  const approver = await registered(fixture);
  const liar = makeAccount(fixture, { kind: "desktop", name: "Claims desktop" });
  await liar.signIn({ email: EMAIL, password: PASSWORD, name: "Claims desktop" });
  const row = await until(() => approver.pendingSignIns().find((r) => r.name === "Claims desktop"), "the card");
  const review = await approver.review(row.id);
  const code = await until(() => liar.status().pending?.code, "the code");
  liar.confirmCode(code);
  await approver.approve(row.id, { code: review.code });
  assert.equal(approver.devices().find((d) => d.id === liar.status().device.id).role, "client");
  await until(() => liar.status().phase === "approved", "approved");
  assert.equal(liar.status().device.role, "client");
  const chosen = await joined(fixture, approver, { kind: "web", name: "Web", role: "full" });
  assert.equal(approver.devices().find((d) => d.id === chosen.status().device.id).role, "full", "the person's call");
});

test("approval: a client device cannot approve, remove or change the password", async () => {
  const fixture = await hubFixture();
  const approver = await registered(fixture);
  const web = await joined(fixture, approver, { kind: "web", name: "Web page" });
  await assert.rejects(web.review("anything"), (e) => e.status === 403);
  await assert.rejects(web.approve("anything", { code: "123456" }), (e) => e.status === 403);
  await assert.rejects(web.deny("anything"), (e) => e.status === 403);
  await assert.rejects(web.remove(approver.status().device.id), (e) => e.status === 403);
  await assert.rejects(web.changePassword({ current: PASSWORD, next: "another long password" }), (e) => e.status === 403);
});

test("approval: one review at a time; deny ends the attempt and the device does not retry", async () => {
  const fixture = await hubFixture();
  const approver = await registered(fixture);
  const second = await joined(fixture, approver);
  const a = makeAccount(fixture), b = makeAccount(fixture);
  await a.signIn({ email: EMAIL, password: PASSWORD, name: "A" });
  await b.signIn({ email: EMAIL, password: PASSWORD, name: "B" });
  const rowA = await until(() => approver.pendingSignIns().find((r) => r.name === "A"), "card A");
  const rowB = await until(() => approver.pendingSignIns().find((r) => r.name === "B"), "card B");
  await approver.review(rowA.id);
  await assert.rejects(approver.review(rowB.id), (e) => e.status === 409);
  await until(() => second.pendingSignIns().find((r) => r.id === rowA.id)?.reviewedBy === "First", "the other card says who is reviewing");
  await approver.deny(rowA.id);
  await until(() => a.status().phase === "denied", "denied");
  assert.equal(approver.status().review, null);
  await sleep(150);
  assert.equal(a.status().hub.connected, false);
  assert.equal(a.status().phase, "denied", "no retry");
  await approver.review(rowB.id);
});

test("approval: on log.conflict the approver refreshes, tells the person, and must review again", async () => {
  const fixture = await hubFixture();
  const approver = await registered(fixture);
  const other = await joined(fixture, approver, { name: "Other" });
  const newcomer = makeAccount(fixture);
  await newcomer.signIn({ email: EMAIL, password: PASSWORD, name: "Laptop" });
  const row = await until(() => approver.pendingSignIns().find((r) => r.name === "Laptop"), "the card");
  const review = await approver.review(row.id);
  // A device changes the log after the code was computed, and this approver has not heard yet.
  let hold = true;
  const web = makeAccount(fixture, { kind: "web" });
  await web.signIn({ email: EMAIL, password: PASSWORD, name: "Web" });
  const webRow = await until(() => other.pendingSignIns().find((r) => r.name === "Web"), "the second card");
  const { tap } = approver;
  tap.incoming = (m) => (hold && m.type === "log.updated" ? null : m);
  await other.review(webRow.id);
  await other.approve(webRow.id, { code: other.status().review.code, role: "client" });
  await assert.rejects(approver.approve(row.id, { code: review.code }), (e) => e.status === 409 && e.code === "log-conflict" && /changed/.test(e.message));
  hold = false;
  assert.equal(approver.status().logHead, other.status().logHead, "refreshed");
  assert.equal(approver.status().review, null, "the code was for the old list");
  assert.ok(!approver.devices().some((d) => d.name === "Laptop"));
  // The new device does not start over by itself: its person says the old code is gone.
  newcomer.restartExchange();
  const again = await approver.review(row.id);
  const code = await until(() => newcomer.status().pending?.code === again.code && again.code, "the new code");
  newcomer.confirmCode(code);
  await approver.approve(row.id, { code, role: "full" });
  await until(() => newcomer.status().phase === "approved", "approved after the second review");
});

// A fake account the hub could hand a new device: it knows the device's public key, so it can list it.
async function fakeAccountAdding(newcomer) {
  const attacker = { ...(await newDeviceKeys({ extractable: true })), name: "Attacker", kind: "desktop" };
  const recovery = await newDeviceKeys({ extractable: true });
  const entries = await createLog({ device: attacker, recoveryPub: recovery.signPub });
  const { head } = await verifyLog(entries, { now: Date.now() });
  return { attacker, entries, head, withDevice: () => append(entries, { type: "add", name: "Victim", kind: "desktop", role: "full", signPub: newcomer.status().device.id, boxPub: toB64(new Uint8Array(32).fill(9)) }, attacker) };
}

test("hacked hub: a fake approver and fake log, with no confirmation from the person, gets nowhere", async () => {
  const fixture = await hubFixture();
  await registered(fixture);
  const newcomer = makeAccount(fixture);
  const { tap } = newcomer;
  await newcomer.signIn({ email: EMAIL, password: PASSWORD, name: "Laptop" });
  await until(() => newcomer.status().hub.connected, "connected");
  const fake = await fakeAccountAdding(newcomer);
  const entries = await fake.withDevice();
  // The hub says approved and answers log.get with its own account.
  tap.incoming = (m) => (m.type === "log" ? { type: "log", entries, head: "x", version: entries.length } : m);
  inject(newcomer, { type: "session.approved" });
  await sleep(150);
  assert.equal(newcomer.status().phase, "pending");
  assert.ok(newcomer.alerts.some((a) => a.kind === "fake-log"), "and it is visible");
  assert.equal(newcomer.status().logHead, null);
});

test("hacked hub: a log that does not follow the head in the code is refused, and so is one signed by anyone else", async () => {
  const fixture = await hubFixture();
  const approver = await registered(fixture);
  const newcomer = makeAccount(fixture);
  const { tap } = newcomer;
  await newcomer.signIn({ email: EMAIL, password: PASSWORD, name: "Laptop" });
  const row = await until(() => approver.pendingSignIns().find((r) => r.name === "Laptop"), "the card");
  const review = await approver.review(row.id);
  const code = await until(() => newcomer.status().pending?.code, "the code");
  newcomer.confirmCode(code);
  assert.equal(code, review.code);
  // The real approval goes through, but this device is shown someone else's account.
  const fake = await fakeAccountAdding(newcomer);
  const entries = await fake.withDevice();
  tap.incoming = (m) => (m.type === "log" ? { type: "log", entries, head: "x", version: entries.length } : m);
  await approver.approve(row.id, { code });
  await until(() => newcomer.alerts.some((a) => a.kind === "fake-log"), "the alert");
  assert.equal(newcomer.status().phase, "pending");
  assert.equal(newcomer.status().logHead, null);
});

test("hacked hub: a log signed by the real approver that does not follow the code's head is refused", async () => {
  const fixture = await hubFixture();
  const approver = await registered(fixture);
  const newcomer = makeAccount(fixture);
  const { tap } = newcomer;
  await newcomer.signIn({ email: EMAIL, password: PASSWORD, name: "Laptop" });
  const row = await until(() => approver.pendingSignIns().find((r) => r.name === "Laptop"), "the card");
  await approver.review(row.id);
  newcomer.confirmCode(await until(() => newcomer.status().pending?.code, "the code"));
  // Another entry slipped in before the add, as if taken from a stolen moment of the approver's key.
  const keys = await keysOf(approver);
  const other = await newDeviceKeys({ extractable: true });
  const entries = JSON.parse(readFileSync(join(approver.dir, "log.json"), "utf8"));
  const between = await append(entries, { type: "add", name: "Slipped in", kind: "desktop", role: "full", signPub: other.signPub, boxPub: other.boxPub }, keys);
  const forged = await append(between, { type: "add", name: "Laptop", kind: "desktop", role: "full", signPub: newcomer.status().device.id, boxPub: toB64(new Uint8Array(32).fill(7)) }, keys);
  // The honest hub would refuse a log.get from a pending session: this one answers with the forgery.
  tap.incoming = (m) => (m.type === "error" && m.for === "log.get" ? { type: "log", entries: forged, head: "x", version: forged.length } : m);
  inject(newcomer, { type: "session.approved" });
  await until(() => newcomer.alerts.some((a) => a.kind === "fake-log"), "the alert");
  assert.equal(newcomer.status().phase, "pending");
});

test("hacked hub: an add right after the head, signed by a device other than the one in the code, is refused", async () => {
  const fixture = await hubFixture();
  const approver = await registered(fixture);
  const other = await joined(fixture, approver, { name: "Other" });
  const newcomer = makeAccount(fixture);
  await newcomer.signIn({ email: EMAIL, password: PASSWORD, name: "Laptop" });
  const row = await until(() => approver.pendingSignIns().find((r) => r.name === "Laptop"), "the card");
  await approver.review(row.id);
  newcomer.confirmCode(await until(() => newcomer.status().pending?.code, "the code"));
  const entries = JSON.parse(readFileSync(join(approver.dir, "log.json"), "utf8"));
  const forged = await append(entries, { type: "add", name: "Laptop", kind: "desktop", role: "full", signPub: newcomer.status().device.id, boxPub: toB64(new Uint8Array(32).fill(7)) }, await keysOf(other));
  newcomer.tap.incoming = (m) => (m.type === "error" && m.for === "log.get" ? { type: "log", entries: forged, head: "x", version: forged.length } : m);
  inject(newcomer, { type: "session.approved" });
  await until(() => newcomer.alerts.some((a) => a.kind === "fake-log"), "the alert");
  assert.equal(newcomer.status().phase, "pending");
});

test("hacked hub: a swapped approver key is caught by the signed details, before any reveal", async () => {
  const fixture = await hubFixture();
  const approver = await registered(fixture);
  const newcomer = makeAccount(fixture);
  const { tap } = newcomer;
  await newcomer.signIn({ email: EMAIL, password: PASSWORD, name: "Laptop" });
  await until(() => newcomer.status().hub.connected, "connected");
  const stranger = await newDeviceKeys({ extractable: true });
  // Everything from the approver now appears to come from the hub's own key.
  tap.incoming = (m) => (m.type === "approval.msg" ? { ...m, from: stranger.signPub } : m);
  tap.outgoing = (m) => (m.type === "approval.msg" ? { ...m, to: approver.status().device.id } : m);
  const row = await until(() => approver.pendingSignIns().find((r) => r.name === "Laptop"), "the card");
  await assert.rejects(approver.review(row.id), (e) => e.status === 502 && /signature/.test(e.message));
  assert.equal(newcomer.status().pending.code, null);
});

test("hacked hub: a reveal that does not match the commit ends that exchange, and a person is never shown its code", async () => {
  const fixture = await hubFixture();
  const approver = await registered(fixture);
  const newcomer = makeAccount(fixture);
  const { tap } = newcomer;
  await newcomer.signIn({ email: EMAIL, password: PASSWORD, name: "Laptop" });
  await until(() => newcomer.status().hub.connected, "connected");
  tap.incoming = (m) => {
    if (m.type !== "approval.msg") return m;
    const o = JSON.parse(m.opaque);
    if (o.t === "reveal") o.random = toB64(new Uint8Array(32).fill(1));
    return { ...m, opaque: JSON.stringify(o) };
  };
  const row = await until(() => approver.pendingSignIns().find((r) => r.name === "Laptop"), "the card");
  await approver.review(row.id);
  await until(() => newcomer.status().pending?.attempts >= 1, "the attempt was counted");
  await sleep(50);
  assert.equal(newcomer.status().pending.code, null);
  assert.equal(newcomer.status().pending.failed, true);
  assert.ok(newcomer.alerts.some((a) => a.kind === "approval-failed"));
  // The hub tries again: nothing happens until the person asks.
  const stranger = await newDeviceKeys({ extractable: true });
  const commit = toB64(new Uint8Array(32).fill(4));
  inject(newcomer, { type: "approval.msg", from: stranger.signPub, opaque: JSON.stringify({ v: 1, t: "commit", commit, logHead: "head" }) });
  await sleep(50);
  assert.equal(newcomer.status().pending.attempts, 1);
  newcomer.restartExchange();
  assert.equal(newcomer.status().pending.failed, false);
  inject(newcomer, { type: "approval.msg", from: stranger.signPub, opaque: JSON.stringify({ v: 1, t: "commit", commit, logHead: "head" }) });
  await until(() => newcomer.status().pending.attempts === 2, "the person's new attempt");
});

test("hacked hub: a claim signed by no one is refused by the approver", async () => {
  const fixture = await hubFixture();
  const approver = await registered(fixture);
  const { tap } = approver;
  const newcomer = makeAccount(fixture);
  await newcomer.signIn({ email: EMAIL, password: PASSWORD, name: "Laptop" });
  tap.incoming = (m) => {
    if (m.type !== "approval.msg") return m;
    const o = JSON.parse(m.opaque);
    if (o.t === "random") o.claim.name = "Renamed by the hub";
    return { ...m, opaque: JSON.stringify(o) };
  };
  const row = await until(() => approver.pendingSignIns().find((r) => r.name === "Laptop"), "the card");
  await assert.rejects(approver.review(row.id), (e) => e.status === 502 && /signature/.test(e.message));
  assert.equal(approver.status().review, null);
});

test("hacked hub: more commits while one exchange runs are ignored, and cannot replace a confirmed code", async () => {
  const fixture = await hubFixture();
  const approver = await registered(fixture);
  const newcomer = makeAccount(fixture);
  await newcomer.signIn({ email: EMAIL, password: PASSWORD, name: "Laptop" });
  const row = await until(() => approver.pendingSignIns().find((r) => r.name === "Laptop"), "the card");
  const review = await approver.review(row.id);
  const code = await until(() => newcomer.status().pending?.code, "the code");
  newcomer.confirmCode(code);
  const stranger = await newDeviceKeys({ extractable: true });
  const commit = toB64(new Uint8Array(32).fill(4));
  for (let i = 0; i < 6; i++) inject(newcomer, { type: "approval.msg", from: stranger.signPub, opaque: JSON.stringify({ v: 1, t: "commit", commit, logHead: "head" }) });
  await sleep(50);
  assert.equal(newcomer.status().pending.attempts, 1);
  assert.equal(newcomer.status().pending.code, code);
  assert.equal(newcomer.status().pending.confirmed, true);
  await approver.approve(row.id, { code: review.code, role: "full" });
  await until(() => newcomer.status().phase === "approved", "the real approval still lands");
});

test("a new device adopts nothing before its person confirms, even once the hub says approved", async () => {
  const fixture = await hubFixture();
  const approver = await registered(fixture);
  const newcomer = makeAccount(fixture);
  const asked = [];
  newcomer.tap.outgoing = (m) => { asked.push(m.type); return m; };
  await newcomer.signIn({ email: EMAIL, password: PASSWORD, name: "Laptop" });
  const row = await until(() => approver.pendingSignIns().find((r) => r.name === "Laptop"), "the card");
  const review = await approver.review(row.id);
  const code = await until(() => newcomer.status().pending?.code, "the code");
  await approver.approve(row.id, { code: review.code, role: "full" });
  await until(() => newcomer.status().pending.approvedByHub, "the hub's word");
  await sleep(50);
  assert.equal(newcomer.status().logHead, null);
  assert.ok(!asked.includes("log.get"), "does not even fetch it");
  newcomer.confirmCode(code);
  await until(() => newcomer.status().phase === "approved", "now it does");
});

// ------------------------------------------------------------------------------- the log on disk

async function pairWithTap(fixture) {
  const first = await registered(fixture, { name: "First" });
  const second = await joined(fixture, first, { name: "Second" });
  return { first, second, tap: second.tap };
}

test("hacked hub: a shorter log is refused, the longest stays on disk, and it says rollback", async () => {
  const fixture = await hubFixture();
  const { first, second, tap } = await pairWithTap(fixture);
  const old = JSON.parse(readFileSync(join(first.dir, "log.json"), "utf8")).slice(0, 1);
  const before = readFileSync(join(second.dir, "log.json"), "utf8");
  tap.incoming = (m) => (m.type === "log" ? { ...m, entries: old, head: "old", version: 1 } : m);
  inject(second, { type: "log.updated", head: "old", version: 1 });
  await until(() => second.alerts.some((a) => a.kind === "rollback"), "the alert");
  assert.match(second.alerts.find((a) => a.kind === "rollback").message, /older|shorter/i);
  assert.equal(readFileSync(join(second.dir, "log.json"), "utf8"), before);
  assert.equal(second.status().logVersion, 2);
});

test("hacked hub: two different entries at one position is a fork, refused and named", async () => {
  const fixture = await hubFixture();
  const { first, second, tap } = await pairWithTap(fixture);
  // A second add by a real device at the same position, as a hub showing two devices two logs would have.
  const entries = JSON.parse(readFileSync(join(first.dir, "log.json"), "utf8"));
  const keys = await keysOf(first);
  const other = await newDeviceKeys({ extractable: true });
  const forked = await append(entries.slice(0, 1), { type: "add", name: "Fork", kind: "desktop", role: "full", signPub: other.signPub, boxPub: other.boxPub }, keys);
  const before = readFileSync(join(second.dir, "log.json"), "utf8");
  tap.incoming = (m) => (m.type === "log" ? { ...m, entries: forked, head: "fork", version: forked.length } : m);
  inject(second, { type: "log.updated", head: "fork", version: forked.length });
  await until(() => second.alerts.some((a) => a.kind === "fork"), "the alert");
  assert.equal(readFileSync(join(second.dir, "log.json"), "utf8"), before);
  assert.ok(!second.devices().some((d) => d.name === "Fork"));
});

test("hacked hub: another account's log, and garbage, are refused and named", async () => {
  const fixture = await hubFixture();
  const { second, tap } = await pairWithTap(fixture);
  const before = readFileSync(join(second.dir, "log.json"), "utf8");
  const stranger = { ...(await newDeviceKeys({ extractable: true })), name: "S", kind: "desktop" };
  const recovery = await newDeviceKeys({ extractable: true });
  const theirs = await createLog({ device: stranger, recoveryPub: recovery.signPub });
  tap.incoming = (m) => (m.type === "log" ? { ...m, entries: theirs, head: "t", version: 1 } : m);
  inject(second, { type: "log.updated", head: "t", version: 1 });
  await until(() => second.alerts.some((a) => a.kind === "different-account"), "different account");
  tap.incoming = (m) => (m.type === "log" ? { ...m, entries: [{ nonsense: 1 }], head: "g", version: 1 } : m);
  inject(second, { type: "log.updated", head: "g", version: 1 });
  await until(() => second.alerts.some((a) => a.kind === "bad-log"), "garbage");
  assert.equal(readFileSync(join(second.dir, "log.json"), "utf8"), before);
});

test("a longer valid log is adopted, kept on disk and announced", async () => {
  const fixture = await hubFixture();
  const { first, second } = await pairWithTap(fixture);
  const devicesEvents = [];
  second.on("devices", (d) => devicesEvents.push(d));
  const third = await joined(fixture, first, { name: "Third" });
  await until(() => second.status().logHead === first.status().logHead, "adopted");
  assert.ok(second.devices().some((d) => d.id === third.status().device.id));
  assert.ok(devicesEvents.length > 0);
  assert.equal(JSON.parse(readFileSync(join(second.dir, "log.json"), "utf8")).length, 3);
});

test("a tampered log file on disk is not believed", async () => {
  const fixture = await hubFixture();
  const { first, second } = await pairWithTap(fixture);
  assert.ok(first);
  await second.stop();
  const entries = JSON.parse(readFileSync(join(second.dir, "log.json"), "utf8"));
  entries[1].body.name = "Renamed";
  writeFileSync(join(second.dir, "log.json"), JSON.stringify(entries));
  const again = makeAccount(fixture, { dir: second.dir });
  await again.start();
  assert.equal(again.status().phase, "log-damaged");
  assert.ok(again.alerts.some((a) => a.kind === "bad-log"));
  await assert.rejects(again.openChannel(first.status().device.id), /log/i);
});

test("the head comparison comes first: an unchanged log is not replayed", async () => {
  const fixture = await hubFixture();
  const first = await registered(fixture, { name: "First" });
  let replays = 0;
  const second = await joined(fixture, first, { name: "Second", verifyLogImpl: (...a) => { replays++; return verifyLog(...a); } });
  await sleep(50);
  replays = 0;
  const head = second.status().logHead;
  inject(second, { type: "log.updated", head, version: second.status().logVersion });
  await second.syncLog();
  await second.syncLog();
  assert.equal(replays, 0);
});

// ------------------------------------------------------------------------------- channels

/** Two approved devices, with the host end serving a tiny handle. */
async function connected(fixture, overrides = {}) {
  const { first, second, tap } = await pairWithTap(fixture);
  const requests = [];
  const handle = (req, res) => { requests.push(req); res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ path: req.url, who: req.omniChannel.deviceName })); };
  first.on("channel", (channel) => serveChannel(channel, overrides.handle || handle, { device: { id: channel.peer.id, name: channel.peer.name, role: channel.peer.role }, audit: (e) => first.audit(e) }));
  return { first, second, tap, requests };
}

test("a channel: encrypted, reaches handle with the device's name, and the hub sees only opaque frames", async () => {
  const fixture = await hubFixture();
  const { first, second, tap, requests } = await connected(fixture);
  const seen = [];
  tap.outgoing = (m) => { if (m.type === "channel.msg") seen.push(m.opaque); return m; };
  const channel = await second.openChannel(first.status().device.id);
  assert.equal(channel.peer.name, "First");
  const r = await channelClient(channel).request({ method: "POST", path: "/api/secret-path", body: Buffer.from("secret request body") });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { path: "/api/secret-path", who: "Second" });
  assert.equal(requests.length, 1);
  assert.ok(seen.length >= 3);
  assert.ok(!seen.join("").includes("secret-path"));
  assert.ok(!Buffer.from(seen.join(""), "utf8").includes("secret request body"));
  for (const opaque of seen) {
    const outer = JSON.parse(opaque);
    if (outer.d) assert.ok(!Buffer.from(outer.d, "base64").includes("secret"), "not in the frame either");
  }
  channel.close();
});

test("audit: a line per request, in the account folder, no bodies, and readable for the UI", async () => {
  const fixture = await hubFixture();
  const { first, second } = await connected(fixture);
  const channel = await second.openChannel(first.status().device.id);
  const r = await channelClient(channel).request({ method: "POST", path: "/api/pi/prompt?q=private", body: Buffer.from("private body text") });
  await r.text();
  const lines = await until(async () => { const l = await first.auditLines(10); return l.length ? l : null; }, "the audit line");
  assert.deepEqual(Object.keys(lines[0]).sort(), ["at", "device", "deviceName", "method", "path"]);
  assert.equal(lines[0].device, second.status().device.id);
  assert.equal(lines[0].deviceName, "Second");
  assert.equal(lines[0].method, "POST");
  assert.equal(lines[0].path, "/api/pi/prompt");
  const file = readFileSync(join(first.dir, "audit.jsonl"), "utf8");
  assert.ok(!file.includes("private"));
  channel.close();
});

test("audit: a size cap and rotation, with the newest lines first in what is read back", async () => {
  const fixture = await hubFixture();
  const account = makeAccount(fixture, { limits: { auditMaxBytes: 2000 } });
  for (let i = 0; i < 100; i++) account.audit({ at: i, device: "d", deviceName: "n", method: "GET", path: `/p${i}` });
  await account.auditFlush();
  assert.ok(statSync(join(account.dir, "audit.jsonl")).size <= 2000);
  assert.ok(existsSync(join(account.dir, "audit.1.jsonl")));
  assert.ok(statSync(join(account.dir, "audit.1.jsonl")).size <= 2000);
  const lines = await account.auditLines(5);
  assert.deepEqual(lines.map((l) => l.path), ["/p99", "/p98", "/p97", "/p96", "/p95"]);
  const many = await account.auditLines(1000);
  assert.ok(many.length > 20, "both files are read");
  assert.ok(many.length <= 100);
});

test("a device that is not on the log is refused, and told so", async () => {
  const fixture = await hubFixture();
  const { first, second } = await connected(fixture);
  const channels = [];
  first.on("channel", (c) => channels.push(c));
  const stranger = await newDeviceKeys({ extractable: true });
  inject(first, { type: "channel.msg", from: stranger.signPub, opaque: JSON.stringify({ v: 1, c: toB64(new Uint8Array(16).fill(1)), t: "hello", eph: stranger.boxPub, logHead: "x" }) });
  await sleep(100);
  assert.equal(channels.length, 0);
  assert.equal(first.status().channels.length, 0);
  assert.ok(second);
});

test("Allow web page access: off refuses client devices at handshake and closes those already open; full devices are untouched", async () => {
  const fixture = await hubFixture();
  const { first, second } = await connected(fixture);
  const web = await joined(fixture, first, { kind: "web", name: "Web page" });
  assert.equal(first.settings().allowWebAccess, true, "on by default");

  const open = await web.openChannel(first.status().device.id);
  const closed = new Promise((r) => open.once("close", r));
  await first.setSettings({ allowWebAccess: false });
  assert.match(await closed, /refused|web/i);
  assert.equal(JSON.parse(readFileSync(join(first.dir, "settings.json"), "utf8")).allowWebAccess, false);

  await assert.rejects(web.openChannel(first.status().device.id), /web page access/i);
  const fromDesktop = await second.openChannel(first.status().device.id);
  fromDesktop.close();

  await first.setSettings({ allowWebAccess: true });
  (await web.openChannel(first.status().device.id)).close();

  await first.setSettings({ allowWebAccess: false });
  const restarted = makeAccount(fixture, { dir: first.dir });
  await restarted.start();
  assert.equal(restarted.settings().allowWebAccess, false, "kept across a restart");
});

test("a removed device's open channel is closed at once, with no new request needed", async () => {
  const fixture = await hubFixture();
  const { first, second } = await connected(fixture);
  const channel = await second.openChannel(first.status().device.id);
  assert.equal(first.status().channels.length, 1);
  const hostChannelClosed = new Promise((r) => first.once("channel-closed", r));
  // Not by the hub's word that the peer has gone: by this machine's own log.
  first.tap.incoming = (m) => (m.type === "presence" ? null : m);
  await first.remove(second.status().device.id);
  await hostChannelClosed;
  assert.equal(first.status().channels.length, 0);
  await until(() => channel.closed, "the client end hears it");
  await until(() => second.status().phase === "removed" || !second.status().hub.connected, "the removed device is out");
  await assert.rejects(second.openChannel(first.status().device.id));
});

test("a removal learned from another device closes this machine's channel too", async () => {
  const fixture = await hubFixture();
  const { first, second } = await connected(fixture);
  const third = await joined(fixture, first, { name: "Third" });
  await until(() => second.status().logHead === first.status().logHead, "second caught up");
  const channel = await second.openChannel(first.status().device.id);
  await third.remove(second.status().device.id);
  await until(() => first.status().channels.length === 0, "the host cut it off");
  await until(() => channel.closed, "the client end hears it");
});

test("a client's channel closes when its 30 days run out, without waiting for a request", async () => {
  const fixture = await hubFixture();
  let clock = Date.now();
  const now = () => clock;
  const first = await registered(fixture, { now });
  const web = await joined(fixture, first, { kind: "web", name: "Web page" });
  const webId = web.status().device.id;
  // A window that ends in a moment: the approver's clock wrote addedAt, so this device's clock moves on to just before the end.
  const added = first.devices().find((d) => d.id === webId).addedAt;
  clock = added + 30 * DAY - 150;
  first.on("channel", (channel) => serveChannel(channel, (req, res) => res.end("x"), { device: channel.peer, audit() {} }));
  const opened = await web.openChannel(first.status().device.id);
  assert.equal(first.status().channels.length, 1);
  assert.ok(opened);
  // The timer was set for 150 ms from now by the clock; the clock moves too, as it would.
  clock = added + 30 * DAY;
  await until(() => first.status().channels.length === 0, "closed by its own timer", 2000);
  await assert.rejects(web.openChannel(first.status().device.id), /refused|not on|expired/i, "and it is not allowed back");
});

test("signing out closes every channel and stops the hub connection", async () => {
  const fixture = await hubFixture();
  const { first, second } = await connected(fixture);
  const channel = await second.openChannel(first.status().device.id);
  await first.signOut();
  assert.equal(first.status().phase, "signed-out");
  assert.equal(first.status().hub.connected, false);
  assert.equal(first.status().channels.length, 0);
  await until(() => channel.closed, "the far end hears it");
  assert.ok(!existsSync(join(first.dir, "session.json")));
  assert.ok(existsSync(join(first.dir, "keys.json")), "the device keeps its keys, so it signs back in as itself");
  await first.signIn({ email: EMAIL, password: PASSWORD });
  await until(() => first.status().phase === "approved" && first.status().hub.connected, "back");
  await first.signOut({ forget: true });
  assert.ok(!existsSync(join(first.dir, "keys.json")));
  assert.ok(!existsSync(join(first.dir, "log.json")));
});

test("a failed frame kills the channel, and it is surfaced, not silently retried", async () => {
  const fixture = await hubFixture();
  const { first, second, tap } = await connected(fixture);
  const channel = await second.openChannel(first.status().device.id);
  const closed = new Promise((r) => channel.once("close", r));
  // Tamper with the next frame from this device.
  tap.outgoing = (m) => {
    if (m.type !== "channel.msg") return m;
    const outer = JSON.parse(m.opaque);
    if (!outer.d) return m;
    const bytes = Buffer.from(outer.d, "base64");
    bytes[bytes.length - 1] ^= 1;
    return { ...m, opaque: JSON.stringify({ ...outer, d: bytes.toString("base64") }) };
  };
  const refused = assert.rejects(channelClient(channel).request({ method: "GET", path: "/x" }));
  await until(() => first.alerts.some((a) => a.kind === "channel-failure"), "the host's alert");
  assert.equal(first.status().channels.length, 0);
  await refused;
  await closed;
  tap.outgoing = undefined;
  const fresh = await second.openChannel(first.status().device.id);
  const r = await channelClient(fresh).request({ method: "GET", path: "/y" });
  assert.equal(r.status, 200, "a new channel works");
  await r.text();
  fresh.close();
});

test("a request sent before the READY frame kills the channel, and never runs", async () => {
  const fixture = await hubFixture();
  const { first, second, requests } = await connected(fixture);
  const firstId = first.status().device.id;
  const keys = await keysOf(second);
  const c = toB64(new Uint8Array(16).fill(9));
  const send = (fields) => second.tap.sockets.at(-1).real.send(JSON.stringify({ type: "channel.msg", to: firstId, opaque: encodeOuter({ c, ...fields }) }));
  const hs = await startHandshake({ device: keys, peerPub: firstId, logHead: second.status().logHead });
  let core;
  let sentEarly = false;
  let order = Promise.resolve();
  second.tap.incoming = (m) => {
    if (m.type !== "channel.msg") return m;
    const outer = JSON.parse(m.opaque);
    if (outer.c !== c) return m;
    order = order.then(async () => {
      if (outer.t === "hello") {
        core = await hs.finish({ eph: outer.eph, logHead: outer.logHead });
        send({ t: "proof", proof: core.proof });
      } else if (outer.t === "proof") {
        await core.confirm(outer.proof);
        const frame = await core.seal(encodeFrame(FRAME.REQ, 1, encodeJson({ method: "GET", path: "/early" })));
        send({ t: "data", d: Buffer.from(frame).toString("base64") });
        sentEarly = true;
      }
    });
    return null;
  };
  send({ t: "hello", ...hs.hello });
  await until(() => sentEarly, "the early request");
  await until(() => first.status().channels.length === 0 && first.status().handshakes === 0, "the channel ended");
  await sleep(50);
  assert.equal(requests.length, 0);
});

test("a replayed or reordered frame kills the channel", async () => {
  const fixture = await hubFixture();
  const { first, second, tap } = await connected(fixture);
  const channel = await second.openChannel(first.status().device.id);
  let last;
  tap.outgoing = (m) => { if (m.type === "channel.msg" && JSON.parse(m.opaque).d) last = m; return m; };
  const r = await channelClient(channel).request({ method: "GET", path: "/x" });
  await r.text();
  tap.outgoing = undefined;
  await until(() => last, "a frame");
  inject(first, { type: "channel.msg", from: second.status().device.id, opaque: last.opaque });
  await until(() => first.status().channels.length === 0, "the replay ended it");
  assert.ok(first.alerts.some((a) => a.kind === "channel-failure"));
});

test("a frame from another device under this channel's id is not taken for the peer's", async () => {
  const fixture = await hubFixture();
  const { first, second, tap } = await connected(fixture);
  const third = await joined(fixture, first, { name: "Third" });
  const channel = await second.openChannel(first.status().device.id);
  let last;
  tap.outgoing = (m) => { if (m.type === "channel.msg" && JSON.parse(m.opaque).d) last = m; return m; };
  const r = await channelClient(channel).request({ method: "GET", path: "/x" });
  await r.text();
  tap.outgoing = undefined;
  inject(first, { type: "channel.msg", from: third.status().device.id, opaque: last.opaque });
  await sleep(50);
  assert.equal(first.status().channels.length, 1, "keyed by who the hub says sent it, so it goes nowhere");
  channel.close();
});

test("handshake: a newer head on the other side is fetched, verified and adopted", async () => {
  const fixture = await hubFixture();
  const first = await registered(fixture, { name: "First" });
  const second = await joined(fixture, first, { name: "Second" });
  const { tap } = second;
  first.on("channel", (c) => serveChannel(c, (req, res) => res.end("x"), { device: c.peer, audit() {} }));
  // This device misses the announcement of a new device.
  tap.incoming = (m) => (m.type === "log.updated" ? null : m);
  const third = await joined(fixture, first, { name: "Third" });
  const headBefore = second.status().logHead;
  assert.notEqual(headBefore, first.status().logHead);
  const channel = await second.openChannel(first.status().device.id);
  assert.equal(second.status().logHead, first.status().logHead, "caught up during the handshake");
  assert.ok(third);
  channel.close();
});

test("handshake: a hub hiding the newer log gets the channel refused and an alert", async () => {
  const fixture = await hubFixture();
  const first = await registered(fixture, { name: "First" });
  const second = await joined(fixture, first, { name: "Second" });
  const { tap } = second;
  first.on("channel", (c) => serveChannel(c, (req, res) => res.end("x"), { device: c.peer, audit() {} }));
  const staleEntries = JSON.parse(readFileSync(join(second.dir, "log.json"), "utf8"));
  const staleHead = second.status().logHead;
  // The hub keeps this device on the old log for good.
  tap.incoming = (m) => {
    if (m.type === "log.updated") return null;
    if (m.type === "log") return { ...m, entries: staleEntries, head: staleHead, version: staleEntries.length };
    return m;
  };
  await joined(fixture, first, { name: "Third" });
  await assert.rejects(second.openChannel(first.status().device.id), /reconcile|log/i);
  assert.ok(second.alerts.some((a) => a.kind === "log-unreconciled"));
  assert.equal(second.status().channels.length, 0);
});

test("handshake: a device behind us on the same chain is fine, and it catches up itself", async () => {
  const fixture = await hubFixture();
  const first = await registered(fixture, { name: "First" });
  const second = await joined(fixture, first, { name: "Second" });
  const { tap } = second;
  second.on("channel", (c) => serveChannel(c, (req, res) => res.end("x"), { device: c.peer, audit() {} }));
  tap.incoming = (m) => (m.type === "log.updated" ? null : m);
  await joined(fixture, first, { name: "Third" });
  // The device ahead opens to the device behind: the one behind adopts, the one ahead just proceeds.
  const channel = await first.openChannel(second.status().device.id);
  assert.equal(second.status().logHead, first.status().logHead);
  channel.close();
});

test("handshake: a fork seen by comparing heads refuses the channel", async () => {
  const fixture = await hubFixture();
  const first = await registered(fixture, { name: "First" });
  const second = await joined(fixture, first, { name: "Second" });
  const { tap } = second;
  first.on("channel", (c) => serveChannel(c, (req, res) => res.end("x"), { device: c.peer, audit() {} }));
  const entries = JSON.parse(readFileSync(join(second.dir, "log.json"), "utf8"));
  const keys = await keysOf(first);
  const other = await newDeviceKeys({ extractable: true });
  const forked = await append(entries, { type: "add", name: "Fork", kind: "desktop", role: "full", signPub: other.signPub, boxPub: other.boxPub }, keys);
  tap.incoming = (m) => {
    if (m.type === "log.updated") return null;
    if (m.type === "log") return { ...m, entries: forked, head: "f", version: forked.length };
    return m;
  };
  await joined(fixture, first, { name: "Third" }); // the real log moves on with a different entry 2
  await assert.rejects(second.openChannel(first.status().device.id), /refused|reconcile|fork|log/i);
  assert.equal(second.status().channels.length, 0);
});

test("a handshake that never finishes is dropped, and there is a limit on how many can wait", async () => {
  const fixture = await hubFixture();
  const { first, second } = await pairWithTap(fixture);
  const account = first;
  account.limits.handshakeTimeoutMs = 60;
  account.limits.maxChannelsPerDevice = 2;
  const from = second.status().device.id;
  const eph = (await newDeviceKeys({ extractable: true })).boxPub;
  first.tap.outgoing = (m) => (m.type === "channel.msg" ? null : m); // nobody ever answers these handshakes
  const hello = (i) => ({ type: "channel.msg", from, opaque: JSON.stringify({ v: 1, c: toB64(new Uint8Array(16).fill(i)), t: "hello", eph, logHead: first.status().logHead }) });
  for (let i = 0; i < 5; i++) inject(account, hello(i));
  await until(() => account.status().handshakes <= 2 && account.status().handshakes > 0, "only two waiting");
  await until(() => account.status().handshakes === 0, "dropped when they time out");
  assert.equal(account.status().channels.length, 0);
});

test("presence: a peer gone from the hub closes its channels, and the client can see who is online", async () => {
  const fixture = await hubFixture();
  const { first, second } = await connected(fixture);
  await until(() => second.devices().find((d) => d.id === first.status().device.id)?.online === true, "online");
  const channel = await second.openChannel(first.status().device.id);
  await first.stop();
  await until(() => channel.closed, "the channel ends when the peer leaves");
  await until(() => second.devices().find((d) => d.id === first.status().device.id)?.online === false, "offline");
  await assert.rejects(second.openChannel(first.status().device.id));
});

// ------------------------------------------------------------------------------- recovery and password

test("recovery: a new device with the code joins, gets a new code, the old one is dead, every device shows a notice", async () => {
  const fixture = await hubFixture();
  const first = await registered(fixture, { name: "First" });
  const code = first.recoveryCode;
  const lost = makeAccount(fixture);
  await assert.rejects(lost.recover({ email: EMAIL, password: PASSWORD, recoveryCode: "0000-0000", name: "New" }), (e) => e.status === 400);
  const wrong = (await recoveryKeysFrom(code), makeAccount(fixture));
  await assert.rejects(wrong.recover({ email: EMAIL, password: `${PASSWORD}x`, recoveryCode: code, name: "New" }), (e) => e.status === 401);

  const fresh = makeAccount(fixture);
  const out = await fresh.recover({ email: EMAIL, password: PASSWORD, recoveryCode: code, name: "New" });
  assert.notEqual(out.recoveryCode, code);
  assert.equal(fresh.status().phase, "approved");
  assert.ok(fresh.devices().some((d) => d.self && d.role === "full"));
  await until(() => first.status().logHead === fresh.status().logHead, "the other device adopts");
  const notice = await until(() => first.alerts.find((a) => a.kind === "recovered"), "the notice");
  assert.match(notice.message, /recover/i);
  assert.equal(first.status().recoveries.length, 1);
  assert.equal(first.status().recoveries[0].name, "New");
  const compact = out.recoveryCode.replace(/-/g, "");
  for (const content of onDisk(fresh.dir)) assert.ok(!content.includes(compact));

  const again = makeAccount(fixture);
  await assert.rejects(again.recover({ email: EMAIL, password: PASSWORD, recoveryCode: code, name: "Thief" }), (e) => e.status === 403);
  assert.equal(again.status().phase, "signed-out");

  const next = makeAccount(fixture);
  await next.recover({ email: EMAIL, password: PASSWORD, recoveryCode: out.recoveryCode, name: "Newer" });
  assert.equal(next.status().phase, "approved");
});

test("recovery: a log from the hub that does not name this code's key is refused before anything is signed", async () => {
  const fixture = await hubFixture();
  const first = await registered(fixture, { name: "First" });
  const fake = { ...(await newDeviceKeys({ extractable: true })), name: "F", kind: "desktop" };
  const otherRecovery = await newDeviceKeys({ extractable: true });
  const theirs = await createLog({ device: fake, recoveryPub: otherRecovery.signPub });
  const tap = {};
  let appended = false;
  tap.incoming = (m) => (m.type === "log" ? { ...m, entries: theirs, head: "t", version: 1 } : m);
  tap.outgoing = (m) => { if (m.type === "log.append") appended = true; return m; };
  const lost = makeAccount(fixture, { WebSocketImpl: tappedSocket(tap) });
  await assert.rejects(lost.recover({ email: EMAIL, password: PASSWORD, recoveryCode: first.recoveryCode, name: "New" }), (e) => e.status === 403);
  assert.equal(appended, false);
});

test("password change: full device only, old password stops working, keys and the log are untouched", async () => {
  const fixture = await hubFixture();
  const first = await registered(fixture);
  const head = first.status().logHead, id = first.status().device.id;
  await assert.rejects(first.changePassword({ current: "wrong password here", next: "another long password" }), (e) => e.status === 401);
  await assert.rejects(first.changePassword({ current: PASSWORD, next: "short" }), (e) => e.status === 400);
  await first.changePassword({ current: PASSWORD, next: "another long password" });
  assert.equal(first.status().logHead, head);
  assert.equal(first.status().device.id, id);
  const oldTry = makeAccount(fixture);
  await assert.rejects(oldTry.signIn({ email: EMAIL, password: PASSWORD }), (e) => e.status === 401);
  const newTry = makeAccount(fixture);
  await newTry.signIn({ email: EMAIL, password: "another long password", name: "L" });
  assert.equal(newTry.status().phase, "pending");
});

// ------------------------------------------------------------------------------- hub unreachable

const appOptions = (dir, extra = {}) => ({ port: 0, relay: { host: "" }, vaultDir: join(dir, "vault"), piSessionsDir: join(dir, "pi"), claudeProjectsDir: join(dir, "claude"), autoStartPi: false, cwd: dir, persistHook: false, persistPiModel: false, hook: { enabled: false }, ...extra });

test("a hub that never answers costs the server's startup nothing", async () => {
  const fixture = await hubFixture();
  const first = await registered(fixture);
  await first.stop();
  // A socket that accepts and then says nothing, the worst kind of unreachable.
  const silent = [];
  const blackHole = createNetServer((s) => silent.push(s));
  await new Promise((r) => blackHole.listen(0, "127.0.0.1", r));
  cleanups.push(() => { for (const s of silent) s.destroy(); return new Promise((r) => blackHole.close(r)); });
  const timeListen = async (extra) => {
    const dir = freshDir();
    const app = await createApp(appOptions(dir, extra));
    const started = performance.now();
    await app.listen();
    const took = performance.now() - started;
    return { app, took };
  };
  const plain = await timeListen({ accountDir: join(freshDir(), "none") });
  plain.app.close();
  const dead = await timeListen({ accountDir: first.dir, accountHub: `http://127.0.0.1:${blackHole.address().port}`, accountOptions: { protector: testProtector } });
  assert.ok(dead.took < plain.took + 500, `listen took ${dead.took} ms with a dead hub, ${plain.took} ms without`);
  const r = await fetch(`http://127.0.0.1:${dead.app.server.address().port}/api/state`);
  assert.equal(r.status, 200);
  await r.text();
  // The protected session is read and the socket tried in the background.
  await until(() => dead.app.account.status().signedIn, "the account loaded");
  assert.equal(dead.app.account.status().hub.connected, false);
  dead.app.close();
});

test("an unreachable hub is retried with backoff and joined when it comes back", async () => {
  const dataDir = join(freshDir(), "hub");
  const hub = await startHub({ dataDir, bootstrapToken: BOOTSTRAP, origin: ORIGIN, log() {} });
  const fixture = { url: `http://127.0.0.1:${hub.port}` };
  const account = await registered(fixture);
  const { port } = hub;
  await hub.close();
  await until(() => !account.status().hub.connected, "noticed the hub went");
  await sleep(120);
  assert.ok(account.status().hub.attempts >= 1);
  const back = await startHub({ dataDir, port, origin: ORIGIN, log() {} });
  cleanups.push(() => back.close());
  await until(() => account.status().hub.connected, "reconnected");
});

test("a session the hub replaced, removed or expired does not loop reconnecting", async () => {
  const fixture = await hubFixture();
  const first = await registered(fixture);
  const twin = makeAccount(fixture, { dir: first.dir });
  await twin.start();
  await until(() => twin.status().hub.connected, "the twin's socket");
  await until(() => !first.status().hub.connected, "the first is replaced");
  await sleep(150);
  assert.equal(first.status().hub.connected, false, "no reconnect fight");
  assert.equal(first.status().hub.attempts, 0, "not even an attempt");
  assert.equal(twin.status().hub.connected, true);
  assert.match(first.status().hub.lastError, /replaced/i);
});

// ------------------------------------------------------------------------------- secrets

test("no key, token, password or code in the logs, status, alerts or audit", async () => {
  const fixture = await hubFixture();
  const { first, second, tap } = await connected(fixture);
  const channel = await second.openChannel(first.status().device.id);
  await (await channelClient(channel).request({ method: "GET", path: "/x" })).text();
  tap.incoming = (m) => (m.type === "log" ? { ...m, entries: [{ nonsense: 1 }], head: "g", version: 1 } : m);
  inject(second, { type: "log.updated", head: "g", version: 1 });
  await until(() => second.alerts.some((a) => a.kind === "bad-log"), "an alert to scan");
  await assert.rejects(first.changePassword({ current: "wrong password here", next: "another long password" }));
  const sessionRecord = JSON.parse(readFileSync(join(first.dir, "session.json"), "utf8"));
  const session = Buffer.from(await testProtector.unprotect(Buffer.from(sessionRecord.data, "base64"))).toString();
  const keys = JSON.parse(Buffer.from(await testProtector.unprotect(Buffer.from(JSON.parse(readFileSync(join(first.dir, "keys.json"), "utf8")).data, "base64"))).toString());
  assert.equal(typeof keys.sign, "string");
  const secrets = [PASSWORD, "wrong password here", "another long password", first.recoveryCode, BOOTSTRAP, session, keys.sign, keys.box];
  const texts = [
    JSON.stringify(first.status()), JSON.stringify(second.status()), JSON.stringify(first.alerts), JSON.stringify(second.alerts),
    first.logged.join("\n"), second.logged.join("\n"), JSON.stringify(await first.auditLines(100)), fixture.logged.join("\n"),
    readFileSync(join(first.dir, "state.json"), "utf8"), readFileSync(join(first.dir, "log.json"), "utf8"),
  ];
  for (const secret of secrets) for (const text of texts) assert.ok(!text.includes(secret), `a secret leaked: ${secret.slice(0, 4)}…`);
  assert.ok(keys.sign.length > 40 && fromB64(keys.sign).length > 32);
  channel.close();
});

// ------------------------------------------------------------------------------- the whole way

test("the whole way: the window's routes run the account, and another device reaches the real handle through the hub", async () => {
  const fixture = await hubFixture();
  const dir = freshDir();
  const accountDir = join(dir, "account");
  writeBootstrap(accountDir);
  const token = "window-token-for-the-whole-way-0123456789";
  const app = await createApp(appOptions(dir, { accountDir, accountHub: fixture.url, windowToken: token, accountOptions: { hubOrigin: ORIGIN, protector: testProtector, deriveLoginKey: quickKey, reconnect: { minMs: 20, maxMs: 100 } } }));
  await app.listen();
  cleanups.push(async () => { app.close(); });
  const at = `http://127.0.0.1:${app.server.address().port}`;
  const swap = await fetch(`${at}/?desktop=1&token=${token}`, { redirect: "manual" });
  const cookie = swap.headers.get("set-cookie").split(";")[0];
  const call = async (method, path, body) => {
    const r = await fetch(`${at}/api/account/${path}`, { method, headers: { cookie, origin: at, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json() };
  };

  const before = await call("GET", "status");
  assert.equal(before.json.phase, "signed-out");
  const short = await call("POST", "register", { email: EMAIL, password: "short" });
  assert.equal(short.status, 400);
  assert.equal(short.json.code, "weak-password");
  const reg = await call("POST", "register", { email: EMAIL, password: PASSWORD, name: "Host" });
  assert.equal(reg.status, 200);
  assert.ok(reg.json.recoveryCode);
  await until(async () => (await call("GET", "status")).json.hub.connected, "the host's socket");

  // The window's own event stream carries approval cards.
  const events = await fetch(`${at}/api/account/events`, { headers: { cookie } });
  assert.match(events.headers.get("content-type"), /event-stream/);
  let streamed = "";
  (async () => { try { for await (const c of events.body) streamed += Buffer.from(c).toString(); } catch { /* closed */ } })();

  const phone = makeAccount(fixture);
  await phone.signIn({ email: EMAIL, password: PASSWORD, name: "Phone" });
  const row = await until(async () => (await call("GET", "approvals")).json.pending.find((r) => r.name === "Phone"), "the card");
  await until(() => streamed.includes("event: approval") && streamed.includes("Phone"), "the card on the stream");
  const review = await call("POST", "review", { id: row.id });
  assert.equal(review.status, 200);
  const code = await until(() => phone.status().pending?.code, "the code");
  assert.equal(review.json.code, code);
  phone.confirmCode(code);
  const approved = await call("POST", "approve", { id: row.id, code, role: "full" });
  assert.equal(approved.status, 200);
  await until(() => phone.status().phase === "approved", "the phone approved");
  const devices = await call("GET", "devices");
  assert.equal(devices.json.devices.length, 2);

  const channel = await phone.openChannel(app.account.status().device.id);
  const http = channelClient(channel);
  const state = await http.request({ method: "GET", path: "/api/state" });
  assert.equal(state.status, 200);
  assert.equal((await state.json()).access.role, "device");
  const never = await http.request({ method: "POST", path: "/api/shutdown" });
  assert.equal(never.status, 403);
  await never.text();
  const stream = await http.request({ method: "GET", path: "/events" });
  let text = "";
  stream.body.on("data", (c) => { text += c; });
  stream.body.on("error", () => {});
  app.bus.emit({ sid: "s", harness: "omni", kind: "log", ts: 1, text: "marker-through-the-hub" });
  await until(() => text.includes("marker-through-the-hub"), "a live event through the hub");

  const audit = await until(async () => { const j = (await call("GET", "audit?limit=10")).json; return j.lines.length >= 3 ? j : null; }, "audit lines");
  assert.ok(audit.lines.some((l) => l.path === "/api/shutdown" && l.deviceName === "Phone"));

  const removed = await call("POST", "remove", { id: phone.status().device.id });
  assert.equal(removed.status, 200);
  await until(() => channel.closed, "the channel is cut off at once");
  const out = await call("POST", "sign-out", { forget: true });
  assert.equal(out.json.phase, "signed-out");
  await events.body.cancel().catch(() => {});
});
