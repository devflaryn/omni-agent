import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../server/bus.mjs";
import { ProjectStore } from "../server/projects.mjs";
import { MissionManager } from "../server/missions.mjs";
import { handleMissionRoutes } from "../server/mission-routes.mjs";
import { FakeAgents, orchestratorFactory, flush } from "./helpers/mission-fakes.mjs";

const base = mkdtempSync(join(tmpdir(), "omni-mroutes-"));
const servers = [];
after(() => { for (const s of servers) s.close(); rmSync(base, { recursive: true, force: true }); });
function send(res, code, body) { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); }
async function readBody(req) { const chunks = []; for await (const c of req) chunks.push(c); const s = Buffer.concat(chunks).toString("utf8"); return s ? JSON.parse(s) : {}; }

async function serve() {
  const dir = join(base, "repo"); mkdirSync(dir, { recursive: true });
  const bus = new Bus(), agents = new FakeAgents(), bf = orchestratorFactory(bus);
  const missions = new MissionManager({ bus, store: new ProjectStore({ root: join(base, "p") }), agents, createOrchestrator: bf.createOrchestrator, config: { heartbeatMs: 0 } });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (!(await handleMissionRoutes(req, res, { p: url.pathname, q: url.searchParams, missions, send, readBody, isLocal: (r) => r.headers["x-remote"] !== "1" }))) send(res, 404, { fallthrough: true });
  });
  servers.push(server);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const call = async (method, path, body, headers = {}) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  return { call, missions, agents, bf, dir };
}

test("mission routes: create, list, get, message, tool, scope, notifications, stop/resume", async () => {
  const { call, bf, dir, agents } = await serve();
  assert.equal((await call("POST", "/api/missions", { dir, goal: "" })).status, 400);
  assert.equal((await call("POST", "/api/missions", { dir, goal: "g", orchestratorModel: "a/b" }, { "x-remote": "1" })).status, 403);
  const c = await call("POST", "/api/missions", { dir, goal: "Map the APK", orchestratorModel: "a/b" });
  assert.equal(c.status, 200);
  const id = c.body.mission.id;
  await flush(); await flush();
  assert.equal((await call("GET", "/api/missions")).body.missions[0].id, id);
  const orchestrator = bf.made[0];
  const t = await call("POST", "/api/missions/tool", { sessionID: orchestrator.sid.slice(3), tool: "worker_spawn", args: { task: "scan the dex" } });
  assert.match(t.body.output, /Started worker a-/);
  const wid = t.body.metadata.id;
  const g = await call("GET", `/api/missions/${id}`);
  assert.equal(g.body.workers.length, 1);
  assert.equal((await call("GET", `/api/missions/scope?session=${agents.get(wid).sid.slice(3)}`)).body.role, "worker");
  assert.equal((await call("GET", "/api/missions/scope?session=nobody")).body.missionId, null);
  orchestrator.stream(true);
  await call("POST", `/api/missions/${id}/message`, { text: "focus on login" });
  const m1 = (await call("GET", `/api/missions/${id}`)).body.mission;
  assert.equal(m1.queue[1].type, "user", "user message is right behind the in-flight briefing");
  assert.equal((await call("POST", `/api/missions/${id}/workers/${wid}/message`, { text: "also libfoo" })).body.ok, true);
  await call("POST", "/api/missions/tool", { sessionID: orchestrator.sid.slice(3), tool: "notify", args: { title: "Need creds", question: "which?" } });
  const nid = (await call("GET", `/api/missions/${id}`)).body.mission.notifications[0].id;
  const n = await call("POST", `/api/missions/${id}/notifications/${nid}`, { answer: "test account" });
  assert.equal(n.body.notification.answer, "test account");
  assert.equal((await call("POST", `/api/missions/${id}/stop`)).body.mission.status, "paused");
  assert.equal(agents.get(wid).status, "cancelled");
  assert.equal((await call("POST", `/api/missions/${id}/resume`)).body.mission.status, "running");
  assert.equal((await call("GET", "/api/missions/m-00000000")).status, 404);
  const rep = await call("GET", `/api/missions/${id}/report/${wid}`);
  assert.equal(rep.status, 200, "the cancelled worker's report was stored");
  assert.match(rep.body.text, /: cancelled/);
});
