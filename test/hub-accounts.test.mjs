// Several accounts on one hub: invite codes, who may make them, the limits per address and per account, and above all that
// nothing routes, lists or leaks from one account to another. Real sockets, on an ephemeral loopback port.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newDeviceKeys, newRecoveryCode, recoveryKeysFrom, sign } from "../ui/account-core.js";
import { append, createLog, verifyLog } from "../ui/device-log.js";
import { startHub } from "../hub/server.mjs";

const ORIGIN = "https://hub.example";
const BOOTSTRAP = "test-bootstrap-token-0123456789";
const DAY = 24 * 60 * 60_000;
const WAIT_MS = 4000;
const b64 = (bytes) => Buffer.from(bytes).toString("base64");
const randomKey = () => b64(randomBytes(32));
const later = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function hubFor(t, options = {}) {
  const dir = options.dataDir ?? mkdtempSync(join(tmpdir(), "omni-hub-accounts-"));
  const clock = options.clock ?? { t: 1_800_000_000_000 };
  const sockets = [];
  const open = () => startHub({ port: 0, dataDir: dir, origin: ORIGIN, bootstrapToken: BOOTSTRAP, now: () => clock.t, sweepMs: 20, log: () => {}, ...options });
  let running = await open();
  const hub = {
    clock, dir, sockets,
    get port() { return running.port; },
    get url() { return `http://127.0.0.1:${running.port}`; },
    async restart() { for (const s of sockets) s.close(); await running.close(); running = await open(); },
  };
  t.after(async () => {
    for (const s of sockets) s.close();
    await running.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  return hub;
}

async function api(hub, path, body) {
  const r = await fetch(`${hub.url}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
}

/** A socket with an inbox. `next` takes the first message of a type, and `never` says one has not come after a round trip. */
class Socket {
  inbox = [];
  closeCode = null;
  #waiters = [];

  constructor(hub) {
    this.ws = new WebSocket(`ws://127.0.0.1:${hub.port}/ws`);
    this.opened = new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = reject; });
    this.ws.onmessage = (event) => {
      this.inbox.push(JSON.parse(event.data));
      for (const w of [...this.#waiters]) w();
    };
    this.ws.onclose = (event) => {
      this.closeCode = event.code;
      for (const w of [...this.#waiters]) w();
    };
    hub.sockets.push(this);
  }

  send(message) { this.ws.send(JSON.stringify(message)); }
  close() { try { this.ws.close(); } catch { /* it went */ } }
  has(type) { return this.inbox.some((m) => m.type === type); }

  async next(type, ms = WAIT_MS) {
    const take = () => {
      const at = this.inbox.findIndex((m) => m.type === type);
      return at < 0 ? null : this.inbox.splice(at, 1)[0];
    };
    const found = take();
    if (found) return found;
    return new Promise((resolve, reject) => {
      const done = () => { clearTimeout(timer); this.#waiters.splice(this.#waiters.indexOf(waiter), 1); };
      const timer = setTimeout(() => { done(); reject(new Error(`no ${type} within ${ms} ms; inbox ${JSON.stringify(this.inbox).slice(0, 300)}; closed ${this.closeCode}`)); }, ms);
      const waiter = () => {
        const got = take();
        if (got) { done(); resolve(got); }
      };
      this.#waiters.push(waiter);
    });
  }

  /** A full round trip, so whatever the hub was going to send here because of an earlier message has come. */
  async settled() {
    this.inbox = this.inbox.filter((m) => m.type !== "presence");
    this.send({ type: "presence" });
    await this.next("presence");
  }
}

const named = (keys, name, kind = "desktop") => ({ ...keys, name, kind });

async function makeBody(email, extra = {}) {
  const device = named(await newDeviceKeys(), `${email} PC`);
  const log = await createLog({ device, recovery: await recoveryKeysFrom(newRecoveryCode()) });
  const account = { email, device, log, loginKey: randomKey(), salt: b64(randomBytes(16)) };
  return { account, body: { email, salt: account.salt, verifierInput: account.loginKey, anchor: randomKey(), firstLogEntry: log[0], ...extra } };
}

async function firstAccount(hub, email = "owner@example.com") {
  const { account, body } = await makeBody(email, { bootstrapToken: BOOTSTRAP });
  const r = await api(hub, "/api/register", body);
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return account;
}

async function connect(hub, session, device) {
  const socket = new Socket(hub);
  await socket.opened;
  socket.send({ type: "auth", session });
  const { nonce } = await socket.next("auth.challenge");
  socket.send({ type: "auth.proof", sig: await sign(device.sign.privateKey, new TextEncoder().encode(`omni-hub-auth-v1 ${ORIGIN} ${nonce}`)) });
  socket.auth = await socket.next("auth.ok");
  socket.device = device;
  return socket;
}

async function online(hub, account, device = account.device, extra = {}) {
  const r = await api(hub, "/api/login", { email: account.email, loginKey: account.loginKey, signPub: device.signPub, ...extra });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const socket = await connect(hub, r.json.session, device);
  socket.session = r.json.session;
  return socket;
}

async function addDevice(hub, account, socket, device, role = "full") {
  const next = await append(account.log, { type: "add", name: device.name, kind: device.kind, role, signPub: device.signPub, boxPub: device.boxPub, addedAt: hub.clock.t }, account.device);
  socket.send({ type: "log.append", prevHead: (await verifyLog(account.log, { now: hub.clock.t })).head, entry: next.at(-1) });
  await socket.next("log.ok");
  account.log = next;
}

const makeInvite = async (socket) => {
  socket.send({ type: "invite.create" });
  return socket.next("invite.created");
};

/** A second account, in by a real invite. */
async function invitedAccount(hub, ownerSocket, email) {
  const { code } = await makeInvite(ownerSocket);
  const { account, body } = await makeBody(email, { inviteCode: code });
  const r = await api(hub, "/api/register", body);
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return account;
}

/** Owner and another person, both online on their first devices. */
async function twoPeople(t, options) {
  const hub = await hubFor(t, options);
  const alice = await firstAccount(hub, "alice@example.com");
  const a = await online(hub, alice);
  const bob = await invitedAccount(hub, a, "bob@example.com");
  const b = await online(hub, bob);
  return { hub, alice, bob, a, b };
}

// ------------------------------------------------------------------------------------- invite codes

test("after the first account, registering needs an invite; there is no open door", async (t) => {
  const hub = await hubFor(t);
  await firstAccount(hub);
  const { body } = await makeBody("stranger@example.com");
  const r = await api(hub, "/api/register", body);
  assert.equal(r.status, 403);
  assert.equal(r.json.error, "registration-closed");
  const token = await makeBody("stranger@example.com", { bootstrapToken: BOOTSTRAP });
  assert.equal((await api(hub, "/api/register", token.body)).status, 403, "the token is spent once an account exists");
});

test("the hub has no switch that opens sign-ups any more", async (t) => {
  const hub = await hubFor(t, { allowSignup: true });
  await firstAccount(hub);
  assert.equal((await api(hub, "/api/register", (await makeBody("x@example.com")).body)).status, 403);
  const source = readFileSync(new URL("../hub/server.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /ALLOW_SIGNUP|allowSignup/);
});

test("an invite is single use, also for two registrations at the same moment", async (t) => {
  const hub = await hubFor(t);
  const owner = await firstAccount(hub);
  const socket = await online(hub, owner);
  const { code } = await makeInvite(socket);
  const answers = await Promise.all(["a@example.com", "b@example.com", "c@example.com"].map(async (email) => api(hub, "/api/register", (await makeBody(email, { inviteCode: code })).body)));
  assert.deepEqual(answers.map((r) => r.status).sort(), [201, 403, 403]);
  const refused = answers.find((r) => r.status === 403);
  assert.equal(refused.json.error, "bad-invite");
  socket.send({ type: "invite.list" });
  const { invites } = await socket.next("invite.list");
  assert.deepEqual(invites.map((i) => i.state), ["used"]);
});

test("an invite ends after 14 days", async (t) => {
  const clock = { t: 1_800_000_000_000 };
  const hub = await hubFor(t, { clock });
  const owner = await firstAccount(hub);
  const socket = await online(hub, owner);
  const made = await makeInvite(socket);
  assert.equal(made.expiresAt, clock.t + 14 * DAY);
  clock.t += 14 * DAY + 1;
  const r = await api(hub, "/api/register", (await makeBody("late@example.com", { inviteCode: made.code })).body);
  assert.equal(r.json.error, "bad-invite");
  socket.send({ type: "invite.list" });
  assert.deepEqual((await socket.next("invite.list")).invites.map((i) => i.state), ["expired"]);
});

test("an invite is stored only as a hash, and the list never shows the code", async (t) => {
  const hub = await hubFor(t);
  const owner = await firstAccount(hub);
  const socket = await online(hub, owner);
  const { code } = await makeInvite(socket);
  const stored = readFileSync(join(hub.dir, "invites.json"), "utf8");
  const bare = code.replace(/-/g, "");
  assert.ok(!stored.includes(code) && !stored.includes(bare), "not in the file");
  assert.ok(stored.includes(createHash("sha256").update(bare).digest("base64")), "its hash is");
  socket.send({ type: "invite.list" });
  const list = await socket.next("invite.list");
  assert.ok(!JSON.stringify(list).includes(bare));
  assert.deepEqual(Object.keys(list.invites[0]).sort(), ["createdAt", "expiresAt", "id", "state"]);
});

test("a code can be typed in any case, with or without the dashes", async (t) => {
  const hub = await hubFor(t);
  const owner = await firstAccount(hub);
  const socket = await online(hub, owner);
  const { code } = await makeInvite(socket);
  const r = await api(hub, "/api/register", (await makeBody("typed@example.com", { inviteCode: ` ${code.replace(/-/g, " ").toLowerCase()} ` })).body);
  assert.equal(r.status, 201);
});

test("a revoked invite stops working at once, and it survives a restart if not revoked", async (t) => {
  const hub = await hubFor(t);
  const owner = await firstAccount(hub);
  let socket = await online(hub, owner);
  const gone = await makeInvite(socket);
  const kept = await makeInvite(socket);
  socket.send({ type: "invite.revoke", id: gone.id });
  assert.equal((await socket.next("invite.revoked")).id, gone.id);
  assert.equal((await api(hub, "/api/register", (await makeBody("x@example.com", { inviteCode: gone.code })).body)).json.error, "bad-invite");
  socket.send({ type: "invite.revoke", id: gone.id });
  assert.equal((await socket.next("error")).code, "not-found");
  await hub.restart();
  socket = await online(hub, owner);
  assert.equal((await api(hub, "/api/register", (await makeBody("y@example.com", { inviteCode: kept.code })).body)).status, 201);
});

test("only a full device of the first account can make, list or revoke invites", async (t) => {
  const { hub, alice, a, b } = await twoPeople(t);
  const live = await makeInvite(a);

  // Another account's full device, however much it has on its own account.
  for (const message of [{ type: "invite.create" }, { type: "invite.list" }, { type: "invite.revoke", id: live.id }]) {
    b.send(message);
    const error = await b.next("error");
    assert.equal(error.code, "forbidden", message.type);
    assert.equal(error.for, message.type);
  }

  // A limited web page on the owner's own account.
  const web = named(await newDeviceKeys(), "Web", "web");
  await addDevice(hub, alice, a, web, "client");
  const page = await online(hub, alice, web);
  page.send({ type: "invite.create" });
  assert.equal((await page.next("error")).code, "forbidden");

  // A sign-in the owner's devices have not approved: the password alone makes no invites.
  const newcomer = named(await newDeviceKeys(), "New");
  const waiting = await online(hub, alice, newcomer);
  assert.equal(waiting.auth.state, "pending");
  waiting.send({ type: "invite.create" });
  assert.equal((await waiting.next("error")).code, "forbidden");

  // And a second full device of the owner may.
  const laptop = named(await newDeviceKeys(), "Laptop");
  await addDevice(hub, alice, a, laptop);
  const second = await online(hub, alice, laptop);
  assert.ok((await makeInvite(second)).code);
  assert.equal((await api(hub, "/api/register", (await makeBody("z@example.com", { inviteCode: live.code })).body)).status, 201, "the first invite was untouched");
});

test("who owns the hub is remembered, whatever order the file ends up in", async (t) => {
  const { hub, alice, bob, a, b } = await twoPeople(t);
  // Any write moves that account to the end of the file: "the first in the file" is not the first account.
  await addDevice(hub, bob, b, named(await newDeviceKeys(), "Bob laptop"));
  await addDevice(hub, alice, a, named(await newDeviceKeys(), "Alice laptop"));
  await addDevice(hub, bob, b, named(await newDeviceKeys(), "Bob other"));
  await hub.restart();
  const a2 = await online(hub, alice);
  const b2 = await online(hub, bob);
  assert.ok((await makeInvite(a2)).code);
  b2.send({ type: "invite.create" });
  assert.equal((await b2.next("error")).code, "forbidden");
});

test("the number of live invites is limited, and a used one does not count", async (t) => {
  const hub = await hubFor(t, { limits: { maxLiveInvites: 2 } });
  const owner = await firstAccount(hub);
  const socket = await online(hub, owner);
  const one = await makeInvite(socket);
  await makeInvite(socket);
  socket.send({ type: "invite.create" });
  assert.equal((await socket.next("error")).code, "too-many-invites");
  await api(hub, "/api/register", (await makeBody("u@example.com", { inviteCode: one.code })).body);
  assert.ok((await makeInvite(socket)).code);
});

test("settled invites are dropped from the file in time", async (t) => {
  const clock = { t: 1_800_000_000_000 };
  const hub = await hubFor(t, { clock });
  const owner = await firstAccount(hub);
  const socket = await online(hub, owner);
  await makeInvite(socket);
  clock.t += 14 * DAY + 31 * DAY;
  await socket.next("invite.created", 1).catch(() => {});
  await later(60);
  socket.send({ type: "invite.list" });
  assert.deepEqual((await socket.next("invite.list")).invites, []);
});

// ------------------------------------------------------------------------------------- limits

test("sign-ups are limited per address, right code or wrong", async (t) => {
  const hub = await hubFor(t, { limits: { maxSignupsPerAddress: 3, signupWindowMs: 3600_000 } });
  const owner = await firstAccount(hub);
  const socket = await online(hub, owner);
  const statuses = [];
  for (let i = 0; i < 3; i++) statuses.push((await api(hub, "/api/register", (await makeBody(`w${i}@example.com`, { inviteCode: "AAAA-BBBB-CCCC-DDDD" })).body)).status);
  assert.deepEqual(statuses, [403, 403, 403]);
  const { code } = await makeInvite(socket);
  const blocked = await api(hub, "/api/register", (await makeBody("good@example.com", { inviteCode: code })).body);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.json.error, "too-many-signups");
  hub.clock.t += 3600_001;
  assert.equal((await api(hub, "/api/register", (await makeBody("good@example.com", { inviteCode: code })).body)).status, 201, "the code was not spent by the refusal");
});

test("an account cannot hold more than its share of devices, and recovery still gets through", async (t) => {
  const hub = await hubFor(t, { limits: { maxDevicesPerAccount: 2 } });
  const device = named(await newDeviceKeys(), "One");
  const recovery = await recoveryKeysFrom(newRecoveryCode());
  const log = await createLog({ device, recovery });
  const account = { email: "o@example.com", device, log, loginKey: randomKey() };
  await api(hub, "/api/register", { email: account.email, salt: b64(randomBytes(16)), verifierInput: account.loginKey, anchor: randomKey(), firstLogEntry: log[0], bootstrapToken: BOOTSTRAP });
  const socket = await online(hub, account);
  await addDevice(hub, account, socket, named(await newDeviceKeys(), "Two"));

  const three = named(await newDeviceKeys(), "Three");
  const next = await append(account.log, { type: "add", name: three.name, kind: three.kind, role: "full", signPub: three.signPub, boxPub: three.boxPub, addedAt: hub.clock.t }, device);
  socket.send({ type: "log.append", prevHead: (await verifyLog(account.log, { now: hub.clock.t })).head, entry: next.at(-1) });
  const refused = await socket.next("error");
  assert.equal(refused.code, "too-many-devices");
  assert.equal(refused.for, "log.append");

  // Past the limit, recovery is still the way back in: it must never be the limit that locks someone out for good.
  const rescue = named(await newDeviceKeys(), "Rescue");
  const replacement = await recoveryKeysFrom(newRecoveryCode());
  const recovered = await append(account.log, { type: "recover", name: rescue.name, kind: rescue.kind, signPub: rescue.signPub, boxPub: rescue.boxPub, newRecovery: replacement, addedAt: hub.clock.t }, recovery);
  const rescuer = await online(hub, account, rescue);
  assert.equal(rescuer.auth.state, "pending");
  rescuer.send({ type: "log.append", prevHead: (await verifyLog(account.log, { now: hub.clock.t })).head, entry: recovered.at(-1) });
  await rescuer.next("log.ok");
});

test("one account's log cannot grow without end", async (t) => {
  const hub = await hubFor(t, { limits: { maxLogEntries: 3 } });
  const owner = await firstAccount(hub);
  const socket = await online(hub, owner);
  const one = named(await newDeviceKeys(), "One");
  await addDevice(hub, owner, socket, one);
  const next = await append(owner.log, { type: "remove", signPub: one.signPub }, owner.device);
  socket.send({ type: "log.append", prevHead: (await verifyLog(owner.log, { now: hub.clock.t })).head, entry: next.at(-1) });
  await socket.next("log.ok");
  owner.log = next;
  const two = named(await newDeviceKeys(), "Two");
  const full = await append(owner.log, { type: "add", name: two.name, kind: two.kind, role: "full", signPub: two.signPub, boxPub: two.boxPub, addedAt: hub.clock.t }, owner.device);
  socket.send({ type: "log.append", prevHead: (await verifyLog(owner.log, { now: hub.clock.t })).head, entry: full.at(-1) });
  assert.equal((await socket.next("error")).code, "log-full");
});

test("one account at its limit of connections does not stop another", async (t) => {
  const { hub, alice, bob, a } = await twoPeople(t, { limits: { maxSocketsPerAccount: 3 } });
  const more = [];
  for (const name of ["L1", "L2"]) {
    const device = named(await newDeviceKeys(), name);
    await addDevice(hub, alice, a, device);
    more.push(await online(hub, alice, device));
  }
  const extra = named(await newDeviceKeys(), "L3");
  await addDevice(hub, alice, a, extra);
  const r = await api(hub, "/api/login", { email: alice.email, loginKey: alice.loginKey, signPub: extra.signPub });
  const socket = new Socket(hub);
  await socket.opened;
  socket.send({ type: "auth", session: r.json.session });
  const { nonce } = await socket.next("auth.challenge");
  socket.send({ type: "auth.proof", sig: await sign(extra.sign.privateKey, new TextEncoder().encode(`omni-hub-auth-v1 ${ORIGIN} ${nonce}`)) });
  for (let i = 0; i < 100 && socket.closeCode === null; i++) await later(20);
  assert.equal(socket.closeCode, 4429);
  // Bob is on the hub with one socket of his own, and takes a second.
  const device = named(await newDeviceKeys(), "Bob two");
  await addDevice(hub, bob, hub.sockets.find((s) => s.device?.signPub === bob.device.signPub), device);
  assert.equal((await online(hub, bob, device)).auth.state, "approved");
});

// ------------------------------------------------------------------------------------- nothing crosses

test("isolation: a frame to another account's online device is refused exactly as an unknown device is, and arrives nowhere", async (t) => {
  const { hub, alice, a, b } = await twoPeople(t);
  const laptop = named(await newDeviceKeys(), "Alice laptop");
  await addDevice(hub, alice, a, laptop);
  const own = await online(hub, alice, laptop);
  for (const type of ["channel.msg", "approval.msg"]) {
    a.send({ type, to: b.device.signPub, opaque: "secret" });
    const foreign = await a.next("error");
    a.send({ type, to: randomKey(), opaque: "secret" });
    const unknown = await a.next("error");
    assert.deepEqual({ ...foreign, to: "" }, { ...unknown, to: "" }, "another account cannot be told from no device");
    assert.equal(foreign.code, "unreachable");
  }
  await b.settled();
  assert.ok(!b.has("channel.msg") && !b.has("approval.msg"));
  // And the same message on one's own account does arrive, so the refusal above is about the account.
  a.send({ type: "channel.msg", to: laptop.signPub, opaque: "for me" });
  assert.equal((await own.next("channel.msg")).opaque, "for me");
});

test("isolation: one key on two accounts is two devices, and each hears only its own account", async (t) => {
  const { hub, alice, bob, a, b } = await twoPeople(t);
  const shared = named(await newDeviceKeys(), "Same key");
  await addDevice(hub, alice, a, shared);
  await addDevice(hub, bob, b, shared);
  const onA = await online(hub, alice, shared);
  const onB = await online(hub, bob, shared);
  assert.equal(onA.closeCode, null);
  a.send({ type: "channel.msg", to: shared.signPub, opaque: "from alice" });
  assert.equal((await onA.next("channel.msg")).opaque, "from alice");
  await onB.settled();
  assert.ok(!onB.has("channel.msg"));
  b.send({ type: "channel.msg", to: shared.signPub, opaque: "from bob" });
  assert.equal((await onB.next("channel.msg")).opaque, "from bob");
  await onA.settled();
  assert.ok(!onA.has("channel.msg"), "the socket on the other account stayed its own");
});

test("isolation: device lists, heads and news about them stay on their account", async (t) => {
  const { hub, alice, bob, a, b } = await twoPeople(t);
  a.send({ type: "log.get" });
  const logA = await a.next("log");
  b.send({ type: "log.get" });
  const logB = await b.next("log");
  assert.notEqual(logA.head, logB.head);
  const text = JSON.stringify(logA);
  assert.ok(!text.includes(bob.device.signPub) && !text.includes(bob.email), "Alice's list names nothing of Bob's");
  assert.ok(!JSON.stringify(logB).includes(alice.device.signPub));

  b.inbox.length = 0;
  await addDevice(hub, alice, a, named(await newDeviceKeys(), "New for Alice"));
  await b.settled();
  assert.ok(!b.has("log.updated"), "Bob hears nothing of Alice's change");
  assert.ok(!b.has("log.ok"));
});

test("isolation: one account cannot write to another's log", async (t) => {
  const { hub, alice, bob, a, b } = await twoPeople(t);
  const headA = (await verifyLog(alice.log, { now: hub.clock.t })).head;
  const headB = (await verifyLog(bob.log, { now: hub.clock.t })).head;
  // Alice's device signs an add that follows Bob's head, and Alice's socket sends it.
  const intruder = named(await newDeviceKeys(), "Intruder");
  const onBobs = await append(bob.log, { type: "add", name: intruder.name, kind: intruder.kind, role: "full", signPub: intruder.signPub, boxPub: intruder.boxPub, addedAt: hub.clock.t }, bob.device);
  a.send({ type: "log.append", prevHead: headB, entry: onBobs.at(-1) });
  assert.equal((await a.next("log.conflict")).head, headA, "its head is not this account's head");
  a.send({ type: "log.append", prevHead: headA, entry: onBobs.at(-1) });
  assert.equal((await a.next("error")).code, "invalid-entry");
  b.send({ type: "log.get" });
  assert.equal((await b.next("log")).head, headB, "Bob's log did not move");
});

test("isolation: presence shows only one's own account, and no news of the other", async (t) => {
  const { hub, alice, bob, a, b } = await twoPeople(t);
  a.inbox.length = 0;
  a.send({ type: "presence" });
  assert.deepEqual((await a.next("presence")).online, [alice.device.signPub]);
  b.send({ type: "presence" });
  assert.deepEqual((await b.next("presence")).online, [bob.device.signPub]);

  a.inbox.length = 0;
  const laptop = named(await newDeviceKeys(), "Bob laptop");
  await addDevice(hub, bob, b, laptop);
  const on = await online(hub, bob, laptop);
  on.close();
  await b.next("presence");
  await a.settled();
  assert.ok(!a.inbox.some((m) => JSON.stringify(m).includes(laptop.signPub)), "nothing about Bob's device reached Alice");
});

test("isolation: a pending sign-in shows only on its own account, and only it can be denied there", async (t) => {
  const { hub, alice, bob, a, b } = await twoPeople(t);
  a.inbox.length = 0;
  b.inbox.length = 0;
  const newcomer = named(await newDeviceKeys(), "Bob new phone");
  const waiting = await online(hub, bob, newcomer, { name: "Bob new phone", kind: "desktop" });
  const row = (await b.next("pending.list")).pending.find((p) => p.signPub === newcomer.signPub);
  assert.ok(row);
  await a.settled();
  assert.ok(!a.has("pending.list"), "Alice's cards never see it");
  a.send({ type: "pending.list" });
  assert.deepEqual((await a.next("pending.list")).pending, []);

  a.send({ type: "pending.deny", id: row.id });
  assert.equal((await a.next("error")).code, "not-found", "Alice cannot deny Bob's sign-in, or learn it exists");
  assert.equal(waiting.closeCode, null);

  // Nor can it reach an approver of another account, with its offered key or any other way.
  waiting.send({ type: "approval.msg", to: alice.device.signPub, opaque: "let me in" });
  assert.equal((await waiting.next("error")).code, "unreachable");
  await a.settled();
  assert.ok(!a.has("approval.msg"));
});

test("isolation: another account's password does not open this one, and a shared email is refused", async (t) => {
  const { hub, alice, bob } = await twoPeople(t);
  const r = await api(hub, "/api/login", { email: alice.email, loginKey: bob.loginKey, signPub: bob.device.signPub });
  assert.equal(r.status, 401);
  const session = (await api(hub, "/api/login", { email: bob.email, loginKey: bob.loginKey, signPub: alice.device.signPub })).json;
  assert.equal(session.state, "pending", "Alice's key on Bob's account is a stranger there");
  const same = await makeInviteFor(hub, alice);
  const dup = await api(hub, "/api/register", (await makeBody(alice.email.toUpperCase(), { inviteCode: same })).body);
  assert.equal(dup.status, 409);
});

async function makeInviteFor(hub, account) {
  const existing = hub.sockets.find((s) => s.device?.signPub === account.device.signPub && s.closeCode === null);
  const { code } = await makeInvite(existing);
  return code;
}

test("isolation: a refused registration holding an invite says nothing of who else is on the hub", async (t) => {
  const { hub, alice } = await twoPeople(t);
  const noCode = await api(hub, "/api/register", (await makeBody(alice.email)).body);
  const other = await api(hub, "/api/register", (await makeBody("nobody-here@example.com")).body);
  assert.deepEqual(noCode, other, "without an invite, an email that exists and one that does not get the same answer");
});

test("isolation: a session on one account gets nothing of another by asking for it by name", async (t) => {
  const { a, b, bob } = await twoPeople(t);
  for (const message of [{ type: "log.get", accountId: bob.log[0].body.accountId }, { type: "presence", accountId: bob.log[0].body.accountId }, { type: "pending.list", accountId: bob.log[0].body.accountId }]) {
    a.send(message);
    const answer = await a.next(message.type === "log.get" ? "log" : message.type);
    assert.ok(!JSON.stringify(answer).includes(b.device.signPub), message.type);
  }
});
