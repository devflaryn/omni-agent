/**
 * The Mission view: every mission, and for the open one its layered tree (the orchestrator on top, its workers below, their
 * subagents under them), live status per node, a detail pane to talk to any node, the user's inbox (notifications),
 * the task tree and the ledger notes. Pure helpers (buildTree, …) are exported for tests.
 */
import { el, ago, agentTone, agentElapsed, fmtN } from "./lib.js";
import { createOffice, officeData } from "./office.js";

const ACTIVE = new Set(["queued", "starting", "running"]);
const kindLabel = (k) => (k === "claude" ? "Claude Code" : k === "claude-sub" ? "Claude subagent" : k === "shell" ? "Shell" : "OpenCode");
const modelLabel = (m) => (m ? (m.provider ? `${m.provider}/${m.id}` : m.id) : "");
const one = (s, n = 140) => { const t = String(s ?? "").replace(/(^|\s)#{1,4}\s+/g, "$1").replace(/\*\*/g, "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/**
 * The mission's agents as a tree: `workers` (role worker), each with `children` (agents whose parentSid is that
 * worker's chat, recursively). Agents whose parent is unknown hang under the orchestrator as orphans. Pure.
 */
export function buildTree(mission, agents = []) {
  const mine = agents.filter((a) => a && a.missionId === mission?.id);
  const bySid = new Map(mine.filter((a) => a.sid).map((a) => [a.sid, a]));
  // Claude Code's own subagents (rec.subtasks) are leaves under their agent; they cannot be messaged.
  const subs = (a) => (a.subtasks || []).map((s) => ({ id: `${a.id}/${s.id}`, kind: "claude-sub", status: s.status === "running" && !ACTIVE.has(a.status) ? "interrupted" : s.status, title: s.title, model: s.type, activity: "", sid: null, rec: { ...s, createdAt: s.startedAt, role: "claude-sub", parent: a.id }, children: [] }));
  const node = (a) => ({ id: a.id, kind: a.kind, status: a.status, title: a.title, model: a.model, agent: a.agent, taskId: a.taskId, activity: a.activity?.at(-1) || "", sid: a.sid, rec: a, children: subs(a) });
  const nodes = new Map(mine.map((a) => [a.id, node(a)]));
  const workers = [], orphans = [];
  for (const a of mine) {
    const n = nodes.get(a.id);
    if (a.role === "worker") { workers.push(n); continue; }
    const parent = bySid.get(a.parentSid);
    if (parent && nodes.has(parent.id) && parent.id !== a.id) nodes.get(parent.id).children.push(n); else orphans.push(n);
  }
  const order = (x, y) => (ACTIVE.has(y.status) - ACTIVE.has(x.status)) || ((x.rec.createdAt || 0) - (y.rec.createdAt || 0));
  workers.sort(order);
  const depth = (n) => (n.children.length ? 1 + Math.max(...n.children.map(depth)) : 0);
  return { workers, orphans, layers: 1 + (workers.length ? 1 + Math.max(0, ...workers.map(depth)) : 0) };
}

/** Unread notifications across missions. Pure. */
export const unreadCount = (missions) => [...missions].reduce((n, m) => n + (m.notifications || []).filter((x) => !x.read).length, 0);

/** The orchestrator's state for its card. Pure. */
export function orchestratorState(m, session) {
  if (m.status === "paused") return { tone: "off", text: "paused", px: "cancelled" };
  if (m.status === "done") return { tone: "ok", text: "done", px: "done" };
  if (m.errors?.consecutive) return { tone: "err", text: `retrying (${m.errors.consecutive}) · ${one(m.errors.lastError, 60)}`, px: "error" };
  if (session?.streaming) return { tone: "run", text: "thinking", px: "running" };
  if (m.queue?.length) return { tone: "run", text: `${m.queue.length} queued`, px: "running" };
  return { tone: "", text: "idle · waiting for reports", px: "idle" };
}

export function createMissionView({ root, api, toast, onOpenChat, sessionOf = () => null, defaultDir = () => "", defaultModel = () => null }) {
  const M = { list: new Map(), agents: new Map(), reports: new Map(), open: null, selected: "orchestrator", tab: "inbox", timer: null, tick: null, models: null, kg: { q: "", text: "", node: "", stats: null, missionId: null } };
  const shell = el("div", "ms-shell");
  const side = el("aside", "ms-list");
  const main = el("div", "ms-main");
  shell.append(side, main);
  root.appendChild(shell);
  const badgeListeners = new Set();
  const removed = new Set();
  // The scrolling panels live as long as the view. A live update only swaps what changed inside them: replacing a
  // panel would end a scroll in progress (a wheel's glide, a finger's fling, a dragged scrollbar) every time an event came.
  const headSlot = el("div", "ms-head-slot"), bodyEl = el("div", "ms-body"), col = el("div", "ms-col");
  const officeEl = el("div", "ms-office"), detailSlot = el("div", "ms-detail-slot"), sideEl = el("aside", "ms-side"), tabsSlot = el("div", "ms-tabs-slot"), sideBody = el("div", "ms-side-body");
  col.append(officeEl, detailSlot);
  sideEl.append(tabsSlot, sideBody);
  bodyEl.append(col, sideEl);
  const sigs = new Map(); // what each part was last built from
  const changed = (name, sig) => { if (sigs.get(name) === sig) return false; sigs.set(name, sig); return true; };
  const saved = new Map(); // where each mission's and tab's panels were left
  let shownMission = null, shownSide = null;

  function schedule() { if (!M.timer) M.timer = setTimeout(() => { M.timer = null; render(); }, 150); }
  function setTick(on) { if (on && !M.tick) M.tick = setInterval(() => schedule(), 5000); if (!on && M.tick) { clearInterval(M.tick); M.tick = null; } }
  const emitBadge = () => { const n = unreadCount(M.list.values()); for (const f of badgeListeners) f(n); };

  async function load() {
    try {
      const r = await api("/api/missions");
      M.list = new Map(r.missions.map((m) => [m.id, m]));
      if (!M.list.has(M.open)) M.open = r.missions[0]?.id || null;
      if (M.open) await loadOne(M.open);
    } catch (e) { toast(`Missions: ${e.message}`, true); }
    emitBadge();
    render();
  }
  async function loadOne(id) {
    const r = await api(`/api/missions/${id}`);
    if (removed.has(id)) return;
    M.list.set(id, r.mission);
    for (const a of r.workers || []) M.agents.set(a.id, a);
  }

  // ---------------------------------------------------------------- live
  function onMission(m) { if (!m?.id || removed.has(m.id)) return; M.list.set(m.id, m); if (!M.open) M.open = m.id; emitBadge(); schedule(); }
  /** Gone from the server. Its last events can still arrive after this, so its id is remembered. */
  function onRemoved(id) {
    if (!id) return;
    removed.add(id);
    M.list.delete(id);
    for (const a of M.agents.values()) if (a.missionId === id) M.agents.delete(a.id);
    if (M.open === id) {
      M.open = [...M.list.values()].sort((a, b) => b.createdAt - a.createdAt)[0]?.id || null;
      M.selected = "orchestrator";
      if (M.open) loadOne(M.open).then(schedule, () => { /* live events fill it */ });
    }
    emitBadge();
    schedule();
  }
  function onAgent(a) { if (!a?.missionId) return; M.agents.set(a.id, { ...(M.agents.get(a.id) || {}), ...a }); schedule(); }
  function onNotify(ev) {
    const n = ev.notification;
    toast(`${ev.missionTitle ? `${one(ev.missionTitle, 40)}: ` : ""}${n.title}`, n.urgency === "urgent");
    emitBadge();
  }
  function onStatus() { if (M.open) schedule(); }

  // ---------------------------------------------------------------- render
  /** Live updates change only the parts whose data changed; what is being typed, the focus and the caret survive them. */
  function render() {
    const keep = new Map();
    for (const e of root.querySelectorAll("[data-k]")) if (e.value) keep.set(e.dataset.k, e.value);
    const act = document.activeElement, focus = act?.dataset?.k && root.contains(act) ? act.dataset.k : null;
    let caret = null; try { caret = focus ? [act.selectionStart, act.selectionEnd] : null; } catch { /* no selection */ }
    renderList();
    const m = M.open && M.list.get(M.open);
    if (!m) {
      if (!main.querySelector(".ms-empty")) { sigs.clear(); shownMission = shownSide = null; main.replaceChildren(emptyState()); }
      setTick(false);
      return;
    }
    if (!bodyEl.isConnected) main.replaceChildren(headSlot, bodyEl);
    if (changed("head", headSig(m))) headSlot.replaceChildren(header(m));
    moveTo(m);
    tree(m);
    if (changed("detail", detailSig(m))) {
      const pre = detailSlot.querySelector(".ms-summary"), top = pre?.scrollTop || 0;
      detailSlot.replaceChildren(detail(m));
      const now = detailSlot.querySelector(".ms-summary");
      if (now) now.scrollTop = top;
    }
    sidePane(m);
    setTick(m.status === "running");
    for (const e of root.querySelectorAll("[data-k]")) if (!e.value && keep.has(e.dataset.k)) e.value = keep.get(e.dataset.k);
    if (focus) {
      const e = [...root.querySelectorAll("[data-k]")].find((x) => x.dataset.k === focus);
      if (e && e !== document.activeElement) { e.focus({ preventScroll: true }); if (caret) { try { e.setSelectionRange(caret[0], caret[1]); } catch { /* not a text input */ } } }
    }
  }

  /** Another mission opened: its panels go back to where they were left in it (the top the first time). */
  function moveTo(m) {
    if (shownMission === m.id) return;
    if (shownMission) { saved.set(`col:${shownMission}`, col.scrollTop); saved.set(`body:${shownMission}`, bodyEl.scrollTop); }
    shownMission = m.id;
    sigs.delete("detail");
    queueMicrotask(() => { col.scrollTop = saved.get(`col:${m.id}`) || 0; bodyEl.scrollTop = saved.get(`body:${m.id}`) || 0; }); // once its content is in
  }

  const minute = () => Math.floor(Date.now() / 60_000);
  const headSig = (m) => JSON.stringify([m.id, m.title, m.status, m.dir, m.goal, m.usingFallback, m.fallbackModel, m.orchestratorModel, m.orchestrator?.generation, m.orchestrator?.contextUsed, m.orchestrator?.contextWindow]);
  function detailSig(m) {
    const a = M.agents.get(String(M.selected).split("/")[0]);
    const os = orchestratorState(m, m.orchestrator?.sid ? sessionOf(m.orchestrator.sid) : null);
    return JSON.stringify([m.id, M.selected, minute(), os.text, os.px, (m.queue || []).map((x) => x.type), m.orchestrator?.sid, m.usingFallback, a && [a.title, a.status, a.model, a.turns, a.cost, a.error, a.role, a.sid, a.kind, a.activity?.slice(-6), a.subtasks], M.reports.get(M.selected)]);
  }

  function renderList() {
    const ms = [...M.list.values()].sort((a, b) => b.createdAt - a.createdAt);
    if (!changed("list", JSON.stringify([M.open, minute(), ms.map((m) => [m.id, m.title, m.status, ago(m.updatedAt), (m.notifications || []).filter((x) => !x.read).length])]))) return;
    const out = [];
    const head = el("div", "ms-list-head");
    head.append(el("span", "ms-list-title", "Missions"));
    const nb = el("button", "btn small primary", "New mission");
    nb.onclick = () => openNew();
    head.append(nb);
    out.push(head);
    if (!ms.length) out.push(el("div", "ms-list-empty", "No missions yet."));
    for (const m of ms) {
      const row = el("button", `ms-row${m.id === M.open ? " on" : ""}`);
      const unread = (m.notifications || []).filter((x) => !x.read).length;
      const dot = el("span", `dot ${m.status === "running" ? "run" : m.status === "done" ? "ok" : m.status === "error" ? "err" : "off"}`);
      const t = el("span", "ms-row-title", m.title);
      const sub = el("span", "ms-row-sub mono", `${m.status} · ${ago(m.updatedAt)}`);
      const txt = el("span", "ms-row-text"); txt.append(t, sub);
      row.append(dot, txt);
      if (unread) row.append(el("span", "ms-badge", String(unread)));
      row.onclick = async () => { M.open = m.id; M.selected = "orchestrator"; try { await loadOne(m.id); } catch { /* live events fill it */ } render(); };
      out.push(row);
    }
    side.replaceChildren(...out);
  }

  function emptyState() {
    const box = el("div", "ms-empty");
    box.append(el("h2", "ms-empty-title", "Give it a big job and walk away"));
    box.append(el("p", "ms-empty-sub", "A mission has an orchestrator that only plans and delegates, and workers (OpenCode or Claude Code) that do the work and report back. Everything it learns is kept in Omni's own folder for the project, so it can run for days."));
    const b = el("button", "btn primary", "New mission"); b.onclick = () => openNew();
    box.append(b);
    return box;
  }

  function header(m) {
    const h = el("div", "ms-head");
    const left = el("div", "ms-head-main");
    const title = el("div", "ms-title"); title.append(el("span", "", m.title), el("span", `ms-status s-${m.status}`, m.status));
    left.append(title);
    const meta = el("div", "ms-meta mono");
    const ctx = m.orchestrator?.contextWindow ? ` · context ${Math.round((m.orchestrator.contextUsed / m.orchestrator.contextWindow) * 100)}%` : "";
    meta.textContent = `${m.dir} · orchestrator ${modelLabel(m.usingFallback ? m.fallbackModel : m.orchestratorModel)}${m.usingFallback ? " (fallback)" : ""} · generation ${m.orchestrator?.generation || 1}${ctx}`;
    left.append(meta);
    const goal = el("div", "ms-goal", one(m.goal, 400)); goal.title = m.goal;
    left.append(goal);
    const acts = el("div", "ms-head-acts");
    if (m.status === "paused" || m.status === "error") { const b = el("button", "btn small", "Resume"); b.onclick = () => act(`/api/missions/${m.id}/resume`, "Mission resumed"); acts.append(b); }
    else if (m.status !== "done") { const b = el("button", "btn small", "Pause"); b.title = "Stops the orchestrator and every worker; resume continues from the ledger"; b.onclick = () => { if (window.confirm("Pause this mission? Every worker is stopped; Resume continues from the ledger.")) act(`/api/missions/${m.id}/stop`, "Mission paused"); }; acts.append(b); }
    const rm = el("button", "btn small quiet", "Remove"); rm.title = "Stops this mission and deletes its ledger, reports and inbox"; rm.onclick = () => removeMission(m); acts.append(rm);
    h.append(left, acts);
    return h;
  }

  async function removeMission(m) {
    const running = m.status === "running" || m.status === "starting";
    if (!window.confirm(`Remove "${one(m.title, 60)}"?${running ? " It is still running: the orchestrator and every worker are stopped." : ""} Its ledger, reports and inbox are deleted and cannot be restored. The project's memory and knowledge graph stay.`)) return;
    try { await api(`/api/missions/${m.id}/remove`, {}); onRemoved(m.id); toast("Mission removed"); render(); } catch (e) { toast(e.message, true); }
  }

  async function act(path, ok, body = {}) { try { await api(path, body); if (ok) toast(ok); if (M.open) await loadOne(M.open); render(); } catch (e) { toast(e.message, true); } }

  /** The mission as an office (ui/office.js): one canvas, re-drawn from live data; a click on a desk selects that agent. */
  const office = createOffice({ spawn: () => new Worker(new URL("./office-worker.js", import.meta.url), { type: "module" }), onReady: () => schedule() });
  let drawn = null;
  function tree(m) {
    const t = buildTree(m, [...M.agents.values()]);
    const orch = orchestratorState(m, m.orchestrator?.sid ? sessionOf(m.orchestrator.sid) : null);
    if (!M.canvas) {
      const c = M.canvas = document.createElement("canvas");
      c.className = "ms-office-canvas";
      c.setAttribute("role", "img");
      const at = (e) => { const r = c.getBoundingClientRect(), x = ((e.clientX - r.left) * c.width) / r.width, y = ((e.clientY - r.top) * c.height) / r.height; return [...(M.hits || [])].reverse().find((h) => x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h); };
      c.onclick = (e) => { const h = at(e); if (h) { M.selected = h.id; render(); } };
      c.onmousemove = (e) => { c.style.cursor = at(e) ? "pointer" : "default"; };
      M.officeSr = el("div", "sr-only");
      M.officeNote = el("div", "ms-tree-empty");
      officeEl.append(c, M.officeSr, M.officeNote);
    }
    const none = !t.workers.length && !t.orphans.length;
    M.officeNote.hidden = !none;
    if (none) M.officeNote.textContent = m.status === "running" ? "The orchestrator is planning; its workers take a desk here as it starts them." : "No workers.";
    let result = null;
    try { result = office.draw(officeData(m, t, orch), { selected: M.selected }); } catch (e) { console.error("office", e); }
    if (!result) return;
    const { img, hits } = result, c = M.canvas;
    M.hits = hits;
    if (c.width !== img.w || c.height !== img.h) { c.width = img.w; c.height = img.h; c.style.aspectRatio = `${img.w} / ${img.h}`; c.style.maxWidth = `${img.w * 3}px`; }
    const sum = `${result.version}|${M.selected}|${JSON.stringify(result.labels)}`;
    if (sum !== drawn) { drawn = sum; c.getContext("2d").putImageData(new ImageData(img.rgba, img.w, img.h), 0, 0); }
    c.setAttribute("aria-label", `The mission as an office: the orchestrator and ${t.workers.length + t.orphans.length} workers`);
    // the same choices for keyboards and screen readers
    if (changed("sr", JSON.stringify(hits.map((h) => [h.id, h.label])))) {
      M.officeSr.replaceChildren(...hits.map((h) => { const b = el("button", "", `Open ${h.label}`); b.onclick = () => { M.selected = h.id; render(); }; return b; }));
    }
  }

  /** The detail pane's heading: title and facts. */
  function detailHead(kind, status, title, sub) {
    const h = el("div", "ms-detail-head");
    const t = el("div", "ms-detail-head-text");
    t.append(el("div", "ms-detail-title", title));
    if (sub) t.append(el("div", "ms-detail-sub mono", sub));
    h.append(t);
    return h;
  }

  function detail(m) {
    const d = el("div", "ms-detail");
    const sub = String(M.selected).includes("/") ? String(M.selected).split("/") : null;
    if (sub && M.agents.get(sub[0])) {
      const parent = M.agents.get(sub[0]), s = (parent.subtasks || []).find((x) => x.id === sub[1]);
      d.append(detailHead("claude", s?.status === "running" && !ACTIVE.has(parent.status) ? "interrupted" : s?.status, s?.title || "Claude subagent", `Claude Code subagent${s?.type ? ` (${s.type})` : ""} of ${parent.id} · ${s?.status || "?"}${s?.startedAt ? ` · ${agentElapsed({ startedAt: s.startedAt, endedAt: s.endedAt })}` : ""}`));
      d.append(el("div", "ms-detail-sub", "It runs inside its Claude Code agent and reports to it; message the agent instead."));
      const o = el("button", "btn small quiet", `Select ${parent.id}`); o.onclick = () => { M.selected = parent.id; render(); };
      d.append(o);
      return d;
    }
    if (M.selected === "orchestrator" || !M.agents.get(M.selected)) {
      M.selected = "orchestrator";
      const q = m.queue || [];
      const os = orchestratorState(m, m.orchestrator?.sid ? sessionOf(m.orchestrator.sid) : null);
      d.append(detailHead("orchestrator", os.px, "Orchestrator", `${modelLabel(m.usingFallback ? m.fallbackModel : m.orchestratorModel)} · ${os.text}`));
      d.append(el("div", "ms-detail-sub", q.length ? `Next for the orchestrator: ${q.map((x) => x.type).join(", ")}` : "Nothing waiting for the orchestrator."));
      const acts = el("div", "ms-detail-acts");
      if (m.orchestrator?.sid) { const o = el("button", "btn small quiet", "Open the orchestrator's chat"); o.onclick = () => onOpenChat(m.orchestrator.sid); acts.append(o); }
      d.append(acts, composer("Message the orchestrator…", (text) => act(`/api/missions/${m.id}/message`, "Sent to the orchestrator", { text })));
      return d;
    }
    const a = M.agents.get(M.selected);
    if (!a) return d;
    d.append(detailHead(a.kind, a.status, a.title, `${a.id} · ${kindLabel(a.kind)}${a.model ? ` · ${a.model}` : ""} · ${a.status} · ${agentElapsed(a)}${a.turns ? ` · ${a.turns} turns` : ""}${a.cost ? ` · $${a.cost.toFixed(2)}` : ""}${a.role === "subagent" ? " · subagent" : ""}`));
    if (a.error) d.append(el("div", "ms-detail-err", a.error));
    if (a.activity?.length) { const ul = el("ul", "ms-activity mono"); for (const l of a.activity.slice(-6)) ul.append(el("li", "", l)); d.append(ul); }
    const out = el("pre", "ms-summary"); const selected = M.selected, shownReport = M.reports.get(selected);
    out.hidden = shownReport == null; if (shownReport != null) out.textContent = shownReport;
    const report = (text) => { M.reports.set(selected, text); out.hidden = false; out.textContent = text; };
    const acts = el("div", "ms-detail-acts");
    if (a.sid) { const o = el("button", "btn small quiet", "Open chat"); o.onclick = () => onOpenChat(a.sid); acts.append(o); }
    if (a.role === "worker" && ACTIVE.has(a.status)) {
      const s = el("button", "btn small", "Ask for a summary");
      s.onclick = async () => { s.disabled = true; report("Asking the worker…"); try { report((await api(`/api/missions/${m.id}/workers/${a.id}/summary`, {})).text); } catch (e) { report(e.message); } s.disabled = false; schedule(); };
      acts.append(s);
    }
    if (a.role === "worker" && !ACTIVE.has(a.status)) {
      const r = el("button", "btn small", "Full report");
      r.onclick = async () => { try { report((await api(`/api/missions/${m.id}/report/${a.id}`)).text); } catch (e) { report(e.message); } schedule(); };
      acts.append(r);
    }
    if (ACTIVE.has(a.status)) { const c = el("button", "btn small quiet", "Stop"); c.onclick = () => { if (window.confirm(`Stop ${a.id}?`)) act(a.role === "worker" ? `/api/missions/${m.id}/workers/${a.id}/cancel` : `/api/agents/${a.id}/cancel`, "Stopped"); }; acts.append(c); }
    d.append(acts, out);
    if (a.kind !== "shell") d.append(composer(a.role === "worker" ? "Message this worker (the orchestrator is told)…" : "Message this subagent…", (text) => act(a.role === "worker" ? `/api/missions/${m.id}/workers/${a.id}/message` : `/api/agents/${a.id}/message`, "Sent", { text })));
    return d;
  }

  function composer(placeholder, send, key = placeholder) {
    const f = el("form", "ms-compose");
    const t = el("textarea"); t.rows = 2; t.placeholder = placeholder; t.dataset.k = `${M.open}:${M.selected}:${key}`;
    const b = el("button", "btn small primary", "Send"); b.type = "submit";
    t.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); f.requestSubmit(); } });
    f.onsubmit = (e) => { e.preventDefault(); const v = t.value.trim(); if (!v) return; t.value = ""; send(v); };
    f.append(t, b);
    return f;
  }

  /** The side pane: the panel stays; each tab of each mission remembers where it was. */
  function sidePane(m) {
    const unread = (m.notifications || []).filter((x) => !x.read).length;
    const tabs = [["inbox", `Inbox${unread ? ` (${unread})` : ""}`], ["tasks", `Tasks (${m.tasks?.length || 0})`], ["ledger", "Ledger"], ["kg", "Knowledge"]];
    if (changed("tabs", JSON.stringify([M.tab, tabs]))) {
      const row = el("div", "ms-tabs");
      for (const [k, label] of tabs) {
        const b = el("button", `seg-btn${M.tab === k ? " active" : ""}`, label);
        b.onclick = () => { M.tab = k; render(); };
        row.append(b);
      }
      tabsSlot.replaceChildren(row);
    }
    const key = `side:${m.id}:${M.tab}`, K = M.kg;
    const data = M.tab === "inbox" ? m.notifications : M.tab === "tasks" ? m.tasks : M.tab === "ledger" ? m.notes : [K.missionId, K.text, K.node, K.q, K.stats];
    if (!changed("side", JSON.stringify([key, minute(), data]))) return;
    const moved = shownSide !== key;
    if (moved && shownSide) saved.set(shownSide, sideBody.scrollTop);
    shownSide = key;
    sideBody.replaceChildren();
    if (M.tab === "inbox") inbox(m, sideBody); else if (M.tab === "tasks") tasks(m, sideBody); else if (M.tab === "kg") knowledge(m, sideBody); else ledger(m, sideBody);
    if (moved) sideBody.scrollTop = saved.get(key) || 0;
  }

  function inbox(m, box) {
    const ns = [...(m.notifications || [])].reverse();
    if (!ns.length) { box.append(el("div", "ms-none", "Nothing yet. The orchestrator notifies you when it needs you or reaches a milestone.")); return; }
    for (const n of ns) {
      const it = el("div", `ms-note u-${n.urgency}${n.read ? "" : " unread"}`);
      const h = el("div", "ms-note-head"); h.append(el("span", `ms-urg u-${n.urgency}`, n.urgency), el("span", "ms-note-title", n.title), el("span", "ms-note-ago", ago(n.at)));
      it.append(h);
      if (n.body) it.append(el("div", "ms-note-body", n.body));
      if (n.question) {
        it.append(el("div", "ms-note-q", n.question));
        if (n.answer != null) it.append(el("div", "ms-note-a", `You answered: ${n.answer}`));
        else it.append(composer("Your answer (goes to the orchestrator)…", (text) => act(`/api/missions/${m.id}/notifications/${n.id}`, "Answer sent to the orchestrator", { answer: text }), `answer-${n.id}`));
      }
      if (!n.read) { const r = el("button", "btn small quiet", "Mark read"); r.onclick = () => act(`/api/missions/${m.id}/notifications/${n.id}`, null, { read: true }); it.append(r); }
      box.append(it);
    }
  }
  function tasks(m, box) {
    if (!m.tasks?.length) { box.append(el("div", "ms-none", "The orchestrator has not planned any tasks yet.")); return; }
    for (const t of m.tasks) {
      const r = el("div", `ms-task t-${t.status}`);
      r.style.setProperty("--d", t.id.split(".").length - 1);
      const h = el("div", "ms-task-head"); h.append(el("span", `ms-tstat t-${t.status}`, t.status), el("span", "mono ms-task-id", t.id), el("span", "ms-task-title", t.title));
      r.append(h);
      if (t.summary) r.append(el("div", "ms-task-sum", t.summary));
      if (t.workers?.length) r.append(el("div", "ms-task-w mono", t.workers.join(" · ")));
      box.append(r);
    }
  }
  function ledger(m, box) {
    const notes = [...(m.notes || [])].reverse();
    if (!notes.length) { box.append(el("div", "ms-none", "Decisions, dead ends and facts the orchestrator records show up here.")); return; }
    for (const n of notes) {
      const r = el("div", `ms-ledger k-${n.kind}`);
      const h = el("div", "ms-ledger-head"); h.append(el("span", `ms-kind k-${n.kind}`, n.kind.replace("_", " ")), el("span", "ms-ledger-title", n.title), el("span", "ms-note-ago", ago(n.at)));
      r.append(h);
      if (n.body) r.append(el("div", "ms-ledger-body", n.body));
      box.append(r);
    }
  }

  /** The project's knowledge graph: what it holds, a search, one node with its neighbours (ids are clickable). */
  function knowledge(m, box) {
    const K = M.kg;
    if (K.missionId !== m.id) Object.assign(K, { missionId: m.id, q: "", text: "", node: "", stats: null });
    if (!K.stats) { K.stats = "loading"; api(`/api/missions/${m.id}/kg/stats`).then((s) => { K.stats = s; schedule(); }, () => { K.stats = { nodes: 0, edges: 0, byKind: {} }; schedule(); }); }
    const st = K.stats && K.stats !== "loading" ? K.stats : null;
    box.append(el("div", "ms-kg-stats mono", st ? `${fmtN(st.nodes)} nodes · ${fmtN(st.edges)} edges${Object.keys(st.byKind || {}).length ? ` · ${Object.entries(st.byKind).map(([k, n]) => `${fmtN(n)} ${k}`).join(" · ")}` : ""}` : "…"));
    if (st && !st.nodes) box.append(el("div", "ms-none", "Empty so far. Workers seed it with kg_import (graphify for source, Ghidra for binaries) and add what they learn with kg_upsert."));
    const f = el("form", "ms-kg-search");
    const inp = Object.assign(el("input", "mono"), { type: "search", placeholder: "Search functions, strings, files…", value: K.q });
    inp.dataset.k = `${m.id}:kg-search`;
    f.append(inp);
    f.onsubmit = async (e) => { e.preventDefault(); K.q = inp.value.trim(); K.node = ""; if (!K.q) { K.text = ""; render(); return; } try { K.text = (await api(`/api/missions/${m.id}/kg/search?q=${encodeURIComponent(K.q)}`)).text; } catch (err) { K.text = err.message; } render(); };
    box.append(f);
    const show = async (id) => { K.node = id; try { K.text = (await api(`/api/missions/${m.id}/kg/node?id=${encodeURIComponent(id)}`)).text; } catch (err) { K.text = err.message; } render(); };
    if (K.text) {
      const out = el("div", "ms-kg-out mono");
      for (const line of K.text.split("\n")) {
        const row = el("div", "ms-kg-line");
        const id = /^\s*(?:\w+ )?([a-z]+:[^\s]+)/.exec(line)?.[1];
        if (id && id !== K.node) { const b = el("button", "ms-kg-id", id); b.onclick = () => show(id); row.append(document.createTextNode(line.slice(0, line.indexOf(id))), b, document.createTextNode(line.slice(line.indexOf(id) + id.length))); }
        else row.textContent = line;
        out.append(row);
      }
      box.append(out);
    }
  }

  // ---------------------------------------------------------------- new mission
  async function models() {
    if (M.models) return M.models;
    try { M.models = (await api("/api/pi/models")).data?.models || []; } catch { M.models = []; }
    return M.models;
  }
  async function openNew() {
    const wrap = el("div", "ms-dlg-wrap");
    const dlg = el("form", "ms-dlg");
    dlg.append(el("div", "ms-dlg-title", "New mission"));
    dlg.append(el("div", "ms-dlg-sub", "The orchestrator plans and delegates; workers do the work. Project memory, the knowledge graph and the ledger live in Omni's folder, not in the project."));
    const field = (label, input, hint) => { const f = el("label", "ms-field"); f.append(el("span", "ms-field-label", label), input); if (hint) f.append(el("span", "ms-field-hint", hint)); dlg.append(f); return input; };
    const dir = field("Project folder", Object.assign(el("input", "mono"), { value: defaultDir(), required: true, spellcheck: false }));
    const goal = field("Goal", Object.assign(el("textarea"), { rows: 6, required: true, placeholder: "e.g. Fully map the login and token-refresh flow of app.apk (lib/arm64-v8a/libapp.so is packed); document every key, offset and request, and write a working client for it." }));
    const title = field("Title (optional)", el("input"));
    const list = await models();
    const sel = (withNone) => { const s = el("select"); if (withNone) s.append(Object.assign(el("option", "", "None"), { value: "" })); for (const x of list) s.append(Object.assign(el("option", "", `${x.provider}/${x.id}${x.contextWindow ? ` · ${fmtN(x.contextWindow)}` : ""}`), { value: `${x.provider}/${x.id}` })); return s; };
    const orchestrator = field("Orchestrator model", sel(false), "Pick a model with a large context window; the orchestrator only reads summaries.");
    const dm = defaultModel(); if (dm) orchestrator.value = modelLabel(dm);
    const fb = field("Fallback model", sel(true), "Used when the orchestrator's model keeps failing (rate limits, outages); the primary is tried again after an hour.");
    const wk = el("div", "ms-seg");
    let kind = "pi";
    for (const [k, l] of [["pi", "OpenCode"], ["claude", "Claude Code"]]) { const b = el("button", `seg-btn${k === kind ? " active" : ""}`, l); b.type = "button"; b.onclick = () => { kind = k; for (const x of wk.children) x.classList.toggle("active", x === b); }; wk.append(b); }
    field("Default workers", wk, "The orchestrator still picks per task.");
    const wm = field("Worker model (optional)", Object.assign(el("input", "mono"), { placeholder: "provider/id for OpenCode, a Claude model id for Claude Code" }));
    const sm = field("Start message (optional)", Object.assign(el("textarea"), { rows: 2, placeholder: "e.g. hey · read AGENTS.md" }), "Sent first to every agent that starts (the orchestrator, each worker and subagent); its reply comes before the real prompt.");
    const acts = el("div", "ms-dlg-acts");
    const cancel = el("button", "btn quiet", "Cancel"); cancel.type = "button"; cancel.onclick = () => wrap.remove();
    const go = el("button", "btn primary", "Start mission"); go.type = "submit";
    acts.append(cancel, go);
    dlg.append(acts);
    dlg.onsubmit = async (e) => {
      e.preventDefault();
      go.disabled = true;
      try {
        const r = await api("/api/missions", { dir: dir.value.trim(), goal: goal.value.trim(), title: title.value.trim() || undefined, orchestratorModel: orchestrator.value, fallbackModel: fb.value || undefined, workerKind: kind, workerModel: wm.value.trim() || undefined, startMessage: sm.value.trim() || undefined });
        M.list.set(r.mission.id, r.mission); M.open = r.mission.id; M.selected = "orchestrator";
        wrap.remove(); toast("Mission started"); render();
      } catch (err) { toast(err.message, true); go.disabled = false; }
    };
    wrap.onclick = (e) => { if (e.target === wrap) wrap.remove(); };
    wrap.append(dlg);
    document.body.append(wrap);
    goal.focus();
  }

  return { load, render, onMission, onRemoved, onAgent, onNotify, onStatus, openNew, onBadge: (f) => { badgeListeners.add(f); f(unreadCount(M.list.values())); }, get state() { return M; } };
}
