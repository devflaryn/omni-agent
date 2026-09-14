/* Drag handles that change a column's width only. Each column has a CSS variable (--explorer, --preview,
   --panel); dragging sets it on :root and remembers it in localStorage. */

const COLS = {
  explorer: { v: "--explorer", min: 180, max: 640, side: "right" },
  preview: { v: "--preview", min: 260, max: 1100, side: "right" },
  panel: { v: "--panel", min: 260, max: 800, side: "left" },
};
const root = document.documentElement;
const key = (name) => `omni.width.${name}`;

function apply(name, px) {
  const c = COLS[name];
  const w = Math.max(c.min, Math.min(c.max, Math.round(px)));
  root.style.setProperty(c.v, `${w}px`);
  return w;
}

export function initResizers() {
  for (const name of Object.keys(COLS)) {
    try { const saved = Number(localStorage.getItem(key(name))); if (saved) apply(name, saved); } catch { /* */ }
  }
  document.querySelectorAll(".resizer[data-for]").forEach((h) => {
    const name = h.dataset.for, c = COLS[name];
    if (!c) return;
    h.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const col = h.closest("aside") || h.parentElement;
      const startX = e.clientX, startW = col.getBoundingClientRect().width;
      let w = startW;
      document.body.classList.add("resizing");
      h.setPointerCapture(e.pointerId);
      const move = (ev) => { const dx = ev.clientX - startX; w = apply(name, c.side === "right" ? startW + dx : startW - dx); };
      const up = () => {
        h.removeEventListener("pointermove", move); h.removeEventListener("pointerup", up); h.removeEventListener("pointercancel", up);
        document.body.classList.remove("resizing");
        try { localStorage.setItem(key(name), String(w)); } catch { /* */ }
      };
      h.addEventListener("pointermove", move);
      h.addEventListener("pointerup", up);
      h.addEventListener("pointercancel", up);
    });
    h.addEventListener("dblclick", () => { root.style.removeProperty(c.v); try { localStorage.removeItem(key(name)); } catch { /* */ } });
  });
}
