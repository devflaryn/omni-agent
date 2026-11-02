import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey, hkdfSync, scryptSync } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  scrypt, loginKeyFrom, newDeviceKeys, sign, verify, approverCommit, newApprovalRandom, verifyReveal, approvalCode,
  startHandshake, newRecoveryCode, recoveryKeysFrom, toB64, fromB64,
} from "../ui/account-core.js";

const utf8 = (s) => new TextEncoder().encode(s);
const hex = (b) => Buffer.from(b).toString("hex");
const flip = (bytes, i) => { const c = bytes.slice(); c[i < 0 ? c.length + i : i] ^= 1; return c; };
const flipB64 = (b64, i = 0) => toB64(flip(fromB64(b64), i));
const overJson = (v) => JSON.parse(JSON.stringify(v));

async function handshake(a, b, { aHead = "head-a", bHead = "head-b" } = {}) {
  const ha = await startHandshake({ device: a, peerPub: b.signPub, logHead: aHead });
  const hb = await startHandshake({ device: b, peerPub: a.signPub, logHead: bHead });
  const ca = await ha.finish(overJson(hb.hello));
  const cb = await hb.finish(overJson(ha.hello));
  await ca.confirm(overJson(cb.proof));
  await cb.confirm(overJson(ca.proof));
  return [ca, cb];
}
const [alice, bob, carol] = await Promise.all([newDeviceKeys(), newDeviceKeys(), newDeviceKeys()]);

test("the module loads anywhere: no imports at all, WebCrypto only", () => {
  const source = readFileSync(new URL("../ui/account-core.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /^\s*import\b|\bimport\(|\brequire\(|node:/m);
});

// --- scrypt ---

const RFC7914 = [
  { password: "", salt: "", N: 16, r: 1, p: 1, dk: "77d6576238657b203b19ca42c18a0497f16b4844e3074ae8dfdffa3fede21442fcd0069ded0948f8326a753a0fc81f17e8d3e0fb2e0d3628cf35e20c38d18906" },
  { password: "password", salt: "NaCl", N: 1024, r: 8, p: 16, dk: "fdbabe1c9d3472007856e7190d01e9fe7c6ad7cbc8237830e77376634b3731622eaf30d92e22a3886ff109279d9830dac727afb94a83ee6d8360cbdfa2cc0640" },
  { password: "pleaseletmein", salt: "SodiumChloride", N: 16384, r: 8, p: 1, dk: "7023bdcb3afd7348461c06cd81fd38ebfda8fbba904f8e3ea9b543f6545da1f2d5432955613f0fcf62d49705242a9af9e61e85dc0d651e40dfcf017b45575887" },
];

for (const v of RFC7914) {
  test(`scrypt: RFC 7914 vector N=${v.N} r=${v.r} p=${v.p}, also matching node:crypto`, async () => {
    const got = await scrypt(utf8(v.password), utf8(v.salt), { N: v.N, r: v.r, p: v.p, dkLen: 64 });
    assert.equal(hex(got), v.dk);
    assert.equal(hex(scryptSync(v.password, v.salt, 64, { N: v.N, r: v.r, p: v.p, maxmem: 2 ** 30 })), v.dk);
  });
}

test("scrypt: matches node:crypto on binary input, an odd length and several lanes", async () => {
  const password = new Uint8Array([0, 255, 1, 254, 128]), salt = new Uint8Array([9, 0, 200]);
  const got = await scrypt(password, salt, { N: 64, r: 3, p: 5, dkLen: 37 });
  assert.equal(hex(got), scryptSync(password, salt, 37, { N: 64, r: 3, p: 5 }).toString("hex"));
});

test("scrypt: refuses parameters that are not valid", async () => {
  const base = { N: 16, r: 1, p: 1, dkLen: 32 };
  for (const bad of [{ N: 15 }, { N: 1 }, { N: 0 }, { N: 16.5 }, { r: 0 }, { r: 1.5 }, { p: 0 }, { dkLen: 0 }, { r: 2 ** 15, p: 2 ** 15 }]) {
    await assert.rejects(scrypt(utf8("x"), utf8("y"), { ...base, ...bad }), /scrypt/, JSON.stringify(bad));
  }
});

test("loginKeyFrom: full-strength scrypt then HKDF with the omni-login-v1 label, the same as node:crypto computes", async () => {
  const salt = utf8("per-account-salt");
  const started = Date.now();
  const got = await loginKeyFrom("correct horse battery", salt);
  const stretched = scryptSync("correct horse battery", salt, 32, { N: 2 ** 17, r: 8, p: 1, maxmem: 2 ** 29 });
  const expected = Buffer.from(hkdfSync("sha256", stretched, new Uint8Array(0), "omni-login-v1", 32));
  assert.equal(hex(got), expected.toString("hex"));
  assert.notEqual(hex(got), stretched.toString("hex"), "the login key is not the raw scrypt output");
  assert.ok(Date.now() - started < 60_000);
});

test("loginKeyFrom: the same password typed on another platform (decomposed Unicode) gives the same key", async () => {
  const salt = utf8("s");
  assert.equal(hex(await loginKeyFrom("sifre-ğüşçö-12", salt)), hex(await loginKeyFrom("sifre-ğüşçö-12".normalize("NFD"), salt)));
});

// --- device keys and signatures ---

test("newDeviceKeys: Ed25519 and X25519 pairs, raw public keys in base64, private keys not extractable", async () => {
  const d = await newDeviceKeys();
  assert.equal(d.sign.privateKey.algorithm.name, "Ed25519");
  assert.equal(d.box.privateKey.algorithm.name, "X25519");
  assert.equal(fromB64(d.signPub).length, 32);
  assert.equal(fromB64(d.boxPub).length, 32);
  assert.equal(d.sign.privateKey.extractable, false);
  assert.equal(d.box.privateKey.extractable, false);
  await assert.rejects(crypto.subtle.exportKey("pkcs8", d.sign.privateKey));
  await assert.rejects(crypto.subtle.exportKey("pkcs8", d.box.privateKey));
  assert.notEqual(d.signPub, alice.signPub);
});

test("newDeviceKeys {extractable}: the desktop can export keys for its key file, and they still sign", async () => {
  const d = await newDeviceKeys({ extractable: true });
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", d.sign.privateKey);
  assert.ok(await crypto.subtle.exportKey("pkcs8", d.box.privateKey));
  const again = await crypto.subtle.importKey("pkcs8", pkcs8, "Ed25519", false, ["sign"]);
  assert.equal(await verify(d.signPub, utf8("m"), await sign(again, utf8("m"))), true);
});

test("sign and verify: a good signature passes; any change to message, signature or signer fails", async () => {
  const msg = utf8("log entry");
  const sig = await sign(alice.sign.privateKey, msg);
  assert.equal(await verify(alice.signPub, msg, sig), true);
  assert.equal(await verify(alice.signPub, flip(msg, 0), sig), false);
  assert.equal(await verify(alice.signPub, msg, flipB64(sig)), false);
  assert.equal(await verify(bob.signPub, msg, sig), false);
});

test("verify: returns false, not an exception, on malformed input", async () => {
  const msg = utf8("m");
  const sig = await sign(alice.sign.privateKey, msg);
  assert.equal(await verify("not base64!!", msg, sig), false);
  assert.equal(await verify(toB64(new Uint8Array(31)), msg, sig), false);
  assert.equal(await verify(alice.signPub, msg, "not base64!!"), false);
  assert.equal(await verify(alice.signPub, msg, toB64(new Uint8Array(10))), false);
});

test("sign is domain separated: its signature is not a bare Ed25519 signature on those bytes", async () => {
  const msg = utf8("any bytes at all");
  const sig = fromB64(await sign(alice.sign.privateKey, msg));
  assert.equal(await crypto.subtle.verify("Ed25519", alice.sign.publicKey, sig, msg), false);
});

// --- approval ---

const codeInput = async () => ({
  approverRandom: await newApprovalRandom(), newRandom: await newApprovalRandom(),
  approverPub: alice.signPub, newPub: bob.signPub, logHead: "head-1",
});

test("approval: commit, the new device's random, reveal; both sides reach one 6-digit code", async () => {
  const { commit, random } = await approverCommit();
  const newRandom = await newApprovalRandom(); // sent only once the commit has arrived
  assert.equal(await verifyReveal(commit, random), true);
  const onApprover = await approvalCode({ approverRandom: random, newRandom, approverPub: alice.signPub, newPub: bob.signPub, logHead: "h" });
  const onNew = await approvalCode({ approverRandom: random, newRandom, approverPub: alice.signPub, newPub: bob.signPub, logHead: "h" });
  assert.match(onApprover, /^\d{6}$/);
  assert.equal(onApprover, onNew);
});

test("approval: a committed value cannot be swapped once the other side's value has been seen", async () => {
  const { commit, random } = await approverCommit();
  assert.equal(await verifyReveal(commit, flipB64(random)), false);
  for (let tries = 0; tries < 50; tries++) assert.equal(await verifyReveal(commit, await newApprovalRandom()), false);
  assert.equal(await verifyReveal(flipB64(commit), random), false);
});

test("approval: verifyReveal says no to malformed values, and to a value of the wrong size that hashes correctly", async () => {
  const { commit, random } = await approverCommit();
  assert.equal(await verifyReveal(commit, "not base64!!"), false);
  assert.equal(await verifyReveal("not base64!!", random), false);
  assert.equal(await verifyReveal(commit, ""), false);
  const shortRandom = toB64(new Uint8Array(4));
  const shortCommit = toB64(createHash("sha256").update(frameFields("omni-approval-commit-v1", new Uint8Array(4))).digest());
  assert.equal(await verifyReveal(shortCommit, shortRandom), false);
});

test("approval: commit is the domain-separated hash of the random value", async () => {
  const { commit, random } = await approverCommit();
  assert.equal(fromB64(random).length, 32);
  assert.equal(commit, toB64(createHash("sha256").update(frameFields("omni-approval-commit-v1", fromB64(random))).digest()));
  assert.notEqual(commit, toB64(createHash("sha256").update(fromB64(random)).digest()));
});

test("approval: the code changes when any one input changes, and swapping the two keys changes it too", async () => {
  // Compare on the full digest space: one 6-digit collision in a test would be luck, so several values are tried per field.
  const base = await codeInput();
  const code = await approvalCode(base);
  assert.equal(code, await approvalCode({ ...base }), "deterministic");
  const differs = async (field, variants) => {
    const codes = await Promise.all(variants.map((value) => approvalCode({ ...base, [field]: value })));
    assert.ok(codes.some((c) => c !== code), `${field} must change the code`);
  };
  await differs("approverRandom", [flipB64(base.approverRandom), flipB64(base.approverRandom, 1), flipB64(base.approverRandom, 2)]);
  await differs("newRandom", [flipB64(base.newRandom), flipB64(base.newRandom, 1), flipB64(base.newRandom, 2)]);
  await differs("approverPub", [carol.signPub, flipB64(alice.signPub), flipB64(alice.signPub, 1)]);
  await differs("newPub", [carol.signPub, flipB64(bob.signPub), flipB64(bob.signPub, 1)]);
  await differs("logHead", ["head-2", "head-3", "head-4"]);
  const swapped = await Promise.all([0, 1, 2].map(async () => {
    const b = await codeInput();
    return [await approvalCode(b), await approvalCode({ ...b, approverPub: b.newPub, newPub: b.approverPub })];
  }));
  assert.ok(swapped.some(([x, y]) => x !== y), "roles are bound to their keys");
});

test("approval: the code is the first 64 bits of the domain-separated digest of every input, mod 1e6, with leading zeros", async () => {
  const seen = [];
  for (let i = 0; i < 300; i++) {
    const b = await codeInput();
    const code = await approvalCode(b);
    const digest = createHash("sha256").update(frameFields("omni-approval-code-v1", fromB64(b.approverRandom), fromB64(b.newRandom), fromB64(b.approverPub), fromB64(b.newPub), utf8(b.logHead))).digest();
    assert.equal(code, String(digest.readBigUInt64BE(0) % 1_000_000n).padStart(6, "0"));
    assert.match(code, /^\d{6}$/);
    seen.push(code);
  }
  assert.ok(seen.some((c) => c.startsWith("0")), "codes with a leading zero keep six digits");
});

test("approval: refuses a random value or key of the wrong size and an empty log head", async () => {
  const base = await codeInput();
  for (const bad of [
    { approverRandom: toB64(new Uint8Array(4)) }, { newRandom: "" }, { newRandom: toB64(new Uint8Array(4)) },
    { approverPub: toB64(new Uint8Array(4)) }, { newPub: "not base64!!" }, { logHead: "" }, { logHead: undefined },
  ]) {
    await assert.rejects(approvalCode({ ...base, ...bad }), /approval/, JSON.stringify(Object.keys(bad)));
  }
});

// --- channel handshake ---

test("handshake: both sides end up talking, each sees the other's log head, and hellos and proofs survive JSON", async () => {
  const [ca, cb] = await handshake(alice, bob, { aHead: "head-a", bHead: "head-b" });
  assert.equal(ca.peerLogHead, "head-b");
  assert.equal(cb.peerLogHead, "head-a");
  assert.equal(hex(await cb.open(await ca.seal(utf8("from a")))), hex(utf8("from a")));
  assert.equal(hex(await ca.open(await cb.seal(utf8("from b")))), hex(utf8("from b")));
  assert.equal((await cb.open(await ca.seal(new Uint8Array(0)))).length, 0);
});

test("handshake: works whichever side starts, since neither has a fixed role", async () => {
  const [cb, ca] = await handshake(bob, alice);
  assert.equal(hex(await ca.open(await cb.seal(utf8("x")))), hex(utf8("x")));
});

test("channel: nothing moves and no log head is believed until the peer's proof has checked out", async () => {
  const ha = await startHandshake({ device: alice, peerPub: bob.signPub, logHead: "a" });
  const hb = await startHandshake({ device: bob, peerPub: alice.signPub, logHead: "b" });
  const ca = await ha.finish(hb.hello);
  const cb = await hb.finish(ha.hello);
  await assert.rejects(ca.seal(utf8("secret")), /not confirmed/);
  await assert.rejects(ca.open(new Uint8Array(40)), /not confirmed/);
  assert.throws(() => ca.peerLogHead, /not confirmed/);
  await ca.confirm(cb.proof);
  assert.equal(ca.peerLogHead, "b");
  const frame = await ca.seal(utf8("ok"));
  await assert.rejects(cb.open(frame), /not confirmed/, "bob has not confirmed alice yet");
});

test("handshake: fails when peerPub is wrong, on either side", async () => {
  const hb = await startHandshake({ device: bob, peerPub: alice.signPub, logHead: "b" });
  const expectsCarol = await startHandshake({ device: alice, peerPub: carol.signPub, logHead: "a" });
  const ca = await expectsCarol.finish(hb.hello);
  const cb = await hb.finish(expectsCarol.hello);
  await assert.rejects(ca.confirm(cb.proof), /proof/);
  await assert.rejects(cb.confirm(ca.proof), /proof/);
  await assert.rejects(ca.seal(utf8("x")), /not confirmed/, "a failed confirm leaves the channel shut");
});

test("handshake: an attacker with its own device key cannot pose as the expected peer", async () => {
  const ha = await startHandshake({ device: alice, peerPub: bob.signPub, logHead: "a" });
  const mallory = await startHandshake({ device: carol, peerPub: alice.signPub, logHead: "a" });
  const ca = await ha.finish(mallory.hello);
  const cm = await mallory.finish(ha.hello);
  await assert.rejects(ca.confirm(cm.proof), /proof/);
});

test("handshake: fails when any part of the transcript was changed in transit", async () => {
  const tamper = {
    "key share": (hello) => ({ ...hello, eph: flipB64(hello.eph) }),
    "log head": (hello) => ({ ...hello, logHead: hello.logHead + "x" }),
  };
  for (const [what, change] of Object.entries(tamper)) {
    const ha = await startHandshake({ device: alice, peerPub: bob.signPub, logHead: "a" });
    const hb = await startHandshake({ device: bob, peerPub: alice.signPub, logHead: "b" });
    const ca = await ha.finish(change(hb.hello));
    const cb = await hb.finish(ha.hello);
    await assert.rejects(ca.confirm(cb.proof), /proof/, `alice notices the changed ${what}`);
    await assert.rejects(cb.confirm(ca.proof), /proof/, `bob notices the changed ${what}`);
  }
});

test("handshake: a hub hiding a newer log cannot rewrite a log head", async () => {
  const ha = await startHandshake({ device: alice, peerPub: bob.signPub, logHead: "old" });
  const hb = await startHandshake({ device: bob, peerPub: alice.signPub, logHead: "new" });
  const ca = await ha.finish({ ...hb.hello, logHead: "old" });
  const cb = await hb.finish(ha.hello);
  await assert.rejects(ca.confirm(cb.proof), /proof/);
  assert.throws(() => ca.peerLogHead, /not confirmed/);
});

test("handshake: a hello and proof replayed from an earlier session are refused, so a stale log head cannot be replayed", async () => {
  const oldA = await startHandshake({ device: alice, peerPub: bob.signPub, logHead: "a" });
  const oldB = await startHandshake({ device: bob, peerPub: alice.signPub, logHead: "stale" });
  const oldChannelB = await oldB.finish(oldA.hello);
  await oldA.finish(oldB.hello);

  const fresh = await startHandshake({ device: alice, peerPub: bob.signPub, logHead: "a" });
  const replayedTo = await fresh.finish(oldB.hello);
  await assert.rejects(replayedTo.confirm(oldChannelB.proof), /proof/);
});

test("handshake: a proof given for one peer cannot be passed off to another, even with that peer's key share", async () => {
  const ha = await startHandshake({ device: alice, peerPub: bob.signPub, logHead: "a" });
  const hb = await startHandshake({ device: bob, peerPub: carol.signPub, logHead: "b" });
  const ca = await ha.finish(hb.hello);
  const bobThinksCarol = await hb.finish(ha.hello); // the hub hands Bob alice's hello as if it were Carol's
  await assert.rejects(ca.confirm(bobThinksCarol.proof), /proof/);
});

test("handshake: a device's own hello and proof reflected back at it are refused", async () => {
  const ha = await startHandshake({ device: alice, peerPub: bob.signPub, logHead: "a" });
  const ca = await ha.finish(ha.hello);
  await assert.rejects(ca.confirm(ca.proof), /proof/);
});

test("handshake: refuses malformed input, a low-order key share, itself as a peer, and a second finish", async () => {
  const hb = await startHandshake({ device: bob, peerPub: alice.signPub, logHead: "b" });
  const start = () => startHandshake({ device: alice, peerPub: bob.signPub, logHead: "a" });
  for (const bad of [null, {}, { eph: hb.hello.eph }, { eph: "not base64!!", logHead: "b" }, { eph: toB64(new Uint8Array(31)), logHead: "b" }, { eph: hb.hello.eph, logHead: "" }, { eph: hb.hello.eph, logHead: 7 }]) {
    await assert.rejects((await start()).finish(bad), /handshake/, JSON.stringify(bad));
  }
  await assert.rejects((await start()).finish({ eph: toB64(new Uint8Array(32)), logHead: "b" }), /handshake/, "the all-zero point gives a known shared secret");
  await assert.rejects(startHandshake({ device: alice, peerPub: alice.signPub, logHead: "a" }), /handshake/);
  const b64Letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const sameKeyOtherSpelling = alice.signPub.slice(0, 42) + b64Letters[b64Letters.indexOf(alice.signPub[42]) + 1] + "="; // the last letter's low bits are unused
  assert.equal(hex(fromB64(sameKeyOtherSpelling)), hex(fromB64(alice.signPub)));
  await assert.rejects(startHandshake({ device: alice, peerPub: sameKeyOtherSpelling, logHead: "a" }), /itself/);
  await assert.rejects(startHandshake({ device: alice, peerPub: toB64(new Uint8Array(3)), logHead: "a" }), /handshake/);
  await assert.rejects(startHandshake({ device: alice, peerPub: bob.signPub, logHead: "" }), /handshake/);
  const once = await start();
  await once.finish(hb.hello);
  await assert.rejects(once.finish(hb.hello), /handshake/, "a second finish would restart the counters on the same keys");
});

// --- channel frames ---

async function threeFrames() {
  const [ca, cb] = await handshake(alice, bob);
  const frames = [await ca.seal(utf8("one")), await ca.seal(utf8("two")), await ca.seal(utf8("three"))];
  return { ca, cb, frames };
}

test("channel: a replayed frame is refused, and the channel carries on", async () => {
  const { cb, frames: [f0, f1] } = await threeFrames();
  assert.equal(new TextDecoder().decode(await cb.open(f0)), "one");
  await assert.rejects(cb.open(f0), /order/);
  assert.equal(new TextDecoder().decode(await cb.open(f1)), "two");
  await assert.rejects(cb.open(f0), /order/);
  await assert.rejects(cb.open(f1), /order/);
});

test("channel: a reordered or skipped frame is refused; only the next expected one opens", async () => {
  const { cb, frames: [f0, f1, f2] } = await threeFrames();
  await assert.rejects(cb.open(f1), /order/);
  await assert.rejects(cb.open(f2), /order/);
  await cb.open(f0);
  await assert.rejects(cb.open(f2), /order/, "f1 was dropped");
  await cb.open(f1);
  assert.equal(new TextDecoder().decode(await cb.open(f2)), "three");
});

test("channel: two opens of one frame at the same moment cannot both succeed", async () => {
  const { cb, frames: [f0] } = await threeFrames();
  const results = await Promise.allSettled([cb.open(f0), cb.open(f0), cb.open(f0)]);
  assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected", "rejected"]);
});

test("channel: seals called together come out with their own counters, in call order", async () => {
  const [ca, cb] = await handshake(alice, bob);
  const frames = await Promise.all(["a", "b", "c", "d"].map((m) => ca.seal(utf8(m))));
  assert.equal(new Set(frames.map(hex)).size, 4);
  const got = [];
  for (const f of frames) got.push(new TextDecoder().decode(await cb.open(f)));
  assert.deepEqual(got, ["a", "b", "c", "d"]);
});

test("channel: a frame altered anywhere is refused, and does not spend the counter", async () => {
  const { cb, frames: [f0] } = await threeFrames();
  for (const at of [0, 7, 8, 10, -1]) await assert.rejects(cb.open(flip(f0, at)), /order|authentic/, `byte ${at}`);
  await assert.rejects(cb.open(f0.slice(0, 7)), /short/);
  await assert.rejects(cb.open(f0.slice(0, 20)), /short/);
  await assert.rejects(cb.open(f0.slice(0, f0.length - 1)), /authentic/);
  await assert.rejects(cb.open(new Uint8Array(0)), /short/);
  assert.equal(new TextDecoder().decode(await cb.open(f0)), "one");
});

test("channel: a later frame relabelled with the expected counter is refused", async () => {
  const { cb, frames: [, f1] } = await threeFrames();
  const relabelled = f1.slice();
  relabelled.fill(0, 0, 8);
  await assert.rejects(cb.open(relabelled), /authentic/);
});

test("channel: nothing is sent in the clear, and the same message differs frame to frame", async () => {
  const [ca] = await handshake(alice, bob);
  const secret = utf8("very secret text");
  const [f0, f1] = [await ca.seal(secret), await ca.seal(secret)];
  assert.ok(!Buffer.from(f0).includes(Buffer.from(secret)));
  assert.notEqual(hex(f0.slice(8)), hex(f1.slice(8)));
  assert.equal(f0.length, 8 + secret.length + 16);
});

test("channel: each direction has its own key, so a frame reflected at its sender is refused", async () => {
  const [ca, cb] = await handshake(alice, bob);
  const secret = utf8("same message");
  const fromA = await ca.seal(secret), fromB = await cb.seal(secret);
  assert.notEqual(hex(fromA.slice(8)), hex(fromB.slice(8)), "the same counter and message in the two directions must not match");
  await assert.rejects(ca.open(fromA), /authentic/);
  assert.equal(hex(await ca.open(fromB)), hex(secret));
});

test("channel: the two directions use different keys and different nonces, each matching the other side's opposite", async () => {
  const realImport = crypto.subtle.importKey, realEncrypt = crypto.subtle.encrypt;
  const aesKeys = [], ivs = [];
  crypto.subtle.importKey = function (format, data, algorithm, ...rest) {
    if (algorithm === "AES-GCM") aesKeys.push(hex(data));
    return realImport.call(this, format, data, algorithm, ...rest);
  };
  crypto.subtle.encrypt = function (params, ...rest) {
    ivs.push(hex(params.iv));
    return realEncrypt.call(this, params, ...rest);
  };
  try {
    const ha = await startHandshake({ device: alice, peerPub: bob.signPub, logHead: "a" });
    const hb = await startHandshake({ device: bob, peerPub: alice.signPub, logHead: "b" });
    const ca = await ha.finish(hb.hello);
    const cb = await hb.finish(ha.hello);
    await ca.confirm(cb.proof);
    await cb.confirm(ca.proof);
    const [aSend, aRecv, bSend, bRecv] = aesKeys;
    assert.equal(aesKeys.length, 4);
    assert.notEqual(aSend, aRecv);
    assert.equal(aSend, bRecv);
    assert.equal(bSend, aRecv);
    await ca.seal(utf8("x"));
    await cb.seal(utf8("x"));
    await ca.seal(utf8("x"));
    assert.equal(new Set(ivs).size, 3, "counter 0 from each side, then counter 1");
  } finally {
    crypto.subtle.importKey = realImport;
    crypto.subtle.encrypt = realEncrypt;
  }
});

test("channel: every session has fresh keys, so a frame from an earlier session is refused at the same counter", async () => {
  const [oldA] = await handshake(alice, bob);
  const [, newB] = await handshake(alice, bob);
  await assert.rejects(newB.open(await oldA.seal(utf8("old"))), /authentic/);
});

test("channel: refuses a frame from a session with another device", async () => {
  const [fromCarol] = await handshake(carol, alice);
  const [, cb] = await handshake(alice, bob);
  await assert.rejects(cb.open(await fromCarol.seal(utf8("x"))), /authentic/);
});

// --- recovery ---

test("recovery code: 128 random bits in groups for typing", () => {
  const code = newRecoveryCode();
  assert.match(code, /^[0-7][0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{5}){3}-[0-9A-HJKMNP-TV-Z]{6}$/);
  assert.notEqual(code, newRecoveryCode());
});

test("recovery keys: the same code gives the same key, however it was typed", async () => {
  const code = newRecoveryCode();
  const { signPub } = await recoveryKeysFrom(code);
  for (const typed of [code.toLowerCase(), code.replaceAll("-", " "), code.replaceAll("-", ""), `  ${code.replaceAll("-", "  ").toLowerCase()}\n`]) {
    assert.equal((await recoveryKeysFrom(typed)).signPub, signPub, typed);
  }
  assert.notEqual((await recoveryKeysFrom(newRecoveryCode())).signPub, signPub);
});

test("recovery keys: a working Ed25519 key with the same shape as a device's, not extractable", async () => {
  const keys = await recoveryKeysFrom(newRecoveryCode());
  assert.equal(keys.sign.privateKey.extractable, false);
  assert.equal(keys.sign.privateKey.algorithm.name, "Ed25519");
  await assert.rejects(crypto.subtle.exportKey("pkcs8", keys.sign.privateKey));
  const sig = await sign(keys.sign.privateKey, utf8("recover entry"));
  assert.equal(await verify(keys.signPub, utf8("recover entry"), sig), true);
});

test("recovery keys: derived by HKDF with the recovery label, as a standard Ed25519 seed, the same as node:crypto computes", async () => {
  // 128 bits of value 1, in the code's 26-character form.
  const code = "00000-00000-00000-00000-000001";
  const entropy = new Uint8Array(16); entropy[15] = 1;
  const seed = Buffer.from(hkdfSync("sha256", entropy, new Uint8Array(0), "omni-recovery-sign-v1", 32));
  const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  const pub = createPublicKey(createPrivateKey({ key: der, format: "der", type: "pkcs8" })).export({ format: "der", type: "spki" }).subarray(-32);
  assert.equal((await recoveryKeysFrom(code)).signPub, pub.toString("base64"));
});

test("recovery code: the highest value still parses; anything above 128 bits, a wrong length or a bad character is refused", async () => {
  await recoveryKeysFrom("7ZZZZ-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZZ");
  const bad = ["", "abc", "00000-00000-00000-00000-00000", "00000-00000-00000-00000-0000000", "80000-00000-00000-00000-000000", "ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZZ", "00000-00000-00000-00000-00000U", "00000-00000-00000-00000-00000!"];
  for (const code of bad) await assert.rejects(recoveryKeysFrom(code), /recovery code/, code);
});

// --- helpers ---

test("base64 helpers round trip every byte value and refuse junk", () => {
  const all = Uint8Array.from({ length: 256 }, (_, i) => i);
  assert.equal(hex(fromB64(toB64(all))), hex(all));
  assert.equal(toB64(all), Buffer.from(all).toString("base64"));
  assert.throws(() => fromB64("not base64!!"));
});

/** The module's length-prefixed encoding, restated here so that a change to it fails a test. */
function frameFields(domain, ...fields) {
  return Buffer.concat([utf8(domain), ...fields].flatMap((f) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(f.length);
    return [length, f];
  }));
}
