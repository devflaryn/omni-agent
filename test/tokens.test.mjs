import { test } from "node:test";
import assert from "node:assert/strict";
import { createTally, estimateCost, estimateTokens } from "../server/tokens.mjs";

test("tally dedupes by groupId and tracks context + cost", () => {
  const t = createTally();
  const u = { input: 2, output: 400, cacheRead: 30000, cacheWrite: 18000, total: 48402 };
  t.add("claude:s", { groupId: "msg_1", usage: u, model: "claude-opus-5" });
  t.add("claude:s", { groupId: "msg_1", usage: u, model: "claude-opus-5" }); // duplicate block line
  t.add("claude:s", { groupId: "msg_2", usage: { input: 5, output: 10, cacheRead: 48000, cacheWrite: 0, total: 48015 }, model: "claude-opus-5" });
  const s = t.get("claude:s");
  assert.equal(s.messages, 2);
  assert.equal(s.output, 410);
  assert.equal(s.context, 48005, "context = last message input + cache tokens");
  assert.ok(s.cost > 0);
  assert.equal(s.model, "claude-opus-5");
});

test("cost table: opus 5 $5/$25 per MTok, cache read 10%, cache write 125%", () => {
  assert.equal(estimateCost("claude-opus-5", { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }), 5);
  assert.equal(estimateCost("claude-opus-5", { input: 0, output: 1_000_000, cacheRead: 0, cacheWrite: 0 }), 25);
  assert.equal(estimateCost("claude-opus-5", { input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 0 }), 0.5);
  assert.equal(estimateCost("Qwen/Qwen3.8-27B", { input: 1e6, output: 1e6, cacheRead: 0, cacheWrite: 0 }), 0, "unknown model -> 0");
});

test("pi provider cost is used when present", () => {
  const t = createTally();
  t.add("pi:s", { groupId: "a", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }, model: "x", cost: 0.25 });
  assert.equal(t.get("pi:s").cost, 0.25);
});

test("estimateTokens ~ chars/4", () => {
  assert.equal(estimateTokens("a".repeat(400)), 100);
});
