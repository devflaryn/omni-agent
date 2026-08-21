// Boot the real app.js against a DOM built from the REAL index.html ids, with a
// stubbed pywebview API, and run init() the way window.onload does. Static checks
// (node --check, the id audit) cannot catch a TypeError inside init(); this can.
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';

import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND = path.join(here, '..', '..', 'frontend');
const html = fs.readFileSync(path.join(FRONTEND, 'index.html'), 'utf8');
const ids = new Set([...html.matchAll(/\bid="([\w-]+)"/g)].map(m => m[1]));

class El {
  constructor(tag='div'){ this.tagName=tag; this.id=''; this._t=''; this._h='';
    this.style={}; this.children=[]; this.dataset={}; this._parent=null;
    this._classes=new Set(); this._q=new Map(); this._l={}; this.options=[];
    this.classList={ add:c=>this._classes.add(c), remove:c=>this._classes.delete(c),
      toggle:(c,on)=>{const v=on===undefined?!this._classes.has(c):on; v?this._classes.add(c):this._classes.delete(c); return v;},
      contains:c=>this._classes.has(c) }; }
  set className(v){ this._classes=new Set(String(v).split(/\s+/).filter(Boolean)); }
  get className(){ return [...this._classes].join(' '); }
  set textContent(v){ this._t=String(v); } get textContent(){ return this._t; }
  set innerHTML(v){ this._h=String(v); } get innerHTML(){ return this._h; }
  addEventListener(t,f){ this._l[t]=f; } removeEventListener(t){ delete this._l[t]; }
  click(){ this._l.click && this._l.click(); }
  appendChild(c){ if(c._frag){ c.children.forEach(g=>{g._parent=this;this.children.push(g);}); c.children=[]; return c;} c._parent=this; this.children.push(c); return c; }
  append(...cs){ cs.forEach(c=>this.appendChild(c)); }
  insertAdjacentHTML(_p,h){ this._h+=h; }
  remove(){ const p=this._parent; if(!p) return; const i=p.children.indexOf(this); if(i>=0) p.children.splice(i,1); this._parent=null; }
  scrollIntoView(){} setAttribute(k,v){ this[k]=v; } getAttribute(k){ return this[k]; }
  removeAttribute(k){ delete this[k]; } hasAttribute(k){ return this[k]!==undefined; }
  querySelector(s){ if(!this._q.has(s)) this._q.set(s,new El()); return this._q.get(s); }
  querySelectorAll(){ return []; }
  closest(){ return null; }
  focus(){}
}

const missing = [];
const doc = {
  _byId:new Map(),
  getElementById(id){
    if(!this._byId.has(id)){
      // Report any id app.js expects that the markup does not declare.
      if(!ids.has(id) && !['concurrency-dock','subagents-fab'].includes(id)) missing.push(id);
      const e=new El(); e.id=id; this._byId.set(id,e);
    }
    return this._byId.get(id);
  },
  createElement(t){ return new El(t); },
  createDocumentFragment(){ const f=new El('#frag'); f._frag=true; return f; },
  addEventListener(){}, documentElement:new El('html'),
};
doc.body = new El('body');

const calls = [];
const api = new Proxy({}, { get:(_,name)=>(...a)=>{ calls.push(String(name)); return Promise.resolve({ok:true, recent:[], options:[], configs:[], providers:[], tree:{name:'ws',children:[]}}); } });

const sb = {};
sb.window=sb; sb.globalThis=sb; sb.document=doc; sb.console=console;
sb.performance={now:()=>0}; sb.localStorage={getItem:()=>null,setItem:()=>{}};
sb.setInterval=()=>0; sb.clearInterval=()=>{}; sb.setTimeout=(f)=>{return 0;}; sb.clearTimeout=()=>{};
sb.requestAnimationFrame=()=>0; sb.addEventListener=(t,f)=>{ sb._onload = t==='load'?f:sb._onload; };
sb.Event=class{constructor(t){this.type=t;}}; sb.pywebview={api}; sb.navigator={clipboard:{writeText(){}}};
sb.prompt=()=>null; sb.confirm=()=>false; sb.alert=()=>{};
vm.createContext(sb);
for (const f of ['wave_stats.js','app.js'])
  vm.runInContext(fs.readFileSync(path.join(FRONTEND,f),'utf8'), sb, {filename:f});

let err = null;
try { await sb._onload(); } catch (e) { err = e; }

import assert from 'node:assert';

assert.equal(err, null,
  'init() threw during boot:\n' + (err && (err.stack || String(err))));
assert.deepEqual([...new Set(missing)], [],
  'init() looked up element ids that index.html does not declare');

// Boot must reach the backend for the things the first screen needs. If these
// stop being called, the app came up but is not actually wired to anything.
for (const expected of ['get_projects', 'get_model_options']) {
  assert.ok(calls.includes(expected), `boot never called ${expected}`);
}

// I5: ultra mode had no UI control at all — set_ultra/get_ultra had no caller,
// so the spec's header toggle did not exist and the keyword latched it on with
// no way back. The chip must reach the backend and mirror whatever it reports.
const ultraBtn = doc.getElementById('ultraToggle');
ultraBtn.click();
assert.ok(calls.includes('set_ultra'),
  'the ultra toggle is not wired to pywebview.api.set_ultra');
sb.window.__agent.onEvent({ type: 'ultra_mode', ultra: true });
assert.equal(ultraBtn.textContent, 'ultra on');
assert.equal(ultraBtn.classList.contains('is-on'), true, 'the chip shows the ON state');
assert.equal(ultraBtn.getAttribute('aria-checked'), 'true');
// …and a turn-scoped keyword expiring turns it back off without a click.
sb.window.__agent.onEvent({ type: 'ultra_mode', ultra: false });
assert.equal(ultraBtn.textContent, 'ultra off');
assert.equal(ultraBtn.classList.contains('is-on'), false);

console.log(`boot: OK (init clean, ${new Set(calls).size} backend calls)`);
