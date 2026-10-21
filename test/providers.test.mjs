import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PRESETS, PI_APIS, readModelsFile, listProviders, upsertProvider, removeProvider, reorderProviders, flatModels, normalizeModels, validateProvider } from "../server/providers.mjs";

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
  writeFileSync(file, JSON.stringify({ providers: { orca: { baseUrl: "https://orca/v1", api: "openai-completions", apiKey: "orca-key", compat: { supportsDeveloperRole: false }, models: [{ id: "Qwen/Qwen3.8-27B", name: "Qwen", input: ["text", "image"], cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }] } }, somethingElse: 1 }));
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
  // re-saving an existing model by id alone keeps its hand-written fields (image input, cost, name)
  upsertProvider(file, "orca", { baseUrl: "https://orca/v1", api: "openai-completions", models: [{ id: "Qwen/Qwen3.8-27B" }, "new/model"] });
  j = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(j.providers.orca.models[0].name, "Qwen");
  assert.deepEqual(j.providers.orca.models[0].input, ["text", "image"]);
  assert.equal(j.providers.orca.models[0].cost.input, 1);
  assert.equal(j.providers.orca.apiKey, "orca-key");
  assert.equal(j.providers.orca.models[1].id, "new/model");
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

// The provider keys the form does not edit: Omni's context caps (server/context-policy.mjs) live in modelOverrides.
const extras = () => ({
  modelOverrides: { "deepseek/deepseek-v4.1-flash-1017:floor": { contextWindow: 280576 }, "catalog/model": { maxTokens: 65536, name: "Mine" } },
  headers: { "X-Title": "omni" }, authHeader: true, compat: { supportsDeveloperRole: false }, someFutureKey: [1, 2],
});

test("upsertProvider preserves modelOverrides and the provider's other unknown keys", () => {
  const f = join(base, "overrides.json");
  writeFileSync(f, JSON.stringify({ providers: { openrouter: { baseUrl: "https://openrouter.ai/api/v1", api: "openai-completions", apiKey: "k", models: [{ id: "deepseek/deepseek-v4.1-flash-1017:floor", contextWindow: 1000000 }], ...extras() } } }));
  upsertProvider(f, "openrouter", { baseUrl: "https://openrouter.ai/api/v2", api: "openai-completions", models: [{ id: "deepseek/deepseek-v4.1-flash-1017:floor", contextWindow: 900000 }, { id: "z/new" }] });
  const p = JSON.parse(readFileSync(f, "utf8")).providers.openrouter;
  for (const [k, v] of Object.entries(extras())) assert.deepEqual(p[k], v, k);
  assert.equal(p.baseUrl, "https://openrouter.ai/api/v2");
  assert.equal(p.apiKey, "k");
  assert.deepEqual(p.models.map((m) => [m.id, m.contextWindow]), [["deepseek/deepseek-v4.1-flash-1017:floor", 900000], ["z/new", 128000]], "the form still owns the declared windows");
  // a brand-new provider gets no modelOverrides of its own
  upsertProvider(f, "fresh", { baseUrl: "https://x/v1", api: "openai-completions", models: ["m"] });
  assert.equal("modelOverrides" in JSON.parse(readFileSync(f, "utf8")).providers.fresh, false);
});

test("removeProvider and reorderProviders keep the other providers' modelOverrides and unknown keys", () => {
  const f = join(base, "overrides2.json");
  const prov = (id) => ({ baseUrl: `https://${id}/v1`, api: "openai-completions", models: [{ id }], ...extras() });
  writeFileSync(f, JSON.stringify({ providers: { a: prov("a"), b: prov("b"), c: prov("c") }, top: 1 }));
  reorderProviders(f, ["c", "a"]);
  let j = JSON.parse(readFileSync(f, "utf8"));
  assert.deepEqual(Object.keys(j.providers), ["c", "a", "b"]);
  for (const n of ["a", "b", "c"]) assert.deepEqual(j.providers[n], prov(n), n);
  removeProvider(f, "a");
  j = JSON.parse(readFileSync(f, "utf8"));
  assert.deepEqual(j, { providers: { c: prov("c"), b: prov("b") }, top: 1 });
});

test("models.json writes are 2-space JSON + newline, atomic (no temp file left), and a BOM-prefixed file is read", () => {
  const dir = mkdtempSync(join(tmpdir(), "omni-prov-bom-"));
  const f = join(dir, "models.json");
  writeFileSync(f, `﻿${JSON.stringify({ providers: { orca: { baseUrl: "https://orca/v1", api: "openai-completions", models: [{ id: "q" }], modelOverrides: { q: { contextWindow: 100000 } } } } })}`);
  assert.equal(readModelsFile(f).providers.orca.models[0].id, "q", "PowerShell's BOM does not hide the providers");
  upsertProvider(f, "openrouter", { baseUrl: "https://openrouter.ai/api/v1", api: "openai-completions", models: ["a"] });
  const text = readFileSync(f, "utf8");
  const j = JSON.parse(text);
  assert.equal(text, `${JSON.stringify(j, null, 2)}\n`);
  assert.deepEqual(Object.keys(j.providers), ["orca", "openrouter"], "the BOM file was merged into, not replaced");
  assert.deepEqual(j.providers.orca.modelOverrides, { q: { contextWindow: 100000 } });
  assert.deepEqual(readdirSync(dir), ["models.json"]);
  // a models.json that does not exist yet (nor its folder) is created
  const g = join(dir, "sub", "models.json");
  upsertProvider(g, "x", { baseUrl: "https://x/v1", api: "openai-completions", models: ["m"] });
  assert.equal(readModelsFile(g).providers.x.models[0].id, "m");
});

test("the write paths refuse a models.json they cannot read instead of replacing it (pi accepts comments there)", () => {
  const dir = mkdtempSync(join(tmpdir(), "omni-prov-strict-"));
  const f = join(dir, "models.json");
  const body = { baseUrl: "https://api.groq.com/openai/v1", api: "openai-completions", models: ["m"] };
  const commented = `// my providers\n${JSON.stringify({ providers: { openrouter: { baseUrl: "https://openrouter.ai/api/v1", api: "openai-completions", models: [{ id: "a" }] } } }, null, 2)}\n`;
  for (const text of [commented, "{ broken", "[]", JSON.stringify({ providers: "x" }), JSON.stringify({ providers: [] })]) {
    writeFileSync(f, text);
    for (const write of [() => upsertProvider(f, "groq", body), () => removeProvider(f, "openrouter"), () => reorderProviders(f, ["openrouter"])]) {
      assert.throws(write, (e) => e.status === 409 && /models\.json was not changed/.test(e.message), text);
      assert.equal(readFileSync(f, "utf8"), text, "the file is left as it was");
    }
    assert.deepEqual(listProviders(f), [], "readers stay lenient");
  }
  assert.deepEqual(readdirSync(dir), ["models.json"]);
  // an empty file or one without providers holds nothing to lose: written as usual
  for (const text of ["", "  \n", JSON.stringify({ top: 1 }), JSON.stringify({ providers: null })]) {
    writeFileSync(f, text);
    upsertProvider(f, "groq", body);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(f, "utf8")).providers), ["groq"], JSON.stringify(text));
  }
  writeFileSync(f, JSON.stringify({ top: 1 }));
  upsertProvider(f, "groq", body);
  assert.equal(JSON.parse(readFileSync(f, "utf8")).top, 1, "top-level keys are kept");
  assert.equal(removeProvider(f, "constructor"), false, "only own provider names count");
});

test("reorderProviders rewrites the provider order (the fallback chain); unknown names are ignored, unlisted ones trail", () => {
  const f = join(base, "order.json");
  writeFileSync(f, JSON.stringify({ providers: { a: { baseUrl: "https://a/v1", api: "openai-completions", models: [{ id: "a1" }, { id: "a2" }] }, b: { baseUrl: "https://b/v1", api: "openai-completions", models: [{ id: "b1" }] }, c: { baseUrl: "https://c/v1", api: "openai-completions", models: [{ id: "c1" }] } }, compat: { keep: true } }));
  assert.deepEqual(reorderProviders(f, ["c", "nope", "a", "c"]), ["c", "a", "b"]);
  const j = JSON.parse(readFileSync(f, "utf8"));
  assert.deepEqual(Object.keys(j.providers), ["c", "a", "b"]);
  assert.deepEqual(j.compat, { keep: true }, "other top-level keys survive");
  assert.deepEqual(flatModels(f).map((m) => `${m.provider}/${m.id}`), ["c/c1", "a/a1", "a/a2", "b/b1"], "the picker and the fallback chain follow the new order");
});
