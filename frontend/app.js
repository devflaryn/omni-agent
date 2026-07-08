// ===== Omni Agent frontend bridge =====
// Talks to the Python backend through pywebview's JS API and renders a
// terminal-style live view of the agent loop (with more detail than the old CLI).

const $ = (id) => document.getElementById(id);
const chat = $('chat');

let session = null;        // {project}
let autoScroll = true;
let replaying = false;     // true while a saved transcript is being replayed

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

// Coalesce scroll requests to one real scroll per animation frame. Events can
// arrive far faster than the display refreshes, and every `scrollTop =
// scrollHeight` forces a synchronous layout of the whole transcript.
let scrollQueued = false;
function scrollDown() {
  if (!autoScroll || replaying || scrollQueued) return;
  scrollQueued = true;
  requestAnimationFrame(() => {
    scrollQueued = false;
    if (autoScroll) chat.scrollTop = chat.scrollHeight;
  });
}

chat.addEventListener('scroll', () => {
  autoScroll = nearBottom();
});

// Cap how many rows live in the chat DOM at once. A long agent run can emit
// thousands of step lines; keeping them all (plus their text) is what OOMs the
// webview renderer. The full history is persisted server-side, so trimming the
// oldest visible rows here is safe.
const MAX_CHAT_ROWS = 1400;

function trimChat() {
  while (chat.children.length > MAX_CHAT_ROWS) chat.removeChild(chat.firstChild);
}

function appendRow(el) {
  // No entry animation during a transcript replay: animating hundreds of
  // restored rows at once stalls the compositor for no visual benefit.
  if (!replaying) el.classList.add('msg-enter');
  chat.appendChild(el);
  trimChat();
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

// ---------- input auto-grow ----------
// The composer has no fixed width (it fills the footer) and grows to fit its
// content up to a max, then scrolls — so short prompts are compact and long
// ones expand without a manual resize.
const INPUT_MAX_H = 260;
function autoGrowInput() {
  const ta = $('input');
  if (!ta) return;
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, INPUT_MAX_H) + 'px';
  ta.style.overflowY = ta.scrollHeight > INPUT_MAX_H ? 'auto' : 'hidden';
}
function resetInputHeight() {
  const ta = $('input');
  if (ta) { ta.style.height = 'auto'; ta.style.overflowY = 'hidden'; }
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

// ---------- lightweight inline formatting (Discord / WhatsApp style) ----------
// Applied to plain-text messages (user prompts + agent thoughts) so **bold**,
// *italic* / _italic_, ~~strike~~, `code` and ```code blocks``` render like a
// chat app — WITHOUT sending those messages through the full markdown pipeline
// (which would also turn a leading "# " into a heading, "- " into a list, etc.).
// HTML is escaped first and only a fixed set of safe tags is introduced, so this
// stays injection-safe on its own (no DOMPurify needed). Newlines are preserved
// by the container's `whitespace-pre-wrap`.
function formatInline(text) {
  let s = escapeHtml(text);

  // Pull code out first so markers inside it (e.g. ** or _) stay literal. Each
  // span is swapped for a NUL-delimited placeholder (\u0000 can't occur in the
  // escaped text) and restored at the very end.
  const stash = [];
  const keep = (html) => `\u0000${stash.push(html) - 1}\u0000`;

  // ```fenced blocks``` — optional leading language token, trailing newline trimmed
  s = s.replace(/```(?:[^\n`]*\n)?([\s\S]*?)```/g,
    (_, code) => keep(`<pre><code>${code.replace(/\n+$/, '')}</code></pre>`));
  // `inline code`
  s = s.replace(/`([^`\n]+)`/g, (_, code) => keep(`<code>${code}</code>`));

  // ***bold italic***  →  **bold**  →  *italic*  (no space just inside the markers)
  s = s.replace(/\*\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*\*/g, '<strong><em>$1</em></strong>');
  s = s.replace(/\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*(?=\S)([^*\n]+?)(?<=\S)\*/g, '<em>$1</em>');
  // __underline__ (Discord)
  s = s.replace(/__(?=\S)([\s\S]+?)(?<=\S)__/g, '<u>$1</u>');
  // _italic_ — only on word boundaries, so snake_case / file_name.py are left alone
  s = s.replace(/(^|[^\w])_(?=\S)([^_\n]+?)(?<=\S)_(?=[^\w]|$)/g, '$1<em>$2</em>');
  // ~~strikethrough~~ (double tilde only, so "~/path" and "~5" aren't mangled)
  s = s.replace(/~~(?=\S)([\s\S]+?)(?<=\S)~~/g, '<del>$1</del>');

  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => stash[+i]);
}

// ---------- event renderers ----------
function renderUserMessage(content) {
  currentGroup = null; // a new user turn starts a fresh set of action groups
  const el = document.createElement('div');
  el.className = 'py-1';
  el.innerHTML = `
    <div class="mb-0.5 text-[10px] text-term-muted"><span class="text-term-green">user</span> <span>${nowTime()}</span></div>
    <div class="msg-fmt whitespace-pre-wrap text-term-text">${formatInline(content)}</div>`;
  appendRow(el);
}

// ---------- agent activity: thought messages + action groups ----------
// The model's reasoning is printed as a real, white message. The action(s) it
// takes after that thought are grouped beneath it: the group shows the CURRENT
// action as a header, and clicking the header reveals the earlier actions in
// that same group. Actions NEVER show their raw tool output (that lives only in
// the agent's own context). A thought WITH text starts a new group; a turn with
// no narration just adds its action to the current group.

const SPIN_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
let spinFrame = 0;

// One global ticker animates the live spinner glyphs (at most a couple exist
// at a time). Live spinners register here instead of being found with a
// document-wide querySelectorAll on every tick, and the interval only runs
// while something is actually spinning.
const liveSpinners = new Set();
let spinTimer = null;

function registerSpinners(scope) {
  for (const el of scope.querySelectorAll('.braille-spin')) liveSpinners.add(el);
  if (liveSpinners.size && !spinTimer) spinTimer = setInterval(spinTick, 90);
}

function spinTick() {
  spinFrame = (spinFrame + 1) % SPIN_FRAMES.length;
  for (const el of liveSpinners) {
    if (!el.isConnected) { liveSpinners.delete(el); continue; }
    el.textContent = SPIN_FRAMES[spinFrame];
  }
  if (!liveSpinners.size) { clearInterval(spinTimer); spinTimer = null; }
}

let thinkingEl = null;     // the live "Thinking…" shimmer line, if any
let currentGroup = null;   // the action group following the most recent thought

// Reset the live-render state (called whenever the chat is cleared/replaced).
function resetActivityState() {
  thinkingEl = null;
  currentGroup = null;
}

function startThinking() {
  if (thinkingEl) return; // JSON-retry leg: reuse the existing line
  const el = document.createElement('div');
  el.className = 'py-0.5 font-mono text-[12px] leading-5';
  el.innerHTML = `<span class="braille-spin text-term-cyan">${SPIN_FRAMES[spinFrame]}</span> <span class="shimmer">Thinking…</span>`;
  appendRow(el);
  registerSpinners(el);
  thinkingEl = el;
}

// A thought arrived. Print it as a real white message, then (if it had actual
// narration) open a fresh action group beneath it. Empty-thought turns fall
// through so their action attaches to the current group.
function finishThinking(ev) {
  if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
  const text = (ev.text || '').trim();
  if (!text) return;
  const dur = fmtDuration(ev.elapsed_ms) || '0s';
  const el = document.createElement('div');
  el.className = 'py-1';
  el.innerHTML = `
    <div class="mb-0.5 text-[10px] text-term-muted"><span class="text-term-magenta">✻ thought</span> <span>${dur}</span></div>
    <div class="msg-fmt whitespace-pre-wrap text-term-text leading-6">${formatInline(text)}</div>`;
  appendRow(el);
  startActionGroup();
  scrollDown();
}

function startActionGroup() {
  const el = document.createElement('div');
  el.className = 'action-group ml-2 mb-1.5 border-l-2 border-term-line/60 pl-2';
  el.innerHTML = `
    <button type="button" class="group-head flex w-full items-center gap-2 rounded-lg px-1.5 py-0.5 text-left font-mono text-[12px] leading-5 hover:bg-term-line/30">
      <span class="group-caret caret invisible shrink-0 select-none text-[9px] leading-none text-term-muted">▶</span>
      <span class="group-current min-w-0 flex-1 truncate"></span>
      <span class="group-meta ml-auto shrink-0 text-[10.5px] tabular-nums text-term-muted"></span>
      <span class="group-count shrink-0 text-[10px] text-term-muted"></span>
    </button>
    <div class="group-past step-detail"><div class="step-detail-inner space-y-px py-0.5 pl-5 font-mono text-[12px] text-term-muted"></div></div>`;
  const head = el.querySelector('.group-head');
  const past = el.querySelector('.group-past');
  const pastInner = el.querySelector('.step-detail-inner');
  const caret = el.querySelector('.group-caret');
  head.addEventListener('click', () => {
    if (!pastInner.children.length) return; // nothing to reveal (single action)
    const open = past.classList.toggle('open');
    caret.classList.toggle('open', open);
  });
  currentGroup = {
    el, past, pastInner, caret,
    current: el.querySelector('.group-current'),
    meta: el.querySelector('.group-meta'),
    count: el.querySelector('.group-count'),
    liveId: null, liveEv: null, n: 0,
  };
  appendRow(el);
}

// Inline HTML for one action line (icon + tool name + arg summary). No output.
function actionInner(ev, state) {
  const icon = {
    live: `<span class="braille-spin text-term-cyan">${SPIN_FRAMES[spinFrame]}</span>`,
    done: '<span class="text-term-green">●</span>',
    warn: '<span class="text-term-red">!</span>',
    interrupted: '<span class="text-term-muted">○</span>',
  }[state];
  const nameCls = state === 'warn' ? 'text-term-red' : 'text-term-text';
  return `${icon} <span class="${nameCls}">${escapeHtml(ev.tool)}</span>` +
    ` <span class="text-term-muted">${escapeHtml(argSummary(ev.args))}</span>` +
    (state === 'warn' ? ' <span class="text-term-red">loop warning</span>' : '');
}

// Put an action into the current group's header, demoting the previous header
// action into the (collapsible, newest-first) past list.
function pushAction(ev, state) {
  if (!currentGroup) startActionGroup(); // safety: an action before any thought
  const g = currentGroup;
  if (g.n > 0) {
    const row = document.createElement('div');
    row.className = 'truncate';
    row.innerHTML = g.current.innerHTML;
    g.pastInner.insertBefore(row, g.pastInner.firstChild);
  }
  g.current.innerHTML = actionInner(ev, state);
  if (state === 'live') registerSpinners(g.current);
  g.meta.textContent = (state === 'live') ? '' : (fmtDuration(ev.run_ms) || '');
  g.liveId = (state === 'live') ? ev.id : null;
  g.liveEv = (state === 'live') ? ev : null;
  g.n += 1;
  const hidden = g.n - 1;
  if (hidden > 0) {
    g.caret.classList.remove('invisible');
    g.count.textContent = `+${hidden}`;
  }
}

function startTool(ev) {
  pushAction(ev, 'live');
  scrollDown();
}

function finishTool(ev) {
  const state = ev.is_loop_warning ? 'warn' : 'done';
  if (currentGroup && currentGroup.liveId === ev.id) {
    // finalize the live header action in place (no demotion)
    currentGroup.current.innerHTML = actionInner(ev, state);
    currentGroup.meta.textContent = fmtDuration(ev.run_ms) || '';
    currentGroup.liveId = null;
    currentGroup.liveEv = null;
  } else {
    // replay (no prior tool_running) or id mismatch: add as a finalized action
    pushAction(ev, state);
  }
  scrollDown();
}

// Freeze any still-live spinner when a run ends (done / stop / session change).
function finalizeLiveLines() {
  if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
  if (currentGroup && currentGroup.liveEv) {
    currentGroup.current.innerHTML = actionInner(currentGroup.liveEv, 'interrupted');
    currentGroup.meta.textContent = '';
    currentGroup.liveId = null;
    currentGroup.liveEv = null;
  }
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
      <div class="flex items-start gap-2 rounded-lg px-2 py-1.5 ${active ? 'bg-term-cyan/10 border border-term-cyan/30' : 'border border-transparent'}">
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
  // The full tab is rebuilt from innerHTML on every update, so only do it
  // while it's actually visible — switchTab('plan') renders it from
  // currentPlan when the user opens it.
  if (activeTab === 'plan') renderPlanTab(plan);
}

// ---------- file tree ----------
function fileIcon(name) {
  return name.endsWith('.md') ? '📘' :
    name.endsWith('.py') ? '🐍' :
    name.match(/\.(js|ts|jsx|tsx|html|css|json)$/) ? '🧩' :
    name.match(/\.(png|jpe?g|gif|webp|bmp|ico|svg)$/i) ? '🖼️' :
    name.match(/\.(zip|apk|jar|aar|xapk|apks|so|dex|bin|dat)$/i) ? '📦' : '📄';
}

// Directory paths the user currently has expanded. Preserved across tree
// re-renders so a mid-run refresh doesn't collapse what you were browsing.
// Only paths that were actually opened are ever rebuilt, so this keeps the
// lazy-render memory bound (we never eagerly build unopened folders).
const expandedDirs = new Set();

// Count files in a tree data object WITHOUT building any DOM (so the footer
// count stays correct even though folders render lazily).
function countTreeFiles(node) {
  if (!node) return 0;
  if (node.type === 'file') return 1;
  let n = 0;
  for (const c of (node.children || [])) n += countTreeFiles(c);
  return n;
}

// Build a tree row. Folders render their children LAZILY — the child DOM is
// created only the first time the folder is expanded. This bounds the live DOM
// to what the user has actually opened, instead of eagerly materializing every
// file in a huge (decompiled-APK) workspace, which is what OOM'd the renderer.
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
    let built = false; // lazy: children DOM is created on first expand only

    const buildChildren = () => {
      if (built) return;
      built = true;
      const frag = document.createDocumentFragment();
      for (const c of (node.children || [])) frag.appendChild(buildTreeNode(c, depth + 1));
      childWrap.appendChild(frag);
    };
    const setOpen = (open) => {
      childWrap.classList.toggle('hidden', !open);
      caret.classList.toggle('open', open);
      icon.textContent = open ? '📂' : '📁';
      if (open) { buildChildren(); expandedDirs.add(node.path); }
      else expandedDirs.delete(node.path);
    };
    row.addEventListener('click', () => setOpen(childWrap.classList.contains('hidden')));
    // Re-expand a folder that was open before this re-render (recurses into its
    // children, which restore their own state — only the previously-open subtree).
    if (expandedDirs.has(node.path)) setOpen(true);

    const wrap = document.createElement('div');
    wrap.appendChild(row);
    wrap.appendChild(childWrap);
    return wrap;
  } else {
    const spacer = document.createElement('span'); spacer.className = 'w-3 inline-block';
    const icon = document.createElement('span'); icon.textContent = fileIcon(node.name); icon.className = 'text-[12px]';
    const name = document.createElement('span'); name.textContent = node.name; name.className = 'text-term-text truncate flex-1';
    const size = document.createElement('span'); size.textContent = humanSize(node.size); size.className = 'text-[10px] text-term-muted';
    row.append(spacer, icon, name, size);
    row.addEventListener('click', () => {
      $('fileTree').querySelectorAll('.tree-row.active').forEach(r => r.classList.remove('active'));
      row.classList.add('active');
      openFileViewer(node.path);
    });
    return row;
  }
}

function renderFileTree(tree) {
  const root = $('fileTree');
  root.innerHTML = '';
  let count = 0;
  if (tree && tree.children) {
    const frag = document.createDocumentFragment();
    for (const c of tree.children) {
      frag.appendChild(buildTreeNode(c, 0)); // only the top level is built up front
      count += countTreeFiles(c);
    }
    root.appendChild(frag);
  }
  setStatus('treeFileCount', count);
}

// ---------- file viewer ----------
// When an archive (zip/apk/…) is open, this holds its workspace path and the
// header size label so "← archive" can return to the cached listing without
// re-reading the zip. null whenever the viewer shows a plain workspace file.
let archiveViewer = null;

// Switches which pane of the viewer body is visible ('text' | 'image' | 'archive').
// The back button shows only while previewing an entry *inside* an open archive.
function viewerShowPane(mode) {
  $('viewerContent').classList.toggle('hidden', mode !== 'text');
  $('viewerImage').classList.toggle('hidden', mode !== 'image');
  $('viewerImage').classList.toggle('flex', mode === 'image');
  $('viewerArchive').classList.toggle('hidden', mode !== 'archive');
  $('viewerBack').classList.toggle('hidden', !(archiveViewer && mode !== 'archive'));
}

function viewerShowError(msg) {
  $('viewerSize').textContent = '';
  $('viewerContent').textContent = 'Error: ' + msg;
  viewerShowPane('text');
}

// Renders a typed read_file / read_archive_member payload into the viewer body.
function renderViewerResult(res) {
  $('viewerSize').textContent = humanSize(res.size) + (res.truncated ? ' (truncated)' : '');
  if (res.kind === 'image') {
    $('viewerImage').querySelector('img').src = `data:${res.mime};base64,${res.data}`;
    viewerShowPane('image');
  } else if (res.kind === 'archive') {
    renderArchiveListing(res);
    viewerShowPane('archive');
  } else {
    $('viewerContent').textContent = res.content;
    viewerShowPane('text');
  }
}

async function openFileViewer(path) {
  if (!session) return;
  archiveViewer = null;
  $('viewerPath').textContent = path;
  $('viewerSize').textContent = 'loading…';
  $('viewerContent').textContent = '';
  $('viewerImage').querySelector('img').removeAttribute('src');
  viewerShowPane('text');
  $('fileViewer').classList.remove('hidden');
  try {
    const res = await pywebview.api.read_file(path);
    if (!res.ok) { viewerShowError(res.error); return; }
    if (res.kind === 'archive') archiveViewer = { path };
    renderViewerResult(res);
    if (archiveViewer) archiveViewer.sizeLabel = $('viewerSize').textContent;
  } catch (e) {
    viewerShowError(e);
  }
}

// Groups the archive's flat entry names ("res/layout/a.xml") into a nested
// {dirs: Map, files: []} structure for the explorer. Intermediate directories
// are created even when the zip has no explicit dir entries for them.
function buildArchiveTree(entries) {
  const root = { dirs: new Map(), files: [] };
  for (const e of entries) {
    const parts = e.name.split('/').filter(Boolean);
    if (!parts.length) continue;
    let node = root;
    const dirCount = e.dir ? parts.length : parts.length - 1;
    for (let i = 0; i < dirCount; i++) {
      if (!node.dirs.has(parts[i])) node.dirs.set(parts[i], { dirs: new Map(), files: [] });
      node = node.dirs.get(parts[i]);
    }
    if (!e.dir) node.files.push({ name: parts[parts.length - 1], full: e.name, size: e.size });
  }
  return root;
}

// Appends rows for one directory level; children build lazily on first expand,
// same as the workspace tree, so a 10k-entry APK doesn't materialize all at once.
function appendArchiveLevel(container, node, depth) {
  const dirs = [...node.dirs.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const files = [...node.files].sort((a, b) => a.name.localeCompare(b.name));
  for (const [dirName, child] of dirs) {
    const row = document.createElement('div');
    row.className = 'tree-row flex items-center gap-1 rounded-md px-1 py-0.5 cursor-pointer select-none';
    row.style.paddingLeft = (depth * 12 + 4) + 'px';
    const caret = document.createElement('span');
    caret.className = 'caret text-term-muted w-3 inline-block text-[10px]'; caret.textContent = '▶';
    const icon = document.createElement('span'); icon.textContent = '📁'; icon.className = 'text-[12px]';
    const name = document.createElement('span'); name.textContent = dirName; name.className = 'text-term-text truncate';
    row.append(caret, icon, name);
    const childWrap = document.createElement('div');
    childWrap.className = 'hidden';
    let built = false;
    row.addEventListener('click', () => {
      const open = childWrap.classList.contains('hidden');
      if (open && !built) { built = true; appendArchiveLevel(childWrap, child, depth + 1); }
      childWrap.classList.toggle('hidden', !open);
      caret.classList.toggle('open', open);
      icon.textContent = open ? '📂' : '📁';
    });
    container.append(row, childWrap);
  }
  for (const f of files) {
    const row = document.createElement('div');
    row.className = 'tree-row flex items-center gap-1 rounded-md px-1 py-0.5 cursor-pointer select-none';
    row.style.paddingLeft = (depth * 12 + 4) + 'px';
    const spacer = document.createElement('span'); spacer.className = 'w-3 inline-block';
    const icon = document.createElement('span'); icon.textContent = fileIcon(f.name); icon.className = 'text-[12px]';
    const name = document.createElement('span'); name.textContent = f.name; name.className = 'text-term-text truncate flex-1';
    const size = document.createElement('span'); size.textContent = humanSize(f.size); size.className = 'text-[10px] text-term-muted';
    row.append(spacer, icon, name, size);
    row.addEventListener('click', () => openArchiveMember(f.full));
    container.appendChild(row);
  }
}

function renderArchiveListing(res) {
  const root = $('viewerArchive');
  root.innerHTML = '';
  appendArchiveLevel(root, buildArchiveTree(res.entries), 0);
  if (res.truncated) {
    const note = document.createElement('div');
    note.className = 'text-[10px] text-term-muted mt-2 px-1';
    note.textContent = `Showing ${res.entries.length.toLocaleString()} of ${res.entry_count.toLocaleString()} entries.`;
    root.appendChild(note);
  }
}

// Previews one file from inside the currently open archive (text or image).
async function openArchiveMember(entry) {
  if (!archiveViewer) return;
  $('viewerPath').textContent = archiveViewer.path + ' › ' + entry;
  $('viewerSize').textContent = 'loading…';
  try {
    const res = await pywebview.api.read_archive_member(archiveViewer.path, entry);
    if (!res.ok) { viewerShowError(res.error); return; }
    renderViewerResult(res);
  } catch (e) {
    viewerShowError(e);
  }
}

// "← archive": return from an entry preview to the still-rendered listing.
function backToArchiveListing() {
  if (!archiveViewer) return;
  $('viewerPath').textContent = archiveViewer.path;
  $('viewerSize').textContent = archiveViewer.sizeLabel || '';
  viewerShowPane('archive');
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
    // No scrollDown() here: every renderer that appends to the chat already
    // requests one, and non-chat events (status/file_tree/plan) don't need it.
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
  // the run may have changed the knowledge graph: rebuild it now if it's on
  // screen, otherwise just mark it stale so the next visit refetches
  graphLoaded = false;
  if (activeTab === 'graph') loadGraph();
}

// Upload files from the host machine into the current project's workspace via a
// native OS file picker (the backend copies them in, then returns the fresh tree).
async function uploadFiles() {
  if (!session) return;
  const btn = $('uploadFilesBtn');
  btn.disabled = true;
  $('hint').textContent = 'choose files to upload…';
  try {
    const res = await pywebview.api.upload_files('');
    if (!res || !res.ok) {
      $('hint').textContent = (res && res.error) ? ('upload failed: ' + res.error) : 'upload failed';
    } else if (res.cancelled) {
      $('hint').textContent = 'upload cancelled';
    } else {
      const n = (res.copied || []).length;
      $('hint').textContent = n
        ? `uploaded ${n} file${n === 1 ? '' : 's'} to workspace`
        : 'no files uploaded';
      if (res.tree) renderFileTree(res.tree);
      else { const r = await pywebview.api.get_file_tree(); if (r && r.ok) renderFileTree(r.tree); }
    }
  } catch (e) {
    $('hint').textContent = 'upload error: ' + e;
  } finally {
    btn.disabled = false;
    // restore the idle hint a few seconds later, unless the agent is now working
    setTimeout(() => { if (!$('input').disabled) $('hint').textContent = 'ready'; }, 4000);
  }
}

function onSessionStarted(ev) {
  finalizeLiveLines();
  session = { project: ev.project };
  $('app').classList.remove('hidden');
  $('startScreen').classList.add('hidden');
  $('projectBadge').textContent = ev.project;
  $('treeProjectName').textContent = ev.project;
  $('chat').innerHTML = '';
  resetActivityState();
  expandedDirs.clear(); // a new/re-opened workspace starts with nothing expanded
  autoScroll = true;
  setBusy(!!ev.busy);

  // Rebuild the prior chat exactly by replaying the saved renderable events
  // (restored on a webview refresh or when reopening a workspace). If there's
  // no transcript, show the usual one-line workspace banner.
  const transcript = Array.isArray(ev.transcript) ? ev.transcript : [];
  if (transcript.length) {
    // Replay in bulk mode: no per-row entry animation and no per-event
    // scroll/layout — one scroll to the bottom once the DOM is rebuilt.
    replaying = true;
    try {
      for (const e of transcript) { try { window.__agent.onEvent(e); } catch (_) {} }
    } finally {
      replaying = false;
    }
    chat.scrollTop = chat.scrollHeight;
  } else {
    renderSystem(`Workspace: ${ev.project}`);
  }
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
  resetGraph(); // this session's graph may differ from the previous one's
  if (activeTab === 'graph') loadGraph();
  resetInputHeight();
  scrollDown();
}

function onSessionEnded() {
  finalizeLiveLines();
  session = null;
  $('app').classList.add('hidden');
  $('startScreen').classList.remove('hidden');
  $('chat').innerHTML = '';
  resetActivityState();
  expandedDirs.clear();
  renderPlan(null);
  resetGraph();
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

// ---------- LLM provider settings ----------
let _llmProviders = [];   // preset metadata from the backend
let _llmSaved = null;     // the currently-saved effective config
let _llmActiveProvider = null; // which provider tab is selected in the modal

function _llmProvider(id) { return _llmProviders.find(p => p.id === id) || null; }

async function openLlmModal() {
  $('llmError').textContent = '';
  $('llmTestResult').textContent = '';
  $('llmModal').classList.remove('hidden');
  try {
    const res = await pywebview.api.get_llm_config();
    if (!res || !res.ok) {
      $('llmError').textContent = (res && res.error) || 'Failed to load LLM config.';
      return;
    }
    _llmProviders = res.providers || [];
    _llmSaved = res.config || {};
    renderLlmTabs();
    selectLlmProvider(_llmSaved.provider, true);
  } catch (e) {
    $('llmError').textContent = '' + e;
  }
}

function closeLlmModal() { $('llmModal').classList.add('hidden'); }

function renderLlmTabs() {
  const wrap = $('llmProviderTabs');
  wrap.innerHTML = '';
  _llmProviders.forEach(p => {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.pid = p.id;
    b.textContent = p.label;
    b.className = 'rounded-full border px-3 py-1 text-[12px] border-term-line text-term-muted hover:bg-term-line/60 hover:text-term-text';
    b.addEventListener('click', () => selectLlmProvider(p.id, false));
    wrap.appendChild(b);
  });
}

// Populate the form for a provider. `useSaved` keeps the saved key/model/base
// URL only when this is the provider that's actually saved; switching to a
// different provider tab shows that provider's fresh defaults instead.
function selectLlmProvider(id, useSaved) {
  const p = _llmProvider(id) || _llmProviders[0];
  if (!p) return;
  _llmActiveProvider = p.id;

  for (const b of $('llmProviderTabs').children) {
    const active = b.dataset.pid === p.id;
    b.className = 'rounded-full border px-3 py-1 text-[12px] ' + (active
      ? 'bg-term-cyan text-white border-term-cyan'
      : 'border-term-line text-term-muted hover:bg-term-line/60 hover:text-term-text');
  }

  const savedThis = !!(useSaved && _llmSaved && _llmSaved.provider === p.id);
  $('llmKey').value = savedThis ? (_llmSaved.api_key || '') : '';
  $('llmModel').value = savedThis ? (_llmSaved.model || p.default_model || '') : (p.default_model || '');
  $('llmBaseUrl').value = savedThis ? (_llmSaved.base_url || p.base_url || '') : (p.base_url || '');
  $('llmKey').placeholder = p.requires_key ? (p.key_hint || 'API key') : (p.key_hint || 'not required for this provider');
  $('llmProviderNotes').textContent = p.notes || '';

  const showMax = p.protocol === 'anthropic';
  $('llmMaxTokensRow').classList.toggle('hidden', !showMax);
  $('llmMaxTokens').value = (showMax && savedThis && _llmSaved.max_tokens) ? _llmSaved.max_tokens : '';

  $('llmTestResult').textContent = '';
  $('llmError').textContent = '';
}

function _llmFormValues() {
  const v = {
    provider: _llmActiveProvider,
    api_key: $('llmKey').value.trim(),
    model: $('llmModel').value.trim(),
    base_url: $('llmBaseUrl').value.trim(),
  };
  const mt = $('llmMaxTokens').value.trim();
  if (mt) v.max_tokens = parseInt(mt, 10);
  return v;
}

async function testLlmConnection() {
  const btn = $('llmTestBtn');
  btn.disabled = true;
  $('llmTestResult').className = 'text-[11px] text-term-muted';
  $('llmTestResult').textContent = 'testing…';
  try {
    const res = await pywebview.api.test_llm_config(_llmFormValues());
    if (res && res.ok) {
      $('llmTestResult').className = 'text-[11px] text-term-green';
      $('llmTestResult').textContent = `✓ ${res.provider} · ${res.model}` + (res.reply ? ` — “${res.reply}”` : ' — reachable');
    } else {
      $('llmTestResult').className = 'text-[11px] text-term-red';
      $('llmTestResult').textContent = '✕ ' + ((res && res.error) || 'connection failed');
    }
  } catch (e) {
    $('llmTestResult').className = 'text-[11px] text-term-red';
    $('llmTestResult').textContent = '✕ ' + e;
  } finally {
    btn.disabled = false;
  }
}

async function saveLlmConfig() {
  $('llmError').textContent = '';
  const btn = $('llmSaveBtn');
  btn.disabled = true; btn.textContent = 'saving…';
  try {
    const res = await pywebview.api.save_llm_config(_llmFormValues());
    if (res && res.ok) {
      closeLlmModal();
      if (session) renderSystem(`LLM provider set to ${res.label} · ${res.model}. New messages will use it.`);
    } else {
      $('llmError').textContent = (res && res.error) || 'Save failed.';
    }
  } catch (e) {
    $('llmError').textContent = '' + e;
  } finally {
    btn.disabled = false; btn.textContent = 'save';
  }
}

// ---------- input ----------
async function sendMessage() {
  const input = $('input');
  const text = input.value.trim();
  if (!text || !session) return;

  // /clear — start a fresh conversation for this workspace. Only the chat is
  // wiped; memory summaries, the plan and files on disk are all kept.
  if (text.toLowerCase() === '/clear') {
    input.value = '';
    resetInputHeight();
    try {
      const res = await pywebview.api.clear_chat();
      if (!res || !res.ok) { renderError((res && res.error) || 'clear failed'); return; }
      $('chat').innerHTML = '';
      resetActivityState();
      autoScroll = true;
      renderSystem('New conversation started — memory, plan and files kept.');
    } catch (e) {
      renderError('' + e);
    }
    return;
  }

  input.value = '';
  resetInputHeight();
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
let graph2D = null;         // vis.Network (2D view)
let graph3D = null;         // ForceGraph3D instance (3D view)
let graph2DNodesDS = null;  // vis DataSet backing the 2D view (for show/hide)
let graphLoaded = false;
let activeTab = 'chat';

// 2D (vis-network, canvas) is the default because it renders reliably inside the
// desktop WebView; 3D needs WebGL, which some WebView/GPU combos block. The user
// can switch to 3D via the toggle, and their choice is remembered. A prior 3D
// choice that fails at render time auto-falls back to 2D (see renderGraph).
let graphMode = (localStorage.getItem('omni-graph-mode') === '3d') ? '3d' : '2d';

// Mode-independent lookups, rebuilt on each data load and used by the sidebar
// (info panel / legend / search) regardless of 2D vs 3D.
let _graphRaw = null;
let _nodesById = new Map();
let _adj = new Map();
let _hiddenCommunities = new Set();

// Read a theme CSS variable (stored as "R G B") as a CSS color string, so the
// 3D scene background and 2D label color follow the active light/dark theme.
function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const p = v.split(/\s+/);
  return p.length === 3 ? `rgb(${p.join(',')})` : (v || fallback);
}

// Drop whichever graph engine(s) belong to the session that's going away
// (WebGL context, canvases, datasets, physics state), instead of leaking them.
function resetGraph() {
  if (graph2D) { graph2D.destroy(); graph2D = null; }
  if (graph3D) { try { graph3D._destructor(); } catch (e) {} graph3D = null; }
  graph2DNodesDS = null;
  graphLoaded = false;
  _graphRaw = null;
  _nodesById = new Map();
  _adj = new Map();
  _hiddenCommunities = new Set();
  currentGraphId = null;
  const row = $('graphSelectRow');
  if (row) { row.classList.add('hidden'); row.classList.remove('flex'); }
}

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
    // Rebuilding the graph (fetch + layout) on every tab visit is expensive;
    // reuse it until a finished run invalidates it. The tab was hidden (and so
    // zero-size) while off-screen, so nudge the active engine to re-fit.
    if (!graphLoaded) loadGraph();
    else {
      if (graph2D) setTimeout(() => { graph2D.redraw(); graph2D.fit(); }, 50);
      if (graph3D) setTimeout(() => { resizeGraph3D(); try { graph3D.zoomToFit(400, 60); } catch (e) {} }, 50);
    }
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

// ---------- knowledge graph visualization (2D vis-network / 3D force-graph) ----------
// Which named graph is currently shown. A workspace can hold several (one per
// app version); null means "let the backend pick the most recently built one".
let currentGraphId = null;

// Fill the per-version graph selector. Hidden unless more than one graph exists.
function populateGraphSelect(graphs, chosen) {
  const row = $('graphSelectRow'), sel = $('graphSelect');
  if (!row || !sel) return;
  if (!graphs || graphs.length <= 1) { row.classList.add('hidden'); row.classList.remove('flex'); return; }
  row.classList.remove('hidden'); row.classList.add('flex');
  sel.innerHTML = '';
  for (const g of graphs) {
    const o = document.createElement('option');
    o.value = g.id;
    const meta = [g.root, g.classes ? g.classes + ' classes' : ''].filter(Boolean).join(' · ');
    o.textContent = meta ? `${g.id} (${meta})` : g.id;
    if (g.id === chosen) o.selected = true;
    sel.appendChild(o);
  }
}

async function loadGraph(graphId) {
  const info = $('graphInfo');
  if (!session) {
    info.innerHTML = '<span class="text-term-muted italic">No active session.</span>';
    return;
  }
  info.innerHTML = '<span class="text-term-muted">Loading graph…</span>';
  try {
    // Explicit id (from the selector) wins; otherwise reuse the current pick, or
    // null so the backend defaults to the most recently built graph.
    const wantId = (graphId != null && graphId !== '') ? graphId : (currentGraphId || null);
    const res = await pywebview.api.get_code_graph(wantId);
    if (res && res.graphs) populateGraphSelect(res.graphs, res.graph_id);
    if (res && res.graph_id) currentGraphId = res.graph_id;
    if (!res.ok) {
      info.innerHTML = '<span class="text-term-muted italic">' + escapeHtml(res.error) + '</span>';
      $('graphLegend').innerHTML = '';
      $('graphStats').textContent = '';
      if (graph2D) { graph2D.destroy(); graph2D = null; }
      if (graph3D) { try { graph3D._destructor(); } catch (e) {} graph3D = null; }
      graphLoaded = false;
      return;
    }
    // An empty graph (build_code_graph indexed no .smali classes) would draw a
    // blank canvas — say so explicitly instead of leaving a mystery empty view.
    if (!res.graph || !res.graph.nodes || !res.graph.nodes.length) {
      // If OTHER built graphs actually have nodes, this empty one was likely a
      // stray/mis-targeted build — surface them and keep the selector visible so
      // the user can switch instead of being stuck on the empty view.
      const withData = (res.graphs || []).filter(g => g.id !== res.graph_id && (g.classes || 0) > 0);
      let msg = 'Graph "' + escapeHtml(res.graph_id || '(default)') + '" has no nodes — it was ' +
        'built over a directory with no .smali classes. Run build_code_graph on the decompiled ' +
        'smali root (e.g. the apktool output directory).';
      if (withData.length) {
        msg += ' These built graphs DO have data: ' + withData.map(g => escapeHtml(g.id)).join(', ') +
          ' — pick one from the selector above.';
      }
      showGraphError($('graphContainer'), msg);
      // Reveal the selector (even for the empty pick) whenever there's more than
      // one graph, so switching to a populated one is possible.
      populateGraphSelect(res.graphs, res.graph_id);
      $('graphLegend').innerHTML = '';
      $('graphStats').textContent = '';
      info.innerHTML = '<span class="text-term-muted italic">No graph nodes to inspect.</span>';
      // Do NOT latch graphLoaded here — leaving it false lets a later tab visit or
      // a fresh build retry the fetch instead of freezing on the empty state.
      graphLoaded = false;
      return;
    }
    renderGraph(res.graph);
    graphLoaded = true;
    // renderGraph populates the canvas/legend/stats but not this sidebar panel,
    // so clear the "Loading graph…" placeholder now that the graph is drawn.
    info.innerHTML = '<span class="text-term-muted italic">Click a node to inspect it</span>';
  } catch (e) {
    info.innerHTML = '<span class="text-term-red">Error: ' + escapeHtml('' + e) + '</span>';
  }
}

// Coordinator: cache the data, rebuild the shared lookups + sidebar, then draw
// the active mode. Also called (without a refetch) when the 2D/3D toggle flips.
function renderGraph(data) {
  _graphRaw = data;
  const container = $('graphContainer');

  _nodesById = new Map(data.nodes.map(n => [n.id, n]));
  _adj = new Map();
  for (const e of data.edges) {
    if (!_adj.has(e.from)) _adj.set(e.from, new Set());
    if (!_adj.has(e.to)) _adj.set(e.to, new Set());
    _adj.get(e.from).add(e.to);
    _adj.get(e.to).add(e.from);
  }
  _hiddenCommunities = new Set();

  renderGraphLegend(data);
  wireGraphSearch(data);

  // Tear down any previous engine (free its WebGL/canvas), then clear the host.
  if (graph2D) { graph2D.destroy(); graph2D = null; }
  if (graph3D) { try { graph3D._destructor(); } catch (e) {} graph3D = null; }
  graph2DNodesDS = null;
  container.innerHTML = '';

  // Draw the active mode, degrading gracefully instead of leaving a blank canvas.
  // Both engines are vendored locally (frontend/vendor), so they load offline;
  // 3D still needs WebGL, which can throw (or silently fail) inside the desktop
  // WebView. So: if the 3D library is absent, drop to 2D up front; if the 3D
  // engine throws while building, catch it and retry in 2D; if 2D is unavailable
  // or also throws, show an explicit message rather than nothing.
  const has3D = typeof ForceGraph3D !== 'undefined';
  const has2D = typeof vis !== 'undefined';
  if (graphMode === '3d' && !has3D) graphMode = '2d';

  let drew = false;
  if (graphMode === '3d') {
    try {
      renderGraph3D(data, container);
      drew = true;
    } catch (e) {
      console.error('3D graph render failed, falling back to 2D:', e);
      if (graph3D) { try { graph3D._destructor(); } catch (_) {} graph3D = null; }
      container.innerHTML = '';
      graphMode = '2d';
    }
  }
  if (!drew) {
    if (!has2D) {
      showGraphError(container,
        'The graph library (vis-network) failed to load from frontend/vendor. ' +
        'Reinstall/repair the app files, then reopen the Graph tab.');
      return;
    }
    try {
      renderGraph2D(data, container);
      drew = true;
    } catch (e) {
      console.error('2D graph render failed:', e);
      showGraphError(container, 'Failed to render the graph: ' + (e && e.message ? e.message : e));
      return;
    }
  }

  const s = data.stats;
  $('graphStats').textContent =
    `${s.total_nodes} nodes · ${s.total_edges} edges · ${s.total_communities} communities · ${graphMode.toUpperCase()}`;
  localStorage.setItem('omni-graph-mode', graphMode);  // persist any auto-fallback
  updateGraphModeButton();
}

// Show a centered message in the graph host when no engine could draw (library
// missing, WebGL unavailable, or a render error) — never a silent blank canvas.
function showGraphError(container, msg) {
  container.innerHTML =
    '<div class="absolute inset-0 flex items-center justify-center p-6 text-center">' +
    '<span class="text-term-muted text-[13px] max-w-sm leading-relaxed">' + escapeHtml(msg) + '</span></div>';
  $('graphStats').textContent = '';
}

function updateGraphModeButton() {
  // Label shows the mode you'll switch TO (the action), not the current one, so
  // a click is unambiguous: in 2D it reads "3D", in 3D it reads "2D".
  const b = $('graphModeToggle');
  if (b) b.textContent = (graphMode === '3d') ? '2D' : '3D';
}

function toggleGraphMode() {
  graphMode = (graphMode === '3d') ? '2d' : '3d';
  localStorage.setItem('omni-graph-mode', graphMode);
  if (_graphRaw) renderGraph(_graphRaw);  // re-render the cached graph in the new mode
}

// --- shared sidebar (identical in both modes) ---
function renderNodeInfo(nodeId) {
  const n = _nodesById.get(nodeId);
  if (!n) return;
  const neighbors = [...(_adj.get(nodeId) || [])];
  const items = neighbors.map(nid => {
    const nb = _nodesById.get(nid);
    const color = (nb && nb.color && nb.color.background) || '#555';
    return `<span class="block rounded-md px-1.5 py-0.5 text-[11px] cursor-pointer hover:bg-term-line" style="border-left:3px solid ${color}" onclick="focusGraphNode(${JSON.stringify(nid)})">${escapeHtml(nb ? nb.label : nid)}</span>`;
  }).join('');
  $('graphInfo').innerHTML = `
    <div class="font-semibold text-term-text mb-1">${escapeHtml(n.label)}</div>
    <div class="text-[11px] text-term-muted mb-0.5">community: ${escapeHtml(n.community_name)}</div>
    <div class="text-[11px] text-term-muted mb-0.5">source: ${escapeHtml(n.source_file || '-')}</div>
    <div class="text-[11px] text-term-muted mb-1">degree: ${n.degree}</div>
    ${neighbors.length ? `<div class="text-[10px] text-term-muted mb-1">neighbors (${neighbors.length})</div><div class="space-y-0.5 max-h-32 overflow-y-auto">${items}</div>` : ''}`;
}

// Center/select a node in whichever engine is active, then show its info.
// Exposed globally because neighbor chips + the search box call it inline.
function focusGraphNode(nodeId) {
  if (graphMode === '3d') focusNode3D(nodeId);
  else if (graph2D) { graph2D.focus(nodeId, { scale: 1.4, animation: true }); graph2D.selectNodes([nodeId]); }
  renderNodeInfo(nodeId);
}
window.focusGraphNode = focusGraphNode;

function renderGraphLegend(data) {
  const legendEl = $('graphLegend');
  legendEl.innerHTML = '';
  data.legend.forEach(c => {
    const item = document.createElement('label');
    item.className = 'flex items-center gap-1.5 py-0.5 cursor-pointer text-[11px] hover:text-term-text';
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = true; cb.className = 'accent-term-cyan';
    cb.onchange = () => {
      if (cb.checked) _hiddenCommunities.delete(c.cid); else _hiddenCommunities.add(c.cid);
      applyCommunityVisibility();
    };
    const dot = document.createElement('span'); dot.className = 'w-2.5 h-2.5 rounded-full inline-block'; dot.style.background = c.color;
    const label = document.createElement('span'); label.className = 'flex-1 truncate text-term-muted'; label.textContent = c.label;
    const count = document.createElement('span'); count.className = 'text-[10px] text-term-muted'; count.textContent = c.count;
    item.append(cb, dot, label, count);
    legendEl.appendChild(item);
  });
}

function applyCommunityVisibility() {
  if (graphMode === '2d' && graph2DNodesDS) {
    graph2DNodesDS.update(_graphRaw.nodes.map(n => ({ id: n.id, hidden: _hiddenCommunities.has(n.community) })));
  } else if (graphMode === '3d' && graph3D) {
    // Re-setting the accessors forces the engine to re-evaluate visibility.
    graph3D.nodeVisibility(n => !_hiddenCommunities.has(n._community));
    graph3D.linkVisibility(l => {
      const sc = (l.source && typeof l.source === 'object') ? l.source._community : (_nodesById.get(l.source) || {}).community;
      const tc = (l.target && typeof l.target === 'object') ? l.target._community : (_nodesById.get(l.target) || {}).community;
      return !_hiddenCommunities.has(sc) && !_hiddenCommunities.has(tc);
    });
  }
}

function wireGraphSearch(data) {
  const searchInput = $('graphSearch');
  searchInput.oninput = () => {
    const q = searchInput.value.toLowerCase().trim();
    if (!q) return;
    const m = data.nodes.find(n => n.label.toLowerCase().includes(q) || n.id.toLowerCase().includes(q));
    if (m) focusGraphNode(m.id);
  };
}

// --- 3D (three.js via 3d-force-graph) ---
function resizeGraph3D() {
  if (!graph3D) return;
  const c = $('graphContainer');
  graph3D.width(c.clientWidth || 800).height(c.clientHeight || 600);
}

function focusNode3D(nodeId) {
  if (!graph3D) return;
  const node = graph3D.graphData().nodes.find(x => x.id === nodeId);
  if (!node || node.x == null) return;                 // layout not settled yet
  const dist = 140;
  const r = 1 + dist / Math.max(1, Math.hypot(node.x, node.y, node.z || 0));
  graph3D.cameraPosition({ x: node.x * r, y: node.y * r, z: (node.z || 0) * r }, node, 1200);
}

function renderGraph3D(data, container) {
  const nodes = data.nodes.map(n => ({
    id: n.id, label: n.label, title: n.title,
    _bg: (n.color && n.color.background) || '#8a877f',
    _community: n.community, _degree: n.degree,
  }));
  const links = data.edges.map(e => ({ source: e.from, target: e.to, _width: e.width }));

  graph3D = ForceGraph3D()(container)
    .backgroundColor(cssVar('--term-bg', '#262624'))
    .graphData({ nodes, links })
    .nodeId('id')
    .nodeLabel(n => n.title || n.label)                       // hover tooltip
    .nodeVal(n => 1 + Math.min((n._degree || 0) * 0.35, 14))  // sphere size ~ degree
    .nodeRelSize(3)
    .nodeColor(n => n._bg)                                    // community color
    .nodeOpacity(0.95)
    .linkColor(() => 'rgba(160,158,150,0.22)')
    .linkWidth(l => Math.max(0.4, (l._width || 1) * 0.4))
    .linkOpacity(0.55)
    .warmupTicks(24)
    .cooldownTicks(140)
    .onNodeHover(node => { container.style.cursor = node ? 'pointer' : 'default'; })
    .onNodeClick(node => { focusNode3D(node.id); renderNodeInfo(node.id); })
    // Once the force layout settles, frame the whole graph so it's never left
    // tiny/off-camera (which reads as "3D is broken"). Guarded because the tab
    // may be hidden — zoomToFit on a zero-size canvas is a no-op we retry on show.
    .onEngineStop(() => { try { if (activeTab === 'graph') graph3D.zoomToFit(500, 60); } catch (e) {} });

  resizeGraph3D();
}

// --- 2D (vis-network) ---
function renderGraph2D(data, container) {
  const labelColor = cssVar('--term-text', '#c9d1d9');
  const nodes = data.nodes.map(n => ({
    id: n.id, label: n.label, color: n.color, size: n.size,
    font: { size: 10, color: labelColor },
    title: n.title, hidden: _hiddenCommunities.has(n.community),
    _community: n.community,
  }));
  const edges = data.edges.map((e, i) => ({
    id: i, from: e.from, to: e.to, label: '',
    title: e.title, dashes: e.dashes, width: e.width, color: e.color,
  }));

  const nodesDS = new vis.DataSet(nodes);
  const edgesDS = new vis.DataSet(edges);
  graph2DNodesDS = nodesDS;
  graph2D = new vis.Network(container, { nodes: nodesDS, edges: edgesDS }, {
    physics: {
      enabled: true, solver: 'forceAtlas2Based',
      forceAtlas2Based: { gravitationalConstant: -60, centralGravity: 0.005, springLength: 120, springConstant: 0.08, damping: 0.4, avoidOverlap: 0.8 },
      stabilization: { iterations: 200, fit: true },
    },
    interaction: { hover: true, tooltipDelay: 100, hideEdgesOnDrag: true },
    nodes: { shape: 'dot', borderWidth: 1.5 },
    edges: { smooth: { type: 'cubicBezier', forceDirection: 'none', roundness: 0.4 }, selectionWidth: 3 },
  });
  graph2D.once('stabilizationIterationsDone', () => graph2D.setOptions({ physics: { enabled: false } }));

  let hovered = null;
  graph2D.on('hoverNode', p => { hovered = p.node; container.style.cursor = 'pointer'; });
  graph2D.on('blurNode', () => { hovered = null; container.style.cursor = 'default'; });
  graph2D.on('click', p => {
    if (p.nodes.length > 0) renderNodeInfo(p.nodes[0]);
    else if (hovered === null) $('graphInfo').innerHTML = '<span class="text-term-muted italic">Click a node to inspect it</span>';
  });
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
  // Always populate the start screen's project list first (so "change session"
  // later has a ready dropdown), then — if a backend session is still alive
  // (e.g. after a webview refresh or an Out-of-Memory renderer reload) —
  // reconnect and replay the chat instead of dropping to the start screen.
  await loadStartScreen();
  try {
    const st = await pywebview.api.get_state();
    if (st && st.active) await pywebview.api.restore_session();
  } catch (e) { /* stay on the start screen */ }

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

  $('deleteProjectBtn').addEventListener('click', async () => {
    $('startError').textContent = '';
    const project = $('projectSelect').value;
    if (!project || project.startsWith('(')) {
      $('startError').textContent = 'Pick a valid project to delete.'; return;
    }
    if (!confirm(`Delete workspace "${project}"?\n\nThis permanently removes its files and saved conversation. This cannot be undone.`)) return;
    const btn = $('deleteProjectBtn'); btn.disabled = true;
    try {
      const res = await pywebview.api.delete_workspace(project);
      if (res.ok) await loadStartScreen();
      else $('startError').textContent = res.error || 'Failed to delete workspace.';
    } catch (e) {
      $('startError').textContent = '' + e;
    } finally {
      btn.disabled = false;
    }
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
  $('input').addEventListener('input', autoGrowInput);
  autoGrowInput();

  $('refreshTreeBtn').addEventListener('click', async () => {
    if (!session) return;
    const r = await pywebview.api.get_file_tree();
    if (r && r.ok) renderFileTree(r.tree);
  });
  $('uploadFilesBtn').addEventListener('click', uploadFiles);
  $('changeSessionBtn').addEventListener('click', async () => {
    await pywebview.api.end_session();
  });
  $('tabChat').addEventListener('click', () => switchTab('chat'));
  $('tabPlan').addEventListener('click', () => switchTab('plan'));
  $('tabGraph').addEventListener('click', () => switchTab('graph'));
  $('planBadge').addEventListener('click', () => switchTab('plan'));
  $('graphModeToggle').addEventListener('click', toggleGraphMode);
  // Switching the selector forces a reload of that specific graph (bypasses the
  // graphLoaded cache, which only guards the first open of the tab).
  $('graphSelect').addEventListener('change', (e) => loadGraph(e.target.value));
  updateGraphModeButton();
  // Keep the 3D canvas sized to its container (the graph tab is hidden while
  // off-screen, so it renders at zero size until the container gets dimensions).
  if (window.ResizeObserver) {
    new ResizeObserver(() => { if (activeTab === 'graph') resizeGraph3D(); }).observe($('graphContainer'));
  }
  $('viewerClose').addEventListener('click', () => $('fileViewer').classList.add('hidden'));
  $('viewerBack').addEventListener('click', backToArchiveListing);
  $('fileViewer').addEventListener('click', (e) => { if (e.target.id === 'fileViewer') $('fileViewer').classList.add('hidden'); });

  $('exportWorkspaceBtn').addEventListener('click', openExportModal);
  $('exportModalClose').addEventListener('click', closeExportModal);
  $('exportCancelBtn').addEventListener('click', closeExportModal);
  $('exportApproveBtn').addEventListener('click', approveExport);
  $('exportModal').addEventListener('click', (e) => { if (e.target.id === 'exportModal') closeExportModal(); });

  $('llmSettingsBtn').addEventListener('click', openLlmModal);
  $('llmSettingsBtnStart').addEventListener('click', openLlmModal);
  $('llmModalClose').addEventListener('click', closeLlmModal);
  $('llmCancelBtn').addEventListener('click', closeLlmModal);
  $('llmSaveBtn').addEventListener('click', saveLlmConfig);
  $('llmTestBtn').addEventListener('click', testLlmConnection);
  $('llmModal').addEventListener('click', (e) => { if (e.target.id === 'llmModal') closeLlmModal(); });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      $('fileViewer').classList.add('hidden');
      closeExportModal();
      closeLlmModal();
    }
  });
}

window.addEventListener('load', init);
