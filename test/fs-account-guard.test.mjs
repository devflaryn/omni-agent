// The account folder against the file routes of server/files.mjs: what the guard reads must be what the route opens.
// files.mjs takes a leading slash as the root, not the disk, and turns what it is given into text.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { channelAllowed } from "../server/access.mjs";
import { createApp } from "../server/index.mjs";

const base = mkdtempSync(join(tmpdir(), "omni-fs-guard-"));
const parent = join(base, "acct"), accountDir = join(parent, "account"), secrets = join(accountDir, "keys.json");
mkdirSync(accountDir, { recursive: true });
writeFileSync(secrets, "SECRET-KEY-BYTES");
// A change under a root that holds the account folder is refused whatever its path says, so a change is tried from
// a folder that does not hold it, through a link: the one way a path that stays inside its root gets there.
const work = join(base, "work");
mkdirSync(work);
const hasLinks = (() => { try { symlinkSync(accountDir, join(work, "keylink"), "junction"); return true; } catch { return false; } })();

const app = await createApp({ port: 0, vaultDir: join(base, "vault"), piSessionsDir: join(base, "pi"), claudeProjectsDir: join(base, "claude"), autoStartPi: false, cwd: base, liveWindowMs: 0, persistHook: false, persistPiModel: false, hook: { enabled: false }, accountDir, fsTrash: async (abs) => rmSync(abs, { recursive: true, force: true }) });
await app.listen();
const at = `http://127.0.0.1:${app.server.address().port}`;
after(async () => { await app.close(); try { rmSync(base, { recursive: true, force: true }); } catch { /* */ } });

const get = async (route, params) => { const r = await fetch(`${at}${route}?${new URLSearchParams(params)}`); return { status: r.status, text: await r.text() }; };
const post = async (route, body) => { const r = await fetch(`${at}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, text: await r.text() }; };
const intact = (what) => {
  assert.equal(readFileSync(secrets, "utf8"), "SECRET-KEY-BYTES", what);
  assert.deepEqual(readdirSync(accountDir), ["keys.json"], what);
};

// Every spelling files.mjs reads as <root>/account/keys.json.
const SPELLINGS = ["account/keys.json", "/account/keys.json", "//account/keys.json", "///account/keys.json", "\\account\\keys.json", "\\\\account\\keys.json", "/\\account/keys.json"];
const READS = [["/api/fs/list", {}], ["/api/fs/read", {}], ["/api/fs/text", {}], ["/api/fs/hex", {}], ["/api/fs/raw", {}], ["/api/fs/raw", { download: "1" }], ["/api/fs/archive-entry", { entry: "x" }]];
const CHANGES = [
  ["/api/fs/write", { content: "PLANTED" }],
  ["/api/fs/write", { content: "PLANTED", force: true, create: true }],
  ["/api/fs/create", {}],
  ["/api/fs/duplicate", {}],
  ["/api/fs/delete", { permanent: true }],
  ["/api/fs/delete", {}],
  ["/api/fs/rename", { to: "moved.txt" }],
  ...(process.env.OMNI_GUARD_NO_REVEAL ? [] : [["/api/fs/reveal", {}]]), // refused before it opens anything
];

test("reading: every file route refuses the account folder, by every spelling of the path", async () => {
  for (const [route, extra] of READS) for (const path of SPELLINGS) {
    const r = await get(route, { root: parent, path, ...extra });
    assert.equal(r.status, 403, `${route} ${path}`);
    assert.ok(!r.text.includes("SECRET-KEY-BYTES"), `${route} ${path}`);
  }
  for (const path of ["/account", "//account", "\\account"]) assert.equal((await get("/api/fs/list", { root: parent, path })).status, 403, `list ${path}`);
});

test("changing: every file route refuses the account folder, by every spelling of the path", async () => {
  for (const [route, extra] of CHANGES) for (const path of SPELLINGS) {
    const r = await post(route, { root: parent, path, ...extra });
    assert.equal(r.status, 403, `${route} ${path}: ${r.text}`);
    intact(`${route} ${path}`);
  }
});

test("changing and reading through a link in a working folder, by every spelling of the path", { skip: !hasLinks }, async () => {
  const through = SPELLINGS.map((p) => p.replace("account", "keylink"));
  for (const [route, extra] of READS) for (const path of through) {
    const r = await get(route, { root: work, path, ...extra });
    assert.equal(r.status, 403, `${route} ${path}`);
    assert.ok(!r.text.includes("SECRET-KEY-BYTES"), `${route} ${path}`);
  }
  for (const [route, extra] of CHANGES) for (const path of through) {
    const r = await post(route, { root: work, path, ...extra });
    assert.equal(r.status, 403, `${route} ${path}: ${r.text}`);
    intact(`${route} ${path}`);
  }
  writeFileSync(join(work, "note.txt"), "n");
  for (const to of ["keylink/planted.txt", "/keylink/planted.txt", "//keylink/planted.txt", "\\keylink\\planted.txt"]) {
    const r = await post("/api/fs/rename", { root: work, path: "note.txt", to });
    assert.equal(r.status, 403, `rename to ${to}: ${r.text}`);
    intact(`rename to ${to}`);
    assert.ok(existsSync(join(work, "note.txt")));
  }
  const a = await post("/api/fs/write", { root: work, path: ["keylink/keys.json"], content: "PLANTED", force: true });
  assert.ok([400, 403].includes(a.status), `an array path: ${a.status}`);
  intact("an array path through the link");
  const b = await post("/api/fs/rename", { root: work, path: "note.txt", to: ["keylink/planted.txt"] });
  assert.ok([400, 403].includes(b.status), `an array target: ${b.status}`);
  intact("an array target through the link");
});

test("a path that is not text is not read as one", async () => {
  for (const [route, extra] of CHANGES) {
    const r = await post(route, { root: parent, path: ["account/keys.json"], ...extra });
    assert.ok(r.status === 400 || r.status === 403, `${route}: ${r.status}`);
    intact(route);
  }
  writeFileSync(join(parent, "note.txt"), "n");
  assert.ok([400, 403].includes((await post("/api/fs/rename", { root: parent, path: "note.txt", to: ["account/planted.txt"] })).status));
  intact("rename to an array");
  assert.ok([400, 403].includes((await post("/api/fs/write", { root: [parent], path: "account/keys.json", content: "x" })).status));
  intact("root as an array");
  assert.ok(existsSync(join(parent, "note.txt")), "the file stayed");
});

test("nothing is moved or created into the account folder", async () => {
  writeFileSync(join(parent, "note.txt"), "n");
  for (const to of ["account/planted.txt", "/account/planted.txt", "//account/planted.txt", "\\account\\planted.txt", "x/../account/planted.txt"]) {
    const r = await post("/api/fs/rename", { root: parent, path: "note.txt", to });
    assert.equal(r.status, 403, `rename to ${to}: ${r.text}`);
    intact(`rename to ${to}`);
    assert.ok(existsSync(join(parent, "note.txt")));
  }
});

test("a folder holding the account folder cannot be moved, copied or deleted, by any spelling", async () => {
  for (const [route, extra] of [["/api/fs/rename", { to: "elsewhere" }], ["/api/fs/duplicate", {}], ["/api/fs/delete", { permanent: true }], ["/api/fs/delete", {}]]) {
    for (const path of ["acct", "/acct", "//acct", "\\acct"]) {
      const r = await post(route, { root: base, path, ...extra });
      assert.equal(r.status, 403, `${route} ${path}: ${r.text}`);
      intact(`${route} ${path}`);
    }
  }
});

test("reveal is never reachable over a channel, like the other things only the person at the machine does", () => {
  for (const spelling of ["/api/fs/reveal", "/api/fs/REVEAL", "/api/fs/reveal/", "/api/fs//reveal", "/api/fs/reveal.", "/api/%66s/reveal"]) assert.equal(channelAllowed("POST", spelling), false, spelling);
  for (const allowed of ["/api/fs/write", "/api/fs/rename", "/api/fs/delete", "/api/fs/list"]) assert.equal(channelAllowed("POST", allowed), true, allowed);
});

test("everything beside the account folder still works, a leading slash included", async () => {
  writeFileSync(join(parent, "fine.txt"), "hello");
  assert.equal((await get("/api/fs/list", { root: parent })).status, 200, "the parent itself can be listed");
  assert.match((await get("/api/fs/read", { root: parent, path: "fine.txt" })).text, /hello/);
  assert.match((await get("/api/fs/read", { root: parent, path: "/fine.txt" })).text, /hello/);
  const here = join(base, "here");
  mkdirSync(here);
  writeFileSync(join(here, "fine.txt"), "hello");
  assert.equal((await post("/api/fs/write", { root: here, path: "/fine.txt", content: "changed" })).status, 200);
  assert.equal(readFileSync(join(here, "fine.txt"), "utf8"), "changed");
  assert.equal((await post("/api/fs/rename", { root: here, path: "fine.txt", to: "/sub/fine2.txt" })).status, 200);
  assert.equal(readFileSync(join(here, "sub", "fine2.txt"), "utf8"), "changed");
  assert.equal((await post("/api/fs/duplicate", { root: here, path: "sub/fine2.txt" })).status, 200);
  assert.equal((await post("/api/fs/delete", { root: here, path: "/sub/fine2.txt" })).status, 200);
  assert.equal(existsSync(join(here, "sub", "fine2.txt")), false);
});
