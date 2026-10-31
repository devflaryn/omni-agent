import { test } from "node:test";
import assert from "node:assert/strict";
import { bossState, buildTree, unreadCount } from "../ui/mission.js";

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
  assert.equal(t.layers, 4, "boss, workers, subagents, sub-subagents");
  assert.equal(buildTree(m, []).layers, 1);
  const withSubs = buildTree(m, [a("a-7", { role: "worker", kind: "claude", sid: "claude:x", subtasks: [{ id: "toolu_1", title: "Explore auth", status: "running", startedAt: 1 }] })]);
  assert.deepEqual(withSubs.workers[0].children.map((c) => [c.id, c.kind, c.status]), [["a-7/toolu_1", "claude-sub", "running"]]);
});

test("bossState and unreadCount", () => {
  assert.equal(bossState({ ...m, status: "paused" }).text, "paused");
  assert.equal(bossState({ ...m, errors: { consecutive: 2, lastError: "429" } }).tone, "err");
  assert.equal(bossState(m, { streaming: true }).text, "thinking");
  assert.match(bossState({ ...m, queue: [{}, {}] }).text, /2 queued/);
  assert.equal(unreadCount([{ notifications: [{ read: false }, { read: true }] }, { notifications: [{ read: false }] }]), 2);
});
