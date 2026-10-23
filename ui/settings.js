/* Providers dialog: Omni's custom OpenAI-compatible providers (base URL, key, model ids), rendered into OpenCode's
   config, and API keys for OpenCode's own providers (OpenCode's auth store), all through the server.
   Its Long runs tab holds the context policy (compaction cap, keep going on context stops): PUT /api/context. */
import { el, esc, compactAtFromField, compactAtK } from "./lib.js";
import { createMcpSettings } from "./mcp-settings.js";

/** `getContext()` → the saved context policy (`/api/state.config.context`); `onContext(policy)` after a save. */
export function createSettings({ api, toast, onChanged, loadRemote, getContext = () => null, onContext }) {
  const $ = (s) => document.querySelector(s);
  const modal = $("#settings"), list = $("#provList"), form = $("#provForm");
  const f = {
    preset: $("#pfPreset"), name: $("#pfName"), baseUrl: $("#pfBase"), key: $("#pfKey"), models: $("#pfModels"),
    ctx: $("#pfCtx"), max: $("#pfMax"), hint: $("#pfHint"), title: $("#pfTitle"), save: $("#pfSave"), del: $("#pfDelete"), file: $("#provFile"),
  };
  /** The form rows only a custom provider has (a key for one of OpenCode's own providers is just the key). */
  const customRows = [$("#pfBaseRow"), $("#pfModelsRow"), $("#pfLimits")];
  const keyRow = $("#pfKeyRow");
  let data = { providers: [], opencode: [], presets: [], active: null };
  let editing = null; // custom provider name being edited, or null for a new one
  let keyFor = null; // the OpenCode provider id whose key the form edits (key mode), or null

  const mcp = createMcpSettings({ api, toast, onChanged });
  // Four tabs in one dialog: the models OpenCode can use, the MCP servers it connects to, remote access (host only) and long runs.
  const tabs = { models: { btn: $("#tabModels"), body: $("#provBody"), sub: $("#subModels") }, mcp: { btn: $("#tabMcp"), body: $("#mcpBody"), sub: $("#subMcp") }, remote: { btn: $("#tabRemote"), body: $("#remoteBody"), sub: $("#subRemote") }, long: { btn: $("#tabLong"), body: $("#longBody"), sub: $("#subLong") } };
  let tab = "models";
  function showTab(name) {
    tab = name;
    for (const [k, t] of Object.entries(tabs)) {
      const on = k === name;
      t.btn.classList.toggle("active", on); t.btn.setAttribute("aria-selected", String(on));
      t.body.hidden = !on; t.sub.hidden = !on;
    }
    if (name === "mcp") mcp.load(); else if (name === "remote") loadRemote?.(); else if (name === "long") renderLong(); else load();
  }
  tabs.models.btn.onclick = () => showTab("models");
  tabs.mcp.btn.onclick = () => showTab("mcp");
  tabs.remote.btn.onclick = () => showTab("remote");
  tabs.long.btn.onclick = () => showTab("long");

  // ------------------------------------------------------------ long runs
  function renderLong() {
    const body = tabs.long.body;
    const ctx = { compactAt: 256000, autoContinue: true, ...(getContext?.() || {}) };
    body.innerHTML = "";
    const wrap = el("div", "rm-wrap");
    const sec = el("section", "rm-sec");
    sec.appendChild(el("h3", null, "Context"));
    const row = el("label", "lr-row");
    const k = el("input");
    k.type = "number"; k.min = "0"; k.step = "1"; k.id = "lrCompact"; k.value = String(compactAtK(ctx.compactAt));
    row.append("Compact chats at", k, "k tokens", el("span", "pf-note", "0 = off"));
    sec.appendChild(row);
    sec.appendChild(el("p", "rm-note", "Omni has OpenCode summarize the older part of a chat once its prompt reaches this size, so a long run keeps a sharp model instead of filling the model's whole window. It applies to every model with a larger window; smaller ones keep OpenCode's own limit."));
    const chk = el("label", "lr-check");
    const cb = el("input");
    cb.type = "checkbox"; cb.id = "lrAuto"; cb.checked = ctx.autoContinue !== false;
    chk.append(cb, "Keep going when the model stops for context");
    sec.appendChild(chk);
    sec.appendChild(el("p", "rm-note", "Models sometimes stop mid-task to say their context is nearly full. Omni then compacts if it needs to and tells the model to carry on, even with the goal hook off. A question to you, a finished answer or your Stop is left alone."));
    const save = el("button", "btn primary", "Save");
    save.onclick = async () => {
      const p = compactAtFromField(k.value, ctx.compactAt);
      if (p.error) { toast(p.error, true); k.focus(); return; }
      const patch = { compactAt: p.compactAt, autoContinue: cb.checked };
      save.disabled = true;
      try {
        const r = await api("/api/context", patch, "PUT");
        const saved = r.context || { ...ctx, ...patch };
        onContext?.(saved);
        ctx.compactAt = saved.compactAt;
        k.value = String(compactAtK(saved.compactAt));
        toast(`${saved.compactAt ? `Chats compact at ${compactAtK(saved.compactAt)}k tokens` : "Compaction cap off"} · ${saved.autoContinue ? "keeps going on context stops" : "context stops are left alone"}`);
      } catch (e) { toast(e.message, true); }
      finally { save.disabled = false; }
    };
    k.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); save.click(); } });
    sec.appendChild(save);
    wrap.appendChild(sec);
    body.appendChild(wrap);
  }

  function open(which = tab) { modal.hidden = false; showTab(which); }
  function close() { modal.hidden = true; }
  async function load() {
    try { data = await api("/api/providers"); } catch (e) { toast(e.message, true); return; }
    data.opencode ||= [];
    f.file.textContent = data.file || "";
    const group = (kind, label) => `<optgroup label="${esc(label)}">${data.presets.filter((p) => p.kind === kind).map((p) => `<option value="${esc(p.key)}">${esc(p.label)}</option>`).join("")}</optgroup>`;
    f.preset.innerHTML = group("key", "OpenCode's own providers · key only") + group("custom", "Your own endpoint · OpenAI-compatible");
    renderList();
    if (keyFor && data.opencode.some((p) => p.id === keyFor)) editKey(keyFor);
    else if (editing && data.providers.some((p) => p.name === editing)) edit(editing);
    else if (data.providers.length) edit(data.providers[0].name);
    else if (data.opencode.length) editKey(data.opencode[0].id);
    else startNew();
  }
  function renderList() {
    list.innerHTML = "";
    for (const p of data.providers) {
      const item = el("div", "prov-item");
      item.dataset.name = p.name;
      const b = el("button", `prov${p.name === editing ? " active" : ""}`);
      const on = data.active?.provider === p.name;
      b.innerHTML = `<span class="pn"></span><span class="pm"></span>`;
      b.querySelector(".pn").textContent = p.name + (on ? " · active" : "");
      b.querySelector(".pm").textContent = p.builtIn
        ? `${p.models.length} Omni-added model${p.models.length === 1 ? "" : "s"} · OpenCode's ${p.name}`
        : `${p.models.length} model${p.models.length === 1 ? "" : "s"} · ${p.hasKey ? `key •••${p.keyHint}` : "no key"}`;
      b.onclick = () => edit(p.name);
      // The six-dot grip under each provider: drag (or arrow keys) to set the order of Omni's providers.
      const grip = el("button", "prov-grip");
      grip.type = "button";
      grip.title = "Drag to reorder";
      grip.setAttribute("aria-label", `Move ${p.name} in the provider order`);
      grip.addEventListener("pointerdown", (e) => startDrag(e, item, grip));
      grip.addEventListener("keydown", (e) => {
        const d = e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : 0;
        if (!d) return;
        e.preventDefault();
        const sib = d < 0 ? item.previousElementSibling : item.nextElementSibling;
        if (!sib || !sib.classList.contains("prov-item") || !sib.dataset.name) return;
        if (d < 0) list.insertBefore(item, sib); else list.insertBefore(sib, item);
        grip.focus();
        saveOrder();
      });
      item.append(b, grip);
      list.appendChild(item);
    }
    // OpenCode's own connected providers (a key, a login, or the user's global OpenCode config): their key is edited here.
    for (const p of data.opencode) {
      const item = el("div", "prov-item");
      const b = el("button", `prov${p.id === keyFor ? " active" : ""}`);
      b.innerHTML = `<span class="pn"></span><span class="pm"></span>`;
      b.querySelector(".pn").textContent = p.id + (data.active?.provider === p.id ? " · active" : "");
      b.querySelector(".pm").textContent = `OpenCode${p.name && p.name !== p.id ? ` · ${p.name}` : ""} · connected`;
      b.onclick = () => editKey(p.id);
      item.append(b);
      list.appendChild(item);
    }
    const add = el("button", "prov add", "+ Add provider or key");
    add.onclick = startNew;
    list.appendChild(add);
  }
  // Only Omni's own providers (they carry data-name) can be reordered.
  const items = () => [...list.querySelectorAll(".prov-item[data-name]")];
  const currentOrder = () => items().map((it) => it.dataset.name);
  function startDrag(e, item, grip) {
    if (e.button != null && e.button !== 0) return;
    e.preventDefault();
    const row = getComputedStyle(list).flexDirection.startsWith("row");
    const axis = (ev) => (row ? ev.clientX : ev.clientY);
    const mid = (r) => (row ? r.left + r.width / 2 : r.top + r.height / 2);
    const pid = e.pointerId;
    item.classList.add("dragging");
    // Listeners live on the window: moving the item in the DOM would release a pointer capture on the grip.
    const move = (ev) => {
      if (ev.pointerId !== pid) return;
      const pos = axis(ev);
      const others = items().filter((it) => it !== item);
      const before = others.find((it) => pos < mid(it.getBoundingClientRect()));
      if (before) { if (item.nextElementSibling !== before) list.insertBefore(item, before); }
      else { const last = others[others.length - 1]; if (last && last.nextElementSibling !== item) list.insertBefore(item, last.nextElementSibling); }
    };
    let done = false;
    const up = (ev) => {
      if (ev.pointerId !== pid || done) return;
      done = true;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      item.classList.remove("dragging");
      grip.focus({ preventScroll: true });
      saveOrder();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }
  let saving = null;
  async function saveOrder() {
    if (saving) await saving;
    const order = currentOrder();
    if (order.join("\n") === data.providers.map((p) => p.name).join("\n")) return;
    saving = (async () => {
      try {
        const r = await api("/api/providers-order", { order }, "POST");
        data.providers = r.providers;
        toast(`Provider order: ${r.order.join(" → ")}`);
        onChanged?.();
      } catch (e) { toast(e.message, true); renderList(); }
    })();
    try { await saving; } finally { saving = null; }
  }
  function presetFor(key) { return data.presets.find((p) => p.key === key); }
  /** "key": the form sets the API key of one of OpenCode's own providers; "custom": one of Omni's endpoints. */
  const keyMode = () => presetFor(f.preset.value)?.kind === "key";
  const KEY_NOTE = "Saved in OpenCode's own login store (auth.json), which the opencode CLI on this computer shares.";
  function showMode() {
    const key = keyMode();
    for (const row of customRows) if (row) row.hidden = key;
    if (keyRow) keyRow.hidden = false;
    f.del.textContent = key ? "Remove key" : "Remove provider";
  }
  /** The entry being edited only adds models to one of OpenCode's own providers (no URL or key of its own). */
  const editingBuiltIn = () => !!editing && !!data.providers.find((x) => x.name === editing)?.builtIn;
  function applyPreset() {
    const p = presetFor(f.preset.value); if (!p) return;
    showMode();
    if (p.kind === "key") {
      f.name.value = p.anyId ? "" : p.key; f.name.disabled = !p.anyId; f.name.placeholder = "moonshotai";
      f.hint.textContent = `${p.hint || ""} · ${KEY_NOTE}`;
      return;
    }
    f.name.disabled = false; f.name.placeholder = "modal";
    if (!editing) { f.name.value = p.key === "custom" ? "" : p.key; f.baseUrl.value = p.baseUrl || ""; }
    f.hint.textContent = p.hint || "";
    f.baseUrl.placeholder = p.baseUrl || "https://host/v1";
  }
  function startNew() {
    editing = null; keyFor = null;
    f.title.textContent = "New provider or key";
    f.preset.disabled = false;
    f.name.disabled = false; f.name.value = ""; f.baseUrl.value = ""; f.key.value = ""; f.key.placeholder = "API key"; f.models.value = ""; f.ctx.value = ""; f.max.value = "";
    f.ctx.dataset.was = ""; f.max.dataset.was = "";
    f.preset.value = "openrouter"; applyPreset();
    f.del.hidden = true;
    renderList();
    f.key.focus();
  }
  /** One of OpenCode's own connected providers: only its key can be replaced or removed here. */
  function editKey(id) {
    editing = null; keyFor = id;
    f.title.textContent = `${id} · OpenCode`;
    f.preset.value = presetFor(id)?.kind === "key" ? id : "opencode-other";
    f.preset.disabled = true;
    showMode();
    f.name.value = id; f.name.disabled = true;
    f.key.value = ""; f.key.placeholder = "paste a new key to replace OpenCode's";
    f.hint.textContent = `Connected in OpenCode. ${KEY_NOTE}`;
    f.del.hidden = false;
    renderList();
  }
  function edit(name) {
    const p = data.providers.find((x) => x.name === name); if (!p) return;
    editing = name; keyFor = null;
    f.title.textContent = name;
    const preset = data.presets.find((x) => x.kind === "custom" && x.baseUrl && x.baseUrl === p.baseUrl) || presetFor("custom");
    f.preset.value = preset?.key || "custom";
    f.preset.disabled = true;
    showMode();
    f.hint.textContent = preset?.hint || "";
    f.name.value = name; f.name.disabled = true;
    f.baseUrl.value = p.baseUrl;
    f.key.value = ""; f.key.placeholder = p.hasKey ? `•••••••• ${p.keyHint}  (leave empty to keep)` : "API key";
    f.models.value = p.models.map((m) => (m.name && m.name !== m.id ? `${m.id} | ${m.name}` : m.id)).join("\n");
    const cw = p.models[0]?.contextWindow, mt = p.models[0]?.maxTokens;
    f.ctx.value = cw || ""; f.max.value = mt || "";
    f.ctx.dataset.was = f.ctx.value; f.max.dataset.was = f.max.value;
    f.del.hidden = false;
    if (p.builtIn) {
      // Extra models for one of OpenCode's own providers: OpenCode's definition and stored key apply, so no URL or key here.
      f.title.textContent = `${name} · Omni-added models`;
      $("#pfBaseRow").hidden = true;
      if (keyRow) keyRow.hidden = true;
      f.hint.textContent = `Models OpenCode's ${name} does not list, added to it by Omni. Its key is set in its own row below.`;
      f.del.textContent = "Remove these models";
    }
    renderList();
  }
  function parseModels(text) {
    return String(text || "").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map((l) => {
      const [id, name] = l.split("|").map((s) => s.trim());
      const m = { id };
      if (name) m.name = name;
      // Only push the shared limits when the user actually changed them, so per-model values in the file survive.
      if (f.ctx.value && f.ctx.value !== f.ctx.dataset.was) m.contextWindow = Number(f.ctx.value);
      if (f.max.value && f.max.value !== f.max.dataset.was) m.maxTokens = Number(f.max.value);
      return m;
    });
  }
  const reloaded = (r) => (r.restarted ? " · OpenCode reloaded" : r.restartPending ? " · OpenCode reloads once the chats are idle" : "");
  async function save() {
    if (keyMode()) return saveKey();
    const name = (editing || f.name.value).trim().toLowerCase();
    const body = editingBuiltIn() ? { builtIn: true, models: parseModels(f.models.value) } : { baseUrl: f.baseUrl.value.trim(), models: parseModels(f.models.value) };
    if (!body.builtIn && (f.key.value.trim() || !editing)) body.apiKey = f.key.value.trim();
    f.save.disabled = true;
    try {
      const r = await api(`/api/providers/${encodeURIComponent(name)}`, body, "PUT");
      toast(`Saved ${name}${reloaded(r)}`);
      editing = name;
      await load();
      onChanged?.();
    } catch (e) { toast(e.message, true); }
    finally { f.save.disabled = false; }
  }
  async function saveKey() {
    const p = presetFor(f.preset.value);
    const id = (keyFor || (p?.anyId ? f.name.value : p?.key) || "").trim().toLowerCase();
    const key = f.key.value.trim();
    if (!id) { toast("type the OpenCode provider id", true); f.name.focus(); return; }
    if (!key) { toast("paste the API key", true); f.key.focus(); return; }
    f.save.disabled = true;
    try {
      const r = await api(`/api/provider-keys/${encodeURIComponent(id)}`, { key }, "PUT");
      toast(`Saved the key for ${id}${reloaded(r)}`);
      keyFor = id; editing = null;
      await load();
      onChanged?.();
    } catch (e) { toast(e.message, true); }
    finally { f.save.disabled = false; }
  }
  async function remove() {
    if (keyFor) {
      if (!window.confirm(`Remove OpenCode's key for "${keyFor}"? It is removed from OpenCode's own login store, which the opencode CLI shares.`)) return;
      try { const r = await api(`/api/provider-keys/${encodeURIComponent(keyFor)}`, null, "DELETE"); toast(`Removed the key for ${keyFor}${reloaded(r)}`); keyFor = null; await load(); onChanged?.(); }
      catch (e) { toast(e.message, true); }
      return;
    }
    const confirmText = editingBuiltIn() ? `Remove the models Omni added to OpenCode's "${editing}"? OpenCode's own models and key stay.` : `Remove provider "${editing}" and its models from OpenCode?`;
    if (!editing || !window.confirm(confirmText)) return;
    try { const r = await api(`/api/providers/${encodeURIComponent(editing)}`, null, "DELETE"); toast(`Removed ${editing}${reloaded(r)}`); editing = null; await load(); onChanged?.(); }
    catch (e) { toast(e.message, true); }
  }

  f.preset.addEventListener("change", applyPreset);
  f.save.onclick = save;
  f.del.onclick = remove;
  form.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target !== f.models) { e.preventDefault(); save(); } });
  $("#settingsClose").onclick = close;
  modal.addEventListener("click", (e) => { if (e.target === modal) close(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !modal.hidden) close(); });
  return { open, close };
}
