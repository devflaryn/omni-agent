#!/usr/bin/env node
/**
 * Claude Code SessionStart hook: prints the Omni vault's memory index as
 * additional context so Claude Code knows what durable memory exists and where
 * the vault lives. Small on purpose (index lines only, capped), so it costs a
 * few hundred tokens rather than the whole vault.
 *
 * Install with: node scripts/install.mjs --claude-hook
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const vault = process.env.OMNI_VAULT || join(root, "vault");
const idx = join(vault, "MEMORY.md");
let lines = [];
if (existsSync(idx)) lines = readFileSync(idx, "utf8").split("\n").filter((l) => l.startsWith("- ")).slice(0, 60);
const context = [
  `Omni Agent memory vault: ${vault}`,
  "Durable notes (one line each; read a note with its path when relevant, and add new durable facts as Memory/<slug>.md with frontmatter name/description/type):",
  ...lines,
].join("\n");
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } }));
