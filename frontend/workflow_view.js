// Workflow progress: the phase tree in the Workflow tab and the compact inline
// card in the chat stream.
//
// Kept out of app.js (already 4,388 lines) because this is self-contained state
// driven by six event types. State is keyed by run_id so a nested workflow, or a
// second run started after a refresh, cannot scribble on the first one's tree.
(function () {
  const runs = Object.create(null);

  function emptyCounts() {
    return { running: 0, done: 0, failed: 0, cached: 0, tokens: 0 };
  }

  function ensureRun(id) {
    if (!runs[id]) {
      runs[id] = {
        id, name: '', description: '', status: 'running',
        phases: Object.create(null), order: [], logs: [],
        counts: emptyCounts(), elapsed_s: 0, agent_count: 0,
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
    };
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

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function renderCard(run) {
    const card = document.getElementById('workflowCard');
    if (!card) return;
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
      for (const id of phase.order) {
        const a = phase.agents[id];
        const meta = [a.agent_type, a.model, a.tokens ? `${a.tokens} tok` : '',
                      a.cached ? 'cached' : '', a.elapsed_s ? `${a.elapsed_s}s` : '']
          .filter(Boolean).join(' · ');
        parts.push(
          `<div class="wf-agent" data-sub-id="${esc(a.id)}">${statusDot(a.status)}` +
          `<span class="wf-agent-label">${esc(a.label)}</span>` +
          `<span class="wf-agent-meta">${esc(meta)}</span></div>`);
      }
      parts.push('</div>');
    }
    if (run.logs.length) {
      parts.push('<div class="wf-logs">' +
        run.logs.map((l) => `<div class="wf-log">${esc(l)}</div>`).join('') + '</div>');
    }
    tree.innerHTML = parts.join('');
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

  const api = {
    workflowStarted, workflowPhase, workflowAgentStarted, workflowAgentDone,
    workflowLog, workflowDone,
    workflowState: () => ({ runs }),
  };
  Object.assign(typeof window !== 'undefined' ? window : globalThis, api);
})();
