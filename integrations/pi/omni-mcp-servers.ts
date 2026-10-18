/**
 * Omni Agent → any MCP server, for pi.
 *
 * pi has no MCP client of its own. omni-mcp.ts is one for omnidroid; this one is for every other
 * server the owner configures, in Claude Code's `mcpServers` shape, so a block can be pasted from a
 * `.mcp.json` or a server's README as-is. Each server's tools are registered as pi tools named
 * `mcp__<server>__<tool>`, the same names Claude Code uses (the UI already shows them as tool calls).
 *
 * Transports: stdio (`command`) and Streamable HTTP (`"type": "http"`, `url`). `${VAR}` and
 * `${VAR:-default}` in any string are filled from the environment. OAuth is not done here: put a
 * token in `headers` (e.g. "Authorization": "Bearer ${GITHUB_TOKEN}").
 *
 * The servers start at session_start (in parallel; one that fails is reported and skipped) and are
 * kept across a session switch (new / resume / fork / reload); they are closed on quit. A stdio
 * server that dies is restarted on the next call.
 *
 * Config: ~/.pi/agent/omni-agent.json
 *   { "mcpServers": {
 *       "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/src"] },
 *       "github":     { "type": "http", "url": "https://api.githubcopilot.com/mcp/",
 *                       "headers": { "Authorization": "Bearer ${GITHUB_TOKEN}" } },
 *       "slow-one":   { "command": "…", "timeoutSec": 900 },
 *       "parked":     { "command": "…", "disabled": true } } }
 * Installed by: node scripts/install.mjs   (the config is never overwritten by it)
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { McpHttpClient, McpStdioClient, SlowCallError, coerceArgs, mcpToolName, normalizeSchema, serverConfigs } from "./omni-mcp-lib.mjs";

const MAX_CHARS = 12000;
const clip = (s: string) => (s.length > MAX_CHARS ? `${s.slice(0, MAX_CHARS)}\n… (${s.length - MAX_CHARS} more characters truncated)` : s);
const pretty = (text: string) => { try { return JSON.stringify(JSON.parse(text), null, 1); } catch { return text; } };

function loadServers(): any[] {
	const p = join(homedir(), ".pi", "agent", "omni-agent.json");
	if (!existsSync(p)) return [];
	try { return serverConfigs(JSON.parse(readFileSync(p, "utf8")).mcpServers); } catch { return []; }
}

type Client = McpStdioClient | McpHttpClient;
/** The clients outlive an extension reload (a session switch re-imports this module). Keyed by
 *  server name; a changed config for the same name replaces the old client. */
const G = globalThis as unknown as { __omniMcpServers?: Map<string, { key: string; client: Client }> };

export default function omniMcpServers(pi: ExtensionAPI) {
	const servers = loadServers();
	if (!servers.length) return;
	const registered = new Set<string>();
	const live = new Map<string, { tools: number; error?: string }>();
	const pool = (G.__omniMcpServers ??= new Map());

	function client(s: any): Client {
		const key = JSON.stringify(s);
		const have = pool.get(s.name);
		if (have && have.key === key) return have.client;
		have?.client.close();
		const onNotification = (msg: any) => {
			// A server whose tool list changed: pick up the new tools (removed ones fail on call).
			if (msg?.method === "notifications/tools/list_changed") c.listTools().then((tools: any[]) => registerAll(s, tools)).catch(() => {});
		};
		const c: Client = s.type === "http"
			? new McpHttpClient({ name: `MCP server "${s.name}"`, url: s.url, headers: s.headers, onNotification })
			: new McpStdioClient({ name: `MCP server "${s.name}"`, command: s.command, args: s.args, env: s.env, cwd: s.cwd, onNotification });
		pool.set(s.name, { key, client: c });
		return c;
	}

	function registerAll(s: any, tools: any[]) {
		for (const t of tools) {
			const name = mcpToolName(s.name, t.name);
			if (registered.has(name)) continue;
			registered.add(name);
			const parameters = normalizeSchema(t.inputSchema);
			pi.registerTool({
				name,
				label: `${s.name} ${t.title ?? t.annotations?.title ?? t.name}`,
				description: `${t.description ?? t.name} (MCP server "${s.name}", tool \`${t.name}\`)`,
				parameters,
				prepareArguments: (args: unknown) => coerceArgs(parameters, args),
				async execute(_id: string, params: any, signal: AbortSignal | undefined) {
					let text: string;
					let images: { data: string; mimeType: string }[];
					try {
						({ text, images } = await client(s).callTool(t.name, params ?? {}, s.timeoutSec * 1000, signal));
					} catch (e) {
						if (e instanceof SlowCallError) throw new Error(`${name} did not return in ${s.timeoutSec}s (raise "timeoutSec" for "${s.name}" in ~/.pi/agent/omni-agent.json if it needs longer)`);
						throw e;
					}
					let parsed: unknown;
					try { parsed = JSON.parse(text); } catch { parsed = undefined; }
					const content: any[] = [{ type: "text", text: clip(pretty(text)) || "(no output)" }, ...images.map((i) => ({ type: "image", ...i }))];
					return { content, details: { server: s.name, tool: t.name, result: parsed ?? text } };
				},
			} as any);
		}
		live.set(s.name, { tools: tools.length });
	}

	pi.on("session_start", async (_event, ctx) => {
		await Promise.all(servers.map(async (s) => {
			if (s.error) { live.set(s.name, { tools: 0, error: s.error }); ctx?.ui?.notify?.(`MCP server "${s.name}": ${s.error}`, "warning"); return; }
			try {
				const c = client(s);
				await c.start();
				registerAll(s, c.tools);
			} catch (e: any) {
				live.set(s.name, { tools: 0, error: String(e?.message || e) });
				ctx?.ui?.notify?.(`MCP server "${s.name}" unavailable: ${e?.message || e}`, "warning");
			}
		}));
	});

	pi.on("session_shutdown", async (event) => {
		if (event?.reason !== "quit") return;
		for (const { client: c } of pool.values()) c.close();
		pool.clear();
	});

	pi.on("before_agent_start", async (event) => {
		if (!live.size) return;
		const lines = [...live].map(([name, st]) => st.error ? `- ${name}: not available (${st.error.split("\n")[0].slice(0, 200)})` : `- ${name}: ${st.tools} tools, named ${mcpToolName(name, "")}*`);
		const note = `MCP servers configured in ~/.pi/agent/omni-agent.json (mcpServers):\n${lines.join("\n")}`;
		return { systemPrompt: `${event.systemPrompt}\n\n${note}` };
	});
}
