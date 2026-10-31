# Missions (boss + workers + project knowledge) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A mission mode in Omni Agent: one boss chat that only orchestrates (never sees tool output), temporary worker agents that do the work and report in a fixed structure, a durable per-project store outside the project folder, a live layered Mission view, and a per-project knowledge graph.

**Architecture:** New server modules (`projects`, `missions`, `mission-tools`, `mission-routes`, `kgraph`, `omni-mcp-http`) built on the existing `AgentManager`, `OpencodeRpc`, the bus and the Omni OpenCode plugin. The boss is an `OpencodeRpc` chat whose tool allowlist is only the boss tools; the `MissionManager` owns a persisted delivery queue into it. Workers are `AgentManager` agents tagged with `missionId`; their reports go to the boss through the manager, not the plugin poller.

**Tech Stack:** Node ≥ 22 built-ins only (`node:test`, `node:sqlite` for the KG), vanilla ES-module UI, SSE bus.

**Spec:** `docs/superpowers/specs/2026-10-31-mission-boss-design.md`

## Global Constraints

- No npm dependencies (README: "Node built-ins only. No npm install").
- Nothing is written into the target project's directory; project data lives in `~/.omni-agent/projects/<slug>/` (configurable `projectsDir`).
- Boss tool results ≤ 4000 chars; worker report delivered to the boss ≤ 8000 chars (full report stored).
- Boss allowlist = boss tools only; no bash/read/edit/write/grep/glob/webfetch/task/list.
- Mission workers: `parentSid = "mission:<id>"`, depth limit 3 inside missions (`agents.missionMaxDepth`, default 3).
- Retry backoff 15 s doubling to a 10 min cap; fallback after 3 consecutive boss failures; primary retried after 60 min; heartbeat 30 min; rebirth at 60 % of the boss's context window.
- `notify` stores + broadcasts only. No push, no channel layer.
- All JSON state written atomically (tmp + rename), events appended to `events.jsonl`.
- Tests: `node --test`, existing suite (518) must stay green.

## Review Focus

- Boss model has a rate limit/outage for hours → deliveries keep queueing (persisted), workers keep running, the user gets one notification on fallback, not one per retry. (Task 4 test `boss errors back off, switch to fallback once, notify once`.)
- Omni restarts mid-mission → mission reloads, the boss session is reopened (not a new one), interrupted workers are reported to the boss in one delivery. (Task 9 test `reconcile after restart`.)
- A worker's report is huge (100 KB) or empty → boss gets ≤ 8000 chars with a pointer to the full report file; an empty one becomes a `stuck` report saying it ended without a report. (Task 5 test `report capping and empty report`.)
- Two missions on the same project dir → same project folder, separate mission folders, tools resolve to the right mission by the caller's session. (Task 2 test `two missions share a project`, Task 6 test `tool resolves by session`.)
- A user message to a worker while the boss is mid-turn → the worker gets it at once, the boss learns of it in its next delivery (not lost). (Task 5 test `user message to worker is relayed to boss`.)

---

## Milestone 1 — Mission core

### Task 1: Project store

**Files:**
- Create: `server/projects.mjs`
- Test: `test/projects.test.mjs`

**Interfaces:**
- Produces:
  - `projectSlug(dir: string) → string` — `<basename lowercased, [^a-z0-9._-]→-, ≤40>-<first 8 hex of sha1(resolved absolute dir, lowercased on win32)>`.
  - `class ProjectStore({ root })` with `project(dir) → { slug, dir, root, memoryDir, graphDir, artifactsDir, missionsDir }` (creates the folders and `project.json` `{dir,name,createdAt}` once), `list() → project.json[]`.
  - `class MissionFiles({ dir })` (one mission folder): `read() → object|null`, `write(obj)` atomic, `append(ev)` to events.jsonl (adds `ts`), `ledger(line)` appends `- <ISO time> <line>\n` to ledger.md, `writeReport(workerId, text) → path`, `writeBrief(workerId, text) → path`.
  - `writeJsonAtomic(file, obj)`.

- [ ] **Step 1: Write failing tests** `projectSlug is stable and safe` (same dir with trailing slash → same slug; `C:\\A b\\My Repo` → starts with `my-repo-` and matches `/^[a-z0-9._-]+-[0-9a-f]{8}$/`), `project() creates the layout once` (all dirs exist; `project.json.createdAt` unchanged on second call), `two missions share a project` (two `MissionFiles` under one `missionsDir` keep separate `mission.json`), `MissionFiles round-trips and appends` (write/read; two `append` → two JSON lines; `ledger` lines; `writeReport` returns path under `reports/`).
- [ ] **Step 2:** `node --test test/projects.test.mjs` → FAIL (module not found).
- [ ] **Step 3:** Implement `server/projects.mjs`.
- [ ] **Step 4:** Tests pass.
- [ ] **Step 5:** Commit `feat(missions): per-project store outside the project folder`.

### Task 2: Mission model (no boss yet)

**Files:**
- Create: `server/missions.mjs`
- Test: `test/missions.test.mjs`

**Interfaces:**
- Consumes: `ProjectStore`, `MissionFiles` (Task 1).
- Produces (`server/missions.mjs`):
  - `class MissionManager extends EventEmitter` — `constructor({ bus, store, agents, createBoss, config = {}, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, log = () => {} })`.
  - `create({ dir, goal, title?, bossModel: {provider,id}, fallbackModel?: {provider,id}|null, workerKind?: "pi"|"claude", workerModel?: string }) → mission` (status `"starting"`, id `m-<8 hex>`). Throws `status 400` on missing goal/dir/bossModel or a dir that does not exist.
  - `get(id)`, `list()` (newest first), `bySession(sid) → mission|null` (boss sid or any worker/subagent sid via `agents.agentBySid(sid)?.missionId`).
  - `addTask(m, {title, parent?, detail?}) → task` ids `t1, t2…` (child `t1.1`); `updateTask(m, id, {status?, summary?, title?})`; statuses `todo|active|done|blocked|dropped` (400 otherwise).
  - `addNote(m, {kind, title, body})` kinds `decision|dead_end|fact|risk|lesson`.
  - `notify(m, {title, body, urgency = "info", question?}) → notification` (`n<k>`, `read:false`, `answer:null`); emits bus `{sid:"mission:<id>", harness:"omni", kind:"notify", mission:<id>, notification}`.
  - `save(m)` (mission.json + bus `{kind:"mission", mission: publicView}`), every mutator saves and appends an event.
  - `renderState(m, { workers, max = 4000 }) → string` pure, exported: goal line, task tree (`[status] id title — summary`), active workers (`id kind status elapsed · last activity`), unanswered questions, last 8 notes; clipped to `max`.
- Mission record fields: `id, title, goal, dir, slug, status ("starting"|"running"|"waiting"|"paused"|"done"|"error"), createdAt, updatedAt, bossModel, fallbackModel, usingFallback:false, workerKind, workerModel, boss: {sid, sessionId, sessionFile, generation, contextUsed, contextWindow}, tasks: [], notes: [], workers: [] (ids), notifications: [], queue: [], errors: {consecutive:0, lastError:"", nextRetryAt:0}`.

- [ ] **Step 1: Write failing tests** `create validates and persists` (400 without goal; mission.json exists under the project's missions dir; `list()` has it), `tasks and notes` (t1, t1.1; bad status → 400; ledger.md mentions the task title), `notify emits a bus event and stores it`, `renderState is capped and readable` (contains goal, `[active] t1`, cap respected with 50 long tasks), `two missions share a project` (same slug, different ids).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement (no boss start in `create` when `createBoss` is absent — Task 3 adds it).
- [ ] **Step 4:** Pass.
- [ ] **Step 5:** Commit `feat(missions): mission model, tasks, notes, notifications`.

### Task 3: The boss chat and its delivery queue

**Files:**
- Modify: `server/missions.mjs`
- Create: `server/boss-prompt.mjs` (constants only)
- Test: `test/missions-boss.test.mjs`

**Interfaces:**
- Consumes: Task 2.
- Produces:
  - `BOSS_TOOLS: string[]` = `["mission_state","task_add","task_update","worker_spawn","worker_message","worker_summary","worker_cancel","note","kg_search","kg_node","memory_recall","notify","mission_done"]`.
  - `BOSS_SYSTEM: string` — the boss's role: orchestrator only, cannot read files or run commands, delegates everything, keeps tasks/notes current, decides when to notify, asks workers for summaries instead of details, writes complete self-contained briefs with scope.
  - `bossBriefing(m, workers) → string` — first prompt of a boss generation: goal + `renderState` + "continue".
  - `createBoss({ cwd, model, provider, system, tools, meta }) → OpencodeRpc-like` (injected; same shape as `AgentManager`'s `createPi`; `meta = { missionId, role: "boss" }`).
  - `MissionManager.startBoss(m)` — creates the chat, `start()`, `waitReady()`, `switchSession(m.boss.sessionFile)` when one is saved, stores sid/sessionId/sessionFile, enqueues the briefing on a new generation.
  - `MissionManager.enqueue(m, item: { type: "user"|"report"|"question"|"event"|"briefing"|"heartbeat", text, front?: boolean, ref? })` persisted in `m.queue`; `pump(m)` delivers the head when the boss is idle (`!boss.streaming` and no turn in flight); a turn ends on a bus `status` `streaming:false` for the boss sid; the item is removed when that turn ended without an assistant `stopReason === "error"`, else Task 4's retry runs.
  - Delivered text is prefixed `[mission <id>] ` and capped at 12000 chars.

- [ ] **Step 1: Write failing tests** (fake boss like `piFactory` in `test/agents.test.mjs`): `create starts the boss with the boss allowlist and system` (opts.tools equals `BOSS_TOOLS`, system contains "You are the boss"), `briefing is the first prompt`, `queue delivers one at a time when idle` (two enqueued while streaming → 0 prompts; stream(false) → 1; after that turn ends → 2), `user messages jump the queue` (`front:true`), `queue survives a reload` (new manager over the same store sees queued items).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Pass.
- [ ] **Step 5:** Commit `feat(missions): boss chat with boss-only tools and a persisted delivery queue`.

### Task 4: Boss resilience: backoff, fallback, notify once

**Files:** Modify `server/missions.mjs`; Test `test/missions-boss.test.mjs`.

**Interfaces:**
- Produces: `MissionManager.onBossTurnEnd(m, { error })`; config keys `retryBaseMs = 15000`, `retryMaxMs = 600000`, `fallbackAfter = 3`, `primaryRetryMs = 3600000`; on fallback the boss `setModel(fallback.provider, fallback.id)`, `m.usingFallback = true`, one `notify(urgency "info", title "Boss switched to fallback model")`; when `usingFallback` and `primaryRetryMs` elapsed, the next delivery switches back first.
- A boss chat `exit` → `startBoss` again on the same session file after the backoff (no new session).

- [ ] **Step 1: Write failing tests** `boss errors back off, switch to fallback once, notify once` (fake timers; 3 error turns → setModel called with fallback, exactly one notification; delays 15 s, 30 s, 60 s), `success resets the error count`, `primary is retried after an hour`, `boss exit restarts it on the same session`.
- [ ] **Step 2–4:** fail → implement → pass.
- [ ] **Step 5:** Commit `feat(missions): the boss retries, falls back and never stops on API errors`.

### Task 5: Workers: spawn, reports, summaries, user messages

**Files:**
- Modify: `server/agents.mjs` (records accept `missionId`, `taskId`, `role`; subagents inherit `missionId` from their parent agent; depth limit `config.missionMaxDepth` (3) when `missionId` set; `AGENT_FOOTER` replaced by `spec.footer` when given)
- Modify: `server/missions.mjs`; Create: `server/worker-contract.mjs`
- Test: `test/missions-workers.test.mjs`, `test/agents.test.mjs` (inherit + depth)

**Interfaces:**
- Produces:
  - `WORKER_FOOTER` (worker contract + report format with headings exactly: `## Status` (done|stuck|partial), `## Outcome`, `## What works`, `## Tried and failed`, `## Errors`, `## Artifacts`, `## Knowledge recorded`, `## Open questions / next`), `SUMMARY_REQUEST` (asks for the same headings, "so far").
  - `workerBrief(m, spec, paths) → string`: task, scope (files, notes, kg queries), project paths (artifacts dir, memory), mission goal one line.
  - `MissionManager.spawnWorker(m, { task, title?, taskId?, kind?: "pi"|"claude", agent?, model?, scope?: { files?: string[], notes?: string[], kg?: string[] } }) → agent record` (via `agents.start({ ..., parentSid: "mission:"+id, parentSessionId: null, missionId, taskId, role: "worker", footer: WORKER_FOOTER, cwd: m.dir, memory: true })`); brief written with `writeBrief`.
  - On an agent `change` to finished for a mission worker: full report → `writeReport`; `compactReport(rec, path) → string` (≤ 8000: status line, the report clipped, `full report: <path>`; empty → `## Status\nstuck\n… ended (<status>) without a report. Error: …`); enqueued as type `report`; `agents.markDelivered(id)`; task linked to the worker gets `summary` from the report's Outcome line.
  - `MissionManager.workerSummary(m, workerId, { timeoutMs = 600000 }) → string` — finished: its compact report; running: `agents.message(id, SUMMARY_REQUEST)` and resolve with the next assistant text from that worker (bus `msg` live assistant for its sid; Claude: next `resultText` change), capped 4000.
  - `MissionManager.messageWorker(m, workerId, text, { from: "boss"|"user" })` → `agents.message`; from user → ledger + enqueue `event` `the user told worker <id>: <text>`.

- [ ] **Step 1: Write failing tests** `spawn tags the agent and writes the brief`, `report capping and empty report`, `report updates the task summary`, `summary of a running worker asks it and returns its answer`, `user message to worker is relayed to boss`, (agents.test) `mission subagents inherit missionId and may nest 3 deep`.
- [ ] **Step 2–4:** fail → implement → pass.
- [ ] **Step 5:** Commit `feat(missions): workers with structured reports, summaries and relayed user messages`.

### Task 6: Mission tool dispatcher

**Files:** Create `server/mission-tools.mjs`; Test `test/mission-tools.test.mjs`.

**Interfaces:**
- Consumes: `MissionManager` (Tasks 2–5).
- Produces: `async runMissionTool(missions, { sessionID, tool, args }) → { output: string, metadata?: object }` — resolves the mission with `missions.bySession("pi:"+sessionID)` (also accepts a full sid); unknown session → `output` "This chat is not part of a mission." Boss tools as in Task 3's `BOSS_TOOLS` (kg_* and memory_recall return "not available yet" until Tasks 12/10); worker tools `ask_boss {question}` (enqueue `question`, wait ≤ 30 min for `answerQuestion`, returns the answer or "no answer yet; continue with your best assumption") and `progress {note}` (ledger + worker activity). Every `output` clipped to 4000.
  - `MissionManager.answerQuestion(m, qid, text)`; `worker_message` with `{ id, message, question_id? }` answers a pending question.
  - `mission_done {summary}` → status `done`, ledger, one notification `urgency "action"`.

- [ ] **Step 1: Write failing tests** `tool resolves by session` (boss sid of mission B → B), `worker_spawn returns the id`, `mission_state is capped`, `ask_boss waits for the boss's answer`, `unknown tool → readable error`.
- [ ] **Step 2–4.** **Step 5:** Commit `feat(missions): boss and worker tools, executed server-side`.

### Task 7: Routes, wiring, plugin tools

**Files:**
- Create: `server/mission-routes.mjs`; Modify: `server/index.mjs` (construct `ProjectStore({root: cfg.projectsDir})`, `MissionManager` with `createBoss` = an `OpencodeRpc` like `createAgentPi` with `compactAt: 0`; `missions.reconcile()` on boot; `/api/missions` routes); `server/config.mjs` (`projectsDir` default `~/.omni-agent/projects`, `missions` config block).
- Modify: `integrations/opencode/omni-plugin.mjs` — `mission_*`, `task_*`, `worker_*`, `note`, `notify`, `ask_boss`, `progress` tools that POST `/api/missions/tool` and return its output; not in the default guideline text; workers' allowlist unaffected (they get everything but boss tools via the system prompt contract).
- Test: `test/mission-routes.test.mjs`, extend `test/opencode-plugin.test.mjs`.

**Interfaces:**
- Routes: `GET /api/missions` → `{missions}`; `POST /api/missions` (local only) → `{mission}`; `GET /api/missions/:id` → `{mission, workers}` (workers = `agents.list()` filtered by missionId, `pub` shape); `POST /api/missions/:id/message {text}` → user → boss (front of queue); `POST /api/missions/:id/workers/:wid/message {text}`; `POST /api/missions/:id/notifications/:nid {read?, answer?}` (answer → enqueue `user` "answer to <title>: …"); `POST /api/missions/:id/stop` (cancel workers, boss stop, status `paused`) / `resume`; `POST /api/missions/tool {sessionID, tool, args}` → `{output, metadata}`.

- [ ] **Step 1:** Failing route tests (create → 200 with id; bad → 400; tool route → output; message → enqueued front). Plugin test: the tools exist and POST the right body.
- [ ] **Step 2–4.** Run the full suite: `node --test` → all pass.
- [ ] **Step 5:** Commit `feat(missions): routes, server wiring and plugin tools`.

## Milestone 2 — Mission view

### Task 8: Mission view UI

**Files:** Create `ui/mission.js`; Modify `ui/index.html` (a "Missions" panel tab + a main-area mission view container + new-mission dialog), `ui/app.js` (route bus `mission`/`notify`/`agent` events to `mission.js`), `ui/styles.css`. Test `test/ui-mission.test.mjs` (pure helpers).

**Interfaces:**
- `ui/mission.js` exports pure `buildTree(mission, agents) → { boss, layers: [[node]] }` (node: `{id, kind, status, title, model, activity, children}`; children = agents whose `parentSid` is the worker's sid), `statusClass(status)`, and `mountMission(root, { api, onOpenChat })`.
- View: header (title, goal, status, boss model / fallback badge, Stop/Resume); the tree — boss card on top, a row per layer, connector lines, each card: kind badge (OpenCode/Claude), status dot, title, last activity line, elapsed, cost; click → drawer with details, "Ask for summary", "Message", "Open chat"; side column: notifications (unread badge, reply box for questions) and the ledger (tasks + notes). New-mission dialog: project folder, goal, boss model + fallback (from `/api/pi/models`), default worker kind.

- [ ] **Step 1:** Failing test for `buildTree` (boss, 2 workers, 1 subagent → layers lengths [2,1]).
- [ ] **Step 2–4.**
- [ ] **Step 5:** Run Omni from the worktree on a spare port with a fake/real mission, screenshot the view, send it to the user. Commit `feat(ui): live mission view`.

## Milestone 3 — Restart and rebirth

### Task 9: Reconcile after restart, rebirth at 60 %

**Files:** Modify `server/missions.mjs`; Test `test/missions-boss.test.mjs`.

**Interfaces:** `MissionManager.reconcile()` — loads every mission under every project; running ones: `startBoss` (reopens the saved session file), workers that `agents` marked `interrupted` → one `event` delivery listing them with "resume with worker_message or respawn". `maybeRebirth(m)` after each boss turn: `pi.lastContext / contextWindow ≥ 0.6` → new generation: new session (no `switchSession`), `bossBriefing` enqueued at front, ledger "boss rebirth", old session kept in `m.boss.previous[]`. Heartbeat: every `heartbeatMs` (30 min) when workers are active and the queue is empty → enqueue `heartbeat` with `renderState`.

- [ ] Tests `reconcile after restart`, `rebirth past 60 %`, `heartbeat only when workers run and nothing queued`; implement; commit `feat(missions): restart resume, boss rebirth, heartbeat`.

## Milestone 4 — Scoped memory, Claude workers, handoff

### Task 10: Project-scoped memory

**Files:** Modify `server/index.mjs` (`/api/missions/memory/*` using a `Vault(project.memoryDir)` per project), `integrations/opencode/omni-plugin.mjs` (memory_* tools: ask `GET /api/missions/scope?session=<root>`; in a mission use the project vault via `/api/missions/memory/{search,recall,save}`), `server/mission-tools.mjs` (`memory_recall` for the boss). Test `test/mission-memory.test.mjs`.
- [ ] Tests: a mission worker's `memory_save` lands in the project's `memory/`, not the global vault; non-mission chats unchanged. Commit.

### Task 11: Omni tools for Claude Code workers over MCP

**Files:** Create `server/omni-mcp-http.mjs` (JSON-RPC over HTTP POST: `initialize`, `tools/list`, `tools/call`, `notifications/initialized`), route `POST /mcp?agent=<id>`; Modify `server/claude-runner.mjs` (`mcpConfig` option → `--mcp-config <json>`), `server/agents.mjs` (claude workers in a mission get `mcpConfig` pointing at `/mcp?agent=<id>`). Tools: `ask_boss`, `progress`, `memory_search/recall/save` (project), `kg_search/kg_node/kg_upsert`. Test `test/omni-mcp-http.test.mjs` (initialize → protocolVersion; tools/list names; tools/call ask_boss reaches the manager).
- [ ] Commit `feat(missions): Claude Code workers get Omni's worker tools over MCP`.

### Task 12: Handoff to a successor worker

**Files:** `server/mission-tools.mjs` (`handoff {note}` worker tool), `server/missions.mjs` (`handoffWorker(m, id, note)`: store note in `workers/<id>/handoff.md`, cancel the worker without a report delivery, spawn a successor with the same task/scope + the handoff, ledger + `event` to boss "worker X handed off to Y"). Worker contract text: use `handoff` when compaction happened twice or context feels lost. Test + commit.

## Milestone 5 — Knowledge graph

### Task 13: KG store and tools

**Files:** Create `server/kgraph.mjs`; Test `test/kgraph.test.mjs`.

**Interfaces:** `class KGraph({ file })` on `node:sqlite` `DatabaseSync`: tables `nodes(id TEXT PK, kind, name, binary, addr, summary, status, confidence REAL, evidence, tags, updated_at, updated_by)`, `edges(src, dst, rel, note, PRIMARY KEY(src,dst,rel))`, FTS5 `nodes_fts(name, summary, tags)`. Methods: `upsert({nodes, edges}, {by}) → {nodes, edges}` (merge: non-empty fields win, `status` only moves `unknown → hypothesis → confirmed` unless `force`), `search(q, {kind, limit=20, budget=1200}) → string`, `node(idOrName, {depth=1, budget=1500}) → string`, `stats()`. Node kinds: `file, module, symbol, binary, function, string, offset, struct, concept`; edge rels: `imports, calls, xref, contains, reads, writes, decrypts, implements, related`. Tools `kg_search`, `kg_node` (boss + worker), `kg_upsert` (worker) wired in mission-tools, plugin and MCP.
- [ ] Tests: upsert/merge rules, FTS search ranks name hits first, budget caps output, 200k-node insert in a transaction < 10 s. Commit.

### Task 14: Importers (graphify, Ghidra)

**Files:** `server/kgraph-import.mjs`, `integrations/ghidra/OmniExport.java`; tools `kg_import {source: "graphify"|"ghidra", path}` (worker) running as a shell job via `agents.start({kind:"shell"})`. graphify: runs the existing `graph.build`, reads `graph.json` nodes/links → file/symbol nodes + imports/calls edges; when `graphify-out/` did not exist before, move it to `<project>/graph/imports/graphify/`. Ghidra: `analyzeHeadless <project>/artifacts/ghidra <name> -import <bin> -postScript OmniExport.java <out.jsonl> -scriptPath integrations/ghidra` → JSONL lines `{t:"fn",name,addr,size}`, `{t:"call",from,to}`, `{t:"str",addr,value,refs:[addr]}`, `{t:"imp"|"exp",name,addr}` → nodes/edges with `binary`. Tests on fixture JSON/JSONL. Commit.

### Task 15: KG in the Mission view

**Files:** `ui/mission.js` (a "Knowledge" tab: stats, search box over `/api/missions/:id/kg/search`, node detail with neighbors). Screenshot to the user. Commit.

## Milestone 6 — Polish

### Task 16: Claude internal subagents in the tree, docs

**Files:** `server/claude-runner.mjs`/`server/agents.mjs` (track `Task` tool_use starts/ends from stream-json as `rec.subtasks[]` `{id, description, status}`), `ui/mission.js` (render them as child nodes), README section "Missions", update this plan's checkboxes. Commit.
