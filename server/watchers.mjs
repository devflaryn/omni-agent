/**
 * Discovers pi and Claude Code session files, tails the recent ones, keeps a
 * registry of sessions (title, cwd, model, activity), can rebuild a session's
 * full history on demand, and writes vault digests when sessions go quiet.
 */
import { promises as fs, existsSync, watch } from "node:fs";
import { basename, join, resolve } from "node:path";
import { JsonlTail, readAppended } from "./tailer.mjs";
import { normalizePiEntry, normalizeClaudeEntry } from "./normalize.mjs";
import { createTally } from "./tokens.mjs";

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

function sidForFile(harness, file) {
  const id = basename(file, ".jsonl");
  if (harness === "claude") return `claude:${id}`;
  const m = /_([0-9a-f-]{20,})$/i.exec(id);
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
      if (t) s.title = t.replace(/\s+/g, " ").slice(0, 80);
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

  /** Full normalized history for a session (from its file). */
  async history(sid) {
    const s = this.registry.get(sid);
    if (!s?.file) return { events: [], tally: null };
    const harness = s.harness;
    const ctx = { sid, harness };
    let r;
    try { r = await readAppended(s.file, 0, ""); } catch (e) { if (e?.code === "ENOENT") return { events: [], tally: this.tally.has(sid) ? this.tally.get(sid) : null }; throw e; }
    const events = [];
    const tally = createTally();
    for (const o of r.objects) {
      for (const ev of normalizeEntry(harness, o, ctx)) {
        events.push(ev);
        if (ev.kind === "msg" && ev.usage) tally.add(sid, { groupId: ev.groupId || ev.id, usage: ev.usage, model: ev.model, cost: ev.cost, ts: ev.ts });
      }
    }
    // refresh the live tally with the authoritative file numbers
    this.tally.reset(sid);
    for (const ev of events) if (ev.kind === "msg" && ev.usage) this.tally.add(sid, { groupId: ev.groupId || ev.id, usage: ev.usage, model: ev.model, cost: ev.cost, ts: ev.ts });
    return { events, tally: tally.get(sid) };
  }

  /** Build the digest input for the vault from a session's history. */
  async digestData(sid) {
    const s = this.registry.get(sid);
    if (!s) return null;
    const { events, tally } = await this.history(sid);
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
