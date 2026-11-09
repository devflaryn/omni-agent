// Copy works on plain http too (LAN access): no Clipboard API there, so the old copy command does it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { withFakeDom } from "./helpers/fake-dom.mjs";
import { copyText } from "../ui/lib.js";

test("copyText uses the Clipboard API where there is one", () => withFakeDom(async (doc) => {
  const got = [];
  await copyText("a", { clipboard: { writeText: async (t) => { got.push(t); } } });
  assert.deepEqual(got, ["a"]);
}));

test("without the Clipboard API (a non-secure origin), or when it refuses, copyText falls back to the copy command and keeps the focus", () => withFakeDom(async (doc) => {
  const field = doc.createElement("textarea");
  doc.body.appendChild(field);
  field.focus();
  const copied = [];
  doc.execCommand = (cmd) => { if (cmd === "copy") copied.push(doc.selected); return true; };
  await copyText("plain http", { clipboard: undefined });
  await copyText("refused", { clipboard: { writeText: async () => { throw new Error("NotAllowedError"); } } });
  assert.deepEqual(copied, ["plain http", "refused"]);
  assert.equal(doc.activeElement, field, "the focus is back where it was");
  assert.equal(doc.body.children.length, 1, "the helper textarea is gone");
  doc.execCommand = () => false;
  await assert.rejects(copyText("nowhere", { clipboard: undefined }), "a copy that did not happen says so");
}));

test("every Copy in the chat goes through copyText", () => {
  const src = readFileSync(new URL("../ui/transcript.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /navigator\.clipboard/);
  assert.equal(src.match(/copyText\(/g)?.length, 3, "code block, tool card, reply");
});
