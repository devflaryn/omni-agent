/* Where this window's actions go. Every request the UI makes, every event stream and every direct URL goes through here, so
   there is one place that knows which machine they are for. Modes:
     local    this computer (no prefix): exactly what the app did before accounts
     proxied  another machine, through this computer's server at /remote/<id>, which holds the channel. The desktop window.
     channel  another machine, over a channel this page holds itself (Task 8). See `setChannelTransport`.

   Changing machine reloads the page, on purpose: nothing of the last machine's can then survive, not a chat, a path in a
   field, a seq, a half-typed message or an answer still on its way. The choice lives in sessionStorage, for this window only.
   This file also runs in Node, so nothing here may touch a browser global until it is called. */

const STORE_KEY = "omni.machine";
const CONTROL_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu; // controls, direction marks and zero-width characters, line separators

/**
 * A name a device or the hub supplied, safe to show and to compare by eye: no controls, no direction marks that would turn
 * text around, no zero-width characters that make two names look alike, and not so long it pushes the rest off the screen.
 * The caller still renders it as text.
 */
export function cleanName(name, max = 64, fallback = "Unnamed device") {
  const text = String(name ?? "").replace(/\s+/g, " ").replace(CONTROL_CHARS, "").trim();
  return [...text].slice(0, max).join("") || fallback;
}

let env = {
  get storage() { try { return globalThis.sessionStorage ?? null; } catch { return null; } },
  reload: () => globalThis.location?.reload(),
};
/** For tests. */
export function setTransportEnv(replacement) { env = replacement; current = undefined; channelImpl = null; }

let current; // undefined until first read: { id, name } | null
let channelImpl = null;

function read() {
  if (current !== undefined) return current;
  current = null;
  try {
    const stored = JSON.parse(env.storage?.getItem(STORE_KEY) ?? "null");
    if (stored && typeof stored.id === "string" && stored.id) current = { id: stored.id, name: cleanName(stored.name) };
  } catch { /* an unreadable choice is no choice: this computer */ }
  return current;
}

/** The machine this window acts on, or null for this computer. */
export const machine = () => read();
export const isRemote = () => read() !== null;
export const machineName = () => read()?.name ?? "this computer";
export const mode = () => (!read() ? "local" : channelImpl ? "channel" : "proxied");
const prefix = () => (read() ? `/remote/${encodeURIComponent(read().id)}` : "");

/** The window's title, saying which machine it is on. Everything that sets the title goes through here. */
export const machineTitle = (title = "Omni Agent") => (read() ? `[${read().name}] ${title}` : title);

/**
 * The named events to take from the chosen machine's stream. Old-style approval cards act on this computer, so another
 * machine's stream must not be able to paint them: on another machine they come from this computer's own stream alone.
 */
export const streamEvents = ({ approvals, resync }) => (read() ? { resync } : { approvals, resync });

/** Task 8: a page with no server of its own hands in its channel here. */
export function setChannelTransport(impl) { channelImpl = impl; }

/**
 * Points this window at a machine, or at this computer with null, and starts the page over on it. `name` is what the top
 * bar shows. Nothing is sent to the machine by this: the reloaded page asks for its state, and says so if it cannot.
 */
export function setMachine(id, { name, reload = true } = {}) {
  const next = id ? { id: String(id), name: cleanName(name) } : null;
  const unchanged = (read()?.id ?? null) === (next?.id ?? null);
  current = next;
  try {
    if (next) env.storage?.setItem(STORE_KEY, JSON.stringify(next));
    else env.storage?.removeItem(STORE_KEY);
  } catch { /* in memory only, for this page */ }
  if (reload && !unchanged) env.reload();
  return next;
}

/** One request. Throws an Error with `.status` and `.code`, whose message names the machine when another was asked. */
export async function api(method, path, body) {
  if (mode() === "channel") return channelImpl.api(method, path, body);
  const m = read();
  const options = method !== "GET"
    ? { method, headers: { "content-type": "application/json" }, body: body !== undefined && body !== null ? JSON.stringify(body) : undefined }
    : { method: "GET" };
  let r;
  try { r = await globalThis.fetch(`${prefix()}${path}`, options); }
  catch (e) { throw m ? failure(`Could not reach ${m.name} through this computer's Omni: ${e.message}`) : e; }
  return m ? remoteAnswer(r, m) : localAnswer(r);
}

async function localAnswer(r) {
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && j.login) { globalThis.location?.reload(); throw new Error("signed out"); }
  if (!r.ok || j.error) throw failure(j.error || `${r.status}`, r.status, j.code);
  return j;
}

/** A dropped connection or a cut-off body is a failure here, never an empty success: the far machine may not have acted. */
async function remoteAnswer(r, m) {
  let text;
  try { text = await r.text(); }
  catch { throw failure(`The connection to ${m.name} was lost during that answer. The action may or may not have run there.`, 502, "machine-lost"); }
  let j = {};
  if (text) {
    try { j = JSON.parse(text); }
    catch { throw failure(`${m.name} sent an answer that could not be read. The action may or may not have run there.`, 502, "machine-lost"); }
  }
  if (!r.ok || j.error) throw failure(j.error || `${m.name} answered ${r.status}`, r.status, j.code);
  return j;
}

function failure(message, status, code) {
  const e = new Error(message);
  if (status) e.status = status;
  if (code) e.code = code;
  return e;
}

/** What createStream needs: an EventSource, for this machine. */
export function eventSource(url) {
  if (mode() === "channel") return channelImpl.eventSource(url);
  return new globalThis.EventSource(`${prefix()}${url}`);
}

/**
 * A URL for a file's bytes, for an <img>, a <video> or a download. The one helper for direct URLs: a page in channel mode
 * has no server behind a URL and answers with a blob, which is why this is a promise everywhere.
 */
export async function rawUrl(path) {
  if (mode() === "channel") return channelImpl.rawUrl(path);
  return `${prefix()}${path}`;
}

/** This computer, whichever machine the window is on: Settings → Account, Settings → Remote, their event streams. */
export const local = Object.freeze({
  async api(method, path, body) {
    const r = await globalThis.fetch(path, method !== "GET"
      ? { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) }
      : { method: "GET" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) throw failure(j.error || `${r.status}`, r.status, j.code);
    return j;
  },
  eventSource(url) { return new globalThis.EventSource(url); },
});
