// Omni office art (see docs/office-art.md). A tiny pixel-art renderer: orthographic rays against boxes and ellipsoids, quantized shading ramps,
// a key light with cast shadows, coloured point lights (CRT screens), glass, selective outlines.
// No DOM, no Node APIs: runs in the browser (into ImageData) and in Node (into a PNG).

export const V = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  mul: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  len: (a) => Math.hypot(a[0], a[1], a[2]),
  norm: (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
};
export const hexRgb = (c) => { const n = parseInt(c.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
export const mixRgb = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** Axes for a yaw (about Y) then pitch (about the new X) then roll. */
export function axes(yaw = 0, pitch = 0, roll = 0) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch), cr = Math.cos(roll), sr = Math.sin(roll);
  let x = [cy, 0, -sy], y = [0, 1, 0], z = [sy, 0, cy];
  // pitch about x
  const y2 = V.add(V.mul(y, cp), V.mul(z, sp)), z2 = V.add(V.mul(z, cp), V.mul(y, -sp)); y = y2; z = z2;
  // roll about z
  const x3 = V.add(V.mul(x, cr), V.mul(y, sr)), y3 = V.add(V.mul(y, cr), V.mul(x, -sr)); x = x3; y = y3;
  return [x, y, z];
}
/** Axes whose Y points from a to b (for limbs). */
export function axesAlong(a, b) {
  const y = V.norm(V.sub(b, a));
  const ref = Math.abs(y[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
  const x = V.norm(V.cross(ref, y)); const z = V.cross(x, y);
  return [x, y, z];
}

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);

export class Scene {
  constructor() { this.prims = []; this.lights = []; this.decals = []; this.texts = []; this.key = V.norm([-0.45, 0.85, 0.5]); this.ambient = 0.42; }
  /** material: { ramp: [hex dark→light], group, outline: true, dither: false, cast: true, glass: false, tex(local, prim) → ramp offset } */
  box(c, size, ax, mat) { this.prims.push({ type: "box", c, h: size.map((s) => s / 2), ax: ax || axes(), mat }); return this.prims.at(-1); }
  ell(c, r, ax, mat, reject) { this.prims.push({ type: "ell", c, r, ax: ax || axes(), mat, reject }); return this.prims.at(-1); }
  limb(a, b, r, mat) { const ax = axesAlong(a, b); return this.ell(V.mul(V.add(a, b), 0.5), [r, V.len(V.sub(b, a)) / 2 + r * 0.6, r], ax, mat); }
  light(p, color, radius, strength = 1) { this.lights.push({ p, color: hexRgb(color), radius, strength }); }
}

function hitPrim(p, o, d) {
  const rel = V.sub(o, p.c);
  if (p.type === "box") {
    let tmin = -Infinity, tmax = Infinity, nIn = null, nOut = null;
    for (let i = 0; i < 3; i++) {
      const a = p.ax[i], oo = V.dot(rel, a), dd = V.dot(d, a), h = p.h[i];
      if (Math.abs(dd) < 1e-9) { if (oo < -h || oo > h) return null; continue; }
      let t1 = (-h - oo) / dd, t2 = (h - oo) / dd, s = -1;
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; s = 1; }
      if (t1 > tmin) { tmin = t1; nIn = V.mul(a, s); }
      if (t2 < tmax) { tmax = t2; nOut = V.mul(a, -s); }
      if (tmin > tmax) return null;
    }
    if (tmax < 0) return null;
    const t = tmin > 0 ? tmin : tmax;
    const pt = V.add(o, V.mul(d, t)), lr = V.sub(pt, p.c);
    return { t, n: tmin > 0 ? nIn : nOut, local: [V.dot(lr, p.ax[0]), V.dot(lr, p.ax[1]), V.dot(lr, p.ax[2])] };
  }
  const oo = [V.dot(rel, p.ax[0]) / p.r[0], V.dot(rel, p.ax[1]) / p.r[1], V.dot(rel, p.ax[2]) / p.r[2]];
  const dd = [V.dot(d, p.ax[0]) / p.r[0], V.dot(d, p.ax[1]) / p.r[1], V.dot(d, p.ax[2]) / p.r[2]];
  const A = V.dot(dd, dd), B = 2 * V.dot(oo, dd), C = V.dot(oo, oo) - 1, disc = B * B - 4 * A * C;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  for (const t of [(-B - sq) / (2 * A), (-B + sq) / (2 * A)]) {
    if (t < 0) continue;
    const q = V.add(oo, V.mul(dd, t));
    if (p.reject && p.reject(q)) continue;
    const n = V.norm(V.add(V.add(V.mul(p.ax[0], q[0] / p.r[0]), V.mul(p.ax[1], q[1] / p.r[1])), V.mul(p.ax[2], q[2] / p.r[2])));
    // an inside (far) hit of a carved shell faces away: flip it
    return { t, n: V.dot(n, d) > 0 ? V.mul(n, -1) : n, local: q };
  }
  return null;
}
const radiusOf = (p) => (p.type === "box" ? Math.hypot(...p.h) : Math.max(...p.r));

/**
 * Render. view: { pitch, x0, y0, w, h } (screen y = world-up projected; x0/y0 the top-left in screen units).
 * Returns { w, h, rgba: Uint8ClampedArray, id: Int32Array, depth: Float32Array, project(p) → [px, py, depth] }.
 */
export function render(scene, view) {
  const { w, h, x0, y0 } = view, th = view.pitch, ct = Math.cos(th), st = Math.sin(th);
  const project = (p) => [p[0] - x0, y0 - (p[1] * ct - p[2] * st), p[1] * st + p[2] * ct];
  const dir = [0, -st, -ct];
  const prims = scene.prims;
  prims.forEach((p, i) => { p.id = i; p.rad = radiusOf(p); const [px, py] = project(p.c); p.bb = [px - p.rad - 1, py - p.rad - 1, px + p.rad + 1, py + p.rad + 1]; });
  // tile bins
  const T = 16, tw = Math.ceil(w / T), thn = Math.ceil(h / T), bins = Array.from({ length: tw * thn }, () => []);
  for (const p of prims) for (let ty = Math.max(0, Math.floor(p.bb[1] / T)); ty <= Math.min(thn - 1, Math.floor(p.bb[3] / T)); ty++) for (let tx = Math.max(0, Math.floor(p.bb[0] / T)); tx <= Math.min(tw - 1, Math.floor(p.bb[2] / T)); tx++) bins[ty * tw + tx].push(p);
  const casters = prims.filter((p) => p.mat.cast !== false && !p.mat.glass);
  const shadowed = (pt) => {
    const o = V.add(pt, V.mul(scene.key, 0.6));
    for (const p of casters) {
      const rel = V.sub(p.c, o), tc = V.dot(rel, scene.key);
      if (tc < -p.rad) continue;
      const d2 = V.dot(rel, rel) - tc * tc;
      if (d2 > p.rad * p.rad) continue;
      const hh = hitPrim(p, o, scene.key);
      if (hh && hh.t > 0.05) return true;
    }
    return false;
  };
  const rgba = new Uint8ClampedArray(w * h * 4), idb = new Int32Array(w * h).fill(-1), depth = new Float32Array(w * h).fill(-1e9), grp = new Array(w * h).fill(null);
  const shadeHit = (p, hit, pt, px, py) => {
    const m = p.mat;
    if (m.emit) return hexRgb(m.emit);
    const ramp = m.rampRgb || (m.rampRgb = m.ramp.map(hexRgb));
    const lam = Math.max(0, V.dot(hit.n, scene.key));
    const sh = m.noShadow || lam <= 0 ? 1 : shadowed(pt) ? 0 : 1;
    let I = (m.ambient ?? scene.ambient) + (1 - (m.ambient ?? scene.ambient)) * lam * sh;
    if (m.tex) I += m.tex(hit.local, p, pt) || 0;
    if (m.dither) I += (BAYER[(py & 3) * 4 + (px & 3)] - 0.5) * (1.2 / ramp.length);
    const k = Math.max(0, Math.min(ramp.length - 1, Math.floor(I * ramp.length)));
    let c = ramp[k];
    // coloured light from the screens, quantized in steps so it reads as pixel light
    for (const L of scene.lights) {
      const to = V.sub(L.p, pt), dist = V.len(to);
      if (dist > L.radius) continue;
      const f = Math.max(0, V.dot(hit.n, V.mul(to, 1 / dist))) * (1 - dist / L.radius) * L.strength;
      const q = Math.floor((f + (m.dither ? (BAYER[(py & 3) * 4 + (px & 3)] - 0.5) * 0.25 : 0)) * 5) / 5;
      if (q > 0) c = mixRgb(c, L.color, Math.min(0.42, q * (m.lightGain ?? 0.55)));
    }
    return c;
  };
  for (let py = 0; py < h; py++) for (let px = 0; px < w; px++) {
    const sx = px + x0 + 0.5, sy = y0 - (py + 0.5);
    const o = [sx, sy * ct + 2000 * st, -sy * st + 2000 * ct];
    const list = bins[Math.floor(py / T) * tw + Math.floor(px / T)];
    let best = null, bp = null; const glass = [];
    for (const p of list) {
      if (px < p.bb[0] || px > p.bb[2] || py < p.bb[1] || py > p.bb[3]) continue;
      const hh = hitPrim(p, o, dir);
      if (!hh) continue;
      if (p.mat.glass) { glass.push([hh, p]); continue; }
      if (!best || hh.t < best.t) { best = hh; bp = p; }
    }
    const i = py * w + px;
    let c = [0, 0, 0], a = 0;
    if (best) {
      const pt = V.add(o, V.mul(dir, best.t));
      c = shadeHit(bp, best, pt, px, py); a = 255;
      idb[i] = bp.id; depth[i] = -best.t; grp[i] = bp.mat.group || `p${bp.id}`;
    }
    for (const [gh, gp] of glass.sort((u, v) => v[0].t - u[0].t)) {
      if (best && gh.t > best.t) continue;
      const g = hexRgb(gp.mat.ramp[0]);
      c = mixRgb(a ? c : g, g, gp.mat.alpha ?? 0.3); a = 255;
      // a highlight streak on the glass
      if (((px + py * 2) % 23) < 2) c = mixRgb(c, [255, 255, 255], 0.35);
    }
    rgba[i * 4] = c[0]; rgba[i * 4 + 1] = c[1]; rgba[i * 4 + 2] = c[2]; rgba[i * 4 + 3] = a;
  }
  // selective outlines: a pixel on the silhouette of its group (or over a big depth jump) takes the ramp's darkest tone
  const out = new Uint8ClampedArray(rgba);
  for (let py = 0; py < h; py++) for (let px = 0; px < w; px++) {
    const i = py * w + px, id = idb[i];
    if (id < 0) continue;
    const m = prims[id].mat;
    if (!m.outline) continue;
    let edge = false;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x = px + dx, y = py + dy;
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const j = y * w + x;
      if (idb[j] < 0) { edge = true; break; }
      if (grp[j] !== grp[i] && depth[j] < depth[i] - 1.5) { edge = true; break; }
      if (grp[j] === grp[i] && idb[j] !== id && depth[j] < depth[i] - (m.innerEdge ?? 5)) { edge = true; break; }
    }
    if (edge) { const oc = hexRgb(m.line || m.ramp[0]); const k = m.line ? 1 : 0.55; out[i * 4] = rgba[i * 4] * (1 - k) * 0.4 + oc[0] * k; out[i * 4 + 1] = rgba[i * 4 + 1] * (1 - k) * 0.4 + oc[1] * k; out[i * 4 + 2] = rgba[i * 4 + 2] * (1 - k) * 0.4 + oc[2] * k; }
  }
  return { w, h, rgba: out, id: idb, depth, project, prims };
}

/** Paint a pixel only where `prim` is the visible surface (for faces drawn on heads). */
export function paintOn(img, prim, p, color) {
  const [x, y] = img.project(p), px = Math.floor(x), py = Math.floor(y);
  if (px < 0 || py < 0 || px >= img.w || py >= img.h) return;
  const i = py * img.w + px;
  if (img.id[i] !== prim.id) return;
  const c = hexRgb(color); img.rgba[i * 4] = c[0]; img.rgba[i * 4 + 1] = c[1]; img.rgba[i * 4 + 2] = c[2];
}
export function px(img, x, y, color, alpha = 1) {
  x = Math.floor(x); y = Math.floor(y);
  if (x < 0 || y < 0 || x >= img.w || y >= img.h) return;
  const i = (y * img.w + x) * 4, c = hexRgb(color);
  img.rgba[i] = img.rgba[i] * (1 - alpha) + c[0] * alpha; img.rgba[i + 1] = img.rgba[i + 1] * (1 - alpha) + c[1] * alpha; img.rgba[i + 2] = img.rgba[i + 2] * (1 - alpha) + c[2] * alpha; img.rgba[i + 3] = 255;
}
