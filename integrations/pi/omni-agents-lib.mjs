/**
 * Background agents and jobs for pi, the client side: the HTTP client for the Omni server's
 * `/api/agents` routes, the chunked wait loops, the report text, and the delivery poller that
 * wakes the chat when a background agent finishes. Shared by omni-agents.ts (agent_* / job_* tools)
 * and omni-claude.ts (claude_task). Plain ESM, no pi imports, so the tests drive it directly.
 *
 * Every blocking request stays ≤ 240 s (CHUNK_SEC), and under pi's own `httpIdleTimeoutMs`
 * (chunkSecFor): pi's HTTP client gives up on a response whose headers take longer, which is what
 * killed the old 15-minute blocking claude_task.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CHUNK_SEC = 240;

/**
 * The longest wait per request under pi's HTTP headers timeout (`httpIdleTimeoutMs`; unset = pi's
 * 300 s default, 0 = disabled): 15 s of margin, half the timeout when that is short, never above 240 s.
 */
export function chunkSecFor(timeoutMs = 300000) {
  const sec = Number(timeoutMs) / 1000;
  if (!Number.isFinite(sec) || sec <= 0) return CHUNK_SEC;
  return Math.max(1, Math.min(CHUNK_SEC, Math.floor(Math.max(sec / 2, sec - 15))));
}

/** pi's `httpIdleTimeoutMs` as pi reads it: its settings.json (PI_CODING_AGENT_DIR or ~/.pi/agent), the project's .pi/settings.json over it. */
export function piHttpTimeoutMs({ home = homedir(), env = process.env, cwd = process.cwd() } = {}) {
  const dir = env.PI_CODING_AGENT_DIR ? env.PI_CODING_AGENT_DIR.replace(/^~(?=$|[\\/])/, home) : join(home, ".pi", "agent");
  let v;
  for (const f of [join(dir, "settings.json"), join(cwd, ".pi", "settings.json")]) {
    try { const s = JSON.parse(readFileSync(f, "utf8")); if (s?.httpIdleTimeoutMs !== undefined) v = s.httpIdleTimeoutMs; } catch { /* not there */ }
  }
  if (typeof v === "string") v = v.trim().toLowerCase() === "disabled" ? 0 : v.trim() ? Number(v) : undefined;
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined;
}
/** A finished agent's result text in a tool result (agent_wait / claude_task). */
export const MAX_RESULT = 20000;
/** The whole wake-up message the poller posts into the chat. */
export const MAX_REPORT = 12000;
export const FINISHED = new Set(["done", "error", "cancelled", "timeout", "interrupted", "stalled"]);
export const isFinished = (rec) => FINISHED.has(rec?.status);

/**
 * The Omni server on this computer: `~/.pi/agent/omni-agent.json` `port` (same file as the other
 * extensions), unless the server that spawned this pi said where it listens (OMNI_AGENT_URL).
 */
export function omniBase(home = homedir(), env = process.env) {
  if (/^https?:\/\/[^\s/]+$/.test(String(env.OMNI_AGENT_URL || "").replace(/\/+$/, ""))) return env.OMNI_AGENT_URL.replace(/\/+$/, "");
  const p = join(home, ".pi", "agent", "omni-agent.json");
  let cfg = {};
  if (existsSync(p)) { try { cfg = JSON.parse(readFileSync(p, "utf8")) || {}; } catch { cfg = {}; } }
  return `http://127.0.0.1:${Number(cfg.port) || 4400}`;
}

/** Who is asking: this chat's session, its Omni sid, and how deep in an agent tree this pi runs. */
export function identity(ctx, env = process.env) {
  let id = "";
  try { id = String(ctx?.sessionManager?.getSessionId?.() || ""); } catch { id = ""; }
  const depth = Number(env.OMNI_AGENT_DEPTH || 0);
  return { parentSessionId: id, parentSid: id ? `pi:${id}` : null, depth: Number.isFinite(depth) && depth > 0 ? Math.floor(depth) : 0 };
}

export const clip = (s, max) => (s.length > max ? `${s.slice(0, max)}\n… (${s.length - max} more characters truncated)` : s);
export const oneLine = (s, n) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
export const titleFor = (text) => oneLine(text, 60);
const toMs = (v) => (typeof v === "number" ? v : v ? Date.parse(v) : NaN);

export function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

/** Run time so far (or in total once finished); "" while it has not started. */
export function elapsedOf(rec, now = Date.now()) {
  const start = toMs(rec?.startedAt);
  if (!Number.isFinite(start)) return "";
  const end = toMs(rec.endedAt);
  return fmtDuration((Number.isFinite(end) ? end : now) - start);
}

export const kindLabel = (kind) => (kind === "claude" ? "Claude agent" : kind === "shell" ? "job" : "pi agent");
const statusText = (rec) => `${rec.status}${rec.kind === "shell" && rec.exitCode != null ? ` (exit ${rec.exitCode})` : ""}`;

/** One line per agent: id · kind · status · elapsed · title — last activity. */
export function statusLine(rec, now = Date.now()) {
  const el = elapsedOf(rec, now);
  const last = rec.activity?.length ? ` — last: ${oneLine(rec.activity.at(-1), 120)}` : "";
  return `${rec.id} · ${kindLabel(rec.kind)} · ${statusText(rec)}${el ? ` · ${el}` : ""} · ${oneLine(rec.title || rec.task || rec.command, 80)}${last}`;
}

/** agent_status for one agent: the status line, what it was given, its recent activity, a result preview. */
export function describeAgent(rec, now = Date.now()) {
  const lines = [statusLine(rec, now)];
  const what = rec.kind === "shell" ? rec.command : rec.task;
  if (what) lines.push(`${rec.kind === "shell" ? "command" : "task"}: ${oneLine(what, 300)}`);
  const where = [rec.cwd && `cwd ${rec.cwd}`, rec.model && `model ${rec.model}`, rec.agent && `persona ${rec.agent}`, rec.sessionId && `session ${rec.sessionId}`].filter(Boolean);
  if (where.length) lines.push(where.join(" · "));
  if (rec.toolCalls || rec.turns) lines.push(`${rec.toolCalls || 0} tool calls · ${rec.turns || 0} turns${rec.cost ? ` · $${Number(rec.cost).toFixed(3)}` : ""}`);
  if (rec.activity?.length) lines.push("recent activity:", ...rec.activity.slice(-8).map((l) => `  - ${oneLine(l, 160)}`));
  if (rec.error) lines.push(`error: ${oneLine(rec.error, 400)}`);
  if (isFinished(rec) && rec.resultText) lines.push("", `result${rec.delivered ? "" : " (not reported yet)"}:`, clip(String(rec.resultText), 1500));
  return lines.join("\n");
}

/** A claude agent's session footer, in claude_task's old format. */
export function claudeFooter(rec) {
  const turns = Number(rec.turns) || 0;
  const err = rec.status === "error" ? " · ended with an error" : "";
  return `[claude session ${rec.sessionId || "?"} · ${turns} turn${turns === 1 ? "" : "s"} · $${Number(rec.cost || 0).toFixed(3)}${err} — pass resume="${rec.sessionId || ""}" to continue]`;
}

/**
 * A finished agent's report: a header line (kind, id, title, status, run time, error), then its result
 * (a job's log tail), then how to follow up. The whole text is ≤ `max` characters; or, with
 * `resultMax`, the result alone is ≤ resultMax (a tool result: agent_wait).
 */
export function agentReport(rec, { max = MAX_REPORT, resultMax, now = Date.now(), hint = true } = {}) {
  const el = elapsedOf(rec, now);
  const head = `${rec.kind === "shell" ? "Background job" : `Background ${kindLabel(rec.kind)}`} ${rec.id} "${oneLine(rec.title || rec.task || rec.command, 80)}" finished: ${statusText(rec)}${el ? ` after ${el}` : ""}.`
    + (rec.error ? `\nError: ${oneLine(rec.error, 400)}` : "");
  const tail = !hint ? "" : rec.kind === "shell" ? "" : rec.kind === "claude" ? `\n\n${claudeFooter(rec)} (or agent_message ${rec.id})` : `\n\n(agent_message ${rec.id} to send it a follow-up)`;
  const label = rec.kind === "shell" ? "Log tail:\n" : "";
  const body = String(rec.resultText || "").trim() || (rec.kind === "shell" ? "(no output)" : "(no report text)");
  const room = resultMax ?? Math.max(200, max - head.length - tail.length - label.length - 64);
  return `${head}\n\n${label}${clip(body, room)}${tail}`;
}

/** The Omni server's agent routes. Errors: `.unreachable` (no server), `.status` (an HTTP error, server's message). */
export class AgentsClient {
  /** `chunkSec`: the longest wait per request (chunkSecFor(piHttpTimeoutMs()) in pi). */
  constructor({ base, fetch: f = globalThis.fetch, quickTimeoutMs = 20000, chunkSec = CHUNK_SEC } = {}) {
    this.base = base || omniBase();
    this.fetch = f;
    this.quickTimeoutMs = quickTimeoutMs;
    this.chunkSec = chunkSec;
  }

  async request(method, path, body, { signal, timeoutMs } = {}) {
    const guard = AbortSignal.timeout(timeoutMs ?? this.quickTimeoutMs);
    const sig = signal ? AbortSignal.any([signal, guard]) : guard;
    let r;
    try {
      r = await this.fetch(`${this.base}${path}`, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined, signal: sig });
    } catch (e) {
      if (signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError", aborted: true });
      const why = guard.aborted ? "no answer in time" : e?.cause?.code || e?.message || String(e);
      throw Object.assign(new Error(`Omni Agent is not reachable on ${this.base} (${why}). Start it, then retry.`), { unreachable: true });
    }
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j?.error) throw Object.assign(new Error(String(j?.error || `HTTP ${r.status} from ${path}`)), { status: r.status });
    return j || {};
  }

  /** A start may wait for a free slot's process to spawn: more time than the quick calls. */
  start(spec) { return this.request("POST", "/api/agents", spec, { timeoutMs: 60000 }).then((j) => j.agent); }
  list({ parentSessionId, parentSid, active } = {}) {
    const q = new URLSearchParams();
    if (parentSid) q.set("parent", parentSid);
    if (parentSessionId) q.set("parentSession", parentSessionId);
    if (active) q.set("active", "1");
    return this.request("GET", `/api/agents${q.size ? `?${q}` : ""}`).then((j) => j.agents || []);
  }
  get(id) { return this.request("GET", `/api/agents/${encodeURIComponent(id)}`).then((j) => j.agent); }
  undelivered(parentSessionId) { return this.request("GET", `/api/agents/undelivered?parentSession=${encodeURIComponent(parentSessionId)}`).then((j) => j.agents || []); }
  wait({ ids, parentSessionId, undeliveredOnly = false, timeoutSec = this.chunkSec }, signal) {
    const body = { ...(ids?.length ? { ids } : {}), ...(parentSessionId ? { parentSessionId } : {}), undeliveredOnly, timeoutSec };
    return this.request("POST", "/api/agents/wait", body, { signal, timeoutMs: (timeoutSec + 30) * 1000 })
      .then((j) => ({ finished: j.finished || [], pending: j.pending || [] }));
  }
  log(id, tail = 80) { return this.request("GET", `/api/agents/${encodeURIComponent(id)}/log?tail=${Math.max(1, Math.floor(tail) || 80)}`).then((j) => String(j.text ?? "")); }
  waitLog(id, { until, timeoutSec = this.chunkSec }, signal) {
    return this.request("POST", `/api/agents/${encodeURIComponent(id)}/wait-log`, { ...(until ? { until } : {}), timeoutSec }, { signal, timeoutMs: (timeoutSec + 30) * 1000 });
  }
  message(id, text) { return this.request("POST", `/api/agents/${encodeURIComponent(id)}/message`, { text }); }
  cancel(id) { return this.request("POST", `/api/agents/${encodeURIComponent(id)}/cancel`, {}).then((j) => j.agent); }
  delivered(id) { return this.request("POST", `/api/agents/${encodeURIComponent(id)}/delivered`, {}).then((j) => !!j.ok); }
}

const sleepFor = (ms, signal) => new Promise((resolve) => {
  if (signal?.aborted) return resolve();
  const t = setTimeout(done, ms);
  t.unref?.();
  function done() { clearTimeout(t); signal?.removeEventListener?.("abort", done); resolve(); }
  signal?.addEventListener?.("abort", done, { once: true });
});

/**
 * Repeat `call(timeoutSec)` in ≤ chunkSec requests until `settle(answer)` returns a result, the time
 * is up (`timedOut`) or `signal` aborts (`aborted`); the last answer is spread into those two. An
 * unreachable server is retried after `retryMs`; three failures in a row throw.
 */
async function chunkedWait(call, settle, { timeoutMs, signal, onChunk, chunkSec = CHUNK_SEC, now = Date.now, sleep = sleepFor, retryMs = 5000 }, initial) {
  const t0 = now();
  const deadline = t0 + timeoutMs;
  let last = initial;
  let fails = 0;
  for (;;) {
    if (signal?.aborted) return { ...last, aborted: true };
    const left = deadline - now();
    if (left <= 0) return { ...last, timedOut: true };
    const timeoutSec = Math.max(1, Math.min(chunkSec, Math.ceil(left / 1000)));
    const started = now();
    try {
      last = await call(timeoutSec);
      fails = 0;
    } catch (e) {
      if (signal?.aborted || e?.aborted) return { ...last, aborted: true };
      if (!e?.unreachable || ++fails >= 3) throw e;
      await sleep(Math.min(retryMs, Math.max(0, deadline - now())), signal);
      continue;
    }
    const out = settle(last);
    if (out) return out;
    onChunk?.({ ...last, elapsedMs: now() - t0, leftMs: Math.max(0, deadline - now()) });
    // A server that answers early without a result must not turn this into a busy loop.
    if (now() - started < 1000) await sleep(1000, signal);
  }
}

/**
 * Wait until a selected agent finishes (`ids`, or the chat's `parentSessionId` agents).
 * → { finished, pending, timedOut?, aborted?, empty? } (`empty`: nothing selected is running or finished).
 */
export const waitAgents = (client, { ids, parentSessionId, undeliveredOnly = false, signal, ...opts }) => chunkedWait(
  (timeoutSec) => client.wait({ ids, parentSessionId, undeliveredOnly, timeoutSec }, signal),
  (r) => (r.finished.length ? r : r.pending.length ? null : { ...r, empty: true }),
  { signal, chunkSec: client.chunkSec ?? CHUNK_SEC, ...opts }, { finished: [], pending: [] },
);

/** Wait until a job's log matches `until` (a regex string) or the job finishes. → { matched, status, tail, timedOut?, aborted? } */
export const waitJob = (client, { id, until, signal, ...opts }) => chunkedWait(
  (timeoutSec) => client.waitLog(id, { until, timeoutSec }, signal).then((r) => ({ matched: !!r.matched, status: String(r.status || ""), tail: String(r.tail ?? "") })),
  (r) => (r.matched || FINISHED.has(r.status) ? r : null),
  { signal, chunkSec: client.chunkSec ?? CHUNK_SEC, ...opts }, { matched: false, status: "", tail: "" },
);

/** State shared by every copy of this module in the pi process (omni-agents.ts and omni-claude.ts, reloads). */
const S = (globalThis.__omniAgents ??= { pollers: new Map(), pauses: new Map(), claimed: new Set() });
/**
 * Reports posted into the chat but not yet in it: id → { key, at }. pi.sendMessage only queues a report while the
 * chat is busy, and that queue is lost on Stop (clear_queue), a stall kill, a crash or a restart, so a report is
 * acked as delivered only when its message_end shows it reached the session (confirmDelivered).
 */
S.pendingAck ??= new Map();

/**
 * Where this pi's turn is, from its extension events: what a wake-up message (an agent's report, a late MCP result)
 * may do. pi's prompt() checks it is idle, then awaits auth, compaction and every before_agent_start hook before it
 * claims the run; a sendMessage(triggerTurn) in that window starts a second run, and the loser's cleanup clears pi's
 * busy flag while the winner streams. From then on every wake-up throws "Agent is already processing a prompt", each
 * throw emits a false agent_settled (Omni's keeper reads it as "the turn ended" and prompts again) and queued
 * messages are dropped. And a report queued as a follow-up after Stop is run by pi as soon as the aborted run ends.
 * So a wake-up triggers a turn only when no prompt is starting and the user has not stopped the chat; otherwise it
 * goes into the chat quietly (the starting turn, or the user's next one, sees it).
 */
export const PROMPT_START_MAX_MS = 10 * 60 * 1000;
const T = (globalThis.__omniTurn ??= {});
/** Forget everything (a new session; tests). */
export function resetTurn() { Object.assign(T, { running: false, startingAt: 0, stopped: false }); }
if (T.running === undefined) resetTurn();

/** Feed one pi extension event (input, agent_start, agent_end, agent_settled, session_start). */
export function onTurnEvent(type, event, ctx, now = Date.now()) {
  switch (type) {
    case "input": T.startingAt = now; T.stopped = false; break;
    case "agent_start": {
      T.running = true; T.startingAt = 0;
      // Stop aborts this signal before pi releases any tool, so a poller let go by an aborted job_wait already sees it.
      const signal = ctx?.signal;
      if (signal?.aborted) T.stopped = true;
      else signal?.addEventListener?.("abort", () => { T.stopped = true; }, { once: true });
      break;
    }
    case "agent_end": {
      const last = [...(event?.messages || [])].reverse().find((m) => m?.role === "assistant");
      if (last?.stopReason === "aborted") T.stopped = true;
      break;
    }
    case "agent_settled": T.running = false; T.startingAt = 0; break;
    case "session_start": resetTurn(); break;
  }
}

/** sendMessage options for a wake-up message right now. */
export function wakeOptions(now = Date.now()) {
  const starting = T.startingAt > 0 && now - T.startingAt < PROMPT_START_MAX_MS;
  if (T.stopped || (starting && !T.running)) return { triggerTurn: false };
  return { triggerTurn: true, deliverAs: "followUp" };
}
// omni-mcp.ts posts late tool results too; it reads this without importing the lib.
T.wakeOptions = wakeOptions;

/** The report's message_end arrived (it is in the session now): forget the pending entry. → true if it was pending. */
export function confirmDelivered(id) { return S.pendingAck.delete(id); }
export const pendingAck = (id) => S.pendingAck.get(id) || null;

/**
 * Claim a finished agent's report for delivery: true once per run, so a result never reaches the chat
 * twice. Keyed by id + endedAt: an agent resumed by agent_message finishes again with a new report.
 */
const claimKey = (rec) => `${rec.id}@${rec.endedAt ?? ""}`;
export function claim(rec) {
  const key = claimKey(rec);
  if (S.claimed.has(key)) return false;
  S.claimed.add(key);
  return true;
}
/** Give a claim back: the report never reached the chat. */
export function unclaim(rec) { S.claimed.delete(claimKey(rec)); }

/** Hold the session's poller while a tool waits itself (agent_wait, job_wait, claude_task); → release(). */
export function pausePoller(sessionId) {
  if (!sessionId) return () => {};
  S.pauses.set(sessionId, (S.pauses.get(sessionId) || 0) + 1);
  S.pollers.get(sessionId)?.nudge();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const n = (S.pauses.get(sessionId) || 1) - 1;
    if (n > 0) S.pauses.set(sessionId, n); else S.pauses.delete(sessionId);
    S.pollers.get(sessionId)?.nudge();
  };
}

export const pollerFor = (sessionId) => S.pollers.get(sessionId);

/**
 * One per chat: long-polls `/api/agents/wait {undeliveredOnly}` and posts every finished agent's
 * report into the chat (`deliver`), then acks it as delivered. Ends when nothing of the chat's is
 * running or undelivered, on stop(), on a client error (4xx: an Omni without these routes), or when
 * `deliver` throws (a stale pi after a session switch: the report stays undelivered for the next one).
 * An unreachable server is retried with back-off (minBackoffMs → maxBackoffMs), never thrown.
 */
export class DeliveryPoller {
  /**
   * `isIdle` → whether the chat is idle (a posted report still not in it then was dropped); `ackTimeoutMs` → how long a
   * posted report may wait for its message_end before an idle chat gets it again.
   */
  constructor({ client, parentSessionId, deliver, owner = null, log = () => {}, chunkSec, minBackoffMs = 5000, maxBackoffMs = 60000, idleMs = 1000, pendingNapMs = 3000, ackTimeoutMs = 60000, isIdle = () => false, now = Date.now, sleep = sleepFor }) {
    Object.assign(this, { client, parentSessionId, deliver, owner, log, chunkSec: chunkSec ?? client?.chunkSec ?? CHUNK_SEC, minBackoffMs, maxBackoffMs, idleMs, pendingNapMs, ackTimeoutMs, isIdle, now, sleepImpl: sleep });
    this.stopped = false;
    this.running = false;
    this.inflight = null;
    this.napper = null;
    this.done = Promise.resolve();
  }

  get paused() { return (S.pauses.get(this.parentSessionId) || 0) > 0; }

  start() {
    if (this.running || this.stopped) return this;
    this.running = true;
    this.done = this.#loop().catch((e) => this.log(`agent poller: ${e?.message || e}`)).finally(() => {
      this.running = false;
      this.stopped = true;
      if (S.pollers.get(this.parentSessionId) === this) S.pollers.delete(this.parentSessionId);
    });
    return this;
  }

  stop() { this.stopped = true; this.nudge(); }

  /** Cut the current request / nap short (a pause, a release, a stop). */
  nudge() { this.inflight?.abort(); this.napper?.abort(); }

  async #nap(ms) {
    const ac = new AbortController();
    this.napper = ac;
    try { await this.sleepImpl(ms, ac.signal); } finally { if (this.napper === ac) this.napper = null; }
  }

  async #loop() {
    let backoff = this.minBackoffMs;
    while (!this.stopped) {
      if (this.paused) { await this.#nap(60000); continue; }
      const ac = new AbortController();
      this.inflight = ac;
      let r;
      try {
        r = await this.client.wait({ parentSessionId: this.parentSessionId, undeliveredOnly: true, timeoutSec: this.chunkSec }, ac.signal);
      } catch (e) {
        if (this.stopped) break;
        if (ac.signal.aborted) continue;
        if (!e?.unreachable && e?.status && e.status < 500) { this.log(`agent poller stopped: ${e.message}`); break; }
        await this.#nap(backoff);
        backoff = Math.min(backoff * 2, this.maxBackoffMs);
        continue;
      } finally { if (this.inflight === ac) this.inflight = null; }
      backoff = this.minBackoffMs;
      // A tool started waiting meanwhile: it reports these itself.
      if (this.stopped || this.paused) continue;
      let fresh = 0, waiting = 0;
      for (const rec of r.finished) {
        // Stopped or held while acking the one before: the rest is left undelivered (the waiting tool gets it).
        if (this.stopped || this.paused) break;
        const pend = S.pendingAck.get(rec.id);
        if (pend && pend.key === claimKey(rec)) {
          // Posted, not in the chat yet (queued behind a busy run). An idle chat without it lost it: post it again now.
          if (!(this.now() - pend.at > this.ackTimeoutMs && this.isIdle())) { waiting++; continue; }
          S.pendingAck.delete(rec.id); unclaim(rec);
          this.log(`agent report ${rec.id} never reached the chat; posting it again`);
        }
        if (claim(rec)) {
          try { this.deliver(rec); } catch (e) {
            unclaim(rec);
            this.log(`agent poller stopped: posting ${rec.id} failed: ${e?.message || e}`);
            this.stopped = true;
            break;
          }
          // Acked when its message_end shows it reached the session (confirmDelivered), not now.
          S.pendingAck.set(rec.id, { key: claimKey(rec), at: this.now() });
          fresh++;
          continue;
        }
        // Claimed by a tool that already showed it to the model (agent_wait, job_wait, claude_task): ack it.
        try { await this.client.delivered(rec.id); } catch { /* acked on the next round */ }
      }
      if (this.stopped) break;
      if (!r.finished.length && !r.pending.length) break;
      if (waiting) await this.#nap(this.pendingNapMs);
      else if (r.finished.length && !fresh) await this.#nap(this.idleMs);
    }
  }
}

/** The session's poller, started if none runs. `pi` posts the reports (wakeOptions: followUp + triggerTurn wakes an idle chat). */
export function ensurePoller({ client, parentSessionId, pi, owner = pi, log, isIdle, ...opts }) {
  if (!parentSessionId) return null;
  const have = S.pollers.get(parentSessionId);
  if (have && !have.stopped) return have;
  const p = new DeliveryPoller({
    client, parentSessionId, owner, log, ...opts, ...(isIdle ? { isIdle } : {}),
    deliver: (rec) => pi.sendMessage(
      { customType: "omni-agent-result", content: agentReport(rec, { max: MAX_REPORT }), display: true, details: { id: rec.id, status: rec.status } },
      wakeOptions(),
    ),
  });
  S.pollers.set(parentSessionId, p);
  return p.start();
}

/** Stop the pollers an extension instance started (its session is shutting down). */
export function stopPollers(owner) {
  for (const [sid, p] of S.pollers) if (!owner || p.owner === owner) { p.stop(); S.pollers.delete(sid); }
}

/** On session start: resume delivery when the server still has this chat's agents running or undelivered. */
export async function resumeDelivery({ client, parentSessionId, pi, owner = pi, log, ...opts }) {
  if (!parentSessionId) return null;
  const [active, undelivered] = await Promise.all([client.list({ parentSessionId, active: true }), client.undelivered(parentSessionId)]);
  if (!active.length && !undelivered.length) return null;
  return ensurePoller({ client, parentSessionId, pi, owner, log, ...opts });
}
