// test/run-cli.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runUnattended } from "../scripts/run.mjs";
import { RunLedger } from "../server/run-ledger.mjs";

function fakeApp({ onGoal }) {
  const listeners = [];
  const bus = { on: (_e, f) => listeners.push(f), off() {}, emit(ev) { for (const f of listeners) f(ev); } };
  const pi = { sid: "pi:1", proc: {}, streaming: false, state: { sessionFile: "/s/a.jsonl" }, waitReady: async () => {}, prompt: async () => {}, stop() {} };
  const keeper = { setExplicitGoal: (_s, g) => onGoal(g), setConfig() {}, startHeartbeat() {}, config: { enabled: true } };
  return {
    async listen() {}, close() {}, bus, keeper, startPi: () => pi, get pi() { return pi; },
    vault: { pack: async () => "" }, cfg: {},
    _settle() { bus.emit({ sid: "pi:1", kind: "status", streaming: false }); },
  };
}

test("sets OMNI_RUN_DIR, creates a ledger, sets the explicit goal, and does NOT resolve on a settle", async () => {
  const runsRoot = mkdtempSync(join(tmpdir(), "runs-"));
  let gotGoal = null;
  const app = fakeApp({ onGoal: (g) => (gotGoal = g) });
  let resolved = false;
  let capturedOpts = null;
  const p = runUnattended({ cwd: process.cwd(), goal: "REVERSE IT", runsRoot, createApp: async (opts) => { capturedOpts = opts; return app; }, pollMs: 10 }).then((r) => { resolved = true; return r; });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(gotGoal, "REVERSE IT");
  assert.ok(process.env.OMNI_RUN_DIR && process.env.OMNI_RUN_DIR.includes(runsRoot.split(/[\\/]/).pop()));
  // the ledger must be handed to createApp so the supervisor engages durable-run persistence
  assert.ok(capturedOpts && capturedOpts.runLedger, "createApp must receive a runLedger");
  assert.equal(capturedOpts.runLedger.dir, process.env.OMNI_RUN_DIR, "runLedger must be this run's ledger");
  app._settle();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(resolved, false, "a settle must not end the unattended run");
  // flipping status to done ends it
  RunLedger.open(process.env.OMNI_RUN_DIR).writeControl({ status: "done" });
  const out = await p;
  assert.equal(out.status, "done");
});

test("--resume puts pi back on the run's own chat even though the fresh pi announces its new session first", async () => {
  const runsRoot = mkdtempSync(join(tmpdir(), "runs-resume-"));
  const oldChat = join(runsRoot, "old-chat.jsonl");
  writeFileSync(oldChat, "{}\n");
  const ledger = RunLedger.create({ runsRoot, goalText: "port it", sessionFile: oldChat });
  ledger.writeControl({ sessionFile: oldChat, status: "running" });
  const listeners = [];
  const bus = { on: (_e, f) => listeners.push(f), off() {}, emit(ev) { for (const f of listeners) f(ev); } };
  const fresh = join(runsRoot, "fresh-not-yet-written.jsonl"); // pi names the file at once and writes it lazily
  const switched = [];
  const pi = {
    sid: "pi:fresh", proc: {}, streaming: false, state: { sessionFile: fresh },
    // what PiRpc.refreshState() does before the ready promise resolves
    waitReady: async () => { bus.emit({ sid: "pi:fresh", harness: "pi", kind: "session", owned: true, file: fresh }); },
    switchSession: async (f) => { switched.push(f); pi.state.sessionFile = f; },
    prompt: async () => {}, setThinking: async () => {}, stop() {},
  };
  const keeper = { setExplicitGoal() {}, setConfig() {}, startHeartbeat() {}, goal: () => null, config: { enabled: true } };
  const app = { async listen() {}, close() {}, bus, keeper, startPi: () => pi, get pi() { return pi; }, cfg: {} };
  const p = runUnattended({ cwd: process.cwd(), runId: ledger.runId, runsRoot, createApp: async () => app, pollMs: 10, out: () => {} });
  await new Promise((r) => setTimeout(r, 80));
  RunLedger.open(ledger.dir).writeControl({ status: "done" });
  await p;
  assert.deepEqual(switched, [oldChat]);
});
