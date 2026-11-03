/**
 * The client end of a channel, and the flow control both ends share. One file for the desktop, the web page and the iPhone
 * app. Wire format: channel-frames.js. A `channel` here is anything with sendFrame(bytes), onFrame(cb), close(reason), a
 * `closed` flag and a "close" event.
 */
import { Emitter } from "./emitter.js";
import { FRAME, MAX_CHUNK, WINDOW, decodeAck, decodeFrame, decodeHead, encodeAck, encodeFrame, encodeJson } from "./channel-frames.js";

/** How many body bytes may be on their way. A writer waits here, which is what pauses whatever feeds it. */
export class Credit {
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

/** The bookkeeping both ends of a channel share: flow control over the shared window, and sending a body in chunks. */
export class Link {
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

/**
 * A response body in a browser: `for await` gives the chunks as they come, and each is acknowledged as it is taken, so a slow
 * reader slows the far side. Ended cleanly only by RES_END. Anything else throws out of the loop, so a part of an answer
 * cannot pass for all of it.
 */
export class WebBody extends Emitter {
  destroyed = false;
  #queue = [];
  #ended = false;
  #error = null;
  #wake = null;
  #giveBack;

  constructor(giveBack) {
    super();
    this.#giveBack = giveBack;
  }

  deliver(chunk) {
    this.#queue.push(chunk);
    this.#notify();
  }

  /** As a stream's push: null is the end. */
  push(chunk) {
    if (chunk !== null) { this.deliver(chunk); return; }
    this.#ended = true;
    this.#notify();
  }

  /** Nobody will read the rest. */
  destroy(error) {
    if (this.destroyed) return;
    this.destroyed = true;
    this.#error = error ?? (this.#ended && !this.#queue.length ? null : new Error("the answer was stopped"));
    const left = this.#queue.reduce((sum, chunk) => sum + chunk.length, 0);
    this.#queue = [];
    if (left) this.#giveBack(left);
    this.#notify();
    this.emit("close");
  }

  #notify() {
    const wake = this.#wake;
    this.#wake = null;
    wake?.();
  }

  async *[Symbol.asyncIterator]() {
    try {
      for (;;) {
        if (this.#error) throw this.#error;
        if (this.#queue.length) {
          const chunk = this.#queue.shift();
          this.#giveBack(chunk.length);
          yield chunk;
        } else if (this.#ended) return;
        else await new Promise((resolve) => { this.#wake = resolve; });
      }
    } finally {
      this.destroy();
    }
  }
}

function joined(parts) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

/**
 * channelClient(channel).request({method, path, headers?, body?, signal?}) resolves when the response's head arrives, to
 * {status, headers, body, buffer(), text(), json(), abort()}. Fails, never hangs, if the channel closes.
 * `body` is bytes, or an async iterable of them, read only as the window allows. If it throws, the request is ended over there.
 * `onHeard` runs for every frame from the far side, and ping() asks for one.
 * `makeBody(giveBack)` makes what a response's bytes arrive in, `concat` joins what buffer() gathers.
 */
export function channelClient(channel, { window = WINDOW, onHeard = () => {}, makeBody = (giveBack) => new WebBody(giveBack), concat = joined } = {}) {
  const link = new Link(channel, window);
  const calls = new Map();
  let nextId = 1;
  let closedWith = channel.closed ? new Error("the channel is closed") : null;

  const end = (id) => calls.delete(id);

  channel.onFrame((bytes) => {
    let frame;
    try { frame = decodeFrame(bytes); } catch { return channel.close("closed"); }
    onHeard();
    const call = calls.get(frame.stream);
    switch (frame.type) {
      case FRAME.PONG: return undefined;
      case FRAME.ACK:
        try { link.credit.release(decodeAck(frame.payload)); } catch { channel.close("closed"); }
        return undefined;
      case FRAME.RES: {
        if (!call || call.body) return undefined;
        const head = decodeHead(frame.payload);
        if (!head || !Number.isInteger(head.status)) return channel.close("closed");
        call.body = makeBody((n) => link.consumed(n));
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
            return concat(parts);
          },
          async text() { return new TextDecoder("utf-8", { ignoreBOM: true }).decode(await this.buffer()); },
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
    ping() { return channel.closed ? Promise.reject(new Error("the channel is closed")) : channel.sendFrame(encodeFrame(FRAME.PING, 0)); },
    request({ method, path, headers, body, signal }) {
      if (closedWith || channel.closed) return Promise.reject(closedWith ?? new Error("the channel is closed"));
      if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("aborted"));
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
        const stop = (error) => {
          if (calls.get(id) !== call) return;
          call.stopped = true;
          end(id);
          if (!channel.closed) channel.sendFrame(encodeFrame(FRAME.ABORT, id)).catch(() => {});
          call.fail(error);
        };
        signal?.addEventListener("abort", () => stop(signal.reason ?? new Error("aborted")), { once: true });
        const send = async () => {
          await channel.sendFrame(encodeFrame(FRAME.REQ, id, encodeJson({ method, path, headers })));
          if (body) {
            for await (const part of body instanceof Uint8Array ? [body] : body) {
              for (let at = 0; at < part.length && !call.stopped; at += MAX_CHUNK) {
                const piece = part.subarray(at, at + MAX_CHUNK);
                await link.credit.take(piece.length);
                await channel.sendFrame(encodeFrame(FRAME.REQ_BODY, id, piece));
              }
              if (call.stopped) break;
            }
          }
          if (!call.stopped) await channel.sendFrame(encodeFrame(FRAME.REQ_END, id));
        };
        send().catch(stop);
      });
    },
    close(reason) { channel.close(reason); },
  };
}
