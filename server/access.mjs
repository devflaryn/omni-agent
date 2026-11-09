/**
 * Who may do what, from where.
 *
 * - **The host** (a request on the loopback listener, from a loopback address, naming a loopback Host, with no proxy
 *   header) reads and writes freely: it is the person at this machine. Account actions also need the desktop window,
 *   see WindowGate.
 * - **A device on the account** reaches this server over a channel (server/channel-host.mjs): what the host can do,
 *   except the list in channelAllowed.
 * - **Anything else** is refused: a loopback request that fails one of the host's checks (DNS rebinding, a proxy or a
 *   tunnel on this machine) is not the person at it.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { promises as fsp } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, resolve as resolvePath, sep } from "node:path";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** The host is a loopback socket whose Host header is loopback too (no DNS rebinding) and that came through no proxy
 *  (a tunnel or reverse proxy on this machine is not the person at it). */
export function isHostRequest(req) {
  if (!LOOPBACK.has(req.socket?.remoteAddress || "")) return false;
  if (req.headers["x-forwarded-for"] || req.headers.forwarded || req.headers["x-real-ip"]) return false;
  const host = String(req.headers.host || "").toLowerCase().replace(/:\d+$/, "");
  return LOOPBACK_HOSTS.has(host);
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// ------------------------------------------------------------------------------- channels
/** The Host a channel request carries: never a loopback name, so isHostRequest can never be true of one. */
export const CHANNEL_HOST = "omni-channel.invalid";
const CHANNEL_BASE = `http://${CHANNEL_HOST}`;
const CHANNEL_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
const MAX_DECODES = 5;
/** Never over a channel, matched on a canonical path. Acting as an agent is not a user's request; nobody strands a
 *  machine they cannot restart; account actions need the desktop window; reveal opens a window on that machine's screen. */
const NEVER_OVER_CHANNEL = /^\/(mcp|remote|api\/(account|remote|shutdown|claude\/task|missions\/tool|missions\/[^/]+\/kg\/load|fs\/reveal))(\/|$)/;

/** A request target's path as a route would have to see it to be reached by any spelling, or null when it cannot be trusted. */
function canonicalChannelPath(target) {
  if (typeof target !== "string" || !target.startsWith("/") || target.startsWith("//")) return null;
  // URL drops tabs and newlines and reads a backslash as a slash, so these would change what a route is matched against.
  if (/[\x00-\x20\x7f\\]/.test(target)) return null;
  let path;
  try { path = new URL(target, CHANNEL_BASE).pathname; } catch { return null; }
  for (let i = 0; ; i++) {
    let decoded;
    try { decoded = decodeURIComponent(path); } catch { return null; }
    if (decoded === path) break;
    if (i >= MAX_DECODES) return null;
    path = decoded;
  }
  if (/[\x00-\x1f\x7f\\]/.test(path)) return null;
  const segments = [];
  for (const segment of path.toLowerCase().split("/")) {
    const clean = segment.replace(/[ .]+$/, ""); // Windows ignores these, and so would a path built from this one
    if (segment === "..") segments.pop();
    else if (clean) segments.push(clean);
  }
  return `/${segments.join("/")}`;
}

/** Whether a device may make this request over a channel. Allowed by default, except the list above. */
export function channelAllowed(method, target) {
  if (!CHANNEL_METHODS.has(method)) return false;
  const path = canonicalChannelPath(target);
  return path !== null && !NEVER_OVER_CHANNEL.test(path);
}

// --------------------------------------------------------------------------- the account folder
const WINDOWS = process.platform === "win32";
const FOLDS_CASE = WINDOWS || process.platform === "darwin";
const fold = (p) => (FOLDS_CASE ? p.toLowerCase() : p);
const within = (child, parent) => {
  const [c, p] = [fold(child), fold(parent).replace(/[\\/]+$/, "")];
  return c === p || c.startsWith(p + sep);
};

/**
 * In this folder or a sibling of its family: a second instance's account-<port> holds another device identity.
 */
function inFamily(child, dir) {
  const c = fold(child), d = fold(dir).replace(/[\\/]+$/, "");
  const parent = dirname(d);
  const prefix = parent.endsWith(sep) ? parent : parent + sep;
  return c.startsWith(prefix) && c.slice(prefix.length).split(sep, 1)[0].startsWith(basename(d).replace(/-\d+$/, ""));
}

/** What Windows would open: it ignores trailing dots and spaces in a name and takes `name:stream` as `name`. */
function windowsSpelling(path) {
  const drive = /^[a-zA-Z]:/.exec(path)?.[0] ?? "";
  const clean = path.slice(drive.length).split(/[\\/]/).map((part) => (part === "." || part === ".." ? part : part.replace(/:.*$/, "").replace(/[. ]+$/, "")));
  return resolvePath(drive + clean.join("\\"));
}

/** A share on this machine, as the drive path it is, or null. Any share of this machine can reach the folder another way. */
function windowsLocalShare(path) {
  const m = /^[\\/]{2}([^\\/]+)[\\/]([^\\/]+)(.*)$/s.exec(path);
  if (!m) return null;
  const host = m[1].toLowerCase();
  if (host !== "localhost" && host !== hostname().toLowerCase() && !/^127\.\d+\.\d+\.\d+$/.test(host) && host !== "[::1]") return null;
  return /^[a-zA-Z]\$$/.test(m[2]) ? `${m[2][0]}:${m[3] || "\\"}` : null;
}

/** The real path of the deepest part that exists, with the rest added back. The native call expands 8.3 names and links. */
async function realPathOf(path) {
  let tail = "", current = path;
  for (;;) {
    try { return tail ? resolvePath(await fsp.realpath(current), `.${sep}${tail}`) : await fsp.realpath(current); } catch { /* not there, or not readable */ }
    const parent = dirname(current);
    if (parent === current) return path;
    tail = tail ? `${current.slice(parent.length).replace(/^[\\/]+/, "")}${sep}${tail}` : current.slice(parent.length).replace(/^[\\/]+/, "");
    current = parent;
  }
}

const statOf = async (path) => { try { return await fsp.stat(path, { bigint: true }); } catch { return null; } };
const sameFolder = (a, b) => a && b && a.ino === b.ino && (WINDOWS || a.dev === b.dev);

/**
 * Whether a path is in one of the account folders or their `account*` siblings (`family: false`: only in those folders), by any spelling: `..`, case, 8.3 names, links, streams, device paths and
 * shares. Without `containing` a parent of the folder is fine to read. With it, a parent counts too: renaming or copying
 * a parent would take the folder along.
 */
export async function inAccountFolder(path, dirs, { containing = false, family = true } = {}) {
  const isIn = family ? inFamily : within;
  const text = String(path);
  if (text.includes("\0")) return true;
  if (WINDOWS && /^[\\/]{2}[?.][\\/]/.test(text)) return true; // \\?\ and \\.\ reach everything without normal path rules
  const given = (WINDOWS && windowsLocalShare(text)) || text;
  const spellings = WINDOWS ? [resolvePath(given), windowsSpelling(given)] : [resolvePath(given)];
  for (const spelling of spellings) {
    const real = await realPathOf(spelling);
    for (const dir of dirs) {
      const lexical = resolvePath(dir);
      const realDir = await realPathOf(lexical);
      for (const candidate of [spelling, real]) {
        if (isIn(candidate, lexical) || isIn(candidate, realDir)) return true;
        if (containing && (within(lexical, candidate) || within(realDir, candidate))) return true;
      }
      // The same folder seen some other way (another share, a mount): ask the file system.
      const folder = await statOf(realDir);
      if (folder) {
        for (let at = real; ; at = dirname(at)) {
          if (sameFolder(await statOf(at), folder)) return true;
          if (dirname(at) === at) break;
        }
      }
    }
  }
  return false;
}

const PATH_KEYS = new Set(["root", "path", "to", "dir", "cwd", "file", "binary", "folder", "target", "from", "dest", "destination"]);
const MAX_WALK_DEPTH = 6;

function pathValues(value, out, depth = 0) {
  if (depth > MAX_WALK_DEPTH || typeof value !== "object" || value === null) return out;
  for (const [key, inner] of Object.entries(value)) {
    // A route may turn what it is given into text, so a list of one path is that path.
    if (PATH_KEYS.has(key) && (typeof inner === "string" || Array.isArray(inner))) out.push([key, String(inner)]);
    if (typeof inner !== "string") pathValues(inner, out, depth + 1);
  }
  return out;
}

/**
 * Whether a request names a path in the account folder, in its query or anywhere in its JSON body. Applied to every route
 * and every caller, the person at the machine included, since an agent on this machine counts as that person.
 * `bases` are folders a relative path might be taken from. A change to files also may not touch a parent of the folder.
 */
export async function requestTouchesAccountFolder({ method, path: route, query, body, bases, dirs, family = true }) {
  const values = [...query.entries()].filter(([key]) => PATH_KEYS.has(key));
  pathValues(body, values);
  const fileRoute = route.startsWith("/api/fs/");
  if (!values.length && !fileRoute) return false;
  const containing = fileRoute && method !== "GET" && method !== "HEAD";
  const givenRoots = values.filter(([key]) => key === "root").map(([, value]) => value);
  const roots = [...givenRoots, ...bases];
  const candidates = fileRoute && !givenRoots.length ? [...bases] : [];
  for (const [key, value] of values) {
    if (key === "root") candidates.push(value);
    else for (const root of roots) {
      candidates.push(/^[\\/]{2}/.test(value) ? value : resolvePath(root, value));
      // What server/files.mjs opens: it takes a leading slash as its root rather than the disk, and a backslash as a separator.
      if (fileRoute) candidates.push(resolvePath(root, value.replace(/\\/g, "/").replace(/^\/+/, "") || "."));
    }
  }
  for (const candidate of candidates) if (await inAccountFolder(candidate, dirs, { containing, family })) return true;
  return false;
}

// ------------------------------------------------------------------------------ the window token
export const WINDOW_COOKIE = "omni_window";
const sha = (text) => createHash("sha256").update(String(text)).digest();
const sameSecret = (a, b) => timingSafeEqual(sha(a), sha(b));

/**
 * A loopback connection only says "something on this machine", which includes every agent. Account actions need the
 * desktop window, which alone is handed a token by the launcher that started this server. The token is swapped once for
 * a cookie the page's scripts, and anything else that cannot get into the window, cannot read.
 */
export class WindowGate {
  #token;
  #cookie = null;

  constructor(token) { this.#token = token || null; this.available = !!token; }

  /** For GET /?...&token=: the redirect that drops it from the URL, with the cookie when it is right and unused. */
  swap(req, url) {
    if (!req.omniHost) return null;
    const given = url.searchParams.get("token");
    const clean = new URLSearchParams(url.searchParams);
    clean.delete("token");
    const query = clean.toString();
    const out = { location: `${url.pathname}${query ? `?${query}` : ""}`, cookie: null };
    if (this.#token && sameSecret(given, this.#token)) {
      this.#token = null;
      this.#cookie = randomBytes(32).toString("base64url");
      out.cookie = `${WINDOW_COOKIE}=${this.#cookie}; Path=/; HttpOnly; SameSite=Strict`;
    }
    return out;
  }

  /**
   * Which kind of refusal, for the window to explain: `no-window` when this server was started with no desktop window (start.cmd,
   * start.sh), `other-window` when it was, and this is not that window (a second launcher reusing the server, or a browser tab).
   */
  refusalCode(req) {
    if (!req.omniHost) return "not-here";
    if (!this.available) return "no-window";
    return "other-window";
  }

  /** Why this request may not use an account route, or null. */
  refusal(req) {
    if (!req.omniHost) return "only the desktop window on this computer can do that";
    if (!this.available) return "Account actions work only in the Omni desktop app: open the desktop app to use them";
    const given = parseCookies(req.headers.cookie)[WINDOW_COOKIE];
    if (!this.#cookie || !given || !sameSecret(given, this.#cookie)) return "Account actions work only in the Omni desktop window: reopen the desktop app";
    const origin = req.headers.origin;
    const own = `http://${req.headers.host}`;
    // SameSite does not stop another page on this site, which includes another port. A change must name this exact page.
    if (req.method !== "GET" && req.method !== "HEAD" ? origin !== own : origin !== undefined && origin !== own) return "that request did not come from the Omni window";
    return null;
  }
}
