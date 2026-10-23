// test/stream.test.mjs: the page's live event stream (ui/stream.js) over a flaky link.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createStream, retryDelay, STALE_MS } from "../ui/stream.js";

class FakeES {
  constructor(url) { this.url = url; this.closed = false; this.l = {}; FakeES.all.push(this); }
  addEventListener(n, f) { (this.l[n] ||= []).push(f); }
  fire(n, data = "1") { if (n === "message") this.onmessage?.({ data }); else for (const f of this.l[n] || []) f({ data }); }
  close() { this.closed = true; }
}
function rig() {
  FakeES.all = [];
  const clock = { t: 1_000_000 };
  const timers = {
    q: [], tick: null,
    setTimeout(f, ms) { const h = { f, ms }; timers.q.push(h); return h; },
    clearTimeout(h) { timers.q = timers.q.filter((x) => x !== h); },
    setInterval(f) { timers.tick = f; return 1; },
    clearInterval() { timers.tick = null; },
    run() { const h = timers.q.shift(); h?.f(); return h; },
  };
  const got = { msgs: [], up: 0, down: 0 };
  let seq = 0;
  const s = createStream({
    url: () => `/events?since=${seq}`,
    onMessage: (m) => { got.msgs.push(m.data); seq += 1; },
    onUp: () => got.up++, onDown: () => got.down++,
    EventSource: FakeES, now: () => clock.t, timers,
  });
  return { s, clock, timers, got, es: () => FakeES.all.at(-1) };
}

test("retryDelay: doubles per attempt with jitter, capped at 30 s", () => {
  assert.equal(retryDelay(0, () => 0), 500);
  assert.equal(retryDelay(0, () => 1), 1000);
  assert.equal(retryDelay(3, () => 1), 8000);
  assert.equal(retryDelay(12, () => 1), 30_000);
  assert.equal(retryDelay(12, () => 0), 15_000);
});

test("a dropped stream reconnects from the latest seq with growing delays, and calms down once it is back", () => {
  // It used to retry every 1.5 s flat: a 4-minute tunnel outage meant 40 tries a minute per tab, against the
  // relay's 120-a-minute per-address limit that every other request from that address shares.
  const { s, timers, got, es } = rig();
  s.start();
  assert.equal(es().url, "/events?since=0");
  es().onopen();
  es().fire("message", "{}");
  const first = es();
  first.onerror();
  assert.equal(first.closed, true);
  assert.equal(got.down, 1);
  assert.equal(timers.q.length, 1);
  assert.ok(timers.q[0].ms >= 500 && timers.q[0].ms <= 1000);
  first.onerror(); // a closed stream's late error must not queue a second reconnect
  assert.equal(timers.q.length, 1);
  timers.run();
  assert.equal(es().url, "/events?since=1", "it asks for what it missed");
  const delays = [];
  for (let i = 0; i < 8; i++) { es().onerror(); delays.push(timers.q[0].ms); timers.run(); }
  assert.ok(delays[0] >= 1000 && delays[0] <= 2000);
  assert.ok(delays.at(-1) >= 15_000 && delays.at(-1) <= 30_000, `capped: ${delays}`);
  es().onopen();
  assert.equal(got.up, 2);
  es().onerror();
  assert.ok(timers.q[0].ms <= 1000, "back to a short wait after a good connection");
});

test("a stream that goes silent is replaced, though the browser never reports an error", () => {
  const { s, clock, timers, es } = rig();
  s.start();
  const first = es();
  first.onopen();
  clock.t += 30_000;
  first.fire("ka");
  clock.t += STALE_MS - 10_000;
  timers.tick();
  assert.equal(first.closed, false, "a keepalive within the window keeps it");
  clock.t += 20_000;
  timers.tick();
  assert.equal(first.closed, true);
  timers.run();
  assert.notEqual(es(), first, "a new stream replaced the dead one");
});

test("poke (page visible again, network back) replaces a stale stream at once and leaves a live one alone", () => {
  const { s, clock, timers, es } = rig();
  s.start();
  const first = es();
  first.onopen();
  clock.t += 10_000;
  s.poke();
  assert.equal(es(), first);
  clock.t += 20_000; // a keepalive (every 20 s) was missed
  s.poke();
  assert.equal(first.closed, true);
  const second = es();
  assert.notEqual(second, first);
  second.onerror();
  assert.equal(timers.q.length, 1);
  s.poke(); // waiting out a backoff: try now instead
  assert.equal(timers.q.length, 0);
  assert.notEqual(es(), second);
});

test("named events reach their handlers and count as signs of life", () => {
  const { clock, timers, es } = rig();
  FakeES.all = [];
  const seen = [];
  const s = createStream({ url: () => "/e", onMessage() {}, on: { resync: (m) => seen.push(m.data) }, EventSource: FakeES, now: () => clock.t, timers });
  s.start();
  clock.t += STALE_MS - 1000;
  es().fire("resync", "{\"boot\":\"b\"}");
  clock.t += 5000;
  timers.tick();
  assert.deepEqual(seen, ["{\"boot\":\"b\"}"]);
  assert.equal(es().closed, false);
});
