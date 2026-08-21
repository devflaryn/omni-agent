// Workflow progress: the phase tree in the Workflow tab and the compact inline
// card in the chat stream.
//
// Kept out of app.js (already 4,388 lines) because this is self-contained state
// driven by six event types. State is keyed by run_id so a nested workflow, or a
// second run started after a refresh, cannot scribble on the first one's tree.
(function () {
  const runs = Object.create(null);
  // Namespace for a run loaded from load_run. See workflowRenderRecord.
  const HISTORICAL_PREFIX = 'hist:';
  // The agent currently shown in #workflowAgentDetail — set by clicking a row
  // in either a live or a historical tree, both of which share this state.
  let selectedAgent = null;

  function emptyCounts() {
    return { running: 0, done: 0, failed: 0, cached: 0, tokens: 0 };
  }

  function ensureRun(id) {
    if (!runs[id]) {
      runs[id] = {
        id, name: '', description: '', status: 'running',
        phases: Object.create(null), order: [], logs: [],
        counts: emptyCounts(), elapsed_s: 0, agent_count: 0,
        groups: {},   // nested-workflow group names seen on this run
      };
    }
    return runs[id];
  }

  function ensurePhase(run, title) {
    const key = title || 'Work';
    if (!run.phases[key]) {
      run.phases[key] = { title: key, agents: Object.create(null), order: [] };
      run.order.push(key);
    }
    return run.phases[key];
  }

  function workflowStarted(ev) {
    const run = ensureRun(ev.run_id);
    run.name = ev.name || '';
    run.description = ev.description || '';
    run.resumed = !!ev.resumed;
    (ev.phases || []).forEach((p) => ensurePhase(run, p && p.title));
    render(run);
  }

  function workflowPhase(ev) {
    const run = ensureRun(ev.run_id);
    ensurePhase(run, ev.title);
    run.currentPhase = ev.title;
    render(run);
  }

  function workflowAgentStarted(ev) {
    const run = ensureRun(ev.run_id);
    const phase = ensurePhase(run, ev.phase || run.currentPhase);
    if (!phase.agents[ev.sub_id]) phase.order.push(ev.sub_id);
    phase.agents[ev.sub_id] = {
      id: ev.sub_id, label: ev.label || '', agent_type: ev.agent_type || '',
      model: ev.model || '', status: 'running', cached: false, tokens: 0, elapsed_s: 0,
      // ev.group is set by runtime.py's _emit for every event of a nested
      // workflow (its emit_prefix). Undefined — not '' — for a top-level agent,
      // so the group test can tell "no group" from "empty string group" apart.
      group: ev.group || undefined,
    };
    if (ev.group) run.groups[ev.group] = true;
    run.counts.running += 1;
    render(run);
  }

  function findAgent(run, subId) {
    for (const key of run.order) {
      const a = run.phases[key].agents[subId];
      if (a) return a;
    }
    return null;
  }

  function workflowAgentDone(ev) {
    const run = runs[ev.run_id];
    if (!run) return;              // attached mid-run; nothing to update
    const a = findAgent(run, ev.sub_id);
    if (!a) return;
    a.status = ev.ok ? 'done' : 'failed';
    a.cached = !!ev.cached;
    a.tokens = ev.tokens || 0;
    a.elapsed_s = ev.elapsed_s || 0;
    // Stored so a later click can show it in #workflowAgentDetail. Only
    // overwritten when the event actually carries a result.
    if (ev.result !== undefined) a.result = ev.result;
    run.counts.running = Math.max(0, run.counts.running - 1);
    if (ev.ok) run.counts.done += 1; else run.counts.failed += 1;
    if (ev.cached) run.counts.cached += 1;
    run.counts.tokens += a.tokens;
    render(run);
  }

  function workflowLog(ev) {
    const run = ensureRun(ev.run_id);
    run.logs.push(ev.message || '');
    render(run);
  }

  function workflowDone(ev) {
    const run = ensureRun(ev.run_id);
    run.status = ev.aborted ? 'aborted' : (ev.ok ? 'done' : 'failed');
    run.elapsed_s = ev.elapsed_s || 0;
    run.agent_count = ev.agent_count || 0;
    run.counts.running = 0;
    render(run);
  }

  // --- rendering ------------------------------------------------------------
  function statusDot(status) {
    if (status === 'running') return '<span class="wf-dot wf-dot-run"></span>';
    if (status === 'failed') return '<span class="wf-dot wf-dot-fail"></span>';
    if (status === 'aborted') return '<span class="wf-dot wf-dot-warn"></span>';
    return '<span class="wf-dot wf-dot-ok"></span>';
  }

  // Quotes matter as much as angle brackets here: every one of these values is
  // also interpolated into an ATTRIBUTE (data-run-id=, data-sub-id=), where a
  // bare " ends the attribute and everything after it becomes markup.
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // The inline card ships hidden in index.html and only earns its space while a
  // run is live — same class-toggling idiom as #workflowEmpty below. Nothing
  // used to remove that `hidden`, so this surface never appeared at all.
  function anyRunActive() {
    for (const id in runs) if (runs[id].status === 'running') return true;
    return false;
  }

  function renderCard(run) {
    const card = document.getElementById('workflowCard');
    if (!card) return;
    if (run.status !== 'running') {
      // A finished run must not scribble its final state over a sibling that is
      // still live; it only takes the card down once nothing is running.
      if (anyRunActive()) return;
      card.classList.add('hidden');
      card.innerHTML = '';
      return;
    }
    card.classList.remove('hidden');
    const c = run.counts;
    const bits = [];
    if (run.currentPhase) bits.push(esc(run.currentPhase));
    if (c.running) bits.push(`${c.running} running`);
    if (c.done) bits.push(`${c.done} done`);
    if (c.cached) bits.push(`${c.cached} cached`);
    if (c.failed) bits.push(`${c.failed} failed`);
    card.innerHTML =
      `<div class="wf-card-head">${statusDot(run.status)}` +
      `<span class="wf-card-name">${esc(run.name)}</span>` +
      `<span class="wf-card-meta">${bits.join(' · ')}</span></div>`;
  }

  // sub_id carries a run_id so a click routes unambiguously between a live
  // and a historical run rendered in the same tree.
  function renderAgentRow(runId, a) {
    const meta = [a.agent_type, a.model, a.tokens ? `${a.tokens} tok` : '',
                  a.cached ? 'cached' : '', a.elapsed_s ? `${a.elapsed_s}s` : '']
      .filter(Boolean).join(' · ');
    return `<div class="wf-agent" data-run-id="${esc(runId)}" data-sub-id="${esc(a.id)}">` +
      `${statusDot(a.status)}` +
      `<span class="wf-agent-label">${esc(a.label)}</span>` +
      `<span class="wf-agent-meta">${esc(meta)}</span></div>`;
  }

  // Buckets a phase's agents in first-seen order: a run of top-level agents
  // stays flat, but the first agent carrying a given `group` opens a bucket
  // that every later agent in that same group (however interleaved) joins.
  function bucketPhaseAgents(phase) {
    const buckets = [];
    const byGroup = new Map();
    for (const id of phase.order) {
      const a = phase.agents[id];
      if (a.group) {
        let b = byGroup.get(a.group);
        if (!b) { b = { group: a.group, agents: [] }; byGroup.set(a.group, b); buckets.push(b); }
        b.agents.push(a);
      } else {
        buckets.push({ group: null, agents: [a] });
      }
    }
    return buckets;
  }

  function renderTree(run) {
    const tree = document.getElementById('workflowTree');
    if (!tree) return;
    const empty = document.getElementById('workflowEmpty');
    if (empty) empty.classList.add('hidden');

    const parts = [
      `<div class="wf-run-head">${statusDot(run.status)}<span class="wf-run-name">${esc(run.name)}</span>` +
      `<span class="wf-run-desc">${esc(run.description)}</span></div>`,
    ];
    for (const key of run.order) {
      const phase = run.phases[key];
      parts.push(`<div class="wf-phase"><div class="wf-phase-title">${esc(phase.title)}</div>`);
      for (const bucket of bucketPhaseAgents(phase)) {
        if (bucket.group) {
          parts.push(`<div class="wf-group"><div class="wf-group-title">${icon('chevron-right')} ${esc(bucket.group)}</div>`);
          for (const a of bucket.agents) parts.push(renderAgentRow(run.id, a));
          parts.push('</div>');
        } else {
          for (const a of bucket.agents) parts.push(renderAgentRow(run.id, a));
        }
      }
      parts.push('</div>');
    }
    if (run.logs.length) {
      parts.push('<div class="wf-logs">' +
        run.logs.map((l) => `<div class="wf-log">${esc(l)}</div>`).join('') + '</div>');
    }
    tree.innerHTML = parts.join('');
    bindTreeClicks(tree);
  }

  // Delegated so it survives every innerHTML replacement above, and bound
  // once per element rather than once per render.
  function bindTreeClicks(tree) {
    if (tree._wfClickBound) return;
    tree._wfClickBound = true;
    tree.addEventListener('click', (e) => {
      const row = e.target && e.target.closest ? e.target.closest('.wf-agent') : null;
      if (!row) return;
      const runId = row.getAttribute ? row.getAttribute('data-run-id') : row['data-run-id'];
      const subId = row.getAttribute ? row.getAttribute('data-sub-id') : row['data-sub-id'];
      workflowSelectAgent(runId, subId);
    });
  }

  function renderBadge(run) {
    const badge = document.getElementById('workflowTabBadge');
    if (!badge) return;
    const n = run.counts.running;
    badge.textContent = n ? String(n) : '';
    badge.classList.toggle('hidden', !n);
  }

  function render(run) {
    try {
      renderCard(run);
      renderTree(run);
      renderBadge(run);
    } catch (e) {
      // Rendering must never break the event stream.
    }
  }

  // A historical run arrives from load_run as flat journal rows, not events. It
  // must draw through the SAME renderer as a live run, or the two views drift.
  function workflowRenderRecord(record) {
    if (!record || !record.ok) return;
    // A HISTORICAL record must never share a key with the live event path.
    // meta.json is written at run START, so list_runs happily lists a run that
    // is still going; opening it merged flat journal rows (keyed "0","1",…)
    // into the very object holding that run's live sub_id-keyed agents —
    // every agent appeared twice and run.status was forced to 'done' mid-run.
    const id = HISTORICAL_PREFIX + (record.run_id || 'historical');
    const run = ensureRun(id);
    run.name = (record.meta && record.meta.name) || '';
    run.description = (record.meta && record.meta.description) || '';
    run.status = (record.summary && record.summary.aborted) ? 'aborted'
               : ((record.summary && record.summary.ok) === false ? 'failed' : 'done');
    run.historical = true;
    run.result = record.result;
    (record.rows || []).forEach((row, i) => {
      const phase = ensurePhase(run, row.phase);
      const key = String(i);          // journal rows have no sub_id
      if (!phase.agents[key]) phase.order.push(key);
      phase.agents[key] = {
        id: key, label: row.label || '', agent_type: row.agent_type || '',
        model: row.model || '', status: row.ok ? 'done' : 'failed',
        cached: !!row.cached, tokens: row.tokens || 0,
        elapsed_s: row.elapsed_s || 0, group: row.group || undefined,
        result: row.result,
      };
      if (row.group) run.groups[row.group] = true;
    });
    render(run);
  }

  function renderAgentDetail() {
    const el = document.getElementById('workflowAgentDetail');
    if (!el) return;
    const a = selectedAgent;
    if (!a) { el.innerHTML = ''; return; }
    const meta = [a.agent_type, a.model, a.tokens ? `${a.tokens} tok` : '',
                  a.elapsed_s ? `${a.elapsed_s}s` : '', a.cached ? 'cached' : '']
      .filter(Boolean).join(' · ');
    let body = a.result;
    if (body !== null && typeof body === 'object') {
      try { body = JSON.stringify(body, null, 2); } catch (e) { body = String(body); }
    }
    // A stored result is MODEL-AUTHORED text. esc() is not optional here.
    el.innerHTML =
      `<div class="wf-detail-head">${esc(a.label)}</div>` +
      `<div class="wf-detail-meta">${esc(meta)}</div>` +
      `<pre class="wf-detail-body">${esc(body == null ? '' : String(body))}</pre>`;
  }

  function workflowSelectAgent(runId, subId) {
    const run = runs[runId];
    if (!run) return;
    for (const key of run.order) {
      const a = run.phases[key].agents[String(subId)];
      if (a) { selectedAgent = Object.assign({ sub_id: String(subId) }, a); break; }
    }
    renderAgentDetail();
  }

  const api = {
    workflowStarted, workflowPhase, workflowAgentStarted, workflowAgentDone,
    workflowLog, workflowDone,
    workflowRenderRecord, workflowSelectAgent,
    workflowState: () => ({ runs, selectedAgent }),
  };
  Object.assign(typeof window !== 'undefined' ? window : globalThis, api);
})();
