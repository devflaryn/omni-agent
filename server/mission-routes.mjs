/**
 * HTTP routes of missions (server/missions.mjs). JSON in, JSON out.
 *
 *   GET  /api/missions                                   → { missions }
 *   POST /api/missions { dir, goal, title?, orchestratorModel, fallbackModel?, workerKind?, workerModel? }  → { mission }  (local only)
 *   POST /api/missions/tool { sessionID, tool, args }    → { output, metadata }  (the plugin / MCP)
 *   GET  /api/missions/scope?session=<id>                → { missionId, role, memoryDir, graphDir, artifactsDir } | { missionId: null }
 *   GET  /api/missions/:id                               → { mission, workers }
 *   GET  /api/missions/:id/report/:wid                   → { text }  (the full stored report)
 *   POST /api/missions/:id/message { text }              → { ok }    user → orchestrator
 *   POST /api/missions/:id/workers/:wid/message { text } → { ok, how }
 *   POST /api/missions/:id/workers/:wid/summary          → { text }
 *   POST /api/missions/:id/workers/:wid/cancel           → { agent }
 *   POST /api/missions/:id/notifications/:nid { read?, answer? } → { notification }
 *   POST /api/missions/:id/stop | /resume                → { mission }
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runMissionTool } from "./mission-tools.mjs";

export async function handleMissionRoutes(req, res, { p, q, missions, send, readBody, isLocal, deps = {} }) {
  if (!p.startsWith("/api/missions")) return false;
  const get = req.method === "GET", post = req.method === "POST";
  const fail = (e) => send(res, e?.status || 500, { error: e?.message || String(e) });
  try {
    if (p === "/api/missions" && get) { send(res, 200, { missions: missions.list().map((m) => missions.pub(m)) }); return true; }
    if (p === "/api/missions" && post) {
      if (!isLocal(req)) { send(res, 403, { error: "local only" }); return true; }
      const m = missions.create(await readBody(req));
      send(res, 200, { mission: missions.pub(m) });
      return true;
    }
    if (p === "/api/missions/tool" && post) {
      const body = await readBody(req);
      send(res, 200, await runMissionTool(missions, body, deps));
      return true;
    }
    if (p === "/api/missions/scope" && get) {
      const sid = q.get("session") || "";
      const m = missions.bySession(sid);
      if (!m) { send(res, 200, { missionId: null }); return true; }
      const pr = missions.projectOf(m);
      send(res, 200, { missionId: m.id, role: missions.isOrchestrator(m, sid) ? "orchestrator" : "worker", memoryDir: pr.memoryDir, graphDir: pr.graphDir, artifactsDir: pr.artifactsDir, dir: m.dir });
      return true;
    }
    const mm = /^\/api\/missions\/(m-[0-9a-f]{8})(\/.*)?$/.exec(p);
    if (!mm) { send(res, 404, { error: "no such mission route" }); return true; }
    const m = missions.must(mm[1]);
    const rest = mm[2] || "";
    if (!rest && get) { send(res, 200, { mission: missions.pub(m), workers: missions.workersOf(m) }); return true; }
    let r;
    if (get && (r = /^\/report\/(a-[0-9a-f]{8})$/.exec(rest))) {
      let text = "";
      try { text = readFileSync(join(missions.files.get(m.id).dir, "reports", `${r[1]}.md`), "utf8"); } catch { send(res, 404, { error: "no report yet" }); return true; }
      send(res, 200, { text });
      return true;
    }
    if (get && rest.startsWith("/kg/")) {
      const kg = await deps.kg?.(m);
      if (!kg) { send(res, 404, { error: "no knowledge graph" }); return true; }
      if (rest === "/kg/stats") { send(res, 200, kg.stats()); return true; }
      if (rest === "/kg/search") { send(res, 200, { text: kg.search(q.get("q") || "", { kind: q.get("kind") || "", limit: Number(q.get("limit")) || 30, budget: 2500 }) }); return true; }
      if (rest === "/kg/node") { send(res, 200, { text: kg.node(q.get("id") || "", { depth: Number(q.get("depth")) || 1, budget: 3000 }) }); return true; }
    }
    if (!post) { send(res, 405, { error: "method not allowed" }); return true; }
    const body = await readBody(req).catch(() => ({}));
    if (rest === "/kg/load") {
      if (!isLocal(req)) { send(res, 403, { error: "local only" }); return true; }
      if (!deps.kgLoad) { send(res, 404, { error: "no knowledge graph" }); return true; }
      send(res, 200, await deps.kgLoad(m, String(body.file || ""), String(body.binary || "")));
      return true;
    }
    if (rest === "/message") { missions.messageOrchestrator(m, body.text); send(res, 200, { ok: true }); return true; }
    if (rest === "/stop") { await missions.stop(m); send(res, 200, { mission: missions.pub(m) }); return true; }
    if (rest === "/resume") { await missions.resume(m); send(res, 200, { mission: missions.pub(m) }); return true; }
    if ((r = /^\/workers\/(a-[0-9a-f]{8})\/(message|summary|cancel)$/.exec(rest))) {
      if (r[2] === "message") { const x = await missions.messageWorker(m, r[1], body.text, { from: "user" }); send(res, 200, { ok: true, how: x?.how }); return true; }
      if (r[2] === "summary") { send(res, 200, { text: await missions.workerSummary(m, r[1], { timeoutMs: 240000 }) }); return true; }
      const a = await missions.cancelWorker(m, r[1]); send(res, 200, { agent: a }); return true;
    }
    if ((r = /^\/notifications\/([\w-]+)$/.exec(rest))) { send(res, 200, { notification: missions.markNotification(m, r[1], body) }); return true; }
    send(res, 404, { error: "no such mission route" });
    return true;
  } catch (e) { fail(e); return true; }
}
