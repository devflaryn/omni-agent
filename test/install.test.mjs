import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    assert.ok(existsSync(join(home, ".pi", "agent", "extensions", "omni-graph.ts")));
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

test("install.mjs --openrouter writes the key to auth.json and the DeepSeek provider to models.json (merging)", () => {
  const home = mkdtempSync(join(tmpdir(), "omni-home-"));
  try {
    const keyFile = join(home, "openrouter.txt");
    writeFileSync(keyFile, "sk-or-v1-test\n");
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(join(home, ".pi", "agent", "models.json"), JSON.stringify({ providers: { orca: { baseUrl: "http://x/v1", api: "openai-completions", apiKey: "k", models: [{ id: "Qwen/Qwen3.8-27B" }] } } }));
    const r = spawnSync(process.execPath, [script, "--openrouter"], { encoding: "utf8", env: { ...process.env, OMNI_HOME: home, OMNI_OPENROUTER_KEY_FILE: keyFile } });
    assert.equal(r.status, 0, r.stderr);
    const auth = JSON.parse(readFileSync(join(home, ".pi", "agent", "auth.json"), "utf8"));
    assert.deepEqual(auth.openrouter, { type: "api_key", key: "sk-or-v1-test" });
    const models = JSON.parse(readFileSync(join(home, ".pi", "agent", "models.json"), "utf8"));
    assert.ok(models.providers.orca, "existing provider kept");
    assert.equal(models.providers.openrouter.baseUrl, "https://openrouter.ai/api/v1");
    assert.equal(models.providers.openrouter.api, "openai-completions");
    assert.equal(models.providers.openrouter.apiKey, "sk-or-v1-test");
    const m = models.providers.openrouter.models.find((x) => x.id === "deepseek/deepseek-v4-flash-0731");
    assert.ok(m, "deepseek flash 0731 present");
    assert.deepEqual(m.input, ["text"]);
    const missing = spawnSync(process.execPath, [script, "--openrouter"], { encoding: "utf8", env: { ...process.env, OMNI_HOME: home, OMNI_OPENROUTER_KEY_FILE: join(home, "nope.txt") } });
    assert.equal(missing.status, 1);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
