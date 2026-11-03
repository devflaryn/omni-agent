/**
 * The desktop as a client of the account's other machines: one encrypted channel per machine, kept and reused, and the
 * /remote/<deviceId>/<path> proxy the window's own UI talks to.
 *
 * Why a heartbeat: a request can rightly take minutes to answer (a chat compacting before it starts), so its silence
 * proves nothing. PING does: when the far side stops answering those, every request on the channel is rejected, naming the
 * machine, inside `deadAfterMs`, and a new request starts over with a fresh handshake. Nothing is ever queued or retried: a
 * dropped action may or may not have run, and only the person can say whether to send it again.
 *
 * What crosses is built here, field by field, in both directions. The window's cookie and everything else about this
 * computer stay on this side, and a far machine's reply can set nothing and run nothing in the window's origin.
 */
import { EventEmitter } from "node:events";
import { validateHeaderValue } from "node:http";
import { channelAllowed } from "./access.mjs";
import { SAFE_REQUEST_HEADERS, channelClient } from "./channel-host.mjs";
import { cleanName } from "../ui/transport.js";

const SECOND = 1000;
const DEFAULTS = Object.freeze({
  responseTimeoutMs: 30 * SECOND,  // from request() to the response's head, connecting included: what a person is promised
  connectTimeoutMs: 28 * SECOND,   // one attempt to connect, which goes on for later requests after one has given up
  pingEveryMs: 8 * SECOND,
  stallAfterMs: 12 * SECOND,       // shown as stalled from here
  deadAfterMs: 25 * SECOND,        // given up from here
  idleCloseMs: 5 * 60 * SECOND,    // no request on it for this long: a channel is not held open for nobody
  slowReaderMs: 20 * SECOND,       // a browser that stops reading holds the channel's shared window, so it is let go of
  maxBodyBytes: 32 * 1024 * 1024,  // as for a signed-in remote browser
});
const DIFFERENT_VERSION = /different version/;
const DRAIN_MS = 2 * SECOND;
const SELF = "That is this computer: there is nothing to connect to.";
const REPLY_HEADERS = ["content-type", "content-length", "content-range", "accept-ranges", "cache-control", "etag", "last-modified", "content-disposition", "content-encoding", "x-accel-buffering"];

/** Nothing a far machine sends may run in this window's origin, which holds the account's cookie. */
const SANDBOX = "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'";
/** A sandbox stops the browser's PDF viewer, and a PDF runs nothing in the origin: it may be framed by this page alone. */
const PDF_POLICY = "default-src 'none'; object-src 'self'; frame-ancestors 'self'";

export class MachineError extends Error {
  constructor(status, code, message, machine) {
    super(message);
    this.status = status;
    this.code = code;
    this.machine = machine;
  }
}

class BodyTooLarge extends Error {}

export class MachineLinks extends EventEmitter {
  #links = new Map();
  #closed = false;

  constructor({ account, ...options }) {
    super();
    this.account = account;
    this.options = { ...DEFAULTS, ...options };
    this.on("error", () => {});
    this.setMaxListeners(0);
  }

  /** The account's other machines. A web page or a phone hosts nothing, whatever it calls itself, and neither does a client. */
  #hosts() {
    return this.account.devices().filter((d) => !d.self && d.role === "full" && d.kind === "desktop");
  }

  machines() {
    return this.#hosts().map((d) => ({ id: d.id, name: cleanName(d.name), kind: cleanName(d.kind), online: d.online, addedAt: d.addedAt, link: this.#linkView(d) }));
  }

  #linkView(device) {
    const link = this.#links.get(device.id);
    const state = link?.state ?? "idle";
    const shown = !device.online && state === "idle" ? "offline" : state;
    return { state: shown, lastError: link?.lastError ?? null };
  }

  #changed() {
    if (!this.#closed) this.emit("links", this.machines());
  }

  /** The device, if it may be asked at all. */
  #hostFor(id) {
    const devices = this.account.devices();
    const device = devices.find((d) => d.id === id);
    if (device?.self) throw new MachineError(400, "self", SELF);
    if (!device || !this.#hosts().some((d) => d.id === id)) throw new MachineError(404, "no-such-machine", "That machine is not on this account.");
    return device;
  }

  isSelf(id) { return this.account.devices().some((d) => d.self && d.id === id); }

  #link(device) {
    let link = this.#links.get(device.id);
    if (!link) {
      link = { id: device.id, name: cleanName(device.name), client: null, channel: null, opening: null, state: "idle", lastError: null, lastHeard: 0, inflight: 0, lastUsed: Date.now(), tick: null };
      this.#links.set(device.id, link);
    }
    link.name = cleanName(device.name);
    return link;
  }

  async #whenConnected(ms) {
    const end = Date.now() + ms;
    while (!this.account.status().hub.connected) {
      if (this.#closed || Date.now() >= end) return false;
      await new Promise((r) => { const t = setTimeout(r, 100); t.unref?.(); });
    }
    return true;
  }

  async #connect(link) {
    link.state = "connecting";
    this.#changed();
    try {
      const { connectTimeoutMs } = this.options;
      const started = Date.now();
      if (!(await this.#whenConnected(connectTimeoutMs))) throw new Error("this computer is not connected to the hub");
      const channel = await deadline(this.account.openChannel(link.id), connectTimeoutMs - (Date.now() - started), `${link.name} did not finish connecting`);
      link.channel = channel;
      link.lastHeard = Date.now();
      link.client = channelClient(channel, { onHeard: () => this.#heard(link, channel) });
      link.state = "open";
      link.lastError = null;
      link.tick = setInterval(() => this.#watch(link, channel), Math.min(SECOND, this.options.pingEveryMs));
      link.tick.unref?.();
      channel.once("close", (reason) => this.#gone(link, channel, reason));
      this.#changed();
      return link.client;
    } catch (error) {
      link.state = "idle";
      link.lastError = error.message;
      this.#changed();
      throw error;
    }
  }

  #heard(link, channel) {
    if (link.channel !== channel) return;
    link.lastHeard = Date.now();
    if (link.state === "stalled") {
      link.state = "open";
      this.#changed();
    }
  }

  #watch(link, channel) {
    if (link.channel !== channel || channel.closed) return;
    const { pingEveryMs, stallAfterMs, deadAfterMs, idleCloseMs } = this.options;
    const now = Date.now();
    const silent = now - link.lastHeard;
    if (silent >= deadAfterMs) {
      channel.close(`${link.name} stopped answering`);
      return;
    }
    if (silent >= stallAfterMs && link.state !== "stalled") {
      link.state = "stalled";
      this.#changed();
    }
    if (!link.inflight && now - link.lastUsed >= idleCloseMs) {
      channel.close("closed");
      return;
    }
    if (now - (link.lastPing ?? 0) >= pingEveryMs) {
      link.lastPing = now;
      link.client.ping().catch(() => {});
    }
  }

  #gone(link, channel, reason) {
    if (link.channel !== channel) return;
    clearInterval(link.tick);
    link.tick = null;
    link.channel = null;
    link.client = null;
    link.state = "idle";
    link.lastError = String(reason ?? "the channel closed");
    this.#changed();
  }

  /** A response from the machine, or a MachineError that names it. Never a retry and never a queue. */
  async request(id, options) {
    const device = this.#hostFor(id);
    const link = this.#link(device);
    const name = link.name;
    const started = Date.now();
    const left = () => this.options.responseTimeoutMs - (Date.now() - started);
    const connected = this.account.status().hub.connected;
    if (!link.client && connected && !device.online) throw new MachineError(503, "machine-offline", `${name} is offline. Nothing was sent to it.`, { id, name });
    let client;
    try {
      client = link.client ?? await deadline(link.opening ??= this.#connect(link).finally(() => { link.opening = null; }), left(), `${name} did not finish connecting`);
    } catch (error) {
      if (DIFFERENT_VERSION.test(error.message)) throw new MachineError(502, "machine-version", `${name} runs a different version of Omni. Update Omni on ${name} and on this computer. Nothing was sent to it.`, { id, name });
      throw new MachineError(504, "machine-unreachable", `Could not reach ${name}: ${error.message}. Nothing was sent to it.`, { id, name });
    }
    link.lastUsed = Date.now();
    link.inflight++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      link.inflight--;
      link.lastUsed = Date.now();
    };
    // No head inside the budget, however alive the link: the action is given up on, and the far machine is told. A response
    // already streaming is past this: from its head on it follows the liveness rule alone, so a long event stream or a slow
    // download is not cut off by a clock.
    const budget = new AbortController();
    let late = false;
    const timer = setTimeout(() => { late = true; budget.abort(new Error("no answer in time")); }, Math.max(0, left()));
    timer.unref?.();
    try {
      const response = await client.request({ ...options, signal: options.signal ? AbortSignal.any([options.signal, budget.signal]) : budget.signal });
      clearTimeout(timer);
      response.body.once("close", release);
      return response;
    } catch (error) {
      clearTimeout(timer);
      release();
      if (late) throw new MachineError(504, "machine-slow", `${name} did not answer within ${Math.round(this.options.responseTimeoutMs / SECOND)} seconds. This action may or may not have run there.`, { id, name });
      if (options.signal?.aborted || error instanceof BodyTooLarge) throw error;
      throw new MachineError(502, "machine-lost", `The connection to ${name} was lost (${error.message}). This action may or may not have run there.`, { id, name });
    }
  }

  close() {
    this.#closed = true;
    for (const link of this.#links.values()) {
      clearInterval(link.tick);
      link.channel?.close("closed");
    }
    this.#links.clear();
  }
}

function deadline(promise, ms, message) {
  let timer;
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), Math.max(0, ms)); timer.unref?.(); });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

/** Only what the far machine needs to answer: none of this computer's cookies, addresses, or anything it did not list. */
function requestHeaders(given) {
  const out = {};
  for (const name of SAFE_REQUEST_HEADERS) if (typeof given[name] === "string") out[name] = given[name];
  return out;
}

function replyHeaders(given) {
  const out = {};
  for (const name of REPLY_HEADERS) {
    const value = given?.[name];
    if (typeof value !== "string" && typeof value !== "number") continue;
    // The defence against a second response on this connection rests on the proxy and the browser reading this number alike.
    // Anything else goes, and chunked takes over.
    if (name === "content-length" && !/^\d{1,15}$/.test(String(value))) continue;
    try { validateHeaderValue(name, value); out[name] = String(value); } catch { /* a value that could break the header block is no header */ }
  }
  return out;
}

async function* limited(req, max) {
  let size = 0;
  // Not destroyed on the way out: the answer still has to go back down this socket.
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > max) throw new BodyTooLarge("request too large");
    yield chunk;
  }
}

const parseTarget = (url) => {
  const m = /^\/remote\/([^/?#]+)(\/[^#]*)?$/.exec(url);
  if (!m) return null;
  let id;
  try { id = decodeURIComponent(m[1]); } catch { return { bad: true }; }
  return { id, path: m[2] ?? null };
};

/** /remote/<deviceId>/<path>. The caller has checked the window cookie and the Origin. */
export async function proxyToMachine(req, res, { links, send }) {
  const target = parseTarget(req.url);
  if (!target) return send(res, 404, { error: "/remote/<device>/<path>" });
  if (target.bad) return send(res, 400, { error: "that device id is not readable" });
  const fail = (e) => send(res, e.status, { error: e.message, code: e.code, ...(e.machine ? { machine: e.machine } : {}) });
  const { maxBodyBytes, slowReaderMs } = links.options;
  const hasBody = req.method !== "GET" && req.method !== "HEAD";

  // The cookie is SameSite and a change must name this page, which leaves a read from another page on this site: another port.
  const site = req.headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin" && site !== "none") return send(res, 403, { error: "that request did not come from the Omni window" });

  if (target.path === null) {
    if (links.isSelf(target.id)) return send(res, 400, { error: SELF, code: "self" });
    return send(res, 404, { error: "/remote/<device>/<path>" });
  }
  // The far machine refuses these too. Asked here, nothing has to cross to learn it.
  if (!channelAllowed(req.method, target.path)) return send(res, 403, { error: "that is not available on another machine" });
  if (Number(req.headers["content-length"]) > maxBodyBytes) return refuseTooLarge(req, res, send);

  const gone = new AbortController();
  const onClose = () => { if (!res.writableFinished) gone.abort(new Error("the window went away")); };
  res.once("close", onClose);

  let response;
  try {
    response = await links.request(target.id, {
      method: req.method,
      path: target.path,
      headers: requestHeaders(req.headers),
      body: hasBody ? limited(req, maxBodyBytes) : undefined,
      signal: gone.signal,
    });
  } catch (error) {
    if (error instanceof MachineError) { if (hasBody) req.resume(); return fail(error); }
    if (error instanceof BodyTooLarge) return refuseTooLarge(req, res, send);
    if (gone.signal.aborted) return undefined;
    throw error;
  }
  return relay(req, res, response, { slowReaderMs, send, hasBody });
}

/** Reads and drops what is on its way for a moment first: a socket closed under a sender loses this answer to a reset. */
async function refuseTooLarge(req, res, send) {
  req.resume();
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, DRAIN_MS);
    timer.unref?.();
    req.once("end", resolve);
    req.once("close", resolve);
  });
  res.setHeader("Connection", "close");
  return send(res, 413, { error: "request too large" });
}

async function relay(req, res, response, { slowReaderMs, send, hasBody }) {
  const stop = () => { response.abort(); res.destroy(); };
  // 1xx would change what this connection is, and anything under 200 or past 599 is not an answer.
  if (!Number.isInteger(response.status) || response.status < 200 || response.status > 599) {
    response.abort();
    return send(res, 502, { error: "the other machine sent an answer that makes no sense" });
  }
  const headers = replyHeaders(response.headers);
  const pdf = /^application\/pdf\b/i.test(headers["content-type"] ?? "");
  res.setHeader("Content-Security-Policy", pdf ? PDF_POLICY : SANDBOX);
  if (pdf) res.removeHeader("X-Frame-Options");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  // An event stream's head goes now, not with its first event. While an upload may still be running it waits for the first
  // byte of the answer: a far side that answers early must not be able to turn the 413 for that upload into a reset.
  const sendHead = () => {
    if (res.headersSent) return;
    res.writeHead(response.status, headers);
    res.flushHeaders();
  };
  if (!hasBody) sendHead();

  // Counted here: passed on as it stands, a false length would let the rest be read as another response on this connection.
  const declared = headers["content-length"] === undefined || req.method === "HEAD" || response.status === 204 || response.status === 304 ? null : Number(headers["content-length"]);
  let sent = 0;
  try {
    for await (const chunk of response.body) {
      if (req.method === "HEAD") continue;
      sent += chunk.length;
      if (declared !== null && sent > declared) { stop(); return undefined; }
      sendHead();
      if (!res.write(chunk)) await drained(res, slowReaderMs);
    }
  } catch (error) {
    if (error instanceof BodyTooLarge && !res.headersSent) return refuseTooLarge(req, res, send);
    // The channel went, or the reader did. Ended cleanly, a part of an answer would pass for all of it.
    stop();
    return undefined;
  }
  if (declared !== null && sent < declared) { stop(); return undefined; }
  if (hasBody) req.resume(); // the far machine has answered: whatever is left of an upload goes nowhere
  sendHead();
  res.end();
  return undefined;
}

function drained(res, ms) {
  return new Promise((resolve, reject) => {
    const done = (error) => {
      clearTimeout(timer);
      res.off("drain", onDrain);
      res.off("close", onClose);
      if (error) reject(error); else resolve();
    };
    const onDrain = () => done();
    const onClose = () => done(new Error("the reader went away"));
    const timer = setTimeout(() => done(new Error("the reader stopped reading")), ms);
    timer.unref?.();
    res.once("drain", onDrain);
    res.once("close", onClose);
  });
}
