/**
 * The MCP clients in omni-mcp-lib.mjs (McpStdioClient, McpHttpClient) and the `mcpServers` config reader, which the
 * server's MCP-server test (server/mcp.mjs) and the OpenCode plugin's omnidroid tools use. Driven against the fake
 * stdio server (test/helpers/fake-mcp.mjs) and an in-process Streamable HTTP server that answers some requests as
 * JSON and some as SSE, hands out a session id and can expire it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { join } from "node:path";
import { ROOT } from "../server/config.mjs";
import * as lib from "../integrations/pi/omni-mcp-lib.mjs";

const FAKE = join(ROOT, "test", "helpers", "fake-mcp.mjs");
const stdio = (env = {}, extra = {}) => new lib.McpStdioClient({ name: "fake", command: process.execPath, args: [FAKE], env: { FAKE_MCP: "1", ...env }, ...extra });

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

test("stdio: the handshake lists the tools and a call round-trips; env from serverConfigs is expanded; a JSON-RPC error is thrown and the server keeps serving", async () => {
  const [cfg] = lib.serverConfigs({ fake: { command: process.execPath, args: [FAKE], env: { FAKE_MCP: "1", FAKE_MCP_ENV: "${OMNI_TEST_MCP_VAR:-from-default}" } } });
  const c = new lib.McpStdioClient({ name: "fake", command: cfg.command, args: cfg.args, env: cfg.env });
  try {
    await c.start();
    assert.equal(c.serverInfo?.name, "fake-mcp");
    assert.deepEqual(c.tools.map((t) => t.name).sort(), ["echo", "fail", "hang"]);
    const body = JSON.parse((await c.callTool("echo", { len: 16 })).text);
    assert.deepEqual(body.got, { len: 16 });
    assert.equal(body.env, "from-default", "${VAR:-default} in env is expanded");
    await assert.rejects(c.callTool("fail", {}), /no lab session/);
    assert.equal(JSON.parse((await c.callTool("echo", { address: "0x10" })).text).got.address, "0x10", "still serving after an error");
  } finally { c.close(0); }
});

test("stdio: a server's own ping (id colliding with ours) is answered, and its notifications reach onNotification", async () => {
  const notes = [];
  const c = stdio({ FAKE_MCP_EXTRA: "1" }, { onNotification: (m) => notes.push(m.method) });
  try {
    await c.start();
    assert.ok(c.tools.some((t) => t.name === "grow"), "the handshake survived a server request with id 1");
    assert.equal((await c.callTool("grow", {})).text, "grew");
    for (let i = 0; i < 50 && !notes.includes("notifications/tools/list_changed"); i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(notes.includes("notifications/tools/list_changed"));
    await c.listTools();
    assert.ok(c.tools.some((t) => t.name === "grown"), "a re-list picks up the new tool");
  } finally { c.close(0); }
});

test("stdio: a slow call rejects with SlowCallError but the server is kept alive; a missing command is a clear error", async () => {
  const c = stdio();
  try {
    await c.start();
    await assert.rejects(c.callTool("hang", {}, 200), (e) => e instanceof lib.SlowCallError);
    assert.ok(c.alive, "the server is not killed for a slow call");
    assert.equal(JSON.parse((await c.callTool("echo", { len: 1 })).text).got.len, 1);
  } finally { c.close(0); }
  await assert.rejects(new lib.McpStdioClient({ name: "none" }).start(), /no command configured/);
  await assert.rejects(new lib.McpStdioClient({ name: "gone", command: join(ROOT, "no-such-dir", "omni-mcp.exe") }).start(), /not found/);
});

test("http: JSON and SSE answers, paging, headers from env, isError and an expired session; close ends the session", async () => {
  const h = await httpServer({ token: "t0k" });
  const [cfg] = lib.serverConfigs({ calc: { type: "http", url: h.url, headers: { Authorization: "Bearer ${OMNI_TEST_MCP_TOKEN}" } } }, { OMNI_TEST_MCP_TOKEN: "t0k" });
  const c = new lib.McpHttpClient({ name: "calc", url: cfg.url, headers: cfg.headers });
  try {
    await c.start();
    assert.deepEqual(c.tools.map((t) => t.name).sort(), ["add", "fail"], "both pages of tools/list");
    assert.equal((await c.callTool("add", { a: 2, b: 3 })).text, "5", "SSE answer after a notification");
    await assert.rejects(c.callTool("fail", {}), /it broke/);
    h.expire();
    assert.equal((await c.callTool("add", { a: 1, b: 1 })).text, "2", "re-initialized after a 404");
    assert.equal(h.seen.inits, 2);
    assert.ok(h.seen.auth.every((a) => a === "Bearer t0k"), "the header reaches every request");
  } finally { c.close(); await new Promise((r) => setTimeout(r, 100)); await h.close(); }
  assert.equal(h.seen.deletes, 1, "close ends the http session");
  await assert.rejects(new lib.McpHttpClient({ name: "down", url: "http://127.0.0.1:9/mcp" }).start());
});

test("serverConfigs: stdio and http entries, errors for unusable ones, disabled ones left out", () => {
  const list = lib.serverConfigs({
    down: { type: "http", url: "http://127.0.0.1:9/mcp" },
    nocmd: { args: ["x"] },
    sse: { type: "sse", url: "http://127.0.0.1:9/sse" },
    parked: { command: "x", disabled: true },
    off: { command: "x", enabled: false },
    ok: { command: "node", args: [1, "a"], timeoutSec: 5 },
  }, {});
  assert.deepEqual(list.map((s) => s.name), ["down", "nocmd", "sse", "ok"]);
  assert.equal(list[0].type, "http");
  assert.match(list[1].error, /a stdio server needs a `command`/);
  assert.match(list[2].error, /transport "sse" is not supported/);
  assert.deepEqual(list[3], { name: "ok", type: "stdio", command: "node", args: ["1", "a"], env: {}, cwd: undefined, timeoutSec: 5 });
  assert.deepEqual(lib.serverConfigs(undefined), []);
});

test("mcpToolName keeps names provider-safe; parseToolResult reads resources and structured content", () => {
  assert.equal(lib.mcpToolName("my server", "do.thing"), "mcp__my_server__do_thing");
  assert.equal(lib.mcpToolName("s".repeat(40), "t".repeat(40)).length, 64);
  assert.deepEqual(lib.parseToolResult({ content: [{ type: "resource", resource: { uri: "file:///a", text: "A" } }, { type: "image", data: "eA==", mimeType: "image/jpeg" }] }),
    { text: "A", images: [{ data: "eA==", mimeType: "image/jpeg" }], isError: false });
  assert.equal(lib.parseToolResult({ content: [], structuredContent: { n: 1 } }).text, '{"n":1}');
});
