/**
 * The omni-fallback pi extension: when a run ends on a model error, switch to the next model in models.json
 * order (providers in file order, each provider's models in line order) and continue the turn on it. The retried
 * model must not see the error: the context hook drops errored assistant messages and the switch notice.
 * Loads the real extension source through node's type stripping; pi's own packages resolve from the installed
 * pi (skipped when pi is not installed).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { registerHooks } from "node:module";
import { ROOT, findPiCli } from "../server/config.mjs";

const EXT = join(ROOT, "integrations", "pi", "omni-fallback.ts");
const piCli = findPiCli();
const skip = !piCli && "pi is not installed";

if (piCli) {
  const extUrl = pathToFileURL(EXT).href;
  registerHooks({
    resolve(specifier, context, next) {
      if (String(context.parentURL || "").split("?")[0] === extUrl && !specifier.startsWith(".") && !specifier.startsWith("node:") && !specifier.startsWith("file:")) {
        return next(specifier, { ...context, parentURL: pathToFileURL(piCli).href });
      }
      return next(specifier, context);
    },
  });
}

const CHAIN = { providers: {
  modal: { baseUrl: "https://modal.example/v1", api: "openai-completions", models: [{ id: "Qwen/Qwen3.8-27B" }] },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", api: "openai-completions", models: [{ id: "deepseek/deepseek-v4-flash-0731" }, { id: "z-ai/glm-5.3-flash:floor" }] },
} };

/** A pi whose agent dir holds `chain`; returns the loaded extension wired to a scripted ExtensionAPI. */
async function load(chain = CHAIN, { setModelOk = () => true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "omni-fb-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "models.json"), JSON.stringify(chain));
  const saved = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const handlers = {};
  const calls = { setModel: [], sent: [], renderers: [] };
  const api = {
    on: (name, fn) => { (handlers[name] ||= []).push(fn); },
    registerMessageRenderer: (type) => calls.renderers.push(type),
    setModel: async (m) => { calls.setModel.push(`${m.provider}/${m.id}`); return setModelOk(m); },
    sendMessage: async (msg, opts) => { calls.sent.push({ msg, opts }); },
  };
  const mod = await import(`${pathToFileURL(EXT).href}?${Math.random()}`);
  mod.default(api);
  const model = { provider: "modal", id: "Qwen/Qwen3.8-27B" };
  const ctx = { model, modelRegistry: { find: (provider, id) => ({ provider, id, api: "openai-completions" }) } };
  const emit = async (type, ev = {}) => { for (const fn of handlers[type] || []) await fn({ type, ...ev }, ctx); };
  const tick = () => new Promise((r) => setTimeout(r, 5));
  const cleanup = () => { if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = saved; rmSync(dir, { recursive: true, force: true }); };
  return { mod, api, handlers, calls, ctx, emit, tick, cleanup };
}

const errored = (provider, model, errorMessage = "400 Bad Request: no body") => ({ role: "assistant", content: [{ type: "text", text: "" }], provider, model, stopReason: "error", errorMessage });

test("readChain / modelsBelow: providers in file order, models in line order; the model below the current one is next", { skip }, async () => {
  const { mod, cleanup } = await load();
  try {
    const chain = mod.readChain(mod.modelsFile());
    assert.deepEqual(chain.map((s) => `${s.provider}/${s.id}`), ["modal/Qwen/Qwen3.8-27B", "openrouter/deepseek/deepseek-v4-flash-0731", "openrouter/z-ai/glm-5.3-flash:floor"]);
    assert.deepEqual(mod.modelsBelow(chain, { provider: "modal", id: "Qwen/Qwen3.8-27B" }).map((s) => s.id), ["deepseek/deepseek-v4-flash-0731", "z-ai/glm-5.3-flash:floor"]);
    assert.deepEqual(mod.modelsBelow(chain, { provider: "openrouter", id: "z-ai/glm-5.3-flash:floor" }), [], "the last model has nothing below it");
    assert.deepEqual(mod.modelsBelow(chain, { provider: "other", id: "x" }), [], "a model outside the list has no fallback");
    assert.deepEqual(mod.readChain(join(tmpdir(), "nope-omni.json")), []);
  } finally { cleanup(); }
});

test("a model error at agent_end switches to the model below and steers a display-only notice so pi continues the run", { skip }, async () => {
  const { calls, emit, cleanup } = await load();
  try {
    await emit("agent_end", { messages: [errored("modal", "Qwen/Qwen3.8-27B")] });
    assert.deepEqual(calls.setModel, ["openrouter/deepseek/deepseek-v4-flash-0731"]);
    assert.equal(calls.sent.length, 1);
    const { msg, opts } = calls.sent[0];
    assert.equal(msg.customType, "omni-fallback");
    assert.equal(msg.display, true);
    assert.match(msg.content, /^model error on modal\/Qwen\/Qwen3.8-27B → switched to openrouter\/deepseek\/deepseek-v4-flash-0731 \(400 Bad Request/);
    assert.equal(opts.deliverAs, "steer", "queued for the continuation pi runs after agent_end; nothing is triggered from inside the handler");
    assert.equal(opts.triggerTurn, undefined);
  } finally { cleanup(); }
});

test("the retried model never sees the error: errored assistant messages and the notice are dropped from the context", { skip }, async () => {
  const { handlers, ctx, cleanup } = await load();
  try {
    const messages = [
      { role: "user", content: "hi" },
      errored("modal", "Qwen/Qwen3.8-27B"),
      { role: "custom", customType: "omni-fallback", content: "model error on … → switched to …" },
      { role: "custom", customType: "other", content: "kept" },
      { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" },
    ];
    const out = handlers.context[0]({ type: "context", messages }, ctx);
    assert.deepEqual(out.messages.map((m) => m.role + (m.customType ? `:${m.customType}` : "")), ["user", "custom:other", "assistant"]);
  } finally { cleanup(); }
});

test("the chain stops at the bottom; a successful turn, an abort, or an unlisted model never switch", { skip }, async () => {
  const { calls, ctx, emit, cleanup } = await load();
  try {
    ctx.model = { provider: "openrouter", id: "z-ai/glm-5.3-flash:floor" };
    await emit("agent_end", { messages: [errored("openrouter", "z-ai/glm-5.3-flash:floor")] });
    assert.deepEqual(calls.setModel, [], "last in the list: the error stays");
    ctx.model = { provider: "modal", id: "Qwen/Qwen3.8-27B" };
    await emit("agent_end", { messages: [{ role: "assistant", content: [{ type: "text", text: "fine" }], stopReason: "stop" }] });
    await emit("agent_end", { messages: [{ ...errored("modal", "Qwen/Qwen3.8-27B"), stopReason: "aborted" }] });
    await emit("agent_end", { messages: [errored("modal", "Qwen/Qwen3.8-27B"), { role: "toolResult", content: [] }] });
    ctx.model = { provider: "other", id: "x" };
    await emit("agent_end", { messages: [errored("other", "x")] });
    assert.deepEqual(calls.setModel, []);
    assert.equal(calls.sent.length, 0);
  } finally { cleanup(); }
});

test("a model pi cannot switch to (no key) is skipped for the next one below", { skip }, async () => {
  const { calls, emit, cleanup } = await load(CHAIN, { setModelOk: (m) => m.id !== "deepseek/deepseek-v4-flash-0731" });
  try {
    await emit("agent_end", { messages: [errored("modal", "Qwen/Qwen3.8-27B", "401 invalid key")] });
    assert.deepEqual(calls.setModel, ["openrouter/deepseek/deepseek-v4-flash-0731", "openrouter/z-ai/glm-5.3-flash:floor"]);
    assert.equal(calls.sent.length, 1);
    assert.match(calls.sent[0].msg.content, /switched to openrouter\/z-ai\/glm-5.3-flash:floor/);
  } finally { cleanup(); }
});

test("the extension registers a renderer for its notice so a terminal pi shows the switch", { skip }, async () => {
  const { calls, cleanup } = await load();
  try { assert.deepEqual(calls.renderers, ["omni-fallback"]); } finally { cleanup(); }
});
