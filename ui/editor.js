/* The code editor in the file pane: a transparent textarea (the real caret, selection, undo, IME and the
   phone keyboard) laid exactly over a <pre> holding the same text in colour, a line-number gutter beside it
   and a band on the caret's line. Edits made by keys (Tab, Enter, Ctrl+/) go through insertText so the
   browser's own undo keeps them. No wrapping: lines and numbers stay one to one. */
import { highlight } from "./highlight.js";

const HL_MAX = 600 * 1024; // past this the text is shown plain: colouring would lag typing
const COMMENT = { js: "//", ts: "//", c: "//", java: "//", kt: "//", cs: "//", go: "//", rs: "//", swift: "//", php: "//", dart: "//", json: "//", css: null, py: "#", sh: "#", ps1: "#", yaml: "#", toml: "#", ini: "#", docker: "#", make: "#", smali: "#", rb: "#", lua: "--", sql: "--", bat: "REM", md: null, html: null };
const BLOCK = { css: ["/*", "*/"], html: ["<!--", "-->"], md: ["<!--", "-->"] };
const OPEN = { "{": "}", "[": "]", "(": ")" };

/** Indent unit used by most indented lines: a tab, or the smallest run of spaces (2 or 4). */
export function detectIndent(text) {
  let tabs = 0, spaces = 0, min = 8;
  for (const m of String(text).slice(0, 200_000).matchAll(/^([ \t]+)\S/gm)) {
    if (m[1][0] === "\t") tabs++;
    else { spaces++; if (m[1].length >= 2 && m[1].length < min) min = m[1].length; }
  }
  if (tabs > spaces) return "\t";
  return " ".repeat(min === 8 ? 2 : min >= 4 ? 4 : min);
}

export function createEditor({ value = "", lang = "plain", readOnly = false, onChange, onSave, onCursor } = {}) {
  const root = document.createElement("div"); root.className = "code-ed";
  const gutter = document.createElement("div"); gutter.className = "ce-gutter";
  const nums = document.createElement("pre"); nums.className = "ce-nums"; nums.setAttribute("aria-hidden", "true");
  gutter.appendChild(nums);
  const main = document.createElement("div"); main.className = "ce-main";
  const band = document.createElement("div"); band.className = "ce-band";
  const pre = document.createElement("pre"); pre.className = "ce-hl"; pre.setAttribute("aria-hidden", "true");
  const code = document.createElement("code"); pre.appendChild(code);
  const ta = document.createElement("textarea"); ta.className = "ce-ta";
  for (const [k, v] of Object.entries({ spellcheck: "false", autocapitalize: "off", autocomplete: "off", autocorrect: "off", wrap: "off", "aria-label": "File contents" })) ta.setAttribute(k, v);
  main.append(band, pre, ta);
  root.append(gutter, main);

  let curLang = lang, lineCount = 0, raf = 0, slow = 0, paintMs = 0, indent = detectIndent(value);
  ta.value = value;
  ta.setSelectionRange(0, 0); // a new value leaves the caret at the end
  ta.readOnly = readOnly;
  root.classList.toggle("ro", readOnly);

  function paint() {
    raf = 0;
    const v = ta.value;
    const plain = v.length > HL_MAX || curLang === "plain";
    root.classList.toggle("plain", plain);
    const started = performance.now();
    code.innerHTML = plain ? "" : `${highlight(v, curLang)}\n`;
    paintMs = performance.now() - started;
    let n = 1;
    for (let i = v.indexOf("\n"); i !== -1; i = v.indexOf("\n", i + 1)) n++;
    if (n !== lineCount) {
      lineCount = n;
      let s = "";
      for (let i = 1; i <= n; i++) s += `${i}\n`;
      nums.textContent = s;
      gutter.style.width = `${Math.max(3, String(n).length) + 2}ch`;
    }
    sync(); cursor();
  }
  const schedule = () => {
    if (raf || slow) return;
    // A big or slow file is recoloured once typing pauses; a small one on the next frame.
    if (ta.value.length > 150_000 || paintMs > 30) slow = setTimeout(() => { slow = 0; paint(); }, Math.max(150, paintMs * 2));
    else raf = requestAnimationFrame(paint);
  };
  function sync() {
    const x = ta.scrollLeft, y = ta.scrollTop;
    pre.style.transform = `translate(${-x}px, ${-y}px)`;
    nums.style.transform = `translateY(${-y}px)`;
    placeBand();
  }
  const lh = () => parseFloat(getComputedStyle(ta).lineHeight) || 20;
  const padTop = () => parseFloat(getComputedStyle(ta).paddingTop) || 0;
  let line = 1, col = 1;
  function cursor() {
    const v = ta.value, at = ta.selectionStart;
    let l = 1, last = -1;
    for (let i = v.indexOf("\n"); i !== -1 && i < at; i = v.indexOf("\n", i + 1)) { l++; last = i; }
    line = l; col = at - last;
    placeBand();
    onCursor?.({ line, col, selected: Math.abs(ta.selectionEnd - ta.selectionStart), lines: lineCount });
  }
  function placeBand() { band.style.transform = `translateY(${padTop() + (line - 1) * lh() - ta.scrollTop}px)`; band.style.height = `${lh()}px`; }

  // --------------------------------------------------------------- editing
  /** Replace [from, to) with text the way typing would (one undo step), then select [selFrom, selTo]. */
  function replace(from, to, text, selFrom, selTo) {
    ta.focus();
    ta.setSelectionRange(from, to);
    let ok = false;
    try { ok = document.execCommand("insertText", false, text); } catch { /* */ }
    if (!ok) { ta.setRangeText(text, from, to, "end"); ta.dispatchEvent(new Event("input", { bubbles: true })); }
    if (selFrom != null) ta.setSelectionRange(selFrom, selTo ?? selFrom);
  }
  const lineStart = (v, i) => v.lastIndexOf("\n", i - 1) + 1;
  const lineEnd = (v, i) => { const e = v.indexOf("\n", i); return e === -1 ? v.length : e; };

  /** Indent or outdent every line the selection touches (Tab / Shift+Tab on several lines). */
  function shiftLines(out) {
    const v = ta.value, s = ta.selectionStart, e = ta.selectionEnd;
    const from = lineStart(v, s), to = lineEnd(v, e > s && v[e - 1] === "\n" ? e - 1 : e);
    const lines = v.slice(from, to).split("\n");
    let firstDelta = 0, total = 0;
    const next = lines.map((ln, i) => {
      let d;
      if (!out) { d = indent.length; ln = indent + ln; }
      else { const m = /^(\t| {1,4})/.exec(ln); const cut = m ? (m[1] === "\t" ? 1 : Math.min(m[1].length, indent === "\t" ? 4 : indent.length)) : 0; d = -cut; ln = ln.slice(cut); }
      if (i === 0) firstDelta = d;
      total += d;
      return ln;
    });
    replace(from, to, next.join("\n"), Math.max(from, s + firstDelta), e + total);
  }

  function toggleComment() {
    const v = ta.value, s = ta.selectionStart, e = ta.selectionEnd;
    const from = lineStart(v, s), to = lineEnd(v, e > s && v[e - 1] === "\n" ? e - 1 : e);
    const block = v.slice(from, to);
    const tok = COMMENT[curLang];
    if (!tok) {
      const [a, b] = BLOCK[curLang] || ["/*", "*/"];
      const lead = /^\s*/.exec(block)[0], trail = /\s*$/.exec(block)[0], body = block.slice(lead.length, block.length - trail.length);
      const out = body.startsWith(a) && body.endsWith(b) && body.length >= a.length + b.length
        ? lead + body.slice(a.length, body.length - b.length).replace(/^ /, "").replace(/ $/, "") + trail
        : `${lead}${a} ${body} ${b}${trail}`;
      return replace(from, to, out, from, from + out.length);
    }
    const lines = block.split("\n");
    const code = lines.filter((l) => l.trim());
    const all = code.length && code.every((l) => l.trimStart().startsWith(tok));
    const pad = Math.min(...code.map((l) => /^\s*/.exec(l)[0].length), Infinity);
    const out = lines.map((l) => {
      if (!l.trim()) return l;
      if (all) return l.replace(new RegExp(`^(\\s*)${tok.replace(/[/\\^$*+?.()|[\]{}-]/g, "\\$&")} ?`), "$1");
      return `${l.slice(0, pad)}${tok} ${l.slice(pad)}`;
    }).join("\n");
    replace(from, to, out, from, from + out.length);
  }

  ta.addEventListener("keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.altKey && e.key.toLowerCase() === "s") { e.preventDefault(); e.stopPropagation(); onSave?.(); return; }
    if (ta.readOnly) return;
    if (e.isComposing) return;
    const v = ta.value, s = ta.selectionStart, en = ta.selectionEnd;
    if (e.key === "Tab" && !mod && !e.altKey) {
      e.preventDefault();
      if (e.shiftKey || v.slice(s, en).includes("\n")) return shiftLines(e.shiftKey);
      return replace(s, en, indent, s + indent.length);
    }
    if (mod && (e.key === "/" || e.code === "Slash")) { e.preventDefault(); return toggleComment(); }
    if (mod && (e.key === "]" || e.key === "[")) { e.preventDefault(); return shiftLines(e.key === "["); }
    if (e.key === "Enter" && !mod && !e.altKey && !e.shiftKey) {
      // Keep the line's indent; one more after an opener (and the closer on its own line when the caret sits between a pair).
      e.preventDefault();
      const ls = lineStart(v, s), lead = /^[ \t]*/.exec(v.slice(ls, s))[0];
      const before = v.slice(ls, s).trimEnd().slice(-1), after = v[en];
      const opens = OPEN[before] || (curLang === "py" && before === ":") || (curLang === "lua" && /\b(then|do|function\b.*\))$/.test(v.slice(ls, s).trimEnd()));
      if (OPEN[before] && after === OPEN[before]) return replace(s, en, `\n${lead}${indent}\n${lead}`, s + 1 + lead.length + indent.length);
      const ins = `\n${lead}${opens ? indent : ""}`;
      return replace(s, en, ins, s + ins.length);
    }
    if (e.key === "Backspace" && s === en && s > 0 && indent !== "\t") {
      // Inside leading spaces, back to the previous indent stop.
      const ls = lineStart(v, s), lead = v.slice(ls, s);
      if (lead.length && /^ +$/.test(lead)) { e.preventDefault(); const cut = ((lead.length - 1) % indent.length) + 1; return replace(s - cut, s, "", s - cut); }
    }
  });
  ta.addEventListener("input", () => { schedule(); onChange?.(ta.value); });
  ta.addEventListener("scroll", sync, { passive: true });
  for (const ev of ["keyup", "click", "select", "focus"]) ta.addEventListener(ev, cursor);
  const onSel = () => { if (document.activeElement === ta) cursor(); };
  document.addEventListener("selectionchange", onSel);
  const ro = new ResizeObserver(() => sync());
  ro.observe(main);

  paint();
  return {
    el: root,
    get value() { return ta.value; },
    setValue(v, { keepView = true } = {}) {
      const { scrollTop, scrollLeft, selectionStart } = ta;
      ta.value = v; indent = detectIndent(v);
      if (keepView) { ta.scrollTop = scrollTop; ta.scrollLeft = scrollLeft; const at = Math.min(selectionStart, v.length); ta.setSelectionRange(at, at); }
      paint();
    },
    setLang(l) { curLang = l; paint(); },
    setReadOnly(ro) { ta.readOnly = ro; root.classList.toggle("ro", ro); },
    get readOnly() { return ta.readOnly; },
    focus() { ta.focus({ preventScroll: true }); },
    gotoLine(n) {
      const v = ta.value; let at = 0;
      for (let i = 1; i < n && at !== -1; i++) at = v.indexOf("\n", at) + 1 || -1;
      if (at < 0) at = v.length;
      ta.focus(); ta.setSelectionRange(at, at);
      ta.scrollTop = Math.max(0, (n - 1) * lh() - ta.clientHeight / 3);
      cursor();
    },
    get indent() { return indent === "\t" ? "Tabs" : `Spaces: ${indent.length}`; },
    get cursor() { return { line, col, lines: lineCount }; },
    refresh: paint,
    destroy() { document.removeEventListener("selectionchange", onSel); ro.disconnect(); cancelAnimationFrame(raf); clearTimeout(slow); root.remove(); },
  };
}
