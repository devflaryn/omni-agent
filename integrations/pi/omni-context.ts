/**
 * Omni Agent context policy for pi. Long runs ended because the model believed its context was "nearly
 * exhausted" and wrote handoffs for a fresh session, while pi compacts automatically and carries on from
 * a summary. So:
 *   - before_agent_start: the system prompt gets CONTEXT_GUIDANCE (context is managed for you; never
 *     stop or hand off because of it) — static text, so the cached prompt prefix is stable.
 *   - context: once the conversation passes `context.statusFromPercent` (default 70) of the budget pi
 *     compacts at (contextWindow − compaction.reserveTokens), a one-line status note is appended to the
 *     newest message of the LLM call — not persisted, and at the tail so the cached prefix is kept.
 * The stop rules and wording are shared with the server's goal hook (omni-context-lib.mjs, installed
 * beside this file). OMNI_CONTEXT=off turns it off; so does `compaction.enabled: false` in pi's settings
 * (then nothing compacts and the guidance would not be true).
 *
 * Config: ~/.pi/agent/omni-agent.json  { "context": { "statusFromPercent": 70 } }
 *         pi's settings.json  { "compaction": { "reserveTokens": 16384 } }
 * Installed by: node scripts/install.mjs
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { compact, convertToLlm, generateSummaryWithUsage, serializeConversation } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONTEXT_GUIDANCE, chunkBySize, contextStatusNote, foldIntoSummary, repairToolCallIds, summaryInputBudget, tokensOfChars } from "./omni-context-lib.mjs";

/** pi's own default for compaction.reserveTokens. */
const PI_RESERVE_TOKENS = 16384;

const readJson = (file: string): any => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return {}; } };

/** pi's settings.json, where pi looks for it (PI_CODING_AGENT_DIR overrides ~/.pi/agent). */
function piSettingsFile(): string {
	const d = process.env.PI_CODING_AGENT_DIR;
	return join(d ? d.replace(/^~(?=$|[\\/])/, homedir()) : join(homedir(), ".pi", "agent"), "settings.json");
}

export default function omniContext(pi: ExtensionAPI) {
	// A tool call saved without an id would 400 every later request; repaired on the way out (the saved session is
	// left as it is). Independent of the context policy below, so it stays on when that is turned off.
	pi.on("context", async (ev: any) => {
		try {
			const messages = repairToolCallIds(ev?.messages);
			return messages ? { messages } : undefined;
		} catch {
			return undefined;
		}
	});

	if (String(process.env.OMNI_CONTEXT || "").toLowerCase() === "off") return;
	const compaction = readJson(piSettingsFile())?.compaction ?? {};
	if (compaction.enabled === false) return;
	const reserve = Number.isFinite(Number(compaction.reserveTokens)) && Number(compaction.reserveTokens) >= 0 ? Number(compaction.reserveTokens) : PI_RESERVE_TOKENS;
	const from = Number(readJson(join(homedir(), ".pi", "agent", "omni-agent.json"))?.context?.statusFromPercent);
	const fromPercent = Number.isFinite(from) && from > 0 ? from : 70;

	pi.on("before_agent_start", async (event: any) => {
		const base = String(event?.systemPrompt ?? "");
		if (base.includes(CONTEXT_GUIDANCE)) return undefined;
		return { systemPrompt: base ? `${base}\n\n${CONTEXT_GUIDANCE}` : CONTEXT_GUIDANCE };
	});

	// Oversized compaction: a span bigger than one summary request can hold (an old chat resumed after Omni capped the
	// window, or one huge turn) is folded into the summary chunk by chunk with pi's own summarizer. A span that fits
	// returns undefined, so pi's own compaction runs unchanged; any failure does too (fail open, never worse than pi).
	// Unattended runs (OMNI_RUN_DIR) leave compaction to omni-run's ledger.
	pi.on("session_before_compact", async (ev: any, ctx: any) => {
		if (process.env.OMNI_RUN_DIR) return undefined;
		try {
			const prep = ev?.preparation, model = ctx?.model;
			if (!prep?.messagesToSummarize?.length || !model?.contextWindow || !prep.firstKeptEntryId) return undefined;
			const reserveTokens = Number(prep.settings?.reserveTokens) || reserve;
			const sizeOf = (m: any) => tokensOfChars(serializeConversation(convertToLlm([m])).length);
			// Room for the running summary as it grows (up to the summary's own output budget).
			const budget = summaryInputBudget({ contextWindow: model.contextWindow, reserveTokens, maxTokens: model.maxTokens, carriedChars: Math.max(String(prep.previousSummary || "").length, 40000) });
			const span = [...prep.messagesToSummarize, ...(prep.turnPrefixMessages || [])];
			if (span.reduce((n: number, m: any) => n + sizeOf(m), 0) <= budget) return undefined;
			const chunks = chunkBySize(prep.messagesToSummarize, sizeOf, Math.floor(budget * 0.85));
			const { apiKey, headers } = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			const signal = ev.signal;
			ctx.ui?.notify?.(`Compacting a large conversation in ${chunks.length} parts…`, "info");
			const result = await foldIntoSummary({
				chunks, previousSummary: prep.previousSummary,
				summarize: async (msgs: any[], prev: string) => (await generateSummaryWithUsage(msgs, model, reserveTokens, apiKey, headers, signal, ev.customInstructions, prev, "off")).text,
				last: (msgs: any[], prev: string) => compact({ ...prep, messagesToSummarize: msgs, previousSummary: prev }, model, apiKey, headers, ev.customInstructions, signal, "off"),
			});
			return result?.summary ? { compaction: result } : undefined;
		} catch {
			return undefined;
		}
	});

	// Tail note on the newest message, the way omni-plan appends its reminder: earlier messages stay byte-identical.
	// A `custom` message (a background agent's report) reaches the model as a user message too (pi's convertToLlm).
	pi.on("context", async (ev: any, ctx: any) => {
		try {
			const messages = ev?.messages;
			if (!Array.isArray(messages) || !messages.length) return undefined;
			const last = messages[messages.length - 1];
			if (last?.role !== "user" && last?.role !== "toolResult" && last?.role !== "custom") return undefined;
			const u = ctx?.getContextUsage?.();
			const tokens = u?.tokens, budget = (Number(u?.contextWindow) || 0) - reserve;
			if (tokens == null || !Number.isFinite(tokens) || budget <= 0) return undefined;
			const note = contextStatusNote((tokens / budget) * 100, { fromPercent });
			if (!note) return undefined;
			const content = typeof last.content === "string" ? [{ type: "text", text: last.content }] : [...(last.content || [])];
			content.push({ type: "text", text: `\n${note}` });
			return { messages: [...messages.slice(0, -1), { ...last, content }] };
		} catch {
			return undefined;
		}
	});
}
