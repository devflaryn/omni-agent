/**
 * The agent's plan: one pure state machine shared by the pi `plan` tool (integrations/pi/omni-plan.ts,
 * installed beside it as omni-plan-lib.mjs), the goal hook (server/hook.mjs) and the status box (ui/app.js).
 *
 * The plan is worked in phases, the way the superpowers brainstorm → write-plan → execute flow works:
 *   brainstorm  understand the goal, list assumptions/unknowns, weigh 2-3 approaches, pick one, and say how
 *               "done" will be verified (success criteria). No plan can be written before this.
 *   plan        milestones, each a few concrete steps, each step with a "done when" check.
 *   execute     one step active at a time; a step is marked done only with evidence that its check passed.
 *               A milestone is reached when all its steps are done or skipped; the plan is complete when
 *               every milestone is.
 * `revise` replaces the unfinished work (with a reason) and keeps what is already done; `ask_user` parks
 * the plan until the user answers (the next real user message clears it).
 *
 * Because the plan is explicit state, the goal hook needs no model to know whether the work is finished:
 * unfinished steps → re-engage; every step done → the goal is done; waiting on the user → stay quiet.
 * Every function here is pure and returns new objects.
 */

export const PLAN_TOOL = "plan";
export const PLAN_ACTIONS = ["brainstorm", "create", "start", "done", "skip", "revise", "ask_user", "show"];
const MAX_STEPS = 60;

const str = (v) => (typeof v === "string" ? v : v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v)).trim();
const clip = (s, n) => { const t = str(s); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const list = (v) => (Array.isArray(v) ? v : v == null || v === "" ? [] : [v]).map((x) => (typeof x === "object" && x ? x : str(x))).filter((x) => (typeof x === "string" ? !!x : true));
const strList = (v) => list(v).map((x) => clip(typeof x === "string" ? x : x.text || x.title || x.name || JSON.stringify(x), 400)).filter(Boolean);
const clone = (p) => JSON.parse(JSON.stringify(p));
const FINAL = new Set(["done", "skipped"]);

export function emptyPlan() {
  return { v: 1, brainstorm: null, milestones: [], nextMilestone: 1, waiting: null, revisions: 0, updatedAt: 0 };
}

/** A plan from tool-result details, or null when the value is not one. */
export function asPlan(v) {
  const p = v && typeof v === "object" ? (v.plan && typeof v.plan === "object" ? v.plan : v) : null;
  return p && Array.isArray(p.milestones) ? p : null;
}

export const allSteps = (plan) => (plan?.milestones || []).flatMap((m) => m.steps.map((s) => ({ ...s, milestone: m })));
const milestoneDone = (m) => m.steps.length > 0 && m.steps.every((s) => FINAL.has(s.status));

/** brainstorm | plan | execute | waiting | complete */
export function planPhase(plan) {
  if (!plan) return "brainstorm";
  if (plan.waiting) return "waiting";
  if (!plan.milestones.length) return plan.brainstorm ? "plan" : "brainstorm";
  return plan.milestones.every(milestoneDone) ? "complete" : "execute";
}

/** The step to work on: the active one, else the first unfinished one. */
export function currentStep(plan) {
  const steps = allSteps(plan);
  return steps.find((s) => s.status === "active") || steps.find((s) => !FINAL.has(s.status)) || null;
}

export function planProgress(plan) {
  const steps = allSteps(plan);
  const ms = plan?.milestones || [];
  const cur = currentStep(plan);
  return {
    phase: planPhase(plan),
    steps: steps.length,
    done: steps.filter((s) => s.status === "done").length,
    skipped: steps.filter((s) => s.status === "skipped").length,
    milestones: ms.length,
    milestonesDone: ms.filter(milestoneDone).length,
    current: cur ? { id: cur.id, title: cur.title, doneWhen: cur.doneWhen, status: cur.status } : null,
    currentMilestone: cur ? { id: cur.milestone.id, title: cur.milestone.title } : null,
    complete: planPhase(plan) === "complete",
    waiting: plan?.waiting || null,
  };
}

/** "1.2", "step 1.2", 1.2, "#1.2" → the step, or null. */
function findStep(plan, ref) {
  const r = str(ref).replace(/^(step|#)\s*/i, "").trim();
  if (!r) return null;
  for (const m of plan.milestones) for (const s of m.steps) if (s.id === r) return { m, s };
  // A bare milestone-less number ("3") picks the 3rd step overall, which is how small models count.
  if (/^\d+$/.test(r)) { const s = allSteps(plan)[Number(r) - 1]; if (s) { const m = plan.milestones.find((x) => x.id === s.milestone.id); return { m, s: m.steps.find((x) => x.id === s.id) }; } }
  return null;
}

function normalizeSteps(raw, mid) {
  return list(raw).map((s, i) => {
    const o = typeof s === "string" ? { title: s } : s;
    return { id: `${mid}.${i + 1}`, title: clip(o.title || o.step || o.name || o.text || o.description, 300), doneWhen: clip(o.done_when || o.doneWhen || o.check || o.verify || o.verification || "", 300), status: "pending", evidence: "", note: "" };
  }).filter((s) => s.title);
}

function normalizeMilestones(raw, start) {
  let n = start;
  const out = [];
  for (const m of list(raw)) {
    const o = typeof m === "string" ? { title: m, steps: [m] } : m;
    const id = String(n);
    const steps = normalizeSteps(o.steps || o.tasks, id);
    if (!steps.length) continue;
    out.push({ id, title: clip(o.title || o.name || o.milestone || `Milestone ${id}`, 200), goal: clip(o.goal || o.outcome || o.description || "", 300), steps });
    n++;
  }
  return { milestones: out, next: n };
}

/** Problems that make a list of milestones unusable as a plan (empty when it is fine). */
function planProblems(milestones) {
  const errs = [];
  if (!milestones.length) errs.push("give at least one milestone with at least one step (milestones: [{ title, steps: [{ title, done_when }] }])");
  const steps = milestones.flatMap((m) => m.steps);
  if (steps.length > MAX_STEPS) errs.push(`${steps.length} steps is too many; keep it under ${MAX_STEPS} by merging small steps`);
  const vague = steps.filter((s) => !s.doneWhen);
  if (vague.length) errs.push(`every step needs done_when (a concrete check that proves it worked); missing on: ${vague.slice(0, 5).map((s) => `${s.id} "${clip(s.title, 60)}"`).join(", ")}`);
  return errs;
}

/**
 * Apply one `plan` tool call. Returns `{ plan, ok, text, events }`: `plan` is the new state (unchanged when
 * !ok), `text` is what the model reads back, `events` name what happened (brainstormed, created, revised,
 * step_started, step_done, step_skipped, milestone_done, plan_done, ask_user) for the goal hook and the UI.
 */
export function applyPlanAction(prev, params = {}, { now = Date.now() } = {}) {
  const plan = clone(asPlan(prev) || emptyPlan());
  const action = str(params.action).toLowerCase().replace(/[\s-]+/g, "_");
  const fail = (msg) => ({ plan: asPlan(prev) || emptyPlan(), ok: false, text: `plan ${action || "?"} refused: ${msg}\n\n${renderPlan(asPlan(prev) || emptyPlan())}`, events: [] });
  const out = (text, events = []) => { plan.updatedAt = now; return { plan, ok: true, text: `${text}\n\n${renderPlan(plan)}${nextHint(plan, events)}`, events }; };

  switch (action) {
    case "brainstorm": {
      const b = {
        understanding: clip(params.understanding || params.goal || params.summary, 1200),
        assumptions: strList(params.assumptions || params.unknowns).slice(0, 12),
        approaches: list(params.approaches).slice(0, 5).map((a) => (typeof a === "string" ? { name: clip(a, 200), tradeoffs: "" } : { name: clip(a.name || a.title || a.approach, 200), tradeoffs: clip(a.tradeoffs || [a.pros && `pros: ${str(a.pros)}`, a.cons && `cons: ${str(a.cons)}`].filter(Boolean).join("; "), 400) })).filter((a) => a.name),
        chosen: clip(params.chosen || params.choice || params.decision, 300),
        rationale: clip(params.rationale || params.why, 600),
        successCriteria: strList(params.success_criteria || params.successCriteria || params.criteria).slice(0, 12),
      };
      const errs = [];
      if (!b.understanding) errs.push("understanding: restate the goal in your own words, including what is in and out of scope");
      if (b.approaches.length < 2) errs.push("approaches: weigh at least two genuinely different ways to do this, each with its trade-offs");
      if (!b.chosen) errs.push("chosen: say which approach you will take");
      if (!b.successCriteria.length) errs.push("success_criteria: how will you verify the whole goal is done (tests pass, output matches, file exists…)");
      if (errs.length) return fail(`a brainstorm needs:\n- ${errs.join("\n- ")}`);
      plan.brainstorm = b;
      return out("Brainstorm recorded.", ["brainstormed"]);
    }
    case "create": {
      if (!plan.brainstorm) return fail('brainstorm first: call plan with action "brainstorm" (understanding, assumptions, approaches, chosen, rationale, success_criteria), then create the plan from the chosen approach');
      if (plan.milestones.length && planPhase(plan) !== "complete") return fail('a plan already exists; use action "revise" (with a reason) to change it');
      const { milestones, next } = normalizeMilestones(params.milestones || params.plan, plan.nextMilestone);
      const errs = planProblems(milestones);
      if (errs.length) return fail(errs.join("; "));
      plan.milestones = milestones; plan.nextMilestone = next; plan.waiting = null;
      return out(`Plan created: ${milestones.length} milestone(s), ${milestones.flatMap((m) => m.steps).length} step(s).`, ["created"]);
    }
    case "revise": {
      if (!plan.milestones.length) return fail('there is no plan to revise; use action "create"');
      const reason = clip(params.reason || params.why, 400);
      if (!reason) return fail("say why the plan changes (reason)");
      // Keep finished work; replace everything unfinished with the new milestones.
      const kept = plan.milestones.map((m) => ({ ...m, steps: m.steps.filter((s) => FINAL.has(s.status)) })).filter((m) => m.steps.length);
      const { milestones, next } = normalizeMilestones(params.milestones || params.plan, plan.nextMilestone);
      const errs = milestones.length ? planProblems(milestones) : ["give the new milestones for the remaining work (finished steps are kept)"];
      if (errs.length) return fail(errs.join("; "));
      plan.milestones = [...kept, ...milestones]; plan.nextMilestone = next; plan.revisions++; plan.waiting = null;
      plan.lastRevision = reason;
      return out(`Plan revised (${reason}).`, ["revised"]);
    }
    case "start": {
      const hit = findStep(plan, params.step || params.id);
      if (!hit) return fail(`no step "${str(params.step || params.id)}"; use a step id like 1.2`);
      if (FINAL.has(hit.s.status)) return fail(`step ${hit.s.id} is already ${hit.s.status}`);
      for (const s of allSteps(plan)) if (s.status === "active" && s.id !== hit.s.id) findStep(plan, s.id).s.status = "pending";
      hit.s.status = "active";
      plan.waiting = null;
      return out(`Started step ${hit.s.id}: ${hit.s.title}`, ["step_started"]);
    }
    case "done":
    case "complete":
    case "skip": {
      const skip = action === "skip";
      // `done` without a step id means the step being worked on (small models often leave it out).
      const ref = params.step || params.id || (!skip ? currentStep(plan)?.id || "" : "");
      const hit = findStep(plan, ref);
      if (!hit) return fail(`no step "${str(ref)}"; use a step id like 1.2`);
      if (FINAL.has(hit.s.status)) return fail(`step ${hit.s.id} is already ${hit.s.status}`);
      const why = clip(skip ? params.reason || params.why || params.evidence : params.evidence || params.result || params.proof, 600);
      if (!why) return fail(skip ? "say why the step is skipped (reason)" : `give evidence that "${hit.s.doneWhen || hit.s.title}" holds (what you ran or saw)`);
      const wasDone = milestoneDone(hit.m);
      hit.s.status = skip ? "skipped" : "done";
      if (skip) hit.s.note = why; else hit.s.evidence = why;
      const events = [skip ? "step_skipped" : "step_done"];
      if (!wasDone && milestoneDone(hit.m)) events.push("milestone_done");
      if (planPhase(plan) === "complete") events.push("plan_done");
      return out(`${skip ? "Skipped" : "Done:"} step ${hit.s.id}${skip ? ` (${why})` : ""}.${events.includes("milestone_done") ? ` Milestone ${hit.m.id} "${hit.m.title}" reached.` : ""}`, events);
    }
    case "ask_user": {
      const q = clip(params.question || params.reason || params.text, 800);
      if (!q) return fail("give the question only the user can answer");
      plan.waiting = { question: q, at: now };
      return out(`Waiting for the user: ${q}`, ["ask_user"]);
    }
    case "show":
    case "list":
    case "":
      return { plan: asPlan(prev) || emptyPlan(), ok: true, text: renderPlan(asPlan(prev) || emptyPlan()), events: [] };
    default:
      return fail(`unknown action; use one of ${PLAN_ACTIONS.join(", ")}`);
  }
}

/**
 * The newest plan on a session's active branch, from pi's session entries (`get_entries`, which keeps
 * pre-compaction history): the plan tool's results and the extension's `omni-plan` entries. With
 * `leafId`, only the branch ending there counts (abandoned branches are skipped). Null when there is none.
 */
export function latestPlan(entries = [], leafId = null) {
  let branch = entries;
  if (leafId) {
    const byId = new Map(entries.map((e) => [e.id, e]));
    branch = [];
    for (let e = byId.get(leafId); e; e = e.parentId ? byId.get(e.parentId) : null) branch.unshift(e);
  }
  let plan = null;
  for (const e of branch) {
    const p = e?.type === "message" && e.message?.role === "toolResult" && e.message.toolName === PLAN_TOOL ? asPlan(e.message.details)
      : e?.type === "custom" && e.customType === "omni-plan" ? asPlan(e.data) : null;
    if (p) plan = p;
  }
  return plan;
}

/** A real user message answers an `ask_user`: the plan is no longer waiting. */
export function clearWaiting(plan) {
  const p = asPlan(plan);
  if (!p?.waiting) return p;
  return { ...p, waiting: null };
}

function nextHint(plan, events) {
  const ph = planPhase(plan);
  if (ph === "plan") return '\n\nNext: call plan with action "create" — milestones built from the chosen approach, each with small concrete steps that have a done_when check.';
  // A finished plan is not a finished goal: the plan may have covered only part of what the user asked for.
  if (ph === "complete") return `\n\nAll steps are done. First check the result against the success criteria${plan.brainstorm?.successCriteria?.length ? ` (${plan.brainstorm.successCriteria.join("; ")})` : ""} and against the user's overall goal. If any part of that goal is still not done, create the next plan for it (plan action "create") and continue working. Only when the whole goal is done, give the user a short final answer.`;
  if (ph === "waiting") return "\n\nStop now and ask the user that question in your reply.";
  const cur = currentStep(plan);
  if (!cur) return "";
  if (events.includes("created") || events.includes("revised") || events.includes("step_done") || events.includes("step_skipped")) return `\n\nNext: step ${cur.id} — ${cur.title}. Start it (action "start") and work on it.`;
  return "";
}

const MARK = { done: "[x]", skipped: "[-]", active: "[>]", pending: "[ ]" };

/** The whole plan as compact text (what the tool returns to the model). */
export function renderPlan(plan, { maxChars = 6000 } = {}) {
  const p = asPlan(plan);
  if (!p || (!p.brainstorm && !p.milestones.length)) return "No plan yet. Start with plan action \"brainstorm\".";
  const pr = planProgress(p);
  const lines = [`PLAN · ${pr.phase} · ${pr.done + pr.skipped}/${pr.steps} steps · milestone ${Math.min(pr.milestonesDone + (pr.complete ? 0 : 1), pr.milestones)}/${pr.milestones}`];
  if (p.brainstorm) {
    lines.push(`Approach: ${p.brainstorm.chosen}${p.brainstorm.rationale ? ` — ${p.brainstorm.rationale}` : ""}`);
    if (p.brainstorm.successCriteria.length) lines.push(`Done when: ${p.brainstorm.successCriteria.join("; ")}`);
  }
  for (const m of p.milestones) {
    const md = milestoneDone(m);
    lines.push(`${md ? "✓" : "○"} Milestone ${m.id}: ${m.title}`);
    for (const s of m.steps) lines.push(`  ${MARK[s.status] || "[ ]"} ${s.id} ${s.title}${s.status === "done" || s.status === "skipped" ? "" : s.doneWhen ? ` (done when: ${s.doneWhen})` : ""}`);
  }
  if (p.waiting) lines.push(`WAITING FOR USER: ${p.waiting.question}`);
  return clip(lines.join("\n"), maxChars);
}

/**
 * The short reminder put in front of the model on every call while a plan is open, so it survives
 * compaction: finished milestones collapse to one line, the current milestone is shown in full, later
 * ones by title only.
 */
export function planReminder(plan, { maxChars = 1800 } = {}) {
  const p = asPlan(plan);
  if (!p) return "";
  const ph = planPhase(p);
  if (ph === "complete" || (!p.brainstorm && !p.milestones.length)) return "";
  if (ph === "plan") return `<omni-plan>Brainstorm done (approach: ${clip(p.brainstorm.chosen, 200)}). Next: create the plan with plan action "create".</omni-plan>`;
  const pr = planProgress(p);
  const cur = currentStep(p);
  const lines = [`<omni-plan phase="${ph}" progress="${pr.done + pr.skipped}/${pr.steps}">`];
  for (const m of p.milestones) {
    if (milestoneDone(m)) { lines.push(`✓ ${m.id} ${m.title}`); continue; }
    if (cur && cur.milestone.id === m.id) {
      lines.push(`○ ${m.id} ${m.title}`);
      for (const s of m.steps) lines.push(`  ${MARK[s.status] || "[ ]"} ${s.id} ${s.title}${FINAL.has(s.status) ? "" : ` (done when: ${s.doneWhen})`}`);
    } else lines.push(`○ ${m.id} ${m.title} (${m.steps.length} steps)`);
  }
  if (p.waiting) lines.push(`Waiting for the user: ${p.waiting.question}`);
  else if (cur) lines.push(`Now: step ${cur.id} — ${cur.title}. When its check passes, call plan action "done" with evidence; revise the plan if it turns out wrong.`);
  lines.push("</omni-plan>");
  return clip(lines.join("\n"), maxChars);
}

/** The goal hook's "keep going" text for an unfinished plan. Deterministic: no model involved. */
export function planNudge(plan) {
  const p = asPlan(plan);
  const pr = planProgress(p);
  if (pr.phase === "plan") return `Your brainstorm is recorded but there is no plan yet. Create it now with plan action "create" (milestones → small steps, each with done_when), then start executing step 1.1.`;
  const cur = currentStep(p);
  const where = `${pr.done + pr.skipped}/${pr.steps} steps done, milestone ${pr.milestonesDone + 1}/${pr.milestones}${pr.currentMilestone ? ` "${pr.currentMilestone.title}"` : ""}`;
  return [
    `You stopped, but your plan is not finished (${where}).`,
    cur ? `Current step ${cur.id}: ${cur.title}\nDone when: ${cur.doneWhen || "(no check given)"}` : "",
    `Continue now: work on step ${cur?.id || "the next unfinished step"}, mark it done with plan action "done" and evidence once its check passes, then move to the next step. If the plan turned out wrong, use plan action "revise" with a reason; if you truly need something only the user can give, use plan action "ask_user".`,
  ].filter(Boolean).join("\n\n");
}
