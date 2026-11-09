/* Every machine the window shows, and what it keeps of each: the account's machines in one list, this computer first; one
   workspace per machine (its chats, its agents, its stream's place); the chats sidebar grouped by machine; drafts per chat.
   Pure, so it can be tested in Node: app.js does the drawing and the asking. */
import { applyStatus, cleanTitle } from "./lib.js";
import { cleanName } from "./transport.js";

/** The key of this computer. Every other machine's key is its device id. */
export const HERE = "here";
export const shortId = (id) => String(id ?? "").slice(0, 6);

const linkState = (m) => {
  if (!m.online) return "offline";
  const s = m.link?.state;
  return s === "refusing" || s === "stalled" ? s : "online";
};

/**
 * The machines in the window: this computer first (`here`, null on a web page, which has none), then the account's other
 * desktop machines as MachineLinks.machines() gives them, online before offline, by name. A name two machines share carries
 * the device's short id, so the two can never be taken for each other.
 */
export function machineList({ here, machines = [] }) {
  const others = machines.map((m) => ({ key: m.id, id: m.id, name: cleanName(m.name), here: false, online: !!m.online, state: linkState(m), error: m.link?.lastError ?? null }));
  others.sort((a, b) => (a.online === b.online ? a.name.localeCompare(b.name) || a.id.localeCompare(b.id) : a.online ? -1 : 1));
  const counts = new Map();
  for (const m of others) counts.set(m.name.toLowerCase(), (counts.get(m.name.toLowerCase()) ?? 0) + 1);
  for (const m of others) m.label = counts.get(m.name.toLowerCase()) > 1 ? `${m.name} (${shortId(m.id)})` : m.name;
  if (!here) return others;
  return [{ key: HERE, id: null, name: cleanName(here.name, 64, "This computer"), label: "This computer", here: true, online: true, state: "online", error: null }, ...others];
}

/**
 * How a caption names the machine an action runs on: nothing while the window has only this computer (as before accounts),
 * "this computer", or the machine's label.
 */
export function whereWords(list, key) {
  const m = list.find((x) => x.key === key);
  if (!m) return "";
  if (m.here) return list.length > 1 ? "this computer" : "";
  return m.label;
}

/** A machine's place in the window: what it has shown so far. Its `seq` and `boot` are its stream's. */
export function newWorkspace() {
  return {
    sessions: new Map(), buffers: new Map(), agents: new Map(), agentSids: new Map(), piChats: new Map(),
    pi: { running: false }, runs: [], config: null, hook: null, seq: 0, boot: "",
    loaded: false, loading: null, error: null, errorCode: null, allChats: false, homeCwd: "",
  };
}

/** The goal box state a chat carries. */
export const goalBox = (s) => s.goalBox || (s.goalBox = { goal: "", plan: null, summary: "", summaryAt: 0, nudges: 0, done: false });

/**
 * One live event of a machine's stream, applied to that machine's chats. Returns the chat it was about, or null for an event
 * that is not a chat's (agents, missions, logs). The same for the chat open on the screen and for every machine in the sidebar.
 */
export function applySessionEvent(ws, ev) {
  if (!ev?.sid || ["agent", "mission", "mission-removed", "notify", "pis", "log"].includes(ev.kind)) return null;
  if (ev.kind === "removed") { ws.sessions.delete(ev.sid); ws.buffers.delete(ev.sid); return null; }
  const s = ws.sessions.get(ev.sid) || { sid: ev.sid, harness: ev.harness, lastActivity: 0, tally: null };
  if (ev.kind === "session") {
    Object.assign(s, Object.fromEntries(Object.entries({ cwd: ev.cwd, title: ev.title ? cleanTitle(ev.title) || undefined : undefined, model: ev.model, file: ev.file, owned: ev.owned, forkedFrom: ev.forkedFrom }).filter(([, v]) => v != null)));
    // A background agent's chat names the chat that started it and its agent (OpencodeRpc / ClaudeRunner `meta`).
    for (const k of ["parentSid", "agentId", "agentKind", "missionId", "missionRole"]) if (ev[k]) s[k] = ev[k];
    if (ev.agentId) ws.agentSids.set(ev.sid, ev.agentId);
  }
  if (ev.kind === "status") applyStatus(s, ev);
  if (ev.kind === "msg" && ev.role === "user" && !s.title) s.title = cleanTitle(ev.blocks?.[0]?.text || "");
  if (ev.kind === "msg" && ev.usage) {
    const t = s.tally || (s.tally = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, messages: 0, cost: 0, context: 0 });
    if (!ev.groupId || t.lastGroup !== ev.groupId) { t.lastGroup = ev.groupId; t.input += ev.usage.input; t.output += ev.usage.output; t.cacheRead += ev.usage.cacheRead; t.cacheWrite += ev.usage.cacheWrite; t.total += ev.usage.total; t.messages++; t.context = ev.usage.input + ev.usage.cacheRead + ev.usage.cacheWrite; t.cost += ev.cost || 0; }
  }
  if (ev.kind !== "session") s.lastActivity = Math.max(s.lastActivity || 0, ev.ts || 0);
  if (ev.kind === "summary") Object.assign(goalBox(s), { summary: ev.text || "", summaryAt: ev.ts, goal: ev.goal || goalBox(s).goal, explicit: !!ev.explicit, nudges: ev.nudges || 0, done: !!ev.done });
  if (ev.kind === "plan") Object.assign(goalBox(s), { plan: ev.plan, goal: ev.goal || goalBox(s).goal });
  if (ev.kind === "goal") Object.assign(goalBox(s), { goal: ev.goal || goalBox(s).goal, explicit: !!ev.explicit, done: !!ev.done, nudges: ev.nudges || 0, plan: ev.plan || goalBox(s).plan });
  if (ev.kind === "keeper") { s.hookArmed = !!ev.armed; s.hookRetryAt = ev.retryAt || 0; }
  if (ev.kind === "hook" && ev.attempt) goalBox(s).nudges = ev.attempt;
  ws.sessions.set(ev.sid, s);
  const buf = ws.buffers.get(ev.sid) || [];
  buf.push(ev);
  if (buf.length > 800) buf.splice(0, buf.length - 800);
  ws.buffers.set(ev.sid, buf);
  return s;
}

/**
 * The chats sidebar: one group per machine, in the list's order. An offline or refusing machine shows no chats (nothing was
 * fetched from it), only why. `filter` searches every machine; `only` shows one. `titleOf(ws, s)` names a chat.
 */
export function sidebarGroups({ machines, workspaces, filter = "", only = null, titleOf = (_ws, s) => s.title || "", textOf = (s) => `${s.cwd || ""} ${s.model || ""} ${s.harness || ""}` }) {
  const f = filter.trim().toLowerCase();
  const groups = [];
  for (const m of machines) {
    if (only && m.key !== only) continue;
    const ws = workspaces.get(m.key);
    let note = "";
    if (m.state === "offline") note = "offline";
    else if (m.state === "refusing") note = "refusing";
    else if (!ws || (!ws.loaded && !ws.error)) note = "loading";
    else if (ws.error) note = ws.error;
    const shown = note === "offline" || note === "refusing" || !ws?.loaded;
    const sessions = shown ? [] : [...ws.sessions.values()]
      .filter((s) => titleOf(ws, s) && (!f || `${titleOf(ws, s)} ${textOf(s)}`.toLowerCase().includes(f)))
      .sort((a, b) => (b.lastActivity || b.mtime || 0) - (a.lastActivity || a.mtime || 0));
    if (f && !sessions.length && !note) continue;
    groups.push({ m, ws, note: !shown && ws?.error ? ws.error : note, sessions });
  }
  return groups;
}

/** The desktop's one stream for every other machine (server/channel-client.mjs mergedEvents), from where each left off. */
export function mergedEventsUrl(list) {
  return `/remote/~events?m=${encodeURIComponent(JSON.stringify(list.map((x) => ({ id: x.id, since: x.seq || 0, boot: x.boot || "" }))))}`;
}

/**
 * One `m` event of the merged stream, if it is for a machine the window shows and is a chat event or a resync. Anything
 * else, approval cards above all (they act on this computer), is dropped.
 */
export function fromMerged(text, known) {
  let x;
  try { x = JSON.parse(text); } catch { return null; }
  if (!x || typeof x.id !== "string" || !known.has(x.id) || typeof x.data !== "string") return null;
  if (x.name !== "message" && x.name !== "resync") return null;
  return { id: x.id, name: x.name, data: x.data };
}

/** Half-typed messages, per chat per machine. Taken once: what is restored to the box is the box's again. */
export function createDrafts() {
  const kept = new Map();
  const key = (machineKey, sid) => `${machineKey}\u0000${sid}`;
  return {
    save(machineKey, sid, text) { if (!sid) return; if (text) kept.set(key(machineKey, sid), text); else kept.delete(key(machineKey, sid)); },
    take(machineKey, sid) { const k = key(machineKey, sid); const t = kept.get(k) ?? ""; kept.delete(k); return t; },
  };
}
