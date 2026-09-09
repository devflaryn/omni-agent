/**
 * Allowlist for the pi model picker. Patterns are "provider/id" with `*` wildcards,
 * e.g. ["orca/*"] keeps only the local Qwen provider and hides the hundreds of
 * OpenRouter models pi otherwise lists. No patterns → no filtering.
 */
function toRegex(pattern) {
  const esc = String(pattern).toLowerCase().split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${esc}$`);
}

export function filterPiModels(models, patterns) {
  const list = Array.isArray(models) ? models : [];
  if (!Array.isArray(patterns) || !patterns.length) return list;
  const res = patterns.map(toRegex);
  return list.filter((m) => { const key = `${m?.provider || ""}/${m?.id || ""}`.toLowerCase(); return res.some((r) => r.test(key)); });
}
