/**
 * A minimal MCP server over HTTP (JSON-RPC 2.0, one JSON answer per POST) so Claude Code workers get Omni's mission
 * tools: `claude --mcp-config` points at `POST /mcp?agent=<id>`. The agent id names the caller; its chat decides the
 * mission, exactly like the OpenCode plugin's calls (server/mission-tools.mjs runs both).
 */
import { runMissionTool } from "./mission-tools.mjs";

export const MCP_PROTOCOL = "2025-06-18";

const str = (description) => ({ type: "string", description });
const obj = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: true });

/** The tools a Claude Code worker sees (names without a prefix; Claude shows them as mcp__omni__<name>). */
export const MCP_TOOLS = [
  { name: "ask_orchestrator", description: "Ask the mission's orchestrator when you are truly blocked on a decision only it can make. Waits up to 30 minutes for the answer.", inputSchema: obj({ question: str("The question") }, ["question"]) },
  { name: "progress", description: "A one-line progress note into the mission ledger (a milestone reached, a key finding).", inputSchema: obj({ note: str("The note") }, ["note"]) },
  { name: "handoff", description: "Hand your task to a fresh worker when your context was compacted twice or you are losing track. Give a complete handoff note (state, what works, what failed, next steps); then stop.", inputSchema: obj({ note: str("The handoff note") }, ["note"]) },
  { name: "memory_search", description: "Search the project's memory (durable notes other workers saved: offsets, keys, quirks, decisions).", inputSchema: obj({ query: str("Keywords"), limit: { type: "number" } }, ["query"]) },
  { name: "memory_recall", description: "A compact, token-budgeted pack of the project memory notes most relevant to a topic.", inputSchema: obj({ topic: str("What you are working on"), budget_tokens: { type: "number" } }, ["topic"]) },
  { name: "memory_save", description: "Save one durable fact to the project's memory (one fact per note; include why and how to apply).", inputSchema: obj({ name: str("Short name"), description: str("One line used to decide relevance"), body: str("The fact, markdown"), tags: { type: "array", items: { type: "string" } } }, ["name", "description", "body"]) },
  { name: "kg_search", description: "Search the project's knowledge graph (files, symbols, binaries, functions, strings, offsets and what is known about them).", inputSchema: obj({ query: str("What to look for"), kind: str("Optional node kind"), limit: { type: "number" } }, ["query"]) },
  { name: "kg_node", description: "One knowledge-graph node (id or name) with its neighbours and what is known about it.", inputSchema: obj({ id: str("Node id or name"), depth: { type: "number" } }, ["id"]) },
  { name: "kg_import", description: "Seed the project's knowledge graph: source \"graphify\" (a source repo; path = its directory, default the project) or \"ghidra\" (path = a binary such as a .so; runs Ghidra headless as a background job and loads functions, calls, strings, imports and exports when it ends).", inputSchema: obj({ source: str("graphify or ghidra"), path: str("The repo directory or the binary") }, ["source"]) },
  { name: "kg_upsert", description: "Record structure you learned in the project's knowledge graph: nodes {id, kind, name, summary, status: unknown|hypothesis|confirmed, confidence, evidence, binary, addr} and edges {src, dst, rel}.", inputSchema: obj({ nodes: { type: "array", items: { type: "object" } }, edges: { type: "array", items: { type: "object" } } }) },
];

const rpc = (id, result) => ({ jsonrpc: "2.0", id, result });
const rpcErr = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

/** One JSON-RPC message → its answer (null for a notification). */
export async function mcpAnswer(msg, { missions, agents, agentId, deps = {} }) {
  const id = msg?.id ?? null;
  const method = String(msg?.method || "");
  if (method.startsWith("notifications/")) return null;
  switch (method) {
    case "initialize": return rpc(id, { protocolVersion: msg.params?.protocolVersion || MCP_PROTOCOL, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "omni", version: "0.1.0" } });
    case "ping": return rpc(id, {});
    case "tools/list": return rpc(id, { tools: MCP_TOOLS });
    case "tools/call": {
      const name = msg.params?.name;
      if (!MCP_TOOLS.some((t) => t.name === name)) return rpcErr(id, -32602, `unknown tool ${name}`);
      const rec = agents.get(agentId);
      if (!rec?.sid) return rpc(id, { content: [{ type: "text", text: `Omni does not know agent ${agentId}.` }], isError: true });
      const r = await runMissionTool(missions, { sessionID: rec.sid, tool: name, args: msg.params?.arguments || {} }, deps);
      return rpc(id, { content: [{ type: "text", text: r.output }], isError: !!r.metadata?.error });
    }
    default: return id == null ? null : rpcErr(id, -32601, `method not found: ${method}`);
  }
}

/** POST /mcp?agent=<id> (a single message or a batch). */
export async function handleMcp(req, res, { q, missions, agents, deps, readBody, send }) {
  if (req.method === "GET") { res.writeHead(405, { allow: "POST" }); res.end(); return; }
  if (req.method === "DELETE") { res.writeHead(200); res.end(); return; }
  if (req.method !== "POST") { send(res, 405, { error: "method not allowed" }); return; }
  const agentId = q.get("agent") || "";
  let body;
  try { body = await readBody(req); } catch { send(res, 400, rpcErr(null, -32700, "parse error")); return; }
  const ctx = { missions, agents, agentId, deps };
  const out = Array.isArray(body) ? (await Promise.all(body.map((m) => mcpAnswer(m, ctx)))).filter(Boolean) : await mcpAnswer(body, ctx);
  if (!out || (Array.isArray(out) && !out.length)) { res.writeHead(202); res.end(); return; }
  send(res, 200, out);
}
