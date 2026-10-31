import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KGraph, ftsQuery } from "../server/kgraph.mjs";

const base = mkdtempSync(join(tmpdir(), "omni-kg-"));
const open = [];
after(() => { for (const k of open) k.close(); rmSync(base, { recursive: true, force: true }); });
const kgAt = async (name) => { const k = await KGraph.open(join(base, `${name}.sqlite`)); open.push(k); return k; };

test("ftsQuery makes prefix terms from words", () => {
  assert.equal(ftsQuery("decrypt the String-table!"), '"decrypt"* OR "the"* OR "string"* OR "table"*');
  assert.equal(ftsQuery("  "), "");
});

test("upsert merges: non-empty wins, status only moves up, evidence accumulates", async () => {
  const kg = await kgAt("merge");
  kg.upsert({ nodes: [{ kind: "function", binary: "libapp.so", addr: "0x4A20", name: "FUN_00104a20" }] }, { by: "ghidra" });
  const id = "function:libapp.so:0x4a20";
  kg.upsert({ nodes: [{ id, name: "decrypt_strings", summary: "XOR 0x5A over .rodata strings", status: "confirmed", confidence: 0.9, evidence: "lab_trace: output matches" }] }, { by: "a-1" });
  kg.upsert({ nodes: [{ id, status: "hypothesis", evidence: "r2 xrefs" }] }, { by: "a-2" });
  const n = kg.find(id);
  assert.equal(n.name, "decrypt_strings");
  assert.equal(n.addr, "0x4a20");
  assert.equal(n.status, "confirmed", "a weaker status does not downgrade");
  assert.match(n.evidence, /lab_trace[\s\S]*r2 xrefs/);
  assert.equal(n.updated_by, "a-2");
  kg.upsert({ nodes: [{ id, status: "hypothesis" }] }, { force: true });
  assert.equal(kg.find(id).status, "hypothesis");
  assert.equal(kg.find("0x4a20").id, id, "found by address");
  assert.equal(kg.find("decrypt_strings").id, id, "found by name");
});

test("search ranks name hits first and respects the budget; node shows neighbours", async () => {
  const kg = await kgAt("search");
  kg.upsert({
    nodes: [
      { id: "f:login", kind: "function", name: "login_request", summary: "builds the signed login POST" },
      { id: "f:sign", kind: "function", name: "hmac_sign", summary: "signs a request body; used by login" },
      { id: "s:url", kind: "string", name: "https://api.example.com/v2/login", summary: "" },
      ...Array.from({ length: 300 }, (_, i) => ({ id: `f:n${i}`, kind: "function", name: `filler_${i}`, summary: "login helper noise ".repeat(20) })),
    ],
    edges: [{ src: "f:login", dst: "f:sign", rel: "calls" }, { src: "f:login", dst: "s:url", rel: "xref", note: "at 0x1234" }],
  });
  const r = kg.search("login", { limit: 50, budget: 300 });
  assert.match(r.split("\n")[0], /login_request/);
  assert.ok(r.length <= 1200, String(r.length));
  assert.match(kg.search("hmac", { kind: "function" }), /hmac_sign/);
  assert.match(kg.search("zzzz"), /No knowledge-graph nodes match/);
  const node = kg.node("login_request");
  assert.match(node, /→ out:/);
  assert.match(node, /calls f:sign \[function\] hmac_sign/);
  assert.match(node, /xref s:url .*\(at 0x1234\)/);
  assert.match(kg.node("hmac_sign"), /← in:\n {2}calls f:login/);
  assert.deepEqual(kg.stats().byKind.string, 1);
});

test("200k nodes in one transaction stay fast", async () => {
  const kg = await kgAt("big");
  const nodes = Array.from({ length: 200000 }, (_, i) => ({ id: `f${i}`, kind: "function", name: `FUN_${i.toString(16)}`, binary: "big.so", addr: `0x${(0x10000 + i * 16).toString(16)}` }));
  const edges = Array.from({ length: 200000 }, (_, i) => ({ src: `f${i}`, dst: `f${(i * 7) % 200000}`, rel: "calls" }));
  const t0 = Date.now();
  kg.upsert({ nodes, edges });
  const ms = Date.now() - t0;
  assert.ok(ms < 20000, `took ${ms} ms`);
  assert.equal(kg.stats().nodes, 200000);
  assert.match(kg.search("FUN_1a2b"), /FUN_1a2b/);
});
