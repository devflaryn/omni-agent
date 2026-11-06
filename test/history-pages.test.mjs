import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWindow, readLineAt, scanBack } from "../server/tailer.mjs";
import { SessionRegistry, SessionWatcher } from "../server/watchers.mjs";
import { createTally } from "../server/tokens.mjs";
import { wireEvent, OUT_INLINE, UPDATE_TAIL } from "../server/wire.mjs";
import { Bus } from "../server/bus.mjs";

const tmpFile = (name = "s.jsonl") => join(mkdtempSync(join(tmpdir(), "hist-")), name);

test("readWindow pages a JSONL file backwards by whole lines, with each line's byte offset", async () => {
  const f = tmpFile();
  const lines = Array.from({ length: 300 }, (_, i) => JSON.stringify({ i, pad: "x".repeat(50) }));
  writeFileSync(f, lines.join("\n") + "\n");
  const seen = [];
  let before;
  for (let pages = 0; pages < 100; pages++) {
    const r = await readWindow(f, { before, maxBytes: 2000 });
    assert.ok(r.lines.length > 0);
    seen.unshift(...r.lines.map((l) => l.obj.i));
    for (const l of r.lines) assert.deepEqual(await readLineAt(f, l.at), l.obj);
    if (r.start === 0) break;
    before = r.start;
  }
  assert.deepEqual(seen, lines.map((_, i) => i));
});

test("readWindow reads further back when one line is longer than a page", async () => {
  const f = tmpFile();
  writeFileSync(f, [JSON.stringify({ i: 0 }), JSON.stringify({ i: 1, big: "y".repeat(10000) }), JSON.stringify({ i: 2 })].join("\n") + "\n");
  const first = await readWindow(f, { maxBytes: 100 });
  assert.deepEqual(first.lines.map((l) => l.obj.i), [2]);
  const second = await readWindow(f, { before: first.start, maxBytes: 100 });
  assert.equal(second.lines.at(-1).obj.i, 1, "the long line is read whole");
  assert.equal(second.lines.at(-1).obj.big.length, 10000);
});

test("scanBack finds the newest line holding a needle across chunk boundaries", async () => {
  const f = tmpFile();
  const lines = Array.from({ length: 200 }, (_, i) => JSON.stringify({ i, id: i % 50 === 7 ? "tool-7" : `t${i}` }));
  writeFileSync(f, lines.join("\n") + "\n");
  assert.equal(await scanBack(f, '"tool-7"', (o) => o.i, { chunk: 97 }), 157);
  assert.equal(await scanBack(f, '"tool-7"', (o) => (o.i < 100 ? o.i : undefined), { chunk: 97 }), 57);
  assert.equal(await scanBack(f, '"nope"', (o) => o.i, { chunk: 97 }), undefined);
});

test("wireEvent clips long tool outputs and diffs for the page, never the event itself", () => {
  const long = "z".repeat(OUT_INLINE + 1);
  const end = { kind: "tool", phase: "end", toolId: "c1", text: long };
  const w = wireEvent(end);
  assert.equal(w.text, ""); assert.equal(w.clipped, long.length); assert.equal(end.text, long);
  assert.equal(wireEvent({ kind: "tool", phase: "end", text: "short" }).clipped, undefined);
  assert.equal(wireEvent({ kind: "tool", phase: "update", text: "q".repeat(UPDATE_TAIL + 10) }).text.length, UPDATE_TAIL);
  const diff = `@@ -1,1 +1,2 @@\n-a\n+b\n+c\n${" pad\n".repeat(5000)}`;
  const msg = wireEvent({ kind: "msg", role: "tool", blocks: [{ type: "tool_result", toolId: "e1", text: "ok", diff, at: 12 }] });
  assert.equal(msg.blocks[0].diff, undefined);
  assert.deepEqual(msg.blocks[0].diffStat, { added: 2, removed: 1 });
  assert.equal(msg.blocks[0].text, "ok"); assert.equal(msg.blocks[0].at, 12); assert.ok(msg.blocks[0].clipped);
  const plain = { kind: "msg", role: "assistant", blocks: [{ type: "text", text: long }] };
  assert.equal(wireEvent(plain), plain);
});

test("the bus writes clipped events to pages but keeps the full result for tool-output", () => {
  const bus = new Bus();
  const written = [];
  bus.addClient({ write: (s) => written.push(s) });
  const long = "o".repeat(5000);
  bus.emit({ sid: "pi:a", kind: "tool", phase: "end", toolId: "c1", text: long });
  assert.ok(!written.join("").includes(long));
  assert.equal(bus.toolResult("pi:a", "c1").text, long);
  assert.equal(bus.toolResult("pi:b", "c1"), undefined);
});

/** A pi session file of `turns` turns, each: a user prompt, an assistant tool call, a big tool result, a reply. */
function piSession(turns) {
  const out = [];
  let ts = 1_700_000_000_000;
  for (let i = 0; i < turns; i++) {
    out.push({ type: "message", id: `u${i}`, timestamp: ts++, message: { role: "user", content: [{ type: "text", text: `prompt ${i}` }] } });
    out.push({ type: "message", id: `a${i}`, timestamp: ts++, message: { role: "assistant", content: [{ type: "toolCall", id: `call${i}`, name: "bash", arguments: { command: `echo ${i}` } }] } });
    out.push({ type: "message", id: `r${i}`, timestamp: ts++, message: { role: "toolResult", toolCallId: `call${i}`, toolName: "bash", content: [{ type: "text", text: `out${i} `.repeat(400) }], isError: false } });
    out.push({ type: "message", id: `b${i}`, timestamp: ts++, message: { role: "assistant", content: [{ type: "text", text: `reply ${i}` }] } });
  }
  return out.map((o) => JSON.stringify(o)).join("\n") + "\n";
}

test("history pages a long chat from newest to oldest, each page starting at a user message, and tool outputs read back", async () => {
  const f = tmpFile("2026_ses_abc.jsonl");
  writeFileSync(f, piSession(40));
  const registry = new SessionRegistry();
  registry.upsert("pi:ses_abc", { file: f });
  const w = Object.create(SessionWatcher.prototype);
  Object.assign(w, { registry, tally: createTally() });
  const prompts = [];
  let before, pages = 0;
  for (;;) {
    const h = await w.history("pi:ses_abc", { before, maxBytes: 8000 });
    pages++;
    const first = h.events.find((e) => e.kind === "msg");
    assert.equal(first.role, "user", "a page starts at a user message");
    prompts.unshift(...h.events.filter((e) => e.kind === "msg" && e.role === "user").map((e) => e.blocks[0].text));
    const res = h.events.find((e) => e.kind === "msg" && e.role === "tool")?.blocks[0];
    if (res) {
      assert.equal(typeof res.at, "number");
      const full = await w.toolOutput("pi:ses_abc", res.toolId, { at: res.at });
      assert.equal(full.text, res.text);
      assert.deepEqual(await w.toolOutput("pi:ses_abc", res.toolId), full, "found without the offset too");
    }
    if (!h.more) break;
    before = h.start;
  }
  assert.ok(pages > 3);
  assert.deepEqual(prompts, Array.from({ length: 40 }, (_, i) => `prompt ${i}`));
});
