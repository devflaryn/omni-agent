import { test } from "node:test";
import assert from "node:assert/strict";
import { planContinue, isLiveInTerminal } from "../server/continue.mjs";

const now = 1_800_000_000_000;
const claudeClosed = { sid: "claude:abc", harness: "claude", owned: false, streaming: false, lastActivity: now - 600_000, mtime: now - 600_000, cwd: "C:\\p", file: "C:\\c\\abc.jsonl" };
const claudeLive = { ...claudeClosed, lastActivity: now - 5_000 };
const piClosed = { sid: "pi:111", harness: "pi", owned: false, streaming: false, lastActivity: now - 600_000, mtime: now - 600_000, cwd: "C:\\p", file: "C:\\s\\x_111.jsonl" };
const piLive = { ...piClosed, streaming: true };

test("unknown session is a 404", () => {
  assert.deepEqual(planContinue(null, { now }), { action: "error", status: 404, error: "unknown session" });
});

test("closed Claude session resumes in place", () => {
  assert.deepEqual(planContinue(claudeClosed, { now }), { action: "claude", resume: "abc", fork: false, cwd: "C:\\p" });
});

test("Claude session active in a terminal is forked", () => {
  const p = planContinue(claudeLive, { now });
  assert.equal(p.action, "claude");
  assert.equal(p.fork, true);
});

test("forceFork forks even a closed Claude session", () => {
  assert.equal(planContinue(claudeClosed, { now, forceFork: true }).fork, true);
});

test("a Claude run already alive in Omni is a 409", () => {
  assert.equal(planContinue(claudeClosed, { now, claudeAlive: true }).status, 409);
});

test("Omni-owned Claude session that ended resumes in place (never forks)", () => {
  const owned = { ...claudeLive, owned: true };
  assert.equal(planContinue(owned, { now }).fork, false);
});

test("pi: Omni's pi already on this session just prompts", () => {
  assert.deepEqual(planContinue(piClosed, { now, piAlive: true, piSid: "pi:111" }), { action: "pi-prompt" });
});

test("pi: closed session switches without clone; starts pi when it is not running", () => {
  assert.deepEqual(planContinue(piClosed, { now, piAlive: false }), { action: "pi-switch", file: "C:\\s\\x_111.jsonl", clone: false, cwd: "C:\\p", start: true });
  assert.equal(planContinue(piClosed, { now, piAlive: true, piSid: "pi:999" }).start, false);
});

test("pi: session live in a terminal is cloned", () => {
  assert.equal(planContinue(piLive, { now, piAlive: true, piSid: "pi:999" }).clone, true);
});

test("pi: busy Omni pi is a 409", () => {
  assert.equal(planContinue(piClosed, { now, piAlive: true, piSid: "pi:999", piStreaming: true }).status, 409);
});

test("pi: no file is a 400", () => {
  assert.equal(planContinue({ ...piClosed, file: null }, { now }).status, 400);
});

test("isLiveInTerminal uses the newer of lastActivity and mtime", () => {
  assert.equal(isLiveInTerminal({ owned: false, streaming: false, lastActivity: now - 100_000, mtime: now - 1_000 }, now, 30_000), true);
  assert.equal(isLiveInTerminal({ owned: false, streaming: false, lastActivity: now - 100_000, mtime: now - 100_000 }, now, 30_000), false);
  assert.equal(isLiveInTerminal({ owned: true, streaming: true, lastActivity: now }, now, 30_000), false);
});
