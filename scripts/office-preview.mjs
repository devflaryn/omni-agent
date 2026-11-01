#!/usr/bin/env node
// Render the Mission view's office (ui/office.js) to a PNG, to tweak the art without the app.
//   node scripts/office-preview.mjs [out.png] [scale] [data.json]
// data.json has the shape officeData() returns (see SAMPLE below). Edit ui/office-props.js (people, CRTs, desks,
// plants, palettes), ui/office.js (layout, states, text) or ui/office-engine.js (lighting), re-run, look.
import { writeFileSync, readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { createOffice } from "../ui/office.js";

export const SAMPLE = {
  seed: "m-sample",
  orchestrator: { state: "working", model: "opencode-go/deepseek-v4.1-flash", tasksDone: 22, tasksTotal: 30, workers: 17, busy: 3, ctx: "312K", ctxMax: "1M", time: "6H12M", generation: 2 },
  workers: [
    { id: "a1", kind: "claude", state: "working", task: "t6.2", title: "Implement relocation layer and build 2.744", step: 4, of: 7, turns: 31, tokens: "184K", time: "28M", subs: [
      { id: "s1", kind: "claude", state: "working", title: "Patch the loader stub", step: null, of: null, turns: 4, tokens: "41K", time: "6M" },
      { id: "s2", kind: "shell", state: "done", title: "build 2.744 apks", step: null, of: null, turns: 0, tokens: "-", time: "6S" },
      { id: "s3", kind: "pi", state: "done", title: "Grep reloc tables", step: null, of: null, turns: 2, tokens: "12K", time: "2M" }] },
    { id: "a2", kind: "pi", state: "working", task: "t6.1", title: "Root-cause exit_group(11)", step: 2, of: 5, turns: 18, tokens: "96K", time: "12M", subs: [] },
    { id: "a3", kind: "pi", state: "done", task: "t1", title: "Survey the workspace", step: 6, of: 6, turns: 9, tokens: "41K", time: "1M35S", subs: [] },
    { id: "a4", kind: "claude", state: "failed", task: "t5", title: "Design a version-agnostic portkit", step: 1, of: 6, turns: 1, tokens: "3K", time: "3S", subs: [] },
    { id: "a5", kind: "pi", state: "queued", task: "t6.9", title: "Inventory payload sources", step: null, of: null, turns: 0, tokens: "-", time: "-", subs: [] },
    { id: "a6", kind: "pi", state: "stopped", task: "t6.7", title: "Fix the wild pointer in the builder", step: 3, of: 8, turns: 22, tokens: "77K", time: "21M", subs: [] },
    { id: "a7", kind: "claude", state: "done", task: "t6.7.1", title: "Static provenance of memcpy", step: 5, of: 5, turns: 12, tokens: "58K", time: "1M35S", subs: [] },
    { id: "a8", kind: "pi", state: "working", task: "t6.7.2", title: "Dynamic builder trace", step: 5, of: 9, turns: 40, tokens: "212K", time: "1H15M", subs: [] },
  ],
};

export function png({ w, h, rgba }, scale = 1) {
  const W = w * scale, H = h * scale, raw = Buffer.alloc((W * 4 + 1) * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const s = (Math.floor(y / scale) * w + Math.floor(x / scale)) * 4, o = y * (W * 4 + 1) + 1 + x * 4; raw[o] = rgba[s]; raw[o + 1] = rgba[s + 1]; raw[o + 2] = rgba[s + 2]; raw[o + 3] = rgba[s + 3]; }
  const crc = (buf) => { let c = ~0; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/").replace(/^\//, "")}` || process.argv[1]?.endsWith("office-preview.mjs")) {
  const [out = "office-preview.png", scale = "3", dataFile] = process.argv.slice(2);
  const data = dataFile ? JSON.parse(readFileSync(dataFile, "utf8")) : SAMPLE;
  const t0 = Date.now();
  const { img } = createOffice().draw(data, { selected: process.env.OFFICE_SELECTED || null });
  writeFileSync(out, png(img, Number(scale) || 1));
  console.log(`${out}: ${img.w}x${img.h} (x${scale}) in ${Date.now() - t0} ms`);
}
