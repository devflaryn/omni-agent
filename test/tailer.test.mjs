import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAppended, JsonlTail } from "../server/tailer.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
