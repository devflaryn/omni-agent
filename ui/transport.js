/* Where this window's actions go. Every request the UI makes, every event stream and every direct URL goes through here, so
   there is one place that knows which machine they are for. Modes:
     local    this computer (no prefix): exactly what the app did before accounts
     proxied  another machine, through this computer's server at /remote/<id>, which holds the channel. The desktop window.
     channel  another machine, over a channel this page holds itself: the web page, and the iPhone app's web view. See `setChannelTransport`.

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

/**
 * A page with no server of its own hands in its channel here: {api, eventSource, rawUrl, saveFile, local}. `local` stands in for
 * this computer's server, which it does not have. From ui/page-transport.js.
 */
export function setChannelTransport(impl) { channelImpl = impl; }

/** Whether this is the web page or the iPhone's web view, which has no computer of its own and may not approve anything. */
export const webPage = () => channelImpl !== null;

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

// A link that answers pings may wait for a slow route for as long as it takes, so the window says it is waiting.
let stillWaitingAfterMs = 30_000;
let waiting = 0;
const waitingListeners = new Set();
const announceWaiting = () => { for (const listener of waitingListeners) listener(waiting); };
/** `listener(count)`: how many actions have gone unanswered past the wait. 0 when the last has its answer. */
export function onStillWaiting(listener) { waitingListeners.add(listener); return () => waitingListeners.delete(listener); }
/** For tests. */
export function setStillWaitingAfter(ms) { stillWaitingAfterMs = ms; }

/** One request. Throws an Error with `.status` and `.code`, whose message names the machine when another was asked. */
export async function api(method, path, body) {
  if (!read()) return ask(method, path, body);
  let late = false;
  const timer = setTimeout(() => { late = true; waiting++; announceWaiting(); }, stillWaitingAfterMs);
  try { return await ask(method, path, body); }
  finally {
    clearTimeout(timer);
    if (late) { waiting--; announceWaiting(); }
  }
}

async function ask(method, path, body) {
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
  return answerFrom(r.status, text, m);
}

/** What a far machine's whole answer means. Used by the proxied path above and by the page's own channel. */
export function answerFrom(status, text, m) {
  let j = {};
  if (text) {
    try { j = JSON.parse(text); }
    catch { throw failure(`${m.name} sent an answer that could not be read. The action may or may not have run there.`, 502, "machine-lost"); }
  }
  if (status < 200 || status > 299 || j.error) {
    const e = failure(j.error || `${m.name} answered ${status}`, status, j.code);
    e.body = j; // what the far machine said, whole: a file pane's conflict is in it
    throw e;
  }
  return j;
}

export function failure(message, status, code) {
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
 * A URL for an <img>, a <video> or an <audio>, and for nothing else. The one helper for direct URLs: a page in channel mode has
 * no server behind a URL and answers with a blob, which is why this is a promise everywhere. A blob carries the page's origin, so
 * there it refuses, with code `not-viewable`, anything that could run, and with `too-large-for-page` anything over 200 MB. Both
 * mean: offer saveFile. So a caller shows its error with a Download button, and never frames this or navigates to it.
 */
export async function rawUrl(path) {
  if (mode() === "channel") return channelImpl.rawUrl(path);
  return `${prefix()}${path}`;
}

/** Saves a file's bytes on this device, whatever they are. To be called from a click: the page's way may open a file dialog. */
export async function saveFile(path, name) {
  if (mode() === "channel") return channelImpl.saveFile(path, name);
  const a = globalThis.document.createElement("a");
  a.href = `${prefix()}${path}`;
  a.download = name;
  globalThis.document.body.appendChild(a);
  a.click();
  a.remove();
  return {};
}

/**
 * Whether a file's URL may go in an <iframe> or a new window, as a PDF does on a desktop, where a server's sandbox header goes with
 * it. A page has no such header to give a blob: it never does this, and offers saveFile.
 */
export const framesFiles = () => mode() !== "channel";

/** The app's markup, for the web page to take its elements from. */
export const appMarkup = async () => {
  const r = await globalThis.fetch("index.html");
  if (!r.ok) throw new Error(`the app's page answered ${r.status}`);
  return r.text();
};

/** This computer, whichever machine the window is on: Settings → Account, Settings → Remote, their event streams. */
export const local = Object.freeze({
  async api(method, path, body) {
    if (channelImpl?.local) return channelImpl.local.api(method, path, body);
    const r = await globalThis.fetch(path, method !== "GET"
      ? { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) }
      : { method: "GET" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) throw failure(j.error || `${r.status}`, r.status, j.code);
    return j;
  },
  eventSource(url) { return channelImpl?.local ? channelImpl.local.eventSource(url) : new globalThis.EventSource(url); },
});
