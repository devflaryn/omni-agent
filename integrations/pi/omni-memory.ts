/**
 * Omni Agent memory for pi.
 *
 * Gives the pi model three tools over the Omni Obsidian vault and, optionally,
 * auto-attaches a small relevant memory pack to each prompt so the model gets
 * durable facts without dragging whole files into context.
 *
 *   memory_search  — rank vault notes for a query (compact hits)
 *   memory_recall  — return a token-budgeted pack of the most relevant notes
 *   memory_save    — write one durable fact as a note (Memory/<slug>.md)
 *
 * Config: ~/.pi/agent/omni-agent.json  { "root": "<omni-agent folder>", "autoRecall": true, "budgetTokens": 800 }
 * Installed by: node scripts/install.mjs   (in the omni-agent folder)
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

interface OmniConfig { root: string; vault?: string; autoRecall?: boolean; budgetTokens?: number }

function loadConfig(): OmniConfig | null {
	const p = join(homedir(), ".pi", "agent", "omni-agent.json");
	if (!existsSync(p)) return null;
	try { return JSON.parse(readFileSync(p, "utf8")) as OmniConfig; } catch { return null; }
}

export default async function omniMemory(pi: ExtensionAPI) {
	const cfg = loadConfig();
	if (!cfg?.root) return; // Omni Agent not installed; stay silent.
	const memoryModule = join(cfg.root, "server", "memory.mjs");
	if (!existsSync(memoryModule)) return;
	const { Vault } = await import(pathToFileURL(memoryModule).href);
	const vault = new Vault(cfg.vault ?? join(cfg.root, "vault")).ensure();
	const budget = cfg.budgetTokens ?? 800;

	pi.registerTool({
		name: "memory_search",
		label: "Memory search",
		description: "Search the user's durable memory vault (Obsidian notes managed by Omni Agent). Returns the best-matching notes with a short preview. Use before re-deriving something the user may already have written down (offsets, quirks, decisions, preferences).",
		promptSnippet: "Search the user's durable memory vault",
		parameters: Type.Object({
			query: Type.String({ description: "Keywords to search for" }),
			limit: Type.Optional(Type.Number({ description: "Max hits (default 8)" })),
		}),
		async execute(_id, params) {
			const hits = await vault.search(params.query, { limit: params.limit ?? 8 });
			const text = hits.length
				? hits.map((h: any) => `- ${h.name} [${h.type || "note"}] (${h.path}): ${h.description || h.preview}`).join("\n")
				: "No matching notes.";
			return { content: [{ type: "text", text }], details: { count: hits.length } };
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("memory_search ")) + theme.fg("muted", String(args.query ?? "")), 0, 0);
		},
		renderResult(result, _opts, theme) {
			const t = result.content[0];
			return new Text(theme.fg("toolOutput", t?.type === "text" ? t.text : ""), 0, 0);
		},
	});

	pi.registerTool({
		name: "memory_recall",
		label: "Memory recall",
		description: "Return a compact, token-budgeted pack of the notes most relevant to a topic, ready to reason over. Cheaper than reading notes one by one.",
		promptSnippet: "Recall relevant durable memory as a compact pack",
		parameters: Type.Object({
			topic: Type.String({ description: "What you are working on or need to remember" }),
			budgetTokens: Type.Optional(Type.Number({ description: "Approximate token budget (default from config)" })),
		}),
		async execute(_id, params) {
			const pack = await vault.pack(params.topic, { budgetTokens: params.budgetTokens ?? budget });
			return { content: [{ type: "text", text: pack || "Nothing relevant in memory." }], details: {} };
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("memory_recall ")) + theme.fg("muted", String(args.topic ?? "")), 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			const t = result.content[0];
			const text = t?.type === "text" ? t.text : "";
			const lines = text.split("\n");
			return new Text(theme.fg("toolOutput", expanded ? text : lines.slice(0, 6).join("\n") + (lines.length > 6 ? `\n... ${lines.length - 6} more lines` : "")), 0, 0);
		},
	});

	pi.registerTool({
		name: "memory_save",
		label: "Memory save",
		description: "Save one durable fact to the user's memory vault as a note. Use for things worth remembering across sessions: a resolved offset, a working hook, a host quirk, a user preference or decision. One fact per note; link related notes with [[name]].",
		promptSnippet: "Save a durable fact to the user's memory vault",
		parameters: Type.Object({
			name: Type.String({ description: "Short name, e.g. 'roblox 2.3.4 jni offsets'" }),
			description: Type.String({ description: "One line used to decide relevance later" }),
			type: Type.Optional(Type.String({ description: "user | feedback | project | reference (default project)" })),
			body: Type.String({ description: "The fact itself, markdown. Include why and how to apply." }),
			tags: Type.Optional(Type.Array(Type.String())),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const r = await vault.save({ name: params.name, description: params.description, type: params.type ?? "project", body: params.body, tags: params.tags ?? [], source: `pi:${ctx.cwd}` });
			return { content: [{ type: "text", text: `${r.created ? "Saved" : "Updated"} ${r.path}` }], details: r };
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("memory_save ")) + theme.fg("accent", String(args.name ?? "")), 0, 0);
		},
		renderResult(result, _opts, theme) {
			const t = result.content[0];
			return new Text(theme.fg("success", t?.type === "text" ? t.text : ""), 0, 0);
		},
	});

	if (cfg.autoRecall !== false) {
		pi.on("before_agent_start", async (event) => {
			try {
				const pack = await vault.pack(event.prompt, { budgetTokens: budget });
				if (!pack) return undefined;
				return {
					systemPrompt: `${event.systemPrompt}\n\nDurable memory relevant to this prompt (from the user's Omni vault; call memory_recall for more, memory_save to add):\n${pack}`,
				};
			} catch {
				return undefined;
			}
		});
	}

	pi.registerCommand("memory", {
		description: "Search the Omni memory vault: /memory <query>",
		handler: async (args, ctx) => {
			const hits = await vault.search(args || "", { limit: 10 });
			ctx.ui.notify(hits.length ? hits.map((h: any) => `${h.name}: ${h.description || h.preview}`).join("\n") : "No matching notes.", "info");
		},
	});
}
