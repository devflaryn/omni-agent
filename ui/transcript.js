/* Renders omni events into turns. A turn = one user message followed by everything the model did until it stopped. */
import { el, esc, showName, fmtN, fmtBytes, fmtDuration, rollingRate, groupToolRuns, splitAttachments, hookInfo, toolLabel, editDiff, diffCounts, workSummary, isDuplicateUserMessage, agentResultInfo, agentTone, agentKindLabel } from "./lib.js";
import { mdBlocks, closeOpen, fenceLang } from "./markdown.js";
import { planBlocks, meterLabel, jumpShown, paintGap } from "./chat-live.js";

/** ui/highlight.js, once loaded. One import for every diff waiting on it. */
let highlighter = null, highlighterLoading = null;
const loadHighlighter = () => highlighterLoading ??= import("./highlight.js").then((m) => (highlighter = m), () => { highlighterLoading = null; });
/** Escaped text either way: plain until the highlighter is here. */
const highlight = (text, lang) => (highlighter ? highlighter.highlight(text, lang) : esc(text));
const languageFor = (path) => (highlighter ? highlighter.languageFor(path) : "plain");

// ------------------------------------------------------------- markdown on screen
let tplDoc = null, tpl = null;
/** A <template> of the current document, or null where there is none to parse with (the tests' small fake DOM). */
function template() {
  if (tplDoc !== globalThis.document) { tplDoc = globalThis.document; tpl = tplDoc?.createElement("template"); if (!tpl?.content) tpl = null; }
  return tpl;
}
const fromHtml = (html) => { const t = template(); t.innerHTML = html; return t.content.firstElementChild || document.createTextNode(""); };
/** Colours each code block of `root` with its fence's language, once the highlighter is here (it is not the first screen's). */
function colorCode(root) {
  if (!root.querySelectorAll) return;
  const todo = [...root.querySelectorAll("figure.code > pre > code:not(.hl)")];
  if (!todo.length) return;
  if (!highlighter) { loadHighlighter().then(() => { if (highlighter && root.isConnected) colorCode(root); }); return; }
  for (const code of todo) {
    code.classList.add("hl");
    const lang = fenceLang(code.dataset.lang);
    if (lang !== "plain") code.innerHTML = highlighter.highlight(code.textContent, lang);
  }
}
/**
 * Markdown into `box`, one element per top-level block. Blocks that did not change keep their DOM (a selection in them,
 * their colours); a live message is first closed off (closeOpen) so no raw syntax shows, and its new blocks fade in.
 */
function paint(box, text, live = false) {
  const next = mdBlocks(live ? closeOpen(text) : text);
  const old = box.mdBlocks || [];
  if (!template() || (!old.length && !live)) {
    // Drawn whole: a message that is not streaming, or no parser for blocks one by one.
    box.innerHTML = next.join("");
    box.mdBlocks = next; box.mdSource = text;
    colorCode(box);
    return;
  }
  const plan = planBlocks(old, next);
  const kids = box.children;
  for (const i of plan.replace) kids[i].replaceWith(fromHtml(next[i]));
  for (const i of plan.append) { const n = fromHtml(next[i]); if (live && n.classList) n.classList.add("md-in"); box.appendChild(n); }
  for (let r = 0; r < plan.remove; r++) box.lastElementChild?.remove();
  box.mdBlocks = next;
  box.mdSource = text;
  colorCode(box);
}
const COPIED_MS = 1500;
/** Copy on a code block: the code itself, and the button says so for a moment (no toast). One listener for every block. */
globalThis.document?.addEventListener("click", (e) => {
  const b = e.target.closest?.(".code-copy");
  if (!b) return;
  const code = b.closest("figure.code")?.querySelector("pre > code");
  if (!code) return;
  navigator.clipboard?.writeText(code.textContent).then(() => {
    b.classList.add("copied"); b.textContent = "Copied";
    clearTimeout(b.copiedTimer);
    b.copiedTimer = setTimeout(() => { b.classList.remove("copied"); b.textContent = "Copy"; }, COPIED_MS);
  }).catch(() => {});
});

const active = { view: null, timer: null };
const THINK_KEY = "omni.thinking.open";
let thinkOpen = false;
try { thinkOpen = localStorage.getItem(THINK_KEY) === "1"; } catch { /* storage unavailable */ }

const ICONS = {
  shell: `<svg viewBox="0 0 16 16"><path d="M3 4.5 6.5 8 3 11.5M8 12h5"/></svg>`,
  edit: `<svg viewBox="0 0 16 16"><path d="m10.5 3 2.5 2.5L6 12.5H3.5V10zM9 4.5l2.5 2.5"/></svg>`,
  read: `<svg viewBox="0 0 16 16"><path d="M4 2h5l3 3v9H4zM9 2v3h3M6 8h4M6 10.5h4"/></svg>`,
  search: `<svg viewBox="0 0 16 16"><circle cx="7" cy="7" r="4"/><path d="m10 10 3.5 3.5"/></svg>`,
  agent: `<svg viewBox="0 0 16 16"><path d="M8 2v2M4.5 4h7a1.5 1.5 0 0 1 1.5 1.5v5A1.5 1.5 0 0 1 11.5 12h-7A1.5 1.5 0 0 1 3 10.5v-5A1.5 1.5 0 0 1 4.5 4zM6 7.5h.01M10 7.5h.01M6 10h4"/></svg>`,
  browser: `<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.5"/><path d="M2.5 8h11M8 2.5c2 2 2 9 0 11M8 2.5c-2 2-2 9 0 11"/></svg>`,
  web: `<svg viewBox="0 0 16 16"><path d="M6.5 9.5 9.5 6.5M7 4.5l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1M9 11.5l-1 1a2.5 2.5 0 0 1-3.5-3.5l1-1"/></svg>`,
  mcp: `<svg viewBox="0 0 16 16"><path d="M5 2v3M11 2v3M3.5 5h9v2a4.5 4.5 0 0 1-9 0zM8 11.5V14"/></svg>`,
  other: `<svg viewBox="0 0 16 16"><path d="M9.5 3.5a3 3 0 0 0 3 3L6 13a1.4 1.4 0 0 1-2-2l6.5-6.5a3 3 0 0 0-1-1z"/></svg>`,
  work: `<svg viewBox="0 0 16 16"><path d="M3 5h10M3 8h10M3 11h7"/></svg>`,
  plan: `<svg viewBox="0 0 16 16"><path d="m2.5 4 1 1 2-2M2.5 8.5l1 1 2-2M7.5 4h6M7.5 8.5h6M3 12.5h.5M7.5 12.5h6"/></svg>`,
  compact: `<svg viewBox="0 0 16 16"><path d="M3 3h10v3H3zM3.5 6v6.5h9V6M6.5 9h3"/></svg>`,
  hook: `<svg viewBox="0 0 16 16"><path d="M12.5 8a4.5 4.5 0 1 1-1.3-3.2M12.5 2.5v2.8h-2.8"/></svg>`,
  chev: `<svg viewBox="0 0 16 16"><path d="m6 4 4 4-4 4"/></svg>`,
  copy: `<svg viewBox="0 0 16 16"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5v-2A1 1 0 0 0 9.5 2.5h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"/></svg>`,
  close: `<svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg>`,
  check: `<svg viewBox="0 0 16 16"><path d="m3.5 8.5 3 3 6-7"/></svg>`,
  down: `<svg viewBox="0 0 16 16"><path d="M8 3v10M3.5 8.5 8 13l4.5-4.5"/></svg>`,
};
const icon = (kind, cls = "ico") => `<span class="${cls}">${ICONS[kind] || ICONS.other}</span>`;

const makeView = (root, wrap, sid, { cwd, openAgent, loadToolOutput } = {}) =>
  ({ sid, root, wrap, cwd: cwd || "", harness: sid.split(":")[0], tools: new Map(), turn: null, stream: null, lastTs: 0, empty: null, lastUser: null, openAgent: openAgent || null, loadToolOutput: loadToolOutput || null, older: null });
/**
 * `openAgent(id)`: what an agent report card's Open button does (the app opens that agent's chat or log).
 * `loadToolOutput(toolId, at, max)`: fetches a tool's full output, which long ones arrive without.
 */
export function newView(root, wrap, sid, opts = {}) {
  root.innerHTML = "";
  const f = followOf(wrap); if (f && !opts.keepFollow) f.on = true;
  const view = makeView(root, wrap, sid, opts);
  active.view = view;
  if (!active.timer) active.timer = setInterval(() => {
    const v = active.view, t = v?.turn;
    if (!t || t.done) return;
    // Terminal-observed chats never send a status event: treat 30 s of silence after the last whole message as the end of the turn.
    if (!t.live && t.lastMsgTs && Date.now() - t.lastMsgTs > 30000) { closeTurn(v); return; }
    renderMeter(t); updateWorkLabels(t, false);
  }, 250);
  return view;
}
export function finish(view) { closeTurn(view); }

/**
 * The marker above the oldest page shown: `state` "more" (an older page exists; `onLoad` loads it), "loading",
 * "error", or null once the chat's start is on screen.
 */
export function setOlder(view, state, onLoad) {
  if (!state) { view.older?.remove(); view.older = null; return; }
  if (!view.older) {
    view.older = el("button", "older-mark");
    view.older.type = "button";
    // Above the chat's first message, below a fork / agent note.
    const notes = [...view.root.children].filter((n) => n.classList.contains("fork-note"));
    if (notes.length) notes[notes.length - 1].after(view.older); else view.root.prepend(view.older);
  }
  view.older.disabled = state === "loading";
  view.older.textContent = state === "loading" ? "Loading earlier messages…" : state === "error" ? "Could not load earlier messages · retry" : "Load earlier messages";
  view.older.onclick = state === "loading" ? null : onLoad || null;
}

/**
 * An older page of the chat (its events, oldest first) goes above what is shown. It renders on its own (its own
 * turns and tool rows), then moves in under the marker; the caller keeps the scroll position.
 */
export function prependHistory(view, events) {
  const box = el("div");
  const shadow = { scrollHeight: 0, scrollTop: 0, clientHeight: 0 };
  const v = makeView(box, shadow, view.sid, { cwd: view.cwd, openAgent: view.openAgent, loadToolOutput: view.loadToolOutput });
  for (const ev of events) applyEvent(v, ev);
  closeTurn(v);
  for (const [id, c] of v.tools) if (!view.tools.has(id)) { c.view = view; view.tools.set(id, c); }
  const nodes = [...box.childNodes];
  if (view.older) view.older.after(...nodes);
  else {
    const notes = [...view.root.children].filter((n) => n.classList.contains("fork-note"));
    if (notes.length) notes[notes.length - 1].after(...nodes); else view.root.prepend(...nodes);
  }
}
export function emptyNote(view, text) { view.empty = el("div", "divider"); view.empty.appendChild(el("span", null, text)); view.root.appendChild(view.empty); }
export function forkNote(view, { fromTitle, onOpen }) {
  const n = el("div", "fork-note");
  n.append("Forked from ", Object.assign(el("button", null, fromTitle || "the original chat"), { onclick: onOpen }), ". The history above was copied; the original stays untouched.");
  view.root.prepend(n);
}
/** Top of a background agent's chat: who started it, with a way back when that chat is known. */
export function agentNote(view, { kind, parentTitle, onOpen }) {
  const n = el("div", "fork-note");
  n.append(`Background ${agentKindLabel(kind)} started by `, onOpen ? Object.assign(el("button", null, parentTitle || "its parent chat"), { onclick: onOpen }) : "another chat", ". It works on its own; its report goes back to that chat.");
  view.root.prepend(n);
}

/**
 * Whether the chat stays on its newest line. Pure. Moving up at all stops following at once, and only coming back to the
 * bottom starts it again: a distance-from-the-bottom test alone pulls a reader back while they are scrolling up.
 */
export function nextFollow(on, { top, lastTop, gap }) {
  if (top < lastTop - 0.5) return false; // first: the start of a move up is still close to the bottom
  return gap < 24 ? true : on;
}
const follows = new WeakMap();
function followOf(w) {
  if (!w?.addEventListener) return null;
  let f = follows.get(w);
  if (f) return f;
  f = { on: true, held: false, lastTop: w.scrollTop, jump: null };
  follows.set(w, f);
  w.addEventListener("scroll", () => { f.on = nextFollow(f.on, { top: w.scrollTop, lastTop: f.lastTop, gap: w.scrollHeight - w.scrollTop - w.clientHeight }); f.lastTop = w.scrollTop; updateJump(w); }, { passive: true });
  // The intent arrives before the position moves: a stream's next word must not undo it.
  w.addEventListener("wheel", (e) => { if (e.deltaY < 0 && w.scrollTop > 0) f.on = false; }, { passive: true });
  w.addEventListener("touchstart", () => { f.held = true; }, { passive: true });
  for (const n of ["touchend", "touchcancel"]) w.addEventListener(n, () => { f.held = false; }, { passive: true });
  w.addEventListener("pointerdown", (e) => { if (e.target === w) f.held = true; }); // the scrollbar
  globalThis.window?.addEventListener("pointerup", () => { f.held = false; });
  // A smooth scroll can land a few pixels short of a bottom that moved while it ran: following, it finishes the job.
  w.addEventListener("scrollend", () => { if (f.on && !f.held) stick(w, f); });
  // Following survives anything that changes the scroller's size or its content's (the composer growing, a caption, an image,
  // code colouring in): the newest line stays in view. Scrolled up, only the button is updated.
  // Growth the reader caused (opening a tool row) is theirs to look at: it is not followed.
  for (const n of ["pointerdown", "keydown"]) w.addEventListener(n, () => { f.userAt = Date.now(); }, { passive: true });
  if (globalThis.ResizeObserver) {
    const ro = new ResizeObserver(() => { if (f.on && !f.held && Date.now() - (f.userAt || 0) > 600) stick(w, f); updateJump(w); });
    ro.observe(w);
    if (w.firstElementChild) ro.observe(w.firstElementChild);
  }
  jumpButton(w, f);
  return f;
}
function stick(w, f) {
  const bottom = w.scrollHeight - w.clientHeight;
  if (Math.abs(w.scrollTop - bottom) > 1) w.scrollTop = bottom;
  f.lastTop = w.scrollTop;
}
const reducedMotion = () => { try { return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches; } catch { return false; } };
/**
 * "Jump to latest": a round button over the bottom of the transcript, shown while the reader is more than 150 px up.
 * It lives in a zero-height sticky dock at the end of the scroller, so it sits over the transcript column whatever the layout.
 */
function jumpButton(w, f) {
  if (!globalThis.document || f.jump) return;
  const dock = el("div", "jump-dock");
  const b = el("button", "jump-latest");
  b.type = "button";
  b.title = "Jump to latest";
  b.setAttribute("aria-label", "Jump to latest");
  b.tabIndex = -1;
  b.innerHTML = `${ICONS.down}<span class="jump-dot"></span>`;
  b.onclick = () => {
    f.on = true;
    // A long way up is mostly skipped: only the last screen and a half glides, so the jump takes a moment, not seconds.
    const far = w.scrollHeight - w.clientHeight - w.scrollTop - w.clientHeight * 1.5;
    if (far > 0) w.scrollTop += far;
    f.lastTop = w.scrollTop;
    w.scrollTo({ top: w.scrollHeight, behavior: reducedMotion() ? "auto" : "smooth" });
  };
  dock.appendChild(b);
  w.appendChild(dock);
  f.jump = b;
}
function updateJump(w) {
  const f = follows.get(w);
  if (!f?.jump) return;
  const show = jumpShown(w.scrollHeight - w.scrollTop - w.clientHeight);
  if (f.jump.classList.contains("show") !== show) {
    f.jump.classList.toggle("show", show);
    f.jump.tabIndex = show ? 0 : -1;
    f.jump.setAttribute("aria-hidden", String(!show));
  }
  const t = active.view?.wrap === w ? active.view.turn : null;
  f.jump.classList.toggle("live", !!t && !t.done && t.live);
}
function scrollBottom(view) {
  const w = view.wrap, f = followOf(w);
  if (f && (!f.on || f.held)) { updateJump(w); return; }
  w.scrollTop = w.scrollHeight;
  if (f) { f.lastTop = w.scrollTop; updateJump(w); }
}
/** Is this chat following its newest line? (app.js, when it reloads a chat in place.) */
export const isFollowing = (wrap) => followOf(wrap)?.on ?? true;
/** The reader sent a message: whatever they were reading, the chat goes to its newest line and follows it again. */
export function followLatest(wrap) {
  const f = followOf(wrap);
  if (f) { f.on = true; f.held = false; }
  wrap.scrollTop = wrap.scrollHeight;
  if (f) { f.lastTop = wrap.scrollTop; updateJump(wrap); }
}

// ------------------------------------------------------------- turns
function openTurn(view, ts, live) {
  closeTurn(view);
  const t = { el: el("div", "turn"), meter: el("button", "meter"), reason: el("div", "reason"), body: el("div", "tbody"), startTs: ts || Date.now(), started: false, live: !!live, done: false, endTs: 0, lastMsgTs: 0,
    items: [], workEls: [], curWork: null, cards: [], rblocks: [], reasonOpen: thinkOpen, committedOut: 0, currentOut: 0, estChars: 0, reported: false, lastGroup: null, sawThinking: false, sawTool: false, samples: [], phase: "wait", lastDeltaTs: 0 };
  t.meter.hidden = true;
  t.mlabel = el("span", "mlabel"); t.mstats = el("span", "mstats");
  const mtext = el("span", "mtext");
  mtext.append(t.mlabel, t.mstats);
  t.meter.append(el("span", "dot"), mtext);
  t.meter.insertAdjacentHTML("beforeend", icon("chev", "chev"));
  // Only the words are announced (Writing…, Replied in 4s), not the seconds ticking beside them.
  t.mlabel.setAttribute("aria-live", "polite");
  t.reason.hidden = true;
  t.meter.onclick = () => { if (!t.rblocks.length) return; thinkOpen = t.reasonOpen = !t.reasonOpen; try { localStorage.setItem(THINK_KEY, thinkOpen ? "1" : "0"); } catch { /* ignore */ } applyReason(t); if (t.reasonOpen) t.reason.scrollTop = t.reason.scrollHeight; };
  // The status line and its reasoning drawer always sit below everything the model produced this turn.
  t.el.append(t.body, t.meter, t.reason);
  view.root.appendChild(t.el);
  view.turn = t;
  return t;
}
function turnOf(view, ts, live) {
  const t = view.turn && !view.turn.done ? view.turn : openTurn(view, ts, live);
  if (live) t.live = true;
  return t;
}
function closeTurn(view) {
  const t = view.turn;
  if (!t) return;
  closeStream(view);
  t.done = true;
  t.endTs = t.live ? Date.now() : t.lastMsgTs || Date.now();
  t.curWork = null;
  updateWorkLabels(t, true);
  if (t.body.childNodes.length || t.rblocks.length) t.el.appendChild(actionRow(t)); else t.el.remove();
  renderMeter(t);
  view.turn = null;
}
function markStarted(t) {
  if (t.started) return;
  t.started = true;
  if (t.live) t.startTs = Date.now();
}

// ------------------------------------------------------------- meter
/** A gap this long in the deltas reads as waiting: the label shimmers until words flow again. */
const QUIET_MS = 1500;
function renderMeter(t) {
  if (!t.started) return;
  const tokens = t.committedOut + (t.currentOut || Math.ceil(t.estChars / 4));
  const now = Date.now();
  const ms = (t.done ? t.endTs : now) - t.startTs;
  const run = t.done ? null : [...t.cards].reverse().find((c) => c.el.classList.contains("running"));
  // Rate over the last 5 s of streamed output only; while the model waits on a tool there is no rate to show.
  const m = meterLabel({ done: t.done, live: t.live, phase: t.phase, quiet: now - t.lastDeltaTs > QUIET_MS, running: run ? workSummary([run.label], true) : "", sawThinking: t.sawThinking, sawTool: t.sawTool, ms, tokens, rate: t.done ? 0 : rollingRate(t.samples, now) });
  if (t.mlabel.textContent !== m.label) t.mlabel.textContent = m.label;
  if (t.mstats.textContent !== m.stats) t.mstats.textContent = m.stats;
  t.meter.classList.toggle("waiting", m.waiting);
  const has = t.rblocks.length > 0;
  t.meter.title = `${t.reported ? "Tokens reported by the provider" : "Tokens estimated from streamed text (chars ÷ 4)"}${has ? ` · click to ${t.reasonOpen ? "hide" : "show"} reasoning` : t.done ? " · no reasoning was returned this turn" : ""}`;
  t.meter.classList.toggle("live", !t.done);
  t.meter.disabled = !has;
  t.meter.hidden = false;
  applyReason(t);
}
function applyReason(t) {
  const show = t.rblocks.length > 0 && t.reasonOpen;
  t.reason.hidden = !show;
  t.meter.classList.toggle("open", show);
}

// -------------------------------------------------------- work groups
function workGroup(t) {
  if (t.curWork) return t.curWork;
  const d = el("details", "work on");
  d.innerHTML = `<summary>${icon("work")}<span class="wlbl">Working…</span><span class="tdiff" hidden></span>${icon("chev", "chev")}</summary><div class="witems"></div>`;
  t.body.appendChild(d);
  const w = { el: d, ico: d.querySelector(".ico"), lbl: d.querySelector(".wlbl"), diff: d.querySelector(".tdiff"), items: d.querySelector(".witems"), cards: [], imgs: null };
  t.workEls.push(w);
  t.curWork = w;
  t.sawTool = true;
  return w;
}
/** Images a tool returned (a `read` of a PNG) sit under the work group as small boxes; click one for a large preview. */
function addImages(c, images) {
  const w = c.work;
  if (!w || !images?.length) return;
  if (!w.imgs) { w.imgs = el("div", "imgs"); w.el.insertAdjacentElement("afterend", w.imgs); }
  for (const im of images) {
    const b = el("button", "thumb");
    b.title = `${c.label.text} · click to preview`;
    const i = el("img");
    i.src = `data:${im.mimeType};base64,${im.data}`;
    i.alt = c.label.text;
    b.appendChild(i);
    b.onclick = () => openLightbox(i.src, c.label.text);
    w.imgs.appendChild(b);
  }
}
function openLightbox(src, caption) {
  document.querySelector(".lightbox")?.remove();
  const box = el("div", "lightbox");
  box.innerHTML = `<button class="lb-close icon-btn" title="Close (Esc)">${ICONS.close}</button><figure><img alt=""><figcaption></figcaption></figure>`;
  box.querySelector("img").src = src;
  box.querySelector("figcaption").textContent = caption || "";
  const close = () => { box.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  box.onclick = (e) => { if (e.target.tagName !== "IMG") close(); };
  document.addEventListener("keydown", onKey);
  document.body.appendChild(box);
}
function breakWork(t) { t.curWork = null; t.items.push({ kind: "text" }); }
function updateWorkLabels(t, final) {
  const segs = groupToolRuns(t.items).filter((s) => s.kind === "work");
  segs.forEach((s, i) => {
    const w = t.workEls[i]; if (!w) return;
    const kinds = w.cards.map((c) => c.label.kind);
    const live = s.open && !final;
    // A lone tool reads as its own row when collapsed; several fold into a verb summary.
    const single = w.cards.length === 1 && !live;
    if (single) fillLabel(w.lbl, w.diff, w.cards[0].label);
    else { w.lbl.textContent = workSummary(w.cards.map((c) => c.label), live); w.lbl.removeAttribute("title"); w.diff.hidden = true; }
    w.ico.innerHTML = ICONS[single ? w.cards[0].label.kind : kinds.length === 1 ? kinds[0] : "work"] || ICONS.work;
    w.el.classList.toggle("on", live);
    w.el.classList.toggle("err", w.cards.some((c) => c.el.classList.contains("err")));
  });
}

// --------------------------------------------------------------- tools
function toolCard(view, t, { toolId, name, args, ts }) {
  let c = toolId ? view.tools.get(toolId) : null;
  if (c) return c;
  const d = el("details", "tool running");
  d.innerHTML = `<summary>${icon("other")}<span class="tlbl"></span><span class="tdiff" hidden></span><span class="st">running</span>${icon("chev", "chev")}</summary><div class="io"><button class="io-copy icon-btn" title="Copy args + output">${ICONS.copy}</button><div class="dv" hidden></div><pre class="args"></pre><pre class="out" hidden></pre><button class="out-more" hidden></button></div>`;
  c = { el: d, ico: d.querySelector(".ico"), lbl: d.querySelector(".tlbl"), diff: d.querySelector(".tdiff"), dv: d.querySelector(".dv"), args: d.querySelector(".args"), out: d.querySelector(".out"), more: d.querySelector(".out-more"), st: d.querySelector(".st"), argText: "", toolId: toolId || null, pending: null, call: { name: name || "tool", args: undefined }, label: { kind: "other", text: name || "tool" }, item: { kind: "tool", startTs: ts || Date.now(), endTs: null } };
  const ioCopy = d.querySelector(".io-copy");
  if (ioCopy) ioCopy.onclick = (e) => { e.preventDefault(); e.stopPropagation(); const parts = [c.args.textContent, c.out.hidden ? "" : c.out.textContent].filter(Boolean); navigator.clipboard?.writeText(parts.join("\n\n")).catch(() => {}); };
  c.view = view; c.turn = t;
  d.addEventListener("toggle", () => { if (d.open && c.pending && !c.pending.loaded) loadOutput(c); });
  c.more.onclick = () => loadOutput(c, 0);
  setToolArgs(c, args);
  const w = workGroup(t);
  c.work = w;
  w.items.appendChild(d);
  w.cards.push(c);
  t.items.push(c.item);
  t.cards.push(c);
  if (toolId) view.tools.set(toolId, c);
  markStarted(t);
  updateWorkLabels(t, false);
  return c;
}
/** A row label: a file tool's verb and file name in their own shades, an edit's +added −removed beside it. */
function fillLabel(lbl, diffEl, label) {
  if (label.target) lbl.replaceChildren(el("span", "tverb", label.verb), " ", el("span", "tfile", showName(label.target)));
  else lbl.textContent = showName(label.text);
  lbl.title = showName(label.path || label.text);
  const show = label.kind === "edit" && !!(label.added || label.removed);
  diffEl.hidden = !show;
  if (show) diffEl.innerHTML = `${label.added ? `<b class="add">+${label.added}</b>` : ""}${label.removed ? `<b class="del">−${label.removed}</b>` : ""}`;
}
const DIFF_ROWS_MAX = 2000;
/** An edit's expanded view: the changed lines GitHub-style (context, green added, red removed) in place of the call's JSON. */
function renderDiff(c) {
  const d = c.label.kind === "edit" ? editDiff(c.call.name, c.call.args, c.resultDiff) : null;
  const rows = d?.rows.length ? d.rows : null;
  c.dv.hidden = !rows;
  // A file tool's row already says which file; its JSON stays only when there is nothing better to show.
  c.args.hidden = !!rows || (c.label.kind === "read" && !!c.label.target);
  if (!rows) return;
  // The highlighter is not the first screen's: a diff drawn before it has loaded is plain, and drawn again in colour once it has.
  if (!highlighter) loadHighlighter().then(() => { if (highlighter && c.dv.isConnected !== false) renderDiff(c); });
  const lang = languageFor(d.path);
  const sign = { add: "+", del: "−", ctx: " " };
  let html = "";
  for (const r of rows.slice(0, DIFF_ROWS_MAX)) {
    if (r.t === "hunk") html += `<div class="dr d-hunk"><span class="ln"></span><span class="ln"></span><span class="sg"></span><span class="cd">⋯</span></div>`;
    else if (r.t === "file") html += `<div class="dr d-file">${esc(showName(r.s))}</div>`;
    else html += `<div class="dr d-${r.t}"><span class="ln">${esc(r.o ?? "")}</span><span class="ln">${esc(r.n ?? "")}</span><span class="sg">${sign[r.t]}</span><span class="cd">${highlight(r.s, lang) || " "}</span></div>`;
  }
  if (rows.length > DIFF_ROWS_MAX) html += `<div class="dr d-more">… ${fmtN(rows.length - DIFF_ROWS_MAX)} more lines</div>`;
  c.dv.classList.toggle("nums", rows.some((r) => r.o != null || r.n != null));
  c.dv.innerHTML = `<div class="dv-head">${esc(showName(c.label.path || d.path))}</div><div class="dv-body"><div class="dv-rows">${html}</div></div>`;
}
function relabel(c) {
  c.label = toolLabel(c.call.name, c.call.args, c.view.cwd, c.resultDiff);
  // A diff too long to send ahead still gives the row its true counts.
  if (c.label.kind === "edit" && !c.resultDiff && c.diffStat) c.label = { ...c.label, ...diffCounts(c.diffStat) };
  c.ico.innerHTML = ICONS[c.label.kind] || ICONS.other;
  fillLabel(c.lbl, c.diff, c.label);
  renderDiff(c);
}
function setToolArgs(c, args) {
  if (typeof args === "object" && args) c.call.args = args;
  if (args !== undefined) c.args.textContent = (typeof args === "string" ? args : JSON.stringify(args, null, 2)) || "";
  relabel(c);
}
/** Characters of an output a row shows at first; "Show all" fetches the rest. */
const OUT_SHOWN = 30000;
function showOutput(c, text, isError, size = text.length, limit = OUT_SHOWN) {
  const out = limit ? text.slice(0, limit) : text;
  // A successful edit's own reply ("Edit applied successfully.") says nothing the diff does not; a longer one (diagnostics) stays.
  c.out.hidden = c.label.kind === "edit" && !isError && !c.dv.hidden && size < 80;
  c.out.textContent = out;
  c.more.hidden = size <= out.length;
  if (!c.more.hidden) c.more.textContent = `Show all ${fmtBytes(size)}`;
}
/**
 * A long output stays on the server until its row is opened (`max` characters of it; 0 for all of it), so a long
 * chat neither downloads nor holds every output it ever printed.
 */
async function loadOutput(c, max = OUT_SHOWN) {
  const p = c.pending;
  if (!p || p.busy || !c.view.loadToolOutput) return;
  p.busy = true;
  if (!p.loaded) { c.out.hidden = false; c.out.textContent = `Loading the output (${fmtBytes(p.size)})…`; }
  try {
    const r = await c.view.loadToolOutput(p.toolId, p.at, max);
    if (r.diff && r.diff !== c.resultDiff) { c.resultDiff = r.diff; relabel(c); }
    showOutput(c, r.text || "", r.isError, r.size ?? (r.text || "").length, max);
    p.loaded = true;
    if ((r.size ?? 0) <= (r.text || "").length) c.pending = null;
  } catch (e) { c.out.hidden = false; c.out.textContent = `Could not load the output: ${e.message}`; }
  finally { p.busy = false; }
}
/** `r`: a tool result as the page got it — `{ text, isError, images?, diff?, diffStat?, clipped?, at? }` (wire.mjs). */
function setToolResult(c, r, ts) {
  const { text, isError, images, diff } = r;
  if (diff && diff !== c.resultDiff) c.resultDiff = diff;
  c.diffStat = r.diffStat || null;
  relabel(c);
  if (r.clipped) {
    c.pending = { toolId: c.toolId, at: r.at, size: r.clipped, loaded: false };
    c.out.hidden = c.label.kind === "edit" && !isError && !c.dv.hidden;
    c.out.textContent = `Output: ${fmtBytes(r.clipped)} (loads when opened)`;
    c.more.hidden = true;
    if (c.el.open) loadOutput(c);
  } else { c.pending = null; showOutput(c, text || "", isError); }
  c.el.classList.remove("running"); c.el.classList.add(isError ? "err" : "ok");
  // The tool is done: the model has the turn again, and nothing has come from it yet.
  if (c.turn && !c.turn.done) c.turn.phase = "wait";
  if (images?.length && !c.gotImages) { c.gotImages = true; addImages(c, images); }
  if (c.item.endTs == null) c.item.endTs = ts || Date.now();
  updateWorkLabels(c.turn, false);
  const ms = c.item.endTs - c.item.startTs;
  c.st.textContent = isError ? "error" : ms >= 1000 ? fmtDuration(ms) : "";
}

// -------------------------------------------------------------- blocks
function reasonBlock(t) {
  const d = el("div", "rblock stream");
  t.reason.appendChild(d);
  t.rblocks.push(d);
  t.sawThinking = true;
  applyReason(t);
  return d;
}
function renderBlocks(view, t, blocks, ts) {
  for (const b of blocks) {
    if (b.type === "text") { breakWork(t); const d = el("div", "text"); paint(d, b.text); t.body.appendChild(d); markStarted(t); }
    else if (b.type === "thinking") { if (String(b.text || "").trim()) reasonBlock(t).textContent = b.text; markStarted(t); }
    else if (b.type === "tool_call") { const c = toolCard(view, t, { ...b, ts }); if (b.args !== undefined) setToolArgs(c, b.args); }
    else if (b.type === "tool_result") { const c = view.tools.get(b.toolId) || toolCard(view, t, { toolId: b.toolId, name: b.name || "result", ts }); setToolResult(c, b, ts); }
    else if (b.type === "image") { breakWork(t); const i = el("img"); i.src = `data:${b.mimeType};base64,${b.data}`; i.style.maxWidth = "100%"; t.body.appendChild(i); }
  }
}

// ----------------------------------------------------------- streaming
function openStream(view, t) { view.stream = { turn: t, parts: new Map() }; return view.stream; }
function streamPart(view, index, part, meta = {}) {
  const t = turnOf(view, Date.now(), true);
  if (!view.stream || view.stream.turn !== t) openStream(view, t);
  let p = view.stream.parts.get(index);
  if (p) return p;
  markStarted(t);
  if (part === "tool_call" || part === "tool_args") p = { part: "tool_call", card: toolCard(view, t, { toolId: meta.toolId, name: meta.name }), text: "" };
  else if (part === "thinking") { const d = reasonBlock(t); d.classList.add("on"); p = { part, el: d, stream: d, text: "", turn: t }; }
  // The live text is markdown from its first word: rendered, closed off, and repainted at most once a frame.
  else { breakWork(t); const d = el("div", "text live"); t.body.appendChild(d); p = { part: "text", el: d, stream: d, text: "", turn: t }; }
  view.stream.parts.set(index, p);
  return p;
}
/** A delta only marks its part dirty; the next animation frame paints every dirty part once. */
function queuePaint(view, p) {
  (view.dirty ??= new Set()).add(p);
  if (view.frame) return;
  const raf = globalThis.requestAnimationFrame;
  if (!raf) { flushPaints(view); return; }
  view.frame = raf(() => { view.frame = 0; flushPaints(view); });
}
function flushPaints(view) {
  const now = globalThis.performance?.now() ?? Date.now();
  let later = false;
  for (const p of view.dirty) {
    if (p.done) { view.dirty.delete(p); continue; }
    // A long message whose render got slow repaints less often (paintGap), never so rarely that it looks stuck.
    if (now - (p.lastPaint || 0) < (p.gap || 0)) { later = true; continue; }
    view.dirty.delete(p);
    const t0 = globalThis.performance?.now() ?? Date.now();
    if (p.part === "text") paint(p.el, p.text, true);
    else { p.el.textContent = p.text; if (!p.turn.reason.hidden) p.turn.reason.scrollTop = p.turn.reason.scrollHeight; }
    p.lastPaint = globalThis.performance?.now() ?? Date.now();
    p.gap = paintGap(p.lastPaint - t0);
  }
  if (active.view === view) scrollBottom(view);
  if (later) view.frame = globalThis.requestAnimationFrame(() => { view.frame = 0; flushPaints(view); });
}
function finishPart(p, finalText) {
  if (!p || p.done) return;
  if (p.part === "tool_call") { try { setToolArgs(p.card, JSON.parse(p.card.argText || "{}")); } catch { p.card.args.textContent = p.card.argText; } p.done = true; return; }
  p.stream.classList.remove("on");
  const text = finalText ?? p.text;
  // The same renderer as every frame before it: blocks that did not change stay, so the message does not jump as it ends.
  if (p.part === "text") { paint(p.stream, text); p.stream.classList.remove("live"); }
  else {
    p.stream.textContent = text;
    // A provider that streams an empty reasoning part (distilled models, hidden reasoning) leaves nothing to expand.
    if (!String(text).trim()) { const t = p.turn; p.stream.remove(); t.rblocks.splice(t.rblocks.indexOf(p.stream), 1); t.sawThinking = t.rblocks.length > 0; applyReason(t); }
  }
  p.done = true;
}
function closeStream(view) {
  if (!view.stream) return;
  for (const p of view.stream.parts.values()) finishPart(p);
  view.stream = null;
}

// --------------------------------------------------------------- cards
function actionRow(t) {
  const row = el("div", "actions");
  const copy = el("button", "icon-btn"); copy.innerHTML = ICONS.copy; copy.title = "Copy reply";
  // The reply as it was written (markdown), not the screen's text with its code headers and Copy buttons in it.
  copy.onclick = () => {
    const text = [...t.body.querySelectorAll(".text")].map((d) => d.mdSource ?? d.innerText).join("\n\n");
    navigator.clipboard?.writeText(text).then(() => {
      copy.innerHTML = ICONS.check; copy.classList.add("copied");
      clearTimeout(copy.copiedTimer);
      copy.copiedTimer = setTimeout(() => { copy.innerHTML = ICONS.copy; copy.classList.remove("copied"); }, COPIED_MS);
    }).catch(() => {});
  };
  row.appendChild(copy);
  return row;
}
function eventLine(view, kind, text) {
  const d = el("div", "event-line");
  d.innerHTML = `${icon(kind)}<span></span>`;
  d.lastChild.textContent = text;
  view.root.appendChild(d);
}
/** A background agent's report, delivered into this chat: a title line, the report folded under it. */
function agentResultCard(view, info, animate) {
  const tone = agentTone(info.status);
  const d = el("details", `ar-card${tone ? ` ${tone}` : ""}${animate ? " appear" : ""}`);
  const sum = el("summary");
  sum.innerHTML = icon("agent");
  sum.append(el("span", "ar-tag", "Agent report"), el("span", "ar-title", info.title));
  const meta = [info.kind ? agentKindLabel(info.kind) : "", info.status, info.elapsed].filter(Boolean).join(" · ");
  if (meta) sum.appendChild(el("span", "ar-meta", meta));
  if (info.id && view.openAgent) {
    const b = el("button", "ar-open", info.kind === "shell" ? "Log" : "Open");
    b.title = info.kind === "shell" ? `Show the log of job ${info.id}` : `Open the chat of agent ${info.id}`;
    b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); view.openAgent(info.id); };
    sum.appendChild(b);
  }
  sum.insertAdjacentHTML("beforeend", icon("chev", "chev"));
  const body = el("div", "ar-body text");
  paint(body, info.body);
  d.append(sum, body);
  view.root.appendChild(d);
}

// -------------------------------------------------------------- events
export function applyEvent(view, ev) {
  const animate = !!ev.live;
  if (view.empty && !["session", "status", "usage", "keeper"].includes(ev.kind)) { view.empty.remove(); view.empty = null; }
  switch (ev.kind) {
    case "block": {
      if (ev.phase === "message_start") { const t = turnOf(view, Date.now(), true); closeStream(view); openStream(view, t); markStarted(t); t.phase = "wait"; renderMeter(t); }
      else if (ev.phase === "start") streamPart(view, ev.index, ev.part, ev);
      else if (ev.phase === "end") { const p = view.stream?.parts.get(ev.index); if (p) { finishPart(p, ev.text); if (p.part === "tool_call" && ev.args !== undefined) setToolArgs(p.card, ev.args); } }
      break;
    }
    case "delta": {
      const p = streamPart(view, ev.index, ev.part, ev);
      const t = view.turn;
      t.estChars += (ev.delta || "").length;
      t.samples.push({ ts: Date.now(), chars: (ev.delta || "").length });
      if (t.samples.length > 2000) t.samples.splice(0, t.samples.length - 1000);
      t.lastDeltaTs = Date.now();
      const phase = p.part === "tool_call" ? "tool" : p.part === "thinking" ? "think" : "write";
      if (phase !== t.phase) { t.phase = phase; renderMeter(t); }
      if (p.part === "tool_call") { p.card.argText += ev.delta; p.card.args.textContent = p.card.argText; scrollBottom(view); }
      else { p.text += ev.delta; queuePaint(view, p); }
      break;
    }
    case "usage": if (ev.usage && view.turn) { view.turn.currentOut = ev.usage.output || 0; view.turn.reported = true; markStarted(view.turn); } break;
    case "msg": {
      if (ev.role === "assistant") {
        const t = turnOf(view, ev.ts, ev.live);
        t.lastMsgTs = Math.max(t.lastMsgTs, ev.ts || 0);
        if (ev.usage) { const g = ev.groupId || ev.id; if (g !== t.lastGroup) { t.lastGroup = g; t.committedOut += Math.max(ev.usage.output || 0, t.currentOut); t.currentOut = 0; t.estChars = 0; t.reported = true; } }
        if (view.stream && ev.live) {
          const parts = [...view.stream.parts.values()];
          for (const b of ev.blocks) {
            const p = parts.find((x) => (b.type === "tool_call" ? x.part === "tool_call" && x.card === view.tools.get(b.toolId) : x.part === b.type));
            if (p) { finishPart(p, b.text); if (b.type === "tool_call") setToolArgs(p.card, b.args); parts.splice(parts.indexOf(p), 1); }
            else renderBlocks(view, t, [b], ev.ts);
          }
          if (view.harness === "pi") closeStream(view);
        } else renderBlocks(view, t, ev.blocks, ev.ts);
        if (!ev.live) renderMeter(t);
      } else if (ev.role === "tool") {
        const t = turnOf(view, ev.ts, ev.live);
        for (const b of ev.blocks) { const c = view.tools.get(b.toolId) || toolCard(view, t, { toolId: b.toolId, name: b.name || "result", ts: ev.ts }); setToolResult(c, b, ev.ts); }
        t.lastMsgTs = Math.max(t.lastMsgTs, ev.ts || 0);
      } else if (ev.role === "user") {
        closeTurn(view);
        const raw = ev.blocks.map((b) => b.text || (b.type === "image" ? "[image]" : "")).filter(Boolean).join("\n");
        // A prompt Omni sent for the user (the goal hook, replayed from the session file) is a notice, never a bubble.
        const hook = hookInfo(raw);
        if (hook) { eventLine(view, "hook", hook.note); openTurn(view, ev.ts, !!ev.live); break; }
        // The same send reaches us as two events — the optimistic echo (id `u-<ts>`) and pi's
        // session-file entry (its own uuid) — which would otherwise draw two identical bubbles.
        // Collapse the second one (keeping the turn it already opened) instead of splitting the turn.
        if (isDuplicateUserMessage(view.lastUser, raw, ev.ts)) break;
        view.lastUser = { text: raw, ts: ev.ts || Date.now() };
        const m = el("div", `msg user${animate ? " appear" : ""}`);
        const { text, attachments } = splitAttachments(raw);
        const body = el("div", "body", text);
        m.appendChild(body);
        if (attachments.length) {
          const attach = el("div", "attach");
          for (const a of attachments) attach.appendChild(el("span", "ap", a));
          m.appendChild(attach);
        }
        view.root.appendChild(m);
        const t = openTurn(view, ev.ts, !!ev.live);
        // A message just sent: the status line shows at once (a shimmering "Working…") instead of nothing until the first word.
        if (ev.live) { markStarted(t); renderMeter(t); }
      } else {
        const text = ev.blocks.map((b) => b.text || "").join("\n");
        // An agent's report starts the parent's next turn (it is delivered as a follow-up), like a hook notice.
        const report = agentResultInfo(text);
        if (report) { closeTurn(view); agentResultCard(view, report, animate); openTurn(view, ev.ts, !!ev.live); scrollBottom(view); break; }
        const m = el("div", `msg system${animate ? " appear" : ""}`);
        m.textContent = text;
        (view.turn?.body || view.root).appendChild(m);
      }
      scrollBottom(view);
      break;
    }
    case "tool": {
      const t = turnOf(view, ev.ts, false);
      t.lastMsgTs = Math.max(t.lastMsgTs, ev.ts || 0);
      const c = toolCard(view, t, ev);
      if (ev.phase === "start" && ev.args !== undefined) setToolArgs(c, ev.args);
      if (ev.phase === "update") { c.out.hidden = false; c.out.textContent = (ev.text || "").slice(-30000); }
      if (ev.phase === "end") setToolResult(c, ev, ev.ts);
      scrollBottom(view);
      break;
    }
    case "status": if (ev.streaming === false) closeTurn(view); break;
    case "hook": { closeTurn(view); eventLine(view, "hook", ev.text || "A hook re-engaged the agent"); openTurn(view, ev.ts, true); scrollBottom(view); break; }
    case "compaction": { closeTurn(view); eventLine(view, "compact", "Context automatically compacted"); break; }
    case "run": {
      closeTurn(view);
      const line = el("div", `run-line${ev.isError ? " err" : ""}`);
      line.textContent = `${ev.isError ? "Claude Code stopped with an error" : "Finished"}${ev.turns ? ` · ${ev.turns} turn${ev.turns === 1 ? "" : "s"}` : ""}${ev.cost ? ` · $${ev.cost.toFixed(4)}` : ""}${ev.text && ev.isError ? `: ${ev.text}` : ""}`;
      view.root.appendChild(line);
      scrollBottom(view);
      break;
    }
    default: break;
  }
  if (ev.ts > view.lastTs) view.lastTs = ev.ts;
}
