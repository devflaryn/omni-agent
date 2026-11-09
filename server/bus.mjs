/**
 * One event stream for everything. Keeps a ring buffer so a browser that
 * reconnects can catch up with `?since=<seq>&boot=<boot>`.
 */
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { wireEvent, resultIn } from "./wire.mjs";

/** Chat messages the session files hold: a page reads those through the history route, never from a replay. */
const inFile = (ev) => ev.kind === "msg" && (ev.role === "assistant" || ev.role === "tool" || ev.role === "user");
/** A turn's text as it is being written, which its message then holds whole. */
const streamPart = (ev) => ev.kind === "delta" || ev.kind === "block";

export class Bus extends EventEmitter {
  constructor({ ring = 4000 } = {}) {
    super();
    this.setMaxListeners(100);
    this.seq = 0;
    // Names this server run: seq starts again at 0 after a restart, so a seq alone cannot say what a page missed.
    this.boot = randomBytes(4).toString("hex");
    this.ringSize = ring;
    this.ring = [];
    this.clients = new Set();
  }

  emit(ev) {
    if (typeof ev === "string") return super.emit(ev, ...[].slice.call(arguments, 1));
    ev.seq = ++this.seq;
    this.ring.push(ev);
    if (this.ring.length > this.ringSize) this.ring.splice(0, this.ring.length - this.ringSize);
    const line = `data: ${JSON.stringify(wireEvent(ev))}\n\n`;
    const CAP = 4 * 1024 * 1024;
    for (const res of this.clients) {
      try {
        if ((res.writableLength || 0) > CAP) { this.clients.delete(res); try { res.end?.(); } catch { /* */ } continue; }
        res.write(line);
      } catch { this.clients.delete(res); }
    }
    super.emit("event", ev);
    return true;
  }

  /**
   * A page that connects for the first time (since 0) gets the ring without the chat messages: they are most of
   * its bytes (megabytes, over the relay to a phone), the history route serves them from the file anyway, and
   * their usage counted again on top of /api/state's tally doubled the token totals. A reconnect gets exactly
   * what it missed, unless that is gone (the ring wrapped, or the server restarted and seq began again): then it
   * is told to `resync` (reload its state) and gets the fresh replay. The stream parts of a turn whose message has
   * since gone by are in the file too: only a turn still running has parts the page cannot get elsewhere.
   * All of it is one write, for over a channel each write is at least a sealed frame of its own.
   */
  addClient(res, since = 0, boot = "") {
    this.clients.add(res);
    const first = this.ring[0]?.seq ?? this.seq + 1;
    const lost = since > 0 && ((boot && boot !== this.boot) || since > this.seq || since < first - 1);
    let out = lost ? `event: resync\ndata: ${JSON.stringify({ boot: this.boot, seq: this.seq })}\n\n` : "";
    const fresh = since <= 0 || lost;
    const lastInFile = new Map();
    if (fresh) for (const ev of this.ring) if (inFile(ev)) lastInFile.set(ev.sid, ev.seq);
    const wanted = (ev) => (fresh ? !inFile(ev) && !(streamPart(ev) && ev.seq < (lastInFile.get(ev.sid) ?? 0)) : ev.seq > since);
    for (const ev of this.ring) if (wanted(ev)) out += `data: ${JSON.stringify(wireEvent(ev))}\n\n`;
    if (out) res.write(out);
  }

  /** The full result of a tool call still in the ring (a live one the session file may not hold yet). */
  toolResult(sid, toolId) {
    for (let i = this.ring.length - 1; i >= 0; i--) {
      const ev = this.ring[i];
      if (ev.sid !== sid) continue;
      const r = resultIn(ev, toolId);
      if (r) return r;
    }
    return undefined;
  }

  removeClient(res) {
    this.clients.delete(res);
  }
}
