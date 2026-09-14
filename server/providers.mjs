/**
 * Omni's provider config for pi. The single source of truth is pi's own `~/.pi/agent/models.json`
 * (see pi's docs/models.md): `{ providers: { <name>: { baseUrl, api, apiKey, models: [...] } } }`.
 * Omni edits only `providers.<name>` and preserves everything else in the file (unknown top-level
 * keys, `compat`, `headers`), so hand-written entries survive.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";

/** Request protocols pi's model runtime implements. */
export const PI_APIS = ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"];

/** Preset base URLs. A preset only prefills the form; the user may rename the provider and edit the URL. */
export const PRESETS = [
  { key: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", api: "openai-completions", hint: "model ids look like vendor/model, e.g. deepseek/deepseek-v4-flash-0731" },
  { key: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", api: "openai-completions", hint: "e.g. gpt-5, gpt-5-mini" },
  { key: "anthropic", label: "Anthropic", baseUrl: "https://api.anthropic.com", api: "anthropic-messages", hint: "e.g. claude-opus-5, claude-sonnet-5" },
  { key: "google", label: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", api: "google-generative-ai", hint: "e.g. gemini-2.5-pro" },
  { key: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", api: "openai-completions", hint: "e.g. deepseek-chat, deepseek-reasoner" },
  { key: "groq", label: "Groq", baseUrl: "https://api.groq.com/openai/v1", api: "openai-completions", hint: "e.g. llama-3.3-70b-versatile" },
  { key: "xai", label: "xAI", baseUrl: "https://api.x.ai/v1", api: "openai-completions", hint: "e.g. grok-4" },
  { key: "mistral", label: "Mistral", baseUrl: "https://api.mistral.ai/v1", api: "openai-completions", hint: "e.g. mistral-large-latest" },
  { key: "together", label: "Together AI", baseUrl: "https://api.together.xyz/v1", api: "openai-completions", hint: "e.g. Qwen/Qwen3-235B-A22B-Instruct" },
  { key: "fireworks", label: "Fireworks", baseUrl: "https://api.fireworks.ai/inference/v1", api: "openai-completions", hint: "e.g. accounts/fireworks/models/deepseek-v3" },
  { key: "ollama", label: "Ollama (local)", baseUrl: "http://localhost:11434/v1", api: "openai-completions", hint: "e.g. llama3.1:8b · key can be anything" },
  { key: "lmstudio", label: "LM Studio (local)", baseUrl: "http://localhost:1234/v1", api: "openai-completions", hint: "the model name LM Studio shows · key can be anything" },
  { key: "custom-openai", label: "Custom (OpenAI-compatible)", baseUrl: "", api: "openai-completions", hint: "any /v1 endpoint: vLLM, modal, a proxy" },
  { key: "custom-anthropic", label: "Custom (Anthropic-compatible)", baseUrl: "", api: "anthropic-messages", hint: "an Anthropic-style /messages endpoint or proxy" },
];

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;
const DEFAULTS = { contextWindow: 128000, maxTokens: 16384 };

export function readModelsFile(file) {
  if (!file || !existsSync(file)) return { providers: {} };
  try {
    const j = JSON.parse(readFileSync(file, "utf8"));
    if (!j || typeof j !== "object") return { providers: {} };
    if (!j.providers || typeof j.providers !== "object") j.providers = {};
    return j;
  } catch { return { providers: {} }; }
}

function writeModelsFile(file, json) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
  try { chmodSync(file, 0o600); } catch { /* windows */ }
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
  const json = readModelsFile(file);
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
  const next = { ...prev, baseUrl: String(body.baseUrl).trim(), api: body.api, models };
  if (body.apiKey === undefined) { if (prev.apiKey) next.apiKey = prev.apiKey; }
  else if (String(body.apiKey).trim()) next.apiKey = String(body.apiKey).trim();
  else delete next.apiKey;
  json.providers[name] = next;
  writeModelsFile(file, json);
  return next;
}

export function removeProvider(file, name) {
  const json = readModelsFile(file);
  if (!(name in json.providers)) return false;
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
    models: (Array.isArray(p?.models) ? p.models : []).map((m) => ({ id: m.id, name: m.name || m.id, reasoning: m.reasoning === true, contextWindow: m.contextWindow ?? null, maxTokens: m.maxTokens ?? null })),
  }));
}

/** Flat model list for the picker, in file order. */
export function flatModels(file) {
  const out = [];
  for (const p of listProviders(file)) for (const m of p.models) out.push({ provider: p.name, id: m.id, name: m.name, contextWindow: m.contextWindow });
  return out;
}
