/* Omni Agent front end. Home + Chat in the main column, Tokens/Memory/Graph/Files in the right panel. */
import { el, fmtN, baseName } from "./lib.js";
import { newView, applyEvent, finish, forkNote, emptyNote } from "./transcript.js";
import { createComposer } from "./composer.js";
import { createSidebar } from "./sidebar.js";
import { createPanel } from "./panel.js";

const $ = (s) => document.querySelector(s);
const S = { sessions: new Map(), selected: null, pi: { running: false }, runs: [], seq: 0, buffers: new Map(), view: null, page: "home", config: null, memCount: 0, graphs: [], followFork: null, forceFork: false, desktop: new URLSearchParams(location.search).get("desktop") === "1" };
const liveWindowMs = () => S.config?.liveWindowMs || 30000;

async function api(path, body, method) {
  const r = await fetch(path, body ? { method: method || "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : { method: method || "GET" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error || `${r.status}`);
  return j;
}
function toast(text, err) { const t = el("div", `toast${err ? " err" : ""}`, text); $("#toasts").appendChild(t); setTimeout(() => t.remove(), err ? 7000 : 3500); }
const currentDir = () => S.sessions.get(S.selected)?.cwd || $("#homeCwd").value.trim() || S.config?.cwd || null;

// ------------------------------------------------------------- modules
const sidebar = createSidebar({ S, onSelect: (sid) => { selectSession(sid); showView("chat"); }, onNew: () => { showView("home"); home.focus(); } });
const panel = createPanel({ S, api, toast, onSelect: (sid) => { selectSession(sid); showView("chat"); }, currentDir, insert: (t) => (S.page === "chat" ? chat : home).insert(t), getPiContextWindow: () => S.pi.state?.model?.contextWindow });
const home = createComposer($("#homeComposer"), { showTarget: true, onSend: homeSend, onPickFile: () => panel.open("files"), onPiModel: setPiModel, onPiThinking: setPiThinking });
const chat = createComposer($("#chatComposer"), { onSend: chatSend, onStop: chatStop, onPickFile: () => panel.open("files"), onPiModel: setPiModel, onPiThinking: setPiThinking });
home.setState({ harness: "pi" });

async function setPiModel(provider, id) { try { await api("/api/pi/model", { provider, modelId: id }); toast(`pi model: ${id}`); } catch (e) { toast(e.message, true); } }
async function setPiThinking(level) { try { await api("/api/pi/thinking", { level }); } catch (e) { toast(e.message, true); } }
async function loadPiChoices() {
  if (!S.pi.running) return;
  try {
    const [m, l] = await Promise.all([api("/api/pi/models"), api("/api/pi/thinking-levels")]);
    const choices = { models: m.data?.models || [], levels: l.data?.levels || [] };
    home.setPiChoices(choices); chat.setPiChoices(choices);
  } catch { /* pi may still be starting */ }
}
function piModelState() { const mdl = S.pi.state?.model; return { piModel: mdl ? { provider: mdl.provider, id: mdl.id } : null, piThinking: S.pi.state?.thinkingLevel || "" }; }

// --------------------------------------------------------------- views
function showView(name) {
  S.page = name;
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${name}`));
  $("#btnChatMenu").hidden = name !== "chat";
  if (window.innerWidth < 860) sidebar.setOpen(false);
  if (name === "home") renderHome();
  if (name === "chat") { updateHeader(); updateComposer(); }
  updateTitle();
}
function updateTitle() {
  const s = S.sessions.get(S.selected);
  const title = S.page === "chat" && s?.title ? s.title : "Omni Agent";
  $("#topTitle").textContent = title;
  document.title = S.page === "chat" && s?.title ? `${s.title} · Omni Agent` : "Omni Agent";
}

// ---------------------------------------------------------------- home
function recentDirs() {
  const seen = new Map();
  for (const s of [...S.sessions.values()].sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0))) { if (s.cwd && !seen.has(s.cwd)) seen.set(s.cwd, s); if (seen.size >= 6) break; }
  return [...seen.keys()];
}
function renderHome() {
  const cwdInput = $("#homeCwd");
  if (!cwdInput.value) cwdInput.value = S.pi.cwd || S.config?.cwd || "";
  const chips = $("#dirChips"); chips.innerHTML = "";
  for (const d of recentDirs()) { const c = el("button", `chip${d === cwdInput.value ? " active" : ""}`, baseName(d) || d); c.title = d; c.onclick = () => { cwdInput.value = d; panel.resetFiles(); renderHome(); }; chips.appendChild(c); }
  const live = [...S.sessions.values()].filter((s) => s.streaming);
  const today = new Date().setHours(0, 0, 0, 0);
  let tok = 0, cost = 0, n = 0;
  for (const s of S.sessions.values()) { if (!s.tally || (s.lastActivity || s.mtime || 0) < today) continue; tok += s.tally.total; cost += s.tally.cost; n++; }
  const recent = [...S.sessions.values()].filter((s) => s.title).sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0))[0];
  const cards = $("#homeCards"); cards.innerHTML = "";
  const card = (title, big, sub, onClick, cls) => { const c = el("div", `card${cls ? ` ${cls}` : ""}`); c.append(el("div", "c-title", title), el("div", "c-big", big), el("div", "c-sub", sub)); c.onclick = onClick; cards.appendChild(c); };
  card("Working now", String(live.length), live.length ? live.map((s) => `${s.harness}: ${s.title || "…"}`).join(" · ") : recent ? `Last: ${recent.title}` : "Nothing running", () => { if (live[0]) { selectSession(live[0].sid); showView("chat"); } }, live.length ? "live" : "");
  card("Tokens today", fmtN(tok), `${n} session${n === 1 ? "" : "s"} · $${cost.toFixed(2)}`, () => panel.open("tokens"));
  card("Memory", String(S.memCount), S.config ? `vault: ${baseName(S.config.vault)}` : "", () => panel.open("memory"));
  card("Repo graphs", String(S.graphs.length), S.graphs[0] ? `${S.graphs[0].name}: ${S.graphs[0].nodes} nodes` : "Build one from a chat's folder", () => panel.open("graph"));
  $("#topModel").textContent = S.pi.state?.model?.id || "";
  home.setState({ ...piModelState() });
}
async function homeSend(text, o) {
  const cwd = $("#homeCwd").value.trim() || S.config?.cwd;
  home.setState({ disabled: true });
  try {
    if (o.target === "pi") {
      if (!S.pi.running || (S.pi.cwd || "").toLowerCase() !== cwd.toLowerCase()) await api("/api/pi/start", { cwd }); else await api("/api/pi/new", {});
      const st = await api("/api/state");
      S.pi = st.pi;
      if (!st.pi.sid) throw new Error("pi did not report a session");
      S.sessions.set(st.pi.sid, { ...(S.sessions.get(st.pi.sid) || {}), sid: st.pi.sid, harness: "pi", owned: true, cwd, model: st.pi.state?.model?.id, title: text.replace(/\s+/g, " ").slice(0, 80), lastActivity: Date.now(), streaming: true });
      selectSession(st.pi.sid); showView("chat");
      await api("/api/pi/prompt", { message: text, memory: o.memory, graph: o.graph });
      home.clear();
    } else {
      const r = await api("/api/claude/run", { prompt: text, cwd, model: o.model, memory: o.memory, graph: o.graph, autonomous: o.autonomous });
      S.sessions.set(r.sid, { sid: r.sid, harness: "claude", owned: true, cwd, title: text.replace(/\s+/g, " ").slice(0, 80), lastActivity: Date.now(), streaming: true });
      home.clear(); selectSession(r.sid); showView("chat");
    }
  } catch (e) { toast(e.message, true); }
  finally { home.setState({ disabled: false }); }
}

// ---------------------------------------------------------------- chat
function target() {
  const s = S.sessions.get(S.selected);
  if (!s) return { kind: "none" };
  if (s.harness === "pi" && s.owned && S.pi.running && S.pi.sid === s.sid) return { kind: "owned-pi", s, streaming: !!s.streaming };
  if (s.harness === "claude" && S.runs.some((r) => r.sid === s.sid && r.alive)) return { kind: "owned-claude-running", s };
  const live = !s.owned && (s.streaming || Date.now() - Math.max(s.lastActivity || 0, s.mtime || 0) < liveWindowMs());
  return { kind: "continue", s, live };
}
function updateComposer() {
  const t = target();
  const st = { harness: t.s?.harness || "claude", streaming: false, disabled: false, caption: "", ...piModelState() };
  if (t.kind === "none") { st.caption = "Pick a chat"; st.disabled = true; }
  else if (t.kind === "owned-pi") { st.streaming = t.streaming; st.caption = t.streaming ? "Omni's pi is working · a message steers it, empty send stops it" : "Omni's pi"; }
  else if (t.kind === "owned-claude-running") { st.streaming = true; st.caption = "Claude Code is working · send to stop"; }
  else {
    const fork = S.forceFork || t.live;
    const who = t.s.harness === "claude" ? "Claude Code" : "pi";
    st.caption = fork ? `Forks ${t.live ? "the running " : "this "}${who} chat into Omni` : `Continues this ${who} chat${t.s.harness === "pi" ? " in Omni's pi" : ""}`;
  }
  chat.setState(st);
}
async function chatSend(text, o) {
  const t = target();
  try {
    if (t.kind === "owned-pi") { await api("/api/pi/prompt", { message: text, memory: o.memory, graph: o.graph }); chat.clear(); return; }
    if (t.kind === "owned-claude-running") { await chatStop(); return; }
    if (t.kind === "none") return;
    chat.setState({ disabled: true, caption: "Starting…" });
    const r = await api(`/api/sessions/${encodeURIComponent(t.s.sid)}/continue`, { message: text, memory: o.memory, graph: o.graph, model: o.model, autonomous: o.autonomous, fork: S.forceFork });
    chat.clear();
    S.forceFork = false;
    if (r.pending) { S.followFork = r.forkedFrom; toast("Forking the chat… Omni will switch to the new session as soon as Claude Code reports it."); }
    else if (r.sid !== S.selected) { if (r.forked) toast("Forked into a new pi session"); selectSession(r.sid); }
  } catch (e) { toast(e.message, true); }
  finally { updateComposer(); }
}
async function chatStop() {
  const t = target();
  try {
    if (t.kind === "owned-pi") await api("/api/pi/abort", {});
    else if (t.kind === "owned-claude-running") await api("/api/claude/abort", { sid: t.s.sid });
  } catch (e) { toast(e.message, true); }
}
async function selectSession(sid) {
  if (S.view) finish(S.view);
  S.selected = sid;
  S.forceFork = false;
  sidebar.render();
  const s0 = S.sessions.get(sid);
  const view = newView($("#transcript"), $("#transcriptWrap"), sid, { cwd: s0?.cwd });
  S.view = view;
  updateHeader(); updateComposer(); panel.resetFiles();
  try {
    const h = await api(`/api/sessions/${encodeURIComponent(sid)}/history`);
    if (S.selected !== sid) return;
    if (h.session) S.sessions.set(sid, { ...(S.sessions.get(sid) || {}), ...h.session, tally: h.tally || S.sessions.get(sid)?.tally });
    const s = S.sessions.get(sid);
    view.cwd = s?.cwd || view.cwd;
    for (const ev of h.events) applyEvent(view, ev);
    for (const ev of S.buffers.get(sid) || []) if (ev.ts > view.lastTs || ev.kind === "delta" || ev.kind === "block") applyEvent(view, ev);
    if (!s?.streaming) finish(view);
    if (s?.forkedFrom) forkNote(view, { fromTitle: S.sessions.get(s.forkedFrom)?.title, onOpen: () => { selectSession(s.forkedFrom); } });
    $("#transcriptWrap").scrollTop = $("#transcriptWrap").scrollHeight;
    if (!h.events.length) emptyNote(view, "nothing here yet");
  } catch (e) { toast(`Could not load history: ${e.message}`, true); }
  updateHeader(); updateComposer();
  if (document.body.classList.contains("panel-open")) panel.renderStats();
}
function updateHeader() {
  const s = S.sessions.get(S.selected);
  updateTitle();
  $("#topModel").textContent = s?.model || S.pi.state?.model?.id || "";
  $("#topModel").title = s ? `${s.harness} · ${s.cwd || ""}` : "";
}
function renderChatMenu() {
  const m = $("#chatMenu"); m.innerHTML = "";
  const s = S.sessions.get(S.selected); if (!s) return;
  const item = (label, fn, on) => { const b = el("button", on ? "on" : "", label); b.onclick = () => { m.hidden = true; fn(); }; m.appendChild(b); };
  item("Fork into a new chat with the next message", () => { S.forceFork = !S.forceFork; updateComposer(); chat.focus(); }, S.forceFork);
  item("Digest this chat to the vault", async () => { try { const r = await api("/api/memory/digest", { sid: s.sid }); toast(`Digest written: ${r.path}`); } catch (e) { toast(e.message, true); } });
  item("Copy session id", () => navigator.clipboard?.writeText(s.sid.split(":").slice(1).join(":")).then(() => toast("Session id copied")).catch(() => {}));
  item("Tokens for this chat", () => panel.open("tokens"));
  if (s.forkedFrom) item("Open the original chat", () => selectSession(s.forkedFrom));
  m.appendChild(el("div", "mh", `${s.harness} · ${s.cwd || ""}`));
}
$("#btnChatMenu").onclick = (e) => { e.stopPropagation(); const m = $("#chatMenu"); if (m.hidden) renderChatMenu(); m.hidden = !m.hidden; };
document.addEventListener("click", (e) => { if (!e.target.closest("#chatMenu, #btnChatMenu")) $("#chatMenu").hidden = true; });
$("#homeCwd").addEventListener("change", () => { panel.resetFiles(); renderHome(); });

// ------------------------------------------------------------------ SSE
function connect() {
  const es = new EventSource(`/events?since=${S.seq}`);
  es.onmessage = (m) => { let ev; try { ev = JSON.parse(m.data); } catch { return; } handle(ev); };
  es.onerror = () => { $("#piStatus").textContent = "reconnecting"; es.close(); setTimeout(connect, 1500); };
}
let railTimer = null;
function handle(ev) {
  S.seq = Math.max(S.seq, ev.seq || 0);
  if (ev.kind === "log") { if (ev.level === "system") toast(ev.text); else if (ev.level === "graphify" && ev.text) panel.graphLine(ev.text.split("\n").pop()); return; }
  const s = S.sessions.get(ev.sid) || { sid: ev.sid, harness: ev.harness, lastActivity: 0, tally: null };
  if (ev.kind === "session") Object.assign(s, Object.fromEntries(Object.entries({ cwd: ev.cwd, title: ev.title, model: ev.model, file: ev.file, owned: ev.owned, forkedFrom: ev.forkedFrom }).filter(([, v]) => v != null)));
  if (ev.kind === "status") s.streaming = !!ev.streaming;
  if (ev.kind === "msg" && ev.role === "user" && !s.title) s.title = (ev.blocks?.[0]?.text || "").replace(/\s+/g, " ").slice(0, 80);
  if (ev.kind === "msg" && ev.usage) { const t = s.tally || (s.tally = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, messages: 0, cost: 0, context: 0 }); if (!ev.groupId || t.lastGroup !== ev.groupId) { t.lastGroup = ev.groupId; t.input += ev.usage.input; t.output += ev.usage.output; t.cacheRead += ev.usage.cacheRead; t.cacheWrite += ev.usage.cacheWrite; t.total += ev.usage.total; t.messages++; t.context = ev.usage.input + ev.usage.cacheRead + ev.usage.cacheWrite; t.cost += ev.cost || 0; } }
  if (ev.kind !== "session") s.lastActivity = Math.max(s.lastActivity || 0, ev.ts || 0);
  if (ev.kind === "digest") toast(`Digest saved: ${ev.path}`);
  S.sessions.set(ev.sid, s);
  if (ev.harness === "pi" && s.owned) {
    S.pi.running = true;
    if (ev.kind === "session") { if (ev.cwd) S.pi.cwd = ev.cwd; if (ev.sessionId) S.pi.sid = ev.sid; if (ev.model) S.pi.state = { ...(S.pi.state || {}), model: { ...(S.pi.state?.model || {}), id: ev.model, provider: ev.provider || S.pi.state?.model?.provider }, thinkingLevel: ev.thinkingLevel || S.pi.state?.thinkingLevel }; loadPiChoices(); }
    $("#piStatus").textContent = `pi: ${s.model || "ready"}${s.streaming ? " · working" : ""}`; $("#piStatus").classList.toggle("on", !!s.streaming);
  }
  if (ev.kind === "run" && ev.harness === "claude") { const r = S.runs.find((x) => x.sid === ev.sid); if (r) r.alive = false; }
  if (ev.kind === "session" && ev.harness === "claude" && ev.owned && !S.runs.some((r) => r.sid === ev.sid)) S.runs.push({ sid: ev.sid, alive: true });
  if (ev.kind === "status" && ev.harness === "claude") { const r = S.runs.find((x) => x.sid === ev.sid); if (r) r.alive = !!ev.streaming; }
  const buf = S.buffers.get(ev.sid) || []; buf.push(ev); if (buf.length > 800) buf.splice(0, buf.length - 800); S.buffers.set(ev.sid, buf);
  if (ev.kind === "session" && ev.forkedFrom && S.followFork && ev.forkedFrom === S.followFork) { S.followFork = null; selectSession(ev.sid); showView("chat"); }
  if (ev.sid === S.selected && S.view) { applyEvent(S.view, ev); if ((ev.kind === "msg" || ev.kind === "run") && document.body.classList.contains("panel-open")) panel.renderStats(); if (ev.kind === "status" || ev.kind === "session") { updateHeader(); updateComposer(); } }
  if (!railTimer) railTimer = setTimeout(() => { railTimer = null; sidebar.render(); if (S.page === "home") renderHome(); else updateComposer(); }, 250);
}

// ----------------------------------------------------------------- init
async function init() {
  if (S.desktop) document.body.classList.add("desktop");
  const st = await api("/api/state");
  S.config = st.config; S.pi = st.pi; S.runs = st.runs || [];
  for (const s of st.sessions) S.sessions.set(s.sid, s);
  $("#piStatus").textContent = st.pi?.running ? `pi: ${st.pi.state?.model?.id || "ready"}` : "pi: off";
  if (st.config?.lanUrls?.length) { $("#lanInfo").textContent = st.config.lanUrls[0].replace(/\?token=.*/, ""); $("#lanInfo").title = "Open this on another device on your network; the first visit needs the token link from omni.config.json"; }
  await Promise.all([panel.loadMemory(""), panel.loadGraphList(), loadPiChoices()]);
  sidebar.render();
  showView("home");
  connect();
  setInterval(() => { sidebar.render(); if (S.page === "chat") updateComposer(); }, 15000);
}
init().catch((e) => toast(`Omni Agent failed to start: ${e.message}`, true));
