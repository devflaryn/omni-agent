/** A stand-in for OpencodeServer (server/opencode-server.mjs) shared by the OpencodeRpc and server tests. */
import { EventEmitter } from "node:events";

export const CATALOG = {
  all: [
    { id: "opencode", name: "OpenCode Zen", models: {
      "big-pickle": { id: "big-pickle", name: "Big Pickle", limit: { context: 200000, output: 32000 }, reasoning: true, variants: { none: {}, low: {}, high: {}, medium: {} }, cost: { input: 0, output: 0 }, status: "active" },
      plain: { id: "plain", name: "Plain", limit: { context: 8000, output: 1000 }, reasoning: false, cost: { input: 1, output: 2 } },
      think: { id: "think", name: "Thinker", limit: { context: 8000, output: 1000 }, reasoning: true, variants: { high: {}, max: {} } },
      old: { id: "old", name: "Old", limit: { context: 1, output: 1 }, status: "deprecated" },
    } },
    { id: "anthropic", name: "Anthropic", models: { x: { id: "x", name: "X", limit: { context: 1, output: 1 } } } },
  ],
  connected: ["opencode"],
  default: { opencode: "big-pickle" },
};

/**
 * Stands in for OpencodeServer: `request` records every call and answers from small defaults (`reply` overrides
 * them), `listen` keeps the session's listener so `push` can feed it payloads; emits "down"/"up" when told to.
 * `catalog` replaces the `GET /provider` answer; `start`/`stop` are counted.
 */
export class FakeServer extends EventEmitter {
  constructor({ reply, catalog = CATALOG, up = true } = {}) {
    super();
    this.calls = [];
    this.fns = new Map();
    this.up = up;
    this.proc = up ? { pid: 4242 } : null;
    this.url = "http://127.0.0.1:1";
    this.n = 0;
    this.history = new Map();
    this.status = {};
    this.catalog = catalog;
    this.starts = 0;
    this.stops = 0;
    this.reply = reply || (() => undefined);
  }

  async start() {
    this.starts++;
    if (!this.up) { this.up = true; this.proc = { pid: 4242 }; this.emit("up"); }
  }
  stop() { this.stops++; if (this.up) { this.up = false; this.proc = null; this.emit("down"); } }
  waitUp() { return this.up ? Promise.resolve() : new Promise((r) => this.once("up", r)); }

  async request(method, path, opts = {}) {
    this.calls.push({ method, path, ...opts });
    if (!this.up) throw new Error("opencode server is not running");
    const own = await this.reply(method, path, opts);
    if (own !== undefined) { if (own instanceof Error) throw own; return own; }
    let m;
    if (method === "POST" && path === "/session") return { id: `ses_fake${++this.n}`, title: "New session - 2026-10-23T00:00:00.000Z" };
    if (method === "GET" && path === "/provider") return this.catalog;
    if (method === "GET" && path === "/session/status") return this.status;
    if (method === "POST" && (m = /^\/session\/([^/]+)\/fork$/.exec(path))) return { id: `ses_fork${++this.n}`, title: "fork" };
    if (method === "GET" && (m = /^\/session\/([^/]+)\/message$/.exec(path))) return this.history.get(m[1]) || [];
    if (method === "GET" && (m = /^\/session\/([^/]+)$/.exec(path))) return { id: m[1], title: m[1] === "ses_titled" ? "Fix the build" : "New session - 2026-10-23T00:00:00.000Z" };
    if (/prompt_async$/.test(path)) return null;
    return true;
  }

  listen(sessionID, fn) {
    if (!this.fns.has(sessionID)) this.fns.set(sessionID, new Set());
    this.fns.get(sessionID).add(fn);
    return () => this.fns.get(sessionID)?.delete(fn);
  }

  push(payload) {
    const p = payload.properties || {};
    const sid = p.sessionID || p.info?.sessionID || p.part?.sessionID;
    for (const fn of [...(this.fns.get(sid) || [])]) fn(payload);
  }

  listeners_(sid) { return this.fns.get(sid)?.size || 0; }
}
