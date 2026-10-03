/**
 * Goal hook: keeps Omni's pi chat alive the way Claude Code's goal loop does.
 *
 * When pi settles, a judge model reads the user's request and the tail of what the agent did and
 * answers "done or not". If the agent stopped early, the keeper re-engages it with a wrapped
 * prompt (`<omni-hook …>`), which the UI shows as a one-line notice instead of a user bubble.
 * There is no cap on re-engagements: it stops only when the agent made no tool call in
 * `maxIdleNudges` re-engaged runs in a row (it is refusing, or cannot act on the request).
 *
 * The judge runs as `pi -p` with no tools and no session, so every provider configured for pi works.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { hookInfo, hookMessage } from "../ui/lib.js";

export const JUDGE_SYSTEM = `You supervise a coding agent working on a user's request. You get the request and the most recent part of the agent's work.
Decide whether the agent may stop now. It may stop when the request is complete, when it asked the user something only the user can answer (a choice, a credential, a confirmation for a destructive step), or when the task is genuinely impossible and it said so.
It must NOT stop when it only described a plan, stopped part-way ("next I will…", "let me know if…"), hit an error it could retry or work around, ran out of steps, or left part of the request untouched.
Reply with exactly one JSON object and nothing else:
{"done": true or false, "reason": "one short sentence", "nudge": "when done is false: one or two sentences telling the agent precisely what to do next"}`;

export const SUMMARY_SYSTEM = `You write a tiny status box for someone watching a coding agent work. You get the goal and the most recent part of the agent's work.
Reply with 2 to 4 short sentences, plain text, no preamble, no markdown headings: what the goal is, what has been done so far, and what is left or the immediate next step. Be concrete and specific; name files/actions. If nothing has happened yet, say so in one sentence.`;

const clip = (s, n) => { const t = String(s ?? ""); return t.length > n ? `${t.slice(0, n)}…` : t; };

/** The text the summarizer reads — the goal plus the recent work tail, within a budget. Pure. */
export function buildSummaryInput({ goal, tail = [] }, { maxChars = 6000 } = {}) {
  let work = [];
  let used = 0;
  for (let i = tail.length - 1; i >= 0; i--) { const line = tail[i]; if (used + line.length > maxChars && work.length) break; work.unshift(line); used += line.length; }
  if (!work.length) work = ["(the agent has not done anything yet)"];
  return [
    "Goal:",
    "<goal>",
    clip(goal, 2000),
    "</goal>",
    "",
    "Most recent work (most recent last):",
    "<work>",
    ...work,
    "</work>",
    "",
    "Write the 2-4 sentence status box now.",
  ].join("\n");
}

/** The text the judge reads. Pure, so it is testable. */
export function buildJudgeInput({ goal, tail = [], nudges = 0, idleNudges = 0, maxIdleNudges = 5, stopReason = "" }, { maxChars = 6000 } = {}) {
  let work = [];
  let used = 0;
  for (let i = tail.length - 1; i >= 0; i--) { const line = tail[i]; if (used + line.length > maxChars && work.length) break; work.unshift(line); used += line.length; }
  if (!work.length) work = ["(the agent produced nothing)"];
  // The framing repeats the role on purpose: small models otherwise answer *as* the user or the agent.
  return [
    "You are the supervisor. You are not the agent and not the user. Do not reply to the material below; judge it.",
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
    `The agent stopped${stopReason ? ` (stop reason: ${stopReason})` : ""}. Times it was already re-engaged for this request: ${nudges}. Re-engagements in a row after which it made no tool call: ${idleNudges} of ${maxIdleNudges} (at ${maxIdleNudges} the supervisor gives up).`,
    "",
    'Answer now with exactly one JSON object and no other text: {"done": true or false, "reason": "...", "nudge": "..."}',
  ].join("\n");
}

/** First JSON object in the judge's reply → `{ done, reason, nudge }`, or null when unusable. */
export function parseVerdict(text) {
  const s = String(text ?? "");
  const start = s.indexOf("{");
  if (start < 0) return null;
  for (let end = s.lastIndexOf("}"); end > start; end = s.lastIndexOf("}", end - 1)) {
    try {
      const j = JSON.parse(s.slice(start, end + 1));
      if (typeof j?.done !== "boolean") return null;
      return { done: j.done, reason: clip(j.reason || "", 300), nudge: clip(j.nudge || "", 600) };
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
 * Ask a model through `pi -p` (no tools, no session, no extensions) and resolve with its text.
 * `cli` is pi's dist/cli.js (run with the current node); `bin` is the fallback launcher.
 */
export function runJudge({ cli, bin = "pi", provider, model, env = {}, cwd, spawn = nodeSpawn, timeoutMs = 120000 }, { system, input }) {
  return new Promise((resolve, reject) => {
    const args = ["-p", "--no-tools", "--no-extensions", "--no-skills", "--no-session", "--no-context-files", "--no-prompt-templates", "--thinking", "off", "--system-prompt", system];
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

/** A short signature of the current failure/tail so the keeper can detect "stuck on the same thing". */
export function fingerprint(tail = []) {
  const last = [...tail].reverse().find((l) => /error|fail|undefined|cannot|exception/i.test(l)) || tail.at(-1) || "";
  return String(last).replace(/0x[0-9a-f]+|\d+/gi, "#").replace(/\s+/g, " ").trim().slice(0, 160);
}

export class GoalKeeper {
  /**
   * @param {object} o
   * @param {(sid: string) => object|null} o.getPi  Omni's pi child when it owns `sid`, else null.
   * @param {(input: string, pick: {provider, model}) => Promise<string>} o.judge  returns the judge's raw reply.
   */
  constructor({ bus, getPi, judge, summarize, config = {}, log = () => {} }) {
    this.bus = bus;
    this.getPi = getPi;
    this.judge = judge;
    // A separate one-off LLM call (runJudge-style) that writes the status box. Optional.
    this.summarizeFn = summarize || null;
    this.config = { enabled: false, provider: "", model: "", maxIdleNudges: 5, graceMs: 2000, summaries: true, heartbeatMs: 60000, loopK: 3, judgeTimeoutMs: 120000, ...config };
    this.heartbeatTimer = null;
    this.log = log;
    // sid -> { text, seq, nudges, idleNudges, nudged, progress, ran, aborted, stopReason, tail: [], timer, checking }
    // The keeper re-engages without limit; it only gives up after `maxIdleNudges` re-engagements in a row
    // during which the agent made no tool call (it is refusing or cannot act), since nudging then loops for nothing.
    this.goals = new Map();
    this.onEvent = this.onEvent.bind(this);
    bus.on("event", this.onEvent);
  }

  dispose() { this.bus.off("event", this.onEvent); this.stopHeartbeat(); for (const g of this.goals.values()) clearTimeout(g.timer); this.goals.clear(); }
  setConfig(patch) { this.config = { ...this.config, ...patch }; if (!this.config.enabled) { for (const g of this.goals.values()) clearTimeout(g.timer); this.stopHeartbeat(); } else this.startHeartbeat(); return this.config; }

  goal(sid) { return this.goals.get(sid) || null; }
  setGoal(sid, text, explicit = false) {
    const prev = this.goals.get(sid);
    if (prev) clearTimeout(prev.timer);
    const g = { text, explicit, seq: (prev?.seq || 0) + 1, nudges: 0, idleNudges: 0, nudged: false, progress: false, ran: false, aborted: false, paused: false, sameFailCount: 0, lastFingerprint: "", stopReason: "", tail: [], timer: null, checking: false };
    this.goals.set(sid, g);
    return g;
  }
  /**
   * Set an **explicit**, persistent goal (from the `/goal` command): it overrides the implicit
   * "last user prompt" goal and is NOT replaced by subsequent plain prompts, so the agent keeps
   * working toward it until the judge says it is done. Empty text clears the explicit lock, so the
   * next prompt becomes the goal again.
   */
  setExplicitGoal(sid, text) {
    const t = String(text ?? "").trim();
    if (!t) { const g = this.goals.get(sid); if (g) g.explicit = false; return g || null; }
    return this.setGoal(sid, t, true);
  }
  /** The user paused the agent: stop nudging until resumed or a new prompt arrives. Not permanent. */
  cancel(sid) { const g = this.goals.get(sid); if (!g) return; clearTimeout(g.timer); g.timer = null; g.paused = true; }
  resume(sid) { const g = this.goals.get(sid); if (!g) return; g.paused = false; }

  onEvent(ev) {
    if (ev.harness !== "pi" || !this.getPi(ev.sid)) return;
    const g = this.goals.get(ev.sid);
    if (ev.kind === "msg" && ev.live) {
      if (ev.role === "user") {
        const text = (ev.blocks || []).map((b) => b.text || "").join("\n");
        // A plain prompt sets the goal, UNLESS an explicit /goal is locked in for this chat.
        if (!hookInfo(text)) { const cur = this.goals.get(ev.sid); if (!(cur && cur.explicit)) this.setGoal(ev.sid, text); }
        return;
      }
      if (!g) return;
      const line = tailLine(ev);
      if (line) { g.tail.push(line); if (g.tail.length > 60) g.tail.splice(0, g.tail.length - 60); }
      if (ev.role === "tool" || (ev.blocks || []).some((b) => b.type === "tool_call")) g.progress = true;
      if (ev.role === "assistant" && ev.stopReason) g.stopReason = ev.stopReason;
      return;
    }
    if (ev.kind === "status" && g) {
      if (ev.streaming === true) { g.ran = true; clearTimeout(g.timer); g.timer = null; }
      else if (ev.streaming === false && g.ran) this.onSettled(ev.sid);
    }
  }

  onSettled(sid) {
    const g = this.goals.get(sid);
    if (!g || g.paused) return;
    // Refresh the status box on every settle (a milestone), independent of the re-engage toggle,
    // using a separate summarizer LLM. Fire-and-forget so it never blocks the goal check.
    this.makeSummary(sid).catch((e) => this.log("summary failed", e.message));
    if (!this.config.enabled || g.checking) return;
    g.ran = false;
    // The run that just settled was a re-engaged one: did the agent actually do anything (a tool call)?
    if (g.nudged) { g.idleNudges = g.progress ? 0 : g.idleNudges + 1; g.nudged = false; }
    g.progress = false;
    clearTimeout(g.timer);
    const seq = g.seq;
    g.timer = setTimeout(() => { g.timer = null; this.check(sid, seq).catch((e) => this.log("goal hook failed", e.message)); }, this.config.graceMs);
  }

  /** Write the status box with the separate summarizer LLM and broadcast it as a `summary` event. */
  async makeSummary(sid) {
    const g = this.goals.get(sid);
    const pi = this.getPi(sid);
    if (!g || !this.summarizeFn || this.config.summaries === false || !pi) return;
    const input = buildSummaryInput({ goal: g.text, tail: g.tail });
    const pick = { provider: this.config.summaryProvider || this.config.provider || pi.state?.model?.provider || "", model: this.config.summaryModel || this.config.model || pi.state?.model?.id || "" };
    const text = clip(String(await this.summarizeFn(input, pick) ?? "").trim(), 1200);
    if (text) this.bus.emit({ sid, harness: "pi", kind: "summary", ts: Date.now(), goal: g.text, explicit: !!g.explicit, nudges: g.nudges, text });
  }

  async check(sid, seq) {
    const g = this.goals.get(sid);
    const pi = this.getPi(sid);
    if (!g || g.seq !== seq || g.paused || !pi || pi.streaming) return null;
    // Consume the "a run just happened" flag; a *new* run started while the judge thinks re-sets it.
    g.ran = false;
    // No permanent give-up: idle nudges are still counted for context, but a true loop is handled by
    // escalation below (try a different approach), never by stopping the keeper for good.
    g.checking = true;
    let verdict = null;
    try {
      const input = buildJudgeInput({ goal: g.text, tail: g.tail, nudges: g.nudges, idleNudges: g.idleNudges, maxIdleNudges: this.config.maxIdleNudges, stopReason: g.stopReason });
      const pick = { provider: this.config.provider || pi.state?.model?.provider || "", model: this.config.model || pi.state?.model?.id || "" };
      const reply = await this.judge(input, pick);
      verdict = parseVerdict(reply);
      if (!verdict) this.emitLog(sid, `goal hook: judge reply was not JSON: ${clip(reply, 200)}`);
    } catch (e) { this.emitLog(sid, `goal hook: judge failed: ${e.message}`); }
    finally { g.checking = false; }
    if (g.seq !== seq || g.paused || pi.streaming || g.ran) return verdict;
    // Fail open: a missing/failed verdict is treated as "not done", so the run never stops on a judge hiccup.
    if (verdict?.done) { this.emitLog(sid, `goal hook: done (${verdict.reason})`); return verdict; }
    const reason = verdict?.reason || "(no judge verdict — assuming not done)";
    const nudge = verdict?.nudge || "";
    // Loop detection: same failure signature loopK times → escalate instead of nudging the same way.
    const fp = fingerprint(g.tail);
    g.sameFailCount = fp && fp === g.lastFingerprint ? g.sameFailCount + 1 : 0;
    g.lastFingerprint = fp;
    const escalate = g.sameFailCount + 1 >= this.config.loopK;
    g.nudges++; g.nudged = true;
    const note = `Goal hook re-engaged the agent (#${g.nudges}${escalate ? ", escalating" : ""})${reason ? `: ${reason}` : ""}`;
    const body = escalate
      ? `You have been stuck on the same problem for ${g.sameFailCount + 1} attempts. STOP repeating it and try a DIFFERENT APPROACH. If a model/tool keeps failing, switch strategy or mark this sub-task blocked in your progress notes and move on to another part of the goal.\n\nThe original goal, verbatim:\n${g.text}\n\n${nudge}`
      : `Automatic goal check: your last turn ended before the request was finished.${reason ? ` ${reason}` : ""}${nudge ? ` ${nudge}` : ""}\n\nThe original goal, verbatim:\n${g.text}\n\nContinue now and stop only when it is completely done, or when you truly need something only the user can provide.`;
    if (escalate && this.onEscalate) { try { await this.onEscalate(sid, g); } catch { /* best effort */ } }
    try {
      await pi.prompt(hookMessage("goal", note, body), { echo: false });
      this.bus.emit({ sid, harness: "pi", kind: "hook", ts: Date.now(), name: "goal", attempt: g.nudges, idle: g.idleNudges, maxIdle: this.config.maxIdleNudges, reason, escalate, text: note });
    } catch (e) { this.emitLog(sid, `goal hook: could not re-engage pi: ${e.message}`); }
    return verdict;
  }

  startHeartbeat() {
    this.stopHeartbeat();
    if (!this.config.heartbeatMs) return;
    this.heartbeatTimer = setInterval(() => {
      if (!this.config.enabled) return;
      for (const [sid, g] of this.goals) {
        const pi = this.getPi(sid);
        if (!pi || pi.streaming || g.paused || g.checking) continue;
        this.check(sid, g.seq).catch((e) => this.log("heartbeat check failed", e.message));
      }
    }, this.config.heartbeatMs);
    this.heartbeatTimer.unref?.();
  }
  stopHeartbeat() { if (this.heartbeatTimer) clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }

  emitLog(sid, text) { this.log(text); this.bus.emit({ sid, harness: "pi", kind: "log", ts: Date.now(), level: "hook", text }); }
}
