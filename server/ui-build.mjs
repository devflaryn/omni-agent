// Whether dist/ui is what ui/ makes, and the one place that decides what the desktop server serves. No dependencies: a plain checkout
// with no install runs this. A build that is not the sources' is never served: the server goes to source and says so in its log.
//
// Line endings do not count, for a checkout that turns them is the same source; see scripts/build-ui.mjs, which strips them too.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadWebFiles, readBuild } from "../hub/static.mjs";

const TEXT = /\.(?:m?js|css|html|svg|json)$/;

/** A source file's hash. Text is hashed without carriage returns. */
export function hashSource(bytes, name) {
  const body = TEXT.test(name) ? Buffer.from(bytes.toString("latin1").replace(/\r\n/g, "\n"), "latin1") : bytes;
  return createHash("sha256").update(body).digest("hex");
}

const distOf = (root) => pathToFileURL(`${join(root, "dist", "ui")}/`);

/** Why the build in `root` cannot be served, or null. Reads every input and every output. */
export function checkBuild(root) {
  let build;
  try { build = readBuild(distOf(root)); }
  catch (error) { return error.code === "ENOENT" ? "there is no build" : `the build's list cannot be read: ${error.message}`; }
  return staleInput(root, build) ?? damagedOutput(root);
}

function staleInput(root, build) {
  for (const [name, hash] of Object.entries(build.inputs)) {
    const file = join(root, name);
    if (!existsSync(file)) return `${name} is gone`;
    if (hashSource(readFileSync(file), name) !== hash) return `${name} changed`;
  }
  return null;
}

function damagedOutput(root) {
  try { loadWebFiles(distOf(root)); }
  catch (error) { return `the build is damaged: ${error.message}`; }
  return null;
}

/**
 * The desktop server's view of the build. `current()` is the build to serve the page from, or null for source. It is asked at each
 * page load and looks only at each input's size and time unless one has moved, which costs well under a millisecond a file.
 * `files()` is the build's files even when stale, for a page that loaded them before the edit.
 */
export function openUiBuild({ root, log = () => {}, fromSource = false, autoBuild = false, runBuild = defaultBuild }) {
  const list = join(root, "dist", "ui", "build.json");
  // A developer's checkout, with esbuild installed: a stale build is rebuilt by itself, one at a time, while source is served. A failed
  // build is not tried again until a source changes. A plain checkout has no esbuild and is not touched.
  const canBuild = autoBuild && !fromSource && existsSync(join(root, "node_modules", "esbuild"));
  let building = null, failedAt = null;
  function rebuild() {
    if (!canBuild || building || failedAt === signature) return;
    const at = signature;
    log("building the UI (npm run build)");
    building = runBuild(root).then(
      () => { log("the UI is built"); },
      (error) => { failedAt = at; log(`the UI build failed, so the UI stays on source: ${String(error.message).split("\n").slice(0, 6).join(" | ")}`); },
    ).finally(() => { building = null; });
  }
  let loaded = null;       // the build's files, once read, and those of any build before it this run
  let version = null;
  let inputs = [];
  let signature = null;    // the inputs' sizes and times at the last decision, and the build's list's
  let serving = null;      // { files: loaded } while it is what the sources make, else null
  let why = null;
  let said = null;

  const sign = () => [list, ...inputs].map((file) => { try { const s = statSync(file); return `${s.size}:${s.mtimeMs}`; } catch { return "-"; } }).join("|");

  /** Still read when stale, so a page opened before the edit can load its lazy parts. Not when it is damaged, which throws. */
  function read() {
    if (fromSource) return;
    try {
      const build = readBuild(distOf(root));
      inputs = Object.keys(build.inputs).map((name) => join(root, name));
      if (build.version === version) return;
      const files = loadWebFiles(distOf(root), { entry: "index.html", except: ["sw.js", "web.html"] });
      loaded = new Map([...(loaded ?? []), ...files]);
      version = build.version;
      serving = null;
    } catch { /* checkBuild says what is wrong */ }
  }

  function decide() {
    read();
    why = fromSource ? "OMNI_UI_SOURCE or uiFromSource asks for it" : checkBuild(root);
    serving = why ? null : (serving ?? { files: loaded });
    signature = sign();
    const line = why ? `serving the UI from source: ${why}.${canBuild ? "" : " npm run build makes it fast again"}` : "serving the built UI";
    if (line !== said) { said = line; log(line); }
    if (why) rebuild();
  }

  return {
    current() {
      if (signature === null || sign() !== signature) decide();
      return serving;
    },
    /** For a request by name: a page already open may want a part of the build it started on, whatever has changed since. */
    files() {
      if (signature === null) decide();
      return loaded;
    },
    reason() { this.current(); return why; },
    /** The build under way, if any: for tests. */
    get building() { return building; },
  };
}

/** `node scripts/build-ui.mjs` in `root`. Its output goes to the log only when it fails. */
function defaultBuild(root) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, "scripts", "build-ui.mjs")], { cwd: root, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let text = "";
    child.stdout.on("data", (d) => { text += d; });
    child.stderr.on("data", (d) => { text += d; });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(text.trim() || `exit ${code}`))));
  });
}
