/**
 * Omni Agent server. Node built-ins only.
 *
 *   node server/index.mjs [--port 4400] [--cwd <dir>] [--model <id>] [--provider <p>] [--no-pi]
 */
import { createServer } from "node:http";
import { promises as fs, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { extname, join, relative, resolve, sep } from "node:path";
import { CONFIG, ROOT, lanAddresses, piChildEnv } from "./config.mjs";
import * as graph from "./graph.mjs";
import { Bus } from "./bus.mjs";
import { PiRpc } from "./pi-rpc.mjs";
import { ClaudeRunner } from "./claude-runner.mjs";
import { planContinue } from "./continue.mjs";
import { filterPiModels } from "./pi-models.mjs";
import { SessionRegistry, SessionWatcher } from "./watchers.mjs";
import { Vault } from "./memory.mjs";
import { createTally, estimateTokens } from "./tokens.mjs";

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

export async function createApp(overrides = {}) {
  const cfg = { ...CONFIG, ...overrides };
  const bus = new Bus();
  const tally = createTally();
  const registry = new SessionRegistry();
  const vault = new Vault(cfg.vaultDir).ensure();
  const claude = new ClaudeRunner({ bin: cfg.claudeBin, bus, spawn: cfg.claudeSpawn });
  let pi = null;

  const isOwned = (file) => (pi?.owns(file) ?? false) || claude.owns(file);
  const watcher = new SessionWatcher({ piSessionsDir: cfg.piSessionsDir, claudeProjectsDir: cfg.claudeProjectsDir, bus, tally, registry, isOwned, recentHours: cfg.tailRecentHours, log });

  // Owned sessions also need registry + tally bookkeeping from their live events.
  bus.on("event", (ev) => {
    if (ev.kind === "log" || ev.kind === "removed") return;
    const s = registry.upsert(ev.sid, {});
    if (ev.kind === "session") registry.upsert(ev.sid, { cwd: ev.cwd, title: ev.title, model: ev.model, file: ev.file, owned: ev.owned, streaming: ev.streaming, forkedFrom: ev.forkedFrom });
    if (ev.kind === "status") s.streaming = !!ev.streaming;
    if (ev.kind === "msg" && ev.live) {
      s.messages++;
      if (ev.usage) tally.add(ev.sid, { groupId: ev.groupId || ev.id, usage: ev.usage, model: ev.model, cost: ev.cost, ts: ev.ts });
      if (ev.role === "user" && !s.title) s.title = (ev.blocks?.find((b) => b.type === "text")?.text || "").replace(/\s+/g, " ").slice(0, 80);
    }
    if (ev.kind !== "session") s.lastActivity = Math.max(s.lastActivity || 0, ev.ts || 0);
    if (!s.startedAt && ev.ts) s.startedAt = ev.ts;
    if (ev.kind === "msg" || ev.kind === "run") watcher.dirty.set(ev.sid, Date.now());
  });

  function startPi(cwd = cfg.cwd) {
    if (pi) pi.stop();
    pi = cfg.createPi ? cfg.createPi({ cwd, bus }) : new PiRpc({ cli: cfg.piCli, bin: cfg.piBin, cwd, model: cfg.piModel, provider: cfg.piProvider, env: piChildEnv(cfg), bus });
    pi.start();
    return pi;
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
  const normRoot = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  /** Loopback callers can browse anywhere; LAN callers may only browse a folder Omni already knows about. */
  function fsRootAllowed(req, root) {
    if (isLocal(req)) return true;
    const r = normRoot(root);
    if (!r) return false;
    if (r === normRoot(cfg.cwd)) return true;
    if (pi?.cwd && r === normRoot(pi.cwd)) return true;
    for (const s of registry.list()) if (s.cwd && r === normRoot(s.cwd)) return true;
    return false;
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
  async function readFileSafe(root, rel) {
    const abs = safeResolve(root, rel);
    if (!abs) throw new Error("path outside root");
    const st = await fs.stat(abs);
    if (st.size > 2 * 1024 * 1024) return { tooBig: true, size: st.size };
    const ext = extname(abs).toLowerCase();
    if (!(TEXT_EXT.has(ext) || !ext)) return { binary: true, ext };
    return { content: await fs.readFile(abs, "utf8"), ext };
  }

  // ------------------------------------------------------------------ http
  const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
  function send(res, code, body, type = "application/json") {
    res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
    res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  }
  async function readBody(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const s = Buffer.concat(chunks).toString("utf8");
    return s ? JSON.parse(s) : {};
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
  const isLocal = (req) => { const a = req.socket.remoteAddress || ""; return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1"; };
  function cookieToken(req) { const m = /(?:^|;\s*)omni_token=([^;]+)/.exec(req.headers.cookie || ""); return m ? decodeURIComponent(m[1]) : ""; }
  const TOKEN_PAGE = '<!doctype html><meta name=viewport content="width=device-width"><body style="font-family:system-ui;background:#0e1420;color:#e4e9f5;padding:2rem"><h2>Omni Agent</h2><p>This device needs the access token. Open the link printed in the Omni Agent window (it ends with <code>?token=…</code>), or paste the token here.</p><form><input name=token placeholder="token" style="padding:.5rem"> <button style="padding:.5rem">Open</button></form></body>';

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

  async function continueSession(sid, body) {
    const s = registry.get(sid);
    if (!s) throw Object.assign(new Error("unknown session"), { status: 404 });
    if (!body.message?.trim()) throw Object.assign(new Error("empty message"), { status: 400 });
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

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const p = url.pathname;
    const q = url.searchParams;
    try {
      const sfs = req.headers["sec-fetch-site"];
      if (req.method !== "GET" && sfs && sfs !== "same-origin" && sfs !== "none") return send(res, 403, { error: "cross-site request refused" });
      if (cfg.token && !isLocal(req)) {
        const supplied = q.get("token") || cookieToken(req) || (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
        if (supplied !== cfg.token) return send(res, 401, TOKEN_PAGE, "text/html; charset=utf-8");
        if (q.get("token")) {
          q.delete("token");
          res.writeHead(302, { "Set-Cookie": `omni_token=${encodeURIComponent(cfg.token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`, Location: url.pathname + (q.size ? `?${q}` : "") });
          return res.end();
        }
      }
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
        const ka = setInterval(() => { try { res.write(": ka\n\n"); } catch { /* */ } }, 20000);
        req.on("close", () => { clearInterval(ka); bus.removeClient(res); });
        return;
      }
      // state
      if (req.method === "GET" && p === "/api/state") {
        return send(res, 200, {
          config: { cwd: cfg.cwd, vault: cfg.vaultDir, port: cfg.port, piCli: cfg.piCli, claudeBin: cfg.claudeBin, memoryBudgetTokens: cfg.memoryBudgetTokens, liveWindowMs: cfg.liveWindowMs, lan: cfg.lan, lanUrls: cfg.lan ? lanAddresses().map((a) => `http://${a.address}:${cfg.port}/?token=${cfg.token}`) : [] },
          pi: pi ? { running: !!pi.proc, sid: pi.sid, cwd: pi.cwd, streaming: pi.streaming, state: pi.state } : { running: false },
          runs: claude.list(),
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
      // pi
      if (p.startsWith("/api/pi/")) {
        const body = req.method === "POST" ? await readBody(req) : {};
        switch (p) {
          case "/api/pi/start": startPi(body.cwd || cfg.cwd); return send(res, 200, { ok: true, sid: pi.sid });
          case "/api/pi/stop": pi?.stop(); pi = null; return send(res, 200, { ok: true });
          case "/api/pi/prompt": {
            const p0 = requirePi();
            if (!body.message?.trim()) return send(res, 400, { error: "empty" });
            const c = await composePrompt("pi", body.message, { memory: body.memory, graph: body.graph, dir: graphDirFor(p0.sid) });
            return send(res, 200, await p0.prompt(c.text, { images: body.images }));
          }
          case "/api/pi/abort": return send(res, 200, await requirePi().abort());
          case "/api/pi/new": return send(res, 200, await requirePi().newSession());
          case "/api/pi/switch": return send(res, 200, await requirePi().switchSession(body.file));
          case "/api/pi/model": return send(res, 200, await requirePi().setModel(body.provider, body.modelId));
          case "/api/pi/thinking": return send(res, 200, await requirePi().setThinking(body.level));
          case "/api/pi/compact": return send(res, 200, await requirePi().compact());
          case "/api/pi/stats": return send(res, 200, await requirePi().stats());
          case "/api/pi/models": { const r = await requirePi().models(); if (r?.data?.models) r.data.models = filterPiModels(r.data.models, cfg.piModels); return send(res, 200, r); }
          case "/api/pi/thinking-levels": return send(res, 200, await requirePi().thinkingLevels());
          case "/api/pi/state": return send(res, 200, await requirePi().refreshState());
          default: return send(res, 404, { error: "unknown pi route" });
        }
      }
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
      return send(res, 404, { error: "not found" });
    } catch (e) {
      return send(res, e?.status || 500, { error: String(e?.message || e) });
    }
  });

  async function listen() {
    await new Promise((r) => server.listen(cfg.port, cfg.host, r));
    log(`Omni Agent on http://127.0.0.1:${cfg.port}  vault=${cfg.vaultDir}`);
    if (cfg.lan) {
      for (const a of lanAddresses()) log(`  from other devices: http://${a.address}:${cfg.port}/?token=${cfg.token}   (${a.name})`);
      log(`  token lives in omni.config.json; if the firewall blocks it run ${process.platform === "win32" ? "scripts\\allow-lan.cmd" : "scripts/allow-lan.sh"} once`);
    }
    await watcher.start();
    log(`watching ${watcher.tails.size} session files (${registry.list().length} known sessions)`);
    if (cfg.autoStartPi) startPi(cfg.cwd);
    return server;
  }

  function close() {
    clearInterval(digestTimer);
    watcher.stop();
    pi?.stop();
    claude.stopAll();
    server.close();
  }

  return { server, listen, close, bus, vault, registry, tally, watcher, claude, get pi() { return pi; }, startPi, cfg };
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}` || process.argv[1]?.endsWith("index.mjs")) {
  const app = await createApp();
  await app.listen();
  const bye = () => { app.close(); process.exit(0); };
  process.on("SIGINT", bye);
  process.on("SIGTERM", bye);
}
