/**
 * Runs Claude Code tasks from Omni:
 *   claude -p --output-format stream-json --include-partial-messages --verbose ...
 * The prompt goes in on stdin (no shell quoting). A fresh run gets a session id we
 * choose (`--session-id`). A resume keeps the id. A fork (`--resume X --fork-session`)
 * only learns its id from the `system.init` line, so it starts under a pending sid
 * and announces nothing until then.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { createLineSplitter } from "./jsonl.mjs";
import { normalizeClaudeStream } from "./normalize.mjs";

export class ClaudeRunner {
  constructor({ bin = "claude", bus, spawn = nodeSpawn }) {
    this.bin = bin;
    this.bus = bus;
    this.spawn = spawn;
    this.runs = new Map(); // sid -> run
  }

  owns(file) {
    const id = basename(String(file || ""), ".jsonl").toLowerCase();
    for (const [, r] of this.runs) if (r.sessionId && r.sessionId.toLowerCase() === id && r.alive) return true;
    return false;
  }

  list() {
    return [...this.runs.values()].map(({ proc, ...r }) => r);
  }

  run({ prompt, cwd, model, resume, fork = false, forkedFrom = null, appendSystem, autonomous = true, maxTurns, allowedTools }) {
    if (!prompt?.trim()) throw new Error("empty prompt");
    const pending = !!(resume && fork);
    if (fork && !forkedFrom) forkedFrom = `claude:${resume}`;
    const sessionId = pending ? null : resume || randomUUID();
    const sid = pending ? `claude:pending-${randomUUID().slice(0, 8)}` : `claude:${sessionId}`;
    if (!pending && this.runs.get(sid)?.alive) throw new Error("that Claude session is already running");
    const args = ["-p", "--output-format", "stream-json", "--include-partial-messages", "--verbose"];
    if (resume) { args.push("--resume", resume); if (fork) args.push("--fork-session"); }
    else args.push("--session-id", sessionId);
    if (model) args.push("--model", model);
    if (autonomous) args.push("--dangerously-skip-permissions");
    if (maxTurns) args.push("--max-turns", String(maxTurns));
    if (allowedTools) args.push("--allowedTools", allowedTools);
    if (appendSystem) args.push("--append-system-prompt", appendSystem);

    const proc = this.spawn(this.bin, args, { cwd, windowsHide: true, shell: false, env: { ...process.env, OMNI_AGENT: "1" } });
    const run = { sid, sessionId, cwd, model: model || null, resume: !!resume, fork: !!fork, forkedFrom, pending, startedAt: Date.now(), alive: true, exitCode: null, cost: 0, proc, prompt: prompt.slice(0, 500) };
    this.runs.set(sid, run);
    const ctx = { sid, harness: "claude" };
    const title = prompt.replace(/\s+/g, " ").slice(0, 80);

    const announce = () => {
      this.bus.emit({ ...ctx, kind: "session", ts: Date.now(), owned: true, cwd, sessionId: run.sessionId, model: model || null, title, forkedFrom: run.forkedFrom || undefined });
      this.bus.emit({ ...ctx, kind: "status", ts: Date.now(), streaming: true });
      this.bus.emit({ ...ctx, kind: "msg", ts: Date.now(), id: `u-${Date.now()}`, role: "user", live: true, blocks: [{ type: "text", text: prompt }] });
    };
    if (!pending) announce();

    const attrSid = () => (run.pending ? run.forkedFrom : ctx.sid);
    let sawResult = false;
    const splitter = createLineSplitter((line) => {
      let obj;
      try { obj = JSON.parse(line); } catch { return run.pending ? undefined : this.bus.emit({ ...ctx, kind: "log", ts: Date.now(), level: "raw", text: line.slice(0, 2000) }); }
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
      for (const ev of normalizeClaudeStream(obj, ctx)) this.bus.emit(ev);
    });
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (c) => splitter.push(c));
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (t) => this.bus.emit({ sid: attrSid(), harness: "claude", kind: "log", ts: Date.now(), level: "stderr", text: t.slice(0, 4000) }));
    const fail = (text) => this.bus.emit({ sid: attrSid(), harness: "claude", kind: "msg", ts: Date.now(), id: `err-${Date.now()}`, role: "system", live: true, blocks: [{ type: "text", text }] });
    proc.on("error", (e) => fail(`claude spawn failed: ${e.message}`));
    proc.on("exit", (code) => {
      splitter.flush();
      run.alive = false;
      run.exitCode = code;
      run.endedAt = Date.now();
      if (run.pending) { fail(`Fork failed: claude exited with code ${code} before reporting a session id (see omni.log / stderr)`); return; }
      if (!sawResult) this.bus.emit({ ...ctx, kind: "run", ts: Date.now(), phase: "end", isError: code !== 0, text: `claude exited with code ${code}` });
      this.bus.emit({ ...ctx, kind: "status", ts: Date.now(), streaming: false });
    });
    proc.stdin.on("error", () => {});
    proc.stdin.end(prompt);
    return { sid, sessionId, pending };
  }

  abort(sid) {
    const r = this.runs.get(sid);
    if (!r?.alive) return false;
    try { r.proc.kill(); } catch { /* ignore */ }
    return true;
  }

  stopAll() {
    for (const [sid] of this.runs) this.abort(sid);
  }
}
