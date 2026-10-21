/**
 * The context policy shared by the omni-context pi extension and the server's goal hook: which turn-ending
 * replies are "my context is used up" stops (re-engaged) and which are real ends (a finished task, a question
 * for the user, a handoff the user asked for). Every phrasing here is synthetic.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CONTEXT_GUIDANCE, UNNAMED_TOOL, classifyStop, contextContinueMessage, contextSkipReason, contextStatusNote, effectiveContextWindow, repairToolCallIds, userAskedForHandoff } from "../integrations/pi/omni-context-lib.mjs";

const stop = (text, extra = {}) => classifyStop({ text, stopReason: "stop", ...extra });
const NEUTRAL = "Summary: the loader resolves both imports now and the unit tests pass. Steps 4 and 5 of the plan are still open.";

test("context claims in the reply are context stops", () => {
  for (const phrase of [
    "Context is nearly exhausted, so I am stopping after this commit.",
    "The context window is almost full.",
    "I'm running low on context, so this is a good place to pause.",
    "We are out of token budget for this run.",
    "The token limit has been reached, so here is the state of things.",
    "I will use the remaining context to record what is left.",
    "The conversation context has grown too large to keep going.",
    "This session's budget is almost exhausted.",
    "Let me write the notes down before the context runs out.",
    "Given the limited context, I will wrap up with a summary.",
    "This session’s budget is nearly spent.", // typographic apostrophe
  ]) {
    const r = stop(`Progress: steps 1-3 are done and verified.\n\n${phrase}`);
    assert.equal(r.kind, "context-stop", phrase);
    assert.match(r.reason, /claiming its context was used up/, phrase);
  }
});

test("the same belief only in the reasoning is a context stop; the plain summary alone is not", () => {
  assert.equal(stop(NEUTRAL).kind, "normal");
  for (const thought of [
    "I'm almost out of budget, so I should wrap up now.",
    "I am approaching the limit of my context window, better to summarise.",
    "This is the end of my practical context.",
    "We are at the budget limit; finish with a summary.",
    "There is very little context left for more tool output.",
    "The context is getting very large now.",
    "Given the session's length, I should write things up.",
    "The context window is nearly full.",
  ]) {
    const r = stop(NEUTRAL, { thinking: `Let me check the plan. ${thought}` });
    assert.equal(r.kind, "context-stop", thought);
    assert.match(r.reason, /wrapped up believing/, thought);
  }
  assert.equal(stop(NEUTRAL, { thinking: "The tests pass, the plan is on step 4, keep going after this report." }).kind, "normal");
});

test("stopping 'for this session' is a context stop", () => {
  for (const phrase of [
    "I've reached the end of what I can verify in this session.",
    "I’ve reached the end of what I can do in this session.",
    "I'll stop here so the session stays manageable.",
    "I'm going to stop here; the session is long enough already.",
    "Stopping here to keep the token count down.",
  ]) {
    const r = stop(`The parser is half done.\n\n${phrase}`);
    assert.equal(r.kind, "context-stop", phrase);
    assert.match(r.reason, /for this session/, phrase);
  }
});

test("a handoff for another session is a context stop", () => {
  for (const phrase of [
    "I saved a handoff note in notes/handoff.md with the offsets found so far.",
    "Below is a prompt for a fresh session that covers the open steps.",
    "Paste this into a new chat to continue the migration.",
    "Continue in a fresh session from where I left off: the crash is in the second loader.",
    "The next session should pick this up from step 4.",
  ]) {
    const r = stop(`Status: two of five fixtures pass.\n\n${phrase}`);
    assert.equal(r.kind, "context-stop", phrase);
    assert.match(r.reason, /handoff for another session/, phrase);
  }
});

test("weak handoff wording without a cue that the work is put down is product talk, not a stop", () => {
  assert.equal(stop("Done: the + button in the sidebar now lets you start a new chat, and the old chat keeps its history. Tests pass.").kind, "normal");
  assert.equal(stop("The game now saves progress before the next session starts; verified with two launches.").kind, "normal");
  // The put-down cue has to be in the same sentence as the weak wording, and "where they left off" is the product's users.
  for (const text of [
    "Done. The sidebar now lets you start a new chat; for now the old chat stays pinned. Tests pass.",
    "Done. Users can continue in a new chat from where they left off via the fork button; 12 tests pass.",
    "Done. Sessions now resume where they left off and the next session restores the scroll position. Tests pass.",
  ]) assert.equal(stop(text).kind, "normal", text);
  assert.equal(stop("Steps 1-3 are done. I will start a new chat for now and pick this up from step 4 there.").kind, "context-stop");
});

test("real ends are left alone: a finished task, a question for the user, 'context' in another sense", () => {
  const done = stop("Done. The parser handles all three fixture files and `node --test` passes (42 tests, 0 failures).\n\nChanged: src/parser.mjs, test/parser.test.mjs.");
  assert.deepEqual(done, { kind: "normal", reason: "it stopped normally" });
  assert.equal(stop("I found two ways to fix the crash: patch the offset table, or rebuild the base image. Which approach do you want me to take?").kind, "asks-user");
  assert.equal(stop("The rebuild needs the signing key from your password manager. Please confirm where it is stored and I will continue.").kind, "asks-user");
  for (const text of [
    "Progress: the renderer now creates its GL context lazily and recreates it when the window is resized; the Android Context object is passed into the plugin instead of a static field. Next I wire the context menu. All 12 tests pass.",
    "The GL context was lost after the resize, so it is recreated in onSurfaceChanged; verified at 60 fps.",
    "Context switches dropped from 40k/s to 9k/s after pinning the render thread; the SessionProvider context now carries the user id.",
    "Done. I fixed the remaining context menu entries and all 20 tests pass.",
    "Done. Given the limited context in the crash dump, I traced the fault to the second loader and fixed it; tests pass.",
  ]) assert.equal(stop(text).kind, "normal", text);
  // …while the budget sense of the same words is still a claim.
  assert.equal(stop("Steps 1-3 are done. With little context left, here is where things stand.").kind, "context-stop");
});

test("a handoff the user asked for is the task, not a stop — only the user's own words count", () => {
  const text = "Here is the handoff prompt for the next session:\n\nRead notes/33.md first, then continue with step 4.";
  const r = stop(text, { userText: "We're done for today. Please write a handoff prompt I can paste into a new session tomorrow." });
  assert.deepEqual(r, { kind: "normal", reason: "the user asked for a handoff" });
  assert.equal(userAskedForHandoff("What should I paste into the next chat to carry on?"), true);
  assert.equal(userAskedForHandoff("Give me a prompt for another agent that does the review."), true);

  // Omni's memory pack goes in front of the user's text; a note in it that mentions a handoff is not a request.
  const note = "- Write a handoff prompt before the session ends (notes/07-handoff-prompt.md).";
  assert.equal(userAskedForHandoff(note), true, "the note's wording on its own would count");
  const withPack = `<omni-memory>\n${note}\n</omni-memory>\n\nKeep rebuilding the payload until the crash is gone.`;
  assert.equal(userAskedForHandoff(withPack), false);
  assert.equal(stop("I wrote a handoff note to notes/33-handoff.md; continue in a fresh session from there.", { userText: withPack }).kind, "context-stop");
  assert.equal(userAskedForHandoff(`<repo-graph dir="C:/work/app">\nscripts/handoff.mjs: write the handoff prompt file\n</repo-graph>\n\nFix the crash in the loader.`), false, "repo-graph context is not the user's words");

  // The goal hook's own nudge is not the user speaking either.
  const hook = '<omni-hook name="goal" note="re-engage">Do not write a handoff prompt; continue with step 3.</omni-hook>';
  assert.equal(userAskedForHandoff(hook), false);
  assert.equal(stop("Here is a prompt for a fresh session that picks up step 3.", { userText: hook }).kind, "context-stop");
  assert.equal(userAskedForHandoff(""), false);
  assert.equal(userAskedForHandoff(undefined), false);
});

test("a request for a handoff is told apart from ordinary work on prompts and on the handoff code", () => {
  for (const u of [
    "Write a handoff.",
    "Can you write up a short handoff?",
    "Give me a handoff note for the next agent.",
    "I need a handoff before I log off.",
    "Draft handoff notes so I can continue later.",
    "Write a prompt I can paste into a fresh session.",
    "Write a continuation prompt for tomorrow.",
    "Can I get a prompt for a fresh session?",
    "Write me a handover for the new chat.",
  ]) assert.equal(userAskedForHandoff(u), true, u);
  for (const u of [
    "Make the prompt builder stop duplicating the guidance.",
    "I want the system prompt to keep its cache prefix stable.",
    "I need a brief look at the loader first, then fix the crash.",
    "Update the continuation token logic in the paginator.",
    "Make the handoff detection stricter.",
    "Write tests for the handoff.",
    "We need to remove the handoff check.",
    "The system prompt for a new chat is missing the guidance; fix it.",
    "Make the prompt for the next agent call shorter.",
    "Generate a brief changelog entry.",
  ]) assert.equal(userAskedForHandoff(u), false, u);
  // Such a request as the run's prompt must not hide a real context stop for the whole run.
  const claim = "Progress: steps 1-3 done.\n\nThe context window is almost full, so I am stopping here.";
  for (const userText of ["Make the prompt builder stop duplicating the guidance.", "I need a brief look at the loader first, then fix the crash."]) {
    assert.equal(stop(claim, { userText }).kind, "context-stop", userText);
  }
});

test("length stops: at the output cap (or with nothing said) is length-cap, otherwise length", () => {
  const len = (output, text, maxTokens = 16384) => classifyStop({ text, stopReason: "length", usage: { output }, maxTokens }).kind;
  assert.equal(len(16384, "Partial answer"), "length-cap");
  assert.equal(len(16000, "Partial answer"), "length-cap", "within 3% of the cap");
  assert.equal(len(4000, "Here is the first half of the table"), "length");
  assert.equal(len(4000, ""), "length-cap", "all-reasoning output never acted");
  assert.equal(len(99999, "some text", 0), "length", "no known cap");
  assert.equal(classifyStop({ stopReason: "length", text: "x" }).kind, "length");
});

test("error, aborted and toolUse stops win over any wording", () => {
  const claim = "Context is nearly exhausted.";
  assert.equal(classifyStop({ text: claim, stopReason: "error" }).kind, "error");
  assert.equal(classifyStop({ text: claim, stopReason: "aborted" }).kind, "aborted");
  assert.equal(classifyStop({ text: claim, stopReason: "toolUse" }).kind, "tool-use");
  assert.deepEqual(classifyStop({ text: "  ", stopReason: "stop" }), { kind: "normal", reason: "empty reply" });
  assert.equal(classifyStop().kind, "normal");
});

test("effectiveContextWindow: compactAt + reserve, only when below the real window", () => {
  assert.equal(effectiveContextWindow({ contextWindow: 1048576, compactAt: 256000, reserveTokens: 24576 }), 280576);
  assert.equal(effectiveContextWindow({ contextWindow: 1000000, compactAt: 256000 }), 272384, "pi's default reserve 16384");
  assert.equal(effectiveContextWindow({ contextWindow: 262144, compactAt: 256000, reserveTokens: 16384 }), null, "the real window already compacts sooner");
  assert.equal(effectiveContextWindow({ contextWindow: 272384, compactAt: 256000, reserveTokens: 16384 }), null, "equal is not below");
  assert.equal(effectiveContextWindow({ contextWindow: 272385, compactAt: 256000, reserveTokens: 16384 }), 272384);
  assert.equal(effectiveContextWindow({ contextWindow: 1048576, compactAt: 0 }), null, "compactAt 0 = off");
  assert.equal(effectiveContextWindow({ contextWindow: 0, compactAt: 256000 }), null);
  assert.equal(effectiveContextWindow({ compactAt: 256000 }), null);
  assert.equal(effectiveContextWindow({ contextWindow: 1000000, compactAt: 256000, reserveTokens: -5 }), 256000, "a negative reserve counts as 0");
  assert.equal(effectiveContextWindow({ contextWindow: "1048576", compactAt: "256000", reserveTokens: "24576" }), 280576);
});

test("contextSkipReason: skipping because of context/budget/another session, not 'GL context'", () => {
  for (const r of [
    "context is nearly full", "skipped to save context", "due to context limits", "not enough token budget", "better done in a fresh session",
    "not enough context left", "I’m running out of context", "deferred to the next session", "out of scope for this session",
    // any mention of the conversation's context is a context reason
    "context", "Context.", "to keep the context small", "would flood the context with the full dump", "too much context for one pass",
    "skipped to avoid context bloat", "reading the 40 MB log would blow up the context", "keeps the context lean; do it later", "context is large",
    "the GL context is fine but the dump would flood the context",
  ]) {
    assert.equal(contextSkipReason(r), true, r);
  }
  for (const r of [
    "", undefined, null, "the device is offline", "needs a real GPU: the GL context cannot be created under WHPX", "the Android Context object is not available in the lab",
    "the context menu is out of scope", "duplicate of step 2.1", "given the context menu is hidden on tablets", "Context switches are already minimal",
    "the SessionProvider context is not mounted in tests", "the EGL context was lost", "the docker build context is missing the base image",
    "not meaningful in this context", "Context.getSystemService is unavailable in the lab",
    // sessions and tokens as product terms
    "needs a new session cookie from the user", "requires a fresh session token from the login server",
  ]) {
    assert.equal(contextSkipReason(r), false, String(r));
  }
});

test("guidance, continue message and status note", () => {
  assert.match(CONTEXT_GUIDANCE, /compacted automatically/);
  assert.match(CONTEXT_GUIDANCE, /Never end your turn/);
  assert.match(contextContinueMessage({ compacted: true }), /^Your context was just compacted automatically\. /);
  assert.match(contextContinueMessage({ usagePercent: 41.6 }), /^Your context is fine \(42% of the budget/);
  assert.match(contextContinueMessage(), /^Your context is fine\. .*Continue the task/);
  assert.equal(contextStatusNote(69), null);
  assert.match(contextStatusNote(70), /^\[context: 70% of the budget/);
  assert.match(contextStatusNote(55, { fromPercent: 50 }), /55%/);
  assert.match(contextStatusNote(104.4), /104%/);
  for (const v of [null, undefined, NaN, Infinity]) assert.equal(contextStatusNote(v), null);
});

test("oversized compaction: the per-request budget, chunking at message boundaries, and folding oldest first", async () => {
  const { summaryInputBudget, chunkBySize, foldIntoSummary, tokensOfChars } = await import("../integrations/pi/omni-context-lib.mjs");
  // 288768 window − min(0.8 × 32768, 65536) = 26214 summary output − 4096 margin − 3000 prompt − carried summary
  assert.equal(summaryInputBudget({ contextWindow: 288768, reserveTokens: 32768, maxTokens: 65536 }), 288768 - 26214 - 4096 - 3000);
  assert.equal(summaryInputBudget({ contextWindow: 288768, reserveTokens: 32768, maxTokens: 16384, carriedChars: 32000 }), 288768 - 16384 - 4096 - 3000 - tokensOfChars(32000));
  assert.equal(summaryInputBudget({ contextWindow: 20000, reserveTokens: 32768, maxTokens: 65536 }), 0, "never negative");
  assert.deepEqual(chunkBySize([5, 5, 5, 5, 5], (n) => n, 10), [[5, 5], [5, 5], [5]]);
  assert.deepEqual(chunkBySize([3, 30, 3], (n) => n, 10), [[3], [30], [3]], "an item bigger than the limit is a chunk of its own");
  assert.deepEqual(chunkBySize([], (n) => n, 10), []);
  const calls = [];
  const out = await foldIntoSummary({
    chunks: [["a"], ["b"], ["c"]], previousSummary: "S0",
    summarize: async (msgs, prev) => { calls.push(`${msgs[0]}<${prev}`); return `S(${msgs[0]})`; },
    last: async (msgs, prev) => ({ summary: `final(${msgs[0]}|${prev})` }),
  });
  assert.deepEqual(calls, ["a<S0", "b<S(a)"]);
  assert.equal(out.summary, "final(c|S(b))");
  assert.equal((await foldIntoSummary({ chunks: [["only"]], previousSummary: undefined, summarize: async () => assert.fail("no middle chunks"), last: async (m, p) => ({ summary: `${m[0]}:${p}` }) })).summary, "only:undefined");
});

test("a context claim found only in the reasoning counts on a big prompt, not on a small one ('very little context' = too little information)", () => {
  const thinking = "The user said continue. I have very little context. The device is still booting, so I will report what I know.";
  const text = "Here is where things stand: the device is still booting.";
  assert.equal(classifyStop({ text, thinking, stopReason: "stop", usage: { input: 2000, cacheRead: 40000, output: 300 } }).kind, "normal", "42k prompt: not a context stop");
  assert.equal(classifyStop({ text, thinking, stopReason: "stop", usage: { input: 2000, cacheRead: 595000, output: 300 } }).kind, "context-stop", "597k prompt: it is");
  assert.equal(classifyStop({ text, thinking, stopReason: "stop" }).kind, "context-stop", "size unknown: counts");
  assert.equal(classifyStop({ text: "I ran out of context, so I will stop here.", stopReason: "stop", usage: { input: 30000, output: 20 } }).kind, "context-stop", "a claim in the reply counts at any size");
  assert.equal(classifyStop({ text, thinking: "I have very little context about what they want next.", stopReason: "stop", usage: { input: 500000, output: 20 } }).kind, "normal", "information sense never counts");
});

test("repairToolCallIds: a tool call saved without an id (or name) gets a stable one, handed to its results in order", () => {
  const user = { role: "user", content: [{ type: "text", text: "go" }], timestamp: 1 };
  const ok = { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: {} }], timestamp: 2 };
  const okResult = { role: "toolResult", toolCallId: "t1", toolName: "bash", content: [], isError: false, timestamp: 3 };
  assert.equal(repairToolCallIds([user, ok, okResult]), null, "nothing to repair: null, so the request is byte-identical");
  assert.equal(repairToolCallIds(undefined), null);
  assert.equal(repairToolCallIds([]), null);

  const bad = { role: "assistant", content: [{ type: "text", text: "two calls" }, { type: "toolCall", id: "", name: "", arguments: { a: 1 } }, { type: "toolCall", id: "keep", name: "read", arguments: {} }, { type: "toolCall", name: "bash", arguments: {} }], timestamp: 1700000000000 };
  const r1 = { role: "toolResult", toolCallId: "", toolName: "", content: [], isError: true, timestamp: 5 };
  const r2 = { role: "toolResult", toolCallId: "keep", toolName: "read", content: [], isError: false, timestamp: 6 };
  const r3 = { role: "toolResult", toolCallId: "", toolName: "bash", content: [], isError: false, timestamp: 7 };
  const input = [user, bad, r1, r2, r3, ok, okResult];
  const snapshot = JSON.stringify(input);
  const out = repairToolCallIds(input);
  assert.equal(JSON.stringify(input), snapshot, "the input is not mutated");
  assert.equal(out[0], user); assert.equal(out[3], r2); assert.equal(out[5], ok); assert.equal(out[6], okResult);
  assert.deepEqual(out[1].content.map((c) => [c.id, c.name]), [[undefined, undefined], ["call_omni_1700000000000_1", UNNAMED_TOOL], ["keep", "read"], ["call_omni_1700000000000_3", "bash"]]);
  assert.equal(out[1].content[0], bad.content[0]);
  assert.deepEqual([out[2].toolCallId, out[2].toolName], ["call_omni_1700000000000_1", UNNAMED_TOOL]);
  assert.deepEqual([out[4].toolCallId, out[4].toolName], ["call_omni_1700000000000_3", "bash"]);
  assert.deepEqual(repairToolCallIds(input), out, "deterministic: the same ids on every request");
  // No timestamp: the message's position. A result with no id and no id-less call before it is left alone.
  const noTs = repairToolCallIds([user, { role: "assistant", content: [{ type: "toolCall", id: "", name: "x", arguments: {} }] }, { ...r1 }]);
  assert.equal(noTs[1].content[0].id, "call_omni_1_0");
  assert.equal(noTs[2].toolCallId, "call_omni_1_0");
  assert.equal(repairToolCallIds([user, { ...r1 }]), null);
  // A named call with an id is never touched even beside a broken one; a nameless call with an id keeps the id.
  const named = repairToolCallIds([{ role: "assistant", content: [{ type: "toolCall", id: "z9", name: "", arguments: {} }], timestamp: 4 }, { ...okResult, toolCallId: "z9", toolName: "" }]);
  assert.deepEqual([named[0].content[0].id, named[0].content[0].name], ["z9", UNNAMED_TOOL]);
  assert.equal(named[1].toolCallId, "z9", "its result already points at it");
});
