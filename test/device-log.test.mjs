import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { newDeviceKeys, newRecoveryCode, recoveryKeysFrom, sign, approvalCode, toB64, fromB64 } from "../ui/account-core.js";
import { createLog, append, verifyLog, compareLogs, entryBytes, entryHash, LogError, MAX_LOG_ENTRIES } from "../ui/device-log.js";

const T0 = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const THIRTY_DAYS = 30 * DAY;
const opts = { now: T0 };

const [alice, bob, carol, web, dave] = await Promise.all(Array.from({ length: 5 }, () => newDeviceKeys()));
const recovery = await recoveryKeysFrom(newRecoveryCode());
const recovery2 = await recoveryKeysFrom(newRecoveryCode());
const recovery3 = await recoveryKeysFrom(newRecoveryCode());
const spare = await newDeviceKeys();
const recoveryAsDevice = (keys) => ({ ...keys, boxPub: spare.boxPub });

const overJson = (v) => JSON.parse(JSON.stringify(v));
const named = (keys, name = "PC", kind = "desktop") => ({ ...keys, name, kind });
const created = () => createLog({ device: named(alice, "Alice PC"), recoveryPub: recovery.signPub });
const addOf = (keys, role = "full", addedAt = T0, name = "Device") => ({ type: "add", name, kind: "desktop", role, signPub: keys.signPub, boxPub: keys.boxPub, addedAt });
const bodyOf = ({ type, ...body }) => body;
const recoverOf = (keys, recoveryPub, addedAt = T0) => ({ type: "recover", name: "Rescue", kind: "desktop", signPub: keys.signPub, boxPub: keys.boxPub, recoveryPub, addedAt });
const recoverBody = (keys, recoveryPub) => ({ ...bodyOf(recoverOf(keys, recoveryPub)), role: "full" });
const removeOf = (keys) => ({ type: "remove", signPub: keys.signPub });

/** create, add bob (full), add web (client), all at T0. */
async function base() {
  let log = await created();
  log = await append(log, addOf(bob), alice);
  return append(log, addOf(web, "client"), alice);
}

/** What a malicious signer can do and `append` would not: sign any entry, correctly chained unless told otherwise. */
async function forged(log, type, body, signer, over = {}) {
  const unsigned = { type, index: log.length, prev: log.length ? await entryHash(log.at(-1)) : "", signer: signer.signPub, body, ...over };
  return [...log, { ...unsigned, sig: await sign(signer.sign.privateKey, entryBytes(unsigned)) }];
}

/** The same, reusing the array, for building a long log. */
async function forgedOnto(log, type, body, signer) {
  log.push((await forged(log.slice(-1), type, body, signer, { index: log.length })).at(-1));
  return log;
}

async function rejectedAt(entries, index, pattern) {
  await assert.rejects(verifyLog(entries, opts), (e) => {
    assert.ok(e instanceof LogError, `not a LogError: ${e}`);
    assert.equal(e.index, index);
    assert.match(e.message, new RegExp(`entry ${index}\\b`));
    assert.match(e.message, pattern);
    return true;
  });
}

const withLast = (log, change) => [...log.slice(0, -1), change(overJson(log.at(-1)))];

test("the module loads anywhere: only the core is imported, no node: and no npm", () => {
  const source = readFileSync(new URL("../ui/device-log.js", import.meta.url), "utf8");
  const imports = [...source.matchAll(/^\s*import\b.*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ["./account-core.js"]);
  assert.doesNotMatch(source, /\bimport\(|\brequire\(|node:/);
});

// --- a valid chain ---

test("a valid chain: create, add, remove, read back as devices, head and version", async () => {
  let log = await created();
  let state = await verifyLog(log, opts);
  assert.equal(state.version, 1);
  assert.deepEqual([...state.devices.keys()], [alice.signPub]);
  assert.equal(state.devices.get(alice.signPub).role, "full");
  assert.equal(state.devices.get(alice.signPub).name, "Alice PC");
  assert.equal(state.devices.get(alice.signPub).kind, "desktop");
  assert.equal(state.devices.get(alice.signPub).boxPub, alice.boxPub);
  assert.equal(state.recoveryPub, recovery.signPub);
  assert.deepEqual(state.recoveries, []);
  const firstHead = state.head;
  assert.equal(firstHead, await entryHash(log[0]));

  log = await append(log, addOf(bob), alice);
  log = await append(log, addOf(web, "client"), bob);
  state = await verifyLog(log, opts);
  assert.equal(state.version, 3);
  assert.deepEqual([...state.devices.keys()], [alice.signPub, bob.signPub, web.signPub]);
  assert.equal(state.devices.get(web.signPub).role, "client");
  assert.equal(state.accountId, log[0].body.accountId);
  assert.notEqual(state.head, firstHead);

  log = await append(log, removeOf(bob), alice);
  state = await verifyLog(log, opts);
  assert.equal(state.version, 4);
  assert.deepEqual([...state.devices.keys()], [alice.signPub, web.signPub]);
});

test("the log survives JSON unchanged: same head, whatever order the keys come in", async () => {
  const log = await base();
  const reversed = overJson(log).map((entry) => {
    const body = Object.fromEntries(Object.entries(entry.body).reverse());
    return Object.fromEntries(Object.entries({ ...entry, body }).reverse());
  });
  assert.equal((await verifyLog(overJson(log), opts)).head, (await verifyLog(log, opts)).head);
  assert.equal((await verifyLog(reversed, opts)).head, (await verifyLog(log, opts)).head);
});

test("the head is a non-empty string the core's approval code accepts", async () => {
  const { head } = await verifyLog(await base(), opts);
  assert.equal(typeof head, "string");
  assert.ok(head.length > 0);
  const code = await approvalCode({ approverRandom: toB64(new Uint8Array(32)), newRandom: toB64(new Uint8Array(32)), approverPub: alice.signPub, newPub: bob.signPub, logHead: head });
  assert.match(code, /^\d{6}$/);
});

test("every prefix of a valid log is valid: an old log is stale, not broken", async () => {
  const log = await append(await base(), removeOf(web), bob);
  for (let n = 1; n <= log.length; n++) assert.equal((await verifyLog(log.slice(0, n), opts)).version, n);
});

test("append does not change the log it was given", async () => {
  const log = await created();
  const before = overJson(log);
  const next = await append(log, addOf(bob), alice);
  assert.deepEqual(overJson(log), before);
  assert.equal(next.length, 2);
});

test("each log has its own random account id", async () => {
  const [a, b] = [await created(), await created()];
  assert.equal(fromB64(a[0].body.accountId).length, 32);
  assert.notEqual(a[0].body.accountId, b[0].body.accountId);
  assert.notEqual((await verifyLog(a, opts)).head, (await verifyLog(b, opts)).head);
});

test("the encoding is the documented one, pinned against an independent implementation", async () => {
  const frame = (...fields) => Buffer.concat(fields.map((f) => {
    const bytes = Buffer.from(f), length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    return Buffer.concat([length, bytes]);
  }));
  const pub = Buffer.alloc(32, 7), box = Buffer.alloc(32, 8), prev = Buffer.alloc(32, 9), signer = Buffer.alloc(32, 10), sig = Buffer.alloc(64, 11);
  const entry = {
    type: "add", index: 5, prev: prev.toString("base64"), signer: signer.toString("base64"),
    body: { name: "Ç PC", kind: "iphone", role: "client", signPub: pub.toString("base64"), boxPub: box.toString("base64"), addedAt: T0 },
    sig: sig.toString("base64"),
  };
  const expected = frame("omni-log-entry-v1", "add", "5", prev, signer, "Ç PC", "iphone", "client", pub, box, String(T0));
  assert.equal(Buffer.from(entryBytes(entry)).toString("hex"), expected.toString("hex"));
  const hash = createHash("sha256").update(frame("omni-log-hash-v1", expected, sig)).digest("base64");
  assert.equal(await entryHash(entry), hash);
});

// --- signatures and hashes ---

test("a bad signature is rejected, naming the entry", async () => {
  const log = await base();
  const flipped = (sig) => { const bytes = fromB64(sig); bytes[0] ^= 1; return toB64(bytes); };
  await rejectedAt(withLast(log, (e) => ({ ...e, sig: flipped(e.sig) })), 2, /signature/);
  await rejectedAt([{ ...overJson(log[0]), sig: flipped(log[0].sig) }], 0, /signature/);
});

test("no field of any entry type escapes the signature", async () => {
  const other = await newDeviceKeys();
  const changes = { name: "Other", kind: "other", role: null, signPub: other.signPub, boxPub: other.boxPub, addedAt: T0 + 1, recoveryPub: other.signPub, accountId: toB64(new Uint8Array(32)) };
  const logs = {
    create: await created(),
    add: await base(),
    remove: await append(await base(), removeOf(bob), alice),
    recover: await append(await base(), recoverOf(carol, recovery2.signPub), recovery),
  };
  for (const [type, log] of Object.entries(logs)) {
    assert.equal(log.at(-1).type, type);
    for (const field of Object.keys(log.at(-1).body)) {
      const value = field === "role" ? (log.at(-1).body.role === "full" ? "client" : "full") : changes[field];
      await rejectedAt(withLast(log, (e) => ({ ...e, body: { ...e.body, [field]: value } })), log.length - 1, /signature/);
    }
  }
});

test("the signer field is bound: naming another key does not make its signature", async () => {
  await rejectedAt(withLast(await base(), (e) => ({ ...e, signer: bob.signPub })), 2, /signature/);
});

test("an entry that does not chain to the one before is rejected, even if correctly signed", async () => {
  const log = await base();
  const wrongPrev = await entryHash(log[0]);
  await rejectedAt(await forged(log, "add", bodyOf(addOf(carol)), alice, { prev: wrongPrev }), 3, /does not chain/);
  await rejectedAt(await forged(log, "add", bodyOf(addOf(carol)), alice, { prev: "" }), 3, /does not chain/);
});

test("entries dropped, shifted or reordered are rejected", async () => {
  const log = await base();
  const dropped = [log[0], log[2]];
  await rejectedAt(dropped, 1, /position/);
  const shifted = [log[0], { ...log[2], index: 1 }];
  await rejectedAt(shifted, 1, /does not chain/);
  await rejectedAt([log[0], log[2], log[1]], 1, /position/);
});

test("a signature made for one position is not valid at another", async () => {
  const log = await base();
  const moved = { ...log[2], index: 1, prev: await entryHash(log[0]) };
  await rejectedAt([log[0], moved], 1, /signature/);
});

test("an entry cannot be spliced into another account's log", async () => {
  const mine = await append(await created(), addOf(bob), alice);
  const theirs = await created(); // same device, same recovery key, another account
  await rejectedAt([theirs[0], mine[1]], 1, /does not chain/);
  const repointed = { ...mine[1], prev: await entryHash(theirs[0]) };
  await rejectedAt([theirs[0], repointed], 1, /signature/);
});

// --- the first entry ---

test("a log must start with one create, and has only one", async () => {
  await rejectedAt([], 0, /create/);
  const log = await created();
  const again = await createLog({ device: named(bob), recoveryPub: recovery2.signPub });
  await rejectedAt([...log, { ...again[0], index: 1, prev: log[0] && await entryHash(log[0]) }], 1, /create/);
  await rejectedAt(await forged(log, "create", { ...log[0].body }, alice), 1, /create/);
  await rejectedAt(await forged([], "add", bodyOf(addOf(alice)), alice), 0, /create/);
});

test("create: self-signed, with a role of full and an empty prev", async () => {
  const body = (await created())[0].body;
  await rejectedAt(await forged([], "create", body, bob), 0, /own key/);
  await rejectedAt(await forged([], "create", { ...body, role: "client" }, alice), 0, /full/);
  await rejectedAt(await forged([], "create", body, alice, { prev: await entryHash((await created())[0]) }), 0, /does not chain/);
});

test("createLog and append refuse what verifyLog would refuse", async () => {
  await assert.rejects(createLog({ device: named(alice), recoveryPub: alice.signPub }), LogError);
  await assert.rejects(createLog({ device: { ...alice, name: "" , kind: "desktop" }, recoveryPub: recovery.signPub }), LogError);
  await assert.rejects(createLog({ device: named(alice), recoveryPub: "nope" }), LogError);
  const log = await created();
  await assert.rejects(append(log, { type: "create" }, alice), LogError);
  await assert.rejects(append(log, { type: "nonsense" }, alice), LogError);
  await assert.rejects(append(log, addOf(bob), bob), LogError, "a stranger cannot add itself");
  await assert.rejects(append(log, addOf(bob), { ...alice, sign: bob.sign }), LogError, "the key must be the one it claims");
  await assert.rejects(append(log, { ...addOf(bob), extra: 1 }, alice), LogError);
  const tampered = withLast(await base(), (e) => ({ ...e, sig: toB64(new Uint8Array(64)) }));
  await assert.rejects(append(tampered, addOf(carol), alice), (e) => e instanceof LogError && e.index === 2 && /signature/.test(e.message), "no appending to a log that does not verify");
});

test("an add needs no timestamp from the caller, and takes one", async () => {
  const before = Date.now();
  const { addedAt, ...noTime } = addOf(bob);
  const log = await append(await created(), noTime, alice);
  assert.ok(log[1].body.addedAt >= before && log[1].body.addedAt <= Date.now());
  assert.equal(log[1].body.role, "full");
  assert.equal((await append(await created(), addOf(bob, "full", 12345), alice))[1].body.addedAt, 12345);
});

// --- who can sign what ---

test("a removed device's later entries are rejected, however well signed", async () => {
  const log = await append(await base(), removeOf(bob), alice);
  await rejectedAt(await forged(log, "add", bodyOf(addOf(carol)), bob), 4, /not on the log/);
  await rejectedAt(await forged(log, "add", bodyOf(addOf(dave, "client")), bob), 4, /not on the log/);
  await rejectedAt(await forged(log, "remove", bodyOf(removeOf(alice)), bob), 4, /not on the log/);
  await assert.rejects(append(log, addOf(carol), bob), /not on the log/);
});

test("a removed device's entries from before its removal stay valid", async () => {
  let log = await created();
  log = await append(log, addOf(bob), alice);
  log = await append(log, addOf(carol), bob);
  log = await append(log, removeOf(bob), alice);
  assert.ok((await verifyLog(log, opts)).devices.has(carol.signPub));
});

test("a removed device cannot be added back, by itself or anyone", async () => {
  const log = await append(await base(), removeOf(bob), alice);
  await rejectedAt(await forged(log, "add", bodyOf(addOf(bob)), alice), 4, /already/);
});

test("a stranger's entry is rejected", async () => {
  await rejectedAt(await forged(await base(), "add", bodyOf(addOf(carol)), carol), 3, /not on the log/);
});

test("a client device cannot sign any entry", async () => {
  const log = await base();
  await rejectedAt(await forged(log, "add", bodyOf(addOf(carol)), web), 3, /full.*client/);
  await rejectedAt(await forged(log, "remove", bodyOf(removeOf(bob)), web), 3, /full.*client/);
  await rejectedAt(await forged(log, "remove", bodyOf(removeOf(web)), web), 3, /full.*client/);
  await rejectedAt(await forged(log, "recover", recoverBody(carol, recovery2.signPub), web), 3, /recovery.*client/);
  await assert.rejects(append(log, addOf(carol), web), LogError);
});

test("the recovery key can sign only a recover", async () => {
  const log = await base();
  await rejectedAt(await forged(log, "add", bodyOf(addOf(carol)), recovery), 3, /full.*recovery/);
  await rejectedAt(await forged(log, "remove", bodyOf(removeOf(bob)), recovery), 3, /full.*recovery/);
  await assert.rejects(append(log, addOf(carol), recovery), LogError);
});

test("the recovery key is not a device: it cannot be found in devices, so it opens no channel", async () => {
  const state = await verifyLog(await base(), opts);
  assert.equal(state.devices.has(recovery.signPub), false);
  assert.equal(state.recoveryPub, recovery.signPub);
});

test("a full device cannot sign a recover", async () => {
  await rejectedAt(await forged(await base(), "recover", recoverBody(carol, recovery2.signPub), alice), 3, /recovery.*full/);
});

test("add can only give the roles full and client", async () => {
  const log = await base();
  for (const role of ["recovery", "admin"]) {
    await rejectedAt(withLast(log, (e) => ({ ...e, body: { ...e.body, role } })), 2, /role/);
    await assert.rejects(append(log, addOf(carol, role), alice), /role/);
  }
});

// --- removal limits ---

test("removing the last full device is refused, also from itself", async () => {
  const log = await created();
  await assert.rejects(append(log, removeOf(alice), alice), (e) => e instanceof LogError && /last full/.test(e.message));
  await rejectedAt(await forged(log, "remove", bodyOf(removeOf(alice)), alice), 1, /last full/);
});

test("a client does not count as the full device that remains", async () => {
  const log = await append(await created(), addOf(web, "client"), alice);
  await rejectedAt(await forged(log, "remove", bodyOf(removeOf(alice)), alice), 2, /last full/);
});

test("a device may remove itself while another full device remains, and can sign nothing after", async () => {
  const log = await append(await base(), removeOf(bob), bob);
  const state = await verifyLog(log, opts);
  assert.equal(state.devices.has(bob.signPub), false);
  await rejectedAt(await forged(log, "remove", bodyOf(removeOf(alice)), alice), 4, /last full/);
  await rejectedAt(await forged(log, "add", bodyOf(addOf(carol)), bob), 4, /not on the log/);
});

test("a recover first: then the old last full device can go", async () => {
  let log = await created();
  log = await append(log, recoverOf(carol, recovery2.signPub), recovery);
  log = await append(log, removeOf(alice), carol);
  const state = await verifyLog(log, opts);
  assert.deepEqual([...state.devices.keys()], [carol.signPub]);
});

test("a remove must name a device on the log", async () => {
  const log = await base();
  await rejectedAt(await forged(log, "remove", bodyOf(removeOf(carol)), alice), 3, /not a device/);
  await rejectedAt(await forged(log, "remove", bodyOf(removeOf(recovery)), alice), 3, /not a device/);
  const gone = await append(log, removeOf(bob), alice);
  await rejectedAt(await forged(gone, "remove", bodyOf(removeOf(bob)), alice), 4, /not a device/);
});

// --- recovery ---

test("a recover adds a full device, replaces the recovery key, and leaves a notice", async () => {
  const log = await append(await base(), recoverOf(carol, recovery2.signPub, T0 + 5), recovery);
  const state = await verifyLog(log, opts);
  const added = state.devices.get(carol.signPub);
  assert.equal(added.role, "full");
  assert.equal(added.boxPub, carol.boxPub);
  assert.equal(state.recoveryPub, recovery2.signPub);
  assert.deepEqual(state.recoveries, [{ index: 3, signPub: carol.signPub, name: "Rescue", kind: "desktop", addedAt: T0 + 5 }]);
  const next = await append(log, addOf(dave), carol);
  assert.ok((await verifyLog(next, opts)).devices.has(dave.signPub), "the new device can act");
});

test("the old recovery key is useless after a recover", async () => {
  const log = await append(await base(), recoverOf(carol, recovery2.signPub), recovery);
  await rejectedAt(await forged(log, "recover", recoverBody(dave, recovery3.signPub), recovery), 4, /recovery.*not on the log/);
  await assert.rejects(append(log, recoverOf(dave, recovery3.signPub), recovery), LogError);
  const next = await append(log, recoverOf(dave, recovery3.signPub), recovery2);
  const state = await verifyLog(next, opts);
  assert.equal(state.recoveryPub, recovery3.signPub);
  assert.equal(state.recoveries.length, 2);
});

test("a recover always gives the role full", async () => {
  const log = await base();
  await rejectedAt(await forged(log, "recover", { ...recoverBody(carol, recovery2.signPub), role: "client" }, recovery), 3, /full/);
  await assert.rejects(append(log, { ...recoverOf(carol, recovery2.signPub), role: "client" }, recovery), /full/);
});

test("a recover cannot keep or reuse a recovery key, or make the recovery key a device", async () => {
  const log = await base();
  await rejectedAt(await forged(log, "recover", recoverBody(carol, recovery.signPub), recovery), 3, /already/);
  await rejectedAt(await forged(log, "recover", recoverBody(recoveryAsDevice(recovery), recovery2.signPub), recovery), 3, /already/);
  await rejectedAt(await forged(log, "recover", recoverBody(carol, carol.signPub), recovery), 3, /already/);
  await rejectedAt(await forged(log, "recover", recoverBody(bob, recovery2.signPub), recovery), 3, /already/);
  await rejectedAt(await forged(log, "recover", recoverBody(carol, bob.signPub), recovery), 3, /already/);
  const after = await append(log, recoverOf(carol, recovery2.signPub), recovery);
  await rejectedAt(await forged(after, "recover", recoverBody(dave, recovery.signPub), recovery2), 4, /already/);
  await rejectedAt(await forged(after, "add", bodyOf(addOf(recoveryAsDevice(recovery))), alice), 4, /already/);
});

// --- client expiry ---

test("a client is gone at 30 days by the verifier's clock, and that is not a log error", async () => {
  const log = await base();
  const at = async (now) => (await verifyLog(log, { now })).devices.has(web.signPub);
  assert.equal(await at(T0), true);
  assert.equal(await at(T0 + THIRTY_DAYS - 1), true);
  assert.equal(await at(T0 + THIRTY_DAYS), false);
  assert.equal(await at(T0 + 10 * THIRTY_DAYS), false);
  const later = await verifyLog(log, { now: T0 + THIRTY_DAYS });
  assert.equal(later.version, 3);
  assert.equal(later.head, (await verifyLog(log, opts)).head);
});

test("a full device never expires", async () => {
  const state = await verifyLog(await base(), { now: T0 + 100 * THIRTY_DAYS });
  assert.ok(state.devices.has(alice.signPub));
  assert.ok(state.devices.has(bob.signPub));
});

test("now is required: a verifier with no clock does not get immortal clients", async () => {
  const log = await base();
  for (const bad of [undefined, {}, { now: NaN }, { now: Infinity }, { now: "1" }, { now: null }]) {
    await assert.rejects(verifyLog(log, bad), LogError, JSON.stringify(bad));
  }
});

test("addedAt cannot be moved: it is under the approver's signature", async () => {
  await rejectedAt(withLast(await base(), (e) => ({ ...e, body: { ...e.body, addedAt: T0 + THIRTY_DAYS } })), 2, /signature/);
});

test("validity never depends on timestamps: they may go backwards, and any clock accepts the same log", async () => {
  let log = await created();
  log = await append(log, addOf(bob, "full", T0), alice);
  log = await append(log, addOf(carol, "full", T0 - 10 * DAY), bob);
  log = await append(log, addOf(dave, "full", 0), carol);
  log = await append(log, recoverOf(await newDeviceKeys(), recovery2.signPub, 1), recovery);
  const head = (await verifyLog(log, opts)).head;
  for (const now of [0, T0, T0 * 1000]) {
    const state = await verifyLog(log, { now });
    assert.equal(state.head, head);
    assert.ok(state.devices.has(dave.signPub), "a full device's old timestamp changes nothing");
  }
});

test("an expired client is still known: it can be removed, it cannot sign, it cannot be added again", async () => {
  const log = await base();
  const now = T0 + THIRTY_DAYS * 2;
  const gone = await append(log, removeOf(web), alice);
  assert.equal((await verifyLog(gone, { now })).version, 4);
  const again = await forged(log, "add", bodyOf(addOf(web, "client", now)), alice);
  await assert.rejects(verifyLog(again, { now }), /already/);
  const signed = await forged(log, "add", bodyOf(addOf(carol)), web);
  await assert.rejects(verifyLog(signed, { now }), /client/);
});

test("a client added with an old timestamp is simply already expired", async () => {
  const log = await append(await created(), addOf(web, "client", T0 - THIRTY_DAYS), alice);
  const state = await verifyLog(log, opts);
  assert.equal(state.version, 2);
  assert.equal(state.devices.has(web.signPub), false);
});

// --- duplicate keys ---

test("a key can only join once", async () => {
  const log = await base();
  await rejectedAt(await forged(log, "add", bodyOf(addOf(bob)), alice), 3, /already/);
  await rejectedAt(await forged(log, "add", bodyOf(addOf(alice)), alice), 3, /already/);
  await rejectedAt(await forged(log, "add", bodyOf(addOf(recoveryAsDevice(recovery))), alice), 3, /already/);
  await rejectedAt(await forged(log, "add", { ...bodyOf(addOf(carol)), boxPub: bob.boxPub }, alice), 3, /already/);
  await assert.rejects(createLog({ device: named(alice), recoveryPub: alice.signPub }), /already/);
});

test("the same key in another spelling is not another key", async () => {
  const log = await base();
  // 32 bytes leave two unused bits in the last base64 character. atob ignores them; the log must not.
  const bytes = fromB64(bob.signPub);
  const canonical = toB64(bytes);
  const last = canonical[42];
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const respelled = canonical.slice(0, 42) + alphabet[alphabet.indexOf(last) + 1] + "=";
  const entry = { ...overJson(log.at(-1)), index: 3, prev: await entryHash(log.at(-1)), signer: alice.signPub, type: "add", body: { ...bodyOf(addOf(bob)), signPub: respelled }, sig: toB64(new Uint8Array(64)) };
  await rejectedAt([...log, entry], 3, /signPub/);
  await rejectedAt([...log, { ...entry, body: { ...entry.body, signPub: canonical.slice(0, 43) } }], 3, /signPub/);
  await rejectedAt([...log, { ...entry, body: { ...entry.body, signPub: ` ${canonical}` } }], 3, /signPub/);
});

// --- shape: nothing unsigned rides along ---

test("an unknown field anywhere is refused, so nothing rides along unsigned", async () => {
  const log = await base();
  await rejectedAt(withLast(log, (e) => ({ ...e, note: "x" })), 2, /fields/);
  await rejectedAt(withLast(log, (e) => ({ ...e, body: { ...e.body, note: "x" } })), 2, /fields/);
  await rejectedAt(withLast(log, (e) => JSON.parse(JSON.stringify(e).replace(/^\{/, '{"__proto__":{"role":"full"},'))), 2, /fields/);
  await rejectedAt(withLast(log, ({ sig, ...e }) => e), 2, /fields/);
  await rejectedAt(withLast(log, ({ body: { name, ...body }, ...e }) => ({ ...e, body })), 2, /fields/);
  await rejectedAt(withLast(log, ({ body: { name, ...body }, ...e }) => ({ ...e, body: { ...body, note: name } })), 2, /fields/);
  await rejectedAt(withLast(log, ({ sig, ...e }) => ({ ...e, note: sig })), 2, /fields/);
});

test("malformed entries are refused with a LogError naming them", async () => {
  const log = await base();
  const last = overJson(log.at(-1));
  for (const bad of [null, 7, "x", [], {}, { ...last, body: null }, { ...last, body: [] }]) {
    await rejectedAt([...log.slice(0, -1), bad], 2, /fields/);
  }
  for (const [field, values] of Object.entries({
    type: ["constructor", "__proto__", 1], index: ["2", 2.5, -1], prev: [5, "x"], signer: ["x"], sig: ["x", toB64(new Uint8Array(63)), 1],
  })) {
    for (const value of values) await rejectedAt([...log.slice(0, -1), { ...last, [field]: value }], 2, new RegExp(field));
  }
  for (const [field, values] of Object.entries({
    name: ["", 5, "x".repeat(129)], kind: ["", "x".repeat(33)], addedAt: [-1, 1.5, "1", 2 ** 53, null],
    boxPub: [toB64(new Uint8Array(31))], signPub: [toB64(new Uint8Array(33))], role: [1],
  })) {
    for (const value of values) await rejectedAt([...log.slice(0, -1), { ...last, body: { ...last.body, [field]: value } }], 2, new RegExp(field));
  }
  await assert.rejects(verifyLog("not a list", opts), LogError);
  await assert.rejects(verifyLog(null, opts), LogError);
});

test("text that cannot be encoded one way is refused: two lone surrogates would sign alike", async () => {
  const log = await base();
  const sneaky = await forged(log, "add", { ...bodyOf(addOf(carol)), name: "x\ud800" }, alice).catch((e) => e);
  assert.ok(sneaky instanceof LogError);
  await rejectedAt(withLast(log, (e) => ({ ...e, body: { ...e.body, name: "x\ud800" } })), 2, /name/);
  await rejectedAt(withLast(log, (e) => ({ ...e, body: { ...e.body, kind: "\udc00" } })), 2, /kind/);
});

test("a log over the maximum is refused, naming the first entry past it, before any checking", async () => {
  const entry = (await created())[0];
  await assert.rejects(verifyLog(new Array(MAX_LOG_ENTRIES + 1).fill(entry), opts), (e) => {
    assert.ok(e instanceof LogError);
    assert.equal(e.index, MAX_LOG_ENTRIES);
    assert.match(e.message, /too many/);
    return true;
  });
  await rejectedAt(new Array(MAX_LOG_ENTRIES).fill(entry), 1, /position/);
});

test("a log of exactly the maximum verifies, and nothing can be appended to it", async () => {
  let log = await created();
  const randomKey = () => toB64(globalThis.crypto.getRandomValues(new Uint8Array(32)));
  while (log.length < MAX_LOG_ENTRIES) {
    log = await forgedOnto(log, "add", { ...bodyOf(addOf(alice)), signPub: randomKey(), boxPub: randomKey() }, alice);
  }
  assert.equal((await verifyLog(log, opts)).version, MAX_LOG_ENTRIES);
  await assert.rejects(append(log, addOf(bob), alice), (e) => e instanceof LogError && e.index === MAX_LOG_ENTRIES && /too many/.test(e.message));
});

// --- comparing logs ---

test("compareLogs: same, newer each way, also across JSON", async () => {
  const short = await base();
  const long = await append(short, removeOf(web), alice);
  assert.equal(await compareLogs(short, short), "same");
  assert.equal(await compareLogs(short, overJson(short)), "same");
  assert.equal(await compareLogs(long, short), "a-newer");
  assert.equal(await compareLogs(short, long), "b-newer");
});

test("compareLogs: two valid entries at one position are a fork", async () => {
  const shared = await base();
  const one = await append(shared, addOf(carol), alice);
  const two = await append(shared, addOf(dave), alice);
  assert.equal(await compareLogs(one, two), "fork");
  const twoLonger = await append(two, removeOf(web), alice);
  assert.equal(await compareLogs(one, twoLonger), "fork", "a longer log that disagrees earlier is a fork, not newer");
  assert.equal(await compareLogs(twoLonger, one), "fork");
});

test("compareLogs: another account's log is a fork at position 0", async () => {
  assert.equal(await compareLogs(await created(), await created()), "fork");
});

test("compareLogs: a log that does not verify is an error, never newer and never a fork", async () => {
  const log = await base();
  const longer = await forged(log, "add", bodyOf(addOf(carol)), carol);
  await assert.rejects(compareLogs(log, longer), (e) => e instanceof LogError && e.index === 3);
  await assert.rejects(compareLogs(longer, log), (e) => e instanceof LogError && e.index === 3);
  const garbage = withLast(log, (e) => ({ ...e, sig: toB64(new Uint8Array(64)) }));
  await assert.rejects(compareLogs(log, garbage), LogError);
});

test("LogError: has its name and index", async () => {
  const error = await verifyLog([], opts).catch((e) => e);
  assert.equal(error.name, "LogError");
  assert.ok(error instanceof Error);
  assert.equal(error.index, 0);
});
