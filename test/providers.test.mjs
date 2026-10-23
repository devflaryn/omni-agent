import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PRESETS, readModelsFile, listProviders, upsertProvider, removeProvider, reorderProviders, flatModels, normalizeModels, validateProvider } from "../server/providers.mjs";
import { saveCustomProvider, customProviderConfig, migratePiProviders, migrationMarker, normalizeCustomModels, opencodeCost, piVariants } from "../server/providers.mjs";
import { writeOpencodeConfig } from "../server/opencode-config.mjs";

const base = mkdtempSync(join(tmpdir(), "omni-prov-"));
const file = join(base, "models.json");

test("the dialog's presets: custom OpenAI-compatible endpoints and OpenCode's own providers (key only)", () => {
  const custom = PRESETS.filter((p) => p.kind === "custom").map((p) => p.key);
  const keyed = PRESETS.filter((p) => p.kind === "key").map((p) => p.key);
  for (const k of ["custom", "ollama"]) assert.ok(custom.includes(k), k);
  for (const k of ["openrouter", "anthropic", "openai", "google", "opencode"]) assert.ok(keyed.includes(k), k);
  assert.equal(PRESETS.length, custom.length + keyed.length, "every preset is one kind or the other");
  assert.equal(PRESETS.find((p) => p.key === "custom").baseUrl, "");
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
    // each with the thinking levels its family has (ui/thinking.js): Qwen only switches it on or off
    { provider: "orca", id: "Qwen/Qwen3.8-27B", name: "Qwen", contextWindow: 32768, thinking: ["off", "high"], thinkingLabels: { high: "on" } },
    { provider: "openrouter", id: "a", name: "a", contextWindow: null, thinking: ["off", "minimal", "low", "medium", "high"], thinkingLabels: {} },
    { provider: "openrouter", id: "b", name: "B", contextWindow: null, thinking: ["off", "minimal", "low", "medium", "high"], thinkingLabels: {} },
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

// ------------------------------------------------------------ OpenCode custom providers (BYOK)
test("normalizeCustomModels: the store's model shape (reasoning only when asked for)", () => {
  assert.deepEqual(normalizeCustomModels([" a ", { id: "b", name: "B", contextWindow: 32000, maxTokens: 4000, reasoning: true }, { id: "" }]), [
    { id: "a", name: "a", contextWindow: 128000, maxTokens: 16384, reasoning: false },
    { id: "b", name: "B", contextWindow: 32000, maxTokens: 4000, reasoning: true },
  ]);
});

test("a model's price and thinking levels: OpenCode's cost keys, zeros mean unknown, pi's thinking map as variants; a re-save keeps them", () => {
  assert.deepEqual(opencodeCost({ input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 }), { input: 0.3, output: 1.2, cache_read: 0.006, cache_write: 0 });
  assert.deepEqual(opencodeCost({ input: 1, output: 2, cache: { read: 0.5, write: 0.25 } }), { input: 1, output: 2, cache_read: 0.5, cache_write: 0.25 });
  assert.equal(opencodeCost({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }), null);
  assert.deepEqual(normalizeCustomModels([{ id: "m", cost: { input: 0, output: 0 } }])[0].cost, undefined);
  const tpl = [{ reasoning: { effort: "high" } }, { reasoning: { effort: "max" } }];
  assert.deepEqual(piVariants({ minimal: null, high: "high", max: "max", xhigh: "ultra" }, { templates: tpl }), { variants: { minimal: { disabled: true }, high: { reasoning: { effort: "high" } }, max: { reasoning: { effort: "max" } } }, unmapped: ["xhigh"] });
  assert.deepEqual(piVariants({ low: null, xhigh: "xhigh" }, { shape: (v) => ({ reasoningEffort: v }) }).variants, { low: { disabled: true }, xhigh: { reasoningEffort: "xhigh" } });
  assert.deepEqual(piVariants(undefined), { variants: null, unmapped: [] });
  const f = join(mkdtempSync(join(tmpdir(), "omni-ocprice-")), "p.json");
  writeFileSync(f, JSON.stringify({ providers: { x: { baseUrl: "https://x/v1", models: [{ id: "m", name: "M", contextWindow: 1000, maxTokens: 100, reasoning: true, cost: { input: 1, output: 2, cache_read: 0, cache_write: 0 }, variants: { low: { disabled: true } } }] } } }));
  saveCustomProvider(f, "x", { baseUrl: "https://x/v1", models: [{ id: "m" }] });
  const m = JSON.parse(readFileSync(f, "utf8")).providers.x.models[0];
  assert.deepEqual([m.cost, m.variants], [{ input: 1, output: 2, cache_read: 0, cache_write: 0 }, { low: { disabled: true } }], "the dialog does not edit them, so a re-save keeps them");
  assert.deepEqual(customProviderConfig(f).x.models.m, { name: "M", limit: { context: 1000, output: 100 }, reasoning: true, cost: { input: 1, output: 2, cache_read: 0, cache_write: 0 }, variants: { low: { disabled: true } } });
});

test("provider saved → opencode.json provider entry", () => {
  const dir = mkdtempSync(join(tmpdir(), "omni-ocprov-"));
  const f = join(dir, "opencode-providers.json");
  assert.throws(() => saveCustomProvider(f, "Bad Name", { baseUrl: "https://x/v1", models: ["a"] }), (e) => e.status === 400 && /name/.test(e.message));
  assert.throws(() => saveCustomProvider(f, "x", { baseUrl: "nope", models: ["a"] }), (e) => e.status === 400 && /url/i.test(e.message));
  assert.throws(() => saveCustomProvider(f, "x", { baseUrl: "https://x/v1", models: [] }), (e) => e.status === 400 && /model/.test(e.message));
  saveCustomProvider(f, "modal", { baseUrl: "https://modal.example/v1", apiKey: "sk-modal-1234", models: [{ id: "Qwen/Qwen3.8-27B", name: "Qwen", contextWindow: 262144, maxTokens: 32768, reasoning: true }, "vendor/b:floor"] });
  saveCustomProvider(f, "local", { baseUrl: "http://localhost:11434/v1", models: ["llama3.1:8b"] });
  saveCustomProvider(f, "envy", { baseUrl: "https://envy.example/v1", apiKey: "$ENVY_KEY", models: ["m"] });
  const store = JSON.parse(readFileSync(f, "utf8"));
  assert.deepEqual(store.providers.modal, { baseUrl: "https://modal.example/v1", apiKey: "sk-modal-1234", models: [
    { id: "Qwen/Qwen3.8-27B", name: "Qwen", contextWindow: 262144, maxTokens: 32768, reasoning: true },
    { id: "vendor/b:floor", name: "vendor/b:floor", contextWindow: 128000, maxTokens: 16384, reasoning: false },
  ] });
  const conf = customProviderConfig(f);
  assert.deepEqual(Object.keys(conf), ["modal", "local", "envy"]);
  assert.deepEqual(conf.modal, {
    npm: "@ai-sdk/openai-compatible", name: "modal", options: { baseURL: "https://modal.example/v1", apiKey: "sk-modal-1234" },
    models: { "Qwen/Qwen3.8-27B": { name: "Qwen", limit: { context: 262144, output: 32768 }, reasoning: true }, "vendor/b:floor": { name: "vendor/b:floor", limit: { context: 128000, output: 16384 } } },
  });
  assert.deepEqual(conf.local.options, { baseURL: "http://localhost:11434/v1" }, "a keyless local server gets no apiKey");
  assert.equal(conf.envy.options.apiKey, "{env:ENVY_KEY}", "pi's $VAR key reference becomes OpenCode's {env:VAR}");
  const oc = JSON.parse(readFileSync(writeOpencodeConfig({ dir: join(dir, "oc"), providers: conf }), "utf8"));
  assert.deepEqual(oc.provider.modal, conf.modal, "rendered into opencode.json's provider block");
  // a re-save without a key keeps the stored one and each model's own limits; "" clears the key
  saveCustomProvider(f, "modal", { baseUrl: "https://modal.example/v2", models: [{ id: "Qwen/Qwen3.8-27B" }, "new/one"] });
  let p = JSON.parse(readFileSync(f, "utf8")).providers.modal;
  assert.equal(p.apiKey, "sk-modal-1234");
  assert.equal(p.baseUrl, "https://modal.example/v2");
  assert.deepEqual(p.models[0], { id: "Qwen/Qwen3.8-27B", name: "Qwen", contextWindow: 262144, maxTokens: 32768, reasoning: true });
  assert.deepEqual(p.models.map((m) => m.id), ["Qwen/Qwen3.8-27B", "new/one"]);
  saveCustomProvider(f, "modal", { baseUrl: "https://modal.example/v2", apiKey: "", models: ["a"] });
  p = JSON.parse(readFileSync(f, "utf8")).providers.modal;
  assert.equal("apiKey" in p, false);
  assert.deepEqual(listProviders(f).map((x) => x.name), ["modal", "local", "envy"]);
  assert.equal(listProviders(f)[2].keyHint, "$ENVY_KEY");
});

test("migration copies models.json once", () => {
  const dir = mkdtempSync(join(tmpdir(), "omni-ocmig-"));
  const from = join(dir, "pi", "models.json"), to = join(dir, "omni", "opencode-providers.json");
  const model = (id, extra = {}) => ({ id, name: id.toUpperCase(), reasoning: true, input: ["text"], contextWindow: 200000, maxTokens: 8192, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, thinkingLevelMap: { low: "low" }, ...extra });
  mkdirSync(join(dir, "pi"), { recursive: true });
  writeFileSync(from, `﻿${JSON.stringify({ providers: {
    modal: { baseUrl: "https://modal.example/v1", api: "openai-completions", apiKey: "sk-modal-9999", modelOverrides: { a: { contextWindow: 1 } }, models: [model("qwen/q"), model("plain", { reasoning: false })] },
    openrouter: { baseUrl: "https://openrouter.ai/api/v1", api: "openai-completions", apiKey: "sk-or", models: [
      // the user's real entry: pi wrote zeros for its price and a thinking map (only high and max)
      model("deepseek/deepseek-v4.1-flash-1017:floor", { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, thinkingLevelMap: { minimal: null, low: null, medium: null, max: "max" } }),
      model("known/one"),
      model("odd/one", { thinkingLevelMap: { xhigh: "ultra" } }),
    ] },
    lmstudio: { baseUrl: "http://localhost:1234/v1", api: "openai-completions", models: [model("q")] },
    envy: { baseUrl: "https://envy.example/v1", apiKey: "$ENVY_KEY", models: [{ id: "m" }] },
    cmd: { baseUrl: "https://cmd.example/v1", api: "openai-completions", apiKey: "!op read secret", models: [{ id: "c" }] },
    anth: { baseUrl: "https://proxy.example", api: "anthropic-messages", apiKey: "k", models: [{ id: "claude-x" }] },
    mine: { baseUrl: "https://pi-version.example/v1", api: "openai-completions", models: [{ id: "old" }] },
  } })}`);
  saveCustomProvider(to, "mine", { baseUrl: "https://omni-version.example/v1", models: ["kept"] });
  // OpenCode's catalog (GET /provider): openrouter is built in, lmstudio comes from the user's global config.
  const catalog = { all: [{ id: "openrouter", name: "OpenRouter", models: {
    "known/one": { id: "known/one" },
    // the model the :floor id is a routing variant of, as OpenCode's catalog has it
    "deepseek/deepseek-v4.1-flash-1017": { id: "deepseek/deepseek-v4.1-flash-1017", cost: { input: 0.3, output: 1.2, cache: { read: 0.006, write: 0 } }, variants: { none: { reasoning: { effort: "none" } }, low: { reasoning: { effort: "low" } }, high: { reasoning: { effort: "high" } }, max: { reasoning: { effort: "max" } } } },
  } }, { id: "lmstudio", name: "LM Studio", models: { q: { id: "q" } } }, { id: "mine", name: "mine", models: {} }], connected: ["openrouter", "lmstudio"] };
  const r = migratePiProviders({ from, to, catalog });
  assert.deepEqual(r.copied, ["modal", "envy", "cmd"]);
  // a provider OpenCode already has keeps OpenCode's definition and key; only the models it lacks are added to it
  assert.deepEqual(r.extended, [{ name: "openrouter", models: ["deepseek/deepseek-v4.1-flash-1017:floor", "odd/one"] }]);
  assert.deepEqual(r.skipped.map((s) => s.name), ["lmstudio", "anth", "mine"]);
  const why = Object.fromEntries(r.skipped.map((s) => [s.name, s.why]));
  assert.match(why.lmstudio, /OpenCode already has a provider named lmstudio/);
  assert.match(why.anth, /anthropic-messages/);
  assert.match(why.mine, /already/);
  assert.ok(r.lines.some((l) => /\bcmd\b/.test(l) && /command/.test(l)), "a key that runs a command is not carried over, and that is said");
  assert.ok(r.lines.some((l) => /deepseek\/deepseek-v4\.1-flash-1017:floor/.test(l) && /OpenCode's openrouter/.test(l)), "each added model is logged");
  assert.ok(!r.lines.some((l) => /known\/one/.test(l)), "a model OpenCode already lists is left alone");
  const store = JSON.parse(readFileSync(to, "utf8")).providers;
  assert.deepEqual(Object.keys(store), ["mine", "modal", "openrouter", "envy", "cmd"]);
  const floorVariants = { minimal: { disabled: true }, low: { disabled: true }, medium: { disabled: true }, max: { reasoning: { effort: "max" } } };
  assert.deepEqual(store.openrouter.models[0], {
    id: "deepseek/deepseek-v4.1-flash-1017:floor", name: "DEEPSEEK/DEEPSEEK-V4.1-FLASH-1017:FLOOR", contextWindow: 200000, maxTokens: 8192, reasoning: true,
    cost: { input: 0.3, output: 1.2, cache_read: 0.006, cache_write: 0 }, // pi had no price (zeros): the base model's, from OpenCode's catalog
    variants: floorVariants, // pi's missing levels off; max with the options OpenCode itself sends for it
  }, "reasoning, price and thinking levels carried; no base URL or key: OpenCode's own provider and stored key apply");
  assert.equal(store.openrouter.builtIn, true);
  assert.deepEqual(store.openrouter.models[1].cost, { input: 1, output: 2, cache_read: 0, cache_write: 0 }, "a price pi knew is kept as it is");
  assert.equal(store.openrouter.models[1].variants, undefined, "a level with no OpenCode equivalent is left out");
  assert.ok(r.lines.some((l) => /xhigh/.test(l) && l.includes("openrouter/odd/one")), "and that is said");
  assert.deepEqual(customProviderConfig(to).openrouter.models["deepseek/deepseek-v4.1-flash-1017:floor"], { name: "DEEPSEEK/DEEPSEEK-V4.1-FLASH-1017:FLOOR", limit: { context: 200000, output: 8192 }, reasoning: true, cost: { input: 0.3, output: 1.2, cache_read: 0.006, cache_write: 0 }, variants: floorVariants }, "rendered as extra models only: no npm, options or apiKey");
  assert.deepEqual(Object.keys(customProviderConfig(to).openrouter), ["models"]);
  assert.equal(listProviders(to).find((p) => p.name === "openrouter").builtIn, true, "the dialog shows them as Omni-added models of OpenCode's provider");
  removeProvider(to, "openrouter");
  assert.deepEqual(store.modal, { baseUrl: "https://modal.example/v1", apiKey: "sk-modal-9999", models: [
    { id: "qwen/q", name: "QWEN/Q", contextWindow: 200000, maxTokens: 8192, reasoning: true, cost: { input: 1, output: 2, cache_read: 0, cache_write: 0 }, variants: { low: { reasoningEffort: "low" } } },
    { id: "plain", name: "PLAIN", contextWindow: 200000, maxTokens: 8192, reasoning: false, cost: { input: 1, output: 2, cache_read: 0, cache_write: 0 }, variants: { low: { reasoningEffort: "low" } } },
  ] });
  assert.equal(store.envy.apiKey, "$ENVY_KEY");
  assert.equal("apiKey" in store.cmd, false);
  assert.equal(store.mine.baseUrl, "https://omni-version.example/v1", "a provider Omni already has is left alone");
  assert.ok(existsSync(migrationMarker(to)));
  assert.equal(JSON.parse(readFileSync(migrationMarker(to), "utf8")).copied.length, 3);
  // once: a second run (pi's file changed meanwhile, a provider removed in Omni) does nothing
  writeFileSync(from, JSON.stringify({ providers: { later: { baseUrl: "https://later/v1", api: "openai-completions", models: [{ id: "l" }] } } }));
  removeProvider(to, "envy");
  assert.equal(migratePiProviders({ from, to, catalog }), null);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(to, "utf8")).providers), ["mine", "modal", "cmd"]);
  // no pi file at all: nothing to copy, and the marker is still written
  const to2 = join(dir, "omni2", "opencode-providers.json");
  assert.deepEqual(migratePiProviders({ from: join(dir, "missing.json"), to: to2, catalog }).copied, []);
  assert.ok(existsSync(migrationMarker(to2)));
  // the dialog can re-save Omni-added models of OpenCode's provider (no base URL needed), and keeps them models-only
  saveCustomProvider(to2, "openrouter", { builtIn: true, models: [{ id: "x/y:floor", name: "XY" }] });
  assert.deepEqual(JSON.parse(readFileSync(to2, "utf8")).providers.openrouter, { builtIn: true, models: [{ id: "x/y:floor", name: "XY", contextWindow: 128000, maxTokens: 16384, reasoning: false }] });
  saveCustomProvider(to2, "openrouter", { baseUrl: "https://ignored/v1", apiKey: "k", models: ["x/y:floor", "z"] });
  assert.deepEqual(customProviderConfig(to2).openrouter, { models: { "x/y:floor": { name: "XY", limit: { context: 128000, output: 16384 } }, z: { name: "z", limit: { context: 128000, output: 16384 } } } }, "an entry that extends OpenCode's provider never gets a URL or key");
  assert.throws(() => saveCustomProvider(to2, "openrouter", { builtIn: true, models: [] }), (e) => e.status === 400 && /model/.test(e.message));
  // a pi file that cannot be read is not marked as done (the next start tries again)
  const bad = join(dir, "bad.json");
  writeFileSync(bad, "// comment\n{}");
  const to3 = join(dir, "omni3", "opencode-providers.json");
  assert.match(migratePiProviders({ from: bad, to: to3, catalog }).error, /JSON/);
  assert.equal(existsSync(migrationMarker(to3)), false);
});
