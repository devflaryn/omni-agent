/* Omni Agent front-end: Home + Chat + Memory + Graph + Tokens + Files views. No build step. */
"use strict";
const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const fmtN = (n) => (n == null ? "–" : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
const ago = (ts) => { if (!ts) return ""; const d = Date.now() - ts; if (d < 60e3) return "just now"; if (d < 3600e3) return `${Math.floor(d / 60e3)} min ago`; if (d < 86400e3) return `${Math.floor(d / 3600e3)} h ago`; return `${Math.floor(d / 86400e3)} d ago`; };
const baseName = (p) => String(p || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop();

// ------------------------------------------------------------ markdown
function md(src) {
  const blocks = String(src || "").split(/(```[\s\S]*?```)/g);
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
      const rows = tbl.trim().split("\n").filter((r) => !/^\|[-:| ]+\|$/.test(r));
      return `\n<table>${rows.map((r, i) => `<tr>${r.split("|").slice(1, -1).map((c) => `<${i ? "td" : "th"}>${c.trim()}</${i ? "td" : "th"}>`).join("")}</tr>`).join("")}</table>`;
    });
    h = h.replace(/\n{2,}/g, "</p><p>").replace(/(?<!>)\n(?!<)/g, "<br>");
    return `<p>${h}</p>`;
  }).join("");
}

// -------------------------------------------------------------- state
const S = { sessions: new Map(), selected: null, pi: { running: false }, runs: [], seq: 0, buffers: new Map(), view: null, page: "home", config: null, memCount: 0, graphs: [] };

async function api(path, body, method) {
  const r = await fetch(path, body ? { method: method || "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : { method: method || "GET" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error || `${r.status}`);
  return j;
}
function toast(text, err) { const t = el("div", `toast${err ? " err" : ""}`, text); $("#toasts").appendChild(t); setTimeout(() => t.remove(), err ? 7000 : 3500); }

// --------------------------------------------------------------- views
const VIEW_TITLES = { home: "Home", chat: "Chat", memory: "Memory", graph: "Graph", tokens: "Tokens", files: "Files" };
function showView(name) {
  S.page = name;
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${name}`));
  document.querySelectorAll(".nav-item[data-view]").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  $("#topTitle").textContent = name === "chat" ? (S.sessions.get(S.selected)?.title || "Chat") : VIEW_TITLES[name];
  document.body.classList.remove("show-side");
  if (name === "home") renderHome();
  if (name === "memory") loadMemory($("#memSearch").value.trim());
  if (name === "graph") loadGraph();
  if (name === "tokens") renderStats();
  if (name === "files") loadFiles();
  if (name === "chat") { updateHeader(); updateComposer(); }
}

// --------------------------------------------------------- history rail
function sessionIsLive(s) { return s.streaming || (Date.now() - (s.lastActivity || 0) < 20000); }
function groupLabel(ts) {
  const d = new Date(ts || 0), now = new Date();
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = (day(now) - day(d)) / 86400e3;
  if (diff < 1) return "Today";
  if (diff < 2) return "Yesterday";
  if (diff < 7) return "This week";
  return d.toLocaleString(undefined, { month: "long", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" });
}
function renderHistory() {
  const filter = $("#sessionFilter").value.trim().toLowerCase();
  const list = [...S.sessions.values()]
    .filter((s) => s.title && (!filter || `${s.title} ${s.cwd || ""} ${s.model || ""} ${s.harness}`.toLowerCase().includes(filter)))
    .sort((a, b) => (b.lastActivity || b.mtime || 0) - (a.lastActivity || a.mtime || 0))
    .slice(0, 120);
  const wrap = $("#history");
  wrap.innerHTML = "";
  let last = null;
  for (const s of list) {
    const g = groupLabel(s.lastActivity || s.mtime);
    if (g !== last) { wrap.appendChild(el("div", "hist-group", g)); last = g; }
    const b = el("button", `hist${s.sid === S.selected ? " active" : ""}${sessionIsLive(s) ? " live" : ""}`);
    b.dataset.h = s.harness;
    b.title = `${s.harness} · ${s.cwd || ""}`;
    b.textContent = s.title;
    if (s.owned) b.appendChild(el("span", "own", "live"));
    b.onclick = () => { selectSession(s.sid); showView("chat"); };
    wrap.appendChild(b);
  }
  if (!list.length) wrap.appendChild(el("div", "hist-group", filter ? "No matches." : "No conversations yet."));
}

// ---------------------------------------------------------------- home
function recentDirs() {
  const seen = new Map();
  for (const s of [...S.sessions.values()].sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0))) {
    if (s.cwd && !seen.has(s.cwd)) seen.set(s.cwd, s);
    if (seen.size >= 6) break;
  }
  return [...seen.keys()];
}
function renderHome() {
  const cwdInput = $("#homeCwd");
  if (!cwdInput.value) cwdInput.value = S.pi.cwd || S.config?.cwd || "";
  const chips = $("#dirChips"); chips.innerHTML = "";
  for (const d of recentDirs()) {
    const c = el("button", `chip${d === cwdInput.value ? " active" : ""}`, baseName(d) || d);
    c.title = d;
    c.onclick = () => { cwdInput.value = d; renderHome(); };
    chips.appendChild(c);
  }
  const live = [...S.sessions.values()].filter((s) => s.streaming);
  const today = new Date().setHours(0, 0, 0, 0);
  let tok = 0, cost = 0, n = 0;
  for (const s of S.sessions.values()) { if (!s.tally || (s.lastActivity || s.mtime || 0) < today) continue; tok += s.tally.total; cost += s.tally.cost; n++; }
  const recent = [...S.sessions.values()].filter((s) => s.title).sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0))[0];
  const cards = $("#homeCards"); cards.innerHTML = "";
  const card = (title, big, sub, view, cls) => { const c = el("div", `card${cls ? ` ${cls}` : ""}`); c.append(el("div", "c-title", title), el("div", "c-big", big), el("div", "c-sub", sub)); c.onclick = () => showView(view); cards.appendChild(c); };
  card("Working now", String(live.length), live.length ? live.map((s) => `${s.harness}: ${s.title || "…"}`).join(" · ") : recent ? `Last: ${recent.title}` : "Nothing running", "chat", live.length ? "live" : "");
  card("Tokens today", fmtN(tok), `${n} session${n === 1 ? "" : "s"} · $${cost.toFixed(2)}`, "tokens");
  card("Memory", String(S.memCount), S.config ? `vault: ${baseName(S.config.vault)}` : "", "memory");
  card("Repo graphs", String(S.graphs.length), S.graphs[0] ? `${S.graphs[0].name}: ${S.graphs[0].nodes} nodes` : "Build one from a session's folder", "graph");
  $("#topModel").textContent = S.pi.state?.model?.id || "";
}
async function homeSend() {
  const text = $("#homeInput").value.trim();
  if (!text) return;
  const target = $("#homeTarget .seg-btn.active").dataset.target;
  const cwd = $("#homeCwd").value.trim() || S.config?.cwd;
  const memory = $("#homeMemory").checked, graph = $("#homeGraph").checked;
  $("#homeSend").disabled = true;
  try {
    if (target === "pi") {
      if (!S.pi.running || (S.pi.cwd || "").toLowerCase() !== cwd.toLowerCase()) await api("/api/pi/start", { cwd });
      else await api("/api/pi/new", {});
      const st = await api("/api/state");
      S.pi = st.pi;
      if (!st.pi.sid) throw new Error("pi did not report a session");
      S.sessions.set(st.pi.sid, { ...(S.sessions.get(st.pi.sid) || {}), sid: st.pi.sid, harness: "pi", owned: true, cwd, model: st.pi.state?.model?.id, title: text.replace(/\s+/g, " ").slice(0, 80), lastActivity: Date.now(), streaming: true });
      $("#homeInput").value = "";
      selectSession(st.pi.sid); showView("chat");
      await api("/api/pi/prompt", { message: text, memory, graph });
    } else {
      const r = await api("/api/claude/run", { prompt: text, cwd, model: $("#homeModel").value, memory, graph, autonomous: true });
      S.sessions.set(r.sid, { sid: r.sid, harness: "claude", owned: true, cwd, title: text.replace(/\s+/g, " ").slice(0, 80), lastActivity: Date.now(), streaming: true });
      $("#homeInput").value = "";
      selectSession(r.sid); showView("chat");
    }
  } catch (e) { toast(e.message, true); }
  finally { $("#homeSend").disabled = false; }
}

// ------------------------------------------------------ transcript view
function newView(sid) { const root = $("#transcript"); root.innerHTML = ""; return { sid, root, groups: new Map(), tools: new Map(), stream: null, lastTs: 0, empty: null }; }
function scrollBottom() { const w = $("#transcriptWrap"); if (w.scrollHeight - w.scrollTop - w.clientHeight < 200) w.scrollTop = w.scrollHeight; }
function harnessOf(sid) { return sid.split(":")[0]; }
function newBubble(view, role, ts, animate, label) {
  const m = el("div", `msg ${role}${animate ? " appear" : ""}`);
  m.dataset.h = harnessOf(view.sid);
  const who = el("div", "who");
  who.append(el("span", null, label || (role === "user" ? "you" : role === "assistant" ? (harnessOf(view.sid) === "pi" ? "pi" : "claude") : role)), el("span", "t", ts ? new Date(ts).toLocaleTimeString() : ""));
  m.appendChild(who);
  const body = el("div", "body");
  m.appendChild(body);
  view.root.appendChild(m);
  return { el: m, body };
}
function toolCard(view, { toolId, name, args }, into) {
  let c = toolId ? view.tools.get(toolId) : null;
  if (c) return c;
  const d = el("details", "tool running");
  d.innerHTML = `<summary><span class="name">${esc(name || "tool")}</span><span class="brief"></span><span class="st">running</span></summary><div class="io"><pre class="args"></pre><pre class="out" hidden></pre></div>`;
  c = { el: d, args: d.querySelector(".args"), out: d.querySelector(".out"), st: d.querySelector(".st"), brief: d.querySelector(".brief"), argText: "" };
  if (args !== undefined) setToolArgs(c, args);
  (into || view.root).appendChild(d);
  if (toolId) view.tools.set(toolId, c);
  return c;
}
function setToolArgs(c, args) {
  const text = typeof args === "string" ? args : JSON.stringify(args, null, 2);
  if (typeof args === "object" && args) c.brief.textContent = String(args.command || args.path || args.file_path || args.pattern || args.query || args.task || args.description || "").replace(/\s+/g, " ").slice(0, 120);
  c.args.textContent = text || "";
}
function setToolResult(c, text, isError) { c.out.hidden = false; c.out.textContent = (text || "").slice(0, 30000); c.el.classList.remove("running"); c.el.classList.add(isError ? "err" : "ok"); c.st.textContent = isError ? "error" : "done"; }
function renderBlocks(view, bubble, blocks) {
  for (const b of blocks) {
    if (b.type === "text") { const d = el("div", "text"); d.innerHTML = md(b.text); bubble.body.appendChild(d); }
    else if (b.type === "thinking") { const d = el("details", "think"); d.innerHTML = `<summary></summary><div class="stream"></div>`; d.querySelector(".stream").textContent = b.text; bubble.body.appendChild(d); }
    else if (b.type === "tool_call") { const c = toolCard(view, b, bubble.body); if (b.args !== undefined) setToolArgs(c, b.args); }
    else if (b.type === "tool_result") { const c = view.tools.get(b.toolId); if (c) setToolResult(c, b.text, b.isError); else setToolResult(toolCard(view, { toolId: b.toolId, name: b.name || "result" }, bubble.body), b.text, b.isError); }
    else if (b.type === "image") { const i = el("img"); i.src = `data:${b.mimeType};base64,${b.data}`; i.style.maxWidth = "100%"; bubble.body.appendChild(i); }
  }
}
function openStream(view, ts) { view.stream = newBubble(view, "assistant", ts || Date.now(), false); view.stream.parts = new Map(); return view.stream; }
function streamPart(view, index, part, meta = {}) {
  if (!view.stream) openStream(view);
  let p = view.stream.parts.get(index);
  if (p) return p;
  if (part === "tool_call" || part === "tool_args") p = { part: "tool_call", card: toolCard(view, { toolId: meta.toolId, name: meta.name }, view.stream.body), text: "" };
  else if (part === "thinking") { const d = el("details", "think"); d.open = true; d.innerHTML = `<summary></summary><div class="stream on"></div>`; view.stream.body.appendChild(d); p = { part, el: d, stream: d.querySelector(".stream"), text: "" }; }
  else { const d = el("div", "stream on"); view.stream.body.appendChild(d); p = { part: "text", el: d, stream: d, text: "" }; }
  view.stream.parts.set(index, p);
  return p;
}
function finishPart(p, finalText) {
  if (!p || p.done) return;
  if (p.part === "tool_call") { try { setToolArgs(p.card, JSON.parse(p.card.argText || "{}")); } catch { p.card.args.textContent = p.card.argText; } p.done = true; return; }
  p.stream.classList.remove("on");
  const text = finalText ?? p.text;
  if (p.part === "text") p.stream.innerHTML = md(text); else { p.stream.textContent = text; p.el.open = false; }
  p.done = true;
}
function closeStream(view) {
  if (!view.stream) return;
  for (const p of view.stream.parts.values()) finishPart(p);
  if (!view.stream.body.childNodes.length) view.stream.el.remove();
  view.stream = null;
}
function applyEvent(view, ev) {
  const animate = !!ev.live;
  if (view.empty && !["session", "status", "usage"].includes(ev.kind)) { view.empty.remove(); view.empty = null; }
  switch (ev.kind) {
    case "session": updateHeader(); break;
    case "block":
      if (ev.phase === "message_start") { closeStream(view); openStream(view, ev.ts); }
      else if (ev.phase === "start") streamPart(view, ev.index, ev.part, ev);
      else if (ev.phase === "end") { const p = view.stream?.parts.get(ev.index); if (p) { if (p.part === "tool_call" && ev.args !== undefined) setToolArgs(p.card, ev.args); finishPart(p, ev.text); } }
      break;
    case "delta": {
      const p = streamPart(view, ev.index, ev.part, ev);
      if (p.part === "tool_call") { p.card.argText += ev.delta; p.card.args.textContent = p.card.argText; }
      else { p.text += ev.delta; p.stream.appendChild(el("span", "tok", ev.delta)); }
      scrollBottom();
      break;
    }
    case "msg": {
      if (ev.role === "assistant") {
        if (view.stream && ev.live) {
          const parts = [...view.stream.parts.values()].filter((p) => !p.done);
          for (const b of ev.blocks) {
            const p = parts.find((x) => (b.type === "tool_call" ? x.part === "tool_call" && x.card === view.tools.get(b.toolId) : x.part === b.type));
            if (p) { finishPart(p, b.text); if (b.type === "tool_call") setToolArgs(p.card, b.args); parts.splice(parts.indexOf(p), 1); }
            else renderBlocks(view, view.stream, [b]);
          }
          if (harnessOf(view.sid) === "pi") closeStream(view);
          break;
        }
        let bubble = ev.groupId ? view.groups.get(ev.groupId) : null;
        if (!bubble) { bubble = newBubble(view, "assistant", ev.ts, animate); if (ev.groupId) view.groups.set(ev.groupId, bubble); }
        renderBlocks(view, bubble, ev.blocks);
      } else if (ev.role === "tool") {
        for (const b of ev.blocks) {
          const c = view.tools.get(b.toolId);
          if (c) setToolResult(c, b.text, b.isError);
          else { const bub = newBubble(view, "system", ev.ts, animate, b.name || "tool result"); setToolResult(toolCard(view, { toolId: b.toolId, name: b.name || "result" }, bub.body), b.text, b.isError); }
        }
      } else {
        closeStream(view);
        const bubble = newBubble(view, ev.role, ev.ts, animate);
        if (ev.role === "user") bubble.body.textContent = ev.blocks.map((b) => b.text || "").join("\n"); else renderBlocks(view, bubble, ev.blocks);
      }
      scrollBottom();
      break;
    }
    case "tool": {
      const c = toolCard(view, ev, view.stream?.body);
      if (ev.phase === "start" && ev.args !== undefined) setToolArgs(c, ev.args);
      if (ev.phase === "update") { c.out.hidden = false; c.out.textContent = (ev.text || "").slice(-30000); }
      if (ev.phase === "end") setToolResult(c, ev.text, ev.isError);
      scrollBottom();
      break;
    }
    case "status": if (!ev.streaming) closeStream(view); updateComposer(); break;
    case "usage": if (ev.usage) $("#liveTokens").textContent = `in ${fmtN(ev.usage.input)} · cache ${fmtN(ev.usage.cacheRead)} · out ${fmtN(ev.usage.output)}`; break;
    case "compaction": { const d = el("div", "divider"); d.appendChild(el("span", null, "context compacted")); view.root.appendChild(d); break; }
    case "run": {
      closeStream(view);
      const b = newBubble(view, "system run-result", ev.ts, true, "claude code");
      b.body.textContent = `${ev.isError ? "Claude Code stopped with an error" : "Claude Code finished"}${ev.turns ? ` after ${ev.turns} turns` : ""}${ev.cost ? `, cost $${ev.cost.toFixed(4)}` : ""}${ev.text && ev.isError ? `: ${ev.text}` : ""}`;
      scrollBottom();
      break;
    }
    default: break;
  }
}
async function selectSession(sid) {
  S.selected = sid;
  renderHistory();
  const view = newView(sid);
  S.view = view;
  updateHeader(); updateComposer();
  try {
    const h = await api(`/api/sessions/${encodeURIComponent(sid)}/history`);
    if (S.selected !== sid) return;
    for (const ev of h.events) { applyEvent(view, ev); if (ev.ts > view.lastTs) view.lastTs = ev.ts; }
    if (h.session) S.sessions.set(sid, { ...(S.sessions.get(sid) || {}), ...h.session, tally: h.tally || S.sessions.get(sid)?.tally });
    for (const ev of S.buffers.get(sid) || []) if (ev.ts > view.lastTs || ev.kind === "delta" || ev.kind === "block") applyEvent(view, ev);
    $("#transcriptWrap").scrollTop = $("#transcriptWrap").scrollHeight;
    if (!h.events.length) { view.empty = el("div", "divider"); view.empty.appendChild(el("span", null, "nothing here yet")); view.root.appendChild(view.empty); }
  } catch (e) { toast(`Could not load history: ${e.message}`, true); }
  updateHeader();
  if (S.page === "tokens") renderStats();
}
function updateHeader() {
  const s = S.sessions.get(S.selected);
  if (S.page === "chat") $("#topTitle").textContent = s?.title || "Chat";
  if (!s) { $("#shTitle").textContent = "Pick a session"; $("#shMeta").textContent = "Choose a conversation from the history on the left, or start one from Home."; return; }
  $("#shTitle").textContent = s.title || `${s.harness} session ${s.sid.split(":")[1].slice(0, 8)}`;
  const meta = $("#shMeta");
  meta.innerHTML = `${esc(s.harness)} · ${esc(s.cwd || "")} <span class="model">${esc(s.model || "")}</span>`;
  const acts = el("span", "sh-actions");
  if (s.harness === "pi" && !s.owned && s.file) { const b = el("button", "btn quiet", "Open in Omni's pi"); b.title = "Switch Omni's pi to this session file (close it in your terminal first)"; b.onclick = async () => { try { await api("/api/pi/switch", { file: s.file }); toast("pi switched to this session"); } catch (e) { toast(e.message, true); } }; acts.appendChild(b); }
  meta.appendChild(acts);
}
function composerTarget() {
  const s = S.sessions.get(S.selected);
  if (!s) return { kind: "none" };
  if (s.harness === "pi" && s.owned && S.pi.running) return { kind: "pi", s };
  if (s.harness === "claude") return { kind: "claude", s, running: S.runs.some((r) => r.sid === s.sid && r.alive) };
  return { kind: "readonly", s };
}
function updateComposer() {
  const t = composerTarget();
  const target = $("#composerTarget"), send = $("#send");
  $("#optModel").hidden = t.kind !== "claude";
  $("#optAutoWrap").hidden = t.kind !== "claude";
  send.disabled = false; send.className = "send-btn"; send.textContent = "↑";
  if (t.kind === "pi") { target.innerHTML = `<b>pi</b>${t.s.streaming ? " · working, your message steers it" : ""}`; if (t.s.streaming) { send.className = "send-btn stop"; send.textContent = "■"; } }
  else if (t.kind === "claude") { target.innerHTML = t.running ? `<b>Claude Code</b> · running` : `<b>Claude Code</b> · resume this session`; if (t.running) { send.className = "send-btn stop"; send.textContent = "■"; } }
  else if (t.kind === "readonly") { target.innerHTML = `Runs in a terminal; read-only here`; send.disabled = true; }
  else { target.textContent = "Pick a session"; send.disabled = true; }
}
async function sendPrompt() {
  const t = composerTarget();
  const text = $("#input").value.trim();
  const memory = $("#optMemory").checked, graph = $("#optGraph").checked;
  try {
    if (t.kind === "pi") {
      if (t.s.streaming && !text) { await api("/api/pi/abort", {}); return; }
      if (!text) return;
      $("#input").value = ""; autosize($("#input"));
      await api("/api/pi/prompt", { message: text, memory, graph });
    } else if (t.kind === "claude") {
      if (t.running) { await api("/api/claude/abort", { sid: t.s.sid }); return; }
      if (!text) return;
      $("#input").value = ""; autosize($("#input"));
      const r = await api("/api/claude/run", { prompt: text, cwd: t.s.cwd, resume: t.s.sid.split(":")[1], model: $("#optModel").value, memory, graph, autonomous: $("#optAuto").checked });
      if (r.sid !== S.selected) selectSession(r.sid);
    }
  } catch (e) { toast(e.message, true); }
}
function autosize(i) { i.style.height = "auto"; i.style.height = `${Math.min(i.scrollHeight, 260)}px`; }

// ---------------------------------------------------------------- memory
async function loadMemory(q) {
  const list = $("#memList");
  try {
    const data = q ? await api(`/api/memory/search?q=${encodeURIComponent(q)}&limit=60`) : await api("/api/memory/list");
    const notes = q ? data.hits : data.notes.filter((n) => !n.path.startsWith("Graphs/"));
    if (!q) S.memCount = notes.length;
    list.innerHTML = "";
    if (!notes.length) list.appendChild(el("div", "lead", q ? "No notes match." : "The vault is empty. Save a memory, import Claude's, or let a session digest land here."));
    for (const n of notes) {
      const d = el("div", "note");
      const name = el("div", "n-name", n.name); name.dataset.type = n.type || "";
      d.append(name, el("div", "n-desc", n.description || n.preview || ""), el("div", "n-path", n.path));
      d.onclick = () => openNote(n.path);
      list.appendChild(d);
    }
  } catch (e) { toast(e.message, true); }
}
async function openNote(path) {
  try { const n = await api(`/api/memory/note?path=${encodeURIComponent(path)}`); $("#memPath").textContent = path; $("#memText").value = n.raw; $("#memEditor").hidden = false; $("#memForm").hidden = true; $("#memList").hidden = true; }
  catch (e) { toast(e.message, true); }
}
function closeNote() { $("#memEditor").hidden = true; $("#memForm").hidden = true; $("#memList").hidden = false; }

// ----------------------------------------------------------------- stats
function tile(k, v) { const t = el("div", "tile"); t.append(el("div", "v", v), el("div", "k", k)); return t; }
function renderStats() {
  const s = S.sessions.get(S.selected);
  const t = s?.tally;
  const tiles = $("#statTiles"); tiles.innerHTML = "";
  $("#statTitle").textContent = s ? (s.title || "Current chat") : "Current chat";
  if (t) {
    tiles.append(tile("input", fmtN(t.input)), tile("output", fmtN(t.output)), tile("cache read", fmtN(t.cacheRead)), tile("cache write", fmtN(t.cacheWrite)), tile("messages", fmtN(t.messages)), tile("cost", `$${(t.cost || 0).toFixed(3)}`));
    const win = s.harness === "claude" ? (/haiku/.test(s.model || "") ? 200000 : 1000000) : (S.pi.state?.model?.contextWindow || 262144);
    const pct = Math.min(100, Math.round((t.context / win) * 100));
    const f = $("#ctxFill"); f.style.width = `${pct}%`; f.className = pct > 85 ? "hot" : pct > 60 ? "warn" : "";
    $("#ctxLabel").textContent = `context ${fmtN(t.context)} of ${fmtN(win)} (${pct}%)${pct > 60 ? " – consider compacting or a fresh session" : ""}`;
  } else { tiles.appendChild(el("div", "lead", "No token data for this chat yet.")); $("#ctxFill").style.width = "0"; $("#ctxLabel").textContent = ""; }
  const all = { input: 0, output: 0, cacheRead: 0, cost: 0, n: 0 };
  const today = new Date().setHours(0, 0, 0, 0);
  const ranked = [];
  for (const x of S.sessions.values()) {
    if (!x.tally) continue;
    ranked.push(x);
    if ((x.lastActivity || x.mtime || 0) < today) continue;
    all.input += x.tally.input; all.output += x.tally.output; all.cacheRead += x.tally.cacheRead; all.cost += x.tally.cost; all.n++;
  }
  const a = $("#statAll"); a.innerHTML = "";
  a.append(tile("sessions", all.n), tile("input", fmtN(all.input)), tile("output", fmtN(all.output)), tile("cache read", fmtN(all.cacheRead)), tile("cost", `$${all.cost.toFixed(2)}`), tile("cache hit", all.input + all.cacheRead ? `${Math.round((all.cacheRead / (all.input + all.cacheRead)) * 100)}%` : "–"));
  const top = $("#statTop"); top.innerHTML = "";
  for (const x of ranked.sort((p, q) => q.tally.cost - p.tally.cost || q.tally.total - p.tally.total).slice(0, 10)) {
    const r = el("div", "row"); r.append(el("span", null, `${x.harness} · ${(x.title || x.sid).slice(0, 60)}`), el("span", null, `${fmtN(x.tally.total)} tok  $${x.tally.cost.toFixed(2)}`));
    r.onclick = () => { selectSession(x.sid); showView("chat"); };
    top.appendChild(r);
  }
}

// ----------------------------------------------------------------- files
let filesRoot = null;
function currentDir() { return S.sessions.get(S.selected)?.cwd || $("#homeCwd").value.trim() || S.config?.cwd || null; }
async function loadFiles() {
  const root = currentDir();
  if (!root) return;
  if (root === filesRoot) return;
  filesRoot = root;
  $("#filesRoot").textContent = root;
  await loadDir(root, "", $("#tree"));
}
async function loadDir(root, path, container) {
  try {
    const { entries } = await api(`/api/fs/list?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`);
    container.innerHTML = "";
    for (const e of entries) {
      const node = el("div", "node"), row = el("div", "row");
      row.append(el("span", "ico", e.dir ? "▸" : "·"), el("span", null, e.name));
      node.appendChild(row);
      if (e.dir) { const kids = el("div", "children"); kids.hidden = true; node.appendChild(kids); let loaded = false; row.onclick = async () => { kids.hidden = !kids.hidden; row.querySelector(".ico").textContent = kids.hidden ? "▸" : "▾"; if (!kids.hidden && !loaded) { loaded = true; await loadDir(root, e.path, kids); } }; }
      else row.onclick = () => openFile(root, e.path);
      container.appendChild(node);
    }
  } catch (e) { container.textContent = e.message; }
}
async function openFile(root, path) {
  try {
    const d = await api(`/api/fs/read?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`);
    $("#vpath").textContent = path;
    $("#vbody").textContent = d.content != null ? d.content : d.tooBig ? `(file too large: ${d.size} bytes)` : d.binary ? `(binary file: ${d.ext})` : "(unreadable)";
    $("#viewer").hidden = false;
    $("#vref").onclick = () => { const i = S.page === "chat" ? $("#input") : $("#homeInput"); i.value += `${i.value ? " " : ""}@${path} `; $("#viewer").hidden = true; showView(S.page === "chat" ? "chat" : "home"); i.focus(); };
  } catch (e) { toast(e.message, true); }
}

// ----------------------------------------------------------------- graph
const G = { dir: null, data: null, pos: new Map(), sel: null, view: { x: 0, y: 0, k: 1 }, drag: null, raf: 0, ticks: 0 };
async function loadGraph() {
  const dir = currentDir();
  $("#graphDir").textContent = dir ? `Repo: ${dir}` : "Pick a session or set a working directory on Home; that folder is the repo.";
  if (!dir) return;
  G.dir = dir;
  try {
    const d = await api(`/api/graph/data?dir=${encodeURIComponent(dir)}&limit=${Number($("#graphLimit").value) || 150}&q=${encodeURIComponent($("#graphFilter").value.trim())}`);
    G.data = d;
    $("#graphTotals").textContent = `${d.totals.nodes} nodes, ${d.totals.links} links, ${d.totals.communities} communities in the full graph; showing the ${d.nodes.length} best-connected.`;
    layoutGraph();
  } catch (e) {
    G.data = null; drawGraph();
    $("#graphTotals").textContent = /no graph/.test(e.message) ? "No graph for this folder yet. Build one (takes seconds, no LLM)." : e.message;
  }
}
function layoutGraph() {
  const c = $("#graphCanvas");
  const W = c.width = c.clientWidth * devicePixelRatio, H = c.height = c.clientHeight * devicePixelRatio;
  const nodes = G.data.nodes;
  const keep = new Map();
  for (const n of nodes) keep.set(n.id, G.pos.get(n.id) || { x: W / 2 + (Math.random() - 0.5) * W * 0.6, y: H / 2 + (Math.random() - 0.5) * H * 0.6, vx: 0, vy: 0 });
  G.pos = keep; G.ticks = 0; G.view = { x: 0, y: 0, k: 1 };
  cancelAnimationFrame(G.raf);
  const step = () => {
    const pos = G.pos, k = 0.9;
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
      const a = pos.get(nodes[i].id), b = pos.get(nodes[j].id);
      let dx = a.x - b.x, dy = a.y - b.y; const d2 = dx * dx + dy * dy + 0.01, d = Math.sqrt(d2);
      const f = (2600 * devicePixelRatio) / d2; dx /= d; dy /= d;
      a.vx += dx * f; a.vy += dy * f; b.vx -= dx * f; b.vy -= dy * f;
    }
    for (const l of G.data.links) {
      const a = pos.get(l.source), b = pos.get(l.target); if (!a || !b) continue;
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.sqrt(dx * dx + dy * dy) + 0.01, f = (d - 60 * devicePixelRatio) * 0.02;
      a.vx += (dx / d) * f; a.vy += (dy / d) * f; b.vx -= (dx / d) * f; b.vy -= (dy / d) * f;
    }
    for (const n of nodes) { const p = pos.get(n.id); p.vx += (W / 2 - p.x) * 0.002; p.vy += (H / 2 - p.y) * 0.002; p.x += p.vx *= k; p.y += p.vy *= k; }
    drawGraph();
    if (++G.ticks < 220) G.raf = requestAnimationFrame(step);
  };
  G.raf = requestAnimationFrame(step);
}
const COMMUNITY_COLORS = ["#7cc9ff", "#f2b84b", "#b39cff", "#57d69a", "#ff7b7b", "#ffa94d", "#7dd3fc", "#f9a8d4", "#a3e635", "#fb7185", "#c4b5fd", "#67e8f9"];
function drawGraph() {
  const c = $("#graphCanvas"), ctx = c.getContext("2d");
  const W = c.width, H = c.height;
  ctx.clearRect(0, 0, W, H);
  if (!G.data) { ctx.fillStyle = "#5f5f68"; ctx.font = `${13 * devicePixelRatio}px IBM Plex Sans, sans-serif`; ctx.fillText("No graph loaded.", 16 * devicePixelRatio, 28 * devicePixelRatio); return; }
  ctx.save(); ctx.translate(G.view.x, G.view.y); ctx.scale(G.view.k, G.view.k);
  const selLinks = new Set();
  ctx.lineWidth = devicePixelRatio;
  for (const l of G.data.links) {
    const a = G.pos.get(l.source), b = G.pos.get(l.target); if (!a || !b) continue;
    const hot = G.sel && (l.source === G.sel || l.target === G.sel);
    if (hot) selLinks.add(l.source === G.sel ? l.target : l.source);
    ctx.strokeStyle = hot ? "rgba(124,201,255,0.9)" : "rgba(154,154,163,0.16)";
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }
  ctx.font = `${11 * devicePixelRatio}px IBM Plex Sans, sans-serif`;
  for (const n of G.data.nodes) {
    const p = G.pos.get(n.id); const r = (3 + Math.min(10, Math.sqrt(n.degree))) * devicePixelRatio;
    const dim = G.sel && n.id !== G.sel && !selLinks.has(n.id);
    ctx.globalAlpha = dim ? 0.25 : 1;
    ctx.fillStyle = COMMUNITY_COLORS[(n.community ?? 0) % COMMUNITY_COLORS.length];
    ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();
    if (n.degree >= 4 || n.id === G.sel || selLinks.has(n.id)) { ctx.fillStyle = "#ececee"; ctx.fillText(n.label.slice(0, 28), p.x + r + 3, p.y + 4 * devicePixelRatio); }
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}
function graphHit(ev) {
  const c = $("#graphCanvas"), rect = c.getBoundingClientRect();
  const x = ((ev.clientX - rect.left) * devicePixelRatio - G.view.x) / G.view.k, y = ((ev.clientY - rect.top) * devicePixelRatio - G.view.y) / G.view.k;
  let best = null, bd = 14 * devicePixelRatio;
  for (const n of G.data?.nodes || []) { const p = G.pos.get(n.id); const d = Math.hypot(p.x - x, p.y - y); if (d < bd) { bd = d; best = n; } }
  return best;
}
function showGraphNode(n) {
  const box = $("#graphNode");
  if (!n) { box.innerHTML = ""; return; }
  const links = G.data.links.filter((l) => l.source === n.id || l.target === n.id).map((l) => { const other = G.data.nodes.find((x) => x.id === (l.source === n.id ? l.target : l.source)); return `<span class="lk">${esc(l.relation || "")}</span> ${esc(other?.label || "")}`; });
  box.innerHTML = `<b>${esc(n.label)}</b> <span class="lk">${esc(n.file || "")} ${esc(n.loc || "")}</span> · community ${n.community} · ${n.degree} links<br>${links.slice(0, 12).join("<br>")}${links.length > 12 ? `<br>… ${links.length - 12} more` : ""}`;
}
(() => {
  const c = $("#graphCanvas");
  c.addEventListener("mousedown", (e) => { G.drag = { x: e.clientX, y: e.clientY, vx: G.view.x, vy: G.view.y, moved: false }; });
  window.addEventListener("mousemove", (e) => { if (!G.drag) return; const dx = (e.clientX - G.drag.x) * devicePixelRatio, dy = (e.clientY - G.drag.y) * devicePixelRatio; if (Math.abs(dx) + Math.abs(dy) > 3) G.drag.moved = true; G.view.x = G.drag.vx + dx; G.view.y = G.drag.vy + dy; drawGraph(); });
  window.addEventListener("mouseup", (e) => { if (!G.drag) return; if (!G.drag.moved && e.target === c) { const n = graphHit(e); G.sel = n?.id || null; showGraphNode(n); drawGraph(); } G.drag = null; });
  c.addEventListener("wheel", (e) => { e.preventDefault(); const f = e.deltaY < 0 ? 1.15 : 1 / 1.15; const rect = c.getBoundingClientRect(); const mx = (e.clientX - rect.left) * devicePixelRatio, my = (e.clientY - rect.top) * devicePixelRatio; G.view.x = mx - (mx - G.view.x) * f; G.view.y = my - (my - G.view.y) * f; G.view.k *= f; drawGraph(); }, { passive: false });
})();
async function loadGraphList() { try { S.graphs = (await api("/api/graph/list")).graphs || []; } catch { S.graphs = []; } }

// ------------------------------------------------------------------ SSE
function connect() {
  const es = new EventSource(`/events?since=${S.seq}`);
  es.onmessage = (m) => { let ev; try { ev = JSON.parse(m.data); } catch { return; } handle(ev); };
  es.onerror = () => { $("#piStatus").textContent = "reconnecting"; };
}
let railTimer = null;
function handle(ev) {
  S.seq = Math.max(S.seq, ev.seq || 0);
  if (ev.kind === "log") { if (ev.level === "system") toast(ev.text); else if (ev.level === "graphify" && ev.text) $("#graphTotals").textContent = ev.text.split("\n").pop(); return; }
  const s = S.sessions.get(ev.sid) || { sid: ev.sid, harness: ev.harness, lastActivity: 0, tally: null };
  if (ev.kind === "session") Object.assign(s, Object.fromEntries(Object.entries({ cwd: ev.cwd, title: ev.title, model: ev.model, file: ev.file, owned: ev.owned }).filter(([, v]) => v != null)));
  if (ev.kind === "status") s.streaming = !!ev.streaming;
  if (ev.kind === "msg" && ev.role === "user" && !s.title) s.title = (ev.blocks?.[0]?.text || "").replace(/\s+/g, " ").slice(0, 80);
  if (ev.kind === "msg" && ev.usage) { const t = s.tally || (s.tally = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, messages: 0, cost: 0, context: 0 }); if (!ev.groupId || t.lastGroup !== ev.groupId) { t.lastGroup = ev.groupId; t.input += ev.usage.input; t.output += ev.usage.output; t.cacheRead += ev.usage.cacheRead; t.cacheWrite += ev.usage.cacheWrite; t.total += ev.usage.total; t.messages++; t.context = ev.usage.input + ev.usage.cacheRead + ev.usage.cacheWrite; t.cost += ev.cost || 0; } }
  if (ev.kind !== "session") s.lastActivity = Math.max(s.lastActivity || 0, ev.ts || 0);
  if (ev.kind === "digest") toast(`Digest saved: ${ev.path}`);
  S.sessions.set(ev.sid, s);
  if (ev.harness === "pi" && s.owned) { S.pi.running = true; if (ev.kind === "session" && ev.cwd) S.pi.cwd = ev.cwd; $("#piStatus").textContent = `pi: ${s.model || "ready"}${s.streaming ? " · working" : ""}`; $("#piStatus").classList.toggle("on", !!s.streaming); }
  if (ev.kind === "run" && ev.harness === "claude") { const r = S.runs.find((x) => x.sid === ev.sid); if (r) r.alive = false; }
  if (ev.kind === "session" && ev.harness === "claude" && ev.owned && !S.runs.some((r) => r.sid === ev.sid)) S.runs.push({ sid: ev.sid, alive: true });
  if (ev.kind === "status" && ev.harness === "claude") { const r = S.runs.find((x) => x.sid === ev.sid); if (r) r.alive = !!ev.streaming; }
  const buf = S.buffers.get(ev.sid) || []; buf.push(ev); if (buf.length > 800) buf.splice(0, buf.length - 800); S.buffers.set(ev.sid, buf);
  if (ev.sid === S.selected && S.view) { applyEvent(S.view, ev); if ((ev.kind === "msg" || ev.kind === "run") && S.page === "tokens") renderStats(); if (ev.kind === "status" || ev.kind === "session") { updateHeader(); updateComposer(); } }
  if (!railTimer) railTimer = setTimeout(() => { railTimer = null; renderHistory(); if (S.page === "home") renderHome(); }, 250);
}

// ------------------------------------------------------------------ init
async function init() {
  const st = await api("/api/state");
  S.config = st.config; S.pi = st.pi; S.runs = st.runs || [];
  for (const s of st.sessions) S.sessions.set(s.sid, s);
  $("#piStatus").textContent = st.pi?.running ? `pi: ${st.pi.state?.model?.id || "ready"}` : "pi: off";
  if (st.config?.lanUrls?.length) $("#lanInfo").textContent = st.config.lanUrls[0].replace(/\?token=.*/, "");
  await Promise.all([loadMemory(""), loadGraphList()]);
  renderHistory();
  showView("home");
  connect();
  setInterval(renderHistory, 15000);
}

document.querySelectorAll(".nav-item[data-view]").forEach((b) => { b.onclick = () => showView(b.dataset.view); });
$("#btnNewChat").onclick = () => { showView("home"); $("#homeInput").focus(); };
$("#btnOpenSide").onclick = () => document.body.classList.add("show-side");
$("#btnCloseSide").onclick = () => document.body.classList.remove("show-side");
$("#sessionFilter").addEventListener("input", renderHistory);
$("#homeTarget").addEventListener("click", (e) => { const b = e.target.closest(".seg-btn"); if (!b) return; document.querySelectorAll("#homeTarget .seg-btn").forEach((x) => x.classList.toggle("active", x === b)); $("#homeModel").hidden = b.dataset.target !== "claude"; });
$("#homeModel").hidden = true;
$("#homeSend").onclick = homeSend;
$("#homeInput").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); homeSend(); } });
$("#homeInput").addEventListener("input", () => autosize($("#homeInput")));
$("#homeCwd").addEventListener("change", () => { filesRoot = null; renderHome(); });
$("#send").onclick = sendPrompt;
$("#input").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendPrompt(); } });
$("#input").addEventListener("input", () => autosize($("#input")));
$("#memSearch").addEventListener("input", () => { clearTimeout(window._ms); window._ms = setTimeout(() => loadMemory($("#memSearch").value.trim()), 250); });
$("#memNew").onclick = () => { $("#memForm").hidden = false; $("#memEditor").hidden = true; $("#memList").hidden = true; $("#mfName").focus(); };
$("#mfCancel").onclick = closeNote;
$("#mfSave").onclick = async () => { try { const r = await api("/api/memory/save", { name: $("#mfName").value, description: $("#mfDesc").value, type: $("#mfType").value, body: $("#mfBody").value }); toast(`Saved ${r.path}`); $("#mfName").value = $("#mfDesc").value = $("#mfBody").value = ""; closeNote(); loadMemory(""); } catch (e) { toast(e.message, true); } };
$("#memSave").onclick = async () => { try { await api("/api/memory/note", { path: $("#memPath").textContent, text: $("#memText").value }, "PUT"); toast("Note saved"); loadMemory($("#memSearch").value.trim()); } catch (e) { toast(e.message, true); } };
$("#memDelete").onclick = async () => { const p = $("#memPath").textContent; if (!confirm(`Delete ${p}?`)) return; try { await api(`/api/memory/note?path=${encodeURIComponent(p)}`, null, "DELETE"); toast("Note deleted"); closeNote(); loadMemory(""); } catch (e) { toast(e.message, true); } };
$("#memClose").onclick = closeNote;
$("#memImport").onclick = async () => { try { const r = await api("/api/memory/import-claude", {}); toast(`Imported ${r.imported.length} Claude memory notes`); loadMemory(""); } catch (e) { toast(e.message, true); } };
$("#memReindex").onclick = async () => { try { const r = await api("/api/memory/reindex", {}); toast(`Index rebuilt: ${r.notes} notes`); } catch (e) { toast(e.message, true); } };
$("#memOpen").onclick = () => api("/api/memory/open-vault", {}).catch((e) => toast(e.message, true));
$("#memDigest").onclick = async () => { if (!S.selected) return toast("Open a chat first", true); try { const r = await api("/api/memory/digest", { sid: S.selected }); toast(`Digest written: ${r.path}`); loadMemory(""); } catch (e) { toast(e.message, true); } };
$("#graphBuild").onclick = async () => {
  const dir = currentDir(); if (!dir) return;
  $("#graphBuild").disabled = true; $("#graphTotals").textContent = "Building… (graphify update + clustering)";
  try { const r = await api("/api/graph/build", { dir }); toast(`Graph built: ${r.nodes} nodes, ${r.notes} notes in vault/${r.vault}`); await loadGraphList(); await loadGraph(); }
  catch (e) { toast(e.message, true); $("#graphTotals").textContent = e.message; }
  finally { $("#graphBuild").disabled = false; }
};
$("#graphRefresh").onclick = loadGraph;
$("#graphFilter").addEventListener("input", () => { clearTimeout(window._gf); window._gf = setTimeout(loadGraph, 300); });
$("#graphLimit").addEventListener("change", loadGraph);
$("#graphOpenNotes").onclick = () => { $("#memSearch").value = "graph"; showView("memory"); };
$("#graphAsk").onclick = async () => {
  const q = $("#graphQ").value.trim(); const dir = currentDir(); if (!q || !dir) return;
  $("#graphAnswer").hidden = false; $("#graphAnswer").textContent = "Asking the graph…";
  try { const r = await api("/api/graph/query", { dir, question: q }); $("#graphAnswer").textContent = r.answer || "(no answer)"; } catch (e) { $("#graphAnswer").textContent = e.message; }
};
$("#graphQ").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#graphAsk").click(); });
$("#vclose").onclick = () => { $("#viewer").hidden = true; };
$("#viewer").onclick = (e) => { if (e.target.id === "viewer") $("#viewer").hidden = true; };
init().catch((e) => toast(`Omni Agent failed to start: ${e.message}`, true));
