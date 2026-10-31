/**
 * What a mission worker is told: the contract it works under, the report format, and the status request the orchestrator sends.
 */

export const REPORT_HEADINGS = Object.freeze(["Status", "Outcome", "What works", "Tried and failed", "Errors", "Artifacts", "Knowledge recorded", "Open questions / next"]);

const FORMAT = REPORT_HEADINGS.map((h) => `## ${h}`).join("\n");

export const WORKER_FOOTER = `

(You are a worker in an Omni mission, started by the mission's orchestrator for this one task. You work alone: the orchestrator does not see your chat, only your final report.
- Record durable findings as you go so they outlive your context: memory_save for facts (offsets, keys, quirks, what an obfuscated function does), kg_upsert for structure (functions, calls, strings, names, with status hypothesis/confirmed and evidence) when those tools are available.
- Put big outputs (dumps, decrypted binaries, scripts, exports) in the project artifacts directory, never in the report.
- If you are truly blocked on something only the orchestrator can decide, call ask_orchestrator. Otherwise make reasonable assumptions and note them.
- If your context has been compacted twice or you are losing track, call handoff with a complete handoff note; a fresh worker continues.
- Use subagents for independent sub-investigations when it helps.
Finish with a report in exactly this format (short, factual; no code dumps — paths instead):
${FORMAT}
Status is one of: done, stuck, partial.)`;

export const SUMMARY_REQUEST = `[omni-orchestrator] Status request from the mission orchestrator. Do not stop your work for long: reply now with a short status in exactly this format (so far), then continue.
${FORMAT}
Status is one of: done, stuck, partial (still working = partial).`;

/** The first lines of one `## Heading` section of a report, or "". */
export function reportSection(text, heading) {
  const lines = String(text ?? "").split(/\r?\n/);
  const want = heading.toLowerCase();
  const i = lines.findIndex((l) => /^#{1,3}\s/.test(l) && l.replace(/^#{1,3}\s+/, "").trim().toLowerCase().startsWith(want));
  if (i < 0) return "";
  const out = [];
  for (const l of lines.slice(i + 1)) { if (/^#{1,3}\s/.test(l)) break; out.push(l); }
  return out.join("\n").trim();
}

/** The brief a worker starts with. `paths` = the project folders. */
export function workerBrief(m, spec, paths = {}) {
  const scope = spec.scope || {};
  const lines = [
    `Mission goal (context only — your task is below): ${String(m.goal || "").split(/\r?\n/)[0].slice(0, 400)}`,
    "",
    "## Your task",
    String(spec.task || "").trim(),
  ];
  const sc = [];
  if (scope.files?.length) sc.push(`Files / directories to start from:\n${scope.files.map((f) => `- ${f}`).join("\n")}`);
  if (scope.notes?.length) sc.push(`Project memory notes to read first (memory_recall / memory_search):\n${scope.notes.map((n) => `- ${n}`).join("\n")}`);
  if (scope.kg?.length) sc.push(`Knowledge-graph queries to start from (kg_search / kg_node):\n${scope.kg.map((q) => `- ${q}`).join("\n")}`);
  if (sc.length) lines.push("", "## Scope", ...sc);
  lines.push("", "## Where things go", `- Project directory: ${m.dir}`);
  if (paths.artifactsDir) lines.push(`- Artifacts (dumps, exports, scripts): ${paths.artifactsDir}`);
  if (paths.memoryDir) lines.push(`- Project memory: ${paths.memoryDir} (use the memory_* tools)`);
  return lines.join("\n");
}
