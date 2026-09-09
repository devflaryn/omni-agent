/* Renders omni events into turns. A turn = one user message followed by everything the model did until it stopped. */
import { el, esc, md, fmtN, fmtDuration, tokRate, editedFiles, groupToolRuns, relPath, splitAttachments } from "./lib.js";

const active = { view: null, timer: null };

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
  const t = { el: el("div", "turn"), meter: el("button", "meter"), body: el("div", "tbody"), startTs: ts || Date.now(), started: false, live: !!live, done: false, endTs: 0, lastMsgTs: 0,
    items: [], workEls: [], curWork: null, cards: [], thinkEls: [], committedOut: 0, currentOut: 0, estChars: 0, reported: false, lastGroup: null, sawThinking: false, sawTool: false };
  t.meter.hidden = true;
  t.meter.onclick = () => { const open = !t.thinkEls[0]?.open; for (const d of t.thinkEls) d.open = open; };
  t.el.append(t.meter, t.body);
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
  const ed = editedFiles(t.cards.map((c) => c.call));
  if (ed.files.length) t.body.appendChild(editedCard(ed, view.cwd));
  if (t.body.childNodes.length) t.el.appendChild(actionRow(t)); else t.el.remove();
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
  t.meter.textContent = text;
  t.meter.title = `${t.reported ? "Tokens reported by the provider" : "Tokens estimated from streamed text (chars ÷ 4)"}${t.thinkEls.length ? " · click to show reasoning" : ""}`;
  t.meter.classList.toggle("live", !t.done);
  t.meter.disabled = !t.thinkEls.length;
  t.meter.hidden = false;
}

// -------------------------------------------------------- work groups
function workGroup(t) {
  if (t.curWork) return t.curWork;
  const d = el("details", "work on");
  d.innerHTML = `<summary><span class="wlbl">Working…</span><span class="chev">›</span></summary><div class="witems"></div>`;
  t.body.appendChild(d);
  const w = { el: d, lbl: d.querySelector(".wlbl"), items: d.querySelector(".witems") };
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
    const n = `${s.items.length} tool${s.items.length === 1 ? "" : "s"}`;
    const live = s.open && !final;
    w.lbl.textContent = live ? `Working… ${fmtDuration(s.durationMs)} · ${n}` : `Worked for ${fmtDuration(s.durationMs)} · ${n}`;
    w.el.classList.toggle("on", live);
  });
}

// --------------------------------------------------------------- tools
function toolCard(view, t, { toolId, name, args, ts }) {
  let c = toolId ? view.tools.get(toolId) : null;
  if (c) return c;
  const d = el("details", "tool running");
  d.innerHTML = `<summary><span class="name">${esc(name || "tool")}</span><span class="brief"></span><span class="st">running</span></summary><div class="io"><pre class="args"></pre><pre class="out" hidden></pre></div>`;
  c = { el: d, args: d.querySelector(".args"), out: d.querySelector(".out"), st: d.querySelector(".st"), brief: d.querySelector(".brief"), argText: "", call: { name: name || "tool", args: undefined }, item: { kind: "tool", startTs: ts || Date.now(), endTs: null } };
  if (args !== undefined) setToolArgs(c, args);
  workGroup(t).items.appendChild(d);
  t.items.push(c.item);
  t.cards.push(c);
  if (toolId) view.tools.set(toolId, c);
  markStarted(t);
  return c;
}
function setToolArgs(c, args) {
  const text = typeof args === "string" ? args : JSON.stringify(args, null, 2);
  if (typeof args === "object" && args) { c.call.args = args; c.brief.textContent = String(args.command || args.file_path || args.path || args.pattern || args.query || args.task || args.description || "").replace(/\s+/g, " ").slice(0, 120); }
  c.args.textContent = text || "";
}
function setToolResult(c, text, isError, ts) {
  c.out.hidden = false; c.out.textContent = (text || "").slice(0, 30000);
  c.el.classList.remove("running"); c.el.classList.add(isError ? "err" : "ok");
  c.st.textContent = isError ? "error" : "done";
  if (c.item.endTs == null) c.item.endTs = ts || Date.now();
}

// -------------------------------------------------------------- blocks
function thinkEl(t) {
  const d = el("details", "think");
  d.innerHTML = `<summary></summary><div class="stream"></div>`;
  t.body.appendChild(d);
  t.thinkEls.push(d);
  t.sawThinking = true;
  return d;
}
function renderBlocks(view, t, blocks, ts) {
  for (const b of blocks) {
    if (b.type === "text") { breakWork(t); const d = el("div", "text"); d.innerHTML = md(b.text); t.body.appendChild(d); markStarted(t); }
    else if (b.type === "thinking") { breakWork(t); thinkEl(t).querySelector(".stream").textContent = b.text; markStarted(t); }
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
  else if (part === "thinking") { breakWork(t); const d = thinkEl(t); d.querySelector(".stream").classList.add("on"); p = { part, el: d, stream: d.querySelector(".stream"), text: "" }; }
  else { breakWork(t); const d = el("div", "text stream on"); t.body.appendChild(d); p = { part: "text", el: d, stream: d, text: "" }; }
  view.stream.parts.set(index, p);
  return p;
}
function finishPart(p, finalText) {
  if (!p || p.done) return;
  if (p.part === "tool_call") { try { setToolArgs(p.card, JSON.parse(p.card.argText || "{}")); } catch { p.card.args.textContent = p.card.argText; } p.done = true; return; }
  p.stream.classList.remove("on");
  const text = finalText ?? p.text;
  if (p.part === "text") { p.stream.innerHTML = md(text); p.stream.classList.remove("stream"); } else p.stream.textContent = text;
  p.done = true;
}
function closeStream(view) {
  if (!view.stream) return;
  for (const p of view.stream.parts.values()) finishPart(p);
  view.stream = null;
}

// --------------------------------------------------------------- cards
function editedCard(ed, cwd) {
  const c = el("div", "edited");
  const head = el("div", "e-head");
  head.innerHTML = `<span class="e-title">Edited ${ed.files.length} file${ed.files.length === 1 ? "" : "s"}</span><span class="e-diff"><b class="add">+${ed.added}</b><b class="del">−${ed.removed}</b></span>`;
  const list = el("div", "e-list");
  ed.files.forEach((f, i) => { const r = el("div", "e-row"); if (i >= 3) r.hidden = true; r.innerHTML = `<span class="e-path">${esc(relPath(f.path, cwd))}</span><span class="e-diff"><b class="add">+${f.added}</b><b class="del">−${f.removed}</b></span>`; r.querySelector(".e-path").title = f.path; list.appendChild(r); });
  c.append(head, list);
  if (ed.files.length > 3) { const more = el("button", "e-more", `Show ${ed.files.length - 3} more files ▾`); more.onclick = () => { list.querySelectorAll(".e-row[hidden]").forEach((r) => { r.hidden = false; }); more.remove(); }; c.appendChild(more); }
  return c;
}
function actionRow(t) {
  const row = el("div", "actions");
  const copy = el("button", "icon-btn", "⧉"); copy.title = "Copy reply";
  copy.onclick = () => { const text = [...t.body.querySelectorAll(".text")].map((d) => d.innerText).join("\n\n"); navigator.clipboard?.writeText(text).catch(() => {}); };
  row.appendChild(copy);
  return row;
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
      else { p.text += ev.delta; p.stream.appendChild(el("span", "tok", ev.delta)); }
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
    case "compaction": { closeTurn(view); const d = el("div", "divider"); d.appendChild(el("span", null, "context compacted")); view.root.appendChild(d); break; }
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
