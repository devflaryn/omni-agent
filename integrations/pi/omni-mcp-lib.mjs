/**
 * MCP client pieces shared by the pi extensions omni-mcp.ts (omnidroid's server) and
 * omni-mcp-servers.ts (any server the owner configures):
 *
 *   McpStdioClient   JSON-RPC 2.0 over a child's stdio, one message per line
 *   McpHttpClient    the Streamable HTTP transport (POST, answered as JSON or an SSE stream)
 *   normalizeSchema / coerceArgs   make an MCP inputSchema and a model's arguments agree with every provider
 *   parseToolResult  an MCP `tools/call` result as text + images
 *
 * Plain JS (no build step) so both .ts extensions and the tests import it as-is.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

export const STDIO_PROTOCOL_VERSION = "2024-11-05";
export const HTTP_PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "omni-agent", version: "0.1.0" };

/** A tool call that did not return within its timeout. A stdio server is NOT killed: the call stays
 *  pending (a late answer is delivered through `onLate`), so the lab and other progress survive. */
export class SlowCallError extends Error {
	constructor(method, elapsedMs) {
		super(`${method} did not return in ${Math.round(elapsedMs / 1000)} s`);
		this.name = "SlowCallError";
		this.method = method;
		this.elapsedMs = elapsedMs;
	}
}

/** `{ content: [...], isError }` → `{ text, images, isError }`. Embedded text resources count as text. */
export function parseToolResult(result) {
	const content = Array.isArray(result?.content) ? result.content : [];
	const texts = [];
	const images = [];
	for (const c of content) {
		if (c?.type === "text") texts.push(String(c.text));
		else if (c?.type === "image" && c.data) images.push({ data: String(c.data), mimeType: String(c.mimeType || "image/png") });
		else if (c?.type === "resource" && c.resource) texts.push(typeof c.resource.text === "string" ? c.resource.text : `[resource ${c.resource.uri ?? ""}${c.resource.mimeType ? ` ${c.resource.mimeType}` : ""}]`);
		else if (c?.type === "resource_link") texts.push(`[resource ${c.uri ?? ""}${c.name ? ` (${c.name})` : ""}]`);
		else if (c?.type === "audio") texts.push(`[audio ${c.mimeType ?? ""}]`);
	}
	if (!texts.length && result?.structuredContent !== undefined) texts.push(JSON.stringify(result.structuredContent));
	return { text: texts.join("\n"), images, isError: !!result?.isError };
}

/** What a client answers a request the *server* sends (ping is required; the rest are capabilities we do not offer). */
function answerServerRequest(msg) {
	if (msg.method === "ping") return { jsonrpc: "2.0", id: msg.id, result: {} };
	return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `omni-agent does not support ${msg.method}` } };
}

/**
 * A minimal MCP client over a child's stdio: requests matched to responses by id.
 * opts: { name, command, args, env, cwd, protocolVersion, notConfigured, notFound(command), onNotification(msg) }
 */
export class McpStdioClient {
	constructor(cfg = {}) {
		this.cfg = cfg;
		this.name = cfg.name || "MCP server";
		this.child = null;
		this.buf = "";
		this.nextId = 1;
		this.pending = new Map();
		this.stderrTail = "";
		this.starting = null;
		this.tools = [];
		this.serverInfo = null;
	}

	get alive() { return !!this.child && this.child.exitCode === null && !this.child.killed; }

	/** Start the server and run the MCP handshake (once; concurrent callers share it). */
	start() {
		if (this.alive && !this.starting) return Promise.resolve();
		if (!this.starting) this.starting = this.spawnAndInit().finally(() => { this.starting = null; });
		return this.starting;
	}

	async spawnAndInit() {
		const command = this.cfg.command;
		if (!command) throw new Error(this.cfg.notConfigured || `${this.name}: no command configured`);
		// A bare name ("npx", "uvx") is looked up on PATH by spawn; only a path is checked up front.
		if (/[\\/]/.test(command) && !existsSync(command)) throw new Error(this.cfg.notFound ? this.cfg.notFound(command) : `${this.name}: ${command} not found`);
		const child = spawn(command, this.cfg.args ?? [], {
			env: { ...process.env, ...(this.cfg.env ?? {}) },
			cwd: this.cfg.cwd || undefined,
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
			// npx/uvx are .cmd shims on Windows and need a shell to run.
			shell: process.platform === "win32" && !/[\\/]/.test(command) && !/\.exe$/i.test(command),
		});
		this.child = child;
		this.buf = "";
		this.stderrTail = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => this.onData(chunk));
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk) => { this.stderrTail = (this.stderrTail + chunk).slice(-4000); });
		child.stdin.on("error", () => { /* a dead server surfaces through "exit" */ });
		const failAll = (why) => {
			if (this.child === child) this.child = null;
			for (const [id, p] of this.pending) { if (p.child !== child) continue; if (p.timer) clearTimeout(p.timer); p.reject(new Error(why)); this.pending.delete(id); }
		};
		child.on("error", (e) => failAll(`${this.name} could not run (${command}): ${e.message}`));
		child.on("exit", (code, signal) => failAll(`${this.name} exited (${signal ?? `code ${code}`})${this.stderrTail ? `: ${this.stderrTail.trim()}` : ""}`));

		const init = await this.request("initialize", { protocolVersion: this.cfg.protocolVersion || STDIO_PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO }, 30_000);
		this.serverInfo = init?.serverInfo ?? null;
		this.notify("notifications/initialized", {});
		await this.listTools();
	}

	async listTools() {
		const tools = [];
		let cursor;
		do {
			const page = await this.request("tools/list", cursor ? { cursor } : {}, 30_000);
			if (Array.isArray(page?.tools)) tools.push(...page.tools);
			cursor = page?.nextCursor;
		} while (cursor);
		this.tools = tools;
		return tools;
	}

	onData(chunk) {
		this.buf += chunk;
		let nl;
		while ((nl = this.buf.indexOf("\n")) >= 0) {
			const line = this.buf.slice(0, nl).trim();
			this.buf = this.buf.slice(nl + 1);
			if (!line) continue;
			let msg;
			try { msg = JSON.parse(line); } catch { continue; }
			// A message with a method is the server talking to us (a request or a notification), never
			// a response, even when its id happens to match one of ours.
			if (typeof msg?.method === "string") {
				if (msg.id !== undefined && msg.id !== null) this.send(answerServerRequest(msg));
				else this.cfg.onNotification?.(msg);
				continue;
			}
			const p = typeof msg?.id === "number" ? this.pending.get(msg.id) : undefined;
			if (!p) continue;
			this.pending.delete(msg.id);
			if (p.timer) clearTimeout(p.timer);
			const error = msg.error ? new Error(String(msg.error.message ?? JSON.stringify(msg.error))) : null;
			if (p.timedOut) {
				// The awaiting promise already settled (SlowCallError); deliver the late answer out-of-band.
				p.onLate?.(error, msg.result);
				continue;
			}
			if (error) p.reject(error);
			else p.resolve(msg.result);
		}
	}

	send(obj) { this.child?.stdin?.write(`${JSON.stringify(obj)}\n`); }

	notify(method, params) { this.send({ jsonrpc: "2.0", method, params }); }

	/** One request. On timeout the server is **kept alive**: the promise rejects with a
	 *  {@link SlowCallError}, but the call stays pending and a late answer is delivered through `onLate`. */
	request(method, params, timeoutMs = 600_000, signal, onLate) {
		const child = this.child;
		if (!child) return Promise.reject(new Error(`${this.name} is not running`));
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = timeoutMs > 0 ? setTimeout(() => {
				const p = this.pending.get(id);
				if (!p) return;
				p.timedOut = true;
				p.timer = null;
				// Keep the entry (and the server) so a late answer still reaches `onLate`.
				reject(new SlowCallError(method, timeoutMs));
			}, timeoutMs) : null;
			this.pending.set(id, { resolve, reject, timer, child, onLate });
			signal?.addEventListener("abort", () => {
				if (!this.pending.delete(id)) return;
				if (timer) clearTimeout(timer);
				this.notify("notifications/cancelled", { requestId: id, reason: "aborted" });
				reject(new Error(`${method} cancelled (${this.name} may still finish it)`));
			}, { once: true });
			this.send({ jsonrpc: "2.0", id, method, params });
		});
	}

	/** Call a tool; returns its text and images, throws on an error result. */
	async callTool(name, args, timeoutMs, signal, onLate) {
		await this.start();
		const lateInner = onLate ? (err, result) => onLate(err, err ? undefined : parseToolResult(result)) : undefined;
		const result = await this.request("tools/call", { name, arguments: args }, timeoutMs, signal, lateInner);
		const { text, images, isError } = parseToolResult(result);
		if (isError) throw new Error(text || `${name} failed`);
		return { text, images };
	}

	/** End the server: close stdin (it exits at EOF), then kill it if it lingers. */
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

/** Every JSON-RPC message in an SSE body (`data:` lines, events split by a blank line). */
async function* sseMessages(body) {
	const decoder = new TextDecoder();
	let buf = "";
	let data = [];
	const flush = function* () {
		if (!data.length) return;
		const text = data.join("\n");
		data = [];
		try { yield JSON.parse(text); } catch { /* not JSON: skip */ }
	};
	for await (const chunk of body) {
		buf += decoder.decode(chunk, { stream: true });
		let nl;
		while ((nl = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, nl).replace(/\r$/, "");
			buf = buf.slice(nl + 1);
			if (line === "") yield* flush();
			else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
		}
	}
	if (buf.startsWith("data:")) data.push(buf.slice(5).replace(/^ /, ""));
	yield* flush();
}

/**
 * A minimal MCP client over the Streamable HTTP transport: each request is a POST whose answer is
 * either one JSON message or an SSE stream that carries it. The session id the server hands out at
 * initialize goes on every later request; a 404 on it means the session expired and is re-initialized
 * once. opts: { name, url, headers, onNotification(msg) }
 */
export class McpHttpClient {
	constructor(cfg = {}) {
		this.cfg = cfg;
		this.name = cfg.name || "MCP server";
		this.nextId = 1;
		this.sessionId = null;
		this.protocolVersion = null;
		this.ready = false;
		this.starting = null;
		this.tools = [];
		this.serverInfo = null;
	}

	get alive() { return this.ready; }

	start() {
		if (this.ready && !this.starting) return Promise.resolve();
		if (!this.starting) this.starting = this.init().finally(() => { this.starting = null; });
		return this.starting;
	}

	async init() {
		if (!this.cfg.url) throw new Error(`${this.name}: no url configured`);
		this.sessionId = null;
		this.protocolVersion = null;
		const init = await this.post({ jsonrpc: "2.0", id: this.nextId++, method: "initialize", params: { protocolVersion: HTTP_PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO } }, 30_000);
		this.protocolVersion = init?.protocolVersion || HTTP_PROTOCOL_VERSION;
		this.serverInfo = init?.serverInfo ?? null;
		await this.post({ jsonrpc: "2.0", method: "notifications/initialized" }, 30_000);
		this.ready = true;
		await this.listTools();
	}

	headers() {
		const h = { "content-type": "application/json", accept: "application/json, text/event-stream", ...(this.cfg.headers ?? {}) };
		if (this.sessionId) h["mcp-session-id"] = this.sessionId;
		if (this.protocolVersion) h["mcp-protocol-version"] = this.protocolVersion;
		return h;
	}

	/** POST one message; resolves with the matching response's result (or undefined for a notification). */
	async post(message, timeoutMs = 600_000, signal) {
		const ctl = new AbortController();
		let timedOut = false;
		const timer = timeoutMs > 0 ? setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs) : null;
		const onAbort = () => ctl.abort();
		signal?.addEventListener("abort", onAbort, { once: true });
		const what = message.method;
		try {
			let res;
			try {
				res = await fetch(this.cfg.url, { method: "POST", headers: this.headers(), body: JSON.stringify(message), signal: ctl.signal });
			} catch (e) {
				if (timedOut) throw new SlowCallError(what, timeoutMs);
				if (signal?.aborted) throw new Error(`${what} cancelled`);
				throw new Error(`${this.name} is not reachable at ${this.cfg.url}: ${e?.cause?.code || e?.cause?.message || e?.message || e}`);
			}
			const sid = res.headers.get("mcp-session-id");
			if (sid) this.sessionId = sid;
			if (res.status === 404 && this.sessionId && what !== "initialize") {
				const err = new Error(`${this.name}: session expired`);
				err.sessionExpired = true;
				throw err;
			}
			if (!res.ok) {
				const body = await res.text().catch(() => "");
				const auth = res.status === 401 || res.status === 403 ? " (set an Authorization header in the server's `headers`)" : "";
				throw new Error(`${this.name} answered HTTP ${res.status}${auth}${body ? `: ${body.slice(0, 500)}` : ""}`);
			}
			if (message.id === undefined) { await res.body?.cancel().catch(() => {}); return undefined; }
			const type = res.headers.get("content-type") || "";
			let reply;
			if (type.includes("text/event-stream")) {
				for await (const msg of sseMessages(res.body)) {
					if (typeof msg?.method === "string") {
						// A server request on the stream: answer it with its own POST (fire and forget).
						if (msg.id !== undefined && msg.id !== null) this.post(answerServerRequest(msg), 30_000).catch(() => {});
						else this.cfg.onNotification?.(msg);
						continue;
					}
					if (msg?.id === message.id) { reply = msg; break; }
				}
				ctl.abort(); // done with the stream
			} else {
				reply = await res.json();
				if (Array.isArray(reply)) reply = reply.find((m) => m?.id === message.id);
			}
			if (!reply) throw new Error(`${this.name} closed the response without answering ${what}`);
			if (reply.error) throw new Error(String(reply.error.message ?? JSON.stringify(reply.error)));
			return reply.result;
		} catch (e) {
			if (timedOut && !(e instanceof SlowCallError)) throw new SlowCallError(what, timeoutMs);
			if (signal?.aborted && !(e instanceof SlowCallError)) throw new Error(`${what} cancelled`);
			throw e;
		} finally {
			if (timer) clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		}
	}

	async request(method, params, timeoutMs, signal) {
		// Not `await this.start()` unconditionally: init() itself lists tools through here.
		if (!this.ready) await this.start();
		const send = () => this.post({ jsonrpc: "2.0", id: this.nextId++, method, params }, timeoutMs, signal);
		try { return await send(); } catch (e) {
			if (!e?.sessionExpired) throw e;
			this.ready = false;
			await this.start();
			return send();
		}
	}

	async listTools() {
		const tools = [];
		let cursor;
		do {
			const page = await this.request("tools/list", cursor ? { cursor } : {}, 30_000);
			if (Array.isArray(page?.tools)) tools.push(...page.tools);
			cursor = page?.nextCursor;
		} while (cursor);
		this.tools = tools;
		return tools;
	}

	async callTool(name, args, timeoutMs, signal) {
		const result = await this.request("tools/call", { name, arguments: args }, timeoutMs, signal);
		const { text, images, isError } = parseToolResult(result);
		if (isError) throw new Error(text || `${name} failed`);
		return { text, images };
	}

	/** End the session (best effort: a server may not support DELETE). */
	close() {
		const sid = this.sessionId;
		this.ready = false;
		this.sessionId = null;
		if (!sid || !this.cfg.url) return;
		fetch(this.cfg.url, { method: "DELETE", headers: { ...(this.cfg.headers ?? {}), "mcp-session-id": sid }, signal: AbortSignal.timeout(3000) }).catch(() => {});
	}
}

/**
 * An MCP inputSchema made acceptable to every provider pi talks to: an `array` with no `items` is
 * rejected by OpenAI and Google, so its items become strings (omni-mcp reads every integer as a
 * decimal or `0x…` string too; a 64-bit address does not fit a JSON number anyway).
 */
export function normalizeSchema(schema) {
	const s = schema && typeof schema === "object" ? structuredClone(schema) : {};
	if (s.type !== "object") s.type = "object";
	s.properties = s.properties && typeof s.properties === "object" ? s.properties : {};
	for (const p of Object.values(s.properties)) {
		if (p?.type === "array" && !p.items) p.items = { type: "string", description: "decimal or 0x-hex" };
	}
	if (!Array.isArray(s.required) || !s.required.length) delete s.required;
	return s;
}

/** Models send `"0x10"` for a number or `16` for a string; turn each into what the schema says. */
export function coerceArgs(schema, args) {
	if (!args || typeof args !== "object" || Array.isArray(args)) return args;
	const out = { ...args };
	const props = schema?.properties ?? {};
	const asNumber = (v) => {
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

/** `mcp__<server>__<tool>` (Claude Code's naming), cut to the 64 characters [A-Za-z0-9_-] every provider accepts. */
export function mcpToolName(server, tool) {
	const clean = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, "_");
	return `mcp__${clean(server)}__${clean(tool)}`.slice(0, 64);
}

/** `${VAR}` and `${VAR:-default}` in a config string, from `env` (Claude Code's .mcp.json syntax). */
export function expandEnv(value, env = process.env) {
	if (typeof value === "string") return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, name, dflt) => env[name] ?? dflt ?? "");
	if (Array.isArray(value)) return value.map((v) => expandEnv(v, env));
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expandEnv(v, env)]));
	return value;
}

/**
 * The owner's `mcpServers` map (Claude Code's shape) as a list of usable server configs:
 *   { "<name>": { "command": "npx", "args": [...], "env": {...}, "cwd": "..." } }            stdio
 *   { "<name>": { "type": "http", "url": "https://…/mcp", "headers": {...} } }              Streamable HTTP
 * plus omni's own `disabled: true` and `timeoutSec`. Entries that are neither are returned with `error`.
 */
export function serverConfigs(mcpServers, env = process.env) {
	const out = [];
	if (!mcpServers || typeof mcpServers !== "object") return out;
	for (const [name, raw] of Object.entries(mcpServers)) {
		if (!raw || typeof raw !== "object" || raw.disabled === true || raw.enabled === false) continue;
		const c = expandEnv(raw, env);
		const type = String(c.type || (c.url ? "http" : "stdio")).toLowerCase();
		const timeoutSec = Math.max(1, Number(c.timeoutSec) || 300);
		if (type === "stdio") {
			out.push(c.command ? { name, type, command: String(c.command), args: Array.isArray(c.args) ? c.args.map(String) : [], env: c.env ?? {}, cwd: c.cwd, timeoutSec }
				: { name, type, error: "a stdio server needs a `command`" });
		} else if (type === "http" || type === "streamable-http" || type === "streamablehttp") {
			out.push(c.url ? { name, type: "http", url: String(c.url), headers: c.headers ?? {}, timeoutSec }
				: { name, type: "http", error: "an http server needs a `url`" });
		} else {
			out.push({ name, type, error: `transport "${type}" is not supported (use stdio or http; the old SSE transport is not)` });
		}
	}
	return out;
}
