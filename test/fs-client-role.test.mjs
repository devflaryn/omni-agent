// A `client` device (the web page) over a channel and Omni's own files: the next start would run them as the host.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { channelClient, serveChannel } from "../server/channel-host.mjs";
import { createApp } from "../server/index.mjs";

function pipePair() {
  class End extends EventEmitter {
    closed = false; #onFrame = null; #backlog = [];
    constructor(peer) { super(); this.peer = peer; }
    onFrame(cb) { this.#onFrame = cb; for (const f of this.#backlog.splice(0)) cb(f); }
    deliver(f) { if (this.closed) return; if (this.#onFrame) this.#onFrame(f); else this.#backlog.push(f); }
    async sendFrame(f) { if (this.closed) throw new Error("channel closed"); const bytes = Uint8Array.from(f); setImmediate(() => this.other.deliver(bytes)); }
    close(reason = "closed") { if (this.closed) return; this.closed = true; this.emit("close", reason); if (!this.other.closed) this.other.close(reason); }
  }
  const a = new End({ id: "peer-b", name: "b" }), b = new End({ id: "peer-a", name: "a", role: "full" });
  a.other = b; b.other = a;
  return [a, b];
}

const base = mkdtempSync(join(tmpdir(), "omni-client-role-"));
const holder = join(base, "holder"), appDir = join(holder, "omni-app"), cfgFile = join(appDir, "omni.config.json"), code = join(appDir, "server", "account.mjs");
const sibling = join(holder, "omni-app-other"), work = join(base, "work");
for (const d of [join(appDir, "server"), sibling, work, join(base, "account")]) mkdirSync(d, { recursive: true });
const ORIGINAL = "// the app's code\n";
writeFileSync(code, ORIGINAL);
writeFileSync(cfgFile, "{}\n");
writeFileSync(join(sibling, "keep.txt"), "x");
writeFileSync(join(work, "note.txt"), "n");
const hasLinks = (() => { try { symlinkSync(appDir, join(work, "applink"), "junction"); return true; } catch { return false; } })();

const options = { port: 0, relay: { host: "" }, vaultDir: join(base, "vault"), piSessionsDir: join(base, "pi"), claudeProjectsDir: join(base, "claude"), autoStartPi: false, cwd: work, liveWindowMs: 0, persistHook: false, persistPiModel: false, hook: { enabled: false }, accountDir: join(base, "account"), fsTrash: async (abs) => rmSync(abs, { recursive: true, force: true }) };
const app = await createApp({ ...options, appFiles: [appDir, cfgFile] });
await app.listen();
after(async () => { await app.close(); try { rmSync(base, { recursive: true, force: true }); } catch { /* */ } });

const device = (role, target = app) => {
  const [client, host] = pipePair();
  serveChannel(host, target.handleChannelRequest, { device: { id: `dev-${role}`, name: role, role }, audit: () => {} });
  return channelClient(client);
};
const post = async (http, route, body) => { const r = await http.request({ method: "POST", path: route, body: Buffer.from(JSON.stringify(body)) }); return { status: r.status, text: await r.text() }; };
const intact = (what) => {
  assert.equal(readFileSync(code, "utf8"), ORIGINAL, what);
  assert.equal(readFileSync(cfgFile, "utf8"), "{}\n", what);
  assert.deepEqual(readdirSync(appDir).sort(), ["omni.config.json", "server"], what);
  assert.deepEqual(readdirSync(join(appDir, "server")), ["account.mjs"], what);
};

// Everything the account guard's tests try, against the install folder.
const spellings = () => {
  const out = [
    ["plain", { root: appDir, path: "server/account.mjs" }],
    ["through the parent", { root: holder, path: "omni-app/server/account.mjs" }],
    ["with dots", { root: work, path: "../holder/omni-app/server/account.mjs" }],
    ["dots in the root", { root: join(work, "..", "holder", "omni-app"), path: "server/account.mjs" }],
    ["backslashes and dots", { root: work, path: "..\\holder\\omni-app\\server\\account.mjs" }],
    ["a leading slash", { root: appDir, path: "/server/account.mjs" }],
    ["two leading slashes", { root: appDir, path: "//server/account.mjs" }],
    ["a leading backslash", { root: appDir, path: "\\server\\account.mjs" }],
    ["a parent, by slash", { root: holder, path: "/omni-app/server/account.mjs" }],
    ["the config file", { root: appDir, path: "omni.config.json" }],
    ["the config file, by slash", { root: appDir, path: "/omni.config.json" }],
    ["a new file in it", { root: appDir, path: "server/planted.mjs" }],
    ["an array path", { root: appDir, path: ["server/account.mjs"] }],
    ["an array path by the parent", { root: holder, path: ["omni-app/server/account.mjs"] }],
  ];
  if (process.platform === "win32") {
    out.push(
      ["upper case", { root: appDir.toUpperCase(), path: "SERVER/ACCOUNT.MJS" }],
      ["trailing dot", { root: `${appDir}.`, path: "server/account.mjs" }],
      ["trailing space and dot in the path", { root: holder, path: "omni-app. /server/account.mjs" }],
      ["a stream", { root: appDir, path: "server/account.mjs::$DATA" }],
      ["a folder stream", { root: `${appDir}::$INDEX_ALLOCATION`, path: "server/account.mjs" }],
      ["device path", { root: `\\\\?\\${appDir}`, path: "server/account.mjs" }],
      ["dot device path", { root: `\\\\.\\${appDir}`, path: "server/account.mjs" }],
      ["forward-slash device path", { root: `//?/${appDir}`, path: "server/account.mjs" }],
      ["loopback share", { root: `\\\\localhost\\${appDir[0]}$${appDir.slice(2)}`, path: "server/account.mjs" }],
      ["loopback address share", { root: `\\\\127.0.0.1\\${appDir[0]}$${appDir.slice(2)}`, path: "server/account.mjs" }],
    );
  }
  if (hasLinks) out.push(["a link as root", { root: join(work, "applink"), path: "server/account.mjs" }], ["a link in the path", { root: work, path: "applink/server/account.mjs" }], ["a link, by slash", { root: work, path: "/applink/server/account.mjs" }]);
  return out;
};
const CHANGES = [
  ["/api/fs/write", { content: "PLANTED", force: true, create: true }],
  ["/api/fs/create", {}],
  ["/api/fs/duplicate", {}],
  ["/api/fs/delete", { permanent: true }],
  ["/api/fs/delete", {}],
  ["/api/fs/rename", { to: "moved.mjs" }],
];

test("a client device changes nothing of Omni's, by any route and any spelling", async () => {
  const http = device("client");
  for (const [route, extra] of CHANGES) for (const [what, params] of spellings()) {
    const r = await post(http, route, { ...params, ...extra });
    assert.ok(r.status === 403 || r.status === 400, `${route}, ${what}: ${r.status} ${r.text}`);
    intact(`${route}, ${what}`);
  }
});

test("a client device moves nothing into Omni's folder, by any spelling of the target", { skip: !hasLinks }, async () => {
  const http = device("client");
  for (const to of ["applink/planted.mjs", "/applink/planted.mjs", "//applink/planted.mjs", "\\applink\\planted.mjs", "applink/server/account.mjs", "APPLINK/planted.mjs"]) {
    const r = await post(http, "/api/fs/rename", { root: work, path: "note.txt", to });
    assert.equal(r.status, 403, `to ${to}: ${r.text}`);
    intact(`to ${to}`);
    assert.ok(existsSync(join(work, "note.txt")));
  }
  assert.ok([400, 403].includes((await post(http, "/api/fs/rename", { root: work, path: "note.txt", to: ["applink/planted.mjs"] })).status));
  intact("an array target");
});

test("a folder holding Omni's cannot be moved, copied or deleted by a client device", async () => {
  const http = device("client");
  for (const [route, extra] of [["/api/fs/rename", { to: "elsewhere" }], ["/api/fs/duplicate", {}], ["/api/fs/delete", { permanent: true }]]) {
    for (const params of [{ root: base, path: "holder" }, { root: base, path: "/holder" }, { root: holder, path: "omni-app" }]) {
      const r = await post(http, route, { ...params, ...extra });
      assert.equal(r.status, 403, `${route} ${params.path}: ${r.text}`);
      intact(`${route} ${params.path}`);
    }
  }
});

test("a client device still reads Omni's files, and still works everywhere else", async () => {
  const http = device("client");
  const read = await http.request({ method: "GET", path: `/api/fs/read?root=${encodeURIComponent(appDir)}&path=server/account.mjs` });
  assert.equal(read.status, 200);
  assert.match(await read.text(), /the app's code/);
  // A project with a `server` folder of its own, and a folder named like Omni's beside it: not the install folder.
  const project = join(base, "project");
  assert.equal((await post(http, "/api/fs/write", { root: project, path: "server/x.txt", content: "mine", create: true })).status, 200);
  assert.equal(readFileSync(join(project, "server", "x.txt"), "utf8"), "mine");
  assert.equal((await post(http, "/api/fs/write", { root: sibling, path: "keep.txt", content: "changed" })).status, 200, "only that folder, not its siblings");
  assert.equal((await post(http, "/api/fs/duplicate", { root: project, path: "server/x.txt" })).status, 200);
  assert.equal((await post(http, "/api/fs/delete", { root: project, path: "server/x.txt" })).status, 200);
});

test("a full device keeps it, as the design gives", async () => {
  const http = device("full");
  const planted = join(appDir, "server", "by-full.txt");
  assert.equal((await post(http, "/api/fs/write", { root: appDir, path: "server/by-full.txt", content: "ok", create: true })).status, 200);
  assert.equal(readFileSync(planted, "utf8"), "ok");
  assert.equal((await post(http, "/api/fs/delete", { root: appDir, path: "server/by-full.txt", permanent: true })).status, 200);
  assert.equal(existsSync(planted), false);
});

test("the default is the real install folder and config file", async () => {
  const real = await createApp({ ...options, accountDir: join(base, "account-2") });
  await real.listen();
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const http = device("client", real);
  const name = `__client_probe_${process.pid}.txt`;
  try {
    // New names only, and create for the rest, which never replaces: a regression here must not damage the checkout it runs in.
    for (const path of [name, `server/${name}`, `/${name}`]) {
      const r = await post(http, "/api/fs/write", { root: repo, path, content: "PLANTED", create: true });
      assert.equal(r.status, 403, `${path}: ${r.text}`);
    }
    for (const path of ["omni.config.json", "server/index.mjs"]) assert.equal((await post(http, "/api/fs/create", { root: repo, path })).status, 403, path);
    assert.equal(existsSync(join(repo, name)), false);
  } finally {
    for (const f of [join(repo, name), join(repo, "server", name)]) rmSync(f, { force: true });
    await real.close();
  }
});
