/**
 * Read-only zip parsing with Node built-ins, enough to list what is inside a .zip/.apk/.jar and
 * pull one entry out for a preview. Central directory only (no streaming, no ZIP64).
 */
import { inflateRawSync } from "node:zlib";

const SIG_EOCD = 0x06054b50, SIG_CD = 0x02014b50, SIG_LOCAL = 0x04034b50;
const ARCHIVE_EXT = /\.(zip|apk|jar|aar|xapk|apks|war|ear|ipa)$/i;

export function isArchiveName(name) { return ARCHIVE_EXT.test(String(name || "")); }

function findEocd(buf) {
  // The EOCD is 22 bytes plus an optional comment of up to 65535 bytes, so scan back from the end.
  const min = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= min; i--) if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  return -1;
}

/** @returns {{ path: string, size: number, compressed: number, method: number, dir: boolean, offset: number }[]} */
export function listZipEntries(buf, { limit = 5000 } = {}) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error("not a zip file");
  const at = findEocd(buf);
  if (at < 0) throw new Error("not a zip file (no end-of-central-directory record)");
  const countDisk = buf.readUInt16LE(at + 8), count = buf.readUInt16LE(at + 10), cdSize = buf.readUInt32LE(at + 12), cdOffset = buf.readUInt32LE(at + 16);
  if (countDisk === 0xffff || count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new Error("ZIP64 archives are not supported");
  if (cdOffset + cdSize > buf.length) throw new Error("zip central directory out of range");
  const out = [];
  let p = cdOffset;
  for (let i = 0; i < count && p + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(p) !== SIG_CD) throw new Error("zip central directory is corrupt");
    const method = buf.readUInt16LE(p + 10), compressed = buf.readUInt32LE(p + 20), size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const path = buf.toString("utf8", p + 46, p + 46 + nameLen);
    if (out.length < limit) out.push({ path, size, compressed, method, dir: path.endsWith("/"), offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** Bytes of one entry from `listZipEntries` (stored or deflated). */
export function readZipEntry(buf, entry) {
  const p = entry.offset;
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== SIG_LOCAL) throw new Error("zip local header is corrupt");
  const nameLen = buf.readUInt16LE(p + 26), extraLen = buf.readUInt16LE(p + 28);
  const start = p + 30 + nameLen + extraLen;
  const data = buf.subarray(start, start + entry.compressed);
  if (entry.method === 0) return Buffer.from(data);
  if (entry.method === 8) return inflateRawSync(data);
  throw new Error(`zip compression method ${entry.method} is not supported`);
}
