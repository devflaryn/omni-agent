/**
 * The omni-mcp pi extension: an MCP stdio client that registers omnidroid's omni-mcp tools as
 * `omnidroid_<tool>` pi tools. Driven against a fake server (test/helpers/fake-mcp.mjs) always, and
 * against the real omni-mcp binary and its libz.so fixture when the sibling omnidroid checkout has
 * one built (skipped otherwise). Loads the real extension source through node's type stripping.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, findPiCli } from "../server/config.mjs";

const EXT = join(ROOT, "integrations", "pi", "omni-mcp.ts");
const FAKE = join(ROOT, "test", "helpers", "fake-mcp.mjs");
const OMNIDROID = join(dirname(ROOT), "omnidroid");
const REAL_BIN = process.env.OMNI_MCP_BIN || join(OMNIDROID, "target", "release", process.platform === "win32" ? "omni-mcp.exe" : "omni-mcp");
const LIBZ = join(OMNIDROID, "crates", "omni-debug", "tests", "fixtures", "libz.so");

const mod = await import(pathToFileURL(EXT).href);

function fakeApi() {
  const tools = new Map(), events = new Map();
  return { tools, events, api: { registerTool: (t) => tools.set(t.name, t), on: (name, fn) => events.set(name, fn) } };
}

/** Load the extension with `omniMcp` config in a temp ~/.pi/agent/omni-agent.json, fire session_start. */
async function load(omniMcp) {
  const home = mkdtempSync(join(tmpdir(), "omni-mcp-"));
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  writeFileSync(join(home, ".pi", "agent", "omni-agent.json"), JSON.stringify({ omniMcp }));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home; process.env.USERPROFILE = home;
  const fx = fakeApi();
  const notes = [];
  try { mod.default(fx.api); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(home, { recursive: true, force: true });
  }
  await fx.events.get("session_start")?.({}, { ui: { notify: (m) => notes.push(m) } });
  const quit = () => fx.events.get("session_shutdown")?.({ reason: "quit" });
  const run = (name, args, ctx = {}) => {
    const t = fx.tools.get(name);
    return t.execute("id", t.prepareArguments ? t.prepareArguments(args) : args, undefined, undefined, ctx);
  };
  return { ...fx, notes, quit, run };
}

test("omni-mcp: the server's tools register as omnidroid_* with provider-safe schemas, and a call round-trips", async () => {
  const x = await load({ command: process.execPath, args: [FAKE], env: { FAKE_MCP: "1", FAKE_MCP_ENV: "passed" } });
  try {
    assert.deepEqual([...x.tools.keys()].sort(), ["omnidroid_echo", "omnidroid_fail", "omnidroid_hang"]);
    const echo = x.tools.get("omnidroid_echo");
    assert.deepEqual(echo.parameters.properties.args.items, { type: "string", description: "decimal or 0x-hex" }, "an array without items gets string items");
    assert.equal(echo.parameters.required, undefined, "an empty required list is dropped");
    const r = await x.run("omnidroid_echo", { address: 4096, len: "0x10", args: [1, "0x40000000", 14] });
    const body = JSON.parse(r.content[0].text);
    assert.deepEqual(body.got, { address: "4096", len: 16, args: ["1", "0x40000000", "14"] }, "numbers and strings coerced to the schema");
    assert.equal(body.env, "passed", "omniMcp.env reaches the server");
    assert.deepEqual(r.details.result.got.len, 16);
    const hasNote = await x.events.get("before_agent_start")({ systemPrompt: "base" });
    assert.match(hasNote.systemPrompt, /omnidroid_lab_load/);
  } finally { await x.quit(); }
});

test("omni-mcp: a JSON-RPC error from a tool is thrown (pi marks it isError) and the server keeps serving", async () => {
  const x = await load({ command: process.execPath, args: [FAKE], env: { FAKE_MCP: "1" } });
  try {
    await assert.rejects(x.run("omnidroid_fail", {}), /no lab session/);
    const r = await x.run("omnidroid_echo", { len: 1 });
    assert.equal(JSON.parse(r.content[0].text).got.len, 1);
  } finally { await x.quit(); }
});

test("omni-mcp: a slow call is kept alive and surfaced to the agent, not killed", async () => {
  const x = await load({ command: process.execPath, args: [FAKE], env: { FAKE_MCP: "1" }, timeoutSec: 1 });
  try {
    // A call that does not return in time must RESOLVE with a keep-alive note (not reject/kill),
    // so the agent decides whether to wait or move on and the server + lab survive.
    const slow = await x.run("omnidroid_hang", {});
    assert.equal(slow.isError ?? false, false, "a slow call is not an error");
    assert.match(slow.content[0].text, /without returning|still alive|slow|intact|move on/i, "slow call surfaces a keep-alive note");
    // The server stayed up: a later call still works without a restart.
    const r = await x.run("omnidroid_echo", { len: 2 });
    assert.equal(JSON.parse(r.content[0].text).got.len, 2, "server alive after a slow call");
  } finally { await x.quit(); }
});

test("omni-mcp: a missing binary registers nothing and says why; enabled:false does nothing at all", async () => {
  const x = await load({ command: join(tmpdir(), "no-such-omni-mcp.exe") });
  assert.equal(x.tools.size, 0);
  assert.match(x.notes.join("\n"), /omni-mcp not found .*cargo build --release -p omni-mcp/);
  assert.equal(await x.events.get("before_agent_start")({ systemPrompt: "base" }), undefined, "no prompt note without tools");
  await x.quit();
  const off = await load({ command: process.execPath, args: [FAKE], env: { FAKE_MCP: "1" }, enabled: false });
  assert.equal(off.events.size, 0);
});

const piCli = findPiCli();
// pi-ai exports no subpaths, so its validator is found on disk beside the installed pi.
const piRoot = piCli && dirname(dirname(piCli));
const VALIDATION = piRoot && [join(piRoot, "node_modules", "@earendil-works", "pi-ai"), join(dirname(piRoot), "pi-ai")]
  .map((d) => join(d, "dist", "utils", "validation.js")).find((f) => existsSync(f));
test("omni-mcp: pi's own validator accepts the normalized schemas and the coerced arguments", { skip: !VALIDATION && "pi (with pi-ai) is not installed" }, async () => {
  const validation = await import(pathToFileURL(VALIDATION).href);
  const x = await load({ command: process.execPath, args: [FAKE], env: { FAKE_MCP: "1" } });
  try {
    const echo = x.tools.get("omnidroid_echo");
    const args = echo.prepareArguments({ address: 16, args: [1, 2] });
    const ok = validation.validateToolArguments({ name: echo.name, parameters: echo.parameters }, { type: "toolCall", id: "1", name: echo.name, arguments: args });
    assert.deepEqual(ok, { address: "16", args: ["1", "2"] });
  } finally { await x.quit(); }
});

test("omni-mcp: the real omni-mcp drives the lab debugger (adler32 of libz.so)", { skip: !(existsSync(REAL_BIN) && existsSync(LIBZ)) && "no built omni-mcp / libz.so fixture in ../omnidroid" }, async () => {
  const x = await load({ command: REAL_BIN });
  try {
    for (const t of ["omnidroid_start_instance", "omnidroid_screenshot", "omnidroid_lab_load", "omnidroid_call_function", "omnidroid_intercept", "omnidroid_dump_module"]) assert.ok(x.tools.has(t), `${t} registered`);
    await assert.rejects(x.run("omnidroid_read_mem", { address: "0x1000", len: 4 }), /no lab session/);
    const loaded = JSON.parse((await x.run("omnidroid_lab_load", { path: LIBZ })).content[0].text);
    assert.equal(loaded.module, "libz.so");
    const data = Buffer.from("Hello, world!");
    const buf = JSON.parse((await x.run("omnidroid_alloc_data", { hex: data.toString("hex") })).content[0].text).address;
    // adler32(1, buf, len): the model may pass numbers; the extension turns them into strings.
    const out = JSON.parse((await x.run("omnidroid_call_function", { symbol: "adler32", args: [1, buf, data.length] })).content[0].text);
    let a = 1, b = 0;
    for (const c of data) { a = (a + c) % 65521; b = (b + a) % 65521; }
    assert.equal(BigInt(out.ret), BigInt(((b << 16) | a) >>> 0));
    const mem = JSON.parse((await x.run("omnidroid_read_mem", { address: buf, len: data.length })).content[0].text);
    assert.equal(mem.hex, data.toString("hex"));
  } finally { await x.quit(); }
});
