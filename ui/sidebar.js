/* Session rail: grouped by day, harness dot, live pulse. */
import { el, groupLabel } from "./lib.js";

export function createSidebar({ S, onSelect, onNew, onDelete }) {
  const wrap = document.querySelector("#history"), filter = document.querySelector("#sessionFilter");
  const isLive = (s) => s.streaming || Date.now() - (s.lastActivity || 0) < 20000;
  function render() {
    const f = filter.value.trim().toLowerCase();
    const list = [...S.sessions.values()]
      .filter((s) => s.title && (!f || `${s.title} ${s.cwd || ""} ${s.model || ""} ${s.harness}`.toLowerCase().includes(f)))
      .sort((a, b) => (b.lastActivity || b.mtime || 0) - (a.lastActivity || a.mtime || 0))
      .slice(0, 150);
    wrap.innerHTML = "";
    let last = null;
    for (const s of list) {
      const g = groupLabel(s.lastActivity || s.mtime);
      if (g !== last) { wrap.appendChild(el("div", "hist-group", g)); last = g; }
      const row = el("div", `hist-row${s.sid === S.selected ? " active" : ""}`);
      const b = el("button", `hist${s.sid === S.selected ? " active" : ""}${isLive(s) ? " live" : ""}`);
      b.dataset.h = s.harness;
      b.title = `${s.harness} · ${s.cwd || ""}${s.forkedFrom ? " · forked" : ""}`;
      b.textContent = s.title;
      if (s.owned) b.appendChild(el("span", "own", "in Omni"));
      b.onclick = () => onSelect(s.sid);
      row.appendChild(b);
      if (onDelete) {
        const del = el("button", "hist-del");
        del.textContent = "✕";
        del.title = "Delete this chat";
        del.setAttribute("aria-label", `Delete ${s.title}`);
        del.onclick = (e) => { e.stopPropagation(); onDelete(s.sid); };
        row.appendChild(del);
      }
      wrap.appendChild(row);
    }
    if (!list.length) wrap.appendChild(el("div", "hist-group", f ? "No matches." : "No chats yet."));
  }
  function setOpen(open) { document.body.classList.toggle("side-open", open); try { localStorage.setItem("omni.side", open ? "1" : "0"); } catch { /* private mode */ } }
  filter.addEventListener("input", render);
  document.querySelector("#btnNewChat").onclick = onNew;
  document.querySelector("#btnCloseSide").onclick = () => setOpen(false);
  document.querySelector("#btnOpenSide").onclick = () => setOpen(true);
  let initial = true; try { initial = localStorage.getItem("omni.side") !== "0"; } catch { /* */ }
  if (window.innerWidth < 860) initial = false;
  setOpen(initial);
  return { render, setOpen };
}
