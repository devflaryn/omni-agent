#!/usr/bin/env node
/**
 * A stand-in for omnidroid's omni-mcp: JSON-RPC 2.0 over stdio, one message per line, with the same
 * tool-list shape (an `array` parameter with no `items`) and the same error style (a failing tool is a
 * JSON-RPC error, not an isError result). `hang` never answers, to exercise the client's timeout.
 * FAKE_MCP_EXTRA=1 adds what a general server does: a `ping` request of its own (with an id that
 * collides with the client's) before it answers initialize, and `grow`, which adds a tool and sends
 * notifications/tools/list_changed.
 */
import { createInterface } from "node:readline";

// `node --test` runs every .mjs under test/ as a test file; only a spawn that asks for the server gets one.
if (process.env.FAKE_MCP !== "1") process.exit(0);

const TOOLS = [
  { name: "echo", description: "Echo the arguments back.", inputSchema: { type: "object", properties: { address: { type: "string", description: "guest address" }, len: { type: "number", description: "bytes" }, args: { type: "array", description: "args" } }, required: [] } },
  { name: "fail", description: "Always fails.", inputSchema: { type: "object", properties: {}, required: [] } },
  { name: "hang", description: "Never answers.", inputSchema: { type: "object", properties: {}, required: [] } },
];

const EXTRA = process.env.FAKE_MCP_EXTRA === "1";
if (EXTRA) TOOLS.push({ name: "grow", description: "Adds the tool `grown`.", inputSchema: { type: "object", properties: {} } });
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
createInterface({ input: process.stdin }).on("line", (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return out({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse" } }); }
  if (m.id === undefined) return;
  if (m.method === undefined) return; // the client's answer to our ping
  if (EXTRA && m.method === "initialize") out({ jsonrpc: "2.0", id: m.id, method: "ping" });
  const ok = (result) => out({ jsonrpc: "2.0", id: m.id, result });
  const err = (message, code = -32000) => out({ jsonrpc: "2.0", id: m.id, error: { code, message } });
  if (m.method === "initialize") return ok({ protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fake-mcp", version: "0" } });
  if (m.method === "tools/list") return ok({ tools: TOOLS });
  if (m.method !== "tools/call") return err(`no method ${m.method}`, -32601);
  const { name, arguments: args } = m.params;
  if (name === "echo") return ok({ content: [{ type: "text", text: JSON.stringify({ got: args, env: process.env.FAKE_MCP_ENV ?? null }) }], isError: false });
  if (name === "fail") return err("no lab session; call `lab_load` with a library path first");
  if (name === "hang") return;
  if (name === "grow") {
    TOOLS.push({ name: "grown", description: "Appeared later.", inputSchema: { type: "object", properties: {} } });
    ok({ content: [{ type: "text", text: "grew" }] });
    return out({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
  }
  if (name === "grown") return ok({ content: [{ type: "text", text: "hello from grown" }] });
  return err(`no tool named ${name}`, -32601);
});
