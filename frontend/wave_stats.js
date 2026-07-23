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
if (typeof globalThis !== 'undefined') globalThis.computeWaveStats = computeWaveStats;
if (typeof window !== 'undefined') window.computeWaveStats = computeWaveStats;
