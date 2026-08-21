// Drives the REAL frontend/workflow_library.js over the shared DOM shim.
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { El } from './_harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND = path.join(here, '..', '..', 'frontend');

function load() {
  const byId = new Map();
  for (const id of ['workflowLibraryList', 'workflowRunList', 'workflowArgsForm',
                    'workflowLaunchName', 'workflowTree', 'workflowAgentDetail']) {
    const el = new El('div'); el.id = id; byId.set(id, el);
  }
  const document = { getElementById: (id) => byId.get(id) || null,
                     createElement: (t) => new El(t), body: new El('div') };
  const ctx = { document, window: {}, console, setTimeout, clearTimeout,
                workflowRenderRecord: (r) => { ctx.__rendered = r; } };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(FRONTEND, 'workflow_library.js'), 'utf8'), ctx);
  return { ctx, byId };
}

const LIB = [
  { name: 'review-changes', description: 'Review a diff', when_to_use: 'for bugs',
    args_schema: { target: { label: 'Git ref', required: false, placeholder: 'HEAD' } } },
  { name: 'deep-research', description: 'Research', when_to_use: 'open questions',
    args_schema: { question: { label: 'Question', required: true } } },
];

{
  const { ctx, byId } = load();
  ctx.renderLibrary({ ok: true, workflows: LIB });
  const html = byId.get('workflowLibraryList')._html || '';
  assert.ok(/review-changes/.test(html) && /deep-research/.test(html));
  assert.ok(/for bugs/.test(html), 'when_to_use is shown — it is how you choose one');
  console.log('PASS library renders');
}

{
  const { ctx, byId } = load();
  ctx.renderLibrary({ ok: true, workflows: LIB });
  ctx.buildArgsForm(LIB[0].args_schema);
  const html = byId.get('workflowArgsForm')._html || '';
  assert.ok(/Git ref/.test(html), 'the label comes from args_schema');
  assert.ok(/HEAD/.test(html), 'the placeholder is used');
  console.log('PASS form is built from args_schema');
}

{
  // A workflow without a schema must still be launchable.
  const { ctx, byId } = load();
  ctx.buildArgsForm(undefined);
  const html = byId.get('workflowArgsForm')._html || '';
  assert.ok(/textarea/i.test(html), 'falls back to a raw JSON box');
  console.log('PASS falls back to JSON without a schema');
}

{
  const { ctx, byId } = load();
  ctx.renderRunHistory({ ok: true, runs: [
    { run_id: 'aaa', name: 'review-changes', ok: true, aborted: false,
      agent_count: 4, elapsed_s: 9.2, started: 1000 },
    { run_id: 'bbb', name: 'migrate', ok: false, aborted: null,
      agent_count: 7, elapsed_s: null, started: 900 },
  ]});
  const html = byId.get('workflowRunList')._html || '';
  assert.ok(/review-changes/.test(html) && /migrate/.test(html));
  assert.ok(!/null/.test(html), 'unknown elapsed renders blank, not the word null');
  console.log('PASS history renders, unknown fields stay blank');
}

{
  // A required field left empty must be caught in the form, not by a dry-run
  // round trip.
  const { ctx } = load();
  ctx.buildArgsForm(LIB[1].args_schema);
  const out = ctx.libraryState().collectArgs();
  assert.equal(out.ok, false);
  assert.ok(/question/i.test(out.error), 'the error names the missing field');
  console.log('PASS required fields are validated in the form');
}

{
  // Workflow names and descriptions come from files on disk; escape anyway.
  const { ctx, byId } = load();
  ctx.renderLibrary({ ok: true, workflows: [
    { name: '<img src=x onerror=alert(1)>', description: 'd', when_to_use: 'w',
      args_schema: {} }]});
  const html = byId.get('workflowLibraryList')._html || '';
  assert.ok(!html.includes('<img'), 'names are escaped');
  console.log('PASS library entries are escaped');
}

console.log('OK');
