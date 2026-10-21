#!/usr/bin/env node
/**
 * Wire Omni Agent into the harnesses.
 *
 *   node scripts/install.mjs                 install the pi extensions (memory tools, the planner, claude_task, background
 *                                            agents + jobs, context guidance, graph tools, model fallback, omnidroid's MCP
 *                                            tools, any MCP server in mcpServers), the omnidroid skills
 *                                            (skills/ -> ~/.pi/agent/skills/) + config
 *   node scripts/install.mjs --claude-hook   also register the Claude Code SessionStart hook (user settings)
 *   node scripts/install.mjs --claude-skills also copy the skills to ~/.claude/skills/ (Claude Code)
 *   node scripts/install.mjs --claude-mcp    also register the omnidroid app's MCP server with Claude Code (user
 *                                            scope, HTTP: the app serves it once `mcp on` is set in it)
 *   node scripts/install.mjs --openrouter    also wire OpenRouter into pi from openrouter.txt (auth.json +
 *                                            a models.json provider on https://openrouter.ai/api/v1)
 *   node scripts/install.mjs --uninstall     remove everything this script installed
 *
 * OMNI_HOME overrides the home directory (tests). OMNI_OMNIDROID names the omnidroid checkout whose
 * target/release/omni-mcp pi runs as the bridge to the app (default: the sibling ../omnidroid).
 * OMNI_APP_MCP_URL is the app's MCP server (default http://127.0.0.1:7457/mcp). OMNI_CLAUDE_BIN names
 * the claude CLI for --claude-mcp.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HOME = process.env.OMNI_HOME || homedir();
const piAgent = join(HOME, ".pi", "agent");
const extDir = join(piAgent, "extensions");
const EXTENSIONS = ["omni-memory.ts", "omni-claude.ts", "omni-graph.ts", "omni-fallback.ts", "omni-fallback-lib.mjs", "omni-mcp.ts", "omni-mcp-lib.mjs", "omni-mcp-servers.ts", "omni-run.ts", "omni-run-lib.mjs", "omni-plan.ts", "omni-plan-lib.mjs",
  // Background agents/jobs (omni-agents.ts) and claude_task (omni-claude.ts) share omni-agents-lib.mjs.
  "omni-agents.ts", "omni-agents-lib.mjs", "omni-context.ts", "omni-context-lib.mjs"];
/** Extension files whose installed copy comes from elsewhere in the repo (the planner's state machine is shared with the server and UI). */
const EXT_SOURCE = { "omni-plan-lib.mjs": join("ui", "plan.js") };
const SKILLS = ["omnidroid", "omnidroid-frida", "omnidroid-qemu", "omnidroid-input"];
const AGENTS = ["scout.md", "re-analyst.md", "droid-operator.md"];
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
const omnidroidDir = process.env.OMNI_OMNIDROID || join(dirname(ROOT), "omnidroid");
const omniMcpBin = join(omnidroidDir, "target", "release", process.platform === "win32" ? "omni-mcp.exe" : "omni-mcp");
const claudeBin = process.env.OMNI_CLAUDE_BIN || "claude";
// The omnidroid app serves MCP over HTTP on this computer (`mcp on` in the app): every agent drives
// the same pool of warm Androids through it.
const appMcpUrl = process.env.OMNI_APP_MCP_URL || "http://127.0.0.1:7457/mcp";
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

/** The omni-mcp pi extension's block of omni-agent.json: keep what the owner set, point `command` at the
 *  built omni-mcp unless the one configured still exists, and make it the bridge to the omnidroid app's
 *  MCP server (`omni-mcp --connect <url>`) unless the owner gave it other arguments. */
function omniMcpConfig(prev = {}) {
  const keep = prev.command && existsSync(prev.command);
  const dyn = process.env.OMNIDROID_DYNARMIC_BUILD_DIR;
  const env = { ...(dyn ? { OMNIDROID_DYNARMIC_BUILD_DIR: dyn } : {}), ...(prev.env || {}) };
  const args = prev.args && prev.args.length ? prev.args : ["--connect", appMcpUrl];
  return { ...prev, ...(Object.keys(env).length ? { env } : {}), command: keep ? prev.command : omniMcpBin, args };
}

/** Claude Code gets the omnidroid app's server as `omnidroid` (tools mcp__omnidroid__*), over HTTP. */
function claudeMcp(add, mcp) {
  const run = (...a) => {
    // A .js/.mjs launcher runs under node; a Windows .cmd shim only runs through the shell, which needs
    // its arguments quoted by hand (paths here have spaces: "Omni Apps").
    if (/\.m?js$/i.test(claudeBin)) return spawnSync(process.execPath, [claudeBin, ...a], { encoding: "utf8" });
    const r = spawnSync(claudeBin, a, { encoding: "utf8" });
    if (!r.error || process.platform !== "win32") return r;
    const q = (x) => (/[\s"&|<>^()]/.test(x) ? `"${x.replace(/"/g, '\\"')}"` : x);
    return spawnSync([claudeBin, ...a].map(q).join(" "), { encoding: "utf8", shell: true });
  };
  run("mcp", "remove", "--scope", "user", "omnidroid");
  if (!add) { console.log("removed omnidroid MCP server from Claude Code"); return; }
  const r = run("mcp", "add", "--transport", "http", "--scope", "user", "omnidroid", appMcpUrl);
  if (r.status !== 0) { console.error(`--claude-mcp: \`${claudeBin} mcp add\` failed: ${(r.stderr || r.stdout || r.error?.message || "").trim()}`); process.exit(1); }
  console.log(`Claude Code MCP server added: omnidroid -> ${appMcpUrl} (the omnidroid app serves it once \`mcp on\` is set there)`);
}

if (args.has("--uninstall")) {
  for (const f of EXTENSIONS) { const t = join(extDir, f); if (existsSync(t)) { rmSync(t); console.log("removed", t); } }
  { const t = join(extDir, "subagent"); if (existsSync(t)) { rmSync(t, { recursive: true }); console.log("removed", t); } }
  // The default agents (agents/*.md) are left in place: they may be user-edited.
  for (const s of SKILLS) for (const dir of [piSkillsDir, ...(args.has("--claude-skills") ? [claudeSkillsDir] : [])]) { const t = join(dir, s); if (existsSync(t)) { rmSync(t, { recursive: true }); console.log("removed", t); } }
  if (existsSync(piCfg)) {
    // The owner's own MCP servers are theirs, not ours: keep that block, drop the rest.
    const servers = readJson(piCfg, {}).mcpServers;
    if (servers && Object.keys(servers).length) { writeFileSync(piCfg, JSON.stringify({ mcpServers: servers }, null, 2)); console.log("kept mcpServers in", piCfg); }
    else { rmSync(piCfg); console.log("removed", piCfg); }
  }
  if (args.has("--claude-mcp")) claudeMcp(false);
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
for (const f of EXTENSIONS) copyFileSync(join(ROOT, EXT_SOURCE[f] || join("integrations", "pi", f)), join(extDir, f));
// The subagent extension ships whole; its default agent definitions seed agents/ only when absent (never clobber a user's edits).
const subagentDir = join(extDir, "subagent");
cpSync(join(ROOT, "integrations", "pi", "subagent"), subagentDir, { recursive: true });
console.log("pi subagent extension installed:", subagentDir);
const agentsSrc = join(ROOT, "integrations", "pi", "agents");
const agentsDir = join(piAgent, "agents");
mkdirSync(agentsDir, { recursive: true });
for (const f of AGENTS) {
  const t = join(agentsDir, f);
  if (existsSync(t)) { console.log("agent kept (not overwritten):", t); continue; }
  copyFileSync(join(agentsSrc, f), t);
  console.log("agent installed:", t);
}
const omniCfg = readJson(join(ROOT, "omni.config.json"), {});
const prevCfg = readJson(piCfg, {});
const cfg = { ...prevCfg, root: ROOT, vault: join(ROOT, "vault"), autoRecall: true, budgetTokens: 800, port: Number(omniCfg.port) || 4400, omniMcp: omniMcpConfig(prevCfg.omniMcp) };
writeFileSync(piCfg, JSON.stringify(cfg, null, 2));
console.log("pi extensions installed:", EXTENSIONS.map((f) => join(extDir, f)).join(", "));
console.log("pi config written:", piCfg);
if (!existsSync(cfg.omniMcp.command)) console.log(`omni-mcp not built yet (${cfg.omniMcp.command}): in ${omnidroidDir} run \`cargo build --release -p omni-mcp\`; the omnidroid_* tools appear once it exists.`);
installSkills(piSkillsDir);
if (args.has("--claude-skills")) installSkills(claudeSkillsDir);
if (args.has("--openrouter")) installOpenRouter();
if (args.has("--claude-mcp")) claudeMcp(true, cfg.omniMcp);

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

console.log("RE tools (jadx/apktool/baksmali/smali, CLI-only, on the pi PATH): run `node scripts/install-tools.mjs` once.");
