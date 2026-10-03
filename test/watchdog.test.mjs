// test/watchdog.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { restartDelay, nextRestartState, stalled } from "../server/watchdog.mjs";

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
