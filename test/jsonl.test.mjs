import { test } from "node:test";
import assert from "node:assert/strict";
import { createLineSplitter, parseJsonLines } from "../server/jsonl.mjs";

test("splitter splits on LF only, strips CR, ignores blank lines, keeps partial tail", () => {
  const out = [];
  const s = createLineSplitter((line) => out.push(line));
  s.push('{"a":1}\r\n{"b":"x y"}\n\n{"c"');
  assert.deepEqual(out, ['{"a":1}', '{"b":"x y"}']);
  s.push(":3}\n");
  assert.deepEqual(out.at(-1), '{"c":3}');
  s.flush();
  assert.equal(out.length, 3);
});

test("parseJsonLines skips malformed lines", () => {
  const objs = parseJsonLines('{"a":1}\nnot json\n{"b":2}\n');
  assert.deepEqual(objs, [{ a: 1 }, { b: 2 }]);
});
