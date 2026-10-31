/**
 * Importers into a project's knowledge graph (server/kgraph.mjs):
 *
 *   graphify   a source repo's graphify graph.json → file/symbol nodes + their relations (ids prefixed "src:").
 *              A repo that has no graphify-out/ of its own gets one built, imported, and moved out of the repo into
 *              the project's graph/imports/graphify/ (nothing of ours stays in the project folder).
 *   ghidra     the JSONL that integrations/ghidra/OmniExport.java writes: functions, calls, strings and the functions
 *              that reference them, imports, exports → nodes with binary + addr, `calls` / `xref` edges.
 */
import { createReadStream, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import * as graphify from "./graph.mjs";

const REL = { contains: "contains", calls: "calls", imports: "imports", imports_from: "imports", inherits: "implements", implements: "implements", method: "contains", uses: "related", references: "related" };

/** graphify's graph.json → { nodes, edges } for KGraph.upsert. Pure. */
export function fromGraphify(g, { repo = "" } = {}) {
  const nodes = [], edges = [];
  for (const n of g?.nodes || []) {
    if (!n?.id) continue;
    const file = n.source_file || "";
    const isFile = !!file && (n.label === basename(file) || n.label === file);
    nodes.push({ id: `src:${n.id}`, kind: isFile ? "file" : "symbol", name: n.label || n.id, summary: file ? `${file}${n.source_location ? `:${n.source_location}` : ""}` : "", tags: [repo, n.file_type, n.community != null ? `community${n.community}` : ""].filter(Boolean) });
  }
  for (const e of g?.links || g?.edges || []) {
    const s = e?.source ?? e?.src, t = e?.target ?? e?.dst;
    if (s == null || t == null) continue;
    edges.push({ src: `src:${typeof s === "object" ? s.id : s}`, dst: `src:${typeof t === "object" ? t.id : t}`, rel: REL[e.relation] || "related", note: e.relation && !REL[e.relation] ? e.relation : null });
  }
  return { nodes, edges };
}

/** Import a repo through graphify; nothing new is left in the repo. → { nodes, edges, built } */
export async function importGraphify(kg, dir, { graphDir, bin = "graphify", by = "graphify", onLine } = {}) {
  const repo = resolve(dir);
  const own = existsSync(graphify.graphPath(repo));
  if (!own) await graphify.build(repo, { bin, onLine });
  const g = JSON.parse(readFileSync(graphify.graphPath(repo), "utf8"));
  const r = kg.upsert(fromGraphify(g, { repo: basename(repo) }), { by });
  if (!own && graphDir) {
    const out = join(repo, "graphify-out"), dest = join(graphDir, "imports", "graphify", basename(repo));
    mkdirSync(join(graphDir, "imports", "graphify"), { recursive: true });
    rmSync(dest, { recursive: true, force: true });
    try { renameSync(out, dest); } catch { cpSync(out, dest, { recursive: true }); rmSync(out, { recursive: true, force: true }); }
  }
  return { ...r, built: !own };
}

/** One OmniExport JSONL record → nodes/edges (into `acc`). Pure. */
export function ghidraRecord(rec, bin, acc) {
  const fid = (a) => `function:${bin}:${String(a).toLowerCase()}`;
  switch (rec?.t) {
    case "bin": acc.nodes.push({ id: `binary:${bin}`, kind: "binary", name: bin, summary: [rec.format, rec.arch, rec.size ? `${rec.size} bytes` : "", rec.path].filter(Boolean).join(" · ") }); break;
    case "fn": acc.nodes.push({ id: fid(rec.addr), kind: "function", name: rec.name, binary: bin, addr: rec.addr, tags: [rec.thunk ? "thunk" : "", rec.ext ? "external" : "", rec.size ? `size${rec.size}` : ""].filter(Boolean) }); break;
    case "call": acc.edges.push({ src: fid(rec.from), dst: fid(rec.to), rel: "calls" }); break;
    case "str": {
      const id = `string:${bin}:${String(rec.addr).toLowerCase()}`;
      acc.nodes.push({ id, kind: "string", name: String(rec.value ?? "").slice(0, 300), binary: bin, addr: rec.addr });
      for (const f of rec.refs || []) acc.edges.push({ src: fid(f), dst: id, rel: "xref" });
      break;
    }
    case "imp": acc.nodes.push({ id: `symbol:${bin}:imp:${rec.name}`, kind: "symbol", name: rec.name, binary: bin, addr: rec.addr, tags: ["import", rec.lib || ""].filter(Boolean) }); if (rec.addr) acc.edges.push({ src: fid(rec.addr), dst: `symbol:${bin}:imp:${rec.name}`, rel: "implements" }); break;
    case "exp": acc.nodes.push({ id: fid(rec.addr), kind: "function", name: rec.name, binary: bin, addr: rec.addr, tags: ["export"] }); break;
    default: break;
  }
}

/** Load an OmniExport JSONL file in batches. → { nodes, edges, lines } */
export async function importGhidraJsonl(kg, file, { binary = "", by = "ghidra", batch = 5000 } = {}) {
  const bin = binary || basename(file).replace(/\.jsonl$/i, "");
  let acc = { nodes: [], edges: [] }, lines = 0, nodes = 0, edges = 0;
  const flush = () => { const r = kg.upsert(acc, { by }); nodes += r.nodes; edges += r.edges; acc = { nodes: [], edges: [] }; };
  // Calls and xrefs can name functions before their "fn" line: nodes first would need two passes; edges to a node
  // that arrives later are fine (edges are not foreign-keyed).
  const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    lines++;
    let rec; try { rec = JSON.parse(line); } catch { continue; }
    ghidraRecord(rec, bin, acc);
    if (acc.nodes.length + acc.edges.length >= batch) flush();
  }
  flush();
  return { nodes, edges, lines };
}

/** The shell command that analyses one binary headless with Ghidra and writes OmniExport's JSONL. */
export function ghidraCommand({ analyzeHeadless = "analyzeHeadless", projectDir, projectName, binary, out, scriptDir }) {
  const q = (s) => `"${String(s).replace(/"/g, '\\"')}"`;
  // A Windows .bat runs through cmd.exe (the job's shell is Git Bash, which cannot run one itself).
  const run = /\.(bat|cmd)$/i.test(analyzeHeadless) ? `cmd.exe //c ${q(analyzeHeadless)}` : q(analyzeHeadless);
  return `${run} ${q(projectDir)} ${q(projectName)} -import ${q(binary)} -overwrite -scriptPath ${q(scriptDir)} -postScript OmniExport.java ${q(out)}`;
}
