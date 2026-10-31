import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { KGraph } from "../server/kgraph.mjs";
import { fromGraphify, ghidraCommand, importGhidraJsonl } from "../server/kgraph-import.mjs";

const base = mkdtempSync(join(tmpdir(), "omni-kgi-"));
const open = [];
after(() => { for (const k of open) k.close(); rmSync(base, { recursive: true, force: true }); });
const fixture = fileURLToPath(new URL("./fixtures/ghidra-libz.jsonl", import.meta.url));

test("fromGraphify maps files, symbols and relations", () => {
  const g = { nodes: [{ id: "agent", label: "agent.py", source_file: "agent.py", source_location: "L1", file_type: "code", community: 5 }, { id: "agent_run", label: "run()", source_file: "agent.py", source_location: "L40" }],
    links: [{ source: "agent", target: "agent_run", relation: "contains" }, { source: "agent_run", target: "agent", relation: "weird_rel" }] };
  const r = fromGraphify(g, { repo: "omni" });
  assert.deepEqual(r.nodes.map((n) => [n.id, n.kind]), [["src:agent", "file"], ["src:agent_run", "symbol"]]);
  assert.equal(r.nodes[1].summary, "agent.py:L40");
  assert.deepEqual(r.edges.map((e) => [e.rel, e.note]), [["contains", null], ["related", "weird_rel"]]);
});

test("a real Ghidra export (libz.so, arm64) loads into the graph: functions, calls, strings, exports", async () => {
  const kg = await KGraph.open(join(base, "libz.sqlite")); open.push(kg);
  const r = await importGhidraJsonl(kg, fixture, { binary: "libz.so", batch: 100 });
  assert.equal(r.lines, 811);
  const s = kg.stats();
  assert.ok(s.byKind.function >= 190, JSON.stringify(s.byKind));
  assert.equal(s.byKind.string, 183);
  assert.equal(s.byKind.binary, 1);
  const inflate = kg.find("function:libz.so:0x1126a4");
  assert.equal(inflate.name, "inflate");
  assert.match(kg.node("function:libz.so:0x1126a4"), /→ out/);
  assert.match(kg.search("inflate", { kind: "function" }), /0x1126a4/);
  assert.match(kg.node("binary:libz.so"), /AARCH64/);
});

test("ghidraCommand quotes paths with spaces", () => {
  const c = ghidraCommand({ analyzeHeadless: "C:/g/analyzeHeadless.bat", projectDir: "C:/Users/a b/proj", projectName: "libz", binary: "C:/x y/libz.so", out: "C:/o/libz.jsonl", scriptDir: "C:/Omni Apps/integrations/ghidra" });
  assert.equal(c, 'cmd.exe //c "C:/g/analyzeHeadless.bat" "C:/Users/a b/proj" "libz" -import "C:/x y/libz.so" -overwrite -scriptPath "C:/Omni Apps/integrations/ghidra" -postScript OmniExport.java "C:/o/libz.jsonl"');
});
