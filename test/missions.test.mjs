import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../server/bus.mjs";
import { ProjectStore } from "../server/projects.mjs";
import { MissionManager, compactReport, renderState } from "../server/missions.mjs";
import { BOSS_TOOLS } from "../server/boss-prompt.mjs";
import { SUMMARY_REQUEST, WORKER_FOOTER } from "../server/worker-contract.mjs";
import { FakeAgents, bossFactory, fakeClock, flush } from "./helpers/mission-fakes.mjs";

const base = mkdtempSync(join(tmpdir(), "omni-missions-"));
after(() => rmSync(base, { recursive: true, force: true }));
let k = 0;
function setup({ boss = true, config = {}, clock = null } = {}) {
  const d = join(base, `t${++k}`);
  const dir = join(d, "repo"); mkdirSync(dir, { recursive: true });
  const bus = new Bus();
  const agents = new FakeAgents();
  const bf = bossFactory(bus);
  const store = new ProjectStore({ root: join(d, "projects") });
  const c = clock || fakeClock();
  const mm = new MissionManager({ bus, store, agents, createBoss: boss ? bf.createBoss : null, config: { heartbeatMs: 0, ...config }, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer });
  const events = []; bus.on("event", (e) => events.push(e));
  return { d, dir, bus, agents, bf, store, mm, clock: c, events };
}
const spec = (dir, x = {}) => ({ dir, goal: "Map the auth flow of app.apk", bossModel: "opencode-go/kimi", fallbackModel: "opencode/free", ...x });

// ------------------------------------------------------------------ model
test("create validates and persists", () => {
  const { mm, dir, store } = setup({ boss: false });
  assert.throws(() => mm.create({ dir, bossModel: "x/y" }), (e) => e.status === 400);
  assert.throws(() => mm.create({ dir: join(dir, "nope"), goal: "g", bossModel: "x/y" }), (e) => e.status === 400);
  assert.throws(() => mm.create({ dir, goal: "g" }), (e) => e.status === 400);
  const m = mm.create(spec(dir));
  assert.match(m.id, /^m-[0-9a-f]{8}$/);
  assert.deepEqual(m.bossModel, { provider: "opencode-go", id: "kimi" });
  const p = store.project(dir);
  assert.ok(existsSync(join(p.missionsDir, m.id, "mission.json")));
  assert.equal(mm.list()[0].id, m.id);
  assert.ok(!existsSync(join(dir, ".omni")), "nothing in the project dir");
});

test("tasks and notes", () => {
  const { mm, dir, store } = setup({ boss: false });
  const m = mm.create(spec(dir));
  const t1 = mm.addTask(m, { title: "Unpack libapp.so" });
  const t2 = mm.addTask(m, { title: "Find the login request" });
  const t11 = mm.addTask(m, { title: "Dump after relocation", parent: "t1" });
  assert.deepEqual([t1.id, t2.id, t11.id], ["t1", "t2", "t1.1"]);
  assert.deepEqual(m.tasks.map((t) => t.id), ["t1", "t1.1", "t2"]);
  assert.throws(() => mm.updateTask(m, "t1", { status: "finished" }), (e) => e.status === 400);
  mm.updateTask(m, "t1", { status: "active", summary: "packer is a custom XOR" });
  assert.throws(() => mm.addNote(m, { kind: "idea", title: "x" }), (e) => e.status === 400);
  mm.addNote(m, { kind: "dead_end", title: "frida-server", body: "no frida here; use the lab" });
  const led = readFileSync(join(store.project(dir).missionsDir, m.id, "ledger.md"), "utf8");
  assert.match(led, /Unpack libapp\.so/);
  assert.match(led, /\[dead_end\] frida-server/);
});

test("notify emits a bus event and stores it", () => {
  const { mm, dir, events } = setup({ boss: false });
  const m = mm.create(spec(dir));
  const n = mm.notify(m, { title: "Need the APK password", urgency: "action", question: "Which account?" });
  assert.equal(m.notifications.length, 1);
  const ev = events.find((e) => e.kind === "notify");
  assert.equal(ev.notification.id, n.id);
  assert.equal(ev.mission, m.id);
  mm.markNotification(m, n.id, { answer: "the test account" });
  assert.equal(m.notifications[0].answer, "the test account");
  assert.match(m.queue.at(-1).text, /the test account/);
});

test("renderState is capped and readable", () => {
  const { mm, dir } = setup({ boss: false });
  const m = mm.create(spec(dir));
  mm.addTask(m, { title: "Unpack" }); mm.updateTask(m, "t1", { status: "active" });
  const s = renderState(m, { workers: [] });
  assert.match(s, /Goal: Map the auth flow/);
  assert.match(s, /\[active\] t1 Unpack/);
  for (let i = 0; i < 50; i++) mm.addTask(m, { title: "x".repeat(150) });
  assert.ok(renderState(m, { max: 4000 }).length <= 4000);
});

test("two missions share a project", () => {
  const { mm, dir } = setup({ boss: false });
  const a = mm.create(spec(dir)), b = mm.create(spec(dir, { goal: "other" }));
  assert.equal(a.slug, b.slug);
  assert.notEqual(a.id, b.id);
});

// ------------------------------------------------------------------ boss
test("create starts the boss with the boss allowlist and system; briefing is the first prompt", async () => {
  const { mm, dir, bf } = setup();
  const m = mm.create(spec(dir));
  await flush(); await flush();
  const boss = bf.made[0];
  assert.deepEqual(boss.opts.tools, BOSS_TOOLS);
  assert.match(boss.opts.system, /You are the boss/);
  assert.equal(boss.opts.model, "kimi"); assert.equal(boss.opts.provider, "opencode-go");
  assert.equal(m.status, "running");
  assert.equal(boss.prompts.length, 1);
  assert.match(boss.prompts[0].text, /^\[mission m-[0-9a-f]{8}\] A new mission/);
  assert.equal(mm.bySession(boss.sid).id, m.id);
});

test("queue delivers one at a time when idle; user messages jump the queue", async () => {
  const { mm, dir, bf, bus } = setup();
  const m = mm.create(spec(dir));
  await flush(); await flush();
  const boss = bf.made[0];
  boss.stream(true); // the briefing turn is running
  mm.enqueue(m, { type: "event", text: "first" });
  mm.enqueue(m, { type: "event", text: "second" });
  mm.messageBoss(m, "hurry up");
  assert.equal(boss.prompts.length, 1);
  bus.emit({ sid: boss.sid, kind: "msg", role: "assistant", live: true, stopReason: "stop", blocks: [{ type: "text", text: "planned" }] });
  boss.stream(false); // briefing turn over
  await flush();
  assert.equal(boss.prompts.length, 2);
  assert.match(boss.prompts[1].text, /Message from the user:\nhurry up/);
  boss.turn(); await flush();
  assert.match(boss.prompts[2].text, /first/);
  boss.turn(); await flush();
  assert.match(boss.prompts[3].text, /second/);
  boss.turn(); await flush();
  assert.equal(m.queue.length, 0);
});

test("queue survives a reload", async () => {
  const s = setup({ boss: false });
  const m = s.mm.create(spec(s.dir));
  s.mm.enqueue(m, { type: "event", text: "pending thing" });
  const bf = bossFactory(s.bus);
  const mm2 = new MissionManager({ bus: s.bus, store: s.store, agents: s.agents, createBoss: bf.createBoss, config: { heartbeatMs: 0 } });
  mm2.reconcile();
  const m2 = mm2.get(m.id);
  assert.ok(m2.queue.some((q) => /pending thing/.test(q.text)));
  await flush(); await flush();
  assert.equal(bf.made.length, 1);
});

test("boss errors back off, switch to fallback once, notify once", async () => {
  const { mm, dir, bf, clock } = setup();
  const m = mm.create(spec(dir));
  await flush(); await flush();
  const boss = bf.made[0];
  boss.turn({ error: "429 rate limited" }); await flush();
  assert.equal(m.errors.consecutive, 1);
  assert.deepEqual(clock.pending()[0], 15000);
  assert.equal(boss.prompts.length, 1);
  await clock.tick(15000);
  assert.equal(boss.prompts.length, 2, "retried the same item");
  assert.equal(boss.prompts[1].text, boss.prompts[0].text);
  boss.turn({ error: "429" }); await flush();
  assert.equal(clock.pending()[0], 30000);
  await clock.tick(30000);
  boss.turn({ error: "429" }); await flush(); await flush();
  assert.deepEqual(boss.models, ["opencode/free"]);
  assert.equal(m.usingFallback, true);
  assert.equal(m.notifications.filter((n) => /fallback/.test(n.title)).length, 1);
  assert.equal(clock.pending()[0], 60000);
  await clock.tick(60000);
  boss.turn({ error: "still" }); await flush(); await flush();
  assert.equal(m.notifications.filter((n) => /fallback/.test(n.title)).length, 1, "no second fallback notice");
  assert.equal(boss.models.length, 1);
});

test("a boss turn that ends without any reply is retried, not dropped", async () => {
  const { mm, dir, bf, clock } = setup();
  const m = mm.create(spec(dir));
  await flush(); await flush();
  const boss = bf.made[0];
  boss.stream(true); boss.stream(false); // the watchdog aborted a stalled stream: no assistant message
  await flush();
  assert.equal(m.queue.length, 1, "the briefing is still queued");
  assert.match(m.errors.lastError, /without a reply/);
  await clock.tick(15000);
  assert.equal(boss.prompts.length, 2);
});

test("success resets the error count; primary is retried after an hour", async () => {
  const { mm, dir, bf, clock } = setup({ config: { fallbackAfter: 1 } });
  const m = mm.create(spec(dir));
  await flush(); await flush();
  const boss = bf.made[0];
  boss.turn({ error: "down" }); await flush(); await flush();
  assert.equal(m.usingFallback, true);
  await clock.tick(15000);
  boss.turn(); await flush();
  assert.equal(m.errors.consecutive, 0);
  await clock.tick(3600000);
  mm.enqueue(m, { text: "later" });
  await flush(); await flush();
  assert.deepEqual(boss.models, ["opencode/free", "opencode-go/kimi"]);
  assert.equal(m.usingFallback, false);
});

test("boss exit restarts it on the same session", async () => {
  const { mm, dir, bf, clock } = setup();
  const m = mm.create(spec(dir));
  await flush(); await flush();
  const file = m.boss.sessionFile;
  bf.made[0].crash(1);
  assert.equal(bf.made.length, 1);
  await clock.tick(15000); await flush(); await flush();
  assert.equal(bf.made.length, 2);
  assert.deepEqual(bf.made[1].switched, [file]);
  assert.equal(bf.made[1].prompts.length, 1, "the undelivered briefing is retried, no second briefing");
});

test("rebirth past 60 %", async () => {
  const { mm, dir, bf } = setup();
  const m = mm.create(spec(dir));
  await flush(); await flush();
  const boss = bf.made[0];
  mm.addTask(m, { title: "Unpack" });
  boss.turn({ context: 650000 }); await flush(); await flush(); await flush();
  assert.equal(boss.newSessions, 1);
  assert.equal(m.boss.generation, 2);
  assert.equal(m.boss.previous.length, 1);
  const last = boss.prompts.at(-1).text;
  assert.match(last, /taking over this mission/);
  assert.match(last, /\[todo\] t1 Unpack/);
});

test("heartbeat only when workers run and nothing queued", async () => {
  const { mm, dir, bf, clock, agents } = setup({ config: { heartbeatMs: 1800000 } });
  const m = mm.create(spec(dir));
  await flush(); await flush();
  bf.made[0].turn(); await flush();
  await clock.tick(1800000);
  assert.equal(bf.made[0].prompts.length, 1, "no workers → no heartbeat");
  mm.spawnWorker(m, { task: "scan" });
  bf.made[0].turn(); await flush(); // nothing pending
  await clock.tick(1800000); await flush();
  assert.match(bf.made[0].prompts.at(-1).text, /Heartbeat/);
  assert.equal(agents.list().length, 1);
});

// ------------------------------------------------------------------ workers
test("spawn tags the agent and writes the brief", () => {
  const { mm, dir, agents, store } = setup({ boss: false });
  const m = mm.create(spec(dir));
  mm.addTask(m, { title: "Unpack" });
  const w = mm.spawnWorker(m, { task: "Unpack libapp.so and dump it", taskId: "t1", kind: "opencode", scope: { files: ["lib/arm64-v8a/libapp.so"], kg: ["packer"] } });
  const r = agents.get(w.id);
  assert.equal(r.parentSid, `mission:${m.id}`);
  assert.equal(r.missionId, m.id); assert.equal(r.role, "worker"); assert.equal(r.taskId, "t1");
  assert.equal(r.footer, WORKER_FOOTER);
  assert.equal(r.kind, "pi"); assert.equal(r.model, "kimi"); assert.equal(r.provider, "opencode-go");
  assert.match(r.task, /libapp\.so/); assert.match(r.task, /Artifacts/);
  assert.equal(m.tasks[0].status, "active");
  assert.ok(existsSync(join(store.project(dir).missionsDir, m.id, "workers", w.id, "brief.md")));
  assert.throws(() => mm.spawnWorker(m, { task: "x", taskId: "t9" }), (e) => e.status === 400);
  const c = mm.spawnWorker(m, { task: "refactor", kind: "claude" });
  assert.equal(agents.get(c.id).kind, "claude"); assert.equal(agents.get(c.id).model, "");
});

test("report capping, task summary, empty report", async () => {
  const { mm, dir, agents } = setup({ boss: false });
  const m = mm.create(spec(dir));
  mm.addTask(m, { title: "Unpack" });
  const w = mm.spawnWorker(m, { task: "Unpack", taskId: "t1" });
  const big = `## Status\ndone\n## Outcome\nUnpacked: XOR 0x5A over .text\n## What works\n${"x".repeat(100000)}`;
  agents.end(w.id, "done", big);
  const item = m.queue.at(-1);
  assert.equal(item.type, "report");
  assert.ok(item.text.length <= 8000, String(item.text.length));
  assert.match(item.text, /full report: .*reports.*\.md/);
  assert.equal(m.tasks[0].summary, "Unpacked: XOR 0x5A over .text");
  assert.equal(agents.get(w.id).delivered, true);
  const w2 = mm.spawnWorker(m, { task: "Other" });
  agents.end(w2.id, "error", "", { error: "API 500" });
  assert.match(m.queue.at(-1).text, /## Status\nstuck/);
  assert.match(m.queue.at(-1).text, /API 500/);
  assert.equal(m.queue.filter((q) => q.type === "report").length, 2, "delivered once each");
});

test("compactReport of an interrupted worker hints at resuming", () => {
  const t = compactReport({ id: "a-1", kind: "pi", title: "x", status: "interrupted", resultText: "" }, "");
  assert.match(t, /worker_message resumes it/);
});

test("summary of a running worker asks it and returns its answer", async () => {
  const { mm, dir, agents, bus } = setup({ boss: false });
  const m = mm.create(spec(dir));
  const w = mm.spawnWorker(m, { task: "scan" });
  const p = mm.workerSummary(m, w.id, { timeoutMs: 5000 });
  await flush();
  assert.equal(agents.messages[0].text, SUMMARY_REQUEST);
  bus.emit({ sid: agents.get(w.id).sid, kind: "msg", role: "assistant", live: true, blocks: [{ type: "text", text: "looking at it" }] });
  bus.emit({ sid: agents.get(w.id).sid, kind: "msg", role: "assistant", live: true, blocks: [{ type: "text", text: "## Status\npartial\n## Outcome\nfound 3 candidates" }] });
  assert.match(await p, /found 3 candidates/);
  agents.end(w.id, "done", "## Status\ndone\n## Outcome\nall good");
  assert.match(await mm.workerSummary(m, w.id), /all good/);
});

test("user message to worker is relayed to boss", async () => {
  const { mm, dir, agents } = setup({ boss: false });
  const m = mm.create(spec(dir));
  const w = mm.spawnWorker(m, { task: "scan" });
  await mm.messageWorker(m, w.id, "look at libfoo too", { from: "user" });
  assert.equal(agents.messages[0].text, "[from the user] look at libfoo too");
  assert.match(m.queue.at(-1).text, /The user told worker a-\d+ directly: look at libfoo too/);
  await mm.messageWorker(m, w.id, "ok", { from: "boss" });
  assert.equal(m.queue.filter((q) => /told worker/.test(q.text)).length, 1);
});

test("ask_boss waits for the boss's answer", async () => {
  const { mm, dir } = setup({ boss: false });
  const m = mm.create(spec(dir));
  const w = mm.spawnWorker(m, { task: "scan" });
  const p = mm.askBoss(m, w.id, "Which ABI?");
  const q = m.questions[0];
  assert.match(m.queue[0].text, /asks \(q\d+\):\nWhich ABI\?/);
  assert.equal(mm.answerQuestion(m, q.id, "arm64-v8a"), true);
  assert.equal(await p, "arm64-v8a");
  assert.equal(mm.answerQuestion(m, q.id, "again"), false);
});
