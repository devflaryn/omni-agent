import { test } from "node:test";
import assert from "node:assert/strict";
import { PiRpc } from "../server/pi-rpc.mjs";

/**
 * A PiRpc whose child is scripted: every command written to stdin gets a JSON response on the next tick.
 * Mirrors what pi does on `new_session`: the runtime is rebuilt from the launch-time model, so a model or
 * thinking level set later through `set_model` / `set_thinking_level` is reset to the launch default.
 */
function fakePi({ model = "", provider = "", thinking = "", launch = { provider: "modal", id: "Qwen/Qwen3.8-27B", thinkingLevel: "high" }, rejectModel = null, ...opts } = {}) {
  const logs = [];
  const pi = new PiRpc({ bus: { emit(ev) { logs.push(ev); } }, model, provider, thinking, ...opts });
  const state = { sessionId: "s1", sessionFile: "/tmp/s1.jsonl", model: { provider: launch.provider, id: launch.id }, thinkingLevel: launch.thinkingLevel, isStreaming: false };
  const cmds = [];
  let n = 1;
  pi.proc = {
    stdin: {
      writable: true,
      write(line) {
        const cmd = JSON.parse(line);
        cmds.push(cmd);
        let success = true, data, error;
        switch (cmd.type) {
          case "get_state": data = { ...state, model: { ...state.model } }; break;
          case "new_session": state.sessionId = `s${++n}`; state.sessionFile = `/tmp/${state.sessionId}.jsonl`; state.model = { provider: launch.provider, id: launch.id }; state.thinkingLevel = launch.thinkingLevel; data = { cancelled: false }; break;
          case "set_model":
            if (rejectModel && rejectModel.provider === cmd.provider && rejectModel.id === cmd.modelId) { success = false; error = `Model not found: ${cmd.provider}/${cmd.modelId}`; break; }
            state.model = { provider: cmd.provider, id: cmd.modelId }; data = { ...state.model }; break;
          case "set_thinking_level": state.thinkingLevel = cmd.level; data = {}; break;
          default: data = {};
        }
        setImmediate(() => pi.onLine(JSON.stringify({ type: "response", id: cmd.id, command: cmd.type, success, data, error })));
      },
    },
  };
  return { pi, cmds, state, logs };
}

test("PiRpc.newSession puts the new session back on the model and thinking level picked after pi started", async () => {
  const { pi, cmds } = fakePi();
  await pi.refreshState();
  await pi.setModel("openrouter", "deepseek/deepseek-chat");
  await pi.setThinking("low");
  cmds.length = 0;
  await pi.newSession();
  assert.deepEqual(pi.state.model, { provider: "openrouter", id: "deepseek/deepseek-chat" }, "the picked model survives new_session");
  assert.equal(pi.state.thinkingLevel, "low", "the picked thinking level survives new_session");
  assert.equal(cmds[0].type, "new_session");
  assert.ok(cmds.some((c) => c.type === "set_model" && c.provider === "openrouter" && c.modelId === "deepseek/deepseek-chat"), "set_model re-sent after new_session");
  assert.ok(cmds.some((c) => c.type === "set_thinking_level" && c.level === "low"), "set_thinking_level re-sent after new_session");
  assert.match(pi.sid, /^pi:s\d+$/);
});

test("PiRpc.newSession re-applies the launch flags too (a child started with --model keeps it on new sessions)", async () => {
  // pi itself does this, but the guard must not fight it either: state already matches, so no extra command is sent.
  const { pi, cmds } = fakePi({ provider: "modal", model: "Qwen/Qwen3.8-27B", thinking: "high" });
  await pi.refreshState();
  cmds.length = 0;
  await pi.newSession();
  assert.deepEqual(cmds.map((c) => c.type), ["new_session", "get_state"], "nothing re-sent when the new session already matches");
});

test("PiRpc.newSession leaves pi's own default alone when nothing was picked", async () => {
  const { pi, cmds } = fakePi();
  await pi.refreshState();
  cmds.length = 0;
  await pi.newSession();
  assert.deepEqual(cmds.map((c) => c.type), ["new_session", "get_state"]);
  assert.deepEqual(pi.state.model, { provider: "modal", id: "Qwen/Qwen3.8-27B" });
});

test("PiRpc remembers picks for its auto-restart (the child is relaunched with the latest model, not the boot one)", async () => {
  const { pi } = fakePi({ provider: "modal", model: "Qwen/Qwen3.8-27B", thinking: "high" });
  await pi.refreshState();
  await pi.setModel("openrouter", "deepseek/deepseek-chat");
  await pi.setThinking("off");
  assert.equal(pi.provider, "openrouter");
  assert.equal(pi.model, "deepseek/deepseek-chat");
  assert.equal(pi.thinking, "off");
});

test("PiRpc.setModel does not adopt a model pi rejected", async () => {
  const { pi } = fakePi({ provider: "modal", model: "Qwen/Qwen3.8-27B", rejectModel: { provider: "nope", id: "ghost" } });
  await pi.refreshState();
  const r = await pi.setModel("nope", "ghost");
  assert.equal(r.success, false);
  assert.equal(pi.provider, "modal");
  assert.equal(pi.model, "Qwen/Qwen3.8-27B");
});

test("PiRpc.newSession still resolves when the remembered model cannot be re-applied, and says so", async () => {
  const { pi, logs } = fakePi({ provider: "nope", model: "ghost", rejectModel: { provider: "nope", id: "ghost" } });
  await pi.refreshState();
  const r = await pi.newSession();
  assert.equal(r.success, true);
  assert.deepEqual(pi.state.model, { provider: "modal", id: "Qwen/Qwen3.8-27B" }, "pi's fallback stays");
  assert.ok(logs.some((e) => e.kind === "log" && e.level === "system" && /nope\/ghost/.test(e.text)), "a system log names the model that could not be applied");
});

test("PiRpc re-reads state when the omni-fallback extension switches models (the session's model label follows)", async () => {
  const { pi, cmds, state, logs } = fakePi();
  await pi.refreshState();
  cmds.length = 0;
  state.model = { provider: "openrouter", id: "z-ai/glm-5.3-flash:floor" }; // what the extension's set_model did inside pi
  pi.onLine(JSON.stringify({ type: "message_end", message: { role: "custom", customType: "omni-fallback", content: "model error on modal/Qwen/Qwen3.8-27B → switched to openrouter/z-ai/glm-5.3-flash:floor", display: true } }));
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(cmds.map((c) => c.type), ["get_state"]);
  assert.deepEqual(pi.state.model, { provider: "openrouter", id: "z-ai/glm-5.3-flash:floor" });
  const sess = logs.filter((e) => e.kind === "session").at(-1);
  assert.equal(sess.model, "z-ai/glm-5.3-flash:floor");
  assert.equal(pi.model, "", "the remembered pick is untouched: a new chat starts back on it");
  const notice = logs.find((e) => e.kind === "msg" && e.fallback);
  assert.equal(notice.role, "system");
  assert.match(notice.blocks[0].text, /^model error on modal\/Qwen/);
});

test("restart resumes the saved session file via the onRestart hook", async () => {
  const bus = { emit() {}, on() {}, off() {} };
  const pi = new PiRpc({ cli: null, bin: "node", cwd: process.cwd(), bus });
  pi.resumeFile = "/sessions/keep.jsonl";
  let resumedTo = null;
  pi.switchSession = async (f) => { resumedTo = f; };
  pi.waitReady = async () => {};
  pi.start = () => { pi.onRestart && pi.onRestart(); return pi; }; // stub spawn
  await pi.handleExit(0); // new method invoked by the real 'exit' listener
  // onRestart default resumes:
  await pi.resumeSession();
  assert.equal(resumedTo, "/sessions/keep.jsonl");
});

test("C1: a crash captures the resume anchor and a transient empty-session event can't clobber it", async () => {
  const bus = { emit() {}, on() {}, off() {} };
  const pi = new PiRpc({ cli: null, bin: "node", cwd: process.cwd(), bus });
  pi.state = { sessionFile: "/sessions/goal.jsonl" }; // the live (goal) session before the crash
  let resumedTo = null;
  pi.switchSession = async (f) => { resumedTo = f; };
  pi.start = () => pi; // stub spawn; leaves pi.ready undefined so the restart timer can't auto-resume
  await pi.handleExit(1);
  assert.equal(pi.restoring, true, "restoring is latched for the restart window");
  assert.equal(pi.resumeFile, "/sessions/goal.jsonl", "the crashed session was captured as the anchor");
  // The fresh child opens an empty session; the supervisor mirror is gated on !pi.restoring, so it must NOT overwrite.
  if (!pi.restoring) pi.resumeFile = "/sessions/empty.jsonl";
  assert.equal(pi.resumeFile, "/sessions/goal.jsonl", "the empty session did not clobber the anchor");
  await pi.resumeSession();
  assert.equal(resumedTo, "/sessions/goal.jsonl", "resume switched to the captured goal session, not the empty one");
  assert.equal(pi.restoring, false, "restoring is cleared once resume finished");
});

test("abort() is a full stop: writes abort_bash, clear_queue, and abort frames to pi.proc.stdin", async () => {
  const { pi, cmds } = fakePi();
  await pi.refreshState();
  cmds.length = 0;
  await pi.abort();
  assert.deepEqual(cmds.map((c) => c.type), ["abort_bash", "clear_queue", "abort"], "cancels in-flight tools, clears the queue, then aborts the run");
});

test("watchdog aborts+restarts a wedged stream", () => {
  const bus = { emit() {}, on() {}, off() {} };
  const pi = new PiRpc({ cli: null, bin: "node", cwd: process.cwd(), bus });
  pi.streaming = true; pi.lastEventAt = 0;
  let aborted = false; pi.abort = async () => { aborted = true; };
  pi.checkStall({ now: 10_000_000, stallMs: 360000 });
  assert.equal(aborted, true);
});

test("a stdin 'error' event does not throw out of PiRpc", async () => {
  const bus = { emit() {}, on() {}, off() {} };
  const pi = new PiRpc({ cli: null, bin: "node", cwd: process.cwd(), bus });
  // fake proc with a stdin that emits 'error'
  const { EventEmitter } = await import("node:events");
  const stdin = new EventEmitter(); stdin.writable = true; stdin.write = () => true;
  const stdout = new EventEmitter(); stdout.setEncoding = () => {};
  const stderr = new EventEmitter(); stderr.setEncoding = () => {};
  pi.proc = Object.assign(new EventEmitter(), { stdin, stdout, stderr, kill() {} });
  pi.attachPipeGuards(); // new method under test
  assert.doesNotThrow(() => stdin.emit("error", Object.assign(new Error("EPIPE"), { code: "EPIPE" })));
});

test("extraArgs go after the launch flags; without them the argv is unchanged", () => {
  const bus = { emit() {} };
  const plain = new PiRpc({ bus, provider: "modal", model: "m1", thinking: "low" });
  assert.deepEqual(plain.launchArgs(), ["--mode", "rpc", "--provider", "modal", "--model", "m1", "--thinking", "low"]);
  const agent = new PiRpc({ bus, model: "m1", extraArgs: ["--append-system-prompt", "You are a scout.\nRead only.", "--tools", "read,grep"] });
  assert.deepEqual(agent.launchArgs(), ["--mode", "rpc", "--model", "m1", "--append-system-prompt", "You are a scout.\nRead only.", "--tools", "read,grep"]);
});

test("the Windows pi.cmd fallback (no cli) refuses extraArgs that cmd.exe would split, instead of launching a broken argv", () => {
  const bus = { emit() {} };
  const agent = new PiRpc({ bus, cli: null, bin: "pi-that-must-not-run", platform: "win32", extraArgs: ["--append-system-prompt", "You are a scout.\nRead only.", "--tools", "read,grep"] });
  assert.throws(() => agent.start(), /cli\.js was not found.*cannot pass a background agent's system prompt/);
  assert.equal(agent.proc, null, "nothing was spawned");
});

test("meta is spread into every session event, and cannot override the sid", async () => {
  const { pi, logs } = fakePi({ meta: { parentSid: "pi:parent-1", agentId: "a-0123abcd", agentKind: "pi", sid: "pi:evil" } });
  await pi.refreshState();
  const sess = logs.find((e) => e.kind === "session");
  assert.equal(sess.parentSid, "pi:parent-1");
  assert.equal(sess.agentId, "a-0123abcd");
  assert.equal(sess.agentKind, "pi");
  assert.equal(sess.sid, "pi:s1", "the real sid wins over a meta key");
  const plain = fakePi();
  await plain.pi.refreshState();
  assert.equal("parentSid" in plain.logs.find((e) => e.kind === "session"), false, "no meta, no extra keys");
});

test("prompt while streaming: steer by default, followUp when asked; idle prompts carry no streamingBehavior", async () => {
  const { pi, cmds } = fakePi();
  await pi.refreshState();
  pi.streaming = true;
  await pi.prompt("a", { echo: false });
  await pi.prompt("b", { echo: false, behavior: "followUp" });
  pi.streaming = false;
  await pi.prompt("c", { echo: false, behavior: "followUp" });
  const prompts = cmds.filter((c) => c.type === "prompt");
  assert.deepEqual(prompts.map((c) => [c.message, c.streamingBehavior]), [["a", "steer"], ["b", "followUp"], ["c", undefined]]);
});

test("tool-aware watchdog: an open tool call gets toolStallMs, a closed one falls back to stallMs", () => {
  const bus = { emit() {} };
  const pi = new PiRpc({ bus });
  let aborts = 0;
  pi.abort = async () => { aborts++; };
  pi.onLine(JSON.stringify({ type: "agent_start" }));
  pi.onLine(JSON.stringify({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "gradle build" } }));
  assert.equal(pi.openTools.size, 1);
  const t0 = pi.lastEventAt;
  pi.checkStall({ now: t0 + 2 * 3600000, stallMs: 900000, toolStallMs: 4 * 3600000 });
  assert.equal(aborts, 0, "a 2-hour build is not a stall");
  pi.checkStall({ now: t0 + 5 * 3600000, stallMs: 900000, toolStallMs: 4 * 3600000 });
  assert.equal(aborts, 1, "5 hours of silence is, even inside a tool");
  pi.onLine(JSON.stringify({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: { content: [] } }));
  assert.equal(pi.openTools.size, 0);
  const t1 = pi.lastEventAt;
  pi.checkStall({ now: t1 + 1_000_000, stallMs: 900000 });
  assert.equal(aborts, 2, "no tool open: back to stallMs");
  pi.onLine(JSON.stringify({ type: "tool_execution_start", toolCallId: "t2", toolName: "bash" }));
  pi.onLine(JSON.stringify({ type: "agent_settled" }));
  assert.equal(pi.openTools.size, 0, "agent_settled forgets tools that never reported an end");
});

test("the stall log says how many tool calls were open", () => {
  const logs = [];
  const pi = new PiRpc({ bus: { emit(ev) { logs.push(ev); } } });
  pi.abort = async () => {};
  pi.streaming = true; pi.lastEventAt = 1;
  pi.openTools.add("t1");
  pi.checkStall({ now: 5 * 3600000, stallMs: 900000 });
  assert.match(logs.find((e) => e.kind === "log").text, /stalled \d+s with 1 tool call open/);
});

test("exit event: a listener that calls stop() keeps the child from being restarted", async () => {
  const bus = { emit() {} };
  const pi = new PiRpc({ bus });
  pi.state = { sessionFile: "/s/agent.jsonl" };
  pi.openTools.add("t1");
  let starts = 0;
  pi.start = () => { starts++; return pi; };
  const codes = [];
  pi.on("exit", (code) => { codes.push(code); pi.stop(); });
  await pi.handleExit(3);
  assert.deepEqual(codes, [3]);
  assert.equal(pi.restoring, false, "no restart was armed");
  assert.equal(pi.openTools.size, 0);
  await new Promise((r) => setTimeout(r, 1100)); // past the first restart delay (≤ 960 ms)
  assert.equal(starts, 0);
});
