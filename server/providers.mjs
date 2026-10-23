/**
 * Model providers. Two stores share this file's helpers, both `{ providers: { <name>: { baseUrl, apiKey, models: [...] } } }`:
 *
 * - Omni's own custom providers for OpenCode (BYOK), `~/.omni-agent/opencode-providers.json` (`cfg.opencodeProvidersFile`):
 *   OpenAI-compatible endpoints the Providers dialog edits, rendered into Omni's `opencode.json` `provider` block by
 *   customProviderConfig(). OpenCode's own providers (openrouter, anthropic, its Zen `opencode`, …) are not stored here:
 *   their key goes to OpenCode's auth store (`PUT /auth/:id`). The first OpenCode start copies pi's custom providers
 *   over once (migratePiProviders).
 * - pi's `~/.pi/agent/models.json` (see pi's docs/models.md), which pi-era code (context caps, thinking maps) still
 *   edits. Omni edits only `providers.<name>` and preserves everything else in the file (unknown top-level keys,
 *   `compat`, `headers`, and the provider's own unknown keys such as `modelOverrides`), so hand-written entries survive.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, renameSync, realpathSync, unlinkSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { thinkingProfile } from "../ui/thinking.js";

/** Request protocols pi's model runtime implements. */
export const PI_APIS = ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"];

/**
 * The Providers dialog's presets. `kind: "custom"` prefills a custom OpenAI-compatible provider (the user may rename it
 * and edit the URL); `kind: "key"` is one of OpenCode's own providers (`key` is its OpenCode id): only its API key is
 * asked for, and it goes to OpenCode's auth store.
 */
export const PRESETS = [
  { kind: "key", key: "openrouter", label: "OpenRouter", hint: "OpenCode lists every OpenRouter model once its key is set" },
  { kind: "key", key: "anthropic", label: "Anthropic", hint: "an Anthropic API key (sk-ant-…)" },
  { kind: "key", key: "openai", label: "OpenAI", hint: "an OpenAI API key (sk-…)" },
  { kind: "key", key: "google", label: "Google Gemini", hint: "a Gemini API key from AI Studio" },
  { kind: "key", key: "opencode", label: "OpenCode Zen", hint: "an OpenCode Zen key (its free models need none)" },
  { kind: "key", key: "deepseek", label: "DeepSeek", hint: "a DeepSeek API key" },
  { kind: "key", key: "groq", label: "Groq", hint: "a Groq API key" },
  { kind: "key", key: "xai", label: "xAI", hint: "an xAI API key" },
  { kind: "key", key: "mistral", label: "Mistral", hint: "a Mistral API key" },
  { kind: "key", key: "togetherai", label: "Together AI", hint: "a Together AI API key" },
  { kind: "key", key: "fireworks-ai", label: "Fireworks", hint: "a Fireworks API key" },
  { kind: "key", key: "opencode-other", anyId: true, label: "Other OpenCode provider…", hint: "type the id OpenCode uses for it (e.g. moonshotai, nvidia, zai) and paste its key" },
  { kind: "custom", key: "custom", label: "Custom (OpenAI-compatible)", baseUrl: "", hint: "any /v1 endpoint: vLLM, modal, a proxy" },
  { kind: "custom", key: "ollama", label: "Ollama (local)", baseUrl: "http://localhost:11434/v1", hint: "e.g. llama3.1:8b · no key needed" },
  { kind: "custom", key: "lmstudio-local", label: "LM Studio (local)", baseUrl: "http://localhost:1234/v1", hint: "the model name LM Studio shows · no key needed" },
];

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;
const DEFAULTS = { contextWindow: 128000, maxTokens: 16384 };

/** A file saved by PowerShell starts with a BOM, which JSON.parse rejects (pi strips it too). */
export const stripBom = (s) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * models.json with `providers` always an object. Lenient for readers: missing or unreadable → empty.
 * `strict` is for the write paths: a file that is there but is not plain JSON (pi also accepts comments) or
 * whose root/`providers` is not an object throws a 409, because rewriting it would drop every provider in it.
 */
export function readModelsFile(file, { strict = false } = {}) {
  if (!file || !existsSync(file)) return { providers: {} };
  const refuse = (why) => {
    if (!strict) return { providers: {} };
    throw Object.assign(new Error(`models.json was not changed: ${why}. Fix ${file} by hand (Omni rewrites the whole file, so it would lose what is in it).`), { status: 409 });
  };
  let j;
  try {
    const text = stripBom(readFileSync(file, "utf8"));
    j = text.trim() ? JSON.parse(text) : {};
  } catch (e) { return refuse(`it could not be read as JSON (${e.message}; comments are not supported)`); }
  if (!isObj(j)) return refuse("it is not a JSON object");
  if (j.providers == null) j.providers = {};
  else if (!isObj(j.providers)) return refuse("its `providers` is not an object");
  return j;
}

/**
 * 2-space JSON + newline, mode 600 (it holds API keys). Atomic (tmp + rename) so a pi starting at the same
 * moment never reads half a file; a symlinked models.json is written through to its target. When the rename
 * is refused (Windows: the target held open without delete sharing) it falls back to a plain write.
 */
export function writeModelsFile(file, json) {
  let target = file;
  try { target = realpathSync(file); } catch { /* not there yet */ }
  mkdirSync(dirname(target), { recursive: true });
  const text = `${JSON.stringify(json, null, 2)}\n`, tmp = `${target}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, target);
  } catch {
    try { unlinkSync(tmp); } catch { /* never written */ }
    writeFileSync(target, text);
  }
  try { chmodSync(target, 0o600); } catch { /* windows */ }
}

const num = (v, dflt) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.round(n) : dflt; };

/** Typed model ids (strings or {id,...}) → pi model entries with sane defaults. Blank ids are dropped. */
export function normalizeModels(list) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const m = typeof raw === "string" ? { id: raw } : raw && typeof raw === "object" ? raw : null;
    const id = String(m?.id ?? "").trim();
    if (!id) continue;
    out.push({
      id,
      name: String(m.name || "").trim() || id,
      reasoning: m.reasoning !== false,
      input: Array.isArray(m.input) && m.input.length ? m.input : ["text"],
      contextWindow: num(m.contextWindow, DEFAULTS.contextWindow),
      maxTokens: num(m.maxTokens, DEFAULTS.maxTokens),
      cost: m.cost && typeof m.cost === "object" ? m.cost : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
  }
  return out;
}

/** @returns {string|null} an error message, or null when the provider is valid */
export function validateProvider(name, body) {
  if (!NAME_RE.test(String(name || ""))) return "provider name must be lowercase letters, digits, - or _ (e.g. openrouter)";
  try { const u = new URL(String(body?.baseUrl || "")); if (!/^https?:$/.test(u.protocol)) throw new Error(); } catch { return "base URL must be a valid http(s) URL"; }
  if (!PI_APIS.includes(body?.api)) return `api must be one of ${PI_APIS.join(", ")}`;
  if (!normalizeModels(body?.models).length) return "add at least one model id";
  return null;
}

/** Create or replace `providers.<name>`. An omitted/undefined apiKey keeps the stored one; "" clears it. */
export function upsertProvider(file, name, body) {
  const err = validateProvider(name, body);
  if (err) throw Object.assign(new Error(err), { status: 400 });
  const json = readModelsFile(file, { strict: true });
  const prev = json.providers[name] || {};
  // Per model id, keep what the file already had (image input, costs, compat) and let the form override.
  const prevById = new Map((Array.isArray(prev.models) ? prev.models : []).map((m) => [m?.id, m]));
  const models = [];
  for (const raw of body.models) {
    const given = typeof raw === "string" ? { id: raw } : raw && typeof raw === "object" ? raw : {};
    const [m] = normalizeModels([given]);
    if (!m) continue;
    const old = prevById.get(m.id);
    if (!old) { models.push(m); continue; }
    const merged = { ...old, ...m };
    for (const k of ["name", "reasoning", "input", "contextWindow", "maxTokens", "cost"]) if (given[k] === undefined && old[k] !== undefined) merged[k] = old[k];
    models.push(merged);
  }
  // `...prev` keeps the provider's keys the form does not edit: modelOverrides (Omni's context caps), headers, compat, authHeader.
  const next = { ...prev, baseUrl: String(body.baseUrl).trim(), api: body.api, models };
  if (body.apiKey === undefined) { if (prev.apiKey) next.apiKey = prev.apiKey; }
  else if (String(body.apiKey).trim()) next.apiKey = String(body.apiKey).trim();
  else delete next.apiKey;
  json.providers[name] = next;
  fillThinkingMaps(json);
  writeModelsFile(file, json);
  return next;
}

/**
 * Rewrite `providers` in the given order (names not listed keep their relative order after the listed ones).
 * The order is the model fallback chain: when a model errors, pi's omni-fallback extension moves to the next
 * model in `flatModels()` order, i.e. this provider order with each provider's model lines in sequence.
 * @returns {string[]} the resulting order
 */
export function reorderProviders(file, names) {
  const json = readModelsFile(file, { strict: true });
  const wanted = (Array.isArray(names) ? names : []).map(String).filter((n, i, a) => Object.hasOwn(json.providers, n) && a.indexOf(n) === i);
  const rest = Object.keys(json.providers).filter((n) => !wanted.includes(n));
  const order = [...wanted, ...rest];
  json.providers = Object.fromEntries(order.map((n) => [n, json.providers[n]]));
  writeModelsFile(file, json);
  return order;
}

export function removeProvider(file, name) {
  const json = readModelsFile(file, { strict: true });
  if (!Object.hasOwn(json.providers, name)) return false;
  delete json.providers[name];
  writeModelsFile(file, json);
  return true;
}

const keyHint = (k) => { const s = String(k || ""); return s && !s.startsWith("$") && !s.startsWith("!") ? s.slice(-4) : s ? s.slice(0, 12) : ""; };

/** Providers for the UI: no key material, only whether one is set and a hint. */
export function listProviders(file) {
  const { providers } = readModelsFile(file);
  return Object.entries(providers).map(([name, p]) => ({
    name,
    baseUrl: p?.baseUrl || "",
    api: p?.api || "openai-completions",
    hasKey: !!p?.apiKey,
    keyHint: keyHint(p?.apiKey),
    ...(p?.builtIn === true ? { builtIn: true } : {}),
    models: (Array.isArray(p?.models) ? p.models : []).map((m) => ({ id: m.id, name: m.name || m.id, reasoning: m.reasoning === true, contextWindow: m.contextWindow ?? null, maxTokens: m.maxTokens ?? null })),
  }));
}

/** Flat model list for the picker, in file order, each with the thinking levels it has (ui/thinking.js). */
export function flatModels(file) {
  const out = [];
  for (const [provider, p] of Object.entries(readModelsFile(file).providers)) {
    for (const m of Array.isArray(p?.models) ? p.models : []) {
      if (!m?.id) continue;
      const t = thinkingProfile({ provider, ...m });
      out.push({ provider, id: m.id, name: m.name || m.id, contextWindow: m.contextWindow ?? null, thinking: t.levels, thinkingLabels: t.labels });
    }
  }
  return out;
}

/** The models.json entry for provider/id (null: not one of the file's own models, e.g. pi's built-in catalogue). */
export function modelEntry(file, provider, id) {
  const m = (readModelsFile(file).providers[provider]?.models || []).find?.((x) => x?.id === id);
  return m ? { provider, ...m } : null;
}

/**
 * Give each model with no `thinkingLevelMap` the one its family needs (thinkingProfile), so pi offers and sends only
 * the levels the model has. A map already there (the user's, or one written earlier) is never changed: a wrong guess
 * is fixed by editing it in models.json. Mutates `json`; → the "provider/id" keys it filled.
 */
export function fillThinkingMaps(json) {
  const filled = [];
  for (const [provider, p] of Object.entries(json?.providers || {})) {
    for (const m of Array.isArray(p?.models) ? p.models : []) {
      if (!isObj(m) || !m.id || m.thinkingLevelMap !== undefined || m.reasoning === false) continue;
      const { map } = thinkingProfile({ provider, ...m });
      if (map) { m.thinkingLevelMap = map; filled.push(`${provider}/${m.id}`); }
    }
  }
  return filled;
}

// ------------------------------------------------------------------ OpenCode custom providers (Omni's store)
/** Typed model ids (strings or {id,...}) → the store's model entries. Blank ids are dropped. */
export function normalizeCustomModels(list) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const m = typeof raw === "string" ? { id: raw } : raw && typeof raw === "object" ? raw : null;
    const id = String(m?.id ?? "").trim();
    if (!id) continue;
    out.push({ id, name: String(m.name || "").trim() || id, contextWindow: num(m.contextWindow, DEFAULTS.contextWindow), maxTokens: num(m.maxTokens, DEFAULTS.maxTokens), reasoning: m.reasoning === true });
  }
  return out;
}

/**
 * @param {boolean} [builtIn] the entry only adds models to one of OpenCode's own providers (no base URL of its own)
 * @returns {string|null} an error message, or null when the custom provider is valid
 */
export function validateCustomProvider(name, body, builtIn = body?.builtIn === true) {
  if (!NAME_RE.test(String(name || ""))) return "provider name must be lowercase letters, digits, - or _ (e.g. modal)";
  if (builtIn) return normalizeCustomModels(body?.models).length ? null : "add at least one model id";
  try { const u = new URL(String(body?.baseUrl || "")); if (!/^https?:$/.test(u.protocol)) throw new Error(); } catch { return "base URL must be a valid http(s) URL"; }
  if (!normalizeCustomModels(body?.models).length) return "add at least one model id";
  return null;
}

/**
 * Create or replace the custom provider `name` in Omni's store. An omitted apiKey keeps the stored one; "" clears it.
 * A model re-saved by id alone keeps its stored name, limits and reasoning; keys the form does not edit are kept.
 * `builtIn: true` (given, or already on the stored entry) stores only extra models for one of OpenCode's own providers:
 * `{builtIn: true, models}`, never a base URL or key, so OpenCode's definition of it and its stored key still apply.
 */
export function saveCustomProvider(file, name, body) {
  const json = readModelsFile(file, { strict: true });
  const prev = isObj(json.providers[name]) ? json.providers[name] : {};
  const builtIn = body?.builtIn === true || prev.builtIn === true;
  const err = validateCustomProvider(name, body, builtIn);
  if (err) throw Object.assign(new Error(err), { status: 400 });
  const prevById = new Map((Array.isArray(prev.models) ? prev.models : []).map((m) => [m?.id, m]));
  const models = [];
  for (const raw of body.models) {
    const given = typeof raw === "string" ? { id: raw } : raw && typeof raw === "object" ? raw : {};
    const [m] = normalizeCustomModels([given]);
    if (!m) continue;
    const old = prevById.get(m.id);
    if (old) for (const k of ["name", "contextWindow", "maxTokens", "reasoning"]) if (given[k] === undefined && old[k] !== undefined) m[k] = old[k];
    models.push(m);
  }
  if (builtIn) {
    json.providers[name] = { builtIn: true, models };
    writeModelsFile(file, json);
    return json.providers[name];
  }
  const { apiKey: _k, ...rest } = prev;
  const next = { ...rest, baseUrl: String(body.baseUrl).trim() };
  const key = body.apiKey === undefined ? prev.apiKey : String(body.apiKey).trim();
  if (key) next.apiKey = key;
  next.models = models;
  json.providers[name] = next;
  writeModelsFile(file, json);
  return next;
}

/** A stored key as OpenCode config: pi's `$VAR` / `${VAR}` references become OpenCode's `{env:VAR}`. */
const opencodeKey = (k) => { const m = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(String(k).trim()); return m ? `{env:${m[1]}}` : String(k); };

/**
 * Omni's custom providers as OpenCode's `provider` config block (OpenAI-compatible endpoints), in store order. An entry
 * that extends one of OpenCode's own providers (`builtIn`) renders as `{models}` only: OpenCode merges those models into
 * its own definition of the provider, whose SDK, URL and stored key stay as they are.
 */
export function customProviderConfig(file) {
  const out = {};
  for (const [name, p] of Object.entries(readModelsFile(file).providers)) {
    if (!isObj(p) || (!p.baseUrl && p.builtIn !== true)) continue;
    const models = {};
    for (const m of Array.isArray(p.models) ? p.models : []) {
      if (!m?.id) continue;
      models[m.id] = { name: m.name || m.id, limit: { context: num(m.contextWindow, DEFAULTS.contextWindow), output: num(m.maxTokens, DEFAULTS.maxTokens) }, ...(m.reasoning === true && p.builtIn !== true ? { reasoning: true } : {}) };
    }
    if (p.builtIn === true) { if (Object.keys(models).length) out[name] = { models }; continue; }
    const options = { baseURL: String(p.baseUrl) };
    if (p.apiKey) options.apiKey = opencodeKey(p.apiKey);
    out[name] = { npm: "@ai-sdk/openai-compatible", name, options, models };
  }
  return out;
}

/** The file that records the one-time copy of pi's providers: next to the store. */
export const migrationMarker = (file) => join(dirname(file), `${basename(file).replace(/\.json$/i, "")}.migrated.json`);

/**
 * Copies pi's custom providers (`from`, pi's models.json) into Omni's store (`to`) once; the marker file next to the
 * store makes every later call a no-op (→ null). A name OpenCode already has (`catalog` is its `GET /provider` answer:
 * built-in providers and the user's global config) is never overridden: only the models of pi's entry that OpenCode's
 * provider does not list are kept, as `{builtIn: true, models}` (`extended`), so OpenCode's own definition and stored key
 * still apply. Skipped, each with a reason in `lines`: a name Omni's store already has, one OpenCode has with nothing to
 * add, and a provider that does not speak the OpenAI chat API. A key that runs a command (pi's `!cmd`) cannot be
 * expressed in OpenCode's config: the provider is copied without it.
 * A pi file that cannot be read → `{ error }` and no marker, so the next start tries again.
 * @returns {{copied: string[], extended: {name: string, models: string[]}[], skipped: {name: string, why: string}[], lines: string[]} | {error: string} | null}
 */
export function migratePiProviders({ from, to, catalog = null }) {
  const marker = migrationMarker(to);
  if (existsSync(marker)) return null;
  let pi;
  try { pi = readModelsFile(from, { strict: true }); } catch (e) { return { error: e.message }; }
  const store = readModelsFile(to, { strict: true });
  const known = new Map((Array.isArray(catalog?.all) ? catalog.all : []).map((p) => [p?.id, p]));
  const connected = new Set(Array.isArray(catalog?.connected) ? catalog.connected : []);
  const copied = [], extended = [], skipped = [], lines = [];
  for (const [name, p] of Object.entries(pi.providers)) {
    if (!isObj(p)) continue;
    const ids = (Array.isArray(p.models) ? p.models : []).map((m) => m?.id).filter(Boolean);
    let why = null;
    if (Object.hasOwn(store.providers, name)) why = `Omni already has a provider named ${name}`;
    else if (known.has(name)) {
      const lacks = new Set(ids.filter((id) => !Object.hasOwn(known.get(name)?.models || {}, id)));
      if (!lacks.size) why = `OpenCode already has a provider named ${name}${connected.has(name) ? " (connected)" : ""} with every model pi listed for it`;
      else {
        const models = normalizeCustomModels(p.models.filter((m) => lacks.has(m?.id)));
        store.providers[name] = { builtIn: true, models };
        extended.push({ name, models: models.map((m) => m.id) });
        for (const m of models) lines.push(`Providers: added pi's model ${m.id} to OpenCode's ${name} (OpenCode's own provider and its key stay as they are).`);
        continue;
      }
    } else if ((p.api || "openai-completions") !== "openai-completions") why = `it uses ${p.api}, and Omni's custom providers are OpenAI-compatible only (OpenCode's own provider for it takes just a key)`;
    else if (!p.baseUrl || !ids.length) why = "it has no base URL or no models";
    if (why) { skipped.push({ name, why }); lines.push(`Providers: pi's ${name} was not copied: ${why}.`); continue; }
    const entry = { baseUrl: String(p.baseUrl), models: normalizeCustomModels(p.models) };
    const key = String(p.apiKey || "").trim();
    if (key.startsWith("!")) lines.push(`Providers: pi's ${name} gets its key by running a command, which OpenCode cannot do: set its key in Providers.`);
    else if (key) entry.apiKey = key;
    store.providers[name] = entry;
    copied.push(name);
    lines.push(`Providers: copied pi's ${name} (${entry.models.length} model${entry.models.length === 1 ? "" : "s"}) into OpenCode.`);
  }
  if (copied.length || extended.length) writeModelsFile(to, store);
  mkdirSync(dirname(marker), { recursive: true });
  writeFileSync(marker, `${JSON.stringify({ at: new Date().toISOString(), from, copied, extended, skipped }, null, 2)}\n`);
  return { copied, extended, skipped, lines };
}

/** fillThinkingMaps on the file (call before a pi starts: pi reads models.json only at boot). Never throws. */
export function applyThinkingMaps(file) {
  try {
    if (!file || !existsSync(file)) return { filled: [] };
    const json = readModelsFile(file, { strict: true });
    const filled = fillThinkingMaps(json);
    if (filled.length) writeModelsFile(file, json);
    return { filled };
  } catch (e) { return { filled: [], error: e.message }; }
}
