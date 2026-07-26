// End-to-end frontend proof: the REAL app.js event handlers, driven by the exact
// telemetry sequence a delegating run emits (wave_started → subagent_started ×N →
// subagent_progress → subagent_done → wave_done), must make the persistent
// Subagents HUD appear and show the right running/done count, cumulative tokens,
// and elapsed time. This is the "delegating → HUD shows up" guarantee, verified
// against the actual shipped app.js (loaded in a VM over a minimal DOM shim) — no
// browser, no jsdom, no LLM.
import assert from 'node:assert';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND = path.join(here, '..', '..', 'frontend');

// --- minimal DOM shim: only what the dock/HUD code path touches -------------
class El {
  constructor(tag = 'div') {
    this.tagName = tag; this.id = ''; this._text = ''; this._html = '';
    this.style = {}; this.children = [];
    this._classes = new Set();
    this._q = new Map(); // querySelector results, cached & persistent per selector
    this.classList = {
      add: (c) => this._classes.add(c),
      remove: (c) => this._classes.delete(c),
      toggle: (c, on) => { const v = on === undefined ? !this._classes.has(c) : on;
                           if (v) this._classes.add(c); else this._classes.delete(c); return v; },
      contains: (c) => this._classes.has(c),
    };
  }
  set textContent(v) { this._text = String(v); }
  get textContent() { return this._text; }
  set innerHTML(v) { this._html = String(v); }   // template ignored; querySelector synthesizes nodes
  get innerHTML() { return this._html; }
  addEventListener(type, fn) { (this._listeners ||= {})[type] = fn; }
  click() { const f = this._listeners && this._listeners.click; if (f) f(); }
  appendChild(c) { c._parent = this; this.children.push(c); if (c.id) doc._byId.set(c.id, c); return c; }
  // Detach from the parent. app.js calls this on completed subagent track rows
  // (subagentDone) and on the Thinking… line, so the shim needs it to be real —
  // a no-op stub would let a test pass while the live UI leaked rows.
  remove() {
    const p = this._parent;
    if (!p) return;
    const i = p.children.indexOf(this);
    if (i >= 0) p.children.splice(i, 1);
    this._parent = null;
  }
  querySelector(sel) { if (!this._q.has(sel)) this._q.set(sel, new El()); return this._q.get(sel); }
  querySelectorAll() { return []; }
}

const doc = {
  _byId: new Map(),
  // Auto-create+cache leaf ids app.js only ever *queries* (chat, buttons…) so its
  // load-time `$()` lookups don't crash. But the containers app.js CREATES itself
  // (concurrency-dock, subagents-fab) must report absent until created, or the
  // `if (!el)` build guard in _dock() is defeated and the real element (with its
  // click handler) never gets built.
  _appCreated: new Set(['concurrency-dock', 'subagents-fab']),
  getElementById(id) {
    if (!this._byId.has(id)) {
      if (this._appCreated.has(id)) return null;
      const e = new El(); e.id = id; this._byId.set(id, e);
    }
    return this._byId.get(id);
  },
  createElement(tag) { return new El(tag); },
};
doc.body = new El('body');

// --- build the VM sandbox ---------------------------------------------------
let nowVal = 0;
const sandbox = {};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.document = doc;
sandbox.performance = { now: () => nowVal };
sandbox.console = console;
sandbox.setInterval = () => 0;      // no real ticking; handlers call _hudRender synchronously
sandbox.clearInterval = () => {};
sandbox.setTimeout = () => 0;       // freeze/grace timers are irrelevant to this assertion
sandbox.clearTimeout = () => {};
sandbox.requestAnimationFrame = () => 0;
sandbox.addEventListener = () => {};   // window.addEventListener('load', init)
sandbox.localStorage = { getItem: () => null, setItem: () => {} };
vm.createContext(sandbox);

function load(file) {
  const code = fs.readFileSync(path.join(FRONTEND, file), 'utf8');
  vm.runInContext(code, sandbox, { filename: file });
}
load('wave_stats.js'); // must load first (app.js reads window.SessionHudModel etc.)
load('app.js');

const onEvent = sandbox.window.__agent.onEvent;
assert.equal(typeof onEvent, 'function', 'app.js must expose window.__agent.onEvent');

function sess() {
  const dock = doc.getElementById('concurrency-dock');
  assert.ok(dock, 'the Subagents dock element must exist once telemetry starts');
  return dock.querySelector('.cdock-session');
}
function onEventFab() { doc.getElementById('subagents-fab').click(); }

// --- drive the exact delegating-run telemetry sequence ----------------------
const wave_id = 'w1';
nowVal = 1000; // epoch origin = first subagent start
onEvent({ type: 'wave_started', wave_id, size: 2, workers: 2 });
onEvent({ type: 'subagent_started', wave_id, sub_id: 's1', agent: 'native-analyst', task: 'map the check', mode: 'read' });
onEvent({ type: 'subagent_started', wave_id, sub_id: 's2', agent: 'researcher', task: 'find the flow', mode: 'read' });

// HUD appeared and shows 2 running, 0 done
let line = sess();
assert.equal(line.style.display, '', 'HUD session panel must be revealed');
assert.equal(line.querySelector('.cdock-sess-count').textContent, '2 running · 0 done');

// the sidebar auto-opens on a wave, and the FAB shows the running count
const dock = doc.getElementById('concurrency-dock');
assert.ok(dock.classList.contains('cdock-open'), 'sidebar must slide open on wave start');
const fab = doc.getElementById('subagents-fab');
assert.ok(fab.classList.contains('fab-visible'), 'FAB must be visible during activity');
assert.equal(fab.querySelector('.fab-count').textContent, '2', 'FAB shows running count');

// clicking the FAB toggles the sidebar closed, then open again (the whole point)
onEventFab(); // simulate a FAB click
assert.equal(dock.classList.contains('cdock-open'), false, 'FAB click closes the sidebar');
onEventFab();
assert.ok(dock.classList.contains('cdock-open'), 'FAB click reopens the sidebar');

// progress accrues cumulative per-subagent tokens
onEvent({ type: 'subagent_progress', wave_id, sub_id: 's1', step: 1, max_steps: 6, tokens: 6100 });
onEvent({ type: 'subagent_progress', wave_id, sub_id: 's2', step: 1, max_steps: 6, tokens: 900 });
assert.equal(sess().querySelector('.cdock-sess-tokens').textContent, '7k', 'session token total = 6100+900');

// one finishes → 1 running · 1 done, tokens preserved
onEvent({ type: 'subagent_done', wave_id, sub_id: 's1', agent: 'native-analyst', ok: true, elapsed_s: 3, tokens: 6100, steps: 3 });
assert.equal(sess().querySelector('.cdock-sess-count').textContent, '1 running · 1 done');

// second finishes, wave ends
onEvent({ type: 'subagent_done', wave_id, sub_id: 's2', agent: 'researcher', ok: true, elapsed_s: 4, tokens: 900, steps: 4 });
onEvent({ type: 'wave_done', wave_id });

// advance the clock and nudge a render (run end): elapsed reflects wall time since origin
nowVal = 1000 + 222000; // 3m42s
onEvent({ type: 'done' }); // onDone() → _hudEnd() → _hudRender()
line = sess();
assert.equal(line.querySelector('.cdock-sess-count').textContent, '0 running · 2 done');
assert.equal(line.querySelector('.cdock-sess-elapsed').textContent, '03:42', 'elapsed since first subagent');
assert.equal(line.querySelector('.cdock-sess-tokens').textContent, '7k', 'final token tally kept');

console.log('hud-integration ok');
