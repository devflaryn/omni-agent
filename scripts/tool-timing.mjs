/**
 * Where does an agent's wall-clock time go: the model, or the tools?
 *
 *   node scripts/tool-timing.mjs [--pi 15] [--claude 15] [--days 7] [--out timing.json] [--skip <session-id>]
 *
 * Reads the most recent pi and Claude Code session files and keeps only their STRUCTURE: entry roles,
 * tool names, timestamps and token counts. No message text, tool input or tool output is ever read
 * into the result, so the output is safe to share.
 *
 * Each session is a timeline of points; the time between two points belongs to whatever ended it:
 *   - a model response (pi: an assistant message; Claude Code: an assistant entry)  → "llm"
 *   - a tool result                                                                 → that tool
 *   - a request leaving the harness (pi: an assistant's start stamp; Claude Code: an
 *     `api-request` entry), when it follows a tool result                          → "overhead"
 *   - a person's prompt                                                             → not counted
 * A span longer than --idle-min minutes is a person away (or a permission prompt left open), not work:
 * it is reported apart and kept out of the totals.
 */
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt; };
const PI_N = Number(arg("--pi", 15));
const CLAUDE_N = Number(arg("--claude", 15));
const DAYS = Number(arg("--days", 7));
const IDLE_MS = Number(arg("--idle-min", 20)) * 60_000;
const SKIP = arg("--skip", "");
const OUT = arg("--out", "");
const PI_DIR = join(homedir(), ".pi", "agent", "sessions");
const CLAUDE_DIR = join(homedir(), ".claude", "projects");

const ms = (iso) => { const t = typeof iso === "number" ? iso : Date.parse(iso); return Number.isFinite(t) ? t : null; };

/** The newest `n` .jsonl files one folder below `root`, touched within DAYS. */
async function recent(root, n) {
  const out = [];
  const since = Date.now() - DAYS * 86_400_000;
  for (const d of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!d.isDirectory()) continue;
    for (const f of await fs.readdir(join(root, d.name)).catch(() => [])) {
      if (!f.endsWith(".jsonl") || (SKIP && f.includes(SKIP))) continue;
      const p = join(root, d.name, f);
      const st = await fs.stat(p).catch(() => null);
      if (st && st.mtimeMs >= since) out.push({ path: p, project: d.name, mtime: st.mtimeMs });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, n);
}

async function entries(path) {
  const out = [];
  for (const line of (await fs.readFile(path, "utf8")).split("\n")) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* a line being written */ }
  }
  return out;
}

/** Spans of one session: [{ kind: "llm"|"tool"|"overhead", tool?, ms, out? }] plus the idle spans set aside. */
function newSession(meta) { return { ...meta, spans: [], idle: [], llmCalls: 0, outputTokens: 0, toolCalls: 0 }; }
function addSpan(s, span) {
  if (!(span.ms >= 0)) return;
  if (span.ms > IDLE_MS) s.idle.push(span); else s.spans.push(span);
}

// ------------------------------------------------------------------------------------------- pi
// assistant message: message.timestamp = request start, entry timestamp = response end.
// toolResult: entry timestamp = the tool finished (pi runs a turn's tools one after another).
function piSession(list, meta) {
  const s = newSession(meta);
  let prev = null, prevKind = null;
  for (const e of list) {
    if (e.type !== "message" || !e.message) continue;
    const m = e.message, end = ms(e.timestamp);
    if (end == null) continue;
    if (m.role === "user") { prev = end; prevKind = "user"; continue; }
    if (m.role === "assistant") {
      const start = ms(m.timestamp) ?? prev;
      if (prev != null && start != null && prevKind === "tool") addSpan(s, { kind: "overhead", ms: start - prev });
      if (start != null) addSpan(s, { kind: "llm", ms: end - start, out: m.usage?.output || 0 });
      s.llmCalls++; s.outputTokens += m.usage?.output || 0;
      prev = end; prevKind = "llm"; continue;
    }
    if (m.role === "toolResult") {
      if (prev != null) addSpan(s, { kind: "tool", tool: m.toolName || "?", ms: end - prev, err: !!m.isError });
      s.toolCalls++;
      prev = end; prevKind = "tool";
    }
  }
  return s;
}

// ---------------------------------------------------------------------------------- Claude Code
// `api-request` = a request left; `assistant` entries = blocks of its response as they completed
// (one response can span several entries); a `user` entry with tool_result blocks = tools finished;
// a `user` entry with text = a person (or a hook) spoke. Side-chain (subagent) entries are skipped:
// a subagent's whole run is the duration of the Agent/Task tool that started it.
function claudeSession(list, meta) {
  const s = newSession(meta);
  const names = new Map();
  const points = [];
  for (const e of list) {
    if (e.isSidechain) continue;
    const t = ms(e.timestamp);
    if (t == null) continue;
    if (e.type === "api-request") { points.push({ t, kind: "request" }); continue; }
    const content = e.message?.content;
    if (e.type === "assistant" && e.message) {
      for (const c of Array.isArray(content) ? content : []) if (c.type === "tool_use") names.set(c.id, c.name);
      points.push({ t, kind: "llm", id: e.message.id, out: e.message.usage?.output_tokens || 0 });
      continue;
    }
    if (e.type === "user" && e.message) {
      const results = Array.isArray(content) ? content.filter((c) => c.type === "tool_result") : [];
      if (results.length) { points.push({ t, kind: "tool", ids: results.map((r) => r.tool_use_id), err: results.some((r) => r.is_error) }); continue; }
      if (!e.isMeta) points.push({ t, kind: "user" });
    }
  }
  points.sort((a, b) => a.t - b.t);
  let prev = null, prevKind = null;
  const seenResponse = new Set();
  for (const p of points) {
    if (p.kind === "user") { prev = p.t; prevKind = "user"; continue; }
    if (prev == null) { prev = p.t; prevKind = p.kind; continue; }
    const span = p.t - prev;
    if (p.kind === "request") { if (prevKind === "tool") addSpan(s, { kind: "overhead", ms: span }); }
    else if (p.kind === "llm") {
      addSpan(s, { kind: "llm", ms: span, out: seenResponse.has(p.id) ? 0 : p.out });
      if (!seenResponse.has(p.id)) { seenResponse.add(p.id); s.llmCalls++; s.outputTokens += p.out; }
    } else if (p.kind === "tool") {
      // Several results in one entry ran side by side: the span is split evenly between them.
      const tools = p.ids.map((id) => names.get(id) || "?");
      for (const tool of tools) addSpan(s, { kind: "tool", tool, ms: span / tools.length, err: p.err });
      s.toolCalls += tools.length;
    }
    prev = p.t; prevKind = p.kind;
  }
  return s;
}

// ----------------------------------------------------------------------------------- summarise
const pct = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0);
function stats(values) {
  const v = [...values].sort((a, b) => a - b);
  return { count: v.length, totalMs: Math.round(v.reduce((a, b) => a + b, 0)), medianMs: Math.round(pct(v, 0.5)), p90Ms: Math.round(pct(v, 0.9)), maxMs: Math.round(v.at(-1) || 0) };
}

/** How the time splits by call length: a few slow calls, or many quick ones? */
const BUCKETS = [["<1 s", 1e3], ["1–5 s", 5e3], ["5–15 s", 15e3], ["15–60 s", 60e3], ["1–5 min", 300e3], [">5 min", Infinity]];
function buckets(values) {
  const out = BUCKETS.map(([label]) => ({ label, count: 0, totalMs: 0 }));
  for (const v of values) { const i = BUCKETS.findIndex(([, hi]) => v < hi); out[i].count++; out[i].totalMs += v; }
  return out.map((b) => ({ ...b, totalMs: Math.round(b.totalMs) }));
}

function summarise(harness, sessions) {
  const spans = sessions.flatMap((s) => s.spans);
  const llm = spans.filter((x) => x.kind === "llm");
  const tool = spans.filter((x) => x.kind === "tool");
  const overhead = spans.filter((x) => x.kind === "overhead");
  const byTool = new Map();
  for (const x of tool) { const a = byTool.get(x.tool) || { ms: [], errors: 0 }; a.ms.push(x.ms); if (x.err) a.errors++; byTool.set(x.tool, a); }
  const tools = [...byTool].map(([name, a]) => ({ name, errors: a.errors, ...stats(a.ms) })).sort((a, b) => b.totalMs - a.totalMs);
  const llmMs = llm.reduce((a, x) => a + x.ms, 0);
  const outTok = sessions.reduce((a, s) => a + s.outputTokens, 0);
  return {
    harness,
    sessions: sessions.map((s) => {
      const sum = (k) => Math.round(s.spans.filter((x) => x.kind === k).reduce((a, x) => a + x.ms, 0));
      return { id: s.id, project: s.project, started: s.started, llmMs: sum("llm"), toolMs: sum("tool"), overheadMs: sum("overhead"), idleMs: Math.round(s.idle.reduce((a, x) => a + x.ms, 0)), idleSpans: s.idle.length, llmCalls: s.llmCalls, toolCalls: s.toolCalls, outputTokens: s.outputTokens };
    }),
    llm: { ...stats(llm.map((x) => x.ms)), outputTokens: outTok, tokensPerSec: llmMs ? Math.round((outTok / (llmMs / 1000)) * 10) / 10 : 0, buckets: buckets(llm.map((x) => x.ms)) },
    tool: { ...stats(tool.map((x) => x.ms)), buckets: buckets(tool.map((x) => x.ms)) },
    overhead: stats(overhead.map((x) => x.ms)),
    idle: stats(sessions.flatMap((s) => s.idle.map((x) => x.ms))),
    tools,
  };
}

const piFiles = await recent(PI_DIR, PI_N);
const claudeFiles = await recent(CLAUDE_DIR, CLAUDE_N);
const piSessions = [];
for (const f of piFiles) {
  const id = basename(f.path, ".jsonl").split("_").pop();
  piSessions.push(piSession(await entries(f.path), { id: id.slice(0, 8), project: f.project.replace(/^-+|-+$/g, ""), started: basename(f.path).slice(0, 19) }));
}
const claudeSessions = [];
for (const f of claudeFiles) {
  const list = await entries(f.path);
  const first = list.find((e) => e.timestamp)?.timestamp || "";
  claudeSessions.push(claudeSession(list, { id: basename(f.path, ".jsonl").slice(0, 8), project: f.project, started: String(first).slice(0, 19) }));
}

const result = { generatedAt: new Date().toISOString(), idleMinutes: IDLE_MS / 60_000, days: DAYS, pi: summarise("pi", piSessions), claude: summarise("claude", claudeSessions) };
if (OUT) await fs.writeFile(OUT, `${JSON.stringify(result, null, 2)}\n`);

const min = (x) => `${(x / 60_000).toFixed(1)} min`;
for (const h of [result.pi, result.claude]) {
  const work = h.llm.totalMs + h.tool.totalMs + h.overhead.totalMs;
  if (!work) { console.log(`${h.harness}: no sessions`); continue; }
  const share = (x) => `${Math.round((x / work) * 100)}%`;
  console.log(`\n${h.harness}: ${h.sessions.length} sessions, ${min(work)} of agent work (idle set aside: ${min(h.idle.totalMs)} in ${h.idle.count} spans)`);
  console.log(`  model     ${min(h.llm.totalMs).padStart(10)}  ${share(h.llm.totalMs).padStart(4)}  ${h.llm.count} calls, median ${(h.llm.medianMs / 1000).toFixed(1)} s, p90 ${(h.llm.p90Ms / 1000).toFixed(1)} s, ${h.llm.tokensPerSec} output tok/s`);
  console.log(`  tools     ${min(h.tool.totalMs).padStart(10)}  ${share(h.tool.totalMs).padStart(4)}  ${h.tool.count} calls, median ${(h.tool.medianMs / 1000).toFixed(1)} s, p90 ${(h.tool.p90Ms / 1000).toFixed(1)} s`);
  console.log(`  overhead  ${min(h.overhead.totalMs).padStart(10)}  ${share(h.overhead.totalMs).padStart(4)}`);
  for (const t of h.tools.slice(0, 10)) console.log(`    ${t.name.slice(0, 34).padEnd(34)} ${String(t.count).padStart(5)}x  ${min(t.totalMs).padStart(10)}  median ${(t.medianMs / 1000).toFixed(1)} s  max ${(t.maxMs / 1000).toFixed(0)} s`);
}
