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

console.log('OK');
