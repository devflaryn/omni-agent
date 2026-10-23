/* Chat history list inside the right drawer: grouped by day, harness dot, live pulse, hover delete.
   A background agent's chat sits indented under the chat that started it (nestSessions). */
import { el, groupLabel, nestSessions, agentTag, harnessLabel } from "./lib.js";

export function createHistory({ S, onSelect, onNew, onDelete, agentFor = () => null }) {
  const wrap = document.querySelector("#history"), filter = document.querySelector("#sessionFilter");
  const isLive = (s) => s.streaming || Date.now() - (s.lastActivity || 0) < 20000;
  // An agent's own title (what its parent called the job) reads better than the first line of its task prompt.
  const titleOf = (s) => agentFor(s.sid)?.title || s.title || "";
  function render() {
    const f = filter.value.trim().toLowerCase();
    const list = [...S.sessions.values()]
      .filter((s) => titleOf(s) && (!f || `${titleOf(s)} ${s.cwd || ""} ${s.model || ""} ${s.harness} ${harnessLabel(s.harness)}`.toLowerCase().includes(f)))
      .sort((a, b) => (b.lastActivity || b.mtime || 0) - (a.lastActivity || a.mtime || 0));
    const rows = nestSessions(list, (s) => s.parentSid || agentFor(s.sid)?.parentSid).slice(0, 200);
    wrap.innerHTML = "";
    let last = null;
    for (const { s, depth } of rows) {
      // Children follow their parent whatever their own date, so only top-level rows open a day group.
      if (!depth) { const g = groupLabel(s.lastActivity || s.mtime); if (g !== last) { wrap.appendChild(el("div", "hist-group", g)); last = g; } }
      const tag = agentTag(s, agentFor(s.sid));
      const row = el("div", `hist-row${s.sid === S.selected ? " active" : ""}${depth ? " child" : ""}`);
      if (depth) row.style.setProperty("--depth", String(Math.min(depth, 4)));
      const b = el("button", `hist${s.sid === S.selected ? " active" : ""}${isLive(s) ? " live" : ""}`);
      b.dataset.h = s.harness;
      b.title = `${tag ? `${tag} · ` : ""}${harnessLabel(s.harness)} · ${s.cwd || ""}${s.forkedFrom ? " · forked" : ""}`;
      b.textContent = titleOf(s);
      if (tag) b.appendChild(el("span", "own agent", tag));
      else if (s.harness === "claude") b.appendChild(el("span", "own", "Claude Code"));
      else if (s.owned) b.appendChild(el("span", "own", "in Omni"));
      b.onclick = () => onSelect(s.sid);
      row.appendChild(b);
      const del = el("button", "hist-del"); del.innerHTML = `<svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg>`;
      del.title = "Delete this chat";
      del.setAttribute("aria-label", `Delete ${titleOf(s)}`);
      del.onclick = (e) => { e.stopPropagation(); onDelete(s.sid); };
      row.appendChild(del);
      wrap.appendChild(row);
    }
    if (!rows.length) wrap.appendChild(el("div", "hist-group", f ? "No matches." : "No chats yet."));
  }
  filter.addEventListener("input", render);
  document.querySelector("#btnNewChat").onclick = onNew;
  return { render };
}
