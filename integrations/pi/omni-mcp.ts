/**
 * Omni Agent → omnidroid's MCP server (`omni-mcp`) for pi.
 *
 * pi has no MCP client of its own, so this extension is one: it starts omnidroid's `omni-mcp`
 * binary (JSON-RPC 2.0 over stdio, one message per line), asks it for its tools and registers each
 * one as a pi tool named `omnidroid_<tool>`:
 *
 *   devices, apps   omnidroid_start_instance {apk} (the warm device) / shell / screenshot / stop_app / …
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
 *                  "env": { "OMNI_MCP_APK": "…", "OMNI_MCP_COOKIE": "…", "OMNI_MCP_REPO": "…" },
 *                  "timeoutSec": 600, "prefix": "omnidroid_", "enabled": true } }
 * Installed by: node scripts/install.mjs   (in the omni-agent folder; it fills `command` in)
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface OmniMcpConfig {
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	timeoutSec?: number;
	prefix?: string;
	enabled?: boolean;
}

export interface McpTool { name: string; description?: string; inputSchema?: any }

function loadConfig(): OmniMcpConfig {
	const p = join(homedir(), ".pi", "agent", "omni-agent.json");
	if (!existsSync(p)) return {};
	try { return (JSON.parse(readFileSync(p, "utf8")).omniMcp ?? {}) as OmniMcpConfig; } catch { return {}; }
}

const PROTOCOL_VERSION = "2024-11-05";
const MAX_CHARS = 12000;
const clip = (s: string) => (s.length > MAX_CHARS ? `${s.slice(0, MAX_CHARS)}\n… (${s.length - MAX_CHARS} more characters truncated)` : s);

/** A minimal MCP client over a child's stdio: requests matched to responses by id. */
export class McpStdioClient {
	private child: ChildProcess | null = null;
	private buf = "";
	private nextId = 1;
	private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout | null; child: ChildProcess }>();
	private stderrTail = "";
	private starting: Promise<void> | null = null;
	private cfg: OmniMcpConfig;
	tools: McpTool[] = [];

	constructor(cfg: OmniMcpConfig) { this.cfg = cfg; }

	get alive(): boolean { return !!this.child && this.child.exitCode === null && !this.child.killed; }

	/** Start the server and run the MCP handshake (once; concurrent callers share it). */
	start(): Promise<void> {
		if (this.alive && !this.starting) return Promise.resolve();
		if (!this.starting) this.starting = this.spawnAndInit().finally(() => { this.starting = null; });
		return this.starting;
	}

	private async spawnAndInit(): Promise<void> {
		const command = this.cfg.command;
		if (!command) throw new Error("omni-mcp is not configured: set omniMcp.command in ~/.pi/agent/omni-agent.json (node scripts/install.mjs fills it in)");
		if (!existsSync(command)) throw new Error(`omni-mcp not found at ${command}: build it in the omnidroid repo with \`cargo build --release -p omni-mcp\``);
		const child = spawn(command, this.cfg.args ?? [], {
			env: { ...process.env, ...(this.cfg.env ?? {}) },
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		this.child = child;
		this.buf = "";
		this.stderrTail = "";
		child.stdout!.setEncoding("utf8");
		child.stdout!.on("data", (chunk: string) => this.onData(chunk));
		child.stderr!.setEncoding("utf8");
		child.stderr!.on("data", (chunk: string) => { this.stderrTail = (this.stderrTail + chunk).slice(-4000); });
		child.stdin!.on("error", () => { /* a dead server surfaces through "exit" */ });
		const failAll = (why: string) => {
			if (this.child === child) this.child = null;
			for (const [id, p] of this.pending) { if (p.child !== child) continue; if (p.timer) clearTimeout(p.timer); p.reject(new Error(why)); this.pending.delete(id); }
		};
		child.on("error", (e) => failAll(`omni-mcp could not run (${command}): ${e.message}`));
		child.on("exit", (code, signal) => failAll(`omni-mcp exited (${signal ?? `code ${code}`})${this.stderrTail ? `: ${this.stderrTail.trim()}` : ""}`));

		await this.request("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "omni-agent", version: "0.1.0" } }, 30_000);
		this.notify("notifications/initialized", {});
		const listed = await this.request("tools/list", {}, 30_000);
		this.tools = Array.isArray(listed?.tools) ? listed.tools : [];
	}

	private onData(chunk: string) {
		this.buf += chunk;
		let nl: number;
		while ((nl = this.buf.indexOf("\n")) >= 0) {
			const line = this.buf.slice(0, nl).trim();
			this.buf = this.buf.slice(nl + 1);
			if (!line) continue;
			let msg: any;
			try { msg = JSON.parse(line); } catch { continue; }
			const p = typeof msg?.id === "number" ? this.pending.get(msg.id) : undefined;
			if (!p) continue;
			this.pending.delete(msg.id);
			if (p.timer) clearTimeout(p.timer);
			if (msg.error) p.reject(new Error(String(msg.error.message ?? JSON.stringify(msg.error))));
			else p.resolve(msg.result);
		}
	}

	private send(obj: unknown) { this.child?.stdin?.write(`${JSON.stringify(obj)}\n`); }

	notify(method: string, params: unknown) { this.send({ jsonrpc: "2.0", method, params }); }

	/** One request. A timeout kills the server (it is single-threaded: a stuck call blocks all others). */
	request(method: string, params: unknown, timeoutMs = 600_000, signal?: AbortSignal): Promise<any> {
		const child = this.child;
		if (!child) return Promise.reject(new Error("omni-mcp is not running"));
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = timeoutMs > 0 ? setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`omni-mcp did not answer ${method} in ${Math.round(timeoutMs / 1000)} s; it was restarted (a loaded lab is gone: lab_load again)`));
				this.close(0);
			}, timeoutMs) : null;
			this.pending.set(id, { resolve, reject, timer, child });
			signal?.addEventListener("abort", () => {
				if (!this.pending.delete(id)) return;
				if (timer) clearTimeout(timer);
				reject(new Error(`${method} cancelled (omni-mcp may still finish it)`));
			}, { once: true });
			this.send({ jsonrpc: "2.0", id, method, params });
		});
	}

	/** Call a tool; returns the text the server answered with (omni-mcp answers one JSON text item). */
	async callTool(name: string, args: Record<string, unknown>, timeoutMs?: number, signal?: AbortSignal): Promise<{ text: string; images: { data: string; mimeType: string }[] }> {
		await this.start();
		const result = await this.request("tools/call", { name, arguments: args }, timeoutMs, signal);
		const content: any[] = Array.isArray(result?.content) ? result.content : [];
		const text = content.filter((c) => c?.type === "text").map((c) => String(c.text)).join("\n");
		const images = content.filter((c) => c?.type === "image" && c.data).map((c) => ({ data: String(c.data), mimeType: String(c.mimeType || "image/png") }));
		if (result?.isError) throw new Error(text || `${name} failed`);
		return { text, images };
	}

	/** End the server: close stdin (it exits at EOF and stops its instances), then kill it if it lingers. */
	close(graceMs = 3000) {
		const child = this.child;
		this.child = null;
		if (!child) return;
		try { child.stdin?.end(); } catch { /* already closed */ }
		if (graceMs <= 0) { child.kill(); return; }
		const t = setTimeout(() => { if (child.exitCode === null) child.kill(); }, graceMs);
		t.unref?.();
	}
}

/**
 * An MCP inputSchema made acceptable to every provider pi talks to: an `array` with no `items` is
 * rejected by OpenAI and Google, so its items become strings (omni-mcp reads every integer as a
 * decimal or `0x…` string too; a 64-bit address does not fit a JSON number anyway).
 */
export function normalizeSchema(schema: any): any {
	const s = schema && typeof schema === "object" ? structuredClone(schema) : {};
	if (s.type !== "object") s.type = "object";
	s.properties = s.properties && typeof s.properties === "object" ? s.properties : {};
	for (const p of Object.values<any>(s.properties)) {
		if (p?.type === "array" && !p.items) p.items = { type: "string", description: "decimal or 0x-hex" };
	}
	if (!Array.isArray(s.required) || !s.required.length) delete s.required;
	return s;
}

/** Models send `"0x10"` for a number or `16` for a string; turn each into what the schema says. */
export function coerceArgs(schema: any, args: unknown): unknown {
	if (!args || typeof args !== "object" || Array.isArray(args)) return args;
	const out: Record<string, unknown> = { ...(args as Record<string, unknown>) };
	const props = schema?.properties ?? {};
	const asNumber = (v: unknown) => {
		if (typeof v !== "string") return v;
		const t = v.trim();
		const n = /^0x[0-9a-f]+$/i.test(t) ? Number.parseInt(t, 16) : /^\d+(\.\d+)?$/.test(t) ? Number(t) : Number.NaN;
		return Number.isFinite(n) ? n : v;
	};
	for (const [k, v] of Object.entries(out)) {
		const p = props[k];
		if (!p || v === null || v === undefined) continue;
		if (p.type === "string" && (typeof v === "number" || typeof v === "boolean")) out[k] = String(v);
		else if ((p.type === "number" || p.type === "integer") && typeof v === "string") out[k] = asNumber(v);
		else if (p.type === "boolean" && typeof v === "string") out[k] = v === "true" ? true : v === "false" ? false : v;
		else if (p.type === "array" && Array.isArray(v) && p.items?.type === "string") out[k] = v.map((x) => (typeof x === "number" ? String(x) : x));
		else if (p.type === "array" && typeof v === "string" && v.trim().startsWith("[")) {
			try { out[k] = coerceArgs({ properties: { x: p } }, { x: JSON.parse(v) }).x; } catch { /* leave it for validation to report */ }
		}
	}
	return out;
}

const pretty = (text: string) => { try { return JSON.stringify(JSON.parse(text), null, 1); } catch { return text; } };

/** The client outlives an extension reload (a session switch re-imports this module). */
const G = globalThis as unknown as { __omniMcp?: McpStdioClient };

export default function omniMcp(pi: ExtensionAPI) {
	const cfg = loadConfig();
	if (cfg.enabled === false) return;
	const prefix = cfg.prefix ?? "omnidroid_";
	const timeoutMs = Math.max(1, Number(cfg.timeoutSec) || 600) * 1000;
	const registered = new Set<string>();

	function client(): McpStdioClient {
		if (!G.__omniMcp) G.__omniMcp = new McpStdioClient(cfg);
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
					const { text, images } = await client().callTool(t.name, params ?? {}, timeoutMs, signal);
					let parsed: unknown;
					try { parsed = JSON.parse(text); } catch { parsed = undefined; }
					const content: any[] = [{ type: "text", text: clip(pretty(text)) }, ...images.map((i) => ({ type: "image", ...i }))];
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

	pi.on("session_start", async (_event, ctx) => {
		try {
			await client().start();
			registerAll(client().tools);
		} catch (e: any) {
			ctx?.ui?.notify?.(`omnidroid MCP tools unavailable: ${e?.message || e}`, "warning");
		}
	});

	pi.on("session_shutdown", async (event) => {
		if (event?.reason === "quit") { G.__omniMcp?.close(); G.__omniMcp = undefined; }
	});

	pi.on("before_agent_start", async (event) => {
		if (!registered.size) return;
		const note = `omnidroid tools (${prefix}*) drive omnidroid -- real Android 15 running on its own Linux layer, arm64 translated, no VM -- through its MCP server. Any APK: ${prefix}start_instance {apk} installs it on the host's one warm Android device (by content: the same bytes are reused) and answers once its first screen is up (seconds when the device is warm; a first call boots the device, ~1-4 min); ${prefix}shell runs a command on that device (root with uid 0), ${prefix}screenshot shows it, ${prefix}stop_instance / ${prefix}stop_app stop the app and keep the device warm. Native code: ${prefix}lab_load + ${prefix}call_function / ${prefix}intercept / ${prefix}read_mem / ${prefix}dump_module are a Frida-style debugger for one arm64 .so at the emulation layer (not attached to a live app; there is no frida-server here). Read the omnidroid skill (devices, apps) or the omnidroid-frida skill (the lab) before using them. Addresses are strings ("0x…"). The omni_* tools, if present, are the retired QEMU manager: only when asked for it by name.`;
		return { systemPrompt: `${event.systemPrompt}\n\n${note}` };
	});
}
