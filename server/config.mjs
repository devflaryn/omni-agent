import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir, networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const HOME = homedir();
export const CONFIG_FILE = join(ROOT, "omni.config.json");
const APPDATA = process.env.APPDATA || join(HOME, "AppData", "Roaming");

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
const piCliCandidate = join(APPDATA, "npm", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
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
  piSessionsDir: fc.piSessionsDir || join(HOME, ".pi", "agent", "sessions"),
  claudeProjectsDir: fc.claudeProjectsDir || join(HOME, ".claude", "projects"),
  /** pi is launched as `node cli.js --mode rpc` (no shell, no quoting issues). */
  piCli: fc.piCli || (existsSync(piCliCandidate) ? piCliCandidate : null),
  piBin: fc.piBin || "pi",
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
