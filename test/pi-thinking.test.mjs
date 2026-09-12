import { test } from "node:test";
import assert from "node:assert/strict";
import { PiRpc, PI_THINKING_LEVELS } from "../server/pi-rpc.mjs";

test("PiRpc.thinkingLevels returns the fixed level set, not the removed RPC command", async () => {
  const pi = new PiRpc({ bus: { emit() {} } });
  // if this still called get_available_thinking_levels it would need a live child and throw;
  // it must resolve locally to the known levels.
  const r = await pi.thinkingLevels();
  assert.equal(r.success, true);
  assert.ok(Array.isArray(r.data?.levels) && r.data.levels.length, "levels present");
  assert.deepEqual(r.data.levels, PI_THINKING_LEVELS);
  assert.ok(r.data.levels.includes("off") && r.data.levels.includes("high"), "off + high offered");
});
