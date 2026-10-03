#!/usr/bin/env node
/**
 * The durable unattended runner. A standalone CLI that owns one multi-day pi run:
 * it creates (or --resume's) a run ledger, points the pi omni-run extension at it via
 * OMNI_RUN_DIR, sets the explicit goal, enables the goal keeper, and then BLOCKS until the
 * run's status becomes "done" (or it is stopped) — it never exits on a mere settle. The GUI
 * (desktop or browser) is a separate, read-only observer of the same server; it does not own
 * this process.
 *
 *   node scripts/run.mjs --cwd <dir> --goal "…" [--goal-file f] [--resume <run-id>]
 *        [--provider p] [--model id] [--thinking lvl] [--max-seconds N] [--port N]
 */
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp as realCreateApp } from "../server/index.mjs";
import { RunLedger } from "../server/run-ledger.mjs";
import { CONFIG } from "../server/config.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export async function runUnattended({ cwd, goal, provider, model, thinking, runId, runsRoot = CONFIG.runsDir, maxSeconds = 0, port = 4400, createApp = realCreateApp, pollMs = 2000, out = console.log }) {
  mkdirSync(runsRoot, { recursive: true });
  const ledger = runId ? RunLedger.open(join(runsRoot, runId)) : RunLedger.create({ runsRoot, goalText: goal || "", sessionFile: "" });
  process.env.OMNI_RUN_DIR = ledger.dir;
  ledger.writeControl({ status: "running" });
  out(`run ${ledger.runId} · ledger ${ledger.dir}`);

  const app = await createApp({ port, host: "127.0.0.1", lan: false, cwd, autoStartPi: false, runLedger: ledger, ...(provider ? { piProvider: provider } : {}), ...(model ? { piModel: model } : {}) });
  await app.listen();
  const pi = app.startPi(cwd);
  // Mirror pi's session file into the ledger so a restart resumes it.
  app.bus.on("event", (ev) => { if (ev.kind === "session" && ev.harness === "pi" && ev.owned && ev.file && !app.pi?.restoring) { ledger.writeControl({ sessionFile: ev.file }); if (app.pi) app.pi.resumeFile = ev.file; } });

  await pi.waitReady();
  if (thinking) await pi.setThinking(thinking).catch(() => {});
  const goalText = ledger.goalText() || goal || "";
  if (goalText) {
    app.keeper.setExplicitGoal(pi.sid, goalText);
    app.keeper.setConfig({ ...app.keeper.config, enabled: true });
    app.keeper.startHeartbeat?.();
    if (!runId) await pi.prompt(goalText); // first launch kicks off the work; a resume relies on the heartbeat
  }

  const started = Date.now();
  return await new Promise((resolveRun) => {
    const timer = setInterval(() => {
      const ctrl = ledger.readControl();
      if (ctrl.status === "done" || ctrl.status === "stopped") { clearInterval(timer); app.close(); resolveRun({ runId: ledger.runId, status: ctrl.status }); return; }
      if (maxSeconds > 0 && Date.now() - started > maxSeconds * 1000) { clearInterval(timer); ledger.writeControl({ status: "stopped" }); app.close(); resolveRun({ runId: ledger.runId, status: "stopped" }); }
    }, pollMs);
    timer.unref?.();
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d; };
  const goalFile = arg("--goal-file");
  const goal = goalFile ? readFileSync(goalFile, "utf8") : arg("--goal", "");
  const runId = arg("--resume");
  if (!runId && !goal.trim()) { console.error("usage: node scripts/run.mjs --cwd <dir> --goal \"…\" | --goal-file f | --resume <run-id> [--provider p] [--model id] [--thinking lvl] [--max-seconds N]"); process.exit(1); }
  process.on("uncaughtException", (e) => console.error("uncaughtException", e?.stack || e));
  process.on("unhandledRejection", (e) => console.error("unhandledRejection", e?.stack || e));
  const r = await runUnattended({ cwd: resolve(arg("--cwd", process.cwd())), goal, runId, provider: arg("--provider"), model: arg("--model"), thinking: arg("--thinking"), maxSeconds: Number(arg("--max-seconds", 0)), port: Number(arg("--port", 4400)) });
  console.log(`run ${r.runId} ended: ${r.status}`);
  process.exit(0);
}
