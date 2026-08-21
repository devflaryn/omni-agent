// Device chip: the standing answer to "which machine am I about to affect?"
// While a device is active, every command, file edit and build in this
// session runs on ANOTHER computer — the chip must always be visible and
// visually distinct when remote, or a destructive command can be run by
// someone who believes they are local.
//
// Kept out of app.js (already 4,400+ lines) for the same reason
// workflow_view.js is: this is small, self-contained state driven by one
// event (`device_changed`). The picker's list rendering and its
// add/remove/select/test wiring live in app.js instead, because that part is
// mostly request/response calls into pywebview.api, not event-driven state —
// this file owns only the chip and the escaping rule that protects it.
(function () {
  const state = {
    device: null,   // {id, name, target, remote_root, env_prelude, notes} | null
    lastHtml: '',    // last HTML rendered into #deviceChipName — inspected by tests
  };

  // Same idiom as workflow_view.js's esc(): device names, ssh targets and
  // remote roots are user-supplied free text and must never reach innerHTML
  // unescaped.
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function renderDeviceChip() {
    const chip = document.getElementById('deviceChip');
    const nameEl = document.getElementById('deviceChipName');
    const d = state.device;
    const html = d ? esc(d.name || d.target || 'device') : 'this computer';
    state.lastHtml = html;
    if (nameEl) nameEl.innerHTML = html;
    if (chip) {
      // The distinct class is the safety control — do not weaken this to a
      // cosmetic-only toggle.
      chip.classList.toggle('device-chip-remote', !!d);
      chip.title = d
        ? `Tools run on ${d.name || d.target} (${d.target}) — click to switch`
        : 'Tools run on this computer — click to switch';
    }
  }

  function deviceChanged(ev) {
    state.device = (ev && ev.device) || null;
    renderDeviceChip();
  }

  function deviceState() { return state; }

  const api = { deviceChanged, renderDeviceChip, deviceState };
  Object.assign(typeof window !== 'undefined' ? window : globalThis, api);
})();
