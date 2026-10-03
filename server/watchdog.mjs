/**
 * Pure decision helpers for keeping the pi child alive over days. No timers, no I/O,
 * so the policy is unit-tested directly; pi-rpc wires these to real setTimeout/clocks.
 */
export function restartDelay(restarts, { base = 800, cap = 30000 } = {}) {
  const raw = Math.min(cap, base * 2 ** Math.max(0, restarts));
  const jitter = raw * (0.8 + Math.random() * 0.4);
  return Math.round(Math.min(cap, jitter));
}

/** We never stop restarting (fail open); the growing delay prevents a busy loop. */
export function shouldKeepRestarting() { return true; }

/** Reset the restart counter once the child has streamed healthily for a while. */
export function nextRestartState(state = {}, { now = Date.now(), healthyAfterMs = 120000 } = {}) {
  const lastHealthyAt = state.lastHealthyAt || 0;
  if (lastHealthyAt && now - lastHealthyAt >= healthyAfterMs) return { ...state, restarts: 0 };
  return state;
}

/** True when pi claims to be streaming but has produced no event within stallMs. */
export function stalled({ streaming, lastEventAt, now = Date.now(), stallMs = 360000 }) {
  return !!streaming && now - (lastEventAt || 0) > stallMs;
}
