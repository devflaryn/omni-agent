// Omni office art (see docs/office-art.md). Builders for the office: people, CRTs, desks, plants. World units ≈ pixels; Y up, Z toward the viewer.
import { V, axes, paintOn } from "./office-engine.js";

export const RAMP = {
  skin: ["#5e3426", "#9a5b42", "#c98763", "#e8ac86", "#f6caa8"],
  skin2: ["#3b2219", "#6a3d2b", "#94593e", "#b77a55", "#d39a72"],
  claudeKnit: ["#3f1a12", "#712f20", "#a84c34", "#d27053", "#ec977a"],
  claudeHair: ["#1e0d08", "#3e1a10", "#62291a", "#8a3d25", "#ad5735"],
  hoodie: ["#161b22", "#262e38", "#38424f", "#4f5b6b", "#6a7889"],
  hoodieIn: ["#0d1015", "#151a21", "#1d242d", "#262e38", "#2f3843"],
  piHair: ["#0e0b0b", "#1d1817", "#2d2624", "#3f3633", "#544844"],
  blazer: ["#160d35", "#2a1a68", "#40299a", "#5c3fcc", "#7f62e6"],
  shirt: ["#6b6878", "#9b98a8", "#c4c1cf", "#e3e1ea", "#f8f7fc"],
  orchHair: ["#0c0910", "#181220", "#251c31", "#352a45", "#4a3c5e"],
  gold: ["#4d3604", "#83600c", "#b88b18", "#e6b63a", "#ffdc7a"],
  warmWhite: ["#4f463b", "#81766a", "#ada08c", "#d2c6b0", "#ece3d1"],
  coolWhite: ["#424852", "#6c7480", "#99a2ad", "#c2c9d1", "#e6eaee"],
  ivory: ["#55503f", "#878070", "#b6af9c", "#dad4c3", "#f7f3e8"],
  plastic: ["#141418", "#1f1f25", "#2b2b33", "#383842", "#474752"],
  wood: ["#2e1c12", "#4a2f1f", "#69442c", "#875a39", "#a57148"],
  woodDark: ["#22150e", "#352217", "#4b3221", "#61422c", "#775337"],
  chair: ["#101014", "#18181e", "#212129", "#2c2c36", "#383844"],
  floor: ["#141417", "#18181c", "#1c1c21", "#212126", "#26262c"],
  wall: ["#1d1d22", "#222228", "#28282e", "#2e2e35", "#35353d"],
  carpet: ["#17132a", "#1d1834", "#231d3f", "#2a2349", "#312953"],
  pot: ["#4a2a1c", "#74402a", "#9c5838", "#c0714a", "#d98d63"],
  potWhite: ["#5a5a5e", "#86868c", "#adadb3", "#cfcfd4", "#ececf0"],
  potGrey: ["#26282c", "#383b41", "#4c5058", "#62666f", "#7a7f89"],
  leaf: ["#0f2a16", "#1a4424", "#256133", "#348043", "#4ea05a"],
  leaf2: ["#152b10", "#24461a", "#356425", "#4a8434", "#66a349"],
  leaf3: ["#0e2a26", "#17443d", "#226157", "#2f8072", "#45a08f"],
  paper: ["#77736b", "#a3a097", "#c9c6bd", "#e6e3db", "#faf8f3"],
  mugT: ["#3f1a12", "#712f20", "#a84c34", "#d27053", "#ec977a"],
  key: ["#2a2a30", "#3a3a42", "#4c4c56", "#60606b", "#75757f"],
  glass: ["#9fd8ff"],
  board: ["#3b3f47", "#5d636e", "#cfd5dd", "#e8ecf1", "#f7f9fb"],
};

const mat = (ramp, extra = {}) => ({ ramp: RAMP[ramp] || ramp, outline: true, ...extra });

/** A local frame on the floor: origin, facing yaw (0 = facing the viewer). */
export function frame(origin, yaw) {
  const r = [Math.cos(yaw), 0, -Math.sin(yaw)], f = [Math.sin(yaw), 0, Math.cos(yaw)];
  return { o: origin, yaw, P: (x, y, z) => V.add(V.add(V.add(origin, V.mul(r, x)), [0, y, 0]), V.mul(f, z)) };
}

const STYLE = {
  claude: { body: "claudeKnit", hair: "claudeHair", skin: "skin", sleeve: "claudeKnit" },
  pi: { body: "hoodie", hair: "piHair", skin: "skin2", sleeve: "hoodie" },
  orchestrator: { body: "blazer", hair: "orchHair", skin: "skin", sleeve: "blazer" },
};

/**
 * A seated person. `look`: a world point they look at (their screen). pose: type | relax | sleep | away.
 * Returns the head prim and a `face(img)` painter for after rendering.
 */
export function person(s, kind, origin, yaw, { look, pose = "type", scale = 1, id, glint }) {
  const st = STYLE[kind], g = `person-${id}`;
  const F = frame(origin, yaw), k = scale;
  const P = (x, y, z) => F.P(x * k, y * k, z * k);
  const cloth = mat(st.body, { group: g, innerEdge: 3 });
  const skin = mat(st.skin, { group: g, innerEdge: 3, lightGain: 0.7 });
  const hairM = mat(st.hair, { group: g, innerEdge: 3 });
  const slump = pose === "sleep" ? 6 : 0;
  // torso, a little forward lean
  s.ell(P(0, 31 - slump * 0.4, 0), [8.6 * k, 10.5 * k, 5.6 * k], axes(yaw, pose === "relax" ? -0.2 : 0.12 + slump * 0.05), cloth);
  s.ell(P(-7.4, 38 - slump * 0.4, 0.2), [3.6 * k, 3.4 * k, 3.6 * k], axes(yaw), cloth);
  s.ell(P(7.4, 38 - slump * 0.4, 0.2), [3.6 * k, 3.4 * k, 3.6 * k], axes(yaw), cloth);
  if (kind === "orchestrator") { // shirt V and lapels
    s.ell(P(0, 37, 4.2), [3 * k, 4 * k, 1.8 * k], axes(yaw, 0.2), mat("shirt", { group: g, innerEdge: 3 }));
    s.ell(P(0, 33.5, 5.2), [0.9 * k, 3.4 * k, 0.8 * k], axes(yaw, 0.2), mat("gold", { group: g, innerEdge: 2 }));
  }
  if (kind === "claude") s.ell(P(0, 40.5, 2.6), [4.2 * k, 1.6 * k, 2.6 * k], axes(yaw), mat("paper", { group: g, innerEdge: 3 })); // cream collar
  if (kind === "pi") { // drawstrings
    s.limb(P(-1.6, 39, 5), P(-1.8, 33, 5.6), 0.45 * k, mat(["#7fe0c3", "#a7f3d0", "#c9f8e3", "#e6fdf3", "#ffffff"], { group: g, outline: false }));
    s.limb(P(1.6, 39, 5), P(1.8, 33.5, 5.6), 0.45 * k, mat(["#7fe0c3", "#a7f3d0", "#c9f8e3", "#e6fdf3", "#ffffff"], { group: g, outline: false }));
  }
  // arms
  const arm = (side) => {
    const sh = P(side * 7.8, 37.5 - slump * 0.4, 0.5);
    let el, wr, hand;
    if (pose === "relax") { el = P(side * 11, 47, -2); wr = P(side * 5, 52, -4); hand = P(side * 3, 51, -4.5); }
    else if (pose === "sleep") { el = P(side * 10, 26, 9); wr = P(side * 2, 27, 14); hand = P(side * 0.5, 27.5, 14.5); }
    else if (pose === "away") return;
    else { el = P(side * 9.6, 28.5, 6); wr = P(side * 4.6, 26.6, 14.5); hand = P(side * 3.8, 26.2, 16.6); }
    s.limb(sh, el, 2.7 * k, cloth); s.limb(el, wr, 2.3 * k, cloth);
    s.ell(hand, [1.9 * k, 1.3 * k, 2.3 * k], axes(yaw), skin);
  };
  arm(-1); arm(1);
  // neck, head (turned toward the look point), ears, hair
  const headC = pose === "sleep" ? P(0, 40, 11) : P(0, 51.5, 0.8);
  let hy = yaw;
  if (look && pose !== "sleep") { const d = V.sub(look, headC); hy = Math.atan2(d[0], d[2]); const dy = hy - yaw; hy = yaw + Math.max(-0.9, Math.min(0.9, Math.atan2(Math.sin(dy), Math.cos(dy)))); }
  const hp = pose === "sleep" ? 1.1 : pose === "relax" ? -0.15 : 0.12;
  const hax = axes(hy, hp);
  if (pose !== "sleep") s.ell(P(0, 43, 0.6), [2.8 * k, 3.4 * k, 2.8 * k], axes(yaw), skin);
  const R = [6.8 * k, 7.6 * k, 6.9 * k];
  const head = s.ell(headC, R, hax, skin);
  const at = (q) => V.add(V.add(V.add(headC, V.mul(hax[0], R[0] * q[0])), V.mul(hax[1], R[1] * q[1])), V.mul(hax[2], R[2] * q[2]));
  s.ell(at([0.98, 0.0, 0.05]), [0.9 * k, 1.7 * k, 1.2 * k], hax, skin);
  s.ell(at([-0.98, 0.0, 0.05]), [0.9 * k, 1.7 * k, 1.2 * k], hax, skin);
  const HR = R.map((r) => r * 1.12);
  if (kind === "claude") {
    // a soft bob: covers the back and the sides down to the jaw, a side-swept fringe
    s.ell(V.add(headC, V.mul(hax[1], 0.4 * k)), HR, hax, hairM, (q) => (q[2] > 0.18 && q[1] < 0.38 - q[0] * 0.25) || q[1] < -0.62);
  } else if (kind === "orchestrator") {
    s.ell(V.add(headC, V.mul(hax[1], 0.5 * k)), [HR[0] * 0.98, HR[1] * 0.95, HR[2]], hax, hairM, (q) => (q[2] > 0.05 && q[1] < 0.5) || q[1] < -0.1);
  } else {
    s.ell(V.add(headC, V.mul(hax[1], 0.5 * k)), HR, hax, hairM, (q) => (q[2] > 0.1 && q[1] < 0.45) || q[1] < -0.15);
    // the hood: a shell around the head, open at the face
    const hood = mat("hoodie", { group: g, innerEdge: 2 });
    s.ell(V.add(V.add(headC, V.mul(hax[1], 0.3 * k)), V.mul(hax[2], -0.6 * k)), [8.6 * k, 9.2 * k, 8.8 * k], hax, hood, (q) => (q[2] > 0.42 && q[1] < 0.62 && q[1] > -0.85) || q[1] < -0.85);
  }
  if (kind === "orchestrator") {
    const gold = mat("gold", { group: g, innerEdge: 2 });
    s.ell(V.add(headC, V.mul(hax[1], 0.5 * k)), R.map((r) => r * 1.22), hax, gold, (q) => Math.abs(q[2]) > 0.13 || q[1] < 0.15);
    s.ell(at([1.12, 0.0, 0.0]), [1.6 * k, 2.6 * k, 2.6 * k], hax, gold);
    s.ell(at([-1.12, 0.0, 0.0]), [1.6 * k, 2.6 * k, 2.6 * k], hax, gold);
    s.limb(at([-1.1, -0.25, 0.25]), at([-0.45, -0.62, 0.95]), 0.5 * k, mat("plastic", { group: g, outline: false }));
  }
  const face = (img) => {
    const eye = pose === "sleep" ? "#3a2a2a" : "#1d1418";
    const skinShade = RAMP[st.skin][1], lip = "#8c4538";
    for (const sx of [-0.37, 0.37]) {
      if (pose === "sleep") { paintOn(img, head, at([sx, -0.02, 0.93]), eye); continue; }
      paintOn(img, head, at([sx, 0.04, 0.93]), eye); paintOn(img, head, at([sx, -0.1, 0.93]), eye);
      paintOn(img, head, at([sx, 0.3, 0.9]), RAMP[st.hair][1]);
      if (kind === "pi" && glint) paintOn(img, head, at([sx + 0.12, 0.08, 0.92]), glint); // glasses catch the screen
    }

    paintOn(img, head, at([0.04, -0.2, 1.0]), skinShade);
    if (pose === "relax") { paintOn(img, head, at([-0.15, -0.46, 0.89]), lip); paintOn(img, head, at([0.15, -0.46, 0.89]), lip); paintOn(img, head, at([0, -0.52, 0.86]), lip); }
    else paintOn(img, head, at([0, -0.48, 0.88]), lip);
    paintOn(img, head, at([-0.5, -0.25, 0.83]), RAMP[st.skin][3]);
  };
  return { head, face, headC };
}

/** A CRT whose screen faces `toward` (a world point). model: claude | pi | orchestrator. */
export function crt(s, model, base, toward, { light, scale = 1, id }) {
  const d = V.sub(toward, base), yaw = Math.atan2(d[0], d[2]);
  const F = frame(base, yaw), k = scale, g = `crt-${id}`;
  const P = (x, y, z) => F.P(x * k, y * k, z * k);
  const ramp = model === "claude" ? "warmWhite" : model === "pi" ? "coolWhite" : "ivory";
  const body = mat(ramp, { group: g, innerEdge: 2.5 });
  const ax = axes(yaw);
  const vents = (lc) => (Math.abs(lc[1]) < 4 && Math.round(lc[0]) % 2 === 0 ? -0.12 : 0);
  if (model === "orchestrator") { s.ell(P(0, 1, -3), [8 * k, 1.4 * k, 7 * k], ax, body); s.box(P(0, 3, -3), [5 * k, 3 * k, 5 * k], ax, body); }
  else s.box(P(0, 1.2, -4), [15 * k, 2.4 * k, 12 * k], ax, body);
  const by = model === "orchestrator" ? 15 : 13.5;
  s.box(P(0, by, 0), [25 * k, 21 * k, 4.5 * k], ax, body);
  if (model === "pi") {
    s.box(P(0, by - 0.5, -6.5), [21 * k, 18 * k, 9 * k], ax, mat(ramp, { group: g, innerEdge: 2.5, tex: (lc) => (lc[2] < -4 && Math.abs(lc[0]) < 7 && Math.round(lc[1]) % 3 === 0 ? -0.12 : 0) }));
    s.box(P(0, by - 1, -12.5), [15 * k, 13 * k, 5 * k], ax, mat(ramp, { group: g, innerEdge: 2.5 }));
    s.box(P(4.5, by - 7, -15.2), [3 * k, 1.4 * k, 0.4 * k], ax, { ramp: ["#5eead4"], emit: "#5eead4", group: g });
  } else {
    s.box(P(0, by - 0.5, -7.5), [20 * k, 17 * k, 11 * k], ax, mat(ramp, { group: g, innerEdge: 2.5, tex: vents }));
    s.box(P(0, by - 1, -15), [13 * k, 11 * k, 6 * k], ax, mat(ramp, { group: g, innerEdge: 2.5, tex: (lc) => (Math.abs(lc[0]) < 4 && Math.abs(lc[1]) < 3 && Math.round(lc[1]) % 2 === 0 ? -0.15 : 0) }));
    if (model === "claude") s.box(P(-3, by - 6, -18.1), [4 * k, 2.5 * k, 0.4 * k], ax, mat("paper", { group: g, outline: false }));
  }
  // the screen faces away from us; its light falls on whoever sits in front of it
  s.box(P(0, by, 2.4), [20 * k, 16 * k, 0.4 * k], ax, { ramp: ["#000"], emit: light || "#101418", group: g });
  if (light) s.light(P(0, by, 14), light, 60 * k, 1);
  return { yaw };
}

export function desk(s, c, { w = 62, d = 30, h = 24, ramp = "wood", id }) {
  const g = `desk-${id}`, m = mat(ramp, { group: g, innerEdge: 3, tex: (lc, p, pt) => ((Math.floor(pt[0] / 1) + Math.floor(pt[2] * 0.25)) % 9 === 0 ? -0.08 : 0) });
  s.box([c[0], h - 1, c[2]], [w, 2, d], null, m);
  const leg = mat("woodDark", { group: g, innerEdge: 3 });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) s.box([c[0] + sx * (w / 2 - 2), (h - 2) / 2, c[2] + sz * (d / 2 - 2)], [2.4, h - 2, 2.4], null, leg);
  s.box([c[0], h - 9, c[2] + d / 2 - 2.2], [w - 6, 12, 1.2], null, leg);
}

export function chair(s, origin, yaw, { id, scale: k = 1, ramp = "chair" }) {
  const F = frame(origin, yaw), g = `chair-${id}`, m = mat(ramp, { group: g, innerEdge: 3 });
  const P = (x, y, z) => F.P(x * k, y * k, z * k);
  s.box(P(0, 20, -7.5), [17 * k, 22 * k, 2.6 * k], axes(yaw, -0.08), m);
  s.box(P(0, 17, 0), [16 * k, 2.6 * k, 15 * k], axes(yaw), m);
  s.box(P(0, 8, 0), [2 * k, 15 * k, 2 * k], axes(yaw), mat("plastic", { group: g }));
  s.ell(P(0, 1, 0), [9 * k, 1 * k, 9 * k], axes(yaw), mat("plastic", { group: g }));
}

export function keyboard(s, c, yaw, id) {
  s.box(c, [15, 1.4, 5], axes(yaw, -0.08), mat("key", { group: `kb-${id}`, innerEdge: 9, tex: (lc) => (Math.abs(lc[1]) > 0.5 && (Math.round(lc[0] * 0.9) + Math.round(lc[2])) % 2 === 0 ? -0.1 : 0) }));
}
export function mug(s, c, ramp, id) { s.ell(V.add(c, [0, 2.6, 0]), [2, 2.8, 2], null, mat(ramp, { group: `mug-${id}`, innerEdge: 3 })); s.ell(V.add(c, [2.1, 2.8, 0]), [0.9, 1.4, 0.5], null, mat(ramp, { group: `mug-${id}`, innerEdge: 3 })); }
export function papers(s, c, yaw, id) { s.box(c, [10, 0.8, 7], axes(yaw), mat("paper", { group: `pp-${id}`, innerEdge: 9, tex: (lc) => (Math.abs(lc[0]) < 3.5 && Math.round(lc[2]) % 2 === 0 && lc[1] > 0 ? -0.15 : 0) })); }

/** Seeded random plants: bush, snake, palm, monstera, cactus; pots vary too. */
export function plant(s, c, seed, { size = 1, id } = {}) {
  let x = seed * 9301 + 49297; const rnd = () => ((x = (x * 9301 + 49297) % 233280) / 233280);
  const types = ["bush", "snake", "palm", "monstera", "cactus"], t = types[Math.floor(rnd() * types.length)];
  const potR = ["pot", "potWhite", "potGrey"][Math.floor(rnd() * 3)], leafR = ["leaf", "leaf2", "leaf3"][Math.floor(rnd() * 3)];
  const g = `plant-${id}`, k = size * (0.85 + rnd() * 0.35);
  const potH = 9 * k;
  s.ell(V.add(c, [0, potH * 0.5, 0]), [5.5 * k, potH * 0.55, 5.5 * k], null, mat(potR, { group: g, innerEdge: 3 }), (q) => q[1] > 0.75 || q[1] < -0.95);
  s.ell(V.add(c, [0, potH * 0.88, 0]), [4.8 * k, 0.6, 4.8 * k], null, mat(["#140c08", "#21150e", "#2e1d13", "#3b2619", "#48301f"], { group: g, outline: false }));
  const leaf = mat(leafR, { group: g, innerEdge: 2 });
  const top = V.add(c, [0, potH, 0]);
  if (t === "bush") for (let i = 0; i < 9; i++) { const a = rnd() * 6.28, r = rnd() * 5 * k; s.ell(V.add(top, [Math.cos(a) * r, 5 * k + rnd() * 9 * k, Math.sin(a) * r]), [4.5 * k, 4 * k, 4.5 * k], axes(rnd() * 3, rnd()), leaf); }
  if (t === "snake") for (let i = 0; i < 6; i++) { const a = rnd() * 6.28; s.ell(V.add(top, [Math.cos(a) * 2.5 * k, 9 * k + rnd() * 5 * k, Math.sin(a) * 2.5 * k]), [1.6 * k, (10 + rnd() * 6) * k, 0.8 * k], axes(a, (rnd() - 0.5) * 0.3, (rnd() - 0.5) * 0.35), leaf); }
  if (t === "palm") for (let i = 0; i < 7; i++) { const a = (i / 7) * 6.28 + rnd(); s.ell(V.add(top, [Math.cos(a) * 6 * k, 10 * k + rnd() * 4 * k, Math.sin(a) * 6 * k]), [1.6 * k, 9 * k, 3 * k], axes(a + 1.57, 0, 1.0 + rnd() * 0.3), leaf); }
  if (t === "monstera") for (let i = 0; i < 6; i++) { const a = rnd() * 6.28, r = (2 + rnd() * 4) * k; s.limb(top, V.add(top, [Math.cos(a) * r, 8 * k + rnd() * 6 * k, Math.sin(a) * r]), 0.5 * k, leaf); s.ell(V.add(top, [Math.cos(a) * r * 1.6, 10 * k + rnd() * 8 * k, Math.sin(a) * r * 1.6]), [5 * k, 1.6 * k, 4 * k], axes(a, 0.4 + rnd() * 0.5), leaf); }
  if (t === "cactus") { s.ell(V.add(top, [0, 9 * k, 0]), [3.4 * k, 10 * k, 3.4 * k], null, mat(leafR, { group: g, innerEdge: 2, tex: (lc) => (Math.round(Math.atan2(lc[0], lc[2]) * 3) % 2 === 0 ? -0.1 : 0) })); s.limb(V.add(top, [2.5 * k, 8 * k, 0]), V.add(top, [6 * k, 13 * k, 0]), 1.6 * k, leaf); s.limb(V.add(top, [-2.5 * k, 6 * k, 0]), V.add(top, [-6 * k, 10 * k, 1]), 1.4 * k, leaf); }
}
