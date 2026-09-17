import { test } from "node:test";
import assert from "node:assert/strict";
import { PiRpc } from "../server/pi-rpc.mjs";

/**
 * A PiRpc whose child is scripted: every command written to stdin gets a JSON response on the next tick.
 * Mirrors what pi does on `new_session`: the runtime is rebuilt from the launch-time model, so a model or
 * thinking level set later through `set_model` / `set_thinking_level` is reset to the launch default.
 */
function fakePi({ model = "", provider = "", thinking = "", launch = { provider: "modal", id: "Qwen/Qwen3.8-27B", thinkingLevel: "high" }, rejectModel = null } = {}) {
  const logs = [];
  const pi = new PiRpc({ bus: { emit(ev) { logs.push(ev); } }, model, provider, thinking });
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
