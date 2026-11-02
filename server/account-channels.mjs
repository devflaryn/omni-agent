/**
 * Encrypted channels between this device and the account's others: the handshake, the checks against the verified log,
 * and closing a channel the moment its device leaves that log. The account owns the log and the hub connection, and
 * lends them here through `ctx`.
 */
import { EventEmitter } from "node:events";
import { startHandshake, toB64 } from "../ui/account-core.js";
import { deviceCurrent, deviceExpiresAt } from "../ui/device-log.js";
import { CLOSE_REASONS, FRAME, decodeFrame, encodeFrame, encodeOuter } from "../ui/channel-frames.js";
import { AccountError } from "./account-error.mjs";

const TIMER_MAX = 2 ** 31 - 1;
const DISAGREEMENT_REASONS = new Set(["not-on-log", "removed", "expired", "log-mismatch"]);

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

/**
 * ctx: { limits, now(), keys(), phase(), connected(), verified(), hashes(), allowWebAccess(), syncLog(), sendPaced(message),
 *        alert(kind, detail), emit(name, ...args), changed(), peerHeadSigned(head) }
 */
export class ChannelSet {
  channels = new Map();

  constructor(ctx) { this.ctx = ctx; }

  all() { return [...this.channels.values()]; }

  #channelKey(peerId, id) { return `${peerId}|${id}`; }

  #countFor(peerId) {
    return [...this.channels.values()].filter((c) => c.peerId === peerId).length;
  }

  #newChannel(id, peerId, direction) {
    const channel = new Channel({
      id, peerId, direction,
      send: (ch, d) => this.ctx.sendPaced({ type: "channel.msg", to: ch.peerId, opaque: encodeOuter({ c: ch.id, t: "data", d }) }),
      closing: (ch, reason, notify) => this.#onChannelClosing(ch, reason, notify),
    });
    this.channels.set(this.#channelKey(peerId, id), channel);
    return channel;
  }

  #onChannelClosing(channel, reason, notify) {
    this.channels.delete(this.#channelKey(channel.peerId, channel.id));
    if (notify && this.ctx.connected() && Object.hasOwn(CLOSE_REASONS, reason)) {
      this.ctx.sendPaced({ type: "channel.msg", to: channel.peerId, opaque: encodeOuter({ c: channel.id, t: "close", reason }) }).catch(() => {});
    }
    channel.rejectOpening?.(new AccountError(502, "channel-refused", CLOSE_REASONS[reason] ?? String(reason)));
    this.ctx.emit("channel-closed", channel);
    this.ctx.changed();
  }

  /** A device still current on the log, or null. An unknown one may just be news, so the log is fetched once to see. */
  async #currentDevice(peerId) {
    const known = () => {
      const device = this.ctx.verified()?.devices.get(peerId);
      return device && deviceCurrent(device, this.ctx.now()) ? device : null;
    };
    if (known()) return known();
    try { await this.ctx.syncLog(); } catch { return null; }
    return known();
  }

  /** The reason this device may not hold a channel here, or null. */
  async #whyRefused(peerId, direction) {
    if (this.ctx.phase() !== "approved") return "unavailable";
    const device = await this.#currentDevice(peerId);
    if (!device) return "not-on-log";
    if (direction === "in" && device.role === "client" && !this.ctx.allowWebAccess()) return "web-access-off";
    return null;
  }

  /** Opens a channel to another machine on the account. */
  async open(deviceId) {
    if (this.ctx.phase() === "log-damaged") throw new AccountError(409, "log-damaged", "The device log on this computer is damaged.");
    if (this.ctx.phase() !== "approved" || !this.ctx.connected()) throw new AccountError(409, "not-connected", "This computer is not connected to the account.");
    const peerDevice = await this.#currentDevice(deviceId);
    if (!peerDevice) throw new AccountError(404, "no-such-device", "That device is not on the account.");
    if (deviceId === this.ctx.keys().signPub) throw new AccountError(400, "self", "This is this computer.");
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
      channel.handshake = await startHandshake({ device: this.ctx.keys(), peerPub: deviceId, logHead: this.ctx.hashes().at(-1) });
      await this.ctx.sendPaced({ type: "channel.msg", to: deviceId, opaque: encodeOuter({ c: id, t: "hello", ...channel.handshake.hello }) });
    } catch (error) {
      channel.close(error.message, { notify: false });
      throw error;
    }
    return opened;
  }

  #armHandshakeTimer(channel) {
    const timer = setTimeout(() => {
      if (channel.state === "handshake") channel.close("the other device did not finish connecting", { notify: false });
    }, this.ctx.limits.handshakeTimeoutMs);
    timer.unref?.();
    channel.setTimer(timer);
  }

  /** A message from another device, already parsed. Believed only as far as each step checks it. */
  receive(from, outer, size) {
    if (typeof outer.c !== "string" || outer.c.length > 64) return;
    const channel = this.channels.get(this.#channelKey(from, outer.c));
    if (!channel) {
      if (outer.t === "hello") this.#onHello(from, outer);
      return;
    }
    let queued;
    switch (outer.t) {
      case "hello": queued = channel.enqueue(size, () => this.#finishHandshake(channel, outer), this.ctx.limits.maxInboundBytes); break;
      case "proof": queued = channel.enqueue(size, () => this.#onProof(channel, outer), this.ctx.limits.maxInboundBytes); break;
      case "data": queued = channel.enqueue(size, () => this.#onData(channel, outer), this.ctx.limits.maxInboundBytes); break;
      case "close":
        // Being told no by a device this computer trusts means the two logs disagree: a security matter, not a plain error.
        if (DISAGREEMENT_REASONS.has(outer.reason) && this.ctx.verified()?.devices.has(from)) {
          this.ctx.alert("refused-by-device", `${from}|${outer.reason}`);
          this.ctx.syncLog().catch(() => {});
        }
        channel.close(Object.hasOwn(CLOSE_REASONS, outer.reason) ? outer.reason : "closed", { notify: false });
        return;
      default: return;
    }
    if (!queued) channel.close("closed");
  }

  /** Another device opens a channel to this one. Checked before any key work is done for it. */
  #onHello(from, outer) {
    const refuse = (reason) => this.ctx.sendPaced({ type: "channel.msg", to: from, opaque: encodeOuter({ c: outer.c, t: "close", reason }) }).catch(() => {});
    if (this.ctx.phase() !== "approved") return refuse("unavailable");
    if (this.#countFor(from) >= this.ctx.limits.maxChannelsPerDevice || this.channels.size >= this.ctx.limits.maxChannels) return refuse("busy");
    const channel = this.#newChannel(outer.c, from, "in");
    this.#armHandshakeTimer(channel);
    channel.enqueue(0, async () => {
      const reason = await this.#whyRefused(from, "in");
      if (reason) {
        channel.close(reason);
        return;
      }
      const device = this.ctx.verified().devices.get(from);
      channel.peer = { id: from, name: device.name, kind: device.kind, role: device.role };
      channel.handshake = await startHandshake({ device: this.ctx.keys(), peerPub: from, logHead: this.ctx.hashes().at(-1) });
      await this.ctx.sendPaced({ type: "channel.msg", to: from, opaque: encodeOuter({ c: outer.c, t: "hello", ...channel.handshake.hello }) });
      await this.#finishHandshake(channel, outer);
    }, this.ctx.limits.maxInboundBytes);
    return undefined;
  }

  async #finishHandshake(channel, hello) {
    if (channel.core || !channel.handshake) return;
    try {
      channel.core = await channel.handshake.finish({ eph: hello.eph, logHead: hello.logHead });
      await this.ctx.sendPaced({ type: "channel.msg", to: channel.peerId, opaque: encodeOuter({ c: channel.id, t: "proof", proof: channel.core.proof }) });
    } catch {
      channel.close("the handshake failed", { notify: false });
    }
  }

  async #onProof(channel, { proof }) {
    if (!channel.core || channel.state !== "handshake") return;
    try {
      await channel.core.confirm(proof);
    } catch {
      this.ctx.alert("channel-failure", channel.id);
      channel.close("frame-failed");
      return;
    }
    // The log heads were signed in the transcript, so this is what the other device really holds.
    this.ctx.peerHeadSigned(channel.core.peerLogHead);
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
    const knows = () => this.ctx.hashes().includes(peerHead);
    if (knows()) return true;
    let verdict;
    try { verdict = await this.ctx.syncLog(); } catch { verdict = "offline"; }
    if (knows()) return true;
    if (channel.closed) return false; // it timed out while waiting: nothing here was refused
    // A fork or another account has already been named. Otherwise the hub simply will not give what the other device has.
    if (verdict === "same" || verdict === "adopted" || verdict === "offline") this.ctx.alert("log-unreconciled", String(peerHead));
    return false;
  }

  async #onData(channel, { d }) {
    if (!channel.core || typeof d !== "string") return;
    let plain;
    try {
      plain = await channel.core.open(new Uint8Array(Buffer.from(d, "base64")));
    } catch {
      // The core has shut this channel for good: it is evidence of tampering, so it is shown, not retried.
      this.ctx.alert("channel-failure", channel.id);
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
    this.ctx.changed();
    if (channel.direction === "in") this.ctx.emit("channel", channel);
    else channel.resolveOpening?.(channel);
  }

  /** A client's window ends with no event to announce it, so each of its channels has a timer for the moment. */
  #armExpiry(channel) {
    const device = this.ctx.verified()?.devices.get(channel.peerId);
    const at = device && deviceExpiresAt(device);
    if (!at) return;
    const timer = setTimeout(() => {
      this.recheck();
      if (!channel.closed) this.#armExpiry(channel);
    }, Math.min(Math.max(at - this.ctx.now(), 10), TIMER_MAX));
    timer.unref?.();
    channel.setTimer(timer);
  }

  /** After any change to who is on the log: a device no longer on it, or past its window, is cut off now. */
  recheck() {
    const now = this.ctx.now();
    for (const channel of [...this.channels.values()]) {
      const device = this.ctx.verified()?.devices.get(channel.peerId);
      if (!device) channel.close("removed");
      else if (!deviceCurrent(device, now)) channel.close("expired");
    }
  }
}
