/* The model picker's list as last seen, per machine, so the picker has something in it at once and the real list can take its time
   (asking OpenCode takes a second or two). Only the fields the picker uses are kept: names and sizes, never anything a provider's
   entry might carry beside them. Whatever goes wrong here costs a list that fills in a moment later, and no more. */
const PREFIX = "omni.models.";
const FIELDS = ["provider", "id", "name", "contextWindow", "thinking", "thinkingLabels", "free"];

const defaultStorage = () => { try { return globalThis.localStorage ?? null; } catch { return null; } };

const brief = (model) => Object.fromEntries(FIELDS.filter((key) => model?.[key] !== undefined).map((key) => [key, model[key]]));

/** `machineId`: the chosen machine's id, or "here" for this computer. */
export function cachedModels(machineId, storage = defaultStorage()) {
  try {
    const kept = JSON.parse(storage?.getItem(`${PREFIX}${machineId}`) ?? "null");
    return kept && Array.isArray(kept.models) ? kept : null;
  } catch { return null; }
}

export function keepModels(machineId, { models, levels, labels }, storage = defaultStorage()) {
  try {
    storage?.setItem(`${PREFIX}${machineId}`, JSON.stringify({ models: (models ?? []).map(brief), levels, labels }));
  } catch { /* full, or not allowed: next time it asks */ }
}

export function forgetCachedModels(storage = defaultStorage()) {
  try {
    if (!storage) return;
    for (let i = storage.length - 1; i >= 0; i--) {
      const key = storage.key(i);
      if (key?.startsWith(PREFIX)) storage.removeItem(key);
    }
  } catch { /* nothing to do about it */ }
}
