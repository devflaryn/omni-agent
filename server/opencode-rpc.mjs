/**
 * One Omni chat on the shared `opencode serve` (OpencodeServer), behind PiRpc's contract so the rest of the server
 * drives it like a pi child. Its session's SSE payloads go through OpencodeTranslator: the pi RPC events feed the bus
 * (via normalizePiRpcEvent) and the pi JSONL entries are appended to the chat's mirror file, which the watcher,
 * reload, continue and the goal hook read like any pi session file.
 */
import { EventEmitter } from "node:events";
import { appendFileSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { THINKING_LEVELS } from "../ui/thinking.js";
import { cleanTitle } from "../ui/lib.js";
import { OpencodeTranslator, historyEntries } from "./opencode-events.mjs";
import { normalizePiEntry, normalizePiRpcEvent } from "./normalize.mjs";
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

/** A model's OpenCode `variants` as thinking levels ("none" is off), in ladder order; unknown names last. */
function variantLevels(variants) {
  const keys = Array.isArray(variants) ? variants : Object.keys(variants && typeof variants === "object" ? variants : {});
  const levels = [...new Set(keys.map((k) => (k === "none" ? "off" : String(k))))];
  const rank = (l) => { const i = THINKING_LEVELS.indexOf(l); return i < 0 ? THINKING_LEVELS.length : i; };
  return levels.sort((a, b) => rank(a) - rank(b));
}

/** The raw model `id` of `providerID` in a `GET /provider` catalog, or null. */
function findModel(catalog, providerID, id) {
  const p = catalog?.all?.find((x) => x.id === providerID);
  return p?.models?.[id] || Object.values(p?.models || {}).find((m) => m.id === id) || null;
}

/** `state.model` of a catalog model. */
const modelOf = (provider, m) => ({ provider, id: m.id, name: m.name || m.id, contextWindow: num(m.limit?.context), maxTokens: num(m.limit?.output), reasoning: !!m.reasoning, variants: variantLevels(m.variants) });

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

/**
 * Emits "pi" (every pi RPC event, as PiRpc does) and "exit" (null) when stop() ends the chat. `env` is accepted for
 * PiRpc parity only: the shared server's environment applies. `system`/`tools` are sent with every prompt (a
 * background agent's persona). `compactAt` > 0 compacts before a prompt once the last turn's context exceeded it.
 */
export class OpencodeRpc extends EventEmitter {
  constructor({ server, cwd, model = "", provider = "", thinking = "", env = {}, bus, meta = {}, system = "", tools = null, mirrorDir, compactAt = 0 }) {
    super();
    this.server = server;
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
    /** True from the server going down until the chat is reattached and onRestart ran (see PiRpc). */
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
    this.sessionID = null;
    this.mirror = null;
    this.catalog = null;
    this.onDown = () => this.serverDown();
    this.onUp = () => { this.serverUp().catch(() => {}); };
  }

  get ctx() {
    return { sid: this.sid, harness: "pi" };
  }

  get proc() {
    return this.live && this.alive ? SHARED_PROC : null;
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
    this.alive = !!this.server.proc && this.server.up !== false;
    // Every chat listens on the one server: lift the 10-listener warning.
    if (this.server.getMaxListeners?.() !== 0) this.server.setMaxListeners?.(0);
    this.server.off("down", this.onDown).off("up", this.onUp).on("down", this.onDown).on("up", this.onUp);
    this.ready = (async () => {
      if (!this.alive && typeof this.server.waitUp === "function") await this.server.waitUp();
      await this.createSession();
      return this.state;
    })();
    this.ready.catch(() => {});
    return this;
  }

  /** Ends the chat: stops listening, aborts a turn still running (a killed pi child would have ended it too). */
  stop() {
    const busy = this.streaming || this.inFlight > 0;
    const wasLive = this.live;
    this.stopped = true;
    this.live = false;
    this.stopWatchdog();
    this.unlisten?.();
    this.unlisten = null;
    this.server.off("down", this.onDown).off("up", this.onUp);
    if (busy && this.sessionID) this.server.request("POST", `/session/${this.sessionID}/abort`, { directory: this.cwd }).catch(() => {});
    this.streaming = false;
    this.openTools.clear();
    if (wasLive) this.emit("exit", null);
  }

  serverDown() {
    if (!this.live || !this.alive) return;
    this.alive = false;
    if (this.translator) this.translator.streaming = false;
    this.streaming = false;
    this.openTools.clear();
    this.resumeFile = this.state?.sessionFile || this.resumeFile;
    this.crashedSid = this.sid;
    this.restoring = true;
    this.log("system", "opencode server went away — the chat reattaches when it is back");
    this.bus.emit({ ...this.ctx, kind: "status", ts: Date.now(), streaming: false });
  }

  /** Back after a "down": mirror what was missed, re-read the run state, then let the supervisor replay. */
  async serverUp() {
    if (!this.live || this.alive) return;
    this.alive = true;
    if (!this.restoring) return;
    try {
      await this.reconcile();
      await this.syncStatus();
      await this.refreshState();
    } catch (e) { this.log("system", `opencode reattach failed: ${e.message}`); }
    try { if (this.onRestart) await this.onRestart(); }
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
   * Points the chat at session `id` and its mirror `file`, and listens to it; returns what it was on before. `past`:
   * the finished messages the session already had (pastOf).
   */
  attach(id, file, past = new Set()) {
    const prev = { id: this.sessionID, file: this.mirror, used: this.used };
    this.unlisten?.();
    const known = readMirror(file);
    this.sessionID = id;
    this.mirror = file;
    this.sid = `pi:${id}`;
    this.mirrored = new Set(known.map((e) => e.id));
    this.lastId = known.at(-1)?.id ?? null;
    this.used = known.length > 0;
    this.past = past;
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
    try { unlinkSync(prev.file); } catch { /* already gone */ }
    this.server.request("DELETE", `/session/${prev.id}`, { directory: this.cwd }).catch(() => {});
  }

  /**
   * The ids of the finished messages session `id` already has (null when unknown). Their payloads are ignored and a
   * reconcile never mirrors them: a fork re-emits its copies as new messages, an import's transcript is not history.
   */
  async pastOf(id) {
    try {
      const msgs = await this.server.request("GET", `/session/${id}/message`, { directory: this.cwd });
      return new Set((Array.isArray(msgs) ? msgs : []).filter((m) => m?.info?.role === "user" || m?.info?.time?.completed || m?.info?.error).map((m) => m.info.id));
    } catch { return null; }
  }

  async createSession() {
    const info = await this.server.request("POST", "/session", { directory: this.cwd, body: {} });
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

  /** Finished messages OpenCode has that the mirror missed while the event stream was gone, chained onto its end. */
  async reconcile() {
    if (!this.past) return;
    const msgs = await this.server.request("GET", `/session/${this.sessionID}/message`, { directory: this.cwd });
    const missed = historyEntries((Array.isArray(msgs) ? msgs : []).filter((m) => !this.past.has(m?.info?.id)), { cwd: this.cwd })
      .filter((e) => !this.mirrored.has(e.id));
    let parent = this.lastId;
    const added = this.appendEntries(missed.map((e) => { const out = { ...e, parentId: parent }; parent = e.id; return out; }));
    this.translator.chain.last = this.lastId;
    for (const e of added) for (const ev of normalizePiEntry(e, this.ctx)) this.bus.emit(ev);
  }

  /** Whether OpenCode is running this session right now (after attaching to it or reconnecting). */
  async syncStatus() {
    const all = await this.server.request("GET", "/session/status", { directory: this.cwd }).catch(() => null);
    const t = all?.[this.sessionID]?.type;
    const busy = t === "busy" || t === "retry";
    if (busy === this.streaming) return;
    this.translator.streaming = busy;
    this.onEvent({ type: busy ? "agent_start" : "agent_settled" });
  }

  // ---------------------------------------------------------------- events

  onPayload(payload) {
    this.lastEventAt = Date.now();
    const p = payload?.properties || {};
    if (payload?.type === "permission.asked" || payload?.type === "permission.updated") return this.allow(p);
    const mid = p.info?.id ?? p.part?.messageID ?? p.messageID;
    if (mid && this.past?.has(mid)) return;
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
    if (ev.type === "agent_start") this.streaming = true;
    if (ev.type === "agent_settled") { this.streaming = false; this.openTools.clear(); }
    if (ev.type === "tool_execution_start" && ev.toolCallId) this.openTools.add(ev.toolCallId);
    if (ev.type === "tool_execution_end" && ev.toolCallId) this.openTools.delete(ev.toolCallId);
    if (ev.type === "message_end" && ev.message?.role === "assistant") {
      const u = ev.message.usage;
      if (u && !ev.message.errorMessage) this.lastContext = num(u.input) + num(u.cacheRead);
      if (ev.message.provider && ev.message.model) this.lastModel = { providerID: ev.message.provider, modelID: ev.message.model };
    }
    for (const out of normalizePiRpcEvent(ev, this.ctx)) this.bus.emit(out);
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
  pick() {
    if (!this.model) return null;
    if (this.provider) return { providerID: this.provider, modelID: this.model };
    const i = this.model.indexOf("/");
    return i > 0 ? { providerID: this.model.slice(0, i), modelID: this.model.slice(i + 1) } : null;
  }

  /** The variant for the thinking level: "off" is the model's "none" variant when it has one, else nothing is sent. */
  variant() {
    const p = this.pick() || this.lastModel;
    const m = p && findModel(this.catalogValue, p.providerID, p.modelID);
    const levels = variantLevels(m?.variants);
    if (!this.thinking || !levels.includes(this.thinking)) return undefined;
    return this.thinking === "off" ? "none" : this.thinking;
  }

  async announce(info) {
    const p = this.pick() || this.lastModel;
    let model = null;
    if (p) {
      const m = findModel(await this.loadCatalog().catch(() => null), p.providerID, p.modelID);
      model = m ? modelOf(p.providerID, m) : { provider: p.providerID, id: p.modelID, name: p.modelID, contextWindow: 0, maxTokens: 0, reasoning: false, variants: [] };
    }
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
    const levels = variantLevels(model.variants ?? known?.variants);
    if (levels.length) return { success: true, data: { levels, labels: {} } };
    return { success: true, data: { levels: ["off"], labels: { off: (model.reasoning ?? known?.reasoning) ? "auto" : "off" } } };
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
    await this.ready;
    if (this.compacting) await this.compacting.catch(() => {});
    if (this.compactAt > 0 && !this.streaming && this.lastContext > this.compactAt) await this.compact().catch(() => {});
    await this.loadCatalog().catch(() => null);
    this.used = true;
    const r = await this.call("POST", `/session/${this.sessionID}/prompt_async`, this.promptBody(message, images));
    return r.success ? { success: true } : r;
  }

  abort() { return this.call("POST", `/session/${this.sessionID}/abort`); }

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

  /** Attaches to the OpenCode session of an opencode mirror file. */
  async switchSession(sessionPath) {
    let head = null;
    try { head = JSON.parse(readFileSync(sessionPath, "utf8").split("\n", 1)[0]); } catch { /* not a mirror */ }
    if (head?.type !== "session" || head.harness !== "opencode" || !head.id) throw new Error("not an opencode chat file");
    await this.ready?.catch(() => {});
    const info = await this.server.request("GET", `/session/${head.id}`, { directory: this.cwd });
    const past = await this.pastOf(head.id);
    this.dropUnused(this.attach(head.id, resolve(sessionPath), past));
    await this.syncStatus();
    await this.announce(info);
    return { success: true, data: { cancelled: false } };
  }

  /** Forks the session into a new one with a copy of the mirror and switches to it (the original stays untouched). */
  async clone() {
    await this.ready;
    const info = await this.server.request("POST", `/session/${this.sessionID}/fork`, { directory: this.cwd, body: {} });
    const file = this.newMirrorPath(info.id);
    const rest = readMirror(this.mirror).map((e) => `${JSON.stringify(e)}\n`).join("");
    writeFileSync(file, `${this.header(info.id)}\n${rest}`);
    const past = await this.pastOf(info.id);
    this.dropUnused(this.attach(info.id, file, past));
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
