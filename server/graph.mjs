/**
 * Repo knowledge graphs, powered by the user's installed `graphify` CLI.
 *
 *   build(dir)        graphify update + cluster-only (AST extraction, no LLM, seconds)
 *   load(dir)         parse <dir>/graphify-out/graph.json
 *   exportToVault()   write an Obsidian-friendly slice of the graph into vault/Graphs/<name>/
 *                     "files" mode (default): one note per source file, symbols listed inside,
 *                     wikilinks between files + community index notes -> Obsidian graph view
 *                     stays readable even for 6k-node graphs.
 *   summary()         top-N nodes by degree (+ their links) for the in-app graph view
 *   query()           `graphify query` -> compact, token-budgeted repo context for a prompt
 */
import { spawn } from "node:child_process";
import { promises as fs, existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { slugify, serializeNote } from "./memory.mjs";

function run(cmd, args, { cwd, timeoutMs = 600000, onLine } = {}) {
  return new Promise((resolvePromise, reject) => {
    const p = spawn(cmd, args, { cwd, windowsHide: true, shell: process.platform === "win32" });
    let out = "", err = "";
    const t = setTimeout(() => { p.kill(); reject(new Error(`${cmd} timed out`)); }, timeoutMs);
    p.stdout.setEncoding("utf8"); p.stderr.setEncoding("utf8");
    p.stdout.on("data", (d) => { out += d; onLine?.(d); });
    p.stderr.on("data", (d) => { err += d; onLine?.(d); });
    p.on("error", (e) => { clearTimeout(t); reject(e); });
    p.on("exit", (code) => { clearTimeout(t); code === 0 ? resolvePromise({ out, err }) : reject(new Error(`${cmd} ${args[0]} exited ${code}: ${(err || out).slice(-800)}`)); });
  });
}

export function graphPath(dir) {
  return join(resolve(dir), "graphify-out", "graph.json");
}

export async function build(dir, { onLine, bin = "graphify", cluster = true } = {}) {
  const cwd = resolve(dir);
  await run(bin, ["update", "."], { cwd, onLine });
  if (cluster) await run(bin, ["cluster-only", ".", "--no-viz", "--no-label"], { cwd, onLine });
  return load(dir);
}

export async function load(dir) {
  const p = graphPath(dir);
  const g = JSON.parse(await fs.readFile(p, "utf8"));
  g.links = g.links || g.edges || [];
  g.nodes = g.nodes || [];
  return g;
}

export function degrees(g) {
  const d = new Map();
  for (const n of g.nodes) d.set(n.id, 0);
  for (const l of g.links) { d.set(l.source, (d.get(l.source) || 0) + 1); d.set(l.target, (d.get(l.target) || 0) + 1); }
  return d;
}

/** Top nodes by degree, optionally filtered by a substring; links restricted to the kept set. */
export function summary(g, { limit = 150, q = "", community } = {}) {
  const deg = degrees(g);
  const needle = q.toLowerCase();
  let nodes = g.nodes.filter((n) => (community == null || n.community === community) && (!needle || `${n.label} ${n.source_file || ""}`.toLowerCase().includes(needle)));
  nodes.sort((a, b) => (deg.get(b.id) || 0) - (deg.get(a.id) || 0));
  nodes = nodes.slice(0, limit);
  const keep = new Set(nodes.map((n) => n.id));
  const links = g.links.filter((l) => keep.has(l.source) && keep.has(l.target)).map((l) => ({ source: l.source, target: l.target, relation: l.relation, confidence: l.confidence }));
  const communities = {};
  for (const n of g.nodes) communities[n.community] = (communities[n.community] || 0) + 1;
  return {
    nodes: nodes.map((n) => ({ id: n.id, label: n.label, file: n.source_file, loc: n.source_location, type: n.file_type, community: n.community, degree: deg.get(n.id) || 0 })),
    links,
    totals: { nodes: g.nodes.length, links: g.links.length, communities: Object.keys(communities).length },
  };
}

/** Group nodes by source file; return file records with symbols and inter-file edges. */
export function fileGraph(g) {
  const byFile = new Map();
  const fileOf = new Map();
  for (const n of g.nodes) {
    const f = n.source_file || "(unknown)";
    fileOf.set(n.id, f);
    if (!byFile.has(f)) byFile.set(f, { file: f, symbols: [], communities: new Set(), out: new Map() });
    const rec = byFile.get(f);
    if (n.label !== basename(f)) rec.symbols.push({ label: n.label, loc: n.source_location, id: n.id });
    if (n.community != null) rec.communities.add(n.community);
  }
  for (const l of g.links) {
    const a = fileOf.get(l.source), b = fileOf.get(l.target);
    if (!a || !b || a === b) continue;
    const rec = byFile.get(a);
    const key = b;
    const e = rec.out.get(key) || { file: b, relations: new Set(), count: 0 };
    e.relations.add(l.relation || "relates"); e.count++;
    rec.out.set(key, e);
  }
  return byFile;
}

const noteName = (file) => slugify(file.replace(/\.[^.]+$/, "").replace(/[\\/]/g, "-"));

/**
 * Write the graph into the vault as notes. Returns { dir, notes }.
 * mode "files": one note per source file (default). mode "symbols": one note per node (big).
 */
export async function exportToVault(vault, name, g, { dir, mode = "files" } = {}) {
  const base = `Graphs/${slugify(name)}`;
  await fs.rm(vault.abs(base), { recursive: true, force: true });
  await fs.mkdir(vault.abs(base), { recursive: true });
  let notes = 0;
  const communities = new Map();
  if (mode === "symbols") {
    const deg = degrees(g);
    const nameOf = new Map(g.nodes.map((n) => [n.id, slugify(`${n.label}-${n.id}`)]));
    const neighbors = new Map();
    for (const l of g.links) {
      (neighbors.get(l.source) || neighbors.set(l.source, []).get(l.source)).push({ id: l.target, rel: l.relation });
      (neighbors.get(l.target) || neighbors.set(l.target, []).get(l.target)).push({ id: l.source, rel: l.relation });
    }
    for (const n of g.nodes) {
      const body = [`# ${n.label}`, "", `File: \`${n.source_file || "?"}\` ${n.source_location || ""} · community ${n.community} · degree ${deg.get(n.id) || 0}`, "", "## Links", ...(neighbors.get(n.id) || []).slice(0, 80).map((x) => `- ${x.rel || "relates"} [[${base}/${nameOf.get(x.id)}]]`), ""].join("\n");
      await vault.write(`${base}/${nameOf.get(n.id)}.md`, serializeNote({ name: n.label, type: "graph", graph: name, file: n.source_file, community: n.community }, body));
      notes++;
      (communities.get(n.community) || communities.set(n.community, []).get(n.community)).push(`[[${base}/${nameOf.get(n.id)}|${n.label}]]`);
    }
  } else {
    const files = fileGraph(g);
    for (const rec of files.values()) {
      const nn = noteName(rec.file);
      const body = [
        `# ${rec.file}`, "",
        `Graph: [[${base}/_index|${name}]] · communities ${[...rec.communities].sort((a, b) => a - b).join(", ")}`, "",
        "## Depends on / relates to",
        ...[...rec.out.values()].sort((a, b) => b.count - a.count).map((e) => `- [[${base}/${noteName(e.file)}|${e.file}]] (${[...e.relations].join(", ")} ×${e.count})`),
        "", "## Symbols",
        ...rec.symbols.slice(0, 400).map((s) => `- \`${s.label}\` ${s.loc || ""}`),
        "",
      ].join("\n");
      await vault.write(`${base}/${nn}.md`, serializeNote({ name: rec.file, type: "graph", graph: name, symbols: rec.symbols.length }, body));
      notes++;
      for (const c of rec.communities) (communities.get(c) || communities.set(c, []).get(c)).push(`[[${base}/${nn}|${rec.file}]]`);
    }
  }
  const idx = [`# ${name} graph`, "", `Source: \`${dir || ""}\` · ${g.nodes.length} nodes · ${g.links.length} links · built ${new Date().toISOString().slice(0, 16)}`, ""];
  for (const [c, items] of [...communities.entries()].sort((a, b) => b[1].length - a[1].length)) {
    idx.push(`## Community ${c} (${items.length})`, ...[...new Set(items)].slice(0, 60).map((x) => `- ${x}`), "");
  }
  await vault.write(`${base}/_index.md`, serializeNote({ name: `${name} graph`, type: "graph", graph: name, source: dir }, idx.join("\n")));
  await fs.writeFile(vault.abs(`${base}/omni-graph.json`), JSON.stringify({ name, dir, mode, nodes: g.nodes.length, links: g.links.length, built: Date.now() }, null, 2));
  return { dir: base, notes: notes + 1 };
}

export async function listGraphs(vault) {
  const base = vault.abs("Graphs");
  if (!existsSync(base)) return [];
  const out = [];
  for (const d of await fs.readdir(base, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const meta = join(base, d.name, "omni-graph.json");
    if (!existsSync(meta)) continue;
    try { out.push({ id: d.name, ...JSON.parse(await fs.readFile(meta, "utf8")) }); } catch { /* skip */ }
  }
  return out.sort((a, b) => b.built - a.built);
}

export async function query(dir, question, { budget = 800, bin = "graphify", dfs = false } = {}) {
  const args = ["query", question, "--budget", String(budget), "--graph", graphPath(dir)];
  if (dfs) args.push("--dfs");
  const { out } = await run(bin, args, { cwd: resolve(dir), timeoutMs: 120000 });
  return out.trim();
}

export async function explain(dir, node, { bin = "graphify" } = {}) {
  const { out } = await run(bin, ["explain", node, "--graph", graphPath(dir)], { cwd: resolve(dir), timeoutMs: 120000 });
  return out.trim();
}
