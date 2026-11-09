/* Settings → Appearance: the theme choice. ui/theme.js applies it before the first paint; this is only the control. */
import { el } from "./lib.js";

const CHOICES = [["dark", "Dark"], ["light", "Light"], ["system", "System"]];

/**
 * Dark (the default), Light, or System, drawn into `body`. `theme` is window.omniTheme: { get(), set(value) }.
 * A radiogroup: a choice is marked in place, so the option just pressed keeps the focus; the arrow keys (and Home, End)
 * move between the options and choose, and only the chosen one is in the Tab order.
 */
export function renderThemeChoice(body, theme) {
  body.innerHTML = "";
  const wrap = el("div", "rm-wrap");
  const sec = el("section", "rm-sec");
  sec.appendChild(el("h3", null, "Theme"));
  const row = el("div", "dlg-tabs");
  row.setAttribute("role", "radiogroup");
  row.setAttribute("aria-label", "Theme");
  const buttons = CHOICES.map(([value, label]) => {
    const b = el("button", "seg-btn", label);
    b.type = "button";
    b.dataset.theme = value;
    b.setAttribute("role", "radio");
    b.onclick = () => choose(value);
    row.appendChild(b);
    return b;
  });
  function mark(now) {
    for (const b of buttons) {
      const on = b.dataset.theme === now;
      b.classList.toggle("active", on);
      b.setAttribute("aria-checked", String(on));
      b.tabIndex = on ? 0 : -1;
    }
  }
  function choose(value, focus = false) {
    theme?.set(value);
    mark(theme?.get() ?? value);
    if (focus) buttons.find((b) => b.dataset.theme === value)?.focus();
  }
  row.addEventListener("keydown", (e) => {
    const at = buttons.indexOf(e.target);
    if (at < 0) return;
    const n = buttons.length;
    const to = { ArrowRight: at + 1, ArrowDown: at + 1, ArrowLeft: at - 1, ArrowUp: at - 1, Home: 0, End: n - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    choose(buttons[(to + n) % n].dataset.theme, true);
  });
  mark(theme?.get() ?? "dark");
  sec.appendChild(row);
  sec.appendChild(el("p", "rm-note", "System follows this device's light or dark setting."));
  wrap.appendChild(sec);
  body.appendChild(wrap);
}
