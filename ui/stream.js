/**
 * The page's live event stream, kept up over a flaky link (the VPS relay, a phone's network, a tab in the
 * background). EventSource alone is not enough: it never notices a connection that died without a FIN (a NAT
 * that forgot it, a phone that switched networks, the relay's far side gone), so the page sat on a dead stream
 * looking merely quiet. The server sends a `ka` event every 20 s; a stream silent for STALE_MS is replaced.
 */
export const STALE_MS = 50_000;

/** Wait before reconnect attempt n (0-based): doubling from 1 s to a 30 s cap, the lower half jittered so
 *  several tabs (or devices behind one address) do not retry in step against the relay's per-address limits. */
export function retryDelay(attempt, rand = Math.random) {
  const cap = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 15));
  return Math.round(cap / 2 + (rand() * cap) / 2);
}

/**
 * `url()` is read at each (re)connect so it can carry the latest seq. `on` maps named events to handlers.
 * `onDown` runs at each drop (the page checks whether it was signed out: EventSource cannot see a 401),
 * `onUp` when a stream opens.
 */
export function createStream({ url, onMessage, on = {}, onUp, onDown, EventSource: ES = globalThis.EventSource, now = Date.now, timers = globalThis, staleMs = STALE_MS }) {
  let es = null;
  let attempt = 0;
  let lastAt = 0;
  let retry = null;
  let tick = null;
  function open() {
    timers.clearTimeout(retry);
    retry = null;
    es?.close();
    const s = (es = new ES(url()));
    lastAt = now();
    const live = (fn) => (m) => { if (s !== es) return; lastAt = now(); fn?.(m); };
    s.onopen = live(() => { attempt = 0; onUp?.(); });
    s.onmessage = live(onMessage);
    for (const [name, fn] of Object.entries(on)) s.addEventListener(name, live(fn));
    s.addEventListener("ka", live());
    // Closed by hand: EventSource's own retry would reuse the old URL (an old seq) and wait a fixed time.
    s.onerror = () => { if (s === es) down(); };
  }
  function down() {
    es?.close();
    es = null;
    onDown?.();
    if (!retry) retry = timers.setTimeout(open, retryDelay(attempt++));
  }
  return {
    start() {
      open();
      timers.clearInterval(tick);
      tick = timers.setInterval(() => { if (es && now() - lastAt > staleMs) down(); }, 10_000);
    },
    /** The page came back to the front or the network came back: a stream that has missed a keepalive, or a
     *  reconnect still waiting out its backoff, goes now rather than at the next watchdog tick. */
    poke() { if (!es || now() - lastAt > staleMs / 2) open(); },
    stop() { timers.clearTimeout(retry); timers.clearInterval(tick); retry = tick = null; es?.close(); es = null; },
  };
}
