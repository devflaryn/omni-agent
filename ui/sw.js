/* The web page's app shell: a repeat visit paints with no network. The build fills in the two strings below (scripts/build-ui.mjs).

   What it may touch is the build's own list of files and nothing else. It does not look at the API, the sign-in, a machine's files
   or anything else that passes: those requests never reach respondWith, so no chat, key or file can land in a cache, and the one
   `put` here is at install. The channel is a WebSocket, which a service worker does not see at all.

   A new deployment changes this file, because the list is in it, so the browser finds it on its next check and installs it beside
   the old one, all files or none, each against the hash the build recorded. It then takes over: the next page comes from it, and a
   tab still open can load its old parts from the one earlier version kept. web-sw.js tells that tab. */
const VERSION = "__VERSION__";
const PRECACHE = "__PRECACHE__";

const CACHE = `omni-shell-${VERSION}`;
const SHELL = new Set(PRECACHE.map((file) => file.url));
const HASHED = /^\/[\w.-]+-[A-Za-z0-9]{8}\.(?:js|css|svg|png)$/;

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const answers = await Promise.all(PRECACHE.map(async ({ url, integrity }) => {
      const response = await fetch(new Request(url, { integrity, cache: "no-cache", credentials: "same-origin" }));
      if (!response.ok) throw new Error(`${url}: ${response.status}`);
      return [url, response];
    }));
    const cache = await caches.open(CACHE);
    await Promise.all(answers.map(([url, response]) => cache.put(url, response)));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    // In the order made, so the one before this is the last but this one. Anything not named as this worker names them is not ours to keep.
    const ours = names.filter((name) => name.startsWith("omni-shell-") && name !== CACHE);
    const keep = new Set([CACHE, ours[ours.length - 1]]);
    await Promise.all(names.filter((name) => !keep.has(name)).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const path = url.pathname;
  if (path === "/index.html" && request.mode === "navigate") return; // the hub sends a person there to the page
  if (SHELL.has(path)) {
    event.respondWith((async () => (await (await caches.open(CACHE)).match(path)) ?? fetch(request))());
  } else if (HASHED.test(path)) {
    // A part of the version before this, for a tab still open on it. Each name holds one content, so any cache will do.
    event.respondWith((async () => (await caches.match(path)) ?? fetch(request))());
  }
});
