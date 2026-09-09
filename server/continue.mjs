/**
 * Decides how Omni attaches to a session the user typed into.
 * Pure: no I/O, so it is unit-tested cell by cell.
 *
 *   Claude Code   terminal still active → --resume --fork-session   closed → --resume
 *   pi            terminal still active → switch + clone            closed → switch
 */
const idOf = (sid) => String(sid).split(":").slice(1).join(":");

export function isLiveInTerminal(s, now = Date.now(), liveWindowMs = 30000) {
  if (!s || s.owned) return false;
  if (s.streaming) return true;
  const last = Math.max(s.lastActivity || 0, s.mtime || 0);
  return now - last < liveWindowMs;
}

export function planContinue(s, { now = Date.now(), liveWindowMs = 30000, piAlive = false, piSid = null, piStreaming = false, claudeAlive = false, forceFork = false } = {}) {
  if (!s) return { action: "error", status: 404, error: "unknown session" };
  const live = isLiveInTerminal(s, now, liveWindowMs);
  if (s.harness === "claude") {
    if (claudeAlive) return { action: "error", status: 409, error: "that Claude session is already running in Omni; stop it first" };
    return { action: "claude", resume: idOf(s.sid), fork: !!(forceFork || live), cwd: s.cwd || null };
  }
  if (s.harness === "pi") {
    if (piAlive && piSid === s.sid && !forceFork) return { action: "pi-prompt" };
    if (piAlive && piStreaming) return { action: "error", status: 409, error: "pi is busy; stop it or wait" };
    if (!s.file) return { action: "error", status: 400, error: "session file unknown" };
    return { action: "pi-switch", file: s.file, clone: !!(forceFork || live), cwd: s.cwd || null, start: !piAlive };
  }
  return { action: "error", status: 400, error: `cannot continue a ${s.harness} session` };
}
