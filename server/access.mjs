/**
 * Who may do what, from where.
 *
 * - **The host** (a request on the local listener, from a loopback address, naming a loopback Host, with
 *   no proxy header) reads and writes freely: it is the person at this machine.
 * - **Everyone else** (anything on the remote listener, or any request that fails one of those checks)
 *   must sign in with the host's password, and is then read-only: a request that changes something is
 *   held open, shown to the host, and runs only if the host approves it. A few routes never run remotely.
 *
 * The password is stored as a scrypt hash in ~/.omni-agent/remote-auth.json, outside the repo.
 * Remote sessions live in memory only: restarting the server signs every remote browser out.
 */
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { dirname } from "node:path";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb);
const sha256 = (s) => createHash("sha256").update(String(s)).digest("hex");

export const COOKIE = "omni_remote";
/** Long enough to resist guessing once the remote port faces the internet (the lockout does the rest). */
export const MIN_PASSWORD = 12;
export const DEVICE_COOKIE = "omni_device";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** The host is a loopback socket on the local listener whose Host header is loopback too (no DNS
 *  rebinding) and that came through no proxy (a tunnel or reverse proxy on this machine is remote). */
export function isHostRequest(req, { remoteListener = false } = {}) {
  if (remoteListener) return false;
  if (!LOOPBACK.has(req.socket?.remoteAddress || "")) return false;
  if (req.headers["x-forwarded-for"] || req.headers.forwarded || req.headers["x-real-ip"]) return false;
  const host = String(req.headers.host || "").toLowerCase().replace(/:\d+$/, "");
  return LOOPBACK_HOSTS.has(host);
}

/** The visitor's address: the one the VPS relay saw (its PROXY header, kept on the raw socket under the
 *  TLS one), else the socket's own. */
export function clientIp(req) {
  const relayed = req.socket?._parent?.omniIp || req.socket?.omniIp;
  return String(relayed || req.socket?.remoteAddress || "?").replace(/^::ffff:/, "");
}

/** A PROXY protocol v1 line ("PROXY TCP4 <src> <dst> <sport> <dport>"): the source address, or null. */
export function parseProxyLine(line) {
  const m = /^PROXY (TCP4|TCP6) ([0-9a-fA-F.:]+) ([0-9a-fA-F.:]+) (\d{1,5}) (\d{1,5})$/.exec(String(line));
  if (!m) return null;
  const want = m[1] === "TCP4" ? 4 : 6;
  return isIP(m[2]) === want && isIP(m[3]) === want ? m[2] : null;
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// ------------------------------------------------------------------------------------ routes
/** What a remote viewer may do without asking: read. Matched on method + path; anything not listed
 *  needs the host's approval, so a new route is safe until someone decides it is only a read. */
const READ = [
  ["GET", /^\/(index\.html)?$/],
  ["GET", /^\/[\w.-]+\.(js|mjs|css|svg|png|ico)$/],
  ["GET", /^\/events$/],
  ["GET", /^\/api\/state$/],
  ["GET", /^\/api\/sessions\/[^/]+\/history$/],
  ["GET", /^\/api\/(hook|goal|providers|mcp)$/],
  ["GET", /^\/api\/memory\/(list|search|note|pack|graph)$/],
  ["GET", /^\/api\/graph\/(list|data)$/],
  ["POST", /^\/api\/graph\/(query|explain)$/],
  ["GET", /^\/api\/fs\/(list|read|raw|archive-entry)$/],
  ["GET", /^\/api\/pi\/(state|stats|models|thinking-levels)$/],
  ["GET", /^\/api\/agents(\/(undelivered|[^/]+(\/log)?))?$/],
  ["GET", /^\/api\/context$/],
  ["GET", /^\/api\/remote\/me$/],
];
/** Never from a remote browser, approval or not: the host's own controls. */
const HOST_ONLY = [
  /^\/api\/shutdown$/,
  /^\/api\/claude\/task$/,
  /^\/api\/remote\/(password|approvals|sessions|status|devices)(\/.*)?$/,
];

/** "read" | "write" | "host" for a remote request. */
export function classify(method, path) {
  if (HOST_ONLY.some((re) => re.test(path))) return "host";
  if (READ.some(([m, re]) => m === method && re.test(path))) return "read";
  return "write";
}

// ------------------------------------------------------------------------------- describing
const SECRET_KEY = /key|token|secret|password|authorization|cookie/i;
/** A request body as the host sees it: secrets replaced, long strings and images cut. */
export function redact(value, depth = 0) {
  if (depth > 6) return "…";
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === "images" && Array.isArray(v)) { out[k] = `${v.length} image(s)`; continue; }
      if (k === "env" || k === "headers") { out[k] = Object.keys(v && typeof v === "object" ? v : {}); continue; }
      out[k] = SECRET_KEY.test(k) && v ? "(hidden)" : redact(v, depth + 1);
    }
    return out;
  }
  if (typeof value === "string" && value.length > 600) return `${value.slice(0, 600)}… (${value.length} characters)`;
  return value;
}

const clip = (s, n = 140) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };

/** One plain sentence for the approval card, plus the message text when there is one. */
export function describe(method, path, body = {}, { titleOf = () => "" } = {}) {
  let m;
  const chat = (sid) => { const t = titleOf(sid); return t ? `“${clip(t, 60)}”` : "a chat"; };
  if ((m = /^\/api\/sessions\/([^/]+)\/continue$/.exec(path))) return { title: `Send a message to ${chat(decodeURIComponent(m[1]))}${body.fork ? " (as a fork)" : ""}`, text: body.message || "" };
  if (method === "DELETE" && (m = /^\/api\/sessions\/([^/]+)$/.exec(path))) return { title: `Delete ${chat(decodeURIComponent(m[1]))}` };
  if (path === "/api/pi/prompt") return { title: body.sid ? `Send a message to ${chat(body.sid)}` : "Send a message to pi", text: body.message || "" };
  if (path === "/api/pi/open") return { title: `Open a new pi chat${body.cwd ? ` in ${body.cwd}` : ""}` };
  if (path === "/api/pi/send") return { title: `Start a new pi chat${body.cwd ? ` in ${body.cwd}` : ""}`, text: body.message || "" };
  if (path === "/api/pi/start") return { title: `Start pi${body.cwd ? ` in ${body.cwd}` : ""}` };
  if (path === "/api/pi/stop") return { title: body.sid ? `Close the pi of ${chat(body.sid)}` : "Stop every pi chat" };
  if (path === "/api/pi/abort") return { title: body.sid ? `Stop ${chat(body.sid)} and its goal` : "Stop pi's current turn and its goal" };
  if (path === "/api/pi/new") return { title: "Start a new pi chat" };
  if (path === "/api/pi/switch") return { title: "Switch pi to another chat" };
  if (path === "/api/pi/model") return { title: `Switch pi's model to ${body.provider || "?"}/${body.modelId || "?"}` };
  if (path === "/api/pi/thinking") return { title: `Set pi's thinking level to ${body.level || "?"}` };
  if (path === "/api/pi/compact") return { title: "Compact pi's context" };
  if (path === "/api/goal") return { title: "Set pi's goal and start working on it", text: body.goal || "" };
  if (path === "/api/hook") return { title: "Change the goal-hook settings" };
  if (path === "/api/claude/run") return { title: `Start Claude Code${body.cwd ? ` in ${body.cwd}` : ""}`, text: body.prompt || "" };
  if (path === "/api/claude/abort") return { title: "Stop a Claude Code run" };
  if ((m = /^\/api\/providers\/([^/]+)$/.exec(path))) return { title: `${method === "DELETE" ? "Remove" : "Change"} the model provider “${decodeURIComponent(m[1])}”` };
  if (path === "/api/providers-order") return { title: "Reorder the model providers" };
  if ((m = /^\/api\/provider-keys\/([^/]+)$/.exec(path))) return { title: method === "DELETE" ? `Remove OpenCode's key for “${decodeURIComponent(m[1])}”` : `Set OpenCode's API key for “${decodeURIComponent(m[1])}”` };
  if ((m = /^\/api\/mcp\/([^/]+)$/.exec(path))) return { title: method === "DELETE" ? `Remove the MCP server “${decodeURIComponent(m[1])}”` : `Change the MCP server “${decodeURIComponent(m[1])}”${body.command ? ` — it runs: ${clip([body.command, ...(body.args || [])].join(" "), 200)}` : ""}` };
  if (path === "/api/mcp-test") return { title: `Test-connect an MCP server${body.command ? ` — runs: ${clip([body.command, ...(body.args || [])].join(" "), 200)}` : ""}` };
  if (path === "/api/memory/note") return { title: `${method === "DELETE" ? "Delete" : "Write"} the vault note ${body.path || ""}`.trim() };
  if (path === "/api/memory/save") return { title: `Save a memory${body.name ? `: ${clip(body.name, 60)}` : ""}` };
  if (path === "/api/memory/import-claude") return { title: "Import Claude Code's memory into the vault" };
  if (path === "/api/memory/reindex") return { title: "Rebuild the vault index" };
  if (path === "/api/memory/digest") return { title: "Write a digest of a chat into the vault" };
  if (path === "/api/memory/open-vault") return { title: "Open the vault folder on this computer" };
  if (path === "/api/graph/build") return { title: `Build a repo graph${body.dir ? ` of ${body.dir}` : ""}` };
  return { title: `${method} ${path}` };
}

// ------------------------------------------------------------------------------------ auth
export class RemoteAuth {
  constructor({ file, sessionTtlMs = 7 * 86_400_000, deviceTtlMs = 180 * 86_400_000, now = Date.now, failDelayMs = 400 } = {}) {
    this.file = file;
    this.sessionTtlMs = sessionTtlMs;
    this.deviceTtlMs = deviceTtlMs;
    this.now = now;
    this.failDelayMs = failDelayMs;
    this.sessions = new Map();
    this.failures = new Map();
    this.globalFailures = [];
    this.record = this.load();
  }

  load() {
    try { return this.file && existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf8")) : null; } catch { return null; }
  }

  save() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, `${JSON.stringify(this.record, null, 2)}\n`, { mode: 0o600 });
  }

  hasPassword() { return !!(this.record?.hash && this.record?.salt); }

  /** A new password signs every remote browser out; the trusted devices stay trusted. */
  async setPassword(password) {
    const pw = String(password || "");
    if (pw.length < MIN_PASSWORD) throw Object.assign(new Error(`the password needs at least ${MIN_PASSWORD} characters`), { status: 400 });
    const salt = randomBytes(16).toString("base64");
    const hash = (await scrypt(pw, salt, 64)).toString("base64");
    this.record = { v: 1, salt, hash, setAt: new Date(this.now()).toISOString(), devices: this.record?.devices || [] };
    this.save();
    this.sessions.clear();
  }

  async check(password) {
    if (!this.hasPassword()) return false;
    const want = Buffer.from(this.record.hash, "base64");
    const got = await scrypt(String(password || ""), this.record.salt, want.length);
    return got.length === want.length && timingSafeEqual(got, want);
  }

  /** 5 wrong passwords from one address in 15 minutes lock that address out for the rest of the window;
   *  30 from anywhere lock every remote login, so a botnet cannot just rotate addresses. */
  lockedFor(ip) {
    const now = this.now(), win = 15 * 60_000;
    this.globalFailures = this.globalFailures.filter((t) => now - t < win);
    if (this.globalFailures.length >= 30) return win - (now - this.globalFailures[0]);
    const list = (this.failures.get(ip) || []).filter((t) => now - t < win);
    this.failures.set(ip, list);
    return list.length >= 5 ? win - (now - list[0]) : 0;
  }

  /** The password check alone, with the lockout: throws 503/429/401, or returns once it is right. */
  async verify(ip, password) {
    if (!this.hasPassword()) throw Object.assign(new Error("remote access has no password yet: set one on the host first"), { status: 503 });
    const locked = this.lockedFor(ip);
    if (locked > 0) throw Object.assign(new Error(`too many wrong passwords: try again in ${Math.ceil(locked / 60_000)} min`), { status: 429 });
    if (!(await this.check(password))) {
      const now = this.now();
      this.failures.set(ip, [...(this.failures.get(ip) || []), now]);
      this.globalFailures.push(now);
      if (this.failDelayMs) await new Promise((r) => setTimeout(r, this.failDelayMs));
      throw Object.assign(new Error("wrong password"), { status: 401 });
    }
    this.failures.delete(ip);
  }

  createSession(ip, { userAgent = "" } = {}) {
    const token = randomBytes(32).toString("base64url");
    this.sessions.set(token, { ip, userAgent: String(userAgent).slice(0, 200), createdAt: this.now(), lastSeen: this.now() });
    return token;
  }

  async login(ip, password, opts = {}) {
    await this.verify(ip, password);
    return this.createSession(ip, opts);
  }

  // ------------------------------------------------------------------ trusted devices
  // A browser the host approved once keeps a random token (only its SHA-256 is stored), so a leaked
  // password alone never signs a new device in: that still needs the host's Approve.
  devices() {
    const now = this.now();
    return (this.record?.devices || []).filter((d) => now - d.addedAt < this.deviceTtlMs);
  }

  trustDevice({ label = "", ip = "" } = {}) {
    if (!this.record) throw Object.assign(new Error("no password set"), { status: 503 });
    const token = randomBytes(32).toString("base64url");
    const id = randomBytes(6).toString("hex");
    this.record.devices = [...this.devices(), { id, hash: sha256(token), label: String(label).slice(0, 200), ip, addedAt: this.now(), lastSeen: this.now() }];
    this.save();
    return token;
  }

  isTrustedDevice(token) {
    if (!token) return false;
    const h = sha256(token);
    const d = this.devices().find((x) => x.hash.length === h.length && timingSafeEqual(Buffer.from(x.hash), Buffer.from(h)));
    if (!d) return false;
    d.lastSeen = this.now();
    this.save();
    return true;
  }

  removeDevice(id) {
    const before = this.devices().length;
    this.record.devices = this.devices().filter((d) => id !== "all" && d.id !== id);
    this.save();
    return before - this.record.devices.length;
  }

  listDevices() { return this.devices().map(({ id, label, ip, addedAt, lastSeen }) => ({ id, label, ip, addedAt, lastSeen })); }

  session(token) {
    const s = token && this.sessions.get(token);
    if (!s) return null;
    if (this.now() - s.createdAt > this.sessionTtlMs) { this.sessions.delete(token); return null; }
    s.lastSeen = this.now();
    return s;
  }

  logout(token) { this.sessions.delete(token); }
  logoutAll() { const n = this.sessions.size; this.sessions.clear(); return n; }
  list() { return [...this.sessions.values()].map(({ ip, userAgent, createdAt, lastSeen }) => ({ ip, userAgent, createdAt, lastSeen })); }
}

// ------------------------------------------------------------------------------- approvals
/** Remote changes wait here until the host decides. `request()` resolves "approved" | "denied" | "timeout"
 *  | "cancelled" (the remote browser went away). Emits "change" with the pending list. */
export class Approvals extends EventEmitter {
  constructor({ timeoutMs = 5 * 60_000 } = {}) {
    super();
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.seq = 0;
  }

  request(info, { signal } = {}) {
    const id = `a${++this.seq}-${randomBytes(3).toString("hex")}`;
    return new Promise((resolve) => {
      const done = (outcome) => {
        if (!this.pending.has(id)) return;
        clearTimeout(entry.timer);
        this.pending.delete(id);
        this.emit("change", this.list());
        this.emit("decided", { id, outcome });
        resolve(outcome);
      };
      const entry = { id, at: Date.now(), ...info, done, timer: setTimeout(() => done("timeout"), this.timeoutMs) };
      this.pending.set(id, entry);
      signal?.addEventListener?.("abort", () => done("cancelled"), { once: true });
      this.emit("change", this.list());
    });
  }

  decide(id, approve) {
    const e = this.pending.get(id);
    if (!e) return false;
    e.done(approve ? "approved" : "denied");
    return true;
  }

  list() {
    return [...this.pending.values()].map(({ done: _d, timer: _t, ...rest }) => ({ ...rest, expiresAt: rest.at + this.timeoutMs }));
  }

  dispose() { for (const e of [...this.pending.values()]) e.done("cancelled"); }
}
