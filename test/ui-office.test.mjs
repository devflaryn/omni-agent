import { test } from "node:test";
import assert from "node:assert/strict";
import { createOffice, officeData, officeState, sceneKey, renderOffice, labelOffice, dur, LIGHT } from "../ui/office.js";
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
  assert.deepEqual({ ...w1, subs: w1.subs.map((s) => `${s.kind}:${s.state}`) }, { id: "a-1", kind: "claude", state: "working", task: "t2", title: "Fix the loader", step: 2, of: 5, turns: 9, tokens: "184K", time: "1H2M", subs: ["claude:done", "shell:done"] });
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

test("pixel fonts: upper case, unknown characters as spaces, fit() shortens with two dots", () => {
  assert.equal(textWidth("ABC"), 11); assert.equal(textWidth("ABC", 5), 17);
  assert.equal(fit("a long title here", 8), "A LONG..");
  assert.equal(fit("short", 8), "SHORT");
  const img = { w: 20, h: 10, rgba: new Uint8ClampedArray(20 * 10 * 4) };
  text(img, "1", 0, 0, "#ffffff", { shadow: null });
  assert.equal([...img.rgba].filter((v, i) => i % 4 === 0 && v === 255).length, 8, "the 3x5 '1' has 8 pixels");
});
