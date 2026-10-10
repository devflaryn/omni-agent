import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(process.cwd(), "scripts", "install.mjs");
const run = (home, ...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: { ...process.env, OMNI_HOME: home } });
const runEnv = (home, env, ...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: { ...process.env, OMNI_HOME: home, ...env } });

test("install.mjs copies the pi extensions and the omnidroid skills under $OMNI_HOME, uninstall removes them", () => {
  const home = mkdtempSync(join(tmpdir(), "omni-home-"));
  try {
    const r = run(home, "--claude-skills");
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(home, ".pi", "agent", "extensions", "omni-memory.ts")));
    assert.ok(existsSync(join(home, ".pi", "agent", "extensions", "omni-claude.ts")));
    assert.ok(existsSync(join(home, ".pi", "agent", "extensions", "omni-graph.ts")));
    assert.ok(existsSync(join(home, ".pi", "agent", "extensions", "omni-mcp.ts")));
    assert.ok(existsSync(join(home, ".pi", "agent", "skills", "omnidroid-frida", "SKILL.md")));
    assert.ok(existsSync(join(home, ".pi", "agent", "skills", "omnidroid-qemu", "reference", "omni-cli.md")));
    assert.ok(existsSync(join(home, ".pi", "agent", "skills", "omnidroid", "SKILL.md")));
    assert.ok(existsSync(join(home, ".pi", "agent", "skills", "omnidroid", "reference", "omni-cli.md")));
    assert.ok(existsSync(join(home, ".pi", "agent", "skills", "omnidroid-input", "SKILL.md")));
    assert.ok(existsSync(join(home, ".claude", "skills", "omnidroid", "SKILL.md")));
    const cfg = JSON.parse(readFileSync(join(home, ".pi", "agent", "omni-agent.json"), "utf8"));
    assert.equal(cfg.autoRecall, true);
    assert.match(cfg.omniMcp.command, /omnidroid[\\/]target[\\/]release[\\/]omni-mcp(\.exe)?$/, "omni-mcp points at the sibling omnidroid build");
    assert.ok(!existsSync(join(home, ".claude", "settings.json")), "no Claude hook without --claude-hook");
    const u = run(home, "--uninstall", "--claude-skills");
    assert.equal(u.status, 0, u.stderr);
    assert.ok(!existsSync(join(home, ".pi", "agent", "skills", "omnidroid")));
    assert.ok(!existsSync(join(home, ".claude", "skills", "omnidroid")));
    assert.ok(!existsSync(join(home, ".pi", "agent", "omni-agent.json")));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("install.mjs ships the subagent extension and seeds the default agents, uninstall keeps the agents", () => {
  const home = mkdtempSync(join(tmpdir(), "omni-home-"));
  try {
    const r = run(home);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(home, ".pi", "agent", "extensions", "subagent", "index.ts")), "subagent index.ts installed");
    assert.ok(existsSync(join(home, ".pi", "agent", "extensions", "subagent", "agents.ts")), "subagent agents.ts installed");
    assert.ok(existsSync(join(home, ".pi", "agent", "agents", "scout.md")), "scout.md seeded");
    assert.ok(existsSync(join(home, ".pi", "agent", "agents", "re-analyst.md")), "re-analyst.md seeded");
    assert.ok(existsSync(join(home, ".pi", "agent", "agents", "droid-operator.md")), "droid-operator.md seeded");
    // A user-edited agent is never clobbered.
    const edited = join(home, ".pi", "agent", "agents", "scout.md");
    writeFileSync(edited, "EDITED BY USER");
    const r2 = run(home);
    assert.equal(r2.status, 0, r2.stderr);
    assert.equal(readFileSync(edited, "utf8"), "EDITED BY USER", "existing agent file not overwritten");
    // Uninstall drops the extension but leaves the (possibly user-edited) agents.
    const u = run(home, "--uninstall");
    assert.equal(u.status, 0, u.stderr);
    assert.ok(!existsSync(join(home, ".pi", "agent", "extensions", "subagent")), "subagent extension removed on uninstall");
    assert.ok(existsSync(join(home, ".pi", "agent", "agents", "scout.md")), "agents kept on uninstall");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("installer copies omni-run and its lib siblings into pi's extensions", () => {
  const home = mkdtempSync(join(tmpdir(), "omni-home-"));
  try {
    const r = run(home);
    assert.equal(r.status, 0, r.stderr);
    for (const f of ["omni-run.ts", "omni-run-lib.mjs", "omni-fallback-lib.mjs", "omni-fallback.ts"]) {
      assert.ok(existsSync(join(home, ".pi", "agent", "extensions", f)), `${f} should be installed`);
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("the shipped skills document today's omnidroid, its MCP tools, and keep the QEMU manager as legacy", () => {
  const read = (...p) => readFileSync(join(process.cwd(), "skills", ...p), "utf8");
  const skill = read("omnidroid", "SKILL.md");
  assert.match(skill, /^name: omnidroid$/m);
  for (const s of ["omnidroid_start_instance", "mcp__omnidroid__", "start_instance", "list_instances", "omni-linux-r-", "app_on_screen", "Any APK", "link_id", "omnidroid aosp", "--claude-mcp", "omnidroid-frida"]) assert.ok(skill.includes(s), `omnidroid skill mentions ${s}`);
  for (const s of ["DID_LOG_IN", "Joining game", "8737899170", "Roblox"]) assert.ok(!skill.includes(s), `the omnidroid skill is about any APK, not one app (${s})`);
  assert.ok(skill.includes("`omnidroid start/offset/session/debug-info/su/frida` belong to the old QEMU manager"), "the QEMU commands are named as not existing here");
  const ref = read("omnidroid", "reference", "omni-cli.md");
  for (const s of ["--headless", "--no-window", "--control", "OMNI_MCP_APK", "OMNI_MCP_ARGS", "OMNI_MCP_REPO", "timeoutSec", "--with-systemui", "r_app"]) assert.ok(ref.includes(s), `reference mentions ${s}`);
  const lab = read("omnidroid-frida", "SKILL.md");
  assert.match(lab, /^name: omnidroid-frida$/m);
  for (const s of ["lab_load", "call_function", "intercept", "replace_return", "run_until_stop", "dump_module", "write_mem", "load_code", "trace_syscalls", "does NOT attach", "never fires", "0x0 faulted"]) assert.ok(lab.includes(s), `frida skill mentions ${s}`);
  const qemu = read("omnidroid-qemu", "SKILL.md");
  assert.match(qemu, /^name: omnidroid-qemu$/m);
  assert.match(qemu, /^description: LEGACY/m);
  for (const s of ["--restart", "--apk-once", "--no-window", "view <name> --hide", "warm list|prune|clear|bake", "OMNI-", "--place", "kiosk_failure", "omnidroid-old"]) assert.ok(qemu.includes(s), `qemu skill mentions ${s}`);
  const qref = read("omnidroid-qemu", "reference", "omni-cli.md");
  for (const s of ["frida <user> --restart", "--apk-once", "apk-<sha256", "[apk-cache]", "frida.restart", "devkit.attached", "view <user> --hide", "--vnc-viewer", "warm list", "--no-window", "kiosk_failure", "--place"]) assert.ok(qref.includes(s), `qemu reference mentions ${s}`);
  const input = read("omnidroid-input", "SKILL.md");
  assert.match(input, /^name: omnidroid-input$/m);
  assert.match(input, /^description: LEGACY/m);
  assert.ok(input.includes("Driving without vision"));
});

test("install.mjs keeps an omniMcp.command that still exists and registers it with Claude Code on --claude-mcp", () => {
  const home = mkdtempSync(join(tmpdir(), "omni-home-"));
  try {
    const bin = join(home, "my-omni-mcp.exe");
    writeFileSync(bin, "");
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(join(home, ".pi", "agent", "omni-agent.json"), JSON.stringify({ omniMcp: { command: bin, env: { OMNI_MCP_PLACE: "8737899170" }, timeoutSec: 120 } }));
    const log = join(home, "claude-calls.jsonl");
    const fakeClaude = join(home, "claude.mjs");
    writeFileSync(fakeClaude, `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + String.fromCharCode(10));`);
    const r = runEnv(home, { OMNI_CLAUDE_BIN: fakeClaude }, "--claude-mcp");
    assert.equal(r.status, 0, r.stderr);
    const cfg = JSON.parse(readFileSync(join(home, ".pi", "agent", "omni-agent.json"), "utf8"));
    assert.deepEqual(cfg.omniMcp, { command: bin, env: { OMNI_MCP_PLACE: "8737899170" }, timeoutSec: 120 });
    const calls = readFileSync(log, "utf8").trim().split(/\r?\n/).map((l) => JSON.parse(l));
    assert.deepEqual(calls[0], ["mcp", "remove", "--scope", "user", "omnidroid"]);
    assert.deepEqual(calls[1], ["mcp", "add", "--scope", "user", "-e", "OMNI_MCP_PLACE=8737899170", "omnidroid", "--", bin]);
    const u = runEnv(home, { OMNI_CLAUDE_BIN: fakeClaude }, "--uninstall", "--claude-mcp");
    assert.equal(u.status, 0, u.stderr);
    assert.deepEqual(JSON.parse(readFileSync(log, "utf8").trim().split(/\r?\n/).at(-1)), ["mcp", "remove", "--scope", "user", "omnidroid"]);
  } finally { rmSync(home, { recursive: true, force: true }); }
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
