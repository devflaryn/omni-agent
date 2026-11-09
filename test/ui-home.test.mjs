// Home's list of what is going on (ui/home.js): running work first, then the newest chats, from every machine.
import { test } from "node:test";
import assert from "node:assert/strict";
import { recentRows } from "../ui/home.js";

const ws = { loaded: true };
const machine = (key, label) => ({ key, label });
const chat = (sid, at, extra = {}) => ({ sid, title: `chat ${sid}`, lastActivity: at, ...extra });

test("running chats come first, then the newest, across machines", () => {
  const groups = [
    { m: machine("here", "This computer"), ws, sessions: [chat("a", 300), chat("b", 100, { streaming: true })] },
    { m: machine("id-2", "Studio"), ws, sessions: [chat("c", 500), chat("d", 50)] },
  ];
  const rows = recentRows(groups, { now: 1000 });
  assert.deepEqual(rows.map((r) => r.s.sid), ["b", "c", "a", "d"]);
  assert.equal(rows[0].running, true);
  assert.equal(rows[1].m.label, "Studio");
});

test("a chat touched a moment ago is recent, not running: only a streaming turn is", () => {
  const rows = recentRows([{ m: machine("here", "Here"), ws, sessions: [chat("a", 999)] }], { now: 1000 });
  assert.equal(rows[0].running, false);
});

test("an agent's chat shows only while it runs, untitled chats never, and the list is short", () => {
  const sessions = [chat("agent-idle", 900, { parentSid: "x" }), chat("agent-busy", 800, { parentSid: "x", streaming: true }), { sid: "untitled", lastActivity: 990 }];
  for (let i = 0; i < 10; i++) sessions.push(chat(`n${i}`, i));
  const rows = recentRows([{ m: machine("here", "Here"), ws, sessions }], { now: 1000 });
  const sids = rows.map((r) => r.s.sid);
  assert.ok(sids.includes("agent-busy"));
  assert.ok(!sids.includes("agent-idle"));
  assert.ok(!sids.includes("untitled"));
  assert.equal(rows.length, 6);
});

test("a machine that has not loaded adds nothing", () => {
  assert.deepEqual(recentRows([{ m: machine("id-3", "Laptop"), ws: { loaded: false }, sessions: [chat("a", 1)] }]), []);
});
