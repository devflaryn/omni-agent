/**
 * Omni Agent → omnidroid's MCP server (`omni-mcp`) for pi.
 *
 * pi has no MCP client of its own, so this extension is one: it starts omnidroid's `omni-mcp`
 * binary (JSON-RPC 2.0 over stdio, one message per line), asks it for its tools and registers each
 * one as a pi tool named `omnidroid_<tool>`:
 *
 *   devices, apps   omnidroid_start_instance {apk, count, options} (the app's pool of warm Androids) /
 *                   wait_instance / screenshot / input / shell / web_* / …
 *   lab debugger    omnidroid_lab_load, then call_function / intercept / read_mem / dump_module / …
 *                   (Frida-style, at the emulation layer; see the omnidroid-frida skill)
 *
 * One omni-mcp process per pi process. It is started at session_start and kept across a session
 * switch (new / resume / fork / reload), so a booted instance and a loaded lab survive a chat
 * change; it is closed on quit. omni-mcp stops every instance it booted when it exits. If it dies
 * or a call times out, the next call starts a fresh one (the lab has to be loaded again).
 *
 * Config: ~/.pi/agent/omni-agent.json
 *   { "omniMcp": { "command": "<omnidroid>/target/release/omni-mcp[.exe]", "args": [],
 *                  "env": { "OMNI_MCP_APK": "…", "OMNI_MCP_REPO": "…" },
 *                  "timeoutSec": 600, "prefix": "omnidroid_", "enabled": true } }
 * Installed by: node scripts/install.mjs   (in the omni-agent folder; it fills `command` in)
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { McpStdioClient, SlowCallError, coerceArgs, idempotentStopNote, normalizeSchema, repeatNudge, trimInstanceList, waitDeviceVerdict } from "./omni-mcp-lib.mjs";

export { McpStdioClient, SlowCallError, coerceArgs, idempotentStopNote, normalizeSchema, repeatNudge, trimInstanceList, waitDeviceVerdict };

export interface OmniMcpConfig {
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	timeoutSec?: number;
	prefix?: string;
	enabled?: boolean;
	waitPollMs?: number;
}

export interface McpTool { name: string; description?: string; inputSchema?: any }

function loadConfig(): OmniMcpConfig {
	const p = join(homedir(), ".pi", "agent", "omni-agent.json");
	if (!existsSync(p)) return {};
	try { return (JSON.parse(readFileSync(p, "utf8")).omniMcp ?? {}) as OmniMcpConfig; } catch { return {}; }
}

const MAX_CHARS = 12000;

/** What a late (post-timeout) answer carries back to the caller. */
export type LatePayload = { text: string; images: { data: string; mimeType: string }[]; isError: boolean };
const clip = (s: string) => (s.length > MAX_CHARS ? `${s.slice(0, MAX_CHARS)}\n… (${s.length - MAX_CHARS} more characters truncated)` : s);

/** omnidroid's omni-mcp, with its own setup hints. */
const omniClient = (cfg: OmniMcpConfig) => new McpStdioClient({
	...cfg,
	name: "omni-mcp",
	notConfigured: "omni-mcp is not configured: set omniMcp.command in ~/.pi/agent/omni-agent.json (node scripts/install.mjs fills it in)",
	notFound: (command: string) => `omni-mcp not found at ${command}: build it in the omnidroid repo with \`cargo build --release -p omni-mcp\``,
});

const pretty = (text: string) => { try { return JSON.stringify(JSON.parse(text), null, 1); } catch { return text; } };

/** The client outlives an extension reload (a session switch re-imports this module). */
const G = globalThis as unknown as { __omniMcp?: McpStdioClient; __omniLastCall?: { name: string; args: string; result: string } };

export default function omniMcp(pi: ExtensionAPI) {
	const cfg = loadConfig();
	if (cfg.enabled === false) return;
	const prefix = cfg.prefix ?? "omnidroid_";
	const timeoutMs = Math.max(1, Number(cfg.timeoutSec) || 600) * 1000;
	const registered = new Set<string>();

	function client(): McpStdioClient {
		if (!G.__omniMcp) G.__omniMcp = omniClient(cfg);
		return G.__omniMcp;
	}

	function registerAll(tools: McpTool[]) {
		for (const t of tools) {
			const name = `${prefix}${t.name}`;
			if (registered.has(name)) continue;
			registered.add(name);
			const parameters = normalizeSchema(t.inputSchema);
			pi.registerTool({
				name,
				label: `omnidroid ${t.name}`,
				description: `${t.description ?? t.name} (omnidroid MCP server, tool \`${t.name}\`)`,
				parameters,
				prepareArguments: (args: unknown) => coerceArgs(parameters, args),
				async execute(_id: string, params: any, signal: AbortSignal | undefined, _update: unknown, ctx: any) {
					// If this call times out but the server later finishes it, post the result as a
					// follow-up so nothing is lost (the server and lab stayed alive meanwhile).
					const onLate = (err: Error | null, payload?: LatePayload) => {
						if (err || !payload) return;
						try {
							// omni-agents' turn tracker: no wake-up while a prompt is starting or after Stop (pi's run-flag race).
							const wake = (globalThis as any).__omniTurn?.wakeOptions?.() ?? { deliverAs: "followUp", triggerTurn: true };
							pi.sendMessage?.(
								{ customType: "omnidroid-late", content: `✓ ${name} finished after running long${payload.isError ? " (with an error)" : ""}:\n${clip(pretty(payload.text))}`, display: true },
								wake,
							);
						} catch { /* best effort */ }
					};
					let text: string;
					let images: { data: string; mimeType: string }[];
					try {
						({ text, images } = await client().callTool(t.name, params ?? {}, timeoutMs, signal, onLate));
					} catch (e) {
						// A stop whose target had already ended is a no-op success, not a failure the model must react to.
						const note = idempotentStopNote(t.name, (e as Error)?.message);
						if (note) return { content: [{ type: "text", text: note }], details: { tool: t.name, idempotent: true } };
						if (e instanceof SlowCallError) {
							// Keep-alive: tell the agent and let it decide, rather than failing the whole run.
							const secs = Math.round(e.elapsedMs / 1000);
							return {
								content: [{ type: "text", text:
									`⏱ ${name} has run ${secs}s without returning. The omni-mcp server and your loaded lab are still alive — nothing was lost. The call may be slow or stuck. Decide: wait and call ${name} again to keep going, or move on to something else. If it finishes on its own I'll post the result.` }],
								details: { tool: t.name, slow: true, elapsedMs: e.elapsedMs },
							};
						}
						throw e;
					}
					let parsed: unknown;
					try { parsed = JSON.parse(text); } catch { parsed = undefined; }
					// list_instances is mostly ended instances the model does not need in full; trim the shown text
					// (details.result keeps the complete parsed object) so it stops overflowing the clip below.
					let shown = (t.name === "list_instances" && trimInstanceList(text)) || pretty(text);
					// A watched read that returns byte-identical to the last one: nudge the model off a no-progress poll.
					const argsJson = JSON.stringify(params ?? {});
					const nudge = repeatNudge(G.__omniLastCall, t.name, argsJson, text);
					if (nudge) shown = `${nudge}\n${shown}`;
					G.__omniLastCall = { name: t.name, args: argsJson, result: text };
					const content: any[] = [{ type: "text", text: clip(shown) }, ...images.map((i) => ({ type: "image", ...i }))];
					// A screenshot is only a path to a text-only model; a model that reads images gets the frame.
					const png = t.name === "screenshot" ? (parsed as any)?.path : undefined;
					if (png && !images.length && ctx?.model?.input?.includes?.("image")) {
						try { content.push({ type: "image", data: readFileSync(png).toString("base64"), mimeType: "image/png" }); } catch { /* the path is in the text */ }
					}
					return { content, details: { tool: t.name, result: parsed ?? text } };
				},
			} as any);
		}
	}

	const pollMs = Math.max(50, Number(cfg.waitPollMs) || 3000);
	const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
		const t = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
	});

	/**
	 * A blocking device wait the server lacks: poll list_devices server-side until a device is ready (or all
	 * have finished coming up), so the model makes one call instead of polling by hand. Synthesized here — it
	 * drives the server's own list_devices — so it needs that tool present.
	 */
	function registerWaitDevice() {
		const name = `${prefix}wait_device`;
		if (registered.has(name) || !client().tools.some((t) => t.name === "list_devices")) return;
		registered.add(name);
		pi.registerTool({
			name,
			label: "omnidroid wait_device",
			description: `Wait until a warm Android is ready (booted), at most \`timeout\` seconds (default 300). Blocks server-side by polling list_devices for you — use it after warm_device, or whenever a device is still "booting", instead of calling ${prefix}list_devices in a loop. Answers the final devices snapshot. (omnidroid MCP helper, synthesized by omni-agent.)`,
			parameters: { type: "object", properties: {
				device: { type: "number", description: "the device id to wait for (omit: wait until none is still booting)" },
				timeout: { type: "number", description: "seconds to wait (default 300)" },
			} } as any,
			async execute(_id: string, params: any, signal: AbortSignal | undefined) {
				const target = params?.device != null ? Number(params.device) : null;
				const deadline = Date.now() + Math.max(1, Number(params?.timeout) || 300) * 1000;
				let waited = 0;
				let text = "";
				for (;;) {
					if (signal?.aborted) return { content: [{ type: "text", text: `wait_device aborted after ${waited}s` }], details: { tool: "wait_device", ready: false, aborted: true } };
					({ text } = await client().callTool("list_devices", {}, timeoutMs, signal));
					const v = waitDeviceVerdict(text, target);
					if (v.done) return { content: [{ type: "text", text: `ready after ${waited}s:\n${pretty(text)}` }], details: { tool: "wait_device", ready: true, waitedMs: waited * 1000, result: JSON.parse(text) } };
					if (Date.now() >= deadline) return { content: [{ type: "text", text: `still not ready after ${waited}s (booting: ${v.booting.join(", ") || "none"}):\n${pretty(text)}` }], details: { tool: "wait_device", ready: false, waitedMs: waited * 1000, result: JSON.parse(text) } };
					await sleep(pollMs, signal);
					waited += Math.round(pollMs / 1000) || 1;
				}
			},
		} as any);
	}

	pi.on("session_start", async (_event, ctx) => {
		try {
			await client().start();
			registerAll(client().tools);
			registerWaitDevice();
		} catch (e: any) {
			ctx?.ui?.notify?.(`omnidroid MCP tools unavailable: ${e?.message || e}`, "warning");
		}
	});

	pi.on("session_shutdown", async (event) => {
		if (event?.reason === "quit") { G.__omniMcp?.close(); G.__omniMcp = undefined; }
	});

	pi.on("before_agent_start", async (event) => {
		if (!registered.size) return;
		const note = `omnidroid tools (${prefix}*) drive omnidroid -- real Android 15 running on its own Linux layer, arm64 translated, no VM -- through its MCP server. The tools are the omnidroid app's (it must be open, with \`mcp on\` set in it, or \`omnidroid serve\` running; an "is not reachable" error means it is not). Every omnidroid window on the computer shares that one pool: what the person launches you see too. Any APK: ${prefix}start_instance {apk, count} launches it as count instances and answers their ids at once -- each runs in a window of its own on one of the app's warm Androids, as an Android user of its own (the same APK file again shares an Android, another package goes in beside it, another build of a running package gets an Android of its own); \`options\` passes an installed plugin's options as on the command line (e.g. "--cookie <file or saved name> --place <id>": each instance signed in as that account, then the link opened; follow it in ${prefix}pool_log); ${prefix}wait_instance {instance_id} waits until it runs; ${prefix}screenshot {instance_id} and ${prefix}input {instance_id, action: tap|swipe|text|key} see and drive it; ${prefix}list_instances / ${prefix}list_devices show the state (a device is still "booting"? call ${prefix}wait_device to block until it is ready instead of polling ${prefix}list_devices in a loop); ${prefix}shell runs a command on an Android (root with uid 0); ${prefix}stop_instance closes one; ${prefix}web_pages / web_dom / web_click / web_type / web_eval / web_screenshot drive an instance's WebViews (sign-in pages, captchas). Native code: ${prefix}lab_load + ${prefix}call_function / ${prefix}intercept / ${prefix}read_mem / ${prefix}dump_module are a Frida-style debugger for one arm64 .so at the emulation layer (not attached to a live app; there is no frida-server here). RE workbench (reverse-engineer a .so and prove a rebuilt one matches): ${prefix}lab_load_apk (load a target + its siblings, report unresolved imports), ${prefix}lab_trace (call via an arg_spec of scalars/buffers), ${prefix}lab_corpus (a reproducible input corpus), ${prefix}lab_diff (differential-test original vs candidate over the corpus), ${prefix}lab_build (compile candidate C to an arm64 .so; needs an arm64 clang/NDK on the host). Read the omnidroid skill (devices, apps) or the omnidroid-frida skill (the lab + the workbench) before using them. Addresses are strings ("0x…"). The omni_* tools, if present, are the retired QEMU manager: only when asked for it by name.`;
		return { systemPrompt: `${event.systemPrompt}\n\n${note}` };
	});
}
