/**
 * Pixel-art avatars for the Mission view: an agent at its computer, drawn as crisp SVG rects (no image files).
 *
 *   claude        terracotta outfit with a light spark on the chest; its screen writes orange lines
 *   pi (OpenCode) charcoal hoodie, hood up, a diamond on the chest; its screen shows a green `>_` prompt
 *   orchestrator  purple conductor with a gold headset between two monitors; its screens show a node graph
 *   shell         a terminal on a desk, nobody at it
 *
 * The screen tells the state: working (animated), done (✓), failed (✗), queued (…), stopped (dark).
 * `spriteOf` / `screenGlyph` are pure (tested); `pixelAvatar` builds the SVG element.
 */

// Legend: . empty · K outline · S skin · E eyes · H hair · B outfit · L chest mark · P headset · C screen
//         k keyboard · m stand · D desk · d desk legs
const AGENT_CLAUDE = [
  "...KKKK.............",
  "..KHHHHK............",
  ".KHHHHHHK..KKKKKKKKK",
  ".KSSSSSSK..KCCCCCCCK",
  ".KSESSESK..KCCCCCCCK",
  ".KSSSSSSK..KCCCCCCCK",
  "..KSSSSK...KCCCCCCCK",
  ".KBBBBBBK..KCCCCCCCK",
  "KBBBLBBBBK.KKKKKKKKK",
  "KBBLLLBBSSK...KmK...",
  "KBBBLBBBK.SSkkkkkkk.",
  "DDDDDDDDDDDDDDDDDDDD",
  ".d................d.",
  ".d................d.",
];
const AGENT_OPENCODE = [
  "....KK..............",
  "..KKBBKK............",
  ".KBBBBBBK..KKKKKKKKK",
  ".KBSSSSBK..KCCCCCCCK",
  ".KBESSEBK..KCCCCCCCK",
  ".KBSSSSBK..KCCCCCCCK",
  "..KBSSBK...KCCCCCCCK",
  ".KBBBBBBK..KCCCCCCCK",
  "KBBBLBBBBK.KKKKKKKKK",
  "KBBLBLBBSSK...KmK...",
  "KBBBLBBBK.SSkkkkkkk.",
  "DDDDDDDDDDDDDDDDDDDD",
  ".d................d.",
  ".d................d.",
];
const ORCHESTRATOR = [
  ".........KKKK.............",
  "........KHHHHK............",
  "KKKKKKK.KPHHHHPK..KKKKKKK.",
  "KCCCCCK.KPSSSSPK..KCCCCCK.",
  "KCCCCCK.KSESSESK..KCCCCCK.",
  "KCCCCCK.KSSSSSSK..KCCCCCK.",
  "KCCCCCK..KSPSSK...KCCCCCK.",
  "KCCCCCK.KBBBBBBK..KCCCCCK.",
  "KKKKKKK.KBLBBLBK..KKKKKKK.",
  "...m....KBLLLLBK....m.....",
  "..mmm..SKBBBBBBKS..mmm....",
  "DDDDDDDDDDDDDDDDDDDDDDDDDD",
  ".d......................d.",
  ".d......................d.",
];
const SHELL = [
  "..............",
  "..............",
  ".KKKKKKKKKKK..",
  ".KCCCCCCCCCK..",
  ".KCCCCCCCCCK..",
  ".KCCCCCCCCCK..",
  ".KCCCCCCCCCK..",
  ".KCCCCCCCCCK..",
  ".KKKKKKKKKKK..",
  ".....KmK......",
  "...kkkkkkk....",
  "DDDDDDDDDDDDDD",
  ".d..........d.",
  ".d..........d.",
];

/** Where each sprite's screens are (glyphs are centred in them) and which columns are the person (it bobs). */
const SPRITES = {
  claude: { rows: AGENT_CLAUDE, screens: [{ x: 12, y: 3, w: 7, h: 5 }], person: [0, 10] },
  pi: { rows: AGENT_OPENCODE, screens: [{ x: 12, y: 3, w: 7, h: 5 }], person: [0, 10] },
  orchestrator: { rows: ORCHESTRATOR, screens: [{ x: 1, y: 3, w: 5, h: 5 }, { x: 19, y: 3, w: 5, h: 5 }], person: [7, 17] },
  shell: { rows: SHELL, screens: [{ x: 2, y: 3, w: 9, h: 5 }], person: null },
};

const BASE = { K: "#141414", E: "#141414", S: "#f1c27d", k: "#9ca3af", m: "#4b5563", D: "#6b4423", d: "#4a2f18" };
const PALETTES = {
  claude: { ...BASE, H: "#5b2c17", B: "#d97757", L: "#fff4ec", screen: "#2a140c", glyph: "#ffb38a" },
  pi: { ...BASE, B: "#64748b", L: "#f1f5f9", screen: "#07140c", glyph: "#4ade80" },
  orchestrator: { ...BASE, H: "#2d1b4e", P: "#f5c542", B: "#6d4bd8", L: "#f5c542", screen: "#160f2b", glyph: "#c4b5fd" },
  shell: { ...BASE, screen: "#0b0b0b", glyph: "#e5e5e5" },
};

const GLYPHS = {
  claude: ["ccc.c", "c.ccc", "cc...", "c.cc."],
  pi: ["c....", ".c...", "c.ccc", "....."],
  orchestrator: ["..c..", ".c.c.", "c...c", "....."],
  shell: ["c....", ".c...", "c.ccc", "....."],
  done: ["....c", "...c.", "c.c..", ".c..."],
  failed: ["c...c", ".c.c.", ".c.c.", "c...c"],
  waiting: [".....", "c.c.c", ".....", "....."],
};
const ACTIVE = new Set(["running", "starting", "thinking"]);
const FAILED = new Set(["error", "timeout", "stalled", "interrupted"]);

/** The sprite family for a node kind ("claude-sub" draws as claude; unknown kinds as OpenCode). Pure. */
export function spriteOf(kind) {
  if (kind === "claude" || kind === "claude-sub") return "claude";
  if (kind === "orchestrator" || kind === "shell") return kind;
  return "pi";
}

/** What the screen shows for a status: { glyph rows | null, mode: run|done|failed|waiting|off }. Pure. */
export function screenGlyph(sprite, status) {
  if (ACTIVE.has(status)) return { rows: GLYPHS[sprite], mode: "run" };
  if (status === "done") return { rows: GLYPHS.done, mode: "done" };
  if (FAILED.has(status)) return { rows: GLYPHS.failed, mode: "failed" };
  if (status === "queued" || status === "waiting") return { rows: GLYPHS.waiting, mode: "waiting" };
  if (status === "idle") return { rows: GLYPHS[sprite], mode: "idle" };
  return { rows: null, mode: "off" };
}

/** Every lit pixel of a sprite in a status: [{x, y, color, part: person|glyph|scene}]. Pure. */
export function pixelsOf(kind, status) {
  const sprite = spriteOf(kind);
  const def = SPRITES[sprite], pal = PALETTES[sprite];
  const { rows, mode } = screenGlyph(sprite, status);
  const out = [];
  const screenColor = mode === "off" ? "#050505" : pal.screen;
  def.rows.forEach((row, y) => [...row].forEach((ch, x) => {
    if (ch === ".") return;
    const color = ch === "C" ? screenColor : pal[ch];
    if (!color) return;
    const person = def.person && x >= def.person[0] && x <= def.person[1] && y <= 10 && ch !== "C" && !(sprite !== "orchestrator" && x >= 11);
    out.push({ x, y, color, part: person ? "person" : "scene" });
  }));
  if (rows) {
    const color = mode === "failed" ? "#ef4444" : mode === "done" ? "#86efac" : pal.glyph;
    for (const s of def.screens) {
      const gw = rows[0].length, gh = rows.length;
      const ox = s.x + Math.floor((s.w - gw) / 2), oy = s.y + Math.floor((s.h - gh) / 2);
      rows.forEach((r, gy) => [...r].forEach((ch, gx) => { if (ch === "c" && gx < s.w && gy < s.h) out.push({ x: ox + gx, y: oy + gy, color, part: "glyph" }); }));
    }
  }
  return { width: def.rows[0].length, height: def.rows.length, pixels: out, mode, sprite };
}

const SVG = "http://www.w3.org/2000/svg";
const LABEL = { claude: "Claude Code agent", pi: "OpenCode agent", orchestrator: "Orchestrator", shell: "Shell job" };

/** The avatar as an <svg> (each pixel `scale` CSS pixels). Classes drive the animation: .px-run bobs and types. */
export function pixelAvatar(kind, status, { scale = 3, title } = {}) {
  const { width, height, pixels, mode, sprite } = pixelsOf(kind, status);
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("width", String(width * scale));
  svg.setAttribute("height", String(height * scale));
  svg.setAttribute("shape-rendering", "crispEdges");
  svg.setAttribute("role", "img");
  svg.setAttribute("class", `px-avatar px-${sprite} px-${mode}`);
  const t = document.createElementNS(SVG, "title");
  t.textContent = title || `${LABEL[sprite]} · ${status || "unknown"}`;
  svg.append(t);
  const groups = { scene: document.createElementNS(SVG, "g"), person: document.createElementNS(SVG, "g"), glyph: document.createElementNS(SVG, "g") };
  groups.person.setAttribute("class", "px-person");
  groups.glyph.setAttribute("class", "px-glyph");
  // Horizontal runs of one colour become one rect.
  const key = (p) => `${p.part}|${p.y}|${p.color}`;
  const sorted = [...pixels].sort((a, b) => (a.part > b.part ? 1 : a.part < b.part ? -1 : a.y - b.y || a.x - b.x));
  let run = null;
  const flush = () => { if (!run) return; const r = document.createElementNS(SVG, "rect"); r.setAttribute("x", run.x); r.setAttribute("y", run.y); r.setAttribute("width", run.w); r.setAttribute("height", 1); r.setAttribute("fill", run.color); groups[run.part].append(r); run = null; };
  for (const p of sorted) {
    if (run && key(run) === key(p) && run.x + run.w === p.x) { run.w++; continue; }
    flush();
    run = { ...p, w: 1 };
  }
  flush();
  svg.append(groups.scene, groups.person, groups.glyph);
  return svg;
}

export const AVATAR_LABELS = LABEL;
