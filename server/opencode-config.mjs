/**
 * Omni's own OpenCode config directory (`OPENCODE_CONFIG_DIR` of the `opencode serve` Omni runs): `opencode.json`
 * there is layered over the user's global OpenCode config, so Omni's chats get what an unattended agent needs —
 * every permission pre-allowed (nobody is there to answer a prompt; that covers OpenCode's own `task` subagents,
 * whose prompts never reach a chat), no interactive `question` tool — plus Omni's MCP servers and custom providers.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { writeModelsFile } from "./providers.mjs";

/** Allowed without asking. OpenCode's PermissionConfig: a tool name → "allow" | "ask" | "deny" (or per-pattern rules). */
export const PERMISSIONS = Object.freeze({ edit: "allow", bash: "allow", webfetch: "allow", external_directory: "allow", doom_loop: "allow" });

/** Where Omni's OpenCode plugin shim lives in the config dir (OpenCode loads `<dir>/plugin/*.js`). */
export const pluginShimPath = (dir) => join(dir, "plugin", "omni.js");

/**
 * The plugin shim's source for Omni's repo at `root`: integrations/opencode/shim.js with the plugin's file URL and the
 * root filled in (the shim imports the plugin from the repo, so the logic stays there).
 */
export function omniShim(root) {
  const template = readFileSync(join(root, "integrations", "opencode", "shim.js"), "utf8");
  const url = pathToFileURL(join(root, "integrations", "opencode", "omni-plugin.mjs")).href;
  return template.replace('"__OMNI_PLUGIN_URL__"', () => JSON.stringify(url)).replace('"__OMNI_ROOT__"', () => JSON.stringify(root));
}

/** Omni's `${VAR}` env references in OpenCode's `{env:VAR}` form (OpenCode substitutes those in its config). */
const envRef = (v) => String(v ?? "").replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, "{env:$1}");
const envMap = (o) => Object.fromEntries(Object.entries(o && typeof o === "object" ? o : {}).map(([k, v]) => [k, envRef(v)]));
const nonEmpty = (o) => o && Object.keys(o).length > 0;

/**
 * One server of Omni's MCP list (the pi extension's `mcpServers` shape: stdio `{command, args, env, cwd}` or
 * `{type:"http", url, headers}`) as OpenCode's `mcp` entry; null for one OpenCode cannot run.
 */
export function mcpEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  const type = String(raw.type || (raw.url ? "http" : "stdio")).toLowerCase();
  const off = raw.disabled === true || raw.enabled === false ? { enabled: false } : {};
  if (type === "stdio") {
    const cmd = String(raw.command || "").trim();
    if (!cmd) return null;
    const out = { type: "local", command: [cmd, ...(Array.isArray(raw.args) ? raw.args.map(String) : [])] };
    if (nonEmpty(raw.env)) out.environment = envMap(raw.env);
    if (raw.cwd) out.cwd = String(raw.cwd);
    return { ...out, ...off };
  }
  if (type === "http" || type === "streamable-http" || type === "streamablehttp") {
    const url = String(raw.url || "").trim();
    if (!url) return null;
    const out = { type: "remote", url: envRef(url) };
    if (nonEmpty(raw.headers)) out.headers = envMap(raw.headers);
    return { ...out, ...off };
  }
  return null; // the old SSE transport and anything else
}

/**
 * The `opencode.json` object. `mcpServers`: Omni's MCP list; `omniMcp`: omnidroid's `omni-mcp` (`{command, args,
 * env, enabled}`), served as the `omnidroid` MCP server so its tools are `omnidroid_*`; `providers`: OpenCode
 * `provider` entries for Omni's custom providers (server/providers.mjs customProviderConfig), passed through as they are.
 */
export function opencodeConfig({ mcpServers = {}, omniMcp = null, providers = null } = {}) {
  const mcp = {};
  for (const [name, raw] of Object.entries(mcpServers && typeof mcpServers === "object" ? mcpServers : {})) {
    const e = mcpEntry(raw);
    if (e) mcp[name] = e;
  }
  if (omniMcp?.command && omniMcp.enabled !== false) {
    const e = mcpEntry({ command: omniMcp.command, args: omniMcp.args, env: omniMcp.env, cwd: omniMcp.cwd });
    if (e) mcp.omnidroid = e;
  }
  const out = { $schema: "https://opencode.ai/config.json", permission: { ...PERMISSIONS }, tools: { question: false } };
  if (nonEmpty(mcp)) out.mcp = mcp;
  if (nonEmpty(providers)) out.provider = providers;
  return out;
}

/**
 * Writes `<dir>/opencode.json` whole (atomically) and returns its path. `shim`: the plugin shim's source
 * (omniShim(root)); when given it is written to `pluginShimPath(dir)`, where OpenCode loads it as a plugin.
 */
export function writeOpencodeConfig({ dir, mcpServers = {}, omniMcp = null, providers = null, shim = null } = {}) {
  if (!dir) throw new Error("writeOpencodeConfig needs a dir");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "opencode.json");
  // It holds the custom providers' API keys: written like models.json (atomically: temp file + rename; mode 0600).
  writeModelsFile(path, opencodeConfig({ mcpServers, omniMcp, providers }));
  if (typeof shim === "string") {
    const file = pluginShimPath(dir);
    mkdirSync(join(dir, "plugin"), { recursive: true });
    writeFileSync(file, shim);
  }
  return path;
}
