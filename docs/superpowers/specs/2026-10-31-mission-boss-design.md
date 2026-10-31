# Missions: a boss agent, temporary workers, a project knowledge store

Date: 2026-10-31 · Branch: `feat/mission-boss` (worktree `Omni Apps/omni-agent-mission`)

## Why

Today the user is the orchestrator. When an agent's context fills up they ask it for a handoff, paste it into a
fresh agent, and carry the thread in their own head. That costs effort, and on hard problems (Android reverse
engineering: millions of lines of obfuscated ARM64, packed/encrypted binaries, offsets) details are lost between
agents and the user does not always understand the issue well enough to hand it over correctly.

A **mission** replaces the user in that role. The user gives one big job, walks away, and comes back days later to
real progress, with nothing pasted by hand. The system keeps track of everything itself.

## Goals

- **Boss.** One long-lived orchestrator per mission. It holds the whole mission in its head, and it never sees
  raw tool output: it can only call orchestration tools whose results are short, structured and capped. It plans,
  splits the job, assigns workers, reads their reports, decides what's next and decides when to ping the user.
- **Workers.** Temporary agents (OpenCode or Claude Code, chosen per task by the boss, overridable by the user) that
  do the actual tool work, fill their context, compact when needed, can start subagents of their own, and only
  see the files/memory/graph the boss scoped for them. They report back when done or stuck.
- **Summaries, not transcripts.** The boss never reads a worker's chat. It asks for a status summary or gets the
  final report: what works and why, what was tried, what failed and with what error, artifacts, open questions.
- **Everything persists outside any context window.** A mission ledger on disk (task tree, decisions, dead ends,
  every report, notifications) is the source of truth; the boss can be restarted from it with nothing lost.
- **Never fully stops.** API errors, rate limits, quota on the boss or a worker: retries with backoff, a per-mission
  fallback model for the boss, workers keep running while the boss is down, reports queue for later delivery, an
  Omni restart resumes the mission.
- **Project knowledge store.** Per project, outside the project's own folder:
  `~/.omni-agent/projects/<slug>/` with the mission ledger, project memory notes, the knowledge graph, artifacts
  and worker briefs/handoffs.
- **Knowledge graph.** One queryable graph per project that both source repos (graphify import) and binaries
  (Ghidra headless import: functions, calls, strings, xrefs, imports/exports) feed, and that workers annotate as
  they learn (names, offsets, "decrypts strings", hypotheses with confidence and evidence). Token-budgeted queries,
  so a fresh worker starts from the map instead of re-reading code or disassembly.
- **Live layered view.** A Mission view: the boss on top, its workers below, their subagents below them, live
  status/activity/context use/cost per node, and the user can message any node in real time.
- **notify tool.** The boss decides when the user is needed. For now a notification is stored in the ledger and
  shown in Omni's window and the remote web page; phone delivery is wired in later (not in this project).

## Non-goals (this round)

- The mobile app, web push, or any notification channel/transport layer. (`notify` only stores + shows.)
- Replacing the existing chat UI, plan tool, goal keeper or background agents; missions build on them.
- A decompiler of our own. Static RE comes from Ghidra/r2 the workers already run; we store what they learn.

## Anti-goals (a failure even if it "works")

- The boss's context fills with tool output, file contents or transcripts.
- A mission silently stops (an error, a rate limit, a restart) and the user only finds out days later.
- Knowledge lives only inside one worker's context and dies with it.
- Anything written into the target project's folder that the user did not ask for.

## How it fits on what exists

Omni already has: one shared `opencode serve` with chats as `OpencodeRpc` sessions (system prompt + tool
allowlist per prompt), the Omni OpenCode plugin (plan, agent_*, job_*, memory_*, graph_*), `AgentManager`
(pi/claude/shell agents with parent/child/depth, persistence, report delivery, `message()` that steers or
resumes), auto-compaction (`context.compactAt`), the goal keeper, `ClaudeRunner` (stream-json, steerable), the
Obsidian vault, a graphify wrapper, SSE bus to a vanilla-JS UI, and remote HTTPS access with approvals.

Missions add, as mostly new files:

| Piece | File | What |
|---|---|---|
| Project store | `server/projects.mjs` | `~/.omni-agent/projects/<slug>/` layout, slug from the project dir, mission.json/ledger.md/events.jsonl I/O (atomic) |
| Mission manager | `server/missions.mjs` | missions, boss lifecycle, delivery queue to the boss, worker bookkeeping, notifications, resilience |
| Mission tools dispatcher | `server/mission-tools.mjs` | the boss tools and the worker-side tools, executed server-side, results capped |
| Routes | `server/mission-routes.mjs` | `/api/missions…` |
| Knowledge graph | `server/kgraph.mjs` | `node:sqlite` store (nodes, edges, FTS5), budgeted query, graphify + Ghidra importers |
| MCP for Claude workers | `server/omni-mcp-http.mjs` | minimal MCP over HTTP so Claude Code workers get Omni's worker tools (`--mcp-config`) |
| Plugin tools | `integrations/opencode/omni-plugin.mjs` | thin `mission_*`/`worker_*`/`kg_*`/`notify` tools that POST to the server |
| Ghidra export script | `integrations/ghidra/OmniExport.java` | headless post-script → JSONL of functions/calls/strings/xrefs |
| UI | `ui/mission.js`, `ui/index.html`, `ui/styles.css` | Mission view (tree, node drawer, ledger, notifications, new-mission dialog) |

### The boss

- An `OpencodeRpc` chat on the shared server, model chosen per mission (`bossModel`, `bossFallbackModel`), with a
  boss system prompt and a **tool allowlist of only the boss tools** (no bash/read/edit/grep/webfetch/task).
- Boss tools (all results short, structured, capped ~4k chars):
  - `mission_state` — the task tree with statuses, active workers (status, elapsed, last activity line, context %),
    pending questions, recent notes. Never transcripts.
  - `task_add / task_update` — the mission's task tree (id, title, status `todo|active|done|blocked|dropped`,
    summary, assigned worker ids).
  - `worker_spawn` — task brief, kind `opencode|claude`, persona, model, and a scope: files/dirs to look at,
    memory note names, graph node ids/queries to hand over. Returns the worker id at once.
  - `worker_message` — steer or answer a worker (also answers `ask_boss`).
  - `worker_summary` — asks the worker for a structured status summary; returns it (or its final report).
  - `worker_cancel`.
  - `note` — a ledger entry: `decision | dead_end | fact | risk | lesson`, with a one-line title and short body.
  - `kg_search / kg_node` — the knowledge graph, token-budgeted (so the boss can reason about structure).
  - `memory_recall` — project memory pack, budgeted.
  - `notify` — title, body, urgency `info|action|urgent`, optional question. The user's answer arrives as a message.
  - `mission_done` — final summary; ends the mission (user can reopen by messaging).
- Event-driven: the boss is prompted when something happens — a worker report, a worker question, a user
  message, a notification answer, a restart, a periodic heartbeat (configurable, default 30 min, only if workers
  are running and nothing else arrived) — and idles otherwise. Each delivery is a compact `[mission] …` message.
- **Delivery queue** in the manager (persisted in mission.json): items are delivered one at a time when the boss
  is idle (followUp when it is busy). A delivery whose boss turn fails is retried.
- **Rebirth.** When the boss's context passes `rebirthAt` (default 60% of its window) or its session is broken, the
  manager starts a fresh boss session whose first message is a briefing rendered from the ledger (goal, tree,
  decisions, dead ends, open workers, pending items). Old session kept for the user to read.

### Workers

- `AgentManager` agents with `missionId`, `taskId`, `role: "worker"`, `parentSid: "mission:<id>"` (so the plugin's
  own report poller never touches them; the manager delivers to the boss).
- Brief = boss task + the scope it gave + a **worker contract**: work alone; use the project memory and knowledge
  graph; record durable findings with `memory_save`/`kg_upsert` as you go; use `ask_boss` when truly stuck; finish
  with the structured report.
- Structured report (required, capped at 8k chars when delivered; the full one stored in `reports/<worker>.md`):
  `Status (done|stuck|partial) · Outcome · What works (and why) · Tried and failed (and why) · Errors · Artifacts
  (paths) · Knowledge recorded · Open questions / next`.
- Worker-side tools: `ask_boss(question)` (blocks up to 30 min for the boss's answer), `progress(note)` (a one-line
  heartbeat into the ledger), project-scoped `memory_*`, `kg_*`, plus all normal tools and `agent_start` for
  subagents (subagents inherit `missionId`, depth limit 3 for missions).
- OpenCode workers get them through the plugin; Claude Code workers through Omni's MCP endpoint
  (`--mcp-config` pointing at `/mcp?agent=<id>`), plus their own Task subagents.
- Compaction: existing `compactAt`. A worker past its compaction budget can `handoff(note)`: the manager ends it
  and starts a successor on the same task with the handoff note (the user's manual paste, automated).

### The user, live

- Messaging the boss: prompted directly (queued in front of other deliveries).
- Messaging a worker: `AgentManager.message` + a ledger entry; the boss is told in its next delivery
  (`[mission] the user told worker a-… : …`).
- Notifications: listed in the Mission view with unread badges, toast on arrival; an action/urgent one with a
  question has a reply box whose answer goes to the boss.
- Works from the remote page too (existing approvals apply to changes from a remote browser).

### Resilience

- Boss turn error / rate limit: retry the delivery with exponential backoff (15 s → 10 min cap). After
  `fallbackAfter` (default 3) consecutive failures switch the boss to `bossFallbackModel` and `notify` the user.
  Switch back after `primaryRetryMin` (default 60 min).
- Worker error: AgentManager records it; the manager delivers a `stuck` report to the boss (with the error),
  and the boss decides (resume via `worker_message`, respawn, change model).
- Omni restart: missions reload; boss session reopened by its session file; interrupted workers are listed in a
  `[mission] Omni restarted` delivery so the boss can resume them (`worker_message` resumes a finished agent's
  session).
- Every state change is in mission.json (atomic write) + events.jsonl (append), so nothing depends on memory.

### Storage layout

```
~/.omni-agent/projects/<slug>/          slug = basename + short hash of the absolute project dir
  project.json                          { dir, name, createdAt }
  memory/                               project vault (MEMORY.md, Memory/*.md) — Vault class, separate root
  graph/kg.sqlite                       knowledge graph
  graph/imports/                        graphify / Ghidra raw exports
  artifacts/                            dumps, decrypted binaries, scripts, Ghidra projects (workers write here)
  missions/<mission-id>/
    mission.json                        state: goal, models, status, boss session, tasks, workers, notes, queue, notifications
    ledger.md                           human-readable running log
    events.jsonl                        append-only event log
    reports/<worker-id>.md              full worker reports
    workers/<worker-id>/brief.md        the brief, handoffs
```

## Decided by the user

- Boss runs on OpenCode with an API model, selectable per mission. Workers OpenCode or Claude Code, per task.
- Nothing in the target project's folder; everything project-related in Omni's own folder.
- The boss decides when to ping the user; API errors/limits must not stop the boss or its tasks.
- `notify` only stores and shows for now; no mobile app, no push/channel plumbing.
- Live view with boss on top, layers of workers and subagents, interact with any of them.

## Calls made by the builder (Claude), open to change

- Storage root `~/.omni-agent/projects/<slug>/`; global vault stays for cross-project things.
- Knowledge graph on `node:sqlite` (Node ≥ 22.13; the user runs 24) in the server; the plugin (Bun) reaches it over HTTP.
- graphify still builds source graphs (its output is imported, and moved out of the repo when it was not there before).
- Ghidra import via a Java headless post-script (no Python/Jython dependency).
- Worker report format and caps above; boss tool result cap ~4k chars; boss rebirth at 60% of its window.
- Heartbeat 30 min; retry/backoff numbers above.
- Work on a separate branch/worktree because `main` has uncommitted changes from another session.

## Milestones

1. Mission core: project store, mission manager, boss chat with boss-only tools, worker spawn/report/summary/
   message/cancel, ledger, notify, routes. Tests.
2. Mission view UI: new-mission dialog, live tree, node drawer with message box, ledger, notifications. Screenshot.
3. Resilience: retries/backoff/fallback model, rebirth, restart resume, stuck reports. Tests.
4. Project-scoped memory for mission agents; Claude workers get Omni tools via MCP; `ask_boss`, `handoff`.
5. Knowledge graph: sqlite store, kg tools, graphify import, Ghidra import, graph view of the project KG. Screenshot.
6. Claude Code internal subagents shown in the tree; polish, docs, README.
