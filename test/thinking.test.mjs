import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { THINKING_LEVELS, clampThinking, thinkingProfile } from "../ui/thinking.js";
import { fillThinkingMaps, flatModels, upsertProvider } from "../server/providers.mjs";

const levels = (id, extra = {}) => thinkingProfile({ provider: "p", id, ...extra }).levels;
const STANDARD = ["off", "minimal", "low", "medium", "high"];

test("thinkingProfile: each family's own levels, from the model's id or name", () => {
  // Claude: effort, no minimal; Opus/Sonnet 4.6 and the 5 family add xhigh and max (the version is parsed, not any "-5")
  assert.deepEqual(levels("claude-opus-5-5"), ["off", "low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(levels("anthropic/claude-opus-4.6"), ["off", "low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(levels("claude-sonnet-4-5"), ["off", "low", "medium", "high"]);
  assert.deepEqual(levels("claude-3-5-sonnet-20241022"), ["off", "low", "medium", "high"]);
  assert.deepEqual(levels("x", { name: "Claude Fable 5.1" }), ["off", "low", "medium", "high", "xhigh", "max"]);
  // GPT: 5 cannot turn off (a date suffix is not a minor version), 5.1 off = "none", xhigh from 5.2, max from 5.6
  assert.deepEqual(levels("gpt-5-2025-08-07"), ["minimal", "low", "medium", "high"]);
  assert.deepEqual(levels("gpt-5.1"), ["off", "low", "medium", "high"]);
  assert.deepEqual(levels("openai/gpt-5.2-codex"), ["off", "low", "medium", "high", "xhigh"]);
  assert.deepEqual(levels("gpt-5.6"), ["off", "low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(levels("o3-mini"), ["low", "medium", "high"]);
  assert.deepEqual(levels("gpt-4o"), ["off"]);
  // DeepSeek: V4 high + max, V3.x a switch, R1 always thinks
  assert.deepEqual(levels("deepseek/deepseek-v4.1-flash-1017:floor"), ["off", "high", "max"]);
  assert.deepEqual(levels("deepseek/deepseek-v3.2"), ["off", "high"]);
  assert.deepEqual(levels("deepseek-r1"), ["high"]);
  // Qwen and GLM: a switch, shown as "on"; the thinking builds always think, the 2507 instruct builds never do
  const q = thinkingProfile({ provider: "orca", id: "Qwen/Qwen3.8-27B" });
  assert.deepEqual([q.family, q.levels, q.labels], ["qwen", ["off", "high"], { high: "on" }]);
  assert.deepEqual(levels("qwen3-235b-a22b-thinking-2507"), ["high"]);
  assert.deepEqual(levels("qwen3-235b-a22b-instruct-2507"), ["off"]);
  assert.deepEqual(levels("z-ai/glm-4.6"), ["off", "high"]);
  // unknown: pi's standard ladder, nothing written; a non-reasoning model: off; a map the user wrote wins
  assert.deepEqual(thinkingProfile({ id: "llama-3.3-70b" }), { family: "other", levels: STANDARD, labels: {}, map: null, guessed: false });
  assert.deepEqual(levels("deepseek-v4", { reasoning: false }), ["off"]);
  assert.deepEqual(levels("deepseek-v4", { thinkingLevelMap: { minimal: null, xhigh: "xhigh" } }), ["off", "low", "medium", "high", "xhigh"]);
});

test("thinkingProfile.map is pi's thinkingLevelMap: null hides a level, xhigh/max need a value, off is \"none\" for GPT", () => {
  assert.deepEqual(thinkingProfile({ id: "deepseek-v4-pro" }).map, { minimal: null, low: null, medium: null, max: "max" });
  assert.deepEqual(thinkingProfile({ id: "gpt-5.2" }).map, { off: "none", minimal: null, xhigh: "xhigh" });
  assert.deepEqual(thinkingProfile({ id: "deepseek-r1" }).map, { off: null, minimal: null, low: null, medium: null });
  // The map pi reads back gives exactly the levels offered.
  for (const id of ["claude-opus-5-5", "gpt-5.6", "glm-4.6", "o3", "gemini-3-pro"]) {
    const { levels: ls, map } = thinkingProfile({ id });
    for (const l of THINKING_LEVELS) assert.equal(ls.includes(l), Object.hasOwn(map, l) ? map[l] !== null : STANDARD.includes(l), `${id} ${l}`);
  }
});

test("clampThinking: the nearest level the model has, and a level that thinks never lands on off", () => {
  assert.equal(clampThinking("medium", ["off", "high"]), "high", "a switch: medium is on");
  assert.equal(clampThinking("low", ["off", "high", "max"]), "high");
  assert.equal(clampThinking("xhigh", ["off", "high", "max"]), "high", "down when there is a level below");
  assert.equal(clampThinking("max", ["off", "low", "medium", "high", "xhigh"]), "xhigh");
  assert.equal(clampThinking("off", ["high"]), "high", "a model that always thinks");
  assert.equal(clampThinking("off", ["minimal", "low", "medium", "high"]), "minimal");
  assert.equal(clampThinking("minimal", ["off", "low", "medium", "high"]), "low");
  assert.equal(clampThinking("medium", ["off"]), "off");
  assert.equal(clampThinking("high", ["off", "high"]), "high");
  assert.equal(clampThinking("high", []), "high");
});

test("models.json: each model gets its family's thinkingLevelMap once; a map already there is never changed", () => {
  const dir = mkdtempSync(join(tmpdir(), "omni-thinking-"));
  const file = join(dir, "models.json");
  const fillFile = () => { const j = JSON.parse(readFileSync(file, "utf8")); const filled = fillThinkingMaps(j); writeFileSync(file, JSON.stringify(j)); return filled; };
  writeFileSync(file, JSON.stringify({ other: 1, providers: { openrouter: { baseUrl: "https://x", api: "openai-completions", apiKey: "k", models: [
    { id: "deepseek/deepseek-v4.1-flash" },
    { id: "z-ai/glm-4.6", thinkingLevelMap: { off: null } },
    { id: "meta/llama-3", reasoning: true },
    { id: "gpt-4o", reasoning: false },
  ] } } }));
  assert.deepEqual(fillFile(), ["openrouter/deepseek/deepseek-v4.1-flash"]);
  const j = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(j.other, 1);
  assert.equal(j.providers.openrouter.apiKey, "k");
  const [ds, glm, llama, gpt4] = j.providers.openrouter.models;
  assert.deepEqual(ds.thinkingLevelMap, { minimal: null, low: null, medium: null, max: "max" });
  assert.deepEqual(glm.thinkingLevelMap, { off: null }, "the user's own");
  assert.equal(llama.thinkingLevelMap, undefined, "unknown family: pi's own mapping");
  assert.equal(gpt4.thinkingLevelMap, undefined, "no reasoning: nothing to map");
  assert.deepEqual(fillFile(), [], "idempotent");
  // The picker list carries each model's levels.
  const flat = flatModels(file);
  assert.deepEqual(flat.find((m) => m.id === "z-ai/glm-4.6").thinking, ["minimal", "low", "medium", "high"]);
  assert.deepEqual(flat.find((m) => m.id === "deepseek/deepseek-v4.1-flash").thinking, ["off", "high", "max"]);
  // A provider saved from the form keeps the maps there and fills a new model's.
  upsertProvider(file, "openrouter", { baseUrl: "https://x", api: "openai-completions", models: ["deepseek/deepseek-v4.1-flash", "z-ai/glm-4.6", "qwen/qwen3-max"] });
  const m2 = JSON.parse(readFileSync(file, "utf8")).providers.openrouter.models;
  assert.deepEqual(m2[1].thinkingLevelMap, { off: null }, "kept");
  assert.deepEqual(m2[2].thinkingLevelMap, { minimal: null, low: null, medium: null }, "a new model is filled when saved");
  assert.deepEqual(fillThinkingMaps({}), []);
});
