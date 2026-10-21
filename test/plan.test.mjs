import { test } from "node:test";
import assert from "node:assert/strict";
import { applyPlanAction, emptyPlan, planPhase, planProgress, currentStep, planReminder, planNudge, renderPlan, clearWaiting, asPlan, latestPlan } from "../ui/plan.js";

const BRAIN = { action: "brainstorm", understanding: "Add retries to the API client; no UI changes.", assumptions: ["fetch is the only transport"], approaches: [{ name: "wrap fetch", tradeoffs: "small, local" }, { name: "retry middleware", tradeoffs: "bigger, reusable" }], chosen: "wrap fetch", rationale: "smallest change", success_criteria: ["npm test passes", "a 503 is retried 3 times"] };
const MILESTONES = [
  { title: "Retry helper", steps: [{ title: "write retry()", done_when: "unit test for retry passes" }, { title: "back-off", done_when: "delays double" }] },
  { title: "Wire it in", steps: [{ title: "use retry in client", done_when: "npm test passes" }] },
];
/** Apply actions in order, asserting each one is accepted; returns the last result. */
function run(...actions) {
  let plan = emptyPlan(), r = null, t = 1000;
  for (const a of actions) { r = applyPlanAction(plan, a, { now: t++ }); assert.ok(r.ok, `${a.action} refused: ${r.text}`); plan = r.plan; }
  return r;
}

test("plan: a plan cannot be written before the brainstorm, and a brainstorm must weigh real options", () => {
  const early = applyPlanAction(emptyPlan(), { action: "create", milestones: MILESTONES });
  assert.equal(early.ok, false);
  assert.match(early.text, /brainstorm first/);
  const thin = applyPlanAction(emptyPlan(), { action: "brainstorm", understanding: "do it", approaches: [{ name: "just do it", tradeoffs: "" }], chosen: "just do it" });
  assert.equal(thin.ok, false);
  assert.match(thin.text, /at least two/);
  assert.match(thin.text, /success_criteria/);
  const ok = applyPlanAction(emptyPlan(), BRAIN);
  assert.ok(ok.ok);
  assert.deepEqual(ok.events, ["brainstormed"]);
  assert.equal(planPhase(ok.plan), "plan");
  assert.match(ok.text, /Next: call plan with action "create"/);
});

test("plan: every step needs a done_when check; ids are milestone.step", () => {
  const b = run(BRAIN).plan;
  const vague = applyPlanAction(b, { action: "create", milestones: [{ title: "M", steps: [{ title: "do things" }] }] });
  assert.equal(vague.ok, false);
  assert.match(vague.text, /done_when/);
  const r = applyPlanAction(b, { action: "create", milestones: MILESTONES });
  assert.ok(r.ok);
  assert.deepEqual(r.events, ["created"]);
  assert.deepEqual(r.plan.milestones.flatMap((m) => m.steps.map((s) => s.id)), ["1.1", "1.2", "2.1"]);
  assert.equal(planPhase(r.plan), "execute");
  assert.equal(currentStep(r.plan).id, "1.1");
  const again = applyPlanAction(r.plan, { action: "create", milestones: MILESTONES });
  assert.equal(again.ok, false, "an open plan is revised, not re-created");
  assert.match(again.text, /revise/);
});

test("plan: done needs evidence; milestones and the whole plan complete from step states", () => {
  const p = run(BRAIN, { action: "create", milestones: MILESTONES }, { action: "start", step: "1.1" }).plan;
  assert.equal(currentStep(p).status, "active");
  const noEvidence = applyPlanAction(p, { action: "done", step: "1.1" });
  assert.equal(noEvidence.ok, false);
  assert.match(noEvidence.text, /evidence/);
  // `done` without a step id means the step being worked on.
  const d1 = applyPlanAction(p, { action: "done", evidence: "retry.test.js: 4 passing" });
  assert.ok(d1.ok); assert.deepEqual(d1.events, ["step_done"]);
  const d2 = applyPlanAction(d1.plan, { action: "done", step: "step 1.2", evidence: "100, 200, 400 ms" });
  assert.deepEqual(d2.events, ["step_done", "milestone_done"]);
  assert.match(d2.text, /Milestone 1 "Retry helper" reached/);
  const pr = planProgress(d2.plan);
  assert.equal(pr.milestonesDone, 1); assert.equal(pr.done, 2); assert.equal(pr.current.id, "2.1");
  const d3 = applyPlanAction(d2.plan, { action: "skip", step: "2.1", reason: "the client already retries via the SDK" });
  assert.deepEqual(d3.events, ["step_skipped", "milestone_done", "plan_done"]);
  assert.equal(planPhase(d3.plan), "complete");
  assert.match(d3.text, /success criteria \(npm test passes; a 503 is retried 3 times\)/);
  // A finished plan is not a finished goal: the hint sends it to the user's goal before any final answer.
  assert.match(d3.text, /and against the user's overall goal\. If any part of that goal is still not done, create the next plan for it \(plan action "create"\) and continue working\. Only when the whole goal is done, give the user a short final answer\.$/);
  const next = applyPlanAction(d3.plan, { action: "create", milestones: [{ title: "Next part", steps: [{ title: "retry uploads", done_when: "upload test passes" }] }] }, { now: 2000 });
  assert.ok(next.ok, "the next plan can be created on a finished one, as the hint says");
  assert.equal(currentStep(next.plan).id, "3.1");
  assert.equal(planReminder(d3.plan), "", "a finished plan is not pushed into the context any more");
  assert.equal(applyPlanAction(d3.plan, { action: "done", step: "2.1", evidence: "x" }).ok, false, "a finished step stays finished");
});

test("plan: revise keeps finished steps, replaces the rest, and needs a reason", () => {
  const p = run(BRAIN, { action: "create", milestones: MILESTONES }, { action: "done", step: "1.1", evidence: "ok" }).plan;
  assert.equal(applyPlanAction(p, { action: "revise", milestones: MILESTONES }).ok, false, "a reason is required");
  const r = applyPlanAction(p, { action: "revise", reason: "back-off belongs in the SDK config", milestones: [{ title: "Configure SDK", steps: [{ title: "set retries: 3", done_when: "config test passes" }] }] });
  assert.ok(r.ok); assert.deepEqual(r.events, ["revised"]);
  assert.deepEqual(r.plan.milestones.map((m) => [m.id, m.steps.map((s) => `${s.id}:${s.status}`)]), [["1", ["1.1:done"]], ["3", ["3.1:pending"]]], "finished work kept, new milestone ids never reuse old ones");
  assert.equal(r.plan.revisions, 1);
  assert.equal(currentStep(r.plan).id, "3.1");
});

test("plan: ask_user parks the plan until a user answer clears it", () => {
  const p = run(BRAIN, { action: "create", milestones: MILESTONES }, { action: "ask_user", question: "Which API key should I use?" }).plan;
  assert.equal(planPhase(p), "waiting");
  assert.equal(planProgress(p).waiting.question, "Which API key should I use?");
  assert.equal(planPhase(clearWaiting(p)), "execute");
});

test("plan: small-model shapes are accepted (string steps, doneWhen/check aliases, bare step numbers)", () => {
  const b = run(BRAIN).plan;
  const r = applyPlanAction(b, { action: "create", milestones: [{ name: "Only", tasks: [{ step: "a", check: "a works" }, { title: "b", doneWhen: "b works" }] }] });
  assert.ok(r.ok, r.text);
  const d = applyPlanAction(r.plan, { action: "done", step: "2", evidence: "b ran" });
  assert.ok(d.ok, d.text);
  assert.equal(d.plan.milestones[0].steps[1].status, "done");
  assert.equal(applyPlanAction(r.plan, { action: "explode" }).ok, false);
});

test("plan: the reminder shows the current milestone in full and the rest collapsed; the nudge names the step and its check", () => {
  const p = run(BRAIN, { action: "create", milestones: MILESTONES }, { action: "done", step: "1.1", evidence: "ok" }, { action: "done", step: "1.2", evidence: "ok" }).plan;
  const rem = planReminder(p);
  assert.match(rem, /^<omni-plan phase="execute" progress="2\/3">/);
  assert.match(rem, /✓ 1 Retry helper/);
  assert.match(rem, /\[ \] 2\.1 use retry in client \(done when: npm test passes\)/);
  assert.doesNotMatch(rem, /write retry\(\)/, "finished milestones collapse to their title");
  const n = planNudge(p);
  assert.match(n, /your plan is not finished \(2\/3 steps done, milestone 2\/2 "Wire it in"\)/);
  assert.match(n, /Current step 2\.1: use retry in client\nDone when: npm test passes/);
  assert.match(renderPlan(p), /PLAN · execute · 2\/3 steps/);
  assert.equal(asPlan({ plan: p }), p);
  assert.equal(asPlan({ nope: 1 }), null);
});

test("plan: latestPlan reads the active branch of pi's session entries, incl. omni-plan entries", () => {
  const p1 = run(BRAIN, { action: "create", milestones: MILESTONES }).plan;
  const p2 = applyPlanAction(p1, { action: "done", step: "1.1", evidence: "ok" }).plan;
  const pAbandoned = applyPlanAction(p1, { action: "skip", step: "1.1", reason: "x" }).plan;
  const tr = (id, parentId, plan) => ({ type: "message", id, parentId, message: { role: "toolResult", toolName: "plan", details: { plan } } });
  const entries = [tr("a", null, p1), tr("b", "a", pAbandoned), tr("c", "a", p2), { type: "custom", id: "d", parentId: "c", customType: "omni-plan", data: { plan: { ...p2, waiting: null, updatedAt: 9 } } }, { type: "message", id: "e", parentId: "d", message: { role: "user", content: "hi" } }];
  assert.equal(latestPlan(entries, "e").updatedAt, 9, "the newest entry on the branch wins");
  assert.equal(latestPlan(entries, "b").milestones[0].steps[0].status, "skipped", "another leaf, another branch");
  assert.equal(latestPlan(entries.slice(0, 1)).milestones.length, 2, "no leaf: all entries in order");
  assert.equal(latestPlan([{ type: "message", id: "z", message: { role: "user", content: "x" } }]), null);
});
