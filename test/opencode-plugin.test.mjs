import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTEXT_GUIDANCE } from "../integrations/pi/omni-context-lib.mjs";
import { stopPollers } from "../integrations/pi/omni-agents-lib.mjs";
import { createOmniPlugin, planFromMessages } from "../integrations/opencode/omni-plugin.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 5000) => { const t0 = Date.now(); while (!(await fn())) { if (Date.now() - t0 > ms) throw new Error("timed out waiting"); await sleep(10); } };
const base = mkdtempSync(join(tmpdir(), "omni-ocplugin-"));
after(() => { stopPollers(); try { rmSync(base, { recursive: true, force: true }); } catch { /* still open */ } });

/** `tool` as the plugin package has it: identity, `tool.schema` = zod; here a chainable stand-in for zod. */
const schema = new Proxy({}, { get: () => () => schema });
const tool = Object.assign((def) => def, { schema });

/** The OpenCode SDK client the plugin gets, over an in-memory store of session messages. */
function fakeClient() {
  const store = new Map();
  const prompts = [];
  /** child session id → parent id (OpenCode's `task` subagents run in child sessions). */
  const parents = new Map();
  return {
    store, prompts, parents,
    session: {
      get: async ({ path }) => ({ data: { id: path.id, ...(parents.has(path.id) ? { parentID: parents.get(path.id) } : {}) } }),
      messages: async ({ path }) => ({ data: store.get(path.id) || [] }),
      message: async ({ path }) => ({ data: { info: { id: path.messageID, role: "assistant", providerID: "opencode", modelID: "big-pickle" }, parts: [] } }),
      promptAsync: async (opts) => { prompts.push(opts); return { data: undefined }; },
    },
  };
}

/** Omni's /api/agents routes, enough for agent_start and the delivery poller. */
async function fakeOmni() {
  const calls = [];
  const agents = new Map();
  let n = 0;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : null;
      const url = new URL(req.url, "http://x");
      calls.push({ method: req.method, path: url.pathname, query: url.search, body });
      const send = (code, j) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(j)); };
      if (url.pathname === "/api/agents" && req.method === "POST") {
        const id = `a-0000000${++n}`;
        const rec = { id, kind: body.kind, title: body.title, task: body.task, status: "running", startedAt: Date.now(), parentSessionId: body.parentSessionId, delivered: false };
        agents.set(id, rec);
        return send(200, { agent: rec });
      }
      if (url.pathname === "/api/agents/wait") {
        const mine = [...agents.values()].filter((a) => a.parentSessionId === body.parentSessionId);
        // The agent finishes as soon as someone waits for it.
        for (const a of mine) if (a.status === "running") Object.assign(a, { status: "done", endedAt: Date.now(), resultText: `report of ${a.id}` });
        const finished = mine.filter((a) => a.status === "done" && (!body.undeliveredOnly || !a.delivered));
        return send(200, { finished, pending: [] });
      }
      const m = /^\/api\/agents\/([^/]+)\/delivered$/.exec(url.pathname);
      if (m) { const a = agents.get(m[1]); if (a) a.delivered = true; return send(200, { ok: !!a }); }
      if (url.pathname === "/api/agents/undelivered") return send(200, { agents: [] });
      if (url.pathname === "/api/agents") return send(200, { agents: [] });
      send(404, { error: "no route" });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  after(() => server.close());
  return { url: `http://127.0.0.1:${server.address().port}`, calls, agents };
}

const ctxFor = (sessionID, extra = {}) => ({ sessionID, messageID: "msg_a1", agent: "build", directory: base, worktree: base, abort: new AbortController().signal, metadata() {}, ask: async () => {}, ...extra });

async function plugin({ client = fakeClient(), env = {} } = {}) {
  const hooks = await createOmniPlugin({ tool, root: base, env: { OMNI_AGENT_URL: "http://127.0.0.1:9", OMNI_VAULT: join(base, "vault"), ...env } })({ client, directory: base, worktree: base, project: {}, serverUrl: new URL("http://127.0.0.1:4096") });
  return { hooks, client };
}

const BRAINSTORM = { action: "brainstorm", understanding: "Add a retry loop", approaches: [{ name: "loop", tradeoffs: "simple" }, { name: "library", tradeoffs: "a dependency" }], chosen: "loop", success_criteria: ["npm test passes"] };
const CREATE = { action: "create", milestones: [{ title: "Retry works", steps: [{ title: "add the loop", done_when: "the test passes" }, { title: "log retries", done_when: "the log shows them" }] }] };

/** The session's messages as OpenCode lists them: a user prompt, then an assistant message with the plan tool parts. */
function sessionWith(results, after = []) {
  return [
    { info: { id: "msg_u1", role: "user", sessionID: "ses_1", model: { providerID: "opencode", modelID: "big-pickle" }, agent: "build" }, parts: [{ type: "text", text: "Add a retry loop" }] },
    { info: { id: "msg_a1", role: "assistant", sessionID: "ses_1" }, parts: results.map((r, i) => ({ id: `prt_${i}`, type: "tool", tool: "plan", callID: `c${i}`, state: { status: "completed", input: {}, output: r.output, metadata: { ...r.metadata, truncated: false } } })) },
    ...after,
  ];
}

test("plan tool applies actions and returns metadata", async () => {
  const { hooks } = await plugin();
  assert.ok(hooks.tool.plan, "the plan tool is registered");
  const r1 = await hooks.tool.plan.execute(BRAINSTORM, ctxFor("ses_p1"));
  assert.match(r1.output, /Brainstorm recorded/);
  assert.equal(r1.metadata.ok, true);
  assert.equal(r1.metadata.action, "brainstorm");
  assert.deepEqual(r1.metadata.events, ["brainstormed"]);
  assert.equal(r1.metadata.plan.brainstorm.chosen, "loop");
  const r2 = await hooks.tool.plan.execute(CREATE, ctxFor("ses_p1"));
  assert.equal(r2.metadata.ok, true);
  assert.deepEqual(r2.metadata.events, ["created"]);
  assert.equal(r2.metadata.plan.milestones[0].steps.length, 2);
  const bad = await hooks.tool.plan.execute({ action: "start", step: "9.9" }, ctxFor("ses_p1"));
  assert.equal(bad.metadata.ok, false);
  assert.match(bad.output, /refused/);
  assert.equal(bad.metadata.plan.milestones.length, 1, "a refused action keeps the plan");
  const other = await hooks.tool.plan.execute({ action: "show" }, ctxFor("ses_other"));
  assert.match(other.output, /No plan yet/, "each session has its own plan");
});

test("plan calls run at once (one OpenCode step) are all recorded", async () => {
  const client = fakeClient();
  const { hooks } = await plugin({ client });
  await hooks.tool.plan.execute(BRAINSTORM, ctxFor("ses_c"));
  await hooks.tool.plan.execute(CREATE, ctxFor("ses_c"));
  const [a, b] = await Promise.all([
    hooks.tool.plan.execute({ action: "skip", step: "1.1", reason: "not needed" }, ctxFor("ses_c")),
    hooks.tool.plan.execute({ action: "skip", step: "1.2", reason: "not needed either" }, ctxFor("ses_c")),
  ]);
  assert.equal(a.metadata.ok && b.metadata.ok, true);
  assert.deepEqual(b.metadata.plan.milestones[0].steps.map((s) => s.status), ["skipped", "skipped"], "the second result holds both");
  // Also on a cold start, when both calls wait for the plan to be rebuilt from the session.
  const r1 = await hooks.tool.plan.execute(BRAINSTORM, ctxFor("ses_cold"));
  const r2 = await hooks.tool.plan.execute(CREATE, ctxFor("ses_cold"));
  const c2 = fakeClient();
  c2.store.set("ses_cold", sessionWith([r1, r2]));
  const fresh = (await plugin({ client: c2 })).hooks;
  const [p, q] = await Promise.all([
    fresh.tool.plan.execute({ action: "start", step: "1.1" }, ctxFor("ses_cold")),
    fresh.tool.plan.execute({ action: "skip", step: "1.2", reason: "b" }, ctxFor("ses_cold")),
  ]);
  assert.equal(p.metadata.ok && q.metadata.ok, true);
  assert.deepEqual(q.metadata.plan.milestones[0].steps.map((s) => s.status), ["active", "skipped"]);
});

test("plan state survives a fresh plugin instance (rebuilt from messages)", async () => {
  const first = await plugin();
  const r1 = await first.hooks.tool.plan.execute(BRAINSTORM, ctxFor("ses_1"));
  const r2 = await first.hooks.tool.plan.execute(CREATE, ctxFor("ses_1"));
  const r3 = await first.hooks.tool.plan.execute({ action: "ask_user", question: "Which log level?" }, ctxFor("ses_1"));
  assert.ok(r3.metadata.plan.waiting);

  // OpenCode restarted: a new plugin instance, nothing in memory, the session's messages hold the tool results.
  const client = fakeClient();
  client.store.set("ses_1", sessionWith([r1, r2, r3]));
  const { hooks } = await plugin({ client });
  const shown = await hooks.tool.plan.execute({ action: "show" }, ctxFor("ses_1"));
  assert.match(shown.output, /WAITING FOR USER: Which log level\?/, "the rebuilt plan is still waiting");
  const started = await hooks.tool.plan.execute({ action: "start", step: "1.1" }, ctxFor("ses_1"));
  assert.equal(started.metadata.ok, true);
  assert.deepEqual(started.metadata.events, ["step_started"]);
  assert.equal(started.metadata.plan.milestones[0].steps[0].status, "active");

  // A real user message after the ask_user answers it; a hook prompt or an agent report does not.
  const answered = (text) => planFromMessages(sessionWith([r1, r2, r3], [{ info: { id: "msg_u2", role: "user" }, parts: [{ type: "text", text }] }]));
  assert.equal(answered("<omni-hook kind=\"goal\">keep going</omni-hook>").waiting.question, "Which log level?");
  assert.equal(answered("[omni-agent-result] Background pi agent a-1 finished").waiting.question, "Which log level?");
  assert.equal(answered("debug, please").waiting, null);

  // chat.message clears it in memory too.
  const live = await plugin({ client: Object.assign(fakeClient(), {}) });
  await live.hooks.tool.plan.execute(BRAINSTORM, ctxFor("ses_w"));
  await live.hooks.tool.plan.execute(CREATE, ctxFor("ses_w"));
  await live.hooks.tool.plan.execute({ action: "ask_user", question: "Which?" }, ctxFor("ses_w"));
  await live.hooks["chat.message"]({ sessionID: "ses_w" }, { message: { id: "msg_x", role: "user" }, parts: [{ type: "text", text: "<omni-hook>continue</omni-hook>" }] });
  assert.match((await live.hooks.tool.plan.execute({ action: "show" }, ctxFor("ses_w"))).output, /WAITING FOR USER/);
  await live.hooks["chat.message"]({ sessionID: "ses_w" }, { message: { id: "msg_y", role: "user" }, parts: [{ type: "text", text: "the info level" }] });
  assert.doesNotMatch((await live.hooks.tool.plan.execute({ action: "show" }, ctxFor("ses_w"))).output, /WAITING FOR USER/);
});

test("system transform includes CONTEXT_GUIDANCE", async () => {
  const { hooks } = await plugin();
  const output = { system: ["You are opencode."] };
  await hooks["experimental.chat.system.transform"]({ sessionID: "ses_s", model: {} }, output);
  assert.equal(output.system[0], "You are opencode.", "the existing prompt is kept in front");
  const added = output.system.slice(1).join("\n");
  assert.ok(added.includes(CONTEXT_GUIDANCE));
  assert.match(added, /use the plan tool before doing the work/);
  assert.doesNotMatch(added, /knowledge graph of/, "no graph note without a graph");
  assert.doesNotMatch(added, /omnidroid tools/, "no omnidroid note without omnidroid");

  // With a built graph in the directory and omnidroid in Omni's opencode.json, both notes are there.
  const dir = join(base, "with-graph");
  mkdirSync(join(dir, "graphify-out"), { recursive: true });
  writeFileSync(join(dir, "graphify-out", "graph.json"), "{}");
  const conf = join(base, "oc-config");
  mkdirSync(conf, { recursive: true });
  writeFileSync(join(conf, "opencode.json"), JSON.stringify({ mcp: { omnidroid: { type: "local", command: ["omni-mcp", "--connect", "http://127.0.0.1:7457/mcp"] } } }));
  const hooks2 = await createOmniPlugin({ tool, root: base, env: { OPENCODE_CONFIG_DIR: conf, OMNI_AGENT_URL: "http://127.0.0.1:9" } })({ client: fakeClient(), directory: dir, worktree: dir });
  const out2 = { system: ["x"] };
  await hooks2["experimental.chat.system.transform"]({ sessionID: "ses_s", model: {} }, out2);
  const text2 = out2.system.join("\n");
  assert.match(text2, /knowledge graph of .*with-graph already exists/);
  assert.match(text2, /omnidroid tools \(omnidroid_\*\)/);
  assert.ok(hooks2.tool.omnidroid_wait_device, "wait_device comes with omnidroid");
  assert.equal(hooks.tool.omnidroid_wait_device, undefined);
});

test("messages transform appends the plan reminder", async () => {
  const { hooks } = await plugin();
  const sid = "ses_m";
  const messages = () => [
    { info: { id: "msg_1", role: "user", sessionID: sid }, parts: [{ id: "prt_1", type: "text", text: "first" }] },
    { info: { id: "msg_2", role: "assistant", sessionID: sid }, parts: [{ id: "prt_2", type: "text", text: "ok" }] },
    { info: { id: "msg_3", role: "user", sessionID: sid, agent: "build", model: { providerID: "opencode", modelID: "big-pickle" }, summary: { diffs: [] } }, parts: [{ id: "prt_3", type: "text", text: "go on" }] },
    { info: { id: "msg_4", role: "assistant", sessionID: sid }, parts: [{ id: "prt_4", type: "tool", tool: "bash", state: { status: "completed" } }] },
  ];
  // No plan yet: nothing is added.
  const none = { messages: messages() };
  await hooks["experimental.chat.messages.transform"]({}, none);
  assert.deepEqual(none.messages, messages());

  await hooks.tool.plan.execute(BRAINSTORM, ctxFor(sid));
  await hooks.tool.plan.execute(CREATE, ctxFor(sid));

  // Mid-loop (the context ends with an assistant step): a synthetic user message at the tail carries it.
  const out = { messages: messages() };
  const before = JSON.stringify(out.messages);
  await hooks["experimental.chat.messages.transform"]({}, out);
  assert.equal(out.messages.length, 5);
  assert.equal(JSON.stringify(out.messages.slice(0, 4)), before, "everything in front of the tail is untouched (prompt cache)");
  const tail = out.messages[4];
  assert.equal(tail.info.role, "user");
  assert.equal(tail.info.id, "msg_4:plan-reminder");
  assert.equal(tail.info.sessionID, sid);
  assert.equal(tail.info.agent, "build", "shaped like the chat's own user messages");
  assert.deepEqual(tail.info.model, { providerID: "opencode", modelID: "big-pickle" });
  assert.equal(tail.parts.length, 1);
  assert.equal(tail.parts[0].type, "text");
  assert.equal(tail.parts[0].messageID, "msg_4:plan-reminder");
  assert.equal(tail.parts[0].synthetic, true);
  assert.match(tail.parts[0].text, /<omni-plan phase="execute" progress="0\/2">/);
  assert.match(tail.parts[0].text, /Now: step 1\.1/);

  // A turn's first call (the context ends with the user's message): the note is an extra part of a copy of it.
  const msgs2 = messages().slice(0, 3);
  const out2 = { messages: [...msgs2] };
  await hooks["experimental.chat.messages.transform"]({}, out2);
  assert.equal(out2.messages.length, 3);
  assert.equal(out2.messages[2].parts.length, 2);
  assert.match(out2.messages[2].parts[1].text, /<omni-plan /);
  assert.equal(msgs2[2].parts.length, 1, "the stored message is not changed (the note is never persisted)");
  assert.equal(out2.messages[0].parts.length, 1, "only the tail gets it");
});

test("agent tools in an OpenCode task child session act for the root chat (identity, delivery)", async () => {
  const omni = await fakeOmni();
  const client = fakeClient();
  client.parents.set("ses_child", "ses_mid");
  client.parents.set("ses_mid", "ses_root");
  client.store.set("ses_root", [{ info: { id: "msg_u1", role: "user", sessionID: "ses_root", agent: "build", model: { providerID: "opencode", modelID: "big-pickle" } }, parts: [{ type: "text", text: "go" }] }]);
  const { hooks } = await plugin({ client, env: { OMNI_AGENT_URL: omni.url } });
  await hooks.tool.agent_start.execute({ task: "Look around", title: "Look" }, ctxFor("ses_child"));
  const post = omni.calls.find((c) => c.method === "POST" && c.path === "/api/agents");
  assert.equal(post.body.parentSid, "pi:ses_root");
  assert.equal(post.body.parentSessionId, "ses_root");
  await until(() => client.prompts.length > 0);
  assert.equal(client.prompts[0].path.id, "ses_root", "the report goes to the chat the user sees, not the finished child session");
  assert.match(client.prompts[0].body.parts[0].text, /^\[omni-agent-result\] /);
  assert.ok(omni.calls.some((c) => c.path === "/api/agents/wait" && c.body.parentSessionId === "ses_root"));
  stopPollers();
});

test("agent_start posts to /api/agents with parentSid pi:<sessionID>", async () => {
  const omni = await fakeOmni();
  const { hooks } = await plugin({ env: { OMNI_AGENT_URL: omni.url } });
  for (const name of ["agent_start", "agent_status", "agent_wait", "agent_message", "agent_cancel", "job_start", "job_wait", "job_output", "job_kill", "claude_task", "memory_search", "memory_recall", "memory_save", "graph_build", "graph_query", "graph_explain"]) {
    assert.ok(hooks.tool[name], `${name} is registered`);
  }
  const r = await hooks.tool.agent_start.execute({ task: "Count the lines of x.js and report the number" }, ctxFor("ses_ag"));
  assert.match(r.output, /Started OpenCode agent a-00000001/);
  assert.equal(r.metadata.id, "a-00000001");
  const post = omni.calls.find((c) => c.method === "POST" && c.path === "/api/agents");
  assert.equal(post.body.parentSid, "pi:ses_ag");
  assert.equal(post.body.parentSessionId, "ses_ag");
  assert.equal(post.body.depth, undefined, "the server derives the depth from the parent agent");
  assert.equal(post.body.kind, "pi");
  assert.equal(post.body.cwd, base);
  assert.equal(post.body.memory, true, "a pi agent gets the vault pack in its system (server-side)");
  assert.equal(post.body.model, "big-pickle", "a pi agent runs on this chat's model");
  assert.equal(post.body.provider, "opencode");
  stopPollers();
});

test("delivery prompts the session with [omni-agent-result]", async () => {
  const omni = await fakeOmni();
  const client = fakeClient();
  const sid = "ses_dl";
  client.store.set(sid, [
    { info: { id: "msg_u1", role: "user", sessionID: sid, agent: "build", model: { providerID: "opencode", modelID: "big-pickle" }, system: "You are a scout.", tools: { read: true, plan: true } }, parts: [{ type: "text", text: "go" }] },
  ]);
  const { hooks } = await plugin({ client, env: { OMNI_AGENT_URL: omni.url } });
  await hooks.tool.agent_start.execute({ task: "Look around", title: "Look" }, ctxFor(sid));
  await until(() => client.prompts.length > 0);
  const p = client.prompts[0];
  assert.equal(p.path.id, sid);
  assert.equal(p.body.parts.length, 1);
  assert.match(p.body.parts[0].text, /^\[omni-agent-result\] Background OpenCode agent a-00000001 "Look" finished: done/);
  assert.match(p.body.parts[0].text, /report of a-00000001/);
  assert.deepEqual(p.body.model, { providerID: "opencode", modelID: "big-pickle" }, "the chat's own model, not OpenCode's global default");
  assert.equal(p.body.agent, "build");
  assert.equal(p.body.system, "You are a scout.", "an agent chat keeps its persona");
  assert.deepEqual(p.body.tools, { read: true, plan: true });
  await until(() => omni.calls.some((c) => c.path === "/api/agents/a-00000001/delivered"));
  await sleep(50);
  assert.equal(client.prompts.length, 1, "a report is delivered once");
  stopPollers();
});
