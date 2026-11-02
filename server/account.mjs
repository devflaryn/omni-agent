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
 *   state.json     email, name, phase, and a confirmed approval's head and approver (not its code). No secrets.
 *   log.candidate.json  a log about to be sent to the hub, so that a kill right after the hub takes it can be resumed. No secrets.
 *   log.json       the longest log verified so far
 *   settings.json  { allowWebAccess }
 *   alerts.json    what the person has been warned of
 *   audit.jsonl    one line per request from another device, with one older file, audit.1.jsonl
 *
 * Never logged, alerted, audited or put in an error: keys, tokens, passwords, codes.
 */
import { execFile } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import { hostname } from "node:os";
import { basename, join } from "node:path";
import { Worker } from "node:worker_threads";
import { checkPassword, fromB64, loginKeyFrom, newDeviceExchange, newDeviceKeys, newRecoveryCode, approverExchange, recoveryKeysFrom, sign, startHandshake, toB64, verify } from "../ui/account-core.js";
import { LogError, append, canRecover, compareLogs, createLog, deviceCurrent, deviceExpiresAt, entryHash, verifyLog } from "../ui/device-log.js";
import { CLOSE_REASONS, FRAME, decodeFrame, decodeOuter, encodeFrame, encodeOuter } from "../ui/channel-frames.js";

export class AccountError extends Error {
  constructor(status, code, message) {
    super(message ?? code);
    this.name = "AccountError";
    this.status = status;
    this.code = code;
  }
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const DEFAULT_LIMITS = Object.freeze({
  auditMaxBytes: 5 * 1024 * 1024,
  handshakeTimeoutMs: 35 * SECOND,      // longer than rpcTimeoutMs: a handshake may have to fetch the log
  reviewTimeoutMs: MINUTE,
  rpcTimeoutMs: 30 * SECOND,
  httpTimeoutMs: 20 * SECOND,
  connectTimeoutMs: 15 * SECOND,
  maxChannels: 64,
  maxChannelsPerDevice: 8,
  maxInboundBytes: 16 * 1024 * 1024,
  messagesPerSecond: 400,               // the hub closes a socket at 500 frames a second
  maxBufferedBytes: 4 * 1024 * 1024,    // what may sit in the socket before the sender waits
});
const SALT_BYTES = 16;
/**
 * What the person must not miss: these are never pushed out by others. Every other kind can be raised by a hub at will
 * from public data, so each is one row with a count, whatever it is about.
 */
const LASTING_ALERTS = new Set(["fork", "rollback", "fake-log", "different-account", "recovered", "removed", "log-unreconciled", "refused-by-device"]);
/** A hub can make different-account or fake-log rows for ever by building new logs, so past this they count on the last row. */
const MAX_ROWS_PER_KIND = 8;
const MAX_PENDING_ROWS = 64;
/** A hub's error code is shown to the person. */
const safeCode = (code) => String(code ?? "").replace(/[^\w.-]/g, "").slice(0, 64) || "hub-error";
const AUTH_DOMAIN = "omni-hub-auth-v1";
const RECOVERY_DOMAIN = "omni-hub-recovery-v1";
const CLAIM_DOMAIN = "omni-approval-claim-v1";
const TIMER_MAX = 2 ** 31 - 1;
const encoder = new TextEncoder();
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const clip = (value, max) => String(value ?? "").trim().slice(0, max);
const isFiniteDevice = (value) => typeof value === "string" && value.length > 0 && value.length < 4096;
const DISAGREEMENT_REASONS = new Set(["not-on-log", "removed", "expired", "log-mismatch"]);
const HUB_CLAIMS_REMOVED = "The hub says this device was removed from the account, and it would not show the device list. This computer's own list still has it. Sign in again to check.";
const CLOSE_SESSION_GONE = 4401, CLOSE_REMOVED = 4403, CLOSE_PENDING_EXPIRED = 4408, CLOSE_REPLACED = 4409, CLOSE_DENIED = 4410;

// ------------------------------------------------------------------------------ protecting secrets

function runCommand(cmd, args, input) {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { windowsHide: true, timeout: 30 * SECOND, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      // The message is ours: stderr or the arguments could hold anything.
      if (error) reject(new Error(`${basename(cmd)} failed`));
      else resolve(stdout);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
  });
}

const system32 = (exe) => join(process.env.SystemRoot || "C:\\Windows", "System32", exe);

/** DPAPI through PowerShell, for this user. The data goes over stdin, never in an argument. */
export function windowsProtector({ run = runCommand } = {}) {
  const powershell = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const call = async (method, bytes) => {
    const script = `Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::${method}($b,$null,'CurrentUser'))`;
    const out = await run(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], Buffer.from(bytes).toString("base64"));
    const result = Buffer.from(out.trim(), "base64");
    if (!result.length) throw new Error(`DPAPI ${method} returned nothing`);
    return result;
  };
  return { name: "dpapi", warning: null, protect: (bytes) => call("Protect", bytes), unprotect: (bytes) => call("Unprotect", bytes) };
}

/**
 * A random wrapping key kept in the login Keychain through `security`, and AES-256-GCM with it. The key goes in through
 * `security -i` on stdin, since an argument could be seen by any process.
 */
export function keychainProtector({ service, run = runCommand } = {}) {
  const security = "/usr/bin/security";
  const ACCOUNT = "omni-agent";
  let cached = null;
  const wrappingKey = async ({ create }) => {
    if (cached) return cached;
    try {
      const hex = (await run(security, ["find-generic-password", "-a", ACCOUNT, "-s", service, "-w"])).trim();
      if (/^[0-9a-f]{64}$/.test(hex)) return (cached = Buffer.from(hex, "hex"));
    } catch { /* no such item yet */ }
    if (!create) throw new Error("no key in the Keychain");
    const key = randomBytes(32);
    await run(security, ["-i"], `add-generic-password -a ${ACCOUNT} -s ${service} -U -w ${key.toString("hex")}\n`);
    return (cached = key);
  };
  return {
    name: "keychain",
    warning: null,
    async protect(bytes) {
      const key = await wrappingKey({ create: true });
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const sealed = Buffer.concat([cipher.update(bytes), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), sealed]);
    },
    async unprotect(blob) {
      const key = await wrappingKey({ create: false });
      const decipher = createDecipheriv("aes-256-gcm", key, blob.subarray(0, 12));
      decipher.setAuthTag(blob.subarray(12, 28));
      return Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]);
    },
  };
}

const SETTINGS_DAMAGED = "The saved settings could not be read, so Allow web page access is off until you choose again.";
const LOG_NOT_SAVED = "This computer could not save its device list. It will try again the next time Omni starts: check the disk.";
const PLAIN_WARNING = "This computer's keys are protected by file permissions alone: any program running as you can read them.";
export function plainProtector() {
  return { name: "none", warning: PLAIN_WARNING, protect: async (bytes) => Buffer.from(bytes), unprotect: async (bytes) => Buffer.from(bytes) };
}

function defaultProtector(dir) {
  if (process.platform === "win32") return windowsProtector();
  if (process.platform === "darwin") return keychainProtector({ service: `omni-agent-${createHash("sha256").update(dir).digest("hex").slice(0, 16)}` });
  return plainProtector();
}

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

// ------------------------------------------------------------------------------ a channel

/** One encrypted channel to one device. sendFrame and onFrame carry sealed frames, in order. */
class Channel extends EventEmitter {
  closed = false;
  state = "handshake";
  #onFrame = null;
  #backlog = [];
  #outChain = Promise.resolve();
  #inChain = Promise.resolve();
  #inBytes = 0;
  #send;
  #closing;
  #timer = null;

  constructor({ id, peerId, direction, send, closing }) {
    super();
    this.id = id;
    this.peerId = peerId;
    this.direction = direction;
    this.peer = { id: peerId, name: "", kind: "", role: "" };
    this.core = null;
    this.handshake = null;
    this.ready = { sent: false, received: false };
    this.#send = send;
    this.#closing = closing;
    this.on("error", () => {});
  }

  /** Runs one incoming step at a time, in the order they came. Returns false when too much is waiting. */
  enqueue(bytes, step, maxBytes) {
    this.#inBytes += bytes;
    if (this.#inBytes > maxBytes) return false;
    // A step that throws was handling something it could not make sense of, and that ends this channel, not the server.
    this.#inChain = this.#inChain.then(() => (this.closed ? undefined : step())).catch(() => this.close("closed")).finally(() => { this.#inBytes -= bytes; });
    return true;
  }

  setTimer(timer) {
    clearTimeout(this.#timer);
    this.#timer = timer;
  }

  onFrame(callback) {
    this.#onFrame = callback;
    for (const frame of this.#backlog.splice(0)) callback(frame);
  }

  deliver(frame) {
    if (this.#onFrame) this.#onFrame(frame);
    else this.#backlog.push(frame);
  }

  /** Seals and sends, in the order called. Resolves once the frame is in the socket and there was room for it. */
  sendFrame(bytes) {
    if (this.closed || !this.core) return Promise.reject(new Error("the channel is closed"));
    const result = this.#outChain.then(async () => {
      if (this.closed) throw new Error("the channel is closed");
      await this.#send(this, Buffer.from(await this.core.seal(bytes)).toString("base64"));
    });
    this.#outChain = result.catch(() => {});
    return result;
  }

  /** `reason` is a key of CLOSE_REASONS, or text. `notify` tells the far side, which is pointless when it told us. */
  close(reason = "closed", { notify = true } = {}) {
    if (this.closed) return;
    this.closed = true;
    this.state = "closed";
    clearTimeout(this.#timer);
    this.#closing(this, reason, notify);
    this.emit("close", CLOSE_REASONS[reason] ?? String(reason));
  }
}

// ------------------------------------------------------------------------------ recovery keys on the log
// Every call that puts a recovery key on a log, or decides a log may be recovered, is here and nowhere else.

const startLog = ({ device, recovery }) => createLog({ device, recovery });

const recoverOnto = (entries, device, { current, next, addedAt }) => append(entries, { type: "recover", ...device, newRecovery: next, addedAt }, current);

/** Whether a log the hub gave is one this code may recover. Asked before anything is signed for it. */
const mayRecover = (entries, recovery) => canRecover(entries, recovery.signPub);

// ------------------------------------------------------------------------------ the account

const ALERT_TEXT = {
  rollback: "The hub offered an older copy of the device list than this computer already has. It was refused: someone may be hiding a removal.",
  fork: "The hub showed a device list that differs from this computer's at the same position. It was refused: the hub may be showing different lists to different devices.",
  "different-account": "The hub showed the device list of a different account. It was refused.",
  "bad-log": "A device list failed its signature checks and was refused.",
  "fake-log": "This computer was told it was approved, but the device list does not follow the approval code you confirmed. It was refused, and this computer stays out of the account.",
  "log-unreconciled": "Another device has a device list this computer cannot get from the hub. The channel was refused: the hub may be hiding a change.",
  removed: "This device is no longer on the account.",
  recovered: "A device recovered this account with the recovery code. If that was not you, your recovery code is out and that device has full control.",
  "channel-failure": "An encrypted channel failed its check and was closed. A frame was changed, lost or replayed on the way.",
  "approval-failed": "An approval exchange failed its check and was abandoned. No code from it is shown.",
  "refused-by-device": "A device on your account refused this computer, so the two hold different device lists. The hub may be hiding a change from one of them, or this computer may have been removed.",
  "hub-says-removed": "The hub says this device was removed from the account. This computer's own device list does not show that, so do not forget this device on the hub's word alone. If it stays disconnected, sign in again.",
  "key-unavailable": "This computer's account keys could not be opened. Nothing was changed. To start over, sign out and forget this device.",
};

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
  #exchange = null;       // on a new device: { from, core, head, code, confirmed }
  #attempts = 0;
  #exchangeFailed = false;
  #recoveryAt = null;     // the position of this device's own recover, until another device shows it holds that entry
  #acceptExchange = true; // one exchange per press of the person's button: a hub cannot try again by itself
  #approvedByHub = false;
  #channels = new Map();
  #dirReady = null;
  #started = null;
  #stopped = false;
  #ws = null;
  #connected = false;
  #connectAttempts = 0;
  #hubError = null;
  #reconnectTimer = null;
  #nonce = null;
  #waiters = [];
  #syncing = null;
  #logLock = Promise.resolve();
  #approvalChain = Promise.resolve();
  #auditChain = Promise.resolve();
  #auditSize = null;
  #alertsWrite = Promise.resolve();
  #alertsQueued = false;
  #candidate = null;      // { kind, entries }: a log sent, or about to be sent, to the hub and not yet known to have landed
  #registerAttempt = null;
  #codeHandedOut = false;
  #codeNotShown = false;
  #hubClaimedRemoved = false;
  #sentInWindow = 0;
  #windowStart = 0;
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
      hub: { url: this.hubUrl, connected: this.#connected, attempts: this.#connectAttempts, lastError: this.#hubError },
      logHead: this.#hashes.at(-1) ?? null,
      logVersion: this.#hashes.length,
      pending: this.#phase === "pending" ? { code: this.#exchange?.code ?? null, attempts: this.#attempts, failed: this.#exchangeFailed, confirmed: !!this.#exchange?.confirmed, approvedByHub: this.#approvedByHub } : null,
      review: this.#review ? { ...this.#reviewView() } : null,
      allowWebAccess: this.#settings.allowWebAccess,
      keyProtection,
      warnings: [...this.#warnings, ...(keyProtection.warning ? [keyProtection.warning] : [])],
      alerts: this.#alerts.slice(),
      recoveries: this.#verified?.recoveries ?? [],
      recoveryUnconfirmed: this.#recoveryAt !== null,
      recoveryCodeNotShown: this.#codeNotShown,
      channels: [...this.#channels.values()].filter((c) => c.state === "open").map((c) => ({ id: c.id, device: c.peerId, name: c.peer.name, direction: c.direction })),
      handshakes: [...this.#channels.values()].filter((c) => c.state === "handshake").length,
    };
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
    if (!allowWebAccess) for (const c of [...this.#channels.values()]) if (c.peer.role === "client") c.close("web-access-off");
    this.#changed();
    return this.settings();
  }

  #changed() { this.emit("status", this.status()); }

  #alert(kind, detail) {
    const key = LASTING_ALERTS.has(kind) ? `${kind}|${detail ?? ""}` : kind;
    const sameKind = this.#alerts.filter((a) => a.kind === kind);
    const repeat = sameKind.find((a) => a.key === key) ?? (sameKind.length >= MAX_ROWS_PER_KIND ? sameKind.at(-1) : null);
    if (repeat) {
      repeat.count = (repeat.count ?? 1) + 1;
      repeat.lastAt = this.now();
      this.#saveAlerts();
      this.#changed();
      return;
    }
    const alert = { kind, message: ALERT_TEXT[kind] ?? kind, at: this.now(), lastAt: this.now(), count: 1, key };
    this.#alerts = [...this.#alerts, alert];
    this.log(`account alert: ${kind}`);
    this.#saveAlerts();
    this.emit("alert", alert);
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
    const exchange = this.#exchange?.confirmed ? { head: this.#exchange.head, from: this.#exchange.from } : null;
    return this.#writeFile("state.json", JSON.stringify({ v: 1, email: this.#email, name: this.#name, kind: this.#kind, phase: this.#phase, exchange, recoveryAt: this.#recoveryAt, codeNotShown: this.#codeNotShown }));
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
    const candidate = await this.#readJson("log.candidate.json").catch(() => null);
    if (Array.isArray(candidate?.entries)) this.#candidate = { kind: candidate.kind, entries: candidate.entries };
    const state = await this.#readJson("state.json").catch(() => null);
    this.#email = candidate?.email ?? null;
    if (state) {
      this.#codeNotShown = state.codeNotShown === true;
      this.#email = state.email ?? this.#email;
      this.#name = state.name ?? this.#name;
      this.#recoveryAt = Number.isSafeInteger(state.recoveryAt) ? state.recoveryAt : null;
      if (state.exchange?.head) this.#acceptExchange = false;
      if (state.exchange?.head) this.#exchange = { from: state.exchange.from, head: state.exchange.head, code: null, core: null, confirmed: true };
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
    else if (this.#session) this.#phase = this.#candidate?.kind === "recover" ? "recovering" : state?.phase === "pending" ? "pending" : "approved";
    if (this.#phase === "approved" && !this.#verified?.devices.has(this.#keys.signPub)) this.#phase = "pending";
    this.#changed();
    if (this.#session && ["approved", "pending", "recovering"].includes(this.#phase)) this.#connect();
  }

  async stop() {
    this.#stopped = true;
    this.#dropConnection("the app is closing");
    await this.#auditChain.catch(() => {});
    await this.#alertsWrite.catch(() => {});
  }

  #dropConnection(reason) {
    clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
    const ws = this.#ws;
    this.#ws = null;
    this.#connected = false;
    try { ws?.close(); } catch { /* it was not open */ }
    this.#closeAllChannels(reason);
    this.#failWaiters(new AccountError(503, "hub-unreachable", "The hub connection was lost."));
  }

  #closeAllChannels(reason) {
    for (const channel of [...this.#channels.values()]) channel.close(reason);
  }

  // ---------------------------------------------------------------------------- the hub over HTTP

  async #post(path, body) {
    let response;
    try {
      response = await this.fetchImpl(new URL(path, this.hubUrl), {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(this.limits.httpTimeoutMs),
      });
    } catch {
      throw new AccountError(503, "hub-unreachable", "The hub cannot be reached.");
    }
    let parsed = {};
    try { parsed = await response.json(); } catch { /* an error page: its status is enough */ }
    if (!response.ok) {
      const code = safeCode(parsed.error);
      throw new AccountError(response.status, code, hubErrorText(code));
    }
    return parsed;
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
    // A registration from before a kill may have reached the hub. If this password opens it, that is the account.
    if (this.#candidate?.kind === "register" && !this.#registerAttempt && await this.#resumeRegistration(email, password)) {
      return { recoveryCode: null, signedIn: true, resumed: true };
    }
    // A retry after no answer sends the same thing, so that if the first one landed its code is the code that counts.
    const retry = this.#registerAttempt?.email === email ? this.#registerAttempt : null;
    const { recoveryCode, entries, salt } = retry ?? await this.#newRegistration(email);
    const loginKey = await this.#loginKey(password, salt);
    const token = await this.#bootstrapToken();
    await this.#writeCandidate("register", email, entries); // nothing has been sent if this fails
    let accepted = true;
    try {
      await this.#post("/api/register", { email, salt: toB64(salt), verifierInput: loginKey, firstLogEntry: entries[0], ...(token ? { bootstrapToken: token } : {}) });
    } catch (error) {
      if (error.code === "hub-unreachable") throw error;
      if (!retry) {
        this.#registerAttempt = null;
        await this.#dropCandidate();
        throw error;
      }
      accepted = false;
      this.#registerAttempt = null;
      // Refused the second time: the first may have landed. The login below tells.
      const state = await this.#login(email, loginKey).catch(() => null);
      if (state !== "approved") {
        await this.#dropCandidate();
        throw error;
      }
    }
    this.#registerAttempt = null;
    // The account exists now. From here nothing may stop the person getting this code: it is never shown again.
    this.#email = email;
    this.#codeHandedOut = true;
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

  async #resumeRegistration(email, password) {
    const salt = await this.#saltFor(email);
    let state;
    try {
      state = await this.#login(email, await this.#loginKey(password, salt));
    } catch (error) {
      if (error.code === "hub-unreachable") throw error;
      return false;
    }
    if (state !== "approved") {
      await this.#forgetSession();
      return false;
    }
    this.#phase = "pending";
    await this.#tryLocal(() => this.#persistState(), LOG_NOT_SAVED);
    this.#connect();
    return true;
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

  async #writeCandidate(kind, email, entries) {
    await this.#writeFile("log.candidate.json", JSON.stringify({ v: 1, kind, email, entries }));
    this.#candidate = { kind, entries };
  }

  async #dropCandidate() {
    this.#candidate = null;
    await fs.rm(join(this.dir, "log.candidate.json"), { force: true }).catch(() => {});
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
    const saved = await this.#adopt(entries, verified, { bestEffort: true }).catch(() => {
      this.#warnings.add(LOG_NOT_SAVED);
      return false;
    });
    if (saved) await this.#dropCandidate();
    return saved;
  }

  /**
   * On reconnecting with a log that may have reached the hub. If the hub holds it, that log is this computer's, and its
   * one-time code was lost unless it was handed out before. If not, nothing happened and the old recovery code stands.
   */
  async #resolveCandidate(hubState) {
    const candidate = this.#candidate;
    if (!candidate) return;
    const notThere = async (message) => {
      await this.#dropCandidate();
      if (this.#phase !== "recovering") return;
      this.#phase = "signed-out";
      this.#recoveryAt = null;
      this.#hubError = message;
      this.#dropConnection("signed-out");
      await this.#tryLocal(() => this.#forgetSession(), LOG_NOT_SAVED);
      await this.#tryLocal(() => this.#persistState(), LOG_NOT_SAVED);
      this.#changed();
    };
    if (hubState !== "approved") return notThere("The recovery did not reach the hub. Your old recovery code still works.");
    const reply = await this.#rpc({ type: "log.get" }, ["log"]);
    let verified, verdict;
    try {
      verified = await this.verifyLogImpl(reply.entries, { now: this.now() });
      verdict = await compareLogs(candidate.entries, reply.entries);
    } catch (error) {
      if (!(error instanceof LogError)) throw error;
      this.#alert("bad-log");
      return;
    }
    if (verdict !== "same" && verdict !== "b-newer") return notThere("The recovery did not reach the hub. Your old recovery code still works.");
    if (await this.#adopt(reply.entries, verified, { bestEffort: true })) await this.#dropCandidate();
    if (!this.#codeHandedOut) {
      this.#codeNotShown = true;
      this.#warnings.add("Omni stopped before it could show this account's new recovery code, and it cannot be shown again. This computer keeps full control, but the account has no recovery code you know.");
    }
    if (candidate.kind === "recover") this.#recoveryAt ??= candidate.entries.length - 1;
    this.#phase = "approved";
    await this.#tryLocal(() => this.#persistState(), LOG_NOT_SAVED);
    this.#changed();
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
      if (!this.#verified?.devices.has(this.#keys.signPub) && !this.#candidate) {
        this.#alert("fake-log", "no-anchor");
        await this.#forgetSession();
        throw new AccountError(409, "no-anchor", "The hub says this device is on the account, but this computer holds no log to check that against. Sign out and forget this device to sign in again as a new one.");
      }
      this.#phase = this.#verified?.devices.has(this.#keys.signPub) ? "approved" : "pending";
    } else {
      this.#phase = "pending";
      this.#attempts = 0;
      this.#exchangeFailed = false;
      this.#acceptExchange = true;
      this.#exchange = null;
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
    this.#exchange = null;
    this.#review = null;
    this.#rows = [];
    this.#online = new Set();
    this.#approvedByHub = false;
    this.#hubError = null;
    if (forget) {
      for (const file of ["keys.json", "log.json", "state.json"]) await fs.rm(join(this.dir, file), { force: true });
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
    if (this.#stopped || !this.#session || this.#ws) return;
    clearTimeout(this.#reconnectTimer);
    let ws;
    try {
      ws = new this.WebSocketImpl(`${this.hubUrl.replace(/^http/, "ws")}/ws`);
    } catch {
      this.#scheduleReconnect();
      return;
    }
    this.#ws = ws;
    const timeout = setTimeout(() => {
      if (this.#ws === ws && !this.#connected) {
        this.#hubError = "The hub did not answer.";
        this.#onSocketGone(ws, 0);
      }
    }, this.limits.connectTimeoutMs);
    timeout.unref?.();
    ws.onopen = () => { if (this.#ws === ws) this.#sendNow({ type: "auth", session: this.#session }); };
    ws.onmessage = (event) => {
      if (this.#ws !== ws) return;
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (typeof message === "object" && message !== null) this.#dispatch(message, timeout);
    };
    ws.onerror = () => {};
    ws.onclose = (event) => { clearTimeout(timeout); this.#onSocketGone(ws, event?.code ?? 0); };
  }

  #onSocketGone(ws, code) {
    if (this.#ws !== ws) return;
    this.#ws = null;
    this.#connected = false;
    try { ws.close(); } catch { /* */ }
    this.#closeAllChannels("the hub connection was lost");
    this.#failWaiters(new AccountError(503, "hub-unreachable", "The hub connection was lost."));
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
        this.#scheduleReconnect();
        return;
      case CLOSE_SESSION_GONE:
        this.#settle("signed-out", this.#hubClaimedRemoved ? HUB_CLAIMS_REMOVED : "The hub no longer knows this session. Sign in again.");
        return;
      default:
        this.#hubError ??= "The hub connection was lost.";
        this.#scheduleReconnect();
    }
  }

  /** The hub ended this session for good. */
  #settle(phase, message) {
    this.#phase = phase;
    this.#hubError = message;
    this.#forgetSession().then(() => this.#persistState()).catch(() => {});
    this.#changed();
  }

  #scheduleReconnect() {
    if (this.#stopped || !this.#session || this.#reconnectTimer) return;
    this.#connectAttempts++;
    const ceiling = Math.min(this.reconnect.maxMs, this.reconnect.minMs * 2 ** Math.min(this.#connectAttempts - 1, 16));
    const delay = ceiling / 2 + Math.random() * (ceiling / 2);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#connect();
    }, delay);
    this.#reconnectTimer.unref?.();
    this.#changed();
  }

  #sendNow(message) {
    if (!this.#ws || this.#ws.readyState !== 1) throw new AccountError(503, "hub-unreachable", "The hub is not connected.");
    this.#ws.send(JSON.stringify(message));
  }

  /** For traffic that can burst: stays under the hub's frame rate, and waits while the socket's own queue is high. */
  async #sendPaced(message) {
    for (;;) {
      const now = Date.now();
      if (now - this.#windowStart >= SECOND) {
        this.#windowStart = now;
        this.#sentInWindow = 0;
      }
      if (this.#sentInWindow < this.limits.messagesPerSecond) break;
      await sleep(this.#windowStart + SECOND - now);
    }
    this.#sentInWindow++;
    while ((this.#ws?.bufferedAmount ?? 0) > this.limits.maxBufferedBytes) await sleep(5);
    this.#sendNow(message);
  }

  #rpc(message, replyTypes) {
    return new Promise((resolve, reject) => {
      const waiter = { replyTypes, for: message.type, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.#waiters = this.#waiters.filter((w) => w !== waiter);
        reject(new AccountError(504, "hub-timeout", "The hub did not answer in time."));
      }, this.limits.rpcTimeoutMs);
      waiter.timer.unref?.();
      this.#waiters.push(waiter);
      try {
        this.#sendNow(message);
      } catch (error) {
        clearTimeout(waiter.timer);
        this.#waiters = this.#waiters.filter((w) => w !== waiter);
        reject(error);
      }
    });
  }

  #failWaiters(error) {
    for (const waiter of this.#waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  #answerWaiter(message) {
    const isError = message.type === "error";
    const at = this.#waiters.findIndex((w) => (isError ? w.for === message.for : w.replyTypes.includes(message.type)));
    if (at < 0) return false;
    const [waiter] = this.#waiters.splice(at, 1);
    clearTimeout(waiter.timer);
    if (isError) {
      const code = safeCode(message.code);
      waiter.reject(new AccountError(Object.hasOwn(HUB_CODE_STATUS, code) ? HUB_CODE_STATUS[code] : 502, code, hubErrorText(code)));
    }
    else waiter.resolve(message);
    return true;
  }

  #dispatch(message, connectTimer) {
    switch (message.type) {
      case "auth.challenge": return void this.#onChallenge(message);
      case "auth.ok": clearTimeout(connectTimer); return void this.#onAuthOk(message);
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
        this.#answerWaiter(message);
        this.emit("approval", this.pendingSignIns());
        this.#changed();
        return undefined;
      case "presence":
        this.#online = new Set(Array.isArray(message.online) ? message.online.filter((k) => typeof k === "string") : []);
        for (const channel of [...this.#channels.values()]) {
          if (channel.state === "open" && !this.#online.has(channel.peerId)) channel.close("the other device went offline", { notify: false });
        }
        this.#answerWaiter(message);
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
          for (const channel of [...this.#channels.values()]) {
            if (channel.peerId === message.to) channel.close(message.code === "busy" ? "the other device is not reading, so the channel was closed" : "the other device cannot be reached", { notify: false });
          }
          return undefined;
        }
        this.#answerWaiter(message);
        return undefined;
      default:
        this.#answerWaiter(message);
        return undefined;
    }
  }

  async #onChallenge({ nonce }) {
    if (typeof nonce !== "string" || !this.#keys) return;
    this.#nonce = nonce;
    const sig = await sign(this.#keys.sign.privateKey, encoder.encode(`${AUTH_DOMAIN} ${this.hubOrigin} ${nonce}`));
    try { this.#sendNow({ type: "auth.proof", sig }); } catch { /* the socket went while signing */ }
  }

  async #onAuthOk({ state }) {
    this.#connected = true;
    this.#connectAttempts = 0;
    this.#hubError = null;
    this.#hubClaimedRemoved = false;
    this.#changed();
    if (this.#candidate) {
      try {
        await this.#resolveCandidate(state);
      } catch { /* the socket went: the next connection does this again */ }
    }
    if (this.#phase === "approved") {
      try {
        await this.syncLog();
        this.#sendNow({ type: "presence" });
        if (this.#role() === "full") this.#sendNow({ type: "pending.list" });
      } catch { /* the socket went: the next connection does this again */ }
    } else if (this.#phase === "pending" && state === "approved") {
      this.#approvedByHub = true;
      this.#tryFinishApproval();
    }
    for (const waiter of this.#socketWaiters.splice(0)) waiter();
  }

  #socketWaiters = [];

  #whenConnected() {
    if (this.#connected) return Promise.resolve();
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
    this.#recheckChannels();
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
      let verified;
      try {
        verified = await this.verifyLogImpl(entries, { now: this.now() });
      } catch (error) {
        if (!(error instanceof LogError)) throw error;
        this.#alert("bad-log", error.message);
        return "bad-log";
      }
      const verdict = await compareLogs(this.#log, entries);
      switch (verdict) {
        case "same": return "same";
        case "b-newer": await this.#adopt(entries, verified); return "adopted";
        case "a-newer": this.#alert("rollback", String(verified.head)); return "rollback";
        case "fork": this.#alert("fork", String(verified.head)); return "fork";
        default: this.#alert("different-account", String(verified.accountId)); return "different-account";
      }
    });
    this.#logLock = run.catch(() => {});
    return run;
  }

  /** Asks the hub for the log. The heads are compared first, since a replay is costly. */
  syncLog() {
    this.#syncing ??= (async () => {
      try {
        const reply = await this.#rpc({ type: "log.get" }, ["log"]);
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
    const reply = await this.#rpc({ type: "log.append", prevHead: entry.prev, entry }, ["log.ok", "log.conflict"]);
    if (reply.type === "log.conflict") {
      await this.#considerLog(reply.entries);
      return "conflict";
    }
    const verified = await this.verifyLogImpl(entries, { now: this.now() });
    if (reply.head !== verified.head) this.log("account: the hub's head differs from the appended entry's");
    await new Promise((resolve, reject) => {
      this.#logLock = this.#logLock.then(() => this.#adopt(entries, verified)).then(resolve, reject);
    });
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
      this.#sendNow({ type: "approval.msg", to: row.signPub, opaque: encodeOuter({ t: "commit", commit: exchange.commit, logHead: head }) });
      const { random, claim, sig } = await arrived;
      if (!this.#review || this.#review.id !== id) throw new AccountError(409, "review-ended", "This review was ended.");
      if (!await this.#claimVerifies(claim, sig, row.signPub, head)) throw new AccountError(502, "bad-claim", "The new device's details did not carry a valid signature, so this sign-in was not trusted.");
      exchange.receiveRandom(random);
      this.#sendNow({ type: "approval.msg", to: row.signPub, opaque: encodeOuter({ t: "reveal", random: exchange.revealRandom() }) });
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
      this.#sendPaced({ type: "channel.msg", to: device.id, opaque: encodeOuter({ t: "review", id }) }).catch(() => {});
    }
  }

  #claimBytes(claim, head, approverPub) {
    return encoder.encode(JSON.stringify([CLAIM_DOMAIN, claim.name, claim.kind, claim.boxPub, approverPub, head]));
  }

  async #claimVerifies(claim, sig, signPub, head) {
    if (typeof claim !== "object" || claim === null) return false;
    for (const field of ["name", "kind", "boxPub"]) if (typeof claim[field] !== "string" || !claim[field]) return false;
    return verify(signPub, this.#claimBytes(claim, head, this.#keys.signPub), sig);
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
    await this.#rpc({ type: "pending.deny", id }, ["pending.denied"]);
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
    if (outer.t === "commit") return this.#onCommit(from, outer);
    if (outer.t === "reveal" && this.#exchange?.from === from && this.#exchange.core) return this.#onReveal(outer);
  }

  async #onCommit(from, { commit, logHead }) {
    // Only the person starts another exchange: otherwise a hub could keep trying values, and could replace one already confirmed.
    if (!this.#acceptExchange) return;
    this.#acceptExchange = false;
    this.#attempts++;
    this.#changed();
    let core;
    try {
      core = await newDeviceExchange({ approverPub: from, newPub: this.#keys.signPub, logHead });
      core.receiveCommit(commit);
    } catch {
      this.#failExchange();
      return;
    }
    this.#exchange = { from, core, head: logHead, code: null, confirmed: false };
    const random = core.releaseRandom();
    const claim = { name: this.#name, kind: this.#kind, boxPub: this.#keys.boxPub };
    const sig = await sign(this.#keys.sign.privateKey, encoder.encode(JSON.stringify([CLAIM_DOMAIN, claim.name, claim.kind, claim.boxPub, from, logHead])));
    this.#sendNow({ type: "approval.msg", to: from, opaque: encodeOuter({ t: "random", random, claim, sig }) });
  }

  async #onReveal({ random }) {
    const exchange = this.#exchange;
    try {
      await exchange.core.receiveReveal(random);
      exchange.code = await exchange.core.code();
      exchange.core = null;
      this.#changed();
    } catch {
      this.#failExchange();
    }
  }

  /** It ends here, visibly. No code from it is ever shown, and nothing starts again until the person says so. */
  #failExchange() {
    this.#exchange = null;
    this.#exchangeFailed = true;
    this.#alert("approval-failed", String(this.#attempts));
    this.#changed();
  }

  /** The person's button on a new device: after a failed exchange, or a code that did not match. Forgets any code held. */
  restartExchange() {
    if (this.#phase !== "pending") throw new AccountError(409, "not-pending", "This computer is not waiting for approval.");
    this.#exchange = null;
    this.#exchangeFailed = false;
    this.#acceptExchange = true;
    this.#persistState().catch(() => {});
    this.#changed();
    return this.status();
  }

  /**
   * The person at this computer checked that the code here matches the approving device's. Without this step, a hacked
   * hub could play the approver on its own and hand this computer a made-up account whose devices it then controls:
   * the log would follow the head of an exchange that was real, just not with any device of the person's.
   */
  confirmCode(code) {
    if (this.#phase !== "pending" || !this.#exchange?.code) throw new AccountError(409, "no-code", "There is no code to confirm yet.");
    if (code !== this.#exchange.code) throw new AccountError(400, "wrong-code", "That is not the code shown on this computer.");
    this.#exchange.confirmed = true;
    this.#persistState().catch(() => {});
    this.#changed();
    this.#tryFinishApproval();
    return this.status();
  }

  async #tryFinishApproval() {
    if (this.#phase !== "pending" || !this.#approvedByHub) return;
    const exchange = this.#exchange;
    if (!exchange?.code && !exchange?.confirmed) {
      this.#alert("fake-log", "no-code");
      return;
    }
    if (!exchange.confirmed) return;
    let reply;
    try {
      reply = await this.#rpc({ type: "log.get" }, ["log"]);
    } catch {
      return; // the next connection tries again
    }
    if (this.#phase !== "pending" || this.#exchange !== exchange) return;
    const entries = reply.entries;
    let verified;
    try {
      verified = await this.verifyLogImpl(entries, { now: this.now() });
    } catch (error) {
      if (!(error instanceof LogError)) throw error;
      this.#alert("fake-log", "invalid");
      return;
    }
    // The add naming this device, right after the head in the code and signed by the key in the code.
    const me = this.#keys.signPub;
    const added = entries.findIndex((entry) => entry.type === "add" && entry.body.signPub === me);
    const follows = added > 0 && entries[added].prev === exchange.head && entries[added].signer === exchange.from;
    if (!follows || !verified.devices.has(me)) {
      this.#alert("fake-log", String(verified.head));
      return;
    }
    if (this.#log) {
      const verdict = await compareLogs(this.#log, entries);
      if (verdict !== "b-newer" && verdict !== "same") {
        this.#alert(verdict === "a-newer" ? "rollback" : verdict === "fork" ? "fork" : "different-account", String(verified.head));
        return;
      }
    }
    await this.#adopt(entries, verified);
    this.#phase = "approved";
    this.#exchange = null;
    this.#approvedByHub = false;
    await this.#persistState();
    this.#changed();
    try {
      this.#sendNow({ type: "presence" });
      if (this.#role() === "full") this.#sendNow({ type: "pending.list" });
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
    const salt = await this.#saltFor(email);
    await this.#login(email, await this.#loginKey(password, salt));
    this.#phase = "recovering";
    this.#connect();
    try {
      await this.#whenConnected();
      const proof = await sign(recovery.sign.privateKey, encoder.encode(`${RECOVERY_DOMAIN} ${this.hubOrigin} ${this.#nonce}`));
      const nextCode = newRecoveryCode();
      const next = await recoveryKeysFrom(nextCode);
      for (let attempt = 0; attempt < 3; attempt++) {
        let reply;
        try {
          reply = await this.#rpc({ type: "log.get", recoveryProof: proof }, ["log"]);
        } catch (error) {
          if (error.code === "forbidden") throw new AccountError(403, "wrong-code", "That recovery code does not belong to this account, or has been used.");
          throw error;
        }
        const entries = await this.#checkedRecoveryLog(reply.entries, recovery);
        const appended = await recoverOnto(entries, { name: this.#name, kind: this.#kind, signPub: this.#keys.signPub, boxPub: this.#keys.boxPub }, { current: recovery, next, addedAt: this.now() });
        await this.#writeCandidate("recover", email, appended); // nothing has been sent if this fails: the old code stands
        let answer;
        try {
          answer = await this.#rpc({ type: "log.append", prevHead: entries.at(-1) ? await entryHash(entries.at(-1)) : "", entry: appended.at(-1) }, ["log.ok", "log.conflict"]);
        } catch (error) {
          // No answer: the old code may be dead already. The person gets the new one and keeps both until the reconnect settles it.
          if (error.code === "hub-unreachable" || error.code === "hub-timeout") return this.#recoveryInDoubt(nextCode, appended);
          throw error;
        }
        if (answer.type === "log.conflict") {
          await this.#dropCandidate();
          continue;
        }
        return this.#finishRecovery(nextCode, appended);
      }
      throw new AccountError(409, "log-conflict", "The device list keeps changing. Try again.");
    } catch (error) {
      await this.#dropCandidate();
      this.#phase = "signed-out";
      this.#dropConnection("signed-out");
      await this.#forgetSession().catch(() => {});
      if (error instanceof LogError) throw new AccountError(400, "cannot-recover", error.message);
      throw error;
    }
  }

  /** The hub has the entry, so the old code is dead. Never throws: losing this code could leave the account with none. */
  async #finishRecovery(nextCode, appended) {
    this.#codeHandedOut = true;
    this.#phase = "approved";
    // Until another device shows it holds this entry, the hub may have shown an older log and this new code may not count.
    this.#recoveryAt = appended.length - 1;
    await this.#settleCommitted(appended);
    await this.#tryLocal(() => this.#persistState(), LOG_NOT_SAVED);
    try {
      this.#sendNow({ type: "presence" });
      this.#sendNow({ type: "pending.list" });
    } catch { /* the next connection does this */ }
    this.#changed();
    return { recoveryCode: nextCode, confirmed: true };
  }

  async #recoveryInDoubt(nextCode, appended) {
    this.#codeHandedOut = true;
    this.#recoveryAt = appended.length - 1;
    await this.#tryLocal(() => this.#persistState(), LOG_NOT_SAVED);
    // Reconnecting says which: an approved session means the hub has the entry.
    try { this.#ws?.close(); } catch { /* it has gone */ }
    if (!this.#ws) this.#connect();
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
    await this.#rpc({ type: "password.change", currentLoginKey, salt: toB64(salt), verifierInput }, ["password.changed"]);
    return { ok: true };
  }

  // ---------------------------------------------------------------------------- channels

  #channelKey(peerId, id) { return `${peerId}|${id}`; }

  #countFor(peerId) {
    return [...this.#channels.values()].filter((c) => c.peerId === peerId).length;
  }

  #newChannel(id, peerId, direction) {
    const channel = new Channel({
      id, peerId, direction,
      send: (ch, d) => this.#sendPaced({ type: "channel.msg", to: ch.peerId, opaque: encodeOuter({ c: ch.id, t: "data", d }) }),
      closing: (ch, reason, notify) => this.#onChannelClosing(ch, reason, notify),
    });
    this.#channels.set(this.#channelKey(peerId, id), channel);
    return channel;
  }

  #onChannelClosing(channel, reason, notify) {
    this.#channels.delete(this.#channelKey(channel.peerId, channel.id));
    if (notify && this.#connected && Object.hasOwn(CLOSE_REASONS, reason)) {
      this.#sendPaced({ type: "channel.msg", to: channel.peerId, opaque: encodeOuter({ c: channel.id, t: "close", reason }) }).catch(() => {});
    }
    channel.rejectOpening?.(new AccountError(502, "channel-refused", CLOSE_REASONS[reason] ?? String(reason)));
    this.emit("channel-closed", channel);
    this.#changed();
  }

  /** A device still current on the log, or null. An unknown one may just be news, so the log is fetched once to see. */
  async #currentDevice(peerId) {
    const known = () => {
      const device = this.#verified?.devices.get(peerId);
      return device && deviceCurrent(device, this.now()) ? device : null;
    };
    if (known()) return known();
    try { await this.syncLog(); } catch { return null; }
    return known();
  }

  /** The reason this device may not hold a channel here, or null. */
  async #whyRefused(peerId, direction) {
    if (this.#phase !== "approved") return "unavailable";
    const device = await this.#currentDevice(peerId);
    if (!device) return "not-on-log";
    if (direction === "in" && device.role === "client" && !this.#settings.allowWebAccess) return "web-access-off";
    return null;
  }

  /** Opens a channel to another machine on the account. */
  async openChannel(deviceId) {
    if (this.#phase === "log-damaged") throw new AccountError(409, "log-damaged", "The device log on this computer is damaged.");
    if (this.#phase !== "approved" || !this.#connected) throw new AccountError(409, "not-connected", "This computer is not connected to the account.");
    const peerDevice = await this.#currentDevice(deviceId);
    if (!peerDevice) throw new AccountError(404, "no-such-device", "That device is not on the account.");
    if (deviceId === this.#keys.signPub) throw new AccountError(400, "self", "This is this computer.");
    const id = toB64(globalThis.crypto.getRandomValues(new Uint8Array(16)));
    const channel = this.#newChannel(id, deviceId, "out");
    channel.peer = { id: deviceId, name: peerDevice.name, kind: peerDevice.kind, role: peerDevice.role };
    const opened = new Promise((resolve, reject) => {
      channel.resolveOpening = resolve;
      channel.rejectOpening = reject;
    });
    opened.catch(() => {});
    this.#armHandshakeTimer(channel);
    try {
      channel.handshake = await startHandshake({ device: this.#keys, peerPub: deviceId, logHead: this.#hashes.at(-1) });
      await this.#sendPaced({ type: "channel.msg", to: deviceId, opaque: encodeOuter({ c: id, t: "hello", ...channel.handshake.hello }) });
    } catch (error) {
      channel.close(error.message, { notify: false });
      throw error;
    }
    return opened;
  }

  #armHandshakeTimer(channel) {
    const timer = setTimeout(() => {
      if (channel.state === "handshake") channel.close("the other device did not finish connecting", { notify: false });
    }, this.limits.handshakeTimeoutMs);
    timer.unref?.();
    channel.setTimer(timer);
  }

  #onChannelMessage(from, opaque) {
    const outer = decodeOuter(opaque);
    if (!outer) return;
    if (outer.t === "review") {
      const device = this.#verified?.devices.get(from);
      if (device?.role === "full" && this.#rows.some((row) => row.id === outer.id)) {
        this.#reviewHints.set(outer.id, device.name);
        this.emit("approval", this.pendingSignIns());
      }
      return;
    }
    if (typeof outer.c !== "string" || outer.c.length > 64) return;
    const channel = this.#channels.get(this.#channelKey(from, outer.c));
    if (!channel) {
      if (outer.t === "hello") this.#onHello(from, outer);
      return;
    }
    const size = opaque.length;
    let queued;
    switch (outer.t) {
      case "hello": queued = channel.enqueue(size, () => this.#finishHandshake(channel, outer), this.limits.maxInboundBytes); break;
      case "proof": queued = channel.enqueue(size, () => this.#onProof(channel, outer), this.limits.maxInboundBytes); break;
      case "data": queued = channel.enqueue(size, () => this.#onData(channel, outer), this.limits.maxInboundBytes); break;
      case "close":
        // Being told no by a device this computer trusts means the two logs disagree: a security matter, not a plain error.
        if (DISAGREEMENT_REASONS.has(outer.reason) && this.#verified?.devices.has(from)) {
          this.#alert("refused-by-device", `${from}|${outer.reason}`);
          this.syncLog().catch(() => {});
        }
        channel.close(Object.hasOwn(CLOSE_REASONS, outer.reason) ? outer.reason : "closed", { notify: false });
        return;
      default: return;
    }
    if (!queued) channel.close("closed");
  }

  /** Another device opens a channel to this one. Checked before any key work is done for it. */
  #onHello(from, outer) {
    const refuse = (reason) => this.#sendPaced({ type: "channel.msg", to: from, opaque: encodeOuter({ c: outer.c, t: "close", reason }) }).catch(() => {});
    if (this.#phase !== "approved") return refuse("unavailable");
    if (this.#countFor(from) >= this.limits.maxChannelsPerDevice || this.#channels.size >= this.limits.maxChannels) return refuse("busy");
    const channel = this.#newChannel(outer.c, from, "in");
    this.#armHandshakeTimer(channel);
    channel.enqueue(0, async () => {
      const reason = await this.#whyRefused(from, "in");
      if (reason) {
        channel.close(reason);
        return;
      }
      const device = this.#verified.devices.get(from);
      channel.peer = { id: from, name: device.name, kind: device.kind, role: device.role };
      channel.handshake = await startHandshake({ device: this.#keys, peerPub: from, logHead: this.#hashes.at(-1) });
      await this.#sendPaced({ type: "channel.msg", to: from, opaque: encodeOuter({ c: outer.c, t: "hello", ...channel.handshake.hello }) });
      await this.#finishHandshake(channel, outer);
    }, this.limits.maxInboundBytes);
    return undefined;
  }

  async #finishHandshake(channel, hello) {
    if (channel.core || !channel.handshake) return;
    try {
      channel.core = await channel.handshake.finish({ eph: hello.eph, logHead: hello.logHead });
      await this.#sendPaced({ type: "channel.msg", to: channel.peerId, opaque: encodeOuter({ c: channel.id, t: "proof", proof: channel.core.proof }) });
    } catch {
      channel.close("the handshake failed", { notify: false });
    }
  }

  async #onProof(channel, { proof }) {
    if (!channel.core || channel.state !== "handshake") return;
    try {
      await channel.core.confirm(proof);
    } catch {
      this.#alert("channel-failure", channel.id);
      channel.close("frame-failed");
      return;
    }
    // The log heads were signed in the transcript, so this is what the other device really holds.
    if (this.#recoveryAt !== null && this.#hashes.indexOf(channel.core.peerLogHead) >= this.#recoveryAt) this.#recoveryConfirmed();
    const reconciled = await this.#reconcile(channel.core.peerLogHead, channel);
    if (channel.closed) return;
    if (!reconciled) {
      channel.close("log-mismatch");
      return;
    }
    const reason = await this.#whyRefused(channel.peerId, channel.direction);
    if (reason) {
      channel.close(reason);
      return;
    }
    channel.ready.sent = true;
    await channel.sendFrame(encodeFrame(FRAME.READY, 0)).catch(() => {});
    this.#maybeOpen(channel);
  }

  /** The other device's head against this one's. An older head on this chain is fine: that device will catch up itself. */
  async #reconcile(peerHead, channel) {
    const knows = () => this.#hashes.includes(peerHead);
    if (knows()) return true;
    let verdict;
    try { verdict = await this.syncLog(); } catch { verdict = "offline"; }
    if (knows()) return true;
    if (channel.closed) return false; // it timed out while waiting: nothing here was refused
    // A fork or another account has already been named. Otherwise the hub simply will not give what the other device has.
    if (verdict === "same" || verdict === "adopted" || verdict === "offline") this.#alert("log-unreconciled", String(peerHead));
    return false;
  }

  async #onData(channel, { d }) {
    if (!channel.core || typeof d !== "string") return;
    let plain;
    try {
      plain = await channel.core.open(new Uint8Array(Buffer.from(d, "base64")));
    } catch {
      // The core has shut this channel for good: it is evidence of tampering, so it is shown, not retried.
      this.#alert("channel-failure", channel.id);
      channel.close("frame-failed");
      return;
    }
    let frame;
    try { frame = decodeFrame(plain); } catch { channel.close("closed"); return; }
    if (frame.type === FRAME.READY) {
      channel.ready.received = true;
      this.#maybeOpen(channel);
      return;
    }
    if (channel.state !== "open") {
      channel.close("closed"); // nothing but READY may come first
      return;
    }
    channel.deliver(plain);
  }

  #maybeOpen(channel) {
    if (channel.state !== "handshake" || !channel.ready.sent || !channel.ready.received) return;
    channel.state = "open";
    channel.setTimer(null);
    this.#armExpiry(channel);
    this.#changed();
    if (channel.direction === "in") this.emit("channel", channel);
    else channel.resolveOpening?.(channel);
  }

  /** A client's window ends with no event to announce it, so each of its channels has a timer for the moment. */
  #armExpiry(channel) {
    const device = this.#verified?.devices.get(channel.peerId);
    const at = device && deviceExpiresAt(device);
    if (!at) return;
    const timer = setTimeout(() => {
      this.#recheckChannels();
      if (!channel.closed) this.#armExpiry(channel);
    }, Math.min(Math.max(at - this.now(), 10), TIMER_MAX));
    timer.unref?.();
    channel.setTimer(timer);
  }

  /** After any change to who is on the log: a device no longer on it, or past its window, is cut off now. */
  #recheckChannels() {
    const now = this.now();
    for (const channel of [...this.#channels.values()]) {
      const device = this.#verified?.devices.get(channel.peerId);
      if (!device) channel.close("removed");
      else if (!deviceCurrent(device, now)) channel.close("expired");
    }
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

const HUB_ERROR_TEXT = {
  "wrong-credentials": "Wrong email or password.",
  locked: "Too many failed attempts. Try again later.",
  "too-many-pending": "Too many sign-ins are waiting on this account.",
  busy: "The hub is busy. Try again in a moment.",
  "registration-closed": "This hub is not open for registration.",
  "already-registered": "That email is already registered.",
  "bad-email": "That does not look like an email address.",
  conflict: "Another device changed the password first.",
  forbidden: "The hub does not allow this device to do that.",
  "not-found": "That sign-in is no longer waiting.",
  "invalid-entry": "The hub refused the change to the device list.",
};
const hubErrorText = (code) => (Object.hasOwn(HUB_ERROR_TEXT, code) ? HUB_ERROR_TEXT[code] : `The hub refused this (${code}).`);
const HUB_CODE_STATUS = { "wrong-credentials": 401, locked: 429, busy: 503, conflict: 409, forbidden: 403, "not-found": 404, "invalid-entry": 400, "bad-message": 400 };

// ------------------------------------------------------------------------------ the /api/account routes

const need = (value, what) => {
  if (typeof value !== "string" || !value || value.length > 4096) throw new AccountError(400, "bad-request", `${what} is required`);
  return value;
};

/** Every /api/account route. The caller has already checked the window cookie and the Origin. Answers, or throws AccountError. */
export async function handleAccountRoutes(req, res, { p, q, account, send, readBody, streams }) {
  const post = req.method === "POST";
  const get = req.method === "GET";
  const body = post ? await readBody(req) : {};
  await account.start();
  switch (p) {
    case "/api/account/status": if (get) return send(res, 200, account.status()); break;
    case "/api/account/register":
      if (post) return send(res, 200, await account.register({ email: need(body.email, "email"), password: need(body.password, "password"), name: body.name }));
      break;
    case "/api/account/sign-in":
      if (post) return send(res, 200, await account.signIn({ email: need(body.email, "email"), password: need(body.password, "password"), name: body.name }));
      break;
    case "/api/account/confirm-code":
      if (post) return send(res, 200, account.confirmCode(need(body.code, "code")));
      break;
    case "/api/account/restart-exchange":
      if (post) return send(res, 200, account.restartExchange());
      break;
    case "/api/account/sign-out":
      if (post) return send(res, 200, await account.signOut({ forget: body.forget === true }));
      break;
    case "/api/account/devices": if (get) return send(res, 200, { devices: account.devices() }); break;
    case "/api/account/approvals":
      if (get) return send(res, 200, { pending: account.pendingSignIns(), review: account.status().review });
      break;
    case "/api/account/review":
      if (post) return send(res, 200, await account.review(need(body.id, "id")));
      break;
    case "/api/account/approve":
      if (post) return send(res, 200, await account.approve(need(body.id, "id"), { code: body.code, role: body.role }));
      break;
    case "/api/account/deny":
      if (post) return send(res, 200, await account.deny(need(body.id, "id")));
      break;
    case "/api/account/remove":
      if (post) return send(res, 200, await account.remove(need(body.id, "id")));
      break;
    case "/api/account/password":
      if (post) return send(res, 200, await account.changePassword({ current: body.current, next: body.next }));
      break;
    case "/api/account/recover":
      if (post) return send(res, 200, await account.recover({ email: need(body.email, "email"), password: need(body.password, "password"), recoveryCode: need(body.recoveryCode, "recoveryCode"), name: body.name }));
      break;
    case "/api/account/settings":
      if (get) return send(res, 200, account.settings());
      if (post) return send(res, 200, await account.setSettings({ allowWebAccess: body.allowWebAccess }));
      break;
    case "/api/account/audit":
      if (get) return send(res, 200, { lines: await account.auditLines(q.get("limit")) });
      break;
    case "/api/account/alerts/clear":
      if (post) { await account.clearAlerts(); return send(res, 200, { ok: true }); }
      break;
    case "/api/account/events":
      if (get) return accountEvents(req, res, account, streams);
      break;
    default:
  }
  return send(res, 404, { error: "unknown account route" });
}

/** The window's own stream of account events. Not /events, which also goes to other devices. */
function accountEvents(req, res, account, streams) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
  const push = (name) => (data) => { try { res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* it went */ } };
  const listeners = Object.fromEntries(["approval", "devices", "alert", "status"].map((name) => [name, push(name)]));
  for (const [name, listener] of Object.entries(listeners)) account.on(name, listener);
  listeners.status(account.status());
  const beat = setInterval(() => { try { res.write(": ka\n\n"); } catch { /* */ } }, 20_000);
  beat.unref?.();
  streams.add(res);
  req.on("close", () => {
    clearInterval(beat);
    streams.delete(res);
    for (const [name, listener] of Object.entries(listeners)) account.off(name, listener);
  });
}
