import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { Bus } from "../server/bus.mjs";
import { ClaudeRunner } from "../server/claude-runner.mjs";

function fakeSpawn(record) {
  return (bin, args, opts) => {
    const p = new EventEmitter();
    p.stdout = new PassThrough(); p.stderr = new PassThrough(); p.stdin = new PassThrough();
    p.pid = 42; p.kill = () => p.emit("exit", 0);
    record.push({ bin, args, opts, proc: p });
    return p;
  };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("resume without fork keeps the session id and passes --resume", () => {
  const calls = [], bus = new Bus();
  const r = new ClaudeRunner({ bin: "claude", bus, spawn: fakeSpawn(calls) });
  const out = r.run({ prompt: "hi", cwd: "C:\\p", resume: "abc" });
  assert.equal(out.sid, "claude:abc");
  assert.equal(out.pending, false);
  const a = calls[0].args;
  assert.ok(a.includes("--resume") && a[a.indexOf("--resume") + 1] === "abc");
  assert.ok(!a.includes("--fork-session"));
  assert.ok(!a.includes("--session-id"));
});

test("fork passes --fork-session, starts pending, re-keys on system.init and announces forkedFrom", async () => {
  const calls = [], bus = new Bus(), events = [];
  bus.on("event", (ev) => events.push(ev));
  const r = new ClaudeRunner({ bin: "claude", bus, spawn: fakeSpawn(calls) });
  const out = r.run({ prompt: "continue please", cwd: "C:\\p", resume: "abc", fork: true, forkedFrom: "claude:abc" });
  assert.match(out.sid, /^claude:pending-[0-9a-f]{8}$/);
  assert.equal(out.pending, true);
  assert.ok(calls[0].args.includes("--fork-session"));
  assert.equal(events.length, 0, "nothing announced before init");
  calls[0].proc.stdout.write(`${JSON.stringify({ type: "system", subtype: "init", session_id: "new-1", cwd: "C:\\p", model: "claude-opus-5" })}\n`);
  await sleep(20);
  assert.ok(r.runs.has("claude:new-1"), "run re-keyed");
  assert.ok(!r.runs.has(out.sid), "pending key removed");
  const sess = events.find((e) => e.kind === "session" && e.forkedFrom === "claude:abc");
  assert.ok(sess, "session event carries forkedFrom");
  assert.equal(sess.sid, "claude:new-1");
  assert.ok(events.some((e) => e.kind === "msg" && e.role === "user" && e.sid === "claude:new-1"), "user prompt echoed under the new sid");
  assert.ok(events.every((e) => !String(e.sid).includes("pending")), "no event ever uses the pending sid");
});

test("a pending fork that exits before init reports the failure on the source session", async () => {
  const calls = [], bus = new Bus(), events = [];
  bus.on("event", (ev) => events.push(ev));
  const r = new ClaudeRunner({ bin: "claude", bus, spawn: fakeSpawn(calls) });
  r.run({ prompt: "x", cwd: "C:\\p", resume: "abc", fork: true, forkedFrom: "claude:abc" });
  calls[0].proc.emit("exit", 1);
  await sleep(10);
  const err = events.find((e) => e.kind === "msg" && e.role === "system");
  assert.equal(err.sid, "claude:abc");
  assert.match(err.blocks[0].text, /fork failed/i);
});

test("owns() ignores pending runs and matches by session id", () => {
  const calls = [], bus = new Bus();
  const r = new ClaudeRunner({ bin: "claude", bus, spawn: fakeSpawn(calls) });
  r.run({ prompt: "x", cwd: "C:\\p", resume: "abc", fork: true });
  r.run({ prompt: "y", cwd: "C:\\p", resume: "def" });
  assert.equal(r.owns("C:\\c\\DEF.jsonl"), true);
  assert.equal(r.owns("C:\\c\\zzz.jsonl"), false);
});

test("fork without forkedFrom defaults to source session and no pending sid in events", async () => {
  const calls = [], bus = new Bus(), events = [];
  bus.on("event", (ev) => events.push(ev));
  const r = new ClaudeRunner({ bin: "claude", bus, spawn: fakeSpawn(calls) });
  r.run({ prompt: "x", cwd: "C:\\p", resume: "abc", fork: true });
  calls[0].proc.emit("exit", 1);
  await sleep(10);
  const err = events.find((e) => e.kind === "msg" && e.role === "system");
  assert.equal(err.sid, "claude:abc", "error routed to source session");
  assert.ok(events.every((e) => !String(e.sid).includes("pending")), "no event ever uses a pending sid");
});

test("stderr from pending fork is routed to source session, never pending sid", async () => {
  const calls = [], bus = new Bus(), events = [];
  bus.on("event", (ev) => events.push(ev));
  const r = new ClaudeRunner({ bin: "claude", bus, spawn: fakeSpawn(calls) });
  r.run({ prompt: "x", cwd: "C:\\p", resume: "abc", fork: true });
  calls[0].proc.stderr.write("some error output\n");
  await sleep(10);
  const log = events.find((e) => e.kind === "log" && e.level === "stderr");
  assert.equal(log.sid, "claude:abc", "stderr routed to source session");
  assert.ok(events.every((e) => !String(e.sid).includes("pending")), "no event ever uses a pending sid");
});

// ---------------------------------------------------------------- interactive runs (background agents)
const lines = (stream) => { const out = []; let buf = ""; stream.on("data", (c) => { buf += c; let i; while ((i = buf.indexOf("\n")) >= 0) { out.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } }); return out; };
const emitLine = (proc, obj) => proc.stdout.write(`${JSON.stringify(obj)}\n`);
const result = (extra = {}) => ({ type: "result", subtype: "success", is_error: false, num_turns: 3, result: "All done: wrote src/x.mjs", stop_reason: "end_turn", total_cost_usd: 0.42, session_id: "s", ...extra });

test("non-interactive argv and stdin are exactly as before", async () => {
  const calls = [], bus = new Bus();
  const r = new ClaudeRunner({ bin: "claude", bus, spawn: fakeSpawn(calls) });
  const out = r.run({ prompt: "do it", cwd: "C:\\p", model: "opus", maxTurns: 5, allowedTools: "Read", appendSystem: "SYS" });
  assert.deepEqual(calls[0].args, ["-p", "--output-format", "stream-json", "--include-partial-messages", "--verbose", "--session-id", out.sessionId, "--model", "opus", "--dangerously-skip-permissions", "--max-turns", "5", "--allowedTools", "Read", "--append-system-prompt", "SYS"]);
  let text = "";
  calls[0].proc.stdin.on("data", (c) => { text += c; });
  await sleep(10);
  assert.equal(text, "do it", "the prompt goes in as plain text");
  assert.equal(calls[0].proc.stdin.writableEnded, true, "and stdin is closed at once");
  assert.equal(calls[0].opts.env.OMNI_AGENT, "1");
});

test("interactive: stream-json input, --permission-prompts none, prompt as one JSON line, stdin kept open until the result", async () => {
  const calls = [], bus = new Bus(), events = [];
  bus.on("event", (ev) => events.push(ev));
  const r = new ClaudeRunner({ bin: "claude", bus, spawn: fakeSpawn(calls) });
  const out = r.run({ prompt: "refactor the parser", cwd: "C:\\p", interactive: true, maxTurns: 300, title: "Refactor", name: "Refactor", meta: { parentSid: "pi:p1", agentId: "a-00000001", agentKind: "claude" } });
  const { args, proc } = calls[0];
  assert.deepEqual(args.slice(0, 7), ["-p", "--output-format", "stream-json", "--include-partial-messages", "--verbose", "--input-format", "stream-json"]);
  assert.ok(args.includes("--dangerously-skip-permissions"));
  assert.equal(args[args.indexOf("--permission-prompts") + 1], "none");
  assert.equal(args[args.indexOf("--name") + 1], "Refactor");
  assert.equal(args[args.indexOf("--max-turns") + 1], "300");
  const sent = lines(proc.stdin);
  await sleep(10);
  assert.deepEqual(sent[0], { type: "user", message: { role: "user", content: [{ type: "text", text: "refactor the parser" }] } });
  assert.equal(proc.stdin.writableEnded, false, "stdin stays open while the turn runs");
  const sess = events.find((e) => e.kind === "session");
  assert.equal(sess.parentSid, "pi:p1");
  assert.equal(sess.agentId, "a-00000001");
  assert.equal(sess.agentKind, "claude");
  assert.equal(sess.sid, out.sid);
  emitLine(proc, { type: "assistant", message: { id: "m1", role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } }, { type: "text", text: "Tests pass." }] } });
  emitLine(proc, result());
  await sleep(10);
  assert.equal(proc.stdin.writableEnded, true, "a result with nothing outstanding closes stdin, so the CLI exits");
  const run = r.runs.get(out.sid);
  assert.equal(run.results, 1);
  assert.deepEqual(run.lastResult, { subtype: "success", isError: false, text: "All done: wrote src/x.mjs", turns: 3, cost: 0.42, stopReason: "end_turn" });
  assert.deepEqual(run.activity, ['Bash({"command":"npm test"})', "Tests pass."]);
  assert.equal(run.pid, 42);
  assert.ok(run.lastEventAt > 0);
  assert.doesNotThrow(() => JSON.stringify(r.list()), "list() is plain JSON (no process handle, no timers)");
  assert.equal(r.list()[0].proc, undefined);
  assert.equal(r.list()[0].ctl, undefined);
});

test("meta also rides on the session event that system.init produces; without meta that event is unchanged", async () => {
  const calls = [], bus = new Bus(), events = [];
  bus.on("event", (ev) => events.push(ev));
  const r = new ClaudeRunner({ bin: "claude", bus, spawn: fakeSpawn(calls) });
  r.run({ prompt: "x", cwd: "C:\\p", interactive: true, meta: { parentSid: "pi:p1", agentId: "a-00000002", agentKind: "claude" } });
  r.run({ prompt: "y", cwd: "C:\\p" });
  emitLine(calls[0].proc, { type: "system", subtype: "init", session_id: "s1", cwd: "C:\\p", model: "opus" });
  emitLine(calls[1].proc, { type: "system", subtype: "init", session_id: "s2", cwd: "C:\\p", model: "opus" });
  await sleep(10);
  const inits = events.filter((e) => e.kind === "session" && e.model === "opus");
  assert.equal(inits.length, 2);
  assert.equal(inits[0].parentSid, "pi:p1");
  assert.equal(inits[0].agentKind, "claude");
  assert.equal("parentSid" in inits[1], false);
});

test("interactive: the nested-session environment of the Claude that started Omni is not inherited", () => {
  const calls = [], bus = new Bus();
  const r = new ClaudeRunner({ bin: "claude", bus, spawn: fakeSpawn(calls) });
  const saved = process.env.CLAUDECODE;
  process.env.CLAUDECODE = "1";
  try {
    r.run({ prompt: "x", cwd: "C:\\p", interactive: true });
    r.run({ prompt: "y", cwd: "C:\\p" });
  } finally { if (saved === undefined) delete process.env.CLAUDECODE; else process.env.CLAUDECODE = saved; }
  assert.equal(calls[0].opts.env.CLAUDECODE, undefined);
  assert.equal(calls[1].opts.env.CLAUDECODE, "1", "non-interactive runs keep today's environment");
});

test("permissionMode other than bypassPermissions replaces --dangerously-skip-permissions", () => {
  const calls = [], bus = new Bus();
  const r = new ClaudeRunner({ bin: "claude", bus, spawn: fakeSpawn(calls) });
  r.run({ prompt: "x", cwd: "C:\\p", interactive: true, permissionMode: "acceptEdits" });
  r.run({ prompt: "y", cwd: "C:\\p", interactive: true, permissionMode: "bypassPermissions" });
  assert.equal(calls[0].args[calls[0].args.indexOf("--permission-mode") + 1], "acceptEdits");
  assert.ok(!calls[0].args.includes("--dangerously-skip-permissions"));
  assert.ok(calls[1].args.includes("--dangerously-skip-permissions") && !calls[1].args.includes("--permission-mode"));
});

test("send() steers a live interactive run: a user line, a live user msg, and stdin stays open for the steer's own result", async () => {
  const calls = [], bus = new Bus(), events = [];
  bus.on("event", (ev) => events.push(ev));
  const r = new ClaudeRunner({ bin: "claude", bus, spawn: fakeSpawn(calls) });
  const { sid } = r.run({ prompt: "build it", cwd: "C:\\p", interactive: true });
  const proc = calls[0].proc;
  const sent = lines(proc.stdin);
  assert.equal(r.send(sid, "also add tests"), true);
  await sleep(10);
  assert.deepEqual(sent[1], { type: "user", message: { role: "user", content: [{ type: "text", text: "also add tests" }] } });
  assert.ok(events.some((e) => e.kind === "msg" && e.role === "user" && e.live && e.blocks[0].text === "also add tests"), "the UI sees the steer");
  emitLine(proc, result({ result: "built" }));
  await sleep(10);
  assert.equal(proc.stdin.writableEnded, false, "the steer is still outstanding");
  const streamingBefore = events.filter((e) => e.kind === "status" && e.streaming === true).length;
  emitLine(proc, { type: "stream_event", event: { type: "message_start", message: { model: "m" } } });
  await sleep(10);
  assert.equal(events.filter((e) => e.kind === "status" && e.streaming === true).length, streamingBefore + 1, "the second turn says it is streaming again");
  emitLine(proc, result({ result: "tests added" }));
  await sleep(10);
  assert.equal(proc.stdin.writableEnded, true);
  assert.equal(r.runs.get(sid).results, 2);
  assert.equal(r.runs.get(sid).lastResult.text, "tests added");
  assert.equal(r.send(sid, "too late"), false, "stdin is closed: no more steering");
  assert.equal(r.send("claude:nope", "x"), false);
});

test("a steer folded into the running turn produces no result of its own: idleEndMs closes stdin anyway", async () => {
  const calls = [], bus = new Bus();
  const r = new ClaudeRunner({ bin: "claude", bus, spawn: fakeSpawn(calls), idleEndMs: 40 });
  const { sid } = r.run({ prompt: "go", cwd: "C:\\p", interactive: true });
  const proc = calls[0].proc;
  r.send(sid, "and this");
  emitLine(proc, result());
  await sleep(15);
  assert.equal(proc.stdin.writableEnded, false);
  await sleep(60);
  assert.equal(proc.stdin.writableEnded, true);
});

test("a folded steer followed by non-turn lines (keep_alive, rate_limit_event, system) still closes stdin after idleEndMs", async () => {
  const calls = [], bus = new Bus();
  const r = new ClaudeRunner({ bin: "claude", bus, spawn: fakeSpawn(calls), idleEndMs: 40 });
  const { sid } = r.run({ prompt: "go", cwd: "C:\\p", interactive: true });
  const proc = calls[0].proc;
  r.send(sid, "and this");
  emitLine(proc, result());
  await sleep(10);
  emitLine(proc, { type: "keep_alive" });
  emitLine(proc, { type: "rate_limit_event", rate_limit_info: { status: "allowed" } });
  emitLine(proc, { type: "system", subtype: "session_state_changed" });
  await sleep(15);
  assert.equal(proc.stdin.writableEnded, false, "not before idleEndMs");
  await sleep(60);
  assert.equal(proc.stdin.writableEnded, true, "lines between turns do not hold stdin open");
});

test("a steer whose own turn starts after the result keeps stdin open past idleEndMs, until that turn's result", async () => {
  const calls = [], bus = new Bus();
  const r = new ClaudeRunner({ bin: "claude", bus, spawn: fakeSpawn(calls), idleEndMs: 40 });
  const { sid } = r.run({ prompt: "go", cwd: "C:\\p", interactive: true });
  const proc = calls[0].proc;
  r.send(sid, "and this");
  emitLine(proc, result());
  await sleep(10);
  emitLine(proc, { type: "stream_event", event: { type: "message_start", message: { model: "m" } } });
  await sleep(80);
  assert.equal(proc.stdin.writableEnded, false, "the steer's turn is running: its result ends the run");
  emitLine(proc, result({ result: "steer done" }));
  await sleep(10);
  assert.equal(proc.stdin.writableEnded, true);
});

/** A process whose spawn failed the way Node reports ENOENT/EACCES: no pid, 'error' then 'close', never 'exit'. */
function failingSpawn(record, code = "ENOENT") {
  return (bin, args, opts) => {
    const p = new EventEmitter();
    p.stdout = new PassThrough(); p.stderr = new PassThrough(); p.stdin = new PassThrough();
    p.pid = undefined; p.kill = () => false;
    process.nextTick(() => { p.emit("error", Object.assign(new Error(`spawn ${bin} ${code}`), { code })); p.emit("close", -4058, null); });
    record.push({ bin, args, opts, proc: p });
    return p;
  };
}

test("a claude that cannot be spawned (error + close, no exit) still ends the run: alive false, one 'exit', an error run end", async () => {
  const calls = [], bus = new Bus(), events = [], exits = [];
  bus.on("event", (ev) => events.push(ev));
  const r = new ClaudeRunner({ bin: "claude-missing", bus, spawn: failingSpawn(calls) });
  r.on("exit", (run) => exits.push(run));
  const { sid } = r.run({ prompt: "x", cwd: "C:\\p", interactive: true });
  await sleep(10);
  const run = r.runs.get(sid);
  assert.equal(run.alive, false);
  assert.equal(run.exitCode, null);
  assert.match(run.error, /^claude could not start: spawn claude-missing ENOENT/);
  assert.equal(exits.length, 1);
  const end = events.find((e) => e.kind === "run" && e.phase === "end");
  assert.equal(end.isError, true);
  assert.match(end.text, /could not start/);
  assert.ok(events.some((e) => e.kind === "status" && e.streaming === false));
  assert.ok(events.some((e) => e.kind === "msg" && e.role === "system" && /claude spawn failed/.test(e.blocks[0].text)));
  calls[0].proc.emit("exit", 1);
  assert.equal(exits.length, 1, "the run ends once");
  assert.equal(r.abort(sid), false, "nothing left to abort");
  assert.doesNotThrow(() => r.run({ prompt: "again", cwd: "C:\\p", resume: run.sessionId, interactive: true }), "the session is free to be resumed");
});

test("a real binary that does not exist ends the run (Node's own ENOENT path)", async () => {
  const bus = new Bus();
  const r = new ClaudeRunner({ bin: "omni-no-such-claude-binary-xyz", bus });
  const ended = new Promise((resolve) => r.once("exit", resolve));
  const { sid } = r.run({ prompt: "x", cwd: process.cwd(), interactive: true });
  const run = await Promise.race([ended, sleep(5000).then(() => null)]);
  assert.ok(run, "the runner emitted 'exit'");
  assert.equal(r.runs.get(sid).alive, false);
  assert.match(run.error, /could not start/);
});

test("an 'error' after a successful spawn (a pid exists) does not end the run", async () => {
  const calls = [], bus = new Bus();
  const r = new ClaudeRunner({ bin: "claude", bus, spawn: fakeSpawn(calls) });
  const { sid } = r.run({ prompt: "x", cwd: "C:\\p", interactive: true });
  calls[0].proc.emit("error", new Error("kill EPERM"));
  await sleep(5);
  assert.equal(r.runs.get(sid).alive, true);
  assert.equal(r.runs.get(sid).error, null);
});

test("send() and interrupt() refuse non-interactive runs", () => {
  const calls = [], bus = new Bus();
  const r = new ClaudeRunner({ bin: "claude", bus, spawn: fakeSpawn(calls) });
  const { sid } = r.run({ prompt: "x", cwd: "C:\\p" });
  assert.equal(r.send(sid, "steer"), false);
  assert.equal(r.interrupt(sid), false);
});

test("interrupt() writes a control_request line", async () => {
  const calls = [], bus = new Bus();
  const r = new ClaudeRunner({ bin: "claude", bus, spawn: fakeSpawn(calls) });
  const { sid } = r.run({ prompt: "x", cwd: "C:\\p", interactive: true });
  const sent = lines(calls[0].proc.stdin);
  assert.equal(r.interrupt(sid), true);
  await sleep(10);
  assert.equal(sent[1].type, "control_request");
  assert.match(sent[1].request_id, /^int-[0-9a-f]{8}$/);
  assert.deepEqual(sent[1].request, { subtype: "interrupt" });
});

test("abort() of an interactive run: interrupt, EOF, then the tree-kill after graceMs, then the plain kill", async () => {
  const calls = [], bus = new Bus(), killed = [];
  const r = new ClaudeRunner({ bin: "claude", bus, spawn: fakeSpawn(calls), graceMs: 30, killTree: (pid) => { killed.push(pid); } });
  const { sid } = r.run({ prompt: "x", cwd: "C:\\p", interactive: true });
  const proc = calls[0].proc;
  const sent = lines(proc.stdin);
  let plainKills = 0;
  proc.kill = () => { plainKills++; proc.emit("exit", 1); };
  assert.equal(r.abort(sid), true);
  await sleep(10);
  assert.equal(sent[1]?.request?.subtype, "interrupt");
  assert.equal(proc.stdin.writableEnded, true);
  assert.deepEqual(killed, [], "the CLI gets graceMs to stop on its own");
  await sleep(50);
  assert.deepEqual(killed, [42]);
  assert.equal(plainKills, 1);
  assert.equal(r.runs.get(sid).alive, false);
});

test("abort() of an interactive run that exits on EOF never tree-kills", async () => {
  const calls = [], bus = new Bus(), killed = [];
  const r = new ClaudeRunner({ bin: "claude", bus, spawn: fakeSpawn(calls), graceMs: 30, killTree: (pid) => { killed.push(pid); } });
  const { sid } = r.run({ prompt: "x", cwd: "C:\\p", interactive: true });
  const proc = calls[0].proc;
  proc.stdin.on("finish", () => proc.emit("exit", 0));
  r.abort(sid);
  await sleep(60);
  assert.deepEqual(killed, []);
});

test("abort() of a non-interactive run: tree-kill first on Windows, then proc.kill(); plain kill elsewhere", async () => {
  for (const platform of ["win32", "linux"]) {
    const calls = [], bus = new Bus(), order = [];
    const r = new ClaudeRunner({ bin: "claude", bus, spawn: fakeSpawn(calls), platform, killTree: (pid) => { order.push(`tree:${pid}`); } });
    const { sid } = r.run({ prompt: "x", cwd: "C:\\p" });
    calls[0].proc.kill = () => { order.push("kill"); calls[0].proc.emit("exit", 0); };
    assert.equal(r.abort(sid), true);
    await sleep(10);
    assert.deepEqual(order, platform === "win32" ? ["tree:42", "kill"] : ["kill"], platform);
    assert.equal(r.abort(sid), false, "nothing left to abort");
  }
});

test("the default tree-kill runs taskkill /T /F through the injected spawn on Windows", async () => {
  const calls = [], bus = new Bus();
  const r = new ClaudeRunner({ bin: "claude", bus, spawn: fakeSpawn(calls), platform: "win32" });
  const { sid } = r.run({ prompt: "x", cwd: "C:\\p", interactive: true });
  r.abort(sid, { graceMs: 0 });
  const tk = calls.find((c) => c.bin === "taskkill");
  assert.deepEqual(tk.args, ["/PID", "42", "/T", "/F"]);
  assert.equal(tk.opts.windowsHide, true);
  tk.proc.emit("exit", 0);
  await sleep(10);
  assert.equal(r.runs.get(sid).alive, false, "the plain kill followed once taskkill was done");
});

test("stopAll() does not wait for a grace period", async () => {
  const calls = [], bus = new Bus(), killed = [];
  const r = new ClaudeRunner({ bin: "claude", bus, spawn: fakeSpawn(calls), graceMs: 60000, killTree: (pid) => { killed.push(pid); } });
  r.run({ prompt: "x", cwd: "C:\\p", interactive: true });
  r.stopAll();
  await sleep(10);
  assert.deepEqual(killed, [42]);
});

test("killProcessTree resolves with the taskkill outcome and never rejects", async () => {
  const { killProcessTree } = await import("../server/claude-runner.mjs");
  const mk = (code) => () => { const p = new EventEmitter(); setImmediate(() => (code === "error" ? p.emit("error", new Error("ENOENT")) : p.emit("exit", code))); return p; };
  assert.equal(await killProcessTree(1234, { spawn: mk(0), platform: "win32" }), true);
  assert.equal(await killProcessTree(1234, { spawn: mk(128), platform: "win32" }), false);
  assert.equal(await killProcessTree(1234, { spawn: mk("error"), platform: "win32" }), false);
  assert.equal(await killProcessTree(1234, { spawn: () => { throw new Error("no spawn"); }, platform: "win32" }), false);
  let killedWith = null;
  assert.equal(await killProcessTree(1234, { platform: "linux", proc: { kill: (s) => { killedWith = s; } } }), true);
  assert.equal(killedWith, "SIGKILL");
  assert.equal(await killProcessTree(null, { proc: { kill() {} } }), false);
});

test("the runner emits 'result' and 'exit' with the run", async () => {
  const calls = [], bus = new Bus(), seen = [];
  const r = new ClaudeRunner({ bin: "claude", bus, spawn: fakeSpawn(calls) });
  r.on("result", (run) => seen.push(["result", run.lastResult.text]));
  r.on("exit", (run) => seen.push(["exit", run.exitCode, run.alive]));
  r.run({ prompt: "x", cwd: "C:\\p", interactive: true });
  emitLine(calls[0].proc, result({ result: "ok" }));
  await sleep(10);
  calls[0].proc.emit("exit", 0);
  assert.deepEqual(seen, [["result", "ok"], ["exit", 0, false]]);
});

test("an error result is recorded as one", async () => {
  const calls = [], bus = new Bus();
  const r = new ClaudeRunner({ bin: "claude", bus, spawn: fakeSpawn(calls) });
  const { sid } = r.run({ prompt: "x", cwd: "C:\\p", interactive: true });
  emitLine(calls[0].proc, result({ subtype: "error_max_turns", is_error: true, result: "" }));
  await sleep(10);
  assert.equal(r.runs.get(sid).lastResult.isError, true);
  assert.equal(r.runs.get(sid).lastResult.subtype, "error_max_turns");
});
