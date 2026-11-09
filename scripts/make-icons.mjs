#!/usr/bin/env node
// Every icon from ui/logo.svg, drawn by headless Chrome: node scripts/make-icons.mjs [--mac] [chrome path]
//   ui/icon-{32,180,192,512}.png   the page, home screens
//   desktop/omni.ico               the desktop window (16 to 256)
//   ios/OmniAgent/Assets.xcassets/AppIcon.appiconset/   the iPhone app (opaque and square: iOS rounds it itself)
//   mac/AppIcon.png                the Mac app, 1024 on Apple's grid (mac/make-app.sh makes the .icns from it). --mac: only this one.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ARGS = process.argv.slice(2);
const CHROME = ARGS.find((a) => !a.startsWith("--")) || (process.platform === "win32" ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" : "google-chrome");
const svg = readFileSync(join(ROOT, "ui", "logo.svg"), "utf8");
const square = svg.replace('rx="15"', 'rx="0"'); // iOS applies its own corners, and an app icon may not be transparent

const run = (args) => new Promise((res, rej) => { const p = spawn(CHROME, args, { stdio: "ignore" }); p.on("error", rej); p.on("exit", res); });
async function draw(source, size, html = false) {
  const dir = mkdtempSync(join(tmpdir(), "omni-icon-"));
  try {
    const page = join(dir, "i.html"), shot = join(dir, "i.png");
    writeFileSync(page, `<!doctype html><html style="background:transparent"><body style="margin:0;background:transparent"><div style="width:${size}px;height:${size}px">${html ? source : source.replace("<svg ", `<svg width="${size}" height="${size}" `)}</div></body></html>`);
    await run(["--headless=new", "--disable-gpu", "--default-background-color=00000000", "--hide-scrollbars", "--force-device-scale-factor=1", `--window-size=${size},${Math.max(size, 200)}`, `--user-data-dir=${join(dir, "p")}`, `--screenshot=${shot}`, `file:///${page.replace(/\\/g, "/")}`]);
    return cropPng(readFileSync(shot), size);
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); }
}

// Chrome keeps a minimum window size, so the shot can be taller than the icon: cut it to size.
import { deflateSync, inflateSync } from "node:zlib";
function cropPng(buf, size) {
  let o = 8, idat = [], w = 0, h = 0, type = 0;
  while (o < buf.length) {
    const len = buf.readUInt32BE(o), kind = buf.toString("latin1", o + 4, o + 8), data = buf.subarray(o + 8, o + 8 + len);
    if (kind === "IHDR") { w = data.readUInt32BE(0); h = data.readUInt32BE(4); type = data[9]; }
    if (kind === "IDAT") idat.push(data);
    o += 12 + len;
  }
  const bpp = type === 6 ? 4 : 3, raw = inflateSync(Buffer.concat(idat)), stride = w * bpp;
  const px = Buffer.alloc(h * stride);
  const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x], a = x >= bpp ? px[y * stride + x - bpp] : 0, b = y ? px[(y - 1) * stride + x] : 0, c = y && x >= bpp ? px[(y - 1) * stride + x - bpp] : 0;
      px[y * stride + x] = (v + (f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : f === 4 ? paeth(a, b, c) : 0)) & 255;
    }
  }
  const out = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const s = y * stride + x * bpp, d = y * (size * 4 + 1) + 1 + x * 4;
    out[d] = px[s]; out[d + 1] = px[s + 1]; out[d + 2] = px[s + 2]; out[d + 3] = bpp === 4 ? px[s + 3] : 255;
  }
  const crc = (b) => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]), r = Buffer.alloc(4); r.writeUInt32BE(crc(td)); return Buffer.concat([l, td, r]); };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(size, 0); ih.writeUInt32BE(size, 4); ih[8] = 8; ih[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ih), chunk("IDAT", deflateSync(out)), chunk("IEND", Buffer.alloc(0))]);
}

function ico(images) {
  const head = Buffer.alloc(6 + images.length * 16); head.writeUInt16LE(1, 2); head.writeUInt16LE(images.length, 4);
  let at = head.length;
  images.forEach(([size, png], i) => { const e = 6 + i * 16; head[e] = size === 256 ? 0 : size; head[e + 1] = size === 256 ? 0 : size; head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6); head.writeUInt32LE(png.length, e + 8); head.writeUInt32LE(at, e + 12); at += png.length; });
  return Buffer.concat([head, ...images.map(([, p]) => p)]);
}

// macOS draws no corners or shadow of its own: the shape sits at 824 of 1024 with room for its shadow, as Apple's template has it.
const macIcon = `<div style="width:1024px;height:1024px;display:flex;align-items:center;justify-content:center"><div style="width:824px;height:824px;margin-top:-12px;filter:drop-shadow(0 10px 14px rgba(0,0,0,.28))">${svg.replace("<svg ", '<svg width="824" height="824" ')}</div></div>`;
writeFileSync(join(ROOT, "mac", "AppIcon.png"), await draw(macIcon, 1024, true));
if (ARGS.includes("--mac")) { console.log("mac/AppIcon.png written"); process.exit(0); }
for (const s of [32, 180, 192, 512]) writeFileSync(join(ROOT, "ui", `icon-${s}.png`), await draw(s === 180 ? square : svg, s));
writeFileSync(join(ROOT, "desktop", "omni.ico"), ico(await Promise.all([16, 24, 32, 48, 64, 256].map(async (s) => [s, await draw(svg, s)]))));
const set = join(ROOT, "ios", "OmniAgent", "Assets.xcassets", "AppIcon.appiconset");
mkdirSync(set, { recursive: true });
writeFileSync(join(set, "icon-1024.png"), await draw(square, 1024));
writeFileSync(join(set, "Contents.json"), `${JSON.stringify({ images: [{ filename: "icon-1024.png", idiom: "universal", platform: "ios", size: "1024x1024" }], info: { author: "xcode", version: 1 } }, null, 2)}\n`);
console.log("icons written");
