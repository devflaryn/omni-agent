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
