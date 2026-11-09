/* Markdown for the chat, the agent reports and the file preview. Written here rather than vendored: about 400 lines, no
   runtime dependency, and every byte of output is one this file chose. Pure (no DOM), so `node --test` imports it.

   Safety: the source is never trusted. Text is escaped as it is emitted; the only tags are the ones below; the only attributes
   are fixed classes (a table cell's alignment is one), a sanitised fence language, and an href that safeHref let through (http, https,
   mailto, with no quote, bracket or whitespace in it). There is no HTML pass-through and no image load.

   Streaming: `mdBlocks` gives one HTML string per top-level block, each a single element, so a live message can replace only
   the blocks that changed. `closeOpen` turns a half-arrived message into one that renders without raw syntax. */

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const MAX_DEPTH = 16; // quotes and lists deeper than this render as text: enough for any real answer, bounded for a hostile one

// ------------------------------------------------------------------ links
/** The href a link may carry, or null: http(s) and mailto only, and nothing that could leave the attribute. */
export function safeHref(raw) {
  const s = String(raw ?? "").trim();
  if (!/^(?:https?:\/\/|mailto:)/i.test(s)) return null;
  return /["<>`\\\s\u0000-\u001f\u007f]/.test(s) ? null : s;
}
const linkHtml = (href, inner) => `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${inner}</a>`;

// ------------------------------------------------------------------ fence languages
const FENCE_ALIAS = {
  javascript: "js", js: "js", jsx: "js", mjs: "js", cjs: "js", node: "js", typescript: "ts", ts: "ts", tsx: "ts",
  json: "json", jsonc: "json", json5: "json", python: "py", py: "py", python3: "py", py3: "py",
  bash: "sh", sh: "sh", shell: "sh", zsh: "sh", console: "sh", shellsession: "sh", terminal: "sh", fish: "sh",
  powershell: "ps1", ps1: "ps1", pwsh: "ps1", ps: "ps1", bat: "bat", batch: "bat", cmd: "bat",
  c: "c", h: "c", cpp: "c", "c++": "c", cc: "c", cxx: "c", hpp: "c", objc: "c", "objective-c": "c",
  java: "java", scala: "java", groovy: "java", kotlin: "kt", kt: "kt", kts: "kt", csharp: "cs", "c#": "cs", cs: "cs",
  go: "go", golang: "go", rust: "rs", rs: "rs", swift: "swift", php: "php", dart: "dart", lua: "lua", ruby: "rb", rb: "rb",
  sql: "sql", css: "css", scss: "css", sass: "css", less: "css", html: "html", xml: "html", svg: "html", vue: "html", svelte: "html",
  markdown: "md", md: "md", yaml: "yaml", yml: "yaml", toml: "toml", ini: "ini", cfg: "ini", conf: "ini", env: "ini", properties: "ini",
  diff: "diff", patch: "diff", smali: "smali", log: "log", dockerfile: "docker", docker: "docker", makefile: "make", make: "make",
};
/** A fence's language as ui/highlight.js names it ("plain" when it has none). */
export const fenceLang = (word) => FENCE_ALIAS[String(word || "").toLowerCase()] || "plain";

// ------------------------------------------------------------------ inline
const PUNCT = /[\p{P}\p{S}]/u;
const WS = /\s/u;
const isWs = (c) => c === "" || WS.test(c);
const isPunct = (c) => c !== "" && PUNCT.test(c);
const ESCAPABLE = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;
const LINK_SCAN = 2000; // how far a [ looks for its ]: bounded, so a line of [[[[ stays linear

/** Backtick runs of `s` by length, so a code span finds its closer without rescanning. */
function tickRuns(s) {
  const byLen = new Map();
  for (let i = 0; i < s.length;) {
    if (s[i] === "\\") { i += 2; continue; }
    if (s[i] !== "`") { i++; continue; }
    let j = i; while (s[j] === "`") j++;
    const n = j - i;
    if (!byLen.has(n)) byLen.set(n, []);
    byLen.get(n).push(i);
    i = j;
  }
  return byLen;
}
/** Where the run of n backticks after `from` starts, or -1. */
function nextRun(runs, n, from) {
  const list = runs.get(n);
  if (!list) return -1;
  while (list.length && list[0] < from) list.shift();
  return list.length ? list[0] : -1;
}
/** The `]` that closes the `[` at `at` (nested brackets counted, escapes and code skipped), or -1. */
function closeBracket(s, at) {
  let depth = 0;
  const end = Math.min(s.length, at + LINK_SCAN);
  for (let i = at; i < end; i++) {
    const c = s[i];
    if (c === "\\") { i++; continue; }
    if (c === "`") { let j = i; while (s[j] === "`") j++; const close = s.indexOf(s.slice(i, j), j); if (close < 0 || close > end) { i = j - 1; continue; } i = close + (j - i) - 1; continue; }
    if (c === "[") depth++;
    else if (c === "]" && --depth === 0) return i;
  }
  return -1;
}
/** `(url "title")` right after a link's `]`: `{ url, end }` (end just past the `)`) or null. Parentheses in the url may nest. */
function linkTarget(s, at) {
  if (s[at] !== "(") return null;
  let i = at + 1;
  while (s[i] === " ") i++;
  let url = "";
  if (s[i] === "<") { const j = s.indexOf(">", i); if (j < 0 || s.slice(i, j).includes("\n")) return null; url = s.slice(i + 1, j); i = j + 1; }
  else {
    let depth = 0;
    const start = i;
    for (; i < s.length && i < at + LINK_SCAN; i++) {
      const c = s[i];
      if (c === "\\") { i++; continue; }
      if (WS.test(c)) break;
      if (c === "(") depth++;
      else if (c === ")") { if (depth === 0) break; depth--; }
    }
    url = s.slice(start, i);
  }
  while (s[i] === " ") i++;
  if (s[i] === '"' || s[i] === "'") { const q = s[i]; const j = s.indexOf(q, i + 1); if (j < 0) return null; i = j + 1; while (s[i] === " ") i++; }
  if (s[i] !== ")") return null;
  return { url: url.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, "$1"), end: i + 1 };
}
const BARE_URL = /^(?:https?:\/\/|mailto:)[^\s<>"`]*/i;
/** A bare URL without the punctuation that ends the sentence around it, or a `)` it does not open. */
function trimUrl(u) {
  let s = u;
  for (;;) {
    const last = s[s.length - 1];
    if (/[.,:;!?'"*_~]/.test(last)) { s = s.slice(0, -1); continue; }
    if (last === ")" && (s.match(/\(/g) || []).length < (s.match(/\)/g) || []).length) { s = s.slice(0, -1); continue; }
    return s;
  }
}

/** Inline markdown → HTML. `links` false inside a link's own text (no link in a link). */
export function inline(src, links = true) {
  const s = String(src ?? "");
  const runs = tickRuns(s);
  const toks = []; // { t: "html", h } | { t: "delim", ch, n, orig, open, close, pre, post, active }
  let text = "";
  const flush = () => { if (text) { toks.push({ t: "html", h: esc(text).replace(/[ \t]*\n[ \t]*/g, "<br>") }); text = ""; } };
  const push = (h) => { flush(); toks.push({ t: "html", h }); };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\" && i + 1 < s.length && ESCAPABLE.test(s[i + 1])) { text += s[i + 1]; i += 2; continue; }
    if (c === "`") {
      let j = i; while (s[j] === "`") j++;
      const n = j - i;
      const close = nextRun(runs, n, j);
      if (close < 0) { text += s.slice(i, j); i = j; continue; }
      let code = s.slice(j, close).replace(/\n/g, " ");
      if (code.length > 2 && code[0] === " " && code[code.length - 1] === " " && code.trim()) code = code.slice(1, -1);
      push(`<code>${esc(code)}</code>`);
      i = close + n;
      continue;
    }
    if (c === "<" && links) {
      const m = /^<((?:https?:\/\/|mailto:)[^\s<>]*)>/i.exec(s.slice(i, i + LINK_SCAN));
      const href = m && safeHref(m[1]);
      if (href) { push(linkHtml(href, esc(m[1]))); i += m[0].length; continue; }
    }
    if ((c === "[" || (c === "!" && s[i + 1] === "[")) && links) {
      const at = c === "!" ? i + 1 : i;
      const close = closeBracket(s, at);
      const target = close > 0 ? linkTarget(s, close + 1) : null;
      if (target) {
        const label = s.slice(at + 1, close);
        const href = safeHref(target.url);
        const inner = inline(label, false);
        push(href ? linkHtml(href, inner || esc(target.url)) : inner);
        i = target.end;
        continue;
      }
    }
    if (links && (c === "h" || c === "H" || c === "m" || c === "M") && (i === 0 || /[\s(*_~]/.test(s[i - 1]))) {
      const m = BARE_URL.exec(s.slice(i, i + LINK_SCAN));
      if (m) {
        const u = trimUrl(m[0]);
        const href = /^(?:https?:\/\/|mailto:)./i.test(u) && safeHref(u);
        if (href) { push(linkHtml(href, esc(u))); i += u.length; continue; }
      }
    }
    if (c === "*" || c === "_" || c === "~") {
      let j = i; while (s[j] === c) j++;
      const n = j - i;
      const before = i ? s[i - 1] : "", after = j < s.length ? s[j] : "";
      const left = !isWs(after) && (!isPunct(after) || isWs(before) || isPunct(before));
      const right = !isWs(before) && (!isPunct(before) || isWs(after) || isPunct(after));
      let open = left, close = right;
      if (c === "_") { open = left && (!right || isPunct(before)); close = right && (!left || isPunct(after)); }
      if (c === "~" && n !== 2) { text += s.slice(i, j); i = j; continue; }
      flush();
      toks.push({ t: "delim", ch: c, n, orig: n, open, close, pre: "", post: "", active: true });
      i = j;
      continue;
    }
    text += c;
    i++;
  }
  flush();
  emphasis(toks);
  let out = "";
  for (const t of toks) out += t.t === "html" ? t.h : `${t.pre}${t.ch.repeat(t.n)}${t.post}`;
  return out;
}

/** CommonMark's delimiter pass, on a flat token list: a match adds tags to the opener's end and the closer's start. */
function emphasis(toks) {
  const bottom = new Map(); // (char, can-open, length % 3) → the lowest index still worth searching
  for (let k = 0; k < toks.length; k++) {
    const cl = toks[k];
    if (cl.t !== "delim" || !cl.close || !cl.active) continue;
    while (cl.n > 0) {
      const key = `${cl.ch}${cl.open ? 1 : 0}${cl.orig % 3}`;
      const floor = bottom.get(key) ?? -1;
      let o = -1;
      for (let m = k - 1; m > floor; m--) {
        const op = toks[m];
        if (op.t !== "delim" || !op.active || !op.open || op.ch !== cl.ch || op.n === 0) continue;
        if ((op.close || cl.open) && (op.orig + cl.orig) % 3 === 0 && !(op.orig % 3 === 0 && cl.orig % 3 === 0)) continue;
        o = m;
        break;
      }
      if (o < 0) { bottom.set(key, k - 1); break; }
      const op = toks[o];
      const use = cl.ch === "~" ? 2 : op.n >= 2 && cl.n >= 2 ? 2 : 1;
      const tag = cl.ch === "~" ? "del" : use === 2 ? "strong" : "em";
      op.n -= use; cl.n -= use;
      op.post = `<${tag}>${op.post}`;
      cl.pre = `${cl.pre}</${tag}>`;
      for (let m = o + 1; m < k; m++) if (toks[m].t === "delim") toks[m].active = false;
    }
  }
}

// ------------------------------------------------------------------ blocks
const RE = {
  blank: /^\s*$/,
  fence: /^( {0,3})(`{3,}|~{3,})(.*)$/,
  hr: /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/,
  heading: /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/,
  quote: /^ {0,3}>/,
  item: /^( {0,3})([-*+]|\d{1,9}[.)])([ \t]+|$)(.*)$/,
  sep: /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/,
};
const indentOf = (line) => { let n = 0; for (const c of line) { if (c === " ") n++; else if (c === "\t") n += 4 - (n % 4); else break; } return n; };
/** The line without its first `n` columns of indent (tabs count to the next stop of 4). */
function dedent(line, n) {
  let col = 0, i = 0;
  while (i < line.length && col < n && (line[i] === " " || line[i] === "\t")) { col += line[i] === "\t" ? 4 - (col % 4) : 1; i++; }
  return " ".repeat(Math.max(0, col - n)) + line.slice(i);
}
function isFenceOpen(line) {
  const m = RE.fence.exec(line);
  return !!m && !(m[2][0] === "`" && m[3].includes("`"));
}
/** Cells of a table row: split on pipes that are not escaped, the outer ones dropped. */
function cells(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const out = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "|") { cur += "|"; i++; continue; }
    if (s[i] === "|") { out.push(cur.trim()); cur = ""; continue; }
    cur += s[i];
  }
  out.push(cur.trim());
  return out;
}
function isTableStart(lines, i) {
  const head = lines[i], sep = lines[i + 1];
  // The delimiter row needs a pipe of its own, so "text\n---" stays a paragraph and a rule.
  if (sep == null || !head.includes("|") || !sep.includes("|") || !sep.includes("-") || !RE.sep.test(sep)) return false;
  return cells(head).length === cells(sep).length;
}
const startsBlock = (lines, i) => {
  const l = lines[i];
  return isFenceOpen(l) || RE.hr.test(l) || RE.heading.test(l) || RE.quote.test(l) || RE.item.test(l) || isTableStart(lines, i);
};

function codeBlock(info, body) {
  const word = (String(info || "").trim().split(/\s+/)[0] || "").replace(/[^\w#+.-]/g, "").slice(0, 32);
  const lang = esc(word);
  return `<figure class="code" data-lang="${lang}"><figcaption><span class="code-lang">${lang}</span><button class="code-copy" type="button" aria-label="Copy code">Copy</button></figcaption><pre><code data-lang="${lang}">${esc(body)}</code></pre></figure>`;
}

/** Lines → one HTML string per top-level block. */
function blocks(lines, depth) {
  const out = [];
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (RE.blank.test(line)) { i++; continue; }
    // Fenced code: to its closing fence, or to the end when it never closes.
    const f = RE.fence.exec(line);
    if (f && isFenceOpen(line)) {
      const indent = f[1].length, mark = f[2];
      const body = [];
      i++;
      while (i < n) {
        const c = new RegExp(`^ {0,3}${mark[0] === "`" ? "`" : "~"}{${mark.length},}[ \\t]*$`).exec(lines[i]);
        if (c) { i++; break; }
        body.push(dedent(lines[i], indent));
        i++;
      }
      out.push(codeBlock(f[3], body.join("\n")));
      continue;
    }
    if (RE.hr.test(line)) { out.push("<hr>"); i++; continue; }
    const h = RE.heading.exec(line);
    if (h) { const lvl = h[1].length; out.push(`<h${lvl}>${inline((h[2] || "").trim())}</h${lvl}>`); i++; continue; }
    if (RE.quote.test(line)) {
      const inner = [];
      let lastText = false;
      while (i < n) {
        const l = lines[i];
        if (RE.quote.test(l)) { const rest = l.replace(/^ {0,3}> ?/, ""); inner.push(rest); lastText = !RE.blank.test(rest) && !isFenceOpen(rest); i++; continue; }
        // A lazy line: plain text right after quoted text carries the quote on.
        if (lastText && !RE.blank.test(l) && !startsBlock(lines, i)) { inner.push(l); i++; continue; }
        break;
      }
      out.push(depth >= MAX_DEPTH ? `<p>${inline(inner.join("\n").trim())}</p>` : `<blockquote>${blocks(inner, depth + 1).join("")}</blockquote>`);
      continue;
    }
    const it = RE.item.exec(line);
    if (it) { const r = list(lines, i, depth); out.push(r.html); i = r.end; continue; }
    if (isTableStart(lines, i)) { const r = table(lines, i); out.push(r.html); i = r.end; continue; }
    // A paragraph: to a blank line or the start of another block.
    const para = [line.trim()];
    i++;
    while (i < n && !RE.blank.test(lines[i]) && !startsBlock(lines, i)) { para.push(lines[i].trim()); i++; }
    out.push(`<p>${inline(para.join("\n"))}</p>`);
  }
  return out;
}

function table(lines, start) {
  const head = cells(lines[start]);
  // Alignment is a class, never a style attribute: the hub serves this page under `style-src 'self'`, which blocks those.
  const aligns = cells(lines[start + 1]).map((c) => (/^:-+:$/.test(c) ? "al-c" : /^-+:$/.test(c) ? "al-r" : /^:-+$/.test(c) ? "al-l" : ""));
  const cell = (tag, text, k) => `<${tag}${aligns[k] ? ` class="${aligns[k]}"` : ""}>${inline(text)}</${tag}>`;
  let i = start + 2;
  const rows = [];
  while (i < lines.length && !RE.blank.test(lines[i]) && lines[i].includes("|") && !(isFenceOpen(lines[i]) || RE.quote.test(lines[i]) || RE.heading.test(lines[i]))) {
    const c = cells(lines[i]);
    rows.push(`<tr>${head.map((_, k) => cell("td", c[k] ?? "", k)).join("")}</tr>`);
    i++;
  }
  const html = `<div class="md-table"><table><thead><tr>${head.map((t, k) => cell("th", t, k)).join("")}</tr></thead>${rows.length ? `<tbody>${rows.join("")}</tbody>` : ""}</table></div>`;
  return { html, end: i };
}

function list(lines, start, depth) {
  const first = RE.item.exec(lines[start]);
  const ordered = /\d/.test(first[2]);
  const kind = ordered ? first[2].slice(-1) : first[2];
  const items = [];
  let i = start, loose = false;
  while (i < lines.length) {
    const m = RE.item.exec(lines[i]);
    if (!m || RE.hr.test(lines[i]) || (ordered ? !/\d/.test(m[2]) || m[2].slice(-1) !== kind : m[2] !== kind)) break;
    if (items.length && indentOf(lines[i]) > indentOf(lines[start]) + 3) break;
    const pad = m[3].length > 4 ? 1 : Math.max(1, m[3].length);
    const offset = m[1].length + m[2].length + (m[4] ? pad : 1);
    const body = [m[4] ? (m[3].length > 4 ? " ".repeat(m[3].length - 1) + m[4] : m[4]) : ""];
    i++;
    let blankInside = false;
    while (i < lines.length) {
      const l = lines[i];
      if (RE.blank.test(l)) {
        // A blank line stays in the item only when what follows is indented into it.
        let j = i; while (j < lines.length && RE.blank.test(lines[j])) j++;
        if (j < lines.length && indentOf(lines[j]) >= offset) { for (; i < j; i++) body.push(""); blankInside = true; continue; }
        break;
      }
      if (indentOf(l) >= offset) { body.push(dedent(l, offset)); i++; continue; }
      if (RE.item.test(l) || startsBlock(lines, i)) break;
      // A lazy line continues the item's text.
      if (!RE.blank.test(body[body.length - 1] ?? "")) { body.push(l.trim()); i++; continue; }
      break;
    }
    if (blankInside) loose = true;
    items.push({ body, num: ordered ? Number(m[2].slice(0, -1)) : 0 });
    // Blank lines between this item and the next one of the same list make it loose.
    let j = i; while (j < lines.length && RE.blank.test(lines[j])) j++;
    if (j > i && j < lines.length) {
      const nx = RE.item.exec(lines[j]);
      if (nx && (ordered ? /\d/.test(nx[2]) && nx[2].slice(-1) === kind : nx[2] === kind) && indentOf(lines[j]) <= indentOf(lines[start]) + 3) { loose = true; i = j; continue; }
    }
    if (j > i) break;
  }
  const tag = ordered ? "ol" : "ul";
  let tasks = false;
  const lis = items.map(({ body }) => {
    let lines2 = body;
    let box = "";
    const t = /^\[([ xX])\](?:[ \t]+|$)/.exec(lines2[0] || "");
    if (t) { box = `<input type="checkbox" disabled${t[1] === " " ? "" : " checked"}> `; lines2 = [lines2[0].slice(t[0].length), ...lines2.slice(1)]; tasks = true; }
    let inner;
    if (depth >= MAX_DEPTH) inner = inline(lines2.join("\n").trim());
    else {
      const bs = blocks(lines2, depth + 1);
      inner = loose ? bs.join("") : bs.map((b) => (b.startsWith("<p>") && b.endsWith("</p>") ? b.slice(3, -4) : b)).join("");
    }
    return `<li${box ? ' class="task"' : ""}>${box}${inner}</li>`;
  });
  const startAttr = ordered && items[0].num !== 1 ? ` start="${items[0].num}"` : "";
  return { html: `<${tag}${startAttr}${tasks ? ' class="tasks"' : ""}>${lis.join("")}</${tag}>`, end: i };
}

const toLines = (src) => String(src ?? "").replace(/\r\n?/g, "\n").split("\n");
/** One HTML string per top-level block, each a single element. */
export const mdBlocks = (src) => blocks(toLines(src), 0);
export const md = (src) => mdBlocks(src).join("");

// ------------------------------------------------------------------ streaming
/**
 * A half-arrived message made safe to render: an open fence is closed, an emphasis, strike or code span still open is closed
 * (or dropped when nothing follows it yet), a link still being written shows as its text, and a line that is only a marker so
 * far (`##`, `-`, `1.`, `>`), a fence's opening line, or a table whose separator row has not arrived is held back.
 * Applied to a finished message it changes nothing that renders differently.
 */
const closingFence = (mark) => new RegExp(`^ {0,3}${mark[0] === "`" ? "`" : "~"}{${mark.length},}[ \\t]*$`);
/** A line that is only a block marker so far: nothing to show yet, and shown raw it would be literal syntax. */
const MARKER_ONLY = /^\s*(?:[-*+]|\d{1,9}[.)]|#{1,6}|>[\s>]*|[-*_]{2}|`{1,2}|~{1,2})\s*$/;

export function closeOpen(src) {
  const text = String(src ?? "").replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  // Does the text end inside a fence?
  let fence = null, fenceLine = -1;
  for (let k = 0; k < lines.length; k++) {
    if (fence) { if (closingFence(fence).test(lines[k])) fence = null; continue; }
    const f = RE.fence.exec(lines[k]);
    if (f && isFenceOpen(lines[k])) { fence = f[2]; fenceLine = k; }
  }
  if (fence) {
    // Only its opening line so far: held back until it ends, or the language would spell itself out letter by letter.
    if (fenceLine === lines.length - 1) return lines.slice(0, -1).join("\n") + (lines.length > 1 ? "\n" : "");
    return `${text}${text.endsWith("\n") ? "" : "\n"}${fence}`;
  }
  let end = lines.length;
  if (MARKER_ONLY.test(lines[end - 1]) && lines[end - 1].trim()) end--;
  // A table (lines that start with a pipe) shows once its separator row is whole.
  let e = end;
  if (e > 0 && lines[e - 1] === "" && e === lines.length) e--;
  let t = e;
  while (t > 0 && /^\s*\|/.test(lines[t - 1])) t--;
  if (t < e) {
    const sepDone = t + 2 < e || (t + 2 === e && e < lines.length);
    if (!(t + 1 < e && RE.sep.test(lines[t + 1]) && sepDone)) end = t;
  }
  const kept = lines.slice(0, end);
  // The last paragraph's inline spans (trailing empty lines stay where they are).
  let last = kept.length - 1;
  while (last >= 0 && kept[last] === "") last--;
  if (last >= 0) {
    let from = last;
    while (from > 0 && !RE.blank.test(kept[from - 1])) from--;
    kept.splice(from, last - from + 1, closeInline(kept.slice(from, last + 1).join("\n")));
  }
  return kept.join("\n") + (end < lines.length ? "\n" : "");
}

/** Closes the inline spans the end of `src` leaves open, and drops a delimiter that nothing follows yet. */
function closeInline(src, depth = 0) {
  let s = src.replace(/[*_~`]+$/, "");
  // An open code span: closed, or dropped when nothing is in it yet.
  let open = null;
  for (let i = 0; i < s.length;) {
    if (s[i] === "\\") { i += 2; continue; }
    if (s[i] !== "`") { i++; continue; }
    let j = i; while (s[j] === "`") j++;
    if (!open) open = [i, j - i]; else if (open[1] === j - i) open = null;
    i = j;
  }
  if (open && !s.slice(open[0] + open[1]).trim()) return depth < 4 ? closeInline(s.slice(0, open[0]), depth + 1) : s.slice(0, open[0]);
  const plain = open ? s.slice(0, open[0]) : s;
  const code = open ? `${s.slice(open[0])}${"`".repeat(open[1])}` : "";
  // A link still being written shows as its text.
  const fixed = plain.replace(/!?\[([^\]\n]*)\]\([^)\n]*$/, "$1").replace(/!?\[([^\]\n]*)$/, "$1");
  if (fixed !== plain && depth < 4) return closeInline(fixed + (open ? s.slice(open[0]) : ""), depth + 1);
  // Emphasis and strike still open: closed, innermost first. Code spans and escapes are masked out.
  const masked = plain.replace(/(`+)[\s\S]*?\1/g, (m) => " ".repeat(m.length)).replace(/\\./g, "  ");
  const stack = [];
  for (let i = 0; i < masked.length;) {
    const c = masked[i];
    if (c !== "*" && c !== "_" && c !== "~") { i++; continue; }
    let j = i; while (masked[j] === c) j++;
    let n = j - i;
    const before = i ? masked[i - 1] : "", after = j < masked.length ? masked[j] : "";
    i = j;
    if (c === "~" && n !== 2) continue;
    const left = !isWs(after) && (!isPunct(after) || isWs(before) || isPunct(before));
    const right = !isWs(before) && (!isPunct(before) || isWs(after) || isPunct(after));
    const canOpen = c === "_" ? left && (!right || isPunct(before)) : left;
    const canClose = c === "_" ? right && (!left || isPunct(after)) : right;
    while (n > 0 && canClose) {
      const k = stack.findLastIndex((x) => x.ch === c);
      if (k < 0) break;
      const use = Math.min(n, stack[k].n);
      stack[k].n -= use; n -= use;
      stack.length = stack[k].n ? k + 1 : k; // what opened inside it and never closed stays literal
    }
    if (n > 0 && canOpen) stack.push({ ch: c, n });
  }
  let marks = "";
  for (let k = stack.length - 1; k >= 0; k--) marks += stack[k].ch.repeat(stack[k].n);
  return open ? `${plain}${code}${marks}` : `${plain}${marks}`;
}
