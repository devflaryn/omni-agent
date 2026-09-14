import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir, networkInterfaces } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const HOME = homedir();
export const CONFIG_FILE = join(ROOT, "omni.config.json");
const APPDATA = process.env.APPDATA || join(HOME, "AppData", "Roaming");
const PI_CLI_REL = join("@earendil-works", "pi-coding-agent", "dist", "cli.js");

/**
 * Locate pi's `dist/cli.js` so the child can be spawned as `node cli.js --mode rpc`
 * (no shell, no `.cmd` shim, no PATH surprises inside a GUI launcher).
 * Order: the `pi` launcher on PATH (a symlink to cli.js on macOS/Linux npm installs),
 * `%APPDATA%\npm` on Windows, then the usual global `node_modules` prefixes.
 */
export function findPiCli({ home = HOME, platform = process.platform, pathEnv = process.env.PATH || "", appdata = process.env.APPDATA, prefixes } = {}) {
  const isFile = (p) => { try { return !!p && existsSync(p); } catch { return false; } };
  for (const dir of pathEnv.split(delimiter).filter(Boolean)) {
    const bin = join(dir, "pi");
    if (!isFile(bin)) continue;
    let real;
    try { real = realpathSync(bin); } catch { continue; }
    if (/\.(m?js)$/i.test(real)) return real;
  }
  const candidates = [];
  if (platform === "win32") candidates.push(join(appdata || join(home, "AppData", "Roaming"), "npm", "node_modules"));
  candidates.push(...(prefixes ?? [
    join(home, ".local", "lib", "node_modules"),
    join(home, ".npm-global", "lib", "node_modules"),
    "/opt/homebrew/lib/node_modules",
    "/usr/local/lib/node_modules",
    "/usr/lib/node_modules",
    join(home, ".bun", "install", "global", "node_modules"),
  ]));
  for (const prefix of candidates) { const p = join(prefix, PI_CLI_REL); if (isFile(p)) return p; }
  return null;
}

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
      if (/vmware|vmnet|vethernet|wsl|hyper-v|virtualbox|docker/i.test(name)) continue;
      out.push({ name, address: a.address });
    }
  }
  return out;
}

const fc = readConfigFile();
const lan = process.argv.includes("--lan") || fc.lan === true;
let token = process.env.OMNI_TOKEN || fc.token || "";
if (lan && !token) {
  token = randomBytes(12).toString("base64url");
  writeConfigFile({ token });
}

export const CONFIG = {
  port: Number(argVal("--port", process.env.OMNI_PORT || fc.port || 4400)),
  /** `--lan` (or {"lan":true}) listens on every interface and requires the access token from non-local devices. */
  host: lan ? "0.0.0.0" : "127.0.0.1",
  lan,
  token,
  vaultDir: process.env.OMNI_VAULT || fc.vaultDir || join(ROOT, "vault"),
  /** Deleted chats are moved here (recoverable), never hard-unlinked. */
  trashDir: fc.trashDir || join(HOME, ".omni-agent", "trash"),
  piSessionsDir: fc.piSessionsDir || join(HOME, ".pi", "agent", "sessions"),
  claudeProjectsDir: fc.claudeProjectsDir || join(HOME, ".claude", "projects"),
  /** pi is launched as `node cli.js --mode rpc` (no shell, no quoting issues). */
  piCli: fc.piCli || findPiCli(),
  /** pi's config folder; `models.json` in it is where Omni's Providers dialog writes providers, keys and model ids. */
  piAgentDir: fc.piAgentDir || join(HOME, ".pi", "agent"),
  piModelsFile: fc.piModelsFile || join(fc.piAgentDir || join(HOME, ".pi", "agent"), "models.json"),
  piBin: fc.piBin || "pi",
  /** Key files handed to the pi child as environment variables (one line each, gitignored). */
  apiKeyFiles: { OPENROUTER_API_KEY: join(ROOT, "openrouter.txt"), ...(fc.apiKeyFiles || {}) },
  /** Guest resolution (WxH[@DPI]) exported as OMNI_DISPLAY to the pi child, so any omnidroid
   *  the model launches boots at a higher default resolution. Empty string / "native" = off. */
  emulatorDisplay: fc.emulatorDisplay ?? "1600x1000",
  claudeBin: process.env.OMNI_CLAUDE_BIN || fc.claudeBin || "claude",
  graphifyBin: fc.graphifyBin || "graphify",
  cwd: argVal("--cwd", process.env.OMNI_CWD || fc.cwd || join(HOME, "Desktop")),
  piModel: argVal("--model", fc.piModel || ""),
  piProvider: argVal("--provider", fc.piProvider || ""),
  /** Model picker allowlist, "provider/id" patterns with `*` (e.g. ["orca/*"]). Unset → every model pi knows. */
  piModels: Array.isArray(fc.piModels) ? fc.piModels : null,
  /** Longest a `POST /api/claude/task` (pi → Claude delegation) waits before returning what it has. */
  claudeTaskTimeoutSec: fc.claudeTaskTimeoutSec || 900,
  /** Start the pi child at boot. `--no-pi` or {"autoStartPi":false} disables it. */
  autoStartPi: !process.argv.includes("--no-pi") && fc.autoStartPi !== false,
  /** Seconds of quiet after which a session digest is written to the vault. */
  digestIdleSec: fc.digestIdleSec || 90,
  /** Only tail session files touched within this many hours at boot. */
  tailRecentHours: fc.tailRecentHours || 72,
  memoryBudgetTokens: fc.memoryBudgetTokens || 1200,
  graphBudgetTokens: fc.graphBudgetTokens || 900,
  /** A non-owned session file touched within this window counts as "still open in a terminal" → fork instead of resume. */
  liveWindowMs: fc.liveWindowMs || 30000,
};

/** Environment handed to the pi child: provider API keys (from key files) plus the
 *  emulator display override, so omnidroid launched by the model uses the higher
 *  default resolution. Pure so it is unit-testable. */
export function piChildEnv(cfg = CONFIG) {
  const env = { ...apiKeyEnv(cfg.apiKeyFiles || {}) };
  const disp = String(cfg.emulatorDisplay || "").trim();
  if (disp && !["native", "off", "0", "false"].includes(disp.toLowerCase())) env.OMNI_DISPLAY = disp;
  return env;
}
