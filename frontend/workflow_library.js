// The library rail: which run to draw, not how to draw it.
//
// workflow_view.js owns the tree renderer (a live event stream or a historical
// load_run payload both draw through it). This file owns everything upstream
// of that: the catalog of launchable workflows (list_workflows), the launch
// form built from each workflow's args_schema, and the run history list
// (list_runs) whose rows call load_run and hand the record to
// workflowRenderRecord. Kept out of app.js (already 4,400+ lines) for the
// same reason workflow_view.js and device_view.js are.
(function () {
  // Selection state for the launch form. `schema` is null when the selected
  // workflow declares no args_schema, which switches the form to a raw JSON
  // textarea instead of one input per field.
  const current = { name: '', schema: null };

  // Same idiom as workflow_view.js's esc() and device_view.js's esc(): every
  // value here (workflow names/descriptions come from files on disk, run
  // names and labels come from a journal) goes through this before innerHTML.
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // --- the catalog ------------------------------------------------------

  function renderLibrary(payload) {
    const el = document.getElementById('workflowLibraryList');
    if (!el) return;
    const workflows = (payload && payload.ok && payload.workflows) || [];
    if (!workflows.length) {
      el.innerHTML = '<div class="wf-lib-empty t-xs text-term-muted">No workflows found.</div>';
      return;
    }
    el.innerHTML = workflows.map((w) => {
      const name = esc(w.name || '');
      return `<div class="wf-lib-row" data-name="${name}">` +
        `<div class="wf-lib-name">${name}</div>` +
        `<div class="wf-lib-desc">${esc(w.description || '')}</div>` +
        `<div class="wf-lib-when">${esc(w.when_to_use || '')}</div>` +
        `</div>`;
    }).join('');
    if (!el._wfClickBound) {
      el._wfClickBound = true;
      el.addEventListener('click', (e) => {
        const row = e.target && e.target.closest ? e.target.closest('.wf-lib-row') : null;
        if (!row) return;
        const name = row.getAttribute ? row.getAttribute('data-name') : row['data-name'];
        const w = workflows.find((x) => x.name === name);
        if (!w) return;
        selectWorkflow(w);
      });
    }
  }

  function selectWorkflow(w) {
    current.name = w.name || '';
    const nameEl = document.getElementById('workflowLaunchName');
    if (nameEl) nameEl.textContent = current.name;
    buildArgsForm(w.args_schema);
  }

  // --- the launch form ----------------------------------------------------

  // Built from args_schema when there is one; a raw JSON box otherwise, so a
  // workflow without a schema is still launchable.
  function buildArgsForm(schema) {
    const el = document.getElementById('workflowArgsForm');
    if (!el) return;
    current.schema = schema && Object.keys(schema).length ? schema : null;
    if (!current.schema) {
      el.innerHTML =
        '<label class="wf-arg-label">Arguments (JSON)</label>' +
        '<textarea id="workflowArgsJson" class="wf-arg-input" rows="4" ' +
        'placeholder="{}"></textarea>';
      return;
    }
    el.innerHTML = Object.entries(current.schema).map(([name, spec]) => {
      const label = esc((spec && spec.label) || name);
      const req = (spec && spec.required) ? ' <span class="wf-arg-req">*</span>' : '';
      const ph = esc((spec && spec.placeholder) || '');
      return `<label class="wf-arg-label">${label}${req}</label>` +
             `<input class="wf-arg-input" data-arg="${esc(name)}" placeholder="${ph}">`;
    }).join('');
  }

  // Validate HERE rather than spending a dry-run round trip on a blank field.
  function collectArgs() {
    if (!current.schema) {
      const box = document.getElementById('workflowArgsJson');
      const raw = ((box && box.value) || '').trim();
      if (!raw) return { ok: true, args: {} };
      try { return { ok: true, args: JSON.parse(raw) }; }
      catch (e) { return { ok: false, error: 'Arguments must be valid JSON.' }; }
    }
    const out = {};
    for (const [name, spec] of Object.entries(current.schema)) {
      const field = document.querySelector
        ? document.querySelector(`[data-arg="${name}"]`) : null;
      const val = ((field && field.value) || '').trim();
      if (!val) {
        if (spec && spec.required) {
          return { ok: false, error: `"${name}" is required.` };
        }
        continue;
      }
      // A JSON-looking value is parsed so list args (paths, sites) arrive typed.
      if (val.startsWith('[') || val.startsWith('{')) {
        try { out[name] = JSON.parse(val); continue; }
        catch (e) { return { ok: false, error: `"${name}" is not valid JSON.` }; }
      }
      out[name] = val;
    }
    return { ok: true, args: out };
  }

  // --- run history ----------------------------------------------------------

  function statusDot(run) {
    if (run.aborted) return '<span class="wf-dot wf-dot-warn"></span>';
    if (run.ok === false) return '<span class="wf-dot wf-dot-fail"></span>';
    if (run.ok === true) return '<span class="wf-dot wf-dot-ok"></span>';
    return '<span class="wf-dot"></span>';
  }

  // A null elapsed_s or aborted comes from a run made before the summary
  // existed — render blank, never the string "null".
  function blankIfNull(v, suffix) {
    if (v === null || v === undefined) return '';
    return `${v}${suffix || ''}`;
  }

  function renderRunHistory(payload) {
    const el = document.getElementById('workflowRunList');
    if (!el) return;
    const runs = (payload && payload.ok && payload.runs) || [];
    if (!runs.length) {
      el.innerHTML = '<div class="wf-lib-empty t-xs text-term-muted">No runs yet.</div>';
      return;
    }
    const sorted = [...runs].sort((a, b) => (b.started || 0) - (a.started || 0));
    el.innerHTML = sorted.map((r) => {
      const meta = [blankIfNull(r.agent_count) !== '' ? `${r.agent_count} agents` : '',
                    blankIfNull(r.elapsed_s, 's')]
        .filter(Boolean).join(' · ');
      return `<div class="wf-run-row" data-run-id="${esc(r.run_id)}">${statusDot(r)}` +
        `<span class="wf-run-row-name">${esc(r.name)}</span>` +
        `<span class="wf-run-row-meta">${esc(meta)}</span></div>`;
    }).join('');
    if (!el._wfClickBound) {
      el._wfClickBound = true;
      el.addEventListener('click', (e) => {
        const row = e.target && e.target.closest ? e.target.closest('.wf-run-row') : null;
        if (!row) return;
        const runId = row.getAttribute ? row.getAttribute('data-run-id') : row['data-run-id'];
        if (!runId) return;
        Promise.resolve(pywebview.api.load_run(runId)).then((record) => {
          if (typeof workflowRenderRecord === 'function') workflowRenderRecord(record);
        }).catch(() => {});
      });
    }
  }

  function libraryState() {
    return { selected: current.name, args_schema: current.schema, collectArgs };
  }

  const api = { renderLibrary, buildArgsForm, renderRunHistory, libraryState };
  Object.assign(typeof window !== 'undefined' ? window : globalThis, api);
})();
