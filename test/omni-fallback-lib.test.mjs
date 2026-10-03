import { test } from "node:test";
import assert from "node:assert/strict";
import { modelsBelow, nextModelOnHealthy } from "../integrations/pi/omni-fallback-lib.mjs";

const chain = [{ provider: "a", id: "1" }, { provider: "a", id: "2" }, { provider: "b", id: "3" }];

test("recovers one step up after the cooldown of healthy turns", () => {
	const up = nextModelOnHealthy(chain, { provider: "b", id: "3" }, { cooldownTurns: 3, healthyTurns: 3 });
	assert.deepEqual(up, { provider: "a", id: "2" });
});
test("stays put before the cooldown", () => {
	assert.equal(nextModelOnHealthy(chain, { provider: "b", id: "3" }, { cooldownTurns: 3, healthyTurns: 2 }), null);
});
test("at the top, nothing to recover to", () => {
	assert.equal(nextModelOnHealthy(chain, { provider: "a", id: "1" }, { cooldownTurns: 3, healthyTurns: 9 }), null);
});
