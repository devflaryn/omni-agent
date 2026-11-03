// What the hub serves for the web page: an exact list, under the page's policy.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHub } from "../hub/server.mjs";
import { WEB_FILES, webPolicy } from "../hub/static.mjs";

const base = mkdtempSync(join(tmpdir(), "omni-static-"));
const cleanups = [];
after(async () => { for (const c of cleanups.reverse()) await c(); rmSync(base, { recursive: true, force: true }); });
const uiSource = (f) => readFileSync(new URL(`../ui/${f}`, import.meta.url), "utf8");

async function plainHub(options = {}) {
  const hub = await startHub({ dataDir: mkdtempSync(join(base, "hub-")), origin: "https://tomcamp.tech", log: () => {}, ...options });
  cleanups.push(() => hub.close());
  return { hub, at: `http://127.0.0.1:${hub.port}` };
}
/** A raw request, for paths fetch would tidy up first. */
const rawGet = (port, path, { method = "GET", headers = {} } = {}) => new Promise((resolve, reject) => {
  const r = httpRequest({ port, host: "127.0.0.1", path, method, headers }, (res) => {
    const parts = [];
    res.on("data", (c) => parts.push(c));
    res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }));
  });
  r.on("error", reject);
  r.end();
});

const POLICY_HEADERS = ["content-security-policy", "x-frame-options", "referrer-policy", "cross-origin-opener-policy", "x-content-type-options"];

test("every answer the hub gives carries the page's headers: a 404, an error and the API too", async () => {
  const { hub } = await plainHub();
  const answers = {
    "a 404": await rawGet(hub.port, "/no-such-file"),
    "a wrong method": await rawGet(hub.port, "/app.js", { method: "POST" }),
    "the API": await rawGet(hub.port, "/api/health"),
    "a refused origin": await rawGet(hub.port, "/app.js", { headers: { origin: "https://evil.example" } }),
  };
  for (const [what, r] of Object.entries(answers)) {
    for (const name of POLICY_HEADERS) assert.ok(r.headers[name], `${what}: ${name}`);
    assert.match(r.headers["content-type"], /^application\/json/, what);
    assert.match(r.headers["content-security-policy"], /frame-ancestors 'none'/, what);
    assert.equal(r.headers["strict-transport-security"], undefined, what);
  }
});

test("the policy is the one asked for: nothing inline, blob only for images and media, no framing, no base, no forms", async () => {
  const { hub } = await plainHub();
  const page_ = await rawGet(hub.port, "/");
  assert.equal(page_.status, 200);
  assert.match(page_.headers["content-type"], /^text\/html/);
  assert.equal(page_.body.toString(), uiSource("web.html"));
  const csp = Object.fromEntries(page_.headers["content-security-policy"].split("; ").map((d) => { const [k, ...v] = d.split(" "); return [k, v.join(" ")]; }));
  assert.deepEqual(csp, {
    "default-src": "'none'", "script-src": "'self'", "worker-src": "'self'", "style-src": "'self'", "img-src": "'self' blob: data:", "media-src": "'self' blob:",
    "connect-src": "'self' wss://tomcamp.tech", "frame-ancestors": "'none'", "base-uri": "'none'", "form-action": "'none'",
  });
  assert.doesNotMatch(page_.headers["content-security-policy"], /unsafe/);
  assert.equal(page_.headers["x-content-type-options"], "nosniff");
  assert.equal(page_.headers["x-frame-options"], "DENY");
  assert.equal(page_.headers["referrer-policy"], "no-referrer");
  assert.equal(page_.headers["cross-origin-opener-policy"], "same-origin");
  assert.equal(page_.headers["strict-transport-security"], undefined, "HSTS stays off: it would cover the sites on other ports of this name");
  const script = await rawGet(hub.port, "/web.js");
  assert.match(script.headers["content-type"], /^text\/javascript/);
  assert.ok(script.headers["content-security-policy"], "every file has the policy, not only the page");
  assert.equal((await rawGet(hub.port, "/logo.svg")).headers["content-type"], "image/svg+xml");
  assert.equal(webPolicy(null).includes("wss:"), false);
  assert.match(webPolicy("https://127.0.0.1:4443"), /connect-src 'self' wss:\/\/127\.0\.0\.1:4443/);
});

test("only the exact list is served: no walk, no source of the hub, no other page", async () => {
  const { hub } = await plainHub();
  for (const path of ["/ui/app.js", "/../package.json", "/..%2fpackage.json", "/%2e%2e/hub/server.mjs", "/hub/server.mjs", "/server.mjs", "/login.html", "/web.html", "/app.js/", "//app.js", "/app.js/../../hub/store.mjs", "/.git/config", "/package.json", "/APP.JS", "/ui/", "/test.js"]) {
    const r = await rawGet(hub.port, path);
    assert.equal(r.status, 404, path);
    assert.doesNotMatch(r.body.toString(), /import |<html/i, path);
  }
  assert.equal((await rawGet(hub.port, "/app.js", { method: "POST" })).status, 404);
  assert.equal((await rawGet(hub.port, "/app.js", { method: "DELETE" })).status, 404);
  assert.equal((await rawGet(hub.port, "/app.js?x=1")).status, 200);
  const head = await rawGet(hub.port, "/app.js", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
  const again = await rawGet(hub.port, "/app.js", { headers: { "if-none-match": head.headers.etag } });
  assert.equal(again.status, 304);
  assert.ok(again.headers["content-security-policy"]);
  assert.equal((await rawGet(hub.port, "/api/health")).status, 200, "the API is still there");
});

test("the app's markup is fetched, not visited", async () => {
  const { hub } = await plainHub();
  assert.equal((await rawGet(hub.port, "/index.html", { headers: { "sec-fetch-dest": "empty" } })).status, 200);
  const visit = await rawGet(hub.port, "/index.html", { headers: { "sec-fetch-dest": "document" } });
  assert.equal(visit.status, 303);
  assert.equal(visit.headers.location, "/");
});

test("a page from a foreign origin gets none of it", async () => {
  const { hub } = await plainHub();
  assert.equal((await rawGet(hub.port, "/app.js", { headers: { origin: "https://evil.example" } })).status, 403);
});

test("the list is complete, and deploy carries exactly it", () => {
  const seen = new Set();
  const walk = (name) => {
    if (seen.has(name)) return;
    seen.add(name);
    const src = uiSource(name);
    for (const m of src.matchAll(/(?:from |import\(|new URL\()"\.\/([\w.-]+\.js)"/g)) walk(m[1]);
  };
  walk("web.js");
  walk("login-worker.js");
  for (const name of seen) assert.ok(WEB_FILES.includes(name), `${name} is loaded and not on the list`);
  for (const m of `${uiSource("web.html")}${uiSource("index.html")}`.matchAll(/(?:href|src)="\/?([\w.-]+\.(?:css|js|svg|png))"/g)) assert.ok(WEB_FILES.includes(m[1]), m[1]);
  assert.ok(!WEB_FILES.includes("login.html"), "the old sign-in page is not the hub's");
  const deploy = readFileSync(new URL("../hub/deploy.sh", import.meta.url), "utf8");
  const listed = /^FILES=\(([\s\S]*?)^\)/m.exec(deploy)[1].split(/\s+/).filter(Boolean);
  assert.deepEqual(listed.filter((f) => f.startsWith("ui/")).map((f) => f.slice(3)).sort(), [...WEB_FILES].sort());
  for (const f of ["hub/server.mjs", "hub/ws.mjs", "hub/store.mjs", "hub/static.mjs", "hub/omni-hub.service"]) assert.ok(listed.includes(f), f);
  assert.doesNotMatch(deploy.replace(/^#.*$/gm, ""), /\bcp -r|\brsync\b|ui\/\*/, "no folder is copied whole");
  assert.doesNotMatch(readFileSync(new URL("../hub/omni-hub.service", import.meta.url), "utf8"), /^Environment=.*OMNI_HUB_HSTS_MAX_AGE/m, "HSTS stays off");
});
