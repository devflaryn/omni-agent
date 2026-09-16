import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Exercise the real renderer functions with a minimal DOM. No browser/network.
class Element {
  constructor() { this.children = []; this.textContent = ''; this.className = ''; this.scrollHeight = 100; this.scrollTop = 0; this.clientHeight = 100; }
  appendChild(el) { this.children.push(el); el.parent = this; return el; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(el => el !== this); }
  setAttribute() {}
  get firstElementChild() { return this.children[0]; }
  querySelector(selector) {
    const name = selector.slice(1);
    return this.children.find(el => el.className.split(' ').includes(name)) || null;
  }
}
const main = new Element();
const dock = new Element();
const context = vm.createContext({
  document: {createElement: () => new Element()},
  appendRow: el => main.appendChild(el), scrollDown() {},
  _dock: () => dock, _waveRowKey: ev => ev.sub_id,
});
const source = fs.readFileSync(new URL('../../frontend/app.js', import.meta.url), 'utf8');
vm.runInContext(source.slice(source.indexOf('const _assistantStreams'), source.indexOf('function renderFinalAnswer')), context);
vm.runInContext(source.slice(source.indexOf('const _subagentChats'), source.indexOf('function subagentProgress')), context);
const run = code => vm.runInContext(code, context);
run("renderAssistantStream({stream_id:'a', phase:'delta',content:'Hel'})");
run("renderAssistantStream({stream_id:'a', phase:'delta',content:'Hello'})");
assert.equal(main.children.length, 1);
assert.equal(main.children[0].textContent, 'Hello');
run("renderAssistantStream({stream_id:'a', phase:'end'})");
assert.equal(main.children.length, 0, 'completion removes draft before authoritative message');
run("subagentStream({sub_id:'one',agent:'worker',stream_id:'s',phase:'delta',content:'Partial'})");
run("subagentStream({sub_id:'two',agent:'worker',stream_id:'t',phase:'delta',content:'Other'})");
assert.equal(run("_subagentChats.get('one').messages.children[0].textContent"), 'Partial');
assert.equal(run("_subagentChats.get('two').messages.children[0].textContent"), 'Other');
run("subagentStream({sub_id:'one',stream_id:'s',phase:'end'}); subagentChat({sub_id:'one',role:'assistant',content:'Complete'})");
assert.equal(run("_subagentChats.get('one').messages.children.length"), 1);
run("for(let i=0;i<100;i++) subagentChat({sub_id:'one',role:'tool_result',content:'x'.repeat(20000)})");
assert.equal(run("_subagentChats.get('one').messages.children.length"), 80);
assert.ok(run("_subagentChats.get('one').messages.children[0].children[1].textContent.length") < 16100);
run("for(let i=0;i<40;i++) subagentChat({sub_id:'agent-'+i,role:'user',content:'task'})");
assert.equal(run('_subagentChats.size'), 24);
console.log('live streaming render, reconciliation, concurrent chats and bounds passed');
