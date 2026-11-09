// ui/transport.js with a fake browser, and what every other UI file must do about it.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { api, cleanName, eventSource, isRemote, local, machine, machineName, machineTitle, mode, onStillWaiting, rawUrl, setChannelTransport, setMachine, setStillWaitingAfter, setTransportEnv } from "../ui/transport.js";
import { alertTitle, gateKey, linkNews } from "../ui/account.js";
import { esc, md } from "../ui/lib.js";

const ID = "a/b+c==";
const PREFIX = "/remote/a%2Fb%2Bc%3D%3D";

function fakeStorage(start = {}) {
  const data = new Map(Object.entries(start));
  return { data, getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)), removeItem: (k) => data.delete(k) };
}
const answer = (status, body) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

let calls, reloads, storage, realFetch, realES;
beforeEach(() => {
  calls = []; reloads = 0;
  storage = fakeStorage();
  realFetch = globalThis.fetch; realES = globalThis.EventSource;
  // As a real reload does: the page is built again from what is stored.
  const page = { storage, reload: () => { reloads++; setTransportEnv(page); } };
  setTransportEnv(page);
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); return answer(200, { ok: true }); };
  globalThis.EventSource = class { constructor(url) { this.url = url; } };
});
afterEach(() => { globalThis.fetch = realFetch; globalThis.EventSource = realES; });

test("local: no prefix, the same requests as ever", async () => {
  assert.equal(mode(), "local");
  assert.equal(machine(), null);
  assert.equal(isRemote(), false);
  assert.deepEqual(await api("GET", "/api/state"), { ok: true });
  await api("POST", "/api/x", { a: 1 });
  assert.equal(calls[0].url, "/api/state");
  assert.equal(calls[1].url, "/api/x");
  assert.equal(calls[1].options.body, '{"a":1}');
  assert.equal(new (function E(u) { return eventSource(u); })("/events?since=1").url, "/events?since=1");
  assert.equal(await rawUrl("/api/fs/raw?path=a"), "/api/fs/raw?path=a");
});

test("proxied: every request, stream and URL carries the machine, with the id encoded as one path segment", async () => {
  setMachine(ID, { name: "Ubuntu" });
  assert.equal(mode(), "proxied");
  await api("GET", "/api/state");
  assert.equal(calls[0].url, `${PREFIX}/api/state`);
  assert.equal(eventSource("/events?since=4").url, `${PREFIX}/events?since=4`);
  assert.equal(await rawUrl("/api/fs/raw?path=a%20b"), `${PREFIX}/api/fs/raw?path=a%20b`);
  assert.equal(machineName(), "Ubuntu");
});

test("this computer's own calls ignore the machine", async () => {
  setMachine(ID, { name: "Ubuntu" });
  await local.api("GET", "/api/account/status");
  assert.equal(calls[0].url, "/api/account/status");
  assert.equal(local.eventSource("/api/account/events").url, "/api/account/events");
});

test("setMachine moves the focus without a reload, and persists for this window only", () => {
  assert.equal(setMachine(ID, { name: "Ubuntu" }), true);
  assert.equal(reloads, 0, "the window keeps its drafts and its other machines");
  assert.deepEqual(JSON.parse(storage.data.get("omni.machine")), { id: ID, name: "Ubuntu" });

  // A page loaded again reads it back.
  const page = { storage, reload: () => { reloads++; setTransportEnv(page); } };
  setTransportEnv(page);
  assert.deepEqual(machine(), { id: ID, name: "Ubuntu" });
  assert.equal(mode(), "proxied");

  setMachine(ID, { name: "Ubuntu renamed" });
  assert.equal(machineName(), "Ubuntu renamed");

  setMachine(null);
  assert.equal(reloads, 0);
  assert.equal(storage.data.has("omni.machine"), false);
  assert.equal(mode(), "local");
});

test("nothing is stored where another window would read it", () => {
  const src = readFileSync(new URL("../ui/transport.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /localStorage/);
  assert.match(src, /sessionStorage/);
});

test("each machine keeps its own place in the app: nothing of one machine's is read as another's", () => {
  const app = readFileSync(new URL("../ui/app.js", import.meta.url), "utf8");
  assert.match(app, /newWorkspace\(\)/, "one workspace per machine");
  assert.doesNotMatch(app, /sessionStorage/, "app.js persists nothing of a machine");
});

test("a stored choice that cannot be read means this computer", () => {
  setTransportEnv({ storage: fakeStorage({ "omni.machine": "{not json" }), reload: () => {} });
  assert.equal(machine(), null);
  setTransportEnv({ storage: fakeStorage({ "omni.machine": JSON.stringify({ id: 5 }) }), reload: () => {} });
  assert.equal(machine(), null);
});

test("an error names the machine, carries the code, and a dropped answer never looks like success", async () => {
  setMachine(ID, { name: "Ubuntu" });
  globalThis.fetch = async () => answer(502, { error: "The connection to Ubuntu was lost", code: "machine-lost" });
  await assert.rejects(api("POST", "/api/x", {}), (e) => /Ubuntu/.test(e.message) && e.code === "machine-lost" && e.status === 502);

  globalThis.fetch = async () => { throw new TypeError("fetch failed"); };
  await assert.rejects(api("POST", "/api/x", {}), /Ubuntu/);

  // The head said 200 and then the body broke: fetch's text() rejects.
  globalThis.fetch = async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"ok":')); c.error(new Error("connection lost")); } }), { status: 200 });
  await assert.rejects(api("POST", "/api/x", {}), (e) => /Ubuntu/.test(e.message) && /may or may not/.test(e.message));

  // Cut off cleanly enough for text() to finish, but not JSON.
  globalThis.fetch = async () => answer(200, '{"ok":');
  await assert.rejects(api("POST", "/api/x", {}), /Ubuntu/);

  // A 401 from a far machine is not this window's sign-out: no reload loop.
  globalThis.fetch = async () => answer(401, { error: "signed out there", login: true });
  await assert.rejects(api("GET", "/api/x"), /signed out there/);
  assert.equal(reloads, 0, "nothing reloaded");
});

test("past the wait the window says so, once, and clears on the answer: good or bad", async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  setStillWaitingAfter(30);
  const heard = [];
  const off = onStillWaiting((n) => heard.push(n));
  let answer_;
  globalThis.fetch = () => new Promise((r) => { answer_ = r; });
  try {
    // On this computer nothing is said.
    const here = api("GET", "/a");
    await sleep(60);
    assert.deepEqual(heard, []);
    answer_(answer(200, {}));
    await here;

    setMachine(ID, { name: "Ubuntu" });
    const quick = api("GET", "/quick");
    answer_(answer(200, {}));
    await quick;
    await sleep(60);
    assert.deepEqual(heard, [], "an answer in time says nothing");

    const slow = api("POST", "/slow", {});
    await sleep(60);
    assert.deepEqual(heard, [1]);
    await sleep(60);
    assert.deepEqual(heard, [1], "once, not over and over");
    answer_(answer(200, { ok: true }));
    assert.deepEqual(await slow, { ok: true });
    assert.deepEqual(heard, [1, 0]);

    const failing = api("POST", "/slow", {});
    await sleep(60);
    answer_(answer(502, { error: "lost" }));
    await assert.rejects(failing);
    assert.deepEqual(heard, [1, 0, 1, 0]);
  } finally { off(); setStillWaitingAfter(30_000); }
});

test("an empty answer from a far machine is still an answer", async () => {
  setMachine(ID, { name: "Ubuntu" });
  globalThis.fetch = async () => new Response("", { status: 200 });
  assert.deepEqual(await api("POST", "/api/x", {}), {});
});

test("channel mode hands everything to the page's own channel (Task 8's seam)", async () => {
  setMachine(ID, { name: "Ubuntu" });
  const seen = [];
  setChannelTransport({
    api: async (...a) => { seen.push(a); return { from: "channel" }; },
    eventSource: (url) => ({ channel: url }),
    rawUrl: async (path) => `blob:${path}`,
  });
  assert.equal(mode(), "channel");
  assert.deepEqual(await api("GET", "/api/state"), { from: "channel" });
  assert.deepEqual(seen, [["GET", "/api/state", undefined]]);
  assert.deepEqual(eventSource("/events"), { channel: "/events" });
  assert.equal(await rawUrl("/api/fs/raw"), "blob:/api/fs/raw");
  assert.equal(calls.length, 0, "not one request through a server");
});

test("cleanName takes its fallback, so a missing kind is not an Unnamed device", () => {
  assert.equal(cleanName("", 32, "unknown"), "unknown");
  assert.doesNotMatch(read("account.js"), /cleanName\([\w.?]*kind, 32\)/);
});

test("cleanName: controls, direction marks and zero-width characters go; the text stays text", () => {
  assert.equal(cleanName(`Good${String.fromCodePoint(0x202e)}doog`), "Gooddoog");
  assert.equal(cleanName(`a${String.fromCodePoint(0x200b)}b${String.fromCodePoint(0x2066)}c${String.fromCodePoint(0x061c)}d`), "abcd");
  assert.equal(cleanName("line\nbreak\ttab\u0007"), "line break tab");
  assert.equal(cleanName(`x${String.fromCodePoint(0x2028)}y`), "x y");
  assert.equal(cleanName("<img src=x onerror=alert(1)>"), "<img src=x onerror=alert(1)>", "escaping is the DOM's job: it is shown with textContent");
  assert.equal(cleanName(""), "Unnamed device");
  assert.equal(cleanName(`${String.fromCodePoint(0x202e)}  `), "Unnamed device");
  assert.equal([...cleanName("x".repeat(500))].length, 64);
});

// ------------------------------------------------------------------------------- what the other files must do

const uiFiles = () => readdirSync(new URL("../ui/", import.meta.url)).filter((f) => f.endsWith(".js"));
const read = (f) => readFileSync(new URL(`../ui/${f}`, import.meta.url), "utf8");

test("every direct URL to a file's bytes goes through the one helper", () => {
  for (const f of uiFiles()) {
    for (const line of read(f).split(/\r?\n/)) {
      if (!line.includes("/api/fs/raw")) continue;
      assert.match(line, /(?:^|[^.\w])(?:rawUrl|saveFile)\(`\/api\/fs\/raw/, `${f} builds a raw URL by hand: ${line.trim()}`);
    }
    if (f !== "transport.js") assert.doesNotMatch(read(f), /(const|let|function)\s+rawUrl\b/, `${f} has its own rawUrl`);
  }
});

test("only transport.js calls fetch or opens an EventSource, so nothing can miss the machine", () => {
  for (const f of uiFiles()) {
    if (f === "transport.js") continue;
    // The service worker fetches the page's own files, from the server that served the page, and never acts on a machine.
    if (f === "sw.js") { assert.doesNotMatch(read(f), /\/api\/|\/remote\/|\/events/, "sw.js names nothing of a machine"); continue; }
    assert.doesNotMatch(read(f), /(^|[^.\w])fetch\(|\b(window|globalThis|self)\.fetch\(/m, `${f} calls fetch`);
    assert.doesNotMatch(read(f), /new\s+((window|globalThis|self)\.)?EventSource\(/, `${f} opens an EventSource`);
  }
});

test("a machine's stream takes chat events and its resync, and nothing of the old approval cards", () => {
  const app = read("app.js");
  assert.match(app, /on: \{ resync: \(msg\) => resyncMachine\(key, msg\.data\) \}/, "every machine's own stream");
  assert.match(app, /fromMerged\(/, "the other machines' merged stream goes through its filter");
  assert.doesNotMatch(app, /approvals|createRemote|\/api\/remote\//);
});

test("a banner does not say the same thing twice", () => {
  assert.equal(alertTitle({ kind: "hub-says-removed", message: "The hub says this device was removed from the account." }), "");
  assert.equal(alertTitle({ kind: "fork", message: "Two logs exist." }), "Two different device lists exist");
  assert.equal(alertTitle({ kind: "made-up", message: "x" }), "Security notice");
});

test("the stored code is only asked for again when something about it can have changed", () => {
  const base = { recoveryCodePending: true, recoveryContested: false, logHead: "a", alerts: [], hub: { attempts: 1, connected: true } };
  assert.equal(gateKey(base), gateKey({ ...base, alerts: [1], hub: { attempts: 9, connected: false } }), "news about something else asks nothing");
  assert.notEqual(gateKey(base), gateKey({ ...base, recoveryContested: true }));
  assert.notEqual(gateKey(base), gateKey({ ...base, recoveryCodePending: false }));
  assert.notEqual(gateKey(base), gateKey({ ...base, logHead: "b" }), "a code settles by a log being adopted");
});

test("the link's news: back up is said once, and only after it was down", () => {
  const up = { online: true, link: { state: "open" } };
  assert.deepEqual(linkNews(false, up, true), { down: false, reconnected: false });
  assert.equal(linkNews(false, { online: true, link: { state: "stalled" } }, true).down, true);
  assert.equal(linkNews(false, { online: false, link: { state: "offline" } }, true).down, true);
  assert.equal(linkNews(false, up, false).down, true, "no hub, no link");
  const idle = linkNews(true, { online: true, link: { state: "idle" } }, true);
  assert.deepEqual(idle, { down: true, reconnected: false }, "not back until a channel is open again");
  assert.deepEqual(linkNews(true, up, true), { down: false, reconnected: true });
});

test("account.js speaks to this computer only, and shows supplied text as text", () => {
  const src = read("account.js");
  assert.doesNotMatch(src, /\bapi as\b|from "\.\/transport\.js".*\bapi\b/, "the account is never sent to another machine");
  assert.doesNotMatch(src, /innerHTML|insertAdjacentHTML|outerHTML/);
  assert.match(src, /local\.api\(/);
});

test("the approval card: Deny at once, the role only from the person's tap, no approve without the code on screen", () => {
  const src = read("account.js");
  assert.match(src, /role: choice\.role/, "the role sent is the one on the button pressed");
  const reviewless = src.slice(src.indexOf("if (!review) {"), src.indexOf('c.appendChild(el("div", "acct-code", groupCode(review.code)));'));
  assert.ok(reviewless.length > 100);
  assert.doesNotMatch(reviewless, /"approve"/, "before the code is there, there is nothing to approve with");
});

test("HTML from a far machine cannot break out of an attribute in the shared helpers", () => {
  assert.equal(esc('"><script>'), "&quot;&gt;&lt;script&gt;");
  const out = md('[click](https://example.com/"onmouseover="alert(1))');
  assert.doesNotMatch(out, /href="[^"]*"onmouseover/, out);
  assert.doesNotMatch(md("<img src=x onerror=alert(1)>"), /<img/);
});
