import { test } from "node:test";
import assert from "node:assert/strict";
import { orchestratorState, buildTree, unreadCount } from "../ui/mission.js";

const m = { id: "m-1", status: "running", queue: [], errors: { consecutive: 0 } };
const a = (id, x) => ({ id, kind: "pi", status: "running", title: id, missionId: "m-1", createdAt: Number(id.slice(2)), activity: [], ...x });

test("buildTree: workers, their subagents (recursively) and orphans; other missions ignored", () => {
  const agents = [
    a("a-1", { role: "worker", sid: "pi:w1" }),
    a("a-2", { role: "worker", sid: "pi:w2", status: "done" }),
    a("a-3", { role: "subagent", sid: "pi:s3", parentSid: "pi:w1" }),
    a("a-4", { role: "subagent", sid: "pi:s4", parentSid: "pi:s3" }),
    a("a-5", { role: "subagent", sid: "pi:s5", parentSid: "pi:gone" }),
    a("a-6", { role: "worker", missionId: "m-2" }),
  ];
  const t = buildTree(m, agents);
  assert.deepEqual(t.workers.map((w) => w.id), ["a-1", "a-2"], "active first");
  assert.deepEqual(t.workers[0].children.map((c) => c.id), ["a-3"]);
  assert.deepEqual(t.workers[0].children[0].children.map((c) => c.id), ["a-4"]);
  assert.deepEqual(t.orphans.map((o) => o.id), ["a-5"]);
  assert.equal(t.layers, 4, "orchestrator, workers, subagents, sub-subagents");
  assert.equal(buildTree(m, []).layers, 1);
  const withSubs = buildTree(m, [a("a-7", { role: "worker", kind: "claude", sid: "claude:x", subtasks: [{ id: "toolu_1", title: "Explore auth", status: "running", startedAt: 1 }] })]);
  assert.deepEqual(withSubs.workers[0].children.map((c) => [c.id, c.kind, c.status]), [["a-7/toolu_1", "claude-sub", "running"]]);
});

test("the New mission dialog closes on Esc, like every other dialog, and lets go of its key listener", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../ui/mission.js", import.meta.url), "utf8");
  const fn = src.slice(src.indexOf("async function openNew"), src.indexOf("function reset()"));
  assert.match(fn, /e\.key === "Escape"/);
  assert.match(fn, /document\.addEventListener\("keydown", onKey\)/);
  assert.match(fn, /document\.removeEventListener\("keydown", onKey\)/);
  assert.equal(fn.match(/wrap\.remove\(\)/g)?.length, 1, "every way out goes through close(), which drops the listener");
});

test("orchestratorState and unreadCount", () => {
  assert.equal(orchestratorState({ ...m, status: "paused" }).text, "paused");
  assert.equal(orchestratorState({ ...m, errors: { consecutive: 2, lastError: "429" } }).tone, "err");
  assert.equal(orchestratorState(m, { streaming: true }).text, "thinking");
  assert.match(orchestratorState({ ...m, queue: [{}, {}] }).text, /2 queued/);
  assert.equal(unreadCount([{ notifications: [{ read: false }, { read: true }] }, { notifications: [{ read: false }] }]), 2);
});

test("a chat follows its newest line only while the reader is there: any move up stops it, only the bottom restarts it", async () => {
  const { nextFollow } = await import("../ui/transcript.js");
  // 100 px above the bottom and moving up: still stops following (the old rule pulled anyone within 200 px back down)
  assert.equal(nextFollow(true, { top: 900, lastTop: 1000, gap: 100 }), false);
  assert.equal(nextFollow(true, { top: 995, lastTop: 1000, gap: 5 }), false, "the first pixels of a move up count, though still near the bottom");
  assert.equal(nextFollow(false, { top: 950, lastTop: 900, gap: 50 }), false, "moving down without reaching the bottom does not restart it");
  assert.equal(nextFollow(false, { top: 1000, lastTop: 950, gap: 10 }), true);
  assert.equal(nextFollow(true, { top: 1000, lastTop: 1000, gap: 300 }), true, "content growing below does not stop it");
});
