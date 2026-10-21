/**
 * The omni-run pi extension (active only with OMNI_RUN_DIR): the goal + ledger block reaches the model on
 * the newest user/toolResult message — a `role: "system"` message is dropped by pi's convertToLlm — and the
 * compaction summary only replaces ledger.md when the summary call finished cleanly. Loads the real
 * extension source through node's type stripping with a fake ExtensionAPI and a fake model registry; pi's
 * own packages resolve from the installed pi (skipped when pi is not installed).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { registerHooks } from "node:module";
import { ROOT, findPiCli } from "../server/config.mjs";

const EXT = join(ROOT, "integrations", "pi", "omni-run.ts");
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

const GOAL = "Rebuild the payload and prove it loads on the device";
const LEDGER = `# Run ledger\n\n## Goal\n${GOAL}\n\n## Critical facts\n- crash offset 0x1234 in libfoo.so\n\n## Next steps\n- rebuild with -O2\n`;

/** A run dir with run.json + ledger.md, the extension loaded against it (OMNI_RUN_DIR is read at load). */
async function load({ ledger = LEDGER } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "omni-run-"));
  writeFileSync(join(dir, "run.json"), JSON.stringify({ goalText: GOAL }));
  if (ledger != null) writeFileSync(join(dir, "ledger.md"), ledger);
  const saved = process.env.OMNI_RUN_DIR;
  process.env.OMNI_RUN_DIR = dir;
  const on = {};
  try {
    const mod = await import(`${pathToFileURL(EXT).href}?${Math.random()}`);
    mod.default({ on: (name, fn) => { on[name] = fn; } });
  } finally {
    if (saved === undefined) delete process.env.OMNI_RUN_DIR; else process.env.OMNI_RUN_DIR = saved;
  }
  const ledgerNow = () => readFileSync(join(dir, "ledger.md"), "utf8");
  return { dir, on, ledgerNow, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const convo = () => [
  { role: "user", content: [{ type: "text", text: "start" }], timestamp: 1 },
  { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "make" } }], timestamp: 2 },
  { role: "toolResult", toolCallId: "t1", toolName: "bash", content: [{ type: "text", text: "built" }], isError: false, timestamp: 3 },
];

/** A session_before_compact event + ctx whose summary model answers `response` (or throws it when an Error). */
function compactCall(response) {
  const calls = [];
  const preparation = {
    messagesToSummarize: [
      { role: "user", content: [{ type: "text", text: "look at libfoo" }], timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "found a second crash at 0x5678" }], timestamp: 2 },
    ],
    turnPrefixMessages: [],
    firstKeptEntryId: "e42",
    tokensBefore: 300000,
  };
  const ctx = {
    model: { provider: "fake", id: "summary-model" },
    modelRegistry: { complete: async (model, req, opts) => { calls.push({ model, req, opts }); if (response instanceof Error) throw response; return response; } },
  };
  return { ev: { type: "session_before_compact", preparation, signal: new AbortController().signal }, ctx, calls };
}

test("omni-run: the goal + ledger ride on the newest message, never as a dropped system message", { skip }, async () => {
  const x = await load();
  try {
    const messages = convo();
    const before = JSON.stringify(messages);
    const r = await x.on.context({ type: "context", messages });
    assert.equal(r.messages.length, 3, "nothing prepended");
    assert.ok(!r.messages.some((m) => m.role === "system"));
    assert.equal(r.messages[0], messages[0], "earlier messages untouched (prompt cache kept)");
    assert.equal(r.messages[1], messages[1]);
    const tail = r.messages[2].content.at(-1).text;
    assert.match(tail, /<omni-run-goal>\nRebuild the payload and prove it loads on the device\n<\/omni-run-goal>/);
    assert.match(tail, /crash offset 0x1234/);
    assert.equal(r.messages[2].content[0], messages[2].content[0]);
    assert.equal(JSON.stringify(messages), before, "the incoming messages are not mutated");
    assert.equal(await x.on.context({ type: "context", messages: messages.slice(0, 2) }), undefined, "nothing to append to after an assistant message");
    // A turn woken by a background agent's report (a custom message, sent to the model as a user message).
    const report = { role: "custom", customType: "omni-agent-result", content: "agent a1 finished: 3 crashes fixed", display: true, timestamp: 4 };
    const woken = await x.on.context({ type: "context", messages: [...messages, report] });
    assert.equal(woken.messages[2], messages[2]);
    assert.equal(woken.messages[3].customType, "omni-agent-result");
    assert.equal(woken.messages[3].content[0].text, "agent a1 finished: 3 crashes fixed");
    assert.match(woken.messages[3].content[1].text, /<omni-run-goal>/);
    assert.equal(report.content, "agent a1 finished: 3 crashes fixed", "the report is not mutated");
  } finally { x.cleanup(); }
});

test("omni-run: a clean summary answer is folded into ledger.md, the goal kept verbatim", { skip }, async () => {
  const x = await load();
  try {
    const answer = "# Run ledger\n\n## Goal\nSomething else entirely\n\n## Critical facts\n- crash offset 0x1234 in libfoo.so\n- second crash at 0x5678\n\n## Next steps\n- rebuild with -O2";
    const { ev, ctx, calls } = compactCall({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: answer }], usage: { input: 10, output: 20 } });
    const r = await x.on.session_before_compact(ev, ctx);
    assert.equal(calls.length, 1);
    assert.match(calls[0].req.messages[0].content[0].text, /found a second crash at 0x5678/, "the compacted span is serialized for the summary model");
    assert.equal(r.compaction.firstKeptEntryId, "e42");
    assert.equal(r.compaction.tokensBefore, 300000);
    assert.match(r.compaction.summary, /^GOAL: Rebuild the payload/);
    assert.match(r.compaction.summary, /0x5678/);
    const ledger = x.ledgerNow();
    assert.match(ledger, /## Goal\nRebuild the payload and prove it loads on the device/);
    assert.doesNotMatch(ledger, /Something else entirely/);
    assert.match(ledger, /second crash at 0x5678/);
  } finally { x.cleanup(); }
});

test("omni-run: a cut-off, failed, aborted or tool-calling summary never overwrites ledger.md (pi compacts instead)", { skip }, async () => {
  const x = await load();
  try {
    const partial = [{ type: "text", text: "# Run ledger\n\n## Critical facts\n- crash off" }];
    for (const response of [
      { role: "assistant", stopReason: "length", content: partial },
      { role: "assistant", stopReason: "error", errorMessage: "502 upstream", content: partial },
      { role: "assistant", stopReason: "aborted", content: partial },
      { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "c", name: "bash", arguments: {} }] },
      { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "   " }] },
      new Error("network down"),
    ]) {
      const { ev, ctx } = compactCall(response);
      assert.equal(await x.on.session_before_compact(ev, ctx), undefined, String(response.stopReason || response.message));
      assert.equal(x.ledgerNow(), LEDGER, `ledger.md unchanged after ${response.stopReason || response.message}`);
    }
  } finally { x.cleanup(); }
});

test("omni-run: without OMNI_RUN_DIR nothing is registered", { skip }, async () => {
  const saved = process.env.OMNI_RUN_DIR;
  delete process.env.OMNI_RUN_DIR;
  try {
    const mod = await import(`${pathToFileURL(EXT).href}?${Math.random()}`);
    const on = {};
    mod.default({ on: (name, fn) => { on[name] = fn; } });
    assert.deepEqual(on, {});
  } finally { if (saved !== undefined) process.env.OMNI_RUN_DIR = saved; }
});
