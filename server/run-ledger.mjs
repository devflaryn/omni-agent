/**
 * The run ledger: one directory per unattended run, under the vault, holding the
 * durable control state (run.json), the human-readable progress ledger (ledger.md),
 * a bounded event log (events.jsonl) and offloaded artifacts. Both the supervisor and
 * the pi omni-run extension read/write it; it is the single source of truth and the
 * resume anchor. Supervisor owns run.json; the extension owns ledger.md + artifacts/.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const atomicWrite = (file, text) => { const tmp = `${file}.tmp`; writeFileSync(tmp, text); renameSync(tmp, file); };
const readJson = (file) => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return {}; } };

function newRunId() {
  const d = new Date();
  const stamp = d.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `${stamp}_${Math.random().toString(36).slice(2, 8)}`;
}

const INITIAL_LEDGER = (goal) => `# Run ledger

## Goal
${goal}

## Constraints

## Milestones
### Done
### In progress
### Blocked

## Decisions

## Next steps

## Critical facts
`;

export class RunLedger {
  constructor({ dir }) {
    this.dir = dir;
    this.runId = dir.split(/[\\/]/).pop();
    this.controlFile = join(dir, "run.json");
    this.ledgerFile = join(dir, "ledger.md");
    this.eventsFile = join(dir, "events.jsonl");
    this.artifactsDir = join(dir, "artifacts");
  }

  static create({ runsRoot, goalText = "", sessionFile = "" }) {
    const dir = join(runsRoot, newRunId());
    mkdirSync(join(dir, "artifacts"), { recursive: true });
    const l = new RunLedger({ dir });
    const now = Date.now();
    atomicWrite(l.controlFile, JSON.stringify({
      runId: l.runId, goalText, sessionFile, status: "running",
      createdAt: now, updatedAt: now,
      counters: { restarts: 0, nudges: 0, compactions: 0, judgeFailures: 0 },
      model: { active: "", fallbackIndex: 0 },
    }, null, 2));
    atomicWrite(l.ledgerFile, INITIAL_LEDGER(goalText || "(no goal set)"));
    return l;
  }

  static open(dir) {
    if (!existsSync(join(dir, "run.json"))) throw new Error(`no run ledger at ${dir}`);
    return new RunLedger({ dir });
  }

  readControl() { return readJson(this.controlFile); }

  writeControl(patch = {}) {
    const prev = this.readControl();
    const next = { ...prev, ...patch, updatedAt: Date.now() };
    if (patch.counters) next.counters = { ...(prev.counters || {}), ...patch.counters };
    if (patch.model) next.model = { ...(prev.model || {}), ...patch.model };
    atomicWrite(this.controlFile, JSON.stringify(next, null, 2));
    return next;
  }

  goalText() { return this.readControl().goalText || ""; }
  readLedgerMd() { try { return readFileSync(this.ledgerFile, "utf8"); } catch { return ""; } }
  writeLedgerMd(text) { atomicWrite(this.ledgerFile, String(text)); }

  appendEvent(obj) {
    try {
      if (existsSync(this.eventsFile) && statSync(this.eventsFile).size > 5 * 1024 * 1024) {
        renameSync(this.eventsFile, `${this.eventsFile}.1`);
      }
    } catch { /* ignore rotate race */ }
    try { writeFileSync(this.eventsFile, `${JSON.stringify({ ts: Date.now(), ...obj })}\n`, { flag: "a" }); } catch { /* never fatal */ }
  }
}
