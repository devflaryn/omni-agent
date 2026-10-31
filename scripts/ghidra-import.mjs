#!/usr/bin/env node
/**
 * One kg_import of a binary, run as a mission's shell job: Ghidra headless with OmniExport.java, then the JSONL is
 * loaded into the mission's knowledge graph through the running Omni. Every path comes in through the environment,
 * never through a command line a shell parses (a binary may be named anything):
 *
 *   OMNI_GHIDRA (analyzeHeadless[.bat]) OMNI_GHIDRA_PROJECT OMNI_GHIDRA_NAME OMNI_GHIDRA_BIN OMNI_GHIDRA_OUT
 *   OMNI_GHIDRA_SCRIPTS OMNI_URL OMNI_MISSION OMNI_BIN_NAME
 */
import { spawn } from "node:child_process";

const env = process.env;
const need = ["OMNI_GHIDRA", "OMNI_GHIDRA_PROJECT", "OMNI_GHIDRA_NAME", "OMNI_GHIDRA_BIN", "OMNI_GHIDRA_OUT", "OMNI_GHIDRA_SCRIPTS", "OMNI_URL", "OMNI_MISSION"];
const missing = need.filter((k) => !env[k]);
if (missing.length) { console.error(`ERROR: missing ${missing.join(", ")}`); process.exit(2); }

export const ghidraArgs = (e) => [e.OMNI_GHIDRA_PROJECT, e.OMNI_GHIDRA_NAME, "-import", e.OMNI_GHIDRA_BIN, "-overwrite", "-scriptPath", e.OMNI_GHIDRA_SCRIPTS, "-postScript", "OmniExport.java", e.OMNI_GHIDRA_OUT];

/**
 * A .bat needs cmd.exe. Its command line is built here, verbatim, every argument in double quotes; characters cmd (or
 * the .bat itself) could still act on are refused.
 */
function run() {
  const bin = env.OMNI_GHIDRA, args = ghidraArgs(env);
  if (/\.(bat|cmd)$/i.test(bin)) {
    // Ghidra's own .bat forwards its arguments with %*, where & | < > ^ ! would act again: refuse those too.
    const bad = [bin, ...args].find((a) => /["%!&|<>^\r\n]/.test(a));
    if (bad) { console.error(`ERROR: cannot pass ${JSON.stringify(bad)} to cmd.exe safely (it contains one of " % ! & | < > ^); copy the file to a plain name first`); process.exit(2); }
    const line = `"${[bin, ...args].map((a) => `"${a}"`).join(" ")}"`;
    return spawn(env.ComSpec || "cmd.exe", ["/d", "/s", "/c", line], { stdio: "inherit", windowsVerbatimArguments: true, windowsHide: true });
  }
  return spawn(bin, args, { stdio: "inherit", shell: false });
}

const code = await new Promise((resolve) => { const p = run(); p.on("exit", (c) => resolve(c ?? 1)); p.on("error", (e) => { console.error(`ERROR: ${e.message}`); resolve(1); }); });
if (code !== 0) { console.error(`ERROR: Ghidra exited with code ${code}`); process.exit(code); }
const r = await fetch(`${env.OMNI_URL.replace(/\/+$/, "")}/api/missions/${env.OMNI_MISSION}/kg/load`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ file: env.OMNI_GHIDRA_OUT, binary: env.OMNI_BIN_NAME || "" }) });
const j = await r.json().catch(() => ({}));
if (!r.ok || j.error) { console.error(`ERROR: loading the export failed: ${j.error || r.status}`); process.exit(1); }
console.log(`KG LOADED: ${j.nodes} nodes, ${j.edges} edges from ${j.lines} lines (${env.OMNI_BIN_NAME || env.OMNI_GHIDRA_BIN})`);
