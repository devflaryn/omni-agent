// test/omni-run-lib.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderContextBlock, renderCompactionSummary, shouldOffload, offloadReference, sha256Hex, imageBlockData, extForMediaType, appendToNewest, summaryUsable } from "../integrations/pi/omni-run-lib.mjs";

test("appendToNewest copies only the newest user/toolResult/custom message and adds the text at its tail", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "go" }] },
    { role: "assistant", content: [{ type: "text", text: "ok" }] },
    { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "done" }] },
  ];
  const out = appendToNewest(messages, "<omni-run-goal>G</omni-run-goal>");
  assert.equal(out.length, 3);
  assert.equal(out[0], messages[0]);
  assert.equal(out[1], messages[1]);
  assert.deepEqual(out[2], { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "done" }, { type: "text", text: "\n<omni-run-goal>G</omni-run-goal>" }] });
  assert.equal(messages[2].content.length, 1, "the input is not mutated");
  assert.ok(!out.some((m) => m.role === "system"), "no system message (pi's convertToLlm drops them)");
  assert.deepEqual(appendToNewest([{ role: "user", content: "hi" }], "X")[0].content, [{ type: "text", text: "hi" }, { type: "text", text: "\nX" }]);
  // A background agent's report (pi sends a custom message to the model as a user message).
  const report = { role: "custom", customType: "omni-agent-result", content: "agent a1 finished", display: true, timestamp: 4 };
  assert.deepEqual(appendToNewest([...messages, report], "X")[3], { ...report, content: [{ type: "text", text: "agent a1 finished" }, { type: "text", text: "\nX" }] });
  assert.equal(report.content, "agent a1 finished", "the input is not mutated");
  assert.equal(appendToNewest(messages.slice(0, 2), "X"), null, "not after an assistant message");
  assert.equal(appendToNewest([], "X"), null);
  assert.equal(appendToNewest(undefined, "X"), null);
  assert.equal(appendToNewest(messages, ""), null);
});

test("summaryUsable rejects cut-off, failed, aborted and tool-calling summary answers", () => {
  assert.equal(summaryUsable({ stopReason: "stop", content: [{ type: "text", text: "ledger" }] }), true);
  for (const stopReason of ["length", "error", "aborted"]) assert.equal(summaryUsable({ stopReason, content: [{ type: "text", text: "partial" }] }), false, stopReason);
  assert.equal(summaryUsable({ stopReason: "toolUse", content: [{ type: "toolCall", name: "bash", arguments: {} }] }), false);
  assert.equal(summaryUsable(null), false);
});

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
