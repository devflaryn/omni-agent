/* File explorer (left column), VS Code style: folders load when opened and stay open across refreshes, one
   click opens a file in a preview tab and a double click keeps it, arrow keys walk the tree (F2 renames,
   Delete trashes), a right click (a long press on a phone) opens the file's menu, new files and renames are
   typed in place, and a row dragged onto a folder moves there (onto the prompt, it becomes an @reference).
   The tabs and viewers live in filepane.js. */
import { el, showName } from "./lib.js";
import { createFilePane } from "./filepane.js";
import { fileIcon, folderIcon, ICONS } from "./fileicons.js";
import { showMenu, onContext } from "./contextmenu.js";

const parentOf = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const nameOf = (p) => p.split("/").pop();
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export function createExplorer({ api, toast, insert, onClose, isRemote = () => false }) {
  const $ = (s) => document.querySelector(s);
  const tree = $("#tree"), rootLbl = $("#explorerRoot"), filter = $("#explorerFilter");
  let root = null, loadedRoot = null, selected = null, activePath = null;
  const nodes = new Map(); // path → { entry, el, row, kids, loaded, depth }
  const expandedBy = new Map(); // root → Set of open folder paths
  const expanded = () => { if (!expandedBy.has(root)) expandedBy.set(root, new Set()); return expandedBy.get(root); };

  const pane = createFilePane({
    api, toast, insert, isRemote,
    onActive: (r, p) => { if (r === root) { activePath = p; markActive(); } },
    revealInTree: (r, p) => { if (r === root) reveal(p); },
  });

  // ------------------------------------------------------------------ tree
  async function loadDir(path, container, depth) {
    try {
      const { entries } = await api(`/api/fs/list?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`);
      // Forget what was drawn under this folder before.
      for (const k of [...nodes.keys()]) if (k !== path && (path === "" || k.startsWith(`${path}/`))) nodes.delete(k);
      container.innerHTML = "";
      for (const e of entries) container.appendChild(nodeFor(e, depth));
      if (!entries.length) container.appendChild(el("div", "empty", "empty"));
      // Folders that were open stay open.
      await Promise.all(entries.filter((e) => e.dir && expanded().has(e.path)).map((e) => setOpen(nodes.get(e.path), true)));
      applyFilter(); markActive();
    } catch (e) { container.innerHTML = ""; container.appendChild(el("div", "empty err", e.message)); }
  }
  function nodeFor(e, depth) {
    const node = el("div", "node"), row = el("div", "row");
    row.tabIndex = -1;
    row.setAttribute("role", "treeitem");
    row.dataset.path = e.path;
    row.style.setProperty("--depth", depth);
    row.innerHTML = `<span class="tw">${e.dir ? ICONS.chevron : ""}</span>${e.dir ? folderIcon(false) : fileIcon(e.name)}<span class="name"></span>`;
    row.querySelector(".name").textContent = showName(e.name);
    row.title = showName(e.path) + (e.link ? " (link)" : "");
    if (e.dir) row.setAttribute("aria-expanded", "false");
    row.draggable = true;
    node.appendChild(row);
    const n = { entry: e, el: node, row, kids: null, loaded: false, depth };
    if (e.dir) { n.kids = el("div", "children"); n.kids.hidden = true; n.kids.style.setProperty("--depth", depth); n.kids.setAttribute("role", "group"); node.appendChild(n.kids); }
    nodes.set(e.path, n);
    return node;
  }
  async function setOpen(n, open) {
    if (!n?.entry.dir) return;
    n.kids.hidden = !open;
    n.row.setAttribute("aria-expanded", String(open));
    n.row.querySelector(".ico").outerHTML = folderIcon(open);
    if (open) expanded().add(n.entry.path); else expanded().delete(n.entry.path);
    if (open && !n.loaded) { n.loaded = true; n.kids.appendChild(el("div", "empty", "loading…")); await loadDir(n.entry.path, n.kids, n.depth + 1); }
  }
  /** Re-list one folder ("" = the root), keeping what was open. */
  async function reloadDir(path) {
    if (!path) return loadDir("", tree, 0);
    const n = nodes.get(path);
    if (!n) return reloadDir(parentOf(path));
    n.loaded = true;
    if (n.kids.hidden) { n.loaded = false; return; }
    await loadDir(path, n.kids, n.depth + 1);
  }
  /** Open every folder down to `path`, then select and show it. */
  async function reveal(path) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const p = parts.slice(0, i).join("/");
      const n = nodes.get(p);
      if (!n) break;
      if (n.kids.hidden || !n.loaded) await setOpen(n, true);
    }
    select(path, { scroll: true });
  }

  function applyFilter() {
    const f = filter.value.trim().toLowerCase();
    tree.querySelectorAll(".node").forEach((n) => { const row = n.querySelector(":scope > .row"); n.classList.toggle("dim", !!f && !row.dataset.path.toLowerCase().includes(f)); });
  }
  filter.addEventListener("input", applyFilter);

  function markActive() {
    tree.querySelectorAll(".row.active").forEach((r) => r.classList.remove("active"));
    if (activePath) nodes.get(activePath)?.row.classList.add("active");
  }
  function select(path, { scroll = false, focus = false } = {}) {
    tree.querySelectorAll(".row.sel").forEach((r) => r.classList.remove("sel"));
    selected = path;
    const n = nodes.get(path);
    if (!n) return;
    n.row.classList.add("sel");
    if (scroll) n.row.scrollIntoView({ block: "nearest" });
    if (focus) n.row.focus({ preventScroll: !scroll });
  }
  const visibleRows = () => [...tree.querySelectorAll(".row")].filter((r) => r.offsetParent !== null);

  async function setRoot(r) {
    root = r || null;
    rootLbl.textContent = root || "No working directory";
    rootLbl.title = root || "";
    if (!root) { tree.innerHTML = ""; loadedRoot = null; nodes.clear(); return; }
    if (root === loadedRoot) return;
    loadedRoot = root; nodes.clear(); selected = null;
    tree.innerHTML = ""; tree.appendChild(el("div", "empty", "loading…"));
    await loadDir("", tree, 0);
  }
  async function refresh() { if (!root) return; loadedRoot = root; await loadDir("", tree, 0); }
  async function collapseAll() { expanded().clear(); await refresh(); }

  // ------------------------------------------------------------- pointer
  tree.addEventListener("click", (e) => {
    const row = e.target.closest(".row");
    if (!row || e.target.closest("input")) return;
    const n = nodes.get(row.dataset.path);
    if (!n) return;
    select(n.entry.path, { focus: true });
    if (n.entry.dir) setOpen(n, n.kids.hidden);
    else pane.open(root, n.entry.path);
  });
  tree.addEventListener("dblclick", (e) => {
    const row = e.target.closest(".row");
    const n = row && nodes.get(row.dataset.path);
    if (n && !n.entry.dir) pane.open(root, n.entry.path, { pin: true });
  });
  onContext(tree, (x, y, e) => {
    const row = e.target?.closest?.(".row");
    const n = row && nodes.get(row.dataset.path);
    if (n) select(n.entry.path);
    showMenu(x, y, n ? menuFor(n) : rootMenu());
  });

  // -------------------------------------------------------------- keyboard
  tree.addEventListener("keydown", (e) => {
    if (e.target.closest("input")) return;
    const rows = visibleRows();
    const i = rows.findIndex((r) => r.dataset.path === selected);
    const n = nodes.get(selected);
    const go = (r) => { if (r) { e.preventDefault(); select(r.dataset.path, { scroll: true, focus: true }); } };
    switch (e.key) {
      case "ArrowDown": return go(rows[i + 1] || rows[0]);
      case "ArrowUp": return go(rows[i - 1] || rows[rows.length - 1]);
      case "Home": return go(rows[0]);
      case "End": return go(rows[rows.length - 1]);
      case "ArrowRight": if (n?.entry.dir) { e.preventDefault(); if (n.kids.hidden) setOpen(n, true); else go(n.kids.querySelector(".row")); } return;
      case "ArrowLeft": if (n) { e.preventDefault(); if (n.entry.dir && !n.kids.hidden) setOpen(n, false); else { const p = nodes.get(parentOf(n.entry.path)); if (p) select(p.entry.path, { scroll: true, focus: true }); } } return;
      case "Enter": if (n) { e.preventDefault(); if (n.entry.dir) setOpen(n, n.kids.hidden); else pane.open(root, n.entry.path, { pin: true }); } return;
      case " ": if (n && !n.entry.dir) { e.preventDefault(); pane.open(root, n.entry.path); } return;
      case "F2": if (n) { e.preventDefault(); rename(n); } return;
      case "Delete": if (n) { e.preventDefault(); remove(n, { permanent: e.shiftKey }); } return;
      case "Backspace": if (n && (e.metaKey || e.ctrlKey)) { e.preventDefault(); remove(n); } return;
      case "ContextMenu": if (n) { e.preventDefault(); const r = n.row.getBoundingClientRect(); showMenu(r.left + 24, r.bottom, menuFor(n)); } return;
    }
    if ((e.ctrlKey || e.metaKey) && e.altKey && e.key.toLowerCase() === "c" && n) { e.preventDefault(); pane.copy(pane.absPath(root, n.entry.path)); }
  });
  // A row picked up with no selection yet (keyboard focus lands on the tree).
  tree.addEventListener("focus", () => { if (!selected) { const r = visibleRows()[0]; if (r) select(r.dataset.path); } });

  // --------------------------------------------------------------- dragging
  tree.addEventListener("dragstart", (e) => {
    const row = e.target.closest?.(".row");
    if (!row) return;
    e.dataTransfer.setData("application/x-omni-path", row.dataset.path);
    // Dropped on the prompt (or any text field) it becomes a reference.
    e.dataTransfer.setData("text/plain", `@${row.dataset.path} `);
    e.dataTransfer.effectAllowed = "copyMove";
  });
  const dropTarget = (e) => {
    const row = e.target.closest?.(".row");
    if (!row) return e.target === tree || tree.contains(e.target) ? "" : null;
    const n = nodes.get(row.dataset.path);
    return n?.entry.dir ? n.entry.path : parentOf(row.dataset.path);
  };
  const clearDrop = () => tree.querySelectorAll(".drop").forEach((r) => r.classList.remove("drop"));
  tree.addEventListener("dragover", (e) => {
    if (!e.dataTransfer.types.includes("application/x-omni-path")) return;
    const to = dropTarget(e);
    if (to == null) return;
    e.preventDefault(); e.dataTransfer.dropEffect = "move";
    clearDrop();
    (to ? nodes.get(to)?.row : tree)?.classList.add("drop");
  });
  tree.addEventListener("dragleave", (e) => { if (!tree.contains(e.relatedTarget)) clearDrop(); });
  tree.addEventListener("drop", async (e) => {
    const from = e.dataTransfer.getData("application/x-omni-path");
    clearDrop();
    const to = dropTarget(e);
    if (!from || to == null) return;
    e.preventDefault();
    const dest = to ? `${to}/${nameOf(from)}` : nameOf(from);
    if (dest === from || to === from || to.startsWith(`${from}/`)) return;
    if (!window.confirm(`Move “${showName(nameOf(from))}” into “${showName(to || nameOf(root.replace(/[\\/]+$/, "")) || "the root")}”?`)) return;
    await moveTo(from, dest);
  });

  // ---------------------------------------------------------- file actions
  const post = (path, body) => api(path, { root, ...body });
  async function moveTo(from, to) {
    try {
      const r = await post("/api/fs/rename", { path: from, to });
      pane.renamed(root, from, r.path);
      const ex = expanded();
      for (const p of [...ex]) if (p === from || p.startsWith(`${from}/`)) { ex.delete(p); ex.add(r.path + p.slice(from.length)); }
      if (activePath && (activePath === from || activePath.startsWith(`${from}/`))) activePath = r.path + activePath.slice(from.length);
      await reloadDir(parentOf(from));
      if (parentOf(r.path) !== parentOf(from)) await reloadDir(parentOf(r.path));
      await reveal(r.path);
      return r.path;
    } catch (e) { toast(e.message, true); return null; }
  }

  /** An input typed in place (rename, new file): resolves to the text, or null on Escape / empty. */
  function typeIn({ host, initial = "", selectStem = false, onCheck }) {
    return new Promise((resolve) => {
      const input = el("input", "row-input");
      input.value = initial; input.spellcheck = false;
      input.setAttribute("autocapitalize", "off"); input.setAttribute("autocorrect", "off");
      host.appendChild(input);
      input.focus();
      const dot = initial.lastIndexOf(".");
      if (selectStem && dot > 0) input.setSelectionRange(0, dot); else input.select();
      let done = false;
      const finish = (v) => { if (done) return; done = true; input.remove(); resolve(v); };
      input.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") { e.preventDefault(); const v = input.value.trim(); finish(v && v !== initial ? v : null); }
        else if (e.key === "Escape") { e.preventDefault(); finish(null); }
      });
      input.addEventListener("input", () => { const err = onCheck?.(input.value.trim()); input.classList.toggle("bad", !!err); input.title = err || ""; });
      input.addEventListener("blur", () => { const v = input.value.trim(); finish(v && v !== initial ? v : null); });
      input.addEventListener("click", (e) => e.stopPropagation());
    });
  }
  const badName = (v) => (/[\\:*?"<>|]/.test(v) ? "A name cannot contain \\ : * ? \" < > |" : /(^|\/)\.\.?(\/|$)/.test(v) ? "Not . or .." : "");

  async function rename(n) {
    const name = n.row.querySelector(".name");
    name.hidden = true;
    const v = await typeIn({ host: n.row, initial: n.entry.name, selectStem: !n.entry.dir, onCheck: (x) => (x.includes("/") ? "" : badName(x)) });
    name.hidden = false;
    n.row.focus();
    if (!v || badName(v)) return;
    const parent = parentOf(n.entry.path);
    await moveTo(n.entry.path, parent ? `${parent}/${v}` : v);
  }

  async function create(dirPath, { dir = false } = {}) {
    // Inside the folder: open it first, the new row goes at its top.
    let container = tree, depth = 0;
    if (dirPath) { const d = nodes.get(dirPath); if (!d) return; await setOpen(d, true); container = d.kids; depth = d.depth + 1; }
    const ghost = el("div", "node"), row = el("div", "row ghost");
    row.style.setProperty("--depth", depth);
    row.innerHTML = `<span class="tw"></span>${dir ? folderIcon(false) : fileIcon("x.txt")}`;
    ghost.appendChild(row);
    container.prepend(ghost);
    row.scrollIntoView({ block: "nearest" });
    const v = await typeIn({ host: row, onCheck: (x) => { if (!dir) row.querySelector(".ico").outerHTML = fileIcon(x || "x.txt"); return badName(x); } });
    ghost.remove();
    if (!v || badName(v)) return;
    const path = dirPath ? `${dirPath}/${v.replace(/^\/+/, "")}` : v.replace(/^\/+/, "");
    try {
      const r = await post("/api/fs/create", { path, dir });
      await reloadDir(dirPath);
      await reveal(r.path);
      if (!dir) pane.open(root, r.path, { pin: true });
    } catch (e) { toast(e.message, true); }
  }

  async function remove(n, { permanent = false } = {}) {
    const what = `${n.entry.dir ? "the folder " : ""}“${showName(n.entry.name)}”${n.entry.dir ? " and everything in it" : ""}`;
    if (!window.confirm(permanent ? `Permanently delete ${what}? This cannot be undone.` : `Move ${what} to the trash?`)) return;
    try {
      try { await post("/api/fs/delete", { path: n.entry.path, permanent }); }
      catch (e) {
        if (!e.body?.trashFailed) throw e;
        if (!window.confirm(`${e.message}.\n\nDelete ${what} permanently instead? This cannot be undone.`)) return;
        await post("/api/fs/delete", { path: n.entry.path, permanent: true });
      }
      pane.deleted(root, n.entry.path);
      for (const p of [...expanded()]) if (p === n.entry.path || p.startsWith(`${n.entry.path}/`)) expanded().delete(p);
      await reloadDir(parentOf(n.entry.path));
    } catch (e) { toast(e.message, true); }
  }

  async function duplicate(n) {
    try { const r = await post("/api/fs/duplicate", { path: n.entry.path }); await reloadDir(parentOf(n.entry.path)); await reveal(r.path); }
    catch (e) { toast(e.message, true); }
  }
  async function revealOnHost(path) {
    try { await post("/api/fs/reveal", { path }); } catch (e) { toast(e.message, true); }
  }
  const revealLabel = isMac ? "Reveal in Finder" : /Win/.test(navigator.platform || navigator.userAgent) ? "Reveal in File Explorer" : "Open Containing Folder";

  function menuFor(n) {
    const p = n.entry.path, dir = n.entry.dir, here = dir ? p : parentOf(p);
    const k = (win, mac) => (isMac ? mac : win);
    return [
      !dir && { label: "Open", action: () => pane.open(root, p, { pin: true }) },
      !dir && { label: "Open as Text (read-only)", action: () => pane.open(root, p, { pin: true, mode: "text" }) },
      !dir && { label: "Open in Hex Viewer", action: () => pane.open(root, p, { pin: true, mode: "hex" }) },
      dir && { label: n.kids.hidden ? "Expand" : "Collapse", action: () => setOpen(n, n.kids.hidden) },
      "-",
      { label: "New File…", action: () => create(here) },
      { label: "New Folder…", action: () => create(here, { dir: true }) },
      "-",
      { label: "Reference in Prompt", action: () => insert(`@${p} `) },
      "-",
      { label: "Copy Path", kbd: k("Ctrl+Alt+C", "⌥⌘C"), action: () => pane.copy(pane.absPath(root, p)) },
      { label: "Copy Relative Path", action: () => pane.copy(p) },
      { label: "Copy Name", action: () => pane.copy(n.entry.name) },
      !dir && { label: "Download", action: () => pane.download(root, p) },
      !isRemote() && { label: revealLabel, action: () => revealOnHost(p) },
      "-",
      { label: "Rename…", kbd: "F2", action: () => rename(n) },
      { label: "Duplicate", action: () => duplicate(n) },
      { label: "Move to Trash", kbd: k("Delete", "⌘⌫"), action: () => remove(n), danger: true },
      { label: "Delete Permanently", kbd: "Shift+Del", action: () => remove(n, { permanent: true }), danger: true },
      ...(dir ? ["-", { label: "Refresh", action: () => { n.loaded = false; if (!n.kids.hidden) reloadDir(p); } }] : []),
    ];
  }
  function rootMenu() {
    return [
      { label: "New File…", action: () => create("") },
      { label: "New Folder…", action: () => create("", { dir: true }) },
      "-",
      { label: "Refresh", action: refresh },
      { label: "Collapse All", action: collapseAll },
      "-",
      { label: "Copy Path", action: () => pane.copy(root) },
      !isRemote() && { label: revealLabel, action: () => revealOnHost("") },
    ];
  }

  // ---------------------------------------------------------------- header
  const selectedDir = () => { const n = nodes.get(selected); return n ? (n.entry.dir ? n.entry.path : parentOf(n.entry.path)) : ""; };
  $("#explorerNewFile").onclick = () => root && create(selectedDir());
  $("#explorerNewFolder").onclick = () => root && create(selectedDir(), { dir: true });
  $("#explorerCollapse").onclick = () => root && collapseAll();
  $("#explorerRefresh").onclick = refresh;
  $("#explorerClose").onclick = () => onClose?.();

  return {
    setRoot, refresh,
    openFile: (path) => pane.open(root, path, { pin: true }),
    closePreview: () => pane.hide(),
    restorePreview: () => pane.restore(),
    get root() { return root; },
  };
}
