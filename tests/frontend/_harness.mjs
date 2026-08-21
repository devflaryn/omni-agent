// Shared loader for the frontend tests: runs the REAL frontend/wave_stats.js and
// frontend/app.js inside a Node `vm` over a minimal DOM shim, so assertions are
// made against shipped code rather than a reimplementation.
//
// test_hud_integration.mjs predates this and keeps its own bespoke shim (it needs
// a stricter getElementById that reports app-created containers as absent). Tests
// that just need "load app.js and call a function" should use this instead.
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND = path.join(here, '..', '..', 'frontend');

export class El {
  constructor(tag = 'div') {
    this.tagName = tag; this.id = ''; this._text = ''; this._html = '';
    this.style = {}; this.children = []; this._parent = null;
    this.dataset = {};   // data-* attributes, as the real DOM exposes them
    this.title = '';
    this._classes = new Set();
    this._q = new Map();
    this._listeners = {};
    this.classList = {
      add: (c) => this._classes.add(c),
      remove: (c) => this._classes.delete(c),
      toggle: (c, on) => {
        const v = on === undefined ? !this._classes.has(c) : on;
        if (v) this._classes.add(c); else this._classes.delete(c);
        return v;
      },
      contains: (c) => this._classes.has(c),
    };
  }
  // className and classList must share one store, or code that sets
  // `el.className = 'a b'` becomes invisible to classList.contains().
  set className(v) {
    this._classes = new Set(String(v).split(/\s+/).filter(Boolean));
  }
  get className() { return [...this._classes].join(' '); }
  set textContent(v) { this._text = String(v); }
  get textContent() { return this._text; }
  set innerHTML(v) { this._html = String(v); }
  get innerHTML() { return this._html; }
  addEventListener(type, fn) { this._listeners[type] = fn; }
  removeEventListener(type) { delete this._listeners[type]; }
  click() { const f = this._listeners.click; if (f) f(); }
  appendChild(c) {
    if (c._isFragment) {
      c.children.forEach(g => { g._parent = this; this.children.push(g); });
      c.children = [];
      return c;
    }
    c._parent = this; this.children.push(c); return c;
  }
  append(...cs) { cs.forEach(c => this.appendChild(c)); }
  get firstChild() { return this.children[0] || null; }
  insertAdjacentHTML(_pos, html) { this._html += html; }
  remove() {
    const p = this._parent;
    if (!p) return;
    const i = p.children.indexOf(this);
    if (i >= 0) p.children.splice(i, 1);
    this._parent = null;
  }
  scrollIntoView() {}
  querySelector(sel) { if (!this._q.has(sel)) this._q.set(sel, new El()); return this._q.get(sel); }
  // Depth-first search over real children, so tests can assert on rendered
  // trees rather than only on return values.
  querySelectorAll(sel) {
    const cls = sel.startsWith('.') ? sel.slice(1) : null;
    const out = [];
    const walk = (n) => n.children.forEach(c => {
      if (cls && c._classes.has(cls)) out.push(c);
      walk(c);
    });
    walk(this);
    return out;
  }
  setAttribute(k, v) { this[k] = v; }
  getAttribute(k) { return this[k]; }
  // Real elements have these; the shim did not, so any code path that cleared
  // or probed an attribute blew up here while working fine in the webview.
  // test_boot.mjs caught it the first time aria-busy was cleared during init.
  removeAttribute(k) { delete this[k]; }
  hasAttribute(k) { return this[k] !== undefined; }
  // Used to skip focusables inside a hidden subtree in the modal focus trap.
  closest(sel) {
    const cls = sel.startsWith('.') ? sel.slice(1) : null;
    let n = this;
    while (n) {
      if (cls && n._classes && n._classes.has(cls)) return n;
      n = n._parent || null;
    }
    return null;
  }
}

// Load app.js into a fresh sandbox. `now` is a mutable clock the caller can drive.
export function loadApp() {
  const doc = {
    _byId: new Map(),
    getElementById(id) {
      if (!this._byId.has(id)) { const e = new El(); e.id = id; this._byId.set(id, e); }
      return this._byId.get(id);
    },
    createElement(tag) { return new El(tag); },
    // A fragment is just a detached parent for these purposes; appendChild
    // on the real container then re-parents its children.
    createDocumentFragment() {
      const f = new El('#fragment');
      f._isFragment = true;
      return f;
    },
    addEventListener() {},
  };
  doc.body = new El('body');
  doc.documentElement = new El('html');

  const clock = { now: 0 };
  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.document = doc;
  sandbox.performance = { now: () => clock.now };
  sandbox.console = console;
  sandbox.setInterval = () => 0;
  sandbox.clearInterval = () => {};
  sandbox.setTimeout = () => 0;
  sandbox.clearTimeout = () => {};
  sandbox.requestAnimationFrame = () => 0;
  sandbox.addEventListener = () => {};
  sandbox.localStorage = { getItem: () => null, setItem: () => {} };
  sandbox.Event = class Event { constructor(t) { this.type = t; } };
  vm.createContext(sandbox);

  // Loaded as three separate scripts, exactly as index.html does it.
  for (const f of ['wave_stats.js', 'icons.js', 'app.js']) {
    vm.runInContext(fs.readFileSync(path.join(FRONTEND, f), 'utf8'), sandbox, { filename: f });
  }

  // Evaluate an expression in the realm's global lexical scope. app.js declares
  // TOOL_META and friends with `const`, which creates a global *lexical* binding
  // rather than a property on globalThis — visible to later scripts in the same
  // context, but not as sandbox.TOOL_META. This reaches them without exporting
  // anything from production code purely for testing.
  const evalInApp = (expr) => vm.runInContext(expr, sandbox, { filename: 'eval' });

  return { sandbox, doc, clock, evalInApp };
}
