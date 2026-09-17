/**
 * Omni Agent model fallback for pi.
 *
 * When a run ends because the model returned an error, switch pi to the next model in
 * `~/.pi/agent/models.json` (provider order, then each provider's model lines — the order the
 * Providers dialog shows and lets you drag) and continue the turn on that model at once.
 * pi's own transient-error retry, when it fires, already runs on the switched model.
 *
 * The retried model sees the conversation exactly as the failed one did: the errored assistant
 * messages and this extension's own switch notice are dropped from the LLM context here (pi's
 * message transform drops errored messages too; this makes it explicit). Nothing is appended
 * for the model to read — the notice is display-only.
 *
 * The chain stops at the bottom of the list: the last model's error stays visible, and the
 * user picks a model or edits the list. A new chat starts back on the picked model.
 *
 * Installed by: node scripts/install.mjs   (in the omni-agent folder)
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const NOTICE = "omni-fallback";

interface Slot { provider: string; id: string }

/** models.json path the way pi resolves it (PI_CODING_AGENT_DIR overrides ~/.pi/agent). */
export function modelsFile(env: NodeJS.ProcessEnv = process.env): string {
	const dir = env.PI_CODING_AGENT_DIR ? env.PI_CODING_AGENT_DIR.replace(/^~(?=$|[\\/])/, homedir()) : join(homedir(), ".pi", "agent");
	return join(dir, "models.json");
}

/** The fallback chain: providers in file order, each provider's models in line order. */
export function readChain(file: string): Slot[] {
	if (!existsSync(file)) return [];
	let json: any;
	try { json = JSON.parse(readFileSync(file, "utf8")); } catch { return []; }
	const out: Slot[] = [];
	for (const [provider, p] of Object.entries<any>(json?.providers && typeof json.providers === "object" ? json.providers : {})) {
		for (const m of Array.isArray(p?.models) ? p.models : []) {
			const id = typeof m === "string" ? m : String(m?.id ?? "");
			if (id) out.push({ provider, id });
		}
	}
	return out;
}

/** Models below `current` in the chain, in order. Empty when `current` is not listed or is last. */
export function modelsBelow(chain: Slot[], current: Slot | undefined): Slot[] {
	if (!current) return [];
	const i = chain.findIndex((s) => s.provider === current.provider && s.id === current.id);
	return i < 0 ? [] : chain.slice(i + 1);
}

const short = (s: unknown, n = 160) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

export default function omniFallback(pi: ExtensionAPI) {
	pi.registerMessageRenderer(NOTICE, (message: any, _opts: unknown, theme: any) => {
		const text = Array.isArray(message.content) ? message.content.map((c: any) => (c?.type === "text" ? c.text : "")).join("") : String(message.content ?? "");
		return new Text(theme.fg("warning", "↷ ") + theme.fg("muted", text), 0, 0);
	});

	// Errored turns and our switch notices never reach the model.
	pi.on("context", (ev: any) => ({
		messages: ev.messages.filter((m: any) => !(m.role === "assistant" && m.stopReason === "error") && !(m.role === "custom" && m.customType === NOTICE)),
	}));

	// agent_end fires before pi decides whether to retry: switching here means pi's own retry (transient errors)
	// already runs on the next model, and for every other error the steered notice makes pi continue the run —
	// on the new model, with the notice and the errored turn filtered out of what it reads.
	pi.on("agent_end", async (ev: any, ctx: any) => {
		const failed = Array.isArray(ev.messages) ? ev.messages[ev.messages.length - 1] : undefined;
		if (!failed || failed.role !== "assistant" || failed.stopReason !== "error") return;
		const current: Slot | undefined = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : failed.provider && failed.model ? { provider: failed.provider, id: failed.model } : undefined;
		for (const next of modelsBelow(readChain(modelsFile()), current)) {
			const model = ctx.modelRegistry?.find?.(next.provider, next.id);
			if (!model) continue;
			if (!(await pi.setModel(model))) continue;
			const text = `model error on ${current!.provider}/${current!.id} → switched to ${next.provider}/${next.id}` + (failed.errorMessage ? ` (${short(failed.errorMessage)})` : "");
			await pi.sendMessage({ customType: NOTICE, content: text, display: true }, { deliverAs: "steer" });
			return;
		}
	});
}
