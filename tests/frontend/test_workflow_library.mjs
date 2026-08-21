// Drives the REAL frontend/workflow_library.js over the shared DOM shim.
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { El, loadApp } from './_harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND = path.join(here, '..', '..', 'frontend');

function load() {
  const byId = new Map();
  for (const id of ['workflowLibraryList', 'workflowRunList', 'workflowArgsForm',
                    'workflowLaunchName', 'workflowTree', 'workflowAgentDetail',
                    'workflowRunError']) {
    const el = new El('div'); el.id = id; byId.set(id, el);
  }
  const document = { getElementById: (id) => byId.get(id) || null,
                     createElement: (t) => new El(t), body: new El('div') };
  const ctx = { document, window: {}, console, setTimeout, clearTimeout,
                Date, Promise, JSON, isFinite, Math, Number, String, Object,
                pywebview: { api: { load_run: async (id) => ({ ok: true, run_id: id }) } },
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

{
  // Spec: history rows show "name, relative time, a status dot, agent count
  // and elapsed". Relative time was specified and never rendered.
  const { ctx, byId } = load();
  const nowSecs = Math.floor(Date.now() / 1000);
  ctx.renderRunHistory({ ok: true, runs: [
    { run_id: 'aaa', name: 'review-changes', ok: true, aborted: false,
      agent_count: 4, elapsed_s: 9.2, started: nowSecs - 3600 * 3 },
    { run_id: 'bbb', name: 'migrate', ok: true, aborted: false,
      agent_count: 2, elapsed_s: 1, started: nowSecs - 120 },
  ]});
  const html = byId.get('workflowRunList')._html || '';
  assert.ok(/3h ago/.test(html), `history rows must show relative time: ${html}`);
  assert.ok(/2m ago/.test(html));
  // A pre-summary run has no `started` at all; it must render blank, not an
  // "ago" computed from epoch 0.
  ctx.renderRunHistory({ ok: true, runs: [
    { run_id: 'ccc', name: 'legacy', ok: null, aborted: null,
      agent_count: 3, elapsed_s: null, started: null }]});
  const legacy = byId.get('workflowRunList')._html || '';
  assert.ok(!/ago/.test(legacy), 'a run with no start time shows no relative time');
  console.log('PASS history rows show relative time');
}

{
  // load_run answers {ok:false, error} for a deleted run directory. Discarding
  // it made the click do NOTHING at all.
  const { ctx, byId } = load();
  ctx.pywebview.api.load_run = async () => ({ ok: false, error: 'unknown run id: zzz' });
  ctx.renderRunHistory({ ok: true, runs: [
    { run_id: 'zzz', name: 'gone', ok: true, agent_count: 1, elapsed_s: 1, started: 1 }]});
  const listen = byId.get('workflowRunList')._listeners.click;
  listen({ target: { closest: () => ({ getAttribute: () => 'zzz' }) } });
  await new Promise((r) => setImmediate(r));
  assert.equal(byId.get('workflowRunError')._text, 'unknown run id: zzz',
    'a failed load_run must surface its error, not silently do nothing');
  assert.equal(ctx.__rendered, undefined, 'nothing is rendered on failure');
  console.log('PASS a failed load_run surfaces its error');
}

{
  // The click listener is bound once and must read CURRENT state. It used to
  // close over the first `workflows` array, so after a re-render every lookup
  // resolved against the stale catalog.
  const { ctx, byId } = load();
  ctx.renderLibrary({ ok: true, workflows: LIB });
  ctx.renderLibrary({ ok: true, workflows: [
    { name: 'brand-new', description: 'd', when_to_use: 'w',
      args_schema: { fresh: { label: 'Fresh field' } } }]});
  const listen = byId.get('workflowLibraryList')._listeners.click;
  listen({ target: { closest: () => ({ getAttribute: () => 'brand-new' }) } });
  assert.equal(ctx.libraryState().selected, 'brand-new',
    'the handler must resolve against the CURRENT catalog, not the first one');
  assert.ok(/Fresh field/.test(byId.get('workflowArgsForm')._html || ''));
  console.log('PASS a re-rendered library is not looked up against a stale array');
}

{
  // esc() is used in attribute position (data-name=, data-arg=, placeholder=).
  const { ctx, byId } = load();
  ctx.renderLibrary({ ok: true, workflows: [
    { name: 'x" onclick="alert(1)', description: 'd', when_to_use: 'w' }]});
  const html = byId.get('workflowLibraryList')._html || '';
  assert.ok(!/onclick="alert/.test(html), 'a quote must not be able to close the attribute');
  ctx.buildArgsForm({ target: { label: 'T', placeholder: 'a" autofocus onfocus="x' } });
  const form = byId.get('workflowArgsForm')._html || '';
  assert.ok(!/onfocus="x/.test(form), 'placeholders are attribute-escaped too');
  console.log('PASS esc() escapes quotes, not just angle brackets');
}

{
  // A UI-launched workflow holds the backend's _busy for the whole run. Without
  // setBusy(true) the UI believed it was idle: #stopBtn hidden for minutes,
  // #input enabled, and every send_message refused with "already working".
  const { sandbox, doc } = loadApp();
  sandbox.libraryState = () => ({ selected: 'review-changes',
                                  collectArgs: () => ({ ok: true, args: {} }) });
  let asked = null;
  sandbox.pywebview = { api: { launch_workflow: async (n, a, d) => {
    asked = { n, a, d }; return { ok: true, started: true };
  } } };
  doc.getElementById('stopBtn').classList.add('hidden');
  await sandbox.launchSelectedWorkflow(false);
  assert.ok(asked && asked.n === 'review-changes');
  assert.equal(doc.getElementById('stopBtn').classList.contains('hidden'), false,
    'Stop must be visible for the duration of a launched workflow run');
  assert.equal(doc.getElementById('input').disabled, true,
    'the input is disabled while the launched run drives the conversation');
  console.log('PASS launching a workflow puts the UI in the busy state');
}

{
  // A refused launch must NOT put the UI into the busy state.
  const { sandbox, doc } = loadApp();
  sandbox.libraryState = () => ({ selected: 'review-changes',
                                  collectArgs: () => ({ ok: true, args: {} }) });
  sandbox.pywebview = { api: { launch_workflow: async () => ({ ok: false, error: 'busy' }) } };
  doc.getElementById('stopBtn').classList.add('hidden');
  await sandbox.launchSelectedWorkflow(false);
  assert.equal(doc.getElementById('stopBtn').classList.contains('hidden'), true,
    'a refused launch leaves the UI idle');
  assert.equal(doc.getElementById('workflowLaunchError')._text, 'busy');
  console.log('PASS a refused launch leaves the UI idle');
}

console.log('OK');
