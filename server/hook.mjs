/**
 * Goal hook: keeps Omni's pi chat going the way Claude Code's Stop hook does — driven by the agent's own plan.
 *
 * The agent plans with the `plan` tool (integrations/pi/omni-plan.ts, state machine in ui/plan.js):
 * brainstorm → milestones of steps with "done when" checks → execute step by step. Every plan change
 * arrives on the RPC stream as the tool result's details, so when pi really stops (`agent_settled`) the
 * keeper knows without asking any model whether the work is finished:
 *   unfinished steps        → re-engage at once with the current step and its check (a wrapped prompt,
 *                             `<omni-hook …>`, shown in the UI as a one-line notice)
 *   every step done         → the goal is done (latched; never re-engaged for it again)
 *   plan waits on the user  → stay quiet until the user answers (`ask_user`)
 *   an explicit /goal and no plan yet → re-engage: brainstorm and write the plan first
 * Work without a plan (a quick task the agent chose not to plan) ends when the agent stops normally; if
 * it used tools, it is first asked once to either confirm it is finished or plan the rest. The old judge
 * model is only an opt-in fallback for that case (`judgeFallback`).
 *
 * Stops that are not the agent's choice are handled on their own, before the plan is looked at:
 *   output limit (`length`, typically a long think)  → re-engage, telling it to think briefly and act
 *   provider unavailable (5xx, 429, timeouts)       → retry after a growing back-off instead of piling nudges
 *   the request rejected (e.g. 400: context too long or a malformed tail) → compact, then retry; pause the
 *                                                    goal if it keeps failing after that
 *
 * Status box: written by a separate summarizer — its own side conversation (`pi -p` on a dedicated
 * session per goal), never the agent's chat — and only when the plan moves: plan written or revised, a
 * milestone reached, the plan finished. The plan itself is broadcast on every change (`plan` event) so
 * the box's checklist is always current without any model call.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { hookInfo, hookMessage } from "../ui/lib.js";
import { PLAN_TOOL, asPlan, clearWaiting, currentStep, latestPlan, planNudge, planProgress, renderPlan } from "../ui/plan.js";

export const JUDGE_SYSTEM = `A coding agent working on a user's request has just stopped. You get the request and the most recent part of the agent's work. Decide only whether the request is finished; do not plan or direct the work.
It is finished when the request is complete, when the agent asked the user something only the user can answer (a choice, a credential, a confirmation for a destructive step), or when the task is genuinely impossible and it said so.
It is NOT finished when the agent stopped part-way: it only described a plan, said what it will do next ("next I will…", "let me know if…"), stopped after an error it could retry or work around, ended abruptly (an error, a length limit), or left part of the request untouched.
Reply with exactly one JSON object and nothing else:
{"done": true or false, "reason": "one short sentence: why it is finished, or which part of the request is still not done"}`;

export const SUMMARY_SYSTEM = `You keep a tiny status box for someone watching a coding agent work toward a goal. You are a separate observer, not the agent: never address the agent, never give instructions.
Each message brings the goal, the agent's plan with its progress, what just happened (plan written, milestone reached, plan finished…) and the agent's recent work. Reply with 2 to 4 short sentences, plain text, no preamble, no markdown headings: where the goal stands, what was achieved in the milestone that was just reached (be concrete: files, results, findings), and what comes next. Do not list the plan steps; the box already shows them.`;

const clip = (s, n) => { const t = String(s ?? ""); return t.length > n ? `${t.slice(0, n)}…` : t; };

/** What a plan event means for the status box (null: not worth a summary). */
const SUMMARY_REASON = { created: "the agent wrote its plan", revised: "the agent revised its plan", milestone_done: "a milestone was reached", plan_done: "every step of the plan is done" };

/**
 * The summarizer's message — the goal, the plan, what just happened and only the work since the previous
 * status, within a budget (tool results are the bulk of the tail, so they are clipped hard). Pure.
 */
export function buildSummaryInput({ goal, tail = [], previous = "", plan = null, reason = "" }, { maxChars = 3500 } = {}) {
  let work = [];
  let used = 0;
  for (let i = tail.length - 1; i >= 0; i--) { const line = clip(tail[i], 300); if (used + line.length > maxChars && work.length) break; work.unshift(line); used += line.length; }
  if (!work.length) work = ["(no new work since the previous status)"];
  return [
    "Goal:",
    "<goal>",
    clip(goal, previous ? 600 : 1500),
    "</goal>",
    ...(plan ? ["", "The agent's plan ([x] done, [>] in progress, [-] skipped):", "<plan>", renderPlan(plan, { maxChars: 2500 }), "</plan>"] : []),
    ...(reason ? ["", `What just happened: ${reason}.`] : []),
    ...(previous ? ["", "Previous status:", "<status>", clip(previous, 800), "</status>"] : []),
    "",
    `${previous ? "Work since the previous status" : "Work so far"} (most recent last${tail.length > work.length ? ", earlier steps omitted" : ""}):`,
    "<work>",
    ...work,
    "</work>",
    "",
    "Write the 2-4 sentence status box now.",
  ].join("\n");
}

/** The text the (opt-in) judge reads. Pure, so it is testable. */
export function buildJudgeInput({ goal, tail = [], nudges = 0, stopReason = "" }, { maxChars = 6000 } = {}) {
  let work = [];
  let used = 0;
  for (let i = tail.length - 1; i >= 0; i--) { const line = tail[i]; if (used + line.length > maxChars && work.length) break; work.unshift(line); used += line.length; }
  if (!work.length) work = ["(the agent produced nothing)"];
  // The framing repeats the role on purpose: small models otherwise answer *as* the user or the agent.
  return [
    "You are the checker. You are not the agent and not the user. Do not reply to the material below; judge it.",
    "",
    "User's request:",
    "<request>",
    clip(goal, 4000),
    "</request>",
    "",
    `What the agent did since, most recent last${tail.length > work.length ? " (earlier steps omitted)" : ""}:`,
    "<agent-work>",
    ...work,
    "</agent-work>",
    "",
    `The agent stopped${stopReason ? ` (stop reason: ${stopReason})` : ""}. Times it was already told to continue on this request: ${nudges}.`,
    "",
    'Is the request finished? Answer now with exactly one JSON object and no other text: {"done": true or false, "reason": "..."}',
  ].join("\n");
}

/** First JSON object in the judge's reply → `{ done, reason }`, or null when unusable. */
export function parseVerdict(text) {
  const s = String(text ?? "");
  const start = s.indexOf("{");
  if (start < 0) return null;
  for (let end = s.lastIndexOf("}"); end > start; end = s.lastIndexOf("}", end - 1)) {
    try {
      const j = JSON.parse(s.slice(start, end + 1));
      if (typeof j?.done !== "boolean") return null;
      return { done: j.done, reason: clip(j.reason || "", 300) };
    } catch { /* try a shorter slice */ }
  }
  return null;
}

/** One line of the transcript tail from a live omni `msg` event; null when there is nothing worth keeping. */
export function tailLine(ev) {
  if (ev.kind !== "msg") return null;
  if (ev.role === "assistant") {
    const parts = [];
    for (const b of ev.blocks || []) {
      if (b.type === "text" && b.text?.trim()) parts.push(`assistant: ${clip(b.text.trim(), 900)}`);
      else if (b.type === "tool_call") parts.push(`tool call ${b.name}(${clip(JSON.stringify(b.args ?? {}), 240)})`);
    }
    if (ev.stopReason && ev.stopReason !== "toolUse" && ev.stopReason !== "stop") parts.push(`(assistant message ended: ${ev.stopReason})`);
    return parts.length ? parts.join("\n") : null;
  }
  if (ev.role === "tool") {
    return (ev.blocks || []).filter((b) => b.type === "tool_result").map((b) => `${b.isError ? "tool error" : "tool result"} ${b.name || ""}: ${clip((b.text || "").trim(), 400)}${b.images?.length ? ` [${b.images.length} image(s)]` : ""}`).join("\n") || null;
  }
  return null;
}

/**
 * Ask a model through `pi -p` (no tools, no extensions) and resolve with its text. With `conversation`
 * ({ dir, id }) the call continues that side conversation's own session file, so a summarizer keeps its
 * memory across calls; without it the call is ephemeral (`--no-session`).
 * `cli` is pi's dist/cli.js (run with the current node); `bin` is the fallback launcher.
 */
export function runJudge({ cli, bin = "pi", provider, model, env = {}, cwd, spawn = nodeSpawn, timeoutMs = 120000, conversation = null }, { system, input }) {
  return new Promise((resolve, reject) => {
    const session = conversation?.dir && conversation?.id ? ["--session-dir", conversation.dir, "--session-id", conversation.id] : ["--no-session"];
    const args = ["-p", "--no-tools", "--no-extensions", "--no-skills", ...session, "--no-context-files", "--no-prompt-templates", "--thinking", "off", "--system-prompt", system];
    if (provider) args.push("--provider", provider);
    if (model) args.push("--model", model);
    const full = { ...process.env, ...env };
    const proc = cli
      ? spawn(process.execPath, [cli, ...args], { cwd, env: full, windowsHide: true })
      : spawn(process.platform === "win32" ? `${bin}.cmd` : bin, args, { cwd, env: full, shell: process.platform === "win32", windowsHide: true });
    let out = "", err = "";
    const timer = setTimeout(() => { try { proc.kill(); } catch { /* */ } reject(new Error("judge timed out")); }, timeoutMs);
    proc.stdout.setEncoding("utf8"); proc.stdout.on("data", (c) => { out += c; });
    proc.stderr.setEncoding("utf8"); proc.stderr.on("data", (c) => { err += c; });
    proc.on("error", (e) => { clearTimeout(timer); reject(e); });
    proc.on("exit", (code) => { clearTimeout(timer); if (code === 0 || out.trim()) resolve(out); else reject(new Error(err.trim().split("\n").pop() || `judge exited with code ${code}`)); });
    proc.stdin.on("error", () => {});
    proc.stdin.end(input);
  });
}

/**
 * A plain "keep going" for work without a plan (the plan path uses planNudge from ui/plan.js). Kept short
 * on purpose: it is persisted in the chat and re-read on every later turn. The goal is repeated verbatim
 * only when `restate` is set.
 */
export function nudgeBody({ goal, reason = "", escalate = false, attempts = 0, restate = false }) {
  const head = escalate
    ? `You stopped again on the same problem (${attempts} times). Do not repeat what failed: try a DIFFERENT APPROACH, or set that part aside (note it as blocked) and continue with the rest of the goal.`
    : `You stopped, but the goal is not finished yet${reason ? `: ${reason}` : "."}`;
  const parts = [head];
  if (restate) parts.push(`The original goal, verbatim:\n${goal}`);
  parts.push(`Continue working on your own until the whole goal is done: carry on through the remaining steps without stopping to report progress or to ask whether to continue. Do not recap or summarize progress (a separate status summary is kept for the user). Stop only when the goal is completely done, or when you truly need something only the user can provide.`);
  return parts.join("\n\n");
}

/** The last assistant message ended some other way than a normal finish (an error, a length limit, a dropped tool call). */
export const stoppedAbnormally = (stopReason) => !!stopReason && stopReason !== "stop";

/** A provider/network failure that clears up by itself (retry later) rather than a request the provider refuses. */
export const transientError = (text) => /\b(5\d\d|429)\b|overload|unavailable|no upstream|rate.?limit|too many requests|timed? ?out|timeout|ECONN|ETIMEDOUT|EAI_AGAIN|socket|network|fetch failed|terminated|unloaded/i.test(String(text ?? ""));

/** Back-off before retrying after the n-th consecutive transient error (1-based). */
export const errorBackoff = (n, { base = 15000, cap = 600000 } = {}) => Math.min(cap, base * 2 ** Math.max(0, n - 1));

export const LENGTH_NOTE = "Your last reply was cut off by the output-token limit (stop reason: length) — most likely a long think — before you acted. Keep your reasoning short now and make the next tool call right away; split big outputs (long files, big edits) into smaller pieces.";

/** A short signature of the current failure/tail so the keeper can detect "stuck on the same thing". */
export function fingerprint(tail = []) {
  const last = [...tail].reverse().find((l) => /error|fail|undefined|cannot|exception/i.test(l)) || tail.at(-1) || "";
  return String(last).replace(/0x[0-9a-f]+|\d+/gi, "#").replace(/\s+/g, " ").trim().slice(0, 160);
}

export class GoalKeeper {
  /**
   * @param {object} o
   * @param {(sid: string) => object|null} o.getPi  Omni's pi child when it owns `sid`, else null.
   * @param {(input: string, pick: {provider, model}) => Promise<string>} [o.judge]  opt-in fallback judge (`judgeFallback`).
   * @param {(input: string, pick: {provider, model, conversation}) => Promise<string>} [o.summarize]  the status-box side conversation.
   */
  constructor({ bus, getPi, judge = null, summarize = null, config = {}, log = () => {}, ledger = null, onEscalate = null, setTimer = setTimeout, clearTimer = clearTimeout }) {
    this.bus = bus;
    this.getPi = getPi;
    this.judge = judge;
    this.summarizeFn = summarize;
    // Optional RunLedger-like durable store (writeControl/goalText). Null in normal GUI use — only the
    // durable unattended runner sets one. Every use is guarded with `?.` so nothing breaks when null.
    this.ledger = ledger;
    this.onEscalate = onEscalate;
    this.setTimer = setTimer; this.clearTimer = clearTimer;
    // The sid the goal currently lives on, so a restart can carry it onto pi's new session id.
    this._lastSid = null;
    this.config = { enabled: false, provider: "", model: "", maxIdleNudges: 5, graceMs: 2000, summaries: true, restateEvery: 10, heartbeatMs: 60000, loopK: 3, judgeTimeoutMs: 120000, judgeFallback: false, planlessNudges: 1, errorCompactAfter: 2, errorBackoffMs: 15000, ...config };
    this.heartbeatTimer = null;
    this.log = log;
    this.goals = new Map();
    // sid -> the session's latest plan (it belongs to the chat, not to one prompt: a follow-up prompt keeps working on it)
    this.plans = new Map();
    // sids whose plan was already looked up in pi's session (after a server restart, a resumed run, an older chat)
    this.planLoaded = new Set();
    this.onEvent = this.onEvent.bind(this);
    bus.on("event", this.onEvent);
  }

  dispose() { this.bus.off("event", this.onEvent); this.stopHeartbeat(); for (const g of this.goals.values()) this.clearTimer(g.timer); this.goals.clear(); }
  setConfig(patch) { this.config = { ...this.config, ...patch }; if (!this.config.enabled) { for (const g of this.goals.values()) { this.clearTimer(g.timer); g.timer = null; } this.stopHeartbeat(); } else this.startHeartbeat(); return this.config; }

  goal(sid) { return this.goals.get(sid) || null; }
  setGoal(sid, text, explicit = false) {
    const prev = this.goals.get(sid);
    if (prev) this.clearTimer(prev.timer);
    const g = {
      text, explicit, seq: (prev?.seq || 0) + 1, startedAt: Date.now(), timer: null,
      nudges: 0, idleNudges: 0, nudged: false, progress: false, planMoved: false, ran: false, paused: false, done: false, checking: false, recheck: false, restate: false,
      sameFailCount: 0, lastFingerprint: "", stopReason: "", lastError: "", errorStops: 0, compactedForError: false, planlessNudges: 0,
      tail: [], toolCalls: 0, linesSinceSummary: 0, lastSummary: "", lastSummaryAt: 0, summarizing: false, summaryPending: "",
      // The summarizer's own side conversation for this goal (a session file of its own, never the agent's chat).
      conversation: prev?.text === text && prev?.conversation ? prev.conversation : newConversationId(),
    };
    this.goals.set(sid, g);
    this._lastSid = sid;
    this.ledger?.writeControl?.({ goalText: text });
    return g;
  }
  /** After a pi restart (new session id), carry the goal, its plan and counters to the new sid so a crash doesn't drop them. */
  attachToSid(oldSid, newSid) {
    if (oldSid === newSid) return;
    const g = this.goals.get(oldSid);
    if (!g) return;
    this.clearTimer(g.timer); g.timer = null;
    this.goals.delete(oldSid);
    this.goals.set(newSid, g);
    if (this.plans.has(oldSid)) { this.plans.set(newSid, this.plans.get(oldSid)); this.plans.delete(oldSid); this.planLoaded.add(newSid); }
    this._lastSid = newSid;
  }
  /**
   * Set an **explicit**, persistent goal (from the `/goal` command): it overrides the implicit
   * "last user prompt" goal and is NOT replaced by subsequent plain prompts, and it requires a plan:
   * the agent is re-engaged until it has brainstormed, planned and finished every step. Empty text
   * clears the explicit lock, so the next prompt becomes the goal again.
   */
  setExplicitGoal(sid, text) {
    const t = String(text ?? "").trim();
    if (!t) { const g = this.goals.get(sid); if (g) g.explicit = false; return g || null; }
    return this.setGoal(sid, t, true);
  }
  /** The user paused the agent: stop re-engaging until resumed or a new prompt arrives. Not permanent. */
  cancel(sid) { const g = this.goals.get(sid); if (!g) return; this.clearTimer(g.timer); g.timer = null; g.paused = true; }
  resume(sid) { const g = this.goals.get(sid); if (!g) return; g.paused = false; }

  /** The plan that applies to the goal: the session's plan, unless it is a finished plan from before this goal began. */
  plan(sid) {
    const p = this.plans.get(sid) || null;
    const g = this.goals.get(sid);
    if (!p || !g) return p;
    return planProgress(p).complete && (p.updatedAt || 0) < g.startedAt ? null : p;
  }

  /**
   * The keeper only sees plan changes live; a session it did not watch from the start (a server restart,
   * a resumed run, a continued older chat) gets its plan from pi's session entries, once.
   */
  async loadPlan(sid, pi) {
    if (this.planLoaded.has(sid) || this.plans.has(sid) || typeof pi?.entries !== "function") return;
    this.planLoaded.add(sid);
    try {
      const r = await pi.entries();
      const p = latestPlan(r?.data?.entries || [], r?.data?.leafId || null);
      if (p && !this.plans.has(sid)) { this.plans.set(sid, p); this.bus.emit({ sid, harness: "pi", kind: "plan", ts: Date.now(), goal: this.goals.get(sid)?.text || "", plan: p, progress: planProgress(p), events: ["restored"] }); }
    } catch (e) { this.log("could not read the plan from pi's session", e.message); }
  }

  /** What the status box shows for a chat (also served by GET /api/goal). */
  status(sid) {
    const g = this.goals.get(sid);
    const p = this.plan(sid);
    return { goal: g?.text || "", explicit: !!g?.explicit, nudges: g?.nudges || 0, done: !!g?.done, paused: !!g?.paused, enabled: !!this.config.enabled, plan: p, progress: p ? planProgress(p) : null, summary: g?.lastSummary || "", summaryAt: g?.lastSummaryAt || 0 };
  }

  onEvent(ev) {
    if (ev.harness !== "pi" || !this.getPi(ev.sid)) return;
    const g = this.goals.get(ev.sid);
    // The plan tool's result: from the live tool event or the tool-result message, whichever comes first.
    if (ev.kind === "tool" && ev.phase === "end" && ev.name === PLAN_TOOL && ev.details) this.onPlan(ev.sid, ev.details);
    if (ev.kind === "msg" && ev.live) {
      if (ev.role === "user") {
        const text = (ev.blocks || []).map((b) => b.text || "").join("\n");
        if (hookInfo(text)) return;
        // A real user message answers a plan's ask_user, and resumes a paused goal.
        const p = this.plans.get(ev.sid);
        if (p?.waiting) this.plans.set(ev.sid, clearWaiting(p));
        // A plain prompt sets the goal, UNLESS an explicit /goal is locked in for this chat.
        const cur = this.goals.get(ev.sid);
        if (!(cur && cur.explicit)) this.setGoal(ev.sid, text);
        else { cur.paused = false; cur.idleNudges = 0; }
        return;
      }
      if (!g) return;
      for (const b of ev.blocks || []) if (b.type === "tool_result" && b.name === PLAN_TOOL && b.details) this.onPlan(ev.sid, b.details);
      const line = tailLine(ev);
      if (line) { g.tail.push(line); g.linesSinceSummary++; if (g.tail.length > 60) g.tail.splice(0, g.tail.length - 60); }
      const calls = ev.role === "assistant" ? (ev.blocks || []).filter((b) => b.type === "tool_call").length : 0;
      if (calls) g.toolCalls += calls;
      if (ev.role === "tool" || calls) g.progress = true;
      if (ev.role === "assistant" && ev.stopReason) {
        g.stopReason = ev.stopReason;
        if (ev.stopReason === "error") { g.errorStops++; g.lastError = (ev.blocks || []).map((b) => b.text || "").join(" ").replace(/^Model error:\s*/, "").trim(); }
        else { g.errorStops = 0; g.compactedForError = false; g.lastError = ""; }
      }
      return;
    }
    // A compaction may have dropped the original prompt from pi's context: restate it on the next re-engage.
    if (ev.kind === "compaction" && g) { g.restate = true; return; }
    if (ev.kind === "status" && g && typeof ev.streaming === "boolean") {
      if (ev.streaming === true) { g.ran = true; this.clearTimer(g.timer); g.timer = null; }
      else if (g.ran) this.onSettled(ev.sid);
    }
  }

  /** A plan tool result: keep the newest state, broadcast it, and refresh the status box when the plan moved. */
  onPlan(sid, details) {
    const p = asPlan(details);
    if (!p) return;
    const prev = this.plans.get(sid);
    if (prev && (prev.updatedAt || 0) > (p.updatedAt || 0)) return;
    const same = prev && JSON.stringify(prev) === JSON.stringify(p);
    this.plans.set(sid, p);
    if (same) return; // the tool event and the tool-result message carry the same state
    const g = this.goals.get(sid);
    if (g) {
      g.planMoved = true; g.planlessNudges = 0;
      // The agent reopened work on a finished goal (revised or re-planned it): the goal is live again.
      if (g.done && !planProgress(p).complete) { g.done = false; this.ledger?.writeControl?.({ status: "running" }); }
    }
    const events = Array.isArray(details.events) ? details.events : [];
    this.bus.emit({ sid, harness: "pi", kind: "plan", ts: Date.now(), goal: g?.text || "", plan: p, progress: planProgress(p), events });
    const why = ["plan_done", "milestone_done", "revised", "created"].find((e) => events.includes(e));
    if (why && g) this.requestSummary(sid, SUMMARY_REASON[why]);
  }

  onSettled(sid) {
    const g = this.goals.get(sid);
    // Consume the "a run happened" flag even when nothing else happens, so a later idle status event
    // (a state refresh, a model switch) is not mistaken for another settle.
    if (g) g.ran = false;
    if (!g || g.paused || g.done || !this.config.enabled || g.checking) return;
    // The run that just settled was a re-engaged one: did the agent do anything (a tool call, a plan move)?
    // A run that failed on the provider's side is not the agent idling (an outage must not pause a long run).
    if (g.nudged) { g.idleNudges = g.progress || g.planMoved ? 0 : g.stopReason === "error" ? g.idleNudges : g.idleNudges + 1; g.nudged = false; }
    g.progress = false;
    g.recheck = false; // this settle's own check supersedes a pending heartbeat retry
    this.clearTimer(g.timer);
    const seq = g.seq;
    g.timer = this.setTimer(() => { g.timer = null; this.check(sid, seq).catch((e) => this.log("goal hook failed", e.message)); }, this.config.graceMs);
  }

  /**
   * Decide what a stop means — from the stop reason and the plan, no model involved (unless the opt-in
   * judge fallback is on for planless work). Returns `{ action, reason }` for tests and logs.
   */
  async check(sid, seq) {
    const g = this.goals.get(sid);
    const pi = this.getPi(sid);
    if (!g || g.seq !== seq || g.paused || g.done || !pi || pi.streaming) return null;
    this._lastSid = sid;
    g.ran = false;
    g.recheck = false;
    const c = this.config;

    // Nothing is happening: several re-engagements in a row without a single tool call or plan change.
    if (g.idleNudges >= c.maxIdleNudges) {
      g.paused = true;
      this.emitLog(sid, `goal hook paused: ${g.idleNudges} re-engagements in a row without any progress. Send a message to resume.`);
      return { action: "pause", reason: "no progress" };
    }

    // 1) Stops that were not the agent's choice.
    if (g.stopReason === "error") return this.recoverFromError(sid, g, pi);

    await this.loadPlan(sid, pi);
    if (g.seq !== seq || g.paused || g.done || pi.streaming) return null;

    const plan = this.plan(sid);
    const pr = plan ? planProgress(plan) : null;
    const lengthNote = g.stopReason === "length" ? LENGTH_NOTE : "";

    // 2) The plan decides.
    if (pr?.complete) return this.finish(sid, g, `every step of the plan is done (${pr.done} done${pr.skipped ? `, ${pr.skipped} skipped` : ""})`);
    if (pr?.phase === "waiting") { this.emitLog(sid, `goal hook: waiting for your answer — ${clip(pr.waiting.question, 200)}`); return { action: "wait", reason: pr.waiting.question }; }
    if (pr && pr.phase !== "brainstorm") {
      const step = currentStep(plan);
      return this.nudge(sid, g, pi, { reason: `plan step ${step?.id || "?"} is not done (${pr.done + pr.skipped}/${pr.steps})`, body: [lengthNote, planNudge(plan)], fp: `plan:${step?.id}:${step?.status}:${pr.done}` });
    }

    // 3) No plan.
    if (g.explicit) {
      return this.nudge(sid, g, pi, { reason: "this goal needs a plan first", body: [lengthNote, `This goal is tracked by its plan, and there is none yet. Before doing more work, call the plan tool: action "brainstorm" (understanding, assumptions, at least two approaches with trade-offs, the chosen one and why, success criteria), then action "create" (milestones of small steps, each with done_when), then execute it step by step.`], fp: "noplan" });
    }
    if (stoppedAbnormally(g.stopReason)) return this.nudge(sid, g, pi, { reason: `it stopped abnormally (${g.stopReason})`, body: [lengthNote, nudgeBody({ goal: g.text, restate: this.restateNow(g) })], fp: fingerprint(g.tail) });
    if (!g.toolCalls) return this.finish(sid, g, "answered without needing any tools", { quiet: true });
    if (c.judgeFallback && this.judge) return this.judgeCheck(sid, g, pi, seq);
    if (g.planlessNudges < c.planlessNudges) {
      g.planlessNudges++;
      return this.nudge(sid, g, pi, { reason: "it stopped after working without a plan", body: [`You stopped after working without a plan. If the request is completely done and verified, reply with one short final answer and stop. If anything is left, call the plan tool now (brainstorm, then create a plan for the remaining work) and continue.`], fp: "planless" });
    }
    return this.finish(sid, g, "it stopped normally and did not plan further work", { quiet: true });
  }

  restateNow(g) {
    const r = g.restate || (this.config.restateEvery > 0 && (g.nudges + 1) % this.config.restateEvery === 0);
    g.restate = false;
    return r;
  }

  /** A model/provider error ended the run. Transient → retry after a back-off; refused → compact, then retry; then pause. */
  async recoverFromError(sid, g, pi) {
    const c = this.config;
    const err = g.lastError || "the provider returned an error";
    if (transientError(err)) {
      const wait = errorBackoff(g.errorStops, { base: c.errorBackoffMs });
      this.emitLog(sid, `goal hook: provider error (${clip(err, 160)}); retrying in ${Math.round(wait / 1000)}s`);
      const seq = g.seq;
      this.clearTimer(g.timer);
      g.timer = this.setTimer(() => {
        g.timer = null;
        const p = this.getPi(sid);
        if (!p || g.seq !== seq || g.paused || g.done || p.streaming) return;
        this.nudge(sid, g, p, { reason: `retrying after a provider error`, body: ["The model provider failed on your last turn; this is a retry. Continue exactly where you left off."], fp: "" }).catch((e) => this.log("retry failed", e.message));
      }, wait);
      return { action: "retry-later", reason: err, waitMs: wait };
    }
    // The provider refuses the request itself (typically a context that grew too long or a malformed tail):
    // repeating it unchanged fails the same way, so compact first.
    if (g.errorStops >= c.errorCompactAfter && !g.compactedForError && typeof pi.compact === "function") {
      g.compactedForError = true;
      this.emitLog(sid, `goal hook: the provider keeps rejecting the request (${clip(err, 160)}); compacting the context, then retrying`);
      try { await pi.compact(); } catch (e) { this.emitLog(sid, `goal hook: compaction failed: ${e.message}`); }
      return this.nudge(sid, g, pi, { reason: "retrying after compacting the context", body: ["The context was compacted after the provider rejected your requests. Continue where you left off."], fp: "" });
    }
    if (g.compactedForError && g.errorStops >= c.errorCompactAfter + 2) {
      g.paused = true;
      // Context size is ruled out by now, so it is usually a request setting the server refuses (for example a
      // thinking level it does not support); "400 status code (no body)" is pi hiding the server's own message.
      this.emitLog(sid, `goal hook paused: the provider still rejects the request after compacting (${clip(err, 160)}). This is usually a setting the server refuses, such as the thinking level (try another one, or map it with thinkingLevelMap in models.json). Send a message to resume.`);
      return { action: "pause", reason: err };
    }
    return this.nudge(sid, g, pi, { reason: `retrying after a model error`, body: ["Your last turn failed with a model error. Continue where you left off."], fp: "" });
  }

  /** The goal is finished: latch it, persist "done", and close the status box with a final summary. */
  finish(sid, g, reason, { quiet = false } = {}) {
    g.done = true;
    this.ledger?.writeControl?.({ status: "done" });
    if (!quiet || g.nudges) this.emitLog(sid, `goal hook: done (${reason})`);
    if (g.lastSummary && g.linesSinceSummary && !this.plan(sid)) this.requestSummary(sid, "the goal is finished");
    this.bus.emit({ sid, harness: "pi", kind: "goal", ts: Date.now(), ...this.status(sid), reason });
    return { action: "done", reason };
  }

  /** Re-engage pi with a wrapped, non-echoed prompt. `fp` detects "stuck on the same thing" → escalate. */
  async nudge(sid, g, pi, { reason, body, fp }) {
    const parts = (Array.isArray(body) ? body : [body]).filter(Boolean);
    g.sameFailCount = fp && fp === g.lastFingerprint ? g.sameFailCount + 1 : 0;
    g.lastFingerprint = fp;
    const escalate = !!fp && g.sameFailCount + 1 >= this.config.loopK;
    if (escalate) parts.unshift(`You have stopped ${g.sameFailCount + 1} times at the same point without moving on. Do not repeat what failed: try a DIFFERENT APPROACH, or revise the plan (plan action "revise", with the reason), or skip the step with a reason and continue with the rest.`);
    if (this.plan(sid) && this.restateNow(g)) parts.push(`The original goal, verbatim:\n${g.text}`);
    g.nudges++; g.nudged = true; g.planMoved = false;
    this.ledger?.writeControl?.({ counters: { nudges: g.nudges } });
    const note = `Goal hook re-engaged the agent (#${g.nudges}${escalate ? ", escalating" : ""})${reason ? `: ${reason}` : ""}`;
    if (escalate && this.onEscalate) { try { await this.onEscalate(sid, g); } catch { /* best effort */ } }
    try {
      await pi.prompt(hookMessage("goal", note, parts.join("\n\n")), { echo: false });
      this.bus.emit({ sid, harness: "pi", kind: "hook", ts: Date.now(), name: "goal", attempt: g.nudges, idle: g.idleNudges, maxIdle: this.config.maxIdleNudges, reason, escalate, text: note });
    } catch (e) { g.recheck = true; this.emitLog(sid, `goal hook: could not re-engage pi: ${e.message}`); }
    return { action: "nudge", reason, escalate };
  }

  /** Opt-in fallback for planless work: the old judge model. No verdict → recheck on the heartbeat. */
  async judgeCheck(sid, g, pi, seq) {
    g.checking = true;
    let verdict = null;
    try {
      const input = buildJudgeInput({ goal: g.text, tail: g.tail, nudges: g.nudges, stopReason: g.stopReason });
      const pick = { provider: this.config.provider || pi.state?.model?.provider || "", model: this.config.model || pi.state?.model?.id || "" };
      const reply = await this.judge(input, pick);
      verdict = parseVerdict(reply);
      if (!verdict) this.emitLog(sid, `goal hook: judge reply was not JSON: ${clip(reply, 200)}`);
    } catch (e) { this.emitLog(sid, `goal hook: judge failed: ${e.message}`); }
    finally { g.checking = false; }
    if (g.seq !== seq || g.paused || pi.streaming || g.ran) return { action: "stale" };
    if (!verdict) { g.recheck = true; return { action: "recheck" }; }
    if (verdict.done) return this.finish(sid, g, verdict.reason);
    return this.nudge(sid, g, pi, { reason: verdict.reason, body: [nudgeBody({ goal: g.text, reason: verdict.reason, restate: this.restateNow(g) })], fp: fingerprint(g.tail) });
  }

  /** Queue a status-box update; calls never overlap (one waiting request is kept, the newest reason wins). */
  requestSummary(sid, reason) {
    const g = this.goals.get(sid);
    if (!g || !this.summarizeFn || this.config.summaries === false) return;
    if (g.summarizing) { g.summaryPending = reason; return; }
    this.makeSummary(sid, reason).catch((e) => this.emitLog(sid, `goal hook: status summary failed: ${e.message}`));
  }

  /** Write the status box with the separate summarizer conversation and broadcast it as a `summary` event (UI only, never sent to pi). */
  async makeSummary(sid, reason = "") {
    const g = this.goals.get(sid);
    const pi = this.getPi(sid);
    if (!g || !this.summarizeFn || this.config.summaries === false || !pi || g.summarizing) return;
    const fresh = Math.min(g.linesSinceSummary, g.tail.length);
    g.summarizing = true; g.linesSinceSummary = 0;
    try {
      const plan = this.plan(sid);
      const input = buildSummaryInput({ goal: g.text, plan, reason, tail: g.lastSummary ? g.tail.slice(g.tail.length - fresh) : g.tail, previous: g.lastSummary });
      const pick = { provider: this.config.summaryProvider || this.config.provider || pi.state?.model?.provider || "", model: this.config.summaryModel || this.config.model || pi.state?.model?.id || "", conversation: g.conversation };
      const text = clip(String(await this.summarizeFn(input, pick) ?? "").trim(), 1200);
      if (text) {
        g.lastSummary = text; g.lastSummaryAt = Date.now();
        this.bus.emit({ sid, harness: "pi", kind: "summary", ts: g.lastSummaryAt, goal: g.text, explicit: !!g.explicit, nudges: g.nudges, done: !!g.done, reason, progress: plan ? planProgress(plan) : null, text });
      }
    } finally {
      g.summarizing = false;
      if (g.summaryPending) { const next = g.summaryPending; g.summaryPending = ""; this.requestSummary(sid, next); }
    }
  }

  /** Retries only re-engages that could not be sent (or a judge with no verdict) — it never re-checks an idle goal on a timer. */
  startHeartbeat() {
    this.stopHeartbeat();
    if (!this.config.heartbeatMs) return;
    this.heartbeatTimer = setInterval(() => {
      if (!this.config.enabled) return;
      for (const [sid, g] of this.goals) {
        const pi = this.getPi(sid);
        if (!g.recheck || !pi || pi.streaming || g.paused || g.checking || g.done) continue;
        this.check(sid, g.seq).catch((e) => this.log("heartbeat check failed", e.message));
      }
    }, this.config.heartbeatMs);
    this.heartbeatTimer.unref?.();
  }
  stopHeartbeat() { if (this.heartbeatTimer) clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }

  emitLog(sid, text) { this.log(text); this.bus.emit({ sid, harness: "pi", kind: "log", ts: Date.now(), level: "hook", text }); }
}

function newConversationId() {
  try { return globalThis.crypto.randomUUID(); } catch { return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`; }
}
