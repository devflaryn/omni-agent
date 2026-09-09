/* Right panel: tab strip + the Tokens, Memory, Graph and Files features. */
import { el, esc, fmtN } from "./lib.js";

export function createPanel({ S, api, toast, onSelect, currentDir, insert, getPiContextWindow }) {
  const $ = (s) => document.querySelector(s);
  const TABS = ["tokens", "memory", "graph", "files"];
  let tab = "tokens";
  try { tab = TABS.includes(localStorage.getItem("omni.tab")) ? localStorage.getItem("omni.tab") : "tokens"; } catch { /* */ }

  function show(name) {
    tab = name;
    document.querySelectorAll(".ptab").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
    document.querySelectorAll(".ptab-body").forEach((b) => b.classList.toggle("active", b.id === `tab-${name}`));
    try { localStorage.setItem("omni.tab", name); } catch { /* */ }
    if (name === "tokens") renderStats();
    if (name === "memory") loadMemory($("#memSearch").value.trim());
    if (name === "graph") loadGraph();
    if (name === "files") loadFiles();
  }
  function setOpen(open) { document.body.classList.toggle("panel-open", open); try { localStorage.setItem("omni.panel", open ? "1" : "0"); } catch { /* */ } if (open) show(tab); }
  function open(name) { if (name) tab = name; setOpen(true); }
  function toggle() { setOpen(!document.body.classList.contains("panel-open")); }
  document.querySelectorAll(".ptab").forEach((b) => { b.onclick = () => show(b.dataset.tab); });
  $("#btnPanel").onclick = toggle;
  $("#btnPanelClose").onclick = () => setOpen(false);
  let initial = false; try { initial = localStorage.getItem("omni.panel") === "1"; } catch { /* */ }
  if (window.innerWidth < 1100) initial = false;
  setOpen(initial);

  // ---------------------------------------------------------------- tokens
  function tile(k, v) { const t = el("div", "tile"); t.append(el("div", "v", v), el("div", "k", k)); return t; }
  function renderStats() {
    const s = S.sessions.get(S.selected);
    const t = s?.tally;
    const tiles = $("#statTiles"); tiles.innerHTML = "";
    $("#statTitle").textContent = s ? (s.title || "Current chat") : "Current chat";
    if (t) {
      tiles.append(tile("input", fmtN(t.input)), tile("output", fmtN(t.output)), tile("cache read", fmtN(t.cacheRead)), tile("cache write", fmtN(t.cacheWrite)), tile("messages", fmtN(t.messages)), tile("cost", `$${(t.cost || 0).toFixed(3)}`));
      const win = s.harness === "claude" ? (/haiku/.test(s.model || "") ? 200000 : 1000000) : (getPiContextWindow() || 262144);
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
      r.onclick = () => onSelect(x.sid);
      top.appendChild(r);
    }
  }

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

  // ----------------------------------------------------------------- files
  let filesRoot = null;
  function resetFiles() { filesRoot = null; }
  async function loadFiles() {
    const root = currentDir();
    if (!root || root === filesRoot) return;
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
      $("#vref").onclick = () => { insert(`@${path} `); $("#viewer").hidden = true; };
    } catch (e) { toast(e.message, true); }
  }
  $("#vclose").onclick = () => { $("#viewer").hidden = true; };
  $("#viewer").onclick = (e) => { if (e.target.id === "viewer") $("#viewer").hidden = true; };

  // ----------------------------------------------------------------- graph
  const G = { dir: null, data: null, pos: new Map(), sel: null, view: { x: 0, y: 0, k: 1 }, drag: null, raf: 0, ticks: 0 };
  async function loadGraph() {
    const dir = currentDir();
    $("#graphDir").textContent = dir ? `Repo: ${dir}` : "Pick a chat or set a working directory on Home; that folder is the repo.";
    if (!dir) return;
    G.dir = dir;
    try {
      const d = await api(`/api/graph/data?dir=${encodeURIComponent(dir)}&limit=${Number($("#graphLimit").value) || 150}&q=${encodeURIComponent($("#graphFilter").value.trim())}`);
      G.data = d;
      $("#graphTotals").textContent = `${d.totals.nodes} nodes, ${d.totals.links} links, ${d.totals.communities} communities; showing the ${d.nodes.length} best-connected.`;
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
  const COLORS = ["#7cc9ff", "#f2b84b", "#b39cff", "#57d69a", "#ff7b7b", "#ffa94d", "#7dd3fc", "#f9a8d4", "#a3e635", "#fb7185", "#c4b5fd", "#67e8f9"];
  function drawGraph() {
    const c = $("#graphCanvas"), ctx = c.getContext("2d");
    const W = c.width, H = c.height;
    ctx.clearRect(0, 0, W, H);
    if (!G.data) { ctx.fillStyle = "#6b6b6b"; ctx.font = `${13 * devicePixelRatio}px system-ui, sans-serif`; ctx.fillText("No graph loaded.", 16 * devicePixelRatio, 28 * devicePixelRatio); return; }
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
    ctx.font = `${11 * devicePixelRatio}px system-ui, sans-serif`;
    for (const n of G.data.nodes) {
      const p = G.pos.get(n.id); const r = (3 + Math.min(10, Math.sqrt(n.degree))) * devicePixelRatio;
      const dim = G.sel && n.id !== G.sel && !selLinks.has(n.id);
      ctx.globalAlpha = dim ? 0.25 : 1;
      ctx.fillStyle = COLORS[(n.community ?? 0) % COLORS.length];
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();
      if (n.degree >= 4 || n.id === G.sel || selLinks.has(n.id)) { ctx.fillStyle = "#ececec"; ctx.fillText(n.label.slice(0, 28), p.x + r + 3, p.y + 4 * devicePixelRatio); }
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
  $("#graphOpenNotes").onclick = () => { $("#memSearch").value = "graph"; show("memory"); };
  $("#graphAsk").onclick = async () => {
    const q = $("#graphQ").value.trim(); const dir = currentDir(); if (!q || !dir) return;
    $("#graphAnswer").hidden = false; $("#graphAnswer").textContent = "Asking the graph…";
    try { const r = await api("/api/graph/query", { dir, question: q }); $("#graphAnswer").textContent = r.answer || "(no answer)"; } catch (e) { $("#graphAnswer").textContent = e.message; }
  };
  $("#graphQ").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#graphAsk").click(); });

  return { open, toggle, show, renderStats, loadMemory, loadGraph, loadGraphList, loadFiles, resetFiles, graphLine: (t) => { $("#graphTotals").textContent = t; } };
}
