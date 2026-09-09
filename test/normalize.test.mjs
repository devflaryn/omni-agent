import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizePiEntry,
  normalizePiRpcEvent,
  normalizeClaudeEntry,
  normalizeClaudeStream,
  usageFromPi,
  usageFromClaude,
} from "../server/normalize.mjs";

const ctx = { sid: "pi:abc", harness: "pi" };

test("pi session header -> session event", () => {
  const ev = normalizePiEntry({ type: "session", version: 3, id: "abc", timestamp: "2026-09-09T14:51:12.099Z", cwd: "C:\\x" }, ctx);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].kind, "session");
  assert.equal(ev[0].cwd, "C:\\x");
});

test("pi assistant message -> msg with text/thinking/tool_call blocks and usage", () => {
  const entry = {
    type: "message",
    id: "m1",
    timestamp: "2026-09-09T14:51:27.453Z",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hmm" },
        { type: "text", text: "hi" },
        { type: "toolCall", id: "c1", name: "ls", arguments: { path: "." } },
      ],
      model: "Qwen",
      usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: { total: 0 } },
    },
  };
  const [ev] = normalizePiEntry(entry, ctx);
  assert.equal(ev.kind, "msg");
  assert.equal(ev.role, "assistant");
  assert.deepEqual(ev.blocks.map((b) => b.type), ["thinking", "text", "tool_call"]);
  assert.equal(ev.blocks[2].name, "ls");
  assert.equal(ev.usage.input, 10);
  assert.equal(ev.live, false);
});

test("pi toolResult -> tool_result msg", () => {
  const [ev] = normalizePiEntry(
    { type: "message", id: "m2", timestamp: "t", message: { role: "toolResult", toolCallId: "c1", toolName: "ls", content: [{ type: "text", text: "a\nb" }], isError: false } },
    ctx,
  );
  assert.equal(ev.role, "tool");
  assert.equal(ev.blocks[0].type, "tool_result");
  assert.equal(ev.blocks[0].text, "a\nb");
  assert.equal(ev.blocks[0].toolId, "c1");
});

test("pi user message with string content", () => {
  const [ev] = normalizePiEntry({ type: "message", id: "m3", timestamp: "t", message: { role: "user", content: "yo" } }, ctx);
  assert.equal(ev.role, "user");
  assert.equal(ev.blocks[0].text, "yo");
});

test("pi rpc deltas -> delta events; message_end -> live msg; status + tool events", () => {
  const d = normalizePiRpcEvent({ type: "message_update", usage: { input: 1 }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "He" } }, ctx);
  assert.equal(d[0].kind, "delta");
  assert.equal(d[0].part, "text");
  assert.equal(d[0].delta, "He");
  const tc = normalizePiRpcEvent({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 1, id: "c9", toolName: "bash" } }, ctx);
  assert.equal(tc[0].kind, "block");
  assert.equal(tc[0].toolId, "c9");
  const end = normalizePiRpcEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Hello" }], usage: { input: 5, output: 1 } } }, ctx);
  assert.equal(end[0].kind, "msg");
  assert.equal(end[0].live, true);
  const st = normalizePiRpcEvent({ type: "agent_start" }, ctx);
  assert.equal(st[0].kind, "status");
  assert.equal(st[0].streaming, true);
  const te = normalizePiRpcEvent({ type: "tool_execution_end", toolCallId: "c9", toolName: "bash", result: { content: [{ type: "text", text: "ok" }] }, isError: false }, ctx);
  assert.equal(te[0].kind, "tool");
  assert.equal(te[0].phase, "end");
});

test("claude jsonl assistant block lines share groupId; usage normalized; meta hidden", () => {
  const cctx = { sid: "claude:s1", harness: "claude" };
  const line = {
    type: "assistant",
    uuid: "u1",
    timestamp: "2026-09-09T15:48:25.620Z",
    cwd: "C:\\p",
    message: {
      id: "msg_1",
      model: "claude-fable-5-1",
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }],
      usage: { input_tokens: 2, cache_creation_input_tokens: 18, cache_read_input_tokens: 31, output_tokens: 4 },
    },
  };
  const [ev] = normalizeClaudeEntry(line, cctx);
  assert.equal(ev.kind, "msg");
  assert.equal(ev.groupId, "msg_1");
  assert.equal(ev.blocks[0].type, "tool_call");
  assert.equal(ev.blocks[0].name, "Bash");
  assert.deepEqual(ev.usage, { input: 2, output: 4, cacheRead: 31, cacheWrite: 18, total: 55 });
  const tr = normalizeClaudeEntry(
    { type: "user", uuid: "u2", timestamp: "t", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "out", is_error: false }] } },
    cctx,
  );
  assert.equal(tr[0].role, "tool");
  assert.equal(tr[0].blocks[0].toolId, "toolu_1");
  const meta = normalizeClaudeEntry({ type: "user", uuid: "u3", isMeta: true, message: { role: "user", content: "caveat" } }, cctx);
  assert.equal(meta.length, 0, "meta/caveat user lines are hidden");
  const title = normalizeClaudeEntry({ type: "ai-title", aiTitle: "Omni" }, cctx);
  assert.equal(title[0].kind, "session");
  assert.equal(title[0].title, "Omni");
});

test("claude stream-json -> deltas, msgs, run result; hook noise dropped", () => {
  const cctx = { sid: "claude:run1", harness: "claude" };
  const init = normalizeClaudeStream({ type: "system", subtype: "init", session_id: "db3", cwd: "C:\\p", model: "claude-opus-5" }, cctx);
  assert.equal(init[0].kind, "session");
  assert.equal(init[0].sessionId, "db3");
  const d = normalizeClaudeStream({ type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "hi" } } }, cctx);
  assert.equal(d[0].kind, "delta");
  assert.equal(d[0].delta, "hi");
  const bs = normalizeClaudeStream({ type: "stream_event", event: { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_9", name: "Bash" } } }, cctx);
  assert.equal(bs[0].kind, "block");
  assert.equal(bs[0].toolId, "toolu_9");
  const a = normalizeClaudeStream({ type: "assistant", uuid: "u", message: { id: "m", role: "assistant", content: [{ type: "text", text: "hi" }], usage: { input_tokens: 1, output_tokens: 1 } } }, cctx);
  assert.equal(a[0].kind, "msg");
  assert.equal(a[0].live, true);
  const r = normalizeClaudeStream({ type: "result", subtype: "success", total_cost_usd: 0.02, session_id: "db3", result: "done" }, cctx);
  assert.equal(r[0].kind, "run");
  assert.equal(r[0].cost, 0.02);
  const hook = normalizeClaudeStream({ type: "system", subtype: "hook_started" }, cctx);
  assert.equal(hook.length, 0);
});

test("usage helpers", () => {
  assert.deepEqual(usageFromPi({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10 }), { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 });
  assert.deepEqual(usageFromClaude({ input_tokens: 1, output_tokens: 2 }), { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 });
});
