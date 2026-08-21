// Drives the REAL frontend/workflow_view.js over the shared DOM shim with a
// recorded event stream — the same events the Python runtime emits.
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { El } from './_harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND = path.join(here, '..', '..', 'frontend');

function load() {
  const root = new El('div');
  const byId = new Map();
  for (const id of ['workflowTree', 'workflowEmpty', 'workflowCard', 'workflowTabBadge']) {
    const el = new El('div');
    el.id = id;
    byId.set(id, el);
  }
  const document = {
    getElementById: (id) => byId.get(id) || null,
    createElement: (tag) => new El(tag),
    body: root,
  };
  const ctx = { document, window: {}, console, setTimeout, clearTimeout };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(FRONTEND, 'workflow_view.js'), 'utf8'), ctx);
  return { ctx, byId };
}

const RUN = 'run123';

function started(ctx) {
  ctx.workflowStarted({
    type: 'workflow_started', run_id: RUN, name: 'review-changes',
    description: 'review a diff', phases: [{ title: 'Review' }, { title: 'Verify' }],
  });
}

// --- tests ------------------------------------------------------------------
{
  const { ctx } = load();
  started(ctx);
  const st = ctx.workflowState();
  assert.equal(st.runs[RUN].name, 'review-changes', 'run is registered by id');
  console.log('PASS registers a run');
}

{
  const { ctx } = load();
  started(ctx);
  ctx.workflowAgentStarted({ run_id: RUN, sub_id: 'a1', phase: 'Review', label: 'review:bugs', agent_type: 'researcher' });
  const st = ctx.workflowState();
  assert.equal(st.runs[RUN].phases.Review.agents.a1.status, 'running');
  console.log('PASS groups an agent under its phase');
}

{
  const { ctx } = load();
  started(ctx);
  ctx.workflowAgentStarted({ run_id: RUN, sub_id: 'a1', phase: 'Review', label: 'l' });
  ctx.workflowAgentDone({ run_id: RUN, sub_id: 'a1', ok: true, cached: false, tokens: 120, elapsed_s: 2.5 });
  const a = ctx.workflowState().runs[RUN].phases.Review.agents.a1;
  assert.equal(a.status, 'done');
  assert.equal(a.tokens, 120);
  console.log('PASS marks an agent done with its tokens');
}

{
  const { ctx } = load();
  started(ctx);
  ctx.workflowAgentStarted({ run_id: RUN, sub_id: 'c1', phase: 'Review', label: 'l' });
  ctx.workflowAgentDone({ run_id: RUN, sub_id: 'c1', ok: true, cached: true, tokens: 0, elapsed_s: 0 });
  const st = ctx.workflowState();
  assert.equal(st.runs[RUN].phases.Review.agents.c1.cached, true);
  assert.equal(st.runs[RUN].counts.cached, 1, 'cached replays are counted separately');
  console.log('PASS distinguishes a cached replay');
}

{
  const { ctx } = load();
  started(ctx);
  for (const id of ['a', 'b', 'c']) {
    ctx.workflowAgentStarted({ run_id: RUN, sub_id: id, phase: 'Verify', label: id });
  }
  ctx.workflowAgentDone({ run_id: RUN, sub_id: 'a', ok: true, cached: false, tokens: 1, elapsed_s: 1 });
  const c = ctx.workflowState().runs[RUN].counts;
  assert.equal(c.running, 2, 'two still in flight');
  assert.equal(c.done, 1);
  console.log('PASS tracks running/done counts for the inline card');
}

{
  const { ctx } = load();
  started(ctx);
  ctx.workflowAgentStarted({ run_id: RUN, sub_id: 'x', phase: 'Review', label: 'l' });
  ctx.workflowAgentDone({ run_id: RUN, sub_id: 'x', ok: false, cached: false, tokens: 5, elapsed_s: 1 });
  assert.equal(ctx.workflowState().runs[RUN].counts.failed, 1);
  console.log('PASS counts a failed agent');
}

{
  const { ctx } = load();
  started(ctx);
  ctx.workflowDone({ run_id: RUN, ok: true, aborted: false, agent_count: 4, elapsed_s: 9.1 });
  const r = ctx.workflowState().runs[RUN];
  assert.equal(r.status, 'done');
  assert.equal(r.elapsed_s, 9.1);
  console.log('PASS finalizes the run');
}

{
  // An event for an unknown run must not throw — the UI can attach mid-run after
  // a webview refresh, exactly as the wave HUD already handles.
  const { ctx } = load();
  ctx.workflowAgentDone({ run_id: 'never-seen', sub_id: 'z', ok: true, cached: false, tokens: 0, elapsed_s: 0 });
  console.log('PASS tolerates events for an unknown run');
}

{
  const { ctx } = load();
  started(ctx);
  ctx.workflowLog({ run_id: RUN, message: '3 leads found' });
  assert.deepEqual(ctx.workflowState().runs[RUN].logs, ['3 leads found']);
  console.log('PASS records log lines');
}

{
  // I4: #workflowCard ships `hidden` in index.html and NOTHING ever removed it,
  // so one of the two specified UI surfaces was dead on arrival.
  const { ctx, byId } = load();
  const card = byId.get('workflowCard');
  card.className = 'hidden';
  assert.equal(card.classList.contains('hidden'), true, 'starts hidden');
  started(ctx);
  assert.equal(card.classList.contains('hidden'), false, 'a started run reveals the card');
  assert.ok(card.innerHTML.includes('review-changes'), 'the card renders the run');
  console.log('PASS unhides the inline card when a run starts');
}

{
  const { ctx, byId } = load();
  const card = byId.get('workflowCard');
  started(ctx);
  ctx.workflowDone({ run_id: RUN, ok: true, aborted: false, agent_count: 2, elapsed_s: 1 });
  assert.equal(card.classList.contains('hidden'), true, 'hidden again once nothing runs');
  console.log('PASS hides the inline card when no run is active');
}

{
  // A second run still going must keep the card up when the first finishes.
  const { ctx, byId } = load();
  const card = byId.get('workflowCard');
  started(ctx);
  ctx.workflowStarted({ run_id: 'run456', name: 'other', description: '', phases: [] });
  ctx.workflowDone({ run_id: RUN, ok: true, aborted: false, agent_count: 1, elapsed_s: 1 });
  assert.equal(card.classList.contains('hidden'), false, 'a live sibling keeps the card up');
  assert.ok(card.innerHTML.includes('other'), 'and the live run owns it');
  console.log('PASS keeps the card up while another run is still live');
}

{
  // I3: sub_id is now `${key}:${occ}`, so two identical prompts are two rows.
  const { ctx } = load();
  started(ctx);
  const KEY = 'deadbeefdeadbeef';
  ctx.workflowAgentStarted({ run_id: RUN, sub_id: KEY + ':0', phase: 'Review', label: 'dup' });
  ctx.workflowAgentStarted({ run_id: RUN, sub_id: KEY + ':1', phase: 'Review', label: 'dup' });
  const st = ctx.workflowState().runs[RUN];
  assert.equal(st.phases.Review.order.length, 2, 'two identical prompts are two rows');
  assert.equal(st.counts.running, 2, 'and both count as running');
  ctx.workflowAgentDone({ run_id: RUN, sub_id: KEY + ':0', ok: true, cached: false, tokens: 1, elapsed_s: 1 });
  assert.equal(st.counts.running, 1);
  assert.equal(st.phases.Review.agents[KEY + ':1'].status, 'running', 'the sibling row is untouched');
  console.log('PASS keeps colliding prompts as separate rows');
}

console.log('OK');
