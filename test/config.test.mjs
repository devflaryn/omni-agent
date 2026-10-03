import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { findPiCli, apiKeyEnv, piChildEnv, hookConfig } from "../server/config.mjs";

const REL = join("@earendil-works", "pi-coding-agent", "dist", "cli.js");

function layout() {
  const root = mkdtempSync(join(tmpdir(), "omni-cfg-"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("findPiCli follows the `pi` symlink on PATH (npm --prefix ~/.local layout)", () => {
  const { root, cleanup } = layout();
  try {
    const cli = join(root, ".local", "lib", "node_modules", REL);
    mkdirSync(join(cli, ".."), { recursive: true });
    writeFileSync(cli, "// cli");
    mkdirSync(join(root, ".local", "bin"), { recursive: true });
    symlinkSync(join("..", "lib", "node_modules", REL), join(root, ".local", "bin", "pi"));
    const found = findPiCli({ home: root, platform: "darwin", pathEnv: join(root, ".local", "bin"), appdata: undefined });
    assert.equal(found, realpathSync(cli));
  } finally { cleanup(); }
});

test("findPiCli falls back to global node_modules prefixes when pi is not on PATH", () => {
  const { root, cleanup } = layout();
  try {
    const cli = join(root, ".npm-global", "lib", "node_modules", REL);
    mkdirSync(join(cli, ".."), { recursive: true });
    writeFileSync(cli, "// cli");
    const found = findPiCli({ home: root, platform: "linux", pathEnv: join(root, "nowhere"), appdata: undefined, prefixes: [join(root, ".npm-global", "lib", "node_modules")] });
    assert.equal(found, cli);
  } finally { cleanup(); }
});

test("findPiCli uses %APPDATA%\\npm on Windows and returns null when nothing exists", () => {
  const { root, cleanup } = layout();
  try {
    const cli = join(root, "AppData", "Roaming", "npm", "node_modules", REL);
    mkdirSync(join(cli, ".."), { recursive: true });
    writeFileSync(cli, "// cli");
    assert.equal(findPiCli({ home: root, platform: "win32", pathEnv: "", appdata: join(root, "AppData", "Roaming"), prefixes: [] }), cli);
    assert.equal(findPiCli({ home: root, platform: "darwin", pathEnv: "", appdata: undefined, prefixes: [] }), null);
  } finally { cleanup(); }
});

test("findPiCli ignores a `pi` on PATH that is not a JS entry point", () => {
  const { root, cleanup } = layout();
  try {
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(join(root, "bin", "pi"), "#!/bin/sh\nexec node something\n");
    assert.equal(findPiCli({ home: root, platform: "darwin", pathEnv: [join(root, "bin"), join(root, "missing")].join(delimiter), appdata: undefined, prefixes: [] }), null);
  } finally { cleanup(); }
});

test("apiKeyEnv reads one-line key files into env vars and skips missing ones", () => {
  const { root, cleanup } = layout();
  try {
    writeFileSync(join(root, "openrouter.txt"), "sk-or-v1-abc\n");
    const env = apiKeyEnv({ OPENROUTER_API_KEY: join(root, "openrouter.txt"), OTHER_KEY: join(root, "nope.txt") });
    assert.deepEqual(env, { OPENROUTER_API_KEY: "sk-or-v1-abc" });
    assert.deepEqual(apiKeyEnv({}), {});
  } finally { cleanup(); }
});

test("piChildEnv exports OMNI_DISPLAY from emulatorDisplay, honoring off-switches and key files", () => {
  const { root, cleanup } = layout();
  try {
    writeFileSync(join(root, "or.txt"), "sk-or-test\n");
    const base = { apiKeyFiles: { OPENROUTER_API_KEY: join(root, "or.txt") } };
    assert.deepEqual(piChildEnv({ ...base, emulatorDisplay: "1600x1000" }), { OPENROUTER_API_KEY: "sk-or-test", OMNI_DISPLAY: "1600x1000", OMNI_MEMORY: "server" });
    assert.deepEqual(piChildEnv({ ...base, emulatorDisplay: "1920x1200@240" }).OMNI_DISPLAY, "1920x1200@240");
    for (const off of ["", "native", "off", "  ", "0", "false"]) {
      assert.ok(!("OMNI_DISPLAY" in piChildEnv({ ...base, emulatorDisplay: off })), `off: ${JSON.stringify(off)}`);
    }
    assert.deepEqual(piChildEnv({ emulatorDisplay: "1280x800" }), { OMNI_DISPLAY: "1280x800", OMNI_MEMORY: "server" });
  } finally { cleanup(); }
});

test("piChildEnv marks the child as server-owned so the omni-memory extension leaves memory to the composer toggle", () => {
  const { cleanup } = layout();
  try {
    // The server attaches the vault pack per prompt (composer checkbox); the extension must not add its own on top.
    assert.equal(piChildEnv({ emulatorDisplay: "" }).OMNI_MEMORY, "server");
  } finally { cleanup(); }
});

test("hookConfig surfaces summary model, judge timeout, heartbeat, loopK", () => {
  const h = hookConfig({ summaryProvider: "orca", summaryModel: "Qwen/Qwen3.8-27B", judgeTimeoutMs: 90000, heartbeatMs: 60000, loopK: 3 });
  assert.equal(h.summaryProvider, "orca");
  assert.equal(h.summaryModel, "Qwen/Qwen3.8-27B");
  assert.equal(h.judgeTimeoutMs, 90000);
  assert.equal(h.heartbeatMs, 60000);
  assert.equal(h.loopK, 3);
});
test("hookConfig clamps and defaults the new numbers", () => {
  const h = hookConfig({});
  assert.equal(h.heartbeatMs, 60000);
  assert.equal(h.loopK, 3);
  assert.equal(h.judgeTimeoutMs, 120000);
});

test("piChildEnv puts the tools bin dir first on the pi child's PATH when it exists", () => {
  const env = piChildEnv({ toolsBinDir: "/opt/retools/bin", apiKeyFiles: {} }, { path: "/usr/bin:/bin", exists: () => true });
  assert.ok(env.PATH.startsWith("/opt/retools/bin"), "tools bin should be prepended");
  assert.ok(env.PATH.includes("/usr/bin"), "existing PATH preserved");
  assert.equal(env.OMNI_MEMORY, "server");
});
test("piChildEnv does not touch PATH when the tools bin dir is absent", () => {
  const env = piChildEnv({ toolsBinDir: "/nope", apiKeyFiles: {} }, { path: "/usr/bin", exists: () => false });
  assert.equal(env.PATH, undefined);
});
