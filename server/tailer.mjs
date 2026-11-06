/**
 * Follow an append-only JSONL file. Works on Windows where fs.watch on a single
 * file is unreliable: fs.watch gives us a nudge when it works, a short poll
 * covers the rest. Only complete LF-terminated lines are parsed.
 */
import { promises as fs, watch } from "node:fs";
import { createLineSplitter } from "./jsonl.mjs";

export async function readAppended(path, offset, pending) {
  const st = await fs.stat(path);
  if (st.size < offset) { offset = 0; pending = ""; } // truncated/rotated
  if (st.size === offset) return { objects: [], offset, pending };
  const fh = await fs.open(path, "r");
  try {
    const len = st.size - offset;
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, offset);
    const objects = [];
    const s = createLineSplitter((line) => {
      try { objects.push(JSON.parse(line)); } catch { /* skip */ }
    });
    s.push(pending + buf.toString("utf8"));
    return { objects, offset: st.size, pending: s.pending };
  } finally {
    await fh.close();
  }
}

/** Read only the final `maxBytes` of an append-only JSONL file, discarding the first
 *  (possibly partial) line so every returned object is a clean parse. For history views
 *  of multi-day sessions that must never load the whole file into one string. */
export async function readTail(path, { maxBytes = 8 * 1024 * 1024 } = {}) {
  const st = await fs.stat(path);
  const start = st.size > maxBytes ? st.size - maxBytes : 0;
  const len = st.size - start;
  const fh = await fs.open(path, "r");
  try {
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, start);
    let text = buf.toString("utf8");
    if (start > 0) { const nl = text.indexOf("\n"); text = nl >= 0 ? text.slice(nl + 1) : ""; }
    const objects = [];
    const s = createLineSplitter((line) => { try { objects.push(JSON.parse(line)); } catch { /* skip */ } });
    s.push(text); s.flush();
    return { objects, truncated: start > 0 };
  } finally { await fh.close(); }
}

const parseLine = (buf) => { try { return JSON.parse(buf.toString("utf8")); } catch { return undefined; } };

/**
 * One page of a JSONL file: the whole lines that end at or before byte `before` (the file's end when absent),
 * reading back about `maxBytes` (further when a single line is longer, so a page is never empty while the file
 * has more). `lines` are `{ at, obj }` with `at` the line's byte offset; `start` is the first one's offset (0: the
 * page reaches the file's start). The file is never read whole.
 */
export async function readWindow(path, { before, maxBytes = 2 * 1024 * 1024 } = {}) {
  const st = await fs.stat(path);
  const end = before == null ? st.size : Math.max(0, Math.min(Number(before) || 0, st.size));
  const fh = await fs.open(path, "r");
  try {
    for (let want = maxBytes; ; want *= 2) {
      const start = Math.max(0, end - want);
      const buf = Buffer.alloc(end - start);
      await fh.read(buf, 0, buf.length, start);
      let pos = 0;
      if (start > 0) {
        const nl = buf.indexOf(10);
        // No line starts inside this window: read further back.
        if (nl < 0 || nl === buf.length - 1) continue;
        pos = nl + 1;
      }
      const lines = [];
      while (pos < buf.length) {
        let nl = buf.indexOf(10, pos);
        if (nl < 0) nl = buf.length;
        const obj = nl > pos ? parseLine(buf.subarray(pos, nl)) : undefined;
        if (obj !== undefined) lines.push({ at: start + pos, obj });
        pos = nl + 1;
      }
      return { lines, start: lines.length ? lines[0].at : end, size: st.size };
    }
  } finally { await fh.close(); }
}

/** The JSONL object on the line starting at byte `at` (undefined when that is not a whole JSON line). */
export async function readLineAt(path, at, { maxBytes = 64 * 1024 * 1024 } = {}) {
  const fh = await fs.open(path, "r");
  try {
    const parts = [];
    let pos = Number(at) || 0, total = 0;
    for (;;) {
      const chunk = Buffer.alloc(1024 * 1024);
      const { bytesRead } = await fh.read(chunk, 0, chunk.length, pos);
      if (!bytesRead) break;
      const nl = chunk.subarray(0, bytesRead).indexOf(10);
      parts.push(chunk.subarray(0, nl < 0 ? bytesRead : nl));
      total += nl < 0 ? bytesRead : nl;
      if (nl >= 0 || total > maxBytes) break;
      pos += bytesRead;
    }
    return parseLine(Buffer.concat(parts));
  } finally { await fh.close(); }
}

/**
 * Newest-first scan of a JSONL file for a line holding `needle`: `test(obj)` returns the value wanted (undefined
 * to keep looking). Reads backwards in chunks, so a recent line is found without reading the whole file.
 */
export async function scanBack(path, needle, test, { chunk = 4 * 1024 * 1024 } = {}) {
  const st = await fs.stat(path);
  const want = Buffer.from(String(needle));
  const fh = await fs.open(path, "r");
  try {
    let pos = st.size, carry = Buffer.alloc(0);
    while (pos > 0) {
      const s = Math.max(0, pos - chunk);
      const buf = Buffer.alloc(pos - s);
      await fh.read(buf, 0, buf.length, s);
      const data = carry.length ? Buffer.concat([buf, carry]) : buf;
      pos = s;
      // The bytes before the first newline belong to a line that starts in an older chunk.
      const nl = s > 0 ? data.indexOf(10) : -1;
      if (s > 0 && nl < 0) { carry = data; continue; }
      const body = data.subarray(nl + 1);
      carry = s > 0 ? data.subarray(0, nl + 1) : Buffer.alloc(0);
      if (body.indexOf(want) < 0) continue;
      let e = body.length;
      while (e > 0) {
        const b = body.lastIndexOf(10, e - 1);
        const line = body.subarray(b + 1, e);
        if (line.indexOf(want) >= 0) { const obj = parseLine(line); if (obj !== undefined) { const r = test(obj); if (r !== undefined) return r; } }
        e = b < 0 ? 0 : b;
      }
    }
    return undefined;
  } finally { await fh.close(); }
}

export class JsonlTail {
  constructor(path, { fromEnd = true, intervalMs = 700, onObject, onError } = {}) {
    this.path = path;
    this.fromEnd = fromEnd;
    this.intervalMs = intervalMs;
    this.onObject = onObject || (() => {});
    this.onError = onError || (() => {});
    this.offset = 0;
    this.pending = "";
    this.timer = null;
    this.watcher = null;
    this.busy = false;
    this.stopped = false;
  }

  async start() {
    if (this.fromEnd) {
      try { this.offset = (await fs.stat(this.path)).size; } catch { this.offset = 0; }
    }
    try {
      this.watcher = watch(this.path, () => this.poll());
      this.watcher.on("error", () => { /* fall back to polling */ });
    } catch { /* polling only */ }
    this.timer = setInterval(() => this.poll(), this.intervalMs);
    if (!this.fromEnd) await this.poll();
    return this;
  }

  async poll() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      const r = await readAppended(this.path, this.offset, this.pending);
      this.offset = r.offset;
      this.pending = r.pending;
      for (const o of r.objects) {
        if (this.stopped) break;
        try { this.onObject(o); } catch (e) { this.onError(e); }
      }
    } catch (e) {
      if (e?.code !== "ENOENT") this.onError(e);
    } finally {
      this.busy = false;
    }
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    try { this.watcher?.close(); } catch { /* ignore */ }
  }
}
