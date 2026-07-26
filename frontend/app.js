// ===== Omni Agent frontend bridge =====
// Talks to the Python backend through pywebview's JS API and renders a
// terminal-style live view of the agent loop (with more detail than the old CLI).

const $ = (id) => document.getElementById(id);
const chat = $('chat');

let session = null;        // {project}
let autoScroll = true;
let replaying = false;     // true while a saved transcript is being replayed
let replayTs = null;       // wall-clock ms of the event being replayed (for real elapsed)

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
// ---------- light/dark theme toggle (header + start screen) ----------
// The <head> boot script applies the saved choice before first paint; these
// keep localStorage and the button icons (sun = switch to light, moon = switch
// to dark) in sync with the <html class="light"> flag.
const _THEME_SUN = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>';
const _THEME_MOON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
// ---------- sidebar collapse ----------
// The file tree is a fixed --sidebar-w column. On a narrow window that column is
// most of the usable width, so it can be folded away entirely; the chat reclaims
// the space and a matching expand button appears in the header. Persisted so the
// choice survives a reload.
const SIDEBAR_KEY = 'omni-sidebar-collapsed';

function setSidebarCollapsed(collapsed) {
  $('app').classList.toggle('sidebar-collapsed', collapsed);
  try { localStorage.setItem(SIDEBAR_KEY, collapsed ? '1' : '0'); } catch (e) { /* private mode */ }
  // The graph canvases size themselves to their container, so a width change
  // has to be announced or the 3D view keeps rendering at the old width.
  resizeGraph3D();
}

function applySidebarState() {
  let collapsed = false;
  try { collapsed = localStorage.getItem(SIDEBAR_KEY) === '1'; } catch (e) { /* private mode */ }
  $('app').classList.toggle('sidebar-collapsed', collapsed);
}

function applyThemeIcons() {
  const light = document.documentElement.classList.contains('light');
  const icon = light ? _THEME_MOON : _THEME_SUN;
  ['themeToggle', 'themeToggleStart'].forEach(id => { const b = $(id); if (b) b.innerHTML = icon; });
}
function toggleTheme() {
  const el = document.documentElement;
  el.classList.toggle('light');
  try { localStorage.setItem('omni-theme', el.classList.contains('light') ? 'light' : 'dark'); } catch (e) {}
  applyThemeIcons();
}

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
  // A genuine new user turn starts the run clock for the Thinking… elapsed readout.
  // (Skip during transcript replay on reopen — those aren't a live run.)
  // Only the clock restarts per turn — convoTokens is the size of the WHOLE
  // conversation and must keep climbing across turns.
  if (!replaying) runStartTs = performance.now();
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

// Live run telemetry surfaced on the Thinking… line: "Thinking… (31m 5s · 214k tokens)".
// convoTokens = total size of the MAIN conversation in real provider-reported
// tokens (from the 'status' event's convo_tokens). It counts every main-thread
// message ever sent — including ones auto-summarization later discarded — so it
// only ever climbs. Subagent spend is deliberately excluded. runStartTs = the
// wall-clock origin of the current run, reset on each user message.
let convoTokens = 0;
let runStartTs = null;
let _thinkTicker = null;

// Reset the live-render state (called whenever the chat is cleared/replaced).
function resetActivityState() {
  if (_thinkTicker) { clearInterval(_thinkTicker); _thinkTicker = null; }
  thinkingEl = null;
  currentGroup = null;
  convoTokens = 0;
  runStartTs = null;
  resetConcurrencyDock();
}

// Fill the elapsed/tokens suffix on the live Thinking… line, rendered as
// "(1h 55m 4s · 56k tokens)" — elapsed first, joined by a deliberately small
// middot. With only one value available the parens hold just that value; with
// neither, nothing is rendered (no empty parens).
function _updateThinkingMeta() {
  if (!thinkingEl) return;
  const meta = thinkingEl.querySelector('.think-meta');
  if (!meta) return;
  const parts = [];
  if (runStartTs != null) parts.push(escapeHtml(window.formatClock(performance.now() - runStartTs)));
  if (convoTokens > 0) parts.push(escapeHtml(`${window.formatTokens(convoTokens)} tokens`));
  meta.innerHTML = parts.length
    ? ` (${parts.join('<span class="think-dot">·</span>')})`
    : '';
}

function startThinking() {
  if (thinkingEl) { _updateThinkingMeta(); return; } // JSON-retry leg: reuse the existing line
  const el = document.createElement('div');
  el.className = 'py-0.5 font-mono text-[12px] leading-5';
  el.innerHTML = `<span class="braille-spin text-term-cyan">${SPIN_FRAMES[spinFrame]}</span> ` +
    `<span class="shimmer">Thinking…</span><span class="think-meta text-term-muted"></span>`;
  appendRow(el);
  registerSpinners(el);
  thinkingEl = el;
  _updateThinkingMeta();
  if (_thinkTicker) clearInterval(_thinkTicker);
  _thinkTicker = setInterval(_updateThinkingMeta, 1000); // tick elapsed while thinking
}

// An explanation arrived (as a 'thought' event). Complete the current action
// group — its silver title settles solid and it collapses — then print the
// explanation as a real white message and leave currentGroup null so the NEXT
// tool call opens a fresh group folded beneath this explanation. Events with no
// text fall through, so their action just extends the current group.
function finishThinking(ev) {
  if (_thinkTicker) { clearInterval(_thinkTicker); _thinkTicker = null; }
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

// ---------- tool metadata: display names + summary categories ----------
// One entry per registered tool: the human-facing name shown on an action row,
// and which of the six summary buckets it counts toward. Kept in sync with the
// Python registry by tests/test_tool_meta_coverage.py, which fails if a
// registered tool has no entry here.
const TOOL_META = {
  // read: reads content out of the workspace — counted by distinct path
  read_file_chunk:         { name: 'Read File', cat: 'read' },
  read_binary_range:       { name: 'Read Binary Range', cat: 'read' },
  tail_file:               { name: 'Tail File', cat: 'read' },
  read_skill_resource:     { name: 'Read Skill Resource', cat: 'read' },
  read_auto_screenshots:   { name: 'Read Screenshots', cat: 'read' },
  use_skill:               { name: 'Use Skill', cat: 'read' },
  extract_manifest_info:   { name: 'Read Manifest', cat: 'read' },
  extract_strings:         { name: 'Extract Strings', cat: 'read' },
  analyze_image:           { name: 'Analyze Image', cat: 'read' },
  analyze_keyframes:       { name: 'Analyze Keyframes', cat: 'read' },
  ghidra_decompile:        { name: 'Decompile (Ghidra)', cat: 'read' },
  jadx_decompile:          { name: 'Decompile (JADX)', cat: 'read' },
  decode_apk:              { name: 'Decode APK', cat: 'read' },
  unzip_apk:               { name: 'Unzip APK', cat: 'read' },
  disassemble_dex:         { name: 'Disassemble DEX', cat: 'read' },
  disassemble_range:       { name: 'Disassemble Range', cat: 'read' },
  llvm_objdump_disasm:     { name: 'Disassemble (objdump)', cat: 'read' },
  readelf_info:            { name: 'Read ELF Info', cat: 'read' },
  nm_symbols:              { name: 'Read Symbol Table', cat: 'read' },
  rabin2_info:             { name: 'Read Binary Info', cat: 'read' },
  inspect_apk:             { name: 'Inspect APK', cat: 'read' },
  list_dex_classes:        { name: 'List DEX Classes', cat: 'read' },
  analyze_function_calls:  { name: 'Analyze Function Calls', cat: 'read' },
  get_apk_signature_hash:  { name: 'Read APK Signature', cat: 'read' },
  verify_apk:              { name: 'Verify APK', cat: 'read' },
  compute_sha256:          { name: 'Compute SHA-256', cat: 'read' },
  compare_files_sha256:    { name: 'Compare File Hashes', cat: 'read' },
  diff_binary_files:       { name: 'Diff Binaries', cat: 'read' },
  compare_directories:     { name: 'Compare Directories', cat: 'read' },
  generate_test_report:    { name: 'Generate Test Report', cat: 'read' },
  get_logcat:              { name: 'Read Logcat', cat: 'run' },
  monitor_logcat:          { name: 'Monitor Logcat', cat: 'run' },
  read_archive_member:     { name: 'Read Archive Member', cat: 'read' },

  // change: writes or mutates files — counted by distinct path
  write_file:                  { name: 'Write File', cat: 'change' },
  replace_in_file:             { name: 'Edit File', cat: 'change' },
  delete_path:                 { name: 'Delete Path', cat: 'change' },
  move_file:                   { name: 'Move File', cat: 'change' },
  duplicate_file:              { name: 'Duplicate File', cat: 'change' },
  patch_smali_method:          { name: 'Patch Smali Method', cat: 'change' },
  insert_smali_code:           { name: 'Insert Smali Code', cat: 'change' },
  assemble_dex:                { name: 'Assemble DEX', cat: 'change' },
  patch_binary_string:         { name: 'Patch Binary String', cat: 'change' },
  binary_patch:                { name: 'Patch Binary', cat: 'change' },
  nop_function:                { name: 'NOP Function', cat: 'change' },
  patch_function_return:       { name: 'Patch Function Return', cat: 'change' },
  patch_at_offset_with_bytes:  { name: 'Patch At Offset', cat: 'change' },
  patch_bytes_at_offset:       { name: 'Patch Bytes At Offset', cat: 'change' },
  replace_file_in_apk:         { name: 'Replace File In APK', cat: 'change' },
  recompile_apk:               { name: 'Recompile APK', cat: 'change' },
  sign_apk:                    { name: 'Sign APK', cat: 'change' },
  assemble_and_patch:          { name: 'Assemble & Patch', cat: 'change' },
  compile_c_and_patch:         { name: 'Compile C & Patch', cat: 'change' },
  inject_session_bootstrap:    { name: 'Inject Session Bootstrap', cat: 'change' },
  hide_root_from_app:          { name: 'Hide Root From App', cat: 'run' },
  find_code_cave:              { name: 'Find Code Cave', cat: 'change' },

  // search: locating / querying — counted by call
  list_directory:            { name: 'List Directory', cat: 'search' },
  find_files:                { name: 'Find Files', cat: 'search' },
  grep_file:                 { name: 'Search In File', cat: 'search' },
  grep_directory:            { name: 'Search In Directory', cat: 'search' },
  search_java:               { name: 'Search Java', cat: 'search' },
  search_smali:              { name: 'Search Smali', cat: 'search' },
  query_code_graph:          { name: 'Query Code Graph', cat: 'search' },
  ask_codebase:              { name: 'Ask The Codebase', cat: 'search' },
  build_code_graph:          { name: 'Build Code Graph', cat: 'search' },
  diff_code_graphs:          { name: 'Diff Code Graphs', cat: 'search' },
  list_code_graphs:          { name: 'List Code Graphs', cat: 'search' },
  list_skills:               { name: 'List Skills', cat: 'search' },
  list_commands:             { name: 'List Commands', cat: 'search' },
  web_search:                { name: 'Search The Web', cat: 'search' },
  read_webpage:              { name: 'Read Webpage', cat: 'search' },
  download_file:             { name: 'Download File', cat: 'search' },
  find_byte_sequence_in_so:  { name: 'Find Byte Sequence', cat: 'search' },
  frida_list_processes:      { name: 'List Processes', cat: 'search' },
  list_roblox_accounts:      { name: 'List Roblox Accounts', cat: 'search' },
  expand_tools:              { name: 'Expand Tools', cat: 'search' },

  // run: executes something — counted by call
  run_command:                   { name: 'Run Command', cat: 'run' },
  use_command:                   { name: 'Use Command', cat: 'run' },
  adb_shell:                     { name: 'ADB Shell', cat: 'run' },
  radare2_cmd:                   { name: 'Radare2 Command', cat: 'run' },
  frida_run_script:              { name: 'Run Frida Script', cat: 'run' },
  frida_trace:                   { name: 'Frida Trace', cat: 'run' },
  frida_bypass_ssl_pinning:      { name: 'Bypass SSL Pinning', cat: 'run' },
  ensure_frida_server:           { name: 'Start Frida Server', cat: 'run' },
  ensure_emulator_running:       { name: 'Start Emulator', cat: 'run' },
  install_apk_on_emulator:       { name: 'Install APK', cat: 'run' },
  launch_app_on_emulator:        { name: 'Launch App', cat: 'run' },
  stop_emulator:                 { name: 'Stop Emulator', cat: 'run' },
  run_apk_test_session:          { name: 'Run APK Test Session', cat: 'run' },
  record_and_capture_keyframes:  { name: 'Record Keyframes', cat: 'run' },
  take_emulator_screenshot:      { name: 'Take Screenshot', cat: 'run' },
  tap_screen:                    { name: 'Tap Screen', cat: 'run' },
  swipe_screen:                  { name: 'Swipe Screen', cat: 'run' },
  press_key:                     { name: 'Press Key', cat: 'run' },
  type_text:                     { name: 'Type Text', cat: 'run' },
  set_emulator_ui:               { name: 'Set Emulator UI', cat: 'run' },
  launch_roblox_build:           { name: 'Launch Roblox Build', cat: 'run' },
  login_roblox_account:          { name: 'Log In Roblox Account', cat: 'run' },
  set_roblox_account:            { name: 'Set Roblox Account', cat: 'run' },
  play_roblox:                   { name: 'Play Roblox', cat: 'run' },

  // delegate: fans work out to subagents
  dispatch_agents:  { name: 'Dispatch Subagents', cat: 'delegate' },

  // plan: plan / investigation / strategy bookkeeping — counted by call
  plan_create:                  { name: 'Create Plan', cat: 'plan' },
  plan_add_task:                { name: 'Add Plan Step', cat: 'plan' },
  plan_update_task:             { name: 'Update Plan Step', cat: 'plan' },
  plan_advance_phase:           { name: 'Advance Phase', cat: 'plan' },
  plan_reorder:                 { name: 'Reorder Plan', cat: 'plan' },
  plan_replan:                  { name: 'Replan', cat: 'plan' },
  plan_set_next_action:         { name: 'Set Next Action', cat: 'plan' },
  plan_set_outcome:             { name: 'Set Step Outcome', cat: 'plan' },
  plan_view:                    { name: 'View Plan', cat: 'plan' },
  investigation_view:           { name: 'View Investigation', cat: 'plan' },
  record_assumption:            { name: 'Record Assumption', cat: 'plan' },
  record_decision:              { name: 'Record Decision', cat: 'plan' },
  record_failed_attempt:        { name: 'Record Failed Attempt', cat: 'plan' },
  record_finding:               { name: 'Record Finding', cat: 'plan' },
  record_hypothesis:            { name: 'Record Hypothesis', cat: 'plan' },
  record_learned_technique:     { name: 'Record Learned Technique', cat: 'plan' },
  record_open_question:         { name: 'Record Open Question', cat: 'plan' },
  record_test_result:           { name: 'Record Test Result', cat: 'plan' },
  update_assumption:            { name: 'Update Assumption', cat: 'plan' },
  update_hypothesis:            { name: 'Update Hypothesis', cat: 'plan' },
  declare_constraints:          { name: 'Declare Constraints', cat: 'plan' },
  clear_technique_constraints:  { name: 'Clear Constraints', cat: 'plan' },
  set_next_steps:               { name: 'Set Next Steps', cat: 'plan' },
  strategy_set:                 { name: 'Set Strategy', cat: 'plan' },
  strategy_update:              { name: 'Update Strategy', cat: 'plan' },
  review_conclusion:            { name: 'Review Conclusion', cat: 'plan' },
};

// Acronyms that must stay upper-case when a tool falls through to the mechanical
// fallback below (i.e. a tool added after this table was last regenerated).
const _TOOL_ACRONYMS = new Set([
  'apk', 'dex', 'elf', 'so', 'adb', 'url', 'id', 'ui', 'kg', 'js', 'nm', 'plt',
  'ssl', 'os', 'io', 'api', 'cli', 'sdk', 'jvm', 'xml', 'json',
]);

// Human-facing name for a tool. Curated entries win; anything unmapped is
// Title-Cased mechanically, so a newly added tool degrades to "Some New Tool"
// instead of leaking `some_new_tool` into the transcript.
function toolDisplayName(tool) {
  const meta = TOOL_META[tool];
  if (meta) return meta.name;
  const raw = String(tool || '');
  const words = raw.split('_').filter(Boolean).map(w =>
    _TOOL_ACRONYMS.has(w.toLowerCase())
      ? w.toUpperCase()
      : w.charAt(0).toUpperCase() + w.slice(1));
  return words.join(' ') || raw;
}

// Which of the six summary buckets a tool belongs to. Unmapped tools land in
// 'other', which renders as a trailing "Ran N tools" so they never disappear
// from the count.
function toolCategory(tool) {
  const meta = TOOL_META[tool];
  return meta ? meta.cat : 'other';
}

// Derived views, kept because other call sites still read them.
const READ_FILE_TOOLS = new Set(
  Object.keys(TOOL_META).filter(t => TOOL_META[t].cat === 'read'));
const CHANGE_FILE_TOOLS = new Set(
  Object.keys(TOOL_META).filter(t => TOOL_META[t].cat === 'change'));

// The identity a tool operates on, used to dedupe read/changed counts so that
// touching the same target twice still counts once. Mirrors the arg names the
// backend tools actually declare — kept honest by
// tests/test_tool_meta_coverage.py, which fails if a read/change tool takes none
// of these. Not every key is a filesystem path: a skill name or capture-session
// name identifies the thing just as well for counting purposes.
const _TOOL_PATH_ARGS = [
  // workspace files
  'filepath', 'file_path', 'path', 'destination', 'source', 'output', 'out_path', 'target',
  // binaries / native
  'binary_path', 'so_path', 'so_filename',
  // dex / smali
  'smali_file', 'smali_dir', 'dex_path', 'output_dex', 'decompiled_dir',
  // apk
  'apk_filename', 'apk_path', 'output_apk', 'manifest_path',
  // media
  'image_path', 'image_paths',
  // comparisons name two operands; the first is a stable enough identity
  'dir_a', 'file_a', 'file1',
  // non-filesystem identities
  'skill_name', 'resource_path', 'session_name',
];

function toolPathKey(args) {
  if (!args || typeof args !== 'object') return null;
  for (const k of _TOOL_PATH_ARGS) {
    const v = args[k];
    if (Array.isArray(v)) { if (v.length) return v.join(','); continue; }
    if (v) return v;
  }
  return null;
}

// Fresh per-group counters. read/change dedupe by workspace path, so touching
// the same file twice still counts once; every other bucket counts calls.
function newGroupCounts() {
  return { read: new Set(), change: new Set(), run: 0, search: 0, delegate: 0, plan: 0, other: 0 };
}

// How many subagents one dispatch_agents call fanned out to. The arg is a list
// of specs; anything unreadable counts as a single delegation.
function dispatchedAgentCount(args) {
  const specs = args && (args.agents || args.specs || args.tasks);
  return (Array.isArray(specs) && specs.length) ? specs.length : 1;
}

// Record one tool call into a group's counters. `seq` disambiguates calls that
// carry no path, so two pathless reads don't collapse into one.
function countToolCall(counts, ev, seq) {
  const cat = toolCategory(ev.tool);
  if (cat === 'read' || cat === 'change') {
    counts[cat].add(toolPathKey(ev.args) || `${ev.tool}#${seq}`);
  } else if (cat === 'delegate') {
    counts.delegate += dispatchedAgentCount(ev.args);
  } else {
    counts[cat] += 1;
  }
}

// The group's summary title: categorized counts in a fixed order, joined by "·",
// zero segments omitted. Replaces the old undifferentiated "Ran N tools".
const _GROUP_SEGMENTS = [
  ['read',     (n) => `Read ${n} ${n === 1 ? 'file' : 'files'}`],
  ['change',   (n) => `Changed ${n} ${n === 1 ? 'file' : 'files'}`],
  ['run',      (n) => `Ran ${n} ${n === 1 ? 'command' : 'commands'}`],
  ['search',   (n) => `Searched ${n === 1 ? 'once' : n + ' times'}`],
  ['delegate', (n) => `Delegated to ${n} ${n === 1 ? 'subagent' : 'subagents'}`],
  ['plan',     (n) => `Planned ${n} ${n === 1 ? 'step' : 'steps'}`],
  ['other',    (n) => `Ran ${n} ${n === 1 ? 'tool' : 'tools'}`],
];

function groupTitleText(g) {
  const c = g.counts;
  const parts = [];
  for (const [key, fmt] of _GROUP_SEGMENTS) {
    const n = (key === 'read' || key === 'change') ? c[key].size : c[key];
    if (n > 0) parts.push(fmt(n));
  }
  if (!parts.length) return `Ran ${g.n} ${g.n === 1 ? 'tool' : 'tools'}`;
  return parts.join(' · ');
}

function updateGroupTitle(g) {
  g.titleEl.textContent = groupTitleText(g);
  // The raw total stays reachable without cluttering the line.
  g.titleEl.title = `${g.n} ${g.n === 1 ? 'tool call' : 'tool calls'}`;
}

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
  // On replay the wall clock is meaningless (everything happens "now"); use the
  // timestamp of the event that closed the group so the shown elapsed is the real
  // historical duration, not ~0s.
  const nowTs = (replaying && replayTs != null) ? replayTs : Date.now();
  g.metaEl.textContent = fmtElapsed(nowTs - g.startTs);
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
    n: 0, counts: newGroupCounts(),
    liveId: null, liveEv: null, liveRow: null,
    // On replay, anchor the group's clock to the event's real timestamp so its
    // completed elapsed reflects history, not the instant of the rebuild.
    startTs: (replaying && replayTs != null) ? replayTs : Date.now(),
    completed: false, open: true,
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
  return `${icon} <span class="${nameCls}">${escapeHtml(toolDisplayName(ev.tool))}</span>` +
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
  countToolCall(g.counts, ev, g.n);
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
  if (_thinkTicker) { clearInterval(_thinkTicker); _thinkTicker = null; }
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
  // The steps / tools / ctx / resets header counters were removed; the only status
  // field still surfaced is the token count, which rides on the live Thinking… line.
  // Prefer convo_tokens (real provider counts, monotonic). Transcripts recorded
  // before that field existed still replay, falling back to the old ctx_tokens
  // estimate rather than showing zero.
  const tokens = (ev.convo_tokens !== undefined && ev.convo_tokens !== null)
    ? ev.convo_tokens : ev.ctx_tokens;
  if (tokens !== undefined && tokens !== null) {
    convoTokens = tokens;
    _updateThinkingMeta();
  }
}

// ---------- concurrency dock: live parallel-wave timeline ----------
// A pinned bottom-right dock proving parallelism: one time-driven bar per
// subagent on a shared wall-clock axis (overlap = provably concurrent), plus a
// wall-vs-summed speedup line when the wave finishes. Driven by wave_started /
// subagent_started|progress|done / wave_done. Bars grow via a local ticker, not
// per-step events, so they glide smoothly regardless of event cadence.
// computeWaveStats comes from wave_stats.js (loaded before this script).
let _wave = null;          // { originTs, bars: Map<rowKey,bar>, done }
let _waveTicker = null;

// ---------- persistent session HUD ----------
// Unlike a single wave (which comes and goes), the HUD spans a whole run of
// subagent activity: it appears with the first subagent, survives across every
// wave in the run, and shows the three things the run cares about — elapsed time
// since the first subagent started, how many are running vs done, and the
// cumulative token spend across ALL subagents. Its epoch resets when a new run's
// first subagent activity arrives after the previous run ended (see _hudEnsure).
// All HUD accounting lives in the DOM-free SessionHudModel (wave_stats.js); this
// layer is only the ticker + DOM writes. wave_stats.js is deferred and app.js is
// not, so it isn't defined at parse time — instantiate lazily on first use.
let _hud = null;
let _hudTicker = null;
function _hudModel() {
  if (!_hud) _hud = new window.SessionHudModel();
  return _hud;
}

function _hudShowPanel() {
  const sess = _dock().querySelector('.cdock-session');
  if (sess) sess.style.display = '';
  if (!_hudTicker) _hudTicker = setInterval(_hudRender, 1000);
}

function _hudEnsure() {
  // Reveal the panel + start ticking. The model owns epoch lifecycle; a snapshot
  // stays null (render no-ops) until the first subagent actually starts.
  _hudShowPanel();
}

function _hudOnStart(ev) {
  _hudModel().onStart(_waveRowKey(ev), performance.now());
  _hudShowPanel();
  _hudRender();
}

function _hudOnProgress(ev) {
  _hudModel().onProgress(_waveRowKey(ev), ev.tokens || 0);
  _hudRender();
}

function _hudOnDone(ev) {
  _hudModel().onDone(_waveRowKey(ev), ev.tokens || 0);
  _hudRender();
}

function _hudEnd() {
  // Whole run finished: freeze the elapsed timer, keep the final tally on screen
  // until the next run's first subagent (a fresh epoch) or a session reset.
  if (_hud) _hud.end();
  if (_hudTicker) { clearInterval(_hudTicker); _hudTicker = null; }
  _hudRender();
}

function _hudRender() {
  if (!_hud) return;
  const el = document.getElementById('concurrency-dock');
  if (!el) return;
  const sess = el.querySelector('.cdock-session');
  if (!sess) return;
  const stats = _hud.snapshot(performance.now());
  if (!stats) return;
  sess.querySelector('.cdock-sess-elapsed').textContent = stats.elapsed;
  sess.querySelector('.cdock-sess-count').textContent = stats.countLabel;
  sess.querySelector('.cdock-sess-tokens').textContent = stats.tokensLabel;
  sess.classList.toggle('cdock-sess-idle', _hud.idle);
}

function resetSessionHud() {
  if (_hudTicker) { clearInterval(_hudTicker); _hudTicker = null; }
  if (_hud) _hud.reset();
}

// The Subagents UI is a right slide-in SIDEBAR (#concurrency-dock) plus a small
// persistent toggle button (#subagents-fab) pinned bottom-right. Clicking the FAB
// slides the sidebar in/out; the sidebar's × closes it. Both are created together
// on first subagent activity and removed together on reset.
function _dock() {
  let el = document.getElementById('concurrency-dock');
  if (!el) {
    // Bottom-right toggle button — the thing the user clicks to reveal the sidebar.
    const fab = document.createElement('button');
    fab.id = 'subagents-fab';
    fab.type = 'button';
    fab.innerHTML = '<span>⚡</span><span class="fab-label">Subagents</span><span class="fab-count"></span>';
    fab.addEventListener('click', _toggleSubagents);
    document.body.appendChild(fab);

    el = document.createElement('div');
    el.id = 'concurrency-dock';
    el.innerHTML =
      '<div class="cdock-header"><span>⚡</span><span class="cdock-title">Subagents</span>' +
      '<span class="cdock-count"></span>' +
      '<button class="cdock-close" type="button" title="Close">✕</button></div>' +
      '<div class="cdock-session" style="display:none">' +
      '<div class="cdock-sess-line"><span class="cdock-sess-elapsed">00:00</span>' +
      '<span class="cdock-sess-count">0 running · 0 done</span></div>' +
      '<div class="cdock-sess-line"><span class="cdock-sess-toklabel">session tokens</span>' +
      '<span class="cdock-sess-tokens">0</span></div></div>' +
      '<div class="cdock-body"></div><div class="cdock-summary" style="display:none"></div>';
    el.querySelector('.cdock-close').addEventListener('click', _closeSubagents);
    document.body.appendChild(el);
  }
  return el;
}

// The dock is position:fixed so it can slide in. `cdock-pushed` on <body> is what
// makes the app shell reserve its width (see index.html) so the chat and sidebar
// shrink instead of being covered — keep the two classes in lockstep.
function _syncDockPush() {
  document.body.classList.toggle('cdock-pushed', _dock().classList.contains('cdock-open'));
}
function _toggleSubagents() { _dock().classList.toggle('cdock-open'); _syncDockPush(); }
function _openSubagents() { _dock().classList.add('cdock-open'); _syncDockPush(); }
function _closeSubagents() { _dock().classList.remove('cdock-open'); _syncDockPush(); }

// Reflect live subagent counts on the always-visible FAB so it's informative even
// while the sidebar is closed.
function _updateFab(runningCount, done) {
  const fab = document.getElementById('subagents-fab');
  if (!fab) return;
  fab.classList.add('fab-visible');
  const c = fab.querySelector('.fab-count');
  if (c) c.textContent = runningCount > 0 ? String(runningCount) : (done ? '✓' : '');
  fab.classList.toggle('fab-active', runningCount > 0);
}

function _waveRowKey(ev) {
  // sub_id uniquely identifies one subagent invocation — prefer it. Concurrent
  // subagents can now share an API key (no keys-1 cap), so key_label alone can
  // collide between two bars of the same delegate agent; fall back to the old
  // agent+key_label key only for events that predate sub_id.
  if (ev.sub_id) return `${ev.wave_id || ''}::${ev.sub_id}`;
  return `${ev.wave_id || ''}::${ev.agent || ''}::${ev.key_label || ''}`;
}

function resetConcurrencyDock() {
  if (_waveTicker) { clearInterval(_waveTicker); _waveTicker = null; }
  if (_freezeTimer) { clearTimeout(_freezeTimer); _freezeTimer = null; }
  _wave = null;
  resetSessionHud();
  const el = document.getElementById('concurrency-dock');
  if (el) el.remove();
  const fab = document.getElementById('subagents-fab');
  if (fab) fab.remove();
}

function _startWave() {
  if (_waveTicker) clearInterval(_waveTicker);
  if (_freezeTimer) { clearTimeout(_freezeTimer); _freezeTimer = null; }
  _wave = { originTs: performance.now(), bars: new Map(), done: false };
  const el = _dock();
  // Running bars live in .cdock-active; finished ones are moved into a lazily
  // created .cdock-completed group below them (see subagentDone).
  el.querySelector('.cdock-body').innerHTML = '<div class="cdock-active"></div>';
  el.querySelector('.cdock-summary').style.display = 'none';
  _openSubagents(); // auto-reveal the sidebar when a wave starts so the work is visible
  _waveTicker = setInterval(_renderWave, 200);
  _renderWave();
}

function _ensureWave() { if (!_wave || _wave.done) _startWave(); }

// Rebuild the Subagents dock from a persisted snapshot after a refresh / reopen,
// so the menu doesn't vanish. This is a STATIC restore — no live timeline or
// ticker (the run that produced these subagents is over from the dock's view);
// every row renders in its final label-only form. A subsequent live wave_started
// clears this and takes over.
function waveRestore(ev) {
  const dock = ev && ev.dock;
  const rows = dock && Array.isArray(dock.rows) ? dock.rows : [];
  if (!rows.length) return;
  _hudEnsure();
  const el = _dock();
  const body = el.querySelector('.cdock-body');
  body.innerHTML = '<div class="cdock-active"></div>';
  el.querySelector('.cdock-summary').style.display = 'none';
  _wave = null; // static — not a live wave
  let doneCount = 0;
  rows.forEach(r => {
    const row = document.createElement('div');
    row.className = 'cbar cbar-done ' + (r.running ? '' : (r.ok ? 'cbar-ok' : 'cbar-failed'));
    row.innerHTML =
      '<div class="cbar-label"><span class="cbar-name"></span><span class="cbar-task"></span>' +
      '<span class="cbar-model"></span><span class="cbar-key"></span><span class="cbar-stat"></span></div>';
    row.querySelector('.cbar-name').textContent = r.agent || '';
    row.querySelector('.cbar-task').textContent = r.task || '';
    row.querySelector('.cbar-model').textContent =
      _modelTierLabel(r.tier, r.model) + (r.escalated ? ' ⇡' : '');
    row.querySelector('.cbar-key').textContent = r.key_label || '';
    row.querySelector('.cbar-stat').textContent = r.running
      ? `⋯ interrupted · ${r.tokens || 0} tok · step ${r.steps || 0}`
      : `${r.ok ? '✓' : '✗'} ${r.elapsed_s || 0}s · ${r.tokens || 0} tok · ${r.steps || 0} steps`;
    _completedSection().appendChild(row);
    if (!r.running) doneCount++;
  });
  const cnt = _completedSection().querySelector('.cdock-done-count');
  if (cnt) cnt.textContent = String(rows.length);
  el.querySelector('.cdock-count').textContent = '';
  _updateFab(0, doneCount > 0); // surface the FAB so the menu is reachable; don't auto-open
}

function waveStarted(ev) { _hudEnsure(); _startWave(); }

// Compact "tier · model" label for the HUD row, e.g. "cheap · gpt-4o-mini".
// Either half may be absent (an explicit model list has no tier; a ladder-less
// spec has no model yet) — never render a dangling separator.
function _modelTierLabel(tier, model) {
  return [tier, model].filter(Boolean).join(' · ');
}

function subagentStarted(ev) {
  _ensureWave();
  _hudOnStart(ev);
  const key = _waveRowKey(ev);
  const now = performance.now();
  const row = document.createElement('div');
  row.className = 'cbar';
  row.innerHTML =
    '<div class="cbar-label"><span class="cbar-name"></span><span class="cbar-task"></span>' +
    '<span class="cbar-model"></span><span class="cbar-key"></span><span class="cbar-stat"></span></div>' +
    '<div class="cbar-track"><div class="cbar-fill"></div></div>';
  row.querySelector('.cbar-name').textContent = ev.agent || '';
  row.querySelector('.cbar-task').textContent = ev.task || '';
  row.querySelector('.cbar-model').textContent = _modelTierLabel(ev.tier, ev.model);
  row.querySelector('.cbar-key').textContent = ev.key_label || '';
  const active = _dock().querySelector('.cdock-active') || _dock().querySelector('.cdock-body');
  active.appendChild(row);
  _wave.bars.set(key, { row, startOffsetMs: now - _wave.originTs, endOffsetMs: null,
                        ok: null, steps: 0, tokens: 0, name: ev.agent, running: true,
                        tier: ev.tier });
  _renderWave();
}

// Lazily create (once per wave) the "Completed" group that finished subagent
// rows are moved into, appended below the live .cdock-active bars in the body.
function _completedSection() {
  const body = _dock().querySelector('.cdock-body');
  let sec = body.querySelector('.cdock-completed');
  if (!sec) {
    sec = document.createElement('div');
    sec.className = 'cdock-completed';
    sec.innerHTML = '<div class="cdock-done-title">Completed <span class="cdock-done-count">0</span></div>';
    body.appendChild(sec);
  }
  return sec;
}

function subagentProgress(ev) {
  if (!_wave) return;
  const bar = _wave.bars.get(_waveRowKey(ev));
  if (!bar) return;
  bar.steps = ev.step; bar.tokens = ev.tokens;
  bar.row.querySelector('.cbar-stat').textContent = `${ev.tokens} tok · step ${ev.step}/${ev.max_steps}`;
  _hudOnProgress(ev);
}

function subagentDone(ev) {
  if (!_wave) return;
  const bar = _wave.bars.get(_waveRowKey(ev));
  if (!bar) return;
  bar.endOffsetMs = performance.now() - _wave.originTs;
  bar.ok = !!ev.ok; bar.running = false; bar.steps = ev.steps; bar.tokens = ev.tokens;
  bar.row.querySelector('.cbar-fill').classList.add(ev.ok ? 'ok' : 'failed');
  bar.row.querySelector('.cbar-stat').textContent =
    `${ev.ok ? '✓' : '✗'} ${ev.elapsed_s}s · ${ev.tokens} tok · ${ev.steps} steps`;
  // The model actually served can differ from the one advertised at start
  // (mid-run fallback) and/or have escalated after repeated protocol errors —
  // refresh the label so the HUD reflects what really ran.
  if (ev.model) {
    const modelEl = bar.row.querySelector('.cbar-model');
    modelEl.textContent = _modelTierLabel(bar.tier, ev.model) + (ev.escalated ? ' ⇡' : '');
    if (ev.escalated) modelEl.title = 'escalated to a stronger model after repeated protocol errors';
  }
  // Retire the finished row: its timeline bar only ever spanned its slice of the
  // shared wall-clock axis (green but never "full", which misreads as still
  // running), so drop the track entirely and file the row under a "Completed"
  // title. The ✓/✗ stat line now carries the outcome.
  const track = bar.row.querySelector('.cbar-track');
  if (track) track.remove();
  bar.row.classList.add('cbar-done', ev.ok ? 'cbar-ok' : 'cbar-failed');
  const sec = _completedSection();
  sec.appendChild(bar.row);
  const cnt = sec.querySelector('.cdock-done-count');
  if (cnt) cnt.textContent = String(sec.querySelectorAll('.cbar-done').length);
  _hudOnDone(ev);
  _renderWave();
  // Singleton (write) waves have no wave_done: freeze when nothing is running.
  if (![..._wave.bars.values()].some(b => b.running)) _freezeWaveSoon();
}

let _freezeTimer = null;
function _freezeWaveSoon() {
  if (_freezeTimer) clearTimeout(_freezeTimer);
  // Capture the specific wave this freeze was scheduled for. A new wave_started
  // can arrive within the grace window and replace the global _wave with a fresh,
  // empty wave — without this the stale timer would see zero running bars on
  // THAT new wave and prematurely freeze it (bogus "0 agents" summary).
  const w = _wave;
  // brief grace so a rapid next-start in the same wave doesn't prematurely freeze
  _freezeTimer = setTimeout(() => {
    if (_wave === w && ![..._wave.bars.values()].some(b => b.running)) waveDone({});
  }, 400);
}

function waveDone(ev) {
  if (!_wave || _wave.done) return;
  _wave.done = true;
  if (_waveTicker) { clearInterval(_waveTicker); _waveTicker = null; }
  _renderWave();
  const stats = window.computeWaveStats([..._wave.bars.values()]);
  const el = _dock();
  const sum = el.querySelector('.cdock-summary');
  sum.style.display = '';
  sum.innerHTML = `⚡ wave done · ${stats.n} agents · peak ${stats.peak} concurrent · ` +
    `${stats.wallS}s wall vs ${stats.summedS}s summed → ` +
    `<span class="cdock-speedup">${stats.speedup}× faster</span>`;
  el.querySelector('.cdock-count').textContent = '';
  _updateFab(0, true);
}

function _renderWave() {
  if (!_wave) return;
  const el = _dock();
  const bars = [..._wave.bars.values()];
  const now = performance.now();
  let span = 1;
  bars.forEach(b => { const end = b.endOffsetMs == null ? now - _wave.originTs : b.endOffsetMs; if (end > span) span = end; });
  const runningCount = bars.filter(b => b.running).length;
  el.querySelector('.cdock-count').textContent = _wave.done ? '' : `${runningCount} running`;
  _updateFab(runningCount, _wave.done);
  bars.forEach(b => {
    const fill = b.row.querySelector('.cbar-fill');
    if (!fill) return;   // a completed row: its timeline track was removed on done
    const end = b.endOffsetMs == null ? now - _wave.originTs : b.endOffsetMs;
    fill.style.left = `${(b.startOffsetMs / span) * 100}%`;
    fill.style.width = `${Math.max(1, ((end - b.startOffsetMs) / span) * 100)}%`;
  });
}

// Dev-only: fire a synthetic parallel wave so the dock can be verified without a
// real delegating task. Call __demoWave(3) from the browser console.
window.__demoWave = function (n = 3) {
  const send = ev => window.__agent.onEvent(ev);
  const wave_id = 'demo' + Math.floor(Math.random() * 1e4);
  send({ type: 'wave_started', wave_id, size: n, workers: n });
  for (let i = 0; i < n; i++) {
    const agent = `probe-${i + 1}`, key_label = `k${i + 1}`, sub_id = `demo-${i}`;
    const dur = 1500 + Math.round(Math.random() * 3500);
    const base = { wave_id, agent, key_label, sub_id };
    send({ type: 'subagent_started', ...base, task: `investigating thing #${i + 1}`, mode: 'read' });
    let step = 0;
    const iv = setInterval(() => {
      step++;
      send({ type: 'subagent_progress', ...base, elapsed_s: step, tokens: step * 900, step, max_steps: 6 });
    }, dur / 5);
    setTimeout(() => {
      clearInterval(iv);
      send({ type: 'subagent_done', ...base, ok: Math.random() > 0.15,
             elapsed_s: Math.round(dur / 1000), tokens: 5400, steps: 5 });
    }, dur);
  }
  const total = 5200;
  setTimeout(() => send({ type: 'wave_done', wave_id }), total);
};

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

// ---------- composer model selector + fallback indicator ----------
// The dropdown under the input box picks the model requests START at. The engine
// only ever falls back DOWNWARD from that selection (never to a model above it)
// and returns to it as soon as it recovers. While a fallback is serving, the
// dropdown shows the serving model with a small "fallback" badge — the user's
// selection itself is unchanged.
let _modelOptions = [];      // flattened rungs across providers, fallback order
let _preferredModel = null;  // model id the user pinned (or the primary)
let _activeModel = null;     // model that last answered (from 'active_llm' events)

function _updateFallbackBadge() {
  const sel = $('modelSelect');
  const badge = $('fallbackBadge');
  if (!sel || !badge) return;
  const fellBack = !!(_activeModel && _preferredModel && _activeModel !== _preferredModel
    && _modelOptions.some(m => m.model === _activeModel));
  const shown = fellBack ? _activeModel
    : (_preferredModel || (_modelOptions[0] && _modelOptions[0].model) || '');
  if (shown && sel.value !== shown) sel.value = shown;
  badge.classList.toggle('hidden', !fellBack);
  if (fellBack) {
    badge.title = `Fallback — "${_preferredModel}" is unavailable, temporarily using `
      + `"${_activeModel}". Your selection is kept and retried automatically.`;
  }
  _syncModelTrigger();
}

// Custom dropdown UI over the hidden #modelSelect. The native popup can't be
// font-styled in the desktop webview, and a native select always sizes to its
// widest option — the trigger button + menu here hug the selected name and use
// the app's own font/colors. The select stays the source of truth: picking an
// item sets its value and fires 'change' so onModelSelected runs unchanged.
const _MODEL_CHECK_SVG = '<svg class="composer-model-check" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';

function _syncModelTrigger() {
  const sel = $('modelSelect'), btn = $('modelSelectBtn'), label = $('modelSelectLabel');
  if (!sel || !btn || !label) return;
  const opt = sel.selectedOptions && sel.selectedOptions[0];
  label.textContent = opt ? opt.textContent : (sel.value || '—');
  btn.disabled = sel.disabled;
  btn.title = (opt && opt.title) || '';

  // Surface the active effort on the trigger, so the current level is visible
  // without opening the menu. Hidden when the model has nothing to configure.
  const suffix = btn.querySelector('.composer-model-effort');
  if (suffix) {
    const meta = _modelOptions.find(m => m.model === sel.value);
    const fam = meta && (meta.reasoning_style || detectReasoningFamily(sel.value));
    const def = fam && _REASONING_FAMILIES[fam];
    const eff = meta && _coerceEffort(fam, meta.reasoning_effort || '');
    const known = def && def.options && def.options.find(([v]) => v === eff);
    // "Default" carries no information on the trigger — only show a real level.
    const show = known && eff ? known[1] : '';
    suffix.textContent = show;
    suffix.classList.toggle('hidden', !show);
  }
}

function _closeModelMenu() {
  const menu = $('modelMenu');
  if (!menu || menu.classList.contains('hidden')) return;
  menu.classList.add('hidden');
  $('modelSelectBtn').setAttribute('aria-expanded', 'false');
}

function _openModelMenu() {
  const sel = $('modelSelect'), menu = $('modelMenu');
  if (!sel || !menu || sel.disabled) return;
  menu.innerHTML = '';
  [...sel.options].forEach(o => {
    const it = document.createElement('button');
    it.type = 'button';
    it.setAttribute('role', 'option');
    it.className = 'composer-model-item' + (o.value === sel.value ? ' active' : '');
    it.title = o.title || o.textContent;
    const lbl = document.createElement('span');
    lbl.className = 'composer-model-item-label';
    lbl.textContent = o.textContent;
    it.appendChild(lbl);
    if (o.value === sel.value) it.insertAdjacentHTML('beforeend', _MODEL_CHECK_SVG);
    it.addEventListener('click', () => {
      _closeModelMenu();
      if (o.value !== sel.value) { sel.value = o.value; sel.dispatchEvent(new Event('change')); }
      _syncModelTrigger();
    });
    menu.appendChild(it);
  });
  _appendEffortSection(menu, sel.value);
  menu.classList.remove('hidden');
  $('modelSelectBtn').setAttribute('aria-expanded', 'true');
  const act = menu.querySelector('.active');
  if (act) act.scrollIntoView({ block: 'nearest' });
}

// The effort control that lives at the FOOT of the model menu. Which levels are
// offered depends on the selected model's reasoning family — a GLM model gets a
// thinking on/off toggle, an OpenAI-style model gets Off..Max, and a model that
// always reasons (DeepSeek R1) gets no control at all. Families and their option
// lists are the same _REASONING_FAMILIES table the LLM settings panel uses, so
// the two surfaces can never disagree about what a model supports.
function _appendEffortSection(menu, model) {
  const opt = _modelOptions.find(m => m.model === model);
  if (!opt) return;
  const fam = opt.reasoning_style || detectReasoningFamily(model);
  const def = _REASONING_FAMILIES[fam];
  if (!def || !def.options) return;   // family reasons unconditionally

  const current = _coerceEffort(fam, opt.reasoning_effort || '');

  const sec = document.createElement('div');
  sec.className = 'composer-effort';

  const head = document.createElement('div');
  head.className = 'composer-effort-head';
  head.textContent = 'Effort';
  head.title = def.label;
  sec.appendChild(head);

  const row = document.createElement('div');
  row.className = 'composer-effort-row';
  def.options.forEach(([value, label]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'composer-effort-btn' + (value === current ? ' active' : '');
    b.textContent = label;
    b.title = def.label;
    b.addEventListener('click', (e) => {
      // Keep the menu open: changing effort is a setting, not a selection, and
      // closing here would make comparing levels needlessly fiddly.
      e.stopPropagation();
      setModelEffort(opt.config_id || '', model, value);
    });
    row.appendChild(b);
  });
  sec.appendChild(row);
  menu.appendChild(sec);
}

async function setModelEffort(configId, model, effort) {
  const target = _modelOptions.find(m => m.model === model);
  if (target) target.reasoning_effort = effort;   // optimistic, for instant feedback
  _syncModelTrigger();
  if (!$('modelMenu').classList.contains('hidden')) _openModelMenu();  // re-render the row
  try {
    const res = await pywebview.api.set_model_effort(configId, model, effort);
    if (res && res.ok && res.options) {
      _modelOptions = res.options;
      _syncModelTrigger();
      if (!$('modelMenu').classList.contains('hidden')) _openModelMenu();
    }
  } catch (e) { /* non-fatal: the optimistic value stands until the next refresh */ }
}

function _renderModelSelect() {
  const sel = $('modelSelect');
  if (!sel) return;
  sel.innerHTML = '';
  if (!_modelOptions.length) {
    const o = document.createElement('option');
    o.value = ''; o.textContent = 'no models — open LLM settings';
    sel.appendChild(o);
    sel.disabled = true;
    _updateFallbackBadge();
    return;
  }
  sel.disabled = false;
  // Prefix the provider name only when models come from more than one provider.
  const names = new Set(_modelOptions.map(m => m.name));
  _modelOptions.forEach(m => {
    const o = document.createElement('option');
    o.value = m.model;
    o.textContent = names.size > 1 ? `${m.name} · ${m.model}` : m.model;
    o.title = `${m.name} — ${m.model}`;
    sel.appendChild(o);
  });
  _updateFallbackBadge();
}

async function refreshModelOptions() {
  try {
    const res = await pywebview.api.get_model_options();
    if (!res || !res.ok) return;
    _modelOptions = res.options || [];
    _preferredModel = (res.preferred && res.preferred.model)
      || (_modelOptions.find(m => m.preferred) || {}).model || null;
    if (res.active && res.active.model) _activeModel = res.active.model;
    _renderModelSelect();
  } catch (e) { /* non-fatal: the selector just keeps its current state */ }
}

function onActiveLlm(info) {
  _activeModel = (info && info.model) || null;
  _updateFallbackBadge();
}

async function onModelSelected() {
  const sel = $('modelSelect');
  const model = sel.value;
  const opt = _modelOptions.find(m => m.model === model);
  _preferredModel = model || null;
  // Forget the stale active model so the dropdown shows the new pick; the next
  // 'active_llm' event re-reports what's actually serving (and re-flags fallback).
  _activeModel = null;
  _updateFallbackBadge();
  try {
    await pywebview.api.set_preferred_model(opt ? (opt.config_id || '') : '', model);
  } catch (e) { /* non-fatal */ }
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
      case 'active_llm': onActiveLlm(ev); break;
      case 'system': renderSystem(ev.content); break;
      case 'log': renderLog(ev.content); break;
      case 'error': renderError(ev.content); break;
      case 'status': renderStatus(ev); break;
      case 'file_tree': renderFileTree(ev.tree); break;
      case 'plan_update': renderPlan(ev.plan); break;
      case 'wave_restore': waveRestore(ev); break;
      case 'wave_started': waveStarted(ev); break;
      case 'subagent_started': subagentStarted(ev); break;
      case 'subagent_progress': subagentProgress(ev); break;
      case 'subagent_done': subagentDone(ev); break;
      case 'wave_done': waveDone(ev); break;
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
  _hudEnd(); // freeze the session HUD's elapsed timer; keep the final tally visible
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
  const btns = [$('uploadFilesBtn'), $('composerUploadBtn')].filter(Boolean);
  btns.forEach(b => { b.disabled = true; });
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
    btns.forEach(b => { b.disabled = false; });
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
      for (const e of transcript) {
        replayTs = (typeof e.ts === 'number') ? e.ts : null;
        try { window.__agent.onEvent(e); } catch (_) {}
      }
      // If the run isn't still live, settle the last open action group using the
      // final event's timestamp so it shows its real elapsed and collapses.
      if (!ev.busy) finalizeLiveLines();
    } finally {
      replaying = false;
      replayTs = null;
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
  refreshModelOptions(); // sync the composer's model selector with the config
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
// ---------- workspace picker (start screen) ----------
// A VS Code-style recent list, not a <select>: each row shows the folder name,
// its full path, when it was last opened and how big its saved chat is, with
// per-row actions revealed on hover.
let _recent = [];            // [{label, path, opened_at, message_count}]
let _selectedWs = null;      // path of the highlighted row

// "3 minutes ago" / "2 days ago". Entries saved before opened_at existed have
// no timestamp and render as an em dash rather than a fabricated "just now".
function relativeTime(epochSeconds) {
  if (!epochSeconds) return '—';
  const s = Math.max(0, Math.floor(Date.now() / 1000 - epochSeconds));
  if (s < 60) return 'just now';
  const units = [['minute', 60], ['hour', 3600], ['day', 86400], ['month', 2592000], ['year', 31536000]];
  let label = 'just now';
  for (const [name, secs] of units) {
    if (s < secs) break;
    const n = Math.floor(s / secs);
    label = `${n} ${name}${n === 1 ? '' : 's'} ago`;
  }
  return label;
}

function _wsIconBtn(title, svg, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'icon-btn';
  b.title = title;
  b.innerHTML = svg;
  b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
  return b;
}

const _WS_REVEAL_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/></svg>';
const _WS_FORGET_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';

function _wsRow(entry) {
  const row = document.createElement('div');
  row.className = 'ws-row' + (entry.path === _selectedWs ? ' selected' : '');
  row.tabIndex = 0;
  row.setAttribute('role', 'option');
  row.setAttribute('aria-selected', entry.path === _selectedWs ? 'true' : 'false');
  row.dataset.path = entry.path;

  const main = document.createElement('div');
  main.className = 'ws-main';
  const name = document.createElement('div');
  name.className = 'ws-name';
  name.textContent = entry.label;
  const path = document.createElement('div');
  path.className = 'ws-path';
  path.title = entry.path;
  // The RTL trick clips the front of the path; bidi marks keep the text itself
  // reading left-to-right so separators don't get reordered.
  path.textContent = '‪' + entry.path + '‬';
  main.appendChild(name);
  main.appendChild(path);

  const meta = document.createElement('div');
  meta.className = 'ws-meta';
  const when = document.createElement('span');
  when.textContent = relativeTime(entry.opened_at);
  meta.appendChild(when);
  if (entry.message_count > 0) {
    const chat = document.createElement('span');
    chat.className = 'chip';
    chat.textContent = `${entry.message_count} msg`;
    chat.title = 'This folder has a saved chat that will be restored';
    meta.appendChild(chat);
  }

  const actions = document.createElement('div');
  actions.className = 'ws-actions';
  actions.appendChild(_wsIconBtn('Reveal in file manager', _WS_REVEAL_SVG,
    () => pywebview.api.reveal_in_finder(entry.path)));
  actions.appendChild(_wsIconBtn(
    'Forget this folder (removes it from the list and its saved chat; does NOT delete the folder)',
    _WS_FORGET_SVG, () => forgetWorkspace(entry.path)));

  row.appendChild(main);
  row.appendChild(meta);
  row.appendChild(actions);

  row.addEventListener('click', () => selectWorkspace(entry.path));
  row.addEventListener('dblclick', () => { selectWorkspace(entry.path); startSession(); });
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); selectWorkspace(entry.path); startSession(); }
  });
  return row;
}

function selectWorkspace(path) {
  _selectedWs = path;
  $('startSessionBtn').disabled = !path;
  [...$('recentList').children].forEach(el => {
    const on = el.dataset.path === path;
    el.classList.toggle('selected', on);
    el.setAttribute('aria-selected', on ? 'true' : 'false');
  });
}

function renderRecent() {
  const q = $('recentFilter').value.trim().toLowerCase();
  const shown = q
    ? _recent.filter(r => r.label.toLowerCase().includes(q) || r.path.toLowerCase().includes(q))
    : _recent;

  const list = $('recentList');
  list.innerHTML = '';
  shown.forEach(r => list.appendChild(_wsRow(r)));

  // The empty state distinguishes "nothing yet" from "nothing matched", which a
  // single blank pane would not.
  const noneAtAll = _recent.length === 0;
  $('recentEmpty').classList.toggle('hidden', !noneAtAll);
  $('recentEmpty').classList.toggle('flex', noneAtAll);
  list.classList.toggle('hidden', noneAtAll);
  $('recentCount').textContent = noneAtAll
    ? 'no folders yet'
    : (q ? `${shown.length} of ${_recent.length} folders` : `${_recent.length} folder${_recent.length === 1 ? '' : 's'}`);

  // Keep a valid selection: if the highlighted row got filtered away, move to
  // the first visible one so Enter/Open always does something sensible.
  if (!shown.some(r => r.path === _selectedWs)) {
    selectWorkspace(shown.length ? shown[0].path : null);
  }
}

async function loadStartScreen() {
  try {
    const res = await pywebview.api.get_projects();
    _recent = (res && res.recent) || [];
    _selectedWs = (res && res.last && _recent.some(r => r.path === res.last))
      ? res.last
      : (_recent[0] ? _recent[0].path : null);
    renderRecent();
    selectWorkspace(_selectedWs);
  } catch (e) {
    $('startError').textContent = 'Failed to load: ' + e;
  }
}

// Move the highlight by `delta` rows within the currently filtered list.
function moveWsSelection(delta) {
  const rows = [...$('recentList').children];
  if (!rows.length) return;
  const i = rows.findIndex(el => el.dataset.path === _selectedWs);
  const next = Math.min(rows.length - 1, Math.max(0, (i < 0 ? 0 : i + delta)));
  selectWorkspace(rows[next].dataset.path);
  rows[next].scrollIntoView({ block: 'nearest' });
}

async function forgetWorkspace(path) {
  $('startError').textContent = '';
  try {
    const res = await pywebview.api.delete_workspace(path);
    if (res && !res.ok) { $('startError').textContent = res.error || 'Could not forget that folder.'; return; }
    await loadStartScreen();
  } catch (e) {
    $('startError').textContent = '' + e;
  }
}

async function startSession() {
  $('startError').textContent = '';
  if (!_selectedWs) { $('startError').textContent = 'Select a workspace folder first.'; return; }
  const btn = $('startSessionBtn'); btn.disabled = true; btn.textContent = 'Starting sandbox…';
  try {
    const res = await pywebview.api.start_session(_selectedWs);
    if (!res.ok) $('startError').textContent = res.error || 'Failed to start session.';
  } catch (e) {
    $('startError').textContent = '' + e;
  } finally {
    btn.disabled = false; btn.textContent = 'Open';
  }
}

// Pick a NEW workspace folder from the device (native dialog), mount it into the
// container, then start the session on it. The picked folder is the project root.
async function pickWorkspaceAndStart() {
  $('startError').textContent = '';
  const btn = $('openFolderBtn');
  const prev = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Selecting + mounting…'; }
  try {
    const res = await pywebview.api.select_workspace();   // native picker + bind-mount
    if (res && res.cancelled) return;
    if (!res || !res.ok) { $('startError').textContent = (res && res.error) || 'Could not select folder.'; return; }
    await loadStartScreen();
    selectWorkspace(res.path);
    await startSession();
  } catch (e) {
    $('startError').textContent = '' + e;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = prev; }
  }
}

// ---------- import from folder ----------
function toggleImportBox() {
  const box = $('importFolderBox');
  const showing = box.classList.contains('hidden');
  box.classList.toggle('hidden', !showing);
  box.classList.toggle('flex', showing);
}

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
    toggleImportBox();
    $('importSourcePath').value = '';
    $('importProjectNameInput').value = '';
  } catch (e) {
    $('startError').textContent = '' + e;
  } finally {
    btn.disabled = false; btn.textContent = 'import & copy in';
  }
}

// ---------- LLM provider settings (multiple providers + fallback order) ----------
let _llmProviders = [];        // preset metadata from the backend
let _llmConfigs = [];          // ordered list of saved providers (order = fallback priority)
let _llmActiveProvider = null; // provider selected in the edit form
let _llmEditingId = null;      // id being edited in the form, or null when adding
let _llmDragId = null;         // id of the row currently being dragged
let _llmSelectedId = null;     // id highlighted in the master column

function _llmProvider(id) { return _llmProviders.find(p => p.id === id) || null; }

async function openLlmModal() {
  $('llmError').textContent = '';
  $('llmListStatus').textContent = '';
  $('llmModal').classList.remove('hidden');
  llmShowList();
  try {
    const res = await pywebview.api.get_llm_configs();
    if (!res || !res.ok) {
      _llmStatusKind('error');
      $('llmListStatus').textContent = (res && res.error) || 'Failed to load LLM configs.';
      return;
    }
    _llmProviders = res.providers || [];
    _llmConfigs = (res.configs || []).map(c => ({ ...c }));
    renderLlmList();
  } catch (e) {
    _llmStatusKind('error');
    $('llmListStatus').textContent = '' + e;
  }
}

// The status line now lives in the SHARED modal footer, so replacing its
// className (as this used to) also stripped its layout classes. Set only the
// colour and leave the rest of the class list alone.
function _llmStatusKind(kind) {
  const el = $('llmListStatus');
  el.classList.remove('text-term-red', 'text-term-green', 'text-term-muted');
  el.classList.add(kind === 'error' ? 'text-term-red'
    : kind === 'ok' ? 'text-term-green' : 'text-term-muted');
}

function closeLlmModal() { $('llmModal').classList.add('hidden'); }

// ----- switch between the list view and the add/edit form -----
// The panel is master-detail now: the provider list is ALWAYS visible on the
// left, and the right column shows either the edit form or a placeholder. These
// two functions therefore toggle the DETAIL column (and which footer buttons
// apply), not two mutually exclusive full-panel views.
function llmShowList() {
  $('llmModalTitle').textContent = 'LLM Providers';
  $('llmEditView').style.display = 'none';
  $('llmEmptyDetail').style.display = 'flex';
  $('llmEditFoot').style.display = 'none';
  $('llmDoneBtn').style.display = '';
  $('llmError').textContent = '';
  _llmSelectedId = null;
  _markSelectedProvider();
}
function llmShowEdit() {
  $('llmModalTitle').textContent = _llmEditingId ? 'Edit provider' : 'Add provider';
  $('llmEditView').style.display = 'block';
  $('llmEmptyDetail').style.display = 'none';
  $('llmEditFoot').style.display = 'flex';
  $('llmDoneBtn').style.display = 'none';
  llmShowModelPane('text');
  _llmSelectedId = _llmEditingId;
  _markSelectedProvider();
}

// Text / Vision tabs inside the Models section.
function llmShowModelPane(which) {
  const text = which !== 'vision';
  $('llmTextPane').style.display = text ? '' : 'none';
  $('llmVisionPane').style.display = text ? 'none' : '';
  $('llmTabText').classList.toggle('active', text);
  $('llmTabVision').classList.toggle('active', !text);
}

function _markSelectedProvider() {
  [...$('llmList').children].forEach(el =>
    el.classList.toggle('selected', el.dataset.id === _llmSelectedId));
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
  // Narrow master column: rank + name on one line, a compact summary beneath,
  // actions revealed on hover. The old row put edit/remove buttons inline and
  // spelled every model out, which no longer fits.
  row.className = 'llm-prow' + (c.id === _llmSelectedId ? ' selected' : '');
  row.dataset.id = c.id;
  row.draggable = true;
  row.title = 'Click to edit · drag ⠿ to change fallback priority';

  const handle = document.createElement('span');
  handle.textContent = '⠿';
  handle.title = 'drag to reorder';
  handle.className = 'text-term-muted shrink-0';
  handle.style.cursor = 'grab';
  row.appendChild(handle);

  // Explicit priority number: "top is primary" is much easier to read when the
  // position is stated rather than inferred from the order.
  const rank = document.createElement('span');
  rank.className = 'llm-prow-rank';
  rank.textContent = String(idx + 1);
  row.appendChild(rank);

  const mid = document.createElement('div');
  mid.className = 'min-w-0';
  mid.style.flex = '1 1 auto';

  const title = document.createElement('div');
  title.className = 'truncate text-term-text';
  title.textContent = c.name || label;
  if (idx === 0) {
    const badge = document.createElement('span');
    badge.textContent = 'primary';
    badge.className = 'chip ml-2';
    title.appendChild(badge);
  }

  const keys = Array.isArray(c.api_keys) && c.api_keys.length ? c.api_keys : (c.api_key ? [c.api_key] : []);
  const models = Array.isArray(c.models) && c.models.length ? c.models : (c.model ? [c.model] : []);
  const vision = Array.isArray(c.vision_models) ? c.vision_models : (c.vision_model ? [c.vision_model] : []);

  const sub = document.createElement('div');
  sub.className = 'truncate text-term-muted';
  sub.style.fontSize = 'var(--text-2xs)';
  // Counts, not a full model list: the detail pane shows the ladder itself.
  const parts = [label];
  parts.push(models.length ? `${models.length} model${models.length === 1 ? '' : 's'}` : 'default model');
  if (vision.length) parts.push(`${vision.length} vision`);
  if (prov && prov.requires_key) {
    parts.push(keys.length ? `${keys.length} key${keys.length === 1 ? '' : 's'}` : '⚠ no key');
  }
  sub.textContent = parts.join(' · ');
  sub.title = models.join(', ');

  mid.appendChild(title);
  mid.appendChild(sub);
  row.appendChild(mid);

  const actions = document.createElement('div');
  actions.className = 'ws-actions';
  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.textContent = '✕';
  delBtn.title = 'Remove this provider';
  delBtn.className = 'icon-btn';
  delBtn.addEventListener('click', (e) => { e.stopPropagation(); llmDeleteEntry(c.id); });
  actions.appendChild(delBtn);
  row.appendChild(actions);

  // The whole row is the edit affordance now — there is no separate edit button.
  row.addEventListener('click', () => llmEditEntry(c.id));

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
  // If the detail pane was editing the row just removed, fall back to the
  // placeholder rather than leaving a form bound to a deleted provider.
  if (_llmEditingId === id) { _llmEditingId = null; llmShowList(); }
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

// ---- text-model ladder editor (drag-to-reorder + per-model ⚙ settings) ----
// One row per model: [⠿ drag] [model id] [⚙] [✕]. The gear expands a panel with
// that model's REASONING control — the right control is auto-detected from the
// model name (GLM → thinking toggle, DeepSeek V4 → none/high/max effort,
// Nemotron 3 → off/reduced/full, o-series/GPT → an effort level, Claude → its
// thinking effort, DeepSeek R1 → nothing to configure) — plus a per-model "test"
// button that probes exactly this key pool + model + reasoning. Only the effort
// VALUE is stored (model_settings[model] = {reasoning_effort, tier}); how the
// effort is encoded on the wire is derived from the model name by the backend.
// `tier` is a free-form cost band (premium/standard/cheap, or a custom string a
// user hand-edited into llm_config.json) — '' means "derive from ladder position".

const _REASONING_FAMILIES = {
  openai: {
    label: 'OpenAI-style — reasoning_effort level',
    options: [['', 'Default'], ['off', 'Off'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['max', 'Max']],
  },
  thinking: {
    label: 'GLM / Z.AI — thinking toggle',
    options: [['', 'Default (on)'], ['off', 'Thinking off'], ['high', 'Thinking on']],
  },
  chat_template: {
    label: 'Qwen / DeepSeek V3 / Kimi — thinking toggle',
    options: [['', 'Default'], ['off', 'Thinking off'], ['high', 'Thinking on']],
  },
  deepseek_v4: {
    label: 'DeepSeek V4 — effort: none / high / max',
    options: [['', 'Default'], ['off', 'Off (none)'], ['high', 'High'], ['max', 'Max']],
  },
  nemotron3: {
    label: 'Nemotron 3 — thinking mode',
    options: [['', 'Default'], ['off', 'Off'], ['medium', 'Reduced (medium effort)'], ['high', 'Full thinking']],
  },
  system: {
    label: 'Nemotron — "detailed thinking" directive',
    options: [['', 'Default'], ['off', 'Off'], ['high', 'On']],
  },
  anthropic: {
    label: 'Claude — extended-thinking effort',
    options: [['', 'Default'], ['off', 'Off'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['max', 'Max']],
  },
  none: {
    label: 'always reasons — nothing to configure',
    options: null,
  },
};

// COST TIER for a model — the band a subagent asks for by name (see
// llm.model_ladder / llm._norm_tier). '' means "derive from ladder position",
// which is the default for every model until the user tags one explicitly.
const _MODEL_TIERS = [
  ['', 'auto (by position)'],
  ['premium', 'premium'],
  ['standard', 'standard'],
  ['cheap', 'cheap'],
];

// A tier already in the config that isn't one of the builtins (the user hand-
// edited llm_config.json with e.g. 'fast') must survive a round-trip through
// this select rather than silently resetting to blank.
function _tierOptions(current) {
  const opts = _MODEL_TIERS.slice();
  if (current && !opts.some(([v]) => v === current)) {
    opts.push([current, current + ' (custom)']);
  }
  return opts;
}

// JS mirror of llm.py's _auto_reasoning_style (+ the Anthropic protocol case).
function detectReasoningFamily(model) {
  const p = _llmProvider(_llmActiveProvider);
  if (p && p.protocol === 'anthropic') return 'anthropic';
  const m = (model || '').toLowerCase();
  if (m.includes('glm')) return 'thinking';
  if (m.includes('nemotron-3') || m.includes('nemotron3')) return 'nemotron3';
  if (m.includes('nemotron')) return 'system';
  if (m.includes('qwen3') || m.includes('qwen-3') || m.includes('kimi')) return 'chat_template';
  if (m.includes('deepseek')) {
    if (m.includes('r1')) return 'none';
    if (m.includes('v4')) return 'deepseek_v4';
    return 'chat_template';
  }
  return 'openai';
}

// Snap a stored effort onto the closest value this family's control offers, so a
// saved level from another family (or an old config) still lands on a real option.
function _coerceEffort(fam, eff) {
  if (!eff) return '';
  const def = _REASONING_FAMILIES[fam];
  if (!def || !def.options) return '';
  if (def.options.some(([v]) => v === eff)) return eff;
  if (eff === 'off') return 'off';
  if (fam === 'nemotron3') return (eff === 'minimal' || eff === 'low' || eff === 'medium') ? 'medium' : 'high';
  if (fam === 'deepseek_v4') return eff === 'max' ? 'max' : 'high';
  if (fam === 'openai' || fam === 'anthropic') return eff === 'minimal' ? 'low' : eff;
  return 'high'; // toggle families: any ON level is just "on"
}

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

// Read the model ladder back as {models, settings, open}: the ordered ids, the
// per-model {reasoning_effort, tier} overrides, and which rows have their ⚙
// panel open (so a re-render doesn't slam panels shut). Blank rows are dropped.
function _readModelLadder(containerId) {
  const models = [];
  const settings = {};
  const open = new Set();
  document.querySelectorAll('#' + containerId + ' .llm-model-row').forEach(row => {
    const id = row.querySelector('input.llm-list-input').value.trim();
    if (!id) return;
    models.push(id);
    const effSel = row.querySelector('select.llm-model-effort');
    const eff = effSel ? effSel.value : '';
    const tierSel = row.querySelector('select.llm-model-tier');
    const tier = tierSel ? tierSel.value : '';
    if (eff || tier) {
      settings[id] = {};
      if (eff) settings[id].reasoning_effort = eff;
      if (tier) settings[id].tier = tier;
    }
    if (row.classList.contains('open')) open.add(id);
  });
  return { models, settings, open };
}

let _llmModelDragIndex = null;

function _modelRow(containerId, val, i, s, openPanel) {
  const card = document.createElement('div');
  card.className = 'llm-model-row rounded-lg border border-term-line/70' + (openPanel ? ' open' : '');

  const top = document.createElement('div');
  top.className = 'flex items-center gap-1.5 p-1.5';

  const handle = document.createElement('span');
  handle.textContent = '⠿';
  handle.title = 'drag to reorder (top = primary)';
  handle.className = 'shrink-0 select-none px-0.5 text-term-muted';
  handle.style.cursor = 'grab';
  handle.draggable = true;
  handle.addEventListener('dragstart', (e) => {
    _llmModelDragIndex = i;
    card.style.opacity = '0.4';
    if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)); }
  });
  handle.addEventListener('dragend', () => { _llmModelDragIndex = null; card.style.opacity = ''; });
  card.addEventListener('dragover', (e) => e.preventDefault());
  card.addEventListener('drop', (e) => {
    e.preventDefault();
    if (_llmModelDragIndex === null || _llmModelDragIndex === i) return;
    const cur = _readModelLadder(containerId);
    if (_llmModelDragIndex >= cur.models.length) return;
    const [moved] = cur.models.splice(_llmModelDragIndex, 1);
    cur.models.splice(Math.min(i, cur.models.length), 0, moved);
    _llmModelDragIndex = null;
    _renderModelLadder(containerId, cur.models, cur.settings, cur.open);
  });

  const inp = document.createElement('input');
  inp.type = 'text'; inp.value = val; inp.autocomplete = 'off'; inp.spellcheck = false;
  inp.placeholder = _LLM_MODEL_OPTS.placeholder;
  inp.className = 'llm-list-input flex-1 min-w-0 rounded-lg border border-term-line bg-term-bg px-2.5 py-1.5 font-mono text-[11px] outline-none focus:border-term-cyan';
  // A rename can change the model family — rebuild so the ⚙ panel shows the
  // right reasoning control for the new name.
  inp.addEventListener('change', () => {
    const cur = _readModelLadder(containerId);
    _renderModelLadder(containerId, cur.models, cur.settings, cur.open);
  });

  const gear = _miniBtn('⚙', 'reasoning & connection test for this model', () => {
    const isOpen = card.classList.toggle('open');
    panel.classList.toggle('hidden', !isOpen);
  });
  const del = _miniBtn('✕', 'remove', () => {
    const cur = _readModelLadder(containerId);
    const idx = cur.models.indexOf(val);
    if (idx >= 0) cur.models.splice(idx, 1);
    delete cur.settings[val];
    _renderModelLadder(containerId, cur.models, cur.settings, cur.open);
  });

  top.append(handle, inp, gear, del);
  card.appendChild(top);

  // ---- ⚙ panel: auto-detected reasoning control + per-model test ----
  const panel = document.createElement('div');
  panel.className = 'flex flex-col gap-1.5 border-t border-term-line/60 p-2' + (openPanel ? '' : ' hidden');
  const fam = detectReasoningFamily(val);
  const famDef = _REASONING_FAMILIES[fam] || _REASONING_FAMILIES.openai;
  const famLine = document.createElement('div');
  famLine.className = 'text-[10px] text-term-muted';
  famLine.textContent = 'detected: ' + famDef.label;
  panel.appendChild(famLine);
  if (famDef.options) {
    const rowEl = document.createElement('div');
    rowEl.className = 'flex items-center gap-1.5';
    const lab = document.createElement('span');
    lab.className = 'shrink-0 text-[10px] uppercase tracking-wider text-term-muted';
    lab.textContent = 'reasoning';
    rowEl.append(lab, _miniSelect('llm-model-effort', famDef.options, _coerceEffort(fam, s.reasoning_effort)));
    panel.appendChild(rowEl);
  }
  const tierRow = document.createElement('div');
  tierRow.className = 'flex items-center gap-1.5';
  const tierLab = document.createElement('span');
  tierLab.className = 'shrink-0 text-[10px] uppercase tracking-wider text-term-muted';
  tierLab.textContent = 'cost tier';
  tierRow.append(tierLab, _miniSelect('llm-model-tier', _tierOptions(s.tier), s.tier || ''));
  panel.appendChild(tierRow);
  const testRow = document.createElement('div');
  testRow.className = 'flex min-w-0 items-center gap-2';
  testRow.appendChild(_miniBtn('test this model', 'send a tiny probe using this key pool + model + reasoning', () => _testModelRow(card)));
  const result = document.createElement('span');
  result.className = 'llm-model-test-result min-w-0 truncate text-[10.5px] text-term-muted';
  testRow.appendChild(result);
  panel.appendChild(testRow);
  card.appendChild(panel);
  return card;
}

function _renderModelLadder(containerId, models, modelSettings, openSet) {
  const host = $(containerId);
  if (!host) return;
  modelSettings = modelSettings || {};
  openSet = openSet || new Set();
  host.innerHTML = '';
  const list = models || [];
  list.forEach((val, i) => {
    host.appendChild(_modelRow(containerId, val, i, modelSettings[val] || {}, openSet.has(val)));
  });
  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'text-[11px] italic text-term-muted';
    empty.textContent = _LLM_MODEL_OPTS.emptyText;
    host.appendChild(empty);
  }
}

function _addModelLadder(containerId) {
  const cur = _readModelLadder(containerId);
  cur.models.push('');
  _renderModelLadder(containerId, cur.models, cur.settings, cur.open);
  const inputs = document.querySelectorAll('#' + containerId + ' input.llm-list-input');
  if (inputs.length) inputs[inputs.length - 1].focus();
}

// Probe exactly ONE rung: the shared key pool + this row's model + its reasoning.
async function _testModelRow(card) {
  const result = card.querySelector('.llm-model-test-result');
  const model = card.querySelector('input.llm-list-input').value.trim();
  if (!model) {
    result.className = 'llm-model-test-result min-w-0 truncate text-[10.5px] text-term-red';
    result.textContent = 'enter a model id first';
    return;
  }
  const effSel = card.querySelector('select.llm-model-effort');
  const eff = effSel ? effSel.value : '';
  const keys = _readListEditor('llmKeysList');
  const payload = {
    provider: _llmActiveProvider,
    api_keys: keys,
    api_key: keys[0] || '',
    models: [model],
    model,
    base_url: $('llmBaseUrl').value.trim(),
    reasoning_effort: (eff && eff !== 'off') ? eff : '',
  };
  const mt = $('llmMaxTokens').value.trim();
  if (mt) payload.max_tokens = parseInt(mt, 10);
  const temp = $('llmTemperature').value.trim();
  if (temp !== '') payload.temperature = parseFloat(temp);
  result.className = 'llm-model-test-result min-w-0 truncate text-[10.5px] text-term-muted';
  result.textContent = 'testing…';
  result.title = '';
  try {
    const res = await pywebview.api.test_llm_config(payload);
    if (res && res.ok) {
      result.className = 'llm-model-test-result min-w-0 truncate text-[10.5px] text-term-green';
      result.textContent = `✓ ${res.model}` + (res.reply ? ` — “${res.reply}”` : ' — reachable');
    } else {
      result.className = 'llm-model-test-result min-w-0 truncate text-[10.5px] text-term-red';
      result.textContent = '✕ ' + ((res && res.error) || 'connection failed');
      result.title = (res && res.error) || '';
    }
  } catch (e) {
    result.className = 'llm-model-test-result min-w-0 truncate text-[10.5px] text-term-red';
    result.textContent = '✕ ' + e;
  }
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
  $('llmTemperature').value = (use && use.temperature !== null && use.temperature !== undefined) ? use.temperature : '';
  $('llmContextWindow').value = (use && use.context_window) ? use.context_window : '';

  $('llmError').textContent = '';
}

function llmAddEntry() {
  _llmEditingId = null;
  renderLlmTabs();
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
  const temp = $('llmTemperature').value.trim();
  v.temperature = temp === '' ? null : parseFloat(temp);
  const ctx = $('llmContextWindow').value.trim();
  if (ctx) v.context_window = parseInt(ctx, 10);
  if (!v.name) v.name = (p && p.label) || v.provider;
  return v;
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
      _llmStatusKind('error');
      $('llmListStatus').textContent = (res && res.error) || 'Save failed.';
      return false;
    }
    const fresh = await pywebview.api.get_llm_configs();
    if (fresh && fresh.ok) {
      _llmConfigs = (fresh.configs || []).map(c => ({ ...c }));
      _llmProviders = fresh.providers || _llmProviders;
      renderLlmList();
    }
    _llmStatusKind('ok');
    $('llmListStatus').textContent = '✓ ' + (statusMsg || 'saved') + (res.primary
      ? ` — primary: ${res.primary.name} (${res.primary.label} · ${res.primary.model})`
      : ' — no providers left');
    refreshModelOptions();  // the composer's model list / primary may have changed
    if (session && res.primary) {
      renderSystem(`LLM providers saved. Primary: ${res.primary.name} · ${res.primary.model}. Fallbacks are used automatically if it errors.`);
    }
    return true;
  } catch (e) {
    _llmStatusKind('error');
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
  refreshModelOptions();  // populate the composer's model selector from the config
  try {
    const st = await pywebview.api.get_state();
    if (st && st.active) await pywebview.api.restore_session();
  } catch (e) { /* stay on the start screen */ }

  // "Open Folder…": pick a host folder at runtime, mount it, and start on it.
  $('openFolderBtn').addEventListener('click', pickWorkspaceAndStart);
  $('importFolderBtn').addEventListener('click', toggleImportBox);
  $('importBrowseBtn').addEventListener('click', browseImportFolder);
  $('importConfirmBtn').addEventListener('click', confirmImport);
  $('startSessionBtn').addEventListener('click', startSession);

  $('recentFilter').addEventListener('input', renderRecent);
  // Keyboard navigation over the recent list. Only while the picker is up, so it
  // can never swallow keys meant for the chat composer.
  document.addEventListener('keydown', (e) => {
    if ($('startScreen').classList.contains('hidden')) return;
    const typing = e.target === $('recentFilter');
    if (e.key === 'ArrowDown') { e.preventDefault(); moveWsSelection(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveWsSelection(-1); }
    else if (e.key === 'Enter' && !typing) { e.preventDefault(); startSession(); }
    else if (e.key === 'Enter' && typing) { e.preventDefault(); startSession(); }
    else if (e.key === '/' && !typing) { e.preventDefault(); $('recentFilter').focus(); }
    else if (e.key === 'Escape' && typing && $('recentFilter').value) {
      e.preventDefault(); $('recentFilter').value = ''; renderRecent();
    }
  });

  $('themeToggle').addEventListener('click', toggleTheme);
  $('themeToggleStart').addEventListener('click', toggleTheme);
  applyThemeIcons();

  $('modelSelectBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    if ($('modelMenu').classList.contains('hidden')) _openModelMenu(); else _closeModelMenu();
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('.composer-model')) _closeModelMenu(); });
  _syncModelTrigger();

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
  $('composerUploadBtn').addEventListener('click', uploadFiles);
  $('sidebarCollapseBtn').addEventListener('click', () => setSidebarCollapsed(true));
  $('sidebarExpandBtn').addEventListener('click', () => setSidebarCollapsed(false));
  applySidebarState();
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


  $('modelSelect').addEventListener('change', onModelSelected);
  $('llmSettingsBtn').addEventListener('click', openLlmModal);
  $('llmSettingsBtnStart').addEventListener('click', openLlmModal);
  $('llmModalClose').addEventListener('click', closeLlmModal);
  $('llmDoneBtn').addEventListener('click', closeLlmModal);
  $('llmAddBtn').addEventListener('click', llmAddEntry);
  $('llmTabText').addEventListener('click', () => llmShowModelPane('text'));
  $('llmTabVision').addEventListener('click', () => llmShowModelPane('vision'));
  $('llmBackBtn').addEventListener('click', () => { $('llmError').textContent = ''; llmShowList(); });
  $('llmSaveBtn').addEventListener('click', saveLlmEntry);
  $('llmKeysAdd').addEventListener('click', () => _addListItem('llmKeysList', _LLM_KEY_OPTS));
  $('llmModelsAdd').addEventListener('click', () => _addModelLadder('llmModelsList'));
  $('llmVisionAdd').addEventListener('click', () => _addListItem('llmVisionList', _LLM_VISION_OPTS));
  $('llmModal').addEventListener('click', (e) => { if (e.target.id === 'llmModal') closeLlmModal(); });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      $('fileViewer').classList.add('hidden');
      closeLlmModal();
      _closeModelMenu();
    }
  });
}

window.addEventListener('load', init);
