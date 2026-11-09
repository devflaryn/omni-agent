import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG, apiKeyEnv, piChildEnv, hookConfig, retiredKeys } from "../server/config.mjs";

function layout() {
  const root = mkdtempSync(join(tmpdir(), "omni-cfg-"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

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

test("retiredKeys names the old relay's settings a config file still holds, and nothing else", () => {
  assert.deepEqual(retiredKeys({ port: 4400, relay: { host: "203.0.113.9" }, remote: true, tlsDir: "x", account: { hub: "h" } }), ["remote", "tlsDir", "relay"]);
  assert.deepEqual(retiredKeys({ port: 4400 }), []);
  assert.deepEqual(retiredKeys(null), []);
  for (const key of ["lan", "remote", "remotePort", "remoteTls", "tlsCert", "tlsKey", "tlsDir", "remoteAuthFile", "remoteApprovalTimeoutSec", "remoteSessionDays", "remoteDeviceApproval", "relay"]) {
    assert.ok(!(key in CONFIG), `CONFIG.${key} is gone`);
  }
});

test("a server whose config still has the old relay and remote keys starts on loopback alone, with one line about them", async () => {
  const { createApp } = await import("../server/index.mjs");
  const { root, cleanup } = layout();
  const lines = [];
  const real = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  let app;
  try {
    app = await createApp({
      port: 0, retiredKeys: ["remote", "relay"], relay: { host: "203.0.113.9", localPort: 0 }, remote: true, lan: true, remotePort: 0,
      autoStartPi: false, cwd: root, vaultDir: join(root, "vault"), piSessionsDir: join(root, "pi"), claudeProjectsDir: join(root, "claude"), persistHook: false, persistPiModel: false, hook: { enabled: false },
    });
    await app.listen();
  } finally { console.log = real; }
  try {
    const about = lines.filter((l) => /remote|relay/.test(l));
    assert.equal(about.length, 1, about.join("\n"));
    assert.match(about[0], /omni\.config\.json still has remote, relay: .*can be deleted/);
    assert.equal(app.server.address().address, "127.0.0.1");
    assert.equal(app.remote, undefined);
    assert.equal(app.relay, undefined);
    assert.equal(app.tunnel, undefined);
    const r = await fetch(`http://127.0.0.1:${app.server.address().port}/api/state`);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).access.role, "host");
  } finally { app.close(); cleanup(); }
});
