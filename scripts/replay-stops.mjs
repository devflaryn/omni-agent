/**
 * Replays recorded pi sessions through Omni's real control loop and reports, for every point where the original
 * run stopped, what the goal keeper does now: continue after a "my context is full" stop (and whether it compacts),
 * re-engage on the plan, retry a provider error, wait for the user, finish, or leave the chat alone.
 *
 *   node scripts/replay-stops.mjs [sessionsDir] [--hook on|off] [--labels labels.json] [--compact-at 256000]
 *
 * The session entries go through the real normalizer (server/normalize.mjs) into a real GoalKeeper (server/hook.mjs)
 * on a fake pi that only records prompts and compactions — no model, no tools, nothing executed. Output is counts
 * only (no chat text). `--labels` takes [{ session, entry, label }] (session = the file name's first 30 characters)
 * to print a label × decision table.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { Bus } from "../server/bus.mjs";
import { GoalKeeper } from "../server/hook.mjs";
import { normalizePiEntry } from "../server/normalize.mjs";

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const dir = argv[0] && !argv[0].startsWith("--") ? argv[0] : join(homedir(), ".pi", "agent", "sessions");
const hookOn = opt("--hook", "on") !== "off";
const compactAt = Number(opt("--compact-at", 256000));
const labelsFile = opt("--labels", "");
const why = opt("--why", ""); // a forensics label: print the keeper's reason for each stop with that label (no text)
const debug = opt("--debug", ""); // a session file name fragment: print the keeper's state at each of its stops (no text)
const labels = labelsFile && existsSync(labelsFile) ? JSON.parse(readFileSync(labelsFile, "utf8")) : [];
const labelOf = new Map(labels.map((l) => [`${l.session}#${l.entry}`, l.label]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const files = readdirSync(dir).flatMap((d) => { try { return readdirSync(join(dir, d)).filter((f) => f.endsWith(".jsonl")).map((f) => join(dir, d, f)); } catch { return []; } });

/** What the keeper did right after one settle, from the events it emitted and the fake pi's counters. */
function decision(evs, compacted, prompted) {
  const hook = evs.find((e) => e.kind === "hook");
  const logs = evs.filter((e) => e.kind === "log").map((e) => e.text);
  const goal = evs.find((e) => e.kind === "goal");
  if (hook && /context/i.test(hook.reason || "")) return compacted ? "continue: context stop (compacted)" : "continue: context stop";
  if (hook && /output limit/i.test(hook.reason || "")) return "continue: output limit";
  if (hook) return "re-engage (plan / unfinished)";
  if (logs.some((t) => /retrying in/i.test(t))) return "retry provider error";
  if (goal?.paused) return "pause";
  if (goal?.done) return "finish";
  if (logs.some((t) => /waiting for your answer|asked for a handoff|waiting for \d+ background/i.test(t))) return "wait for user";
  return prompted ? "re-engage (other)" : "leave alone";
}

const table = new Map(); // label -> decision -> count
const totals = new Map();
let stops = 0, sessions = 0;
for (const file of files) {
  let entries;
  try { entries = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { continue; }
  sessions++;
  const sid = "pi:replay";
  const bus = new Bus();
  const pi = { proc: {}, sid, streaming: false, state: { model: { maxTokens: 16384 } }, prompts: 0, compacts: 0, async prompt() { this.prompts++; return { success: true }; }, async compact() { this.compacts++; return { success: true }; }, seen: [], async entries() { return { data: { entries: this.seen, leafId: null } }; } };
  const keeper = new GoalKeeper({ bus, getPi: (s) => (s === sid ? pi : null), config: { enabled: hookOn, graceMs: 0, summaries: false, heartbeatMs: 0 }, contextPolicy: { compactAt, autoContinue: true, maxContextNudges: 3 }, maxTokensFor: () => 16384, setTimer: (fn, ms) => (ms > 50 ? null : setTimeout(fn, ms)), clearTimer: (t) => t && clearTimeout(t) });
  const evs = [];
  bus.on("event", (e) => evs.push(e));
  let running = false;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    pi.seen.push(e);
    const role = e.message?.role;
    // Same order as a live run: the user's message first (it sets the goal), then pi reports that it is working.
    for (const ev of normalizePiEntry(e, { sid, harness: "pi" })) bus.emit({ ...ev, live: true });
    if ((role === "user" || role === "assistant") && !running) { running = pi.streaming = true; bus.emit({ sid, harness: "pi", kind: "status", ts: Date.now(), streaming: true }); }
    if (e.type === "compaction") bus.emit({ sid, harness: "pi", kind: "compaction", ts: Date.now() });
    // A run ended here: an assistant message that is not a tool call, followed by a user message or the end of the file.
    const next = entries.slice(i + 1).find((x) => x.type === "message");
    const endsRun = role === "assistant" && e.message.stopReason !== "toolUse" && (!next || next.message?.role === "user");
    if (!endsRun) continue;
    const before = evs.length, c0 = pi.compacts, p0 = pi.prompts;
    running = pi.streaming = false;
    bus.emit({ sid, harness: "pi", kind: "status", ts: Date.now(), streaming: false });
    await sleep(15);
    const d = decision(evs.slice(before), pi.compacts > c0, pi.prompts > p0);
    if (debug && basename(file).includes(debug)) {
      const g = keeper.goal(sid);
      const k = g ? keeper.classify(sid, g) : null;
      console.log(`#${i} stop=${e.message.stopReason} decision="${d}" kind=${k?.kind} handoff=${k?.handoff} goal=${!!g} done=${g?.done} paused=${g?.paused} explicit=${g?.explicit} ctxNudges=${g?.contextNudges} ctxStops=${g?.contextStops} toolCalls=${g?.toolCalls} events=${evs.slice(before).map((x) => x.kind).join(",")}`);
    }
    stops++;
    totals.set(d, (totals.get(d) || 0) + 1);
    const label = labelOf.get(`${basename(file).slice(0, 30)}#${i}`) || "(unlabelled)";
    if (why && label === why) {
      // The keeper's own words (hook reason / log line) and the classifier's reading — never the chat's text.
      const g = keeper.goal(sid);
      const k = g ? keeper.classify(sid, g) : null;
      const said = evs.slice(before).filter((x) => x.kind === "hook" || x.kind === "log").map((x) => (x.kind === "hook" ? `hook: ${x.reason}` : `log: ${String(x.text).replace(/\(".*?"\)/g, "(…)").slice(0, 110)}`));
      console.log(`[${label}] ${basename(file).slice(0, 19)}#${i} → ${d} · classify=${k?.kind}${k?.handoff ? " (handoff)" : ""} · explicit=${!!g?.explicit} · ${said.join(" | ") || "(no keeper output)"}`);
    }
    if (!table.has(label)) table.set(label, new Map());
    table.get(label).set(d, (table.get(label).get(d) || 0) + 1);
  }
  keeper.dispose();
}

console.log(`replayed ${sessions} sessions, ${stops} run ends · goal hook ${hookOn ? "on" : "off"} · autoContinue on · compactAt ${compactAt}`);
console.log("\nwhat the keeper does now, all run ends:");
for (const [d, n] of [...totals].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${d}`);
if (labels.length) {
  console.log("\nby the forensics label of each stop:");
  for (const [label, m] of [...table].sort()) console.log(`  ${label}: ${[...m].sort((a, b) => b[1] - a[1]).map(([d, n]) => `${n}× ${d}`).join(" · ")}`);
}
