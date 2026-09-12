/* Renders omni events into turns. A turn = one user message followed by everything the model did until it stopped. */
import { el, esc, md, fmtN, fmtDuration, tokRate, groupToolRuns, splitAttachments, toolLabel, workSummary } from "./lib.js";

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
  compact: `<svg viewBox="0 0 16 16"><path d="M3 3h10v3H3zM3.5 6v6.5h9V6M6.5 9h3"/></svg>`,
  chev: `<svg viewBox="0 0 16 16"><path d="m6 4 4 4-4 4"/></svg>`,
};
const icon = (kind, cls = "ico") => `<span class="${cls}">${ICONS[kind] || ICONS.other}</span>`;

export function newView(root, wrap, sid, { cwd } = {}) {
  root.innerHTML = "";
  const view = { sid, root, wrap, cwd: cwd || "", harness: sid.split(":")[0], tools: new Map(), turn: null, stream: null, lastTs: 0, empty: null };
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
export function emptyNote(view, text) { view.empty = el("div", "divider"); view.empty.appendChild(el("span", null, text)); view.root.appendChild(view.empty); }
export function forkNote(view, { fromTitle, onOpen }) {
  const n = el("div", "fork-note");
  n.append("Forked from ", Object.assign(el("button", null, fromTitle || "the original chat"), { onclick: onOpen }), ". The history above was copied; the original stays untouched.");
  view.root.prepend(n);
}

function scrollBottom(view) { const w = view.wrap; if (w.scrollHeight - w.scrollTop - w.clientHeight < 200) w.scrollTop = w.scrollHeight; }

// ------------------------------------------------------------- turns
function openTurn(view, ts, live) {
  closeTurn(view);
  const t = { el: el("div", "turn"), meter: el("button", "meter"), reason: el("div", "reason"), body: el("div", "tbody"), startTs: ts || Date.now(), started: false, live: !!live, done: false, endTs: 0, lastMsgTs: 0,
    items: [], workEls: [], curWork: null, cards: [], rblocks: [], reasonOpen: thinkOpen, committedOut: 0, currentOut: 0, estChars: 0, reported: false, lastGroup: null, sawThinking: false, sawTool: false };
  t.meter.hidden = true;
  t.meter.innerHTML = `<span class="dot"></span><span class="mtext"></span>${icon("chev", "chev")}`;
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
function renderMeter(t) {
  if (!t.started) return;
  const tokens = t.committedOut + (t.currentOut || Math.ceil(t.estChars / 4));
  const ms = (t.done ? t.endTs : Date.now()) - t.startTs;
  let text;
  if (!t.done) { text = `Thinking… ${fmtDuration(ms)} · ${fmtN(tokens)} tokens`; if (ms >= 2000 && tokens) text += ` · ${tokRate(tokens, ms)} tok/sec`; }
  else if (!t.live) text = `Replied in ${fmtDuration(ms)}${tokens ? ` · ${fmtN(tokens)} tokens` : ""}`;
  else text = `${t.sawThinking || !t.sawTool ? "Thought" : "Worked"} for ${fmtDuration(ms)}${tokens ? ` · ${fmtN(tokens)} tokens` : ""}`;
  t.meter.querySelector(".mtext").textContent = text;
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
  d.innerHTML = `<summary>${icon("work")}<span class="wlbl">Working…</span>${icon("chev", "chev")}</summary><div class="witems"></div>`;
  t.body.appendChild(d);
  const w = { el: d, ico: d.querySelector(".ico"), lbl: d.querySelector(".wlbl"), items: d.querySelector(".witems"), cards: [] };
  t.workEls.push(w);
  t.curWork = w;
  t.sawTool = true;
  return w;
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
    w.lbl.textContent = single ? w.cards[0].label.text : workSummary(kinds, live);
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
  d.innerHTML = `<summary>${icon("other")}<span class="tlbl"></span><span class="tdiff" hidden></span><span class="st">running</span>${icon("chev", "chev")}</summary><div class="io"><pre class="args"></pre><pre class="out" hidden></pre></div>`;
  c = { el: d, ico: d.querySelector(".ico"), lbl: d.querySelector(".tlbl"), diff: d.querySelector(".tdiff"), args: d.querySelector(".args"), out: d.querySelector(".out"), st: d.querySelector(".st"), argText: "", call: { name: name || "tool", args: undefined }, label: { kind: "other", text: name || "tool" }, item: { kind: "tool", startTs: ts || Date.now(), endTs: null } };
  c.view = view; c.turn = t;
  setToolArgs(c, args);
  const w = workGroup(t);
  w.items.appendChild(d);
  w.cards.push(c);
  t.items.push(c.item);
  t.cards.push(c);
  if (toolId) view.tools.set(toolId, c);
  markStarted(t);
  updateWorkLabels(t, false);
  return c;
}
function setToolArgs(c, args) {
  if (typeof args === "object" && args) c.call.args = args;
  c.label = toolLabel(c.call.name, c.call.args, c.view.cwd);
  c.ico.innerHTML = ICONS[c.label.kind] || ICONS.other;
  c.lbl.textContent = c.label.text;
  c.lbl.title = c.label.text;
  if (c.label.kind === "edit" && (c.label.added || c.label.removed)) { c.diff.hidden = false; c.diff.innerHTML = `<b class="add">+${c.label.added}</b><b class="del">−${c.label.removed}</b>`; }
  if (args === undefined) return;
  c.args.textContent = (typeof args === "string" ? args : JSON.stringify(args, null, 2)) || "";
}
function setToolResult(c, text, isError, ts) {
  c.out.hidden = false; c.out.textContent = (text || "").slice(0, 30000);
  c.el.classList.remove("running"); c.el.classList.add(isError ? "err" : "ok");
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
    if (b.type === "text") { breakWork(t); const d = el("div", "text"); d.innerHTML = md(b.text); t.body.appendChild(d); markStarted(t); }
    else if (b.type === "thinking") { if (String(b.text || "").trim()) reasonBlock(t).textContent = b.text; markStarted(t); }
    else if (b.type === "tool_call") { const c = toolCard(view, t, { ...b, ts }); if (b.args !== undefined) setToolArgs(c, b.args); }
    else if (b.type === "tool_result") { const c = view.tools.get(b.toolId) || toolCard(view, t, { toolId: b.toolId, name: b.name || "result", ts }); setToolResult(c, b.text, b.isError, ts); }
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
  else { breakWork(t); const d = el("div", "text stream on"); t.body.appendChild(d); p = { part: "text", el: d, stream: d, text: "" }; }
  view.stream.parts.set(index, p);
  return p;
}
function finishPart(p, finalText) {
  if (!p || p.done) return;
  if (p.part === "tool_call") { try { setToolArgs(p.card, JSON.parse(p.card.argText || "{}")); } catch { p.card.args.textContent = p.card.argText; } p.done = true; return; }
  p.stream.classList.remove("on");
  const text = finalText ?? p.text;
  if (p.part === "text") { p.stream.innerHTML = md(text); p.stream.classList.remove("stream"); }
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
  const copy = el("button", "icon-btn", "⧉"); copy.title = "Copy reply";
  copy.onclick = () => { const text = [...t.body.querySelectorAll(".text")].map((d) => d.innerText).join("\n\n"); navigator.clipboard?.writeText(text).catch(() => {}); };
  row.appendChild(copy);
  return row;
}
function eventLine(view, kind, text) {
  const d = el("div", "event-line");
  d.innerHTML = `${icon(kind)}<span></span>`;
  d.lastChild.textContent = text;
  view.root.appendChild(d);
}

// -------------------------------------------------------------- events
export function applyEvent(view, ev) {
  const animate = !!ev.live;
  if (view.empty && !["session", "status", "usage"].includes(ev.kind)) { view.empty.remove(); view.empty = null; }
  switch (ev.kind) {
    case "block": {
      if (ev.phase === "message_start") { const t = turnOf(view, Date.now(), true); closeStream(view); openStream(view, t); markStarted(t); }
      else if (ev.phase === "start") streamPart(view, ev.index, ev.part, ev);
      else if (ev.phase === "end") { const p = view.stream?.parts.get(ev.index); if (p) { finishPart(p, ev.text); if (p.part === "tool_call" && ev.args !== undefined) setToolArgs(p.card, ev.args); } }
      break;
    }
    case "delta": {
      const p = streamPart(view, ev.index, ev.part, ev);
      const t = view.turn;
      t.estChars += (ev.delta || "").length;
      if (p.part === "tool_call") { p.card.argText += ev.delta; p.card.args.textContent = p.card.argText; }
      else {
        p.text += ev.delta; p.stream.appendChild(el("span", "tok", ev.delta));
        if (p.part === "thinking" && !t.reason.hidden) t.reason.scrollTop = t.reason.scrollHeight;
      }
      scrollBottom(view);
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
        for (const b of ev.blocks) { const c = view.tools.get(b.toolId) || toolCard(view, t, { toolId: b.toolId, name: b.name || "result", ts: ev.ts }); setToolResult(c, b.text, b.isError, ev.ts); }
        t.lastMsgTs = Math.max(t.lastMsgTs, ev.ts || 0);
      } else if (ev.role === "user") {
        closeTurn(view);
        const m = el("div", `msg user${animate ? " appear" : ""}`);
        const raw = ev.blocks.map((b) => b.text || (b.type === "image" ? "[image]" : "")).filter(Boolean).join("\n");
        const { text, attachments } = splitAttachments(raw);
        const body = el("div", "body", text);
        m.appendChild(body);
        if (attachments.length) {
          const attach = el("div", "attach");
          for (const a of attachments) attach.appendChild(el("span", "ap", a));
          m.appendChild(attach);
        }
        view.root.appendChild(m);
        openTurn(view, ev.ts, !!ev.live);
      } else {
        const m = el("div", `msg system${animate ? " appear" : ""}`);
        m.textContent = ev.blocks.map((b) => b.text || "").join("\n");
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
      if (ev.phase === "end") setToolResult(c, ev.text, ev.isError, ev.ts);
      scrollBottom(view);
      break;
    }
    case "status": if (ev.streaming === false) closeTurn(view); break;
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
