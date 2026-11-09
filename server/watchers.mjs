/**
 * Discovers pi and Claude Code session files, tails the recent ones, keeps a
 * registry of sessions (title, cwd, model, activity), can rebuild a session's
 * full history on demand, and writes vault digests when sessions go quiet.
 */
import { promises as fs, existsSync, watch } from "node:fs";
import { basename, join, resolve } from "node:path";
import { JsonlTail, readAppended, readTail, readWindow, readLineAt, scanBack } from "./tailer.mjs";
import { resultIn, wireEvent } from "./wire.mjs";
import { PLAN_TOOL } from "../ui/plan.js";
import { normalizePiEntry, normalizeClaudeEntry } from "./normalize.mjs";
import { createTally } from "./tokens.mjs";
import { cleanTitle } from "../ui/lib.js";
export const titleFrom = cleanTitle;

const normPath = (p) => resolve(String(p)).toLowerCase();

export class SessionRegistry {
  constructor() {
    this.sessions = new Map();
  }
  get(sid) { return this.sessions.get(sid); }
  upsert(sid, patch) {
    const s = this.sessions.get(sid) || { sid, harness: sid.split(":")[0], file: null, cwd: null, title: null, model: null, mtime: 0, size: 0, owned: false, streaming: false, lastActivity: 0, messages: 0, startedAt: 0 };
    for (const [k, v] of Object.entries(patch)) if (v !== undefined && v !== null && v !== "") s[k] = v;
    this.sessions.set(sid, s);
    return s;
  }
  list() {
    return [...this.sessions.values()].sort((a, b) => (b.lastActivity || b.mtime) - (a.lastActivity || a.mtime));
  }
  bySidOrFile(x) {
    if (this.sessions.has(x)) return this.sessions.get(x);
    const n = normPath(x);
    for (const s of this.sessions.values()) if (s.file && normPath(s.file) === n) return s;
    return null;
  }
  remove(sid) { const s = this.sessions.get(sid); this.sessions.delete(sid); return s || null; }
}

export function sidForFile(harness, file) {
  const id = basename(file, ".jsonl");
  if (harness === "claude") return `claude:${id}`;
  const m = /_(ses_[A-Za-z0-9]+|[0-9a-f-]{20,})$/i.exec(id);
  return `pi:${m ? m[1] : id}`;
}

export function normalizeEntry(harness, entry, ctx) {
  return harness === "pi" ? normalizePiEntry(entry, ctx) : normalizeClaudeEntry(entry, ctx);
}

function applyToRegistry(registry, ev) {
  const s = registry.upsert(ev.sid, {});
  if (ev.kind === "session") {
    registry.upsert(ev.sid, { cwd: ev.cwd, title: ev.title, model: ev.model, file: ev.file, owned: ev.owned });
    if (ev.ts && !s.startedAt) s.startedAt = ev.ts;
  } else if (ev.kind === "msg") {
    s.messages++;
    s.lastActivity = Math.max(s.lastActivity, ev.ts || 0);
    if (!s.startedAt) s.startedAt = ev.ts;
    if (ev.cwd) s.cwd = ev.cwd;
    if (ev.model) s.model = ev.model;
    if (ev.role === "user" && !s.title) {
      const t = ev.blocks?.find((b) => b.type === "text")?.text || "";
      if (t) s.title = titleFrom(t) || t.replace(/\s+/g, " ").slice(0, 80);
    }
    if (ev.role === "assistant") {
      // pi: stopReason "toolUse" => still working; claude: a tool_call block => still working
      const hasToolCall = ev.blocks?.some((b) => b.type === "tool_call");
      s.streaming = hasToolCall || ev.stopReason === "toolUse";
    } else if (ev.role === "user") s.streaming = true;
  } else if (ev.kind === "status") {
    s.streaming = !!ev.streaming;
    s.lastActivity = Math.max(s.lastActivity, ev.ts || 0);
  } else if (ev.kind === "delta" || ev.kind === "tool" || ev.kind === "block") {
    s.lastActivity = Math.max(s.lastActivity, ev.ts || 0);
  }
  return s;
}

/**
 * How many of a window's lines to leave out, oldest first, so what is left comes to about `pageBytes` as a page receives it. The cut
 * moves forward to a person's message when there is one within the page, as a turn reads from its start; when not, it stays where the
 * bytes put it, since one very long turn must still page. A single line over the limit comes whole. 0 if it all fits.
 */
function pageCut(lines, pageBytes) {
  let bytes = 0, cut = lines.length;
  while (cut > 0) {
    const line = lines[cut - 1].evs.reduce((sum, ev) => sum + JSON.stringify(wireEvent(ev)).length, 0);
    if (bytes + line > pageBytes && cut < lines.length) break;
    bytes += line;
    cut--;
  }
  if (cut === 0) return 0;
  const asked = (i) => lines[i].evs.some((ev) => ev.kind === "msg" && ev.role === "user");
  for (let i = cut; i < lines.length; i++) if (asked(i)) return i;
  // No message of the person's in the page: its turn's start, if that is within another page back.
  let back = 0;
  for (let i = cut - 1; i >= 0 && back <= pageBytes; i--) {
    if (asked(i)) return i;
    back += lines[i].evs.reduce((sum, ev) => sum + JSON.stringify(wireEvent(ev)).length, 0);
  }
  return cut;
}

export class SessionWatcher {
  constructor({ piSessionsDir, claudeProjectsDir, bus, tally, registry, isOwned = () => false, recentHours = 72, log = () => {} }) {
    this.dirs = { pi: piSessionsDir, claude: claudeProjectsDir };
    this.bus = bus;
    this.tally = tally || createTally();
    this.registry = registry || new SessionRegistry();
    this.isOwned = isOwned;
    this.recentMs = recentHours * 3600 * 1000;
    this.tails = new Map(); // file -> JsonlTail
    this.watchers = [];
    this.log = log;
    this.dirty = new Map(); // sid -> last activity ts (needs digest)
  }

  async listFiles(harness) {
    const dir = this.dirs[harness];
    const out = [];
    if (!dir || !existsSync(dir)) return out;
    if (harness === "pi") {
      const stack = [dir];
      while (stack.length) {
        const d = stack.pop();
        let entries = [];
        try { entries = await fs.readdir(d, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
          const p = join(d, e.name);
          if (e.isDirectory()) stack.push(p);
          else if (e.name.endsWith(".jsonl")) out.push(p);
        }
      }
    } else {
      let projects = [];
      try { projects = await fs.readdir(dir, { withFileTypes: true }); } catch { return out; }
      for (const p of projects) {
        if (!p.isDirectory()) continue;
        let entries = [];
        try { entries = await fs.readdir(join(dir, p.name), { withFileTypes: true }); } catch { continue; }
        for (const e of entries) if (e.isFile() && e.name.endsWith(".jsonl")) out.push(join(dir, p.name, e.name));
      }
    }
    return out;
  }

  /** Cheap metadata: first ~64KB (cwd, first prompt) and last ~64KB (title). */
  async peek(harness, file) {
    const sid = sidForFile(harness, file);
    const st = await fs.stat(file);
    const s = this.registry.upsert(sid, { file, mtime: st.mtimeMs, size: st.size, owned: this.isOwned(file) });
    if (s.peeked) return s;
    s.peeked = true;
    const ctx = { sid, harness };
    try {
      const fh = await fs.open(file, "r");
      try {
        const headLen = Math.min(st.size, 65536);
        const head = Buffer.alloc(headLen);
        await fh.read(head, 0, headLen, 0);
        for (const line of head.toString("utf8").split("\n").slice(0, -1)) {
          let o; try { o = JSON.parse(line); } catch { continue; }
          for (const ev of normalizeEntry(harness, o, ctx)) applyToRegistry(this.registry, ev);
        }
        if (st.size > headLen) {
          const tailLen = Math.min(st.size - headLen, 65536);
          const tail = Buffer.alloc(tailLen);
          await fh.read(tail, 0, tailLen, st.size - tailLen);
          for (const line of tail.toString("utf8").split("\n").slice(1)) {
            let o; try { o = JSON.parse(line); } catch { continue; }
            if (o.type === "ai-title" && o.aiTitle) s.title = o.aiTitle;
            if (o.type === "session_info" && o.name) s.title = o.name;
            if (o.type === "model_change" && o.modelId) s.model = o.modelId;
            if (o.timestamp) s.lastActivity = Math.max(s.lastActivity, Date.parse(o.timestamp) || 0);
          }
        }
      } finally { await fh.close(); }
    } catch (e) { this.log(`peek failed ${file}: ${e.message}`); }
    s.lastActivity = Math.max(s.lastActivity || 0, st.mtimeMs);
    s.streaming = false;
    return s;
  }

  async start() {
    for (const harness of ["pi", "claude"]) {
      const files = await this.listFiles(harness);
      for (const f of files) {
        const s = await this.peek(harness, f);
        if (Date.now() - s.mtime < this.recentMs) this.ensureTail(harness, f);
      }
      const dir = this.dirs[harness];
      if (dir && existsSync(dir)) {
        try {
          const w = watch(dir, { recursive: true }, (_t, filename) => {
            if (!filename || !String(filename).endsWith(".jsonl")) return;
            const full = join(dir, String(filename));
            if (harness === "claude" && String(filename).split(/[\\/]/).length !== 2) return; // skip nested subagent files
            this.onFileEvent(harness, full);
          });
          w.on("error", (e) => this.log(`watch error ${dir}: ${e.message}`));
          this.watchers.push(w);
        } catch (e) { this.log(`watch failed ${dir}: ${e.message}`); }
      }
    }
    this.rescanTimer = setInterval(() => this.rescan().catch(() => {}), 30000);
    return this;
  }

  async rescan() {
    for (const harness of ["pi", "claude"]) {
      for (const f of await this.listFiles(harness)) {
        if (this.tails.has(normPath(f))) continue;
        try {
          const st = await fs.stat(f);
          if (Date.now() - st.mtimeMs < 600000) { await this.peek(harness, f); this.ensureTail(harness, f); }
        } catch { /* gone */ }
      }
    }
  }

  async onFileEvent(harness, file) {
    if (!existsSync(file)) return;
    if (!this.tails.has(normPath(file))) {
      await this.peek(harness, file).catch(() => {});
      this.ensureTail(harness, file, { fromEnd: false, offsetFromPeek: true });
    }
  }

  ensureTail(harness, file, { fromEnd = true } = {}) {
    const key = normPath(file);
    if (this.tails.has(key)) return this.tails.get(key);
    const sid = sidForFile(harness, file);
    const ctx = { sid, harness };
    const tail = new JsonlTail(file, {
      fromEnd,
      intervalMs: 700,
      onObject: (o) => this.onEntry(harness, file, ctx, o),
      onError: (e) => this.log(`tail ${file}: ${e.message}`),
    });
    this.tails.set(key, tail);
    tail.start().catch((e) => this.log(`tail start ${file}: ${e.message}`));
    return tail;
  }

  onEntry(harness, file, ctx, entry) {
    const owned = this.isOwned(file);
    const s = this.registry.upsert(ctx.sid, { file, owned });
    for (const ev of normalizeEntry(harness, entry, ctx)) {
      applyToRegistry(this.registry, ev);
      if (ev.kind === "msg" && ev.usage) this.tally.add(ev.sid, { groupId: ev.groupId || ev.id, usage: ev.usage, model: ev.model, cost: ev.cost, ts: ev.ts });
      this.dirty.set(ev.sid, Date.now());
      if (owned) continue; // the RPC child / runner already streamed this
      this.bus.emit(ev);
    }
    s.mtime = Date.now();
  }

  /**
   * One page of a session's normalized history, read from its file: the newest ~`maxBytes` (or those ending
   * at byte `before`, the `start` an earlier page returned). A page that does not reach the file's start begins
   * at a user message, so a turn is never split across pages; `more` says an older page exists. Each tool
   * result carries `at`, its line's offset, so its full output can be read back later (toolOutput).
   */
  /**
   * A page of chat `sid`. `pageBytes` asks for only the newest that many bytes as a page receives them (a far machine's first paint
   * should not wait on 2 MB), from the same window: the tally still counts the whole window, and a plan older than the page comes
   * along as `plan`. It ends at a person's message when one is near enough, and `start` is where the next page picks up.
   */
  async history(sid, { before, maxBytes = 2 * 1024 * 1024, pageBytes } = {}) {
    const s = this.registry.get(sid);
    if (!s?.file) return { events: [], tally: null, start: 0, more: false };
    const harness = s.harness;
    const ctx = { sid, harness };
    let r;
    try { r = await readWindow(s.file, { before, maxBytes }); } catch (e) { if (e?.code === "ENOENT") return { events: [], tally: this.tally.has(sid) ? this.tally.get(sid) : null, start: 0, more: false }; throw e; }
    const lines = r.lines.map(({ at, obj }) => ({ at, evs: normalizeEntry(harness, obj, ctx) }));
    let from = 0;
    if (r.start > 0) { const i = lines.findIndex((l) => l.evs.some((ev) => ev.kind === "msg" && ev.role === "user")); if (i > 0) from = i; }
    let start = from < lines.length ? lines[from].at : r.start;
    const events = [];
    for (const l of lines.slice(from)) {
      for (const ev of l.evs) {
        if (ev.kind === "msg" && Array.isArray(ev.blocks)) for (const b of ev.blocks) if (b.type === "tool_result") b.at = l.at;
        events.push(ev);
      }
    }
    // The newest page resets the chat's running tally (as a full read did); an older page leaves it alone.
    let pageTally = null;
    if (before == null) {
      const tally = createTally();
      this.tally.reset(sid);
      for (const ev of events) if (ev.kind === "msg" && ev.usage) { const u = { groupId: ev.groupId || ev.id, usage: ev.usage, model: ev.model, cost: ev.cost, ts: ev.ts }; tally.add(sid, u); this.tally.add(sid, u); }
      pageTally = tally.get(sid);
    }
    const cut = pageBytes > 0 ? pageCut(lines.slice(from), pageBytes) : 0;
    if (!cut) return { events, tally: pageTally, start, more: start > 0, truncated: start > 0 };
    const kept = lines.slice(from + cut);
    start = kept[0].at;
    const dropped = lines.slice(from, from + cut).flatMap((l) => l.evs);
    const shown = kept.flatMap((l) => l.evs);
    const planIn = (evs) => { for (let i = evs.length - 1; i >= 0; i--) { const ev = evs[i]; if (ev.kind === "msg" && ev.role === "tool") for (const b of ev.blocks || []) if (b.name === PLAN_TOOL && b.details?.plan) return b.details; } return null; };
    const plan = planIn(shown) ? null : planIn(dropped);
    return { events: shown, tally: pageTally, start, more: true, truncated: true, ...(plan ? { plan } : {}) };
  }

  /** The full result of tool call `toolId`: from the line at byte `at` when given, else the newest line naming it. */
  async toolOutput(sid, toolId, { at } = {}) {
    const s = this.registry.get(sid);
    if (!s?.file || !toolId) return undefined;
    const ctx = { sid, harness: s.harness };
    const find = (obj) => { for (const ev of normalizeEntry(s.harness, obj, ctx)) { const r = resultIn(ev, toolId); if (r) return r; } return undefined; };
    try {
      if (at != null && at !== "") { const obj = await readLineAt(s.file, Number(at)); const r = obj === undefined ? undefined : find(obj); if (r) return r; }
      return await scanBack(s.file, JSON.stringify(String(toolId)), find);
    } catch (e) { if (e?.code === "ENOENT") return undefined; throw e; }
  }

  /** Build the digest input for the vault from a session's history. */
  async digestData(sid) {
    const s = this.registry.get(sid);
    if (!s) return null;
    const { events, tally } = await this.history(sid, { maxBytes: 8 * 1024 * 1024 });
    const prompts = [];
    const tools = {};
    let lastAssistant = "";
    let model = s.model;
    let startedAt = s.startedAt || 0;
    let endedAt = 0;
    for (const ev of events) {
      if (ev.kind !== "msg") continue;
      if (!startedAt) startedAt = ev.ts;
      endedAt = Math.max(endedAt, ev.ts);
      if (ev.model) model = ev.model;
      if (ev.role === "user") { const t = ev.blocks.find((b) => b.type === "text")?.text; if (t) prompts.push(t); }
      if (ev.role === "assistant") {
        const t = ev.blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
        if (t) lastAssistant = t;
        for (const b of ev.blocks) if (b.type === "tool_call") tools[b.name] = (tools[b.name] || 0) + 1;
      }
    }
    return { harness: s.harness, sid, cwd: s.cwd, title: s.title, model, startedAt, endedAt: endedAt || Date.now(), usage: tally, cost: tally?.cost || 0, prompts, lastAssistant, tools };
  }

  /** Remove a session: stop tailing it, move its .jsonl to the trash dir (recoverable),
   *  and drop it from the registry + tally. Refuses (400) a session with no file. */
  async deleteSession(sid, { trashDir }) {
    const s = this.registry.get(sid);
    if (!s) throw Object.assign(new Error("unknown session"), { status: 404 });
    if (!s.file) throw Object.assign(new Error("session has no file to delete"), { status: 400 });
    const file = s.file;
    const key = normPath(file);
    const tail = this.tails.get(key);
    if (tail) { try { tail.stop(); } catch { /* ignore */ } this.tails.delete(key); }
    this.dirty.delete(sid);
    let trashed = null;
    if (existsSync(file)) {
      const dir = join(trashDir, s.harness);
      await fs.mkdir(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      trashed = join(dir, `${basename(file, ".jsonl")}-${stamp}.jsonl`);
      try { await fs.rename(file, trashed); }
      catch (e) { if (e?.code === "EXDEV") { await fs.copyFile(file, trashed); await fs.unlink(file); } else throw e; }
    }
    this.registry.remove(sid);
    this.tally.reset(sid);
    return { sid, harness: s.harness, file, trashed };
  }

  stop() {
    for (const [, t] of this.tails) t.stop();
    for (const w of this.watchers) { try { w.close(); } catch { /* ignore */ } }
    if (this.rescanTimer) clearInterval(this.rescanTimer);
  }
}
