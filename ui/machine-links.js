/**
 * One encrypted channel per machine, kept and reused, for anything on the account that acts on its machines: the desktop's
 * /remote proxy, the web page and the iPhone app. One file, so a far machine fails the same way for all of them.
 *
 * Why a heartbeat: a request can rightly take minutes to answer (a chat compacting before it starts), so its silence
 * proves nothing. PING does: when the far side stops answering those, every request on the channel is rejected, naming the
 * machine, inside `deadAfterMs`, and a new request starts over with a fresh handshake. Nothing is ever queued or retried: a
 * dropped action may or may not have run, and only the person can say whether to send it again.
 *
 * The promise to a person: 30 s from request(), a request is rejected, naming the machine, if the channel is not up, or if
 * nothing has been heard on it since the request went. A link that answers pings may take as long as the route takes: a
 * false failure could make someone send a prompt again and run it twice. The window says it is still waiting.
 *
 * `account` needs devices(), status() and openChannel(id). `selfName` is what its messages call this device.
 */
import { Emitter } from "./emitter.js";
import { channelClient } from "./channel-client.js";
import { cleanName } from "./transport.js";
import { CLOSE_REASONS } from "./channel-frames.js";

/** A machine that turned web pages away: not broken, and not worth asking until it changes its mind. */
const refusedWebPages = (error) => error?.code === "channel-refused" && error.message === CLOSE_REASONS["web-access-off"];

const SECOND = 1000;
const DEFAULTS = Object.freeze({
  budgetMs: 30 * SECOND,           // from request(): connecting, plus proof that the link is alive. Not a limit on a slow route
  connectTimeoutMs: 28 * SECOND,   // one attempt to connect, which goes on for later requests after one has given up
  pingEveryMs: 8 * SECOND,
  stallAfterMs: 12 * SECOND,       // shown as stalled from here
  deadAfterMs: 25 * SECOND,        // given up from here
  idleCloseMs: 5 * 60 * SECOND,    // no request on it for this long: a channel is not held open for nobody
  slowReaderMs: 20 * SECOND,       // a browser that stops reading holds the channel's shared window, so it is let go of
  maxBodyBytes: 32 * 1024 * 1024,  // as for a signed-in remote browser
});
const DIFFERENT_VERSION = /different version/;
const SELF = "That is this computer: there is nothing to connect to.";
/** Why a device that is not `approved` asks nothing of a machine. */
const NOT_APPROVED = {
  recovering: "is still finishing a recovery",
  pending: "is still waiting for approval",
  removed: "is no longer on the account",
  "log-damaged": "holds a damaged device list",
  "key-unavailable": "cannot open its device key",
};

export class MachineError extends Error {
  constructor(status, code, message, machine) {
    super(message);
    this.status = status;
    this.code = code;
    this.machine = machine;
  }
}

export class MachineLinks extends Emitter {
  #links = new Map();
  #closed = false;

  constructor({ account, client = channelClient, selfName = "this computer", ...options }) {
    super();
    this.account = account;
    this.makeClient = client;
    this.selfName = selfName;
    this.options = { ...DEFAULTS, ...options };
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
    const shown = !device.online && state === "idle" ? "offline" : state === "idle" && link?.refusing ? "refusing" : state;
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
    for (;;) {
      const { hub } = this.account.status();
      if (hub.connected) break;
      if (hub.gaveUp || this.#closed || Date.now() >= end) return false;
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
      if (!(await this.#whenConnected(connectTimeoutMs))) {
        const { hub } = this.account.status();
        const why = hub.connectionError ?? hub.lastError; // the connection's, not a recovery code's
        throw new Error(hub.gaveUp && why ? why.replace(/\.$/, "") : `${this.selfName} is not connected to the hub`);
      }
      const channel = await deadline(this.account.openChannel(link.id), connectTimeoutMs - (Date.now() - started), `${link.name} did not finish connecting`);
      link.channel = channel;
      link.lastHeard = Date.now();
      link.client = this.makeClient(channel, { onHeard: () => this.#heard(link, channel) });
      link.state = "open";
      link.lastError = null;
      link.refusing = false;
      link.tick = setInterval(() => this.#watch(link, channel), Math.min(SECOND, this.options.pingEveryMs));
      link.tick.unref?.();
      channel.once("close", (reason) => this.#gone(link, channel, reason));
      this.#changed();
      return link.client;
    } catch (error) {
      link.state = "idle";
      link.lastError = error.message;
      link.refusing = refusedWebPages(error);
      this.#changed();
      throw error;
    }
  }

  #heard(link, channel) {
    if (link.channel !== channel) return;
    link.lastHeard = Date.now();
    link.heard = (link.heard ?? 0) + 1; // counted, not timed: a handshake in the same millisecond as a request proves nothing about after it
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
    link.refusing = link.lastError === CLOSE_REASONS["web-access-off"]; // turned off while this page was using it
    this.#changed();
  }

  /** A response from the machine, or a MachineError that names it. Never a retry and never a queue. */
  async request(id, options) {
    const device = this.#hostFor(id);
    const link = this.#link(device);
    const name = link.name;
    const started = Date.now();
    const left = () => this.options.budgetMs - (Date.now() - started);
    const { hub: { connected }, phase } = this.account.status();
    if (phase !== undefined && phase !== "approved") throw new MachineError(503, "machine-unreachable", `Could not reach ${name}: ${this.selfName} ${Object.hasOwn(NOT_APPROVED, phase) ? NOT_APPROVED[phase] : "is not signed in to the account"}. Nothing was sent to it.`, { id, name });
    if (!link.client && connected && !device.online) throw new MachineError(503, "machine-offline", `${name} is offline. Nothing was sent to it.`, { id, name });
    let client;
    try {
      client = link.client ?? await deadline(link.opening ??= this.#connect(link).finally(() => { link.opening = null; }), left(), `${name} did not finish connecting`);
    } catch (error) {
      if (refusedWebPages(error)) throw new MachineError(403, "machine-refusing", `${name} does not let web pages in: Allow web page access is off on ${name}. Nothing was sent to it.`, { id, name });
      if (DIFFERENT_VERSION.test(error.message)) throw new MachineError(502, "machine-version", `${name} runs a different version of Omni. Update Omni on ${name} and on ${this.selfName}. Nothing was sent to it.`, { id, name });
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
    // Asked now, so that an alive link has proved it long before the budget ends, however late the channel came up. Nothing
    // heard since the request went, when the budget ends, means silence: it is given up on. After that, and for a response
    // already streaming, the liveness rule alone decides. `responseTimeoutMs` is a per-call limit for a caller that wants one:
    // none by default, because a slow route is not a failure.
    const { responseTimeoutMs, ...call } = options;
    const heardAtSend = link.heard ?? 0;
    link.lastPing = Date.now();
    client.ping().catch(() => {});
    const giveUp = new AbortController();
    let why = null;
    const silence = setTimeout(() => { if ((link.heard ?? 0) === heardAtSend) { why = "silent"; giveUp.abort(new Error("silence")); } }, Math.max(0, left()));
    const limit = responseTimeoutMs ? setTimeout(() => { why = "limit"; giveUp.abort(new Error("the limit")); }, responseTimeoutMs) : null;
    silence.unref?.();
    limit?.unref?.();
    const settled = () => { clearTimeout(silence); clearTimeout(limit); };
    try {
      const response = await client.request({ ...call, signal: options.signal ? eitherSignal(options.signal, giveUp.signal) : giveUp.signal });
      settled();
      response.body.once("close", release);
      return response;
    } catch (error) {
      settled();
      release();
      if (why === "silent") throw new MachineError(502, "machine-lost", `${name} stopped answering. This action may or may not have run there.`, { id, name });
      if (why === "limit") throw new MachineError(504, "machine-slow", `${name} did not answer within ${Math.round(responseTimeoutMs / SECOND)} seconds. This action may or may not have run there.`, { id, name });
      if (options.signal?.aborted || error.fromCaller) throw error;
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

/** AbortSignal.any, which iOS gained only in 17.4. */
function eitherSignal(a, b) {
  const either = new AbortController();
  for (const signal of [a, b]) signal.addEventListener("abort", () => either.abort(signal.reason), { once: true });
  return either.signal;
}
