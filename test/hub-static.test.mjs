// What the hub serves for the web page: an exact list, under the page's policy.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { startHub } from "../hub/server.mjs";
import { loadWebFiles, readBuild, webFileList, webPolicy } from "../hub/static.mjs";

const base = mkdtempSync(join(tmpdir(), "omni-static-"));
const cleanups = [];
after(async () => { for (const c of cleanups.reverse()) await c(); rmSync(base, { recursive: true, force: true }); });
const built = (f) => readFileSync(new URL(`../dist/ui/${f}`, import.meta.url));
const WEB_FILES = webFileList();
/** A file of the build, by the source's name: the hash in its name changes with every build. */
const named = (stem, ext = "js") => { const hit = WEB_FILES.find((n) => n.startsWith(`${stem}-`) && n.endsWith(`.${ext}`)); assert.ok(hit, `${stem}.${ext} is not in the build`); return hit; };
const APP = `/${named("app")}`;

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
    "a wrong method": await rawGet(hub.port, APP, { method: "POST" }),
    "the API": await rawGet(hub.port, "/api/health"),
    "a refused origin": await rawGet(hub.port, APP, { headers: { origin: "https://evil.example" } }),
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
  assert.deepEqual(page_.body, built("web.html"));
  const csp = Object.fromEntries(page_.headers["content-security-policy"].split("; ").map((d) => { const [k, ...v] = d.split(" "); return [k, v.join(" ")]; }));
  assert.deepEqual(csp, {
    "default-src": "'none'", "script-src": "'self'", "worker-src": "'self'", "style-src": "'self'", "img-src": "'self' blob: data:", "media-src": "'self' blob:", "manifest-src": "'self'",
    "connect-src": "'self' wss://tomcamp.tech", "frame-ancestors": "'none'", "base-uri": "'none'", "form-action": "'none'",
  });
  assert.doesNotMatch(page_.headers["content-security-policy"], /unsafe/);
  assert.equal(page_.headers["x-content-type-options"], "nosniff");
  assert.equal(page_.headers["x-frame-options"], "DENY");
  assert.equal(page_.headers["referrer-policy"], "no-referrer");
  assert.equal(page_.headers["cross-origin-opener-policy"], "same-origin");
  assert.equal(page_.headers["strict-transport-security"], undefined, "HSTS stays off: it would cover the sites on other ports of this name");
  const script = await rawGet(hub.port, `/${named("web")}`);
  assert.match(script.headers["content-type"], /^text\/javascript/);
  assert.ok(script.headers["content-security-policy"], "every file has the policy, not only the page");
  assert.equal((await rawGet(hub.port, `/${named("logo", "svg")}`)).headers["content-type"], "image/svg+xml");
  assert.equal(webPolicy(null).includes("wss:"), false);
  assert.match(webPolicy("https://127.0.0.1:4443"), /connect-src 'self' wss:\/\/127\.0\.0\.1:4443/);
});

test("only the exact list is served: no walk, no source of the hub, no other page", async () => {
  const { hub } = await plainHub();
  for (const path of ["/ui/app.js", "/app.js", "/web.js", "/styles.css", "/lib.js", "/account-core.js", "/../package.json", "/..%2fpackage.json", "/%2e%2e/hub/server.mjs", "/hub/server.mjs", "/server.mjs", "/login.html", "/web.html", "/build.json", "/dist/ui/build.json", "/dist/ui/web.html", `${APP}.br`, `${APP}.gz`, `${APP}/`, `/${APP}`, `${APP}/../../hub/store.mjs`, "/.git/config", "/package.json", APP.toUpperCase(), "/ui/", "/test.js"]) {
    const r = await rawGet(hub.port, path);
    assert.equal(r.status, 404, path);
    assert.doesNotMatch(r.body.toString(), /import |<html/i, path);
  }
  assert.equal((await rawGet(hub.port, APP, { method: "POST" })).status, 404);
  assert.equal((await rawGet(hub.port, APP, { method: "DELETE" })).status, 404);
  assert.equal((await rawGet(hub.port, `${APP}?x=1`)).status, 200);
  const head = await rawGet(hub.port, APP, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
  const again = await rawGet(hub.port, APP, { headers: { "if-none-match": head.headers.etag } });
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
  assert.equal((await rawGet(hub.port, APP, { headers: { origin: "https://evil.example" } })).status, 403);
});

test("the list is complete, and deploy carries exactly it", () => {
  // Everything a page or a module names is on the list: the check that a browser can load it, on the files a browser gets.
  const seen = new Set();
  const walk = (name) => {
    if (seen.has(name)) return;
    seen.add(name);
    for (const m of built(name).toString().matchAll(/(?:from\s*|import\(|new URL\()"\.\/([\w.-]+\.js)"/g)) walk(m[1]);
  };
  for (const page of ["web.html", "index.html"]) {
    for (const m of built(page).toString().matchAll(/(?:href|src)="\/?([\w.-]+\.(?:css|js|svg|png))"/g)) {
      assert.ok(WEB_FILES.includes(m[1]), m[1]);
      if (m[1].endsWith(".js")) walk(m[1]);
    }
  }
  for (const name of seen) assert.ok(WEB_FILES.includes(name), `${name} is loaded and not on the list`);
  assert.ok([...seen].some((n) => n.startsWith("login-worker-")), "the sign-in's worker is reached");
  assert.ok(!WEB_FILES.includes("login.html"), "the old sign-in page is not the hub's");
  assert.ok(!WEB_FILES.includes("build.json"), "the list itself is not served");
  const deploy = readFileSync(new URL("../hub/deploy.sh", import.meta.url), "utf8");
  const listed = /^FILES=\(([\s\S]*?)^\)/m.exec(deploy)[1].split(/\s+/).filter(Boolean);
  for (const f of ["hub/server.mjs", "hub/ws.mjs", "hub/store.mjs", "hub/static.mjs", "hub/omni-hub.service"]) assert.ok(listed.includes(f), f);
  assert.match(deploy, /scripts\/build-ui\.mjs --check/, "a stale build does not go out");
  assert.match(deploy, /scripts\/build-ui\.mjs --list/, "the page's list is the build's");
  assert.doesNotMatch(deploy.replace(/^#.*$/gm, ""), /\bcp -r|\brsync\b|ui\/\*|dist\/\*/, "no folder is copied whole");
  assert.doesNotMatch(readFileSync(new URL("../hub/omni-hub.service", import.meta.url), "utf8"), /^Environment=.*OMNI_HUB_HSTS_MAX_AGE/m, "HSTS stays off");
});

const GIT_BASH = ["C:/Program Files/Git/bin/bash.exe", "C:/Program Files (x86)/Git/bin/bash.exe"].find((p) => existsSync(p)) ?? (process.platform === "win32" ? null : "bash");

test("what deploy lays out runs: a hub from exactly those files serves the page, with nothing else of the repository in it", { skip: !GIT_BASH && "no bash" }, async () => {
  const stage = mkdtempSync(join(base, "stage-"));
  const r = spawnSync(GIT_BASH, ["hub/deploy.sh"], { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8", env: { ...process.env, OMNI_DEPLOY_STAGE: stage } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  // Every file there is on a list, and no source of the UI but what the hub's own code imports.
  assert.deepEqual(readdirSync(join(stage, "ui")).sort(), ["account-core.js", "device-log.js"]);
  assert.deepEqual(readdirSync(join(stage, "dist", "ui")).filter((n) => !/\.(br|gz)$/.test(n)).sort(), [...WEB_FILES, "build.json"].sort());
  for (const name of WEB_FILES) assert.deepEqual(readFileSync(join(stage, "dist", "ui", name)), built(name), `${name} is carried byte for byte`);
  assert.ok(!readFileSync(join(stage, "hub", "server.mjs")).includes(13), "source has its carriage returns taken out");

  const { startHub: stagedHub } = await import(pathToFileURL(join(stage, "hub", "server.mjs")).href);
  const hub = await stagedHub({ dataDir: mkdtempSync(join(base, "hub-")), origin: "https://tomcamp.tech", log: () => {} });
  cleanups.push(() => hub.close());
  const page_ = await rawGet(hub.port, "/");
  assert.equal(page_.status, 200);
  assert.deepEqual(page_.body, built("web.html"));
  assert.equal((await rawGet(hub.port, APP)).status, 200);
  assert.equal((await rawGet(hub.port, "/sw.js")).status, 200);
});

// ------------------------------------------------------------------------- how files go out

test("a file with its hash in its name is cached for good, and the pages and the worker are always checked", async () => {
  const { hub } = await plainHub();
  assert.match((await rawGet(hub.port, APP)).headers["cache-control"], /max-age=31536000.*immutable/);
  assert.match((await rawGet(hub.port, `/${named("styles", "css")}`)).headers["cache-control"], /immutable/);
  assert.match((await rawGet(hub.port, `/${named("logo", "svg")}`)).headers["cache-control"], /immutable/);
  for (const path of ["/", "/index.html", "/sw.js"]) {
    const r = await rawGet(hub.port, path);
    assert.equal(r.status, 200, path);
    assert.equal(r.headers["cache-control"], "no-cache", path);
    assert.ok(r.headers.etag, path);
  }
});

test("the smallest form the browser takes goes out, compressed ahead of time, by what it says it takes", async () => {
  const { hub } = await plainHub();
  const body = built(APP.slice(1));
  const br = await rawGet(hub.port, APP, { headers: { "accept-encoding": "gzip, deflate, br" } });
  assert.equal(br.headers["content-encoding"], "br");
  assert.equal(br.headers.vary, "Accept-Encoding");
  assert.equal(Number(br.headers["content-length"]), br.body.length);
  assert.ok(br.body.length < body.length / 2);
  assert.deepEqual(brotliDecompressSync(br.body), body);
  const gz = await rawGet(hub.port, APP, { headers: { "accept-encoding": "gzip" } });
  assert.equal(gz.headers["content-encoding"], "gzip");
  assert.deepEqual(gunzipSync(gz.body), body);
  const plain = await rawGet(hub.port, APP);
  assert.equal(plain.headers["content-encoding"], undefined);
  assert.equal(plain.headers.vary, "Accept-Encoding");
  assert.deepEqual(plain.body, body);
  assert.equal((await rawGet(hub.port, APP, { headers: { "accept-encoding": "br;q=0, gzip;q=1.0" } })).headers["content-encoding"], "gzip");
  assert.equal((await rawGet(hub.port, APP, { headers: { "accept-encoding": "gzip;q=0" } })).headers["content-encoding"], undefined);
  assert.equal((await rawGet(hub.port, `/${named("icon-32", "png")}`, { headers: { "accept-encoding": "br" } })).headers["content-encoding"], undefined, "an image is not compressed twice");
  // Each form has its own tag, so a cache cannot hand one form to a browser that asked for another.
  const tags = new Set([br.headers.etag, gz.headers.etag, plain.headers.etag]);
  assert.equal(tags.size, 3);
  assert.equal((await rawGet(hub.port, APP, { headers: { "accept-encoding": "br", "if-none-match": br.headers.etag } })).status, 304);
  assert.equal((await rawGet(hub.port, APP, { headers: { "accept-encoding": "br", "if-none-match": `W/${br.headers.etag}` } })).status, 304, "a proxy may weaken a tag");
  assert.equal((await rawGet(hub.port, APP, { headers: { "accept-encoding": "gzip", "if-none-match": br.headers.etag } })).status, 200);
  assert.ok(br.headers["content-security-policy"], "and every form has the policy");
});

test("a build that was altered stops the hub at its start, rather than serving it", () => {
  const dir = mkdtempSync(join(base, "dist-"));
  const build = readBuild();
  for (const name of Object.keys(build.files)) writeFileSync(join(dir, name), built(name));
  writeFileSync(join(dir, "build.json"), JSON.stringify({ ...build, files: Object.fromEntries(Object.entries(build.files).map(([n, f]) => [n, { ...f, br: false, gz: false }])) }));
  const at = pathToFileURL(`${dir}/`);
  assert.ok(loadWebFiles(at).size > 0, "as built");
  writeFileSync(join(dir, APP.slice(1)), "// changed\n");
  assert.throws(() => loadWebFiles(at), /is not the file that was built/);
  rmSync(join(dir, APP.slice(1)));
  assert.throws(() => loadWebFiles(at));
});

test("the service worker is served by its own name; any other worker a browser checks is told to remove itself", async () => {
  const { hub } = await plainHub();
  const ours = await rawGet(hub.port, "/sw.js", { headers: { "service-worker": "script" } });
  assert.equal(ours.status, 200);
  assert.deepEqual(ours.body, built("sw.js"));
  for (const planted of ["/evil-worker.js", "/sw2.js", "/", APP]) {
    const r = await rawGet(hub.port, planted, { headers: { "service-worker": "script" } });
    assert.equal(r.status, 200, planted);
    assert.match(r.headers["content-type"], /^text\/javascript/, planted);
    assert.match(r.body.toString(), /registration\.unregister\(\)/, planted);
    assert.equal(r.headers["cache-control"], "no-store", planted);
    assert.ok(r.headers["content-security-policy"], planted);
  }
  assert.equal((await rawGet(hub.port, "/evil-worker.js")).status, 404, "without the browser's own header it is any other path");
});
