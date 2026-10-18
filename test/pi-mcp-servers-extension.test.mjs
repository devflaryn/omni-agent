/**
 * The omni-mcp-servers pi extension: any MCP server from `mcpServers` in ~/.pi/agent/omni-agent.json
 * becomes `mcp__<server>__<tool>` pi tools. Driven against the fake stdio server
 * (test/helpers/fake-mcp.mjs) and an in-process Streamable HTTP server that answers some requests as
 * JSON and some as SSE, hands out a session id and can expire it. Loads the real extension source
 * through node's type stripping.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "../server/config.mjs";

const EXT = join(ROOT, "integrations", "pi", "omni-mcp-servers.ts");
const LIB = join(ROOT, "integrations", "pi", "omni-mcp-lib.mjs");
const FAKE = join(ROOT, "test", "helpers", "fake-mcp.mjs");

const mod = await import(pathToFileURL(EXT).href);
const lib = await import(pathToFileURL(LIB).href);

/** Load the extension with `mcpServers` in a temp ~/.pi/agent/omni-agent.json, fire session_start. */
async function load(mcpServers) {
  const home = mkdtempSync(join(tmpdir(), "omni-mcp-servers-"));
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  writeFileSync(join(home, ".pi", "agent", "omni-agent.json"), JSON.stringify({ mcpServers }));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home; process.env.USERPROFILE = home;
  const tools = new Map(), events = new Map(), notes = [];
  try { mod.default({ registerTool: (t) => tools.set(t.name, t), on: (name, fn) => events.set(name, fn) }); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(home, { recursive: true, force: true });
  }
  await events.get("session_start")?.({}, { ui: { notify: (m) => notes.push(m) } });
  const quit = () => events.get("session_shutdown")?.({ reason: "quit" });
  const run = (name, args = {}) => {
    const t = tools.get(name);
    assert.ok(t, `${name} is registered`);
    return t.execute("id", t.prepareArguments ? t.prepareArguments(args) : args, undefined, undefined, {});
  };
  return { tools, events, notes, quit, run };
}

/** A Streamable HTTP MCP server: tools/list answers JSON, tools/call answers SSE (a notification first). */
async function httpServer({ token } = {}) {
  const seen = { auth: [], sessions: new Set(), deletes: 0, inits: 0 };
  let session = null;
  const srv = createServer(async (req, res) => {
    seen.auth.push(req.headers.authorization);
    if (req.method === "DELETE") { seen.deletes++; session = null; res.writeHead(200).end(); return; }
    if (token && req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end("no token"); return; }
    let body = "";
    for await (const c of req) body += c;
    const m = JSON.parse(body);
    if (m.method === "initialize") {
      seen.inits++;
      session = `s${seen.inits}`;
      res.writeHead(200, { "content-type": "application/json", "mcp-session-id": session });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake-http", version: "0" } } }));
      return;
    }
    if (req.headers["mcp-session-id"] !== session) { res.writeHead(404).end(); return; }
    seen.sessions.add(req.headers["mcp-session-id"]);
    if (m.id === undefined) { res.writeHead(202).end(); return; }
    if (m.method === "tools/list") {
      // Two pages, to exercise nextCursor.
      const page = m.params?.cursor
        ? { tools: [{ name: "fail", inputSchema: { type: "object", properties: {} } }] }
        : { tools: [{ name: "add", description: "Add two numbers.", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] } }], nextCursor: "2" };
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: page }));
      return;
    }
    if (m.method === "tools/call") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } })}\n\n`);
      const { name, arguments: a } = m.params;
      const result = name === "add"
        ? { content: [{ type: "text", text: String(a.a + a.b) }] }
        : { content: [{ type: "text", text: "it broke" }], isError: true };
      res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: m.id, result })}\n\n`);
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "nope" } }));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${srv.address().port}/mcp`, seen, expire: () => { session = "gone"; }, close: () => new Promise((r) => { srv.close(r); srv.closeAllConnections(); }) };
}

test("mcp servers: a stdio server's tools register as mcp__<server>__<tool> and a call round-trips", async () => {
  const x = await load({ fake: { command: process.execPath, args: [FAKE], env: { FAKE_MCP: "1", FAKE_MCP_ENV: "${OMNI_TEST_MCP_VAR:-from-default}" } } });
  try {
    assert.deepEqual([...x.tools.keys()].sort(), ["mcp__fake__echo", "mcp__fake__fail", "mcp__fake__hang"]);
    const r = await x.run("mcp__fake__echo", { len: "0x10" });
    const body = JSON.parse(r.content[0].text);
    assert.deepEqual(body.got, { len: 16 });
    assert.equal(body.env, "from-default", "${VAR:-default} in env is expanded");
    await assert.rejects(x.run("mcp__fake__fail"), /no lab session/);
    const note = await x.events.get("before_agent_start")({ systemPrompt: "base" });
    assert.match(note.systemPrompt, /fake: 3 tools, named mcp__fake__\*/);
  } finally { await x.quit(); }
});

test("mcp servers: a server's own ping (id colliding with ours) is answered, and list_changed adds the new tools", async () => {
  const x = await load({ grow: { command: process.execPath, args: [FAKE], env: { FAKE_MCP: "1", FAKE_MCP_EXTRA: "1" } } });
  try {
    assert.ok(x.tools.has("mcp__grow__grow"), "the handshake survived a server request with id 1");
    assert.equal((await x.run("mcp__grow__grow")).content[0].text, "grew");
    for (let i = 0; i < 50 && !x.tools.has("mcp__grow__grown"); i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal((await x.run("mcp__grow__grown")).content[0].text, "hello from grown");
  } finally { await x.quit(); }
});

test("mcp servers: a slow stdio call fails with a hint to raise timeoutSec", async () => {
  const x = await load({ slow: { command: process.execPath, args: [FAKE], env: { FAKE_MCP: "1" }, timeoutSec: 1 } });
  try {
    await assert.rejects(x.run("mcp__slow__hang"), /did not return in 1s .*timeoutSec/);
  } finally { await x.quit(); }
});

test("mcp servers: an http server over JSON and SSE, with paging, headers from env, isError and an expired session", async () => {
  const h = await httpServer({ token: "t0k" });
  process.env.OMNI_TEST_MCP_TOKEN = "t0k";
  const x = await load({ calc: { type: "http", url: h.url, headers: { Authorization: "Bearer ${OMNI_TEST_MCP_TOKEN}" } } });
  try {
    assert.deepEqual([...x.tools.keys()].sort(), ["mcp__calc__add", "mcp__calc__fail"], "both pages of tools/list");
    assert.equal(x.tools.get("mcp__calc__add").parameters.required.join(), "a,b");
    assert.equal((await x.run("mcp__calc__add", { a: "2", b: 3 })).content[0].text, "5", "SSE answer after a notification");
    await assert.rejects(x.run("mcp__calc__fail"), /it broke/);
    h.expire();
    assert.equal((await x.run("mcp__calc__add", { a: 1, b: 1 })).content[0].text, "2", "re-initialized after a 404");
    assert.equal(h.seen.inits, 2);
    assert.ok(h.seen.auth.every((a) => a === "Bearer t0k"), "the header reaches every request");
  } finally { await x.quit(); delete process.env.OMNI_TEST_MCP_TOKEN; await new Promise((r) => setTimeout(r, 50)); await h.close(); }
  assert.equal(h.seen.deletes, 1, "quit ends the http session");
});

test("mcp servers: a bad or unreachable server is reported and skipped, the others still load; disabled ones are ignored", async () => {
  const x = await load({
    down: { type: "http", url: "http://127.0.0.1:9/mcp" },
    nocmd: { args: ["x"] },
    sse: { type: "sse", url: "http://127.0.0.1:9/sse" },
    parked: { command: process.execPath, args: [FAKE], env: { FAKE_MCP: "1" }, disabled: true },
    ok: { command: process.execPath, args: [FAKE], env: { FAKE_MCP: "1" } },
  });
  try {
    assert.deepEqual([...x.tools.keys()].sort(), ["mcp__ok__echo", "mcp__ok__fail", "mcp__ok__hang"]);
    const notes = x.notes.join("\n");
    assert.match(notes, /"down" unavailable: .*not reachable/);
    assert.match(notes, /"nocmd": a stdio server needs a `command`/);
    assert.match(notes, /"sse": transport "sse" is not supported/);
    assert.doesNotMatch(notes, /parked/);
    const note = (await x.events.get("before_agent_start")({ systemPrompt: "base" })).systemPrompt;
    assert.match(note, /- down: not available/);
    assert.doesNotMatch(note, /parked/);
  } finally { await x.quit(); }
});

test("mcp servers: no mcpServers registers nothing and adds no prompt note", async () => {
  const x = await load(undefined);
  assert.equal(x.tools.size, 0);
  assert.equal(x.events.size, 0);
});

test("mcpToolName keeps names provider-safe; parseToolResult reads resources and structured content", () => {
  assert.equal(lib.mcpToolName("my server", "do.thing"), "mcp__my_server__do_thing");
  assert.equal(lib.mcpToolName("s".repeat(40), "t".repeat(40)).length, 64);
  assert.deepEqual(lib.parseToolResult({ content: [{ type: "resource", resource: { uri: "file:///a", text: "A" } }, { type: "image", data: "eA==", mimeType: "image/jpeg" }] }),
    { text: "A", images: [{ data: "eA==", mimeType: "image/jpeg" }], isError: false });
  assert.equal(lib.parseToolResult({ content: [], structuredContent: { n: 1 } }).text, '{"n":1}');
});
