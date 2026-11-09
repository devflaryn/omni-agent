/**
 * Omni Agent server. Node built-ins only.
 *
 *   node server/index.mjs [--port 4400] [--cwd <dir>] [--model <id>] [--provider <p>] [--no-pi]
 *
 * Chats and background agents run on one shared `opencode serve` (server/opencode-server.mjs), each as an
 * OpencodeRpc (server/opencode-rpc.mjs) that keeps pi's RPC contract: the internal harness key stays "pi".
 */
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { promises as fs, createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { basename, dirname, extname, join, resolve } from "node:path";
import { CONFIG, CONFIG_FILE, ROOT, contextConfig, hookConfig, lanAddresses, piChildEnv, writeConfigFile } from "./config.mjs";
import { AgentManager } from "./agents.mjs";
import { handleAgentRoutes } from "./agent-routes.mjs";
import * as graph from "./graph.mjs";
import { Bus } from "./bus.mjs";
import { wireEvent } from "./wire.mjs";
import { OpencodeServer, guardOpencodeExit } from "./opencode-server.mjs";
import { OpencodeRpc, allowTools, findModel, inCatalog, modelPick, modelThinking, pickerModels, runOnce } from "./opencode-rpc.mjs";
import { omniShim, writeOpencodeConfig } from "./opencode-config.mjs";
import { opencodeAuthFile, watchAuthStore } from "./auth-watch.mjs";
import { GoalKeeper, JUDGE_SYSTEM, SUMMARY_SYSTEM } from "./hook.mjs";
import { ClaudeRunner } from "./claude-runner.mjs";
import { planContinue } from "./continue.mjs";
import { filterPiModels } from "./pi-models.mjs";
import { listMcpServers, upsertMcpServer, removeMcpServer, testMcpServer } from "./mcp.mjs";
import { PRESETS, readModelsFile, listProviders, saveCustomProvider, removeProvider, reorderProviders, customProviderConfig, migratePiProviders, migrationMarker, modelEntry } from "./providers.mjs";
import { THINKING_LEVELS, clampThinking, thinkingProfile } from "../ui/thinking.js";
import * as files from "./files.mjs";
import { SessionRegistry, SessionWatcher, titleFrom } from "./watchers.mjs";
import { AGENT_ACTIVE as AGENT_RUNNING, applyStatus } from "../ui/lib.js";
import { openUiBuild } from "./ui-build.mjs";
import { serveWebFile } from "../hub/static.mjs";
import { Vault } from "./memory.mjs";
import { createTally, estimateTokens } from "./tokens.mjs";
import { createServer as createNetServer } from "node:net";
import { Approvals, COOKIE, DEVICE_COOKIE, RemoteAuth, WindowGate, channelAllowed, classify, clientIp, describe, inAccountFolder, isHostRequest, parseCookies, parseProxyLine, redact, requestTouchesAccountFolder } from "./access.mjs";
import { Account, AccountError, handleAccountRoutes } from "./account.mjs";
import { MachineLinks, proxyToMachine } from "./channel-client.mjs";
import { serveChannel } from "./channel-host.mjs";
import { httpsRedirect, loadOrCreateCert } from "./tls.mjs";
import { SshTunnel } from "./tunnel.mjs";
import { ProjectStore } from "./projects.mjs";
import { MissionManager } from "./missions.mjs";
import { handleMissionRoutes } from "./mission-routes.mjs";
import { handleMcp } from "./omni-mcp-http.mjs";
import { KGraph } from "./kgraph.mjs";
import { importGhidraJsonl, importGraphify } from "./kgraph-import.mjs";

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

export async function createApp(overrides = {}) {
  const cfg = { ...CONFIG, ...overrides };
  // Under `node --test`, Omni's own state files never default to the real ~/.omni-agent, the real
  // ~/.pi/agent/models.json is never read, and no real `opencode serve` is started (a test passes
  // cfg.opencodeServer): a test that wants them passes its own paths.
  // node --test sets NODE_TEST_CONTEXT only with per-file isolation; also catch --test-isolation=none and a test file run directly.
  const underTest = !!process.env.NODE_TEST_CONTEXT || process.execArgv.includes("--test") || /\.test\.m?js$/i.test(process.argv[1] || "");
  if (underTest) {
    const tmp = mkdtempSync(join(tmpdir(), "omni-state-"));
    for (const k of ["agentsFile", "goalsFile", "opencodeProvidersFile"]) if (!(k in overrides)) cfg[k] = join(tmp, `${k}.json`);
    if (!("agentsDir" in overrides)) cfg.agentsDir = join(tmp, "agents");
    // Nor is the real ~/.pi/agent/models.json (and its keys) copied into a test's provider store.
    if (!("piModelsFile" in overrides)) cfg.migratePiProviders = false;
    if (!("persistContext" in overrides)) cfg.persistContext = false;
    for (const k of ["opencodeConfigDir", "statusSessionsDir", "projectsDir", "accountDir"]) if (!(k in overrides)) cfg[k] = join(tmp, k);
    // Nor the real certificate (a renewal would change the fingerprint phones trust) or the real remote port:
    // a test that wants the LAN listener says so.
    if (!("tlsDir" in overrides)) cfg.tlsDir = join(tmp, "tls");
    if (!("lan" in overrides)) cfg.lan = false;
  }
  cfg.opencodeMirrorDir ||= join(cfg.piSessionsDir, "opencode");
  // Another Omni on another port (headless.mjs, a scratch instance) keeps its own registry and goals: each server
  // rewrites those files whole from its own memory, so sharing them lets the last one to exit erase the other's.
  if (cfg.port && cfg.port !== CONFIG.port) {
    for (const k of ["agentsFile", "goalsFile"]) if (!(k in overrides)) cfg[k] = String(cfg[k]).replace(/\.json$/, `-${cfg.port}.json`);
    if (!("agentsDir" in overrides)) cfg.agentsDir = `${cfg.agentsDir}-${cfg.port}`;
    // One device holds one hub connection: a second one on the same keys would push the desktop's off.
    if (!("accountDir" in overrides)) cfg.accountDir = `${cfg.accountDir}-${cfg.port}`;
  }
  // Read once and taken out of the environment: everything this server starts, agents included, inherits that.
  const windowGate = new WindowGate(cfg.windowToken ?? process.env.OMNI_WINDOW_TOKEN);
  delete process.env.OMNI_WINDOW_TOKEN;
  const accountDirs = [...new Set([cfg.accountDir, CONFIG.accountDir])];
  const accountStreams = new Set();
  let account = null;
  let machineLinks = null;
  try {
    account = new Account({ dir: cfg.accountDir, hubUrl: cfg.accountHub, log: (t) => log(t), ...cfg.accountOptions });
    account.on("channel", (channel) => serveChannel(channel, handle, { device: channel.peer, audit: (entry) => account.audit(entry) }));
    machineLinks = new MachineLinks({ account, ...cfg.machineLinks });
  } catch (e) { log(`account off: ${e.message}`); }
  const bus = new Bus();
  const tally = createTally();
  const registry = new SessionRegistry();
  const vault = new Vault(cfg.vaultDir).ensure();
  const claude = new ClaudeRunner({ bin: cfg.claudeBin, bus, spawn: cfg.claudeSpawn });
  const auth = cfg.remoteAuth || new RemoteAuth({ file: cfg.remoteAuthFile, sessionTtlMs: (cfg.remoteSessionDays || 7) * 86_400_000 });
  const approvals = new Approvals({ timeoutMs: (cfg.remoteApprovalTimeoutSec || 300) * 1000 });
  /** The remote listener, once it listens: { server, port, tls: { fingerprint, selfSigned } | null, error }. */
  const remote = { server: null, front: null, port: null, tls: null, error: null };
  /** The VPS relay's loopback listener: { server, front, port, fingerprint, selfSigned, error }. */
  const relay = { server: null, front: null, port: null, fingerprint: null, selfSigned: false, error: null };
  let tunnel = null;
  /** Host browsers' event streams: only they hear about pending approvals. */
  const hostStreams = new Set();
  approvals.on("change", (list) => { const line = `event: approvals\ndata: ${JSON.stringify(list)}\n\n`; for (const res of hostStreams) { try { res.write(line); } catch { hostStreams.delete(res); } } });
  /**
   * Omni's own pi children, one per chat that runs at once: a busy chat never blocks another (each child can
   * start background agents of its own). `pi` is the one used last; routes without a `sid` talk to it.
   */
  const pis = new Set();
  let pi = null;
  const sameDir = (a, b) => String(a || "").toLowerCase() === String(b || "").toLowerCase();
  /** The child that has chat `sid` open right now, else null. */
  const piFor = (sid) => { if (!sid) return null; for (const c of pis) if (c.proc && c.sid === sid) return c; return null; };
  // The durable run ledger. Null in normal GUI use; the unattended runner (scripts/run.mjs) opens one
  // via cfg so the goal + counters persist and survive a pi restart. Every use is guarded with `?.`.
  let runLedger = cfg.runLedger || null;
  /** Background agents the agents start (pi subagents, Claude Code sessions, shell jobs); created after the keeper. */
  let agents = null;

  // ---------------------------------------------------------------- opencode
  /**
   * The one `opencode serve` every chat, background agent and side call shares. It is only spawned by the first
   * chat (or a route that needs its catalog); `cfg.opencodeServer` injects one (tests). Under `node --test` without
   * one, nothing real is ever started.
   */
  const opencode = cfg.opencodeServer || new OpencodeServer({
    bin: cfg.opencodeBin, configDir: cfg.opencodeConfigDir, env: piChildEnv(cfg),
    log: (level, text) => {
      const t = String(text ?? "").trim();
      if (!t || level === "stdout" || level === "raw") return;
      log(`opencode ${level}:`, t.slice(0, 500));
      if (level === "system") bus.emit({ sid: "omni", harness: "omni", kind: "log", ts: Date.now(), level: "system", text: `OpenCode: ${t}` });
    },
  });
  const noRealOpencode = underTest && !cfg.opencodeServer && !("opencodeBin" in overrides);
  /**
   * The process whose exit (and unhandled terminating signals) must take Omni's own `opencode serve` along, whatever
   * entry point runs this app: the real process for a server Omni spawns (never under node --test); a test passes
   * its own stand-in as `cfg.exitGuardProcess`.
   */
  const exitGuardProc = cfg.exitGuardProcess || (cfg.opencodeServer || underTest ? null : process);
  let exitGuard = null;
  let opencodeStart = null;
  /** The server was asked for (a chat, an agent, a side call): a config change may start it again after a failed start. */
  let opencodeWanted = false;
  /** Starts the shared server once (its config written first); a failed start is tried again by the next call. */
  function ensureOpencode() {
    if (opencodeStart) return opencodeStart;
    if (noRealOpencode) return Promise.reject(new Error("no opencode server under node --test (pass cfg.opencodeServer)"));
    opencodeWanted = true;
    if (exitGuardProc && !exitGuard) exitGuard = guardOpencodeExit(opencode, { proc: exitGuardProc });
    opencodeStart = (async () => {
      writeConfig();
      await opencode.start();
      checkPlugin();
      await migrateProviders();
      checkSavedModel().catch((e) => log("could not check the saved model against opencode's catalog", e.message));
      return opencode;
    })();
    opencodeStart.catch((e) => {
      opencodeStart = null;
      log("opencode could not start:", e.message);
      bus.emit({ sid: "omni", harness: "omni", kind: "log", ts: Date.now(), level: "system", text: `OpenCode could not start: ${e.message}` });
    });
    return opencodeStart;
  }
  /** The server, started and connected. */
  async function opencodeUp() {
    await ensureOpencode();
    if (!opencode.up) await opencode.waitUp();
    return opencode;
  }
  const readJson = (file) => { try { return JSON.parse(readFileSync(file, "utf8")) || {}; } catch { return {}; } };
  /**
   * opencode.json from Omni's MCP list and omnidroid's omni-mcp (both in omni-agent.json, cfg.piExtConfigFile, where
   * the MCP dialog and the installer write them) and Omni's custom providers (cfg.opencodeProvidersFile), plus the shim
   * that loads Omni's plugin (integrations/opencode/omni-plugin.mjs) into OpenCode.
   */
  function writeConfig() {
    const ext = readJson(cfg.piExtConfigFile);
    try { writeOpencodeConfig({ dir: cfg.opencodeConfigDir, mcpServers: ext.mcpServers, omniMcp: ext.omniMcp, providers: customProviderConfig(cfg.opencodeProvidersFile), shim: omniShim(ROOT) }); }
    catch (e) { log("could not write the opencode config", e.message); }
  }
  const systemLog = (text) => { log(text); bus.emit({ sid: "omni", harness: "omni", kind: "log", ts: Date.now(), level: "system", text }); };
  /**
   * Omni's plugin (integrations/opencode/omni-plugin.mjs, loaded through the shim in the config dir) gives OpenCode the
   * `plan` tool the goal hook tracks: after a start or a config reload, a server without it is reported (never blocking).
   */
  function checkPlugin() {
    const dir = [...pis].find((c) => c.cwd)?.cwd || cfg.cwd;
    return opencode.request("GET", "/experimental/tool/ids", { directory: dir }).then((ids) => {
      if (Array.isArray(ids) && ids.includes("plan")) return;
      systemLog(`Omni's OpenCode plugin did not load (no plan tool) — the goal hook cannot track plans; check ${join(cfg.opencodeConfigDir, "plugin")} and OpenCode's log`);
    }, (e) => log("could not list opencode's tools:", e.message));
  }
  /**
   * The first start copies pi's custom providers (pi's models.json) into Omni's store once, so a BYOK setup carries
   * over. A name OpenCode already has (built in, or in the user's global config) is skipped, and each skip is logged.
   * Runs on the started server (its catalog says what OpenCode has); copied providers → config rewritten and reloaded.
   */
  async function migrateProviders() {
    if (cfg.migratePiProviders === false || existsSync(migrationMarker(cfg.opencodeProvidersFile))) return;
    try {
      const catalog = await opencode.request("GET", "/provider", { directory: cfg.cwd });
      const r = migratePiProviders({ from: cfg.piModelsFile, to: cfg.opencodeProvidersFile, catalog });
      if (!r) return;
      if (r.error) { systemLog(`Providers: pi's models.json was not copied into OpenCode (tried again at the next start): ${r.error}`); return; }
      for (const line of r.lines) systemLog(line);
      if (r.copied.length || r.extended.length) { writeConfig(); await disposeOpencode(); }
    } catch (e) { log("could not copy pi's providers:", e.message); }
  }
  let catalogCache = null, catalogRefresh = null;
  /** OpenCode's `GET /provider` catalog, cached a minute (`fresh` re-reads it); starts the server when needed. */
  async function catalog(fresh = false) {
    if (!fresh && catalogCache && Date.now() - catalogCache.at < 60000) return catalogCache.value;
    const server = await opencodeUp();
    const value = await server.request("GET", "/provider", { directory: cfg.cwd });
    catalogCache = { at: Date.now(), value };
    return value;
  }
  /** For the picker, which a page asks at every load: what is known, at once, and past its minute a fresh look behind the scenes. A change of providers clears it. */
  function pickerCatalog() {
    if (!catalogCache) return catalog(true);
    if (Date.now() - catalogCache.at >= 60000 && !catalogRefresh) catalogRefresh = catalog(true).catch(() => null).finally(() => { catalogRefresh = null; });
    return catalogCache.value;
  }
  /** provider/id in the catalog while the server runs (this never starts it), else null. */
  async function knownModel(provider, id) {
    if (!opencode.up || !id) return null;
    return findModel(await catalog().catch(() => null), provider, id);
  }
  /**
   * The saved pick must be one OpenCode can run: without a model OpenCode would fall back to the user's own global
   * default. A pick no connected provider offers is reported once (the config is left as it is).
   */
  let warnedPick = "";
  async function checkSavedModel() {
    const p = modelPick(cfg.piProvider, cfg.piModel);
    if (!p) return;
    const key = `${p.providerID}/${p.modelID}`;
    if (warnedPick === key || inCatalog(await catalog(true), p.providerID, p.modelID)) return;
    warnedPick = key;
    const text = `The saved model ${key} is not available in OpenCode (no connected provider offers it): pick another model in the model picker.`;
    log(text);
    bus.emit({ sid: "omni", harness: "omni", kind: "log", ts: Date.now(), level: "system", text });
  }
  /** A chat (or background agent) whose turn is running or about to: OpenCode's reload would cut it short. */
  const opencodeBusy = () => [...pis].some((c) => c.streaming || c.inFlight > 0)
    || (agents?.list({ active: true }) || []).some((a) => { const c = a.kind === "pi" && agents.piFor(a.sid); return !!c && (c.streaming || c.inFlight > 0); });
  let reloadPending = false;
  async function disposeOpencode() {
    reloadPending = false;
    catalogCache = null;
    for (const c of pis) if ("catalog" in c) c.catalog = null;
    const ok = await opencode.request("POST", "/global/dispose").then(() => true, (e) => { log("opencode reload failed", e.message); return false; });
    if (ok) checkPlugin();
  }
  /**
   * Omni's MCP servers or providers changed: rewrite opencode.json and let OpenCode re-read it (its instances are
   * disposed; sessions persist and every chat keeps its own). A reload would cut a running turn short, so while any
   * chat works it waits for the moment none does.
   */
  async function reloadOpencode() {
    writeConfig();
    if (!opencode.up) {
      // Its first start failed (a bad config, say): the fixed config is worth another start. A server that is only
      // relaunching after a crash reads the new config by itself; one nobody asked for yet reads it at its start.
      if (!opencodeWanted || opencodeStart) return { restarted: false, pending: false };
      ensureOpencode().catch(() => {});
      return { restarted: true, pending: false };
    }
    if (opencodeBusy()) { reloadPending = true; return { restarted: false, pending: true }; }
    await disposeOpencode();
    return { restarted: true, pending: false };
  }
  // A login made outside Omni (`opencode auth login`, OpenCode's /connect) reaches the running server only with a
  // reload: until then it answers "Model not found" for the new provider's models. Under node --test only a given file.
  const authFile = cfg.opencodeAuthFile || (underTest ? "" : opencodeAuthFile({ ...process.env, ...piChildEnv(cfg) }));
  const authWatch = authFile ? watchAuthStore(authFile, () => {
    if (!opencode.up) return; // a server that is not running reads the store when it starts
    log("OpenCode's logins changed: reloading OpenCode");
    reloadOpencode().catch((e) => log("opencode reload failed", e.message));
  }, cfg.opencodeAuthWatch) : null;

  // ---------------------------------------------------------------- side calls (judge, status box)
  /** Status-box conversation id (one per goal) → `{id, at}` of its OpenCode session, kept across Omni restarts. */
  let statusSessions = null;
  const statusFile = () => join(cfg.statusSessionsDir, "opencode-sessions.json");
  function statusSessionMap() {
    if (!statusSessions) statusSessions = new Map(Object.entries(readJson(statusFile())).filter(([, v]) => v?.id));
    return statusSessions;
  }
  function saveStatusSessions() {
    const keep = [...statusSessionMap().entries()].sort((a, b) => (b[1].at || 0) - (a[1].at || 0)).slice(0, 200);
    try { mkdirSync(cfg.statusSessionsDir, { recursive: true }); writeFileSync(statusFile(), `${JSON.stringify(Object.fromEntries(keep), null, 2)}\n`); }
    catch (e) { log("could not save the status-box sessions", e.message); }
  }
  /**
   * A model call outside every chat (the opt-in judge, the status box) on the shared server, in its own directory:
   * `pick` is the hook's model, else the saved chat model. A `conversation` (the status box of one goal) keeps one
   * OpenCode session; a call without one gets a throw-away session.
   */
  async function sideCall(system, input, pick, conversation = null) {
    const server = await opencodeUp();
    const use = pick?.model ? pick : { provider: cfg.piProvider, model: cfg.piModel };
    const cwd = cfg.statusSessionsDir;
    mkdirSync(cwd, { recursive: true });
    const o = { server, provider: use.provider || "", model: use.model || "", system, input, cwd, timeoutMs: keeper.config.judgeTimeoutMs };
    if (!conversation) return runOnce(o);
    const map = statusSessionMap();
    for (let attempt = 0; ; attempt++) {
      let s = map.get(conversation);
      if (!s) {
        s = { id: (await server.request("POST", "/session", { directory: cwd, body: { title: "Omni status box" } })).id, at: Date.now() };
        map.set(conversation, s);
        saveStatusSessions();
      }
      try { return await runOnce({ ...o, session: s.id }); }
      catch (e) { if (e.status !== 404 || attempt) throw e; map.delete(conversation); } // its session is gone: open another
    }
  }

  const piOwns = (file) => [...pis].some((c) => c.owns?.(file));
  const isOwned = (file) => piOwns(file) || claude.owns(file) || (agents?.owns(file) ?? false);
  const watcher = new SessionWatcher({ piSessionsDir: cfg.piSessionsDir, claudeProjectsDir: cfg.claudeProjectsDir, bus, tally, registry, isOwned, recentHours: cfg.tailRecentHours, log });
  // A thin proxy so the keeper always reads the *current* runLedger (which may be set/replaced later).
  const ledgerProxy = { writeControl: (p) => runLedger?.writeControl(p), goalText: () => runLedger?.goalText() || "" };
  // Goal hook: re-engages a chat while its plan (the `plan` tool) has unfinished steps — no model decides that.
  const keeper = new GoalKeeper({
    bus, log,
    // Background agents are chats of their own (an OpencodeRpc each): the keeper watches and re-engages them too.
    getPi: (sid) => piFor(sid) || agents?.piFor(sid) || null,
    contextPolicy: cfg.context,
    maxTokensFor: (sid) => Number(keeper.getPi(sid)?.state?.model?.maxTokens) || 0,
    // Only agents count: a long-lived shell job (a dev server, logcat) must not hold every recovery back until it exits.
    activeChildren: (sid) => agents?.activeChildren(sid, { kinds: ["pi", "claude"] }) || 0,
    // Opt-in only (hook.judgeFallback): a judge model for work the agent did without a plan.
    judge: cfg.judge || ((input, pick) => sideCall(JUDGE_SYSTEM, input, pick)),
    // The status box: a side conversation of its own per goal (an OpenCode session of its own), chat model by default.
    summarize: cfg.summarize || ((input, pick) => sideCall(SUMMARY_SYSTEM, input, pick, pick?.conversation || null)),
    config: hookConfig(cfg.hook),
    ledger: ledgerProxy,
    onEscalate: async (sid, g) => { runLedger?.appendEvent?.({ kind: "escalate", sid, nudges: g.nudges, fingerprint: g.lastFingerprint }); },
  });

  /** The chat's model: its pi child's live one when it runs, else the saved pick the next pi starts with. */
  function currentModel(c = pi) {
    const m = c?.proc ? c.state?.model : null;
    if (m?.id) return { provider: m.provider, id: m.id };
    return cfg.piModel ? { provider: cfg.piProvider || "", id: cfg.piModel } : null;
  }
  /**
   * The thinking levels provider/id has: its OpenCode variants (what a prompt can send) when the running server's
   * catalog has it, else a guess from its models.json entry or its name (ui/thinking.js).
   */
  async function thinkingOf(provider, id, live = null) {
    const m = await knownModel(provider, id);
    if (m) return modelThinking(m);
    const t = thinkingProfile(modelEntry(cfg.piModelsFile, provider, id) || (live?.id === id ? { ...live, provider } : { provider, id }));
    return { levels: t.levels, labels: t.labels, family: t.family };
  }
  const levelsOf = async (provider, id) => (await thinkingOf(provider, id)).levels;

  agents = cfg.agentManager || new AgentManager({
    bus, config: cfg.agents, file: cfg.agentsFile, dir: cfg.agentsDir, personasDir: cfg.personasDir,
    claude, keeper, shellPath: cfg.agentShell || "", cwd: cfg.cwd, log, omniUrl: `http://127.0.0.1:${cfg.port}`,
    // A Claude agent asked for memory gets the vault pack (and repo graph) the old /api/claude/task gave it.
    composeSystem: async (rec, text) => (await composePrompt("claude", text, { memory: rec.memory, graph: rec.graph, dir: rec.cwd })).system,
    // A pi agent is a chat of its own on the shared server: its persona goes with each prompt (system + tool allowlist).
    // Its OMNI_AGENT_* env cannot reach a shared server; the plugin derives an agent's identity server-side (Task 6).
    createPi: cfg.createAgentPi || ((o) => {
      const child = new OpencodeRpc({ server: opencode, ensureServer: ensureOpencode, bus, cwd: o.cwd, provider: o.model ? o.provider : cfg.piProvider, model: o.model || cfg.piModel, thinking: o.thinking || cfg.piThinking, system: o.system || "", tools: allowTools(o.tools), meta: o.meta, mirrorDir: cfg.opencodeMirrorDir, compactAt: cfg.context?.compactAt });
      child.startWatchdog({ stallMs: cfg.stallMs, toolStallMs: cfg.toolStallMs });
      return child;
    }),
  });

  // Missions: an orchestrator chat (orchestrator tools only, never raw tool output) per mission, workers as background agents.
  const projects = new ProjectStore({ root: cfg.projectsDir });
  const missions = cfg.missionManager || new MissionManager({
    bus, store: projects, agents, config: cfg.missions, log,
    createOrchestrator: cfg.createOrchestrator || ((o) => {
      // compactAt 0: the orchestrator is never compacted by Omni; past its rebirth point a fresh orchestrator continues from the ledger.
      const c = new OpencodeRpc({ server: opencode, ensureServer: ensureOpencode, bus, cwd: o.cwd, provider: o.provider, model: o.model, thinking: cfg.piThinking, system: o.system, tools: allowTools(o.tools), meta: o.meta, mirrorDir: cfg.opencodeMirrorDir, compactAt: 0 });
      c.startWatchdog({ stallMs: cfg.stallMs, toolStallMs: cfg.toolStallMs });
      return c;
    }),
  });

  // What the mission tools reach beyond the mission itself: the project's own vault (and, later, its knowledge graph).
  const projectVaults = new Map(), projectGraphs = new Map();
  const kgOf = (m) => {
    const file = join(missions.projectOf(m).graphDir, "kg.sqlite");
    if (!projectGraphs.has(file)) projectGraphs.set(file, KGraph.open(file).catch((e) => { projectGraphs.delete(file); log("kg: could not open", file, e.message); return null; }));
    return projectGraphs.get(file);
  };
  const missionDeps = {
    memory: (m) => { const dir = missions.projectOf(m).memoryDir; if (!projectVaults.has(dir)) projectVaults.set(dir, new Vault(dir).ensure()); return projectVaults.get(dir); },
    kg: kgOf,
    kgLoad: async (m, file, binary) => {
      if (!file || !existsSync(file)) throw Object.assign(new Error(`no export file ${file}`), { status: 400 });
      const kg = await kgOf(m);
      const r = await importGhidraJsonl(kg, file, { binary, by: "ghidra" });
      missions.ledger(m, `knowledge graph: loaded ${r.nodes} nodes / ${r.edges} edges from Ghidra (${binary || file})`);
      return r;
    },
    kgImport: async (m, { source, path, callerSid, by }) => {
      const p = missions.projectOf(m);
      const kg = await kgOf(m);
      if (!kg) return { text: "The knowledge graph could not be opened (node:sqlite needs Node 22.13 or newer).", meta: { error: true } };
      if (source === "graphify") {
        const dir = path || m.dir;
        if (!existsSync(dir)) return { text: `No such directory: ${dir}`, meta: { error: true } };
        const r = await importGraphify(kg, dir, { graphDir: p.graphDir, bin: cfg.graphifyBin, by });
        missions.ledger(m, `knowledge graph: imported ${r.nodes} nodes / ${r.edges} edges from graphify (${dir})`);
        return { text: `Imported ${r.nodes} source nodes and ${r.edges} relations from ${dir}${r.built ? " (graph built and kept in the project's graph folder, not in the repo)" : ""}. Query them with kg_search / kg_node (ids start with src:).`, meta: r };
      }
      if (source === "ghidra") {
        if (!path || !existsSync(path)) return { text: `Give the binary to analyse as path (not found: ${path || "none"}).`, meta: { error: true } };
        const name = basename(path);
        const out = join(p.graphDir, "imports", "ghidra", `${name}-${Date.now()}.jsonl`);
        mkdirSync(dirname(out), { recursive: true });
        const projectDir = join(cfg.ghidraProjectsDir, p.slug);
        mkdirSync(projectDir, { recursive: true });
        // No path is ever part of the command text (a binary may be named anything): the launcher reads them from its env.
        const env = { OMNI_GHIDRA: cfg.ghidraHeadless, OMNI_GHIDRA_PROJECT: projectDir, OMNI_GHIDRA_NAME: name.replace(/[^\w.-]+/g, "_"), OMNI_GHIDRA_BIN: resolve(path), OMNI_GHIDRA_OUT: out, OMNI_GHIDRA_SCRIPTS: join(ROOT, "integrations", "ghidra"), OMNI_URL: `http://127.0.0.1:${cfg.port}`, OMNI_MISSION: m.id, OMNI_BIN_NAME: name };
        const command = `node '${join(ROOT, "scripts", "ghidra-import.mjs").replace(/\\/g, "/").replace(/'/g, "'\\''")}'`;
        const job = agents.start({ kind: "shell", command, env, cwd: m.dir, parentSid: callerSid, title: `Ghidra → knowledge graph: ${name}`, timeoutMinutes: 24 * 60 });
        missions.ledger(m, `knowledge graph: Ghidra import of ${name} started as job ${job.id}`);
        return { text: `Ghidra is analysing ${name} as background job ${job.id} (large binaries take a long time). When it ends, the functions, calls, strings, imports and exports are loaded into the graph automatically (the log ends with "KG LOADED"). job_wait {id: "${job.id}", until: "KG LOADED|ERROR"} to wait; meanwhile keep working.`, meta: { job: job.id } };
      }
      return { text: 'source must be "graphify" or "ghidra".', meta: { error: true } };
    },
  };

  /** Explicit goals survive an Omni restart (cfg.goalsFile): the goal, its chat's session file and cwd. */
  function saveGoals() {
    // An unattended run (scripts/run.mjs) keeps its goal in its own ledger; it must never be reopened by the GUI.
    if (cfg.runLedger) return;
    // savedAt = the chat's last activity (not the save time), so re-saving on every shutdown never makes a stale goal look live.
    const mine = keeper.exportGoals().filter((d) => !d.managed).map((d) => ({ ...d, hookEnabled: !!keeper.config.enabled, savedAt: registry.get(d.sid)?.lastActivity || d.startedAt || Date.now(), file: registry.get(d.sid)?.file || piFor(d.sid)?.state?.sessionFile || "", cwd: registry.get(d.sid)?.cwd || piFor(d.sid)?.cwd || pi?.cwd || cfg.cwd }));
    // Saved goals this process never loaded (a stopped one, an older one) are kept for a week, not erased by this save.
    const kept = loadGoals().filter((x) => x?.sid && !keeper.goal(x.sid) && !mine.some((d) => d.sid === x.sid || (d.file && d.file === x.file)) && Date.now() - (x.savedAt || 0) < 7 * 86400000);
    const goals = [...mine, ...kept];
    try {
      mkdirSync(dirname(cfg.goalsFile), { recursive: true });
      const tmp = `${cfg.goalsFile}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ goals }, null, 2)}\n`);
      renameSync(tmp, cfg.goalsFile);
    } catch (e) { log("could not save goals", e.message); }
  }
  function loadGoals() { try { return JSON.parse(readFileSync(cfg.goalsFile, "utf8")).goals || []; } catch { return []; } }
  bus.on("event", (ev) => { if (ev.kind === "goal" || (ev.kind === "plan" && keeper.goal(ev.sid)?.explicit)) saveGoals(); });

  // Owned sessions also need registry + tally bookkeeping from their live events.
  bus.on("event", (ev) => {
    if (ev.kind === "log" || ev.kind === "removed" || ev.kind === "agent" || ev.kind === "pis" || ev.kind === "mission" || ev.kind === "mission-removed" || ev.kind === "notify") return;
    const s = registry.upsert(ev.sid, {});
    if (ev.kind === "session") registry.upsert(ev.sid, { cwd: ev.cwd, title: ev.title, model: ev.model, file: ev.file, owned: ev.owned, streaming: ev.streaming, forkedFrom: ev.forkedFrom, ...(ev.parentSid ? { parentSid: ev.parentSid, agentId: ev.agentId, agentKind: ev.agentKind } : {}), ...(ev.missionId ? { missionId: ev.missionId, missionRole: ev.missionRole } : {}) });
    // Invariant: run.json.sessionFile always names pi's current session file, and the child's resumeFile mirrors it.
    // Gated on !restoring so the transient empty session a fresh child opens during a crash restart
    // cannot clobber the resume anchor before resumeSession() reads it (C1).
    // A background pi agent announces an owned session too; it must never become the main chat's resume anchor.
    if (ev.kind === "session" && ev.owned && ev.harness === "pi" && !ev.agentId && !ev.missionId) {
      const c = piFor(ev.sid);
      if (ev.file && !c?.restoring) {
        if (c) c.resumeFile = ev.file;
        if (!c || c === pi) runLedger?.writeControl({ sessionFile: ev.file });
      }
      announcePis();
    }
    if (ev.kind === "status") applyStatus(s, ev);
    // OpenCode's config changed while a chat was working: it is reloaded once no chat works any more.
    if (ev.kind === "status" && ev.streaming === false && reloadPending) {
      setTimeout(() => { if (reloadPending && opencode.up && !opencodeBusy()) disposeOpencode(); }, 0);
    }
    // A background agent's report is delivered once it is IN the parent chat (pi only queues it while the chat is busy,
    // and that queue is lost on Stop or a crash) — the extension acks on message_end too; this is the backstop.
    if (ev.kind === "msg" && ev.role === "system") {
      const t = ev.blocks?.[0]?.text || "";
      const m = t.startsWith("[omni-agent-result]") ? /\ba-[0-9a-f]{8}\b/.exec(t) : null;
      if (m) agents?.markDelivered(m[0]);
    }
    if (ev.kind === "msg" && ev.live) {
      s.messages++;
      if (ev.usage) tally.add(ev.sid, { groupId: ev.groupId || ev.id, usage: ev.usage, model: ev.model, cost: ev.cost, ts: ev.ts });
      if (ev.role === "user" && !s.title) s.title = titleFrom(ev.blocks?.find((b) => b.type === "text")?.text || "");
    }
    if (ev.kind !== "session") s.lastActivity = Math.max(s.lastActivity || 0, ev.ts || 0);
    if (!s.startedAt && ev.ts) s.startedAt = ev.ts;
    if (ev.kind === "msg" || ev.kind === "run") watcher.dirty.set(ev.sid, Date.now());
  });

  /**
   * Starts another chat in `cwd` (the ones already running keep going): an OpencodeRpc on the shared server, with the
   * saved model pick (always one: without it OpenCode would use the user's own global default). It becomes the
   * current one unless `current` is false.
   */
  function startPi(cwd = cfg.cwd, { current = true } = {}) {
    let c;
    if (cfg.createPi) c = cfg.createPi({ cwd, bus, model: cfg.piModel, provider: cfg.piProvider, thinking: cfg.piThinking });
    // The chat starts the shared server itself whenever it needs it and it is not running (ensureServer): its first
    // session, and every prompt after a failed start.
    else c = new OpencodeRpc({ server: opencode, ensureServer: ensureOpencode, cwd, model: cfg.piModel, provider: cfg.piProvider, thinking: cfg.piThinking, bus, mirrorDir: cfg.opencodeMirrorDir, compactAt: cfg.context?.compactAt });
    // A new child is claimed for the chat it is started for: no other chat takes it before its first prompt.
    c.lastUsedAt = c.claimedAt = Date.now();
    // The auto-restart path re-attaches the goal: crashedSid is this child's sid before the crash, c.sid the resumed one (C1).
    // The killed run never reported a settle of its own, so the heartbeat re-checks the goal instead of relying on one.
    c.onRestart = async () => { keeper.attachToSid(c.crashedSid || c.sid, c.sid); c.crashedSid = null; const g = keeper.goal(c.sid); if (g && !g.done && !g.paused) g.recheck = true; };
    pis.add(c);
    if (current || !pi) pi = c;
    c.start();
    c.startWatchdog?.({ stallMs: cfg.stallMs, toolStallMs: cfg.toolStallMs });
    announcePis();
    return c;
  }
  const lastUsed = (c) => Math.max(c.lastUsedAt || 0, c.lastEventAt || 0);
  function stopPi(c) {
    if (!c) return;
    c.stop();
    pis.delete(c);
    if (pi === c) pi = [...pis].sort((a, b) => lastUsed(b) - lastUsed(a))[0] || null;
    announcePis();
  }
  /** How long a child handed to a chat stays reserved for it before that chat's first prompt reaches it. */
  const CLAIM_MS = 60000;
  /**
   * A child no chat needs right now, so another chat may open in it: not working or about to (a prompt in flight, just
   * claimed), no unfinished goal (the keeper re-engages it), no background agent of its chat still running (their
   * reports are delivered into that chat).
   */
  function piFree(c, now = Date.now()) {
    if (!c?.proc || c.streaming || c.restoring || c.inFlight > 0) return false;
    if (c.claimedAt && now - c.claimedAt < CLAIM_MS) return false;
    const g = keeper.goal(c.sid);
    if (g && !g.done && !g.paused) return false;
    return !((agents?.activeChildren(c.sid, { kinds: ["pi", "claude"] }) || 0) > 0);
  }
  /** A child to open a chat in, in `cwd`: a free one already there (the current one first), else a new one. */
  async function acquirePi(cwd) {
    const free = [...pis].filter((c) => sameDir(c.cwd, cwd) && piFree(c)).sort((a, b) => (b === pi) - (a === pi) || lastUsed(b) - lastUsed(a))[0];
    if (free) { free.lastUsedAt = free.claimedAt = Date.now(); pi = free; return { child: free, fresh: false }; }
    const c = startPi(cwd);
    await c.waitReady();
    return { child: c, fresh: true };
  }
  /** A message is going to this child's chat now: it is the current one, and no longer just claimed. */
  function usePi(c) { c.lastUsedAt = Date.now(); c.claimedAt = 0; pi = c; return c; }
  /** Every live child, for /api/state and the `pis` event: which chats a message goes straight to. */
  const piList = () => [...pis].filter((c) => c.proc).map((c) => ({ sid: c.sid, cwd: c.cwd, streaming: !!c.streaming, current: c === pi, model: c.state?.model?.id ? { provider: c.state.model.provider, id: c.state.model.id } : null, thinkingLevel: c.state?.thinkingLevel || "" }));
  let pisTimer = null;
  function announcePis() {
    if (pisTimer) return;
    pisTimer = setTimeout(() => { pisTimer = null; bus.emit({ sid: "omni", harness: "omni", kind: "pis", ts: Date.now(), pis: piList() }); }, 0);
  }
  /**
   * Free children past a few spares are closed (each runs its own extensions and MCP servers), and any free one
   * idle for long; the current one stays. A chat whose child was closed starts one again with its next message.
   */
  function trimPis(now = Date.now()) {
    const spare = cfg.piSpareChildren ?? 2, idleMs = (cfg.piIdleMinutes ?? 30) * 60000;
    const free = [...pis].filter((c) => c !== pi && piFree(c, now)).sort((a, b) => lastUsed(b) - lastUsed(a));
    free.forEach((c, i) => { const idle = now - lastUsed(c); if ((i >= spare && idle > 60000) || idle > idleMs) stopPi(c); });
  }
  const trimTimer = setInterval(() => trimPis(), 60000);
  trimTimer.unref?.();

  // ---------------------------------------------------------------- digests
  const digestTimer = setInterval(async () => {
    const now = Date.now();
    for (const [sid, at] of [...watcher.dirty]) {
      const s = registry.get(sid);
      if (now - at < cfg.digestIdleSec * 1000) continue;
      if (s?.streaming && now - at < cfg.digestIdleSec * 4000) continue;
      watcher.dirty.delete(sid);
      try {
        const d = await watcher.digestData(sid);
        if (d && d.prompts.length) {
          const out = await vault.writeSessionDigest(d);
          bus.emit({ sid, harness: s?.harness, kind: "digest", ts: Date.now(), path: out.path });
        }
      } catch (e) { log("digest failed", sid, e.message); }
    }
  }, 30000);

  // ------------------------------------------------------------- file browser (server/files.mjs)
  /** The host browses any folder. A remote viewer only the folders Omni works in (the chats' working
   *  directories, the default one and the vault), never the rest of the disk. */
  const normDir = (d) => { const r = resolve(String(d)); return process.platform === "win32" ? r.toLowerCase() : r; };
  function fsRootAllowed(req, root) {
    if (!String(root || "").trim()) return false;
    if (req.omniHost || req.omniChannel) return true;
    const allowed = new Set([cfg.cwd, cfg.vaultDir, ...[...pis].map((c) => c.cwd), ...registry.list().map((s) => s.cwd)].filter(Boolean).map(normDir));
    return allowed.has(normDir(root));
  }

  // ------------------------------------------------------------------ http
  // The UI: dist/ui while it is what ui/ makes, ui/ itself the moment it is not (server/ui-build.mjs).
  const UI_ROOT = cfg.uiRoot || ROOT;
  const uiBuild = openUiBuild({ root: UI_ROOT, log: cfg.log || log, fromSource: !!cfg.uiFromSource || process.env.OMNI_UI_SOURCE === "1" });
  const NO_FILES = new Map(), NOTHING_FETCH_ONLY = new Set();
  const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
  function send(res, code, body, type = "application/json") {
    res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
    res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  }
  /** Read once and kept on the request: the approval gate reads a remote body before the route does. */
  async function readBody(req) {
    if (req.omniBody) return req.omniBody;
    if (req.omniBodyError) throw req.omniBodyError;
    // A remote body is capped (16 KB before sign-in, 32 MB after: pasted images); the host's is not.
    const cap = req.omniHost ? Infinity : req.omniSignedIn || req.omniChannel ? 32 * 1024 * 1024 : 16 * 1024;
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > cap) { req.destroy(); throw Object.assign(new Error("request too large"), { status: 413 }); }
      chunks.push(c);
    }
    const s = Buffer.concat(chunks).toString("utf8");
    try { req.omniBody = s ? JSON.parse(s) : {}; } catch (e) { req.omniBodyError = e; throw e; }
    return req.omniBody;
  }
  /** Chat `sid`'s child, also while it waits to reattach after OpenCode went away (it has no proc then). */
  const chatOf = (sid) => { if (!sid) return null; for (const c of pis) if (c.sid === sid && (c.proc || (c.restoring && !c.stopped))) return c; return null; };
  /**
   * Chat `sid`'s child, ready for a request; null when no child has the chat. One reattaching after OpenCode went away
   * is waited for (bounded by the server's start timeout): opening the chat in another child meanwhile would put two
   * children on one session (doubled events and mirror entries). Not back in time → 409.
   */
  async function readyPi(sid) {
    const c = chatOf(sid);
    if (!c || c.proc) return c;
    const until = Date.now() + (cfg.opencodeRestartWaitMs ?? opencode.startTimeoutMs ?? 60000);
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 50));
      if (!pis.has(c) || c.stopped) return piFor(sid);
      if (c.proc && !c.restoring) return c;
    }
    throw Object.assign(new Error("OpenCode is restarting — try again in a moment"), { status: 409 });
  }
  /** Chat `sid`'s pi child (waited for while it reattaches), or the current one without a sid. */
  const requirePi = async (sid = "") => {
    const c = sid ? await readyPi(sid) : pi;
    if (!c?.proc) throw Object.assign(new Error(sid ? "that chat is not open on OpenCode right now; send it a message to continue it" : "no chat is open on OpenCode (POST /api/pi/start)"), { status: 409 });
    return c;
  };

  function graphDirFor(sid) {
    const s = registry.get(sid);
    const dir = s?.cwd || cfg.cwd;
    return dir && existsSync(graph.graphPath(dir)) ? dir : null;
  }
  async function graphContext(prompt, dir) {
    if (!dir || !existsSync(graph.graphPath(dir))) return "";
    try {
      const out = await graph.query(dir, prompt, { budget: cfg.graphBudgetTokens, bin: cfg.graphifyBin });
      return out ? `<repo-graph dir="${dir}">\n${out}\n</repo-graph>` : "";
    } catch (e) { log("graph query failed", e.message); return ""; }
  }
  const isLocal = (req) => !!req.omniHost;
  /** The person, at the machine or on another of their devices. isLocal stays for what only this machine may do. */
  const isPerson = (req) => !!req.omniHost || !!req.omniChannel;

  async function memoryPack(prompt) {
    const pack = await vault.pack(prompt, { budgetTokens: cfg.memoryBudgetTokens });
    return pack;
  }

  /** Memory pack + repo-graph context. Claude gets them as system prompt text, pi inline before the message. */
  async function composePrompt(harness, prompt, { memory, graph: graphFlag, dir }) {
    const parts = [];
    if (memory) { const pack = await memoryPack(prompt); if (pack) parts.push(harness === "claude" ? `Relevant durable memory from the user's Omni vault:\n${pack}` : pack); }
    if (graphFlag) { const g = await graphContext(prompt, dir); if (g) parts.push(harness === "claude" ? `Repo knowledge graph context (graphify):\n${g}` : g); }
    if (harness === "claude") return { text: prompt, system: parts.join("\n\n") };
    return { text: parts.length ? `${parts.join("\n\n")}\n\n${prompt}` : prompt, system: "" };
  }

  /** The background agent still running in this chat (its own pi/claude writes the session file), else null. */
  function activeAgentIn(sid, file) {
    const a = registry.get(sid)?.agentId ? agents.get(registry.get(sid).agentId) : null;
    if (a && ["queued", "starting", "running"].includes(a.status)) return a;
    return (file && agents.owns(file)) || agents.piFor(sid) ? a || { id: "?", title: "" } : null;
  }
  const agentBusyError = (a) => Object.assign(new Error(`that chat belongs to background agent ${a.id}${a.title ? ` ("${a.title}")` : ""}, which is still running: message it with POST /api/agents/${a.id}/message, or stop it first`), { status: 409 });

  async function continueSession(sid, body) {
    // A mission orchestrator's chat is driven by its mission (one queue, orchestrator-only tools): never as a plain chat.
    const orchestratorOf = missions.bySession(sid);
    if (orchestratorOf && missions.isOrchestrator(orchestratorOf, sid)) throw Object.assign(new Error(`This is the orchestrator of mission "${orchestratorOf.title}": message it from the Missions view.`), { status: 409 });
    const s = registry.get(sid);
    if (!s) throw Object.assign(new Error("unknown session"), { status: 404 });
    if (!body.message?.trim()) throw Object.assign(new Error("empty message"), { status: 400 });
    // Omni's main pi must never open a session file a running agent's own pi is still writing.
    const busy = activeAgentIn(sid, s.file);
    if (busy) throw agentBusyError(busy);
    // A chat whose child is reattaching is that child's (waited for), never opened in a second one.
    const plan = planContinue(s, { liveWindowMs: cfg.liveWindowMs, piOwned: !!(await readyPi(sid)), claudeAlive: !!claude.runs.get(sid)?.alive, forceFork: !!body.fork });
    if (plan.action === "error") throw Object.assign(new Error(plan.error), { status: plan.status });
    const dir = s.cwd || cfg.cwd;
    if (plan.action === "claude") {
      const p = await composePrompt("claude", body.message, { memory: body.memory, graph: body.graph, dir });
      const r = claude.run({ prompt: p.text, cwd: plan.cwd || cfg.cwd, resume: plan.resume, fork: plan.fork, forkedFrom: plan.fork ? sid : null, model: body.model, appendSystem: p.system, autonomous: body.autonomous !== false });
      return { sid: r.sid, pending: r.pending, forked: plan.fork, forkedFrom: plan.fork ? sid : null };
    }
    const p = await composePrompt("pi", body.message, { memory: body.memory, graph: body.graph, dir });
    if (plan.action === "pi-prompt") { const c = usePi(piFor(sid)); await c.prompt(p.text, { images: body.images }); return { sid: c.sid, pending: false, forked: false, forkedFrom: null }; }
    // Any other chat's child keeps working: this one opens in a free child in its folder, or a new one.
    const { child: c } = await acquirePi(plan.cwd || dir);
    try {
      const switched = await c.switchSession(plan.file);
      // An old pi chat is imported into a new session: that is the fork already (a clone of it would leave a ghost copy).
      if (plan.clone) {
        if (!switched?.data?.imported) await c.clone();
        bus.emit({ sid: c.sid, harness: "pi", kind: "session", ts: Date.now(), owned: true, forkedFrom: sid, cwd: c.cwd, file: c.state?.sessionFile });
      }
    } catch (e) { c.claimedAt = 0; throw Object.assign(e, { status: e.status || 409 }); }
    await usePi(c).prompt(p.text, { images: body.images });
    return { sid: c.sid, pending: false, forked: !!plan.clone, forkedFrom: plan.clone ? sid : null };
  }

  /** Resolve when a Claude run ends (its `run` event), or after `ms` with whatever exists. */
  function waitForRun(sid, ms) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (out) => { if (done) return; done = true; clearTimeout(timer); bus.off("event", onEvent); resolve(out); };
      const onEvent = (ev) => {
        if (ev.sid !== sid) return;
        if (ev.kind === "run") finish({ text: ev.text || "", isError: !!ev.isError, cost: ev.cost || 0, turns: ev.turns || 0, durationMs: ev.durationMs || 0, timedOut: false });
      };
      const timer = setTimeout(() => finish({ text: "", isError: false, cost: 0, turns: 0, durationMs: ms, timedOut: true }), ms);
      bus.on("event", onEvent);
    });
  }

  // Secure whenever the certificate exists: the relay path is always HTTPS even if the LAN listener is off.
  const secure = () => (remote.tls || relay.server ? "; Secure" : "");
  const cookieFor = (token, maxAgeSec) => `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${secure()}`;
  // The device token only ever needs to reach the sign-in route.
  const deviceCookieFor = (token, maxAgeSec) => `${DEVICE_COOKIE}=${token}; Path=/api/remote/login; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${secure()}`;
  function remoteStatus() {
    const proto = remote.tls ? "https" : "http";
    return {
      enabled: !!cfg.lan, listening: !!remote.server, port: remote.port, error: remote.error,
      https: !!remote.tls, fingerprint: remote.tls?.fingerprint || relay.fingerprint || null, selfSigned: !!(remote.tls?.selfSigned ?? relay.selfSigned),
      urls: remote.server ? lanAddresses().map((a) => `${proto}://${a.address}:${remote.port}/`) : [],
      relay: cfg.relay?.host ? { url: `https://${cfg.relay.host}:${cfg.relay.publicPort}/`, listening: !!relay.server, error: relay.error, tunnel: tunnel?.status() || null } : null,
      hasPassword: auth.hasPassword(), sessions: auth.list(), pending: approvals.list().length,
      deviceApproval: cfg.remoteDeviceApproval !== false, devices: auth.listDevices(),
    };
  }

  /** Password right: a trusted device signs straight in; a new one waits for the host's Approve, and is
   *  then remembered. At most one waiting sign-in per address and three in all, so a leaked password
   *  cannot bury the host in cards. */
  async function signIn(req, res, ip, body) {
    await auth.verify(ip, body.password);
    const ua = String(req.headers["user-agent"] || "");
    if (cfg.remoteDeviceApproval !== false && !auth.isTrustedDevice(parseCookies(req.headers.cookie)[DEVICE_COOKIE])) {
      const waiting = approvals.list().filter((a) => a.kind === "signin");
      if (waiting.some((a) => a.ip === ip) || waiting.length >= 3) throw Object.assign(new Error("a sign-in is already waiting for the host"), { status: 429 });
      const gone = new AbortController();
      res.on("close", () => { if (!res.writableFinished) gone.abort(); });
      log(`remote ${ip} signs in from a new device; waiting for the host`);
      const outcome = await approvals.request({ kind: "signin", ip, method: "POST", path: "/api/remote/login", title: "Sign in from a new device", text: `${ua.slice(0, 300) || "unknown browser"}\n\nApprove only if this is you. The device is remembered for 180 days (Settings → Remote lists it).`, detail: {} }, { signal: gone.signal });
      log(`  → ${outcome}`);
      if (outcome === "cancelled") return;
      if (outcome !== "approved") throw Object.assign(new Error(outcome === "denied" ? "the host declined this device" : "the host did not answer in time"), { status: 403 });
      res.appendHeader("Set-Cookie", deviceCookieFor(auth.trustDevice({ label: ua, ip }), Math.round(auth.deviceTtlMs / 1000)));
    }
    log(`remote sign-in from ${ip}`);
    res.appendHeader("Set-Cookie", cookieFor(auth.createSession(ip, { userAgent: ua }), Math.round(auth.sessionTtlMs / 1000)));
    send(res, 200, { ok: true });
  }

  /** The self-signed certificate as a file iOS installs as a profile (Settings → General → VPN & Device
   *  Management, then Settings → General → About → Certificate Trust Settings): the warning is then gone. */
  const CERT_PATH = "/omni-agent.crt";
  function sendCert(res) {
    const c = remote.tls || relay.server ? loadCert() : null;
    if (!c?.cert) return send(res, 404, { error: "this listener has no certificate" });
    res.writeHead(200, { "Content-Type": "application/x-x509-ca-cert", "Content-Disposition": 'attachment; filename="omni-agent.crt"', "Cache-Control": "no-store" });
    res.end(c.cert);
  }

  /** Everything a request from anywhere but the host's own browser goes through first. Answers the
   *  request itself (login page, 401, refusal) and returns true, or returns false to let the route run. */
  async function remoteGate(req, res, p) {
    const ip = clientIp(req);
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (p === "/api/remote/login" && req.method === "POST") {
      await signIn(req, res, ip, await readBody(req));
      return true;
    }
    if (p === "/api/remote/logout" && req.method === "POST") {
      auth.logout(token);
      res.setHeader("Set-Cookie", cookieFor("", 0));
      send(res, 200, { ok: true });
      return true;
    }
    // The certificate is public (every visitor's browser is sent it): a phone downloads it to trust it.
    if (req.method === "GET" && p === CERT_PATH) { sendCert(res); return true; }
    const session = auth.session(token);
    if (!session) {
      if (req.method === "GET" && (p === "/" || p === "/index.html" || p === "/login")) { send(res, 200, await fs.readFile(join(ROOT, "ui", "login.html")), MIME[".html"]); return true; }
      send(res, 401, { error: "sign in first", login: true });
      return true;
    }
    req.omniSignedIn = true;
    if (p === "/login") { res.writeHead(302, { Location: "/" }); res.end(); return true; }
    const kind = classify(req.method, p);
    if (kind === "host") { send(res, 403, { error: "only the host can do that, at the computer itself" }); return true; }
    if (kind === "read") return false;
    // A change: hold it open until the host approves or denies it on this computer.
    const body = req.method === "GET" || req.method === "DELETE" ? {} : await readBody(req);
    const d = describe(req.method, p, body, { titleOf: (sid) => registry.get(sid)?.title || "" });
    const gone = new AbortController();
    res.on("close", () => { if (!res.writableFinished) gone.abort(); });
    log(`remote ${ip} asks: ${d.title}`);
    const outcome = await approvals.request({ ip, method: req.method, path: p, title: d.title, text: String(d.text || "").slice(0, 4000), detail: redact(body) }, { signal: gone.signal });
    log(`  → ${outcome}`);
    if (outcome === "approved") return false;
    if (outcome !== "cancelled") send(res, 403, { error: outcome === "denied" ? "the host declined this" : "the host did not answer in time", approval: outcome });
    return true;
  }

  /** The host's controls for remote access (Settings → Remote, and the approval cards). */
  async function remoteAdmin(req, res, p) {
    let m;
    if (req.method === "GET" && p === "/api/remote/status") return send(res, 200, remoteStatus());
    if (req.method === "POST" && p === "/api/remote/password") {
      await auth.setPassword((await readBody(req)).password);
      log("remote password changed; remote browsers signed out");
      return send(res, 200, remoteStatus());
    }
    if (req.method === "DELETE" && p === "/api/remote/sessions") return send(res, 200, { signedOut: auth.logoutAll(), ...remoteStatus() });
    if (req.method === "DELETE" && (m = /^\/api\/remote\/devices\/([^/]+)$/.exec(p))) {
      const removed = auth.removeDevice(decodeURIComponent(m[1]));
      // A device no longer trusted must not stay signed in either.
      if (removed) auth.logoutAll();
      return send(res, 200, { removed, ...remoteStatus() });
    }
    if (req.method === "GET" && p === "/api/remote/approvals") return send(res, 200, { approvals: approvals.list() });
    if (req.method === "POST" && (m = /^\/api\/remote\/approvals\/([^/]+)$/.exec(p))) {
      const ok = approvals.decide(decodeURIComponent(m[1]), (await readBody(req)).approve === true);
      return ok ? send(res, 200, { ok: true }) : send(res, 404, { error: "that request is no longer waiting" });
    }
    return send(res, 404, { error: "unknown remote route" });
  }

  /** Whether this request names a path in the account folder, in its query or anywhere in its JSON body. */
  async function accountFolderAsked(req, p, q) {
    let body = {};
    if (req.method !== "GET" && req.method !== "HEAD") { try { body = await readBody(req); } catch (e) { if (e.status === 413) throw e; /* the route answers a malformed body as it always did */ } }
    return requestTouchesAccountFolder({ method: req.method, path: p, query: q, body, bases: [cfg.cwd, cfg.vaultDir].filter(Boolean), dirs: accountDirs });
  }

  /**
   * A `client` device (the web page) changing Omni's own code or config: the next start would run it as the host, which
   * would undo the role's limit. Reading is its to do. A `full` device keeps this, as the design gives.
   */
  async function appFilesChanged(req, p, q) {
    if (req.omniChannel?.role !== "client" || !p.startsWith("/api/fs/") || req.method === "GET" || req.method === "HEAD") return false;
    let body = {};
    try { body = await readBody(req); } catch (e) { if (e.status === 413) throw e; }
    // Only what the route will use: another base would refuse a project's own `server/x` because Omni has one too.
    return requestTouchesAccountFolder({ method: req.method, path: p, query: q, body, bases: body?.root || q.get("root") ? [] : [cfg.cwd].filter(Boolean), dirs: cfg.appFiles || [ROOT, CONFIG_FILE], family: false });
  }

  /** The account routes and the proxy to other machines: only for the desktop window, see WindowGate. */
  async function accountRoute(req, res, p, q) {
    const refusal = windowGate.refusal(req);
    if (refusal) return send(res, 403, { error: refusal });
    if (!account) return send(res, 503, { error: "the account is off: check account.hub in omni.config.json" });
    if (p === "/remote" || p.startsWith("/remote/")) return await proxyToMachine(req, res, { links: machineLinks, send });
    try {
      return await handleAccountRoutes(req, res, { p, q, account, links: machineLinks, send, readBody, streams: accountStreams });
    } catch (e) {
      if (e instanceof AccountError) return send(res, e.status, { error: e.message, code: e.code });
      throw e;
    }
  }

  async function handle(req, res, { remoteListener = false } = {}) {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const p = url.pathname;
    const q = url.searchParams;
    // No framing (clickjacking an Approve button), no MIME sniffing, no referrer leaking a path.
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    try {
      const sfs = req.headers["sec-fetch-site"];
      if (req.method !== "GET" && sfs && sfs !== "same-origin" && sfs !== "none") return send(res, 403, { error: "cross-site request refused" });
      req.omniHost = !req.omniChannel && isHostRequest(req, { remoteListener });
      if (req.omniChannel) { if (!channelAllowed(req.method, req.url)) return send(res, 403, { error: "that is not available over a channel" }); }
      else if (!req.omniHost && (await remoteGate(req, res, p))) return;
      // The proxy first: its body is the far machine's to read, as it streams, and no path in it names anything here.
      if (p === "/remote" || p.startsWith("/remote/")) return await accountRoute(req, res, p, q);
      // Whoever asks, by whatever route: the keys are not reachable through this server.
      if (await accountFolderAsked(req, p, q)) return send(res, 403, { error: "the account folder cannot be opened through Omni" });
      if (await appFilesChanged(req, p, q)) return send(res, 403, { error: "a web page device cannot change Omni's own files" });
      if (req.method === "GET" && (p === "/" || p === "/index.html") && q.has("token") && req.omniHost) {
        const swap = windowGate.swap(req, url);
        res.writeHead(302, { Location: swap.location, "Cache-Control": "no-store", ...(swap.cookie ? { "Set-Cookie": swap.cookie } : {}) });
        return res.end();
      }
      if (p === "/api/account" || p.startsWith("/api/account/")) return await accountRoute(req, res, p, q);
      if (req.method === "GET" && p === "/api/remote/me") return send(res, 200, { role: req.omniHost ? "host" : "remote" });
      if (p.startsWith("/api/remote/")) return remoteAdmin(req, res, p);
      if (req.method === "GET" && p === CERT_PATH) return sendCert(res);
      // static UI
      if (req.method === "GET" && (p === "/" || p === "/index.html")) {
        const built = uiBuild.current();
        if (built) { serveWebFile(req, res, built.files, {}, { fetchOnly: NOTHING_FETCH_ONLY }); return; }
        res.setHeader("X-Omni-Ui", "source");
        return send(res, 200, await fs.readFile(join(UI_ROOT, "ui", "index.html")), MIME[".html"]);
      }
      if (req.method === "GET" && /^\/[\w.-]+\.(js|mjs|css|svg|png|ico)$/.test(p)) {
        if (serveWebFile(req, res, uiBuild.files() ?? NO_FILES, {}, { fetchOnly: NOTHING_FETCH_ONLY })) return;
        const f = join(UI_ROOT, "ui", p.slice(1));
        if (p === "/sw.js" || !existsSync(f)) return send(res, 404, { error: "not found" }); // the worker is the web page's, and its source a template

        return send(res, 200, await fs.readFile(f), MIME[extname(f)] || "application/octet-stream");
      }
      // events
      if (req.method === "GET" && p === "/events") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        res.write(": omni\n\n");
        bus.addClient(res, Number(q.get("since") || 0), q.get("boot") || "");
        if (req.omniHost) { hostStreams.add(res); res.write(`event: approvals\ndata: ${JSON.stringify(approvals.list())}\n\n`); }
        // A real event, not an SSE comment: page code never sees a comment, and the page needs this beat to
        // notice a stream that died without a FIN (a phone switching networks, the relay's far side gone).
        const ka = setInterval(() => { try { res.write("event: ka\ndata: 1\n\n"); } catch { /* */ } }, cfg.sseKeepAliveMs || 20000);
        req.on("close", () => { clearInterval(ka); bus.removeClient(res); hostStreams.delete(res); });
        return;
      }
      // state
      if (req.method === "GET" && p === "/api/state") {
        // `first`: what the first screen needs, in one small answer. The page asks for the whole once it has painted.
        const first = q.get("first") === "1";
        const allSessions = registry.list();
        const allAgents = agents.list();
        const brief = (text) => (typeof text === "string" && text.length > 300 ? `${text.slice(0, 300)}…` : text);
        const sessionsNow = !first ? allSessions : [...allSessions].sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0)).filter((s, i) => i < 60 || s.streaming || s.owned);
        const agentsNow = !first ? allAgents.slice(0, 200) : [...allAgents.filter((a) => AGENT_RUNNING.has(a.status)).slice(0, 12), ...allAgents.filter((a) => !AGENT_RUNNING.has(a.status)).slice(0, 20)];
        return send(res, 200, {
          config: { cwd: cfg.cwd, vault: cfg.vaultDir, port: cfg.port, piModelsFile: cfg.piModelsFile, claudeBin: cfg.claudeBin, memoryBudgetTokens: cfg.memoryBudgetTokens, liveWindowMs: cfg.liveWindowMs, lan: cfg.lan, lanUrls: remoteStatus().urls, piProvider: cfg.piProvider, piModel: cfg.piModel, piThinking: cfg.piThinking, context: cfg.context },
          access: { role: req.omniHost ? "host" : req.omniChannel ? "device" : "remote", ...(req.omniHost ? { remote: remoteStatus() } : {}) },
          pi: pi ? { running: !!pi.proc, sid: pi.sid, cwd: pi.cwd, streaming: pi.streaming, state: pi.state } : { running: false },
          // Every chat with a pi child right now (`pi` is the one used last), and each one's goal.
          pis: piList().map((x) => ({ ...x, goal: keeper.goal(x.sid) ? keeper.status(x.sid) : null })),
          hook: keeper.config,
          goal: pi?.sid ? keeper.status(pi.sid) : null,
          runs: claude.list(),
          // A record can hold a 20 KB report and up to 500 are kept: the list carries a preview.
          agents: agentsNow.map((a) => (first ? { ...a, task: brief(a.task), command: brief(a.command), resultText: brief(a.resultText) } : { ...a, resultText: (a.resultText || "").length > 2000 ? `${a.resultText.slice(0, 2000)}…` : a.resultText })),
          sessions: sessionsNow.map((s) => ({ ...s, tally: tally.has(s.sid) ? tally.get(s.sid) : null })),
          ...(first ? { sessionsTotal: allSessions.length } : {}),
          seq: bus.seq,
          boot: bus.boot,
        });
      }
      let m;
      if (req.method === "GET" && (m = /^\/api\/sessions\/([^/]+)\/history$/.exec(p))) {
        const sid = decodeURIComponent(m[1]);
        const before = q.get("before");
        // A far machine's page asks for less than the whole window at a time. The floor keeps a page a page.
        const asked = Number(q.get("page"));
        const pageBytes = Number.isSafeInteger(asked) && asked > 0 ? Math.max(asked, 8 * 1024) : undefined;
        const h = await watcher.history(sid, { before: before == null || before === "" ? undefined : Number(before), pageBytes });
        return send(res, 200, { ...h, events: h.events.map(wireEvent), session: registry.get(sid) || null });
      }
      // A tool's full output (a page gets long ones clipped): the event ring holds a live one the file may not have yet.
      if (req.method === "GET" && (m = /^\/api\/sessions\/([^/]+)\/tool-output$/.exec(p))) {
        const sid = decodeURIComponent(m[1]), id = q.get("id") || "";
        const r = bus.toolResult(sid, id) || await watcher.toolOutput(sid, id, { at: q.get("at") });
        if (!r) return send(res, 404, { error: "that tool output is not in the chat's file" });
        const max = Number(q.get("max") || 0);
        const size = r.text.length;
        return send(res, 200, { ...r, text: max > 0 && size > max ? r.text.slice(0, max) : r.text, size });
      }
      if (req.method === "POST" && (m = /^\/api\/sessions\/([^/]+)\/continue$/.exec(p))) {
        return send(res, 200, await continueSession(decodeURIComponent(m[1]), await readBody(req)));
      }
      if (req.method === "DELETE" && (m = /^\/api\/sessions\/([^/]+)$/.exec(p))) {
        const sid = decodeURIComponent(m[1]);
        const s = registry.get(sid);
        if (!s) return send(res, 404, { error: "unknown session" });
        const live = s.owned || piOwns(s.file) || claude.owns(s.file || "") || (s.streaming && Date.now() - (s.lastActivity || 0) < cfg.liveWindowMs);
        if (live) return send(res, 409, { error: "that chat is still live \u2014 stop it before deleting" });
        const out = await watcher.deleteSession(sid, { trashDir: cfg.trashDir });
        bus.emit({ sid, harness: s.harness, kind: "removed", ts: Date.now() });
        return send(res, 200, { ok: true, trashed: out.trashed });
      }
      if (req.method === "POST" && p === "/api/shutdown") {
        if (!isLocal(req)) return send(res, 403, { error: "local only" });
        send(res, 200, { ok: true });
        setTimeout(() => { close(); process.exit(0); }, 100);
        return;
      }
      // goal hook
      if (p === "/api/hook") {
        if (req.method === "GET") return send(res, 200, { hook: keeper.config });
        if (req.method === "PUT" || req.method === "POST") {
          const next = hookConfig({ ...keeper.config, ...(await readBody(req)) });
          keeper.setConfig(next);
          if (cfg.persistHook !== false) writeConfigFile({ hook: next });
          return send(res, 200, { hook: next });
        }
      }
      // long-run settings: where a chat compacts (OpencodeRpc's compactAt) and auto-continue after a context stop
      if (p === "/api/context") {
        if (req.method === "GET") return send(res, 200, { context: cfg.context });
        if (req.method === "PUT" || req.method === "POST") {
          const b = await readBody(req);
          const patch = {};
          if (b.compactAt !== undefined) { const n = Number(b.compactAt); if (!Number.isInteger(n) || n < 0) return send(res, 400, { error: "compactAt must be a whole number of tokens (0 = off)" }); patch.compactAt = n; } // contextConfig raises 1..99999 to its 100k floor
          if (b.autoContinue !== undefined) patch.autoContinue = !!b.autoContinue;
          cfg.context = contextConfig({ ...cfg.context, ...patch });
          keeper.setContextPolicy(cfg.context);
          if (cfg.persistContext !== false) writeConfigFile({ context: cfg.context });
          // Every running chat and background agent compacts at the new point from its next prompt on (nothing restarts).
          const at = Number(cfg.context.compactAt) || 0;
          for (const c of [...pis, ...(agents?.liveChildren?.() || [])]) if ("compactAt" in c) c.compactAt = at;
          return send(res, 200, { ok: true, context: cfg.context, restarted: false, restartPending: false });
        }
      }
      // explicit goal (the /goal command): set a persistent goal and arm the keeper
      if (p === "/api/goal") {
        if (req.method === "GET") return send(res, 200, keeper.status(q.get("sid") || pi?.sid));
        if (req.method === "POST" || req.method === "PUT") {
          const b = await readBody(req);
          // The chat it was typed in (`sid`); without one, the chat used last.
          const c = b.sid ? await readyPi(b.sid) : pi;
          if (!c?.sid) return send(res, 400, { error: b.sid ? "that chat is not open on OpenCode right now; send it a message first, then set the goal" : "no active chat session; start a chat first" });
          const goal = String(b.goal ?? "").trim();
          keeper.setExplicitGoal(c.sid, goal);
          saveGoals();
          // Setting a goal arms the keeper so the agent is re-engaged until the goal is done.
          if (goal && !keeper.config.enabled) { keeper.setConfig({ ...keeper.config, enabled: true }); if (cfg.persistHook !== false) writeConfigFile({ hook: keeper.config }); }
          // The kickoff says up front that this goal is tracked by its plan (the keeper insists on one anyway).
          if (goal) { try { await usePi(c).prompt(`${goal}\n\n(Tracked goal: first brainstorm and plan it with the plan tool, then work through the plan until every step is done.)`); } catch { /* goal is set + hook armed; the keeper will re-engage */ } }
          return send(res, 200, { goal, explicit: !!goal, enabled: keeper.config.enabled, started: !!goal });
        }
      }
      // providers: Omni's custom (BYOK) providers, rendered into opencode.json; keys for OpenCode's own providers
      if (req.method === "GET" && p === "/api/providers") {
        const mdl = pi?.state?.model;
        // OpenCode's catalog (this starts the server, as the model picker does; its first start copies pi's providers).
        const cat = await Promise.race([catalog().catch(() => null), new Promise((r) => { setTimeout(r, 15000, null).unref?.(); })]);
        const providers = listProviders(cfg.opencodeProvidersFile);
        const own = new Set(providers.filter((x) => !x.builtIn).map((x) => x.name)); // Omni-added models of an OpenCode provider leave its key row
        const builtIn = (Array.isArray(cat?.connected) ? cat.connected : []).filter((id) => !own.has(id)).map((id) => ({ id, name: cat.all?.find?.((x) => x.id === id)?.name || id }));
        return send(res, 200, { providers, opencode: builtIn, presets: PRESETS, file: cfg.opencodeProvidersFile, active: mdl ? { provider: mdl.provider, id: mdl.id } : null });
      }
      // The order of Omni's custom providers in opencode.json (read at OpenCode's next reload; nothing restarts).
      if (req.method === "POST" && p === "/api/providers-order") {
        const body = await readBody(req);
        if (!Array.isArray(body.order)) return send(res, 400, { error: "order must be an array of provider names" });
        const order = reorderProviders(cfg.opencodeProvidersFile, body.order);
        writeConfig();
        return send(res, 200, { ok: true, order, providers: listProviders(cfg.opencodeProvidersFile) });
      }
      if ((req.method === "PUT" || req.method === "DELETE") && (m = /^\/api\/providers\/([^/]+)$/.exec(p))) {
        const name = decodeURIComponent(m[1]);
        if (req.method === "PUT") {
          const body = await readBody(req);
          const stored = Object.hasOwn(readModelsFile(cfg.opencodeProvidersFile).providers, name);
          if (!stored && body.builtIn === true) {
            // Extra models for one of OpenCode's own providers: only for a provider OpenCode has.
            const cat = await catalog().catch(() => null);
            if (!cat) return send(res, 503, { error: "OpenCode is not running, so its providers cannot be checked" });
            if (!cat.all?.some?.((x) => x.id === name)) return send(res, 400, { error: `OpenCode has no provider named "${name}"` });
          } else if (!stored && opencode.up) {
            // A name OpenCode already has (built in, or the user's global config) would be overridden by Omni's entry.
            const cat = await catalog().catch(() => null);
            if (cat?.all?.some?.((x) => x.id === name)) return send(res, 409, { error: `OpenCode already has a provider named "${name}": set its key with its own preset (OpenCode providers), or give this one another name` });
          }
          saveCustomProvider(cfg.opencodeProvidersFile, name, body);
        } else if (!removeProvider(cfg.opencodeProvidersFile, name)) return send(res, 404, { error: "unknown provider" });
        const { restarted, pending } = await reloadOpencode();
        return send(res, 200, { ok: true, restarted, restartPending: pending, providers: listProviders(cfg.opencodeProvidersFile) });
      }
      // The API key of one of OpenCode's own providers: OpenCode's auth store (PUT/DELETE /auth/:id), then a reload.
      if ((req.method === "PUT" || req.method === "DELETE") && (m = /^\/api\/provider-keys\/([^/]+)$/.exec(p))) {
        const id = decodeURIComponent(m[1]);
        const body = req.method === "PUT" ? await readBody(req) : {};
        const key = String(body.key ?? "").trim();
        if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) return send(res, 400, { error: "not a provider id" });
        if (req.method === "PUT" && !key) return send(res, 400, { error: "paste the API key" });
        // Omni's custom providers keep their key in their own form; Omni-added models of an OpenCode provider (builtIn) do not.
        const ownEntry = readModelsFile(cfg.opencodeProvidersFile).providers;
        if (Object.hasOwn(ownEntry, id) && ownEntry[id]?.builtIn !== true) return send(res, 409, { error: `"${id}" is one of your custom providers: its key is saved in its own form` });
        let server;
        try { server = await opencodeUp(); } catch (e) { return send(res, 503, { error: `OpenCode is not running: ${e.message}` }); }
        if (req.method === "PUT") {
          const cat = await catalog().catch(() => null);
          if (cat && !cat.all?.some?.((x) => x.id === id)) return send(res, 400, { error: `OpenCode has no provider named "${id}"` });
          await server.request("PUT", `/auth/${encodeURIComponent(id)}`, { body: { type: "api", key } });
        } else await server.request("DELETE", `/auth/${encodeURIComponent(id)}`);
        const { restarted, pending } = await reloadOpencode();
        return send(res, 200, { ok: true, restarted, restartPending: pending });
      }
      // MCP servers (pi's omni-agent.json → mcpServers, rendered into opencode.json). A change reloads OpenCode.
      if (req.method === "GET" && p === "/api/mcp") {
        return send(res, 200, { servers: listMcpServers(cfg.piExtConfigFile), file: cfg.piExtConfigFile });
      }
      if (req.method === "POST" && p === "/api/mcp-test") {
        const body = await readBody(req);
        return send(res, 200, await testMcpServer(cfg.piExtConfigFile, String(body.name || "").trim(), body));
      }
      if ((req.method === "PUT" || req.method === "DELETE") && (m = /^\/api\/mcp\/([^/]+)$/.exec(p))) {
        const name = decodeURIComponent(m[1]);
        if (req.method === "PUT") { const body = await readBody(req); upsertMcpServer(cfg.piExtConfigFile, name, body, { rename: body.rename }); }
        else if (!removeMcpServer(cfg.piExtConfigFile, name)) return send(res, 404, { error: "unknown MCP server" });
        const { restarted, pending } = await reloadOpencode();
        return send(res, 200, { ok: true, restarted, restartPending: pending, servers: listMcpServers(cfg.piExtConfigFile) });
      }
      // pi
      if (p.startsWith("/api/pi/")) {
        const body = req.method === "POST" ? await readBody(req) : {};
        // The chat a request is for: its own pi child. Without one, the child used last.
        const sid = String(body.sid || q.get("sid") || "");
        switch (p) {
          // Another pi child; any already running keep going.
          case "/api/pi/start": { const c = startPi(body.cwd || cfg.cwd); try { await c.waitReady(); } catch { /* the UI polls /api/state */ } return send(res, 200, { ok: true, sid: c.sid }); }
          // `sid` stops that chat's child; without one, every chat's.
          case "/api/pi/stop": { for (const c of sid ? [chatOf(sid)].filter(Boolean) : [...pis]) stopPi(c); return send(res, 200, { ok: true }); }
          // A new chat in `cwd`, without a prompt yet: a free child opens a new session, else a new child starts.
          case "/api/pi/open": {
            const { child: c, fresh } = await acquirePi(body.cwd || cfg.cwd);
            if (!fresh) await c.newSession();
            return send(res, 200, { ok: true, sid: c.sid, cwd: c.cwd, state: c.state });
          }
          // A new chat in one step (open it, then prompt): what a remote browser's Home sends, so the host
          // approves one request instead of three.
          case "/api/pi/send": {
            if (!body.message?.trim()) return send(res, 400, { error: "empty" });
            const { child: c, fresh } = await acquirePi(body.cwd || cfg.cwd);
            if (!fresh) await c.newSession();
            const composed = await composePrompt("pi", body.message, { memory: body.memory, graph: body.graph, dir: graphDirFor(c.sid) });
            await usePi(c).prompt(composed.text, { images: body.images });
            return send(res, 200, { ok: true, sid: c.sid });
          }
          case "/api/pi/prompt": {
            if (!body.message?.trim()) return send(res, 400, { error: "empty" });
            // The chat's child was closed (idle too long, or it opened another chat): pick the chat up again.
            if (sid && !(await readyPi(sid)) && registry.get(sid)) return send(res, 200, await continueSession(sid, body));
            const p0 = usePi(await requirePi(sid));
            const c = await composePrompt("pi", body.message, { memory: body.memory, graph: body.graph, dir: graphDirFor(p0.sid) });
            return send(res, 200, await p0.prompt(c.text, { images: body.images }));
          }
          case "/api/pi/abort": {
            // Stop halts this run and its goal (no re-engage until the user writes again). It used to also switch
            // the hook off globally and persist that, which silently left every later overnight run without one.
            const p0 = await requirePi(sid);
            keeper.cancel(p0.sid);
            // A full halt includes the chat's background agents: their reports would otherwise wake the stopped chat
            // and start new, unsupervised turns in it.
            const halted = agents.list({ parentSid: p0.sid, active: true });
            for (const a of halted) agents.cancel(a.id).catch((e) => log("could not stop agent", a.id, e.message));
            return send(res, 200, { ...(await p0.abort()), agentsStopped: halted.map((a) => a.id) });
          }
          // A new chat: in `sid`'s child when it is free, else (and without a sid) like /api/pi/open in its folder.
          case "/api/pi/new": {
            const own = sid ? await requirePi(sid) : null;
            if (own && piFree(own)) { const r = await usePi(own).newSession(); own.claimedAt = Date.now(); return send(res, 200, { ...r, sid: own.sid }); }
            const { child: c, fresh } = await acquirePi(body.cwd || own?.cwd || pi?.cwd || cfg.cwd);
            const r = fresh ? { success: true } : await c.newSession();
            return send(res, 200, { ...r, sid: c.sid });
          }
          case "/api/pi/switch": {
            const owner = registry.list().find((x) => x.file && body.file && resolve(x.file).toLowerCase() === resolve(body.file).toLowerCase());
            const busy = body.file && agents.owns(body.file) ? activeAgentIn(owner?.sid || "", body.file) || { id: "?" } : owner ? activeAgentIn(owner.sid, body.file) : null;
            if (busy) throw agentBusyError(busy);
            // Already open in a child: that one. A working child is never moved off its chat.
            const has = [...pis].find((c) => c.proc && c.owns?.(body.file));
            if (has) { usePi(has); return send(res, 200, { success: true, sid: has.sid }); }
            const c0 = await requirePi(sid);
            const c = c0.streaming || c0.inFlight > 0 ? (await acquirePi(c0.cwd)).child : c0;
            const r = await usePi(c).switchSession(body.file);
            return send(res, 200, { ...r, sid: c.sid });
          }
          // Model and thinking level are remembered even when no chat runs yet: the next chat starts with them. A live
          // chat refuses a model OpenCode's catalog does not have (nothing is saved then).
          // A model only has some of the levels (ui/thinking.js): the saved level follows a model switch to the nearest one it has.
          // `sid` applies the pick to that chat's child (the others keep theirs); without one, to the current child.
          case "/api/pi/model": {
            if (!body.provider || !body.modelId) return send(res, 400, { error: "provider and modelId are required" });
            const c = sid ? await readyPi(sid) : pi;
            let r;
            if (c?.proc) r = await c.setModel(body.provider, body.modelId);
            else {
              const cat = opencode.up ? await catalog().catch(() => null) : null;
              r = cat && !inCatalog(cat, body.provider, body.modelId) ? { success: false, error: `Model not found: ${body.provider}/${body.modelId}` } : { success: true, pending: true };
            }
            if (r?.success !== false) {
              cfg.piProvider = body.provider; cfg.piModel = body.modelId;
              const level = cfg.piThinking && clampThinking(cfg.piThinking, await levelsOf(body.provider, body.modelId));
              if (level && level !== cfg.piThinking) { cfg.piThinking = level; if (c?.proc) await c.setThinking(level).catch(() => {}); }
              if (cfg.persistPiModel !== false) writeConfigFile({ piProvider: body.provider, piModel: body.modelId, ...(level ? { piThinking: level } : {}) });
            }
            return send(res, 200, { ...r, provider: cfg.piProvider, modelId: cfg.piModel, level: cfg.piThinking });
          }
          case "/api/pi/thinking": {
            if (!THINKING_LEVELS.includes(body.level)) return send(res, 400, { error: `level must be one of ${THINKING_LEVELS.join(", ")}` });
            const c = sid ? await readyPi(sid) : pi;
            const cur = currentModel(c);
            // Clamped to the levels the model has (its OpenCode variants): a level it lacks would not be sent at all.
            const level = cur ? clampThinking(body.level, await levelsOf(cur.provider, cur.id)) : body.level;
            const r = c?.proc ? await c.setThinking(level) : { success: true, pending: true };
            if (r?.success !== false) { cfg.piThinking = level; if (cfg.persistPiModel !== false) writeConfigFile({ piThinking: level }); }
            return send(res, 200, { ...r, level: cfg.piThinking });
          }
          case "/api/pi/compact": return send(res, 200, await (await requirePi(sid)).compact());
          case "/api/pi/stats": return send(res, 200, await (await requirePi(sid)).stats());
          case "/api/pi/models": {
            // OpenCode's connected providers (its free `opencode` models and every provider with a key). The
            // piModels allowlist narrows the others; the `opencode` provider is always listed in full.
            const models = pickerModels(await pickerCatalog());
            const shown = cfg.piModels?.length ? models.filter((x) => x.provider === "opencode" || filterPiModels([x], cfg.piModels).length) : models;
            return send(res, 200, { success: true, data: { models: shown } });
          }
          // ?provider=&model= for a model in the picker; without them the chat's current model (running or saved).
          case "/api/pi/thinking-levels": {
            const c = sid ? piFor(sid) : pi;
            const cur = q.get("model") ? { provider: q.get("provider") || "", id: q.get("model") } : currentModel(c);
            if (!cur) return send(res, 200, { success: true, data: { levels: THINKING_LEVELS, labels: {} } });
            const t = await thinkingOf(cur.provider, cur.id, c?.state?.model);
            return send(res, 200, { success: true, data: { levels: t.levels, labels: t.labels, ...(t.family ? { family: t.family } : {}), provider: cur.provider, model: cur.id } });
          }
          case "/api/pi/state": return send(res, 200, await (await requirePi(sid)).refreshState());
          default: return send(res, 404, { error: "unknown /api/pi route" });
        }
      }
      // background agents (pi subagents, Claude Code sessions, shell jobs) started by the agents
      if (p.startsWith("/api/agents") && (await handleAgentRoutes(req, res, { p, q, agents, send, readBody, isLocal: isPerson }))) return;
      // Claude Code workers of a mission call the mission tools here (local only: it acts as that worker).
      if (p === "/mcp") { if (!isLocal(req)) return send(res, 403, { error: "local only" }); return handleMcp(req, res, { q, missions, agents, deps: missionDeps, readBody, send }); }
      if (p.startsWith("/api/missions") && (await handleMissionRoutes(req, res, { p, q, missions, send, readBody, isLocal, isPerson, deps: missionDeps }))) return;
      // claude
      // pi (or any local caller) hands Claude Code a task and waits for the answer
      if (req.method === "POST" && p === "/api/claude/task") {
        if (!isLocal(req)) return send(res, 403, { error: "local only" });
        const body = await readBody(req);
        if (!body.prompt?.trim()) return send(res, 400, { error: "empty prompt" });
        const c = await composePrompt("claude", body.prompt, { memory: body.memory, graph: body.graph, dir: body.cwd || cfg.cwd });
        const r = claude.run({ prompt: body.prompt, cwd: body.cwd || cfg.cwd, model: body.model, resume: body.resume, appendSystem: c.system, autonomous: body.autonomous !== false, maxTurns: body.maxTurns, title: body.title });
        const out = await waitForRun(r.sid, Math.max(1, Number(body.timeoutSec) || cfg.claudeTaskTimeoutSec) * 1000);
        return send(res, 200, { sid: r.sid, sessionId: r.sessionId, ...out });
      }
      if (req.method === "POST" && p === "/api/claude/run") {
        const body = await readBody(req);
        const c = await composePrompt("claude", body.prompt || "", { memory: body.memory, graph: body.graph, dir: body.cwd || cfg.cwd });
        const appendSystem = [body.appendSystem || "", c.system].filter(Boolean).join("\n\n");
        const r = claude.run({ prompt: body.prompt, cwd: body.cwd || cfg.cwd, model: body.model, resume: body.resume, appendSystem, autonomous: body.autonomous !== false, maxTurns: body.maxTurns });
        return send(res, 200, r);
      }
      if (req.method === "POST" && p === "/api/claude/abort") { const body = await readBody(req); return send(res, 200, { ok: claude.abort(body.sid) }); }
      // memory
      if (p.startsWith("/api/memory/")) {
        const body = req.method === "GET" || req.method === "DELETE" ? {} : await readBody(req);
        switch (p) {
          case "/api/memory/list": return send(res, 200, { notes: await vault.list(q.get("dir") || "") });
          case "/api/memory/search": return send(res, 200, { hits: (await vault.search(q.get("q") || "", { limit: Number(q.get("limit") || 20), dir: q.get("dir") || "" })).map(({ body: _b, ...h }) => h) });
          case "/api/memory/note":
            if (req.method === "GET") return send(res, 200, await vault.read(q.get("path")));
            if (req.method === "PUT") return send(res, 200, await vault.write(body.path, body.text));
            if (req.method === "DELETE") { await vault.remove(q.get("path")); return send(res, 200, { ok: true }); }
            break;
          case "/api/memory/save": return send(res, 200, await vault.save(body));
          case "/api/memory/import-claude": return send(res, 200, { imported: await vault.importClaudeMemory(cfg.claudeProjectsDir) });
          case "/api/memory/reindex": return send(res, 200, { notes: await vault.rebuildIndex() });
          case "/api/memory/pack": { const pack = await vault.pack(q.get("q") || "", { budgetTokens: Number(q.get("budget") || cfg.memoryBudgetTokens) }); return send(res, 200, { pack, tokens: estimateTokens(pack) }); }
          case "/api/memory/graph": return send(res, 200, await vault.graph());
          case "/api/memory/digest": { const d = await watcher.digestData(body.sid); if (!d) return send(res, 404, { error: "unknown session" }); return send(res, 200, await vault.writeSessionDigest(d)); }
          case "/api/memory/open-vault": { spawn(process.platform === "win32" ? "explorer" : process.platform === "darwin" ? "open" : "xdg-open", [cfg.vaultDir], { detached: true, stdio: "ignore", windowsHide: true }).unref(); return send(res, 200, { ok: true }); }
          default: return send(res, 404, { error: "unknown memory route" });
        }
      }
      // graphs
      if (p.startsWith("/api/graph/")) {
        const body = req.method === "GET" ? {} : await readBody(req);
        switch (p) {
          case "/api/graph/list": return send(res, 200, { graphs: await graph.listGraphs(vault), current: q.get("sid") ? graphDirFor(q.get("sid")) : null });
          case "/api/graph/build": {
            const dir = body.dir || cfg.cwd;
            if (!existsSync(dir)) return send(res, 400, { error: "directory not found" });
            const name = body.name || dir.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
            bus.emit({ sid: "omni", harness: "omni", kind: "log", ts: Date.now(), level: "system", text: `Building graph for ${dir}…` });
            const g = await graph.build(dir, { bin: cfg.graphifyBin, onLine: (t) => bus.emit({ sid: "omni", harness: "omni", kind: "log", ts: Date.now(), level: "graphify", text: t.trim() }) });
            const out = await graph.exportToVault(vault, name, g, { dir, mode: body.mode || "files" });
            bus.emit({ sid: "omni", harness: "omni", kind: "log", ts: Date.now(), level: "system", text: `Graph ready: ${g.nodes.length} nodes, ${out.notes} notes in vault/${out.dir}` });
            return send(res, 200, { name, dir, nodes: g.nodes.length, links: g.links.length, vault: out.dir, notes: out.notes });
          }
          case "/api/graph/data": {
            const dir = q.get("dir");
            if (!dir || !existsSync(graph.graphPath(dir))) return send(res, 404, { error: "no graph for that directory; build one first" });
            const g = await graph.load(dir);
            const c = q.get("community");
            return send(res, 200, graph.summary(g, { limit: Number(q.get("limit") || 150), q: q.get("q") || "", community: c != null && c !== "" ? Number(c) : undefined }));
          }
          case "/api/graph/query": { const dir = body.dir; if (!dir || !existsSync(graph.graphPath(dir))) return send(res, 404, { error: "no graph for that directory" }); return send(res, 200, { answer: await graph.query(dir, body.question, { budget: body.budget || cfg.graphBudgetTokens, bin: cfg.graphifyBin, dfs: !!body.dfs }) }); }
          case "/api/graph/explain": { const dir = body.dir; if (!dir || !existsSync(graph.graphPath(dir))) return send(res, 404, { error: "no graph for that directory" }); return send(res, 200, { answer: await graph.explain(dir, body.node, { bin: cfg.graphifyBin }) }); }
          default: return send(res, 404, { error: "unknown graph route" });
        }
      }
      // files
      if (p.startsWith("/api/fs/")) {
        const isGet = req.method === "GET" || req.method === "HEAD";
        const b = isGet ? {} : await readBody(req);
        const root = (isGet ? q.get("root") : b.root) || cfg.cwd;
        const path = (isGet ? q.get("path") : b.path) || "";
        // files.mjs reads what it is given as text: only text is a path here.
        if ([root, path, b.to].some((v) => v != null && typeof v !== "string")) return send(res, 400, { error: "root, path and to must be text" });
        if (!fsRootAllowed(req, root)) return send(res, 403, { error: "that folder is not a known session folder" });
        // A password viewer is kept to the folders above, so a link in one does not lead out. The host and a device may browse anywhere.
        if (!req.omniHost && !req.omniChannel) for (const rel of [path, b.to]) if (rel != null && files.safeResolve(root, rel) && !(await files.staysInside(root, rel))) return send(res, 403, { error: "that link leads outside the folder" });
        if (isGet) switch (p) {
          case "/api/fs/list": return send(res, 200, { entries: await files.listDir(root, path) });
          case "/api/fs/read": return send(res, 200, await files.readFileInfo(root, path));
          case "/api/fs/text": return send(res, 200, await files.readAsText(root, path, { encoding: q.get("encoding") === "latin1" ? "latin1" : "utf8" }));
          case "/api/fs/hex": return send(res, 200, await files.readHex(root, path, q.get("offset"), q.get("length")));
          case "/api/fs/raw": return await files.serveRaw(req, res, root, path, { download: q.get("download") === "1" });
          case "/api/fs/archive-entry": return send(res, 200, await files.readArchiveEntry(root, path, q.get("entry") || ""));
        }
        if (req.method === "POST") switch (p) {
          case "/api/fs/write": return send(res, 200, await files.writeText(root, path, { content: b.content, encoding: b.encoding, eol: b.eol, baseHash: b.baseHash, force: !!b.force, create: !!b.create }));
          case "/api/fs/create": return send(res, 200, await files.createEntry(root, path, { dir: !!b.dir }));
          case "/api/fs/rename": return send(res, 200, await files.renameEntry(root, path, b.to));
          case "/api/fs/duplicate": return send(res, 200, await files.duplicateEntry(root, path));
          case "/api/fs/delete": return send(res, 200, await files.deleteEntry(root, path, { permanent: !!b.permanent, ...(cfg.fsTrash ? { trash: cfg.fsTrash } : {}) }));
          case "/api/fs/reveal": return send(res, 200, files.reveal(root, path));
        }
        return send(res, 404, { error: "unknown file route" });
      }
      return send(res, 404, { error: "not found" });
    } catch (e) {
      if (res.headersSent) { try { res.end(); } catch { /* */ } return; }
      // What a file save or delete needs to tell apart: a conflict, a binary, a trash that failed.
      const extra = Object.fromEntries(["conflict", "hash", "gone", "binary", "trashFailed"].filter((k) => e?.[k] != null).map((k) => [k, e[k]]));
      const status = e?.status || (e?.code === "ENOENT" ? 404 : e?.code === "EEXIST" ? 409 : 500);
      return send(res, status, { error: String(e?.message || e), ...extra });
    }
  }

  const server = createServer((req, res) => handle(req, res));

  let certCache = null;
  const loadCert = () => (certCache ||= loadOrCreateCert({ dir: cfg.tlsDir, certFile: cfg.tlsCert, keyFile: cfg.tlsKey, altNames: [...lanAddresses().map((a) => a.address), ...(cfg.relay?.host ? [cfg.relay.host] : [])], log: (t) => log(`  ${t}`) }));
  /** Limits for a listener strangers reach: slow or idle clients are cut off, and connections are capped.
   *  requestTimeout covers receiving a request, not the wait for an approval after it. */
  function harden(srv) {
    srv.headersTimeout = 15_000;
    srv.requestTimeout = 60_000;
    srv.keepAliveTimeout = 10_000;
    srv.maxConnections = 256;
    srv.maxHeadersCount = 100;
    return srv;
  }

  /** Other devices' listener: every interface, HTTPS when a certificate can be had. Every request on it is remote. */
  async function listenRemote() {
    let tls = null;
    if (cfg.remoteTls !== false) {
      tls = loadCert();
      if (tls.error) { log(`  remote HTTPS unavailable (${tls.error}); serving plain HTTP: passwords cross the network readable`); tls = null; }
    }
    const onReq = (req, res) => handle(req, res, { remoteListener: true });
    const srv = harden(tls ? createHttpsServer({ key: tls.key, cert: tls.cert }, onReq) : createServer(onReq));
    // With TLS a front sorts each connection by its first byte: a TLS handshake goes to the HTTPS server, a
    // plain-HTTP request (the address typed without https://, which is what a phone's browser then opens)
    // gets a redirect to https:// instead of a dropped connection.
    const front = tls ? createNetServer((sock) => {
      sock.on("error", () => {});
      const drop = setTimeout(() => sock.destroy(), 10_000);
      const first = () => {
        const c = sock.read();
        if (c === null) return void sock.once("readable", first);
        clearTimeout(drop);
        if (c[0] === 0x16) { sock.unshift(c); srv.emit("connection", sock); return; }
        const local = String(sock.localAddress || "").replace(/^::ffff:/, "");
        const reply = httpsRedirect(c, `${local.includes(":") ? `[${local}]` : local}:${sock.localPort}`);
        if (reply) sock.end(reply); else sock.destroy();
      };
      sock.once("readable", first);
    }) : srv;
    if (tls) front.maxConnections = 256;
    try {
      await new Promise((r, j) => { front.once("error", j); front.listen(cfg.remotePort, cfg.remoteHost || "0.0.0.0", () => { front.off("error", j); r(); }); });
    } catch (e) { remote.error = e.message; log(`  remote listener could not start on port ${cfg.remotePort}: ${e.message}`); return; }
    Object.assign(remote, { server: srv, front, port: front.address().port, tls: tls ? { fingerprint: tls.fingerprint, selfSigned: tls.selfSigned } : null });
    const proto = tls ? "https" : "http";
    for (const a of lanAddresses()) log(`  other devices: ${proto}://${a.address}:${remote.port}/   (${a.name})`);
    log(`  from another network: forward TCP ${remote.port} on your router to this PC, then open ${proto}://<your public IP>:${remote.port}/`);
    log(`  remote browsers sign in with the host's password (${auth.hasPassword() ? "set" : "NOT SET: set it in Settings → Remote"}), see everything read-only, and every change waits for your approval here`);
    if (tls) log(`  certificate SHA-256 ${tls.fingerprint}${tls.selfSigned ? " (self-signed: the browser warns once; compare this fingerprint)" : ""}`);
    if (process.platform === "win32") log(`  if the firewall blocks it run scripts\\allow-lan.cmd ${remote.port} once`);
  }

  /** The VPS relay's way in: loopback only (nothing on the network can reach it; the SSH tunnel brings the
   *  VPS's connections here), HTTPS only, and every connection must open with the relay's PROXY line naming
   *  the visitor, or it is dropped. Everything on it is remote. */
  async function listenRelay() {
    const tls = loadCert();
    if (tls.error) { relay.error = `no certificate (${tls.error}); the relay never serves plain HTTP`; log(`  relay off: ${relay.error}`); return; }
    const srv = harden(createHttpsServer({ key: tls.key, cert: tls.cert }, (req, res) => handle(req, res, { remoteListener: true })));
    const front = createNetServer((sock) => {
      let acc = Buffer.alloc(0);
      const drop = setTimeout(() => sock.destroy(), 5000);
      sock.on("error", () => {});
      sock.pause();
      const onReadable = () => {
        let c;
        while ((c = sock.read()) !== null) {
          acc = Buffer.concat([acc, c]);
          const i = acc.indexOf("\r\n");
          if (i < 0) { if (acc.length > 107) { clearTimeout(drop); sock.destroy(); } continue; }
          sock.off("readable", onReadable);
          clearTimeout(drop);
          const ip = parseProxyLine(acc.subarray(0, i).toString("latin1"));
          if (!ip) { sock.destroy(); return; }
          sock.omniIp = ip;
          sock.unshift(acc.subarray(i + 2));
          srv.emit("connection", sock);
          return;
        }
      };
      sock.on("readable", onReadable);
    });
    front.maxConnections = 256;
    try {
      await new Promise((r, j) => { front.once("error", j); front.listen(cfg.relay.localPort, "127.0.0.1", () => { front.off("error", j); r(); }); });
    } catch (e) { relay.error = e.message; log(`  relay listener could not start on 127.0.0.1:${cfg.relay.localPort}: ${e.message}`); return; }
    Object.assign(relay, { server: srv, front, port: front.address().port, fingerprint: tls.fingerprint, selfSigned: tls.selfSigned, error: null });
    log(`  internet: https://${cfg.relay.host}:${cfg.relay.publicPort}/  (through the VPS relay; no router port forward)`);
    if (!cfg.relayNoTunnel) {
      tunnel = new SshTunnel({ host: cfg.relay.host, user: cfg.relay.user, key: cfg.relay.key, knownHosts: cfg.relay.knownHosts, remotePort: cfg.relay.remotePort, localPort: relay.port, spawn: cfg.tunnelSpawn, log: (t) => log(`  ${t}`) });
      tunnel.start();
    }
  }

  async function listen() {
    // The agent registry is loaded BEFORE the server answers anything: an empty manager would tell a reconnecting
    // delivery poller there is nothing to deliver, and its first save would overwrite agents.json. Agents that were
    // running when Omni last stopped come back interrupted (their processes are gone); finished reports not yet
    // delivered stay, so the parent chat still gets them.
    agents.reconcile();
    // After the agents: a mission's interrupted workers are reported to its orchestrator, which is reopened on its session.
    missions.reconcile();
    await new Promise((r) => server.listen(cfg.port, cfg.host, r));
    log(`Omni Agent on http://127.0.0.1:${cfg.port}  vault=${cfg.vaultDir}`);
    account?.start(); // never awaited: local use does not wait for the hub, or for the key store
    if (cfg.lan) await listenRemote();
    if (cfg.relay?.host) await listenRelay();
    await watcher.start();
    log(`watching ${watcher.tails.size} session files (${registry.list().length} known sessions)`);
    // Agent chats keep their place under their parent (only chats the watcher found: a deleted one is not recreated blank).
    for (const a of agents.list()) if (a.sid && a.parentSid && registry.get(a.sid)) registry.upsert(a.sid, { parentSid: a.parentSid, agentId: a.id, agentKind: a.kind });
    if (cfg.autoStartPi) {
      startPi(cfg.cwd);
      restoreGoal().catch((e) => log("could not restore the saved goal", e.message));
    }
    keeper.startHeartbeat?.();
    return server;
  }

  /** After a restart, put the main pi back on the newest unfinished explicit goal's chat; the heartbeat carries on. */
  async function restoreGoal() {
    // Only a goal that was live recently: an abandoned one from days ago must not hijack the next start.
    const d = loadGoals().filter((x) => x.file && existsSync(x.file) && !x.paused && !x.done && Date.now() - (x.savedAt || 0) < 72 * 3600000).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))[0];
    if (!d || !pi) return;
    await pi.waitReady();
    if (!sameDir(pi.cwd, d.cwd) && d.cwd && existsSync(d.cwd)) { stopPi(pi); startPi(d.cwd); await pi.waitReady(); }
    await pi.switchSession(d.file);
    keeper.importGoal(pi.sid, d, { resume: true });
    // Re-arm the hook only if it was on when the goal was saved (a user who runs with it off keeps context-only mode).
    if (d.hookEnabled !== false && !keeper.config.enabled) keeper.setConfig({ ...keeper.config, enabled: true });
    log(`restored goal on ${pi.sid}: ${String(d.text).slice(0, 80)}`);
  }

  function close() {
    clearInterval(digestTimer);
    saveGoals(); // before keeper.dispose(), which forgets every goal
    keeper.dispose();
    watcher.stop();
    authWatch?.stop();
    clearInterval(trimTimer);
    clearTimeout(pisTimer);
    for (const c of [...pis]) c.stop();
    // Before the agents stop: their "interrupted" reports are delivered by the next start's reconcile, not now.
    missions.dispose({ stopOrchestrators: true });
    agents.stopAll();
    agents.dispose();
    // The shared `opencode serve` never outlives Omni (an injected one is stopped too): its tree is ended before this
    // returns, since scripts exit right after close(). The exit hook stays (a later process.exit still kills).
    try { if (typeof opencode.killSync === "function") opencode.killSync(); else opencode.stop(); } catch (e) { log("could not stop opencode", e.message); }
    exitGuard?.release();
    claude.stopAll();
    approvals.dispose();
    machineLinks?.close();
    account?.stop();
    for (const res of accountStreams) { try { res.end(); } catch { /* */ } }
    for (const res of hostStreams) { try { res.end(); } catch { /* */ } }
    server.close();
    remote.front?.close();
    if (remote.front !== remote.server) remote.server?.closeAllConnections?.();
    tunnel?.stop();
    relay.front?.close();
    relay.server?.closeAllConnections?.();
  }

  return { server, remote, relay, account, handleChannelRequest: (req, res) => handle(req, res), get tunnel() { return tunnel; }, listen, close, bus, vault, registry, tally, watcher, claude, keeper, agents, missions, projects, auth, approvals, get pi() { return pi; }, get pis() { return [...pis]; }, startPi, opencode, cfg };
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}` || process.argv[1]?.endsWith("index.mjs")) {
  const app = await createApp();
  await app.listen();
  const bye = () => { app.close(); process.exit(0); };
  process.on("SIGINT", bye);
  process.on("SIGTERM", bye);
  // Closing the console window on Windows (SIGHUP) and Ctrl+Break (SIGBREAK).
  process.on("SIGHUP", bye);
  if (process.platform === "win32") process.on("SIGBREAK", bye);
  // A multi-day unattended run must survive a stray error: log and keep the process up.
  process.on("uncaughtException", (e) => log("uncaughtException", e?.stack || e));
  process.on("unhandledRejection", (e) => log("unhandledRejection", e?.stack || e));
}
