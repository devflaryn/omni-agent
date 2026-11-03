/**
 * The connection to the hub: HTTP calls, the socket, proving the device key on it, backoff, and asking and answering. It decides
 * nothing about what the hub says. One file for the desktop, the web page and the iPhone app.
 */
import { sign } from "./account-core.js";
import { AccountError } from "./account-error.js";

const SECOND = 1000;
const AUTH_DOMAIN = "omni-hub-auth-v1";
const encoder = new TextEncoder();
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/** A hub's error code is shown to the person. */
export const safeCode = (code) => String(code ?? "").replace(/[^\w.-]/g, "").slice(0, 64) || "hub-error";

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
export const hubErrorText = (code) => (Object.hasOwn(HUB_ERROR_TEXT, code) ? HUB_ERROR_TEXT[code] : `The hub refused this (${code}).`);
const HUB_CODE_STATUS = { "wrong-credentials": 401, locked: 429, busy: 503, conflict: 409, forbidden: 403, "not-found": 404, "invalid-entry": 400, "bad-message": 400 };

/** One JSON call to the hub. A failure is an AccountError whose message is safe to show. */
export async function hubPost({ fetchImpl, hubUrl, timeoutMs }, path, body) {
  let response;
  try {
    response = await fetchImpl(new URL(path, hubUrl), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
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

/**
 * Callbacks: session(), signKey() the private key to prove with, onAuthOk(message), onMessage(message), onGone(code),
 * onConnectTimeout(), onChange().
 */
export class HubSocket {
  connected = false;
  attempts = 0;
  nonce = null;
  stopped = false;
  ws = null;
  #reconnectTimer = null;
  #waiters = [];
  #sentInWindow = 0;
  #windowStart = 0;

  constructor({ hubUrl, hubOrigin, WebSocketImpl, limits, reconnect, session, signKey, onAuthOk, onMessage, onGone, onConnectTimeout, onChange }) {
    Object.assign(this, { hubUrl, hubOrigin, WebSocketImpl, limits, reconnect, session, signKey, onAuthOk, onMessage, onGone, onConnectTimeout, onChange });
  }

  connect() {
    if (this.stopped || !this.session() || this.ws) return;
    clearTimeout(this.#reconnectTimer);
    let ws;
    try {
      ws = new this.WebSocketImpl(`${this.hubUrl.replace(/^http/, "ws")}/ws`);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    const timeout = setTimeout(() => {
      if (this.ws === ws && !this.connected) {
        this.onConnectTimeout();
        this.#gone(ws, 0);
      }
    }, this.limits.connectTimeoutMs);
    timeout.unref?.();
    ws.onopen = () => { if (this.ws === ws) this.sendNow({ type: "auth", session: this.session() }); };
    ws.onmessage = (event) => {
      if (this.ws !== ws) return;
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (typeof message !== "object" || message === null) return;
      if (message.type === "auth.challenge") { this.#onChallenge(message); return; }
      if (message.type === "auth.ok") {
        clearTimeout(timeout);
        this.connected = true;
        this.attempts = 0;
        this.onAuthOk(message);
        return;
      }
      this.onMessage(message);
    };
    ws.onerror = () => {};
    ws.onclose = (event) => { clearTimeout(timeout); this.#gone(ws, event?.code ?? 0); };
  }

  #gone(ws, code) {
    if (this.ws !== ws) return;
    this.ws = null;
    this.connected = false;
    try { ws.close(); } catch { /* */ }
    this.onGone(code);
  }

  /** Lets go of the socket without saying why to anyone: the caller knows. */
  drop(error) {
    clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
    const ws = this.ws;
    this.ws = null;
    this.connected = false;
    try { ws?.close(); } catch { /* it was not open */ }
    this.failWaiters(error);
  }

  /** Closes the socket as if the hub had: what follows it is what follows any loss. */
  closeSocket() {
    try { this.ws?.close(); } catch { /* it has gone */ }
  }

  async #onChallenge({ nonce }) {
    const key = this.signKey();
    if (typeof nonce !== "string" || !key) return;
    this.nonce = nonce;
    const sig = await sign(key, encoder.encode(`${AUTH_DOMAIN} ${this.hubOrigin} ${nonce}`));
    try { this.sendNow({ type: "auth.proof", sig }); } catch { /* the socket went while signing */ }
  }

  scheduleReconnect() {
    if (this.stopped || !this.session() || this.#reconnectTimer) return;
    this.attempts++;
    const ceiling = Math.min(this.reconnect.maxMs, this.reconnect.minMs * 2 ** Math.min(this.attempts - 1, 16));
    const delay = ceiling / 2 + Math.random() * (ceiling / 2);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.connect();
    }, delay);
    this.#reconnectTimer.unref?.();
    this.onChange();
  }

  sendNow(message) {
    if (!this.ws || this.ws.readyState !== 1) throw new AccountError(503, "hub-unreachable", "The hub is not connected.");
    this.ws.send(JSON.stringify(message));
  }

  /** For traffic that can burst: stays under the hub's frame rate, and waits while the socket's own queue is high. */
  async sendPaced(message) {
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
    while ((this.ws?.bufferedAmount ?? 0) > this.limits.maxBufferedBytes) await sleep(5);
    this.sendNow(message);
  }

  rpc(message, replyTypes) {
    return new Promise((resolve, reject) => {
      const waiter = { replyTypes, for: message.type, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.#waiters = this.#waiters.filter((w) => w !== waiter);
        reject(new AccountError(504, "hub-timeout", "The hub did not answer in time."));
      }, this.limits.rpcTimeoutMs);
      waiter.timer.unref?.();
      this.#waiters.push(waiter);
      try {
        this.sendNow(message);
      } catch (error) {
        clearTimeout(waiter.timer);
        this.#waiters = this.#waiters.filter((w) => w !== waiter);
        error.neverSent = true;
        reject(error);
      }
    });
  }

  failWaiters(error) {
    for (const waiter of this.#waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  answerWaiter(message) {
    const isError = message.type === "error";
    const at = this.#waiters.findIndex((w) => (isError ? w.for === message.for : w.replyTypes.includes(message.type)));
    if (at < 0) return false;
    const [waiter] = this.#waiters.splice(at, 1);
    clearTimeout(waiter.timer);
    if (isError) {
      const code = safeCode(message.code);
      waiter.reject(new AccountError(Object.hasOwn(HUB_CODE_STATUS, code) ? HUB_CODE_STATUS[code] : 502, code, hubErrorText(code)));
    } else waiter.resolve(message);
    return true;
  }
}
