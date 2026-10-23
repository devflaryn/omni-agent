import { test } from "node:test";
import assert from "node:assert/strict";
import { Bus } from "../server/bus.mjs";
import { GoalKeeper, LENGTH_NOTE, asksForDiscussion, asksToGoOn, buildJudgeInput, buildSummaryInput, errorBackoff, parseVerdict, tailLine, transientError } from "../server/hook.mjs";
import { hookInfo, hookMessage } from "../ui/lib.js";
import { applyPlanAction, emptyPlan } from "../ui/plan.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SID = "pi:abc";
const BRAIN = { action: "brainstorm", understanding: "u", approaches: [{ name: "a", tradeoffs: "x" }, { name: "b", tradeoffs: "y" }], chosen: "a", success_criteria: ["tests pass"] };
const PLAN = { action: "create", milestones: [{ title: "Core", steps: [{ title: "write parser", done_when: "parser tests pass" }, { title: "write printer", done_when: "printer tests pass" }] }, { title: "Ship", steps: [{ title: "update docs", done_when: "README mentions it" }] }] };
/** Usage of an assistant message whose prompt was `k` thousand tokens (mostly cache reads, as on a long run). */
const U = (k) => ({ input: 2000, output: 800, cacheRead: k * 1000 - 2000, cacheWrite: 0, total: k * 1000 + 800 });
/** Hook off, context auto-continue on: Omni's default for chats nobody set a /goal on. */
const REDUCED = { config: { enabled: false }, keeper: { contextPolicy: { compactAt: 256000, autoContinue: true, maxContextNudges: 3 } } };

function setup({ verdicts = [], config = {}, summarize, pi: piOver = {}, keeper: keeperOpts = {} } = {}) {
  const bus = new Bus();
  const pi = { proc: {}, sid: SID, streaming: false, state: { model: { provider: "orca", id: "qwen" } }, prompts: [], compacts: 0, async prompt(m, o) { this.prompts.push([m, o]); return { success: true }; }, async compact() { this.compacts++; return { success: true }; }, ...piOver };
  const judgeCalls = [];
  const judge = async (input, pick) => { judgeCalls.push({ input, pick }); const v = verdicts.shift(); if (v instanceof Error) throw v; return typeof v === "string" ? v : JSON.stringify(v); };
  const events = [];
  bus.on("event", (ev) => events.push(ev));
  const timers = [];
  const keeper = new GoalKeeper({ bus, getPi: (sid) => (sid === SID ? pi : null), judge, summarize, config: { enabled: true, graceMs: 5, maxIdleNudges: 5, summaries: !!summarize, ...config }, ...keeperOpts });
  const emit = (ev) => bus.emit({ sid: SID, harness: "pi", ts: Date.now(), ...ev });
  let plan = emptyPlan(), now = Date.now();
  const s = {
    bus, pi, keeper, judgeCalls, events, timers, emit,
    user: (text) => emit({ kind: "msg", role: "user", live: true, id: `u${Math.random()}`, blocks: [{ type: "text", text }] }),
    assistant: (text, stopReason = "stop") => emit({ kind: "msg", role: "assistant", live: true, id: `a${Math.random()}`, stopReason, blocks: text ? [{ type: "text", text }] : [] }),
    /** An assistant message with reasoning and usage: what classifyStop reads. */
    say: ({ text = "", thinking = "", stopReason = "stop", usage } = {}) => emit({ kind: "msg", role: "assistant", live: true, id: `a${Math.random()}`, stopReason, usage, blocks: [...(thinking ? [{ type: "thinking", text: thinking }] : []), ...(text ? [{ type: "text", text }] : [])] }),
    error: (text) => emit({ kind: "msg", role: "assistant", live: true, id: `e${Math.random()}`, stopReason: "error", blocks: [{ type: "text", text: `Model error: ${text}` }] }),
    logs: () => events.filter((e) => e.kind === "log").map((e) => e.text),
    goalEvents: () => events.filter((e) => e.kind === "goal"),
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

test("a pending retry is announced as armed (the UI keeps Stop live) and cancel disarms it", async () => {
  const s = setup({ config: { errorBackoffMs: 1000 } });
  s.user("Build it");
  await s.turn(() => { s.plan(BRAIN); s.plan(PLAN); s.error('503 "no upstreams available"'); });
  const armed = s.events.filter((e) => e.kind === "keeper");
  assert.ok(armed.length, "the keeper says it is about to act");
  const last = armed.at(-1);
  assert.equal(last.armed, true);
  assert.ok(last.retryAt > Date.now() + 500, "with when the retry fires");
  assert.equal(s.keeper.status(SID).armed, true, "a page reload sees it too");
  s.keeper.cancel(SID);
  const after = s.events.filter((e) => e.kind === "keeper").at(-1);
  assert.equal(after.armed, false);
  assert.equal(after.retryAt, 0);
  assert.equal(s.keeper.status(SID).armed, false);
  await sleep(1050);
  assert.equal(s.pi.prompts.length, 0, "stopped: the retry never fires");
  s.keeper.dispose();
});

test("a grace check that ends quietly disarms", async () => {
  const s = setup();
  s.user("What is 2+2?");
  await s.turn(() => s.assistant("4"));
  const k = s.events.filter((e) => e.kind === "keeper");
  assert.ok(k.some((e) => e.armed), "armed during the grace period");
  assert.equal(k.at(-1).armed, false, "nothing to do: disarmed");
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

test("the same plan step stopping loopK times escalates; idle re-engages compact + restate the goal once, then pause it", async () => {
  const s = setup({ config: { loopK: 2, maxIdleNudges: 3 } });
  s.user("Build it");
  await s.turn(() => { s.plan(BRAIN); s.plan(PLAN); s.assistant("."); });
  await s.turn(() => s.assistant("still thinking"));
  assert.match(s.last().note, /escalating/);
  assert.match(s.last().body, /try a DIFFERENT APPROACH, or revise the plan/);
  await s.turn(() => s.assistant("hm"));
  await s.turn(() => s.assistant("hm"));
  // Three idle re-engaged runs in a row: the first time it is compacted and handed the goal again, not paused.
  assert.equal(s.pi.prompts.length, 4);
  assert.equal(s.pi.compacts, 1);
  assert.equal(s.keeper.goal(SID).paused, false);
  assert.match(s.last().note, /no progress in 3 re-engagements; context compacted, goal restated/);
  assert.match(s.last().body, /The original goal, verbatim:\nBuild it/);
  assert.equal(s.last().body.match(/The original goal, verbatim/g).length, 1, "restated once");
  assert.match(s.last().body, /Current step 1\.1: write parser/);
  // Two more idle runs reach the limit again: now it pauses.
  await s.turn(() => s.assistant("hm"));
  await s.turn(() => s.assistant("hm"));
  assert.equal(s.pi.prompts.length, 5);
  assert.equal(s.pi.compacts, 1, "compacted only once");
  assert.equal(s.keeper.goal(SID).paused, true);
  assert.ok(s.events.some((e) => e.kind === "log" && /paused: 3 re-engagements in a row without any progress/.test(e.text)));
  const ge = s.goalEvents().at(-1);
  assert.equal(ge.paused, true, "the pause is announced"); assert.equal(ge.reason, "no progress");
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

// ---------------------------------------------------------------- long runs: context stops, modes, agents

test("transientError: every outage string seen in the session scans is retried; a refused request is not", () => {
  for (const t of ["503 Service Unavailable", "502 Bad Gateway", "Connection error.", "Request timed out.", "A Timeout Occurred", "Upstream idle timeout exceeded", "terminated", "400 Provider returned error", "This operation was aborted", "Upstream returned HTTP 409", "Request aborted", "Request was aborted", "read ECONNRESET", "write EPIPE", "Connection reset by peer"]) assert.ok(transientError(t), t);
  for (const t of ["400 status code (no body)", "401 Unauthorized", "404 No endpoints found for this model", "This model's maximum context length is 262144 tokens", ""]) assert.ok(!transientError(t), t);
});

test("the keeper tracks the newest assistant text, reasoning and usage, and the user's own latest words", () => {
  const s = setup();
  const typed = "<omni-memory>notes that mention a handoff</omni-memory>\nBuild it";
  s.user(typed);
  s.run();
  s.say({ text: "Plan ready.", thinking: "First the parser.", usage: U(10), stopReason: "toolUse" });
  const g = s.keeper.goal(SID);
  assert.equal(g.lastText, "Plan ready."); assert.equal(g.lastThinking, "First the parser."); assert.equal(g.lastUsage.cacheRead, 8000);
  assert.equal(g.lastUserText, typed, "kept raw: userAskedForHandoff strips the memory pack itself");
  s.emit({ kind: "msg", role: "user", live: true, id: "h", blocks: [{ type: "text", text: hookMessage("goal", "note", "Continue.") }] });
  assert.equal(g.lastUserText, typed, "a hook message is not the user's");
  s.settle(); s.run();
  assert.equal(g.lastText, "", "a new run starts clean"); assert.equal(g.lastUsage, null);
  s.keeper.dispose();
});

test("false 'context nearly full' at 441k tokens with an unfinished plan → compact + continue", async () => {
  const s = setup({ keeper: { contextPolicy: { compactAt: 256000, autoContinue: true, maxContextNudges: 3 } } });
  s.user("Port the renderer");
  await s.turn(() => {
    s.plan(BRAIN); s.plan(PLAN); s.plan({ action: "start", step: "1.1" }); s.tool();
    s.say({ text: "The parser compiles now.\n\nMy context window is almost full, so I am stopping here. Here is a handoff prompt for a fresh session: continue with step 1.1.", usage: U(441) });
  });
  assert.equal(s.pi.compacts, 1, "441k is far past a quarter of compactAt: compact first");
  assert.equal(s.pi.prompts.length, 1);
  const { note, body } = s.last();
  assert.match(note, /claiming its context was used up.*; context compacted$/);
  assert.match(body, /^Your context was just compacted automatically\./);
  assert.match(body, /never a reason to stop or hand off/);
  assert.match(body, /Current step 1\.1: write parser\nDone when: parser tests pass/);
  assert.match(body, /The original goal, verbatim:\nPort the renderer/, "the compaction may have dropped the prompt");
  assert.ok(s.logs().some((t) => /at 441k tokens; compacting the context, then continuing/.test(t)));
  s.keeper.dispose();
});

test("a context stop on a small prompt is continued without compacting, saying how full the context really is", async () => {
  const s = setup({ keeper: { contextPolicy: { compactAt: 200000, autoContinue: true } } });
  const claim = (k) => s.say({ text: "I am running low on context, so I will stop and sum up here.", usage: U(k) });
  s.user("Map the save format");
  await s.turn(() => { s.tool(); claim(40); });
  assert.equal(s.pi.compacts, 0, "40k is under a quarter of compactAt");
  assert.match(s.last().body, /^Your context is fine \(20% of the budget before automatic compaction\)\./);
  assert.doesNotMatch(s.last().body, /verbatim/);
  // Without a compaction point, 64k counts as big.
  s.keeper.setContextPolicy({ compactAt: 0 });
  s.user("Map the index format");
  await s.turn(() => { s.tool(); claim(70); });
  assert.equal(s.pi.compacts, 1);
  assert.match(s.last().body, /^Your context was just compacted automatically\./);
  assert.match(s.last().body, /The original goal, verbatim:\nMap the index format/);
  s.keeper.dispose();
});

test("user-requested handoff → no nudge", async () => {
  const handoff = "Here is the handoff prompt for a fresh session:\n\nContinue the exporter from step 3; the tests are in test/export.";
  const s = setup(REDUCED);
  s.user("Write a handoff prompt for a fresh session so I can pick this up tomorrow.");
  await s.turn(() => { s.tool(); s.say({ text: handoff, usage: U(300) }); });
  assert.equal(s.pi.prompts.length, 0, "the user asked for it");
  assert.equal(s.pi.compacts, 0);
  s.user("Finish the exporter.");
  await s.turn(() => { s.tool(); s.say({ text: handoff, usage: U(300) }); });
  assert.equal(s.pi.prompts.length, 1, "the same handoff, unasked, is a context stop");
  s.keeper.dispose();
  // With the hook on the handoff is the answer: no plan nudge on top of it, and the goal stays open for the user.
  const f = setup();
  f.user("Write a handoff prompt for a fresh session so I can continue tomorrow.");
  await f.turn(() => { f.plan(BRAIN); f.plan(PLAN); f.tool(); f.say({ text: handoff }); });
  assert.equal(f.pi.prompts.length, 0);
  assert.equal(f.keeper.goal(SID).done, false);
  assert.ok(f.logs().some((t) => /you asked for a handoff/.test(t)));
  f.keeper.dispose();
});

test("legit question to the user → no nudge", async () => {
  const q = "Both fixes work. Option A keeps the old file format; option B is faster but breaks old saves. Which option do you want?";
  const s = setup(REDUCED);
  s.user("Fix the save bug");
  await s.turn(() => { s.tool("edit"); s.say({ text: q, usage: U(120) }); });
  assert.equal(s.pi.prompts.length, 0);
  s.keeper.dispose();
  // Hook on, no plan: no "confirm or plan the rest" nudge either; the goal waits for the answer.
  const f = setup();
  f.user("Fix the save bug");
  await f.turn(() => { f.tool("edit"); f.say({ text: q }); });
  assert.equal(f.pi.prompts.length, 0);
  assert.equal(f.keeper.goal(SID).done, false);
  assert.ok(f.logs().some((t) => /it asked you something; waiting for your answer/.test(t)));
  f.keeper.dispose();
});

test("Stop/abort → no nudge", async () => {
  const s = setup({ keeper: { contextPolicy: { autoContinue: true } } });
  s.user("Build it");
  // What /api/pi/abort does: pause the goal, then abort pi (the hook itself stays on).
  s.run(); s.plan(BRAIN); s.plan(PLAN); s.tool();
  s.keeper.cancel(SID);
  s.say({ text: "Now writing the par", stopReason: "aborted" });
  s.settle(); await sleep(30);
  assert.equal(s.pi.prompts.length, 0);
  assert.equal(s.keeper.config.enabled, true);
  const ge = s.goalEvents().at(-1);
  assert.equal(ge.paused, true); assert.equal(ge.reason, "stopped by the user");
  s.keeper.dispose();
  // With the hook off, an aborted run is left alone even without a cancel.
  const r = setup(REDUCED);
  r.user("Build it");
  await r.turn(() => { r.tool(); r.say({ text: "partial", stopReason: "aborted" }); });
  assert.equal(r.pi.prompts.length, 0);
  r.keeper.dispose();
});

test("provider 409 → retry later", async () => {
  const s = setup({ config: { errorBackoffMs: 20 } });
  s.user("Build it");
  await s.turn(() => { s.plan(BRAIN); s.plan(PLAN); s.error("Upstream returned HTTP 409"); });
  assert.equal(s.pi.prompts.length, 0, "not at once");
  assert.ok(s.logs().some((t) => /provider error \(Upstream returned HTTP 409\); retrying in/.test(t)));
  await sleep(80);
  assert.equal(s.pi.prompts.length, 1);
  assert.match(s.last().body, /this is a retry/);
  assert.equal(s.pi.compacts, 0, "an outage is not compacted away");
  s.keeper.dispose();
  // Hook off + auto-continue: an outage is still retried, a refused request is left to the user.
  const r = setup({ config: { enabled: false, errorBackoffMs: 20 }, keeper: REDUCED.keeper });
  r.user("Build it");
  await r.turn(() => r.error("Connection error."));
  await sleep(80);
  assert.equal(r.pi.prompts.length, 1);
  await r.turn(() => r.error("400 status code (no body)"));
  await sleep(80);
  assert.equal(r.pi.prompts.length, 1);
  assert.equal(r.pi.compacts, 0);
  r.keeper.dispose();
});

test("length at the 16384 cap with all-reasoning output → nudge", async () => {
  const s = setup({ ...REDUCED, keeper: { ...REDUCED.keeper, maxTokensFor: (sid) => (sid === SID ? 16384 : 0) } });
  const runaway = () => s.say({ thinking: "Let me weigh the loader design once more. ".repeat(200), stopReason: "length", usage: { input: 5000, output: 16384, cacheRead: 570000, cacheWrite: 0, total: 591384 } });
  s.user("Refactor the loader");
  await s.turn(() => { s.tool(); runaway(); });
  assert.equal(s.pi.prompts.length, 1);
  assert.equal(s.last().body, LENGTH_NOTE, "hook off, no plan: just the note");
  assert.match(s.last().note, /output limit was used up before it acted \(1\/3\)/);
  await s.turn(runaway);
  await s.turn(runaway);
  assert.equal(s.pi.prompts.length, 3);
  await s.turn(runaway);
  assert.equal(s.pi.prompts.length, 3, "a fourth in a row without a tool call is left alone");
  await s.turn(() => { s.tool(); runaway(); });
  assert.equal(s.pi.prompts.length, 4, "a tool call in between starts a new streak");
  await s.turn(() => { s.tool(); s.say({ text: "The new loader reads the hea", stopReason: "length", usage: { input: 9000, output: 4000, cacheRead: 0 } }); });
  assert.equal(s.pi.prompts.length, 4, "a cut-off below the cap is pi's to recover (it compacts and retries those)");
  s.keeper.dispose();
});

test("hook disabled + autoContinue → context stop still continued, normal stop left alone", async () => {
  const s = setup(REDUCED);
  s.user("Build it");
  await s.turn(() => { s.plan(BRAIN); s.plan(PLAN); s.tool(); s.say({ text: "Stopping here for now.", usage: U(100) }); });
  assert.equal(s.pi.prompts.length, 0, "a normal stop with an unfinished plan: no plan nudge while the hook is off");
  await s.turn(() => { s.tool(); s.say({ text: "The context is getting full, so I will stop and let you continue in a new session.", usage: U(300) }); });
  assert.equal(s.pi.prompts.length, 1);
  assert.equal(s.pi.compacts, 1);
  assert.match(s.last().body, /^Your context was just compacted automatically/);
  assert.match(s.last().body, /Current step 1\.1/, "the plan's current step comes with it");
  assert.equal(s.keeper.goal(SID).done, false, "the hook-off mode never finishes a goal");
  s.keeper.setContextPolicy({ autoContinue: false });
  await s.turn(() => { s.tool(); s.say({ text: "The context is getting full, so I will stop here.", usage: U(300) }); });
  assert.equal(s.pi.prompts.length, 1, "auto-continue off too: nothing is handled");
  s.keeper.dispose();
});

test("3 context stops without progress → stop continuing", async () => {
  const s = setup(REDUCED);
  const claim = () => s.say({ text: "I have run out of context for this session, so I will stop here.", usage: U(50) });
  s.user("Build it");
  await s.turn(() => { s.tool(); claim(); });
  await s.turn(claim);
  await s.turn(claim);
  assert.equal(s.pi.prompts.length, 3);
  assert.equal(s.pi.compacts, 0, "50k is no reason to compact");
  await s.turn(claim);
  assert.equal(s.pi.prompts.length, 3, "a fourth in a row is left alone");
  assert.ok(s.logs().some((t) => /3 context stops in a row without any progress/.test(t)));
  await s.turn(() => { s.tool(); claim(); });
  assert.equal(s.pi.prompts.length, 4, "progress (a tool call) starts a new streak");
  s.keeper.dispose();
  // With the hook on, past the cap the ordinary plan logic takes over.
  const f = setup({ keeper: { contextPolicy: { compactAt: 256000, autoContinue: true, maxContextNudges: 1 } } });
  const fclaim = () => f.say({ text: "I have run out of context for this session, so I will stop here.", usage: U(50) });
  f.user("Build it");
  await f.turn(() => { f.plan(BRAIN); f.plan(PLAN); f.tool(); fclaim(); });
  assert.match(f.last().body, /^Your context is fine/);
  await f.turn(fclaim);
  assert.equal(f.pi.prompts.length, 2);
  assert.match(f.last().body, /^You stopped, but your plan is not finished/);
  f.keeper.dispose();
});

test("a plan completed by skipping steps 'because of context' is sent back to revise them, once", async () => {
  const s = setup();
  s.user("Build it");
  await s.turn(() => {
    s.plan(BRAIN); s.plan(PLAN); s.plan({ action: "done", step: "1.1", evidence: "ok" });
    s.plan({ action: "skip", step: "1.2", reason: "Not enough context left to finish this in this session" });
    s.plan({ action: "done", step: "2.1", evidence: "ok" });
    s.say({ text: "All steps are handled." });
  });
  assert.equal(s.keeper.goal(SID).done, false, "skipped for context is not finished work");
  assert.equal(s.pi.prompts.length, 1);
  assert.match(s.last().note, /1 plan step was skipped because of context/);
  assert.match(s.last().body, /- 1\.2 write printer \(skipped: Not enough context left/);
  assert.match(s.last().body, /a step may not be skipped because of context\. Reopen it now with plan action "revise"/);
  // It stops again without reopening it: the same set of skips is not sent back twice.
  await s.turn(() => s.say({ text: "Done." }));
  assert.equal(s.keeper.goal(SID).done, true);
  assert.equal(s.pi.prompts.length, 1);
  s.keeper.dispose();
});

test("a managed goal (background agent): full handling with the hook off, its task's echo never resets it, its end is announced", async () => {
  const writes = [];
  const s = setup({ config: { enabled: false }, keeper: { ledger: { writeControl: (p) => writes.push(p) } } });
  const g = s.keeper.setManagedGoal(SID, "Survey the save format");
  s.user("Survey the save format\n\n(You are a background agent started by another agent for this one task.)");
  assert.equal(s.keeper.goal(SID), g, "the echo of the task prompt did not replace it");
  assert.equal(g.text, "Survey the save format"); assert.equal(g.managed, true);
  await s.turn(() => { s.tool("read"); s.say({ text: "Read the header." }); });
  assert.equal(s.pi.prompts.length, 1, "the hook is off, yet it is handled in full");
  assert.match(s.last().body, /reply with your final report \(what you did, the results, file paths\) and stop/);
  await s.turn(() => s.say({ text: "Report: the header is 64 bytes; notes in notes/save.md." }));
  assert.equal(g.done, true);
  const done = s.goalEvents().at(-1);
  assert.equal(done.done, true); assert.equal(done.managed, true);
  assert.deepEqual(writes, [], "the run ledger belongs to the user's chat, not to an agent");
  assert.equal(s.keeper._lastSid, null, "an agent's goal is never the one a main-pi restart carries over");
  // A follow-up to the finished agent is more work on its task, ended (and announced) again.
  s.user("Also check the footer.");
  assert.equal(s.keeper.goal(SID), g); assert.equal(g.done, false);
  await s.turn(() => s.say({ text: "The footer is a CRC32 of the body." }));
  assert.equal(g.done, true);
  assert.equal(s.goalEvents().filter((e) => e.done).length, 2);
  s.keeper.dispose();
});

test("every pause is announced as a goal event (the agent manager ends a background agent's run on it)", async () => {
  const s = setup({ config: { enabled: false, errorCompactAfter: 1 } });
  s.keeper.setManagedGoal(SID, "Build it");
  for (let i = 0; i < 3; i++) await s.turn(() => s.error("400 status code (no body)"));
  assert.equal(s.keeper.goal(SID).paused, true);
  assert.equal(s.pi.compacts, 1);
  const ge = s.goalEvents().at(-1);
  assert.equal(ge.paused, true); assert.equal(ge.done, false); assert.equal(ge.managed, true);
  assert.match(ge.reason, /400 status code \(no body\)/);
  s.keeper.dispose();
});

test("background agents still running → wait: no nudge, no finish, no idle count", async () => {
  let kids = 2;
  const s = setup({ keeper: { activeChildren: (sid) => (sid === SID ? kids : 0) } });
  s.user("Build it");
  await s.turn(() => { s.plan(BRAIN); s.plan(PLAN); s.tool(); s.say({ text: "Two agents are on it; I will wait for their reports." }); });
  assert.equal(s.pi.prompts.length, 0);
  const g = s.keeper.goal(SID);
  assert.equal(g.done, false);
  assert.equal(g.recheck, true, "the heartbeat looks again in case nothing delivers their reports");
  assert.equal((await s.keeper.check(SID, g.seq)).action, "wait-children");
  assert.equal(s.logs().filter((t) => /waiting for 2 background agents/.test(t)).length, 1, "said once, not on every look");
  g.nudged = true;
  await s.turn(() => s.say({ text: "Still waiting." }));
  assert.equal(g.idleNudges, 0, "a run that stops while its agents work is not idling");
  kids = 0;
  assert.equal((await s.keeper.check(SID, g.seq)).action, "nudge");
  assert.match(s.last().note, /plan step 1\.1 is not done/);
  s.keeper.dispose();
});

test("goals survive an Omni restart: exportGoals → importGoal recreates them without prompting", async () => {
  const s = setup();
  s.keeper.setExplicitGoal(SID, "Port the app");
  s.keeper.goal(SID).nudges = 4;
  s.keeper.setGoal("pi:plain", "a plain prompt");
  s.keeper.setManagedGoal("pi:agent", "Survey X");
  s.keeper.setExplicitGoal("pi:old", "Finished goal");
  s.keeper.goal("pi:old").done = true;
  const out = JSON.parse(JSON.stringify(s.keeper.exportGoals()));
  assert.deepEqual(out.map((x) => x.sid).sort(), ["pi:abc", "pi:agent"], "explicit or managed, and not done");
  const main = out.find((x) => x.sid === SID);
  assert.deepEqual({ ...main, startedAt: 0 }, { sid: SID, text: "Port the app", explicit: true, managed: false, done: false, paused: false, nudges: 4, startedAt: 0 });
  s.keeper.dispose();
  // The restarted server's keeper takes them back; nothing is sent to pi until it decides to re-engage.
  const plan = applyPlanAction(applyPlanAction(emptyPlan(), BRAIN).plan, PLAN).plan;
  const r = setup({ pi: { async entries() { return { success: true, data: { entries: [{ type: "message", id: "x", parentId: null, message: { role: "toolResult", toolName: "plan", details: { plan } } }], leafId: "x" } }; } } });
  for (const d of out) r.keeper.importGoal(d.sid, d, { resume: d.sid === SID });
  assert.equal(r.pi.prompts.length, 0);
  const g = r.keeper.goal(SID);
  assert.equal(g.text, "Port the app"); assert.equal(g.explicit, true); assert.equal(g.nudges, 4); assert.equal(g.startedAt, main.startedAt);
  assert.equal(g.recheck, true, "resume: the heartbeat's next look re-engages it");
  assert.equal(r.keeper.goal("pi:agent").managed, true); assert.equal(r.keeper.goal("pi:agent").recheck, false);
  await r.keeper.check(SID, g.seq);
  assert.equal(r.pi.prompts.length, 1);
  assert.match(r.last().note, /plan step 1\.1 is not done \(0\/3\)/, "resumed on its plan");
  assert.equal(r.keeper.importGoal(SID, { text: " " }), null);
  r.keeper.dispose();
});

// ---------------------------------------------------------------- review fixes

test("asking permission to go on is not a question for the user: a /goal is told to plan, a plain prompt to confirm or plan; a real choice still waits", async () => {
  for (const t of ["Shall I go ahead and port it?", "Converted three files.\n\nLet me know if you want me to continue with the rest.", "Would you like me to continue with the rest, or stop here?", "Should I proceed?", "I can do the remaining files next. Do you want me to do that?", "Let me know if you’d like me to finish the docs."]) assert.ok(asksToGoOn(t), t);
  for (const t of ["Which option do you want?", "Shall I use the v2 header or the v3 one?", "Should I go ahead with A, or do you prefer B?", "Your call: shall I continue?", "What is the API key for the staging server?", "Shall I go on?\n\nAll files are converted and the tests pass."]) assert.ok(!asksToGoOn(t), t);
  // An explicit /goal with no plan: still "plan first", as before.
  const s = setup();
  s.keeper.setExplicitGoal(SID, "Port the save loader to the new format");
  await s.turn(() => { s.tool("read"); s.say({ text: "I have read the loader. It uses a v2 header.\n\nShall I go ahead and port it?" }); });
  assert.equal(s.pi.prompts.length, 1);
  assert.match(s.last().note, /this goal needs a plan first/);
  // Even a real question: a tracked goal asks through its plan (ask_user), which then waits.
  await s.turn(() => { s.tool("read"); s.say({ text: "Which header version should the new format use?" }); });
  assert.equal(s.pi.prompts.length, 2);
  assert.match(s.last().note, /this goal needs a plan first/);
  s.keeper.dispose();
  // A plain prompt after tool work that asks whether to go on: the one "confirm or plan the rest" nudge.
  const f = setup();
  f.user("Convert every .cfg in conf/ to JSON");
  await f.turn(() => { f.tool("edit"); f.say({ text: "Converted the first three files.\n\nLet me know if you want me to continue with the rest." }); });
  assert.equal(f.pi.prompts.length, 1);
  assert.match(f.last().note, /it stopped after working without a plan/);
  f.keeper.dispose();
  // A real choice on a plain prompt still waits for the user.
  const c = setup();
  c.user("Fix the header parsing");
  await c.turn(() => { c.tool("read"); c.say({ text: "Shall I use the v2 header or the v3 one?" }); });
  assert.equal(c.pi.prompts.length, 0);
  assert.equal(c.keeper.goal(SID).done, false);
  c.keeper.dispose();
});

test("context-stop nudges never escalate into 'skip the step', even after real progress between them; a planless length stop only escalates without tool calls", async () => {
  const s = setup({ keeper: { contextPolicy: { compactAt: 256000, autoContinue: true, maxContextNudges: 3 } } });
  const FIVE = { action: "create", milestones: [{ title: "M", steps: [1, 2, 3, 4, 5].map((i) => ({ title: `step ${i}`, done_when: `check ${i}` })) }] };
  const claim = () => s.say({ text: "My context window is almost full, so I am stopping here.", usage: U(300) });
  s.user("Port the renderer");
  await s.turn(() => { s.plan(BRAIN); s.plan(FIVE); });
  for (let i = 1; i <= 3; i++) await s.turn(() => { s.tool(); s.plan({ action: "done", step: `1.${i}`, evidence: "ok" }); s.tool(); claim(); });
  await s.turn(claim);
  await s.turn(claim);
  assert.equal(s.pi.prompts.length, 6);
  for (const [m] of s.pi.prompts) {
    const { note, body } = hookInfo(m);
    assert.doesNotMatch(note, /escalating/, note);
    assert.doesNotMatch(body, /You have stopped \d+ times at the same point/);
  }
  assert.equal(s.events.filter((e) => e.kind === "hook" && e.escalate).length, 0);
  s.keeper.dispose();
  // A length-cap stop without a plan, with tool work between them: not "the same point".
  const r = setup({ ...REDUCED, keeper: { ...REDUCED.keeper, maxTokensFor: () => 16384 } });
  const runaway = () => r.say({ thinking: "Weigh it again. ".repeat(100), stopReason: "length", usage: { input: 5000, output: 16384, cacheRead: 50000 } });
  r.user("Refactor the loader");
  for (let i = 0; i < 4; i++) await r.turn(() => { r.tool(); runaway(); });
  assert.equal(r.pi.prompts.length, 4);
  assert.ok(r.pi.prompts.every(([m]) => !/escalating/.test(hookInfo(m).note)));
  r.keeper.dispose();
});

test("a background agent that parks its plan on a question is told to assume and go on, then ended with the question", async () => {
  const s = setup({ config: { enabled: false } });
  s.keeper.setManagedGoal(SID, "Survey the save format");
  s.user("Survey the save format\n\n(You are a background agent started by another agent for this one task.)");
  const ask = () => { s.plan({ action: "ask_user", question: "Which game version should I target?" }); s.say({ text: "Which game version should I target?" }); };
  await s.turn(() => { s.plan(BRAIN); s.plan(PLAN); s.tool(); ask(); });
  assert.equal(s.pi.prompts.length, 1, "nobody answers a background agent mid-task");
  assert.match(s.last().note, /asked "Which game version should I target\?"; a background agent has nobody to answer it/);
  assert.match(s.last().body, /Make the most reasonable assumption for "Which game version should I target\?", note it/);
  assert.match(s.last().body, /plan action "start" on step 1\.1/);
  await s.turn(ask);
  assert.equal(s.pi.prompts.length, 2);
  await s.turn(ask);
  const g = s.keeper.goal(SID);
  assert.equal(s.pi.prompts.length, 2, "it keeps asking: end it instead");
  assert.equal(g.paused, true); assert.equal(g.done, false);
  const ge = s.goalEvents().at(-1);
  assert.equal(ge.paused, true); assert.equal(ge.managed, true);
  assert.equal(ge.reason, "it needs an answer: Which game version should I target?", "the agent that started it gets the question at once");
  s.keeper.dispose();
});

test("'400 Provider returned error' over and over: retried with a back-off, compacted once, never paused", async () => {
  const s = setup({ config: { errorBackoffMs: 1 } });
  s.keeper.setExplicitGoal(SID, "Port it");
  s.user("Port it");
  await s.turn(() => { s.plan(BRAIN); s.plan(PLAN); s.tool(); });
  for (let i = 0; i < 6; i++) { await s.turn(() => s.error("400 Provider returned error")); await sleep(60); }
  assert.equal(s.pi.compacts, 1, "a refusal code that repeats gets one compaction");
  assert.equal(s.keeper.goal(SID).paused, false, "it may still be an outage: keep retrying");
  assert.equal(s.pi.prompts.length, 7, "the plan nudge, then one retry per failure");
  assert.ok(s.logs().some((t) => /keeps rejecting the request \(400 Provider returned error\); compacting/.test(t)));
  s.keeper.dispose();
  // A plain outage is never compacted.
  const o = setup({ config: { errorBackoffMs: 1 } });
  o.user("Port it");
  for (let i = 0; i < 5; i++) { await o.turn(() => o.error("503 Service Unavailable")); await sleep(60); }
  assert.equal(o.pi.compacts, 0);
  assert.equal(o.pi.prompts.length, 5);
  o.keeper.dispose();
});

test("a new prompt sent while the keeper compacts for a context stop: the old goal's nudge is dropped", async () => {
  let release = null;
  const s = setup({ ...REDUCED, pi: { async compact() { this.compacts++; await new Promise((r) => { release = r; }); return { success: true }; } } });
  s.user("Port the renderer");
  await s.turn(() => { s.tool(); s.say({ text: "My context window is almost full, so I am stopping here.", usage: U(441) }); });
  assert.equal(s.pi.compacts, 1);
  s.user("Forget that. What does the -m flag of the CLI do?");
  release(); await sleep(20);
  assert.equal(s.pi.prompts.length, 0, "the goal it was for is gone");
  assert.equal(s.keeper.goal(SID).text, "Forget that. What does the -m flag of the CLI do?");
  s.keeper.dispose();
});

test("one trivial read, then the same context claim, over and over: continued only so often until the plan moves on", async () => {
  const s = setup(REDUCED);
  const claim = () => s.say({ text: "I have run out of context for this session, so I will stop here.", usage: U(40) });
  s.user("Port the renderer");
  for (let i = 0; i < 12; i++) await s.turn(() => { s.tool("read"); claim(); });
  assert.equal(s.pi.prompts.length, 9, "three streaks' worth (3 × maxContextNudges)");
  assert.ok(s.logs().some((t) => /9 context stops without the plan moving on; not continuing it for context again/.test(t)));
  // Real plan progress starts a new allowance.
  await s.turn(() => { s.plan(BRAIN); s.plan(PLAN); s.tool(); claim(); });
  assert.equal(s.pi.prompts.length, 10);
  // So does the user's own message.
  s.user("Go on with the renderer.");
  for (let i = 0; i < 3; i++) await s.turn(() => { s.tool("read"); claim(); });
  assert.equal(s.pi.prompts.length, 13);
  s.keeper.dispose();
});

test("a message steered into a running turn still gets its end handled (no new agent_start for a steer)", async () => {
  const s = setup(REDUCED);
  s.user("Port the importer");
  s.run(); s.pi.streaming = true;
  s.tool();
  // The user types while pi works: pi folds it into the running run, so no second "streaming: true" ever comes.
  s.user("Also keep the old format working.");
  s.tool();
  s.say({ text: "I ran out of context, so I will stop here.", usage: U(300) });
  s.pi.streaming = false; s.settle(); await sleep(30);
  assert.equal(s.pi.prompts.length, 1, "the context stop at the end of the steered run is continued");
  assert.match(s.last().body, /never a reason to stop or hand off/);
  s.keeper.dispose();
});

test("handoff wording in a /goal or an agent's task never turns its later context stops into 'the user asked for a handoff'", async () => {
  // A /goal that itself mentions a handoff: its kickoff is not a request to stop with one mid-plan.
  const s = setup({ keeper: { contextPolicy: { compactAt: 256000, autoContinue: true, maxContextNudges: 3 } } });
  s.keeper.setExplicitGoal(SID, "Port the exporter. When everything is done, write a handoff note for tomorrow.");
  s.user("Port the exporter. When everything is done, write a handoff note for tomorrow.\n\n(Tracked goal: first brainstorm and plan it with the plan tool, then work through the plan until every step is done.)");
  await s.turn(() => {
    s.plan(BRAIN); s.plan(PLAN); s.plan({ action: "start", step: "1.1" }); s.tool();
    s.say({ text: "Parser done. My context is nearly exhausted, so here is a handoff prompt for a fresh session.", usage: U(420) });
  });
  assert.equal(s.pi.compacts, 1, "treated as a context stop: compacted");
  assert.match(s.last().body, /never a reason to stop or hand off/);
  s.keeper.dispose();
  // A background agent whose task mentions a handoff is continued too, not marked done with a partial report.
  const a = setup({ config: { enabled: false }, keeper: { contextPolicy: { compactAt: 256000, autoContinue: true, maxContextNudges: 3 } } });
  const g = a.keeper.setManagedGoal(SID, "Map the save format and write a handoff note with the offsets.");
  a.user("Map the save format and write a handoff note with the offsets.\n\n(You are a background agent started by another agent for this one task.)");
  await a.turn(() => { a.tool("read"); a.say({ text: "I ran out of context, so I will stop here.", usage: U(30) }); });
  assert.equal(g.done, false, "not finished on a context claim");
  assert.match(a.last().body, /never a reason to stop or hand off/);
  a.keeper.dispose();
  // A real later request from the user still counts.
  const r = setup(REDUCED);
  r.user("Port the importer.");
  r.user("Stop there and write me a handoff prompt for a fresh session.");
  await r.turn(() => r.say({ text: "Here is the handoff prompt for a fresh session: continue with the importer tests." }));
  assert.equal(r.pi.prompts.length, 0, "the user's own request is honoured");
  r.keeper.dispose();
});

test("a plain prompt that asks for discussion (brainstorm, what do you think) is answered, not re-engaged to plan", async () => {
  // Seen live: "now lets brainstorm what to do…" got a long answer after a few reads, then "You stopped after working
  // without a plan… call the plan tool now", which the user had to Stop.
  for (const t of ["change of plan. now lets brainstorm what to do for now, without giving a prompt for the new agent", "What do you think about splitting the loader?", "Give me your thoughts on the hook layer before we start", "Let's discuss the options first"]) assert.ok(asksForDiscussion(t), t);
  for (const t of ["Convert every .cfg in conf/ to JSON", "Fix the header parsing and explain the change"]) assert.ok(!asksForDiscussion(t), t);
  const s = setup();
  s.user("now lets brainstorm what to do for now");
  await s.turn(() => { s.tool("read"); s.say({ text: "Here is my read: the loader is the risk. I would archive the old work first, then start from the clean build." }); });
  assert.equal(s.pi.prompts.length, 0, "no nudge");
  assert.equal(s.keeper.goal(SID).done, true);
  s.keeper.dispose();
  // Stopping part-way still gets the one nudge, even in a discussion.
  const f = setup();
  f.user("What do you think, and then port the first file?");
  await f.turn(() => { f.tool("read"); f.say({ text: "Looks fine.\n\nShall I go ahead and port it?" }); });
  assert.equal(f.pi.prompts.length, 1);
  f.keeper.dispose();
});
