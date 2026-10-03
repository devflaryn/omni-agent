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

export function offloadReference({ sha, bytes, preview, path }) {
  return [
    `⟨offloaded ${bytes} bytes → ${path} (sha256 ${sha.slice(0, 16)})⟩`,
    `Preview (first 800 chars):`,
    clip(preview, 800),
    `To read a slice, use a shell/read tool on ${path} with an offset/length; do not expect the whole blob inline.`,
  ].join("\n");
}
