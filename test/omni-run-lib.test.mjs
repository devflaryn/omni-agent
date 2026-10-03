// test/omni-run-lib.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderContextBlock, renderCompactionSummary, shouldOffload, offloadReference, sha256Hex, imageBlockData, extForMediaType } from "../integrations/pi/omni-run-lib.mjs";

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

test("extForMediaType maps known image types and falls back to bin", () => {
  assert.equal(extForMediaType("image/png"), "png");
  assert.equal(extForMediaType("image/jpeg"), "jpg");
  assert.equal(extForMediaType("image/webp"), "webp");
  assert.equal(extForMediaType("image/gif"), "gif");
  assert.equal(extForMediaType(""), "bin");
  assert.equal(extForMediaType("application/octet-stream"), "bin");
});

test("imageBlockData reads both flat and nested image shapes; ignores non-images", () => {
  assert.deepEqual(imageBlockData({ type: "image", data: "QUJD", mimeType: "image/png" }), { data: "QUJD", mediaType: "image/png" });
  assert.deepEqual(imageBlockData({ type: "image", source: { data: "QUJD", media_type: "image/jpeg" } }), { data: "QUJD", mediaType: "image/jpeg" });
  assert.equal(imageBlockData({ type: "text", text: "hi" }), null);
  assert.equal(imageBlockData({ type: "image" }), null);
  assert.equal(imageBlockData(null), null);
});

test("an oversized image base64 payload trips shouldOffload", () => {
  const big = "A".repeat(20000); // base64 of a ~15KB image, over the 12k cap
  assert.equal(shouldOffload(big), true);
  const img = imageBlockData({ type: "image", data: big, mimeType: "image/png" });
  assert.ok(img && shouldOffload(img.data));
});
