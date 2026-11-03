/**
 * The web page's account: its keys, its copy of the device log, its connection to the hub, the new device's side of an approval
 * and the channels it opens. The iPhone app's web view uses this too. Design: docs/superpowers/specs/2026-11-02-omni-accounts-remote-design.md.
 *
 * What a page cannot do is not here to do. It approves nothing, removes nothing, changes no password and signs no log entry, and
 * that holds if the log calls it `full` too: the person may have chosen that by mistake, and nothing here looks. It hosts nothing.
 * It has no recovery. An account is made in the desktop app.
 *
 * A client's window is 30 days, on this page's own clock as well as everyone else's. A key that has left the log can never come
 * back on it, so a page past its 30 days, or removed, drops its keys, and comes back as a new device with fresh ones. The log it
 * has verified stays: that is what refuses a rollback.
 *
 * The rules about the log and an approval are in log-trust.js, shared with the desktop.
 */
import { loginKeyFrom, fromB64, newDeviceKeys, toB64 } from "./account-core.js";
import { deviceCurrent, deviceExpiresAt, entryHash, verifyLog as realVerifyLog } from "./device-log.js";
import { decodeOuter, foreignOuter } from "./channel-frames.js";
import { AccountError } from "./account-error.js";
import { ChannelSet } from "./channel-set.js";
import { Emitter } from "./emitter.js";
import { HubSocket, hubPost } from "./hub-socket.js";
import { NewDeviceApproval, addAlert, checkApprovedLog, judgeLog } from "./log-trust.js";
import { MachineLinks } from "./machine-links.js";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const TIMER_MAX = 2 ** 31 - 1;
const CLOSE_SESSION_GONE = 4401, CLOSE_REMOVED = 4403, CLOSE_PENDING_EXPIRED = 4408, CLOSE_REPLACED = 4409, CLOSE_DENIED = 4410;
const DEFAULT_LIMITS = Object.freeze({
  handshakeTimeoutMs: 35 * SECOND,
  rpcTimeoutMs: 30 * SECOND,
  httpTimeoutMs: 20 * SECOND,
  connectTimeoutMs: 15 * SECOND,
  maxChannels: 64,
  maxChannelsPerDevice: 8,
  maxInboundBytes: 16 * 1024 * 1024,
  messagesPerSecond: 400,            // the hub closes a socket at 500 frames a second
  maxBufferedBytes: 4 * 1024 * 1024, // what may sit in the socket before the sender waits
});

/** This page's words for what ALERT_TEXT says of a computer. */
const PAGE_ALERT_TEXT = Object.freeze({
  rollback: "The hub offered an older copy of the device list than this page already has. It was refused: someone may be hiding a removal.",
  fork: "The hub showed a device list that differs from this page's at the same position. It was refused: the hub may be showing different lists to different devices.",
  "different-account": "The hub showed the device list of a different account. It was refused.",
  "bad-log": "A device list failed its signature checks and was refused.",
  "fake-log": "This page was told it was approved, but the device list does not follow the approval code you confirmed. It was refused, and this page stays out of the account.",
  "log-unreconciled": "Another device has a device list this page cannot get from the hub. The channel was refused: the hub may be hiding a change.",
  removed: "This page is no longer on the account.",
  recovered: "A device recovered this account with the recovery code. If that was not you, your recovery code is out and that device has full control.",
  "channel-failure": "An encrypted channel failed its check and was closed. A frame was changed, lost or replayed on the way.",
  "approval-failed": "An approval exchange failed its check and was abandoned. No code from it is shown.",
  "refused-by-device": "A device on your account refused this page, so the two hold different device lists. The hub may be hiding a change from one of them, or this page may have been removed.",
  "hub-says-removed": "The hub says this page is no longer on the account, and this page's own device list does not show that. If it was not you, check your devices from a desktop or phone app.",
});
const OVER_30_DAYS = "This page's 30 days have run out. Sign in again and approve it from one of your devices. It comes back as a new device, with new keys.";
const NOT_ON_A_PAGE = "A web page cannot do that. Use the desktop or phone app.";
const clip = (value, max) => String(value ?? "").trim().slice(0, max);
const isFiniteDevice = (value) => typeof value === "string" && value.length > 0 && value.length < 4096;

/**
 * Events: status, devices, alert ({kind, message, at}), links (the machines), channel-closed.
 * store: page-store.js. deriveLoginKey(password, salt): the slow key, in a worker on a page.
 */
export class PageAccount extends Emitter {
  #phase = "signed-out";
  #email = null;
  #name;
  #kind;
  #keys = null;
  #session = null;
  #log = null;
  #verified = null;
  #hashes = [];
  #knownRecoveries = 0;
  #alerts = [];
  #online = new Set();
  #approvedByHub = false;
  #approverOnline = null;
  #hubError = null;
  #hubClaimedRemoved = false;
  #hubGaveUp = false; // replaced by another tab: nothing here will reconnect, so nothing should wait for it
  #logLock = Promise.resolve();
  #syncing = null;
  #started = null;
  #expiryTimer = null;
  #approverTimer = null;
  #store;
  #hub;
  #exchange;
  #channels;

  constructor({ store, hubUrl, hubOrigin, now = Date.now, name = "Web page", kind = "web", deriveLoginKey = loginKeyFrom, WebSocketImpl, fetchImpl, reconnect = {}, limits = {}, verifyLogImpl = realVerifyLog, machineLinks = {}, approverPollMs = 5 * SECOND }) {
    super();
    const url = new URL(hubUrl);
    this.hubUrl = url.origin;
    this.hubOrigin = hubOrigin ?? url.origin;
    this.now = now;
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.deriveLoginKey = deriveLoginKey;
    this.fetchImpl = fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.verifyLogImpl = verifyLogImpl;
    this.approverPollMs = approverPollMs;
    this.#name = clip(name, 128) || "Web page";
    this.#kind = clip(kind, 32) || "web";
    this.#store = store;
    this.#hub = new HubSocket({
      hubUrl: this.hubUrl,
      hubOrigin: this.hubOrigin,
      WebSocketImpl: WebSocketImpl ?? globalThis.WebSocket,
      limits: this.limits,
      reconnect: { minMs: reconnect.minMs ?? SECOND, maxMs: reconnect.maxMs ?? MINUTE },
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
      alert: (alertKind, detail) => this.#alert(alertKind, detail),
      persist: () => { this.#saveState().catch(() => {}); },
    });
    this.#channels = new ChannelSet({
      hostsNothing: true,
      limits: this.limits,
      now: () => this.now(),
      keys: () => this.#keys,
      phase: () => this.#phase,
      connected: () => this.#hub.connected,
      verified: () => this.#verified,
      hashes: () => this.#hashes,
      allowWebAccess: () => false,
      syncLog: () => this.syncLog(),
      sendPaced: (message) => this.#hub.sendPaced(message),
      alert: (alertKind, detail) => this.#alert(alertKind, detail),
      emit: (event, ...args) => this.emit(event, ...args),
      changed: () => this.#changed(),
      peerHeadSigned: () => {},
    });
    this.links = new MachineLinks({ account: this, selfName: "this page", ...machineLinks });
    this.links.on("links", (list) => this.emit("links", list));
  }

  // ---------------------------------------------------------------------------- what is shown

  status() {
    const me = this.#keys && this.#verified?.devices.get(this.#keys.signPub);
    return {
      webPage: true,
      signedIn: this.#phase === "approved" || this.#phase === "pending",
      phase: this.#phase,
      email: this.#email,
      accountId: this.#verified?.accountId ?? null,
      device: this.#keys ? { id: this.#keys.signPub, name: this.#name, kind: this.#kind, role: me?.role ?? null, expiresAt: me ? deviceExpiresAt(me) : null } : null,
      hub: { url: this.hubUrl, connected: this.#hub.connected, attempts: this.#hub.attempts, lastError: this.#hubError, gaveUp: this.#hubGaveUp },
      logHead: this.#hashes.at(-1) ?? null,
      logVersion: this.#hashes.length,
      pending: this.#phase === "pending" ? { code: this.#exchange.current?.code ?? null, attempts: this.#exchange.attempts, failed: this.#exchange.failed, confirmed: !!this.#exchange.current?.confirmed, approvedByHub: this.#approvedByHub, approverOnline: this.#approverOnline } : null,
      review: null,
      allowWebAccess: false,
      keyProtection: { kind: "webcrypto", warning: null },
      warnings: [],
      alerts: this.#alerts.slice(),
      recoveries: this.#verified?.recoveries ?? [],
      recoveryUnconfirmed: false,
      recoveryCodePending: false,
      recoveryContested: false,
      channels: this.#channels.all().filter((c) => c.state === "open").map((c) => ({ id: c.id, device: c.peerId, name: c.peer.name, direction: c.direction })),
      handshakes: this.#channels.all().filter((c) => c.state === "handshake").length,
    };
  }

  devices() {
    if (!this.#verified) return [];
    const now = this.now();
    return [...this.#verified.devices.values()].filter((d) => deviceCurrent(d, now)).map((d) => ({
      id: d.signPub, name: d.name, kind: d.kind, role: d.role, addedAt: d.addedAt, expiresAt: deviceExpiresAt(d), online: this.#online.has(d.signPub), self: d.signPub === this.#keys?.signPub,
    }));
  }

  #changed() { this.emit("status", this.status()); }

  #alert(kind, detail) {
    const { alerts, fresh } = addAlert(this.#alerts, kind, detail, this.now(), PAGE_ALERT_TEXT);
    this.#alerts = alerts;
    this.#store.set("alerts", JSON.stringify(alerts)).catch(() => {});
    if (fresh) this.emit("alert", fresh);
    this.#changed();
  }

  async clearAlerts() {
    this.#alerts = [];
    await this.#store.delete("alerts");
    this.#changed();
  }

  // ---------------------------------------------------------------------------- what is kept

  #signedIn() { return this.#phase === "approved" || this.#phase === "pending"; }

  #saveState() {
    return this.#store.set("state", { email: this.#email, name: this.#name, phase: this.#phase, exchange: this.#exchange.saved, knownRecoveries: this.#knownRecoveries, reason: this.#signedIn() ? null : this.#hubError });
  }

  async #ensureKeys() {
    if (this.#keys) return;
    const made = await newDeviceKeys({ extractable: false });
    const kept = { sign: { privateKey: made.sign.privateKey }, box: { privateKey: made.box.privateKey }, signPub: made.signPub, boxPub: made.boxPub };
    await this.#store.set("keys", kept);
    this.#keys = kept;
  }

  /** A key that has left the log can never come back on it. */
  async #dropKeys() {
    this.#keys = null;
    await this.#store.delete("keys");
  }

  async #forgetSession() {
    this.#session = null;
    await this.#store.delete("session");
  }

  // ---------------------------------------------------------------------------- start and stop

  /** Loads what is kept and connects if signed in. */
  start() {
    this.#hub.stopped = false;
    this.#started ??= this.#load();
    return this.#started;
  }

  async #load() {
    try {
      const alerts = JSON.parse((await this.#store.get("alerts")) ?? "[]");
      this.#alerts = Array.isArray(alerts) ? alerts.filter((a) => typeof a?.kind === "string" && typeof a?.key === "string" && typeof a?.message === "string") : [];
    } catch {
      this.#alerts = [];
    }
    const state = await this.#store.get("state");
    if (state) {
      this.#email = state.email ?? null;
      this.#name = state.name ?? this.#name;
      this.#knownRecoveries = Number.isSafeInteger(state.knownRecoveries) ? state.knownRecoveries : 0;
      if (state.exchange?.head) this.#exchange.resume(state.exchange);
      this.#hubError = typeof state.reason === "string" ? state.reason : null; // why this page is at the sign-in, across the reload that follows
    }
    this.#keys = await this.#store.get("keys");
    const entries = await this.#store.get("log");
    if (entries) {
      try {
        const verified = await this.verifyLogImpl(entries, { now: this.now() });
        await this.#setLog(entries, verified);
      } catch {
        this.#phase = "log-damaged";
        this.#alert("bad-log", "store");
        return;
      }
    }
    this.#session = this.#keys ? await this.#store.get("session") : null;
    if (["denied", "expired", "removed"].includes(state?.phase)) this.#phase = state.phase;
    else if (this.#session) this.#phase = state?.phase === "pending" ? "pending" : "approved";
    if (this.#phase === "approved" && !this.#everOnLog(this.#keys.signPub)) this.#phase = "pending";
    if (await this.#leftTheLog()) { this.#changed(); return; }
    this.#armExpiry();
    this.#changed();
    if (this.#session && ["approved", "pending"].includes(this.#phase)) this.#hub.connect();
  }

  async stop() {
    this.#hub.stopped = true;
    clearTimeout(this.#expiryTimer);
    clearInterval(this.#approverTimer);
    this.links.close();
    this.#dropConnection("the page is closing");
  }

  #dropConnection(reason) {
    this.#hub.drop(new AccountError(503, "hub-unreachable", "The hub connection was lost."));
    for (const channel of this.#channels.all()) channel.close(reason);
  }

  // ---------------------------------------------------------------------------- signing in

  async signIn({ email, password, name } = {}) {
    await this.start();
    if (this.#phase === "log-damaged") throw new AccountError(409, "log-damaged", "The device list kept by this page is damaged. Forget this page to start over.");
    if (this.#phase === "approved" || this.#phase === "pending") throw new AccountError(409, "already-signed-in", "This page is already signed in.");
    this.#name = clip(name, 128) || this.#name;
    await this.#ensureKeys();
    const post = (path, body) => hubPost({ fetchImpl: this.fetchImpl, hubUrl: this.hubUrl, timeoutMs: this.limits.httpTimeoutMs }, path, body);
    const { salt } = await post("/api/salt", { email });
    let saltBytes;
    try { saltBytes = fromB64(salt); } catch { throw new AccountError(502, "bad-salt", "The hub gave a salt that makes no sense."); }
    const loginKey = toB64(await this.deriveLoginKey(password, saltBytes));
    const login = async () => {
      const { session, state } = await post("/api/login", { email, loginKey, signPub: this.#keys.signPub, name: this.#name, kind: this.#kind });
      if (typeof session !== "string" || !session) throw new AccountError(502, "bad-login", "The hub's answer made no sense.");
      this.#session = session;
      await this.#store.set("session", session);
      return state;
    };
    let state = await login();
    // This page's own list names this key, and the hub says it is not on the account. Either it was removed, which this page has
    // not seen, or the hub lies. Waiting cannot help in the first case, and a key costs nothing here, so it starts over with a new
    // one, which the person must approve. It says so, since that may be the hub's lie.
    if (state === "pending" && this.#everOnLog(this.#keys.signPub)) {
      this.#alert("hub-says-removed");
      await this.#dropKeys();
      await this.#ensureKeys();
      state = await login();
    }
    if (state === "approved") {
      // The hub's word alone is not enough: this page must already hold a log that names it.
      if (!this.#verified?.devices.has(this.#keys.signPub)) {
        this.#alert("fake-log", "no-anchor");
        await this.#forgetSession();
        throw new AccountError(409, "no-anchor", "The hub says this page is on the account, but this page holds no device list to check that against. Forget this page to sign in again as a new device.");
      }
      this.#phase = "approved";
    } else {
      this.#phase = "pending";
      this.#exchange.reset();
      this.#approvedByHub = false;
      this.#approverOnline = null;
    }
    this.#email = email;
    this.#hubError = null;
    await this.#saveState();
    this.#hub.connect();
    this.#armExpiry();
    this.#changed();
    return this.status();
  }

  async signOut({ forget = false } = {}) {
    await this.#started;
    this.#dropConnection("signed-out");
    clearInterval(this.#approverTimer);
    clearTimeout(this.#expiryTimer);
    await this.#forgetSession();
    this.#phase = "signed-out";
    this.#exchange.current = null;
    this.#online = new Set();
    this.#approvedByHub = false;
    this.#hubError = null;
    if (forget) {
      await this.#store.clear();
      this.#keys = null;
      this.#log = null;
      this.#verified = null;
      this.#hashes = [];
      this.#knownRecoveries = 0;
      this.#email = null;
      this.#alerts = [];
    } else await this.#saveState();
    this.#changed();
    this.emit("devices", this.devices());
    return this.status();
  }

  // ---------------------------------------------------------------------------- the hub

  #onAuthOk({ state }) {
    this.#hubError = null;
    this.#hubClaimedRemoved = false;
    this.#hubGaveUp = false;
    this.#changed();
    if (this.#phase === "approved") {
      this.syncLog().then(() => this.#hub.sendNow({ type: "presence" })).catch(() => {});
    } else if (this.#phase === "pending") {
      if (state === "approved") {
        this.#approvedByHub = true;
        this.#tryFinishApproval();
      }
      this.#askForApprovers();
    }
  }

  /** Whether anyone could approve: the hub's word, so it only decides what the person is told. */
  #askForApprovers() {
    clearInterval(this.#approverTimer);
    const ask = () => {
      if (this.#phase !== "pending") { clearInterval(this.#approverTimer); return; }
      try { this.#hub.sendNow({ type: "pending.list" }); } catch { /* the socket went: the next connection asks */ }
    };
    ask();
    this.#approverTimer = setInterval(ask, this.approverPollMs);
    this.#approverTimer.unref?.();
  }

  #onSocketGone(code) {
    for (const channel of this.#channels.all()) channel.close("the hub connection was lost");
    this.#hub.failWaiters(new AccountError(503, "hub-unreachable", "The hub connection was lost."));
    clearInterval(this.#approverTimer);
    this.#online = new Set();
    this.#approverOnline = null;
    this.#changed();
    this.emit("devices", this.devices());
    if (this.#hub.stopped) return;
    switch (code) {
      case CLOSE_REPLACED:
        this.#hubError = "Another tab or window of this page took over. This one will not reconnect, so the two do not fight. Reload to use this one.";
        this.#hubGaveUp = true;
        this.#changed();
        return;
      case CLOSE_DENIED:
        this.#settle("denied", "A device on the account refused this sign-in.");
        return;
      case CLOSE_PENDING_EXPIRED:
        this.#settle("signed-out", "This sign-in expired before it was approved. Sign in again.");
        return;
      case CLOSE_REMOVED:
        // The hub's word, not a verified log. One more connection will show the log if the session still stands.
        this.#alert("hub-says-removed");
        this.#hubClaimedRemoved = true;
        this.#hub.scheduleReconnect();
        return;
      case CLOSE_SESSION_GONE:
        this.#settle("signed-out", this.#hubClaimedRemoved ? "The hub says this page is no longer on the account. Sign in again to check." : "The hub no longer knows this session. Sign in again.");
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
    this.#forgetSession().then(() => this.#saveState()).catch(() => {});
    this.#changed();
  }

  #dispatch(message) {
    switch (message.type) {
      case "log.updated":
        if (this.#phase === "approved" && message.head !== this.#hashes.at(-1)) this.syncLog().catch(() => {});
        return;
      case "session.approved":
        this.#approvedByHub = true;
        this.#changed();
        this.#tryFinishApproval();
        return;
      case "pending.list":
        if (typeof message.approverOnline === "boolean" && message.approverOnline !== this.#approverOnline) {
          this.#approverOnline = message.approverOnline;
          this.#changed();
        }
        this.#hub.answerWaiter(message);
        return;
      case "presence":
        this.#online = new Set(Array.isArray(message.online) ? message.online.filter((k) => typeof k === "string") : []);
        for (const channel of this.#channels.all()) {
          if (channel.state === "open" && !this.#online.has(channel.peerId)) channel.close("the other device went offline", { notify: false });
        }
        this.#hub.answerWaiter(message);
        this.emit("devices", this.devices());
        this.#changed();
        return;
      case "approval.msg":
        if (!isFiniteDevice(message.from) || typeof message.opaque !== "string" || this.#phase !== "pending" || !this.#keys) return;
        this.#approvalChain = this.#approvalChain.then(() => {
          const outer = decodeOuter(message.opaque);
          return outer ? this.#exchange.onMessage(message.from, outer) : undefined;
        }).catch(() => {});
        return;
      case "channel.msg":
        if (isFiniteDevice(message.from) && typeof message.opaque === "string") this.#onChannelMessage(message.from, message.opaque);
        return;
      case "error":
        if (message.for === "channel.msg" && typeof message.to === "string") {
          for (const channel of this.#channels.all()) {
            if (channel.peerId === message.to) channel.close(message.code === "busy" ? "the other device is not reading, so the channel was closed" : "the other device cannot be reached", { notify: false });
          }
          return;
        }
        this.#hub.answerWaiter(message);
        return;
      default:
        this.#hub.answerWaiter(message);
    }
  }

  #approvalChain = Promise.resolve();

  #onChannelMessage(from, opaque) {
    const outer = decodeOuter(opaque);
    if (!outer) {
      const foreign = foreignOuter(opaque);
      if (foreign) this.#channels.otherVersion(from, foreign);
      return;
    }
    if (outer.t === "review") return; // a label on the cards a page does not show
    this.#channels.receive(from, outer, opaque.length);
  }

  // ---------------------------------------------------------------------------- the log

  #everOnLog(signPub) {
    return !!this.#log?.some((entry) => entry.body?.signPub === signPub);
  }

  async #setLog(entries, verified) {
    this.#log = entries;
    this.#verified = verified;
    this.#hashes = await Promise.all(entries.map((entry) => entryHash(entry)));
  }

  /** Kept first: a log believed but not kept could be rolled back by a reload. */
  async #adopt(entries, verified) {
    await this.#store.set("log", entries);
    await this.#setLog(entries, verified);
    const fresh = verified.recoveries.slice(this.#knownRecoveries);
    this.#knownRecoveries = verified.recoveries.length;
    await this.#saveState();
    for (const recovery of fresh) if (recovery.signPub !== this.#keys?.signPub) this.#alert("recovered", String(recovery.index));
    this.emit("devices", this.devices());
    this.#changed();
    if (await this.#leftTheLog()) return;
    this.#channels.recheck();
    this.#armExpiry();
  }

  /** This page's key on the log it holds: past its window, or off it. Either way it is out for good, and it goes now. */
  async #leftTheLog() {
    if (!this.#keys || !this.#log || !this.#everOnLog(this.#keys.signPub)) return false;
    if (this.#phase !== "approved" && this.#phase !== "pending") return false;
    const removed = this.#log.some((entry) => entry.type === "remove" && entry.body.signPub === this.#keys.signPub);
    if (!removed && this.#verified.devices.has(this.#keys.signPub) && deviceCurrent(this.#verified.devices.get(this.#keys.signPub), this.now())) return false;
    this.#phase = removed ? "removed" : "expired";
    if (removed) this.#alert("removed");
    this.#hubError = removed ? "This page was removed from the account. Sign in again and approve it from one of your devices. It comes back as a new device, with new keys." : OVER_30_DAYS;
    clearTimeout(this.#expiryTimer);
    this.#dropConnection(removed ? "removed" : "expired");
    await this.#forgetSession();
    await this.#dropKeys();
    await this.#saveState();
    this.#changed();
    return true;
  }

  /** Its 30 days end with no event to announce them. */
  #armExpiry() {
    clearTimeout(this.#expiryTimer);
    const me = this.#keys && this.#verified?.devices.get(this.#keys.signPub);
    const at = me && deviceExpiresAt(me);
    if (!at) return;
    this.#expiryTimer = setTimeout(() => {
      this.#run(async () => {
        const verified = await this.verifyLogImpl(this.#log, { now: this.now() });
        this.#verified = verified;
        if (!await this.#leftTheLog()) {
          this.#channels.recheck();
          this.#armExpiry();
        }
      }).catch(() => {});
    }, Math.min(Math.max(at - this.now(), 10), TIMER_MAX));
    this.#expiryTimer.unref?.();
  }

  /** One change to the log at a time. */
  #run(work) {
    const run = this.#logLock.then(work);
    this.#logLock = run.catch(() => {});
    return run;
  }

  #considerLog(entries) {
    return this.#run(async () => {
      const { verdict, verified, alert } = await judgeLog(this.#log, entries, { now: this.now(), verifyLog: this.verifyLogImpl });
      if (alert) this.#alert(...alert);
      if (verdict === "adopted") await this.#adopt(entries, verified);
      return verdict;
    });
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

  // ---------------------------------------------------------------------------- approving

  /** The person's button: after a failed exchange, or a code that did not match. */
  restartExchange() {
    if (this.#phase !== "pending") throw new AccountError(409, "not-pending", "This page is not waiting for approval.");
    this.#exchange.restart();
    return this.status();
  }

  /** The person checked that this page's code matches the approving device's. Nothing is adopted before this. */
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
    const { verified, alert } = await checkApprovedLog(reply.entries, { me: this.#keys.signPub, exchange, held: this.#log, now: this.now(), verifyLog: this.verifyLogImpl });
    if (alert) {
      this.#alert(...alert);
      return;
    }
    await this.#run(() => this.#adopt(reply.entries, verified));
    this.#phase = "approved";
    this.#exchange.current = null;
    this.#approvedByHub = false;
    clearInterval(this.#approverTimer);
    await this.#saveState();
    this.#armExpiry();
    this.#changed();
    try { this.#hub.sendNow({ type: "presence" }); } catch { /* the socket went: the next connection does this again */ }
  }

  /** Opens a channel to another machine on the account. */
  openChannel(deviceId) { return this.#channels.open(deviceId); }

  // ---------------------------------------------------------------------------- what stands in for this computer's server

  /**
   * ui/account.js talks to /api/account/* through transport's `local`. A page has no server, so this answers it, in the same
   * shapes. Everything a page cannot do is refused here as well as absent from its screens.
   */
  routes() {
    const answer = async (method, path, body) => {
      const name = path.split("?", 1)[0].replace(/^\/api\/account\//, "");
      if (!path.startsWith("/api/account/")) throw new AccountError(404, "not-here", "A web page has no computer of its own to ask.");
      if (method === "GET") {
        switch (name) {
          case "status": return this.status();
          case "devices": return { devices: this.devices() };
          case "approvals": return { pending: [], review: null };
          case "machines": return { machines: this.links.machines() };
          default: throw new AccountError(403, "web-page", NOT_ON_A_PAGE);
        }
      }
      switch (name) {
        case "sign-in": return this.signIn(body);
        case "sign-out": return this.signOut(body ?? {});
        case "confirm-code": return this.confirmCode(body?.code);
        case "restart-exchange": return this.restartExchange();
        case "alerts/clear": await this.clearAlerts(); return { ok: true };
        default: throw new AccountError(403, "web-page", NOT_ON_A_PAGE);
      }
    };
    return {
      api: answer,
      eventSource: (url) => (url.split("?", 1)[0] === "/api/account/events" ? this.#newsStream() : quietStream()),
    };
  }

  #newsStream() {
    const stream = quietStream();
    const stops = [];
    for (const name of ["status", "devices", "alert", "links"]) {
      const listener = (value) => { if (stream.readyState === 1) stream.dispatch(name, JSON.stringify(value)); };
      this.on(name, listener);
      stops.push(() => this.off(name, listener));
    }
    const close = stream.close;
    stream.close = () => { for (const stop of stops) stop(); close(); };
    Promise.resolve().then(() => { if (stream.readyState === 1) stream.dispatch("status", JSON.stringify(this.status())); });
    return stream;
  }
}

/** An EventSource with nothing behind it, for what only a computer's own server would say. */
function quietStream() {
  const listeners = new Map();
  const stream = {
    readyState: 1, onopen: null, onmessage: null, onerror: null,
    addEventListener(name, listener) { listeners.set(name, [...(listeners.get(name) ?? []), listener]); },
    removeEventListener(name, listener) { listeners.set(name, (listeners.get(name) ?? []).filter((l) => l !== listener)); },
    close() { stream.readyState = 2; },
    dispatch(name, data) { for (const listener of listeners.get(name) ?? []) listener({ type: name, data }); },
  };
  return stream;
}
