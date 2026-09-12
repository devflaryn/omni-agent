#!/usr/bin/env node
/**
 * Wire Omni Agent into the harnesses.
 *
 *   node scripts/install.mjs                 install the pi extensions (memory tools + claude_task), the
 *                                            omnidroid skills (skills/ -> ~/.pi/agent/skills/) + config
 *   node scripts/install.mjs --claude-hook   also register the Claude Code SessionStart hook (user settings)
 *   node scripts/install.mjs --claude-skills also copy the skills to ~/.claude/skills/ (Claude Code)
 *   node scripts/install.mjs --openrouter    also wire OpenRouter into pi from openrouter.txt (auth.json +
 *                                            a models.json provider on https://openrouter.ai/api/v1)
 *   node scripts/install.mjs --uninstall     remove everything this script installed
 *
 * OMNI_HOME overrides the home directory (tests).
 */
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HOME = process.env.OMNI_HOME || homedir();
const piAgent = join(HOME, ".pi", "agent");
const extDir = join(piAgent, "extensions");
const EXTENSIONS = ["omni-memory.ts", "omni-claude.ts", "omni-graph.ts"];
const SKILLS = ["omnidroid", "omnidroid-input"];
const piSkillsDir = join(piAgent, "skills");
const claudeSkillsDir = join(HOME, ".claude", "skills");
const piCfg = join(piAgent, "omni-agent.json");
const claudeSettings = join(HOME, ".claude", "settings.json");
const keyFile = process.env.OMNI_OPENROUTER_KEY_FILE || join(ROOT, "openrouter.txt");
/** The test/driver model while the local Qwen (modal) is down: text-only, 1.3M context, tools. Slug verified on openrouter.ai/models 2026-09-12. */
export const OPENROUTER = {
  baseUrl: "https://openrouter.ai/api/v1",
  api: "openai-completions",
  models: [{
    id: "deepseek/deepseek-v4-flash-0731",
    name: "DeepSeek V4 Flash 0731 (OpenRouter)",
    reasoning: true,
    input: ["text"],
    contextWindow: 1310720,
    maxTokens: 65536,
    cost: { input: 0.04, output: 0.08, cacheRead: 0, cacheWrite: 0 },
  }],
};
const hookCmd = `node "${join(ROOT, "integrations", "claude", "session-start-hook.mjs")}"`;
const args = new Set(process.argv.slice(2));

function readJson(p, dflt) { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return dflt; } }

function installSkills(dir) {
  for (const s of SKILLS) { const t = join(dir, s); cpSync(join(ROOT, "skills", s), t, { recursive: true }); console.log("skill installed:", t); }
}

/** OpenRouter as pi's "other" OpenAI-compatible provider: the key goes to auth.json (0600) and
 *  models.json pins the base URL + the DeepSeek model. Both files are merged, never replaced. */
function installOpenRouter() {
  const key = existsSync(keyFile) ? readFileSync(keyFile, "utf8").split(/\r?\n/)[0].trim() : "";
  if (!key) { console.error(`--openrouter: no key in ${keyFile} (one line, the OpenRouter API key; gitignored)`); process.exit(1); }
  const authPath = join(piAgent, "auth.json");
  const auth = readJson(authPath, {});
  auth.openrouter = { type: "api_key", key };
  writeFileSync(authPath, JSON.stringify(auth, null, 2));
  try { chmodSync(authPath, 0o600); } catch { /* windows */ }
  const modelsPath = join(piAgent, "models.json");
  const models = readJson(modelsPath, {});
  models.providers = models.providers || {};
  const prev = models.providers.openrouter || {};
  const byId = new Map((prev.models || []).map((m) => [m.id, m]));
  for (const m of OPENROUTER.models) byId.set(m.id, m);
  models.providers.openrouter = { ...prev, baseUrl: OPENROUTER.baseUrl, api: OPENROUTER.api, apiKey: key, models: [...byId.values()] };
  writeFileSync(modelsPath, JSON.stringify(models, null, 2));
  console.log(`OpenRouter wired for pi: ${authPath} (openrouter key), ${modelsPath} (${OPENROUTER.baseUrl}, ${OPENROUTER.models.map((m) => m.id).join(", ")})`);
}

if (args.has("--uninstall")) {
  for (const f of EXTENSIONS) { const t = join(extDir, f); if (existsSync(t)) { rmSync(t); console.log("removed", t); } }
  for (const s of SKILLS) for (const dir of [piSkillsDir, ...(args.has("--claude-skills") ? [claudeSkillsDir] : [])]) { const t = join(dir, s); if (existsSync(t)) { rmSync(t, { recursive: true }); console.log("removed", t); } }
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
for (const f of EXTENSIONS) copyFileSync(join(ROOT, "integrations", "pi", f), join(extDir, f));
const omniCfg = readJson(join(ROOT, "omni.config.json"), {});
const cfg = { ...readJson(piCfg, {}), root: ROOT, vault: join(ROOT, "vault"), autoRecall: true, budgetTokens: 800, port: Number(omniCfg.port) || 4400 };
writeFileSync(piCfg, JSON.stringify(cfg, null, 2));
console.log("pi extensions installed:", EXTENSIONS.map((f) => join(extDir, f)).join(", "));
console.log("pi config written:", piCfg);
installSkills(piSkillsDir);
if (args.has("--claude-skills")) installSkills(claudeSkillsDir);
if (args.has("--openrouter")) installOpenRouter();

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
