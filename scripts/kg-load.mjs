#!/usr/bin/env node
// Loads a Ghidra OmniExport JSONL into a mission's knowledge graph through the running Omni (the last step of a
// kg_import shell job): node scripts/kg-load.mjs <omniUrl> <missionId> <file.jsonl> <binary name>
const [url, mission, file, binary] = process.argv.slice(2);
if (!url || !mission || !file) { console.error("usage: kg-load.mjs <omniUrl> <missionId> <file.jsonl> [binary]"); process.exit(2); }
const r = await fetch(`${url.replace(/\/+$/, "")}/api/missions/${mission}/kg/load`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ file, binary }) });
const j = await r.json().catch(() => ({}));
if (!r.ok || j.error) { console.error(`kg-load failed: ${j.error || r.status}`); process.exit(1); }
console.log(`KG LOADED: ${j.nodes} nodes, ${j.edges} edges from ${j.lines} lines (${binary || file})`);
