// The Mac app's server process. `Omni Agent.app` runs `node launch.mjs` from inside its bundle and reads one line from stdout:
//   OMNI-READY {"url": "...", "attached": false}   the window loads `url` (it carries the window token, so the line is never logged)
//   OMNI-FAIL  {"message": "..."}                  the app shows the message and quits
// Everything else on stdout and stderr is the server's log, which the app writes to <data dir>/omni.log.
//
// The server lives as long as the app: it stops when stdin closes (the app quit, or died, since the kernel closes the pipe either
// way), on SIGTERM/SIGINT/SIGHUP, and if it is orphaned. Stopping runs the server's own close(), which ends its children
// (opencode, pi, claude) before the process exits.
//
// No paths are written inside the app bundle: omni.config.json, the vault and the log live in the data dir.
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const MIN_NODE_MAJOR = 22;
const HERE = dirname(fileURLToPath(import.meta.url));

/** The default data dir: the Mac convention, or beside the code elsewhere (a checkout run by hand). */
export function defaultDataDir({ platform = process.platform, home = homedir() } = {}) {
  return platform === "darwin" ? join(home, "Library", "Application Support", "Omni Agent") : join(home, ".omni-agent", "app");
}

function argValue(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return {}; }
}

/**
 * What to start, from the command line, the environment and the data dir's omni.config.json. Pure apart from reading that file.
 * Returns { root, dataDir, configFile, port, cwd, env } where env is what the server's configuration reads at import.
 */
export function launchPlan({ argv = [], env = process.env, platform = process.platform, home = homedir(), root = join(HERE, "..") } = {}) {
  const dataDir = argValue(argv, "--data") || env.OMNI_DATA_DIR || defaultDataDir({ platform, home });
  const configFile = join(dataDir, "omni.config.json");
  const fc = readJson(configFile);
  const port = Number(argValue(argv, "--port") || env.OMNI_PORT || fc.port || 4400);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`not a port: ${argValue(argv, "--port") ?? env.OMNI_PORT ?? fc.port}`);
  const cwd = argValue(argv, "--cwd") || env.OMNI_CWD || fc.cwd || join(home, "Desktop");
  return {
    root, dataDir, configFile, port, cwd,
    // The bundle holds a finished UI build and no esbuild: never try to rebuild into it.
    env: { OMNI_DATA_DIR: dataDir, OMNI_PORT: String(port), OMNI_CWD: cwd, OMNI_UI_AUTOBUILD: "0" },
  };
}

export function nodeTooOld(version = process.versions.node) {
  const major = Number(String(version).split(".")[0]);
  return major < MIN_NODE_MAJOR ? `Omni Agent needs Node ${MIN_NODE_MAJOR} or newer; this is Node ${version}.` : null;
}

export const newWindowToken = () => randomBytes(32).toString("base64url");

export function windowUrl(port, token) {
  return `http://127.0.0.1:${port}/?desktop=1${token ? `&token=${encodeURIComponent(token)}` : ""}`;
}

/** "free", "omni" (an Omni server already answers there) or "taken" (something else holds the port). */
export async function probePort(port, { timeoutMs = 1500 } = {}) {
  const open = await new Promise((resolve) => {
    const s = createConnection({ port, host: "127.0.0.1" });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(timeoutMs, () => done(true)); // a port that swallows the connection is not free
    s.once("connect", () => done(true));
    s.once("error", (e) => done(e.code !== "ECONNREFUSED"));
  });
  if (!open) return "free";
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(timeoutMs) });
    const body = await r.json();
    return r.ok && body && typeof body === "object" ? "omni" : "taken";
  } catch { return "taken"; }
}

/** Calls `stop` once, for whichever of these comes first: stdin closing, a signal, the parent going away. */
export function stopWith(stop, { stdin = process.stdin, proc = process, parentPid = process.ppid, pollMs = 2000 } = {}) {
  let done = false;
  const once = (why) => { if (done) return; done = true; clearInterval(timer); stop(why); };
  stdin.on("end", () => once("stdin closed"));
  stdin.on("close", () => once("stdin closed"));
  stdin.on("error", () => once("stdin closed"));
  stdin.resume();
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) proc.on(sig, () => once(sig));
  // Belt and braces: an orphan is re-parented, usually to launchd (1).
  const timer = setInterval(() => { if (proc.ppid !== parentPid) once("parent gone"); }, pollMs);
  timer.unref?.();
  return () => once("asked");
}

const say = (tag, obj) => process.stdout.write(`${tag} ${JSON.stringify(obj)}\n`);

export async function main(argv = process.argv.slice(2)) {
  // A log line must never take the server down: if the app's end of the pipe is gone, stop writing, keep serving.
  process.stdout.on("error", () => {});
  process.stderr.on("error", () => {});
  const old = nodeTooOld();
  if (old) { say("OMNI-FAIL", { message: old }); return 2; }
  let plan;
  try { plan = launchPlan({ argv }); } catch (e) { say("OMNI-FAIL", { message: e.message }); return 2; }
  mkdirSync(plan.dataDir, { recursive: true });

  const state = await probePort(plan.port);
  if (state === "taken") { say("OMNI-FAIL", { message: `Port ${plan.port} is in use by another program. Set "port" in ${plan.configFile} to another number.` }); return 2; }
  if (state === "omni") {
    // A server this app did not start (start.sh, another launcher): open a window on it without the token. Account actions stay off
    // in that window, and Settings says why. Quitting the app leaves that server alone.
    say("OMNI-READY", { url: windowUrl(plan.port), attached: true, port: plan.port });
    await new Promise((resolve) => stopWith(resolve));
    return 0;
  }

  Object.assign(process.env, plan.env);
  const token = newWindowToken();
  const { createApp } = await import(pathToFileURL(join(plan.root, "server", "index.mjs")).href);
  const app = await createApp({ windowToken: token });
  await app.listen();
  process.on("uncaughtException", (e) => console.error("uncaughtException", e?.stack || e));
  process.on("unhandledRejection", (e) => console.error("unhandledRejection", e?.stack || e));
  say("OMNI-READY", { url: windowUrl(plan.port, token), attached: false, port: plan.port });
  stopWith((why) => {
    console.log(`stopping: ${why}`);
    try { app.close(); } finally { process.exit(0); }
  });
  return null;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().then((code) => { if (code !== null) process.exit(code); }, (e) => { say("OMNI-FAIL", { message: `The server did not start: ${e.message}` }); process.exit(1); });
}
