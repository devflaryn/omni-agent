// The host side of a channel: what may cross it, and how requests become the same handle() the local listener uses.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { WINDOW_COOKIE, WindowGate, channelAllowed, classify, inAccountFolder } from "../server/access.mjs";
import { channelClient, serveChannel } from "../server/channel-host.mjs";
import { createApp } from "../server/index.mjs";
import { FRAME, FRAME_VERSION, MAX_CHUNK, decodeFrame, encodeFrame } from "../ui/channel-frames.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (check, what = "condition", ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await check(); if (v) return v; await sleep(5); }
  assert.fail(`timed out waiting for ${what}`);
};
const base = mkdtempSync(join(tmpdir(), "omni-host-"));

/** Two ends joined in memory. `stall` holds what crosses until it is released. */
function pipePair() {
  class End extends EventEmitter {
    closed = false; sent = 0; #onFrame = null; #backlog = [];
    constructor(peer) { super(); this.peer = peer; }
    onFrame(cb) { this.#onFrame = cb; for (const f of this.#backlog.splice(0)) cb(f); }
    deliver(f) { if (this.closed) return; if (this.#onFrame) this.#onFrame(f); else this.#backlog.push(f); }
    async sendFrame(f) {
      if (this.closed) throw new Error("channel closed");
      this.sent += f.length;
      const bytes = Uint8Array.from(f);
      setImmediate(() => { if (this.other.stalled) this.other.held.push(bytes); else this.other.deliver(bytes); });
    }
    close(reason = "closed") { if (this.closed) return; this.closed = true; this.emit("close", reason); if (!this.other.closed) this.other.close(reason); }
    stalled = false; held = [];
    stall() { this.stalled = true; }
    release() { this.stalled = false; for (const f of this.held.splice(0)) this.deliver(f); }
  }
  const a = new End({ id: "peer-b", name: "b" }), b = new End({ id: "peer-a", name: "a", role: "full" });
  a.other = b; b.other = a;
  return [a, b];
}

const DEVICE = { id: "sign-pub-of-phone", name: "Phone", role: "full" };

function served(handle, opts = {}) {
  const [client, host] = pipePair();
  const lines = [];
  serveChannel(host, handle, { device: DEVICE, audit: (e) => lines.push(e), ...opts });
  return { client, host, lines, http: channelClient(client) };
}

const okHandle = (req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ url: req.url })); };

// ------------------------------------------------------------------------------- the gate

const REFUSED = [
  ["POST", "/api/missions/tool"],
  ["POST", "/mcp"],
  ["GET", "/mcp"],
  ["POST", "/api/missions/m-0123abcd/kg/load"],
  ["POST", "/api/claude/task"],
  ["POST", "/api/shutdown"],
  ["GET", "/api/remote/status"],
  ["POST", "/api/remote/password"],
  ["GET", "/api/remote/me"],
  ["GET", "/api/account/status"],
  ["POST", "/api/account/approve"],
  ["GET", "/remote/some-device/api/state"],
];

test("channelAllowed: the never list", () => {
  for (const [method, path] of REFUSED) assert.equal(channelAllowed(method, path), false, `${method} ${path}`);
});

test("channelAllowed: everything else is allowed", () => {
  for (const [method, path] of [
    ["GET", "/"], ["GET", "/app.js"], ["GET", "/events"], ["GET", "/api/state"], ["GET", "/api/fs/read?root=x&path=y"],
    ["POST", "/api/pi/prompt"], ["POST", "/api/missions"], ["GET", "/api/missions/m-0123abcd/kg/stats"],
    ["POST", "/api/missions/m-0123abcd/message"], ["POST", "/api/claude/run"], ["DELETE", "/api/sessions/abc"],
    ["PUT", "/api/providers/openrouter"], ["GET", "/api/mcp"], ["GET", "/api/missions/toolbox"], ["GET", "/api/accounts"],
    ["GET", "/mcpish"], ["GET", "/remotes"],
  ]) assert.equal(channelAllowed(method, path), true, `${method} ${path}`);
});

test("channelAllowed: encoding tricks do not get past it", () => {
  const tricks = [
    "/%6Dcp", "/%6dcp", "/MCP", "/Mcp", "/mcp/", "/mcp//", "/mcp?x=1", "/mcp#x", "/mcp/?x=1", "/./mcp", "/a/../mcp", "/a/%2E%2E/mcp", "/a/%2e%2e/mcp",
    "/%2E/mcp", "/a/..%2Fmcp", "/a/%2e%2e%2fmcp", "/%252e%252e/mcp", "/%256Dcp",
    "/api/shutdown/", "/API/SHUTDOWN", "/api//shutdown", "/api/%2Fshutdown", "/api%2Fshutdown", "/api%2fshutdown", "/api/./shutdown", "/api/x/../shutdown",
    "/api/shutdown?y=1", "/api/%73hutdown", "/api%252Fshutdown", "/api/shutdown%2F", "/api/shutdown%20", "/api/shutdown.",
    "/api/missions/tool/", "/api/missions/TOOL", "/api/missions//tool",
    "/api/missions/m-0123abcd/kg/load/", "/api/missions/m-0123abcd/KG/LOAD", "/api/missions/m-0123abcd/kg%2Fload", "/api/missions/whatever/kg/load",
    "/api/claude/task/", "/api/CLAUDE/task", "/api/claude%2Ftask",
    "/api/remote", "/api/remote/", "/API/REMOTE/status", "/api%2Fremote%2Fstatus", "/api/x/../remote/me",
    "/api/account", "/api/account/", "/API/ACCOUNT/status", "/api%2Faccount%2Fstatus", "/api/x/../account/status", "/api//account//status",
    "/remote", "/remote/", "/REMOTE/x", "/remote%2Fx",
  ];
  for (const path of tricks) assert.equal(channelAllowed("POST", path), false, path);
});

test("channelAllowed: a target that parses to something other than a local path is refused", () => {
  const odd = [
    "//evil/mcp", "//mcp", "///mcp", "/\\mcp", "\\mcp", "\\\\evil\\mcp", "/api\\shutdown", "/api%5Cshutdown", "/api/%5Cshutdown",
    "http://x/mcp", "https://x/api/shutdown", "mcp", "", "*", "/m\tcp", "/m\ncp", "/m\rcp", "/api/shut\tdown", "/mcp\0", "/m%00cp", "/m%09cp", "/m%0acp",
    "/%", "/%zz", "/%E0%A4%A", " /mcp", "/mcp ",
  ];
  for (const path of odd) assert.equal(channelAllowed("GET", path), false, JSON.stringify(path));
  for (const bad of [null, undefined, 7, {}, ["/x"]]) assert.equal(channelAllowed("GET", bad), false);
});

test("channelAllowed: a method outside the known set, in any spelling, is refused", () => {
  for (const method of ["post", "Get", "TRACE", "CONNECT", "", null, undefined, "GET ", "G\r\nET"]) assert.equal(channelAllowed(method, "/api/state"), false, String(method));
  for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]) assert.equal(channelAllowed(method, "/api/state"), true, method);
});

test("classify: a remote browser can never reach the account routes or the proxy", () => {
  for (const path of ["/api/account/status", "/api/account/approve", "/remote/x/api/state"]) {
    assert.equal(classify("GET", path), "host", path);
    assert.equal(classify("POST", path), "host", path);
  }
});

// ------------------------------------------------------------------------------- frames

test("frames: round trip, a known version only, nothing malformed", () => {
  const f = decodeFrame(encodeFrame(FRAME.RES_BODY, 7, Uint8Array.of(1, 2, 3)));
  assert.equal(f.type, FRAME.RES_BODY);
  assert.equal(f.stream, 7);
  assert.deepEqual([...f.payload], [1, 2, 3]);
  assert.equal(FRAME_VERSION, 1);
  const wrongVersion = encodeFrame(FRAME.RES_BODY, 7, new Uint8Array(0));
  wrongVersion[0] = 2;
  assert.throws(() => decodeFrame(wrongVersion), /version/);
  assert.throws(() => decodeFrame(new Uint8Array(3)), /short/);
  const wrongType = encodeFrame(FRAME.RES_BODY, 7, new Uint8Array(0));
  wrongType[1] = 200;
  assert.throws(() => decodeFrame(wrongType), /type/);
});

// ------------------------------------------------------------------------------- serveChannel

test("serveChannel: a request reaches handle as the channel's device, never as the host", async () => {
  let seen;
  const { http, lines } = served((req, res) => {
    seen = { url: req.url, method: req.method, omniChannel: req.omniChannel, omniHost: req.omniHost, signedIn: req.omniSignedIn, headers: { ...req.headers }, addr: req.socket?.remoteAddress };
    okHandle(req, res);
  });
  const r = await http.request({ method: "GET", path: "/api/state?a=1", headers: { accept: "application/json" } });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { url: "/api/state?a=1" });
  assert.deepEqual(seen.omniChannel, { deviceId: DEVICE.id, deviceName: DEVICE.name, role: DEVICE.role });
  assert.equal(seen.omniHost, undefined);
  assert.equal(seen.signedIn, undefined);
  assert.equal(seen.addr, undefined, "no address, so isHostRequest can never be true");
  assert.equal(seen.headers.accept, "application/json");
  assert.deepEqual(Object.keys(lines[0]).sort(), ["at", "device", "deviceName", "method", "path"]);
  assert.equal(lines[0].device, DEVICE.id);
  assert.equal(lines[0].deviceName, "Phone");
  assert.equal(lines[0].method, "GET");
  assert.equal(lines[0].path, "/api/state", "no query: it can hold search text");
});

test("serveChannel: the audit of a file route names its root and path, and nothing else from the query", async () => {
  const { http, lines } = served(okHandle);
  await (await http.request({ method: "GET", path: "/api/fs/read?root=C%3A%5Cwork&path=a%20b.txt&secret=x" })).text();
  assert.equal(lines[0].path, "/api/fs/read?root=C%3A%5Cwork&path=a+b.txt");
  await (await http.request({ method: "GET", path: "/api/memory/search?q=private&path=x" })).text();
  assert.equal(lines[1].path, "/api/memory/search");
});

test("serveChannel: a device cannot send itself a host's headers", async () => {
  let headers;
  const { http } = served((req, res) => { headers = { ...req.headers }; okHandle(req, res); });
  await http.request({ method: "GET", path: "/x", headers: { cookie: `${WINDOW_COOKIE}=stolen; omni_remote=a`, host: "127.0.0.1:4400", "x-forwarded-for": "1.1.1.1", origin: "http://127.0.0.1:4400", "sec-fetch-site": "same-origin", "content-type": "application/json" } });
  assert.equal(headers.cookie, undefined);
  assert.equal(headers.origin, undefined);
  assert.equal(headers["x-forwarded-for"], undefined);
  assert.equal(headers["sec-fetch-site"], undefined);
  assert.equal(headers.host, "omni-channel.invalid");
  assert.equal(headers["content-type"], "application/json");
});

test("serveChannel: refused paths are answered 403 and audited, and handle never runs", async () => {
  let ran = 0;
  const { http, lines } = served((req, res) => { ran++; okHandle(req, res); });
  for (const [method, path] of [...REFUSED, ["GET", "//evil/mcp"], ["POST", "/a/%2e%2e/mcp"], ["GET", "/%6Dcp"]]) {
    const r = await http.request({ method, path });
    assert.equal(r.status, 403, path);
    await r.text();
  }
  assert.equal(ran, 0);
  assert.equal(lines.length, REFUSED.length + 3, "a refusal is audited too");
});

test("serveChannel: a response cannot set a cookie on the far side", async () => {
  const { http } = served((req, res) => { res.setHeader("Set-Cookie", "x=1"); res.setHeader("X-Thing", "y"); okHandle(req, res); });
  const r = await http.request({ method: "GET", path: "/x" });
  assert.equal(r.headers["set-cookie"], undefined);
  assert.equal(r.headers["x-thing"], "y");
});

test("serveChannel: the body arrives whole, and the response API behaves like Node's", async () => {
  const { http } = served(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    res.statusCode = 201;
    res.setHeader("X-A", "1");
    res.appendHeader("X-B", "2");
    assert.equal(res.getHeader("x-a"), "1");
    assert.equal(res.hasHeader("X-B"), true);
    res.removeHeader("X-A");
    assert.equal(res.headersSent, false);
    res.write(Buffer.concat(chunks));
    assert.equal(res.headersSent, true);
    res.end("!");
  });
  const big = Buffer.alloc(3 * MAX_CHUNK + 17, 7);
  const r = await http.request({ method: "POST", path: "/x", body: big });
  assert.equal(r.status, 201);
  assert.equal(r.headers["x-a"], undefined);
  assert.equal(r.headers["x-b"], "2");
  const text = await r.buffer();
  assert.equal(text.length, big.length + 1);
  assert.equal(text.at(-1), "!".charCodeAt(0));
});

test("serveChannel: an event stream flows as separate chunks, without waiting for the end", async () => {
  let write;
  const { http } = served((req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    write = (t) => res.write(t);
  });
  const r = await http.request({ method: "GET", path: "/events" });
  assert.equal(r.status, 200, "the head arrives before any body");
  const got = [];
  r.body.on("data", (c) => got.push(c.toString()));
  write("data: 1\n\n");
  await until(() => got.join("").includes("data: 1"), "first event");
  write("data: 2\n\n");
  await until(() => got.join("").includes("data: 2"), "second event");
});

test("serveChannel: a burst of writes is coalesced, so a replay cannot trip the hub's frame rate", async () => {
  const { http, host } = served((req, res) => {
    res.writeHead(200);
    for (let i = 0; i < 4000; i++) res.write(`data: ${i}\n\n`);
    res.end();
  });
  let frames = 0;
  const send = host.sendFrame.bind(host);
  host.sendFrame = (f) => { frames++; return send(f); };
  const r = await http.request({ method: "GET", path: "/events" });
  const text = (await r.buffer()).toString();
  assert.equal(text.split("\n\n").length - 1, 4000);
  assert.ok(frames < 50, `${frames} frames for one burst`);
});

test("serveChannel: a stalled client stops a large response, and a source that respects it stops being read", async () => {
  let reads = 0;
  const pieces = 200, piece = 256 * 1024; // 50 MiB, far more than may ever be in flight
  const source = () => new Readable({ highWaterMark: piece, read() { reads++; this.push(reads > pieces ? null : Buffer.alloc(piece, 1)); } });
  const { http, client } = served((req, res) => { res.writeHead(200); source().pipe(res); });
  const r = await http.request({ method: "GET", path: "/big" });
  // The client receives nothing more and acknowledges nothing.
  client.stall();
  await sleep(150);
  const stalledAt = reads;
  assert.ok(stalledAt < pieces / 2, `read ${stalledAt} of ${pieces} pieces with nobody reading`);
  await sleep(100);
  assert.equal(reads, stalledAt, "reading has paused");
  client.release();
  const body = await r.buffer();
  assert.equal(body.length, pieces * piece);
});

test("serveChannel: a body over the limit gets 413, however it is sent, and stops being kept", async () => {
  let ranWith = -1;
  const { http } = served(async (req, res) => {
    let size = 0;
    try { for await (const c of req) size += c.length; } catch { /* cut off */ }
    ranWith = size;
    okHandle(req, res);
  }, { limits: { maxBody: 4 * MAX_CHUNK } });
  const r = await http.request({ method: "POST", path: "/x", body: Buffer.alloc(8 * MAX_CHUNK, 1) });
  assert.equal(r.status, 413);
  assert.ok(ranWith <= 4 * MAX_CHUNK, `handle saw ${ranWith} bytes`);
});

test("serveChannel: too many requests at once are refused, not queued without end", async () => {
  const { http } = served(() => { /* never answers */ }, { limits: { maxStreams: 3 } });
  for (let i = 0; i < 3; i++) http.request({ method: "GET", path: `/${i}` }).catch(() => {});
  const r = await http.request({ method: "GET", path: "/one-too-many" });
  assert.equal(r.status, 503);
});

test("serveChannel: a head too large, or not JSON, ends the channel: it is not a device talking sense", async () => {
  for (const payload of [new TextEncoder().encode("not json"), new TextEncoder().encode(JSON.stringify({ method: "GET", path: `/${"x".repeat(70000)}` }))]) {
    const { client, host } = served(okHandle);
    await client.sendFrame(encodeFrame(FRAME.REQ, 1, payload));
    await until(() => host.closed, "the channel closes");
  }
});

test("serveChannel: a body sent past the window ends the channel", async () => {
  const { client, host } = served(() => { /* never reads */ }, { limits: { window: MAX_CHUNK } });
  await client.sendFrame(encodeFrame(FRAME.REQ, 1, new TextEncoder().encode(JSON.stringify({ method: "POST", path: "/x" }))));
  for (let i = 0; i < 4; i++) await client.sendFrame(encodeFrame(FRAME.REQ_BODY, 1, new Uint8Array(MAX_CHUNK)));
  await until(() => host.closed, "the channel closes");
});

test("serveChannel: when the channel closes, every open request and response hears it", async () => {
  let reqClosed = false, resClosed = false, finished = null;
  const { http, client } = served((req, res) => {
    res.writeHead(200);
    res.write("x");
    req.on("close", () => { reqClosed = true; });
    res.on("close", () => { resClosed = true; finished = res.writableFinished; });
  });
  const r = await http.request({ method: "GET", path: "/events" });
  r.body.on("error", () => {});
  client.close("removed");
  await until(() => reqClosed && resClosed, "both closed");
  assert.equal(finished, false, "the route can tell it did not finish");
});

test("serveChannel: a client that aborts one request leaves the others running", async () => {
  const closed = [];
  let pending = 0;
  const { http } = served((req, res) => {
    pending++;
    res.writeHead(200);
    res.write("x");
    req.on("close", () => closed.push(req.url));
    if (req.url === "/two") res.end("done");
  });
  const one = await http.request({ method: "GET", path: "/one" });
  one.body.on("error", () => {});
  one.abort();
  await until(() => closed.includes("/one"), "the abort");
  const two = await http.request({ method: "GET", path: "/two" });
  assert.equal((await two.buffer()).toString(), "xdone");
  assert.equal(pending, 2);
});

test("channel client: a closed channel rejects a pending request instead of hanging, and fails a body in progress", async () => {
  const { http, client } = served((req, res) => { if (req.url === "/slow") { res.writeHead(200); res.write("x"); } });
  const hanging = http.request({ method: "GET", path: "/never" });
  const r = await http.request({ method: "GET", path: "/slow" });
  const body = r.buffer();
  client.close("gone");
  await assert.rejects(hanging, /gone/);
  await assert.rejects(body, /gone/);
  await assert.rejects(http.request({ method: "GET", path: "/after" }), /closed|gone/);
});

// ------------------------------------------------------------------------------- the real handle()

const work = join(base, "work");
const accountDir = join(base, "acct", "account");
const secrets = join(accountDir, "keys.json");
mkdirSync(accountDir, { recursive: true });
mkdirSync(work, { recursive: true });
writeFileSync(secrets, "SECRET-KEY-BYTES");
writeFileSync(join(work, "note.txt"), "visible");
writeFileSync(join(work, "pixel.png"), Buffer.alloc(1024, 3));
const hasLinks = (() => {
  try { symlinkSync(accountDir, join(work, "keylink"), "junction"); return true; } catch { return false; }
})();

const app = await createApp({ port: 0, lan: true, relay: { host: "" }, remotePort: 0, remoteHost: "127.0.0.1", remoteTls: false, vaultDir: join(base, "vault"), piSessionsDir: join(base, "pi"), claudeProjectsDir: join(base, "claude"), autoStartPi: false, cwd: work, liveWindowMs: 0, persistHook: false, persistPiModel: false, hook: { enabled: false }, accountDir, windowToken: "window-token-for-the-test-0123456789" });
await app.listen();
const port = app.server.address().port;
after(() => app.close());

function raw(path, { method = "GET", headers = {}, body, listenerPort = port } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port: listenerPort, method, path, headers: { host: `127.0.0.1:${listenerPort}`, ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on("error", reject);
    req.end(body);
  });
}
const realDevice = () => {
  const [client, host] = pipePair();
  const lines = [];
  serveChannel(host, app.handleChannelRequest, { device: DEVICE, audit: (e) => lines.push(e) });
  return { http: channelClient(client), lines };
};
const q = (obj) => new URLSearchParams(obj).toString();

test("real handle: a channel reads state as a device, and the event stream carries live events", async () => {
  const { http, lines } = realDevice();
  const r = await http.request({ method: "GET", path: "/api/state" });
  assert.equal(r.status, 200);
  const state = await r.json();
  assert.equal(state.access.role, "device");
  assert.equal(state.access.remote, undefined, "the host's remote settings are not shared");
  const ev = await http.request({ method: "GET", path: "/events" });
  assert.equal(ev.status, 200);
  assert.match(ev.headers["content-type"], /event-stream/);
  let text = "";
  ev.body.on("data", (c) => { text += c; });
  app.bus.emit({ sid: "s1", harness: "omni", kind: "log", ts: 1, text: "marker-over-channel" });
  await until(() => text.includes("marker-over-channel"), "the live event");
  ev.abort();
  await until(() => !app.bus.clients.size, "the bus forgets the stream once it is gone");
  assert.ok(lines.some((l) => l.path === "/events"));
});

test("real handle: the never list is 403 even with a hand-made request that skipped serveChannel", async () => {
  for (const [method, path] of REFUSED) {
    let status;
    const res = Object.assign(new EventEmitter(), { setHeader() {}, writeHead(s) { status = s; }, end() {} });
    const req = Object.assign(Readable.from([]), { method, url: path, headers: { host: "omni-channel.invalid" }, socket: {}, omniChannel: { deviceId: "d", deviceName: "n", role: "full" } });
    await app.handleChannelRequest(req, res);
    assert.equal(status, 403, path);
  }
});

test("real handle: allowed routes are the person's, not a remote browser's, with no approval card", async () => {
  const { http } = realDevice();
  const before = app.approvals.list().length;
  const r = await http.request({ method: "POST", path: "/api/missions", body: Buffer.from(JSON.stringify({})) });
  assert.notEqual(r.status, 403, "starting a mission is something the person at the machine can do");
  await r.text();
  assert.equal(app.approvals.list().length, before);
  const list = await http.request({ method: "GET", path: `/api/fs/list?${q({ root: base })}` });
  assert.equal(list.status, 200, "any folder, as at the machine");
  await list.text();
});

test("real handle: a channel body is capped like a signed-in remote browser's", async () => {
  const { http } = realDevice();
  const fine = await http.request({ method: "POST", path: "/api/goal", body: Buffer.from(JSON.stringify({ goal: "x".repeat(100 * 1024) })) });
  assert.notEqual(fine.status, 413, "past a signed-out browser's 16 KB");
  await fine.text();
  const r = await http.request({ method: "POST", path: "/api/goal", body: Buffer.alloc(33 * 1024 * 1024, 32) });
  assert.equal(r.status, 413);
  await r.text();
});

const attempts = () => {
  const out = [
    ["the file", { root: accountDir, path: "keys.json" }],
    ["the folder as root", { root: accountDir }],
    ["through the parent", { root: join(base, "acct"), path: "account/keys.json" }],
    ["with dots", { root: work, path: "../acct/account/keys.json" }],
    ["dots in the root", { root: join(work, "..", "acct", "account"), path: "keys.json" }],
    ["backslashes and dots", { root: work, path: "..\\acct\\account\\keys.json" }],
    ["a missing file inside it", { root: accountDir, path: "not-there.png" }],
  ];
  if (process.platform === "win32") {
    out.push(
      ["upper case", { root: accountDir.toUpperCase(), path: "KEYS.JSON" }],
      ["trailing dot", { root: `${accountDir}.`, path: "keys.json" }],
      ["trailing space and dot in the path", { root: join(base, "acct"), path: "account. /keys.json" }],
      ["a stream", { root: accountDir, path: "keys.json::$DATA" }],
      ["a folder stream", { root: `${accountDir}::$INDEX_ALLOCATION`, path: "keys.json" }],
      ["device path", { root: `\\\\?\\${accountDir}`, path: "keys.json" }],
      ["dot device path", { root: `\\\\.\\${accountDir}`, path: "keys.json" }],
      ["forward-slash device path", { root: `//?/${accountDir}`, path: "keys.json" }],
      ["loopback share", { root: `\\\\localhost\\${accountDir[0]}$${accountDir.slice(2)}`, path: "keys.json" }],
      ["loopback address share", { root: `\\\\127.0.0.1\\${accountDir[0]}$${accountDir.slice(2)}`, path: "keys.json" }],
    );
  }
  if (hasLinks) {
    out.push(["a link as root", { root: join(work, "keylink"), path: "keys.json" }], ["a link in the path", { root: work, path: "keylink/keys.json" }]);
  }
  return out;
};
const FS_ROUTES = ["/api/fs/list", "/api/fs/read", "/api/fs/raw", "/api/fs/archive-entry"];

test("file routes refuse the account folder to a local caller, every spelling", async () => {
  for (const route of FS_ROUTES) for (const [what, params] of attempts()) {
    const r = await raw(`${route}?${q(params)}`);
    assert.equal(r.status, 403, `${route}: ${what}`);
    assert.ok(!r.text.includes("SECRET-KEY-BYTES"), `${route}: ${what}`);
    assert.match(r.json.error, /account folder/, `${route}: ${what}`);
  }
});

test("file routes refuse the account folder over a channel, every spelling", async () => {
  const { http } = realDevice();
  for (const route of FS_ROUTES) for (const [what, params] of attempts()) {
    const r = await http.request({ method: "GET", path: `${route}?${q(params)}` });
    assert.equal(r.status, 403, `${route}: ${what}`);
    const text = await r.text();
    assert.ok(!text.includes("SECRET-KEY-BYTES"), `${route}: ${what}`);
  }
});

test("file routes refuse the account folder through an 8.3 short name", { skip: process.platform !== "win32" }, async (t) => {
  const short = spawnSync("cmd", ["/c", `for %I in ("${accountDir}") do @echo %~sI`], { encoding: "utf8", windowsVerbatimArguments: true }).stdout.trim();
  const long = join(base, "acct-with-a-long-enough-name");
  mkdirSync(long, { recursive: true });
  const shortLong = spawnSync("cmd", ["/c", `for %I in ("${long}") do @echo %~sI`], { encoding: "utf8", windowsVerbatimArguments: true }).stdout.trim();
  if (shortLong.toLowerCase() === long.toLowerCase()) return t.skip("8.3 names are off on this volume");
  // A real short name, for a folder made to be the account folder of a second check.
  assert.equal(await inAccountFolder(join(shortLong, "keys.json"), [long]), true);
  assert.equal(await inAccountFolder(join(short, "keys.json"), [accountDir]), true);
});

test("inAccountFolder: inside and outside", async () => {
  const dirs = [accountDir];
  assert.equal(await inAccountFolder(accountDir, dirs), true);
  assert.equal(await inAccountFolder(secrets, dirs), true);
  assert.equal(await inAccountFolder(join(accountDir, "no", "such", "file"), dirs), true);
  assert.equal(await inAccountFolder(join(base, "acct"), dirs), false, "the parent itself can be listed");
  assert.equal(await inAccountFolder(`${accountDir}-4411`, dirs), true, "a second instance's device identity");
  assert.equal(await inAccountFolder(join(`${accountDir}-4411`, "keys.json"), dirs), true);
  assert.equal(await inAccountFolder(join(base, "acct", "other-folder"), dirs), false, "a sibling of another name");
  assert.equal(await inAccountFolder(`${accountDir}-4411`, [`${accountDir}-4400`]), true, "seen from another instance");
  assert.equal(await inAccountFolder(join(work, "note.txt"), dirs), false);
  assert.equal(await inAccountFolder(join(base, "acct"), dirs, { containing: true }), true, "changing a parent would take the folder with it");
});

test("inAccountFolder: each Windows spelling on its own, with nothing on disk to fall back on", { skip: process.platform !== "win32" }, async () => {
  const gone = join(base, "NoSuchFolder", "Account");
  const dirs = [gone];
  assert.equal(await inAccountFolder(join(base, "nosuchfolder", "ACCOUNT", "keys.json"), dirs), true, "case");
  assert.equal(await inAccountFolder(`\\\\localhost\\${gone[0]}$${gone.slice(2)}\\keys.json`, dirs), true, "a share of this machine");
  assert.equal(await inAccountFolder(`\\\\127.0.0.1\\${gone[0]}$${gone.slice(2)}`, dirs), true, "by address");
  assert.equal(await inAccountFolder(`${gone}. \\keys.json::$DATA`, dirs), true, "dots, spaces and streams");
  assert.equal(await inAccountFolder("\\\\?\\C:\\Windows", dirs), true, "a device path is refused wherever it points");
  assert.equal(await inAccountFolder("\\\\.\\C:\\Windows", dirs), true);
  assert.equal(await inAccountFolder("\\\\nas.example\\share\\x", dirs), false, "someone else's share is not this");
});

test("file routes still work for everything else", async () => {
  const r = await raw(`/api/fs/read?${q({ root: work, path: "note.txt" })}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.content, "visible");
  const png = await raw(`/api/fs/raw?${q({ root: work, path: "pixel.png" })}`);
  assert.equal(png.status, 200);
  assert.equal(png.text.length, 1024);
  assert.equal(png.headers["content-type"], "image/png");
  const { http } = realDevice();
  const overChannel = await http.request({ method: "GET", path: `/api/fs/raw?${q({ root: work, path: "pixel.png" })}` });
  assert.equal(overChannel.status, 200);
  assert.equal((await overChannel.buffer()).length, 1024);
});

test("any other route taking a path refuses the account folder, local or channel", async () => {
  const { http } = realDevice();
  const cases = [
    ["POST", "/api/pi/start", { cwd: accountDir }],
    ["POST", "/api/pi/open", { cwd: accountDir }],
    ["POST", "/api/pi/send", { cwd: accountDir, message: "x" }],
    ["POST", "/api/pi/switch", { file: secrets }],
    ["POST", "/api/claude/run", { cwd: accountDir, prompt: "x" }],
    ["POST", "/api/missions", { dir: accountDir, goal: "x" }],
    ["POST", "/api/agents", { cwd: accountDir, kind: "shell" }],
    ["POST", "/api/graph/build", { dir: accountDir }],
    ["POST", "/api/graph/query", { dir: accountDir, question: "x" }],
    ["GET", `/api/graph/data?${q({ dir: accountDir })}`],
    ["POST", "/api/fs/rename", { root: work, path: "note.txt", to: "../acct/account/moved" }],
    ["POST", "/api/fs/duplicate", { root: join(base, "acct"), path: "account" }],
    ["POST", "/api/fs/rename", { root: base, path: "acct", to: "elsewhere" }],
    ["POST", "/api/fs/delete", { root: base, path: "acct" }],
    ["POST", "/api/whatever", { nested: { cwd: accountDir } }],
    ["GET", `/api/whatever?${q({ file: secrets })}`],
  ];
  for (const [method, path, body] of cases) {
    const text = body ? JSON.stringify(body) : undefined;
    const local = await raw(path, { method, headers: body ? { "content-type": "application/json" } : {}, body: text });
    assert.equal(local.status, 403, `local ${method} ${path} ${text}`);
    const r = await http.request({ method, path, body: text ? Buffer.from(text) : undefined });
    assert.equal(r.status, 403, `channel ${method} ${path} ${text}`);
    await r.text();
  }
});

test("a malformed body still fails the way it did, once the path check has read it", async () => {
  const r = await raw("/api/goal", { method: "POST", headers: { "content-type": "application/json" }, body: "{nope" });
  assert.equal(r.status, 500);
});

// ------------------------------------------------------------------------------- the window token

const swap = (token) => raw(`/?desktop=1&token=${encodeURIComponent(token)}`);

test("account routes: 403 without the cookie even from loopback, also the proxy", async () => {
  for (const path of ["/api/account/status", "/api/account/devices", "/api/account/audit", "/remote/x/api/state"]) {
    const r = await raw(path);
    assert.equal(r.status, 403, path);
  }
  const post = await raw("/api/account/approve", { method: "POST", headers: { "content-type": "application/json", origin: `http://127.0.0.1:${port}` }, body: "{}" });
  assert.equal(post.status, 403);
  const forged = await raw("/api/account/status", { headers: { cookie: `${WINDOW_COOKIE}=forged` } });
  assert.equal(forged.status, 403);
  const tokenAsCookie = await raw("/api/account/status", { headers: { cookie: `${WINDOW_COOKIE}=window-token-for-the-test-0123456789` } });
  assert.equal(tokenAsCookie.status, 403, "the token itself is not the cookie");
});

test("window token: not for the remote listener or a request that is not the host's", async () => {
  const remotePort = app.remote.port;
  const remote = await raw("/?desktop=1&token=window-token-for-the-test-0123456789", { listenerPort: remotePort });
  assert.equal(remote.headers["set-cookie"], undefined);
  const rebinding = await raw("/?desktop=1&token=window-token-for-the-test-0123456789", { headers: { host: "evil.example" } });
  assert.equal(rebinding.headers["set-cookie"], undefined);
  const proxied = await raw("/?desktop=1&token=window-token-for-the-test-0123456789", { headers: { "x-forwarded-for": "8.8.8.8" } });
  assert.equal(proxied.headers["set-cookie"], undefined);
  const { http } = realDevice();
  const channel = await http.request({ method: "GET", path: "/?desktop=1&token=window-token-for-the-test-0123456789" });
  assert.equal(channel.status, 200, "just the page");
  assert.equal(channel.headers["set-cookie"], undefined);
  await channel.text();
});

test("window token: a wrong token gets no cookie, and the URL is still cleaned", async () => {
  const r = await swap("wrong-token-of-a-different-length");
  assert.equal(r.status, 302);
  assert.equal(r.headers["set-cookie"], undefined);
  assert.equal(r.headers.location, "/?desktop=1");
});

let cookie;
test("window token: swapped once for an HttpOnly, SameSite=Strict cookie, and dropped from the URL", async () => {
  const r = await swap("window-token-for-the-test-0123456789");
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, "/?desktop=1");
  const [set] = r.headers["set-cookie"];
  assert.match(set, new RegExp(`^${WINDOW_COOKIE}=`));
  assert.match(set, /; HttpOnly/);
  assert.match(set, /; SameSite=Strict/);
  assert.match(set, /; Path=\//);
  assert.ok(!set.includes("window-token-for-the-test"), "the cookie is not the token");
  cookie = set.split(";")[0];
  const again = await swap("window-token-for-the-test-0123456789");
  assert.equal(again.headers["set-cookie"], undefined, "once");
  assert.equal(again.status, 302);
  const ok = await raw("/api/account/status", { headers: { cookie } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.phase, "signed-out");
});

test("WindowGate: the right cookie on a request that is not the host's own is still refused", () => {
  const gate = new WindowGate("gate-token");
  assert.equal(gate.swap({ omniHost: false }, new URL("http://x/?token=gate-token")), null);
  const { cookie: set } = gate.swap({ omniHost: true }, new URL("http://x/?token=gate-token"));
  const headers = { cookie: set.split(";")[0], host: "127.0.0.1:1" };
  assert.equal(gate.refusal({ omniHost: true, method: "GET", headers }), null);
  assert.match(gate.refusal({ omniHost: false, method: "GET", headers }), /desktop window/);
});

test("window cookie: not accepted anywhere but the host's own request", async () => {
  const remote = await raw("/api/account/status", { headers: { cookie }, listenerPort: app.remote.port });
  assert.ok(remote.status === 401 || remote.status === 403, `${remote.status}`);
  const rebinding = await raw("/api/account/status", { headers: { cookie, host: "evil.example" } });
  assert.notEqual(rebinding.status, 200);
  const proxied = await raw("/api/account/status", { headers: { cookie, "x-forwarded-for": "8.8.8.8" } });
  assert.notEqual(proxied.status, 200);
  const { http } = realDevice();
  const channel = await http.request({ method: "GET", path: "/api/account/status", headers: { cookie } });
  assert.equal(channel.status, 403);
  await channel.text();
});

test("account POST: the cookie is not enough, it needs this page's own Origin", async () => {
  const post = (headers) => raw("/api/account/settings", { method: "POST", headers: { cookie, "content-type": "application/json", ...headers }, body: JSON.stringify({ allowWebAccess: true }) });
  assert.equal((await post({})).status, 403, "no Origin");
  assert.equal((await post({ origin: "https://evil.example" })).status, 403);
  assert.equal((await post({ origin: "null" })).status, 403);
  assert.equal((await post({ origin: `http://127.0.0.1:${port}.evil.example` })).status, 403);
  assert.equal((await post({ origin: `http://127.0.0.1:${port + 1}` })).status, 403, "another Omni on another port");
  assert.equal((await post({ origin: `http://127.0.0.1:${port}`, "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await post({ origin: `http://127.0.0.1:${port}` })).status, 200);
});

test("account GET with a foreign Origin is refused too", async () => {
  assert.equal((await raw("/api/account/status", { headers: { cookie, origin: "https://evil.example" } })).status, 403);
});

test("account routes: settings and audit answer through the window cookie", async () => {
  const headers = { cookie, "content-type": "application/json", origin: `http://127.0.0.1:${port}` };
  const off = await raw("/api/account/settings", { method: "POST", headers, body: JSON.stringify({ allowWebAccess: false }) });
  assert.deepEqual(off.json, { allowWebAccess: false });
  const read = await raw("/api/account/settings", { headers: { cookie } });
  assert.deepEqual(read.json, { allowWebAccess: false });
  await raw("/api/account/settings", { method: "POST", headers, body: JSON.stringify({ allowWebAccess: true }) });
  const bad = await raw("/api/account/settings", { method: "POST", headers, body: JSON.stringify({ allowWebAccess: "no" }) });
  assert.equal(bad.status, 400);
  const audit = await raw("/api/account/audit?limit=5", { headers: { cookie } });
  assert.ok(Array.isArray(audit.json.lines));
  assert.ok(JSON.parse(readFileSync(join(accountDir, "settings.json"), "utf8")).allowWebAccess === true);
  const unknown = await raw("/api/account/nope", { headers: { cookie } });
  assert.equal(unknown.status, 404);
});

test("the token is not left in the environment for every child to inherit", async () => {
  process.env.OMNI_WINDOW_TOKEN = "from-the-launcher-0123456789abcdef";
  const scratch = await createApp({ port: 0, relay: { host: "" }, vaultDir: join(base, "vault3"), piSessionsDir: join(base, "pi"), claudeProjectsDir: join(base, "claude"), autoStartPi: false, cwd: work, persistHook: false, persistPiModel: false, hook: { enabled: false }, accountDir: join(base, "acct3") });
  assert.equal(process.env.OMNI_WINDOW_TOKEN, undefined);
  await scratch.listen();
  const scratchPort = scratch.server.address().port;
  const r = await raw("/?token=from-the-launcher-0123456789abcdef", { listenerPort: scratchPort });
  assert.ok(r.headers["set-cookie"], "and the server still has it");
  scratch.close();
});

test("without a token from the launcher the account routes say to open the desktop app", async () => {
  const scratch = await createApp({ port: 0, relay: { host: "" }, vaultDir: join(base, "vault4"), piSessionsDir: join(base, "pi"), claudeProjectsDir: join(base, "claude"), autoStartPi: false, cwd: work, persistHook: false, persistPiModel: false, hook: { enabled: false }, accountDir: join(base, "acct4") });
  await scratch.listen();
  const r = await raw("/api/account/status", { listenerPort: scratch.server.address().port });
  assert.equal(r.status, 403);
  assert.match(r.json.error, /desktop app/i);
  scratch.close();
});

// ------------------------------------------------------------------------------- the launcher

const PY = ["python3", "python"].find((p) => spawnSync(p, ["--version"], { encoding: "utf8" }).status === 0);

test("launcher: a token for the server's environment and the first URL, never in the plan or argv", { skip: !PY && "no python" }, () => {
  const script = join(process.cwd(), "desktop", "omni_desktop.pyw").replace(/\\/g, "/");
  const code = `
import importlib.machinery, importlib.util, json, sys
sys.dont_write_bytecode = True
loader = importlib.machinery.SourceFileLoader("omni_desktop", r"${script}")
spec = importlib.util.spec_from_loader("omni_desktop", loader)
m = importlib.util.module_from_spec(spec)
loader.exec_module(m)
p = m.plan(["--port", "4567"])
a, b = m.new_window_token(), m.new_window_token()
print(json.dumps({"plan": p, "a": a, "b": b, "url": m.first_url(p, a), "reused": m.first_url(p, None), "env": m.server_env(a).get("OMNI_WINDOW_TOKEN")}))
`;
  const r = spawnSync(PY, ["-c", code], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.notEqual(out.a, out.b);
  assert.ok(out.a.length >= 32);
  assert.equal(out.env, out.a);
  assert.equal(out.url, `http://127.0.0.1:4567/?desktop=1&token=${out.a}`);
  assert.equal(out.reused, "http://127.0.0.1:4567/?desktop=1", "a server it did not start was not given this token");
  assert.ok(!JSON.stringify(out.plan).includes(out.a));
});
