/**
 * Background agents: pi subagents, Claude Code sessions and shell jobs that a chat (or one of its
 * agents) starts and keeps working beside. Each one is a plain record in a small registry
 * (agents.json, written atomically) and every change is broadcast as a bus `agent` event.
 *
 *   pi      a chat of its own on the shared OpenCode server (persona from `<personasDir>/<name>.md`) with a managed goal:
 *           the goal keeper re-engages it until its goal event says done (or paused → "stalled").
 *   claude  an interactive ClaudeRunner run (stream-json in and out), steerable while it works,
 *           resumed with --resume once it has exited.
 *   shell   `bash -lc <command>` writing straight into <dir>/<id>.log (no pipe that a daemon it
 *           starts could hold open), watched by readLog / waitFor.
 *
 * Process handles and timers live in `rt` (per id), never in the record, so a record is always
 * plain JSON. Nothing here kills an agent on dispose(); stopAll() does (server shutdown).
 */
import { EventEmitter } from "node:events";
import { spawn as nodeSpawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { killProcessTree } from "./claude-runner.mjs";
import { PLAN_TOOL } from "../ui/plan.js";

export const AGENT_FOOTER = "\n\n(You are a background agent started by another agent for this one task. Work on your own until it is done — nobody will answer questions mid-task, so make reasonable assumptions and note them. Finish with a concise final report: what you did, the results, and file paths.)";
export const AGENT_KINDS = ["pi", "claude", "shell"];
export const FINISHED_STATUSES = new Set(["done", "error", "cancelled", "timeout", "interrupted", "stalled"]);
export const ACTIVE_STATUSES = new Set(["queued", "starting", "running"]);
const MAX_RECORDS = 500, TASK_MAX = 4000, RESULT_MAX = 20000, ACTIVITY_MAX = 8, SHELL_RESULT_MAX = 4000;
const SHELL_TIMEOUT_MIN = 120, MAX_MINUTES = 7 * 24 * 60, TIMER_MAX = 2147483647;
/** Bus `agent` events: at most one per agent per BROADCAST_MS between status changes, with a report preview. */
const BROADCAST_MS = 500, BUS_RESULT_MAX = 2000;
/** waitFor scans at most this much of an existing log, and keeps this much across reads for matches that straddle two. */
const SCAN_START_MAX = 4 * 1024 * 1024, SCAN_CARRY = 64 * 1024;

const isActive = (r) => ACTIVE_STATUSES.has(r.status);
const isFinished = (r) => FINISHED_STATUSES.has(r.status);
const oneLine = (s, n) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const clip = (s, n) => { const t = String(s ?? ""); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const tail = (s, n) => { const t = String(s ?? ""); return t.length > n ? `…${t.slice(-n)}` : t; };
const httpError = (status, message) => Object.assign(new Error(message), { status });
const bad = (m) => httpError(400, m);
const notFound = (id) => httpError(404, `no agent ${id}`);
const minutes = (v, dflt) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.min(MAX_MINUTES, n) : dflt; };

/** Persona file: `---` frontmatter (name, description, tools, model; `tools` as "a, b" or [a, b]) then the system prompt. Pure. */
export function parsePersona(text) {
  const src = String(text ?? "").replace(/^\uFEFF/, "");
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(src);
  const fm = {};
  const unquote = (v) => v.trim().replace(/^(["'])([\s\S]*)\1$/, "$2");
  if (m) for (const line of m[1].split(/\r?\n/)) { const kv = /^([A-Za-z_][\w-]*)[ \t]*:[ \t]*(.*)$/.exec(line); if (kv) fm[kv[1]] = unquote(kv[2]); }
  const tools = String(fm.tools || "").replace(/^\[|\]$/g, "").split(",").map(unquote).filter(Boolean);
  return { name: fm.name || "", description: fm.description || "", tools, model: fm.model || "", body: (m ? src.slice(m[0].length) : src).trim() };
}

/** Git Bash on Windows (a bare "bash" there may be WSL's launcher in System32), "bash" elsewhere. */
export function defaultShell({ platform = process.platform, env = process.env, exists = existsSync } = {}) {
  if (platform !== "win32") return "bash";
  const roots = [env.ProgramFiles, env.ProgramW6432, env["ProgramFiles(x86)"], env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Programs"), "C:\\Program Files"].filter(Boolean);
  for (const r of roots) { const p = join(r, "Git", "bin", "bash.exe"); if (exists(p)) return p; }
  return "bash";
}

/** Readable log text: colour codes dropped, a carriage-return progress line reduced to what it last showed. */
export function cleanLog(text) {
  return String(text ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .split("\n").map((l) => { const s = l.replace(/\r+$/, ""); const i = s.lastIndexOf("\r"); return i >= 0 ? s.slice(i + 1) : s; }).join("\n");
}

function readRange(file, start, end) {
  const len = Math.max(0, end - start);
  if (!len) return Buffer.alloc(0);
  const fd = openSync(file, "r");
  try { const buf = Buffer.alloc(len); const n = readSync(fd, buf, 0, len, start); return buf.subarray(0, n); } finally { closeSync(fd); }
}
/** The last `maxBytes` of a file (empty when it does not exist). */
function readTail(file, maxBytes) {
  try { const size = statSync(file).size; return { text: readRange(file, Math.max(0, size - maxBytes), size).toString("utf8"), cut: size > maxBytes }; } catch { return { text: "", cut: false }; }
}
function tailLines(file, n) {
  const { text, cut } = readTail(file, 512 * 1024);
  const lines = cleanLog(text).split("\n");
  if (cut) lines.shift(); // a partial first line
  if (lines.length && lines.at(-1) === "") lines.pop();
  return lines.slice(-n).join("\n");
}

export class AgentManager extends EventEmitter {
  /**
   * `createPi(opts)` → a PiRpc-like child (start, waitReady, prompt, abort, stop, switchSession, owns, sid,
   * state, streaming, proc; "exit" events); `opts` = {cwd, model, provider, thinking, env, system, tools, meta}, with
   * a persona's prompt as `system` and its tool allowlist (pi names, plus the plan tool) as `tools`, else "" / null.
   * `personasDir` holds the persona files. `claude` → a ClaudeRunner ("exit" events, runs, run, send, abort).
   * `keeper` → the GoalKeeper (setManagedGoal); without one a pi agent is done 3 s (`idleDoneMs`) after it
   * stops streaming; with one, its goal event decides, and `keeperIdleMs` of silence is only the backstop.
   */
  constructor({ bus, config = {}, file = "", dir = "", personasDir = "", createPi, claude, keeper = null, composeSystem = null, piEnv = {}, shellPath = "", shellArgs = ["-lc"], cwd = process.cwd(),
    now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, killTree, spawn = nodeSpawn, log = () => {},
    idleDoneMs = 3000, keeperIdleMs = 30 * 60000, graceMs = 1500, saveDelayMs = 150, pollMs = 500 } = {}) {
    super();
    this.setMaxListeners(500);
    this.bus = bus;
    this.config = { maxConcurrent: 6, maxDepth: 2, maxMinutes: 360, claudePermissionMode: "bypassPermissions", claudeMaxTurns: 300, claudeModel: "", ...config };
    this.file = file; this.dir = dir; this.personasDir = personasDir;
    this.createPi = createPi; this.claude = claude; this.keeper = keeper; this.composeSystem = composeSystem;
    this.piEnv = piEnv; this.shellPath = shellPath; this.shellArgs = shellArgs; this.cwd = cwd;
    this.now = now; this.setTimer = setTimer; this.clearTimer = clearTimer; this.spawn = spawn; this.log = log;
    this.killTree = killTree || ((pid, proc, o = {}) => killProcessTree(pid, { spawn: this.spawn, proc, group: !!o.group }));
    this.idleDoneMs = idleDoneMs; this.keeperIdleMs = keeperIdleMs; this.graceMs = graceMs; this.saveDelayMs = saveDelayMs; this.pollMs = pollMs;
    this.records = new Map(); // id -> record (plain JSON, persisted)
    this.rt = new Map();      // id -> runtime: process handles, timers, the full task (never persisted)
    this.bySid = new Map();   // child chat sid -> agent id
    this.saveTimer = null;
    this.disposed = false;
    this.onBus = this.onBus.bind(this);
    this.onClaudeExit = this.onClaudeExit.bind(this);
    bus?.on?.("event", this.onBus);
    claude?.on?.("exit", this.onClaudeExit);
  }

  setConfig(patch = {}) { this.config = { ...this.config, ...patch }; this.pump(); return this.config; }

  // ------------------------------------------------------------------ queries
  pub(rec) {
    const out = { ...rec, activity: [...(rec.activity || [])] };
    if (rec.kind === "shell" && rec.status === "running" && rec.logFile) { try { out.lastActivityAt = Math.max(rec.lastActivityAt || 0, Math.round(statSync(rec.logFile).mtimeMs)); } catch { /* not written yet */ } }
    return out;
  }
  get(id) { const r = this.records.get(String(id)); return r ? this.pub(r) : null; }
  list({ parentSid, parentSessionId, active } = {}) {
    // Reversed first so agents started in the same millisecond still come newest first (the sort is stable).
    return [...this.records.values()].reverse()
      .filter((r) => (!parentSid || r.parentSid === parentSid) && (!parentSessionId || r.parentSessionId === parentSessionId) && (!active || isActive(r)))
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((r) => this.pub(r));
  }
  /** Finished agents of that chat whose report has not been handed to it yet, oldest first. */
  undelivered(parentSessionId) {
    return [...this.records.values()].filter((r) => isFinished(r) && !r.delivered && (!parentSessionId || r.parentSessionId === parentSessionId))
      .sort((a, b) => (a.endedAt || 0) - (b.endedAt || 0)).map((r) => this.pub(r));
  }
  /** Agents still queued, starting or running under that chat (the goal keeper waits for them). */
  /** Active agents under a chat; `kinds` narrows it (the goal keeper waits for pi/claude agents, not for a long-lived shell job). */
  activeChildren(parentSid, { kinds = null } = {}) { let n = 0; for (const r of this.records.values()) if (parentSid && r.parentSid === parentSid && isActive(r) && (!kinds || kinds.includes(r.kind))) n++; return n; }
  /** The live PiRpc of a pi agent's chat (the keeper's getPi), else null. */
  piFor(sid) { const id = this.bySid.get(sid); const rt = id && this.rt.get(id); return rt?.pi?.proc && this.records.get(id)?.kind === "pi" ? rt.pi : null; }
  /** True when a live pi agent writes that session file (the watcher must not tail it twice). */
  owns(file) { for (const rt of this.rt.values()) if (rt.pi?.owns?.(file)) return true; return false; }
  /** The agent whose own chat is `sid` (its current or an earlier one), else null. */
  agentBySid(sid) {
    if (!sid) return null;
    const id = this.bySid.get(sid);
    if (id && this.records.has(id)) return this.records.get(id);
    for (const r of this.records.values()) if (r.sid === sid) return r;
    return null;
  }
  activeCount() { let n = 0; for (const r of this.records.values()) if (r.status === "starting" || r.status === "running") n++; return n; }

  /** Persona `<personasDir>/<name>.md` (or the file whose frontmatter has that name). Throws a 400 when unknown. */
  persona(name) {
    const n = String(name ?? "").trim();
    if (!/^[\w.-]+$/.test(n)) throw bad(`bad agent persona name "${n}"`);
    const dir = this.personasDir || "";
    let text = null;
    if (dir) { try { text = readFileSync(join(dir, `${n}.md`), "utf8"); } catch { /* look it up by its frontmatter name */ } }
    if (text == null) for (const p of this.personas()) if (p.name === n) { text = readFileSync(p.file, "utf8"); break; }
    if (text == null) {
      const known = this.personas().map((p) => p.name);
      throw bad(`unknown agent persona "${n}"${known.length ? ` (known: ${known.join(", ")})` : " (no personas are installed)"}`);
    }
    const p = parsePersona(text);
    return { ...p, name: p.name || n };
  }
  personas() {
    const dir = this.personasDir || "";
    if (!dir) return [];
    let files = [];
    try { files = readdirSync(dir).filter((f) => f.endsWith(".md")); } catch { return []; }
    const out = [];
    for (const f of files) { try { const p = parsePersona(readFileSync(join(dir, f), "utf8")); out.push({ name: p.name || f.slice(0, -3), description: p.description, tools: p.tools, model: p.model, file: join(dir, f) }); } catch { /* unreadable */ } }
    return out;
  }

  // ------------------------------------------------------------------ start
  /** Validates the spec and queues the agent; it starts at once when a slot is free. Throws (status 400) on a bad spec. */
  start(spec = {}) {
    const s = spec && typeof spec === "object" ? spec : {};
    const kind = String(s.kind || (s.command && !s.task ? "shell" : "pi"));
    if (!AGENT_KINDS.includes(kind)) throw bad(`unknown agent kind "${kind}" (pi, claude or shell)`);
    const task = String(s.task ?? "").trim(), command = String(s.command ?? "").trim();
    if (kind === "shell" ? !command : !task) throw bad(kind === "shell" ? "a shell job needs a command" : "an agent needs a task");
    // A shared `opencode serve` cannot hand each chat its own OMNI_AGENT_DEPTH, so a caller that gives none (the
    // OpenCode plugin) is placed by its chat: an agent's own chat is at that agent's depth, any other chat at 0.
    const given = s.depth !== undefined && s.depth !== null && s.depth !== "";
    const callerDepth = Math.max(0, Math.floor(Number(given ? s.depth : this.agentBySid(s.parentSid)?.depth) || 0));
    // A shell job cannot start anything itself, so the nesting limit only applies to agents.
    if (kind !== "shell" && callerDepth + 1 > this.config.maxDepth) throw bad(`agents nest at most ${this.config.maxDepth} deep and this caller is already at depth ${callerDepth}: do this work yourself instead of starting another agent`);
    let persona = null;
    if (s.agent) { if (kind === "shell") throw bad("a shell job takes no agent persona"); persona = this.persona(s.agent); }
    const cwd = String(s.cwd || this.cwd || process.cwd());
    if (!existsSync(cwd)) throw bad(`working directory not found: ${cwd}`);
    const now = this.now();
    const id = this.newId();
    const rec = {
      id, kind,
      title: oneLine(s.title || String(kind === "shell" ? command : task).split(/\r?\n/).find((l) => l.trim()) || kind, 80),
      task: kind === "shell" ? "" : clip(task, TASK_MAX), command: kind === "shell" ? clip(command, TASK_MAX) : "",
      cwd, model: String(s.model || ""), provider: String(s.provider || ""), thinking: String(s.thinking || ""), agent: persona ? String(s.agent) : "",
      parentSid: s.parentSid ? String(s.parentSid) : null, parentSessionId: s.parentSessionId ? String(s.parentSessionId) : null,
      /** The agent's own nesting level: 1 = started by the user's chat (a shell job sits at its caller's level). */
      depth: kind === "shell" ? callerDepth : callerDepth + 1,
      status: "queued", createdAt: now, queuedAt: now, startedAt: null, endedAt: null, lastActivityAt: now,
      sid: null, sessionId: null, sessionFile: null, pid: null, exitCode: null, turns: 0, toolCalls: 0, cost: 0,
      resultText: "", error: null, delivered: false, activity: [], logFile: null,
      timeoutMinutes: minutes(s.timeoutMinutes, kind === "shell" ? SHELL_TIMEOUT_MIN : this.config.maxMinutes),
      resume: s.resume ? String(s.resume) : null, steer: !!s.steer,
      memory: !!s.memory, graph: !!s.graph,
    };
    this.records.set(id, rec);
    this.runtime(id).task = kind === "shell" ? command : task;
    this.prune();
    this.touch(rec);
    this.pump();
    return this.pub(rec);
  }

  newId() { let id; do { id = `a-${randomBytes(4).toString("hex")}`; } while (this.records.has(id)); return id; }
  runtime(id) {
    let rt = this.rt.get(id);
    if (!rt) { rt = { gen: 0, task: "", followup: null, pi: null, run: null, proc: null, stopping: null, prompted: false, sawStreaming: false, texts: [], timers: {}, turnsBase: 0, costBase: 0 }; this.rt.set(id, rt); }
    return rt;
  }
  later(ms, fn) { const t = this.setTimer(fn, Math.max(0, Math.min(TIMER_MAX, ms))); t?.unref?.(); return t; }
  clear(rt, name) { if (rt.timers[name]) { this.clearTimer(rt.timers[name]); rt.timers[name] = null; } }
  clearTimers(rt) { for (const k of Object.keys(rt.timers)) this.clear(rt, k); }

  /** Starts queued agents, oldest first, while there are free slots. */
  pump() {
    if (this.pumping || this.disposed) return;
    this.pumping = true;
    try {
      while (this.activeCount() < this.config.maxConcurrent) {
        let next = null;
        for (const r of this.records.values()) if (r.status === "queued" && (!next || r.queuedAt < next.queuedAt)) next = r;
        if (!next) break;
        this.launch(next);
      }
    } finally { this.pumping = false; }
  }

  launch(rec) {
    const rt = this.runtime(rec.id);
    const gen = ++rt.gen;
    Object.assign(rt, { stopping: null, prompted: false, sawStreaming: false, texts: [] });
    Object.assign(rec, { status: "starting", startedAt: this.now(), endedAt: null, error: null, exitCode: null, delivered: false, lastActivityAt: this.now() });
    this.clearTimers(rt);
    const mins = rec.timeoutMinutes;
    rt.timers.timeout = this.later(mins * 60000, () => { rt.timers.timeout = null; this.terminate(rec.id, "timeout", `stopped after its ${mins}-minute limit`).catch(() => {}); });
    this.touch(rec);
    const go = rec.kind === "pi" ? this.launchPi(rec, rt, gen) : rec.kind === "claude" ? this.launchClaude(rec, rt, gen) : this.launchShell(rec, rt, gen);
    go.catch((e) => { if (rt.gen === gen && isActive(rec)) this.finish(rec, "error", { error: `could not start: ${e?.message || e}` }); });
  }

  bindSid(rec, sid) {
    if (rec.sid && rec.sid !== sid && this.bySid.get(rec.sid) === rec.id) this.bySid.delete(rec.sid);
    rec.sid = sid || null;
    if (sid) this.bySid.set(sid, rec.id);
  }

  // ------------------------------------------------------------------ pi
  async launchPi(rec, rt, gen) {
    if (typeof this.createPi !== "function") throw new Error("pi agents are not available (no createPi)");
    const persona = rec.agent ? this.persona(rec.agent) : null;
    // The vault memory pack (and repo graph) when asked for, as a Claude agent gets it: the shared server's chats have
    // no recall of their own (OMNI_MEMORY=server), so it rides in the agent's system prompt after its persona.
    const extra = (rec.memory || rec.graph) && this.composeSystem ? await Promise.resolve(this.composeSystem(rec, rt.followup ?? rt.task)).catch(() => "") : "";
    if (rt.gen !== gen || rt.stopping) return;
    const system = [persona?.body, extra].filter(Boolean).join("\n\n");
    // The tools are an allowlist over plugin tools too: keep the plan tool the goal keeper works with. agent_* is
    // not added: it would let a restricted persona start an unrestricted agent, so a persona that should delegate
    // lists agent_start itself.
    const tools = persona?.tools.length ? [...new Set([...persona.tools, PLAN_TOOL])] : null;
    // The spec's model wins; else the persona's ("provider/id"); else the caller's provider default.
    const model = rec.model || persona?.model || "";
    const provider = rec.model ? rec.provider : persona?.model ? "" : rec.provider;
    const env = { ...this.piEnv, OMNI_AGENT_ID: rec.id, OMNI_AGENT_DEPTH: String(rec.depth), OMNI_PARENT_SID: rec.parentSid || "" };
    const pi = this.createPi({ cwd: rec.cwd, model, provider, thinking: rec.thinking, env, system, tools, meta: { parentSid: rec.parentSid, agentId: rec.id, agentKind: "pi" } });
    rt.pi = pi;
    pi.on?.("exit", (code) => this.onPiExit(rec.id, gen, pi, code));
    pi.start();
    await pi.waitReady();
    if (rt.gen !== gen || rt.stopping) return;
    // A message after the end continues the agent's own session; spec.resume continues a given session file.
    const file = rt.followup != null ? rec.sessionFile : rec.resume;
    if (file) await pi.switchSession(file);
    if (rt.gen !== gen || rt.stopping) return;
    this.bindSid(rec, pi.sid);
    rec.sessionId = pi.state?.sessionId || rec.sessionId;
    rec.sessionFile = pi.state?.sessionFile || rec.sessionFile;
    rec.pid = pi.proc?.pid ?? null;
    const text = rt.followup ?? rt.task;
    rt.followup = null;
    this.keeper?.setManagedGoal?.(pi.sid, text);
    rec.status = "running";
    rec.lastActivityAt = this.now();
    this.touch(rec);
    rt.prompted = true;
    const r = await pi.prompt(text + AGENT_FOOTER, { echo: true });
    if (r && r.success === false) throw new Error(r.error || "pi refused the prompt");
  }

  onPiExit(id, gen, pi, code) {
    const rec = this.records.get(id), rt = this.rt.get(id);
    if (!rec || !rt || rt.gen !== gen || rt.pi !== pi) return;
    rt.pi = null;
    // An agent whose process dies is reported, not relaunched: stop() keeps PiRpc from restarting it.
    try { pi.stop(); } catch { /* gone */ }
    if (rt.stopping || !isActive(rec)) return;
    rec.exitCode = code ?? null;
    this.finish(rec, "error", { error: `pi exited unexpectedly (code ${code})` });
  }

  /** Free the child: tree-kill (its bash tools and their children), then PiRpc.stop() as the backstop. */
  stopPi(pi) {
    const proc = pi?.proc, pid = proc?.pid;
    try { pi.stopped = true; pi.stopWatchdog?.(); } catch { /* fake */ }
    if (pid) { try { Promise.resolve(this.killTree(pid, proc)).catch(() => {}); } catch { /* ignore */ } }
    this.later(pid ? this.graceMs : 0, () => { try { pi.stop(); } catch { /* gone */ } });
  }

  onPiStatus(rec, rt, streaming) {
    if (streaming) { rt.sawStreaming = true; this.clear(rt, "idle"); return; }
    if (!rt.sawStreaming || rec.status !== "running") return;
    this.armIdle(rec, rt);
  }
  /** Not streaming any more: without a keeper that is the end; with one it is only a backstop. Children keep it alive. */
  armIdle(rec, rt) {
    this.clear(rt, "idle");
    const gen = rt.gen;
    rt.timers.idle = this.later(this.keeper ? this.keeperIdleMs : this.idleDoneMs, () => {
      rt.timers.idle = null;
      if (rt.gen !== gen || rec.status !== "running" || rt.pi?.streaming) return;
      if (rec.sid && this.activeChildren(rec.sid, { kinds: ["pi", "claude"] }) > 0) return this.armIdle(rec, rt);
      this.finish(rec, "done");
    });
  }

  onGoal(rec, ev) {
    if (rec.kind !== "pi" || rec.status !== "running") return;
    if (ev.done) this.finish(rec, "done");
    else if (ev.paused) this.finish(rec, "stalled", { error: ev.reason ? `the goal keeper paused it: ${ev.reason}` : "the goal keeper paused it" });
  }

  /** A pi agent's report: its last text, with the longer one before it when the last is only a short sign-off. */
  piReport(rt, current) {
    const t = rt.texts;
    const last = t.at(-1);
    if (!last) return current;
    if (last.length < 300) { const longer = t.slice(0, -1).reverse().find((x) => x.length >= 300); if (longer) return clip(`${longer}\n\n${last}`, RESULT_MAX); }
    return clip(last, RESULT_MAX);
  }

  // ------------------------------------------------------------------ claude
  async launchClaude(rec, rt, gen) {
    if (!this.claude) throw new Error("Claude agents are not available");
    const persona = rec.agent ? this.persona(rec.agent) : null;
    const followup = rt.followup;
    rt.followup = null;
    const resume = followup != null ? rec.sessionId : rec.resume;
    rt.turnsBase = rec.turns; rt.costBase = rec.cost;
    // The vault memory pack / repo graph the old blocking /api/claude/task gave Claude, when the caller asks for it.
    const extra = (rec.memory || rec.graph) && this.composeSystem ? await Promise.resolve(this.composeSystem(rec, followup ?? rt.task)).catch(() => "") : "";
    if (rt.gen !== gen || rt.stopping) return;
    const r = this.claude.run({
      prompt: (followup ?? rt.task) + AGENT_FOOTER, cwd: rec.cwd, model: rec.model || this.config.claudeModel || undefined,
      interactive: true, autonomous: true, permissionMode: this.config.claudePermissionMode, maxTurns: this.config.claudeMaxTurns,
      title: rec.title, name: rec.title, appendSystem: [persona?.body, extra].filter(Boolean).join("\n\n") || undefined,
      meta: { parentSid: rec.parentSid, agentId: rec.id, agentKind: "claude" }, resume: resume || undefined,
    });
    if (rt.gen !== gen) return;
    rt.run = this.claude.runs?.get?.(r.sid) || null;
    this.bindSid(rec, r.sid);
    rec.sessionId = r.sessionId || rec.sessionId;
    rec.pid = rt.run?.pid ?? null;
    rec.status = "running";
    rt.prompted = true;
    this.touch(rec);
  }

  onClaudeExit(run) {
    const id = this.bySid.get(run?.sid);
    const rec = id && this.records.get(id), rt = id && this.rt.get(id);
    if (!rec || !rt || rec.kind !== "claude" || (rt.run && rt.run !== run)) return;
    rt.run = null;
    const lr = run.lastResult;
    if (lr?.text) rec.resultText = clip(lr.text, RESULT_MAX);
    rec.exitCode = run.exitCode ?? null;
    // A message arrived while the run was winding down: continue the session now that it has exited.
    if (rt.followup != null) return this.requeue(rec);
    if (!isActive(rec)) return this.touch(rec);
    // run.error: the CLI never ran (claude not on PATH, a wrong claudeBin).
    const isErr = run.error ? true : lr ? lr.isError : run.exitCode !== 0;
    const error = !isErr ? null : run.error ? run.error : lr ? `${lr.subtype || "error"}${lr.text ? `: ${oneLine(lr.text, 300)}` : ""}` : `claude exited with code ${run.exitCode}`;
    this.finish(rec, isErr ? "error" : "done", { error });
  }

  // ------------------------------------------------------------------ shell
  async launchShell(rec, rt, gen) {
    if (!this.dir) throw new Error("no log directory for shell jobs");
    mkdirSync(this.dir, { recursive: true });
    rec.logFile = join(this.dir, `${rec.id}.log`);
    // The job writes into the file itself, so nothing in Omni holds a pipe a daemon it starts could keep open.
    // "w", not "a": MSYS bash cannot write through an append-only Windows handle (its echo fails).
    const fd = openSync(rec.logFile, "w");
    let proc;
    try {
      proc = this.spawn(this.shellPath || defaultShell(), [...this.shellArgs, rt.task], {
        cwd: rec.cwd, windowsHide: true, shell: false, detached: process.platform !== "win32", stdio: ["ignore", fd, fd],
        env: { ...process.env, CHERE_INVOKING: "1", OMNI_AGENT_ID: rec.id, OMNI_AGENT_DEPTH: String(rec.depth), OMNI_PARENT_SID: rec.parentSid || "" },
      });
    } finally { closeSync(fd); }
    if (rt.gen !== gen) return;
    rt.proc = proc;
    rec.pid = proc.pid ?? null;
    rec.status = "running";
    this.touch(rec);
    // 'error' after a successful spawn (a failed kill) is not the end of the job; only a spawn that never ran is.
    proc.on("error", (e) => { if (proc.pid == null) this.onShellExit(rec.id, proc, null, null, e); else this.log(`agents: ${rec.id} shell error`, e.message); });
    proc.on("exit", (code, signal) => this.onShellExit(rec.id, proc, code, signal, null));
  }

  onShellExit(id, proc, code, signal, err) {
    const rec = this.records.get(id), rt = this.rt.get(id);
    if (!rec || !rt || rt.proc !== proc) return;
    rt.proc = null;
    rec.exitCode = code ?? null;
    rec.resultText = this.logTail(rec);
    if (!isActive(rec)) return this.touch(rec);
    if (err) return this.finish(rec, "error", { error: `could not run the shell: ${err.message}` });
    this.finish(rec, code === 0 ? "done" : "error", { error: code === 0 ? null : `exit code ${code}${signal ? ` (${signal})` : ""}` });
  }

  killShell(proc) {
    const alive = () => proc.exitCode == null && proc.signalCode == null;
    const fallback = () => { if (alive()) { try { proc.kill(); } catch { /* gone */ } } };
    try { Promise.resolve(this.killTree(proc.pid, proc, { group: process.platform !== "win32" })).then(fallback, fallback); } catch { fallback(); }
  }

  logTail(rec) { return rec.logFile ? tail(cleanLog(readTail(rec.logFile, SHELL_RESULT_MAX * 4).text), SHELL_RESULT_MAX).trim() : ""; }

  /** A shell job's log tail; for pi and Claude agents their recent activity lines. */
  readLog(id, { tailLines: n = 80 } = {}) {
    const rec = this.records.get(String(id));
    if (!rec) throw notFound(id);
    const lines = Math.max(1, Math.min(5000, Math.floor(Number(n) || 80)));
    if (rec.kind !== "shell") return rec.activity.slice(-lines).join("\n");
    return rec.logFile ? tailLines(rec.logFile, lines) : "";
  }

  /** A matcher over a job's log that reads only what was appended since its last call (carrying a window across reads). */
  logScanner(rec) {
    let pos = null, carry = "";
    const dec = new StringDecoder("utf8");
    return (re) => {
      if (rec.kind !== "shell") return re.test([...rec.activity, rec.resultText].join("\n"));
      if (!rec.logFile) return false;
      let size;
      try { size = statSync(rec.logFile).size; } catch { return false; }
      if (pos === null) pos = Math.max(0, size - SCAN_START_MAX);
      if (size < pos) { pos = 0; carry = ""; }
      if (size === pos) return false;
      let text;
      try { text = dec.write(readRange(rec.logFile, pos, size)); } catch { return false; }
      pos = size;
      const hay = carry + cleanLog(text);
      carry = hay.slice(-SCAN_CARRY);
      return re.test(hay);
    };
  }

  /**
   * Resolves when the log matches `until` (a regular expression, multiline), the job finished, the
   * timeout passed or the signal aborted: `{ matched, status, tail }`.
   */
  waitFor(id, { until = "", timeoutMs = 300000, signal } = {}) {
    const rec = this.records.get(String(id));
    if (!rec) return Promise.reject(notFound(id));
    let re = null;
    if (until) { try { re = new RegExp(String(until), "m"); } catch (e) { return Promise.reject(bad(`"until" is not a valid regular expression: ${e.message}`)); } }
    const scan = this.logScanner(rec);
    return new Promise((resolve) => {
      let over = false, poll = null, timer = null;
      const end = (matched) => {
        if (over) return;
        over = true;
        if (poll) this.clearTimer(poll);
        if (timer) this.clearTimer(timer);
        this.off("change", onChange);
        signal?.removeEventListener?.("abort", onAbort);
        resolve({ matched, status: rec.status, tail: this.readLog(rec.id, { tailLines: 40 }) });
      };
      const check = () => {
        if (over) return;
        if (re && scan(re)) return end(true);
        if (isFinished(rec)) return end(false);
      };
      const onChange = (a) => { if (a?.id === rec.id) check(); };
      const onAbort = () => end(false);
      const tick = () => { poll = null; check(); if (!over) poll = this.later(this.pollMs, tick); };
      check();
      if (over) return;
      if (signal?.aborted) return end(false);
      this.on("change", onChange);
      signal?.addEventListener?.("abort", onAbort, { once: true });
      poll = this.later(this.pollMs, tick);
      timer = this.later(Math.max(0, Number(timeoutMs) || 0), () => { timer = null; check(); end(false); });
    });
  }

  // ------------------------------------------------------------------ live events
  onBus(ev) {
    if (!ev?.sid || ev.kind === "agent") return;
    const id = this.bySid.get(ev.sid);
    const rec = id && this.records.get(id), rt = id && this.rt.get(id);
    if (!rec || !rt) return;
    if (ev.kind === "goal") return this.onGoal(rec, ev);
    if (!isActive(rec)) return;
    rec.lastActivityAt = ev.ts || this.now();
    if (ev.kind === "msg" && ev.live && ev.role === "assistant") this.onAssistant(rec, rt, ev);
    else if (ev.kind === "run" && rec.kind === "claude") {
      // The report itself is taken from the run's last result when the process exits (onClaudeExit).
      if (Number.isFinite(ev.turns)) rec.turns = Math.max(rec.turns, rt.turnsBase + ev.turns);
      if (Number.isFinite(ev.cost)) rec.cost = Math.max(rec.cost, rt.costBase + ev.cost);
      this.touch(rec);
    } else if (ev.kind === "status" && rec.kind === "pi" && typeof ev.streaming === "boolean") this.onPiStatus(rec, rt, ev.streaming);
  }

  onAssistant(rec, rt, ev) {
    const blocks = ev.blocks || [];
    const text = blocks.filter((b) => b.type === "text" && b.text).map((b) => b.text).join("\n").trim();
    const calls = blocks.filter((b) => b.type === "tool_call");
    rec.toolCalls += calls.length;
    for (const c of calls) this.pushActivity(rec, `${c.name}(${oneLine(JSON.stringify(c.args ?? {}), 80)})`);
    if (text) {
      this.pushActivity(rec, oneLine(text, 160));
      rec.resultText = clip(text, RESULT_MAX);
      rt.texts.push(text);
      if (rt.texts.length > 4) rt.texts.shift();
    }
    if (rec.kind === "pi") { rec.turns++; if (Number.isFinite(ev.cost)) rec.cost += ev.cost; }
    this.touch(rec);
  }
  pushActivity(rec, line) { rec.activity.push(line); if (rec.activity.length > ACTIVITY_MAX) rec.activity.splice(0, rec.activity.length - ACTIVITY_MAX); }

  // ------------------------------------------------------------------ ending
  /** Latch a final status (once per run), release whatever is still alive, and start the next queued agent. */
  finish(rec, status, { error, now = false } = {}) {
    if (!isActive(rec)) return false;
    const rt = this.runtime(rec.id);
    this.clearTimers(rt);
    if (rec.kind === "pi") rec.resultText = this.piReport(rt, rec.resultText);
    rec.status = status;
    rec.endedAt = this.now();
    if (error !== undefined) rec.error = error ? clip(error, 2000) : null;
    this.release(rec, rt, { now });
    this.touch(rec);
    this.pump();
    return true;
  }

  release(rec, rt, { now = false } = {}) {
    if (rt.pi) { const pi = rt.pi; rt.pi = null; this.stopPi(pi); }
    if (rt.run?.alive && rec.sid) { try { this.claude.abort(rec.sid, now ? { graceMs: 0 } : undefined); } catch { /* gone */ } }
    if (rt.proc && rt.proc.exitCode == null && rt.proc.signalCode == null) this.killShell(rt.proc);
  }

  requeue(rec) {
    const rt = this.runtime(rec.id);
    this.clearTimers(rt);
    Object.assign(rec, { status: "queued", queuedAt: this.now(), endedAt: null, error: null, delivered: false });
    this.touch(rec);
    this.pump();
  }

  async terminate(id, status = "cancelled", reason = null, { now = false } = {}) {
    const rec = this.records.get(String(id));
    if (!rec) throw notFound(id);
    if (!isActive(rec)) return this.pub(rec);
    const rt = this.runtime(rec.id);
    rt.stopping = status;
    rt.followup = null;
    this.finish(rec, status, { error: reason, now });
    return this.pub(rec);
  }
  cancel(id) { return this.terminate(id, "cancelled", "cancelled"); }
  /** Server shutdown: every agent still going is stopped at once and recorded as interrupted. */
  stopAll() {
    // Queued ones first, so a slot freed by a running one is not handed to a queued one on the way out.
    const active = [...this.records.values()].filter(isActive).sort((a, b) => (b.status === "queued") - (a.status === "queued"));
    return Promise.all(active.map((r) => this.terminate(r.id, "interrupted", "Omni shut down while it was running", { now: true }).catch(() => null)));
  }

  /**
   * Message an agent. pi: while it streams the message is queued ("followUp", or "steer" with
   * `steer`); idle, it starts a new run; after it ended its session is reopened ("restarted").
   * Claude: a live run is steered ("steer"); otherwise its session is resumed ("resumed").
   */
  async message(id, text, { steer } = {}) {
    const rec = this.records.get(String(id));
    if (!rec) throw notFound(id);
    const t = String(text ?? "").trim();
    if (!t) throw bad("empty message");
    if (rec.kind === "shell") throw bad("a shell job takes no messages; start a new job instead");
    const rt = this.runtime(rec.id);
    if (rec.status === "queued" || (rec.status === "starting" && !rt.prompted)) {
      if (rt.followup != null) rt.followup += `\n\n${t}`; else rt.task += `\n\n${t}`;
      return { ok: true, how: "followUp" };
    }
    if (rec.kind === "pi") {
      const pi = rt.pi;
      if (pi?.proc && isActive(rec)) {
        const streaming = !!pi.streaming;
        const behavior = (steer ?? rec.steer) ? "steer" : "followUp";
        const r = await pi.prompt(t, { echo: true, behavior });
        if (r && r.success === false) throw httpError(409, r.error || "pi refused the message");
        if (!streaming) { this.clear(rt, "idle"); rec.status = "running"; }
        rec.delivered = false;
        this.touch(rec);
        return { ok: true, how: streaming ? behavior : "followUp" };
      }
      if (!rec.sessionFile) throw httpError(409, "this agent has no session to continue");
      rt.followup = t;
      this.requeue(rec);
      return { ok: true, how: "restarted" };
    }
    const run = rec.sid ? this.claude?.runs?.get?.(rec.sid) : null;
    if (run?.alive) {
      if (this.claude.send(rec.sid, t)) { rec.delivered = false; this.touch(rec); return { ok: true, how: "steer" }; }
      // The run is winding down: onClaudeExit resumes it with every message that arrives meanwhile.
      rt.followup = rt.followup != null ? `${rt.followup}\n\n${t}` : t;
      return { ok: true, how: "resumed" };
    }
    if (!rec.sessionId) throw httpError(409, "this Claude agent has no session to resume");
    rt.followup = t;
    this.requeue(rec);
    return { ok: true, how: "resumed" };
  }

  markDelivered(id) {
    const rec = this.records.get(String(id));
    if (!rec || !isFinished(rec)) return false;
    if (!rec.delivered) { rec.delivered = true; this.touch(rec); }
    return true;
  }

  /**
   * Resolves as soon as any selected agent is finished (at once when one already is, or when none is
   * still going), at `timeoutMs`, or when `signal` aborts: `{ finished, pending }`. Selected: `ids` plus
   * every agent of `parentSessionId` (all agents when neither is given), minus delivered ones with `undeliveredOnly`.
   */
  wait({ ids, parentSessionId, undeliveredOnly = false, timeoutMs = 300000, signal } = {}) {
    const want = new Set((Array.isArray(ids) ? ids : ids ? [ids] : []).map(String));
    const all = !want.size && !parentSessionId;
    const pick = () => {
      const sel = [...this.records.values()].filter((r) => (all || want.has(r.id) || (parentSessionId && r.parentSessionId === parentSessionId)) && (!undeliveredOnly || !r.delivered));
      return { finished: sel.filter(isFinished).map((r) => this.pub(r)), pending: sel.filter(isActive).map((r) => this.pub(r)) };
    };
    const first = pick();
    if (first.finished.length || !first.pending.length || signal?.aborted) return Promise.resolve(first);
    return new Promise((resolve) => {
      let over = false, timer = null;
      const end = () => {
        if (over) return;
        over = true;
        this.off("change", onChange);
        signal?.removeEventListener?.("abort", end);
        if (timer) this.clearTimer(timer);
        resolve(pick());
      };
      const onChange = () => { const o = pick(); if (o.finished.length || !o.pending.length) end(); };
      this.on("change", onChange);
      signal?.addEventListener?.("abort", end, { once: true });
      timer = this.later(Math.max(0, Number(timeoutMs) || 0), end);
    });
  }

  // ------------------------------------------------------------------ registry
  /** Every change: the in-process "change" event at once (wait() listens), the registry soon, the bus throttled. */
  touch(rec) {
    this.emit("change", this.pub(rec));
    this.scheduleSave();
    this.broadcast(rec);
  }

  /**
   * The bus `agent` event. A status change goes out at once; other changes (activity while it works)
   * at most every BROADCAST_MS per agent, trailing. The report is clipped to a preview: the bus ring and
   * every browser would otherwise carry 20 KB per event (GET /api/agents/:id has the whole record).
   */
  broadcast(rec) {
    if (!this.bus?.emit) return;
    const rt = this.runtime(rec.id);
    const send = () => {
      rt.lastBroadcast = this.now();
      rt.lastStatus = rec.status;
      const agent = this.pub(rec);
      agent.resultText = clip(agent.resultText, BUS_RESULT_MAX);
      this.bus.emit({ sid: rec.parentSid || "agents", harness: "omni", kind: "agent", ts: rt.lastBroadcast, agent });
    };
    const due = (rt.lastBroadcast || 0) + BROADCAST_MS;
    if (rec.status !== rt.lastStatus || this.now() >= due) { this.clear(rt, "broadcast"); return send(); }
    if (!rt.timers.broadcast) rt.timers.broadcast = this.later(due - this.now(), () => { rt.timers.broadcast = null; send(); });
  }

  /** At most MAX_RECORDS: the oldest finished records go first. */
  prune() {
    if (this.records.size <= MAX_RECORDS) return;
    const old = [...this.records.values()].filter(isFinished).sort((a, b) => (a.endedAt || a.createdAt || 0) - (b.endedAt || b.createdAt || 0));
    for (const r of old.slice(0, this.records.size - MAX_RECORDS)) {
      this.records.delete(r.id);
      this.rt.delete(r.id);
      if (r.sid && this.bySid.get(r.sid) === r.id) this.bySid.delete(r.sid);
    }
  }

  scheduleSave() {
    if (!this.file || this.saveTimer || this.disposed) return;
    this.saveTimer = this.later(this.saveDelayMs, () => { this.saveTimer = null; this.save(); });
  }
  save() {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ version: 1, savedAt: this.now(), agents: [...this.records.values()] })}\n`);
      renameSync(tmp, this.file);
    } catch (e) { this.log("agents: could not save the registry", e.message); }
  }

  /** On boot: load the registry; anything that was still going lost its process with the old server → "interrupted". */
  reconcile() {
    let data = null;
    if (this.file) { try { data = JSON.parse(readFileSync(this.file, "utf8")); } catch (e) { if (e.code !== "ENOENT") this.log("agents: unreadable registry, starting empty", e.message); } }
    const list = Array.isArray(data) ? data : Array.isArray(data?.agents) ? data.agents : [];
    let changed = false;
    for (const raw of list) {
      if (!raw || typeof raw !== "object" || !/^a-[0-9a-f]{8}$/.test(String(raw.id)) || this.records.has(raw.id) || !AGENT_KINDS.includes(raw.kind)) continue;
      const rec = { ...raw, activity: Array.isArray(raw.activity) ? raw.activity.slice(-ACTIVITY_MAX).map(String) : [], delivered: !!raw.delivered, turns: Number(raw.turns) || 0, toolCalls: Number(raw.toolCalls) || 0, cost: Number(raw.cost) || 0, createdAt: Number(raw.createdAt) || 0 };
      rec.queuedAt = Number(rec.queuedAt) || rec.createdAt;
      if (!FINISHED_STATUSES.has(rec.status)) {
        Object.assign(rec, { status: "interrupted", endedAt: this.now(), error: "Omni restarted while it was running; its process is gone" });
        if (rec.kind === "shell") rec.resultText = this.logTail(rec);
        changed = true;
      }
      this.records.set(rec.id, rec);
      if (rec.sid) this.bySid.set(rec.sid, rec.id);
    }
    const before = this.records.size;
    this.prune();
    if (changed || this.records.size !== before) this.save();
    return this.list();
  }

  /** Stop timers and listeners and write the registry; the agents themselves keep running. */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.bus?.off?.("event", this.onBus);
    this.claude?.off?.("exit", this.onClaudeExit);
    for (const rt of this.rt.values()) this.clearTimers(rt);
    if (this.saveTimer) { this.clearTimer(this.saveTimer); this.saveTimer = null; }
    this.save();
  }
}
