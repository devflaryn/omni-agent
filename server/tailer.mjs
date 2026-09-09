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
