/* What the live chat decides, apart from drawing it: which blocks of a streaming message to repaint, how often, what the
   status line says, and when "jump to latest" shows. Pure, so `node --test` imports it. */
import { fmtDuration, fmtN } from "./lib.js";

/**
 * From the blocks on screen (`old`, HTML strings) to the blocks now (`next`): the leading run kept as it is, the indexes
 * replaced in place, the ones appended, and how many to take off the end. A stream grows at its end, so all but the last
 * block or two are kept: their DOM, a selection in them, and their highlighting stay.
 */
export function planBlocks(old, next) {
  let keep = 0;
  while (keep < old.length && keep < next.length && old[keep] === next[keep]) keep++;
  const replace = [], append = [];
  for (let i = keep; i < next.length; i++) (i < old.length ? replace : append).push(i);
  return { keep, replace, append, remove: Math.max(0, old.length - next.length) };
}

/** Milliseconds to wait between paints when one took `costMs`: every frame while cheap, then less often, at worst ~8 a second. */
export function paintGap(costMs) {
  if (costMs <= 8) return 0;
  return Math.min(120, Math.round(costMs * 4));
}

/**
 * The status line under a turn. `phase`: "wait" (nothing yet), "think", "write" or "tool" (what the last delta was);
 * `quiet`: nothing has arrived for a moment; `running`: a running tool's own words ("Running pytest…").
 * `waiting` is when the label shimmers: the model is busy and nothing is arriving.
 */
export function meterLabel({ done, live, phase = "wait", quiet = true, running = "", sawThinking = false, sawTool = false, ms = 0, tokens = 0, rate = 0 }) {
  const t = fmtDuration(ms);
  const tok = tokens > 0 ? `${fmtN(tokens)} tokens` : "";
  if (done) {
    const label = !live ? `Replied in ${t}` : sawTool ? `Worked for ${t}` : sawThinking ? `Thought for ${t}` : `Replied in ${t}`;
    return { label, stats: tok, waiting: false };
  }
  let label;
  if (running) label = running;
  else if (phase === "think") label = "Thinking…";
  else if (phase === "write") label = "Writing…";
  else label = "Working…";
  const flowing = !running && !quiet && (phase === "think" || phase === "write");
  const stats = [t, tok, flowing && rate ? `${rate} tok/sec` : ""].filter(Boolean).join(" · ");
  return { label, stats, waiting: !flowing };
}

/** Past this many pixels from the bottom, a "jump to latest" button shows. */
export const JUMP_GAP = 150;
export const jumpShown = (gap) => gap > JUMP_GAP;
