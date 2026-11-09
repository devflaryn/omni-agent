/* Where this window's actions go. Every request the UI makes, every event stream and every direct URL goes through here, so
   there is one place that knows which machine they are for. Modes:
     local    this computer (no prefix): exactly what the app did before accounts
     proxied  another machine, through this computer's server at /remote/<id>, which holds the channel. The desktop window.
     channel  another machine, over a channel this page holds itself: the web page, and the iPhone app's web view. See `setChannelTransport`.

   A window shows every machine on the account at once. `at(machine)` is a handle fixed to one machine: whatever it sends goes
   there and nowhere else, however the window moves on. The window's focus (`machine()`) is the machine of what it shows now:
   the open chat, or the one a new chat starts on. Changing it never reloads the page, so no draft is lost; files with unsaved
   changes are asked about first, since the file pane is the focused machine's. The focus lives in sessionStorage, for this
   window only. This file also runs in Node, so nothing here may touch a browser global until it is called. */

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
  confirm: (text) => globalThis.confirm(text),
};
/** For tests. */
export function setTransportEnv(replacement) { env = replacement; current = undefined; channelImpl = null; channels.clear(); leaveChecks.clear(); }

let current; // undefined until first read: { id, name } | null
let channelImpl = null;
const channels = new Map(); // machine id → its channel transport, on a page
const leaveChecks = new Set();

function read() {
  if (current !== undefined) return current;
  current = null;
  try {
    const stored = JSON.parse(env.storage?.getItem(STORE_KEY) ?? "null");
    if (stored && typeof stored.id === "string" && stored.id) current = { id: stored.id, name: cleanName(stored.name) };
  } catch { /* an unreadable choice is no choice: this computer */ }
  return current;
}

/** The machine this window is focused on, or null for this computer. */
export const machine = () => read();
export const isRemote = () => read() !== null;
export const machineName = () => read()?.name ?? "this computer";
export const mode = () => (!read() ? "local" : channelImpl ? "channel" : "proxied");

/** The window's title, saying which machine it is on. Everything that sets the title goes through here. */
export const machineTitle = (title = "Omni Agent") => (read() ? `[${read().name}] ${title}` : title);

/**
 * A page with no server of its own hands in its channel here: {api, eventSource, rawUrl, saveFile, local, forMachine(m)}.
 * `local` stands in for this computer's server, which it does not have; `forMachine` gives the same for any one machine.
 * From ui/page-transport.js.
 */
export function setChannelTransport(impl) { channelImpl = impl; channels.clear(); }

/** Whether this is the web page or the iPhone's web view, which has no computer of its own and may not approve anything. */
export const webPage = () => channelImpl !== null;

/** Whether this is the iPhone app: a client like the page, but installed, approved as `full`, and with nothing that runs out. */
export const onPhone = () => channelImpl?.client === "phone";

/** `check()` says why this window should not leave its machine (unsaved files), or nothing. Returns the way to remove it. */
export function onLeaveCheck(check) { leaveChecks.add(check); return () => leaveChecks.delete(check); }

/**
 * Focuses this window on a machine, or on this computer with null. Never reloads. Returns whether it moved: unsaved files
 * are asked about first, and No leaves everything where it was. `whenClean`: not the person's own choice, so it does not
 * ask, and does not move while there is something to lose.
 */
export function setMachine(id, { name, whenClean = false } = {}) {
  const next = id ? { id: String(id), name: cleanName(name) } : null;
  const unchanged = (read()?.id ?? null) === (next?.id ?? null);
  if (!unchanged) {
    const reasons = [...leaveChecks].map((check) => check()).filter(Boolean);
    if (reasons.length && (whenClean || !env.confirm(`${reasons.join("\n")}\n\nGo to ${next ? next.name : "this computer"} and lose them?`))) return false;
  }
  current = next;
  try {
    if (next) env.storage?.setItem(STORE_KEY, JSON.stringify(next));
    else env.storage?.removeItem(STORE_KEY);
  } catch { /* in memory only, for this page */ }
  return true;
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

const prefixFor = (m) => (m ? `/remote/${encodeURIComponent(m.id)}` : "");

/** The channel transport for one machine, on a page. */
function channelFor(m) {
  if (!channelImpl.forMachine) return channelImpl;
  let t = channels.get(m.id);
  if (!t) channels.set(m.id, (t = channelImpl.forMachine({ id: m.id, name: m.name })));
  return t;
}

/** One request to `m` (null: this computer). Throws an Error with `.status`, `.code` and the answer as `.body`, whose message names the machine when another was asked. */
async function apiOn(m, method, path, body) {
  if (!m) return ask(null, method, path, body);
  let late = false;
  const timer = setTimeout(() => { late = true; waiting++; announceWaiting(); }, stillWaitingAfterMs);
  try { return await ask(m, method, path, body); }
  finally {
    clearTimeout(timer);
    if (late) { waiting--; announceWaiting(); }
  }
}

async function ask(m, method, path, body) {
  if (m && channelImpl) return channelFor(m).api(method, path, body);
  const options = method !== "GET"
    ? { method, headers: { "content-type": "application/json" }, body: body !== undefined && body !== null ? JSON.stringify(body) : undefined }
    : { method: "GET" };
  let r;
  try { r = await globalThis.fetch(`${prefixFor(m)}${path}`, options); }
  catch (e) { throw m ? failure(`Could not reach ${m.name} through this computer's Omni: ${e.message}`) : e; }
  return m ? remoteAnswer(r, m) : localAnswer(r);
}

async function localAnswer(r) {
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw failure(j.error || `${r.status}`, r.status, j.code, j);
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
  // What the far machine said goes along whole: a file pane's conflict is in it.
  if (status < 200 || status > 299 || j.error) throw failure(j.error || `${m.name} answered ${status}`, status, j.code, j);
  return j;
}

export function failure(message, status, code, body) {
  const e = new Error(message);
  if (status) e.status = status;
  if (code) e.code = code;
  if (body) e.body = body;
  return e;
}

function eventSourceOn(m, url) {
  if (m && channelImpl) return channelFor(m).eventSource(url);
  return new globalThis.EventSource(`${prefixFor(m)}${url}`);
}

async function rawUrlOn(m, path) {
  if (m && channelImpl) return channelFor(m).rawUrl(path);
  return `${prefixFor(m)}${path}`;
}

async function saveFileOn(m, path, name) {
  if (m && channelImpl) return channelFor(m).saveFile(path, name);
  const a = globalThis.document.createElement("a");
  a.href = `${prefixFor(m)}${path}`;
  a.download = name;
  globalThis.document.body.appendChild(a);
  a.click();
  a.remove();
  return {};
}

/**
 * A handle on one machine ({id, name}, or null for this computer). Everything sent through it goes to that machine, whatever
 * the window is focused on later: a chat's Stop reaches the chat's machine even if the person has moved on.
 */
export function at(m) {
  const fixed = m ? { id: String(m.id), name: cleanName(m.name) } : null;
  return Object.freeze({
    machine: fixed,
    api: (method, path, body) => apiOn(fixed, method, path, body),
    eventSource: (url) => eventSourceOn(fixed, url),
    rawUrl: (path) => rawUrlOn(fixed, path),
    saveFile: (path, name) => saveFileOn(fixed, path, name),
  });
}

/** One request to the focused machine. See apiOn. */
export const api = (method, path, body) => apiOn(read(), method, path, body);

/** What createStream needs: an EventSource, for the focused machine. */
export const eventSource = (url) => eventSourceOn(read(), url);

/**
 * A URL for an <img>, a <video> or an <audio>, and for nothing else. The one helper for direct URLs: a page in channel mode has
 * no server behind a URL and answers with a blob, which is why this is a promise everywhere. A blob carries the page's origin, so
 * there it refuses, with code `not-viewable`, anything that could run, and with `too-large-for-page` anything over 200 MB. Both
 * mean: offer saveFile. So a caller shows its error with a Download button, and never frames this or navigates to it.
 */
export const rawUrl = (path) => rawUrlOn(read(), path);

/** Saves a file's bytes on this device, whatever they are. To be called from a click: the page's way may open a file dialog. */
export const saveFile = (path, name) => saveFileOn(read(), path, name);

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
    if (!r.ok || j.error) throw failure(j.error || `${r.status}`, r.status, j.code, j);
    return j;
  },
  eventSource(url) { return channelImpl?.local ? channelImpl.local.eventSource(url) : new globalThis.EventSource(url); },
});
