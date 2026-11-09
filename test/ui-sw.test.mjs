// The web page's service worker, run for real against stand-ins for the browser's caches and fetch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { readBuild } from "../hub/static.mjs";

const source = readFileSync(new URL("../ui/sw.js", import.meta.url), "utf8");
const built = readFileSync(new URL("../dist/ui/sw.js", import.meta.url), "utf8");

function worker({ version = "v1", files = [{ url: "/", integrity: "sha256-a" }, { url: "/index.html", integrity: "sha256-b" }, { url: "/app-AAAAAAAA.js", integrity: "sha256-c" }], network = {}, caches = new Map(), script = source } = {}) {
  const listeners = {};
  const log = { fetched: [], skipped: 0, claimed: 0, navigated: [] };
  const cacheFor = (name) => {
    if (!caches.has(name)) caches.set(name, new Map());
    const store = caches.get(name);
    return {
      async put(key, value) { store.set(typeof key === "string" ? key : new URL(key.url).pathname, value); },
      async match(key) { return store.get(typeof key === "string" ? key : new URL(key.url).pathname); },
    };
  };
  const scope = {
    location: new URL("https://hub.example/sw.js"),
    addEventListener: (type, fn) => { listeners[type] = fn; },
    skipWaiting: async () => { log.skipped++; },
    clients: { claim: async () => { log.claimed++; }, matchAll: async () => [] },
    caches: {
      open: async (name) => cacheFor(name),
      keys: async () => [...caches.keys()],
      delete: async (name) => caches.delete(name),
      match: async (key) => { for (const store of caches.values()) { const hit = store.get(key); if (hit) return hit; } return undefined; },
    },
    fetch: async (request) => {
      const path = new URL(request.url ?? request, "https://hub.example").pathname;
      log.fetched.push({ path, integrity: request.integrity });
      if (network[path] === undefined) return { ok: true, status: 200, body: `network ${path}`, clone() { return this; } };
      if (network[path] instanceof Error) throw network[path];
      return network[path];
    },
    Request: class { constructor(url, init = {}) { this.url = new URL(url, "https://hub.example").href; Object.assign(this, init); } },
    URL, Promise, Map, Set, JSON, console,
  };
  scope.self = scope;
  createContext(scope);
  const text = script.replace('"__VERSION__"', JSON.stringify(version)).replace('"__PRECACHE__"', JSON.stringify(files));
  runInContext(text, scope);
  const extendable = () => { const waits = []; return { waitUntil: (p) => waits.push(p), done: () => Promise.all(waits) }; };
  return {
    log, caches, listeners,
    async install() { const e = extendable(); listeners.install(e); await e.done(); },
    async activate() { const e = extendable(); listeners.activate(e); await e.done(); },
    /** What the worker does with a request: `{ passed: true }` if it stays out of it. */
    async fetch(url, { method = "GET", mode = "cors" } = {}) {
      let answer;
      listeners.fetch({ request: { url: new URL(url, "https://hub.example").href, method, mode }, respondWith: (p) => { answer = p; } });
      return answer ? { passed: false, response: await answer } : { passed: true };
    },
  };
}

test("install takes each file with the hash the build recorded, and all of them or none", async () => {
  const w = worker();
  await w.install();
  assert.deepEqual(w.log.fetched.map((f) => [f.path, f.integrity]), [["/", "sha256-a"], ["/index.html", "sha256-b"], ["/app-AAAAAAAA.js", "sha256-c"]]);
  assert.equal(w.log.skipped, 1, "a new version takes over without waiting for tabs to close");

  const broken = worker({ network: { "/app-AAAAAAAA.js": { ok: false, status: 404, clone() { return this; } } } });
  await assert.rejects(() => broken.install());
  assert.equal(broken.caches.get("omni-shell-v1"), undefined, "a half-fetched version never stays");

  const refused = worker({ network: { "/index.html": new TypeError("integrity") } });
  await assert.rejects(() => refused.install());
  assert.equal(refused.caches.size, 0);
});

test("a repeat visit is answered with no network at all", async () => {
  const w = worker();
  await w.install();
  await w.activate();
  w.log.fetched.length = 0;
  for (const path of ["/", "/?x=1", "/index.html", "/app-AAAAAAAA.js"]) {
    const r = await w.fetch(path);
    assert.equal(r.passed, false, path);
    assert.ok(r.response.body, path);
  }
  assert.equal(w.log.fetched.length, 0);
});

test("the worker stays out of everything but the shell: API, sign-in, keys, a machine's files, other origins, every change", async () => {
  const w = worker();
  await w.install();
  await w.activate();
  const entries = [...w.caches.get("omni-shell-v1").keys()];
  for (const url of ["/api/health", "/api/login", "/api/session/start", "/api/machines", "/ws", "/events", "/remote/abc/api/state", "/api/fs/raw?path=x", "/sw.js", "/something.js", "/styles.css", "/app.js", "/index.html.br", "/.git/config", "https://other.example/app-AAAAAAAA.js"]) {
    assert.equal((await w.fetch(url)).passed, true, url);
  }
  for (const method of ["POST", "PUT", "DELETE", "HEAD"]) assert.equal((await w.fetch("/", { method })).passed, true, method);
  assert.deepEqual([...w.caches.get("omni-shell-v1").keys()], entries, "and nothing it saw was kept");
});

test("nothing is ever put in a cache but at install", () => {
  assert.equal(source.match(/\.put\(/g).length, 1);
  const install = source.slice(source.indexOf('"install"'), source.indexOf('"activate"'));
  assert.match(install, /\.put\(/);
});

test("the markup file opened as a page goes to the hub, which sends the person to the page", async () => {
  const w = worker();
  await w.install();
  await w.activate();
  assert.equal((await w.fetch("/index.html", { mode: "navigate" })).passed, true);
});

test("a new deployment: the page comes from the new version at once, and an open tab can still load its old parts", async () => {
  const caches = new Map();
  const v1 = worker({ caches });
  await v1.install();
  await v1.activate();
  const v2 = worker({ version: "v2", caches, files: [{ url: "/", integrity: "sha256-x" }, { url: "/index.html", integrity: "sha256-y" }, { url: "/app-BBBBBBBB.js", integrity: "sha256-z" }] });
  await v2.install();
  await v2.activate();
  assert.equal(v2.log.claimed, 1);
  assert.equal((await v2.fetch("/")).response.body, "network /");
  assert.equal(caches.get("omni-shell-v2").get("/").body, "network /");
  assert.equal((await v2.fetch("/app-AAAAAAAA.js")).passed, false, "the open tab's lazy part");
  assert.equal(caches.has("omni-shell-v1"), true);

  const v3 = worker({ version: "v3", caches, files: [{ url: "/", integrity: "sha256-q" }] });
  await v3.install();
  await v3.activate();
  assert.deepEqual([...caches.keys()], ["omni-shell-v2", "omni-shell-v3"], "one version back is kept, no more");
});

test("a worker put there by a hacked hub leaves nothing behind once a clean one takes over", async () => {
  const caches = new Map([["evil", new Map([["/", { body: "changed page" }]])], ["omni-shell-evil", new Map([["/", { body: "changed page" }]])]]);
  const w = worker({ caches });
  await w.install();
  await w.activate();
  assert.equal(caches.has("evil"), false, "a cache not of this worker's naming goes");
  assert.notEqual((await w.fetch("/")).response.body, "changed page", "the page comes only from this version's own cache");
});

test("a hashed file it has lost goes to the network rather than failing", async () => {
  const w = worker();
  await w.install();
  await w.activate();
  const r = await w.fetch("/chunk-CCCCCCCC.js");
  assert.equal(r.passed, false);
  assert.equal(r.response.body, "network /chunk-CCCCCCCC.js");
});

test("the built worker carries the build's whole list, each with its hash, and a version that changes with any of it", () => {
  const build = readBuild();
  assert.doesNotMatch(built, /__PRECACHE__|__VERSION__/);
  for (const [name, file] of Object.entries(build.files)) {
    if (name === "sw.js" || name === "phone.html") continue; // the iPhone app's page is in the app, never at the hub
    const url = name === "web.html" ? "/" : `/${name}`;
    assert.ok(built.includes(`"${url}"`) || built.includes(`url:"${url}"`), `${url} is not precached`);
    assert.ok(built.includes(file.integrity), `${url} has no hash`);
  }
  assert.ok(built.includes(build.version), "the version is the build's");
});

test("the built worker runs", async () => {
  const build = readBuild();
  const w = worker({ script: built });
  await w.install();
  await w.activate();
  assert.ok(w.caches.has(`omni-shell-${build.version}`));
  assert.equal((await w.fetch("/api/health")).passed, true);
  assert.equal((await w.fetch("/")).passed, false);
});
