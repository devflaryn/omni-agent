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
export function toolKind(name) {
  const n = String(name || "");
  if (/^mcp__claude-in-chrome__/i.test(n)) return "browser";
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
  const file = a.file_path || a.path || a.notebook_path || a.file;
  switch (kind) {
    case "shell": { const c = one(a.command || a.cmd); return { kind, text: c ? `Ran ${c}` : "Ran a command" }; }
    case "edit": { const st = editStats(name, a); const verb = /^write$/i.test(name) ? "Wrote" : "Edited"; return { kind, text: `${verb} ${baseName(file) || "a file"}`, added: st?.added || 0, removed: st?.removed || 0 }; }
    case "read": return { kind, text: file ? `Read ${relPath(file, cwd)}` : "Read a file" };
    case "search": { const q = one(a.pattern || a.query || a.glob || a.path || a.command, 80); return { kind, text: q ? `Searched ${q}` : "Searched files" }; }
    case "agent": return { kind, text: one(a.description || a.task || a.prompt, 100) || "Ran a subagent" };
    case "browser": return { kind, text: "Used the browser" };
    case "web": { const q = one(a.url || a.query, 100); return { kind, text: q ? (a.url ? `Fetched ${q}` : `Searched the web for ${q}`) : "Fetched the web" }; }
    default: { const b = one(a.command || a.file_path || a.path || a.pattern || a.query || a.skill || a.task || a.description, 80); return { kind, text: b ? `${name} ${b}` : String(name || "tool") }; }
  }
}
const VERBS = { browser: ["used the browser", "Using the browser"], edit: ["edited files", "Editing a file"], shell: ["ran commands", "Running a command"], read: ["read files", "Reading a file"], search: ["searched files", "Searching files"], agent: ["ran subagents", "Running a subagent"], web: ["fetched the web", "Fetching the web"], mcp: ["used tools", "Using a tool"], other: ["used tools", "Using a tool"] };
export function workSummary(kinds, live = false) {
  const ks = (kinds || []).map((k) => (VERBS[k] ? k : "other"));
  if (live) return `${(VERBS[ks[ks.length - 1]] || VERBS.other)[1]}…`;
  const seen = [...new Set(ks.map((k) => VERBS[k][0]))];
  if (!seen.length) return "Worked";
  const s = seen.join(", ");
  return s[0].toUpperCase() + s.slice(1);
}
