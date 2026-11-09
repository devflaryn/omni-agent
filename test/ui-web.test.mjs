// The web page's own account and transport, against a real hub and a real desktop on the far side. Its keys and log live in a
// store the test holds. A wrapper around WebSocket plays the hacked hub. Real Chrome runs the rest: see the task report.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHub } from "../hub/server.mjs";
import { Account } from "../server/account.mjs";
import { serveChannel } from "../server/channel-host.mjs";
import { FRAME, decodeFrame, decodeHead, encodeOuter } from "../ui/channel-frames.js";
import { createStream } from "../ui/stream.js";
import { PageAccount } from "../ui/page-account.js";
import { memoryStore } from "../ui/page-store.js";
import { createPageTransport } from "../ui/page-transport.js";
import { BLOB_LIMIT, fileClass } from "../ui/page-files.js";
import { approverExchange, newDeviceKeys, newRecoveryCode, recoveryKeysFrom } from "../ui/account-core.js";
import { append, createLog, verifyLog } from "../ui/device-log.js";
import { GLANCE, alertAdvice, alertTitle, deviceWords, explain, hubLostText, noAccountText, phaseText, roleChoices, showWelcome } from "../ui/account.js";
import { MachineLinks } from "../ui/machine-links.js";
import { framesFiles, local, mode, rawUrl as chosenRawUrl, saveFile, setChannelTransport, setMachine, setTransportEnv, webPage } from "../ui/transport.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (check, what = "condition", ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await check(); if (v) return v; await sleep(5); }
  assert.fail(`timed out waiting for ${what}`);
};
const DAY = 86_400_000;
const base = mkdtempSync(join(tmpdir(), "omni-web-"));
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
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const cleanups = [];
after(async () => { for (const c of cleanups.reverse()) { try { await c(); } catch { /* */ } } });

async function hubFixture() {
  const hub = await startHub({ dataDir: join(freshDir(), "hub"), bootstrapToken: BOOTSTRAP, origin: ORIGIN, log: () => {}, sweepMs: 50 });
  cleanups.push(() => hub.close());
  return { hub, url: `http://127.0.0.1:${hub.port}` };
}

/** `tap.incoming(msg)` and `tap.outgoing(msg)` see each parsed message and return it, changed or not, or null to drop it. */
function tappedSocket(tap) {
  return class TappedSocket {
    constructor(url) {
      this.real = new WebSocket(url);
      tap.socket = this;
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

function desktop(fixture, { name = "Desk", kind = "desktop", ...rest } = {}) {
  const dir = join(freshDir(), "account");
  mkdirSync(dir, { recursive: true });
  const account = new Account({ dir, hubUrl: fixture.url, hubOrigin: ORIGIN, name, kind, protector: testProtector, deriveKeys: quickKey, reconnect: { minMs: 20, maxMs: 100 }, log: () => {}, ...rest });
  cleanups.push(() => account.stop());
  return account;
}

async function firstDesktop(fixture, options = {}) {
  const account = desktop(fixture, options);
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(account.dir, "bootstrap-token"), `${BOOTSTRAP}\n`);
  await account.register({ email: EMAIL, password: PASSWORD, name: options.name ?? "Desk" });
  await account.recoveryCodeSaved();
  await until(() => account.status().hub.connected, "the desktop's socket");
  return account;
}

function page(fixture, { store = memoryStore(), tap = {}, ...rest } = {}) {
  const account = new PageAccount({ store, hubUrl: fixture.url, hubOrigin: ORIGIN, name: "Chrome here", deriveKeys: quickKey, WebSocketImpl: tappedSocket(tap), reconnect: { minMs: 20, maxMs: 100 }, ...rest });
  account.store = store;
  account.tap = tap;
  account.alerts = [];
  account.on("alert", (a) => account.alerts.push(a));
  cleanups.push(() => account.stop());
  return account;
}

/** A far desktop's real signing key, from its file: for logs a hacked hub would need a device's help to make. */
async function signerOf(far) {
  const record = JSON.parse(readFileSync(join(far.dir, "keys.json"), "utf8"));
  const secret = JSON.parse(Buffer.from(await testProtector.unprotect(Buffer.from(record.data, "base64"))).toString());
  return { signPub: record.signPub, sign: { privateKey: await crypto.subtle.importKey("pkcs8", Buffer.from(secret.sign, "base64"), "Ed25519", false, ["sign"]) } };
}

const signIn = (p, extra = {}) => p.signIn({ email: EMAIL, password: PASSWORD, ...extra });

async function approvePage(approver, p, role = "client") {
  await until(() => p.status().phase === "pending" && p.status().hub.connected, "the page on the hub");
  const row = await until(() => approver.pendingSignIns().find((x) => x.signPub === p.status().device.id), "the card");
  const review = await approver.review(row.id);
  const code = await until(() => p.status().pending?.code, "the code on the page");
  assert.equal(code, review.code);
  await approver.approve(row.id, { code, role });
  await until(() => p.status().phase === "approved", "approval");
  await until(() => p.status().logHead === approver.status().logHead, "the same log");
}

/** A desktop on the account, a page approved on it, and whatever the far machine answers. */
async function connected(handle, { pageOptions = {}, far: farOptions = {} } = {}) {
  const fixture = await hubFixture();
  const far = await firstDesktop(fixture, farOptions);
  const heads = [];
  far.on("channel", (channel) => {
    const onFrame = channel.onFrame.bind(channel);
    channel.onFrame = (cb) => onFrame((bytes) => {
      const frame = decodeFrame(bytes);
      heads.push(frame.type === FRAME.REQ ? { type: frame.type, ...decodeHead(frame.payload) } : { type: frame.type });
      cb(bytes);
    });
    serveChannel(channel, handle, { device: channel.peer, audit: () => {} });
  });
  const p = page(fixture, pageOptions);
  await signIn(p);
  await approvePage(far, p);
  await until(() => p.devices().find((d) => d.id === far.status().device.id)?.online, "the machine online");
  return { fixture, far, p, farId: far.status().device.id, heads };
}

function transportFor(p, farId, name = "Far box", browser = {}) {
  const objectUrls = [];
  const fake = {
    createObjectURL: (blob) => { const url = `blob:test/${objectUrls.length}`; objectUrls.push({ url, blob }); return url; },
    revokeObjectURL: () => {},
    ...browser,
  };
  const t = createPageTransport({ links: p.links, machine: () => ({ id: farId, name }), local: p.routes(), browser: fake });
  t.objectUrls = objectUrls;
  return t;
}

const respond = (type, body, { status = 200, length = true } = {}) => (req, res) => {
  const bytes = Buffer.from(body);
  res.writeHead(status, { ...(type ? { "Content-Type": type } : {}), ...(length ? { "Content-Length": bytes.length } : {}) });
  res.end(bytes);
};

// ---------------------------------------------------------------------------------------------- keys and sign-in

test("the page's private keys cannot leave as bytes, and are what the store holds", async () => {
  const fixture = await hubFixture();
  await firstDesktop(fixture);
  const p = page(fixture);
  await signIn(p);
  const keys = await p.store.get("keys");
  assert.equal(keys.sign.privateKey.extractable, false);
  assert.equal(keys.box.privateKey.extractable, false);
  await assert.rejects(crypto.subtle.exportKey("pkcs8", keys.sign.privateKey));
  await assert.rejects(crypto.subtle.exportKey("jwk", keys.sign.privateKey));
  await assert.rejects(crypto.subtle.exportKey("pkcs8", keys.box.privateKey));
  assert.equal(keys.signPub, p.status().device.id);
  // A reload: the same identity, from the store.
  await p.stop();
  const again = page(fixture, { store: p.store });
  await again.start();
  assert.equal(again.status().device.id, keys.signPub);
});

test("sign-in shows the code with nothing to press, and is in once the other device approves", async () => {
  const fixture = await hubFixture();
  const far = await firstDesktop(fixture);
  const sent = [];
  const p = page(fixture, { tap: { outgoing: (m) => { sent.push(m.type); return m; } } });
  await signIn(p);
  await until(() => p.status().phase === "pending" && p.status().hub.connected, "pending");
  assert.equal(p.status().pending.code, null);
  assert.equal(p.status().device.role, null, "the page says nothing of its own role");
  const row = await until(() => far.pendingSignIns().find((x) => x.signPub === p.status().device.id), "the card");
  assert.equal(row.kind, "web");
  assert.equal(row.name, "Chrome here");
  const review = await far.review(row.id);
  const code = await until(() => p.status().pending?.code, "the code");
  assert.equal(code, review.code);
  assert.equal(typeof p.confirmCode, "undefined", "there is no second confirmation to give");
  assert.ok(!sent.includes("log.get"), "no log is asked for before the approval");
  assert.equal(p.status().logVersion, 0);
  assert.equal(await p.store.get("log"), null);
  await far.approve(row.id, { code, role: "client" });
  await until(() => p.status().phase === "approved", "approved");
  assert.equal(p.status().device.role, "client");
  assert.equal((await p.store.get("log")).length, 2);
});

test("a page signs in to the account the password vouches for, and refuses a hub that cannot show that", async () => {
  const fixture = await hubFixture();
  await firstDesktop(fixture);
  const lying = page(fixture, { fetchImpl: async (url, init) => {
    const r = await fetch(url, init);
    if (!String(url).endsWith("/api/login")) return r;
    return new Response(JSON.stringify({ ...await r.json(), anchor: Buffer.alloc(32, 3).toString("base64") }), { status: r.status });
  } });
  await assert.rejects(signIn(lying), (e) => e.code === "bad-anchor");
  assert.equal(lying.status().phase, "signed-out");
  assert.ok(lying.alerts.some((a) => a.kind === "bad-anchor"));
  assert.equal(await lying.store.get("session"), null);
});

test("a hacked hub playing the approver for a page, with a made-up account, gets nowhere though nobody presses anything", async () => {
  const fixture = await hubFixture();
  await firstDesktop(fixture);
  const tap = {};
  const p = page(fixture, { tap });
  await signIn(p);
  await until(() => p.status().hub.connected, "connected");
  const mallory = await newDeviceKeys();
  const keys = await p.store.get("keys");
  const log = await createLog({ device: { ...mallory, name: "Mallory", kind: "desktop" }, recovery: await recoveryKeysFrom(newRecoveryCode()) });
  const { head } = await verifyLog(log, { now: Date.now() });
  const added = await append(log, { type: "add", name: "Victim", kind: "web", role: "client", signPub: keys.signPub, boxPub: keys.boxPub }, mallory);
  const exchange = await approverExchange({ approverPub: mallory.signPub, newPub: keys.signPub, logHead: head });
  const random = new Promise((resolve) => { tap.outgoing = (m) => { if (m.type === "approval.msg") { resolve(JSON.parse(m.opaque).random); return null; } return m; }; });
  const hubSays = (m) => tap.socket.onmessage({ data: JSON.stringify(m) });
  hubSays({ type: "approval.msg", from: mallory.signPub, opaque: encodeOuter({ t: "commit", commit: exchange.commit, logHead: head }) });
  exchange.receiveRandom(await random);
  hubSays({ type: "approval.msg", from: mallory.signPub, opaque: encodeOuter({ t: "reveal", random: exchange.revealRandom() }) });
  await until(() => p.status().pending?.code, "the code from the hub's exchange");
  tap.incoming = (m) => (m.type === "error" && m.for === "log.get" ? { type: "log", entries: added, head: "x", version: added.length } : m);
  hubSays({ type: "session.approved" });
  await until(() => p.alerts.some((a) => a.kind === "fake-log"), "the alert");
  assert.equal(p.status().phase, "pending");
  assert.equal(await p.store.get("log"), null);
});

test("sign-in says when no full device is online, and stops saying it when one is", async () => {
  const fixture = await hubFixture();
  const far = await firstDesktop(fixture);
  await far.stop();
  const p = page(fixture, { approverPollMs: 20 });
  await signIn(p);
  await until(() => p.status().pending?.approverOnline === false, "no approver online");
  const back = desktop(fixture, { dir: far.dir });
  await back.start();
  await until(() => p.status().pending?.approverOnline === true, "an approver online");
});

test("the hub tells a pending session only its own row and whether an approver is there", async () => {
  const fixture = await hubFixture();
  const far = await firstDesktop(fixture);
  const replies = [];
  const p = page(fixture, { approverPollMs: 20, tap: { incoming: (m) => { if (m.type === "pending.list") replies.push(m); return m; } } });
  await signIn(p);
  const reply = await until(() => replies[0], "a reply");
  assert.equal(reply.approverOnline, true);
  assert.deepEqual(reply.pending.map((r) => r.signPub), [p.status().device.id], "its own row alone");
  assert.equal(far.status().hub.connected, true);
});

test("a page never restarts an exchange by itself: a second commit is ignored, and a bad reveal needs the person", async () => {
  const fixture = await hubFixture();
  const far = await firstDesktop(fixture);
  let lie = false;
  const tap = { incoming: (m) => {
    if (lie && m.type === "approval.msg" && JSON.parse(m.opaque).t === "reveal") return { ...m, opaque: encodeOuter({ t: "reveal", random: Buffer.alloc(32, 9).toString("base64") }) };
    return m;
  } };
  const p = page(fixture, { tap });
  await signIn(p);
  await until(() => p.status().hub.connected, "connected");
  const row = await until(() => far.pendingSignIns().find((x) => x.signPub === p.status().device.id), "the card");
  lie = true;
  await far.review(row.id);
  await until(() => p.status().pending?.failed, "the failed exchange");
  assert.equal(p.status().pending.code, null, "no code from a failed exchange");
  assert.ok(p.alerts.some((a) => a.kind === "approval-failed"));
  const attempts = p.status().pending.attempts;

  // The hub tries again on its own: nothing happens. Delivered as the hub would, to the page's own socket.
  tap.incoming = (m) => m;
  const farKey = far.status().device.id;
  const commit = encodeOuter({ t: "commit", commit: Buffer.alloc(32, 1).toString("base64"), logHead: "x" });
  const hubSays = () => tap.socket.onmessage({ data: JSON.stringify({ type: "approval.msg", from: farKey, opaque: commit }) });
  hubSays();
  await sleep(50);
  assert.equal(p.status().pending.attempts, attempts, "a commit after that opens nothing");
  assert.equal(p.status().pending.failed, true);

  // Only the person's button reopens it, which also shows that what was injected above does reach the exchange.
  p.restartExchange();
  assert.equal(p.status().pending.failed, false);
  hubSays();
  await until(() => p.status().pending.attempts === attempts + 1, "the commit after the person's press");
});

test("a second commit cannot replace a code on the screen", async () => {
  const fixture = await hubFixture();
  const far = await firstDesktop(fixture);
  const tap = {};
  const p = page(fixture, { tap });
  await signIn(p);
  await until(() => p.status().hub.connected, "connected");
  const row = await until(() => far.pendingSignIns().find((x) => x.signPub === p.status().device.id), "the card");
  await far.review(row.id);
  const code = await until(() => p.status().pending?.code, "the code");
  const opaque = encodeOuter({ t: "commit", commit: Buffer.alloc(32, 1).toString("base64"), logHead: "x" });
  tap.socket.onmessage({ data: JSON.stringify({ type: "approval.msg", from: far.status().device.id, opaque }) });
  await sleep(50);
  assert.equal(p.status().pending.code, code);
  assert.equal(p.status().pending.attempts, 1);
});

test("a log that does not follow the code is refused, with an alert, and the page stays out", async () => {
  const fixture = await hubFixture();
  const far = await firstDesktop(fixture);
  let forge = false;
  const tap = { incoming: (m) => {
    if (forge && m.type === "log") {
      const entries = JSON.parse(JSON.stringify(m.entries));
      entries.at(-1).prev = Buffer.alloc(32, 7).toString("base64");
      return { ...m, entries };
    }
    return m;
  } };
  const p = page(fixture, { tap });
  await signIn(p);
  await until(() => p.status().hub.connected, "connected");
  const row = await until(() => far.pendingSignIns().find((x) => x.signPub === p.status().device.id), "the card");
  const review = await far.review(row.id);
  const code = await until(() => p.status().pending?.code, "the code");
  forge = true;
  await far.approve(row.id, { code, role: "client" });
  await until(() => p.alerts.some((a) => a.kind === "fake-log"), "the alert");
  assert.equal(p.status().phase, "pending");
  assert.equal(await p.store.get("log"), null);
  assert.equal(review.code, code);
});

test("a real log, really signed, whose add does not follow the head in the code is refused", async () => {
  const fixture = await hubFixture();
  const far = await firstDesktop(fixture);
  const before = JSON.parse(readFileSync(join(far.dir, "log.json"), "utf8"));
  const signer = await signerOf(far);
  let forged = null;
  const p = page(fixture, { tap: { incoming: (m) => (forged && m.type === "log" ? { ...m, entries: forged, head: "x", version: forged.length } : m) } });
  await signIn(p);
  await until(() => p.status().hub.connected, "connected");
  const row = await until(() => far.pendingSignIns().find((x) => x.signPub === p.status().device.id), "the card");
  const review = await far.review(row.id);
  const code = await until(() => p.status().pending?.code, "the code");
  const keys = await p.store.get("keys");
  const stranger = await newDeviceKeys();
  const longer = await append(before, { type: "add", name: "Slipped in", kind: "desktop", role: "full", signPub: stranger.signPub, boxPub: stranger.boxPub }, signer);
  forged = await append(longer, { type: "add", name: "Chrome here", kind: "web", role: "client", signPub: keys.signPub, boxPub: keys.boxPub }, signer);
  await far.approve(row.id, { code, role: "client" });
  await until(() => p.alerts.some((a) => a.kind === "fake-log"), "the alert");
  assert.equal(p.status().phase, "pending");
  assert.equal(await p.store.get("log"), null);
  assert.equal(review.code, code);
});

test("a page already on the account answers no commit: it is no new device", async () => {
  const fixture = await hubFixture();
  const far = await firstDesktop(fixture);
  const store = memoryStore();
  const first = page(fixture, { store });
  await signIn(first);
  await approvePage(far, first);
  await first.stop();
  const sent = [];
  const tap = { outgoing: (m) => { sent.push(m.type); return m; } };
  const p = page(fixture, { store, tap });
  await p.start();
  await until(() => p.status().hub.connected, "connected");
  const opaque = encodeOuter({ t: "commit", commit: Buffer.alloc(32, 1).toString("base64"), logHead: p.status().logHead });
  tap.socket.onmessage({ data: JSON.stringify({ type: "approval.msg", from: far.status().device.id, opaque }) });
  await sleep(80);
  assert.ok(!sent.includes("approval.msg"), "nothing signed for it");
});

test("a removal this page does see on its log ends it at once: cut off, alerted, keys gone", async () => {
  const { far, farId, p } = await connected(respond("application/json", "{}"));
  await transportFor(p, farId).api("GET", "/x");
  assert.equal(p.status().channels.length, 1);
  const held = await p.store.get("log");
  const removal = await append(held, { type: "remove", signPub: p.status().device.id }, await signerOf(far));
  p.tap.incoming = (m) => (m.type === "log" ? { ...m, entries: removal, head: "x", version: removal.length } : m);
  await p.syncLog();
  assert.equal(p.status().phase, "removed");
  assert.ok(p.alerts.some((a) => a.kind === "removed"));
  assert.equal(p.status().device, null);
  assert.equal(await p.store.get("keys"), null);
  assert.equal(p.status().channels.length, 0);
  assert.equal(p.status().hub.connected, false);
  assert.equal((await p.store.get("log")).length, removal.length, "the longer log is kept");
});

test("a hub claiming approved for a page holding no log gets an alert, not a session", async () => {
  const fixture = await hubFixture();
  const far = await firstDesktop(fixture);
  const { p } = await (async () => {
    const q = page(fixture);
    await signIn(q);
    await approvePage(far, q);
    return { p: q };
  })();
  await p.stop();
  // The browser lost the log, and kept the keys.
  await p.store.delete("log");
  const again = page(fixture, { store: p.store });
  await again.start();
  await again.signOut();
  await assert.rejects(signIn(again), (e) => e.code === "no-anchor");
  assert.ok(again.alerts.some((a) => a.kind === "fake-log"));
  assert.equal(again.status().signedIn, false);
});

// ---------------------------------------------------------------------------------------------- the log's rules

test("the page keeps the highest verified log: rollback and fork are refused, visibly, also after a reload", async () => {
  const { far, p } = await connected(respond("application/json", "{}"));
  const held = await p.store.get("log");
  const heldHead = p.status().logHead;
  // A second device joins, so the page's log grows.
  const other = desktop({ url: p.hubUrl }, { name: "Other" });
  await other.signIn({ email: EMAIL, password: PASSWORD });
  await until(() => far.pendingSignIns().some((x) => x.signPub === other.status().device.id), "the card");
  const row = far.pendingSignIns().find((x) => x.signPub === other.status().device.id);
  const review = await far.review(row.id);
  await until(() => other.status().pending?.code, "code");
  await far.approve(row.id, { code: review.code, role: "full" });
  await until(() => p.status().logVersion === 3, "the newer log");
  const newer = await p.store.get("log");

  // The hub shows the older one.
  p.tap.incoming = (m) => (m.type === "log" ? { ...m, entries: held, head: heldHead, version: held.length } : m);
  assert.equal(await p.syncLog(), "rollback");
  assert.ok(p.alerts.some((a) => a.kind === "rollback"));
  assert.equal(p.status().logVersion, 3, "nothing adopted");
  assert.deepEqual(await p.store.get("log"), newer);

  // A different entry at a position this page holds, really signed by a device on the log.
  const signer = await signerOf(far);
  const stranger = await newDeviceKeys();
  const forked = await append(held, { type: "add", name: "Forged", kind: "desktop", role: "full", signPub: stranger.signPub, boxPub: stranger.boxPub }, signer);
  p.tap.incoming = (m) => (m.type === "log" ? { ...m, entries: forked, head: "different", version: forked.length } : m);
  assert.equal(await p.syncLog(), "fork");
  assert.ok(p.alerts.some((a) => a.kind === "fork"));
  assert.deepEqual(await p.store.get("log"), newer);

  // Across a reload, an older log is still refused: the store remembers.
  p.tap.incoming = null;
  await p.stop();
  const tap = { incoming: (m) => (m.type === "log" ? { ...m, entries: held, head: heldHead, version: held.length } : m) };
  const again = page({ url: p.hubUrl }, { store: p.store, tap });
  await again.start();
  assert.equal(again.status().logVersion, 3);
  // A repeat of an alert it kept: counted on that row, which also came back from the store.
  const rollbackRow = () => again.status().alerts.find((a) => a.kind === "rollback");
  await until(() => rollbackRow()?.count === 2, "refused after a reload");
  assert.equal(again.status().logVersion, 3);
});

test("a log that fails its checks changes nothing, and raises the alert", async () => {
  const { p } = await connected(respond("application/json", "{}"));
  const held = await p.store.get("log");
  const bad = JSON.parse(JSON.stringify(held));
  bad[1].sig = Buffer.alloc(64, 3).toString("base64");
  bad.push({ ...bad[1], index: 2 });
  p.tap.incoming = (m) => (m.type === "log" ? { ...m, entries: bad, head: "x", version: 3 } : m);
  assert.equal(await p.syncLog(), "bad-log");
  assert.ok(p.alerts.some((a) => a.kind === "bad-log"));
  assert.deepEqual(await p.store.get("log"), held);
});

test("the handshake compares heads: a machine holding a log the hub hides from this page is refused, visibly", async () => {
  const { far, farId, p } = await connected((req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end("{}"); });
  const held = await p.store.get("log");
  const heldHead = p.status().logHead;
  // The hub keeps showing the page the old log, while the desktop moves on.
  p.tap.incoming = (m) => {
    if (m.type === "log.updated") return null;
    if (m.type === "log") return { ...m, entries: held, head: heldHead, version: held.length };
    return m;
  };
  const other = desktop({ url: p.hubUrl }, { name: "Other" });
  await other.signIn({ email: EMAIL, password: PASSWORD });
  await until(() => far.pendingSignIns().some((x) => x.signPub === other.status().device.id), "the card");
  const row = far.pendingSignIns().find((x) => x.signPub === other.status().device.id);
  const review = await far.review(row.id);
  await until(() => other.status().pending?.code, "code");
  await far.approve(row.id, { code: review.code, role: "full" });
  await until(() => far.status().logVersion === 3, "the desktop's newer log");
  await assert.rejects(transportFor(p, farId).api("GET", "/x"), (e) => /Far box|Desk/.test(e.message));
  assert.ok(p.alerts.some((a) => a.kind === "log-unreconciled"), "the disagreement is shown");
  assert.equal(p.status().logVersion, 2);
});

test("a device on the log refusing this page is an alert, not a plain error", async () => {
  const { far, farId, p } = await connected((req, res) => { res.writeHead(200); res.end("{}"); });
  // The desktop turned web pages off: an ordinary answer, no alert.
  await far.setSettings({ allowWebAccess: false });
  await assert.rejects(transportFor(p, farId).api("GET", "/x"), /Web|web|refused|reach/);
  assert.ok(!p.alerts.some((a) => a.kind === "refused-by-device"));
  await far.setSettings({ allowWebAccess: true });

  // The far side says its log does not name this page.
  p.tap.incoming = (m) => {
    if (m.type === "channel.msg" && m.from === farId) {
      const outer = JSON.parse(m.opaque);
      if (outer.t === "hello") return { ...m, opaque: encodeOuter({ c: outer.c, t: "close", reason: "not-on-log" }) };
    }
    return m;
  };
  await assert.rejects(transportFor(p, farId).api("GET", "/x"));
  await until(() => p.alerts.some((a) => a.kind === "refused-by-device"), "the alert");
});

test("a page hosts nothing: a hello to it is refused before any key work", async () => {
  const { far, p } = await connected(respond("application/json", "{}"));
  const sent = [];
  p.tap.outgoing = (m) => { if (m.type === "channel.msg") sent.push(JSON.parse(m.opaque)); return m; };
  let refused = null;
  far.on("channel-closed", () => {});
  await assert.rejects(far.openChannel(p.status().device.id).catch((e) => { refused = e; throw e; }));
  assert.match(refused.message, /not signed in/);
  assert.ok(sent.every((o) => o.t === "close"), "no hello or proof went back");
});

// ---------------------------------------------------------------------------------- the role and what it can do

test("the page's account routes answer what the UI needs, and refuse every approval, removal and password route", async () => {
  const { p } = await connected(respond("application/json", "{}"));
  const r = p.routes();
  assert.equal((await r.api("GET", "/api/account/status")).phase, "approved");
  assert.deepEqual(await r.api("GET", "/api/account/approvals"), { pending: [], review: null });
  assert.equal((await r.api("GET", "/api/account/devices")).devices.length, 2);
  assert.equal((await r.api("GET", "/api/account/machines")).machines.length, 1);
  for (const path of ["approve", "review", "deny", "remove", "password", "register", "recover", "settings", "recovery-code/show", "recovery-code/saved"]) {
    await assert.rejects(r.api("POST", `/api/account/${path}`, { id: "x" }), (e) => e.status === 403 && e.code === "web-page", path);
  }
  await assert.rejects(r.api("POST", "/api/remote/password", {}), (e) => e.status === 404);
  assert.equal(typeof p.approve, "undefined");
  assert.equal(typeof p.remove, "undefined");
  assert.equal(typeof p.changePassword, "undefined");
  assert.equal(typeof p.register, "undefined");
  assert.equal(typeof p.recover, "undefined");
});

test("a page wrongly approved as full still has no approval, removal or password route", async () => {
  const fixture = await hubFixture();
  const far = await firstDesktop(fixture);
  const p = page(fixture);
  await signIn(p);
  await approvePage(far, p, "full");
  assert.equal(p.status().device.role, "full");
  await assert.rejects(p.routes().api("POST", "/api/account/approve", {}), (e) => e.code === "web-page");
  await assert.rejects(p.routes().api("POST", "/api/account/remove", {}), (e) => e.code === "web-page");
  // It sends the hub nothing a full device would, so no card can land on it.
  assert.deepEqual(p.status().review, null);
});

test("account.js shows no approve, remove or password control on a web page, whatever the log says of it", () => {
  const src = readFileSync(new URL("../ui/account.js", import.meta.url), "utf8");
  assert.match(src, /const fullDevice = \(\) => !webPage\(\) && /, "the page is never treated as a full device");
  assert.match(src, /if \(!webPage\(\) && s\.phase === "approved"\) webAccessSection/);
  assert.match(src, /if \(!webPage\(\) && s\.phase === "approved"\) auditSection/);
});

test("the page offers no registration and no recovery, and says where an account is made", () => {
  const src = readFileSync(new URL("../ui/web.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /Create the account|recoveryCode|Recovery code/);
  assert.match(src, /New accounts are made in the Omni desktop app/);
});

test("the page says once on sign-in what a hacked server could do, in plain words", () => {
  const src = readFileSync(new URL("../ui/web.js", import.meta.url), "utf8");
  const notice = /const SERVER_NOTICE = "([^"]+)"/.exec(src)?.[1];
  assert.ok(notice, "the notice");
  assert.match(notice, /hacked/);
  assert.match(notice, /changed page/);
  assert.match(notice, /password/);
  assert.match(notice, /installed apps/);
  assert.match(notice, /run commands on your machines as you/, "the design's sharper part");
  assert.match(notice, /reading a machine's keys/);
  assert.match(notice, /Allow web page access off/);
  assert.match(src, /SERVER_NOTICE/);
});

// ------------------------------------------------------------------------------------------ its 30 days and removal

test("a client's 30 days end on its own clock: cut off, keys retired, and back only as a new device with fresh keys", async () => {
  const fixture = await hubFixture();
  const far = await firstDesktop(fixture);
  const handled = [];
  far.on("channel", (channel) => serveChannel(channel, (req, res) => { handled.push(req.url); res.writeHead(200); res.end("{}"); }, { device: channel.peer, audit: () => {} }));
  let offset = 0;
  const store = memoryStore();
  const p = page(fixture, { store, now: () => Date.now() + offset });
  await signIn(p);
  await approvePage(far, p);
  const firstKey = p.status().device.id;

  // Reloaded later, three seconds before the end. The timer does the rest.
  await p.stop();
  offset = 30 * DAY - 2500;
  const later = page(fixture, { store, now: () => Date.now() + offset });
  await later.start();
  assert.equal(later.status().phase, "approved");
  await until(() => later.status().hub.connected, "the socket");
  const farId = far.status().device.id;
  await until(() => later.devices().find((d) => d.id === farId)?.online, "online");
  const t = transportFor(later, farId);
  await t.api("GET", "/x");
  await until(() => later.status().phase === "expired", "the end of its days", 6000);
  assert.equal(later.status().device, null, "no key held");
  assert.equal(await store.get("keys"), null, "the keys are gone from the store");
  assert.equal(await store.get("session"), null);
  assert.equal(later.status().channels.length, 0);
  assert.equal((await store.get("log")).length, 2, "the log it verified stays");
  const asked = Date.now();
  await assert.rejects(t.api("GET", "/x"), (e) => /not signed in/.test(e.message) && /Nothing was sent/.test(e.message));
  assert.ok(Date.now() - asked < 1000, "not left to wait out the 30 s");

  // Back with new keys, and the log grows by a new device: no key rejoins.
  await signIn(later);
  assert.notEqual(later.status().device.id, firstKey);
  assert.equal(later.status().phase, "pending");
});

test("expired already at load: not signed in, and it says so", async () => {
  const fixture = await hubFixture();
  const far = await firstDesktop(fixture);
  let offset = 0;
  const store = memoryStore();
  const p = page(fixture, { store, now: () => Date.now() + offset });
  await signIn(p);
  await approvePage(far, p);
  await p.stop();
  offset = 31 * DAY;
  const later = page(fixture, { store, now: () => Date.now() + offset });
  await later.start();
  assert.equal(later.status().phase, "expired");
  assert.match(later.status().hub.lastError, /30 days/);
  assert.equal(await store.get("keys"), null);
  // A reload still says why.
  await later.stop();
  const reloaded = page(fixture, { store, now: () => Date.now() + offset });
  await reloaded.start();
  assert.equal(reloaded.status().phase, "expired");
  assert.match(reloaded.status().hub.lastError, /30 days/);
});

test("removal on the log: this page leaves, says so, and its next sign-in has new keys", async () => {
  const fixture = await hubFixture();
  const far = await firstDesktop(fixture);
  const p = page(fixture);
  await signIn(p);
  await approvePage(far, p);
  const oldKey = p.status().device.id;
  // The hub hands over the log first, then ends the session.
  await far.remove(oldKey);
  await until(() => ["removed", "signed-out"].includes(p.status().phase), "out");
  assert.equal(await p.store.get("session"), null);
  await signIn(p);
  assert.notEqual(p.status().device.id, oldKey, "a key can never rejoin");
  assert.equal(p.status().phase, "pending");
  await approvePage(far, p);
  assert.equal(p.status().device.role, "client");
});

test("a hub saying pending for a key this page's own log names: fresh keys, and it says so", async () => {
  const fixture = await hubFixture();
  const far = await firstDesktop(fixture);
  const p = page(fixture);
  await signIn(p);
  await approvePage(far, p);
  const oldKey = p.status().device.id;
  await p.signOut();
  await far.remove(oldKey); // the page never saw this entry
  await signIn(p);
  assert.notEqual(p.status().device.id, oldKey);
  assert.ok(p.alerts.some((a) => a.kind === "hub-says-removed"));
  assert.equal(p.status().phase, "pending");
});

test("denied: back to the sign-in, with its reason, and no automatic retry", async () => {
  const fixture = await hubFixture();
  const far = await firstDesktop(fixture);
  const p = page(fixture);
  await signIn(p);
  await until(() => p.status().hub.connected, "connected");
  const row = await until(() => far.pendingSignIns().find((x) => x.signPub === p.status().device.id), "the card");
  await far.deny(row.id);
  await until(() => p.status().phase === "denied", "denied");
  assert.equal(p.status().signedIn, false);
  assert.equal(await p.store.get("session"), null);
});

test("the hub going away and coming back: the page reconnects by itself, and a machine answers over a fresh handshake", async () => {
  const dataDir = join(freshDir(), "hub");
  let hub = await startHub({ dataDir, bootstrapToken: BOOTSTRAP, origin: ORIGIN, log: () => {}, sweepMs: 50 });
  const port = hub.port;
  cleanups.push(() => hub.close());
  const fixture = { url: `http://127.0.0.1:${port}` };
  const far = await firstDesktop(fixture);
  far.on("channel", (channel) => serveChannel(channel, respond("application/json", '{"ok":1}'), { device: channel.peer, audit: () => {} }));
  const p = page(fixture);
  await signIn(p);
  await approvePage(far, p);
  const farId = far.status().device.id;
  await until(() => p.devices().find((d) => d.id === farId)?.online, "online");
  const t = transportFor(p, farId);
  assert.deepEqual(await t.api("GET", "/a"), { ok: 1 });
  await hub.close();
  await until(() => !p.status().hub.connected, "the loss");
  assert.equal(p.status().channels.length, 0);
  assert.equal(p.status().phase, "approved", "losing the hub is not losing the account");
  hub = await startHub({ port, dataDir, bootstrapToken: BOOTSTRAP, origin: ORIGIN, log: () => {}, sweepMs: 50 });
  await until(() => p.status().hub.connected && p.devices().find((d) => d.id === farId)?.online, "back");
  assert.deepEqual(await t.api("GET", "/b"), { ok: 1 });
});

test("forget wipes the browser's copy: keys, log, session, alerts", async () => {
  const { p } = await connected(respond("application/json", "{}"));
  await p.signOut({ forget: true });
  for (const key of ["keys", "log", "session", "state", "alerts"]) assert.equal(await p.store.get(key), null, key);
  assert.equal(p.status().phase, "signed-out");
  assert.equal(p.status().logVersion, 0);
});

test("a wrong password says so plainly, and mentions where accounts are made", async () => {
  const fixture = await hubFixture();
  await firstDesktop(fixture);
  const p = page(fixture);
  await assert.rejects(p.signIn({ email: EMAIL, password: "not the password at all" }), (e) => e.code === "wrong-credentials" && /Wrong email or password/.test(e.message));
  assert.equal(await p.store.get("session"), null);
  assert.equal(p.status().phase, "signed-out");
});

// -------------------------------------------------------------------------------------------- api over the channel

test("api: frames over the hub carry the request; the answer comes back; only safe headers cross", async () => {
  const seen = [];
  const { p, farId, heads } = await connected(async (req, res) => {
    const parts = [];
    for await (const c of req) parts.push(c);
    seen.push({ method: req.method, url: req.url, body: Buffer.concat(parts).toString(), headers: req.headers });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, url: req.url }));
  });
  const t = transportFor(p, farId);
  assert.deepEqual(await t.api("POST", "/api/x?y=a b", { a: 1 }), { ok: true, url: "/api/x?y=a%20b" });
  assert.equal(seen[0].method, "POST");
  assert.equal(seen[0].body, '{"a":1}');
  assert.equal(seen[0].headers["content-type"], "application/json");
  assert.equal(seen[0].headers.cookie, undefined);
  assert.deepEqual(await t.api("GET", "/api/y"), { ok: true, url: "/api/y" });
  assert.ok(heads.some((h) => h.type === FRAME.PING), "liveness inside the seal");
  assert.ok(heads.filter((h) => h.type === FRAME.REQ).every((h) => Object.keys(h.headers ?? {}).every((k) => ["content-type", "accept"].includes(k))));
});

test("api: one channel per machine, reused", async () => {
  const { p, farId, far } = await connected(respond("application/json", "{}"));
  const t = transportFor(p, farId);
  await Promise.all([t.api("GET", "/a"), t.api("GET", "/b"), t.api("GET", "/c")]);
  await t.api("GET", "/d");
  assert.equal(far.status().channels.length, 1);
});

test("api: far errors carry status and code; the machine is named when the channel fails", async () => {
  const { p, farId } = await connected((req, res) => {
    if (req.url === "/err") { res.writeHead(409, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "not now", code: "busy-here" })); return; }
    if (req.url === "/nojson") { res.writeHead(200); res.end("<html>"); return; }
    if (req.url === "/empty") { res.writeHead(200); res.end(); return; }
    if (req.url === "/teapot") { res.writeHead(418); res.end(); return; }
    res.writeHead(200); res.end("{}");
  });
  const t = transportFor(p, farId);
  await assert.rejects(t.api("GET", "/err"), (e) => e.message === "not now" && e.status === 409 && e.code === "busy-here" && e.body?.code === "busy-here" && e.body.error === "not now");
  await assert.rejects(t.api("GET", "/nojson"), (e) => /Far box/.test(e.message) && /may or may not/.test(e.message) && e.code === "machine-lost");
  assert.deepEqual(await t.api("GET", "/empty"), {});
  await assert.rejects(t.api("GET", "/teapot"), /answered 418/);
});

test("api: a body cut mid-way, or shorter than it declared, is never success", async () => {
  let channelOf;
  const { p, farId } = await connected((req, res) => {
    if (req.url === "/short") { res.writeHead(200, { "Content-Type": "application/json", "Content-Length": 100 }); res.end("{}"); return; }
    if (req.url === "/long") { res.writeHead(200, { "Content-Type": "application/json", "Content-Length": 1 }); res.end("{}"); return; }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write('{"ok":');
    setTimeout(() => channelOf?.(), 30);
  });
  const t = transportFor(p, farId);
  await assert.rejects(t.api("GET", "/short"), (e) => e.code === "machine-lost" && /may or may not/.test(e.message));
  await assert.rejects(t.api("GET", "/long"), (e) => e.code === "machine-lost");
  channelOf = () => p.status().channels.length && p.links.close();
  await assert.rejects(t.api("POST", "/cut", {}), (e) => /Far box|lost|Desk/.test(e.message));
});

test("a body running past its own length is stopped there, with no wait for its end", async () => {
  const { p, farId } = await connected((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json", "Content-Length": 2 });
    res.write("{}{}{}"); // and never ends
  });
  await assert.rejects(transportFor(p, farId).api("GET", "/x"), (e) => e.code === "machine-lost");
});

test("an answer with a status that makes no sense gives nothing: no URL, no JSON", async () => {
  let status = 150;
  const { p, farId } = await connected((req, res) => { res.statusCode = status; res.setHeader("Content-Type", "image/png"); res.setHeader("Content-Length", PNG.length); res.end(PNG); });
  const t = transportFor(p, farId);
  for (status of [150, 199, 600, 999]) {
    await assert.rejects(t.rawUrl("/x"), (e) => /makes no sense/.test(e.message), String(status));
    await assert.rejects(t.api("GET", "/x"), (e) => /makes no sense/.test(e.message), String(status));
  }
  assert.equal(t.objectUrls.length, 0);
});

test("api: nothing queued: an offline machine is named at once, and nothing was sent", async () => {
  const { p, farId, far, heads } = await connected(respond("application/json", "{}"));
  const t = transportFor(p, farId);
  await t.api("GET", "/first");
  const before = heads.filter((h) => h.type === FRAME.REQ).length;
  await far.stop();
  await until(() => !p.devices().find((d) => d.id === farId)?.online, "offline");
  await assert.rejects(t.api("POST", "/later", {}), (e) => /Nothing was sent/.test(e.message) && e.code === "machine-offline");
  assert.equal(heads.filter((h) => h.type === FRAME.REQ).length, before);
});

test("api: a silent machine is named within the budget, and the next request starts a fresh handshake", async () => {
  const state = { dead: false, hellos: 0 };
  const { p, farId } = await connected(respond("application/json", "{}"), { pageOptions: { machineLinks: { budgetMs: 300, connectTimeoutMs: 280, pingEveryMs: 50, stallAfterMs: 100, deadAfterMs: 200 } } });
  const t = transportFor(p, farId);
  await t.api("GET", "/first");
  p.tap.outgoing = (m) => {
    if (m.type === "channel.msg" && JSON.parse(m.opaque).t === "hello") state.hellos++;
    return state.dead && m.type === "channel.msg" ? null : m;
  };
  state.dead = true;
  const started = Date.now();
  await assert.rejects(t.api("POST", "/hangs", {}), (e) => /stopped answering|lost/.test(e.message) && /may or may not/.test(e.message));
  assert.ok(Date.now() - started < 2000);
  await until(() => p.status().channels.length === 0, "the channel closed");
  state.dead = false;
  assert.deepEqual(await t.api("GET", "/again"), {});
  assert.equal(state.hellos, 1, "a new handshake, from the person's own request");
});

test("a link that answers pings may take as long as the route takes", async () => {
  const { p, farId } = await connected(async (req, res) => { await sleep(500); res.writeHead(200); res.end('{"slow":true}'); }, { pageOptions: { machineLinks: { budgetMs: 100, connectTimeoutMs: 90, pingEveryMs: 30, stallAfterMs: 300, deadAfterMs: 600 } } });
  assert.deepEqual(await transportFor(p, farId).api("POST", "/slow", {}), { slow: true });
});

// ---------------------------------------------------------------------------------------------------- eventSource

test("eventSource over the channel drives the existing createStream: messages, named events, and a drop that reconnects", async () => {
  const opened = [];
  let far;
  const { p, farId, far: theFar } = await connected((req, res) => {
    opened.push({ url: req.url, accept: req.headers.accept });
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: {"seq":${opened.length}}\n\n`);
    res.write("event: resync\ndata: {\"boot\":\"b\"}\n\n");
    res.write(": comment\n\ndata: li");
    res.write("ne one\ndata: line two\n\n");
    req.on("close", () => {});
    far?.(res);
  });
  far = (res) => { theFar.lastRes = res; };
  const t = transportFor(p, farId);
  const messages = [], named = [];
  let ups = 0, downs = 0;
  const stream = createStream({
    url: () => "/events?since=0",
    EventSource: function MachineEvents(url) { return t.eventSource(url); },
    onMessage: (m) => messages.push(m.data),
    on: { resync: (m) => named.push(m.data) },
    onUp: () => { ups++; },
    onDown: () => { downs++; },
  });
  stream.start();
  await until(() => messages.length === 2, "two messages");
  assert.equal(opened[0].url, "/events?since=0");
  assert.equal(opened[0].accept, "text/event-stream");
  assert.deepEqual(messages, ['{"seq":1}', "line one\nline two"]);
  assert.deepEqual(named, ['{"boot":"b"}']);
  assert.equal(ups, 1);
  // The far stream ends: that is a drop, and createStream opens again by itself.
  theFar.lastRes.end();
  await until(() => downs === 1, "the drop");
  await until(() => opened.length === 2, "a new stream", 5000);
  stream.stop();
});

test("eventSource: a refused stream is an error, not silence; closing aborts on the far side", async () => {
  let closed = 0;
  const { p, farId } = await connected((req, res) => {
    if (req.url === "/no") { res.writeHead(403, { "Content-Type": "application/json" }); res.end('{"error":"no"}'); return; }
    req.on("close", () => { closed++; });
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write("data: 1\n\n");
  });
  const t = transportFor(p, farId);
  const refused = t.eventSource("/no");
  let opened = false;
  refused.onopen = () => { opened = true; };
  await new Promise((resolve) => { refused.onerror = resolve; });
  assert.equal(refused.readyState, 2);
  assert.equal(opened, false, "a refusal never says it is up");
  const live = t.eventSource("/live");
  await new Promise((resolve) => { live.onmessage = resolve; });
  assert.equal(live.readyState, 1);
  live.close();
  assert.equal(live.readyState, 2);
  await until(() => closed === 1, "the far side told");
});

// --------------------------------------------------------------------------------- a hostile far machine's bytes

test("fileClass: an exact allow-list. Anything else is not viewable, however it is spelled", () => {
  for (const type of ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp", "IMAGE/PNG", "image/png; charset=binary", "video/mp4", "video/webm", "audio/mpeg", "audio/ogg", "audio/wav"]) {
    assert.ok(["image", "media"].includes(fileClass(type).kind), type);
  }
  for (const type of ["text/html", "TEXT/HTML", "application/xhtml+xml", "text/xml", "application/xml", "application/pdf", "application/javascript", "text/javascript", "text/plain", "", null, undefined, "image/png, text/html", "text/html, image/png", "image/png\r\nx: y", "image/", "image", "video", "image/x-unknown", "multipart/x-mixed-replace", "application/octet-stream", "text/html;image/png", "image/svg", "message/rfc822"]) {
    assert.equal(fileClass(type).kind, "other", String(type));
  }
  assert.equal(fileClass("image/svg+xml").kind, "svg");
  assert.equal(fileClass("IMAGE/SVG+XML; charset=utf-8").kind, "svg");
  assert.equal(fileClass("IMAGE/PNG; x=1").type, "image/png", "the type a blob gets is this list's, never the far side's text");
});

test("rawUrl: an allow-listed image becomes a blob of exactly that type", async () => {
  const { p, farId } = await connected(respond("image/png; hack=1", PNG));
  const t = transportFor(p, farId);
  const url = await t.rawUrl("/api/fs/raw?path=a.png");
  assert.match(url, /^blob:/);
  const { blob } = t.objectUrls.find((o) => o.url === url);
  assert.equal(blob.type, "image/png");
  assert.deepEqual(Buffer.from(await blob.arrayBuffer()), PNG);
});

test("rawUrl: HTML, XML, PDF, scripts and the unlabelled never become a URL at all", async () => {
  let type = "text/html";
  const { p, farId } = await connected((req, res) => respond(type, "<script>top.pwned=1</script>")(req, res));
  const t = transportFor(p, farId);
  for (type of ["text/html", "application/xhtml+xml", "text/xml", "application/xml", "application/pdf", "text/javascript", "application/octet-stream", "text/plain", "", "multipart/x-mixed-replace; boundary=x", "image/png, text/html"]) {
    await assert.rejects(t.rawUrl("/api/fs/raw?path=x"), (e) => e.code === "not-viewable" && /Far box/.test(e.message) && /[Dd]ownload/.test(e.message), type);
  }
  assert.equal(t.objectUrls.length, 0, "no blob at all");
});

test("rawUrl: SVG is usable by an <img> and is never a blob, so it can never be a document at this origin", async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>top.pwned=1</script></svg>';
  const { p, farId } = await connected(respond("image/svg+xml", svg));
  const t = transportFor(p, farId);
  const url = await t.rawUrl("/api/fs/raw?path=a.svg");
  assert.match(url, /^data:image\/svg\+xml;base64,/);
  assert.equal(Buffer.from(url.split(",")[1], "base64").toString(), svg);
  assert.equal(t.objectUrls.length, 0);
});

test("rawUrl: a far error is named; a cut body gives no URL", async () => {
  const { p, farId } = await connected((req, res) => {
    if (req.url === "/gone") { res.writeHead(404, { "Content-Type": "application/json" }); res.end('{"error":"not an image"}'); return; }
    res.writeHead(200, { "Content-Type": "image/png", "Content-Length": 1000 });
    res.end(PNG);
  });
  const t = transportFor(p, farId);
  await assert.rejects(t.rawUrl("/gone"), /not an image/);
  await assert.rejects(t.rawUrl("/cut"), (e) => /Far box/.test(e.message) && e.code === "machine-lost");
  assert.equal(t.objectUrls.length, 0);
});

test("rawUrl: over the limit by its own word it is refused before reading, offering a download", async () => {
  assert.equal(BLOB_LIMIT, 200 * 1024 * 1024);
  let sent = 0;
  const { p, farId } = await connected((req, res) => {
    res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": BLOB_LIMIT + 1 });
    res.write(PNG, () => { sent++; });
  });
  const t = transportFor(p, farId);
  await assert.rejects(t.rawUrl("/big.mp4"), (e) => e.code === "too-large-for-page" && /[Dd]ownload/.test(e.message) && e.size === BLOB_LIMIT + 1);
  assert.equal(t.objectUrls.length, 0);
  assert.ok(sent <= 1);
});

test("rawUrl: over the limit while lying about it stops there", async () => {
  const { p, farId } = await connected((req, res) => {
    res.writeHead(200, { "Content-Type": "video/mp4" });
    const chunk = Buffer.alloc(64 * 1024);
    const timer = setInterval(() => res.write(chunk), 1);
    res.once("close", () => clearInterval(timer));
  });
  const t = createPageTransport({ links: p.links, machine: () => ({ id: farId, name: "Far box" }), local: p.routes(), blobLimit: 256 * 1024, browser: { createObjectURL: () => assert.fail("no URL"), revokeObjectURL() {} } });
  await assert.rejects(t.rawUrl("/liar.mp4"), (e) => e.code === "too-large-for-page");
});

test("older blob URLs are let go of once too much is held", async () => {
  const revoked = [];
  const { p, farId } = await connected(respond("image/png", Buffer.alloc(100 * 1024)));
  let n = 0;
  const t = createPageTransport({ links: p.links, machine: () => ({ id: farId, name: "Far box" }), local: p.routes(), heldLimit: 250 * 1024, browser: { createObjectURL: () => `blob:x/${n++}`, revokeObjectURL: (u) => revoked.push(u) } });
  for (let i = 0; i < 4; i++) await t.rawUrl(`/p${i}.png`);
  assert.deepEqual(revoked, ["blob:x/0", "blob:x/1"]);
});

// ---------------------------------------------------------------------------------------------------- downloads

test("a download to a chosen file is written as it arrives, and a far label of HTML changes nothing", async () => {
  const size = 3 * 1024 * 1024;
  const { p, farId } = await connected((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html", "Content-Length": size });
    const piece = Buffer.alloc(256 * 1024, 7);
    let left = size;
    const write = () => { while (left > 0) { const n = Math.min(left, piece.length); left -= n; if (!res.write(piece.subarray(0, n))) { res.once("drain", write); return; } } res.end(); };
    write();
  });
  const writes = [];
  let closed = false, suggested = null;
  const browser = {
    createObjectURL: () => assert.fail("a chosen file needs no blob"),
    revokeObjectURL() {},
    showSaveFilePicker: async ({ suggestedName }) => {
      suggested = suggestedName;
      return { createWritable: async () => ({ write: async (c) => { writes.push(c.length); }, close: async () => { closed = true; }, abort: async () => assert.fail("not aborted") }) };
    },
  };
  await transportFor(p, farId, "Far box", browser).saveFile("/api/fs/raw?path=x&download=1", "report<1>.html");
  assert.equal(closed, true);
  assert.equal(writes.reduce((a, b) => a + b, 0), size);
  assert.ok(Math.max(...writes) <= 256 * 1024, "piece by piece");
  assert.ok(writes.length >= 12);
  assert.equal(suggested, "report<1>.html");
});

test("a cut download leaves no file: the writer is aborted, never closed, and the failure names the machine", async () => {
  const { p, farId } = await connected((req, res) => { res.writeHead(200, { "Content-Length": 1000 }); res.end(PNG); });
  let closed = false, aborted = false;
  const browser = { createObjectURL() {}, revokeObjectURL() {}, showSaveFilePicker: async () => ({ createWritable: async () => ({ write: async () => {}, close: async () => { closed = true; }, abort: async () => { aborted = true; } }) }) };
  await assert.rejects(transportFor(p, farId, "Far box", browser).saveFile("/x", "x.bin"), (e) => /Far box/.test(e.message) && e.code === "machine-lost");
  assert.equal(closed, false);
  assert.equal(aborted, true);
});

test("the person cancelling the file dialog is no failure, and nothing is asked of the machine", async () => {
  const { p, farId, heads } = await connected(respond("application/octet-stream", "x"));
  const browser = { createObjectURL() {}, revokeObjectURL() {}, showSaveFilePicker: async () => { throw Object.assign(new Error("cancelled"), { name: "AbortError" }); } };
  assert.deepEqual(await transportFor(p, farId, "Far box", browser).saveFile("/x", "x.bin"), { cancelled: true });
  assert.equal(heads.filter((h) => h.type === FRAME.REQ).length, 0);
});

test("without a file dialog: a blob of a type no browser will run, named by the page, and only once whole", async () => {
  const body = Buffer.alloc(5 * 1024 * 1024, 3);
  const { p, farId } = await connected((req, res) => {
    if (req.url === "/cut") { res.writeHead(200, { "Content-Type": "text/html", "Content-Length": 1000 }); res.end("<script>"); return; }
    res.writeHead(200, { "Content-Type": "text/html", "Content-Length": body.length, "Content-Disposition": 'attachment; filename="evil.html"' });
    res.end(body);
  });
  const clicked = [];
  const t = transportFor(p, farId, "Far box", { clickDownload: (url, name) => clicked.push({ url, name }) });
  await assert.rejects(t.saveFile("/cut", "x.bin"), (e) => e.code === "machine-lost");
  assert.equal(clicked.length, 0, "a part of a file is not offered");
  await t.saveFile("/whole", "a/b\\c.html");
  assert.equal(clicked.length, 1);
  assert.equal(clicked[0].name, "c.html", "the last part only");
  const { blob } = t.objectUrls.find((o) => o.url === clicked[0].url);
  assert.equal(blob.type, "application/octet-stream", "never text/html");
  assert.equal(blob.size, body.length);
});

test("past what a browser with no file dialog can hold it says so, and does not try", async () => {
  const { p, farId } = await connected((req, res) => { res.writeHead(200, { "Content-Length": 5000 }); res.end(Buffer.alloc(5000)); });
  const t = createPageTransport({ links: p.links, machine: () => ({ id: farId, name: "Far box" }), local: p.routes(), batchedLimit: 1000, browser: { createObjectURL() { assert.fail("no blob"); }, revokeObjectURL() {}, clickDownload() { assert.fail("no click"); } } });
  await assert.rejects(t.saveFile("/big", "big.bin"), (e) => e.code === "too-large-for-page" && /installed app|desktop/.test(e.message));
});

// --------------------------------------------------------------------------------------------- the transport's seam

test("transport.js in channel mode: local goes to the page's own account, the helpers to the channel, and files cannot frame", async (t) => {
  t.after(() => setChannelTransport(null));
  const data = new Map();
  setTransportEnv({ storage: { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: (k) => data.delete(k) }, reload: () => {} });
  assert.equal(webPage(), false);
  assert.equal(framesFiles(), true);
  const seen = [];
  setChannelTransport({
    api: async () => ({}),
    eventSource: () => ({}),
    rawUrl: async (p) => { seen.push(["raw", p]); return "blob:x"; },
    saveFile: async (p, n) => { seen.push(["save", p, n]); },
    local: { api: async (m, p) => ({ local: p }), eventSource: (u) => ({ local: u }) },
  });
  setMachine("id", { name: "Far", reload: false });
  assert.equal(mode(), "channel");
  assert.equal(webPage(), true);
  assert.equal(framesFiles(), false, "a far PDF is never put in an iframe on the page");
  assert.deepEqual(await local.api("GET", "/api/account/status"), { local: "/api/account/status" });
  assert.deepEqual(local.eventSource("/api/account/events"), { local: "/api/account/events" });
  await chosenRawUrl("/p");
  await saveFile("/d", "n.bin");
  assert.deepEqual(seen, [["raw", "/p"], ["save", "/d", "n.bin"]]);
  setTransportEnv({ storage: null, reload: () => {} });
});

test("the page's local account stream carries news; other local streams stay quiet and cost nothing", async () => {
  const { p } = await connected(respond("application/json", "{}"));
  const r = p.routes();
  const events = r.eventSource("/api/account/events");
  const got = [];
  events.addEventListener("status", (m) => got.push(JSON.parse(m.data).phase));
  await until(() => got.length >= 1, "the first status");
  assert.equal(got[0], "approved");
  events.close();
  const before = got.length;
  p.emit("status", p.status());
  assert.equal(got.length, before, "a closed stream hears nothing");
  const quiet = r.eventSource("/events?since=0");
  assert.equal(quiet.readyState, 1);
  quiet.close();
});

test("device names on the wire are hostile: the machine list and machine name come cleaned", async () => {
  const fixture = await hubFixture();
  const bad = `Good${String.fromCodePoint(0x202e)}doog<img src=x onerror=alert(1)>`;
  const far = await firstDesktop(fixture, { name: bad });
  const p = page(fixture);
  await signIn(p);
  await approvePage(far, p);
  await until(() => p.links.machines().length, "a machine");
  const m = p.links.machines()[0];
  assert.ok(!/‮/.test(m.name));
  assert.equal(m.name, "Gooddoog<img src=x onerror=alert(1)>", "text, to be shown as text");
  const src = readFileSync(new URL("../ui/web.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
});

// ------------------------------------------------------------------------------------------------- review round 1

test("replaced by another tab: it says why and promises no reconnect, and a request does not wait out the budget", async () => {
  const { p, farId } = await connected(respond("application/json", "{}"));
  const other = page({ url: p.hubUrl }, { store: p.store });
  await other.start();
  await until(() => p.status().hub.gaveUp, "the first tab told");
  assert.equal(p.status().hub.connected, false);
  assert.match(p.status().hub.lastError, /took over/);
  const text = hubLostText(p.status());
  assert.match(text, /took over/);
  assert.match(text, /nothing is queued/);
  assert.doesNotMatch(text, /reconnects by itself/);
  const asked = Date.now();
  await assert.rejects(transportFor(p, farId).api("GET", "/x"), (e) => /took over/.test(e.message) && /Nothing was sent/.test(e.message) && !/this computer/.test(e.message));
  assert.ok(Date.now() - asked < 2000, "no 28 s wait for what will not come");
  assert.equal(other.status().hub.gaveUp, false);

  // Signing in here again takes the socket back, and with it the giving up ends.
  await other.stop();
  await p.signOut();
  await signIn(p);
  await until(() => p.status().hub.connected, "back on the hub");
  assert.equal(p.status().hub.gaveUp, false);
});

test("the banner promises a reconnect only when one is set and nothing else is wrong", () => {
  const nothing = "Nothing you send now will arrive, and nothing is queued.";
  const promise = `this computer has lost the hub. ${nothing} It reconnects by itself.`;
  assert.equal(hubLostText({ hub: { reconnecting: true } }), promise);
  for (const connectionError of ["The hub connection was lost.", "The hub did not answer."]) assert.equal(hubLostText({ hub: { reconnecting: true, connectionError } }), promise, "an ordinary drop keeps it");
  assert.equal(hubLostText({ hub: {} }), `this computer has lost the hub. ${nothing}`, "none set, none promised");
  assert.equal(hubLostText({ hub: { reconnecting: true, connectionError: "Why." } }), `Why. ${nothing}`, "another reason says that instead");
  assert.equal(hubLostText({ hub: { gaveUp: true, reconnecting: true, connectionError: "Replaced." } }), `Replaced. ${nothing}`, "gaveUp decides");
  assert.equal(hubLostText({ hub: { gaveUp: true } }), `this computer has lost the hub. ${nothing}`);
  // Given up, nothing is promised even if a reason looks ordinary or a timer is somehow set.
  assert.equal(hubLostText({ hub: { gaveUp: true, reconnecting: true } }), `this computer has lost the hub. ${nothing}`);
  assert.equal(hubLostText({ hub: { gaveUp: true, reconnecting: true, connectionError: "The hub connection was lost." } }), `The hub connection was lost. ${nothing}`);
  // A contested recovery code is in lastError, and has its own banner: never here too.
  const text = hubLostText({ recoveryContested: true, hub: { reconnecting: true, lastError: "Keep every recovery code. The hub connection was lost.", connectionError: "The hub connection was lost." } });
  assert.equal(text, promise);
  assert.doesNotMatch(hubLostText({ hub: { lastError: "Keep every recovery code.", connectionError: null } }), /recovery code/);
  assert.match(readFileSync(new URL("../ui/account.js", import.meta.url), "utf8"), /cannot be reached\.`, hubLostText\(A\.status\)/);
});

test("the hub gone with no reason to give up: the wait ends naming this page, not a computer", async () => {
  const fixture = await hubFixture();
  const far = await firstDesktop(fixture);
  const p = page(fixture, { machineLinks: { connectTimeoutMs: 200, budgetMs: 2000 } });
  await signIn(p);
  await approvePage(far, p);
  const farId = far.status().device.id;
  await until(() => p.devices().find((d) => d.id === farId)?.online, "online");
  await fixture.hub.close();
  await until(() => !p.status().hub.connected, "the loss");
  await assert.rejects(transportFor(p, farId).api("GET", "/x"), (e) => /this page is not connected to the hub/.test(e.message));
});

test("MachineLinks names this device by what it was given, with the desktop's words by default", async () => {
  const device = { id: "d", name: "Far", kind: "desktop", role: "full", online: true, self: false };
  const fake = (phase, gaveUp) => ({ devices: () => [device], status: () => ({ phase, hub: { connected: false, gaveUp } }), openChannel() { assert.fail("not asked"); } });
  const say = async (phase, options = {}) => {
    const links = new MachineLinks({ account: fake(phase), connectTimeoutMs: 20, budgetMs: 2000, ...options });
    try { await links.request("d", { method: "GET", path: "/" }); assert.fail("it answered"); } catch (e) { return e.message; } finally { links.close(); }
    return "";
  };
  assert.match(await say("recovering"), /this computer is still finishing a recovery/);
  assert.doesNotMatch(await say("recovering"), /not signed in/);
  assert.match(await say("pending", { selfName: "this page" }), /this page is still waiting for approval/);
  assert.match(await say("signed-out"), /this computer is not signed in/);
  assert.match(await say("removed"), /is no longer on the account/);
  assert.match(await say("constructor"), /is not signed in/, "a phase is looked up as its own key");
  assert.match(await say("approved"), /this computer is not connected to the hub/);
  assert.match(await say("approved", { selfName: "this page" }), /this page is not connected to the hub/);
});

test("a JSON answer too large to read says that, not that the link was lost", async () => {
  const { p, farId } = await connected((req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(Buffer.alloc(4096, 32)); });
  const t = createPageTransport({ links: p.links, machine: () => ({ id: farId, name: "Far box" }), local: p.routes(), blobLimit: 1024, browser: {} });
  await assert.rejects(t.api("POST", "/x", {}), (e) => e.code === "answer-too-large" && e.status === 413 && /Far box/.test(e.message) && /reached it/.test(e.message) && !/may or may not/.test(e.message) && !/lost/.test(e.message));
});

test("SVG data: strings count toward what is held, and only a blob is revoked", async () => {
  const revoked = [];
  let body = PNG, type = "image/png";
  const { p, farId } = await connected((req, res) => respond(type, body)(req, res));
  let n = 0;
  const t = createPageTransport({ links: p.links, machine: () => ({ id: farId, name: "Far box" }), local: p.routes(), heldLimit: 250 * 1024, browser: { createObjectURL: () => `blob:x/${n++}`, revokeObjectURL: (u) => revoked.push(u) } });
  body = Buffer.alloc(100 * 1024);
  await t.rawUrl("/a.png");
  type = "image/svg+xml";
  await t.rawUrl("/a.svg"); // about 133 KiB as text: both still fit
  assert.deepEqual(revoked, []);
  await t.rawUrl("/b.svg"); // now the png goes, and the first svg, which there is nothing to revoke for
  assert.deepEqual(revoked, ["blob:x/0"]);
});

test("a path that a URL parser would read as another host is refused, and nothing crosses", async () => {
  const { p, farId, heads } = await connected(respond("application/json", "{}"));
  const t = transportFor(p, farId);
  for (const path of ["//evil.example/x", "/\\evil.example/x", "\\\\evil.example\\x", "\\/evil"]) {
    for (const call of [() => t.api("GET", path), () => t.rawUrl(path), () => t.saveFile(path, "x.bin")]) {
      await assert.rejects(call(), (e) => e.code === "bad-path" && e.status === 400, path);
    }
    const stream = t.eventSource(path);
    await new Promise((resolve) => { stream.onerror = resolve; });
  }
  assert.equal(heads.filter((h) => h.type === FRAME.REQ).length, 0);
  assert.deepEqual(await t.api("GET", "/ok//still?a=//b"), {}, "only at the start");
  // Nor anything with a scheme of its own, however it is spelled.
  for (const absolute of ["http://evil.test/x", "https://evil.test/x", "HTTP://evil.test/x", "http:/evil.test/x", "http:evil", "data:text/html,x", "javascript:alert(1)", "blob:http://evil.test/x", "file:///c:/x", "ws://evil.test/x", "h\ttp://evil.test/x", " http://evil.test/x", "\thttp://evil.test/x", "\\\\evil.test/x", "/\\evil.test/x"]) {
    await assert.rejects(t.api("GET", absolute), (e) => e.code === "bad-path", JSON.stringify(absolute));
  }
  assert.equal(heads.filter((h) => h.type === FRAME.REQ).length, 1, "only the one above crossed");
});

test("on a page, one helper turns the texts about this device, and drops what is not true of a page", () => {
  const data = new Map();
  setTransportEnv({ storage: { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: (k) => data.delete(k) }, reload: () => {} });
  try {
    // As they stand on a desktop.
    assert.match(alertAdvice("removed"), /^This computer no longer has access.*It still works on its own/);
    assert.equal(alertTitle({ kind: "removed", message: "x" }), "This computer was removed from the account");
    assert.match(phaseText("signed-out"), /This computer works on its own/);
    assert.match(explain({ code: "hub-unreachable", message: "No." }), /this computer still works on its own/);

    setChannelTransport({ api() {}, eventSource() {}, rawUrl() {}, saveFile() {}, local: {} });
    for (const kind of ["rollback", "fork", "different-account", "fake-log", "log-unreconciled", "recovered", "removed", "refused-by-device", "bad-log", "channel-failure", "approval-failed", "hub-says-removed", "key-unavailable"]) {
      assert.doesNotMatch(alertAdvice(kind), /this computer|on its own|Local use/i, kind);
      assert.doesNotMatch(alertTitle({ kind, message: "x" }), /this computer/i, kind);
    }
    assert.equal(alertAdvice("removed"), "This page no longer has access to the account's other machines. If this was not you, sign in again from a device you trust and check the list.");
    assert.equal(alertTitle({ kind: "refused-by-device", message: "x" }), "One of your devices refused this page");
    assert.equal(alertAdvice("different-account"), "Do not approve anything. Check the address of this page.");
    assert.match(alertAdvice("fork"), /from another computer/, "another computer stays what it is");
    for (const phase of ["signed-out", "pending", "recovering", "approved", "denied", "expired", "removed", "key-unavailable", "log-damaged"]) {
      assert.doesNotMatch(phaseText(phase), /this computer|on its own/i, phase);
    }
    assert.equal(phaseText("signed-out"), "Not signed in.");
    assert.equal(explain({ code: "hub-unreachable", message: "No." }), "The hub cannot be reached. No. Nothing here changed.");
    assert.match(hubLostText({ hub: {} }), /^this page has lost the hub/);
    assert.match(hubLostText({ hub: { reconnecting: true } }), /^this page has lost the hub.*It reconnects by itself\.$/);
    assert.equal(deviceWords("This computer and this computer"), "This page and this page");
  } finally { setChannelTransport(null); setTransportEnv({ storage: null, reload: () => {} }); }
  const src = readFileSync(new URL("../ui/account.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /PHASE_TEXT\[s\./, "every phase goes through the helper");
  assert.doesNotMatch(src, /ALERT_ADVICE\[a\./, "every alert goes through the helper");
  assert.match(readFileSync(new URL("../ui/web.js", import.meta.url), "utf8"), /const store = await openPageStore\(\);[\s\S]*setChannelTransport\([\s\S]*await account\.start\(\)/, "the transport is set before the sign-in screen draws an alert");
});

test("approving: the claim only orders the two choices, and a page that says it is a page gets limited first", () => {
  for (const kind of ["web", "", undefined, "something else", "Web"]) {
    const [first, second] = roleChoices(kind);
    assert.deepEqual([first.role, first.primary, second.role, second.primary], ["client", true, "full", false], String(kind));
  }
  for (const kind of ["desktop", "phone", "iphone"]) assert.deepEqual(roleChoices(kind).map((c) => c.role), ["full", "client"], kind);
  for (const kind of ["web", "desktop"]) assert.deepEqual(roleChoices(kind).map((c) => c.role).sort(), ["client", "full"], "both are always offered");
  assert.match(roleChoices("web")[0].label, /web page \(limited\)/);
  assert.match(roleChoices("web")[1].label, /app \(full control\)/);
  assert.equal(GLANCE, "Check that the new device shows the same code before you approve.");
});

test("the approval card asks for a glance in one sentence, and has one tap per choice and no second step", () => {
  const src = readFileSync(new URL("../ui/account.js", import.meta.url), "utf8");
  const card = src.slice(src.indexOf("function approvalCard("), src.indexOf("// --------------------------------------------------------------------------------- the recovery code"));
  assert.match(card, /GLANCE/);
  assert.match(card, /roleChoices\(/);
  assert.doesNotMatch(card, /type = "checkbox"|The codes match|This is my desktop or phone app/);
  const web = readFileSync(new URL("../ui/web.js", import.meta.url), "utf8");
  for (const text of [src, web]) assert.doesNotMatch(text, /This matches|confirm-code|confirmCode/);
});

test("the first-run screen shows only on a desktop with its account on, until a choice, and while its own sign-in waits", () => {
  const status = (over) => ({ phase: "signed-out", firstRun: true, ...over });
  assert.equal(showWelcome(status(), { available: true }), true);
  assert.equal(showWelcome(status(), { available: false }), false, "an account that is off never blocks local use");
  assert.equal(showWelcome(null, { available: true }), false);
  assert.equal(showWelcome(status({ firstRun: false }), { available: true }), false, "chosen once, remembered");
  assert.equal(showWelcome(status(), { available: true, closed: true }), false);
  assert.equal(showWelcome(status({ firstRun: false, phase: "pending" }), { available: true, flow: true }), true, "its own sign-in, waiting for approval");
  assert.equal(showWelcome(status({ firstRun: false, phase: "approved" }), { available: true, flow: true }), false, "and gone once in");
  const data = new Map();
  setTransportEnv({ storage: { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: (k) => data.delete(k) }, reload: () => {} });
  try {
    setChannelTransport({ api() {}, eventSource() {}, rawUrl() {}, saveFile() {}, local: {} });
    assert.equal(showWelcome(status(), { available: true }), false, "never on a web page, which has its own sign-in");
  } finally { setChannelTransport(null); setTransportEnv({ storage: null, reload: () => {} }); }
});

test("the first-run screen and the sign-in surface speak plainly: no phase, role, log or hub", () => {
  const src = readFileSync(new URL("../ui/account.js", import.meta.url), "utf8");
  const part = (from, to) => src.slice(src.indexOf(from), src.indexOf(to));
  const words = (code) => [...code.matchAll(/(["`])((?:\.|(?!).)*)/g)].map((m) => m[2]).filter((s) => /\s/.test(s));
  const main = [part("export function signInSurface(", "export function createAccount("), part("function renderWelcome(", "/** The hub's own words"), part("function welcomeWaiting(", "// ---------------------------------------------------------------------------------- machine switcher")];
  for (const text of main.flatMap(words)) assert.doesNotMatch(text, /(phase|role|log|hub)/i, text);
  for (const code of ["no-window", "other-window", undefined]) assert.doesNotMatch(noAccountText(code), /(phase|role|log|hub|token)/i);
  assert.match(noAccountText("no-window"), /Omni Agent/);
  assert.match(noAccountText("other-window"), /Another Omni window/);
});
