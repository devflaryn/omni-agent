/**
 * Omni Agent → repo knowledge graph tools for pi.
 *
 * Lets the pi model decide, mid-turn, to BUILD or READ a repository knowledge
 * graph instead of grinding through the files:
 *
 *   graph_build   — build/refresh the graph for a working directory (graphify
 *                   AST + clustering, no LLM, a few seconds). Do this once for
 *                   a repo before querying it.
 *   graph_query   — ask the graph a question and get a token-budgeted answer
 *                   (the "read it" path). Cheaper than reading the codebase.
 *   graph_explain — what one node (a file or symbol) imports, calls, and is
 *                   called by.
 *
 * All three run through the Omni Agent server (`/api/graph/*`), which shells out
 * to the local `graphify` — so they work with NO model endpoint up. The graph is
 * also written into the Obsidian vault under `vault/Graphs/<repo>/`.
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

const MAX_CHARS = 12000;
const clip = (s: string) => (s.length > MAX_CHARS ? `${s.slice(0, MAX_CHARS)}\n… (${s.length - MAX_CHARS} more characters truncated)` : s);

export default async function omniGraph(pi: ExtensionAPI) {
	const cfg = loadConfig();
	const port = Number(cfg.port) || 4400;
	const base = `http://127.0.0.1:${port}`;

	// Tell the model, every turn, that the graph tools exist and whether this repo already has a graph,
	// so it reaches for graph_query on structural questions instead of grinding through files.
	pi.on("before_agent_start", async (event, ctx) => {
		const dir = ctx.cwd;
		const built = existsSync(join(dir, "graphify-out", "graph.json"));
		const note = built
			? `A knowledge graph of ${dir} already exists. For questions about the structure of this repository (what talks to what, where something is used, what a module depends on), call graph_query first and graph_explain for one file or symbol; only read the source when you need the exact code. Call graph_build to refresh the graph after large changes.`
			: `No knowledge graph exists for ${dir} yet. When you need to understand how this repository fits together before making changes (more than one or two files involved), call graph_build once (seconds, no model call), then graph_query for structural questions and graph_explain for one file or symbol.`;
		return { systemPrompt: `${event.systemPrompt}\n\nRepo graph tools (graph_build / graph_query / graph_explain): ${note}` };
	});

	async function call(path: string, body: Record<string, unknown>): Promise<any> {
		let r: Response;
		try {
			r = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
		} catch (e: any) {
			return { __error: `Omni Agent is not running on ${base} (${e?.message || e}). Start it, then retry.` };
		}
		const j: any = await r.json().catch(() => ({}));
		if (!r.ok || j.error) return { __error: `${j.error || r.status}` };
		return j;
	}
	const err = (text: string) => ({ content: [{ type: "text" as const, text }], details: { error: true } });
	const ok = (text: string, details: Record<string, unknown> = {}) => ({ content: [{ type: "text" as const, text: clip(text) }], details });

	pi.registerTool({
		name: "graph_build",
		label: "Build repo graph",
		description: "Build (or refresh) a knowledge graph of a code repository: every source file becomes a node linked to the files it imports or calls, clustered into communities. Runs the local `graphify` (AST extraction, no model call, a few seconds) and writes the result into the Omni vault. Do this once for a repo before graph_query / graph_explain. Returns node/edge/community counts.",
		promptSnippet: "Build a knowledge graph of a repository",
		parameters: Type.Object({
			dir: Type.Optional(Type.String({ description: "Repository directory to graph (default: the current working directory)" })),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const dir = params.dir || ctx.cwd;
			const j = await call("/api/graph/build", { dir });
			if (j.__error) return err(`graph_build failed: ${j.__error}`);
			return ok(`Built graph for ${j.dir}: ${j.nodes} nodes, ${j.links} links → vault/${j.vault} (${j.notes} notes). Query it with graph_query.`, { nodes: j.nodes, links: j.links, dir: j.dir });
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("graph_build ")) + theme.fg("muted", String(args.dir ?? "cwd")), 0, 0);
		},
	});

	pi.registerTool({
		name: "graph_query",
		label: "Ask the repo graph",
		description: "Ask a question of a repository's knowledge graph and get a token-budgeted answer assembled from the most relevant nodes and their links — a cheap way to understand structure (\"what talks to the auth module?\", \"where is X used?\") without reading the whole codebase. The graph must have been built first with graph_build (same dir). Set dfs for a depth-first traversal instead of the default best-connected slice.",
		promptSnippet: "Ask a repository knowledge graph a question",
		parameters: Type.Object({
			question: Type.String({ description: "The question to ask about the repository's structure" }),
			dir: Type.Optional(Type.String({ description: "Repository directory whose graph to query (default: the current working directory)" })),
			budget: Type.Optional(Type.Number({ description: "Approximate token budget for the answer (default 900)" })),
			dfs: Type.Optional(Type.Boolean({ description: "Depth-first traversal from the best match instead of the best-connected slice" })),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const dir = params.dir || ctx.cwd;
			const j = await call("/api/graph/query", { dir, question: params.question, budget: params.budget, dfs: !!params.dfs });
			if (j.__error) {
				const hint = /no graph/i.test(j.__error) ? " Run graph_build on this directory first." : "";
				return err(`graph_query failed: ${j.__error}.${hint}`);
			}
			return ok(String(j.answer || "(the graph returned no answer)"), { dir });
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("graph_query ")) + theme.fg("muted", String(args.question ?? "").replace(/\s+/g, " ").slice(0, 100)), 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			const t = result.content[0];
			const text = t?.type === "text" ? t.text : "";
			const lines = text.split("\n");
			return new Text(theme.fg("toolOutput", expanded ? text : lines.slice(0, 8).join("\n") + (lines.length > 8 ? `\n... ${lines.length - 8} more lines` : "")), 0, 0);
		},
	});

	pi.registerTool({
		name: "graph_explain",
		label: "Explain a graph node",
		description: "Explain one node of a repository's knowledge graph: what a given file (or symbol) imports, what it calls, and what calls it. The graph must have been built first with graph_build (same dir).",
		promptSnippet: "Explain one node of a repository knowledge graph",
		parameters: Type.Object({
			node: Type.String({ description: "The node to explain — a file path or symbol name as it appears in the graph" }),
			dir: Type.Optional(Type.String({ description: "Repository directory whose graph to use (default: the current working directory)" })),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const dir = params.dir || ctx.cwd;
			const j = await call("/api/graph/explain", { dir, node: params.node });
			if (j.__error) {
				const hint = /no graph/i.test(j.__error) ? " Run graph_build on this directory first." : "";
				return err(`graph_explain failed: ${j.__error}.${hint}`);
			}
			return ok(String(j.answer || `(nothing recorded for ${params.node})`), { dir, node: params.node });
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("graph_explain ")) + theme.fg("muted", String(args.node ?? "")), 0, 0);
		},
	});
}
