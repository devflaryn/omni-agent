// The desktop's account: keys on disk, trust in the log, approvals, recovery, and channels against a real hub.
// The hub runs on an ephemeral loopback port. A wrapper around WebSocket plays the hacked hub by changing what crosses.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promises as fsp } from "node:fs";
import { startHub } from "../hub/server.mjs";
import { Account, keychainProtector, plainProtector, windowsProtector } from "../server/account.mjs";
import { RecoveryStore } from "../server/account-recovery.mjs";
import { channelClient, serveChannel } from "../server/channel-host.mjs";
import { createApp } from "../server/index.mjs";
import { FRAME, FRAME_VERSION, encodeFrame, encodeJson, encodeOuter } from "../ui/channel-frames.js";
import { randomBytes } from "node:crypto";
import { approverExchange, fromB64, newDeviceExchange, newDeviceKeys, recoveryKeysFrom, sign, startHandshake, toB64 } from "../ui/account-core.js";
import { signedClaimBytes } from "../ui/log-trust.js";
import { append, canRecover, createLog, entryBytes, verifyLog } from "../ui/device-log.js";

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
  const part = (label) => new Uint8Array(createHash("sha256").update(label).update(password).update(salt).digest());
  return { loginKey: part("login"), anchorKey: part("anchor") };
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
    dir, hubUrl: fixture.url, hubOrigin: ORIGIN, name: "Device", kind: "desktop", protector: testProtector, deriveKeys: quickKey, WebSocketImpl: tappedSocket(tap),
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
  assert.match(keyProtection.warning, /recovery code/i, "the code sits in the same store");
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
  const account = makeAccount(fixture, { deriveKeys: undefined });
  writeBootstrap(account.dir);
  let worst = 0, last = Date.now();
  const beat = setInterval(() => { const t = Date.now(); worst = Math.max(worst, t - last); last = t; }, 5);
  const out = await account.register({ email: EMAIL, password: PASSWORD, name: "First" });
  clearInterval(beat);
  assert.ok(out.recoveryCode);
  assert.ok(worst < 400, `the event loop stalled ${worst} ms`);
  const second = makeAccount(fixture, { deriveKeys: undefined });
  await second.signIn({ email: EMAIL, password: PASSWORD, name: "Second" });
  assert.equal(second.status().phase, "pending", "the same key derivation reaches the same account");
  const wrong = makeAccount(fixture, { deriveKeys: undefined });
  await assert.rejects(wrong.signIn({ email: EMAIL, password: `${PASSWORD}x`, name: "Third" }), (e) => e.status === 401);
});

test("register: a local failure at any step after the hub accepted still returns the code, as a warning", async () => {
  for (const blocked of ["log.json", "session.json", "state.json"]) {
    const fixture = await hubFixture();
    const account = makeAccount(fixture);
    writeBootstrap(account.dir);
    await account.start();
    mkdirSync(join(account.dir, blocked)); // the write's rename fails, as on a full or failing disk
    const out = await account.register({ email: EMAIL, password: PASSWORD, name: "First" });
    assert.ok(out.recoveryCode, blocked);
    assert.ok(account.status().warnings.length > 0 || blocked === "session.json", blocked);
  }
});

test("register: a failure on the verify step after the hub accepted still returns the code", async () => {
  const fixture = await hubFixture();
  const account = makeAccount(fixture, { verifyLogImpl: async () => { throw new Error("disk gone"); } });
  writeBootstrap(account.dir);
  const out = await account.register({ email: EMAIL, password: PASSWORD, name: "First" });
  assert.ok(out.recoveryCode);
  assert.equal(out.signedIn, false);
  assert.ok(account.status().warnings.some((w) => /could not save/.test(w)));
});

test("register: killed right after the hub accepted, the next sign-in resumes on the candidate and says the code is gone", async () => {
  const fixture = await hubFixture();
  const killedDir = join(freshDir(), "account");
  const account = makeAccount(fixture, { fetchImpl: async (url, init) => {
    const reply = await fetch(url, init);
    if (String(url).endsWith("/api/register")) { cpSync(account.dir, killedDir, { recursive: true }); throw new Error("killed"); }
    return reply;
  } });
  writeBootstrap(account.dir);
  await assert.rejects(account.register({ email: EMAIL, password: PASSWORD, name: "First" }));
  const after = makeAccount(fixture, { dir: killedDir });
  await after.start();
  assert.equal(after.status().phase, "signed-out");
  await after.signIn({ email: EMAIL, password: PASSWORD });
  await until(() => after.status().phase === "approved", "resumed");
  assert.equal(after.status().logVersion, 1);
  assert.ok(existsSync(join(killedDir, "log.json")));
  assert.equal(after.status().recoveryCodePending, true);
  const { recoveryCode, confirmed } = await after.showRecoveryCode();
  assert.equal(confirmed, true);
  const proof = makeAccount(fixture);
  await proof.recover({ email: EMAIL, password: PASSWORD, recoveryCode, name: "Proof" });
  assert.equal(proof.status().phase, "approved", "the stored code is the live one");
});

test("register: the code stays stored until the person says they saved it, and is on no plain file", async () => {
  const fixture = await hubFixture();
  const account = makeAccount(fixture);
  writeBootstrap(account.dir);
  const out = await account.register({ email: EMAIL, password: PASSWORD, name: "First" });
  assert.equal(account.status().recoveryCodePending, true);
  assert.deepEqual(await account.showRecoveryCode(), { recoveryCode: out.recoveryCode, confirmed: true });
  await until(() => account.status().hub.connected, "connected");
  const record = JSON.parse(readFileSync(join(account.dir, "recovery-code.json"), "utf8"));
  assert.equal(record.protection, "test");
  assert.equal(Buffer.from(await testProtector.unprotect(Buffer.from(record.data, "base64"))).toString(), out.recoveryCode);
  for (const name of ["state.json", "log.json"]) assert.ok(!readFileSync(join(account.dir, name), "utf8").includes(out.recoveryCode), name);
  for (const content of onDisk(account.dir)) assert.ok(!content.includes(out.recoveryCode), "protected wherever it is");
  assert.ok(!account.logged.join("\n").includes(out.recoveryCode));
  assert.ok(!JSON.stringify(account.status()).includes(out.recoveryCode));
  await account.stop();
  const restarted = makeAccount(fixture, { dir: account.dir });
  await restarted.start();
  assert.equal(restarted.status().recoveryCodePending, true, "still there after a restart");
  await restarted.recoveryCodeSaved();
  assert.equal(restarted.status().recoveryCodePending, false);
  assert.ok(!existsSync(join(account.dir, "recovery-code.json")));
  await assert.rejects(restarted.showRecoveryCode(), (e) => e.status === 404);
});

test("register: killed before the hub saw it, the stored code blocks a fresh registration until the person forgets this device", async () => {
  const fixture = await hubFixture();
  const killedDir = join(freshDir(), "account");
  const account = makeAccount(fixture, { fetchImpl: async (url, init) => {
    if (String(url).endsWith("/api/register")) { cpSync(account.dir, killedDir, { recursive: true }); throw new Error("killed"); }
    return fetch(url, init);
  } });
  writeBootstrap(account.dir);
  await assert.rejects(account.register({ email: EMAIL, password: PASSWORD, name: "First" }));
  const after = makeAccount(fixture, { dir: killedDir });
  await after.start();
  assert.equal(after.status().recoveryCodePending, true);
  const stale = await after.showRecoveryCode();
  assert.equal(stale.confirmed, false);
  await assert.rejects(after.recoveryCodeSaved(), (e) => e.status === 409);
  // This computer cannot tell a registration that never left from one whose answer was lost: the code may be live.
  await assert.rejects(after.register({ email: EMAIL, password: PASSWORD, name: "First" }), (e) => e.status === 409 && e.code === "recovery-code-pending" && /saved|forget/.test(e.message));
  assert.deepEqual(await after.showRecoveryCode(), stale, "nothing replaced it");
  await after.signOut({ forget: true });
  assert.equal(after.status().recoveryCodePending, false);
  const out = await after.register({ email: EMAIL, password: PASSWORD, name: "First" });
  assert.notEqual(out.recoveryCode, stale.recoveryCode);
  assert.deepEqual(await after.showRecoveryCode(), { recoveryCode: out.recoveryCode, confirmed: true });
});

/** A registration the hub took, killed before its answer was handled: the code on disk is live and was never shown. */
async function landedThenKilled(fixture) {
  const killedDir = join(freshDir(), "account");
  const account = makeAccount(fixture, { fetchImpl: async (url, init) => {
    const reply = await fetch(url, init);
    if (String(url).endsWith("/api/register")) { cpSync(account.dir, killedDir, { recursive: true }); throw new Error("killed"); }
    return reply;
  } });
  writeBootstrap(account.dir);
  await assert.rejects(account.register({ email: EMAIL, password: PASSWORD, name: "First" }));
  await account.stop();
  return killedDir;
}

const codeWorks = async (fixture, code) => {
  const proof = makeAccount(fixture);
  return proof.recover({ email: EMAIL, password: PASSWORD, recoveryCode: code, name: "Proof" }).then(() => proof.status().phase === "approved", () => false);
};

test("register: killed after the hub took it, a wrong password at the retry is refused as wrong, and cannot cost the live code", async () => {
  const fixture = await hubFixture();
  const killedDir = await landedThenKilled(fixture);
  const after = makeAccount(fixture, { dir: killedDir });
  await after.start();
  const live = await after.showRecoveryCode();
  const before = onDisk(killedDir);
  await assert.rejects(after.register({ email: EMAIL, password: "a different long password", name: "First" }), (e) => e.status === 409 && e.code === "recovery-code-pending" && /password/.test(e.message));
  assert.deepEqual(onDisk(killedDir), before, "nothing on disk changed");
  assert.deepEqual(await after.showRecoveryCode(), live, "the same code, still stored");
  await after.signIn({ email: EMAIL, password: PASSWORD });
  await until(() => after.status().phase === "approved", "resumed with the right password");
  assert.equal((await after.showRecoveryCode()).confirmed, true);
  assert.equal((await after.showRecoveryCode()).recoveryCode, live.recoveryCode);
});

// The three probes: after a landed registration whose answer was lost, a wrong password used to start a fresh attempt
// whose record replaced the live code on disk, and the attempt's own failure then left that code nowhere.
for (const [name, fetchFor] of [
  ["the network drops the fresh attempt", () => { throw new Error("net down"); }],
  ["a kill right after the fresh attempt's write", null],
  ["the hub answers 500 internal to the fresh attempt", () => new Response(JSON.stringify({ error: "internal" }), { status: 500 })],
]) {
  test(`register over a landed registration, wrong password, ${name}: the live code is kept and the right password opens the account`, async () => {
    const fixture = await hubFixture();
    const killedDir = await landedThenKilled(fixture);
    const registers = [];
    const after = makeAccount(fixture, { dir: killedDir, fetchImpl: async (url, init) => {
      if (String(url).endsWith("/api/register")) { registers.push(1); return fetchFor(); }
      return fetch(url, init);
    } });
    await after.start();
    const A = await after.showRecoveryCode();
    assert.equal(A.confirmed, false);
    const before = onDisk(killedDir);
    const wrong = () => after.register({ email: EMAIL, password: "a mistyped long password", name: "First" });
    if (fetchFor) {
      await assert.rejects(wrong, (e) => e.status === 409 && e.code === "recovery-code-pending" && /did not accept that password/.test(e.message) && /saved|forget/.test(e.message));
    } else {
      // A kill at the first file write of the attempt: there is no such write, so nothing to kill.
      const killed = await killedAtWrite(after, 1, join(freshDir(), "account"), () => assert.rejects(wrong, (e) => e.code === "recovery-code-pending"));
      assert.equal(killed, false, "a wrong password writes nothing");
    }
    assert.equal(registers.length, 0, "nothing was sent to the hub's register route");
    assert.deepEqual(onDisk(killedDir), before, "nothing on disk changed");
    const again = fetchFor ? after : makeAccount(fixture, { dir: killedDir });
    await again.start();
    assert.deepEqual(await again.showRecoveryCode(), A, "A is still the code held");
    assert.deepEqual(await again.register({ email: EMAIL, password: PASSWORD, name: "First" }), { recoveryCode: null, signedIn: true, resumed: true });
    await until(() => again.status().phase === "approved", "the candidate settles");
    assert.equal(again.status().recoveryContested, false);
    assert.equal(again.status().logVersion, 1);
    assert.deepEqual(await again.showRecoveryCode(), { recoveryCode: A.recoveryCode, confirmed: true });
    assert.equal(await codeWorks(fixture, A.recoveryCode), true, "A is the hub's code");
    await again.recoveryCodeSaved();
    assert.equal(again.status().recoveryCodePending, false);
  });
}

test("register over a landed registration: the exits are the right password, saved after ten minutes, or forget; a fresh attempt then creates nothing and says so", async () => {
  const fixture = await hubFixture();
  const killedDir = await landedThenKilled(fixture);
  let clock = Date.now();
  const after = makeAccount(fixture, { dir: killedDir, now: () => clock });
  await after.start();
  const A = await after.showRecoveryCode();
  await assert.rejects(after.register({ email: EMAIL, password: "a mistyped long password", name: "First" }), (e) => e.code === "recovery-code-pending");
  await assert.rejects(after.recoveryCodeSaved(), (e) => e.code === "not-settled");
  clock += 10 * 60_000;
  assert.equal(after.status().recoveryContested, true);
  assert.match(after.status().hub.lastError, /not confirmed this recovery code in 10 minutes/);
  assert.doesNotMatch(after.status().hub.lastError, /do not match/, "no hub answer contradicted it");
  await after.recoveryCodeSaved();
  assert.equal(JSON.parse(readFileSync(join(killedDir, "recovery-code.json"), "utf8")).state, "saved-unsettled");
  // Saved, the right password still lands on the account rather than on a refused registration.
  assert.deepEqual(await after.register({ email: EMAIL, password: PASSWORD, name: "First" }), { recoveryCode: null, signedIn: true, resumed: true });
  await until(() => after.status().phase === "approved", "the saved candidate settles");
  assert.ok(!existsSync(join(killedDir, "recovery-code.json")), "settled, and the person has the code");
  assert.equal(await codeWorks(fixture, A.recoveryCode), true, "the saved code is the account's");
  // Saved, a wrong password gets the fresh registration the person asked for, which creates nothing and says so.
  const fixture2 = await hubFixture();
  const killedDir2 = await landedThenKilled(fixture2);
  let clock2 = Date.now();
  const second = makeAccount(fixture2, { dir: killedDir2, now: () => clock2 });
  await second.start();
  const A2 = await second.showRecoveryCode();
  clock2 += 10 * 60_000;
  await second.recoveryCodeSaved();
  await assert.rejects(second.register({ email: EMAIL, password: "a mistyped long password", name: "First" }), (e) => e.code === "registration-closed" && /invite code is needed/.test(e.message));
  assert.equal(second.status().recoveryCodePending, false);
  assert.ok(!existsSync(join(killedDir2, "recovery-code.json")), "the attempt that created nothing left nothing");
  assert.equal(await codeWorks(fixture2, A2.recoveryCode), true);
  // The other exit: forget.
  const fixture3 = await hubFixture();
  const killedDir3 = await landedThenKilled(fixture3);
  const third = makeAccount(fixture3, { dir: killedDir3 });
  await third.start();
  const A3 = await third.showRecoveryCode();
  await third.signOut({ forget: true });
  await assert.rejects(third.register({ email: EMAIL, password: PASSWORD, name: "First" }), (e) => e.code === "registration-closed");
  assert.equal(await codeWorks(fixture3, A3.recoveryCode), true);
});

test("register after the person saved a recovery's code: the right password lands on the account through the held candidate, not on a refused registration", async () => {
  const fixture = await hubFixture();
  const first = await registered(fixture, { name: "First" });
  const oldLog = JSON.parse(readFileSync(join(first.dir, "log.json"), "utf8"));
  const killedDir = await killedRecovery(fixture, first);
  const after = makeAccount(fixture, { dir: killedDir });
  after.tap.incoming = (m) => (m.type === "log" ? { ...m, entries: oldLog, head: "old", version: oldLog.length } : m);
  await after.start();
  await until(() => after.status().recoveryContested, "contested");
  const { recoveryCode } = await after.showRecoveryCode();
  await after.recoveryCodeSaved();
  await after.signOut();
  after.tap.incoming = undefined;
  assert.deepEqual(await after.register({ email: EMAIL, password: PASSWORD, name: "Again" }), { recoveryCode: null, signedIn: true, resumed: true });
  await until(() => after.status().phase === "approved", "the held candidate settles");
  assert.ok(!existsSync(join(killedDir, "recovery-code.json")));
  assert.equal(after.status().logVersion, 2);
  assert.equal(await codeWorks(fixture, recoveryCode), true, "the saved code is the live one");
});

test("register: an unsaved recovery from this computer blocks a registration for that email too", async () => {
  const fixture = await hubFixture();
  const first = await registered(fixture, { name: "First" });
  const fresh = makeAccount(fixture, { limits: { rpcTimeoutMs: 40 } });
  fresh.tap.incoming = (m) => (m.type === "log.ok" || m.type === "log.conflict" ? null : m);
  const out = await fresh.recover({ email: EMAIL, password: PASSWORD, recoveryCode: first.recoveryCode, name: "New" });
  assert.equal(out.confirmed, false);
  await fresh.signOut();
  const before = onDisk(fresh.dir);
  await assert.rejects(fresh.register({ email: EMAIL, password: PASSWORD, name: "New" }), (e) => e.status === 409 && e.code === "recovery-code-pending" && /recovery/.test(e.message));
  assert.deepEqual(onDisk(fresh.dir), before);
  assert.equal((await fresh.showRecoveryCode()).recoveryCode, out.recoveryCode);
});

test("register: when the hub refuses, the stored code is deleted", async () => {
  const fixture = await hubFixture();
  const account = makeAccount(fixture);
  mkdirSync(account.dir, { recursive: true });
  writeFileSync(join(account.dir, "bootstrap-token"), "wrong-token-0123456789");
  await assert.rejects(account.register({ email: EMAIL, password: PASSWORD, name: "x" }), (e) => e.status === 403);
  assert.equal(account.status().recoveryCodePending, false);
  assert.ok(!existsSync(join(account.dir, "recovery-code.json")));
});

test("register: if the code cannot be stored first, nothing reaches the hub", async () => {
  const fixture = await hubFixture();
  const sent = [];
  const account = makeAccount(fixture, { fetchImpl: async (url, init) => { sent.push(String(url)); return fetch(url, init); } });
  writeBootstrap(account.dir);
  await account.start();
  mkdirSync(join(account.dir, "recovery-code.json"));
  await assert.rejects(account.register({ email: EMAIL, password: PASSWORD, name: "First" }));
  assert.ok(!sent.some((u) => u.endsWith("/api/register")));
});

test("register: no answer from the hub, then a retry, gives the code of the attempt that landed", async () => {
  const fixture = await hubFixture();
  let lost = true;
  const account = makeAccount(fixture, { fetchImpl: async (url, init) => {
    const reply = await fetch(url, init);
    if (lost && String(url).endsWith("/api/register")) { lost = false; throw new Error("the answer was lost"); }
    return reply;
  } });
  writeBootstrap(account.dir);
  await assert.rejects(account.register({ email: EMAIL, password: PASSWORD, name: "First" }), (e) => e.code === "hub-unreachable");
  const out = await account.register({ email: EMAIL, password: PASSWORD, name: "First" });
  await until(() => account.status().hub.connected, "connected");
  assert.equal(account.status().phase, "approved");
  const recovered = makeAccount(fixture);
  await recovered.recover({ email: EMAIL, password: PASSWORD, recoveryCode: out.recoveryCode, name: "New" });
  assert.equal(recovered.status().phase, "approved", "that code is the real one");
});

test("register: a stale record blocks a fresh registration until the person discards it through saved, after the bounded time, or forget; and says so", async () => {
  const fixture = await hubFixture();
  let clock = Date.now();
  const account = makeAccount(fixture, { now: () => clock });
  mkdirSync(account.dir, { recursive: true });
  const stale = { ...(await newDeviceKeys({ extractable: true })), name: "Old", kind: "desktop" };
  const record = { v: 1, protection: "none", state: "in-doubt", since: clock, kind: "register", email: EMAIL, entries: await createLog({ device: stale, recovery: await newDeviceKeys({ extractable: true }) }), data: Buffer.from("OLD-CODE").toString("base64") };
  writeFileSync(join(account.dir, "recovery-code.json"), JSON.stringify(record));
  writeBootstrap(account.dir);
  // This computer cannot know that it never landed: the password is refused by the hub either way.
  await assert.rejects(account.register({ email: EMAIL, password: PASSWORD, name: "First" }), (e) => e.status === 409 && e.code === "recovery-code-pending" && /did not accept that password/.test(e.message) && /say you saved that code/.test(e.message) && /forget this device/.test(e.message));
  assert.equal(JSON.parse(readFileSync(join(account.dir, "recovery-code.json"), "utf8")).data, record.data, "the stored code is untouched");
  assert.equal(account.status().logVersion, 0);
  await assert.rejects(account.recoveryCodeSaved(), (e) => e.code === "not-settled");
  clock += 10 * 60_000;
  await account.recoveryCodeSaved();
  const out = await account.register({ email: EMAIL, password: PASSWORD, name: "First" });
  assert.ok(out.recoveryCode);
  assert.equal(account.status().logVersion, 1);
  // The forget exit, on another copy.
  const other = makeAccount(await hubFixture());
  mkdirSync(other.dir, { recursive: true });
  writeFileSync(join(other.dir, "recovery-code.json"), JSON.stringify(record));
  writeBootstrap(other.dir);
  await assert.rejects(other.register({ email: EMAIL, password: PASSWORD, name: "First" }), (e) => e.code === "recovery-code-pending");
  await other.signOut({ forget: true });
  assert.ok((await other.register({ email: EMAIL, password: PASSWORD, name: "First" })).recoveryCode);
});

test("register: a stale record for an email whose account this computer is not on: the password opens nothing here, and the record stays", async () => {
  const fixture = await hubFixture();
  await registered(fixture, { name: "First" });
  const other = makeAccount(fixture);
  mkdirSync(other.dir, { recursive: true });
  const stale = { ...(await newDeviceKeys({ extractable: true })), name: "Old", kind: "desktop" };
  writeFileSync(join(other.dir, "recovery-code.json"), JSON.stringify({ v: 1, protection: "none", state: "in-doubt", since: Date.now(), kind: "register", email: EMAIL, entries: await createLog({ device: stale, recovery: await newDeviceKeys({ extractable: true }) }), data: Buffer.from("OLD-CODE").toString("base64") }));
  await other.start();
  const before = readFileSync(join(other.dir, "recovery-code.json"), "utf8");
  await assert.rejects(other.register({ email: EMAIL, password: PASSWORD, name: "Other" }), (e) => e.status === 409 && e.code === "recovery-code-pending" && /not on/.test(e.message) && /sign in instead/.test(e.message));
  assert.equal(other.status().phase, "signed-out");
  assert.equal(other.status().signedIn, false);
  assert.ok(!existsSync(join(other.dir, "session.json")));
  assert.equal(readFileSync(join(other.dir, "recovery-code.json"), "utf8"), before, "the record is untouched");
  assert.equal(other.status().recoveryCodePending, true);
});

/** The store on its own, with the plainest io: what the table allows, whoever calls it. */
function storeIn(dir, { now = () => Date.now(), unsettledMs = 10 * 60_000 } = {}) {
  mkdirSync(dir, { recursive: true });
  const warnings = [];
  const store = new RecoveryStore({
    dir, now, unsettledMs, warn: (t) => warnings.push(t),
    writeSecret: async (name, fields, bytes) => fsp.writeFile(join(dir, name), JSON.stringify({ ...fields, protection: "none", data: Buffer.from(bytes).toString("base64") })),
    readSecret: async (record) => Buffer.from(record.data, "base64"),
    writeFile: async (name, text) => fsp.writeFile(join(dir, name), text),
  });
  store.warnings = warnings;
  return store;
}

test("the recovery table: prepare refuses from any state holding a code that may be live, and only the person's saved, a hub's no, or forget open it again", async () => {
  const dir = join(freshDir(), "store");
  const store = storeIn(dir);
  const file = join(dir, "recovery-code.json");
  const refused = async (args) => {
    const before = existsSync(file) ? readFileSync(file, "utf8") : null;
    const state = store.state;
    await assert.rejects(store.prepare(args), (e) => /may be live/.test(e.message), `prepare over ${state}`);
    assert.equal(store.state, state, `state after a refused prepare over ${state}`);
    assert.equal(existsSync(file) ? readFileSync(file, "utf8") : null, before, `disk after a refused prepare over ${state}`);
  };
  const A = { kind: "register", email: EMAIL, code: "CODE-A", entries: [{ a: 1 }] };
  const B = { kind: "register", email: EMAIL, code: "CODE-B", entries: [{ b: 1 }] };
  await store.prepare(A);
  assert.equal(store.state, "in-doubt");
  await refused(B);
  await refused({ ...A, kind: "recover" });
  await store.prepare({ ...A, entries: [{ a: 2 }] }); // the same code sent again, on a new candidate: nothing is replaced
  assert.equal(store.state, "in-doubt");
  assert.deepEqual(store.candidate.entries, [{ a: 2 }]);
  await store.apply("contradicted");
  assert.equal(store.state, "contested");
  await refused(B);
  await store.prepare(A);
  assert.equal(store.state, "in-doubt", "a resend of a contested code is in doubt again");
  await store.apply("settled");
  assert.equal(store.state, "live");
  await refused(B);
  await refused(A); // a live code is never sent again
  await store.apply("saved");
  assert.equal(store.state, "none");
  await store.prepare(B);
  await store.apply("contradicted");
  await store.apply("saved");
  assert.equal(store.state, "saved-unsettled");
  await refused(A);
  await store.apply("replaced");
  assert.equal(store.state, "none");
  await store.prepare(A);
  await store.apply("nothingCreated");
  assert.equal(store.state, "none");
  await store.prepare(B);
  await store.apply("forgotten");
  assert.equal(store.state, "none");
  // A reader that cannot open the stored code cannot prove a resend is the same code, so it is refused too.
  await store.prepare(A);
  writeFileSync(file, "{not json");
  await refused(A);
  assert.deepEqual(store.warnings, []);
});

test("the recovery table: a contradiction after the person saved an unsettled code is shown, not swallowed", async () => {
  const dir = join(freshDir(), "store");
  const store = storeIn(dir);
  await store.prepare({ kind: "recover", email: EMAIL, code: "CODE-A", entries: [{ a: 1 }] });
  await store.apply("contradicted");
  await store.apply("saved");
  assert.equal(store.state, "saved-unsettled");
  assert.equal(store.contested, false);
  assert.equal(await store.apply("contradicted"), true);
  assert.equal(store.state, "saved-contested");
  assert.equal(store.contested, true);
  assert.equal(store.pending, false);
  assert.ok(store.candidate, "the candidate is still held");
  const reloaded = storeIn(dir);
  await reloaded.load();
  assert.equal(reloaded.state, "saved-contested", "and it survives a restart");
  await store.apply("signedOut");
  assert.equal(store.state, "saved-unsettled", "no hub is being asked now");
  await store.apply("contradicted");
  await store.apply("settled");
  assert.equal(store.state, "none");
  await store.prepare({ kind: "recover", email: EMAIL, code: "CODE-B", entries: [{ b: 1 }] });
  await store.apply("contradicted");
  await store.apply("saved");
  await store.apply("contradicted");
  await store.apply("forgotten");
  assert.equal(store.state, "none");
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

test("approval: the whole exchange, one tap on the approver, and nothing asked of the new device", async () => {
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

test("approval: a review that fails late does not wipe another review, and hints are only for real cards", async () => {
  const fixture = await hubFixture();
  const approver = await registered(fixture, { limits: { reviewTimeoutMs: 150 } });
  const second = await joined(fixture, approver);
  const silent = makeAccount(fixture), b = makeAccount(fixture);
  await silent.signIn({ email: EMAIL, password: PASSWORD, name: "Silent" });
  await b.signIn({ email: EMAIL, password: PASSWORD, name: "B" });
  silent.tap.outgoing = (m) => (m.type === "approval.msg" ? null : m);
  const rowA = await until(() => approver.pendingSignIns().find((r) => r.name === "Silent"), "card A");
  const rowB = await until(() => approver.pendingSignIns().find((r) => r.name === "B"), "card B");
  const failing = assert.rejects(approver.review(rowA.id), (e) => e.status === 504);
  await sleep(20);
  await assert.rejects(approver.review(rowB.id), (e) => e.status === 409, "A is still in hand");
  // A is denied, so B can start. A's timer then runs out while B is on screen.
  await approver.deny(rowA.id);
  await approver.review(rowB.id);
  await failing;
  assert.equal(approver.status().review?.id, rowB.id, "A's failure leaves B's review alone");
  await approver.deny(rowB.id);
  const c = makeAccount(fixture);
  await c.signIn({ email: EMAIL, password: PASSWORD, name: "C" });
  const rowC = await until(() => approver.pendingSignIns().find((r) => r.name === "C"), "card C");

  // A hub's hints: an id with no card is dropped, however many.
  const from = second.status().device.id;
  for (let i = 0; i < 200; i++) inject(approver, { type: "channel.msg", from, opaque: JSON.stringify({ v: FRAME_VERSION, t: "review", id: `made-up-${i}` }) });
  inject(approver, { type: "channel.msg", from, opaque: JSON.stringify({ v: FRAME_VERSION, t: "review", id: rowC.id }) });
  assert.equal(approver.pendingSignIns().find((r) => r.id === rowC.id).reviewedBy, "Second");
  // A hint is not kept for a card that may come later: nothing is held for an id the hub made up.
  inject(approver, { type: "pending.list", pending: [{ ...rowC, id: "made-up-7" }] });
  assert.equal(approver.pendingSignIns().find((r) => r.id === "made-up-7").reviewedBy, null);
});

test("a hub's error code is clipped before it reaches an error the person sees", async () => {
  const fixture = await hubFixture();
  const first = await registered(fixture);
  const long = `<script>${"x".repeat(5000)}`;
  first.tap.incoming = (m) => (m.type === "pending.denied" ? null : m);
  const denied = first.deny("id");
  inject(first, { type: "error", for: "pending.deny", code: long });
  await assert.rejects(denied, (e) => e.code.length <= 64 && e.message.length < 120 && !e.message.includes("<"));
  const proto = first.deny("id");
  inject(first, { type: "error", for: "pending.deny", code: "constructor" });
  await assert.rejects(proto, (e) => e.status === 502 && /constructor/.test(e.message));
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
  await approver.approve(row.id, { code, role: "full" });
  await until(() => newcomer.status().phase === "approved", "approved after the second review");
});

// A fake account the hub could hand a new device: it knows the device's public key, so it can list it.
async function fakeAccountAdding(newcomer) {
  const attacker = { ...(await newDeviceKeys({ extractable: true })), name: "Attacker", kind: "desktop" };
  const recovery = await newDeviceKeys({ extractable: true });
  const entries = await createLog({ device: attacker, recovery });
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
  await until(() => newcomer.status().pending?.code, "the code");
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
  await until(() => newcomer.status().pending?.code, "the code");
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
  inject(newcomer, { type: "approval.msg", from: stranger.signPub, opaque: JSON.stringify({ v: FRAME_VERSION, t: "commit", commit, logHead: "head" }) });
  await sleep(50);
  assert.equal(newcomer.status().pending.attempts, 1);
  newcomer.restartExchange();
  assert.equal(newcomer.status().pending.failed, false);
  inject(newcomer, { type: "approval.msg", from: stranger.signPub, opaque: JSON.stringify({ v: FRAME_VERSION, t: "commit", commit, logHead: "head" }) });
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
  const stranger = await newDeviceKeys({ extractable: true });
  const commit = toB64(new Uint8Array(32).fill(4));
  for (let i = 0; i < 6; i++) inject(newcomer, { type: "approval.msg", from: stranger.signPub, opaque: JSON.stringify({ v: FRAME_VERSION, t: "commit", commit, logHead: "head" }) });
  await sleep(50);
  assert.equal(newcomer.status().pending.attempts, 1);
  assert.equal(newcomer.status().pending.code, code);
  assert.equal(newcomer.status().pending.confirmed, true);
  await approver.approve(row.id, { code: review.code, role: "full" });
  await until(() => newcomer.status().phase === "approved", "the real approval still lands");
});

test("the confirmed code is not stored, and a restart between confirming and the approval still lands", async () => {
  const fixture = await hubFixture();
  const approver = await registered(fixture);
  const newcomer = makeAccount(fixture);
  await newcomer.signIn({ email: EMAIL, password: PASSWORD, name: "Laptop" });
  const row = await until(() => approver.pendingSignIns().find((r) => r.name === "Laptop"), "the card");
  const review = await approver.review(row.id);
  const code = await until(() => newcomer.status().pending?.code, "the code");
  const stored = await until(() => { try { const s = JSON.parse(readFileSync(join(newcomer.dir, "state.json"), "utf8")); return s.exchange ? s : null; } catch { return null; } }, "the confirmation on disk");
  assert.equal(stored.exchange.code, undefined);
  for (const content of onDisk(newcomer.dir)) assert.ok(!content.includes(`"${code}"`), "the code is on no file in that window");
  await newcomer.stop();
  const again = makeAccount(fixture, { dir: newcomer.dir });
  await again.start();
  await until(() => again.status().hub.connected, "reconnected");
  assert.equal(again.status().pending.code, null);
  assert.equal(again.status().pending.confirmed, true);
  await approver.approve(row.id, { code: review.code, role: "full" });
  await until(() => again.status().phase === "approved", "approved after the restart");
  assert.equal(again.alerts.filter((a) => a.kind === "fake-log").length, 0);
});

test("one tap: the code shows on the new device with nothing to press, and it lands when the approver approves", async () => {
  const fixture = await hubFixture();
  const approver = await registered(fixture);
  const newcomer = makeAccount(fixture);
  const asked = [];
  newcomer.tap.outgoing = (m) => { asked.push(m.type); return m; };
  await newcomer.signIn({ email: EMAIL, password: PASSWORD, name: "Laptop" });
  const row = await until(() => approver.pendingSignIns().find((r) => r.name === "Laptop"), "the card");
  const review = await approver.review(row.id);
  const code = await until(() => newcomer.status().pending?.code, "the code");
  assert.equal(code, review.code);
  assert.equal(typeof newcomer.confirmCode, "undefined", "there is no second confirmation to give");
  assert.ok(!asked.includes("log.get"), "and no log is asked for before the approval");
  await approver.approve(row.id, { code: review.code, role: "full" });
  await until(() => newcomer.status().phase === "approved", "approved");
  assert.equal(newcomer.status().logHead, approver.status().logHead);
  assert.equal(newcomer.alerts.length, 0);
});

test("one tap: an approval faster than the reveal's check is no false alarm", async () => {
  const fixture = await hubFixture();
  const approver = await registered(fixture);
  const newcomer = makeAccount(fixture);
  await newcomer.signIn({ email: EMAIL, password: PASSWORD, name: "Laptop" });
  const row = await until(() => approver.pendingSignIns().find((r) => r.name === "Laptop"), "the card");
  // Approving in the same breath as the code appearing, with nobody reading anything.
  const review = await approver.review(row.id);
  await approver.approve(row.id, { code: review.code, role: "client" });
  await until(() => newcomer.status().phase === "approved", "approved");
  assert.equal(newcomer.alerts.length, 0);
});

/** A hacked hub playing the approver for this device: a real exchange, with its own key, over the head of its own log. */
async function hubPlaysApprover(newcomer, approverKeys, head) {
  const exchange = await approverExchange({ approverPub: approverKeys.signPub, newPub: newcomer.status().device.id, logHead: head });
  const random = new Promise((resolve) => {
    const before = newcomer.tap.outgoing;
    newcomer.tap.outgoing = (m) => {
      if (m.type === "approval.msg" && JSON.parse(m.opaque).t === "random") { resolve(JSON.parse(m.opaque).random); return null; }
      return before ? before(m) : m;
    };
  });
  inject(newcomer, { type: "approval.msg", from: approverKeys.signPub, opaque: encodeOuter({ t: "commit", commit: exchange.commit, logHead: head }) });
  exchange.receiveRandom(await random);
  inject(newcomer, { type: "approval.msg", from: approverKeys.signPub, opaque: encodeOuter({ t: "reveal", random: exchange.revealRandom() }) });
}

test("hacked hub: playing the approver alone, with a made-up account, gets nowhere though nobody presses anything", async () => {
  const fixture = await hubFixture();
  await registered(fixture);
  const newcomer = makeAccount(fixture);
  await newcomer.signIn({ email: EMAIL, password: PASSWORD, name: "Laptop" });
  await until(() => newcomer.status().hub.connected, "connected");
  const fake = await fakeAccountAdding(newcomer);
  await hubPlaysApprover(newcomer, fake.attacker, fake.head);
  const code = await until(() => newcomer.status().pending?.code, "the code from the hub's own exchange");
  assert.match(code, /^\d{6}$/);
  // Every check of the exchange passed, and the add follows the head in the code, signed by the key in the code.
  const entries = await fake.withDevice();
  assert.equal(entries.at(-1).prev, fake.head);
  assert.equal(entries.at(-1).signer, fake.attacker.signPub);
  newcomer.tap.incoming = (m) => (m.type === "error" && m.for === "log.get" ? { type: "log", entries, head: "x", version: entries.length } : m);
  inject(newcomer, { type: "session.approved" });
  await until(() => newcomer.alerts.some((a) => a.kind === "fake-log"), "the alert");
  assert.equal(newcomer.status().phase, "pending", "it is not the account the password vouched for");
  assert.equal(newcomer.status().logHead, null);
  assert.deepEqual(newcomer.devices(), []);
});

test("hacked hub: an account made up for this password cannot get past sign-in, with no anchor, another's, or one for another id", async () => {
  const fixture = await hubFixture();
  await registered(fixture);
  const made = randomBytes(16).toString("base64");
  for (const lie of [{ anchor: null }, { anchor: randomBytes(32).toString("base64") }, { accountId: made }, { accountId: undefined, anchor: undefined }]) {
    const newcomer = makeAccount(fixture, { fetchImpl: async (url, init) => {
      const r = await fetch(url, init);
      if (!String(url).endsWith("/api/login")) return r;
      return new Response(JSON.stringify({ ...await r.json(), ...lie }), { status: r.status });
    } });
    await assert.rejects(newcomer.signIn({ email: EMAIL, password: PASSWORD, name: "Laptop" }), (e) => e.code === "bad-anchor", JSON.stringify(lie));
    assert.equal(newcomer.status().phase, "signed-out");
    assert.equal(newcomer.status().hub.connected, false);
    assert.ok(newcomer.alerts.some((a) => a.kind === "bad-anchor"));
    assert.ok(!existsSync(join(newcomer.dir, "session.json")), "no session is kept from it");
  }
});

test("the hub never sees what vouches for an account: not the anchor key, and the anchor differs from the login key", async () => {
  const fixture = await hubFixture();
  const sent = [];
  const account = makeAccount(fixture, { fetchImpl: async (url, init) => { sent.push(init.body); return fetch(url, init); } });
  writeBootstrap(account.dir);
  await account.register({ email: EMAIL, password: PASSWORD, name: "First" });
  const { anchorKey, loginKey } = await quickKey(PASSWORD, fromB64(JSON.parse(sent.find((b) => b.includes("firstLogEntry"))).salt));
  const everything = sent.join("\n");
  assert.ok(everything.includes(toB64(loginKey)), "the login key does cross, as it always did");
  assert.ok(!everything.includes(toB64(anchorKey)), "the anchor key never does");
});

test("a changed password goes on vouching for the account: a new device signs in with the new one, and joins", async () => {
  const fixture = await hubFixture();
  const approver = await registered(fixture);
  await approver.changePassword({ current: PASSWORD, next: "a whole new long password" });
  const newcomer = makeAccount(fixture);
  await newcomer.signIn({ email: EMAIL, password: "a whole new long password", name: "Laptop" });
  await approveNewDevice(approver, newcomer);
  assert.equal(newcomer.status().phase, "approved");
});

test("the account a sign-in was vouched for survives a restart, and still decides what is adopted", async () => {
  const fixture = await hubFixture();
  await registered(fixture);
  const newcomer = makeAccount(fixture);
  await newcomer.signIn({ email: EMAIL, password: PASSWORD, name: "Laptop" });
  await until(() => newcomer.status().hub.connected, "connected");
  const fake = await fakeAccountAdding(newcomer);
  await hubPlaysApprover(newcomer, fake.attacker, fake.head);
  await until(() => newcomer.status().pending?.code, "the code");
  await until(() => { try { return JSON.parse(readFileSync(join(newcomer.dir, "state.json"), "utf8")).exchange; } catch { return null; } }, "the exchange on disk");
  await newcomer.stop();
  const again = makeAccount(fixture, { dir: newcomer.dir });
  await again.start();
  await until(() => again.status().hub.connected, "reconnected");
  const entries = await fake.withDevice();
  again.tap.incoming = (m) => (m.type === "error" && m.for === "log.get" ? { type: "log", entries, head: "x", version: entries.length } : m);
  inject(again, { type: "session.approved" });
  await until(() => again.alerts.some((a) => a.kind === "fake-log"), "the alert");
  assert.equal(again.status().phase, "pending");
});

/*
 * THE ACCEPTED LIMIT, decided by the owner on 2026-11-09 (PLAN-accounts-v2.md, decision 1) and stated in docs/accounts.md and on
 * the approval card. This test documents it: it passes because the attack WORKS. If it starts failing because the attack fails,
 * that is good news, and the card and the docs can say less.
 *
 * Comparing the code is no longer forced. A hacked hub can show the approver a card for a device of its own while the person is
 * signing in somewhere else. Every automatic check passes, because the approver really is talking to a device with that key. Only
 * the person can notice: the code on their card is not the code on their new device.
 */
test("ACCEPTED LIMIT: someone who approves without glancing at the code can let in a hacked hub's device", async () => {
  const fixture = await hubFixture();
  const approver = await registered(fixture);
  const person = makeAccount(fixture);
  await person.signIn({ email: EMAIL, password: PASSWORD, name: "Laptop" });
  await until(() => person.status().hub.connected, "the person's real new device");

  // The hub puts its own key on the card in place of the person's, and answers for it.
  const mallory = await newDeviceKeys({ extractable: true });
  const realKey = person.status().device.id;
  const myKey = approver.status().device.id;
  approver.tap.incoming = (m) => (m.type === "pending.list" ? { ...m, pending: m.pending.map((r) => (r.signPub === realKey ? { ...r, signPub: mallory.signPub } : r)) } : m);
  approver.tap.outgoing = (m) => {
    if (m.type !== "approval.msg" || m.to !== mallory.signPub) return m;
    const outer = JSON.parse(m.opaque);
    if (outer.t === "commit") {
      (async () => {
        const core = await newDeviceExchange({ approverPub: myKey, newPub: mallory.signPub, logHead: outer.logHead });
        core.receiveCommit(outer.commit);
        const claim = { name: "Laptop", kind: "desktop", boxPub: mallory.boxPub };
        const sig = await sign(mallory.sign.privateKey, signedClaimBytes(claim, outer.logHead, myKey));
        inject(approver, { type: "approval.msg", from: mallory.signPub, opaque: encodeOuter({ t: "random", random: core.releaseRandom(), claim, sig }) });
      })();
    }
    return null;
  };
  approver.tap.sockets.at(-1).real.send(JSON.stringify({ type: "pending.list" }));
  const row = await until(() => approver.pendingSignIns().find((r) => r.signPub === mallory.signPub), "the hub's card");
  assert.equal(row.name, "Laptop", "to the person it looks like the sign-in they just started");

  const review = await approver.review(row.id);
  assert.match(review.code, /^\d{6}$/, "every automatic check passed");
  assert.notEqual(person.status().pending?.code, review.code, "this is the only thing that gives it away: the person's own screen shows another code, or none");

  // One tap, without a glance.
  await approver.approve(row.id, { code: review.code, role: "full" });
  const admitted = approver.devices().find((d) => d.id === mallory.signPub);
  assert.equal(admitted?.role, "full", "the hub's device is on the account, with the role the person chose");
  assert.ok(!approver.devices().some((d) => d.id === realKey), "and the person's own device is not");
  assert.equal(person.status().phase, "pending", "which is still waiting");
});

test("what that limit does not reach: a stolen password alone adds nothing, and a device cannot be added with no tap", async () => {
  const fixture = await hubFixture();
  const approver = await registered(fixture);
  const thief = makeAccount(fixture);
  await thief.signIn({ email: EMAIL, password: PASSWORD, name: "Looks fine" });
  const row = await until(() => approver.pendingSignIns().find((r) => r.name === "Looks fine"), "the card");
  const review = await approver.review(row.id);
  assert.equal(approver.status().logVersion, 1, "showing the code signs nothing");
  await sleep(100);
  assert.equal(approver.status().logVersion, 1);
  assert.equal(thief.status().phase, "pending");
  await approver.deny(row.id);
  await until(() => thief.status().phase === "denied", "denied");
  await assert.rejects(approver.approve(row.id, { code: review.code, role: "full" }), (e) => e.status === 409);
  assert.equal(approver.status().logVersion, 1);
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
  const theirs = await createLog({ device: stranger, recovery });
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

test("hacked hub: a flood of forgeable alerts evicts nothing that matters, and stays small", async () => {
  const fixture = await hubFixture();
  const { first, second, tap } = await pairWithTap(fixture);
  const old = JSON.parse(readFileSync(join(first.dir, "log.json"), "utf8")).slice(0, 1);
  tap.incoming = (m) => (m.type === "log" ? { ...m, entries: old, head: "old", version: 1 } : m);
  inject(second, { type: "log.updated", head: "old", version: 1 });
  const rollback = await until(() => second.status().alerts.find((a) => a.kind === "rollback"), "the rollback alert");
  tap.incoming = undefined;
  // Public data only: a hello from a device on the log, with a new channel id each time and a proof that fails.
  const from = first.status().device.id;
  const eph = (await newDeviceKeys({ extractable: true })).boxPub;
  const proof = toB64(new Uint8Array(64).fill(1));
  let order = 0;
  second.limits.maxChannelsPerDevice = 1000;
  second.limits.maxChannels = 1000;
  for (let round = 0; round < 60; round++) {
    const c = toB64(new Uint8Array(16).fill(round, 0, 8).fill(++order, 8));
    inject(second, { type: "channel.msg", from, opaque: JSON.stringify({ v: FRAME_VERSION, c, t: "hello", eph, logHead: second.status().logHead }) });
    inject(second, { type: "channel.msg", from, opaque: JSON.stringify({ v: FRAME_VERSION, c, t: "proof", proof }) });
    await sleep(1);
  }
  const flood = await until(() => { const row = second.status().alerts.find((a) => a.kind === "channel-failure"); return row?.count >= 60 ? row : null; }, "the flood counted");
  assert.equal(second.status().alerts.filter((a) => a.kind === "channel-failure").length, 1, "one row");
  assert.ok(flood.count >= 60);
  assert.ok(second.status().alerts.some((a) => a.key === rollback.key), "still there");
  const raised = second.alerts.filter((a) => a.kind === "rollback").length;
  tap.incoming = (m) => (m.type === "log" ? { ...m, entries: old, head: "old", version: 1 } : m);
  inject(second, { type: "log.updated", head: "old2", version: 1 });
  await until(() => second.status().alerts.find((a) => a.key === rollback.key).count === 2, "the same rollback counted, not raised again");
  assert.equal(second.alerts.filter((a) => a.kind === "rollback").length, raised);
  tap.incoming = undefined;
  await second.stop();
  const again = makeAccount(fixture, { dir: second.dir });
  await again.start();
  assert.ok(again.status().alerts.some((a) => a.key === rollback.key), "and it survives a restart");
});

test("hacked hub: endless new logs cannot grow the alert list without end", async () => {
  const fixture = await hubFixture();
  const { second, tap } = await pairWithTap(fixture);
  for (let i = 0; i < 12; i++) {
    const stranger = { ...(await newDeviceKeys({ extractable: true })), name: "S", kind: "desktop" };
    const theirs = await createLog({ device: stranger, recovery: await newDeviceKeys({ extractable: true }) });
    tap.incoming = (m) => (m.type === "log" ? { ...m, entries: theirs, head: `t${i}`, version: 1 } : m);
    inject(second, { type: "log.updated", head: `t${i}`, version: 1 });
    await until(() => second.status().alerts.filter((a) => a.kind === "different-account").reduce((sum, a) => sum + a.count, 0) === i + 1, `round ${i}`);
  }
  assert.equal(second.status().alerts.filter((a) => a.kind === "different-account").length, 8);
});

test("a damaged settings file turns web page access off, says so, and choosing again clears it", async () => {
  const fixture = await hubFixture();
  const first = await registered(fixture);
  await first.stop();
  for (const bad of ["{nope", "null", JSON.stringify({ allowWebAccess: "yes" }), "[]"]) {
    writeFileSync(join(first.dir, "settings.json"), bad);
    const again = makeAccount(fixture, { dir: first.dir });
    await again.start();
    assert.equal(again.settings().allowWebAccess, false, bad);
    assert.ok(again.status().warnings.some((w) => /Allow web page access is off/.test(w)), bad);
    await again.stop();
  }
  const again = makeAccount(fixture, { dir: first.dir });
  await again.start();
  await again.setSettings({ allowWebAccess: true });
  assert.ok(!again.status().warnings.some((w) => /Allow web page access is off/.test(w)));
  assert.equal(again.settings().allowWebAccess, true);
});

test("damaged saved alerts are said to be missing", async () => {
  const fixture = await hubFixture();
  const first = await registered(fixture);
  await first.stop();
  writeFileSync(join(first.dir, "alerts.json"), "{nope");
  const again = makeAccount(fixture, { dir: first.dir });
  await again.start();
  assert.ok(again.status().warnings.some((w) => /alerts could not be read/.test(w)));
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
  inject(first, { type: "channel.msg", from: stranger.signPub, opaque: JSON.stringify({ v: FRAME_VERSION, c: toB64(new Uint8Array(16).fill(1)), t: "hello", eph: stranger.boxPub, logHead: "x" }) });
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
  await until(() => first.status().channels.length === 1, "the host's end of the channel");
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

test("handshake: a timeout while fetching the log closes the channel without a false alert", async () => {
  const fixture = await hubFixture();
  const first = await registered(fixture, { name: "First" });
  const second = await joined(fixture, first, { name: "Second", limits: { handshakeTimeoutMs: 60, rpcTimeoutMs: 180 } });
  const { tap } = second;
  first.on("channel", (c) => serveChannel(c, (req, res) => res.end("x"), { device: c.peer, audit() {} }));
  tap.incoming = (m) => (m.type === "log.updated" ? null : m);
  await joined(fixture, first, { name: "Third" });
  tap.incoming = (m) => (m.type === "log.updated" || m.type === "log" ? null : m);
  await assert.rejects(second.openChannel(first.status().device.id), /did not finish/);
  await sleep(250);
  assert.ok(!second.alerts.some((a) => a.kind === "log-unreconciled"));
});

test("the handshake outlasts a log fetch by default", () => {
  const account = new Account({ dir: freshDir(), hubUrl: "https://tomcamp.tech" });
  assert.ok(account.limits.handshakeTimeoutMs > account.limits.rpcTimeoutMs);
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
  const hello = (i) => ({ type: "channel.msg", from, opaque: JSON.stringify({ v: FRAME_VERSION, c: toB64(new Uint8Array(16).fill(i)), t: "hello", eph, logHead: first.status().logHead }) });
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
  const theirs = await createLog({ device: fake, recovery: otherRecovery });
  const tap = {};
  let appended = false;
  tap.incoming = (m) => (m.type === "log" ? { ...m, entries: theirs, head: "t", version: 1 } : m);
  tap.outgoing = (m) => { if (m.type === "log.append") appended = true; return m; };
  const lost = makeAccount(fixture, { WebSocketImpl: tappedSocket(tap) });
  await assert.rejects(lost.recover({ email: EMAIL, password: PASSWORD, recoveryCode: first.recoveryCode, name: "New" }), (e) => e.status === 403);
  assert.equal(appended, false);
});

test("recovery: a local failure at any step after the hub rotated the key still returns the new code", async () => {
  for (const blocked of ["log.json", "state.json"]) {
    const fixture = await hubFixture();
    const first = await registered(fixture, { name: "First" });
    const fresh = makeAccount(fixture);
    await fresh.start();
    mkdirSync(fresh.dir, { recursive: true });
    mkdirSync(join(fresh.dir, blocked));
    const out = await fresh.recover({ email: EMAIL, password: PASSWORD, recoveryCode: first.recoveryCode, name: "New" });
    assert.ok(out.recoveryCode, blocked);
    assert.equal(out.confirmed, true);
    assert.equal(fresh.status().phase, "approved", blocked);
    assert.ok(fresh.status().warnings.some((w) => /could not save/.test(w)), blocked);
    const next = makeAccount(fixture);
    await next.recover({ email: EMAIL, password: PASSWORD, recoveryCode: out.recoveryCode, name: "Newer" });
    assert.equal(next.status().phase, "approved", "the code returned is the live one");
  }
});

test("recovery: killed right after the hub took it, a restart resumes on the candidate and says the code is gone", async () => {
  const fixture = await hubFixture();
  const first = await registered(fixture, { name: "First" });
  const killedDir = join(freshDir(), "account");
  const fresh = makeAccount(fixture);
  fresh.tap.incoming = (m) => {
    if (m.type === "log.ok") { cpSync(fresh.dir, killedDir, { recursive: true }); fresh.tap.sockets.at(-1).real.close(); return null; }
    return m;
  };
  await fresh.recover({ email: EMAIL, password: PASSWORD, recoveryCode: first.recoveryCode, name: "New" }).catch(() => {});
  await fresh.stop();
  const after = makeAccount(fixture, { dir: killedDir });
  await after.start();
  await until(() => after.status().phase === "approved", "resumed");
  assert.equal(after.status().recoveryUnconfirmed, true);
  assert.ok(after.status().logVersion >= 2);
  assert.equal(after.status().recoveryCodePending, true);
  const { recoveryCode, confirmed } = await after.showRecoveryCode();
  assert.equal(confirmed, true);
  await after.recoveryCodeSaved();
  assert.equal(after.status().recoveryCodePending, false);
  assert.ok(!existsSync(join(killedDir, "recovery-code.json")));
  const proof = makeAccount(fixture);
  await proof.recover({ email: EMAIL, password: PASSWORD, recoveryCode, name: "Proof" });
  assert.equal(proof.status().phase, "approved", "the stored code is the live one");
});

test("recovery: killed before sending, a restart sends it again, and the stored code is the live one", async () => {
  const fixture = await hubFixture();
  const first = await registered(fixture, { name: "First" });
  const killedDir = join(freshDir(), "account");
  const fresh = makeAccount(fixture);
  fresh.tap.outgoing = (m) => {
    if (m.type === "log.append") { cpSync(fresh.dir, killedDir, { recursive: true }); fresh.tap.sockets.at(-1).real.close(); return null; }
    return m;
  };
  await fresh.recover({ email: EMAIL, password: PASSWORD, recoveryCode: first.recoveryCode, name: "New" }).catch(() => {});
  await fresh.stop();
  const after = makeAccount(fixture, { dir: killedDir });
  await after.start();
  assert.equal(after.status().recoveryCodePending, true);
  const { recoveryCode } = await after.showRecoveryCode();
  await until(() => after.status().phase === "approved", "settled");
  assert.deepEqual(await after.showRecoveryCode(), { recoveryCode, confirmed: true });
  const other = makeAccount(fixture);
  await other.recover({ email: EMAIL, password: PASSWORD, recoveryCode, name: "Other" });
  assert.equal(other.status().phase, "approved");
});

test("recovery: an error reply to the send is no proof of anything: the code is kept in doubt; an unsaved code blocks a second recovery", async () => {
  const fixture = await hubFixture();
  const first = await registered(fixture, { name: "First" });
  // A hub that appended, then answers with an error.
  const lying = makeAccount(fixture);
  lying.tap.incoming = (m) => (m.type === "log.ok" ? { type: "error", for: "log.append", code: "internal" } : m);
  const answer = await lying.recover({ email: EMAIL, password: PASSWORD, recoveryCode: first.recoveryCode, name: "New" });
  assert.equal(answer.confirmed, false);
  assert.equal(lying.status().recoveryCodePending, true);
  assert.equal((await lying.showRecoveryCode()).recoveryCode, answer.recoveryCode);
  lying.tap.incoming = undefined;
  await until(() => lying.status().phase === "approved", "the next connection shows it landed");
  assert.deepEqual(await lying.showRecoveryCode(), { recoveryCode: answer.recoveryCode, confirmed: true });

  const malformed = makeAccount(fixture);
  await assert.rejects(malformed.recover({ email: EMAIL, password: PASSWORD, recoveryCode: "0000-0000-0000", name: "x" }), (e) => e.status === 400);
  assert.equal(malformed.status().recoveryCodePending, false, "a malformed code stores nothing");

  const good = makeAccount(fixture);
  const out = await good.recover({ email: EMAIL, password: PASSWORD, recoveryCode: answer.recoveryCode, name: "Good" });
  assert.equal(good.status().recoveryCodePending, true);
  await good.signOut();
  await assert.rejects(good.recover({ email: EMAIL, password: PASSWORD, recoveryCode: out.recoveryCode, name: "Again" }), (e) => e.status === 409 && e.code === "recovery-code-pending");
  assert.equal((await good.showRecoveryCode()).recoveryCode, out.recoveryCode, "the unsaved code survives the attempt");
});

async function killedRecovery(fixture, first, { keep = (m) => m.type === "log.ok" } = {}) {
  const killedDir = join(freshDir(), "account");
  const fresh = makeAccount(fixture);
  fresh.tap.incoming = (m) => {
    if (keep(m)) { cpSync(fresh.dir, killedDir, { recursive: true }); fresh.tap.sockets.at(-1).real.close(); return null; }
    return m;
  };
  await fresh.recover({ email: EMAIL, password: PASSWORD, recoveryCode: first.recoveryCode, name: "New" }).catch(() => {});
  await fresh.stop();
  return killedDir;
}

test("hacked hub: an older log at settlement deletes nothing, is shown as a rollback, and a later honest answer settles it", async () => {
  const fixture = await hubFixture();
  const first = await registered(fixture, { name: "First" });
  const oldLog = JSON.parse(readFileSync(join(first.dir, "log.json"), "utf8"));
  const killedDir = await killedRecovery(fixture, first);
  const after = makeAccount(fixture, { dir: killedDir, limits: { settleRetryMs: 120 } });
  after.tap.incoming = (m) => (m.type === "log" ? { ...m, entries: oldLog, head: "old", version: oldLog.length } : m);
  await after.start();
  await until(() => after.status().recoveryContested, "contested");
  assert.ok(after.alerts.some((a) => a.kind === "rollback"));
  assert.equal(after.status().recoveryCodePending, true);
  const { recoveryCode, confirmed } = await after.showRecoveryCode();
  assert.equal(confirmed, false);
  assert.doesNotMatch(after.status().hub.lastError, /still works/);
  assert.match(after.status().hub.lastError, /Keep every recovery code/);
  assert.equal(after.status().phase, "recovering");
  after.tap.incoming = undefined;
  await until(() => after.status().phase === "approved", "the hub stopped lying");
  assert.equal(after.status().recoveryContested, false);
  assert.equal(after.status().hub.lastError, null);
  assert.deepEqual(await after.showRecoveryCode(), { recoveryCode, confirmed: true });
  const proof = makeAccount(fixture);
  await proof.recover({ email: EMAIL, password: PASSWORD, recoveryCode, name: "Proof" });
  assert.equal(proof.status().phase, "approved", "it was the live code all along");
});

test("hacked hub: a fork or another account's log at settlement deletes nothing, and the person may then say they saved it", async () => {
  for (const kind of ["fork", "different-account", "bad-log"]) {
    const fixture = await hubFixture();
    const first = await registered(fixture, { name: "First" });
    const entries = JSON.parse(readFileSync(join(first.dir, "log.json"), "utf8"));
    const other = await newDeviceKeys({ extractable: true });
    const stranger = { ...(await newDeviceKeys({ extractable: true })), name: "S", kind: "desktop" };
    const lie = kind === "fork" ? await append(entries, { type: "add", name: "F", kind: "desktop", role: "full", signPub: other.signPub, boxPub: other.boxPub }, await keysOf(first))
      : kind === "different-account" ? await createLog({ device: stranger, recovery: await newDeviceKeys({ extractable: true }) })
      : [{ nonsense: 1 }];
    const killedDir = await killedRecovery(fixture, first);
    const after = makeAccount(fixture, { dir: killedDir });
    after.tap.incoming = (m) => (m.type === "log" ? { ...m, entries: lie, head: "x", version: lie.length } : m);
    await after.start();
    await until(() => after.status().recoveryContested, kind);
    assert.ok(after.alerts.some((a) => a.kind === kind), kind);
    assert.equal(after.status().recoveryCodePending, true, kind);
    assert.ok(existsSync(join(killedDir, "recovery-code.json")), kind);
    await after.recoveryCodeSaved();
    assert.equal(after.status().recoveryCodePending, false, kind);
    const kept = JSON.parse(readFileSync(join(killedDir, "recovery-code.json"), "utf8"));
    assert.equal(kept.state, "saved-unsettled", "the candidate stays, in case the hub comes round");
    assert.equal(kept.data, "", "but not the code");
  }
});

test("hacked hub: a contradiction after the person saved an unsettled code is shown in status, clears on sign-out, and an honest answer still settles it", async () => {
  const fixture = await hubFixture();
  const first = await registered(fixture, { name: "First" });
  const oldLog = JSON.parse(readFileSync(join(first.dir, "log.json"), "utf8"));
  const killedDir = await killedRecovery(fixture, first);
  const after = makeAccount(fixture, { dir: killedDir, limits: { settleRetryMs: 60 } });
  after.tap.incoming = (m) => (m.type === "log" ? { ...m, entries: oldLog, head: "old", version: oldLog.length } : m);
  await after.start();
  await until(() => after.status().recoveryContested, "contested");
  await after.recoveryCodeSaved();
  assert.equal(after.status().recoveryContested, false, "saved: the person decided");
  const rollbacks = () => after.status().alerts.find((a) => a.kind === "rollback")?.count ?? 0;
  const seen = rollbacks();
  await until(() => after.status().recoveryContested, "the hub contradicts it again, and status says so");
  assert.ok(rollbacks() > seen, "it was a fresh contradiction");
  assert.equal(after.status().recoveryCodePending, false);
  assert.match(after.status().hub.lastError, /do not match this recovery code/);
  assert.equal(after.status().phase, "recovering");
  const stateOnDisk = () => JSON.parse(readFileSync(join(killedDir, "recovery-code.json"), "utf8")).state;
  await until(() => stateOnDisk() === "saved-contested", "the state on disk");
  await after.signOut();
  assert.equal(after.status().recoveryContested, false);
  assert.equal(after.status().hub.lastError, null);
  assert.equal(JSON.parse(readFileSync(join(killedDir, "recovery-code.json"), "utf8")).state, "saved-unsettled");
  after.tap.incoming = undefined;
  await after.signIn({ email: EMAIL, password: PASSWORD });
  await until(() => after.status().phase === "approved", "the honest log settles the held candidate");
  assert.ok(!existsSync(join(killedDir, "recovery-code.json")));
  assert.equal(after.status().recoveryContested, false);
});

test("hacked hub: 'not on the log' at settlement of a registration deletes nothing", async () => {
  const fixture = await hubFixture();
  const killedDir = join(freshDir(), "account");
  const account = makeAccount(fixture, { fetchImpl: async (url, init) => {
    const reply = await fetch(url, init);
    if (String(url).endsWith("/api/register")) { cpSync(account.dir, killedDir, { recursive: true }); throw new Error("killed"); }
    return reply;
  } });
  writeBootstrap(account.dir);
  await assert.rejects(account.register({ email: EMAIL, password: PASSWORD, name: "First" }));
  const after = makeAccount(fixture, { dir: killedDir });
  after.tap.incoming = (m) => (m.type === "auth.ok" ? { ...m, state: "pending" } : m);
  await after.start();
  await after.signIn({ email: EMAIL, password: PASSWORD });
  await until(() => after.status().recoveryContested, "contested");
  assert.equal(after.status().recoveryCodePending, true);
  assert.ok(!after.alerts.some((a) => a.kind === "fake-log"), "no false alarm from the approval path");
});

test("hacked hub: another account's log at settlement of a registration deletes nothing, and raises only what it should", async () => {
  const fixture = await hubFixture();
  const killedDir = join(freshDir(), "account");
  const account = makeAccount(fixture, { fetchImpl: async (url, init) => {
    const reply = await fetch(url, init);
    if (String(url).endsWith("/api/register")) { cpSync(account.dir, killedDir, { recursive: true }); throw new Error("killed"); }
    return reply;
  } });
  writeBootstrap(account.dir);
  await assert.rejects(account.register({ email: EMAIL, password: PASSWORD, name: "First" }));
  const after = makeAccount(fixture, { dir: killedDir });
  const stranger = { ...(await newDeviceKeys({ extractable: true })), name: "S", kind: "desktop" };
  const theirs = await createLog({ device: stranger, recovery: await newDeviceKeys({ extractable: true }) });
  after.tap.incoming = (m) => (m.type === "log" ? { ...m, entries: theirs, head: "t", version: 1 } : m);
  await after.start();
  await after.signIn({ email: EMAIL, password: PASSWORD });
  await until(() => after.status().recoveryContested, "contested");
  await sleep(50);
  assert.equal(after.status().recoveryCodePending, true);
  assert.ok(after.alerts.some((a) => a.kind === "different-account"));
  assert.ok(!after.alerts.some((a) => a.kind === "fake-log"), "a held candidate is not a device told it was approved out of nowhere");
  assert.equal(after.status().logHead, null);
});

test("settlement: no answer in time on a live socket reconnects and tries again", async () => {
  const fixture = await hubFixture();
  const first = await registered(fixture, { name: "First" });
  const killedDir = await killedRecovery(fixture, first);
  const after = makeAccount(fixture, { dir: killedDir, limits: { rpcTimeoutMs: 60 } });
  let swallowed = 0;
  after.tap.incoming = (m) => {
    if (m.type === "log" && swallowed < 2) { swallowed++; return null; }
    return m;
  };
  await after.start();
  await until(() => after.status().phase === "approved", "settled after the retries", 5000);
  assert.ok(swallowed >= 2);
  assert.ok(after.tap.sockets.length >= 2, "by reconnecting");
  assert.equal((await after.showRecoveryCode()).confirmed, true);
});

test("recovery: told 'conflict' by a hub that did append: the next log shows it landed, and the code stands", async () => {
  const fixture = await hubFixture();
  const first = await registered(fixture, { name: "First" });
  const fresh = makeAccount(fixture);
  let lied = false;
  fresh.tap.incoming = (m) => {
    if (m.type === "log.ok" && !lied) { lied = true; return { type: "log.conflict", entries: [], head: "x", version: 0 }; }
    return m;
  };
  const out = await fresh.recover({ email: EMAIL, password: PASSWORD, recoveryCode: first.recoveryCode, name: "New" });
  assert.equal(lied, true);
  assert.equal(out.confirmed, true);
  assert.equal(fresh.status().phase, "approved");
  const proof = makeAccount(fixture);
  await proof.recover({ email: EMAIL, password: PASSWORD, recoveryCode: out.recoveryCode, name: "Proof" });
  assert.equal(proof.status().phase, "approved");
});

test("recovery: only ever told 'conflict', the code is kept unconfirmed", async () => {
  const fixture = await hubFixture();
  const first = await registered(fixture, { name: "First" });
  const entries = JSON.parse(readFileSync(join(first.dir, "log.json"), "utf8"));
  const fresh = makeAccount(fixture);
  fresh.tap.outgoing = (m) => {
    if (m.type !== "log.append") return m;
    setImmediate(() => inject(fresh, { type: "log.conflict", entries, head: "x", version: 1 }));
    return null;
  };
  const out = await fresh.recover({ email: EMAIL, password: PASSWORD, recoveryCode: first.recoveryCode, name: "New" });
  assert.equal(out.confirmed, false);
  assert.ok(out.recoveryCode);
  assert.equal(fresh.status().recoveryCodePending, true);
});

test("register: a retry with a mistyped password does not cost the code of the attempt that landed", async () => {
  const fixture = await hubFixture();
  let lost = true;
  const account = makeAccount(fixture, { fetchImpl: async (url, init) => {
    const reply = await fetch(url, init);
    if (lost && String(url).endsWith("/api/register")) { lost = false; throw new Error("the answer was lost"); }
    return reply;
  } });
  writeBootstrap(account.dir);
  await assert.rejects(account.register({ email: EMAIL, password: PASSWORD, name: "First" }));
  const held = await account.showRecoveryCode();
  // Neither "closed to registration" nor a contest: a mistyped password says nothing about either.
  await assert.rejects(account.register({ email: EMAIL, password: "a mistyped long password", name: "First" }), (e) => e.status === 409 && e.code === "recovery-code-pending" && /did not accept that password/.test(e.message) && !/not open for registration/.test(e.message));
  assert.deepEqual(await account.showRecoveryCode(), held, "both files kept");
  assert.equal(account.status().recoveryContested, false);
  const out = await account.register({ email: EMAIL, password: PASSWORD, name: "First" });
  assert.equal(out.recoveryCode, held.recoveryCode);
  await until(() => account.status().phase === "approved", "signed in");
  assert.equal(account.status().recoveryContested, false);
  const proof = makeAccount(fixture);
  await proof.recover({ email: EMAIL, password: PASSWORD, recoveryCode: out.recoveryCode, name: "Proof" });
  assert.equal(proof.status().phase, "approved");
});

test("register: a double click gets a clean answer, not a plain error", async () => {
  const fixture = await hubFixture();
  const account = makeAccount(fixture);
  writeBootstrap(account.dir);
  const both = await Promise.allSettled([1, 2].map(() => account.register({ email: EMAIL, password: PASSWORD, name: "First" })));
  const refused = both.filter((r) => r.status === "rejected");
  assert.equal(refused.length, 1, "one of them lands");
  assert.equal(refused[0].reason.code, "recovery-code-pending");
  assert.equal(refused[0].reason.status, 409);
});

test("register: a live code whose candidate is gone is not called a recovery", async () => {
  const fixture = await hubFixture();
  const first = await registered(fixture, { name: "First" });
  assert.equal(first.status().recoveryCodePending, true);
  await first.stop();
  for (const name of ["log.json", "state.json", "session.json"]) await fsp.rm(join(first.dir, name), { force: true });
  const again = makeAccount(fixture, { dir: first.dir });
  await again.start();
  await assert.rejects(again.register({ email: EMAIL, password: "another long password", name: "First" }), (e) => e.code === "recovery-code-pending" && !/from a recovery/.test(e.message));
});

test("recovery: a send that never left this computer deletes the code, and the old one stands", async () => {
  const fixture = await hubFixture();
  const first = await registered(fixture, { name: "First" });
  const fresh = makeAccount(fixture);
  fresh.tap.outgoing = (m) => { if (m.type === "log.append") throw Object.assign(new Error("socket shut"), { code: "hub-unreachable" }); return m; };
  await assert.rejects(fresh.recover({ email: EMAIL, password: PASSWORD, recoveryCode: first.recoveryCode, name: "New" }));
  assert.equal(fresh.status().recoveryCodePending, false);
  assert.ok(!existsSync(join(fresh.dir, "recovery-code.json")));
  assert.equal(fresh.status().phase, "signed-out");
  const other = makeAccount(fixture);
  await other.recover({ email: EMAIL, password: PASSWORD, recoveryCode: first.recoveryCode, name: "Other" });
  assert.equal(other.status().phase, "approved");
});

/** Runs `work` on an account, killing the process's view of the disk at the n-th completed file write. */
async function killedAtWrite(account, n, killedDir, work) {
  const real = fsp.rename;
  let seen = 0, killed = false;
  fsp.rename = async function (from, to) {
    if (String(to).startsWith(account.dir)) {
      if (++seen === n && !killed) {
        killed = true;
        cpSync(account.dir, killedDir, { recursive: true });
        throw Object.assign(new Error("killed here"), { code: "EKILLED" });
      }
    }
    return real.call(this, from, to);
  };
  try { await work().catch(() => {}); } finally { fsp.rename = real; }
  await account.stop();
  return killed;
}

test("recovery: a kill at every file write: the person never ends up without a working code, and confirmed:true is never wrong", async () => {
  for (let n = 1; n < 40; n++) {
    const fixture = await hubFixture();
    const first = await registered(fixture, { name: "First" });
    const fresh = makeAccount(fixture);
    const killedDir = join(freshDir(), "account");
    const killed = await killedAtWrite(fresh, n, killedDir, () => fresh.recover({ email: EMAIL, password: PASSWORD, recoveryCode: first.recoveryCode, name: "New" }));
    if (!killed) {
      assert.ok(n > 3, "the test reached some writes");
      break;
    }
    const after = makeAccount(fixture, { dir: killedDir });
    await after.start();
    await sleep(120);
    const shown = after.status().recoveryCodePending ? await after.showRecoveryCode() : null;
    const works = async (code) => { const a = makeAccount(fixture); return a.recover({ email: EMAIL, password: PASSWORD, recoveryCode: code, name: "Proof" }).then(() => true, () => false); };
    if (shown?.confirmed) assert.equal(await works(shown.recoveryCode), true, `write ${n}: confirmed but dead`);
    else {
      const oldWorks = await works(first.recoveryCode);
      assert.ok(oldWorks || (shown && await works(shown.recoveryCode)), `write ${n}: no code works`);
    }
  }
});

test("register: a kill at every file write: if the account exists, its code is held and works", async () => {
  for (let n = 1; n < 40; n++) {
    const fixture = await hubFixture();
    const account = makeAccount(fixture);
    writeBootstrap(account.dir);
    await account.start();
    const killedDir = join(freshDir(), "account");
    const killed = await killedAtWrite(account, n, killedDir, () => account.register({ email: EMAIL, password: PASSWORD, name: "First" }));
    if (!killed) {
      assert.ok(n > 3, "the test reached some writes");
      break;
    }
    const exists = await makeAccount(fixture).signIn({ email: EMAIL, password: PASSWORD, name: "Asker" }).then(() => true, () => false);
    const after = makeAccount(fixture, { dir: killedDir });
    await after.start();
    if (!exists) continue;
    assert.equal(after.status().recoveryCodePending, true, `write ${n}: the account exists, and no code is held`);
    const { recoveryCode } = await after.showRecoveryCode();
    const proof = makeAccount(fixture);
    await proof.recover({ email: EMAIL, password: PASSWORD, recoveryCode, name: "Proof" });
    assert.equal(proof.status().phase, "approved", `write ${n}: the held code does not work`);
  }
});

test("contested survives a restart, so saved is not refused again; signing out clears the flag; a fresh recover starts clean", async () => {
  const fixture = await hubFixture();
  const first = await registered(fixture, { name: "First" });
  const oldLog = JSON.parse(readFileSync(join(first.dir, "log.json"), "utf8"));
  const killedDir = await killedRecovery(fixture, first);
  const lie = (m) => (m.type === "log" ? { ...m, entries: oldLog, head: "old", version: oldLog.length } : m);
  const a = makeAccount(fixture, { dir: killedDir });
  a.tap.incoming = lie;
  await a.start();
  await until(() => a.status().recoveryContested, "contested");
  await a.stop();
  const b = makeAccount(fixture, { dir: killedDir, hubUrl: "http://127.0.0.1:1" });
  await b.start();
  assert.equal(b.status().recoveryContested, true, "with no hub to ask at all");
  assert.equal(b.status().phase, "recovering");
  await until(() => /connection was lost/.test(b.status().hub.lastError), "the connection failure is shown as well");
  assert.match(b.status().hub.lastError, /do not match this recovery code/, "and so is the contradiction");
  const { recoveryCode } = await b.showRecoveryCode();
  await b.signOut();
  assert.equal(b.status().recoveryContested, false);
  assert.equal(b.status().hub.lastError, null);
  await assert.rejects(b.recoveryCodeSaved(), (e) => e.code === "not-settled");
  await b.stop();
  const c = makeAccount(fixture, { dir: killedDir });
  await c.start();
  assert.equal(c.status().recoveryContested, false, "still clear after a restart");
  assert.equal((await c.showRecoveryCode()).recoveryCode, recoveryCode);
  await c.stop();
});

test("saved while contested, signed out, then an honest recover with that code: it starts clean and the old attempt is not resent", async () => {
  const fixture = await hubFixture();
  const first = await registered(fixture, { name: "First" });
  const oldLog = JSON.parse(readFileSync(join(first.dir, "log.json"), "utf8"));
  const killedDir = await killedRecovery(fixture, first);
  const after = makeAccount(fixture, { dir: killedDir });
  after.tap.incoming = (m) => (m.type === "log" ? { ...m, entries: oldLog, head: "old", version: oldLog.length } : m);
  await after.start();
  await until(() => after.status().recoveryContested, "contested");
  const { recoveryCode } = await after.showRecoveryCode();
  await after.recoveryCodeSaved();
  await after.signOut();
  after.tap.incoming = undefined;
  assert.equal(after.status().recoveryContested, false);
  assert.equal(after.status().hub.lastError, null);
  const out = await after.recover({ email: EMAIL, password: PASSWORD, recoveryCode, name: "New again" });
  assert.deepEqual(out, { recoveryCode: null, confirmed: false, alreadyOnLog: true, codeUsed: false }, "the first recovery had landed, so none is needed, and the typed code was never checked");
  await until(() => after.status().phase === "approved", "the held candidate settles it");
  assert.equal(after.status().recoveryContested, false);
  assert.equal(after.status().hub.lastError, null);
  const proof = makeAccount(fixture);
  await proof.recover({ email: EMAIL, password: PASSWORD, recoveryCode, name: "Proof" });
  assert.equal(proof.status().phase, "approved", "and the saved code is the live one");
});

test("saved while contested on an attempt that never landed, then a new recover: the old attempt is replaced, not resent", async () => {
  const fixture = await hubFixture();
  const first = await registered(fixture, { name: "First" });
  const killedDir = join(freshDir(), "account");
  const fresh = makeAccount(fixture);
  fresh.tap.outgoing = (m) => {
    if (m.type === "log.append") { cpSync(fresh.dir, killedDir, { recursive: true }); fresh.tap.sockets.at(-1).real.close(); return null; }
    return m;
  };
  await fresh.recover({ email: EMAIL, password: PASSWORD, recoveryCode: first.recoveryCode, name: "New" }).catch(() => {});
  await fresh.stop();
  const after = makeAccount(fixture, { dir: killedDir });
  let appends = 0;
  after.tap.outgoing = (m) => {
    if (m.type !== "log.append") return m;
    appends++;
    setImmediate(() => inject(after, { type: "error", code: "invalid-entry", for: "log.append" }));
    return null;
  };
  await after.start();
  await until(() => after.status().recoveryContested, "contested");
  const stale = await after.showRecoveryCode();
  await after.recoveryCodeSaved();
  await after.signOut();
  const count = appends;
  after.tap.outgoing = undefined;
  const out = await after.recover({ email: EMAIL, password: PASSWORD, recoveryCode: first.recoveryCode, name: "New again" });
  assert.equal(appends, count);
  assert.equal(out.confirmed, true);
  assert.notEqual(out.recoveryCode, stale.recoveryCode);
  assert.deepEqual(await after.showRecoveryCode(), { recoveryCode: out.recoveryCode, confirmed: true });
  assert.equal(after.status().phase, "approved");
  assert.equal(after.status().recoveryContested, false);
});

test("an unsettled code counts as contested after ten minutes, so the person is not stuck", async () => {
  const fixture = await hubFixture();
  const first = await registered(fixture, { name: "First" });
  let clock = Date.now();
  const fresh = makeAccount(fixture, { now: () => clock, limits: { rpcTimeoutMs: 40 } });
  // The send gets no answer, and neither does any log.get afterwards.
  fresh.tap.incoming = (m) => (m.type === "log.ok" || m.type === "log.conflict" ? null : m);
  const out = await fresh.recover({ email: EMAIL, password: PASSWORD, recoveryCode: first.recoveryCode, name: "New" });
  assert.equal(out.confirmed, false);
  await assert.rejects(fresh.recoveryCodeSaved(), (e) => e.code === "not-settled");
  assert.equal(fresh.status().recoveryContested, false);
  clock += 10 * 60_000 - 1;
  assert.equal(fresh.status().recoveryContested, false);
  await assert.rejects(fresh.recoveryCodeSaved(), (e) => e.code === "not-settled");
  clock += 1;
  assert.equal(fresh.status().recoveryContested, true);
  assert.match(fresh.status().hub.lastError, /Keep every recovery code/);
  await fresh.recoveryCodeSaved();
  assert.equal(fresh.status().recoveryCodePending, false);
});

test("signing out starts the ten minutes again, so a stale code does not read as contested at once", async () => {
  const fixture = await hubFixture();
  const first = await registered(fixture, { name: "First" });
  let clock = Date.now();
  const fresh = makeAccount(fixture, { now: () => clock, limits: { rpcTimeoutMs: 40 } });
  fresh.tap.incoming = (m) => (m.type === "log.ok" || m.type === "log.conflict" ? null : m);
  await fresh.recover({ email: EMAIL, password: PASSWORD, recoveryCode: first.recoveryCode, name: "New" });
  clock += 11 * 60_000;
  assert.equal(fresh.status().recoveryContested, true);
  await fresh.signOut();
  assert.equal(fresh.status().recoveryContested, false);
  assert.equal(fresh.status().hub.lastError, null);
  clock += 10 * 60_000;
  assert.equal(fresh.status().recoveryContested, true, "and it is not stuck after that");
});

test("register: another email is refused while a code for the first is unsaved, so the first code cannot be overwritten", async () => {
  const fixture = await hubFixture();
  let lost = true;
  const account = makeAccount(fixture, { fetchImpl: async (url, init) => {
    const reply = await fetch(url, init);
    if (lost && String(url).endsWith("/api/register")) { lost = false; throw new Error("the answer was lost"); }
    return reply;
  } });
  writeBootstrap(account.dir);
  await assert.rejects(account.register({ email: EMAIL, password: PASSWORD, name: "First" }));
  const held = await account.showRecoveryCode();
  await assert.rejects(account.register({ email: "other@example.com", password: PASSWORD, name: "First" }), (e) => e.status === 409 && e.code === "recovery-code-pending" && /another email/.test(e.message));
  assert.deepEqual(await account.showRecoveryCode(), held);
});

test("register: an error from the hub keeps the code unless it shows nothing was created; closed says so plainly", async () => {
  // Accepted, then an unknown error.
  let fixture = await hubFixture();
  let account = makeAccount(fixture, { fetchImpl: async (url, init) => {
    const reply = await fetch(url, init);
    if (String(url).endsWith("/api/register")) return new Response(JSON.stringify({ error: "internal" }), { status: 500 });
    return reply;
  } });
  writeBootstrap(account.dir);
  await assert.rejects(account.register({ email: EMAIL, password: PASSWORD, name: "First" }), (e) => e.status === 500);
  assert.equal(account.status().recoveryCodePending, true);
  assert.equal(account.status().recoveryContested, true);
  const kept = await account.showRecoveryCode();
  const proof = makeAccount(fixture);
  await proof.recover({ email: EMAIL, password: PASSWORD, recoveryCode: kept.recoveryCode, name: "Proof" });
  assert.equal(proof.status().phase, "approved", "it was live");
  // Closed: nothing of this attempt is live.
  fixture = await hubFixture();
  account = makeAccount(fixture);
  mkdirSync(account.dir, { recursive: true });
  writeFileSync(join(account.dir, "bootstrap-token"), "wrong-token-0123456789");
  await assert.rejects(account.register({ email: EMAIL, password: PASSWORD, name: "x" }), (e) => e.code === "registration-closed" && /invite code is needed/.test(e.message));
  assert.equal(account.status().recoveryCodePending, false);
  assert.ok(!existsSync(join(account.dir, "recovery-code.json")));
});

test("recovery: if the code cannot be stored first, nothing is sent and the old code still works", async () => {
  const fixture = await hubFixture();
  const first = await registered(fixture, { name: "First" });
  const fresh = makeAccount(fixture);
  let sent = false;
  fresh.tap.outgoing = (m) => { if (m.type === "log.append") sent = true; return m; };
  await fresh.start();
  mkdirSync(join(fresh.dir, "recovery-code.json"), { recursive: true });
  await assert.rejects(fresh.recover({ email: EMAIL, password: PASSWORD, recoveryCode: first.recoveryCode, name: "New" }));
  assert.equal(sent, false);
  const other = makeAccount(fixture);
  await other.recover({ email: EMAIL, password: PASSWORD, recoveryCode: first.recoveryCode, name: "Other" });
  assert.equal(other.status().phase, "approved");
});

test("recovery: no answer after sending: the new code is returned unconfirmed, and the reconnect settles it either way", async () => {
  // It landed.
  let fixture = await hubFixture();
  let first = await registered(fixture, { name: "First" });
  let fresh = makeAccount(fixture);
  fresh.tap.incoming = (m) => (m.type === "log.ok" ? null : m);
  fresh.limits.rpcTimeoutMs = 100;
  let out = await fresh.recover({ email: EMAIL, password: PASSWORD, recoveryCode: first.recoveryCode, name: "New" });
  assert.ok(out.recoveryCode);
  assert.equal(out.confirmed, false);
  assert.equal(fresh.status().recoveryUnconfirmed, true);
  fresh.tap.incoming = undefined;
  assert.equal(fresh.status().recoveryCodePending, true);
  assert.equal((await fresh.showRecoveryCode()).confirmed, false, "it may not count yet");
  await assert.rejects(fresh.recoveryCodeSaved(), (e) => e.status === 409, "too soon to discard");
  await until(() => fresh.status().phase === "approved", "the hub had it");
  assert.equal((await fresh.showRecoveryCode()).confirmed, true);
  assert.equal((await fresh.showRecoveryCode()).recoveryCode, out.recoveryCode);
  // It did not land.
  fixture = await hubFixture();
  first = await registered(fixture, { name: "First" });
  fresh = makeAccount(fixture);
  fresh.tap.outgoing = (m) => (m.type === "log.append" ? null : m);
  fresh.limits.rpcTimeoutMs = 100;
  out = await fresh.recover({ email: EMAIL, password: PASSWORD, recoveryCode: first.recoveryCode, name: "New" });
  assert.equal(out.confirmed, false);
  fresh.tap.outgoing = undefined;
  // The reconnect sends the same signed entry again, so the code shown is the one that ends up counting.
  await until(() => fresh.status().phase === "approved", "the entry landed on the second try");
  assert.deepEqual(await fresh.showRecoveryCode(), { recoveryCode: out.recoveryCode, confirmed: true });
  const other = makeAccount(fixture);
  await other.recover({ email: EMAIL, password: PASSWORD, recoveryCode: out.recoveryCode, name: "Other" });
  assert.equal(other.status().phase, "approved");
});

test("recovery: a fake account built around the real recovery key is refused before anything is signed", async () => {
  const fixture = await hubFixture();
  const first = await registered(fixture, { name: "First" });
  const realRecovery = await recoveryKeysFrom(first.recoveryCode);
  // The public half is no secret, so a hub can put it in a create. It cannot sign for it.
  const attacker = { ...(await newDeviceKeys({ extractable: true })), name: "Attacker", kind: "desktop" };
  const [made] = await createLog({ device: attacker, recovery: await newDeviceKeys({ extractable: true }) });
  const body = { ...made.body, recoveryPub: realRecovery.signPub };
  const unsigned = { type: "create", index: 0, prev: "", signer: attacker.signPub, body };
  const forged = [{ ...unsigned, sig: await sign(attacker.sign.privateKey, entryBytes(unsigned)) }];
  assert.equal(await canRecover(forged, realRecovery.signPub), false);
  const withForeignSig = [{ ...forged[0], recoverySig: made.recoverySig }];
  assert.equal(await canRecover(withForeignSig, realRecovery.signPub), false);
  for (const entries of [forged, withForeignSig]) {
    const lost = makeAccount(fixture);
    let signed = false;
    lost.tap.incoming = (m) => (m.type === "log" ? { ...m, entries, head: "t", version: 1 } : m);
    lost.tap.outgoing = (m) => { if (m.type === "log.append") signed = true; return m; };
    await assert.rejects(lost.recover({ email: EMAIL, password: PASSWORD, recoveryCode: first.recoveryCode, name: "New" }), (e) => e.status === 403);
    assert.equal(signed, false);
    assert.equal(lost.status().phase, "signed-out");
    assert.ok(lost.alerts.some((a) => a.kind === "bad-log"), "and it is visible");
  }
});

test("recovery: the flag to keep the old code stays until another device shows it holds the recover", async () => {
  const fixture = await hubFixture();
  const first = await registered(fixture, { name: "First" });
  assert.equal(first.status().recoveryUnconfirmed, false);
  const oldHead = first.status().logHead;
  // The other device misses the news for now.
  first.tap.incoming = (m) => (m.type === "log.updated" ? null : m);
  const fresh = makeAccount(fixture);
  await fresh.recover({ email: EMAIL, password: PASSWORD, recoveryCode: first.recoveryCode, name: "New" });
  assert.equal(fresh.status().recoveryUnconfirmed, true);
  const freshId = fresh.status().device.id;

  const restarted = makeAccount(fixture, { dir: fresh.dir });
  await fresh.stop();
  await restarted.start();
  assert.equal(restarted.status().recoveryUnconfirmed, true, "kept across a restart");
  await until(() => restarted.status().hub.connected, "reconnected");

  // A real device, by hand, signing a head from before the recover: the handshake completes, and confirms nothing.
  const keys = await keysOf(first);
  const c = toB64(new Uint8Array(16).fill(3));
  const send = (fields) => first.tap.sockets.at(-1).real.send(JSON.stringify({ type: "channel.msg", to: freshId, opaque: encodeOuter({ c, ...fields }) }));
  const hs = await startHandshake({ device: keys, peerPub: freshId, logHead: oldHead });
  let core, proofChecked = false, order = Promise.resolve();
  first.tap.incoming = (m) => {
    if (m.type === "log.updated") return null;
    if (m.type !== "channel.msg") return m;
    const outer = JSON.parse(m.opaque);
    if (outer.c !== c) return m;
    order = order.then(async () => {
      if (outer.t === "hello") {
        core = await hs.finish({ eph: outer.eph, logHead: outer.logHead });
        send({ t: "proof", proof: core.proof });
      } else if (outer.t === "proof") {
        await core.confirm(outer.proof);
        proofChecked = true;
      }
    });
    return null;
  };
  send({ t: "hello", ...hs.hello });
  await until(() => proofChecked, "that handshake");
  await sleep(30);
  assert.equal(restarted.status().recoveryUnconfirmed, true, "a head from before the recover confirms nothing");
  first.tap.incoming = undefined;
  const current = await first.openChannel(freshId);
  await until(() => restarted.status().recoveryUnconfirmed === false, "a head holding the recover confirms it");
  current.close();
  const again = makeAccount(fixture, { dir: fresh.dir });
  await restarted.stop();
  await again.start();
  assert.equal(again.status().recoveryUnconfirmed, false, "and that is remembered");
});

test("recovery: an entry another device signed after the recover also confirms it", async () => {
  const fixture = await hubFixture();
  const first = await registered(fixture, { name: "First" });
  const fresh = makeAccount(fixture);
  await fresh.recover({ email: EMAIL, password: PASSWORD, recoveryCode: first.recoveryCode, name: "New" });
  assert.equal(fresh.status().recoveryUnconfirmed, true);
  await until(() => first.status().logHead === fresh.status().logHead, "first adopts");
  // This device's own later entry proves nothing.
  const own = await joined(fixture, fresh, { name: "Added by the recovered device" });
  assert.equal(fresh.status().recoveryUnconfirmed, true);
  await until(() => first.status().logHead === fresh.status().logHead, "first adopts again");
  await first.remove(own.status().device.id);
  await until(() => fresh.status().recoveryUnconfirmed === false, "another device's entry");
});

test("refused by a device on this log: a visible alert, and the log is checked; ordinary refusals are not alarms", async () => {
  const fixture = await hubFixture();
  const { first, second, tap } = await connected(fixture);
  const firstId = first.status().device.id;
  for (const reason of ["not-on-log", "log-mismatch", "removed", "expired"]) {
    second.alerts.length = 0;
    let fetched = 0;
    const before = tap.outgoing;
    tap.outgoing = (m) => { if (m.type === "log.get") fetched++; return m; };
    first.tap.outgoing = (m) => {
      if (m.type !== "channel.msg" || JSON.parse(m.opaque).t !== "hello") return m;
      return { ...m, opaque: JSON.stringify({ v: FRAME_VERSION, c: JSON.parse(m.opaque).c, t: "close", reason }) };
    };
    await assert.rejects(second.openChannel(firstId), /refused/);
    assert.ok(second.status().alerts.some((a) => a.kind === "refused-by-device" && a.key.endsWith(reason)), reason);
    assert.ok(second.alerts.some((a) => a.kind === "refused-by-device"), reason);
    await until(() => fetched > 0, "the log is fetched");
    tap.outgoing = before;
  }
  await second.clearAlerts();
  second.alerts.length = 0;
  for (const reason of ["busy", "unavailable", "web-access-off"]) {
    first.tap.outgoing = (m) => {
      if (m.type !== "channel.msg" || JSON.parse(m.opaque).t !== "hello") return m;
      return { ...m, opaque: JSON.stringify({ v: FRAME_VERSION, c: JSON.parse(m.opaque).c, t: "close", reason }) };
    };
    await assert.rejects(second.openChannel(firstId), /refused/);
  }
  assert.equal(second.alerts.length, 0);
  // A stranger's refusal says nothing about this log.
  const stranger = await newDeviceKeys({ extractable: true });
  // Its hello opens a channel entry while the log is checked, so a close can land on one.
  inject(second, { type: "channel.msg", from: stranger.signPub, opaque: JSON.stringify({ v: FRAME_VERSION, c: "x", t: "hello", eph: stranger.boxPub, logHead: "h" }) });
  inject(second, { type: "channel.msg", from: stranger.signPub, opaque: JSON.stringify({ v: FRAME_VERSION, c: "x", t: "close", reason: "removed" }) });
  await sleep(20);
  assert.equal(second.alerts.length, 0);
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

test("hacked hub: a close claiming removal does not make this device removed; the log decides", async () => {
  const fixture = await hubFixture();
  const first = await registered(fixture);
  const before = first.status().tapped;
  assert.equal(before, undefined);
  const socket = first.tap.sockets.at(-1);
  socket.onclose({ code: 4403 });
  await until(() => first.alerts.some((a) => a.kind === "hub-says-removed"), "the claim is shown");
  assert.notEqual(first.status().phase, "removed");
  assert.ok(!first.alerts.some((a) => a.kind === "removed"));
  await until(() => first.status().hub.connected, "the session still stands, so it looks");
  assert.equal(first.status().phase, "approved");
  assert.equal(first.status().hub.lastError, null);
});

test("hub says removed for real: signing in says so rather than waiting, and forgetting stays the person's choice", async () => {
  const fixture = await hubFixture();
  const { first, second } = await pairWithTap(fixture);
  await first.remove(second.status().device.id);
  await until(() => second.alerts.some((a) => a.kind === "hub-says-removed"), "the claim");
  await until(() => second.status().phase === "signed-out", "the session is gone");
  assert.match(second.status().hub.lastError, /hub says/i);
  assert.ok(!second.alerts.some((a) => a.kind === "removed"), "this device has not seen a log saying so");
  await assert.rejects(second.signIn({ email: EMAIL, password: PASSWORD }), (e) => e.code === "removed" && /hub reports/.test(e.message) && /another device/.test(e.message));
  assert.equal(second.status().phase, "signed-out", "no wait for an approval that cannot come");
  assert.ok(!second.alerts.some((a) => a.kind === "removed"), "still only the hub's word");
  assert.ok(second.status().device, "the keys are still here, until the person forgets them");
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
  // It says so, and what is waiting for the hub fails at once rather than waiting for what will not come.
  assert.equal(first.status().hub.gaveUp, true);
  assert.equal(first.status().hub.reconnecting, false);
  assert.equal(twin.status().hub.gaveUp, false);
  const { hubLostText } = await import("../ui/account.js");
  assert.match(hubLostText(first.status()), /^Replaced by another sign-in/);
  assert.doesNotMatch(hubLostText(first.status()), /reconnects by itself/);
  const { MachineLinks } = await import("../ui/machine-links.js");
  const far = { id: "far", name: "Far", kind: "desktop", role: "full", online: true };
  const links = new MachineLinks({ account: { status: () => first.status(), devices: () => [far], openChannel: () => assert.fail("nothing to open"), on() {}, off() {} } });
  const asked = Date.now();
  await assert.rejects(links.request("far", { method: "GET", path: "/x" }), /Replaced by another sign-in/);
  assert.ok(Date.now() - asked < 2000, "no wait");
  links.close?.();
  // Signing out ends the giving up.
  await first.signOut();
  assert.equal(first.status().hub.gaveUp, false);
});

test("a removed desktop that signs in again is told so, rather than waiting for an approval that cannot come", async () => {
  const fixture = await hubFixture();
  const first = await registered(fixture);
  const gone = await joined(fixture, first);
  const id = gone.status().device.id, dir = gone.dir;
  // Removed while it is away, so its own log still lists it.
  await gone.stop();
  await first.remove(id);
  const again = makeAccount(fixture, { dir });
  await again.start();
  await until(() => again.status().phase === "signed-out", "it settles to signed out");
  assert.equal(again.status().device.role, "full", "its own log does not show the removal");
  // What anchors this device: its keys and its log. state.json and the like are rewritten as they should be.
  const files = () => Object.fromEntries(["keys.json", "log.json"].map((f) => [f, readFileSync(join(dir, f)).toString("base64")]));
  const before = files();

  await assert.rejects(again.signIn({ email: EMAIL, password: PASSWORD }), (e) => {
    assert.equal(e.status, 409);
    assert.equal(e.code, "removed");
    assert.match(e.message, /hub reports/);
    assert.match(e.message, /another device/);
    assert.match(e.message, /Forget this device/);
    return true;
  });
  assert.equal(again.status().phase, "signed-out", "not pending");
  assert.equal(again.status().hub.connected, false);
  assert.ok(again.alerts.some((a) => a.kind === "hub-says-removed"));
  await sleep(100);
  assert.equal(again.status().hub.connected, false, "no socket behind its back");
  assert.deepEqual(files(), before, "nothing was deleted");
  assert.equal(again.status().device.id, id, "the same keys");
  assert.equal(again.status().device.role, "full", "the same log");
  // It never connected, so the other device is not shown a card it could not approve.
  await sleep(150);
  assert.equal(first.pendingSignIns().find((r) => r.signPub === id), undefined);

  // The person's choice, then a new device like any other.
  await again.signOut({ forget: true });
  await again.signIn({ email: EMAIL, password: PASSWORD, name: "Back" });
  assert.equal(again.status().phase, "pending");
  assert.notEqual(again.status().device.id, id);
  await approveNewDevice(first, again);
  assert.equal(again.status().phase, "approved");
});

test("a hub that says pending falsely costs nothing: the keys and the log are still good", async () => {
  const fixture = await hubFixture();
  const first = await registered(fixture);
  const member = await joined(fixture, first);
  const id = member.status().device.id;
  await member.signOut();
  let lying = true;
  const fetchImpl = async (url, init) => {
    const r = await fetch(url, init);
    if (!lying || !String(url).endsWith("/api/login")) return r;
    return new Response(JSON.stringify({ ...(await r.json()), state: "pending" }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const again = makeAccount(fixture, { dir: member.dir, fetchImpl });
  await again.start();
  await assert.rejects(again.signIn({ email: EMAIL, password: PASSWORD }), (e) => e.code === "removed" && /hub reports/.test(e.message));
  assert.equal(again.status().phase, "signed-out");
  lying = false;
  await again.signIn({ email: EMAIL, password: PASSWORD });
  assert.equal(again.status().phase, "approved", "the same device, still on the account");
  assert.equal(again.status().device.id, id);
  assert.equal(first.status().device.role, "full");
});

test("a new device still waits: the check is only for a key that has been on the log", async () => {
  const fixture = await hubFixture();
  await registered(fixture);
  const fresh = makeAccount(fixture);
  await fresh.signIn({ email: EMAIL, password: PASSWORD });
  assert.equal(fresh.status().phase, "pending");
  assert.equal(fresh.alerts.filter((a) => a.kind === "hub-says-removed").length, 0);
});

test("changing the password: sent with no answer says it may or may not have happened", async () => {
  const fixture = await hubFixture();
  const first = await registered(fixture, { limits: { rpcTimeoutMs: 80 } });
  first.tap.outgoing = (m) => (m.type === "password.change" ? null : m);
  await assert.rejects(first.changePassword({ current: PASSWORD, next: "another long password" }), (e) => {
    assert.equal(e.code, "hub-timeout");
    assert.match(e.message, /may or may not have taken effect/);
    assert.match(e.message, /both passwords/);
    return true;
  });
  // The socket going after it was sent is the same doubt.
  const pending = first.changePassword({ current: PASSWORD, next: "another long password" });
  first.tap.outgoing = (m) => { if (m.type === "password.change") setImmediate(() => first.tap.sockets.at(-1).close()); return m.type === "password.change" ? null : m; };
  await assert.rejects(pending, /may or may not have taken effect/);
  // The hub's own answer stays what it is, and so does a change that was never sent.
  first.tap.outgoing = null;
  await until(() => first.status().hub.connected, "back");
  await assert.rejects(first.changePassword({ current: "wrong password here", next: "another long password" }), (e) => e.status === 401 && !/may or may not/.test(e.message));
  await first.stop();
});

test("an ordinary drop: a reconnect is set, and the banner may say so", async () => {
  const fixture = await hubFixture();
  const a = await registered(fixture);
  const { hubLostText } = await import("../ui/account.js");
  await fixture.hub.close();
  await until(() => !a.status().hub.connected, "the loss");
  await until(() => a.status().hub.reconnecting, "a reconnect set");
  assert.equal(a.status().hub.gaveUp, false);
  assert.match(a.status().hub.connectionError, /connection was lost/);
  assert.match(hubLostText(a.status()), /^this computer has lost the hub.*It reconnects by itself\.$/);
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
    existsSync(join(first.dir, "alerts.json")) ? readFileSync(join(first.dir, "alerts.json"), "utf8") : "",
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
  const app = await createApp(appOptions(dir, { accountDir, accountHub: fixture.url, windowToken: token, accountOptions: { hubOrigin: ORIGIN, protector: testProtector, deriveKeys: quickKey, reconnect: { minMs: 20, maxMs: 100 } } }));
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
  assert.equal((await call("GET", "status")).json.recoveryCodePending, true);
  assert.deepEqual((await call("POST", "recovery-code/show")).json, { recoveryCode: reg.json.recoveryCode, confirmed: true });
  const asAgent = await fetch(`${at}/api/account/recovery-code/show`, { method: "POST", headers: { origin: at, "content-type": "application/json" }, body: "{}" });
  assert.equal(asAgent.status, 403, "an agent on this machine has no cookie");
  await asAgent.text();
  assert.deepEqual((await call("POST", "recovery-code/saved")).json, { recoveryCodePending: false });
  assert.equal((await call("POST", "recovery-code/show")).status, 404);
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

// ------------------------------------------------------------------------------- invites, the first run, and other people

test("invites: the hub's owner makes, lists and revokes them; a code is shown once and lets one other person in", async () => {
  const fixture = await hubFixture();
  const owner = await registered(fixture);
  const made = await owner.createInvite();
  assert.match(made.code, /^[2-9A-Z]{4}(-[2-9A-Z]{4}){3}$/);
  assert.ok(made.expiresAt > Date.now() + 13 * 24 * 3600_000);
  const { invites } = await owner.invites();
  assert.deepEqual(invites.map((i) => [i.id, i.state]), [[made.id, "live"]]);
  assert.ok(!JSON.stringify(invites).includes(made.code.replace(/-/g, "")), "the list never shows a code");

  const other = makeAccount(fixture);
  const out = await other.register({ email: "friend@example.com", password: "another long password", name: "Friend", inviteCode: made.code });
  assert.ok(out.recoveryCode);
  assert.equal(other.status().phase, "approved");
  assert.equal((await owner.invites()).invites[0].state, "used");
  // The two are strangers to each other.
  assert.ok(!owner.devices().some((d) => d.name === "Friend"));
  assert.ok(!other.devices().some((d) => d.name === "First"));

  await until(() => other.status().hub.connected, "the friend's socket");
  await assert.rejects(other.createInvite(), (e) => e.status === 403 && e.code === "forbidden", "only the owner's devices make invites");
  await assert.rejects(other.invites(), (e) => e.code === "forbidden");

  const spare = await owner.createInvite();
  await owner.revokeInvite(spare.id);
  const late = makeAccount(fixture);
  await assert.rejects(late.register({ email: "late@example.com", password: "another long password", inviteCode: spare.code }), (e) => e.code === "bad-invite");
  assert.equal(late.status().recoveryCodePending, false, "nothing was created, so no code is held");
});

test("register with no invite after the first account says an invite is needed, and creates nothing", async () => {
  const fixture = await hubFixture();
  await registered(fixture);
  const other = makeAccount(fixture);
  await assert.rejects(other.register({ email: "x@example.com", password: "another long password" }), (e) => e.code === "registration-closed" && /invite code is needed/.test(e.message));
  assert.equal(other.status().recoveryCodePending, false);
});

test("the first run: offered while nothing was ever chosen, and a choice to stay local is remembered", async () => {
  const fixture = await hubFixture();
  const account = makeAccount(fixture);
  await account.start();
  assert.equal(account.status().firstRun, true);
  assert.equal(account.status().canCreateFirst, false);
  writeBootstrap(account.dir);
  assert.equal((await account.refreshStatus()).canCreateFirst, true, "the token on this computer is what creates the first account");
  await account.chooseWelcome("local");
  assert.equal(account.status().firstRun, false);
  await account.stop();
  const again = makeAccount(fixture, { dir: account.dir });
  await again.start();
  assert.equal(again.status().firstRun, false, "remembered across a restart");
  assert.equal(again.status().phase, "signed-out", "and it signed nothing in");
});

test("the first run is not offered to a computer that has signed in before", async () => {
  const fixture = await hubFixture();
  const account = await registered(fixture);
  assert.equal(account.status().firstRun, false);
  await account.signOut();
  assert.equal(account.status().firstRun, false);
  await account.signOut({ forget: true });
  assert.equal(account.status().firstRun, false, "forgetting a device is not a new computer: the person has chosen before");
});

test("the window's routes: invites, the first-run choice, and the reason an account action is refused", async () => {
  const fixture = await hubFixture();
  const dir = freshDir();
  const accountDir = join(dir, "account");
  writeBootstrap(accountDir);
  const token = "window-token-for-invites-0123456789";
  const app = await createApp(appOptions(dir, { accountDir, accountHub: fixture.url, windowToken: token, accountOptions: { hubOrigin: ORIGIN, protector: testProtector, deriveKeys: quickKey, reconnect: { minMs: 20, maxMs: 100 } } }));
  await app.listen();
  cleanups.push(async () => { app.close(); });
  const at = `http://127.0.0.1:${app.server.address().port}`;
  const noCookie = await fetch(`${at}/api/account/status`, { headers: { origin: at } });
  assert.equal(noCookie.status, 403);
  assert.equal((await noCookie.json()).code, "other-window", "a window that did not get this server's token is told so");
  const swap = await fetch(`${at}/?desktop=1&token=${token}`, { redirect: "manual" });
  const cookie = swap.headers.get("set-cookie").split(";")[0];
  const call = async (method, path, body) => {
    const r = await fetch(`${at}/api/account/${path}`, { method, headers: { cookie, origin: at, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json() };
  };
  const first = (await call("GET", "status")).json;
  assert.equal(first.firstRun, true);
  assert.equal(first.canCreateFirst, true);
  assert.equal((await call("POST", "welcome", { choice: "local" })).status, 200);
  assert.equal((await call("GET", "status")).json.firstRun, false);
  assert.equal((await call("POST", "welcome", { choice: "anything" })).status, 400);

  await call("POST", "register", { email: EMAIL, password: PASSWORD, name: "Host" });
  await call("POST", "recovery-code/saved");
  await until(async () => (await call("GET", "status")).json.hub.connected, "the host's socket");
  const made = await call("POST", "invites", {});
  assert.equal(made.status, 200);
  assert.match(made.json.code, /-/);
  const list = await call("GET", "invites");
  assert.deepEqual(list.json.invites.map((i) => i.state), ["live"]);
  assert.equal((await call("POST", "invites/revoke", { id: made.json.id })).status, 200);
  assert.deepEqual((await call("GET", "invites")).json.invites, []);
});

test("a server started with no window token says so, in its own words", async () => {
  const dir = freshDir();
  const app = await createApp(appOptions(dir, { accountDir: join(dir, "account"), accountHub: "http://127.0.0.1:9", windowToken: "" }));
  await app.listen();
  cleanups.push(async () => { app.close(); });
  const at = `http://127.0.0.1:${app.server.address().port}`;
  const r = await fetch(`${at}/api/account/status`, { headers: { origin: at } });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).code, "no-window");
});

test("codes that differ: the new device starts again, the approver gets a new code for the same sign-in, and it lands", async () => {
  const fixture = await hubFixture();
  const approver = await registered(fixture);
  const newcomer = makeAccount(fixture);
  await newcomer.signIn({ email: EMAIL, password: PASSWORD, name: "Laptop" });
  const row = await until(() => approver.pendingSignIns().find((r) => r.name === "Laptop"), "the card");
  const first = await approver.review(row.id);
  await until(() => newcomer.status().pending?.code, "the first code");
  newcomer.restartExchange();
  const second = await approver.review(row.id);
  const code = await until(() => newcomer.status().pending?.code, "the second code");
  assert.equal(code, second.code);
  assert.equal(approver.status().review.code, second.code);
  await assert.rejects(approver.approve(row.id, { code: first.code === second.code ? "x" : first.code, role: "full" }), (e) => e.status === 400, "the old code is gone");
  await approver.approve(row.id, { code: second.code, role: "full" });
  await until(() => newcomer.status().phase === "approved", "approved");
});
