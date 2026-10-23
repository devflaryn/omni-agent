/* Omni Agent front end. Home (one container) → Chat (explorer | preview | transcript). Right drawer: Chats / Memory / Graph / Tokens. pi only. */
import { el, baseName, cleanTitle, applyStatus, AGENT_ACTIVE, agentTone, agentKindLabel, agentTitle, agentsFor, agentSummary, agentSubline, agentElapsed, agentReportKey, withLiveReports, mergeAgentSnapshot } from "./lib.js";
import { newView, applyEvent, finish, forkNote, agentNote, emptyNote } from "./transcript.js";
import { createComposer } from "./composer.js";
import { createHistory } from "./sidebar.js";
import { createPanel } from "./panel.js";
import { createExplorer } from "./explorer.js";
import { createSettings } from "./settings.js";
import { initResizers } from "./resizer.js";
import { asPlan, planProgress, PLAN_TOOL } from "./plan.js";
import { createRemote } from "./remote.js";
import { createStream } from "./stream.js";

const $ = (s) => document.querySelector(s);
// agents: background agents by id (/api/state + live `agent` events); agentSids: an agent chat's sid → agent id;
// agentsOpen: chats whose folded agents strip the user expanded.
const S = { sessions: new Map(), selected: null, pi: { running: false }, piChats: new Map(), runs: [], seq: 0, buffers: new Map(), view: null, page: "home", config: null, followFork: null, forceFork: false, agents: new Map(), agentSids: new Map(), agentsOpen: new Set(), desktop: new URLSearchParams(location.search).get("desktop") === "1" };
const liveWindowMs = () => S.config?.liveWindowMs || 30000;
/** Events replayed by the SSE stream at connect time predate this; their system toasts are stale. */
const BOOT_TS = Date.now();

/** What a remote browser may do without the host's approval (mirrors server/access.mjs READ). */
const REMOTE_FREE = /^\/api\/(graph\/(query|explain)|remote\/(login|logout))$/;
async function api(path, body, method) {
  const verb = body || (method && method !== "GET") ? method || "POST" : "GET";
  // A remote change is held open by the server until the host decides: say so while it waits.
  if (remote.role === "remote" && verb !== "GET" && !REMOTE_FREE.test(path)) toast("Waiting for the host to approve…");
  const r = await fetch(path, verb !== "GET" ? { method: verb, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined } : { method: "GET" });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && j.login) { location.reload(); throw new Error("signed out"); }
  if (!r.ok || j.error) throw new Error(j.error || `${r.status}`);
  return j;
}
function toast(text, err) { const t = el("div", `toast${err ? " err" : ""}`, text); $("#toasts").appendChild(t); setTimeout(() => t.remove(), err ? 7000 : 3500); }
const remote = createRemote({ api, toast });
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

// ------------------------------------------------------------- agents
/** The agent record behind a chat (pi or Claude agent), or null for an ordinary chat. */
const agentFor = (sid) => (sid && S.agentSids.has(sid) ? S.agents.get(S.agentSids.get(sid)) || null : null);
/** A background agent's chat: its own pi process (never Omni's main pi) or a Claude Code run another chat started. */
const isAgentChat = (s) => !!(s && (s.parentSid || s.agentId || S.agentSids.has(s.sid)));
function putAgent(a) {
  if (!a?.id) return;
  S.agents.set(a.id, a);
  if (!a.sid) return;
  S.agentSids.set(a.sid, a.id);
  const s = S.sessions.get(a.sid);
  if (s) { s.parentSid = s.parentSid || a.parentSid || undefined; s.agentId = s.agentId || a.id; s.agentKind = s.agentKind || a.kind; }
}
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
const history = createHistory({ S, onSelect: openChat, onNew: () => { showView("home"); home.focus(); }, onDelete: deleteChat, agentFor });
const panel = createPanel({ S, api, toast, onSelect: openChat, currentDir, getPiContextWindow: () => S.pi.state?.model?.contextWindow, onShowChats: () => history.render() });
const explorer = createExplorer({ api, toast, insert: (t) => (S.page === "chat" ? chat : home).insert(t), onClose: () => setExplorer(false, S.page === "chat") });
const settings = createSettings({ api, toast, onChanged: () => { loadPiChoices(); refreshState(); }, loadRemote: () => remote.loadSettings(), getContext: () => S.config?.context, onContext: (context) => { S.config = { ...(S.config || {}), context }; } });
const composerHooks = { onPickFile: () => { explorer.setRoot(currentDir()); setExplorer(true); }, onPiModel: setPiModel, onPiThinking: setPiThinking, onManageProviders: () => settings.open(), onHook: setHook };
const home = createComposer($("#homeComposer"), { ...composerHooks, onSend: homeSend });
// In a background agent's chat the picker shows the agent's model; picking there would change Omni's own pi.
const notForAgents = (fn) => (...args) => { if (target().kind !== "agent") return fn(...args); toast("A background agent keeps the model it started with; this picker sets Omni's own chat model. Pick it from one of its chats.", true); updateComposer(); };
const chat = createComposer($("#chatComposer"), { ...composerHooks, onPiModel: notForAgents(setPiModel), onPiThinking: notForAgents(setPiThinking), onHook: notForAgents(setHook), onSend: chatSend, onStop: chatStop });

/** Choices made before pi runs are saved on the server and applied when it starts, so the picker never "forgets". */
/** The open chat when it has a pi child of its own: a model, thinking or goal change is for that chat. */
const piChatSid = () => (S.page === "chat" && S.piChats.has(S.selected) ? S.selected : undefined);
async function setPiModel(provider, id) {
  try {
    const sid = piChatSid();
    const r = await api("/api/pi/model", { provider, modelId: id, sid });
    if (sid) { const c = S.piChats.get(sid); if (c) c.model = { provider, id }; }
    // The server moves the thinking level to the nearest one the new model has.
    S.config = { ...(S.config || {}), piProvider: provider, piModel: id, ...(r.level ? { piThinking: r.level } : {}) };
    loadPiChoices();
    toast(r.pending ? `Model: ${id} (applies when OpenCode starts)` : `Model: ${id}`);
    if (S.page === "home") renderHome(); else updateComposer();
  } catch (e) { toast(e.message, true); }
}
async function setPiThinking(level) {
  try {
    const sid = piChatSid();
    const r = await api("/api/pi/thinking", { level, sid });
    S.config = { ...(S.config || {}), piThinking: r.level || level };
    if (sid) { const c = S.piChats.get(sid); if (c) c.thinkingLevel = r.level || level; }
    if (S.page === "home") renderHome(); else updateComposer();
  } catch (e) { toast(e.message, true); }
}
async function loadPiChoices() {
  const [m, l] = await Promise.allSettled([api("/api/pi/models"), api("/api/pi/thinking-levels")]);
  const choices = {};
  const models = m.status === "fulfilled" ? (m.value.data?.models || []) : [];
  const levels = l.status === "fulfilled" ? (l.value.data?.levels || []) : [];
  if (m.status === "fulfilled") choices.models = models;
  if (levels.length) { choices.levels = levels; choices.labels = l.value.data?.labels || {}; }
  if (Object.keys(choices).length) { home.setPiChoices(choices); chat.setPiChoices(choices); }
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
function setPiChats(list) {
  if (!Array.isArray(list)) return;
  S.piChats = new Map(list.filter((c) => c?.sid && c.sid !== "pi:pending").map((c) => [c.sid, c]));
}
async function refreshState() { try { const rev = agentRev; const st = await api("/api/state"); for (const s of st.sessions || []) { S.sessions.set(s.sid, { ...(S.sessions.get(s.sid) || {}), ...s }); if (s.agentId) S.agentSids.set(s.sid, s.agentId); } if (st.boot) S.boot = st.boot; S.pi = st.pi; setPiChats(st.pis); S.runs = st.runs || []; S.hook = st.hook || S.hook; if (st.config) S.config = st.config; if (st.agents) { loadAgents(st.agents, rev); renderAgents(); } updateHeader(); if (S.page === "home") renderHome(); else updateComposer(); } catch { /* transient */ } }
/** Goal hook settings live in omni.config.json through the server; the menu reflects the saved state. */
async function setHook(patch) {
  try {
    const r = await api("/api/hook", patch, "PUT");
    S.hook = r.hook;
    toast(patch.enabled === true ? "Goal hook on: the agent is re-engaged until its plan is finished" : patch.enabled === false ? "Goal hook off" : `Status box model: ${r.hook.model || "same as the chat"}`);
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
  renderAgents();
  updateTitle();
}

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
  const sig = `${S.selected}|${open}|${list.map((a) => `${a.id}:${a.status}:${a.sid ? 1 : 0}:${logOpen.has(a.id) ? 1 : 0}`).join(",")}`;
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
  try { const r = await api(`/api/agents/${encodeURIComponent(id)}/log?tail=60`); logText.set(id, r.text || "(no output yet)"); }
  catch (e) { logText.set(id, `Could not read the log: ${e.message}`); }
  finally { logBusy.delete(id); }
  for (const pre of $("#agentStrip").querySelectorAll("pre.ag-log")) {
    if (pre.dataset.id !== id) continue;
    const stick = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 24;
    pre.textContent = logText.get(id);
    if (stick) pre.scrollTop = pre.scrollHeight;
  }
}
async function stopAgent(id, btn) {
  const a = S.agents.get(id);
  if (!window.confirm(`Stop “${agentTitle(a || { id })}”?\nWhat it did so far stays in its chat.`)) return;
  if (btn) btn.disabled = true;
  try { const r = await api(`/api/agents/${encodeURIComponent(id)}/cancel`, {}); if (r.agent) liveAgent(r.agent); toast("Agent stopped"); }
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
  home.setState({ ...piModelState(), caption: "" });
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
      const g = await api(`/api/goal${piChatSid() ? `?sid=${encodeURIComponent(piChatSid())}` : ""}`);
      const pg = g.progress ? ` · ${g.progress.complete ? "plan complete" : g.progress.steps ? `${g.progress.done + g.progress.skipped}/${g.progress.steps} steps` : g.progress.phase}` : g.goal ? " · no plan yet" : "";
      toast(g.goal ? `Goal: ${g.goal}${pg}${g.nudges ? ` · re-engaged ${g.nudges}×` : ""}` : "No goal set — type /goal <text> to set one");
    } else if (arg === "clear") {
      await api("/api/goal", { goal: "", sid: piChatSid() }, "POST");
      toast("Goal cleared");
    } else {
      await api("/api/goal", { goal: arg, sid: piChatSid() }, "POST");
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
  home.setState({ disabled: true, caption: remote.role === "remote" ? "Waiting for the host to approve…" : "Starting…" });
  try {
    if (remote.role === "remote") {
      // One request, one approval: the server starts pi (or a new session) and sends the message.
      const r = await api("/api/pi/send", { cwd, message: text, memory: o.memory, graph: o.graph });
      const st = await api("/api/state");
      S.pi = st.pi;
      S.sessions.set(r.sid, { ...(S.sessions.get(r.sid) || {}), sid: r.sid, harness: "pi", owned: true, cwd, title: text.replace(/\s+/g, " ").slice(0, 80), lastActivity: Date.now(), streaming: true });
      openChat(r.sid);
      home.clear();
      return;
    }
    // A chat of its own: a free pi child in that folder opens it, else another one starts. Chats already working keep going.
    const r = await api("/api/pi/open", { cwd });
    if (!r.sid || r.sid === "pi:pending") throw new Error("OpenCode did not report a session");
    S.piChats.set(r.sid, { sid: r.sid, cwd, model: r.state?.model?.id ? { provider: r.state.model.provider, id: r.state.model.id } : null, thinkingLevel: r.state?.thinkingLevel || "" });
    S.sessions.set(r.sid, { ...(S.sessions.get(r.sid) || {}), sid: r.sid, harness: "pi", owned: true, cwd, model: r.state?.model?.id, title: text.replace(/\s+/g, " ").slice(0, 80), lastActivity: Date.now(), streaming: true });
    openChat(r.sid);
    await api("/api/pi/prompt", { message: text, memory: o.memory, graph: o.graph, sid: r.sid });
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
  if (t.kind === "none") { st.caption = "Pick a chat"; st.disabled = true; }
  else if (t.kind === "agent") {
    // The agent's own model (its chat's, else what it was started with), never Omni's pi or its goal hook.
    const model = t.s.model || t.a?.model || "";
    Object.assign(st, { piModel: { provider: t.a?.provider || "", id: model || "agent's model" }, piThinking: t.a?.thinking || "", hook: null });
    st.disabled = !t.id;
    st.streaming = t.active;
    st.caption = !t.id ? "Background agent · view only" : t.active ? `${agentKindLabel(t.a?.kind || t.s.agentKind)} at work · a message steers it, empty send stops it` : `${agentKindLabel(t.a?.kind || t.s.agentKind)} · ${t.a?.status || "finished"} · a message picks it up again`;
  }
  else if (t.kind === "claude") { st.caption = "Claude Code chat · view only in Omni"; st.disabled = true; }
  else if (t.kind === "owned-pi") {
    // pi is idle while the goal hook waits to retry or check, but the chat is not: Stop must reach the hook too.
    const armed = !t.streaming && !!t.s.hookArmed;
    const retry = (t.s.hookRetryAt || 0) > Date.now() ? new Date(t.s.hookRetryAt).toLocaleTimeString() : "";
    st.streaming = t.streaming || armed;
    st.caption = t.streaming ? "Working · a message steers it, empty send stops it" : armed ? `${retry ? `Goal hook retries at ${retry} after a model error` : "Goal hook is about to continue"} · empty send stops it` : "";
  }
  else {
    const fork = S.forceFork || t.live;
    st.caption = fork ? `Forks ${t.live ? "the running " : "this "}chat into Omni` : "Continues this chat in Omni";
  }
  if (t.s?.compacting) st.caption = "Compacting the context (a long chat is summarized first; this can take minutes)…";
  $("#chatComposer").classList.toggle("for-agent", t.kind === "agent");
  chat.setState(st);
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
  // `/goal` drives Omni's own pi (the keeper); here it would quietly set that goal from an agent's chat.
  if (t.kind === "agent" && /^\/goal\b/.test(text.trim())) { toast("/goal sets the goal of Omni's own chat. Type it in one of its chats; here, just tell the agent.", true); return; }
  if (await goalCommand(text, chat)) return;
  try {
    if (t.kind === "owned-pi") {
      const r = await sendClearing(chat, text, () => api("/api/pi/prompt", { message: text, memory: o.memory, graph: o.graph, sid: t.s.sid }));
      // The chat's child had closed meanwhile: the server picked the chat up again (a fork lands in a new chat).
      if (r?.sid && r.sid !== S.selected) selectSession(r.sid);
      return;
    }
    if (t.kind === "agent") {
      if (!t.id) return;
      const r = await sendClearing(chat, text, () => api(`/api/agents/${encodeURIComponent(t.id)}/message`, { text }));
      if (r.how === "resumed" || r.how === "restarted") toast(`Agent ${r.how} with your message`);
      return;
    }
    if (t.kind !== "continue") return;
    chat.setState({ disabled: true, caption: "Starting…" });
    const r = await sendClearing(chat, text, () => api(`/api/sessions/${encodeURIComponent(t.s.sid)}/continue`, { message: text, memory: o.memory, graph: o.graph, fork: S.forceFork }));
    S.forceFork = false;
    if (r.sid !== S.selected) { if (r.forked) toast("Forked into a new session"); selectSession(r.sid); }
  } catch (e) { toast(e.message, true); }
  finally { updateComposer(); }
}
async function chatStop() {
  const t = target();
  if (t.kind === "agent") { if (t.id) await stopAgent(t.id); return; }
  try { if (t.kind === "owned-pi") await api("/api/pi/abort", { sid: t.s.sid }); } catch (e) { toast(e.message, true); }
}
async function selectSession(sid) {
  if (S.view) finish(S.view);
  S.selected = sid;
  S.forceFork = false;
  history.render();
  const s0 = S.sessions.get(sid);
  const view = newView($("#transcript"), $("#transcriptWrap"), sid, { cwd: s0?.cwd, openAgent });
  S.view = view;
  updateHeader(); updateComposer(); renderAgents();
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
    // Agent reports the history lacks come from the buffered live copies, in their place (withLiveReports).
    const events = withLiveReports(h.events, S.buffers.get(sid));
    for (const ev of events) { applyEvent(view, ev); if (ev.kind === "msg" && ev.id) seen.add(ev.id); }
    // A reopened chat gets its plan back from the plan tool's results in the file (live events keep it current after).
    const histPlan = planFromEvents(h.events);
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
    $("#transcriptWrap").scrollTop = $("#transcriptWrap").scrollHeight;
    if (!events.length) emptyNote(view, "nothing here yet");
  } catch (e) { toast(`Could not load history: ${e.message}`, true); }
  updateHeader(); updateComposer();
  if (document.body.classList.contains("panel-open")) panel.renderStats();
}
function updateHeader() {
  const s = S.page === "chat" ? S.sessions.get(S.selected) : null;
  updateTitle();
  const model = s?.model || (s ? "" : S.config?.piModel) || "";
  // A foreign chat's model is labelled with its harness so the slot never implies pi is running it.
  $("#topModel").textContent = s && s.harness !== "pi" && model ? `${s.harness} · ${model}` : model;
  $("#topModel").hidden = !model;
  $("#topModel").title = s ? `${s.harness} · ${s.cwd || ""}` : S.pi.cwd || "";
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
  const parent = s.parentSid || agentFor(s.sid)?.parentSid;
  if (parent && S.sessions.has(parent)) item("Open the chat that started this agent", () => openChat(parent));
  item("Delete this chat", () => deleteChat(s.sid));
  m.appendChild(el("div", "mh", `${s.harness} · ${s.cwd || ""}`));
}
$("#btnChatMenu").onclick = (e) => { e.stopPropagation(); const m = $("#chatMenu"); if (m.hidden) renderChatMenu(); m.hidden = !m.hidden; };
document.addEventListener("click", (e) => { if (!e.target.closest("#chatMenu, #btnChatMenu")) $("#chatMenu").hidden = true; });
$("#btnExplorer").onclick = () => { explorer.setRoot(currentDir()); setExplorer(!document.body.classList.contains("explorer-open"), true); };
$("#btnSummary").onclick = () => { try { localStorage.setItem("omni.summary", summaryOn() ? "off" : "on"); } catch { /* */ } renderSummary(); };
$("#btnSettings").onclick = () => settings.open();

// ------------------------------------------------------------------ SSE
// seq + boot let a reconnect ask for exactly what it missed (server/bus.mjs addClient).
const stream = createStream({
  url: () => `/events?since=${S.seq}${S.boot ? `&boot=${encodeURIComponent(S.boot)}` : ""}`,
  onMessage: (m) => { let ev; try { ev = JSON.parse(m.data); } catch { return; } handle(ev); },
  on: {
    // Only the host's own window receives these: remote changes waiting for Approve/Deny.
    approvals: (m) => { try { remote.setApprovals(JSON.parse(m.data)); } catch { /* */ } },
    // What this page missed is gone (the ring wrapped, or the server restarted and its seq began again): count
    // from the replay that follows this, and reload the state and the open chat.
    resync: (m) => { let r = {}; try { r = JSON.parse(m.data); } catch { /* */ } S.boot = r.boot || ""; S.seq = 0; resync(); },
  },
  onUp: () => { $("#connStatus").hidden = true; updateHeader(); },
  onDown: () => { $("#connStatus").hidden = false; checkSignedIn(); },
});
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") stream.poke(); });
window.addEventListener("online", () => stream.poke());
/** EventSource cannot see a 401, so a remote browser whose session ended (the server restarted, the password
 *  changed, it expired) retried "reconnecting" forever. After a drop, ask once; api() reloads to the sign-in page. */
let probing = false;
function checkSignedIn() {
  if (remote.role !== "remote" || probing) return;
  probing = true;
  api("/api/remote/me").catch(() => {}).finally(() => { probing = false; });
}
async function resync() {
  await refreshState();
  history.render();
  if (S.page === "chat" && S.selected) selectSession(S.selected);
}
let railTimer = null;
function handle(ev) {
  S.seq = Math.max(S.seq, ev.seq || 0);
  // A background agent's record changed (`sid` is its parent chat, or "agents"): no chat of its own to update.
  if (ev.kind === "agent") { onAgent(ev.agent); return; }
  // Which chats have a pi child right now (one per chat that runs at once).
  if (ev.kind === "pis") { setPiChats(ev.pis); if (S.page === "chat") updateComposer(); return; }
  if (ev.kind === "removed") { S.sessions.delete(ev.sid); S.buffers.delete(ev.sid); if (S.selected === ev.sid) { S.selected = null; S.view = null; showView("home"); } history.render(); return; }
  if (ev.kind === "log") { if (ev.level === "system" && (ev.ts || 0) >= BOOT_TS) toast(ev.text); else if (ev.level === "graphify" && ev.text) panel.graphLine(ev.text.split("\n").pop()); else if (ev.level === "hook" && ev.text && (ev.ts || 0) >= BOOT_TS && /failed|gave up|not JSON/.test(ev.text)) toast(ev.text, true); return; }
  const s = S.sessions.get(ev.sid) || { sid: ev.sid, harness: ev.harness, lastActivity: 0, tally: null };
  if (ev.kind === "session") {
    Object.assign(s, Object.fromEntries(Object.entries({ cwd: ev.cwd, title: ev.title ? cleanTitle(ev.title) || undefined : undefined, model: ev.model, file: ev.file, owned: ev.owned, forkedFrom: ev.forkedFrom }).filter(([, v]) => v != null)));
    // A background agent's chat names the chat that started it and its agent (PiRpc / ClaudeRunner `meta`).
    for (const k of ["parentSid", "agentId", "agentKind"]) if (ev[k]) s[k] = ev[k];
    if (ev.agentId) S.agentSids.set(ev.sid, ev.agentId);
  }
  if (ev.kind === "status") applyStatus(s, ev);
  if (ev.kind === "msg" && ev.role === "user" && !s.title) s.title = cleanTitle(ev.blocks?.[0]?.text || "");
  if (ev.kind === "msg" && ev.usage) { const t = s.tally || (s.tally = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, messages: 0, cost: 0, context: 0 }); if (!ev.groupId || t.lastGroup !== ev.groupId) { t.lastGroup = ev.groupId; t.input += ev.usage.input; t.output += ev.usage.output; t.cacheRead += ev.usage.cacheRead; t.cacheWrite += ev.usage.cacheWrite; t.total += ev.usage.total; t.messages++; t.context = ev.usage.input + ev.usage.cacheRead + ev.usage.cacheWrite; t.cost += ev.cost || 0; } }
  if (ev.kind !== "session") s.lastActivity = Math.max(s.lastActivity || 0, ev.ts || 0);
  if (ev.kind === "digest") toast(`Digest saved: ${ev.path}`);
  if (ev.kind === "summary") { Object.assign(goalBox(s), { summary: ev.text || "", summaryAt: ev.ts, goal: ev.goal || goalBox(s).goal, explicit: !!ev.explicit, nudges: ev.nudges || 0, done: !!ev.done }); if (ev.sid === S.selected) renderSummary(); }
  if (ev.kind === "plan") { Object.assign(goalBox(s), { plan: ev.plan, goal: ev.goal || goalBox(s).goal }); if (ev.sid === S.selected) renderSummary(); }
  if (ev.kind === "goal") { Object.assign(goalBox(s), { goal: ev.goal || goalBox(s).goal, explicit: !!ev.explicit, done: !!ev.done, nudges: ev.nudges || 0, plan: ev.plan || goalBox(s).plan }); if (ev.sid === S.selected) renderSummary(); }
  if (ev.kind === "keeper") { s.hookArmed = !!ev.armed; s.hookRetryAt = ev.retryAt || 0; if (ev.sid === S.selected) updateComposer(); }
  if (ev.kind === "hook" && ev.attempt) { goalBox(s).nudges = ev.attempt; if (ev.sid === S.selected) renderSummary(); }
  S.sessions.set(ev.sid, s);
  // A background pi agent is owned too, but it is its own pi process: it must not pass for Omni's main pi.
  if (ev.harness === "pi" && s.owned && !isAgentChat(s)) {
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
  S.config = st.config; S.pi = st.pi; setPiChats(st.pis); S.runs = st.runs || []; S.hook = st.hook || null; S.boot = st.boot || "";
  for (const s of st.sessions) { S.sessions.set(s.sid, s); if (s.agentId) S.agentSids.set(s.sid, s.agentId); }
  loadAgents(st.agents);
  // The goal each running chat is working on right now (plan, status, re-engages) survives a page reload.
  const goals = (st.pis || []).filter((c) => c.goal?.goal).map((c) => [c.sid, c.goal]);
  if (!goals.length && st.goal && st.pi?.sid) goals.push([st.pi.sid, st.goal]);
  for (const [sid, g] of goals) {
    const s = S.sessions.get(sid);
    if (!s) continue;
    Object.assign(goalBox(s), { goal: g.goal, explicit: g.explicit, plan: g.plan, summary: g.summary, summaryAt: g.summaryAt, nudges: g.nudges, done: g.done });
    Object.assign(s, { hookArmed: !!g.armed, hookRetryAt: g.retryAt || 0 });
  }
  remote.init(st.access);
  if (st.access?.role !== "remote" && st.config?.lanUrls?.length) { $("#lanInfo").textContent = st.config.lanUrls[0]; $("#lanInfo").title = "Open this on another device and sign in with the remote password (Settings → Remote); it is read-only there and every change waits for your approval"; }
  await Promise.all([panel.loadMemory(""), panel.loadGraphList(), loadPiChoices()]);
  history.render();
  showView("home");
  stream.start();
  setInterval(() => { if (document.body.classList.contains("panel-open")) history.render(); if (S.page === "chat") updateComposer(); }, 15000);
}
init().catch((e) => toast(`Omni Agent failed to start: ${e.message}`, true));
