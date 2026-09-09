import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault } from "../server/memory.mjs";
import { summary, fileGraph, exportToVault, listGraphs } from "../server/graph.mjs";

const g = {
  nodes: [
    { id: "a", label: "a.py", source_file: "a.py", source_location: "L1", file_type: "code", community: 1 },
    { id: "a_f", label: "f()", source_file: "a.py", source_location: "L10", file_type: "code", community: 1 },
    { id: "b", label: "b.py", source_file: "b.py", source_location: "L1", file_type: "code", community: 2 },
    { id: "b_g", label: "g()", source_file: "b.py", source_location: "L3", file_type: "code", community: 2 },
  ],
  links: [
    { source: "a", target: "a_f", relation: "contains", confidence: "EXTRACTED" },
    { source: "a_f", target: "b_g", relation: "calls", confidence: "EXTRACTED" },
    { source: "b", target: "b_g", relation: "contains", confidence: "EXTRACTED" },
  ],
};

test("summary ranks by degree and keeps only links among kept nodes", () => {
  const s = summary(g, { limit: 2 });
  assert.deepEqual(s.nodes.map((n) => n.id), ["a_f", "b_g"]);
  assert.equal(s.links.length, 1);
  assert.equal(s.totals.communities, 2);
  assert.equal(summary(g, { q: "b.py" }).nodes.length, 2);
});

test("fileGraph collapses symbols into files with inter-file edges", () => {
  const f = fileGraph(g);
  assert.deepEqual([...f.keys()], ["a.py", "b.py"]);
  assert.equal(f.get("a.py").symbols.length, 1);
  assert.equal(f.get("a.py").out.get("b.py").count, 1);
});

test("exportToVault writes file notes with wikilinks and an index", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omni-graph-"));
  const v = new Vault(dir).ensure();
  const r = await exportToVault(v, "My Repo", g, { dir: "C:\\repo" });
  assert.equal(r.dir, "Graphs/my-repo");
  assert.equal(r.notes, 3);
  const a = readFileSync(join(dir, "Graphs", "my-repo", "a.md"), "utf8");
  assert.match(a, /\[\[Graphs\/my-repo\/b\|b\.py\]\] \(calls ×1\)/);
  assert.match(a, /`f\(\)` L10/);
  assert.ok(existsSync(join(dir, "Graphs", "my-repo", "_index.md")));
  const list = await listGraphs(v);
  assert.equal(list[0].id, "my-repo");
  assert.equal(list[0].nodes, 4);
});
