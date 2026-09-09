/* The composer card: textarea, + menu (file / memory / repo graph), access pill, model pill, send/stop. */
import { el, esc } from "./lib.js";

export const CLAUDE_MODELS = [["", "Default"], ["claude-opus-5", "Opus 5"], ["claude-fable-5-1", "Fable 5.1"], ["claude-sonnet-5", "Sonnet 5"], ["claude-haiku-4-5", "Haiku 4.5"]];

export function createComposer(root, h) {
  root.innerHTML = `
  <div class="composer">
    <textarea rows="1" placeholder="Do anything"></textarea>
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
      <div class="seg" data-role="target" hidden><button class="seg-btn" data-target="pi">pi</button><button class="seg-btn" data-target="claude">Claude Code</button></div>
      <button class="cbtn access" data-role="access" hidden title="Full access runs Claude Code with --dangerously-skip-permissions; Ask makes it stop for permissions"><span class="dot"></span><span class="lbl">Full access</span></button>
      <div class="menu-wrap">
        <button class="cbtn" data-role="model"><span class="lbl">Model</span><span class="chev">▾</span></button>
        <div class="menu up model-menu" data-role="modelMenu" hidden></div>
      </div>
      <span class="grow"></span>
      <span class="caption"></span>
      <button class="send-btn" data-role="send" title="Send (Enter)">↑</button>
    </div>
  </div>`;
  const q = (s) => root.querySelector(s);
  const ta = q("textarea"), plus = q('[data-role="plus"]'), plusMenu = q('[data-role="plusMenu"]'), pills = q(".attach-pills");
  const seg = q('[data-role="target"]'), access = q('[data-role="access"]'), modelBtn = q('[data-role="model"]'), modelMenu = q('[data-role="modelMenu"]');
  const caption = q(".caption"), send = q('[data-role="send"]');
  const st = { harness: "claude", streaming: false, disabled: false, caption: "", autonomous: true, claudeModel: "", piModel: null, piThinking: "", models: [], levels: [] };
  let menuDirty = true;

  const autosize = () => { ta.style.height = "auto"; ta.style.height = `${Math.min(ta.scrollHeight, 260)}px`; };
  const closeMenus = () => { plusMenu.hidden = true; modelMenu.hidden = true; };
  document.addEventListener("click", (e) => { if (!root.contains(e.target)) closeMenus(); });

  function getOptions() {
    const o = { memory: q('[data-opt="memory"]').checked, graph: q('[data-opt="graph"]').checked, autonomous: st.autonomous, model: st.harness === "claude" ? st.claudeModel : "" };
    if (h.showTarget) o.target = st.harness;
    return o;
  }
  function renderPills() {
    pills.innerHTML = "";
    const o = getOptions();
    if (o.memory) pills.appendChild(el("span", "ap", "memory"));
    if (o.graph) pills.appendChild(el("span", "ap", "repo graph"));
  }
  function renderModelMenu() {
    modelMenu.innerHTML = "";
    if (st.harness === "claude") {
      modelMenu.appendChild(el("div", "mh", "Claude model"));
      for (const [id, name] of CLAUDE_MODELS) { const b = el("button", id === st.claudeModel ? "on" : "", name); b.onclick = () => { st.claudeModel = id; render(); closeMenus(); }; modelMenu.appendChild(b); }
      return;
    }
    modelMenu.appendChild(el("div", "mh", "Thinking"));
    for (const lv of st.levels) { const b = el("button", lv === st.piThinking ? "on" : "", lv); b.onclick = () => { st.piThinking = lv; h.onPiThinking?.(lv); render(); closeMenus(); }; modelMenu.appendChild(b); }
    modelMenu.appendChild(el("div", "mh", "Model"));
    if (!st.models.length) modelMenu.appendChild(el("div", "mh", "pi is not running"));
    for (const m of st.models) { const on = st.piModel && m.provider === st.piModel.provider && m.id === st.piModel.id; const b = el("button", on ? "on" : "", `${m.name || m.id} · ${m.provider}`); b.onclick = () => { st.piModel = { provider: m.provider, id: m.id }; h.onPiModel?.(m.provider, m.id); render(); closeMenus(); }; modelMenu.appendChild(b); }
  }
  function render() {
    const claude = st.harness === "claude";
    access.hidden = !claude;
    access.classList.toggle("ask", !st.autonomous);
    access.querySelector(".lbl").textContent = st.autonomous ? "Full access" : "Ask";
    seg.hidden = !h.showTarget;
    seg.querySelectorAll(".seg-btn").forEach((x) => x.classList.toggle("active", x.dataset.target === st.harness));
    const lbl = modelBtn.querySelector(".lbl");
    if (claude) { const name = (CLAUDE_MODELS.find(([id]) => id === st.claudeModel) || CLAUDE_MODELS[0])[1]; lbl.innerHTML = `<b>${name}</b>`; }
    else lbl.innerHTML = `<b>${esc(st.piModel?.id || "pi model")}</b>${st.piThinking ? ` <span>${esc(st.piThinking)}</span>` : ""}`;
    caption.textContent = st.caption;
    caption.title = st.caption;
    send.disabled = st.disabled;
    send.className = `send-btn${st.streaming ? " stop" : ""}`;
    send.textContent = st.streaming ? "" : "↑";
    send.title = st.streaming ? "Stop" : "Send (Enter)";
    renderPills();
    // Rebuild only when something menu-relevant changed, and never while it's open (a mid-open
    // rebuild destroys the button the user is about to click). The model button's click handler
    // forces a fresh build right before opening, so staying dirty while open is harmless.
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
  seg.addEventListener("click", (e) => { const b = e.target.closest(".seg-btn"); if (!b) return; st.harness = b.dataset.target; menuDirty = true; closeMenus(); render(); });
  access.onclick = () => { st.autonomous = !st.autonomous; render(); };
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
      const menuRelevant = ["harness", "claudeModel", "piThinking"].some((k) => k in patch && patch[k] !== st[k]) || piModelChanged;
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
