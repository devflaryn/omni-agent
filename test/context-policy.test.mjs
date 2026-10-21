import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_RESERVE_TOKENS, applyContextCaps, planContextCaps, readCompactionSettings, readReserveTokens } from "../server/context-policy.mjs";
import { upsertProvider } from "../server/providers.mjs";

const DS = "deepseek/deepseek-v4.1-flash-1017:floor";
const QWEN = "Qwen/Qwen3.8-27B";
const DS_KEY = `openrouter/${DS}`;
const models = () => ({
  providers: {
    openrouter: { baseUrl: "https://openrouter.ai/api/v1", api: "openai-completions", apiKey: "sk-or-x", models: [{ id: DS, name: "DeepSeek", contextWindow: 1000000, maxTokens: 16384, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] },
    orca: { baseUrl: "https://orca/v1", api: "openai-completions", compat: { supportsDeveloperRole: false }, models: [{ id: QWEN, contextWindow: 262144, maxTokens: 32768 }] },
  },
  somethingElse: { keep: true },
});
const tmp = () => mkdtempSync(join(tmpdir(), "omni-ctxcap-"));
const ov = (json, p, id) => json.providers[p].modelOverrides?.[id];

test("readReserveTokens reads compaction.reserveTokens and falls back to pi's default", () => {
  const dir = tmp(), f = join(dir, "settings.json");
  assert.equal(DEFAULT_RESERVE_TOKENS, 16384);
  assert.equal(readReserveTokens(join(dir, "missing.json")), 16384);
  assert.equal(readReserveTokens(undefined), 16384);
  writeFileSync(f, JSON.stringify({ compaction: { reserveTokens: 24576, keepRecentTokens: 20000 } }));
  assert.equal(readReserveTokens(f), 24576);
  writeFileSync(f, `﻿${JSON.stringify({ compaction: { reserveTokens: 49152 } })}`);
  assert.equal(readReserveTokens(f), 49152, "a PowerShell BOM is tolerated");
  writeFileSync(f, JSON.stringify({ compaction: { reserveTokens: 0 } }));
  assert.equal(readReserveTokens(f), 0, "0 is a valid reserve (pi uses ??)");
  for (const bad of [{ compaction: { reserveTokens: "24576" } }, { compaction: { reserveTokens: -1 } }, { compaction: null }, {}, []]) {
    writeFileSync(f, JSON.stringify(bad));
    assert.equal(readReserveTokens(f), 16384, JSON.stringify(bad));
  }
  writeFileSync(f, "{ broken");
  assert.equal(readReserveTokens(f), 16384);
});

test("readCompactionSettings reads compaction.enabled the way pi does (`?? true`, then truthiness)", () => {
  const dir = tmp(), f = join(dir, "settings.json");
  assert.deepEqual(readCompactionSettings(join(dir, "missing.json")), { enabled: true, reserveTokens: 16384 });
  const cases = [[{ compaction: { enabled: false, reserveTokens: 32768 } }, { enabled: false, reserveTokens: 32768 }], [{ compaction: { enabled: true } }, { enabled: true, reserveTokens: 16384 }],
    [{ compaction: { enabled: null } }, { enabled: true, reserveTokens: 16384 }], [{ compaction: { enabled: 0 } }, { enabled: false, reserveTokens: 16384 }], [{ compaction: "x" }, { enabled: true, reserveTokens: 16384 }]];
  for (const [settings, expected] of cases) {
    writeFileSync(f, JSON.stringify(settings));
    assert.deepEqual(readCompactionSettings(f), expected, JSON.stringify(settings));
  }
});

test("the 1M DeepSeek window is capped through modelOverrides so pi compacts at compactAt; the declared model is untouched", () => {
  const input = models();
  const { json, managed, changes } = planContextCaps(input, { compactAt: 256000, reserveTokens: 24576 });
  assert.deepEqual(ov(json, "openrouter", DS), { contextWindow: 280576 });
  assert.equal(280576 - 24576, 256000, "pi's trigger (window − reserve) lands on compactAt");
  assert.deepEqual(managed, { [DS_KEY]: 280576 });
  assert.deepEqual(changes, [{ key: DS_KEY, from: null, to: 280576 }]);
  assert.deepEqual(json.providers.openrouter.models, models().providers.openrouter.models, "models[] entries are not changed");
  assert.equal(json.providers.openrouter.apiKey, "sk-or-x");
  assert.deepEqual(json.somethingElse, { keep: true });
  assert.deepEqual(input, models(), "the input is never mutated");
});

test("a 262144 Qwen already compacts before compactAt: no override is written", () => {
  const { json, managed } = planContextCaps(models(), { compactAt: 256000, reserveTokens: 24576 });
  assert.equal("modelOverrides" in json.providers.orca, false);
  assert.equal(`orca/${QWEN}` in managed, false);
  assert.deepEqual(json.providers.orca, models().providers.orca, "the provider is byte-identical");
});

test("a model without a declared contextWindow is left alone (its real window is unknown)", () => {
  const input = { providers: { x: { baseUrl: "https://x/v1", api: "openai-completions", models: [{ id: "m" }] } } };
  const r = planContextCaps(input, { compactAt: 256000, reserveTokens: 24576 });
  assert.deepEqual(r.json, input); assert.deepEqual(r.managed, {}); assert.deepEqual(r.changes, []);
});

test("the user's own override is never touched (and is not managed)", () => {
  const input = models();
  input.providers.openrouter.modelOverrides = { [DS]: { contextWindow: 400000, maxTokens: 65536 } };
  for (const managed of [{}, { [DS_KEY]: 280576 }]) {
    for (const compactAt of [256000, 0]) {
      const r = planContextCaps(input, { compactAt, reserveTokens: 24576, managed });
      assert.deepEqual(ov(r.json, "openrouter", DS), { contextWindow: 400000, maxTokens: 65536 });
      assert.deepEqual(r.managed, {}, "a value Omni did not write is dropped from managed");
      assert.deepEqual(r.changes, []);
    }
  }
});

test("a user's override that happens to equal the cap is still theirs while Omni has no record of writing it", () => {
  const input = models();
  input.providers.openrouter.modelOverrides = { [DS]: { contextWindow: 280576 } };
  const r = planContextCaps(input, { compactAt: 128000, reserveTokens: 24576 });
  assert.deepEqual(ov(r.json, "openrouter", DS), { contextWindow: 280576 });
  assert.equal(DS_KEY in r.managed, false);
});

test("Omni's override follows compactAt and keeps the fields the user added next to it", () => {
  const first = planContextCaps(models(), { compactAt: 256000, reserveTokens: 24576 });
  first.json.providers.openrouter.modelOverrides[DS].maxTokens = 65536; // the user adds a field to Omni's override
  const second = planContextCaps(first.json, { compactAt: 128000, reserveTokens: 24576, managed: first.managed });
  assert.deepEqual(ov(second.json, "openrouter", DS), { contextWindow: 152576, maxTokens: 65536 });
  // 152576 is below Qwen's 262144 too, so it is capped now as well
  assert.deepEqual(second.managed, { [DS_KEY]: 152576, [`orca/${QWEN}`]: 152576 });
  assert.deepEqual(second.changes, [{ key: DS_KEY, from: 280576, to: 152576 }, { key: `orca/${QWEN}`, from: null, to: 152576 }]);
  // a new reserve moves it too
  const third = planContextCaps(second.json, { compactAt: 128000, reserveTokens: 49152, managed: second.managed });
  assert.equal(ov(third.json, "openrouter", DS).contextWindow, 177152);
});

test("Omni re-adds its override when someone deleted it", () => {
  const first = planContextCaps(models(), { compactAt: 256000, reserveTokens: 24576 });
  delete first.json.providers.openrouter.modelOverrides;
  const again = planContextCaps(first.json, { compactAt: 256000, reserveTokens: 24576, managed: first.managed });
  assert.equal(ov(again.json, "openrouter", DS).contextWindow, 280576);
  assert.deepEqual(again.changes, [{ key: DS_KEY, from: null, to: 280576 }]);
});

test("compactAt 0 removes only Omni's override: the override object and modelOverrides go when they end up empty", () => {
  const first = planContextCaps(models(), { compactAt: 256000, reserveTokens: 24576 });
  const off = planContextCaps(first.json, { compactAt: 0, reserveTokens: 24576, managed: first.managed });
  assert.deepEqual(off.json, models(), "back to the original file");
  assert.deepEqual(off.managed, {});
  assert.deepEqual(off.changes, [{ key: DS_KEY, from: 280576, to: null }]);
  // other override fields and other models' overrides stay
  first.json.providers.openrouter.modelOverrides[DS].name = "Mine";
  first.json.providers.openrouter.modelOverrides["other/model"] = { maxTokens: 1000 };
  const kept = planContextCaps(first.json, { compactAt: 0, reserveTokens: 24576, managed: first.managed });
  assert.deepEqual(kept.json.providers.openrouter.modelOverrides, { [DS]: { name: "Mine" }, "other/model": { maxTokens: 1000 } });
});

test("a model or provider that is gone takes Omni's override with it", () => {
  const first = planContextCaps(models(), { compactAt: 256000, reserveTokens: 24576 });
  const edited = structuredClone(first.json);
  edited.providers.openrouter.models = [{ id: "moonshotai/kimi-k2.5", contextWindow: 131072 }];
  const r = planContextCaps(edited, { compactAt: 256000, reserveTokens: 24576, managed: first.managed });
  assert.equal("modelOverrides" in r.json.providers.openrouter, false);
  assert.deepEqual(r.managed, {});
  assert.deepEqual(r.changes, [{ key: DS_KEY, from: 280576, to: null }]);
  // the whole provider removed: nothing to edit, the record is dropped
  const gone = structuredClone(first.json);
  delete gone.providers.openrouter;
  const g = planContextCaps(gone, { compactAt: 256000, reserveTokens: 24576, managed: first.managed });
  assert.deepEqual(g.json, gone); assert.deepEqual(g.managed, {}); assert.deepEqual(g.changes, []);
  // gone, but the user changed the value since: theirs now
  const changedByUser = structuredClone(edited);
  changedByUser.providers.openrouter.modelOverrides[DS].contextWindow = 300000;
  const u = planContextCaps(changedByUser, { compactAt: 256000, reserveTokens: 24576, managed: first.managed });
  assert.equal(ov(u.json, "openrouter", DS).contextWindow, 300000);
  assert.deepEqual(u.managed, {});
});

test("planning twice is idempotent", () => {
  const first = planContextCaps(models(), { compactAt: 256000, reserveTokens: 24576 });
  const second = planContextCaps(first.json, { compactAt: 256000, reserveTokens: 24576, managed: first.managed });
  assert.deepEqual(second.changes, []);
  assert.deepEqual(second.json, first.json);
  assert.deepEqual(second.managed, first.managed);
});

test("several providers and models are capped independently; the last definition of a duplicated id wins (as in pi)", () => {
  const input = models();
  input.providers.openrouter.models.push({ id: "big/one", contextWindow: 2000000 }, { id: "big/one", contextWindow: 200000 });
  input.providers.deepseek = { baseUrl: "https://api.deepseek.com/v1", api: "openai-completions", models: [{ id: "deepseek-chat", contextWindow: 1048576 }] };
  const r = planContextCaps(input, { compactAt: 100000, reserveTokens: 16384 });
  assert.deepEqual(r.managed, { [DS_KEY]: 116384, [`orca/${QWEN}`]: 116384, "deepseek/deepseek-chat": 116384, "openrouter/big/one": 116384 });
  assert.equal(r.changes.length, 4);
  const small = structuredClone(input);
  small.providers.openrouter.models.splice(1, 2, { id: "big/one", contextWindow: 2000000 }, { id: "big/one", contextWindow: 100000 });
  const s = planContextCaps(small, { compactAt: 100000, reserveTokens: 16384 });
  assert.equal("openrouter/big/one" in s.managed, false, "the last (100000) definition needs no cap");
});

test("shapes Omni cannot edit safely are left alone", () => {
  const managed = { [DS_KEY]: 280576 };
  const weird = models();
  weird.providers.openrouter.modelOverrides = "oops";
  let r = planContextCaps(weird, { compactAt: 256000, reserveTokens: 24576, managed });
  assert.equal(r.json.providers.openrouter.modelOverrides, "oops"); assert.deepEqual(r.changes, []);
  weird.providers.openrouter.modelOverrides = { [DS]: "nope" };
  r = planContextCaps(weird, { compactAt: 256000, reserveTokens: 24576, managed });
  assert.equal(r.json.providers.openrouter.modelOverrides[DS], "nope"); assert.deepEqual(r.changes, []);
  weird.providers.openrouter.modelOverrides = { [DS]: { contextWindow: "280576" } };
  r = planContextCaps(weird, { compactAt: 256000, reserveTokens: 24576, managed });
  assert.equal(ov(r.json, "openrouter", DS).contextWindow, "280576"); assert.deepEqual(r.changes, []);
  // providers / models that are not what pi expects: skipped; unreadable files keep what Omni manages
  const odd = { providers: { a: null, b: { models: "x" }, c: { models: [null, 3, { id: "" }, { contextWindow: 9 }] } } };
  r = planContextCaps(odd, { compactAt: 256000, reserveTokens: 24576 });
  assert.deepEqual(r.json, odd); assert.deepEqual(r.changes, []);
  for (const bad of [null, undefined, 5, { providers: [] }, { providers: "x" }]) {
    r = planContextCaps(bad, { compactAt: 256000, reserveTokens: 24576, managed });
    assert.deepEqual(r.changes, []); assert.deepEqual(r.managed, managed, String(bad));
  }
  // a corrupt managed record is ignored
  r = planContextCaps(models(), { compactAt: 256000, reserveTokens: 24576, managed: { [DS_KEY]: "280576", x: null } });
  assert.deepEqual(r.managed, { [DS_KEY]: 280576 });
});

test("a model id like __proto__ is an ordinary key: Object.prototype is never written", () => {
  const input = { providers: { p: { baseUrl: "https://p/v1", api: "openai-completions", models: [{ id: "__proto__", contextWindow: 1000000 }, { id: "constructor", contextWindow: 1000000 }] } } };
  try {
    const r = planContextCaps(input, { compactAt: 256000, reserveTokens: 16384 });
    assert.equal(({}).contextWindow, undefined, "no prototype pollution");
    assert.deepEqual(r.managed, { "p/__proto__": 272384, "p/constructor": 272384 });
    const text = JSON.stringify(r.json);
    assert.deepEqual(JSON.parse(text).providers.p.modelOverrides, JSON.parse('{"__proto__":{"contextWindow":272384},"constructor":{"contextWindow":272384}}'));
    assert.ok(Object.hasOwn(JSON.parse(text).providers.p.modelOverrides, "__proto__"), "written as an own key pi reads back");
    // read back from the file (own "__proto__" keys from JSON.parse): recognised as Omni's, and removed at compactAt 0
    const again = planContextCaps(JSON.parse(text), { compactAt: 256000, reserveTokens: 16384, managed: r.managed });
    assert.deepEqual(again.changes, []);
    const off = planContextCaps(JSON.parse(text), { compactAt: 0, reserveTokens: 16384, managed: r.managed });
    assert.deepEqual(off.json, input); assert.deepEqual(off.managed, {});
    // a user's own "__proto__" override is theirs
    const mine = JSON.parse(JSON.stringify(input).replace('"models"', '"modelOverrides":{"__proto__":{"contextWindow":400000}},"models"'));
    const u = planContextCaps(mine, { compactAt: 256000, reserveTokens: 16384 });
    assert.equal(u.json.providers.p.modelOverrides.__proto__.contextWindow, 400000);
    assert.equal("p/__proto__" in u.managed, false);
  } finally { delete Object.prototype.contextWindow; }
});

// ------------------------------------------------------------------ files

function fixture({ json = models(), reserve = 24576 } = {}) {
  const dir = tmp();
  const modelsFile = join(dir, "pi", "models.json"), settingsFile = join(dir, "pi", "settings.json"), stateFile = join(dir, "omni", "context-caps.json");
  mkdirSync(join(dir, "pi"), { recursive: true });
  if (json !== null) writeFileSync(modelsFile, typeof json === "string" ? json : JSON.stringify(json));
  if (reserve != null) writeFileSync(settingsFile, JSON.stringify({ compaction: { reserveTokens: reserve } }));
  return { dir, modelsFile, settingsFile, stateFile };
}

test("applyContextCaps writes the cap in providers.mjs's format, records what it manages, and a second run is a no-op", () => {
  const f = fixture();
  const r = applyContextCaps({ ...f, compactAt: 256000 });
  assert.equal(r.error, undefined);
  assert.equal(r.changed, true);
  assert.deepEqual(r.changes, [{ key: DS_KEY, from: null, to: 280576 }]);
  const expected = models();
  expected.providers.openrouter.modelOverrides = { [DS]: { contextWindow: 280576 } };
  const text = readFileSync(f.modelsFile, "utf8");
  assert.equal(text, `${JSON.stringify(expected, null, 2)}\n`);
  assert.deepEqual(JSON.parse(readFileSync(f.stateFile, "utf8")), { managed: { [DS_KEY]: 280576 } });
  const stateText = readFileSync(f.stateFile, "utf8");
  const again = applyContextCaps({ ...f, compactAt: 256000 });
  assert.deepEqual(again, { changed: false, changes: [] });
  assert.equal(readFileSync(f.modelsFile, "utf8"), text);
  assert.equal(readFileSync(f.stateFile, "utf8"), stateText);
  assert.deepEqual(readdirSync(join(f.dir, "pi")).sort(), ["models.json", "settings.json"], "no temp file is left behind");
  assert.deepEqual(readdirSync(join(f.dir, "omni")), ["context-caps.json"]);
});

test("applyContextCaps follows a compactAt change and takes its override out at compactAt 0", () => {
  const f = fixture();
  applyContextCaps({ ...f, compactAt: 256000 });
  const r = applyContextCaps({ ...f, compactAt: 200000 });
  assert.deepEqual(r.changes, [{ key: DS_KEY, from: 280576, to: 224576 }, { key: `orca/${QWEN}`, from: null, to: 224576 }]);
  const j = JSON.parse(readFileSync(f.modelsFile, "utf8"));
  assert.equal(j.providers.openrouter.modelOverrides[DS].contextWindow, 224576);
  assert.equal(j.providers.orca.modelOverrides[QWEN].contextWindow, 224576);
  assert.deepEqual(JSON.parse(readFileSync(f.stateFile, "utf8")), { managed: { [DS_KEY]: 224576, [`orca/${QWEN}`]: 224576 } });
  const off = applyContextCaps({ ...f, compactAt: 0 });
  assert.equal(off.changed, true);
  assert.equal(off.changes.length, 2);
  assert.equal(readFileSync(f.modelsFile, "utf8"), `${JSON.stringify(models(), null, 2)}\n`);
  assert.deepEqual(JSON.parse(readFileSync(f.stateFile, "utf8")), { managed: {} });
  assert.deepEqual(applyContextCaps({ ...f, compactAt: 0 }), { changed: false, changes: [] });
});

test("applyContextCaps leaves a hand-written override alone across runs", () => {
  const json = models();
  json.providers.openrouter.modelOverrides = { [DS]: { contextWindow: 500000 } };
  const f = fixture({ json });
  const before = readFileSync(f.modelsFile, "utf8");
  assert.deepEqual(applyContextCaps({ ...f, compactAt: 256000 }), { changed: false, changes: [] });
  assert.deepEqual(applyContextCaps({ ...f, compactAt: 0 }), { changed: false, changes: [] });
  assert.equal(readFileSync(f.modelsFile, "utf8"), before, "the file is not even reformatted");
});

test("applyContextCaps: a missing models.json is a no-op and creates nothing", () => {
  const f = fixture({ json: null });
  assert.deepEqual(applyContextCaps({ ...f, compactAt: 256000 }), { changed: false, changes: [] });
  assert.deepEqual(readdirSync(join(f.dir, "pi")), ["settings.json"]);
  assert.deepEqual(applyContextCaps({ compactAt: 256000 }), { changed: false, changes: [] });
});

test("applyContextCaps reports a malformed models.json and never rewrites it", () => {
  for (const bad of ["{ broken", "[]", JSON.stringify({ providers: 3 }), "// a comment\n{}"]) {
    const f = fixture({ json: bad });
    const r = applyContextCaps({ ...f, compactAt: 256000 });
    assert.equal(r.changed, false, bad);
    assert.ok(r.error, bad);
    assert.equal(readFileSync(f.modelsFile, "utf8"), bad);
  }
});

test("applyContextCaps falls back to pi's default reserve and to an empty record on broken side files", () => {
  const f = fixture({ reserve: null });
  writeFileSync(f.settingsFile, "{ nope");
  const r = applyContextCaps({ ...f, compactAt: 256000 });
  assert.deepEqual(r.changes, [{ key: DS_KEY, from: null, to: 256000 + 16384 }]);
  // a broken state file: Omni no longer knows the value is its own, so it leaves it (never clobbers a user's value)
  writeFileSync(f.stateFile, "garbage");
  const r2 = applyContextCaps({ ...f, compactAt: 128000 });
  assert.equal(r2.error, undefined);
  assert.deepEqual(r2.changes, [{ key: `orca/${QWEN}`, from: null, to: 128000 + 16384 }], "only the uncapped Qwen gets a (new) cap");
  assert.equal(JSON.parse(readFileSync(f.modelsFile, "utf8")).providers.openrouter.modelOverrides[DS].contextWindow, 272384);
  // an explicit reserveTokens wins over the settings file
  const g = fixture();
  assert.equal(applyContextCaps({ ...g, compactAt: 100000, reserveTokens: 0 }).changes[0].to, 100000);
});

test("applyContextCaps reads a BOM-prefixed models.json (PowerShell) and writes it back without the BOM", () => {
  const f = fixture({ json: `﻿${JSON.stringify(models())}` });
  const r = applyContextCaps({ ...f, compactAt: 256000 });
  assert.equal(r.changed, true);
  const text = readFileSync(f.modelsFile, "utf8");
  assert.notEqual(text.charCodeAt(0), 0xfeff);
  assert.equal(JSON.parse(text).providers.openrouter.modelOverrides[DS].contextWindow, 280576);
});

test("applyContextCaps never throws", () => {
  const f = fixture();
  const dirAsFile = applyContextCaps({ modelsFile: join(f.dir, "pi"), compactAt: 256000 });
  assert.equal(dirAsFile.changed, false); assert.ok(dirAsFile.error);
  assert.doesNotThrow(() => applyContextCaps());
  assert.doesNotThrow(() => applyContextCaps({ modelsFile: f.modelsFile, compactAt: "lots" }));
});

test("applyContextCaps never writes a cap it cannot record: an unwritable state file leaves models.json alone", () => {
  const f = fixture();
  const before = readFileSync(f.modelsFile, "utf8");
  const r = applyContextCaps({ ...f, stateFile: join(f.modelsFile, "state.json"), compactAt: 256000 }); // its folder would be a file
  assert.equal(r.changed, false); assert.ok(r.error);
  assert.equal(readFileSync(f.modelsFile, "utf8"), before, "no orphaned cap the next run would take for the user's");
  // the next run with a working state file caps, and compactAt 0 takes it out again
  assert.equal(applyContextCaps({ ...f, compactAt: 256000 }).changed, true);
  const off = applyContextCaps({ ...f, compactAt: 0 });
  assert.deepEqual(off.changes, [{ key: DS_KEY, from: 280576, to: null }]);
  assert.equal(readFileSync(f.modelsFile, "utf8"), `${JSON.stringify(models(), null, 2)}\n`);
});

test("applyContextCaps: a models.json write that fails after the record was written puts the old record back", (t) => {
  const f = fixture();
  applyContextCaps({ ...f, compactAt: 256000 });
  const state = readFileSync(f.stateFile, "utf8"), text = readFileSync(f.modelsFile, "utf8");
  chmodSync(f.modelsFile, 0o444); // Windows refuses both the rename over it and the plain write
  if (process.platform !== "win32") chmodSync(join(f.dir, "pi"), 0o555);
  try {
    let refused = false;
    try { writeFileSync(f.modelsFile, text); } catch { refused = true; }
    if (!refused) return t.skip("this account can write read-only files");
    const r = applyContextCaps({ ...f, compactAt: 200000 });
    assert.equal(r.changed, false); assert.ok(r.error);
    assert.equal(readFileSync(f.stateFile, "utf8"), state, "the record still names the cap models.json holds");
    assert.equal(readFileSync(f.modelsFile, "utf8"), text);
  } finally {
    if (process.platform !== "win32") chmodSync(join(f.dir, "pi"), 0o755);
    chmodSync(f.modelsFile, 0o644);
  }
  // writable again: Omni still recognises its cap and moves it
  assert.deepEqual(applyContextCaps({ ...f, compactAt: 200000 }).changes[0], { key: DS_KEY, from: 280576, to: 224576 });
});

test("applyContextCaps takes every cap out while pi's auto-compaction is off (a cap would only clamp max_tokens)", () => {
  const f = fixture();
  applyContextCaps({ ...f, compactAt: 256000 });
  writeFileSync(f.settingsFile, JSON.stringify({ compaction: { enabled: false, reserveTokens: 24576 } }));
  const r = applyContextCaps({ ...f, compactAt: 256000 });
  assert.deepEqual(r.changes, [{ key: DS_KEY, from: 280576, to: null }]);
  assert.equal(readFileSync(f.modelsFile, "utf8"), `${JSON.stringify(models(), null, 2)}\n`);
  assert.deepEqual(JSON.parse(readFileSync(f.stateFile, "utf8")), { managed: {} });
  // a fresh file with compaction off gets no cap at all; turning it back on restores the cap
  const g = fixture();
  writeFileSync(g.settingsFile, JSON.stringify({ compaction: { enabled: false } }));
  assert.deepEqual(applyContextCaps({ ...g, compactAt: 256000, reserveTokens: 24576 }), { changed: false, changes: [] });
  writeFileSync(g.settingsFile, JSON.stringify({ compaction: { enabled: true, reserveTokens: 24576 } }));
  assert.deepEqual(applyContextCaps({ ...g, compactAt: 256000 }).changes, [{ key: DS_KEY, from: null, to: 280576 }]);
});

test("the Providers dialog and the cap coexist: upsertProvider keeps the cap, the next apply recomputes it from the edited window", () => {
  const f = fixture();
  applyContextCaps({ ...f, compactAt: 256000 });
  upsertProvider(f.modelsFile, "openrouter", { baseUrl: "https://openrouter.ai/api/v1", api: "openai-completions", models: [{ id: DS }, { id: "moonshotai/kimi-k2.5", contextWindow: 131072 }] });
  let j = JSON.parse(readFileSync(f.modelsFile, "utf8"));
  assert.deepEqual(j.providers.openrouter.modelOverrides, { [DS]: { contextWindow: 280576 } }, "saving the provider keeps Omni's override");
  assert.equal(j.providers.openrouter.models[0].contextWindow, 1000000, "and the declared window");
  assert.deepEqual(applyContextCaps({ ...f, compactAt: 256000 }), { changed: false, changes: [] });
  // the user lowers the declared window below compactAt + reserve: no cap is needed any more
  upsertProvider(f.modelsFile, "openrouter", { baseUrl: "https://openrouter.ai/api/v1", api: "openai-completions", models: [{ id: DS, contextWindow: 200000 }] });
  const r = applyContextCaps({ ...f, compactAt: 256000 });
  assert.deepEqual(r.changes, [{ key: DS_KEY, from: 280576, to: null }]);
  j = JSON.parse(readFileSync(f.modelsFile, "utf8"));
  assert.equal("modelOverrides" in j.providers.openrouter, false);
  assert.equal(j.providers.openrouter.models[0].contextWindow, 200000);
});
