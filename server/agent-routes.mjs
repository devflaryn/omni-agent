/**
 * HTTP routes of the background agent manager (server/agents.mjs). JSON in, JSON out. The two long
 * waits are capped at 300 s, well under pi's 600 s HTTP timeout, and end early when the request goes
 * away. Starting an agent is local-only: it launches processes on this computer.
 *
 *   GET  /api/agents?parent=<sid>&parentSession=<id>&active=1   → { agents }
 *   POST /api/agents                                            → { agent }   (400 on a bad spec)
 *   GET  /api/agents/undelivered?parentSession=<id>             → { agents }
 *   POST /api/agents/wait { ids, parentSessionId, undeliveredOnly, timeoutSec } → { finished, pending }
 *   GET  /api/agents/:id                                        → { agent }   (404)
 *   GET  /api/agents/:id/log?tail=N                             → { text }
 *   POST /api/agents/:id/wait-log { until, timeoutSec }         → { matched, status, tail }
 *   POST /api/agents/:id/message { text, steer? }               → { ok, how }
 *   POST /api/agents/:id/cancel                                 → { agent }
 *   POST /api/agents/:id/delivered                              → { ok }
 */
export const AGENT_WAIT_MAX_SEC = 300;

/** Seconds from a request (default `dflt`, capped at 300) → milliseconds. */
export function waitMs(v, dflt = 60) {
  const n = v === undefined || v === null || v === "" ? dflt : Number(v);
  return Math.round(Math.min(AGENT_WAIT_MAX_SEC, Math.max(0, Number.isFinite(n) ? n : dflt)) * 1000);
}
const flag = (v) => v === "1" || v === "true" || v === "yes";

/** An AbortSignal that fires when the client goes away before the answer was sent. */
function closeSignal(res) {
  const ac = new AbortController();
  res.on("close", () => { if (!res.writableFinished) ac.abort(); });
  return ac.signal;
}

/** Answers the request and returns true when the path is one of the agent routes; false otherwise. */
export async function handleAgentRoutes(req, res, { p, q, agents, send, readBody, isLocal = () => true }) {
  if (p !== "/api/agents" && !p.startsWith("/api/agents/")) return false;
  if (!agents) { send(res, 503, { error: "background agents are not available" }); return true; }
  const body = async () => { try { return (await readBody(req)) || {}; } catch (e) { throw Object.assign(e, { status: e.status || 400 }); } };
  const reply = (code, out) => { if (!res.writableEnded && !res.destroyed) send(res, code, out); return true; };
  try {
    if (p === "/api/agents") {
      if (req.method === "GET") return reply(200, { agents: agents.list({ parentSid: q.get("parent") || undefined, parentSessionId: q.get("parentSession") || undefined, active: flag(q.get("active")) }) });
      if (req.method === "POST") {
        if (!isLocal(req)) return reply(403, { error: "local only: agents are started by the agents on this computer" });
        const spec = await body();
        let agent;
        try { agent = agents.start(spec); } catch (e) { return reply(e.status || 400, { error: e.message }); }
        return reply(200, { agent });
      }
      return reply(405, { error: "GET or POST" });
    }
    if (p === "/api/agents/undelivered" && req.method === "GET") return reply(200, { agents: agents.undelivered(q.get("parentSession") || undefined) });
    if (p === "/api/agents/wait" && req.method === "POST") {
      const b = await body();
      const signal = closeSignal(res);
      const ids = Array.isArray(b.ids) ? b.ids : b.ids ? [b.ids] : undefined;
      const out = await agents.wait({ ids, parentSessionId: b.parentSessionId || undefined, undeliveredOnly: !!b.undeliveredOnly, timeoutMs: waitMs(b.timeoutSec), signal });
      return reply(200, out);
    }
    const m = /^\/api\/agents\/([^/]+)(?:\/([a-z-]+))?$/.exec(p);
    if (!m) return reply(404, { error: "unknown agents route" });
    let id;
    try { id = decodeURIComponent(m[1]); } catch { return reply(400, { error: "bad agent id" }); }
    const sub = m[2] || "";
    const agent = agents.get(id);
    if (!agent) return reply(404, { error: `no agent ${id}` });
    const route = `${req.method} ${sub}`;
    switch (route) {
      case "GET ": return reply(200, { agent });
      case "GET log": return reply(200, { text: agents.readLog(id, { tailLines: Number(q.get("tail")) || 80 }) });
      case "POST wait-log": {
        const b = await body();
        const signal = closeSignal(res);
        return reply(200, await agents.waitFor(id, { until: b.until ? String(b.until) : "", timeoutMs: waitMs(b.timeoutSec), signal }));
      }
      case "POST message": { const b = await body(); return reply(200, await agents.message(id, b.text ?? b.message, { steer: b.steer === undefined ? undefined : !!b.steer })); }
      case "POST cancel": return reply(200, { agent: await agents.cancel(id) });
      case "POST delivered": return reply(200, { ok: agents.markDelivered(id) });
      default: return reply(["", "log", "wait-log", "message", "cancel", "delivered"].includes(sub) ? 405 : 404, { error: `unknown agents route: ${route.trim()}` });
    }
  } catch (e) {
    return reply(e?.status || 500, { error: String(e?.message || e) });
  }
}
