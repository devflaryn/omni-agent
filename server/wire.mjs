/**
 * What a page is sent of an event: a tool's output past a few hundred bytes, and an edit's long diff, stay on the
 * server until the page asks for them (`/api/sessions/:sid/tool-output`, when a tool row is opened). Server-side
 * listeners and the ring keep the whole event; only the copy written to a page is lighter, which is what a phone on
 * the relay downloads and what a long chat keeps in the page's memory.
 */
import { parseDiff } from "../ui/lib.js";

/** Outputs up to this many characters ride along (opening the row would cost a round trip for nothing). */
export const OUT_INLINE = 1024;
/** A running tool's output streams its tail only: the page shows the latest lines while it runs. */
export const UPDATE_TAIL = 4096;
/** Diffs up to this many characters ride along; a longer one sends only its +/- counts. */
export const DIFF_INLINE = 16 * 1024;

const diffStat = (diff) => {
  let added = 0, removed = 0;
  for (const r of parseDiff(diff)) { if (r.t === "add") added++; else if (r.t === "del") removed++; }
  return { added, removed };
};

/** A tool result (a `tool_result` block or a `tool` end event) as the page gets it: `clipped` is the output's full length. */
function clipResult(r) {
  const text = typeof r.text === "string" ? r.text : "";
  const longText = text.length > OUT_INLINE;
  const longDiff = typeof r.diff === "string" && r.diff.length > DIFF_INLINE;
  if (!longText && !longDiff) return r;
  const out = { ...r };
  if (longText) { out.text = ""; out.clipped = text.length; }
  if (longDiff) { delete out.diff; out.diffStat = diffStat(r.diff); out.clipped = text.length || 1; }
  return out;
}

export function wireEvent(ev) {
  if (!ev || typeof ev !== "object") return ev;
  if (ev.kind === "tool") {
    if (ev.phase === "update" && typeof ev.text === "string" && ev.text.length > UPDATE_TAIL) return { ...ev, text: ev.text.slice(-UPDATE_TAIL) };
    if (ev.phase === "end") return clipResult(ev);
    return ev;
  }
  if (ev.kind === "msg" && Array.isArray(ev.blocks) && ev.blocks.some((b) => b?.type === "tool_result")) {
    const blocks = ev.blocks.map((b) => (b?.type === "tool_result" ? clipResult(b) : b));
    return blocks.some((b, i) => b !== ev.blocks[i]) ? { ...ev, blocks } : ev;
  }
  return ev;
}

/** The full result for `toolId` in an event, or undefined. */
export function resultIn(ev, toolId) {
  if (!ev || !toolId) return undefined;
  if (ev.kind === "tool" && ev.phase === "end" && ev.toolId === toolId) return pick(ev);
  if (ev.kind === "msg" && Array.isArray(ev.blocks)) {
    const b = ev.blocks.find((x) => x?.type === "tool_result" && x.toolId === toolId);
    if (b) return pick(b);
  }
  return undefined;
}
const pick = (r) => ({ text: typeof r.text === "string" ? r.text : "", isError: !!r.isError, ...(r.diff ? { diff: r.diff } : {}) });
