/**
 * Runs Claude Code tasks from Omni:
 *   claude -p --output-format stream-json --include-partial-messages --verbose ...
 * The prompt goes in on stdin (no shell quoting). A fresh run gets a session id we
 * choose (`--session-id`). A resume keeps the id. A fork (`--resume X --fork-session`)
 * only learns its id from the `system.init` line, so it starts under a pending sid
 * and announces nothing until then.
 *
 * `interactive` runs (background agents) add `--input-format stream-json`: the prompt is one
 * JSON user line and stdin stays open, so `send()` can steer the run and `interrupt()` can stop
 * a turn. When a turn's `result` arrives with no steer outstanding, stdin is closed and the CLI exits.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { createLineSplitter } from "./jsonl.mjs";
import { normalizeClaudeStream } from "./normalize.mjs";

/**
 * Kill a process and everything it started. Windows: `taskkill /PID <pid> /T /F` (Node's `kill()` only
 * terminates the top process, which orphans Claude's shells and MCP servers). Elsewhere: the process
 * group when the child leads one (`group`, spawned detached), else the process. Resolves true when the
 * kill command reported success; never rejects.
 */
export function killProcessTree(pid, { spawn = nodeSpawn, proc = null, platform = process.platform, group = false, timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    if (!pid) { try { proc?.kill(); } catch { /* gone */ } return resolve(false); }
    if (platform === "win32") {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
      const done = (ok) => { clearTimeout(timer); resolve(ok); };
      let k;
      try { k = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", shell: false }); } catch { return done(false); }
      k?.on?.("error", () => done(false));
      k?.on?.("exit", (code) => done(code === 0));
      return;
    }
    try { if (group) { process.kill(-pid, "SIGKILL"); return resolve(true); } } catch { /* not a group leader */ }
    try { if (proc) proc.kill("SIGKILL"); else process.kill(pid, "SIGKILL"); resolve(true); } catch { resolve(false); }
  });
}

/** One stream-json input line carrying a user message. */
const userLine = (text) => `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } })}\n`;
const ACTIVITY_MAX = 8;
const oneLine = (s, n) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
/** Environment a nested Claude Code would mistake for being inside the session that started Omni. */
const NESTED_ENV = ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_ENTRYPOINT"];

export class ClaudeRunner extends EventEmitter {
  /**
   * `killTree(pid, proc)`: tree-kill used by abort (default: killProcessTree through `spawn`, so a test's
   * fake spawn sees the taskkill too). `graceMs`: an interactive abort's wait between interrupt + EOF and
   * the kill. `idleEndMs`: a steer that Claude folded into the running turn produces no result of its own,
   * so after a result with a steer outstanding, this long without a new turn starting also ends the run.
   * Only turn output (stream_event, assistant) counts: keep_alive, rate_limit_event and other system lines
   * between turns do not hold stdin open.
   */
  constructor({ bin = "claude", bus, spawn = nodeSpawn, killTree, graceMs = 3000, idleEndMs = 120000, platform = process.platform }) {
    super();
    this.bin = bin;
    this.bus = bus;
    this.spawn = spawn;
    this.platform = platform;
    this.killTree = killTree || ((pid, proc) => killProcessTree(pid, { spawn: this.spawn, proc, platform: this.platform }));
    this.graceMs = graceMs;
    this.idleEndMs = idleEndMs;
    this.runs = new Map(); // sid -> run
  }

  owns(file) {
    const id = basename(String(file || "").replace(/\\/g, "/"), ".jsonl").toLowerCase();
    for (const [, r] of this.runs) if (r.sessionId && r.sessionId.toLowerCase() === id && r.alive) return true;
    return false;
  }

  list() {
    return [...this.runs.values()].map(({ proc, ctl, ...r }) => r);
  }

  run({ prompt, cwd, model, resume, fork = false, forkedFrom = null, appendSystem, autonomous = true, maxTurns, allowedTools, title, interactive = false, permissionPrompts, permissionMode, meta = {}, name }) {
    if (!prompt?.trim()) throw new Error("empty prompt");
    const pending = !!(resume && fork);
    if (fork && !forkedFrom) forkedFrom = `claude:${resume}`;
    const sessionId = pending ? null : resume || randomUUID();
    const sid = pending ? `claude:pending-${randomUUID().slice(0, 8)}` : `claude:${sessionId}`;
    if (!pending && this.runs.get(sid)?.alive) throw new Error("that Claude session is already running");
    const args = ["-p", "--output-format", "stream-json", "--include-partial-messages", "--verbose"];
    if (interactive) args.push("--input-format", "stream-json");
    if (resume) { args.push("--resume", resume); if (fork) args.push("--fork-session"); }
    else args.push("--session-id", sessionId);
    if (model) args.push("--model", model);
    // bypassPermissions is what --dangerously-skip-permissions means; any other mode is passed as is.
    if (permissionMode && permissionMode !== "bypassPermissions") args.push("--permission-mode", permissionMode);
    else if (autonomous) args.push("--dangerously-skip-permissions");
    // Unattended: anything that would still ask is denied (listed in result.permission_denials) instead of hanging.
    const prompts = permissionPrompts || (interactive && autonomous ? "none" : "");
    if (prompts) args.push("--permission-prompts", prompts);
    if (maxTurns) args.push("--max-turns", String(maxTurns));
    if (allowedTools) args.push("--allowedTools", allowedTools);
    if (name) args.push("--name", String(name).slice(0, 120));
    if (appendSystem) args.push("--append-system-prompt", appendSystem);

    const env = { ...process.env, OMNI_AGENT: "1" };
    if (interactive) for (const k of NESTED_ENV) delete env[k];
    const proc = this.spawn(this.bin, args, { cwd, windowsHide: true, shell: false, env });
    const run = {
      sid, sessionId, cwd, model: model || null, resume: !!resume, fork: !!fork, forkedFrom, pending, startedAt: Date.now(), alive: true, exitCode: null, cost: 0, proc, prompt: prompt.slice(0, 500),
      interactive: !!interactive, pid: proc?.pid ?? null, results: 0, lastResult: null, lastEventAt: Date.now(), activity: [], outstanding: 0, stdinOpen: !!interactive, streaming: true, meta, error: null,
      ctl: { idleTimer: null, killTimer: null },
    };
    this.runs.set(sid, run);
    const ctx = { sid, harness: "claude" };
    const hasMeta = !!meta && Object.keys(meta).length > 0;
    title = (title || prompt).replace(/\s+/g, " ").slice(0, 80);

    const announce = () => {
      this.bus.emit({ ...meta, ...ctx, kind: "session", ts: Date.now(), owned: true, cwd, sessionId: run.sessionId, model: model || null, title, forkedFrom: run.forkedFrom || undefined });
      this.bus.emit({ ...ctx, kind: "status", ts: Date.now(), streaming: true });
      this.bus.emit({ ...ctx, kind: "msg", ts: Date.now(), id: `u-${Date.now()}`, role: "user", live: true, blocks: [{ type: "text", text: prompt }] });
    };
    if (!pending) announce();

    const attrSid = () => (run.pending ? run.forkedFrom : ctx.sid);
    let sawResult = false;
    const splitter = createLineSplitter((line) => {
      run.lastEventAt = Date.now();
      let obj;
      try { obj = JSON.parse(line); } catch { return run.pending ? undefined : this.bus.emit({ ...ctx, kind: "log", ts: Date.now(), level: "raw", text: line.slice(0, 2000) }); }
      // The steer's own turn has started (its result will close stdin): the folded-steer backstop is not needed.
      // Anything else between turns (keep_alive, rate_limit_event, system lines) leaves the backstop armed.
      if (run.ctl.idleTimer && (obj?.type === "stream_event" || obj?.type === "assistant")) { clearTimeout(run.ctl.idleTimer); run.ctl.idleTimer = null; }
      if (run.pending && obj.type === "system" && obj.subtype === "init" && obj.session_id) {
        this.runs.delete(run.sid);
        run.sessionId = obj.session_id;
        run.sid = ctx.sid = `claude:${obj.session_id}`;
        run.pending = false;
        this.runs.set(run.sid, run);
        announce();
      }
      if (run.pending) return; // nothing to attribute yet
      if (obj.type === "result") { sawResult = true; run.cost = obj.total_cost_usd || 0; }
      if (obj.type === "assistant") this.noteActivity(run, obj.message?.content);
      // A later turn of an interactive run (after a steer) streams again after its result said "not streaming".
      if (!run.streaming && (obj.type === "stream_event" || obj.type === "assistant")) { run.streaming = true; this.bus.emit({ ...ctx, kind: "status", ts: Date.now(), streaming: true }); }
      for (const ev of normalizeClaudeStream(obj, ctx)) this.bus.emit(hasMeta && ev.kind === "session" ? { ...meta, ...ev } : ev);
      if (obj.type === "result") this.onResult(run, obj);
    });
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (c) => splitter.push(c));
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (t) => this.bus.emit({ sid: attrSid(), harness: "claude", kind: "log", ts: Date.now(), level: "stderr", text: t.slice(0, 4000) }));
    const fail = (text) => this.bus.emit({ sid: attrSid(), harness: "claude", kind: "msg", ts: Date.now(), id: `err-${Date.now()}`, role: "system", live: true, blocks: [{ type: "text", text }] });
    // The end of the run, once: on 'exit', or on the 'error' of a spawn that never ran (ENOENT/EACCES: Node
    // then emits 'error' and 'close' but no 'exit', and the run would otherwise stay alive forever).
    let ended = false;
    const end = (code, spawnError = null) => {
      if (ended) return;
      ended = true;
      splitter.flush();
      run.alive = false;
      run.exitCode = code;
      run.endedAt = Date.now();
      run.stdinOpen = false;
      run.streaming = false;
      if (spawnError) run.error = `claude could not start: ${spawnError.message}`;
      for (const k of ["idleTimer", "killTimer"]) if (run.ctl[k]) { clearTimeout(run.ctl[k]); run.ctl[k] = null; }
      if (run.pending) {
        if (!spawnError) fail(`Fork failed: claude exited with code ${code} before reporting a session id (see omni.log / stderr)`);
        this.emit("exit", run);
        return;
      }
      if (!sawResult) this.bus.emit({ ...ctx, kind: "run", ts: Date.now(), phase: "end", isError: !!spawnError || code !== 0, text: spawnError ? run.error : `claude exited with code ${code}` });
      this.bus.emit({ ...ctx, kind: "status", ts: Date.now(), streaming: false });
      this.emit("exit", run);
    };
    // An 'error' after a successful spawn (a failed kill, a stdin write) is not the end of the run.
    proc.on("error", (e) => { fail(`claude spawn failed: ${e.message}`); if (proc.pid == null) end(null, e); });
    proc.on("exit", (code) => end(code));
    proc.stdin.on("error", () => {});
    if (interactive) proc.stdin.write(userLine(prompt));
    else proc.stdin.end(prompt);
    return { sid, sessionId, pending };
  }

  /** Tool calls as `name(args)` and text as one short line: the last few things the run did. */
  noteActivity(run, content) {
    if (!Array.isArray(content)) return;
    for (const c of content) {
      let line = "";
      if (c?.type === "tool_use") line = `${c.name}(${oneLine(JSON.stringify(c.input ?? {}), 80)})`;
      else if (c?.type === "text" && c.text?.trim()) line = oneLine(c.text, 160);
      if (!line) continue;
      run.activity.push(line);
      if (run.activity.length > ACTIVITY_MAX) run.activity.splice(0, run.activity.length - ACTIVITY_MAX);
    }
  }

  onResult(run, obj) {
    run.results++;
    run.streaming = false;
    run.lastResult = { subtype: obj.subtype || "", isError: !!obj.is_error || (obj.subtype || "success") !== "success", text: obj.result || "", turns: obj.num_turns || 0, cost: obj.total_cost_usd || 0, stopReason: obj.stop_reason || null };
    this.emit("result", run);
    if (!run.interactive || !run.stdinOpen) return;
    if (run.outstanding > 0) {
      run.outstanding--;
      // Keep stdin open for the steer's own turn; if it never comes (the steer was folded into this one), end anyway.
      run.ctl.idleTimer = setTimeout(() => { run.ctl.idleTimer = null; if (run.alive && run.stdinOpen) { run.outstanding = 0; this.endStdin(run); } }, this.idleEndMs);
      run.ctl.idleTimer.unref?.();
      return;
    }
    this.endStdin(run);
  }

  endStdin(run) {
    run.stdinOpen = false;
    try { run.proc.stdin.end(); } catch { /* already closed */ }
  }

  /** Steer a live interactive run: one more user message on its stdin (Claude queues it). False when that is impossible. */
  send(sid, text) {
    const r = this.runs.get(sid);
    if (!r?.alive || !r.interactive || !r.stdinOpen || !String(text ?? "").trim()) return false;
    try { r.proc.stdin.write(userLine(String(text))); } catch { return false; }
    r.outstanding++;
    if (r.ctl.idleTimer) { clearTimeout(r.ctl.idleTimer); r.ctl.idleTimer = null; }
    const ctx = { sid: r.sid, harness: "claude" };
    if (!r.streaming) { r.streaming = true; this.bus.emit({ ...ctx, kind: "status", ts: Date.now(), streaming: true }); }
    this.bus.emit({ ...ctx, kind: "msg", ts: Date.now(), id: `u-${Date.now()}`, role: "user", live: true, blocks: [{ type: "text", text: String(text) }] });
    return true;
  }

  /** Ask an interactive run to stop its current turn (it answers with a control_response, then a result). */
  interrupt(sid) {
    const r = this.runs.get(sid);
    if (!r?.alive || !r.interactive || !r.stdinOpen) return false;
    try { r.proc.stdin.write(`${JSON.stringify({ type: "control_request", request_id: `int-${randomUUID().slice(0, 8)}`, request: { subtype: "interrupt" } })}\n`); } catch { return false; }
    return true;
  }

  /** `graceMs` (interactive only): how long interrupt + EOF get before the tree-kill; 0 kills at once. */
  abort(sid, { graceMs = this.graceMs } = {}) {
    const r = this.runs.get(sid);
    if (!r?.alive) return false;
    if (r.interactive) {
      // Interrupt + EOF lets the CLI clean up its own children; the tree-kill is the backstop.
      this.interrupt(sid);
      r.outstanding = 0;
      this.endStdin(r);
      if (graceMs <= 0) { this.killRun(r); return true; }
      if (!r.ctl.killTimer) {
        r.ctl.killTimer = setTimeout(() => { r.ctl.killTimer = null; if (r.alive) this.killRun(r); }, graceMs);
        r.ctl.killTimer.unref?.();
      }
      return true;
    }
    // Windows: taskkill /T first (it needs the root alive to find the tree), then the plain kill as before.
    if (this.platform === "win32" && r.pid) { this.killRun(r); return true; }
    try { r.proc.kill(); } catch { /* ignore */ }
    return true;
  }

  /** Tree-kill, then the plain kill once taskkill is done (or after 1.5 s at most). */
  killRun(r) {
    let fired = false;
    const after = () => { if (fired) return; fired = true; if (r.alive) { try { r.proc.kill(); } catch { /* ignore */ } } };
    const t = setTimeout(after, 1500);
    t.unref?.();
    let out;
    try { out = this.killTree(r.pid, r.proc); } catch { out = null; }
    Promise.resolve(out).then(after, after).finally(() => clearTimeout(t));
  }

  /** Server shutdown: nothing waits for a grace period. */
  stopAll() {
    for (const sid of [...this.runs.keys()]) this.abort(sid, { graceMs: 0 });
  }
}
