import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { OpencodeServer, sessionIdOf } from "../server/opencode-server.mjs";

const SERVE_ARGS = ["serve", "--port", "0", "--hostname", "127.0.0.1"];
/** Fast back-off so reconnects and restarts happen within a test. */
const backoff = { base: 5, cap: 20 };

/** Resolves once `cond()` is true; fails after `ms`. */
async function waitFor(cond, ms = 2000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
const nextEvent = (em, name, ms = 2000) => once(em, name, { signal: AbortSignal.timeout(ms) });

/**
 * A fake `opencode serve` on node:http: `/global/health`, the `/global/event` SSE stream, `/session` routes.
 * Every request needs `Basic base64("opencode:" + password())`; `password` is read per request so a test can
 * learn it from the spawned env.
 */
async function fakeOpencode({ password = () => "pw" } = {}) {
  const streams = new Set();
  const requests = [];
  const http = createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, path: u.pathname, directory: u.searchParams.get("directory"), auth: req.headers.authorization, body });
      if (req.headers.authorization !== `Basic ${Buffer.from(`opencode:${password()}`).toString("base64")}`) {
        res.writeHead(401, { "www-authenticate": 'Basic realm="Secure Area"' }); return res.end();
      }
      const json = (status, v) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
      if (u.pathname === "/global/health") return json(200, { healthy: true, version: "fake" });
      if (u.pathname === "/global/event") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ payload: { type: "server.connected", properties: {} } })}\n\n`);
        streams.add(res);
        res.on("close", () => streams.delete(res));
        return;
      }
      if (req.method === "POST" && u.pathname === "/session") return json(200, { id: "ses_new", directory: u.searchParams.get("directory"), title: JSON.parse(body || "{}").title });
      if (u.pathname === "/session/boom") return json(500, { name: "UnknownError", data: { message: "boom happened" } });
      if (u.pathname === "/session/bad") return json(400, { _tag: "BadRequest" });
      if (req.method === "DELETE" && u.pathname === "/session/ses_1") { res.writeHead(204); return res.end(); }
      if (u.pathname === "/session/hang") return; // never answers
      json(404, { name: "NotFound", data: { message: `no route ${u.pathname}` } });
    });
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const url = `http://127.0.0.1:${http.address().port}`;
  return {
    url,
    requests,
    streams,
    /**
     * Sends one SSE block `{directory, payload}` to every open stream, optionally with CRLF line ends, or split
     * mid-JSON into two writes 10ms apart (await it so the next block does not land between the halves).
     */
    async push(payload, { split = false, crlf = false } = {}) {
      const nl = crlf ? "\r\n" : "\n";
      const block = `data: ${JSON.stringify({ directory: "C:\\work", payload })}${nl}${nl}`;
      if (!split) { for (const s of streams) s.write(block); return; }
      const mid = Math.floor(block.length / 2);
      for (const s of streams) s.write(block.slice(0, mid));
      await new Promise((r) => setTimeout(r, 10));
      for (const s of streams) s.write(block.slice(mid));
    },
    dropStreams() { for (const s of streams) s.destroy(); },
    async close() { for (const s of streams) s.destroy(); http.closeAllConnections(); http.close(); await once(http, "close"); },
  };
}

/**
 * A fake `spawn`: each `opencode` launch returns a child that prints the listening line for `url()`; `taskkill`
 * ends the child with that pid (as the real one ends cmd.exe and its tree).
 */
function fakeSpawn(url) {
  const calls = [];
  const children = [];
  let pid = 1000;
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const child = new EventEmitter();
    child.pid = ++pid;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exited = false;
    child.end = (code = null, signal = null) => { if (child.exited) return; child.exited = true; setImmediate(() => child.emit("exit", code, signal)); };
    child.kill = (sig = "SIGTERM") => { child.end(null, sig); return true; };
    if (cmd === "taskkill") {
      const target = children.find((c) => String(c.pid) === String(args[1]));
      target?.end(1);
      child.end(0);
      return child;
    }
    children.push(child);
    setImmediate(() => child.stdout.write(`opencode server listening on ${url()}\n`));
    return child;
  };
  return { spawn, calls, children, launches: () => calls.filter((c) => c.cmd !== "taskkill") };
}

test("sessionIdOf reads properties.sessionID, info.sessionID or part.sessionID", () => {
  assert.equal(sessionIdOf({ type: "session.idle", properties: { sessionID: "a" } }), "a");
  assert.equal(sessionIdOf({ type: "message.updated", properties: { info: { id: "m", sessionID: "b" } } }), "b");
  assert.equal(sessionIdOf({ type: "message.part.updated", properties: { part: { id: "p", sessionID: "c" } } }), "c");
  assert.equal(sessionIdOf({ type: "server.heartbeat", properties: {} }), null);
  assert.equal(sessionIdOf(null), null);
});

test("routes SSE payloads to the session's listener only", async () => {
  const oc = await fakeOpencode();
  const server = new OpencodeServer({ url: oc.url, password: "pw", backoff });
  try {
    await server.start();
    assert.ok(server.proc, "proc is truthy while attached and up");
    const a = [], b = [];
    const offA = server.listen("ses_a", (p) => a.push(p));
    server.listen("ses_b", (p) => b.push(p));
    assert.deepEqual(server.listeners("down"), [], "session listeners do not shadow EventEmitter#listeners");
    const before = server.lastEventAt;
    await new Promise((r) => setTimeout(r, 5));
    oc.push({ type: "server.heartbeat", properties: {} });
    await waitFor(() => server.lastEventAt > before);
    oc.push({ type: "session.status", properties: { sessionID: "ses_a", status: { type: "busy" } } });
    await oc.push({ type: "message.updated", properties: { info: { id: "m1", sessionID: "ses_a" } } }, { split: true });
    oc.push({ type: "message.part.updated", properties: { part: { id: "p1", sessionID: "ses_a", type: "text" } } }, { crlf: true });
    oc.push({ type: "session.idle", properties: { sessionID: "ses_b" } });
    await waitFor(() => a.length === 3 && b.length === 1);
    assert.deepEqual(a.map((p) => p.type), ["session.status", "message.updated", "message.part.updated"]);
    assert.deepEqual(b, [{ type: "session.idle", properties: { sessionID: "ses_b" } }], "the listener gets the inner payload");
    offA();
    oc.push({ type: "session.idle", properties: { sessionID: "ses_a" } });
    oc.push({ type: "session.idle", properties: { sessionID: "ses_b" } });
    await waitFor(() => b.length === 2);
    assert.equal(a.length, 3, "an unsubscribed listener gets nothing more");
  } finally {
    server.stop();
    await oc.close();
  }
});

test("request adds directory and auth, throws Error(message) on 4xx/5xx JSON", async () => {
  const oc = await fakeOpencode({ password: () => "s3cret" });
  const server = new OpencodeServer({ url: oc.url, password: "s3cret", backoff });
  try {
    await server.start();
    const created = await server.request("POST", "/session", { directory: "C:\\Omni Apps\\a&b", body: { title: "hi" } });
    assert.deepEqual(created, { id: "ses_new", directory: "C:\\Omni Apps\\a&b", title: "hi" });
    const r = oc.requests.find((q) => q.method === "POST" && q.path === "/session");
    assert.equal(r.auth, `Basic ${Buffer.from("opencode:s3cret").toString("base64")}`);
    assert.match(r.url, /directory=C%3A%5COmni%20Apps%5Ca%26b$/);
    assert.deepEqual(JSON.parse(r.body), { title: "hi" });

    assert.equal(await server.request("DELETE", "/session/ses_1"), null, "204 → null");
    assert.deepEqual(await server.request("GET", "/global/health"), { healthy: true, version: "fake" });

    await assert.rejects(server.request("GET", "/session/boom"), (e) => e instanceof Error && e.message === "boom happened" && e.status === 500);
    await assert.rejects(server.request("GET", "/session/bad"), (e) => e.message === "BadRequest" && e.status === 400);
    await assert.rejects(server.request("GET", "/session/hang", { timeoutMs: 50 }), /timed out/);

    const wrong = new OpencodeServer({ url: oc.url, password: "nope", backoff });
    await assert.rejects(wrong.request("GET", "/global/health"), (e) => e.status === 401);
  } finally {
    server.stop();
    await oc.close();
  }
});

test("reconnects the event stream and emits down/up", async () => {
  const oc = await fakeOpencode();
  const server = new OpencodeServer({ url: oc.url, password: "pw", backoff });
  try {
    await server.start();
    const got = [];
    server.listen("ses_a", (p) => got.push(p));
    const down = nextEvent(server, "down");
    oc.dropStreams();
    await down;
    await nextEvent(server, "up");
    await waitFor(() => oc.streams.size === 1);
    oc.push({ type: "session.idle", properties: { sessionID: "ses_a" } });
    await waitFor(() => got.length === 1);
    assert.equal(got[0].type, "session.idle", "listeners survive the reconnect");
  } finally {
    server.stop();
    await oc.close();
  }
});

test("restarts the child after an unexpected exit, with a fresh listening url and the same listeners", async () => {
  let password = null;
  const oc = await fakeOpencode({ password: () => password });
  const fake = fakeSpawn(() => oc.url);
  const server = new OpencodeServer({ spawn: fake.spawn, platform: "linux", configDir: "/cfg", env: { FOO: "1" }, backoff });
  try {
    const started = server.start();
    await waitFor(() => fake.launches().length === 1);
    const [launch] = fake.launches();
    assert.equal(launch.cmd, "opencode");
    assert.deepEqual(launch.args, SERVE_ARGS);
    assert.equal(launch.opts.shell, false);
    assert.equal(launch.opts.windowsHide, true);
    assert.equal(launch.opts.env.OPENCODE_CONFIG_DIR, "/cfg");
    assert.equal(launch.opts.env.FOO, "1");
    password = launch.opts.env.OPENCODE_SERVER_PASSWORD;
    assert.ok(password && password.length >= 16, "a random password is generated");
    await started;
    assert.equal(server.url, oc.url);
    assert.deepEqual(await server.request("GET", "/global/health"), { healthy: true, version: "fake" });

    const got = [];
    server.listen("ses_a", (p) => got.push(p));
    const down = nextEvent(server, "down");
    fake.children[0].end(1);
    await down;
    await nextEvent(server, "up");
    assert.equal(fake.launches().length, 2, "relaunched once");
    assert.ok(server.proc, "the new child is up");
    await waitFor(() => oc.streams.size === 1);
    oc.push({ type: "session.idle", properties: { sessionID: "ses_a" } });
    await waitFor(() => got.length === 1);
  } finally {
    server.stop();
    await oc.close();
  }
});

test("keeps relaunching when spawn throws synchronously during a restart", async () => {
  let password = null;
  const oc = await fakeOpencode({ password: () => password });
  const fake = fakeSpawn(() => oc.url);
  let launches = 0;
  const spawn = (cmd, args, opts) => {
    if (cmd !== "taskkill" && ++launches === 2) throw new Error("spawn EMFILE");
    return fake.spawn(cmd, args, opts);
  };
  const logs = [];
  const server = new OpencodeServer({ spawn, platform: "linux", backoff, log: (l, t) => logs.push(`${l} ${t}`) });
  try {
    const started = server.start();
    await waitFor(() => fake.launches().length === 1);
    password = fake.launches()[0].opts.env.OPENCODE_SERVER_PASSWORD;
    await started;
    const down = nextEvent(server, "down");
    fake.children[0].end(1);
    await down;
    await nextEvent(server, "up");
    assert.equal(launches, 3, "the throwing relaunch was followed by another");
    assert.ok(logs.some((l) => /restart failed: spawn EMFILE/.test(l)));
    assert.deepEqual(await server.request("GET", "/global/health"), { healthy: true, version: "fake" });
  } finally {
    server.stop();
    await oc.close();
  }
});

test("stop() does not restart", async () => {
  let password = null;
  const oc = await fakeOpencode({ password: () => password });
  const fake = fakeSpawn(() => oc.url);
  const server = new OpencodeServer({ spawn: fake.spawn, platform: "linux", configDir: "/cfg", backoff });
  try {
    const started = server.start();
    await waitFor(() => fake.launches().length === 1);
    password = fake.launches()[0].opts.env.OPENCODE_SERVER_PASSWORD;
    await started;
    server.stop();
    await waitFor(() => fake.children[0].exited);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(fake.launches().length, 1, "no relaunch after stop()");
    assert.equal(server.proc, null);
    await assert.rejects(server.request("GET", "/global/health"), /not running/);
  } finally {
    server.stop();
    await oc.close();
  }
});

test("on Windows spawns opencode.cmd through the shell with fixed args and stop() kills the process tree", async () => {
  let password = null;
  const oc = await fakeOpencode({ password: () => password });
  const fake = fakeSpawn(() => oc.url);
  const server = new OpencodeServer({ spawn: fake.spawn, platform: "win32", configDir: "C:\\cfg", password: "given", backoff });
  password = "given";
  try {
    await server.start();
    const [launch] = fake.launches();
    assert.equal(launch.cmd, `opencode.cmd ${SERVE_ARGS.join(" ")}`, "one fixed command line");
    assert.deepEqual(launch.args, [], "no args array with shell:true (DEP0190)");
    assert.equal(launch.opts.shell, true);
    assert.equal(launch.opts.env.OPENCODE_SERVER_PASSWORD, "given");
    server.stop();
    const kill = fake.calls.find((c) => c.cmd === "taskkill");
    assert.deepEqual(kill.args, ["/pid", String(fake.children[0].pid), "/T", "/F"]);
    await waitFor(() => fake.children[0].exited);
  } finally {
    server.stop();
    await oc.close();
  }
});

test("start() rejects when the child exits before listening, without a restart loop", async () => {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    calls.push(cmd);
    const child = new EventEmitter();
    child.pid = 7; child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
    setImmediate(() => { child.stderr.write("Error: bad config\n"); setImmediate(() => child.emit("exit", 1, null)); });
    return child;
  };
  const server = new OpencodeServer({ spawn, platform: "linux", backoff });
  await assert.rejects(server.start(), /exited \(code 1\).*bad config/s);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(calls.length, 1);
  assert.equal(server.proc, null);
});
