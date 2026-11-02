// Omni office art (see docs/office-art.md): a mission drawn as an office. The orchestrator works in a purple room at the
// back; workers sit at desks on the open floor; subagents and shell jobs sit in front of their worker; the numbers
// (tasks, plan steps, tokens, time) are written into the scene.
//
// Two passes, so a live view stays cheap:
//   renderOffice(data) → { base, layout }   the 3D scene; only when someone's state or the set of agents changes
//   labelOffice(base, layout, data) → { img, hits }   copies the base and writes the text; every tick
import { Scene, render, V, px } from "./office-engine.js";
import { RAMP, CRT_SHAPES, person, crt, desktopCase, towerCase, wire, desk, chair, keyboard, mug, papers, plant } from "./office-props.js";
import { text as drawText, fit, textWidth } from "./office-font.js";

/** Screen light per state (null = the screen is off). */
export const LIGHT = { working: "#7dd3fc", idle: "#c4b5fd", done: "#86efac", failed: "#f87171", queued: "#fbbf24", stopped: null };
export const STATE_COLOR = { working: "#7dd3fc", idle: "#c4b5fd", done: "#86efac", failed: "#f87171", queued: "#fbbf24", stopped: "#8b8b94" };
const KIND = {
  claude: { tag: "CLAUDE", c: "#f0a585" },
  pi: { tag: "OPENCODE", c: "#9fb6cc" },
  shell: { tag: "SHELL", c: "#a1a1aa" },
};
const POSE = { working: "type", idle: "relax", done: "relax", failed: "type", stopped: "sleep" };
export const hash = (s) => { let h = 2166136261; for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return (h >>> 0) % 100000; };

// The layout: change these to move things around (world units ≈ pixels before the camera tilt).
export const LAYOUT = {
  pitch: 0.68, width: 520, cols: 4, colX: (i) => 72 + i * 125,
  back: -236, roomFront: -150, roomL: 170, roomR: 350,
  firstRowZ: -18, rowGap: 170, rowGapWithSubs: 300, subZ: 135, maxSubs: 2,
  keepDone: 5, keepDoneShell: 3,
};

// ---------------------------------------------------------------- mission → office data (pure)
const STATUS = { running: "working", starting: "working", done: "done", idle: "done", error: "failed", timeout: "failed", stalled: "failed", queued: "queued", cancelled: "stopped", interrupted: "stopped" };
export const officeState = (status) => STATUS[status] || "working";
const short = (n) => (n == null || !Number.isFinite(n) ? "-" : n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(Math.round(n)));
export function dur(ms) {
  if (!(ms > 0)) return "0S";
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
  return d ? `${d}D${h % 24}H` : h ? `${h}H${m % 60}M` : m ? `${m}M${s % 60 ? `${s % 60}S` : ""}` : `${s}S`;
}

/**
 * The office's data from a mission and its tree (ui/mission.js buildTree). `orch`: orchestratorState(); `now` for times.
 * Workers carry their subagents and shell jobs (every descendant, flattened, newest last).
 */
export function officeData(m, tree, orch, now = Date.now()) {
  const tasks = m.tasks || [];
  const OSTATE = { running: "working", idle: "idle", done: "done", error: "failed", cancelled: "stopped" };
  const flat = (n) => n.children.flatMap((c) => [c, ...flat(c)]);
  const agentOf = (n) => {
    const r = n.rec || {};
    return {
      id: n.id, kind: n.kind === "claude-sub" ? "claude" : n.kind === "shell" ? "shell" : n.kind === "claude" ? "claude" : "pi", state: officeState(n.status),
      task: n.taskId || "", title: n.title || "", step: r.plan?.done ?? null, of: r.plan?.of ?? null, turns: r.turns || 0,
      tokens: r.tokens ? short(r.tokens) : "-", time: r.startedAt ? dur((r.endedAt || now) - r.startedAt) : "-",
    };
  };
  const recent = (n) => n.rec?.endedAt || n.rec?.startedAt || n.rec?.createdAt || 0;
  const { tops, keepSub } = keepRecentDone([...tree.workers, ...tree.orphans], flat, recent);
  // The desks in front of a worker are few: whoever is still busy first, then the newest.
  const subOrder = (x, y) => (officeState(y.status) === "working") - (officeState(x.status) === "working") || recent(y) - recent(x);
  const workers = tops.map((w) => ({ ...agentOf(w), subs: flat(w).filter(keepSub).sort(subOrder).map(agentOf) }));
  const active = workers.filter((w) => w.state === "working").length;
  const o = m.orchestrator || {};
  return {
    seed: m.id,
    orchestrator: {
      state: OSTATE[orch?.px] || "idle", model: modelName(m.usingFallback ? m.fallbackModel : m.orchestratorModel),
      tasksDone: tasks.filter((t) => t.status === "done").length, tasksTotal: tasks.length, workers: (m.workers || []).length, busy: active,
      ctx: short(o.contextUsed || 0), ctxMax: o.contextWindow ? short(o.contextWindow) : "?", time: dur(now - (m.createdAt || now)), generation: o.generation || 1,
    },
    workers,
  };
}
/**
 * Finished desks leave the floor: of the workers done, the newest LAYOUT.keepDone stay; of the shell jobs done, wherever
 * they run, the newest LAYOUT.keepDoneShell. Failed and stopped ones stay, someone may need to look at them. Pure.
 */
export function keepRecentDone(tops, flat, recent) {
  const isDone = (n) => officeState(n.status) === "done";
  const newest = (list, keep) => new Set([...list].sort((a, b) => recent(b) - recent(a)).slice(0, keep));
  const isShell = (n) => n.kind === "shell";
  const doneShells = [...tops, ...tops.flatMap(flat)].filter((n) => isShell(n) && isDone(n));
  const keptShells = newest(doneShells, LAYOUT.keepDoneShell);
  const keptWorkers = newest(tops.filter((n) => !isShell(n) && isDone(n)), LAYOUT.keepDone);
  const keepSub = (n) => !isShell(n) || !isDone(n) || keptShells.has(n);
  return { tops: tops.filter((n) => !isDone(n) || (isShell(n) ? keptShells.has(n) : keptWorkers.has(n))), keepSub };
}
const modelName = (x) => (!x ? "" : typeof x === "string" ? x : `${x.provider ? `${x.provider}/` : ""}${x.id || ""}`);

/** What changes the 3D scene (everything else is text): when this string is the same, the base image is reused. */
export function sceneKey(d) {
  const w = d.workers.map((x) => `${x.id}:${x.kind}:${x.state}[${x.subs.slice(0, LAYOUT.maxSubs).map((s) => `${s.id}:${s.kind}:${s.state}`).join(",")}]${x.subs.length > LAYOUT.maxSubs ? "+" : ""}`).join("|");
  return `${d.seed}#${d.orchestrator.state}#${w}`;
}

// ---------------------------------------------------------------- the scene
function station(s, kind, x, z, { state, id, k = 1 }) {
  const light = LIGHT[state], h = hash(id), on = state === "working" || state === "failed";
  const shape = CRT_SHAPES[h % CRT_SHAPES.length], tone = (h >> 3) % 2, onCase = (h >> 5) % 2 === 0;
  desk(s, [x, 0, z], { id, w: 62 * k, d: 30 * k, h: 24 * k });
  const seat = [x + 11 * k, 0, z - 22 * k];
  chair(s, seat, 0, { id, scale: k });
  const headAt = V.add(seat, [0, 51 * k, 1]);
  const top = 24 * k, lift = onCase ? 7 * k : 0;
  const mon = [x - 9 * k, top + lift, z + 5 * k];
  let face = null;
  if (state !== "queued") face = person(s, kind, seat, -0.35, { look: V.add(mon, [0, 14 * k, 0]), pose: POSE[state] || "type", id, scale: k, glint: light }).face;
  const screen = crt(s, kind, mon, headAt, { light: state === "queued" ? LIGHT.queued : light, id, scale: k, shape, tone });
  if (onCase) {
    const pc = desktopCase(s, kind, [mon[0], top, mon[2]], headAt, { id, scale: k, tone, power: on });
    wire(s, [screen.back, pc.port], { id, scale: k });
  } else {
    const side = (h >> 7) % 2 ? 1 : -1, tx = x + side * 40 * k, tz = z + 2 * k;
    const pc = towerCase(s, kind, [tx, 0, tz], { id, scale: k, tone, power: on, side });
    const drop = [screen.back[0], 2 * k, z + 18 * k];
    wire(s, [screen.back, [screen.back[0], top - 3 * k, z + 17 * k], drop, [pc.port[0], 1.2 * k, drop[2]], pc.port], { id, scale: k });
  }
  keyboard(s, [x + 7 * k, 24 * k + 1, z - 6 * k], -0.35, id);
  if (k >= 1) { mug(s, [x + 24, 24, z + 4], h % 2 ? "mugT" : "potWhite", id); papers(s, [x - 22, 24.4, z + 9], (h % 7) * 0.2 - 0.6, id); }
  return { face, head: headAt };
}

/** A shell job: a small server rack, its lights by state. */
function rack(s, x, z, { state, id }) {
  const g = `rack-${id}`, body = { ramp: RAMP.plastic, outline: true, group: g, innerEdge: 3 };
  s.box([x, 17, z], [20, 34, 16], null, body);
  const led = state === "failed" ? "#f87171" : state === "working" ? "#4ade80" : state === "queued" ? "#fbbf24" : state === "done" ? "#86efac" : "#3f3f46";
  for (let i = 0; i < 4; i++) {
    s.box([x, 8 + i * 7, z + 8.1], [16, 5, 0.4], null, { ramp: ["#09090b", "#0f0f12", "#18181b", "#202024", "#27272a"], outline: false, group: g });
    s.box([x - 5, 8 + i * 7, z + 8.4], [1.4, 1.4, 0.4], null, { ramp: ["#000"], emit: (i + hash(id)) % 3 === 0 && state === "working" ? "#facc15" : led, group: g });
  }
  if (state === "working") s.light([x, 18, z + 14], "#4ade80", 22, 0.5);
  return { head: [x, 40, z] };
}

/** The 3D pass: → { base: { w, h, rgba, id, project }, layout } (layout: where each agent's text goes, its hit box). */
export function renderOffice(data) {
  const L = LAYOUT, s = new Scene();
  const W = L.width, { back, roomFront, roomL, roomR } = L;
  const faces = [], spots = [];
  // the building
  s.box([W / 2, -1, 0], [W + 200, 2, 1400], null, { ramp: RAMP.floor, dither: true, cast: false, ambient: 0.55 });
  s.box([W / 2, 60, back - 1], [W + 200, 120, 2], null, { ramp: RAMP.wall, dither: true, cast: false });
  s.box([W / 2, 2, back + 1], [W + 200, 4, 1], null, { ramp: RAMP.woodDark, cast: false });
  // the orchestrator's room: purple carpet and back wall, a LED board on the wall
  s.box([(roomL + roomR) / 2, 0.2, (back + roomFront) / 2], [roomR - roomL, 0.6, roomFront - back], null, { ramp: RAMP.carpet, dither: true, cast: false, ambient: 0.6 });
  s.box([(roomL + roomR) / 2, 58, back + 0.5], [roomR - roomL, 116, 1], null, { ramp: ["#1f1b33", "#252040", "#2b254a", "#322b55", "#383060"], dither: true, cast: false });
  const board = { c: [(roomL + roomR) / 2, 86, back + 1.6], w: 136, h: 36 };
  s.box(board.c, [board.w + 4, board.h + 4, 1.4], null, { ramp: RAMP.plastic, outline: true, group: "board" });
  s.box(V.add(board.c, [0, 0, 0.8]), [board.w, board.h, 0.4], null, { ramp: ["#000"], emit: "#0a0d16", group: "board" });
  // the orchestrator, monitors angled in toward him
  const O = data.orchestrator, oState = O.state || "idle", oLight = LIGHT[oState];
  const ox = (roomL + roomR) / 2, oz = -186;
  desk(s, [ox, 0, oz], { id: "orch", w: 112, d: 32, ramp: "woodDark" });
  const oSeat = [ox, 0, oz - 24];
  chair(s, oSeat, 0, { id: "orch", scale: 1.1, ramp: ["#120e1c", "#1c1530", "#271d44", "#33275a", "#40316e"] });
  const oHead = V.add(oSeat, [0, 51, 1]);
  const monL = [ox - 30, 24, oz + 4], monR = [ox + 30, 24, oz + 4];
  faces.push(person(s, "orchestrator", oSeat, 0, { look: V.add(hash(data.seed) % 2 ? monR : monL, [0, 15, 0]), pose: POSE[oState] || "type", id: "orch" }).face);
  crt(s, "orchestrator", monL, oHead, { light: oLight, id: "oL", scale: 1.05 });
  const oScreen = crt(s, "orchestrator", monR, oHead, { light: oLight, id: "oR", scale: 1.05 });
  const oPc = towerCase(s, "orchestrator", [ox + 70, 0, oz + 6], { id: "orch", power: oState === "working", side: 1 });
  wire(s, [oScreen.back, [oScreen.back[0], 21, oz + 17], [oScreen.back[0], 2, oz + 19], [oPc.port[0], 1.2, oz + 19], oPc.port], { id: "orch" });
  keyboard(s, [ox, 25, oz - 8], 0, "orch"); mug(s, [ox + 44, 24, oz + 2], "potWhite", "orch"); papers(s, [ox - 46, 24.4, oz + 6], 0.4, "orch");
  plant(s, [roomL + 14, 0, back + 14], hash(`${data.seed}:roomL`) % 97, { id: "rp1" }); plant(s, [roomR - 14, 0, back + 14], hash(`${data.seed}:roomR`) % 97, { id: "rp2", size: 1.2 });
  // wall decor on the open floor
  for (const [x, w] of [[50, 60], [470, 60]]) {
    s.box([x, 66, back + 1.2], [w, 30, 1.2], null, { ramp: ["#4a3420", "#6b4a2c", "#8a6038", "#a87644", "#c08a52"], outline: true, group: `pin${x}` });
    for (let i = 0; i < 5; i++) s.box([x - w / 2 + 8 + (hash(x + i) % (w - 14)), 56 + (hash(i * 7 + x) % 18), back + 2], [7, 7, 0.4], null, { ramp: [["#fde68a", "#fbcfe8", "#bae6fd", "#bbf7d0", "#fed7aa"][i]], ambient: 1, group: `pin${x}` });
  }
  s.ell([125, 92, back + 1.5], [6, 6, 0.8], null, { ramp: ["#c9c3b5", "#ddd7c9", "#ece6d8", "#f5f0e4", "#fffbf2"], outline: true, group: "clock", tex: (lc, p, pt) => (Math.abs(pt[0] - 125) < 0.6 && pt[1] > 92 && pt[1] < 96.5 ? -2 : Math.abs(pt[1] - 92) < 0.6 && pt[0] > 125 && pt[0] < 128 ? -2 : 0) });
  s.box([400, 70, back + 4], [44, 2, 8], null, { ramp: RAMP.wood, outline: true, group: "shelf" });
  const BOOKS = [["#7c2d12", "#9a3412", "#c2410c", "#ea580c", "#fb923c"], ["#1e3a5f", "#1e40af", "#2563eb", "#3b82f6", "#60a5fa"], ["#14532d", "#166534", "#15803d", "#16a34a", "#22c55e"], ["#3b0764", "#581c87", "#7e22ce", "#9333ea", "#a855f7"], ["#422006", "#713f12", "#a16207", "#ca8a04", "#eab308"]];
  for (let i = 0; i < 9; i++) s.box([382 + i * 4.2, 75 - (hash(i) % 3), back + 4], [3.4, 8 + (hash(i * 3) % 4), 6], null, { ramp: BOOKS[hash(i * 11) % 5], outline: true, group: "shelf" });
  // workers in rows; subagents and shell jobs in front of their worker
  const ws = data.workers || [];
  const rows = []; for (let i = 0; i < ws.length; i += L.cols) rows.push(ws.slice(i, i + L.cols));
  let z = L.firstRowZ;
  let end = z;
  rows.forEach((row, r) => {
    const hasSubs = row.some((w) => w.subs?.length);
    row.forEach((w, c) => {
      const x = L.colX(c);
      const st = w.kind === "shell" ? rack(s, x, z, w) : station(s, w.kind, x, z, { state: w.state, id: w.id });
      if (st.face) faces.push(st.face);
      const subs = (w.subs || []).slice(0, L.maxSubs).map((sb, i, all) => {
        const sx = x - 18 + i * 50 + (all.length === 1 ? 18 : 0), sz = z + L.subZ;
        const ss = sb.kind === "shell" ? rack(s, sx, sz, sb) : station(s, sb.kind, sx, sz, { state: sb.state, id: sb.id, k: 0.7 });
        if (ss.face) faces.push(ss.face);
        return { id: sb.id, x: sx, z: sz };
      });
      spots.push({ id: w.id, x, z, head: st.head, subs, more: Math.max(0, (w.subs || []).length - L.maxSubs) });
    });
    end = z + (hasSubs ? L.subZ + 13 : 18);
    z += hasSubs ? L.rowGapWithSubs : L.rowGap;
  });
  // plants, scattered but the same for a mission
  const pl = [[16, -200], [504, -200], [140, -160], [380, -160], [10, -40], [510, -20], [262, -60], [10, z - 90], [510, z - 110]];
  pl.forEach(([x, pz], i) => { if (pz < z + 10) plant(s, [x, 0, pz], hash(`${data.seed}:${i}`) % 97, { id: `p${i}`, size: 0.9 + (hash(`${data.seed}:s${i}`) % 5) * 0.1 }); });
  const ct = Math.cos(L.pitch), sn = Math.sin(L.pitch);
  const top = 118 * ct - back * sn + 4, bottom = -end * sn - 40;
  const base = render(s, { pitch: L.pitch, x0: 0, y0: Math.ceil(top), w: W, h: Math.ceil(top - bottom) });
  for (const f of faces) f(base);
  return { base, layout: { board, spots, roomFront, roomL, roomR, back } };
}

/** The text pass: → { img: { w, h, rgba }, hits: [{ id, x, y, w, h }] }. `selected`: an id to mark. */
export function labelOffice(base, layout, data, { selected = null } = {}) {
  const img = { ...base, rgba: new Uint8ClampedArray(base.rgba) };
  const project = base.project || projector(base.view);
  const P = (p) => project(p), hits = [], labels = [];
  const text = (s, x, y, c, o = {}) => {
    drawText(img, s, x, y, c, o);
    const w = textWidth(s, o.size || 3), x0 = o.align === "center" ? x - w / 2 : o.align === "right" ? x - w : x;
    labels.push({ s: String(s), x: x0, y, w, h: o.size === 5 ? 7 : 5 });
  };
  const O = data.orchestrator;
  // the orchestrator's LED board
  const [bx, by] = P(layout.board.c);
  text(`TASKS ${O.tasksDone}/${O.tasksTotal}`, bx - 4, by - 12, "#fbbf24", { size: 5, align: "right", shadow: null });
  text(`${O.workers} WORKERS`, bx + 6, by - 12, "#7dd3fc", { size: 5, shadow: null });
  const n = Math.min(60, O.tasksTotal || 0), pipW = n > 40 ? 1 : n > 30 ? 2 : 3, pw = n * (pipW + 1) - 1;
  for (let i = 0; i < n; i++) for (let yy = 0; yy < 2; yy++) for (let xx = 0; xx < pipW; xx++) px(img, bx - pw / 2 + i * (pipW + 1) + xx, by - 2 + yy, i < O.tasksDone ? "#a78bfa" : "#262636");
  text(`CTX ${O.ctx}/${O.ctxMax} · ${O.time} · ${O.busy || 0} BUSY`, bx, by + 3, "#9ca3af", { align: "center", shadow: null });
  text(fit(O.model, 32), bx, by + 10, "#6b7280", { align: "center", shadow: null });
  text(`ORCHESTRATOR · ${O.state}${O.generation > 1 ? ` · GEN ${O.generation}` : ""}`, bx, by - 22, "#c4b5fd", { align: "center" });
  const [ox0, oy0] = P([layout.roomL, 118, layout.back]), [ox1, oy1] = P([layout.roomR, 0, layout.roomFront]);
  hits.push({ id: "orchestrator", label: "Orchestrator", x: ox0, y: oy0, w: ox1 - ox0, h: oy1 - oy0 + 10 });
  const byId = new Map(); for (const w of data.workers) { byId.set(w.id, w); for (const sb of w.subs) byId.set(sb.id, sb); }
  for (const sp of layout.spots) {
    const w = byId.get(sp.id); if (!w) continue;
    const K = KIND[w.kind];
    const [hx, hy] = P(V.add(sp.head, [0, 14, 0]));
    text(`${K.tag}${w.task ? ` · ${w.task}` : ""}`, hx, hy - 4, K.c, { align: "center" });
    const [fx, fy] = P([sp.x, 0, sp.z + 18]);
    text(fit(w.title, 26), fx, fy + 1, "#e4e4e7", { align: "center" });
    if (w.of) {
      const of = Math.min(30, w.of), step = Math.min(w.step || 0, of), sw = Math.max(1, Math.min(6, Math.floor(60 / of))), tot = of * (sw + 1) - 1, label = `${w.step}/${w.of}`;
      const x0 = Math.round(fx - (tot + 4 + textWidth(label)) / 2);
      for (let i = 0; i < of; i++) for (let yy = 0; yy < 3; yy++) for (let xx = 0; xx < sw; xx++) px(img, x0 + i * (sw + 1) + xx, fy + 9 + yy, i < step ? (w.state === "failed" && i === step - 1 ? "#f87171" : w.state === "done" ? "#86efac" : "#7dd3fc") : i === step && w.state === "working" ? "#365a6e" : "#2c2c35");
      text(label, x0 + tot + 4, fy + 8, "#e4e4e7");
    } else text(w.kind === "shell" ? "SHELL JOB" : `NO PLAN YET · ${w.turns} TURNS`, fx, fy + 8, "#71717a", { align: "center" });
    const stats = `${w.tokens} TOK · ${w.time} · `, sw2 = textWidth(stats + w.state);
    text(stats, fx - sw2 / 2, fy + 15, "#a1a1aa");
    text(w.state, fx - sw2 / 2 + textWidth(stats) + 1, fy + 15, STATE_COLOR[w.state]);
    const [lx, ly] = P([sp.x - 33, 62, sp.z - 24]), [rx] = P([sp.x + 33, 0, sp.z]);
    hits.push({ id: w.id, label: `${K.tag} ${w.task} ${w.title}`, x: lx, y: ly - 6, w: rx - lx, h: fy + 22 - ly + 6 });
    for (const sub of sp.subs) {
      const sb = byId.get(sub.id); if (!sb) continue;
      const [tx, ty] = P([sub.x, 0, sub.z + 13]);
      text(fit(sb.title, 12), tx, ty + 1, "#d4d4d8", { align: "center" });
      text(`${sb.tokens} · ${sb.time}`, tx, ty + 8, STATE_COLOR[sb.state], { align: "center" });
      const [ax2, ay2] = P([sub.x - 24, 44, sub.z - 18]);
      hits.push({ id: sb.id, label: `${KIND[sb.kind].tag} subagent ${sb.title}`, x: ax2, y: ay2, w: 48, h: ty + 14 - ay2 });
    }
    if (sp.more) { const [tx, ty] = P([sp.x, 0, sp.z + LAYOUT.subZ + 13]); text(`+${sp.more} MORE`, tx, ty + 15, "#a1a1aa", { align: "center" }); }
  }
  // the selected one: pixel corner brackets
  const sel = hits.find((h) => h.id === selected);
  if (sel) {
    const c = "#e9d5ff", x0 = Math.round(sel.x) - 2, y0 = Math.round(sel.y) - 2, x1 = Math.round(sel.x + sel.w) + 2, y1 = Math.round(sel.y + sel.h) + 2;
    for (let i = 0; i < 6; i++) { px(img, x0 + i, y0, c); px(img, x0, y0 + i, c); px(img, x1 - i, y0, c); px(img, x1, y0 + i, c); px(img, x0 + i, y1, c); px(img, x0, y1 - i, c); px(img, x1 - i, y1, c); px(img, x1, y1 - i, c); }
  }
  return { img, hits, labels };
}

/** Where a world point lands on a rendered base (a base from the worker carries its camera, not this function). */
export const projector = ({ pitch, x0, y0 }) => { const ct = Math.cos(pitch), st = Math.sin(pitch); return (p) => [p[0] - x0, y0 - (p[1] * ct - p[2] * st), p[1] * st + p[2] * ct]; };

/**
 * Both passes, with the base reused while the scene key is unchanged: `const office = createOffice(); office.draw(data)`.
 * With `spawn` (→ a Worker running office-worker.js) the 3D pass leaves the main thread, so scrolling never stutters on it:
 * draw() keeps labelling the last finished base, returns null until there is one, and `onReady` asks for a redraw.
 */
export function createOffice({ spawn = null, onReady = () => {} } = {}) {
  let key = null, cached = null, worker = null, busy = false, wanted = null, version = 0;
  const post = () => {
    if (busy || !wanted || wanted.key === key) return;
    busy = true;
    worker.postMessage(wanted);
    wanted = null;
  };
  if (spawn) {
    try {
      worker = spawn();
      worker.onmessage = ({ data: r }) => { cached = { base: r.base, layout: r.layout }; key = r.key; version++; busy = false; post(); onReady(); };
      worker.onerror = (e) => { console.error("office worker", e.message); worker = null; busy = false; onReady(); };
    } catch (e) { console.error("office worker", e); worker = null; }
  }
  return {
    draw(data, opts) {
      const k = sceneKey(data);
      if (k !== key || !cached) {
        if (worker) { wanted = { key: k, data }; post(); }
        else { cached = renderOffice(data); key = k; version++; }
      }
      return cached ? { ...labelOffice(cached.base, cached.layout, data, opts), version } : null;
    },
    reset() { key = null; cached = null; },
  };
}
