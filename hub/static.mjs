// The web page's files. An explicit list of exact paths, read once at the start: there is no directory here to walk, so a path
// can name nothing but what is on this list. Deploy keeps the same list (hub/deploy.sh), and a test holds the two together.
//
// HSTS stays off, by ruling: a browser applies it to every port of the name, and sites on http, 8081 and 8082 must keep working.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const JS = "text/javascript; charset=utf-8";
const CONTENT_TYPES = { ".html": "text/html; charset=utf-8", ".js": JS, ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png" };

/** The page and everything it loads, by the path the browser asks for. `/` is ui/web.html. */
export const WEB_FILES = Object.freeze([
  "web.html", "web.js", "web.css", "login-worker.js",
  "account-core.js", "account-error.js", "channel-client.js", "channel-frames.js", "channel-set.js", "device-log.js", "emitter.js", "hub-socket.js", "log-trust.js", "machine-links.js",
  "page-account.js", "page-files.js", "page-store.js", "page-transport.js", "transport.js",
  "index.html", "styles.css", "app.js", "account.js", "composer.js", "contextmenu.js", "editor.js", "explorer.js", "fileicons.js", "filepane.js", "highlight.js", "lib.js", "mcp-settings.js", "mission.js", "office-engine.js", "office-font.js", "office-props.js", "office-worker.js", "office.js", "panel.js", "plan.js", "remote.js", "resizer.js", "settings.js", "sidebar.js", "stream.js", "thinking.js", "transcript.js",
  "logo.svg", "icon-32.png", "icon-180.png", "icon-192.png", "icon-512.png",
]);

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

/** Reads every file now, so a missing one stops the hub at its start rather than breaking a page later. */
export function loadWebFiles(dir = new URL("../ui/", import.meta.url)) {
  const files = new Map();
  for (const name of WEB_FILES) {
    const body = readFileSync(fileURLToPath(new URL(name, dir)));
    const entry = { body, type: CONTENT_TYPES[name.slice(name.lastIndexOf("."))], etag: `"${createHash("sha256").update(body).digest("base64url")}"` };
    files.set(name === "web.html" ? "/" : `/${name}`, entry);
  }
  return files;
}

/** Answers a request for one of the files. Returns false for anything else. */
export function serveWebFile(req, res, files, headers) {
  const path = req.url.split("?", 1)[0];
  const file = files.get(path);
  if (!file || (req.method !== "GET" && req.method !== "HEAD")) return false;
  if (FETCH_ONLY.has(path) && req.headers["sec-fetch-dest"] === "document") {
    res.writeHead(303, { ...headers, Location: "/", "Content-Length": 0 });
    res.end();
    return true;
  }
  // Checked with the hub on each load: a person gets a fixed page as soon as it is deployed.
  const common = { ...headers, "Content-Type": file.type, "Cache-Control": "no-cache", ETag: file.etag };
  if (req.headers["if-none-match"] === file.etag) {
    res.writeHead(304, common);
    res.end();
    return true;
  }
  res.writeHead(200, { ...common, "Content-Length": file.body.length });
  res.end(req.method === "HEAD" ? undefined : file.body);
  return true;
}
