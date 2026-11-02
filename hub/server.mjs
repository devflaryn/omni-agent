// The hub: accounts, device logs, and routing of encrypted frames between one person's devices.
// Design: docs/superpowers/specs/2026-11-02-omni-accounts-remote-design.md, sections 1 to 6.
//
// It decides who may talk to whom, and nothing else. Clients verify the log and the channel for themselves.
//
// Runs on Node 20.19 with built-ins only. Deploy together: hub/server.mjs, hub/ws.mjs, hub/store.mjs,
// ui/device-log.js, ui/account-core.js, keeping that hub/ and ui/ layout.

import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { verify } from "../ui/account-core.js";
import { entryBytes, verifyLog, LogError } from "../ui/device-log.js";
import { CLOSE_POLICY, acceptUpgrade, refuseUpgrade } from "./ws.mjs";
import { openStore } from "./store.mjs";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const KIB = 1024;
const MIB = 1024 * KIB;

const DEFAULT_LIMITS = Object.freeze({
  maxLoginFailures: 5,                 // per account, and per address
  loginFailureWindowMs: 15 * MINUTE,
  maxTrackedFailures: 10_000,          // made-up emails must not grow memory without end
  maxConcurrentHashes: 8,              // each scrypt holds 16 MiB and a worker thread
  maxBodyBytes: 16 * KIB,
  maxAccounts: 1000,
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
});

const SWEEP_MS = 1000;
const SALT_BYTES = 16;
const KEY_BYTES = 32;
const MAX_EMAIL = 254, MAX_NAME = 128, MAX_KIND = 32;

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
const proofText = (domain, nonce) => new TextEncoder().encode(`${domain} ${nonce}`);

const deriveVerifier = (loginKey, salt) => new Promise((resolve, reject) => {
  scrypt(loginKey, salt, VERIFIER_BYTES, VERIFIER_SCRYPT, (error, hash) => (error ? reject(error) : resolve(hash)));
});

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

  constructor({ maxLoginFailures, loginFailureWindowMs, maxTrackedFailures }, now) {
    this.max = maxLoginFailures;
    this.windowMs = loginFailureWindowMs;
    this.maxKeys = maxTrackedFailures;
    this.now = now;
  }

  #recent(key) {
    const cutoff = this.now() - this.windowMs;
    return (this.#entries.get(key) ?? []).filter((t) => t > cutoff);
  }

  locked(key) { return this.#recent(key).length >= this.max; }

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
 * (the one browser origin allowed), allowSignup, now, log(line), sweepMs, limits (overrides of DEFAULT_LIMITS).
 * Rejects with a StoreError if the data dir is damaged.
 */
export async function startHub({ port = 0, dataDir, tls = null, host, origin = null, allowSignup = false, now = Date.now, log = (line) => console.error(line), sweepMs = SWEEP_MS, limits: limitOverrides = {} }) {
  const limits = { ...DEFAULT_LIMITS, ...limitOverrides };
  const store = openStore(dataDir);
  const failures = new FailureLog(limits, now);
  const dummyVerifier = { salt: randomBytes(16).toString("base64"), hash: randomBytes(VERIFIER_BYTES).toString("base64") };

  /** Per account: the verified log and the sockets of its devices, by signPub. Never crosses to another account. */
  const live = new Map();
  const conns = new Set();
  const unauthByIp = new Map();
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

  function saveSessionQuietly(work) {
    try {
      work();
    } catch (error) {
      log(`hub: could not save sessions: ${error.code ?? error.name}`);
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
      .map((s) => ({ signPub: s.signPub, name: s.name, kind: s.kind, ip: s.ip, createdAt: s.createdAt, expiresAt: s.expiresAt, online: sockets.get(s.signPub)?.hash === s.hash }));
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
        saveSessionQuietly(() => store.putSession({ ...session, approved: true, expiresAt: now() + limits.sessionLifetimeMs }));
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

  async function sweep() {
    sweepSessions();
    for (const accountId of store.accounts.keys()) await refreshTrust(accountId);
    failures.prune();
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

  async function register(body) {
    const email = cleanEmail(body.email);
    if (!isB64Of(body.salt, SALT_BYTES)) throw new HttpError(400, "bad-salt");
    if (!isB64Of(body.verifierInput, KEY_BYTES)) throw new HttpError(400, "bad-verifier");
    const closed = () => (store.accounts.size > 0 && !allowSignup) || store.accounts.size >= limits.maxAccounts;
    if (closed()) throw new HttpError(403, "registration-closed");
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
    // Checked again here, with no await before the write: several requests can have been waiting at once.
    if (closed()) throw new HttpError(403, "registration-closed");
    if (store.byEmail.has(email) || store.accounts.has(trust.accountId)) throw new HttpError(409, "already-registered");
    store.putAccount({ id: trust.accountId, email, salt: body.salt, verifier: { salt: salt.toString("base64"), hash: hash.toString("base64") }, log: entries });
    const entry = liveOf(trust.accountId);
    entry.trust = trust;
    entry.trustAt = now();
    return { status: 201, body: { ok: true } };
  }

  function salt(body) {
    const email = cleanEmail(body.email);
    const account = store.byEmail.get(email);
    if (account) return { status: 200, body: { salt: account.salt } };
    const fake = createHmac("sha256", store.secret).update(`${FAKE_SALT_DOMAIN}\0${email}`).digest().subarray(0, SALT_BYTES);
    return { status: 200, body: { salt: fake.toString("base64") } };
  }

  async function login(body, ip) {
    const email = cleanEmail(body.email);
    if (!isB64Of(body.loginKey, KEY_BYTES)) throw new HttpError(400, "bad-login-key");
    if (!isB64Of(body.signPub, KEY_BYTES)) throw new HttpError(400, "bad-sign-pub");
    const name = optionalLabel(body.name, MAX_NAME);
    const kind = optionalLabel(body.kind, MAX_KIND);

    // Everything up to the answer is the same for a known and an unknown email.
    const keys = [`account ${email}`, `ip ${ip}`];
    if (keys.some((key) => failures.locked(key))) throw new HttpError(429, "locked");
    if (hashesRunning >= limits.maxConcurrentHashes) throw new HttpError(503, "busy");
    // Counted before the hash, so guesses sent at once cannot all get in before the first one fails.
    for (const key of keys) failures.add(key);

    const account = store.byEmail.get(email);
    const verifier = account?.verifier ?? dummyVerifier;
    hashesRunning++;
    let hash;
    try {
      hash = await deriveVerifier(Buffer.from(body.loginKey, "base64"), Buffer.from(verifier.salt, "base64"));
    } finally {
      hashesRunning--;
    }
    const matches = timingSafeEqual(hash, Buffer.from(verifier.hash, "base64"));
    if (!account || !matches) throw new HttpError(401, "wrong-credentials");
    for (const key of keys) failures.undo(key);

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
      hash: hashToken(token), accountId: account.id, signPub: body.signPub, name, kind, ip,
      createdAt: now(), expiresAt: now() + limits.pendingLifetimeMs, proven: false, approved: false,
    });
    return { status: 200, body: { session: token, state: onLog ? "approved" : "pending" } };
  }

  const ROUTES = new Map([["/api/register", register], ["/api/salt", salt], ["/api/login", login]]);

  const originAllowed = (req) => req.headers.origin === undefined || (origin !== null && req.headers.origin === origin);

  function reply(res, status, body) {
    const text = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text), "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
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
    pushPresence(conn.accountId);
    pushPending(conn.accountId);
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

  async function logAppend(conn, session, { prevHead, entry }) {
    const { accountId } = conn;
    if (!session.approved && !await isOwnRecover(session, entry)) return forbidden(conn, "log.append");
    const state = liveOf(accountId);
    if (prevHead !== state.trust.head) return sendTo(conn, { type: "log.conflict", ...currentLog(accountId) });

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
      store.putAccount({ ...account, log: entries });
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
      return sendTo(conn, { type: "pending.list", pending: pendingRows(conn.accountId).filter((row) => row.signPub === session.signPub) });
    }
    if (liveOf(conn.accountId).trust.devices.get(session.signPub)?.role !== "full") return forbidden(conn, "pending.list");
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
    const { trust } = liveOf(conn.accountId);
    const isFull = (s) => s.approved && trust.devices.get(s.signPub)?.role === "full";
    return route(conn, "approval.msg", message, (target) => (session.approved ? isFull(session) && !target.approved : isFull(target)));
  }

  function channelMsg(conn, session, message) {
    if (!session.approved) return forbidden(conn, "channel.msg");
    return route(conn, "channel.msg", message, (target) => target.approved);
  }

  const COMMANDS = new Map([
    ["log.get", logGet],
    ["log.append", logAppend],
    ["presence", presence],
    ["pending.list", pendingList],
    ["approval.msg", approvalMsg],
    ["channel.msg", channelMsg],
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

  const sweeper = setInterval(() => {
    sweep().catch((error) => log(`hub: sweep failed: ${error.code ?? error.name}`));
  }, sweepMs);
  sweeper.unref();

  const address = server.address();
  return {
    port: address.port,
    address: address.address,
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
    allowSignup: env.OMNI_HUB_ALLOW_SIGNUP === "1",
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
