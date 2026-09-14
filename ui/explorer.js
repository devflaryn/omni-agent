/* File explorer (left column) + preview column: tree with lazy folders, previews for text, markdown,
   images and zip-like archives (.zip/.apk/.jar: entries inside, text entries readable in place). */
import { el, md, fileKind, fmtBytes, buildTree } from "./lib.js";

const ICONS = {
  folder: `<svg viewBox="0 0 16 16"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z"/></svg>`,
  folderOpen: `<svg viewBox="0 0 16 16"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v1H4.2L2 12z"/><path d="M2 12l2.2-5H15l-2.2 5z"/></svg>`,
  text: `<svg viewBox="0 0 16 16"><path d="M4 2h5l3 3v9H4zM9 2v3h3M6 8h4M6 10.5h4"/></svg>`,
  markdown: `<svg viewBox="0 0 16 16"><path d="M2 4h12v8H2zM4 10V6l2 2 2-2v4M11 6v4M9.5 8.5 11 10l1.5-1.5"/></svg>`,
  image: `<svg viewBox="0 0 16 16"><rect x="2.5" y="3" width="11" height="10" rx="1.5"/><circle cx="6" cy="6.5" r="1"/><path d="m3 12 3.5-3.5 2 2 2-2L13 12"/></svg>`,
  archive: `<svg viewBox="0 0 16 16"><path d="M3 3h10v10H3zM8 3v2M8 6v2M8 9v1.5M7 10.5h2v2H7z"/></svg>`,
  binary: `<svg viewBox="0 0 16 16"><path d="M4 2h5l3 3v9H4zM9 2v3h3"/><path d="M6 9h4M6 11h2" stroke-dasharray="1 1.5"/></svg>`,
};
const icon = (k) => `<span class="ico">${ICONS[k] || ICONS.binary}</span>`;

export function createExplorer({ api, toast, insert, onClose }) {
  const $ = (s) => document.querySelector(s);
  const tree = $("#tree"), rootLbl = $("#explorerRoot"), filter = $("#explorerFilter");
  const pv = $("#preview"), pvPath = $("#pvPath"), pvMeta = $("#pvMeta"), pvBody = $("#pvBody"), pvRaw = $("#pvRaw");
  let root = null, loadedRoot = null, current = null, rawMode = false;

  // ------------------------------------------------------------------ tree
  async function loadDir(path, container, depth) {
    try {
      const { entries } = await api(`/api/fs/list?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`);
      container.innerHTML = "";
      for (const e of entries) container.appendChild(nodeFor(e, depth));
      if (!entries.length) container.appendChild(el("div", "empty", "empty"));
    } catch (e) { container.innerHTML = ""; container.appendChild(el("div", "empty err", e.message)); }
  }
  function nodeFor(e, depth) {
    const node = el("div", "node"), row = el("button", "row");
    row.style.paddingLeft = `${8 + depth * 14}px`;
    row.dataset.path = e.path;
    row.innerHTML = `${icon(e.dir ? "folder" : fileKind(e.name))}<span class="name"></span>`;
    row.querySelector(".name").textContent = e.name;
    row.title = e.path;
    node.appendChild(row);
    if (e.dir) {
      const kids = el("div", "children"); kids.hidden = true; node.appendChild(kids);
      let loaded = false;
      row.onclick = async () => {
        kids.hidden = !kids.hidden;
        row.querySelector(".ico").innerHTML = kids.hidden ? ICONS.folder : ICONS.folderOpen;
        if (!kids.hidden && !loaded) { loaded = true; kids.appendChild(el("div", "empty", "loading…")); await loadDir(e.path, kids, depth + 1); }
      };
    } else row.onclick = () => openFile(e.path);
    return node;
  }
  function applyFilter() {
    const f = filter.value.trim().toLowerCase();
    tree.querySelectorAll(".node").forEach((n) => { const row = n.querySelector(":scope > .row"); n.classList.toggle("dim", !!f && !row.dataset.path.toLowerCase().includes(f)); });
  }
  filter.addEventListener("input", applyFilter);

  async function setRoot(r) {
    root = r || null;
    rootLbl.textContent = root || "No working directory";
    rootLbl.title = root || "";
    if (!root) { tree.innerHTML = ""; loadedRoot = null; return; }
    if (root === loadedRoot) return;
    loadedRoot = root;
    tree.innerHTML = ""; tree.appendChild(el("div", "empty", "loading…"));
    await loadDir("", tree, 0);
    applyFilter();
  }
  async function refresh() { loadedRoot = null; await setRoot(root); }

  // --------------------------------------------------------------- preview
  function markActive(path) { tree.querySelectorAll(".row.active").forEach((r) => r.classList.remove("active")); const r = tree.querySelector(`.row[data-path="${CSS.escape(path)}"]`); r?.classList.add("active"); }
  async function openFile(path) {
    markActive(path);
    current = { path };
    pv.hidden = false; document.body.classList.add("preview-open");
    pvPath.textContent = path; pvPath.title = path; pvMeta.textContent = ""; pvRaw.hidden = true;
    pvBody.innerHTML = ""; pvBody.appendChild(el("div", "pv-note", "Loading…"));
    try {
      const d = await api(`/api/fs/read?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`);
      if (current?.path !== path) return;
      current = { path, data: d };
      renderPreview(d);
    } catch (e) { pvBody.innerHTML = ""; pvBody.appendChild(el("div", "pv-note err", e.message)); }
  }
  function renderPreview(d) {
    pvBody.innerHTML = "";
    pvMeta.textContent = [d.kind, d.size != null ? fmtBytes(d.size) : ""].filter(Boolean).join(" · ");
    pvRaw.hidden = d.kind !== "markdown";
    if (d.kind === "image") {
      if (d.tooBig) return pvBody.appendChild(el("div", "pv-note", `Image too large to preview (${fmtBytes(d.size)}).`));
      const img = el("img", "pv-img"); img.alt = current.path;
      img.src = `/api/fs/raw?root=${encodeURIComponent(root)}&path=${encodeURIComponent(current.path)}`;
      return pvBody.appendChild(img);
    }
    if (d.kind === "archive") return renderArchive(d);
    if (d.kind === "markdown" && !rawMode) { const m = el("div", "pv-md text"); m.innerHTML = md(d.content); return pvBody.appendChild(m); }
    if (d.kind === "markdown" || d.kind === "text") { const pre = el("pre", "pv-text", d.content); return pvBody.appendChild(pre); }
    pvBody.appendChild(el("div", "pv-note", d.tooBig ? `Too large to show (${fmtBytes(d.size)}).` : `No preview for ${d.ext || "this file"} (binary).`));
  }
  function renderArchive(d) {
    if (d.tooBig) return pvBody.appendChild(el("div", "pv-note", `Archive too large to read (${fmtBytes(d.size)}).`));
    const head = el("div", "pv-note", `${d.entries.length} entries inside ${current.path.split("/").pop()}`);
    const q = el("input", "pv-filter"); q.type = "search"; q.placeholder = "Filter entries";
    const list = el("div", "zip-tree"), out = el("div", "zip-entry"); out.hidden = true;
    const tree = buildTree(d.entries);
    const entryRow = (n, depth) => {
      const row = el("button", "zrow");
      row.style.paddingLeft = `${6 + Math.max(0, depth) * 14}px`;
      row.innerHTML = `${icon(fileKind(n.name))}<span class="name"></span><span class="size"></span>`;
      row.querySelector(".name").textContent = depth === -1 ? n.path : n.name;
      row.querySelector(".size").textContent = fmtBytes(n.size);
      row.title = `${n.path} · ${fmtBytes(n.size)} (${fmtBytes(n.compressed)} compressed)`;
      row.onclick = () => openEntry(n.entry, out);
      return row;
    };
    // Folders render their children only when opened, so a 3000-entry APK stays light.
    const folderNode = (n, depth) => {
      const node = el("div", "znode"), row = el("button", "zrow dir"), kids = el("div", "zkids");
      row.style.paddingLeft = `${6 + depth * 14}px`;
      row.innerHTML = `${icon("folder")}<span class="name"></span><span class="size"></span>`;
      row.querySelector(".name").textContent = n.name;
      row.querySelector(".size").textContent = `${n.count}`;
      row.title = `${n.path} · ${n.count} file${n.count === 1 ? "" : "s"}`;
      kids.hidden = true;
      let built = false;
      row.onclick = () => { kids.hidden = !kids.hidden; row.querySelector(".ico").innerHTML = kids.hidden ? ICONS.folder : ICONS.folderOpen; if (!built) { built = true; for (const k of n.children) kids.appendChild(k.dir ? folderNode(k, depth + 1) : entryRow(k, depth + 1)); } };
      node.append(row, kids);
      return node;
    };
    const draw = () => {
      const f = q.value.trim().toLowerCase();
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
    q.addEventListener("input", draw);
    draw();
    // The opened entry sits above the list so it is never buried under thousands of rows.
    pvBody.append(head, q, out, list);
  }
  async function openEntry(e, out) {
    out.hidden = false; out.innerHTML = ""; out.appendChild(el("div", "pv-note", `Reading ${e.path}…`));
    try {
      const d = await api(`/api/fs/archive-entry?root=${encodeURIComponent(root)}&path=${encodeURIComponent(current.path)}&entry=${encodeURIComponent(e.path)}`);
      out.innerHTML = "";
      const h = el("div", "zip-entry-head"); h.append(el("b", null, e.path), el("span", "size", fmtBytes(d.size)));
      const close = el("button", "btn quiet", "Close"); close.onclick = () => { out.hidden = true; out.innerHTML = ""; }; h.appendChild(close);
      out.appendChild(h);
      if (d.kind === "image") { const img = el("img", "pv-img"); img.src = `data:${d.mime};base64,${d.data}`; out.appendChild(img); }
      else if (d.kind === "markdown") { const m = el("div", "pv-md text"); m.innerHTML = md(d.content); out.appendChild(m); }
      else if (d.kind === "text") out.appendChild(el("pre", "pv-text", d.content));
      else out.appendChild(el("div", "pv-note", d.tooBig ? "Too large to show." : "Binary entry, no preview."));
      pvBody.scrollTop = 0;
    } catch (err) { out.innerHTML = ""; out.appendChild(el("div", "pv-note err", err.message)); }
  }
  function closePreview() { pv.hidden = true; document.body.classList.remove("preview-open"); current = null; tree.querySelectorAll(".row.active").forEach((r) => r.classList.remove("active")); }

  $("#pvClose").onclick = closePreview;
  $("#pvRef").onclick = () => { if (current) insert(`@${current.path} `); };
  pvRaw.onclick = () => { rawMode = !rawMode; pvRaw.textContent = rawMode ? "Rendered" : "Raw"; if (current?.data) renderPreview(current.data); };
  $("#explorerRefresh").onclick = refresh;
  $("#explorerClose").onclick = () => onClose?.();

  return { setRoot, refresh, openFile, closePreview, get root() { return root; } };
}
