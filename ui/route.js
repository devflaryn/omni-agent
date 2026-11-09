/* The window's place as a URL: `#/c/<machine>/<chat id>` for a chat, `#missions` for Missions, nothing for Home. A machine is
   "here" (this computer) or its device id, so a link made on one device opens the same chat on another. Pure. */

export const chatHash = (machine, sid) => `#/c/${encodeURIComponent(machine)}/${encodeURIComponent(sid)}`;

/** `{ kind: "chat", machine, sid }`, `{ kind: "missions" }`, or `{ kind: "home" }` for anything else. */
export function parseHash(hash) {
  const h = String(hash || "");
  if (h === "#missions") return { kind: "missions" };
  const m = /^#\/c\/([^/]+)\/(.+)$/.exec(h);
  if (!m) return { kind: "home" };
  try {
    const machine = decodeURIComponent(m[1]), sid = decodeURIComponent(m[2]);
    return machine && sid ? { kind: "chat", machine, sid } : { kind: "home" };
  } catch { return { kind: "home" }; }
}
