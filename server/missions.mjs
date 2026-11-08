/**
 * Missions: one orchestrator chat that only orchestrates, temporary worker agents that do the work, and a durable ledger.
 *
 *   orchestrator     an OpencodeRpc-like chat (createOrchestrator) whose tool allowlist is only the orchestrator tools (orchestrator-prompt.mjs). It
 *            never sees tool output: it is prompted with compact `[mission <id>] …` deliveries from a persisted queue,
 *            one at a time, when it is idle. A failed turn is retried with backoff; after `fallbackAfter` failures it
 *            switches to the mission's fallback model; a dead chat is reopened on its session; past `rebirthAt` of its
 *            context window a fresh orchestrator generation starts from a briefing rendered from the ledger.
 *   workers  AgentManager agents tagged with missionId/role "worker" (parentSid "mission:<id>"). Their reports are
 *            stored in full and delivered to the orchestrator capped; subagents they start inherit the missionId.
 *   state    mission.json (atomic) + events.jsonl + ledger.md per mission (projects.mjs). Nothing lives only in memory.
 */
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { MissionFiles } from "./projects.mjs";
import { ORCHESTRATOR_SYSTEM, ORCHESTRATOR_TOOLS, orchestratorBriefing } from "./orchestrator-prompt.mjs";
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

/** A mission saved before the "boss" was renamed "orchestrator" gets the new field names. Pure (returns the same object). */
export function migrateMission(m) {
  if (!m || typeof m !== "object") return m;
  const OLD = "boss";
  if (m[OLD] && !m.orchestrator) { m.orchestrator = m[OLD]; delete m[OLD]; }
  if (m[`${OLD}Model`] && !m.orchestratorModel) { m.orchestratorModel = m[`${OLD}Model`]; delete m[`${OLD}Model`]; }
  return m;
}

/** The mission as the orchestrator sees it: tasks, workers, open questions, recent notes. Pure. */
export function renderState(m, { workers = [], now = Date.now(), max = 4000 } = {}) {
  const out = [`Mission ${m.id} — ${m.status}${m.usingFallback ? " (orchestrator on fallback model)" : ""}`, `Goal: ${oneLine(m.goal, 300)}`, "", "Tasks:"];
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

/** A worker's report as delivered to the orchestrator: a header, the report (capped), a pointer to the full one. Pure. */
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
  constructor({ bus, store, agents, createOrchestrator = null, config = {}, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, log = () => {} } = {}) {
    super();
    this.bus = bus; this.store = store; this.agents = agents; this.createOrchestrator = createOrchestrator;
    this.config = {
      retryBaseMs: 15000, retryMaxMs: 600000, fallbackAfter: 3, primaryRetryMs: 3600000, heartbeatMs: 1800000, rebirthAt: 0.6,
      reportMax: 8000, toolMax: 4000, deliverMax: 12000, questionTimeoutMs: 1800000, turnTimeoutMs: 45 * 60000, summaryTimeoutMs: 600000, urgentAfter: 10,
      ...config,
    };
    this.now = now; this.setTimer = setTimer; this.clearTimer = clearTimer; this.log = log;
    // Every agent of a mission (workers, their subagents) gets the mission's start message first.
    if (agents && !agents.starterFor) agents.starterFor = (mid) => this.missions.get(mid)?.startMessage || "";
    this.missions = new Map(); // id -> record (plain JSON)
    this.files = new Map();    // id -> MissionFiles
    this.paths = new Map();    // id -> project paths
    this.rt = new Map();       // id -> runtime (orchestrator chat, turn, timers, waiters)
    this.orchestratorSids = new Map(); // orchestrator sid -> mission id
    this.onBus = this.onBus.bind(this);
    this.onAgent = this.onAgent.bind(this);
    bus?.on?.("event", this.onBus);
    agents?.on?.("change", this.onAgent);
  }

  // ------------------------------------------------------------------ records
  runtime(id) {
    let rt = this.rt.get(id);
    if (!rt) { rt = { orchestrator: null, ready: false, starting: null, inFlight: null, sawStreaming: false, turnError: null, timers: {}, reported: new Set(), questions: new Map(), summaryWaiters: new Set(), restarting: false }; this.rt.set(id, rt); }
    return rt;
  }
  later(ms, fn) { const t = this.setTimer(fn, Math.max(0, Math.min(TIMER_MAX, ms))); t?.unref?.(); return t; }
  clearTimerOf(rt, name) { if (rt.timers[name]) { this.clearTimer(rt.timers[name]); rt.timers[name] = null; } }

  pub(m) { return { ...m, queue: (m.queue || []).map((q) => ({ id: q.id, type: q.type, at: q.at, preview: oneLine(q.text, 140) })) }; }
  /** What a bus event carries: the recent tail of the long lists (GET /api/missions/:id has them all). */
  slim(m) {
    const p = this.pub(m);
    return { ...p, notes: (m.notes || []).slice(-40), notifications: (m.notifications || []).slice(-100), questions: (m.questions || []).slice(-40), counts: { notes: m.notes?.length || 0, notifications: m.notifications?.length || 0, questions: m.questions?.length || 0 } };
  }
  get(id) { return this.missions.get(String(id)) || null; }
  must(id) { const m = this.get(id); if (!m) throw httpError(404, `no mission ${id}`); return m; }
  list() { return [...this.missions.values()].sort((a, b) => b.createdAt - a.createdAt); }
  workersOf(m) { return this.agents?.list ? this.agents.list().filter((a) => a.missionId === m.id) : []; }
  /** The mission a chat belongs to: its orchestrator chat, or a worker / subagent chat. */
  bySession(sid) {
    if (!sid) return null;
    const s = String(sid), full = s.includes(":") ? s : `pi:${s}`;
    const byOrchestrator = this.orchestratorSids.get(full);
    if (byOrchestrator) return this.get(byOrchestrator);
    for (const m of this.missions.values()) if (this.orchestratorSession(m, full)) return m;
    const a = this.agents?.agentBySid?.(full);
    return a?.missionId ? this.get(a.missionId) : null;
  }
  /** Is `sid` one of the mission's orchestrator chats — the live one, its saved session, or an earlier generation's? */
  orchestratorSession(m, sid) {
    const full = String(sid).includes(":") ? String(sid) : `pi:${sid}`, bare = full.replace(/^pi:/, "");
    return !!m && (m.orchestrator?.sid === full || m.orchestrator?.sessionId === bare || (m.orchestrator?.previous || []).some((p) => p.sessionId === bare));
  }
  isOrchestrator(m, sid) { const full = String(sid).includes(":") ? String(sid) : `pi:${sid}`; return !!m && (this.orchestratorSids.get(full) === m.id || this.orchestratorSession(m, full)); }
  projectOf(m) { let p = this.paths.get(m.id); if (!p) { p = this.store.project(m.dir); this.paths.set(m.id, p); } return p; }

  save(m, ev = null) {
    if (this.missions.get(m.id) !== m) return; // removed: a timer or a chat still holding it must not announce it again
    m.updatedAt = this.now();
    const f = this.files.get(m.id);
    try { f?.write(m); if (ev) f?.append(ev); } catch (e) { this.log("missions: could not save", m.id, e.message); }
    this.bus?.emit?.({ sid: `mission:${m.id}`, harness: "omni", kind: "mission", ts: m.updatedAt, mission: this.slim(m) });
    this.emit("change", m);
  }
  ledger(m, line) { try { this.files.get(m.id)?.ledger(line); } catch { /* best effort */ } }

  // ------------------------------------------------------------------ create
  create(spec = {}) {
    const goal = String(spec.goal ?? "").trim();
    const dir = String(spec.dir ?? "").trim();
    const orchestratorModel = asModel(spec.orchestratorModel);
    if (!goal) throw bad("a mission needs a goal");
    if (!dir) throw bad("a mission needs a project directory");
    if (!existsSync(dir)) throw bad(`project directory not found: ${dir}`);
    if (!orchestratorModel) throw bad("a mission needs an orchestrator model");
    const p = this.store.project(dir);
    let id; do { id = `m-${randomBytes(4).toString("hex")}`; } while (this.missions.has(id));
    const now = this.now();
    const m = {
      id, title: oneLine(spec.title || goal.split(/\r?\n/).find((l) => l.trim()) || "Mission", 80), goal, dir: p.dir, slug: p.slug,
      status: "starting", createdAt: now, updatedAt: now,
      orchestratorModel, fallbackModel: asModel(spec.fallbackModel), usingFallback: false, fallbackAt: 0,
      workerKind: spec.workerKind === "claude" ? "claude" : "pi", workerModel: String(spec.workerModel || ""),
      startMessage: clip(String(spec.startMessage ?? "").trim(), 4000),
      orchestrator: { sid: null, sessionId: null, sessionFile: null, generation: 0, contextUsed: 0, contextWindow: 0, previous: [] },
      tasks: [], notes: [], workers: [], notifications: [], questions: [], queue: [],
      errors: { consecutive: 0, lastError: "", nextRetryAt: 0, notifiedUrgent: false },
      lastDeliveryAt: 0, seq: 0,
    };
    this.missions.set(id, m);
    this.files.set(id, new MissionFiles({ dir: join(p.missionsDir, id) }));
    this.paths.set(id, p);
    this.ledger(m, `mission created: ${oneLine(goal, 300)} (orchestrator ${modelLabel(orchestratorModel)}${m.fallbackModel ? `, fallback ${modelLabel(m.fallbackModel)}` : ""})`);
    this.save(m, { kind: "created", goal, orchestratorModel, fallbackModel: m.fallbackModel });
    if (this.createOrchestrator) this.startOrchestrator(m).catch((e) => this.log("missions: orchestrator start failed", id, e?.message || e));
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

  // ------------------------------------------------------------------ the orchestrator
  bindOrchestrator(m, rt) {
    const sid = rt.orchestrator?.sid;
    if (!sid || sid === "pi:pending") return;
    if (m.orchestrator.sid && m.orchestrator.sid !== sid) this.orchestratorSids.delete(m.orchestrator.sid);
    m.orchestrator.sid = sid;
    m.orchestrator.sessionId = rt.orchestrator.state?.sessionId || m.orchestrator.sessionId;
    m.orchestrator.sessionFile = rt.orchestrator.state?.sessionFile || m.orchestrator.sessionFile;
    this.orchestratorSids.set(sid, m.id);
  }

  /** Start (or reopen, on its saved session) the orchestrator chat; a fresh mission gets its briefing first. */
  /**
   * Start (or reopen, on its saved session) the orchestrator chat; a fresh mission gets its briefing first. A start that
   * fails is retried with backoff; one overtaken by stop() (or a newer start) stops the chat it made.
   */
  async startOrchestrator(m, { fresh = false } = {}) {
    const rt = this.runtime(m.id);
    if (rt.starting) return rt.starting;
    if (!this.createOrchestrator) throw new Error("missions: no orchestrator factory");
    const token = rt.startToken = (rt.startToken || 0) + 1;
    const current = () => token === rt.startToken && m.status !== "paused" && m.status !== "done";
    const p = (async () => {
      if (rt.orchestrator) { const old = rt.orchestrator; rt.orchestrator = null; rt.ready = false; try { old.stop?.(); } catch { /* gone */ } }
      const model = m.usingFallback && m.fallbackModel ? m.fallbackModel : m.orchestratorModel;
      const orchestrator = this.createOrchestrator({ cwd: m.dir, model: model.id, provider: model.provider, system: ORCHESTRATOR_SYSTEM, tools: [...ORCHESTRATOR_TOOLS], meta: { missionId: m.id, missionRole: "orchestrator", title: `Orchestrator · ${m.title}` } });
      rt.orchestrator = orchestrator; rt.ready = false; rt.inFlight = null;
      orchestrator.on?.("exit", (code) => this.onOrchestratorExit(m, orchestrator, code));
      try {
        orchestrator.start?.();
        await orchestrator.waitReady?.();
        let reopen = !fresh && !!m.orchestrator.sessionFile;
        if (reopen) {
          try { await orchestrator.switchSession(m.orchestrator.sessionFile); } catch (e) {
            // Its session is gone (deleted, a reset server): continue in the new one, briefed from the ledger.
            reopen = false;
            this.log("missions: could not reopen the orchestrator session", m.id, e?.message || e);
          }
        }
        if (!current() || rt.orchestrator !== orchestrator) { if (rt.orchestrator === orchestrator) rt.orchestrator = null; try { orchestrator.stop?.(); } catch { /* gone */ } return; }
        this.bindOrchestrator(m, rt);
        rt.ready = true;
        if (!reopen) {
          m.orchestrator.generation = (m.orchestrator.generation || 0) + 1;
          this.brief(m, { rebirth: m.orchestrator.generation > 1 });
        }
        if (m.status === "starting") m.status = "running";
        this.save(m, { kind: "orchestrator", op: reopen ? "reopened" : "started", generation: m.orchestrator.generation, sid: m.orchestrator.sid });
        this.pump(m);
      } catch (e) {
        if (rt.orchestrator === orchestrator) { rt.orchestrator = null; rt.ready = false; }
        try { orchestrator.stop?.(); } catch { /* gone */ }
        this.log("missions: the orchestrator could not start", m.id, e?.message || e);
        if (current()) this.scheduleOrchestratorRestart(m, `the orchestrator chat could not start: ${oneLine(e?.message || e, 300)}`);
      }
    })();
    rt.starting = p.finally(() => { if (rt.starting === wrapped) rt.starting = null; });
    const wrapped = rt.starting;
    return wrapped;
  }

  /** The orchestrator chat is gone (it exited, or never started): count it as a failure and start it again after the backoff. */
  scheduleOrchestratorRestart(m, reason) {
    const rt = this.runtime(m.id);
    if (rt.inFlight) { rt.inFlight = null; this.clearTimerOf(rt, "turn"); }
    m.errors.consecutive++;
    m.errors.lastError = reason;
    const delay = this.backoff(m);
    m.errors.nextRetryAt = this.now() + delay;
    this.ledger(m, `${reason}; trying again in ${fmtDur(delay)}`);
    this.save(m, { kind: "orchestrator", op: "restart-scheduled", reason, inMs: delay });
    this.clearTimerOf(rt, "restart");
    rt.timers.restart = this.later(delay, () => { rt.timers.restart = null; if (!rt.orchestrator && m.status !== "paused" && m.status !== "done") this.startOrchestrator(m).catch((e) => this.log("missions: orchestrator restart failed", m.id, e?.message || e)); });
  }

  onOrchestratorExit(m, orchestrator, code) {
    const rt = this.runtime(m.id);
    if (rt.orchestrator !== orchestrator) return;
    rt.ready = false; rt.orchestrator = null;
    // A chat whose server went away would reattach by itself when it comes back: stop it, so only the new one runs.
    try { orchestrator.stop?.(); } catch { /* gone */ }
    if (m.orchestrator.sid) this.orchestratorSids.delete(m.orchestrator.sid);
    if (rt.stopping || m.status === "paused" || m.status === "done") return;
    this.scheduleOrchestratorRestart(m, `the orchestrator chat exited (code ${code})`);
  }

  backoff(m) { const n = Math.max(1, m.errors.consecutive); return Math.min(this.config.retryMaxMs, this.config.retryBaseMs * 2 ** (n - 1)); }

  /** A new orchestrator generation: its briefing, and before that the mission's start message (as its own turn). */
  brief(m, { rebirth = false } = {}) {
    this.enqueue(m, { type: "briefing", front: true, text: orchestratorBriefing(m, renderState(m, { workers: this.workersOf(m), now: this.now(), max: 6000 }), { rebirth }) }, { pump: false });
    if (m.startMessage) this.enqueue(m, { type: "start", front: true, text: m.startMessage }, { pump: false });
  }

  /** Queue a delivery to the orchestrator (persisted). `front` puts it before everything not yet in flight. */
  enqueue(m, { type = "event", text, front = false, ref = null } = {}, { pump = true } = {}) {
    const item = { id: this.nextId(m, "d"), type, text: String(text ?? ""), at: this.now(), ref };
    if (front) {
      const rt = this.rt.get(m.id);
      const lead = rt?.inFlight && m.queue[0]?.id === rt.inFlight ? 1 : 0;
      // The start message, then the briefing, go before everything (a new orchestrator must know the mission first);
      // other front items keep their order.
      let i = lead;
      if (type === "briefing") while (i < m.queue.length && m.queue[i].type === "start") i++;
      else if (type !== "start") while (i < m.queue.length && m.queue[i].front) i++;
      m.queue.splice(i, 0, { ...item, front: true });
    } else m.queue.push(item);
    this.save(m, { kind: "enqueue", id: item.id, type });
    if (pump) this.pump(m);
    return item;
  }

  /** Deliver the queue's head when the orchestrator is idle and no retry is pending. */
  pump(m) {
    const rt = this.runtime(m.id);
    const orchestrator = rt.orchestrator;
    if (!orchestrator || !rt.ready || rt.inFlight || rt.pumping) return;
    if (m.status === "paused" || m.status === "done" || m.status === "error") return;
    if (rt.timers.retry) return;
    if (orchestrator.streaming) return; // its status event re-pumps when the current turn ends
    const item = m.queue[0];
    if (!item) return;
    rt.pumping = true;
    try {
      rt.inFlight = item.id; rt.sawStreaming = false; rt.turnError = null; rt.sawReply = false;
      this.clearTimerOf(rt, "turn");
      rt.timers.turn = this.later(this.config.turnTimeoutMs, () => { rt.timers.turn = null; if (rt.inFlight === item.id) this.onOrchestratorTurnEnd(m, { error: "the orchestrator turn did not finish in time" }); });
      // The start message goes exactly as the user wrote it.
      const text = item.type === "start" ? item.text : clip(`[mission ${m.id}] ${item.text}`, this.config.deliverMax);
      (async () => {
        if (m.usingFallback && this.now() - (m.fallbackAt || 0) >= this.config.primaryRetryMs) await this.switchModel(m, false);
        return orchestrator.prompt(text, { echo: true });
      })().then((r) => {
        if (r && r.success === false && rt.inFlight === item.id) this.onOrchestratorTurnEnd(m, { error: r.error || "the prompt was refused" });
      }, (e) => { if (rt.inFlight === item.id) this.onOrchestratorTurnEnd(m, { error: e?.message || String(e) }); });
    } finally { rt.pumping = false; }
  }

  async switchModel(m, toFallback) {
    const rt = this.runtime(m.id);
    const target = toFallback ? m.fallbackModel : m.orchestratorModel;
    if (!target || !rt.orchestrator?.setModel) return false;
    try { await rt.orchestrator.setModel(target.provider, target.id); } catch (e) { this.log("missions: setModel failed", e?.message || e); return false; }
    m.usingFallback = !!toFallback;
    if (toFallback) m.fallbackAt = this.now();
    this.ledger(m, `orchestrator model → ${modelLabel(target)}${toFallback ? " (fallback)" : " (primary again)"}`);
    this.save(m, { kind: "orchestrator", op: "model", model: target, fallback: !!toFallback });
    return true;
  }

  /** An orchestrator turn ended: drop the delivered item, or schedule its retry (backoff, fallback, a notification). */
  onOrchestratorTurnEnd(m, { error = null } = {}) {
    const rt = this.runtime(m.id);
    const id = rt.inFlight;
    rt.inFlight = null;
    this.clearTimerOf(rt, "turn");
    if (error) {
      m.errors.consecutive++;
      m.errors.lastError = oneLine(error, 500);
      const n = m.errors.consecutive;
      if (n >= this.config.fallbackAfter && m.fallbackModel && !m.usingFallback) {
        this.switchModel(m, true).then((ok) => { if (ok) this.notify(m, { title: "Orchestrator switched to fallback model", body: `The orchestrator's model failed ${n} times in a row (last error: ${m.errors.lastError}). It now runs on ${modelLabel(m.fallbackModel)} and will try ${modelLabel(m.orchestratorModel)} again in ${fmtDur(this.config.primaryRetryMs)}. Workers keep running.`, urgency: "info" }); });
      }
      if (n >= this.config.urgentAfter && !m.errors.notifiedUrgent) {
        m.errors.notifiedUrgent = true;
        this.notify(m, { title: "Orchestrator keeps failing", body: `${n} failed orchestrator turns in a row. Last error: ${m.errors.lastError}. Workers keep running and reports are queued; it keeps retrying every ${fmtDur(this.config.retryMaxMs)}.`, urgency: "urgent" });
      }
      const delay = this.backoff(m);
      m.errors.nextRetryAt = this.now() + delay;
      this.ledger(m, `orchestrator turn failed (${n}): ${m.errors.lastError}; retry in ${fmtDur(delay)}`);
      this.save(m, { kind: "turn", ok: false, error: m.errors.lastError, retryInMs: delay });
      this.clearTimerOf(rt, "retry");
      rt.timers.retry = this.later(delay, () => { rt.timers.retry = null; this.pump(m); });
      return;
    }
    const i = m.queue.findIndex((q) => q.id === id);
    if (i >= 0) m.queue.splice(i, 1);
    m.errors.consecutive = 0; m.errors.lastError = ""; m.errors.nextRetryAt = 0; m.errors.notifiedUrgent = false;
    m.lastDeliveryAt = this.now();
    const orchestrator = rt.orchestrator;
    if (orchestrator) {
      m.orchestrator.contextUsed = Number(orchestrator.lastContext) || m.orchestrator.contextUsed || 0;
      m.orchestrator.contextWindow = Number(orchestrator.state?.model?.contextWindow) || m.orchestrator.contextWindow || 0;
    }
    this.save(m, { kind: "turn", ok: true, id });
    if (this.maybeRebirth(m)) return;
    this.pump(m);
  }

  /** Past `rebirthAt` of the orchestrator's window: a new session, briefed from the ledger. → true when it happened. */
  maybeRebirth(m) {
    const rt = this.runtime(m.id);
    const { contextUsed: used, contextWindow: win } = m.orchestrator;
    if (!rt.orchestrator || !win || !used || used / win < this.config.rebirthAt) return false;
    // A rebirth that failed is not retried after every turn: once per 30 minutes.
    if (m.orchestrator.rebirthFailedAt && this.now() - m.orchestrator.rebirthFailedAt < 30 * 60000) return false;
    const orchestrator = rt.orchestrator;
    const prev = { sessionFile: m.orchestrator.sessionFile, sessionId: m.orchestrator.sessionId, generation: m.orchestrator.generation, endedAt: this.now(), contextUsed: used };
    rt.ready = false;
    (async () => {
      await orchestrator.newSession();
      if (rt.orchestrator !== orchestrator) return; // stopped or replaced meanwhile
      m.orchestrator.previous = [...(m.orchestrator.previous || []), prev].slice(-50);
      m.orchestrator.rebirthFailedAt = 0;
      this.ledger(m, `orchestrator rebirth: generation ${prev.generation} used ${Math.round((used / win) * 100)}% of its context; a new orchestrator continues from the ledger`);
      this.bindOrchestrator(m, rt);
      m.orchestrator.sessionFile = rt.orchestrator.state?.sessionFile || null;
      m.orchestrator.sessionId = rt.orchestrator.state?.sessionId || null;
      m.orchestrator.generation++;
      m.orchestrator.contextUsed = 0;
      rt.ready = true;
      this.brief(m, { rebirth: true });
      this.pump(m);
    })().catch((e) => { m.orchestrator.rebirthFailedAt = this.now(); if (rt.orchestrator === orchestrator) rt.ready = true; this.log("missions: rebirth failed", e?.message || e); this.pump(m); });
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
    const id = this.orchestratorSids.get(ev.sid);
    if (id) {
      const m = this.get(id), rt = m && this.runtime(id);
      if (!m) return;
      if (ev.kind === "msg" && ev.role === "assistant" && rt.inFlight && ev.stopReason !== "error" && ev.stopReason !== "aborted") rt.sawReply = true;
      if (ev.kind === "msg" && ev.role === "assistant" && ev.stopReason === "error") rt.turnError = oneLine((ev.blocks || []).map((b) => b.text || "").join(" ").replace(/^Model error:\s*/, ""), 500) || "model error";
      if (ev.kind === "status" && typeof ev.streaming === "boolean") {
        if (ev.streaming) rt.sawStreaming = true;
        // A turn that ended without any reply (a stalled stream the watchdog aborted, a dropped connection) failed too.
        else if (rt.inFlight && rt.sawStreaming) this.onOrchestratorTurnEnd(m, { error: rt.turnError || (rt.sawReply ? null : "the orchestrator's turn ended without a reply") });
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
    if (kind === "pi") { const mm = asModel(want) || (m.usingFallback && m.fallbackModel ? m.fallbackModel : m.orchestratorModel); model = mm.id; provider = mm.provider; } else model = String(want || "");
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
    // The end of a worker that handed off (its successor has the task) is not a report; a later end (resumed) is.
    const h = (m.handoffs || []).find((x) => x.from === rec.id && !x.consumed && (rec.endedAt || 0) >= x.at);
    if (h) { h.consumed = true; try { this.agents.markDelivered(rec.id); } catch { /* gone */ } this.save(m); return; }
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

  async messageWorker(m, wid, text, { from = "orchestrator" } = {}) {
    this.mustWorker(m, wid);
    const t = String(text ?? "").trim();
    if (!t) throw bad("empty message");
    const r = await this.agents.message(wid, from === "user" ? `[from the user] ${t}` : `[from the orchestrator] ${t}`);
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
    const chain = (m.handoffs || []).filter((h) => rec.taskId && h.task === rec.taskId).length;
    const at = this.now();
    const next = this.agents.start({
      kind: rec.kind, task: `${brief}\n\n## Handoff from the previous worker (${rec.id})\nYou continue its task. Its notes:\n\n${clip(text, 12000)}`,
      title: rec.title, cwd: rec.cwd, agent: rec.agent || undefined, model: rec.model, provider: rec.provider,
      parentSid: `mission:${m.id}`, parentSessionId: null, depth: 0, missionId: m.id, taskId: rec.taskId, role: "worker", footer: WORKER_FOOTER, memory: true,
    });
    // Recorded only once the successor exists: a failed start leaves the worker's own report intact.
    m.handoffs = [...(m.handoffs || []), { from: rec.id, to: next.id, task: rec.taskId, at }].slice(-500);
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

  /** A worker's question to the orchestrator; resolves with the answer or a timeout note. */
  askOrchestrator(m, wid, question, { timeoutMs = this.config.questionTimeoutMs, label = "" } = {}) {
    const q = { id: this.nextId(m, "q"), worker: wid, label: label || wid, question: clip(String(question || "").trim(), 3000), at: this.now(), answer: null };
    if (!q.question) return Promise.reject(bad("empty question"));
    m.questions = [...(m.questions || []), q].slice(-500);
    this.ledger(m, `${q.label} asks ${q.id}: ${oneLine(q.question, 300)}`);
    this.enqueue(m, { type: "question", front: true, ref: q.id, text: `${q.label === wid ? `Worker ${wid}` : q.label} is blocked and asks (${q.id}):\n${q.question}\n\nAnswer with worker_message {id: "${wid}", question_id: "${q.id}", message: …}.` });
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
    this.ledger(m, `orchestrator answered ${q.id}: ${oneLine(q.answer, 300)}`);
    this.save(m, { kind: "answer", id: q.id });
    const w = this.runtime(m.id).questions.get(q.id);
    if (w) { w(q.answer); return true; }
    return false;
  }

  // ------------------------------------------------------------------ the user
  messageOrchestrator(m, text) {
    const t = String(text ?? "").trim();
    if (!t) throw bad("empty message");
    this.ledger(m, `user → orchestrator: ${oneLine(t, 300)}`);
    if (m.status === "done") { m.status = "running"; this.armHeartbeat(m); }
    this.enqueue(m, { type: "user", front: true, text: `Message from the user:\n${t}` });
    if (!this.runtime(m.id).orchestrator && this.createOrchestrator && m.status !== "paused") this.startOrchestrator(m).catch(() => {});
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
    // A start still in flight finds itself overtaken and stops the chat it made; resume() starts a new one.
    rt.startToken = (rt.startToken || 0) + 1;
    rt.starting = null;
    for (const w of this.workersOf(m)) if (ACTIVE.has(w.status)) { try { await this.agents.cancel(w.id); } catch { /* gone */ } }
    for (const k of Object.keys(rt.timers)) this.clearTimerOf(rt, k);
    const orchestrator = rt.orchestrator; rt.orchestrator = null; rt.ready = false; rt.inFlight = null;
    try { orchestrator?.stop?.(); } catch { /* gone */ }
    if (m.orchestrator.sid) this.orchestratorSids.delete(m.orchestrator.sid);
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
    if (this.createOrchestrator) await this.startOrchestrator(m);
    return m;
  }
  /**
   * Stop the mission and delete its folder (state, ledger, reports, briefs). The project's memory, knowledge graph and
   * artifacts are shared with its other missions and stay; so do the chats. A folder that cannot be deleted throws, and
   * the mission stays listed (paused).
   */
  async remove(m) {
    await this.stop(m);
    // The orchestrator could still start a worker while stop() waited for the others.
    for (const w of this.workersOf(m)) if (ACTIVE.has(w.status)) { try { await this.agents.cancel(w.id); } catch { /* gone */ } }
    this.files.get(m.id)?.remove();
    const rt = this.rt.get(m.id);
    for (const answer of [...(rt?.questions.values() || [])]) answer(null);
    for (const [sid, id] of this.orchestratorSids) if (id === m.id) this.orchestratorSids.delete(sid);
    this.missions.delete(m.id); this.files.delete(m.id); this.paths.delete(m.id); this.rt.delete(m.id);
    this.bus?.emit?.({ sid: `mission:${m.id}`, harness: "omni", kind: "mission-removed", ts: this.now(), missionId: m.id });
  }

  // ------------------------------------------------------------------ boot
  /** Load every mission; running ones get their orchestrator back and their finished-but-unreported workers delivered. */
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
        const m = migrateMission(f.read());
        if (!m?.id || m.id !== id) continue;
        this.missions.set(id, m);
        this.files.set(id, f);
        if (m.orchestrator?.sid) this.orchestratorSids.delete(m.orchestrator.sid);
        m.orchestrator = { ...m.orchestrator, sid: null };
        // A paused mission keeps its lost reports queued for when it is resumed.
        if (m.status === "paused") for (const w of this.workersOf(m).filter((x) => x.role === "worker" && FINISHED.has(x.status) && !x.delivered)) this.onAgent(w);
        if (m.status === "running" || m.status === "starting" || m.status === "waiting") {
          this.ledger(m, "Omni restarted; resuming the mission");
          m.queue = m.queue || [];
          const lost = this.workersOf(m).filter((w) => w.role === "worker" && FINISHED.has(w.status) && !w.delivered);
          this.enqueue(m, { type: "event", front: true, text: `Omni restarted. ${lost.length ? `${lost.length} worker report(s) follow (some workers may have been interrupted and can be resumed with worker_message).` : "No worker reports were lost."} Continue the mission.` }, { pump: false });
          for (const w of lost) this.onAgent(w);
          this.armHeartbeat(m);
          if (this.createOrchestrator) this.startOrchestrator(m).catch((e) => this.log("missions: orchestrator reopen failed", id, e?.message || e));
        }
      }
    }
    return this.list();
  }

  dispose({ stopOrchestrators = false } = {}) {
    this.bus?.off?.("event", this.onBus);
    this.agents?.off?.("change", this.onAgent);
    for (const rt of this.rt.values()) {
      for (const k of Object.keys(rt.timers)) this.clearTimerOf(rt, k);
      if (stopOrchestrators && rt.orchestrator) { const b = rt.orchestrator; rt.orchestrator = null; try { b.stop?.(); } catch { /* gone */ } }
    }
    for (const m of this.missions.values()) { try { this.files.get(m.id)?.write(m); } catch { /* best effort */ } }
  }
}
