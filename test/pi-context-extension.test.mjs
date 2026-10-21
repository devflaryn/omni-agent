/**
 * The omni-context pi extension: CONTEXT_GUIDANCE is appended to the system prompt, and once the
 * conversation passes statusFromPercent of the compaction budget (contextWindow − reserveTokens) a status
 * note is appended to the newest user/toolResult/custom message of the LLM call — a copy, never the incoming
 * objects, earlier messages untouched. And an oversized compaction span is folded into the summary chunk by chunk.
 * Loads the real extension source through node's type stripping against a temp ~/.pi/agent; pi's own packages
 * (its summarizer) resolve from the installed pi, so these tests are skipped when pi is not installed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { registerHooks } from "node:module";
import { ROOT, findPiCli } from "../server/config.mjs";
import { CONTEXT_GUIDANCE } from "../integrations/pi/omni-context-lib.mjs";

const EXT = join(ROOT, "integrations", "pi", "omni-context.ts");
const piCli = findPiCli();
const skip = !piCli && "pi is not installed";
if (piCli) {
  const extUrl = pathToFileURL(EXT).href;
  registerHooks({
    resolve(specifier, context, next) {
      if (String(context.parentURL || "").split("?")[0] === extUrl && !specifier.startsWith(".") && !specifier.startsWith("node:") && !specifier.startsWith("file:")) {
        return next(specifier, { ...context, parentURL: pathToFileURL(piCli).href });
      }
      return next(specifier, context);
    },
  });
}

/** Load the extension with `files` ({ "settings.json": {...}, "omni-agent.json": {...} }) in a temp ~/.pi/agent. */
async function load({ files = {}, env = {} } = {}) {
  const home = mkdtempSync(join(tmpdir(), "omni-ctx-"));
  const agent = join(home, ".pi", "agent");
  mkdirSync(agent, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(agent, name), typeof body === "string" ? body : JSON.stringify(body));
  const keys = ["HOME", "USERPROFILE", "PI_CODING_AGENT_DIR", "OMNI_CONTEXT"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  process.env.HOME = home; process.env.USERPROFILE = home;
  delete process.env.PI_CODING_AGENT_DIR; delete process.env.OMNI_CONTEXT;
  for (const [k, v] of Object.entries(typeof env === "function" ? env(home) : env)) process.env[k] = v;
  const handlers = {};
  try {
    const mod = await import(`${pathToFileURL(EXT).href}?${Math.random()}`);
    mod.default({ on: (name, fn) => { (handlers[name] ||= []).push(fn); }, registerTool: () => assert.fail("no tools"), sendMessage: () => assert.fail("no messages") });
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(home, { recursive: true, force: true });
  }
  // pi chains handlers of one event: each sees the messages the one before it returned.
  const on = Object.fromEntries(Object.entries(handlers).map(([name, fns]) => [name, fns.length === 1 ? fns[0] : async (ev, ctx) => {
    let messages = ev.messages, changed = false;
    for (const fn of fns) { const r = await fn({ ...ev, messages }, ctx); if (r?.messages) { messages = r.messages; changed = true; } }
    return changed ? { messages } : undefined;
  }]));
  const context = (messages, usage) => on.context({ type: "context", messages }, { getContextUsage: () => usage });
  return { on, context };
}

const convo = () => [
  { role: "user", content: [{ type: "text", text: "rebuild the payload" }], timestamp: 1 },
  { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "make" } }], timestamp: 2 },
  { role: "toolResult", toolCallId: "t1", toolName: "bash", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 3 },
];

test("omni-context: the guidance is appended to the system prompt, the incoming prompt kept intact", { skip }, async () => {
  const x = await load();
  assert.deepEqual(Object.keys(x.on).sort(), ["before_agent_start", "context", "session_before_compact"]);
  const r = await x.on.before_agent_start({ type: "before_agent_start", prompt: "go", systemPrompt: "BASE PROMPT\nline 2" });
  assert.equal(r.systemPrompt, `BASE PROMPT\nline 2\n\n${CONTEXT_GUIDANCE}`);
  assert.equal(await x.on.before_agent_start({ prompt: "again", systemPrompt: r.systemPrompt }), undefined, "never added twice");
  assert.equal((await x.on.before_agent_start({ prompt: "x", systemPrompt: "" })).systemPrompt, CONTEXT_GUIDANCE);
});

test("omni-context: past statusFromPercent of contextWindow − reserveTokens the newest message gets the note", { skip }, async () => {
  const x = await load({ files: { "settings.json": { compaction: { reserveTokens: 24576 } }, "omni-agent.json": { port: 4400, context: { statusFromPercent: 60 } } } });
  const messages = convo();
  const before = JSON.stringify(messages);
  // budget = 280576 − 24576 = 256000; 200000 / 256000 = 78%
  const r = await x.context(messages, { tokens: 200000, contextWindow: 280576, percent: 71.3 });
  assert.equal(r.messages.length, 3);
  assert.equal(r.messages[0], messages[0], "earlier messages are the same objects (prompt cache kept)");
  assert.equal(r.messages[1], messages[1]);
  assert.notEqual(r.messages[2], messages[2], "the newest message is a copy");
  assert.equal(r.messages[2].toolCallId, "t1", "its other fields are kept");
  assert.equal(r.messages[2].content.length, 2);
  assert.equal(r.messages[2].content[0], messages[2].content[0]);
  assert.match(r.messages[2].content[1].text, /^\n\[context: 78% of the budget before automatic compaction\./);
  assert.equal(JSON.stringify(messages), before, "the incoming messages are not mutated");

  assert.equal(await x.context(convo(), { tokens: 140000, contextWindow: 280576 }), undefined, "55% is below the configured 60%");
  assert.equal(await x.context(convo(), { tokens: null, contextWindow: 280576, percent: null }), undefined, "unknown right after a compaction");
  assert.equal(await x.context(convo(), { tokens: 200000, contextWindow: 20000 }), undefined, "no budget left after the reserve");
  assert.equal(await x.context(convo(), undefined), undefined, "no model");
  assert.equal(await x.context(convo().slice(0, 2), { tokens: 250000, contextWindow: 280576 }), undefined, "only after a user/toolResult message");
  assert.equal(await x.context([], { tokens: 250000, contextWindow: 280576 }), undefined);
  assert.equal(await x.on.context({ messages: convo() }, { getContextUsage: () => { throw new Error("boom"); } }), undefined, "never throws");
  assert.equal(await x.on.context({ messages: convo() }, {}), undefined);

  const str = await x.context([{ role: "user", content: "plain string prompt", timestamp: 9 }], { tokens: 250000, contextWindow: 280576 });
  assert.deepEqual(str.messages[0].content.map((c) => c.type), ["text", "text"]);
  assert.equal(str.messages[0].content[0].text, "plain string prompt");
  assert.match(str.messages[0].content[1].text, /98%/);

  // A turn woken by a background agent's report: pi sends the custom message to the model as a user message.
  const report = { role: "custom", customType: "omni-agent-result", content: [{ type: "text", text: "agent a1 finished" }], display: true, timestamp: 4 };
  const woken = await x.context([...convo(), report], { tokens: 200000, contextWindow: 280576 });
  assert.equal(woken.messages.length, 4);
  assert.equal(woken.messages[3].customType, "omni-agent-result");
  assert.equal(woken.messages[3].content[0], report.content[0]);
  assert.match(woken.messages[3].content[1].text, /^\n\[context: 78%/);
  assert.equal(report.content.length, 1, "the report is not mutated");
});

test("omni-context: pi's defaults without config (reserve 16384, from 70%); PI_CODING_AGENT_DIR is where settings live", { skip }, async () => {
  const x = await load();
  // budget = 272384 − 16384 = 256000
  assert.match((await x.context(convo(), { tokens: 179200, contextWindow: 272384 })).messages[2].content[1].text, /\[context: 70%/);
  assert.equal(await x.context(convo(), { tokens: 170000, contextWindow: 272384 }), undefined, "66%");
  const malformed = await load({ files: { "settings.json": "{ not json", "omni-agent.json": "[]" } });
  assert.match((await malformed.context(convo(), { tokens: 179200, contextWindow: 272384 })).messages[2].content[1].text, /70%/);

  const moved = await load({ env: (home) => {
    const dir = join(home, "elsewhere");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ compaction: { reserveTokens: 72384 } }));
    return { PI_CODING_AGENT_DIR: dir };
  } });
  // budget = 272384 − 72384 = 200000; 150000 = 75%
  assert.match((await moved.context(convo(), { tokens: 150000, contextWindow: 272384 })).messages[2].content[1].text, /75%/);
});

test("omni-context: OMNI_CONTEXT=off and compaction.enabled=false register only the tool-call id repair", { skip }, async () => {
  for (const x of [await load({ env: { OMNI_CONTEXT: "off" } }), await load({ files: { "settings.json": { compaction: { enabled: false } } } })]) {
    assert.deepEqual(Object.keys(x.on), ["context"]);
    assert.equal(await x.context(convo(), { tokens: 250000, contextWindow: 280576 }), undefined, "no status note");
    assert.equal((await x.context(idless(), undefined)).messages[2].toolCallId, "call_omni_2_1");
  }
});

// What a malformed provider stream leaves in the session: a tool call with no id and no name, and pi's error result.
const idless = () => [
  { role: "user", content: [{ type: "text", text: "rebuild the payload" }], timestamp: 1 },
  { role: "assistant", content: [{ type: "thinking", thinking: "…" }, { type: "toolCall", id: "", name: "", arguments: { task: "x" } }], stopReason: "toolUse", timestamp: 2 },
  { role: "toolResult", toolCallId: "", toolName: "", content: [{ type: "text", text: "Tool  not found" }], isError: true, timestamp: 3 },
];

test("omni-context: a saved tool call without an id is given one (with its result) before the request, beside the status note", { skip }, async () => {
  const x = await load();
  const messages = idless();
  const before = JSON.stringify(messages);
  const r = await x.context(messages, undefined);
  assert.equal(r.messages[0], messages[0], "untouched messages are the same objects");
  assert.deepEqual(r.messages[1].content[1], { type: "toolCall", id: "call_omni_2_1", name: "unknown_tool", arguments: { task: "x" } });
  assert.equal(r.messages[1].content[0], messages[1].content[0]);
  assert.equal(r.messages[2].toolCallId, "call_omni_2_1");
  assert.equal(r.messages[2].toolName, "unknown_tool");
  assert.equal(JSON.stringify(messages), before, "the session's own messages are not changed");
  assert.deepEqual((await x.context(idless(), undefined)).messages, r.messages, "the same ids every request (prompt cache kept)");
  // Both handlers apply: the repair, then the note on the newest message.
  const both = await x.context(idless(), { tokens: 250000, contextWindow: 272384 });
  assert.equal(both.messages[2].toolCallId, "call_omni_2_1");
  assert.match(both.messages[2].content[1].text, /\[context: 98%/);
  assert.equal(await x.context(convo(), undefined), undefined, "a healthy conversation is passed through");
});

// A run of `n` turns of ~`chars` serialized characters each (thinking dominates, as in the long deepseek chats).
const bigSpan = (n, chars) => Array.from({ length: n }, (_, i) => [
  { role: "user", content: [{ type: "text", text: `step ${i}` }], timestamp: i * 2 },
  { role: "assistant", content: [{ type: "thinking", thinking: "x".repeat(chars) }, { type: "text", text: `done ${i}` }], provider: "p", model: "m", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 }, stopReason: "stop", timestamp: i * 2 + 1 },
]).flat();
const compactEvent = (messages, extra = {}) => ({ type: "session_before_compact", preparation: { firstKeptEntryId: "keep-1", messagesToSummarize: messages, turnPrefixMessages: [], isSplitTurn: false, tokensBefore: 900000, previousSummary: undefined, fileOps: { read: new Set(), written: new Set(), edited: new Set() }, settings: { enabled: true, reserveTokens: 32768, keepRecentTokens: 32000 } }, customInstructions: undefined, reason: "overflow", willRetry: false, ...extra });

test("omni-context: a compaction span that fits one summary request is left to pi's own compaction", { skip }, async () => {
  const x = await load({ files: { "settings.json": { compaction: { reserveTokens: 32768 } } } });
  const model = { provider: "p", id: "m", api: "openai-completions", baseUrl: "http://127.0.0.1:9", contextWindow: 288768, maxTokens: 65536, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  let authAsked = false;
  const ctx = { model, modelRegistry: { getApiKeyAndHeaders: async () => { authAsked = true; return { apiKey: "k", headers: {} }; } } };
  assert.equal(await x.on.session_before_compact(compactEvent(bigSpan(20, 2000)), ctx), undefined);
  assert.equal(authAsked, false, "nothing is summarized by the extension when pi can do it in one request");
});

test("omni-context: an oversized span (an old 900k chat under a 288k window) is chunked; a failing summary falls back to pi", { skip }, async () => {
  const x = await load({ files: { "settings.json": { compaction: { reserveTokens: 32768 } } } });
  // The provider is unreachable: every summary call fails, so the handler must fail open (undefined), never throw.
  const model = { provider: "p", id: "m", api: "openai-completions", baseUrl: "http://127.0.0.1:9", contextWindow: 288768, maxTokens: 65536, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  let authAsked = false;
  const notes = [];
  const ctx = { model, ui: { notify: (m) => notes.push(m) }, modelRegistry: { getApiKeyAndHeaders: async () => { authAsked = true; return { apiKey: "k", headers: {} }; } } };
  // 300 turns × ~60k chars ≈ 5.6M tokens of span: far past one request.
  const out = await x.on.session_before_compact(compactEvent(bigSpan(300, 60000), { signal: AbortSignal.timeout(20000) }), ctx);
  assert.equal(authAsked, true, "the oversized span is summarized by the extension");
  assert.match(notes[0] || "", /Compacting a large conversation in \d+ parts/);
  assert.equal(out, undefined, "a failed summary falls back to pi's own compaction");
});
