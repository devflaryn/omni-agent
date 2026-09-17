/**
 * Owns one long-lived `pi --mode rpc` child and turns its JSONL stream into
 * omni events. Commands get an id so responses can be awaited.
 */
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { createLineSplitter } from "./jsonl.mjs";
import { normalizePiRpcEvent } from "./normalize.mjs";
import { cleanTitle } from "../ui/lib.js";

const normPath = (p) => (p ? resolve(String(p)).toLowerCase() : "");

/**
 * Thinking levels `set_thinking_level` accepts. pi has no RPC to enumerate them
 * (the old `get_available_thinking_levels` was removed), so the picker uses this
 * fixed set. "off" turns thinking off; the rest turn it on at a level. xhigh/max
 * exist only on a few models and are omitted here.
 */
export const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high"];
/** Throws when an RPC response failed or was cancelled, so callers can't silently proceed. */
const ok = (r, what) => {
  if (!r?.success) throw new Error(r?.error || `${what} failed`);
  if (r.data?.cancelled) throw new Error(`${what} was cancelled`);
  return r;
};

export class PiRpc extends EventEmitter {
  constructor({ cli, bin = "pi", cwd, model = "", provider = "", thinking = "", env = {}, bus }) {
    super();
    this.cli = cli;
    this.bin = bin;
    this.cwd = cwd;
    /** Extra environment for the child (provider API keys read from key files). */
    this.env = env;
    this.model = model;
    this.provider = provider;
    this.thinking = thinking;
    this.bus = bus;
    this.proc = null;
    this.pending = new Map();
    this.nextId = 1;
    this.state = null; // last get_state data
    this.sid = "pi:pending";
    this.streaming = false;
    this.stopped = false;
    this.restarts = 0;
  }

  get ctx() {
    return { sid: this.sid, harness: "pi" };
  }

  owns(file) {
    return !!this.state?.sessionFile && normPath(this.state.sessionFile) === normPath(file);
  }

  start() {
    this.stopped = false;
    const args = ["--mode", "rpc"];
    if (this.provider) args.push("--provider", this.provider);
    if (this.model) args.push("--model", this.model);
    if (this.thinking) args.push("--thinking", this.thinking);
    const useNode = !!this.cli;
    const env = { ...process.env, ...this.env };
    this.proc = useNode
      ? spawn(process.execPath, [this.cli, ...args], { cwd: this.cwd, env, windowsHide: true })
      : spawn(process.platform === "win32" ? `${this.bin}.cmd` : this.bin, args, { cwd: this.cwd, env, shell: process.platform === "win32", windowsHide: true });

    const splitter = createLineSplitter((line) => this.onLine(line));
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (c) => splitter.push(c));
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (t) => this.bus.emit({ ...this.ctx, kind: "log", ts: Date.now(), level: "stderr", text: t }));
    this.proc.on("exit", (code) => {
      this.bus.emit({ ...this.ctx, kind: "log", ts: Date.now(), level: "system", text: `pi exited (code ${code})` });
      for (const [, p] of this.pending) p.reject(new Error("pi exited"));
      this.pending.clear();
      this.proc = null;
      this.streaming = false;
      if (!this.stopped && this.restarts++ < 20) setTimeout(() => this.start(), 800);
    });
    this.proc.on("error", (e) => this.bus.emit({ ...this.ctx, kind: "log", ts: Date.now(), level: "error", text: `pi spawn failed: ${e.message}` }));
    // Learn our session identity, then announce it.
    this.ready = this.refreshState();
    this.ready.catch(() => {});
    return this;
  }

  stop() {
    this.stopped = true;
    try { this.proc?.kill(); } catch { /* ignore */ }
  }

  onLine(line) {
    let ev;
    try { ev = JSON.parse(line); } catch { return this.bus.emit({ ...this.ctx, kind: "log", ts: Date.now(), level: "raw", text: line }); }
    if (ev.type === "response") {
      const p = ev.id != null ? this.pending.get(ev.id) : null;
      if (p) { this.pending.delete(ev.id); p.resolve(ev); }
      return;
    }
    if (ev.type === "agent_start" || ev.type === "turn_start") this.streaming = true;
    if (ev.type === "agent_settled") this.streaming = false;
    // The omni-fallback extension switched models inside pi: re-read state so the session's model label follows.
    if (ev.type === "message_end" && ev.message?.customType === "omni-fallback") this.refreshState().catch(() => {});
    for (const out of normalizePiRpcEvent(ev, this.ctx)) this.bus.emit(out);
    this.emit("pi", ev);
  }

  send(cmd, { timeoutMs = 120000 } = {}) {
    return new Promise((resolvePromise, reject) => {
      if (!this.proc || !this.proc.stdin.writable) return reject(new Error("pi is not running"));
      const id = `r${this.nextId++}`;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`pi timeout on ${cmd.type}`)); }, timeoutMs);
      this.pending.set(id, { resolve: (r) => { clearTimeout(timer); resolvePromise(r); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this.proc.stdin.write(`${JSON.stringify({ id, ...cmd })}\n`);
    });
  }

  async refreshState() {
    const r = await this.send({ type: "get_state" });
    if (!r.success) throw new Error(r.error || "get_state failed");
    this.state = r.data;
    const newSid = `pi:${r.data.sessionId}`;
    this.sid = newSid;
    this.bus.emit({ ...this.ctx, kind: "session", ts: Date.now(), owned: true, cwd: this.cwd, file: r.data.sessionFile, sessionId: r.data.sessionId, model: r.data.model?.id, provider: r.data.model?.provider, thinkingLevel: r.data.thinkingLevel, title: cleanTitle(r.data.sessionName) || undefined });
    this.bus.emit({ ...this.ctx, kind: "status", ts: Date.now(), streaming: !!r.data.isStreaming });
    return r.data;
  }

  /** `echo: false` for prompts the user did not type (hooks): no user bubble is broadcast. */
  async prompt(message, { images, echo = true } = {}) {
    const cmd = { type: "prompt", message };
    if (images?.length) cmd.images = images;
    if (this.streaming) cmd.streamingBehavior = "steer";
    // Echo the user's prompt as a live message so every viewer sees it at once.
    if (echo) this.bus.emit({ ...this.ctx, kind: "msg", ts: Date.now(), id: `u-${Date.now()}`, role: "user", live: true, blocks: [{ type: "text", text: message }] });
    return this.send(cmd);
  }

  abort() { return this.send({ type: "abort" }); }
  /**
   * pi rebuilds the runtime on `new_session` from its launch flags, so a model or thinking level picked
   * after the child started would silently fall back. Re-apply the remembered picks to the new session.
   */
  async newSession() {
    const r = await this.send({ type: "new_session" });
    await this.refreshState();
    await this.applyPicks();
    return r;
  }
  async applyPicks() {
    const st = this.state || {};
    let changed = false;
    if (this.model && (st.model?.provider !== this.provider || st.model?.id !== this.model)) {
      const m = await this.send({ type: "set_model", provider: this.provider, modelId: this.model });
      if (m?.success) changed = true;
      else this.bus.emit({ ...this.ctx, kind: "log", ts: Date.now(), level: "system", text: `pi could not switch the new chat to ${this.provider}/${this.model}: ${m?.error || "set_model failed"}` });
    }
    if (this.thinking && st.thinkingLevel !== this.thinking) {
      const t = await this.send({ type: "set_thinking_level", level: this.thinking });
      if (t?.success) changed = true;
      else this.bus.emit({ ...this.ctx, kind: "log", ts: Date.now(), level: "system", text: `pi could not set thinking to ${this.thinking}: ${t?.error || "set_thinking_level failed"}` });
    }
    if (changed) await this.refreshState();
  }
  async switchSession(sessionPath) { const r = ok(await this.send({ type: "switch_session", sessionPath }), "switch_session"); await this.refreshState(); return r; }
  /** Resolves when the child has answered get_state (its session id is known). */
  waitReady() { return this.ready || Promise.reject(new Error("pi is not running")); }
  /** Copies the current session into a new file and switches to it (the original stays untouched). */
  async clone() { const r = ok(await this.send({ type: "clone" }), "clone"); await this.refreshState(); return r; }
  stats() { return this.send({ type: "get_session_stats" }); }
  models() { return this.send({ type: "get_available_models" }); }
  /** A successful pick is remembered: new sessions and the auto-restart start from it, not from the boot flags. */
  async setModel(provider, modelId) {
    const r = await this.send({ type: "set_model", provider, modelId });
    if (r?.success) { this.provider = provider; this.model = modelId; }
    await this.refreshState();
    return r;
  }
  async setThinking(level) {
    const r = await this.send({ type: "set_thinking_level", level });
    if (r?.success) this.thinking = level;
    await this.refreshState();
    return r;
  }
  thinkingLevels() { return { success: true, data: { levels: PI_THINKING_LEVELS } }; }
  compact() { return this.send({ type: "compact" }, { timeoutMs: 600000 }); }
  messages() { return this.send({ type: "get_messages" }); }
}
