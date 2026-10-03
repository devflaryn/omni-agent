/**
 * Omni Agent "context brain" for long unattended pi runs. Reads the run ledger named by
 * OMNI_RUN_DIR and:
 *   - session_before_compact: writes a fixed-budget, non-growing summary (thinking OFF, a
 *     configurable cheap model allowed) derived from ledger.md, so compaction never death-spirals.
 *   - context: prepends the verbatim goal + a budgeted ledger slice to every LLM call, so the
 *     goal and critical facts (paths/symbols/addresses) survive any number of compactions.
 *   - tool_result: offloads oversized tool output (huge .so dumps) to artifacts/ and leaves a
 *     short reference inline, so one result can't blow the window.
 * Installed by: node scripts/install.mjs
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderContextBlock, renderCompactionSummary, shouldOffload, offloadReference, sha256Hex } from "./omni-run-lib.mjs";

function runDir(): string | null {
	const d = process.env.OMNI_RUN_DIR;
	return d && existsSync(d) ? d : null;
}
const readText = (f: string) => { try { return readFileSync(f, "utf8"); } catch { return ""; } };

export default function omniRun(pi: ExtensionAPI) {
	const dir = runDir();
	if (!dir) return; // no active run; this extension is a no-op for ordinary chats
	const ledgerFile = join(dir, "ledger.md");
	const artifactsDir = join(dir, "artifacts");
	const controlFile = join(dir, "run.json");
	const goal = () => { try { return JSON.parse(readText(controlFile)).goalText || ""; } catch { return ""; } };
	// Optional cheap summarizer model: run.json.model.summary = "provider/id"
	const summaryModel = () => { try { return JSON.parse(readText(controlFile)).model?.summary || ""; } catch { return ""; } };

	// 1) Re-inject goal + ledger every LLM call (not persisted; pi's context semantics).
	pi.on("context", (ev: any) => {
		const block = renderContextBlock({ goal: goal(), ledgerMd: readText(ledgerFile) }, { budget: 4000 });
		const sys = { role: "system", content: [{ type: "text", text: block }] };
		return { messages: [sys, ...ev.messages] };
	});

	// 2) Fixed-budget compaction derived from the ledger (thinking off). Never grows.
	pi.on("session_before_compact", async (ev: any, ctx: any) => {
		try {
			const serialized = ctx?.serializeConversation ? ctx.serializeConversation(ev.preparation?.messagesToSummarize ?? []) : "";
			const summary = renderCompactionSummary({ goal: goal(), ledgerMd: readText(ledgerFile), serializedSpan: serialized }, { budget: 6000 });
			return { compaction: { summary, firstKeptEntryId: ev.preparation?.firstKeptEntryId, tokensBefore: ev.preparation?.tokensBefore } };
		} catch {
			return undefined; // fall back to pi's own compaction rather than failing the run
		}
	});

	// 3) Offload oversized tool results to artifacts/, leave a short reference inline.
	pi.on("tool_result", (ev: any) => {
		try {
			const content: any[] = Array.isArray(ev.content) ? ev.content : [];
			let changed = false;
			const next = content.map((c) => {
				if (c?.type !== "text" || !shouldOffload(c.text)) return c;
				const sha = sha256Hex(c.text);
				mkdirSync(artifactsDir, { recursive: true });
				const path = join(artifactsDir, `${sha.slice(0, 32)}.txt`);
				if (!existsSync(path)) writeFileSync(path, c.text);
				changed = true;
				return { type: "text", text: offloadReference({ sha, bytes: Buffer.byteLength(c.text), preview: c.text.slice(0, 800), path: `artifacts/${sha.slice(0, 32)}.txt` }) };
			});
			if (changed) return { content: next };
		} catch { /* never fail the tool */ }
	});
}
