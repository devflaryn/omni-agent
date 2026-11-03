// The desktop as a client: /remote/<deviceId>/<path> through a real hub, two real Accounts and the real server's gate.
// The far side is either a real createApp, or an Account serving a handler the test writes, for what no route does on demand.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { connect } from "node:net";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { join } from "node:path";
import { startHub } from "../hub/server.mjs";
import { Account } from "../server/account.mjs";
import { serveChannel } from "../server/channel-host.mjs";
import { createApp } from "../server/index.mjs";
import { FRAME, decodeFrame, decodeHead } from "../ui/channel-frames.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (check, what = "condition", ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await check(); if (v) return v; await sleep(10); }
  assert.fail(`timed out waiting for ${what}`);
};
const base = mkdtempSync(join(tmpdir(), "omni-client-"));
let serial = 0;
const freshDir = () => { const d = join(base, `t${++serial}`); mkdirSync(d, { recursive: true }); return d; };
const BOOTSTRAP = "bootstrap-token-0123456789";
const ORIGIN = "https://hub.test";
const PASSWORD = "correct horse battery";
const EMAIL = "me@example.com";
const TOKEN = "window-token-for-the-client-tests-012345";

const testProtector = {
  name: "test",
  async protect(bytes) { return Buffer.concat([Buffer.from("TEST"), Buffer.from(bytes).map((b) => b ^ 0x5a)]); },
  async unprotect(bytes) { return Buffer.from(bytes).subarray(4).map((b) => b ^ 0x5a); },
};
const quickKey = async (password, salt) => new Uint8Array(createHash("sha256").update(password).update(salt).digest());
const accountOptions = { hubOrigin: ORIGIN, protector: testProtector, deriveLoginKey: quickKey, reconnect: { minMs: 20, maxMs: 100 } };

const cleanups = [];
after(async () => { for (const c of cleanups.reverse()) { try { await c(); } catch { /* */ } } });

async function startFixtureHub(dataDir, port = 0) {
  const hub = await startHub({ port, dataDir, bootstrapToken: BOOTSTRAP, origin: ORIGIN, log: () => {}, sweepMs: 50 });
  return hub;
}
async function hubFixture() {
  const dataDir = join(freshDir(), "hub");
  const fixture = { dataDir, hub: await startFixtureHub(dataDir) };
  fixture.port = fixture.hub.port;
  fixture.url = `http://127.0.0.1:${fixture.port}`;
  cleanups.push(() => fixture.hub?.close());
  return fixture;
}

const appOptions = (dir, extra = {}) => ({ port: 0, relay: { host: "" }, vaultDir: join(dir, "vault"), piSessionsDir: join(dir, "pi"), claudeProjectsDir: join(dir, "claude"), autoStartPi: false, cwd: dir, persistHook: false, persistPiModel: false, hook: { enabled: false }, ...extra });

/** A real server with a window: `call` is the window's account API, `at` its address. */
async function windowApp(fixture, { name = "Here", dir = freshDir(), links } = {}) {
  const accountDir = join(dir, "account");
  mkdirSync(accountDir, { recursive: true });
  const app = await createApp(appOptions(dir, { accountDir, accountHub: fixture.url, windowToken: TOKEN, accountOptions: { ...accountOptions, name }, ...(links ? { machineLinks: links } : {}) }));
  await app.listen();
  cleanups.push(() => app.close());
  const at = `http://127.0.0.1:${app.server.address().port}`;
  const swap = await fetch(`${at}/?desktop=1&token=${TOKEN}`, { redirect: "manual" });
  const cookie = swap.headers.get("set-cookie").split(";")[0];
  await swap.arrayBuffer();
  const call = async (method, path, body) => {
    const r = await fetch(`${at}/api/account/${path}`, { method, headers: { cookie, origin: at, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json() };
  };
  return { app, at, cookie, call, dir, accountDir };
}

function newAccount(fixture, { name, kind = "desktop", dir = join(freshDir(), "account"), WebSocketImpl } = {}) {
  const account = new Account({ dir, hubUrl: fixture.url, name, kind, log: () => {}, ...accountOptions, ...(WebSocketImpl ? { WebSocketImpl } : {}) });
  cleanups.push(() => account.stop());
  return account;
}

/** The device already on the account brings this one on, as the person would. */
async function approve(approver, account, role = "full") {
  await until(() => account.status().phase === "pending" && account.status().hub.connected, "the new device on the hub");
  const row = await until(() => approver.pendingSignIns().find((p) => p.signPub === account.status().device.id), "the card");
  const review = await approver.review(row.id);
  await until(() => account.status().pending?.code, "the code on the new device");
  assert.equal(account.status().pending.code, review.code);
  account.confirmCode(review.code);
  await approver.approve(row.id, { code: review.code, role });
  await until(() => account.status().phase === "approved", "approval");
  await until(() => account.status().hub.connected, "the new device's socket");
  await until(() => account.status().logHead === approver.status().logHead, "the same log on both");
}

/** A WebSocket the test can silence: once `dead` is set, nothing goes either way but the socket stays up. */
function silencing(state) {
  return class Silenced {
    constructor(url) {
      this.real = new WebSocket(url);
      this.real.onopen = (e) => this.onopen?.(e);
      this.real.onclose = (e) => this.onclose?.(e);
      this.real.onerror = (e) => this.onerror?.(e);
      this.real.onmessage = (e) => { if (!state.dead) this.onmessage?.(e); };
    }
    get readyState() { return this.real.readyState; }
    get bufferedAmount() { return this.real.bufferedAmount; }
    send(text) { if (!state.dead || !String(text).includes("channel.msg")) this.real.send(text); }
    close(...a) { this.real.close(...a); }
  };
}

/** A window on an account, and a far machine with its own handler. */
async function pair({ handle, links, farWs, farName = "Far box" } = {}) {
  const fixture = await hubFixture();
  const here = await windowApp(fixture, { links });
  writeFileSync(join(here.accountDir, "bootstrap-token"), `${BOOTSTRAP}\n`);
  const reg = await here.call("POST", "register", { email: EMAIL, password: PASSWORD, name: "Here" });
  assert.equal(reg.status, 200, JSON.stringify(reg.json));
  await here.call("POST", "recovery-code/saved");
  await until(() => here.app.account.status().hub.connected, "the window's socket");
  const far = newAccount(fixture, { name: farName, WebSocketImpl: farWs });
  await far.signIn({ email: EMAIL, password: PASSWORD, name: farName });
  await approve(here.app.account, far);
  const seen = [];
  const farHandle = handle ?? ((req, res) => { seen.push(req); res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ path: req.url })); });
  // Every request head as it arrived, before the host's own filter: what this side really sent.
  const crossed = [];
  far.on("channel", (channel) => {
    const onFrame = channel.onFrame.bind(channel);
    channel.onFrame = (callback) => onFrame((bytes) => {
      const frame = decodeFrame(bytes);
      if (frame.type === FRAME.REQ) crossed.push(decodeHead(frame.payload));
      callback(bytes);
    });
    serveChannel(channel, farHandle, { device: channel.peer, audit: () => {} });
  });
  const farId = far.status().device.id;
  const remote = (path) => `${here.at}/remote/${encodeURIComponent(farId)}${path}`;
  const window = { cookie: here.cookie, origin: here.at };
  await until(() => here.app.account.devices().find((d) => d.id === farId)?.online, "the far machine online");
  return { fixture, here, far, farId, remote, window, seen, crossed };
}

/** Reads a server-sent stream, keeping every event. `until(fn)` waits on the text so far. */
async function sse(url, headers) {
  const controller = new AbortController();
  const r = await fetch(url, { headers, signal: controller.signal });
  const out = { status: r.status, headers: r.headers, text: "", ended: false, failed: null, close: () => controller.abort() };
  out.done = (async () => {
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    try { for (;;) { const { done, value } = await reader.read(); if (done) break; out.text += decoder.decode(value); } out.ended = true; }
    catch (e) { out.failed = e; }
  })();
  return out;
}

// ---------------------------------------------------------------------------------- the plain way

test("a request and an event stream cross two real accounts and a real hub, and reach the real server", async () => {
  const fixture = await hubFixture();
  const here = await windowApp(fixture);
  writeFileSync(join(here.accountDir, "bootstrap-token"), `${BOOTSTRAP}\n`);
  assert.equal((await here.call("POST", "register", { email: EMAIL, password: PASSWORD, name: "Here" })).status, 200);
  await here.call("POST", "recovery-code/saved");
  await until(() => here.app.account.status().hub.connected, "socket");
  const there = await windowApp(fixture, { name: "There" });
  assert.equal((await there.call("POST", "sign-in", { email: EMAIL, password: PASSWORD, name: "There" })).status, 200);
  await approve(here.app.account, there.app.account);
  const id = there.app.account.status().device.id;
  await until(() => here.app.account.devices().find((d) => d.id === id)?.online, "online");
  const prefix = `${here.at}/remote/${encodeURIComponent(id)}`;
  const headers = { cookie: here.cookie };

  const state = await fetch(`${prefix}/api/state`, { headers });
  assert.equal(state.status, 200);
  const body = await state.json();
  assert.equal(body.access.role, "device", "the far server saw another device, not its own window");
  assert.equal(body.config.cwd, there.dir, "and it is the far machine's state");

  const events = await sse(`${prefix}/events?since=0`, headers);
  assert.match(events.headers.get("content-type"), /text\/event-stream/);
  there.app.bus.emit({ kind: "log", level: "info", text: "from the far machine", sid: "x" });
  await until(() => events.text.includes("from the far machine"), "the far machine's event");
  events.close();

  // The audit on the far machine names who asked.
  await until(async () => (await there.call("GET", "audit")).json.lines.some((l) => l.path === "/api/state" && l.deviceName === "Here"), "the audit line");
});

test("every action reuses one channel per machine, and each new one has a fresh handshake", async () => {
  const { fixture, here, far, remote, window } = await pair();
  const asked = await Promise.all(Array.from({ length: 12 }, (_, i) => fetch(remote(`/x?i=${i}`), { headers: { cookie: window.cookie } }).then((r) => r.json())));
  assert.equal(asked.length, 12);
  await fetch(remote("/again"), { headers: { cookie: window.cookie } }).then((r) => r.text());
  const out = () => here.app.account.status().channels.filter((c) => c.direction === "out");
  assert.equal(out().length, 1, "one channel, however many requests");
  const first = out()[0].id;
  // A machine that drops off and returns gets a new handshake, not a resumed channel.
  for (const channel of here.app.account.status().channels) assert.equal(channel.device, far.status().device.id);
  await far.stop();
  await until(() => out().length === 0, "the channel to go with the machine");
  const back = newAccount(fixture, { name: "Far box", dir: far.dir });
  back.on("channel", (channel) => serveChannel(channel, (req, res) => { res.writeHead(200); res.end("{}"); }, { device: channel.peer, audit: () => {} }));
  await back.start();
  await until(() => here.app.account.devices().find((d) => d.id === far.status().device.id)?.online, "online again");
  await (await fetch(remote("/after"), { headers: { cookie: window.cookie } })).text();
  assert.equal(out().length, 1);
  assert.notEqual(out()[0].id, first, "a fresh handshake");
});

test("an upload streams: a slow reader over there holds the sender back, and the bytes arrive whole", async () => {
  let farRead = 0;
  const digest = createHash("sha256");
  let finished;
  const got = new Promise((r) => { finished = r; });
  const { remote, window } = await pair({
    handle: async (req, res) => {
      for await (const chunk of req) {
        farRead += chunk.length;
        digest.update(chunk);
        await sleep(2);
      }
      finished(digest.digest("hex"));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ read: farRead }));
    },
  });
  const size = 30 * 1024 * 1024;
  const bytes = Buffer.alloc(size);
  for (let i = 0; i < size; i += 4096) bytes[i] = i & 255;
  const url = new URL(remote("/upload"));
  let wrote = 0, ahead = 0;
  const status = await new Promise((resolve, reject) => {
    const req = httpRequest({ host: url.hostname, port: url.port, path: url.pathname, method: "POST", headers: { cookie: window.cookie, origin: window.origin, "content-type": "application/octet-stream", "content-length": String(size) } }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    req.on("error", reject);
    const more = () => {
      while (wrote < size) {
        const piece = bytes.subarray(wrote, wrote + 64 * 1024);
        wrote += piece.length;
        ahead = Math.max(ahead, wrote - farRead);
        if (!req.write(piece)) { req.once("drain", more); return; }
      }
      req.end();
    };
    more();
  });
  assert.equal(status, 200);
  assert.equal(farRead, size);
  assert.equal(await got, createHash("sha256").update(bytes).digest("hex"));
  // Kernel buffers on a loopback socket and the channel's window, not the whole file held on this side.
  assert.ok(ahead < 16 * 1024 * 1024, `the sender ran ${Math.round(ahead / 1e6)} MB ahead of the far reader`);
});

// ---------------------------------------------------------------------------------- the gate

test("/remote needs the window cookie: no cookie, a forged one, a foreign Origin and another device are all refused", async () => {
  const { here, far, farId, remote, window, seen } = await pair();
  const noCookie = await fetch(remote("/api/state"));
  assert.equal(noCookie.status, 403);
  const forged = await fetch(remote("/api/state"), { headers: { cookie: "omni_window=not-the-real-one" } });
  assert.equal(forged.status, 403);
  const badOrigin = await fetch(remote("/api/x"), { method: "POST", headers: { cookie: window.cookie, origin: "http://evil.example", "content-type": "application/json" }, body: "{}" });
  assert.equal(badOrigin.status, 403);
  const noOrigin = await fetch(remote("/api/x"), { method: "POST", headers: { cookie: window.cookie, "content-type": "application/json" }, body: "{}" });
  assert.equal(noOrigin.status, 403);
  const foreignGet = await fetch(remote("/api/x"), { headers: { cookie: window.cookie, origin: "http://evil.example" } });
  assert.equal(foreignGet.status, 403);
  assert.equal(seen.length, 0, "none of them reached the far machine");

  // The window's own server, asked over a channel, will not relay onward.
  const channel = await far.openChannel(here.app.account.status().device.id);
  const { channelClient } = await import("../server/channel-host.mjs");
  const client = channelClient(channel);
  const relayed = await client.request({ method: "GET", path: `/remote/${encodeURIComponent(farId)}/api/state` });
  assert.equal(relayed.status, 403);
  await relayed.text();
  client.close();
});

test("the proxy builds a clean request: no cookie, no Origin, nothing local crosses", async () => {
  const { remote, window, seen, crossed } = await pair();
  const r = await fetch(remote("/api/thing?a=1&b=%20x"), { method: "PUT", headers: { cookie: `${window.cookie}; other=secret`, origin: window.origin, referer: `${window.origin}/secret-page`, authorization: "Bearer local-secret", "x-omni-local": "yes", "user-agent": "Local UA", "accept-language": "tr", "content-type": "application/json", "last-event-id": "7", range: "bytes=0-1" }, body: "{}" });
  await r.text();
  assert.equal(r.status, 200);
  const req = seen.at(-1);
  assert.equal(req.url, "/api/thing?a=1&b=%20x");
  assert.equal(req.method, "PUT");
  assert.deepEqual(Object.keys(req.headers).sort(), ["accept", "accept-language", "content-type", "host", "last-event-id", "range"].sort());
  assert.equal(req.headers.host, "omni-channel.invalid");
  // As sent, not only as the host's filter left it: nothing local leaves this computer at all.
  assert.equal(crossed.length, 1);
  const sent = JSON.stringify(crossed[0]);
  for (const local of ["secret", "omni_window", window.origin, "Local UA", "Bearer", "x-omni-local"]) assert.ok(!sent.includes(local), `${local} crossed: ${sent}`);
});

test("a read from another page on this site is refused, whatever cookie came with it", async () => {
  const { here, farId, window, seen } = await pair();
  const url = new URL(here.at);
  const get = (site) => new Promise((resolve, reject) => {
    const req = httpRequest({ host: url.hostname, port: url.port, path: `/remote/${encodeURIComponent(farId)}/x`, headers: { cookie: window.cookie, ...(site ? { "sec-fetch-site": site } : {}) } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on("error", reject);
    req.end();
  });
  assert.equal(await get("cross-site"), 403);
  assert.equal(await get("same-site"), 403, "another port on this name is same-site");
  assert.equal(seen.length, 0);
  assert.equal(await get("same-origin"), 200);
  assert.equal(await get("none"), 200, "a person's own navigation");
  assert.equal(await get(null), 200, "not sent by everything");
});

test("what comes back is cleaned too: cookies dropped, active content sandboxed, odd statuses refused", async () => {
  const replies = {
    "/cookie": { status: 200, headers: { "Set-Cookie": "omni_window=stolen; Path=/", Location: "http://evil.example/", "Content-Type": "text/plain", "X-Custom": "1", "Access-Control-Allow-Origin": "*", "Clear-Site-Data": "*", Refresh: "0; url=http://evil.example" }, body: "hi" },
    "/html": { status: 200, headers: { "Content-Type": "text/html" }, body: "<script>fetch('/api/account/approve')</script>" },
    "/svg": { status: 200, headers: { "Content-Type": "image/svg+xml" }, body: "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>" },
    "/upgrade": { status: 101, headers: { Upgrade: "h2c" }, body: "" },
    "/low": { status: 42, headers: {}, body: "" },
    "/bad-value": { status: 200, headers: { "Content-Type": "text/plain\r\nSet-Cookie: x=1" }, body: "ok" },
  };
  const { remote, window } = await pair({
    handle: (req, res) => {
      const reply = replies[req.url];
      // Past the host's own filter: this far machine is the one that lies.
      res.writeHead(reply.status, reply.headers);
      res.end(reply.body);
    },
  });
  const get = (p) => fetch(remote(p), { headers: { cookie: window.cookie } });

  const cookie = await get("/cookie");
  assert.equal(await cookie.text(), "hi");
  assert.equal(cookie.headers.get("set-cookie"), null);
  for (const dropped of ["location", "x-custom", "access-control-allow-origin", "clear-site-data", "refresh"]) assert.equal(cookie.headers.get(dropped), null, dropped);
  assert.equal(cookie.headers.get("x-content-type-options"), "nosniff");

  for (const active of ["/html", "/svg"]) {
    const r = await get(active);
    await r.text();
    assert.match(r.headers.get("content-security-policy"), /\bsandbox\b/, `${active} runs nothing in this window's origin`);
    assert.match(r.headers.get("content-security-policy"), /default-src 'none'/);
  }

  for (const odd of ["/upgrade", "/low"]) {
    const r = await get(odd);
    assert.equal(r.status, 502, odd);
    await r.text();
  }
  const bad = await get("/bad-value");
  assert.equal(bad.status, 200);
  assert.equal(bad.headers.get("set-cookie"), null);
  assert.equal(bad.headers.get("content-type"), null, "a value that could break the header block is no header");
  await bad.text();
});

test("a far machine that lies about Content-Length cannot smuggle a second response into this connection", async () => {
  const smuggled = "HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nowned";
  const { here, farId, window } = await pair({
    handle: (req, res) => {
      if (req.url === "/long") { res.writeHead(200, { "Content-Type": "text/plain", "Content-Length": "2" }); res.end(`ok${smuggled}`); return; }
      if (req.url === "/short") { res.writeHead(200, { "Content-Type": "text/plain", "Content-Length": "100" }); res.end("ok"); return; }
      if (req.url.startsWith("/odd")) { res.writeHead(200, { "Content-Type": "text/plain", "Content-Length": new URL(req.url, "http://x").searchParams.get("v") }); res.end("whole body"); return; }
      res.writeHead(200, { "Content-Type": "text/plain" }); res.end("fine");
    },
  });
  const url = new URL(here.at);
  // A raw socket on keep-alive, as a browser reuses it: what the wire carries, not what a parser chose to read.
  const raw = (path) => new Promise((resolve, reject) => {
    const socket = connect(Number(url.port), url.hostname, () => socket.write(`GET /remote/${encodeURIComponent(farId)}${path} HTTP/1.1\r\nHost: ${url.host}\r\nCookie: ${window.cookie}\r\nConnection: keep-alive\r\n\r\n`));
    let text = "";
    const timer = setTimeout(() => { socket.destroy(); resolve({ text, closed: false }); }, 3000);
    socket.on("data", (d) => { text += d; });
    socket.on("error", () => {});
    socket.on("close", () => { clearTimeout(timer); resolve({ text, closed: true }); });
    socket.on("timeout", reject);
  });
  const long = await raw("/long");
  assert.ok(!long.text.includes("owned"), `the extra bytes reached the socket: ${long.text.slice(-120)}`);
  assert.equal(long.closed, true, "a far machine that lied loses the connection");
  const short = await raw("/short");
  assert.equal(short.closed, true, "a body shorter than promised is a failure: the socket closes, nothing waits on it");

  // Lengths a browser and Number() would read differently, or not at all: dropped, so chunked frames the body.
  for (const odd of ["abc", "1e3", "0x10", " 5", "-1", "5, 5", "+5", "1234567890123456"]) {
    const r = await raw(`/odd?v=${encodeURIComponent(odd)}`);
    assert.doesNotMatch(r.text, /content-length/i, JSON.stringify(odd));
    assert.match(r.text, /transfer-encoding: chunked/i, JSON.stringify(odd));
    assert.match(r.text, /whole body/, JSON.stringify(odd));
    assert.doesNotMatch(r.text.split("\r\n\r\n").slice(1).join(""), /HTTP\/1\.1/, JSON.stringify(odd));
  }
});

test("deviceId is checked against the log: unknown, malformed, this computer and a web page are refused", async () => {
  const { fixture, here, remote, window, seen } = await pair();
  const self = here.app.account.status().device.id;
  const get = (id, path = "/api/state") => fetch(`${here.at}/remote/${id}${path}`, { headers: { cookie: window.cookie } });
  const unknown = await get(encodeURIComponent("A".repeat(43) + "="));
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).code, "no-such-machine");
  assert.equal((await get("%ZZ")).status, 400);
  const toSelf = await get(encodeURIComponent(self));
  assert.equal(toSelf.status, 400, "/remote/<self> is not a thing");
  assert.match((await toSelf.json()).error, /this computer/i);
  assert.equal((await get(encodeURIComponent(self), "")).status, 400);
  assert.equal((await fetch(`${here.at}/remote`, { headers: { cookie: window.cookie } })).status, 404);
  assert.equal((await fetch(remote(""), { headers: { cookie: window.cookie } })).status, 404, "no path after the id");

  const web = newAccount(fixture, { name: "A web page", kind: "web" });
  await web.signIn({ email: EMAIL, password: PASSWORD, name: "A web page" });
  await approve(here.app.account, web, "client");
  const toWeb = await get(encodeURIComponent(web.status().device.id));
  assert.equal(toWeb.status, 404, "a web page hosts nothing");
  assert.equal(seen.length, 0);
});

test("what only the far machine's own window may do is refused here, before it crosses", async () => {
  const { remote, window, seen, crossed } = await pair();
  for (const path of ["/api/account/status", "/api/account/approve", "/remote/x/api/state", "/api/shutdown", "/mcp", "/api/missions/tool", "/API/ACCOUNT/status", "/api/%61ccount/status", "/x/../api/account/status"]) {
    const r = await fetch(remote(path), { headers: { cookie: window.cookie } });
    assert.equal(r.status, 403, path);
    await r.text();
  }
  assert.equal(seen.length, 0);
  assert.deepEqual(crossed, [], "not one of them left this computer");
});

test("a device name cannot change what the error says: controls and direction marks are stripped", async () => {
  const { here, far, remote, window } = await pair({ farName: "Evil‮evil\n<b>x</b>\u0007" });
  await far.stop();
  await until(() => !here.app.account.devices().find((d) => d.id === far.status().device.id)?.online, "offline");
  const r = await fetch(remote("/api/state"), { headers: { cookie: window.cookie } });
  const j = await r.json();
  assert.equal(r.status, 503);
  assert.equal(j.code, "machine-offline");
  assert.doesNotMatch(j.error, /[‮\n\u0007]/);
  assert.match(j.error, /Evilevil/);
});

test("the request body limit: declared too large is refused at once, and a stream that grows past it is cut off", async () => {
  let farBytes = 0;
  const { remote, window } = await pair({
    links: { maxBodyBytes: 3 * 1024 * 1024 },
    handle: async (req, res) => {
      try { for await (const chunk of req) farBytes += chunk.length; } catch { /* aborted */ }
      if (!res.writableEnded) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ farBytes })); }
    },
  });
  const url = new URL(remote("/up"));
  const declared = await new Promise((resolve, reject) => {
    const req = httpRequest({ host: url.hostname, port: url.port, path: url.pathname, method: "POST", headers: { cookie: window.cookie, origin: window.origin, "content-length": String(40 * 1024 * 1024) } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on("error", reject);
    req.write("x"); // the rest never comes
  });
  assert.equal(declared, 413);
  assert.equal(farBytes, 0, "nothing of it crossed");

  // No length given: it streams, and it stops at the limit.
  const grown = await new Promise((resolve) => {
    const req = httpRequest({ host: url.hostname, port: url.port, path: url.pathname, method: "POST", headers: { cookie: window.cookie, origin: window.origin, "content-type": "application/octet-stream" } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on("error", (e) => resolve(e));
    const piece = Buffer.alloc(256 * 1024);
    let left = 80; // 20 MiB, well past the limit
    const more = () => { while (left-- > 0) { if (!req.write(piece)) { req.once("drain", more); return; } } req.end(); };
    more();
  });
  assert.equal(grown, 413);
  assert.ok(farBytes <= 3 * 1024 * 1024 + 256 * 1024, `the far side got ${farBytes}`);
});

// ------------------------------------------------------------------------- Review Focus 1: a dropped machine

test("a machine that closes mid-request: the action rejects at once, naming it, and looks nothing like success", async () => {
  let hang;
  const { far, remote, window } = await pair({ farName: "Ubuntu box", handle: (req, res) => { hang = res; if (req.url === "/half") { res.writeHead(200, { "Content-Type": "application/json" }); res.write('{"ok":'); } } });
  const started = Date.now();
  const pending = fetch(remote("/hang"), { method: "POST", headers: { cookie: window.cookie, origin: window.origin, "content-type": "application/json" }, body: "{}" });
  await until(() => hang, "the request over there");
  await far.stop();
  const r = await pending;
  assert.ok(r.status >= 500, "not a success");
  const j = await r.json();
  assert.match(j.error, /Ubuntu box/);
  assert.equal(j.code, "machine-lost");
  assert.match(j.error, /may or may not/);
  assert.ok(Date.now() - started < 30_000);
});

test("a machine lost halfway through a body: the response fails, it does not end cleanly", async () => {
  let wrote;
  const { far, remote, window } = await pair({ handle: (req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.write('{"ok":'); wrote = true; } });
  const events = await sse(remote("/half"), { cookie: window.cookie });
  await until(() => wrote && events.text.includes('{"ok":'), "the first half");
  await far.stop();
  await events.done;
  assert.equal(events.ended, false, "a clean end would pass for a whole answer");
  assert.ok(events.failed);
});

test("a machine that goes silent with no goodbye: rejects within 30 s, named, and the link shows stalled first", { timeout: 60_000 }, async () => {
  const silence = { dead: false };
  let hung = false;
  const { here, remote, window, farId } = await pair({ farName: "Silent box", farWs: silencing(silence), handle: (req) => { hung = req.url === "/hang"; } });
  // A channel in use, then silence: no close, no presence change, the socket stays up.
  const started0 = Date.now();
  const pending = fetch(remote("/hang"), { method: "POST", headers: { cookie: window.cookie, origin: window.origin, "content-type": "application/json" }, body: "{}" });
  await until(() => hung, "the request over there");
  silence.dead = true;
  const started = Date.now();
  await until(async () => (await here.call("GET", "machines")).json.machines.find((m) => m.id === farId)?.link.state === "stalled", "the stalled state", 28_000);
  const r = await pending;
  const took = Date.now() - started;
  assert.ok(took < 30_000, `took ${took} ms, of ${Date.now() - started0}`);
  assert.equal(r.status, 502);
  const j = await r.json();
  assert.match(j.error, /Silent box/);
});

test("no head within the budget is given up on, naming the machine, however alive the link", async () => {
  let aborted = false;
  const { remote, window } = await pair({
    farName: "Busy box",
    links: { responseTimeoutMs: 600 },
    handle: (req, res) => { res.once("close", () => { aborted = true; }); },
  });
  const started = Date.now();
  const r = await fetch(remote("/never"), { method: "POST", headers: { cookie: window.cookie, origin: window.origin, "content-type": "application/json" }, body: "{}" });
  const took = Date.now() - started;
  assert.equal(r.status, 504);
  const j = await r.json();
  assert.equal(j.code, "machine-slow");
  assert.match(j.error, /Busy box/);
  assert.match(j.error, /may or may not/);
  assert.ok(took < 5000, `took ${took}`);
  await until(() => aborted, "the far machine to be told");
});

test("the budget counts the time spent connecting: a machine that never finishes the handshake is rejected inside it", async () => {
  const silence = { dead: false };
  const { remote, window } = await pair({ farName: "Half there", farWs: silencing(silence), links: { responseTimeoutMs: 900 } });
  silence.dead = true; // online by the hub's word, and no channel open yet
  const started = Date.now();
  const r = await fetch(remote("/x"), { headers: { cookie: window.cookie } });
  const took = Date.now() - started;
  assert.equal(r.status, 504);
  assert.equal((await r.json()).code, "machine-unreachable");
  assert.ok(took < 2500, `took ${took}, past a 900 ms budget`);
});

test("a response already streaming is past the budget: it follows the liveness rule alone", async () => {
  const { remote, window } = await pair({
    links: { responseTimeoutMs: 200, pingEveryMs: 50, stallAfterMs: 150, deadAfterMs: 400 },
    handle: async (req, res) => { res.writeHead(200, { "Content-Type": "text/plain" }); res.write("start "); await sleep(1000); res.end("end"); },
  });
  const r = await fetch(remote("/stream"), { headers: { cookie: window.cookie } });
  assert.equal(await r.text(), "start end");
});

test("a far machine that answers early cannot turn an upload's 413 into a reset", async () => {
  const { remote, window } = await pair({
    links: { maxBodyBytes: 1024 * 1024 },
    // Hostile: a head at once, then it reads on and never finishes the reply.
    handle: async (req, res) => { res.writeHead(200, { "Content-Type": "text/plain" }); try { for await (const chunk of req) void chunk; } catch { /* */ } },
  });
  const url = new URL(remote("/up"));
  const status = await new Promise((resolve) => {
    const req = httpRequest({ host: url.hostname, port: url.port, path: url.pathname, method: "POST", headers: { cookie: window.cookie, origin: window.origin, "content-type": "application/octet-stream" } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on("error", (e) => resolve(e));
    const piece = Buffer.alloc(256 * 1024);
    let left = 24;
    const more = () => { while (left-- > 0) { if (!req.write(piece)) { req.once("drain", more); return; } } req.end(); };
    more();
  });
  assert.equal(status, 413);
});

test("a machine of another frame version is refused at open, naming it and saying to update", async () => {
  // It speaks another version in everything it sends, and hears ours: the opener's own check catches its hello.
  const rewrite = (text, v) => { const m = JSON.parse(text); if (typeof m.opaque === "string") { const o = JSON.parse(m.opaque); o.v = v; m.opaque = JSON.stringify(o); } return JSON.stringify(m); };
  const speaksOld = class extends WebSocket { send(text) { super.send(JSON.parse(text).type === "channel.msg" ? rewrite(text, 1) : text); } };
  const started = Date.now();
  const { here, remote, window } = await pair({ farName: "Old box", farWs: speaksOld });
  const opener = await fetch(remote("/x"), { headers: { cookie: window.cookie } });
  const j = await opener.json();
  assert.equal(opener.status, 502, JSON.stringify(j));
  assert.equal(j.code, "machine-version");
  assert.match(j.error, /Old box/);
  assert.match(j.error, /Update Omni/);
  assert.ok(Date.now() - started < 28_000, "no waiting out the handshake");
  assert.equal(here.app.account.status().channels.length, 0);
});

test("the far side of a version mismatch says so too: a hello it cannot read is answered, not dropped", async () => {
  // Now the far machine hears another version: its check answers the opener's hello with a close.
  const hearsOld = class {
    constructor(url) {
      this.real = new WebSocket(url);
      this.real.onopen = (e) => this.onopen?.(e);
      this.real.onclose = (e) => this.onclose?.(e);
      this.real.onerror = (e) => this.onerror?.(e);
      this.real.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.type === "channel.msg" && typeof m.opaque === "string") { const o = JSON.parse(m.opaque); o.v = 1; m.opaque = JSON.stringify(o); }
        this.onmessage?.({ data: JSON.stringify(m) });
      };
    }
    get readyState() { return this.real.readyState; }
    get bufferedAmount() { return this.real.bufferedAmount; }
    send(text) { this.real.send(text); }
    close(...a) { this.real.close(...a); }
  };
  const { remote, window } = await pair({ farName: "Old box", farWs: hearsOld });
  const r = await fetch(remote("/x"), { headers: { cookie: window.cookie } });
  const j = await r.json();
  assert.equal(j.code, "machine-version", JSON.stringify(j));
  assert.match(j.error, /Old box/);
});

test("a slow answer from a machine still answering is not given up on: silence is what counts", async () => {
  const { remote, window } = await pair({
    links: { pingEveryMs: 50, stallAfterMs: 150, deadAfterMs: 300 },
    handle: async (req, res) => { await sleep(1200); res.writeHead(200, { "Content-Type": "application/json" }); res.end('{"slow":true}'); },
  });
  const r = await fetch(remote("/compacting"), { method: "POST", headers: { cookie: window.cookie, origin: window.origin, "content-type": "application/json" }, body: "{}" });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { slow: true });
});

test("an offline machine is said to be offline at once, and nothing waits to run when it returns", async () => {
  const seenPaths = [];
  const record = (req, res) => { seenPaths.push(req.url); res.writeHead(200, { "Content-Type": "application/json" }); res.end("{}"); };
  const { fixture, here, far, farId, remote, window } = await pair({ farName: "Laptop", handle: record });
  await far.stop();
  await until(() => !here.app.account.devices().find((d) => d.id === farId)?.online, "offline");
  const started = Date.now();
  const r = await fetch(remote("/api/send"), { method: "POST", headers: { cookie: window.cookie, origin: window.origin, "content-type": "application/json" }, body: "{}" });
  assert.equal(r.status, 503);
  const j = await r.json();
  assert.match(j.error, /Laptop/);
  assert.match(j.error, /offline/);
  assert.ok(Date.now() - started < 2000, "no 30 s wait for what is already known");
  const back = newAccount(fixture, { name: "Laptop", dir: far.dir });
  back.on("channel", (channel) => serveChannel(channel, record, { device: channel.peer, audit: () => {} }));
  await back.start();
  await until(() => here.app.account.devices().find((d) => d.id === farId)?.online, "online again");
  const again = await fetch(remote("/api/other"), { headers: { cookie: window.cookie } });
  assert.equal(again.status, 200);
  await again.text();
  assert.deepEqual(seenPaths, ["/api/other"], "nothing was queued");
});

test("the hub restarting mid-request rejects naming the machine", async () => {
  let hung = false;
  const { fixture, remote, window } = await pair({ farName: "Tower", handle: (req) => { hung = req.url === "/hang"; } });
  const pending = fetch(remote("/hang"), { headers: { cookie: window.cookie } });
  await until(() => hung, "the request over there");
  const started = Date.now();
  await fixture.hub.close();
  const r = await pending;
  assert.ok(Date.now() - started < 30_000);
  assert.equal(r.status, 502);
  assert.match((await r.json()).error, /Tower/);
  fixture.hub = await startFixtureHub(fixture.dataDir, fixture.port);
});

// ---------------------------------------------------------------------- Review Focus 3: coming back after a drop

test("after a hub restart the link re-handshakes by itself, and events catch up from the seq", async () => {
  const fixture = await hubFixture();
  const here = await windowApp(fixture);
  writeFileSync(join(here.accountDir, "bootstrap-token"), `${BOOTSTRAP}\n`);
  await here.call("POST", "register", { email: EMAIL, password: PASSWORD, name: "Here" });
  await here.call("POST", "recovery-code/saved");
  await until(() => here.app.account.status().hub.connected, "socket");
  const there = await windowApp(fixture, { name: "There" });
  await there.call("POST", "sign-in", { email: EMAIL, password: PASSWORD, name: "There" });
  await approve(here.app.account, there.app.account);
  const id = there.app.account.status().device.id;
  await until(() => here.app.account.devices().find((d) => d.id === id)?.online, "online");
  const prefix = `${here.at}/remote/${encodeURIComponent(id)}`;
  const headers = { cookie: here.cookie };

  const stream = await sse(`${prefix}/events?since=0`, headers);
  there.app.bus.emit({ kind: "log", level: "info", text: "before the drop", sid: "x" });
  await until(() => stream.text.includes("before the drop"), "the first event");
  const firstChannel = here.app.account.status().channels[0].id;
  const seq = Number([...stream.text.matchAll(/"seq":(\d+)/g)].at(-1)[1]);
  const { boot } = await (await fetch(`${prefix}/api/state`, { headers })).json();

  await fixture.hub.close();
  await stream.done;
  assert.equal(stream.ended, false, "the stream fails, so the page reconnects");
  there.app.bus.emit({ kind: "log", level: "info", text: "during the drop", sid: "x" });
  fixture.hub = await startFixtureHub(fixture.dataDir, fixture.port);
  await until(() => here.app.account.status().hub.connected && there.app.account.status().hub.connected, "both reconnected");
  await until(() => here.app.account.devices().find((d) => d.id === id)?.online, "online again");

  // What createStream does on a reconnect: the same seq and boot. No resync when the ring still has it.
  const back = await sse(`${prefix}/events?since=${seq}&boot=${encodeURIComponent(boot)}`, headers);
  await until(() => back.text.includes("during the drop"), "the missed event");
  assert.ok(!back.text.includes("before the drop"), "only what was missed");
  assert.ok(!back.text.includes("event: resync"));
  const secondChannel = here.app.account.status().channels[0].id;
  assert.notEqual(secondChannel, firstChannel, "a fresh handshake, not the old channel");
  back.close();

  // A far server that restarted: the boot no longer matches, so the page is told to resync.
  const stale = await sse(`${prefix}/events?since=${seq}&boot=some-older-boot`, headers);
  await until(() => stale.text.includes("event: resync"), "the resync");
  stale.close();
});

// --------------------------------------------------------------------------- Review Focus 2: large and slow

test("200 MB through the proxy to a slow reader: the far side is held back, and memory stays bounded", { timeout: 120_000 }, async () => {
  const SIZE = 200 * 1024 * 1024;
  const PIECE = Buffer.alloc(1024 * 1024, 7);
  let farWrote = 0;
  const { remote, window } = await pair({
    links: { slowReaderMs: 60_000 },
    handle: async (req, res) => {
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": String(SIZE) });
      while (farWrote < SIZE && !res.destroyed) {
        farWrote += PIECE.length;
        if (!res.write(PIECE)) await new Promise((r) => res.once("drain", r));
      }
      res.end();
    },
  });
  const url = new URL(remote("/big"));
  // Live bytes, not garbage nothing has been asked to collect yet: that is what a bound on memory means here.
  setFlagsFromString("--expose-gc");
  const gc = runInNewContext("gc");
  gc();
  const baseline = process.memoryUsage();
  let peak = 0, peakAhead = 0, read = 0;
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const req = httpRequest({ host: url.hostname, port: url.port, path: `${url.pathname}${url.search}`, headers: { cookie: window.cookie } }, async (res) => {
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers["content-length"], String(SIZE));
      let n = 0;
      try {
        await sleep(3000); // not reading at all: only backpressure can stop the far side now
        peakAhead = farWrote;
        for await (const chunk of res) {
          read += chunk.length;
          hash.update(chunk);
          // Slow at first, enough to prove a stalled reader stops the far side, then quicker so that the run ends.
          if (++n < 60) await sleep(10);
          if (n % 64 === 0) {
            gc();
            const m = process.memoryUsage();
            peak = Math.max(peak, m.arrayBuffers + m.external - baseline.arrayBuffers - baseline.external);
            peakAhead = Math.max(peakAhead, farWrote - read);
          }
        }
        resolve();
      } catch (e) { reject(e); }
    });
    req.on("error", reject);
    req.end();
  });
  assert.equal(read, SIZE);
  assert.equal(hash.digest("hex"), createHash("sha256").update(Buffer.alloc(SIZE, 7)).digest("hex"));
  assert.ok(peakAhead < 32 * 1024 * 1024, `the far side ran ${Math.round(peakAhead / 1e6)} MB ahead of the reader`);
  // Everything is in this one process, hub included, and each frame is a few copies; still nowhere near the file.
  assert.ok(peak > 0, "it was measured");
  assert.ok(peak < 128 * 1024 * 1024, `off-heap memory grew by ${Math.round(peak / 1e6)} MB`);
});

test("a reader who stops holds no other request up: after a limit its stream is given up, and the window is free again", async () => {
  const { remote, window } = await pair({
    links: { slowReaderMs: 1500 },
    handle: async (req, res) => {
      if (req.url !== "/big") { res.writeHead(200, { "Content-Type": "text/plain" }); res.end("small"); return; }
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      const piece = Buffer.alloc(256 * 1024);
      while (!res.destroyed) { if (!res.write(piece)) await new Promise((r) => { res.once("drain", r); res.once("close", r); }); }
    },
  });
  const url = new URL(remote("/big"));
  const stuck = await new Promise((resolve, reject) => {
    const req = httpRequest({ host: url.hostname, port: url.port, path: url.pathname, headers: { cookie: window.cookie } }, (res) => { res.pause(); resolve({ req, res }); });
    req.on("error", () => {});
    req.on("close", () => {});
    setTimeout(() => reject(new Error("no head")), 10_000).unref();
    req.end();
  });
  stuck.res.on("error", () => {});
  // Not read at all, and given time to fill the channel's shared window. Another request must come through once it is given up.
  await sleep(800);
  const started = Date.now();
  const small = await fetch(remote("/small"), { headers: { cookie: window.cookie } });
  assert.equal(await small.text(), "small");
  assert.ok(Date.now() - started < 15_000);
  stuck.req.destroy();
});

test("a browser that goes away ends the request on the far machine", async () => {
  let closed = false;
  const { remote, window } = await pair({
    handle: (req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(": hello\n\n");
      res.once("close", () => { closed = true; });
    },
  });
  const stream = await sse(remote("/events"), { cookie: window.cookie });
  await until(() => stream.text.includes("hello"), "the stream");
  stream.close();
  await until(() => closed, "the far side to hear of it");
});

// ----------------------------------------------------------------------------------- removal and links

test("a removed machine is cut off: refused at once by the proxy, and its open streams end", async () => {
  let wrote = false;
  const { here, far, farId, remote, window } = await pair({ handle: (req, res) => { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.write(": x\n\n"); wrote = true; } });
  const stream = await sse(remote("/events"), { cookie: window.cookie });
  await until(() => wrote, "open");
  assert.equal((await here.call("POST", "remove", { id: farId })).status, 200);
  await stream.done;
  assert.equal(stream.ended, false);
  const r = await fetch(remote("/api/state"), { headers: { cookie: window.cookie } });
  assert.equal(r.status, 404);
  await r.text();
  await until(() => far.status().phase === "removed" || !far.status().hub.connected, "the far side knows");
});

test("/api/account/machines lists the other machines with their link, and needs the cookie", async () => {
  const { here, farId, remote, window } = await pair({ farName: "Box" });
  const list = await here.call("GET", "machines");
  assert.equal(list.status, 200);
  assert.deepEqual(list.json.machines.map((m) => [m.id, m.name, m.online, m.link.state]), [[farId, "Box", true, "idle"]]);
  await (await fetch(remote("/x"), { headers: { cookie: window.cookie } })).text();
  assert.equal((await here.call("GET", "machines")).json.machines[0].link.state, "open");
  assert.equal((await fetch(`${here.at}/api/account/machines`)).status, 403);
});

test("the news of a link reaches the window on its own stream", async () => {
  const { here, far, remote, window } = await pair({ farName: "Box" });
  const news = await sse(`${here.at}/api/account/events`, { cookie: window.cookie });
  await (await fetch(remote("/x"), { headers: { cookie: window.cookie } })).text();
  await until(() => /event: links\ndata: .*"state":"open"/.test(news.text), "the open link");
  await far.stop();
  await until(() => /event: links\ndata: .*"state":"(idle|offline)"/.test(news.text.slice(news.text.lastIndexOf("event: links"))), "the link gone");
  news.close();
});
