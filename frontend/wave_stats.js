// Pure wave statistics for the concurrency dock — DOM-free so it is unit-testable
// under node and shared with app.js via a plain <script> tag (window.computeWaveStats).
function computeWaveStats(bars) {
  const arr = bars.map(b => ({ s: b.startOffsetMs, e: b.endOffsetMs == null ? b.startOffsetMs : b.endOffsetMs }));
  const wallMs = arr.length ? Math.max(...arr.map(b => b.e)) - Math.min(...arr.map(b => b.s)) : 0;
  const summedMs = arr.reduce((t, b) => t + Math.max(0, b.e - b.s), 0);
  // peak concurrency via a sweep of +1/-1 edges
  const edges = [];
  arr.forEach(b => { edges.push([b.s, 1]); edges.push([b.e, -1]); });
  edges.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let cur = 0, peak = 0;
  edges.forEach(([, d]) => { cur += d; if (cur > peak) peak = cur; });
  const wallS = Math.round(wallMs / 100) / 10;
  const summedS = Math.round(summedMs / 100) / 10;
  const speedup = wallMs > 0 ? Math.round((summedMs / wallMs) * 10) / 10 : 1.0;
  return { n: arr.length, peak, wallS, summedS, speedup };
}
// ---- session HUD pure helpers (DOM-free, unit-testable) ----

// mm:ss (or h:mm:ss past an hour) from a millisecond duration.
function formatDuration(ms) {
  const totalS = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalS / 3600);
  const m = Math.floor((totalS % 3600) / 60);
  const s = totalS % 60;
  const pad = n => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

// Human clock from a millisecond duration, e.g. "5s", "31m 5s", "1h 2m 5s".
// Distinct from formatDuration's mm:ss digits — this is the spoken form used on
// the "Thinking… 214k tokens 31m 5s" line.
function formatClock(ms) {
  const totalS = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalS / 3600);
  const m = Math.floor((totalS % 3600) / 60);
  const s = totalS % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// Compact token count: 940 -> "940", 12400 -> "12.4k", 2_100_000 -> "2.1M".
function formatTokens(n) {
  n = Math.max(0, Math.round(n || 0));
  if (n < 1000) return String(n);
  if (n < 1e6) {
    const k = n / 1000;
    return (k < 10 ? Math.round(k * 10) / 10 : Math.round(k)) + 'k';
  }
  const m = n / 1e6;
  return (m < 10 ? Math.round(m * 10) / 10 : Math.round(m)) + 'M';
}

// One-line summary of the current session HUD state.
//   running: number of subagents in flight, done: completed count,
//   tokens: cumulative token total, elapsedMs: since first subagent activity.
function computeSessionHud({ running, done, tokens, elapsedMs }) {
  return {
    elapsed: formatDuration(elapsedMs),
    running,
    done,
    tokensLabel: formatTokens(tokens),
    countLabel: `${running} running · ${done} done`,
  };
}

// Session HUD accounting — all state, zero DOM, so it unit-tests under node and
// app.js is left with nothing but rendering. One "epoch" spans a run of subagent
// activity; a new epoch starts on the first activity after the previous one ended.
// Elapsed is derived from an injected `nowMs` (no timers here) so it's testable.
class SessionHudModel {
  constructor() { this._epoch = null; }

  _ensure(nowMs) {
    if (this._epoch && !this._epoch.ended) return false;
    this._epoch = { originMs: nowMs, running: new Set(), done: 0, tokens: new Map(), ended: false };
    return true; // signals a fresh epoch began (caller can show the panel)
  }

  // Returns true when this start opened a NEW epoch (so the UI can reveal the HUD).
  onStart(key, nowMs) { const fresh = this._ensure(nowMs); this._epoch.running.add(key); return fresh; }
  onProgress(key, tokens) { if (this._epoch) this._epoch.tokens.set(key, tokens || 0); } // cumulative per subagent
  onDone(key, tokens) {
    if (!this._epoch) return;
    this._epoch.running.delete(key);
    this._epoch.done += 1;
    this._epoch.tokens.set(key, tokens || 0);
  }
  end() { if (this._epoch) this._epoch.ended = true; }   // freeze elapsed, keep tally
  reset() { this._epoch = null; }

  get active() { return !!this._epoch; }
  get idle() { return !!this._epoch && this._epoch.ended && this._epoch.running.size === 0; }

  // Rendered view for a given wall-clock reading; null when there's nothing to show.
  snapshot(nowMs) {
    if (!this._epoch) return null;
    let tokens = 0;
    this._epoch.tokens.forEach(v => { tokens += v; });
    return computeSessionHud({
      running: this._epoch.running.size, done: this._epoch.done, tokens,
      elapsedMs: nowMs - this._epoch.originMs,
    });
  }
}

if (typeof globalThis !== 'undefined') {
  globalThis.computeWaveStats = computeWaveStats;
  globalThis.formatDuration = formatDuration;
  globalThis.formatTokens = formatTokens;
  globalThis.computeSessionHud = computeSessionHud;
  globalThis.formatClock = formatClock;
  globalThis.SessionHudModel = SessionHudModel;
}
if (typeof window !== 'undefined') {
  window.computeWaveStats = computeWaveStats;
  window.formatDuration = formatDuration;
  window.formatTokens = formatTokens;
  window.computeSessionHud = computeSessionHud;
  window.formatClock = formatClock;
  window.SessionHudModel = SessionHudModel;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { computeWaveStats, formatDuration, formatClock, formatTokens, computeSessionHud, SessionHudModel };
}
