import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(process.cwd(), "scripts", "install.mjs");
// OMNI_OPENCODE_BIN names the launcher for the presence check: a missing path stands for "opencode is not installed".
const run = (home, ...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: { ...process.env, OMNI_HOME: home, OMNI_OPENCODE_BIN: join(home, "no-such-opencode") } });
const runEnv = (home, env, ...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: { ...process.env, OMNI_HOME: home, OMNI_OPENCODE_BIN: join(home, "no-such-opencode"), ...env } });
const skillsDir = (home) => join(home, ".omni-agent", "opencode", "skills");

test("install.mjs puts the skills in OpenCode's config dir, writes no pi extensions, uninstall removes the skills", () => {
  const home = mkdtempSync(join(tmpdir(), "omni-home-"));
  try {
    const r = run(home, "--claude-skills");
    assert.equal(r.status, 0, r.stderr);
    for (const p of [["omnidroid", "SKILL.md"], ["omnidroid", "reference", "omni-cli.md"], ["omnidroid-frida", "SKILL.md"], ["omnidroid-qemu", "reference", "omni-cli.md"], ["omnidroid-input", "SKILL.md"], ["subagent-driven-implementation", "SKILL.md"]]) {
      assert.ok(existsSync(join(skillsDir(home), ...p)), p.join("/"));
    }
    assert.ok(existsSync(join(home, ".claude", "skills", "omnidroid", "SKILL.md")));
    for (const s of ["omnidroid-frida", "omnidroid-qemu", "omnidroid-input", "subagent-driven-implementation"]) assert.ok(!existsSync(join(home, ".claude", "skills", s)), `${s} is not shared with Claude Code`);
    // Nothing goes to pi any more: no extensions, no skills, no personas; the personas are read from the repo.
    assert.ok(!existsSync(join(home, ".pi", "agent", "extensions")), "no pi extensions");
    assert.ok(!existsSync(join(home, ".pi", "agent", "skills")), "no pi skills");
    assert.ok(!existsSync(join(home, ".pi", "agent", "agents")), "no persona copies");
    assert.ok(!existsSync(join(home, ".omni-agent", "opencode", "agents")) && !existsSync(join(home, ".omni-agent", "opencode", "agent")), "personas must not become OpenCode agents");
    // The server reads omniMcp from omni-agent.json and renders it into opencode.json.
    const cfg = JSON.parse(readFileSync(join(home, ".pi", "agent", "omni-agent.json"), "utf8"));
    assert.match(cfg.omniMcp.command, /omnidroid[\\/]target[\\/]release[\\/]omni-mcp(\.exe)?$/, "omni-mcp points at the sibling omnidroid build");
    assert.deepEqual(cfg.omniMcp.args, ["--connect", "http://127.0.0.1:7457/mcp"]);
    assert.ok(!existsSync(join(home, ".claude", "settings.json")), "no Claude hook without --claude-hook");
    const u = run(home, "--uninstall", "--claude-skills");
    assert.equal(u.status, 0, u.stderr);
    assert.ok(!existsSync(join(skillsDir(home), "omnidroid")));
    assert.ok(!existsSync(join(home, ".claude", "skills", "omnidroid")));
    assert.ok(!existsSync(join(home, ".pi", "agent", "omni-agent.json")));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("install.mjs says how to install OpenCode when it is not on the PATH, and stays quiet when it is", () => {
  const home = mkdtempSync(join(tmpdir(), "omni-home-"));
  try {
    const missing = run(home);
    assert.equal(missing.status, 0, missing.stderr);
    assert.match(missing.stdout, /opencode.*not found/i);
    assert.match(missing.stdout, /npm i -g opencode-ai/);
    const fake = join(home, "fake-opencode.mjs");
    writeFileSync(fake, 'console.log("1.18.32");');
    const ok = runEnv(home, { OMNI_OPENCODE_BIN: fake });
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /opencode 1\.18\.32/);
    assert.doesNotMatch(ok.stdout, /npm i -g/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("install.mjs removes what an older pi-harness install left behind, on uninstall only", () => {
  const home = mkdtempSync(join(tmpdir(), "omni-home-"));
  try {
    const ext = join(home, ".pi", "agent", "extensions");
    mkdirSync(join(ext, "subagent"), { recursive: true });
    writeFileSync(join(ext, "omni-memory.ts"), "x");
    writeFileSync(join(ext, "someone-elses.ts"), "x");
    mkdirSync(join(home, ".pi", "agent", "skills", "omnidroid"), { recursive: true });
    mkdirSync(join(home, ".pi", "agent", "agents"), { recursive: true });
    writeFileSync(join(home, ".pi", "agent", "agents", "scout.md"), "EDITED");
    assert.equal(run(home).status, 0);
    assert.ok(existsSync(join(ext, "omni-memory.ts")), "install leaves pi's folder alone");
    assert.equal(run(home, "--uninstall").status, 0);
    assert.ok(!existsSync(join(ext, "omni-memory.ts")) && !existsSync(join(ext, "subagent")) && !existsSync(join(home, ".pi", "agent", "skills", "omnidroid")));
    assert.ok(existsSync(join(ext, "someone-elses.ts")), "files that are not ours stay");
    assert.equal(readFileSync(join(home, ".pi", "agent", "agents", "scout.md"), "utf8"), "EDITED", "agents stay: they may be user-edited");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("the shipped skills document today's omnidroid, its MCP tools, and keep the QEMU manager as legacy", () => {
  const read = (...p) => readFileSync(join(process.cwd(), "skills", ...p), "utf8");
  const skill = read("omnidroid", "SKILL.md");
  assert.match(skill, /^name: omnidroid$/m);
  for (const s of ["omnidroid_<tool>", "mcp__omnidroid__", "start_instance {apk, count?, options?}", "--cookie", "One pool per computer", "wait_instance", "list_instances", "input {instance_id", "mcp on", "--connect", "Any APK", "not reachable", "omnidroid-frida"]) assert.ok(skill.includes(s), `omnidroid skill mentions ${s}`);
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

test("install.mjs keeps an omniMcp.command that still exists and registers the app's server with Claude Code on --claude-mcp", () => {
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
    assert.deepEqual(cfg.omniMcp, { command: bin, env: { OMNI_MCP_PLACE: "8737899170" }, timeoutSec: 120, args: ["--connect", "http://127.0.0.1:7457/mcp"] });
    const calls = readFileSync(log, "utf8").trim().split(/\r?\n/).map((l) => JSON.parse(l));
    assert.deepEqual(calls[0], ["mcp", "remove", "--scope", "user", "omnidroid"]);
    assert.deepEqual(calls[1], ["mcp", "add", "--transport", "http", "--scope", "user", "omnidroid", "http://127.0.0.1:7457/mcp"]);
    const u = runEnv(home, { OMNI_CLAUDE_BIN: fakeClaude }, "--uninstall", "--claude-mcp");
    assert.equal(u.status, 0, u.stderr);
    assert.deepEqual(JSON.parse(readFileSync(log, "utf8").trim().split(/\r?\n/).at(-1)), ["mcp", "remove", "--scope", "user", "omnidroid"]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("install.mjs --openrouter no longer writes pi's files; it points at the Providers dialog", () => {
  const home = mkdtempSync(join(tmpdir(), "omni-home-"));
  try {
    const r = run(home, "--openrouter");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Providers/);
    assert.ok(!existsSync(join(home, ".pi", "agent", "auth.json")) && !existsSync(join(home, ".pi", "agent", "models.json")));
    assert.ok(!existsSync(skillsDir(home)), "nothing is installed when the flag is refused");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("install.mjs keeps the owner's mcpServers on reinstall and on uninstall", () => {
  const home = mkdtempSync(join(tmpdir(), "omni-home-"));
  try {
    const mcpServers = { fs: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] } };
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(join(home, ".pi", "agent", "omni-agent.json"), JSON.stringify({ mcpServers }));
    assert.equal(run(home).status, 0);
    const file = join(home, ".pi", "agent", "omni-agent.json");
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).mcpServers, mcpServers);
    assert.equal(run(home, "--uninstall").status, 0);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { mcpServers });
  } finally { rmSync(home, { recursive: true, force: true }); }
});
