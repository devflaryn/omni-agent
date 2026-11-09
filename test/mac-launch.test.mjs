// mac/launch.mjs: the plan the Mac app starts the server with, and the server's lifecycle under the app (ready line, stop when the
// app's pipe closes, never touch a server it did not start). Runs on every platform; the server it starts lives in temp folders.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultDataDir, launchPlan, nodeTooOld, probePort, stopWith, windowUrl } from "../mac/launch.mjs";
import { EventEmitter } from "node:events";

const script = join(process.cwd(), "mac", "launch.mjs");
const scratch = () => mkdtempSync(join(tmpdir(), "omni-mac-launch-"));
const freePort = () => new Promise((resolve) => { const s = createNetServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

test("launch plan: the Mac data dir, port 4400, Desktop, and no UI rebuild into the bundle", () => {
  const home = scratch();
  const p = launchPlan({ argv: [], env: {}, platform: "darwin", home, root: "/Applications/Omni Agent.app/Contents/Resources/app" });
  assert.equal(p.dataDir, join(home, "Library", "Application Support", "Omni Agent"));
  assert.equal(p.configFile, join(p.dataDir, "omni.config.json"));
  assert.equal(p.port, 4400);
  assert.equal(p.cwd, join(home, "Desktop"));
  assert.deepEqual(p.env, { OMNI_DATA_DIR: p.dataDir, OMNI_PORT: "4400", OMNI_CWD: p.cwd, OMNI_UI_AUTOBUILD: "0" });
  assert.equal(defaultDataDir({ platform: "linux", home }), join(home, ".omni-agent", "app"));
});

test("launch plan: the data dir's omni.config.json sets port and cwd; the command line and environment win over it", () => {
  const home = scratch();
  const data = join(home, "data");
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, "omni.config.json"), JSON.stringify({ port: 4555, cwd: "/projects" }));
  assert.equal(launchPlan({ env: { OMNI_DATA_DIR: data }, home }).port, 4555);
  assert.equal(launchPlan({ env: { OMNI_DATA_DIR: data }, home }).cwd, "/projects");
  assert.equal(launchPlan({ env: { OMNI_DATA_DIR: data, OMNI_PORT: "4600" }, home }).port, 4600);
  assert.equal(launchPlan({ argv: ["--port", "4700", "--cwd", "/x"], env: { OMNI_DATA_DIR: data, OMNI_PORT: "4600" }, home }).port, 4700);
  assert.equal(launchPlan({ argv: ["--data", join(home, "other")], env: { OMNI_DATA_DIR: data }, home }).dataDir, join(home, "other"));
  assert.throws(() => launchPlan({ argv: ["--port", "99999"], env: {}, home }), /not a port/);
});

test("launch: old Node is named, the window URL carries the token only when there is one", () => {
  assert.match(nodeTooOld("20.11.0"), /needs Node 22 or newer; this is Node 20\.11\.0/);
  assert.equal(nodeTooOld("22.0.0"), null);
  assert.equal(windowUrl(4400), "http://127.0.0.1:4400/?desktop=1");
  assert.equal(windowUrl(4400, "a+b"), "http://127.0.0.1:4400/?desktop=1&token=a%2Bb");
});

test("launch: stopWith stops once, on stdin closing, a signal or the parent going away", async () => {
  const fake = () => { const stdin = new EventEmitter(); stdin.resume = () => {}; const proc = new EventEmitter(); proc.ppid = 10; return { stdin, proc }; };
  let a = fake(), why = [];
  stopWith((w) => why.push(w), { ...a, parentPid: 10, pollMs: 10_000 });
  a.stdin.emit("end"); a.stdin.emit("close"); a.proc.emit("SIGTERM");
  assert.deepEqual(why, ["stdin closed"]);
  a = fake(); why = [];
  stopWith((w) => why.push(w), { ...a, parentPid: 10, pollMs: 10_000 });
  a.proc.emit("SIGHUP");
  assert.deepEqual(why, ["SIGHUP"]);
  a = fake(); why = [];
  stopWith((w) => why.push(w), { ...a, parentPid: 10, pollMs: 5 });
  a.proc.ppid = 1;
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(why, ["parent gone"]);
});

test("launch: probePort tells a free port, an Omni server and something else apart", async () => {
  const port = await freePort();
  assert.equal(await probePort(port), "free");
  const omni = createServer((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); }).listen(0, "127.0.0.1");
  await new Promise((r) => omni.once("listening", r));
  assert.equal(await probePort(omni.address().port), "omni");
  omni.close();
  const other = createNetServer((s) => { s.on("error", () => {}); s.end("SSH-2.0-not-http\r\n"); }).listen(0, "127.0.0.1");
  await new Promise((r) => other.once("listening", r));
  assert.equal(await probePort(other.address().port, { timeoutMs: 800 }), "taken");
  other.close();
});

/** Starts mac/launch.mjs the way the app does, with every home-relative path in a temp folder. */
function launch(port, extra = {}) {
  const home = scratch();
  const data = join(home, "data");
  mkdirSync(data, { recursive: true });
  // No chat at boot and no real opencode, ever: nothing here may start a model.
  writeFileSync(join(data, "omni.config.json"), JSON.stringify({ autoStartPi: false, opencodeBin: join(home, "no-such-opencode"), account: { hub: "https://127.0.0.1:9" }, ...extra }));
  const child = spawn(process.execPath, [script, "--port", String(port), "--data", data, "--cwd", home], {
    env: { ...process.env, HOME: home, USERPROFILE: home, NODE_TEST_CONTEXT: "" }, stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  const lines = [];
  child.stdout.on("data", (b) => { out += b; let i; while ((i = out.indexOf("\n")) >= 0) { lines.push(out.slice(0, i)); out = out.slice(i + 1); } });
  child.stderr.on("data", () => {});
  const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  const line = async (tag, ms = 30_000) => {
    const end = Date.now() + ms;
    for (;;) {
      const l = lines.find((x) => x.startsWith(`${tag} `));
      if (l) return JSON.parse(l.slice(tag.length + 1));
      if (Date.now() > end) throw new Error(`no ${tag} line; got: ${lines.join(" | ")}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  return { child, home, data, line, exited, lines };
}

test("launch: starts the server with a window token, writes nothing outside the data dir, and stops when the app's pipe closes", { timeout: 60_000 }, async () => {
  const port = await freePort();
  const run = launch(port);
  const ready = await run.line("OMNI-READY");
  assert.equal(ready.attached, false);
  assert.match(ready.url, new RegExp(`^http://127\\.0\\.0\\.1:${port}/\\?desktop=1&token=[\\w-]{40,}$`));
  const state = await fetch(`http://127.0.0.1:${port}/api/state`);
  assert.equal(state.status, 200);
  // The token goes only to the window: the page swaps it for a cookie, once.
  const first = await fetch(ready.url, { redirect: "manual" });
  assert.ok(first.headers.get("set-cookie"), "the token was taken");
  const again = await fetch(ready.url, { redirect: "manual" });
  assert.equal(again.headers.get("set-cookie"), null, "a second use gets nothing");
  // The vault went to the data dir, not beside the code.
  assert.ok(existsSync(join(run.data, "vault")), "the vault is in the data dir");
  assert.ok(!existsSync(join(process.cwd(), "mac", "vault")) && !existsSync(join(run.home, "vault")));
  run.child.stdin.end();
  assert.equal(await run.exited, 0);
  assert.equal(await probePort(port), "free", "the port is released");
});

test("launch: a server already on the port is used without the token and left running when the app quits", { timeout: 30_000 }, async () => {
  const omni = createServer((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); }).listen(0, "127.0.0.1");
  await new Promise((r) => omni.once("listening", r));
  const port = omni.address().port;
  const run = launch(port);
  const ready = await run.line("OMNI-READY");
  assert.deepEqual(ready, { url: `http://127.0.0.1:${port}/?desktop=1`, attached: true, port });
  run.child.stdin.end();
  assert.equal(await run.exited, 0);
  assert.equal(await probePort(port), "omni", "the other server is still there");
  omni.close();
});

test("launch: a port held by another program is refused with a message the app can show", { timeout: 30_000 }, async () => {
  const other = createNetServer((s) => { s.on("error", () => {}); s.end("not http\r\n"); }).listen(0, "127.0.0.1");
  await new Promise((r) => other.once("listening", r));
  const run = launch(other.address().port);
  const fail = await run.line("OMNI-FAIL");
  assert.match(fail.message, /in use by another program/);
  assert.equal(await run.exited, 2);
  other.close();
});
