/**
 * Pure helpers for the omni-run pi extension — no pi-runtime imports, so they load under
 * `node --test`. The extension (omni-run.ts) imports these and does the pi wiring.
 */
import { createHash } from "node:crypto";

export const sha256Hex = (text) => createHash("sha256").update(text).digest("hex");

const clip = (s, n) => { const t = String(s ?? ""); return t.length > n ? t.slice(0, n) : t; };

/** Pull named sections out of ledger.md (## headings). */
function sections(ledgerMd) {
  const out = {};
  const re = /^##\s+(.+)$/gm;
  let m, last = null, lastIdx = 0;
  while ((m = re.exec(ledgerMd))) { if (last) out[last] = ledgerMd.slice(lastIdx, m.index).trim(); last = m[1].trim(); lastIdx = re.lastIndex; }
  if (last) out[last] = ledgerMd.slice(lastIdx).trim();
  return out;
}

/** Verbatim goal + a budget-trimmed slice of the ledger (Critical facts and Next steps first). */
export function renderContextBlock({ goal, ledgerMd = "" }, { budget = 4000 } = {}) {
  const s = sections(ledgerMd);
  const order = ["Critical facts", "Next steps", "Milestones", "Decisions", "Constraints"];
  let body = "";
  for (const name of order) { if (!s[name]) continue; const add = `## ${name}\n${s[name]}\n\n`; if (body.length + add.length > budget) { body += clip(add, Math.max(0, budget - body.length)); break; } body += add; }
  return `<omni-run-goal>\n${goal}\n</omni-run-goal>\n<omni-run-ledger>\n${body.trim()}\n</omni-run-ledger>`;
}

/**
 * `messages` with `text` appended as a text part to the newest message, when that is a user, toolResult or
 * custom message (a background agent's report; pi's convertToLlm sends it as a user message) — pi's
 * convertToLlm drops `role: "system"` messages, so a prepended system block never reached the model. Only
 * that message and its content array are copied; the earlier messages are the same objects, so the cached
 * prompt prefix survives. Null when there is nothing to append to.
 */
export function appendToNewest(messages, text) {
  if (!Array.isArray(messages) || !messages.length || !text) return null;
  const last = messages[messages.length - 1];
  if (last?.role !== "user" && last?.role !== "toolResult" && last?.role !== "custom") return null;
  const content = typeof last.content === "string" ? [{ type: "text", text: last.content }] : [...(last.content || [])];
  content.push({ type: "text", text: `\n${text}` });
  return [...messages.slice(0, -1), { ...last, content }];
}

/** Whether a summary-model answer may replace ledger.md: not cut off (length), failed or aborted, and no
 *  tool call — the answers pi's own compaction rejects too (getSummarizationFailure). */
export const summaryUsable = (response) => !!response && !["length", "error", "aborted"].includes(response.stopReason) && !(response.content || []).some((c) => c?.type === "toolCall");

/** A fixed-budget summary: the goal, then the ledger's forward-looking sections, hard-capped.
 *  It does NOT fold in the full span verbatim, so it cannot grow pass-over-pass. */
export function renderCompactionSummary({ goal, ledgerMd = "", serializedSpan = "" }, { budget = 6000 } = {}) {
  const s = sections(ledgerMd);
  const parts = [`GOAL: ${goal}`];
  for (const name of ["Milestones", "Decisions", "Critical facts", "Next steps"]) if (s[name]) parts.push(`${name}:\n${s[name]}`);
  // A small, bounded tail of the most recent raw span for immediate continuity.
  parts.push(`RECENT:\n${clip(serializedSpan.slice(-2000), 2000)}`);
  return clip(parts.join("\n\n"), budget);
}

export const shouldOffload = (content, { maxChars = 12000 } = {}) => String(content ?? "").length > maxChars;

/** Map an image media type to a bare file extension (no dot). Unknown → "bin". */
export function extForMediaType(mediaType = "") {
  const m = String(mediaType ?? "").toLowerCase();
  if (m.includes("jpeg") || m.includes("jpg")) return "jpg";
  if (m.includes("png")) return "png";
  if (m.includes("webp")) return "webp";
  if (m.includes("gif")) return "gif";
  if (m.includes("svg")) return "svg";
  if (m.includes("bmp")) return "bmp";
  if (m.includes("avif")) return "avif";
  return "bin";
}

/** Extract the base64 payload + media type of an image content block, across the two
 *  common shapes (pi flat `{ data, mimeType }` and Anthropic nested `{ source: { data, media_type } }`).
 *  Returns null for non-image blocks or blocks without inline base64 data. */
export function imageBlockData(block) {
  if (!block || block.type !== "image") return null;
  if (typeof block.data === "string" && block.data) {
    return { data: block.data, mediaType: block.mimeType || block.mediaType || block.media_type || "" };
  }
  const src = block.source;
  if (src && typeof src.data === "string" && src.data) {
    return { data: src.data, mediaType: src.media_type || src.mediaType || src.mimeType || "" };
  }
  return null;
}

export function offloadReference({ sha, bytes, preview, path }) {
  return [
    `⟨offloaded ${bytes} bytes → ${path} (sha256 ${sha.slice(0, 16)})⟩`,
    `Preview (first 800 chars):`,
    clip(preview, 800),
    `To read a slice, use a shell/read tool on ${path} with an offset/length; do not expect the whole blob inline.`,
  ].join("\n");
}
