/* Omni Agent front end. Home (one container) → Chat (explorer | preview | transcript). Right drawer: Chats / Memory / Graph / Tokens. pi only. */
import { el, baseName, cleanTitle } from "./lib.js";
import { newView, applyEvent, finish, forkNote, emptyNote } from "./transcript.js";
import { createComposer } from "./composer.js";
import { createHistory } from "./sidebar.js";
import { createPanel } from "./panel.js";
import { createExplorer } from "./explorer.js";
import { createSettings } from "./settings.js";
import { initResizers } from "./resizer.js";
import { asPlan, planProgress, PLAN_TOOL } from "./plan.js";

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
const composerHooks = { onPickFile: () => { explorer.setRoot(currentDir()); setExplorer(true); }, onPiModel: setPiModel, onPiThinking: setPiThinking, onManageProviders: () => settings.open(), onHook: setHook };
const home = createComposer($("#homeComposer"), { ...composerHooks, onSend: homeSend });
const chat = createComposer($("#chatComposer"), { ...composerHooks, onSend: chatSend, onStop: chatStop });

/** Choices made before pi runs are saved on the server and applied when it starts, so the picker never "forgets". */
async function setPiModel(provider, id) {
  try {
    const r = await api("/api/pi/model", { provider, modelId: id });
    S.config = { ...(S.config || {}), piProvider: provider, piModel: id };
    toast(r.pending ? `pi model: ${id} (applies when pi starts)` : `pi model: ${id}`);
    if (S.page === "home") renderHome(); else updateComposer();
  } catch (e) { toast(e.message, true); }
}
async function setPiThinking(level) {
  try {
    await api("/api/pi/thinking", { level });
    S.config = { ...(S.config || {}), piThinking: level };
    if (S.page === "home") renderHome(); else updateComposer();
  } catch (e) { toast(e.message, true); }
}
async function loadPiChoices() {
  const [m, l] = await Promise.allSettled([api("/api/pi/models"), api("/api/pi/thinking-levels")]);
  const choices = {};
  const models = m.status === "fulfilled" ? (m.value.data?.models || []) : [];
  const levels = l.status === "fulfilled" ? (l.value.data?.levels || []) : [];
  if (m.status === "fulfilled") choices.models = models;
  if (levels.length) choices.levels = levels;
  if (Object.keys(choices).length) { home.setPiChoices(choices); chat.setPiChoices(choices); }
}
/** What the picker shows: pi's live state when it runs, else the saved choice the next pi child will start with. */
function piModelState() {
  const mdl = S.pi.running ? S.pi.state?.model : null;
  const c = S.config || {};
  const piModel = mdl ? { provider: mdl.provider, id: mdl.id } : c.piModel ? { provider: c.piProvider, id: c.piModel } : null;
  const piThinking = (S.pi.running ? S.pi.state?.thinkingLevel : "") || c.piThinking || "";
  return { piModel, piThinking, hook: S.hook };
}
async function refreshState() { try { const st = await api("/api/state"); S.pi = st.pi; S.runs = st.runs || []; S.hook = st.hook || S.hook; if (st.config) S.config = st.config; updateHeader(); if (S.page === "home") renderHome(); else updateComposer(); } catch { /* transient */ } }
/** Goal hook settings live in omni.config.json through the server; the menu reflects the saved state. */
async function setHook(patch) {
  try {
    const r = await api("/api/hook", patch, "PUT");
    S.hook = r.hook;
    toast(patch.enabled === true ? "Goal hook on: pi is re-engaged until its plan is finished" : patch.enabled === false ? "Goal hook off" : `Status box model: ${r.hook.model || "same as the chat"}`);
    if (S.page === "home") renderHome(); else updateComposer();
  } catch (e) { toast(e.message, true); }
}

// --------------------------------------------------------------- views
/** `persist` only for a deliberate toggle; leaving the chat view must not remember "closed". */
function setExplorer(open, persist = false) { document.body.classList.toggle("explorer-open", open); if (!open) explorer.closePreview(); if (persist) { try { localStorage.setItem("omni.explorer", open ? "1" : "0"); } catch { /* */ } } }
function explorerPreferred() { try { return localStorage.getItem("omni.explorer") !== "0"; } catch { return true; } }
// The goal box pinned above a chat: the goal, the agent's plan (live from `plan` events, so it is always
// current with no model call) and the status written by the separate summarizer at each milestone.
function summaryOn() { try { return localStorage.getItem("omni.summary") !== "off"; } catch { return true; } }
function planOpen() { try { return localStorage.getItem("omni.planOpen") === "1"; } catch { return false; } }
const goalBox = (s) => s.goalBox || (s.goalBox = { goal: "", plan: null, summary: "", summaryAt: 0, nudges: 0, done: false });
/** The newest plan in a history replay (the plan tool's results carry it). */
function planFromEvents(events) {
  let plan = null;
  for (const ev of events) if (ev.kind === "msg" && ev.role === "tool") for (const b of ev.blocks || []) if (b.name === PLAN_TOOL && b.details?.plan) plan = asPlan(b.details) || plan;
  return plan;
}
const STEP_MARK = { done: "✓", skipped: "–", active: "›", pending: "" };
function renderSummary() {
  const box = $("#summaryBox"), btn = $("#btnSummary");
  const s = S.selected ? S.sessions.get(S.selected) : null;
  const gb = s?.goalBox;
  const plan = gb?.plan && (gb.plan.brainstorm || gb.plan.milestones?.length) ? gb.plan : null;
  // A quick question gets no box: only a plan, a written status or an explicit /goal shows one.
  const have = S.page === "chat" && !!gb && !!(gb.summary || plan || (gb.goal && gb.explicit));
  if (btn) { btn.hidden = !have; btn.classList.toggle("on", have && summaryOn()); }
  if (!box) return;
  if (!have || !summaryOn()) { box.hidden = true; return; }
  box.hidden = false;
  box.textContent = "";
  const pr = plan ? planProgress(plan) : null;
  const head = el("div", "summary-head");
  head.appendChild(el("span", "summary-tag", gb.goal ? "Goal" : "Plan"));
  head.appendChild(el("span", "summary-goal", gb.goal || (plan?.brainstorm?.understanding ?? "")));
  const phase = !pr ? "" : pr.complete ? "complete" : pr.phase === "execute" ? `${pr.done + pr.skipped}/${pr.steps} steps` : pr.phase === "plan" ? "planning" : pr.phase === "waiting" ? "waiting for you" : "brainstorming";
  const at = gb.summaryAt || plan?.updatedAt;
  const meta = [gb.done ? "done" : phase, gb.nudges ? `re-engaged ${gb.nudges}×` : "", at ? `updated ${new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""].filter(Boolean).join(" · ");
  if (meta) head.appendChild(el("span", "summary-nudges", meta));
  if (plan?.milestones?.length) {
    const t = el("button", `summary-toggle${planOpen() ? " open" : ""}`, planOpen() ? "Hide plan" : "Show plan");
    t.onclick = () => { try { localStorage.setItem("omni.planOpen", planOpen() ? "0" : "1"); } catch { /* */ } renderSummary(); };
    head.appendChild(t);
  }
  const x = el("button", "summary-x", "×");
  x.title = "Hide the goal box (toggle it from the header)";
  x.onclick = () => { try { localStorage.setItem("omni.summary", "off"); } catch { /* */ } renderSummary(); };
  head.appendChild(x);
  box.appendChild(head);
  if (plan?.milestones?.length) {
    // One segment per milestone, as wide as its share of the steps, filled by its finished steps.
    const bar = el("div", "plan-bar");
    for (const m of plan.milestones) {
      const fin = m.steps.filter((st) => st.status === "done" || st.status === "skipped").length;
      const seg = el("div", `plan-seg${fin === m.steps.length ? " full" : ""}`);
      seg.style.flex = String(m.steps.length);
      seg.title = `Milestone ${m.id}: ${m.title} (${fin}/${m.steps.length})`;
      const fill = el("div", "plan-fill"); fill.style.width = `${Math.round((fin / m.steps.length) * 100)}%`;
      seg.appendChild(fill); bar.appendChild(seg);
    }
    box.appendChild(bar);
  }
  if (pr?.waiting) box.appendChild(el("div", "plan-now waiting", `Waiting for you: ${pr.waiting.question}`));
  else if (pr?.current && !pr.complete) {
    const now = el("div", "plan-now");
    now.append(el("span", "plan-now-k", pr.currentMilestone ? `Milestone ${pr.currentMilestone.id} · ${pr.current.id}` : pr.current.id), el("span", "plan-now-t", pr.current.title));
    if (pr.current.doneWhen) now.appendChild(el("span", "plan-now-c", `done when ${pr.current.doneWhen}`));
    box.appendChild(now);
  } else if (pr?.phase === "plan") box.appendChild(el("div", "plan-now", `Approach: ${plan.brainstorm?.chosen || ""}. Writing the plan…`));
  if (gb.summary) box.appendChild(el("div", "summary-body", gb.summary));
  else if (!plan) box.appendChild(el("div", "summary-body", "No plan yet. The status is written when the agent plans the work and at each milestone."));
  if (plan?.milestones?.length && planOpen()) {
    const ol = el("div", "plan-list");
    for (const m of plan.milestones) {
      const fin = m.steps.every((st) => st.status === "done" || st.status === "skipped");
      ol.appendChild(el("div", `plan-m${fin ? " fin" : ""}`, `${m.id}. ${m.title}`));
      for (const st of m.steps) {
        const row = el("div", `plan-step ${st.status}`);
        row.append(el("span", "plan-mark", STEP_MARK[st.status] || ""), el("span", "plan-sid", st.id), el("span", "plan-st", st.title));
        row.title = st.status === "done" ? `evidence: ${st.evidence}` : st.status === "skipped" ? `skipped: ${st.note}` : `done when: ${st.doneWhen}`;
        ol.appendChild(row);
      }
    }
    box.appendChild(ol);
  }
}
function showView(name) {
  S.page = name;
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${name}`));
  $("#btnChatMenu").hidden = name !== "chat";
  $("#btnExplorer").hidden = name !== "chat";
  document.body.classList.toggle("in-chat", name === "chat");
  // Both composers share the remembered attachment choices (memory / repo graph).
  if (name === "home") { setExplorer(false); home.reloadOptions(); renderHome(); home.focus(); }
  if (name === "chat") { explorer.setRoot(currentDir()); setExplorer(window.innerWidth > 760 && explorerPreferred()); chat.reloadOptions(); updateHeader(); updateComposer(); }
  renderSummary();
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
// `/goal <text>` sets a persistent goal: the agent brainstorms and plans it, and the keeper re-engages
// it until every plan step is done; `/goal` or `/goal show` reports it; `/goal clear` drops it.
// Handled here, never sent to the model. Returns true when the input was a goal command.
async function goalCommand(text, composer) {
  const m = /^\/goal\b\s*([\s\S]*)$/.exec(text.trim());
  if (!m) return false;
  const arg = m[1].trim();
  try {
    if (!arg || arg === "show") {
      const g = await api("/api/goal");
      const pg = g.progress ? ` · ${g.progress.complete ? "plan complete" : g.progress.steps ? `${g.progress.done + g.progress.skipped}/${g.progress.steps} steps` : g.progress.phase}` : g.goal ? " · no plan yet" : "";
      toast(g.goal ? `Goal: ${g.goal}${pg}${g.nudges ? ` · re-engaged ${g.nudges}×` : ""}` : "No goal set — type /goal <text> to set one");
    } else if (arg === "clear") {
      await api("/api/goal", { goal: "" }, "POST");
      toast("Goal cleared");
    } else {
      await api("/api/goal", { goal: arg }, "POST");
      toast("Goal set — the agent plans it first, then works until every step is done.");
    }
    composer?.clear?.();
  } catch (e) { toast(e.message, true); }
  return true;
}
async function homeSend(text, o) {
  if (await goalCommand(text, home)) return;
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
  if (await goalCommand(text, chat)) return;
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
    // A reopened chat gets its plan back from the plan tool's results in the file (live events keep it current after).
    const histPlan = planFromEvents(h.events);
    if (histPlan && s && !((s.goalBox?.plan?.updatedAt || 0) > (histPlan.updatedAt || 0))) { goalBox(s).plan = histPlan; renderSummary(); }
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
  // A foreign chat's model is labelled with its harness so the slot never implies pi is running it.
  $("#topModel").textContent = s && s.harness !== "pi" && model ? `${s.harness} · ${model}` : model;
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
$("#btnSummary").onclick = () => { try { localStorage.setItem("omni.summary", summaryOn() ? "off" : "on"); } catch { /* */ } renderSummary(); };
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
  if (ev.kind === "log") { if (ev.level === "system" && (ev.ts || 0) >= BOOT_TS) toast(ev.text); else if (ev.level === "graphify" && ev.text) panel.graphLine(ev.text.split("\n").pop()); else if (ev.level === "hook" && ev.text && (ev.ts || 0) >= BOOT_TS && /failed|gave up|not JSON/.test(ev.text)) toast(ev.text, true); return; }
  const s = S.sessions.get(ev.sid) || { sid: ev.sid, harness: ev.harness, lastActivity: 0, tally: null };
  if (ev.kind === "session") Object.assign(s, Object.fromEntries(Object.entries({ cwd: ev.cwd, title: ev.title ? cleanTitle(ev.title) || undefined : undefined, model: ev.model, file: ev.file, owned: ev.owned, forkedFrom: ev.forkedFrom }).filter(([, v]) => v != null)));
  if (ev.kind === "status") s.streaming = !!ev.streaming;
  if (ev.kind === "msg" && ev.role === "user" && !s.title) s.title = cleanTitle(ev.blocks?.[0]?.text || "");
  if (ev.kind === "msg" && ev.usage) { const t = s.tally || (s.tally = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, messages: 0, cost: 0, context: 0 }); if (!ev.groupId || t.lastGroup !== ev.groupId) { t.lastGroup = ev.groupId; t.input += ev.usage.input; t.output += ev.usage.output; t.cacheRead += ev.usage.cacheRead; t.cacheWrite += ev.usage.cacheWrite; t.total += ev.usage.total; t.messages++; t.context = ev.usage.input + ev.usage.cacheRead + ev.usage.cacheWrite; t.cost += ev.cost || 0; } }
  if (ev.kind !== "session") s.lastActivity = Math.max(s.lastActivity || 0, ev.ts || 0);
  if (ev.kind === "digest") toast(`Digest saved: ${ev.path}`);
  if (ev.kind === "summary") { Object.assign(goalBox(s), { summary: ev.text || "", summaryAt: ev.ts, goal: ev.goal || goalBox(s).goal, explicit: !!ev.explicit, nudges: ev.nudges || 0, done: !!ev.done }); if (ev.sid === S.selected) renderSummary(); }
  if (ev.kind === "plan") { Object.assign(goalBox(s), { plan: ev.plan, goal: ev.goal || goalBox(s).goal }); if (ev.sid === S.selected) renderSummary(); }
  if (ev.kind === "goal") { Object.assign(goalBox(s), { goal: ev.goal || goalBox(s).goal, explicit: !!ev.explicit, done: !!ev.done, nudges: ev.nudges || 0, plan: ev.plan || goalBox(s).plan }); if (ev.sid === S.selected) renderSummary(); }
  if (ev.kind === "hook" && ev.attempt) { goalBox(s).nudges = ev.attempt; if (ev.sid === S.selected) renderSummary(); }
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
  S.config = st.config; S.pi = st.pi; S.runs = st.runs || []; S.hook = st.hook || null;
  for (const s of st.sessions) S.sessions.set(s.sid, s);
  // The goal Omni's pi is working on right now (plan, status, re-engages) survives a page reload.
  if (st.goal && st.pi?.sid && S.sessions.get(st.pi.sid)) Object.assign(goalBox(S.sessions.get(st.pi.sid)), { goal: st.goal.goal, explicit: st.goal.explicit, plan: st.goal.plan, summary: st.goal.summary, summaryAt: st.goal.summaryAt, nudges: st.goal.nudges, done: st.goal.done });
  if (st.config?.lanUrls?.length) { $("#lanInfo").textContent = st.config.lanUrls[0].replace(/\?token=.*/, ""); $("#lanInfo").title = "Open this on any device on your network; no login needed"; }
  await Promise.all([panel.loadMemory(""), panel.loadGraphList(), loadPiChoices()]);
  history.render();
  showView("home");
  connect();
  setInterval(() => { if (document.body.classList.contains("panel-open")) history.render(); if (S.page === "chat") updateComposer(); }, 15000);
}
init().catch((e) => toast(`Omni Agent failed to start: ${e.message}`, true));
