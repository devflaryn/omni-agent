import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../server/bus.mjs";
import { ProjectStore } from "../server/projects.mjs";
import { MissionManager } from "../server/missions.mjs";
import { runMissionTool } from "../server/mission-tools.mjs";
import { FakeAgents, orchestratorFactory, flush } from "./helpers/mission-fakes.mjs";

const base = mkdtempSync(join(tmpdir(), "omni-mtools-"));
after(() => rmSync(base, { recursive: true, force: true }));
let k = 0;
async function setup() {
  const d = join(base, `t${++k}`), dir = join(d, "repo"); mkdirSync(dir, { recursive: true });
  const bus = new Bus(), agents = new FakeAgents(), bf = orchestratorFactory(bus);
  const mm = new MissionManager({ bus, store: new ProjectStore({ root: join(d, "p") }), agents, createOrchestrator: bf.createOrchestrator, config: { heartbeatMs: 0 } });
  const a = mm.create({ dir, goal: "A", orchestratorModel: "x/y" });
  const b = mm.create({ dir, goal: "B", orchestratorModel: "x/y" });
  await flush(); await flush();
  return { mm, agents, a, b, orchestratorA: bf.made[0], orchestratorB: bf.made[1] };
}
const call = (mm, sid, tool, args) => runMissionTool(mm, { sessionID: sid.replace(/^pi:/, ""), tool, args });

test("tool resolves by session", async () => {
  const { mm, a, b, orchestratorB } = await setup();
  const r = await call(mm, orchestratorB.sid, "task_add", { title: "only in B" });
  assert.match(r.output, /Added t1/);
  assert.equal(b.tasks.length, 1);
  assert.equal(a.tasks.length, 0);
  assert.match((await call(mm, "pi:stranger", "mission_state", {})).output, /not part of a mission/);
});

test("worker_spawn returns the id; worker tools are refused to the orchestrator and orchestrator tools to workers", async () => {
  const { mm, a, orchestratorA, agents } = await setup();
  await call(mm, orchestratorA.sid, "task_add", { tasks: [{ title: "Unpack" }, { title: "Map" }] });
  const r = await call(mm, orchestratorA.sid, "worker_spawn", { task: "Unpack libapp.so", task_id: "t1", kind: "opencode", scope: { files: "lib/libapp.so" } });
  assert.match(r.output, /Started worker a-\d+ \(opencode y\) for task t1/);
  const w = agents.get(r.metadata.id);
  assert.match(w.task, /lib\/libapp\.so/);
  assert.match((await call(mm, w.sid, "worker_spawn", { task: "x" })).output, /orchestrator only/);
  assert.match((await call(mm, orchestratorA.sid, "ask_orchestrator", { question: "?" })).output, /for workers/);
  assert.match((await call(mm, w.sid, "progress", { note: "found the XOR key" })).output, /Noted/);
  assert.equal(a.workers.length, 1);
});

test("mission_state is capped", async () => {
  const { mm, orchestratorA } = await setup();
  for (let i = 0; i < 80; i++) await call(mm, orchestratorA.sid, "task_add", { title: "t".repeat(190) });
  const r = await call(mm, orchestratorA.sid, "mission_state", {});
  assert.ok(r.output.length <= 4000);
  assert.match(r.output, /^Mission m-/);
});

test("ask_orchestrator waits for the orchestrator's answer via worker_message question_id", async () => {
  const { mm, a, orchestratorA, agents } = await setup();
  const r = await call(mm, orchestratorA.sid, "worker_spawn", { task: "scan" });
  const w = agents.get(r.metadata.id);
  const pending = call(mm, w.sid, "ask_orchestrator", { question: "Which ABI?" });
  await flush();
  const q = a.questions[0];
  const ans = await call(mm, orchestratorA.sid, "worker_message", { id: w.id, question_id: q.id, message: "arm64-v8a" });
  assert.match(ans.output, /Answered q\d+/);
  assert.equal((await pending).output, "The orchestrator answers: arm64-v8a");
});

test("unknown tool and bad args → readable errors", async () => {
  const { mm, orchestratorA } = await setup();
  assert.match((await call(mm, orchestratorA.sid, "rm_rf", {})).output, /Unknown mission tool/);
  assert.match((await call(mm, orchestratorA.sid, "task_update", { id: "t9", status: "done" })).output, /task_update failed: no task t9/);
  assert.match((await call(mm, orchestratorA.sid, "note", { kind: "idea", title: "x" })).output, /note kind must be one of/);
  assert.match((await call(mm, orchestratorA.sid, "kg_search", { query: "x" })).output, /not available yet/);
});

test("notify and mission_done", async () => {
  const { mm, a, orchestratorA } = await setup();
  const r = await call(mm, orchestratorA.sid, "notify", { title: "Need creds", urgency: "action", question: "Which account?" });
  assert.match(r.output, /Notification ping\d+ sent \(action\)/);
  await call(mm, orchestratorA.sid, "mission_done", { summary: "All mapped." });
  assert.equal(a.status, "done");
  assert.equal(a.notifications.at(-1).urgency, "action");
});

test("handoff is refused to a subagent; a subagent's question keeps its id", async () => {
  const { mm, a, orchestratorA, agents } = await setup();
  const r = await call(mm, orchestratorA.sid, "worker_spawn", { task: "scan" });
  const w = agents.get(r.metadata.id);
  const sub = agents.start({ kind: "pi", task: "sub", parentSid: w.sid, missionId: a.id, role: "subagent" });
  assert.match((await call(mm, agents.get(sub.id).sid, "handoff", { note: "x".repeat(60) })).output, /handoff is for a mission's workers/);
  const pending = call(mm, agents.get(sub.id).sid, "ask_orchestrator", { question: "which?" });
  await flush();
  assert.equal(a.questions[0].worker, sub.id);
  assert.match(a.queue.find((q) => q.type === "question").text, /^subagent a-\d+ is blocked/);
  mm.answerQuestion(a, a.questions[0].id, "this");
  await pending;
});
