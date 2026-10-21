/**
 * Omni Agent → Claude Code delegation for pi.
 *
 * Gives the pi model (e.g. the local Qwen) one tool:
 *
 *   claude_task — hand a task to Claude Code and wait for its answer.
 *
 * The task runs as a background Claude agent of the Omni Agent server (`POST /api/agents`, kind
 * "claude"), so it shows up live in Omni's sidebar as its own chat nested under this one ("Task from
 * pi: …") and its tokens are accounted for. The tool waits in ≤ 240 s requests (pi's HTTP client
 * drops a response whose headers take longer: that killed the old single 15-minute request). After
 * `timeoutMinutes` it returns what it has and leaves Claude running; the answer then arrives as an
 * `omni-agent-result` message (see omni-agents.ts). Stopping the pi run stops the Claude agent.
 * The answer ends with the session id; pass that id back as `resume` to continue the same Claude
 * conversation.
 *
 * Config: ~/.pi/agent/omni-agent.json  { "root": "<omni-agent folder>", "port": 4400 }  (OMNI_AGENT_URL wins)
 * Installed by: node scripts/install.mjs   (in the omni-agent folder)
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	AgentsClient, MAX_RESULT, chunkSecFor, claim, claudeFooter, clip, ensurePoller, fmtDuration, identity, omniBase, pausePoller, piHttpTimeoutMs, stopPollers, waitAgents,
} from "./omni-agents-lib.mjs";

const reply = (text: string, details: Record<string, unknown>) => ({ content: [{ type: "text" as const, text }], details });

export default async function omniClaude(pi: ExtensionAPI) {
	const client = new AgentsClient({ base: omniBase(), chunkSec: chunkSecFor(piHttpTimeoutMs()) });
	pi.on("session_shutdown", async () => { stopPollers(pi); });

	pi.registerTool({
		name: "claude_task",
		label: "Claude Code task",
		description: "Delegate a self-contained task to Claude Code (a strong agentic coding model with full access to the working directory) and wait for its answer. Use it for larger coding jobs, multi-file refactors, debugging, or anything you want a second, more capable agent to do end to end. Describe the task fully: goal, constraints, what to report back. Runs in the current working directory unless `cwd` is given. Returns Claude's final answer and a session id; pass that id as `resume` to continue the same Claude conversation with a follow-up. If it takes longer than timeoutMinutes, Claude keeps running and its answer arrives later as a message. To keep working while Claude runs, use agent_start with kind \"claude\" instead.",
		promptSnippet: "Delegate a task to Claude Code and get its answer",
		parameters: Type.Object({
			task: Type.String({ description: "The complete task description for Claude Code" }),
			cwd: Type.Optional(Type.String({ description: "Working directory (default: the current one)" })),
			model: Type.Optional(Type.String({ description: "Claude model id, e.g. claude-opus-5, claude-sonnet-5 (default: Claude Code's default)" })),
			resume: Type.Optional(Type.String({ description: "A session id returned by a previous claude_task, to continue that conversation" })),
			timeoutMinutes: Type.Optional(Type.Number({ description: "Stop waiting after this many minutes (default 15); Claude keeps running and its answer arrives as a message" })),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			const me = identity(ctx);
			const minutes = Number(params.timeoutMinutes) > 0 ? Number(params.timeoutMinutes) : 15;
			let rec: any;
			try {
				rec = await client.start({
					kind: "claude", task: params.task, cwd: params.cwd || ctx.cwd, model: params.model, resume: params.resume,
					// memory: the vault memory pack in Claude's system prompt, as the old /api/claude/task did (the server composes it).
					title: `Task from pi: ${params.task.replace(/\s+/g, " ").slice(0, 60)}`, memory: true,
					parentSid: me.parentSid, parentSessionId: me.parentSessionId, depth: me.depth,
				});
			} catch (e: any) {
				if (e?.unreachable) return reply(e.message, { error: true });
				return reply(`claude_task failed: ${e?.message || e}`, { error: true });
			}
			// This chat's poller is held until the answer (or the cancel) is claimed and acked, so it never posts it too.
			const release = pausePoller(me.parentSessionId);
			let r: any;
			try {
				try {
					r = await waitAgents(client, {
						ids: [rec.id], timeoutMs: minutes * 60000, signal,
						onChunk: ({ elapsedMs }: any) => onUpdate?.(reply(`Claude Code is working (${fmtDuration(elapsedMs)}) — agent ${rec.id}`, { id: rec.id, running: true })),
					});
				} catch (e: any) {
					r = { lost: e?.message || String(e) };
				}
				if (r.aborted) {
					// The pi run was stopped: stop Claude too, and its "cancelled" report need not come back.
					let status = "cancelled";
					try { const c = await client.cancel(rec.id); status = c?.status || status; claim(c || rec); await client.delivered(rec.id); } catch { /* best effort */ }
					return reply(`claude_task stopped; Claude Code agent ${rec.id} was ${status}.`, { id: rec.id, sid: rec.sid, sessionId: rec.sessionId, cancelled: true });
				}
				const f = r.finished?.[0];
				if (f) {
					claim(f);
					try { await client.delivered(f.id); } catch { /* the poller acks it later */ }
					const text = clip(String(f.resultText || ""), MAX_RESULT);
					const footer = f.status === "done" || f.status === "error"
						? claudeFooter(f)
						: `[Claude Code agent ${f.id} ended: ${f.status}${f.error ? ` — ${f.error}` : ""} · session ${f.sessionId || "?"} — pass resume="${f.sessionId || ""}" to continue]`;
					return reply(`${text || "(no answer text)"}\n\n${footer}`, { id: f.id, sid: f.sid, sessionId: f.sessionId, cost: f.cost, turns: f.turns, isError: f.status !== "done", timedOut: false });
				}
			} finally { release(); }

			// Still running (or contact lost): report what there is, leave Claude running, deliver its answer later.
			let cur: any = rec;
			try { cur = (await client.get(rec.id)) || rec; } catch { /* keep what start returned */ }
			ensurePoller({ client, parentSessionId: me.parentSessionId, pi, isIdle: () => { try { return ctx?.isIdle?.() ?? false; } catch { return false; } } });
			const activity = cur.activity?.length ? `Recent activity:\n${cur.activity.map((l: string) => `- ${l}`).join("\n")}` : "(no output yet)";
			const sofar = cur.resultText ? `\n\nSo far:\n${clip(String(cur.resultText), MAX_RESULT)}` : "";
			const why = r.lost ? `claude_task lost contact with Omni Agent while waiting (${r.lost})` : `Claude Code did not finish within ${fmtDuration(minutes * 60000)}`;
			return reply(
				`${activity}${sofar}\n\n[${why}; it is still running in Omni as agent ${rec.id} (session ${cur.sessionId || "?"}). Its answer arrives as a message when it finishes — or agent_status / agent_wait ${rec.id}; agent_cancel ${rec.id} stops it.]`,
				{ id: rec.id, sid: cur.sid, sessionId: cur.sessionId, timedOut: true },
			);
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("claude_task ")) + theme.fg("muted", String(args.task ?? "").replace(/\s+/g, " ").slice(0, 100)), 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			const t = result.content[0];
			const text = t?.type === "text" ? t.text : "";
			const lines = text.split("\n");
			return new Text(theme.fg("toolOutput", expanded ? text : lines.slice(0, 8).join("\n") + (lines.length > 8 ? `\n... ${lines.length - 8} more lines` : "")), 0, 0);
		},
	});
}
