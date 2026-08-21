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
  // The catalog most recently rendered. The click listener is bound ONCE (it
  // is delegated), so it must read this rather than close over the array it
  // happened to be created with — a second renderLibrary() used to leave the
  // handler resolving names against the FIRST payload forever.
  let catalog = [];

  // Same idiom as workflow_view.js's esc() and device_view.js's esc(): every
  // value here (workflow names/descriptions come from files on disk, run
  // names and labels come from a journal) goes through this before innerHTML.
  // Quotes matter as much as angle brackets here: these values also land in
  // ATTRIBUTE position (data-name=, data-arg=, placeholder=, data-run-id=),
  // where a bare " closes the attribute and turns the rest into markup.
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // --- the catalog ------------------------------------------------------

  function renderLibrary(payload) {
    const el = document.getElementById('workflowLibraryList');
    if (!el) return;
    catalog = (payload && payload.ok && payload.workflows) || [];
    const workflows = catalog;
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
        const w = catalog.find((x) => x.name === name);
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

  // Relative time, per spec ("name, relative time, a status dot, agent count
  // and elapsed"). `started` is wall-clock SECONDS (time.time() on the Python
  // side), not milliseconds. A run written before the summary fields existed
  // has no `started` at all, which renders blank rather than "56 years ago".
  function relTime(started) {
    const t = Number(started);
    if (!started || !isFinite(t) || t <= 0) return '';
    const secs = Math.round(Date.now() / 1000 - t);
    if (secs < 0) return 'just now';          // clock skew, not the future
    if (secs < 60) return 'just now';
    if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
    if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
    if (secs < 86400 * 30) return `${Math.floor(secs / 86400)}d ago`;
    return `${Math.floor(secs / (86400 * 30))}mo ago`;
  }

  function showHistoryError(message) {
    const el = document.getElementById('workflowRunError');
    if (!el) return;
    el.textContent = message || '';
  }

  function renderRunHistory(payload) {
    const el = document.getElementById('workflowRunList');
    if (!el) return;
    showHistoryError('');       // a fresh list clears the previous failure
    const runs = (payload && payload.ok && payload.runs) || [];
    if (!runs.length) {
      el.innerHTML = '<div class="wf-lib-empty t-xs text-term-muted">No runs yet.</div>';
      return;
    }
    const sorted = [...runs].sort((a, b) => (b.started || 0) - (a.started || 0));
    el.innerHTML = sorted.map((r) => {
      const meta = [relTime(r.started),
                    blankIfNull(r.agent_count) !== '' ? `${r.agent_count} agents` : '',
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
        showHistoryError('');
        // load_run answers {ok:false, error} for a run whose directory was
        // deleted or whose meta.json is unreadable. Dropping that made the
        // click do NOTHING — the spec promises a clear error and a rail that
        // stays usable.
        Promise.resolve(pywebview.api.load_run(runId)).then((record) => {
          if (!record || !record.ok) {
            showHistoryError((record && record.error) || `Could not open run ${runId}.`);
            return;
          }
          if (typeof workflowRenderRecord === 'function') workflowRenderRecord(record);
        }).catch((e) => showHistoryError(String(e)));
      });
    }
  }

  function libraryState() {
    return { selected: current.name, args_schema: current.schema, collectArgs };
  }

  const api = { renderLibrary, buildArgsForm, renderRunHistory, libraryState,
                relTime };
  Object.assign(typeof window !== 'undefined' ? window : globalThis, api);
})();
