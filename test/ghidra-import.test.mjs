import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const base = mkdtempSync(join(tmpdir(), "omni-ghidra-imp-"));
after(() => rmSync(base, { recursive: true, force: true }));
const script = fileURLToPath(new URL("../scripts/ghidra-import.mjs", import.meta.url));
const win = process.platform === "win32";

/** A stand-in for analyzeHeadless that records the arguments it got, one per line. */
function fakeGhidra(dir) {
  const log = join(dir, "args.txt");
  const js = join(dir, "fake.mjs");
  writeFileSync(js, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(log)}, process.argv.slice(2).join("\\n"));\n`);
  let bin;
  if (win) { bin = join(dir, "fake ghidra.bat"); writeFileSync(bin, `@"${process.execPath}" "${js}" %*\r\n`); }
  else { bin = join(dir, "fake-ghidra"); writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`, { mode: 0o755 }); }
  return { bin, log };
}

async function omni() {
  const loads = [];
  const server = createServer((req, res) => { let raw = ""; req.on("data", (c) => { raw += c; }); req.on("end", () => { loads.push({ path: req.url, body: JSON.parse(raw || "{}") }); res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ nodes: 3, edges: 2, lines: 5 })); }); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  after(() => server.close());
  return { url: `http://127.0.0.1:${server.address().port}`, loads };
}

const runScript = (env) => new Promise((resolve) => {
  const p = spawn(process.execPath, [script], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let out = ""; p.stdout.on("data", (d) => { out += d; }); p.stderr.on("data", (d) => { out += d; });
  p.on("exit", (code) => resolve({ code, out }));
});

test("paths reach Ghidra verbatim (spaces, &, $(...), backticks) and the export is loaded", async () => {
  const dir = join(base, "t1"); mkdirSync(dir);
  const { bin, log } = fakeGhidra(dir);
  const o = await omni();
  // On Windows (a .bat) cmd metacharacters are refused (next test); what a shell would expand must arrive as text.
  const evil = join(dir, win ? `lib a b $(echo pwned) \`id\` ;x.so` : `lib a&b $(echo pwned) \`id\` ;x.so`);
  const env = { OMNI_GHIDRA: bin, OMNI_GHIDRA_PROJECT: join(dir, "proj dir"), OMNI_GHIDRA_NAME: "lib", OMNI_GHIDRA_BIN: evil, OMNI_GHIDRA_OUT: join(dir, "out.jsonl"), OMNI_GHIDRA_SCRIPTS: join(dir, "scripts"), OMNI_URL: o.url, OMNI_MISSION: "m-12345678", OMNI_BIN_NAME: "lib.so" };
  const r = await runScript(env);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /KG LOADED: 3 nodes, 2 edges/);
  const args = readFileSync(log, "utf8").split("\n");
  assert.deepEqual(args, [env.OMNI_GHIDRA_PROJECT, "lib", "-import", evil, "-overwrite", "-scriptPath", env.OMNI_GHIDRA_SCRIPTS, "-postScript", "OmniExport.java", env.OMNI_GHIDRA_OUT]);
  assert.ok(!existsSync(join(dir, "pwned")));
  assert.equal(o.loads[0].path, "/api/missions/m-12345678/kg/load");
  assert.deepEqual(o.loads[0].body, { file: env.OMNI_GHIDRA_OUT, binary: "lib.so" });
});

test("% and & in a path are refused when Ghidra is a .bat (cmd.exe would act on them)", { skip: !win }, async () => {
  const dir = join(base, "t2"); mkdirSync(dir);
  const { bin, log } = fakeGhidra(dir);
  const o = await omni();
  const r = await runScript({ OMNI_GHIDRA: bin, OMNI_GHIDRA_PROJECT: dir, OMNI_GHIDRA_NAME: "x", OMNI_GHIDRA_BIN: join(dir, "lib%PATH%.so"), OMNI_GHIDRA_OUT: join(dir, "o.jsonl"), OMNI_GHIDRA_SCRIPTS: dir, OMNI_URL: o.url, OMNI_MISSION: "m-12345678" });
  assert.equal(r.code, 2);
  assert.match(r.out, /cannot pass .* to cmd\.exe safely/);
  assert.ok(!existsSync(log), "Ghidra never ran");
  assert.equal(o.loads.length, 0);
  const r2 = await runScript({ OMNI_GHIDRA: bin, OMNI_GHIDRA_PROJECT: dir, OMNI_GHIDRA_NAME: "x", OMNI_GHIDRA_BIN: join(dir, "a&calc.so"), OMNI_GHIDRA_OUT: join(dir, "o.jsonl"), OMNI_GHIDRA_SCRIPTS: dir, OMNI_URL: o.url, OMNI_MISSION: "m-12345678" });
  assert.equal(r2.code, 2);
  assert.ok(!existsSync(log));
});
