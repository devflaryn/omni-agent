/**
 * Requests over a channel become the same handle() the local listener uses. A device's request is the person's own, with
 * `req.omniChannel` set rather than `omniHost`, and with no cookie or forwarded header it could have sent itself.
 *
 * Wire format: ui/channel-frames.js. A `channel` here is anything with sendFrame(bytes), onFrame(cb), close(reason),
 * a `closed` flag and a "close" event (server/account.mjs makes the real, encrypted one).
 */
import { Readable, Writable } from "node:stream";
import { CHANNEL_HOST, channelAllowed } from "./access.mjs";
import { FRAME, MAX_CHUNK, MAX_HEAD, WINDOW, decodeAck, decodeFrame, decodeHead, encodeAck, encodeFrame, encodeJson } from "../ui/channel-frames.js";

const MAX_BODY = 32 * 1024 * 1024; // as for a signed-in remote browser
const MAX_STREAMS = 64;
const MAX_AUDIT_PATH = 1024;
const SAFE_REQUEST_HEADERS = new Set(["accept", "accept-language", "content-type", "last-event-id", "if-none-match", "if-modified-since", "range"]);
const DROPPED_RESPONSE_HEADERS = new Set(["set-cookie", "connection", "keep-alive", "transfer-encoding", "upgrade"]);

/** How many body bytes may be on their way. A writer waits here, which is what pauses whatever feeds it. */
class Credit {
  #used = 0;
  #waiting = [];
  #failed = null;

  constructor(window) { this.window = window; }

  async take(bytes) {
    while (!this.#failed && this.#used >= this.window) await new Promise((resolve) => { this.#waiting.push(resolve); });
    if (this.#failed) throw this.#failed;
    this.#used += bytes;
  }

  release(bytes) {
    this.#used = Math.max(0, this.#used - bytes);
    if (this.#used < this.window) for (const wake of this.#waiting.splice(0)) wake();
  }

  fail(error) {
    this.#failed = error;
    for (const wake of this.#waiting.splice(0)) wake();
  }
}

/** A body arriving in frames. Bytes are acknowledged as the reader takes them, not as they arrive. */
class IncomingBody extends Readable {
  #pushed = 0;
  #given = 0;
  #giveBack;

  constructor(giveBack) {
    super({ autoDestroy: true });
    this.#giveBack = giveBack;
  }

  deliver(chunk) {
    this.#pushed += chunk.length;
    this.push(Buffer.from(chunk));
  }

  _read() {}

  // Here and not in _read, which runs before the bytes leave the buffer and may not run again.
  read(size) {
    const chunk = super.read(size);
    this.#settle();
    return chunk;
  }

  #settle() {
    const consumed = this.#pushed - this.readableLength - this.#given;
    if (consumed > 0) {
      this.#given += consumed;
      this.#giveBack(consumed);
    }
  }

  /** Nobody will read the rest. */
  _destroy(error, callback) {
    const left = this.#pushed - this.#given;
    if (left > 0) {
      this.#given = this.#pushed;
      this.#giveBack(left);
    }
    callback(error);
  }
}

/** The bookkeeping both ends of a channel share: flow control over the shared window, and sending a body in chunks. */
class Link {
  #unacked = 0;

  constructor(channel, window) {
    this.channel = channel;
    this.credit = new Credit(window);
    this.window = window;
    this.unconsumed = 0;
  }

  /** The reader has taken this many bytes. Acknowledged in batches, and never held back past a quarter of the window. */
  consumed(bytes) {
    this.unconsumed -= bytes;
    this.#unacked += bytes;
    if (this.#unacked >= Math.max(1, Math.floor(this.window / 4))) this.flushAcks();
  }

  flushAcks() {
    if (!this.#unacked || this.channel.closed) return;
    const bytes = this.#unacked;
    this.#unacked = 0;
    this.channel.sendFrame(encodeFrame(FRAME.ACK, 0, encodeAck(bytes))).catch(() => {});
  }

  /** A peer past its window is not following the protocol. Whatever it sent is still ours to hold, so it is cut off. */
  received(bytes) {
    this.unconsumed += bytes;
    if (this.unconsumed > 2 * this.window) {
      this.channel.close("closed");
      return false;
    }
    return true;
  }

  async sendBody(type, stream, bytes) {
    for (let at = 0; at < bytes.length; at += MAX_CHUNK) {
      const piece = bytes.subarray(at, at + MAX_CHUNK);
      await this.credit.take(piece.length);
      await this.channel.sendFrame(encodeFrame(type, stream, piece));
    }
  }
}

/** The parts of http.ServerResponse the routes use. Writes wait for credit, so res.write() returning false is real. */
class ChannelResponse extends Writable {
  statusCode = 200;
  statusMessage = "";
  headersSent = false;
  #headers = new Map();
  #link;
  #stream;
  #onDone;

  constructor(link, stream, onDone) {
    super({ highWaterMark: MAX_CHUNK, decodeStrings: true });
    this.#link = link;
    this.#stream = stream;
    this.#onDone = onDone;
    this.on("error", () => {}); // a write after the channel went: the routes do not all check first
  }

  setHeader(name, value) { this.#headers.set(String(name).toLowerCase(), value); return this; }
  getHeader(name) { return this.#headers.get(String(name).toLowerCase()); }
  getHeaders() { return Object.fromEntries(this.#headers); }
  hasHeader(name) { return this.#headers.has(String(name).toLowerCase()); }
  removeHeader(name) { this.#headers.delete(String(name).toLowerCase()); }
  appendHeader(name, value) {
    const key = String(name).toLowerCase();
    const before = this.#headers.get(key);
    this.#headers.set(key, before === undefined ? value : [].concat(before, value));
    return this;
  }
  setTimeout() { return this; }

  writeHead(status, reason, headers) {
    if (this.headersSent) return this;
    this.statusCode = status;
    const given = typeof reason === "string" ? headers : reason;
    for (const [name, value] of Object.entries(given || {})) this.setHeader(name, value);
    this.#sendHead();
    return this;
  }

  flushHeaders() { this.#sendHead(); }

  #sendHead() {
    if (this.headersSent) return;
    this.headersSent = true;
    const headers = {};
    for (const [name, value] of this.#headers) if (!DROPPED_RESPONSE_HEADERS.has(name)) headers[name] = value;
    this.#link.channel.sendFrame(encodeFrame(FRAME.RES, this.#stream, encodeJson({ status: this.statusCode, headers }))).catch((error) => this.destroy(error));
  }

  write(chunk, encoding, callback) {
    this.#sendHead();
    return super.write(chunk, encoding, callback);
  }

  end(chunk, encoding, callback) {
    if (!this.writableEnded) this.#sendHead();
    return super.end(chunk, encoding, callback);
  }

  _write(chunk, _encoding, callback) {
    this.#link.sendBody(FRAME.RES_BODY, this.#stream, chunk).then(() => callback(), callback);
  }

  // Everything queued while the last write waited goes as one: a replay of thousands of events is a handful of frames.
  _writev(chunks, callback) {
    this.#link.sendBody(FRAME.RES_BODY, this.#stream, Buffer.concat(chunks.map(({ chunk }) => chunk))).then(() => callback(), callback);
  }

  _final(callback) {
    this.#link.channel.sendFrame(encodeFrame(FRAME.RES_END, this.#stream)).then(() => callback(), callback);
  }

  _destroy(error, callback) {
    this.#onDone();
    callback(error);
  }
}

/** The parts of http.IncomingMessage the routes use. No address, so it cannot pass as a request from this machine. */
class ChannelRequest extends IncomingBody {
  socket = Object.freeze({ remoteAddress: undefined, destroy() {} });
  httpVersion = "1.1";

  constructor({ method, url, headers, device, giveBack }) {
    super(giveBack);
    this.method = method;
    this.url = url;
    this.headers = headers;
    this.omniChannel = Object.freeze({ deviceId: device.id, deviceName: device.name, role: device.role });
  }

  setTimeout() { return this; }
}

/** What the audit keeps of a target. A query can hold search text, so it goes, but a file read must name its file. */
function auditPath(target) {
  const path = target.split(/[?#]/, 1)[0].slice(0, MAX_AUDIT_PATH);
  if (!path.startsWith("/api/fs/")) return path;
  let query;
  try { query = new URL(target, "http://audit.invalid").searchParams; } catch { return path; }
  const kept = new URLSearchParams();
  for (const name of ["root", "path"]) if (query.has(name)) kept.set(name, query.get(name));
  const text = kept.toString();
  return `${path}${text ? `?${text}` : ""}`.slice(0, MAX_AUDIT_PATH);
}

function safeHeaders(given) {
  const headers = { host: CHANNEL_HOST };
  for (const [name, value] of Object.entries(given ?? {})) {
    const key = name.toLowerCase();
    if (SAFE_REQUEST_HEADERS.has(key) && typeof value === "string") headers[key] = value;
  }
  return headers;
}

/**
 * Serves one channel until it closes.
 *   device  { id, name, role }, from the verified log
 *   audit   audit({at, device, deviceName, method, path}), called for every request, refused ones too. No body, and only
 *           the path as sent, so an odd attempt can be recognised, plus `root` and `path` for a file route.
 */
export function serveChannel(channel, handle, { device, audit = () => {}, limits = {} }) {
  const { maxBody = MAX_BODY, maxStreams = MAX_STREAMS, window = WINDOW } = limits;
  const link = new Link(channel, window);
  const streams = new Map();
  let highest = 0;

  const giveBack = (bytes) => link.consumed(bytes);

  function answer(id, status, error) {
    const res = new ChannelResponse(link, id, () => {});
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error }));
  }

  function onRequest(id, payload) {
    // Stream ids only go up, so a replayed request cannot run twice even if it got past the channel's own counter.
    const head = decodeHead(payload);
    if (id <= highest || !head || typeof head.method !== "string" || typeof head.path !== "string") {
      channel.close("closed");
      return;
    }
    highest = id;
    audit({ at: Date.now(), device: device.id, deviceName: device.name, method: head.method.slice(0, 16), path: auditPath(head.path) });
    if (!channelAllowed(head.method, head.path)) return answer(id, 403, "that is not available over a channel");
    if (streams.size >= maxStreams) return answer(id, 503, "too many requests at once on this channel");

    const req = new ChannelRequest({ method: head.method, url: head.path, headers: safeHeaders(head.headers), device, giveBack });
    const stream = { req, res: null, size: 0 };
    const res = new ChannelResponse(link, id, () => {
      streams.delete(id);
      req.destroy();
      link.flushAcks();
    });
    stream.res = res;
    streams.set(id, stream);
    Promise.resolve().then(() => handle(req, res)).catch(() => {
      if (!res.headersSent) answer(id, 500, "internal error");
      res.destroy();
    });
  }

  function onBody(id, payload) {
    if (!link.received(payload.length)) return;
    const stream = streams.get(id);
    // A body for a request already answered: dropped, and its credit given straight back.
    if (!stream || stream.req.destroyed || stream.over) return link.consumed(payload.length);
    stream.size += payload.length;
    if (stream.size > maxBody) {
      stream.over = true;
      link.consumed(payload.length);
      if (!stream.res.headersSent) {
        stream.res.writeHead(413, { "Content-Type": "application/json" });
        stream.res.end(JSON.stringify({ error: "request too large" }));
      }
      stream.req.destroy();
      return;
    }
    stream.req.deliver(payload);
  }

  channel.onFrame((bytes) => {
    let frame;
    try { frame = decodeFrame(bytes); } catch { return channel.close("closed"); }
    switch (frame.type) {
      case FRAME.REQ:
        if (frame.payload.length > MAX_HEAD) return channel.close("closed");
        return onRequest(frame.stream, frame.payload);
      case FRAME.REQ_BODY: return onBody(frame.stream, frame.payload);
      case FRAME.REQ_END: { const s = streams.get(frame.stream); if (s && !s.req.destroyed && !s.over) s.req.push(null); return undefined; }
      case FRAME.ABORT: { const s = streams.get(frame.stream); if (s) { s.req.destroy(); s.res.destroy(); } return undefined; }
      case FRAME.ACK:
        try { link.credit.release(decodeAck(frame.payload)); } catch { channel.close("closed"); }
        return undefined;
      default: return channel.close("closed");
    }
  });

  channel.once("close", (reason) => {
    const error = new Error(String(reason || "the channel closed"));
    link.credit.fail(error);
    for (const { req, res } of [...streams.values()]) { req.destroy(); res.destroy(); }
    streams.clear();
  });
}

/**
 * The client end: channelClient(channel).request({method, path, headers?, body?}) resolves when the response's head
 * arrives, to {status, headers, body: Readable, buffer(), text(), json(), abort()}. Fails, never hangs, if the channel closes.
 */
export function channelClient(channel, { window = WINDOW } = {}) {
  const link = new Link(channel, window);
  const calls = new Map();
  let nextId = 1;
  let closedWith = channel.closed ? new Error("the channel is closed") : null;

  const end = (id) => calls.delete(id);

  channel.onFrame((bytes) => {
    let frame;
    try { frame = decodeFrame(bytes); } catch { return channel.close("closed"); }
    const call = calls.get(frame.stream);
    switch (frame.type) {
      case FRAME.ACK:
        try { link.credit.release(decodeAck(frame.payload)); } catch { channel.close("closed"); }
        return undefined;
      case FRAME.RES: {
        if (!call || call.body) return undefined;
        const head = decodeHead(frame.payload);
        if (!head || !Number.isInteger(head.status)) return channel.close("closed");
        call.body = new IncomingBody((n) => link.consumed(n));
        call.body.on("close", () => { if (calls.get(frame.stream) === call && call.ended) end(frame.stream); });
        call.resolve({
          status: head.status,
          headers: head.headers ?? {},
          body: call.body,
          abort() {
            call.stopped = true;
            end(frame.stream);
            if (!channel.closed) channel.sendFrame(encodeFrame(FRAME.ABORT, frame.stream)).catch(() => {});
            call.body.destroy();
          },
          async buffer() {
            const parts = [];
            for await (const chunk of call.body) parts.push(chunk);
            return Buffer.concat(parts);
          },
          async text() { return (await this.buffer()).toString(); },
          async json() { return JSON.parse(await this.text()); },
        });
        return undefined;
      }
      case FRAME.RES_BODY:
        if (!link.received(frame.payload.length)) return undefined;
        if (!call?.body || call.body.destroyed) return link.consumed(frame.payload.length);
        call.body.deliver(frame.payload);
        return undefined;
      case FRAME.RES_END:
        if (!call) return undefined;
        call.stopped = true; // the host has answered: the rest of an upload is not wanted
        call.ended = true;
        call.body?.push(null);
        link.flushAcks();
        return undefined;
      case FRAME.ABORT:
        if (!call) return undefined;
        end(frame.stream);
        call.fail(new Error("the host ended this request"));
        return undefined;
      default: return channel.close("closed");
    }
  });

  channel.once("close", (reason) => {
    closedWith = new Error(String(reason || "the channel closed"));
    link.credit.fail(closedWith);
    for (const call of [...calls.values()]) call.fail(closedWith);
    calls.clear();
  });

  return {
    request({ method, path, headers, body }) {
      if (closedWith || channel.closed) return Promise.reject(closedWith ?? new Error("the channel is closed"));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const call = {
          resolve, body: null, stopped: false, ended: false,
          fail(error) {
            reject(error);
            if (call.body && !call.body.destroyed) call.body.destroy(error);
          },
        };
        calls.set(id, call);
        const send = async () => {
          await channel.sendFrame(encodeFrame(FRAME.REQ, id, encodeJson({ method, path, headers })));
          for (let at = 0; body && at < body.length && !call.stopped; at += MAX_CHUNK) {
            const piece = body.subarray(at, at + MAX_CHUNK);
            await link.credit.take(piece.length);
            await channel.sendFrame(encodeFrame(FRAME.REQ_BODY, id, piece));
          }
          if (!call.stopped) await channel.sendFrame(encodeFrame(FRAME.REQ_END, id));
        };
        send().catch((error) => { end(id); call.fail(error); });
      });
    },
    close(reason) { channel.close(reason); },
  };
}
