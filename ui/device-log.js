// The device log: who is a device on the account. One file for Node 20+, browsers and iOS WKWebView.
// Design: docs/superpowers/specs/2026-11-02-omni-accounts-remote-design.md, sections 3 to 5.
//
// A log is a JSON-safe array of entries: {type, index, prev, signer, body, sig}.
//   type    create | add | remove | recover
//   index   the entry's position; prev is the hash of the entry before it ("" for create)
//   signer  the signing key; sig covers everything above and the whole body
//
// Whether a log is valid is decided by its entries alone, never by a clock, so every verifier agrees on it.
// Only the final list of devices looks at the time: a client outside its window is left out of it.

import { sign, verify, toB64, fromB64 } from "./account-core.js";

const ENTRY_DOMAIN = "omni-log-entry-v1";
const HASH_DOMAIN = "omni-log-hash-v1";

const encoder = new TextEncoder();
const { subtle } = globalThis.crypto;

const KEY_BYTES = 32;
const HASH_BYTES = 32;
const SIGNATURE_BYTES = 64;
const ACCOUNT_ID_BYTES = 32;
const MAX_NAME = 128;
const MAX_KIND = 32;
const DAY_MS = 24 * 60 * 60 * 1000;
const CLIENT_LIFETIME_MS = 30 * DAY_MS;
const CLOCK_SKEW_MS = DAY_MS;
/** The latest time a JS Date can hold. Adding the client lifetime to it is still exact. */
const MAX_ADDED_AT = 8.64e15;

/** Centuries of re-approvals. A replay checks every signature, and the log comes through the hub. */
export const MAX_LOG_ENTRIES = 4096;

const DEVICE_FIELDS = ["name", "kind", "role", "signPub", "boxPub", "addedAt"];
const ENTRY_FIELDS = ["type", "index", "prev", "signer", "body"];
const BODY_FIELDS = {
  create: ["accountId", ...DEVICE_FIELDS, "recoveryPub"],
  add: DEVICE_FIELDS,
  remove: ["signPub"],
  recover: [...DEVICE_FIELDS, "recoveryPub"],
};
const SIGNER_ROLE = { add: "full", remove: "full", recover: "recovery" };

export class LogError extends Error {
  /** `index` is the bad entry's position, or null when the fault is not in an entry. */
  constructor(index, why) {
    super(index === null ? `device log: ${why}` : `device log entry ${index}: ${why}`);
    this.name = "LogError";
    this.index = index;
  }
}

/** The core keeps its own `framed` private: the same length-prefixed encoding, so no two inputs encode the same. */
function framed(domain, ...fields) {
  const parts = [domain, ...fields].map((f) => (typeof f === "string" ? encoder.encode(f) : f));
  const out = new Uint8Array(parts.reduce((sum, part) => sum + 4 + part.length, 0));
  const view = new DataView(out.buffer);
  let at = 0;
  for (const part of parts) {
    view.setUint32(at, part.length);
    out.set(part, at + 4);
    at += 4 + part.length;
  }
  return out;
}

const sha256 = async (bytes) => new Uint8Array(await subtle.digest("SHA-256", bytes));

/** One spelling per value, so that a key can be compared as text and a hash cannot vary with how it is written. */
function canonicalB64(text, length, label, at) {
  let bytes = null;
  // Checked before decoding, since the text comes from outside and can be any size.
  if (typeof text === "string" && text.length === Math.ceil(length / 3) * 4) {
    try { bytes = fromB64(text); } catch { bytes = null; }
  }
  if (!bytes || bytes.length !== length || toB64(bytes) !== text) throw new LogError(at, `${label} is not ${length} bytes of canonical base64`);
  return bytes;
}

/** Lone surrogates are refused because encoding turns them all into one character, which two entries could share. */
function text(value, max, label, at) {
  if (typeof value !== "string" || !value || value.length > max || !value.isWellFormed()) throw new LogError(at, `${label} must be well-formed text of 1 to ${max} characters`);
  return encoder.encode(value);
}

function count(value, label, at) {
  if (!Number.isSafeInteger(value) || value < 0) throw new LogError(at, `${label} must be a whole number, not negative`);
  return encoder.encode(String(value));
}

const FIELD_ENCODERS = {
  accountId: (v, at) => canonicalB64(v, ACCOUNT_ID_BYTES, "accountId", at),
  name: (v, at) => text(v, MAX_NAME, "name", at),
  kind: (v, at) => text(v, MAX_KIND, "kind", at),
  role(v, at) {
    if (v !== "full" && v !== "client") throw new LogError(at, "role must be full or client");
    return encoder.encode(v);
  },
  signPub: (v, at) => canonicalB64(v, KEY_BYTES, "signPub", at),
  boxPub: (v, at) => canonicalB64(v, KEY_BYTES, "boxPub", at),
  addedAt(v, at) {
    if (v > MAX_ADDED_AT) throw new LogError(at, "addedAt is later than any date");
    return count(v, "addedAt", at);
  },
  recoveryPub: (v, at) => canonicalB64(v, KEY_BYTES, "recoveryPub", at),
};

/** Exactly these own keys: anything more would travel with the entry without being signed. */
function requireFields(value, fields, label, at) {
  const isRecord = typeof value === "object" && value !== null && !Array.isArray(value);
  const keys = isRecord ? Object.keys(value) : [];
  if (!isRecord || keys.length !== fields.length || !fields.every((f) => Object.hasOwn(value, f))) {
    throw new LogError(at, `${label} must have exactly the fields ${fields.join(", ")}`);
  }
}

/** The bytes an entry's signature covers. `sig` itself may be absent, since it is made from these. */
export function entryBytes(entry, at = entry?.index ?? null) {
  const { sig: _sig, ...unsigned } = entry ?? {};
  requireFields(unsigned, ENTRY_FIELDS, "an entry", at);
  const { type, index, prev, signer, body } = entry;
  if (typeof type !== "string" || !Object.hasOwn(BODY_FIELDS, type)) throw new LogError(at, "unknown entry type");
  requireFields(body, BODY_FIELDS[type], `the body of a ${type}`, at);
  return framed(
    ENTRY_DOMAIN,
    type,
    count(index, "index", at),
    prev === "" ? new Uint8Array(0) : canonicalB64(prev, HASH_BYTES, "prev", at),
    canonicalB64(signer, KEY_BYTES, "signer", at),
    ...BODY_FIELDS[type].map((field) => FIELD_ENCODERS[field](body[field], at)),
  );
}

function parseEntry(entry, at) {
  const bytes = entryBytes(entry, at);
  if (!Object.hasOwn(entry, "sig")) throw new LogError(at, `an entry must have exactly the fields ${ENTRY_FIELDS.join(", ")}, sig`);
  return { bytes, sig: canonicalB64(entry.sig, SIGNATURE_BYTES, "sig", at) };
}

const hashOf = async ({ bytes, sig }) => toB64(await sha256(framed(HASH_DOMAIN, bytes, sig)));

/** The signature is in the hash, so two differently signed entries at one position always count as a fork. */
// This relies on verifiers rejecting non-canonical signatures: otherwise a re-encoded signature would be a false fork.
export const entryHash = async (entry, at = entry?.index ?? null) => hashOf(parseEntry(entry, at));

function newState() {
  return { accountId: null, devices: new Map(), recoveryPub: null, recoveries: [], hashes: [], keys: new Set() };
}

// A key that has ever been on the log, in any field, can never join again: a removal is final, and the rule needs no clock.
// So a web page approved again after its 30 days comes back with fresh keys.
function claimKey(state, key, at) {
  if (state.keys.has(key)) throw new LogError(at, "that key has already been on this log");
  state.keys.add(key);
}

function addDevice(state, body, at) {
  claimKey(state, body.signPub, at);
  claimKey(state, body.boxPub, at);
  const device = {};
  for (const field of DEVICE_FIELDS) device[field] = body[field];
  state.devices.set(body.signPub, device);
}

function requireFullDevice(body, at) {
  if (body.role !== "full") throw new LogError(at, "this entry can only add a full device");
}

const APPLY = {
  create(state, { body, signer }, at) {
    if (signer !== body.signPub) throw new LogError(at, "a create must be signed by the device's own key");
    requireFullDevice(body, at);
    state.accountId = body.accountId;
    addDevice(state, body, at);
    claimKey(state, body.recoveryPub, at);
    state.recoveryPub = body.recoveryPub;
  },
  add(state, { body }, at) {
    addDevice(state, body, at);
  },
  remove(state, { body }, at) {
    const target = state.devices.get(body.signPub);
    if (!target) throw new LogError(at, "that key is not a device on the log");
    // A recover replacing a lost device comes before this removal, never after: every prefix of a valid log stays valid.
    if (target.role === "full" && [...state.devices.values()].filter((d) => d.role === "full").length === 1) {
      throw new LogError(at, "the last full device cannot be removed");
    }
    state.devices.delete(body.signPub);
  },
  recover(state, { body }, at) {
    requireFullDevice(body, at);
    addDevice(state, body, at);
    claimKey(state, body.recoveryPub, at);
    state.recoveryPub = body.recoveryPub;
    state.recoveries.push({ index: at, signPub: body.signPub, name: body.name, kind: body.kind, addedAt: body.addedAt });
  },
};

function requireAuthority(state, { type, signer }, at) {
  if (at === 0 || type === "create") {
    if (at !== 0) throw new LogError(at, "only the first entry can be a create");
    if (type !== "create") throw new LogError(at, "the first entry must be a create");
    return;
  }
  const want = SIGNER_ROLE[type];
  const role = signer === state.recoveryPub ? "recovery" : state.devices.get(signer)?.role;
  if (role !== want) throw new LogError(at, `a ${type} must be signed by a ${want} key, and this one is ${role ? `a ${role} key` : "not on the log"}`);
}

/** Checks one entry against everything before it and applies it. The order only decides which error is shown. */
async function applyEntry(state, entry, at) {
  const parsed = parseEntry(entry, at);
  if (entry.index !== at) throw new LogError(at, `says it is at position ${entry.index}`);
  if (entry.prev !== (state.hashes.at(-1) ?? "")) throw new LogError(at, "does not chain to the entry before it");
  requireAuthority(state, entry, at);
  if (!await verify(entry.signer, parsed.bytes, entry.sig)) throw new LogError(at, "bad signature");
  APPLY[entry.type](state, entry, at);
  state.hashes.push(await hashOf(parsed));
}

async function replay(entries) {
  if (!Array.isArray(entries)) throw new LogError(null, "not a list of entries");
  if (entries.length > MAX_LOG_ENTRIES) throw new LogError(MAX_LOG_ENTRIES, `too many entries, the maximum is ${MAX_LOG_ENTRIES}`);
  if (entries.length === 0) throw new LogError(0, "a log must start with a create");
  const state = newState();
  for (let at = 0; at < entries.length; at++) await applyEntry(state, entries[at], at);
  return state;
}

async function sealed(unsigned, signerKeys) {
  const bytes = entryBytes(unsigned);
  return { ...unsigned, sig: await sign(signerKeys.sign.privateKey, bytes) };
}

/** `device` is a newDeviceKeys() result with a `name` and a `kind`. The creator is always a full device. */
export async function createLog({ device, recoveryPub }) {
  const accountId = toB64(globalThis.crypto.getRandomValues(new Uint8Array(ACCOUNT_ID_BYTES)));
  const body = { accountId, name: device.name, kind: device.kind, role: "full", signPub: device.signPub, boxPub: device.boxPub, addedAt: Date.now(), recoveryPub };
  const entry = await sealed({ type: "create", index: 0, prev: "", signer: device.signPub, body }, device);
  await applyEntry(newState(), entry, 0);
  return [entry];
}

/**
 * Returns a new log with the entry added, or throws LogError if verifyLog would refuse the result.
 *   {type: "add", name, kind, role, signPub, boxPub, addedAt?}        signed by a full device
 *   {type: "remove", signPub}                                         signed by a full device
 *   {type: "recover", name, kind, signPub, boxPub, recoveryPub, addedAt?}   signed by the current recovery key
 * `addedAt` defaults to the signer's clock. `signerKeys` is a newDeviceKeys() or recoveryKeysFrom() result.
 */
export async function append(log, { type, ...fields }, signerKeys) {
  const state = await replay(log);
  const at = log.length;
  if (at >= MAX_LOG_ENTRIES) throw new LogError(at, `too many entries, the maximum is ${MAX_LOG_ENTRIES}`);
  if (!Object.hasOwn(SIGNER_ROLE, type)) throw new LogError(at, "append takes an add, a remove or a recover");
  const body = {
    add: () => ({ addedAt: Date.now(), ...fields }),
    remove: () => fields,
    recover: () => ({ role: "full", addedAt: Date.now(), ...fields }),
  }[type]();
  const entry = await sealed({ type, index: at, prev: state.hashes.at(-1), signer: signerKeys.signPub, body }, signerKeys);
  await applyEntry(state, entry, at);
  return [...log, entry];
}

/** A client is judged by this verifier's clock. Its window has a start too, so a fast approver clock cannot lengthen it by more than the skew. */
function isPresent(device, now) {
  return device.role !== "client" || (now >= device.addedAt - CLOCK_SKEW_MS && now < device.addedAt + CLIENT_LIFETIME_MS);
}

/** Whether a device from verifyLog is still inside its window, for checking again without a replay. */
export const deviceCurrent = isPresent;

/** When a device leaves the list by itself, in this verifier's clock, or null for a device that never does. */
export const deviceExpiresAt = (device) => (device.role === "client" ? device.addedAt + CLIENT_LIFETIME_MS : null);

/**
 * Replays a log from the start. Throws LogError naming the first bad entry.
 * `now` is this verifier's own clock and is required: without it a client would never expire.
 * Returns:
 *   devices      Map of signPub to {name, kind, role, signPub, boxPub, addedAt}, without clients outside their window.
 *                The recovery key is not a device: holding the code must not open a channel without leaving a notice.
 *   head         the last entry's hash, for handshakes and approval codes
 *   version      the number of entries
 *   accountId    the random id from the create entry
 *   recoveryPub  the current recovery key
 *   recoveries   one {index, signPub, name, kind, addedAt} per recover, for the notice every device must show
 */
export async function verifyLog(entries, opts) {
  const now = opts?.now;
  if (!Number.isFinite(now)) throw new LogError(null, "verifying needs the current time");
  const state = await replay(entries);
  const devices = new Map();
  for (const [key, device] of state.devices) {
    if (isPresent(device, now)) devices.set(key, device);
  }
  return { devices, head: state.hashes.at(-1), version: state.hashes.length, accountId: state.accountId, recoveryPub: state.recoveryPub, recoveries: state.recoveries };
}

/**
 * Returns "same", "a-newer", "b-newer", "fork" or "different-account".
 * Two logs of one account are compared by entry hash, position by position.
 * Both are verified first and a bad one throws LogError: garbage from the hub must not read as newer, or as a fork.
 */
export async function compareLogs(a, b) {
  const [stateA, stateB] = [await replay(a), await replay(b)];
  if (stateA.accountId !== stateB.accountId) return "different-account";
  const [ours, theirs] = [stateA.hashes, stateB.hashes];
  const shared = Math.min(ours.length, theirs.length);
  for (let at = 0; at < shared; at++) if (ours[at] !== theirs[at]) return "fork";
  if (ours.length === theirs.length) return "same";
  return ours.length > theirs.length ? "a-newer" : "b-newer";
}
