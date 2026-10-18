import { test } from "node:test";
import assert from "node:assert/strict";
import { Bus } from "../server/bus.mjs";
import { GoalKeeper, LENGTH_NOTE, buildJudgeInput, buildSummaryInput, errorBackoff, parseVerdict, tailLine, transientError } from "../server/hook.mjs";
import { hookInfo } from "../ui/lib.js";
import { applyPlanAction, emptyPlan } from "../ui/plan.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SID = "pi:abc";
const BRAIN = { action: "brainstorm", understanding: "u", approaches: [{ name: "a", tradeoffs: "x" }, { name: "b", tradeoffs: "y" }], chosen: "a", success_criteria: ["tests pass"] };
const PLAN = { action: "create", milestones: [{ title: "Core", steps: [{ title: "write parser", done_when: "parser tests pass" }, { title: "write printer", done_when: "printer tests pass" }] }, { title: "Ship", steps: [{ title: "update docs", done_when: "README mentions it" }] }] };

function setup({ verdicts = [], config = {}, summarize, pi: piOver = {} } = {}) {
  const bus = new Bus();
  const pi = { proc: {}, sid: SID, streaming: false, state: { model: { provider: "orca", id: "qwen" } }, prompts: [], compacts: 0, async prompt(m, o) { this.prompts.push([m, o]); return { success: true }; }, async compact() { this.compacts++; return { success: true }; }, ...piOver };
  const judgeCalls = [];
  const judge = async (input, pick) => { judgeCalls.push({ input, pick }); const v = verdicts.shift(); if (v instanceof Error) throw v; return typeof v === "string" ? v : JSON.stringify(v); };
  const events = [];
  bus.on("event", (ev) => events.push(ev));
  const timers = [];
  const keeper = new GoalKeeper({ bus, getPi: (sid) => (sid === SID ? pi : null), judge, summarize, config: { enabled: true, graceMs: 5, maxIdleNudges: 5, summaries: !!summarize, ...config } });
  const emit = (ev) => bus.emit({ sid: SID, harness: "pi", ts: Date.now(), ...ev });
  let plan = emptyPlan(), now = Date.now();
  const s = {
    bus, pi, keeper, judgeCalls, events, timers, emit,
    user: (text) => emit({ kind: "msg", role: "user", live: true, id: `u${Math.random()}`, blocks: [{ type: "text", text }] }),
    assistant: (text, stopReason = "stop") => emit({ kind: "msg", role: "assistant", live: true, id: `a${Math.random()}`, stopReason, blocks: text ? [{ type: "text", text }] : [] }),
    tool: (name = "bash") => { emit({ kind: "msg", role: "assistant", live: true, id: `t${Math.random()}`, stopReason: "toolUse", blocks: [{ type: "tool_call", name, args: {} }] }); emit({ kind: "msg", role: "tool", live: true, id: `r${Math.random()}`, blocks: [{ type: "tool_result", name, text: "ok" }] }); },
    /** The agent calls the plan tool: the result reaches the keeper as the live tool event (and the tool-result message). */
    plan: (action) => {
      const r = applyPlanAction(plan, action, { now: ++now });
      assert.ok(r.ok, r.text);
      plan = r.plan;
      const details = { plan: r.plan, events: r.events, ok: true };
      emit({ kind: "msg", role: "assistant", live: true, id: `p${Math.random()}`, stopReason: "toolUse", blocks: [{ type: "tool_call", name: "plan", args: action }] });
      emit({ kind: "tool", phase: "end", name: "plan", toolId: "x", text: r.text, details });
      emit({ kind: "msg", role: "tool", live: true, id: `pr${Math.random()}`, blocks: [{ type: "tool_result", name: "plan", text: r.text, details }] });
      return r;
    },
    run: () => emit({ kind: "status", streaming: true }),
    settle: () => emit({ kind: "status", streaming: false }),
    turn: async (fn) => { s.run(); await fn?.(); s.settle(); await sleep(30); },
    last: () => hookInfo(pi.prompts.at(-1)?.[0] || ""),
  };
  return s;
}

test("helpers: verdict parsing, judge input, tail lines, error classes and back-off", () => {
  assert.deepEqual(parseVerdict('Sure.\n{"done": false, "reason": "stopped after planning"}\nThanks'), { done: false, reason: "stopped after planning" });
  assert.equal(parseVerdict("I think it is done"), null);
  const s = buildJudgeInput({ goal: "Build it", tail: Array.from({ length: 30 }, (_, i) => `assistant: step ${i} ${"x".repeat(400)}`) }, { maxChars: 2000 });
  assert.match(s, /^You are the checker/); assert.match(s, /step 29/); assert.doesNotMatch(s, /step 0 /);
  assert.equal(tailLine({ kind: "msg", role: "assistant", stopReason: "length", blocks: [{ type: "text", text: "hi" }] }), "assistant: hi\n(assistant message ended: length)");
  assert.ok(transientError('503 "no upstreams available"'));
  assert.ok(transientError("Request timed out."));
  assert.ok(transientError("429 Too Many Requests"));
  assert.ok(!transientError("400 status code (no body)"), "a rejected request is not retried blindly");
  assert.deepEqual([1, 2, 3, 10].map((n) => errorBackoff(n, { base: 1000, cap: 5000 })), [1000, 2000, 4000, 5000]);
});

test("an unfinished plan re-engages the agent on its current step — no model is asked", async () => {
  const s = setup();
  s.user("Build the feature");
  await s.turn(() => { s.plan(BRAIN); s.plan(PLAN); s.plan({ action: "start", step: "1.1" }); s.tool(); s.assistant("I'll continue later."); });
  assert.equal(s.judgeCalls.length, 0, "no judge");
  assert.equal(s.pi.prompts.length, 1);
  const [msg, opts] = s.pi.prompts[0];
  assert.equal(opts.echo, false, "the hook prompt is not shown as a user bubble");
  const info = hookInfo(msg);
  assert.equal(info.name, "goal");
  assert.equal(info.note, "Goal hook re-engaged the agent (#1): plan step 1.1 is not done (0/3)");
  assert.match(info.body, /Current step 1\.1: write parser\nDone when: parser tests pass/);
  const hook = s.events.find((e) => e.kind === "hook");
  assert.equal(hook.attempt, 1);
  const planEvents = s.events.filter((e) => e.kind === "plan");
  assert.equal(planEvents.length, 3, "one plan event per change (the tool event and the tool-result message are de-duplicated)");
  assert.equal(planEvents.at(-1).progress.current.id, "1.1");
  s.keeper.dispose();
});

test("every plan step done → the goal is done and latched; nothing is re-engaged", async () => {
  const s = setup();
  s.user("Build it");
  await s.turn(() => { s.plan(BRAIN); s.plan(PLAN); s.plan({ action: "done", step: "1.1", evidence: "ok" }); s.plan({ action: "done", step: "1.2", evidence: "ok" }); s.plan({ action: "skip", step: "2.1", reason: "no docs" }); s.assistant("All done."); });
  assert.equal(s.pi.prompts.length, 0);
  const g = s.keeper.goal(SID);
  assert.equal(g.done, true);
  const ge = s.events.find((e) => e.kind === "goal");
  assert.equal(ge.done, true); assert.match(ge.reason, /every step of the plan is done \(2 done, 1 skipped\)/);
  await s.turn(() => s.assistant("extra"));
  assert.equal(s.pi.prompts.length, 0, "a finished goal stays finished");
  s.keeper.dispose();
});

test("a plan reopened after done (revise) makes the goal live again", async () => {
  const s = setup();
  s.user("Build it");
  await s.turn(() => { s.plan(BRAIN); s.plan({ action: "create", milestones: [{ title: "M", steps: [{ title: "a", done_when: "a ok" }] }] }); s.plan({ action: "done", step: "1.1", evidence: "ok" }); s.assistant("Done."); });
  assert.equal(s.keeper.goal(SID).done, true);
  await s.turn(() => { s.plan({ action: "revise", reason: "found a bug", milestones: [{ title: "Fix", steps: [{ title: "fix bug", done_when: "repro passes" }] }] }); s.assistant("Pausing."); });
  assert.equal(s.keeper.goal(SID).done, false);
  assert.equal(s.pi.prompts.length, 1);
  assert.match(s.last().body, /Current step 2\.1: fix bug/);
  s.keeper.dispose();
});

test("ask_user parks the goal; the user's answer resumes it", async () => {
  const s = setup();
  s.user("Deploy it");
  await s.turn(() => { s.plan(BRAIN); s.plan(PLAN); s.plan({ action: "ask_user", question: "Which region?" }); s.assistant("Which region?"); });
  assert.equal(s.pi.prompts.length, 0, "waiting on the user: no nudge");
  assert.ok(s.events.some((e) => e.kind === "log" && /waiting for your answer — Which region\?/.test(e.text)));
  // An explicit goal keeps its text across the user's answer; the answer clears the wait.
  s.keeper.setExplicitGoal(SID, "Deploy it");
  s.user("eu-west-1");
  await s.turn(() => s.assistant("ok"));
  assert.equal(s.pi.prompts.length, 1);
  assert.match(s.last().note, /plan step 1\.1 is not done/);
  s.keeper.dispose();
});

test("an explicit /goal without a plan is re-engaged to brainstorm and plan first, and outlives plain prompts", async () => {
  const s = setup();
  s.keeper.setExplicitGoal(SID, "Port the app");
  s.user("also keep the old API");
  assert.equal(s.keeper.goal(SID).text, "Port the app");
  await s.turn(() => { s.tool(); s.assistant("Started."); });
  assert.equal(s.pi.prompts.length, 1);
  assert.match(s.last().note, /this goal needs a plan first/);
  assert.match(s.last().body, /action "brainstorm".*then action "create"/s);
  s.keeper.dispose();
});

test("planless work: a plain answer just ends; tool work gets one 'confirm or plan' nudge, then ends", async () => {
  const s = setup();
  s.user("What is 2+2?");
  await s.turn(() => s.assistant("4"));
  assert.equal(s.pi.prompts.length, 0);
  assert.equal(s.keeper.goal(SID).done, true);
  s.user("Rename foo to bar");
  await s.turn(() => { s.tool("edit"); s.assistant("Renamed."); });
  assert.equal(s.pi.prompts.length, 1);
  assert.match(s.last().body, /If the request is completely done and verified, reply with one short final answer/);
  await s.turn(() => s.assistant("Yes, done."));
  assert.equal(s.pi.prompts.length, 1, "no endless nudging of a finished planless task");
  assert.equal(s.keeper.goal(SID).done, true);
  assert.equal(s.judgeCalls.length, 0);
  s.keeper.dispose();
});

test("the judge is only an opt-in fallback for planless work", async () => {
  const s = setup({ config: { judgeFallback: true }, verdicts: [{ done: false, reason: "tests not run" }] });
  s.user("Fix the bug");
  await s.turn(() => { s.tool(); s.assistant("Fixed."); });
  assert.equal(s.judgeCalls.length, 1);
  assert.deepEqual(s.judgeCalls[0].pick, { provider: "orca", model: "qwen" });
  assert.match(s.last().note, /tests not run/);
  // With a plan, the plan decides even when the fallback is on.
  await s.turn(() => { s.plan(BRAIN); s.plan(PLAN); s.assistant("."); });
  assert.equal(s.judgeCalls.length, 1);
  assert.match(s.last().note, /plan step 1\.1/);
  s.keeper.dispose();
});

test("a reply cut off by the output limit is re-engaged with 'think briefly, act now'", async () => {
  const s = setup();
  s.user("Build it");
  await s.turn(() => { s.plan(BRAIN); s.plan(PLAN); s.assistant("", "length"); });
  assert.equal(s.pi.prompts.length, 1);
  assert.ok(s.last().body.startsWith(LENGTH_NOTE));
  assert.match(s.last().body, /Current step 1\.1/);
  // Without a plan it is re-engaged too: it clearly stopped mid-task.
  s.user("Other thing");
  await s.turn(() => s.assistant("", "length"));
  assert.equal(s.pi.prompts.length, 2);
  assert.ok(s.last().body.startsWith(LENGTH_NOTE));
  s.keeper.dispose();
});

test("a provider outage (503) is retried after a back-off instead of nudging at once", async () => {
  const s = setup({ config: { errorBackoffMs: 1000 } });
  s.user("Build it");
  await s.turn(() => { s.plan(BRAIN); s.plan(PLAN); s.emit({ kind: "msg", role: "assistant", live: true, id: "e1", stopReason: "error", blocks: [{ type: "text", text: 'Model error: 503 "no upstreams available"' }] }); });
  assert.equal(s.pi.prompts.length, 0, "not yet");
  assert.ok(s.events.some((e) => e.kind === "log" && /provider error \(503 "no upstreams available"\); retrying in 1s/.test(e.text)));
  await sleep(1050);
  assert.equal(s.pi.prompts.length, 1);
  assert.match(s.last().body, /this is a retry/);
  s.keeper.dispose();
});

test("rejected requests (400) are retried, then the context is compacted, then the goal pauses", async () => {
  const s = setup({ config: { errorCompactAfter: 2 } });
  const fail = () => s.emit({ kind: "msg", role: "assistant", live: true, id: `e${Math.random()}`, stopReason: "error", blocks: [{ type: "text", text: "Model error: 400 status code (no body)" }] });
  s.user("Build it");
  await s.turn(fail);
  assert.equal(s.pi.prompts.length, 1); assert.equal(s.pi.compacts, 0);
  await s.turn(fail);
  assert.equal(s.pi.compacts, 1, "the same request keeps failing: compact first");
  assert.equal(s.pi.prompts.length, 2);
  assert.match(s.last().body, /context was compacted/);
  await s.turn(fail);
  assert.equal(s.pi.prompts.length, 3);
  await s.turn(fail);
  assert.equal(s.pi.prompts.length, 3, "still rejected after compacting: paused, not an endless pile of nudges");
  assert.equal(s.keeper.goal(SID).paused, true);
  // A success in between resets the error streak.
  s.user("again");
  await s.turn(fail);
  await s.turn(() => { s.tool(); s.assistant("worked"); });
  assert.equal(s.keeper.goal(SID).errorStops, 0);
  s.keeper.dispose();
});

test("the same plan step stopping loopK times escalates; idle re-engages pause the goal", async () => {
  const s = setup({ config: { loopK: 2, maxIdleNudges: 3 } });
  s.user("Build it");
  await s.turn(() => { s.plan(BRAIN); s.plan(PLAN); s.assistant("."); });
  await s.turn(() => s.assistant("still thinking"));
  assert.match(s.last().note, /escalating/);
  assert.match(s.last().body, /try a DIFFERENT APPROACH, or revise the plan/);
  await s.turn(() => s.assistant("hm"));
  await s.turn(() => s.assistant("hm"));
  assert.equal(s.pi.prompts.length, 3, "three idle re-engaged runs in a row → paused");
  assert.equal(s.keeper.goal(SID).paused, true);
  assert.ok(s.events.some((e) => e.kind === "log" && /paused: 3 re-engagements in a row without any progress/.test(e.text)));
  s.user("go on");
  assert.equal(s.keeper.goal(SID).paused, false, "a user message resumes");
  s.keeper.dispose();
});

test("a finished plan from an earlier prompt does not end a new goal", async () => {
  const s = setup();
  s.user("First");
  await s.turn(() => { s.plan(BRAIN); s.plan({ action: "create", milestones: [{ title: "M", steps: [{ title: "a", done_when: "ok" }] }] }); s.plan({ action: "done", step: "1.1", evidence: "ok" }); s.assistant("done"); });
  await sleep(5);
  s.keeper.setExplicitGoal(SID, "Second, bigger goal");
  await s.turn(() => { s.tool(); s.assistant("working"); });
  assert.equal(s.keeper.goal(SID).done, false);
  assert.match(s.last().note, /this goal needs a plan first/);
  s.keeper.dispose();
});

test("a new prompt during the grace period cancels the pending check; cancel pauses until resumed", async () => {
  const s = setup({ config: { graceMs: 40 } });
  s.user("First");
  s.run(); s.plan(BRAIN); s.plan(PLAN); s.assistant("."); s.settle();
  s.keeper.cancel(SID);
  await sleep(80);
  assert.equal(s.pi.prompts.length, 0, "the user stopped pi");
  assert.equal(s.keeper.goal(SID).paused, true);
  s.keeper.resume(SID);
  assert.equal(s.keeper.goal(SID).paused, false);
  s.keeper.dispose();
});

test("status boxes come from the side conversation at plan milestones — never from tool counts, never into the chat", async () => {
  const calls = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const s = setup({ config: { enabled: false, summaryProvider: "sumP", summaryModel: "sumM" }, summarize: async (input, pick) => { calls.push({ input, pick }); if (calls.length === 1) await gate; return `status ${calls.length}`; } });
  s.user("Build it");
  for (let i = 0; i < 30; i++) s.tool();
  await sleep(10);
  assert.equal(calls.length, 0, "30 tool calls alone write no status");
  s.plan(BRAIN);
  assert.equal(calls.length, 0, "a brainstorm is not a milestone");
  s.plan(PLAN);
  assert.equal(calls.length, 1, "plan written → status");
  assert.match(calls[0].input, /What just happened: the agent wrote its plan\./);
  assert.match(calls[0].input, /<plan>\nPLAN · execute · 0\/3 steps/);
  assert.equal(calls[0].pick.provider, "sumP"); assert.equal(calls[0].pick.model, "sumM");
  assert.match(calls[0].pick.conversation, /^[0-9a-f-]{36}$/, "its own side conversation for this goal");
  s.plan({ action: "done", step: "1.1", evidence: "ok" });
  s.plan({ action: "done", step: "1.2", evidence: "ok" });
  assert.equal(calls.length, 1, "calls never overlap: the milestone waits for the first summary");
  release();
  await sleep(20);
  assert.equal(calls.length, 2);
  assert.match(calls[1].input, /What just happened: a milestone was reached\./);
  assert.match(calls[1].input, /Previous status:\n<status>\nstatus 1/);
  assert.equal(calls[1].pick.conversation, calls[0].pick.conversation, "the same conversation all through the goal");
  const sums = s.events.filter((e) => e.kind === "summary");
  assert.deepEqual(sums.map((e) => e.text), ["status 1", "status 2"]);
  assert.equal(sums[1].progress.milestonesDone, 1);
  assert.equal(s.pi.prompts.length, 0, "summaries are never sent to pi");
  s.keeper.dispose();
});

test("buildSummaryInput carries the goal, the plan, the event and only the new work", () => {
  const plan = applyPlanAction(applyPlanAction(emptyPlan(), BRAIN).plan, PLAN).plan;
  const t = buildSummaryInput({ goal: "G", plan, reason: "a milestone was reached", tail: ["tool result bash: ok"], previous: "old" });
  assert.match(t, /^Goal:\n<goal>\nG\n<\/goal>/);
  assert.match(t, /\[ \] 1\.1 write parser/);
  assert.match(t, /What just happened: a milestone was reached\./);
  assert.match(t, /Work since the previous status/);
});

test("a re-engage that could not be sent is retried on the heartbeat; an idle goal is never re-checked on a timer", async () => {
  let fail = true;
  const s = setup({ config: { heartbeatMs: 5000 }, pi: { async prompt(m, o) { if (fail) throw new Error("pi busy"); this.prompts.push([m, o]); return {}; } } });
  s.keeper.stopHeartbeat();
  s.user("Build it");
  await s.turn(() => { s.plan(BRAIN); s.plan(PLAN); s.assistant("."); });
  const g = s.keeper.goal(SID);
  assert.equal(g.recheck, true);
  fail = false;
  await s.keeper.check(SID, g.seq);
  assert.equal(s.pi.prompts.length, 1);
  assert.equal(g.recheck, false);
  s.keeper.dispose();
});

test("ledger, restarts and status: the goal and its plan survive a new session id", async () => {
  const writes = [];
  const bus = new Bus();
  const pi = { sid: "pi:1", proc: {}, streaming: false, state: {}, prompt: async () => ({}) };
  const keeper = new GoalKeeper({ bus, getPi: () => pi, ledger: { writeControl: (p) => writes.push(p) }, config: { enabled: true } });
  keeper.setGoal("pi:1", "DO THE THING", true);
  assert.ok(writes.some((w) => w.goalText === "DO THE THING"));
  const plan = applyPlanAction(applyPlanAction(emptyPlan(), BRAIN).plan, PLAN).plan;
  keeper.onPlan("pi:1", { plan, events: ["created"] });
  keeper.attachToSid("pi:1", "pi:2");
  assert.equal(keeper.goal("pi:1"), null);
  const st = keeper.status("pi:2");
  assert.equal(st.goal, "DO THE THING"); assert.equal(st.explicit, true); assert.equal(st.progress.steps, 3);
  keeper.finish("pi:2", keeper.goal("pi:2"), "test");
  assert.ok(writes.some((w) => w.status === "done"));
  keeper.dispose();
});

test("a session the keeper did not watch live (restart, resumed run) gets its plan from pi's session entries, once", async () => {
  const plan = applyPlanAction(applyPlanAction(emptyPlan(), BRAIN).plan, PLAN).plan;
  let reads = 0;
  const s = setup({ pi: { async entries() { reads++; return { success: true, data: { entries: [{ type: "message", id: "x", parentId: null, message: { role: "toolResult", toolName: "plan", details: { plan } } }], leafId: "x" } }; } } });
  s.keeper.setExplicitGoal(SID, "Resume the work");
  const g = s.keeper.goal(SID);
  g.recheck = true;
  await s.keeper.check(SID, g.seq);
  assert.equal(reads, 1);
  assert.equal(s.pi.prompts.length, 1);
  assert.match(s.last().note, /plan step 1\.1 is not done \(0\/3\)/, "resumed on the restored plan, not asked to plan again");
  assert.deepEqual(s.events.find((e) => e.kind === "plan").events, ["restored"]);
  await s.turn(() => s.tool());
  assert.equal(reads, 1, "looked up once");
  s.keeper.dispose();
});

test("retries during a provider outage are not counted as the agent idling", async () => {
  const s = setup({ config: { errorBackoffMs: 1000, maxIdleNudges: 2 } });
  s.user("Build it");
  await s.turn(() => { s.plan(BRAIN); s.plan(PLAN); s.assistant("."); });
  const outage = () => s.emit({ kind: "msg", role: "assistant", live: true, id: `e${Math.random()}`, stopReason: "error", blocks: [{ type: "text", text: "Model error: 502 Bad Gateway" }] });
  for (let i = 0; i < 4; i++) { await s.turn(outage); s.keeper.goal(SID).nudged = true; }
  assert.equal(s.keeper.goal(SID).idleNudges, 0);
  assert.equal(s.keeper.goal(SID).paused, false, "an outage never pauses the goal");
  s.keeper.dispose();
});
