#!/usr/bin/env node
/**
 * Wire Omni Agent into the harnesses.
 *
 *   node scripts/install.mjs               install the pi extension + config
 *   node scripts/install.mjs --claude-hook also register the Claude Code SessionStart hook (user settings)
 *   node scripts/install.mjs --uninstall   remove both
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HOME = homedir();
const piAgent = join(HOME, ".pi", "agent");
const extDir = join(piAgent, "extensions");
const extTarget = join(extDir, "omni-memory.ts");
const piCfg = join(piAgent, "omni-agent.json");
const claudeSettings = join(HOME, ".claude", "settings.json");
const hookCmd = `node "${join(ROOT, "integrations", "claude", "session-start-hook.mjs")}"`;
const args = new Set(process.argv.slice(2));

function readJson(p, dflt) { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return dflt; } }

if (args.has("--uninstall")) {
  if (existsSync(extTarget)) { rmSync(extTarget); console.log("removed", extTarget); }
  if (existsSync(piCfg)) { rmSync(piCfg); console.log("removed", piCfg); }
  const s = readJson(claudeSettings, null);
  if (s?.hooks?.SessionStart) {
    s.hooks.SessionStart = s.hooks.SessionStart.filter((h) => !JSON.stringify(h).includes("session-start-hook.mjs"));
    if (!s.hooks.SessionStart.length) delete s.hooks.SessionStart;
    writeFileSync(claudeSettings, JSON.stringify(s, null, 2));
    console.log("removed Claude Code hook from", claudeSettings);
  }
  process.exit(0);
}

mkdirSync(extDir, { recursive: true });
copyFileSync(join(ROOT, "integrations", "pi", "omni-memory.ts"), extTarget);
const cfg = { ...readJson(piCfg, {}), root: ROOT, vault: join(ROOT, "vault"), autoRecall: true, budgetTokens: 800 };
writeFileSync(piCfg, JSON.stringify(cfg, null, 2));
console.log("pi extension installed:", extTarget);
console.log("pi config written:", piCfg);

if (args.has("--claude-hook")) {
  const s = readJson(claudeSettings, {});
  s.hooks = s.hooks || {};
  const list = (s.hooks.SessionStart = s.hooks.SessionStart || []);
  if (!list.some((h) => JSON.stringify(h).includes("session-start-hook.mjs"))) {
    list.push({ matcher: "", hooks: [{ type: "command", command: hookCmd }] });
    writeFileSync(claudeSettings, JSON.stringify(s, null, 2));
    console.log("Claude Code SessionStart hook added to", claudeSettings);
  } else console.log("Claude Code hook already present");
} else {
  console.log("Claude Code hook not installed (opt in with --claude-hook).");
}
