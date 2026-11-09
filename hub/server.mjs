// The hub: accounts, device logs, and routing of encrypted frames between one person's devices.
// Design: docs/superpowers/specs/2026-11-02-omni-accounts-remote-design.md, sections 1 to 6.
//
// It decides who may talk to whom, and nothing else. Clients verify the log and the channel for themselves.
//
// Runs on Node 20.19 with built-ins only. Deploy together: hub/server.mjs, hub/ws.mjs, hub/store.mjs, hub/static.mjs and the
// web page's files, keeping that hub/ and ui/ layout: hub/deploy.sh has the list. The page's headers and files are in hub/static.mjs.
//
// For clients:
// - Connect straight after /api/login. A session that has not proved its key on a socket shows no approval card, is
//   replaced by the next login with that key, and is gone after 10 minutes.
// - A proof is sign(key, utf8(`${domain} ${origin} ${nonce}`)), where origin is the hub's own configured origin and
//   nonce comes from auth.challenge: domain omni-hub-auth-v1 with the device key, omni-hub-recovery-v1 with the recovery key.
// - WebSocket errors are {type: "error", code, for?, to?, reason?}:
//     forbidden          this session may not do that
//     unreachable        offline, unknown or another account's device: deliberately the same
//     busy               the receiver is not reading, or the hub is at its limit of password checks: try again later
//     invalid-entry      the entry is malformed, does not follow the head, or does not verify
//     bad-message        not JSON, or a field has the wrong type or shape
//     unknown            no such message type
//     not-found          pending.deny: no such pending sign-in on this account
//     wrong-credentials  password.change: the current loginKey is wrong
//     locked             password.change: too many failures, as for login
//     conflict           password.change: another device changed the password first
//     too-many-devices   log.append: the account is at its limit of devices. A recovery is never refused for this
//     log-full           log.append: the account's log is at its limit of entries. A recovery is never refused for this
//     too-many-invites   invite.create: at the limit of live invites
//     internal           the hub could not save; nothing changed
// - Close codes: 4401 no valid token or proof, or a timeout; 4403 no longer on the log; 4408 pending expired;
//   4409 replaced by a newer socket or sign-in of this device; 4410 denied by a device on the account;
//   4429 too many sockets on the account; 1002, 1003, 1007, 1009 bad frames; 1008 rate or queue limit; 1011 internal.

import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { verify } from "../ui/account-core.js";
import { entryBytes, verifyLog, LogError } from "../ui/device-log.js";
import { CLOSE_POLICY, acceptUpgrade, refuseUpgrade } from "./ws.mjs";
import { openStore } from "./store.mjs";
import { loadWebFiles, serveWebFile, webHeaders } from "./static.mjs";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const KIB = 1024;
const MIB = 1024 * KIB;

const DEFAULT_LIMITS = Object.freeze({
  maxPairFailures: 5,                  // per account and address together
  maxAccountFailures: 50,              // per account from anywhere, so a botnet cannot just rotate addresses
  maxAddressFailures: 20,              // per address over all accounts; above the pair limit, so that one still decides
  loginFailureWindowMs: 15 * MINUTE,
  maxTrackedFailures: 10_000,          // made-up emails must not grow memory without end
  maxConcurrentHashes: 8,              // each scrypt holds 16 MiB and a worker thread
  maxBodyBytes: 16 * KIB,
  maxAccounts: 1000,
  maxSignupsPerAddress: 10,            // attempts to use an invite, right code or wrong, per address
  signupWindowMs: 60 * MINUTE,
  inviteLifetimeMs: 14 * DAY,
  inviteKeptMs: 30 * DAY,              // how long a used or expired invite stays on the owner's list
  maxLiveInvites: 20,
  maxDevicesPerAccount: 24,            // with maxPending, below maxSocketsPerAccount: every device can be online and still approve
  maxLogEntries: 1024,                 // adding and removing devices must not grow accounts.json without end
  maxPending: 5,                       // sign-ins not yet settled, per account
  pendingLifetimeMs: 10 * MINUTE,
  sessionLifetimeMs: 180 * DAY,        // rolling: renewed each time a device connects
  maxSockets: 2048,
  maxSocketsPerAccount: 32,
  maxUnauthPerIp: 16,
  authTimeoutMs: 10_000,
  maxMessageBytes: 1 * MIB,
  maxUnauthMessageBytes: 4 * KIB,
  maxFramesPerSecond: 500,
  maxQueuedBytes: 16 * MIB,            // per socket, while a slow message such as log.append is in hand
  maxBuffered: 8 * MIB,                // per socket: unread output before senders are told it is busy
  pingIntervalMs: 30_000,
  trustRecheckMs: 5000,                // how late a client past its 30 days can be noticed
  headersTimeoutMs: 10_000,
  requestTimeoutMs: 15_000,
  keepAliveTimeoutMs: 5000,
  tlsHandshakeTimeoutMs: 10_000,
  maxHeaderBytes: 8 * KIB,
  maxConnections: 4096,
  maxConnectionsPerIp: 64,
});

const SWEEP_MS = 1000;
const SALT_BYTES = 16;
const KEY_BYTES = 32;
const MAX_EMAIL = 254, MAX_NAME = 128, MAX_KIND = 32;
const MIN_BOOTSTRAP_TOKEN = 16, MAX_BOOTSTRAP_TOKEN = 256;
const MAX_INVITE_CODE = 64;
// No 0/O or 1/I/L: a code gets read out over a phone. 16 of these 31 letters are over 79 bits, so it needs no slow hash.
const INVITE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const INVITE_LENGTH = 16;

// The login verifier. loginKey is already the output of a slow scrypt on the client.
const VERIFIER_SCRYPT = { N: 2 ** 14, r: 8, p: 1 };
const VERIFIER_BYTES = 32;

const FAKE_SALT_DOMAIN = "omni-hub-fake-salt-v1";
const AUTH_DOMAIN = "omni-hub-auth-v1";
const RECOVERY_DOMAIN = "omni-hub-recovery-v1";

const CLOSE_UNAUTHORIZED = 4401;    // no valid token or proof
const CLOSE_REMOVED = 4403;         // no longer on the log: removed, or a client past its 30 days
const CLOSE_PENDING_EXPIRED = 4408;
const CLOSE_REPLACED = 4409;        // a newer sign-in or socket of this device took over
const CLOSE_DENIED = 4410;          // a full device on the account refused this sign-in
const CLOSE_TOO_MANY = 4429;
const CLOSE_INTERNAL = 1011;

class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
  }
}

const isB64Of = (text, length) => {
  if (typeof text !== "string" || text.length !== Math.ceil(length / 3) * 4) return false;
  const bytes = Buffer.from(text, "base64");
  return bytes.length === length && bytes.toString("base64") === text;
};

const hashToken = (token) => createHash("sha256").update(token).digest("base64");
const ipOf = (socket) => (socket.remoteAddress ?? "").replace(/^::ffff:/, "");
const sha256 = (text) => createHash("sha256").update(text).digest();

const deriveVerifier = (loginKey, salt) => new Promise((resolve, reject) => {
  scrypt(loginKey, salt, VERIFIER_BYTES, VERIFIER_SCRYPT, (error, hash) => (error ? reject(error) : resolve(hash)));
});

function newInviteCode() {
  let code = "";
  while (code.length < INVITE_LENGTH) {
    for (const byte of randomBytes(INVITE_LENGTH * 2)) {
      // Taken only from whole multiples of the alphabet's size, so that no letter comes up more often.
      if (byte < 248 && code.length < INVITE_LENGTH) code += INVITE_ALPHABET[byte % INVITE_ALPHABET.length];
    }
  }
  return code;
}

const groupInviteCode = (code) => code.replace(/(.{4})(?=.)/g, "$1-");

/** What was typed, as it is hashed: any case, with or without spaces and dashes. */
const bareInviteCode = (value) => value.toUpperCase().replace(/[\s-]/g, "");
const inviteHash = (bare) => createHash("sha256").update(bare).digest("base64");

function cleanEmail(value) {
  if (typeof value !== "string") throw new HttpError(400, "bad-email");
  const email = value.normalize("NFKC").trim().toLowerCase();
  if (email.length > MAX_EMAIL || !/^[^\s@\p{Cc}]+@[^\s@\p{Cc}]+$/u.test(email) || !email.isWellFormed()) throw new HttpError(400, "bad-email");
  return email;
}

function optionalLabel(value, max) {
  if (value === undefined) return "";
  if (typeof value !== "string" || value.length > max || !value.isWellFormed()) throw new HttpError(400, "bad-label");
  return value;
}

/** Counts failures per key in a sliding window, for a bounded number of keys. */
class FailureLog {
  #entries = new Map();

  constructor({ loginFailureWindowMs, maxTrackedFailures }, now) {
    this.windowMs = loginFailureWindowMs;
    this.maxKeys = maxTrackedFailures;
    this.now = now;
  }

  #recent(key) {
    const cutoff = this.now() - this.windowMs;
    return (this.#entries.get(key) ?? []).filter((t) => t > cutoff);
  }

  locked(key, max) { return this.#recent(key).length >= max; }

  add(key) {
    const times = [...this.#recent(key), this.now()];
    this.#entries.delete(key);
    this.#entries.set(key, times);
    if (this.#entries.size > this.maxKeys) this.#entries.delete(this.#entries.keys().next().value);
  }

  /** Takes back one failure counted in advance. */
  undo(key) {
    const times = this.#entries.get(key);
    if (!times) return;
    times.pop();
    if (times.length === 0) this.#entries.delete(key);
  }

  prune() {
    for (const key of [...this.#entries.keys()]) {
      const times = this.#recent(key);
      if (times.length === 0) this.#entries.delete(key);
      else this.#entries.set(key, times);
    }
  }
}

/**
 * Starts a hub. Options: port, dataDir, tls ({cert, key}, without it the hub only listens on loopback), host, origin
 * (the hub's own browser origin, also bound into every proof), origins (more exact origins allowed to connect, for the
 * iPhone app), webRoot (the folder of the web page's files, ui/ by default), bootstrapToken (opens the first registration, once), hstsMaxAge
 * (seconds of Strict-Transport-Security, TLS only, off by default: a browser applies it to every port of the name, so
 * it also turns plain sites on other ports of that name into failures), now, log(line), sweepMs, limits (overrides of DEFAULT_LIMITS).
 * Rejects with a StoreError if the data dir is damaged.
 */
export async function startHub({ port = 0, dataDir, tls = null, host, origin = null, origins = [], webRoot, bootstrapToken = null, hstsMaxAge = null, now = Date.now, log = (line) => console.error(line), sweepMs = SWEEP_MS, limits: limitOverrides = {} }) {
  const limits = { ...DEFAULT_LIMITS, ...limitOverrides };
  if (bootstrapToken !== null && (typeof bootstrapToken !== "string" || bootstrapToken.length < MIN_BOOTSTRAP_TOKEN || bootstrapToken.length > MAX_BOOTSTRAP_TOKEN)) {
    throw new Error(`hub: bootstrapToken must be text of ${MIN_BOOTSTRAP_TOKEN} to ${MAX_BOOTSTRAP_TOKEN} characters`);
  }
  if (hstsMaxAge !== null && (!Number.isSafeInteger(hstsMaxAge) || hstsMaxAge < 0)) throw new Error("hub: hstsMaxAge must be a whole number of seconds");
  const securityHeaders = tls && hstsMaxAge !== null ? { "Strict-Transport-Security": `max-age=${hstsMaxAge}` } : {};
  const webFiles = loadWebFiles(webRoot);
  const pageHeaders = { ...webHeaders(origin), ...securityHeaders };
  const store = openStore(dataDir);
  // Once an account exists the token has been spent, even if the setting is still there after a restart.
  if (bootstrapToken !== null && store.accounts.size === 0) store.setBootstrapHash(sha256(bootstrapToken));
  const allowedOrigins = new Set([origin, ...origins].filter((value) => value !== null));
  const proofText = (domain, nonce) => new TextEncoder().encode(`${domain} ${origin ?? ""} ${nonce}`);
  const failures = new FailureLog(limits, now);
  const signups = new FailureLog({ loginFailureWindowMs: limits.signupWindowMs, maxTrackedFailures: limits.maxTrackedFailures }, now);
  const dummyVerifier = { salt: randomBytes(16).toString("base64"), hash: randomBytes(VERIFIER_BYTES).toString("base64") };

  /** Per account: the verified log and the sockets of its devices, by signPub. Never crosses to another account. */
  const live = new Map();
  const conns = new Set();
  const unauthByIp = new Map();
  const connectionsByIp = new Map();
  let hashesRunning = 0;

  const liveOf = (accountId) => {
    let entry = live.get(accountId);
    if (!entry) {
      entry = { trust: null, trustAt: 0, sockets: new Map() };
      live.set(accountId, entry);
    }
    return entry;
  };

  const sessionsOf = (accountId) => [...store.sessions.values()].filter((s) => s.accountId === accountId);

  // --- sessions and trust ---

  /** Returns whether the write succeeded. */
  function saveSessionQuietly(work) {
    try {
      work();
      return true;
    } catch (error) {
      log(`hub: could not save sessions: ${error.code ?? error.name}`);
      return false;
    }
  }

  function endSession(hash, closeCode, reason) {
    const session = store.sessions.get(hash);
    if (!session) return;
    saveSessionQuietly(() => store.deleteSession(hash));
    const conn = liveOf(session.accountId).sockets.get(session.signPub);
    if (conn?.hash === hash) dropConn(conn, closeCode, reason);
  }

  function dropConn(conn, closeCode, reason) {
    forgetConn(conn);
    conn.ws.close(closeCode, reason);
  }

  /** Removes the socket from routing, at once. Returns whether it was in routing. */
  function forgetConn(conn) {
    if (conn.gone) return false;
    conn.gone = true;
    clearTimeout(conn.authTimer);
    conns.delete(conn);
    leaveUnauth(conn);
    if (conn.accountId) {
      const { sockets } = liveOf(conn.accountId);
      if (sockets.get(conn.signPub) === conn) {
        sockets.delete(conn.signPub);
        return true;
      }
    }
    return false;
  }

  function leaveUnauth(conn) {
    if (!conn.countedUnauth) return;
    conn.countedUnauth = false;
    const count = (unauthByIp.get(conn.ip) ?? 1) - 1;
    if (count > 0) unauthByIp.set(conn.ip, count);
    else unauthByIp.delete(conn.ip);
  }

  const sendTo = (conn, message) => conn.ws.send(JSON.stringify(message));

  const pendingRows = (accountId) => {
    const { sockets } = liveOf(accountId);
    return sessionsOf(accountId)
      .filter((s) => !s.approved && s.proven && s.expiresAt > now())
      .map((s) => ({ id: s.id, signPub: s.signPub, name: s.name, kind: s.kind, ip: s.ip, createdAt: s.createdAt, expiresAt: s.expiresAt, online: sockets.get(s.signPub)?.hash === s.hash }));
  };

  const approvedConns = (accountId) => [...liveOf(accountId).sockets.values()].filter((conn) => store.sessions.get(conn.hash)?.approved);

  const fullConns = (accountId) => {
    const { trust } = liveOf(accountId);
    return approvedConns(accountId).filter((conn) => trust.devices.get(conn.signPub)?.role === "full");
  };

  const pushPending = (accountId) => {
    const message = { type: "pending.list", pending: pendingRows(accountId) };
    for (const conn of fullConns(accountId)) sendTo(conn, message);
  };

  const presenceOf = (accountId) => ({ type: "presence", online: approvedConns(accountId).map((conn) => conn.signPub) });

  const pushPresence = (accountId) => {
    const message = presenceOf(accountId);
    for (const conn of approvedConns(accountId)) sendTo(conn, message);
  };

  /** Brings the sessions into line with the log: off it means cut off at once, on it means approved. */
  function syncSessions(accountId) {
    const { trust, sockets } = liveOf(accountId);
    let presenceChanged = false, pendingChanged = false;
    for (const session of sessionsOf(accountId)) {
      const onLog = trust.devices.has(session.signPub);
      if (session.approved && !onLog) {
        endSession(session.hash, CLOSE_REMOVED, "no longer on the log");
        presenceChanged = true;
      } else if (!session.approved && onLog && session.proven) {
        // If this fails the session stays pending and the next sync tries again: never say approved without it.
        if (!saveSessionQuietly(() => store.putSession({ ...session, approved: true, expiresAt: now() + limits.sessionLifetimeMs }))) continue;
        const conn = sockets.get(session.signPub);
        if (conn?.hash === session.hash) {
          sendTo(conn, { type: "session.approved" });
          presenceChanged = true;
        }
        pendingChanged = true;
      }
    }
    if (pendingChanged) pushPending(accountId);
    if (presenceChanged) pushPresence(accountId);
  }

  const hasClient = (trust) => [...trust.devices.values()].some((d) => d.role === "client");

  /** A client's 30 days run out with no event to announce it, so a log with clients is looked at again now and then. */
  async function refreshTrust(accountId) {
    const entry = liveOf(accountId);
    if (!hasClient(entry.trust) || now() - entry.trustAt < limits.trustRecheckMs) return;
    const { log: entries } = store.accounts.get(accountId);
    const checkedAt = now();
    const trust = await verifyLog(entries, { now: checkedAt });
    if (store.accounts.get(accountId).log !== entries) return; // an append landed meanwhile and set it already
    entry.trust = trust;
    entry.trustAt = checkedAt;
    syncSessions(accountId);
  }

  function sweepSessions() {
    const changed = new Set();
    for (const session of [...store.sessions.values()]) {
      if (session.expiresAt > now()) continue;
      endSession(session.hash, session.approved ? CLOSE_UNAUTHORIZED : CLOSE_PENDING_EXPIRED, "expired");
      if (session.proven) changed.add(session.accountId);
    }
    for (const accountId of changed) {
      pushPending(accountId);
      pushPresence(accountId);
    }
  }

  /** Past use and past keeping. A failed write leaves them for the next sweep: nothing depends on them being gone. */
  function sweepInvites() {
    const settledAt = (invite) => invite.usedAt ?? invite.expiresAt;
    const gone = [...store.invites.values()].filter((invite) => settledAt(invite) + limits.inviteKeptMs <= now()).map((invite) => invite.hash);
    if (gone.length === 0) return;
    try {
      store.deleteInvites(gone);
    } catch (error) {
      log(`hub: could not drop old invites: ${error.code ?? error.name}`);
    }
  }

  async function sweep() {
    sweepSessions();
    for (const accountId of store.accounts.keys()) await refreshTrust(accountId);
    failures.prune();
    signups.prune();
    sweepInvites();
  }

  // Before anything is served: every stored log must verify, and sessions must agree with it.
  for (const account of store.accounts.values()) {
    let trust;
    try {
      trust = await verifyLog(account.log, { now: now() });
    } catch (error) {
      if (error instanceof LogError) throw new Error(`hub store: the device log of account ${account.id} does not verify (${error.message}). Refusing to start`);
      throw error;
    }
    const entry = liveOf(account.id);
    entry.trust = trust;
    entry.trustAt = now();
  }
  for (const accountId of store.accounts.keys()) syncSessions(accountId);
  sweepSessions();

  // --- HTTP routes ---

  function bootstrapMatches(given) {
    const stored = store.bootstrapHash;
    if (!stored || typeof given !== "string") return false;
    return timingSafeEqual(sha256(given), stored);
  }

  async function register(body, ip) {
    const email = cleanEmail(body.email);
    if (!isB64Of(body.salt, SALT_BYTES)) throw new HttpError(400, "bad-salt");
    if (!isB64Of(body.verifierInput, KEY_BYTES)) throw new HttpError(400, "bad-verifier");
    // Sign-in's counter for this address. A closed hub counts too, or the lock would show which hubs are still fresh.
    const addressKey = `ip ${ip}`;
    if (failures.locked(addressKey, limits.maxAddressFailures)) throw new HttpError(429, "locked");
    const first = store.accounts.size === 0;
    // Someone holding a code is told about their code. Everyone else hears only that this hub is closed.
    const offered = !first && typeof body.inviteCode === "string" && body.inviteCode.length <= MAX_INVITE_CODE ? bareInviteCode(body.inviteCode) : null;
    const signupKey = `signup ${ip}`;
    if (offered !== null) {
      if (signups.locked(signupKey, limits.maxSignupsPerAddress)) throw new HttpError(429, "too-many-signups");
      signups.add(signupKey); // counted before anything slow, so a burst of tries cannot all get in first
    }
    const usableInvite = () => {
      const invite = offered === null ? undefined : store.invites.get(inviteHash(offered));
      return invite && invite.usedAt === null && invite.expiresAt > now() ? invite : null;
    };
    // A fresh hub is open only to whoever holds the token, or the first stranger to find it would own it. After that, each
    // new account needs an invite from the owner.
    const refusal = () => {
      if (store.accounts.size === 0) return bootstrapMatches(body.bootstrapToken) ? null : "registration-closed";
      if (store.accounts.size >= limits.maxAccounts) return "registration-closed";
      if (offered === null) return "registration-closed";
      return usableInvite() ? null : "bad-invite";
    };
    const refused = refusal();
    if (refused) {
      failures.add(addressKey);
      throw new HttpError(403, refused);
    }
    const entries = [body.firstLogEntry];
    let trust;
    try {
      trust = await verifyLog(entries, { now: now() });
    } catch (error) {
      if (error instanceof LogError) throw new HttpError(400, "bad-log-entry");
      throw error;
    }
    if (hashesRunning >= limits.maxConcurrentHashes) throw new HttpError(503, "busy");
    hashesRunning++;
    let hash, salt = randomBytes(16);
    try {
      hash = await deriveVerifier(Buffer.from(body.verifierInput, "base64"), salt);
    } finally {
      hashesRunning--;
    }
    // Checked again here, with no await before the write: several requests can have been waiting at once, and a code is good once.
    const late = refusal();
    if (late) throw new HttpError(403, late);
    if (store.byEmail.has(email) || store.accounts.has(trust.accountId)) throw new HttpError(409, "already-registered");
    const invite = first ? null : usableInvite();
    // Spent first: a crash between the two costs a code, and the other way round would let a code be used twice.
    if (invite) store.putInvite({ ...invite, usedAt: now() });
    try {
      store.putAccount({ id: trust.accountId, email, salt: body.salt, verifier: { salt: salt.toString("base64"), hash: hash.toString("base64") }, log: entries, ...(first ? { owner: true } : {}) });
    } catch (error) {
      if (invite) store.putInvite(invite);
      throw error;
    }
    const entry = liveOf(trust.accountId);
    entry.trust = trust;
    entry.trustAt = now();
    if (first) {
      try {
        store.clearBootstrap();
      } catch (error) {
        log(`hub: could not delete the bootstrap token: ${error.code ?? error.name}`); // it opens nothing now an account exists
      }
    }
    return { status: 201, body: { ok: true } };
  }

  function salt(body) {
    const email = cleanEmail(body.email);
    const account = store.byEmail.get(email);
    if (account) return { status: 200, body: { salt: account.salt } };
    const fake = createHmac("sha256", store.secret).update(`${FAKE_SALT_DOMAIN}\0${email}`).digest().subarray(0, SALT_BYTES);
    return { status: 200, body: { salt: fake.toString("base64") } };
  }

  /**
   * The one check of a loginKey, with the lockout, for signing in and for changing the password. Returns the account and
   * the verifier it matched, or throws HttpError 429, 503 or 401. Everything here is the same for a known and an unknown email.
   */
  async function checkLoginKey(email, ip, loginKey) {
    const counters = [
      [`pair ${email} ${ip}`, limits.maxPairFailures],
      [`account ${email}`, limits.maxAccountFailures],
      [`ip ${ip}`, limits.maxAddressFailures],
    ];
    if (counters.some(([key, max]) => failures.locked(key, max))) throw new HttpError(429, "locked");
    if (hashesRunning >= limits.maxConcurrentHashes) throw new HttpError(503, "busy");
    // Counted before the hash, so guesses sent at once cannot all get in before the first one fails.
    for (const [key] of counters) failures.add(key);

    const account = store.byEmail.get(email);
    const verifier = account?.verifier ?? dummyVerifier;
    hashesRunning++;
    let hash;
    try {
      hash = await deriveVerifier(Buffer.from(loginKey, "base64"), Buffer.from(verifier.salt, "base64"));
    } finally {
      hashesRunning--;
    }
    const matches = timingSafeEqual(hash, Buffer.from(verifier.hash, "base64"));
    if (!account || !matches) throw new HttpError(401, "wrong-credentials");
    for (const [key] of counters) failures.undo(key);
    return { account, verifier };
  }

  async function login(body, ip) {
    const email = cleanEmail(body.email);
    if (!isB64Of(body.loginKey, KEY_BYTES)) throw new HttpError(400, "bad-login-key");
    if (!isB64Of(body.signPub, KEY_BYTES)) throw new HttpError(400, "bad-sign-pub");
    const name = optionalLabel(body.name, MAX_NAME);
    const kind = optionalLabel(body.kind, MAX_KIND);

    const { account } = await checkLoginKey(email, ip, body.loginKey);

    await refreshTrust(account.id);
    const { devices } = liveOf(account.id).trust;
    const onLog = devices.has(body.signPub);

    const otherPending = sessionsOf(account.id).filter((s) => !s.approved && s.signPub !== body.signPub && !devices.has(s.signPub));
    if (!onLog && otherPending.length >= limits.maxPending) throw new HttpError(429, "too-many-pending");
    // One unproved session per key. A proved one stays until the new one proves the key too, so whoever holds a
    // stolen password cannot push a device off by signing in as it.
    for (const old of sessionsOf(account.id)) {
      if (old.signPub === body.signPub && !old.proven) endSession(old.hash, CLOSE_REPLACED, "signed in again");
    }

    const token = randomBytes(32).toString("base64url");
    store.putSession({
      hash: hashToken(token), id: randomBytes(16).toString("base64url"), accountId: account.id, signPub: body.signPub, name, kind, ip,
      createdAt: now(), expiresAt: now() + limits.pendingLifetimeMs, proven: false, approved: false,
    });
    return { status: 200, body: { session: token, state: onLog ? "approved" : "pending" } };
  }

  const ROUTES = new Map([["/api/register", register], ["/api/salt", salt], ["/api/login", login]]);

  const originAllowed = (req) => req.headers.origin === undefined || allowedOrigins.has(req.headers.origin);

  function reply(res, status, body) {
    const text = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text), "Cache-Control": "no-store", ...pageHeaders });
    res.end(text);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      if (Number(req.headers["content-length"]) > limits.maxBodyBytes) {
        reject(new HttpError(413, "too-large"));
        return;
      }
      const chunks = [];
      let size = 0;
      req.on("data", (chunk) => {
        size += chunk.length;
        if (size > limits.maxBodyBytes) {
          chunks.length = 0;
          req.removeAllListeners("data");
          req.resume();
          reject(new HttpError(413, "too-large"));
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString()));
      req.on("error", reject);
    });
  }

  async function onRequest(req, res) {
    try {
      const path = req.url.split("?", 1)[0];
      if (!originAllowed(req)) throw new HttpError(403, "origin");
      if (path === "/api/health" && req.method === "GET") { reply(res, 200, {}); return; }
      if (serveWebFile(req, res, webFiles, pageHeaders)) return;
      const route = ROUTES.get(path);
      if (!route || req.method !== "POST") throw new HttpError(404, "not-found");
      if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) throw new HttpError(415, "json-only");
      const text = await readBody(req);
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        throw new HttpError(400, "bad-json");
      }
      if (typeof body !== "object" || body === null || Array.isArray(body)) throw new HttpError(400, "bad-json");
      const result = await route(body, ipOf(req.socket));
      reply(res, result.status, result.body);
    } catch (error) {
      if (error instanceof HttpError) {
        if (error.status === 413) res.setHeader("Connection", "close");
        reply(res, error.status, { error: error.message });
        return;
      }
      log(`hub: internal error on a request: ${error.code ?? error.name}`);
      if (!res.headersSent) reply(res, 500, { error: "internal" });
    }
  }

  // --- WebSocket ---

  function onUpgrade(req, socket, head) {
    socket.on("error", () => socket.destroy());
    const ip = ipOf(socket);
    if (req.url.split("?", 1)[0] !== "/ws") { refuseUpgrade(socket, 404, "Not Found"); return; }
    if (!originAllowed(req)) { refuseUpgrade(socket, 403, "Forbidden"); return; }
    if (conns.size >= limits.maxSockets) { refuseUpgrade(socket, 503, "Busy"); return; }
    if ((unauthByIp.get(ip) ?? 0) >= limits.maxUnauthPerIp) { refuseUpgrade(socket, 429, "Too Many"); return; }

    const conn = { ip, stage: "token", hash: null, accountId: null, signPub: null, nonce: null, queue: Promise.resolve(), queuedBytes: 0, gone: false, countedUnauth: true, authTimer: null, ws: null };
    const ws = acceptUpgrade(req, socket, head, {
      maxMessageBytes: limits.maxUnauthMessageBytes,
      maxFramesPerSecond: limits.maxFramesPerSecond,
      maxBuffered: 2 * limits.maxBuffered,
      pingIntervalMs: limits.pingIntervalMs,
      onMessage: (text) => enqueue(conn, text),
      onClose: () => onClosed(conn),
    });
    if (!ws) return;
    conn.ws = ws;
    conns.add(conn);
    unauthByIp.set(ip, (unauthByIp.get(ip) ?? 0) + 1);
    conn.authTimer = setTimeout(() => dropConn(conn, CLOSE_UNAUTHORIZED, "auth timeout"), limits.authTimeoutMs);
    conn.authTimer.unref();
  }

  function onClosed(conn) {
    if (!forgetConn(conn)) return;
    if (store.sessions.get(conn.hash)?.approved) pushPresence(conn.accountId);
    else pushPending(conn.accountId);
  }

  /** For a socket that is at fault, where nothing else will tell the other devices it has gone. */
  function kick(conn, closeCode, reason) {
    conn.ws.close(closeCode, reason);
    onClosed(conn);
  }

  /** One socket's messages are handled in order, and a channel depends on it. */
  function enqueue(conn, text) {
    if (conn.gone) return;
    conn.queuedBytes += text.length;
    if (conn.queuedBytes > limits.maxQueuedBytes) {
      kick(conn, CLOSE_POLICY, "too many messages");
      return;
    }
    conn.queue = conn.queue.then(() => (conn.gone ? undefined : handle(conn, text))).catch((error) => {
      log(`hub: internal error on a socket: ${error.code ?? error.name}`);
      kick(conn, CLOSE_INTERNAL, "internal");
    }).finally(() => { conn.queuedBytes -= text.length; });
  }

  function parseMessage(text) {
    try {
      const message = JSON.parse(text);
      return typeof message === "object" && message !== null && !Array.isArray(message) ? message : null;
    } catch {
      return null;
    }
  }

  async function handle(conn, text) {
    const message = parseMessage(text);
    if (conn.stage === "token") return handleToken(conn, message);
    if (conn.stage === "proof") return handleProof(conn, message);
    return handleReady(conn, message);
  }

  const shutOut = (conn) => dropConn(conn, CLOSE_UNAUTHORIZED, "unauthorized");

  function handleToken(conn, message) {
    if (message?.type !== "auth" || typeof message.session !== "string") return shutOut(conn);
    const hash = hashToken(message.session);
    const session = store.sessions.get(hash);
    if (!session || session.expiresAt <= now()) return shutOut(conn);
    conn.hash = hash;
    conn.nonce = randomBytes(32).toString("base64");
    conn.stage = "proof";
    sendTo(conn, { type: "auth.challenge", nonce: conn.nonce });
  }

  /**
   * The token came from the password, and a password can be stolen, so the socket also proves it holds the key.
   * Without this, a stolen password could sign in as any device on the log, or as a new device mid-approval.
   */
  async function handleProof(conn, message) {
    const session = store.sessions.get(conn.hash);
    if (message?.type !== "auth.proof" || !session || session.expiresAt <= now()) return shutOut(conn);
    const proved = await verify(session.signPub, proofText(AUTH_DOMAIN, conn.nonce), message.sig);
    if (!proved) return shutOut(conn);

    await refreshTrust(session.accountId);
    if (conn.gone) return;
    const current = store.sessions.get(conn.hash);
    if (!current) return shutOut(conn);
    const entry = liveOf(current.accountId);
    const previous = entry.sockets.get(current.signPub);
    if (!previous && entry.sockets.size >= limits.maxSocketsPerAccount) {
      dropConn(conn, CLOSE_TOO_MANY, "too many sockets");
      return;
    }

    const approved = entry.trust.devices.has(current.signPub);
    const settled = { ...current, proven: true, approved, expiresAt: approved ? now() + limits.sessionLifetimeMs : current.expiresAt };
    store.putSession(settled);

    // The key is proved, so this device may take over from its own older sessions and socket.
    for (const other of sessionsOf(current.accountId)) {
      if (other.signPub === current.signPub && other.hash !== current.hash) endSession(other.hash, CLOSE_REPLACED, "replaced");
    }
    const stillThere = entry.sockets.get(current.signPub);
    if (stillThere) dropConn(stillThere, CLOSE_REPLACED, "replaced");

    conn.accountId = current.accountId;
    conn.signPub = current.signPub;
    conn.stage = "ready";
    leaveUnauth(conn);
    clearTimeout(conn.authTimer);
    conn.ws.maxMessageBytes = limits.maxMessageBytes;
    entry.sockets.set(current.signPub, conn);

    sendTo(conn, { type: "auth.ok", state: approved ? "approved" : "pending", signPub: current.signPub });
    if (approved) pushPresence(current.accountId);
    else pushPending(current.accountId);
  }

  async function handleReady(conn, message) {
    const session = store.sessions.get(conn.hash);
    if (!session) return shutOut(conn);
    if (session.expiresAt <= now()) {
      endSession(conn.hash, session.approved ? CLOSE_UNAUTHORIZED : CLOSE_PENDING_EXPIRED, "expired");
      if (!session.approved) pushPending(session.accountId);
      return;
    }
    await refreshTrust(conn.accountId);
    if (conn.gone) return;
    if (message === null) return sendTo(conn, { type: "error", code: "bad-message" });
    const command = typeof message.type === "string" ? COMMANDS.get(message.type) : undefined;
    if (!command) return sendTo(conn, { type: "error", code: "unknown" });
    return command(conn, store.sessions.get(conn.hash), message);
  }

  const forbidden = (conn, type) => sendTo(conn, { type: "error", code: "forbidden", for: type });
  const isFullSession = (accountId, session) => session.approved && liveOf(accountId).trust.devices.get(session.signPub)?.role === "full";

  const currentLog = (accountId) => {
    const { trust } = liveOf(accountId);
    return { entries: store.accounts.get(accountId).log, head: trust.head, version: trust.version };
  };

  async function logGet(conn, session, message) {
    if (!session.approved) {
      // Recovery has to build on the log. The password alone must not show who is on the account, so it takes the code's key too.
      const { trust } = liveOf(conn.accountId);
      if (!await verify(trust.recoveryPub, proofText(RECOVERY_DOMAIN, conn.nonce), message.recoveryProof)) return forbidden(conn, "log.get");
    }
    sendTo(conn, { type: "log", ...currentLog(conn.accountId) });
  }

  /** The recover this pending session may append: adding itself, signed by the current recovery key. */
  async function isOwnRecover(session, entry) {
    if (entry?.type !== "recover" || entry.body?.signPub !== session.signPub) return false;
    const { trust } = liveOf(session.accountId);
    if (entry.signer !== trust.recoveryPub) return false;
    let bytes;
    try {
      bytes = entryBytes(entry, null);
    } catch (error) {
      if (error instanceof LogError) return false;
      throw error;
    }
    return verify(entry.signer, bytes, entry.sig);
  }

  /** Why this entry cannot be the next one, found without replaying the log, or null. */
  function refusalBeforeReplay(entry, trust) {
    if (entry?.index !== trust.version || entry?.prev !== trust.head) return "not the next entry";
    if (typeof entry.sig !== "string") return "no signature";
    try {
      entryBytes(entry, null);
      return null;
    } catch (error) {
      if (error instanceof LogError) return "malformed";
      throw error;
    }
  }

  async function logAppend(conn, session, { prevHead, entry }) {
    const { accountId } = conn;
    const state = liveOf(accountId);
    // A client can never sign an entry. Refused first, because a replay is costly and it could ask for one at will.
    if (session.approved && !isFullSession(accountId, session)) return forbidden(conn, "log.append");
    if (!session.approved && !await isOwnRecover(session, entry)) return forbidden(conn, "log.append");
    if (prevHead !== state.trust.head) return sendTo(conn, { type: "log.conflict", ...currentLog(accountId) });
    const refusal = refusalBeforeReplay(entry, state.trust);
    if (refusal) return sendTo(conn, { type: "error", code: "invalid-entry", for: "log.append", reason: refusal });
    // Limits on one account's share of this hub. Recovery goes through them: it is the last way back in.
    if (entry.type !== "recover") {
      if (store.accounts.get(accountId).log.length >= limits.maxLogEntries) return sendTo(conn, { type: "error", code: "log-full", for: "log.append" });
      if (entry.type === "add" && state.trust.devices.size >= limits.maxDevicesPerAccount) return sendTo(conn, { type: "error", code: "too-many-devices", for: "log.append" });
    }

    const account = store.accounts.get(accountId);
    const entries = [...account.log, entry];
    let trust;
    try {
      trust = await verifyLog(entries, { now: now() });
    } catch (error) {
      if (error instanceof LogError) return sendTo(conn, { type: "error", code: "invalid-entry", for: "log.append", reason: error.message });
      throw error;
    }

    // Others were verifying too while this one was. The first to reach here wins.
    if (store.accounts.get(accountId).log !== account.log) return sendTo(conn, { type: "log.conflict", ...currentLog(accountId) });
    try {
      // Read again: a password may have changed during the replay, and this must not put the old one back.
      store.putAccount({ ...store.accounts.get(accountId), log: entries });
    } catch (error) {
      log(`hub: could not save a log: ${error.code ?? error.name}`);
      return sendTo(conn, { type: "error", code: "internal", for: "log.append" });
    }
    state.trust = trust;
    state.trustAt = now();

    const updated = { type: "log.updated", head: trust.head, version: trust.version };
    syncSessions(accountId);
    sendTo(conn, { type: "log.ok", head: trust.head, version: trust.version });
    for (const other of approvedConns(accountId)) if (other !== conn) sendTo(other, updated);
  }

  function presence(conn, session) {
    if (!session.approved) return forbidden(conn, "presence");
    sendTo(conn, presenceOf(conn.accountId));
  }

  function pendingList(conn, session) {
    if (!session.approved) {
      // Whether anyone could approve it, so a sign-in can say so if nobody can. Someone holding the password learns only that.
      return sendTo(conn, { type: "pending.list", pending: pendingRows(conn.accountId).filter((row) => row.signPub === session.signPub), approverOnline: fullConns(conn.accountId).length > 0 });
    }
    if (!isFullSession(conn.accountId, session)) return forbidden(conn, "pending.list");
    sendTo(conn, { type: "pending.list", pending: pendingRows(conn.accountId) });
  }

  /** The socket of a device of this account whose session is still valid, or null. Other accounts cannot be named. */
  function targetOf(conn, to) {
    const target = liveOf(conn.accountId).sockets.get(to);
    if (!target) return null;
    const session = store.sessions.get(target.hash);
    return session && session.expiresAt > now() ? { target, session } : null;
  }

  function route(conn, type, message, canReach) {
    const { to, opaque } = message;
    if (typeof to !== "string" || typeof opaque !== "string") return sendTo(conn, { type: "error", code: "bad-message", for: type });
    const found = targetOf(conn, to);
    if (!found || !canReach(found.session)) return sendTo(conn, { type: "error", code: "unreachable", for: type, to });
    if (found.target.ws.bufferedAmount > limits.maxBuffered) return sendTo(conn, { type: "error", code: "busy", for: type, to });
    sendTo(found.target, { type, from: conn.signPub, opaque });
  }

  function approvalMsg(conn, session, message) {
    const isFull = (s) => isFullSession(conn.accountId, s);
    return route(conn, "approval.msg", message, (target) => (session.approved ? isFull(session) && !target.approved : isFull(target)));
  }

  function channelMsg(conn, session, message) {
    if (!session.approved) return forbidden(conn, "channel.msg");
    return route(conn, "channel.msg", message, (target) => target.approved);
  }

  function pendingDeny(conn, session, { id }) {
    if (!isFullSession(conn.accountId, session)) return forbidden(conn, "pending.deny");
    if (typeof id !== "string") return sendTo(conn, { type: "error", code: "bad-message", for: "pending.deny" });
    const target = sessionsOf(conn.accountId).find((s) => s.id === id && !s.approved && s.proven && s.expiresAt > now());
    if (!target) return sendTo(conn, { type: "error", code: "not-found", for: "pending.deny" });
    endSession(target.hash, CLOSE_DENIED, "denied by a device on this account");
    sendTo(conn, { type: "pending.denied", id });
    pushPending(conn.accountId);
  }

  /** The password only guards new sign-ins, so devices and their sessions are not touched. */
  async function passwordChange(conn, session, { currentLoginKey, salt: newSalt, verifierInput }) {
    if (!isFullSession(conn.accountId, session)) return forbidden(conn, "password.change");
    const fail = (code) => sendTo(conn, { type: "error", code, for: "password.change" });
    if (!isB64Of(currentLoginKey, KEY_BYTES) || !isB64Of(newSalt, SALT_BYTES) || !isB64Of(verifierInput, KEY_BYTES)) return fail("bad-message");

    const { email } = store.accounts.get(conn.accountId);
    let proved;
    try {
      proved = await checkLoginKey(email, conn.ip, currentLoginKey);
    } catch (error) {
      if (error instanceof HttpError) return fail(error.message);
      throw error;
    }
    if (hashesRunning >= limits.maxConcurrentHashes) return fail("busy");
    hashesRunning++;
    const verifierSalt = randomBytes(16);
    let hash;
    try {
      hash = await deriveVerifier(Buffer.from(verifierInput, "base64"), verifierSalt);
    } finally {
      hashesRunning--;
    }

    // Time has passed. The device may be gone, and the proof only counts against the password it was checked against.
    if (conn.gone || !store.sessions.get(conn.hash)) return;
    const account = store.accounts.get(conn.accountId);
    if (account.verifier !== proved.verifier) return fail("conflict");
    try {
      store.putAccount({ ...account, salt: newSalt, verifier: { salt: verifierSalt.toString("base64"), hash: hash.toString("base64") } });
    } catch (error) {
      log(`hub: could not save a password change: ${error.code ?? error.name}`);
      return fail("internal");
    }
    sendTo(conn, { type: "password.changed" });
  }

  // --- invites: only a full device of the first account. That session has proved its key, and the key is on a log it cannot forge ---

  const ownerDevice = (conn, session) => conn.accountId === store.ownerId && isFullSession(conn.accountId, session);

  const inviteState = (invite) => (invite.usedAt !== null ? "used" : invite.expiresAt <= now() ? "expired" : "live");

  function inviteList(conn, session) {
    if (!ownerDevice(conn, session)) return forbidden(conn, "invite.list");
    const invites = [...store.invites.values()].map((i) => ({ id: i.id, createdAt: i.createdAt, expiresAt: i.expiresAt, state: inviteState(i) }));
    sendTo(conn, { type: "invite.list", invites });
  }

  function inviteCreate(conn, session) {
    if (!ownerDevice(conn, session)) return forbidden(conn, "invite.create");
    const live = [...store.invites.values()].filter((i) => inviteState(i) === "live").length;
    if (live >= limits.maxLiveInvites) return sendTo(conn, { type: "error", code: "too-many-invites", for: "invite.create" });
    const code = newInviteCode();
    const invite = { id: randomBytes(12).toString("base64url"), hash: inviteHash(code), createdBy: conn.accountId, createdAt: now(), expiresAt: now() + limits.inviteLifetimeMs, usedAt: null };
    try {
      store.putInvite(invite);
    } catch (error) {
      log(`hub: could not save an invite: ${error.code ?? error.name}`);
      return sendTo(conn, { type: "error", code: "internal", for: "invite.create" });
    }
    // The only time the code exists outside the person's hands.
    sendTo(conn, { type: "invite.created", id: invite.id, code: groupInviteCode(code), createdAt: invite.createdAt, expiresAt: invite.expiresAt });
  }

  function inviteRevoke(conn, session, { id }) {
    if (!ownerDevice(conn, session)) return forbidden(conn, "invite.revoke");
    if (typeof id !== "string") return sendTo(conn, { type: "error", code: "bad-message", for: "invite.revoke" });
    const invite = [...store.invites.values()].find((i) => i.id === id);
    if (!invite) return sendTo(conn, { type: "error", code: "not-found", for: "invite.revoke" });
    try {
      store.deleteInvites([invite.hash]);
    } catch (error) {
      log(`hub: could not revoke an invite: ${error.code ?? error.name}`);
      return sendTo(conn, { type: "error", code: "internal", for: "invite.revoke" });
    }
    sendTo(conn, { type: "invite.revoked", id });
  }

  const COMMANDS = new Map([
    ["log.get", logGet],
    ["log.append", logAppend],
    ["presence", presence],
    ["pending.list", pendingList],
    ["approval.msg", approvalMsg],
    ["channel.msg", channelMsg],
    ["pending.deny", pendingDeny],
    ["password.change", passwordChange],
    ["invite.create", inviteCreate],
    ["invite.list", inviteList],
    ["invite.revoke", inviteRevoke],
  ]);

  // --- the listener ---

  const serverOptions = { maxHeaderSize: limits.maxHeaderBytes, connectionsCheckingInterval: 2000 };
  const server = tls
    ? https.createServer({ ...serverOptions, ...tls, minVersion: "TLSv1.2", handshakeTimeout: limits.tlsHandshakeTimeoutMs }, onRequest)
    : http.createServer(serverOptions, onRequest);
  server.headersTimeout = limits.headersTimeoutMs;
  server.requestTimeout = limits.requestTimeoutMs;
  server.keepAliveTimeout = limits.keepAliveTimeoutMs;
  server.maxConnections = limits.maxConnections;
  server.on("connection", (socket) => {
    const ip = ipOf(socket);
    const count = connectionsByIp.get(ip) ?? 0;
    if (count >= limits.maxConnectionsPerIp) {
      socket.destroy();
      return;
    }
    connectionsByIp.set(ip, count + 1);
    socket.once("close", () => {
      const left = connectionsByIp.get(ip) - 1;
      if (left > 0) connectionsByIp.set(ip, left);
      else connectionsByIp.delete(ip);
    });
  });
  server.on("upgrade", onUpgrade);
  server.on("clientError", (_error, socket) => socket.destroy());

  // Plain HTTP carries login keys, so without TLS it stays on this machine, whatever it was asked.
  const bindHost = tls ? host : "127.0.0.1";
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, bindHost, () => {
      server.off("error", reject);
      resolve();
    });
  });
  server.on("error", (error) => log(`hub: server error: ${error.code ?? error.name}`));

  // A sweep that replays long logs can outlast the interval.
  let sweeping = false;
  const sweeper = setInterval(() => {
    if (sweeping) return;
    sweeping = true;
    sweep().catch((error) => log(`hub: sweep failed: ${error.code ?? error.name}`)).finally(() => { sweeping = false; });
  }, sweepMs);
  sweeper.unref();

  const address = server.address();
  return {
    port: address.port,
    address: address.address,
    /** Only for what runs in this process, such as a test: no route reaches it. Returns a new code. */
    mintInvite() {
      const code = newInviteCode();
      store.putInvite({ id: randomBytes(12).toString("base64url"), hash: inviteHash(code), createdBy: store.ownerId ?? "none", createdAt: now(), expiresAt: now() + limits.inviteLifetimeMs, usedAt: null });
      return groupInviteCode(code);
    },
    async close() {
      clearInterval(sweeper);
      for (const conn of [...conns]) {
        forgetConn(conn);
        conn.ws.destroy();
      }
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      });
    },
  };
}

// --- run as a program ---

async function main() {
  const { env } = process;
  const tls = env.OMNI_HUB_CERT ? { cert: readFileSync(env.OMNI_HUB_CERT), key: readFileSync(env.OMNI_HUB_KEY) } : null;
  const hub = await startHub({
    port: Number(env.OMNI_HUB_PORT ?? 443),
    dataDir: env.OMNI_HUB_DATA ?? "/var/lib/omni-hub",
    origin: env.OMNI_HUB_ORIGIN ?? null,
    origins: (env.OMNI_HUB_EXTRA_ORIGINS ?? "").split(",").map((entry) => entry.trim()).filter(Boolean),
    bootstrapToken: env.OMNI_HUB_BOOTSTRAP_TOKEN || null,
    hstsMaxAge: env.OMNI_HUB_HSTS_MAX_AGE ? Number(env.OMNI_HUB_HSTS_MAX_AGE) : null,
    tls,
  });
  console.log(`omni-hub listening on port ${hub.port}`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (isMain) {
  main().catch((error) => {
    console.error(`omni-hub: ${error.message}`);
    process.exit(1);
  });
}
