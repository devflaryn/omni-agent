import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PRESETS, PI_APIS, readModelsFile, listProviders, upsertProvider, removeProvider, flatModels, normalizeModels, validateProvider } from "../server/providers.mjs";

const base = mkdtempSync(join(tmpdir(), "omni-prov-"));
const file = join(base, "models.json");

test("presets cover the documented providers with a pi api type each", () => {
  const keys = PRESETS.map((p) => p.key);
  for (const k of ["openrouter", "openai", "anthropic", "google", "deepseek", "ollama", "custom-openai", "custom-anthropic"]) assert.ok(keys.includes(k), k);
  for (const p of PRESETS) assert.ok(PI_APIS.includes(p.api), `${p.key} api ${p.api}`);
  assert.equal(PRESETS.find((p) => p.key === "anthropic").api, "anthropic-messages");
  assert.equal(PRESETS.find((p) => p.key === "custom-openai").baseUrl, "");
});

test("readModelsFile tolerates a missing or broken file", () => {
  assert.deepEqual(readModelsFile(join(base, "nope.json")), { providers: {} });
  writeFileSync(file, "{ broken");
  assert.deepEqual(readModelsFile(file), { providers: {} });
});

test("normalizeModels turns typed ids into pi model entries with defaults", () => {
  const m = normalizeModels([{ id: " deepseek/deepseek-v4-flash-0731 " }, { id: "x", name: "X", reasoning: false, contextWindow: 32000, maxTokens: 4000 }, { id: "" }, "openai/gpt-5"]);
  assert.equal(m.length, 3);
  assert.deepEqual(m[0], { id: "deepseek/deepseek-v4-flash-0731", name: "deepseek/deepseek-v4-flash-0731", reasoning: true, input: ["text"], contextWindow: 128000, maxTokens: 16384, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
  assert.equal(m[1].name, "X"); assert.equal(m[1].reasoning, false); assert.equal(m[1].contextWindow, 32000); assert.equal(m[1].maxTokens, 4000);
  assert.equal(m[2].id, "openai/gpt-5");
});

test("validateProvider rejects bad names, urls, apis and empty model lists", () => {
  assert.match(validateProvider("Open Router", { baseUrl: "https://x", api: "openai-completions", models: [{ id: "a" }] }) || "", /name/);
  assert.match(validateProvider("openrouter", { baseUrl: "not a url", api: "openai-completions", models: [{ id: "a" }] }) || "", /url/i);
  assert.match(validateProvider("openrouter", { baseUrl: "https://x", api: "grpc", models: [{ id: "a" }] }) || "", /api/);
  assert.match(validateProvider("openrouter", { baseUrl: "https://x", api: "openai-completions", models: [] }) || "", /model/);
  assert.equal(validateProvider("open-router_2", { baseUrl: "http://localhost:11434/v1", api: "openai-completions", models: [{ id: "a" }] }), null);
});

test("upsertProvider writes pi's models.json shape, keeps unknown fields and the old key when omitted", () => {
  writeFileSync(file, JSON.stringify({ providers: { orca: { baseUrl: "https://orca/v1", api: "openai-completions", apiKey: "orca-key", compat: { supportsDeveloperRole: false }, models: [{ id: "Qwen/Qwen3.8-27B", name: "Qwen" }] } }, somethingElse: 1 }));
  upsertProvider(file, "openrouter", { baseUrl: "https://openrouter.ai/api/v1", api: "openai-completions", apiKey: "sk-or-1234", models: [{ id: "deepseek/deepseek-v4-flash-0731" }] });
  let j = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(j.somethingElse, 1);
  assert.equal(j.providers.orca.compat.supportsDeveloperRole, false);
  assert.equal(j.providers.openrouter.apiKey, "sk-or-1234");
  assert.equal(j.providers.openrouter.models[0].contextWindow, 128000);
  // second write without a key keeps the stored key, replaces the model list, keeps extra fields
  upsertProvider(file, "openrouter", { baseUrl: "https://openrouter.ai/api/v1", api: "openai-completions", models: [{ id: "moonshotai/kimi-k2.5" }, { id: "deepseek/deepseek-v4-flash-0731" }] });
  j = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(j.providers.openrouter.apiKey, "sk-or-1234");
  assert.deepEqual(j.providers.openrouter.models.map((m) => m.id), ["moonshotai/kimi-k2.5", "deepseek/deepseek-v4-flash-0731"]);
  // an explicit empty key clears it
  upsertProvider(file, "openrouter", { baseUrl: "https://openrouter.ai/api/v1", api: "openai-completions", apiKey: "", models: [{ id: "a" }] });
  j = JSON.parse(readFileSync(file, "utf8"));
  assert.equal("apiKey" in j.providers.openrouter, false);
});

test("listProviders hides the key and reports a hint; flatModels lists provider/model pairs in file order", () => {
  writeFileSync(file, JSON.stringify({ providers: {
    orca: { baseUrl: "https://orca/v1", api: "openai-completions", apiKey: "orca-key-9876", models: [{ id: "Qwen/Qwen3.8-27B", name: "Qwen", contextWindow: 32768 }] },
    openrouter: { baseUrl: "https://openrouter.ai/api/v1", api: "openai-completions", models: [{ id: "a" }, { id: "b", name: "B" }] },
  } }));
  const list = listProviders(file);
  assert.deepEqual(list.map((p) => p.name), ["orca", "openrouter"]);
  assert.equal(list[0].hasKey, true); assert.equal(list[0].keyHint, "9876"); assert.equal("apiKey" in list[0], false);
  assert.equal(list[1].hasKey, false); assert.equal(list[1].keyHint, "");
  assert.deepEqual(list[0].models[0], { id: "Qwen/Qwen3.8-27B", name: "Qwen", reasoning: false, contextWindow: 32768, maxTokens: null });
  assert.deepEqual(flatModels(file), [
    { provider: "orca", id: "Qwen/Qwen3.8-27B", name: "Qwen", contextWindow: 32768 },
    { provider: "openrouter", id: "a", name: "a", contextWindow: null },
    { provider: "openrouter", id: "b", name: "B", contextWindow: null },
  ]);
});

test("removeProvider drops the entry and leaves the rest", () => {
  removeProvider(file, "orca");
  const j = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(Object.keys(j.providers), ["openrouter"]);
  assert.equal(removeProvider(file, "missing"), false);
});
