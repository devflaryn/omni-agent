// One sprite, injected once; icon() returns an <svg><use> that inherits colour
// through currentColor. Kept out of app.js, which is already 4,400+ lines.
(function () {
  const NS = 'http://www.w3.org/2000/svg';

  // The sprite is fetched from the same directory as the page. In a webview this
  // is a file:// read, so a failure is silent — log it rather than leaving the UI
  // mysteriously iconless.
  //
  // Guard: the test harness runs this file in a Node `vm` sandbox with no `fetch`
  // and a stub `document` that lacks a real body/createElement. In that
  // environment sprite injection is meaningless — only skip the injection, never
  // the icon() function itself, and keep the .catch() reporting real load
  // failures in the browser.
  function injectSprite() {
    if (typeof fetch !== 'function'
        || !document.body
        || typeof document.createElement !== 'function') {
      return;
    }
    fetch('icons.svg')
      .then((r) => r.text())
      .then((svg) => {
        const host = document.createElement('div');
        host.style.display = 'none';
        host.setAttribute('aria-hidden', 'true');
        host.innerHTML = svg;
        document.body.appendChild(host);
      })
      .catch((e) => console.error('[icons] sprite failed to load:', e));
  }

  function icon(name, cls) {
    const c = cls ? ` ${cls}` : '';
    return `<svg class="ico${c}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">`
         + `<use href="#i-${name}"></use></svg>`;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectSprite);
  } else {
    injectSprite();
  }

  Object.assign(typeof window !== 'undefined' ? window : globalThis, { icon });
})();
