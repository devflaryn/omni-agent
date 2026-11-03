/**
 * This desktop's account: its keys, its copy of the device log, its connection to the hub, approvals, recovery, and the
 * encrypted channels it serves or opens. Design: docs/superpowers/specs/2026-11-02-omni-accounts-remote-design.md.
 *
 * Nothing from the hub is believed. Who is on the account comes only from a log this device replayed itself, starting
 * from one it already holds, or for a new device from the head that went into the approval code. The hub's "approved" or
 * "pending" only decide what to try next.
 *
 * Files, all in one folder (~/.omni-agent/account/ by default), readable only by this user:
 *   keys.json      the private keys, protected (DPAPI, Keychain, or file permissions alone with a warning in status())
 *   session.json   the hub session token, protected the same way
 *   recovery-code.json  a one-time recovery code, protected the same way, with its candidate log and state in one record, from
 *                  just before the hub call that makes it live until the person says they saved it. See account-recovery.mjs.
 *   state.json     email, name, phase, and a confirmed approval's head and approver (not its code). No secrets.
 *   log.json       the longest log verified so far
 *   settings.json  { allowWebAccess }
 *   alerts.json    what the person has been warned of
 *   audit.jsonl    one line per request from another device, with one older file, audit.1.jsonl
 *
 * Never logged, alerted, audited or put in an error: keys, tokens, passwords, codes. Never in state.json or alerts.json.
 */
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { approverExchange, checkPassword, fromB64, newDeviceKeys, newRecoveryCode, recoveryKeysFrom, sign, toB64, verify } from "../ui/account-core.js";
import { LogError, append, canRecover, compareLogs, createLog, deviceCurrent, deviceExpiresAt, entryHash, verifyLog } from "../ui/device-log.js";
import { HubSocket, hubPost } from "../ui/hub-socket.js";
import { ALERT_TEXT, NewDeviceApproval, addAlert, checkApprovedLog, judgeLog, signedClaimBytes } from "../ui/log-trust.js";
import { decodeOuter, encodeOuter, foreignOuter } from "../ui/channel-frames.js";
import { AccountError } from "./account-error.mjs";
import { ChannelSet } from "../ui/channel-set.js";
import { RecoveryStore } from "./account-recovery.mjs";
import { PLAIN_WARNING, defaultProtector, plainProtector, runCommand, system32 } from "./account-keys.mjs";

export { AccountError } from "./account-error.mjs";
export { handleAccountRoutes } from "./account-routes.mjs";
export { keychainProtector, plainProtector, windowsProtector } from "./account-keys.mjs";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const DEFAULT_LIMITS = Object.freeze({
  auditMaxBytes: 5 * 1024 * 1024,
  handshakeTimeoutMs: 35 * SECOND,      // longer than rpcTimeoutMs: a handshake may have to fetch the log
  reviewTimeoutMs: MINUTE,
  rpcTimeoutMs: 30 * SECOND,
  httpTimeoutMs: 20 * SECOND,
  connectTimeoutMs: 15 * SECOND,
  settleRetryMs: MINUTE,
  unsettledMs: 10 * MINUTE,             // after this a code stuck in doubt counts as contested, so the person can move on
  maxChannels: 64,
  maxChannelsPerDevice: 8,
  maxInboundBytes: 16 * 1024 * 1024,
  messagesPerSecond: 400,               // the hub closes a socket at 500 frames a second
  maxBufferedBytes: 4 * 1024 * 1024,    // what may sit in the socket before the sender waits
});
const SALT_BYTES = 16;
const MAX_PENDING_ROWS = 64;
const RECOVERY_DOMAIN = "omni-hub-recovery-v1";
const encoder = new TextEncoder();
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const clip = (value, max) => String(value ?? "").trim().slice(0, max);
const isFiniteDevice = (value) => typeof value === "string" && value.length > 0 && value.length < 4096;
const HUB_CLAIMS_REMOVED = "The hub says this device was removed from the account, and it would not show the device list. This computer's own list still has it. Sign in again to check.";
const CLOSE_SESSION_GONE = 4401, CLOSE_REMOVED = 4403, CLOSE_PENDING_EXPIRED = 4408, CLOSE_REPLACED = 4409, CLOSE_DENIED = 4410;

const SETTINGS_DAMAGED = "The saved settings could not be read, so Allow web page access is off until you choose again.";
const CONTRADICTED = "The hub's answers do not match this recovery code, so this computer cannot tell which code counts. Keep every recovery code you have until another device confirms.";
const unsettledText = (ms) => `The hub has not confirmed this recovery code in ${Math.round(ms / MINUTE)} minutes, so this computer cannot tell whether it counts. Keep every recovery code you have until another device confirms, or say you saved it to move on.`;
/** How a code held on this computer is let go of: the person's choice, never a new attempt's. */
const discardAdvice = (ms) => `To register afresh instead, say you saved that code once Omni allows it (when a hub contradicts it, or ${Math.round(ms / MINUTE)} minutes after it was sent), or sign out and forget this device.`;
const wrongPasswordText = (email, ms) => `The hub did not accept that password. This computer holds a recovery code from an earlier registration of ${email} that may have reached the hub: if it did, that code is the live one and this was the wrong password, so try it again. ${discardAdvice(ms)}`;
const LOG_NOT_SAVED = "This computer could not save its device list. It will try again the next time Omni starts: check the disk.";
// ------------------------------------------------------------------------------ the slow key

/** The core's scrypt is JavaScript and runs for seconds, so it gets its own thread: the server keeps answering meanwhile. */
function loginKeyInWorker(password, salt) {
  const code = `
    const { parentPort, workerData } = require("node:worker_threads");
    import(workerData.core).then((m) => m.loginKeyFrom(workerData.password, workerData.salt)).then((key) => parentPort.postMessage(key));
  `;
  return new Promise((resolve, reject) => {
    const worker = new Worker(code, { eval: true, workerData: { core: new URL("../ui/account-core.js", import.meta.url).href, password, salt } });
    worker.once("message", (key) => { resolve(key); worker.terminate(); });
    worker.once("error", () => reject(new Error("could not derive the login key")));
  });
}

// ------------------------------------------------------------------------------ recovery keys on the log
// Every call that puts a recovery key on a log, or decides a log may be recovered, is here and nowhere else.

const startLog = ({ device, recovery }) => createLog({ device, recovery });

const recoverOnto = (entries, device, { current, next, addedAt }) => append(entries, { type: "recover", ...device, newRecovery: next, addedAt }, current);

/** Whether a log the hub gave is one this code may recover. Asked before anything is signed for it. */
const mayRecover = (entries, recovery) => canRecover(entries, recovery.signPub);

// ------------------------------------------------------------------------------ the account

/**
 * Events: approval (the pending sign-ins), devices (the devices list), alert ({kind, message, at}), channel (a Channel from
 * another device, ready to serve), channel-closed (a Channel), status (when anything status() shows has changed).
 */
export class Account extends EventEmitter {
  #phase = "signed-out";
  #email = null;
  #name;
  #kind;
  #keys = null;
  #keyKind = null;
  #warnings = new Set();
  #session = null;
  #log = null;
  #verified = null;
  #hashes = [];
  #knownRecoveries = 0;
  #settings = { allowWebAccess: true };
  #alerts = [];
  #online = new Set();
  #rows = [];
  #reviewHints = new Map();
  #review = null;
  #exchange;              // on a new device: the approval, from log-trust.js
  #recoveryAt = null;     // the position of this device's own recover, until another device shows it holds that entry
  #approvedByHub = false;
  #links;
  #dirReady = null;
  #started = null;
  #stopped = false;
  #hub;
  #hubError = null;
  #syncing = null;
  #logLock = Promise.resolve();
  #approvalChain = Promise.resolve();
  #auditChain = Promise.resolve();
  #auditSize = null;
  #alertsWrite = Promise.resolve();
  #alertsQueued = false;
  #recovery;
  #registerAttempt = null;
  #lastHubState = null;
  #settleTimer = null;
  #hubClaimedRemoved = false;
  #protector;

  constructor({ dir, hubUrl, hubOrigin, log = () => {}, now = Date.now, name, kind = "desktop", protector, deriveLoginKey, WebSocketImpl, fetchImpl, reconnect = {}, limits = {}, verifyLogImpl = verifyLog }) {
    super();
    const url = new URL(hubUrl);
    const loopback = /^(127\.\d+\.\d+\.\d+|localhost|\[::1\])$/.test(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error("the hub must be on https, or on this machine: login keys cross this connection");
    this.dir = dir;
    this.hubUrl = url.origin;
    this.hubOrigin = hubOrigin ?? url.origin;
    this.log = log;
    this.now = now;
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.#name = clip(name, 128) || clip(hostname(), 128) || "Computer";
    this.#kind = clip(kind, 32) || "desktop";
    this.#protector = protector ?? defaultProtector(dir);
    this.deriveLoginKey = deriveLoginKey ?? loginKeyInWorker;
    this.WebSocketImpl = WebSocketImpl ?? globalThis.WebSocket;
    this.fetchImpl = fetchImpl ?? globalThis.fetch;
    this.reconnect = { minMs: reconnect.minMs ?? SECOND, maxMs: reconnect.maxMs ?? MINUTE };
    this.verifyLogImpl = verifyLogImpl;
    this.on("error", () => {});
    this.#recovery = new RecoveryStore({
      dir,
      now: () => this.now(),
      unsettledMs: this.limits.unsettledMs,
      writeSecret: (...args) => this.#writeSecret(...args),
      readSecret: (record) => this.#readSecret(record),
      writeFile: (name, text) => this.#writeFile(name, text),
      warn: (text) => this.#warnings.add(text),
    });
    this.#hub = new HubSocket({
      hubUrl: this.hubUrl,
      hubOrigin: this.hubOrigin,
      WebSocketImpl: this.WebSocketImpl,
      limits: this.limits,
      reconnect: this.reconnect,
      session: () => this.#session,
      signKey: () => this.#keys?.sign.privateKey,
      onAuthOk: (message) => { this.#onAuthOk(message); },
      onMessage: (message) => this.#dispatch(message),
      onGone: (code) => this.#onSocketGone(code),
      onConnectTimeout: () => { this.#hubError = "The hub did not answer."; },
      onChange: () => this.#changed(),
    });
    this.#exchange = new NewDeviceApproval({
      device: () => ({ keys: this.#keys, name: this.#name, kind: this.#kind }),
      send: (to, opaque) => this.#hub.sendNow({ type: "approval.msg", to, opaque }),
      changed: () => this.#changed(),
      alert: (kind, detail) => this.#alert(kind, detail),
      persist: () => { this.#persistState().catch(() => {}); },
    });
    this.#links = new ChannelSet({
      limits: this.limits,
      now: () => this.now(),
      keys: () => this.#keys,
      phase: () => this.#phase,
      connected: () => this.#hub.connected,
      verified: () => this.#verified,
      hashes: () => this.#hashes,
      allowWebAccess: () => this.#settings.allowWebAccess,
      syncLog: () => this.syncLog(),
      sendPaced: (message) => this.#hub.sendPaced(message),
      alert: (kind, detail) => this.#alert(kind, detail),
      emit: (name, ...args) => this.emit(name, ...args),
      changed: () => this.#changed(),
      peerHeadSigned: (head) => { if (this.#recoveryAt !== null && this.#hashes.indexOf(head) >= this.#recoveryAt) this.#recoveryConfirmed(); },
    });
  }

  // ---------------------------------------------------------------------------- what is shown

  status() {
    const me = this.#keys && this.#verified?.devices.get(this.#keys.signPub);
    const protection = this.#keyKind === "none" || (!this.#keyKind && this.#protector.name === "none");
    const keyProtection = { kind: this.#keyKind ?? this.#protector.name, warning: protection ? PLAIN_WARNING : null };
    return {
      signedIn: this.#phase === "approved" || this.#phase === "pending",
      phase: this.#phase,
      email: this.#email,
      accountId: this.#verified?.accountId ?? null,
      device: this.#keys ? { id: this.#keys.signPub, name: this.#name, kind: this.#kind, role: me?.role ?? null } : null,
      hub: { url: this.hubUrl, connected: this.#hub.connected, attempts: this.#hub.attempts, lastError: this.#lastError() },
      logHead: this.#hashes.at(-1) ?? null,
      logVersion: this.#hashes.length,
      pending: this.#phase === "pending" ? { code: this.#exchange.current?.code ?? null, attempts: this.#exchange.attempts, failed: this.#exchange.failed, confirmed: !!this.#exchange.current?.confirmed, approvedByHub: this.#approvedByHub } : null,
      review: this.#review ? { ...this.#reviewView() } : null,
      allowWebAccess: this.#settings.allowWebAccess,
      keyProtection,
      warnings: [...this.#warnings, ...(keyProtection.warning ? [keyProtection.warning] : [])],
      alerts: this.#alerts.slice(),
      recoveries: this.#verified?.recoveries ?? [],
      recoveryUnconfirmed: this.#recoveryAt !== null,
      recoveryCodePending: this.#recovery.pending,
      recoveryContested: this.#recovery.contested,
      channels: this.#links.all().filter((c) => c.state === "open").map((c) => ({ id: c.id, device: c.peerId, name: c.peer.name, direction: c.direction })),
      handshakes: this.#links.all().filter((c) => c.state === "handshake").length,
    };
  }

  /** What is wrong, in the person's terms: a held code's trouble, in its own true words, and the connection's, both. */
  #lastError() {
    const code = this.#recovery.contradicted ? CONTRADICTED : this.#recovery.unsettledTooLong ? unsettledText(this.limits.unsettledMs) : null;
    return [code, this.#hubError].filter(Boolean).join(" ") || null;
  }

  devices() {
    if (!this.#verified) return [];
    const now = this.now();
    return [...this.#verified.devices.values()].filter((d) => deviceCurrent(d, now)).map((d) => ({
      id: d.signPub, name: d.name, kind: d.kind, role: d.role, addedAt: d.addedAt, expiresAt: deviceExpiresAt(d), online: this.#online.has(d.signPub), self: d.signPub === this.#keys?.signPub,
    }));
  }

  pendingSignIns() {
    return this.#rows.map((row) => ({ ...row, reviewedBy: this.#review?.id === row.id ? this.#name : (this.#reviewHints.get(row.id) ?? null) }));
  }

  settings() { return { ...this.#settings }; }

  async setSettings({ allowWebAccess }) {
    if (typeof allowWebAccess !== "boolean") throw new AccountError(400, "bad-setting", "allowWebAccess must be true or false");
    this.#settings.allowWebAccess = allowWebAccess;
    await this.#writeFile("settings.json", JSON.stringify(this.#settings));
    this.#warnings.delete(SETTINGS_DAMAGED);
    if (!allowWebAccess) for (const c of this.#links.all()) if (c.peer.role === "client") c.close("web-access-off");
    this.#changed();
    return this.settings();
  }

  #changed() { this.emit("status", this.status()); }

  #alert(kind, detail) {
    const { alerts, fresh } = addAlert(this.#alerts, kind, detail, this.now());
    this.#alerts = alerts;
    this.#saveAlerts();
    if (fresh) {
      this.log(`account alert: ${kind}`);
      this.emit("alert", fresh);
    }
    this.#changed();
  }

  /** One write at a time, and only the latest matters: a flood must not turn into a flood of fsyncs. */
  #saveAlerts() {
    if (this.#alertsQueued) return;
    this.#alertsQueued = true;
    this.#alertsWrite = this.#alertsWrite.then(() => {
      this.#alertsQueued = false;
      return this.#writeFile("alerts.json", JSON.stringify(this.#alerts));
    }).catch(() => {});
  }

  async clearAlerts() {
    this.#alerts = [];
    await this.#alertsWrite;
    await this.#writeFile("alerts.json", "[]");
    this.#changed();
  }

  // ---------------------------------------------------------------------------- files

  #ensureDir() {
    this.#dirReady ??= (async () => {
      await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
      if (process.platform !== "win32") {
        await fs.chmod(this.dir, 0o700);
        return;
      }
      try {
        const out = await runCommand(system32("whoami.exe"), ["/user", "/fo", "csv", "/nh"]);
        const sid = /S-1-[\d-]+/.exec(out)?.[0];
        if (!sid) throw new Error("no SID");
        await runCommand(system32("icacls.exe"), [this.dir, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`]);
      } catch {
        this.#warnings.add("Could not restrict the account folder's permissions: other users of this computer may be able to read it.");
      }
    })();
    return this.#dirReady;
  }

  async #writeFile(name, content) {
    await this.#ensureDir();
    const file = join(this.dir, name);
    const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
    const handle = await fs.open(temp, "wx", 0o600);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.rename(temp, file);
        return;
      } catch (error) {
        // Windows refuses while something (a scanner, another read here) holds the file for a moment.
        if (attempt >= 8 || !["EPERM", "EACCES", "EBUSY"].includes(error.code)) {
          await fs.rm(temp, { force: true });
          throw error;
        }
        await sleep(20 * (attempt + 1));
      }
    }
  }

  async #readJson(name) {
    try { return JSON.parse(await fs.readFile(join(this.dir, name), "utf8")); } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async #writeSecret(name, publicFields, bytes) {
    let protector = this.#protector, data;
    try {
      data = await protector.protect(bytes);
    } catch {
      // The protected store is not working on this computer: say so, and fall back to the file's permissions alone.
      protector = plainProtector();
      data = await protector.protect(bytes);
      this.#warnings.add("The system's key store did not work, so keys are protected by file permissions alone.");
    }
    await this.#writeFile(name, JSON.stringify({ v: 1, protection: protector.name, ...publicFields, data: data.toString("base64") }));
    return protector.name;
  }

  async #readSecret(record) {
    const blob = Buffer.from(record.data, "base64");
    if (record.protection === "none") return plainProtector().unprotect(blob);
    if (record.protection !== this.#protector.name) throw new Error("protected by something this computer does not have");
    return this.#protector.unprotect(blob);
  }

  #persistState() {
    return this.#writeFile("state.json", JSON.stringify({ v: 1, email: this.#email, name: this.#name, kind: this.#kind, phase: this.#phase, exchange: this.#exchange.saved, recoveryAt: this.#recoveryAt }));
  }

  async #ensureKeys() {
    if (this.#keys) return;
    const made = await newDeviceKeys({ extractable: true });
    const [signKey, boxKey] = await Promise.all([
      globalThis.crypto.subtle.exportKey("pkcs8", made.sign.privateKey),
      globalThis.crypto.subtle.exportKey("pkcs8", made.box.privateKey),
    ]);
    const secret = Buffer.from(JSON.stringify({ sign: toB64(new Uint8Array(signKey)), box: toB64(new Uint8Array(boxKey)) }));
    this.#keyKind = await this.#writeSecret("keys.json", { signPub: made.signPub, boxPub: made.boxPub }, secret);
    this.#keys = await this.#importKeys({ sign: toB64(new Uint8Array(signKey)), box: toB64(new Uint8Array(boxKey)) }, made.signPub, made.boxPub);
  }

  /** From here on the private keys cannot be exported by this process, only used. */
  async #importKeys(secret, signPub, boxPub) {
    const { subtle } = globalThis.crypto;
    const [signKey, boxKey] = await Promise.all([
      subtle.importKey("pkcs8", fromB64(secret.sign), "Ed25519", false, ["sign"]),
      subtle.importKey("pkcs8", fromB64(secret.box), "X25519", false, ["deriveBits"]),
    ]);
    return { sign: { privateKey: signKey }, box: { privateKey: boxKey }, signPub, boxPub };
  }

  // ---------------------------------------------------------------------------- start and stop

  /** Loads what is on disk and connects if signed in. Never needed before local use, and nothing waits for the hub. */
  start() {
    this.#stopped = false;
    this.#hub.stopped = false;
    this.#started ??= this.#load().catch((error) => { this.log(`account: could not load: ${error.code ?? error.name}`); });
    return this.#started;
  }

  async #load() {
    let exists = true;
    try { await fs.access(this.dir); } catch { exists = false; }
    if (!exists) return;
    await this.#ensureDir();
    const settings = await this.#readJson("settings.json").catch(() => undefined);
    const settingsThere = await fs.access(join(this.dir, "settings.json")).then(() => true, () => false);
    if (settingsThere) {
      // A file that says nothing clear is not a yes: the switch exists for someone worried about the web page.
      const known = typeof settings?.allowWebAccess === "boolean";
      this.#settings = { allowWebAccess: known && settings.allowWebAccess };
      if (!known) this.#warnings.add(SETTINGS_DAMAGED);
    }
    const alerts = await this.#readJson("alerts.json").catch(() => undefined);
    if (await fs.access(join(this.dir, "alerts.json")).then(() => true, () => false)) {
      const rows = Array.isArray(alerts) ? alerts.filter((a) => typeof a?.kind === "string" && typeof a?.key === "string" && typeof a?.message === "string") : [];
      this.#alerts = rows;
      if (!Array.isArray(alerts) || rows.length !== alerts.length) this.#warnings.add("The saved security alerts could not be read, so some earlier alerts may be missing.");
    }
    await this.#recovery.load();
    const state = await this.#readJson("state.json").catch(() => null);
    this.#email = this.#recovery.email;
    if (state) {
      this.#email = state.email ?? this.#email;
      this.#name = state.name ?? this.#name;
      this.#recoveryAt = Number.isSafeInteger(state.recoveryAt) ? state.recoveryAt : null;
      if (state.exchange?.head) this.#exchange.resume(state.exchange);
    }
    const keyRecord = await this.#readJson("keys.json").catch(() => null);
    if (keyRecord) {
      try {
        const secret = JSON.parse(Buffer.from(await this.#readSecret(keyRecord)).toString());
        this.#keys = await this.#importKeys(secret, keyRecord.signPub, keyRecord.boxPub);
        this.#keyKind = keyRecord.protection;
      } catch {
        this.#phase = "key-unavailable";
        this.#alert("key-unavailable");
        return;
      }
    }
    const entries = await this.#readJson("log.json").catch(() => undefined);
    if (entries === undefined) {
      this.#phase = "log-damaged";
      this.#alert("bad-log", "disk");
      return;
    }
    if (entries) {
      try {
        const verified = await this.verifyLogImpl(entries, { now: this.now() });
        await this.#setLog(entries, verified);
        this.#knownRecoveries = verified.recoveries.length;
      } catch (error) {
        if (!(error instanceof LogError)) throw error;
        this.#phase = "log-damaged";
        this.#alert("bad-log", "disk");
        return;
      }
    }
    const sessionRecord = await this.#readJson("session.json").catch(() => null);
    if (sessionRecord && this.#keys) {
      try {
        this.#session = Buffer.from(await this.#readSecret(sessionRecord)).toString();
      } catch {
        this.#session = null;
      }
    }
    if (state?.phase === "denied" || state?.phase === "expired" || state?.phase === "removed") this.#phase = state.phase;
    else if (this.#session) this.#phase = this.#recovery.candidate?.kind === "recover" ? "recovering" : state?.phase === "pending" ? "pending" : "approved";
    if (this.#phase === "approved" && !this.#verified?.devices.has(this.#keys.signPub)) this.#phase = "pending";
    this.#changed();
    if (this.#session && ["approved", "pending", "recovering"].includes(this.#phase)) this.#connect();
  }

  async stop() {
    this.#stopped = true;
    this.#hub.stopped = true;
    this.#dropConnection("the app is closing");
    await this.#auditChain.catch(() => {});
    await this.#alertsWrite.catch(() => {});
  }

  #dropConnection(reason) {
    clearTimeout(this.#settleTimer);
    this.#hub.drop(new AccountError(503, "hub-unreachable", "The hub connection was lost."));
    this.#closeAllChannels(reason);
  }

  #closeAllChannels(reason) {
    for (const channel of this.#links.all()) channel.close(reason);
  }

  // ---------------------------------------------------------------------------- the hub over HTTP

  #post(path, body) {
    return hubPost({ fetchImpl: this.fetchImpl, hubUrl: this.hubUrl, timeoutMs: this.limits.httpTimeoutMs }, path, body);
  }

  async #bootstrapToken() {
    try {
      return (await fs.readFile(join(this.dir, "bootstrap-token"), "utf8")).trim() || null;
    } catch {
      return null;
    }
  }

  async #loginKey(password, salt) {
    return toB64(await this.deriveLoginKey(password, salt));
  }

  async #saltFor(email) {
    const { salt } = await this.#post("/api/salt", { email });
    try { return fromB64(salt); } catch { throw new AccountError(502, "bad-salt", "The hub gave a salt that makes no sense."); }
  }

  /** A password login, which yields a session the socket must then prove the key for. */
  async #login(email, loginKey) {
    const token = await this.#bootstrapToken();
    const { session, state } = await this.#post("/api/login", { email, loginKey, signPub: this.#keys.signPub, name: this.#name, kind: this.#kind, ...(token ? { bootstrapToken: token } : {}) });
    if (typeof session !== "string" || !session) throw new AccountError(502, "bad-login", "The hub's answer made no sense.");
    this.#email = email;
    this.#session = session;
    await this.#writeSecret("session.json", {}, Buffer.from(session));
    return state;
  }

  #requireStartable() {
    if (this.#phase === "key-unavailable") throw new AccountError(409, "key-unavailable", ALERT_TEXT["key-unavailable"]);
    if (this.#phase === "log-damaged") throw new AccountError(409, "log-damaged", "The device log on this computer is damaged. Sign out and forget this device to start over.");
    if (this.#phase === "approved" || this.#phase === "pending" || this.#phase === "recovering") throw new AccountError(409, "already-signed-in", "This computer is already signed in.");
  }

  // ---------------------------------------------------------------------------- registering and signing in

  /** Returns { recoveryCode }: shown once, stored nowhere. */
  async register({ email, password, name } = {}) {
    await this.start();
    this.#requireStartable();
    if (this.#log) throw new AccountError(409, "has-account", "This computer already belongs to an account. Sign out and forget this device first.");
    try { checkPassword(password); } catch (error) { throw new AccountError(400, "weak-password", error.message); }
    this.#name = clip(name, 128) || this.#name;
    await this.#ensureDir();
    await this.#ensureKeys();
    // A retry after no answer, in this same run, sends the same thing: if the first one landed, its code is the code that counts.
    const retry = this.#recovery.pending && this.#registerAttempt?.email === email ? this.#registerAttempt : null;
    // That code may be the live one of an earlier registration or recovery, and a new attempt's record would write over it.
    // Only the person lets go of it. The one way through is the password that opens that earlier registration.
    if (this.#recovery.pending && !retry && this.#recovery.email !== email) throw new AccountError(409, "recovery-code-pending", "This computer holds a recovery code for another email that you have not saved yet. Save that one first.");
    const candidate = this.#recovery.candidate;
    if (!retry && candidate && this.#recovery.email === email && (candidate.kind === "register" || !this.#recovery.pending)) {
      // While a registration's code is unsaved this is the only way through. Once any candidate's code is saved it is a
      // courtesy: whoever saved it after a kill still lands on their account through that candidate, rather than on a
      // refused registration and then a sign-in with nothing to anchor it. An unsaved recovery is not resumed here: its
      // own connection resends it, and `register` is the wrong door for it.
      try {
        await this.#resumeRegistration(email, password);
        return { recoveryCode: null, signedIn: true, resumed: true };
      } catch (error) {
        if (this.#recovery.pending || error.code !== "recovery-code-pending") throw error;
      }
    }
    if (this.#recovery.pending && !retry) {
      // Either an unsaved recovery, or a code a log has already shown to be live, which then has no candidate left to resume.
      const from = candidate?.kind === "recover" ? "from a recovery " : "";
      throw new AccountError(409, "recovery-code-pending", `This computer holds a recovery code for ${email} ${from}that you have not saved yet. It may be the live one, so a new registration cannot replace it. ${discardAdvice(this.limits.unsettledMs)}`);
    }
    if (!retry) await this.#recovery.apply("replaced"); // a candidate whose code the person saved: they are starting again
    const { recoveryCode, entries, salt } = retry ?? await this.#newRegistration(email);
    const loginKey = await this.#loginKey(password, salt);
    const token = await this.#bootstrapToken();
    // On disk as one before the hub can make it live. Nothing has been sent if this fails. On a retry this is the same code
    // again, which the store allows; any other would be refused there.
    try {
      await this.#recovery.prepare({ kind: "register", email, code: recoveryCode, entries });
    } catch (error) {
      if (!retry) this.#registerAttempt = null;
      throw error;
    }
    let accepted = true;
    try {
      await this.#post("/api/register", { email, salt: toB64(salt), verifierInput: loginKey, firstLogEntry: entries[0], ...(token ? { bootstrapToken: token } : {}) });
    } catch (error) {
      if (error.code === "hub-unreachable") throw error;
      if (!retry && NOTHING_CREATED.has(error.code)) {
        // A first attempt, so there was no earlier code on disk to lose: the store was `none` before prepare.
        this.#registerAttempt = null;
        await this.#recovery.apply("nothingCreated");
        this.#changed();
        if (error.code === "registration-closed") throw new AccountError(403, error.code, "This hub is closed to registration: it already holds another account, or the bootstrap token is wrong. Nothing was created by this attempt.");
        throw error;
      }
      if (!retry) {
        // Any other error may have come after the account was made.
        await this.#contest();
        throw error;
      }
      accepted = false;
      // Refused the second time: the first may have landed. Only a login shows that, and a mistyped password shows nothing.
      // The safety of this branch rests on `loginKey` being derived from this attempt's own `salt`: the hub stored that
      // salt if and only if this attempt is the account it holds, so an `approved` here can only mean that. A key derived
      // from any other salt could open nothing here, and would prove nothing if it did.
      let loginError = null;
      const state = await this.#login(email, loginKey).catch((e) => { loginError = e; return null; });
      // A mistyped password says nothing about the first attempt, and the hub has not said it is closed to this one.
      if (loginError?.code === "wrong-credentials") throw new AccountError(409, "recovery-code-pending", wrongPasswordText(email, this.limits.unsettledMs));
      if (state !== "approved") {
        await this.#contest();
        throw error;
      }
    }
    this.#registerAttempt = null;
    clearTimeout(this.#settleTimer);
    // The account exists now. From here nothing may stop the person getting this code: it is never shown again.
    this.#email = email;
    await this.#settleCommitted(entries);
    await this.#tryLocal(() => fs.rm(join(this.dir, "bootstrap-token"), { force: true }), "Could not delete the bootstrap token from the account folder. It opens nothing now, but delete it by hand.");
    if (accepted) await this.#login(email, loginKey).catch(() => {});
    const signedIn = !!this.#session && !!this.#log;
    if (signedIn) this.#phase = "approved";
    await this.#tryLocal(() => this.#persistState(), LOG_NOT_SAVED);
    if (signedIn) this.#connect();
    this.#changed();
    return { recoveryCode, signedIn };
  }

  async #newRegistration(email) {
    const recoveryCode = newRecoveryCode();
    const recovery = await recoveryKeysFrom(recoveryCode);
    const entries = await startLog({ device: { ...this.#keys, name: this.#name, kind: this.#kind }, recovery });
    const salt = globalThis.crypto.getRandomValues(new Uint8Array(SALT_BYTES));
    return (this.#registerAttempt = { email, recoveryCode, entries, salt });
  }

  /**
   * A registration from before a kill, or whose answer was lost, may have reached the hub, and the code held here would then
   * be its live one. If this password opens that account, this computer is on it and the held candidate settles on the
   * socket. If not, nothing here changes on disk: a refused password looks the same whether it was mistyped or the
   * registration never landed, and this computer cannot tell the two apart, so the code stays until the person lets it go.
   */
  async #resumeRegistration(email, password) {
    const salt = await this.#saltFor(email);
    let state;
    try {
      state = await this.#login(email, await this.#loginKey(password, salt));
    } catch (error) {
      if (error.code !== "wrong-credentials") throw error; // unreachable, locked, busy: the person is told that
      throw new AccountError(409, "recovery-code-pending", wrongPasswordText(email, this.limits.unsettledMs));
    }
    if (state !== "approved") {
      await this.#forgetSession();
      throw new AccountError(409, "recovery-code-pending", `The hub has an account for ${email} that this computer is not on, and this computer holds an unsaved recovery code from its own registration of that email. ${discardAdvice(this.limits.unsettledMs)} Then sign in instead.`);
    }
    this.#phase = "pending";
    await this.#tryLocal(() => this.#persistState(), LOG_NOT_SAVED);
    this.#connect();
  }

  // ---------------------------------------------------------------------------- the one-time code, while it is on disk

  /** The stored code. `confirmed` is false while a log from the hub has not shown it, and then it may not work yet. */
  async showRecoveryCode() {
    await this.start();
    if (!this.#recovery.pending) throw new AccountError(404, "no-code", "There is no recovery code waiting to be shown.");
    try {
      return { recoveryCode: await this.#recovery.code(), confirmed: this.#recovery.confirmed };
    } catch {
      throw new AccountError(500, "code-unavailable", "The stored recovery code could not be opened on this computer.");
    }
  }

  /** The person says they saved it. Until then it stays, and the UI keeps asking. */
  async recoveryCodeSaved() {
    await this.start();
    if (this.#recovery.pending && !this.#recovery.mayDiscard) throw new AccountError(409, "not-settled", "Wait until the hub has confirmed this code before discarding it.");
    await this.#recovery.apply("saved");
    this.#registerAttempt = null; // the person has let go of that code: no retry may send it again
    this.#changed();
    return { recoveryCodePending: false };
  }

  async #tryLocal(work, warning) {
    try {
      await work();
      return true;
    } catch {
      this.#warnings.add(warning);
      this.log("account: a local step failed after the hub had accepted");
      return false;
    }
  }

  /** The hub has this log. Never throws: a failure here only costs this computer its copy, which the candidate can restore. */
  async #settleCommitted(entries) {
    let verified;
    try {
      verified = await this.verifyLogImpl(entries, { now: this.now() });
    } catch {
      this.#warnings.add(LOG_NOT_SAVED);
      return false;
    }
    const saved = await this.#adoptLocked(entries, verified, { bestEffort: true }).catch(() => {
      this.#warnings.add(LOG_NOT_SAVED);
      return false;
    });
    if (saved) await this.#recovery.apply("settled");
    return saved;
  }

  /**
   * On reconnecting with a log that may have reached the hub. If the hub holds it, that log is this computer's, and its
   * one-time code was lost unless it was handed out before. If not, nothing happened and the old recovery code stands.
   */
  async #resolveCandidate(hubState) {
    const candidate = this.#recovery.candidate;
    if (!candidate) return;
    this.#lastHubState = hubState;
    const entry = candidate.entries.at(-1);
    if (hubState === "approved") {
      const reply = await this.#hub.rpc({ type: "log.get" }, ["log"]);
      await this.#settleAgainst(candidate, reply.entries);
      return;
    }
    // The hub says this key is not on the log. That is only its word, and a recover not yet landed can simply be sent again:
    // the person's own old key signed it, and that is what they set out to do.
    if (candidate.kind !== "recover") return this.#contest();
    let answer;
    try {
      answer = await this.#hub.rpc({ type: "log.append", prevHead: entry.prev, entry }, ["log.ok", "log.conflict"]);
    } catch (error) {
      if (error.code === "hub-unreachable" || error.code === "hub-timeout") throw error;
      return this.#contest();
    }
    await this.#settleAgainst(candidate, answer.type === "log.ok" ? candidate.entries : answer.entries);
  }

  /** Only a log that holds the candidate settles anything. Anything else is a hub contradicting this device: it deletes nothing. */
  async #settleAgainst(candidate, entries) {
    let verified, verdict;
    try {
      verified = await this.verifyLogImpl(entries, { now: this.now() });
      verdict = await compareLogs(candidate.entries, entries);
    } catch (error) {
      if (!(error instanceof LogError)) throw error;
      this.#alert("bad-log");
      return this.#contest();
    }
    if (verdict !== "same" && verdict !== "b-newer") {
      if (verdict === "a-newer") this.#alert("rollback", String(verified.head));
      else if (verdict === "fork") this.#alert("fork", String(verified.head));
      else this.#alert("different-account", String(verified.accountId));
      return this.#contest();
    }
    if (await this.#adoptLocked(entries, verified, { bestEffort: true })) await this.#recovery.apply("settled");
    if (candidate.kind === "recover") this.#recoveryAt ??= candidate.entries.length - 1;
    this.#hubError = null;
    clearTimeout(this.#settleTimer);
    this.#phase = "approved";
    await this.#tryLocal(() => this.#persistState(), LOG_NOT_SAVED);
    this.#changed();
  }

  /** The person keeps every code they hold, and may now say they saved this one. It is asked again later, since a lie may stop. */
  async #contest() {
    await this.#recovery.apply("contradicted");
    clearTimeout(this.#settleTimer);
    this.#settleTimer = setTimeout(() => this.#settleAgain(), this.limits.settleRetryMs);
    this.#settleTimer.unref?.();
    this.#changed();
  }

  async #settleAgain() {
    if (!this.#recovery.candidate || !this.#hub.connected) return;
    try {
      await this.#resolveCandidate(this.#lastHubState);
    } catch {
      this.#reconnectToSettle();
      return;
    }
    if (this.#phase !== "approved") return;
    try {
      this.#hub.sendNow({ type: "presence" });
      if (this.#role() === "full") this.#hub.sendNow({ type: "pending.list" });
    } catch { /* the next connection does this */ }
  }

  /** No answer in time, on a socket that may be fine: a new connection starts settling again from the top. */
  #reconnectToSettle() {
    this.#hub.closeSocket();
  }

  async signIn({ email, password, name } = {}) {
    await this.start();
    this.#requireStartable();
    // Only ever set from a verified log: the hub's word does not lead anyone to drop a device.
    if (this.#phase === "removed") throw new AccountError(409, "removed", "This device was removed from the account. Sign out and forget this device to sign in again as a new one.");
    this.#name = clip(name, 128) || this.#name;
    await this.#ensureDir();
    await this.#ensureKeys();
    // A key that has left the log can never come back on it, so this device could only wait for ever.
    if (this.#log && this.#everOnLog(this.#keys.signPub) && !this.#verified.devices.has(this.#keys.signPub)) {
      throw new AccountError(409, "removed", "This device was removed from the account. Sign out and forget this device to sign in again as a new one.");
    }
    const salt = await this.#saltFor(email);
    const state = await this.#login(email, await this.#loginKey(password, salt));
    if (state === "approved") {
      // The hub's word alone is not enough: this device must already hold a log that names it, or one it sent itself.
      if (!this.#verified?.devices.has(this.#keys.signPub) && !this.#recovery.candidate) {
        this.#alert("fake-log", "no-anchor");
        await this.#forgetSession();
        throw new AccountError(409, "no-anchor", "The hub says this device is on the account, but this computer holds no log to check that against. Sign out and forget this device to sign in again as a new one.");
      }
      this.#phase = this.#verified?.devices.has(this.#keys.signPub) ? "approved" : "pending";
    } else {
      this.#phase = "pending";
      this.#exchange.reset();
      this.#approvedByHub = false;
    }
    await this.#persistState();
    this.#connect();
    this.#changed();
    return this.status();
  }

  async #forgetSession() {
    this.#session = null;
    await fs.rm(join(this.dir, "session.json"), { force: true });
  }

  async signOut({ forget = false } = {}) {
    this.#dropConnection("signed-out");
    await this.#started;
    await this.#forgetSession();
    this.#phase = "signed-out";
    this.#exchange.current = null;
    this.#review = null;
    this.#rows = [];
    this.#online = new Set();
    this.#approvedByHub = false;
    this.#hubError = null;
    await this.#recovery.apply(forget ? "forgotten" : "signedOut");
    if (forget) {
      for (const file of ["keys.json", "log.json", "state.json"]) await fs.rm(join(this.dir, file), { force: true });
      this.#registerAttempt = null;
      this.#recoveryAt = null;
      this.#keys = null;
      this.#log = null;
      this.#verified = null;
      this.#hashes = [];
      this.#knownRecoveries = 0;
      this.#email = null;
      this.#keyKind = null;
    } else {
      await this.#persistState();
    }
    this.#changed();
    this.emit("devices", this.devices());
    return this.status();
  }

  #everOnLog(signPub) {
    return this.#log?.some((entry) => entry.body?.signPub === signPub);
  }

  // ---------------------------------------------------------------------------- the hub connection

  #connect() {
    if (!this.#stopped) this.#hub.connect();
  }

  #onSocketGone(code) {
    this.#closeAllChannels("the hub connection was lost");
    this.#hub.failWaiters(new AccountError(503, "hub-unreachable", "The hub connection was lost."));
    this.#online = new Set();
    this.#rows = [];
    this.#changed();
    this.emit("devices", this.devices());
    if (this.#stopped) return;
    switch (code) {
      case CLOSE_REPLACED:
        this.#hubError = "Replaced by another sign-in of this device. Not reconnecting, so the two do not fight.";
        this.#changed();
        return;
      case CLOSE_DENIED:
        this.#settle("denied", "A device on the account refused this sign-in.");
        return;
      case CLOSE_PENDING_EXPIRED:
        this.#settle("expired", "This sign-in expired before it was approved.");
        return;
      case CLOSE_REMOVED:
        // The hub's word, not a verified log. One more connection will show the log if the session still stands.
        this.#alert("hub-says-removed");
        this.#hubClaimedRemoved = true;
        this.#hubError = HUB_CLAIMS_REMOVED;
        this.#hub.scheduleReconnect();
        return;
      case CLOSE_SESSION_GONE:
        this.#settle("signed-out", this.#hubClaimedRemoved ? HUB_CLAIMS_REMOVED : "The hub no longer knows this session. Sign in again.");
        return;
      default:
        this.#hubError ??= "The hub connection was lost.";
        this.#hub.scheduleReconnect();
    }
  }

  /** The hub ended this session for good. */
  #settle(phase, message) {
    this.#phase = phase;
    this.#hubError = message;
    this.#forgetSession().then(() => this.#persistState()).catch(() => {});
    this.#changed();
  }

  #dispatch(message) {
    switch (message.type) {
      case "log.updated": return void this.#onLogUpdated(message);
      case "session.approved":
        this.#approvedByHub = true;
        this.#changed();
        return void this.#tryFinishApproval();
      case "pending.list":
        this.#rows = (Array.isArray(message.pending) ? message.pending : []).filter((r) => isFiniteDevice(r?.id) && isFiniteDevice(r?.signPub)).slice(0, MAX_PENDING_ROWS)
          .map((r) => ({ ...r, name: clip(r.name, 128), kind: clip(r.kind, 32), ip: clip(r.ip, 64) }));
        for (const id of [...this.#reviewHints.keys()]) if (!this.#rows.some((r) => r.id === id)) this.#reviewHints.delete(id);
        if (this.#review && !this.#rows.some((r) => r.id === this.#review.id)) this.#review = null;
        this.#hub.answerWaiter(message);
        this.emit("approval", this.pendingSignIns());
        this.#changed();
        return undefined;
      case "presence":
        this.#online = new Set(Array.isArray(message.online) ? message.online.filter((k) => typeof k === "string") : []);
        for (const channel of this.#links.all()) {
          if (channel.state === "open" && !this.#online.has(channel.peerId)) channel.close("the other device went offline", { notify: false });
        }
        this.#hub.answerWaiter(message);
        this.emit("devices", this.devices());
        return undefined;
      case "approval.msg":
        if (!isFiniteDevice(message.from) || typeof message.opaque !== "string") return undefined;
        this.#approvalChain = this.#approvalChain.then(() => this.#onApprovalMessage(message.from, message.opaque)).catch(() => {});
        return undefined;
      case "channel.msg":
        if (isFiniteDevice(message.from) && typeof message.opaque === "string") this.#onChannelMessage(message.from, message.opaque);
        return undefined;
      case "error":
        if (message.for === "channel.msg" && typeof message.to === "string") {
          for (const channel of this.#links.all()) {
            if (channel.peerId === message.to) channel.close(message.code === "busy" ? "the other device is not reading, so the channel was closed" : "the other device cannot be reached", { notify: false });
          }
          return undefined;
        }
        this.#hub.answerWaiter(message);
        return undefined;
      default:
        this.#hub.answerWaiter(message);
        return undefined;
    }
  }

  async #onAuthOk({ state }) {
    this.#hubError = null;
    this.#hubClaimedRemoved = false;
    this.#changed();
    for (const waiter of this.#socketWaiters.splice(0)) waiter();
    if (this.#recovery.candidate) {
      try {
        await this.#resolveCandidate(state);
      } catch {
        this.#reconnectToSettle();
        return;
      }
    }
    if (this.#phase === "approved") {
      try {
        await this.syncLog();
        this.#hub.sendNow({ type: "presence" });
        if (this.#role() === "full") this.#hub.sendNow({ type: "pending.list" });
      } catch { /* the socket went: the next connection does this again */ }
    } else if (this.#phase === "pending" && state === "approved" && !this.#recovery.candidate) {
      this.#approvedByHub = true;
      this.#tryFinishApproval();
    }
  }

  #socketWaiters = [];

  #whenConnected() {
    if (this.#hub.connected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new AccountError(503, "hub-unreachable", "The hub cannot be reached.")), this.limits.connectTimeoutMs);
      timer.unref?.();
      this.#socketWaiters.push(() => { clearTimeout(timer); resolve(); });
    });
  }

  #role() {
    return this.#keys && this.#verified?.devices.get(this.#keys.signPub)?.role;
  }

  #requireFull(what) {
    if (this.#phase !== "approved") throw new AccountError(409, "not-signed-in", "This computer is not signed in.");
    if (this.#role() !== "full") throw new AccountError(403, "not-full", `Only a desktop or iPhone can ${what}.`);
  }

  // ---------------------------------------------------------------------------- the log

  async #setLog(entries, verified) {
    this.#log = entries;
    this.#verified = verified;
    this.#hashes = await Promise.all(entries.map((entry) => entryHash(entry)));
  }

  /** One adoption at a time, in order with #considerLog's. */
  #adoptLocked(entries, verified, options) {
    const run = this.#logLock.then(() => this.#adopt(entries, verified, options));
    this.#logLock = run.catch(() => {});
    return run;
  }

  /** Disk first: a log believed but not kept could be rolled back by a restart. */
  async #adopt(entries, verified, { bestEffort = false } = {}) {
    let saved = true;
    try {
      await this.#writeFile("log.json", JSON.stringify(entries));
    } catch (error) {
      if (!bestEffort) throw error;
      saved = false;
      this.#warnings.add(LOG_NOT_SAVED);
    }
    await this.#setLog(entries, verified);
    if (this.#recoveryAt !== null && entries.slice(this.#recoveryAt + 1).some((entry) => entry.signer !== this.#keys?.signPub)) this.#recoveryConfirmed();
    const fresh = verified.recoveries.slice(this.#knownRecoveries);
    this.#knownRecoveries = verified.recoveries.length;
    for (const recovery of fresh) if (recovery.signPub !== this.#keys?.signPub) this.#alert("recovered", String(recovery.index));
    this.emit("devices", this.devices());
    this.#changed();
    if (this.#phase === "approved" && this.#keys && !verified.devices.has(this.#keys.signPub)) {
      this.#alert("removed");
      this.#phase = "removed";
      this.#hubError = "This device is no longer on the account.";
      this.#dropConnection("removed");
      await this.#forgetSession();
      await this.#persistState();
      this.#changed();
      return saved;
    }
    this.#links.recheck();
    return saved;
  }

  #recoveryConfirmed() {
    this.#recoveryAt = null;
    this.#persistState().catch(() => {});
    this.#changed();
  }

  /** A log from outside against the one held here. Returns same, adopted, rollback, fork, different-account or bad-log. */
  #considerLog(entries) {
    const run = this.#logLock.then(async () => {
      const { verdict, verified, alert } = await judgeLog(this.#log, entries, { now: this.now(), verifyLog: this.verifyLogImpl });
      if (alert) this.#alert(...alert);
      if (verdict === "adopted") await this.#adopt(entries, verified);
      return verdict;
    });
    this.#logLock = run.catch(() => {});
    return run;
  }

  /** Asks the hub for the log. The heads are compared first, since a replay is costly. */
  syncLog() {
    this.#syncing ??= (async () => {
      try {
        const reply = await this.#hub.rpc({ type: "log.get" }, ["log"]);
        if (reply.head === this.#hashes.at(-1) && reply.version === this.#hashes.length) return "same";
        return await this.#considerLog(reply.entries);
      } finally {
        this.#syncing = null;
      }
    })();
    return this.#syncing;
  }

  #onLogUpdated({ head }) {
    if (this.#phase !== "approved" || head === this.#hashes.at(-1)) return;
    this.syncLog().catch((error) => this.log(`account: log sync failed: ${error.code ?? error.name}`));
  }

  /** Adds an entry to the hub's log. Returns "ok", or "conflict" having taken in the newer log. */
  async #appendEntry(entries) {
    const entry = entries.at(-1);
    const reply = await this.#hub.rpc({ type: "log.append", prevHead: entry.prev, entry }, ["log.ok", "log.conflict"]);
    if (reply.type === "log.conflict") {
      await this.#considerLog(reply.entries);
      return "conflict";
    }
    const verified = await this.verifyLogImpl(entries, { now: this.now() });
    if (reply.head !== verified.head) this.log("account: the hub's head differs from the appended entry's");
    await this.#adoptLocked(entries, verified);
    return "ok";
  }

  // ---------------------------------------------------------------------------- approving: the approver

  #reviewView() {
    const r = this.#review;
    return { id: r.id, code: r.code, name: r.claim.name, kind: r.claim.kind, ip: r.row.ip, signPub: r.row.signPub, expiresAt: r.row.expiresAt };
  }

  /** Presses Review on a card: the exchange runs and the code comes back to show the person. Nothing is signed yet. */
  async review(id) {
    this.#requireFull("approve a new device");
    if (this.#review) throw new AccountError(409, "review-in-progress", "Another review is in progress. Finish or deny it first.");
    const row = this.#rows.find((r) => r.id === id);
    if (!row) throw new AccountError(404, "no-such-signin", "That sign-in is no longer waiting.");
    this.#review = { id, row, code: null, claim: { name: row.name, kind: row.kind }, head: null, arrived: null };
    try {
      await this.syncLog();
      const head = this.#hashes.at(-1);
      this.#review.head = head;
      const exchange = await approverExchange({ approverPub: this.#keys.signPub, newPub: row.signPub, logHead: head });
      const arrived = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new AccountError(504, "review-timeout", "The new device did not answer.")), this.limits.reviewTimeoutMs);
        timer.unref?.();
        this.#review.arrived = (fields) => { clearTimeout(timer); resolve(fields); };
      });
      this.#broadcastReview(id);
      this.#hub.sendNow({ type: "approval.msg", to: row.signPub, opaque: encodeOuter({ t: "commit", commit: exchange.commit, logHead: head }) });
      const { random, claim, sig } = await arrived;
      if (!this.#review || this.#review.id !== id) throw new AccountError(409, "review-ended", "This review was ended.");
      if (!await this.#claimVerifies(claim, sig, row.signPub, head)) throw new AccountError(502, "bad-claim", "The new device's details did not carry a valid signature, so this sign-in was not trusted.");
      exchange.receiveRandom(random);
      this.#hub.sendNow({ type: "approval.msg", to: row.signPub, opaque: encodeOuter({ t: "reveal", random: exchange.revealRandom() }) });
      const code = await exchange.code();
      if (!this.#review || this.#review.id !== id) throw new AccountError(409, "review-ended", "This sign-in went away during the review.");
      Object.assign(this.#review, { code, claim });
      this.#changed();
      this.emit("approval", this.pendingSignIns());
      return this.#reviewView();
    } catch (error) {
      if (this.#review?.id === id) this.#review = null;
      this.#changed();
      throw error;
    }
  }

  #broadcastReview(id) {
    for (const device of this.devices()) {
      if (device.self || device.role !== "full" || !device.online) continue;
      this.#hub.sendPaced({ type: "channel.msg", to: device.id, opaque: encodeOuter({ t: "review", id }) }).catch(() => {});
    }
  }

  async #claimVerifies(claim, sig, signPub, head) {
    if (typeof claim !== "object" || claim === null) return false;
    for (const field of ["name", "kind", "boxPub"]) if (typeof claim[field] !== "string" || !claim[field]) return false;
    return verify(signPub, signedClaimBytes(claim, head, this.#keys.signPub), sig);
  }

  /**
   * The person saw the code match on both screens. Only now is the entry signed, and only for the code it was shown.
   * The role is the person's choice and nothing else's: a tampered web page can call itself a desktop. `client` unless
   * they said otherwise.
   */
  async approve(id, { code, role = "client" } = {}) {
    this.#requireFull("approve a new device");
    const review = this.#review;
    if (!review || review.id !== id || !review.code) throw new AccountError(409, "no-review", "Review this sign-in first, and compare the codes.");
    if (typeof code !== "string" || code !== review.code) throw new AccountError(400, "wrong-code", "That is not the code shown for this review.");
    if (role !== "client" && role !== "full") throw new AccountError(400, "bad-role", "The role must be client or full.");
    const { claim, row, head } = review;
    if (head !== this.#hashes.at(-1)) {
      this.#review = null;
      throw new AccountError(409, "log-conflict", "The device list changed while you were reviewing, so that code no longer holds. Review this sign-in again.");
    }
    let entries;
    try {
      entries = await append(this.#log, { type: "add", name: claim.name, kind: claim.kind, role, signPub: row.signPub, boxPub: claim.boxPub, addedAt: this.now() }, this.#keys);
    } catch (error) {
      this.#review = null;
      if (error instanceof LogError) throw new AccountError(400, "bad-claim", "This device cannot be added to the account (it may have been on it before).");
      throw error;
    }
    let outcome;
    try {
      outcome = await this.#appendEntry(entries);
    } finally {
      this.#review = null;
      this.#changed();
    }
    if (outcome === "conflict") throw new AccountError(409, "log-conflict", "The device list changed while you were reviewing, so that code no longer holds. Review this sign-in again.");
    return { devices: this.devices() };
  }

  async deny(id) {
    this.#requireFull("deny a sign-in");
    await this.#hub.rpc({ type: "pending.deny", id }, ["pending.denied"]);
    if (this.#review?.id === id) this.#review = null;
    this.#changed();
    return { ok: true };
  }

  async remove(id) {
    this.#requireFull("remove a device");
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!this.#verified.devices.has(id)) throw new AccountError(404, "no-such-device", "That device is not on the account.");
      let entries;
      try {
        entries = await append(this.#log, { type: "remove", signPub: id }, this.#keys);
      } catch (error) {
        if (error instanceof LogError) throw new AccountError(400, "cannot-remove", error.message);
        throw error;
      }
      if (await this.#appendEntry(entries) === "ok") return { devices: this.devices() };
    }
    throw new AccountError(409, "log-conflict", "The device list keeps changing. Try again.");
  }

  // ---------------------------------------------------------------------------- approving: the new device

  async #onApprovalMessage(from, opaque) {
    const outer = decodeOuter(opaque);
    if (!outer) return;
    if (this.#phase === "approved") {
      const review = this.#review;
      if (review?.arrived && review.row.signPub === from && outer.t === "random") {
        review.arrived({ random: outer.random, claim: outer.claim, sig: outer.sig });
        review.arrived = null;
      }
      return;
    }
    if (this.#phase !== "pending" || !this.#keys) return;
    return this.#exchange.onMessage(from, outer);
  }

  /** The person's button on a new device: after a failed exchange, or a code that did not match. Forgets any code held. */
  restartExchange() {
    if (this.#phase !== "pending") throw new AccountError(409, "not-pending", "This computer is not waiting for approval.");
    this.#exchange.restart();
    return this.status();
  }

  /**
   * The person at this computer checked that the code here matches the approving device's. Without this step, a hacked
   * hub could play the approver on its own and hand this computer a made-up account whose devices it then controls:
   * the log would follow the head of an exchange that was real, just not with any device of the person's.
   */
  confirmCode(code) {
    if (this.#phase !== "pending") throw new AccountError(409, "no-code", "There is no code to confirm yet.");
    this.#exchange.confirm(code);
    this.#tryFinishApproval();
    return this.status();
  }

  async #tryFinishApproval() {
    if (this.#phase !== "pending" || !this.#approvedByHub) return;
    const exchange = this.#exchange.current;
    if (!exchange?.code && !exchange?.confirmed) {
      this.#alert("fake-log", "no-code");
      return;
    }
    if (!exchange.confirmed) return;
    let reply;
    try {
      reply = await this.#hub.rpc({ type: "log.get" }, ["log"]);
    } catch {
      return; // the next connection tries again
    }
    if (this.#phase !== "pending" || this.#exchange.current !== exchange) return;
    const entries = reply.entries;
    const { verified, alert } = await checkApprovedLog(entries, { me: this.#keys.signPub, exchange, held: this.#log, now: this.now(), verifyLog: this.verifyLogImpl });
    if (alert) {
      this.#alert(...alert);
      return;
    }
    await this.#adoptLocked(entries, verified);
    this.#phase = "approved";
    this.#exchange.current = null;
    this.#approvedByHub = false;
    await this.#persistState();
    this.#changed();
    try {
      this.#hub.sendNow({ type: "presence" });
      if (this.#role() === "full") this.#hub.sendNow({ type: "pending.list" });
    } catch { /* the socket went: the next connection does this again */ }
  }

  // ---------------------------------------------------------------------------- recovery and password

  /** Returns { recoveryCode }: the replacement, shown once. */
  async recover({ email, password, recoveryCode, name } = {}) {
    await this.start();
    this.#requireStartable();
    let recovery;
    try { recovery = await recoveryKeysFrom(String(recoveryCode ?? "")); } catch { throw new AccountError(400, "bad-code", "That is not a recovery code."); }
    this.#name = clip(name, 128) || this.#name;
    await this.#ensureDir();
    await this.#ensureKeys();
    if (this.#everOnLog(this.#keys.signPub) && !this.#verified?.devices.has(this.#keys.signPub)) {
      throw new AccountError(409, "removed", "This device was removed from the account. Sign out and forget this device first.");
    }
    // That code may be the live one, and a failed attempt here must not cost it.
    if (this.#recovery.pending) throw new AccountError(409, "recovery-code-pending", "This computer holds a recovery code you have not saved yet. Save that one first.");
    const salt = await this.#saltFor(email);
    const hubState = await this.#login(email, await this.#loginKey(password, salt));
    // Already on the list, by an earlier recovery that landed. The log would refuse another for this key, and none is needed.
    // The typed code was never sent or checked: `codeUsed: false` says so, since it may be wrong or dead for all this shows.
    if (hubState === "approved") {
      const known = this.#verified?.devices.has(this.#keys.signPub);
      if (!known && !this.#recovery.candidate) {
        this.#alert("fake-log", "no-anchor");
        await this.#forgetSession();
        throw new AccountError(409, "no-anchor", "The hub says this device is on the account, but this computer holds no log to check that against. Sign out and forget this device to start over.");
      }
      this.#phase = known ? "approved" : "recovering";
      await this.#tryLocal(() => this.#persistState(), LOG_NOT_SAVED);
      this.#connect();
      this.#changed();
      return { recoveryCode: null, confirmed: false, alreadyOnLog: true, codeUsed: false };
    }
    await this.#recovery.apply("replaced"); // the person saved that code and is starting again
    this.#phase = "recovering";
    this.#connect();
    let nextCode, sent = null;
    try {
      await this.#whenConnected();
      const proof = await sign(recovery.sign.privateKey, encoder.encode(`${RECOVERY_DOMAIN} ${this.hubOrigin} ${this.#hub.nonce}`));
      nextCode = newRecoveryCode();
      const next = await recoveryKeysFrom(nextCode);
      for (let attempt = 0; attempt < 3; attempt++) {
        let reply;
        try {
          reply = await this.#hub.rpc({ type: "log.get", recoveryProof: proof }, ["log"]);
        } catch (error) {
          if (error.code === "forbidden") throw new AccountError(403, "wrong-code", "That recovery code does not belong to this account, or has been used.");
          throw error;
        }
        // A conflict may be a hub lying after it appended. The same code is on disk for every attempt, so nothing is lost by asking.
        if (sent && await this.#holdsCandidate(sent, reply.entries)) return this.#finishRecovery(nextCode, reply.entries, sent.length - 1);
        const entries = await this.#checkedRecoveryLog(reply.entries, recovery);
        const appended = await recoverOnto(entries, { name: this.#name, kind: this.#kind, signPub: this.#keys.signPub, boxPub: this.#keys.boxPub }, { current: recovery, next, addedAt: this.now() });
        // On disk as one before the hub can make it live. Nothing has been sent if this fails: the old code stands.
        await this.#recovery.prepare({ kind: "recover", email, code: nextCode, entries: appended });
        sent = appended;
        let answer;
        try {
          answer = await this.#hub.rpc({ type: "log.append", prevHead: entries.at(-1) ? await entryHash(entries.at(-1)) : "", entry: appended.at(-1) }, ["log.ok", "log.conflict"]);
        } catch (error) {
          // It never left this computer, and nothing earlier did: the old code stands and this one never counted.
          if (error.neverSent && attempt === 0) {
            await this.#recovery.apply("nothingCreated");
            sent = null;
            throw error;
          }
          // Any other answer, an error included: a hub can append and then say anything. The old code may be dead already, so
          // the person gets the new one and keeps both until a log settles it.
          return this.#recoveryInDoubt(nextCode, appended);
        }
        if (answer.type === "log.conflict") continue;
        return this.#finishRecovery(nextCode, appended, appended.length - 1);
      }
      return this.#recoveryInDoubt(nextCode, sent); // only ever told "conflict": any of those may have landed
    } catch (error) {
      if (sent) return this.#recoveryInDoubt(nextCode, sent);
      this.#phase = "signed-out";
      this.#dropConnection("signed-out");
      await this.#forgetSession().catch(() => {});
      if (error instanceof LogError) throw new AccountError(400, "cannot-recover", error.message);
      throw error;
    }
  }

  /** The hub has the entry, so the old code is dead. Never throws: losing this code could leave the account with none. */
  async #finishRecovery(nextCode, entries, recoveryAt) {
    this.#phase = "approved";
    // Until another device shows it holds this entry, the hub may have shown an older log and this new code may not count.
    this.#recoveryAt = recoveryAt;
    await this.#settleCommitted(entries);
    await this.#tryLocal(() => this.#persistState(), LOG_NOT_SAVED);
    try {
      this.#hub.sendNow({ type: "presence" });
      this.#hub.sendNow({ type: "pending.list" });
    } catch { /* the next connection does this */ }
    this.#changed();
    return { recoveryCode: nextCode, confirmed: true };
  }

  async #holdsCandidate(candidateEntries, entries) {
    try {
      const verdict = await compareLogs(candidateEntries, entries);
      return verdict === "same" || verdict === "b-newer";
    } catch (error) {
      if (error instanceof LogError) return false;
      throw error;
    }
  }

  async #recoveryInDoubt(nextCode, appended) {
    this.#recoveryAt = appended.length - 1;
    await this.#tryLocal(() => this.#persistState(), LOG_NOT_SAVED);
    // Reconnecting says which: an approved session means the hub has the entry.
    this.#hub.closeSocket();
    if (!this.#hub.ws) this.#connect();
    this.#changed();
    return { recoveryCode: nextCode, confirmed: false };
  }

  /** The log to build on. It must name this code's key, and may not contradict a log this computer already holds. */
  async #checkedRecoveryLog(entries, recovery) {
    let verified;
    try {
      verified = await this.verifyLogImpl(entries, { now: this.now() });
    } catch (error) {
      if (!(error instanceof LogError)) throw error;
      this.#alert("bad-log", error.message);
      throw new AccountError(403, "wrong-code", "The hub's device list failed its checks.");
    }
    if (!await mayRecover(entries, recovery)) throw new AccountError(403, "wrong-code", "That recovery code does not belong to this account, or has been used.");
    if (this.#log) {
      const verdict = await compareLogs(this.#log, entries);
      if (verdict !== "b-newer" && verdict !== "same") {
        this.#alert(verdict === "a-newer" ? "rollback" : verdict === "fork" ? "fork" : "different-account", String(verified.head));
        throw new AccountError(403, "log-mismatch", "The hub's device list contradicts the one on this computer.");
      }
    }
    return entries;
  }

  /** Changes loginKey only: nothing is encrypted with the password, and device keys stay as they are. */
  async changePassword({ current, next } = {}) {
    this.#requireFull("change the password");
    try { checkPassword(next); } catch (error) { throw new AccountError(400, "weak-password", error.message); }
    if (typeof current !== "string" || !current) throw new AccountError(400, "bad-password", "Type your current password.");
    const oldSalt = await this.#saltFor(this.#email);
    const currentLoginKey = await this.#loginKey(current, oldSalt);
    const salt = globalThis.crypto.getRandomValues(new Uint8Array(SALT_BYTES));
    const verifierInput = await this.#loginKey(next, salt);
    await this.#hub.rpc({ type: "password.change", currentLoginKey, salt: toB64(salt), verifierInput }, ["password.changed"]);
    return { ok: true };
  }

  /** Opens a channel to another machine on the account. */
  openChannel(deviceId) { return this.#links.open(deviceId); }

  #onChannelMessage(from, opaque) {
    const outer = decodeOuter(opaque);
    if (!outer) {
      const foreign = foreignOuter(opaque);
      if (foreign) this.#links.otherVersion(from, foreign);
      return;
    }
    if (outer.t === "review") {
      const device = this.#verified?.devices.get(from);
      if (device?.role === "full" && this.#rows.some((row) => row.id === outer.id)) {
        this.#reviewHints.set(outer.id, device.name);
        this.emit("approval", this.pendingSignIns());
      }
      return;
    }
    this.#links.receive(from, outer, opaque.length);
  }

  // ---------------------------------------------------------------------------- audit

  /** One line per remote request: {at, device, deviceName, method, path}. Never a body. */
  audit({ at, device, deviceName, method, path }) {
    const line = `${JSON.stringify({ at, device, deviceName, method, path })}\n`;
    this.#auditChain = this.#auditChain.then(() => this.#writeAudit(line)).catch((error) => {
      this.log(`account: could not write the audit log: ${error.code ?? error.name}`);
      this.#warnings.add("The audit log could not be written.");
    });
  }

  auditFlush() { return this.#auditChain; }

  async #writeAudit(line) {
    await this.#ensureDir();
    const file = join(this.dir, "audit.jsonl");
    if (this.#auditSize === null) this.#auditSize = await fs.stat(file).then((s) => s.size, () => 0);
    const bytes = Buffer.byteLength(line);
    if (this.#auditSize + bytes > this.limits.auditMaxBytes) {
      await fs.rename(file, join(this.dir, "audit.1.jsonl")).catch(() => {});
      this.#auditSize = 0;
    }
    await fs.appendFile(file, line, { mode: 0o600 });
    this.#auditSize += bytes;
  }

  /** The newest lines first, for Settings. */
  async auditLines(limit = 200) {
    await this.#auditChain;
    const count = Math.min(Math.max(1, Number(limit) || 200), 1000);
    const out = [];
    for (const name of ["audit.jsonl", "audit.1.jsonl"]) {
      let text = "";
      try { text = await fs.readFile(join(this.dir, name), "utf8"); } catch { continue; }
      for (const line of text.split("\n").reverse()) {
        if (!line) continue;
        try { out.push(JSON.parse(line)); } catch { continue; }
        if (out.length >= count) return out;
      }
    }
    return out;
  }
}

/** What a hub's reply to a registration says was not created. Anything else may have come after the account was made. */
const NOTHING_CREATED = new Set(["bad-email", "bad-salt", "bad-verifier", "bad-log-entry", "bad-json", "json-only", "too-large", "origin", "locked", "too-many-pending", "busy", "registration-closed", "already-registered"]);
