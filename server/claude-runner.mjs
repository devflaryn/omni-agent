/**
 * Runs Claude Code tasks from Omni:
 *   claude -p --output-format stream-json --include-partial-messages --verbose ...
 * The prompt goes in on stdin (no shell quoting). Each run gets a session id we
 * choose up front (`--session-id`) so the UI can address it before init arrives.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { createLineSplitter } from "./jsonl.mjs";
import { normalizeClaudeStream } from "./normalize.mjs";

export class ClaudeRunner {
  constructor({ bin = "claude", bus }) {
    this.bin = bin;
    this.bus = bus;
    this.runs = new Map(); // sid -> run
  }

  owns(file) {
    const id = basename(String(file || ""), ".jsonl").toLowerCase();
    for (const [, r] of this.runs) if (r.sessionId.toLowerCase() === id && r.alive) return true;
    return false;
  }

  list() {
    return [...this.runs.values()].map(({ proc, ...r }) => r);
  }

  run({ prompt, cwd, model, resume, appendSystem, autonomous = true, maxTurns, allowedTools }) {
    if (!prompt?.trim()) throw new Error("empty prompt");
    const sessionId = resume || randomUUID();
    const sid = `claude:${sessionId}`;
    if (this.runs.get(sid)?.alive) throw new Error("that Claude session is already running");
    const args = ["-p", "--output-format", "stream-json", "--include-partial-messages", "--verbose"];
    if (resume) args.push("--resume", resume); else args.push("--session-id", sessionId);
    if (model) args.push("--model", model);
    if (autonomous) args.push("--dangerously-skip-permissions");
    if (maxTurns) args.push("--max-turns", String(maxTurns));
    if (allowedTools) args.push("--allowedTools", allowedTools);
    if (appendSystem) args.push("--append-system-prompt", appendSystem);

    const proc = spawn(this.bin, args, { cwd, windowsHide: true, shell: false, env: { ...process.env, OMNI_AGENT: "1" } });
    const run = { sid, sessionId, cwd, model: model || null, resume: !!resume, startedAt: Date.now(), alive: true, exitCode: null, cost: 0, proc, prompt: prompt.slice(0, 500) };
    this.runs.set(sid, run);
    const ctx = { sid, harness: "claude" };

    this.bus.emit({ ...ctx, kind: "session", ts: Date.now(), owned: true, cwd, sessionId, model: model || null, title: prompt.replace(/\s+/g, " ").slice(0, 80) });
    this.bus.emit({ ...ctx, kind: "status", ts: Date.now(), streaming: true });
    this.bus.emit({ ...ctx, kind: "msg", ts: Date.now(), id: `u-${Date.now()}`, role: "user", live: true, blocks: [{ type: "text", text: prompt }] });

    let sawResult = false;
    const splitter = createLineSplitter((line) => {
      let obj;
      try { obj = JSON.parse(line); } catch { return this.bus.emit({ ...ctx, kind: "log", ts: Date.now(), level: "raw", text: line.slice(0, 2000) }); }
      if (obj.type === "result") { sawResult = true; run.cost = obj.total_cost_usd || 0; }
      for (const ev of normalizeClaudeStream(obj, ctx)) this.bus.emit(ev);
    });
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (c) => splitter.push(c));
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (t) => this.bus.emit({ ...ctx, kind: "log", ts: Date.now(), level: "stderr", text: t.slice(0, 4000) }));
    proc.on("error", (e) => {
      this.bus.emit({ ...ctx, kind: "msg", ts: Date.now(), id: `err-${Date.now()}`, role: "system", live: true, blocks: [{ type: "text", text: `claude spawn failed: ${e.message}` }] });
    });
    proc.on("exit", (code) => {
      splitter.flush();
      run.alive = false;
      run.exitCode = code;
      run.endedAt = Date.now();
      if (!sawResult) this.bus.emit({ ...ctx, kind: "run", ts: Date.now(), phase: "end", isError: code !== 0, text: `claude exited with code ${code}` });
      this.bus.emit({ ...ctx, kind: "status", ts: Date.now(), streaming: false });
    });
    proc.stdin.on("error", () => {});
    proc.stdin.end(prompt);
    return { sid, sessionId };
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
