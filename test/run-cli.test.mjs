// test/run-cli.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
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
  const p = runUnattended({ cwd: process.cwd(), goal: "REVERSE IT", runsRoot, createApp: async () => app, pollMs: 10 }).then((r) => { resolved = true; return r; });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(gotGoal, "REVERSE IT");
  assert.ok(process.env.OMNI_RUN_DIR && process.env.OMNI_RUN_DIR.includes(runsRoot.split(/[\\/]/).pop()));
  app._settle();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(resolved, false, "a settle must not end the unattended run");
  // flipping status to done ends it
  RunLedger.open(process.env.OMNI_RUN_DIR).writeControl({ status: "done" });
  const out = await p;
  assert.equal(out.status, "done");
});
