/**
 * Supervises the one `opencode serve` child every chat shares, and is its transport: `request()` is the HTTP API
 * (basic auth, `?directory=`), `listen()` delivers the `/global/event` SSE stream per session. The child is
 * relaunched after an unexpected exit and the stream reconnects with back-off; listeners survive both.
 */
import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { request as httpRequest } from "node:http";
import { createLineSplitter } from "./jsonl.mjs";
import { restartDelay, nextRestartState } from "./watchdog.mjs";

/** Fixed argv: no user text ever reaches cmd.exe (Windows runs opencode.cmd through the shell). */
const SERVE_ARGS = ["serve", "--port", "0", "--hostname", "127.0.0.1"];
const LISTENING = /opencode server listening on (http:\/\/\S+)/;
/** Stands in for the child in `url` (attach) mode, where nothing is spawned. */
const ATTACHED = Object.freeze({ attached: true, pid: null });

/** The session a payload belongs to: `properties.sessionID` ‖ `properties.info.sessionID` ‖ `properties.part.sessionID`. */
export function sessionIdOf(payload) {
  const p = payload?.properties;
  return p?.sessionID || p?.info?.sessionID || p?.part?.sessionID || null;
}

/** SSE framing: `data:` lines are joined until a blank line ends the block; other fields are ignored. */
function createSseParser(onData) {
  let buf = "";
  let data = [];
  return (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      let line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line === "") { if (data.length) onData(data.join("\n")); data = []; }
      else if (line.startsWith("data:")) data.push(line.slice(line[5] === " " ? 6 : 5));
    }
  };
}

/** The message of an OpenCode error body: `{name, data:{message}}`, `{message}` or `{_tag}`. */
function errorMessage(text, status) {
  let j = null;
  try { j = JSON.parse(text); } catch { /* not JSON */ }
  return j?.data?.message || j?.message || j?.name || j?._tag || text.trim() || `HTTP ${status}`;
}

/**
 * Emits "up" each time the event stream (re)connects and "down" once when it is lost or the child exits.
 * `log(level, text)` gets the child's output and lifecycle notes. `url` attaches to a running server without
 * spawning. `platform`, `backoff` ({base, cap} for restartDelay), `startTimeoutMs` and `spawnSync` are for tests.
 */
export class OpencodeServer extends EventEmitter {
  constructor({ bin = "opencode", configDir, env = {}, log, spawn = nodeSpawn, spawnSync = nodeSpawnSync, url = null, password = null, platform = process.platform, backoff = {}, startTimeoutMs = 60000 } = {}) {
    super();
    this.bin = bin;
    this.configDir = configDir;
    this.env = env;
    this.log = typeof log === "function" ? log : () => {};
    this.spawnFn = spawn;
    this.spawnSyncFn = spawnSync;
    this.fixedUrl = url;
    this.givenPassword = password;
    this.password = password;
    this.platform = platform;
    this.backoff = backoff;
    this.startTimeoutMs = startTimeoutMs;
    this.child = null;
    this.baseUrl = url;
    this.stopped = true;
    this.up = false;
    /** When the last SSE payload (heartbeats included) arrived. */
    this.lastEventAt = 0;
    this.lastHealthyAt = 0;
    this.restarts = 0;
    this.restartTimer = null;
    this.sessionListeners = new Map();
    this.upWaiters = new Set();
    this.sse = { gen: 0, req: null, timer: null, attempts: 0 };
  }

  /** The child while it runs (a marker object when attached to `url`); null otherwise. */
  get proc() {
    if (this.fixedUrl) return this.stopped ? null : ATTACHED;
    return this.child;
  }

  get url() { return this.baseUrl; }

  /** Resolves once the server is listening and its event stream is connected. A failed first start does not retry. */
  async start() {
    if (!this.stopped) return this.waitUp();
    this.stopped = false;
    if (!this.fixedUrl) this.password = this.givenPassword || randomBytes(24).toString("base64url");
    try {
      await this.boot();
    } catch (e) {
      this.stop();
      throw e;
    }
  }

  async boot() {
    if (!this.fixedUrl) await this.spawnChild();
    this.openEvents();
    await this.waitUp();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.closeEvents();
    this.setUp(false);
    for (const w of this.upWaiters) w.reject(new Error("opencode server stopped"));
    this.upWaiters.clear();
    const child = this.child;
    if (child) this.killTree(child);
  }

  /**
   * For Omni's process `exit` handler, where nothing asynchronous runs any more: ends the child's tree before
   * returning (a spawned taskkill would not outlive the wait), so no `opencode serve` outlives Omni. Never relaunches.
   */
  killSync() {
    this.stopped = true;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.closeEvents();
    const child = this.child;
    this.child = null;
    if (!child) return;
    if (this.platform === "win32" && child.pid) {
      try { this.spawnSyncFn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 10000 }); return; } catch { /* fall through */ }
    }
    try { child.kill("SIGTERM"); } catch { /* gone */ }
  }

  /** `shell:true` on Windows makes the child cmd.exe: killing it alone would orphan the real server. */
  killTree(child) {
    if (this.platform === "win32" && child.pid) {
      try {
        const k = this.spawnFn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        k.on?.("error", () => { try { child.kill(); } catch { /* gone */ } });
        return;
      } catch { /* fall through */ }
    }
    try { child.kill(); } catch { /* gone */ }
  }

  spawnChild() {
    const win = this.platform === "win32";
    let cmd = win && !/\.(cmd|bat|exe)$/i.test(this.bin) ? `${this.bin}.cmd` : this.bin;
    if (win && /\s/.test(cmd)) cmd = `"${cmd}"`;
    const env = { ...process.env, ...this.env, OPENCODE_SERVER_PASSWORD: this.password };
    if (this.configDir) env.OPENCODE_CONFIG_DIR = this.configDir;
    // Through the shell the argv is one fixed command line (an args array with shell:true is deprecated, DEP0190).
    const child = win
      ? this.spawnFn(`${cmd} ${SERVE_ARGS.join(" ")}`, [], { env, shell: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
      : this.spawnFn(cmd, SERVE_ARGS, { env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    this.child = child;
    return new Promise((resolve, reject) => {
      let settled = false;
      let stderrTail = "";
      const settle = (err, url) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) return reject(err);
        this.baseUrl = url;
        resolve();
      };
      const timer = setTimeout(() => {
        settle(new Error(`opencode serve did not report its address within ${this.startTimeoutMs}ms`));
        this.killTree(child);
      }, this.startTimeoutMs);
      const out = createLineSplitter((line) => {
        const m = LISTENING.exec(line);
        if (m && !settled) { this.log("info", line); settle(null, m[1]); } else this.log("stdout", line);
      });
      child.stdout?.setEncoding?.("utf8");
      child.stdout?.on("data", (c) => out.push(c));
      child.stdout?.on("error", () => {});
      child.stderr?.setEncoding?.("utf8");
      child.stderr?.on("data", (t) => { stderrTail = (stderrTail + t).slice(-2000); this.log("stderr", t); });
      child.stderr?.on("error", () => {});
      child.on("exit", (code, signal) => {
        const tail = stderrTail.trim();
        settle(new Error(`opencode serve exited (code ${code}${signal ? `, ${signal}` : ""}) before listening${tail ? `: ${tail}` : ""}`));
        this.handleExit(child, code, signal);
      });
      child.on("error", (e) => {
        this.log("error", `opencode spawn failed: ${e.message}`);
        settle(new Error(`opencode spawn failed: ${e.message}`));
        if (!child.pid) this.handleExit(child, null, null);
      });
    });
  }

  handleExit(child, code, signal) {
    if (child !== this.child) return;
    this.child = null;
    this.baseUrl = null;
    this.closeEvents();
    this.setUp(false);
    this.log(this.stopped ? "info" : "system", `opencode exited (code ${code}${signal ? `, ${signal}` : ""})`);
    if (this.stopped) return;
    this.scheduleRestart();
  }

  /**
   * Relaunches after back-off and never gives up (watchdog.mjs: fail open). A relaunch that failed with no child left
   * (spawn threw synchronously) schedules the next one; one whose child exited was already rescheduled by handleExit,
   * and one whose child still runs (the stream did not connect yet) is left to the stream's own reconnects.
   */
  scheduleRestart() {
    if (this.stopped || this.restartTimer) return;
    this.restarts = nextRestartState({ restarts: this.restarts, lastHealthyAt: this.lastHealthyAt }).restarts;
    const delay = restartDelay(this.restarts++, this.backoff);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.stopped) return;
      this.boot().catch((e) => {
        this.log("system", `opencode restart failed: ${e.message}`);
        if (!this.child) this.scheduleRestart();
      });
    }, delay);
  }

  setUp(up) {
    if (this.up === up) return;
    this.up = up;
    if (up) {
      this.lastHealthyAt = Date.now();
      for (const w of this.upWaiters) w.resolve();
      this.upWaiters.clear();
    }
    this.emit(up ? "up" : "down");
  }

  waitUp() {
    if (this.up) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const w = {
        resolve: () => { clearTimeout(timer); resolve(); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      };
      const timer = setTimeout(() => { this.upWaiters.delete(w); reject(new Error(`opencode event stream did not connect within ${this.startTimeoutMs}ms`)); }, this.startTimeoutMs);
      this.upWaiters.add(w);
    });
  }

  authHeader() {
    return this.password ? { authorization: `Basic ${Buffer.from(`opencode:${this.password}`).toString("base64")}` } : {};
  }

  /** Opens `/global/event`; a lost stream reconnects with back-off while the child runs (a dead child is relaunched instead). */
  openEvents() {
    this.closeEvents();
    if (this.stopped || !this.baseUrl) return;
    const gen = ++this.sse.gen;
    const lost = (why) => {
      if (gen !== this.sse.gen) return;
      this.sse.gen++;
      this.sse.req = null;
      this.setUp(false);
      if (this.stopped || (!this.fixedUrl && !this.child)) return;
      const delay = restartDelay(this.sse.attempts++, this.backoff);
      this.log("system", `opencode event stream lost (${why}); reconnecting in ${delay}ms`);
      this.sse.timer = setTimeout(() => { this.sse.timer = null; this.openEvents(); }, delay);
    };
    const req = httpRequest(new URL("/global/event", this.baseUrl), { headers: { accept: "text/event-stream", ...this.authHeader() }, agent: false });
    this.sse.req = req;
    req.on("error", (e) => lost(e.code || e.message));
    req.on("response", (res) => {
      if (res.statusCode !== 200) { res.resume(); return lost(`HTTP ${res.statusCode}`); }
      if (gen !== this.sse.gen) return res.destroy();
      this.sse.attempts = 0;
      this.setUp(true);
      res.setEncoding("utf8");
      res.on("data", createSseParser((data) => { if (gen === this.sse.gen) this.onData(data); }));
      res.on("error", (e) => lost(e.code || e.message));
      res.on("close", () => lost("closed"));
    });
    req.end();
  }

  closeEvents() {
    this.sse.gen++;
    clearTimeout(this.sse.timer);
    this.sse.timer = null;
    const req = this.sse.req;
    this.sse.req = null;
    try { req?.destroy(); } catch { /* ignore */ }
  }

  onData(data) {
    let ev;
    try { ev = JSON.parse(data); } catch { return this.log("raw", data); }
    this.lastEventAt = Date.now();
    const payload = ev?.payload ?? ev;
    const sid = sessionIdOf(payload);
    const fns = sid && this.sessionListeners.get(sid);
    if (!fns) return;
    for (const fn of [...fns]) {
      try { fn(payload); } catch (e) { this.log("error", `opencode listener for ${sid} threw: ${e.message}`); }
    }
  }

  /** Calls `fn(payload)` for every `{type, properties}` payload of `sessionID`; returns the unsubscribe. */
  listen(sessionID, fn) {
    let fns = this.sessionListeners.get(sessionID);
    if (!fns) this.sessionListeners.set(sessionID, (fns = new Set()));
    fns.add(fn);
    return () => {
      fns.delete(fn);
      if (!fns.size && this.sessionListeners.get(sessionID) === fns) this.sessionListeners.delete(sessionID);
    };
  }

  /**
   * One API call. `directory` becomes `?directory=` (the project the call acts on); `body` is sent as JSON.
   * Resolves the parsed JSON (null for an empty body / 204); a 4xx/5xx rejects with Error(OpenCode's message)
   * carrying `status` and `body`.
   */
  request(method, path, { directory, body, timeoutMs = 120000 } = {}) {
    return new Promise((resolve, reject) => {
      if (!this.baseUrl || (this.stopped && !this.fixedUrl)) return reject(new Error("opencode server is not running"));
      let target = path;
      if (directory) target += `${path.includes("?") ? "&" : "?"}directory=${encodeURIComponent(directory)}`;
      const payload = body === undefined ? null : JSON.stringify(body);
      const headers = { accept: "application/json", ...this.authHeader() };
      if (payload != null) { headers["content-type"] = "application/json"; headers["content-length"] = Buffer.byteLength(payload); }
      const req = httpRequest(new URL(target, this.baseUrl), { method, headers });
      const timer = setTimeout(() => req.destroy(new Error(`opencode ${method} ${path} timed out after ${timeoutMs}ms`)), timeoutMs);
      req.on("error", (e) => { clearTimeout(timer); reject(e); });
      req.on("response", (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { text += c; });
        res.on("error", (e) => { clearTimeout(timer); reject(e); });
        res.on("end", () => {
          clearTimeout(timer);
          if (res.statusCode >= 400) {
            const err = new Error(errorMessage(text, res.statusCode));
            err.status = res.statusCode;
            err.body = text;
            return reject(err);
          }
          if (!text.trim()) return resolve(null);
          try { resolve(JSON.parse(text)); } catch { resolve(text); }
        });
      });
      req.end(payload ?? undefined);
    });
  }
}
