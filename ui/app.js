/* Omni Agent front end. Home (one container) → Chat (explorer | preview | transcript). Right drawer: Chats / Memory / Graph / Tokens. pi only.
   Every machine on the account is in this one window: the chats drawer lists them all, and opening a chat or starting one on
   any of them moves the window's focus there without a reload (ui/machines.js keeps one workspace per machine). */
import { el, ago, baseName, harnessLabel, AGENT_ACTIVE, agentTone, agentKindLabel, agentTitle, agentsFor, agentSummary, agentSubline, agentElapsed, agentReportKey, withLiveReports, mergeAgentSnapshot } from "./lib.js";
import { newView, applyEvent, finish, forkNote, agentNote, emptyNote, setOlder, prependHistory, isFollowing, followLatest } from "./transcript.js";
import { chatHash, parseHash } from "./route.js";
import { installKeys, openPalette, openShortcuts } from "./keys.js";
import { createComposer } from "./composer.js";
import { createHistory } from "./sidebar.js";
import { createPanel } from "./panel.js";
import { createExplorer } from "./explorer.js";
import { createSettings } from "./settings.js";
import { initResizers } from "./resizer.js";
import { asPlan, planProgress, PLAN_TOOL } from "./plan.js";
import { createRemote } from "./remote.js";
import { createStream } from "./stream.js";
import { at, local, machine, machineTitle, setMachine, streamEvents, webPage } from "./transport.js";
import { createAccount } from "./account.js";
import { cachedModels, keepModels } from "./model-cache.js";
import { HERE, applySessionEvent, createDrafts, fromMerged, goalBox, machineList, mergedEventsUrl, newWorkspace, sidebarGroups, whereWords } from "./machines.js";
import { createToasts } from "./toast.js";
import { recentRows, renderRecent } from "./home.js";

/** How much of a chat's file a page asks for at a time, as the page receives it: the newest first, older as it is scrolled up. */
const HISTORY_PAGE = 96 * 1024;

const $ = (s) => document.querySelector(s);
// agents: background agents by id (/api/state + live `agent` events); agentSids: an agent chat's sid → agent id;
// agentsOpen: chats whose folded agents strip the user expanded. The focused machine's workspace fields (SWAP) are its own.
const S = { selected: null, view: null, page: "home", followFork: null, forceFork: false, agentsOpen: new Set(), desktop: new URLSearchParams(location.search).get("desktop") === "1", ...newWorkspace() };
const liveWindowMs = () => S.config?.liveWindowMs || 30000;
/** Events replayed by the SSE stream at connect time predate this; their system toasts are stale. */
const BOOT_TS = Date.now();

// ------------------------------------------------------------- machines
/** The fields of a workspace the screen reads through S while that machine is focused. */
const SWAP = ["sessions", "buffers", "agents", "agentSids", "piChats", "pi", "runs", "config", "hook"];
const W = new Map(); // machine key → its workspace
const wsOf = (key) => { let ws = W.get(key); if (!ws) W.set(key, (ws = newWorkspace())); return ws; };
let MACHINES = webPage() ? [] : machineList({ here: { name: "This computer" }, machines: [] });
let focusKey = webPage() ? machine()?.id ?? "" : HERE;
/** A machine the window knows of, or the focused one as the page was opened on it while the account's list is still coming. */
const byKey = (key) => MACHINES.find((m) => m.key === key) || (key === HERE && !webPage() ? { key: HERE, id: null, name: "This computer", label: "This computer", here: true, online: true, state: "online" } : machine()?.id === key ? { key, id: key, name: machine().name, label: machine().name, here: false, online: true, state: "online" } : null);
const focusM = () => byKey(focusKey);
/** Everything sent through this goes to that machine, whatever the window does next. */
const handleOf = (key) => { const m = byKey(key); return at(m && !m.here ? { id: m.id, name: m.label } : null); };
const labelOf = (key) => byKey(key)?.label ?? "that machine";
/** " on <machine>" for a confirmation, while the window holds more than one machine; else nothing, as before accounts. */
const whereOn = (key = focusKey) => { const w = whereWords(MACHINES, key); return w ? ` on ${w}` : ""; };
/** On another machine, or with several in the window, every caption names the machine: a command run on the wrong computer is the mistake to design against. */
const onMachine = (caption) => { const w = whereWords(MACHINES, focusKey); return w ? (caption ? `${caption} (on ${w})` : `On ${w}`) : caption; };
/** Why nothing can be sent to the focused machine right now, or "". */
const focusBlocked = () => { const m = focusM(); return !m ? "" : m.state === "offline" ? `${m.label} is offline. Nothing is sent or queued.` : m.state === "refusing" ? `${m.label} does not let web pages in` : ""; };

/** What a remote browser may do without the host's approval (mirrors server/access.mjs READ). */
const REMOTE_FREE = /^\/api\/(graph\/(query|explain)|remote\/(login|logout))$/;
/** A request on one machine, by key. */
const callOn = (key) => (path, body, method) => {
  const verb = body || (method && method !== "GET") ? method || "POST" : "GET";
  // A remote change is held open by the server until the host decides: say so while it waits.
  if (remote.role === "remote" && verb !== "GET" && !REMOTE_FREE.test(path)) toast("Waiting for the host to approve…");
  return handleOf(key).api(verb, path, body || undefined);
};
/** A request on the focused machine, bound to it as it is sent. */
function api(path, body, method) { return callOn(focusKey)(path, body, method); }
const toast = createToasts($("#toasts"));
// The old remote settings and cards are this computer's, whichever machine the window is on.
const hereApi = (path, body, method) => local.api(body || (method && method !== "GET") ? method || "POST" : "GET", path, body);
const remote = createRemote({ api: hereApi, toast });
const homeCwd = () => $("#homeCwd").value.trim() || S.config?.cwd || "";
const currentDir = () => (S.page === "chat" && S.sessions.get(S.selected)?.cwd) || homeCwd() || null;
const drafts = createDrafts({ storage: (() => { try { return globalThis.localStorage; } catch { return null; } })() });

async function deleteChat(key, sid) {
  const ws = key === focusKey ? S : wsOf(key);
  const s = ws.sessions.get(sid);
  const name = s?.title ? `“${s.title.slice(0, 40)}”` : "this chat";
  if (!window.confirm(`Delete ${name}${whereOn(key)}?\n\nIt moves to Omni's trash folder.`)) return;
  try {
    await callOn(key)(`/api/sessions/${encodeURIComponent(sid)}`, null, "DELETE");
    ws.sessions.delete(sid); ws.buffers.delete(sid);
    if (key === focusKey && S.selected === sid) { S.selected = null; S.view = null; showView("home"); }
    history.render();
    if (S.page === "home") renderHome();
  } catch (e) { toast(e.message, true); }
}

// ------------------------------------------------------------- agents
/** The agent record behind a chat (pi or Claude agent), or null for an ordinary chat. */
const agentFor = (sid) => (sid && S.agentSids.has(sid) ? S.agents.get(S.agentSids.get(sid)) || null : null);
const agentIn = (ws, sid) => (sid && ws.agentSids.has(sid) ? ws.agents.get(ws.agentSids.get(sid)) || null : null);
/** A background agent's chat: its own pi process (never Omni's main pi) or a Claude Code run another chat started. */
const isAgentChat = (s) => !!(s && (s.parentSid || s.agentId || S.agentSids.has(s.sid)));
function putAgentIn(ws, a) {
  if (!a?.id) return;
  ws.agents.set(a.id, a);
  if (!a.sid) return;
  ws.agentSids.set(a.sid, a.id);
  const s = ws.sessions.get(a.sid);
  if (s) { s.parentSid = s.parentSid || a.parentSid || undefined; s.agentId = s.agentId || a.id; s.agentKind = s.agentKind || a.kind; }
}
const putAgent = (a) => putAgentIn(S, a);
// agentRev counts the agent records that came in live (SSE, a Stop's answer); agentLiveAt: id → its rev then.
let agentRev = 0;
const agentLiveAt = new Map();
function liveAgent(a) { if (!a?.id) return; agentLiveAt.set(a.id, ++agentRev); putAgent(a); }
/** A `/api/state` snapshot of the agents; `rev` is agentRev when it was requested (live records since then win). */
function loadAgents(list, rev = agentRev) {
  const merged = mergeAgentSnapshot(S.agents, list, agentLiveAt, rev);
  S.agents.clear();
  for (const a of merged.values()) putAgent(a);
}

// ------------------------------------------------------------- modules
const openChat = (sid) => { selectSession(sid); showView("chat"); if (window.innerWidth < 1100) panel.setOpen(false); };
/** A chat on any machine: the window goes there first (asking about unsaved files), then opens it. */
function openChatOn(key, sid) {
  if (key !== focusKey) {
    // The window passes through Home on its way to the other machine: that is no place to come Back to.
    const was = applyingRoute;
    applyingRoute = true;
    try { if (!focusMachine(key)) return; } finally { applyingRoute = was; }
  }
  openChat(sid);
}
const history = createHistory({
  machines: () => MACHINES,
  groups: (filter, only) => sidebarGroups({ machines: MACHINES, workspaces: W, filter, only, titleOf: (ws, s) => agentIn(ws, s.sid)?.title || s.title || "", textOf: (s) => `${s.cwd || ""} ${s.model || ""} ${s.harness} ${harnessLabel(s.harness)}` }),
  selected: () => ({ key: S.page === "chat" ? focusKey : null, sid: S.selected }),
  onSelect: openChatOn, onDelete: deleteChat, onRetry: (key) => loadFirst(key), onMore: (key) => loadAll(key),
  onNew: () => { showView("home"); home.focus(); },
  agentFor: agentIn,
});
const panel = createPanel({ S, api, toast, onSelect: openChat, currentDir, getPiContextWindow: () => S.pi.state?.model?.contextWindow, onShowChats: () => { loadAll(focusKey); history.render(); }, where: () => whereOn() });
// Reveal opens a window on the screen of the computer serving the files: never from a remote browser, or from a window on another machine.
const explorer = createExplorer({ api, toast, insert: (t) => (S.page === "chat" ? chat : home).insert(t), onClose: () => setExplorer(false, S.page === "chat"), isRemote: () => remote.role === "remote" || !focusM()?.here, where: () => whereOn() });
const account = createAccount({ toast, openSettings: () => openSettings("account"), choose: chooseMachine, onMachines: setMachines, retry: () => loadFirst(focusKey) });
// Settings shows one machine's models, MCP servers and long runs: the focused one when it opens, and any other picked in it.
let settingsKey = null;
const settingsOn = () => settingsKey ?? focusKey;
const settingsConfig = () => (settingsOn() === focusKey ? S.config : wsOf(settingsOn()).config);
const settings = createSettings({
  api: (path, body, method) => callOn(settingsOn())(path, body, method), toast,
  onChanged: () => { if (settingsOn() === focusKey) { loadPiChoices(); refreshState(); } },
  loadRemote: () => remote.loadSettings(), loadAccount: () => account.renderSettings(),
  getContext: () => settingsConfig()?.context,
  onContext: (context) => { if (settingsOn() === focusKey) S.config = { ...(S.config || {}), context }; else { const ws = wsOf(settingsOn()); ws.config = { ...(ws.config || {}), context }; } },
  where: () => whereOn(settingsOn()), onTab: renderSettingsMachine,
});
function openSettings(tab) { settingsKey = focusKey; settings.open(tab); }
const composerHooks = { onPickFile: () => { explorer.setRoot(currentDir()); setExplorer(true); }, onPiModel: setPiModel, onPiThinking: setPiThinking, onManageProviders: () => openSettings(), onHook: setHook };
const home = createComposer($("#homeComposer"), { ...composerHooks, onSend: homeSend });
// In a background agent's chat the picker shows the agent's model; picking there would change Omni's own pi.
const notForAgents = (fn) => (...args) => { if (target().kind !== "agent") return fn(...args); toast("A background agent keeps the model it started with. Change the model from one of Omni's own chats.", true); updateComposer(); };
// What is typed in a chat is kept as it is typed (a reload or a closed window keeps it), not only when the chat is left.
let draftTimer = null;
const onChatDraft = () => { clearTimeout(draftTimer); draftTimer = setTimeout(() => { if (S.page === "chat") keepDraft(); }, 300); };
const chat = createComposer($("#chatComposer"), { ...composerHooks, onPiModel: notForAgents(setPiModel), onPiThinking: notForAgents(setPiThinking), onHook: notForAgents(setHook), onSend: chatSend, onStop: chatStop, onDraft: onChatDraft });
globalThis.addEventListener?.("pagehide", () => { if (S.page === "chat") keepDraft(); });

/** Choices made before pi runs are saved on the server and applied when it starts, so the picker never "forgets". */
/** The open chat when it has a pi child of its own: a model, thinking or goal change is for that chat. */
const piChatSid = () => (S.page === "chat" && S.piChats.has(S.selected) ? S.selected : undefined);
async function setPiModel(provider, id) {
  const key = focusKey;
  try {
    const sid = piChatSid();
    const r = await api("/api/pi/model", { provider, modelId: id, sid });
    if (r.pending) toast(`${id} is used once OpenCode starts${whereOn(key)}`);
    if (key !== focusKey) return;
    if (sid) { const c = S.piChats.get(sid); if (c) c.model = { provider, id }; }
    // The server moves the thinking level to the nearest one the new model has.
    S.config = { ...(S.config || {}), piProvider: provider, piModel: id, ...(r.level ? { piThinking: r.level } : {}) };
    loadPiChoices();
    if (S.page === "home") renderHome(); else updateComposer();
  } catch (e) { toast(e.message, true); }
}
async function setPiThinking(level) {
  const key = focusKey;
  try {
    const sid = piChatSid();
    const r = await api("/api/pi/thinking", { level, sid });
    if (key !== focusKey) return;
    S.config = { ...(S.config || {}), piThinking: r.level || level };
    if (sid) { const c = S.piChats.get(sid); if (c) c.thinkingLevel = r.level || level; }
    if (S.page === "home") renderHome(); else updateComposer();
  } catch (e) { toast(e.message, true); }
}
/** The picker gets the list last seen on this machine at once (ui/model-cache.js), then the real one when it comes. */
const modelsKey = () => machine()?.id ?? "here";
let modelsShown = false;
async function loadPiChoices() {
  const key = focusKey;
  if (!modelsShown) {
    modelsShown = true;
    const kept = cachedModels(modelsKey());
    const choices = kept ? { models: kept.models, ...(kept.levels?.length ? { levels: kept.levels, labels: kept.labels || {} } : {}) } : { models: [] };
    home.setPiChoices(choices); chat.setPiChoices(choices);
  }
  const [m, l] = await Promise.allSettled([api("/api/pi/models"), api("/api/pi/thinking-levels")]);
  if (key !== focusKey) return; // another machine's list is not this one's
  const choices = {};
  const models = m.status === "fulfilled" ? (m.value.data?.models || []) : [];
  const levels = l.status === "fulfilled" ? (l.value.data?.levels || []) : [];
  if (m.status === "fulfilled") choices.models = models;
  if (levels.length) { choices.levels = levels; choices.labels = l.value.data?.labels || {}; }
  if (Object.keys(choices).length) { home.setPiChoices(choices); chat.setPiChoices(choices); }
  if (m.status === "fulfilled") keepModels(modelsKey(), { models, levels: choices.levels, labels: choices.labels });
}
/** What the picker shows: the open chat's pi child when it has one, else the saved choice the next pi child will start with. */
function piModelState() {
  const own = S.page === "chat" ? S.piChats.get(S.selected) : null;
  const mdl = own?.model?.id ? own.model : null;
  const c = S.config || {};
  const piModel = mdl ? { provider: mdl.provider, id: mdl.id } : c.piModel ? { provider: c.piProvider, id: c.piModel } : null;
  const piThinking = own?.thinkingLevel || c.piThinking || "";
  return { piModel, piThinking, hook: S.hook };
}
/** The chats with a pi child right now (server `pis`): a message there goes straight to that chat's own pi. */
const piChatsOf = (list) => new Map(list.filter((c) => c?.sid && c.sid !== "pi:pending").map((c) => [c.sid, c]));
function setPiChats(list) {
  if (!Array.isArray(list)) return;
  S.piChats = piChatsOf(list);
}
/** The whole state of the focused machine: every chat, and the agents in full. */
async function refreshState() {
  const key = focusKey;
  try {
    const rev = agentRev;
    const st = await api("/api/state");
    if (key !== focusKey) { mergeAll(wsOf(key), st); return; }
    for (const s of st.sessions || []) { S.sessions.set(s.sid, { ...(S.sessions.get(s.sid) || {}), ...s }); if (s.agentId) S.agentSids.set(s.sid, s.agentId); }
    if (st.boot) wsOf(key).boot = st.boot;
    S.pi = st.pi; setPiChats(st.pis); S.runs = st.runs || []; S.hook = st.hook || S.hook;
    if (st.config) S.config = st.config;
    if (st.agents) { loadAgents(st.agents, rev); renderAgents(); }
    wsOf(key).allChats = true;
    updateHeader();
    if (S.page === "home") renderHome(); else updateComposer();
  } catch { /* transient */ }
}
/** Every chat of a machine the window is not focused on, into its own workspace: its older chats, asked for by the person. */
function mergeAll(ws, st) {
  for (const s of st.sessions || []) { ws.sessions.set(s.sid, { ...(ws.sessions.get(s.sid) || {}), ...s }); if (s.agentId) ws.agentSids.set(s.sid, s.agentId); }
  for (const a of st.agents || []) putAgentIn(ws, a);
  ws.allChats = true;
}
/** Goal hook settings live in omni.config.json through the server; the menu reflects the saved state. */
async function setHook(patch) {
  const key = focusKey;
  try {
    const r = await api("/api/hook", patch, "PUT");
    if (key === focusKey) S.hook = r.hook;
    if (S.page === "home") renderHome(); else updateComposer();
  } catch (e) { toast(e.message, true); }
}

// --------------------------------------------------------------- views
/** `persist` only for a deliberate toggle; leaving the chat view must not remember "closed". */
// The tree opens beside a chat only when asked for: the transcript is the product, and it stays still as a chat opens.
function setExplorer(open, persist = false) {
  document.body.classList.toggle("explorer-open", open); if (!open) explorer.closePreview(); else explorer.restorePreview(); if (persist) { try { localStorage.setItem("omni.explorer", open ? "1" : "0"); } catch { /* */ } } }
function explorerPreferred() { try { return localStorage.getItem("omni.explorer") === "1"; } catch { return false; } }
// The goal box pinned above a chat: the goal, the agent's plan (live from `plan` events, so it is always
// current with no model call) and the status written by the separate summarizer at each milestone.
function summaryOn() { try { return localStorage.getItem("omni.summary") !== "off"; } catch { return true; } }
function planOpen() { try { return localStorage.getItem("omni.planOpen") === "1"; } catch { return false; } }
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
  const atTime = gb.summaryAt || plan?.updatedAt;
  const meta = [gb.done ? "done" : phase, gb.nudges ? `re-engaged ${gb.nudges}×` : "", atTime ? `updated ${new Date(atTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""].filter(Boolean).join(", ");
  if (meta) head.appendChild(el("span", "summary-nudges", meta));
  if (plan?.milestones?.length) {
    const t = el("button", `summary-toggle${planOpen() ? " open" : ""}`, planOpen() ? "Hide plan" : "Show plan");
    t.onclick = () => { try { localStorage.setItem("omni.planOpen", planOpen() ? "0" : "1"); } catch { /* */ } renderSummary(); };
    head.appendChild(t);
  }
  const x = el("button", "summary-x", "×");
  x.title = "Hide this. The button in the bar brings it back.";
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
  if (pr?.waiting) box.appendChild(el("div", "plan-now waiting", `Waiting for you. ${pr.waiting.question}`));
  else if (pr?.current && !pr.complete) {
    const now = el("div", "plan-now");
    now.append(el("span", "plan-now-k", pr.currentMilestone ? `Milestone ${pr.currentMilestone.id}, ${pr.current.id}` : pr.current.id), el("span", "plan-now-t", pr.current.title));
    if (pr.current.doneWhen) now.appendChild(el("span", "plan-now-c", `done when ${pr.current.doneWhen}`));
    box.appendChild(now);
  } else if (pr?.phase === "plan") box.appendChild(el("div", "plan-now", `Writing the plan${plan.brainstorm?.chosen ? ` for ${plan.brainstorm.chosen}` : ""}…`));
  if (gb.summary) box.appendChild(el("div", "summary-body", gb.summary));
  else if (!plan) box.appendChild(el("div", "summary-body", "No plan yet. A status appears once the agent plans, and at each milestone."));
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
  // Leaving a chat keeps what was typed in it for when it opens again.
  if (name !== "chat" && S.page === "chat") keepDraft();
  S.page = name;
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${name}`));
  $("#btnChatMenu").hidden = name !== "chat";
  $("#btnExplorer").hidden = name !== "chat";
  document.body.classList.toggle("in-chat", name === "chat");
  // Both composers share the remembered attachment choices (memory / repo graph).
  if (name === "home") { setExplorer(false); home.reloadOptions(); renderHome(); home.autoFocus(); }
  if (name === "mission") { setExplorer(false); missionView.load(); }
  if (name === "chat") { explorer.setRoot(currentDir()); setExplorer(window.innerWidth > 760 && explorerPreferred()); chat.reloadOptions(); updateHeader(); updateComposer(); chat.autoFocus(); }
  renderSummary();
  renderAgents();
  updateTitle();
  syncRoute();
}

// ------------------------------------------------------------- URLs
// The window's place is in its URL (ui/route.js): a chat is #/c/<machine>/<chat id>, so a reload comes back to it, Back
// goes to where the window was before, and a link opens the same chat on another device. This computer is its device id
// once the account names it ("here" before that, or with no account).
let hereId = null, applyingRoute = false, pendingRoute = null;
const urlKey = (key) => (key === HERE ? hereId || "here" : key);
/** The machine key a URL names, or null while the window does not know that machine (yet). */
const keyFromUrl = (seg) => (seg === "here" ? (webPage() ? null : HERE) : hereId && seg === hereId && !webPage() ? HERE : byKey(seg) ? seg : null);
const routeHash = () => (S.page === "chat" && S.selected ? chatHash(urlKey(focusKey), S.selected) : S.page === "mission" ? "#missions" : "");
const routeUrl = (hash) => `${location.pathname}${location.search}${hash}`;
/** A move the person made becomes a history entry; one the URL made (Back, a link, a reload) does not. */
function syncRoute() {
  if (applyingRoute) return;
  const want = routeHash();
  if ((location.hash || "") !== want) window.history.pushState(null, "", routeUrl(want));
}
function applyRoute(r = parseHash(location.hash)) {
  applyingRoute = true;
  try {
    if (r.kind !== "chat") { pendingRoute = null; const page = r.kind === "missions" ? "mission" : "home"; if (S.page !== page) showView(page); return; }
    const key = keyFromUrl(r.machine);
    if (key == null) { pendingRoute = r; return; } // a machine the account has not listed yet: tried again when it does
    pendingRoute = null;
    if (key !== focusKey && !focusMachine(key)) { window.history.replaceState(null, "", routeUrl(routeHash())); return; }
    if (S.page !== "chat" || S.selected !== r.sid) openChat(r.sid);
  } finally { applyingRoute = false; }
}
window.addEventListener("popstate", () => applyRoute());

// The agents strip above the composer: the background agents (pi, Claude Code, shell jobs) this chat started,
// live from `agent` events. Open selects an agent's chat (a shell job shows its log here); Stop cancels it.
const CHEV = `<span class="chev"><svg viewBox="0 0 16 16"><path d="m6 4 4 4-4 4"/></svg></span>`;
const logOpen = new Set(), logText = new Map(), logBusy = new Set();
let agentTick = null, agentTimer = null, tickN = 0, stripSig = "";
function scheduleAgents() { if (!agentTimer) agentTimer = setTimeout(() => { agentTimer = null; renderAgents(); }, 200); }
function renderAgents() {
  const box = $("#agentStrip");
  if (!box) return;
  const list = S.page === "chat" && S.selected ? agentsFor(S.agents.values(), S.selected) : [];
  if (!list.length) { box.textContent = ""; box.hidden = true; stripSig = ""; setAgentTick(false); return; }
  const fold = list.length > 3, open = !fold || S.agentsOpen.has(S.selected);
  setAgentTick(list.some((a) => AGENT_ACTIVE.has(a.status)));
  // A busy agent sends an event per tool call: when only its activity changed, patch the rows in place so a
  // button under the pointer is never swapped out mid-click. Anything structural rebuilds the strip.
  const sig = `${focusKey}|${S.selected}|${open}|${list.map((a) => `${a.id}:${a.status}:${a.sid ? 1 : 0}:${logOpen.has(a.id) ? 1 : 0}`).join(",")}`;
  if (sig === stripSig && !box.hidden) {
    for (const row of box.querySelectorAll(".ag-row")) {
      const a = S.agents.get(row.dataset.id); if (!a) continue;
      const sub = row.querySelector(".ag-sub"), t = agentSubline(a);
      if (sub.textContent !== t) { sub.textContent = t; sub.title = t; }
      row.querySelector(".ag-title").textContent = agentTitle(a);
    }
    return;
  }
  stripSig = sig;
  box.textContent = "";
  box.hidden = false;
  if (fold) {
    const tones = list.map((a) => agentTone(a.status));
    const sum = el("button", `ag-sum${open ? " open" : ""}`);
    sum.append(el("span", `ag-dot ${tones.includes("run") ? "run" : tones.includes("err") ? "err" : "ok"}`), el("span", "ag-sum-t", agentSummary(list)));
    sum.insertAdjacentHTML("beforeend", CHEV);
    sum.setAttribute("aria-expanded", String(open));
    sum.title = open ? "Fold the agents into one line" : "Show every agent";
    sum.onclick = () => { if (S.agentsOpen.has(S.selected)) S.agentsOpen.delete(S.selected); else S.agentsOpen.add(S.selected); renderAgents(); };
    box.appendChild(sum);
  }
  if (open) {
    const rows = el("div", "ag-rows");
    for (const a of list) rows.append(...agentRow(a));
    box.appendChild(rows);
  }
}
function agentRow(a) {
  const active = AGENT_ACTIVE.has(a.status), tone = agentTone(a.status);
  const row = el("div", `ag-row${tone ? ` ${tone}` : ""}${a.status === "queued" ? " queued" : ""}`);
  row.dataset.id = a.id;
  const dot = el("span", "ag-dot"); dot.title = a.status || "";
  const main = el("div", "ag-main");
  const line = el("div", "ag-line");
  const title = el("span", "ag-title", agentTitle(a)); title.title = a.task || a.command || "";
  line.append(title, el("span", "ag-kind", agentKindLabel(a.kind)));
  const sub = el("div", "ag-sub", agentSubline(a));
  sub.title = sub.textContent;
  main.append(line, sub);
  const time = el("span", "ag-time", agentElapsed(a)); time.dataset.id = a.id;
  const acts = el("div", "ag-acts");
  if (a.kind === "shell") {
    const b = el("button", "btn quiet small", logOpen.has(a.id) ? "Hide log" : "Log");
    b.title = "The last lines of this job's output";
    b.onclick = () => toggleLog(a.id);
    acts.appendChild(b);
  } else {
    const b = el("button", "btn quiet small", "Open");
    b.disabled = !a.sid;
    b.title = a.sid ? "Open this agent's chat" : "The agent has no chat yet";
    b.onclick = () => openChat(a.sid);
    acts.appendChild(b);
  }
  if (active) {
    const x = el("button", "btn quiet small ag-stop", "Stop");
    x.title = "Cancel this agent";
    x.onclick = () => stopAgent(a.id, x);
    acts.appendChild(x);
  }
  row.append(dot, main, time, acts);
  if (!logOpen.has(a.id)) return [row];
  const pre = el("pre", "ag-log", logText.get(a.id) || "Loading…");
  pre.dataset.id = a.id;
  return [row, pre];
}
function setAgentTick(on) {
  if (on && !agentTick) {
    agentTick = setInterval(() => {
      const box = $("#agentStrip");
      if (box.hidden) { setAgentTick(false); return; }
      const now = Date.now();
      for (const t of box.querySelectorAll(".ag-time")) { const a = S.agents.get(t.dataset.id); if (a) t.textContent = agentElapsed(a, now); }
      // An open log of a running job follows its output.
      if (++tickN % 3 === 0) for (const id of logOpen) if (AGENT_ACTIVE.has(S.agents.get(id)?.status)) fetchLog(id);
    }, 1000);
  } else if (!on && agentTick) { clearInterval(agentTick); agentTick = null; }
}
function toggleLog(id) {
  if (logOpen.has(id)) logOpen.delete(id); else { logOpen.add(id); fetchLog(id); }
  renderAgents();
}
async function fetchLog(id) {
  if (logBusy.has(id)) return;
  logBusy.add(id);
  const key = focusKey;
  try { const r = await api(`/api/agents/${encodeURIComponent(id)}/log?tail=60`); if (key === focusKey) logText.set(id, r.text || "No output yet."); }
  catch (e) { if (key === focusKey) logText.set(id, `The log did not load. ${e.message}`); }
  finally { logBusy.delete(id); }
  for (const pre of $("#agentStrip").querySelectorAll("pre.ag-log")) {
    if (pre.dataset.id !== id) continue;
    const stick = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 24;
    pre.textContent = logText.get(id) || "";
    if (stick) pre.scrollTop = pre.scrollHeight;
  }
}
async function stopAgent(id, btn) {
  const a = S.agents.get(id);
  const key = focusKey;
  if (!window.confirm(`Stop “${agentTitle(a || { id })}”${whereOn(key)}?\nWhat it did so far stays in its chat.`)) return;
  if (btn) btn.disabled = true;
  try { const r = await callOn(key)(`/api/agents/${encodeURIComponent(id)}/cancel`, {}); if (r.agent && key === focusKey) liveAgent(r.agent); }
  catch (e) { toast(e.message, true); if (btn) btn.disabled = false; }
  renderAgents(); updateComposer();
}
/** An agent report card's Open: the agent's chat, or for a shell job its log in the strip. */
function openAgent(id) {
  const a = S.agents.get(id);
  if (a?.sid) { openChat(a.sid); return; }
  if (a?.kind === "shell" && a.parentSid === S.selected) {
    // Unfold the strip too: an already-open log in a folded strip is otherwise a click with no effect.
    S.agentsOpen.add(S.selected);
    if (logOpen.has(id)) renderAgents(); else toggleLog(id);
    $("#agentStrip").scrollIntoView?.({ block: "nearest" });
    return;
  }
  toast(a ? "That agent has no chat" : "That agent is no longer known here", true);
}
function onAgent(a) {
  if (!a?.id) return;
  const prev = S.agents.get(a.id);
  liveAgent(a);
  if (a.parentSid === S.selected || prev?.parentSid === S.selected) scheduleAgents();
  // A finished job's log gets its last lines once more.
  if (logOpen.has(a.id) && AGENT_ACTIVE.has(prev?.status) && !AGENT_ACTIVE.has(a.status)) fetchLog(a.id);
  if (a.sid && a.sid === S.selected) updateComposer();
  if (a.sid && prev?.sid !== a.sid && document.body.classList.contains("panel-open")) history.render();
}
function updateTitle() {
  const s = S.sessions.get(S.selected);
  // An agent's chat goes by the title its parent gave the job, not the first line of its task prompt.
  const title = S.page === "chat" && s ? agentFor(s.sid)?.title || s.title || "" : "";
  $("#topTitle").textContent = title;
  document.title = machineTitle(title ? `${title} · Omni Agent` : "Omni Agent");
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
  // Other recent folders, one tap to switch to: worth showing only when there is more than the one already picked.
  const dirs = recentDirs();
  const same = (a, b) => String(a).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() === String(b).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  if (dirs.some((d) => !same(d, cwdInput.value))) for (const d of dirs) { const c = el("button", `chip${same(d, cwdInput.value) ? " active" : ""}`, baseName(d) || d); c.title = d; c.onclick = () => { cwdInput.value = d; renderHome(); }; chips.appendChild(c); }
  const blocked = focusBlocked();
  home.setState({ ...piModelState(), disabled: !!blocked, caption: blocked || onMachine("") });
  // The placeholder says what Send will do, and where.
  const folder = baseName(homeCwd());
  $("#homeComposer textarea").placeholder = blocked ? "" : `Message OpenCode${folder ? ` in ${folder}` : ""}`;
  const groups = sidebarGroups({ machines: MACHINES, workspaces: W, titleOf: (ws, s) => agentIn(ws, s.sid)?.title || s.title || "" });
  renderRecent({ section: $("#homeRecent"), list: $("#homeRecentList"), title: $("#homeRecentTitle"), rows: recentRows(groups, { titleOf: (ws, s) => agentIn(ws, s.sid)?.title || s.title || "" }), many: MACHINES.length > 1, onOpen: openChatOn });
  updateHeader();
}
$("#homeAllChats").onclick = () => panel.open("chats");
// `/goal <text>` sets a persistent goal: the agent brainstorms and plans it, and the keeper re-engages
// it until every plan step is done; `/goal` or `/goal show` reports it; `/goal clear` drops it.
// Handled here, never sent to the model. Returns true when the input was a goal command.
async function goalCommand(text, composer) {
  const m = /^\/goal\b\s*([\s\S]*)$/.exec(text.trim());
  if (!m) return false;
  const arg = m[1].trim();
  try {
    if (!arg || arg === "show") {
      const g = await api(`/api/goal${piChatSid() ? `?sid=${encodeURIComponent(piChatSid())}` : ""}`);
      const pg = g.progress ? ` · ${g.progress.complete ? "plan complete" : g.progress.steps ? `${g.progress.done + g.progress.skipped}/${g.progress.steps} steps` : g.progress.phase}` : g.goal ? " · no plan yet" : "";
      toast(g.goal ? `The goal is “${g.goal}”${pg.replace(/^ · /, ", ")}${g.nudges ? `, re-engaged ${g.nudges}×` : ""}` : "No goal yet. Type /goal and what you want done.");
    } else if (arg === "clear") {
      await api("/api/goal", { goal: "", sid: piChatSid() }, "POST");
      toast("Goal cleared");
    } else {
      await api("/api/goal", { goal: arg, sid: piChatSid() }, "POST");
      toast("Goal set. The agent plans it, then works until every step is done.");
    }
    composer?.clear?.();
  } catch (e) { toast(e.message, true); }
  return true;
}
async function homeSend(text, o) {
  if (await goalCommand(text, home)) return;
  const cwd = homeCwd();
  if (!cwd) return toast("Pick a folder first", true);
  const blocked = focusBlocked();
  if (blocked) return toast(blocked, true);
  // Every step of starting this chat goes to the machine it was started on, wherever the window is by the time it answers.
  const key = focusKey, call = callOn(key), ws = wsOf(key);
  home.setState({ disabled: true, caption: remote.role === "remote" ? "Waiting for the host to approve…" : onMachine("Starting…") });
  try {
    if (remote.role === "remote") {
      // One request, one approval: the server starts pi (or a new session) and sends the message.
      const r = await call("/api/pi/send", { cwd, message: text, memory: o.memory, graph: o.graph });
      const st = await call("/api/state");
      if (key === focusKey) S.pi = st.pi;
      ws.sessions.set(r.sid, { ...(ws.sessions.get(r.sid) || {}), sid: r.sid, harness: "pi", owned: true, cwd, title: text.replace(/\s+/g, " ").slice(0, 80), lastActivity: Date.now(), streaming: true });
      if (key === focusKey) openChat(r.sid);
      home.clear();
      return;
    }
    // A chat of its own: a free pi child in that folder opens it, else another one starts. Chats already working keep going.
    const r = await call("/api/pi/open", { cwd });
    if (!r.sid || r.sid === "pi:pending") throw new Error("OpenCode did not report a session");
    (key === focusKey ? S.piChats : ws.piChats).set(r.sid, { sid: r.sid, cwd, model: r.state?.model?.id ? { provider: r.state.model.provider, id: r.state.model.id } : null, thinkingLevel: r.state?.thinkingLevel || "" });
    ws.sessions.set(r.sid, { ...(ws.sessions.get(r.sid) || {}), sid: r.sid, harness: "pi", owned: true, cwd, model: r.state?.model?.id, title: text.replace(/\s+/g, " ").slice(0, 80), lastActivity: Date.now(), streaming: true });
    if (key === focusKey) openChat(r.sid);
    await call("/api/pi/prompt", { message: text, memory: o.memory, graph: o.graph, sid: r.sid });
    home.clear();
  } catch (e) { toast(e.message, true); }
  finally { home.setState({ disabled: false, caption: onMachine("") }); if (S.page === "home") renderHome(); history.render(); }
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
  // A mission orchestrator's chat: a message goes to the mission (front of the orchestrator's queue), never to Omni's main pi.
  if (s.missionRole === "orchestrator" && s.missionId) return { kind: "orchestrator", s };
  // A background agent's chat talks to that agent (steer / follow up / resume), never to Omni's main pi.
  if (isAgentChat(s)) { const a = agentFor(s.sid) || S.agents.get(s.agentId) || null; return { kind: "agent", s, a, id: a?.id || s.agentId || "", active: AGENT_ACTIVE.has(a?.status) }; }
  if (s.harness === "claude") return { kind: "claude", s };
  // Each chat Omni runs has a pi child of its own: a message goes straight to it, whatever the other chats are doing.
  if (S.piChats.has(s.sid)) return { kind: "owned-pi", s, streaming: !!s.streaming };
  const live = !s.owned && (s.streaming || Date.now() - Math.max(s.lastActivity || 0, s.mtime || 0) < liveWindowMs());
  return { kind: "continue", s, live };
}
function updateComposer() {
  const t = target();
  const st = { streaming: false, disabled: false, caption: "", ...piModelState() };
  // The placeholder says what Send will do. A chat that takes no message shows none.
  let hint = "";
  if (t.kind === "none") { st.caption = "Pick a chat"; st.disabled = true; }
  else if (t.kind === "agent") {
    // The agent's own model (its chat's, else what it was started with), never Omni's pi or its goal hook.
    const model = t.s.model || t.a?.model || "";
    Object.assign(st, { piModel: { provider: t.a?.provider || "", id: model || "agent's model" }, piThinking: t.a?.thinking || "", hook: null });
    st.disabled = !t.id;
    st.streaming = t.active;
    st.caption = !t.id ? "Background agent, read-only here" : t.active ? `${agentKindLabel(t.a?.kind || t.s.agentKind)} is working. A message steers it, an empty send stops it.` : `${agentKindLabel(t.a?.kind || t.s.agentKind)}, ${t.a?.status || "finished"}. A message picks it up again.`;
    hint = t.id ? (t.active ? "Steer the agent" : "Message the agent") : "";
  }
  else if (t.kind === "claude") { st.caption = "Claude Code chat, read-only here"; st.disabled = true; }
  else if (t.kind === "orchestrator") { Object.assign(st, { hook: null, streaming: false, caption: "Mission orchestrator. Your message goes ahead of worker reports." }); hint = "Message the orchestrator"; }
  else if (t.kind === "owned-pi") {
    // pi is idle while the goal hook waits to retry or check, but the chat is not: Stop must reach the hook too.
    const armed = !t.streaming && !!t.s.hookArmed;
    const retry = (t.s.hookRetryAt || 0) > Date.now() ? new Date(t.s.hookRetryAt).toLocaleTimeString() : "";
    st.streaming = t.streaming || armed;
    st.caption = t.streaming ? "Working. A message steers it, an empty send stops it." : armed ? `${retry ? `The goal hook retries at ${retry} after a model error.` : "The goal hook is about to carry on."} An empty send stops it.` : "";
    hint = t.streaming ? "Steer this run" : "Reply";
  }
  else {
    const fork = S.forceFork || t.live;
    st.caption = fork ? `Sending forks ${t.live ? "the running" : "this"} chat` : "";
    hint = fork ? "Fork this chat" : "Continue this chat";
  }
  if (t.s?.compacting) st.caption = "Compacting this long chat first. It can take minutes.";
  $("#chatComposer").classList.toggle("for-agent", t.kind === "agent");
  st.caption = onMachine(st.caption);
  // A machine that is gone takes nothing: said by name, and nothing waits to be sent later.
  const blocked = focusBlocked();
  if (blocked && t.kind !== "none") { st.disabled = true; st.streaming = false; st.caption = blocked; hint = ""; }
  chat.setState(st);
  $("#chatComposer textarea").placeholder = hint;
}
/**
 * Empty the box as the message goes: its bubble is in the chat already, and pi answers only once it has started the
 * run, which can take minutes (it compacts a long session first). The text comes back if the send fails.
 */
async function sendClearing(composer, text, send) {
  composer.clear();
  try { return await send(); } catch (e) { if (!composer.value.trim()) composer.insert(text); throw e; }
}
async function chatSend(text, o) {
  const t = target();
  // Sending always goes to the newest line, wherever the reader had scrolled.
  followLatest($("#transcriptWrap"));
  // `/goal` drives Omni's own pi (the keeper); here it would quietly set that goal from an agent's chat.
  if (t.kind === "agent" && /^\/goal\b/.test(text.trim())) { toast("/goal is for Omni's own chats. Here, just tell the agent.", true); return; }
  if (await goalCommand(text, chat)) return;
  // The chat's own machine, fixed now: an answer that comes after the person has moved on still belongs to it.
  const key = focusKey, call = callOn(key);
  try {
    if (t.kind === "owned-pi") {
      const r = await sendClearing(chat, text, () => call("/api/pi/prompt", { message: text, memory: o.memory, graph: o.graph, sid: t.s.sid }));
      // The chat's child had closed meanwhile: the server picked the chat up again (a fork lands in a new chat).
      if (r?.sid && r.sid !== S.selected && key === focusKey) selectSession(r.sid);
      return;
    }
    if (t.kind === "orchestrator") { await sendClearing(chat, text, () => call(`/api/missions/${encodeURIComponent(t.s.missionId)}/message`, { text })); return; }
    if (t.kind === "agent") {
      if (!t.id) return;
      const r = await sendClearing(chat, text, () => call(`/api/agents/${encodeURIComponent(t.id)}/message`, { text }));
      if (r.how === "resumed" || r.how === "restarted") toast(`Agent ${r.how} with your message`);
      return;
    }
    if (t.kind !== "continue") return;
    chat.setState({ disabled: true, caption: onMachine("Starting…") });
    const r = await sendClearing(chat, text, () => call(`/api/sessions/${encodeURIComponent(t.s.sid)}/continue`, { message: text, memory: o.memory, graph: o.graph, fork: S.forceFork }));
    S.forceFork = false;
    if (r.sid !== S.selected && key === focusKey) selectSession(r.sid);
  } catch (e) { toast(e.message, true); }
  finally { updateComposer(); }
}
async function chatStop() {
  const t = target();
  if (t.kind === "agent") { if (t.id) await stopAgent(t.id); return; }
  try { if (t.kind === "owned-pi") await api("/api/pi/abort", { sid: t.s.sid }); } catch (e) { toast(e.message, true); }
}
/** What is typed in the open chat stays with that chat on that machine. */
function keepDraft() { if (S.selected) drafts.save(focusKey, S.selected, chat.value); }
/** `reload`: the same chat again after the stream lost events. It is built aside and swapped in whole, so the reader
 *  never sees it empty and the panel they are scrolling never loses its height. */
async function selectSession(sid, { reload = false } = {}) {
  const previous = S.view;
  const key = focusKey;
  if (!reload && S.selected !== sid) { keepDraft(); chat.setValue(drafts.take(key, sid)); }
  if (S.view && !reload) finish(S.view);
  S.selected = sid;
  // Opened from Home, showView("chat") records it next; here only a switch from one chat to another is recorded.
  if (!reload && S.page === "chat") syncRoute();
  loadAll(key); // its agents may be older than the first screen's
  S.forceFork = false;
  history.render();
  const s0 = S.sessions.get(sid);
  const enc = encodeURIComponent(sid);
  const call = callOn(key);
  const loadToolOutput = (id, atByte, max) => call(`/api/sessions/${enc}/tool-output?id=${encodeURIComponent(id || "")}${atByte != null ? `&at=${atByte}` : ""}${max ? `&max=${max}` : ""}`);
  const wrap = $("#transcriptWrap"), follow = isFollowing(wrap);
  const view = newView(reload ? document.createElement("div") : $("#transcript"), wrap, sid, { cwd: s0?.cwd, openAgent, loadToolOutput, keepFollow: reload });
  S.view = view;
  updateHeader(); updateComposer(); renderAgents();
  if (s0?.cwd) explorer.setRoot(s0.cwd);
  try {
    const fetchedAt = Date.now();
    const h = await call(`/api/sessions/${encodeURIComponent(sid)}/history?page=${HISTORY_PAGE}`);
    if (S.selected !== sid || focusKey !== key || S.view !== view) return;
    if (h.session) S.sessions.set(sid, { ...(S.sessions.get(sid) || {}), ...h.session, tally: h.tally || S.sessions.get(sid)?.tally });
    const s = S.sessions.get(sid);
    view.cwd = s?.cwd || view.cwd;
    if (s?.cwd) explorer.setRoot(s.cwd);
    const seen = new Set();
    // Agent reports the history lacks come from the buffered live copies, in their place (withLiveReports).
    const events = withLiveReports(h.events, S.buffers.get(sid));
    for (const ev of events) { applyEvent(view, ev); if (ev.kind === "msg" && ev.id) seen.add(ev.id); }
    // A reopened chat gets its plan back from the plan tool's results in the file (live events keep it current after).
    const histPlan = planFromEvents(h.events) || asPlan(h.plan); // a plan older than this page comes beside it
    if (histPlan && s && !((s.goalBox?.plan?.updatedAt || 0) > (histPlan.updatedAt || 0))) { goalBox(s).plan = histPlan; renderSummary(); }
    // Live events buffered while the chat was open elsewhere: skip messages the file already gave us.
    // Anything older than the fetch is already in the file. The one exception: a turn still streaming has
    // partial text that is not written yet, so its stream parts (newer than the last file message) are replayed.
    const streaming = !!s?.streaming;
    for (const ev of S.buffers.get(sid) || []) {
      if ((ev.kind === "msg" && ev.id && seen.has(ev.id)) || agentReportKey(ev)) continue;
      if (ev.ts > fetchedAt) applyEvent(view, ev);
      else if (streaming && (ev.kind === "delta" || ev.kind === "block") && ev.ts > view.lastTs) applyEvent(view, ev);
    }
    if (!s?.streaming) finish(view);
    if (s?.forkedFrom) forkNote(view, { fromTitle: S.sessions.get(s.forkedFrom)?.title, onOpen: () => { selectSession(s.forkedFrom); } });
    if (isAgentChat(s)) {
      const parent = s.parentSid || agentFor(sid)?.parentSid;
      agentNote(view, { kind: s.agentKind || agentFor(sid)?.kind, parentTitle: S.sessions.get(parent)?.title, onOpen: parent && S.sessions.has(parent) ? () => openChat(parent) : null });
    }
    // The chat's file is read a page at a time: the newest now, older ones as the transcript is scrolled up.
    view.olderAt = h.more ? h.start : null;
    if (view.olderAt != null) setOlder(view, "more", () => loadOlder(view));
    if (!events.length && view.olderAt == null) emptyNote(view, "nothing here yet");
    if (reload) {
      // Measured from the bottom: the reload holds only the newest page, so what was above it may be gone until it loads again.
      const fromBottom = wrap.scrollHeight - wrap.scrollTop, shown = $("#transcript");
      shown.replaceChildren(...view.root.childNodes);
      view.root = shown;
      wrap.scrollTop = follow ? wrap.scrollHeight : wrap.scrollHeight - fromBottom;
    } else wrap.scrollTop = wrap.scrollHeight;
    maybeLoadOlder();
  } catch (e) {
    if (focusKey !== key) return;
    // Said where the chat would be. A reload keeps what is on the screen, so only then is it news from elsewhere.
    if (reload && S.selected === sid) { S.view = previous; toast(`This chat did not refresh${whereOn(key)}. ${e.message}`, true); }
    else if (S.view === view) emptyNote(view, `This chat did not load${whereOn(key)}. ${e.message}`);
  }
  updateHeader(); updateComposer();
  if (document.body.classList.contains("panel-open")) panel.renderStats();
}
/** Scrolled near the top of a chat whose start is not shown yet: load the next older page. */
const OLDER_AT_PX = 600;
function maybeLoadOlder() {
  const view = S.view;
  if (view?.olderAt == null || view.loadingOlder || view.olderFailed) return;
  if ($("#transcriptWrap").scrollTop < OLDER_AT_PX) loadOlder(view);
}
async function loadOlder(view) {
  if (view.olderAt == null || view.loadingOlder) return;
  view.loadingOlder = true; view.olderFailed = false;
  setOlder(view, "loading");
  try {
    const h = await api(`/api/sessions/${encodeURIComponent(view.sid)}/history?before=${view.olderAt}&page=${HISTORY_PAGE}`);
    if (S.view !== view) return;
    const wrap = $("#transcriptWrap");
    // Keep what is on screen where it is: the page goes in above it.
    const fromBottom = wrap.scrollHeight - wrap.scrollTop;
    prependHistory(view, h.events || []);
    view.olderAt = h.more ? h.start : null;
    setOlder(view, view.olderAt != null ? "more" : null, () => loadOlder(view));
    wrap.scrollTop = wrap.scrollHeight - fromBottom;
  } catch (e) {
    view.olderFailed = true;
    if (S.view === view) setOlder(view, "error", () => loadOlder(view));
  } finally { view.loadingOlder = false; }
  // A short page may leave the top still in view.
  if (S.view === view) maybeLoadOlder();
}
function updateHeader() {
  const s = S.page === "chat" ? S.sessions.get(S.selected) : null;
  updateTitle();
  const model = s?.model || (s ? "" : S.config?.piModel) || "";
  // A foreign chat's model is labelled with its harness so the slot never implies pi is running it.
  $("#topModel").textContent = s && s.harness !== "pi" && model ? `${model} (${harnessLabel(s.harness)})` : model;
  $("#topModel").hidden = !model;
  $("#topModel").title = s ? `${harnessLabel(s.harness)}${s.cwd ? ` in ${s.cwd}` : ""}` : S.pi.cwd || "";
}
function renderChatMenu() {
  const m = $("#chatMenu"); m.innerHTML = "";
  const s = S.sessions.get(S.selected); if (!s) return;
  const item = (label, fn, on) => { const b = el("button", on ? "on" : "", label); b.onclick = () => { m.hidden = true; fn(); }; m.appendChild(b); };
  if (s.harness === "pi") item("Fork into a new chat with the next message", () => { S.forceFork = !S.forceFork; updateComposer(); chat.focus(); }, S.forceFork);
  item("Save a digest to memory", async () => { try { const r = await api("/api/memory/digest", { sid: s.sid }); toast(`Digest saved to ${r.path}`); } catch (e) { toast(e.message, true); } });
  item("Copy the chat id", () => navigator.clipboard?.writeText(s.sid.split(":").slice(1).join(":")).then(() => toast("Copied")).catch(() => {}));
  item("Tokens for this chat", () => panel.open("tokens"));
  if (s.forkedFrom) item("Open the original chat", () => selectSession(s.forkedFrom));
  const parent = s.parentSid || agentFor(s.sid)?.parentSid;
  if (parent && S.sessions.has(parent)) item("Open the chat that started this agent", () => openChat(parent));
  item("Delete this chat", () => deleteChat(focusKey, s.sid));
  m.appendChild(el("div", "mh", `${harnessLabel(s.harness)}${whereWords(MACHINES, focusKey) ? ` on ${whereWords(MACHINES, focusKey)}` : ""}${s.cwd ? `, in ${baseName(s.cwd)}` : ""}`));
}
$("#transcriptWrap").addEventListener("scroll", maybeLoadOlder, { passive: true });
$("#btnChatMenu").onclick =(e) => { e.stopPropagation(); const m = $("#chatMenu"); if (m.hidden) renderChatMenu(); m.hidden = !m.hidden; };
document.addEventListener("click", (e) => { if (!e.target.closest("#chatMenu, #btnChatMenu")) $("#chatMenu").hidden = true; });
$("#btnExplorer").onclick = () => { explorer.setRoot(currentDir()); setExplorer(!document.body.classList.contains("explorer-open"), true); };
$("#btnSummary").onclick = () => { try { localStorage.setItem("omni.summary", summaryOn() ? "off" : "on"); } catch { /* */ } renderSummary(); };
$("#btnSettings").onclick = () => openSettings();
$("#machineBtn").onclick = (e) => { e.stopPropagation(); account.openMenu(); };
$("#machineBack").onclick = () => chooseMachine(null, null);
document.addEventListener("click", (e) => { if (!e.target.closest("#machineMenu, #machineBtn")) $("#machineMenu").hidden = true; });
/** A select of the account's machines, for the views that are one machine's (Home, Missions, Settings). */
function machineSelect(value, onPick, label) {
  const sel = el("select");
  sel.setAttribute("aria-label", label);
  for (const m of MACHINES) {
    const o = el("option", null, `${m.label}${m.state === "offline" ? " (offline)" : m.state === "refusing" ? " (does not let web pages in)" : ""}`);
    o.value = m.key;
    o.disabled = m.state === "offline" || m.state === "refusing";
    sel.appendChild(o);
  }
  sel.value = value;
  sel.onchange = () => onPick(sel.value, sel);
  return sel;
}
// Missions: the orchestrator/worker view (ui/mission.js). Its badge counts unread notifications across missions.
// Its code (and the office's) is not the first screen's: it loads once that has painted, or at once when Missions is opened, and
// what the stream says meanwhile waits for it in order. Its missions are the focused machine's.
const missionView = (() => {
  let view = null, loading = null;
  const waiting = [];
  const missionApi = (path, body, method) => {
    const key = focusKey;
    return api(path, body, method).then((r) => {
      // A list that comes back after the window moved on is the last machine's: it is not shown as this one's.
      if (key !== focusKey && !(body || (method && method !== "GET"))) throw new Error(`that answer came from ${labelOf(key)}`);
      return r;
    });
  };
  const ready = () => loading ??= import("./mission.js").then(({ createMissionView }) => {
    view = createMissionView({
      root: $("#view-mission"), api: missionApi, toast, onOpenChat: (sid) => openChat(sid), sessionOf: (sid) => S.sessions.get(sid) || null,
      defaultDir: () => homeCwd(), defaultModel: () => S.pi.state?.model?.id ? { provider: S.pi.state.model.provider || "", id: S.pi.state.model.id } : (S.config?.piModel ? { provider: S.config.piProvider || "", id: S.config.piModel } : null),
      machinePicker: () => {
        if (MACHINES.length < 2) return null;
        const row = el("label", "ms-machine");
        row.append(el("span", null, "Missions on"), machineSelect(focusKey, (key, sel) => { if (!focusMachine(key)) sel.value = focusKey; }, "The machine these missions are on"));
        return row;
      },
      machineSig: () => `${focusKey}|${MACHINES.map((m) => `${m.key}:${m.state}:${m.label}`).join(",")}`,
      where: () => whereOn(),
    });
    view.onBadge((n) => { const b = $("#missionsBadge"); b.hidden = !n; b.textContent = n > 99 ? "99+" : String(n); });
    for (const [name, args] of waiting.splice(0)) view[name](...args);
    return view;
  }, (e) => { loading = null; $("#view-mission").replaceChildren(el("p", "ms-empty-sub err ms-empty", `Missions did not load. ${e.message}`)); throw e; });
  const call = (name) => (...args) => { if (view) view[name](...args); else waiting.push([name, args]); };
  return { ready, load: () => ready().then((v) => v.load()).catch(() => {}), reset: () => view?.reset(), render: () => view?.render(), onAgent: call("onAgent"), onMission: call("onMission"), onRemoved: call("onRemoved"), onNotify: call("onNotify"), onStatus: call("onStatus") };
})();
$("#btnMissions").onclick = () => showView("mission");

// --------------------------------------------------------- one window, every machine
const HERO = { title: $(".hero").textContent };
let homeSig = "";
/** What on the screen says which machine the window is on: the bar, the home screen, the title, the pickers. */
function machineChrome() {
  const m = focusM();
  const far = !!m && !m.here;
  document.body.classList.toggle("on-remote", far);
  $(".hero").textContent = far ? `What should ${m.label} work on?` : HERO.title;
  $("#connStatus").title = far ? `The connection to ${m.label} dropped. It reconnects by itself.` : "The connection dropped. It reconnects by itself.";
  $("#connStatus").textContent = far ? `Reconnecting to ${m.label}` : "Reconnecting";
  $("#connStatus").hidden = !down.has(focusKey);
  const row = $("#homeMachineRow");
  row.hidden = MACHINES.length < 2;
  // Drawn again only when something in it changed: a list open under the pointer is not swapped out.
  const sig = `${focusKey}|${MACHINES.map((x) => `${x.key}:${x.state}:${x.label}`).join(",")}`;
  if (!row.hidden && sig !== homeSig) {
    homeSig = sig;
    const sel = machineSelect(focusKey, (key, s) => { if (!focusMachine(key)) s.value = focusKey; renderHome(); }, "The machine the new chat runs on");
    sel.id = "homeMachine";
    $("#homeMachine").replaceWith(sel);
  }
  renderSettingsMachine(settings.tab);
  missionView.render();
  updateTitle();
}
/** Settings → Models, MCP servers and Long runs are one machine's: which one, and a way to pick another. */
function renderSettingsMachine(tab) {
  const box = $("#settingsMachine");
  if (!box) return;
  const machineTab = ["models", "mcp", "long"].includes(tab);
  box.hidden = !machineTab || MACHINES.length < 2;
  if (box.hidden) return;
  $("#settingsMachineText").textContent = "Settings for";
  const sel = machineSelect(settingsOn(), (key) => { settingsKey = key; settings.reload(); }, "The machine these settings are for");
  sel.id = "settingsMachineSel";
  $("#settingsMachineSel").replaceWith(sel);
}

/**
 * Takes the window to another machine: the open chat closes (its draft is kept), the file tree and tabs are that machine's,
 * the pickers and the bar say where it is. Never reloads. Unsaved files are asked about first, and No changes nothing.
 */
function focusMachine(key, { whenClean = false } = {}) {
  if (key === focusKey) return true;
  const m = byKey(key);
  if (!m) return false;
  if (!m.here && (m.state === "offline" || m.state === "refusing")) { toast(m.state === "offline" ? `${m.label} is offline. Nothing was sent to it.` : `${m.label} does not let web pages in. Allow web page access is off there.`, true); return false; }
  keepDraft();
  if (!setMachine(m.here ? null : m.id, { name: m.label, whenClean })) return false;
  explorer.switchMachine();
  if (S.view) finish(S.view);
  S.selected = null; S.view = null; S.forceFork = false;
  wsOf(focusKey).homeCwd = $("#homeCwd").value;
  const old = wsOf(focusKey);
  for (const f of SWAP) old[f] = S[f];
  const ws = wsOf(key);
  for (const f of SWAP) S[f] = ws[f];
  focusKey = key;
  agentLiveAt.clear(); logOpen.clear(); logText.clear(); stripSig = "";
  $("#homeCwd").value = ws.homeCwd || S.pi.cwd || S.config?.cwd || "";
  $("#transcript").textContent = "";
  modelsShown = false;
  missionView.reset();
  account.refocus();
  machineChrome();
  if (!ws.loaded) loadFirst(key); else refreshFirst(key);
  loadPiChoices().catch(() => {});
  if (S.page === "chat") showView("home");
  else if (S.page === "mission") missionView.load();
  else renderHome();
  panel.refresh();
  history.render();
  return true;
}
/** From the account's machine menu: a machine to start a chat on, or (null) this computer. Says whether the window went. */
function chooseMachine(id, _name, options = {}) {
  const ok = focusMachine(id ?? HERE, options);
  if (ok && S.page !== "home") showView("home");
  return ok;
}

/** A machine's first state: its recent chats and what is running, one small answer (P3's `first=1`). */
function applyFirst(ws, st) {
  ws.config = st.config; ws.pi = st.pi || { running: false }; ws.piChats = piChatsOf(st.pis || []); ws.runs = st.runs || []; ws.hook = st.hook || null;
  if (!ws.loaded) { ws.boot = st.boot || ""; ws.seq = 0; }
  for (const s of st.sessions || []) { ws.sessions.set(s.sid, { ...(ws.sessions.get(s.sid) || {}), ...s }); if (s.agentId) ws.agentSids.set(s.sid, s.agentId); }
  for (const a of st.agents || []) putAgentIn(ws, a);
  // The goal each running chat is working on right now (plan, status, re-engages) survives a page reload.
  const goals = (st.pis || []).filter((c) => c.goal?.goal).map((c) => [c.sid, c.goal]);
  if (!goals.length && st.goal && st.pi?.sid) goals.push([st.pi.sid, st.goal]);
  for (const [sid, g] of goals) {
    const s = ws.sessions.get(sid);
    if (!s) continue;
    Object.assign(goalBox(s), { goal: g.goal, explicit: g.explicit, plan: g.plan, summary: g.summary, summaryAt: g.summaryAt, nudges: g.nudges, done: g.done });
    Object.assign(s, { hookArmed: !!g.armed, hookRetryAt: g.retryAt || 0 });
  }
  ws.allChats = ws.allChats || !(st.sessionsTotal > (st.sessions || []).length);
  ws.access = st.access;
}
/** Loads a machine's first state, once at a time. A failure stays on its group in the sidebar, by name, with Try again. */
function loadFirst(key) {
  const ws = wsOf(key);
  if (ws.loading) return ws.loading;
  ws.error = null; ws.errorCode = null;
  history.render();
  ws.loading = handleOf(key).api("GET", "/api/state?first=1").then((st) => {
    applyFirst(ws, st);
    ws.loaded = true;
    if (key === focusKey) {
      for (const f of SWAP) S[f] = ws[f];
      account.machineUp();
      loadPiChoices().catch(() => {});
      if (S.page === "home") renderHome(); else updateComposer();
    }
    return st;
  }, (e) => {
    ws.error = byKey(key)?.here ? e.message : `${e.message}`;
    ws.errorCode = e.code ?? null;
    if (key === focusKey) account.machineDown(e.message);
    return null;
  }).finally(() => { ws.loading = null; syncStreams(); history.render(); });
  return ws.loading;
}
/** A machine the window comes back to: what is running there now (the chats came live meanwhile). */
async function refreshFirst(key) {
  try {
    const st = await handleOf(key).api("GET", "/api/state?first=1");
    const ws = wsOf(key);
    if (key === focusKey) for (const f of SWAP) ws[f] = S[f];
    applyFirst(ws, st);
    if (key === focusKey) { for (const f of SWAP) S[f] = ws[f]; if (S.page === "home") renderHome(); else updateComposer(); }
  } catch (e) { if (key === focusKey) toast(`${labelOf(key)} did not answer. ${e.message}`, true); }
}
/** Every chat of a machine, once: when its chats are asked for. The focused machine's goes through refreshState. */
const loadingAll = new Map();
function loadAll(key) {
  const ws = wsOf(key);
  if (ws.allChats || !ws.loaded || loadingAll.has(key)) return;
  const done = key === focusKey
    ? refreshState()
    : handleOf(key).api("GET", "/api/state").then((st) => mergeAll(ws, st), (e) => toast(`Older chats${whereOn(key)} did not load. ${e.message}`, true));
  loadingAll.set(key, done.finally(() => { loadingAll.delete(key); history.render(); renderAgents(); }));
}

/** The account's machines changed: who is there, who is online. New ones load their first state; gone ones stop. */
const lastState = new Map();
function setMachines(list, status) {
  const here = webPage() ? null : { name: status?.device?.name || "This computer" };
  if (!webPage() && status?.device?.id) hereId = status.device.id;
  MACHINES = machineList({ here, machines: list });
  for (const m of MACHINES) {
    const ws = wsOf(m.key);
    const was = lastState.get(m.key);
    lastState.set(m.key, m.state);
    if (m.here) continue;
    const usable = m.state === "online" || m.state === "stalled";
    // Back online after a failure: it is asked again. Offline or refusing: nothing is fetched from it.
    if (usable && ws.error && was && was !== m.state) { ws.error = null; }
    if (usable && !ws.loaded && !ws.loading && !ws.error) loadFirst(m.key);
  }
  // A page whose machine has left the account goes to another: it has no computer of its own.
  // So does one opened on a machine that turned it away before showing anything: nothing of it was ever on the screen.
  const focused = MACHINES.find((m) => m.key === focusKey);
  if (webPage() && MACHINES.length && (!focused || (focused.state === "refusing" && !wsOf(focusKey).loaded))) {
    const next = MACHINES.find((m) => m.state === "online");
    if (next) focusMachine(next.key, { whenClean: true });
  }
  syncStreams();
  machineChrome();
  if (S.page === "home") renderHome(); else if (S.page === "chat") updateComposer();
  history.render();
  // A chat link for a machine the account had not listed yet opens now that it has.
  if (pendingRoute && keyFromUrl(pendingRoute.machine) != null) applyRoute(pendingRoute);
  // This computer's URL name may just have become its device id.
  else if (S.page === "chat" && focusKey === HERE && location.hash !== routeHash()) window.history.replaceState(null, "", routeUrl(routeHash()));
}

// ------------------------------------------------------------------ SSE
// One live stream per machine, each with its own seq + boot so a reconnect asks for exactly what it missed (server/bus.mjs).
// On the desktop, this computer's is its own /events and every other machine's comes through one merged stream
// (/remote/~events): a browser holds six connections to a host, and one each would spend them. A web page holds one per
// machine over its channels. A slow machine holds up none of the others.
const down = new Set(); // machines whose stream is down
const eventsUrl = (ws) => `/events?since=${ws.seq}${ws.boot ? `&boot=${encodeURIComponent(ws.boot)}` : ""}`;
function streamUp(key) { down.delete(key); wsOf(key).streamError = null; if (key === focusKey) { $("#connStatus").hidden = true; updateHeader(); } history.render(); }
function streamDown(key, why) {
  down.add(key);
  if (why) wsOf(key).streamError = why;
  if (key === focusKey) { $("#connStatus").hidden = false; if (key === HERE) checkSignedIn(); }
  history.render();
}
/** One event of a machine's stream: to its workspace, and to the screen if that machine is the one shown. */
function dispatch(key, text) {
  let ev;
  try { ev = JSON.parse(text); } catch { return; }
  const ws = W.get(key);
  if (!ws) return;
  ws.seq = Math.max(ws.seq, ev.seq || 0);
  if (key === focusKey) { handle(ev); return; }
  if (ev.kind === "agent" && ev.agent?.id) putAgentIn(ws, ev.agent);
  else if (ev.kind === "pis" && Array.isArray(ev.pis)) ws.piChats = piChatsOf(ev.pis);
  else applySessionEvent(ws, ev);
  scheduleRail();
}
/** What a machine's stream missed is gone (the ring wrapped, or its server restarted): count from the replay, and reload it. */
function resyncMachine(key, text) {
  let r = {};
  try { r = JSON.parse(text); } catch { /* */ }
  const ws = wsOf(key);
  ws.boot = r.boot || ""; ws.seq = 0;
  if (key === focusKey) resync();
  else refreshFirst(key);
}
/** A machine's own stream: this computer's, or one machine's over the page's channel. */
function machineStream(m) {
  const key = m.key;
  return createStream({
    url: () => eventsUrl(wsOf(key)),
    EventSource: function MachineEvents(url) { return handleOf(key).eventSource(url); }, // called with new: what it returns is the stream
    onMessage: (msg) => dispatch(key, msg.data),
    on: streamEvents(m.id ? m : null, {
      // Only this computer's own stream carries these: remote changes waiting for Approve/Deny.
      approvals: (msg) => { try { remote.setApprovals(JSON.parse(msg.data)); } catch { /* */ } },
      resync: (msg) => resyncMachine(key, msg.data),
    }),
    onUp: () => streamUp(key),
    onDown: () => streamDown(key),
  });
}
const streams = new Map(); // key → stream, for this computer and (on a page) each machine
let merged = null, mergedSig = "";
/** Streams follow the machines: one for each that is online and has shown its first state, none for the rest. */
function syncStreams() {
  const live = (m) => (m.here || m.state === "online" || m.state === "stalled") && W.get(m.key)?.loaded;
  const wanted = MACHINES.filter(live);
  if (!webPage() && !MACHINES.length && W.get(HERE)?.loaded) wanted.push(byKey(HERE));
  const own = webPage() ? wanted : wanted.filter((m) => m.here);
  for (const m of own) if (!streams.has(m.key)) { const s = machineStream(m); streams.set(m.key, s); s.start(); }
  for (const [key, s] of streams) if (!own.some((m) => m.key === key)) { s.stop(); streams.delete(key); down.delete(key); }
  if (webPage()) return;
  const far = wanted.filter((m) => !m.here);
  const sig = far.map((m) => m.id).join(",");
  if (sig === mergedSig) return;
  mergedSig = sig;
  merged?.stop();
  merged = null;
  for (const m of MACHINES) if (!m.here && !far.includes(m)) down.delete(m.key);
  if (!far.length) return;
  const ids = new Set(far.map((m) => m.id));
  merged = createStream({
    url: () => mergedEventsUrl([...ids].map((id) => ({ id, seq: wsOf(id).seq, boot: wsOf(id).boot }))),
    EventSource: function OtherMachines(url) { return local.eventSource(url); },
    onMessage: () => {},
    on: {
      m: (msg) => { const x = fromMerged(msg.data, ids); if (!x) return; if (x.name === "resync") resyncMachine(x.id, x.data); else dispatch(x.id, x.data); },
      link: (msg) => { let x; try { x = JSON.parse(msg.data); } catch { return; } if (!ids.has(x?.id)) return; if (x.up) streamUp(x.id); else streamDown(x.id, `not answering: ${String(x.error || "the connection was lost").slice(0, 200)}`); },
    },
    onUp: () => {},
    onDown: () => { for (const id of ids) streamDown(id); },
  });
  merged.start();
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") pokeStreams(); });
window.addEventListener("online", () => pokeStreams());
function pokeStreams() { for (const s of streams.values()) s.poke(); merged?.poke(); }
/** EventSource cannot see a 401, so a remote browser whose session ended (the server restarted, the password
 *  changed, it expired) retried "reconnecting" forever. After a drop, ask once; api() reloads to the sign-in page. */
let probing = false;
function checkSignedIn() {
  if (remote.role !== "remote" || probing) return;
  probing = true;
  hereApi("/api/remote/me").catch(() => {}).finally(() => { probing = false; });
}
async function resync() {
  await refreshState();
  history.render();
  if (S.page === "chat" && S.selected) {
    // The open chat reloads (the live stream lost events): the reader stays where they are.
    await selectSession(S.selected, { reload: true });
  }
}
let railTimer = null;
function scheduleRail() {
  if (!railTimer) railTimer = setTimeout(() => { railTimer = null; if (document.body.classList.contains("panel-open")) history.render(); if (S.page === "home") renderHome(); else updateComposer(); }, 250);
}
/** One event of the focused machine's stream. */
function handle(ev) {
  // A background agent's record changed (`sid` is its parent chat, or "agents"): no chat of its own to update.
  if (ev.kind === "agent") { onAgent(ev.agent); if (ev.agent?.missionId) missionView.onAgent(ev.agent); return; }
  if (ev.kind === "mission") { missionView.onMission(ev.mission); return; }
  if (ev.kind === "mission-removed") { missionView.onRemoved(ev.missionId); return; }
  if (ev.kind === "notify") { if ((ev.ts || 0) >= BOOT_TS) missionView.onNotify(ev); return; }
  // Which chats have a pi child right now (one per chat that runs at once).
  if (ev.kind === "pis") { setPiChats(ev.pis); if (S.page === "chat") updateComposer(); return; }
  if (ev.kind === "removed") { S.sessions.delete(ev.sid); S.buffers.delete(ev.sid); if (S.selected === ev.sid) { S.selected = null; S.view = null; showView("home"); } history.render(); return; }
  if (ev.kind === "log") { if (ev.level === "system" && (ev.ts || 0) >= BOOT_TS) toast(ev.text); else if (ev.level === "graphify" && ev.text) panel.graphLine(ev.text.split("\n").pop()); else if (ev.level === "hook" && ev.text && (ev.ts || 0) >= BOOT_TS && /failed|gave up|not JSON/.test(ev.text)) toast(ev.text, true); return; }
  const s = applySessionEvent(S, ev);
  if (!s) return;
  if (ev.kind === "status" && s.missionRole === "orchestrator" && S.page === "mission") missionView.onStatus(ev);
  if (ev.kind === "digest") toast(`Digest saved to ${ev.path}`);
  if ((ev.kind === "summary" || ev.kind === "plan" || ev.kind === "goal" || (ev.kind === "hook" && ev.attempt)) && ev.sid === S.selected) renderSummary();
  if (ev.kind === "keeper" && ev.sid === S.selected) updateComposer();
  // A background pi agent is owned too, but it is its own pi process: it must not pass for Omni's main pi.
  if (ev.harness === "pi" && s.owned && !isAgentChat(s) && !s.missionId) {
    S.pi.running = true;
    if (ev.kind === "session") {
      if (ev.cwd) S.pi.cwd = ev.cwd;
      if (ev.sessionId) S.pi.sid = ev.sid;
      if (ev.model) S.pi.state = { ...(S.pi.state || {}), model: { ...(S.pi.state?.model || {}), id: ev.model, provider: ev.provider || S.pi.state?.model?.provider }, thinkingLevel: ev.thinkingLevel || S.pi.state?.thinkingLevel };
      // The chat's own child (a model switch, a new session): the `pis` event that follows carries the full list.
      if (ev.sessionId) S.piChats.set(ev.sid, { ...(S.piChats.get(ev.sid) || {}), sid: ev.sid, cwd: ev.cwd || S.piChats.get(ev.sid)?.cwd, ...(ev.model ? { model: { provider: ev.provider || "", id: ev.model } } : {}), ...(ev.thinkingLevel ? { thinkingLevel: ev.thinkingLevel } : {}) });
      loadPiChoices();
    }
    updateHeader();
  }
  if (ev.kind === "session" && ev.forkedFrom && S.followFork && ev.forkedFrom === S.followFork) { S.followFork = null; openChat(ev.sid); }
  if (ev.sid === S.selected && S.view) { applyEvent(S.view, ev); if ((ev.kind === "msg" || ev.kind === "run") && document.body.classList.contains("panel-open")) panel.renderStats(); if (ev.kind === "status" || ev.kind === "session") { updateHeader(); updateComposer(); } }
  scheduleRail();
}

// ------------------------------------------------------------- keyboard
/** The palette's rows: the main actions, then every chat the window has listed, on every machine that is reachable, newest first. */
function paletteItems() {
  const actions = [
    { title: "New chat", keys: "mod+shift+o", run: newChat },
    ...(S.page === "chat" && chat.streaming ? [{ title: "Stop the answer", keys: "mod+.", run: stopNow }] : []),
    { title: "Show or hide the files", keys: "mod+b", run: toggleFiles },
    { title: "Show or hide the chat history", keys: "mod+\\", run: toggleHistory },
    { title: "Missions", run: () => showView("mission") },
    { title: "Settings", run: () => openSettings() },
    { title: "Keyboard shortcuts", keys: "?", run: () => openShortcuts() },
  ].map((a) => ({ ...a, group: "Actions" }));
  const chats = [];
  const list = MACHINES.length ? MACHINES : [focusM()].filter(Boolean);
  for (const m of list) {
    if (m.state === "offline" || m.state === "refusing") continue;
    const ws = m.key === focusKey ? S : W.get(m.key);
    if (!ws?.sessions) continue;
    for (const s of ws.sessions.values()) {
      const title = agentIn(ws, s.sid)?.title || s.title;
      if (!title) continue;
      const when = s.lastActivity || s.mtime || 0;
      chats.push({ group: "Chats", title, sub: [list.length > 1 ? m.label : "", ago(when)].filter(Boolean).join(" · "), when, run: () => openChatOn(m.key, s.sid) });
    }
  }
  chats.sort((a, b) => b.when - a.when);
  return [...actions, ...chats.slice(0, 300)];
}
function newChat() { showView("home"); home.focus(); }
function stopNow() { if (S.page === "chat" && chat.streaming) chatStop(); }
function toggleFiles() { if (S.page === "chat") $("#btnExplorer").click(); else if (S.page === "home") $("#homeBrowse").click(); }
function toggleHistory() { if (document.body.classList.contains("panel-open")) panel.setOpen(false); else panel.open("chats"); }
installKeys({
  palette: () => openPalette(paletteItems),
  "new-chat": newChat,
  stop: stopNow,
  files: toggleFiles,
  history: toggleHistory,
  shortcuts: () => openShortcuts(),
  "focus-composer": () => (S.page === "chat" ? chat : home).focus(),
});

// ----------------------------------------------------------------- init
async function init() {
  if (S.desktop) document.body.classList.add("desktop");
  initResizers();
  // A desktop window opens on this computer; the other machines come into the drawer as the account names them.
  if (!webPage()) setMachine(null, { whenClean: true });
  for (const f of SWAP) S[f] = wsOf(focusKey)[f];
  machineChrome();
  account.init().catch(() => {}); // never waited for: local use does not depend on the account
  // The first screen's state is the recent chats and what is running: one small answer. The rest follows once it has painted.
  const st = await loadFirst(focusKey);
  if (!st) {
    if (!webPage()) throw new Error(wsOf(focusKey).error || "no answer");
    // The URL is kept: once the machine answers, a reload opens what it names.
    history.render(); applyingRoute = true; try { showView("home"); } finally { applyingRoute = false; } return;
  }
  remote.init(st.access);
  if (!webPage() && st.access?.role !== "remote" && st.config?.lanUrls?.length) { $("#lanInfo").textContent = st.config.lanUrls[0]; $("#lanInfo").title = "Open this on another device and sign in with the remote password from Settings, Remote. It is read-only there, and every change waits for your approval."; }
  history.render();
  // The URL says where to open: #missions (a link, a bookmark, the phone's home screen), a chat, or Home.
  const route = parseHash(location.hash);
  applyingRoute = true;
  try { showView(route.kind === "missions" ? "mission" : "home"); } finally { applyingRoute = false; }
  if (route.kind === "chat") applyRoute(route);
  syncStreams();
  setInterval(() => { if (document.body.classList.contains("panel-open")) history.render(); if (S.page === "chat") updateComposer(); }, 15000);
  afterFirstPaint();
}
/** What no part of the first screen waits for: the model list (shown from the last one seen until then), and Missions. */
function afterFirstPaint() {
  loadPiChoices().catch(() => {});
  const later = globalThis.requestIdleCallback ?? ((fn) => setTimeout(fn, 200));
  later(() => missionView.ready().catch(() => {}));
}
init().catch((e) => { if (webPage()) account.machineDown(e.message); else toast(`Omni Agent did not start. ${e.message}`, true); });
