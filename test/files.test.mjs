import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEntry, decodeText, deleteEntry, duplicateEntry, encodeText, eolOf, listDir, readAsText, readFileInfo, readHex, renameEntry, safeResolve, serveRaw, writeText } from "../server/files.mjs";

const root = mkdtempSync(join(tmpdir(), "omni-files-"));
const put = (rel, data) => { const p = join(root, rel); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, data); return p; };
const bytes = (rel) => readFileSync(join(root, rel));

test("safeResolve keeps every path inside the root", () => {
  assert.ok(safeResolve(root, "a/b.txt"));
  assert.ok(safeResolve(root, "/a/b.txt"), "a leading slash is the root, not the disk");
  assert.equal(safeResolve(root, "../x"), null);
  assert.equal(safeResolve(root, "a/../../x"), null);
  if (process.platform === "win32") { assert.equal(safeResolve("C:\\x", "D:\\y"), null, "another drive"); assert.equal(safeResolve(root, "C:\\Windows"), null); }
  assert.equal(safeResolve(root, ".."), null);
});

test("decodeText tells text (and its encoding) from binary; encodeText writes the same bytes back", () => {
  const cases = [
    ["utf8", Buffer.from("héllo ✓\n", "utf8")],
    ["utf8bom", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("bom ✓", "utf8")])],
    ["utf16le", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("wide ✓\r\n", "utf16le")])],
    ["latin1", Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a])], // "café" in Latin-1: not UTF-8
  ];
  const be = Buffer.from("big ✓", "utf16le"); be.swap16();
  cases.push(["utf16be", Buffer.concat([Buffer.from([0xfe, 0xff]), be])]);
  for (const [enc, buf] of cases) {
    const t = decodeText(buf);
    assert.equal(t?.encoding, enc, enc);
    assert.deepEqual(encodeText(t.text, t.encoding), buf, `${enc} round-trips byte for byte`);
  }
  assert.equal(decodeText(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0, 0])), null, "an ELF header is binary");
  assert.equal(decodeText(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 65])), null, "mostly control characters is binary");
  assert.throws(() => encodeText("ā", "latin1"), /cannot be saved/);
});

test("eolOf finds the line ending and a mix", () => {
  assert.deepEqual(eolOf("a\nb\n"), { eol: "lf", mixed: false });
  assert.deepEqual(eolOf("a\r\nb\r\n"), { eol: "crlf", mixed: false });
  assert.deepEqual(eolOf("a\r\nb\r\nc\n"), { eol: "crlf", mixed: true });
});

test("readFileInfo: kinds, and what a save needs (encoding, eol, hash)", async () => {
  put("code.mjs", "export const a = 1;\r\n");
  put("noext", "plain\n");
  put("tool.lua", "print('x')\n");
  put("app.exe", Buffer.from([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0]));
  put("clip.mp4", Buffer.alloc(10));
  put("song.mp3", Buffer.alloc(10));
  put("doc.pdf", "%PDF-1.4");
  const t = await readFileInfo(root, "code.mjs");
  assert.equal(t.kind, "text"); assert.equal(t.encoding, "utf8"); assert.equal(t.eol, "crlf"); assert.match(t.hash, /^[0-9a-f]{24}$/);
  assert.equal((await readFileInfo(root, "noext")).kind, "text");
  assert.equal((await readFileInfo(root, "tool.lua")).kind, "text", "text is found by content, not a list of extensions");
  assert.equal((await readFileInfo(root, "app.exe")).kind, "binary");
  assert.equal((await readFileInfo(root, "clip.mp4")).kind, "video");
  assert.equal((await readFileInfo(root, "song.mp3")).kind, "audio");
  assert.equal((await readFileInfo(root, "doc.pdf")).kind, "pdf");
  await assert.rejects(readFileInfo(root, "../x"), /outside root/);
});

test("viewing a binary as text or hex never changes it; saving over a binary is refused", async () => {
  const exe = Buffer.from([0x4d, 0x5a, 0x90, 0, 0xff, 0xfe, 0x41, 0x0a, 0x80]);
  put("prog.bin", exe);
  const v = await readAsText(root, "prog.bin");
  assert.equal(v.readOnly, true); assert.equal(v.lossy, true); assert.match(v.content, /\uFFFD/);
  const l = await readAsText(root, "prog.bin", { encoding: "latin1" });
  assert.equal(Buffer.from(l.content, "latin1").equals(exe), true, "latin1 shows every byte");
  const h = await readHex(root, "prog.bin", 2, 4);
  assert.deepEqual(Buffer.from(h.data, "base64"), exe.subarray(2, 6)); assert.equal(h.size, exe.length);
  await assert.rejects(writeText(root, "prog.bin", { content: v.content }), (e) => e.status === 409 && e.binary);
  assert.deepEqual(bytes("prog.bin"), exe, "the bytes on disk are untouched");
});

test("writeText keeps the encoding and line ending, and refuses a file changed since it was read", async () => {
  put("win.txt", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("one\r\ntwo\r\n", "utf16le")]));
  const r = await readFileInfo(root, "win.txt");
  assert.equal(r.encoding, "utf16le"); assert.equal(r.eol, "crlf");
  // The editor (a textarea) hands back \n line breaks.
  const saved = await writeText(root, "win.txt", { content: "one\ntwo\nthree\n", encoding: r.encoding, eol: r.eol, baseHash: r.hash });
  assert.deepEqual(bytes("win.txt"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("one\r\ntwo\r\nthree\r\n", "utf16le")]));
  // Someone else (the agent) writes the file: a save from the old copy is refused, then forced.
  put("win.txt", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("agent\r\n", "utf16le")]));
  await assert.rejects(writeText(root, "win.txt", { content: "mine\n", encoding: "utf16le", eol: "crlf", baseHash: saved.hash }), (e) => e.status === 409 && e.conflict);
  await writeText(root, "win.txt", { content: "mine\n", encoding: "utf16le", eol: "crlf", baseHash: saved.hash, force: true });
  assert.equal(decodeText(bytes("win.txt")).text, "mine\r\n");
  // A file deleted since it was opened is not silently recreated.
  await assert.rejects(writeText(root, "gone.txt", { content: "x", baseHash: "abc" }), (e) => e.status === 409 && e.gone);
  await assert.rejects(writeText(root, "", { content: "x" }), /root folder/);
});

test("create, rename, duplicate and delete stay inside the root and never replace anything", async () => {
  await createEntry(root, "new/deep/file.txt");
  assert.ok(existsSync(join(root, "new/deep/file.txt")));
  await assert.rejects(createEntry(root, "new/deep/file.txt"), (e) => e.status === 409);
  await assert.rejects(createEntry(root, "bad:name"), /not a valid name/);
  await assert.rejects(createEntry(root, "../escape.txt"), /not a valid name|outside root/);
  await createEntry(root, "new/folder", { dir: true });
  put("keep.txt", "keep");
  await assert.rejects(renameEntry(root, "new/deep/file.txt", "keep.txt"), (e) => e.status === 409);
  assert.equal((await renameEntry(root, "new/deep/file.txt", "new/moved.txt")).path, "new/moved.txt");
  assert.equal((await renameEntry(root, "new/moved.txt", "new/Moved.txt")).path, "new/Moved.txt", "a case-only rename");
  await assert.rejects(renameEntry(root, "new", "new/folder/inner"), /into itself/);
  assert.equal((await duplicateEntry(root, "keep.txt")).path, "keep copy.txt");
  assert.equal((await duplicateEntry(root, "keep.txt")).path, "keep copy 2.txt");
  const trashed = [];
  assert.deepEqual(await deleteEntry(root, "keep copy.txt", { trash: async (p) => { trashed.push(p); writeFileSync(join(root, "keep copy.txt.gone"), ""); (await import("node:fs")).rmSync(p); } }), { ok: true, trashed: true });
  assert.equal(trashed.length, 1);
  await assert.rejects(deleteEntry(root, "keep copy 2.txt", { trash: async () => { throw new Error("no bin"); } }), (e) => e.trashFailed);
  assert.ok(existsSync(join(root, "keep copy 2.txt")), "a failed trash deletes nothing");
  assert.deepEqual(await deleteEntry(root, "keep copy 2.txt", { permanent: true }), { ok: true, permanent: true });
  await assert.rejects(deleteEntry(root, ""), /root folder/);
  const names = (await listDir(root, "")).map((e) => e.name);
  assert.ok(names.includes("new") && names.indexOf("new") < names.indexOf("keep.txt"), "folders first");
});

test("serveRaw: media inline with Range (Safari needs 206), anything as a download, sandboxed", async () => {
  put("v.mp4", Buffer.from("0123456789"));
  put("page.svg", "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>");
  put("data.bin", Buffer.from([1, 2, 3]));
  const srv = createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    serveRaw(req, res, root, u.searchParams.get("p"), { download: u.searchParams.get("d") === "1" }).catch((e) => { res.writeHead(e.status || 500); res.end(e.message); });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}/?p=`;
  try {
    const part = await fetch(`${base}v.mp4`, { headers: { range: "bytes=2-5" } });
    assert.equal(part.status, 206); assert.equal(part.headers.get("content-range"), "bytes 2-5/10"); assert.equal(await part.text(), "2345");
    const tail = await fetch(`${base}v.mp4`, { headers: { range: "bytes=-3" } });
    assert.equal(await tail.text(), "789");
    assert.equal((await fetch(`${base}v.mp4`, { headers: { range: "bytes=50-" } })).status, 416);
    const full = await fetch(`${base}v.mp4`);
    assert.equal(full.status, 200); assert.equal(full.headers.get("accept-ranges"), "bytes"); assert.equal(full.headers.get("content-type"), "video/mp4");
    const svg = await fetch(`${base}page.svg`);
    assert.match(svg.headers.get("content-security-policy"), /sandbox/);
    assert.equal((await fetch(`${base}data.bin`)).status, 404, "a non-media file only as a download");
    const dl = await fetch(`${base}data.bin&d=1`);
    assert.equal(dl.status, 200); assert.match(dl.headers.get("content-disposition"), /attachment; filename="data\.bin"/);
    assert.deepEqual(Buffer.from(await dl.arrayBuffer()), Buffer.from([1, 2, 3]));
  } finally { srv.close(); }
});
