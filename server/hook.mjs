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
 *   plan waits on the user  → stay quiet until the user answers (`ask_user`); a background agent has
 *                             nobody to ask, so it is told to assume and go on, then ended with the question
 *   an explicit /goal and no plan yet → re-engage: brainstorm and write the plan first
 * Work without a plan (a quick task the agent chose not to plan) ends when the agent stops normally; if
 * it used tools, it is first asked once to either confirm it is finished or plan the rest — unless it
 * asked the user a real question (not "shall I go on?") on a plain prompt. The old judge model is only an
 * opt-in fallback for that case (`judgeFallback`).
 *
 * Stops that are not the agent's choice are handled on their own, before the plan is looked at:
 *   output limit (`length`, typically a long think)  → re-engage, telling it to think briefly and act
 *   provider unavailable (5xx, 429, timeouts)       → retry after a growing back-off instead of piling nudges
 *   the request rejected (e.g. 400: context too long or a malformed tail) → compact, then retry; pause the
 *                                                    goal if it keeps failing after that
 *   "my context is used up" (it stopped believing its context or session was spent, or wrote a handoff
 *   for a fresh session; classifyStop in integrations/pi/omni-context-lib.mjs) → compact when the prompt is
 *                                                    big, then re-engage: context is managed for it
 *   the output cap used up by reasoning (`length` at maxTokens, which pi cannot recover) → "act now"
 *
 * Modes: with the hook on, all of the above. With it off but context auto-continue on (`contextPolicy`),
 * only transient provider errors, context stops and length-cap stops are handled; every other stop is
 * left alone. A managed goal (a background agent's task, `setManagedGoal`) is handled in full either way,
 * and its end (done or paused) is announced as a `goal` event. While a chat's background agents are
 * running it is never re-engaged: their reports wake it up.
 *
 * Status box: written by a separate summarizer — its own side conversation (`pi -p` on a dedicated
 * session per goal), never the agent's chat — and only when the plan moves: plan written or revised, a
 * milestone reached, the plan finished. The plan itself is broadcast on every change (`plan` event) so
 * the box's checklist is always current without any model call.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { classifyStop, contextContinueMessage, contextSkipReason } from "../integrations/pi/omni-context-lib.mjs";
import { hookInfo, hookMessage } from "../ui/lib.js";
import { PLAN_TOOL, allSteps, asPlan, clearWaiting, currentStep, latestPlan, planNudge, planProgress, renderPlan } from "../ui/plan.js";

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

/**
 * A provider/network failure that clears up by itself (retry later) rather than a request the provider refuses.
 * Only called for stopReason `error`, so "aborted" here is a dropped connection, not the user's Stop.
 * "400 status code (no body)" stays on the refused path (compact, then pause).
 */
export const transientError = (text) => /\b(5\d\d|429|409)\b|overload|unavailable|upstream|rate.?limit|too many requests|timed? ?out|timeout|ECONN|ETIMEDOUT|EAI_AGAIN|EPIPE|socket|network|fetch failed|terminated|unloaded|connection (?:error|reset|refused|closed|lost)|this operation was aborted|request (?:was )?aborted|provider returned error/i.test(String(text ?? ""));

/** Back-off before retrying after the n-th consecutive transient error (1-based). */
export const errorBackoff = (n, { base = 15000, cap = 600000 } = {}) => Math.min(cap, base * 2 ** Math.max(0, n - 1));

export const LENGTH_NOTE = "Your last reply was cut off by the output-token limit (stop reason: length) — most likely a long think — before you acted. Keep your reasoning short now and make the next tool call right away; split big outputs (long files, big edits) into smaller pieces.";

const PLAN_FIRST = `This goal is tracked by its plan, and there is none yet. Before doing more work, call the plan tool: action "brainstorm" (understanding, assumptions, at least two approaches with trade-offs, the chosen one and why, success criteria), then action "create" (milestones of small steps, each with done_when), then execute it step by step.`;

/** A context stop compacts first only when the prompt is at least this share of `compactAt` (or this many tokens without one). */
const CONTEXT_COMPACT_SHARE = 0.25;
const CONTEXT_COMPACT_FLOOR = 64000;
/** Length-cap stops in a row (no tool call between them) that are re-engaged before the run is left alone. */
const MAX_LENGTH_NUDGES = 3;
/**
 * A tool call ends a streak of context stops, so "one trivial read, then the same claim" would go on for
 * ever: at most this many streaks' worth (× maxContextNudges) is continued until the plan moves on (a step
 * finished or skipped, a plan written or revised) or the user writes.
 */
const CONTEXT_STOPS_PER_PLAN_MOVE = 3;
/** Plan events that count as moving on for that brake (a bare "start" or "ask_user" does not). */
const PLAN_PROGRESS = new Set(["created", "revised", "step_done", "step_skipped"]);
/** Times a background agent that parked its plan on a question is told to assume and go on before it is ended with that question. */
const MAX_ASSUME_NUDGES = 2;
/** A 4xx in an error text that is not "try again later" (408/409/429): the provider refused this request. */
const REFUSED_CODE = /\b4(?!08|09|29)\d\d\b/;

/**
 * Asking permission to go on ("Shall I go ahead?", "Let me know if you want me to continue") is stopping
 * part-way (see nudgeBody and JUDGE_SYSTEM), not a question only the user can answer, unless the same
 * paragraph also offers a real choice ("…option A or B?", "which…", "your call").
 */
const ASKS_TO_GO_ON = /\b(?:shall i\b|should i (?:go ahead|proceed|continue|carry on|keep going|go on|move on|start|finish|do (?:it|that|this|so|the rest))\b|(?:do you want|would you like|want) me to (?:go ahead|proceed|continue|carry on|keep going|go on|move on|start|finish|do (?:it|that|this|so|the rest))\b|let me know (?:if|whether|when) (?:you(?:'d| would)? (?:want|like) me to|i should|to (?:go ahead|proceed|continue))\b|(?:ok(?:ay)?|good) (?:for me )?to (?:go ahead|proceed|continue)\b)/i;
const OFFERS_CHOICE = /\bwhich\b|\bor\b(?! (?:not|stop|wait|pause|hold off|leave it|end it)\b)[^.?!\n]{0,120}\?|\b(?:your (?:call|decision|choice|preference)|(?:do|would) you prefer|need your|please (?:confirm|choose|decide|tell me)|can you (?:confirm|tell me))\b/i;
export function asksToGoOn(text) {
  const last = String(text ?? "").replace(/[‘’ʼ]/g, "'").trim().split(/\n\s*\n/).pop() || "";
  const t = last.slice(-600);
  return ASKS_TO_GO_ON.test(t) && !OFFERS_CHOICE.test(t);
}

/** A number from an injected callback (activeChildren, maxTokensFor); 0 when it is missing or throws. */
const countOf = (fn, sid) => { try { return Math.max(0, Number(fn?.(sid)) || 0); } catch { return 0; } };

/** The re-engage for a plan that is "complete" only because steps were skipped for context reasons. */
function contextSkipNudge(steps) {
  const one = steps.length === 1;
  return [
    `Your plan only looks complete because ${one ? "this step was" : "these steps were"} skipped because of context:`,
    ...steps.map((s) => `- ${s.id} ${clip(s.title, 160)} (skipped: ${clip(s.note, 200)})`),
    "",
    `Context is managed automatically; a step may not be skipped because of context. Reopen ${one ? "it" : "them"} now with plan action "revise" (reason: "reopening work skipped because of context", with milestones for that work again), then continue until it is done.`,
  ].join("\n");
}

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
   * @param {{compactAt?: number, autoContinue?: boolean, maxContextNudges?: number}} [o.contextPolicy]  CONFIG.context:
   *        context stops are continued even with the hook off when `autoContinue`; `compactAt` sizes "a big prompt".
   * @param {(sid: string) => number} [o.maxTokensFor]  the output cap of the chat's model (a `length` stop at it is a runaway think).
   * @param {(sid: string) => number} [o.activeChildren]  background agents the chat started that are still running.
   */
  constructor({ bus, getPi, judge = null, summarize = null, config = {}, contextPolicy = {}, maxTokensFor = () => 0, activeChildren = () => 0, log = () => {}, ledger = null, onEscalate = null, setTimer = setTimeout, clearTimer = clearTimeout }) {
    this.bus = bus;
    this.getPi = getPi;
    this.judge = judge;
    this.summarizeFn = summarize;
    this.contextPolicy = { compactAt: 0, autoContinue: false, maxContextNudges: 3, ...contextPolicy };
    this.maxTokensFor = maxTokensFor;
    this.activeChildren = activeChildren;
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
  setConfig(patch) { this.config = { ...this.config, ...patch }; if (!this.config.enabled) this.parkUnhandled(); else this.startHeartbeat(); return this.config; }
  setContextPolicy(patch) { this.contextPolicy = { ...this.contextPolicy, ...patch }; if (!this.config.enabled) this.parkUnhandled(); return this.contextPolicy; }
  /** The hook is off: drop pending checks of goals nothing handles any more, and the heartbeat while no goal needs it. */
  parkUnhandled() {
    for (const g of this.goals.values()) if (!this.mode(g)) { this.clearTimer(g.timer); g.timer = null; }
    if (this.contextPolicy.autoContinue || [...this.goals.values()].some((g) => g.managed)) { if (!this.heartbeatTimer) this.startHeartbeat(); }
    else this.stopHeartbeat();
  }
  /**
   * How a goal is handled: "full" (the hook is on, or it is a background agent's task), "context" (the hook
   * is off but context auto-continue is on: only the stops that are not the agent's choice), "" (left alone).
   */
  mode(g) { return !g ? "" : this.config.enabled || g.managed ? "full" : this.contextPolicy.autoContinue ? "context" : ""; }
  /** The run ledger only belongs to the user's own chat, never to a background agent's goal. */
  ledgerOf(g) { return g?.managed ? null : this.ledger; }

  goal(sid) { return this.goals.get(sid) || null; }
  setGoal(sid, text, explicit = false, { managed = false } = {}) {
    const prev = this.goals.get(sid);
    if (prev) this.clearTimer(prev.timer);
    const g = {
      text, explicit, managed, locked: managed, seq: (prev?.seq || 0) + 1, startedAt: Date.now(), timer: null,
      nudges: 0, idleNudges: 0, nudged: false, progress: false, planMoved: false, ran: false, paused: false, done: false, checking: false, recheck: false, restate: false,
      sameFailCount: 0, lastFingerprint: "", stopReason: "", lastError: "", errorStops: 0, compactedForError: false, planlessNudges: 0,
      // The newest assistant message (what classifyStop reads) and the user's own latest words (raw: memory packs included).
      lastText: "", lastThinking: "", lastUsage: null, lastUserText: "",
      // Stops in a row without a tool call between them; the idle escalation; the context skips already sent back.
      contextNudges: 0, lengthNudges: 0, compactedForIdle: false, contextSkipKey: "", waitingFor: 0,
      // Context stops continued since the plan last moved on; a background agent told to assume instead of asking.
      contextStops: 0, assumeNudges: 0,
      tail: [], toolCalls: 0, linesSinceSummary: 0, lastSummary: "", lastSummaryAt: 0, summarizing: false, summaryPending: "",
      // The summarizer's own side conversation for this goal (a session file of its own, never the agent's chat).
      conversation: prev?.text === text && prev?.conversation ? prev.conversation : newConversationId(),
    };
    this.goals.set(sid, g);
    if (!managed) { this._lastSid = sid; this.ledger?.writeControl?.({ goalText: text }); }
    return g;
  }
  /**
   * A background agent's task (server/agents.mjs): handled in full even with the hook off, locked (a user
   * message — the task prompt's own echo, or a follow-up — never replaces it), kept out of the run ledger,
   * and its end is announced as a `goal` event (`done`, or `paused` with the reason).
   */
  setManagedGoal(sid, text) {
    const g = this.setGoal(sid, String(text ?? "").trim(), false, { managed: true });
    if (!this.heartbeatTimer) this.startHeartbeat();
    return g;
  }
  /** Goals worth restoring after an Omni restart: explicit or managed, not finished. */
  exportGoals() {
    return [...this.goals].filter(([, g]) => (g.explicit || g.managed) && !g.done)
      .map(([sid, g]) => ({ sid, text: g.text, explicit: !!g.explicit, managed: !!g.managed, done: false, paused: !!g.paused, nudges: g.nudges, startedAt: g.startedAt }));
  }
  /**
   * Recreate an exported goal on `sid` without prompting pi. `resume` marks it for the heartbeat's next look
   * (it then re-engages if its plan is unfinished); otherwise it waits for the next settle or user message.
   */
  importGoal(sid, data = {}, { resume = false } = {}) {
    const text = String(data?.text ?? "").trim();
    if (!sid || !text) return null;
    const g = data.managed ? this.setManagedGoal(sid, text) : this.setGoal(sid, text, !!data.explicit);
    if (data.managed && data.explicit) g.explicit = true;
    g.paused = !!data.paused;
    g.nudges = Number(data.nudges) || 0;
    if (Number(data.startedAt) > 0) g.startedAt = Number(data.startedAt);
    g.recheck = !!resume && !g.paused;
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
  cancel(sid) { const g = this.goals.get(sid); if (!g) return; this.pause(sid, g, "stopped by the user"); }
  resume(sid) { const g = this.goals.get(sid); if (!g) return; g.paused = false; }
  /** Stop re-engaging a goal until a user message resumes it, and say so with a `goal` event (`paused`, `reason`). */
  pause(sid, g, reason, text = "") {
    this.clearTimer(g.timer); g.timer = null;
    g.paused = true;
    if (text) this.emitLog(sid, text);
    this.bus.emit({ sid, harness: "pi", kind: "goal", ts: Date.now(), ...this.status(sid), paused: true, reason });
  }

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
    return { goal: g?.text || "", explicit: !!g?.explicit, managed: !!g?.managed, nudges: g?.nudges || 0, done: !!g?.done, paused: !!g?.paused, enabled: !!this.config.enabled, plan: p, progress: p ? planProgress(p) : null, summary: g?.lastSummary || "", summaryAt: g?.lastSummaryAt || 0 };
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
        // A plain prompt sets the goal, UNLESS an explicit /goal or a background agent's task is locked in for this chat.
        const cur = this.goals.get(ev.sid);
        if (!(cur && (cur.explicit || cur.locked))) {
          const g2 = this.setGoal(ev.sid, text);
          // A message sent while pi is working steers the running run: there is no new agent_start for it, so the new
          // goal counts as running already — otherwise the end of that run would go unhandled.
          if (this.getPi(ev.sid)?.streaming) g2.ran = true;
        } else {
          Object.assign(cur, { paused: false, idleNudges: 0, contextNudges: 0, lengthNudges: 0, compactedForIdle: false, contextStops: 0, assumeNudges: 0 });
          // A follow-up to a finished background agent is more work on its task: handle it until that ends too.
          if (cur.managed && cur.done) Object.assign(cur, { done: false, startedAt: Date.now(), toolCalls: 0, planlessNudges: 0 });
        }
        this.goals.get(ev.sid).lastUserText = text;
        return;
      }
      if (!g) return;
      for (const b of ev.blocks || []) if (b.type === "tool_result" && b.name === PLAN_TOOL && b.details) this.onPlan(ev.sid, b.details);
      const line = tailLine(ev);
      if (line) { g.tail.push(line); g.linesSinceSummary++; if (g.tail.length > 60) g.tail.splice(0, g.tail.length - 60); }
      const calls = ev.role === "assistant" ? (ev.blocks || []).filter((b) => b.type === "tool_call").length : 0;
      if (calls) g.toolCalls += calls;
      // Progress. The context/length streaks only count stops in a row with no tool call between them.
      if (ev.role === "tool" || calls) { g.progress = true; g.contextNudges = 0; g.lengthNudges = 0; }
      if (ev.role === "assistant") {
        const of = (type) => (ev.blocks || []).filter((b) => b.type === type).map((b) => b.text || "").join("\n");
        g.lastText = of("text"); g.lastThinking = of("thinking"); g.lastUsage = ev.usage || null;
      }
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
      if (ev.streaming === true) {
        // A new run: what the previous run's last message said no longer describes the next stop.
        if (!g.ran) { g.lastText = ""; g.lastThinking = ""; g.lastUsage = null; }
        g.ran = true; this.clearTimer(g.timer); g.timer = null;
      }
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
    const events = Array.isArray(details.events) ? details.events : [];
    if (g) {
      g.planMoved = true; g.planlessNudges = 0;
      if (events.some((e) => PLAN_PROGRESS.has(e))) g.contextStops = 0;
      // The agent reopened work on a finished goal (revised or re-planned it): the goal is live again.
      if (g.done && !planProgress(p).complete) { g.done = false; this.ledgerOf(g)?.writeControl?.({ status: "running" }); }
    }
    this.bus.emit({ sid, harness: "pi", kind: "plan", ts: Date.now(), goal: g?.text || "", plan: p, progress: planProgress(p), events });
    const why = ["plan_done", "milestone_done", "revised", "created"].find((e) => events.includes(e));
    if (why && g) this.requestSummary(sid, SUMMARY_REASON[why]);
  }

  onSettled(sid) {
    const g = this.goals.get(sid);
    // Consume the "a run happened" flag even when nothing else happens, so a later idle status event
    // (a state refresh, a model switch) is not mistaken for another settle.
    if (g) g.ran = false;
    if (!g || g.paused || g.done || !this.mode(g) || g.checking) return;
    // The run that just settled was a re-engaged one: did the agent do anything (a tool call, a plan move)?
    // A run that failed on the provider's side is not the agent idling (an outage must not pause a long run),
    // and neither is one that stopped while its background agents work.
    if (g.nudged) {
      if (g.progress || g.planMoved) { g.idleNudges = 0; g.compactedForIdle = false; }
      else if (g.stopReason !== "error" && !countOf(this.activeChildren, sid)) g.idleNudges++;
      g.nudged = false;
    }
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
    const mode = this.mode(g);
    if (!mode) return null;
    const full = mode === "full";
    if (!g.managed) this._lastSid = sid;
    g.ran = false;
    g.recheck = false;
    const c = this.config, cp = this.contextPolicy;

    // 0) Background agents this chat started are still working: their reports wake it up, so neither nudge
    //    nor finish (the heartbeat looks again in case nothing delivers them).
    const kids = countOf(this.activeChildren, sid);
    if (kids) {
      if (g.waitingFor !== kids) this.emitLog(sid, `goal hook: waiting for ${kids} background agent${kids === 1 ? "" : "s"}`);
      g.waitingFor = kids; g.recheck = true;
      return { action: "wait-children", reason: `${kids} background agent(s) still running`, children: kids };
    }
    g.waitingFor = 0;

    // Nothing is happening: several re-engagements in a row without a single tool call or plan change.
    // The first time, compact and restate the goal (a fresh start often unsticks it); the second time, pause.
    if (full && g.idleNudges >= c.maxIdleNudges) {
      if (!g.compactedForIdle) return this.unstick(sid, g, pi, seq);
      this.pause(sid, g, "no progress", `goal hook paused: ${g.idleNudges} re-engagements in a row without any progress. Send a message to resume.`);
      return { action: "pause", reason: "no progress" };
    }

    // 1) Stops that were not the agent's choice. With the hook off only an outage is retried.
    if (g.stopReason === "error") {
      if (full || transientError(g.lastError)) return this.recoverFromError(sid, g, pi);
      return { action: "none", reason: "the provider rejected the request (the goal hook is off)" };
    }

    await this.loadPlan(sid, pi);
    if (this.gone(sid, g, seq, pi)) return null;

    const plan = this.plan(sid);
    const pr = plan ? planProgress(plan) : null;
    const open = !!pr && !pr.complete && pr.phase !== "waiting" && pr.phase !== "brainstorm";
    const step = open ? currentStep(plan) : null;
    const planFp = open ? `plan:${step?.id}:${step?.status}:${pr.done}` : "";
    const stop = this.classify(sid, g);

    // The model stopped believing its context or session was used up: never a reason to stop.
    if (stop.kind === "context-stop" && pr?.phase !== "waiting") {
      const maxStops = cp.maxContextNudges * CONTEXT_STOPS_PER_PLAN_MOVE;
      if (g.contextNudges < cp.maxContextNudges && g.contextStops < maxStops) return this.continueAfterContextStop(sid, g, pi, seq, stop, open ? plan : null);
      this.emitLog(sid, g.contextNudges >= cp.maxContextNudges
        ? `goal hook: ${g.contextNudges} context stops in a row without any progress; not continuing it for context again`
        : `goal hook: ${g.contextStops} context stops without the plan moving on; not continuing it for context again`);
    }
    // The output cap went on reasoning before it acted: pi cannot recover a `length` stop at the cap by itself.
    if (stop.kind === "length-cap" && !pr?.complete && pr?.phase !== "waiting" && g.lengthNudges < MAX_LENGTH_NUDGES) {
      g.lengthNudges++;
      const rest = open ? planNudge(plan) : !full ? "" : g.explicit ? PLAN_FIRST : nudgeBody({ goal: g.text, restate: this.restateNow(g) });
      // Without a plan the "same point" is "no tool call since the last one" (a constant would escalate across real work).
      return this.nudge(sid, g, pi, { reason: `the output limit was used up before it acted (${g.lengthNudges}/${MAX_LENGTH_NUDGES})`, body: [LENGTH_NOTE, rest], fp: planFp || `length:${g.toolCalls}` });
    }
    // The hook is off (context auto-continue only): every other stop is the user's to answer.
    if (!full) return { action: "none", reason: stop.reason };
    // The user asked for a handoff and got one: that is the answer, not a stop to override — unless an explicit goal's
    // or an agent's plan is still open (the plan, not one message, says whether the work is finished).
    if (stop.handoff && !(open && (g.explicit || g.managed))) {
      if (g.managed) return this.finish(sid, g, "it wrote the handoff its task asked for");
      this.emitLog(sid, "goal hook: you asked for a handoff; not re-engaging until you reply");
      return { action: "wait", reason: "the user asked for a handoff" };
    }

    const lengthNote = g.stopReason === "length" ? LENGTH_NOTE : "";

    // 2) The plan decides.
    if (pr?.complete) {
      // Work skipped "because of context" is not finished work: send it back once per set of such steps.
      const skips = allSteps(plan).filter((s) => s.status === "skipped" && contextSkipReason(s.note));
      const key = skips.map((s) => s.id).join(",");
      if (skips.length && key !== g.contextSkipKey && g.contextNudges < cp.maxContextNudges) {
        g.contextSkipKey = key; g.contextNudges++;
        return this.nudge(sid, g, pi, { reason: `${skips.length} plan step${skips.length === 1 ? " was" : "s were"} skipped because of context`, body: [contextSkipNudge(skips)], fp: null });
      }
      return this.finish(sid, g, `every step of the plan is done (${pr.done} done${pr.skipped ? `, ${pr.skipped} skipped` : ""})`);
    }
    if (pr?.phase === "waiting") {
      if (g.managed) return this.assumeForAgent(sid, g, pi, plan, pr);
      this.emitLog(sid, `goal hook: waiting for your answer — ${clip(pr.waiting.question, 200)}`);
      return { action: "wait", reason: pr.waiting.question };
    }
    if (open) return this.nudge(sid, g, pi, { reason: `plan step ${step?.id || "?"} is not done (${pr.done + pr.skipped}/${pr.steps})`, body: [lengthNote, planNudge(plan)], fp: planFp });

    // 3) No plan. A question only the user can answer waits for them, for a plain prompt in the user's own
    //    chat: a tracked /goal asks through its plan (ask_user), a background agent has nobody to ask, and
    //    asking permission to go on ("Shall I go ahead?") is stopping part-way, not such a question.
    if (stop.kind === "asks-user" && !g.explicit && !g.managed && !asksToGoOn(g.lastText)) { this.emitLog(sid, "goal hook: it asked you something; waiting for your answer"); return { action: "wait", reason: stop.reason }; }
    if (g.explicit) return this.nudge(sid, g, pi, { reason: "this goal needs a plan first", body: [lengthNote, PLAN_FIRST], fp: "noplan" });
    if (stoppedAbnormally(g.stopReason)) return this.nudge(sid, g, pi, { reason: `it stopped abnormally (${g.stopReason})`, body: [lengthNote, nudgeBody({ goal: g.text, restate: this.restateNow(g) })], fp: fingerprint(g.tail) });
    if (!g.toolCalls) return this.finish(sid, g, "answered without needing any tools", { quiet: true });
    if (c.judgeFallback && this.judge) return this.judgeCheck(sid, g, pi, seq);
    if (g.planlessNudges < c.planlessNudges) {
      g.planlessNudges++;
      // A background agent's last message is its report, so it is asked to give the report, not a one-liner.
      const done = g.managed ? "If the task is completely done and verified, reply with your final report (what you did, the results, file paths) and stop." : "If the request is completely done and verified, reply with one short final answer and stop.";
      return this.nudge(sid, g, pi, { reason: "it stopped after working without a plan", body: [`You stopped after working without a plan. ${done} If anything is left, call the plan tool now (brainstorm, then create a plan for the remaining work) and continue.`], fp: "planless" });
    }
    return this.finish(sid, g, "it stopped normally and did not plan further work", { quiet: true });
  }

  /** What the newest stop means (classifyStop), and whether it is a handoff the user's own message asked for. */
  classify(sid, g) {
    const m = { text: g.lastText, thinking: g.lastThinking, stopReason: g.stopReason, usage: g.lastUsage, maxTokens: countOf(this.maxTokensFor, sid) };
    // An explicit goal's kickoff or an agent's task echo is not "the user asked for a handoff" for the rest of the run,
    // even when the goal itself mentions one ("write a handoff note when done"): only a later user message counts.
    const kickoff = (g.explicit || g.managed) && !!g.lastUserText && String(g.lastUserText).trim().startsWith(String(g.text || "").trim().slice(0, 300));
    const userText = kickoff ? "" : g.lastUserText;
    const k = classifyStop({ ...m, userText });
    return { ...k, handoff: k.kind === "normal" && !!userText && classifyStop(m).kind === "context-stop" };
  }

  /**
   * The model stopped because it believed its context (or session) was used up. pi compacts by itself, so
   * that is never a reason to stop: compact now when the prompt is big enough for it to matter (a quarter
   * of `compactAt`, or 64k without one), then re-engage on the plan's current step.
   */
  async continueAfterContextStop(sid, g, pi, seq, stop, plan) {
    const cp = this.contextPolicy;
    const u = g.lastUsage || {};
    const tokens = (Number(u.input) || 0) + (Number(u.cacheRead) || 0);
    const big = tokens >= (cp.compactAt > 0 ? cp.compactAt * CONTEXT_COMPACT_SHARE : CONTEXT_COMPACT_FLOOR);
    g.contextNudges++; g.contextStops++;
    this.emitLog(sid, `goal hook: ${stop.reason}${tokens ? ` at ${Math.round(tokens / 1000)}k tokens` : ""}; ${big ? "compacting the context, then continuing" : "continuing"}`);
    const compacted = big && await this.compactNow(sid, pi);
    if (this.gone(sid, g, seq, pi)) return { action: "stale" };
    const usagePercent = !big && cp.compactAt > 0 && tokens ? (tokens / cp.compactAt) * 100 : null;
    return this.nudge(sid, g, pi, {
      reason: `${stop.reason}${compacted ? "; context compacted" : ""}`,
      // With a plan, nudge() restates the goal after a compaction; without one it is restated here.
      body: [contextContinueMessage({ compacted, usagePercent }), plan ? planNudge(plan) : compacted && this.restateNow(g) ? `The original goal, verbatim:\n${g.text}` : ""],
      // A context stop is not "stuck at the same point": it never escalates into "skip the step" advice.
      fp: null,
    });
  }

  /**
   * A background agent parked its plan on a question, and nobody answers mid-task: tell it to assume and go
   * on; when it keeps asking, end it (a paused `goal` event) so the agent that started it gets the question now.
   */
  assumeForAgent(sid, g, pi, plan, pr) {
    const q = clip(pr.waiting.question, 400);
    if (g.assumeNudges >= MAX_ASSUME_NUDGES) {
      this.pause(sid, g, `it needs an answer: ${q}`, `goal hook: the background agent keeps asking "${clip(q, 200)}"; ending its run with that question`);
      return { action: "pause", reason: q };
    }
    g.assumeNudges++;
    const step = currentStep(plan);
    return this.nudge(sid, g, pi, {
      reason: `it asked "${clip(q, 120)}"; a background agent has nobody to answer it`,
      body: [`Nobody can answer questions while you work: you are a background agent, and the agent that started you only reads your final report. Make the most reasonable assumption for "${q}", note it (it belongs in your report), then resume the plan with plan action "start" on step ${step?.id || "the next unfinished step"} and continue until the task is done.`],
      fp: null,
    });
  }

  /** The goal an async step started for is no longer the one to act on: replaced by a new prompt, paused, done, or pi runs again. */
  gone(sid, g, seq, pi) { return this.goals.get(sid) !== g || g.seq !== seq || g.paused || g.done || !!pi?.streaming; }

  /** Too many idle re-engagements: compact once (a long, looping context is the usual cause), restate the goal and try again before pausing. */
  async unstick(sid, g, pi, seq) {
    const n = g.idleNudges;
    g.compactedForIdle = true;
    g.idleNudges = Math.max(0, this.config.maxIdleNudges - 2);
    this.emitLog(sid, `goal hook: ${n} re-engagements in a row without any progress; compacting the context and restating the goal before pausing`);
    const compacted = await this.compactNow(sid, pi);
    await this.loadPlan(sid, pi);
    if (this.gone(sid, g, seq, pi)) return { action: "stale" };
    const plan = this.plan(sid);
    const pr = plan ? planProgress(plan) : null;
    const open = !!pr && !pr.complete && pr.phase !== "waiting" && pr.phase !== "brainstorm";
    g.restate = false;
    return this.nudge(sid, g, pi, {
      reason: `no progress in ${n} re-engagements${compacted ? "; context compacted" : ""}, goal restated`,
      body: [
        `You were re-engaged ${n} times in a row without making any progress (no tool call, no plan change).${compacted ? " Your context was compacted for a fresh start." : ""} Re-read the goal below, then take a DIFFERENT APPROACH to whatever blocks you: revise the plan if it is wrong (plan action "revise"), or set the blocked part aside and continue with the rest. Make a concrete tool call now.`,
        `The original goal, verbatim:\n${g.text}`,
        open ? planNudge(plan) : "",
      ],
      fp: "idle", restated: true,
    });
  }

  /** Compact pi's context; true when it worked. A failure is logged, never thrown. */
  async compactNow(sid, pi) {
    if (typeof pi?.compact !== "function") return false;
    try {
      const r = await pi.compact();
      if (r && r.success === false) throw new Error(r.error || "pi refused to compact");
      const g = this.goals.get(sid);
      if (g) g.restate = true; // the summary may have dropped the original prompt
      return true;
    } catch (e) { this.emitLog(sid, `goal hook: compaction failed: ${e.message}`); return false; }
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
    const canCompact = g.errorStops >= c.errorCompactAfter && !g.compactedForError && typeof pi.compact === "function";
    // "400 Provider returned error" reads as an outage but may be a refusal wrapped by the router (an
    // over-long request): once it repeats, compact once before going back to the back-off.
    if (transientError(err) && !(canCompact && REFUSED_CODE.test(err))) {
      const wait = errorBackoff(g.errorStops, { base: c.errorBackoffMs });
      this.emitLog(sid, `goal hook: provider error (${clip(err, 160)}); retrying in ${Math.round(wait / 1000)}s`);
      const seq = g.seq;
      this.clearTimer(g.timer);
      g.timer = this.setTimer(() => {
        g.timer = null;
        const p = this.getPi(sid);
        if (!p || g.seq !== seq || g.paused || g.done || p.streaming || !this.mode(g)) return;
        this.nudge(sid, g, p, { reason: `retrying after a provider error`, body: ["The model provider failed on your last turn; this is a retry. Continue exactly where you left off."], fp: "" }).catch((e) => this.log("retry failed", e.message));
      }, wait);
      return { action: "retry-later", reason: err, waitMs: wait };
    }
    // The provider refuses the request itself (typically a context that grew too long or a malformed tail):
    // repeating it unchanged fails the same way, so compact first.
    if (canCompact) {
      g.compactedForError = true;
      this.emitLog(sid, `goal hook: the provider keeps rejecting the request (${clip(err, 160)}); compacting the context, then retrying`);
      await this.compactNow(sid, pi);
      return this.nudge(sid, g, pi, { reason: "retrying after compacting the context", body: ["The context was compacted after the provider rejected your requests. Continue where you left off."], fp: "" });
    }
    if (g.compactedForError && g.errorStops >= c.errorCompactAfter + 2) {
      // Context size is ruled out by now, so it is usually a request setting the server refuses (for example a
      // thinking level it does not support); "400 status code (no body)" is pi hiding the server's own message.
      this.pause(sid, g, err, `goal hook paused: the provider still rejects the request after compacting (${clip(err, 160)}). This is usually a setting the server refuses, such as the thinking level (try another one, or map it with thinkingLevelMap in models.json). Send a message to resume.`);
      return { action: "pause", reason: err };
    }
    return this.nudge(sid, g, pi, { reason: `retrying after a model error`, body: ["Your last turn failed with a model error. Continue where you left off."], fp: "" });
  }

  /** The goal is finished: latch it, persist "done", and close the status box with a final summary. */
  finish(sid, g, reason, { quiet = false } = {}) {
    g.done = true;
    this.ledgerOf(g)?.writeControl?.({ status: "done" });
    if (!quiet || g.nudges) this.emitLog(sid, `goal hook: done (${reason})`);
    if (g.lastSummary && g.linesSinceSummary && !this.plan(sid)) this.requestSummary(sid, "the goal is finished");
    this.bus.emit({ sid, harness: "pi", kind: "goal", ts: Date.now(), ...this.status(sid), reason });
    return { action: "done", reason };
  }

  /**
   * Re-engage pi with a wrapped, non-echoed prompt. `fp` detects "stuck on the same thing" → escalate; `fp: null`
   * (a context stop, an agent told to assume) is not that kind of stop, so it neither counts toward nor breaks
   * a streak. `restated`: the body already has the goal.
   */
  async nudge(sid, g, pi, { reason, body, fp, restated = false }) {
    const parts = (Array.isArray(body) ? body : [body]).filter(Boolean);
    if (fp !== null) {
      g.sameFailCount = fp && fp === g.lastFingerprint ? g.sameFailCount + 1 : 0;
      g.lastFingerprint = fp;
    }
    const escalate = !!fp && g.sameFailCount + 1 >= this.config.loopK;
    if (escalate) parts.unshift(`You have stopped ${g.sameFailCount + 1} times at the same point without moving on. Do not repeat what failed: try a DIFFERENT APPROACH, or revise the plan (plan action "revise", with the reason), or skip the step with a reason and continue with the rest.`);
    if (!restated && this.plan(sid) && this.restateNow(g)) parts.push(`The original goal, verbatim:\n${g.text}`);
    g.nudges++; g.nudged = true; g.planMoved = false;
    this.ledgerOf(g)?.writeControl?.({ counters: { nudges: g.nudges } });
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
    if (this.gone(sid, g, seq, pi) || g.ran) return { action: "stale" };
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

  /**
   * Re-checks only goals marked `recheck`: a re-engage that could not be sent, a judge with no verdict, a chat
   * waiting on its background agents, a goal restored with `resume` — it never re-checks an idle goal on a timer.
   */
  startHeartbeat() {
    this.stopHeartbeat();
    if (!this.config.heartbeatMs) return;
    this.heartbeatTimer = setInterval(() => {
      for (const [sid, g] of this.goals) {
        const pi = this.getPi(sid);
        if (!g.recheck || !this.mode(g) || !pi || pi.streaming || g.paused || g.checking || g.done) continue;
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
