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

// omnidroid's lifecycle tools, to exercise the wrapper's idempotent-stop and list_instances trimming.
const LIFECYCLE = process.env.FAKE_MCP_LIFECYCLE === "1";
if (LIFECYCLE) {
  TOOLS.push({ name: "stop_instance", description: "Close an instance.", inputSchema: { type: "object", properties: { instance_id: { type: "number" } }, required: ["instance_id"] } });
  TOOLS.push({ name: "list_instances", description: "Every instance.", inputSchema: { type: "object", properties: {} } });
  TOOLS.push({ name: "list_devices", description: "The warm Androids.", inputSchema: { type: "object", properties: {} } });
}
// list_devices reports the device booting for the first FAKE_MCP_BOOT_POLLS calls, then ready — to drive wait_device.
let devicePolls = 0;
const bootPolls = Number(process.env.FAKE_MCP_BOOT_POLLS || 2);
// A realistic instance record (long apk path + sha256 make the list overflow, as the real one does).
const fakeInstance = (id, state) => ({
  apk: `\\\\?\\C:\\Users\\berat\\Desktop\\rebuild\\work\\build_${id}_signed.apk`,
  device: 2, display: 2, instance_id: id, package: "com.roblox.client",
  screenshot: null, sha256: `ee1ee0457a23adb63fb2a95276910cc85079ac8984bdc33b42ddf6f67f5d93${String(id).padStart(2, "0")}`,
  state, up_s: 100 + id, user: 10,
});
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
  if (name === "stop_instance") {
    // id 999 is already gone — omnidroid answers with an error even though the goal (stopped) is met.
    if (Number(args?.instance_id) === 999) return err(`#999 ended already`);
    return ok({ content: [{ type: "text", text: JSON.stringify({ instance_id: Number(args?.instance_id), stopped: true }) }] });
  }
  if (name === "list_instances") {
    // Two live instances and many ended ones — the shape that overflows the clip in the real runs.
    const live = [fakeInstance(30, "running"), fakeInstance(31, "waiting")];
    const ended = Array.from({ length: 24 }, (_, i) => fakeInstance(i + 1, "ended: the app stopped"));
    return ok({ content: [{ type: "text", text: JSON.stringify({ instances: [...ended, ...live] }) }] });
  }
  if (name === "list_devices") {
    const state = devicePolls++ < bootPolls ? "booting" : "ready";
    return ok({ content: [{ type: "text", text: JSON.stringify({ devices: [{ id: 2, state, up_s: 10 + devicePolls }] }) }] });
  }
  return err(`no tool named ${name}`, -32601);
});
