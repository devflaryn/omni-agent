// The web page's files. The list is dist/ui/build.json, written by the build (scripts/build-ui.mjs) with exact names, and read once at
// the start: there is no directory here to walk, so a path can name nothing but what is on that list. Deploy carries the same list
// (hub/deploy.sh asks the build for it), and a test holds the two together.
//
// HSTS stays off, by ruling: a browser applies it to every port of the name, and sites on http, 8081 and 8082 must keep working.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const JS = "text/javascript; charset=utf-8";
const CONTENT_TYPES = { ".html": "text/html; charset=utf-8", ".js": JS, ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png" };
const DIST = new URL("../dist/ui/", import.meta.url);
/** A hash in the name means this name always holds these bytes. */
const FOREVER = "public, max-age=31536000, immutable";
/** Checked with the hub on each load, or by the service worker: a person gets a fixed page as soon as it is deployed. */
const CHECKED = "no-cache";

/** What the build recorded. Throws if there is none: a hub with no page does not start. */
export function readBuild(dir = DIST) {
  const build = JSON.parse(readFileSync(fileURLToPath(new URL("build.json", dir)), "utf8"));
  if (build.format !== 1 || typeof build.files !== "object") throw new Error("build.json is not one this code reads");
  return build;
}

/** The page and everything it loads. */
export const webFileList = (dir = DIST) => Object.keys(readBuild(dir).files);

/** `/index.html` is the app's markup, which web.js fetches. It starts nothing on its own, so a person sent to it goes to the page. */
const FETCH_ONLY = new Set(["/index.html"]);

/**
 * The policy for everything served. `blob:` is for images and media alone, so a far machine's file can reach nothing else, and
 * `data:` is on img-src because the app's CSS has its icons as data: and chat images come so: an <img> runs nothing either way.
 */
export function webPolicy(origin) {
  const socket = origin ? ` ${origin.replace(/^http/, "ws")}` : "";
  return [
    "default-src 'none'",
    "script-src 'self'",
    "worker-src 'self'",
    "style-src 'self'",
    "img-src 'self' blob: data:",
    "media-src 'self' blob:",
    `connect-src 'self'${socket}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

export function webHeaders(origin) {
  return {
    "Content-Security-Policy": webPolicy(origin),
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
  };
}

/**
 * Reads every file now and checks it against the list, so a missing or altered one stops the hub at its start rather than breaking
 * a page later. `entry` is the file that answers `/`: the hub's is the web page, the desktop server's the app.
 */
export function loadWebFiles(dir = DIST, { entry = "web.html", except = [] } = {}) {
  const files = new Map();
  const at = (name) => fileURLToPath(new URL(name, dir));
  for (const [name, listed] of Object.entries(readBuild(dir).files)) {
    if (except.includes(name)) continue;
    const body = readFileSync(at(name));
    const hash = createHash("sha256").update(body).digest("hex");
    if (hash !== listed.sha256) throw new Error(`${name} is not the file that was built`);
    const form = (bytes, tag) => ({ bytes, etag: `"${hash.slice(0, 32)}${tag}"` });
    const forms = { identity: form(body, "") };
    if (listed.br) forms.br = form(readFileSync(at(`${name}.br`)), "-br");
    if (listed.gz) forms.gzip = form(readFileSync(at(`${name}.gz`)), "-gz");
    const file = { forms, type: CONTENT_TYPES[name.slice(name.lastIndexOf("."))], cache: listed.immutable ? FOREVER : CHECKED };
    files.set(name === entry ? "/" : `/${name}`, file);
    if (name === entry && name === "index.html") files.set("/index.html", file);
  }
  return files;
}

/** What the browser says it takes, by name. An encoding given q=0 is refused, and a `*` covers what is not named. */
function accepted(header) {
  const named = new Map();
  for (const part of String(header ?? "").split(",")) {
    const [name, ...params] = part.trim().toLowerCase().split(";");
    if (!name) continue;
    const q = params.map((p) => /^\s*q=([\d.]+)\s*$/.exec(p)?.[1]).find(Boolean);
    named.set(name, q === undefined ? 1 : Number(q));
  }
  const wants = (name) => (named.has(name) ? named.get(name) > 0 : (named.get("*") ?? 0) > 0);
  return wants;
}

const chosenForm = (file, header) => {
  const wants = accepted(header);
  if (file.forms.br && wants("br")) return ["br", file.forms.br];
  if (file.forms.gzip && wants("gzip")) return ["gzip", file.forms.gzip];
  return [null, file.forms.identity];
};

const named = (header, etag) => String(header ?? "").split(",").some((one) => one.trim().replace(/^W\//, "") === etag);

/**
 * What answers when a browser checks a service worker other than ours: one a hacked hub had planted under another name, which a clean
 * hub no longer has. A 404 would leave it in charge, as browsers keep the worker they have when a check fails, and it would go on
 * serving its own page. This takes its place, removes itself and reloads what it controlled. It is the only way back in, for the
 * browser checks with the hub directly, past the worker. The header is the browser's own, and a page cannot set it.
 */
const WORKER_REMOVER = 'self.addEventListener("install",()=>self.skipWaiting());self.addEventListener("activate",(e)=>e.waitUntil((async()=>{for(const n of await caches.keys())await caches.delete(n);await self.registration.unregister();for(const c of await self.clients.matchAll({type:"window"}))c.navigate(c.url);})()));';

/** Answers a request for one of the files. Returns false for anything else. `fetchOnly` is the hub's: the desktop's `/index.html` is a page. */
export function serveWebFile(req, res, files, headers, { fetchOnly = FETCH_ONLY } = {}) {
  const path = req.url.split("?", 1)[0];
  if (req.method === "GET" && req.headers["service-worker"] === "script" && path !== "/sw.js") {
    res.writeHead(200, { ...headers, "Content-Type": JS, "Cache-Control": "no-store" });
    res.end(WORKER_REMOVER);
    return true;
  }
  const file = files.get(path);
  if (!file || (req.method !== "GET" && req.method !== "HEAD")) return false;
  if (fetchOnly.has(path) && req.headers["sec-fetch-dest"] === "document") {
    res.writeHead(303, { ...headers, Location: "/", "Content-Length": 0 });
    res.end();
    return true;
  }
  const [encoding, form] = chosenForm(file, req.headers["accept-encoding"]);
  const common = { ...headers, "Content-Type": file.type, "Cache-Control": file.cache, ETag: form.etag, Vary: "Accept-Encoding", ...(encoding ? { "Content-Encoding": encoding } : {}) };
  if (named(req.headers["if-none-match"], form.etag)) {
    res.writeHead(304, common);
    res.end();
    return true;
  }
  res.writeHead(200, { ...common, "Content-Length": form.bytes.length });
  res.end(req.method === "HEAD" ? undefined : form.bytes);
  return true;
}
