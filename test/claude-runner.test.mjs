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
