/**
 * Omni Agent planner for pi: a `plan` tool the model uses to brainstorm, write and execute a plan.
 *
 *   brainstorm → create → (start → done | skip)* → complete      revise / ask_user at any time
 *
 * The plan lives in the `plan` tool results' `details` (so it follows the session and its branches, and
 * Omni's goal hook reads it from the RPC stream without asking any model whether the work is finished),
 * plus an `omni-plan` entry when a user's answer clears an `ask_user`. While a plan is open, a short
 * reminder of it (current milestone, current step, its check) is appended to the newest message of every
 * LLM call — not persisted, and placed at the tail so the prompt cache in front of it is kept — so the
 * plan survives compactions and long runs.
 *
 * The state machine is ui/plan.js, installed beside this file as omni-plan-lib.mjs.
 * Installed by: node scripts/install.mjs
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { PLAN_TOOL, PLAN_ACTIONS, applyPlanAction, asPlan, clearWaiting, emptyPlan, planProgress, planReminder, renderPlan } from "./omni-plan-lib.mjs";

const HOOK_PROMPT = /^\s*<omni-hook\b/;

// The fields are optional and extra properties are allowed on purpose: the state machine
// (applyPlanAction → normalizeMilestones/normalizeSteps in omni-plan-lib.mjs) is already tolerant of the
// model's near-miss shapes (done_when on a milestone, `tasks` for `steps`, a missing title it derives),
// but pi validates this schema BEFORE execute() runs — a strict schema hard-rejected those calls (the
// measured runs lost 3 `revise` calls to "milestones.N.title: must have required properties title"). The
// descriptions still steer the model; a genuinely unusable plan comes back as a readable, fixable tool
// result from planProblems, not a validation failure the model cannot see the body of.
const Step = Type.Object({
	title: Type.Optional(Type.String({ description: "One concrete action, e.g. 'add the retry loop to fetchUser in src/api.ts'" })),
	done_when: Type.Optional(Type.String({ description: "The check that proves this step worked, e.g. 'npm test passes', 'the log shows 200'" })),
}, { additionalProperties: true });
const Milestone = Type.Object({
	title: Type.Optional(Type.String({ description: "A meaningful checkpoint, e.g. 'Parser handles all fixtures'" })),
	steps: Type.Optional(Type.Array(Step, { description: "2-6 small steps that reach the milestone, each with a done_when check" })),
}, { additionalProperties: true });

export default function omniPlan(pi: ExtensionAPI) {
	let plan: any = emptyPlan();

	const reconstruct = (ctx: ExtensionContext) => {
		plan = emptyPlan();
		for (const e of ctx.sessionManager.getBranch() as any[]) {
			if (e.type === "message" && e.message?.role === "toolResult" && e.message.toolName === PLAN_TOOL) { const p = asPlan(e.message.details); if (p) plan = p; }
			else if (e.type === "custom" && e.customType === "omni-plan") { const p = asPlan(e.data); if (p) plan = p; }
		}
	};
	pi.on("session_start", async (_e, ctx) => reconstruct(ctx));
	pi.on("session_tree", async (_e, ctx) => reconstruct(ctx));

	// A real user message answers an ask_user (the goal hook's own prompts do not).
	pi.on("before_agent_start", async (ev: any) => {
		if (plan.waiting && !HOOK_PROMPT.test(String(ev.prompt ?? ""))) {
			plan = clearWaiting(plan);
			pi.appendEntry("omni-plan", { plan });
		}
		return undefined;
	});

	// Keep the open plan in front of the model on every call, at the tail (cache-friendly), never persisted.
	pi.on("context", async (ev: any) => {
		try {
			const note = planReminder(plan);
			if (!note || !ev.messages?.length) return undefined;
			const messages = ev.messages;
			const last = messages[messages.length - 1];
			if (last.role !== "user" && last.role !== "toolResult") return undefined;
			const content = typeof last.content === "string" ? [{ type: "text", text: last.content }] : [...(last.content || [])];
			content.push({ type: "text", text: `\n${note}` });
			return { messages: [...messages.slice(0, -1), { ...last, content }] };
		} catch {
			return undefined;
		}
	});

	pi.registerTool({
		name: PLAN_TOOL,
		label: "Plan",
		description: [
			"Your planner for any task that needs more than a few steps. Work in this order:",
			"1. brainstorm — before touching anything: understanding (the goal in your own words, scope), assumptions (unknowns you must check), approaches (at least two real options with trade-offs), chosen + rationale, success_criteria (how you will verify the whole goal is done). Explore the code/files first if you need to.",
			"2. create — milestones (meaningful checkpoints), each with small concrete steps; every step has done_when, a check that proves it worked.",
			"3. execute — start a step, do it, verify its check, then done with evidence (what you ran/saw). One step at a time. skip a step only with a reason.",
			"revise (with a reason) when you learn the plan is wrong — finished steps are kept. ask_user only for something only the user can provide (a choice, a credential, a risky confirmation). show prints the plan.",
			"The goal is finished when every step is done; the user's status box is updated at each milestone.",
		].join("\n"),
		promptSnippet: "Brainstorm, plan and track multi-step work (brainstorm → create → start/done)",
		promptGuidelines: [
			"For any task that needs more than a few tool calls, use the plan tool before doing the work: brainstorm first, then create the plan, then execute it step by step, marking each step done with evidence.",
			"Skip the plan tool only for quick questions and one-step changes.",
			"Do not stop while the plan tool shows unfinished steps: continue with the next step, revise the plan, or use plan action ask_user when only the user can unblock you.",
		],
		parameters: Type.Object({
			action: StringEnum(PLAN_ACTIONS as unknown as ["brainstorm", "create", "start", "done", "skip", "revise", "ask_user", "show"]),
			understanding: Type.Optional(Type.String({ description: "brainstorm: the goal in your own words, what is in and out of scope" })),
			assumptions: Type.Optional(Type.Array(Type.String(), { description: "brainstorm: assumptions and unknowns to check" })),
			approaches: Type.Optional(Type.Array(Type.Object({ name: Type.String(), tradeoffs: Type.String() }), { description: "brainstorm: at least two different approaches with their trade-offs" })),
			chosen: Type.Optional(Type.String({ description: "brainstorm: the approach you take" })),
			rationale: Type.Optional(Type.String({ description: "brainstorm: why that approach" })),
			success_criteria: Type.Optional(Type.Array(Type.String(), { description: "brainstorm: how you will verify the whole goal is done" })),
			milestones: Type.Optional(Type.Array(Milestone, { description: "create / revise: the milestones (for revise: only the remaining work)" })),
			step: Type.Optional(Type.String({ description: "start / done / skip: the step id, e.g. '1.2'" })),
			evidence: Type.Optional(Type.String({ description: "done: what you ran or saw that proves the step's check passed" })),
			reason: Type.Optional(Type.String({ description: "skip / revise: why" })),
			question: Type.Optional(Type.String({ description: "ask_user: the question only the user can answer" })),
		}),
		async execute(_id, params) {
			const r = applyPlanAction(plan, params as any);
			if (r.ok) plan = r.plan;
			return { content: [{ type: "text", text: r.text }], details: { plan: r.plan, events: r.events, ok: r.ok, action: (params as any).action } };
		},
		renderCall(args: any, theme) {
			const extra = args.step ? ` ${args.step}` : args.action === "brainstorm" && args.chosen ? ` → ${args.chosen}` : "";
			return new Text(theme.fg("toolTitle", theme.bold("plan ")) + theme.fg("muted", `${args.action ?? ""}${extra}`), 0, 0);
		},
		renderResult(result: any, { expanded }, theme) {
			const d = result.details;
			if (!d?.plan) { const t = result.content?.[0]; return new Text(t?.type === "text" ? t.text : "", 0, 0); }
			if (!d.ok) return new Text(theme.fg("error", String(result.content?.[0]?.text ?? "").split("\n")[0]), 0, 0);
			const pr = planProgress(d.plan);
			const head = theme.fg("success", `${pr.phase} · ${pr.done + pr.skipped}/${pr.steps} steps · ${pr.milestonesDone}/${pr.milestones} milestones`);
			return new Text(expanded ? `${head}\n${theme.fg("toolOutput", renderPlan(d.plan))}` : head, 0, 0);
		},
	});

	pi.registerCommand("plan", {
		description: "Show the agent's current plan",
		handler: async (_args, ctx) => { ctx.ui.notify(renderPlan(plan), "info"); },
	});
}
