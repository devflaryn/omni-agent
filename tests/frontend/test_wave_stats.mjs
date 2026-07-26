// tests/frontend/test_wave_stats.mjs
import assert from 'node:assert';

// wave_stats.js is DOM-free and assigns to globalThis, so it imports cleanly.
await import('../../frontend/wave_stats.js');

const computeWaveStats = globalThis.computeWaveStats;
assert.equal(typeof computeWaveStats, 'function', 'computeWaveStats must be exported');

// Two bars fully overlapping 0..4s and 0..2s: wall=4, summed=6, peak=2, speedup=1.5
const bars = [
  { startOffsetMs: 0, endOffsetMs: 4000 },
  { startOffsetMs: 0, endOffsetMs: 2000 },
];
const s = computeWaveStats(bars);
assert.equal(s.n, 2);
assert.equal(s.peak, 2);
assert.equal(s.wallS, 4);
assert.equal(s.summedS, 6);
assert.equal(s.speedup, 1.5);

// Sequential bars 0..2s then 2..4s: wall=4, summed=4, peak=1, speedup=1.0
const seq = computeWaveStats([
  { startOffsetMs: 0, endOffsetMs: 2000 },
  { startOffsetMs: 2000, endOffsetMs: 4000 },
]);
assert.equal(seq.peak, 1);
assert.equal(seq.speedup, 1.0);

// Empty wave: no bars at all — must not NaN/crash, and speedup defaults to 1.0.
const empty = computeWaveStats([]);
assert.deepEqual(empty, { n: 0, peak: 0, wallS: 0, summedS: 0, speedup: 1.0 });

// Single bar: no overlap possible, peak stays 1 and speedup is 1.0 (no "faster").
const single = computeWaveStats([{ startOffsetMs: 0, endOffsetMs: 2000 }]);
assert.equal(single.peak, 1);
assert.equal(single.speedup, 1.0);

// ---- session HUD helpers ----
const { formatDuration, formatTokens, computeSessionHud } = globalThis;
assert.equal(typeof formatDuration, 'function', 'formatDuration must be exported');
assert.equal(typeof formatTokens, 'function', 'formatTokens must be exported');
assert.equal(typeof computeSessionHud, 'function', 'computeSessionHud must be exported');

// duration: mm:ss under an hour, h:mm:ss past it, floored, never negative.
assert.equal(formatDuration(0), '00:00');
assert.equal(formatDuration(222000), '03:42');
assert.equal(formatDuration(59999), '00:59');
assert.equal(formatDuration(3600000), '1:00:00');
assert.equal(formatDuration(-500), '00:00');

// tokens: raw under 1k, one-decimal k under 10k, integer k under 1M, then M.
assert.equal(formatTokens(0), '0');
assert.equal(formatTokens(940), '940');
assert.equal(formatTokens(12400), '12k');
assert.equal(formatTokens(6100), '6.1k');
assert.equal(formatTokens(2100000), '2.1M');
assert.equal(formatTokens(null), '0');

// formatClock: spoken form used on the Thinking… line ("31m 5s")
const { formatClock } = globalThis;
assert.equal(typeof formatClock, 'function', 'formatClock must be exported');
assert.equal(formatClock(0), '0s');
assert.equal(formatClock(5000), '5s');
assert.equal(formatClock(65000), '1m 5s');
assert.equal(formatClock(1865000), '31m 5s');
assert.equal(formatClock(3725000), '1h 2m 5s');
assert.equal(formatClock(-100), '0s');

// full HUD line assembly
const hud = computeSessionHud({ running: 2, done: 4, tokens: 38300, elapsedMs: 222000 });
assert.equal(hud.elapsed, '03:42');
assert.equal(hud.running, 2);
assert.equal(hud.done, 4);
assert.equal(hud.tokensLabel, '38k');
assert.equal(hud.countLabel, '2 running · 4 done');

// ---- SessionHudModel (DOM-free accounting) ----
const SessionHudModel = globalThis.SessionHudModel;
assert.equal(typeof SessionHudModel, 'function', 'SessionHudModel must be exported');

// no activity yet -> nothing to render
let m = new SessionHudModel();
assert.equal(m.active, false);
assert.equal(m.snapshot(0), null);

// two subagents start; cumulative per-subagent tokens sum; elapsed from origin
assert.equal(m.onStart('a', 1000), true);   // first start opens a new epoch
assert.equal(m.onStart('b', 1000), false);  // same epoch
m.onProgress('a', 6100);
m.onProgress('b', 900);
let snap = m.snapshot(1000 + 222000);
assert.equal(snap.running, 2);
assert.equal(snap.done, 0);
assert.equal(snap.elapsed, '03:42');
assert.equal(snap.tokensLabel, '7k'); // 7000 -> "7k"

// one finishes: running drops, done rises, its final token count is kept
m.onDone('a', 6100);
snap = m.snapshot(1000 + 222000);
assert.equal(snap.running, 1);
assert.equal(snap.done, 1);
assert.equal(snap.countLabel, '1 running · 1 done');

// end() freezes but keeps the tally; idle only once nothing is running
m.onDone('b', 900);
m.end();
assert.equal(m.idle, true);
snap = m.snapshot(1000 + 999000);
assert.equal(snap.running, 0);
assert.equal(snap.done, 2);
assert.equal(snap.tokensLabel, '7k'); // tokens preserved after end

// a NEW epoch after end resets counters and re-anchors elapsed
assert.equal(m.onStart('c', 500000), true); // ended epoch -> fresh one
snap = m.snapshot(500000 + 60000);
assert.equal(snap.running, 1);
assert.equal(snap.done, 0);
assert.equal(snap.elapsed, '01:00');
assert.equal(snap.tokensLabel, '0');

// reset clears everything
m.reset();
assert.equal(m.active, false);
assert.equal(m.snapshot(0), null);

console.log('wave-stats ok');
