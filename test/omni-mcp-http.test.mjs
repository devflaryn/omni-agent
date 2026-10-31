import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { Bus } from "../server/bus.mjs";
import { ProjectStore } from "../server/projects.mjs";
import { MissionManager } from "../server/missions.mjs";
import { Vault } from "../server/memory.mjs";
import { AgentManager } from "../server/agents.mjs";
import { MCP_TOOLS, mcpAnswer } from "../server/omni-mcp-http.mjs";
import { FakeAgents, orchestratorFactory, flush } from "./helpers/mission-fakes.mjs";

const base = mkdtempSync(join(tmpdir(), "omni-mcp-"));
after(() => rmSync(base, { recursive: true, force: true }));

async function setup() {
  const dir = join(base, "repo"); mkdirSync(dir, { recursive: true });
  const bus = new Bus(), agents = new FakeAgents(), bf = orchestratorFactory(bus);
  const missions = new MissionManager({ bus, store: new ProjectStore({ root: join(base, "p") }), agents, createOrchestrator: bf.createOrchestrator, config: { heartbeatMs: 0 } });
  const m = missions.create({ dir, goal: "g", orchestratorModel: "a/b" });
  await flush(); await flush();
  const w = missions.spawnWorker(m, { task: "fix", kind: "claude" });
  const vault = new Vault(missions.projectOf(m).memoryDir).ensure();
  const deps = { memory: () => vault };
  return { missions, agents, m, w, deps, vault };
}

test("initialize, tools/list, notifications and unknown methods", async () => {
  const { missions, agents, w, deps } = await setup();
  const ctx = { missions, agents, agentId: w.id, deps };
  const init = await mcpAnswer({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } }, ctx);
  assert.equal(init.result.protocolVersion, "2025-03-26");
  assert.equal(init.result.serverInfo.name, "omni");
  assert.equal(await mcpAnswer({ jsonrpc: "2.0", method: "notifications/initialized" }, ctx), null);
  const list = await mcpAnswer({ jsonrpc: "2.0", id: 2, method: "tools/list" }, ctx);
  assert.deepEqual(list.result.tools.map((t) => t.name), MCP_TOOLS.map((t) => t.name));
  assert.ok(list.result.tools.every((t) => t.inputSchema?.type === "object"));
  assert.equal((await mcpAnswer({ jsonrpc: "2.0", id: 3, method: "resources/list" }, ctx)).error.code, -32601);
});

test("tools/call reaches the mission as that worker: ask_orchestrator, memory, progress", async () => {
  const { missions, agents, m, w, deps } = await setup();
  const ctx = { missions, agents, agentId: w.id, deps };
  const pending = mcpAnswer({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "ask_orchestrator", arguments: { question: "arm64 or armv7?" } } }, ctx);
  await flush();
  missions.answerQuestion(m, m.questions[0].id, "arm64");
  assert.equal((await pending).result.content[0].text, "The orchestrator answers: arm64");
  const saved = await mcpAnswer({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "memory_save", arguments: { name: "xor key", description: "packer key", body: "0x5A" } } }, ctx);
  assert.match(saved.result.content[0].text, /Saved .*xor-key/);
  const found = await mcpAnswer({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "memory_search", arguments: { query: "xor" } } }, ctx);
  assert.match(found.result.content[0].text, /xor-key/);
  const unknown = await mcpAnswer({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "progress", arguments: { note: "x" } } }, { ...ctx, agentId: "a-ffffffff" });
  assert.equal(unknown.result.isError, true);
});

test("a mission's Claude agent is started with an --mcp-config pointing at /mcp?agent=<id>; others without", async () => {
  const runs = [];
  const claude = Object.assign(new EventEmitter(), { runs: new Map(), run(o) { runs.push(o); return { sid: `claude:s${runs.length}`, sessionId: `s${runs.length}` }; } });
  const dir = join(base, "am"); mkdirSync(dir, { recursive: true });
  const am = new AgentManager({ bus: new Bus(), claude, dir: join(dir, "logs"), file: join(dir, "agents.json"), cwd: dir, omniUrl: "http://127.0.0.1:4410", saveDelayMs: 5 });
  const a = am.start({ kind: "claude", task: "fix", missionId: "m-1", role: "worker", depth: 0 });
  const b = am.start({ kind: "claude", task: "plain", depth: 0 });
  for (let i = 0; i < 50 && runs.length < 2; i++) await flush();
  const ra = runs.find((r) => r.meta.agentId === a.id), rb = runs.find((r) => r.meta.agentId === b.id);
  assert.ok(ra.mcpConfig && existsSync(ra.mcpConfig));
  assert.equal(JSON.parse(readFileSync(ra.mcpConfig, "utf8")).mcpServers.omni.url, `http://127.0.0.1:4410/mcp?agent=${a.id}`);
  assert.equal(rb.mcpConfig, undefined);
  am.dispose();
});
