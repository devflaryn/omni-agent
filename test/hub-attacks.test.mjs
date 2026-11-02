// A hacked hub between real clients. The crypto is the real core and the real log; only the hub is scripted, or, where
// a test says so, the real hub. Design: docs/superpowers/specs/2026-11-02-omni-accounts-remote-design.md, sections 3 to 6.
//
// The desktop client does not exist yet, so ThinClient below holds the checks a client has to make. Where a check lives
// in ThinClient and not in the core, the test also asserts what the core returned, because that is what the real client
// will have to work from.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  approvalCode, approverCommit, approverExchange, fromB64, loginKeyFrom, newApprovalRandom, newDeviceExchange, newDeviceKeys,
  newRecoveryCode, recoveryKeysFrom, sign, startHandshake, toB64,
} from "../ui/account-core.js";
import { LogError, append, canRecover, compareLogs, createLog, entryBytes, entryHash, recoverySignature, verifyLog } from "../ui/device-log.js";
import { startHub } from "../hub/server.mjs";

const ORIGIN = "https://hub.test";
const BOOTSTRAP = "attack-suite-bootstrap-token";
const WAIT_MS = 4000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const b64 = (bytes) => Buffer.from(bytes).toString("base64");
const randomKey = () => b64(randomBytes(32));
const utf8 = (text) => encoder.encode(text);
const now = () => Date.now();

// --- the shared thin client ---

const named = async (name, kind = "desktop") => ({ ...await newDeviceKeys(), name, kind });
const addBody = (device, role = "full", addedAt = now()) => ({ name: device.name, kind: device.kind, role, signPub: device.signPub, boxPub: device.boxPub, addedAt });

const recoverFields = (device, newRecovery) => ({ type: "recover", name: device.name, kind: device.kind, signPub: device.signPub, boxPub: device.boxPub, newRecovery });

/** What the holder of a key can always make, whatever the log says. append() would refuse most of these. */
async function signedEntry(log, type, body, signer) {
  const unsigned = { type, index: log.length, prev: log.length ? await entryHash(log.at(-1)) : "", signer: signer.signPub, body };
  return { ...unsigned, sig: await sign(signer.sign.privateKey, entryBytes(unsigned)) };
}

class ThinClient {
  log = null;
  alerts = [];

  constructor(keys) { this.keys = keys; }

  static async with(name, log, kind) {
    const client = new ThinClient(await named(name, kind));
    client.log = log;
    return client;
  }

  /** The state this client trusts. Its own memory, never what the hub says now. */
  trust() { return verifyLog(this.log, { now: now() }); }

  #refuse(alert) {
    this.alerts.push(alert);
    return alert;
  }

  /** Section 3: a longer valid log is adopted. Anything else that differs is refused, and shown. */
  async see(entries) {
    let relation;
    try {
      await verifyLog(entries, { now: now() });
      relation = await compareLogs(this.log, entries);
    } catch (error) {
      if (error instanceof LogError) return this.#refuse("bad-log");
      throw error;
    }
    if (relation === "same") return "same";
    if (relation === "b-newer") {
      this.log = entries;
      return "adopted";
    }
    return this.#refuse({ "a-newer": "rollback", fork: "fork", "different-account": "different-account" }[relation]);
  }

  /** Section 4, step 5. The code was shown to the person, who said whether another device of theirs shows the same one. */
  async acceptApproval(entries, { logHead, approverPub, role = "full" }, personConfirmedCode) {
    if (!personConfirmedCode) return this.#refuse("code-not-confirmed");
    let trust;
    try {
      trust = await verifyLog(entries, { now: now() });
    } catch (error) {
      if (error instanceof LogError) return this.#refuse("bad-log");
      throw error;
    }
    let at = -1;
    for (let i = 0; i < entries.length && at < 0; i++) if (await entryHash(entries[i]) === logHead) at = i;
    if (at < 0) return this.#refuse("not-the-head-in-the-code");
    const before = await verifyLog(entries.slice(0, at + 1), { now: now() });
    if (before.devices.get(approverPub)?.role !== "full") return this.#refuse("approver-not-on-log");
    const mine = trust.devices.get(this.keys.signPub);
    if (!mine) return this.#refuse("not-added");
    if (mine.boxPub !== this.keys.boxPub) return this.#refuse("wrong-box-key");
    if (mine.role !== role) return this.#refuse("wrong-role");
    this.log = entries;
    return "adopted";
  }

  /** Section 5: everything a recovering device knows is its recovery code. */
  async recoverOnto(entries, recoveryKeys) {
    if (!await canRecover(entries, recoveryKeys.signPub)) return this.#refuse("not-my-recovery-key");
    this.log = await append(entries, recoverFields(this.keys, await recoveryKeysFrom(newRecoveryCode())), recoveryKeys);
    return "adopted";
  }

  /** Section 6: the peer must be on this client's own log. */
  async refuseUnknownPeer(peerPub) {
    return !(await this.trust()).devices.has(peerPub);
  }
}

/** Every value between the two clients passes through here, is recorded, and can be changed by `script[label]`. */
function scriptedHub(script = {}) {
  const wire = [];
  return {
    wire,
    carry(label, value) {
      const out = script[label] ? script[label](value) : value;
      wire.push(JSON.stringify(out));
      return out;
    },
  };
}

async function familyOf(...names) {
  const owner = await named("Main PC");
  const recoveryCode = newRecoveryCode();
  const recovery = await recoveryKeysFrom(recoveryCode);
  let log = await createLog({ device: owner, recovery });
  const others = [];
  for (const name of names) {
    const device = await named(name);
    log = await append(log, { type: "add", ...addBody(device) }, owner);
    others.push(device);
  }
  const client = (keys) => {
    const c = new ThinClient(keys);
    c.log = log;
    return c;
  };
  return { owner, recovery, recoveryCode, log, others, client };
}

/** Runs both flights of a handshake over the hub. confirm is settled, not thrown, so a test can look at each side after. */
async function handshake(a, b, hub = scriptedHub()) {
  const [hsA, hsB] = await Promise.all([
    startHandshake({ device: a.keys, peerPub: b.keys.signPub, logHead: (await a.trust()).head }),
    startHandshake({ device: b.keys, peerPub: a.keys.signPub, logHead: (await b.trust()).head }),
  ]);
  const chA = await hsA.finish(hub.carry("hello-to-a", hsB.hello));
  const chB = await hsB.finish(hub.carry("hello-to-b", hsA.hello));
  const results = await Promise.allSettled([
    chA.confirm(hub.carry("proof-to-a", chB.proof)),
    chB.confirm(hub.carry("proof-to-b", chA.proof)),
  ]);
  return { chA, chB, results, hub, hello: { a: hsA.hello, b: hsB.hello }, proof: { a: chA.proof, b: chB.proof } };
}

async function connected(a, b, hub) {
  const session = await handshake(a, b, hub);
  assert.deepEqual(session.results.map((r) => r.status), ["fulfilled", "fulfilled"]);
  return session;
}

const sendLog = async (fromChannel, toChannel, entries) => JSON.parse(decoder.decode(await toChannel.open(await fromChannel.seal(utf8(JSON.stringify(entries))))));

/** The honest order of an approval, with what the hub may change at each hop. */
async function approval({ approverSees, newSees, hub = scriptedHub() }) {
  const approver = await approverExchange(approverSees);
  const fresh = await newDeviceExchange(newSees);
  fresh.receiveCommit(hub.carry("commit", approver.commit));
  approver.receiveRandom(hub.carry("random", fresh.releaseRandom()));
  await fresh.receiveReveal(hub.carry("reveal", approver.revealRandom()));
  return { approverCode: await approver.code(), newCode: await fresh.code() };
}

/**
 * Finds a value for one random that gives the wanted code: what a hub would do offline once it has seen everything else.
 * Done with node:crypto because a million WebCrypto calls take too long for a test; the caller checks the result against
 * the real approvalCode, so a change of format fails here rather than passing unnoticed.
 */
function grind({ grindField, approverRandom, newRandom, approverPub, newPub, logHead, wanted }) {
  const fields = [
    utf8("omni-approval-code-v1"),
    grindField === "approverRandom" ? new Uint8Array(32) : fromB64(approverRandom),
    grindField === "newRandom" ? new Uint8Array(32) : fromB64(newRandom),
    fromB64(approverPub),
    fromB64(newPub),
    utf8(logHead),
  ];
  const buffer = Buffer.concat(fields.flatMap((f) => {
    const size = Buffer.alloc(4);
    size.writeUInt32BE(f.length);
    return [size, f];
  }));
  const at = 4 + fields[0].length + 4 + (grindField === "newRandom" ? 32 + 4 : 0);
  randomBytes(32).copy(buffer, at);
  const target = Number(wanted);
  for (let tries = 0; tries < 100_000_000; tries++) {
    buffer.writeUInt32BE(tries, at);
    const digest = createHash("sha256").update(buffer).digest();
    // The top 64 bits mod a million, without a BigInt per try. 2^32 mod 10^6 is 967296.
    if (((digest.readUInt32BE(0) % 1_000_000) * 967_296 + digest.readUInt32BE(4) % 1_000_000) % 1_000_000 === target) {
      return toB64(buffer.subarray(at, at + 32));
    }
  }
  throw new Error("grind: nothing found");
}

// --- approving a sign-in: the hub in the middle ---

async function approvalSetting() {
  const family = await familyOf();
  const fresh = await named("New laptop");
  const mallory = await named("Mallory");
  const malloryApprover = await named("Mallory approver");
  const logHead = (await verifyLog(family.log, { now: now() })).head;
  return { ...family, fresh, mallory, malloryApprover, logHead };
}

test("baseline: an honest hub gives both sides one code", async () => {
  const { owner, fresh, logHead } = await approvalSetting();
  const context = { approverPub: owner.signPub, newPub: fresh.signPub, logHead };
  const { approverCode, newCode } = await approval({ approverSees: context, newSees: context });
  assert.equal(approverCode, newCode);
  assert.match(newCode, /^\d{6}$/);
});

test("key swap: a hub showing the approver its own key gets different codes on the two screens", async () => {
  const { owner, fresh, mallory, logHead } = await approvalSetting();
  const { approverCode, newCode } = await approval({
    approverSees: { approverPub: owner.signPub, newPub: mallory.signPub, logHead },
    newSees: { approverPub: owner.signPub, newPub: fresh.signPub, logHead },
  });
  assert.notEqual(approverCode, newCode);
});

test("key swap: a hub showing the new device a fake approver gets different codes too", async () => {
  const { owner, fresh, malloryApprover, logHead } = await approvalSetting();
  const { approverCode, newCode } = await approval({
    approverSees: { approverPub: owner.signPub, newPub: fresh.signPub, logHead },
    newSees: { approverPub: malloryApprover.signPub, newPub: fresh.signPub, logHead },
  });
  assert.notEqual(approverCode, newCode);
});

test("a hub telling the two sides different log heads gets different codes", async () => {
  const { owner, fresh, logHead } = await approvalSetting();
  const stale = randomKey();
  const { approverCode, newCode } = await approval({
    approverSees: { approverPub: owner.signPub, newPub: fresh.signPub, logHead },
    newSees: { approverPub: owner.signPub, newPub: fresh.signPub, logHead: stale },
  });
  assert.notEqual(approverCode, newCode);
});

test("key swap in full: two exchanges in the honest order, with the hub as each side's peer, do not match", async () => {
  const { owner, fresh, mallory, malloryApprover, logHead } = await approvalSetting();
  // Twenty tries: a real hub gets one per person pressing Review. Each match by luck is one in a million.
  for (let i = 0; i < 20; i++) {
    const towardApprover = await newDeviceExchange({ approverPub: owner.signPub, newPub: mallory.signPub, logHead });
    const approver = await approverExchange({ approverPub: owner.signPub, newPub: mallory.signPub, logHead });
    towardApprover.receiveCommit(approver.commit);
    approver.receiveRandom(towardApprover.releaseRandom());
    await towardApprover.receiveReveal(approver.revealRandom());
    const approverCode = await approver.code();

    const towardNew = await approverExchange({ approverPub: malloryApprover.signPub, newPub: fresh.signPub, logHead });
    const newcomer = await newDeviceExchange({ approverPub: malloryApprover.signPub, newPub: fresh.signPub, logHead });
    newcomer.receiveCommit(towardNew.commit);
    towardNew.receiveRandom(newcomer.releaseRandom());
    await newcomer.receiveReveal(towardNew.revealRandom());
    assert.notEqual(approverCode, await newcomer.code());
  }
});

test("trying values after the reveal, on the new device: a value that gives the code is found, and refused", async () => {
  const { owner, fresh, mallory, malloryApprover, logHead } = await approvalSetting();
  // The approver is finished, and its screen shows a code.
  const approver = await approverExchange({ approverPub: owner.signPub, newPub: mallory.signPub, logHead });
  approver.receiveRandom(await newApprovalRandom());
  approver.revealRandom();
  const wanted = await approver.code();

  // The new device takes a commit from the hub and gives its random value. Only now can the hub see what it needs.
  const context = { approverPub: malloryApprover.signPub, newPub: fresh.signPub, logHead };
  const newcomer = await newDeviceExchange(context);
  const honestCommit = await approverCommit();
  newcomer.receiveCommit(honestCommit.commit);
  const newRandom = newcomer.releaseRandom();

  const found = grind({ grindField: "approverRandom", newRandom, ...context, wanted });
  assert.equal(await approvalCode({ approverRandom: found, newRandom, ...context }), wanted, "the hub really has a value that gives this code");

  await assert.rejects(newcomer.receiveReveal(found), /does not match the commit/);
  await assert.rejects(newcomer.receiveReveal(honestCommit.random), /out of order/, "no second try, even with the value it committed to");
  await assert.rejects(newcomer.code(), /out of order/, "and no code from a failed exchange");
});

test("trying values after the reveal, on the approver: a value that gives the code is found, and refused", async () => {
  const { owner, fresh, mallory, malloryApprover, logHead } = await approvalSetting();
  // The new device is finished, and its screen shows a code.
  const toNew = { approverPub: malloryApprover.signPub, newPub: fresh.signPub, logHead };
  const newcomer = await newDeviceExchange(toNew);
  const fake = await approverCommit();
  newcomer.receiveCommit(fake.commit);
  newcomer.releaseRandom();
  await newcomer.receiveReveal(fake.random);
  const wanted = await newcomer.code();

  const toApprover = { approverPub: owner.signPub, newPub: mallory.signPub, logHead };
  const approver = await approverExchange(toApprover);
  approver.receiveRandom(await newApprovalRandom());
  const approverRandom = approver.revealRandom();

  const found = grind({ grindField: "newRandom", approverRandom, ...toApprover, wanted });
  assert.equal(await approvalCode({ approverRandom, newRandom: found, ...toApprover }), wanted, "the hub really has a value that gives this code");

  assert.throws(() => approver.receiveRandom(found), /out of order/);
  await assert.rejects(approver.code(), /out of order/, "the exchange is over, and shows no code");
});

test("the hub cannot get the reveal early, or the new device's random before it has committed", async () => {
  const { owner, fresh, logHead } = await approvalSetting();
  const context = { approverPub: owner.signPub, newPub: fresh.signPub, logHead };

  const approver = await approverExchange(context);
  assert.throws(() => approver.revealRandom(), /out of order/);
  assert.throws(() => approver.receiveRandom(randomKey()), /out of order/, "a refused step ends the exchange");

  const newcomer = await newDeviceExchange(context);
  assert.throws(() => newcomer.releaseRandom(), /out of order/);
  assert.throws(() => newcomer.receiveCommit(randomKey()), /out of order/);
});

test("the hub cannot change its commit once it has seen the new device's random", async () => {
  const { owner, fresh, logHead } = await approvalSetting();
  const newcomer = await newDeviceExchange({ approverPub: owner.signPub, newPub: fresh.signPub, logHead });
  newcomer.receiveCommit((await approverCommit()).commit);
  newcomer.releaseRandom();
  const other = await approverCommit();
  assert.throws(() => newcomer.receiveCommit(other.commit), /out of order/);
  await assert.rejects(newcomer.receiveReveal(other.random), /out of order/);
});

test("a swapped commit or reveal is caught by the new device, and it shows no code", async () => {
  const { owner, fresh, logHead } = await approvalSetting();
  const context = { approverPub: owner.signPub, newPub: fresh.signPub, logHead };
  const other = await approverCommit();
  for (const script of [{ commit: () => other.commit }, { reveal: () => other.random }]) {
    await assert.rejects(approval({ approverSees: context, newSees: context, hub: scriptedHub(script) }), /does not match the commit/);
  }
});

test("malformed values end the exchange", async () => {
  const { owner, fresh, logHead } = await approvalSetting();
  const context = { approverPub: owner.signPub, newPub: fresh.signPub, logHead };
  const approver = await approverExchange(context);
  assert.throws(() => approver.receiveRandom("short"), /malformed/);
  assert.throws(() => approver.revealRandom(), /out of order/);
  const newcomer = await newDeviceExchange(context);
  assert.throws(() => newcomer.receiveCommit("short"), /malformed/);
  assert.throws(() => newcomer.releaseRandom(), /out of order/);
});

test("every exchange draws its own random, so restarting one tries a new code each time", async () => {
  // REQUIREMENT on the clients: this is why a client must not restart an exchange on the hub's say-so. See the Task 5 report.
  const { owner, fresh, logHead } = await approvalSetting();
  const context = { approverPub: owner.signPub, newPub: fresh.signPub, logHead };
  const seen = new Set();
  for (let i = 0; i < 5; i++) {
    const newcomer = await newDeviceExchange(context);
    newcomer.receiveCommit((await approverCommit()).commit);
    seen.add(newcomer.releaseRandom());
  }
  assert.equal(seen.size, 5);
});

// --- a fake log handed to a new device ---

test("fake log: a forged add for the new device, with no authority behind it, does not verify", async () => {
  const { log, fresh, mallory, owner, logHead } = await approvalSetting();
  const forged = [...log, await signedEntry(log, "add", addBody(fresh), mallory)];
  await assert.rejects(verifyLog(forged, { now: now() }), /not on the log/);
  const client = new ThinClient(fresh);
  assert.equal(await client.acceptApproval(forged, { logHead, approverPub: owner.signPub }, true), "bad-log");
  assert.equal(client.log, null);
});

test("fake log: an altered entry, its signature, its chain or its position does not verify", async () => {
  const { log, others } = await familyOf("Laptop");
  const entry = log.at(-1);
  const flipped = { ...entry, sig: b64(Buffer.from(fromB64(entry.sig)).map((byte, i) => (i === 0 ? byte ^ 1 : byte))) };
  const attempts = [
    { ...entry, body: { ...entry.body, name: "Renamed" } },
    { ...entry, body: { ...entry.body, signPub: others[0].boxPub } },
    { ...entry, body: { ...entry.body, role: "client" } },
    { ...entry, prev: randomKey() },
    { ...entry, index: entry.index + 1 },
    flipped,
    { ...entry, extra: "unsigned field" },
  ];
  for (const attempt of attempts) {
    await assert.rejects(verifyLog([...log.slice(0, -1), attempt], { now: now() }), LogError, JSON.stringify(attempt).slice(0, 120));
  }
});

test("fake log: an entry properly signed by a device on the log still has to chain, and to be in its place", async () => {
  // What a removed or colluding device could sign: the signature is good, so only these two checks stand in the way.
  const { log, owner } = await familyOf("Laptop");
  const later = await named("Later");
  const body = addBody(later);
  const signed = async (fields) => {
    const unsigned = { type: "add", index: log.length, prev: await entryHash(log.at(-1)), signer: owner.signPub, body, ...fields };
    return { ...unsigned, sig: await sign(owner.sign.privateKey, entryBytes(unsigned)) };
  };
  await verifyLog([...log, await signed({})], { now: now() });
  await assert.rejects(verifyLog([...log, await signed({ prev: randomKey() })], { now: now() }), /does not chain/);
  await assert.rejects(verifyLog([...log, await signed({ prev: await entryHash(log[0]) })], { now: now() }), /does not chain/);
  await assert.rejects(verifyLog([...log, await signed({ index: log.length + 1 })], { now: now() }), /says it is at position/);
});

test("fake log: a signature re-encoded to look different is refused, so it cannot pass for a fork", async () => {
  const { log } = await familyOf("Laptop");
  const entry = log.at(-1);
  // Ed25519's other spelling of one signature: S + L, the group order, little-endian in the last 32 bytes.
  const L = [0xed, 0xd3, 0xf5, 0x5c, 0x1a, 0x63, 0x12, 0x58, 0xd6, 0x9c, 0xf7, 0xa2, 0xde, 0xf9, 0xde, 0x14, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x10];
  const bytes = Uint8Array.from(fromB64(entry.sig));
  let carry = 0;
  for (let i = 0; i < 32; i++) {
    const sum = bytes[32 + i] + L[i] + carry;
    bytes[32 + i] = sum & 255;
    carry = sum >> 8;
  }
  await assert.rejects(verifyLog([...log.slice(0, -1), { ...entry, sig: toB64(bytes) }], { now: now() }), /bad signature/);
});

test("fake log: a log the new device is not on, or one not following the head in the code, is refused", async () => {
  const { log, owner, fresh, logHead } = await approvalSetting();
  const client = new ThinClient(fresh);
  const context = { logHead, approverPub: owner.signPub };

  assert.ok(!(await verifyLog(log, { now: now() })).devices.has(fresh.signPub), "the core's list does not have it");
  assert.equal(await client.acceptApproval(log, context, true), "not-added");

  const other = await familyOf();
  const elsewhere = await append(other.log, { type: "add", ...addBody(fresh) }, other.owner);
  assert.equal(await client.acceptApproval(elsewhere, context, true), "not-the-head-in-the-code");

  const added = await append(log, { type: "add", ...addBody(fresh) }, owner);
  assert.equal(await client.acceptApproval(added, context, true), "adopted");
  assert.deepEqual(client.alerts, ["not-added", "not-the-head-in-the-code"]);
});

test("fake log: the approver in the code must have been a full device on the log at that head", async () => {
  const { log, owner, fresh, malloryApprover, logHead } = await approvalSetting();
  const added = await append(log, { type: "add", ...addBody(fresh) }, owner);
  const client = new ThinClient(fresh);
  assert.equal(await client.acceptApproval(added, { logHead, approverPub: malloryApprover.signPub }, true), "approver-not-on-log");
});

test("the code does not cover the box key or the role, so the new device checks its own entry", async () => {
  // REQUIREMENT on the clients: the hub carries boxPub, kind and name to the approver, and the code binds only the signing keys.
  const { log, owner, fresh, mallory, logHead } = await approvalSetting();
  const context = { logHead, approverPub: owner.signPub };

  const swappedBox = await append(log, { type: "add", ...addBody({ ...fresh, boxPub: mallory.boxPub }) }, owner);
  const trusted = await verifyLog(swappedBox, { now: now() });
  assert.equal(trusted.devices.get(fresh.signPub).boxPub, mallory.boxPub, "the core returns the entry as signed, for the device to compare");
  assert.equal(await new ThinClient(fresh).acceptApproval(swappedBox, context, true), "wrong-box-key");

  // A web page told "desktop" to the approver by the hub would hold a full device's authority. An honest page refuses it.
  const promoted = await append(log, { type: "add", ...addBody(fresh, "full") }, owner);
  assert.equal(await new ThinClient(fresh).acceptApproval(promoted, { ...context, role: "client" }, true), "wrong-role");
});

test("a hub playing a whole fake account: the log verifies, so only the person comparing codes stops it", async () => {
  // REQUIREMENT on the clients: the core cannot refuse this one. A new device must not adopt any log until the person has
  // said the code it shows is also on another device of theirs. Otherwise the fake account's device can reach this machine.
  const { owner, fresh, logHead } = await approvalSetting();
  const mallory = await named("Main PC");
  const fakeLog = await createLog({ device: mallory, recovery: await recoveryKeysFrom(newRecoveryCode()) });
  const fakeHead = (await verifyLog(fakeLog, { now: now() })).head;

  const context = { approverPub: mallory.signPub, newPub: fresh.signPub, logHead: fakeHead };
  const { approverCode, newCode } = await approval({ approverSees: context, newSees: context });
  assert.equal(newCode, approverCode, "the hub is both ends here, so of course these agree");

  const added = await append(fakeLog, { type: "add", ...addBody(fresh) }, mallory);
  await verifyLog(added, { now: now() });

  // The person looks at their real device. It shows nothing, or a code from a separate exchange over the real head.
  const real = await approverExchange({ approverPub: owner.signPub, newPub: fresh.signPub, logHead });
  real.receiveRandom(await newApprovalRandom());
  real.revealRandom();
  assert.notEqual(await real.code(), newCode);

  const client = new ThinClient(fresh);
  assert.equal(await client.acceptApproval(added, { logHead: fakeHead, approverPub: mallory.signPub }, false), "code-not-confirmed");
  assert.equal(client.log, null);
});

// --- recovery ---

test("recovery: the real log with the current code works, and every device gets what it needs for the notice", async () => {
  const { log, recovery } = await familyOf("Laptop");
  const client = new ThinClient(await named("Replacement"));
  assert.equal(await client.recoverOnto(log, recovery), "adopted");
  const trusted = await client.trust();
  assert.equal(trusted.recoveries.length, 1);
  assert.equal(trusted.recoveries[0].signPub, client.keys.signPub);
  assert.equal(trusted.devices.get(client.keys.signPub).role, "full");
});

test("recovery: a forged recover without the code does not verify", async () => {
  const { log, others } = await familyOf("Laptop");
  const mallory = await named("Mallory");
  const body = { ...addBody(mallory), recoveryPub: mallory.boxPub };
  await assert.rejects(verifyLog([...log, await signedEntry(log, "recover", body, mallory)], { now: now() }), /not on the log/);
  await assert.rejects(verifyLog([...log, await signedEntry(log, "recover", body, others[0])], { now: now() }), /a full key/);
});

test("recovery: an old log cannot be replayed at a device holding the new code", async () => {
  const { log, recovery } = await familyOf();
  const newCode = await recoveryKeysFrom(newRecoveryCode());
  const replacement = await named("Replacement");
  const rotated = await append(log, recoverFields(replacement, newCode), recovery);
  const client = new ThinClient(await named("Second"));
  assert.equal(await client.recoverOnto(log, newCode), "not-my-recovery-key");
  assert.equal(await client.recoverOnto(rotated, recovery), "not-my-recovery-key");
});

test("recovery: a hub cannot hand a recovering device a fake account built on its public recovery key", async () => {
  const { recovery, log } = await familyOf("Laptop");
  // The recovery public key is on the real log, so the hub has it. It does not have the private key.
  const mallory = await named("Main PC");
  const create = await signedEntry([], "create", { accountId: randomKey(), ...addBody(mallory), recoveryPub: recovery.signPub }, mallory);
  const fakes = [
    [create],
    [{ ...create, recoverySig: await recoverySignature(create, mallory) }],
    [{ ...create, recoverySig: log[0].recoverySig }],
    [{ ...create, recoverySig: randomBytes(64).toString("base64") }],
  ];
  for (const fake of fakes) {
    await assert.rejects(verifyLog(fake, { now: now() }), /recovery key it introduces/);
    const client = new ThinClient(await named("Replacement"));
    assert.notEqual(await client.recoverOnto(fake, recovery), "adopted", "a device recovering with the real code must refuse a log the real code never endorsed");
    assert.equal(client.log, null);
    assert.deepEqual(client.alerts, ["not-my-recovery-key"]);
  }
});

test("recovery: a hub's own fake account with a recovery key it does hold is valid, and is refused for not being the person's", async () => {
  const { recovery } = await familyOf();
  const mallory = await named("Main PC");
  const fake = await createLog({ device: mallory, recovery: await recoveryKeysFrom(newRecoveryCode()) });
  await verifyLog(fake, { now: now() });
  assert.equal(await canRecover(fake, recovery.signPub), false);
  assert.equal(await new ThinClient(await named("Replacement")).recoverOnto(fake, recovery), "not-my-recovery-key");
});

test("recovery: a recover introducing a key nobody holds is refused, so a hub cannot strand the account", async () => {
  const { log, recovery } = await familyOf();
  const thief = await named("Device");
  const nobody = randomKey();
  const body = { ...addBody(thief), recoveryPub: nobody };
  const entry = await signedEntry(log, "recover", body, recovery);
  await assert.rejects(verifyLog([...log, entry], { now: now() }), /recovery key it introduces/);
  await assert.rejects(verifyLog([...log, { ...entry, recoverySig: await recoverySignature(entry, recovery) }], { now: now() }), /recovery key it introduces/, "the old key cannot vouch for the new one");
  const lying = { ...await recoveryKeysFrom(newRecoveryCode()), signPub: nobody };
  await assert.rejects(append(log, recoverFields(thief, lying), recovery), /recovery key it introduces/);
});

test("recovery: the new key's signature cannot be swapped for the main signature's bytes, or moved or altered", async () => {
  const { log, recovery } = await familyOf();
  const device = await named("Device");
  const newCode = await recoveryKeysFrom(newRecoveryCode());
  const good = (await append(log, recoverFields(device, newCode), recovery)).at(-1);
  await verifyLog([...log, good], { now: now() });
  const altered = Uint8Array.from(fromB64(good.recoverySig));
  altered[0] ^= 1;
  const attempts = [
    { ...good, recoverySig: await sign(newCode.sign.privateKey, entryBytes(good)) },
    { ...good, recoverySig: good.sig },
    { ...good, recoverySig: toB64(altered) },
    { ...good, body: { ...good.body, name: "Renamed" }, sig: await sign(recovery.sign.privateKey, entryBytes({ ...good, body: { ...good.body, name: "Renamed" } })) },
  ];
  for (const attempt of attempts) await assert.rejects(verifyLog([...log, attempt], { now: now() }), /recovery key it introduces/);
});

test("known limit: an older real prefix from one recovery key's era passes the log alone, and a handshake with a device that has seen more catches it", async () => {
  const { log: start, owner, recovery, others } = await familyOf("Stolen laptop");
  const stolen = others[0];
  const prefix = start;
  const real = await append(prefix, { type: "remove", signPub: stolen.signPub }, owner);

  // The recovering device cannot tell. The log verifies, and its code's key is current on it.
  await verifyLog(prefix, { now: now() });
  assert.equal(await canRecover(prefix, recovery.signPub), true);
  assert.equal(await compareLogs(prefix, real), "b-newer", "only someone holding the longer log can see this one is behind");

  const device = new ThinClient(await named("Replacement"));
  assert.equal(await device.recoverOnto(prefix, recovery), "adopted");

  // What does happen: a device removed after that point is back on this device's list, and can reach it.
  assert.equal(await device.refuseUnknownPeer(stolen.signPub), false);
  const thief = new ThinClient(stolen);
  thief.log = device.log;
  const { chA, chB } = await connected(device, thief);
  assert.equal(decoder.decode(await chA.open(await chB.seal(utf8("run this")))), "run this");

  // What does not happen: the hub alone gets nothing from this. It holds no device on the prefix.
  const mallory = await named("Mallory");
  await assert.rejects(verifyLog([...prefix, await signedEntry(prefix, "add", addBody(mallory), mallory)], { now: now() }), /not on the log/);
  assert.ok(await device.refuseUnknownPeer(mallory.signPub));

  // A peer as stale as the prefix does not catch it: it sees a valid longer log, and adopts it.
  const stale = new ThinClient(owner);
  stale.log = prefix;
  assert.equal(await compareLogs(stale.log, device.log), "b-newer");

  // A device that has seen more does. It has to finish the handshake and send its log for that, although this device is
  // not on its list. See the Task 5 report: a peer that refuses before the handshake leaves only a refusal to see.
  const phone = new ThinClient(owner);
  phone.log = real;
  assert.ok(await phone.refuseUnknownPeer(device.keys.signPub), "it would not give this device a working channel");
  const { chA: atDevice, chB: atPhone } = await connected(device, phone);
  assert.notEqual(atDevice.peerLogHead, (await device.trust()).head);
  assert.equal(await device.see(await sendLog(atPhone, atDevice, phone.log)), "fork");
  assert.deepEqual(device.alerts, ["fork"]);
  assert.equal(await phone.see(device.log), "fork");
});

test("known limit: a removed device's backdated fork also passes canRecover, and is caught the same way", async () => {
  const { log, owner, recovery, others } = await familyOf("Stolen laptop");
  const real = await append(log, { type: "remove", signPub: others[0].signPub }, owner);
  const accomplice = await named("Accomplice");
  const fork = [...log, await signedEntry(log, "add", addBody(accomplice), others[0])];
  assert.equal(await canRecover(fork, recovery.signPub), true);
  assert.equal(await compareLogs(real, fork), "fork");
});

test("kind carries no authority: only the role on the log counts", async () => {
  const { log, owner } = await familyOf();
  const claimsDesktop = await named("Claims desktop", "desktop");
  const claimsWeb = await named("Claims web", "web");
  const mallory = await named("Mallory");
  const withBoth = await append(await append(log, { type: "add", ...addBody(claimsDesktop, "client") }, owner), { type: "add", ...addBody(claimsWeb, "full") }, owner);
  await assert.rejects(verifyLog([...withBoth, await signedEntry(withBoth, "add", addBody(mallory), claimsDesktop)], { now: now() }), /a client key/);
  await verifyLog([...withBoth, await signedEntry(withBoth, "add", addBody(mallory), claimsWeb)], { now: now() });
});

// --- replay, rollback ---

test("rollback: a shorter log than the device has seen is refused, and a removal stays in force", async () => {
  const { log, owner, others, client } = await familyOf("Stolen laptop");
  const machine = client(await named("Machine"));
  machine.log = await append(log, { type: "add", ...addBody(machine.keys) }, owner);
  const older = machine.log;
  const newer = await append(older, { type: "remove", signPub: others[0].signPub }, owner);
  assert.equal(await machine.see(newer), "adopted");
  assert.ok(await machine.refuseUnknownPeer(others[0].signPub));

  assert.equal(await compareLogs(machine.log, older), "a-newer", "the core says the shown log is behind");
  assert.equal(await machine.see(older), "rollback");
  assert.equal(machine.log, newer, "the device keeps what it has");
  assert.ok(await machine.refuseUnknownPeer(others[0].signPub), "the removed device stays out");
  assert.deepEqual(machine.alerts, ["rollback"]);
});

test("replay: an old log shown again is not adopted over a newer one, however often it is shown", async () => {
  const { log, owner, client } = await familyOf();
  const device = client(owner);
  const fresh = await named("Later");
  const newer = await append(log, { type: "add", ...addBody(fresh) }, owner);
  await device.see(newer);
  for (let i = 0; i < 3; i++) assert.equal(await device.see(log), "rollback");
  assert.equal(device.log, newer);
});

test("garbage from the hub never reads as newer or as a fork", async () => {
  const { log, owner } = await familyOf();
  const client = new ThinClient(owner);
  client.log = log;
  const damaged = [...log, { ...(await signedEntry(log, "remove", { signPub: owner.signPub }, owner)), sig: randomKey() }];
  for (const bad of [damaged, [], null, "log", [{}]]) {
    await assert.rejects(compareLogs(log, bad), LogError);
    assert.equal(await client.see(bad), "bad-log");
  }
  assert.equal(client.log, log);
});

test("a log of another account is refused, not adopted", async () => {
  const { log, owner } = await familyOf();
  const other = await familyOf("One", "Two");
  assert.equal(await compareLogs(log, other.log), "different-account");
  const client = new ThinClient(owner);
  client.log = log;
  assert.equal(await client.see(other.log), "different-account");
  assert.equal(client.log, log);
});

// --- fork ---

test("fork: two different logs for two devices are each valid, and comparing them says fork", async () => {
  const { log, owner, others } = await familyOf("Laptop");
  const [a, b] = [await named("Added on A"), await named("Added on B")];
  const shownToA = await append(log, { type: "add", ...addBody(a) }, owner);
  const shownToB = await append(log, { type: "add", ...addBody(b) }, others[0]);
  await verifyLog(shownToA, { now: now() });
  await verifyLog(shownToB, { now: now() });
  assert.equal(await compareLogs(shownToA, shownToB), "fork");
  assert.equal(await compareLogs(shownToB, shownToA), "fork");
  const longerFork = await append(shownToB, { type: "remove", signPub: b.signPub }, others[0]);
  assert.equal(await compareLogs(shownToA, longerFork), "fork", "a longer branch is still a fork, not newer");
});

test("fork: two devices shown different logs find out in their handshake, over a channel the hub cannot touch", async () => {
  const { log, owner, others } = await familyOf("Laptop");
  const [first, second] = [new ThinClient(owner), new ThinClient(others[0])];
  first.log = await append(log, { type: "add", ...addBody(await named("Shown to first")) }, owner);
  second.log = await append(log, { type: "add", ...addBody(await named("Shown to second")) }, others[0]);

  const { chA, chB } = await connected(first, second);
  assert.equal(chA.peerLogHead, (await second.trust()).head, "each side learns the other's real head");
  assert.notEqual(chA.peerLogHead, (await first.trust()).head);

  const received = await sendLog(chB, chA, second.log);
  assert.equal(await first.see(received), "fork");
  assert.deepEqual(first.alerts, ["fork"]);
  assert.notEqual(first.log, received);
});

test("backdated fork: a removed device signs from before its removal; replay alone accepts it, and comparing catches it", async () => {
  const { log, owner, others } = await familyOf("Stolen laptop");
  const beforeRemoval = log;
  const honest = await append(log, { type: "remove", signPub: others[0].signPub }, owner);

  const accomplice = await named("Accomplice");
  const fork = [...beforeRemoval, await signedEntry(beforeRemoval, "add", addBody(accomplice), others[0])];
  assert.ok((await verifyLog(fork, { now: now() })).devices.has(accomplice.signPub), "valid on its own: at that point the signer was on the list");

  assert.equal(await compareLogs(honest, fork), "fork");
  const machine = new ThinClient(owner);
  machine.log = honest;
  assert.equal(await machine.see(fork), "fork");
  assert.ok(await machine.refuseUnknownPeer(accomplice.signPub));
});

test("backdated fork: an old recovery key does the same, and is caught the same way", async () => {
  const { log, owner, recovery } = await familyOf();
  const newCode = await recoveryKeysFrom(newRecoveryCode());
  const replacement = await named("Replacement");
  const honest = await append(log, recoverFields(replacement, newCode), recovery);

  const thief = await named("Thief");
  const stolenCode = await recoveryKeysFrom(newRecoveryCode());
  const fork = await append(log, recoverFields(thief, stolenCode), recovery);
  assert.equal(await compareLogs(honest, fork), "fork");
  const machine = new ThinClient(owner);
  machine.log = honest;
  assert.equal(await machine.see(fork), "fork");
});

// --- authority ---

test("a removed device signing a new entry on the current log is refused", async () => {
  const { log, owner, others } = await familyOf("Removed");
  const after = await append(log, { type: "remove", signPub: others[0].signPub }, owner);
  const newcomer = await named("Newcomer");
  await assert.rejects(append(after, { type: "add", ...addBody(newcomer) }, others[0]), /not on the log/);
  await assert.rejects(verifyLog([...after, await signedEntry(after, "add", addBody(newcomer), others[0])], { now: now() }), /not on the log/);
  await assert.rejects(verifyLog([...after, await signedEntry(after, "remove", { signPub: owner.signPub }, others[0])], { now: now() }), /not on the log/);
});

test("a removed device cannot come back, with its own or anyone's signature", async () => {
  const { log, owner, others } = await familyOf("Removed");
  const after = await append(log, { type: "remove", signPub: others[0].signPub }, owner);
  await assert.rejects(append(after, { type: "add", ...addBody(others[0]) }, owner), /already been on this log/);
});

test("an old recovery key on the current log is refused", async () => {
  const { log, recovery } = await familyOf();
  const newCode = await recoveryKeysFrom(newRecoveryCode());
  const replacement = await named("Replacement");
  const rotated = await append(log, recoverFields(replacement, newCode), recovery);
  const thief = await named("Thief");
  await assert.rejects(append(rotated, recoverFields(thief, await recoveryKeysFrom(newRecoveryCode())), recovery), /not on the log/);
});

test("a client device or the recovery key cannot add or remove anyone, and only the first entry can be a create", async () => {
  const { log, owner, recovery } = await familyOf();
  const web = await named("Web", "web");
  const withWeb = await append(log, { type: "add", ...addBody(web, "client") }, owner);
  const mallory = await named("Mallory");
  await assert.rejects(verifyLog([...withWeb, await signedEntry(withWeb, "add", addBody(mallory), web)], { now: now() }), /a client key/);
  await assert.rejects(verifyLog([...withWeb, await signedEntry(withWeb, "remove", { signPub: owner.signPub }, web)], { now: now() }), /a client key/);
  await assert.rejects(verifyLog([...log, await signedEntry(log, "add", addBody(mallory), recovery)], { now: now() }), /a recovery key/);
  const secondCreate = await signedEntry(log, "create", { accountId: randomKey(), ...addBody(mallory), recoveryPub: mallory.boxPub }, mallory);
  await assert.rejects(verifyLog([...log, secondCreate], { now: now() }), /only the first entry/);
});

test("a client past its 30 days is off the list on every verifier's clock", async () => {
  const { log, owner } = await familyOf();
  const web = await named("Web", "web");
  const addedAt = now() - 31 * 24 * 60 * 60 * 1000;
  const withWeb = await append(log, { type: "add", ...addBody(web, "client", addedAt) }, owner);
  const trusted = await verifyLog(withWeb, { now: now() });
  assert.ok(!trusted.devices.has(web.signPub));
});

// --- a hidden newer log ---

test("hidden newer log: a machine the hub kept in the dark learns of a removal from the handshake's head", async () => {
  const { log, owner, others } = await familyOf("Stolen laptop", "Machine");
  const [stolen, machineKeys] = others;
  const newer = await append(log, { type: "remove", signPub: stolen.signPub }, owner);
  const phone = new ThinClient(owner);
  phone.log = newer;
  const machine = new ThinClient(machineKeys);
  machine.log = log;
  const thief = new ThinClient(stolen);
  thief.log = log;

  // Hidden from the machine, the stolen device still gets a channel: the accepted limit in the design.
  assert.equal(await machine.refuseUnknownPeer(stolen.signPub), false);
  await connected(machine, thief);

  const { chA: atMachine, chB: atPhone } = await connected(machine, phone);
  assert.equal(atMachine.peerLogHead, (await phone.trust()).head);
  assert.notEqual(atMachine.peerLogHead, (await machine.trust()).head, "the head shows a log this machine has not seen");

  assert.equal(await machine.see(await sendLog(atPhone, atMachine, phone.log)), "adopted");
  assert.ok(await machine.refuseUnknownPeer(stolen.signPub), "and the stolen device is now refused");
});

test("hidden newer log: rewriting the head inside the hello to hide it breaks both proofs", async () => {
  const { log, owner, others } = await familyOf("Machine");
  const phone = new ThinClient(owner);
  phone.log = await append(log, { type: "add", ...addBody(await named("Later")) }, owner);
  const machine = new ThinClient(others[0]);
  machine.log = log;
  const oldHead = (await machine.trust()).head;

  const hub = scriptedHub({ "hello-to-a": (hello) => ({ ...hello, logHead: oldHead }) });
  const { chA, chB, results } = await handshake(machine, phone, hub);
  assert.deepEqual(results.map((r) => r.status), ["rejected", "rejected"]);
  assert.match(results[0].reason.message, /bad proof/);
  assert.throws(() => chA.peerLogHead, /closed/);
  await assert.rejects(chA.seal(utf8("hello")), /closed/);
  await assert.rejects(chB.seal(utf8("hello")), /closed/);
});

test("the peer's head cannot be read before the peer is confirmed", async () => {
  const { owner, others, client } = await familyOf("Machine");
  const [a, b] = [client(owner), client(others[0])];
  const hsA = await startHandshake({ device: a.keys, peerPub: b.keys.signPub, logHead: (await a.trust()).head });
  const hsB = await startHandshake({ device: b.keys, peerPub: a.keys.signPub, logHead: (await b.trust()).head });
  const channel = await hsA.finish(hsB.hello);
  assert.throws(() => channel.peerLogHead, /not confirmed/);
  await assert.rejects(channel.seal(utf8("x")), /not confirmed/);
  await assert.rejects(channel.open(new Uint8Array(64)), /not confirmed/);
});

// --- the handshake ---

test("a hub swapping in its own key shares gets no channel, on either side", async () => {
  const { owner, others, client } = await familyOf("Machine");
  const mallory = await named("Mallory");
  const shareOf = async (peerPub) => (await startHandshake({ device: mallory, peerPub, logHead: "any" })).hello.eph;
  const toA = await shareOf(owner.signPub);
  const toB = await shareOf(others[0].signPub);
  const hub = scriptedHub({ "hello-to-a": (hello) => ({ ...hello, eph: toA }), "hello-to-b": (hello) => ({ ...hello, eph: toB }) });
  const { results, chA } = await handshake(client(owner), client(others[0]), hub);
  assert.deepEqual(results.map((r) => r.status), ["rejected", "rejected"]);
  await assert.rejects(chA.open(new Uint8Array(64)), /closed/);
});

test("a hub answering for a device with a key of its own, or another device's, is not believed", async () => {
  const { owner, others } = await familyOf("Machine", "Other machine");
  const [machine, other] = others;
  // The client asked for `machine`, and the hub routes it to `other`, which is real and on the log.
  const hsClient = await startHandshake({ device: owner, peerPub: machine.signPub, logHead: "head" });
  const hsOther = await startHandshake({ device: other, peerPub: owner.signPub, logHead: "head" });
  const atClient = await hsClient.finish(hsOther.hello);
  const atOther = await hsOther.finish(hsClient.hello);
  await assert.rejects(atClient.confirm(atOther.proof), /bad proof/);
  await assert.rejects(atClient.seal(utf8("run this")), /closed/);
});

test("a hub connecting a device to a peer who thinks it is talking to someone else is caught, by both", async () => {
  // X asks for Y. Y asks for Z. The hub joins X and Y. The sort order is chosen so both see the key shares in one order,
  // which leaves the device keys in the transcript as the only thing that differs.
  const devices = await Promise.all(["A", "B", "C"].map((name) => named(name)));
  const order = (d) => Buffer.from(fromB64(d.signPub)).toString("hex");
  const [y, x, z] = devices.sort((p, q) => (order(p) < order(q) ? -1 : 1));
  const hsX = await startHandshake({ device: x, peerPub: y.signPub, logHead: "head" });
  const hsY = await startHandshake({ device: y, peerPub: z.signPub, logHead: "head" });
  const atX = await hsX.finish(hsY.hello);
  const atY = await hsY.finish(hsX.hello);
  await assert.rejects(atX.confirm(atY.proof), /bad proof/);
  await assert.rejects(atY.confirm(atX.proof), /bad proof/);
});

test("an old hello and proof replayed from an earlier channel are refused, stale head and all", async () => {
  const { log, owner, others } = await familyOf("Machine");
  const phone = new ThinClient(owner);
  phone.log = log;
  const machine = new ThinClient(others[0]);
  machine.log = log;
  const earlier = await connected(machine, phone);

  phone.log = await append(log, { type: "add", ...addBody(await named("Later")) }, owner);
  // Machine asks again, and the hub answers with phone's earlier hello and proof, showing the old head.
  const hub = scriptedHub({ "hello-to-a": () => earlier.hello.b, "proof-to-a": () => earlier.proof.b });
  const { results, chA } = await handshake(machine, phone, hub);
  assert.equal(results[0].status, "rejected");
  assert.match(results[0].reason.message, /bad proof/);
  await assert.rejects(chA.seal(utf8("x")), /closed/);
});

test("a device's own hello and proof sent back to it are refused", async () => {
  const { owner, others, client } = await familyOf("Machine");
  const a = client(owner);
  const hs = await startHandshake({ device: a.keys, peerPub: others[0].signPub, logHead: (await a.trust()).head });
  const channel = await hs.finish(hs.hello);
  await assert.rejects(channel.confirm(channel.proof), /bad proof/);
  await assert.rejects(channel.seal(utf8("x")), /closed/);
});

test("a key share that gives no secret is refused", async () => {
  const { owner, others } = await familyOf("Machine");
  for (const eph of [b64(new Uint8Array(32)), b64(Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? 1 : 0)))]) {
    const hs = await startHandshake({ device: owner, peerPub: others[0].signPub, logHead: "head" });
    await assert.rejects(hs.finish({ eph, logHead: "head" }), /unusable/);
  }
});

test("a handshake finishes once, so a hub cannot restart its counters", async () => {
  const { owner, others } = await familyOf("Machine");
  const hs = await startHandshake({ device: owner, peerPub: others[0].signPub, logHead: "head" });
  const peer = await startHandshake({ device: others[0], peerPub: owner.signPub, logHead: "head" });
  await hs.finish(peer.hello);
  await assert.rejects(hs.finish(peer.hello), /already finished/);
});

test("the device list a client checks a peer against leaves out a removed device and a stranger", async () => {
  // REQUIREMENT on the clients: the handshake itself proves only who holds a key. Being on the log is the caller's check.
  const { log, owner, others } = await familyOf("Removed");
  const after = await append(log, { type: "remove", signPub: others[0].signPub }, owner);
  const { devices } = await verifyLog(after, { now: now() });
  assert.ok(!devices.has(others[0].signPub));
  assert.ok(!devices.has((await named("Stranger")).signPub));
  assert.ok(devices.has(owner.signPub));
  const client = new ThinClient(owner);
  client.log = after;
  assert.ok(await client.refuseUnknownPeer(others[0].signPub));
});

// --- frames ---

async function openChannel() {
  const { owner, others, client } = await familyOf("Machine");
  const hub = scriptedHub();
  const { chA, chB } = await connected(client(owner), client(others[0]), hub);
  return { chA, chB, hub, owner, others, client };
}

/** A failed open closes the channel for good, also for the genuine frame that comes after. */
async function assertShut(channel, genuine) {
  await assert.rejects(channel.open(genuine), /closed/);
  await assert.rejects(channel.seal(utf8("x")), /closed/);
}

test("baseline: frames arrive in order, in both directions, and tell the hub nothing", async () => {
  const { chA, chB, hub } = await openChannel();
  const secret = "SECRET-ACTION rm -rf /important";
  const frames = [];
  for (let i = 0; i < 3; i++) {
    const frame = await chA.seal(utf8(`${secret} ${i}`));
    frames.push(hub.carry("frame", b64(frame)));
    assert.equal(decoder.decode(await chB.open(frame)), `${secret} ${i}`);
    const back = await chB.seal(utf8(`reply ${i}`));
    frames.push(hub.carry("frame", b64(back)));
    assert.equal(decoder.decode(await chA.open(back)), `reply ${i}`);
  }
  assert.ok(!hub.wire.join("").includes("SECRET"));
  assert.ok(!frames.some((f) => Buffer.from(f, "base64").includes("SECRET")));
  assert.ok(!frames.some((f) => Buffer.from(f, "base64").includes("reply")));
});

test("a replayed frame is refused and shuts the channel", async () => {
  const { chA, chB } = await openChannel();
  const frame = await chA.seal(utf8("delete it"));
  const copy = frame.slice();
  await chB.open(frame);
  await assert.rejects(chB.open(copy), /out of order or replayed/);
  await assertShut(chB, await chA.seal(utf8("next")));
});

test("reordered frames are refused and shut the channel", async () => {
  const { chA, chB } = await openChannel();
  const first = await chA.seal(utf8("first"));
  const second = await chA.seal(utf8("second"));
  await assert.rejects(chB.open(second), /out of order/);
  await assertShut(chB, first);
});

test("a dropped frame is found at the next one", async () => {
  const { chA, chB } = await openChannel();
  await chA.seal(utf8("dropped"));
  await assert.rejects(chB.open(await chA.seal(utf8("next"))), /out of order/);
});

test("altered frames are refused, whichever byte changes", async () => {
  const positions = [8, 20, -1, -16];
  for (const at of positions) {
    const { chA, chB } = await openChannel();
    const frame = await chA.seal(utf8("transfer this to that"));
    const altered = frame.slice();
    altered[at < 0 ? altered.length + at : at] ^= 1;
    await assert.rejects(chB.open(altered), /failed authentication/);
    await assertShut(chB, frame);
  }
});

test("a frame with a rewritten counter is refused, so it cannot jump the queue", async () => {
  const { chA, chB } = await openChannel();
  const first = await chA.seal(utf8("first"));
  const second = await chA.seal(utf8("second"));
  const moved = second.slice();
  new DataView(moved.buffer).setBigUint64(0, 0n);
  await assert.rejects(chB.open(moved), /failed authentication/);
  await assertShut(chB, first);
});

test("a frame sent back to its sender is refused", async () => {
  const { chA } = await openChannel();
  const frame = await chA.seal(utf8("mine"));
  await assert.rejects(chA.open(frame), /failed authentication/);
});

test("a frame from an earlier channel of the same two devices is refused", async () => {
  const { owner, others, client } = await familyOf("Machine");
  const [a, b] = [client(owner), client(others[0])];
  const old = await connected(a, b);
  const frame = await old.chA.seal(utf8("from before"));
  const fresh = await connected(a, b);
  await assert.rejects(fresh.chB.open(frame), /failed authentication/);
});

test("a frame made up by the hub is refused, and short ones too", async () => {
  const { chA, chB } = await openChannel();
  const made = new Uint8Array(48);
  crypto.getRandomValues(made.subarray(8));
  await assert.rejects(chB.open(made), /failed authentication/);
  await assert.rejects(chA.open(new Uint8Array(4)), /too short/);
  await assert.rejects(chA.seal(utf8("x")), /closed/);
});

test("what the hub carries in a whole session holds no password, recovery code or plaintext", async () => {
  const password = "correct horse battery staple";
  const salt = randomBytes(16);
  const loginKey = await loginKeyFrom(password, salt);
  assert.ok(!Buffer.from(loginKey).includes(Buffer.from(password)));

  const { owner, others, log, recoveryCode, client } = await familyOf("Machine");
  const hub = scriptedHub();
  const { chA } = await connected(client(owner), client(others[0]), hub);
  hub.carry("frame", b64(await chA.seal(utf8(`chat text ${password} ${recoveryCode}`))));
  hub.carry("log", log);
  hub.carry("login", { loginKey: b64(loginKey) });
  const everything = hub.wire.join("\n");
  assert.ok(!everything.includes(password));
  assert.ok(!everything.includes(recoveryCode));
  assert.ok(!everything.includes(recoveryCode.replaceAll("-", "")));
  assert.ok(!everything.includes("chat text"));
});

// --- the real hub ---

async function realHub(t) {
  const dir = mkdtempSync(join(tmpdir(), "omni-hub-attacks-"));
  const hub = await startHub({ port: 0, dataDir: dir, origin: ORIGIN, bootstrapToken: BOOTSTRAP, log: () => {} });
  hub.dir = dir;
  const sockets = [];
  hub.track = (socket) => { sockets.push(socket); return socket; };
  t.after(async () => {
    for (const socket of sockets) socket.close();
    await hub.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  return hub;
}

const post = async (hub, path, body) => {
  const res = await fetch(`http://127.0.0.1:${hub.port}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
};

/** The hub's real message format, on a real WebSocket. */
async function dial(hub, account, keys, extra = {}) {
  const login = await post(hub, "/api/login", { email: account.email, loginKey: account.loginKey, signPub: keys.signPub, ...extra });
  assert.equal(login.status, 200);
  const ws = new WebSocket(`ws://127.0.0.1:${hub.port}/ws`);
  const inbox = [];
  const waiters = new Set();
  let closeCode = null;
  const wake = () => { for (const waiter of [...waiters]) waiter(); };
  ws.onmessage = (event) => { inbox.push(JSON.parse(event.data)); wake(); };
  ws.onclose = (event) => { closeCode = event.code; wake(); };
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error("websocket failed")); });

  const socket = {
    state: login.json.state,
    send: (message) => ws.send(JSON.stringify(message)),
    close: () => ws.close(),
    get closeCode() { return closeCode; },
    next(type) {
      const take = () => {
        const at = inbox.findIndex((m) => m.type === type);
        return at < 0 ? null : inbox.splice(at, 1)[0];
      };
      const found = take();
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const done = (settle, value) => {
          waiters.delete(check);
          clearTimeout(timer);
          settle(value);
        };
        const check = () => {
          const message = take();
          if (message) done(resolve, message);
        };
        const timer = setTimeout(() => done(reject, new Error(`no ${type}; inbox ${JSON.stringify(inbox).slice(0, 200)}; closed ${closeCode}`)), WAIT_MS);
        waiters.add(check);
      });
    },
    async closed() {
      const until = Date.now() + WAIT_MS;
      while (closeCode === null && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 5));
      return closeCode;
    },
  };
  hub.track(socket);
  socket.send({ type: "auth", session: login.json.session });
  const { nonce } = await socket.next("auth.challenge");
  socket.nonce = nonce;
  socket.send({ type: "auth.proof", sig: await sign(keys.sign.privateKey, utf8(`omni-hub-auth-v1 ${ORIGIN} ${nonce}`)) });
  socket.auth = await socket.next("auth.ok");
  return socket;
}

async function registered(hub) {
  const family = await familyOf();
  const account = { email: "owner@example.com", loginKey: randomKey() };
  const r = await post(hub, "/api/register", { email: account.email, salt: b64(randomBytes(16)), verifierInput: account.loginKey, firstLogEntry: family.log[0], bootstrapToken: BOOTSTRAP });
  assert.equal(r.status, 201);
  return { ...family, account };
}

const headOf = async (log) => (await verifyLog(log, { now: now() })).head;

async function appended(socket, log, entry) {
  socket.send({ type: "log.append", prevHead: await headOf(log), entry });
  return socket.next("log.ok");
}

test("honest path through the real hub: approval, then a channel, and the hub's disk never holds the plaintext", async (t) => {
  const hub = await realHub(t);
  const { owner, log, account } = await registered(hub);
  const approverSocket = await dial(hub, account, owner);
  assert.equal(approverSocket.auth.state, "approved");

  const fresh = await named("New laptop");
  const freshSocket = await dial(hub, account, fresh, { name: fresh.name, kind: fresh.kind });
  assert.equal(freshSocket.auth.state, "pending");
  const logHead = await headOf(log);

  // The new device is told who approves, and over what head, by a message the hub could change. The code covers both.
  const toFresh = async (value) => {
    approverSocket.send({ type: "approval.msg", to: fresh.signPub, opaque: JSON.stringify(value) });
    return JSON.parse((await freshSocket.next("approval.msg")).opaque);
  };
  const toApprover = async (value) => {
    freshSocket.send({ type: "approval.msg", to: owner.signPub, opaque: JSON.stringify(value) });
    return JSON.parse((await approverSocket.next("approval.msg")).opaque);
  };
  const exchange = await approverExchange({ approverPub: owner.signPub, newPub: fresh.signPub, logHead });
  const opening = await toFresh({ commit: exchange.commit, approverPub: owner.signPub, logHead });
  const newcomer = await newDeviceExchange({ approverPub: opening.approverPub, newPub: fresh.signPub, logHead: opening.logHead });
  newcomer.receiveCommit(opening.commit);
  const { random, boxPub } = await toApprover({ random: newcomer.releaseRandom(), boxPub: fresh.boxPub });
  exchange.receiveRandom(random);
  await newcomer.receiveReveal((await toFresh({ reveal: exchange.revealRandom() })).reveal);
  const [shownOnApprover, shownOnNew] = [await exchange.code(), await newcomer.code()];
  assert.equal(shownOnApprover, shownOnNew);

  const next = await append(log, { type: "add", ...addBody({ ...fresh, boxPub }) }, owner);
  await appended(approverSocket, log, next.at(-1));
  await freshSocket.next("session.approved");

  freshSocket.send({ type: "log.get" });
  const served = await freshSocket.next("log");
  const client = new ThinClient(fresh);
  assert.equal(await client.acceptApproval(served.entries, { logHead: opening.logHead, approverPub: opening.approverPub }, shownOnNew === shownOnApprover), "adopted");

  // A channel over the real routing.
  const relay = async (from, to, toKey, value) => {
    from.send({ type: "channel.msg", to: toKey, opaque: JSON.stringify(value) });
    return JSON.parse((await to.next("channel.msg")).opaque);
  };
  const ownerClient = new ThinClient(owner);
  ownerClient.log = next;
  const hsOwner = await startHandshake({ device: owner, peerPub: fresh.signPub, logHead: (await ownerClient.trust()).head });
  const hsFresh = await startHandshake({ device: fresh, peerPub: owner.signPub, logHead: (await client.trust()).head });
  const chOwner = await hsOwner.finish(await relay(freshSocket, approverSocket, owner.signPub, hsFresh.hello));
  const chFresh = await hsFresh.finish(await relay(approverSocket, freshSocket, fresh.signPub, hsOwner.hello));
  await chOwner.confirm(await relay(freshSocket, approverSocket, owner.signPub, chFresh.proof));
  await chFresh.confirm(await relay(approverSocket, freshSocket, fresh.signPub, chOwner.proof));

  const secret = "SECRET-FROM-THE-CHAT";
  const frame = await relay(freshSocket, approverSocket, owner.signPub, b64(await chFresh.seal(utf8(secret))));
  assert.equal(decoder.decode(await chOwner.open(Uint8Array.from(Buffer.from(frame, "base64")))), secret);

  for (const name of readdirSync(hub.dir)) assert.ok(!readFileSync(join(hub.dir, name), "latin1").includes(secret), name);
});

test("first valid rule on the real hub: a removed device's backdated fork is refused, by every route", async (t) => {
  const hub = await realHub(t);
  const { owner, log, account } = await registered(hub);
  const socket = await dial(hub, account, owner);
  const removed = await named("Removed");
  const withRemoved = await append(log, { type: "add", ...addBody(removed) }, owner);
  await appended(socket, log, withRemoved.at(-1));
  const removedSocket = await dial(hub, account, removed);
  assert.equal(removedSocket.auth.state, "approved");

  const honest = await append(withRemoved, { type: "remove", signPub: removed.signPub }, owner);
  await appended(socket, withRemoved, honest.at(-1));
  assert.equal(await removedSocket.closed(), 4403, "the removed device is cut off at once");

  const accomplice = await named("Accomplice");
  const fork = await signedEntry(withRemoved, "add", addBody(accomplice), removed);

  // A device still on the log carries it for the removed one, as a colluding sender would, naming the old head...
  socket.send({ type: "log.append", prevHead: await headOf(withRemoved), entry: fork });
  const conflict = await socket.next("log.conflict");
  assert.equal(conflict.version, honest.length);
  assert.equal(conflict.head, await headOf(honest));

  // ...and naming the current one.
  socket.send({ type: "log.append", prevHead: await headOf(honest), entry: fork });
  const notNext = await socket.next("error");
  assert.equal(notNext.code, "invalid-entry");
  assert.equal(notNext.reason, "not the next entry");

  // The same signer on the current head is refused by the replay.
  socket.send({ type: "log.append", prevHead: await headOf(honest), entry: await signedEntry(honest, "add", addBody(accomplice), removed) });
  const refused = await socket.next("error");
  assert.equal(refused.code, "invalid-entry");
  assert.match(refused.reason, /not on the log/);

  // Removed, it can still show a pending card with the password, but it cannot read or write anything.
  const again = await dial(hub, account, removed);
  assert.equal(again.auth.state, "pending");
  again.send({ type: "log.append", prevHead: await headOf(honest), entry: await signedEntry(honest, "add", addBody(accomplice), removed) });
  assert.equal((await again.next("error")).code, "forbidden");

  socket.send({ type: "log.get" });
  assert.deepEqual((await socket.next("log")).entries, honest, "nothing got in");
});

test("first valid rule on the real hub: an old recovery key gets nowhere, and the current one is needed even to read", async (t) => {
  const hub = await realHub(t);
  const { log, recovery, account } = await registered(hub);
  const proof = (keys, nonce) => sign(keys.sign.privateKey, utf8(`omni-hub-recovery-v1 ${ORIGIN} ${nonce}`));

  const replacement = await named("Replacement");
  const recovering = await dial(hub, account, replacement);
  assert.equal(recovering.auth.state, "pending");
  recovering.send({ type: "log.get" });
  assert.equal((await recovering.next("error")).code, "forbidden", "the password alone does not show the log");
  recovering.send({ type: "log.get", recoveryProof: await proof(recovery, recovering.nonce) });
  assert.deepEqual((await recovering.next("log")).entries, log);

  const newCode = await recoveryKeysFrom(newRecoveryCode());
  const rotated = await append(log, recoverFields(replacement, newCode), recovery);
  await appended(recovering, log, rotated.at(-1));

  const thief = await named("Thief");
  const thiefSocket = await dial(hub, account, thief);
  thiefSocket.send({ type: "log.get", recoveryProof: await proof(recovery, thiefSocket.nonce) });
  assert.equal((await thiefSocket.next("error")).code, "forbidden");

  const stolen = await recoveryKeysFrom(newRecoveryCode());
  const forkAtOldHead = await append(log, recoverFields(thief, stolen), recovery);
  thiefSocket.send({ type: "log.append", prevHead: await headOf(log), entry: forkAtOldHead.at(-1) });
  assert.equal((await thiefSocket.next("error")).code, "forbidden");
  const body = { name: thief.name, kind: thief.kind, role: "full", signPub: thief.signPub, boxPub: thief.boxPub, addedAt: now(), recoveryPub: stolen.signPub };
  thiefSocket.send({ type: "log.append", prevHead: await headOf(rotated), entry: await signedEntry(rotated, "recover", body, recovery) });
  assert.equal((await thiefSocket.next("error")).code, "forbidden");

  // Its verified log on the hub is the rotated one, as the holder of the new code sees.
  thiefSocket.send({ type: "log.get", recoveryProof: await proof(newCode, thiefSocket.nonce) });
  assert.deepEqual((await thiefSocket.next("log")).entries, rotated);
});

test("the real hub: a recover with no signature by its new key is refused, and a claimed kind gives no authority", async (t) => {
  const hub = await realHub(t);
  const { owner, log, recovery, account } = await registered(hub);
  const socket = await dial(hub, account, owner);

  const device = await named("Replacement");
  const pending = await dial(hub, account, device, { name: device.name, kind: "desktop" });
  assert.equal(pending.auth.state, "pending", "saying desktop at sign-in changes nothing");
  const body = { ...addBody(device), recoveryPub: randomKey() };
  pending.send({ type: "log.append", prevHead: await headOf(log), entry: await signedEntry(log, "recover", body, recovery) });
  const refused = await pending.next("error");
  assert.equal(refused.code, "invalid-entry");
  assert.match(refused.reason, /recovery key it introduces/);

  const web = await named("Web page", "desktop");
  const withWeb = await append(log, { type: "add", ...addBody(web, "client") }, owner);
  await appended(socket, log, withWeb.at(-1));
  const webSocket = await dial(hub, account, web, { name: web.name, kind: "desktop" });
  assert.equal(webSocket.auth.state, "approved");
  webSocket.send({ type: "log.append", prevHead: await headOf(withWeb), entry: await signedEntry(withWeb, "add", addBody(await named("Mallory")), web) });
  assert.equal((await webSocket.next("error")).code, "forbidden");
  webSocket.send({ type: "pending.list" });
  assert.equal((await webSocket.next("error")).code, "forbidden");

  socket.send({ type: "log.get" });
  assert.deepEqual((await socket.next("log")).entries, withWeb);
});

test("two valid appends at one position on the real hub: the first wins and the second is told", async (t) => {
  const hub = await realHub(t);
  const { owner, log, account } = await registered(hub);
  const socket = await dial(hub, account, owner);
  const second = await named("Second");
  const withSecond = await append(log, { type: "add", ...addBody(second) }, owner);
  await appended(socket, log, withSecond.at(-1));
  const secondSocket = await dial(hub, account, second);

  const first = await append(withSecond, { type: "add", ...addBody(await named("A")) }, owner);
  const rival = await append(withSecond, { type: "add", ...addBody(await named("B")) }, second);
  await appended(socket, withSecond, first.at(-1));
  secondSocket.send({ type: "log.append", prevHead: await headOf(withSecond), entry: rival.at(-1) });
  const conflict = await secondSocket.next("log.conflict");
  assert.deepEqual(conflict.entries, first);
  assert.equal(await compareLogs(rival, conflict.entries), "fork", "and the loser sees exactly why");
});
