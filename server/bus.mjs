/**
 * One event stream for everything. Keeps a ring buffer so a browser that
 * reconnects can catch up with `?since=<seq>`.
 */
import { EventEmitter } from "node:events";

export class Bus extends EventEmitter {
  constructor({ ring = 4000 } = {}) {
    super();
    this.setMaxListeners(100);
    this.seq = 0;
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
    for (const res of this.clients) {
      try { res.write(line); } catch { this.clients.delete(res); }
    }
    super.emit("event", ev);
    return true;
  }

  addClient(res, since = 0) {
    this.clients.add(res);
    for (const ev of this.ring) if (ev.seq > since) res.write(`data: ${JSON.stringify(ev)}\n\n`);
  }

  removeClient(res) {
    this.clients.delete(res);
  }
}
