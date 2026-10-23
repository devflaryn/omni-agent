// test/bus.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { Bus } from "../server/bus.mjs";

test("a client whose write buffer is over the cap is dropped, not buffered forever", () => {
  const bus = new Bus();
  const slow = { writableLength: 5 * 1024 * 1024, write() { return false; } };
  bus.addClient(slow);
  bus.emit({ kind: "x", ts: 1 });
  assert.equal(bus.clients.has(slow), false);
});

const sink = () => { const out = []; return { out, writableLength: 0, write(s) { out.push(s); return true; } }; };
const sent = (r) => r.out.filter((s) => s.startsWith("data: ")).map((s) => JSON.parse(s.slice(6)));

test("a fresh page's replay leaves out the chat messages its history fetch reads from the session file", () => {
  // Measured on the owner's server: 9.4 MB of the 4000-event ring was assistant/tool messages, sent to every
  // page load through the relay, and the 4 MB cap then cut that very stream on the next event.
  const bus = new Bus();
  const big = [{ type: "text", text: "x".repeat(10_000) }];
  bus.emit({ sid: "pi:a", kind: "msg", role: "assistant", blocks: big, usage: { input: 5 }, ts: 1 });
  bus.emit({ sid: "pi:a", kind: "msg", role: "tool", blocks: big, ts: 2 });
  bus.emit({ sid: "pi:a", kind: "msg", role: "user", blocks: big, ts: 3 });
  bus.emit({ sid: "pi:a", kind: "msg", role: "system", blocks: [{ type: "text", text: "agent report" }], ts: 4 });
  bus.emit({ sid: "pi:a", kind: "delta", delta: "par", ts: 5 });
  bus.emit({ sid: "pi:a", kind: "status", streaming: true, ts: 6 });
  const fresh = sink();
  bus.addClient(fresh, 0);
  assert.deepEqual(sent(fresh).map((e) => e.role || e.kind), ["system", "delta", "status"]);
  const back = sink();
  bus.addClient(back, 1, bus.boot);
  assert.equal(sent(back).length, 5, "a reconnect within one server run still gets every event it missed");
});

test("a reconnect that cannot be caught up is told to resync instead of silently missing events", () => {
  const bus = new Bus({ ring: 3 });
  for (let i = 0; i < 6; i++) bus.emit({ kind: "x", ts: i });
  const ok = sink();
  bus.addClient(ok, 3, bus.boot);
  assert.ok(!ok.out.some((s) => s.startsWith("event: resync")));
  assert.deepEqual(sent(ok).map((e) => e.seq), [4, 5, 6]);
  const gap = sink();
  bus.addClient(gap, 1, bus.boot); // 2 and 3 fell out of the ring
  assert.match(gap.out[0], /^event: resync\ndata: /);
  assert.deepEqual(JSON.parse(gap.out[0].split("data: ")[1]), { boot: bus.boot, seq: 6 });
  const restarted = sink();
  bus.addClient(restarted, 5, "an-earlier-run");
  assert.match(restarted.out[0], /^event: resync\n/);
  const ahead = sink();
  bus.addClient(ahead, 99); // a page from before a restart that predates `boot`: its seq is from the old run
  assert.match(ahead.out[0], /^event: resync\n/);
});
