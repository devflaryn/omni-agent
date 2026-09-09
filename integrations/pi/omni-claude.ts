/**
 * Omni Agent → Claude Code delegation for pi.
 *
 * Gives the pi model (e.g. the local Qwen) one tool:
 *
 *   claude_task — hand a task to Claude Code and wait for its answer.
 *
 * The task runs through the Omni Agent server (`POST /api/claude/task`), so it shows
 * up live in Omni's sidebar as its own chat ("Task from pi: …") and its tokens are
 * accounted for. The tool returns Claude's final answer plus the session id; pass
 * that id back as `resume` to continue the same Claude conversation.
 *
 * Config: ~/.pi/agent/omni-agent.json  { "root": "<omni-agent folder>", "port": 4400 }
 * Installed by: node scripts/install.mjs   (in the omni-agent folder)
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface OmniConfig { root?: string; port?: number }

function loadConfig(): OmniConfig {
	const p = join(homedir(), ".pi", "agent", "omni-agent.json");
	if (!existsSync(p)) return {};
	try { return JSON.parse(readFileSync(p, "utf8")) as OmniConfig; } catch { return {}; }
}

const MAX_CHARS = 20000;

export default async function omniClaude(pi: ExtensionAPI) {
	const cfg = loadConfig();
	const port = Number(cfg.port) || 4400;
	const base = `http://127.0.0.1:${port}`;

	pi.registerTool({
		name: "claude_task",
		label: "Claude Code task",
		description: "Delegate a self-contained task to Claude Code (a strong agentic coding model with full access to the working directory) and wait for its answer. Use it for larger coding jobs, multi-file refactors, debugging, or anything you want a second, more capable agent to do end to end. Describe the task fully: goal, constraints, what to report back. Runs in the current working directory unless `cwd` is given. Returns Claude's final answer and a session id; pass that id as `resume` to continue the same Claude conversation with a follow-up.",
		promptSnippet: "Delegate a task to Claude Code and get its answer",
		parameters: Type.Object({
			task: Type.String({ description: "The complete task description for Claude Code" }),
			cwd: Type.Optional(Type.String({ description: "Working directory (default: the current one)" })),
			model: Type.Optional(Type.String({ description: "Claude model id, e.g. claude-opus-5, claude-sonnet-5 (default: Claude Code's default)" })),
			resume: Type.Optional(Type.String({ description: "A session id returned by a previous claude_task, to continue that conversation" })),
			timeoutMinutes: Type.Optional(Type.Number({ description: "Give up waiting after this many minutes (default 15)" })),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const cwd = params.cwd || ctx.cwd;
			const body = {
				prompt: params.task,
				cwd,
				model: params.model,
				resume: params.resume,
				timeoutSec: Math.max(1, Number(params.timeoutMinutes) || 15) * 60,
				title: `Task from pi: ${params.task.replace(/\s+/g, " ").slice(0, 60)}`,
				memory: true,
			};
			let r: Response;
			try {
				r = await fetch(`${base}/api/claude/task`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
			} catch (e: any) {
				return { content: [{ type: "text", text: `Omni Agent is not running on ${base} (${e?.message || e}). Start it, then retry.` }], details: { error: true } };
			}
			const j: any = await r.json().catch(() => ({}));
			if (!r.ok || j.error) return { content: [{ type: "text", text: `claude_task failed: ${j.error || r.status}` }], details: { error: true } };
			let text = String(j.text || "");
			if (text.length > MAX_CHARS) text = `${text.slice(0, MAX_CHARS)}\n… (${text.length - MAX_CHARS} more characters truncated)`;
			const footer = j.timedOut
				? `[Claude Code did not finish within the timeout; the run may still be going in Omni. session: ${j.sessionId}]`
				: `[claude session ${j.sessionId} · ${j.turns} turn${j.turns === 1 ? "" : "s"} · $${Number(j.cost || 0).toFixed(3)}${j.isError ? " · ended with an error" : ""} — pass resume="${j.sessionId}" to continue]`;
			return { content: [{ type: "text", text: `${text || "(no answer text)"}\n\n${footer}` }], details: { sid: j.sid, sessionId: j.sessionId, cost: j.cost, turns: j.turns, isError: j.isError, timedOut: j.timedOut } };
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
