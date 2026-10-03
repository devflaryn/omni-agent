/**
 * Pure helpers for the Omni Agent pi model fallback.
 *
 * Node built-ins only — this file is imported both by omni-fallback.ts and by
 * test/omni-fallback-lib.test.mjs (node --test cannot import the .ts directly).
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** models.json path the way pi resolves it (PI_CODING_AGENT_DIR overrides ~/.pi/agent). */
export function modelsFile(env = process.env) {
	const dir = env.PI_CODING_AGENT_DIR ? env.PI_CODING_AGENT_DIR.replace(/^~(?=$|[\\/])/, homedir()) : join(homedir(), ".pi", "agent");
	return join(dir, "models.json");
}

/** The fallback chain: providers in file order, each provider's models in line order. */
export function readChain(file) {
	if (!existsSync(file)) return [];
	let json;
	try { json = JSON.parse(readFileSync(file, "utf8")); } catch { return []; }
	const out = [];
	for (const [provider, p] of Object.entries(json?.providers && typeof json.providers === "object" ? json.providers : {})) {
		for (const m of Array.isArray(p?.models) ? p.models : []) {
			const id = typeof m === "string" ? m : String(m?.id ?? "");
			if (id) out.push({ provider, id });
		}
	}
	return out;
}

/** Models below `current` in the chain, in order. Empty when `current` is not listed or is last. */
export function modelsBelow(chain, current) {
	if (!current) return [];
	const i = chain.findIndex((s) => s.provider === current.provider && s.id === current.id);
	return i < 0 ? [] : chain.slice(i + 1);
}

/** Models above `current` in the chain, closest first (toward the primary). */
export function modelsAbove(chain, current) {
	if (!current) return [];
	const i = chain.findIndex((s) => s.provider === current.provider && s.id === current.id);
	return i <= 0 ? [] : chain.slice(0, i).reverse();
}

/** One step up toward the primary, only after enough consecutive healthy turns. */
export function nextModelOnHealthy(chain, current, { cooldownTurns = 5, healthyTurns = 0 } = {}) {
	if (healthyTurns < cooldownTurns) return null;
	const up = modelsAbove(chain, current);
	return up[0] || null;
}
