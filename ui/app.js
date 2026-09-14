/* Omni Agent front end. Home (one container) → Chat (explorer | preview | transcript). Right drawer: Chats / Memory / Graph / Tokens. pi only. */
import { el, baseName, cleanTitle } from "./lib.js";
import { newView, applyEvent, finish, forkNote, emptyNote } from "./transcript.js";
import { createComposer } from "./composer.js";
import { createHistory } from "./sidebar.js";
import { createPanel } from "./panel.js";
import { createExplorer } from "./explorer.js";
import { createSettings } from "./settings.js";
import { initResizers } from "./resizer.js";

const $ = (s) => document.querySelector(s);
const S = { sessions: new Map(), selected: null, pi: { running: false }, runs: [], seq: 0, buffers: new Map(), view: null, page: "home", config: null, followFork: null, forceFork: false, desktop: new URLSearchParams(location.search).get("desktop") === "1" };
const liveWindowMs = () => S.config?.liveWindowMs || 30000;
/** Events replayed by the SSE stream at connect time predate this; their system toasts are stale. */
const BOOT_TS = Date.now();

async function api(path, body, method) {
  const r = await fetch(path, body || (method && method !== "GET") ? { method: method || "POST", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined } : { method: "GET" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error || `${r.status}`);
  return j;
}
function toast(text, err) { const t = el("div", `toast${err ? " err" : ""}`, text); $("#toasts").appendChild(t); setTimeout(() => t.remove(), err ? 7000 : 3500); }
const homeCwd = () => $("#homeCwd").value.trim() || S.config?.cwd || "";
const currentDir = () => (S.page === "chat" && S.sessions.get(S.selected)?.cwd) || homeCwd() || null;

async function deleteChat(sid) {
  const s = S.sessions.get(sid);
  const name = s?.title ? `“${s.title.slice(0, 40)}”` : "this chat";
  if (!window.confirm(`Delete ${name}?\nIt moves to the Omni trash folder and disappears here.`)) return;
  try {
    await api(`/api/sessions/${encodeURIComponent(sid)}`, null, "DELETE");
    S.sessions.delete(sid); S.buffers.delete(sid);
    if (S.selected === sid) { S.selected = null; S.view = null; showView("home"); }
    history.render();
    toast("Chat deleted");
  } catch (e) { toast(e.message, true); }
}

// ------------------------------------------------------------- modules
const openChat = (sid) => { selectSession(sid); showView("chat"); if (window.innerWidth < 1100) panel.setOpen(false); };
const history = createHistory({ S, onSelect: openChat, onNew: () => { showView("home"); home.focus(); }, onDelete: deleteChat });
const panel = createPanel({ S, api, toast, onSelect: openChat, currentDir, getPiContextWindow: () => S.pi.state?.model?.contextWindow, onShowChats: () => history.render() });
const explorer = createExplorer({ api, toast, insert: (t) => (S.page === "chat" ? chat : home).insert(t), onClose: () => setExplorer(false, S.page === "chat") });
const settings = createSettings({ api, toast, onChanged: () => { loadPiChoices(); refreshState(); } });
const composerHooks = { onPickFile: () => { explorer.setRoot(currentDir()); setExplorer(true); }, onPiModel: setPiModel, onPiThinking: setPiThinking, onManageProviders: () => settings.open() };
const home = createComposer($("#homeComposer"), { ...composerHooks, onSend: homeSend });
const chat = createComposer($("#chatComposer"), { ...composerHooks, onSend: chatSend, onStop: chatStop });

async function setPiModel(provider, id) {
  try { await api("/api/pi/model", { provider, modelId: id }); toast(`pi model: ${id}`); }
  catch (e) { toast(S.pi.running ? e.message : "pi is not running yet: send a message first, then pick the model", true); }
}
async function setPiThinking(level) { try { await api("/api/pi/thinking", { level }); } catch (e) { toast(e.message, true); } }
async function loadPiChoices() {
  const [m, l] = await Promise.allSettled([api("/api/pi/models"), api("/api/pi/thinking-levels")]);
  const choices = {};
  const models = m.status === "fulfilled" ? (m.value.data?.models || []) : [];
  const levels = l.status === "fulfilled" ? (l.value.data?.levels || []) : [];
  if (m.status === "fulfilled") choices.models = models;
  if (levels.length) choices.levels = levels;
  if (Object.keys(choices).length) { home.setPiChoices(choices); chat.setPiChoices(choices); }
}
function piModelState() { const mdl = S.pi.state?.model; return { piModel: mdl ? { provider: mdl.provider, id: mdl.id } : null, piThinking: S.pi.state?.thinkingLevel || "" }; }
async function refreshState() { try { const st = await api("/api/state"); S.pi = st.pi; S.runs = st.runs || []; updateHeader(); if (S.page === "home") renderHome(); else updateComposer(); } catch { /* transient */ } }

// --------------------------------------------------------------- views
/** `persist` only for a deliberate toggle; leaving the chat view must not remember "closed". */
function setExplorer(open, persist = false) { document.body.classList.toggle("explorer-open", open); if (!open) explorer.closePreview(); if (persist) { try { localStorage.setItem("omni.explorer", open ? "1" : "0"); } catch { /* */ } } }
function explorerPreferred() { try { return localStorage.getItem("omni.explorer") !== "0"; } catch { return true; } }
function showView(name) {
  S.page = name;
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${name}`));
  $("#btnChatMenu").hidden = name !== "chat";
  $("#btnExplorer").hidden = name !== "chat";
  document.body.classList.toggle("in-chat", name === "chat");
  if (name === "home") { setExplorer(false); renderHome(); home.focus(); }
  if (name === "chat") { explorer.setRoot(currentDir()); setExplorer(window.innerWidth >= 900 && explorerPreferred()); updateHeader(); updateComposer(); }
  updateTitle();
}
function updateTitle() {
  const s = S.sessions.get(S.selected);
  const title = S.page === "chat" && s?.title ? s.title : "";
  $("#topTitle").textContent = title;
  document.title = title ? `${title} · Omni Agent` : "Omni Agent";
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
  for (const d of recentDirs()) { const c = el("button", `chip${d === cwdInput.value ? " active" : ""}`, baseName(d) || d); c.title = d; c.onclick = () => { cwdInput.value = d; browseHome(); renderHome(); }; chips.appendChild(c); }
  home.setState({ ...piModelState(), caption: S.pi.running ? `pi in ${baseName(S.pi.cwd || "")}` : "" });
  updateHeader();
}
async function homeSend(text, o) {
  const cwd = homeCwd();
  if (!cwd) return toast("Set a working directory first", true);
  home.setState({ disabled: true, caption: "Starting pi…" });
  try {
    if (!S.pi.running || (S.pi.cwd || "").toLowerCase() !== cwd.toLowerCase()) await api("/api/pi/start", { cwd }); else await api("/api/pi/new", {});
    const st = await api("/api/state");
    S.pi = st.pi;
    if (!st.pi.sid) throw new Error("pi did not report a session");
    S.sessions.set(st.pi.sid, { ...(S.sessions.get(st.pi.sid) || {}), sid: st.pi.sid, harness: "pi", owned: true, cwd, model: st.pi.state?.model?.id, title: text.replace(/\s+/g, " ").slice(0, 80), lastActivity: Date.now(), streaming: true });
    openChat(st.pi.sid);
    await api("/api/pi/prompt", { message: text, memory: o.memory, graph: o.graph });
    home.clear();
  } catch (e) { toast(e.message, true); }
  finally { home.setState({ disabled: false, caption: "" }); }
}
/** Picking a folder on Home shows its tree at once; no need to start a chat first. */
function browseHome() { explorer.setRoot(homeCwd()); setExplorer(true); }
$("#homeCwd").addEventListener("change", () => { browseHome(); renderHome(); });
$("#homeCwd").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); browseHome(); renderHome(); } });
$("#homeBrowse").onclick = () => { if (document.body.classList.contains("explorer-open")) setExplorer(false); else browseHome(); };
$("#brand").onclick = () => showView("home");

// ---------------------------------------------------------------- chat
function target() {
  const s = S.sessions.get(S.selected);
  if (!s) return { kind: "none" };
  if (s.harness === "claude") return { kind: "claude", s };
  if (s.owned && S.pi.running && S.pi.sid === s.sid) return { kind: "owned-pi", s, streaming: !!s.streaming };
  const live = !s.owned && (s.streaming || Date.now() - Math.max(s.lastActivity || 0, s.mtime || 0) < liveWindowMs());
  return { kind: "continue", s, live };
}
function updateComposer() {
  const t = target();
  const st = { streaming: false, disabled: false, caption: "", ...piModelState() };
  if (t.kind === "none") { st.caption = "Pick a chat"; st.disabled = true; }
  else if (t.kind === "claude") { st.caption = "Claude Code chat · view only in Omni"; st.disabled = true; }
  else if (t.kind === "owned-pi") { st.streaming = t.streaming; st.caption = t.streaming ? "pi is working · a message steers it, empty send stops it" : "Omni's pi"; }
  else {
    const fork = S.forceFork || t.live;
    st.caption = fork ? `Forks ${t.live ? "the running " : "this "}pi chat into Omni` : "Continues this chat in Omni's pi";
  }
  chat.setState(st);
}
async function chatSend(text, o) {
  const t = target();
  try {
    if (t.kind === "owned-pi") { await api("/api/pi/prompt", { message: text, memory: o.memory, graph: o.graph }); chat.clear(); return; }
    if (t.kind !== "continue") return;
    chat.setState({ disabled: true, caption: "Starting…" });
    const r = await api(`/api/sessions/${encodeURIComponent(t.s.sid)}/continue`, { message: text, memory: o.memory, graph: o.graph, fork: S.forceFork });
    chat.clear();
    S.forceFork = false;
    if (r.sid !== S.selected) { if (r.forked) toast("Forked into a new pi session"); selectSession(r.sid); }
  } catch (e) { toast(e.message, true); }
  finally { updateComposer(); }
}
async function chatStop() {
  const t = target();
  try { if (t.kind === "owned-pi") await api("/api/pi/abort", {}); } catch (e) { toast(e.message, true); }
}
async function selectSession(sid) {
  if (S.view) finish(S.view);
  S.selected = sid;
  S.forceFork = false;
  history.render();
  const s0 = S.sessions.get(sid);
  const view = newView($("#transcript"), $("#transcriptWrap"), sid, { cwd: s0?.cwd });
  S.view = view;
  updateHeader(); updateComposer();
  if (s0?.cwd) explorer.setRoot(s0.cwd);
  try {
    const fetchedAt = Date.now();
    const h = await api(`/api/sessions/${encodeURIComponent(sid)}/history`);
    if (S.selected !== sid) return;
    if (h.session) S.sessions.set(sid, { ...(S.sessions.get(sid) || {}), ...h.session, tally: h.tally || S.sessions.get(sid)?.tally });
    const s = S.sessions.get(sid);
    view.cwd = s?.cwd || view.cwd;
    if (s?.cwd) explorer.setRoot(s.cwd);
    const seen = new Set();
    for (const ev of h.events) { applyEvent(view, ev); if (ev.kind === "msg" && ev.id) seen.add(ev.id); }
    // Live events buffered while the chat was open elsewhere: skip messages the file already gave us.
    // Anything older than the fetch is already in the file. The one exception: a turn still streaming has
    // partial text that is not written yet, so its stream parts (newer than the last file message) are replayed.
    const streaming = !!s?.streaming;
    for (const ev of S.buffers.get(sid) || []) {
      if (ev.kind === "msg" && ev.id && seen.has(ev.id)) continue;
      if (ev.ts > fetchedAt) applyEvent(view, ev);
      else if (streaming && (ev.kind === "delta" || ev.kind === "block") && ev.ts > view.lastTs) applyEvent(view, ev);
    }
    if (!s?.streaming) finish(view);
    if (s?.forkedFrom) forkNote(view, { fromTitle: S.sessions.get(s.forkedFrom)?.title, onOpen: () => { selectSession(s.forkedFrom); } });
    $("#transcriptWrap").scrollTop = $("#transcriptWrap").scrollHeight;
    if (!h.events.length) emptyNote(view, "nothing here yet");
  } catch (e) { toast(`Could not load history: ${e.message}`, true); }
  updateHeader(); updateComposer();
  if (document.body.classList.contains("panel-open")) panel.renderStats();
}
function updateHeader() {
  const s = S.page === "chat" ? S.sessions.get(S.selected) : null;
  updateTitle();
  const model = s?.model || S.pi.state?.model?.id || "";
  $("#topModel").textContent = model;
  $("#topModel").hidden = !model;
  $("#topModel").title = s ? `${s.harness} · ${s.cwd || ""}` : S.pi.cwd || "";
  const ps = $("#piStatus");
  ps.textContent = S.pi.running ? `pi${S.pi.streaming ? " · working" : ""}` : "pi: off";
  ps.classList.toggle("on", !!S.pi.running && !!S.pi.streaming);
  ps.classList.toggle("off", !S.pi.running);
}
function renderChatMenu() {
  const m = $("#chatMenu"); m.innerHTML = "";
  const s = S.sessions.get(S.selected); if (!s) return;
  const item = (label, fn, on) => { const b = el("button", on ? "on" : "", label); b.onclick = () => { m.hidden = true; fn(); }; m.appendChild(b); };
  if (s.harness === "pi") item("Fork into a new chat with the next message", () => { S.forceFork = !S.forceFork; updateComposer(); chat.focus(); }, S.forceFork);
  item("Digest this chat to the vault", async () => { try { const r = await api("/api/memory/digest", { sid: s.sid }); toast(`Digest written: ${r.path}`); } catch (e) { toast(e.message, true); } });
  item("Copy session id", () => navigator.clipboard?.writeText(s.sid.split(":").slice(1).join(":")).then(() => toast("Session id copied")).catch(() => {}));
  item("Tokens for this chat", () => panel.open("tokens"));
  if (s.forkedFrom) item("Open the original chat", () => selectSession(s.forkedFrom));
  item("Delete this chat", () => deleteChat(s.sid));
  m.appendChild(el("div", "mh", `${s.harness} · ${s.cwd || ""}`));
}
$("#btnChatMenu").onclick = (e) => { e.stopPropagation(); const m = $("#chatMenu"); if (m.hidden) renderChatMenu(); m.hidden = !m.hidden; };
document.addEventListener("click", (e) => { if (!e.target.closest("#chatMenu, #btnChatMenu")) $("#chatMenu").hidden = true; });
$("#btnExplorer").onclick = () => { explorer.setRoot(currentDir()); setExplorer(!document.body.classList.contains("explorer-open"), true); };
$("#btnSettings").onclick = () => settings.open();

// ------------------------------------------------------------------ SSE
function connect() {
  const es = new EventSource(`/events?since=${S.seq}`);
  es.onmessage = (m) => { let ev; try { ev = JSON.parse(m.data); } catch { return; } handle(ev); };
  es.onerror = () => { $("#piStatus").textContent = "reconnecting"; es.close(); setTimeout(connect, 1500); };
}
let railTimer = null;
function handle(ev) {
  S.seq = Math.max(S.seq, ev.seq || 0);
  if (ev.kind === "removed") { S.sessions.delete(ev.sid); S.buffers.delete(ev.sid); if (S.selected === ev.sid) { S.selected = null; S.view = null; showView("home"); } history.render(); return; }
  if (ev.kind === "log") { if (ev.level === "system" && (ev.ts || 0) >= BOOT_TS) toast(ev.text); else if (ev.level === "graphify" && ev.text) panel.graphLine(ev.text.split("\n").pop()); return; }
  const s = S.sessions.get(ev.sid) || { sid: ev.sid, harness: ev.harness, lastActivity: 0, tally: null };
  if (ev.kind === "session") Object.assign(s, Object.fromEntries(Object.entries({ cwd: ev.cwd, title: ev.title ? cleanTitle(ev.title) || undefined : undefined, model: ev.model, file: ev.file, owned: ev.owned, forkedFrom: ev.forkedFrom }).filter(([, v]) => v != null)));
  if (ev.kind === "status") s.streaming = !!ev.streaming;
  if (ev.kind === "msg" && ev.role === "user" && !s.title) s.title = cleanTitle(ev.blocks?.[0]?.text || "");
  if (ev.kind === "msg" && ev.usage) { const t = s.tally || (s.tally = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, messages: 0, cost: 0, context: 0 }); if (!ev.groupId || t.lastGroup !== ev.groupId) { t.lastGroup = ev.groupId; t.input += ev.usage.input; t.output += ev.usage.output; t.cacheRead += ev.usage.cacheRead; t.cacheWrite += ev.usage.cacheWrite; t.total += ev.usage.total; t.messages++; t.context = ev.usage.input + ev.usage.cacheRead + ev.usage.cacheWrite; t.cost += ev.cost || 0; } }
  if (ev.kind !== "session") s.lastActivity = Math.max(s.lastActivity || 0, ev.ts || 0);
  if (ev.kind === "digest") toast(`Digest saved: ${ev.path}`);
  S.sessions.set(ev.sid, s);
  if (ev.harness === "pi" && s.owned) {
    S.pi.running = true;
    if (ev.kind === "status") S.pi.streaming = !!ev.streaming;
    if (ev.kind === "session") { if (ev.cwd) S.pi.cwd = ev.cwd; if (ev.sessionId) S.pi.sid = ev.sid; if (ev.model) S.pi.state = { ...(S.pi.state || {}), model: { ...(S.pi.state?.model || {}), id: ev.model, provider: ev.provider || S.pi.state?.model?.provider }, thinkingLevel: ev.thinkingLevel || S.pi.state?.thinkingLevel }; loadPiChoices(); }
    updateHeader();
  }
  const buf = S.buffers.get(ev.sid) || []; buf.push(ev); if (buf.length > 800) buf.splice(0, buf.length - 800); S.buffers.set(ev.sid, buf);
  if (ev.kind === "session" && ev.forkedFrom && S.followFork && ev.forkedFrom === S.followFork) { S.followFork = null; openChat(ev.sid); }
  if (ev.sid === S.selected && S.view) { applyEvent(S.view, ev); if ((ev.kind === "msg" || ev.kind === "run") && document.body.classList.contains("panel-open")) panel.renderStats(); if (ev.kind === "status" || ev.kind === "session") { updateHeader(); updateComposer(); } }
  if (!railTimer) railTimer = setTimeout(() => { railTimer = null; if (document.body.classList.contains("panel-open")) history.render(); if (S.page === "home") renderHome(); else updateComposer(); }, 250);
}

// ----------------------------------------------------------------- init
async function init() {
  if (S.desktop) document.body.classList.add("desktop");
  initResizers();
  const st = await api("/api/state");
  S.config = st.config; S.pi = st.pi; S.runs = st.runs || [];
  for (const s of st.sessions) S.sessions.set(s.sid, s);
  if (st.config?.lanUrls?.length) { $("#lanInfo").textContent = st.config.lanUrls[0].replace(/\?token=.*/, ""); $("#lanInfo").title = "Open this on any device on your network; no login needed"; }
  await Promise.all([panel.loadMemory(""), panel.loadGraphList(), loadPiChoices()]);
  history.render();
  showView("home");
  connect();
  setInterval(() => { if (document.body.classList.contains("panel-open")) history.render(); if (S.page === "chat") updateComposer(); }, 15000);
}
init().catch((e) => toast(`Omni Agent failed to start: ${e.message}`, true));
