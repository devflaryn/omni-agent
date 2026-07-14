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
  if (currentGroup) completeGroup(currentGroup); // settle/collapse any lingering group
  currentGroup = null; // a new user turn starts a fresh set of action groups
  const el = document.createElement('div');
  el.className = 'py-1 user-row';
  el.innerHTML = `
    <div class="msg-meta mb-0.5 text-[10px] text-term-muted"><span class="text-term-green">user</span> <span>${nowTime()}</span></div>
    <div class="user-bubble msg-fmt whitespace-pre-wrap text-term-text">${formatInline(content)}</div>`;
  appendRow(el);
}

// ---------- agent activity: explanation messages + action groups ----------
// The model's per-subtask "explanation" is printed as a real, white message,
// then the tool calls it makes are grouped beneath it in a widget whose header
// is a live count summary ("Ran N tools · read N files · changed N files"),
// NOT the latest tool. While the group is active the title shimmers silver and
// the widget is auto-expanded as a short, self-scrolling list (newest call at
// the bottom, always kept in view). Actions NEVER show their raw tool output.
// When the next explanation (a 'thought' event WITH text) arrives, that group
// is "completed": the title plays a one-shot wave then settles solid and the
// widget collapses (still clickable to re-open); a fresh group then opens under
// the new explanation. A tool call with no explanation just extends the current
// group — so a run reads as: explanation, [group], next explanation, [group], …

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

// An explanation arrived (as a 'thought' event). Complete the current action
// group — its silver title settles solid and it collapses — then print the
// explanation as a real white message and leave currentGroup null so the NEXT
// tool call opens a fresh group folded beneath this explanation. Events with no
// text fall through, so their action just extends the current group.
function finishThinking(ev) {
  if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
  const text = (ev.text || '').trim();
  if (!text) return;
  if (currentGroup) completeGroup(currentGroup);
  currentGroup = null;
  const el = document.createElement('div');
  el.className = 'py-1';
  // No label/meta — the explanation reads as a plain assistant line so the whole
  // run flows like one continuous chat, with the action group folded beneath it.
  el.innerHTML =
    `<div class="msg-fmt whitespace-pre-wrap text-term-text leading-6">${formatInline(text)}</div>`;
  appendRow(el);
  scrollDown();
}

// Which tools count as "reading a file" vs "changing a file" for the group's
// summary title ("Ran N tools · read N files · changed N files"). Files are
// deduped by path, so touching the same file twice still counts once.
const READ_FILE_TOOLS = new Set([
  'read_file_chunk', 'read_binary_range', 'tail_file', 'grep_file', 'read_archive_member',
]);
const CHANGE_FILE_TOOLS = new Set([
  'write_file', 'replace_in_file', 'delete_path', 'move_file', 'duplicate_file',
  'patch_smali_method', 'insert_smali_code', 'assemble_dex',
  'patch_binary_string', 'binary_patch', 'nop_function', 'patch_function_return',
  'patch_at_offset_with_bytes', 'patch_bytes_at_offset',
  'replace_file_in_apk', 'recompile_apk', 'sign_apk',
  'assemble_and_patch', 'compile_c_and_patch',
]);

// The workspace path a tool operates on, used to dedupe file counts. Mirrors the
// arg keys the backend tools actually use (filepath / file_path / so_path / …).
function toolPathKey(args) {
  if (!args || typeof args !== 'object') return null;
  return args.filepath || args.file_path || args.path || args.so_path || args.smali_file
    || args.dex_path || args.apk_filename || args.apk_path || args.output_apk
    || args.destination || args.source || args.output || args.out_path || args.target || null;
}

// The count summary shown as the group's title. Pluralized, tools first.
function groupTitleText(g) {
  const plur = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const parts = [`Ran ${plur(g.n, 'tool')}`];
  if (g.readFiles.size) parts.push(`read ${plur(g.readFiles.size, 'file')}`);
  if (g.changedFiles.size) parts.push(`changed ${plur(g.changedFiles.size, 'file')}`);
  return parts.join(' · ');
}
function updateGroupTitle(g) { g.titleEl.textContent = groupTitleText(g); }

// Keep the newest tool calls visible: pin the group's scroll region to the
// bottom (rows are appended there). rAF-batched so a burst of calls costs one
// layout; during replay it's set synchronously since there's no live paint.
function scrollGroupToBottom(g) {
  if (replaying) { g.scrollEl.scrollTop = g.scrollEl.scrollHeight; return; }
  requestAnimationFrame(() => { g.scrollEl.scrollTop = g.scrollEl.scrollHeight; });
}

function setGroupOpen(g, open) {
  g.open = open;
  g.bodyEl.classList.toggle('open', open);
  g.caret.classList.toggle('open', open);
  if (open) scrollGroupToBottom(g);
}

// A group is "done" when the next explanation (or the final answer / run end)
// arrives: freeze any live row, settle the silver title into a solid color via
// a one-shot wave, and collapse the widget. It stays clickable to re-expand.
function completeGroup(g) {
  if (!g || g.completed) return;
  g.completed = true;
  if (g.liveEv && g.liveRow) {
    g.liveRow.innerHTML = actionInner(g.liveEv, 'interrupted');
    g.liveId = null; g.liveEv = null; g.liveRow = null;
  }
  // A group that never ran a tool (an explanation with no actions) leaves nothing
  // worth showing — drop it so no empty "Ran 0 tools" widget lingers.
  if (g.n === 0) { g.el.remove(); if (currentGroup === g) currentGroup = null; return; }
  g.titleEl.classList.remove('shimmer');
  if (!replaying) {
    g.titleEl.classList.add('group-title-wave');
    g.titleEl.addEventListener('animationend',
      () => g.titleEl.classList.remove('group-title-wave'), { once: true });
  }
  g.metaEl.textContent = fmtElapsed(Date.now() - g.startTs);
  setGroupOpen(g, false);
}

function startActionGroup() {
  const el = document.createElement('div');
  el.className = 'action-group ml-2 mb-1.5 border-l-2 border-term-line/60 pl-2';
  // The title carries a live count summary (silver-shimmering while the group is
  // active); the body is a short, self-scrolling container so a long burst of
  // tool calls never fills the whole chat — newest calls sit at the bottom.
  el.innerHTML = `
    <button type="button" class="group-head flex w-full items-center gap-2 rounded-lg px-1.5 py-0.5 text-left font-mono text-[12px] leading-5 hover:bg-term-line/30">
      <span class="group-caret caret shrink-0 select-none text-[9px] leading-none text-term-muted">▶</span>
      <span class="group-title min-w-0 flex-1 truncate text-term-text"></span>
      <span class="group-meta ml-auto shrink-0 text-[10.5px] tabular-nums text-term-muted"></span>
    </button>
    <div class="group-body"><div class="group-body-clip"><div class="group-scroll">
      <div class="group-list space-y-px py-0.5 pl-5 font-mono text-[12px] text-term-muted"></div>
    </div></div></div>`;
  const g = {
    el,
    head: el.querySelector('.group-head'),
    titleEl: el.querySelector('.group-title'),
    metaEl: el.querySelector('.group-meta'),
    bodyEl: el.querySelector('.group-body'),
    scrollEl: el.querySelector('.group-scroll'),
    listEl: el.querySelector('.group-list'),
    caret: el.querySelector('.group-caret'),
    n: 0, readFiles: new Set(), changedFiles: new Set(),
    liveId: null, liveEv: null, liveRow: null,
    startTs: Date.now(), completed: false, open: true,
  };
  g.titleEl.classList.add('shimmer'); // active → silver sweep until completed
  g.head.addEventListener('click', () => setGroupOpen(g, !g.open));
  currentGroup = g;
  updateGroupTitle(g);
  setGroupOpen(g, true); // auto-expanded while the group is the live one
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

// Append one action row to the BOTTOM of the current group's list (newest
// last), bump the running count summary, and keep the scroll pinned to the
// bottom so the most recent calls stay visible.
function pushAction(ev, state) {
  if (!currentGroup) startActionGroup(); // safety: an action before any thought
  const g = currentGroup;
  const row = document.createElement('div');
  row.className = 'group-row truncate';
  row.innerHTML = actionInner(ev, state);
  g.listEl.appendChild(row);
  if (state === 'live') { registerSpinners(row); g.liveId = ev.id; g.liveEv = ev; g.liveRow = row; }
  g.n += 1;
  const key = toolPathKey(ev.args) || `${ev.tool}#${g.n}`;
  if (READ_FILE_TOOLS.has(ev.tool)) g.readFiles.add(key);
  else if (CHANGE_FILE_TOOLS.has(ev.tool)) g.changedFiles.add(key);
  updateGroupTitle(g);
  if (g.open) scrollGroupToBottom(g);
  return row;
}

function startTool(ev) {
  pushAction(ev, 'live');
  scrollDown();
}

function finishTool(ev) {
  const state = ev.is_loop_warning ? 'warn' : 'done';
  const g = currentGroup;
  if (g && g.liveId === ev.id && g.liveRow) {
    // finalize the live row in place (already counted when it started)
    g.liveRow.innerHTML = actionInner(ev, state);
    g.liveId = null; g.liveEv = null; g.liveRow = null;
    if (g.open) scrollGroupToBottom(g);
  } else {
    // replay (no prior tool_running) or id mismatch: add as a finalized action
    pushAction(ev, state);
  }
  scrollDown();
}

// End of a run (done / stop / session change): complete the current group so
// its silver title settles solid and it collapses (freezing any live row).
function finalizeLiveLines() {
  if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
  if (currentGroup) completeGroup(currentGroup);
}

function argSummary(args) {
  if (!args || typeof args !== 'object') return '';
  // APK lifecycle tools each name the APK they operate on with one of these keys
  // (inspect_apk/unzip_apk/decode_apk/jadx_decompile/sign_apk/verify_apk use
  // apk_filename; recompile_apk uses output_apk; get_apk_signature_hash and
  // the emulator/test tools use apk_path). Surface it first so the action line
  // always shows WHICH apk is affected in parentheses.
  const apk = args.apk_filename || args.apk_path || args.output_apk || args.original_apk;
  if (apk) return `(${apk})`;
  // Otherwise fall back to whatever file/dir the tool works on (decompiled_dir
  // covers search_smali/search_java; manifest_path covers extract_manifest_info).
  const p = args.path || args.file_path || args.filepath || args.so_path
    || args.dex_path || args.smali_path || args.manifest_path || args.decompiled_dir
    || args.input_dir || args.output_dir || args.dir_path || args.directory
    || args.target || args.output || args.out_path || args.destination;
  if (p) return `(${p})`;
  if (args.command) { const c = String(args.command); return c.length > 40 ? `(${c.slice(0, 40)}…)` : `(${c})`; }
  if (args.query) return `(${args.query})`;
  if (args.pattern) return `(${args.pattern})`;
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

// System messages surface as auto-dismissing toasts in the bottom-right
// corner instead of cluttering the transcript. Each hides itself after 10s.
function renderSystem(content) {
  const host = document.getElementById('toasts');
  if (!host) return; // fall back to nothing if the container isn't present

  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `
    <span class="toast-label">sys</span>
    <span class="toast-msg">${escapeHtml(content)}</span>
    <button class="toast-close" title="Dismiss" aria-label="Dismiss">×</button>`;

  let removed = false;
  const dismiss = () => {
    if (removed) return;
    removed = true;
    clearTimeout(timer);
    el.classList.add('toast-out');
    el.addEventListener('animationend', () => el.remove(), { once: true });
  };
  el.querySelector('.toast-close').addEventListener('click', dismiss);

  const timer = setTimeout(dismiss, 10000);
  host.appendChild(el);
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
  // Prefer the cumulative tools-used count (persisted across reopen); fall back to
  // the per-leg consecutive count for any older event that lacks it.
  const tools = (ev.tools_used !== undefined && ev.tools_used !== null) ? ev.tools_used : ev.consecutive_tools;
  setStatus('statTools', tools);
  const ctx = (ev.ctx_chars !== undefined && ev.ctx_chars !== null) ? ev.ctx_chars : 0;
  setStatus('statCtx', Number(ctx).toLocaleString());
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
  const hasItems = plan && plan.items && plan.items.length;
  const hasPhases = plan && plan.phases && plan.phases.length;
  if (!hasItems && !hasPhases) {
    badge.textContent = 'plan —';
    return;
  }
  if (hasItems) {
    const { done, total } = plan.progress;
    badge.textContent = `plan ${done}/${total}`;
  } else {
    // Mission laid out (phases) but no steps added yet — show phase progress.
    const done = plan.phases.filter(p => p.status === 'completed' || p.status === 'skipped').length;
    badge.textContent = `plan ${done}/${plan.phases.length}φ`;
  }
}

// The terminal outcome pill (active plans show nothing here).
function planOutcomeChip(outcome) {
  if (!outcome || outcome === 'active') return '';
  const color = {
    completed: 'text-term-green border-term-green/40',
    partial: 'text-term-cyan border-term-cyan/40',
    blocked: 'text-term-red border-term-red/40',
    needs_different_approach: 'text-term-red border-term-red/40',
  }[outcome] || 'text-term-muted border-term-line';
  return `<span class="ml-2 rounded-full border px-2 py-0.5 text-[10px] ${color}">${escapeHtml(outcome.replace(/_/g, ' '))}</span>`;
}

// The persistent "which LLM is active right now" badge in the header. Updated
// live by 'active_llm' events (the provider serving requests can change when the
// fallback chain moves after an error) and populated on load via get_active_llm.
function setActiveLlm(info) {
  const label = $('activeLlmLabel');
  const badge = $('activeLlmBadge');
  if (!label || !badge) return;
  if (!info || (!info.name && !info.label && !info.model)) {
    label.textContent = 'LLM —';
    badge.title = 'No LLM configured — click to add one';
    return;
  }
  const name = info.name || info.label || 'LLM';
  label.textContent = name + (info.model ? ` · ${info.model}` : '');
  const provider = (info.label && info.label !== name) ? ` (${info.label})` : '';
  badge.title = `Active LLM: ${name}${provider}${info.model ? ' · ' + info.model : ''}`
    + ' — click to open provider settings';
}

async function refreshActiveLlm() {
  try {
    const res = await pywebview.api.get_active_llm();
    if (res && res.ok) setActiveLlm(res.active);
  } catch (e) { /* non-fatal: the badge just keeps its current text */ }
}

// One step row, with its evidence fields folded in when present.
function _planStepRow(it, plan) {
  const active = it.id === plan.active_item_id;
  const contentClass = it.status === 'completed' ? 'line-through text-term-muted' :
    it.status === 'skipped' ? 'line-through text-term-muted/70' : 'text-term-text';
  const detail = [
    it.purpose ? ['purpose', it.purpose] : null,
    it.expected ? ['expect', it.expected] : null,
    it.verification ? ['verify', it.verification] : null,
    it.fallback ? ['fallback', it.fallback] : null,
  ].filter(Boolean);
  const detailHtml = detail.length ? `
    <div class="text-[11px] text-term-muted mt-1 space-y-0.5">
      ${detail.map(([k, v]) => `<div><span class="text-term-muted/70">${k}:</span> ${escapeHtml(v)}</div>`).join('')}
    </div>` : '';
  return `
    <div class="flex items-start gap-2 rounded-lg px-2 py-1.5 ${active ? 'bg-term-cyan/10 border border-term-cyan/30' : 'border border-transparent'}">
      <span class="${planStatusColor(it.status)} shrink-0 mt-0.5 text-[13px]">${planStatusIcon(it.status)}</span>
      <div class="min-w-0 flex-1">
        <div class="${contentClass} text-[13px] leading-5">${escapeHtml(it.content)}</div>
        ${it.notes ? `<div class="text-[11px] text-term-muted mt-0.5">${escapeHtml(it.notes)}</div>` : ''}
        ${detailHtml}
      </div>
      <span class="text-[10px] text-term-muted shrink-0 mt-0.5">${escapeHtml(it.status.replace('_', ' '))}</span>
    </div>`;
}

function _planBullets(label, values) {
  if (!values || !values.length) return '';
  return `
    <div class="mt-2">
      <div class="text-[10px] uppercase tracking-wider text-term-muted mb-0.5">${label}</div>
      <ul class="text-[12px] text-term-text/90 space-y-0.5">
        ${values.map(v => `<li class="flex gap-1.5"><span class="text-term-muted">•</span><span>${escapeHtml(v)}</span></li>`).join('')}
      </ul>
    </div>`;
}

function renderPlanTab(plan) {
  const root = $('planTab');
  if (!root) return;
  const hasItems = plan && plan.items && plan.items.length;
  const hasPhases = plan && plan.phases && plan.phases.length;
  if (!plan || (!hasItems && !hasPhases)) {
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

  const phasesHtml = hasPhases ? `
    <div class="mt-2">
      <div class="text-[10px] uppercase tracking-wider text-term-muted mb-0.5">phases</div>
      <div class="space-y-0.5">
        ${plan.phases.map(p => {
          const cur = p.id === plan.current_phase_id;
          return `<div class="flex items-start gap-2 text-[12px] ${cur ? 'text-term-cyan' : ''}">
            <span class="${planStatusColor(p.status)} shrink-0 text-[12px]">${planStatusIcon(p.status)}</span>
            <span class="min-w-0 flex-1 ${p.status === 'completed' ? 'text-term-muted' : ''}">${escapeHtml(p.title)}${p.note ? ` <span class="text-term-muted">— ${escapeHtml(p.note)}</span>` : ''}</span>
            ${cur ? '<span class="text-[9px] uppercase tracking-wider text-term-cyan shrink-0">current</span>' : ''}
          </div>`;
        }).join('')}
      </div>
    </div>` : '';

  const rows = hasItems ? plan.items.map(it => _planStepRow(it, plan)).join('') :
    `<div class="text-[12px] text-term-muted italic px-2 py-3">No steps in the current phase yet.</div>`;

  const nextHtml = plan.next_action ? `
    <div class="px-4 py-2.5 border-t border-term-line shrink-0 bg-term-cyan/5">
      <div class="text-[10px] uppercase tracking-wider text-term-muted mb-0.5">next action</div>
      <div class="text-[13px] text-term-text">${escapeHtml(plan.next_action)}</div>
    </div>` : '';

  // Header + steps share one scroll region: with long criteria/phases the
  // header alone can exceed the viewport, so it can't be a fixed shrink-0 bar.
  root.innerHTML = `
    <div class="flex-1 min-h-0 overflow-y-auto">
      <div class="px-4 py-3 border-b border-term-line">
        <div class="text-[10px] uppercase tracking-wider text-term-muted mb-1">current task ${planOutcomeChip(plan.outcome)}</div>
        <div class="text-term-text text-[13px] mb-2">${escapeHtml(plan.task)}${plan.outcome_note ? ` <span class="text-term-muted">— ${escapeHtml(plan.outcome_note)}</span>` : ''}</div>
        <div class="h-1.5 rounded-full bg-term-line overflow-hidden">
          <div class="h-full bg-term-cyan transition-all" style="width:${pct}%"></div>
        </div>
        <div class="text-[10px] text-term-muted mt-1">${done}/${total} steps complete (${pct}%)${plan.replans && plan.replans.length ? ` · replanned ${plan.replans.length}×` : ''}</div>
        ${_planBullets('success criteria', plan.success_criteria)}
        ${_planBullets('constraints', plan.constraints)}
        ${_planBullets('unknowns', plan.unknowns)}
        ${_planBullets('assumptions', plan.assumptions)}
        ${phasesHtml}
      </div>
      <div class="px-2 py-2 space-y-0.5">${rows}</div>
    </div>
    ${nextHtml}`;
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
      case 'active_llm': setActiveLlm(ev); break;
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
  if (activeTab === 'graph') { if (compareMode) renderCompare(comparePanes[0] && comparePanes[0].sel.value, comparePanes[1] && comparePanes[1].sel.value); else loadGraph(); }
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
  // Zero the header stats up front; a 'status' event fired right after this (when
  // the project has saved history) restores the real steps / tools / ctx / resets.
  setStatus('statSteps', 0); setStatus('statTools', 0); setStatus('statCtx', 0); setStatus('statResets', 0);
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
    // A "project" is now a host folder you picked. get_projects returns the
    // recently-used folders {label, path} + the last-used default.
    const res = await pywebview.api.get_projects();
    const recent = (res && res.recent) || [];
    const projSel = $('projectSelect');
    projSel.innerHTML = '';
    recent.forEach(r => {
      const o = document.createElement('option');
      o.value = r.path; o.textContent = r.label + '  —  ' + r.path; o.title = r.path;
      projSel.appendChild(o);
    });
    if (!recent.length) {
      const o = document.createElement('option'); o.value = '';
      o.textContent = '(no folders yet — click “Select folder”)'; projSel.appendChild(o);
    } else if (res.last) {
      projSel.value = res.last;
    }
  } catch (e) {
    $('startError').textContent = 'Failed to load: ' + e;
  }
}

async function startSession() {
  $('startError').textContent = '';
  const path = $('projectSelect').value;   // value is now an absolute folder path
  if (!path || path.startsWith('(')) {
    $('startError').textContent = 'Select a workspace folder first.'; return;
  }
  const btn = $('startSessionBtn'); btn.disabled = true; btn.textContent = 'Starting sandbox…';
  try {
    const res = await pywebview.api.start_session(path);
    if (!res.ok) $('startError').textContent = res.error || 'Failed to start session.';
  } catch (e) {
    $('startError').textContent = '' + e;
  } finally {
    btn.disabled = false; btn.textContent = 'Start session';
  }
}

// Pick a NEW workspace folder from the device (native dialog), mount it into the
// container, then start the session on it. The picked folder is the project root.
async function pickWorkspaceAndStart() {
  $('startError').textContent = '';
  const btn = $('newProjectBtn');
  const prev = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Selecting + mounting…'; }
  try {
    const res = await pywebview.api.select_workspace();   // native picker + bind-mount
    if (res && res.cancelled) return;
    if (!res || !res.ok) { $('startError').textContent = (res && res.error) || 'Could not select folder.'; return; }
    await loadStartScreen();
    $('projectSelect').value = res.path;
    await startSession();
  } catch (e) {
    $('startError').textContent = '' + e;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = prev; }
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

// ---------- LLM provider settings (multiple providers + fallback order) ----------
let _llmProviders = [];        // preset metadata from the backend
let _llmConfigs = [];          // ordered list of saved providers (order = fallback priority)
let _llmActiveProvider = null; // provider selected in the edit form
let _llmEditingId = null;      // id being edited in the form, or null when adding
let _llmDragId = null;         // id of the row currently being dragged

function _llmProvider(id) { return _llmProviders.find(p => p.id === id) || null; }

async function openLlmModal() {
  $('llmError').textContent = '';
  $('llmTestResult').textContent = '';
  $('llmListStatus').textContent = '';
  $('llmModal').classList.remove('hidden');
  llmShowList();
  try {
    const res = await pywebview.api.get_llm_configs();
    if (!res || !res.ok) {
      $('llmListStatus').className = 'text-[11px] text-term-red';
      $('llmListStatus').textContent = (res && res.error) || 'Failed to load LLM configs.';
      return;
    }
    _llmProviders = res.providers || [];
    _llmConfigs = (res.configs || []).map(c => ({ ...c }));
    renderLlmList();
  } catch (e) {
    $('llmListStatus').className = 'text-[11px] text-term-red';
    $('llmListStatus').textContent = '' + e;
  }
}

function closeLlmModal() { $('llmModal').classList.add('hidden'); }

// ----- switch between the list view and the add/edit form -----
function llmShowList() {
  $('llmModalTitle').textContent = 'LLM Providers';
  $('llmListView').style.display = 'flex';
  $('llmEditView').style.display = 'none';
}
function llmShowEdit() {
  $('llmModalTitle').textContent = _llmEditingId ? 'Edit provider' : 'Add provider';
  $('llmListView').style.display = 'none';
  $('llmEditView').style.display = 'flex';
}

// ----- list of saved providers (drag to reorder = change fallback priority) -----
function renderLlmList() {
  const wrap = $('llmList');
  wrap.innerHTML = '';
  $('llmListEmpty').classList.toggle('hidden', _llmConfigs.length > 0);
  _llmConfigs.forEach((c, idx) => wrap.appendChild(_llmRow(c, idx)));
}

function _llmRow(c, idx) {
  const prov = _llmProvider(c.provider);
  const label = (prov && prov.label) || c.label || c.provider;
  const row = document.createElement('div');
  row.className = 'flex items-center gap-2 rounded-xl border border-term-line bg-term-bg px-3 py-2';
  row.dataset.id = c.id;
  row.draggable = true;

  const handle = document.createElement('span');
  handle.textContent = '⠿';
  handle.title = 'drag to reorder';
  handle.className = 'text-term-muted';
  handle.style.cursor = 'grab';
  row.appendChild(handle);

  const mid = document.createElement('div');
  mid.className = 'min-w-0';
  mid.style.flex = '1 1 auto';
  const title = document.createElement('div');
  title.className = 'text-term-text';
  title.textContent = c.name || label;
  if (idx === 0) {
    const badge = document.createElement('span');
    badge.textContent = 'primary';
    badge.className = 'ml-2 rounded-full border border-term-line text-[10px] text-term-muted';
    badge.style.padding = '1px 6px';
    title.appendChild(badge);
  }
  const sub = document.createElement('div');
  sub.className = 'text-[11px] text-term-muted';
  sub.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
  // Decoupled view: a shared key POOL + a separate model LADDER.
  const keys = Array.isArray(c.api_keys) && c.api_keys.length ? c.api_keys : (c.api_key ? [c.api_key] : []);
  const models = Array.isArray(c.models) && c.models.length ? c.models : (c.model ? [c.model] : []);
  const nKeys = keys.length;
  const keyPart = (prov && prov.requires_key)
    ? (nKeys ? ` · ${nKeys} key${nKeys === 1 ? '' : 's'}` : ' · ⚠ no key')
    : '';
  const modelPart = models.length
    ? (models.length === 1 ? ` · ${models[0]}` : ` · ${models.length} models: ${models.join(', ')}`)
    : ' · default model';
  const vision = Array.isArray(c.vision_models) ? c.vision_models : (c.vision_model ? [c.vision_model] : []);
  const visionPart = vision.length ? ` · ${vision.length} vision` : '';
  sub.textContent = `${label}${modelPart}${visionPart}${keyPart}`;
  mid.appendChild(title); mid.appendChild(sub);
  row.appendChild(mid);

  const editBtn = document.createElement('button');
  editBtn.textContent = 'edit';
  editBtn.className = 'rounded-full border border-term-line px-3 py-1 text-[11px] text-term-muted hover:bg-term-line/60 hover:text-term-text';
  editBtn.addEventListener('click', () => llmEditEntry(c.id));
  row.appendChild(editBtn);

  const delBtn = document.createElement('button');
  delBtn.textContent = '✕';
  delBtn.title = 'remove';
  delBtn.className = 'rounded-full border border-term-line px-2 py-1 text-[11px] text-term-muted hover:bg-term-line/60 hover:text-term-text';
  delBtn.addEventListener('click', () => llmDeleteEntry(c.id));
  row.appendChild(delBtn);

  // HTML5 drag-and-drop reorder. Order in _llmConfigs IS the fallback priority.
  row.addEventListener('dragstart', () => { _llmDragId = c.id; row.style.opacity = '0.4'; });
  row.addEventListener('dragend', () => { _llmDragId = null; row.style.opacity = ''; });
  row.addEventListener('dragover', (e) => { e.preventDefault(); });
  row.addEventListener('drop', (e) => { e.preventDefault(); llmReorder(_llmDragId, c.id); });
  return row;
}

function llmReorder(srcId, dstId) {
  if (!srcId || srcId === dstId) return;
  const from = _llmConfigs.findIndex(c => c.id === srcId);
  const to = _llmConfigs.findIndex(c => c.id === dstId);
  if (from < 0 || to < 0) return;
  const [moved] = _llmConfigs.splice(from, 1);
  _llmConfigs.splice(to, 0, moved);
  renderLlmList();
  persistLlmConfigs('order updated');
}

function llmDeleteEntry(id) {
  _llmConfigs = _llmConfigs.filter(c => c.id !== id);
  renderLlmList();
  persistLlmConfigs('provider removed');
}

// ----- add / edit form -----
function renderLlmTabs() {
  const wrap = $('llmProviderTabs');
  wrap.innerHTML = '';
  _llmProviders.forEach(p => {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.pid = p.id;
    b.textContent = p.label;
    b.className = 'rounded-full border px-3 py-1 text-[12px] border-term-line text-term-muted hover:bg-term-line/60 hover:text-term-text';
    b.addEventListener('click', () => selectLlmProvider(p.id, null));
    wrap.appendChild(b);
  });
}

// ---- list editors for the decoupled key pool + model / vision ladders ----
// Each is a small add/remove/(reorder) list of one-line inputs. The array is the
// initial render source; live edits stay in the DOM inputs and are read back at
// save/add/move time (so a half-typed row isn't lost on re-render).
const _LLM_KEY_OPTS = { placeholder: 'nvapi-… / sk-…', emptyText: '(no keys yet — click “add key”)' };
const _LLM_MODEL_OPTS = { ordered: true, placeholder: 'e.g. deepseek-ai/deepseek-v4-pro', emptyText: '(no models yet — click “add model”)' };
const _LLM_VISION_OPTS = { ordered: true, placeholder: 'e.g. meta/llama-3.2-90b-vision-instruct', emptyText: '(none — optional; add if you need image reasoning)' };

function _readListEditor(containerId) {
  return Array.from(document.querySelectorAll('#' + containerId + ' input.llm-list-input'))
    .map(inp => inp.value.trim()).filter(Boolean);
}

function _miniBtn(label, title, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.title = title || '';
  b.className = 'shrink-0 rounded-lg border border-term-line px-2 py-1 text-[11px] leading-none text-term-muted hover:bg-term-line/60 hover:text-term-text';
  b.addEventListener('click', onClick);
  return b;
}

function _renderListEditor(containerId, values, opts) {
  opts = opts || {};
  const host = $(containerId);
  if (!host) return;
  host.innerHTML = '';
  (values || []).forEach((val, i) => {
    const row = document.createElement('div');
    row.className = 'flex items-center gap-1.5';
    const inp = document.createElement('input');
    inp.type = 'text'; inp.value = val; inp.autocomplete = 'off'; inp.spellcheck = false;
    inp.placeholder = opts.placeholder || '';
    inp.className = 'llm-list-input flex-1 min-w-0 rounded-lg border border-term-line bg-term-bg px-2.5 py-1.5 font-mono text-[11px] outline-none focus:border-term-cyan';
    row.appendChild(inp);
    if (opts.ordered) {
      const up = _miniBtn('↑', 'move up (higher priority)', () => _moveListItem(containerId, i, -1, opts));
      const down = _miniBtn('↓', 'move down', () => _moveListItem(containerId, i, +1, opts));
      if (i === 0) { up.disabled = true; up.classList.add('opacity-30'); }
      if (i === (values.length - 1)) { down.disabled = true; down.classList.add('opacity-30'); }
      row.appendChild(up); row.appendChild(down);
    }
    row.appendChild(_miniBtn('✕', 'remove', () => {
      const cur = _readListEditor(containerId); cur.splice(i, 1); _renderListEditor(containerId, cur, opts);
    }));
    host.appendChild(row);
  });
  if (!values || !values.length) {
    const empty = document.createElement('div');
    empty.className = 'text-[11px] italic text-term-muted';
    empty.textContent = opts.emptyText || '(none)';
    host.appendChild(empty);
  }
}

function _moveListItem(containerId, i, dir, opts) {
  const cur = _readListEditor(containerId);
  const j = i + dir;
  if (j < 0 || j >= cur.length) return;
  const tmp = cur[i]; cur[i] = cur[j]; cur[j] = tmp;
  _renderListEditor(containerId, cur, opts);
}

function _addListItem(containerId, opts) {
  const cur = _readListEditor(containerId);
  cur.push('');
  _renderListEditor(containerId, cur, opts);
  const inputs = document.querySelectorAll('#' + containerId + ' input.llm-list-input');
  if (inputs.length) inputs[inputs.length - 1].focus();
}

// ---- text-model ladder editor (per-model reasoning) ----------------------
// The text-model ladder is richer than the generic list editor: besides ordering,
// each model carries its OWN reasoning override so a mixed ladder (GLM + DeepSeek V4
// + …) can reason correctly per family. Each model is a small card — the id input
// (+ reorder/remove) on top, then two compact selects (effort + style) that default
// to "inherit"/"auto" (unset -> the provider's Advanced defaults apply). We read the
// models AND their overrides back together at save time.
const _LLM_EFFORT_OPTS = [
  ['', 'reasoning: inherit'],
  ['off', 'reasoning: off'],
  ['minimal', 'reasoning: minimal'],
  ['low', 'reasoning: low'],
  ['medium', 'reasoning: medium'],
  ['high', 'reasoning: high'],
  ['max', 'reasoning: max'],
];
const _LLM_STYLE_OPTS = [
  ['', 'style: auto'],
  ['openai', 'style: OpenAI effort'],
  ['thinking', 'style: GLM thinking'],
  ['chat_template', 'style: chat-template'],
  ['deepseek_v4', 'style: DeepSeek V4'],
  ['system', 'style: Nemotron'],
  ['none', 'style: none'],
];

function _miniSelect(extraCls, options, value) {
  const sel = document.createElement('select');
  sel.className = extraCls + ' flex-1 min-w-0 rounded-lg border border-term-line bg-term-bg px-2 py-1 text-[10px] text-term-muted outline-none focus:border-term-cyan';
  options.forEach(([v, label]) => {
    const o = document.createElement('option');
    o.value = v; o.textContent = label;
    if (v === (value || '')) o.selected = true;
    sel.appendChild(o);
  });
  return sel;
}

// Read the model ladder back as {models:[id...], settings:{id:{reasoning_effort,
// reasoning_style}}}. Blank rows are dropped; only non-default overrides are kept.
function _readModelLadder(containerId) {
  const models = [];
  const settings = {};
  document.querySelectorAll('#' + containerId + ' .llm-model-row').forEach(row => {
    const id = row.querySelector('input.llm-list-input').value.trim();
    if (!id) return;
    models.push(id);
    const eff = row.querySelector('select.llm-model-effort').value;
    const sty = row.querySelector('select.llm-model-style').value;
    const s = {};
    if (eff) s.reasoning_effort = eff;
    if (sty) s.reasoning_style = sty;
    if (Object.keys(s).length) settings[id] = s;
  });
  return { models, settings };
}

function _renderModelLadder(containerId, models, modelSettings) {
  const host = $(containerId);
  if (!host) return;
  modelSettings = modelSettings || {};
  host.innerHTML = '';
  const list = models || [];
  list.forEach((val, i) => {
    const s = modelSettings[val] || {};
    const card = document.createElement('div');
    card.className = 'llm-model-row flex flex-col gap-1.5 rounded-lg border border-term-line/70 p-1.5';
    const top = document.createElement('div');
    top.className = 'flex items-center gap-1.5';
    const inp = document.createElement('input');
    inp.type = 'text'; inp.value = val; inp.autocomplete = 'off'; inp.spellcheck = false;
    inp.placeholder = _LLM_MODEL_OPTS.placeholder;
    inp.className = 'llm-list-input flex-1 min-w-0 rounded-lg border border-term-line bg-term-bg px-2.5 py-1.5 font-mono text-[11px] outline-none focus:border-term-cyan';
    top.appendChild(inp);
    const up = _miniBtn('↑', 'move up (higher priority)', () => _moveModelLadder(containerId, i, -1));
    const down = _miniBtn('↓', 'move down', () => _moveModelLadder(containerId, i, +1));
    if (i === 0) { up.disabled = true; up.classList.add('opacity-30'); }
    if (i === list.length - 1) { down.disabled = true; down.classList.add('opacity-30'); }
    top.appendChild(up); top.appendChild(down);
    top.appendChild(_miniBtn('✕', 'remove', () => {
      const cur = _readModelLadder(containerId);
      cur.models.splice(i, 1);
      delete cur.settings[val];
      _renderModelLadder(containerId, cur.models, cur.settings);
    }));
    card.appendChild(top);
    const bottom = document.createElement('div');
    bottom.className = 'flex items-center gap-1.5';
    bottom.appendChild(_miniSelect('llm-model-effort', _LLM_EFFORT_OPTS, s.reasoning_effort));
    bottom.appendChild(_miniSelect('llm-model-style', _LLM_STYLE_OPTS, s.reasoning_style));
    card.appendChild(bottom);
    host.appendChild(card);
  });
  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'text-[11px] italic text-term-muted';
    empty.textContent = _LLM_MODEL_OPTS.emptyText;
    host.appendChild(empty);
  }
}

function _moveModelLadder(containerId, i, dir) {
  const cur = _readModelLadder(containerId);
  const j = i + dir;
  if (j < 0 || j >= cur.models.length) return;
  const t = cur.models[i]; cur.models[i] = cur.models[j]; cur.models[j] = t;
  _renderModelLadder(containerId, cur.models, cur.settings);
}

function _addModelLadder(containerId) {
  const cur = _readModelLadder(containerId);
  cur.models.push('');
  _renderModelLadder(containerId, cur.models, cur.settings);
  const inputs = document.querySelectorAll('#' + containerId + ' input.llm-list-input');
  if (inputs.length) inputs[inputs.length - 1].focus();
}

// Fill the form for a provider. `existing` is the saved entry being edited (its
// key/model/base URL are kept only when it matches the selected provider);
// switching provider tabs otherwise shows that provider's fresh defaults.
function selectLlmProvider(id, existing) {
  const p = _llmProvider(id) || _llmProviders[0];
  if (!p) return;
  _llmActiveProvider = p.id;

  for (const b of $('llmProviderTabs').children) {
    const active = b.dataset.pid === p.id;
    b.className = 'rounded-full border px-3 py-1 text-[12px] ' + (active
      ? 'bg-term-cyan text-white border-term-cyan'
      : 'border-term-line text-term-muted hover:bg-term-line/60 hover:text-term-text');
  }

  const use = (existing && existing.provider === p.id) ? existing : null;
  // Decoupled: a key POOL + a text-model LADDER + a vision-model LADDER, each an
  // add/remove(/reorder) list editor.
  const keyPool = use ? (Array.isArray(use.api_keys) && use.api_keys.length ? use.api_keys : (use.api_key ? [use.api_key] : [])) : [];
  const modelLadder = use
    ? (Array.isArray(use.models) && use.models.length ? use.models : (use.model ? [use.model] : []))
    : (p.default_model ? [p.default_model] : []);
  const visionLadder = use ? (Array.isArray(use.vision_models) ? use.vision_models : (use.vision_model ? [use.vision_model] : [])) : [];
  _renderListEditor('llmKeysList', keyPool, _LLM_KEY_OPTS);
  _renderModelLadder('llmModelsList', modelLadder, use ? (use.model_settings || {}) : {});
  _renderListEditor('llmVisionList', visionLadder, _LLM_VISION_OPTS);
  $('llmBaseUrl').value = use ? (use.base_url || p.base_url || '') : (p.base_url || '');
  $('llmProviderNotes').textContent = p.notes || '';

  $('llmMaxTokens').value = (use && use.max_tokens) ? use.max_tokens : '';

  // Advanced options
  $('llmReasoning').value = use ? (use.reasoning_effort || '') : '';
  $('llmReasoningStyle').value = use ? (use.reasoning_style || '') : '';
  $('llmTemperature').value = (use && use.temperature !== null && use.temperature !== undefined) ? use.temperature : '';
  $('llmContextWindow').value = (use && use.context_window) ? use.context_window : '';

  $('llmTestResult').textContent = '';
  $('llmError').textContent = '';
}

// Switch the edit form between the Basic and Advanced panes.
function llmSubtab(pane) {
  const advanced = pane === 'advanced';
  $('llmPaneBasic').classList.toggle('hidden', advanced);
  $('llmPaneAdvanced').classList.toggle('hidden', !advanced);
  const on = 'rounded-full border px-3 py-1 text-[12px] bg-term-cyan text-white border-term-cyan';
  const off = 'rounded-full border px-3 py-1 text-[12px] border-term-line text-term-muted hover:bg-term-line/60 hover:text-term-text';
  $('llmSubtabBasic').className = advanced ? off : on;
  $('llmSubtabAdvanced').className = advanced ? on : off;
}

function llmAddEntry() {
  _llmEditingId = null;
  renderLlmTabs();
  llmSubtab('basic');
  $('llmName').value = '';
  const first = _llmProviders[0];
  selectLlmProvider(first ? first.id : null, null);
  llmShowEdit();
  $('llmName').focus();
}

function llmEditEntry(id) {
  const c = _llmConfigs.find(x => x.id === id);
  if (!c) return;
  _llmEditingId = id;
  renderLlmTabs();
  llmSubtab('basic');
  $('llmName').value = c.name || '';
  selectLlmProvider(c.provider, c);
  llmShowEdit();
}

function _llmFormValues() {
  const p = _llmProvider(_llmActiveProvider);
  // Read the decoupled pool/ladders from the list editors. Keep the singular
  // api_key/model as the FIRST of each for older code paths / tests.
  const apiKeys = _readListEditor('llmKeysList');
  const ladder = _readModelLadder('llmModelsList');
  const models = ladder.models;
  const visionModels = _readListEditor('llmVisionList');
  const v = {
    id: _llmEditingId || undefined,
    name: $('llmName').value.trim(),
    provider: _llmActiveProvider,
    api_keys: apiKeys,
    models: models,
    model_settings: ladder.settings,
    vision_models: visionModels,
    api_key: apiKeys[0] || '',
    model: models[0] || '',
    base_url: $('llmBaseUrl').value.trim(),
  };
  const mt = $('llmMaxTokens').value.trim();
  if (mt) v.max_tokens = parseInt(mt, 10);
  // Advanced options
  const reasoning = $('llmReasoning').value;
  v.reasoning_effort = reasoning || '';
  v.reasoning_style = $('llmReasoningStyle').value || '';
  const temp = $('llmTemperature').value.trim();
  v.temperature = temp === '' ? null : parseFloat(temp);
  const ctx = $('llmContextWindow').value.trim();
  if (ctx) v.context_window = parseInt(ctx, 10);
  if (!v.name) v.name = (p && p.label) || v.provider;
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

// Save the form into the in-memory list (add new or update existing), persist,
// then return to the list.
async function saveLlmEntry() {
  $('llmError').textContent = '';
  const v = _llmFormValues();
  if (!v.provider) { $('llmError').textContent = 'Pick a provider first.'; return; }
  const btn = $('llmSaveBtn');
  btn.disabled = true; btn.textContent = 'saving…';
  try {
    if (_llmEditingId) {
      const i = _llmConfigs.findIndex(c => c.id === _llmEditingId);
      if (i >= 0) _llmConfigs[i] = { ...(_llmConfigs[i]), ...v };
      else _llmConfigs.push(v);
    } else {
      v.id = 'new-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      _llmConfigs.push(v);
    }
    const ok = await persistLlmConfigs(_llmEditingId ? 'provider updated' : 'provider added');
    if (ok) llmShowList();
    else $('llmError').textContent = $('llmListStatus').textContent || 'Save failed.';
  } finally {
    btn.disabled = false; btn.textContent = 'save to list';
  }
}

// Persist the whole ordered list to the backend, then re-sync from what was
// actually stored (so generated ids / minimized fields become authoritative).
// Returns true on success.
async function persistLlmConfigs(statusMsg) {
  try {
    const payload = _llmConfigs.map(c => ({
      id: (c.id && !String(c.id).startsWith('new-')) ? c.id : undefined,
      name: c.name,
      provider: c.provider,
      // Decoupled key pool + text/vision model ladders (with singular fallbacks).
      api_keys: Array.isArray(c.api_keys) ? c.api_keys : (c.api_key ? [c.api_key] : []),
      models: Array.isArray(c.models) ? c.models : (c.model ? [c.model] : []),
      vision_models: Array.isArray(c.vision_models) ? c.vision_models : (c.vision_model ? [c.vision_model] : []),
      // Per-model reasoning overrides {model_id: {reasoning_effort, reasoning_style}}.
      model_settings: (c.model_settings && typeof c.model_settings === 'object') ? c.model_settings : {},
      api_key: c.api_key,
      model: c.model,
      base_url: c.base_url,
      max_tokens: c.max_tokens,
      reasoning_effort: c.reasoning_effort,
      reasoning_style: c.reasoning_style,
      temperature: c.temperature,
      context_window: c.context_window,
    }));
    const res = await pywebview.api.save_llm_configs(payload);
    if (!res || !res.ok) {
      $('llmListStatus').className = 'text-[11px] text-term-red';
      $('llmListStatus').textContent = (res && res.error) || 'Save failed.';
      return false;
    }
    const fresh = await pywebview.api.get_llm_configs();
    if (fresh && fresh.ok) {
      _llmConfigs = (fresh.configs || []).map(c => ({ ...c }));
      _llmProviders = fresh.providers || _llmProviders;
      renderLlmList();
    }
    $('llmListStatus').className = 'text-[11px] text-term-green';
    $('llmListStatus').textContent = '✓ ' + (statusMsg || 'saved') + (res.primary
      ? ` — primary: ${res.primary.name} (${res.primary.label} · ${res.primary.model})`
      : ' — no providers left');
    refreshActiveLlm();  // the primary/active provider may have changed
    if (session && res.primary) {
      renderSystem(`LLM providers saved. Primary: ${res.primary.name} · ${res.primary.model}. Fallbacks are used automatically if it errors.`);
    }
    return true;
  } catch (e) {
    $('llmListStatus').className = 'text-[11px] text-term-red';
    $('llmListStatus').textContent = '' + e;
    return false;
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
  // Also drop any side-by-side compare panes and reset that mode/toggle, so a
  // new session never inherits the previous one's compare view.
  teardownCompare();
  if (compareMode) { compareMode = false; setCompareButton(false); }
  if (buildFormOpen) setBuildFormOpen(false);
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
  planTab.classList.remove('flex');
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
    if (compareMode) {
      comparePanes.forEach(p => { if (p.net) setTimeout(() => { try { p.net.redraw(); p.net.fit(); } catch (e) {} }, 50); });
    } else if (!graphLoaded) loadGraph();
    else {
      if (graph2D) setTimeout(() => { graph2D.redraw(); graph2D.fit(); }, 50);
      if (graph3D) setTimeout(() => { resizeGraph3D(); try { graph3D.zoomToFit(400, 60); } catch (e) {} }, 50);
    }
  } else if (tab === 'plan') {
    planTab.classList.remove('hidden');
    planTab.classList.add('flex');
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
      // Show the same guidance front-and-center (the Build button is right there
      // in the sidebar), instead of leaving a blank canvas.
      showGraphError($('graphContainer'), res.error);
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

// ---------- manual graph build (Build button on the Graph tab) ----------
// Building on demand fixes the "No knowledge graph found" dead-end: the user no
// longer has to ask the agent to run build_code_graph. The backend indexes on
// the host (no Docker round-trip) straight into <workspace>/.codegraph/<id>/,
// which is exactly where this tab reads — so the folder always appears.
let buildFormOpen = false;

function setBuildFormOpen(open) {
  buildFormOpen = open;
  const form = $('graphBuildForm');
  if (!form) return;
  if (open) { form.classList.remove('hidden'); form.classList.add('flex'); populateBuildTargets(); }
  else { form.classList.add('hidden'); form.classList.remove('flex'); }
}

async function populateBuildTargets() {
  const sel = $('graphBuildTarget');
  if (!sel) return;
  sel.innerHTML = '';
  // Whole workspace is always the default first option.
  let rootLabel = '';
  try {
    const r = await pywebview.api.list_graph_build_targets();
    if (r && r.root_label) rootLabel = r.root_label;
    const opt0 = document.createElement('option');
    opt0.value = '.';
    opt0.textContent = '(whole workspace' + (rootLabel ? ' · ' + rootLabel : '') + ')';
    sel.appendChild(opt0);
    if (r && r.ok) for (const d of (r.dirs || [])) {
      const o = document.createElement('option'); o.value = d; o.textContent = d; sel.appendChild(o);
    }
  } catch (e) {
    const opt0 = document.createElement('option'); opt0.value = '.'; opt0.textContent = '(whole workspace)';
    sel.appendChild(opt0);
  }
}

async function runManualBuild() {
  const target = ($('graphBuildTarget').value) || '.';
  const name = $('graphBuildName').value.trim();
  const so = $('graphBuildSo').checked;
  const status = $('graphBuildStatus');
  const btn = $('graphBuildRun');
  btn.disabled = true;
  status.className = 'text-[11px] text-term-muted';
  status.textContent = 'Building… indexing files (this can take a moment).';
  try {
    const res = await pywebview.api.build_code_graph_ui(target, name, so, true);
    if (!res || !res.ok) {
      status.className = 'text-[11px] text-term-red';
      status.textContent = 'Build failed: ' + escapeHtml((res && res.error) || 'unknown error');
      return;
    }
    if (res.graphs) populateGraphSelect(res.graphs, res.graph_id);
    currentGraphId = res.graph_id;
    graphLoaded = false;
    if (res.empty) {
      status.className = 'text-[11px] text-term-orange';
      status.textContent = 'Built "' + escapeHtml(res.graph_id) + '" but it has no indexable code — pick a folder that contains source.';
      return;
    }
    status.className = 'text-[11px] text-term-green';
    // Report HOW MUCH was indexed + WHERE the cache landed, so it's clear the
    // (whole-workspace) build actually covered the tree and wrote .codegraph.
    const c = res.counts || {};
    const detail = (c.files || c.classes)
      ? ' — ' + (c.files || 0) + ' files, ' + (c.classes || 0) + ' classes'
      : '';
    const where = res.cache_dir ? ' → ' + res.cache_dir + '/' : '';
    status.textContent = 'Built graph "' + escapeHtml(res.graph_id) + '"' + escapeHtml(detail + where);
    // If we were comparing, refresh that view; otherwise show the new graph.
    if (compareMode) renderCompare();
    else loadGraph(res.graph_id);
    setTimeout(() => { if (buildFormOpen) setBuildFormOpen(false); }, 1400);
  } catch (e) {
    status.className = 'text-[11px] text-term-red';
    status.textContent = 'Build error: ' + escapeHtml('' + e);
  } finally {
    btn.disabled = false;
  }
}

async function deleteSelectedGraph() {
  const sel = $('graphSelect');
  const gid = sel && sel.value;
  if (!gid) return;
  if (!confirm('Delete graph "' + gid + '"?\n\nThis removes only the built graph instance — your files are not touched.')) return;
  try {
    const res = await pywebview.api.delete_code_graph(gid);
    if (!res || !res.ok) { alert((res && res.error) || 'Delete failed.'); return; }
    populateGraphSelect(res.graphs, null);
    currentGraphId = null;
    graphLoaded = false;
    if (compareMode) renderCompare();
    else loadGraph();
  } catch (e) { alert('' + e); }
}

// ---------- multi-project compare (two graphs side by side) ----------
// A "compare two directories" request produces two SEPARATE graph instances
// (build each folder). Compare mode renders both at once in independent panes,
// each with its own selector, so the two projects are shown separately rather
// than merged into one graph.
let compareMode = false;
let comparePanes = [];

function setCompareButton(on) {
  const btn = $('graphCompareBtn');
  if (!btn) return;
  btn.classList.toggle('border-term-cyan', on);
  btn.classList.toggle('text-term-cyan', on);
  btn.classList.toggle('border-term-line', !on);
  btn.classList.toggle('text-term-muted', !on);
}

function teardownCompare() {
  for (const p of comparePanes) { if (p.net) { try { p.net.destroy(); } catch (e) {} p.net = null; } }
  comparePanes = [];
  const c = $('graphContainer');
  if (c) c.classList.remove('flex');
}

async function toggleCompareMode() {
  if (compareMode) {
    compareMode = false;
    setCompareButton(false);
    teardownCompare();
    graphLoaded = false;
    loadGraph(currentGraphId);
  } else {
    compareMode = true;
    setCompareButton(true);
    await renderCompare();
  }
}

async function renderCompare(idA, idB) {
  const container = $('graphContainer');
  if (!container) return;
  // Discover which graphs exist (only non-empty ones are worth comparing).
  let graphs = [];
  try {
    const res = await pywebview.api.get_code_graph(currentGraphId || null);
    if (res && res.graphs) { populateGraphSelect(res.graphs, res.graph_id); graphs = res.graphs; }
  } catch (e) {}
  const usable = graphs.filter(g => (g.classes || 0) > 0);
  // Retire the single-view engines before taking over the container.
  if (graph2D) { graph2D.destroy(); graph2D = null; }
  if (graph3D) { try { graph3D._destructor(); } catch (e) {} graph3D = null; }
  teardownCompare();
  $('graphLegend').innerHTML = '';
  $('graphStats').textContent = '';
  if (usable.length < 2) {
    showGraphError(container,
      'Compare needs two built graphs with data. Use “Build graph” to index a second ' +
      'project folder (each folder becomes its own graph), then Compare.');
    return;
  }
  const a = idA || usable[0].id;
  const b = idB || (usable.find(g => g.id !== a) || usable[1]).id;
  container.innerHTML = '';
  container.classList.add('flex');
  const paneA = makeComparePane(usable, a, true);   // left pane draws the divider
  const paneB = makeComparePane(usable, b, false);
  comparePanes = [paneA, paneB];
  container.appendChild(paneA.el);
  container.appendChild(paneB.el);
  await drawComparePane(paneA, a);
  await drawComparePane(paneB, b);
}

function makeComparePane(graphs, chosenId, withDivider) {
  const el = document.createElement('div');
  el.className = 'flex-1 min-w-0 flex flex-col' + (withDivider ? ' border-r border-term-line' : '');
  const head = document.createElement('div');
  head.className = 'flex items-center gap-2 px-2 py-1 border-b border-term-line bg-term-panel';
  const sel = document.createElement('select');
  sel.className = 'min-w-0 flex-1 rounded-lg border border-term-line bg-term-bg px-1.5 py-0.5 text-[11px] outline-none focus:border-term-cyan';
  for (const g of graphs) {
    const o = document.createElement('option');
    o.value = g.id;
    o.textContent = g.id + (g.classes ? ' · ' + g.classes + ' cls' : '');
    if (g.id === chosenId) o.selected = true;
    sel.appendChild(o);
  }
  const stat = document.createElement('div');
  stat.className = 'text-[10px] text-term-muted shrink-0';
  head.append(sel, stat);
  const canvas = document.createElement('div');
  canvas.className = 'flex-1 relative bg-term-bg';
  el.append(head, canvas);
  const pane = { el, sel, stat, canvas, net: null };
  sel.addEventListener('change', () => drawComparePane(pane, sel.value));
  return pane;
}

async function drawComparePane(pane, graphId) {
  pane.stat.textContent = '…';
  if (pane.net) { try { pane.net.destroy(); } catch (e) {} pane.net = null; }
  pane.canvas.innerHTML = '';
  try {
    const res = await pywebview.api.get_code_graph(graphId);
    if (!res || !res.ok || !res.graph || !res.graph.nodes || !res.graph.nodes.length) {
      pane.canvas.innerHTML =
        '<div class="absolute inset-0 flex items-center justify-center p-4 text-center">' +
        '<span class="text-term-muted text-[12px]">' +
        escapeHtml((res && res.error) || 'This graph has no nodes.') + '</span></div>';
      pane.stat.textContent = '';
      return;
    }
    if (typeof vis === 'undefined') {
      pane.canvas.innerHTML = '<div class="absolute inset-0 flex items-center justify-center p-4"><span class="text-term-muted text-[12px]">2D graph library unavailable.</span></div>';
      return;
    }
    pane.net = buildStandaloneNetwork(pane.canvas, res.graph);
    const s = res.graph.stats;
    pane.stat.textContent = s.total_nodes + 'n · ' + s.total_edges + 'e';
  } catch (e) {
    pane.canvas.innerHTML =
      '<div class="absolute inset-0 flex items-center justify-center p-4"><span class="text-term-red text-[12px]">' +
      escapeHtml('' + e) + '</span></div>';
  }
}

// A self-contained 2D network for a compare pane — deliberately does NOT touch
// the single-view globals (graph2D / _graphRaw / sidebar), so two can coexist.
function buildStandaloneNetwork(container, data) {
  const labelColor = cssVar('--term-text', '#c9d1d9');
  const nodes = data.nodes.map(n => ({
    id: n.id, label: n.label, color: n.color, size: n.size,
    font: { size: 9, color: labelColor }, title: n.title,
  }));
  const edges = data.edges.map((e, i) => ({
    id: i, from: e.from, to: e.to, title: e.title, width: e.width, color: e.color,
  }));
  const net = new vis.Network(container, { nodes: new vis.DataSet(nodes), edges: new vis.DataSet(edges) }, {
    physics: {
      enabled: true, solver: 'forceAtlas2Based',
      forceAtlas2Based: { gravitationalConstant: -60, centralGravity: 0.005, springLength: 110, springConstant: 0.08, damping: 0.4, avoidOverlap: 0.8 },
      stabilization: { iterations: 150, fit: true },
    },
    interaction: { hover: true, tooltipDelay: 100, hideEdgesOnDrag: true },
    nodes: { shape: 'dot', borderWidth: 1.5 },
    edges: { smooth: { type: 'cubicBezier', forceDirection: 'none', roundness: 0.4 }, selectionWidth: 3 },
  });
  net.once('stabilizationIterationsDone', () => net.setOptions({ physics: { enabled: false } }));
  return net;
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
  if (compareMode) return;  // compare panes are 2D-only; the toggle is a no-op there
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
  const w = c.clientWidth, h = c.clientHeight;
  // Only size to a REAL measured box. Falling back to a fixed 800x600 when the
  // container is momentarily zero-size (during the tab show/hide transition)
  // was making the canvas wider than its column on small screens, shoving the
  // sidebar off-screen. If size isn't known yet, skip — the ResizeObserver /
  // deferred calls below re-run this once layout settles.
  if (w > 0 && h > 0) graph3D.width(w).height(h);
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

  // Size now, then again once layout settles — the container may still be
  // reporting a stale/zero box on this first synchronous pass.
  resizeGraph3D();
  requestAnimationFrame(resizeGraph3D);
  setTimeout(resizeGraph3D, 80);
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
  refreshActiveLlm();  // populate the active-LLM header badge from the current config
  try {
    const st = await pywebview.api.get_state();
    if (st && st.active) await pywebview.api.restore_session();
  } catch (e) { /* stay on the start screen */ }

  // "Select folder": pick a host folder at runtime, mount it, and start on it.
  // No fixed workspace, no copy-in. (Import-from-folder button was removed.)
  $('newProjectBtn').addEventListener('click', pickWorkspaceAndStart);
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
    const path = $('projectSelect').value;
    if (!path || path.startsWith('(')) {
      $('startError').textContent = 'Select a workspace folder to forget.'; return;
    }
    if (!confirm(`Forget workspace "${path}"?\n\nThis removes it from the recent list and deletes its saved chat. Your folder on disk is NOT touched.`)) return;
    const btn = $('deleteProjectBtn'); btn.disabled = true;
    try {
      const res = await pywebview.api.delete_workspace(path);
      if (res.ok) await loadStartScreen();
      else $('startError').textContent = res.error || 'Failed to forget workspace.';
    } catch (e) {
      $('startError').textContent = '' + e;
    } finally {
      btn.disabled = false;
    }
  });

  // Import-from-folder is gone (the picked folder is mounted + edited in place,
  // no copy). The "Select folder" button above is the single entry point.

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
  // Manual build controls (fixes the "no graph yet" dead-end + enables one graph
  // per project for multi-project compare).
  $('graphBuildBtn').addEventListener('click', () => setBuildFormOpen(!buildFormOpen));
  $('graphBuildCancel').addEventListener('click', () => setBuildFormOpen(false));
  $('graphBuildRun').addEventListener('click', runManualBuild);
  $('graphCompareBtn').addEventListener('click', toggleCompareMode);
  $('graphDeleteBtn').addEventListener('click', deleteSelectedGraph);
  // Switching the selector forces a reload of that specific graph (bypasses the
  // graphLoaded cache, which only guards the first open of the tab). In compare
  // mode the per-pane selectors handle switching instead.
  $('graphSelect').addEventListener('change', (e) => { if (!compareMode) loadGraph(e.target.value); });
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

  $('activeLlmBadge').addEventListener('click', openLlmModal);
  $('llmSettingsBtn').addEventListener('click', openLlmModal);
  $('llmSettingsBtnStart').addEventListener('click', openLlmModal);
  $('llmModalClose').addEventListener('click', closeLlmModal);
  $('llmDoneBtn').addEventListener('click', closeLlmModal);
  $('llmAddBtn').addEventListener('click', llmAddEntry);
  $('llmBackBtn').addEventListener('click', () => { $('llmError').textContent = ''; llmShowList(); });
  $('llmSaveBtn').addEventListener('click', saveLlmEntry);
  $('llmTestBtn').addEventListener('click', testLlmConnection);
  $('llmSubtabBasic').addEventListener('click', () => llmSubtab('basic'));
  $('llmSubtabAdvanced').addEventListener('click', () => llmSubtab('advanced'));
  $('llmKeysAdd').addEventListener('click', () => _addListItem('llmKeysList', _LLM_KEY_OPTS));
  $('llmModelsAdd').addEventListener('click', () => _addModelLadder('llmModelsList'));
  $('llmVisionAdd').addEventListener('click', () => _addListItem('llmVisionList', _LLM_VISION_OPTS));
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
