/* Providers dialog: pick a preset, paste a key, type the model ids. Writes pi's models.json through the server. */
import { el, esc } from "./lib.js";

export function createSettings({ api, toast, onChanged }) {
  const $ = (s) => document.querySelector(s);
  const modal = $("#settings"), list = $("#provList"), form = $("#provForm");
  const f = {
    preset: $("#pfPreset"), name: $("#pfName"), baseUrl: $("#pfBase"), api: $("#pfApi"), key: $("#pfKey"), models: $("#pfModels"),
    ctx: $("#pfCtx"), max: $("#pfMax"), hint: $("#pfHint"), title: $("#pfTitle"), save: $("#pfSave"), del: $("#pfDelete"), file: $("#provFile"),
  };
  let data = { providers: [], presets: [], apis: [], active: null };
  let editing = null; // provider name being edited, or null for a new one

  function open() { modal.hidden = false; load(); }
  function close() { modal.hidden = true; }
  async function load() {
    try { data = await api("/api/providers"); } catch (e) { toast(e.message, true); return; }
    f.file.textContent = data.file || "";
    f.preset.innerHTML = data.presets.map((p) => `<option value="${esc(p.key)}">${esc(p.label)}</option>`).join("");
    f.api.innerHTML = data.apis.map((a) => `<option value="${esc(a)}">${esc(a)}</option>`).join("");
    renderList();
    if (editing && data.providers.some((p) => p.name === editing)) edit(editing);
    else if (data.providers.length) edit(data.providers[0].name);
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
      b.querySelector(".pm").textContent = `${p.models.length} model${p.models.length === 1 ? "" : "s"} · ${p.hasKey ? `key •••${p.keyHint}` : "no key"}`;
      b.onclick = () => edit(p.name);
      // The six-dot grip under each provider: drag (or arrow keys) to set the fallback order, top first.
      const grip = el("button", "prov-grip");
      grip.type = "button";
      grip.title = "Drag to reorder · top is tried first";
      grip.setAttribute("aria-label", `Move ${p.name} in the fallback order`);
      grip.addEventListener("pointerdown", (e) => startDrag(e, item, grip));
      grip.addEventListener("keydown", (e) => {
        const d = e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : 0;
        if (!d) return;
        e.preventDefault();
        const sib = d < 0 ? item.previousElementSibling : item.nextElementSibling;
        if (!sib || !sib.classList.contains("prov-item")) return;
        if (d < 0) list.insertBefore(item, sib); else list.insertBefore(sib, item);
        grip.focus();
        saveOrder();
      });
      item.append(b, grip);
      list.appendChild(item);
    }
    const add = el("button", "prov add", "+ Add provider");
    add.onclick = startNew;
    list.appendChild(add);
  }
  const items = () => [...list.querySelectorAll(".prov-item")];
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
        toast(`Fallback order: ${r.order.join(" → ")}`);
        onChanged?.();
      } catch (e) { toast(e.message, true); renderList(); }
    })();
    try { await saving; } finally { saving = null; }
  }
  function presetFor(key) { return data.presets.find((p) => p.key === key); }
  function applyPreset() {
    const p = presetFor(f.preset.value); if (!p) return;
    if (!editing) { f.name.value = p.key.startsWith("custom") ? "" : p.key; f.baseUrl.value = p.baseUrl; }
    f.api.value = p.api;
    f.hint.textContent = p.hint || "";
    f.baseUrl.placeholder = p.baseUrl || "https://host/v1";
  }
  function startNew() {
    editing = null;
    f.title.textContent = "New provider";
    f.name.disabled = false; f.name.value = ""; f.baseUrl.value = ""; f.key.value = ""; f.key.placeholder = "API key"; f.models.value = ""; f.ctx.value = ""; f.max.value = "";
    f.ctx.dataset.was = ""; f.max.dataset.was = "";
    f.preset.value = "openrouter"; applyPreset();
    f.del.hidden = true;
    renderList();
    f.name.focus();
  }
  function edit(name) {
    const p = data.providers.find((x) => x.name === name); if (!p) return;
    editing = name;
    f.title.textContent = name;
    const preset = data.presets.find((x) => x.baseUrl && x.baseUrl === p.baseUrl) || data.presets.find((x) => x.key === (p.api === "anthropic-messages" ? "custom-anthropic" : "custom-openai"));
    f.preset.value = preset?.key || "custom-openai";
    f.hint.textContent = preset?.hint || "";
    f.name.value = name; f.name.disabled = true;
    f.baseUrl.value = p.baseUrl; f.api.value = p.api;
    f.key.value = ""; f.key.placeholder = p.hasKey ? `•••••••• ${p.keyHint}  (leave empty to keep)` : "API key";
    f.models.value = p.models.map((m) => (m.name && m.name !== m.id ? `${m.id} | ${m.name}` : m.id)).join("\n");
    const cw = p.models[0]?.contextWindow, mt = p.models[0]?.maxTokens;
    f.ctx.value = cw || ""; f.max.value = mt || "";
    f.ctx.dataset.was = f.ctx.value; f.max.dataset.was = f.max.value;
    f.del.hidden = false;
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
  async function save() {
    const name = (editing || f.name.value).trim().toLowerCase();
    const body = { baseUrl: f.baseUrl.value.trim(), api: f.api.value, models: parseModels(f.models.value) };
    if (f.key.value.trim() || !editing) body.apiKey = f.key.value.trim();
    f.save.disabled = true;
    try {
      const r = await api(`/api/providers/${encodeURIComponent(name)}`, body, "PUT");
      toast(r.restarted ? `Saved ${name} · pi restarted with the new models` : `Saved ${name}`);
      editing = name;
      await load();
      onChanged?.();
    } catch (e) { toast(e.message, true); }
    finally { f.save.disabled = false; }
  }
  async function remove() {
    if (!editing || !window.confirm(`Remove provider "${editing}" and its models from pi's models.json?`)) return;
    try { await api(`/api/providers/${encodeURIComponent(editing)}`, null, "DELETE"); toast(`Removed ${editing}`); editing = null; await load(); onChanged?.(); }
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
