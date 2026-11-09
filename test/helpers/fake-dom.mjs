// A DOM just big enough for ui/keys.js and ui/appearance.js: elements, classes, focus, and key events that run capture
// listeners on the document, then bubble from the focused element up to the document. Install with `withFakeDom(fn)`.

/** One compound selector (`tag#id.a.b`) against an element. */
function matches(el, sel) {
  const m = /^([a-z0-9]*)(?:#([\w-]+))?((?:\.[\w-]+)*)$/i.exec(sel.trim());
  if (!m) throw new Error(`fake-dom: unsupported selector ${sel}`);
  if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
  if (m[2] && el.id !== m[2]) return false;
  for (const c of m[3].split(".").filter(Boolean)) if (!el.classList.contains(c)) return false;
  return true;
}

export class FakeEl {
  constructor(doc, tag) {
    this.ownerDocument = doc;
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.className = "";
    this.id = "";
    this.attrs = {};
    this.dataset = {};
    this.hidden = false;
    this.tabIndex = -1;
    this.listeners = [];
    this.text = "";
    this.html = "";
    this.style = {};
    this.value = "";
  }
  get classList() {
    const self = this;
    const list = () => self.className.split(/\s+/).filter(Boolean);
    return {
      contains: (c) => list().includes(c),
      add: (...cs) => { self.className = [...new Set([...list(), ...cs])].join(" "); },
      remove: (...cs) => { self.className = list().filter((x) => !cs.includes(x)).join(" "); },
      toggle: (c, on) => { const has = list().includes(c); const want = on === undefined ? !has : !!on; if (want && !has) self.classList.add(c); if (!want && has) self.classList.remove(c); return want; },
    };
  }
  get parentElement() { return this.parentNode instanceof FakeEl ? this.parentNode : null; }
  get isConnected() { let n = this; while (n) { if (n === this.ownerDocument.body) return true; n = n.parentNode; } return false; }
  set textContent(v) { this.text = String(v ?? ""); this.children = []; }
  get textContent() { return this.text + this.children.map((c) => c.textContent).join(""); }
  set innerHTML(v) { this.html = String(v); this.text = ""; for (const c of this.children) c.parentNode = null; this.children = []; }
  get innerHTML() { return this.html; }
  appendChild(c) { if (typeof c === "string") { this.text += c; return c; } c.remove(); c.parentNode = this; this.children.push(c); return c; }
  append(...cs) { for (const c of cs) this.appendChild(c); }
  remove() {
    if (!this.parentNode) return;
    const doc = this.ownerDocument;
    if (this.contains(doc.activeElement)) doc.activeElement = doc.body; // a removed element takes the focus with it
    this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
    this.parentNode = null;
  }
  contains(o) { for (let n = o; n; n = n.parentNode) if (n === this) return true; return false; }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === "id") this.id = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(type, fn, opt) { this.listeners.push({ type, fn, capture: opt === true || !!opt?.capture }); }
  removeEventListener(type, fn) { this.listeners = this.listeners.filter((l) => l.type !== type || l.fn !== fn); }
  focus() { if (this.isConnected) this.ownerDocument.activeElement = this; }
  blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body; }
  click() { this.ownerDocument.dispatch(this, { type: "click" }); }
  scrollIntoView() { /* nothing to scroll */ }
  all() { const out = []; for (const c of this.children) { out.push(c); out.push(...c.all()); } return out; }
  querySelectorAll(sel) { const parts = sel.split(",").map((s) => s.trim()); return this.all().filter((e) => parts.some((p) => matches(e, p))); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
}

export class FakeDocument {
  constructor() {
    this.listeners = [];
    this.documentElement = new FakeEl(this, "html");
    this.body = new FakeEl(this, "body");
    this.body.parentNode = null;
    this.activeElement = this.body;
  }
  createElement(tag) { return new FakeEl(this, tag); }
  addEventListener(type, fn, opt) { this.listeners.push({ type, fn, capture: opt === true || !!opt?.capture }); }
  removeEventListener(type, fn, opt) { const capture = opt === true || !!opt?.capture; this.listeners = this.listeners.filter((l) => l.type !== type || l.fn !== fn || l.capture !== capture); }
  querySelectorAll(sel) { return this.body.querySelectorAll(sel); }
  querySelector(sel) { return this.body.querySelector(sel); }
  getElementById(id) { return this.body.all().find((e) => e.id === id) ?? null; }
  /** An event at `target`: the document's capture listeners, then the target and its parents, then the document's own. */
  dispatch(target, init) {
    let stopped = false;
    const ev = { key: "", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, isComposing: false, keyCode: 0, ...init, target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { stopped = true; } };
    for (const l of [...this.listeners]) if (l.capture && l.type === ev.type && !stopped) l.fn.call(this, ev);
    for (let n = target; n && !stopped; n = n.parentNode) {
      for (const l of [...n.listeners]) if (l.type === ev.type && !stopped) l.fn.call(n, ev);
      if (ev.type === "click" && n === target && typeof n.onclick === "function" && !stopped) n.onclick(ev);
    }
    for (const l of [...this.listeners]) if (!l.capture && l.type === ev.type && !stopped) l.fn.call(this, ev);
    return ev;
  }
  /** A key pressed wherever the focus is. */
  key(key, mods = {}) { return this.dispatch(this.activeElement, { type: "keydown", key, ...mods }); }
}

/** Runs `fn(doc)` with a fresh fake `document` installed globally, and puts the old one back after. */
export async function withFakeDom(fn) {
  const prev = globalThis.document;
  const doc = new FakeDocument();
  globalThis.document = doc;
  try { return await fn(doc); } finally { if (prev === undefined) delete globalThis.document; else globalThis.document = prev; }
}
