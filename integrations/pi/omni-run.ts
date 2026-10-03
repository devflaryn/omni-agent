/**
 * Omni Agent "context brain" for long unattended pi runs. Reads the run ledger named by
 * OMNI_RUN_DIR and:
 *   - session_before_compact: distills the compacted span INTO ledger.md with a model
 *     (thinking OFF, the configured summary model if set), PERSISTS ledger.md, and returns
 *     a bounded render of the updated ledger. Fails open to pi's own compaction on any error.
 *   - context: prepends the verbatim goal + a budgeted ledger slice to every LLM call, so the
 *     goal and critical facts (paths/symbols/addresses) survive any number of compactions.
 *   - tool_result: offloads oversized tool output (huge .so dumps, big screenshots) to
 *     artifacts/ and leaves a short reference inline, so one result can't blow the window.
 * Installed by: node scripts/install.mjs
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderContextBlock, renderCompactionSummary, shouldOffload, offloadReference, sha256Hex, imageBlockData, extForMediaType } from "./omni-run-lib.mjs";

function runDir(): string | null {
	const d = process.env.OMNI_RUN_DIR;
	return d && existsSync(d) ? d : null;
}
const readText = (f: string) => { try { return readFileSync(f, "utf8"); } catch { return ""; } };

/** The full `## <name>` block (heading + body up to the next `## ` or end), trailing-trimmed; "" if absent. */
function sectionBlock(md: string, name: string): string {
	const re = new RegExp(`^##\\s+${name}\\s*$`, "im");
	const m = re.exec(md);
	if (!m) return "";
	const after = md.slice(m.index + m[0].length);
	const nm = /^##\s+/m.exec(after);
	const end = nm ? m.index + m[0].length + nm.index : md.length;
	return md.slice(m.index, end).replace(/\s+$/, "");
}

/** Guarantee the `## Goal` section of `updated` is exactly the one from `original` (verbatim),
 *  regardless of what the model did — inserting it after the title if the model dropped it. */
function preserveGoal(updated: string, original: string): string {
	const orig = sectionBlock(original, "Goal");
	if (!orig) return updated;
	const up = sectionBlock(updated, "Goal");
	if (up) return updated.replace(up, () => orig);
	if (/^#\s+/m.test(updated)) return updated.replace(/^(#[^\n]*\n)/m, (mm) => `${mm}\n${orig}\n`);
	return `${orig}\n\n${updated}`;
}

/** Strip a surrounding ```/```markdown code fence the model may wrap the ledger in. */
function stripFence(text: string): string {
	const t = text.trim();
	const m = /^```[a-zA-Z]*\n([\s\S]*?)\n```$/.exec(t);
	return m ? m[1].trim() : t;
}

/** Resolve the summary model: the configured run.json model.summary ("provider/id" or {provider,id})
 *  if set and found, else the active session/compaction model the API gives us. */
function resolveSummaryModel(ctx: any, control: any): any {
	try {
		const cfg = control?.model?.summary;
		if (cfg) {
			let provider = "", id = "";
			if (typeof cfg === "string") {
				const i = cfg.indexOf("/");
				if (i > 0) { provider = cfg.slice(0, i); id = cfg.slice(i + 1); } else { id = cfg; }
			} else { provider = cfg.provider || ""; id = cfg.id || cfg.model || ""; }
			if (provider && id) {
				const found = ctx?.modelRegistry?.find?.(provider, id);
				if (found) return found;
			}
		}
	} catch { /* fall through to session model */ }
	return ctx?.model ?? null;
}

function ledgerUpdatePrompt(goal: string, currentLedger: string, serializedSpan: string): string {
	return [
		"You maintain a durable progress ledger (markdown) for a long unattended coding run.",
		"The conversation span below is about to be dropped from context during compaction.",
		"Fold everything still useful from it INTO the ledger, then output the UPDATED ledger.",
		"",
		"Rules:",
		"- Output ONLY the updated ledger markdown. No preamble, no code fence, no commentary.",
		"- Preserve the `## Goal` section EXACTLY, verbatim. Never edit or restate the goal.",
		"- Keep the same section headings. Keep each section tight and bounded — merge, don't append endlessly.",
		"- Merge new progress, decisions, and critical facts (paths, symbols, addresses, offsets, versions).",
		"- Drop nothing important; prune only redundancy and resolved chatter.",
		"",
		"<goal>",
		goal,
		"</goal>",
		"",
		"<current-ledger>",
		currentLedger,
		"</current-ledger>",
		"",
		"<conversation-span-being-compacted>",
		serializedSpan,
		"</conversation-span-being-compacted>",
	].join("\n");
}

export default function omniRun(pi: ExtensionAPI) {
	const dir = runDir();
	if (!dir) return; // no active run; this extension is a no-op for ordinary chats
	const ledgerFile = join(dir, "ledger.md");
	const artifactsDir = join(dir, "artifacts");
	const controlFile = join(dir, "run.json");
	const goal = () => { try { return JSON.parse(readText(controlFile)).goalText || ""; } catch { return ""; } };

	// Atomic ledger writer (tmp + rename), mkdir'ing the run dir defensively.
	const writeLedgerMd = (text: string) => {
		mkdirSync(dir, { recursive: true });
		const tmp = `${ledgerFile}.tmp`;
		writeFileSync(tmp, String(text));
		renameSync(tmp, ledgerFile);
	};

	// 1) Re-inject goal + ledger every LLM call (not persisted; pi's context semantics).
	pi.on("context", (ev: any) => {
		try {
			const block = renderContextBlock({ goal: goal(), ledgerMd: readText(ledgerFile) }, { budget: 4000 });
			const sys = { role: "system", content: [{ type: "text", text: block }] };
			return { messages: [sys, ...ev.messages] };
		} catch {
			return undefined; // no-op: keep the original messages
		}
	});

	// 2) Distill the compacted span INTO ledger.md (thinking off), persist it, and return a
	//    bounded render of the UPDATED ledger. The whole thing is fail-open: any error returns
	//    undefined so pi falls back to its own compaction and the run never dies.
	pi.on("session_before_compact", async (ev: any, ctx: any) => {
		try {
			const prep = ev?.preparation ?? {};
			// 1) Current ledger.
			const currentLedger = readText(ledgerFile);
			// 2) Serialize the span pi is about to summarize (messagesToSummarize + any split-turn prefix).
			const toSummarize = [...(prep.messagesToSummarize ?? []), ...(prep.turnPrefixMessages ?? [])];
			const serialized = toSummarize.length ? serializeConversation(convertToLlm(toSummarize)) : "";
			// 3) Pick the summary model (configured summary model, else session/compaction model).
			const model = resolveSummaryModel(ctx, (() => { try { return JSON.parse(readText(controlFile)); } catch { return {}; } })());
			if (!model || typeof ctx?.modelRegistry?.complete !== "function") return undefined; // fall back to pi

			const prompt = ledgerUpdatePrompt(goal(), currentLedger, serialized);
			const response = await ctx.modelRegistry.complete(
				model,
				{ messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] },
				{ maxTokens: 8192, signal: ev?.signal ?? ctx?.signal, reasoning: "off", cacheRetention: "none" },
			);
			const text = (response?.content ?? [])
				.filter((c: any): c is { type: "text"; text: string } => c?.type === "text")
				.map((c: any) => c.text)
				.join("\n")
				.trim();
			if (!text) return undefined; // empty summary → fall back to pi

			// 4) Preserve the goal verbatim, then persist the updated ledger.
			const updated = preserveGoal(stripFence(text), currentLedger);
			writeLedgerMd(updated);

			// 5) Return a bounded render of the NEW ledger using the event's preparation fields.
			const summary = renderCompactionSummary({ goal: goal(), ledgerMd: updated, serializedSpan: serialized }, { budget: 6000 });
			return { compaction: { summary, firstKeptEntryId: prep.firstKeptEntryId, tokensBefore: prep.tokensBefore, usage: response?.usage } };
		} catch {
			return undefined; // 6) fail open: never throw, never worse than pi's own compaction
		}
	});

	// 3) Offload oversized tool results (text AND images) to artifacts/, leave a short reference inline.
	pi.on("tool_result", (ev: any) => {
		try {
			const content: any[] = Array.isArray(ev.content) ? ev.content : [];
			let changed = false;
			const next = content.map((c) => {
				// Text blocks: offload the raw string.
				if (c?.type === "text" && shouldOffload(c.text)) {
					const sha = sha256Hex(c.text);
					mkdirSync(artifactsDir, { recursive: true });
					const rel = `artifacts/${sha.slice(0, 32)}.txt`;
					const path = join(artifactsDir, `${sha.slice(0, 32)}.txt`);
					if (!existsSync(path)) writeFileSync(path, c.text);
					changed = true;
					return { type: "text", text: offloadReference({ sha, bytes: Buffer.byteLength(c.text), preview: c.text.slice(0, 800), path: rel }) };
				}
				// Image blocks: offload the decoded bytes when the base64 payload is over the cap.
				const img = imageBlockData(c);
				if (img && shouldOffload(img.data)) {
					const bytes = Buffer.from(img.data, "base64");
					const sha = sha256Hex(img.data);
					mkdirSync(artifactsDir, { recursive: true });
					const ext = extForMediaType(img.mediaType);
					const rel = `artifacts/${sha.slice(0, 32)}.${ext}`;
					const path = join(artifactsDir, `${sha.slice(0, 32)}.${ext}`);
					if (!existsSync(path)) writeFileSync(path, bytes);
					changed = true;
					return { type: "text", text: offloadReference({ sha, bytes: bytes.length, preview: `[image ${img.mediaType || "unknown"}, ${bytes.length} bytes]`, path: rel }) };
				}
				return c;
			});
			if (changed) return { content: next };
		} catch { /* never fail the tool */ }
	});
}
