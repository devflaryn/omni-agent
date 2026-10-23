#!/usr/bin/env node
/**
 * Wire Omni Agent into the harnesses.
 *
 *   node scripts/install.mjs                 check that `opencode` is installed, copy the skills (skills/ ->
 *                                            <opencode config dir>/skills/) and write omni-agent.json (the omnidroid
 *                                            bridge; your mcpServers are kept). The server writes opencode.json and the
 *                                            plugin shim itself; personas are read from the repo.
 *   node scripts/install.mjs --claude-hook   also register the Claude Code SessionStart hook (user settings)
 *   node scripts/install.mjs --claude-skills also copy the omnidroid skill to ~/.claude/skills/ (Claude Code); the
 *                                            other skills are for OpenCode only
 *   node scripts/install.mjs --claude-mcp    also register the omnidroid app's MCP server with Claude Code (user
 *                                            scope, HTTP: the app serves it once `mcp on` is set in it)
 *   node scripts/install.mjs --uninstall     remove everything this script installed (and what the older pi install left)
 *
 * (--openrouter is gone: add OpenRouter or any other provider and its key in the Providers dialog.)
 *
 * OMNI_HOME overrides the home directory (tests). OMNI_OMNIDROID names the omnidroid checkout whose
 * target/release/omni-mcp OpenCode runs as the bridge to the app (default: the sibling ../omnidroid).
 * OMNI_APP_MCP_URL is the app's MCP server (default http://127.0.0.1:7457/mcp). OMNI_CLAUDE_BIN names
 * the claude CLI for --claude-mcp. OMNI_OPENCODE_BIN (or opencodeBin in omni.config.json) names the opencode launcher.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HOME = process.env.OMNI_HOME || homedir();
const piAgent = join(HOME, ".pi", "agent");
/** What the pi harness installed here: pi never loads it now, so only uninstall still knows it (and removes it). */
const LEGACY_EXTENSIONS = ["omni-memory.ts", "omni-claude.ts", "omni-graph.ts", "omni-fallback.ts", "omni-fallback-lib.mjs", "omni-mcp.ts", "omni-mcp-lib.mjs", "omni-mcp-servers.ts", "omni-run.ts", "omni-run-lib.mjs", "omni-plan.ts", "omni-plan-lib.mjs", "omni-agents.ts", "omni-agents-lib.mjs", "omni-context.ts", "omni-context-lib.mjs"];
const SKILLS = ["omnidroid", "omnidroid-frida", "omnidroid-qemu", "omnidroid-input", "subagent-driven-implementation"];
/** The skills Claude Code gets too (--claude-skills); the rest are for OpenCode only. */
const CLAUDE_SKILLS = ["omnidroid"];
const omniCfg = readJson(join(ROOT, "omni.config.json"), {});
// OpenCode reads skills from <config dir>/skills/ (verified on 1.18 with GET /skill); the server sets OPENCODE_CONFIG_DIR to this.
const opencodeDir = omniCfg.opencodeConfigDir || join(HOME, ".omni-agent", "opencode");
const opencodeSkillsDir = join(opencodeDir, "skills");
const opencodeBin = process.env.OMNI_OPENCODE_BIN || omniCfg.opencodeBin || "opencode";
const claudeSkillsDir = join(HOME, ".claude", "skills");
/** The file the server reads omniMcp and mcpServers from (cfg.piExtConfigFile) and renders into opencode.json. */
const piCfg = join(piAgent, "omni-agent.json");
const claudeSettings = join(HOME, ".claude", "settings.json");
const omnidroidDir = process.env.OMNI_OMNIDROID || join(dirname(ROOT), "omnidroid");
const omniMcpBin = join(omnidroidDir, "target", "release", process.platform === "win32" ? "omni-mcp.exe" : "omni-mcp");
const claudeBin = process.env.OMNI_CLAUDE_BIN || "claude";
// The omnidroid app serves MCP over HTTP on this computer (`mcp on` in the app): every agent drives
// the same pool of warm Androids through it.
const appMcpUrl = process.env.OMNI_APP_MCP_URL || "http://127.0.0.1:7457/mcp";
const hookCmd = `node "${join(ROOT, "integrations", "claude", "session-start-hook.mjs")}"`;
const args = new Set(process.argv.slice(2));

function readJson(p, dflt) { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return dflt; } }


function installSkills(dir, skills = SKILLS) {
  for (const s of skills) { const t = join(dir, s); cpSync(join(ROOT, "skills", s), t, { recursive: true }); console.log("skill installed:", t); }
}

/** The omniMcp block of omni-agent.json (the server renders it into opencode.json as an MCP server): keep what the owner set, point `command` at the
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

/** Runs a launcher (a .js/.mjs one under node, a Windows .cmd shim through the shell). */
function probe(bin, a) {
  if (/\.m?js$/i.test(bin)) return spawnSync(process.execPath, [bin, ...a], { encoding: "utf8" });
  let r = spawnSync(bin, a, { encoding: "utf8" });
  if (r.error && process.platform === "win32") {
    const q = (x) => (/[\s"&|<>^()]/.test(x) ? `"${x.replace(/"/g, '\\"')}"` : x);
    r = spawnSync([bin, ...a].map(q).join(" "), { encoding: "utf8", shell: true });
  }
  return r;
}

if (args.has("--openrouter")) {
  console.error("--openrouter is gone: add OpenRouter (or any provider) and its key in the Providers dialog (gear icon in Omni). Nothing was installed.");
  process.exit(1);
}

if (args.has("--uninstall")) {
  for (const s of SKILLS) for (const dir of [opencodeSkillsDir, join(piAgent, "skills"), ...(args.has("--claude-skills") ? [claudeSkillsDir] : [])]) { const t = join(dir, s); if (existsSync(t)) { rmSync(t, { recursive: true }); console.log("removed", t); } }
  // What the pi harness left in ~/.pi/agent/extensions. Agents (agents/*.md) stay: they may be user-edited.
  for (const f of LEGACY_EXTENSIONS) { const t = join(piAgent, "extensions", f); if (existsSync(t)) { rmSync(t); console.log("removed", t); } }
  { const t = join(piAgent, "extensions", "subagent"); if (existsSync(t)) { rmSync(t, { recursive: true }); console.log("removed", t); } }
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

mkdirSync(opencodeDir, { recursive: true });
const oc = probe(opencodeBin, ["--version"]);
if (oc.status === 0) console.log(`opencode ${(oc.stdout || "").trim().split(/\r?\n/)[0]} found (${opencodeBin})`);
else console.log(`opencode not found (${opencodeBin}): install it with \`npm i -g opencode-ai\` (or set opencodeBin in omni.config.json); Omni starts it itself.`);
const prevCfg = readJson(piCfg, {});
// Only omniMcp is Omni's to write; mcpServers (the MCP dialog) and anything else already there stay as they are.
const cfg = { ...prevCfg, omniMcp: omniMcpConfig(prevCfg.omniMcp) };
mkdirSync(piAgent, { recursive: true });
writeFileSync(piCfg, JSON.stringify(cfg, null, 2));
console.log("config written:", piCfg);
if (!existsSync(cfg.omniMcp.command)) console.log(`omni-mcp not built yet (${cfg.omniMcp.command}): in ${omnidroidDir} run \`cargo build --release -p omni-mcp\`; the omnidroid_* tools appear once it exists.`);
installSkills(opencodeSkillsDir);
if (args.has("--claude-skills")) installSkills(claudeSkillsDir, CLAUDE_SKILLS);
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

console.log("RE tools (jadx/apktool/baksmali/smali, CLI-only, on the PATH of OpenCode's shell): run `node scripts/install-tools.mjs` once.");
