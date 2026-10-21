/**
 * Omni Agent → background agents and jobs for pi.
 *
 *   agent_start / agent_status / agent_wait / agent_message / agent_cancel
 *       another pi agent (kind "pi") or Claude Code (kind "claude") works on a self-contained task in
 *       the background, as its own chat in Omni nested under this one; this chat keeps working.
 *   job_start / job_wait / job_output / job_kill
 *       a long shell command (build, device boot, scan) in the background, with a wait-for-log-line.
 *
 * The agents run in the Omni server (`/api/agents`, its AgentManager), not in this pi process, so they
 * survive this chat's turn ending. When one finishes, its report is posted into this chat as an
 * `omni-agent-result` message (followUp + triggerTurn: it wakes an idle chat), by ONE poller per session
 * that long-polls the server; agent_wait / job_wait / claude_task hold that poller while they wait
 * themselves, so a report reaches the chat once. Identity: the chat's session id (parentSessionId),
 * its Omni sid ("pi:" + id), and OMNI_AGENT_DEPTH (set by the server for an agent's own pi).
 *
 * Config: ~/.pi/agent/omni-agent.json  { "port": 4400 }  (OMNI_AGENT_URL, set by the spawning server, wins)
 * Installed by: node scripts/install.mjs   (in the omni-agent folder; ships omni-agents-lib.mjs beside it)
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	AgentsClient, MAX_RESULT, agentReport, chunkSecFor, claim, clip, confirmDelivered, describeAgent, elapsedOf, ensurePoller, fmtDuration, identity, isFinished,
	kindLabel, omniBase, oneLine, pausePoller, piHttpTimeoutMs, resumeDelivery, statusLine, stopPollers, titleFor, waitAgents, waitJob,
} from "./omni-agents-lib.mjs";

const MAX_WAIT_SEC = 3600;
const MAX_LOG = 12000;
const waitMs = (sec: unknown, dflt = 600) => Math.min(MAX_WAIT_SEC, Math.max(1, Number(sec) || dflt)) * 1000;
const reply = (text: string, details: Record<string, unknown> = {}) => ({ content: [{ type: "text" as const, text }], details });

/** One-line call header + an 8-line result preview, like claude_task's. */
function renderer(name: string, summary: (args: any) => string) {
	return {
		renderCall(args: any, theme: any) {
			return new Text(theme.fg("toolTitle", theme.bold(`${name} `)) + theme.fg("muted", String(summary(args) ?? "").replace(/\s+/g, " ").slice(0, 100)), 0, 0);
		},
		renderResult(result: any, { expanded }: any, theme: any) {
			const t = result.content?.[0];
			const text = t?.type === "text" ? t.text : "";
			const lines = text.split("\n");
			return new Text(theme.fg("toolOutput", expanded ? text : lines.slice(0, 8).join("\n") + (lines.length > 8 ? `\n... ${lines.length - 8} more lines` : "")), 0, 0);
		},
	};
}

export default function omniAgents(pi: ExtensionAPI) {
	const client = new AgentsClient({ base: omniBase(), chunkSec: chunkSecFor(piHttpTimeoutMs()) });
	/** The newest context pi handed us: tells the poller whether the chat is idle (a queued report it never got was lost). */
	let lastCtx: any = null;
	const isIdle = () => { try { return lastCtx?.isIdle?.() ?? true; } catch { return true; } };
	const deliverTo = (ctx: any) => { lastCtx = ctx; return ensurePoller({ client, parentSessionId: identity(ctx).parentSessionId, pi, isIdle }); };
	/** A report the model already sees in a tool result must not arrive again as a message. → false when it already did. */
	const delivered = async (rec: any) => { const fresh = claim(rec); try { await client.delivered(rec.id); } catch { /* the poller acks it later */ } return fresh; };
	/**
	 * agent_cancel / job_kill: stop it with this chat's poller held, so the cancelled record is not posted
	 * back as a wake-up message (the server answers the poller's wait before the cancel itself).
	 * → `ended`: it had finished by itself and its report has not reached the chat yet.
	 */
	const stop = async (id: string, ctx: any) => {
		const release = pausePoller(identity(ctx).parentSessionId);
		try {
			const rec = await client.cancel(id);
			const fresh = await delivered(rec);
			return { rec, ended: fresh && rec.status !== "cancelled" };
		} finally { release(); }
	};
	const needSession = (me: { parentSessionId: string }) => {
		if (!me.parentSessionId) throw new Error("this chat has no session id (pi --no-session?), so its background agents cannot be found");
	};

	// Delivery survives a pi restart: a chat reopened with agents still out (or reports not yet read) gets them.
	pi.on("session_start", async (_event, ctx) => {
		lastCtx = ctx;
		void resumeDelivery({ client, parentSessionId: identity(ctx).parentSessionId, pi, isIdle }).catch(() => { /* Omni not running: nothing to resume */ });
	});
	// A posted report counts as delivered only once it is in the session (its message_end); a report pi only queued
	// and then lost (Stop, a crash, a restart) is posted again by the poller.
	pi.on("message_end", async (event: any, ctx: any) => {
		if (ctx) lastCtx = ctx;
		const m = event?.message;
		const id = m?.role === "custom" && m.customType === "omni-agent-result" ? m.details?.id : null;
		if (!id) return;
		confirmDelivered(id);
		try { await client.delivered(id); } catch { /* the server also acks it when it sees the report in the chat */ }
	});
	pi.on("session_shutdown", async () => { stopPollers(pi); });

	pi.registerTool({
		name: "agent_start",
		label: "Start background agent",
		description: [
			"Start a background agent on a self-contained task. Returns at once — it does not block you.",
			"kind \"pi\" (default): another pi agent with the same tools — for an independent sub-investigation, a search or scan, a device test loop.",
			"kind \"claude\": Claude Code, a strong agentic coding model — for a big coding job, a multi-file refactor, tricky debugging.",
			"Each agent is its own chat in Omni (shown under this one). It works alone and nobody answers its questions, so the task must carry everything: the goal, the context it needs (paths, findings, ids), constraints, and what to report back.",
			"Its final report arrives in this chat as a message when it finishes. agent_status shows progress, agent_wait waits for a report, agent_message sends it more instructions, agent_cancel stops it.",
			"`agent` names a pi persona from ~/.pi/agent/agents (e.g. scout, re-analyst, droid-operator).",
		].join(" "),
		promptSnippet: "Start a background pi or Claude Code agent on a self-contained task; its report arrives as a message",
		promptGuidelines: [
			"Split big work: hand independent sub-investigations to background agents running in parallel (several agent_start calls, kind \"pi\") instead of doing them one after another in this chat — it keeps your context small and finishes sooner.",
			"Give big coding, refactoring or debugging jobs to a Claude Code agent: agent_start with kind \"claude\".",
			"Every agent_start task must be complete and self-contained: the goal, the relevant context (files, findings so far, ids), constraints, and exactly what to report back. The agent cannot see this chat and nobody answers its questions.",
			"After agent_start keep working on something else: each agent's report arrives by itself as an [omni-agent-result] message. Do not poll agent_status in a loop; call agent_wait only when nothing else is left to do until a report is in.",
			"Prefer agent_start over the blocking subagent tool for anything that may take more than a few minutes. Do not delegate trivial steps (one command, one file read).",
		],
		parameters: Type.Object({
			task: Type.String({ description: "The complete, self-contained task: goal, context (paths, findings, ids), constraints, what to report back" }),
			kind: Type.Optional(StringEnum(["pi", "claude"], { description: "pi (default): another pi agent; claude: Claude Code" })),
			agent: Type.Optional(Type.String({ description: "pi persona from ~/.pi/agent/agents/<name>.md (kind pi), e.g. scout" })),
			title: Type.Optional(Type.String({ description: "Short title for the agent's chat (default: the start of the task)" })),
			cwd: Type.Optional(Type.String({ description: "Working directory (default: the current one)" })),
			model: Type.Optional(Type.String({ description: "Model id (default: this chat's model for pi, Claude Code's default for claude)" })),
			thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh"], { description: "pi thinking level (kind pi)" })),
		}),
		async execute(_id: string, params: any, _signal: AbortSignal | undefined, _update: unknown, ctx: any) {
			const me = identity(ctx);
			const kind = params.kind === "claude" ? "claude" : "pi";
			// A pi agent runs on this chat's model unless told otherwise (a persona may pin its own).
			const inherit = kind === "pi" && !params.model && !params.agent && ctx?.model?.id;
			const rec = await client.start({
				kind, task: params.task, title: params.title || titleFor(params.task), cwd: params.cwd || ctx?.cwd, agent: params.agent,
				model: params.model || (inherit ? ctx.model.id : undefined), provider: inherit ? ctx.model.provider : undefined,
				thinking: kind === "pi" ? params.thinking : undefined,
				parentSid: me.parentSid, parentSessionId: me.parentSessionId, depth: me.depth,
			});
			deliverTo(ctx);
			const queued = rec.status === "queued" ? " It is queued until a slot frees (the agent limit is reached)." : "";
			return reply(
				`Started ${kind} agent ${rec.id} "${rec.title || titleFor(params.task)}" — it runs in the background; its report arrives as a message when it finishes.${queued} Keep working. agent_wait / agent_status to check, agent_message to steer it, agent_cancel to stop it.`,
				{ id: rec.id, kind, status: rec.status },
			);
		},
		...renderer("agent_start", (a) => `${a.kind || "pi"}${a.agent ? `/${a.agent}` : ""}: ${a.title || a.task || ""}`),
	} as any);

	pi.registerTool({
		name: "agent_status",
		label: "Background agent status",
		description: "Show this chat's background agents and jobs (status, run time, title, last activity), or one of them in detail (with `id`: its task, recent activity, and a preview of its result once finished).",
		promptSnippet: "Show the background agents/jobs of this chat, or one in detail",
		parameters: Type.Object({ id: Type.Optional(Type.String({ description: "An agent or job id (a-…); omit for all of this chat's" })) }),
		async execute(_id: string, params: any, _signal: AbortSignal | undefined, _update: unknown, ctx: any) {
			if (params.id) {
				const rec = await client.get(params.id);
				return reply(describeAgent(rec), { id: rec.id, status: rec.status });
			}
			const me = identity(ctx);
			needSession(me);
			const list = await client.list({ parentSessionId: me.parentSessionId });
			if (!list.length) return reply("No background agents or jobs in this chat.", { agents: [] });
			const now = Date.now();
			const active = list.filter((a: any) => !isFinished(a)).length;
			const shown = list.slice(0, 30).map((a: any) => statusLine(a, now) + (isFinished(a) && a.resultText ? `\n    → ${oneLine(a.resultText, 160)}` : "")).join("\n");
			return reply(
				`${list.length} background agent${list.length === 1 ? "" : "s"}/job${list.length === 1 ? "" : "s"}, ${active} active:\n${shown}${list.length > 30 ? `\n… ${list.length - 30} older` : ""}`,
				{ agents: list.map((a: any) => ({ id: a.id, kind: a.kind, status: a.status })) },
			);
		},
		...renderer("agent_status", (a) => a.id || "all"),
	} as any);

	pi.registerTool({
		name: "agent_wait",
		label: "Wait for background agents",
		description: "Wait until one of the given background agents (or, without ids, any of this chat's) finishes, and return its report; agents whose report you already got are skipped. Gives up after timeoutSeconds (default 600, max 3600) and leaves them running. Usually you do not need this: reports arrive as messages by themselves — use it only when nothing else is left to do until a result is in.",
		promptSnippet: "Wait for a background agent's report (only when there is nothing else to do)",
		parameters: Type.Object({
			ids: Type.Optional(Type.Array(Type.String(), { description: "Agent ids to wait for (default: any of this chat's)" })),
			timeoutSeconds: Type.Optional(Type.Number({ description: "Give up after this many seconds (default 600, max 3600)" })),
		}),
		async execute(_id: string, params: any, signal: AbortSignal | undefined, onUpdate: any, ctx: any) {
			const me = identity(ctx);
			const ids = (params.ids || []).map(String).filter(Boolean);
			if (!ids.length) needSession(me);
			const timeoutMs = waitMs(params.timeoutSeconds);
			const release = pausePoller(me.parentSessionId);
			let r: any;
			const seen = new Set<string>();
			try {
				// Only unreported ones, with ids too: a report the model already has is not handed back, the rest is waited for.
				r = await waitAgents(client, {
					ids, parentSessionId: ids.length ? undefined : me.parentSessionId, undeliveredOnly: true, timeoutMs, signal,
					onChunk: ({ pending, elapsedMs }: any) => onUpdate?.(reply(`Waiting (${fmtDuration(elapsedMs)}) for ${pending.map((a: any) => a.id).join(", ")}`, { pending: pending.map((a: any) => a.id) })),
				});
				for (const rec of r.finished) if (!(await delivered(rec))) seen.add(rec.id);
			} finally { release(); }
			if (r.aborted) return reply("Stopped waiting. The agents keep running; their reports arrive as messages.", { aborted: true });
			if (r.empty) {
				if (!ids.length) return reply("No background agent of this chat is running, and every finished one has been reported.", { finished: [] });
				const recs = await Promise.all(ids.map((id: string) => client.get(id).catch(() => null)));
				const known = recs.filter(Boolean), unknown = ids.filter((_: string, i: number) => !recs[i]);
				const lines = [
					known.length ? `Nothing to wait for: already finished and reported (agent_status <id> shows a result again):\n${known.map((a: any) => statusLine(a)).join("\n")}` : "Nothing to wait for.",
					unknown.length ? `No such agent: ${unknown.join(", ")}` : "",
				].filter(Boolean);
				return reply(lines.join("\n"), { finished: [], reported: known.map((a: any) => a.id), unknown });
			}
			const now = Date.now();
			const still = r.pending.length ? `\n\nStill running:\n${r.pending.map((a: any) => statusLine(a, now)).join("\n")}` : "";
			if (r.timedOut) return reply(`No agent finished within ${fmtDuration(timeoutMs)}.${still}\nThey keep running; each report arrives as a message when it finishes (or agent_wait again).`, { timedOut: true, pending: r.pending.map((a: any) => a.id) });
			// One the poller posted just before it was held: its report is already in the chat.
			const report = (rec: any) => (seen.has(rec.id) ? `${statusLine(rec, now)}\n(its report already arrived as a message)` : agentReport(rec, { resultMax: MAX_RESULT }));
			return reply(
				r.finished.map(report).join("\n\n---\n\n") + still,
				{ finished: r.finished.map((a: any) => ({ id: a.id, status: a.status })), pending: r.pending.map((a: any) => a.id) },
			);
		},
		...renderer("agent_wait", (a) => (a.ids?.length ? a.ids.join(", ") : "any")),
	} as any);

	pi.registerTool({
		name: "agent_message",
		label: "Message a background agent",
		description: "Send a background agent more instructions. A running pi agent gets it after its current step (Claude Code at once); a finished one is resumed on its own session with the message and reports again when done.",
		promptSnippet: "Send a background agent a follow-up instruction",
		parameters: Type.Object({
			id: Type.String({ description: "The agent id (a-…)" }),
			message: Type.String({ description: "The instruction or answer to send" }),
		}),
		async execute(_id: string, params: any, _signal: AbortSignal | undefined, _update: unknown, ctx: any) {
			const r = await client.message(params.id, params.message);
			if (!r.ok) return reply(`Agent ${params.id} did not take the message.`, { ok: false });
			deliverTo(ctx);
			const how: Record<string, string> = {
				steer: "it receives it in its current run",
				followUp: "it receives it when its current step ends",
				resumed: "it had finished and is running again with your message",
				restarted: "it had stopped and was restarted on its session with your message",
			};
			return reply(`Message delivered to agent ${params.id}: ${how[r.how] || r.how}. Its next report arrives as a message.`, { ok: true, how: r.how });
		},
		...renderer("agent_message", (a) => `${a.id}: ${a.message || ""}`),
	} as any);

	pi.registerTool({
		name: "agent_cancel",
		label: "Stop a background agent",
		description: "Stop a background agent (and its process tree). Its partial result is kept in Omni.",
		promptSnippet: "Stop a background agent",
		parameters: Type.Object({ id: Type.String({ description: "The agent id (a-…)" }) }),
		async execute(_id: string, params: any, _signal: AbortSignal | undefined, _update: unknown, ctx: any) {
			const { rec, ended } = await stop(params.id, ctx);
			if (ended) return reply(`${kindLabel(rec.kind).replace(/^./, (c) => c.toUpperCase())} ${rec.id} had already ended, so nothing was stopped. Its report:\n\n${agentReport(rec, { resultMax: MAX_RESULT })}`, { id: rec.id, status: rec.status });
			return reply(`Stopped ${kindLabel(rec.kind)} ${rec.id} "${rec.title || ""}" (${rec.status}).`, { id: rec.id, status: rec.status });
		},
		...renderer("agent_cancel", (a) => a.id),
	} as any);

	pi.registerTool({
		name: "job_start",
		label: "Start background job",
		description: "Run a shell command as a background job (bash -lc, its output goes to a log). Returns at once. For anything that may take more than ~2 minutes: builds, device boots, downloads, long scans, test suites, waiting for a log line — never sleep-poll in bash. job_wait waits for a log line or the exit, job_output reads the log, job_kill stops it; the exit and log tail also arrive as a message when it ends.",
		promptSnippet: "Run a long shell command in the background (then job_wait for a log line or its exit)",
		promptGuidelines: [
			"Run anything that may take more than ~2 minutes (builds, device boots, downloads, long scans, test suites, waiting for a log line) with job_start, then job_wait {id, until} for the line or the exit — never `sleep`-poll in bash or block the chat on a long foreground command.",
			"A finished job's exit status and log tail arrive by themselves as a message; job_output reads its log at any time, job_kill stops it.",
		],
		parameters: Type.Object({
			command: Type.String({ description: "The shell command (run with bash -lc)" }),
			cwd: Type.Optional(Type.String({ description: "Working directory (default: the current one)" })),
			title: Type.Optional(Type.String({ description: "Short title (default: the command)" })),
			timeoutMinutes: Type.Optional(Type.Number({ description: "Kill it after this many minutes (default 120)" })),
		}),
		async execute(_id: string, params: any, _signal: AbortSignal | undefined, _update: unknown, ctx: any) {
			const me = identity(ctx);
			const rec = await client.start({
				kind: "shell", command: params.command, cwd: params.cwd || ctx?.cwd, title: params.title || titleFor(params.command),
				timeoutMinutes: Math.max(1, Number(params.timeoutMinutes) || 120),
				parentSid: me.parentSid, parentSessionId: me.parentSessionId, depth: me.depth,
			});
			deliverTo(ctx);
			return reply(
				`Started job ${rec.id} "${rec.title || titleFor(params.command)}" in the background. job_wait {id: "${rec.id}", until: "<regex>"} waits for a log line or its exit; job_output shows the log; job_kill stops it. Its exit and log tail arrive as a message when it ends.`,
				{ id: rec.id, status: rec.status },
			);
		},
		...renderer("job_start", (a) => a.command),
	} as any);

	pi.registerTool({
		name: "job_wait",
		label: "Wait for a background job",
		description: "Wait until a background job's log matches `until` (a regular expression, e.g. \"BUILD SUCCESSFUL|error:\") or the job ends; returns whether it matched, the job's status and the log tail. Gives up after timeoutSeconds (default 600, max 3600) and leaves the job running.",
		promptSnippet: "Wait for a background job's log line or its exit",
		parameters: Type.Object({
			id: Type.String({ description: "The job id (a-…)" }),
			until: Type.Optional(Type.String({ description: "Regular expression to wait for in the log (default: wait for the exit)" })),
			timeoutSeconds: Type.Optional(Type.Number({ description: "Give up after this many seconds (default 600, max 3600)" })),
		}),
		async execute(_id: string, params: any, signal: AbortSignal | undefined, onUpdate: any, ctx: any) {
			const me = identity(ctx);
			const timeoutMs = waitMs(params.timeoutSeconds);
			const release = pausePoller(me.parentSessionId);
			let r: any;
			let rec: any = null;
			try {
				r = await waitJob(client, {
					id: params.id, until: params.until, timeoutMs, signal,
					onChunk: ({ status, elapsedMs }: any) => onUpdate?.(reply(`Waiting (${fmtDuration(elapsedMs)}) for job ${params.id}${params.until ? ` to log /${params.until}/` : " to end"} — ${status || "running"}`, { id: params.id })),
				});
				if (isFinished(r)) {
					try { rec = await client.get(params.id); } catch { rec = null; }
					await delivered(rec || { id: params.id });
				}
			} finally { release(); }
			const tail = r.tail ? `\n\n--- log tail ---\n${clip(r.tail, MAX_LOG)}` : "";
			if (r.aborted) return reply(`Stopped waiting; job ${params.id} keeps running.${tail}`, { id: params.id, aborted: true });
			const exit = rec?.exitCode != null ? ` (exit ${rec.exitCode})` : "";
			const el = rec && elapsedOf(rec) ? ` after ${elapsedOf(rec)}` : "";
			const head = r.matched
				? `Job ${params.id}: the log matched /${params.until}/ (${isFinished(r) ? `it ended: ${r.status}${exit}` : "still running"}).`
				: isFinished(r) ? `Job ${params.id} ended: ${r.status}${exit}${el}.`
					: `Job ${params.id} is still running after ${fmtDuration(timeoutMs)}${params.until ? `; /${params.until}/ has not appeared` : ""}. Its exit arrives as a message (or job_wait again).`;
			return reply(head + tail, { id: params.id, matched: r.matched, status: r.status, timedOut: !!r.timedOut, exitCode: rec?.exitCode ?? null });
		},
		...renderer("job_wait", (a) => `${a.id}${a.until ? ` until /${a.until}/` : ""}`),
	} as any);

	pi.registerTool({
		name: "job_output",
		label: "Background job output",
		description: "Show a background job's status and the last lines of its log.",
		promptSnippet: "Read a background job's log tail",
		parameters: Type.Object({
			id: Type.String({ description: "The job id (a-…)" }),
			tail: Type.Optional(Type.Number({ description: "How many log lines (default 80)" })),
		}),
		async execute(_id: string, params: any) {
			const tail = Math.max(1, Math.floor(Number(params.tail) || 80));
			const [rec, text] = await Promise.all([client.get(params.id), client.log(params.id, tail)]);
			return reply(`${statusLine(rec)}\n--- last ${tail} lines ---\n${clip(text, MAX_LOG) || "(no output yet)"}`, { id: rec.id, status: rec.status });
		},
		...renderer("job_output", (a) => a.id),
	} as any);

	pi.registerTool({
		name: "job_kill",
		label: "Stop a background job",
		description: "Stop a background job and its whole process tree.",
		promptSnippet: "Stop a background job",
		parameters: Type.Object({ id: Type.String({ description: "The job id (a-…)" }) }),
		async execute(_id: string, params: any, _signal: AbortSignal | undefined, _update: unknown, ctx: any) {
			const { rec, ended } = await stop(params.id, ctx);
			if (ended) return reply(`Job ${rec.id} had already ended, so nothing was stopped. Its report:\n\n${agentReport(rec, { resultMax: MAX_LOG })}`, { id: rec.id, status: rec.status, exitCode: rec.exitCode ?? null });
			return reply(`Stopped job ${rec.id} "${rec.title || ""}" (${rec.status}).`, { id: rec.id, status: rec.status });
		},
		...renderer("job_kill", (a) => a.id),
	} as any);
}
