import { test } from "node:test";
import assert from "node:assert/strict";
import { buildZip } from "./helpers/zip-fixture.mjs";
import { listZipEntries, readZipEntry, isArchiveName } from "../server/zip.mjs";

test("listZipEntries walks the central directory (stored, deflated, directory, EOCD comment)", () => {
  const zip = buildZip([
    { name: "AndroidManifest.xml", data: "<manifest/>" },
    { name: "res/", data: "" },
    { name: "res/values/strings.xml", data: "<resources>".repeat(20), deflate: true },
  ], { comment: "built by test" });
  const entries = listZipEntries(zip);
  assert.deepEqual(entries.map((e) => e.path), ["AndroidManifest.xml", "res/", "res/values/strings.xml"]);
  assert.equal(entries[0].size, 11); assert.equal(entries[0].method, 0); assert.equal(entries[0].dir, false);
  assert.equal(entries[1].dir, true);
  assert.equal(entries[2].method, 8); assert.equal(entries[2].size, 220); assert.ok(entries[2].compressed < 220);
});

test("readZipEntry inflates deflated entries and returns stored ones as-is", () => {
  const zip = buildZip([{ name: "a.txt", data: "hello" }, { name: "b.txt", data: "world ".repeat(50), deflate: true }]);
  const [a, b] = listZipEntries(zip);
  assert.equal(readZipEntry(zip, a).toString("utf8"), "hello");
  assert.equal(readZipEntry(zip, b).toString("utf8"), "world ".repeat(50));
});

test("readZipEntry refuses unknown compression methods", () => {
  const zip = buildZip([{ name: "a.txt", data: "hello" }]);
  const [a] = listZipEntries(zip);
  assert.throws(() => readZipEntry(zip, { ...a, method: 12 }), /method 12/);
});

test("listZipEntries rejects non-zip data and ZIP64 archives", () => {
  assert.throws(() => listZipEntries(Buffer.from("not a zip at all, definitely not")), /not a zip/i);
  const zip = buildZip([{ name: "a.txt", data: "x" }]);
  const eocdAt = zip.length - 22;
  zip.writeUInt16LE(0xffff, eocdAt + 8); // entry count marker → zip64
  assert.throws(() => listZipEntries(zip), /zip64/i);
});

test("isArchiveName recognizes zip-like extensions", () => {
  for (const n of ["a.zip", "b.APK", "c.jar", "d.aar", "e.xapk", "f.apks"]) assert.equal(isArchiveName(n), true, n);
  for (const n of ["a.txt", "b.png", "c", "d.tar.gz"]) assert.equal(isArchiveName(n), false, n);
});
