/**
 * Pure decision helpers for keeping Omni's chats alive over days. No timers, no I/O,
 * so the policy is unit-tested directly; opencode-server.mjs and opencode-rpc.mjs wire these to real timers/clocks.
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

/** How long a tool call may run without any pi event before it counts as a stall (CONFIG.toolStallMs). */
export const DEFAULT_TOOL_STALL_MS = 4 * 3600000;

/** The silence allowed before a stall: `toolStallMs` while a tool call is open (never less than `stallMs`). */
export function stallLimit({ openTools = 0, stallMs = 360000, toolStallMs = DEFAULT_TOOL_STALL_MS } = {}) {
  return openTools > 0 ? Math.max(stallMs, Number(toolStallMs) || DEFAULT_TOOL_STALL_MS) : stallMs;
}

/** True when pi claims to be streaming but has produced no event within the limit (see stallLimit). */
export function stalled({ streaming, lastEventAt, now = Date.now(), stallMs = 360000, openTools = 0, toolStallMs = DEFAULT_TOOL_STALL_MS }) {
  return !!streaming && now - (lastEventAt || 0) > stallLimit({ openTools, stallMs, toolStallMs });
}
