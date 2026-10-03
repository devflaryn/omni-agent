// test/omni-run-lib.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderContextBlock, renderCompactionSummary, shouldOffload, offloadReference, sha256Hex } from "../integrations/pi/omni-run-lib.mjs";

test("context block keeps the goal verbatim and fits the budget", () => {
  const ledgerMd = "## Critical facts\n" + "fact ".repeat(5000) + "\n## Next steps\nstep";
  const out = renderContextBlock({ goal: "EXACT GOAL", ledgerMd }, { budget: 500 });
  assert.ok(out.includes("EXACT GOAL"));
  assert.ok(out.length <= 500 + 200); // goal + budgeted slice, small overhead
});

test("compaction summary never exceeds its budget regardless of input size", () => {
  const big = "x".repeat(200000);
  const out = renderCompactionSummary({ goal: "g", ledgerMd: "## Next steps\n" + big, serializedSpan: big }, { budget: 3000 });
  assert.ok(out.length <= 3000);
  assert.ok(out.includes("g"));
});

test("shouldOffload triggers only past the cap; reference is short and cites the path", () => {
  assert.equal(shouldOffload("x".repeat(100), { maxChars: 500 }), false);
  assert.equal(shouldOffload("x".repeat(1000), { maxChars: 500 }), true);
  const ref = offloadReference({ sha: "abc123", bytes: 1048576, preview: "ELF…", path: "artifacts/abc123.bin" });
  assert.ok(ref.includes("artifacts/abc123.bin"));
  assert.ok(ref.length < 1000);
});

test("sha256Hex is stable", () => {
  assert.equal(sha256Hex("a"), sha256Hex("a"));
  assert.notEqual(sha256Hex("a"), sha256Hex("b"));
});
