import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { findPiCli, apiKeyEnv } from "../server/config.mjs";

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
