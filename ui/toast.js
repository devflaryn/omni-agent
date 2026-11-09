/* Toasts: for news from somewhere else (a remote approval, a background digest, a failure with nowhere better to go).
   Each one slides in, waits while the pointer rests on it or the tab is hidden, then slides out (styles.css .toast.out).
   Errors stay longer. Never for what the screen already shows. */
const LIFE = 4000, ERR_LIFE = 7000, EXIT_MS = 160;

export function createToasts(box = document.querySelector("#toasts")) {
  return function toast(text, err = false) {
    if (!box) return null;
    const t = document.createElement("div");
    t.className = `toast${err ? " err" : ""}`;
    t.textContent = text;
    t.setAttribute("role", err ? "alert" : "status");
    box.appendChild(t);
    let left = err ? ERR_LIFE : LIFE, started = Date.now(), timer = null, hover = false;
    const go = () => {
      t.classList.add("out");
      setTimeout(() => t.remove(), EXIT_MS);
      document.removeEventListener("visibilitychange", onVisible);
    };
    const run = () => { clearTimeout(timer); started = Date.now(); timer = setTimeout(go, left); };
    const pause = () => { clearTimeout(timer); left = Math.max(800, left - (Date.now() - started)); };
    const onVisible = () => { if (document.hidden) pause(); else if (!hover) run(); };
    t.addEventListener("pointerenter", () => { hover = true; pause(); });
    t.addEventListener("pointerleave", () => { hover = false; if (!document.hidden) run(); });
    t.addEventListener("click", go);
    document.addEventListener("visibilitychange", onVisible);
    if (document.hidden) pause(); else run();
    return t;
  };
}
