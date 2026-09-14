/* The composer card: textarea, + menu (file / memory / repo graph), model + thinking pill, send/stop. pi only. */
import { el, esc } from "./lib.js";

export function createComposer(root, h) {
  root.innerHTML = `
  <div class="composer">
    <textarea rows="1" placeholder="${esc(h.placeholder || "Do anything")}"></textarea>
    <div class="composer-bar">
      <div class="menu-wrap">
        <button class="cbtn round" data-role="plus" title="Attach">+</button>
        <div class="menu up" data-role="plusMenu" hidden>
          <button data-act="file">Reference a file…</button>
          <label><input type="checkbox" data-opt="memory" checked /> Attach relevant memory</label>
          <label><input type="checkbox" data-opt="graph" /> Attach repo graph</label>
        </div>
      </div>
      <span class="attach-pills"></span>
      <div class="menu-wrap">
        <button class="cbtn" data-role="model" title="Model and thinking level"><span class="lbl">Model</span><span class="chev">▾</span></button>
        <div class="menu up model-menu" data-role="modelMenu" hidden></div>
      </div>
      <span class="grow"></span>
      <span class="caption"></span>
      <button class="send-btn" data-role="send" title="Send (Enter)">↑</button>
    </div>
  </div>`;
  const q = (s) => root.querySelector(s);
  const ta = q("textarea"), plus = q('[data-role="plus"]'), plusMenu = q('[data-role="plusMenu"]'), pills = q(".attach-pills");
  const modelBtn = q('[data-role="model"]'), modelMenu = q('[data-role="modelMenu"]');
  const caption = q(".caption"), send = q('[data-role="send"]');
  const st = { streaming: false, disabled: false, caption: "", piModel: null, piThinking: "", models: [], levels: [] };
  let menuDirty = true;

  const autosize = () => { ta.style.height = "auto"; ta.style.height = `${Math.min(ta.scrollHeight, 260)}px`; };
  const closeMenus = () => { plusMenu.hidden = true; modelMenu.hidden = true; };
  document.addEventListener("click", (e) => { if (!root.contains(e.target)) closeMenus(); });

  function getOptions() { return { memory: q('[data-opt="memory"]').checked, graph: q('[data-opt="graph"]').checked }; }
  function renderPills() {
    pills.innerHTML = "";
    const o = getOptions();
    if (o.memory) pills.appendChild(el("span", "ap", "memory"));
    if (o.graph) pills.appendChild(el("span", "ap", "repo graph"));
  }
  function renderModelMenu() {
    modelMenu.innerHTML = "";
    if (st.levels.length) {
      modelMenu.appendChild(el("div", "mh", "Thinking"));
      const row = el("div", "seg-row");
      for (const lv of st.levels) { const b = el("button", `seg-btn${lv === st.piThinking ? " active" : ""}`, lv); b.onclick = () => { st.piThinking = lv; h.onPiThinking?.(lv); render(); closeMenus(); }; row.appendChild(b); }
      modelMenu.appendChild(row);
    }
    modelMenu.appendChild(el("div", "mh", "Model"));
    if (st.models.length) {
      let lastProvider = null;
      for (const m of st.models) {
        if (m.provider !== lastProvider) { modelMenu.appendChild(el("div", "mp", m.provider)); lastProvider = m.provider; }
        const on = st.piModel && m.provider === st.piModel.provider && m.id === st.piModel.id;
        const b = el("button", on ? "on" : "", m.name && m.name !== m.id ? `${m.name}` : m.id);
        b.title = `${m.provider}/${m.id}`;
        b.onclick = () => { st.piModel = { provider: m.provider, id: m.id }; h.onPiModel?.(m.provider, m.id); render(); closeMenus(); };
        modelMenu.appendChild(b);
      }
    } else modelMenu.appendChild(el("div", "menu-empty", "No models yet. Add a provider and type the model ids you want."));
    const manage = el("button", "manage", "Manage providers…");
    manage.onclick = () => { closeMenus(); h.onManageProviders?.(); };
    modelMenu.appendChild(manage);
  }
  function render() {
    const lbl = modelBtn.querySelector(".lbl");
    lbl.innerHTML = `<b>${esc(st.piModel?.id || "Pick a model")}</b>${st.piThinking ? ` <span>${esc(st.piThinking)}</span>` : ""}`;
    caption.textContent = st.caption;
    caption.title = st.caption;
    send.disabled = st.disabled;
    ta.disabled = st.disabled && !!st.lock;
    send.className = `send-btn${st.streaming ? " stop" : ""}`;
    send.textContent = st.streaming ? "" : "↑";
    send.title = st.streaming ? "Stop" : "Send (Enter)";
    renderPills();
    // Never rebuild while open: a mid-open rebuild destroys the button the user is about to click.
    if (menuDirty && modelMenu.hidden) { renderModelMenu(); menuDirty = false; }
  }
  function submit() {
    if (st.disabled) return;
    if (st.streaming && !ta.value.trim()) { h.onStop?.(); return; }
    const text = ta.value.trim();
    if (!text) return;
    h.onSend?.(text, getOptions());
  }

  plus.onclick = (e) => { e.stopPropagation(); modelMenu.hidden = true; plusMenu.hidden = !plusMenu.hidden; };
  plusMenu.querySelector('[data-act="file"]').onclick = () => { closeMenus(); h.onPickFile?.(); };
  plusMenu.querySelectorAll("[data-opt]").forEach((i) => i.addEventListener("change", renderPills));
  modelBtn.onclick = (e) => {
    e.stopPropagation();
    plusMenu.hidden = true;
    const opening = modelMenu.hidden;
    if (opening) { renderModelMenu(); menuDirty = false; }
    modelMenu.hidden = !modelMenu.hidden;
  };
  send.onclick = submit;
  ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } });
  ta.addEventListener("input", autosize);
  render();

  return {
    setState(patch) {
      const piModelChanged = "piModel" in patch && (patch.piModel?.provider !== st.piModel?.provider || patch.piModel?.id !== st.piModel?.id);
      const menuRelevant = ("piThinking" in patch && patch.piThinking !== st.piThinking) || piModelChanged;
      Object.assign(st, patch);
      if (menuRelevant) menuDirty = true;
      render();
    },
    setPiChoices({ models, levels }) { if (models) st.models = models; if (levels) st.levels = levels; menuDirty = true; render(); },
    getOptions,
    insert(text) { ta.value += `${ta.value && !/\s$/.test(ta.value) ? " " : ""}${text}`; autosize(); ta.focus(); },
    focus() { ta.focus(); },
    clear() { ta.value = ""; autosize(); },
    get value() { return ta.value; },
  };
}
