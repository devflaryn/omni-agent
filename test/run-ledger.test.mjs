// test/run-ledger.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunLedger } from "../server/run-ledger.mjs";

function tmp() { return mkdtempSync(join(tmpdir(), "omni-run-")); }

test("create writes run.json and ledger.md with the verbatim goal", () => {
  const root = tmp();
  const l = RunLedger.create({ runsRoot: root, goalText: "Reverse the lib", sessionFile: "/x/s.jsonl" });
  assert.ok(existsSync(l.controlFile));
  const ctrl = l.readControl();
  assert.equal(ctrl.goalText, "Reverse the lib");
  assert.equal(ctrl.sessionFile, "/x/s.jsonl");
  assert.equal(ctrl.status, "running");
  assert.ok(l.readLedgerMd().includes("Reverse the lib"));
});

test("writeControl merges and persists; open re-reads", () => {
  const root = tmp();
  const l = RunLedger.create({ runsRoot: root, goalText: "g", sessionFile: "a" });
  l.writeControl({ sessionFile: "b", counters: { restarts: 2 } });
  const again = RunLedger.open(l.dir);
  assert.equal(again.readControl().sessionFile, "b");
  assert.equal(again.readControl().counters.restarts, 2);
  assert.equal(again.readControl().goalText, "g"); // merge kept it
});

test("corrupt run.json reads as empty object, never throws", () => {
  const root = tmp();
  const l = RunLedger.create({ runsRoot: root, goalText: "g", sessionFile: "a" });
  writeFileSync(l.controlFile, "{ this is not json");
  assert.deepEqual(l.readControl(), {});
  // and writeControl recovers by overwriting
  l.writeControl({ status: "running" });
  assert.equal(l.readControl().status, "running");
});

test("appendEvent appends JSONL and rotates past 5MB", () => {
  const root = tmp();
  const l = RunLedger.create({ runsRoot: root, goalText: "g", sessionFile: "a" });
  l.appendEvent({ kind: "checkpoint", n: 1 });
  const lines = readFileSync(l.eventsFile, "utf8").trim().split("\n");
  assert.equal(JSON.parse(lines.at(-1)).n, 1);
  writeFileSync(l.eventsFile, "x".repeat(5 * 1024 * 1024 + 10));
  l.appendEvent({ kind: "checkpoint", n: 2 });
  assert.ok(existsSync(l.eventsFile + ".1"));
  assert.ok(statSync(l.eventsFile).size < 5 * 1024 * 1024);
});
