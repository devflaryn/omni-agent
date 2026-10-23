/**
 * One event stream for everything. Keeps a ring buffer so a browser that
 * reconnects can catch up with `?since=<seq>&boot=<boot>`.
 */
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";

/** Chat messages the session files hold: a page reads those through the history route, never from a replay. */
const inFile = (ev) => ev.kind === "msg" && (ev.role === "assistant" || ev.role === "tool" || ev.role === "user");

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
    const line = `data: ${JSON.stringify(ev)}\n\n`;
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
   * is told to `resync` (reload its state) and gets the fresh replay.
   */
  addClient(res, since = 0, boot = "") {
    this.clients.add(res);
    const first = this.ring[0]?.seq ?? this.seq + 1;
    const lost = since > 0 && ((boot && boot !== this.boot) || since > this.seq || since < first - 1);
    if (lost) res.write(`event: resync\ndata: ${JSON.stringify({ boot: this.boot, seq: this.seq })}\n\n`);
    const fresh = since <= 0 || lost;
    for (const ev of this.ring) if (fresh ? !inFile(ev) : ev.seq > since) res.write(`data: ${JSON.stringify(ev)}\n\n`);
  }

  removeClient(res) {
    this.clients.delete(res);
  }
}
