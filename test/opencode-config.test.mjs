import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeOpencodeConfig, opencodeConfig, omniShim, pluginShimPath } from "../server/opencode-config.mjs";

const fresh = () => mkdtempSync(join(tmpdir(), "omni-occfg-"));

test("writeOpencodeConfig writes opencode.json: permissions allowed, the question tool off, MCP servers and omnidroid", () => {
  const dir = join(fresh(), "opencode");
  const path = writeOpencodeConfig({
    dir, root: "C:\\omni",
    mcpServers: {
      fs: { command: "npx", args: ["-y", "pkg"], env: { TOKEN: "abc", REF: "${GH_TOKEN}" }, cwd: "C:\\w", timeoutSec: 60 },
      gh: { type: "http", url: "https://api.example.com/mcp", headers: { Authorization: "Bearer ${GH_TOKEN}" } },
      off: { command: "x", disabled: true },
      broken: { type: "sse", url: "http://x" },
      nocmd: { type: "stdio" },
    },
    omniMcp: { command: "C:\\od\\omni-mcp.exe", args: ["--connect", "http://127.0.0.1:7457/mcp"], env: { OMNIDROID_DYNARMIC_BUILD_DIR: "C:\\od-unified" }, timeoutSec: 600 },
  });
  assert.equal(path, join(dir, "opencode.json"));
  const j = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(j.$schema, "https://opencode.ai/config.json");
  assert.deepEqual(j.permission, { edit: "allow", bash: "allow", webfetch: "allow", external_directory: "allow", doom_loop: "allow" });
  assert.deepEqual(j.tools, { question: false });
  assert.deepEqual(j.mcp.fs, { type: "local", command: ["npx", "-y", "pkg"], environment: { TOKEN: "abc", REF: "{env:GH_TOKEN}" }, cwd: "C:\\w" });
  assert.deepEqual(j.mcp.gh, { type: "remote", url: "https://api.example.com/mcp", headers: { Authorization: "Bearer {env:GH_TOKEN}" } });
  assert.deepEqual(j.mcp.off, { type: "local", command: ["x"], enabled: false }, "a disabled server stays listed, switched off");
  assert.equal(j.mcp.broken, undefined, "an unsupported transport is left out");
  assert.equal(j.mcp.nocmd, undefined, "a stdio server without a command is left out");
  assert.deepEqual(j.mcp.omnidroid, { type: "local", command: ["C:\\od\\omni-mcp.exe", "--connect", "http://127.0.0.1:7457/mcp"], environment: { OMNIDROID_DYNARMIC_BUILD_DIR: "C:\\od-unified" } });
  assert.equal(j.provider, undefined, "no provider block without custom providers");
  assert.equal(existsSync(pluginShimPath(dir)), false, "the plugin shim is not written without one (Task 6 adds it)");
});

test("writeOpencodeConfig: no MCP servers → no mcp block; omniMcp disabled or without a command is left out; providers pass through", () => {
  const dir = fresh();
  const providers = { lab: { npm: "@ai-sdk/openai-compatible", name: "lab", options: { baseURL: "http://lab/v1", apiKey: "k" }, models: { q: { name: "Q" } } } };
  writeOpencodeConfig({ dir, root: "/omni", mcpServers: {}, omniMcp: { command: "x", enabled: false }, providers });
  const j = JSON.parse(readFileSync(join(dir, "opencode.json"), "utf8"));
  assert.equal(j.mcp, undefined);
  assert.deepEqual(j.provider, providers);
  assert.deepEqual(opencodeConfig({ omniMcp: {} }).mcp, undefined);
});

test("writeOpencodeConfig writes the plugin shim when one is given, and replaces an older opencode.json whole", () => {
  const dir = fresh();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "opencode.json"), JSON.stringify({ stale: true }));
  writeOpencodeConfig({ dir, root: "/omni", shim: "export const Omni = 1;\n" });
  assert.equal(readFileSync(pluginShimPath(dir), "utf8"), "export const Omni = 1;\n");
  assert.equal(pluginShimPath(dir), join(dir, "plugin", "omni.js"));
  assert.equal(JSON.parse(readFileSync(join(dir, "opencode.json"), "utf8")).stale, undefined);
});

test("omniShim: the plugin shim imports Omni's plugin from the repo by file URL and passes the repo root", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const shim = omniShim(root);
  assert.match(shim, /import \{ tool \} from "@opencode-ai\/plugin";/);
  assert.ok(shim.includes(`from ${JSON.stringify(pathToFileURL(join(root, "integrations", "opencode", "omni-plugin.mjs")).href)};`), shim);
  assert.ok(shim.includes(`createOmniPlugin({ tool, root: ${JSON.stringify(root)} })`), shim);
  assert.match(shim, /export const Omni = /);
  assert.doesNotMatch(shim, /__OMNI_/, "every placeholder is filled");
});
