/**
 * The omni-memory pi extension auto-attaches a vault pack to every prompt (autoRecall). When the pi child is
 * Omni's own (spawned by the server with OMNI_MEMORY=server), the composer's "Attach relevant memory" checkbox
 * decides per prompt, so the extension must stay out of it. Loads the real extension source through node's
 * type stripping; pi's own packages resolve from the installed pi (skipped when pi is not installed).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { registerHooks } from "node:module";
import { ROOT, findPiCli } from "../server/config.mjs";

const EXT = join(ROOT, "integrations", "pi", "omni-memory.ts");
const piCli = findPiCli();

if (piCli) {
  // Bare imports inside the extension (`@earendil-works/pi-tui`, `typebox`) resolve as if from pi's cli.js.
  const extUrl = pathToFileURL(EXT).href;
  registerHooks({
    resolve(specifier, context, next) {
      if (context.parentURL === extUrl && !specifier.startsWith(".") && !specifier.startsWith("node:") && !specifier.startsWith("file:")) {
        return next(specifier, { ...context, parentURL: pathToFileURL(piCli).href });
      }
      return next(specifier, context);
    },
  });
}

function fakeExtensionApi() {
  const tools = [], events = [], commands = [];
  return { tools, events, commands, api: { registerTool: (t) => tools.push(t.name), on: (name, fn) => events.push({ name, fn }), registerCommand: (name) => commands.push(name) } };
}

async function loadWithConfig(env) {
  const home = mkdtempSync(join(tmpdir(), "omni-ext-"));
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  writeFileSync(join(home, ".pi", "agent", "omni-agent.json"), JSON.stringify({ root: ROOT, vault: join(home, "vault"), autoRecall: true, budgetTokens: 200 }));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, OMNI_MEMORY: process.env.OMNI_MEMORY };
  process.env.HOME = home; process.env.USERPROFILE = home;
  if (env.OMNI_MEMORY === undefined) delete process.env.OMNI_MEMORY; else process.env.OMNI_MEMORY = env.OMNI_MEMORY;
  try {
    const mod = await import(pathToFileURL(EXT).href);
    const fx = fakeExtensionApi();
    await mod.default(fx.api);
    return fx;
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(home, { recursive: true, force: true });
  }
}

test("omni-memory: standalone pi keeps auto recall (before_agent_start registered)", { skip: !piCli && "pi is not installed" }, async () => {
  const fx = await loadWithConfig({});
  assert.deepEqual(fx.tools, ["memory_search", "memory_recall", "memory_save"]);
  assert.ok(fx.events.some((e) => e.name === "before_agent_start"), "auto recall hook registered for a terminal pi");
});

test("omni-memory: Omni's own pi child (OMNI_MEMORY=server) gets the tools but no auto recall", { skip: !piCli && "pi is not installed" }, async () => {
  const fx = await loadWithConfig({ OMNI_MEMORY: "server" });
  assert.deepEqual(fx.tools, ["memory_search", "memory_recall", "memory_save"], "memory tools still offered");
  assert.ok(fx.commands.includes("memory"));
  assert.ok(!fx.events.some((e) => e.name === "before_agent_start"), "no system-prompt memory pack: the composer checkbox decides");
});
