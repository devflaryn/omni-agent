// /remote/~events: every other machine's /events in one stream for the desktop window, so a browser's six connections per
// host are not spent one per machine. One slow or lost machine must not hold up the others, and a loss is named.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mergedEvents, MachineError } from "../server/channel-client.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A far machine's event stream that the test writes into. */
function farStream() {
  const queue = [];
  let wake = null, ended = false, failed = null;
  const body = {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (queue.length) yield queue.shift();
        if (failed) throw failed;
        if (ended) return;
        await new Promise((r) => { wake = r; });
      }
    },
  };
  const poke = () => { const w = wake; wake = null; w?.(); };
  return {
    response: { status: 200, headers: { "content-type": "text/event-stream" }, body, abort() { ended = true; poke(); } },
    send(text) { queue.push(Buffer.from(text)); poke(); },
    fail(error) { failed = error; poke(); },
  };
}

async function serve(links, options = {}) {
  const server = createServer((req, res) => mergedEvents(req, res, { links, send: (r, status, body) => { r.writeHead(status, { "content-type": "application/json" }); r.end(JSON.stringify(body)); }, retryMs: 30, kaMs: 60_000, ...options }));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, url: (list) => `http://127.0.0.1:${server.address().port}/remote/~events?m=${encodeURIComponent(JSON.stringify(list))}` };
}

/** Reads the merged stream into parsed {event, data} records. */
async function reader(url) {
  const stop = new AbortController();
  const r = await fetch(url, { signal: stop.signal });
  const got = [];
  (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of r.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let at;
        while ((at = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, at); buffer = buffer.slice(at + 2);
          let event = "message", data = "";
          for (const line of block.split("\n")) { if (line.startsWith("event: ")) event = line.slice(7); else if (line.startsWith("data: ")) data += line.slice(6); }
          if (data) got.push({ event, data: JSON.parse(data) });
        }
      }
    } catch { /* stopped */ }
  })();
  return { status: r.status, type: r.headers.get("content-type"), got, close: () => stop.abort() };
}

const until = async (fn, what, ms = 3000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error(`timed out: ${what}`); await sleep(10); } };

test("two machines in one stream, each event labelled with its machine; one silent machine holds nothing up", async () => {
  const fast = farStream();
  const asked = [];
  const links = {
    options: { slowReaderMs: 2000 },
    request(id, options) {
      asked.push([id, options.path]);
      if (id === "fast") return Promise.resolve(fast.response);
      return new Promise(() => {}); // never answers
    },
  };
  const { server, url } = await serve(links);
  const r = await reader(url([{ id: "fast", since: 7, boot: "b1" }, { id: "slow", since: 0, boot: "" }]));
  try {
    assert.equal(r.status, 200);
    assert.match(r.type, /text\/event-stream/);
    fast.send(`data: ${JSON.stringify({ kind: "session", sid: "s", seq: 8 })}\n\n`);
    await until(() => r.got.some((g) => g.event === "m"), "the fast machine's event");
    const m = r.got.find((g) => g.event === "m");
    assert.equal(m.data.id, "fast");
    assert.equal(m.data.name, "message");
    assert.deepEqual(JSON.parse(m.data.data), { kind: "session", sid: "s", seq: 8 });
    assert.ok(r.got.some((g) => g.event === "link" && g.data.id === "fast" && g.data.up === true));
    assert.deepEqual(asked.find((a) => a[0] === "fast"), ["fast", "/events?since=7&boot=b1"]);
    assert.deepEqual(asked.find((a) => a[0] === "slow"), ["slow", "/events?since=0"]);
  } finally { r.close(); server.close(); }
});

test("a machine that cannot be reached is named, the others keep going, and it is tried again from where it was", async () => {
  let tries = 0;
  const live = farStream();
  const streams = [];
  const links = {
    options: { slowReaderMs: 2000 },
    request(id, options) {
      if (id === "gone") { tries++; return Promise.reject(new MachineError(503, "machine-offline", "Laptop is offline. Nothing was sent to it.", { id, name: "Laptop" })); }
      const s = farStream();
      streams.push({ s, path: options.path });
      return Promise.resolve(s.response);
    },
  };
  const { server, url } = await serve(links);
  const r = await reader(url([{ id: "gone", since: 0, boot: "" }, { id: "ok", since: 0, boot: "" }]));
  try {
    await until(() => r.got.some((g) => g.event === "link" && g.data.id === "gone" && g.data.up === false), "the loss, named");
    const lost = r.got.find((g) => g.event === "link" && g.data.id === "gone");
    assert.match(lost.data.error, /Laptop is offline/);
    assert.equal(lost.data.code, "machine-offline");
    await until(() => tries >= 2, "tried again");
    await until(() => streams.length === 1, "the other machine's stream");
    streams[0].s.send(`data: ${JSON.stringify({ kind: "status", sid: "x", seq: 3 })}\n\n`);
    await until(() => r.got.some((g) => g.event === "m" && g.data.id === "ok"), "the other machine still flows");
    // Its stream drops: it is named, and the next try asks for what came after seq 3.
    streams[0].s.fail(new Error("the channel closed"));
    await until(() => r.got.some((g) => g.event === "link" && g.data.id === "ok" && g.data.up === false), "the drop, named");
    await until(() => streams.length === 2, "a new try");
    assert.equal(streams[1].path, "/events?since=3");
    void live;
  } finally { r.close(); server.close(); }
});

test("a resync from a far machine starts its count again under its new boot", async () => {
  const streams = [];
  const links = { options: { slowReaderMs: 2000 }, request(id, options) { const s = farStream(); streams.push({ s, path: options.path }); return Promise.resolve(s.response); } };
  const { server, url } = await serve(links);
  const r = await reader(url([{ id: "a", since: 50, boot: "old" }]));
  try {
    await until(() => streams.length === 1, "the stream");
    streams[0].s.send(`event: resync\ndata: ${JSON.stringify({ boot: "new", seq: 2 })}\n\ndata: ${JSON.stringify({ kind: "session", sid: "s", seq: 1 })}\n\n`);
    await until(() => r.got.filter((g) => g.event === "m").length === 2, "both");
    assert.equal(r.got.find((g) => g.event === "m").data.name, "resync");
    streams[0].s.fail(new Error("gone"));
    await until(() => streams.length === 2, "a new try");
    assert.equal(streams[1].path, "/events?since=1&boot=new");
  } finally { r.close(); server.close(); }
});

test("a list that is not one is refused, and so is one too long", async () => {
  const links = { options: { slowReaderMs: 2000 }, request: () => assert.fail("nothing asked") };
  const { server } = await serve(links);
  const base = `http://127.0.0.1:${server.address().port}/remote/~events`;
  try {
    for (const q of ["", "?m=not-json", `?m=${encodeURIComponent(JSON.stringify({ id: "x" }))}`, `?m=${encodeURIComponent(JSON.stringify([{ id: 5 }]))}`, `?m=${encodeURIComponent(JSON.stringify(Array.from({ length: 65 }, (_, i) => ({ id: `m${i}`, since: 0 }))))}`]) {
      const r = await fetch(`${base}${q}`);
      assert.equal(r.status, 400, q);
    }
  } finally { server.close(); }
});

test("when the window goes, every far stream is let go of", async () => {
  const aborted = [];
  const links = { options: { slowReaderMs: 2000 }, request(id, options) { options.signal.addEventListener("abort", () => aborted.push(id)); return Promise.resolve(farStream().response); } };
  const { server, url } = await serve(links);
  const r = await reader(url([{ id: "a", since: 0 }, { id: "b", since: 0 }]));
  await until(() => r.got.filter((g) => g.event === "link").length === 2, "both up");
  r.close();
  await until(() => aborted.length === 2, "both let go");
  server.close();
});
