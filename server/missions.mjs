/**
 * Missions: one boss chat that only orchestrates, temporary worker agents that do the work, and a durable ledger.
 *
 *   boss     an OpencodeRpc-like chat (createBoss) whose tool allowlist is only the boss tools (boss-prompt.mjs). It
 *            never sees tool output: it is prompted with compact `[mission <id>] …` deliveries from a persisted queue,
 *            one at a time, when it is idle. A failed turn is retried with backoff; after `fallbackAfter` failures it
 *            switches to the mission's fallback model; a dead chat is reopened on its session; past `rebirthAt` of its
 *            context window a fresh boss generation starts from a briefing rendered from the ledger.
 *   workers  AgentManager agents tagged with missionId/role "worker" (parentSid "mission:<id>"). Their reports are
 *            stored in full and delivered to the boss capped; subagents they start inherit the missionId.
 *   state    mission.json (atomic) + events.jsonl + ledger.md per mission (projects.mjs). Nothing lives only in memory.
 */
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { MissionFiles } from "./projects.mjs";
import { BOSS_SYSTEM, BOSS_TOOLS, bossBriefing } from "./boss-prompt.mjs";
import { SUMMARY_REQUEST, WORKER_FOOTER, reportSection, workerBrief } from "./worker-contract.mjs";

export const TASK_STATUSES = ["todo", "active", "done", "blocked", "dropped"];
export const NOTE_KINDS = ["decision", "dead_end", "fact", "risk", "lesson"];
export const URGENCIES = ["info", "action", "urgent"];
const FINISHED = new Set(["done", "error", "cancelled", "timeout", "interrupted", "stalled"]);
const ACTIVE = new Set(["queued", "starting", "running"]);
const TIMER_MAX = 2147483647;

const httpError = (status, message) => Object.assign(new Error(message), { status });
const bad = (m) => httpError(400, m);
const oneLine = (s, n) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
export const clip = (s, n) => { const t = String(s ?? ""); return t.length > n ? `${t.slice(0, Math.max(0, n - 40))}\n… (${t.length - n + 40} more characters cut)` : t; };
const fmtDur = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); if (s < 90) return `${s}s`; const m = Math.round(s / 60); if (m < 90) return `${m}m`; const h = Math.floor(m / 60); return h < 48 ? `${h}h${String(m % 60).padStart(2, "0")}` : `${Math.round(h / 24)}d`; };
const kindName = (k) => (k === "claude" ? "claude" : k === "shell" ? "shell" : "opencode");
/** "provider/id" or a {provider,id} → {provider, id}. */
export function asModel(v) {
  if (!v) return null;
  if (typeof v === "object") return v.id ? { provider: String(v.provider || ""), id: String(v.id) } : null;
  const s = String(v).trim(); if (!s) return null;
  const i = s.indexOf("/");
  return i > 0 ? { provider: s.slice(0, i), id: s.slice(i + 1) } : { provider: "", id: s };
}
const modelLabel = (m) => (m ? (m.provider ? `${m.provider}/${m.id}` : m.id) : "");

/** The mission as the boss sees it: tasks, workers, open questions, recent notes. Pure. */
export function renderState(m, { workers = [], now = Date.now(), max = 4000 } = {}) {
  const out = [`Mission ${m.id} — ${m.status}${m.usingFallback ? " (boss on fallback model)" : ""}`, `Goal: ${oneLine(m.goal, 300)}`, "", "Tasks:"];
  const tasks = m.tasks || [];
  if (!tasks.length) out.push("  (none yet — add them with task_add)");
  for (const t of tasks) {
    const depth = t.id.split(".").length - 1;
    out.push(`${"  ".repeat(depth + 1)}[${t.status}] ${t.id} ${oneLine(t.title, 100)}${t.summary ? ` — ${oneLine(t.summary, 160)}` : ""}${t.workers?.length ? ` (workers: ${t.workers.join(", ")})` : ""}`);
  }
  const active = workers.filter((w) => ACTIVE.has(w.status));
  const recent = workers.filter((w) => FINISHED.has(w.status)).slice(0, 5);
  out.push("", `Workers: ${active.length} active`);
  for (const w of active) out.push(`  ${w.id} ${kindName(w.kind)} ${w.status} ${fmtDur(now - (w.startedAt || w.createdAt || now))}${w.taskId ? ` task ${w.taskId}` : ""} "${oneLine(w.title, 60)}" · ${oneLine(w.activity?.at(-1) || "", 120)}`);
  if (recent.length) { out.push("  recently finished:"); for (const w of recent) out.push(`  ${w.id} ${kindName(w.kind)} ${w.status}${w.taskId ? ` task ${w.taskId}` : ""} "${oneLine(w.title, 60)}"`); }
  const qs = (m.questions || []).filter((q) => q.answer == null);
  if (qs.length) { out.push("", "Unanswered worker questions:"); for (const q of qs) out.push(`  ${q.id} from ${q.worker}: ${oneLine(q.question, 200)}`); }
  const pend = (m.notifications || []).filter((n) => n.question && n.answer == null);
  if (pend.length) { out.push("", "Waiting for the user:"); for (const n of pend) out.push(`  ${n.id}: ${oneLine(n.question, 160)}`); }
  const notes = (m.notes || []).slice(-8);
  if (notes.length) { out.push("", "Recent notes:"); for (const n of notes) out.push(`  [${n.kind}] ${oneLine(n.title, 100)}${n.body ? ` — ${oneLine(n.body, 160)}` : ""}`); }
  return clip(out.join("\n"), max);
}

/** A worker's report as delivered to the boss: a header, the report (capped), a pointer to the full one. Pure. */
export function compactReport(rec, path, { max = 8000, now = Date.now() } = {}) {
  const el = rec.startedAt ? fmtDur((rec.endedAt || now) - rec.startedAt) : "";
  const head = `Report from worker ${rec.id} (${kindName(rec.kind)}${rec.agent ? ` ${rec.agent}` : ""})${rec.taskId ? ` for task ${rec.taskId}` : ""} "${oneLine(rec.title, 80)}": ${rec.status}${el ? ` after ${el}` : ""}${rec.turns ? `, ${rec.turns} turns` : ""}${rec.cost ? `, $${Number(rec.cost).toFixed(2)}` : ""}${rec.error ? `\nError: ${oneLine(rec.error, 400)}` : ""}`;
  let body = String(rec.resultText || "").trim();
  if (!body) body = `## Status\nstuck\n\nThe worker ended (${rec.status}) without a report.${rec.error ? ` Error: ${oneLine(rec.error, 400)}` : ""}`;
  if (rec.status === "interrupted") body += "\n\n(It was interrupted, e.g. by an Omni restart. worker_message resumes it on its own session.)";
  const foot = path ? `\n\n(full report: ${path})` : "";
  return `${head}\n\n${clip(body, Math.max(500, max - head.length - foot.length - 4))}${foot}`;
}

export class MissionManager extends EventEmitter {
  constructor({ bus, store, agents, createBoss = null, config = {}, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, log = () => {} } = {}) {
    super();
    this.bus = bus; this.store = store; this.agents = agents; this.createBoss = createBoss;
    this.config = {
      retryBaseMs: 15000, retryMaxMs: 600000, fallbackAfter: 3, primaryRetryMs: 3600000, heartbeatMs: 1800000, rebirthAt: 0.6,
      reportMax: 8000, toolMax: 4000, deliverMax: 12000, questionTimeoutMs: 1800000, turnTimeoutMs: 45 * 60000, summaryTimeoutMs: 600000, urgentAfter: 10,
      ...config,
    };
    this.now = now; this.setTimer = setTimer; this.clearTimer = clearTimer; this.log = log;
    this.missions = new Map(); // id -> record (plain JSON)
    this.files = new Map();    // id -> MissionFiles
    this.paths = new Map();    // id -> project paths
    this.rt = new Map();       // id -> runtime (boss chat, turn, timers, waiters)
    this.bossSids = new Map(); // boss sid -> mission id
    this.onBus = this.onBus.bind(this);
    this.onAgent = this.onAgent.bind(this);
    bus?.on?.("event", this.onBus);
    agents?.on?.("change", this.onAgent);
  }

  // ------------------------------------------------------------------ records
  runtime(id) {
    let rt = this.rt.get(id);
    if (!rt) { rt = { boss: null, ready: false, starting: null, inFlight: null, sawStreaming: false, turnError: null, timers: {}, reported: new Set(), questions: new Map(), summaryWaiters: new Set(), restarting: false }; this.rt.set(id, rt); }
    return rt;
  }
  later(ms, fn) { const t = this.setTimer(fn, Math.max(0, Math.min(TIMER_MAX, ms))); t?.unref?.(); return t; }
  clearTimerOf(rt, name) { if (rt.timers[name]) { this.clearTimer(rt.timers[name]); rt.timers[name] = null; } }

  pub(m) { return { ...m, queue: (m.queue || []).map((q) => ({ id: q.id, type: q.type, at: q.at, preview: oneLine(q.text, 140) })) }; }
  get(id) { return this.missions.get(String(id)) || null; }
  must(id) { const m = this.get(id); if (!m) throw httpError(404, `no mission ${id}`); return m; }
  list() { return [...this.missions.values()].sort((a, b) => b.createdAt - a.createdAt); }
  workersOf(m) { return this.agents?.list ? this.agents.list().filter((a) => a.missionId === m.id) : []; }
  /** The mission a chat belongs to: its boss chat, or a worker / subagent chat. */
  bySession(sid) {
    if (!sid) return null;
    const s = String(sid), full = s.includes(":") ? s : `pi:${s}`;
    const byBoss = this.bossSids.get(full);
    if (byBoss) return this.get(byBoss);
    for (const m of this.missions.values()) if (m.boss?.sid === full || m.boss?.sessionId === s) return m;
    const a = this.agents?.agentBySid?.(full);
    return a?.missionId ? this.get(a.missionId) : null;
  }
  isBoss(m, sid) { const full = String(sid).includes(":") ? String(sid) : `pi:${sid}`; return !!m && (m.boss?.sid === full || this.bossSids.get(full) === m.id); }
  projectOf(m) { let p = this.paths.get(m.id); if (!p) { p = this.store.project(m.dir); this.paths.set(m.id, p); } return p; }

  save(m, ev = null) {
    m.updatedAt = this.now();
    const f = this.files.get(m.id);
    try { f?.write(m); if (ev) f?.append(ev); } catch (e) { this.log("missions: could not save", m.id, e.message); }
    this.bus?.emit?.({ sid: `mission:${m.id}`, harness: "omni", kind: "mission", ts: m.updatedAt, mission: this.pub(m) });
    this.emit("change", m);
  }
  ledger(m, line) { try { this.files.get(m.id)?.ledger(line); } catch { /* best effort */ } }

  // ------------------------------------------------------------------ create
  create(spec = {}) {
    const goal = String(spec.goal ?? "").trim();
    const dir = String(spec.dir ?? "").trim();
    const bossModel = asModel(spec.bossModel);
    if (!goal) throw bad("a mission needs a goal");
    if (!dir) throw bad("a mission needs a project directory");
    if (!existsSync(dir)) throw bad(`project directory not found: ${dir}`);
    if (!bossModel) throw bad("a mission needs a boss model");
    const p = this.store.project(dir);
    let id; do { id = `m-${randomBytes(4).toString("hex")}`; } while (this.missions.has(id));
    const now = this.now();
    const m = {
      id, title: oneLine(spec.title || goal.split(/\r?\n/).find((l) => l.trim()) || "Mission", 80), goal, dir: p.dir, slug: p.slug,
      status: "starting", createdAt: now, updatedAt: now,
      bossModel, fallbackModel: asModel(spec.fallbackModel), usingFallback: false, fallbackAt: 0,
      workerKind: spec.workerKind === "claude" ? "claude" : "pi", workerModel: String(spec.workerModel || ""),
      boss: { sid: null, sessionId: null, sessionFile: null, generation: 0, contextUsed: 0, contextWindow: 0, previous: [] },
      tasks: [], notes: [], workers: [], notifications: [], questions: [], queue: [],
      errors: { consecutive: 0, lastError: "", nextRetryAt: 0, notifiedUrgent: false },
      lastDeliveryAt: 0, seq: 0,
    };
    this.missions.set(id, m);
    this.files.set(id, new MissionFiles({ dir: join(p.missionsDir, id) }));
    this.paths.set(id, p);
    this.ledger(m, `mission created: ${oneLine(goal, 300)} (boss ${modelLabel(bossModel)}${m.fallbackModel ? `, fallback ${modelLabel(m.fallbackModel)}` : ""})`);
    this.save(m, { kind: "created", goal, bossModel, fallbackModel: m.fallbackModel });
    if (this.createBoss) this.startBoss(m).catch((e) => this.log("missions: boss start failed", id, e?.message || e));
    this.armHeartbeat(m);
    return m;
  }
  nextId(m, prefix) { m.seq = (m.seq || 0) + 1; return `${prefix}${m.seq}`; }

  // ------------------------------------------------------------------ tasks, notes, notifications
  addTask(m, { title, parent, detail } = {}) {
    const t = oneLine(title, 200);
    if (!t) throw bad("a task needs a title");
    let id;
    if (parent) {
      const p = m.tasks.find((x) => x.id === String(parent));
      if (!p) throw bad(`no task ${parent}`);
      id = `${p.id}.${m.tasks.filter((x) => x.id.startsWith(`${p.id}.`) && x.id.split(".").length === p.id.split(".").length + 1).length + 1}`;
    } else id = `t${m.tasks.filter((x) => !x.id.includes(".")).length + 1}`;
    const task = { id, title: t, detail: clip(detail || "", 2000), status: "todo", summary: "", workers: [], createdAt: this.now(), updatedAt: this.now() };
    // Children go right after their parent's subtree, so the list reads as a tree.
    if (parent) { let i = m.tasks.findIndex((x) => x.id === String(parent)); while (i + 1 < m.tasks.length && m.tasks[i + 1].id.startsWith(`${parent}.`)) i++; m.tasks.splice(i + 1, 0, task); } else m.tasks.push(task);
    this.ledger(m, `task ${id} added: ${t}`);
    this.save(m, { kind: "task", op: "add", task });
    return task;
  }
  updateTask(m, id, patch = {}) {
    const t = m.tasks.find((x) => x.id === String(id));
    if (!t) throw bad(`no task ${id}`);
    if (patch.status !== undefined && !TASK_STATUSES.includes(patch.status)) throw bad(`task status must be one of ${TASK_STATUSES.join(", ")}`);
    if (patch.status) t.status = patch.status;
    if (patch.summary !== undefined) t.summary = oneLine(patch.summary, 400);
    if (patch.title) t.title = oneLine(patch.title, 200);
    t.updatedAt = this.now();
    this.ledger(m, `task ${t.id} → ${t.status}${patch.summary ? `: ${oneLine(patch.summary, 200)}` : ""}`);
    this.save(m, { kind: "task", op: "update", id: t.id, patch });
    return t;
  }
  addNote(m, { kind, title, body } = {}) {
    if (!NOTE_KINDS.includes(kind)) throw bad(`note kind must be one of ${NOTE_KINDS.join(", ")}`);
    if (!String(title || "").trim()) throw bad("a note needs a title");
    const n = { id: this.nextId(m, "n"), kind, title: oneLine(title, 200), body: clip(body || "", 2000), at: this.now() };
    m.notes.push(n);
    if (m.notes.length > 2000) m.notes.splice(0, m.notes.length - 2000);
    this.ledger(m, `[${kind}] ${n.title}${n.body ? ` — ${oneLine(n.body, 300)}` : ""}`);
    this.save(m, { kind: "note", note: n });
    return n;
  }
  notify(m, { title, body = "", urgency = "info", question = "" } = {}) {
    if (!String(title || "").trim()) throw bad("a notification needs a title");
    const u = URGENCIES.includes(urgency) ? urgency : "info";
    const n = { id: this.nextId(m, "ping"), title: oneLine(title, 160), body: clip(body, 4000), urgency: u, question: oneLine(question, 600), at: this.now(), read: false, answer: null, answeredAt: null };
    m.notifications.push(n);
    if (m.notifications.length > 500) m.notifications.splice(0, m.notifications.length - 500);
    this.ledger(m, `notify (${u}): ${n.title}${n.question ? ` — asks: ${n.question}` : ""}`);
    this.save(m, { kind: "notify", notification: n });
    this.bus?.emit?.({ sid: `mission:${m.id}`, harness: "omni", kind: "notify", ts: n.at, mission: m.id, missionTitle: m.title, notification: n });
    return n;
  }
  markNotification(m, nid, { read, answer } = {}) {
    const n = m.notifications.find((x) => x.id === String(nid));
    if (!n) throw httpError(404, `no notification ${nid}`);
    if (read !== undefined) n.read = !!read;
    if (answer !== undefined && String(answer).trim()) {
      n.answer = clip(String(answer).trim(), 4000); n.answeredAt = this.now(); n.read = true;
      this.ledger(m, `user answered ${n.id} (${n.title}): ${oneLine(n.answer, 300)}`);
      this.enqueue(m, { type: "user", front: true, text: `The user answered your notification ${n.id} "${n.title}"${n.question ? ` (you asked: ${n.question})` : ""}:\n${n.answer}` });
    }
    this.save(m, { kind: "notification", id: n.id, read: n.read, answered: n.answer != null });
    return n;
  }

  // ------------------------------------------------------------------ the boss
  bindBoss(m, rt) {
    const sid = rt.boss?.sid;
    if (!sid || sid === "pi:pending") return;
    if (m.boss.sid && m.boss.sid !== sid) this.bossSids.delete(m.boss.sid);
    m.boss.sid = sid;
    m.boss.sessionId = rt.boss.state?.sessionId || m.boss.sessionId;
    m.boss.sessionFile = rt.boss.state?.sessionFile || m.boss.sessionFile;
    this.bossSids.set(sid, m.id);
  }

  /** Start (or reopen, on its saved session) the boss chat; a fresh mission gets its briefing first. */
  async startBoss(m, { fresh = false } = {}) {
    const rt = this.runtime(m.id);
    if (rt.starting) return rt.starting;
    if (!this.createBoss) throw new Error("missions: no boss factory");
    rt.starting = (async () => {
      const model = m.usingFallback && m.fallbackModel ? m.fallbackModel : m.bossModel;
      const boss = this.createBoss({ cwd: m.dir, model: model.id, provider: model.provider, system: BOSS_SYSTEM, tools: [...BOSS_TOOLS], meta: { missionId: m.id, missionRole: "boss", title: `Boss · ${m.title}` } });
      rt.boss = boss; rt.ready = false; rt.inFlight = null;
      boss.on?.("exit", (code) => this.onBossExit(m, boss, code));
      boss.start?.();
      await boss.waitReady?.();
      const reopen = !fresh && m.boss.sessionFile;
      if (reopen) { try { await boss.switchSession(m.boss.sessionFile); } catch (e) { this.log("missions: could not reopen the boss session", m.id, e?.message || e); } }
      this.bindBoss(m, rt);
      rt.ready = true;
      if (!reopen) {
        m.boss.generation = (m.boss.generation || 0) + 1;
        this.enqueue(m, { type: "briefing", front: true, text: bossBriefing(m, renderState(m, { workers: this.workersOf(m), now: this.now(), max: 6000 }), { rebirth: m.boss.generation > 1 }) }, { pump: false });
      }
      if (m.status === "starting") m.status = "running";
      this.save(m, { kind: "boss", op: reopen ? "reopened" : "started", generation: m.boss.generation, sid: m.boss.sid });
      this.pump(m);
    })().finally(() => { rt.starting = null; });
    return rt.starting;
  }

  onBossExit(m, boss, code) {
    const rt = this.runtime(m.id);
    if (rt.boss !== boss) return;
    rt.ready = false; rt.boss = null;
    if (m.boss.sid) this.bossSids.delete(m.boss.sid);
    if (rt.stopping || m.status === "paused" || m.status === "done") return;
    if (rt.inFlight) { rt.inFlight = null; this.clearTimerOf(rt, "turn"); }
    m.errors.consecutive++;
    m.errors.lastError = `the boss chat exited (code ${code})`;
    const delay = this.backoff(m);
    m.errors.nextRetryAt = this.now() + delay;
    this.ledger(m, `boss chat exited (code ${code}); reopening in ${fmtDur(delay)}`);
    this.save(m, { kind: "boss", op: "exit", code });
    this.clearTimerOf(rt, "restart");
    rt.timers.restart = this.later(delay, () => { rt.timers.restart = null; if (!rt.boss && m.status !== "paused" && m.status !== "done") this.startBoss(m).catch((e) => this.log("missions: boss restart failed", m.id, e?.message || e)); });
  }

  backoff(m) { const n = Math.max(1, m.errors.consecutive); return Math.min(this.config.retryMaxMs, this.config.retryBaseMs * 2 ** (n - 1)); }

  /** Queue a delivery to the boss (persisted). `front` puts it before everything not yet in flight. */
  enqueue(m, { type = "event", text, front = false, ref = null } = {}, { pump = true } = {}) {
    const item = { id: this.nextId(m, "d"), type, text: String(text ?? ""), at: this.now(), ref };
    if (front) {
      const rt = this.rt.get(m.id);
      const lead = rt?.inFlight && m.queue[0]?.id === rt.inFlight ? 1 : 0;
      let i = lead; while (i < m.queue.length && m.queue[i].front) i++;
      m.queue.splice(i, 0, { ...item, front: true });
    } else m.queue.push(item);
    this.save(m, { kind: "enqueue", id: item.id, type });
    if (pump) this.pump(m);
    return item;
  }

  /** Deliver the queue's head when the boss is idle and no retry is pending. */
  pump(m) {
    const rt = this.runtime(m.id);
    const boss = rt.boss;
    if (!boss || !rt.ready || rt.inFlight || rt.pumping) return;
    if (m.status === "paused" || m.status === "done" || m.status === "error") return;
    if (rt.timers.retry) return;
    if (boss.streaming) return; // its status event re-pumps when the current turn ends
    const item = m.queue[0];
    if (!item) return;
    rt.pumping = true;
    try {
      rt.inFlight = item.id; rt.sawStreaming = false; rt.turnError = null; rt.sawReply = false;
      this.clearTimerOf(rt, "turn");
      rt.timers.turn = this.later(this.config.turnTimeoutMs, () => { rt.timers.turn = null; if (rt.inFlight === item.id) this.onBossTurnEnd(m, { error: "the boss turn did not finish in time" }); });
      const text = clip(`[mission ${m.id}] ${item.text}`, this.config.deliverMax);
      (async () => {
        if (m.usingFallback && this.now() - (m.fallbackAt || 0) >= this.config.primaryRetryMs) await this.switchModel(m, false);
        return boss.prompt(text, { echo: true });
      })().then((r) => {
        if (r && r.success === false && rt.inFlight === item.id) this.onBossTurnEnd(m, { error: r.error || "the prompt was refused" });
      }, (e) => { if (rt.inFlight === item.id) this.onBossTurnEnd(m, { error: e?.message || String(e) }); });
    } finally { rt.pumping = false; }
  }

  async switchModel(m, toFallback) {
    const rt = this.runtime(m.id);
    const target = toFallback ? m.fallbackModel : m.bossModel;
    if (!target || !rt.boss?.setModel) return false;
    try { await rt.boss.setModel(target.provider, target.id); } catch (e) { this.log("missions: setModel failed", e?.message || e); return false; }
    m.usingFallback = !!toFallback;
    if (toFallback) m.fallbackAt = this.now();
    this.ledger(m, `boss model → ${modelLabel(target)}${toFallback ? " (fallback)" : " (primary again)"}`);
    this.save(m, { kind: "boss", op: "model", model: target, fallback: !!toFallback });
    return true;
  }

  /** A boss turn ended: drop the delivered item, or schedule its retry (backoff, fallback, a notification). */
  onBossTurnEnd(m, { error = null } = {}) {
    const rt = this.runtime(m.id);
    const id = rt.inFlight;
    rt.inFlight = null;
    this.clearTimerOf(rt, "turn");
    if (error) {
      m.errors.consecutive++;
      m.errors.lastError = oneLine(error, 500);
      const n = m.errors.consecutive;
      if (n >= this.config.fallbackAfter && m.fallbackModel && !m.usingFallback) {
        this.switchModel(m, true).then((ok) => { if (ok) this.notify(m, { title: "Boss switched to fallback model", body: `The boss's model failed ${n} times in a row (last error: ${m.errors.lastError}). It now runs on ${modelLabel(m.fallbackModel)} and will try ${modelLabel(m.bossModel)} again in ${fmtDur(this.config.primaryRetryMs)}. Workers keep running.`, urgency: "info" }); });
      }
      if (n >= this.config.urgentAfter && !m.errors.notifiedUrgent) {
        m.errors.notifiedUrgent = true;
        this.notify(m, { title: "Boss keeps failing", body: `${n} failed boss turns in a row. Last error: ${m.errors.lastError}. Workers keep running and reports are queued; it keeps retrying every ${fmtDur(this.config.retryMaxMs)}.`, urgency: "urgent" });
      }
      const delay = this.backoff(m);
      m.errors.nextRetryAt = this.now() + delay;
      this.ledger(m, `boss turn failed (${n}): ${m.errors.lastError}; retry in ${fmtDur(delay)}`);
      this.save(m, { kind: "turn", ok: false, error: m.errors.lastError, retryInMs: delay });
      this.clearTimerOf(rt, "retry");
      rt.timers.retry = this.later(delay, () => { rt.timers.retry = null; this.pump(m); });
      return;
    }
    const i = m.queue.findIndex((q) => q.id === id);
    if (i >= 0) m.queue.splice(i, 1);
    m.errors.consecutive = 0; m.errors.lastError = ""; m.errors.nextRetryAt = 0; m.errors.notifiedUrgent = false;
    m.lastDeliveryAt = this.now();
    const boss = rt.boss;
    if (boss) {
      m.boss.contextUsed = Number(boss.lastContext) || m.boss.contextUsed || 0;
      m.boss.contextWindow = Number(boss.state?.model?.contextWindow) || m.boss.contextWindow || 0;
    }
    this.save(m, { kind: "turn", ok: true, id });
    if (this.maybeRebirth(m)) return;
    this.pump(m);
  }

  /** Past `rebirthAt` of the boss's window: a new session, briefed from the ledger. → true when it happened. */
  maybeRebirth(m) {
    const rt = this.runtime(m.id);
    const { contextUsed: used, contextWindow: win } = m.boss;
    if (!rt.boss || !win || !used || used / win < this.config.rebirthAt) return false;
    const prev = { sessionFile: m.boss.sessionFile, sessionId: m.boss.sessionId, generation: m.boss.generation, endedAt: this.now(), contextUsed: used };
    m.boss.previous = [...(m.boss.previous || []), prev].slice(-50);
    this.ledger(m, `boss rebirth: generation ${m.boss.generation} used ${Math.round((used / win) * 100)}% of its context; a new boss continues from the ledger`);
    rt.ready = false;
    (async () => {
      await rt.boss.newSession();
      this.bindBoss(m, rt);
      m.boss.sessionFile = rt.boss.state?.sessionFile || null;
      m.boss.sessionId = rt.boss.state?.sessionId || null;
      m.boss.generation++;
      m.boss.contextUsed = 0;
      rt.ready = true;
      this.enqueue(m, { type: "briefing", front: true, text: bossBriefing(m, renderState(m, { workers: this.workersOf(m), now: this.now(), max: 6000 }), { rebirth: true }) });
    })().catch((e) => { rt.ready = true; this.log("missions: rebirth failed", e?.message || e); this.pump(m); });
    return true;
  }

  armHeartbeat(m) {
    const rt = this.runtime(m.id);
    this.clearTimerOf(rt, "heartbeat");
    if (!this.config.heartbeatMs) return;
    rt.timers.heartbeat = this.later(this.config.heartbeatMs, () => {
      rt.timers.heartbeat = null;
      if (m.status === "running" && !m.queue.length && !rt.inFlight && this.now() - (m.lastDeliveryAt || 0) >= this.config.heartbeatMs) {
        const workers = this.workersOf(m);
        if (workers.some((w) => ACTIVE.has(w.status))) this.enqueue(m, { type: "heartbeat", text: `Heartbeat: nothing arrived for ${fmtDur(this.config.heartbeatMs)}. Current state:\n${renderState(m, { workers, now: this.now() })}\nCheck on stalled workers if needed (worker_summary), otherwise just reply "ok".` });
      }
      if (m.status !== "done") this.armHeartbeat(m);
    });
  }

  onBus(ev) {
    if (!ev?.sid) return;
    const id = this.bossSids.get(ev.sid);
    if (id) {
      const m = this.get(id), rt = m && this.runtime(id);
      if (!m) return;
      if (ev.kind === "msg" && ev.role === "assistant" && rt.inFlight && ev.stopReason !== "error" && ev.stopReason !== "aborted") rt.sawReply = true;
      if (ev.kind === "msg" && ev.role === "assistant" && ev.stopReason === "error") rt.turnError = oneLine((ev.blocks || []).map((b) => b.text || "").join(" ").replace(/^Model error:\s*/, ""), 500) || "model error";
      if (ev.kind === "status" && typeof ev.streaming === "boolean") {
        if (ev.streaming) rt.sawStreaming = true;
        // A turn that ended without any reply (a stalled stream the watchdog aborted, a dropped connection) failed too.
        else if (rt.inFlight && rt.sawStreaming) this.onBossTurnEnd(m, { error: rt.turnError || (rt.sawReply ? null : "the boss's turn ended without a reply") });
        else if (!rt.inFlight) this.pump(m);
      }
      return;
    }
    // A summary request waits for a worker's next text.
    if (ev.kind === "msg" && ev.role === "assistant" && ev.live) {
      for (const rt of this.rt.values()) for (const w of rt.summaryWaiters) if (w.sid === ev.sid) w.onText((ev.blocks || []).filter((b) => b.type === "text" && b.text).map((b) => b.text).join("\n").trim());
    }
  }

  // ------------------------------------------------------------------ workers
  spawnWorker(m, spec = {}) {
    if (m.status === "done") throw bad("this mission is done");
    const task = String(spec.task ?? "").trim();
    if (!task) throw bad("a worker needs a task");
    const kind = spec.kind === "claude" ? "claude" : spec.kind === "opencode" || spec.kind === "pi" ? "pi" : m.workerKind;
    const taskRef = spec.taskId ? m.tasks.find((t) => t.id === String(spec.taskId)) : null;
    if (spec.taskId && !taskRef) throw bad(`no task ${spec.taskId}`);
    const p = this.projectOf(m);
    const brief = workerBrief(m, { task, scope: spec.scope }, p);
    let model = "", provider = "";
    const want = spec.model || (kind === m.workerKind ? m.workerModel : "");
    if (kind === "pi") { const mm = asModel(want) || (m.usingFallback && m.fallbackModel ? m.fallbackModel : m.bossModel); model = mm.id; provider = mm.provider; } else model = String(want || "");
    const rec = this.agents.start({
      kind, task: brief, title: spec.title || (taskRef ? `${taskRef.id} ${taskRef.title}` : undefined), cwd: m.dir, agent: spec.agent || undefined, model, provider,
      parentSid: `mission:${m.id}`, parentSessionId: null, depth: 0, missionId: m.id, taskId: taskRef?.id || null, role: "worker", footer: WORKER_FOOTER, memory: true,
      timeoutMinutes: spec.timeoutMinutes,
    });
    this.files.get(m.id)?.writeBrief(rec.id, brief);
    if (!m.workers.includes(rec.id)) m.workers.push(rec.id);
    if (taskRef) { taskRef.workers = [...new Set([...(taskRef.workers || []), rec.id])]; if (taskRef.status === "todo") taskRef.status = "active"; }
    this.ledger(m, `worker ${rec.id} (${kindName(kind)}${model ? ` ${model}` : ""}) spawned${taskRef ? ` for ${taskRef.id}` : ""}: ${oneLine(task, 200)}`);
    this.save(m, { kind: "worker", op: "spawn", id: rec.id, workerKind: kind, taskId: taskRef?.id || null });
    return rec;
  }

  mustWorker(m, wid) {
    const rec = this.agents.get(wid);
    if (!rec || rec.missionId !== m.id) throw httpError(404, `no worker ${wid} in mission ${m.id}`);
    return rec;
  }

  onAgent(rec) {
    if (!rec?.missionId || rec.role !== "worker") return;
    const m = this.get(rec.missionId);
    if (!m) return;
    if (!m.workers.includes(rec.id)) m.workers.push(rec.id);
    if (!FINISHED.has(rec.status) || rec.delivered) return;
    const rt = this.runtime(m.id);
    const key = `${rec.id}:${rec.endedAt}`;
    if (rt.reported.has(key)) return;
    rt.reported.add(key);
    // A worker that handed off has a successor on its task: its own end is not a report.
    if (m.handoffs?.some((h) => h.from === rec.id)) { try { this.agents.markDelivered(rec.id); } catch { /* gone */ } return; }
    this.deliverReport(m, rec);
  }

  deliverReport(m, rec) {
    let path = "";
    try { path = this.files.get(m.id)?.writeReport(rec.id, `${compactReport(rec, "", { max: 1e9, now: this.now() })}\n`) || ""; } catch (e) { this.log("missions: could not store a report", e.message); }
    const text = compactReport(rec, path, { max: this.config.reportMax, now: this.now() });
    const task = rec.taskId ? m.tasks.find((t) => t.id === rec.taskId) : null;
    if (task) { const outcome = reportSection(rec.resultText, "Outcome") || reportSection(rec.resultText, "Status"); if (outcome) task.summary = oneLine(outcome, 400); }
    // Pending questions of an ended worker can no longer be answered.
    for (const q of m.questions || []) if (q.worker === rec.id && q.answer == null) { q.answer = "(the worker ended)"; this.runtime(m.id).questions.get(q.id)?.("(the worker ended)"); }
    this.ledger(m, `worker ${rec.id} ${rec.status}${task ? ` (task ${task.id})` : ""}: ${oneLine(reportSection(rec.resultText, "Outcome") || rec.resultText || rec.error || "", 300)}`);
    this.enqueue(m, { type: "report", text, ref: rec.id });
    try { this.agents.markDelivered(rec.id); } catch { /* gone */ }
  }

  /** Ask a worker for a status summary (running) or give its report (finished). */
  async workerSummary(m, wid, { timeoutMs = this.config.summaryTimeoutMs } = {}) {
    const rec = this.mustWorker(m, wid);
    if (FINISHED.has(rec.status)) return compactReport(rec, "", { max: this.config.toolMax, now: this.now() });
    if (rec.kind === "shell") return `Job ${rec.id} ${rec.status}. Last lines:\n${(rec.activity || []).join("\n")}`;
    const rt = this.runtime(m.id);
    return new Promise((resolve) => {
      let done = false, last = "";
      const w = { sid: rec.sid, onText: (t) => { if (!t) return; last = t; if (/##\s*Status/i.test(t) || /##\s*Outcome/i.test(t)) end(t); } };
      const end = (t) => { if (done) return; done = true; rt.summaryWaiters.delete(w); this.clearTimer(timer); resolve(clip(t, this.config.toolMax)); };
      const timer = this.later(timeoutMs, () => { const cur = this.agents.get(rec.id); end(last || `No summary within ${fmtDur(timeoutMs)}. Worker ${rec.id} is ${cur?.status}. Recent activity:\n${(cur?.activity || []).map((l) => `- ${l}`).join("\n")}`); });
      rt.summaryWaiters.add(w);
      // A worker that changed sid since (resumed) is found again by its record.
      Promise.resolve(this.agents.message(rec.id, SUMMARY_REQUEST)).then(() => { const cur = this.agents.get(rec.id); if (cur?.sid) w.sid = cur.sid; }, (e) => end(`Could not ask worker ${rec.id}: ${e?.message || e}`));
    });
  }

  async messageWorker(m, wid, text, { from = "boss" } = {}) {
    this.mustWorker(m, wid);
    const t = String(text ?? "").trim();
    if (!t) throw bad("empty message");
    const r = await this.agents.message(wid, from === "user" ? `[from the user] ${t}` : `[from the boss] ${t}`);
    this.ledger(m, `${from} → worker ${wid}: ${oneLine(t, 300)}`);
    if (from === "user") this.enqueue(m, { type: "event", text: `The user told worker ${wid} directly: ${clip(t, 2000)}` });
    else this.save(m, { kind: "message", to: wid, from });
    return r;
  }

  /**
   * A worker hands its task to a fresh one (its context is spent): the successor gets the same brief, scope and task
   * plus the handoff note; the old one is stopped without a report. → the successor's record.
   */
  async handoffWorker(m, wid, note) {
    const rec = this.mustWorker(m, wid);
    const text = String(note ?? "").trim();
    if (text.length < 40) throw bad("a handoff needs a complete note: state, what works, what failed, next steps");
    const f = this.files.get(m.id);
    let brief = rec.task || "";
    try { brief = readFileSync(join(f.dir, "workers", rec.id, "brief.md"), "utf8"); } catch { /* the record's copy */ }
    try { f.writeBrief(rec.id, text, "handoff.md"); } catch { /* best effort */ }
    m.handoffs = [...(m.handoffs || []), { from: rec.id, at: this.now() }];
    const chain = m.handoffs.filter((h) => h.task === rec.taskId).length;
    const next = this.agents.start({
      kind: rec.kind, task: `${brief}\n\n## Handoff from the previous worker (${rec.id})\nYou continue its task. Its notes:\n\n${clip(text, 12000)}`,
      title: rec.title, cwd: rec.cwd, agent: rec.agent || undefined, model: rec.model, provider: rec.provider,
      parentSid: `mission:${m.id}`, parentSessionId: null, depth: 0, missionId: m.id, taskId: rec.taskId, role: "worker", footer: WORKER_FOOTER, memory: true,
    });
    m.handoffs[m.handoffs.length - 1].to = next.id;
    m.handoffs[m.handoffs.length - 1].task = rec.taskId;
    try { f.writeBrief(next.id, `${brief}\n\n(continued from ${rec.id}; see its handoff.md)`); } catch { /* best effort */ }
    if (!m.workers.includes(next.id)) m.workers.push(next.id);
    const task = rec.taskId ? m.tasks.find((t) => t.id === rec.taskId) : null;
    if (task) task.workers = [...new Set([...(task.workers || []), next.id])];
    this.ledger(m, `worker ${rec.id} handed off to ${next.id}${task ? ` (task ${task.id})` : ""}: ${oneLine(text, 300)}`);
    this.enqueue(m, { type: "event", text: `Worker ${rec.id} ran out of context and handed its task${task ? ` ${task.id}` : ""} to a fresh worker ${next.id}${chain ? ` (handoff #${chain + 1} on this task)` : ""}. Its handoff note:\n${clip(text, 1500)}` });
    // Stopped after the successor exists, so its "cancelled" end is recognized as a handoff, not a report.
    this.agents.cancel(rec.id).catch(() => {});
    return next;
  }

  async cancelWorker(m, wid) { this.mustWorker(m, wid); const r = await this.agents.cancel(wid); this.ledger(m, `worker ${wid} cancelled`); return r; }

  /** A worker's question to the boss; resolves with the answer or a timeout note. */
  askBoss(m, wid, question, { timeoutMs = this.config.questionTimeoutMs } = {}) {
    const q = { id: this.nextId(m, "q"), worker: wid, question: clip(String(question || "").trim(), 3000), at: this.now(), answer: null };
    if (!q.question) return Promise.reject(bad("empty question"));
    m.questions = [...(m.questions || []), q].slice(-500);
    this.ledger(m, `worker ${wid} asks ${q.id}: ${oneLine(q.question, 300)}`);
    this.enqueue(m, { type: "question", front: true, ref: q.id, text: `Worker ${wid} is blocked and asks (${q.id}):\n${q.question}\n\nAnswer with worker_message {id: "${wid}", question_id: "${q.id}", message: …}.` });
    const rt = this.runtime(m.id);
    return new Promise((resolve) => {
      const timer = this.later(timeoutMs, () => { rt.questions.delete(q.id); resolve(null); });
      rt.questions.set(q.id, (a) => { this.clearTimer(timer); rt.questions.delete(q.id); resolve(a); });
    });
  }
  /** → true when a waiting worker took the answer (else it is sent as a normal message). */
  answerQuestion(m, qid, text) {
    const q = (m.questions || []).find((x) => x.id === String(qid));
    if (!q) throw bad(`no question ${qid}`);
    q.answer = clip(String(text ?? ""), 4000); q.answeredAt = this.now();
    this.ledger(m, `boss answered ${q.id}: ${oneLine(q.answer, 300)}`);
    this.save(m, { kind: "answer", id: q.id });
    const w = this.runtime(m.id).questions.get(q.id);
    if (w) { w(q.answer); return true; }
    return false;
  }

  // ------------------------------------------------------------------ the user
  messageBoss(m, text) {
    const t = String(text ?? "").trim();
    if (!t) throw bad("empty message");
    this.ledger(m, `user → boss: ${oneLine(t, 300)}`);
    if (m.status === "done") { m.status = "running"; this.armHeartbeat(m); }
    this.enqueue(m, { type: "user", front: true, text: `Message from the user:\n${t}` });
    if (!this.runtime(m.id).boss && this.createBoss && m.status !== "paused") this.startBoss(m).catch(() => {});
  }

  finish(m, summary) {
    m.status = "done";
    m.summary = clip(String(summary || ""), 8000);
    this.ledger(m, `mission done: ${oneLine(summary, 400)}`);
    this.save(m, { kind: "done" });
    this.notify(m, { title: `Mission done: ${m.title}`, body: m.summary, urgency: "action" });
  }

  async stop(m) {
    const rt = this.runtime(m.id);
    rt.stopping = true;
    m.status = "paused";
    for (const w of this.workersOf(m)) if (ACTIVE.has(w.status)) { try { await this.agents.cancel(w.id); } catch { /* gone */ } }
    for (const k of Object.keys(rt.timers)) this.clearTimerOf(rt, k);
    const boss = rt.boss; rt.boss = null; rt.ready = false; rt.inFlight = null;
    try { boss?.stop?.(); } catch { /* gone */ }
    if (m.boss.sid) this.bossSids.delete(m.boss.sid);
    rt.stopping = false;
    this.ledger(m, "mission paused by the user");
    this.save(m, { kind: "paused" });
  }
  async resume(m) {
    if (m.status !== "paused" && m.status !== "error") return m;
    m.status = "running";
    this.ledger(m, "mission resumed");
    this.save(m, { kind: "resumed" });
    this.armHeartbeat(m);
    if (this.createBoss) await this.startBoss(m);
    return m;
  }

  // ------------------------------------------------------------------ boot
  /** Load every mission; running ones get their boss back and their finished-but-unreported workers delivered. */
  reconcile() {
    const root = this.store.root;
    let slugs = [];
    try { slugs = readdirSync(root); } catch { return []; }
    for (const slug of slugs) {
      const mdir = join(root, slug, "missions");
      let ids = [];
      try { ids = readdirSync(mdir); } catch { continue; }
      for (const id of ids) {
        if (this.missions.has(id)) continue;
        const f = new MissionFiles({ dir: join(mdir, id) });
        const m = f.read();
        if (!m?.id || m.id !== id) continue;
        this.missions.set(id, m);
        this.files.set(id, f);
        if (m.boss?.sid) this.bossSids.delete(m.boss.sid);
        m.boss = { ...m.boss, sid: null };
        if (m.status === "running" || m.status === "starting" || m.status === "waiting") {
          this.ledger(m, "Omni restarted; resuming the mission");
          m.queue = m.queue || [];
          const lost = this.workersOf(m).filter((w) => w.role === "worker" && FINISHED.has(w.status) && !w.delivered);
          this.enqueue(m, { type: "event", front: true, text: `Omni restarted. ${lost.length ? `${lost.length} worker report(s) follow (some workers may have been interrupted and can be resumed with worker_message).` : "No worker reports were lost."} Continue the mission.` }, { pump: false });
          for (const w of lost) this.onAgent(w);
          this.armHeartbeat(m);
          if (this.createBoss) this.startBoss(m).catch((e) => this.log("missions: boss reopen failed", id, e?.message || e));
        }
      }
    }
    return this.list();
  }

  dispose({ stopBosses = false } = {}) {
    this.bus?.off?.("event", this.onBus);
    this.agents?.off?.("change", this.onAgent);
    for (const rt of this.rt.values()) {
      for (const k of Object.keys(rt.timers)) this.clearTimerOf(rt, k);
      if (stopBosses && rt.boss) { const b = rt.boss; rt.boss = null; try { b.stop?.(); } catch { /* gone */ } }
    }
    for (const m of this.missions.values()) { try { this.files.get(m.id)?.write(m); } catch { /* best effort */ } }
  }
}
