/**
 * The omni-plan pi extension: the `plan` tool keeps its state in the tool results' details, rebuilds it from
 * the session branch, appends a plan reminder to the newest message of each LLM call (not persisted), and a
 * real user message clears an ask_user. Loads the real extension source through node's type stripping;
 * pi's own packages resolve from the installed pi (skipped when pi is not installed).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { registerHooks } from "node:module";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { ROOT, findPiCli } from "../server/config.mjs";

const EXT = join(ROOT, "integrations", "pi", "omni-plan.ts");
const piCli = findPiCli();
// pi-ai's own argument validator, beside the installed pi — the same gate pi applies before execute().
const piRoot = piCli && dirname(dirname(piCli));
const VALIDATION = piRoot && [join(piRoot, "node_modules", "@earendil-works", "pi-ai"), join(dirname(piRoot), "pi-ai")]
  .map((d) => join(d, "dist", "utils", "validation.js")).find((f) => existsSync(f));

if (piCli) {
  const extUrl = pathToFileURL(EXT).href;
  registerHooks({
    resolve(specifier, context, next) {
      if (context.parentURL === extUrl && !specifier.startsWith(".") && !specifier.startsWith("node:") && !specifier.startsWith("file:")) {
        return next(specifier, { ...context, parentURL: pathToFileURL(piCli).href });
      }
      return next(specifier, context);
    },
  });
}

async function load() {
  const mod = await import(pathToFileURL(EXT).href);
  const tools = {}, on = {}, entries = [], commands = [];
  mod.default({ registerTool: (t) => { tools[t.name] = t; }, on: (name, fn) => { on[name] = fn; }, registerCommand: (n) => commands.push(n), appendEntry: (type, data) => entries.push({ type: "custom", customType: type, data }) });
  return { tools, on, entries, commands };
}
const BRAIN = { action: "brainstorm", understanding: "u", approaches: [{ name: "a", tradeoffs: "x" }, { name: "b", tradeoffs: "y" }], chosen: "a", success_criteria: ["ok"] };
const PLAN = { action: "create", milestones: [{ title: "Core", steps: [{ title: "write parser", done_when: "tests pass" }] }] };

test("omni-plan: the plan tool keeps its state in details and the context gets a tail reminder", { skip: !piCli && "pi is not installed" }, async () => {
  const x = await load();
  assert.ok(x.tools.plan, "plan tool registered");
  assert.deepEqual(x.commands, ["plan"]);
  assert.ok(x.tools.plan.promptGuidelines.some((g) => /brainstorm first/.test(g)));
  const early = await x.tools.plan.execute("1", { action: "create", milestones: PLAN.milestones });
  assert.equal(early.details.ok, false);
  await x.tools.plan.execute("2", BRAIN);
  const r = await x.tools.plan.execute("3", PLAN);
  assert.equal(r.details.ok, true);
  assert.deepEqual(r.details.events, ["created"]);
  assert.equal(r.details.plan.milestones[0].steps[0].id, "1.1");
  const messages = [{ role: "user", content: [{ type: "text", text: "go" }] }, { role: "assistant", content: [] }, { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "ok" }] }];
  const ctx = await x.on.context({ messages });
  assert.equal(ctx.messages.length, 3);
  assert.equal(ctx.messages[0], messages[0], "earlier messages untouched (prompt cache kept)");
  assert.match(ctx.messages[2].content.at(-1).text, /<omni-plan phase="execute" progress="0\/1">[\s\S]*1\.1 write parser/);
  assert.equal(messages[2].content.length, 1, "the original message is not mutated");
  assert.equal(await x.on.context({ messages: [{ role: "assistant", content: [] }] }), undefined, "only appended after a user/tool message");
});

test("omni-plan: pi's validator accepts the near-miss milestone shapes the model actually sent (no hard reject)", { skip: !VALIDATION && "pi (with pi-ai) is not installed" }, async () => {
  const validation = await import(pathToFileURL(VALIDATION).href);
  const x = await load();
  const tool = { name: "plan", parameters: x.tools.plan.parameters };
  // The exact shapes that hard-failed in the real runs: a milestone carrying done_when (an extra field) with
  // no milestone-level title, and a milestone with no steps. These must now pass validation…
  const nearMiss = { action: "revise", reason: "learned the plan was wrong", milestones: [
    { done_when: "install reaches the overlay", steps: [{ title: "patch init_array[1]", done_when: "breadcrumb file appears" }] },
    { title: "Acceptance" },
  ] };
  const ok = validation.validateToolArguments(tool, { type: "toolCall", id: "1", name: "plan", arguments: nearMiss });
  assert.ok(ok, "the relaxed schema validates the near-miss milestones");
  // …and the tolerant state machine turns them into a usable plan with derived titles/steps.
  await x.tools.plan.execute("b", BRAIN);
  await x.tools.plan.execute("c", PLAN);
  const r = await x.tools.plan.execute("r", nearMiss);
  assert.equal(r.details.ok, true, `revise accepted: ${r.content[0].text}`);
  assert.ok(r.details.plan.milestones.every((m) => m.title && m.steps.length), "every milestone ends up with a title and at least one step");
});

test("omni-plan: state is rebuilt from the session branch; a real user message clears ask_user", { skip: !piCli && "pi is not installed" }, async () => {
  const a = await load();
  await a.tools.plan.execute("1", BRAIN);
  await a.tools.plan.execute("2", PLAN);
  const asked = await a.tools.plan.execute("3", { action: "ask_user", question: "Which key?" });
  const branch = [{ type: "message", message: { role: "toolResult", toolName: "plan", details: asked.details } }];
  const b = await load();
  await b.on.session_start({}, { sessionManager: { getBranch: () => branch } });
  const shown = await b.tools.plan.execute("4", { action: "show" });
  assert.match(shown.content[0].text, /WAITING FOR USER: Which key\?/);
  await b.on.before_agent_start({ prompt: '<omni-hook name="goal" note="n">keep going</omni-hook>' });
  assert.equal(b.entries.length, 0, "the goal hook's own prompt is not an answer");
  await b.on.before_agent_start({ prompt: "use the staging key" });
  assert.equal(b.entries.length, 1);
  assert.equal(b.entries[0].customType, "omni-plan");
  assert.equal(b.entries[0].data.plan.waiting, null);
  const after = await b.tools.plan.execute("5", { action: "show" });
  assert.doesNotMatch(after.content[0].text, /WAITING/);
});
