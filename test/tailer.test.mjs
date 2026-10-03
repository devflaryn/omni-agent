import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAppended, JsonlTail, readTail } from "../server/tailer.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("readTail returns only lines within the last maxBytes and skips the partial first line", async () => {
  const f = join(mkdtempSync(join(tmpdir(), "tail-")), "s.jsonl");
  const lines = [];
  for (let i = 0; i < 1000; i++) lines.push(JSON.stringify({ i, pad: "x".repeat(100) }));
  writeFileSync(f, lines.join("\n") + "\n");
  const { objects } = await readTail(f, { maxBytes: 5000 });
  assert.ok(objects.length > 0 && objects.length < 1000);
  assert.equal(objects.at(-1).i, 999);
  // the first returned object is a clean parse (no truncated line slipped through)
  assert.equal(typeof objects[0].i, "number");
});

test("readAppended returns new complete lines from an offset and keeps a partial tail", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omni-tail-"));
  const f = join(dir, "a.jsonl");
  writeFileSync(f, '{"n":1}\n{"n":2}\n{"n":3');
  const r1 = await readAppended(f, 0, "");
  assert.deepEqual(r1.objects, [{ n: 1 }, { n: 2 }]);
  assert.equal(r1.pending, '{"n":3');
  appendFileSync(f, '}\n{"n":4}\n');
  const r2 = await readAppended(f, r1.offset, r1.pending);
  assert.deepEqual(r2.objects, [{ n: 3 }, { n: 4 }]);
  assert.equal(r2.pending, "");
});

test("JsonlTail polls a file and emits appended objects", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omni-tail-"));
  const f = join(dir, "b.jsonl");
  writeFileSync(f, '{"n":1}\n');
  const got = [];
  const t = new JsonlTail(f, { fromEnd: true, intervalMs: 40, onObject: (o) => got.push(o) });
  await t.start();
  assert.equal(got.length, 0, "fromEnd skips existing content");
  appendFileSync(f, '{"n":2}\n{"n":3}\n');
  await sleep(200);
  t.stop();
  assert.deepEqual(got, [{ n: 2 }, { n: 3 }]);
});
