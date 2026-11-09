// The built UI: one output for the desktop server, the hub and the iPhone bundle, and never a stale one served without a word.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createApp } from "../server/index.mjs";
import { openUiBuild, checkBuild } from "../server/ui-build.mjs";
import { readBuild, webFileList } from "../hub/static.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(ROOT, "dist", "ui");
const base = mkdtempSync(join(tmpdir(), "omni-uibuild-"));
const cleanups = [];
after(async () => { for (const c of cleanups.reverse()) await c(); rmSync(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); });

const build = readBuild();
const names = Object.keys(build.files);
const sha = (b) => createHash("sha256").update(b).digest("hex");

test("the committed build is what the sources make: after any change to ui/, run npm run build", () => {
  const problem = checkBuild(ROOT);
  assert.equal(problem, null, `${problem}. Run: npm run build, and commit dist/ui`);
});

test("the folder holds exactly the list, and every file is the one the list says", () => {
  const expected = new Set(["build.json"]);
  for (const name of names) {
    const file = build.files[name];
    const body = readFileSync(join(DIST, name));
    assert.equal(sha(body), file.sha256, name);
    expected.add(name);
    if (file.br) { expected.add(`${name}.br`); assert.deepEqual(brotliDecompressSync(readFileSync(join(DIST, `${name}.br`))), body, `${name}.br`); }
    if (file.gz) { expected.add(`${name}.gz`); assert.deepEqual(gunzipSync(readFileSync(join(DIST, `${name}.gz`))), body, `${name}.gz`); }
  }
  assert.deepEqual(readdirSync(DIST).sort(), [...expected].sort(), "nothing in the folder is off the list");
});

test("git leaves the built files' bytes alone, on a machine that turns line endings", () => {
  const attrs = readFileSync(join(ROOT, ".gitattributes"), "utf8");
  assert.match(attrs, /^dist\/\*\* -text/m);
  for (const name of names) {
    if (!/\.(html|js|css|svg)$/.test(name)) continue;
    assert.ok(!readFileSync(join(DIST, name)).includes(13), `${name} has a carriage return`);
  }
});

test("everything but the two pages and the service worker has its hash in its name, so it can be cached for good", () => {
  const fixed = names.filter((n) => !build.files[n].immutable).sort();
  assert.deepEqual(fixed, ["index.html", "sw.js", "web.html"]);
  for (const n of names.filter((x) => build.files[x].immutable)) assert.match(n, /^[\w.-]+-[A-Za-z0-9]{8}\.(js|css|svg|png)$/, n);
});

test("what the first screen does not need is not in it: office, editor, highlighter, file pane, Missions", () => {
  const graph = (entry) => {
    const seen = new Set();
    const walk = (name) => { if (seen.has(name)) return; seen.add(name); for (const dep of build.imports[name] ?? []) walk(dep); };
    walk(entry);
    return seen;
  };
  const html = readFileSync(join(DIST, "index.html"), "utf8");
  const entry = /<script type="module" src="\/?([^"]+)"/.exec(html)[1];
  const first = [...graph(entry)];
  assert.ok(first.length <= 6, `the first screen is ${first.length} files`);
  const code = first.map((n) => readFileSync(join(DIST, n), "utf8")).join("\n");
  for (const [what, mark] of [["the office", "OPENCODE"], ["the editor", "detectIndent"], ["the highlighter", "C_LIKE_OPS"], ["the hex viewer", "hexDump"], ["the mission list", "ms-shell"]]) {
    assert.ok(!code.includes(mark), `${what} is in the first screen`);
  }
  const bytes = first.reduce((sum, n) => sum + statSync(join(DIST, `${n}.br`)).size, 0);
  assert.ok(bytes < 90 * 1024, `the first screen's code is ${bytes} bytes on the wire`);
});

test("the sign-in page does not carry the app", () => {
  const html = readFileSync(join(DIST, "web.html"), "utf8");
  const entry = /<script type="module" src="\/?([^"]+)"/.exec(html)[1];
  const preloaded = [...html.matchAll(/rel="modulepreload" href="\/?([^"]+)"/g)].map((m) => m[1]);
  const code = [entry, ...preloaded].map((n) => readFileSync(join(DIST, n), "utf8")).join("\n");
  assert.ok(!code.includes("agentStrip"), "the app's code is in the sign-in page's first load");
  const bytes = [entry, ...preloaded].reduce((sum, n) => sum + statSync(join(DIST, `${n}.br`)).size, 0);
  assert.ok(bytes < 60 * 1024, `the sign-in page's code is ${bytes} bytes on the wire`);
});

test("a page's first modules are named up front, so they do not cost one round trip each", () => {
  for (const page of ["index.html", "web.html"]) {
    const html = readFileSync(join(DIST, page), "utf8");
    const entry = /<script type="module" src="\/?([^"]+)"/.exec(html)[1];
    for (const dep of build.imports[entry] ?? []) assert.match(html, new RegExp(`rel="modulepreload" href="/?${dep.replace(/[.]/g, "\\.")}"`), `${page}: ${dep}`);
  }
});

test("the workers are built, and the code that starts them names the built file", () => {
  const code = names.filter((n) => n.endsWith(".js")).map((n) => readFileSync(join(DIST, n), "utf8")).join("\n");
  for (const worker of ["login-worker", "office-worker"]) {
    const file = names.find((n) => n.startsWith(`${worker}-`));
    assert.ok(file, worker);
    assert.ok(code.includes(`"./${file}"`), `${worker}: nothing starts ${file}`);
  }
  assert.ok(!code.includes('"./login-worker.js"') && !code.includes('"./office-worker.js"'), "a source name is left in the built code");
});

test("nothing built needs what the page's CSP forbids, and no source map or source file is on the list", () => {
  for (const name of names) {
    assert.doesNotMatch(name, /\.map$|\.mjs$/);
    if (name.endsWith(".html")) {
      const html = readFileSync(join(DIST, name), "utf8");
      assert.doesNotMatch(html, /\son[a-z]+\s*=/i, `${name}: inline handler`);
      assert.doesNotMatch(html, /<style\b/i, `${name}: style block`);
      assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/i, `${name}: inline script`);
      assert.doesNotMatch(html, /(src|href)=["'](https?:)?\/\//i, `${name}: remote resource`);
    }
    if (name.endsWith(".js")) {
      const js = readFileSync(join(DIST, name), "utf8");
      assert.doesNotMatch(js, /\bnew Function\(|[^.\w]eval\(/, `${name}: eval`);
      assert.doesNotMatch(js, /sourceMappingURL/, name);
    }
    if (name.endsWith(".css")) assert.doesNotMatch(readFileSync(join(DIST, name), "utf8"), /@import|url\(["']?(https?:)?\/\//, name);
  }
});

test("a file a page refers to is on the list: nothing dangles", () => {
  for (const page of ["index.html", "web.html"]) {
    const html = readFileSync(join(DIST, page), "utf8");
    for (const m of html.matchAll(/(?:href|src)="\/?([^"#?]+\.(?:css|js|svg|png))"/g)) assert.ok(names.includes(m[1]), `${page} → ${m[1]}`);
  }
  for (const name of names.filter((n) => n.endsWith(".js"))) {
    const js = readFileSync(join(DIST, name), "utf8");
    for (const m of js.matchAll(/(?:from\s*|import\(|new URL\()"\.\/([^"]+\.js)"/g)) assert.ok(names.includes(m[1]), `${name} → ${m[1]}`);
  }
});

// ------------------------------------------------------------------------- freshness, in a copy

function checkoutCopy() {
  const dir = mkdtempSync(join(base, "checkout-"));
  cpSync(join(ROOT, "ui"), join(dir, "ui"), { recursive: true });
  cpSync(join(ROOT, "dist"), join(dir, "dist"), { recursive: true });
  mkdirSync(join(dir, "scripts"));
  cpSync(join(ROOT, "scripts", "build-ui.mjs"), join(dir, "scripts", "build-ui.mjs"));
  return dir;
}
const touch = (file, text) => { writeFileSync(file, text); const later = new Date(Date.now() + 5000); utimesSync(file, later, later); };

test("line endings do not make a build stale: a checkout that turned them is the same source", () => {
  const dir = checkoutCopy();
  const file = join(dir, "ui", "lib.js");
  const lf = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  writeFileSync(file, lf.replace(/\n/g, "\r\n"));
  assert.equal(checkBuild(dir), null);
  writeFileSync(file, lf);
  assert.equal(checkBuild(dir), null);
});

test("a changed source, a removed one, a damaged build or no build at all each say so", () => {
  const edited = checkoutCopy();
  writeFileSync(join(edited, "ui", "lib.js"), `${readFileSync(join(edited, "ui", "lib.js"), "utf8")}\n// changed\n`);
  assert.match(checkBuild(edited), /ui\/lib\.js/);

  const removed = checkoutCopy();
  rmSync(join(removed, "ui", "lib.js"));
  assert.match(checkBuild(removed), /ui\/lib\.js/);

  const damaged = checkoutCopy();
  const victim = readBuild(new URL(`file:///${join(damaged, "dist", "ui").replace(/\\/g, "/")}/`));
  const name = Object.keys(victim.files).find((n) => n.endsWith(".js"));
  writeFileSync(join(damaged, "dist", "ui", name), "// not what was built\n");
  assert.match(checkBuild(damaged), new RegExp(name.replace(/[.]/g, "\\.")));

  const none = checkoutCopy();
  rmSync(join(none, "dist"), { recursive: true });
  assert.match(checkBuild(none), /no build/);
});

const app = async (uiRoot, extra = {}) => {
  const dir = mkdtempSync(join(base, "app-"));
  const created = await createApp({ port: 0, relay: { host: "" }, autoStartPi: false, hook: { enabled: false }, persistHook: false, persistPiModel: false, cwd: dir, vaultDir: join(dir, "vault"), piSessionsDir: join(dir, "pi"), claudeProjectsDir: join(dir, "claude"), projectsDir: join(dir, "projects"), tlsDir: join(dir, "tls"), remoteAuthFile: join(dir, "remote.json"), accountDir: join(dir, "account"), uiRoot, log: () => {}, ...extra });
  await created.listen();
  cleanups.push(() => created.close());
  return { app: created, at: `http://127.0.0.1:${created.server.address().port}` };
};

test("the desktop server serves the build when it is fresh: immutable where hashed, revalidated at the page", async () => {
  const { at } = await app(ROOT);
  const page = await fetch(`${at}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("cache-control"), /no-cache/);
  assert.ok(page.headers.get("etag"));
  const html = await page.text();
  const script = /<script type="module" src="\/?([^"]+)"/.exec(html)[1];
  assert.match(script, /^app-[A-Za-z0-9]{8}\.js$/);
  const code = await fetch(`${at}/${script}`, { headers: { "accept-encoding": "br" } });
  assert.equal(code.status, 200);
  assert.match(code.headers.get("cache-control"), /immutable/);
  assert.equal(code.headers.get("content-encoding"), "br");
  await code.text();
  const again = await fetch(`${at}/`, { headers: { "if-none-match": page.headers.get("etag") } });
  assert.equal(again.status, 304);
  // The frame and sniffing rules of everything this server answers stay.
  assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.equal(page.headers.get("x-content-type-options"), "nosniff");
});

test("an edited source is served as it is, at once, while the server runs; the build's own files stay for a page already open", async () => {
  const logged = [];
  const dir = checkoutCopy();
  const { at } = await app(dir, { log: (...a) => logged.push(a.join(" ")) });
  const built = await (await fetch(`${at}/`)).text();
  assert.match(built, /app-[A-Za-z0-9]{8}\.js/, "fresh at the start");
  const hashed = /src="\/?(app-[A-Za-z0-9]{8}\.js)"/.exec(built)[1];

  const file = join(dir, "ui", "index.html");
  touch(file, readFileSync(file, "utf8").replace("</body>", "<!-- edited --></body>"));
  const page = await fetch(`${at}/`);
  const text = await page.text();
  assert.match(text, /<!-- edited -->/, "the edit is what is served");
  assert.match(text, /src="\/app\.js"/, "from source");
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.equal(page.headers.get("x-omni-ui"), "source");
  assert.ok(logged.some((l) => /serving the UI from source/i.test(l) && /ui\/index\.html/.test(l)), "and the log says why");
  assert.equal((await fetch(`${at}/app.js`)).status, 200);
  assert.equal((await fetch(`${at}/${hashed}`)).status, 200, "a page already open can still load its lazy parts");
});

test("with no build at all the server runs from source, as a plain checkout from before did", async () => {
  const dir = checkoutCopy();
  rmSync(join(dir, "dist"), { recursive: true });
  const { at } = await app(dir);
  const page = await fetch(`${at}/`);
  assert.match(await page.text(), /src="\/app\.js"/);
  assert.equal(page.headers.get("x-omni-ui"), "source");
  assert.equal((await fetch(`${at}/lib.js`)).status, 200);
  assert.equal((await fetch(`${at}/no-such-file.js`)).status, 404);
});

test("a developer can ask for source with the build fresh", async () => {
  const { at } = await app(ROOT, { uiFromSource: true });
  assert.match(await (await fetch(`${at}/`)).text(), /src="\/app\.js"/);
});

test("the service worker and the hub's page are not the desktop server's to serve", async () => {
  const { at } = await app(ROOT);
  assert.equal((await fetch(`${at}/sw.js`)).status, 404);
  assert.equal((await fetch(`${at}/web.html`)).status, 404);
  assert.equal((await fetch(`${at}/build.json`)).status, 404);
});

test("openUiBuild looks at the disk only when a file really changed", () => {
  const dir = checkoutCopy();
  const ui = openUiBuild({ root: dir, log: () => {} });
  const first = ui.current();
  assert.ok(first?.files.size > 0);
  assert.equal(ui.current(), first, "the same object while nothing changed");
  const file = join(dir, "ui", "lib.js");
  touch(file, `${readFileSync(file, "utf8")}\n`);
  assert.equal(ui.current(), null);
  assert.match(ui.reason(), /ui\/lib\.js/);
});

test("a developer's checkout rebuilds a stale UI by itself, once at a time, and a failed build waits for the next change", async () => {
  const dir = checkoutCopy();
  mkdirSync(join(dir, "node_modules", "esbuild"), { recursive: true });
  const logged = [];
  let builds = 0, fail = true;
  const runBuild = async () => { builds++; if (fail) throw new Error("ui/app.js:1: broken"); };
  const ui = openUiBuild({ root: dir, log: (l) => logged.push(l), autoBuild: true, runBuild });
  assert.ok(ui.current(), "fresh: nothing to do");
  assert.equal(builds, 0);
  const file = join(dir, "ui", "lib.js");
  touch(file, `${readFileSync(file, "utf8")}\n// edit\n`);
  assert.equal(ui.current(), null, "source while it builds");
  await ui.building;
  assert.equal(builds, 1);
  assert.ok(logged.some((l) => /build failed.*broken/.test(l)));
  ui.current();
  await ui.building;
  assert.equal(builds, 1, "not again for the same sources");
  fail = false;
  touch(file, `${readFileSync(file, "utf8")}\n// another\n`);
  ui.current();
  await ui.building;
  assert.equal(builds, 2);

  const plain = checkoutCopy(); // no node_modules: never built
  let none = 0;
  const off = openUiBuild({ root: plain, autoBuild: true, runBuild: async () => { none++; } });
  touch(join(plain, "ui", "lib.js"), "// changed\n");
  assert.equal(off.current(), null);
  assert.equal(none, 0);
});

test("the build script's check and list work with no node_modules, as on a plain checkout", () => {
  const dir = checkoutCopy();
  const run = (...args) => spawnSync(process.execPath, [join(dir, "scripts", "build-ui.mjs"), ...args], { encoding: "utf8", cwd: dir });
  const noModules = join(dir, "server");
  mkdirSync(noModules);
  cpSync(join(ROOT, "server", "ui-build.mjs"), join(noModules, "ui-build.mjs"));
  mkdirSync(join(dir, "hub"));
  cpSync(join(ROOT, "hub", "static.mjs"), join(dir, "hub", "static.mjs"));
  writeFileSync(join(dir, "package.json"), '{ "type": "module" }\n');
  const check = run("--check");
  assert.equal(check.status, 0, check.stdout + check.stderr);
  const list = run("--list");
  assert.equal(list.status, 0, list.stderr);
  const listed = list.stdout.trim().split(/\r?\n/);
  for (const n of webFileList()) assert.ok(listed.includes(`dist/ui/${n}`), n);
  assert.ok(listed.includes("dist/ui/build.json"));
  for (const f of listed) assert.ok(existsSync(join(dir, f)), f);
  writeFileSync(join(dir, "ui", "lib.js"), "// changed\n");
  const stale = run("--check");
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /ui\/lib\.js/);
});
