#!/usr/bin/env node
/**
 * Pre-install the CLI reverse-engineering tools the pi agent needs, so it never re-downloads
 * them from GitHub every session or accidentally launches a GUI.
 *
 *   node scripts/install-tools.mjs
 *
 * Installs into ~/.omni-agent/tools and writes CLI-only launchers into ~/.omni-agent/tools/bin
 * (both a POSIX script for Git Bash and a .cmd for cmd). server/config.mjs puts that bin dir on
 * the pi child's PATH (piChildEnv), so `command -v jadx|apktool|baksmali|smali` all resolve to a
 * working HEADLESS CLI. Idempotent: anything already present is skipped. Needs Java and `curl`
 * on PATH (and `tar` or `unzip` to extract the jadx zip — both ship with Windows 10+/Git Bash).
 *
 * jadx is the CLI only (the `-all.jar`); the GUI jar is never launched. baksmali/smali run from a
 * pinned classpath (org.smali 2.5.2 + dexlib2/util/guava + jcommander 1.64).
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = process.env.OMNI_HOME || homedir();
const TOOLS = process.env.OMNI_TOOLS_DIR || join(HOME, ".omni-agent", "tools");
const BIN = join(TOOLS, "bin");
const LIB = join(TOOLS, "smali-lib");
const JADX_VER = "1.5.1";

const sh = (cmd, args) => spawnSync(cmd, args, { encoding: "utf8", windowsHide: true });
/** Windows-friendly forward-slash path java + Git Bash both accept. */
const p = (abs) => abs.replace(/\\/g, "/");
const big = (f, min = 100000) => { try { return statSync(f).size >= min; } catch { return false; } };

function curl(url, out) {
  const r = sh("curl", ["-sL", "-o", out, url]);
  if (r.status !== 0) throw new Error(`curl failed for ${url}: ${(r.stderr || r.error?.message || "").trim()}`);
  if (!big(out, 10000)) throw new Error(`download too small (likely 404): ${url}`);
}

/** A POSIX launcher (Git Bash) + a .cmd launcher (cmd) for `name`, both running the given java invocation. */
function wrappers(name, javaArgsPosix, javaArgsCmd) {
  writeFileSync(join(BIN, name), `#!/usr/bin/env bash\nexec java ${javaArgsPosix} "$@"\n`);
  try { chmodSync(join(BIN, name), 0o755); } catch { /* windows: exec bit is best-effort */ }
  writeFileSync(join(BIN, `${name}.cmd`), `@echo off\r\njava ${javaArgsCmd} %*\r\n`);
}

function installJadx() {
  const jar = join(TOOLS, "jadx", "lib", `jadx-${JADX_VER}-all.jar`);
  if (!existsSync(jar)) {
    const zip = join(TOOLS, "jadx.zip");
    curl(`https://github.com/skylot/jadx/releases/download/v${JADX_VER}/jadx-${JADX_VER}.zip`, zip);
    rmSync(join(TOOLS, "jadx"), { recursive: true, force: true });
    mkdirSync(join(TOOLS, "jadx"), { recursive: true });
    // Win10+ `tar` extracts zip; fall back to `unzip` (Git Bash).
    let x = sh("tar", ["-xf", zip, "-C", join(TOOLS, "jadx")]);
    if (x.status !== 0) x = sh("unzip", ["-q", "-o", zip, "-d", join(TOOLS, "jadx")]);
    if (x.status !== 0) throw new Error("could not extract jadx zip (need tar or unzip)");
  }
  if (!existsSync(jar)) throw new Error(`jadx CLI jar missing after extract: ${jar}`);
  wrappers("jadx", `-jar "${p(jar)}"`, `-jar "${jar}"`);
  return "jadx CLI";
}

function installApktool() {
  const jar = join(TOOLS, "apktool.jar");
  if (!big(jar)) curl("https://github.com/iBotPeaches/Apktool/releases/download/v2.10.0/apktool_2.10.0.jar", jar);
  wrappers("apktool", `-jar "${p(jar)}"`, `-jar "${jar}"`);
  return "apktool";
}

function installSmali() {
  // org.smali 2.5.2 library jars + pinned deps, run via main class (no runnable fat jar is published).
  mkdirSync(LIB, { recursive: true });
  const deps = {
    baksmali: "https://repo1.maven.org/maven2/org/smali/baksmali/2.5.2/baksmali-2.5.2.jar",
    smali: "https://repo1.maven.org/maven2/org/smali/smali/2.5.2/smali-2.5.2.jar",
    dexlib2: "https://repo1.maven.org/maven2/org/smali/dexlib2/2.5.2/dexlib2-2.5.2.jar",
    util: "https://repo1.maven.org/maven2/org/smali/util/2.5.2/util-2.5.2.jar",
    guava: "https://repo1.maven.org/maven2/com/google/guava/guava/31.1-jre/guava-31.1-jre.jar",
    jcommander: "https://repo1.maven.org/maven2/com/beust/jcommander/1.64/jcommander-1.64.jar", // version pinned by smali 2.5.2 POM
  };
  for (const [name, url] of Object.entries(deps)) { const f = join(LIB, `${name}.jar`); if (!big(f, 20000)) curl(url, f); }
  const cpOf = (main) => [main, "dexlib2", "util", "guava", "jcommander"].map((j) => join(LIB, `${j}.jar`));
  for (const [cmd, main, cls] of [["baksmali", "baksmali", "org.jf.baksmali.Main"], ["smali", "smali", "org.jf.smali.Main"]]) {
    const jars = cpOf(main);
    wrappers(cmd, `-cp "${jars.map(p).join(";")}" ${cls}`, `-cp "${jars.join(";")}" ${cls}`);
  }
  return "baksmali + smali";
}

function main() {
  if (sh("java", ["-version"]).status !== 0) { console.error("Java not found on PATH — the RE tools (jadx/apktool/baksmali/smali) are JVM-based. Install a JRE/JDK first."); process.exit(1); }
  mkdirSync(BIN, { recursive: true });
  const done = [];
  for (const step of [installJadx, installApktool, installSmali]) {
    try { done.push(step()); } catch (e) { console.error(`  ${step.name} failed: ${e.message}`); }
  }
  console.log(`RE tools installed into ${TOOLS}`);
  console.log(`  bin (on the pi child's PATH): ${BIN}`);
  console.log(`  ready: ${done.join(", ") || "(none — see errors above)"}`);
  // quick headless self-check (a .cmd must be run through cmd on Windows, else directly)
  for (const t of ["jadx", "apktool", "baksmali", "smali"]) {
    const r = process.platform === "win32" ? sh("cmd", ["/c", join(BIN, `${t}.cmd`), "--version"]) : sh(join(BIN, t), ["--version"]);
    const line = (`${r.stdout || ""}\n${r.stderr || ""}`).split(/\r?\n/).find((l) => l.trim()) || "(no output)";
    console.log(`  ${t} --version -> ${line.trim().slice(0, 60)}`);
  }
}

main();
