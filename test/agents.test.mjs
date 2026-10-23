import { test, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../server/bus.mjs";
import { ClaudeRunner } from "../server/claude-runner.mjs";
import { AgentManager, AGENT_FOOTER, cleanLog, defaultShell, parsePersona } from "../server/agents.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 3000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error("timed out waiting"); await sleep(5); } };
const base = mkdtempSync(join(tmpdir(), "omni-agents-"));
after(() => { try { rmSync(base, { recursive: true, force: true }); } catch { /* a log may still be open on Windows */ } });
let dirs = 0;
const fresh = () => { const d = join(base, `t${++dirs}`); mkdirSync(d, { recursive: true }); return d; };

/** OpencodeRpc stand-ins: they record what the manager asks and emit bus events under their sid like the real one. */
function piFactory(bus) {
  const made = [];
  const createPi = (opts) => {
    const n = made.length + 1, id = `sess${n}`;
    const pi = Object.assign(new EventEmitter(), {
      opts, sid: "pi:pending", streaming: false, state: null, proc: { pid: 1000 + n }, prompts: [], switched: [], stops: 0, started: false,
      start() { this.started = true; return this; },
      waitReady() { this.sid = `pi:${id}`; this.state = { sessionId: id, sessionFile: `/sessions/${id}.jsonl` }; return Promise.resolve(this.state); },
      async switchSession(f) { this.switched.push(f); const s = f.split("/").pop().replace(".jsonl", ""); this.sid = `pi:${s}`; this.state = { sessionId: s, sessionFile: f }; return { success: true }; },
      async prompt(text, o = {}) { this.prompts.push({ text, ...o }); return { success: true }; },
      async abort() { return { success: true }; },
      stop() { this.stops++; this.proc = null; },
      owns(f) { return !!this.proc && this.state?.sessionFile === f; },
      // drivers
      stream(on) { this.streaming = on; bus.emit({ sid: this.sid, harness: "pi", kind: "status", ts: Date.now(), streaming: on }); },
      say(text, { calls = [], cost } = {}) {
        bus.emit({ sid: this.sid, harness: "pi", kind: "msg", ts: Date.now(), id: `m-${Math.random()}`, role: "assistant", live: true, cost, blocks: [...calls.map((c) => ({ type: "tool_call", toolId: "t", name: c.name, args: c.args })), ...(text ? [{ type: "text", text }] : [])] });
      },
      goal(patch) { bus.emit({ sid: this.sid, harness: "pi", kind: "goal", ts: Date.now(), done: false, paused: false, ...patch }); },
      crash(code = 1) { this.proc = null; this.emit("exit", code); },
    });
    made.push(pi);
    return pi;
  };
  return { createPi, made };
}

function claudeSpawn(calls) {
  return (bin, args, opts) => {
    const p = new EventEmitter();
    p.stdout = new PassThrough(); p.stderr = new PassThrough(); p.stdin = new PassThrough();
    p.pid = 4200 + calls.length; p.kill = () => p.emit("exit", 1);
    calls.push({ bin, args, opts, proc: p });
    return p;
  };
}
const stdinLines = (proc) => { const out = []; let buf = ""; proc.stdin.on("data", (c) => { buf += c; let i; while ((i = buf.indexOf("\n")) >= 0) { out.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } }); return out; };
const emitLine = (proc, obj) => proc.stdout.write(`${JSON.stringify(obj)}\n`);

function setup({ config = {}, keeper = null, claude, opts = {}, bus = new Bus() } = {}) {
  const dir = fresh();
  const killed = [];
  const pis = piFactory(bus);
  const piAgentDir = join(dir, "pi-agent");
  mkdirSync(join(piAgentDir, "agents"), { recursive: true });
  writeFileSync(join(piAgentDir, "agents", "scout.md"), "---\nname: scout\ndescription: Fast read-only reconnaissance.\ntools: read, grep, find\nmodel: openrouter/qwen-fast\n---\n\nYou are a reconnaissance agent.\nReport file:line references.\n");
  writeFileSync(join(piAgentDir, "agents", "re.md"), "---\nname: re-analyst\ndescription: RE.\ntools: [read, bash]\n---\nYou analyse binaries.\n");
  const m = new AgentManager({
    bus, config: { maxConcurrent: 6, maxDepth: 2, maxMinutes: 360, claudeModel: "", claudeMaxTurns: 300, claudePermissionMode: "bypassPermissions", ...config },
    file: join(dir, "agents.json"), dir: join(dir, "logs"), personasDir: join(piAgentDir, "agents"), createPi: pis.createPi, claude, keeper, cwd: dir, piEnv: { OPENROUTER_API_KEY: "k" },
    killTree: (pid) => { killed.push(pid); }, idleDoneMs: 30, graceMs: 5, saveDelayMs: 10, pollMs: 15, ...opts,
  });
  return { m, bus, dir, killed, pis, piAgentDir };
}
const fakeKeeper = () => { const goals = []; return { goals, setManagedGoal(sid, text) { goals.push({ sid, text }); } }; };
const nodeShell = { shellPath: process.execPath, shellArgs: ["-e"] };

// ------------------------------------------------------------------ pure helpers
test("parsePersona reads the frontmatter (tools as a list or a string) and keeps the body as the system prompt", () => {
  assert.deepEqual(parsePersona("---\nname: scout\ndescription: \"Finds things\"\ntools: read, grep , find\nmodel: m1\n---\n\nBody line 1\nBody line 2\n"),
    { name: "scout", description: "Finds things", tools: ["read", "grep", "find"], model: "m1", body: "Body line 1\nBody line 2" });
  assert.deepEqual(parsePersona("\uFEFF---\r\nname: x\r\ntools: [read, 'bash']\r\n---\r\nB").tools, ["read", "bash"]);
  assert.deepEqual(parsePersona("no frontmatter here"), { name: "", description: "", tools: [], model: "", body: "no frontmatter here" });
});

test("cleanLog drops colour codes and keeps what a carriage-return progress line last showed", () => {
  assert.equal(cleanLog("\u001b[32mok\u001b[0m\n10%\r50%\r100%\ndone\r\n"), "ok\n100%\ndone\n");
});

test("defaultShell finds Git Bash on Windows and falls back to bash", () => {
  const seen = [];
  const found = defaultShell({ platform: "win32", env: { ProgramFiles: "D:\\PF" }, exists: (p) => { seen.push(p); return p.startsWith("D:"); } });
  assert.equal(found, join("D:\\PF", "Git", "bin", "bash.exe"));
  assert.equal(defaultShell({ platform: "win32", env: {}, exists: () => false }), "bash");
  assert.equal(defaultShell({ platform: "linux" }), "bash");
});

// ------------------------------------------------------------------ spec validation
test("start() rejects a bad spec with a 400 and a clear message", () => {
  const { m } = setup();
  const throws400 = (spec, re) => assert.throws(() => m.start(spec), (e) => e.status === 400 && re.test(e.message));
  throws400({ kind: "robot", task: "x" }, /unknown agent kind "robot"/);
  throws400({ kind: "pi", task: "  " }, /needs a task/);
  throws400({ kind: "shell", command: "" }, /needs a command/);
  throws400({ task: "x", agent: "ghost" }, /unknown agent persona "ghost" \(known: .*scout/);
  throws400({ task: "x", agent: "../etc" }, /bad agent persona name/);
  throws400({ task: "x", cwd: join(base, "does-not-exist") }, /working directory not found/);
  throws400({ kind: "shell", command: "ls", agent: "scout" }, /takes no agent persona/);
  assert.equal(m.list().length, 0, "nothing was recorded");
  m.dispose();
});

test("depth: the chat (0) and its agents (1) may start agents; an agent at depth 2 may not (maxDepth 2); shell jobs are exempt", async () => {
  const { m, pis } = setup({ opts: nodeShell });
  const a = m.start({ task: "look around", depth: 0 });
  const b = m.start({ task: "look deeper", depth: 1 });
  assert.equal(a.depth, 1);
  assert.equal(b.depth, 2);
  assert.throws(() => m.start({ task: "even deeper", depth: 2 }), (e) => e.status === 400 && /nest at most 2 deep/.test(e.message) && /do this work yourself/.test(e.message));
  const job = m.start({ kind: "shell", command: "1", depth: 2, timeoutMinutes: 1 });
  assert.equal(job.kind, "shell");
  await sleep(10);
  assert.equal(pis.made[1].opts.env.OMNI_AGENT_DEPTH, "2", "the child learns its own depth");
  await m.stopAll();
  m.dispose();
});

test("depth: without one in the spec, the caller's depth comes from its parent agent's record (an agent's own chat → its depth; any other chat → 0)", async () => {
  const { m } = setup({ opts: nodeShell });
  const a = m.start({ task: "look around", parentSid: "pi:main" });
  assert.equal(a.depth, 1, "started by a chat that is not an agent");
  await until(() => m.get(a.id).status === "running");
  const aSid = m.get(a.id).sid;
  const b = m.start({ task: "look deeper", parentSid: aSid });
  assert.equal(b.depth, 2, "started by agent a (depth 1)");
  await until(() => m.get(b.id).status === "running");
  const bSid = m.get(b.id).sid;
  assert.throws(() => m.start({ task: "even deeper", parentSid: bSid }), (e) => e.status === 400 && /nest at most 2 deep/.test(e.message));
  assert.equal(m.start({ kind: "shell", command: "1", parentSid: bSid, timeoutMinutes: 1 }).depth, 2, "a job sits at its caller's level");
  assert.equal(m.start({ task: "explicit", parentSid: aSid, depth: 0 }).depth, 1, "a depth in the spec still wins");
  await m.stopAll();
  m.dispose();
});

test("pi agent asked for memory gets the vault pack in its system prompt, after its persona (composeSystem, like Claude agents)", async () => {
  const asked = [];
  const pack = "Relevant durable memory from the user's Omni vault:\n- the parser lives in src/p.js";
  const { m, pis } = setup({ opts: { composeSystem: async (rec, text) => { asked.push({ id: rec.id, text }); return pack; } } });
  const rec = m.start({ task: "Find the parser", agent: "scout", memory: true });
  await until(() => pis.made.length === 1 && pis.made[0].prompts.length === 1);
  assert.equal(pis.made[0].opts.system, `You are a reconnaissance agent.\nReport file:line references.\n\n${pack}`);
  assert.deepEqual(asked, [{ id: rec.id, text: "Find the parser" }]);
  m.start({ task: "plain", memory: true });
  await until(() => pis.made.length === 2);
  assert.equal(pis.made[1].opts.system, pack);
  m.start({ task: "no memory" });
  await until(() => pis.made.length === 3);
  assert.equal(pis.made[2].opts.system, "");
  assert.equal(asked.length, 2, "asked only when memory was requested");
  await m.stopAll();
  m.dispose();
});

// ------------------------------------------------------------------ pi agents
test("pi agent: persona → system prompt + tool allowlist, persona model, env identity, meta, managed goal, prompt with the footer", async () => {
  const keeper = fakeKeeper();
  const { m, pis, dir } = setup({ keeper });
  const rec = m.start({ task: "Find where the parser lives.", agent: "scout", parentSid: "pi:parent", parentSessionId: "parent", depth: 0, title: "Find the parser" });
  assert.equal(rec.status, "starting");
  assert.match(rec.id, /^a-[0-9a-f]{8}$/);
  await until(() => m.get(rec.id).status === "running");
  const pi = pis.made[0];
  // The tools are an allowlist over plugin tools too, so the keeper's plan tool is always kept.
  assert.equal(pi.opts.system, "You are a reconnaissance agent.\nReport file:line references.");
  assert.deepEqual(pi.opts.tools, ["read", "grep", "find", "plan"]);
  assert.equal("extraArgs" in pi.opts, false);
  assert.equal(pi.opts.model, "openrouter/qwen-fast", "the persona's model applies when the spec names none");
  assert.equal(pi.opts.provider, "");
  assert.equal(pi.opts.cwd, dir);
  assert.deepEqual(pi.opts.env, { OPENROUTER_API_KEY: "k", OMNI_AGENT_ID: rec.id, OMNI_AGENT_DEPTH: "1", OMNI_PARENT_SID: "pi:parent" });
  assert.deepEqual(pi.opts.meta, { parentSid: "pi:parent", agentId: rec.id, agentKind: "pi" });
  assert.ok(pi.started);
  assert.deepEqual(keeper.goals, [{ sid: "pi:sess1", text: "Find where the parser lives." }]);
  assert.deepEqual(pi.prompts, [{ text: `Find where the parser lives.${AGENT_FOOTER}`, echo: true }]);
  const r = m.get(rec.id);
  assert.equal(r.sid, "pi:sess1");
  assert.equal(r.sessionId, "sess1");
  assert.equal(r.sessionFile, "/sessions/sess1.jsonl");
  assert.equal(r.pid, 1001);
  assert.equal(r.title, "Find the parser");
  assert.equal(r.agent, "scout");
  // spec.model wins over the persona's
  m.start({ task: "x", agent: "re-analyst", model: "deepseek/v4", provider: "openrouter" });
  await until(() => pis.made.length === 2);
  assert.equal(pis.made[1].opts.model, "deepseek/v4");
  assert.equal(pis.made[1].opts.provider, "openrouter");
  assert.deepEqual([pis.made[1].opts.system, pis.made[1].opts.tools], ["You analyse binaries.", ["read", "bash", "plan"]], "found by its frontmatter name");
  // without a persona: no system prompt, every tool
  m.start({ task: "plain" });
  await until(() => pis.made.length === 3);
  assert.deepEqual([pis.made[2].opts.system, pis.made[2].opts.tools], ["", null]);
  await m.stopAll();
  m.dispose();
});

test("pi agent: live events fill resultText, toolCalls, activity, turns, cost; its goal event says done → done and the child is freed", async () => {
  const keeper = fakeKeeper();
  const { m, pis, bus, killed } = setup({ keeper });
  const agentEvents = [];
  bus.on("event", (ev) => { if (ev.kind === "agent") agentEvents.push(ev); });
  const rec = m.start({ task: "Count the files", parentSid: "pi:parent", parentSessionId: "parent" });
  await until(() => m.get(rec.id).status === "running");
  const pi = pis.made[0];
  pi.stream(true);
  pi.say("", { calls: [{ name: "bash", args: { command: "find . -type f | wc -l" } }], cost: 0.01 });
  pi.say("There are 42 files.", { cost: 0.02 });
  pi.stream(false);
  let r = m.get(rec.id);
  assert.equal(r.toolCalls, 1);
  assert.equal(r.turns, 2);
  assert.ok(Math.abs(r.cost - 0.03) < 1e-9);
  assert.equal(r.resultText, "There are 42 files.");
  assert.deepEqual(r.activity, ['bash({"command":"find . -type f | wc -l"})', "There are 42 files."]);
  await sleep(60);
  assert.equal(m.get(rec.id).status, "running", "with a keeper, a pause in streaming is not the end");
  assert.equal(m.activeChildren("pi:parent"), 1);
  pi.goal({ done: true, reason: "plan complete" });
  r = m.get(rec.id);
  assert.equal(r.status, "done");
  assert.ok(r.endedAt >= r.startedAt);
  assert.equal(r.delivered, false);
  assert.equal(m.activeChildren("pi:parent"), 0);
  assert.deepEqual(killed, [1001], "the child's process tree is killed to free its memory");
  await sleep(20);
  assert.equal(pi.stops, 1, "then OpencodeRpc.stop() as the backstop");
  assert.equal(m.piFor("pi:sess1"), null);
  assert.ok(agentEvents.length >= 4);
  assert.ok(agentEvents.every((e) => e.sid === "pi:parent" && e.harness === "omni" && e.agent.id === rec.id));
  assert.equal(agentEvents.at(-1).agent.status, "done");
  m.dispose();
});

test("bus agent events: status changes go out at once, activity at most every 500 ms (trailing), the report as a 2000-char preview", async () => {
  const { m, pis, bus } = setup({ keeper: fakeKeeper() });
  const seen = [];
  bus.on("event", (ev) => { if (ev.kind === "agent") seen.push(ev.agent); });
  const changes = [];
  m.on("change", (a) => changes.push(a));
  const rec = m.start({ task: "write a long report" });
  await until(() => m.get(rec.id).status === "running");
  assert.deepEqual(seen.map((a) => a.status), ["queued", "starting", "running"]);
  const long = "R".repeat(5000);
  for (let i = 0; i < 10; i++) pis.made[0].say(i === 9 ? long : `step ${i}`);
  assert.equal(seen.length, 3, "ten messages inside the window: nothing yet");
  assert.ok(changes.length >= 13, "the in-process change event is not throttled");
  await sleep(600);
  assert.equal(seen.length, 4, "one trailing event");
  assert.equal(seen[3].activity.at(-1).startsWith("RRR"), true);
  assert.ok(seen[3].resultText.length <= 2000, "a preview on the bus");
  assert.equal(m.get(rec.id).resultText, long, "the whole report over HTTP");
  pis.made[0].goal({ done: true });
  assert.equal(seen.at(-1).status, "done", "the end is never held back");
  m.dispose();
});

test("pi agent: a short sign-off after the report keeps the report", async () => {
  const { m, pis } = setup({ keeper: fakeKeeper() });
  const rec = m.start({ task: "investigate" });
  await until(() => m.get(rec.id).status === "running");
  const report = `## Findings\n${"The loader lives in src/load.mjs:42 and is called from three places. ".repeat(6)}`;
  pis.made[0].say(report);
  pis.made[0].say("Done.");
  pis.made[0].goal({ done: true });
  assert.equal(m.get(rec.id).resultText, `${report.trim()}\n\nDone.`);
  m.dispose();
});

test("pi agent: the keeper pausing its goal → stalled, with the reason", async () => {
  const { m, pis } = setup({ keeper: fakeKeeper() });
  const rec = m.start({ task: "loop forever" });
  await until(() => m.get(rec.id).status === "running");
  pis.made[0].goal({ paused: true, reason: "5 re-engagements without progress" });
  const r = m.get(rec.id);
  assert.equal(r.status, "stalled");
  assert.match(r.error, /5 re-engagements without progress/);
  m.dispose();
});

test("pi agent without a keeper: done once it stops streaming for idleDoneMs; streaming again cancels; running children keep it alive", async () => {
  const { m, pis } = setup();
  const rec = m.start({ task: "quick job" });
  await until(() => m.get(rec.id).status === "running");
  const pi = pis.made[0];
  pi.stream(false);
  await sleep(50);
  assert.equal(m.get(rec.id).status, "running", "a not-streaming status before it ever streamed is not an end");
  pi.stream(true);
  pi.stream(false);
  await sleep(10);
  pi.stream(true);
  await sleep(50);
  assert.equal(m.get(rec.id).status, "running", "it streamed again within the grace");
  // A child of this agent is still running: the parent must stay alive to receive its report.
  const child = m.start({ task: "sub-task", parentSid: pi.sid, depth: 1 });
  await until(() => m.get(child.id).status === "running");
  pi.stream(false);
  await sleep(80);
  assert.equal(m.get(rec.id).status, "running", "waiting for its child");
  await m.cancel(child.id);
  await until(() => m.get(rec.id).status === "done", 1000);
  m.dispose();
});

test("pi agent: a child that dies is reported as an error and not relaunched", async () => {
  const { m, pis } = setup({ keeper: fakeKeeper() });
  const rec = m.start({ task: "crashy" });
  await until(() => m.get(rec.id).status === "running");
  pis.made[0].crash(3);
  const r = m.get(rec.id);
  assert.equal(r.status, "error");
  assert.match(r.error, /exited unexpectedly \(code 3\)/);
  assert.equal(r.exitCode, 3);
  assert.equal(pis.made[0].stops, 1, "stop() inside the exit event keeps OpencodeRpc from reattaching it");
  m.dispose();
});

test("pi agent: a prompt pi refuses ends it with the error", async () => {
  const { m, pis } = setup({ keeper: fakeKeeper() });
  const orig = pis.createPi;
  m.createPi = (o) => { const pi = orig(o); pi.prompt = async () => ({ success: false, error: "No API key for provider" }); return pi; };
  const rec = m.start({ task: "x" });
  await until(() => m.get(rec.id).status === "error");
  assert.match(m.get(rec.id).error, /could not start: No API key/);
  m.dispose();
});

test("concurrency: past maxConcurrent agents queue and start oldest first as slots free up", async () => {
  const { m, pis } = setup({ keeper: fakeKeeper(), config: { maxConcurrent: 1 } });
  const a = m.start({ task: "A" }), b = m.start({ task: "B" }), c = m.start({ task: "C" });
  assert.equal(a.status, "starting");
  assert.equal(b.status, "queued");
  assert.equal(c.status, "queued");
  await until(() => m.get(a.id).status === "running");
  pis.made[0].goal({ done: true });
  await until(() => m.get(b.id).status === "running");
  assert.equal(m.get(c.id).status, "queued");
  assert.equal(pis.made[1].prompts[0].text.startsWith("B"), true);
  await m.cancel(c.id);
  assert.equal(m.get(c.id).status, "cancelled", "a queued agent can be cancelled before it ever starts");
  assert.equal(pis.made.length, 2);
  m.dispose();
});

test("message(): queued → added to the task; streaming → followUp (steer on request); idle → a new run; finished → restarted on its session", async () => {
  const keeper = fakeKeeper();
  const { m, pis } = setup({ keeper, config: { maxConcurrent: 1 } });
  const a = m.start({ task: "first" });
  const q = m.start({ task: "queued task" });
  assert.deepEqual(await m.message(q.id, "and also this"), { ok: true, how: "followUp" });
  await until(() => m.get(a.id).status === "running");
  const pi = pis.made[0];
  pi.streaming = true;
  assert.deepEqual(await m.message(a.id, "focus on src/"), { ok: true, how: "followUp" });
  assert.deepEqual(await m.message(a.id, "stop that", { steer: true }), { ok: true, how: "steer" });
  pi.streaming = false;
  assert.deepEqual(await m.message(a.id, "one more thing"), { ok: true, how: "followUp" });
  assert.deepEqual(pi.prompts.slice(1).map((p) => [p.text, p.behavior, p.echo]), [["focus on src/", "followUp", true], ["stop that", "steer", true], ["one more thing", "followUp", true]]);
  pi.goal({ done: true });
  await until(() => m.get(q.id).status === "running");
  assert.equal(pis.made[1].prompts[0].text, `queued task\n\nand also this${AGENT_FOOTER}`);
  pis.made[1].goal({ done: true });
  // a finished agent continues its own session
  assert.deepEqual(await m.message(a.id, "now write the report to notes.md"), { ok: true, how: "restarted" });
  await until(() => m.get(a.id).status === "running");
  const again = pis.made[2];
  assert.deepEqual(again.switched, ["/sessions/sess1.jsonl"]);
  assert.equal(m.get(a.id).sid, "pi:sess1", "same chat as before");
  assert.equal(again.prompts[0].text, `now write the report to notes.md${AGENT_FOOTER}`);
  assert.deepEqual(keeper.goals.at(-1), { sid: "pi:sess1", text: "now write the report to notes.md" });
  assert.equal(m.get(a.id).delivered, false);
  await assert.rejects(m.message(a.id, "  "), (e) => e.status === 400);
  await assert.rejects(m.message("a-ffffffff", "x"), (e) => e.status === 404);
  await m.stopAll();
  m.dispose();
});

test("timeout: an agent past its limit is stopped with status timeout", async () => {
  const long = [];
  const setTimer = (fn, ms) => { if (ms >= 60000) { const t = { fn, ms, unref() {} }; long.push(t); return t; } return setTimeout(fn, ms); };
  const clearTimer = (t) => { const i = long.indexOf(t); if (i >= 0) long.splice(i, 1); else clearTimeout(t); };
  const { m, pis, killed } = setup({ keeper: fakeKeeper(), opts: { setTimer, clearTimer } });
  const rec = m.start({ task: "slow", timeoutMinutes: 2 });
  await until(() => m.get(rec.id).status === "running");
  const t = long.find((x) => x.ms === 120000);
  assert.ok(t, "a 2-minute timer was armed");
  t.fn();
  await sleep(5);
  const r = m.get(rec.id);
  assert.equal(r.status, "timeout");
  assert.match(r.error, /2-minute limit/);
  assert.deepEqual(killed, [1001]);
  const d = m.start({ task: "default limit" });
  await until(() => m.get(d.id).status === "running");
  assert.ok(long.some((x) => x.ms === 360 * 60000), "config.maxMinutes is the default");
  await m.stopAll();
  m.dispose();
  assert.equal(pis.made.length, 2);
});

// ------------------------------------------------------------------ Claude agents
test("claude agent: an interactive autonomous run with the footer; its result + exit → done with the result text", async () => {
  const calls = [];
  const bus = new Bus();
  const claude = new ClaudeRunner({ bin: "claude", bus, spawn: claudeSpawn(calls) });
  const { m } = setup({ claude, bus, config: { claudeModel: "opus", claudeMaxTurns: 77 } });
  const rec = m.start({ kind: "claude", task: "Refactor the parser", parentSid: "pi:p", parentSessionId: "p", title: "Refactor" });
  assert.equal(rec.status, "running");
  const { args, proc } = calls[0];
  const sent = stdinLines(proc);
  assert.ok(args.includes("--input-format") && args.includes("--dangerously-skip-permissions"));
  assert.equal(args[args.indexOf("--permission-prompts") + 1], "none");
  assert.equal(args[args.indexOf("--model") + 1], "opus");
  assert.equal(args[args.indexOf("--max-turns") + 1], "77");
  assert.equal(args[args.indexOf("--name") + 1], "Refactor");
  await sleep(10);
  assert.equal(sent[0].message.content[0].text, `Refactor the parser${AGENT_FOOTER}`);
  const r0 = m.get(rec.id);
  assert.equal(r0.sid, `claude:${r0.sessionId}`);
  assert.equal(r0.pid, 4200);
  emitLine(proc, { type: "assistant", message: { id: "m1", role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Edit", input: { file_path: "src/parser.mjs" } }] } });
  emitLine(proc, { type: "result", subtype: "success", is_error: false, num_turns: 9, result: "Refactored src/parser.mjs; tests pass.", total_cost_usd: 1.5, session_id: r0.sessionId });
  await sleep(10);
  assert.equal(m.get(rec.id).status, "running", "running until the process exits");
  assert.equal(m.get(rec.id).toolCalls, 1);
  proc.emit("exit", 0);
  const r = m.get(rec.id);
  assert.equal(r.status, "done");
  assert.equal(r.resultText, "Refactored src/parser.mjs; tests pass.");
  assert.equal(r.turns, 9);
  assert.equal(r.cost, 1.5);
  assert.equal(r.exitCode, 0);
  m.dispose();
});

test("claude agent: an error result → error; an exit without any result → error with the code", async () => {
  const calls = [];
  const bus = new Bus();
  const claude = new ClaudeRunner({ bin: "claude", bus, spawn: claudeSpawn(calls) });
  const { m } = setup({ claude, bus });
  const a = m.start({ kind: "claude", task: "x" });
  emitLine(calls[0].proc, { type: "result", subtype: "error_max_turns", is_error: true, num_turns: 300, result: "" });
  await sleep(10);
  calls[0].proc.emit("exit", 1);
  assert.equal(m.get(a.id).status, "error");
  assert.match(m.get(a.id).error, /^error_max_turns/);
  const b = m.start({ kind: "claude", task: "y" });
  calls[1].proc.emit("exit", 2);
  assert.equal(m.get(b.id).status, "error");
  assert.equal(m.get(b.id).error, "claude exited with code 2");
  m.dispose();
});

test("claude agent: message while it runs steers it; after it exited the session is resumed with --resume", async () => {
  const calls = [];
  const bus = new Bus();
  const claude = new ClaudeRunner({ bin: "claude", bus, spawn: claudeSpawn(calls) });
  const { m } = setup({ claude, bus });
  const rec = m.start({ kind: "claude", task: "build" });
  const sent = stdinLines(calls[0].proc);
  assert.deepEqual(await m.message(rec.id, "use the new API"), { ok: true, how: "steer" });
  await sleep(10);
  assert.equal(sent[1].message.content[0].text, "use the new API");
  calls[0].proc.emit("exit", 0);
  assert.equal(m.get(rec.id).status, "done");
  const sessionId = m.get(rec.id).sessionId;
  assert.deepEqual(await m.message(rec.id, "now add docs"), { ok: true, how: "resumed" });
  assert.equal(calls.length, 2);
  const a2 = calls[1].args;
  assert.equal(a2[a2.indexOf("--resume") + 1], sessionId);
  assert.ok(!a2.includes("--session-id"));
  const sent2 = stdinLines(calls[1].proc);
  await sleep(10);
  assert.equal(sent2[0].message.content[0].text, `now add docs${AGENT_FOOTER}`);
  const r = m.get(rec.id);
  assert.equal(r.status, "running");
  assert.equal(r.sid, `claude:${sessionId}`);
  assert.equal(r.delivered, false);
  m.dispose();
});

test("claude agent: a message while the run winds down (stdin closed) resumes it once it has exited", async () => {
  const calls = [];
  const bus = new Bus();
  const claude = new ClaudeRunner({ bin: "claude", bus, spawn: claudeSpawn(calls) });
  const { m } = setup({ claude, bus });
  const rec = m.start({ kind: "claude", task: "build" });
  emitLine(calls[0].proc, { type: "result", subtype: "success", is_error: false, num_turns: 2, result: "built" });
  await sleep(10);
  assert.equal(calls[0].proc.stdin.writableEnded, true);
  assert.deepEqual(await m.message(rec.id, "one more change"), { ok: true, how: "resumed" });
  assert.equal(calls.length, 1, "nothing is spawned while the old process is alive");
  calls[0].proc.emit("exit", 0);
  await until(() => calls.length === 2);
  assert.ok(calls[1].args.includes("--resume"));
  assert.equal(m.get(rec.id).status, "running");
  m.dispose();
});

test("claude agent: every message that arrives while the run winds down reaches the resumed run, in order", async () => {
  const calls = [];
  const bus = new Bus();
  const claude = new ClaudeRunner({ bin: "claude", bus, spawn: claudeSpawn(calls) });
  const { m } = setup({ claude, bus });
  const rec = m.start({ kind: "claude", task: "build" });
  emitLine(calls[0].proc, { type: "result", subtype: "success", is_error: false, num_turns: 2, result: "built" });
  await sleep(10);
  assert.deepEqual(await m.message(rec.id, "first follow-up"), { ok: true, how: "resumed" });
  assert.deepEqual(await m.message(rec.id, "second follow-up"), { ok: true, how: "resumed" });
  calls[0].proc.emit("exit", 0);
  await until(() => calls.length === 2);
  const sent = stdinLines(calls[1].proc);
  await sleep(10);
  assert.equal(sent[0].message.content[0].text, `first follow-up\n\nsecond follow-up${AGENT_FOOTER}`);
  m.dispose();
});

test("claude agent: a claude that cannot be spawned (not on PATH) is an error at once, not 'running' until its timeout", async () => {
  const bus = new Bus();
  const claude = new ClaudeRunner({ bin: "omni-no-such-claude-binary-xyz", bus });
  const { m } = setup({ claude, bus });
  const rec = m.start({ kind: "claude", task: "do it", parentSid: "pi:p" });
  await until(() => m.get(rec.id).status !== "running", 5000);
  const r = m.get(rec.id);
  assert.equal(r.status, "error");
  assert.match(r.error, /^claude could not start: .*ENOENT/);
  assert.equal(m.activeChildren("pi:p"), 0, "the slot and the parent's wait are freed");
  m.dispose();
});

test("claude agent: cancel interrupts it, closes stdin and tree-kills it after the runner's grace", async () => {
  const calls = [], trees = [];
  const bus = new Bus();
  const claude = new ClaudeRunner({ bin: "claude", bus, spawn: claudeSpawn(calls), graceMs: 20, killTree: (pid) => { trees.push(pid); } });
  const { m } = setup({ claude, bus });
  const rec = m.start({ kind: "claude", task: "long" });
  const sent = stdinLines(calls[0].proc);
  const r = await m.cancel(rec.id);
  assert.equal(r.status, "cancelled");
  await sleep(10);
  assert.equal(sent.at(-1).request.subtype, "interrupt");
  assert.equal(calls[0].proc.stdin.writableEnded, true);
  await sleep(40);
  assert.deepEqual(trees, [4200]);
  assert.equal(m.get(rec.id).status, "cancelled", "the exit that follows changes nothing");
  m.dispose();
});

// ------------------------------------------------------------------ shell jobs

test("shell job: output lands in its log, waitFor matches a line, a non-zero exit is an error with the log tail", async () => {
  const { m, dir } = setup({ opts: nodeShell });
  const job = m.start({ kind: "shell", command: "console.log('booting'); setTimeout(() => console.log('\\u001b[32mREADY\\u001b[0m on port 5555'), 150); setTimeout(() => { console.error('bye'); process.exit(3); }, 400);", title: "boot" });
  assert.equal(job.kind, "shell");
  assert.equal(job.logFile, join(dir, "logs", `${job.id}.log`));
  const w = await m.waitFor(job.id, { until: "READY on port \\d+", timeoutMs: 10000 });
  assert.equal(w.matched, true);
  assert.equal(w.status, "running");
  assert.match(w.tail, /booting/);
  const w2 = await m.waitFor(job.id, { until: "never printed", timeoutMs: 10000 });
  assert.equal(w2.matched, false, "the job ended first");
  assert.equal(w2.status, "error");
  const r = m.get(job.id);
  assert.equal(r.exitCode, 3);
  assert.equal(r.error, "exit code 3");
  assert.match(r.resultText, /READY on port 5555\nbye/);
  assert.doesNotMatch(r.resultText, /\u001b/);
  assert.equal(m.readLog(job.id, { tailLines: 1 }), "bye");
  assert.ok(existsSync(r.logFile));
  m.dispose();
});

test("shell job: exit 0 → done; waitFor times out; a bad regular expression is a 400", async () => {
  const { m } = setup({ opts: nodeShell });
  const job = m.start({ kind: "shell", command: "setTimeout(() => console.log('ok'), 300)" });
  const w = await m.waitFor(job.id, { until: "zzz", timeoutMs: 50 });
  assert.equal(w.matched, false);
  assert.equal(w.status, "running");
  await assert.rejects(m.waitFor(job.id, { until: "(" }), (e) => e.status === 400);
  const done = await m.wait({ ids: [job.id], timeoutMs: 10000 });
  assert.equal(done.finished[0].status, "done");
  assert.equal(done.finished[0].resultText, "ok");
  m.dispose();
});

test("shell job: a shell that cannot be spawned is an error", async () => {
  const { m } = setup({ opts: { shellPath: join(base, "no-such-shell.exe") } });
  const job = m.start({ kind: "shell", command: "echo" });
  await until(() => m.get(job.id).status === "error");
  assert.match(m.get(job.id).error, /could not (run the shell|start)/);
  m.dispose();
});

test("shell job: cancel kills the whole process tree (real taskkill / kill)", async () => {
  const { m } = setup({ opts: { ...nodeShell, killTree: undefined } });
  const job = m.start({ kind: "shell", command: "console.log('up'); setInterval(() => {}, 1000)" });
  await m.waitFor(job.id, { until: "up", timeoutMs: 10000 });
  const r = await m.cancel(job.id);
  assert.equal(r.status, "cancelled");
  await until(() => m.rt.get(job.id).proc === null, 10000);
  assert.equal(m.get(job.id).status, "cancelled");
  assert.equal(m.get(job.id).resultText, "up");
  m.dispose();
});

test("shell job: its timeout (default 120 min) tree-kills it with status timeout", async () => {
  const long = [];
  const setTimer = (fn, ms) => { if (ms >= 60000) { const t = { fn, ms, unref() {} }; long.push(t); return t; } return setTimeout(fn, ms); };
  const clearTimer = (t) => { const i = long.indexOf(t); if (i >= 0) long.splice(i, 1); else clearTimeout(t); };
  const procs = [];
  const spawn = (bin, args, opts) => { const p = Object.assign(new EventEmitter(), { pid: 777, exitCode: null, signalCode: null, kill() { p.exitCode = 1; p.emit("exit", 1, null); } }); procs.push({ bin, args, opts, p }); return p; };
  const { m, killed } = setup({ opts: { setTimer, clearTimer, spawn, shellPath: "bash" } });
  const job = m.start({ kind: "shell", command: "sleep 99999", cwd: base });
  await until(() => m.get(job.id).status === "running");
  assert.deepEqual(procs[0].args, ["-lc", "sleep 99999"]);
  assert.equal(procs[0].opts.cwd, base);
  assert.equal(procs[0].opts.windowsHide, true);
  assert.equal(procs[0].opts.env.OMNI_AGENT_ID, job.id);
  const t = long.find((x) => x.ms === 120 * 60000);
  assert.ok(t, "120 minutes by default");
  t.fn();
  await sleep(5);
  assert.equal(m.get(job.id).status, "timeout");
  assert.deepEqual(killed, [777]);
  m.dispose();
});

test("a shell job takes no messages", async () => {
  const { m } = setup({ opts: nodeShell });
  const job = m.start({ kind: "shell", command: "1" });
  await assert.rejects(m.message(job.id, "hi"), (e) => e.status === 400 && /no messages/.test(e.message));
  await m.wait({ ids: [job.id], timeoutMs: 10000 });
  m.dispose();
});

// ------------------------------------------------------------------ wait / delivery
test("wait(): at once when one is already finished; else on the first finish; at the timeout with what is pending; on abort", async () => {
  const { m, pis } = setup({ keeper: fakeKeeper() });
  const a = m.start({ task: "A", parentSessionId: "p" }), b = m.start({ task: "B", parentSessionId: "p" });
  await until(() => m.get(b.id).status === "running");
  const t0 = Date.now();
  const timedOut = await m.wait({ parentSessionId: "p", timeoutMs: 40 });
  assert.ok(Date.now() - t0 >= 35);
  assert.deepEqual(timedOut.finished, []);
  assert.deepEqual(timedOut.pending.map((r) => r.id).sort(), [a.id, b.id].sort());
  const ac = new AbortController();
  const aborted = m.wait({ ids: [a.id], timeoutMs: 60000, signal: ac.signal });
  ac.abort();
  assert.deepEqual((await aborted).finished, []);
  const pending = m.wait({ ids: [a.id, b.id], timeoutMs: 60000 });
  setTimeout(() => pis.made[1].goal({ done: true }), 20);
  const got = await pending;
  assert.deepEqual(got.finished.map((r) => r.id), [b.id]);
  assert.deepEqual(got.pending.map((r) => r.id), [a.id]);
  const now = await m.wait({ ids: [b.id], timeoutMs: 60000 });
  assert.equal(now.finished[0].id, b.id, "already finished: no waiting");
  const nothing = await m.wait({ ids: ["a-00000000"], timeoutMs: 60000 });
  assert.deepEqual(nothing, { finished: [], pending: [] }, "nothing to wait for resolves at once");
  await m.stopAll();
  m.dispose();
});

test("delivery: undeliveredOnly skips delivered reports; markDelivered only takes finished agents; undelivered() lists them oldest first", async () => {
  const { m, pis } = setup({ keeper: fakeKeeper() });
  const a = m.start({ task: "A", parentSessionId: "p" }), b = m.start({ task: "B", parentSessionId: "p" }), other = m.start({ task: "O", parentSessionId: "q" });
  await until(() => m.get(other.id).status === "running");
  assert.equal(m.markDelivered(a.id), false, "still running");
  pis.made[0].goal({ done: true });
  await sleep(2);
  pis.made[1].goal({ done: true });
  pis.made[2].goal({ done: true });
  assert.deepEqual(m.undelivered("p").map((r) => r.id), [a.id, b.id]);
  assert.equal(m.markDelivered(a.id), true);
  assert.equal(m.get(a.id).delivered, true);
  assert.deepEqual(m.undelivered("p").map((r) => r.id), [b.id]);
  const w = await m.wait({ parentSessionId: "p", undeliveredOnly: true, timeoutMs: 1000 });
  assert.deepEqual(w.finished.map((r) => r.id), [b.id]);
  m.markDelivered(b.id);
  const t0 = Date.now();
  const none = await m.wait({ parentSessionId: "p", undeliveredOnly: true, timeoutMs: 1000 });
  assert.deepEqual(none, { finished: [], pending: [] });
  assert.ok(Date.now() - t0 < 500, "nothing left to deliver: no long wait");
  assert.equal(m.markDelivered("a-ffffffff"), false);
  m.dispose();
});

// ------------------------------------------------------------------ registry
test("persistence: the registry is written atomically soon after a change; reconcile marks what was running as interrupted", async () => {
  const keeper = fakeKeeper();
  const { m, pis, dir } = setup({ keeper, config: { maxConcurrent: 1 } });
  const file = join(dir, "agents.json");
  const y = m.start({ task: "finished one", parentSessionId: "p" });
  await until(() => m.get(y.id).status === "running");
  pis.made[0].say("the report");
  pis.made[0].goal({ done: true });
  m.markDelivered(y.id);
  const x = m.start({ task: "running one" });
  const z = m.start({ task: "queued one" });
  await until(() => m.get(x.id).status === "running");
  await sleep(40);
  assert.ok(existsSync(file), "written within the debounce");
  assert.ok(!existsSync(`${file}.tmp`), "tmp + rename leaves no tmp file behind");
  const onDisk = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(onDisk.version, 1);
  assert.equal(onDisk.agents.length, 3);
  m.dispose(); // flushes; does not kill
  assert.equal(pis.made[1].stops, 0, "dispose() leaves the agents alone");

  const m2 = new AgentManager({ bus: new Bus(), file, dir: join(dir, "logs"), createPi: () => { throw new Error("must not start anything"); } });
  const list = m2.reconcile();
  assert.equal(list.length, 3);
  const byId = Object.fromEntries(list.map((r) => [r.id, r]));
  assert.equal(byId[y.id].status, "done");
  assert.equal(byId[y.id].delivered, true);
  assert.equal(byId[y.id].resultText, "the report");
  for (const id of [x.id, z.id]) {
    assert.equal(byId[id].status, "interrupted");
    assert.match(byId[id].error, /Omni restarted/);
    assert.equal(byId[id].delivered, false, "the parent hears about the interruption");
  }
  assert.equal(JSON.parse(readFileSync(file, "utf8")).agents.find((r) => r.id === x.id).status, "interrupted", "reconcile saved the change");
  m2.dispose();
});

test("reconcile: keeps at most 500 records (oldest finished dropped) and survives a malformed file", () => {
  const dir = fresh();
  const file = join(dir, "agents.json");
  const agents = Array.from({ length: 505 }, (_, i) => ({ id: `a-${i.toString(16).padStart(8, "0")}`, kind: "shell", status: "done", createdAt: i, endedAt: 1000 + i, activity: [], delivered: true }));
  agents.push({ id: "not-an-id", kind: "pi", status: "done" }, { id: "a-ffffffff", kind: "robot", status: "done" });
  writeFileSync(file, JSON.stringify({ version: 1, agents }));
  const m = new AgentManager({ bus: new Bus(), file });
  const list = m.reconcile();
  assert.equal(list.length, 500);
  assert.ok(!list.some((r) => ["a-00000000", "a-00000004"].includes(r.id)), "the five oldest are gone");
  assert.ok(list.some((r) => r.id === "a-00000005"));
  m.dispose();
  writeFileSync(file, "{ not json");
  const m2 = new AgentManager({ bus: new Bus(), file });
  assert.deepEqual(m2.reconcile(), []);
  m2.dispose();
});

test("stopAll() stops every active agent as interrupted; piFor/owns/list filters follow the live state", async () => {
  const { m, pis } = setup({ keeper: fakeKeeper(), config: { maxConcurrent: 1 } });
  const a = m.start({ task: "A", parentSid: "pi:p", parentSessionId: "p" });
  const b = m.start({ task: "B", parentSid: "pi:p", parentSessionId: "p" });
  await until(() => m.get(a.id).status === "running");
  assert.equal(m.piFor("pi:sess1"), pis.made[0]);
  assert.equal(m.piFor("pi:other"), null);
  assert.equal(m.owns("/sessions/sess1.jsonl"), true);
  assert.equal(m.owns("/sessions/zzz.jsonl"), false);
  assert.deepEqual(m.list({ parentSid: "pi:p" }).map((r) => r.id), [b.id, a.id], "newest first");
  assert.deepEqual(m.list({ parentSessionId: "nope" }), []);
  assert.equal(m.list({ active: true }).length, 2);
  await m.stopAll();
  assert.equal(m.get(a.id).status, "interrupted");
  assert.equal(m.get(b.id).status, "interrupted");
  assert.equal(m.list({ active: true }).length, 0);
  assert.equal(m.piFor("pi:sess1"), null);
  assert.equal(pis.made.length, 1, "the queued one never started");
  m.dispose();
});

test("records are plain JSON and capped: task ≤ 4000 chars, activity ≤ 8 lines", async () => {
  const { m, pis } = setup({ keeper: fakeKeeper() });
  const rec = m.start({ task: "x".repeat(5000) });
  assert.equal(rec.task.length, 4000);
  assert.ok(rec.task.endsWith("…"));
  assert.equal(m.start({ task: "y".repeat(4000) }).task, "y".repeat(4000), "exactly at the limit: not cut");
  await until(() => m.get(rec.id).status === "running");
  assert.equal(pis.made[0].prompts[0].text.startsWith("x".repeat(5000)), true, "the agent still gets the whole task");
  for (let i = 0; i < 12; i++) pis.made[0].say(`step ${i}`);
  assert.equal(m.get(rec.id).activity.length, 8);
  assert.equal(m.get(rec.id).activity.at(-1), "step 11");
  assert.doesNotThrow(() => JSON.stringify(m.list()));
  await m.stopAll();
  m.dispose();
});
