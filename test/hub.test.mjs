// The hub, over real sockets on an ephemeral loopback port, with an injected clock.
// The WebSocket client here is written by hand so that it can also send what no real client would.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loginKeyFrom, newDeviceKeys, newRecoveryCode, recoveryKeysFrom, sign, fromB64 } from "../ui/account-core.js";
import { append, createLog, entryBytes, entryHash, verifyLog } from "../ui/device-log.js";
import { startHub } from "../hub/server.mjs";
import { HubSocket } from "../hub/ws.mjs";

const ORIGIN = "https://hub.example";
const BOOTSTRAP = "test-bootstrap-token-0123456789";
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const WAIT_MS = 4000;

const b64 = (bytes) => Buffer.from(bytes).toString("base64");
const randomKey = () => b64(randomBytes(32));
const named = (keys, name = "Device", kind = "desktop") => ({ ...keys, name, kind });
const later = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- a hand-written WebSocket client ---

function frame(opcode, payload = Buffer.alloc(0), { fin = true, masked = true, rsv = 0, length = null } = {}) {
  const data = Buffer.from(payload);
  const size = length ?? data.length;
  let header;
  if (size < 126) header = Buffer.from([0, size]);
  else if (size < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(size, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(size), 2);
  }
  header[0] = (fin ? 0x80 : 0) | rsv | opcode;
  if (!masked) return Buffer.concat([header, data]);
  header[1] |= 0x80;
  const mask = randomBytes(4);
  const body = Buffer.from(data);
  for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
  return Buffer.concat([header, mask, body]);
}

const TEXT = 1, BINARY = 2, CONTINUATION = 0, CLOSE = 8, PING = 9, PONG = 10;

class Client {
  inbox = [];
  pings = 0;
  pongs = [];
  autoPong = true;
  closeCode = null;
  #buffer = Buffer.alloc(0);
  #waiters = [];
  #onClosed;

  constructor(socket, rest) {
    this.socket = socket;
    this.closed = new Promise((resolve) => { this.#onClosed = resolve; });
    socket.on("data", (chunk) => this.#read(chunk));
    socket.on("error", () => {});
    socket.on("close", () => this.#onClosed(this.closeCode ?? 1006));
    if (rest.length) this.#read(rest);
  }

  #read(chunk) {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    for (;;) {
      const b = this.#buffer;
      if (b.length < 2) return;
      let size = b[1] & 0x7f, at = 2;
      if (size === 126) {
        if (b.length < 4) return;
        size = b.readUInt16BE(2); at = 4;
      } else if (size === 127) {
        if (b.length < 10) return;
        size = Number(b.readBigUInt64BE(2)); at = 10;
      }
      if (b.length < at + size) return;
      const payload = b.subarray(at, at + size);
      const opcode = b[0] & 0x0f;
      if (opcode === TEXT) {
        this.inbox.push(JSON.parse(payload.toString()));
        for (const waiter of [...this.#waiters]) waiter();
      } else if (opcode === PING) {
        this.pings++;
        if (this.autoPong) this.write(frame(PONG, payload));
      } else if (opcode === PONG) {
        this.pongs.push(Buffer.from(payload));
        for (const waiter of [...this.#waiters]) waiter();
      } else if (opcode === CLOSE) {
        this.closeCode ??= size >= 2 ? payload.readUInt16BE(0) : 1005;
      }
      this.#buffer = b.subarray(at + size);
    }
  }

  write(bytes) { if (!this.socket.destroyed) this.socket.write(bytes); }
  send(message) { this.write(frame(TEXT, JSON.stringify(message))); }

  /** Takes the first waiting message of this type out of the inbox. */
  async next(type, ms = WAIT_MS) {
    const take = () => {
      const at = this.inbox.findIndex((m) => m.type === type);
      return at < 0 ? null : this.inbox.splice(at, 1)[0];
    };
    let found = take();
    if (found) return found;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        done();
        reject(new Error(`no ${type} within ${ms} ms; inbox ${JSON.stringify(this.inbox).slice(0, 300)}; closed ${this.closeCode}`));
      }, ms);
      const waiter = () => {
        found = take();
        if (found) { done(); resolve(found); }
      };
      const done = () => {
        clearTimeout(timer);
        this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
      };
      this.#waiters.push(waiter);
    });
  }

  /** A round trip with the hub. A negative check waits for this after the hub has answered the message it is about. */
  async settled() {
    const token = randomBytes(4);
    this.write(frame(PING, token));
    const until = Date.now() + WAIT_MS;
    while (!this.pongs.some((p) => p.equals(token))) {
      if (Date.now() > until) throw new Error("no pong");
      await later(2);
    }
  }

  has(type) { return this.inbox.some((m) => m.type === type); }

  async closedWithin(ms = WAIT_MS) {
    const code = await Promise.race([this.closed, later(ms).then(() => "still open")]);
    return code;
  }

  destroy() { this.socket.destroy(); }
}

/** Resolves {status, client}; a refused upgrade has no client. */
function openSocket(hub, { headers = {}, path = "/ws", localAddress, key = b64(randomBytes(16)), rawRequest } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ port: hub.port, host: "127.0.0.1", localAddress });
    let buffer = Buffer.alloc(0);
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      socket.off("data", onData);
      const head = buffer.subarray(0, end).toString();
      const status = Number(head.split(" ")[1]);
      if (status !== 101) {
        socket.destroy();
        resolve({ status, head });
        return;
      }
      resolve({ status, head, client: hub.track(new Client(socket, buffer.subarray(end + 4))) });
    };
    socket.on("data", onData);
    socket.once("error", reject);
    socket.once("close", () => resolve({ status: 0 }));
    const lines = rawRequest ?? [
      `GET ${path} HTTP/1.1`, "Host: 127.0.0.1", "Upgrade: websocket", "Connection: Upgrade",
      `Sec-WebSocket-Key: ${key}`, "Sec-WebSocket-Version: 13",
      ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
    ];
    socket.write(`${lines.join("\r\n")}\r\n\r\n`);
  });
}

async function rawClient(hub, options) {
  const { client, status } = await openSocket(hub, options);
  assert.equal(status, 101);
  return client;
}

// --- a hub for one test ---

async function hubFor(t, { dataDir, ...options } = {}) {
  const dir = dataDir ?? mkdtempSync(join(tmpdir(), "omni-hub-test-"));
  const clock = options.clock ?? { t: 1_800_000_000_000 };
  const logged = options.logged ?? [];
  const clients = [];
  const open = async () => startHub({ port: 0, dataDir: dir, origin: ORIGIN, bootstrapToken: BOOTSTRAP, now: () => clock.t, sweepMs: 20, log: (line) => logged.push(line), ...options });
  let running = await open();
  const hub = {
    get port() { return running.port; },
    clock, dir, logged,
    track(client) { clients.push(client); return client; },
    async restart() { await running.close(); running = await open(); },
    close: () => running.close(),
  };
  t.after(async () => {
    for (const client of clients) client.destroy();
    await running.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  return hub;
}

function api(hub, path, body, { headers = {}, localAddress, method = "POST", raw } = {}) {
  return new Promise((resolve, reject) => {
    const payload = raw ?? (body === undefined ? "" : JSON.stringify(body));
    const req = http.request({ port: hub.port, host: "127.0.0.1", path, method, localAddress, agent: false, headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload), ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        let json = null;
        try { json = JSON.parse(text); } catch { /* not every refusal has a body */ }
        resolve({ status: res.statusCode, text, json, headers: res.headers });
      });
    });
    req.on("error", reject);
    req.end(payload);
  });
}

async function newAccount(hub, email = "owner@example.com") {
  const device = named(await newDeviceKeys(), "Main PC");
  const recovery = await recoveryKeysFrom(newRecoveryCode());
  const log = await createLog({ device, recoveryPub: recovery.signPub });
  const account = { email, device, recovery, log, loginKey: randomKey(), salt: b64(randomBytes(16)) };
  const r = await api(hub, "/api/register", { email, salt: account.salt, verifierInput: account.loginKey, firstLogEntry: log[0], bootstrapToken: BOOTSTRAP });
  assert.equal(r.status, 201, r.text);
  return account;
}

async function signIn(hub, account, device, extra = {}) {
  const r = await api(hub, "/api/login", { email: account.email, loginKey: account.loginKey, signPub: device.signPub, ...extra });
  assert.equal(r.status, 200, r.text);
  return r.json;
}

const proofBytes = (domain, nonce, origin = ORIGIN) => new TextEncoder().encode(`${domain} ${origin} ${nonce}`);

/** A socket that has given its token and proved it holds the device key. */
async function connect(hub, session, device) {
  const client = await rawClient(hub);
  client.send({ type: "auth", session });
  const { nonce } = await client.next("auth.challenge");
  client.nonce = nonce;
  client.send({ type: "auth.proof", sig: await sign(device.sign.privateKey, proofBytes("omni-hub-auth-v1", nonce)) });
  client.auth = await client.next("auth.ok");
  return client;
}

async function online(hub, account, device, extra) {
  const { session } = await signIn(hub, account, device, extra);
  const client = await connect(hub, session, device);
  client.session = session;
  client.device = device;
  return client;
}

const headOf = async (log, now = Date.now()) => (await verifyLog(log, { now })).head;

/** The owner's socket appends an add, as an approver does at the end of an approval. */
async function approve(account, socket, device, { role = "full", addedAt = Date.now(), signer = account.device } = {}) {
  const next = await append(account.log, { type: "add", name: device.name ?? "Device", kind: device.kind ?? "desktop", role, signPub: device.signPub, boxPub: device.boxPub, addedAt }, signer);
  socket.send({ type: "log.append", prevHead: await headOf(account.log), entry: next.at(-1) });
  await socket.next("log.ok");
  account.log = next;
}

/** An owner, online, plus any further devices already approved and online. */
async function household(hub, account, ...roles) {
  const owner = await online(hub, account, account.device);
  const others = [];
  for (const role of roles) {
    const device = named(await newDeviceKeys(), role === "client" ? "Web" : "Laptop", role === "client" ? "web" : "desktop");
    await approve(account, owner, device, { role, addedAt: hub.clock.t });
    others.push(await online(hub, account, device));
  }
  return [owner, ...others];
}

const pendingDevice = async (hub, account, extra) => online(hub, account, named(await newDeviceKeys()), extra);

function dataFiles(dir) {
  return readdirSync(dir).map((name) => ({ name, text: readFileSync(join(dir, name), "latin1") }));
}

// --- registration ---

test("the first account registers, then registration is closed, also after a restart", async (t) => {
  const hub = await hubFor(t);
  await newAccount(hub);

  const second = await newDeviceKeys();
  const log = await createLog({ device: named(second), recoveryPub: (await recoveryKeysFrom(newRecoveryCode())).signPub });
  const body = { email: "second@example.com", salt: b64(randomBytes(16)), verifierInput: randomKey(), firstLogEntry: log[0] };
  assert.equal((await api(hub, "/api/register", body)).status, 403);

  await hub.restart();
  assert.equal((await api(hub, "/api/register", body)).status, 403);
  assert.equal((await api(hub, "/api/login", { email: body.email, loginKey: body.verifierInput, signPub: second.signPub })).status, 401);
});

test("allowSignup reopens registration, and an email can only be taken once", async (t) => {
  const hub = await hubFor(t, { allowSignup: true });
  const first = await newAccount(hub, "one@example.com");
  await newAccount(hub, "two@example.com");

  const device = await newDeviceKeys();
  const log = await createLog({ device: named(device), recoveryPub: (await recoveryKeysFrom(newRecoveryCode())).signPub });
  const r = await api(hub, "/api/register", { email: "ONE@example.com", salt: b64(randomBytes(16)), verifierInput: randomKey(), firstLogEntry: log[0] });
  assert.equal(r.status, 409);
  assert.equal((await signIn(hub, first, first.device)).state, "approved");
});

test("two registrations at once: one account, the other is refused", async (t) => {
  const hub = await hubFor(t);
  const attempts = await Promise.all(["a@example.com", "b@example.com", "c@example.com"].map(async (email) => {
    const device = await newDeviceKeys();
    const log = await createLog({ device: named(device), recoveryPub: (await recoveryKeysFrom(newRecoveryCode())).signPub });
    return api(hub, "/api/register", { email, salt: b64(randomBytes(16)), verifierInput: randomKey(), firstLogEntry: log[0], bootstrapToken: BOOTSTRAP });
  }));
  assert.deepEqual(attempts.map((r) => r.status).sort(), [201, 403, 403]);
});

test("registration refuses a first entry that does not verify, and malformed fields", async (t) => {
  const hub = await hubFor(t);
  const device = await newDeviceKeys();
  const recovery = await recoveryKeysFrom(newRecoveryCode());
  const [entry] = await createLog({ device: named(device), recoveryPub: recovery.signPub });
  const good = { email: "o@example.com", salt: b64(randomBytes(16)), verifierInput: randomKey(), firstLogEntry: entry, bootstrapToken: BOOTSTRAP };
  const tampered = structuredClone(entry);
  tampered.body.name = "Someone else";
  const anAdd = { ...structuredClone(entry), type: "add" };

  for (const bad of [
    { firstLogEntry: tampered },
    { firstLogEntry: anAdd },
    { firstLogEntry: null },
    { firstLogEntry: [entry] },
    { email: "no-at-sign" },
    { email: "x".repeat(300) + "@example.com" },
    { email: 7 },
    { salt: "c2hvcnQ=" },
    { salt: b64(randomBytes(64)) },
    { verifierInput: "not base64!" },
    { verifierInput: b64(randomBytes(16)) },
  ]) {
    assert.equal((await api(hub, "/api/register", { ...good, ...bad })).status, 400, JSON.stringify(Object.keys(bad)));
  }
  assert.equal((await api(hub, "/api/register", good)).status, 201);
});

// --- what is stored ---

test("the store holds a salted verifier: never the password, never the loginKey, never a token", async (t) => {
  const hub = await hubFor(t, { allowSignup: true });
  const password = "correct horse battery staple";
  const salt = randomBytes(16);
  const loginKey = b64(await loginKeyFrom(password, salt));

  const device = await newDeviceKeys();
  const log = await createLog({ device: named(device), recoveryPub: (await recoveryKeysFrom(newRecoveryCode())).signPub });
  const email = "real@example.com";
  assert.equal((await api(hub, "/api/register", { email, salt: b64(salt), verifierInput: loginKey, firstLogEntry: log[0], bootstrapToken: BOOTSTRAP })).status, 201);

  const served = await api(hub, "/api/salt", { email });
  assert.equal(served.json.salt, b64(salt));
  const again = b64(await loginKeyFrom(password, fromB64(served.json.salt)));
  const login = await api(hub, "/api/login", { email, loginKey: again, signPub: device.signPub });
  assert.equal(login.status, 200);
  const socket = await connect(hub, login.json.session, device);
  socket.send({ type: "presence" });
  await socket.next("presence");

  const twin = await newDeviceKeys();
  const twinLog = await createLog({ device: named(twin), recoveryPub: (await recoveryKeysFrom(newRecoveryCode())).signPub });
  assert.equal((await api(hub, "/api/register", { email: "twin@example.com", salt: b64(randomBytes(16)), verifierInput: loginKey, firstLogEntry: twinLog[0] })).status, 201);

  const files = dataFiles(hub.dir);
  assert.ok(files.length >= 3);
  for (const { name, text } of files) {
    assert.ok(!text.includes(password), `${name} has the password`);
    assert.ok(!text.includes(loginKey), `${name} has the loginKey`);
    assert.ok(!text.includes(Buffer.from(loginKey, "base64").toString("hex")), `${name} has the loginKey in hex`);
    assert.ok(!text.includes(login.json.session), `${name} has the session token`);
  }
  const accounts = JSON.parse(files.find((f) => f.name === "accounts.json").text).accounts;
  assert.equal(accounts.length, 2);
  const [a, b] = accounts.map((x) => x.verifier);
  assert.notEqual(a.salt, b.salt, "the verifier's salt is per account");
  assert.notEqual(a.hash, b.hash, "the same loginKey must not hash the same twice");
  assert.ok(Buffer.from(a.hash, "base64").length >= 32);

  const stored = JSON.parse(files.find((f) => f.name === "sessions.json").text).sessions;
  const tokenHash = createHash("sha256").update(login.json.session).digest("base64");
  assert.ok(stored.some((s) => s.hash === tokenHash), "a token is stored as its hash");
});

test("the fake-salt secret is created on first run, private, and stays", async (t) => {
  const hub = await hubFor(t);
  const before = readFileSync(join(hub.dir, "secret"));
  assert.ok(before.length >= 32);
  if (process.platform !== "win32") assert.equal(statSync(join(hub.dir, "secret")).mode & 0o777, 0o600);
  await hub.restart();
  assert.deepEqual(readFileSync(join(hub.dir, "secret")), before);
});

// --- salts ---

test("an unknown email gets a stable fake salt shaped like a real one", async (t) => {
  const hub = await hubFor(t);
  const account = await newAccount(hub);
  const salt = async (email) => (await api(hub, "/api/salt", { email })).json.salt;

  const fake = await salt("nobody@example.com");
  assert.equal(await salt("nobody@example.com"), fake);
  assert.equal(await salt("  NOBODY@example.com "), fake, "the same login name, however it is typed");
  assert.notEqual(await salt("somebody@example.com"), fake);
  assert.equal(Buffer.from(fake, "base64").length, Buffer.from(account.salt, "base64").length);
  assert.equal(await salt(account.email), account.salt);

  await hub.restart();
  assert.equal(await salt("nobody@example.com"), fake, "stable across restarts");

  const other = await hubFor(t);
  assert.notEqual((await api(other, "/api/salt", { email: "nobody@example.com" })).json.salt, fake, "derived from this hub's secret");
});

test("a salt request gets the same shape of answer for known and unknown emails", async (t) => {
  const hub = await hubFor(t);
  const account = await newAccount(hub);
  const [known, unknown] = [await api(hub, "/api/salt", { email: account.email }), await api(hub, "/api/salt", { email: "no@example.com" })];
  assert.equal(known.status, unknown.status);
  assert.deepEqual(Object.keys(known.json), Object.keys(unknown.json));
  assert.equal(known.text.length, unknown.text.length);
  assert.equal((await api(hub, "/api/salt", { email: "not an email" })).status, 400);
});

// --- signing in ---

test("a wrong password and an unknown email get byte-identical 401s", async (t) => {
  const hub = await hubFor(t);
  const account = await newAccount(hub);
  const signPub = account.device.signPub;
  const wrong = await api(hub, "/api/login", { email: account.email, loginKey: randomKey(), signPub });
  const unknown = await api(hub, "/api/login", { email: "nobody@example.com", loginKey: randomKey(), signPub });
  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  assert.equal(wrong.text, unknown.text);
  const shape = ({ date, ...headers }) => headers;
  assert.deepEqual(shape(wrong.headers), shape(unknown.headers));
});

test("an unknown email costs the hub as much as a wrong password", async (t) => {
  const hub = await hubFor(t, { limits: { maxPairFailures: 1000, maxAccountFailures: 1000, maxAddressFailures: 1000 } });
  const account = await newAccount(hub);
  const signPub = account.device.signPub;
  const timed = async (email) => {
    const samples = [];
    for (let i = 0; i < 7; i++) {
      const start = performance.now();
      assert.equal((await api(hub, "/api/login", { email, loginKey: randomKey(), signPub })).status, 401);
      samples.push(performance.now() - start);
    }
    return samples.sort((a, b) => a - b)[3];
  };
  const [known, unknown] = [await timed(account.email), await timed("nobody@example.com")];
  assert.ok(unknown > known * 0.4, `unknown ${unknown.toFixed(1)} ms against known ${known.toFixed(1)} ms`);
});

test("a known device signs in approved, a new one pending; login refuses malformed fields", async (t) => {
  const hub = await hubFor(t);
  const account = await newAccount(hub);
  assert.equal((await signIn(hub, account, account.device)).state, "approved");
  const fresh = await signIn(hub, account, await newDeviceKeys());
  assert.equal(fresh.state, "pending");
  assert.deepEqual(Object.keys(fresh).sort(), ["session", "state"]);

  const good = { email: account.email, loginKey: account.loginKey, signPub: account.device.signPub };
  for (const bad of [
    { signPub: "nope" }, { signPub: b64(randomBytes(31)) }, { signPub: 3 }, { loginKey: "short" }, { loginKey: null },
    { email: {} }, { name: "x".repeat(200) }, { kind: "x".repeat(50) }, { name: 3 },
  ]) {
    assert.equal((await api(hub, "/api/login", { ...good, ...bad })).status, 400, JSON.stringify(Object.keys(bad)));
  }
});

test("5 failures lock one account from one address for 15 minutes, a right password included", async (t) => {
  const hub = await hubFor(t, { allowSignup: true });
  const account = await newAccount(hub);
  const other = await newAccount(hub, "other@example.com");
  const signPub = account.device.signPub;
  const attempt = (email, loginKey, options) => api(hub, "/api/login", { email, loginKey, signPub }, options);

  for (let i = 0; i < 5; i++) assert.equal((await attempt(account.email, randomKey())).status, 401);
  assert.equal((await attempt(account.email, account.loginKey)).status, 429, "locked, even with the right password");

  // A stranger's guesses do not lock the owner out from elsewhere, or that address out of another account.
  assert.equal((await attempt(account.email, account.loginKey, { localAddress: "127.0.0.2" })).status, 200);
  assert.equal((await attempt(other.email, other.loginKey)).status, 200);
  // A header cannot pretend to be another address.
  assert.equal((await attempt(account.email, account.loginKey, { headers: { "X-Forwarded-For": "9.9.9.9", "X-Real-IP": "9.9.9.9" } })).status, 429);

  hub.clock.t += 15 * MINUTE - 1;
  assert.equal((await attempt(account.email, account.loginKey)).status, 429);
  hub.clock.t += 1;
  assert.equal((await attempt(account.email, account.loginKey)).status, 200);
});

test("50 failures lock an account from everywhere, so rotating addresses does not help", async (t) => {
  const hub = await hubFor(t);
  const account = await newAccount(hub);
  const signPub = account.device.signPub;
  const attempt = (loginKey, n) => api(hub, "/api/login", { email: account.email, loginKey, signPub }, { localAddress: `127.0.0.${n}` });
  for (let n = 0; n < 10; n++) {
    for (let i = 0; i < 5; i++) assert.equal((await attempt(randomKey(), 10 + n)).status, 401);
  }
  const locked = await attempt(account.loginKey, 100);
  assert.equal(locked.status, 429, "a fresh address, with the right password");
  hub.clock.t += 15 * MINUTE;
  assert.equal((await attempt(account.loginKey, 100)).status, 200);
});

test("20 failures from one address lock it out of every account", async (t) => {
  const hub = await hubFor(t, { allowSignup: true });
  const account = await newAccount(hub);
  const signPub = account.device.signPub;
  const attempt = (email, loginKey, options) => api(hub, "/api/login", { email, loginKey, signPub }, options);
  for (let i = 0; i < 20; i++) assert.equal((await attempt(`n${i}@example.com`, randomKey())).status, 401);
  assert.equal((await attempt(account.email, account.loginKey)).status, 429);
  assert.equal((await attempt(account.email, account.loginKey, { localAddress: "127.0.0.2" })).status, 200);
});

test("the lock looks the same for an unknown email", async (t) => {
  const hub = await hubFor(t);
  const account = await newAccount(hub);
  const signPub = account.device.signPub;
  const lockedOut = async (email) => {
    for (let i = 0; i < 5; i++) assert.equal((await api(hub, "/api/login", { email, loginKey: randomKey(), signPub }, { localAddress: "127.0.0.2" })).status, 401);
    return api(hub, "/api/login", { email, loginKey: randomKey(), signPub }, { localAddress: "127.0.0.2" });
  };
  const [known, unknown] = [await lockedOut(account.email), await lockedOut("nobody@example.com")];
  assert.equal(known.status, 429);
  assert.equal(unknown.status, 429);
  assert.equal(known.text, unknown.text);
});

test("guesses sent all at once cannot outrun the lock", async (t) => {
  const hub = await hubFor(t);
  const account = await newAccount(hub);
  const signPub = account.device.signPub;
  const results = await Promise.all(Array.from({ length: 20 }, () => api(hub, "/api/login", { email: account.email, loginKey: randomKey(), signPub })));
  assert.equal(results.filter((r) => r.status === 401).length, 5);
  assert.equal(results.filter((r) => r.status === 429).length, 15);
});

test("the failure records stay bounded under a flood of made-up emails: the oldest are forgotten", async (t) => {
  const hub = await hubFor(t, { limits: { maxTrackedFailures: 8, maxAccountFailures: 2 } });
  const account = await newAccount(hub);
  const signPub = account.device.signPub;
  const attempt = (email, loginKey, n) => api(hub, "/api/login", { email, loginKey, signPub }, { localAddress: `127.0.0.${n}` });
  await attempt(account.email, randomKey(), 2);
  await attempt(account.email, randomKey(), 3);
  assert.equal((await attempt(account.email, account.loginKey, 4)).status, 429, "locked while remembered");
  for (let i = 0; i < 12; i++) assert.equal((await attempt(`n${i}@example.com`, randomKey(), 10 + i)).status, 401);
  assert.equal((await attempt(account.email, account.loginKey, 4)).status, 200, "forgotten, so the record was bounded");
});

// --- HTTP surface ---

test("/api/health says 200 and nothing else; everything else is refused plainly", async (t) => {
  const hub = await hubFor(t);
  await newAccount(hub);
  const health = await api(hub, "/api/health", undefined, { method: "GET" });
  assert.equal(health.status, 200);
  assert.deepEqual(health.json, {});
  assert.equal(health.headers.server, undefined);

  assert.equal((await api(hub, "/api/nothing", {})).status, 404);
  assert.equal((await api(hub, "/", undefined, { method: "GET" })).status, 404);
  assert.equal((await api(hub, "/ws", undefined, { method: "GET" })).status, 404);
  assert.equal((await api(hub, "/api/login", undefined, { method: "GET" })).status, 404);
  assert.equal((await api(hub, "/api/health", {})).status, 404);
  assert.equal((await api(hub, "/api/salt", null, { raw: "{not json" })).status, 400);
  for (const raw of ["null", "[]", "3", '"x"']) assert.equal((await api(hub, "/api/salt", null, { raw })).status, 400, raw);
  assert.equal((await api(hub, "/api/salt", { email: "a@b.c" }, { headers: { "Content-Type": "text/plain" } })).status, 415);
});

test("an oversized body is refused, whether it says so up front or not", async (t) => {
  const hub = await hubFor(t);
  assert.equal((await api(hub, "/api/salt", null, { raw: JSON.stringify({ email: "x".repeat(100_000) }) })).status, 413);

  const chunked = await new Promise((resolve, reject) => {
    const req = http.request({ port: hub.port, host: "127.0.0.1", path: "/api/salt", method: "POST", agent: false, headers: { "Content-Type": "application/json" } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on("error", reject);
    for (let i = 0; i < 10; i++) req.write("x".repeat(10_000));
    req.end();
  });
  assert.equal(chunked, 413);
});

test("a body announced as too large is refused before any of it is sent", async (t) => {
  const hub = await hubFor(t);
  const status = await new Promise((resolve, reject) => {
    const socket = net.connect({ port: hub.port, host: "127.0.0.1" }, () => {
      socket.write("POST /api/salt HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 100000000\r\n\r\n");
    });
    socket.on("error", reject);
    socket.once("data", (chunk) => {
      socket.destroy();
      resolve(Number(chunk.toString().split(" ")[1]));
    });
    setTimeout(() => reject(new Error("no answer")), WAIT_MS).unref();
  });
  assert.equal(status, 413);
});

test("a request that never finishes is dropped: headers, or a body", async (t) => {
  const hub = await hubFor(t, { limits: { headersTimeoutMs: 100, requestTimeoutMs: 200 } });
  const stalled = (text) => new Promise((resolve, reject) => {
    const socket = net.connect({ port: hub.port, host: "127.0.0.1" }, () => socket.write(text));
    const timer = setTimeout(() => reject(new Error("still open")), WAIT_MS);
    socket.on("error", () => {});
    socket.resume();
    socket.on("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  await Promise.all([
    stalled("POST /api/salt HTTP/1.1\r\nHost: x\r\nX-Slow: "),
    stalled("POST /api/salt HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"),
  ]);
});

test("the API refuses a page from another site, and answers no CORS", async (t) => {
  const hub = await hubFor(t);
  const account = await newAccount(hub);
  assert.equal((await api(hub, "/api/salt", { email: account.email }, { headers: { Origin: "https://evil.example" } })).status, 403);
  const own = await api(hub, "/api/salt", { email: account.email }, { headers: { Origin: ORIGIN } });
  assert.equal(own.status, 200);
  assert.equal(own.headers["access-control-allow-origin"], undefined);
});

// --- WebSocket upgrade ---

test("WS: an upgrade with a foreign Origin is refused; absent or the hub's own is accepted", async (t) => {
  const hub = await hubFor(t);
  assert.equal((await openSocket(hub, { headers: { Origin: "https://evil.example" } })).status, 403);
  assert.equal((await openSocket(hub, { headers: { Origin: "null" } })).status, 403);
  assert.equal((await openSocket(hub, { headers: { Origin: `${ORIGIN}.evil.example` } })).status, 403);
  assert.equal((await openSocket(hub, { headers: { Origin: ORIGIN } })).status, 101);
  assert.equal((await openSocket(hub, {})).status, 101);
});

test("WS: a hub with no configured origin refuses every browser", async (t) => {
  const hub = await hubFor(t, { origin: undefined });
  assert.equal((await openSocket(hub, { headers: { Origin: ORIGIN } })).status, 403);
  assert.equal((await openSocket(hub, {})).status, 101);
});

test("WS: a malformed upgrade is refused", async (t) => {
  const hub = await hubFor(t);
  assert.equal((await openSocket(hub, { path: "/other" })).status, 404);
  assert.equal((await openSocket(hub, { key: "short" })).status, 400);
  const base = ["GET /ws HTTP/1.1", "Host: 127.0.0.1", "Upgrade: websocket", "Connection: Upgrade"];
  assert.equal((await openSocket(hub, { rawRequest: [...base, `Sec-WebSocket-Key: ${b64(randomBytes(16))}`, "Sec-WebSocket-Version: 8"] })).status, 426);
  assert.equal((await openSocket(hub, { rawRequest: [...base, "Sec-WebSocket-Version: 13"] })).status, 400);
  assert.equal((await openSocket(hub, { rawRequest: ["POST /ws HTTP/1.1", ...base.slice(1), `Sec-WebSocket-Key: ${b64(randomBytes(16))}`, "Sec-WebSocket-Version: 13"] })).status, 405);
});

test("WS: the accept header is the one RFC 6455 computes", async (t) => {
  const hub = await hubFor(t);
  const { head } = await openSocket(hub, { key: "dGhlIHNhbXBsZSBub25jZQ==" });
  assert.match(head, /sec-websocket-accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=/i);
});

// --- WebSocket authentication ---

async function refusedAuth(t, send) {
  const hub = await hubFor(t);
  const socket = await rawClient(hub);
  await send(socket, hub);
  assert.equal(await socket.closedWithin(), 4401);
  assert.equal(socket.inbox.filter((m) => m.type !== "auth.challenge").length, 0, "told nothing");
}

test("WS: the first message must be the auth, and a bad token is shut out", async (t) => {
  await t.test("garbage", (st) => refusedAuth(st, (s) => s.write(frame(TEXT, "{nope"))));
  await t.test("not an object", (st) => refusedAuth(st, (s) => s.send([1, 2])));
  await t.test("an action first", (st) => refusedAuth(st, (s) => s.send({ type: "log.get" })));
  await t.test("no token", (st) => refusedAuth(st, (s) => s.send({ type: "auth" })));
  await t.test("a made-up token", (st) => refusedAuth(st, (s) => s.send({ type: "auth", session: b64(randomBytes(32)) })));
  await t.test("a token of the wrong type", (st) => refusedAuth(st, (s) => s.send({ type: "auth", session: { a: 1 } })));
});

test("WS: a socket that does not authenticate in time is closed", async (t) => {
  const hub = await hubFor(t, { limits: { authTimeoutMs: 100 } });
  const socket = await rawClient(hub);
  assert.equal(await socket.closedWithin(), 4401);
});

test("WS: a socket that takes the challenge but gives no proof is closed in time too", async (t) => {
  const hub = await hubFor(t, { limits: { authTimeoutMs: 150 } });
  const account = await newAccount(hub);
  const { session } = await signIn(hub, account, account.device);
  const socket = await rawClient(hub);
  socket.send({ type: "auth", session });
  await socket.next("auth.challenge");
  assert.equal(await socket.closedWithin(), 4401);
});

test("WS: a token in the URL does nothing", async (t) => {
  const hub = await hubFor(t);
  const account = await newAccount(hub);
  const { session } = await signIn(hub, account, account.device);
  const socket = await rawClient(hub, { path: `/ws?session=${encodeURIComponent(session)}` });
  socket.send({ type: "presence" });
  assert.equal(await socket.closedWithin(), 4401);
});

test("WS: password and token without the device's key get nothing, even naming a device on the log", async (t) => {
  const hub = await hubFor(t);
  const account = await newAccount(hub);
  const { session, state } = await signIn(hub, account, account.device);
  assert.equal(state, "approved");

  const thief = await newDeviceKeys();
  const socket = await rawClient(hub);
  socket.send({ type: "auth", session });
  const { nonce } = await socket.next("auth.challenge");
  socket.send({ type: "auth.proof", sig: await sign(thief.sign.privateKey, proofBytes("omni-hub-auth-v1", nonce)) });
  assert.equal(await socket.closedWithin(), 4401);
  assert.equal(socket.has("auth.ok"), false);

  const noSig = await rawClient(hub);
  noSig.send({ type: "auth", session });
  await noSig.next("auth.challenge");
  noSig.send({ type: "auth.proof" });
  assert.equal(await noSig.closedWithin(), 4401);

  const anAction = await rawClient(hub);
  anAction.send({ type: "auth", session });
  await anAction.next("auth.challenge");
  anAction.send({ type: "log.get" });
  assert.equal(await anAction.closedWithin(), 4401);
});

test("WS: a proof only answers its own challenge", async (t) => {
  const hub = await hubFor(t);
  const account = await newAccount(hub);
  const { session } = await signIn(hub, account, account.device);
  const key = account.device.sign.privateKey;

  const first = await rawClient(hub);
  first.send({ type: "auth", session });
  const old = (await first.next("auth.challenge")).nonce;
  first.send({ type: "auth.proof", sig: await sign(key, proofBytes("omni-hub-auth-v1", old)) });
  await first.next("auth.ok");

  const replay = await rawClient(hub);
  replay.send({ type: "auth", session });
  assert.notEqual((await replay.next("auth.challenge")).nonce, old);
  replay.send({ type: "auth.proof", sig: await sign(key, proofBytes("omni-hub-auth-v1", old)) });
  assert.equal(await replay.closedWithin(), 4401);
  await first.settled();
  assert.equal(first.closeCode, null, "a failed proof must not push out the real socket");
});

test("a thief with the password cannot push the real device off by signing in as it", async (t) => {
  const hub = await hubFor(t);
  const account = await newAccount(hub);
  const owner = await online(hub, account, account.device);
  await signIn(hub, account, account.device);
  owner.send({ type: "presence" });
  assert.deepEqual((await owner.next("presence")).online, [account.device.signPub]);
  assert.equal(owner.closeCode, null);
});

test("a new socket for the same device replaces the old one, and the old one stops receiving", async (t) => {
  const hub = await hubFor(t);
  const account = await newAccount(hub);
  const [owner, laptop] = await household(hub, account, "full");
  const second = await connect(hub, laptop.session, laptop.device);
  assert.equal(await laptop.closedWithin(), 4409);
  owner.send({ type: "channel.msg", to: laptop.device.signPub, opaque: "only-new" });
  assert.equal((await second.next("channel.msg")).opaque, "only-new");
  await owner.settled();
  assert.equal(owner.has("error"), false);
});

// --- what a pending session may do ---

test("a pending session cannot route channel.msg, see presence, read the log or list other sign-ins", async (t) => {
  const hub = await hubFor(t);
  const account = await newAccount(hub);
  const owner = await online(hub, account, account.device);
  const pending = await pendingDevice(hub, account);
  assert.equal(pending.auth.state, "pending");

  pending.send({ type: "channel.msg", to: account.device.signPub, opaque: "let me in" });
  const refused = await pending.next("error");
  assert.equal(refused.code, "forbidden");
  assert.equal(refused.for, "channel.msg");

  pending.send({ type: "presence" });
  assert.equal((await pending.next("error")).for, "presence");
  assert.equal(pending.has("presence"), false);

  pending.send({ type: "log.get" });
  assert.equal((await pending.next("error")).for, "log.get");
  assert.equal(pending.has("log"), false);

  await owner.settled();
  assert.equal(owner.has("channel.msg"), false);
});

test("a pending session sees only itself in pending.list; a full device sees all; a client none", async (t) => {
  const hub = await hubFor(t);
  const account = await newAccount(hub);
  const [owner, web] = await household(hub, account, "client");
  const a = await pendingDevice(hub, account, { name: "Tablet", kind: "web" });
  const b = await pendingDevice(hub, account);

  a.send({ type: "pending.list" });
  const own = await a.next("pending.list");
  assert.deepEqual(own.pending.map((p) => p.signPub), [a.device.signPub]);

  owner.inbox.length = 0;
  owner.send({ type: "pending.list" });
  const all = await owner.next("pending.list");
  assert.deepEqual(all.pending.map((p) => p.signPub).sort(), [a.device.signPub, b.device.signPub].sort());
  const row = all.pending.find((p) => p.signPub === a.device.signPub);
  assert.equal(row.name, "Tablet");
  assert.equal(row.kind, "web");
  assert.match(row.ip, /127\.0\.0\.1/);
  assert.equal(row.online, true);

  web.send({ type: "pending.list" });
  assert.equal((await web.next("error")).code, "forbidden");
  assert.equal(web.has("pending.list"), false);
});

test("a new sign-in reaches full devices as a pushed pending.list, but not a client's", async (t) => {
  const hub = await hubFor(t);
  const account = await newAccount(hub);
  const [owner, web] = await household(hub, account, "client");
  owner.inbox.length = 0;
  web.inbox.length = 0;
  const pending = await pendingDevice(hub, account);
  const pushed = await owner.next("pending.list");
  assert.deepEqual(pushed.pending.map((p) => p.signPub), [pending.device.signPub]);
  await web.settled();
  assert.equal(web.has("pending.list"), false);
});

test("a sign-in that never proved its key shows no card", async (t) => {
  const hub = await hubFor(t);
  const account = await newAccount(hub);
  const owner = await online(hub, account, account.device);
  await signIn(hub, account, await newDeviceKeys());
  owner.send({ type: "pending.list" });
  assert.deepEqual((await owner.next("pending.list")).pending, []);
});

test("pending sign-ins per account are limited; signing in again with the same key takes no new place", async (t) => {
  const hub = await hubFor(t, { limits: { maxPending: 2 } });
  const account = await newAccount(hub);
  const a = await pendingDevice(hub, account);
  await pendingDevice(hub, account);
  const third = await newDeviceKeys();
  const r = await api(hub, "/api/login", { email: account.email, loginKey: account.loginKey, signPub: third.signPub });
  assert.equal(r.status, 429);
  assert.equal(r.json.session, undefined);

  const again = await signIn(hub, account, a.device);
  assert.equal(again.state, "pending");
  await a.settled();
  assert.equal(a.closeCode, null, "signing in with its key is not enough to push it off");
  assert.equal((await signIn(hub, account, account.device)).state, "approved", "a known device still signs in");

  await connect(hub, again.session, a.device);
  assert.equal(await a.closedWithin(), 4409, "proving the key replaces the older sign-in");
  const reuse = await rawClient(hub);
  reuse.send({ type: "auth", session: a.session });
  assert.equal(await reuse.closedWithin(), 4401);
});

test("signing in again and again leaves one unproved session per key", async (t) => {
  const hub = await hubFor(t);
  const account = await newAccount(hub);
  const device = await newDeviceKeys();
  const first = await signIn(hub, account, device);
  await signIn(hub, account, device);
  const socket = await rawClient(hub);
  socket.send({ type: "auth", session: first.session });
  assert.equal(await socket.closedWithin(), 4401, "the older unproved one is gone");
  const stored = JSON.parse(readFileSync(join(hub.dir, "sessions.json"), "utf8")).sessions;
  assert.equal(stored.filter((s) => s.signPub === device.signPub).length, 1);
});

test("pending expires at 10 minutes: socket closed, token dead, gone from the list", async (t) => {
  const hub = await hubFor(t);
  const account = await newAccount(hub);
  const owner = await online(hub, account, account.device);
  const pending = await pendingDevice(hub, account);

  hub.clock.t += 10 * MINUTE - 1;
  await later(60);
  assert.equal(pending.closeCode, null, "still waiting just before 10 minutes");
  owner.send({ type: "pending.list" });
  assert.equal((await owner.next("pending.list")).pending.length, 1);

  owner.inbox.length = 0;
  hub.clock.t += 1;
  assert.equal(await pending.closedWithin(), 4408);
  owner.send({ type: "pending.list" });
  assert.deepEqual((await owner.next("pending.list")).pending, []);

  const reuse = await rawClient(hub);
  reuse.send({ type: "auth", session: pending.session });
  assert.equal(await reuse.closedWithin(), 4401);
});

test("an expired pending session is refused by its next message, even before the sweep comes round", async (t) => {
  const hub = await hubFor(t, { sweepMs: 60_000 });
  const account = await newAccount(hub);
  const owner = await online(hub, account, account.device);
  const pending = await pendingDevice(hub, account);
  hub.clock.t += 10 * MINUTE;

  pending.send({ type: "approval.msg", to: account.device.signPub, opaque: "too late" });
  assert.equal(await pending.closedWithin(), 4408);

  await owner.settled();
  assert.equal(owner.has("approval.msg"), false);
});

test("an approver cannot reach a sign-in that has expired", async (t) => {
  const hub = await hubFor(t, { sweepMs: 60_000 });
  const account = await newAccount(hub);
  const owner = await online(hub, account, account.device);
  const pending = await pendingDevice(hub, account);
  hub.clock.t += 10 * MINUTE;
  owner.send({ type: "approval.msg", to: pending.device.signPub, opaque: "hello?" });
  assert.equal((await owner.next("error")).code, "unreachable");
  await later(5);
  assert.equal(pending.has("approval.msg"), false);
});

// --- approval ---

test("the whole approval: messages both ways, the add approves the session, and it can then route", async (t) => {
  const hub = await hubFor(t);
  const account = await newAccount(hub);
  const owner = await online(hub, account, account.device);
  const device = named(await newDeviceKeys(), "Phone", "iphone");
  const pending = await online(hub, account, device, { name: "Phone", kind: "iphone" });

  owner.send({ type: "approval.msg", to: device.signPub, opaque: "commit" });
  const first = await pending.next("approval.msg");
  assert.deepEqual(first, { type: "approval.msg", from: account.device.signPub, opaque: "commit" });
  pending.send({ type: "approval.msg", to: account.device.signPub, opaque: "random" });
  assert.equal((await owner.next("approval.msg")).opaque, "random");

  await approve(account, owner, device);
  await pending.next("session.approved");

  pending.send({ type: "log.get" });
  const got = await pending.next("log");
  assert.equal(got.version, 2);
  assert.equal(got.head, await headOf(account.log));
  assert.deepEqual(got.entries, JSON.parse(JSON.stringify(account.log)));

  pending.send({ type: "channel.msg", to: account.device.signPub, opaque: "hello" });
  assert.equal((await owner.next("channel.msg")).opaque, "hello");

  owner.inbox.length = 0;
  owner.send({ type: "pending.list" });
  assert.deepEqual((await owner.next("pending.list")).pending, []);

  hub.clock.t += 11 * MINUTE;
  await later(60);
  assert.equal(pending.closeCode, null, "an approved session does not expire with the pending window");
});

test("approval.msg runs only between a pending session and a full device of its account", async (t) => {
  const hub = await hubFor(t, { allowSignup: true });
  const account = await newAccount(hub);
  const [owner, laptop, web] = await household(hub, account, "full", "client");
  const a = await pendingDevice(hub, account);
  const b = await pendingDevice(hub, account);
  const stranger = await newAccount(hub, "stranger@example.com");
  const strangerOwner = await online(hub, stranger, stranger.device);
  const strangerPending = await pendingDevice(hub, stranger);
  for (const c of [owner, laptop, web, a, b, strangerOwner, strangerPending]) c.inbox.length = 0;

  const refused = async (from, to) => {
    from.send({ type: "approval.msg", to: to.device.signPub, opaque: "x" });
    assert.equal((await from.next("error")).code, "unreachable");
    await to.settled();
    assert.equal(to.has("approval.msg"), false);
  };
  await refused(owner, laptop);      // full to full
  await refused(a, b);               // pending to pending
  await refused(a, web);             // pending to client
  await refused(web, a);             // client to pending
  await refused(strangerOwner, a);   // another account's full device
  await refused(a, strangerOwner);
  await refused(owner, strangerPending);
  await refused(strangerPending, owner);

  owner.send({ type: "approval.msg", to: a.device.signPub, opaque: "ok" });
  assert.equal((await a.next("approval.msg")).opaque, "ok");
  a.send({ type: "approval.msg", to: laptop.device.signPub, opaque: "ok" });
  assert.equal((await laptop.next("approval.msg")).from, a.device.signPub);
});

// --- routing ---

test("channel.msg reaches devices of the same account only; from is set by the hub; opaque passes untouched", async (t) => {
  const hub = await hubFor(t, { allowSignup: true });
  const account = await newAccount(hub);
  const [owner, laptop, web] = await household(hub, account, "full", "client");
  const stranger = await newAccount(hub, "stranger@example.com");
  const strangerOwner = await online(hub, stranger, stranger.device);

  const opaque = 'looks like {"type":"log.get"} \\ but is "just" text é😀';
  owner.send({ type: "channel.msg", to: web.device.signPub, opaque, from: laptop.device.signPub, extra: "dropped" });
  const delivered = await web.next("channel.msg");
  assert.deepEqual(delivered, { type: "channel.msg", from: account.device.signPub, opaque });
  web.send({ type: "channel.msg", to: laptop.device.signPub, opaque: "client too" });
  assert.equal((await laptop.next("channel.msg")).from, web.device.signPub);

  owner.send({ type: "channel.msg", to: stranger.device.signPub, opaque: "secret" });
  const crossing = await owner.next("error");
  strangerOwner.send({ type: "channel.msg", to: account.device.signPub, opaque: "secret" });
  await strangerOwner.next("error");
  await Promise.all([strangerOwner.settled(), owner.settled(), laptop.settled(), web.settled()]);
  assert.equal(strangerOwner.has("channel.msg"), false);
  assert.equal(owner.has("channel.msg"), false);

  // Another account's online device looks exactly like a key nobody has.
  owner.send({ type: "channel.msg", to: stranger.device.signPub, opaque: "x" });
  const asStranger = await owner.next("error");
  const nobody = randomKey();
  owner.send({ type: "channel.msg", to: nobody, opaque: "x" });
  const asNobody = await owner.next("error");
  assert.equal(crossing.code, "unreachable");
  assert.deepEqual({ ...asStranger, to: "" }, { ...asNobody, to: "" });
});

test("an approved device cannot route to a pending one over channel.msg", async (t) => {
  const hub = await hubFor(t);
  const account = await newAccount(hub);
  const owner = await online(hub, account, account.device);
  const pending = await pendingDevice(hub, account);
  owner.send({ type: "channel.msg", to: pending.device.signPub, opaque: "x" });
  assert.equal((await owner.next("error")).code, "unreachable");
  await pending.settled();
  assert.equal(pending.has("channel.msg"), false);
});

test("a message to a device that is offline is reported, not lost in silence", async (t) => {
  const hub = await hubFor(t);
  const account = await newAccount(hub);
  const [owner, laptop] = await household(hub, account, "full");
  laptop.destroy();
  await later(30);
  owner.send({ type: "channel.msg", to: laptop.device.signPub, opaque: "x" });
  const error = await owner.next("error");
  assert.equal(error.code, "unreachable");
  assert.equal(error.for, "channel.msg");
  assert.equal(error.to, laptop.device.signPub);
});

test("routing refuses malformed messages without closing a good socket", async (t) => {
  const hub = await hubFor(t);
  const account = await newAccount(hub);
  const [owner, laptop] = await household(hub, account, "full");
  for (const bad of [
    { type: "channel.msg", opaque: "no to" },
    { type: "channel.msg", to: laptop.device.signPub },
    { type: "channel.msg", to: laptop.device.signPub, opaque: { not: "text" } },
    { type: "channel.msg", to: 7, opaque: "x" },
    { type: "approval.msg", to: laptop.device.signPub },
  ]) {
    owner.send(bad);
    assert.equal((await owner.next("error")).code, "bad-message", JSON.stringify(bad));
  }
  owner.send({ type: "toString" });
  assert.equal((await owner.next("error")).code, "unknown");
  owner.send({ type: "__proto__" });
  assert.equal((await owner.next("error")).code, "unknown");
  owner.send({ nothing: true });
  assert.equal((await owner.next("error")).code, "unknown");
  owner.write(frame(TEXT, "{not json"));
  assert.equal((await owner.next("error")).code, "bad-message");
  await laptop.settled();
  assert.equal(laptop.has("channel.msg"), false);
  assert.equal(owner.closeCode, null);
});

test("presence lists online approved devices, and is pushed when it changes", async (t) => {
  const hub = await hubFor(t);
  const account = await newAccount(hub);
  const [owner, laptop] = await household(hub, account, "full");
  await pendingDevice(hub, account);
  owner.inbox.length = 0;
  owner.send({ type: "presence" });
  assert.deepEqual((await owner.next("presence")).online.sort(), [account.device.signPub, laptop.device.signPub].sort());
  owner.inbox.length = 0;
  laptop.destroy();
  assert.deepEqual((await owner.next("presence")).online, [account.device.signPub]);
});

// --- the log ---

test("two appends at once: the first valid one wins, the second gets log.conflict with the current log", async (t) => {
  const hub = await hubFor(t);
  const account = await newAccount(hub);
  const [owner, laptop] = await household(hub, account, "full");
  owner.inbox.length = 0;
  laptop.inbox.length = 0;
  const [x, y] = [await newDeviceKeys(), await newDeviceKeys()];
  const add = (keys) => ({ type: "add", name: "New", kind: "desktop", role: "full", signPub: keys.signPub, boxPub: keys.boxPub, addedAt: 5 });
  const byOwner = await append(account.log, add(x), account.device);
  const byLaptop = await append(account.log, add(y), laptop.device);
  const prevHead = await headOf(account.log);

  // Same tick, both verifying at once.
  owner.send({ type: "log.append", prevHead, entry: byOwner.at(-1) });
  laptop.send({ type: "log.append", prevHead, entry: byLaptop.at(-1) });

  const replies = await Promise.all([owner, laptop].map(async (socket) => {
    const until = Date.now() + WAIT_MS;
    while (!socket.has("log.ok") && !socket.has("log.conflict")) {
      assert.ok(Date.now() < until, "no answer to log.append");
      await later(2);
    }
    return { socket, conflict: socket.has("log.conflict") };
  }));
  const losers = replies.filter((r) => r.conflict);
  assert.equal(losers.length, 1, "exactly one loses");
  const conflict = await losers[0].socket.next("log.conflict");
  assert.equal(conflict.version, account.log.length + 1);
  const winner = conflict.entries.at(-1);
  assert.ok([byOwner.at(-1).sig, byLaptop.at(-1).sig].includes(winner.sig));

  await hub.restart();
  const again = await online(hub, account, account.device);
  again.send({ type: "log.get" });
  const stored = await again.next("log");
  assert.equal(stored.version, account.log.length + 1);
  assert.equal(stored.entries.at(-1).sig, winner.sig, "the winner is what was kept");
  await verifyLog(stored.entries, { now: hub.clock.t });
});

test("log.append with a stale prevHead gets the conflict, and a later valid one on the right head goes in", async (t) => {
  const hub = await hubFor(t);
  const account = await newAccount(hub);
  const owner = await online(hub, account, account.device);
  const oldHead = await headOf(account.log);
  await approve(account, owner, named(await newDeviceKeys()));

  const stale = await append(account.log, { type: "add", name: "Y", kind: "desktop", role: "full", ...pick(await newDeviceKeys()), addedAt: 1 }, account.device);
  owner.send({ type: "log.append", prevHead: oldHead, entry: stale.at(-1) });
  const conflict = await owner.next("log.conflict");
  assert.equal(conflict.head, await headOf(account.log));
  assert.deepEqual(conflict.entries, JSON.parse(JSON.stringify(account.log)));

  owner.send({ type: "log.append", prevHead: conflict.head, entry: stale.at(-1) });
  const ok = await owner.next("log.ok");
  assert.equal(ok.version, stale.length);
  assert.equal(ok.head, await headOf(stale));
});

function pick({ signPub, boxPub }) { return { signPub, boxPub }; }

test("the hub stores nothing that fails verification", async (t) => {
  const hub = await hubFor(t);
  const account = await newAccount(hub);
  const [owner, web] = await household(hub, account, "client");
  const head = await headOf(account.log);
  const valid = await append(account.log, { type: "add", name: "Y", kind: "desktop", role: "full", ...pick(await newDeviceKeys()), addedAt: 1 }, account.device);
  const entry = valid.at(-1);

  const stranger = await newDeviceKeys();
  const signedByStranger = await append(account.log, { type: "add", name: "Y", kind: "desktop", role: "full", ...pick(await newDeviceKeys()), addedAt: 1 }, stranger).catch(() => null);
  assert.equal(signedByStranger, null, "append itself refuses this");

  const unsignedName = structuredClone(entry);
  unsignedName.body.name = "Changed after signing";
  const extraField = { ...structuredClone(entry), note: "unsigned" };
  for (const bad of [unsignedName, extraField, { ...entry, sig: undefined }, null, "x", 3, [], { type: "create" }]) {
    owner.send({ type: "log.append", prevHead: head, entry: bad });
    const refusal = await owner.next("error");
    assert.equal(refusal.code, "invalid-entry", JSON.stringify(bad)?.slice(0, 80));
  }
  owner.send({ type: "log.get" });
  assert.equal((await owner.next("log")).version, account.log.length);

  // A client device cannot sign, so an add signed by it is refused however it gets here.
  const byClient = await forge(account.log, "add", { name: "Evil", kind: "desktop", role: "full", ...pick(await newDeviceKeys()), addedAt: 1 }, web.device);
  owner.send({ type: "log.append", prevHead: head, entry: byClient });
  assert.equal((await owner.next("error")).code, "invalid-entry");

  owner.send({ type: "log.append", prevHead: head, entry });
  await owner.next("log.ok");
});

async function forge(log, type, body, signer) {
  const unsigned = { type, index: log.length, prev: await entryHash(log.at(-1)), signer: signer.signPub, body };
  return { ...unsigned, sig: await sign(signer.sign.privateKey, entryBytes(unsigned)) };
}

test("appends are pushed to approved devices as log.updated, never to a pending one", async (t) => {
  const hub = await hubFor(t);
  const account = await newAccount(hub);
  const [owner, laptop] = await household(hub, account, "full");
  const pending = await pendingDevice(hub, account);
  laptop.inbox.length = 0;
  await approve(account, owner, named(await newDeviceKeys()));
  const pushed = await laptop.next("log.updated");
  assert.equal(pushed.version, account.log.length);
  assert.equal(pushed.head, await headOf(account.log));
  await pending.settled();
  assert.equal(pending.has("log.updated"), false);
});

test("a removed device is cut off at once: socket closed, token dead, sign-in only pending", async (t) => {
  const hub = await hubFor(t);
  const account = await newAccount(hub);
  const [owner, laptop] = await household(hub, account, "full");
  const next = await append(account.log, { type: "remove", signPub: laptop.device.signPub }, account.device);
  owner.send({ type: "log.append", prevHead: await headOf(account.log), entry: next.at(-1) });
  await owner.next("log.ok");
  account.log = next;
  assert.equal(await laptop.closedWithin(), 4403);

  const reuse = await rawClient(hub);
  reuse.send({ type: "auth", session: laptop.session });
  assert.equal(await reuse.closedWithin(), 4401);
  assert.equal((await signIn(hub, account, laptop.device)).state, "pending");

  owner.send({ type: "channel.msg", to: laptop.device.signPub, opaque: "x" });
  assert.equal((await owner.next("error")).code, "unreachable");
});

test("a client past its 30 days is closed at once, and its token dies", async (t) => {
  const hub = await hubFor(t, { limits: { trustRecheckMs: 0 } });
  const account = await newAccount(hub);
  const [owner, web] = await household(hub, account, "client");
  hub.clock.t += 30 * DAY - 1;
  await later(60);
  assert.equal(web.closeCode, null, "still fine before 30 days");
  hub.clock.t += 1;
  assert.equal(await web.closedWithin(), 4403);

  const reuse = await rawClient(hub);
  reuse.send({ type: "auth", session: web.session });
  assert.equal(await reuse.closedWithin(), 4401);
  owner.send({ type: "presence" });
  assert.deepEqual((await owner.next("presence")).online, [account.device.signPub]);
});

test("a message from a client past its 30 days is refused even before the sweep comes round", async (t) => {
  const hub = await hubFor(t, { sweepMs: 60_000 });
  const account = await newAccount(hub);
  const [owner, web] = await household(hub, account, "client");
  hub.clock.t += 30 * DAY;
  web.send({ type: "channel.msg", to: account.device.signPub, opaque: "expired" });
  assert.equal(await web.closedWithin(), 4403);
  await owner.settled();
  assert.equal(owner.has("channel.msg"), false);
});

test("a client that expired while the hub was down has lost its session after the restart", async (t) => {
  const hub = await hubFor(t);
  const account = await newAccount(hub);
  const [, web] = await household(hub, account, "client");
  hub.clock.t += 31 * DAY;
  await hub.restart();
  const reuse = await rawClient(hub);
  reuse.send({ type: "auth", session: web.session });
  assert.equal(await reuse.closedWithin(), 4401);
});

test("an approved session survives a restart", async (t) => {
  const hub = await hubFor(t);
  const account = await newAccount(hub);
  const owner = await online(hub, account, account.device);
  await hub.restart();
  const back = await connect(hub, owner.session, account.device);
  assert.equal(back.auth.state, "approved");
  back.send({ type: "log.get" });
  assert.equal((await back.next("log")).version, 1);
});

// --- recovery ---

/** A pending device with the recovery code builds and sends its recover entry. */
async function recoverEntry(account, device, signerKeys = account.recovery) {
  const replacement = await recoveryKeysFrom(newRecoveryCode());
  const next = await append(account.log, { type: "recover", name: "Rescue", kind: "desktop", signPub: device.signPub, boxPub: device.boxPub, recoveryPub: replacement.signPub, addedAt: 1 }, { ...signerKeys, boxPub: device.boxPub });
  return { next, entry: next.at(-1), replacement };
}

test("a proof signed for another hub's origin is refused, for sign-in and for recovery", async (t) => {
  const hub = await hubFor(t);
  const account = await newAccount(hub);
  const { session } = await signIn(hub, account, account.device);
  const elsewhere = "https://other-hub.example";
  const socket = await rawClient(hub);
  socket.send({ type: "auth", session });
  const { nonce } = await socket.next("auth.challenge");
  socket.send({ type: "auth.proof", sig: await sign(account.device.sign.privateKey, proofBytes("omni-hub-auth-v1", nonce, elsewhere)) });
  assert.equal(await socket.closedWithin(), 4401);

  const pending = await pendingDevice(hub, account);
  pending.send({ type: "log.get", recoveryProof: await sign(account.recovery.sign.privateKey, proofBytes("omni-hub-recovery-v1", pending.nonce, elsewhere)) });
  assert.equal((await pending.next("error")).code, "forbidden");
});

test("recovery: a pending session reads the log with the code's key, appends its recover, and is approved", async (t) => {
  const hub = await hubFor(t);
  const account = await newAccount(hub);
  const owner = await online(hub, account, account.device);
  const device = named(await newDeviceKeys(), "Rescue");
  const pending = await online(hub, account, device);
  assert.equal(pending.auth.state, "pending");

  pending.send({ type: "log.get", recoveryProof: await sign(account.recovery.sign.privateKey, proofBytes("omni-hub-recovery-v1", pending.nonce)) });
  const log = await pending.next("log");
  assert.deepEqual(log.entries, JSON.parse(JSON.stringify(account.log)));

  const { entry } = await recoverEntry(account, device);
  pending.send({ type: "log.append", prevHead: log.head, entry });
  await pending.next("log.ok");
  await pending.next("session.approved");

  pending.send({ type: "channel.msg", to: account.device.signPub, opaque: "back" });
  assert.equal((await owner.next("channel.msg")).opaque, "back");
  assert.equal((await owner.next("log.updated")).version, 2);
});

test("recovery proof: the wrong key, a proof for another socket and the device's own key do not open the log", async (t) => {
  const hub = await hubFor(t);
  const account = await newAccount(hub);
  const device = await newDeviceKeys();
  const pending = await online(hub, account, device);
  const other = await pendingDevice(hub, account);
  const someKey = await recoveryKeysFrom(newRecoveryCode());
  const bytes = proofBytes("omni-hub-recovery-v1", pending.nonce);
  for (const recoveryProof of [
    await sign(someKey.sign.privateKey, bytes),
    await sign(device.sign.privateKey, bytes),
    await sign(account.recovery.sign.privateKey, proofBytes("omni-hub-recovery-v1", other.nonce)),
    await sign(account.recovery.sign.privateKey, proofBytes("omni-hub-auth-v1", pending.nonce)),
    "not a signature",
    7,
  ]) {
    pending.send({ type: "log.get", recoveryProof });
    assert.equal((await pending.next("error")).code, "forbidden");
  }
  assert.equal(pending.has("log"), false);
});

test("a pending session can append only its own recover, signed by the recovery key", async (t) => {
  const hub = await hubFor(t);
  const account = await newAccount(hub);
  const owner = await online(hub, account, account.device);
  const device = named(await newDeviceKeys());
  const pending = await online(hub, account, device);
  const head = await headOf(account.log);

  const refused = async (entry, prevHead = head) => {
    pending.send({ type: "log.append", prevHead, entry });
    assert.equal((await pending.next("error")).code, "forbidden");
    assert.equal(pending.has("log.conflict"), false, "a refused entry must not hand over the log");
  };
  const anAdd = await append(account.log, { type: "add", name: "Me", kind: "desktop", role: "full", ...pick(device), addedAt: 1 }, account.device);
  await refused(anAdd.at(-1));

  // A recover that would approve some other device.
  const someone = await newDeviceKeys();
  await refused((await recoverEntry(account, someone)).entry);

  // A wrong code.
  const wrongCode = await recoveryKeysFrom(newRecoveryCode());
  await refused(await forge(account.log, "recover", { name: "Me", kind: "desktop", role: "full", ...pick(device), addedAt: 1, recoveryPub: (await recoveryKeysFrom(newRecoveryCode())).signPub }, wrongCode));

  await refused(null);
  await refused("x");
  await refused({ type: "recover" });

  owner.send({ type: "log.get" });
  assert.equal((await owner.next("log")).version, 1);
  assert.equal(pending.auth.state, "pending");
});

test("a recover that only names the recovery key as signer gets no log, even on a stale head", async (t) => {
  const hub = await hubFor(t);
  const account = await newAccount(hub);
  const device = named(await newDeviceKeys());
  const pending = await online(hub, account, device);
  const { entry } = await recoverEntry(account, device);
  const faked = { ...entry, sig: b64(randomBytes(64)) };
  pending.send({ type: "log.append", prevHead: "stale", entry: faked });
  assert.equal((await pending.next("error")).code, "forbidden");
  assert.equal(pending.has("log.conflict"), false);
});

test("a recover signed by the code's key but on a stale head gets the conflict with the log", async (t) => {
  const hub = await hubFor(t);
  const account = await newAccount(hub);
  const owner = await online(hub, account, account.device);
  const device = named(await newDeviceKeys());
  const pending = await online(hub, account, device);
  const { entry } = await recoverEntry(account, device);
  await approve(account, owner, named(await newDeviceKeys()));
  pending.send({ type: "log.append", prevHead: entry.prev, entry });
  const conflict = await pending.next("log.conflict");
  assert.equal(conflict.version, 2);
  assert.equal(pending.has("session.approved"), false);
});

// --- denying a sign-in ---

test("a full device denies a sign-in: socket closed with the reason, token dead, card gone", async (t) => {
  const hub = await hubFor(t);
  const account = await newAccount(hub);
  const [owner, laptop] = await household(hub, account, "full");
  const pending = await pendingDevice(hub, account);
  owner.send({ type: "pending.list" });
  const { id } = (await owner.next("pending.list")).pending.find((p) => p.signPub === pending.device.signPub) ?? {};
  assert.equal(typeof id, "string");

  laptop.inbox.length = 0;
  owner.send({ type: "pending.deny", id });
  assert.deepEqual(await owner.next("pending.denied"), { type: "pending.denied", id });
  assert.equal(await pending.closedWithin(), 4410);
  // The push from the sign-in itself may still be on its way, so read until the card is gone; next() times out if it never goes.
  let cards = (await laptop.next("pending.list")).pending;
  while (cards.length > 0) cards = (await laptop.next("pending.list")).pending;

  const reuse = await rawClient(hub);
  reuse.send({ type: "auth", session: pending.session });
  assert.equal(await reuse.closedWithin(), 4401);
  await hub.restart();
  const again = await rawClient(hub);
  again.send({ type: "auth", session: pending.session });
  assert.equal(await again.closedWithin(), 4401, "still blocked after a restart");
});

test("only an approved full device of the same account can deny, and only a pending session", async (t) => {
  const hub = await hubFor(t, { allowSignup: true });
  const account = await newAccount(hub);
  const [owner, laptop, web] = await household(hub, account, "full", "client");
  const a = await pendingDevice(hub, account);
  const b = await pendingDevice(hub, account);
  const stranger = await newAccount(hub, "stranger@example.com");
  const strangerOwner = await online(hub, stranger, stranger.device);
  owner.inbox.length = 0;
  owner.send({ type: "pending.list" });
  const { id } = (await owner.next("pending.list")).pending.find((p) => p.signPub === a.device.signPub);

  web.send({ type: "pending.deny", id });
  assert.equal((await web.next("error")).code, "forbidden");
  b.send({ type: "pending.deny", id });
  assert.equal((await b.next("error")).code, "forbidden");
  strangerOwner.send({ type: "pending.deny", id });
  assert.equal((await strangerOwner.next("error")).code, "not-found");
  owner.send({ type: "pending.deny", id: "made-up" });
  assert.equal((await owner.next("error")).code, "not-found");
  owner.send({ type: "pending.deny", id: 7 });
  assert.equal((await owner.next("error")).code, "bad-message");
  await a.settled();
  assert.equal(a.closeCode, null, "none of those touched it");

  const stored = JSON.parse(readFileSync(join(hub.dir, "sessions.json"), "utf8")).sessions;
  const approvedId = stored.find((s) => s.signPub === laptop.device.signPub).id;
  owner.send({ type: "pending.deny", id: approvedId });
  assert.equal((await owner.next("error")).code, "not-found");
  await laptop.settled();
  assert.equal(laptop.closeCode, null, "an approved device is removed through the log, not denied");
});

// --- changing the password ---

const passwordChange = (currentLoginKey, salt = b64(randomBytes(16)), verifierInput = randomKey()) => ({ type: "password.change", currentLoginKey, salt, verifierInput });

test("a full device changes the password: the new one signs in, the old one stops, sessions stay", async (t) => {
  const hub = await hubFor(t);
  const account = await newAccount(hub);
  const [owner, laptop] = await household(hub, account, "full");
  const change = passwordChange(account.loginKey);
  owner.send(change);
  await owner.next("password.changed");

  const signPub = account.device.signPub;
  assert.equal((await api(hub, "/api/login", { email: account.email, loginKey: account.loginKey, signPub })).status, 401);
  assert.equal((await api(hub, "/api/login", { email: account.email, loginKey: change.verifierInput, signPub })).status, 200);
  assert.equal((await api(hub, "/api/salt", { email: account.email })).json.salt, change.salt);

  owner.send({ type: "channel.msg", to: laptop.device.signPub, opaque: "still here" });
  assert.equal((await laptop.next("channel.msg")).opaque, "still here");

  await hub.restart();
  assert.equal((await api(hub, "/api/login", { email: account.email, loginKey: change.verifierInput, signPub })).status, 200, "survives a restart");
  const text = readFileSync(join(hub.dir, "accounts.json"), "utf8");
  assert.ok(!text.includes(change.verifierInput), "the new key is stored only as a hash");
});

test("a password change needs an approved full device and the current loginKey", async (t) => {
  const hub = await hubFor(t);
  const account = await newAccount(hub);
  const [owner, web] = await household(hub, account, "client");
  const pending = await pendingDevice(hub, account);

  web.send(passwordChange(account.loginKey));
  assert.equal((await web.next("error")).code, "forbidden");
  pending.send(passwordChange(account.loginKey));
  assert.equal((await pending.next("error")).code, "forbidden");
  owner.send(passwordChange(randomKey()));
  assert.equal((await owner.next("error")).code, "wrong-credentials");

  for (const bad of [
    passwordChange("short"),
    passwordChange(7),
    passwordChange(account.loginKey, "short"),
    passwordChange(account.loginKey, b64(randomBytes(32))),
    passwordChange(account.loginKey, undefined, "short"),
    passwordChange(account.loginKey, undefined, null),
  ]) {
    owner.send(bad);
    assert.equal((await owner.next("error")).code, "bad-message");
  }
  assert.equal((await signIn(hub, account, account.device)).state, "approved", "the password is unchanged");
});

test("a password change shares the lockout with sign-in", async (t) => {
  const hub = await hubFor(t);
  const account = await newAccount(hub);
  const owner = await online(hub, account, account.device);
  for (let i = 0; i < 5; i++) {
    owner.send(passwordChange(randomKey()));
    assert.equal((await owner.next("error")).code, "wrong-credentials");
  }
  owner.send(passwordChange(account.loginKey));
  assert.equal((await owner.next("error")).code, "locked", "even with the right key");
  const signPub = account.device.signPub;
  assert.equal((await api(hub, "/api/login", { email: account.email, loginKey: account.loginKey, signPub })).status, 429);
  assert.equal((await signInFrom(hub, account, "127.0.0.2")).status, 200, "another address is not locked");
});

function signInFrom(hub, account, localAddress) {
  return api(hub, "/api/login", { email: account.email, loginKey: account.loginKey, signPub: account.device.signPub }, { localAddress });
}

test("two password changes at once: one wins, the other is told", async (t) => {
  const hub = await hubFor(t);
  const account = await newAccount(hub);
  const [owner, laptop] = await household(hub, account, "full");
  owner.send(passwordChange(account.loginKey));
  laptop.send(passwordChange(account.loginKey));
  const until = Date.now() + WAIT_MS;
  const answered = (s) => s.has("password.changed") || s.has("error");
  while (!answered(owner) || !answered(laptop)) {
    assert.ok(Date.now() < until, "no answer");
    await later(2);
  }
  assert.equal([owner, laptop].filter((s) => s.has("password.changed")).length, 1);
  const loser = [owner, laptop].find((s) => s.has("error"));
  assert.equal((await loser.next("error")).code, "conflict");
});

test("a log append after a password change keeps the new password", async (t) => {
  const hub = await hubFor(t);
  const account = await newAccount(hub);
  const owner = await online(hub, account, account.device);
  const change = passwordChange(account.loginKey);
  owner.send(change);
  await owner.next("password.changed");
  await approve(account, owner, named(await newDeviceKeys()));
  await hub.restart();
  const signPub = account.device.signPub;
  assert.equal((await api(hub, "/api/login", { email: account.email, loginKey: change.verifierInput, signPub })).status, 200);
});

// --- the bootstrap token ---

const firstBody = async (extra = {}) => {
  const device = await newDeviceKeys();
  const log = await createLog({ device: named(device), recoveryPub: (await recoveryKeysFrom(newRecoveryCode())).signPub });
  return { email: "first@example.com", salt: b64(randomBytes(16)), verifierInput: randomKey(), firstLogEntry: log[0], ...extra };
};

test("a fresh hub refuses registration without the right token, all in the same words", async (t) => {
  const hub = await hubFor(t);
  const responses = [
    await api(hub, "/api/register", await firstBody()),
    await api(hub, "/api/register", await firstBody({ bootstrapToken: "wrong-token-of-a-good-length" })),
    await api(hub, "/api/register", await firstBody({ bootstrapToken: 7 })),
    await api(hub, "/api/register", await firstBody({ bootstrapToken: "" })),
    await api(hub, "/api/register", await firstBody({ bootstrapToken: BOOTSTRAP.slice(0, -1) })),
    await api(hub, "/api/register", await firstBody({ bootstrapToken: "x".repeat(300) })),
  ];
  for (const r of responses) {
    assert.equal(r.status, 403);
    assert.equal(r.text, responses[0].text);
  }
  assert.equal((await api(hub, "/api/register", await firstBody({ bootstrapToken: BOOTSTRAP }))).status, 201);
});

test("wrong bootstrap tokens count against the address: guessing stops, the right token included, and only there", async (t) => {
  const hub = await hubFor(t);
  for (let i = 0; i < 20; i++) {
    assert.equal((await api(hub, "/api/register", await firstBody({ bootstrapToken: `wrong-token-of-a-good-length-${i}` }))).status, 403);
  }
  const blocked = await api(hub, "/api/register", await firstBody({ bootstrapToken: BOOTSTRAP }));
  assert.equal(blocked.status, 429);
  assert.equal(blocked.json.error, "locked");
  assert.equal((await api(hub, "/api/login", { email: "x@example.com", loginKey: randomKey(), signPub: randomKey() })).status, 429, "it is the same counter as sign-in's");

  assert.equal((await api(hub, "/api/register", await firstBody({ bootstrapToken: "wrong-token-of-a-good-length" }), { localAddress: "127.0.0.2" })).status, 403, "another address has its own count");

  hub.clock.t += 15 * MINUTE + 1;
  assert.equal((await api(hub, "/api/register", await firstBody({ bootstrapToken: BOOTSTRAP }))).status, 201, "it wears off");
});

test("the lock on guessing looks the same on a hub that is already closed, so it does not show that a hub is fresh", async (t) => {
  const hub = await hubFor(t);
  await newAccount(hub);
  for (let i = 0; i < 20; i++) assert.equal((await api(hub, "/api/register", await firstBody({ bootstrapToken: "wrong-token-of-a-good-length" }))).status, 403);
  assert.equal((await api(hub, "/api/register", await firstBody({ bootstrapToken: "wrong-token-of-a-good-length" }))).status, 429);
});

test("a malformed registration or a right token is not counted as a guess", async (t) => {
  const hub = await hubFor(t, { allowSignup: true });
  for (let i = 0; i < 25; i++) assert.equal((await api(hub, "/api/register", await firstBody({ salt: "short", bootstrapToken: "wrong-token-of-a-good-length" }))).status, 400);
  assert.equal((await api(hub, "/api/register", await firstBody({ bootstrapToken: BOOTSTRAP }))).status, 201);
  for (let i = 0; i < 25; i++) assert.equal((await api(hub, "/api/register", await firstBody({ email: `n${i}@example.com` }))).status, 201, "allowSignup needs no token, so nothing is a guess");
});

test("a fresh hub with no token configured refuses every registration, allowSignup or not", async (t) => {
  for (const allowSignup of [false, true]) {
    const hub = await hubFor(t, { bootstrapToken: null, allowSignup });
    assert.equal((await api(hub, "/api/register", await firstBody())).status, 403);
    assert.equal((await api(hub, "/api/register", await firstBody({ bootstrapToken: BOOTSTRAP }))).status, 403);
  }
});

test("the token is stored only as a hash, and is deleted by the first registration", async (t) => {
  const hub = await hubFor(t);
  const stored = readFileSync(join(hub.dir, "bootstrap"), "utf8");
  assert.equal(stored, createHash("sha256").update(BOOTSTRAP).digest("hex"));
  if (process.platform !== "win32") assert.equal(statSync(join(hub.dir, "bootstrap")).mode & 0o777, 0o600);
  await newAccount(hub);
  assert.deepEqual(readdirSync(hub.dir).sort(), ["accounts.json", "secret", "sessions.json"]);
});

test("the token works once: not again, not after a restart that still has it configured", async (t) => {
  const hub = await hubFor(t);
  await newAccount(hub);
  assert.equal((await api(hub, "/api/register", await firstBody({ bootstrapToken: BOOTSTRAP }))).status, 403);
  await hub.restart();
  assert.ok(!readdirSync(hub.dir).includes("bootstrap"));
  assert.equal((await api(hub, "/api/register", await firstBody({ bootstrapToken: BOOTSTRAP }))).status, 403);
});

test("the stored token survives a restart without the setting", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "omni-hub-test-"));
  const first = await startHub({ port: 0, dataDir: dir, bootstrapToken: BOOTSTRAP, log: () => {} });
  await first.close();
  const hub = await hubFor(t, { dataDir: dir, bootstrapToken: null });
  assert.equal((await api(hub, "/api/register", await firstBody({ bootstrapToken: BOOTSTRAP }))).status, 201);
});

test("allowSignup opens later registrations with no token, never the first", async (t) => {
  const hub = await hubFor(t, { allowSignup: true });
  assert.equal((await api(hub, "/api/register", await firstBody())).status, 403);
  await newAccount(hub);
  assert.equal((await api(hub, "/api/register", await firstBody())).status, 201);
});

test("a bootstrap file left by a crash after registering opens nothing and is removed", async (t) => {
  const hub = await hubFor(t, { bootstrapToken: null, allowSignup: false });
  await hub.close();
  writeFileSync(join(hub.dir, "bootstrap"), createHash("sha256").update(BOOTSTRAP).digest("hex"));
  await hub.restart();
  await newAccount(hub);
  await hub.close();
  writeFileSync(join(hub.dir, "bootstrap"), createHash("sha256").update(BOOTSTRAP).digest("hex"));
  await hub.restart();
  assert.ok(!readdirSync(hub.dir).includes("bootstrap"));
  assert.equal((await api(hub, "/api/register", await firstBody({ bootstrapToken: BOOTSTRAP }))).status, 403);
});

test("a damaged bootstrap file on a fresh hub stops it, and a weak token is refused", async (t) => {
  const hub = await hubFor(t, { bootstrapToken: null });
  await hub.close();
  writeFileSync(join(hub.dir, "bootstrap"), "abc");
  await assert.rejects(startHub({ port: 0, dataDir: hub.dir, log: () => {} }), /bootstrap/);
  await assert.rejects(startHub({ port: 0, dataDir: hub.dir, bootstrapToken: "short", log: () => {} }), /bootstrapToken/);
  await assert.rejects(startHub({ port: 0, dataDir: hub.dir, bootstrapToken: 7, log: () => {} }), /bootstrapToken/);
});

// --- extra origins ---

test("origins adds exact origins for connecting, and proofs still name the hub's own origin", async (t) => {
  const app = "capacitor://omni";
  const hub = await hubFor(t, { origins: [app, "null"] });
  const account = await newAccount(hub);
  for (const Origin of [app, "null", ORIGIN]) assert.equal((await openSocket(hub, { headers: { Origin } })).status, 101, Origin);
  for (const Origin of [`${app}x`, "capacitor://other", "https://evil.example"]) assert.equal((await openSocket(hub, { headers: { Origin } })).status, 403, Origin);
  assert.equal((await api(hub, "/api/salt", { email: account.email }, { headers: { Origin: app } })).status, 200);
  assert.equal((await api(hub, "/api/salt", { email: account.email }, { headers: { Origin: `${app}x` } })).status, 403);

  const { session } = await signIn(hub, account, account.device);
  const { client } = await openSocket(hub, { headers: { Origin: app } });
  client.send({ type: "auth", session });
  const { nonce } = await client.next("auth.challenge");
  client.send({ type: "auth.proof", sig: await sign(account.device.sign.privateKey, proofBytes("omni-hub-auth-v1", nonce, ORIGIN)) });
  assert.equal((await client.next("auth.ok")).state, "approved");
});

test("without origins, the origin an extra list would add stays refused", async (t) => {
  const hub = await hubFor(t);
  assert.equal((await openSocket(hub, { headers: { Origin: "capacitor://omni" } })).status, 403);
});

// --- review fixes ---

test("session.approved is not sent if saving it failed, and the next change tries again", async (t) => {
  const hub = await hubFor(t);
  const account = await newAccount(hub);
  const owner = await online(hub, account, account.device);
  const device = named(await newDeviceKeys());
  const pending = await online(hub, account, device);

  const sessions = join(hub.dir, "sessions.json");
  const backup = readFileSync(sessions);
  rmSync(sessions);
  mkdirSync(sessions);
  writeFileSync(join(sessions, "keep"), "");
  await approve(account, owner, device);
  assert.equal(pending.has("session.approved"), false);
  pending.send({ type: "channel.msg", to: account.device.signPub, opaque: "x" });
  assert.equal((await pending.next("error")).code, "forbidden", "not approved until it is saved");

  rmSync(sessions, { recursive: true });
  writeFileSync(sessions, backup);
  await approve(account, owner, named(await newDeviceKeys()));
  await pending.next("session.approved");
  pending.send({ type: "channel.msg", to: account.device.signPub, opaque: "y" });
  assert.equal((await owner.next("channel.msg")).opaque, "y");
});

test("a client's log.append is refused outright, whatever it holds", async (t) => {
  const hub = await hubFor(t);
  const account = await newAccount(hub);
  const [owner, web] = await household(hub, account, "client");
  const valid = await append(account.log, { type: "add", name: "Y", kind: "desktop", role: "full", ...pick(await newDeviceKeys()), addedAt: 1 }, account.device);
  web.send({ type: "log.append", prevHead: await headOf(account.log), entry: valid.at(-1) });
  assert.equal((await web.next("error")).code, "forbidden");
  web.send({ type: "log.append", prevHead: "stale", entry: valid.at(-1) });
  assert.equal((await web.next("error")).code, "forbidden");
  assert.equal(web.has("log.conflict"), false);
  owner.send({ type: "log.get" });
  assert.equal((await owner.next("log")).version, account.log.length);
});

test("an entry that cannot be next is refused before any replay", async (t) => {
  const hub = await hubFor(t);
  const account = await newAccount(hub);
  const owner = await online(hub, account, account.device);
  const prevHead = await headOf(account.log);
  const valid = (await append(account.log, { type: "add", name: "Y", kind: "desktop", role: "full", ...pick(await newDeviceKeys()), addedAt: 1 }, account.device)).at(-1);
  // A replay would say what it found in LogError's words. These reasons are only said by the check before it.
  const refused = async (entry, reason) => {
    owner.send({ type: "log.append", prevHead, entry });
    const error = await owner.next("error");
    assert.equal(error.code, "invalid-entry");
    assert.equal(error.reason, reason);
  };
  await refused({ ...valid, index: 7 }, "not the next entry");
  await refused({ ...valid, prev: b64(randomBytes(32)) }, "not the next entry");
  await refused(null, "not the next entry");
  await refused("text", "not the next entry");
  const { sig, ...noSig } = valid;
  await refused(noSig, "no signature");
  await refused({ ...valid, sig: 7 }, "no signature");
  await refused({ ...valid, extra: 1 }, "malformed");
  await refused({ ...valid, body: null }, "malformed");
  await refused({ ...valid, type: "nonsense" }, "malformed");
  assert.ok(sig);

  // And a well-formed next entry with a bad signature does reach the replay.
  owner.send({ type: "log.append", prevHead, entry: { ...valid, sig: b64(randomBytes(64)) } });
  assert.match((await owner.next("error")).reason, /bad signature/);
});

test("connections per address are capped on the listener, and closing frees them", async (t) => {
  const hub = await hubFor(t, { limits: { maxConnectionsPerIp: 2 } });
  const open = (localAddress) => new Promise((resolve, reject) => {
    const socket = net.connect({ port: hub.port, host: "127.0.0.1", localAddress }, () => resolve(socket));
    socket.on("error", () => {});
    setTimeout(() => reject(new Error("no connection")), WAIT_MS).unref();
  });
  const dropped = (socket) => new Promise((resolve) => {
    if (socket.destroyed) resolve(true);
    socket.resume();
    socket.once("close", () => resolve(true));
    setTimeout(() => resolve(false), 300).unref();
  });
  const [a, b] = [await open(), await open()];
  const third = await open();
  assert.equal(await dropped(third), true, "over the cap");
  const other = await open("127.0.0.2");
  assert.equal(await dropped(other), false, "another address is not affected");
  assert.equal(a.destroyed, false);

  a.destroy();
  await later(50);
  const again = await open();
  assert.equal(await dropped(again), false, "the place was freed");
  for (const socket of [b, other, again]) socket.destroy();
});

test("a pending socket closing updates the cards and does not push presence", async (t) => {
  const hub = await hubFor(t);
  const account = await newAccount(hub);
  const [owner, laptop] = await household(hub, account, "full");
  const pending = await pendingDevice(hub, account);
  await later(20);
  owner.inbox.length = 0;
  pending.destroy();
  const row = (await owner.next("pending.list")).pending.find((p) => p.signPub === pending.device.signPub);
  assert.equal(row.online, false);
  await owner.settled();
  assert.equal(owner.has("presence"), false);

  // An approved one closing is the opposite.
  owner.inbox.length = 0;
  laptop.destroy();
  assert.deepEqual((await owner.next("presence")).online, [account.device.signPub]);
  await owner.settled();
  assert.equal(owner.has("pending.list"), false);
});

test("WS parser: a frame in many small packets arrives whole", async (t) => {
  const { socket } = await parserHub(t);
  const message = JSON.stringify({ type: "presence", pad: "x".repeat(900) });
  const bytes = frame(TEXT, message);
  socket.socket.setNoDelay(true);
  for (let at = 0; at < bytes.length; at += 10) {
    socket.write(bytes.subarray(at, at + 10));
    await later(1);
  }
  await socket.next("presence");
  await socket.settled();
  assert.equal(socket.closeCode, null);
});

/** A socket with no network under it, so a test can give the parser exact packets. */
function parserOnFakeSocket(onMessage, { maxMessageBytes = 2 * 1024 * 1024 } = {}) {
  const socket = new EventEmitter();
  Object.assign(socket, { writableLength: 0, setNoDelay() {}, write() {}, end() {}, destroy() { socket.emit("close"); } });
  const parser = new HubSocket(socket, Buffer.alloc(0), { maxMessageBytes, maxFramesPerSecond: 100_000, maxBuffered: 1 << 30, pingIntervalMs: 1 << 30, onMessage, onClose() {} });
  return { socket, parser };
}

test("WS parser: a long frame in tiny packets costs one buffer, not a copy per packet", (t) => {
  const messages = [];
  const { socket } = parserOnFakeSocket((text) => messages.push(text));
  t.after(() => socket.destroy());
  const message = "x".repeat(1024 * 1024);
  const bytes = frame(TEXT, message);

  let copied = 0, allocated = 0;
  const { concat, alloc, allocUnsafe, allocUnsafeSlow } = Buffer;
  t.mock.method(Buffer, "concat", (list, size) => { const out = concat.call(Buffer, list, size); copied += out.length; return out; });
  for (const [name, original] of [["alloc", alloc], ["allocUnsafe", allocUnsafe], ["allocUnsafeSlow", allocUnsafeSlow]]) {
    t.mock.method(Buffer, name, (size, ...rest) => { allocated += size; return original.call(Buffer, size, ...rest); });
  }
  for (let at = 0; at < bytes.length; at += 64) socket.emit("data", bytes.subarray(at, at + 64));
  t.mock.restoreAll();

  assert.deepEqual(messages, [message]);
  assert.equal(copied, 0, "nothing is joined");
  assert.ok(allocated <= bytes.length + 64, `${allocated} bytes allocated for a frame of ${bytes.length}`);
});

test("WS parser: frames cut at every possible place arrive whole and in order, and a chunk's own bytes are not lost", (t) => {
  const texts = ["a", "b".repeat(125), "c".repeat(126), "d".repeat(70_000), "é".repeat(300)];
  const bytes = Buffer.concat(texts.map((text) => frame(TEXT, text)));
  const cuts = [1, 2, 3, 5, 7, 13, 14, 127, 1000, 65_536, bytes.length];
  for (const size of cuts) {
    const messages = [];
    const { socket } = parserOnFakeSocket((text) => messages.push(text));
    for (let at = 0; at < bytes.length; at += size) socket.emit("data", Buffer.from(bytes.subarray(at, at + size)));
    assert.deepEqual(messages, texts, `packets of ${size}`);
    socket.destroy();
  }
});

test("WS parser: fragments held across tiny packets arrive whole, and a frame over the limit is refused before it is held", (t) => {
  const messages = [];
  const { socket, parser } = parserOnFakeSocket((text) => messages.push(text), { maxMessageBytes: 1000 });
  t.after(() => socket.destroy());
  const parts = [frame(TEXT, "x".repeat(400), { fin: false }), frame(PING, "p"), frame(CONTINUATION, "y".repeat(400))];
  for (const byte of Buffer.concat(parts)) socket.emit("data", Buffer.from([byte]));
  assert.deepEqual(messages, ["x".repeat(400) + "y".repeat(400)]);

  let allocated = 0;
  const { alloc } = Buffer;
  t.mock.method(Buffer, "alloc", (size, ...rest) => { allocated += size; return alloc.call(Buffer, size, ...rest); });
  const closed = [];
  const close = parser.close.bind(parser);
  parser.close = (code, reason) => { closed.push(code); close(code, reason); };
  socket.emit("data", frame(TEXT, "z".repeat(1001)).subarray(0, 8));
  t.mock.restoreAll();
  assert.deepEqual(closed, [1009]);
  assert.ok(allocated < 1000, "only the header was ever held");
});

// --- limits ---

test("sockets per account are limited: the next device is closed, the ones online stay", async (t) => {
  const hub = await hubFor(t, { limits: { maxSocketsPerAccount: 2 } });
  const account = await newAccount(hub);
  const [owner, laptop] = await household(hub, account, "full");
  const third = named(await newDeviceKeys());
  await approve(account, owner, third);
  const { session } = await signIn(hub, account, third);
  const socket = await rawClient(hub);
  socket.send({ type: "auth", session });
  const { nonce } = await socket.next("auth.challenge");
  socket.send({ type: "auth.proof", sig: await sign(third.sign.privateKey, proofBytes("omni-hub-auth-v1", nonce)) });
  assert.equal(await socket.closedWithin(), 4429);
  assert.equal(socket.has("auth.ok"), false);
  await Promise.all([owner.settled(), laptop.settled()]);

  // A device replacing its own socket does not count twice.
  const replaced = await connect(hub, laptop.session, laptop.device);
  assert.equal(replaced.auth.state, "approved");
});

test("unauthenticated sockets are limited per address and in total", async (t) => {
  const hub = await hubFor(t, { limits: { maxUnauthPerIp: 2, maxSockets: 4 } });
  await rawClient(hub);
  await rawClient(hub);
  assert.equal((await openSocket(hub)).status, 429);
  await rawClient(hub, { localAddress: "127.0.0.2" });
  await rawClient(hub, { localAddress: "127.0.0.3" });
  assert.equal((await openSocket(hub, { localAddress: "127.0.0.4" })).status, 503);
});

test("closing unauthenticated sockets frees their places", async (t) => {
  const hub = await hubFor(t, { limits: { maxUnauthPerIp: 1 } });
  const first = await rawClient(hub);
  assert.equal((await openSocket(hub)).status, 429);
  first.destroy();
  await later(30);
  assert.equal((await openSocket(hub)).status, 101);
});

test("total accounts are limited", async (t) => {
  const hub = await hubFor(t, { allowSignup: true, limits: { maxAccounts: 1 } });
  await newAccount(hub);
  const device = await newDeviceKeys();
  const log = await createLog({ device: named(device), recoveryPub: (await recoveryKeysFrom(newRecoveryCode())).signPub });
  assert.equal((await api(hub, "/api/register", { email: "b@example.com", salt: b64(randomBytes(16)), verifierInput: randomKey(), firstLogEntry: log[0] })).status, 403);
});

test("a socket that sends too many messages in a second is closed", async (t) => {
  const hub = await hubFor(t, { limits: { maxFramesPerSecond: 50 } });
  const account = await newAccount(hub);
  const owner = await online(hub, account, account.device);
  owner.write(Buffer.concat(Array.from({ length: 200 }, () => frame(TEXT, JSON.stringify({ type: "presence" })))));
  assert.equal(await owner.closedWithin(), 1008);
});

test("control frames count against the rate limit too", async (t) => {
  const hub = await hubFor(t, { limits: { maxFramesPerSecond: 50 } });
  const socket = await rawClient(hub);
  socket.write(Buffer.concat(Array.from({ length: 200 }, () => frame(PING))));
  assert.equal(await socket.closedWithin(), 1008);
});

test("a burst larger than the hub will hold for one socket closes that socket", async (t) => {
  const hub = await hubFor(t, { limits: { maxQueuedBytes: 1000 } });
  const account = await newAccount(hub);
  const owner = await online(hub, account, account.device);
  const big = frame(TEXT, JSON.stringify({ type: "presence", pad: "x".repeat(800) }));
  owner.write(Buffer.concat([big, big]));
  assert.equal(await owner.closedWithin(), 1008);
});

test("a reader that stops reading gets busy for its senders, instead of filling the hub's memory", async (t) => {
  const hub = await hubFor(t, { limits: { maxBuffered: 1024 * 1024, maxFramesPerSecond: 100_000 } });
  const account = await newAccount(hub);
  const [owner, laptop] = await household(hub, account, "full");
  laptop.socket.pause();
  const opaque = "x".repeat(512 * 1024);
  let busy = null;
  for (let i = 0; i < 200 && !busy; i++) {
    owner.send({ type: "channel.msg", to: laptop.device.signPub, opaque });
    await owner.settled();
    busy = owner.inbox.find((m) => m.type === "error");
  }
  assert.equal(busy?.code, "busy");
  assert.equal(owner.closeCode, null);
});

test("a socket that makes the hub answer and never reads the answers is dropped", async (t) => {
  const hub = await hubFor(t, { limits: { maxBuffered: 256 * 1024 } });
  const account = await newAccount(hub);
  const [owner, laptop] = await household(hub, account, "full");
  owner.inbox.length = 0;
  laptop.socket.pause();
  const echoed = JSON.stringify({ type: "channel.msg", to: "x".repeat(512 * 1024), opaque: "" });
  const flood = setInterval(() => laptop.write(frame(TEXT, echoed)), 5);
  t.after(() => clearInterval(flood));
  // A push from the laptop coming online may still be on its way, so wait for the one without it.
  let seen = await owner.next("presence", 20_000);
  while (seen.online.includes(laptop.device.signPub)) seen = await owner.next("presence", 20_000);
  clearInterval(flood);
  assert.deepEqual(seen.online, [account.device.signPub]);
});

test("a socket that stops answering pings is closed; one that answers stays", async (t) => {
  const hub = await hubFor(t, { limits: { pingIntervalMs: 40 } });
  const quiet = await rawClient(hub);
  const account = await newAccount(hub);
  const owner = await online(hub, account, account.device);
  const silent = await online(hub, account, named(await newDeviceKeys()));
  silent.autoPong = false;
  quiet.autoPong = false;
  assert.equal(await silent.closedWithin(), 1006);
  assert.ok(silent.pings >= 1);
  await later(120);
  assert.ok(owner.pings >= 2);
  assert.equal(owner.closeCode, null);
});

// --- WebSocket parser ---

const MAX = 1024;

async function parserHub(t) {
  const hub = await hubFor(t, { limits: { maxMessageBytes: MAX, maxUnauthMessageBytes: MAX } });
  const account = await newAccount(hub);
  const socket = await online(hub, account, account.device);
  return { hub, account, socket };
}

async function closesWith(t, code, bytes) {
  const { socket } = await parserHub(t);
  socket.write(bytes);
  assert.equal(await socket.closedWithin(), code);
}

test("WS parser: refuses what RFC 6455 forbids", async (t) => {
  const presence = JSON.stringify({ type: "presence" });
  const cases = {
    "an unmasked frame": [1002, frame(TEXT, presence, { masked: false })],
    "a reserved bit": [1002, frame(TEXT, presence, { rsv: 0x40 })],
    "another reserved bit": [1002, frame(TEXT, presence, { rsv: 0x10 })],
    "a reserved data opcode": [1002, frame(3, presence)],
    "a reserved control opcode": [1002, frame(0x0b)],
    "a continuation with nothing to continue": [1002, frame(CONTINUATION, presence)],
    "a new message inside a fragmented one": [1002, Buffer.concat([frame(TEXT, "{", { fin: false }), frame(TEXT, "}")])],
    "a fragmented control frame": [1002, frame(PING, "x", { fin: false })],
    "a control frame over 125 bytes": [1002, frame(PING, Buffer.alloc(126))],
    "a 16-bit length that fits in 7": [1002, Buffer.concat([Buffer.from([0x81, 0xfe, 0, 5]), randomBytes(4), Buffer.alloc(5)])],
    "a 64-bit length that fits in 16": [1002, Buffer.concat([Buffer.from([0x81, 0xff, 0, 0, 0, 0, 0, 0, 0, 5]), randomBytes(4), Buffer.alloc(5)])],
    "a 64-bit length with the top bit set": [1002, Buffer.from([0x81, 0xff, 0x80, 0, 0, 0, 0, 0, 0, 0])],
    "a close with a one-byte payload": [1002, frame(CLOSE, "x")],
    "a close with a forbidden code": [1002, frame(CLOSE, Buffer.from([0x03, 0xed]))],
    "invalid UTF-8": [1007, frame(TEXT, Buffer.from([0xc3, 0x28]))],
    "UTF-8 split across fragments that stays invalid": [1007, Buffer.concat([frame(TEXT, Buffer.from([0xc3]), { fin: false }), frame(CONTINUATION, Buffer.from([0x28]))])],
    "a binary message": [1003, frame(BINARY, Buffer.from([1, 2, 3]))],
  };
  for (const [name, [code, bytes]] of Object.entries(cases)) {
    await t.test(name, (st) => closesWith(st, code, bytes));
  }
});

test("WS parser: over-limit frames close the socket", async (t) => {
  const cases = {
    "one frame just over": frame(TEXT, Buffer.alloc(MAX + 1, 0x20)),
    "a length of 2 GiB, announced with no data": Buffer.concat([Buffer.from([0x81, 0xff, 0, 0, 0, 0, 0x80, 0, 0, 0]), randomBytes(4)]),
    "the largest 63-bit length": Buffer.from([0x81, 0xff, 0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
    "a 16-bit length, announced with no data": Buffer.from([0x81, 0xfe, 0xff, 0xff]),
    "fragments that together go over": Buffer.concat([frame(TEXT, Buffer.alloc(MAX, 0x20), { fin: false }), frame(CONTINUATION, Buffer.alloc(1, 0x20))]),
  };
  for (const [name, bytes] of Object.entries(cases)) {
    await t.test(name, (st) => closesWith(st, 1009, bytes));
  }
});

test("WS parser: a frame at exactly the limit is delivered", async (t) => {
  const { socket } = await parserHub(t);
  const text = JSON.stringify({ type: "presence", pad: "" });
  const message = text.replace('"pad":""', `"pad":"${"x".repeat(MAX - text.length)}"`);
  assert.equal(message.length, MAX);
  socket.write(frame(TEXT, message));
  await socket.next("presence");
});

test("WS parser: before auth the limit is far smaller", async (t) => {
  const hub = await hubFor(t);
  const socket = await rawClient(hub);
  socket.write(frame(TEXT, Buffer.alloc(100_000, 0x20)));
  assert.equal(await socket.closedWithin(), 1009);
});

test("WS parser: fragments are reassembled, with control frames in between", async (t) => {
  const { socket } = await parserHub(t);
  const text = Buffer.from(JSON.stringify({ type: "presence" }));
  socket.inbox.length = 0;
  socket.write(frame(TEXT, text.subarray(0, 4), { fin: false }));
  socket.write(frame(PING, "between"));
  socket.write(frame(CONTINUATION, text.subarray(4, 9), { fin: false }));
  socket.write(frame(CONTINUATION, Buffer.alloc(0), { fin: false }));
  socket.write(frame(CONTINUATION, text.subarray(9)));
  await socket.next("presence");
  assert.ok(socket.pongs.some((p) => p.toString() === "between"));
});

test("WS parser: UTF-8 split across fragments is one character", async (t) => {
  const { hub, socket, account } = await parserHub(t);
  const device = named(await newDeviceKeys());
  await approve(account, socket, device);
  const peer = await online(hub, account, device);
  const bytes = Buffer.from(JSON.stringify({ type: "channel.msg", to: device.signPub, opaque: "é" }));
  const split = bytes.indexOf(0xc3) + 1;
  socket.write(frame(TEXT, bytes.subarray(0, split), { fin: false }));
  socket.write(frame(CONTINUATION, bytes.subarray(split)));
  assert.equal((await peer.next("channel.msg")).opaque, "é");
});

test("WS parser: a frame arriving one byte at a time still works, as do several in one packet", async (t) => {
  const { socket } = await parserHub(t);
  const bytes = frame(TEXT, JSON.stringify({ type: "presence" }));
  for (const byte of bytes) {
    socket.write(Buffer.from([byte]));
    await later(1);
  }
  await socket.next("presence");
  const one = frame(TEXT, JSON.stringify({ type: "presence" }));
  socket.write(Buffer.concat([one, one, one]));
  await socket.next("presence");
  await socket.next("presence");
  await socket.next("presence");
});

test("WS parser: a close is echoed with its code", async (t) => {
  const { socket } = await parserHub(t);
  socket.write(frame(CLOSE, Buffer.from([0x03, 0xe8])));
  assert.equal(await socket.closedWithin(), 1000);
});

test("WS parser: noise instead of frames never crashes the hub", async (t) => {
  const hub = await hubFor(t, { limits: { maxUnauthPerIp: 1000 } });
  for (let i = 0; i < 30; i++) {
    const socket = await rawClient(hub);
    socket.write(randomBytes(1 + (i * 37) % 4096));
    socket.destroy();
  }
  await later(30);
  assert.equal((await api(hub, "/api/health", undefined, { method: "GET" })).status, 200);
});

test("WS parser: a half frame followed by a dropped connection cleans up", async (t) => {
  const hub = await hubFor(t, { limits: { maxUnauthPerIp: 1 } });
  const socket = await rawClient(hub);
  socket.write(Buffer.from([0x81, 0xfe, 0x00]));
  socket.destroy();
  await later(30);
  assert.equal((await openSocket(hub)).status, 101);
});

// --- the store ---

test("a crash mid-write leaves a temp file that changes nothing and is cleaned up", async (t) => {
  const hub = await hubFor(t);
  const account = await newAccount(hub);
  await hub.close();
  const leftover = join(hub.dir, "accounts.json.abc123.tmp");
  writeFileSync(leftover, '{"version":1,"accounts":[{"half');
  await hub.restart();
  assert.equal((await signIn(hub, account, account.device)).state, "approved");
  assert.ok(!readdirSync(hub.dir).some((name) => name.endsWith(".tmp")));
});

test("no temp file is left behind by normal writes", async (t) => {
  const hub = await hubFor(t);
  await newAccount(hub);
  assert.deepEqual(readdirSync(hub.dir).sort(), ["accounts.json", "secret", "sessions.json"]);
});

test("a corrupt store stops the hub with a clear error, and is left for inspection", async (t) => {
  const write = (file, text) => (dir) => writeFileSync(join(dir, file), text);
  const remove = (file) => (dir) => rmSync(join(dir, file));
  const edit = (change) => (dir) => {
    const file = join(dir, "accounts.json");
    const data = JSON.parse(readFileSync(file, "utf8"));
    change(data);
    writeFileSync(file, JSON.stringify(data));
  };
  const cases = {
    "truncated accounts": [write("accounts.json", '{"version":1,"acc'), /accounts\.json/],
    "empty accounts": [write("accounts.json", ""), /accounts\.json/],
    "accounts of the wrong shape": [write("accounts.json", '{"version":1,"accounts":{}}'), /accounts\.json/],
    "an account missing its verifier": [edit((d) => { delete d.accounts[0].verifier; }), /accounts\.json/],
    "an unknown version": [edit((d) => { d.version = 99; }), /accounts\.json/],
    "accounts missing while others remain": [remove("accounts.json"), /accounts\.json/],
    "truncated sessions": [write("sessions.json", "{"), /sessions\.json/],
    "sessions missing": [remove("sessions.json"), /sessions\.json/],
    "secret missing": [remove("secret"), /secret/],
    "a short secret": [write("secret", "abc"), /secret/],
    "a device log that does not verify": [edit((d) => { d.accounts[0].log[0].body.name = "Tampered"; }), /log/],
    "a session for no account": [(dir) => {
      const file = join(dir, "sessions.json");
      const data = JSON.parse(readFileSync(file, "utf8"));
      data.sessions[0].accountId = "nobody";
      writeFileSync(file, JSON.stringify(data));
    }, /sessions\.json/],
  };
  for (const [name, [damage, pattern]] of Object.entries(cases)) {
    await t.test(name, async (st) => {
      const hub = await hubFor(st);
      const account = await newAccount(hub);
      await signIn(hub, account, account.device);
      await hub.close();
      damage(hub.dir);
      const seen = Object.fromEntries(dataFiles(hub.dir).map(({ name: n, text }) => [n, text]));
      await assert.rejects(startHub({ port: 0, dataDir: hub.dir, origin: ORIGIN, log: () => {} }), pattern);
      for (const { name: n, text } of dataFiles(hub.dir)) assert.equal(text, seen[n], `${n} must be left as found`);
      assert.deepEqual(Object.keys(seen).sort(), readdirSync(hub.dir).sort(), "nothing created in its place");
    });
  }
});

test("a store write that fails refuses the action and changes nothing in memory", async (t) => {
  const hub = await hubFor(t);
  const account = await newAccount(hub);
  const owner = await online(hub, account, account.device);
  const dir = hub.dir;
  // A directory where the temp file would be renamed to makes the rename fail on every platform.
  const fresh = named(await newDeviceKeys());
  const next = await append(account.log, { type: "add", name: "X", kind: "desktop", role: "full", ...pick(fresh), addedAt: 1 }, account.device);
  const prevHead = await headOf(account.log);
  const accounts = join(dir, "accounts.json");
  const backup = readFileSync(accounts);
  rmSync(accounts);
  mkdirSync(accounts);
  writeFileSync(join(accounts, "keep"), "");

  owner.send({ type: "log.append", prevHead, entry: next.at(-1) });
  assert.equal((await owner.next("error")).code, "internal");
  owner.send({ type: "log.get" });
  assert.equal((await owner.next("log")).version, 1, "not accepted if not durable");

  rmSync(accounts, { recursive: true });
  writeFileSync(accounts, backup);
  owner.send({ type: "log.append", prevHead, entry: next.at(-1) });
  await owner.next("log.ok");
});

// --- secrets stay out of logs ---

test("loginKey, tokens and opaque payloads never reach the log output", async (t) => {
  const logged = [];
  const hub = await hubFor(t, { logged, allowSignup: true });
  const account = await newAccount(hub);
  const [owner, laptop] = await household(hub, account, "full");
  const opaque = "OPAQUE-PAYLOAD-MARKER";
  owner.send({ type: "channel.msg", to: laptop.device.signPub, opaque });
  await laptop.next("channel.msg");

  const printed = [];
  const original = { error: console.error, log: console.log, warn: console.warn };
  for (const k of Object.keys(original)) console[k] = (...args) => printed.push(args.join(" "));
  try {
    // Provoke every failure path that might be tempted to log what it was given.
    await api(hub, "/api/login", { email: account.email, loginKey: randomKey(), signPub: account.device.signPub });
    await api(hub, "/api/login", null, { raw: `{"loginKey":"${account.loginKey}"` });
    owner.write(frame(TEXT, `{"opaque":"${opaque}"`));
    await owner.next("error");
    owner.send({ type: "password.change", currentLoginKey: account.loginKey, salt: "bad", verifierInput: randomKey() });
    await owner.next("error");
    const bad = await rawClient(hub);
    bad.send({ type: "auth", session: owner.session.slice(0, -2) });
    await bad.closedWithin();
    const garbled = await rawClient(hub);
    garbled.write(frame(TEXT, `not json ${owner.session}`));
    await garbled.closedWithin();

    // An internal failure, with the secret in hand.
    const accounts = join(hub.dir, "accounts.json");
    const backup = readFileSync(accounts);
    rmSync(accounts);
    mkdirSync(accounts);
    const entry = (await append(account.log, { type: "add", name: "Y", kind: "desktop", role: "full", ...pick(await newDeviceKeys()), addedAt: 1 }, account.device)).at(-1);
    owner.send({ type: "log.append", prevHead: await headOf(account.log), entry });
    await owner.next("error");
    rmSync(accounts, { recursive: true });
    writeFileSync(accounts, backup);
  } finally {
    Object.assign(console, original);
  }
  const everything = [...logged, ...printed].join("\n");
  assert.ok(logged.length >= 1, "the internal failure is logged");
  assert.ok(!everything.includes(account.loginKey));
  assert.ok(!everything.includes(owner.session));
  assert.ok(!everything.includes(owner.session.slice(0, -2)));
  assert.ok(!everything.includes(opaque));
  assert.ok(!everything.includes(BOOTSTRAP));
});

// --- what the hub is built from ---

test("the hub imports only node: built-ins available on Node 20 and the two ui modules", () => {
  const allowedUi = new Set(["../ui/account-core.js", "../ui/device-log.js"]);
  const allowedLocal = new Set(["./ws.mjs", "./store.mjs"]);
  for (const file of ["server.mjs", "ws.mjs", "store.mjs"]) {
    const source = readFileSync(new URL(`../hub/${file}`, import.meta.url), "utf8");
    const imports = [...source.matchAll(/^\s*import\b.*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
    assert.ok(imports.length >= 1, file);
    for (const name of imports) {
      assert.ok(name.startsWith("node:") || allowedUi.has(name) || allowedLocal.has(name), `${file} imports ${name}`);
      assert.notEqual(name, "node:sqlite");
    }
    assert.doesNotMatch(source, /\bimport\(|\brequire\(/, file);
    assert.doesNotMatch(source, /Promise\.withResolvers|Object\.groupBy|Map\.groupBy|globalThis\.WebSocket|new WebSocket\b/, file);
  }
});

test("without TLS the hub only listens on loopback, whatever it is asked", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "omni-hub-test-"));
  const hub = await startHub({ port: 0, dataDir: dir, host: "0.0.0.0", log: () => {} });
  t.after(async () => {
    await hub.close();
    rmSync(dir, { recursive: true, force: true });
  });
  assert.equal(hub.address, "127.0.0.1");
});

test("run as a program: it reads its settings from the environment, and a corrupt store exits with the reason", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "omni-hub-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  const server = fileURLToPath(new URL("../hub/server.mjs", import.meta.url));
  const env = { ...process.env, OMNI_HUB_PORT: "0", OMNI_HUB_DATA: dir, OMNI_HUB_BOOTSTRAP_TOKEN: BOOTSTRAP, OMNI_HUB_ORIGIN: ORIGIN, OMNI_HUB_EXTRA_ORIGINS: " capacitor://omni , ,null,," };

  const child = spawn(process.execPath, [server], { env, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.kill());
  const port = await new Promise((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (c) => {
      out += c;
      const found = out.match(/listening on port (\d+)/);
      if (found) resolve(Number(found[1]));
    });
    child.once("exit", (code) => reject(new Error(`exited with ${code}`)));
  });
  assert.equal((await api({ port }, "/api/health", undefined, { method: "GET" })).status, 200);
  assert.equal(readFileSync(join(dir, "bootstrap"), "utf8"), createHash("sha256").update(BOOTSTRAP).digest("hex"));
  assert.equal((await api({ port }, "/api/salt", { email: "a@b.c" }, { headers: { Origin: "capacitor://omni" } })).status, 200);
  assert.equal((await api({ port }, "/api/salt", { email: "a@b.c" }, { headers: { Origin: "null" } })).status, 200);
  assert.equal((await api({ port }, "/api/salt", { email: "a@b.c" }, { headers: { Origin: "https://evil.example" } })).status, 403);
  assert.equal((await api({ port }, "/api/salt", { email: "a@b.c" }, { headers: { Origin: "" } })).status, 403, "stray commas do not allow an empty origin");
  const stopped = new Promise((resolve) => child.once("exit", resolve));
  child.kill();
  await stopped;

  writeFileSync(join(dir, "accounts.json"), "{broken");
  const broken = spawn(process.execPath, [server], { env, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  broken.stderr.on("data", (c) => { stderr += c; });
  const code = await new Promise((resolve) => broken.once("exit", resolve));
  assert.notEqual(code, 0);
  assert.match(stderr, /accounts\.json/);
  assert.doesNotMatch(stderr, /at .*\.mjs/, "a reason, not a stack trace");
});
