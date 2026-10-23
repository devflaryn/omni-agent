/* Pure helpers shared by the UI modules. No DOM access, so `node --test` can import it. */
export const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
export const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export const fmtN = (n) => (n == null ? "–" : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
export const ago = (ts) => { if (!ts) return ""; const d = Date.now() - ts; if (d < 60e3) return "just now"; if (d < 3600e3) return `${Math.floor(d / 60e3)} min ago`; if (d < 86400e3) return `${Math.floor(d / 3600e3)} h ago`; return `${Math.floor(d / 86400e3)} d ago`; };
export const baseName = (p) => String(p || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop();
export const fmtBytes = (n) => (n == null ? "" : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`);

// ---------------------------------------------------------- file kinds
const TEXT_EXTS = new Set(["txt", "md", "markdown", "ts", "tsx", "js", "mjs", "cjs", "jsx", "json", "jsonl", "py", "sh", "bash", "zsh", "ps1", "cmd", "bat", "html", "htm", "css", "scss", "xml", "yml", "yaml", "toml", "ini", "cfg", "conf", "log", "java", "kt", "kts", "c", "h", "cpp", "hpp", "rs", "go", "rb", "php", "sql", "smali", "gradle", "properties", "env", "gitignore", "csv", "tsv", "svelte", "vue", "lua", "swift", "m", "mm", "pro", "mk", "cmake", "txt", "lock"]);
const ARCHIVE_EXTS = /^(zip|apk|jar|aar|xapk|apks|war|ear|ipa)$/;
const IMAGE_EXTS = /^(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/;
/** Preview family for a file name: archive | image | markdown | text | binary. The server's `kind` is authoritative once read. */
export function fileKind(name) {
  const base = baseName(name);
  const m = /\.([a-z0-9]+)$/i.exec(base);
  const ext = m ? m[1].toLowerCase() : "";
  if (ARCHIVE_EXTS.test(ext)) return "archive";
  if (IMAGE_EXTS.test(ext)) return "image";
  if (ext === "md" || ext === "markdown") return "markdown";
  if (!ext || TEXT_EXTS.has(ext) || /^(makefile|dockerfile|license|readme|\.[a-z]+rc)$/i.test(base)) return "text";
  return "binary";
}

export function groupLabel(ts, now = Date.now()) {
  const d = new Date(ts || 0), n = new Date(now);
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = (day(n) - day(d)) / 86400e3;
  if (diff < 1) return "Today";
  if (diff < 2) return "Yesterday";
  if (diff < 7) return "This week";
  return d.toLocaleString(undefined, { month: "long", year: d.getFullYear() === n.getFullYear() ? undefined : "numeric" });
}

export function fmtDuration(ms) {
  const s = Math.max(0, Math.round((ms || 0) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), r = s % 60;
  if (m < 60) return `${m}m ${r}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}
export function tokRate(tokens, ms) { return !tokens || !ms || ms <= 0 ? 0 : Math.round(tokens / (ms / 1000)); }
export function estimateTokens(text) { return Math.ceil(String(text || "").length / 4); }

// -------------------------------------------------------- attachments
const MEMORY_RE = /^\s*<omni-memory>[\s\S]*?<\/omni-memory>/;
const GRAPH_RE = /^\s*<repo-graph[^>]*>[\s\S]*?<\/repo-graph>/;
export function splitAttachments(text) {
  let s = String(text ?? "");
  const attachments = [];
  let matched = true;
  while (matched) {
    matched = false;
    const m = s.match(MEMORY_RE);
    if (m) { attachments.push("memory"); s = s.slice(m[0].length); matched = true; continue; }
    const g = s.match(GRAPH_RE);
    if (g) { attachments.push("repo graph"); s = s.slice(g[0].length); matched = true; }
  }
  return attachments.length ? { text: s.trim(), attachments } : { text, attachments: [] };
}

// ------------------------------------------------------------- hooks
/** Prompts Omni sent on the user's behalf (the goal hook) are wrapped so a replayed session file shows a notice, not a user bubble. */
const HOOK_RE = /^\s*<omni-hook\b([^>]*)>([\s\S]*?)<\/omni-hook>\s*$/;
const attr = (attrs, name) => { const m = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs || ""); return m ? m[1].replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&") : ""; };
/** `{ name, note, body }` for a hook-wrapped message, else null. `note` is the one line the chat shows. */
export function hookInfo(text) {
  const m = HOOK_RE.exec(String(text ?? ""));
  if (!m) return null;
  const name = attr(m[1], "name") || "hook";
  return { name, note: attr(m[1], "note") || `A ${name} hook re-engaged the agent`, body: m[2].trim() };
}
export function hookMessage(name, note, body) {
  const q = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<omni-hook name="${q(name)}" note="${q(note)}">\n${String(body ?? "").trim()}\n</omni-hook>`;
}

// ------------------------------------------------------- token rate
/**
 * Output rate over the most recent `windowMs` of streamed samples `{ ts, chars }`, in tokens/sec
 * (chars ÷ 4). 0 when nothing arrived in the last `staleMs` (the model is waiting on a tool) or the
 * window holds too little to measure, so the meter can drop the figure instead of showing a stale one.
 */
export function rollingRate(samples, now = Date.now(), { windowMs = 5000, staleMs = 1500 } = {}) {
  if (!samples?.length) return 0;
  const last = samples[samples.length - 1];
  if (now - last.ts > staleMs) return 0;
  const from = now - windowMs;
  let chars = 0, first = 0;
  for (let i = samples.length - 1; i >= 0; i--) { const s = samples[i]; if (s.ts < from) break; chars += s.chars || 0; first = s.ts; }
  // Time the window actually covers: the whole window once it is full, else since the first sample (never under 1 s, so the first tokens do not spike).
  const span = Math.max(Math.min(windowMs, now - first), 1000);
  return Math.round(chars / 4 / (span / 1000));
}

/**
 * Fold a `status` event into a session: only the fields it carries. A compaction status (`compacting`) says nothing
 * about the run, and a run ending ends any compaction.
 */
export function applyStatus(s, ev) {
  if ("streaming" in ev) { s.streaming = !!ev.streaming; if (!ev.streaming) s.compacting = false; }
  if ("compacting" in ev) s.compacting = !!ev.compacting;
  return s;
}

/** First user text → list title, without a leading memory/graph pack. */
export function cleanTitle(text) { return splitAttachments(String(text || "")).text.replace(/\s+/g, " ").trim().slice(0, 80); }

export function relPath(path, cwd) {
  let p = String(path || "").replace(/\\/g, "/");
  if (cwd) { const c = String(cwd).replace(/\\/g, "/").replace(/\/+$/, ""); if (p.toLowerCase().startsWith(`${c.toLowerCase()}/`)) p = p.slice(c.length + 1); }
  return p;
}

// ------------------------------------------------------------ edits
const EDIT_TOOLS = /^(edit|write|multiedit|notebookedit|str_replace_editor|str_replace_based_edit_tool)$/i;
const lines = (t) => { const s = String(t ?? ""); return s ? s.split("\n").length : 0; };
export function editStats(name, args) {
  if (!EDIT_TOOLS.test(String(name || "")) || !args || typeof args !== "object") return null;
  const path = args.file_path || args.path || args.notebook_path || args.file || "";
  if (!path) return null;
  if (Array.isArray(args.edits)) {
    let added = 0, removed = 0;
    for (const e of args.edits) { added += lines(e.new_string ?? e.newText); removed += lines(e.old_string ?? e.oldText); }
    return { path, added, removed };
  }
  const oldT = args.old_string ?? args.oldText ?? args.old_str;
  const newT = args.new_string ?? args.newText ?? args.new_str ?? args.new_source;
  if (oldT != null || newT != null) return { path, added: lines(newT), removed: lines(oldT) };
  if (args.content != null || args.text != null) return { path, added: lines(args.content ?? args.text), removed: 0 };
  return { path, added: 0, removed: 0 };
}
export function editedFiles(calls) {
  const byPath = new Map();
  for (const c of calls || []) {
    const e = editStats(c?.name, c?.args);
    if (!e) continue;
    const cur = byPath.get(e.path) || { path: e.path, added: 0, removed: 0 };
    cur.added += e.added; cur.removed += e.removed;
    byPath.set(e.path, cur);
  }
  const files = [...byPath.values()];
  return { files, added: files.reduce((a, f) => a + f.added, 0), removed: files.reduce((a, f) => a + f.removed, 0) };
}

// ------------------------------------------------------- work groups
export function groupToolRuns(items, now = Date.now()) {
  const out = [];
  let work = null;
  for (const it of items || []) {
    if (it.kind !== "tool") { work = null; out.push({ kind: "text", item: it }); continue; }
    if (!work) { work = { kind: "work", items: [], startTs: it.startTs, endTs: 0 }; out.push(work); }
    work.items.push(it);
    work.startTs = Math.min(work.startTs, it.startTs);
    if (work.endTs !== null) work.endTs = it.endTs == null ? null : Math.max(work.endTs, it.endTs);
  }
  for (const w of out) if (w.kind === "work") { w.open = w.endTs === null; w.durationMs = Math.max(0, (w.endTs ?? now) - w.startTs); }
  return out;
}

// ------------------------------------------------------- archive tree
/** Flat zip entries ({ path, size, dir, ... }) → nested tree: folders first, names sorted,
 *  implicit folders created for entries whose parent folder has no entry of its own. */
export function buildTree(entries) {
  const root = { name: "", path: "", dir: true, children: new Map() };
  const folder = (parts) => {
    let cur = root;
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      let next = cur.children.get(name);
      if (!next) { next = { name, path: parts.slice(0, i + 1).join("/") + "/", dir: true, children: new Map() }; cur.children.set(name, next); }
      cur = next;
    }
    return cur;
  };
  for (const e of entries || []) {
    const clean = String(e.path || "").replace(/^\/+/, "");
    if (!clean) continue;
    const parts = clean.replace(/\/+$/, "").split("/");
    if (e.dir || clean.endsWith("/")) { folder(parts); continue; }
    const parent = folder(parts.slice(0, -1));
    parent.children.set(parts[parts.length - 1], { name: parts[parts.length - 1], path: clean, dir: false, size: e.size, compressed: e.compressed, entry: e });
  }
  const finish = (n) => {
    if (!n.dir) return n;
    const kids = [...n.children.values()].map(finish).sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    return { name: n.name, path: n.path, dir: true, children: kids, count: kids.reduce((t, k) => t + (k.dir ? k.count : 1), 0) };
  };
  return finish(root).children;
}

// ----------------------------------------------------------- markdown
export function md(src) {
  const blocks = String(src || "").replace(/\r\n?/g, "\n").split(/(```[\s\S]*?```)/g);
  return blocks.map((b) => {
    const m = b.match(/^```(\w*)\n?([\s\S]*?)```$/);
    if (m) return `<pre><code>${esc(m[2].replace(/\n$/, ""))}</code></pre>`;
    let h = esc(b);
    h = h.replace(/`([^`\n]+)`/g, (_, c) => `<code>${c}</code>`);
    h = h.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>").replace(/(^|[^*\w])\*([^*\n]+)\*/g, "$1<i>$2</i>");
    h = h.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    h = h.replace(/^(#{1,4})\s+(.*)$/gm, (_, x, t) => `<h${x.length}>${t}</h${x.length}>`);
    h = h.replace(/(?:^|\n)((?:[ \t]*(?:[-*]|\d+\.)[ \t]+.*(?:\n|$))+)/g, (_, blk) => {
      const ordered = /^\s*\d+\./.test(blk);
      const items = blk.trim().split(/\n/).map((l) => l.replace(/^\s*(?:[-*]|\d+\.)\s+/, "")).map((t) => `<li>${t}</li>`).join("");
      return `\n<${ordered ? "ol" : "ul"}>${items}</${ordered ? "ol" : "ul"}>`;
    });
    h = h.replace(/(?:^|\n)(\|.+\|\n\|[-:| ]+\|\n(?:\|.*\|\n?)*)/g, (_, tbl) => {
      const rows = tbl.trim().split("\n").filter((r) => !/^\|(?:\s*:?-+:?\s*\|)+$/.test(r));
      return `\n<table>${rows.map((r, i) => `<tr>${r.split("|").slice(1, -1).map((c) => `<${i ? "td" : "th"}>${c.trim()}</${i ? "td" : "th"}>`).join("")}</tr>`).join("")}</table>`;
    });
    h = h.replace(/\n{2,}/g, "</p><p>").replace(/(?<!>)\n(?!<)/g, "<br>");
    return `<p>${h}</p>`;
  }).join("");
}

// ------------------------------------------------------- tool labels
const one = (s, n = 120) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
/** The omni-agents extension's tools: background agents (agent_*) and long shell jobs (job_*). */
const AGENT_TOOLS = /^(agent_(start|wait|status|message|cancel)|job_(start|wait|output|kill))$/i;
function agentToolLabel(name, a) {
  const id = one(a.id || (Array.isArray(a.ids) ? a.ids.join(", ") : ""), 60);
  const sp = id ? ` ${id}` : "";
  const what = (s) => (s ? `: ${one(s, 90)}` : "");
  switch (String(name).toLowerCase()) {
    case "agent_start": return `Started ${a.kind === "claude" ? "a Claude agent" : "an agent"}${what(a.title || a.task)}`;
    case "agent_wait": return `Waited for ${id ? `agent${sp}` : "agents"}`;
    case "agent_status": return id ? `Checked agent${sp}` : "Checked agents";
    case "agent_message": return `Messaged agent${sp}`;
    case "agent_cancel": return `Stopped agent${sp}`;
    case "job_start": return `Started a job${what(a.title || a.command)}`;
    case "job_wait": return `Waited for job${sp}${a.until ? ` until /${one(a.until, 40)}/` : ""}`;
    case "job_output": return `Read the output of job${sp}`;
    default: return `Stopped job${sp}`;
  }
}
export function toolKind(name) {
  const n = String(name || "");
  if (/^mcp__claude-in-chrome__/i.test(n)) return "browser";
  if (/^plan$/i.test(n)) return "plan";
  if (AGENT_TOOLS.test(n)) return /^job_/i.test(n) ? "shell" : "agent";
  if (/^(bash|powershell|shell|sh|cmd|exec)$/i.test(n)) return "shell";
  if (EDIT_TOOLS.test(n)) return "edit";
  if (/^(read|cat|view)$/i.test(n)) return "read";
  if (/^(grep|glob|find|ls|search|rg)$/i.test(n)) return "search";
  if (/^(agent|task|claude_task|subagent)$/i.test(n)) return "agent";
  if (/^(webfetch|websearch|fetch)$/i.test(n)) return "web";
  if (/^mcp__/i.test(n)) return "mcp";
  return "other";
}
export function toolLabel(name, args, cwd) {
  const kind = toolKind(name), a = args && typeof args === "object" ? args : {};
  if (AGENT_TOOLS.test(String(name || ""))) return { kind, text: agentToolLabel(name, a) };
  const file = a.file_path || a.path || a.notebook_path || a.file;
  switch (kind) {
    case "shell": { const c = one(a.command || a.cmd); return { kind, text: c ? `Ran ${c}` : "Ran a command" }; }
    case "edit": { const st = editStats(name, a); const verb = /^write$/i.test(name) ? "Wrote" : "Edited"; return { kind, text: `${verb} ${baseName(file) || "a file"}`, added: st?.added || 0, removed: st?.removed || 0 }; }
    case "read": return { kind, text: file ? `Read ${relPath(file, cwd)}` : "Read a file" };
    case "search": { const q = one(a.pattern || a.query || a.glob || a.path || a.command, 80); return { kind, text: q ? `Searched ${q}` : "Searched files" }; }
    case "agent": return { kind, text: one(a.description || a.task || a.prompt, 100) || "Ran a subagent" };
    case "browser": return { kind, text: "Used the browser" };
    case "plan": {
      const step = one(a.step, 20);
      const t = { brainstorm: `Brainstormed${a.chosen ? `: ${one(a.chosen, 80)}` : ""}`, create: `Planned ${Array.isArray(a.milestones) ? `${a.milestones.length} milestone${a.milestones.length === 1 ? "" : "s"}` : "the work"}`, start: `Started step ${step}`, done: `Finished step ${step || "(current)"}`, skip: `Skipped step ${step}`, revise: `Revised the plan${a.reason ? `: ${one(a.reason, 80)}` : ""}`, ask_user: `Asked: ${one(a.question, 80)}` }[a.action];
      return { kind, text: t || "Checked the plan" };
    }
    case "web": { const q = one(a.url || a.query, 100); return { kind, text: q ? (a.url ? `Fetched ${q}` : `Searched the web for ${q}`) : "Fetched the web" }; }
    default: { const b = one(a.command || a.file_path || a.path || a.pattern || a.query || a.skill || a.task || a.description, 80); return { kind, text: b ? `${name} ${b}` : String(name || "tool") }; }
  }
}
const VERBS = { plan: ["updated the plan", "Planning"], browser: ["used the browser", "Using the browser"], edit: ["edited files", "Editing a file"], shell: ["ran commands", "Running a command"], read: ["read files", "Reading a file"], search: ["searched files", "Searching files"], agent: ["ran subagents", "Running a subagent"], web: ["fetched the web", "Fetching the web"], mcp: ["used tools", "Using a tool"], other: ["used tools", "Using a tool"] };
export function workSummary(kinds, live = false) {
  const ks = (kinds || []).map((k) => (VERBS[k] ? k : "other"));
  if (live) return `${(VERBS[ks[ks.length - 1]] || VERBS.other)[1]}…`;
  const seen = [...new Set(ks.map((k) => VERBS[k][0]))];
  if (!seen.length) return "Worked";
  const s = seen.join(", ");
  return s[0].toUpperCase() + s.slice(1);
}

/**
 * True when an incoming user message is the same prompt as the previously rendered one and arrives
 * within `windowMs` — i.e. the optimistic echo (`u-<ts>` id) and pi's session-file entry (its own
 * uuid) for the SAME send, which otherwise render as two bubbles. Distinct prompts, even with
 * identical text sent far enough apart, are not collapsed. Pure, so it is unit-tested.
 */
export function isDuplicateUserMessage(prev, text, ts, windowMs = 15000) {
  if (!prev || prev.text !== text) return false;
  return Math.abs((ts || 0) - (prev.ts || 0)) <= windowMs;
}

// ---------------------------------------------------- background agents
/** Agent statuses that still hold (or wait for) a slot: the strip pulses and offers Stop. */
export const AGENT_ACTIVE = new Set(["queued", "starting", "running"]);
/** Dot tone for an agent status: run (active) | ok (done) | err (failed) | off (cancelled) | "" (unknown). */
export function agentTone(status) {
  if (AGENT_ACTIVE.has(status)) return "run";
  if (status === "done") return "ok";
  if (status === "cancelled") return "off";
  return /^(error|timeout|stalled|interrupted)$/.test(status || "") ? "err" : "";
}
export const agentKindLabel = (kind) => ({ pi: "pi agent", claude: "Claude agent", shell: "shell job" })[kind] || "agent";
export const agentTitle = (a) => one(a?.title || a?.task || a?.command || a?.id || "agent", 90);
/** One chat's agents, newest first (a queued one has no start time yet and counts as newest). */
export function agentsFor(agents, parentSid) {
  const key = (a) => a.startedAt || (AGENT_ACTIVE.has(a.status) ? Number.MAX_SAFE_INTEGER : 0);
  return [...(agents || [])].filter((a) => a && parentSid && a.parentSid === parentSid).sort((a, b) => key(b) - key(a) || String(b.id).localeCompare(String(a.id)));
}
/** "3 agents · 2 running · 1 done": the strip's one-line summary when it is folded. */
export function agentSummary(list) {
  const n = list?.length || 0;
  const c = { running: 0, queued: 0, failed: 0, done: 0, stopped: 0 };
  for (const a of list || []) {
    const t = agentTone(a.status);
    if (a.status === "queued") c.queued++;
    else if (t === "run") c.running++;
    else if (t === "err") c.failed++;
    else if (t === "ok") c.done++;
    else if (t === "off") c.stopped++;
  }
  return [`${n} agent${n === 1 ? "" : "s"}`, ...Object.entries(c).filter(([, v]) => v).map(([k, v]) => `${v} ${k}`)].join(" · ");
}
/** The strip row's second line: what a running agent is doing now, else its status (with the error once it failed). */
export function agentSubline(a) {
  const last = Array.isArray(a?.activity) && a.activity.length ? String(a.activity[a.activity.length - 1]) : "";
  if (AGENT_ACTIVE.has(a?.status)) return a.status === "running" && last ? last : a.status;
  return a?.error ? `${a.status}: ${a.error}` : a?.status || "";
}
/** Run time so far (or in total once finished); "" before it started. */
export function agentElapsed(a, now = Date.now()) { return a?.startedAt ? fmtDuration((a.endedAt || now) - a.startedAt) : ""; }
/** The history drawer's tag for a background agent's chat ("agent" / "Claude agent"), null for an ordinary chat. */
export function agentTag(s, rec) {
  if (!s || !(s.parentSid || s.agentId || rec)) return null;
  return (s.agentKind || rec?.kind) === "claude" || s.harness === "claude" ? "Claude agent" : "agent";
}
/**
 * History rows in display order, `[{ s, depth }]`: a chat whose parent (`parentOf(s)`, the agent's
 * parentSid) is in the list sits right under it, one level deeper, whatever its own date; a chat
 * whose parent is not listed stays at the top level. Roots and siblings keep the input order.
 */
export function nestSessions(list, parentOf = (s) => s?.parentSid) {
  const items = [...(list || [])];
  const bySid = new Map(items.map((s) => [s.sid, s]));
  const kids = new Map(), roots = [];
  for (const s of items) {
    const p = parentOf(s);
    if (p && p !== s.sid && bySid.has(p)) { if (!kids.has(p)) kids.set(p, []); kids.get(p).push(s); } else roots.push(s);
  }
  const out = [], seen = new Set();
  const walk = (s, depth) => { if (seen.has(s.sid)) return; seen.add(s.sid); out.push({ s, depth }); for (const k of kids.get(s.sid) || []) walk(k, depth + 1); };
  for (const s of roots) walk(s, 0);
  // Parents that point at each other leave rows no root reaches: show them rather than lose them.
  for (const s of items) walk(s, 0);
  return out;
}

const AGENT_RESULT_RE = /^\s*\[omni-agent-result\]\s*/;
const AGENT_KEYS = /^(id|agent|kind|title|status|elapsed|duration|time)\s*:\s*(.+)$/i;
const STATUS_WORDS = /\b(done|completed|finished|succeeded|error|errored|failed|cancell?ed|canceled|stopped|timeout|timed out|interrupted|stalled)\b/i;
const STATUS_NORM = { completed: "done", finished: "done", succeeded: "done", errored: "error", failed: "error", canceled: "cancelled", stopped: "cancelled", "timed out": "timeout" };
const DURATION_RE = /\b\d+h\s?\d{1,2}m\b|\b\d+m\s?\d{1,2}s\b|\b\d+(?:\.\d+)?\s?(?:s|secs?|seconds?|min|mins|minutes?|h|hours?)\b/i;
// The header omni-agents-lib.mjs `agentReport` writes, one line:
//   Background <pi agent|Claude agent|job> <id> "<title>" finished: <status>[ (exit N)][ after <1m00s|1h05m|5s>].
// The title is free text (quotes included), so it is matched greedily up to the LAST `" finished:`.
const REPORT_HEAD = /^Background (pi agent|Claude agent|job) (\S+) "(.*)" finished: ([a-z]+)(?: \(exit -?\d+\))?(?: after (\S+?))?\.$/i;
const QUOTED = /[“"][^”"]*[”"]/g;
/** "1m00s" / "1h05m" (the agents lib's format) or "4m 12s" → the strip's own format ("1m 0s", "1h 05m"); other text as written. */
function normDuration(s) {
  const t = String(s || "").trim();
  const m = /^(?:(\d+)h\s?)?(?:(\d+)m\s?)?(?:(\d+)s)?$/.exec(t);
  if (!m || !(m[1] || m[2] || m[3])) return t;
  return fmtDuration(((Number(m[1]) || 0) * 3600 + (Number(m[2]) || 0) * 60 + (Number(m[3]) || 0)) * 1000);
}
/**
 * A report the omni-agents extension delivered into the parent chat (pi custom message
 * `omni-agent-result`, shown as `[omni-agent-result] …`) → `{ id, kind, title, status, elapsed, body }`,
 * else null. The agents lib's own header line (REPORT_HEAD) is read exactly; anything else leniently:
 * one summary line and/or `key: value` lines (title, status, kind, id, elapsed), then the report itself.
 * The lenient path never reads a status or kind out of the quoted title.
 */
export function agentResultInfo(text) {
  const raw = String(text ?? "");
  const m = AGENT_RESULT_RE.exec(raw);
  if (!m) return null;
  const rest = raw.slice(m[0].length).replace(/\r\n?/g, "\n").trim();
  const lines = rest.split("\n");
  const kv = {};
  let head = "", i = 0;
  for (; i < lines.length && i < 12; i++) {
    const l = lines[i].trim();
    const k = AGENT_KEYS.exec(l);
    if (k) { kv[k[1].toLowerCase()] = k[2].trim(); continue; }
    if (i === 0 && l) { head = l; continue; }
    break;
  }
  const body = lines.slice(i).join("\n").trim() || rest;
  const idOf = (s) => /\ba-[0-9a-f]{8}\b/.exec(s || "")?.[0];
  const kindOf = (s) => (/\bclaude\b/i.test(s) ? "claude" : /\b(shell|job)\b/i.test(s) ? "shell" : /\bpi\b/i.test(s) ? "pi" : "");
  const exact = REPORT_HEAD.exec(head);
  // Lenient: the head without its quoted title; after `finished:` comes the status itself.
  const bare = head.replace(QUOTED, " ");
  const st = (kv.status ? STATUS_WORDS.exec(kv.status)?.[1] || kv.status : exact ? exact[4]
    : /\bfinished:\s*(timed out|[a-z]+)/i.exec(bare)?.[1] || STATUS_WORDS.exec(bare)?.[1] || "").toLowerCase();
  return {
    id: idOf(kv.id) || idOf(kv.agent) || idOf(exact?.[2]) || idOf(bare) || idOf(rest.slice(0, 600)) || "",
    kind: kindOf(kv.kind || (exact ? exact[1] : head.split(/[“"]/)[0])),
    title: one(kv.title || exact?.[3] || /[“"]([^”"]{1,200})[”"]/.exec(head)?.[1] || head || "Background agent", 140),
    status: STATUS_NORM[st] || st,
    elapsed: normDuration(kv.elapsed || kv.duration || kv.time || (exact ? exact[5] : DURATION_RE.exec(bare)?.[0]) || ""),
    body,
  };
}
/** An agent report `msg` event's text (what tells a live copy and the history's copy apart), else "". */
export function agentReportKey(ev) {
  if (ev?.kind !== "msg" || ev.role !== "system") return "";
  const text = (ev.blocks || []).map((b) => b.text || "").join("\n");
  return AGENT_RESULT_RE.test(text) ? text.trim() : "";
}
/**
 * A reopened chat's history plus the agent reports only a buffered live event has, each placed by
 * its time. A report reaches the parent chat as a live event, and the history may not carry it (it
 * is a pi custom message); being older than the history fetch, it would otherwise be taken to be in
 * the file and dropped. A report the history does carry is never doubled.
 */
export function withLiveReports(events, buffer) {
  const have = new Set((events || []).map(agentReportKey).filter(Boolean));
  const late = [];
  for (const ev of buffer || []) { const k = agentReportKey(ev); if (k && !have.has(k)) { have.add(k); late.push(ev); } }
  if (!late.length) return events || [];
  late.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  const out = [];
  for (const ev of events || []) { while (late.length && (late[0].ts || 0) <= (ev.ts || 0)) out.push(late.shift()); out.push(ev); }
  return out.concat(late);
}
/**
 * The agent records after a `/api/state` snapshot: the snapshot's, except where a live `agent` event
 * arrived since the request went out (`liveSince`: id → the `rev` it was put at, `rev`: the counter
 * when the request was sent) — that one is at least as new as the snapshot, which an event emitted
 * while the snapshot was in flight would otherwise overwrite for good (a finished agent left
 * "running"). Agents the snapshot lacks are dropped unless they too are that recent.
 */
export function mergeAgentSnapshot(current, snapshot, liveSince, rev) {
  const out = new Map();
  const fresh = (id) => (liveSince?.get(id) ?? -1) > rev && current.has(id);
  for (const a of Array.isArray(snapshot) ? snapshot : Object.values(snapshot || {})) if (a?.id) out.set(a.id, fresh(a.id) ? current.get(a.id) : a);
  for (const [id, a] of current) if (!out.has(id) && fresh(id)) out.set(id, a);
  return out;
}

// ------------------------------------------------------------ long runs
/** Settings → Long runs: thousands of tokens as typed → `{ compactAt }` in tokens (0 = off), or `{ error }`. */
export function parseCompactAt(k) {
  const s = String(k ?? "").trim();
  const n = Number(s);
  if (!s || !Number.isFinite(n) || n < 0) return { error: "Type how many thousand tokens a chat may grow to before OpenCode compacts it (0 = off)" };
  // After a compaction OpenCode still holds the system prompt and tools (~25k), the recent turns it keeps (32k) and the summary.
  if (n > 0 && n < 100) return { error: "Too small: below 100k tokens OpenCode would compact almost every turn (a compacted chat still holds ~60k). Use 0 to turn the cap off." };
  if (n > 10000) return { error: "Too large: use at most 10000k tokens, or 0 to turn the cap off." };
  return { compactAt: Math.round(n * 1000) };
}
/** compactAt in tokens → the k figure the field shows. */
export const compactAtK = (tokens) => (Number(tokens) > 0 ? Math.round(Number(tokens) / 100) / 10 : 0);
/**
 * The Long runs field on Save → `{ compactAt }` / `{ error }`. While the field still shows the saved
 * value, that exact token count goes back: 262144 shows as 262.1, and re-reading 262.1 would save
 * 262100, a cap change (and a pi restart) nobody asked for.
 */
export function compactAtFromField(k, saved) {
  const n = Number(saved);
  return Number.isFinite(n) && n >= 0 && String(k ?? "").trim() === String(compactAtK(n)) ? { compactAt: n } : parseCompactAt(k);
}
