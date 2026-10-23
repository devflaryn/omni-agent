/**
 * One Omni chat on the shared `opencode serve` (OpencodeServer), behind the pi RPC contract (the harness Omni used before OpenCode) so the
 * rest of the server drives it like the pi child it replaced. Its session's SSE payloads go through OpencodeTranslator: the pi RPC events feed the bus
 * (via normalizeRpcEvent) and the pi JSONL entries are appended to the chat's mirror file, which the watcher,
 * reload, continue and the goal hook read like any pi session file.
 */
import { EventEmitter } from "node:events";
import { appendFileSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { THINKING_LEVELS } from "../ui/thinking.js";
import { cleanTitle } from "../ui/lib.js";
import { OpencodeTranslator, historyEntries } from "./opencode-events.mjs";
import { normalizePiEntry, normalizeRpcEvent } from "./normalize.mjs";
import { stalled, DEFAULT_TOOL_STALL_MS } from "./watchdog.mjs";

const normPath = (p) => (p ? resolve(String(p)).toLowerCase() : "");
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
/**
 * What `proc` is while the server is up: chats share one server, so a background agent's tree-kill (which needs a pid)
 * must never reach it, and kill() is a no-op (stop() ends the chat).
 */
const SHARED_PROC = Object.freeze({ pid: null, kill() {} });
/** OpenCode's placeholder titles are not a chat name. */
const PLACEHOLDER_TITLE = /^(New|Child) session - /;
const CATALOG_TTL_MS = 60000;
/** Mirror entry (`{type:"custom", customType, data:{messageIDs}}`, invisible to the watcher) naming OpenCode messages never to mirror. */
const KNOWN = "opencode-known";

/** A model's OpenCode `variants` as thinking levels ("none" is off), in ladder order; unknown names last. */
function variantLevels(variants) {
  const keys = Array.isArray(variants) ? variants : Object.keys(variants && typeof variants === "object" ? variants : {});
  const levels = [...new Set(keys.map((k) => (k === "none" ? "off" : String(k))))];
  const rank = (l) => { const i = THINKING_LEVELS.indexOf(l); return i < 0 ? THINKING_LEVELS.length : i; };
  return levels.sort((a, b) => rank(a) - rank(b));
}

/** The raw model `id` of `providerID` in a `GET /provider` catalog, or null. */
export function findModel(catalog, providerID, id) {
  const p = catalog?.all?.find((x) => x.id === providerID);
  return p?.models?.[id] || Object.values(p?.models || {}).find((m) => m.id === id) || null;
}

/** OpenCode puts the flag under `capabilities` (older catalogs and tests at the top). */
const reasoningOf = (m) => !!(m?.capabilities?.reasoning ?? m?.reasoning);

/** `state.model` of a catalog model. */
const modelOf = (provider, m) => ({ provider, id: m.id, name: m.name || m.id, contextWindow: num(m.limit?.context), maxTokens: num(m.limit?.output), reasoning: reasoningOf(m), variants: variantLevels(m.variants) });

/**
 * The thinking levels a catalog model offers ({levels, labels}, ui/thinking.js shape): its variants; without any,
 * only "off" — labelled "auto" for a reasoning model, which then thinks as its provider decides.
 */
export function modelThinking(m) {
  const levels = variantLevels(m?.variants);
  if (levels.length) return { levels, labels: {} };
  return { levels: ["off"], labels: { off: reasoningOf(m) ? "auto" : "off" } };
}

/** The model picker's list: connected providers' models, deprecated ones left out. */
export function pickerModels(catalog) {
  const connected = Array.isArray(catalog?.connected) ? new Set(catalog.connected) : null;
  const out = [];
  for (const p of catalog?.all || []) {
    if (connected && !connected.has(p.id)) continue;
    for (const m of Object.values(p.models || {})) {
      if (!m?.id || m.status === "deprecated") continue;
      const t = modelThinking(m);
      out.push({ provider: p.id, id: m.id, name: m.name || m.id, contextWindow: num(m.limit?.context) || null, thinking: t.levels, thinkingLabels: t.labels, free: m.cost?.input === 0 && m.cost?.output === 0 });
    }
  }
  return out;
}

/** Whether a connected provider of the catalog offers provider/id (not deprecated). */
export function inCatalog(catalog, provider, id) {
  if (Array.isArray(catalog?.connected) && !catalog.connected.includes(provider)) return false;
  const m = findModel(catalog, provider, id);
  return !!m && m.status !== "deprecated";
}

/** A pick as OpenCode's `{providerID, modelID}` (a bare "provider/model" id is split), or null for OpenCode's default. */
export function modelPick(provider, model) {
  if (!model) return null;
  if (provider) return { providerID: provider, modelID: model };
  const i = model.indexOf("/");
  return i > 0 ? { providerID: model.slice(0, i), modelID: model.slice(i + 1) } : null;
}

/** pi tool names a persona lists that OpenCode calls differently. */
const PI_TOOL_NAMES = { find: "glob", ls: "list" };

/**
 * A persona's tool allowlist (pi names) as OpenCode's per-prompt `tools` map: every tool off ("*") but the listed
 * ones; null (every tool) for an empty list.
 */
export function allowTools(names) {
  if (!Array.isArray(names) || !names.length) return null;
  const out = { "*": false };
  for (const n of names) { const k = PI_TOOL_NAMES[n] || String(n); if (k) out[k] = true; }
  return out;
}

/**
 * The tools of a one-off side call. Every tool off but `read`: OpenCode's free tier answers a request carrying no
 * tools at all with a 403 FreeTierError (verified live on OpenCode 1.18.32), and `read` is harmless.
 */
export const RUN_ONCE_TOOLS = Object.freeze({ "*": false, read: true });

/**
 * One question to a model on the shared server, outside every chat (the goal judge, the status box): one
 * `POST /session/:id/message` with `system`, resolving the reply's joined text parts. `session` continues that
 * session (a status box's side conversation, kept); without it a session is made for the call and deleted after.
 * A model error rejects with its message.
 */
export async function runOnce({ server, provider = "", model = "", system = "", input, cwd, session = null, timeoutMs = 120000 }) {
  const id = session || (await server.request("POST", "/session", { directory: cwd, body: {} })).id;
  try {
    const body = { parts: [{ type: "text", text: String(input ?? "") }], system, tools: { ...RUN_ONCE_TOOLS } };
    const pick = modelPick(provider, model);
    if (pick) body.model = pick;
    const r = await server.request("POST", `/session/${id}/message`, { directory: cwd, body, timeoutMs });
    const err = r?.info?.error;
    if (err) throw new Error(err.data?.message || err.message || err.name || "the model call failed");
    return (r?.parts || []).filter((p) => p?.type === "text" && !p.synthetic && !p.ignored && p.text).map((p) => p.text).join("\n");
  } finally {
    if (!session) server.request("DELETE", `/session/${id}`, { directory: cwd }).catch(() => {});
  }
}

/** The mirror's entries (header excluded); a missing or unreadable file has none. */
function readMirror(file) {
  let text = "";
  try { text = readFileSync(file, "utf8"); } catch { return []; }
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { const e = JSON.parse(line); if (e?.type !== "session") out.push(e); } catch { /* a torn last line */ }
  }
  return out;
}

const TRANSCRIPT_MAX = 48000;
const LINE_MAX = 2000;
const clip = (s) => { s = String(s ?? "").trim(); return s.length > LINE_MAX ? `${s.slice(0, LINE_MAX)}…` : s; };

/** The imported-chat transcript: user/assistant text and short tool lines (thinking skipped), the tail within TRANSCRIPT_MAX chars. */
export function piTranscript(entries) {
  const out = [];
  for (const e of entries) {
    const m = e?.type === "message" ? e.message : null;
    if (!m) continue;
    const parts = typeof m.content === "string" ? [{ type: "text", text: m.content }] : Array.isArray(m.content) ? m.content : [];
    if (m.role === "user" || m.role === "assistant") {
      const who = m.role === "user" ? "User" : "Assistant";
      for (const c of parts) {
        if (c?.type === "text" && c.text?.trim()) out.push(`${who}: ${clip(c.text)}`);
        else if (c?.type === "toolCall") out.push(`Tool call ${c.name}: ${clip(JSON.stringify(c.arguments ?? {}))}`);
      }
    } else if (m.role === "toolResult") {
      const t = parts.filter((c) => c?.type === "text").map((c) => c.text).join("\n");
      out.push(`Tool result${m.toolName ? ` (${m.toolName})` : ""}${m.isError ? " [error]" : ""}: ${clip(t)}`);
    }
  }
  if (!out.length) return "";
  const kept = [];
  let size = 0;
  for (let i = out.length - 1; i >= 0; i--) {
    size += out[i].length + 1;
    if (size > TRANSCRIPT_MAX) break;
    kept.unshift(out[i]);
  }
  return `Earlier conversation, imported from pi (most recent last):\n${kept.join("\n")}`;
}

/**
 * Emits "pi" (every event in pi's RPC shape) and "exit" (null) when stop() ends the chat. `env` is accepted for
 * the old pi child's signature only: the shared server's environment applies. `system`/`tools` are sent with every prompt (a
 * background agent's persona; `tools` is OpenCode's `{name: boolean}` map, see allowTools). `ensureServer()` (a
 * promise) starts the shared server when the chat needs it and it is not running. `compactAt` > 0 compacts before a prompt once the last turn's context exceeded it.
 */
export class OpencodeRpc extends EventEmitter {
  constructor({ server, cwd, model = "", provider = "", thinking = "", env = {}, bus, meta = {}, system = "", tools = null, mirrorDir, compactAt = 0, ensureServer = null }) {
    super();
    this.server = server;
    /** Starts the shared server when it is not running (index.mjs ensureOpencode): a failed start is tried again by the next prompt. */
    this.ensureServer = typeof ensureServer === "function" ? ensureServer : null;
    this.cwd = cwd;
    this.model = model;
    this.provider = provider;
    this.thinking = thinking;
    this.env = env;
    this.bus = bus;
    /** Spread into every `session` event (a background agent's parentSid, agentId, agentKind). */
    this.meta = meta && typeof meta === "object" ? meta : {};
    this.system = system;
    this.tools = tools;
    this.mirrorDir = mirrorDir;
    this.compactAt = Number(compactAt) || 0;
    /** toolCallIds of tool executions that started and have not ended: a long tool is not a stall. */
    this.openTools = new Set();
    this.state = null;
    this.sid = "pi:pending";
    this.streaming = false;
    this.stopped = false;
    this.resumeFile = null;
    this.onRestart = null;
    /** True from the server going down until the chat is reattached and onRestart ran. */
    this.restoring = false;
    this.crashedSid = null;
    this.lastEventAt = 0;
    this.watchdogTimer = null;
    /** Prompts sent and not yet answered: a chat with one is not free for another chat (server/index.mjs). */
    this.inFlight = 0;
    this.promptChain = null;
    this.compacting = null;
    /** Context tokens (input + cacheRead) of the last assistant message, for `compactAt`. */
    this.lastContext = 0;
    /** The model OpenCode last answered with: the state's model when none was picked. */
    this.lastModel = null;
    this.live = false; // between start() and stop()
    this.alive = false; // the server's event stream is connected
    this.gen = 0; // bumped by start() and stop(): work begun before a stop must not attach or announce after it
    this.booting = false; // the first session is being opened
    this.exited = false; // "exit" was emitted for this outage or stop
    this.runLost = false; // a run was going when the server (or only its event stream) went away: stop() aborts it
    this.runSeq = 0; // counts agent_start/agent_settled, so a prompt can tell whether its run already began or ended
    this.sessionID = null;
    this.mirror = null;
    this.catalog = null;
    this.onDown = () => this.serverDown();
    this.onUp = () => { this.serverUp().catch((e) => this.log("system", `opencode reattach failed: ${e.message}`)); };
  }

  get ctx() {
    return { sid: this.sid, harness: "pi" };
  }

  /** Null until the chat has a session, after stop() and while the server is down: nothing is routed to it then. */
  get proc() {
    return this.live && this.alive && this.sessionID ? SHARED_PROC : null;
  }

  /** Throws when stop() ended the run `gen` was taken in: a stopped chat must not attach or announce anything. */
  current(gen) {
    if (gen !== this.gen) throw new Error("the chat was stopped");
  }

  owns(file) {
    return !!this.state?.sessionFile && normPath(this.state.sessionFile) === normPath(file);
  }

  log(level, text) {
    this.bus.emit({ ...this.ctx, kind: "log", ts: Date.now(), level, text });
  }

  /** Opens a new OpenCode session in `cwd` (a following switchSession drops it again while it is unused). */
  start() {
    if (!this.mirrorDir) throw new Error("OpencodeRpc needs a mirrorDir");
    this.stopped = false;
    this.live = true;
    this.exited = false;
    this.gen++;
    this.alive = !!this.server.proc && this.server.up !== false;
    // Every chat listens on the one server: lift the 10-listener warning.
    if (this.server.getMaxListeners?.() !== 0) this.server.setMaxListeners?.(0);
    this.server.off("down", this.onDown).off("up", this.onUp).on("down", this.onDown).on("up", this.onUp);
    this.boot();
    return this;
  }

  /** Opens the chat's first session. A failure is logged, and retried by the next prompt or the server's next `up`. */
  boot() {
    const gen = this.gen;
    this.booting = true;
    this.ready = (async () => {
      try {
        if (!this.alive && this.ensureServer) await this.ensureServer();
        if (!this.alive && !this.server.up && typeof this.server.waitUp === "function") await this.server.waitUp();
        await this.createSession(gen);
        return this.state;
      } catch (e) {
        if (gen === this.gen) this.log("system", `opencode could not open a session for this chat: ${e.message}`);
        throw e;
      } finally { if (gen === this.gen) this.booting = false; }
    })();
    this.ready.catch(() => {});
    return this.ready;
  }

  /**
   * Ends the chat: stops listening, aborts a turn still running (a killed pi child would have ended it too) and drops
   * a session nobody used. Emits "exit" unless the server's going down already did.
   */
  stop() {
    // A run the outage cut off from Omni may still go on in OpenCode (only the event stream was lost): abort it too.
    const busy = this.streaming || this.inFlight > 0 || this.runLost;
    this.runLost = false;
    const wasLive = this.live;
    this.gen++;
    this.stopped = true;
    this.live = false;
    this.booting = false;
    this.stopWatchdog();
    this.unlisten?.();
    this.unlisten = null;
    this.server.off("down", this.onDown).off("up", this.onUp);
    if (busy && this.sessionID) this.abortStopped(this.sessionID);
    else if (wasLive && this.sessionID && !this.used) this.discard(this.sessionID, this.mirror);
    this.streaming = false;
    this.openTools.clear();
    if (wasLive && !this.exited) { this.exited = true; this.emit("exit", null); }
  }

  /** Best effort: the stopped chat's run is aborted now, or — the server being down right now — once it is back. */
  abortStopped(id) {
    const send = () => this.server.request("POST", `/session/${id}/abort`, { directory: this.cwd });
    send().catch(() => {
      if (this.server.up) send().catch(() => {});
      else this.server.once("up", () => { send().catch(() => {}); });
    });
  }

  /**
   * The server is gone: the run is over for Omni (status streaming:false) and "exit" tells a background agent its
   * process died (agents.mjs onPiExit). A live chat reattaches on `up`; one stopped meanwhile does not.
   */
  serverDown() {
    if (!this.live || !this.alive) return;
    this.alive = false;
    if (!this.sessionID) return; // nothing to restore: the session is opened once the server is back
    if (this.translator) this.translator.streaming = false;
    // Remembered for stop(): when only the event stream was lost, OpenCode goes on with the run.
    this.runLost = this.streaming || this.inFlight > 0;
    this.streaming = false;
    this.openTools.clear();
    this.resumeFile = this.state?.sessionFile || this.resumeFile;
    this.crashedSid = this.sid;
    this.restoring = true;
    this.log("system", "opencode server went away — the chat reattaches when it is back");
    this.bus.emit({ ...this.ctx, kind: "status", ts: Date.now(), streaming: false });
    if (!this.exited) { this.exited = true; this.emit("exit", null); }
  }

  /** Back after a "down": mirror what was missed, re-read the run state, then let the supervisor replay. */
  async serverUp() {
    if (!this.live || this.alive) return;
    this.alive = true;
    if (!this.sessionID) { if (!this.booting) this.boot(); return; }
    if (!this.restoring) return;
    const gen = this.gen;
    // A fresh translator on the mirror's end: a message the outage left open must not stand for a later run's.
    this.retranslate();
    try {
      await this.catchUp(await this.reconcile());
      await this.refreshState();
    } catch (e) { this.log("system", `opencode reattach failed: ${e.message}`); }
    if (gen !== this.gen) return;
    this.runLost = false; // `streaming` says again whether OpenCode runs the session
    this.exited = false;
    try { if (this.onRestart) await this.onRestart(); }
    catch (e) { this.log("system", `opencode resume failed: ${e.message}`); }
    finally { this.restoring = false; }
  }

  /** `toolStallMs` applies instead of `stallMs` while a tool call is open (a build or a device boot emits nothing for long). */
  startWatchdog({ stallMs = 360000, toolStallMs = DEFAULT_TOOL_STALL_MS, intervalMs = 30000 } = {}) {
    this.stopWatchdog();
    this.watchdogTimer = setInterval(() => this.checkStall({ stallMs, toolStallMs }), intervalMs);
    this.watchdogTimer.unref?.();
  }
  stopWatchdog() { if (this.watchdogTimer) clearInterval(this.watchdogTimer); this.watchdogTimer = null; }

  /**
   * A stalled run is aborted (the shared server is never restarted for one chat), then OpenCode's own run state is
   * re-read: a session that is idle settles here even when its idle event never arrived.
   */
  checkStall({ now = Date.now(), stallMs = 360000, toolStallMs = DEFAULT_TOOL_STALL_MS } = {}) {
    const openTools = this.openTools.size;
    if (!stalled({ streaming: this.streaming, lastEventAt: this.lastEventAt, now, stallMs, openTools, toolStallMs })) return;
    const tools = openTools ? ` with ${openTools} tool call${openTools === 1 ? "" : "s"} open` : "";
    this.log("system", `opencode stream stalled ${Math.round((now - this.lastEventAt) / 1000)}s${tools} — aborting`);
    this.abort().catch(() => {}).then(() => this.syncStatus()).catch(() => {});
  }

  // ---------------------------------------------------------------- session + mirror

  newMirrorPath(id) {
    return join(this.mirrorDir, `${new Date().toISOString().replace(/:/g, "-")}_${id}.jsonl`);
  }
  header(id) {
    return JSON.stringify({ type: "session", version: 3, id, cwd: this.cwd, timestamp: new Date().toISOString(), harness: "opencode" });
  }

  /**
   * Points the chat at session `id` and its mirror `file`, and listens to it; returns what it was on before. Messages
   * already in the mirror, and those its `opencode-known` entries list (a fork's copies), are never mirrored again.
   */
  attach(id, file) {
    const prev = { id: this.sessionID, file: this.mirror, used: this.used };
    this.unlisten?.();
    const entries = readMirror(file);
    this.sessionID = id;
    this.mirror = file;
    this.sid = `pi:${id}`;
    this.mirrored = new Set(entries.map((e) => e.id));
    this.known = new Set(entries.filter((e) => e.type === "custom" && e.customType === KNOWN).flatMap((e) => e.data?.messageIDs || []));
    this.lastId = entries.at(-1)?.id ?? null;
    this.used = entries.length > 0;
    this.translator = new OpencodeTranslator({ sessionID: id, cwd: this.cwd, parentId: this.lastId });
    this.streaming = false;
    this.openTools.clear();
    this.lastContext = 0;
    this.unlisten = this.server.listen(id, (p) => this.onPayload(p));
    return prev;
  }

  /** A session left before anything was said in it is dropped, like pi never writing a session nobody used. */
  dropUnused(prev) {
    if (!prev.id || prev.id === this.sessionID || prev.used) return;
    this.discard(prev.id, prev.file);
  }
  discard(id, file) {
    if (file) { try { unlinkSync(file); } catch { /* already gone */ } }
    this.server.request("DELETE", `/session/${id}`, { directory: this.cwd }).catch(() => {});
  }

  async createSession(gen = this.gen) {
    const info = await this.server.request("POST", "/session", { directory: this.cwd, body: {} });
    if (gen !== this.gen) { this.discard(info.id, null); this.current(gen); }
    const file = this.newMirrorPath(info.id);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${this.header(info.id)}\n`);
    this.dropUnused(this.attach(info.id, file));
    return this.announce(info);
  }

  /** Appends translator/history entries to the mirror, once per entry id. */
  appendEntries(entries) {
    const fresh = entries.filter((e) => e?.id && !this.mirrored.has(e.id));
    if (!fresh.length) return [];
    for (const e of fresh) { this.mirrored.add(e.id); this.lastId = e.id; }
    this.used = true;
    try { appendFileSync(this.mirror, fresh.map((e) => `${JSON.stringify(e)}\n`).join("")); }
    catch (e) { this.log("error", `could not write the chat mirror ${this.mirror}: ${e.message}`); }
    return fresh;
  }

  /**
   * Finished messages OpenCode has that the mirror missed (while the event stream was gone, or while no chat was
   * attached), chained onto its end.
   */
  async reconcile() {
    const msgs = await this.server.request("GET", `/session/${this.sessionID}/message`, { directory: this.cwd });
    const fresh = (Array.isArray(msgs) ? msgs : []).filter((m) => !this.known.has(m?.info?.id) && !this.mirrored.has(m?.info?.id));
    const missed = historyEntries(fresh, { cwd: this.cwd }).filter((e) => !this.mirrored.has(e.id));
    let parent = this.lastId;
    const added = this.appendEntries(missed.map((e) => { const out = { ...e, parentId: parent }; parent = e.id; return out; }));
    this.translator.chain.last = this.lastId;
    for (const e of added) for (const ev of normalizePiEntry(e, this.ctx)) this.bus.emit(ev);
    return fresh;
  }

  /** A new translator for the session, chained onto the mirror's end (the model it last saw carries over). */
  retranslate() {
    const model = this.translator?.chain.model ?? null;
    this.translator = new OpencodeTranslator({ sessionID: this.sessionID, cwd: this.cwd, parentId: this.lastId });
    this.translator.chain.model = model;
  }

  /**
   * After attaching or reconnecting: whether OpenCode runs the session now, and — when it does — the assistant
   * messages it is still writing (`msgs`, the session's unmirrored messages), picked up so they finish whole.
   */
  async catchUp(msgs = []) {
    await this.syncStatus();
    if (!this.streaming) return;
    for (const m of msgs) {
      const { rpc, entries } = this.translator.resume(m?.info, Array.isArray(m?.parts) ? m.parts : []);
      if (entries.length) this.appendEntries(entries);
      for (const ev of rpc) this.onEvent(ev);
    }
  }

  /** Whether OpenCode is running this session right now (after attaching to it or reconnecting). */
  async syncStatus() {
    const all = await this.server.request("GET", "/session/status", { directory: this.cwd }).catch(() => null);
    const t = all?.[this.sessionID]?.type;
    const busy = t === "busy" || t === "retry";
    if (busy === this.streaming) return;
    if (busy) this.translator.begin();
    else this.translator.streaming = false;
    this.onEvent({ type: busy ? "agent_start" : "agent_settled" });
  }

  // ---------------------------------------------------------------- events

  onPayload(payload) {
    this.lastEventAt = Date.now();
    const p = payload?.properties || {};
    if (payload?.type === "permission.asked" || payload?.type === "permission.updated") return this.allow(p);
    // A message already mirrored (finished) or listed as a fork's copy is old news, even when OpenCode re-announces it.
    const mid = p.info?.id ?? p.part?.messageID ?? p.messageID;
    if (mid && (this.known.has(mid) || this.mirrored.has(mid))) return;
    const { rpc, entries } = this.translator.push(payload);
    if (entries.length) this.appendEntries(entries);
    for (const ev of rpc) this.onEvent(ev);
  }

  /** Backstop for a permission prompt the config did not pre-allow: nobody is there to answer it, so allow it. */
  allow(p) {
    if (!p?.id) return;
    this.server.request("POST", `/permission/${p.id}/reply`, { directory: this.cwd, body: { reply: "always" } })
      .catch((e) => this.log("system", `could not answer opencode's permission prompt: ${e.message}`));
  }

  onEvent(ev) {
    if (ev.type === "agent_start") { this.streaming = true; this.runSeq++; }
    if (ev.type === "agent_settled") { this.streaming = false; this.openTools.clear(); this.runSeq++; }
    if (ev.type === "tool_execution_start" && ev.toolCallId) this.openTools.add(ev.toolCallId);
    if (ev.type === "tool_execution_end" && ev.toolCallId) this.openTools.delete(ev.toolCallId);
    if (ev.type === "message_end" && ev.message?.role === "assistant") {
      const u = ev.message.usage;
      if (u && !ev.message.errorMessage) this.lastContext = num(u.input) + num(u.cacheRead);
      if (ev.message.provider && ev.message.model) this.lastModel = { providerID: ev.message.provider, modelID: ev.message.model };
    }
    for (const out of normalizeRpcEvent(ev, this.ctx)) this.bus.emit(out);
    this.emit("pi", ev);
  }

  // ---------------------------------------------------------------- state + models

  /** The `GET /provider` catalog, cached for a minute (`fresh` re-reads it). */
  async loadCatalog(fresh = false) {
    if (!fresh && this.catalog && Date.now() - this.catalog.at < CATALOG_TTL_MS) return this.catalog.value;
    const value = await this.server.request("GET", "/provider", { directory: this.cwd });
    this.catalog = { at: Date.now(), value };
    return value;
  }
  get catalogValue() { return this.catalog?.value || null; }

  /** The picked model as OpenCode's `{providerID, modelID}` (a bare "provider/model" id is split), or null for OpenCode's default. */
  pick() { return modelPick(this.provider, this.model); }

  /** The variant for the thinking level: "off" is the model's "none" variant when it has one, else nothing is sent. */
  variant() {
    const p = this.pick() || this.lastModel;
    const m = p && findModel(this.catalogValue, p.providerID, p.modelID);
    const levels = variantLevels(m?.variants);
    if (!this.thinking || !levels.includes(this.thinking)) return undefined;
    return this.thinking === "off" ? "none" : this.thinking;
  }

  async announce(info) {
    const gen = this.gen;
    const p = this.pick() || this.lastModel;
    let model = null;
    if (p) {
      const m = findModel(await this.loadCatalog().catch(() => null), p.providerID, p.modelID);
      model = m ? modelOf(p.providerID, m) : { provider: p.providerID, id: p.modelID, name: p.modelID, contextWindow: 0, maxTokens: 0, reasoning: false, variants: [] };
    }
    this.current(gen);
    const title = info?.title && !PLACEHOLDER_TITLE.test(info.title) ? info.title : undefined;
    this.state = { sessionId: this.sessionID, sessionFile: this.mirror, model, thinkingLevel: this.thinking || "off", isStreaming: this.streaming, sessionName: title };
    this.bus.emit({ ...this.meta, ...this.ctx, kind: "session", ts: Date.now(), owned: true, cwd: this.cwd, file: this.mirror, sessionId: this.sessionID, model: model?.id, provider: model?.provider, thinkingLevel: this.state.thinkingLevel, title: cleanTitle(title) || undefined });
    this.bus.emit({ ...this.ctx, kind: "status", ts: Date.now(), streaming: this.streaming });
    return this.state;
  }

  async refreshState() {
    if (!this.sessionID) throw new Error("opencode has no session for this chat yet");
    return this.announce(await this.server.request("GET", `/session/${this.sessionID}`, { directory: this.cwd }));
  }

  /** Resolves when the chat's session exists (its sid is known). */
  waitReady() { return this.ready || Promise.reject(new Error("opencode chat is not started")); }

  /** One API call as a pi-style response: an HTTP error answers `{success:false, error}`, a dead server rejects. */
  async call(method, path, body, { timeoutMs } = {}) {
    try { return { success: true, data: await this.server.request(method, path, { directory: this.cwd, body, timeoutMs }) }; }
    catch (e) { if (e.status) return { success: false, error: e.message }; throw e; }
  }

  /** Connected providers' models (deprecated ones left out), like pi's get_available_models. */
  async models() {
    const cat = await this.loadCatalog(true);
    const connected = Array.isArray(cat?.connected) ? new Set(cat.connected) : null;
    const models = [];
    for (const p of cat?.all || []) {
      if (connected && !connected.has(p.id)) continue;
      for (const m of Object.values(p.models || {})) if (m?.status !== "deprecated") models.push({ ...modelOf(p.id, m), ...(m.cost ? { cost: m.cost } : {}) });
    }
    return { success: true, data: { models } };
  }

  /** The levels `model` ({provider, id, reasoning?, variants?}) has: its variants, else only "off" ("auto" for a reasoning model). */
  thinkingLevels(model) {
    if (!model?.id) return { success: true, data: { levels: THINKING_LEVELS, labels: {} } };
    const known = findModel(this.catalogValue, model.provider, model.id);
    return { success: true, data: modelThinking({ variants: model.variants ?? known?.variants, reasoning: model.reasoning ?? reasoningOf(known) }) };
  }

  /** A model the catalog does not have is refused, like pi's set_model; the pick applies to the next prompt. */
  async setModel(provider, modelId) {
    const cat = await this.loadCatalog().catch(() => null);
    const m = findModel(cat, provider, modelId);
    const r = cat && !m ? { success: false, error: `Model not found: ${provider}/${modelId}` } : { success: true, data: m ? modelOf(provider, m) : { provider, id: modelId } };
    if (r.success) { this.provider = provider; this.model = modelId; }
    await this.refreshState();
    return r;
  }
  async setThinking(level) {
    this.thinking = level;
    await this.refreshState();
    return { success: true, data: {} };
  }

  // ---------------------------------------------------------------- prompting

  promptBody(message, images) {
    const parts = [{ type: "text", text: message }];
    for (const im of images || []) {
      if (!im?.data) continue;
      const mime = im.mimeType || "image/png";
      parts.push({ type: "file", mime, url: `data:${mime};base64,${im.data}` });
    }
    const body = { parts };
    const model = this.pick();
    if (model) body.model = model;
    const variant = this.variant();
    if (variant) body.variant = variant;
    if (this.system) body.system = this.system;
    if (this.tools) body.tools = this.tools;
    body.agent = "build";
    return body;
  }

  /**
   * `echo: false` for prompts the user did not type (hooks): no user bubble is broadcast. OpenCode queues a prompt sent
   * while the session runs into that run (pi's steer), so `behavior` needs nothing. Prompts go out one at a time, after a
   * running compaction; once the last turn's context passed `compactAt`, the next prompt compacts first.
   */
  prompt(message, { images, echo = true } = {}) {
    if (echo) this.bus.emit({ ...this.ctx, kind: "msg", ts: Date.now(), id: `u-${Date.now()}`, role: "user", live: true, blocks: [{ type: "text", text: message }] });
    this.inFlight++;
    const sent = (this.promptChain || Promise.resolve()).then(() => this.sendPrompt(message, images));
    this.promptChain = sent.catch(() => {});
    sent.then(() => { this.inFlight--; }, () => { this.inFlight--; });
    return sent;
  }

  async sendPrompt(message, images) {
    if (!this.sessionID && this.live && !this.booting) this.boot(); // the first session failed to open: try again
    await this.ready;
    if (this.compacting) await this.compacting.catch(() => {});
    if (this.compactAt > 0 && !this.streaming && this.lastContext > this.compactAt) await this.compact().catch(() => {});
    await this.loadCatalog().catch(() => null);
    this.used = true;
    const seq = this.runSeq;
    const r = await this.call("POST", `/session/${this.sessionID}/prompt_async`, this.promptBody(message, images));
    if (!r.success) return r;
    // The run counts from the accepted post: its `busy` comes over another socket, maybe later, and until then the chat
    // must not look free (server/index.mjs piFree). Not when OpenCode already started or even settled it meanwhile.
    if (!this.streaming && this.runSeq === seq) {
      this.translator.begin(); // a new run: its session.error must show even after an earlier run's error
      this.lastEventAt = Date.now();
      this.onEvent({ type: "agent_start" });
    }
    return { success: true };
  }

  abort() {
    if (!this.sessionID) return Promise.resolve({ success: false, error: "opencode has no session for this chat yet" });
    return this.call("POST", `/session/${this.sessionID}/abort`);
  }

  /** Summarizes the session with the chat's model; the translator reports compaction_start/_end from OpenCode's events. */
  compact() {
    if (this.compacting) return this.compacting;
    this.compacting = (async () => {
      await this.ready;
      const model = this.pick() || this.lastModel;
      if (!model) return { success: false, error: "no model to compact with yet" };
      this.lastContext = 0;
      const r = await this.call("POST", `/session/${this.sessionID}/summarize`, model, { timeoutMs: 600000 });
      if (!r.success) this.bus.emit({ ...this.ctx, kind: "status", ts: Date.now(), compacting: false });
      return r;
    })().finally(() => { this.compacting = null; });
    return this.compacting;
  }

  /** A fresh session and mirror; the model and thinking picks carry over (they go with each prompt). */
  async newSession() {
    await this.ready?.catch(() => {});
    await this.createSession();
    return { success: true, data: { cancelled: false } };
  }

  /**
   * A native pi chat continued on OpenCode: a new session whose mirror starts with the pi entries (history stays
   * visible), and whose model context is a `noReply` transcript message. That message is listed as known in the mirror
   * before anything can reconcile, or it would come back as a visible user message.
   */
  async importPi(sessionPath) {
    await this.ready?.catch(() => {});
    const gen = this.gen;
    const copied = readMirror(sessionPath);
    const text = piTranscript(copied);
    const info = await this.server.request("POST", "/session", { directory: this.cwd, body: {} });
    let seeded = null;
    try {
      this.current(gen);
      if (text) {
        const r = await this.server.request("POST", `/session/${info.id}/message`, { directory: this.cwd, body: { noReply: true, parts: [{ type: "text", text }] } });
        seeded = r?.info?.id || null;
        this.current(gen);
      }
    } catch (e) {
      this.discard(info.id, null);
      if (gen === this.gen) this.log("system", `could not continue the pi chat: ${e.message}`);
      throw e;
    }
    const out = [this.header(info.id), ...copied.map((e) => JSON.stringify(e))];
    if (seeded) out.push(JSON.stringify({ type: "custom", customType: KNOWN, id: `known_${info.id}`, parentId: copied.at(-1)?.id ?? null, timestamp: new Date().toISOString(), data: { messageIDs: [seeded] } }));
    const file = this.newMirrorPath(info.id);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, out.join("\n") + "\n");
    this.dropUnused(this.attach(info.id, file));
    await this.announce(info);
    return { success: true, data: { cancelled: false } };
  }

  /** Attaches to the OpenCode session of an opencode mirror file; a native pi chat file is imported into a new session. */
  async switchSession(sessionPath) {
    let head = null;
    try { head = JSON.parse(readFileSync(sessionPath, "utf8").split("\n", 1)[0]); } catch { /* not a session file */ }
    if (head?.type !== "session" || !head.id) throw new Error("not a chat file");
    if (head.harness !== "opencode") return this.importPi(sessionPath);
    await this.ready?.catch(() => {});
    const gen = this.gen;
    const info = await this.server.request("GET", `/session/${head.id}`, { directory: this.cwd });
    this.current(gen);
    this.dropUnused(this.attach(head.id, resolve(sessionPath)));
    // OpenCode may have gone on without Omni (an Omni restart mid-run): mirror what it did meanwhile.
    let msgs = [];
    try { msgs = await this.reconcile(); } catch (e) { this.log("system", `could not bring the chat mirror up to date: ${e.message}`); }
    this.current(gen);
    await this.catchUp(msgs);
    await this.announce(info);
    return { success: true, data: { cancelled: false } };
  }

  /**
   * Forks the session into a new one and switches to it (the original stays untouched). The new mirror is a copy of
   * the current one plus an `opencode-known` entry listing the fork's copied messages: OpenCode gives them new ids and
   * announces them as new, and they must never be mirrored twice. Without that list the clone fails.
   */
  async clone() {
    await this.ready;
    const gen = this.gen;
    const info = await this.server.request("POST", `/session/${this.sessionID}/fork`, { directory: this.cwd, body: {} });
    let copies;
    try {
      this.current(gen);
      const msgs = await this.server.request("GET", `/session/${info.id}/message`, { directory: this.cwd });
      copies = (Array.isArray(msgs) ? msgs : []).map((m) => m?.info?.id).filter(Boolean);
      this.current(gen);
    } catch (e) {
      this.discard(info.id, null);
      if (gen === this.gen) this.log("system", `could not clone the chat: ${e.message}`);
      throw e;
    }
    const rest = readMirror(this.mirror);
    const known = { type: "custom", customType: KNOWN, id: `known_${info.id}`, parentId: rest.at(-1)?.id ?? null, timestamp: new Date().toISOString(), data: { messageIDs: copies } };
    const file = this.newMirrorPath(info.id);
    writeFileSync(file, [this.header(info.id), ...rest.map((e) => JSON.stringify(e)), JSON.stringify(known)].join("\n") + "\n");
    this.dropUnused(this.attach(info.id, file));
    await this.announce(info);
    return { success: true, data: { cancelled: false } };
  }

  /** Every mirror entry, plus the last one as the leaf (the goal hook recovers the plan from them). */
  async entries() {
    const entries = readMirror(this.mirror);
    return { success: true, data: { entries, leafId: entries.at(-1)?.id ?? null } };
  }

  async messages() {
    const { data } = await this.entries();
    return { success: true, data: { messages: data.entries.filter((e) => e.type === "message").map((e) => e.message) } };
  }

  /** Message, tool and token counts of the mirror, like pi's get_session_stats. */
  async stats() {
    const { data } = await this.messages();
    const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
    const n = { user: 0, assistant: 0, toolCalls: 0, toolResults: 0 };
    let cost = 0;
    for (const m of data.messages) {
      if (m.role === "user") n.user++;
      else if (m.role === "toolResult") n.toolResults++;
      else if (m.role === "assistant") {
        n.assistant++;
        n.toolCalls += (m.content || []).filter((c) => c.type === "toolCall").length;
        const u = m.usage || {};
        tokens.input += num(u.input); tokens.output += num(u.output); tokens.cacheRead += num(u.cacheRead); tokens.cacheWrite += num(u.cacheWrite); tokens.total += num(u.totalTokens);
        cost += num(u.cost?.total);
      }
    }
    return { success: true, data: { sessionFile: this.mirror, sessionId: this.sessionID, userMessages: n.user, assistantMessages: n.assistant, toolCalls: n.toolCalls, toolResults: n.toolResults, totalMessages: data.messages.length, tokens, cost } };
  }
}
