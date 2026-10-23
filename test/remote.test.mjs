import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Approvals, RemoteAuth, classify, describe, isHostRequest, parseCookies, parseProxyLine, redact } from "../server/access.mjs";
import { SshTunnel, sshArgs } from "../server/tunnel.mjs";
import { loadOrCreateCert } from "../server/tls.mjs";
import { createApp } from "../server/index.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fakeReq = (addr, headers = {}) => ({ socket: { remoteAddress: addr }, headers });

// ------------------------------------------------------------------------------- pure parts
test("isHostRequest: loopback socket + loopback Host on the local listener, nothing else", () => {
  assert.equal(isHostRequest(fakeReq("127.0.0.1", { host: "127.0.0.1:4400" })), true);
  assert.equal(isHostRequest(fakeReq("::1", { host: "localhost:4400" })), true);
  assert.equal(isHostRequest(fakeReq("::ffff:127.0.0.1", { host: "[::1]:4400" })), true);
  assert.equal(isHostRequest(fakeReq("192.168.0.20", { host: "192.168.0.15:4400" })), false, "another device");
  assert.equal(isHostRequest(fakeReq("127.0.0.1", { host: "evil.example:4400" })), false, "DNS rebinding");
  assert.equal(isHostRequest(fakeReq("127.0.0.1", { host: "127.0.0.1", "x-forwarded-for": "8.8.8.8" })), false, "a local proxy or tunnel");
  assert.equal(isHostRequest(fakeReq("127.0.0.1", { host: "127.0.0.1" }), { remoteListener: true }), false, "anything on the remote listener");
});

test("classify: reads pass, changes need approval, host controls never run remotely", () => {
  assert.equal(classify("GET", "/"), "read");
  assert.equal(classify("GET", "/app.js"), "read");
  assert.equal(classify("GET", "/events"), "read");
  assert.equal(classify("GET", "/api/state"), "read");
  assert.equal(classify("GET", "/api/sessions/pi%3Aabc/history"), "read");
  assert.equal(classify("GET", "/api/fs/read"), "read");
  assert.equal(classify("POST", "/api/graph/query"), "read");
  assert.equal(classify("POST", "/api/sessions/x/continue"), "write");
  assert.equal(classify("POST", "/api/pi/prompt"), "write");
  assert.equal(classify("DELETE", "/api/sessions/x"), "write");
  assert.equal(classify("PUT", "/api/providers/openrouter"), "write");
  // Side effects behind GET are still changes: only listed reads are free.
  assert.equal(classify("GET", "/api/memory/import-claude"), "write");
  assert.equal(classify("GET", "/api/memory/open-vault"), "write");
  assert.equal(classify("GET", "/api/graph/build"), "write");
  assert.equal(classify("POST", "/api/pi/state"), "write");
  assert.equal(classify("GET", "/api/some/new/route"), "write");
  assert.equal(classify("POST", "/api/shutdown"), "host");
  assert.equal(classify("POST", "/api/claude/task"), "host");
  assert.equal(classify("POST", "/api/remote/password"), "host");
  assert.equal(classify("POST", "/api/remote/approvals/a1"), "host");
  assert.equal(classify("DELETE", "/api/remote/sessions"), "host");
});

test("describe + redact: the host reads what is asked, never a secret", () => {
  const d = describe("POST", "/api/sessions/pi%3Aabc/continue", { message: "run the build" }, { titleOf: (sid) => (sid === "pi:abc" ? "APK rebuild" : "") });
  assert.equal(d.title, "Send a message to “APK rebuild”");
  assert.equal(d.text, "run the build");
  assert.match(describe("PUT", "/api/mcp/fs", { command: "npx", args: ["-y", "srv"] }).title, /runs: npx -y srv/);
  assert.equal(describe("POST", "/api/whatever", {}).title, "POST /api/whatever");
  const r = redact({ apiKey: "sk-123", name: "x", env: { TOKEN: "abc" }, headers: { Authorization: "Bearer z" }, images: [1, 2], nested: { password: "p" }, long: "y".repeat(700) });
  assert.equal(r.apiKey, "(hidden)");
  assert.deepEqual(r.env, ["TOKEN"]);
  assert.deepEqual(r.headers, ["Authorization"]);
  assert.equal(r.images, "2 image(s)");
  assert.equal(r.nested.password, "(hidden)");
  assert.match(r.long, /700 characters/);
  assert.ok(!JSON.stringify(r).includes("sk-123") && !JSON.stringify(r).includes("Bearer z") && !JSON.stringify(r).includes("abc"));
});

test("parseCookies", () => {
  assert.deepEqual(parseCookies("a=1; omni_remote=t%2Bk; b=2"), { a: "1", omni_remote: "t+k", b: "2" });
  assert.deepEqual(parseCookies(undefined), {});
});

test("RemoteAuth: scrypt hash on disk, sign-in, lockout, expiry, password change signs everyone out", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omni-auth-"));
  const file = join(dir, "sub", "remote-auth.json");
  let now = 1_000_000;
  const auth = new RemoteAuth({ file, failDelayMs: 0, sessionTtlMs: 60_000, now: () => now });
  await assert.rejects(auth.login("1.2.3.4", "whatever"), { status: 503 });
  await assert.rejects(auth.setPassword("short"), { status: 400 });
  await auth.setPassword("correct horse");
  const stored = readFileSync(file, "utf8");
  assert.ok(!stored.includes("correct horse"), "no plaintext on disk");
  assert.ok(new RemoteAuth({ file }).hasPassword(), "survives a restart");
  await assert.rejects(auth.login("1.2.3.4", "wrong"), { status: 401 });
  const token = await auth.login("1.2.3.4", "correct horse");
  assert.ok(auth.session(token));
  assert.equal(auth.session("forged"), null);
  // Five misses lock that address, not others.
  for (let i = 0; i < 5; i++) await assert.rejects(auth.login("6.6.6.6", "nope"), { status: 401 });
  await assert.rejects(auth.login("6.6.6.6", "correct horse"), { status: 429 });
  assert.ok(await auth.login("5.5.5.5", "correct horse"));
  now += 16 * 60_000;
  assert.ok(await auth.login("6.6.6.6", "correct horse"), "the lock lifts after the window");
  assert.equal(auth.session(token), null, "sessions expire");
  const t2 = await auth.login("1.2.3.4", "correct horse");
  await auth.setPassword("another password");
  assert.equal(auth.session(t2), null);
});

test("RemoteAuth: thirty misses from anywhere lock every remote sign-in", async () => {
  const auth = new RemoteAuth({ failDelayMs: 0 });
  await auth.setPassword("correct horse");
  for (let i = 0; i < 30; i++) await assert.rejects(auth.login(`10.0.0.${i}`, "nope"), { status: 401 });
  await assert.rejects(auth.login("10.9.9.9", "correct horse"), { status: 429 });
});

test("Approvals: approve, deny, time out, cancel when the remote browser leaves", async () => {
  const a = new Approvals({ timeoutMs: 50 });
  const changes = [];
  a.on("change", (l) => changes.push(l.length));
  const p1 = a.request({ title: "one" });
  const [first] = a.list();
  assert.equal(first.title, "one");
  assert.ok(first.expiresAt > first.at);
  assert.equal(a.decide(first.id, true), true);
  assert.equal(await p1, "approved");
  assert.equal(a.decide(first.id, true), false, "decided once");
  const p2 = a.request({ title: "two" });
  a.decide(a.list()[0].id, false);
  assert.equal(await p2, "denied");
  assert.equal(await a.request({ title: "three" }), "timeout");
  const ac = new AbortController();
  const p4 = a.request({ title: "four" }, { signal: ac.signal });
  ac.abort();
  assert.equal(await p4, "cancelled");
  assert.equal(a.list().length, 0);
  assert.deepEqual(changes, [1, 0, 1, 0, 1, 0, 1, 0]);
});

// ------------------------------------------------------------------------------ the server
const base = mkdtempSync(join(tmpdir(), "omni-remote-"));
mkdirSync(join(base, "pi-sessions"), { recursive: true });
mkdirSync(join(base, "claude-projects"), { recursive: true });
const work = join(base, "work");
mkdirSync(work, { recursive: true });
const remoteAuth = new RemoteAuth({ file: join(base, "remote-auth.json"), failDelayMs: 0 });
const app = await createApp({ port: 0, lan: true, relay: { host: "" }, remotePort: 0, remoteHost: "127.0.0.1", remoteTls: false, remoteAuth, remoteApprovalTimeoutSec: 5, vaultDir: join(base, "vault"), piSessionsDir: join(base, "pi-sessions"), claudeProjectsDir: join(base, "claude-projects"), autoStartPi: false, cwd: work, liveWindowMs: 0, persistHook: false, persistPiModel: false, hook: { enabled: false } });
await app.listen();
after(() => app.close());
const hostUrl = `http://127.0.0.1:${app.server.address().port}`;
const remoteUrl = `http://127.0.0.1:${app.remote.port}`;
let cookie = "";
let deviceCookie = "";
const remoteFetch = (path, opts = {}) => fetch(`${remoteUrl}${path}`, { ...opts, headers: { ...(opts.headers || {}), ...(cookie ? { cookie } : {}) } });
const json = { "content-type": "application/json" };

test("remote: signed out, it gets the login page and 401s; the host's password route is host-only", async () => {
  const page = await fetch(`${remoteUrl}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Enter the password set on the host/);
  const st = await fetch(`${remoteUrl}/api/state`);
  assert.equal(st.status, 401);
  assert.equal((await st.json()).login, true);
  assert.equal((await fetch(`${remoteUrl}/events`)).status, 401);
  const noPw = await fetch(`${remoteUrl}/api/remote/login`, { method: "POST", headers: json, body: JSON.stringify({ password: "x" }) });
  assert.equal(noPw.status, 503, "no password set yet");
  const set = await fetch(`${hostUrl}/api/remote/password`, { method: "POST", headers: json, body: JSON.stringify({ password: "correct horse" }) });
  assert.equal(set.status, 200);
  assert.equal((await set.json()).hasPassword, true);
  const bad = await fetch(`${remoteUrl}/api/remote/login`, { method: "POST", headers: json, body: JSON.stringify({ password: "wrong" }) });
  assert.equal(bad.status, 401);
  // The right password from a new device still waits for the host.
  const pending = fetch(`${remoteUrl}/api/remote/login`, { method: "POST", headers: json, body: JSON.stringify({ password: "correct horse" }) });
  const [a] = await waitPending();
  assert.equal(a.kind, "signin");
  assert.equal(a.title, "Sign in from a new device");
  assert.equal((await fetch(`${hostUrl}/api/remote/approvals/${a.id}`, { method: "POST", headers: json, body: JSON.stringify({ approve: true }) })).status, 200);
  const ok = await pending;
  assert.equal(ok.status, 200);
  const set2 = ok.headers.getSetCookie();
  const sess = set2.find((c) => c.startsWith("omni_remote="));
  const dev = set2.find((c) => c.startsWith("omni_device="));
  assert.match(sess, /HttpOnly/);
  assert.match(sess, /SameSite=Strict/);
  assert.match(dev, /Path=\/api\/remote\/login/, "the device token only travels to the sign-in route");
  cookie = sess.split(";")[0];
  deviceCookie = dev.split(";")[0];
});

test("remote: an approved device signs straight in; a denied or duplicate one is refused", async () => {
  const again = await fetch(`${remoteUrl}/api/remote/login`, { method: "POST", headers: { ...json, cookie: deviceCookie }, body: JSON.stringify({ password: "correct horse" }) });
  assert.equal(again.status, 200, "no approval needed the second time");
  assert.equal(app.approvals.list().length, 0);
  // A device token is worth nothing without the password.
  assert.equal((await fetch(`${remoteUrl}/api/remote/login`, { method: "POST", headers: { ...json, cookie: deviceCookie }, body: JSON.stringify({ password: "wrong" }) })).status, 401);
  // Another device: one waiting sign-in per address, and Deny refuses it.
  const p1 = fetch(`${remoteUrl}/api/remote/login`, { method: "POST", headers: json, body: JSON.stringify({ password: "correct horse" }) });
  const [a] = await waitPending();
  assert.equal((await fetch(`${remoteUrl}/api/remote/login`, { method: "POST", headers: json, body: JSON.stringify({ password: "correct horse" }) })).status, 429);
  await fetch(`${hostUrl}/api/remote/approvals/${a.id}`, { method: "POST", headers: json, body: JSON.stringify({ approve: false }) });
  const r1 = await p1;
  assert.equal(r1.status, 403);
  assert.match((await r1.json()).error, /declined this device/);
  const st = await (await fetch(`${hostUrl}/api/remote/status`)).json();
  assert.equal(st.devices.length, 1);
  assert.equal(st.deviceApproval, true);
});

test("remote: oversized bodies are refused before sign-in, and every answer carries the anti-framing headers", async () => {
  const big = await fetch(`${remoteUrl}/api/remote/login`, { method: "POST", headers: json, body: JSON.stringify({ password: "x".repeat(20_000) }) }).catch((e) => ({ status: "reset", e }));
  assert.ok(big.status === 413 || big.status === "reset", `got ${big.status}`);
  const page = await fetch(`${remoteUrl}/`);
  assert.equal(page.headers.get("x-frame-options"), "DENY");
  assert.equal(page.headers.get("content-security-policy"), "frame-ancestors 'none'");
  assert.equal(page.headers.get("x-content-type-options"), "nosniff");
});

test("remote: signed in, it reads freely and sees itself as remote; host controls are refused", async () => {
  const st = await remoteFetch("/api/state");
  assert.equal(st.status, 200);
  const j = await st.json();
  assert.equal(j.access.role, "remote");
  assert.equal(j.access.remote, undefined, "the remote status is the host's business");
  assert.equal((await (await remoteFetch("/api/remote/me")).json()).role, "remote");
  assert.equal((await remoteFetch("/app.js")).status, 200);
  assert.equal((await remoteFetch("/api/remote/status")).status, 403);
  assert.equal((await remoteFetch("/api/remote/password", { method: "POST", headers: json, body: JSON.stringify({ password: "taken over" }) })).status, 403);
  assert.equal((await remoteFetch("/api/shutdown", { method: "POST", headers: json, body: "{}" })).status, 403);
  // The host's own window still sees everything.
  const hj = await (await fetch(`${hostUrl}/api/state`)).json();
  assert.equal(hj.access.role, "host");
  assert.equal(hj.access.remote.listening, true);
  assert.ok(hj.access.remote.sessions.length >= 1);
});

test("remote: the file browser stays inside Omni's folders", async () => {
  assert.equal((await remoteFetch(`/api/fs/list?root=${encodeURIComponent(work)}`)).status, 200);
  assert.equal((await remoteFetch(`/api/fs/list?root=${encodeURIComponent(base)}`)).status, 403);
  assert.equal((await remoteFetch(`/api/fs/read?root=${encodeURIComponent(tmpdir())}&path=x`)).status, 403);
  assert.equal((await fetch(`${hostUrl}/api/fs/list?root=${encodeURIComponent(base)}`)).status, 200, "the host browses anywhere");
});

async function waitPending(n = 1) {
  for (let i = 0; i < 100 && app.approvals.list().length < n; i++) await sleep(20);
  return app.approvals.list();
}

test("remote: a change waits for the host; Approve runs it", async () => {
  const pending = remoteFetch("/api/memory/save", { method: "POST", headers: json, body: JSON.stringify({ name: "remote fact", description: "from the phone", type: "project", body: "It works." }) });
  const [a] = await waitPending();
  assert.equal(a.title, "Save a memory: remote fact");
  assert.equal(a.ip, "127.0.0.1");
  const r = await fetch(`${hostUrl}/api/remote/approvals/${a.id}`, { method: "POST", headers: json, body: JSON.stringify({ approve: true }) });
  assert.equal(r.status, 200);
  const res = await pending;
  assert.equal(res.status, 200);
  const hits = await (await fetch(`${hostUrl}/api/memory/search?q=remote%20fact`)).json();
  assert.ok(hits.hits.length >= 1, "the approved change happened");
});

test("remote: Deny refuses it and nothing changes; a remote browser cannot approve itself", async () => {
  const pending = remoteFetch("/api/pi/model", { method: "POST", headers: json, body: JSON.stringify({ provider: "evil", modelId: "m" }) });
  const [a] = await waitPending();
  assert.match(a.title, /evil\/m/);
  assert.equal((await remoteFetch(`/api/remote/approvals/${a.id}`, { method: "POST", headers: json, body: JSON.stringify({ approve: true }) })).status, 403);
  await fetch(`${hostUrl}/api/remote/approvals/${a.id}`, { method: "POST", headers: json, body: JSON.stringify({ approve: false }) });
  const res = await pending;
  assert.equal(res.status, 403);
  assert.equal((await res.json()).approval, "denied");
  assert.notEqual(app.cfg.piProvider, "evil");
});

test("remote: only the host's event stream hears about approvals", async () => {
  const ctl = new AbortController();
  const r = await fetch(`${hostUrl}/events`, { signal: ctl.signal });
  const reader = r.body.getReader();
  const pending = remoteFetch("/api/hook", { method: "PUT", headers: json, body: JSON.stringify({ enabled: false }) });
  let text = "";
  const until = Date.now() + 3000;
  while (!/event: approvals\ndata: \[\{/.test(text) && Date.now() < until) text += new TextDecoder().decode((await reader.read()).value);
  assert.match(text, /event: approvals\ndata: \[\{.*Change the goal-hook settings/);
  ctl.abort();
  const rctl = new AbortController();
  const rr = await remoteFetch("/events", { signal: rctl.signal });
  const rt = new TextDecoder().decode((await rr.body.getReader().read()).value);
  assert.ok(!rt.includes("event: approvals"), "remote streams never carry approvals");
  rctl.abort();
  app.approvals.decide(app.approvals.list()[0].id, false);
  await pending;
});

test("local listener: a loopback request naming another Host is treated as remote (DNS rebinding)", async () => {
  const port = app.server.address().port;
  const status = await new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path: "/api/state", headers: { host: `attacker.example:${port}` } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on("error", reject);
    req.end();
  });
  assert.equal(status, 401);
});

test("signing out ends the remote session; changing the password signs everyone out", async () => {
  await remoteFetch("/api/remote/logout", { method: "POST", headers: json, body: "{}" });
  assert.equal((await remoteFetch("/api/state")).status, 401);
  const ok = await fetch(`${remoteUrl}/api/remote/login`, { method: "POST", headers: { ...json, cookie: deviceCookie }, body: JSON.stringify({ password: "correct horse" }) });
  cookie = ok.headers.getSetCookie().find((c) => c.startsWith("omni_remote=")).split(";")[0];
  assert.equal((await remoteFetch("/api/state")).status, 200);
  await fetch(`${hostUrl}/api/remote/password`, { method: "POST", headers: json, body: JSON.stringify({ password: "a new password" }) });
  assert.equal((await remoteFetch("/api/state")).status, 401);
  assert.ok(existsSync(join(base, "remote-auth.json")));
});

test("removing an approved device signs everyone out and makes it ask again", async () => {
  const ok = await fetch(`${remoteUrl}/api/remote/login`, { method: "POST", headers: { ...json, cookie: deviceCookie }, body: JSON.stringify({ password: "a new password" }) });
  assert.equal(ok.status, 200, "devices survive a password change");
  cookie = ok.headers.getSetCookie().find((c) => c.startsWith("omni_remote=")).split(";")[0];
  const [d] = (await (await fetch(`${hostUrl}/api/remote/status`)).json()).devices;
  assert.equal((await remoteFetch(`/api/remote/devices/${d.id}`, { method: "DELETE" })).status, 403, "not from a remote browser");
  const r = await (await fetch(`${hostUrl}/api/remote/devices/${d.id}`, { method: "DELETE" })).json();
  assert.equal(r.removed, 1);
  assert.equal((await remoteFetch("/api/state")).status, 401);
  const p = fetch(`${remoteUrl}/api/remote/login`, { method: "POST", headers: { ...json, cookie: deviceCookie }, body: JSON.stringify({ password: "a new password" }) });
  const [a] = await waitPending();
  assert.equal(a.kind, "signin");
  app.approvals.decide(a.id, false);
  assert.equal((await p).status, 403);
});

// ------------------------------------------------------------------------- the VPS relay path
test("parseProxyLine accepts only well-formed v1 lines with real addresses", () => {
  assert.equal(parseProxyLine("PROXY TCP4 9.8.7.6 10.0.0.1 51234 4443"), "9.8.7.6");
  assert.equal(parseProxyLine("PROXY TCP6 2001:db8::1 2001:db8::2 51234 4443"), "2001:db8::1");
  assert.equal(parseProxyLine("PROXY TCP4 2001:db8::1 10.0.0.1 1 2"), null);
  assert.equal(parseProxyLine("PROXY UNKNOWN"), null);
  assert.equal(parseProxyLine("GET / HTTP/1.1"), null);
  assert.equal(parseProxyLine("PROXY TCP4 999.1.1.1 10.0.0.1 1 2"), null);
});

test("sshArgs: pinned host key, batch mode, one loopback remote forward", () => {
  const a = sshArgs({ host: "72.62.59.232", user: "omni-tunnel", key: "k", knownHosts: "kh", remotePort: 14443, localPort: 4444 });
  assert.ok(a.includes("StrictHostKeyChecking=yes") && a.includes("BatchMode=yes") && a.includes("UserKnownHostsFile=kh") && a.includes("ExitOnForwardFailure=yes"));
  assert.equal(a[a.indexOf("-R") + 1], "127.0.0.1:14443:127.0.0.1:4444");
  assert.equal(a.at(-1), "omni-tunnel@72.62.59.232");
  assert.ok(!a.includes("-L") && !a.includes("-D"));
});

test("SshTunnel: up on the forward's success line, reconnects after an exit, stops for good on stop()", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omni-tun-"));
  writeFileSync(join(dir, "k"), "x"); writeFileSync(join(dir, "kh"), "x");
  const procs = [];
  const spawnFn = () => { const p = new EventEmitter(); p.stderr = new PassThrough(); p.kill = () => p.emit("exit", 0); procs.push(p); return p; };
  const t = new SshTunnel({ host: "h", key: join(dir, "k"), knownHosts: join(dir, "kh"), localPort: 1, spawn: spawnFn, minBackoffMs: 10 });
  t.start();
  assert.equal(t.status().state, "connecting");
  procs[0].stderr.write("debug1: remote forward success for: listen 127.0.0.1:14443, connect 127.0.0.1:1\n");
  await sleep(5);
  assert.equal(t.status().state, "up");
  procs[0].stderr.write("Connection timed out during banner exchange\n");
  procs[0].emit("exit", 255);
  assert.equal(t.status().state, "down");
  assert.match(t.status().lastError, /Connection timed out/);
  await sleep(40);
  assert.equal(procs.length, 2, "it dialled again");
  t.stop();
  await sleep(40);
  assert.equal(procs.length, 2);
  assert.equal(t.status().state, "off");
  const missing = new SshTunnel({ host: "h", key: join(dir, "nope"), knownHosts: join(dir, "kh"), localPort: 1, spawn: spawnFn });
  missing.start();
  assert.match(missing.status().lastError, /no SSH key/);
});

test("SshTunnel: a failed spawn (an 'error' with no 'exit', as Node reports it) still dials again", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omni-tun-"));
  writeFileSync(join(dir, "k"), "x"); writeFileSync(join(dir, "kh"), "x");
  const procs = [];
  const spawnFn = () => { const p = new EventEmitter(); p.stderr = new PassThrough(); p.kill = () => {}; procs.push(p); return p; };
  const t = new SshTunnel({ host: "h", key: join(dir, "k"), knownHosts: join(dir, "kh"), localPort: 1, spawn: spawnFn, minBackoffMs: 10 });
  t.start();
  procs[0].emit("error", Object.assign(new Error("spawn EAGAIN"), { code: "EAGAIN" }));
  procs[0].emit("close", -11);
  assert.equal(t.status().state, "down");
  assert.match(t.status().lastError, /EAGAIN/);
  await sleep(40);
  assert.equal(procs.length, 2, "it dialled again");
  procs[1].emit("exit", 255);
  procs[1].emit("close", 255);
  await sleep(40);
  assert.equal(procs.length, 3, "one exit, one retry: an exit and a close are not two failures");
  t.stop();
});

test("relay listener: loopback only, HTTPS only, needs the PROXY line, and the visitor's address reaches the host", { skip: !loadOrCreateCert({ dir: join(base, "tls-probe") }).cert && "no openssl" }, async () => {
  const rauth = new RemoteAuth({ failDelayMs: 0 });
  await rauth.setPassword("relay password!");
  const rapp = await createApp({ port: 0, lan: false, relay: { host: "relay.example", localPort: 0, publicPort: 4443 }, relayNoTunnel: true, tlsDir: join(base, "tls"), remoteAuth: rauth, remoteApprovalTimeoutSec: 5, vaultDir: join(base, "vault2"), piSessionsDir: join(base, "pi-sessions"), claudeProjectsDir: join(base, "claude-projects"), autoStartPi: false, cwd: work, liveWindowMs: 0, persistHook: false, persistPiModel: false, hook: { enabled: false } });
  await rapp.listen();
  try {
    assert.equal(rapp.relay.front.address().address, "127.0.0.1");
    const port = rapp.relay.port;
    const viaRelay = (proxyLine, path, body) => new Promise((resolve) => {
      const raw = netConnect(port, "127.0.0.1", () => {
        if (proxyLine) raw.write(proxyLine);
        const t = tlsConnect({ socket: raw, rejectUnauthorized: false }, () => {
          const payload = body ? JSON.stringify(body) : "";
          t.write(`${body ? "POST" : "GET"} ${path} HTTP/1.1\r\nHost: relay.example\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\nConnection: close\r\n\r\n${payload}`);
        });
        let out = "";
        t.on("data", (d) => { out += d; });
        t.on("end", () => resolve(out));
        t.on("error", () => resolve(out || "reset"));
      });
      raw.on("error", () => resolve("reset"));
    });
    assert.match(await viaRelay("PROXY TCP4 9.8.7.6 10.0.0.1 51234 4443\r\n", "/api/state"), /^HTTP\/1\.1 401/);
    assert.doesNotMatch(await viaRelay(null, "/api/state"), /HTTP/, "no PROXY line, no service");
    assert.doesNotMatch(await viaRelay("PROXY TCP4 garbage\r\n", "/api/state"), /HTTP/);
    const waiting = viaRelay("PROXY TCP4 9.8.7.6 10.0.0.1 51234 4443\r\n", "/api/remote/login", { password: "relay password!" });
    for (let i = 0; i < 100 && !rapp.approvals.list().length; i++) await sleep(20);
    const [a] = rapp.approvals.list();
    assert.equal(a.ip, "9.8.7.6", "the card names the real visitor, not the tunnel");
    rapp.approvals.decide(a.id, true);
    const res = await waiting;
    assert.match(res, /^HTTP\/1\.1 200/);
    assert.match(res, /omni_remote=[^;]+;[^\r\n]*Secure/, "cookies are Secure on the relay");
    // Lockout counts the visitor's address: five misses from 6.6.6.6 do not lock out 9.8.7.6.
    for (let i = 0; i < 5; i++) await viaRelay("PROXY TCP4 6.6.6.6 10.0.0.1 1 4443\r\n", "/api/remote/login", { password: "wrong" });
    assert.match(await viaRelay("PROXY TCP4 6.6.6.6 10.0.0.1 1 4443\r\n", "/api/remote/login", { password: "relay password!" }), /^HTTP\/1\.1 429/);
    const st = await (await fetch(`http://127.0.0.1:${rapp.server.address().port}/api/remote/status`)).json();
    assert.equal(st.relay.url, "https://relay.example:4443/");
    assert.equal(st.relay.listening, true);
  } finally { rapp.close(); }
});
