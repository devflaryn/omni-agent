/**
 * Owns one long-lived `pi --mode rpc` child and turns its JSONL stream into
 * omni events. Commands get an id so responses can be awaited.
 */
import { THINKING_LEVELS, thinkingProfile } from "../ui/thinking.js";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { createLineSplitter } from "./jsonl.mjs";
import { normalizePiRpcEvent } from "./normalize.mjs";
import { cleanTitle } from "../ui/lib.js";
import { restartDelay, nextRestartState, stalled, DEFAULT_TOOL_STALL_MS } from "./watchdog.mjs";

const normPath = (p) => (p ? resolve(String(p)).toLowerCase() : "");
/** An argument cmd.exe passes through unchanged (no spaces, quotes, newlines, %, ^, &, |, <, >, !). */
const CMD_SAFE_ARG = /^[\w@+=:,./\\-]+$/;

/**
 * Every thinking level `set_thinking_level` accepts. pi has no RPC to enumerate a model's own (the old
 * `get_available_thinking_levels` was removed), so they are guessed from the model's family (ui/thinking.js).
 */
export const PI_THINKING_LEVELS = THINKING_LEVELS;
/** How long pi may take to answer a prompt: it answers after its preflight, which may compact the session. */
export const PROMPT_TIMEOUT_MS = 30 * 60 * 1000;
/** Throws when an RPC response failed or was cancelled, so callers can't silently proceed. */
const ok = (r, what) => {
  if (!r?.success) throw new Error(r?.error || `${what} failed`);
  if (r.data?.cancelled) throw new Error(`${what} was cancelled`);
  return r;
};

/**
 * Emits "pi" (every raw RPC event) and "exit" (code) when the child process ends, before the
 * auto-restart decision: a listener that calls stop() there keeps the child from being relaunched.
 */
export class PiRpc extends EventEmitter {
  constructor({ cli, bin = "pi", cwd, model = "", provider = "", thinking = "", env = {}, bus, extraArgs = [], meta = {}, platform = process.platform }) {
    super();
    this.cli = cli;
    this.bin = bin;
    this.platform = platform;
    this.cwd = cwd;
    /** Extra environment for the child (provider API keys read from key files). */
    this.env = env;
    this.model = model;
    this.provider = provider;
    this.thinking = thinking;
    this.bus = bus;
    /** Appended after the launch flags (a background agent's persona: --append-system-prompt, --tools). */
    this.extraArgs = Array.isArray(extraArgs) ? extraArgs : [];
    /** Spread into every `session` event (a background agent's parentSid, agentId, agentKind). */
    this.meta = meta && typeof meta === "object" ? meta : {};
    /** toolCallIds of tool executions that started and have not ended: a long tool is not a stall. */
    this.openTools = new Set();
    this.proc = null;
    this.pending = new Map();
    this.nextId = 1;
    this.state = null; // last get_state data
    this.sid = "pi:pending";
    this.streaming = false;
    this.stopped = false;
    this.restarts = 0;
    this.resumeFile = null;
    this.onRestart = null;
    // True from the moment a crashed session is captured until resumeSession() has put the child
    // back on it. While true, the supervisor must NOT mirror the transient empty-session `session`
    // event over the resume anchor (that was C1: resume landed in the empty session).
    this.restoring = false;
    this.lastEventAt = 0;
    this.lastHealthyAt = 0;
    this.watchdogTimer = null;
    /** Prompts sent and not yet answered: a child with one is not free for another chat (server/index.mjs). */
    this.inFlight = 0;
    /** The sid the child had when it crashed, so the supervisor can carry that chat's goal onto the resumed one. */
    this.crashedSid = null;
  }

  get ctx() {
    return { sid: this.sid, harness: "pi" };
  }

  owns(file) {
    return !!this.state?.sessionFile && normPath(this.state.sessionFile) === normPath(file);
  }

  /** pi's argv after the cli/bin: the launch flags, then `extraArgs`. */
  launchArgs() {
    const args = ["--mode", "rpc"];
    if (this.provider) args.push("--provider", this.provider);
    if (this.model) args.push("--model", this.model);
    if (this.thinking) args.push("--thinking", this.thinking);
    return [...args, ...this.extraArgs];
  }

  start() {
    this.stopped = false;
    const args = this.launchArgs();
    const useNode = !!this.cli;
    const win = this.platform === "win32";
    // The Windows fallback runs pi.cmd through cmd.exe, which joins the argv unquoted: a persona body
    // (spaces, newlines) would arrive split into words and cut at its first line. Refuse instead.
    if (!useNode && win && this.extraArgs.some((a) => !CMD_SAFE_ARG.test(String(a)))) {
      throw new Error("pi's cli.js was not found (set piCli in Omni's config): the pi.cmd fallback runs through cmd.exe, which cannot pass a background agent's system prompt");
    }
    const env = { ...process.env, ...this.env };
    this.proc = useNode
      ? spawn(process.execPath, [this.cli, ...args], { cwd: this.cwd, env, windowsHide: true })
      : spawn(win ? `${this.bin}.cmd` : this.bin, args, { cwd: this.cwd, env, shell: win, windowsHide: true });
    this.attachPipeGuards();

    const splitter = createLineSplitter((line) => this.onLine(line));
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (c) => splitter.push(c));
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (t) => this.bus.emit({ ...this.ctx, kind: "log", ts: Date.now(), level: "stderr", text: t }));
    this.proc.on("exit", (code) => this.handleExit(code));
    this.proc.on("error", (e) => this.bus.emit({ ...this.ctx, kind: "log", ts: Date.now(), level: "error", text: `pi spawn failed: ${e.message}` }));
    // Learn our session identity, then announce it.
    this.ready = this.refreshState();
    this.ready.catch(() => {});
    return this;
  }

  attachPipeGuards() {
    // A dead pi mid-write would otherwise emit an unhandled 'error' on stdin and kill the server.
    this.proc?.stdin?.on("error", (e) => this.bus.emit({ ...this.ctx, kind: "log", ts: Date.now(), level: "system", text: `pi stdin error: ${e.code || e.message}` }));
  }

  stop() {
    this.stopped = true;
    this.stopWatchdog();
    try { this.proc?.kill(); } catch { /* ignore */ }
  }

  async handleExit(code) {
    // A child stopped on purpose (a spare chat's pi closed, a restart) is not news: only a crash is toasted.
    this.bus.emit({ ...this.ctx, kind: "log", ts: Date.now(), level: this.stopped ? "info" : "system", text: `pi exited (code ${code})` });
    for (const [, p] of this.pending) p.reject(new Error("pi exited"));
    this.pending.clear();
    this.proc = null;
    this.streaming = false;
    this.openTools.clear();
    this.emit("exit", code);
    if (this.stopped) return;
    // Capture the session the crashed child had BEFORE a fresh child opens an empty one, and latch
    // `restoring` so the empty session's `session` event can't clobber this anchor (C1).
    this.resumeFile = this.state?.sessionFile || this.resumeFile;
    this.crashedSid = this.sid;
    this.restoring = true;
    const reset = nextRestartState({ restarts: this.restarts, lastHealthyAt: this.lastHealthyAt });
    this.restarts = reset.restarts;
    const delay = restartDelay(this.restarts++);
    setTimeout(() => {
      this.start();
      this.ready?.then(() => this.resumeSession()).catch((e) => this.bus.emit({ ...this.ctx, kind: "log", ts: Date.now(), level: "system", text: `pi resume failed: ${e.message}` }));
    }, delay);
  }

  /** After a restart, put the child back on the session it had, then let the supervisor replay. */
  async resumeSession() {
    try {
      if (this.resumeFile) { try { await this.switchSession(this.resumeFile); } catch (e) { this.bus.emit({ ...this.ctx, kind: "log", ts: Date.now(), level: "system", text: `switch_session on resume failed: ${e.message}` }); } }
      if (this.onRestart) await this.onRestart();
    } finally {
      // Resume is over (success, failure, or no anchor to resume): let the supervisor mirror session events again.
      this.restoring = false;
    }
  }

  /** `toolStallMs` applies instead of `stallMs` while a tool call is open (a build or a device boot emits nothing for long). */
  startWatchdog({ stallMs = 360000, toolStallMs = DEFAULT_TOOL_STALL_MS, intervalMs = 30000 } = {}) {
    this.stopWatchdog();
    this.watchdogTimer = setInterval(() => this.checkStall({ stallMs, toolStallMs }), intervalMs);
    this.watchdogTimer.unref?.();
  }
  stopWatchdog() { if (this.watchdogTimer) clearInterval(this.watchdogTimer); this.watchdogTimer = null; }

  checkStall({ now = Date.now(), stallMs = 360000, toolStallMs = DEFAULT_TOOL_STALL_MS } = {}) {
    const openTools = this.openTools.size;
    if (!stalled({ streaming: this.streaming, lastEventAt: this.lastEventAt, now, stallMs, openTools, toolStallMs })) return;
    const tools = openTools ? ` with ${openTools} tool call${openTools === 1 ? "" : "s"} open` : "";
    this.bus.emit({ ...this.ctx, kind: "log", ts: Date.now(), level: "system", text: `pi stream stalled ${Math.round((now - this.lastEventAt) / 1000)}s${tools} — aborting + restarting` });
    this.abort?.().catch(() => {});
    try { this.proc?.kill(); } catch { /* exit handler restarts */ }
  }

  onLine(line) {
    let ev;
    try { ev = JSON.parse(line); } catch { return this.bus.emit({ ...this.ctx, kind: "log", ts: Date.now(), level: "raw", text: line }); }
    this.lastEventAt = Date.now();
    if (ev.type === "response") {
      const p = ev.id != null ? this.pending.get(ev.id) : null;
      if (p) { this.pending.delete(ev.id); p.resolve(ev); }
      return;
    }
    if (ev.type === "agent_start" || ev.type === "turn_start") { this.streaming = true; this.lastHealthyAt = Date.now(); }
    if (ev.type === "agent_settled") { this.streaming = false; this.openTools.clear(); }
    if (ev.type === "tool_execution_start" && ev.toolCallId) this.openTools.add(ev.toolCallId);
    if (ev.type === "tool_execution_end" && ev.toolCallId) this.openTools.delete(ev.toolCallId);
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
    this.bus.emit({ ...this.meta, ...this.ctx, kind: "session", ts: Date.now(), owned: true, cwd: this.cwd, file: r.data.sessionFile, sessionId: r.data.sessionId, model: r.data.model?.id, provider: r.data.model?.provider, thinkingLevel: r.data.thinkingLevel, title: cleanTitle(r.data.sessionName) || undefined });
    this.bus.emit({ ...this.ctx, kind: "status", ts: Date.now(), streaming: !!r.data.isStreaming });
    return r.data;
  }

  /**
   * `echo: false` for prompts the user did not type (hooks): no user bubble is broadcast.
   * `behavior` while pi is streaming: "steer" (default: delivered after the current tool call) or
   * "followUp" (queued until the agent would stop). It is always sent, as pi reads it only while it streams,
   * and a run an extension's wake-up just started is one Omni has not seen begin yet.
   *
   * One prompt at a time: pi's prompt() checks it is idle, then awaits (auth, compaction, every
   * before_agent_start hook) before it claims the run, so two in that window both start one; the loser clears
   * pi's busy flag mid-run and emits a false agent_settled. pi answers a prompt as it claims the run, so the
   * next one is sent after that answer and gets queued.
   *
   * That answer can take minutes: a long session is compacted first (a model call per chunk). Timing it out at
   * send()'s default failed a message pi then ran anyway, and let the next prompt in mid-compaction, which pi rejects.
   */
  prompt(message, { images, echo = true, behavior } = {}) {
    const cmd = { type: "prompt", message, streamingBehavior: behavior || "steer" };
    if (images?.length) cmd.images = images;
    // Echo the user's prompt as a live message so every viewer sees it at once.
    if (echo) this.bus.emit({ ...this.ctx, kind: "msg", ts: Date.now(), id: `u-${Date.now()}`, role: "user", live: true, blocks: [{ type: "text", text: message }] });
    this.inFlight++;
    const sent = (this.promptChain || Promise.resolve()).then(() => this.send(cmd, { timeoutMs: PROMPT_TIMEOUT_MS }));
    this.promptChain = sent.catch(() => {});
    sent.then(() => { this.inFlight--; }, () => { this.inFlight--; });
    return sent;
  }

  async abort() {
    this.send({ type: "abort_bash" }).catch(() => {});
    this.send({ type: "clear_queue" }).catch(() => {});
    return this.send({ type: "abort" });
  }
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
  /** The levels `model` ({provider, id, name, reasoning, thinkingLevelMap}) has; the full ladder without one. */
  thinkingLevels(model) {
    if (!model?.id) return { success: true, data: { levels: PI_THINKING_LEVELS, labels: {} } };
    const t = thinkingProfile(model);
    return { success: true, data: { levels: t.levels, labels: t.labels, family: t.family, guessed: t.guessed } };
  }
  compact() { return this.send({ type: "compact" }, { timeoutMs: 600000 }); }
  messages() { return this.send({ type: "get_messages" }); }
  /** Every session entry incl. pre-compaction history, plus the active leaf (the goal hook recovers the plan from it). */
  entries() { return this.send({ type: "get_entries" }); }
}
