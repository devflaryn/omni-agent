import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatEvent, runHeadless } from "../scripts/headless.mjs";

test("formatEvent renders tool starts/ends and assistant text, hides deltas", () => {
  const started = 1000;
  assert.equal(formatEvent({ kind: "tool", phase: "start", name: "bash", args: { command: "omnidroid list" }, ts: 3000 }, { started }), "    2s ▶ bash: omnidroid list");
  assert.equal(formatEvent({ kind: "tool", phase: "end", name: "bash", text: "alice  running\nmore", isError: false, ts: 4000 }, { started }), "    3s   ✓ alice running more");
  assert.equal(formatEvent({ kind: "tool", phase: "end", name: "bash", text: "boom", isError: true, ts: 4000 }, { started }), "    3s   ✗ boom");
  assert.equal(formatEvent({ kind: "msg", role: "assistant", blocks: [{ type: "text", text: "Booted." }], ts: 5000 }, { started }), "    4s 🤖 Booted.");
  assert.equal(formatEvent({ kind: "delta", part: "text", delta: "x", ts: 5000 }, { started }), null);
  assert.equal(formatEvent({ kind: "msg", role: "assistant", blocks: [{ type: "thinking", text: "hmm" }], ts: 5000 }, { started }), null);
});

test("runHeadless prompts the pi child, streams its events and settles with a summary", async () => {
  const base = mkdtempSync(join(tmpdir(), "omni-headless-"));
  const lines = [];
  let fake;
  const createPi = ({ cwd, bus }) => {
    fake = {
      proc: {}, sid: "pi:fake", cwd, streaming: false, state: { sessionFile: "/s/fake.jsonl", model: { provider: "openrouter", id: "deepseek/deepseek-v4-flash-0731" }, thinkingLevel: "low" }, calls: [],
      start() {}, stop() {}, owns() { return false; }, waitReady() { return Promise.resolve(this.state); },
      async setThinking(l) { this.calls.push(["thinking", l]); },
      async prompt(m) {
        this.calls.push(["prompt", m]);
        const ctx = { sid: this.sid, harness: "pi" };
        setTimeout(() => {
          bus.emit({ ...ctx, kind: "status", ts: Date.now(), streaming: true });
          bus.emit({ ...ctx, kind: "tool", ts: Date.now(), toolId: "t1", name: "bash", phase: "start", args: { command: "omnidroid list" } });
          bus.emit({ ...ctx, kind: "tool", ts: Date.now(), toolId: "t1", name: "bash", phase: "end", text: "nothing running", isError: false });
          bus.emit({ ...ctx, kind: "msg", ts: Date.now(), id: "a1", role: "assistant", live: true, blocks: [{ type: "text", text: "Done: nothing was running." }], usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 }, cost: 0.001 });
          bus.emit({ ...ctx, kind: "status", ts: Date.now(), streaming: false });
        }, 20);
        return { ok: true };
      },
    };
    return fake;
  };
  try {
    const code = await runHeadless({ cwd: base, task: "check the emulator", thinking: "low", port: 0, out: (l) => lines.push(l), cfg: { vaultDir: join(base, "vault"), piSessionsDir: join(base, "pi-sessions"), claudeProjectsDir: join(base, "claude-projects"), createPi } });
    assert.equal(code, 0);
    assert.deepEqual(fake.calls, [["thinking", "low"], ["prompt", "check the emulator"]]);
    const joined = lines.join("\n");
    assert.match(joined, /pi ready · session \/s\/fake\.jsonl · model openrouter\/deepseek\/deepseek-v4-flash-0731/);
    assert.match(joined, /▶ bash: omnidroid list/);
    assert.match(joined, /✓ nothing running/);
    assert.match(joined, /🤖 Done: nothing was running\./);
    assert.match(joined, /agent settled after \d+s · tools: bash×1 · tokens in\/out 10\/5/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("runHeadless stops at --max-seconds with exit code 2", async () => {
  const base = mkdtempSync(join(tmpdir(), "omni-headless-"));
  const lines = [];
  const createPi = ({ cwd }) => ({ proc: {}, sid: "pi:fake", cwd, streaming: false, state: {}, start() {}, stop() {}, owns() { return false; }, waitReady() { return Promise.resolve({}); }, async prompt() { return { ok: true }; }, async abort() { return { ok: true }; } });
  try {
    const code = await runHeadless({ cwd: base, task: "hang", maxSeconds: 0.2, port: 0, out: (l) => lines.push(l), cfg: { vaultDir: join(base, "vault"), piSessionsDir: join(base, "pi-sessions"), claudeProjectsDir: join(base, "claude-projects"), createPi } });
    assert.equal(code, 2);
    assert.match(lines.join("\n"), /stopped at --max-seconds 0\.2/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
