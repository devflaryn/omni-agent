import { test } from "node:test";
import assert from "node:assert/strict";
import { filterPiModels } from "../server/pi-models.mjs";

const models = [
  { provider: "orca", id: "Qwen/Qwen3.8-27B", name: "Qwen3.8-27B" },
  { provider: "openrouter", id: "deepseek/deepseek-v4-flash-0731" },
  { provider: "openrouter", id: "anthropic/claude-opus-5" },
  { provider: "anthropic", id: "claude-opus-5" },
];

test("no allowlist keeps everything", () => {
  assert.equal(filterPiModels(models, null).length, 4);
  assert.equal(filterPiModels(models, []).length, 4);
});

test("provider wildcard keeps only that provider", () => {
  assert.deepEqual(filterPiModels(models, ["orca/*"]).map((m) => m.id), ["Qwen/Qwen3.8-27B"]);
});

test("exact provider/id and id wildcards", () => {
  assert.deepEqual(filterPiModels(models, ["anthropic/claude-opus-5", "openrouter/anthropic/*"]).map((m) => `${m.provider}/${m.id}`), ["openrouter/anthropic/claude-opus-5", "anthropic/claude-opus-5"]);
});

test("matching is case-insensitive and tolerates bad input", () => {
  assert.equal(filterPiModels(models, ["ORCA/qwen/*"]).length, 1);
  assert.deepEqual(filterPiModels(null, ["orca/*"]), []);
});
