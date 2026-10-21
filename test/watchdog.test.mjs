// test/watchdog.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { restartDelay, nextRestartState, stalled, stallLimit, DEFAULT_TOOL_STALL_MS } from "../server/watchdog.mjs";

test("restartDelay grows exponentially and caps", () => {
  assert.ok(restartDelay(0) >= 640 && restartDelay(0) <= 960);   // ~800 ±20%
  assert.ok(restartDelay(10) <= 30000);                          // capped
  assert.ok(restartDelay(5) > restartDelay(1));
});

test("restart counter resets after a sustained-healthy window", () => {
  const s = { restarts: 7, lastHealthyAt: 1000 };
  assert.equal(nextRestartState(s, { now: 1000 + 130000 }).restarts, 0);
  assert.equal(nextRestartState(s, { now: 1000 + 1000 }).restarts, 7);
});

test("stalled: streaming with no event past stallMs", () => {
  assert.equal(stalled({ streaming: true, lastEventAt: 0, now: 400000, stallMs: 360000 }), true);
  assert.equal(stalled({ streaming: true, lastEventAt: 390000, now: 400000, stallMs: 360000 }), false);
  assert.equal(stalled({ streaming: false, lastEventAt: 0, now: 400000, stallMs: 360000 }), false);
});

test("stallLimit: a tool call that is open gets toolStallMs (4 h by default), never less than stallMs", () => {
  assert.equal(DEFAULT_TOOL_STALL_MS, 4 * 3600000);
  assert.equal(stallLimit({ openTools: 0, stallMs: 900000 }), 900000);
  assert.equal(stallLimit({ openTools: 1, stallMs: 900000 }), 4 * 3600000);
  assert.equal(stallLimit({ openTools: 2, stallMs: 900000, toolStallMs: 3600000 }), 3600000);
  assert.equal(stallLimit({ openTools: 1, stallMs: 900000, toolStallMs: 1000 }), 900000, "a misconfigured shorter tool limit does not cut tools off sooner");
});

test("stalled: a long-running tool is not a stall until toolStallMs", () => {
  const base = { streaming: true, lastEventAt: 0, stallMs: 900000 };
  assert.equal(stalled({ ...base, now: 1_000_000 }), true, "no tool open: 1000 s of silence > 900 s");
  assert.equal(stalled({ ...base, now: 1_000_000, openTools: 1 }), false, "a build running for 1000 s is fine");
  assert.equal(stalled({ ...base, now: 4 * 3600000 + 1, openTools: 1 }), true, "past 4 h even an open tool counts");
  assert.equal(stalled({ ...base, now: 2_000_000, openTools: 1, toolStallMs: 1_500_000 }), true);
});
