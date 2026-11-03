// ui/transport.js with a fake browser, and what every other UI file must do about it.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { api, cleanName, eventSource, isRemote, local, machine, machineName, mode, rawUrl, setChannelTransport, setMachine, setTransportEnv } from "../ui/transport.js";
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
  setTransportEnv({ storage, reload: () => { reloads++; } });
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

test("setMachine starts the page over, and persists for this window only", () => {
  setMachine(ID, { name: "Ubuntu" });
  assert.equal(reloads, 1, "the reload is what clears the open chat, the state, and the stream's seq");
  assert.deepEqual(JSON.parse(storage.data.get("omni.machine")), { id: ID, name: "Ubuntu" });

  // The reloaded page reads it back.
  setTransportEnv({ storage, reload: () => { reloads++; } });
  assert.deepEqual(machine(), { id: ID, name: "Ubuntu" });
  assert.equal(mode(), "proxied");

  setMachine(ID, { name: "Ubuntu renamed" });
  assert.equal(reloads, 1, "the same machine again is not a switch");
  assert.equal(machineName(), "Ubuntu renamed");

  setMachine(null);
  assert.equal(reloads, 2);
  assert.equal(storage.data.has("omni.machine"), false);
  assert.equal(mode(), "local");
});

test("nothing is stored where another window would read it", () => {
  const src = readFileSync(new URL("../ui/transport.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /localStorage/);
  assert.match(src, /sessionStorage/);
});

test("the switch reloads the real page: the app itself keeps no last machine's state across it", () => {
  // What setMachine leaves to a reload must really be built from nothing: S starts empty and seq at 0 in app.js.
  const app = readFileSync(new URL("../ui/app.js", import.meta.url), "utf8");
  assert.match(app, /const S = \{ sessions: new Map\(\), selected: null,[^\n]*seq: 0,/);
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
  assert.equal(reloads, 1, "only the switch itself reloaded");
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
      assert.match(line, /(?:^|[^.\w])rawUrl\(`\/api\/fs\/raw/, `${f} builds a raw URL by hand: ${line.trim()}`);
    }
    if (f !== "transport.js") assert.doesNotMatch(read(f), /(const|let|function)\s+rawUrl\b/, `${f} has its own rawUrl`);
  }
});

test("only transport.js calls fetch or opens an EventSource, so nothing can miss the machine", () => {
  for (const f of uiFiles()) {
    if (f === "transport.js") continue;
    assert.doesNotMatch(read(f), /(^|[^.\w])fetch\(/m, `${f} calls fetch`);
    assert.doesNotMatch(read(f), /new (globalThis\.)?EventSource\(/, `${f} opens an EventSource`);
  }
});

test("account.js speaks to this computer only, and shows supplied text as text", () => {
  const src = read("account.js");
  assert.doesNotMatch(src, /\bapi as\b|from "\.\/transport\.js".*\bapi\b/, "the account is never sent to another machine");
  assert.doesNotMatch(src, /innerHTML|insertAdjacentHTML|outerHTML/);
  assert.match(src, /local\.api\(/);
});

test("the approval card: Deny at once, role full only by choice, no approve without the code step", () => {
  const src = read("account.js");
  assert.match(src, /role: box\.checked \? "full" : "client"/);
  assert.doesNotMatch(src, /box\.checked = true/, "never preselected");
  const reviewless = src.slice(src.indexOf("if (!review) {"), src.indexOf('el("div", "ap-title", "Does the new device show this code?")'));
  assert.doesNotMatch(reviewless, /"approve"/, "before the review there is nothing to approve with");
  assert.match(src, /This is my desktop or phone app/);
});

test("HTML from a far machine cannot break out of an attribute in the shared helpers", () => {
  assert.equal(esc('"><script>'), "&quot;&gt;&lt;script&gt;");
  const out = md('[click](https://example.com/"onmouseover="alert(1))');
  assert.doesNotMatch(out, /href="[^"]*"onmouseover/, out);
  assert.doesNotMatch(md("<img src=x onerror=alert(1)>"), /<img/);
});
