import { test } from "node:test";
import assert from "node:assert/strict";
import { createOffice, officeData, officeState, sceneKey, renderOffice, labelOffice, keepRecentDone, projector, dur, LIGHT } from "../ui/office.js";
import { buildTree } from "../ui/mission.js";
import { text, fit, textWidth } from "../ui/office-font.js";
import { SAMPLE } from "../scripts/office-preview.mjs";

const mission = {
  id: "m-00000001", status: "running", createdAt: 1_000_000, workers: ["a-1", "a-2", "a-3"],
  tasks: [{ id: "t1", status: "done" }, { id: "t2", status: "active" }, { id: "t3", status: "todo" }],
  orchestrator: { contextUsed: 312000, contextWindow: 1000000, generation: 2 }, orchestratorModel: { provider: "opencode-go", id: "kimi" },
};
const agents = [
  { id: "a-1", missionId: mission.id, role: "worker", kind: "claude", status: "running", title: "Fix the loader", taskId: "t2", sid: "claude:x", startedAt: 1_000_000, plan: { done: 2, of: 5 }, tokens: 184000, turns: 9, subtasks: [{ id: "tu1", title: "grep", status: "done", startedAt: 1 }] },
  { id: "a-2", missionId: mission.id, role: "worker", kind: "pi", status: "error", title: "Diff 2.743 vs 2.744", sid: "pi:y", startedAt: 1_000_000, endedAt: 1_060_000 },
  { id: "a-3", missionId: mission.id, role: "subagent", kind: "shell", status: "done", title: "build apks", parentSid: "claude:x", startedAt: 1_000_000, endedAt: 1_006_000 },
];

test("officeData: the orchestrator's numbers, each worker with its plan step, tokens and time, its subagents and jobs under it", () => {
  const d = officeData(mission, buildTree(mission, agents), { px: "running" }, 1_000_000 + 3_725_000);
  assert.deepEqual(d.orchestrator, { state: "working", model: "opencode-go/kimi", tasksDone: 1, tasksTotal: 3, workers: 3, busy: 1, ctx: "312K", ctxMax: "1.0M", time: "1H2M", generation: 2 });
  const [w1, w2] = d.workers;
  assert.deepEqual({ ...w1, subs: w1.subs.map((s) => `${s.kind}:${s.state}`) }, { id: "a-1", kind: "claude", state: "working", task: "t2", title: "Fix the loader", step: 2, of: 5, turns: 9, tokens: "184K", time: "1H2M", subs: ["shell:done", "claude:done"] }, "newest first when no one is busy");
  assert.equal(w2.state, "failed"); assert.equal(w2.time, "1M"); assert.equal(w2.step, null);
  assert.deepEqual(["running", "starting", "done", "error", "timeout", "queued", "cancelled", "interrupted", "weird"].map(officeState), ["working", "working", "done", "failed", "failed", "queued", "stopped", "stopped", "working"]);
  assert.deepEqual([0, 5000, 65000, 3_600_000, 90_000_000].map(dur), ["0S", "5S", "1M5S", "1H0M", "1D1H"]);
});

test("the 3D scene is reused until someone's state changes; numbers alone only redraw the text", () => {
  const a = structuredClone(SAMPLE), b = structuredClone(SAMPLE);
  b.workers[0].tokens = "999K"; b.orchestrator.tasksDone = 23;
  assert.equal(sceneKey(a), sceneKey(b), "text changes keep the scene");
  b.workers[1].state = "done";
  assert.notEqual(sceneKey(a), sceneKey(b), "a state change re-renders");
  const office = createOffice();
  const t0 = Date.now(); office.draw(a); const first = Date.now() - t0;
  const t1 = Date.now(); office.draw({ ...a, orchestrator: { ...a.orchestrator, tasksDone: 25 } }); const second = Date.now() - t1;
  assert.ok(second * 3 < first, `the text pass (${second} ms) is much cheaper than the full render (${first} ms)`);
});

test("the office has a hit box for the orchestrator, every worker and every shown subagent; the selected one is marked", () => {
  const { base, layout } = renderOffice(SAMPLE);
  assert.equal(base.w, 520);
  const plain = labelOffice(base, layout, SAMPLE);
  const ids = plain.hits.map((h) => h.id);
  assert.deepEqual(ids.filter((x) => !x.startsWith("s")), ["orchestrator", ...SAMPLE.workers.map((w) => w.id)]);
  assert.deepEqual(ids.filter((x) => x.startsWith("s")), ["s1", "s2"], "two subagents at most at desks (+1 more written)");
  for (const h of plain.hits) assert.ok(h.x >= -40 && h.y >= -10 && h.x + h.w <= base.w + 40 && h.y + h.h <= base.h + 10 && h.w > 10 && h.h > 10, JSON.stringify(h));
  const sel = labelOffice(base, layout, SAMPLE, { selected: "a2" });
  const diff = sel.img.rgba.reduce((n, v, i) => n + (v !== plain.img.rgba[i] ? 1 : 0), 0);
  assert.ok(diff > 20, "selection brackets are drawn");
  assert.ok(plain.img.rgba.some((v, i) => i % 4 === 3 && v === 255));
});

test("each state lights the screens differently (stopped = off) and the scene draws without workers", () => {
  assert.equal(LIGHT.stopped, null);
  assert.equal(new Set(Object.values(LIGHT).filter(Boolean)).size, 5);
  const empty = createOffice().draw({ seed: "m-x", orchestrator: { ...SAMPLE.orchestrator, state: "idle", tasksDone: 0, tasksTotal: 0, workers: 0 }, workers: [] });
  assert.equal(empty.hits.length, 1);
});

test("no text in the office overlaps other text, however many desks and subagents", () => {
  const long = "A very long title that has to be cut somewhere";
  const sub = (id, kind = "claude", state = "working") => ({ id, kind, state, title: long, step: null, of: null, turns: 4, tokens: "1.2M", time: "1H15M" });
  const worker = (id, kind, subs) => ({ id, kind, state: "working", task: "t6.7.2.1", title: long, step: 12, of: 30, turns: 1640, tokens: "1.2M", time: "12H15M", subs });
  const data = { ...SAMPLE, workers: [worker("a", "claude", [sub("s1"), sub("s2", "shell"), sub("s3")]), worker("b", "pi", []), worker("c", "pi", [sub("s4")]), worker("d", "claude", [sub("s5"), sub("s6"), sub("s7")]), worker("e", "pi", []), worker("f", "claude", []), worker("g", "pi", [sub("s8", "pi")]), { ...worker("h", "pi", []), step: null, of: null }, worker("i", "claude", [])] };
  for (const d of [SAMPLE, data]) {
    const { labels } = createOffice().draw(d);
    assert.ok(labels.length > 20);
    for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) {
      const [a, b] = [labels[i], labels[j]];
      assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y, `"${a.s}" overlaps "${b.s}"`);
    }
  }
});

test("finished desks leave: the newest 5 workers done and the newest 3 shell jobs done stay; failed, stopped and busy ones stay", () => {
  const rec = (id, role, kind, status, endedAt, extra = {}) => ({ id, missionId: mission.id, role, kind, status, title: id, sid: `pi:${id}`, startedAt: 1, endedAt, ...extra });
  const agents = [
    ...[1, 2, 3, 4, 5, 6, 7].map((i) => rec(`done${i}`, "worker", "pi", "done", 1000 + i)),
    rec("bad", "worker", "claude", "error", 10), rec("off", "worker", "pi", "cancelled", 11), rec("busy", "worker", "pi", "running", undefined),
    // shell jobs: orphans on the floor, and under a worker; 3 of the 5 done ones survive however they are spread out
    ...[1, 2, 3].map((i) => rec(`sh${i}`, "subagent", "shell", "done", 2000 + i, { parentSid: "pi:nobody" })),
    ...[4, 5].map((i) => rec(`sh${i}`, "subagent", "shell", "done", 2000 + i, { parentSid: "pi:busy" })),
    rec("shrun", "subagent", "shell", "running", undefined, { parentSid: "pi:busy" }),
  ];
  const d = officeData(mission, buildTree(mission, agents), { px: "running" }, 5000);
  const all = d.workers.flatMap((w) => [w.id, ...w.subs.map((s) => s.id)]);
  for (const gone of ["done1", "done2", "sh1", "sh2"]) assert.ok(!all.includes(gone), `${gone} left`);
  for (const stays of ["done3", "done4", "done5", "done6", "done7", "bad", "off", "busy", "sh3", "sh4", "sh5", "shrun"]) assert.ok(all.includes(stays), `${stays} stays`);
  assert.equal(d.workers.find((w) => w.id === "busy").subs[0].id, "shrun", "whoever is busy gets the desk first");
  assert.equal(keepRecentDone([], () => [], () => 0).tops.length, 0);
});

test("the 3D pass can run in a worker: the page keeps labelling the last finished scene and is told when a new one is ready", () => {
  let posted = [], ready = 0;
  const fake = { postMessage: (m) => posted.push(m) };
  const office = createOffice({ spawn: () => fake, onReady: () => ready++ });
  assert.equal(office.draw(SAMPLE), null, "nothing to show yet");
  assert.equal(posted.length, 1);
  const answer = (m) => {
    const { base, layout } = renderOffice(structuredClone(m.data));
    assert.deepEqual(projector(base.view)([10, 20, 30]), base.project([10, 20, 30]));
    fake.onmessage({ data: { key: m.key, layout, base: { w: base.w, h: base.h, rgba: base.rgba, view: base.view } } });
  };
  answer(posted[0]);
  assert.equal(ready, 1);
  const first = office.draw(SAMPLE);
  assert.ok(first.hits.length > 3);
  const next = structuredClone(SAMPLE); next.workers[1].state = "done";
  assert.equal(office.draw(next).version, first.version, "the old scene stays up while the new one is drawn");
  assert.equal(posted.length, 2);
  office.draw(next);
  assert.equal(posted.length, 2, "one at a time");
  answer(posted[1]);
  assert.ok(office.draw(next).version > first.version);
});

test("pixel fonts: upper case, unknown characters as spaces, fit() shortens with two dots", () => {
  assert.equal(textWidth("ABC"), 11); assert.equal(textWidth("ABC", 5), 17);
  assert.equal(fit("a long title here", 8), "A LONG..");
  assert.equal(fit("short", 8), "SHORT");
  const img = { w: 20, h: 10, rgba: new Uint8ClampedArray(20 * 10 * 4) };
  text(img, "1", 0, 0, "#ffffff", { shadow: null });
  assert.equal([...img.rgba].filter((v, i) => i % 4 === 0 && v === 255).length, 8, "the 3x5 '1' has 8 pixels");
});
