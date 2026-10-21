/**
 * Where pi compacts a chat. pi compacts once `tokens > model.contextWindow − settings.compaction.reserveTokens`,
 * so a model declared with a 1M window compacts only past ~975k, long after it starts ending its turns
 * because it believes its context is used up (~400k). Omni caps the EFFECTIVE window instead of the declared
 * model entry: models.json `providers.<P>.modelOverrides[<id>].contextWindow` is the last layer pi applies
 * (provider-composer.js `getModels`), so `compactAt + reserveTokens` there makes pi compact at `compactAt`.
 *
 * Omni remembers the value it wrote per "provider/model" (`managed`, in its own state file) so its override
 * is told apart from one the user wrote by hand: a hand-written override is never touched. The record is
 * written before models.json, so a failed write never leaves a cap Omni has no record of; losing the state
 * file itself (a reset ~/.omni-agent) does, and that cap then stays until it is removed by hand.
 *
 * Limit: only the global ~/.pi/agent/settings.json is read. pi deep-merges `<cwd>/.pi/settings.json` over it,
 * and models.json is global (one file for every pi, whatever its cwd), so a project that sets its own
 * `compaction.reserveTokens` compacts at `compactAt + globalReserve − projectReserve` instead.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { effectiveContextWindow } from "../integrations/pi/omni-context-lib.mjs";
import { stripBom, writeModelsFile } from "./providers.mjs";

/** pi's default `compaction.reserveTokens` (settings-manager.js). */
export const DEFAULT_RESERVE_TOKENS = 16384;

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
/** An override slot that is there but not a plain object (or sits in a non-object `modelOverrides`): not ours to edit. */
const FOREIGN = Symbol("foreign");

/**
 * pi's settings.compaction as far as the cap depends on it: `enabled` (pi: `?? true`, then tested for truth) and
 * `reserveTokens` (pi's default when the file or the value is missing/invalid).
 * @returns {{ enabled: boolean, reserveTokens: number }}
 */
export function readCompactionSettings(settingsFile) {
  let c;
  try { c = JSON.parse(stripBom(readFileSync(settingsFile, "utf8")))?.compaction; } catch { /* missing or broken: pi's defaults */ }
  const n = c?.reserveTokens;
  return {
    enabled: Boolean(c?.enabled ?? true),
    reserveTokens: typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : DEFAULT_RESERVE_TOKENS,
  };
}

/** settings.compaction.reserveTokens, or pi's default when the file or the value is missing/invalid. */
export const readReserveTokens = (settingsFile) => readCompactionSettings(settingsFile).reserveTokens;

// Own keys only: a model id is file data, and "__proto__" must not reach Object.prototype.
const own = (o, k) => (Object.hasOwn(o, k) ? o[k] : undefined);

/** The override's contextWindow (undefined = none, FOREIGN = a shape Omni leaves alone). */
function overrideOf(prov, id) {
  const all = own(prov, "modelOverrides");
  if (all === undefined) return undefined;
  if (!isObj(all)) return FOREIGN;
  const o = own(all, id);
  if (o === undefined) return undefined;
  return isObj(o) ? own(o, "contextWindow") : FOREIGN;
}
function setOverride(prov, id, value) {
  if (!Object.hasOwn(prov, "modelOverrides")) prov.modelOverrides = {};
  if (!Object.hasOwn(prov.modelOverrides, id)) Object.defineProperty(prov.modelOverrides, id, { value: {}, writable: true, enumerable: true, configurable: true });
  prov.modelOverrides[id].contextWindow = value;
}
/** Drop our contextWindow; then the override object and `modelOverrides` when nothing else is left in them. */
function clearOverride(prov, id) {
  delete prov.modelOverrides[id].contextWindow;
  if (!Object.keys(prov.modelOverrides[id]).length) delete prov.modelOverrides[id];
  if (!Object.keys(prov.modelOverrides).length) delete prov.modelOverrides;
}

/**
 * The models.json Omni wants for `compactAt`. PURE: the input is never mutated, everything Omni does not own
 * (models[] entries, other override fields, users' overrides, other keys) comes back unchanged.
 * @param {object} modelsJson  parsed models.json
 * @param {{compactAt?: number, reserveTokens?: number, managed?: Record<string, number>}} opts
 *   `managed`: "provider/model" → the contextWindow Omni last wrote there
 * @returns {{ json: object, managed: Record<string, number>, changes: {key: string, from: number|null, to: number|null}[] }}
 */
export function planContextCaps(modelsJson, { compactAt = 0, reserveTokens = DEFAULT_RESERVE_TOKENS, managed = {} } = {}) {
  const json = structuredClone(modelsJson ?? {});
  const prev = Object.fromEntries(Object.entries(isObj(managed) ? managed : {}).filter(([, v]) => typeof v === "number"));
  const providers = isObj(json?.providers) ? json.providers : null;
  // A file Omni cannot read as providers tells nothing about which models are gone: keep what it manages.
  if (!providers) return { json, managed: prev, changes: [] };
  const next = {}, changes = [], seen = new Set();
  for (const [p, prov] of Object.entries(providers)) {
    if (!isObj(prov) || !Array.isArray(prov.models)) continue;
    const windows = new Map(); // the last definition of an id wins, as in pi's applyModelsJson
    for (const m of prov.models) if (isObj(m) && typeof m.id === "string" && m.id) windows.set(m.id, m.contextWindow);
    for (const [id, contextWindow] of windows) {
      const key = `${p}/${id}`;
      seen.add(key);
      const eff = effectiveContextWindow({ contextWindow, compactAt, reserveTokens });
      const ov = overrideOf(prov, id);
      const ours = Object.hasOwn(prev, key) && ov === prev[key];
      if (eff != null) {
        if (ov !== undefined && !ours) continue; // the user's own override (or a shape we leave alone)
        if (ov !== eff) { setOverride(prov, id, eff); changes.push({ key, from: ov ?? null, to: eff }); }
        next[key] = eff;
      } else if (ours) {
        clearOverride(prov, id);
        changes.push({ key, from: ov, to: null });
      }
    }
  }
  // Models Omni capped that are no longer declared: take its override back out.
  for (const [key, value] of Object.entries(prev)) {
    if (seen.has(key)) continue;
    const i = key.indexOf("/");
    const prov = i > 0 ? own(providers, key.slice(0, i)) : null;
    const id = key.slice(i + 1);
    if (isObj(prov) && overrideOf(prov, id) === value) { clearOverride(prov, id); changes.push({ key, from: value, to: null }); }
  }
  return { json, managed: next, changes };
}

function atomicWriteJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const text = `${JSON.stringify(value, null, 2)}\n`, tmp = `${file}.${process.pid}.tmp`;
  try { writeFileSync(tmp, text); renameSync(tmp, file); }
  catch { try { unlinkSync(tmp); } catch { /* never written */ } writeFileSync(file, text); }
}
function readManaged(stateFile) {
  try {
    const m = JSON.parse(stripBom(readFileSync(stateFile, "utf8")))?.managed;
    return isObj(m) ? m : {};
  } catch { return {}; }
}
const sameMap = (a, b) => { const ka = Object.keys(a); return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && b[k] === a[k]); };

/**
 * Bring models.json in line with `compactAt` (call before every pi start: pi reads models.json only at boot).
 * Writes models.json only when an override changes, and the state file only when what Omni manages changes.
 * Without a `stateFile` Omni cannot recognise its own overrides later, so it would never update them. Never throws.
 *
 * With pi's auto-compaction off (settings `compaction.enabled: false`) every cap is taken out: pi then never
 * compacts, but it still sizes each request from the window, so past a cap pi-ai's clampMaxTokensToContext
 * would cut max_tokens to 1 instead of letting the chat run on to the model's real window.
 * @param {{modelsFile: string, settingsFile?: string, stateFile?: string, compactAt: number, reserveTokens?: number}} opts
 *   `reserveTokens` defaults to pi's settings (settingsFile)
 * @returns {{ changed: boolean, changes: {key: string, from: number|null, to: number|null}[], error?: string }}
 */
export function applyContextCaps({ modelsFile, settingsFile, stateFile, compactAt, reserveTokens } = {}) {
  let json;
  try {
    if (!modelsFile || !existsSync(modelsFile)) return { changed: false, changes: [] };
    json = JSON.parse(stripBom(readFileSync(modelsFile, "utf8")));
  } catch (e) { return { changed: false, changes: [], error: `models.json not read: ${e.message}` }; }
  if (!isObj(json) || !isObj(json.providers)) return { changed: false, changes: [], error: "models.json has no providers object" };
  let changed = false, changes = [];
  try {
    const managed = stateFile ? readManaged(stateFile) : {};
    const settings = readCompactionSettings(settingsFile);
    const plan = planContextCaps(json, { compactAt: settings.enabled ? compactAt : 0, reserveTokens: reserveTokens ?? settings.reserveTokens, managed });
    changes = plan.changes;
    let recorded = managed;
    if (changes.length) {
      // Record first (the new values, plus the ones being removed): a cap in models.json that Omni has no record
      // of would pass for the user's own from then on, never updated and never removed. A failed write puts the
      // old record back. No state file can be written → no cap is written either.
      const both = { ...managed, ...plan.managed };
      if (stateFile && !sameMap(both, managed)) { atomicWriteJson(stateFile, { managed: both }); recorded = both; }
      try { writeModelsFile(modelsFile, plan.json); }
      catch (e) {
        if (recorded !== managed) try { atomicWriteJson(stateFile, { managed }); } catch { /* the error below is reported */ }
        throw e;
      }
      changed = true;
    }
    if (stateFile && !sameMap(plan.managed, recorded)) atomicWriteJson(stateFile, { managed: plan.managed });
    return { changed, changes };
  } catch (e) { return { changed, changes, error: e.message }; }
}
