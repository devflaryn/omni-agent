/**
 * Omni Agent server. Node built-ins only.
 *
 *   node server/index.mjs [--port 4400] [--cwd <dir>] [--model <id>] [--provider <p>] [--no-pi]
 */
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { promises as fs, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { CONFIG, ROOT, contextConfig, hookConfig, lanAddresses, piChildEnv, writeConfigFile } from "./config.mjs";
import { AgentManager } from "./agents.mjs";
import { handleAgentRoutes } from "./agent-routes.mjs";
import { applyContextCaps } from "./context-policy.mjs";
import * as graph from "./graph.mjs";
import { Bus } from "./bus.mjs";
import { PiRpc, PI_THINKING_LEVELS } from "./pi-rpc.mjs";
import { GoalKeeper, JUDGE_SYSTEM, SUMMARY_SYSTEM, runJudge } from "./hook.mjs";
import { ClaudeRunner } from "./claude-runner.mjs";
import { planContinue } from "./continue.mjs";
import { filterPiModels } from "./pi-models.mjs";
import { listMcpServers, upsertMcpServer, removeMcpServer, testMcpServer } from "./mcp.mjs";
import { PRESETS, PI_APIS, listProviders, upsertProvider, removeProvider, reorderProviders, flatModels } from "./providers.mjs";
import { isArchiveName, listZipEntries, readZipEntry } from "./zip.mjs";
import { SessionRegistry, SessionWatcher, titleFrom } from "./watchers.mjs";
import { Vault } from "./memory.mjs";
import { createTally, estimateTokens } from "./tokens.mjs";
import { createServer as createNetServer } from "node:net";
import { Approvals, COOKIE, DEVICE_COOKIE, RemoteAuth, classify, clientIp, describe, isHostRequest, parseCookies, parseProxyLine, redact } from "./access.mjs";
import { loadOrCreateCert } from "./tls.mjs";
import { SshTunnel } from "./tunnel.mjs";

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

export async function createApp(overrides = {}) {
  const cfg = { ...CONFIG, ...overrides };
  // Under `node --test`, Omni's own state files never default to the real ~/.omni-agent, and the context cap
  // never rewrites the real ~/.pi/agent/models.json: a test that wants them passes its own paths.
  // node --test sets NODE_TEST_CONTEXT only with per-file isolation; also catch --test-isolation=none and a test file run directly.
  const underTest = !!process.env.NODE_TEST_CONTEXT || process.execArgv.includes("--test") || /\.test\.m?js$/i.test(process.argv[1] || "");
  if (underTest) {
    const tmp = mkdtempSync(join(tmpdir(), "omni-state-"));
    for (const k of ["agentsFile", "goalsFile", "contextCapsFile"]) if (!(k in overrides)) cfg[k] = join(tmp, `${k}.json`);
    if (!("agentsDir" in overrides)) cfg.agentsDir = join(tmp, "agents");
    if (!("piModelsFile" in overrides)) cfg.contextCaps = false;
    if (!("persistContext" in overrides)) cfg.persistContext = false;
  }
  // Another Omni on another port (headless.mjs, a scratch instance) keeps its own registry and goals: each server
  // rewrites those files whole from its own memory, so sharing them lets the last one to exit erase the other's.
  if (cfg.port && cfg.port !== CONFIG.port) {
    for (const k of ["agentsFile", "goalsFile"]) if (!(k in overrides)) cfg[k] = String(cfg[k]).replace(/\.json$/, `-${cfg.port}.json`);
    if (!("agentsDir" in overrides)) cfg.agentsDir = `${cfg.agentsDir}-${cfg.port}`;
  }
  const bus = new Bus();
  const tally = createTally();
  const registry = new SessionRegistry();
  const vault = new Vault(cfg.vaultDir).ensure();
  const claude = new ClaudeRunner({ bin: cfg.claudeBin, bus, spawn: cfg.claudeSpawn });
  const auth = cfg.remoteAuth || new RemoteAuth({ file: cfg.remoteAuthFile, sessionTtlMs: (cfg.remoteSessionDays || 7) * 86_400_000 });
  const approvals = new Approvals({ timeoutMs: (cfg.remoteApprovalTimeoutSec || 300) * 1000 });
  /** The remote listener, once it listens: { server, port, tls: { fingerprint, selfSigned } | null, error }. */
  const remote = { server: null, port: null, tls: null, error: null };
  /** The VPS relay's loopback listener: { server, front, port, fingerprint, selfSigned, error }. */
  const relay = { server: null, front: null, port: null, fingerprint: null, selfSigned: false, error: null };
  let tunnel = null;
  /** Host browsers' event streams: only they hear about pending approvals. */
  const hostStreams = new Set();
  approvals.on("change", (list) => { const line = `event: approvals\ndata: ${JSON.stringify(list)}\n\n`; for (const res of hostStreams) { try { res.write(line); } catch { hostStreams.delete(res); } } });
  let pi = null;
  // The durable run ledger. Null in normal GUI use; the unattended runner (scripts/run.mjs) opens one
  // via cfg so the goal + counters persist and survive a pi restart. Every use is guarded with `?.`.
  let runLedger = cfg.runLedger || null;
  /** Background agents the agents start (pi subagents, Claude Code sessions, shell jobs); created after the keeper. */
  let agents = null;
  /** The compaction point changed while pi was busy: restart it at its next settle. */
  let capsRestartPending = false;

  const isOwned = (file) => (pi?.owns(file) ?? false) || claude.owns(file) || (agents?.owns(file) ?? false);
  const watcher = new SessionWatcher({ piSessionsDir: cfg.piSessionsDir, claudeProjectsDir: cfg.claudeProjectsDir, bus, tally, registry, isOwned, recentHours: cfg.tailRecentHours, log });
  // A thin proxy so the keeper always reads the *current* runLedger (which may be set/replaced later).
  const ledgerProxy = { writeControl: (p) => runLedger?.writeControl(p), goalText: () => runLedger?.goalText() || "" };
  // Goal hook: re-engages pi while its plan (the `plan` tool) has unfinished steps — no model decides that.
  const keeper = new GoalKeeper({
    bus, log,
    // Background pi agents have a PiRpc of their own: the keeper watches and re-engages them too.
    getPi: (sid) => (pi?.proc && pi.sid === sid ? pi : null) || agents?.piFor(sid) || null,
    contextPolicy: cfg.context,
    maxTokensFor: (sid) => Number(keeper.getPi(sid)?.state?.model?.maxTokens) || 0,
    // Only agents count: a long-lived shell job (a dev server, logcat) must not hold every recovery back until it exits.
    activeChildren: (sid) => agents?.activeChildren(sid, { kinds: ["pi", "claude"] }) || 0,
    // Opt-in only (hook.judgeFallback): a judge model for work the agent did without a plan.
    judge: cfg.judge || ((input, pick) => runJudge({ cli: cfg.piCli, bin: cfg.piBin, provider: pick.provider, model: pick.model, env: piChildEnv(cfg), cwd: pi?.cwd || cfg.cwd, spawn: cfg.judgeSpawn, timeoutMs: keeper.config.judgeTimeoutMs }, { system: JUDGE_SYSTEM, input })),
    // The status box: a side conversation of its own per goal (its own pi session file), chat model by default.
    summarize: cfg.summarize || ((input, pick) => runJudge({ cli: cfg.piCli, bin: cfg.piBin, provider: pick.provider, model: pick.model, env: piChildEnv(cfg), cwd: pi?.cwd || cfg.cwd, spawn: cfg.judgeSpawn, timeoutMs: keeper.config.judgeTimeoutMs, conversation: pick.conversation && cfg.statusSessionsDir ? { dir: cfg.statusSessionsDir, id: pick.conversation } : null }, { system: SUMMARY_SYSTEM, input })),
    config: hookConfig(cfg.hook),
    ledger: ledgerProxy,
    onEscalate: async (sid, g) => { runLedger?.appendEvent?.({ kind: "escalate", sid, nudges: g.nudges, fingerprint: g.lastFingerprint }); },
  });

  /** Cap each model's effective window in models.json so pi compacts at cfg.context.compactAt (server/context-policy.mjs). */
  function applyCaps(compactAt = cfg.context?.compactAt ?? 0) {
    if (cfg.contextCaps === false || (cfg.createPi && !overrides.contextCapsFile)) return null;
    const r = applyContextCaps({ modelsFile: cfg.piModelsFile, settingsFile: cfg.piSettingsFile, stateFile: cfg.contextCapsFile, compactAt });
    if (r.error) log("context caps:", r.error);
    for (const c of r.changes || []) log(`context cap ${c.key}: ${c.from ?? "none"} -> ${c.to ?? "none"}`);
    return r;
  }

  // OMNI_MEMORY=server tells omni-memory that the server attaches the vault pack per prompt; nobody does that for
  // a background agent, so its own omni-memory does the recall.
  const agentEnv = () => { const { OMNI_MEMORY: _serverPack, ...e } = piChildEnv(cfg); return e; };
  const agentPiEnv = agentEnv();
  agents = cfg.agentManager || new AgentManager({
    bus, config: cfg.agents, file: cfg.agentsFile, dir: cfg.agentsDir, piAgentDir: cfg.piAgentDir,
    claude, keeper, piEnv: agentPiEnv, shellPath: cfg.agentShell || "", cwd: cfg.cwd, log,
    // A Claude agent asked for memory gets the vault pack (and repo graph) the old /api/claude/task gave it.
    composeSystem: async (rec, text) => (await composePrompt("claude", text, { memory: rec.memory, graph: rec.graph, dir: rec.cwd })).system,
    createPi: cfg.createAgentPi || ((o) => {
      applyCaps();
      // Always node + cli.js: the pi.cmd fallback would let cmd.exe split a persona's multi-line system prompt.
      // Key files are re-read per launch (a key changed after Omni started still reaches a new agent); OMNI_AGENT_* stay.
      const child = new PiRpc({ cli: cfg.piCli, bin: cfg.piBin, bus, cwd: o.cwd, provider: o.model ? o.provider : cfg.piProvider, model: o.model || cfg.piModel, thinking: o.thinking || cfg.piThinking, env: { ...o.env, ...agentEnv() }, extraArgs: o.extraArgs, meta: o.meta });
      child.startWatchdog({ stallMs: cfg.stallMs, toolStallMs: cfg.toolStallMs });
      return child;
    }),
  });

  /** Explicit goals survive an Omni restart (cfg.goalsFile): the goal, its chat's session file and cwd. */
  function saveGoals() {
    // An unattended run (scripts/run.mjs) keeps its goal in its own ledger; it must never be reopened by the GUI.
    if (cfg.runLedger) return;
    // savedAt = the chat's last activity (not the save time), so re-saving on every shutdown never makes a stale goal look live.
    const mine = keeper.exportGoals().filter((d) => !d.managed).map((d) => ({ ...d, hookEnabled: !!keeper.config.enabled, savedAt: registry.get(d.sid)?.lastActivity || d.startedAt || Date.now(), file: registry.get(d.sid)?.file || (pi?.sid === d.sid ? pi.state?.sessionFile : "") || "", cwd: registry.get(d.sid)?.cwd || pi?.cwd || cfg.cwd }));
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
    if (ev.kind === "log" || ev.kind === "removed" || ev.kind === "agent") return;
    const s = registry.upsert(ev.sid, {});
    if (ev.kind === "session") registry.upsert(ev.sid, { cwd: ev.cwd, title: ev.title, model: ev.model, file: ev.file, owned: ev.owned, streaming: ev.streaming, forkedFrom: ev.forkedFrom, ...(ev.parentSid ? { parentSid: ev.parentSid, agentId: ev.agentId, agentKind: ev.agentKind } : {}) });
    // Invariant: run.json.sessionFile always names pi's current session file, and pi.resumeFile mirrors it.
    // Gated on !pi.restoring so the transient empty session a fresh child opens during a crash restart
    // cannot clobber the resume anchor before resumeSession() reads it (C1).
    // A background pi agent announces an owned session too; it must never become the main chat's resume anchor.
    if (ev.kind === "session" && ev.owned && ev.harness === "pi" && ev.file && !ev.agentId && !pi?.restoring) {
      runLedger?.writeControl({ sessionFile: ev.file });
      if (pi) pi.resumeFile = ev.file;
    }
    if (ev.kind === "status") s.streaming = !!ev.streaming;
    // A compaction point changed while the main pi was busy: it reads models.json only at boot, so restart it at this settle.
    if (ev.kind === "status" && ev.streaming === false && capsRestartPending && pi?.sid === ev.sid) {
      capsRestartPending = false;
      setTimeout(() => { if (pi?.proc && !pi.streaming) restartPi().catch((e) => log("pi restart for the new compaction point failed", e.message)); else capsRestartPending = true; }, 0);
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

  function startPi(cwd = cfg.cwd) {
    if (pi) pi.stop();
    applyCaps();
    pi = cfg.createPi ? cfg.createPi({ cwd, bus, model: cfg.piModel, provider: cfg.piProvider, thinking: cfg.piThinking }) : new PiRpc({ cli: cfg.piCli, bin: cfg.piBin, cwd, model: cfg.piModel, provider: cfg.piProvider, thinking: cfg.piThinking, env: piChildEnv(cfg), bus });
    // The auto-restart path re-attaches the goal: keeper._lastSid holds the pre-restart sid, pi.sid the new one (C1).
    // The killed run never reported a settle of its own, so the heartbeat re-checks the goal instead of relying on one.
    pi.onRestart = async () => { keeper.attachToSid(keeper._lastSid, pi.sid); const g = keeper.goal(pi.sid); if (g && !g.done && !g.paused) g.recheck = true; };
    pi.start();
    pi.startWatchdog?.({ stallMs: cfg.stallMs, toolStallMs: cfg.toolStallMs });
    return pi;
  }
  /** pi reads models.json only at boot: after a provider change, relaunch the child and put it back on the session it had open. */
  async function restartPi() {
    if (!pi?.proc) return false;
    const { cwd } = pi;
    const file = pi.state?.sessionFile;
    const prevSid = pi.sid;
    startPi(cwd);
    try { await pi.waitReady(); if (file) await pi.switchSession(file); }
    catch (e) { log("pi restart: could not restore the session", e.message); }
    // Move the keeper's goal + counters onto pi's new session id so a restart never drops the goal.
    keeper.attachToSid(prevSid, pi.sid);
    if (pi) { pi.resumeFile = pi.state?.sessionFile || file; runLedger?.writeControl({ sessionFile: pi.resumeFile }); }
    return true;
  }

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

  // ------------------------------------------------------------- file browser
  function safeResolve(root, rel) {
    const abs = resolve(root, rel || ".");
    const r = relative(root, abs);
    if (r.startsWith("..") || (r.length && r.split(sep)[0] === "..")) return null;
    return abs;
  }
  /** The host browses any folder. A remote viewer only the folders Omni works in (the chats' working
   *  directories, the default one and the vault), never the rest of the disk. */
  const normDir = (d) => { const r = resolve(String(d)); return process.platform === "win32" ? r.toLowerCase() : r; };
  function fsRootAllowed(req, root) {
    if (!String(root || "").trim()) return false;
    if (req.omniHost) return true;
    const allowed = new Set([cfg.cwd, cfg.vaultDir, pi?.cwd, ...registry.list().map((s) => s.cwd)].filter(Boolean).map(normDir));
    return allowed.has(normDir(root));
  }
  const TEXT_EXT = new Set([".txt", ".md", ".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".py", ".sh", ".bash", ".ps1", ".cmd", ".bat", ".html", ".css", ".xml", ".yml", ".yaml", ".toml", ".ini", ".cfg", ".conf", ".log", ".java", ".kt", ".c", ".h", ".cpp", ".rs", ".go", ".rb", ".php", ".sql", ".smali", ".gradle", ".properties", ".env", ".gitignore", ".csv", ".jsonl"]);
  async function listDir(root, rel) {
    const abs = safeResolve(root, rel);
    if (!abs) throw new Error("path outside root");
    const entries = await fs.readdir(abs, { withFileTypes: true });
    return entries
      .filter((e) => !e.name.startsWith(".git") && e.name !== "node_modules")
      .map((e) => ({ name: e.name, dir: e.isDirectory(), path: relative(root, join(abs, e.name)).split(sep).join("/") }))
      .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  }
  const IMAGE_MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".bmp": "image/bmp", ".ico": "image/x-icon", ".avif": "image/avif" };
  const TEXT_MAX = 2 * 1024 * 1024, ARCHIVE_MAX = 400 * 1024 * 1024, IMAGE_MAX = 20 * 1024 * 1024;
  const looksText = (buf) => !buf.subarray(0, 8000).includes(0);
  /** What the explorer preview needs: `kind` decides the renderer. */
  async function readFileSafe(root, rel) {
    const abs = safeResolve(root, rel);
    if (!abs) throw new Error("path outside root");
    const st = await fs.stat(abs);
    const ext = extname(abs).toLowerCase(), size = st.size;
    if (IMAGE_MIME[ext]) return { kind: "image", ext, size, mime: IMAGE_MIME[ext], tooBig: size > IMAGE_MAX };
    if (isArchiveName(abs)) {
      if (size > ARCHIVE_MAX) return { kind: "archive", ext, size, tooBig: true, entries: [] };
      const entries = listZipEntries(await fs.readFile(abs)).map(({ offset: _o, ...e }) => e);
      return { kind: "archive", ext, size, entries };
    }
    if (size > TEXT_MAX) return { kind: "binary", ext, size, tooBig: true };
    if (!(TEXT_EXT.has(ext) || !ext)) return { kind: "binary", ext, size, binary: true };
    const buf = await fs.readFile(abs);
    if (!looksText(buf)) return { kind: "binary", ext, size, binary: true };
    return { kind: ext === ".md" ? "markdown" : "text", content: buf.toString("utf8"), ext, size };
  }
  async function readArchiveEntry(root, rel, entryPath) {
    const abs = safeResolve(root, rel);
    if (!abs || !isArchiveName(abs)) throw new Error("not an archive");
    const buf = await fs.readFile(abs);
    const entry = listZipEntries(buf, { limit: Infinity }).find((e) => e.path === entryPath);
    if (!entry) throw Object.assign(new Error("no such entry in the archive"), { status: 404 });
    if (entry.dir) return { kind: "binary", path: entry.path, size: 0 };
    if (entry.size > TEXT_MAX) return { kind: "binary", path: entry.path, size: entry.size, tooBig: true };
    const data = readZipEntry(buf, entry);
    const ext = extname(entry.path).toLowerCase();
    if (IMAGE_MIME[ext]) return { kind: "image", path: entry.path, size: entry.size, mime: IMAGE_MIME[ext], data: data.toString("base64") };
    if (!looksText(data)) return { kind: "binary", path: entry.path, size: entry.size, binary: true };
    return { kind: ext === ".md" ? "markdown" : "text", path: entry.path, size: entry.size, content: data.toString("utf8") };
  }

  // ------------------------------------------------------------------ http
  const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
  function send(res, code, body, type = "application/json") {
    res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
    res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  }
  /** Read once and kept on the request: the approval gate reads a remote body before the route does. */
  async function readBody(req) {
    if (req.omniBody) return req.omniBody;
    // A remote body is capped (16 KB before sign-in, 32 MB after: pasted images); the host's is not.
    const cap = req.omniHost ? Infinity : req.omniSignedIn ? 32 * 1024 * 1024 : 16 * 1024;
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > cap) { req.destroy(); throw Object.assign(new Error("request too large"), { status: 413 }); }
      chunks.push(c);
    }
    const s = Buffer.concat(chunks).toString("utf8");
    req.omniBody = s ? JSON.parse(s) : {};
    return req.omniBody;
  }
  const requirePi = () => { if (!pi?.proc) throw new Error("pi is not running (POST /api/pi/start)"); return pi; };

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
    const s = registry.get(sid);
    if (!s) throw Object.assign(new Error("unknown session"), { status: 404 });
    if (!body.message?.trim()) throw Object.assign(new Error("empty message"), { status: 400 });
    // Omni's main pi must never open a session file a running agent's own pi is still writing.
    const busy = activeAgentIn(sid, s.file);
    if (busy) throw agentBusyError(busy);
    const plan = planContinue(s, { liveWindowMs: cfg.liveWindowMs, piAlive: !!pi?.proc, piSid: pi?.sid, piStreaming: !!pi?.streaming, claudeAlive: !!claude.runs.get(sid)?.alive, forceFork: !!body.fork });
    if (plan.action === "error") throw Object.assign(new Error(plan.error), { status: plan.status });
    const dir = s.cwd || cfg.cwd;
    if (plan.action === "claude") {
      const p = await composePrompt("claude", body.message, { memory: body.memory, graph: body.graph, dir });
      const r = claude.run({ prompt: p.text, cwd: plan.cwd || cfg.cwd, resume: plan.resume, fork: plan.fork, forkedFrom: plan.fork ? sid : null, model: body.model, appendSystem: p.system, autonomous: body.autonomous !== false });
      return { sid: r.sid, pending: r.pending, forked: plan.fork, forkedFrom: plan.fork ? sid : null };
    }
    const p = await composePrompt("pi", body.message, { memory: body.memory, graph: body.graph, dir });
    if (plan.action === "pi-prompt") { await pi.prompt(p.text, { images: body.images }); return { sid: pi.sid, pending: false, forked: false, forkedFrom: null }; }
    if (plan.start) { startPi(plan.cwd || cfg.cwd); await pi.waitReady(); }
    try {
      await pi.switchSession(plan.file);
      if (plan.clone) {
        await pi.clone();
        bus.emit({ sid: pi.sid, harness: "pi", kind: "session", ts: Date.now(), owned: true, forkedFrom: sid, cwd: pi.cwd, file: pi.state?.sessionFile });
      }
    } catch (e) { throw Object.assign(e, { status: e.status || 409 }); }
    await pi.prompt(p.text, { images: body.images });
    return { sid: pi.sid, pending: false, forked: !!plan.clone, forkedFrom: plan.clone ? sid : null };
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
      req.omniHost = isHostRequest(req, { remoteListener });
      if (!req.omniHost && (await remoteGate(req, res, p))) return;
      if (req.method === "GET" && p === "/api/remote/me") return send(res, 200, { role: req.omniHost ? "host" : "remote" });
      if (p.startsWith("/api/remote/")) return remoteAdmin(req, res, p);
      // static UI
      if (req.method === "GET" && (p === "/" || p === "/index.html")) return send(res, 200, await fs.readFile(join(ROOT, "ui", "index.html")), MIME[".html"]);
      if (req.method === "GET" && /^\/[\w.-]+\.(js|mjs|css|svg|png|ico)$/.test(p)) {
        const f = join(ROOT, "ui", p.slice(1));
        if (!existsSync(f)) return send(res, 404, { error: "not found" });
        return send(res, 200, await fs.readFile(f), MIME[extname(f)] || "application/octet-stream");
      }
      // events
      if (req.method === "GET" && p === "/events") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        res.write(": omni\n\n");
        bus.addClient(res, Number(q.get("since") || 0));
        if (req.omniHost) { hostStreams.add(res); res.write(`event: approvals\ndata: ${JSON.stringify(approvals.list())}\n\n`); }
        const ka = setInterval(() => { try { res.write(": ka\n\n"); } catch { /* */ } }, 20000);
        req.on("close", () => { clearInterval(ka); bus.removeClient(res); hostStreams.delete(res); });
        return;
      }
      // state
      if (req.method === "GET" && p === "/api/state") {
        return send(res, 200, {
          config: { cwd: cfg.cwd, vault: cfg.vaultDir, port: cfg.port, piCli: cfg.piCli, piModelsFile: cfg.piModelsFile, claudeBin: cfg.claudeBin, memoryBudgetTokens: cfg.memoryBudgetTokens, liveWindowMs: cfg.liveWindowMs, lan: cfg.lan, lanUrls: remoteStatus().urls, piProvider: cfg.piProvider, piModel: cfg.piModel, piThinking: cfg.piThinking, context: cfg.context },
          access: { role: req.omniHost ? "host" : "remote", ...(req.omniHost ? { remote: remoteStatus() } : {}) },
          pi: pi ? { running: !!pi.proc, sid: pi.sid, cwd: pi.cwd, streaming: pi.streaming, state: pi.state } : { running: false },
          hook: keeper.config,
          goal: pi?.sid ? keeper.status(pi.sid) : null,
          runs: claude.list(),
          // A record can hold a 20 KB report and up to 500 are kept: the list carries a preview.
          agents: agents.list().slice(0, 200).map((a) => ({ ...a, resultText: (a.resultText || "").length > 2000 ? `${a.resultText.slice(0, 2000)}…` : a.resultText })),
          sessions: registry.list().map((s) => ({ ...s, tally: tally.has(s.sid) ? tally.get(s.sid) : null })),
          seq: bus.seq,
        });
      }
      let m;
      if (req.method === "GET" && (m = /^\/api\/sessions\/([^/]+)\/history$/.exec(p))) {
        const sid = decodeURIComponent(m[1]);
        const h = await watcher.history(sid);
        return send(res, 200, { ...h, session: registry.get(sid) || null });
      }
      if (req.method === "POST" && (m = /^\/api\/sessions\/([^/]+)\/continue$/.exec(p))) {
        return send(res, 200, await continueSession(decodeURIComponent(m[1]), await readBody(req)));
      }
      if (req.method === "DELETE" && (m = /^\/api\/sessions\/([^/]+)$/.exec(p))) {
        const sid = decodeURIComponent(m[1]);
        const s = registry.get(sid);
        if (!s) return send(res, 404, { error: "unknown session" });
        const live = s.owned || (pi?.owns(s.file) ?? false) || claude.owns(s.file || "") || (s.streaming && Date.now() - (s.lastActivity || 0) < cfg.liveWindowMs);
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
      // long-run settings: where pi compacts (Omni caps each model's effective window) and auto-continue after a context stop
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
          const caps = applyCaps(cfg.context.compactAt);
          // pi reads models.json only at boot: an idle pi restarts now, a busy one picks the cap up at its next restart.
          let restarted = false, pending = false;
          if (caps?.changed && pi?.proc) { if (!pi.streaming) restarted = await restartPi(); else pending = capsRestartPending = true; }
          return send(res, 200, { ok: true, context: cfg.context, caps: caps && { changed: caps.changed, changes: caps.changes, error: caps.error }, restarted, restartPending: pending });
        }
      }
      // explicit goal (the /goal command): set a persistent goal and arm the keeper
      if (p === "/api/goal") {
        if (req.method === "GET") return send(res, 200, keeper.status(q.get("sid") || pi?.sid));
        if (req.method === "POST" || req.method === "PUT") {
          if (!pi?.sid) return send(res, 400, { error: "no active pi session; start a chat first" });
          const goal = String((await readBody(req)).goal ?? "").trim();
          keeper.setExplicitGoal(pi.sid, goal);
          saveGoals();
          // Setting a goal arms the keeper so the agent is re-engaged until the goal is done.
          if (goal && !keeper.config.enabled) { keeper.setConfig({ ...keeper.config, enabled: true }); if (cfg.persistHook !== false) writeConfigFile({ hook: keeper.config }); }
          // The kickoff says up front that this goal is tracked by its plan (the keeper insists on one anyway).
          if (goal) { try { await pi.prompt(`${goal}\n\n(Tracked goal: first brainstorm and plan it with the plan tool, then work through the plan until every step is done.)`); } catch { /* goal is set + hook armed; the keeper will re-engage */ } }
          return send(res, 200, { goal, explicit: !!goal, enabled: keeper.config.enabled, started: !!goal });
        }
      }
      // providers (pi's models.json)
      if (req.method === "GET" && p === "/api/providers") {
        const mdl = pi?.state?.model;
        return send(res, 200, { providers: listProviders(cfg.piModelsFile), presets: PRESETS, apis: PI_APIS, file: cfg.piModelsFile, active: mdl ? { provider: mdl.provider, id: mdl.id } : null });
      }
      // Fallback priority: the provider order in models.json. pi's omni-fallback extension reads the file per switch, so no restart.
      if (req.method === "POST" && p === "/api/providers-order") {
        const body = await readBody(req);
        if (!Array.isArray(body.order)) return send(res, 400, { error: "order must be an array of provider names" });
        const order = reorderProviders(cfg.piModelsFile, body.order);
        return send(res, 200, { ok: true, order, providers: listProviders(cfg.piModelsFile) });
      }
      if ((req.method === "PUT" || req.method === "DELETE") && (m = /^\/api\/providers\/([^/]+)$/.exec(p))) {
        const name = decodeURIComponent(m[1]);
        if (req.method === "PUT") upsertProvider(cfg.piModelsFile, name, await readBody(req));
        else if (!removeProvider(cfg.piModelsFile, name)) return send(res, 404, { error: "unknown provider" });
        const restarted = await restartPi();
        return send(res, 200, { ok: true, restarted, providers: listProviders(cfg.piModelsFile) });
      }
      // MCP servers (pi's omni-agent.json → mcpServers). pi loads them at boot, so a change restarts it.
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
        const restarted = await restartPi();
        return send(res, 200, { ok: true, restarted, servers: listMcpServers(cfg.piExtConfigFile) });
      }
      // pi
      if (p.startsWith("/api/pi/")) {
        const body = req.method === "POST" ? await readBody(req) : {};
        switch (p) {
          case "/api/pi/start": { startPi(body.cwd || cfg.cwd); try { await pi.waitReady(); } catch { /* the UI polls /api/state */ } return send(res, 200, { ok: true, sid: pi.sid }); }
          case "/api/pi/stop": pi?.stop(); pi = null; return send(res, 200, { ok: true });
          // A new chat in one step (start pi there or open a new session, then prompt): what a remote
          // browser's Home sends, so the host approves one request instead of three.
          case "/api/pi/send": {
            if (!body.message?.trim()) return send(res, 400, { error: "empty" });
            const cwd = body.cwd || cfg.cwd;
            if (!pi?.proc || (pi.cwd || "").toLowerCase() !== String(cwd).toLowerCase()) { startPi(cwd); await pi.waitReady(); }
            else await pi.newSession();
            const c = await composePrompt("pi", body.message, { memory: body.memory, graph: body.graph, dir: graphDirFor(pi.sid) });
            await pi.prompt(c.text, { images: body.images });
            return send(res, 200, { ok: true, sid: pi.sid });
          }
          case "/api/pi/prompt": {
            const p0 = requirePi();
            if (!body.message?.trim()) return send(res, 400, { error: "empty" });
            const c = await composePrompt("pi", body.message, { memory: body.memory, graph: body.graph, dir: graphDirFor(p0.sid) });
            return send(res, 200, await p0.prompt(c.text, { images: body.images }));
          }
          case "/api/pi/abort": {
            // Stop halts this run and its goal (no re-engage until the user writes again). It used to also switch
            // the hook off globally and persist that, which silently left every later overnight run without one.
            const p0 = requirePi();
            keeper.cancel(p0.sid);
            // A full halt includes the chat's background agents: their reports would otherwise wake the stopped chat
            // and start new, unsupervised turns in it.
            const halted = agents.list({ parentSid: p0.sid, active: true });
            for (const a of halted) agents.cancel(a.id).catch((e) => log("could not stop agent", a.id, e.message));
            return send(res, 200, { ...(await p0.abort()), agentsStopped: halted.map((a) => a.id) });
          }
          case "/api/pi/new": return send(res, 200, await requirePi().newSession());
          case "/api/pi/switch": {
            const owner = registry.list().find((x) => x.file && body.file && resolve(x.file).toLowerCase() === resolve(body.file).toLowerCase());
            const busy = body.file && agents.owns(body.file) ? activeAgentIn(owner?.sid || "", body.file) || { id: "?" } : owner ? activeAgentIn(owner.sid, body.file) : null;
            if (busy) throw agentBusyError(busy);
            return send(res, 200, await requirePi().switchSession(body.file));
          }
          // Model and thinking level are remembered even when pi is not running yet: the next pi child starts with them.
          case "/api/pi/model": {
            if (!body.provider || !body.modelId) return send(res, 400, { error: "provider and modelId are required" });
            const r = pi?.proc ? await pi.setModel(body.provider, body.modelId) : { success: true, pending: true };
            if (r?.success !== false) { cfg.piProvider = body.provider; cfg.piModel = body.modelId; if (cfg.persistPiModel !== false) writeConfigFile({ piProvider: body.provider, piModel: body.modelId }); }
            return send(res, 200, { ...r, provider: cfg.piProvider, modelId: cfg.piModel });
          }
          case "/api/pi/thinking": {
            if (!PI_THINKING_LEVELS.includes(body.level)) return send(res, 400, { error: `level must be one of ${PI_THINKING_LEVELS.join(", ")}` });
            const r = pi?.proc ? await pi.setThinking(body.level) : { success: true, pending: true };
            if (r?.success !== false) { cfg.piThinking = body.level; if (cfg.persistPiModel !== false) writeConfigFile({ piThinking: body.level }); }
            return send(res, 200, { ...r, level: cfg.piThinking });
          }
          case "/api/pi/compact": return send(res, 200, await requirePi().compact());
          case "/api/pi/stats": return send(res, 200, await requirePi().stats());
          case "/api/pi/models": {
            // Omni's own provider config wins: only the models the user typed are listed. Without one, fall back to pi's catalogue.
            const own = flatModels(cfg.piModelsFile);
            if (own.length) return send(res, 200, { success: true, data: { models: own, source: "providers" } });
            const r = await requirePi().models(); if (r?.data?.models) r.data.models = filterPiModels(r.data.models, cfg.piModels); return send(res, 200, r);
          }
          case "/api/pi/thinking-levels": return send(res, 200, await requirePi().thinkingLevels());
          case "/api/pi/state": return send(res, 200, await requirePi().refreshState());
          default: return send(res, 404, { error: "unknown pi route" });
        }
      }
      // background agents (pi subagents, Claude Code sessions, shell jobs) started by the agents
      if (p.startsWith("/api/agents") && (await handleAgentRoutes(req, res, { p, q, agents, send, readBody, isLocal }))) return;
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
      if (req.method === "GET" && p === "/api/fs/list") {
        const root = q.get("root") || cfg.cwd;
        if (!fsRootAllowed(req, root)) return send(res, 403, { error: "that folder is not a known session folder" });
        return send(res, 200, { entries: await listDir(root, q.get("path") || "") });
      }
      if (req.method === "GET" && p === "/api/fs/read") {
        const root = q.get("root") || cfg.cwd;
        if (!fsRootAllowed(req, root)) return send(res, 403, { error: "that folder is not a known session folder" });
        return send(res, 200, await readFileSafe(root, q.get("path") || ""));
      }
      if (req.method === "GET" && p === "/api/fs/raw") {
        const root = q.get("root") || cfg.cwd;
        if (!fsRootAllowed(req, root)) return send(res, 403, { error: "that folder is not a known session folder" });
        const abs = safeResolve(root, q.get("path") || "");
        const mime = abs ? IMAGE_MIME[extname(abs).toLowerCase()] : null;
        if (!abs || !mime) return send(res, 404, { error: "not an image" });
        const st = await fs.stat(abs);
        if (st.size > IMAGE_MAX) return send(res, 413, { error: "image too large to preview" });
        return send(res, 200, await fs.readFile(abs), mime);
      }
      if (req.method === "GET" && p === "/api/fs/archive-entry") {
        const root = q.get("root") || cfg.cwd;
        if (!fsRootAllowed(req, root)) return send(res, 403, { error: "that folder is not a known session folder" });
        return send(res, 200, await readArchiveEntry(root, q.get("path") || "", q.get("entry") || ""));
      }
      return send(res, 404, { error: "not found" });
    } catch (e) {
      if (res.headersSent) { try { res.end(); } catch { /* */ } return; }
      return send(res, e?.status || 500, { error: String(e?.message || e) });
    }
  }

  const server = createServer((req, res) => handle(req, res));

  let certCache = null;
  const loadCert = () => (certCache ||= loadOrCreateCert({ dir: cfg.tlsDir, certFile: cfg.tlsCert, keyFile: cfg.tlsKey, altNames: [...lanAddresses().map((a) => a.address), ...(cfg.relay?.host ? [cfg.relay.host] : [])] }));
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
    try {
      await new Promise((r, j) => { srv.once("error", j); srv.listen(cfg.remotePort, cfg.remoteHost || "0.0.0.0", () => { srv.off("error", j); r(); }); });
    } catch (e) { remote.error = e.message; log(`  remote listener could not start on port ${cfg.remotePort}: ${e.message}`); return; }
    Object.assign(remote, { server: srv, port: srv.address().port, tls: tls ? { fingerprint: tls.fingerprint, selfSigned: tls.selfSigned } : null });
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
    await new Promise((r) => server.listen(cfg.port, cfg.host, r));
    log(`Omni Agent on http://127.0.0.1:${cfg.port}  vault=${cfg.vaultDir}`);
    if (cfg.lan) await listenRemote();
    if (cfg.relay?.host) await listenRelay();
    await watcher.start();
    log(`watching ${watcher.tails.size} session files (${registry.list().length} known sessions)`);
    // Agent chats keep their place under their parent (only chats the watcher found: a deleted one is not recreated blank).
    for (const a of agents.list()) if (a.sid && a.parentSid && registry.get(a.sid)) registry.upsert(a.sid, { parentSid: a.parentSid, agentId: a.id, agentKind: a.kind });
    applyCaps();
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
    if ((pi.cwd || "").toLowerCase() !== String(d.cwd || "").toLowerCase() && d.cwd && existsSync(d.cwd)) { startPi(d.cwd); await pi.waitReady(); }
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
    pi?.stop();
    agents.stopAll();
    agents.dispose();
    claude.stopAll();
    approvals.dispose();
    for (const res of hostStreams) { try { res.end(); } catch { /* */ } }
    server.close();
    remote.server?.close();
    tunnel?.stop();
    relay.front?.close();
    relay.server?.closeAllConnections?.();
  }

  return { server, remote, relay, get tunnel() { return tunnel; }, listen, close, bus, vault, registry, tally, watcher, claude, keeper, agents, auth, approvals, get pi() { return pi; }, startPi, cfg };
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}` || process.argv[1]?.endsWith("index.mjs")) {
  const app = await createApp();
  await app.listen();
  const bye = () => { app.close(); process.exit(0); };
  process.on("SIGINT", bye);
  process.on("SIGTERM", bye);
  // A multi-day unattended run must survive a stray error: log and keep the process up.
  process.on("uncaughtException", (e) => log("uncaughtException", e?.stack || e));
  process.on("unhandledRejection", (e) => log("unhandledRejection", e?.stack || e));
}
