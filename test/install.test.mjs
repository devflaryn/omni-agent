import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(process.cwd(), "scripts", "install.mjs");
const run = (home, ...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: { ...process.env, OMNI_HOME: home } });

test("install.mjs copies the pi extensions and the omnidroid skills under $OMNI_HOME, uninstall removes them", () => {
  const home = mkdtempSync(join(tmpdir(), "omni-home-"));
  try {
    const r = run(home, "--claude-skills");
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(home, ".pi", "agent", "extensions", "omni-memory.ts")));
    assert.ok(existsSync(join(home, ".pi", "agent", "extensions", "omni-claude.ts")));
    assert.ok(existsSync(join(home, ".pi", "agent", "skills", "omnidroid", "SKILL.md")));
    assert.ok(existsSync(join(home, ".pi", "agent", "skills", "omnidroid", "reference", "omni-cli.md")));
    assert.ok(existsSync(join(home, ".pi", "agent", "skills", "omnidroid-input", "SKILL.md")));
    assert.ok(existsSync(join(home, ".claude", "skills", "omnidroid", "SKILL.md")));
    const cfg = JSON.parse(readFileSync(join(home, ".pi", "agent", "omni-agent.json"), "utf8"));
    assert.equal(cfg.autoRecall, true);
    assert.ok(!existsSync(join(home, ".claude", "settings.json")), "no Claude hook without --claude-hook");
    const u = run(home, "--uninstall", "--claude-skills");
    assert.equal(u.status, 0, u.stderr);
    assert.ok(!existsSync(join(home, ".pi", "agent", "skills", "omnidroid")));
    assert.ok(!existsSync(join(home, ".claude", "skills", "omnidroid")));
    assert.ok(!existsSync(join(home, ".pi", "agent", "omni-agent.json")));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("the shipped skills document the new omnidroid surface", () => {
  const ref = readFileSync(join(process.cwd(), "skills", "omnidroid", "reference", "omni-cli.md"), "utf8");
  for (const s of ["frida <user> --restart", "--apk-once", "apk-<sha256", "[apk-cache]", "frida.restart", "devkit.attached", "view <user> --hide", "--vnc-viewer", "warm list", "--no-window"]) assert.ok(ref.includes(s), `reference mentions ${s}`);
  const skill = readFileSync(join(process.cwd(), "skills", "omnidroid", "SKILL.md"), "utf8");
  assert.match(skill, /^name: omnidroid$/m);
  for (const s of ["--restart", "--apk-once", "--no-window", "view <name> --hide", "warm list|prune|clear|bake"]) assert.ok(skill.includes(s), `skill mentions ${s}`);
  const input = readFileSync(join(process.cwd(), "skills", "omnidroid-input", "SKILL.md"), "utf8");
  assert.match(input, /^name: omnidroid-input$/m);
  assert.ok(input.includes("Driving without vision"));
});
