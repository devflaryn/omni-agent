/* The file pane beside the explorer: editor tabs like VS Code (a single click opens a preview tab, in italics,
   that the next single click replaces; a double click or the first edit keeps it), and a viewer per kind of
   file: the code editor for text (Ctrl+S saves, in the file's own encoding and line endings; a file changed on
   disk meanwhile is not overwritten without asking), rendered Markdown, images, video, audio, PDF, the entries
   of zip-like archives, and for a binary a read-only text or hex view (looking never writes the file). */
import { el, md, fileKind, fmtBytes, buildTree, showName } from "./lib.js";
import { createEditor } from "./editor.js";
import { languageFor, LANG_LABEL } from "./highlight.js";
import { showMenu, onContext } from "./contextmenu.js";
import { fileIcon, ICONS } from "./fileicons.js";
import { framesFiles, onLeaveCheck, rawUrl, saveFile } from "./transport.js";
import { absPath } from "./paths.js";

const q = (o) => Object.entries(o).filter(([, v]) => v != null).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
const ENC_LABEL = { utf8: "UTF-8", utf8bom: "UTF-8 with BOM", utf16le: "UTF-16 LE", utf16be: "UTF-16 BE", latin1: "Latin-1" };
const EOL_LABEL = { lf: "LF", crlf: "CRLF", cr: "CR" };
export { absPath };
const mdPreferred = () => { try { return localStorage.getItem("omni.mdPreview") !== "0"; } catch { return true; } };

/** A hex dump: offset, 16 bytes, their printable characters. */
export function hexDump(bytes, base = 0) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 16) {
    const row = bytes.subarray(i, i + 16);
    let hex = "", txt = "";
    for (let j = 0; j < 16; j++) {
      hex += j < row.length ? row[j].toString(16).padStart(2, "0") + " " : "   ";
      if (j === 7) hex += " ";
      if (j < row.length) txt += row[j] >= 0x20 && row[j] < 0x7f ? String.fromCharCode(row[j]) : ".";
    }
    out += `${(base + i).toString(16).padStart(8, "0")}  ${hex} ${txt}\n`;
  }
  return out;
}
const b64bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

export function createFilePane({ api, toast, insert, isRemote = () => false, onActive, revealInTree }) {
  const $ = (s) => document.querySelector(s);
  const pane = $("#preview"), tabsBar = $("#pvTabs"), body = $("#pvBody"), pathEl = $("#pvPath"), metaEl = $("#pvMeta"), actions = $("#pvActions"), status = $("#pvStatus");
  const tabs = [];
  let active = null, seq = 0, userHidden = false;

  const fileUrl = (t, extra = {}) => rawUrl(`/api/fs/raw?${q({ root: t.root, path: t.path, v: t.info?.mtimeMs ? Math.round(t.info.mtimeMs) : undefined, ...extra })}`);
  const find = (root, path) => tabs.find((t) => t.root === root && t.path === path);

  // ------------------------------------------------------------------ tabs
  function show() { pane.hidden = false; document.body.classList.add("preview-open"); }
  function hide() { pane.hidden = true; document.body.classList.remove("preview-open", "preview-max"); }

  async function open(root, path, { pin = false, mode } = {}) {
    show(); userHidden = false;
    let t = find(root, path);
    if (t) {
      if (pin) t.pinned = true;
      activate(t);
      if (mode && mode !== t.mode) setMode(t, mode);
      else if (!t.dirty) refreshFromDisk(t, { quiet: true });
      return t;
    }
    // The preview tab (not kept, not edited) is reused for the next single click.
    const reuse = !pin && tabs.find((x) => !x.pinned && !x.dirty);
    t = { id: ++seq, root, path, name: path.split("/").pop(), pinned: pin, dirty: false, mode, view: el("div", "pv-view") };
    if (reuse) { const i = tabs.indexOf(reuse); dispose(reuse); tabs.splice(i, 1, t); } else tabs.push(t);
    body.appendChild(t.view);
    activate(t);
    await load(t);
    return t;
  }

  async function load(t) {
    t.view.innerHTML = ""; t.view.appendChild(el("div", "pv-note pad", "Loading…"));
    try {
      const info = await api(`/api/fs/read?${q({ root: t.root, path: t.path })}`);
      if (!tabs.includes(t)) return;
      t.info = info;
      t.mode ||= defaultMode(info);
      render(t);
    } catch (e) { t.view.innerHTML = ""; t.view.appendChild(el("div", "pv-note pad err", e.message)); }
  }
  function defaultMode(info) {
    if (info.kind === "markdown") return info.tooBig ? "text" : mdPreferred() ? "preview" : "edit";
    if (info.kind === "text") return info.tooBig ? "text" : "edit";
    return info.kind; // image video audio pdf archive binary
  }

  function activate(t) {
    active = t;
    for (const x of tabs) x.view.hidden = x !== t;
    drawTabs(); drawHead();
    onActive?.(t.root, t.path);
    if (t.editor && !t.view.querySelector(".pv-md:not([hidden])")) requestAnimationFrame(() => t.editor?.focus());
  }

  function dispose(t) { t.editor?.destroy(); t.view.remove(); }
  function close(t, { force = false } = {}) {
    if (t.dirty && !force && !window.confirm(`${showName(t.name)} has unsaved changes. Close it and lose them?`)) return false;
    const i = tabs.indexOf(t);
    if (i < 0) return true;
    tabs.splice(i, 1); dispose(t);
    if (active === t) { active = tabs[Math.min(i, tabs.length - 1)] || null; if (active) activate(active); }
    if (!tabs.length) { active = null; hide(); }
    drawTabs(); drawHead();
    return true;
  }
  function closeMany(list) {
    const dirty = list.filter((t) => t.dirty);
    if (dirty.length && !window.confirm(`${dirty.length === 1 ? showName(dirty[0].name) + " has" : dirty.length + " files have"} unsaved changes. Close and lose them?`)) return false;
    for (const t of [...list]) close(t, { force: true });
    return true;
  }

  function drawTabs() {
    tabsBar.innerHTML = "";
    // Same file name twice: the folder tells them apart.
    const count = {};
    for (const t of tabs) count[t.name] = (count[t.name] || 0) + 1;
    for (const t of tabs) {
      const tab = el("div", `pv-tab${t === active ? " active" : ""}${t.pinned ? "" : " transient"}${t.dirty ? " dirty" : ""}`);
      tab.setAttribute("role", "tab"); tab.setAttribute("aria-selected", String(t === active));
      tab.title = showName(absPath(t.root, t.path)) + (t.dirty ? " · unsaved" : "");
      tab.innerHTML = fileIcon(t.name);
      tab.appendChild(el("span", "pv-tab-name", showName(t.name)));
      if (count[t.name] > 1) tab.appendChild(el("span", "pv-tab-dir", showName(t.path.split("/").slice(-2, -1)[0] || "/")));
      const x = el("button", "pv-tab-x"); x.title = t.dirty ? "Unsaved · close" : "Close"; x.setAttribute("aria-label", `Close ${showName(t.name)}`);
      x.innerHTML = `<svg viewBox="0 0 16 16"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>`;
      x.onclick = (e) => { e.stopPropagation(); close(t); };
      tab.appendChild(x);
      tab.onclick = () => activate(t);
      tab.ondblclick = () => { t.pinned = true; drawTabs(); };
      tab.onauxclick = (e) => { if (e.button === 1) { e.preventDefault(); close(t); } };
      onContext(tab, (cx, cy) => showMenu(cx, cy, [
        { label: "Close", action: () => close(t) },
        { label: "Close Others", action: () => closeMany(tabs.filter((o) => o !== t)), disabled: tabs.length < 2 },
        { label: "Close Saved", action: () => closeMany(tabs.filter((o) => !o.dirty)) },
        { label: "Close All", action: () => closeMany(tabs) },
        "-",
        { label: "Keep Open", action: () => { t.pinned = true; drawTabs(); }, disabled: t.pinned },
        { label: "Reload from Disk", action: () => refreshFromDisk(t, { ask: true }) },
        "-",
        { label: "Copy Path", action: () => copy(absPath(t.root, t.path)) },
        { label: "Copy Relative Path", action: () => copy(t.path) },
        { label: "Reveal in Explorer View", action: () => revealInTree?.(t.root, t.path) },
      ]));
      tabsBar.appendChild(tab);
      if (t === active) requestAnimationFrame(() => tab.scrollIntoView({ block: "nearest", inline: "nearest" }));
    }
  }
  tabsBar.addEventListener("wheel", (e) => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { tabsBar.scrollLeft += e.deltaY; e.preventDefault(); } }, { passive: false });

  // ------------------------------------------------------------------ head
  function button(label, fn, { title, primary, disabled } = {}) {
    const b = el("button", `btn small${primary ? " primary" : " quiet"}`, label);
    if (title) b.title = title;
    b.disabled = !!disabled;
    b.onclick = fn;
    return b;
  }
  function drawHead() {
    actions.innerHTML = ""; status.innerHTML = "";
    const t = active;
    if (!t) { pathEl.textContent = ""; metaEl.textContent = ""; return; }
    pathEl.textContent = showName(t.path); pathEl.title = showName(absPath(t.root, t.path));
    const i = t.info;
    metaEl.textContent = i ? [i.kind === "text" || i.kind === "markdown" ? LANG_LABEL[languageFor(t.name)] : i.kind, fmtBytes(i.size)].filter(Boolean).join(" · ") : "";
    if (!i) return;
    const editable = (i.kind === "text" || i.kind === "markdown") && !i.tooBig;
    if (t.mode === "edit" && editable) actions.appendChild(button(t.saving ? "Saving…" : "Save", () => save(t), { primary: t.dirty, disabled: !t.dirty || t.saving, title: "Save (Ctrl+S)" }));
    if (i.kind === "markdown" && !i.tooBig) actions.appendChild(button(t.mode === "preview" ? "Edit" : "Preview", () => setMode(t, t.mode === "preview" ? "edit" : "preview"), { title: "Rendered Markdown or its source" }));
    if (t.mode === "text" && t.text?.lossy) {
      const enc = t.textEncoding || "utf8";
      actions.appendChild(button(enc === "utf8" ? "Show as Latin-1" : "Show as UTF-8", () => { t.textEncoding = enc === "utf8" ? "latin1" : "utf8"; render(t); }, { title: "UTF-8 shows bytes that are not text as �; Latin-1 shows every byte as one character" }));
    }
    if (t.mode === "image") {
      actions.appendChild(button(t.zoom === "actual" ? "Fit" : "100%", () => { t.zoom = t.zoom === "actual" ? "fit" : "actual"; t.view.querySelector(".pv-imgwrap")?.classList.toggle("actual", t.zoom === "actual"); drawHead(); }));
    }
    if (t.mode === "pdf" && framesFiles()) actions.appendChild(button("Open in new tab", () => fileUrl(t).then((u) => window.open(u, "_blank", "noopener"), (e) => toast(e.message, true))));
    const more = el("button", "icon-btn small pv-more"); more.title = "More actions";
    more.innerHTML = `<svg viewBox="0 0 16 16"><circle cx="3.5" cy="8" r="0.9"/><circle cx="8" cy="8" r="0.9"/><circle cx="12.5" cy="8" r="0.9"/></svg>`;
    more.onclick = () => { const r = more.getBoundingClientRect(); showMenu(r.left, r.bottom + 4, moreItems(t)); };
    actions.appendChild(more);
    drawStatus();
  }
  function moreItems(t) {
    const i = t.info || {};
    const textual = i.kind === "text" || i.kind === "markdown";
    return [
      textual && !i.tooBig && t.mode !== "edit" && { label: "Open in Editor", action: () => setMode(t, "edit") },
      t.mode !== "text" && i.kind !== "archive" && { label: textual ? "Open as Plain Text (read-only)" : "Open as Text (read-only)", action: () => setMode(t, "text") },
      t.mode !== "hex" && { label: "Open in Hex Viewer", action: () => setMode(t, "hex") },
      !textual && t.mode !== defaultMode(i) && { label: `Back to the ${defaultMode(i)} view`, action: () => setMode(t, defaultMode(i)) },
      "-",
      { label: "Reload from Disk", action: () => refreshFromDisk(t, { ask: true }) },
      { label: "Download", action: () => download(t.root, t.path) },
      { label: "Reference in Prompt", action: () => insert(`@${t.path} `) },
      "-",
      { label: "Copy Path", action: () => copy(absPath(t.root, t.path)) },
      { label: "Copy Relative Path", action: () => copy(t.path) },
      { label: "Reveal in Explorer View", action: () => revealInTree?.(t.root, t.path) },
      { label: document.body.classList.contains("preview-max") ? "Restore Editor Size" : "Maximize Editor", action: toggleMax },
    ];
  }
  function drawStatus() {
    const t = active;
    status.innerHTML = "";
    if (!t?.info) return;
    const i = t.info, bits = [];
    if (t.editor && (t.mode === "edit" || t.mode === "text")) {
      const c = t.editor.cursor;
      bits.push([`Ln ${c.line}, Col ${c.col}`, "Line and column"]);
      if (t.mode === "edit") bits.push([t.editor.indent, "Indentation, from the file"]);
      if (t.mode === "edit") {
        bits.push([ENC_LABEL[i.encoding] || i.encoding, i.encoding === "latin1" ? "Not UTF-8: opened as Latin-1 (one byte per character), and saved the same way" : "Encoding, kept when saving"]);
        bits.push([`${EOL_LABEL[i.eol]}${i.eolMixed ? " (mixed)" : ""}`, i.eolMixed ? `The file mixes line endings; saving writes ${EOL_LABEL[i.eol]} throughout` : "Line endings, kept when saving"]);
      } else bits.push([t.text?.truncated ? `First ${fmtBytes(t.text.content.length)} only` : ENC_LABEL[t.textEncoding || "utf8"], "Read-only view; the file is not changed by looking"]);
      bits.push([LANG_LABEL[languageFor(t.name)], "Language"]);
      if (t.editor.readOnly) bits.push(["Read-only", "This view cannot change the file"]);
    } else if (t.mode === "image" && t.dims) bits.push([`${t.dims[0]} × ${t.dims[1]}`, "Pixels"], [fmtBytes(i.size), "Size"]);
    else if ((t.mode === "video" || t.mode === "audio") && t.duration) bits.push([fmtTime(t.duration), "Duration"], ...(t.dims ? [[`${t.dims[0]} × ${t.dims[1]}`, "Pixels"]] : []), [fmtBytes(i.size), "Size"]);
    else if (t.mode === "hex") bits.push([`${fmtBytes(t.hexLoaded || 0)} of ${fmtBytes(i.size)} shown`, "Bytes"]);
    else bits.push([fmtBytes(i.size), "Size"]);
    if (t.saveNote) bits.push([t.saveNote, ""]);
    for (const [text, title] of bits) { const s = el("span", null, text); if (title) s.title = title; status.appendChild(s); }
  }
  const fmtTime = (s) => { s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60; return `${h ? `${h}:${String(m).padStart(2, "0")}` : m}:${String(r).padStart(2, "0")}`; };

  function setMode(t, mode) {
    if (t.mode === mode) return;
    if (t.mode === "edit" && t.dirty && mode !== "preview" && !window.confirm(`${showName(t.name)} has unsaved changes. Switch view and lose them?`)) return;
    if (t.info?.kind === "markdown" && (mode === "preview" || mode === "edit")) { try { localStorage.setItem("omni.mdPreview", mode === "preview" ? "1" : "0"); } catch { /* */ } }
    // Markdown preview <-> edit keeps the editor (and its unsaved text and undo).
    if (t.info?.kind === "markdown" && t.editor && ((t.mode === "edit" && mode === "preview") || (t.mode === "preview" && mode === "edit"))) {
      t.mode = mode; showMd(t); drawHead(); return;
    }
    if (t.mode === "edit") setDirty(t, false);
    t.mode = mode;
    render(t);
  }

  // ---------------------------------------------------------------- render
  function render(t) {
    t.editor?.destroy(); t.editor = null; t.text = null;
    t.view.innerHTML = "";
    switch (t.mode) {
      case "edit": case "preview": renderEditor(t); break;
      case "text": renderText(t); break;
      case "hex": renderHex(t); break;
      case "image": renderImage(t); break;
      case "video": case "audio": renderMedia(t); break;
      case "pdf": renderPdf(t); break;
      case "archive": renderArchive(t); break;
      default: renderBinary(t);
    }
    if (t === active) drawHead();
  }

  function renderEditor(t) {
    const i = t.info;
    const ed = createEditor({
      value: i.content, lang: languageFor(t.name), readOnly: false,
      onChange: (v) => { if (!t.pinned) { t.pinned = true; } setDirty(t, v !== t.saved); },
      onSave: () => save(t),
      onCursor: () => { if (t === active) drawStatus(); },
    });
    t.editor = ed; t.saved = ed.value; // the textarea's own form of the text (\n line breaks)
    const mdv = el("div", "pv-md text pad");
    t.view.append(ed.el, mdv);
    if (i.eolMixed) t.view.prepend(banner(`This file mixes line endings. Saving writes ${EOL_LABEL[i.eol]} throughout.`, "note"));
    showMd(t);
  }
  function showMd(t) {
    const mdv = t.view.querySelector(".pv-md");
    if (!mdv || !t.editor) return;
    const preview = t.mode === "preview";
    mdv.hidden = !preview; t.editor.el.hidden = preview;
    if (preview) mdv.innerHTML = md(t.editor.value); else if (t === active) t.editor.focus();
  }

  async function renderText(t) {
    t.view.appendChild(el("div", "pv-note pad", "Loading…"));
    try {
      const d = await api(`/api/fs/text?${q({ root: t.root, path: t.path, encoding: t.textEncoding || "utf8" })}`);
      if (t.mode !== "text") return;
      t.text = d; t.view.innerHTML = "";
      const textual = t.info.kind === "text" || t.info.kind === "markdown";
      t.view.appendChild(banner(textual
        ? `Read-only${d.truncated ? `: the first ${fmtBytes(d.content.length)} of ${fmtBytes(d.size)}` : ""}.`
        : `Read-only: this file is binary, shown as ${t.textEncoding === "latin1" ? "Latin-1 (every byte as one character)" : "UTF-8 (bytes that are not text appear as �)"}${d.truncated ? `, first ${fmtBytes(TEXT_LIMIT)} only` : ""}. Looking never changes the file.`, "note"));
      const ed = createEditor({ value: d.content, lang: textual ? languageFor(t.name) : "plain", readOnly: true, onCursor: () => { if (t === active) drawStatus(); } });
      t.editor = ed; t.view.appendChild(ed.el);
      if (t === active) drawHead();
    } catch (e) { t.view.innerHTML = ""; t.view.appendChild(el("div", "pv-note pad err", e.message)); }
  }
  const TEXT_LIMIT = 2 * 1024 * 1024;

  async function renderHex(t) {
    t.hexLoaded = 0;
    const wrap = el("div", "pv-hexwrap"), pre = el("pre", "pv-hex"), more = button("Load more", () => next());
    wrap.append(banner("Read-only hex view. Looking never changes the file.", "note"), pre, more);
    t.view.appendChild(wrap);
    const next = async () => {
      more.disabled = true; more.textContent = "Loading…";
      try {
        const d = await api(`/api/fs/hex?${q({ root: t.root, path: t.path, offset: t.hexLoaded })}`);
        const bytes = b64bytes(d.data);
        pre.appendChild(document.createTextNode(hexDump(bytes, d.offset)));
        t.hexLoaded = d.offset + bytes.length;
        more.hidden = t.hexLoaded >= d.size; more.disabled = false; more.textContent = `Load more (${fmtBytes(d.size - t.hexLoaded)} left)`;
        if (t === active) drawStatus();
      } catch (e) { more.disabled = false; more.textContent = "Load more"; toast(e.message, true); }
    };
    await next();
  }

  function renderImage(t) {
    const i = t.info;
    if (i.tooBig) return t.view.appendChild(binaryCard(t, `Image too large to show (${fmtBytes(i.size)}).`));
    const wrap = el("div", `pv-imgwrap${t.zoom === "actual" ? " actual" : ""}`), img = el("img", "pv-img");
    img.alt = t.name;
    img.onload = () => { t.dims = [img.naturalWidth, img.naturalHeight]; if (t === active) drawStatus(); };
    img.onerror = () => { wrap.replaceWith(binaryCard(t, "This image could not be shown.")); };
    img.onclick = () => { t.zoom = t.zoom === "actual" ? "fit" : "actual"; wrap.classList.toggle("actual", t.zoom === "actual"); if (t === active) drawHead(); };
    wrap.appendChild(img);
    t.view.appendChild(wrap);
    fileUrl(t).then((u) => { img.src = u; }, (e) => wrap.replaceWith(binaryCard(t, e.message)));
  }

  function renderMedia(t) {
    const video = t.mode === "video";
    const m = el(video ? "video" : "audio", video ? "pv-video" : "pv-audio");
    m.controls = true; m.preload = "metadata"; m.setAttribute("playsinline", "");
    m.onloadedmetadata = () => { t.duration = m.duration; if (video) t.dims = [m.videoWidth, m.videoHeight]; if (t === active) drawStatus(); };
    m.onerror = () => { m.replaceWith(binaryCard(t, `This browser cannot play this ${video ? "video" : "audio"} (its format or codec). Download it to play it elsewhere.`)); };
    const wrap = el("div", "pv-mediawrap"); wrap.appendChild(m);
    t.view.appendChild(wrap);
    fileUrl(t).then((u) => { m.src = u; }, (e) => m.replaceWith(binaryCard(t, e.message)));
  }

  function renderPdf(t) {
    // A blob carries the page's origin and no sandbox header, so the web page never frames a file.
    if (!framesFiles()) return t.view.appendChild(binaryCard(t, "The web page does not show PDFs. Download it."));
    const f = el("iframe", "pv-pdf"); f.title = t.name;
    t.view.appendChild(f);
    fileUrl(t).then((u) => { f.src = u; }, (e) => { f.replaceWith(binaryCard(t, e.message)); });
  }

  function binaryCard(t, line) {
    const c = el("div", "pv-binary");
    c.innerHTML = `<span class="pv-binary-ico">${ICONS.binary}</span>`;
    c.appendChild(el("div", "pv-binary-title", line || "This file is binary or in an encoding the editor does not read."));
    c.appendChild(el("div", "pv-binary-sub", `${t.info?.ext || "no extension"} · ${fmtBytes(t.info?.size)}. Opening it below is read-only and never changes the file.`));
    const row = el("div", "pv-binary-actions");
    row.append(button("Open as Text", () => setMode(t, "text"), { primary: true }), button("Hex Viewer", () => setMode(t, "hex")), button("Download", () => download(t.root, t.path)));
    for (const b of row.children) b.classList.remove("quiet");
    c.appendChild(row);
    return c;
  }
  function renderBinary(t) {
    t.view.appendChild(binaryCard(t, t.info.tooBig ? `Too large to open in the editor (${fmtBytes(t.info.size)}).` : null));
  }

  function banner(text, kind) { const b = el("div", `pv-banner ${kind || ""}`); b.appendChild(el("span", null, text)); return b; }

  // --------------------------------------------------------------- archives
  function renderArchive(t) {
    const d = t.info;
    const box = el("div", "pad");
    t.view.appendChild(box);
    if (d.tooBig) return box.appendChild(el("div", "pv-note", `Archive too large to read (${fmtBytes(d.size)}).`));
    const head = el("div", "pv-note", `${d.entries.length} entries inside ${showName(t.name)}`);
    const filter = el("input", "pv-filter"); filter.type = "search"; filter.placeholder = "Filter entries";
    const list = el("div", "zip-tree"), out = el("div", "zip-entry"); out.hidden = true;
    const tree = buildTree(d.entries);
    const entryRow = (n, depth) => {
      const row = el("button", "zrow");
      row.style.paddingLeft = `${6 + Math.max(0, depth) * 14}px`;
      row.innerHTML = `${fileIcon(n.name)}<span class="name"></span><span class="size"></span>`;
      row.querySelector(".name").textContent = showName(depth === -1 ? n.path : n.name);
      row.querySelector(".size").textContent = fmtBytes(n.size);
      row.title = `${showName(n.path)} · ${fmtBytes(n.size)} (${fmtBytes(n.compressed)} compressed)`;
      row.onclick = () => openEntry(t, n.entry, out, box);
      return row;
    };
    // Folders render their children only when opened, so a 3000-entry APK stays light.
    const folderNode = (n, depth) => {
      const node = el("div", "znode"), row = el("button", "zrow dir"), kids = el("div", "zkids");
      row.style.paddingLeft = `${6 + depth * 14}px`;
      row.innerHTML = `<span class="ico">${ICONS.folder}</span><span class="name"></span><span class="size"></span>`;
      row.querySelector(".name").textContent = showName(n.name);
      row.querySelector(".size").textContent = `${n.count}`;
      row.title = `${showName(n.path)} · ${n.count} file${n.count === 1 ? "" : "s"}`;
      kids.hidden = true;
      let built = false;
      row.onclick = () => { kids.hidden = !kids.hidden; row.querySelector(".ico").innerHTML = kids.hidden ? ICONS.folder : ICONS.folderOpen; if (!built) { built = true; for (const k of n.children) kids.appendChild(k.dir ? folderNode(k, depth + 1) : entryRow(k, depth + 1)); } };
      node.append(row, kids);
      return node;
    };
    const draw = () => {
      const f = filter.value.trim().toLowerCase();
      list.innerHTML = "";
      if (!f) { for (const n of tree) list.appendChild(n.dir ? folderNode(n, 0) : entryRow(n, 0)); return; }
      // A filter flattens to matching files, full paths shown.
      let n = 0;
      for (const e of d.entries) {
        if (e.dir || !e.path.toLowerCase().includes(f)) continue;
        if (++n > 1500) { list.appendChild(el("div", "empty", "… more matches; narrow the filter")); break; }
        list.appendChild(entryRow({ name: e.path.split("/").pop(), path: e.path, size: e.size, compressed: e.compressed, entry: e }, -1));
      }
      if (!n) list.appendChild(el("div", "empty", "No entries match."));
    };
    filter.addEventListener("input", draw);
    draw();
    // The opened entry sits above the list so it is never buried under thousands of rows.
    box.append(head, filter, out, list);
  }
  async function openEntry(t, e, out, box) {
    out.hidden = false; out.innerHTML = ""; out.appendChild(el("div", "pv-note", `Reading ${showName(e.path)}…`));
    try {
      const d = await api(`/api/fs/archive-entry?${q({ root: t.root, path: t.path, entry: e.path })}`);
      out.innerHTML = "";
      const h = el("div", "zip-entry-head"); h.append(el("b", null, showName(e.path)), el("span", "size", fmtBytes(d.size)));
      const closeBtn = el("button", "btn quiet small", "Close"); closeBtn.onclick = () => { out.hidden = true; out.innerHTML = ""; }; h.appendChild(closeBtn);
      out.appendChild(h);
      if (d.kind === "image") { const img = el("img", "pv-img"); img.src = `data:${d.mime};base64,${d.data}`; out.appendChild(img); }
      else if (d.kind === "markdown") { const m = el("div", "pv-md text"); m.innerHTML = md(d.content); out.appendChild(m); }
      else if (d.kind === "text") { const ed = createEditor({ value: d.content, lang: languageFor(e.path), readOnly: true }); ed.el.classList.add("inline"); out.appendChild(ed.el); }
      else if (d.data) { out.appendChild(el("div", "pv-note", `Binary entry${d.size > 65536 ? ", first 64 KB" : ""}:`)); out.appendChild(el("pre", "pv-hex", hexDump(b64bytes(d.data)))); }
      else out.appendChild(el("div", "pv-note", d.tooBig ? "Too large to show." : "Binary entry, no preview."));
      box.scrollTop = 0; t.view.scrollTop = 0;
    } catch (err) { out.innerHTML = ""; out.appendChild(el("div", "pv-note err", err.message)); }
  }

  // ------------------------------------------------------------------ saving
  function setDirty(t, d) {
    if (t.dirty === d) return;
    t.dirty = d; drawTabs(); if (t === active) drawHead();
  }
  async function save(t, { force = false, create = false } = {}) {
    if (!t?.editor || t.editor.readOnly || t.mode === "text" || t.saving) return;
    const content = t.editor.value, i = t.info;
    t.saving = true; if (t === active) drawHead();
    try {
      const r = await api("/api/fs/write", { root: t.root, path: t.path, content, encoding: i.encoding, eol: i.eol, baseHash: create ? undefined : i.hash, force, create });
      Object.assign(i, { hash: r.hash, size: r.size, mtimeMs: r.mtimeMs, eolMixed: undefined });
      t.saved = content; t.saveNote = "Saved";
      setTimeout(() => { if (t.saveNote === "Saved") { t.saveNote = ""; if (t === active) drawStatus(); } }, 2000);
      t.view.querySelector(".pv-banner.conflict")?.remove();
      setDirty(t, t.editor.value !== t.saved);
    } catch (e) {
      if (e.body?.conflict) showConflict(t, e.body);
      else toast(`Could not save ${showName(t.name)}: ${e.message}`, true);
    } finally { t.saving = false; if (t === active) drawHead(); }
  }
  function showConflict(t, b) {
    t.view.querySelector(".pv-banner.conflict")?.remove();
    const bar = banner(b.gone ? "The file was deleted or moved since you opened it." : "The file changed on disk since you opened it (the agent may have edited it).", "conflict");
    const acts = el("span", "pv-banner-actions");
    if (b.gone) acts.append(button("Save as new file", () => save(t, { create: true }), { primary: true }));
    else acts.append(button("Overwrite", () => save(t, { force: true }), { primary: true }), button("Reload (lose mine)", () => refreshFromDisk(t, { force: true })));
    acts.append(button("Dismiss", () => bar.remove()));
    bar.appendChild(acts);
    t.view.prepend(bar);
  }

  /** Re-read the file. A clean editor takes the disk's text in place (scroll kept); a dirty one only when forced. */
  async function refreshFromDisk(t, { quiet = false, ask = false, force = false } = {}) {
    if (!t) return;
    if (t.dirty && ask && !window.confirm(`Reload ${showName(t.name)} from disk and lose your unsaved changes?`)) return;
    if (t.dirty && !ask && !force) return;
    let info;
    try { info = await api(`/api/fs/read?${q({ root: t.root, path: t.path })}`); } catch (e) { if (!quiet) toast(e.message, true); return; }
    if (!tabs.includes(t)) return;
    // Text compares by content; images and binaries (no hash) by size and modification time.
    const same = t.info && (info.hash || t.info.hash ? info.hash === t.info.hash : info.size === t.info.size && info.mtimeMs === t.info.mtimeMs);
    if (same && !ask && !force) return;
    if (t.editor && (t.mode === "edit" || t.mode === "preview") && (info.kind === "text" || info.kind === "markdown") && !info.tooBig) {
      t.info = info; t.editor.setValue(info.content); t.saved = t.editor.value; setDirty(t, false);
      t.view.querySelector(".pv-banner.conflict")?.remove();
      if (t.mode === "preview") showMd(t);
      if (t === active) drawHead();
      return;
    }
    t.info = info;
    if (!["text", "hex"].includes(t.mode)) t.mode = defaultMode(info);
    render(t);
  }
  // The agent edits files while they are open: a clean active tab follows the disk when the window regains focus.
  window.addEventListener("focus", () => { if (active && !active.dirty && !pane.hidden) refreshFromDisk(active, { quiet: true }); });
  window.addEventListener("beforeunload", (e) => { if (tabs.some((t) => t.dirty)) { e.preventDefault(); e.returnValue = ""; } });
  // Going to another machine asks first (transport.js), so its answer can leave the window as it was. Its tabs are this machine's.
  onLeaveCheck(() => { const n = tabs.filter((t) => t.dirty).length; return n ? `${n === 1 ? "A file has" : `${n} files have`} unsaved changes.` : null; });

  // ----------------------------------------------------------------- helpers
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); }
    catch { const ta = el("textarea"); ta.value = text; document.body.appendChild(ta); ta.select(); try { document.execCommand("copy"); } catch { /* */ } ta.remove(); }
    toast("Copied");
  }
  function download(root, path) {
    saveFile(`/api/fs/raw?${q({ root, path, download: 1 })}`, showName(path.split("/").pop())).catch((e) => toast(e.message, true));
  }
  function toggleMax() { document.body.classList.toggle("preview-max"); if (active) drawHead(); active?.editor?.refresh(); }

  $("#pvClose").onclick = () => { userHidden = true; hide(); };
  $("#pvMax").onclick = toggleMax;
  $("#pvRef").onclick = () => { if (active) insert(`@${active.path} `); };
  document.addEventListener("keydown", (e) => {
    if (pane.hidden || !active) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s" && pane.contains(document.activeElement)) { e.preventDefault(); save(active); }
  });

  return {
    open, hide, show, copy, download, absPath,
    /** Back with the explorer: the open tabs return unless the person hid the editor themselves. */
    restore() { if (tabs.length && !userHidden) show(); },
    closeAll: () => closeMany(tabs),
    /** The window went to another machine, already agreed to: these tabs were the last machine's, so none may stay open. */
    forgetAll: () => { for (const t of [...tabs]) close(t, { force: true }); },
    get active() { return active; },
    get hasTabs() { return tabs.length > 0; },
    /** The tree renamed or moved something: open tabs under it follow. */
    renamed(root, from, to) {
      for (const t of tabs) {
        if (t.root !== root) continue;
        if (t.path === from || t.path.startsWith(`${from}/`)) { t.path = to + t.path.slice(from.length); t.name = t.path.split("/").pop(); }
      }
      drawTabs(); drawHead();
      if (active?.editor && active.mode === "edit") active.editor.setLang(languageFor(active.name));
    },
    /** The tree deleted something: clean tabs under it close; dirty ones stay, marked as gone on their next save. */
    deleted(root, path) {
      for (const t of [...tabs]) if (t.root === root && (t.path === path || t.path.startsWith(`${path}/`)) && !t.dirty) close(t, { force: true });
    },
    fileKind,
  };
}
