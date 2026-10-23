/**
 * The Providers dialog's MCP servers tab: reads and writes the `mcpServers` block of omni-agent.json
 * (cfg.piExtConfigFile, ~/.pi/agent/omni-agent.json), which server/opencode-config.mjs renders into Omni's
 * opencode.json `mcp` (each route change rewrites it and reloads OpenCode), and tests a server by connecting
 * to it with Omni's own MCP client.
 *
 * Secret values (env vars and headers) never go to the UI: each one is sent as a mask, and a mask
 * sent back on save keeps the stored value. A `${VAR}` reference is not a secret and is shown as-is.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { McpHttpClient, McpStdioClient, serverConfigs } from "../integrations/pi/omni-mcp-lib.mjs";

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const MASK = "••••••••";

function readFile(file) {
  if (!file || !existsSync(file)) return {};
  try { const j = JSON.parse(readFileSync(file, "utf8")); return j && typeof j === "object" ? j : {}; } catch { return {}; }
}

function writeFile(file, json) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
  try { chmodSync(file, 0o600); } catch { /* windows */ }
}

const servers = (json) => (json.mcpServers && typeof json.mcpServers === "object" ? json.mcpServers : {});
const isRef = (v) => /^\s*\$\{[^}]+\}\s*$/.test(String(v));
/** What the UI sees in place of a secret value: the mask plus the last 4 characters. */
export const maskValue = (v) => { const s = String(v ?? ""); return !s || isRef(s) ? s : `${MASK}${s.length > 8 ? s.slice(-4) : ""}`; };
const masked = (obj) => Object.fromEntries(Object.entries(obj && typeof obj === "object" ? obj : {}).map(([k, v]) => [k, maskValue(v)]));
const transport = (s) => String(s?.type || (s?.url ? "http" : "stdio")).toLowerCase();

/** Servers for the UI, in file order, with secret values masked. */
export function listMcpServers(file) {
  return Object.entries(servers(readFile(file))).map(([name, s]) => ({
    name,
    type: transport(s),
    command: s?.command || "",
    args: Array.isArray(s?.args) ? s.args.map(String) : [],
    cwd: s?.cwd || "",
    env: masked(s?.env),
    url: s?.url || "",
    headers: masked(s?.headers),
    timeoutSec: Number(s?.timeoutSec) || null,
    disabled: s?.disabled === true || s?.enabled === false,
  }));
}

/** A map from the form, with each value that is still the mask replaced by the stored one. */
function unmask(given, prev) {
  const out = {};
  for (const [k, v] of Object.entries(given && typeof given === "object" ? given : {})) {
    const key = String(k).trim();
    if (!key) continue;
    const val = String(v ?? "");
    out[key] = val.startsWith(MASK) && prev && typeof prev === "object" && key in prev && maskValue(prev[key]) === val ? String(prev[key]) : val;
  }
  return out;
}

/** @returns {string|null} an error message, or null when the server entry is valid */
export function validateMcpServer(name, body) {
  if (!NAME_RE.test(String(name || ""))) return "server name must be letters, digits, - or _ (e.g. github)";
  const type = String(body?.type || "stdio").toLowerCase();
  if (type === "stdio") { if (!String(body?.command || "").trim()) return "a stdio server needs a command (e.g. npx)"; }
  else if (type === "http") {
    const url = String(body?.url || "").trim();
    if (!isRef(url)) { try { const u = new URL(url); if (!/^https?:$/.test(u.protocol)) throw new Error(); } catch { return "URL must be a valid http(s) URL"; } }
  } else return "transport must be stdio or http";
  if (body?.timeoutSec != null && body.timeoutSec !== "" && !(Number(body.timeoutSec) > 0)) return "timeout must be a positive number of seconds";
  return null;
}

/** Build the stored entry from the form, keeping masked secrets and any keys the form does not show. */
function entryFrom(body, prev = {}) {
  const type = String(body.type || "stdio").toLowerCase();
  // Keys the form owns are rebuilt; anything else the owner put in the file by hand is kept.
  const { type: _t, command: _c, args: _a, cwd: _w, env: _e, url: _u, headers: _h, timeoutSec: _s, disabled: _d, enabled: _n, ...rest } = prev;
  const next = { ...rest };
  if (type === "stdio") {
    next.command = String(body.command).trim();
    const args = (Array.isArray(body.args) ? body.args : []).map(String).filter((a) => a !== "");
    if (args.length) next.args = args;
    const env = unmask(body.env, prev.env);
    if (Object.keys(env).length) next.env = env;
    if (String(body.cwd || "").trim()) next.cwd = String(body.cwd).trim();
  } else {
    next.type = "http";
    next.url = String(body.url).trim();
    const headers = unmask(body.headers, prev.headers);
    if (Object.keys(headers).length) next.headers = headers;
  }
  if (Number(body.timeoutSec) > 0) next.timeoutSec = Math.round(Number(body.timeoutSec));
  if (body.disabled === true) next.disabled = true;
  return next;
}

/** Create or replace `mcpServers.<name>`; `rename` moves an existing entry to the new name in place. */
export function upsertMcpServer(file, name, body, { rename } = {}) {
  const err = validateMcpServer(name, body);
  if (err) throw Object.assign(new Error(err), { status: 400 });
  const json = readFile(file);
  const all = servers(json);
  const from = rename && rename !== name ? rename : name;
  if (from !== name && name in all) throw Object.assign(new Error(`a server named "${name}" already exists`), { status: 409 });
  const entry = entryFrom(body, all[from] || {});
  // Keep the file order: a rename takes the old entry's place.
  const order = Object.keys(all);
  if (!order.includes(from)) order.push(from);
  json.mcpServers = Object.fromEntries(order.map((n) => (n === from ? [name, entry] : [n, all[n]])));
  writeFile(file, json);
  return entry;
}

export function removeMcpServer(file, name) {
  const json = readFile(file);
  const all = servers(json);
  if (!(name in all)) return false;
  delete all[name];
  json.mcpServers = all;
  writeFile(file, json);
  return true;
}

/**
 * Connect to a server the way pi's extension would and list its tools. `body` is the form (masked
 * secrets are filled from the stored entry `name`, if any). Never throws: answers { ok, tools } or { ok:false, error }.
 */
export async function testMcpServer(file, name, body, { timeoutMs = 20000 } = {}) {
  const err = validateMcpServer(name || "test", body);
  if (err) return { ok: false, error: err };
  const stored = servers(readFile(file))[body.rename || name] || {};
  const [s] = serverConfigs({ [name || "test"]: entryFrom(body, stored) });
  if (s.error) return { ok: false, error: s.error };
  const client = s.type === "http"
    ? new McpHttpClient({ name: `MCP server "${s.name}"`, url: s.url, headers: s.headers })
    : new McpStdioClient({ name: `MCP server "${s.name}"`, command: s.command, args: s.args, env: s.env, cwd: s.cwd });
  let timer;
  try {
    await Promise.race([client.start(), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`no answer in ${Math.round(timeoutMs / 1000)} s`)), timeoutMs); })]);
    return { ok: true, server: client.serverInfo?.name || null, tools: client.tools.map((t) => ({ name: t.name, description: String(t.description || "").split("\n")[0].slice(0, 200) })) };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  } finally {
    clearTimeout(timer);
    client.close(0);
  }
}
