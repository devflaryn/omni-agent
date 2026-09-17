import { test } from "node:test";
import assert from "node:assert/strict";
import { Bus } from "../server/bus.mjs";
import { GoalKeeper, buildJudgeInput, parseVerdict, tailLine } from "../server/hook.mjs";
import { hookInfo } from "../ui/lib.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SID = "pi:abc";

function setup({ verdicts = [], config = {} } = {}) {
  const bus = new Bus();
  const pi = { proc: {}, sid: SID, streaming: false, state: { model: { provider: "orca", id: "qwen" } }, prompts: [], async prompt(m, o) { this.prompts.push([m, o]); return { success: true }; } };
  const judgeCalls = [];
  const judge = async (input, pick) => { judgeCalls.push({ input, pick }); const v = verdicts.shift(); if (v instanceof Error) throw v; return typeof v === "string" ? v : JSON.stringify(v); };
  const events = [];
  bus.on("event", (ev) => events.push(ev));
  const keeper = new GoalKeeper({ bus, getPi: (sid) => (sid === SID ? pi : null), judge, config: { enabled: true, graceMs: 10, maxIdleNudges: 2, ...config } });
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

test("keeper stays quiet when the judge says done, keeps re-engaging without limit while the agent works, and gives up only after maxIdleNudges runs without a tool call", async () => {
  const notDone = (i) => ({ done: false, reason: `r${i}` });
  const s = setup({ verdicts: [{ done: true, reason: "finished" }, ...Array.from({ length: 12 }, (_, i) => notDone(i + 1))] });
  const toolCall = () => s.emit({ kind: "msg", role: "assistant", live: true, id: `t${Date.now()}`, stopReason: "toolUse", blocks: [{ type: "tool_call", toolId: "c1", name: "bash", args: { command: "ls" } }] });
  s.user("Do X");
  s.run(); s.assistant("Done."); s.settle();
  await sleep(50);
  assert.equal(s.pi.prompts.length, 0);
  // five re-engaged runs that each make a tool call: well past the old cap of 5, still going
  for (let i = 1; i <= 5; i++) { s.run(); toolCall(); s.assistant("More."); s.settle(); await sleep(50); assert.equal(s.pi.prompts.length, i); }
  assert.equal(s.events.filter((e) => e.kind === "hook").at(-1).idle, 0);
  // a nudged run with no tool call counts as idle; a later one with a tool call resets the count
  s.run(); s.assistant("I cannot."); s.settle(); await sleep(50);
  assert.equal(s.pi.prompts.length, 6);
  assert.match(hookInfo(s.pi.prompts[5][0]).note, /^Goal hook re-engaged the agent \(#6 · no tool calls in the last 1 of 2\): r6/);
  s.run(); toolCall(); s.assistant("Trying."); s.settle(); await sleep(50);
  assert.equal(s.pi.prompts.length, 7);
  assert.equal(s.events.filter((e) => e.kind === "hook").at(-1).idle, 0, "a tool call reset the idle count");
  // two idle runs in a row (maxIdleNudges: 2) → the keeper gives up without asking the judge again
  s.run(); s.assistant("No."); s.settle(); await sleep(50);
  assert.equal(s.pi.prompts.length, 8);
  s.run(); s.assistant("No."); s.settle(); await sleep(50);
  assert.equal(s.pi.prompts.length, 8, "no ninth nudge");
  assert.equal(s.judgeCalls.length, 9, "the judge is not asked once the agent stopped acting");
  assert.ok(s.events.some((e) => e.kind === "log" && /gave up after 8 re-engagements — the agent made no tool call in the last 2/.test(e.text)));
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

test("judge failures, non-JSON replies, a disabled hook and aborted runs never nudge", async () => {
  const s = setup({ verdicts: [new Error("provider down"), "not json at all", { done: false, reason: "r" }] });
  s.user("Go");
  s.run(); s.assistant("…"); s.settle(); await sleep(50);
  s.run(); s.assistant("…"); s.settle(); await sleep(50);
  assert.equal(s.pi.prompts.length, 0);
  assert.equal(s.events.filter((e) => e.kind === "log" && /judge (failed|reply was not JSON)/.test(e.text)).length, 2);
  s.run(); s.assistant("…", "aborted"); s.settle(); await sleep(50);
  assert.equal(s.judgeCalls.length, 2, "an aborted assistant message skips the judge");
  s.user("Go again");
  s.keeper.setConfig({ enabled: false });
  s.run(); s.assistant("…"); s.settle(); await sleep(50);
  assert.equal(s.judgeCalls.length, 2);
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
