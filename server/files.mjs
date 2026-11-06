/**
 * The file browser behind the explorer and its editor: listing, reading (with the file's encoding and line
 * endings found out so a save writes them back unchanged), saving, creating, renaming, duplicating, deleting
 * (to the system trash first), and serving a file's bytes (images, video and audio with Range requests, so
 * Safari plays them; any file as a download).
 *
 * Nothing here ever writes a file it read as anything but text: a save refuses a file that is not text in the
 * encoding it was opened with, and the "as text" and hex views of a binary are read-only and lossy-free on
 * disk (they never write). Every path is resolved inside a root and refused if it leaves it.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, promises as fs, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isArchiveName, listZipEntries, readZipEntry } from "./zip.mjs";

const fail = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });

export const TEXT_MAX = 2 * 1024 * 1024;
export const ARCHIVE_MAX = 400 * 1024 * 1024;
export const IMAGE_MAX = 20 * 1024 * 1024;
export const HEX_MAX = 64 * 1024;

export const IMAGE_MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".bmp": "image/bmp", ".ico": "image/x-icon", ".avif": "image/avif" };
export const VIDEO_MIME = { ".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".ogv": "video/ogg", ".mkv": "video/x-matroska" };
export const AUDIO_MIME = { ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".oga": "audio/ogg", ".opus": "audio/ogg", ".m4a": "audio/mp4", ".aac": "audio/aac", ".flac": "audio/flac" };
const MEDIA_MIME = { ...IMAGE_MIME, ...VIDEO_MIME, ...AUDIO_MIME, ".pdf": "application/pdf" };
const MARKDOWN = new Set([".md", ".markdown", ".mdx"]);

// ------------------------------------------------------------------ paths
/** `rel` inside `root`, absolute, or null when it would leave the root (`..`, another drive, an absolute path). */
export function safeResolve(root, rel) {
  const abs = resolve(root, String(rel || "").replace(/^[\\/]+/, "") || ".");
  const r = relative(resolve(root), abs);
  if (isAbsolute(r) || r === ".." || r.startsWith(`..${sep}`) || r.startsWith("../")) return null;
  return abs;
}
/** Whether `rel` is still inside `root` once links are followed, as far as the path exists. */
export async function staysInside(root, rel) {
  const abs = safeResolve(root, rel);
  if (!abs) return false;
  const realRoot = await fs.realpath(root).catch(() => resolve(root));
  for (let at = abs, tail = ""; ;) {
    let real = null;
    try { real = await fs.realpath(at); } catch { /* not there yet: the folder it would land in decides */ }
    if (real) {
      const r = relative(realRoot, join(real, tail));
      return !(isAbsolute(r) || r === ".." || r.startsWith(`..${sep}`));
    }
    const up = dirname(at);
    if (up === at) return false;
    tail = join(basename(at), tail);
    at = up;
  }
}
const inside = (root, rel) => { const abs = safeResolve(root, rel); if (!abs) throw fail(400, "path outside root"); return abs; };
/** Not the root itself: renaming or deleting the working directory from its own tree is never meant. */
const insideNotRoot = (root, rel) => { const abs = inside(root, rel); if (abs === resolve(root)) throw fail(400, "that is the root folder itself"); return abs; };
const relOf = (root, abs) => relative(resolve(root), abs).split(sep).join("/");
const exists = (p) => fs.lstat(p).then(() => true, () => false);
/** A name typed for a new file or a rename: one segment, nothing a filesystem refuses. */
function checkName(name) {
  const n = String(name || "");
  if (!n.trim() || n === "." || n === ".." || /[\\/:*?"<>|\0]/.test(n) || n.length > 255) throw fail(400, `“${n}” is not a valid name`);
  return n;
}
/** A target path (may contain folders, VS Code style "a/b/c.txt"), each segment checked. */
function checkRelPath(rel) {
  const parts = String(rel || "").split(/[\\/]+/).filter(Boolean);
  if (!parts.length) throw fail(400, "a name is needed");
  parts.forEach(checkName);
  return parts.join("/");
}

// ----------------------------------------------------------------- listing
export async function listDir(root, rel) {
  const abs = inside(root, rel);
  const entries = await fs.readdir(abs, { withFileTypes: true });
  return entries
    .filter((e) => e.name !== ".git")
    .map((e) => ({ name: e.name, dir: e.isDirectory() || (e.isSymbolicLink() && isDirSync(join(abs, e.name))), link: e.isSymbolicLink() || undefined, path: relOf(root, join(abs, e.name)) }))
    .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) : a.dir ? -1 : 1));
}
function isDirSync(p) { try { return statSync(p).isDirectory(); } catch { return false; } }

// ---------------------------------------------------------------- decoding
export const hashOf = (buf) => createHash("sha256").update(buf).digest("hex").slice(0, 24);

/** Bytes → { text, encoding } when they are text, else null. utf8 / utf8bom / utf16le / utf16be decode exactly;
 *  other bytes without NULs and few control characters are latin1, which maps each byte to one character and back. */
export function decodeText(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    try { return { text: new TextDecoder("utf-8", { fatal: true }).decode(buf.subarray(3)), encoding: "utf8bom" }; } catch { return null; }
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe && buf.length % 2 === 0) {
    try { return { text: new TextDecoder("utf-16le", { fatal: true }).decode(buf.subarray(2)), encoding: "utf16le" }; } catch { return null; }
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff && buf.length % 2 === 0) {
    try { return { text: new TextDecoder("utf-16be", { fatal: true }).decode(buf.subarray(2)), encoding: "utf16be" }; } catch { return null; }
  }
  if (looksBinary(buf)) return null;
  try { return { text: new TextDecoder("utf-8", { fatal: true }).decode(buf), encoding: "utf8" }; } catch { /* not UTF-8 */ }
  return { text: buf.toString("latin1"), encoding: "latin1" };
}
/** NULs, or many control characters other than tab/newline/CR/FF/ESC, in the first 8 KB. */
export function looksBinary(buf) {
  const head = buf.subarray(0, 8000);
  if (head.includes(0)) return true;
  let ctl = 0;
  for (const b of head) if (b < 32 && b !== 9 && b !== 10 && b !== 13 && b !== 12 && b !== 27 && b !== 11) ctl++;
  return head.length > 0 && ctl / head.length > 0.1;
}
export function encodeText(text, encoding) {
  switch (encoding) {
    case "utf8": return Buffer.from(text, "utf8");
    case "utf8bom": return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, "utf8")]);
    case "utf16le": return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
    case "utf16be": { const b = Buffer.from(text, "utf16le"); b.swap16(); return Buffer.concat([Buffer.from([0xfe, 0xff]), b]); }
    case "latin1": {
      // A character latin1 cannot hold would be written as a different byte: refuse rather than change it.
      for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 0xff) throw fail(400, `this file is not UTF-8 (opened as Latin-1), and “${text[i]}” cannot be saved in it`);
      return Buffer.from(text, "latin1");
    }
    default: throw fail(400, `unknown encoding ${encoding}`);
  }
}
/** "lf" | "crlf" | "cr" and whether the file mixes them (a save then writes the most common one throughout). */
export function eolOf(text) {
  let crlf = 0, lf = 0, cr = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 13) { if (text.charCodeAt(i + 1) === 10) { crlf++; i++; } else cr++; } else if (c === 10) lf++;
  }
  const kinds = [["lf", lf], ["crlf", crlf], ["cr", cr]].filter(([, n]) => n > 0);
  if (!kinds.length) return { eol: process.platform === "win32" ? "crlf" : "lf", mixed: false, none: true };
  kinds.sort((a, b) => b[1] - a[1]);
  return { eol: kinds[0][0], mixed: kinds.length > 1 };
}
const EOL = { lf: "\n", crlf: "\r\n", cr: "\r" };

// ----------------------------------------------------------------- reading
/** What the explorer needs to open a file: `kind` picks the viewer. A text file comes with what a save needs
 *  to write it back as it was: encoding, line ending, and a hash of the bytes (a save over a changed file is refused). */
export async function readFileInfo(root, rel) {
  const abs = inside(root, rel);
  const st = await fs.stat(abs);
  if (st.isDirectory()) throw fail(400, "that is a folder");
  const ext = extname(abs).toLowerCase(), size = st.size, mtimeMs = st.mtimeMs;
  const base = { ext, size, mtimeMs };
  if (IMAGE_MIME[ext]) return { kind: "image", ...base, mime: IMAGE_MIME[ext], tooBig: size > IMAGE_MAX };
  if (VIDEO_MIME[ext]) return { kind: "video", ...base, mime: VIDEO_MIME[ext] };
  if (AUDIO_MIME[ext]) return { kind: "audio", ...base, mime: AUDIO_MIME[ext] };
  if (ext === ".pdf") return { kind: "pdf", ...base, mime: "application/pdf" };
  if (isArchiveName(abs)) {
    if (size > ARCHIVE_MAX) return { kind: "archive", ...base, tooBig: true, entries: [] };
    const entries = listZipEntries(await fs.readFile(abs)).map(({ offset: _o, ...e }) => e);
    return { kind: "archive", ...base, entries };
  }
  if (size > TEXT_MAX) {
    // Too big to edit: say whether it looks like text, so the viewer offers the read-only text view first.
    const head = await readRange(abs, 0, 8000);
    return { kind: looksBinary(head) ? "binary" : "text", ...base, tooBig: true, readOnly: true };
  }
  const buf = await fs.readFile(abs);
  const t = decodeText(buf);
  if (!t) return { kind: "binary", ...base, binary: true };
  const { eol, mixed } = eolOf(t.text);
  return { kind: MARKDOWN.has(ext) ? "markdown" : "text", ...base, content: t.text, encoding: t.encoding, eol, eolMixed: mixed || undefined, hash: hashOf(buf) };
}

async function readRange(abs, offset, length) {
  const fh = await fs.open(abs, "r");
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, offset);
    return buf.subarray(0, bytesRead);
  } finally { await fh.close(); }
}

/** Any file shown as text, read-only: its first 2 MB decoded as UTF-8 (bytes that are not become U+FFFD) or Latin-1.
 *  Nothing is written, so the file on disk is never changed by looking at it. */
export async function readAsText(root, rel, { encoding = "utf8" } = {}) {
  const abs = inside(root, rel);
  const st = await fs.stat(abs);
  if (st.isDirectory()) throw fail(400, "that is a folder");
  const buf = await readRange(abs, 0, Math.min(st.size, TEXT_MAX));
  const content = encoding === "latin1" ? buf.toString("latin1") : new TextDecoder("utf-8").decode(buf);
  return { kind: "text", size: st.size, content, encoding, truncated: st.size > TEXT_MAX, readOnly: true, lossy: true };
}

/** A slice of the bytes for the hex view (base64), at most 64 KB at a time. */
export async function readHex(root, rel, offset = 0, length = HEX_MAX) {
  const abs = inside(root, rel);
  const st = await fs.stat(abs);
  if (st.isDirectory()) throw fail(400, "that is a folder");
  const off = Math.max(0, Math.min(Number(offset) || 0, st.size));
  const len = Math.max(0, Math.min(Number(length) || HEX_MAX, HEX_MAX, st.size - off));
  const buf = len ? await readRange(abs, off, len) : Buffer.alloc(0);
  return { offset: off, size: st.size, data: buf.toString("base64") };
}

export async function readArchiveEntry(root, rel, entryPath) {
  const abs = safeResolve(root, rel);
  if (!abs || !isArchiveName(abs)) throw fail(400, "not an archive");
  const buf = await fs.readFile(abs);
  const entry = listZipEntries(buf, { limit: Infinity }).find((e) => e.path === entryPath);
  if (!entry) throw fail(404, "no such entry in the archive");
  if (entry.dir) return { kind: "binary", path: entry.path, size: 0 };
  if (entry.size > TEXT_MAX) return { kind: "binary", path: entry.path, size: entry.size, tooBig: true };
  const data = readZipEntry(buf, entry);
  const ext = extname(entry.path).toLowerCase();
  if (IMAGE_MIME[ext]) return { kind: "image", path: entry.path, size: entry.size, mime: IMAGE_MIME[ext], data: data.toString("base64") };
  const t = decodeText(data);
  if (!t) return { kind: "binary", path: entry.path, size: entry.size, binary: true, data: data.subarray(0, HEX_MAX).toString("base64") };
  return { kind: MARKDOWN.has(ext) ? "markdown" : "text", path: entry.path, size: entry.size, content: t.text, encoding: t.encoding };
}

// ------------------------------------------------------------------ bytes
/** A file's bytes. Media inline (Range-aware: Safari will not play a video without it); anything else only as a
 *  download. Served sandboxed, so an SVG or HTML opened from here cannot run script as this page. */
export async function serveRaw(req, res, root, rel, { download = false } = {}) {
  const abs = inside(root, rel);
  const st = await fs.stat(abs).catch(() => null);
  if (!st || !st.isFile()) throw fail(404, "no such file");
  const ext = extname(abs).toLowerCase();
  const mime = MEDIA_MIME[ext];
  if (!mime && !download) throw fail(404, "not an image, video or audio file");
  const headers = {
    "Content-Type": download ? "application/octet-stream" : mime,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-cache",
    "Last-Modified": new Date(st.mtimeMs).toUTCString(),
  };
  // A PDF is shown in a frame of the file pane (the browser's own viewer, which a sandbox would block).
  if (ext === ".pdf" && !download) Object.assign(headers, { "X-Frame-Options": "SAMEORIGIN", "Content-Security-Policy": "frame-ancestors 'self'" });
  else headers["Content-Security-Policy"] = "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'; media-src 'self'";
  if (download) headers["Content-Disposition"] = `attachment; filename="${basename(abs).replace(/[^\x20-\x7e]|["\\]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(basename(abs))}`;
  let start = 0, end = st.size - 1, code = 200;
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ""));
  if (range && st.size > 0) {
    if (range[1] === "") { start = Math.max(0, st.size - Number(range[2])); } else { start = Number(range[1]); if (range[2] !== "") end = Math.min(end, Number(range[2])); }
    if (start > end || start >= st.size) { res.writeHead(416, { "Content-Range": `bytes */${st.size}` }); res.end(); return; }
    code = 206; headers["Content-Range"] = `bytes ${start}-${end}/${st.size}`;
  }
  headers["Content-Length"] = st.size ? end - start + 1 : 0;
  res.writeHead(code, headers);
  if (req.method === "HEAD" || !st.size) { res.end(); return; }
  const s = createReadStream(abs, { start, end });
  s.on("error", () => res.destroy());
  res.on("close", () => s.destroy());
  s.pipe(res);
}

// ----------------------------------------------------------------- writing
/** Save text the editor holds back to the file, in the encoding and line ending it was read with. `baseHash` is
 *  the hash it was read at: a file changed since (by the agent, say) is not overwritten unless `force`. */
export async function writeText(root, rel, { content, encoding = "utf8", eol = "lf", baseHash, force = false, create = false } = {}) {
  if (typeof content !== "string") throw fail(400, "content must be text");
  if (!EOL[eol]) throw fail(400, `unknown line ending ${eol}`);
  const abs = insideNotRoot(root, rel);
  let old = null;
  try { old = await fs.readFile(abs); } catch (e) { if (e.code !== "ENOENT") throw e; }
  if (old) {
    const st = await fs.stat(abs);
    if (st.isDirectory()) throw fail(400, "that is a folder");
    const t = decodeText(old);
    // Never write over a binary: the editor only ever had a lossy picture of it.
    if (!t) throw fail(409, "this file is not text; saving would change its bytes", { binary: true });
    if (t.encoding !== encoding && !force) throw fail(409, `the file is ${t.encoding} on disk now, not ${encoding}`, { conflict: true, hash: hashOf(old) });
    if (baseHash && hashOf(old) !== baseHash && !force) throw fail(409, "the file changed on disk since it was opened", { conflict: true, hash: hashOf(old) });
  } else if (!create && baseHash) throw fail(409, "the file was deleted or moved since it was opened", { conflict: true, gone: true });
  const bytes = encodeText(content.replace(/\r\n?/g, "\n").replace(/\n/g, EOL[eol]), encoding);
  if (!old) await fs.mkdir(dirname(abs), { recursive: true });
  await fs.writeFile(abs, bytes);
  const st = await fs.stat(abs);
  return { ok: true, path: relOf(root, abs), size: st.size, mtimeMs: st.mtimeMs, hash: hashOf(bytes) };
}

/** A new empty file or folder ("a/b/c.txt" makes the folders on the way). Never replaces anything. */
export async function createEntry(root, rel, { dir = false } = {}) {
  const abs = insideNotRoot(root, checkRelPath(rel));
  if (await exists(abs)) throw fail(409, `${relOf(root, abs)} already exists`);
  if (dir) await fs.mkdir(abs, { recursive: true });
  else { await fs.mkdir(dirname(abs), { recursive: true }); await fs.writeFile(abs, "", { flag: "wx" }); }
  return { ok: true, path: relOf(root, abs), dir };
}

/** Rename or move inside the root. Refuses to replace an existing file (a case-only rename is allowed). */
export async function renameEntry(root, from, to) {
  const src = insideNotRoot(root, from), dst = insideNotRoot(root, checkRelPath(to));
  if (!(await exists(src))) throw fail(404, "no such file or folder");
  if (src === dst) return { ok: true, path: relOf(root, dst) };
  const caseOnly = src.toLowerCase() === dst.toLowerCase();
  if (!caseOnly && (await exists(dst))) throw fail(409, `${relOf(root, dst)} already exists`);
  if (dst.startsWith(src + sep)) throw fail(400, "a folder cannot move into itself");
  await fs.mkdir(dirname(dst), { recursive: true });
  if (caseOnly) { const tmp = `${src}.omni-rename-${process.pid}`; await fs.rename(src, tmp); await fs.rename(tmp, dst); }
  else await fs.rename(src, dst);
  return { ok: true, path: relOf(root, dst) };
}

/** "name copy.ext", "name copy 2.ext", … beside the original. */
export async function duplicateEntry(root, rel) {
  const src = insideNotRoot(root, rel);
  const st = await fs.stat(src);
  const ext = st.isDirectory() ? "" : extname(src), stem = basename(src, ext), dir = dirname(src);
  let dst;
  for (let i = 1; i < 1000; i++) { dst = join(dir, `${stem} copy${i > 1 ? ` ${i}` : ""}${ext}`); if (!(await exists(dst))) break; }
  await fs.cp(src, dst, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
  return { ok: true, path: relOf(root, dst) };
}

/** To the system trash (Recycle Bin, ~/.Trash, gio trash); `permanent` deletes for good instead.
 *  A trash that fails is reported (`trashFailed`) so the person decides about a permanent delete. */
export async function deleteEntry(root, rel, { permanent = false, trash = moveToTrash } = {}) {
  const abs = insideNotRoot(root, rel);
  if (!(await exists(abs))) throw fail(404, "no such file or folder");
  if (permanent) { await fs.rm(abs, { recursive: true, force: true }); return { ok: true, permanent: true }; }
  try { await trash(abs); } catch (e) { throw fail(500, `could not move it to the trash: ${e.message}`, { trashFailed: true }); }
  if (await exists(abs)) throw fail(500, "could not move it to the trash", { trashFailed: true });
  return { ok: true, trashed: true };
}

const run = (bin, args, opts = {}) => new Promise((ok, no) => {
  const p = spawn(bin, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"], ...opts });
  let err = "";
  p.stderr?.on("data", (d) => { err += d; });
  const t = setTimeout(() => p.kill(), 30_000);
  p.on("error", (e) => { clearTimeout(t); no(e); });
  p.on("exit", (c) => { clearTimeout(t); c === 0 ? ok() : no(new Error(err.trim().split("\n").pop() || `${bin} exited ${c}`)); });
});

// SHFileOperation with undo (the Recycle Bin) and no dialog of any kind: the server must never pop a window.
const WIN_TRASH = `Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class OmniTrash {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct OP { public IntPtr hwnd; public uint func; public string from; public string to; public ushort flags; public bool aborted; public IntPtr map; public string title; }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)] static extern int SHFileOperation(ref OP op);
  public static int Recycle(string path) { var op = new OP { func = 3, from = path + "\\0\\0", flags = 0x0040 | 0x0010 | 0x0004 | 0x0400 }; return SHFileOperation(ref op); }
}
'@
$r = [OmniTrash]::Recycle($env:OMNI_TRASH_PATH); if ($r -ne 0) { [Console]::Error.WriteLine("SHFileOperation failed: $r"); exit 1 }`;

export async function moveToTrash(abs) {
  if (process.platform === "win32") return run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WIN_TRASH], { env: { ...process.env, OMNI_TRASH_PATH: abs } });
  if (process.platform === "darwin") {
    const bin = join(homedir(), ".Trash");
    await fs.mkdir(bin, { recursive: true });
    const ext = extname(abs), stem = basename(abs, ext);
    let dst = join(bin, basename(abs));
    for (let i = 2; await exists(dst); i++) dst = join(bin, `${stem} ${i}${ext}`);
    return fs.rename(abs, dst);
  }
  return run("gio", ["trash", abs]);
}

/** Show it in the system file manager, on the host's screen. */
export function reveal(root, rel) {
  const abs = inside(root, rel);
  const opts = { detached: true, stdio: "ignore", windowsHide: false };
  const p = process.platform === "win32" ? spawn("explorer.exe", [`/select,${abs}`], opts)
    : process.platform === "darwin" ? spawn("open", ["-R", abs], opts)
    : spawn("xdg-open", [dirname(abs)], opts);
  p.on("error", () => {});
  p.unref();
  return { ok: true };
}
