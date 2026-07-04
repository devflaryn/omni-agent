// ===== Omni Agent frontend bridge =====
// Talks to the Python backend through pywebview's JS API and renders a
// terminal-style live view of the agent loop (with more detail than the old CLI).

const $ = (id) => document.getElementById(id);
const chat = $('chat');

let session = null;        // {project}
let fileCount = 0;
let autoScroll = true;

// ---------- small utilities ----------
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function humanSize(n) {
  if (n == null) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

function nowTime() {
  return new Date().toLocaleTimeString([], { hour12: false });
}

function nearBottom() {
  return chat.scrollHeight - chat.scrollTop - chat.clientHeight < 120;
}

function scrollDown() {
  if (autoScroll) chat.scrollTop = chat.scrollHeight;
}

chat.addEventListener('scroll', () => {
  autoScroll = nearBottom();
});

function appendRow(el) {
  el.classList.add('msg-enter');
  chat.appendChild(el);
  scrollDown();
}

function fmtElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return s + 's';
  return Math.floor(s / 60) + 'm ' + String(s % 60).padStart(2, '0') + 's';
}

function fmtDuration(ms) {
  if (ms == null) return '';
  return ms > 700 ? (ms / 1000).toFixed(1) + 's' : ms + 'ms';
}

function setStatus(id, val) {
  const el = $(id);
  if (el) el.textContent = val;
}

// ---------- markdown ----------
function renderMarkdown(text) {
  try {
    const raw = marked.parse(text || '');
    return DOMPurify.sanitize(raw);
  } catch {
    return escapeHtml(text);
  }
}

// ---------- event renderers ----------
function renderUserMessage(content) {
  const el = document.createElement('div');
  el.className = 'py-1';
  el.innerHTML = `
    <div class="mb-0.5 text-[10px] text-term-muted"><span class="text-term-green">user</span> <span>${nowTime()}</span></div>
    <div class="whitespace-pre-wrap text-term-text">${escapeHtml(content)}</div>`;
  appendRow(el);
}

// ---------- agent activity (terminal-style step lines) ----------
// Each thinking phase and each tool call is ONE collapsed line inline in the
// conversation flow, like Claude Code's CLI: a spinner while live, then
// "✻ Thought for Xs" / "● tool(args)" when finished. Clicking a finished line
// toggles a detail view underneath (full reasoning text, or tool input
// parameters + output) with a smooth expand animation.

const SPIN_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
let spinFrame = 0;

// One global ticker animates every live spinner glyph and elapsed counter, so
// individual lines never own an interval that could leak.
setInterval(() => {
  const spinners = document.querySelectorAll('.braille-spin');
  if (!spinners.length) return;
  spinFrame = (spinFrame + 1) % SPIN_FRAMES.length;
  spinners.forEach(el => { el.textContent = SPIN_FRAMES[spinFrame]; });
  document.querySelectorAll('.live-elapsed').forEach(el => {
    el.textContent = fmtElapsed(Date.now() - Number(el.dataset.start));
  });
}, 90);

let thinkingLine = null;      // the live "Thinking…" line, if any
const toolLines = new Map();  // tool_running id -> step line awaiting its result

function makeStepLine() {
  const el = document.createElement('div');
  el.className = 'py-px';
  el.innerHTML = `
    <button type="button" class="step-head font-mono text-[12px] leading-5">
      <span class="step-icon w-3 shrink-0 text-center"></span>
      <span class="step-label min-w-0 truncate text-term-muted"></span>
      <span class="step-meta ml-auto shrink-0 text-[10.5px] tabular-nums text-term-muted"></span>
      <span class="step-caret caret hidden shrink-0 select-none text-[9px] leading-none text-term-muted">▶</span>
    </button>
    <div class="step-detail"><div class="step-detail-inner"></div></div>`;
  const head = el.querySelector('.step-head');
  const detail = el.querySelector('.step-detail');
  const caret = el.querySelector('.step-caret');
  head.addEventListener('click', () => {
    if (!head.dataset.expandable) return;
    const open = detail.classList.toggle('open');
    caret.classList.toggle('open', open);
  });
  return {
    el, head,
    icon: el.querySelector('.step-icon'),
    label: el.querySelector('.step-label'),
    meta: el.querySelector('.step-meta'),
    detailInner: el.querySelector('.step-detail-inner'),
    spinner() {
      this.icon.innerHTML = `<span class="braille-spin text-term-cyan">${SPIN_FRAMES[spinFrame]}</span>`;
      this.meta.innerHTML = `<span class="live-elapsed" data-start="${Date.now()}">0s</span>`;
    },
    setExpandable(html) {
      this.detailInner.innerHTML = html;
      this.head.dataset.expandable = '1';
      caret.classList.remove('hidden');
    },
  };
}

function detailBlock(sections) {
  const inner = sections.map(([label, text, cls]) => `
    <div>
      ${label ? `<div class="mb-0.5 text-[9.5px] uppercase tracking-wider text-term-muted">${label}</div>` : ''}
      <pre class="max-h-64 overflow-y-auto whitespace-pre-wrap break-words ${cls}">${escapeHtml(text)}</pre>
    </div>`).join('');
  return `<div class="mb-1 ml-5 mt-0.5 space-y-1.5 border-l-2 border-term-line py-1 pl-3 font-mono text-[11.5px]">${inner}</div>`;
}

function startThinking() {
  if (thinkingLine) return; // JSON-retry leg: reuse the existing line
  const line = makeStepLine();
  line.spinner();
  line.label.innerHTML = '<span class="shimmer">Thinking…</span>';
  appendRow(line.el);
  thinkingLine = line;
}

function finishThinking(ev) {
  const line = thinkingLine;
  thinkingLine = null;
  const text = (ev.text || '').trim();
  if (!line) {
    if (!text) return;
    // thought arrived without a live line (shouldn't happen, but don't drop it)
    const l = makeStepLine();
    appendRow(l.el);
    return finishThinkingLine(l, ev, text);
  }
  if (!text) { line.el.remove(); return; } // nothing to show — drop the spinner line
  finishThinkingLine(line, ev, text);
}

function finishThinkingLine(line, ev, text) {
  line.icon.innerHTML = '<span class="text-term-magenta">✻</span>';
  line.label.innerHTML = `<span class="thought-text">Thought for ${fmtDuration(ev.elapsed_ms) || '0s'}</span>`;
  line.meta.textContent = '';
  line.setExpandable(detailBlock([['', text, 'thought-text']]));
  scrollDown();
}

function startTool(ev) {
  const line = makeStepLine();
  line.spinner();
  line.label.innerHTML =
    `<span class="text-term-text">${escapeHtml(ev.tool)}</span>` +
    `<span class="text-term-muted">${escapeHtml(argSummary(ev.args))}</span>`;
  toolLines.set(ev.id, line);
  appendRow(line.el);
}

function finishTool(ev) {
  let line = toolLines.get(ev.id);
  toolLines.delete(ev.id);
  if (!line) { line = makeStepLine(); appendRow(line.el); } // result without a running line
  const warn = ev.is_loop_warning;
  line.icon.innerHTML = warn
    ? '<span class="text-term-red">!</span>'
    : '<span class="text-term-green">●</span>';
  line.label.innerHTML =
    `<span class="${warn ? 'text-term-red' : 'text-term-text'}">${escapeHtml(ev.tool)}</span>` +
    `<span class="text-term-muted">${escapeHtml(argSummary(ev.args))}</span>` +
    (warn ? ' <span class="text-term-red">loop warning</span>' : '');
  line.meta.textContent = fmtDuration(ev.run_ms);
  line.setExpandable(detailBlock([
    ['input', JSON.stringify(ev.args ?? {}, null, 2), 'text-term-text'],
    ['output', ev.result ?? '', 'text-term-muted'],
  ]));
  scrollDown();
}

// Freeze any still-spinning lines when a run ends (done / stop / session change).
function finalizeLiveLines() {
  if (thinkingLine) { thinkingLine.el.remove(); thinkingLine = null; }
  for (const line of toolLines.values()) {
    line.icon.innerHTML = '<span class="text-term-muted">○</span>';
    line.meta.textContent = '';
    line.label.insertAdjacentHTML('beforeend', ' <span class="italic text-term-muted">interrupted</span>');
  }
  toolLines.clear();
}

function argSummary(args) {
  if (!args || typeof args !== 'object') return '';
  const p = args.path || args.file_path || args.filepath || args.dir_path || args.input_dir || args.directory;
  if (p) return `(${p})`;
  if (args.command) { const c = String(args.command); return c.length > 40 ? `(${c.slice(0, 40)}…)` : `(${c})`; }
  if (args.query) return `(${args.query})`;
  if (args.content) return `(content: ${String(args.content).length} chars)`;
  if (args.source && args.destination) return `(${args.source} → ${args.destination})`;
  return '';
}

function renderFinalAnswer(ev) {
  finalizeLiveLines();
  const el = document.createElement('div');
  el.className = 'py-1';
  el.innerHTML = `
    <div class="mb-0.5 text-[10px] text-term-muted"><span class="text-term-magenta">answer</span> <span>${ev.time}</span> <span>${ev.steps} steps</span></div>
    <div class="markdown text-term-text text-[13px] leading-6">${renderMarkdown(ev.content)}</div>`;
  appendRow(el);
}

function renderSystem(content) {
  const el = document.createElement('div');
  el.className = 'px-2 py-1 text-[11px] text-term-muted';
  el.innerHTML = `<span class="text-term-gray">sys</span> ${escapeHtml(content)}`;
  appendRow(el);
}

function renderLog(content) {
  const el = document.createElement('div');
  el.className = 'px-2 py-0.5 text-[10px] text-term-muted';
  el.textContent = content;
  chat.appendChild(el);
  scrollDown();
}

function renderError(content) {
  const el = document.createElement('div');
  el.className = 'py-1 text-term-red';
  el.innerHTML = `<span class="font-semibold">error</span> ${escapeHtml(content)}`;
  appendRow(el);
}

function renderStatus(ev) {
  setStatus('statSteps', ev.step_count);
  setStatus('statTools', ev.consecutive_tools);
  setStatus('statCtx', ev.ctx_chars.toLocaleString());
  setStatus('statResets', ev.summary_resets);
}

// ---------- plan-and-execute panel ----------
let currentPlan = null;

function planStatusIcon(status) {
  return { pending: '○', in_progress: '◐', completed: '✓', skipped: '⊘' }[status] || '○';
}
function planStatusColor(status) {
  return {
    pending: 'text-term-muted',
    in_progress: 'text-term-cyan',
    completed: 'text-term-green',
    skipped: 'text-term-muted',
  }[status] || 'text-term-muted';
}

function renderPlanBadge(plan) {
  const badge = $('planBadge');
  if (!badge) return;
  if (!plan || !plan.items || !plan.items.length) {
    badge.textContent = 'plan —';
    return;
  }
  const { done, total } = plan.progress;
  badge.textContent = `plan ${done}/${total}`;
}

function renderPlanTab(plan) {
  const root = $('planTab');
  if (!root) return;
  if (!plan || !plan.items || !plan.items.length) {
    root.innerHTML = `
      <div class="flex-1 flex items-center justify-center p-6">
        <div class="text-center text-term-muted italic max-w-sm">
          No active plan yet. The agent creates one automatically as its first
          action on any non-trivial task, and keeps it updated here in real time.
        </div>
      </div>`;
    return;
  }
  const { done, total } = plan.progress;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const rows = plan.items.map(it => {
    const active = it.id === plan.active_item_id;
    const contentClass = it.status === 'completed' ? 'line-through text-term-muted' :
      it.status === 'skipped' ? 'line-through text-term-muted/70' : 'text-term-text';
    return `
      <div class="flex items-start gap-2 rounded-lg px-2 py-1.5 msg-enter ${active ? 'bg-term-cyan/10 border border-term-cyan/30' : 'border border-transparent'}">
        <span class="${planStatusColor(it.status)} shrink-0 mt-0.5 text-[13px]">${planStatusIcon(it.status)}</span>
        <div class="min-w-0 flex-1">
          <div class="${contentClass} text-[13px] leading-5">${escapeHtml(it.content)}</div>
          ${it.notes ? `<div class="text-[11px] text-term-muted mt-0.5">${escapeHtml(it.notes)}</div>` : ''}
        </div>
        <span class="text-[10px] text-term-muted shrink-0 mt-0.5">${escapeHtml(it.status.replace('_', ' '))}</span>
      </div>`;
  }).join('');
  root.innerHTML = `
    <div class="px-4 py-3 border-b border-term-line shrink-0">
      <div class="text-[10px] uppercase tracking-wider text-term-muted mb-1">current task</div>
      <div class="text-term-text text-[13px] mb-2">${escapeHtml(plan.task)}</div>
      <div class="h-1.5 rounded-full bg-term-line overflow-hidden">
        <div class="h-full bg-term-cyan transition-all" style="width:${pct}%"></div>
      </div>
      <div class="text-[10px] text-term-muted mt-1">${done}/${total} tasks complete (${pct}%)</div>
    </div>
    <div class="flex-1 overflow-y-auto px-2 py-2 space-y-0.5">${rows}</div>`;
}

function renderPlan(plan) {
  currentPlan = plan;
  renderPlanBadge(plan);
  renderPlanTab(plan);
}

// ---------- file tree ----------
function fileIcon(name) {
  return name.endsWith('.md') ? '📘' :
    name.endsWith('.py') ? '🐍' :
    name.match(/\.(js|ts|jsx|tsx|html|css|json)$/) ? '🧩' :
    name.match(/\.(so|apk|dex|bin|dat)$/) ? '📦' : '📄';
}

function buildTreeNode(node, depth) {
  const row = document.createElement('div');
  row.className = 'tree-row flex items-center gap-1 rounded-md px-1 py-0.5 cursor-pointer select-none';
  row.style.paddingLeft = (depth * 12 + 4) + 'px';

  if (node.type === 'dir') {
    const caret = document.createElement('span');
    caret.className = 'caret text-term-muted w-3 inline-block text-[10px]'; caret.textContent = '▶';
    const icon = document.createElement('span'); icon.textContent = '📁'; icon.className = 'text-[12px]';
    const name = document.createElement('span'); name.textContent = node.name; name.className = 'text-term-text truncate';
    row.append(caret, icon, name);

    const childWrap = document.createElement('div');
    childWrap.className = 'hidden';
    for (const c of (node.children || [])) childWrap.appendChild(buildTreeNode(c, depth + 1));

    row.addEventListener('click', () => {
      const hidden = childWrap.classList.toggle('hidden');
      caret.classList.toggle('open', !hidden);
      icon.textContent = hidden ? '📁' : '📂';
    });
    const wrap = document.createElement('div');
    wrap.appendChild(row);
    wrap.appendChild(childWrap);
    return wrap;
  } else {
    fileCount++;
    const spacer = document.createElement('span'); spacer.className = 'w-3 inline-block';
    const icon = document.createElement('span'); icon.textContent = fileIcon(node.name); icon.className = 'text-[12px]';
    const name = document.createElement('span'); name.textContent = node.name; name.className = 'text-term-text truncate flex-1';
    const size = document.createElement('span'); size.textContent = humanSize(node.size); size.className = 'text-[10px] text-term-muted';
    row.append(spacer, icon, name, size);
    row.addEventListener('click', () => {
      document.querySelectorAll('.tree-row.active').forEach(r => r.classList.remove('active'));
      row.classList.add('active');
      openFileViewer(node.path);
    });
    return row;
  }
}

function renderFileTree(tree) {
  fileCount = 0;
  const root = $('fileTree');
  root.innerHTML = '';
  if (tree && tree.children) {
    for (const c of tree.children) root.appendChild(buildTreeNode(c, 0));
  }
  setStatus('treeFileCount', fileCount);
}

// ---------- file viewer ----------
async function openFileViewer(path) {
  if (!session) return;
  $('viewerPath').textContent = path;
  $('viewerSize').textContent = 'loading…';
  $('viewerContent').textContent = '';
  $('fileViewer').classList.remove('hidden');
  try {
    const res = await pywebview.api.read_file(path);
    if (!res.ok) {
      $('viewerSize').textContent = '';
      $('viewerContent').textContent = 'Error: ' + res.error;
      return;
    }
    $('viewerSize').textContent = humanSize(res.size) + (res.truncated ? ' (truncated)' : '');
    $('viewerContent').textContent = res.content;
  } catch (e) {
    $('viewerContent').textContent = 'Error: ' + e;
  }
}

// ---------- event dispatch (called from Python) ----------
window.__agent = {
  onEvent(ev) {
    switch (ev.type) {
      case 'session_started': onSessionStarted(ev); break;
      case 'session_ended': onSessionEnded(); break;
      case 'user_message': renderUserMessage(ev.content); break;
      case 'thinking_start': startThinking(); break;
      case 'thinking_end': break; // the 'thought' event that follows finalizes the line
      case 'thought': finishThinking(ev); break;
      case 'tool_running': startTool(ev); break;
      case 'tool_result': finishTool(ev); break;
      case 'final_answer': renderFinalAnswer(ev); break;
      case 'system': renderSystem(ev.content); break;
      case 'log': renderLog(ev.content); break;
      case 'error': renderError(ev.content); break;
      case 'status': renderStatus(ev); break;
      case 'file_tree': renderFileTree(ev.tree); break;
      case 'plan_update': renderPlan(ev.plan); break;
      case 'done': onDone(); break;
    }
    scrollDown();
  }
};

// ---------- session lifecycle ----------
function setBusy(busy) {
  $('sendBtn').classList.toggle('hidden', busy);
  $('stopBtn').classList.toggle('hidden', !busy);
  $('input').disabled = busy;
  $('hint').textContent = busy ? 'agent working…' : 'ready';
}

function onDone() {
  finalizeLiveLines();
  setBusy(false);
  // refresh tree after a generation finishes (files may have changed)
  if (session) pywebview.api.get_file_tree().then(r => { if (r && r.ok) renderFileTree(r.tree); }).catch(() => {});
}

function onSessionStarted(ev) {
  finalizeLiveLines();
  session = { project: ev.project };
  $('app').classList.remove('hidden');
  $('startScreen').classList.add('hidden');
  $('projectBadge').textContent = ev.project;
  $('treeProjectName').textContent = ev.project;
  $('chat').innerHTML = '';
  autoScroll = true;
  setBusy(false);
  renderSystem(`Workspace: ${ev.project}`);
  renderPlan(null); // cleared until the backend's follow-up plan_update event (fires right after session_started) arrives
  if (ev.memory_summary) {
    const banner = $('memoryBanner');
    banner.classList.remove('hidden');
    $('memoryBannerText').textContent = ev.memory_summary.split('\n').slice(0, 3).join(' ') + ' …';
  } else {
    $('memoryBanner').classList.add('hidden');
  }
  const importBanner = $('importBanner');
  if (ev.import_source && ev.import_source.source_path) {
    importBanner.classList.remove('hidden');
    $('importSourceLabel').textContent = ev.import_source.source_path;
    $('importSourceLabel').title = ev.import_source.source_path;
  } else {
    importBanner.classList.add('hidden');
  }
  renderFileTree(ev.file_tree);
}

function onSessionEnded() {
  finalizeLiveLines();
  session = null;
  $('app').classList.add('hidden');
  $('startScreen').classList.remove('hidden');
  $('chat').innerHTML = '';
  renderPlan(null);
}

// ---------- start screen ----------
async function loadStartScreen() {
  try {
    const projects = await pywebview.api.get_projects();
    const projSel = $('projectSelect');
    projSel.innerHTML = '';
    projects.forEach(p => {
      const o = document.createElement('option'); o.value = p; o.textContent = p; projSel.appendChild(o);
    });
    if (!projects.length) {
      const o = document.createElement('option'); o.textContent = '(no projects yet)'; projSel.appendChild(o);
    }
  } catch (e) {
    $('startError').textContent = 'Failed to load: ' + e;
  }
}

async function startSession() {
  $('startError').textContent = '';
  const project = $('projectSelect').value;
  if (!project || project.startsWith('(')) {
    $('startError').textContent = 'Pick a valid project.'; return;
  }
  const btn = $('startSessionBtn'); btn.disabled = true; btn.textContent = 'Starting sandbox…';
  try {
    const res = await pywebview.api.start_session(project);
    if (!res.ok) $('startError').textContent = res.error || 'Failed to start session.';
  } catch (e) {
    $('startError').textContent = '' + e;
  } finally {
    btn.disabled = false; btn.textContent = 'Start session';
  }
}

// ---------- import from folder ----------
async function browseImportFolder() {
  try {
    const res = await pywebview.api.pick_folder();
    if (res && res.ok && res.path) {
      $('importSourcePath').value = res.path;
      $('importSourcePath').title = res.path;
      if (!$('importProjectNameInput').value) {
        const parts = res.path.replace(/[\\/]+$/, '').split(/[\\/]/);
        $('importProjectNameInput').value = parts[parts.length - 1] || '';
      }
    }
  } catch (e) {
    $('startError').textContent = '' + e;
  }
}

async function confirmImport() {
  $('startError').textContent = '';
  const sourcePath = $('importSourcePath').value.trim();
  const name = $('importProjectNameInput').value.trim();
  if (!sourcePath) { $('startError').textContent = 'Pick a folder to import first.'; return; }
  if (!name) { $('startError').textContent = 'Enter a project name for the import.'; return; }
  const btn = $('importConfirmBtn'); btn.disabled = true; btn.textContent = 'copying…';
  try {
    const res = await pywebview.api.import_workspace(name, sourcePath);
    if (!res.ok) {
      $('startError').textContent = res.error || 'Import failed.';
      return;
    }
    await loadStartScreen();
    $('projectSelect').value = name;
    $('importFolderBox').classList.add('hidden'); $('importFolderBox').classList.remove('flex');
    $('importSourcePath').value = '';
    $('importProjectNameInput').value = '';
  } catch (e) {
    $('startError').textContent = '' + e;
  } finally {
    btn.disabled = false; btn.textContent = 'import & copy in';
  }
}

// ---------- export workspace ----------
function renderExportDiff(diff) {
  const listEl = $('exportDiffList');
  const summaryEl = $('exportDiffSummary');
  const groups = [
    ['added', 'text-term-green', '+'],
    ['modified', 'text-term-orange', '~'],
    ['deleted', 'text-term-red', '-'],
  ];
  const total = diff.added.length + diff.modified.length + diff.deleted.length;
  summaryEl.textContent = total === 0
    ? 'No changes since import — exporting will not modify the target folder.'
    : `${diff.added.length} added, ${diff.modified.length} modified, ${diff.deleted.length} deleted.`;
  listEl.innerHTML = '';
  for (const [key, color, sign] of groups) {
    const files = diff[key];
    if (!files.length) continue;
    const section = document.createElement('div');
    const label = document.createElement('div');
    label.className = `text-[10px] uppercase tracking-wider ${color} mb-1`;
    label.textContent = `${key} (${files.length})`;
    section.appendChild(label);
    const list = document.createElement('div');
    list.className = 'space-y-0.5 max-h-40 overflow-y-auto rounded-lg border border-term-line bg-term-bg p-2';
    files.forEach(f => {
      const row = document.createElement('div');
      row.className = `${color} text-[11px] font-mono`;
      row.textContent = `${sign} ${f}`;
      list.appendChild(row);
    });
    section.appendChild(list);
    listEl.appendChild(section);
  }
}

let _exportDiffCache = null;

async function openExportModal() {
  if (!session) return;
  $('exportError').textContent = '';
  $('exportTargetPath').textContent = '—';
  $('exportDiffSummary').textContent = 'Pick a target folder…';
  $('exportDiffList').innerHTML = '';
  $('exportApproveBtn').disabled = true;
  _exportDiffCache = null;

  let targetPath;
  try {
    const pick = await pywebview.api.pick_folder();
    if (!pick || !pick.ok || !pick.path) return; // cancelled
    targetPath = pick.path;
  } catch (e) {
    $('exportError').textContent = '' + e;
    return;
  }

  $('exportModal').classList.remove('hidden');
  $('exportTargetPath').textContent = targetPath;
  $('exportDiffSummary').textContent = 'Computing changes…';

  try {
    const res = await pywebview.api.compute_export_diff(session.project);
    if (!res.ok) {
      $('exportDiffSummary').textContent = '';
      $('exportError').textContent = res.error || 'Failed to compute diff.';
      return;
    }
    _exportDiffCache = { targetPath, diff: res.diff };
    renderExportDiff(res.diff);
    $('exportApproveBtn').disabled = false;
  } catch (e) {
    $('exportError').textContent = '' + e;
  }
}

function closeExportModal() {
  $('exportModal').classList.add('hidden');
  _exportDiffCache = null;
}

async function approveExport() {
  if (!session || !_exportDiffCache) return;
  $('exportError').textContent = '';
  const btn = $('exportApproveBtn'); btn.disabled = true; btn.textContent = 'exporting…';
  try {
    const res = await pywebview.api.export_workspace(session.project, _exportDiffCache.targetPath);
    if (!res.ok) {
      $('exportError').textContent = res.error || 'Export failed.';
      return;
    }
    const a = res.applied;
    $('exportDiffSummary').textContent = `Done: ${a.copied.length} file(s) copied, ${a.deleted.length} deleted` +
      (a.errors.length ? `, ${a.errors.length} error(s)` : '') + '.';
    if (a.errors.length) $('exportError').textContent = a.errors.join(' | ');
    $('exportDiffList').innerHTML = '';
    _exportDiffCache = null;
  } catch (e) {
    $('exportError').textContent = '' + e;
  } finally {
    btn.disabled = false; btn.textContent = 'approve & export';
  }
}

// ---------- input ----------
async function sendMessage() {
  const input = $('input');
  const text = input.value.trim();
  if (!text || !session) return;
  input.value = '';
  autoScroll = true;
  setBusy(true);
  try {
    const res = await pywebview.api.send_message(text);
    if (!res.ok) { renderError(res.error || 'send failed'); setBusy(false); }
  } catch (e) {
    renderError('' + e); setBusy(false);
  }
}

// ---------- tab switching (chat / knowledge graph) ----------
let graphNetwork = null;
let graphLoaded = false;
let activeTab = 'chat';

function switchTab(tab) {
  activeTab = tab;
  const chatTab = $('chatTab'), graphTab = $('graphTab'), planTab = $('planTab');
  const tabChat = $('tabChat'), tabGraph = $('tabGraph'), tabPlan = $('tabPlan');
  const allTabs = [chatTab, graphTab, planTab];
  const allBtns = [tabChat, tabGraph, tabPlan];

  allTabs.forEach(el => el.classList.add('hidden'));
  graphTab.classList.remove('flex');
  allBtns.forEach(btn => {
    btn.classList.remove('border-term-cyan', 'text-term-cyan');
    btn.classList.add('border-transparent', 'text-term-muted');
  });

  if (tab === 'graph') {
    graphTab.classList.remove('hidden');
    graphTab.classList.add('flex');
    tabGraph.classList.add('border-term-cyan', 'text-term-cyan');
    tabGraph.classList.remove('border-transparent', 'text-term-muted');
    loadGraph();
    if (graphNetwork) setTimeout(() => graphNetwork.redraw(), 50);
  } else if (tab === 'plan') {
    planTab.classList.remove('hidden');
    tabPlan.classList.add('border-term-cyan', 'text-term-cyan');
    tabPlan.classList.remove('border-transparent', 'text-term-muted');
    renderPlanTab(currentPlan);
  } else {
    chatTab.classList.remove('hidden');
    tabChat.classList.add('border-term-cyan', 'text-term-cyan');
    tabChat.classList.remove('border-transparent', 'text-term-muted');
  }
}

// ---------- knowledge graph visualization ----------
async function loadGraph() {
  const container = $('graphContainer');
  const info = $('graphInfo');
  const legendEl = $('graphLegend');
  const statsEl = $('graphStats');
  if (!session) {
    info.innerHTML = '<span class="text-term-muted italic">No active session.</span>';
    return;
  }
  info.innerHTML = '<span class="text-term-muted">Loading graph…</span>';
  try {
    const res = await pywebview.api.get_code_graph();
    if (!res.ok) {
      info.innerHTML = '<span class="text-term-muted italic">' + escapeHtml(res.error) + '</span>';
      legendEl.innerHTML = '';
      statsEl.textContent = '';
      if (graphNetwork) { graphNetwork.destroy(); graphNetwork = null; }
      graphLoaded = false;
      return;
    }
    renderGraph(res.graph, container, info, legendEl, statsEl);
    graphLoaded = true;
  } catch (e) {
    info.innerHTML = '<span class="text-term-red">Error: ' + escapeHtml('' + e) + '</span>';
  }
}

function renderGraph(data, container, infoEl, legendEl, statsEl) {
  // Destroy old network if present
  if (graphNetwork) { graphNetwork.destroy(); graphNetwork = null; }
  legendEl.innerHTML = '';

  const nodes = data.nodes.map(n => ({
    id: n.id, label: n.label, color: n.color, size: n.size,
    font: { size: 10, color: '#c9d1d9' },
    title: n.title,
    _community: n.community, _community_name: n.community_name,
    _source_file: n.source_file, _file_type: n.file_type, _degree: n.degree,
  }));
  const edges = data.edges.map((e, i) => ({
    id: i, from: e.from, to: e.to, label: '',
    title: e.title, dashes: e.dashes, width: e.width, color: e.color,
  }));

  const nodesDS = new vis.DataSet(nodes);
  const edgesDS = new vis.DataSet(edges);
  graphNetwork = new vis.Network(container, { nodes: nodesDS, edges: edgesDS }, {
    physics: {
      enabled: true, solver: 'forceAtlas2Based',
      forceAtlas2Based: { gravitationalConstant: -60, centralGravity: 0.005, springLength: 120, springConstant: 0.08, damping: 0.4, avoidOverlap: 0.8 },
      stabilization: { iterations: 200, fit: true },
    },
    interaction: { hover: true, tooltipDelay: 100, hideEdgesOnDrag: true },
    nodes: { shape: 'dot', borderWidth: 1.5 },
    edges: { smooth: { type: 'cubicBezier', forceDirection: 'none', roundness: 0.4 }, selectionWidth: 3 },
  });

  graphNetwork.once('stabilizationIterationsDone', () => {
    graphNetwork.setOptions({ physics: { enabled: false } });
  });

  function showInfo(nodeId) {
    const n = nodesDS.get(nodeId);
    if (!n) return;
    const neighborIds = graphNetwork.getConnectedNodes(nodeId);
    const neighborItems = neighborIds.map(nid => {
      const nb = nodesDS.get(nid);
      const color = nb ? nb.color.background : '#555';
      return `<span class="block rounded-md px-1.5 py-0.5 text-[11px] cursor-pointer hover:bg-term-line" style="border-left:3px solid ${color}" onclick="focusGraphNode(${JSON.stringify(nid)})">${escapeHtml(nb ? nb.label : nid)}</span>`;
    }).join('');
    infoEl.innerHTML = `
      <div class="font-semibold text-term-text mb-1">${escapeHtml(n.label)}</div>
      <div class="text-[11px] text-term-muted mb-0.5">community: ${escapeHtml(n._community_name)}</div>
      <div class="text-[11px] text-term-muted mb-0.5">source: ${escapeHtml(n._source_file || '-')}</div>
      <div class="text-[11px] text-term-muted mb-1">degree: ${n._degree}</div>
      ${neighborIds.length ? `<div class="text-[10px] text-term-muted mb-1">neighbors (${neighborIds.length})</div><div class="space-y-0.5 max-h-32 overflow-y-auto">${neighborItems}</div>` : ''}`;
  }
  window.__showGraphInfo = showInfo;
  window.focusGraphNode = (nid) => { graphNetwork.focus(nid, { scale: 1.4, animation: true }); graphNetwork.selectNodes([nid]); showInfo(nid); };

  let hovered = null;
  graphNetwork.on('hoverNode', p => { hovered = p.node; container.style.cursor = 'pointer'; });
  graphNetwork.on('blurNode', () => { hovered = null; container.style.cursor = 'default'; });
  graphNetwork.on('click', p => { if (p.nodes.length > 0) showInfo(p.nodes[0]); else if (hovered === null) infoEl.innerHTML = '<span class="text-term-muted italic">Click a node to inspect it</span>'; });

  // search
  const searchInput = $('graphSearch');
  searchInput.oninput = () => {
    const q = searchInput.value.toLowerCase().trim();
    if (!q) return;
    const match = data.nodes.find(n => n.label.toLowerCase().includes(q) || n.id.toLowerCase().includes(q));
    if (match) { graphNetwork.focus(match.id, { scale: 1.5, animation: true }); graphNetwork.selectNodes([match.id]); showInfo(match.id); }
  };

  // legend with toggle
  const hidden = new Set();
  data.legend.forEach(c => {
    const item = document.createElement('label');
    item.className = 'flex items-center gap-1.5 py-0.5 cursor-pointer text-[11px] hover:text-term-text';
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = true; cb.className = 'accent-term-cyan';
    cb.onchange = () => {
      if (cb.checked) hidden.delete(c.cid); else hidden.add(c.cid);
      nodesDS.update(data.nodes.filter(n => n.community === c.cid).map(n => ({ id: n.id, hidden: !cb.checked })));
    };
    const dot = document.createElement('span'); dot.className = 'w-2.5 h-2.5 rounded-full inline-block'; dot.style.background = c.color;
    const label = document.createElement('span'); label.className = 'flex-1 truncate text-term-muted'; label.textContent = c.label;
    const count = document.createElement('span'); count.className = 'text-[10px] text-term-muted'; count.textContent = c.count;
    item.append(cb, dot, label, count);
    legendEl.appendChild(item);
  });

  const s = data.stats;
  statsEl.textContent = `${s.total_nodes} nodes · ${s.total_edges} edges · ${s.total_communities} communities`;
}

// ---------- wiring ----------
function waitForPywebview() {
  return new Promise(resolve => {
    if (window.pywebview && pywebview.api) return resolve();
    window.addEventListener('pywebviewready', () => resolve(), { once: true });
  });
}

async function init() {
  await waitForPywebview();
  await loadStartScreen();

  $('newProjectBtn').addEventListener('click', () => {
    $('importFolderBox').classList.add('hidden'); $('importFolderBox').classList.remove('flex');
    const box = $('newProjectBox');
    box.classList.toggle('hidden');
    box.classList.toggle('flex');
    if (!box.classList.contains('hidden')) $('newProjectInput').focus();
  });
  $('createProjectConfirm').addEventListener('click', async () => {
    const name = $('newProjectInput').value.trim();
    if (!name) return;
    const res = await pywebview.api.create_project(name);
    if (res.ok) {
      await loadStartScreen();
      $('projectSelect').value = name;
      $('newProjectInput').value = '';
      $('newProjectBox').classList.add('hidden'); $('newProjectBox').classList.remove('flex');
    } else { $('startError').textContent = res.error; }
  });

  $('importFolderBtn').addEventListener('click', () => {
    $('newProjectBox').classList.add('hidden'); $('newProjectBox').classList.remove('flex');
    const box = $('importFolderBox');
    box.classList.toggle('hidden');
    box.classList.toggle('flex');
  });
  $('importBrowseBtn').addEventListener('click', browseImportFolder);
  $('importConfirmBtn').addEventListener('click', confirmImport);

  $('startSessionBtn').addEventListener('click', startSession);

  $('sendBtn').addEventListener('click', sendMessage);
  $('stopBtn').addEventListener('click', () => pywebview.api.stop());
  $('input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });

  $('refreshTreeBtn').addEventListener('click', async () => {
    if (!session) return;
    const r = await pywebview.api.get_file_tree();
    if (r && r.ok) renderFileTree(r.tree);
  });
  $('changeSessionBtn').addEventListener('click', async () => {
    await pywebview.api.end_session();
  });
  $('tabChat').addEventListener('click', () => switchTab('chat'));
  $('tabPlan').addEventListener('click', () => switchTab('plan'));
  $('tabGraph').addEventListener('click', () => switchTab('graph'));
  $('planBadge').addEventListener('click', () => switchTab('plan'));
  $('viewerClose').addEventListener('click', () => $('fileViewer').classList.add('hidden'));
  $('fileViewer').addEventListener('click', (e) => { if (e.target.id === 'fileViewer') $('fileViewer').classList.add('hidden'); });

  $('exportWorkspaceBtn').addEventListener('click', openExportModal);
  $('exportModalClose').addEventListener('click', closeExportModal);
  $('exportCancelBtn').addEventListener('click', closeExportModal);
  $('exportApproveBtn').addEventListener('click', approveExport);
  $('exportModal').addEventListener('click', (e) => { if (e.target.id === 'exportModal') closeExportModal(); });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      $('fileViewer').classList.add('hidden');
      closeExportModal();
    }
  });
}

window.addEventListener('load', init);
