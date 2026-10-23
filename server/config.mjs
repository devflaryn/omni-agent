import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const HOME = homedir();
export const CONFIG_FILE = join(ROOT, "omni.config.json");

/** { ENV_NAME: "/path/to/key.txt" } → { ENV_NAME: "<first line>" } for the files that exist. */
export function apiKeyEnv(files) {
  const out = {};
  for (const [name, file] of Object.entries(files || {})) {
    try { const v = readFileSync(file, "utf8").split(/\r?\n/)[0].trim(); if (v) out[name] = v; } catch { /* absent: the provider stays unconfigured */ }
  }
  return out;
}

function argVal(name, dflt) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

export function readConfigFile() {
  if (!existsSync(CONFIG_FILE)) return {};
  try { return JSON.parse(readFileSync(CONFIG_FILE, "utf8")); } catch { return {}; }
}

export function writeConfigFile(patch) {
  const next = { ...readConfigFile(), ...patch };
  writeFileSync(CONFIG_FILE, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

/** LAN IPv4 addresses (skips loopback, link-local and virtual-switch ranges). */
export function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== "IPv4" || a.internal) continue;
      if (a.address.startsWith("169.254.")) continue;
      // Virtual switches, and VPN clients whose address no other device can reach (Cloudflare WARP).
      if (/vmware|vmnet|vethernet|wsl|hyper-v|virtualbox|docker|cloudflare|warp/i.test(name)) continue;
      out.push({ name, address: a.address });
    }
  }
  return out;
}

const fc = readConfigFile();
/** `--lan`/`--remote` (or {"lan":true}/{"remote":true}) also serves other devices — on the LAN or, with a port
 *  forward, the internet — from a second, password-protected, read-only listener (see server/access.mjs). */
const lan = process.argv.includes("--lan") || process.argv.includes("--remote") || fc.lan === true || fc.remote === true;

export const CONFIG = {
  port: Number(argVal("--port", process.env.OMNI_PORT || fc.port || 4400)),
  /** The host's own listener: loopback only, full access, no login. */
  host: "127.0.0.1",
  lan,
  /** The listener other devices use (every interface). Forward this port on the router to reach it from another network. */
  remotePort: Number(argVal("--remote-port", process.env.OMNI_REMOTE_PORT || fc.remotePort || 4443)),
  /** HTTPS on the remote listener (a self-signed certificate is made once unless tlsCert/tlsKey are given). */
  remoteTls: fc.remoteTls !== false,
  tlsCert: fc.tlsCert || "",
  tlsKey: fc.tlsKey || "",
  tlsDir: fc.tlsDir || join(HOME, ".omni-agent", "tls"),
  /** The remote password's scrypt hash. Outside the repo on purpose. */
  remoteAuthFile: fc.remoteAuthFile || join(HOME, ".omni-agent", "remote-auth.json"),
  /** How long a remote change waits for the host's Approve/Deny before it is refused. */
  remoteApprovalTimeoutSec: Number(fc.remoteApprovalTimeoutSec) || 300,
  remoteSessionDays: Number(fc.remoteSessionDays) || 7,
  /** A browser on a device the host has not approved before must wait for the host's Approve to sign in,
   *  even with the right password. Each approved device is remembered (180 days). */
  remoteDeviceApproval: fc.remoteDeviceApproval !== false,
  /** The internet way in without a router port forward: an SSH tunnel to a VPS (server/tunnel.mjs). Off until relay.host is set. */
  relay: relayConfig(fc.relay),
  vaultDir: process.env.OMNI_VAULT || fc.vaultDir || join(ROOT, "vault"),
  /** Deleted chats are moved here (recoverable), never hard-unlinked. */
  trashDir: fc.trashDir || join(HOME, ".omni-agent", "trash"),
  piSessionsDir: fc.piSessionsDir || join(HOME, ".pi", "agent", "sessions"),
  claudeProjectsDir: fc.claudeProjectsDir || join(HOME, ".claude", "projects"),
  /** pi's config folder; its `models.json` holds pi's providers (copied once into opencodeProvidersFile). */
  piAgentDir: fc.piAgentDir || join(HOME, ".pi", "agent"),
  piModelsFile: fc.piModelsFile || join(fc.piAgentDir || join(HOME, ".pi", "agent"), "models.json"),
  /** The `opencode` launcher: Omni runs one `opencode serve` that every chat and background agent shares. */
  opencodeBin: fc.opencodeBin || "opencode",
  /** Omni's own OpenCode config dir (`OPENCODE_CONFIG_DIR`): opencode.json written by Omni, layered over the user's global config. */
  opencodeConfigDir: fc.opencodeConfigDir || join(HOME, ".omni-agent", "opencode"),
  /**
   * Omni's custom providers (BYOK) for OpenCode — what the Providers dialog edits — rendered into opencode.json's
   * `provider` block. Its first start copies pi's models.json providers here once (the marker file sits beside it).
   */
  opencodeProvidersFile: fc.opencodeProvidersFile || join(HOME, ".omni-agent", "opencode-providers.json"),
  /** The chats' pi-format mirror files; empty = `<piSessionsDir>/opencode` (createApp fills it in). */
  opencodeMirrorDir: fc.opencodeMirrorDir || "",
  /** Background-agent personas (`<name>.md`: frontmatter + system prompt), kept out of OpenCode's config dir. */
  personasDir: fc.personasDir || join(ROOT, "integrations", "pi", "agents"),
  /**
   * pi's Omni extension config; its `mcpServers` block is what the Providers dialog's MCP servers tab edits (rendered
   * into opencode.json's `mcp`); scripts/install.mjs writes omnidroid's `omniMcp` there.
   */
  piExtConfigFile: fc.piExtConfigFile || join(fc.piAgentDir || join(HOME, ".pi", "agent"), "omni-agent.json"),
  /** Key files handed to Omni's `opencode serve` as environment variables (one line each, gitignored). */
  apiKeyFiles: { OPENROUTER_API_KEY: join(ROOT, "openrouter.txt"), ...(fc.apiKeyFiles || {}) },
  /** Guest resolution (WxH[@DPI]) exported as OMNI_DISPLAY to Omni's `opencode serve`, so any omnidroid
   *  the model launches boots at a higher default resolution. Empty string / "native" = off. */
  emulatorDisplay: fc.emulatorDisplay ?? "1600x1000",
  claudeBin: process.env.OMNI_CLAUDE_BIN || fc.claudeBin || "claude",
  graphifyBin: fc.graphifyBin || "graphify",
  cwd: argVal("--cwd", process.env.OMNI_CWD || fc.cwd || join(HOME, "Desktop")),
  piModel: argVal("--model", fc.piModel || ""),
  piProvider: argVal("--provider", fc.piProvider || ""),
  /** Thinking level a new chat starts with (off|minimal|low|medium|high); "" = the model's own default. The picker persists it. */
  piThinking: argVal("--thinking", fc.piThinking || ""),
  /** Model picker allowlist, "provider/id" patterns with `*` (e.g. ["orca/*"]). Unset → every model OpenCode offers. */
  piModels: Array.isArray(fc.piModels) ? fc.piModels : null,
  /** Longest a `POST /api/claude/task` (chat → Claude delegation) waits before returning what it has. */
  claudeTaskTimeoutSec: fc.claudeTaskTimeoutSec || 900,
  /** Open a chat on OpenCode at boot. `--no-pi` or {"autoStartPi":false} disables it. */
  autoStartPi: !process.argv.includes("--no-pi") && fc.autoStartPi !== false,
  /** Seconds of quiet after which a session digest is written to the vault. */
  digestIdleSec: fc.digestIdleSec || 90,
  /** Only tail session files touched within this many hours at boot. */
  tailRecentHours: fc.tailRecentHours || 72,
  memoryBudgetTokens: fc.memoryBudgetTokens || 1200,
  graphBudgetTokens: fc.graphBudgetTokens || 900,
  /** A non-owned session file touched within this window counts as "still open in a terminal" → fork instead of resume. */
  liveWindowMs: fc.liveWindowMs || 30000,
  /** Goal hook: when an Omni chat stops before its plan is finished, it is re-engaged (see server/hook.mjs). */
  hook: hookConfig(fc.hook),
  /** Watchdog: a chat claims to be streaming but produced no event for this long → abort and reattach
   *  (server/opencode-rpc.mjs). Long enough for the provider's own HTTP retries to run first. */
  stallMs: Number(fc.stallMs) || 900000,
  /** A tool that runs this long without any event is still not a stall (builds, device boots, waits);
   *  the watchdog uses this limit instead of `stallMs` while a tool call is open. */
  toolStallMs: Number(fc.toolStallMs) || 4 * 3600000,
  /** Context policy for long runs (compaction point, auto-continue after a "my context is full" stop). */
  context: contextConfig(fc.context),
  /** Background agents (OpenCode agents, Claude Code sessions, shell jobs) the agents start: registry + logs. */
  agents: agentsConfig(fc.agents),
  agentsFile: fc.agentsFile || join(HOME, ".omni-agent", "agents.json"),
  agentsDir: fc.agentsDir || join(HOME, ".omni-agent", "agents"),
  /** Explicit goals survive an Omni restart: the goal, its chat's session file and cwd. */
  goalsFile: fc.goalsFile || join(HOME, ".omni-agent", "goals.json"),
  /** Where unattended run ledgers live. */
  /** The status-box summarizer's own side conversations (one OpenCode session per goal, ids kept in opencode-sessions.json; the judge's and the summarizer's sessions run in this directory), apart from the chats. */
  statusSessionsDir: fc.statusSessionsDir || join(HOME, ".omni-agent", "status-sessions"),
  runsDir: fc.runsDir || join(fc.vaultDir || join(ROOT, "vault"), "Runs"),
  /** CLI reverse-engineering tools (jadx/apktool/baksmali/smali) are pre-installed here and this
   *  bin dir is put on the PATH of Omni's `opencode serve`, so the agent finds working headless CLIs instead of
   *  re-downloading them from GitHub or launching a GUI. Provisioned by `node scripts/install-tools.mjs`. */
  toolsBinDir: fc.toolsBinDir || join(HOME, ".omni-agent", "tools", "bin"),
};

/** VPS relay settings: `host` turns it on. The public port is the relay's on the VPS; the tunnel forwards
 *  the VPS's loopback `remotePort` to this PC's loopback `localPort`, the listener that reads PROXY headers. */
export function relayConfig(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const dir = join(HOME, ".omni-agent", "relay");
  return {
    host: String(r.host || "").trim(),
    user: String(r.user || "omni-tunnel"),
    publicPort: Number(r.publicPort) || 4443,
    remotePort: Number(r.remotePort) || 14443,
    localPort: Number(r.localPort) || 4444,
    key: r.key || join(dir, "id_ed25519"),
    knownHosts: r.knownHosts || join(dir, "known_hosts"),
  };
}

/** Normalized goal-hook settings. Empty provider/model = the (opt-in) judge uses the chat's current model. */
export function hookConfig(raw = {}) {
  const h = raw && typeof raw === "object" ? raw : {};
  const int = (v, dflt, min, max) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : dflt; };
  return {
    enabled: h.enabled === true,
    provider: String(h.provider || "").trim(),
    model: String(h.model || "").trim(),
    /** Consecutive re-engagements without a single tool call before the keeper gives up; otherwise it never stops. */
    maxIdleNudges: int(h.maxIdleNudges, 5, 1, 50),
    graceMs: int(h.graceMs, 2000, 0, 600000),
    /** Whether the separate summarizer conversation writes the status box (default on) — never into the chat's context.
     *  Paced by the plan, not by time or tool calls: when the plan is written or revised, at each milestone, at the end. */
    summaries: h.summaries !== false,
    /** Re-engages restate the goal verbatim only every N times (and after a compaction); 0 = only after a compaction. */
    restateEvery: int(h.restateEvery, 10, 0, 1000),
    summaryProvider: String(h.summaryProvider || "").trim(),
    summaryModel: String(h.summaryModel || "").trim(),
    judgeTimeoutMs: int(h.judgeTimeoutMs, 120000, 10000, 600000),
    heartbeatMs: int(h.heartbeatMs, 60000, 5000, 3600000),
    /** Same failure signature (or the same plan step) this many times in a row → escalate instead of nudging again. */
    loopK: int(h.loopK, 3, 2, 20),
    /** Work without a plan that ends normally: ask the judge model (opt-in) instead of the deterministic rule. */
    judgeFallback: h.judgeFallback === true,
    /** Work without a plan that used tools: how many "confirm it is done, or plan the rest" re-engages before it counts as finished. */
    planlessNudges: int(h.planlessNudges, 1, 0, 10),
    /** Consecutive rejected requests (e.g. 400) before the context is compacted to recover. */
    errorCompactAfter: int(h.errorCompactAfter, 2, 1, 10),
    /** First back-off after a transient provider error (5xx, 429, timeouts); doubles per repeat, capped at 10 min. */
    errorBackoffMs: int(h.errorBackoffMs, 15000, 1000, 600000),
  };
}

/**
 * Context policy. `compactAt`: a chat is compacted before its next prompt once its context passes this many tokens
 * (OpencodeRpc's `compactAt`); 0 = only OpenCode's own compaction. `autoContinue`: a run that stops because the model believes its context is used up is
 * compacted and continued even with the goal hook off. Pure.
 */
export function contextConfig(raw = {}) {
  const c = raw && typeof raw === "object" ? raw : {};
  const int = (v, dflt, min, max) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : dflt; };
  return {
    // Floor 100k: a compacted chat still holds the system prompt + tools, keepRecentTokens and the summary (~60k),
    // so a lower point would compact on almost every turn.
    compactAt: c.compactAt === 0 ? 0 : int(c.compactAt, 256000, 100000, 10000000),
    autoContinue: c.autoContinue !== false,
    /** Above this share of the budget the model gets a one-line context note on its newest message. */
    statusFromPercent: int(c.statusFromPercent, 70, 1, 100),
    /** Context stops in a row (no tool call between them) that are continued before the run is left alone. */
    maxContextNudges: int(c.maxContextNudges, 3, 1, 20),
  };
}

/** Limits for the background agents the agents start (server/agents.mjs). Pure. */
export function agentsConfig(raw = {}) {
  const a = raw && typeof raw === "object" ? raw : {};
  const int = (v, dflt, min, max) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : dflt; };
  return {
    /** Agents of all kinds running at once (more wait in a queue). */
    maxConcurrent: int(a.maxConcurrent, 6, 1, 64),
    /** How deep agents may nest: 1 = only the user's chat starts agents; 2 = its agents may start their own. */
    maxDepth: int(a.maxDepth, 2, 1, 5),
    /** A running agent is stopped after this long (a shell job uses its own timeout). */
    maxMinutes: int(a.maxMinutes, 360, 1, 7 * 24 * 60),
    /** Claude Code agents run unattended: nothing may block on a permission prompt. */
    claudePermissionMode: String(a.claudePermissionMode || "bypassPermissions"),
    claudeMaxTurns: int(a.claudeMaxTurns, 300, 1, 10000),
    claudeModel: String(a.claudeModel || "").trim(),
  };
}

/** Environment handed to Omni's `opencode serve`, which every chat shares, so it carries
 *  only server-wide values (a background agent's identity cannot reach it): provider API keys (from key files), the emulator display
 *  override (so omnidroid launched by the model uses the higher default resolution), and
 *  OMNI_MEMORY=server, which says the memory tools run in Omni's own chats:
 *  the server attaches the vault pack per prompt (composer checkbox), so no tool adds
 *  its own on every turn. Pure so it is unit-testable. */
export function piChildEnv(cfg = CONFIG, { path = process.env.PATH || "", exists = existsSync } = {}) {
  const env = { ...apiKeyEnv(cfg.apiKeyFiles || {}) };
  const disp = String(cfg.emulatorDisplay || "").trim();
  if (disp && !["native", "off", "0", "false"].includes(disp.toLowerCase())) env.OMNI_DISPLAY = disp;
  env.OMNI_MEMORY = "server";
  // Put the pre-installed RE tools (jadx/apktool/baksmali/smali, CLI-only) first on PATH so the
  // agent finds working headless commands instead of re-downloading them or launching a GUI.
  const bin = cfg.toolsBinDir;
  if (bin && exists(bin)) env.PATH = `${bin}${delimiter}${path}`;
  // The omni-agents / claude_task extensions call back into this server (background agents), whatever port it runs on.
  if (cfg.port) env.OMNI_AGENT_URL = `http://127.0.0.1:${cfg.port}`;
  // The OpenCode plugin's memory_* tools use the server's vault.
  if (cfg.vaultDir) env.OMNI_VAULT = cfg.vaultDir;
  return env;
}
