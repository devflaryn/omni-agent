import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { OpencodeTranslator, stopReasonOf, errorText, piUsage, historyEntries } from "../server/opencode-events.mjs";
import { normalizeRpcEvent, normalizePiEntry } from "../server/normalize.mjs";

const fx = JSON.parse(readFileSync(new URL("./fixtures/opencode-turn.json", import.meta.url), "utf8"));
const ctx = { sid: "pi:x", harness: "pi" };

/** Feeds every payload of a fixture case; returns all rpc events and entries in order. */
function run(c, opts = {}) {
  const t = new OpencodeTranslator({ sessionID: c.sessionID, cwd: "C:\\work", ...opts });
  const rpc = [], entries = [];
  for (const p of c.payloads) { const o = t.push(p); rpc.push(...o.rpc); entries.push(...o.entries); }
  return { t, rpc, entries };
}
const kind = (e) => e.type === "message_update" ? e.assistantMessageEvent.type : e.type === "message_end" ? `message_end:${e.message.role}` : e.type;
const normalized = (rpc) => rpc.flatMap((e) => normalizeRpcEvent(e, ctx));
const msgEnds = (rpc, role) => rpc.filter((e) => e.type === "message_end" && e.message.role === role);

// Small hand-built payload helpers for the cases no capture covers.
const S = "ses_test";
const user = (id, text, extra = {}) => [
  { type: "message.updated", properties: { sessionID: S, info: { id, sessionID: S, role: "user", time: { created: 1000 } } } },
  ...(text == null ? [] : [{ type: "message.part.updated", properties: { sessionID: S, part: { id: `${id}-p`, sessionID: S, messageID: id, type: "text", text, ...extra } } }]),
];
const asst = (id, extra = {}) => ({ type: "message.updated", properties: { sessionID: S, info: { id, sessionID: S, role: "assistant", time: { created: 2000 }, modelID: "big-pickle", providerID: "opencode", tokens: { input: 5, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0, ...extra } } });
const part = (p) => ({ type: "message.part.updated", properties: { sessionID: S, part: { sessionID: S, ...p } } });
const busy = { type: "session.status", properties: { sessionID: S, status: { type: "busy" } } };
const idle = { type: "session.idle", properties: { sessionID: S } };

test("translates a tool turn into pi events in order", () => {
  const { rpc, entries } = run(fx.tool);
  const seq = rpc.map(kind);
  const at = (k, from = 0) => { const i = seq.indexOf(k, from); assert.ok(i >= 0, `missing ${k} after ${from} in ${seq.join(",")}`); return i; };
  const a = at("agent_start"), ms = at("message_start", a), tcs = at("toolcall_start", ms), tce = at("toolcall_end", tcs);
  const tes = at("tool_execution_start", tce), teu = at("tool_execution_update", tes), tee = at("tool_execution_end", teu);
  const end1 = at("message_end:assistant", tee), tr = at("message_end:toolResult", end1);
  const ms2 = at("message_start", tr), ts = at("text_start", ms2), td = at("text_delta", ts), te = at("text_end", td), end2 = at("message_end:assistant", te);
  assert.equal(seq.lastIndexOf("agent_settled"), seq.length - 1);
  assert.ok(end2 > tr);
  assert.equal(seq.filter((k) => k === "agent_start").length, 1, "busy repeats inside a turn but the agent starts once");
  assert.equal(seq.filter((k) => k === "agent_settled").length, 1);

  const call = rpc[tcs].assistantMessageEvent;
  assert.equal(call.id, "call_00_aquldmhe3a38jcf2ofwq7o37");
  assert.equal(call.toolName, "bash");
  assert.deepEqual(rpc[tce].assistantMessageEvent.toolCall, { id: call.id, name: "bash", arguments: { command: "echo hi" } });
  assert.equal(rpc[teu].partialResult.content[0].text, "hi\n");
  assert.equal(rpc[tee].toolCallId, call.id);
  assert.equal(rpc[tee].isError, false);
  assert.equal(rpc[tee].result.content[0].text.trim(), "hi");
  assert.deepEqual(rpc[tee].result.details, { output: "hi\n", exit: 0, truncated: false });

  const m1 = rpc[end1].message;
  assert.equal(m1.stopReason, "toolUse");
  assert.equal(m1.model, "big-pickle");
  assert.equal(m1.responseId, "msg_1661fd1730017Jl4a5ALaWRhJD");
  assert.deepEqual(m1.content.map((c) => c.type), ["toolCall"]);
  assert.deepEqual(m1.usage, { input: 18628, output: 38, cacheRead: 1792, cacheWrite: 0, totalTokens: 20458, cost: { total: 0 } });
  const r = rpc[tr].message;
  assert.equal(r.toolCallId, call.id);
  assert.equal(r.toolName, "bash");
  assert.equal(r.isError, false);
  assert.equal(r.content[0].text.trim(), "hi");
  assert.equal(rpc[td].assistantMessageEvent.delta, "done");
  assert.equal(rpc[te].assistantMessageEvent.content, "done");
  assert.equal(rpc[td].assistantMessageEvent.contentIndex, 0);
  assert.equal(rpc[end2].message.stopReason, "stop");
  assert.deepEqual(rpc[end2].message.content, [{ type: "text", text: "done" }]);

  // The rpc stream reads as the usual omni events.
  const ev = normalized(rpc);
  assert.deepEqual(ev.filter((e) => e.kind === "msg").map((e) => e.role), ["assistant", "tool", "assistant"]);
  assert.equal(ev.filter((e) => e.kind === "tool" && e.phase === "end").length, 1);

  // Mirror entries: user prompt, model change, assistant, tool result, assistant — chained by parentId.
  assert.deepEqual(entries.map((e) => e.type === "message" ? e.message.role : e.type), ["user", "model_change", "assistant", "toolResult", "assistant"]);
  for (let i = 1; i < entries.length; i++) assert.equal(entries[i].parentId, entries[i - 1].id);
  assert.equal(entries[0].parentId, null);
  assert.match(entries[0].message.content[0].text, /^Run the shell command `echo hi`/);
  assert.deepEqual([entries[1].provider, entries[1].modelId], ["opencode", "big-pickle"]);
  for (const e of entries) assert.ok(!Number.isNaN(Date.parse(e.timestamp)), "ISO timestamp");
  const back = entries.flatMap((e) => normalizePiEntry(e, ctx));
  assert.deepEqual(back.filter((e) => e.kind === "msg").map((e) => e.role), ["user", "assistant", "tool", "assistant"]);
  assert.equal(back.find((e) => e.kind === "session").model, "big-pickle");
  // Live ids match the mirror's, so a reload does not duplicate the turn.
  assert.deepEqual(ev.filter((e) => e.kind === "msg").map((e) => e.id), back.filter((e) => e.kind === "msg" && e.role !== "user").map((e) => e.id));
});

test("plan tool metadata becomes details", () => {
  const plan = { goal: "g", steps: [{ id: 1, text: "a", status: "doing" }] };
  const meta = { plan, events: [{ type: "start", id: 1 }], ok: true, truncated: false };
  const st = { input: { action: "add" }, title: "plan", time: { start: 3 } };
  const c = { sessionID: S, payloads: [
    ...user("u1", "make a plan"), busy, asst("a1"),
    part({ id: "t1", messageID: "a1", type: "tool", tool: "plan", callID: "c1", state: { status: "pending", input: {}, raw: "" } }),
    part({ id: "t1", messageID: "a1", type: "tool", tool: "plan", callID: "c1", state: { status: "running", ...st } }),
    part({ id: "t1", messageID: "a1", type: "tool", tool: "plan", callID: "c1", state: { status: "completed", ...st, output: "plan updated", metadata: meta, time: { start: 3, end: 4 } } }),
    asst("a1", { time: { created: 2000, completed: 5000 }, finish: "tool-calls" }), idle,
  ] };
  const { rpc, entries } = run(c);
  const end = normalized(rpc).find((e) => e.kind === "tool" && e.phase === "end");
  assert.deepEqual(end.details, { plan, events: meta.events, ok: true });
  const result = entries.find((e) => e.message?.role === "toolResult");
  assert.deepEqual(result.message.details, meta);
  assert.deepEqual(normalizePiEntry(result, ctx)[0].blocks[0].details.plan, plan);
});

test("403 assistant error → stopReason error and \"Model error: 403: …\"", () => {
  const { rpc, entries } = run(fx.apiError403);
  const ends = msgEnds(rpc, "assistant");
  assert.equal(ends.length, 1, "the session.error that follows the failed message adds nothing");
  assert.equal(ends[0].message.stopReason, "error");
  assert.match(ends[0].message.errorMessage, /^403: \{"type":"FreeTierError"/);
  const msgs = normalized(rpc).filter((e) => e.kind === "msg");
  assert.equal(msgs.length, 1);
  assert.match(msgs[0].blocks[0].text, /^Model error: 403: \{"type":"FreeTierError","message":"OpenCode's free tier/);
  assert.equal(entries.filter((e) => e.message?.role === "assistant").length, 1);
  assert.deepEqual(rpc.map(kind).slice(-1), ["agent_settled"]);
});

test("session.error without a message → synthetic error message", () => {
  const { rpc, entries } = run(fx.badModel);
  const ends = msgEnds(rpc, "assistant");
  assert.equal(ends.length, 1, "the repeated session.error (with a stack) is not a second message");
  assert.equal(ends[0].message.stopReason, "error");
  assert.equal(ends[0].message.errorMessage, "Model not found: opencode/no-such-model-xyz. Did you mean: gpt-5-nano, gpt-5.4-nano?");
  const msg = normalized(rpc).find((e) => e.kind === "msg");
  assert.equal(msg.blocks[0].text, "Model error: Model not found: opencode/no-such-model-xyz. Did you mean: gpt-5-nano, gpt-5.4-nano?");
  assert.deepEqual(rpc.map(kind), ["agent_start", "message_end:assistant", "agent_settled"]);
  assert.deepEqual(entries.map((e) => e.message?.role), ["user", "assistant"]);
});

test("abort → aborted", () => {
  const { rpc, entries } = run(fx.abort);
  const ends = msgEnds(rpc, "assistant");
  assert.equal(ends.length, 1, "the abort's session.error arrives while the message is open: no synthetic message");
  assert.equal(ends[0].message.stopReason, "aborted");
  assert.equal(ends[0].message.content[0].type, "toolCall");
  assert.equal(rpc.filter((e) => e.type === "agent_settled").length, 1);
  const end = rpc.find((e) => e.type === "tool_execution_end");
  assert.match(end.result.content[0].text, /User aborted the command/);
  assert.equal(msgEnds(rpc, "toolResult").length, 1);
  assert.deepEqual(entries.map((e) => e.message?.role ?? e.type), ["user", "model_change", "assistant", "toolResult"]);
});

test("each message_end once even when message.updated repeats", () => {
  const { rpc } = run(fx.tool);
  const ids = msgEnds(rpc, "assistant").map((e) => e.message.responseId);
  assert.deepEqual(ids, ["msg_1661fd1730017Jl4a5ALaWRhJD", "msg_1661fddfe0014NNIcI5uKgbV9D"]);
  assert.equal(rpc.filter((e) => e.type === "message_start").length, 2);
  // Replaying the turn's tail again changes nothing.
  const t = new OpencodeTranslator({ sessionID: fx.tool.sessionID, cwd: "C:\\work" });
  for (const p of fx.tool.payloads) t.push(p);
  const again = fx.tool.payloads.flatMap((p) => t.push(p).rpc).filter((e) => e.type === "message_end" || e.type === "message_start");
  assert.deepEqual(again, []);
});

test("omni-agent-result user text → custom message", () => {
  const report = '[omni-agent-result] Background pi agent a-1a2b3c4d "count" finished: done after 12s.\n\n42';
  const { rpc, entries } = run({ sessionID: S, payloads: [...user("u1", report), busy] });
  const custom = msgEnds(rpc, "custom");
  assert.equal(custom.length, 1);
  assert.equal(custom[0].message.customType, "omni-agent-result");
  assert.match(custom[0].message.content, /^Background pi agent a-1a2b3c4d/);
  const [msg] = normalized(custom);
  assert.equal(msg.role, "system");
  assert.match(msg.blocks[0].text, /^\[omni-agent-result\] Background pi agent a-1a2b3c4d "count" finished/);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].type, "custom_message");
  assert.equal(entries[0].customType, "omni-agent-result");
  assert.equal(normalizePiEntry(entries[0], ctx)[0].blocks[0].text, msg.blocks[0].text);
  // A plain prompt: a mirror entry but no rpc message (the prompt echo covers the live view).
  const plain = run({ sessionID: S, payloads: [...user("u2", "hi"), busy] });
  assert.deepEqual(plain.rpc.map(kind), ["agent_start"]);
  assert.deepEqual(plain.entries.map((e) => e.message.content), [[{ type: "text", text: "hi" }]]);
  assert.deepEqual(run({ sessionID: S, payloads: [...user("u3", "ctx", { synthetic: true }), busy] }).entries, []);
});

test("compaction: a compaction part starts it, the summary message ends it (no assistant message)", () => {
  const { rpc, entries } = run(fx.compaction);
  const seq = rpc.map(kind);
  assert.ok(seq.indexOf("compaction_start") >= 0 && seq.indexOf("compaction_start") < seq.indexOf("compaction_end"));
  assert.equal(seq.filter((k) => k === "compaction_end").length, 1);
  assert.ok(!seq.some((k) => k.startsWith("message_") || k.startsWith("text_")), seq.join(","));
  const summary = rpc.find((e) => e.type === "compaction_end").summary;
  assert.match(summary, /^## Objective/);
  assert.deepEqual(entries.map((e) => e.type), ["compaction"]);
  assert.equal(entries[0].summary, summary);
  assert.equal(normalizePiEntry(entries[0], ctx)[0].kind, "compaction");
});

test("reasoning parts stream as thinking; text arriving without deltas is still streamed", () => {
  const { rpc } = run({ sessionID: S, payloads: [
    ...user("u1", "q"), busy, asst("a1"),
    part({ id: "r1", messageID: "a1", type: "reasoning", text: "", time: { start: 1 } }),
    { type: "message.part.delta", properties: { sessionID: S, messageID: "a1", partID: "r1", field: "text", delta: "hmm" } },
    part({ id: "r1", messageID: "a1", type: "reasoning", text: "hmm", time: { start: 1, end: 2 } }),
    part({ id: "x1", messageID: "a1", type: "text", text: "answer", time: { start: 3, end: 4 } }),
    asst("a1", { time: { created: 2000, completed: 5000 }, finish: "stop" }), idle,
  ] });
  const ups = rpc.filter((e) => e.type === "message_update").map((e) => e.assistantMessageEvent);
  assert.deepEqual(ups.map((a) => [a.type, a.contentIndex]), [["thinking_start", 0], ["thinking_delta", 0], ["thinking_end", 0], ["text_start", 1], ["text_delta", 1], ["text_end", 1]]);
  assert.equal(ups[4].delta, "answer");
  assert.deepEqual(msgEnds(rpc, "assistant")[0].message.content, [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "answer" }]);
});

test("payloads of other sessions are ignored", () => {
  const t = new OpencodeTranslator({ sessionID: "ses_other", cwd: "C:\\work" });
  assert.deepEqual(fx.tool.payloads.flatMap((p) => { const o = t.push(p); return [...o.rpc, ...o.entries]; }), []);
});

test("historyEntries turns GET /session/:id/message into the same mirror entries", () => {
  const entries = historyEntries(fx.history.messages, { cwd: "C:\\work" });
  assert.deepEqual(entries.map((e) => e.type === "message" ? e.message.role : e.type), ["user", "model_change", "assistant", "toolResult", "assistant", "compaction"]);
  const live = [...run(fx.tool).entries, ...run(fx.compaction).entries];
  assert.deepEqual(entries.map((e) => e.id), live.map((e) => e.id));
  for (let i = 1; i < entries.length; i++) assert.equal(entries[i].parentId, entries[i - 1].id);
  assert.deepEqual(historyEntries([], {}), []);
});

test("stopReasonOf / errorText / piUsage", () => {
  assert.equal(stopReasonOf({ finish: "stop" }), "stop");
  assert.equal(stopReasonOf({ finish: "tool-calls" }), "toolUse");
  assert.equal(stopReasonOf({ finish: "length" }), "length");
  assert.equal(stopReasonOf({ finish: "stop", error: { name: "MessageAbortedError", data: { message: "Aborted" } } }), "aborted");
  assert.equal(stopReasonOf({ error: { name: "ProviderAuthError", data: { message: "no key" } } }), "error");
  assert.equal(errorText({ name: "APIError", data: { message: "Forbidden", statusCode: 403, isRetryable: false, responseBody: "{\"x\":1}" } }), "403: {\"x\":1}");
  assert.equal(errorText({ name: "APIError", data: { message: "Bad gateway", statusCode: 502, isRetryable: true } }), "502: Bad gateway");
  assert.equal(errorText({ name: "UnknownError", data: { message: "boom" } }), "boom");
  assert.equal(errorText({ name: "MessageOutputLengthError", data: {} }), "MessageOutputLengthError");
  assert.deepEqual(piUsage({ total: 30, input: 10, output: 5, reasoning: 3, cache: { read: 7, write: 5 } }, 0.25), { input: 10, output: 8, cacheRead: 7, cacheWrite: 5, totalTokens: 30, cost: { total: 0.25 } });
  assert.deepEqual(piUsage({ input: 1, output: 2, reasoning: 0, cache: { read: 3, write: 4 } }), { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10, cost: { total: 0 } });
});
