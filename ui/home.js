/* Home's "what is going on": the work running now and the latest chats, from every machine on the account, newest first.
   It reads the same groups the chats drawer does (sidebarGroups), so the two never disagree. */
import { el, ago } from "./lib.js";

const SHOWN = 6;
/** Running means a turn is streaming now: a file touched a moment ago is only recent. */
const live = (s) => !!s.streaming;

/** The rows Home shows: running chats first, then the newest, an agent's chat only when it is running. Pure. */
export function recentRows(groups, { now = Date.now(), titleOf = (_ws, s) => s.title || "", limit = SHOWN } = {}) {
  const rows = [];
  for (const g of groups) {
    if (!g.ws?.loaded) continue;
    for (const s of g.sessions) {
      const title = titleOf(g.ws, s);
      if (!title) continue;
      const child = !!(s.parentSid || s.agentId);
      const running = live(s);
      if (child && !running) continue;
      rows.push({ m: g.m, s, title, running, at: s.lastActivity || s.mtime || 0 });
    }
  }
  rows.sort((a, b) => (b.running - a.running) || (b.at - a.at));
  return rows.slice(0, limit);
}

/** Draws the list into its section. `many`: the window holds more than one machine, so each row names its own. */
export function renderRecent({ section, list, title, rows, many, onOpen, now = Date.now() }) {
  list.textContent = "";
  section.hidden = !rows.length;
  if (!rows.length) return;
  const running = rows.filter((r) => r.running).length;
  title.textContent = running ? `Running now (${running}) and recent` : "Recent";
  for (const r of rows) {
    const b = el("button", `home-row${r.running ? " live" : ""}`);
    b.type = "button";
    b.appendChild(el("span", `dot${r.running ? " run" : r.s.harness === "claude" ? " claude" : ""}`));
    b.appendChild(el("span", "home-row-title", r.title));
    const folder = String(r.s.cwd || "").replace(/\\/g, "/").split("/").filter(Boolean).pop() || "";
    const meta = [many ? r.m.label : "", folder, r.running ? "running" : r.at ? ago(r.at, now) : ""].filter(Boolean).join(", ");
    b.appendChild(el("span", "home-row-meta", meta));
    b.title = `${r.title}${many ? ` on ${r.m.label}` : ""}${r.s.cwd ? ` in ${r.s.cwd}` : ""}`;
    b.onclick = () => onOpen(r.m.key, r.s.sid);
    list.appendChild(b);
  }
}
