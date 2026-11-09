/* The theme, set before the first paint: Dark (the default), Light, or System, which follows the device and changes with it.
   A classic script in <head>, so the page never flashes the wrong palette; Settings → Appearance changes it through
   window.omniTheme. The choice is this browser's own (localStorage), like any per-viewer convenience. */
(() => {
  const KEY = "omni.theme";
  const CHOICES = ["dark", "light", "system"];
  const media = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: light)") : null;
  const read = () => { try { const v = localStorage.getItem(KEY); return CHOICES.includes(v) ? v : "dark"; } catch { return "dark"; } };
  const resolve = (choice) => (choice === "system" ? (media?.matches ? "light" : "dark") : choice);
  let choice = read();
  function apply() {
    const root = document.documentElement, theme = resolve(choice);
    root.dataset.themeChoice = choice;
    if (root.dataset.theme !== theme) {
      // A flip repaints at once: styles.css turns transitions off for the two frames this class is on.
      root.classList.add("theme-switching");
      root.dataset.theme = theme;
      requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove("theme-switching")));
    }
    for (const m of document.querySelectorAll('meta[name="theme-color"]')) m.setAttribute("content", theme === "light" ? "#ffffff" : "#212121");
    // The Mac app paints its title bar and window to match, and follows the choice when it is System.
    try { window.webkit?.messageHandlers?.omniShell?.postMessage({ theme, choice }); } catch { /* not in the Mac app */ }
  }
  apply();
  media?.addEventListener?.("change", () => { if (choice === "system") apply(); });
  addEventListener("storage", (e) => { if (e.key === KEY) { choice = read(); apply(); } });
  window.omniTheme = {
    choices: CHOICES,
    get: () => choice,
    set(next) {
      choice = CHOICES.includes(next) ? next : "dark";
      try { localStorage.setItem(KEY, choice); } catch { /* private window: it lasts this visit */ }
      apply();
    },
  };
})();
