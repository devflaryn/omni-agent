import { test } from "node:test";
import assert from "node:assert/strict";
import { Bus } from "../server/bus.mjs";
import { GoalKeeper, buildJudgeInput, parseVerdict, tailLine } from "../server/hook.mjs";
import { hookInfo } from "../ui/lib.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SID = "pi:abc";

function setup({ verdicts = [], config = {}, summarize } = {}) {
  const bus = new Bus();
  const pi = { proc: {}, sid: SID, streaming: false, state: { model: { provider: "orca", id: "qwen" } }, prompts: [], async prompt(m, o) { this.prompts.push([m, o]); return { success: true }; } };
  const judgeCalls = [];
  const judge = async (input, pick) => { judgeCalls.push({ input, pick }); const v = verdicts.shift(); if (v instanceof Error) throw v; return typeof v === "string" ? v : JSON.stringify(v); };
  const events = [];
  bus.on("event", (ev) => events.push(ev));
  const keeper = new GoalKeeper({ bus, getPi: (sid) => (sid === SID ? pi : null), judge, summarize, config: { enabled: true, graceMs: 10, maxIdleNudges: 2, summaries: !summarize ? false : true, ...config } });
  const emit = (ev) => bus.emit({ sid: SID, harness: "pi", ts: Date.now(), ...ev });
  const user = (text) => emit({ kind: "msg", role: "user", live: true, id: `u${Date.now()}`, blocks: [{ type: "text", text }] });
  const assistant = (text, stopReason = "stop") => emit({ kind: "msg", role: "assistant", live: true, id: `a${Date.now()}`, stopReason, blocks: [{ type: "text", text }] });
  const run = () => emit({ kind: "status", streaming: true });
  const settle = () => emit({ kind: "status", streaming: false });
  return { bus, pi, keeper, judge, judgeCalls, events, emit, user, assistant, run, settle };
}

test("parseVerdict pulls the JSON object out of a chatty reply and rejects junk", () => {
  assert.deepEqual(parseVerdict('Sure.\n{"done": false, "reason": "stopped after planning", "nudge": "Do it."}\nThanks'), { done: false, reason: "stopped after planning", nudge: "Do it." });
  assert.deepEqual(parseVerdict('```json\n{"done":true,"reason":"all files written"}\n```'), { done: true, reason: "all files written", nudge: "" });
  assert.equal(parseVerdict("I think it is done"), null);
  assert.equal(parseVerdict('{"reason":"no done field"}'), null);
});

test("buildJudgeInput keeps the most recent tail within the budget", () => {
  const tail = Array.from({ length: 30 }, (_, i) => `assistant: step ${i} ${"x".repeat(400)}`);
  const s = buildJudgeInput({ goal: "Build it", tail, nudges: 1, idleNudges: 1, maxIdleNudges: 5, stopReason: "stop" }, { maxChars: 2000 });
  assert.match(s, /User's request:\n<request>\nBuild it\n<\/request>/);
  assert.match(s, /^You are the supervisor/);
  assert.match(s, /Answer now with exactly one JSON object/);
  assert.match(s, /step 29/);
  assert.doesNotMatch(s, /step 0 /);
  assert.match(s, /earlier steps omitted/);
  assert.match(s, /re-engaged for this request: 1\. Re-engagements in a row after which it made no tool call: 1 of 5/);
  assert.match(buildJudgeInput({ goal: "g", tail: [] }), /produced nothing/);
});

test("tailLine summarises assistant text, tool calls and tool results", () => {
  assert.equal(tailLine({ kind: "msg", role: "assistant", blocks: [{ type: "text", text: "Hi" }, { type: "tool_call", name: "bash", args: { command: "ls" } }], stopReason: "toolUse" }), 'assistant: Hi\ntool call bash({"command":"ls"})');
  assert.equal(tailLine({ kind: "msg", role: "assistant", blocks: [{ type: "text", text: "Oops" }], stopReason: "error" }), "assistant: Oops\n(assistant message ended: error)");
  assert.equal(tailLine({ kind: "msg", role: "tool", blocks: [{ type: "tool_result", name: "read", text: "Read image file", isError: false, images: [{}] }] }), "tool result read: Read image file [1 image(s)]");
  assert.equal(tailLine({ kind: "msg", role: "user", blocks: [] }), null);
});

test("keeper re-engages pi with a hook-wrapped prompt (not echoed) and emits a hook event when the judge says not done", async () => {
  const s = setup({ verdicts: [{ done: false, reason: "It only wrote a plan.", nudge: "Implement the plan." }] });
  s.user("Build the feature");
  s.run(); s.assistant("Here is my plan."); s.settle();
  await sleep(60);
  assert.equal(s.judgeCalls.length, 1);
  assert.match(s.judgeCalls[0].input, /Build the feature/);
  assert.match(s.judgeCalls[0].input, /assistant: Here is my plan\./);
  assert.deepEqual(s.judgeCalls[0].pick, { provider: "orca", model: "qwen" });
  assert.equal(s.pi.prompts.length, 1);
  const [msg, opts] = s.pi.prompts[0];
  assert.equal(opts.echo, false);
  const info = hookInfo(msg);
  assert.equal(info.name, "goal");
  assert.equal(info.note, "Goal hook re-engaged the agent (#1): It only wrote a plan.");
  assert.match(info.body, /Implement the plan\./);
  const hook = s.events.find((e) => e.kind === "hook");
  assert.ok(hook, "hook event broadcast");
  assert.equal(hook.text, info.note);
  assert.equal(hook.attempt, 1);
  assert.ok(!s.events.some((e) => e.kind === "msg" && e.role === "user" && e.blocks[0].text.includes("omni-hook")), "the hook prompt is not shown as a user message");
  s.keeper.dispose();
});

test("keeper stays quiet when the judge says done, keeps re-engaging without limit, and never permanently gives up", async () => {
  const notDone = (i) => ({ done: false, reason: `r${i}` });
  // loopK high so loop-escalation never fires here — this test is about never permanently stopping.
  const s = setup({ config: { loopK: 99 }, verdicts: [{ done: true, reason: "finished" }, ...Array.from({ length: 12 }, (_, i) => notDone(i + 1))] });
  const toolCall = () => s.emit({ kind: "msg", role: "assistant", live: true, id: `t${Date.now()}`, stopReason: "toolUse", blocks: [{ type: "tool_call", toolId: "c1", name: "bash", args: { command: "ls" } }] });
  s.user("Do X");
  s.run(); s.assistant("Done."); s.settle();
  await sleep(50);
  assert.equal(s.pi.prompts.length, 0);
  // five re-engaged runs that each make a tool call: well past the old cap of 5, still going
  for (let i = 1; i <= 5; i++) { s.run(); toolCall(); s.assistant("More."); s.settle(); await sleep(50); assert.equal(s.pi.prompts.length, i); }
  assert.equal(s.events.filter((e) => e.kind === "hook").at(-1).idle, 0);
  // a nudged run with no tool call counts as idle (tracked in the hook event), but it still re-engages
  s.run(); s.assistant("I cannot."); s.settle(); await sleep(50);
  assert.equal(s.pi.prompts.length, 6);
  assert.match(hookInfo(s.pi.prompts[5][0]).note, /^Goal hook re-engaged the agent \(#6\): r6/);
  s.run(); toolCall(); s.assistant("Trying."); s.settle(); await sleep(50);
  assert.equal(s.pi.prompts.length, 7);
  assert.equal(s.events.filter((e) => e.kind === "hook").at(-1).idle, 0, "a tool call reset the idle count");
  // two idle runs in a row (old maxIdleNudges cap of 2) no longer stops it — the keeper self-heals
  s.run(); s.assistant("No."); s.settle(); await sleep(50);
  assert.equal(s.pi.prompts.length, 8);
  s.run(); s.assistant("No."); s.settle(); await sleep(50);
  assert.equal(s.pi.prompts.length, 9, "it keeps re-engaging — no permanent give-up");
  s.keeper.dispose();
});

test("a new user prompt during the grace period cancels the pending check; an abort silences the goal", async () => {
  const s = setup({ verdicts: [{ done: false, reason: "r" }, { done: false, reason: "r" }], config: { graceMs: 40 } });
  s.user("First");
  s.run(); s.assistant("Half."); s.settle();
  s.user("Second");
  await sleep(80);
  assert.equal(s.judgeCalls.length, 0, "the settle of the first goal was superseded");
  s.run(); s.assistant("Stopped."); s.settle();
  await sleep(80);
  assert.equal(s.pi.prompts.length, 1);
  s.keeper.cancel(SID);
  s.run(); s.assistant("Again."); s.settle();
  await sleep(80);
  assert.equal(s.pi.prompts.length, 1, "no nudge after the user stopped pi");
  assert.equal(s.judgeCalls.length, 1);
  s.keeper.dispose();
});

test("fail open: judge failures and non-JSON replies re-engage anyway; a disabled hook never nudges", async () => {
  const s = setup({ verdicts: [new Error("provider down"), "not json at all"] });
  s.user("Go");
  s.run(); s.assistant("…"); s.settle(); await sleep(50);
  s.run(); s.assistant("…"); s.settle(); await sleep(50);
  assert.equal(s.pi.prompts.length, 2, "a thrown judge and junk JSON both fail open and re-engage");
  assert.equal(s.events.filter((e) => e.kind === "log" && /judge (failed|reply was not JSON)/.test(e.text)).length, 2);
  s.user("Go again");
  s.keeper.setConfig({ enabled: false });
  s.run(); s.assistant("…"); s.settle(); await sleep(50);
  assert.equal(s.judgeCalls.length, 2, "a disabled hook does not ask the judge");
  s.keeper.dispose();
});

test("an explicit /goal persists across plain prompts and is what the judge sees", async () => {
  const s = setup({ verdicts: [{ done: false, reason: "r" }] });
  s.keeper.setExplicitGoal(SID, "Port the whole module");
  assert.equal(s.keeper.goal(SID).text, "Port the whole module");
  assert.equal(s.keeper.goal(SID).explicit, true);
  // A plain user prompt must NOT replace the explicit goal (it is a step toward it).
  s.user("also fix the typo");
  assert.equal(s.keeper.goal(SID).text, "Port the whole module", "explicit goal survives a plain prompt");
  s.run(); s.assistant("planned."); s.settle(); await sleep(60);
  assert.match(s.judgeCalls[0].input, /Port the whole module/, "the judge sees the explicit goal");
  s.keeper.dispose();
});

test("setExplicitGoal('') clears the explicit lock so a prompt sets the goal again", () => {
  const s = setup();
  s.keeper.setExplicitGoal(SID, "Big goal");
  s.keeper.setExplicitGoal(SID, "");
  s.user("new task");
  assert.equal(s.keeper.goal(SID).text, "new task");
  assert.equal(!!s.keeper.goal(SID).explicit, false);
  s.keeper.dispose();
});

test("the keeper emits a summary event on settle via a separate summarizer, even with re-engage off", async () => {
  const s = setup({ config: { enabled: false }, summarize: async () => "Wrote the loader in loader.rs. Next: write the tests." });
  s.user("Build the loader");
  s.run(); s.assistant("working on it"); s.settle();
  await sleep(60);
  const sum = s.events.find((e) => e.kind === "summary");
  assert.ok(sum, "a summary event is emitted on settle");
  assert.match(sum.text, /Wrote the loader in loader\.rs/);
  assert.equal(sum.goal, "Build the loader");
  assert.equal(s.pi.prompts.length, 0, "re-engage stays off; only the summary fired");
  s.keeper.dispose();
});

test("the judge's pick follows the hook config over the chat model, and a new run while judging discards the verdict", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const s = setup({ config: { provider: "openrouter", model: "deepseek/x" } });
  s.keeper.judge = async (input, pick) => { s.judgeCalls.push({ input, pick }); await gate; return JSON.stringify({ done: false, reason: "r" }); };
  s.user("Go");
  s.run(); s.assistant("…"); s.settle(); await sleep(40);
  assert.deepEqual(s.judgeCalls[0].pick, { provider: "openrouter", model: "deepseek/x" });
  s.run(); // pi started again on its own (a steer, a retry) while the judge was thinking
  release(); await sleep(20);
  assert.equal(s.pi.prompts.length, 0);
  s.keeper.dispose();
});

function fakeBus() { const h = []; return { on: (_e, f) => h.push(f), off() {}, emit(ev) { for (const f of h) f(ev); } }; }

test("re-engage message contains the verbatim goal text", async () => {
  const bus = fakeBus();
  const prompts = [];
  const pi = { sid: "pi:1", proc: {}, streaming: false, state: { model: { provider: "p", id: "m" } }, prompt: async (msg) => prompts.push(msg) };
  const keeper = new GoalKeeper({ bus, getPi: () => pi, judge: async () => '{"done":false,"reason":"keep going","nudge":"do X"}', config: { enabled: true, graceMs: 0, heartbeatMs: 999999 } });
  keeper.setGoal("pi:1", "REVERSE libfoo.so exactly");
  const g = keeper.goal("pi:1"); g.ran = true; g.tail = ["assistant: ok"];
  await keeper.check("pi:1", g.seq);
  assert.ok(prompts.some((p) => p.includes("REVERSE libfoo.so exactly")));
});

test("a judge that never returns JSON fails open (re-engages), never permanently stops", async () => {
  const bus = fakeBus();
  const prompts = [];
  const pi = { sid: "pi:1", proc: {}, streaming: false, state: {}, prompt: async (m) => prompts.push(m) };
  const keeper = new GoalKeeper({ bus, getPi: () => pi, judge: async () => "garbage not json", config: { enabled: true, graceMs: 0, heartbeatMs: 999999, loopK: 3 } });
  keeper.setGoal("pi:1", "goal");
  const g = keeper.goal("pi:1"); g.ran = true;
  await keeper.check("pi:1", g.seq);
  assert.equal(prompts.length, 1); // re-engaged despite no verdict
});

test("same failure fingerprint loopK times escalates with a different-approach steer", async () => {
  const bus = fakeBus();
  const prompts = [];
  const pi = { sid: "pi:1", proc: {}, streaming: false, state: {}, prompt: async (m) => prompts.push(m) };
  const keeper = new GoalKeeper({ bus, getPi: () => pi, judge: async () => '{"done":false,"reason":"err","nudge":"retry"}', config: { enabled: true, graceMs: 0, heartbeatMs: 999999, loopK: 2 } });
  keeper.setGoal("pi:1", "goal");
  const g = keeper.goal("pi:1");
  g.tail = ["tool error build: undefined symbol foo"];
  for (let i = 0; i < 2; i++) { g.ran = true; await keeper.check("pi:1", g.seq); }
  assert.ok(prompts.at(-1).toLowerCase().includes("different approach"));
});

test("cancel pauses (resumable), it does not permanently latch", () => {
  const bus = fakeBus();
  const pi = { sid: "pi:1", proc: {}, streaming: false, state: {} };
  const keeper = new GoalKeeper({ bus, getPi: () => pi, judge: async () => "{}", config: { enabled: true } });
  keeper.setGoal("pi:1", "goal");
  keeper.cancel("pi:1");
  assert.equal(keeper.goal("pi:1").paused, true);
  keeper.resume("pi:1");
  assert.equal(keeper.goal("pi:1").paused, false);
});

test("summarizer uses summaryProvider/summaryModel when set", async () => {
  const bus = fakeBus();
  let pick = null;
  const pi = { sid: "pi:1", proc: {}, streaming: false, state: { model: { provider: "chatP", id: "chatM" } } };
  const keeper = new GoalKeeper({ bus, getPi: () => pi, judge: async () => "{}", summarize: async (_i, p) => { pick = p; return "ok"; }, config: { enabled: false, summaries: true, summaryProvider: "sumP", summaryModel: "sumM" } });
  keeper.setGoal("pi:1", "g");
  await keeper.makeSummary("pi:1");
  assert.deepEqual(pick, { provider: "sumP", model: "sumM" });
});
