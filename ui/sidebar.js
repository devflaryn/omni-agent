/* Chat history list inside the right drawer: one group per machine on the account (this computer first), each grouped by
   day, with a harness dot, a live pulse and a hover delete. A background agent's chat sits indented under the chat that
   started it (nestSessions). With one machine it looks as it did before accounts: no machine headers. */
import { el, groupLabel, nestSessions, agentTag, harnessLabel } from "./lib.js";

const NOTE = { offline: "offline", refusing: "does not let web pages in", loading: "loading…" };
/** Chats per machine in the All machines view, so every machine's name is on screen at once. */
const PER_MACHINE = 6;

/**
 * groups(filter, only)  sidebarGroups for the search text and the machine shown alone (or null)
 * machines()            the machine list, for the filter chips
 * selected()            {key, sid} of the open chat
 * onSelect(key, sid), onDelete(key, sid), onRetry(key), onMore(key), agentFor(ws, sid)
 */
export function createHistory({ groups, machines, selected, onSelect, onNew, onDelete, onRetry, onMore, agentFor = () => null }) {
  const wrap = document.querySelector("#history"), filter = document.querySelector("#sessionFilter"), chips = document.querySelector("#machineFilter");
  const isLive = (s) => s.streaming || Date.now() - (s.lastActivity || 0) < 20000;
  let only = null;

  function renderChips(list) {
    if (!chips) return;
    chips.textContent = "";
    chips.hidden = list.length < 2;
    if (list.length < 2) { only = null; return; }
    if (only && !list.some((m) => m.key === only)) only = null;
    const chip = (key, label, state) => {
      const b = el("button", `chip mach-chip${only === key ? " active" : ""}`);
      if (state) b.appendChild(el("span", `machine-dot${state === "online" ? " live" : ""}`));
      b.appendChild(el("span", null, label));
      b.onclick = () => { only = only === key ? null : key; render(); };
      return b;
    };
    chips.appendChild(chip(null, "All machines"));
    for (const m of list) chips.appendChild(chip(m.key, m.label, m.state));
  }

  function render() {
    const list = machines();
    renderChips(list);
    const many = list.length > 1;
    const f = filter.value.trim().toLowerCase();
    const open = selected();
    wrap.innerHTML = "";
    let shownRows = 0;
    for (const g of groups(f, only)) {
      const { m, ws } = g;
      if (many) {
        const head = el("div", `hist-machine ${m.state}`);
        head.dataset.machine = m.key;
        head.appendChild(el("span", `machine-dot${m.state === "online" ? " live" : ""}`));
        const name = el("span", "hist-machine-name", m.label);
        name.title = m.here ? "This computer" : `${m.name} (${String(m.id).slice(0, 6)})`;
        head.appendChild(name);
        if (g.note) {
          const known = Object.hasOwn(NOTE, g.note);
          const note = el("span", `hist-machine-note${known ? "" : " err"}`, known ? NOTE[g.note] : g.note);
          note.title = known ? `${m.label} ${NOTE[g.note]}` : g.note;
          head.appendChild(note);
          if (!known) { const r = el("button", "btn quiet small", "Try again"); r.onclick = () => onRetry(m.key); head.appendChild(r); }
        } else if (m.state === "stalled" || ws?.streamError) {
          // Its chats stay on show, but what is new on it may not arrive: said by name.
          const note = el("span", "hist-machine-note err", "not answering");
          note.title = `${m.label}: ${ws?.streamError || "not answering"}`;
          head.appendChild(note);
        }
        wrap.appendChild(head);
      }
      if (!ws?.loaded) continue;
      const titleOf = (s) => agentFor(ws, s.sid)?.title || s.title || "";
      const all = nestSessions(g.sessions, (s) => s.parentSid || agentFor(ws, s.sid)?.parentSid).slice(0, 200);
      // Every machine at a glance: a few chats each, and the rest one tap away under the machine's own name.
      const capped = many && !only && !f;
      const rows = capped ? all.slice(0, PER_MACHINE) : all;
      let last = null;
      for (const { s, depth } of rows) {
        // Children follow their parent whatever their own date, so only top-level rows open a day group.
        if (!depth) { const label = groupLabel(s.lastActivity || s.mtime); if (label !== last) { wrap.appendChild(el("div", "hist-group", label)); last = label; } }
        const tag = agentTag(s, agentFor(ws, s.sid));
        const on = open.key === m.key && open.sid === s.sid;
        const row = el("div", `hist-row${on ? " active" : ""}${depth ? " child" : ""}`);
        if (depth) row.style.setProperty("--depth", String(Math.min(depth, 4)));
        const b = el("button", `hist${on ? " active" : ""}${isLive(s) ? " live" : ""}`);
        b.dataset.h = s.harness;
        b.dataset.machine = m.key;
        b.title = `${many ? `${m.label} · ` : ""}${tag ? `${tag} · ` : ""}${harnessLabel(s.harness)} · ${s.cwd || ""}${s.forkedFrom ? " · forked" : ""}`;
        b.textContent = titleOf(s);
        if (tag) b.appendChild(el("span", "own agent", tag));
        else if (s.harness === "claude") b.appendChild(el("span", "own", "Claude Code"));
        else if (s.owned) b.appendChild(el("span", "own", "in Omni"));
        b.onclick = () => onSelect(m.key, s.sid);
        row.appendChild(b);
        const del = el("button", "hist-del"); del.innerHTML = `<svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg>`;
        del.title = many ? `Delete this chat on ${m.here ? "this computer" : m.label}` : "Delete this chat";
        del.setAttribute("aria-label", `Delete ${titleOf(s)}`);
        del.onclick = (e) => { e.stopPropagation(); onDelete(m.key, s.sid); };
        row.appendChild(del);
        wrap.appendChild(row);
        shownRows++;
      }
      const where = m.here ? "this computer" : m.label;
      if (capped && (all.length > rows.length || !ws.allChats)) {
        const more = el("button", "btn quiet small hist-more", `All chats on ${where}`);
        more.onclick = () => { only = m.key; if (!ws.allChats) onMore(m.key); render(); };
        wrap.appendChild(more);
      } else if (!ws.allChats && !f) {
        const more = el("button", "btn quiet small hist-more", many ? `Older chats on ${where}` : "Older chats");
        more.onclick = () => onMore(m.key);
        wrap.appendChild(more);
      } else if (many && !g.sessions.length && !g.note) wrap.appendChild(el("div", "hist-group", f ? "No matches." : "No chats yet."));
    }
    if (!many && !shownRows && !wrap.querySelector(".hist-more")) wrap.appendChild(el("div", "hist-group", f ? "No matches." : "No chats yet."));
  }
  filter.addEventListener("input", render);
  document.querySelector("#btnNewChat").onclick = onNew;
  return { render, get only() { return only; } };
}
