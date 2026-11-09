/* The keyboard layer: which keys are shortcuts, the Ctrl/⌘+K palette over chats and actions, and the shortcut sheet on "?".
   A key typed into a field stays the field's; only the documented Ctrl/⌘ combinations reach the app from there.
   The pure parts (shortcutFor, isTyping, rankItems, keyLabel) are tested in Node; the rest draws on demand. */

const TEXT_INPUTS = new Set(["text", "search", "email", "url", "tel", "password", "number", "date", "time", "datetime-local", "month", "week", ""]);
/** Is this element taking typed text? */
export function isTyping(t) {
  if (!t) return false;
  if (t.isContentEditable) return true;
  const tag = String(t.tagName || "").toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") return TEXT_INPUTS.has(String(t.type || "").toLowerCase());
  return false;
}

/** The action a key press means, or null. Ctrl on Windows and Linux, ⌘ on a Mac; never with Alt (AltGr is Ctrl+Alt). */
export function shortcutFor(e, { mac = false } = {}) {
  if (!e || e.altKey) return null;
  const k = e.key && e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (mod) {
    if (k === "k" && !e.shiftKey) return "palette";
    if (k === "o" && e.shiftKey) return "new-chat";
    if (k === ".") return "stop";
    // In the file editor Ctrl+B is the editor's: hiding the files there would close the file being edited.
    if (k === "b" && !e.shiftKey) return e.target?.classList?.contains("ce-ta") ? null : "files";
    if (k === "\\") return "history";
    if (k === "/") return "shortcuts";
    return null;
  }
  if (e.ctrlKey || e.metaKey || isTyping(e.target)) return null;
  if (k === "?") return "shortcuts";
  if (k === "/" && !e.shiftKey) return "focus-composer";
  return null;
}

/** "mod+shift+o" as this platform writes it: "Ctrl+Shift+O", or "⇧⌘O" on a Mac. */
export function keyLabel(spec, mac) {
  const parts = String(spec).split("+").filter(Boolean);
  const key = parts.pop() ?? "";
  const name = { esc: "Esc", enter: "Enter", "\\": "\\", ".": ".", "/": "/" }[key] ?? (key.length === 1 ? key.toUpperCase() : key);
  if (mac) {
    const sym = { shift: "⇧", mod: "⌘", alt: "⌥", ctrl: "⌃" };
    const order = ["ctrl", "alt", "shift", "mod"];
    return `${order.filter((p) => parts.includes(p)).map((p) => sym[p]).join("")}${key === "enter" ? "Return" : name}`;
  }
  return [...parts.map((p) => ({ mod: "Ctrl", shift: "Shift", alt: "Alt", ctrl: "Ctrl" })[p] ?? p), name].join("+");
}

/** The shortened span of `q`'s letters in order in `s`, as `[start, length]`, or null. */
function subsequence(s, q) {
  let best = null;
  for (let a = s.indexOf(q[0]); a >= 0; a = s.indexOf(q[0], a + 1)) {
    let j = a, ok = true;
    for (let i = 1; i < q.length; i++) { j = s.indexOf(q[i], j + 1); if (j < 0) { ok = false; break; } }
    if (!ok) break;
    if (!best || j - a + 1 < best[1]) best = [a, j - a + 1];
  }
  return best;
}
/** Items matching `query` (title, then subtitle), best first: a prefix, a word start, a substring, letters in order. */
export function rankItems(query, items) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return items;
  const scored = [];
  items.forEach((it, idx) => {
    const t = String(it.title || "").toLowerCase(), sub = String(it.sub || "").toLowerCase();
    let score = null;
    if (t.startsWith(q)) score = 0;
    else if (new RegExp(`(^|[^\\p{L}\\p{N}])${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "u").test(t)) score = 1;
    else if (t.includes(q)) score = 2;
    else { const m = q.length > 1 ? subsequence(t, q) : null; if (m) score = 3 + m[1] / 1000 + m[0] / 1e6; else if (sub.includes(q)) score = 4; }
    if (score != null) scored.push({ it, score, idx });
  });
  return scored.sort((a, b) => a.score - b.score || a.idx - b.idx).map((x) => x.it);
}

/** What the shortcut sheet lists, in order. */
export const SHORTCUTS = [
  ["mod+k", "Search chats and actions"],
  ["mod+shift+o", "New chat"],
  ["mod+.", "Stop the answer"],
  ["esc", "Stop the answer, from the message box"],
  ["mod+b", "Show or hide the files"],
  ["mod+\\", "Show or hide the chat history"],
  ["/", "Go to the message box"],
  ["enter", "Send"],
  ["shift+enter", "New line"],
  ["?", "Keyboard shortcuts"],
];
export const isMac = () => /Mac|iPhone|iPad/.test(globalThis.navigator?.platform || globalThis.navigator?.userAgent || "");

// ------------------------------------------------------------------ drawing
const make = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
let openLayer = null;
// A layer closed so that another can open in its place (the palette's "Keyboard shortcuts") hands on where the focus was
// before it, so the next one gives it back there. Only for the moment of that hand-over.
let handOff = null;
function closeLayer(restore = true) {
  if (!openLayer) return;
  const { scrim, prev, onKey } = openLayer;
  openLayer = null;
  document.removeEventListener("keydown", onKey, true);
  scrim.remove();
  if (restore && prev?.isConnected) prev.focus?.({ preventScroll: true });
  if (!restore) { handOff = prev; queueMicrotask(() => { handOff = null; }); }
}
export const layerOpen = () => !!openLayer;

/** A modal dialog is up (Settings, the account gate, New mission, an image): it owns the keyboard, so no shortcut acts behind it. */
const MODALS = ".modal, .ms-dlg-wrap, .lightbox";
export const modalOpen = () => [...document.querySelectorAll(MODALS)].some((m) => !m.hidden);

function layer(cls, label, onKey) {
  closeLayer(false);
  const prev = handOff?.isConnected ? handOff : document.activeElement;
  handOff = null;
  const scrim = make("div", `kbd-scrim ${cls}-scrim`);
  const box = make("div", cls);
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  box.setAttribute("aria-label", label);
  scrim.appendChild(box);
  scrim.addEventListener("mousedown", (e) => { if (e.target === scrim) closeLayer(); });
  const handler = (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeLayer(); return; } onKey?.(e); };
  document.addEventListener("keydown", handler, true);
  document.body.appendChild(scrim);
  openLayer = { scrim, prev, onKey: handler };
  return box;
}

/**
 * The palette. `items()` gives `[{ title, sub?, keys?, group, run }]` at the moment it opens; Enter or a click runs one.
 * Opened by a key it appears at once: no animation on what the keyboard does hundreds of times a day.
 */
export function openPalette(items, { mac = isMac() } = {}) {
  const all = items();
  let shown = all, sel = 0;
  const list = make("div", "pal-list");
  list.setAttribute("role", "listbox");
  list.id = "palList";
  const input = make("input", "pal-input");
  input.type = "text";
  input.placeholder = "Search chats and actions";
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-controls", "palList");
  input.setAttribute("aria-expanded", "true");
  input.setAttribute("aria-label", "Search chats and actions");
  input.autocomplete = "off";
  input.spellcheck = false;
  const pick = (it) => { closeLayer(false); it.run(); };
  const mark = () => {
    [...list.querySelectorAll(".pal-row")].forEach((r, i) => { r.classList.toggle("on", i === sel); r.setAttribute("aria-selected", String(i === sel)); });
    const on = list.querySelector(".pal-row.on");
    if (on) { input.setAttribute("aria-activedescendant", on.id); on.scrollIntoView({ block: "nearest" }); }
  };
  const render = () => {
    list.textContent = "";
    shown = rankItems(input.value, all).slice(0, 60);
    if (!shown.length) { list.appendChild(make("div", "pal-empty", "Nothing matches")); return; }
    let group = null;
    shown.forEach((it, i) => {
      if (!input.value.trim() && it.group !== group) { group = it.group; list.appendChild(make("div", "pal-group", group)); }
      const row = make("div", "pal-row");
      row.id = `palRow${i}`;
      row.setAttribute("role", "option");
      const main = make("span", "pal-main");
      main.append(make("span", "pal-title", it.title));
      if (it.sub) main.append(make("span", "pal-sub", it.sub));
      row.appendChild(main);
      if (it.keys) row.appendChild(make("kbd", "pal-kbd", keyLabel(it.keys, mac)));
      row.addEventListener("mousemove", () => { if (sel !== i) { sel = i; mark(); } });
      row.addEventListener("click", () => pick(it));
      list.appendChild(row);
    });
    mark();
  };
  const box = layer("pal", "Search chats and actions", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); if (shown.length) { sel = (sel + (e.key === "ArrowDown" ? 1 : -1) + shown.length) % shown.length; mark(); } }
    else if (e.key === "Enter" && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); if (shown[sel]) pick(shown[sel]); }
    else if (e.key === "Tab") e.preventDefault();
  });
  input.addEventListener("input", () => { sel = 0; render(); });
  box.append(input, list);
  render();
  input.focus();
}

/** The sheet of shortcuts. Its one control is Close, so Tab and Shift+Tab stay on it, as the palette keeps Tab in its box. */
export function openShortcuts({ mac = isMac() } = {}) {
  const x = make("button", "icon-btn kbd-close");
  const box = layer("kbd-sheet", "Keyboard shortcuts", (e) => { if (e.key === "Tab") { e.preventDefault(); x.focus(); } });
  const head = make("div", "kbd-head");
  head.appendChild(make("h2", null, "Keyboard shortcuts"));
  x.type = "button";
  x.setAttribute("aria-label", "Close");
  x.innerHTML = '<svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
  x.onclick = () => closeLayer();
  head.appendChild(x);
  const rows = make("dl", "kbd-rows");
  for (const [keys, what] of SHORTCUTS) {
    rows.appendChild(make("dt", null, what));
    const dd = make("dd");
    dd.appendChild(make("kbd", null, keyLabel(keys, mac)));
    rows.appendChild(dd);
  }
  box.append(head, rows);
  box.tabIndex = -1;
  box.focus();
}

/**
 * Global keys: `actions[name]()` for each shortcut. Escape and the layers' own keys are theirs. While a modal is open no
 * shortcut acts, Ctrl/⌘+K included: Esc closes the modal first. A Ctrl/⌘ combination still keeps the browser's meaning away.
 */
export function installKeys(actions, { mac = isMac() } = {}) {
  document.addEventListener("keydown", (e) => {
    if (e.defaultPrevented || e.isComposing || e.keyCode === 229) return;
    const name = shortcutFor(e, { mac });
    if (!name) return;
    if (modalOpen()) { if (e.ctrlKey || e.metaKey) e.preventDefault(); return; }
    if (openLayer && name !== "palette" && name !== "shortcuts") return;
    const fn = actions[name];
    if (!fn) return;
    // A shortcut the moment does not allow (Stop with nothing running) still keeps the browser's own meaning away.
    e.preventDefault();
    if (openLayer && ((name === "palette" && openLayer.scrim.classList.contains("pal-scrim")) || (name === "shortcuts" && openLayer.scrim.classList.contains("kbd-sheet-scrim")))) { closeLayer(); return; }
    fn();
  });
}
