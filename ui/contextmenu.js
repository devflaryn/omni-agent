/* Right-click menus (the file tree, the editor tabs): one open at a time, kept on screen, closed by a click
   elsewhere, Escape, scrolling or resizing; arrow keys and Enter work. A long press opens one on a phone,
   where there is no right click. */
import { el } from "./lib.js";

let open = null;

export function closeMenu() {
  if (!open) return;
  open.remove(); open = null;
  document.removeEventListener("pointerdown", outside, true);
  document.removeEventListener("keydown", keys, true);
  window.removeEventListener("blur", closeMenu);
  window.removeEventListener("resize", closeMenu);
  document.removeEventListener("scroll", closeMenu, true);
}
const outside = (e) => { if (open && !open.contains(e.target)) closeMenu(); };
function keys(e) {
  if (!open) return;
  const items = [...open.querySelectorAll("button:not([disabled])")];
  const i = items.indexOf(document.activeElement);
  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeMenu(); }
  else if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
  else if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
}

/** items: [{ label, kbd?, action, disabled?, danger? } | "-" ] (falsy entries skipped). */
export function showMenu(x, y, items) {
  closeMenu();
  const m = el("div", "menu ctx-menu");
  m.setAttribute("role", "menu");
  let sep = false;
  for (const it of items.filter(Boolean)) {
    if (it === "-") { sep = m.children.length > 0; continue; }
    if (sep) { m.appendChild(el("div", "cm-sep")); sep = false; }
    const b = el("button", it.danger ? "danger" : "");
    b.setAttribute("role", "menuitem");
    b.append(el("span", "cm-label", it.label));
    if (it.kbd) b.append(el("span", "cm-kbd", it.kbd));
    b.disabled = !!it.disabled;
    b.onclick = (e) => { e.stopPropagation(); closeMenu(); it.action?.(); };
    m.appendChild(b);
  }
  document.body.appendChild(m);
  open = m;
  const r = m.getBoundingClientRect(), vw = window.innerWidth, vh = window.innerHeight;
  m.style.left = `${Math.max(4, Math.min(x, vw - r.width - 4))}px`;
  m.style.top = `${Math.max(4, y + r.height > vh - 4 ? y - r.height : y)}px`;
  setTimeout(() => {
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", keys, true);
    window.addEventListener("blur", closeMenu);
    window.addEventListener("resize", closeMenu);
    document.addEventListener("scroll", closeMenu, true);
  });
  return m;
}

/** Calls fn(x, y, event) on right click, and on a ~half-second press with a finger that does not move.
 *  The click that ends a long press is swallowed so it does not also open the row. */
export function onContext(node, fn) {
  node.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); fn(e.clientX, e.clientY, e); });
  let timer = 0, sx = 0, sy = 0, fired = false;
  node.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) return;
    const t = e.touches[0]; sx = t.clientX; sy = t.clientY; fired = false;
    const target = e.target;
    clearTimeout(timer);
    timer = setTimeout(() => { fired = true; navigator.vibrate?.(10); fn(sx, sy, { target }); }, 480);
  }, { passive: true });
  const cancel = () => clearTimeout(timer);
  node.addEventListener("touchmove", (e) => { const t = e.touches[0]; if (Math.hypot(t.clientX - sx, t.clientY - sy) > 10) cancel(); }, { passive: true });
  node.addEventListener("touchend", (e) => { cancel(); if (fired) { e.preventDefault(); fired = false; } });
  node.addEventListener("touchcancel", cancel);
}
