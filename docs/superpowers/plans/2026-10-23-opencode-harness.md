# OpenCode Harness (replaces pi) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Omni's chats and background agents run on OpenCode (`opencode serve`) instead of `pi --mode rpc`, so OpenCode's free models and every BYOK provider OpenCode knows work, with the goal hook, plan tool, agents, memory, graph and MCP still working.

**Architecture:** One `opencode serve` child per Omni server (`OpencodeServer`), reached over HTTP + the `/global/event` SSE stream. Each chat is an `OpencodeRpc` that keeps the exact `PiRpc` contract (methods, `state`, `sid = "pi:<sessionID>"`, `proc`, `streaming`, `inFlight`, events): it translates OpenCode events into **pi RPC event shapes** and feeds them to the existing `normalizePiRpcEvent`, and writes a **pi-format JSONL mirror** per chat so history, reload, continue/fork, delete, digests and goal restore keep working through the existing watcher. The pi extensions are rebuilt as one OpenCode plugin loaded only by Omni's server via `OPENCODE_CONFIG_DIR`.

**Tech Stack:** Node ≥22 built-ins only (server), OpenCode 1.18.x HTTP API, OpenCode plugin API (`@opencode-ai/plugin`, auto-installed by OpenCode into its config dir), `node --test`.

**Spec:** this conversation (user: "switch the pi harness running at the background to opencode … use both opencode free models and byok"; scope chosen: full replacement now). Probe evidence: OpenCode free model `opencode/big-pickle` answers through `opencode serve`; plugin tools load from `OPENCODE_CONFIG_DIR/plugin/*.js` and their `metadata` arrives as the tool part's `state.metadata`.

## Global Constraints

- No npm dependencies in Omni itself ("Node built-ins only. No npm install."). The plugin may import `@opencode-ai/plugin` only from the shim inside the OpenCode config dir (OpenCode installs it there).
- Internal harness key stays `"pi"` and chat ids stay `pi:<id>` (hook, UI, registry and tests key on it); only user-visible strings say OpenCode.
- `opencode serve` listens on `127.0.0.1` only, with a random `OPENCODE_SERVER_PASSWORD` per launch.
- The plan tool is named exactly `plan` and its result carries `details {plan, events, ok}`; hook prompts keep the `<omni-hook …>` wrapper.
- Never spoof OpenCode's client identity to providers: model calls go through OpenCode itself.
- Every task keeps `node --test` green.

## Review Focus

1. **opencode serve dies mid-run** — chats must reattach after the server restarts (sessions persist in OpenCode's DB), `streaming` must drop to false, the watchdog must not kill the shared server for one chat. Test in Task 3.
2. **A message sent while the chat is busy** (steer) — must not error or create a second run; OpenCode queues it into the running loop. Test in Task 3.
3. **Provider rejects the request (403 FreeTierError, 400, 429)** — must surface as an assistant `msg` with `stopReason:"error"` and a `Model error: …` block so the goal hook's recovery runs, including the case with no assistant message (`session.error` only). Test in Task 1.
4. **Continuing an old pi chat** (a native pi JSONL, no OpenCode session) — must open as a new OpenCode chat that shows the old history and carries a transcript of it to the model. Test in Task 4.
5. **Abort/stop with a tool running** — the tool part ends `error`/aborted, the assistant message ends `stopReason:"aborted"`, the status ends `streaming:false`. Test in Task 1.

---

### Task 1: Event translator (OpenCode → pi RPC shapes + mirror entries)

**Files:**
- Create: `server/opencode-events.mjs`
- Test: `test/opencode-events.test.mjs` (fixtures: `test/fixtures/opencode-turn.json`, captured from a real tool-using turn, an aborted turn and a `session.error`)

**Interfaces:**
- Produces: `class OpencodeTranslator { constructor({ sessionID, cwd }); push(payload) → { rpc: object[], entries: object[] } }` — `payload` is one SSE `payload` (`{type, properties}`).
- Produces: `stopReasonOf(info) → "stop"|"toolUse"|"length"|"error"|"aborted"` (`finish:"stop"→stop`, `"tool-calls"→toolUse`, `"length"→length`; `error.name==="MessageAbortedError"→aborted`; other errors→error).
- Produces: `errorText(err) → string` (`APIError`: `"<statusCode>: <responseBody or message>"`; others: `data.message || name`).
- Produces: `piUsage(tokens, cost) → {input, output, cacheRead, cacheWrite, totalTokens, cost:{total}}`.
- Produces: `historyEntries(messages, { cwd }) → entries[]` (GET `/session/:id/message` → mirror entries; used by Tasks 3/4).

Mapping (pi RPC event emitted):
- `session.status busy` (not streaming yet) → `agent_start`; `session.idle` / `status idle` → `agent_settled`.
- new assistant `message.updated` → `message_start {message:{role:"assistant", model}}`; `info.summary===true` messages are compaction summaries: no `message_*`, they end as `compaction_end {summary}`; a `compaction` part → `compaction_start`.
- text / reasoning part first seen → `text_start` / `thinking_start` (`contentIndex` = part's ordinal in its message); `message.part.delta` → `text_delta` / `thinking_delta`; part with `time.end` → `text_end` / `thinking_end {content}`.
- tool part `pending` → `toolcall_start {id: callID, toolName}`; first `running` → `toolcall_end {toolCall:{id,name,arguments: state.input}}` + `tool_execution_start`; `running` with new `metadata.output` → `tool_execution_update`; `completed`/`error` → `tool_execution_end {result:{content:[{type:"text",text}], details: state.metadata}, isError}`.
- assistant `message.updated` with `time.completed` or `error` → `message_end {message: pi assistant (content: text/thinking/toolCall in part order, usage, stopReason, errorMessage, model, responseId: info.id)}` followed by one `message_end {message:{role:"toolResult", toolCallId, toolName, content, isError, details}}` per finished tool part. Emitted once per message id.
- `session.error` with no open assistant message → synthetic assistant `message_end` with `stopReason:"error"` and `errorMessage` (MessageAbortedError → `aborted`).
- user `message.updated` + its text parts → no rpc event (the prompt echo covers live), one mirror `message` entry; text starting `[omni-agent-result]` → `custom_message {customType:"omni-agent-result"}` entry and a `message_end {message:{role:"custom", customType:"omni-agent-result", content}}` rpc event.
- `entries` are pi JSONL entries (`{type:"message", id, parentId, timestamp, message}`, `compaction`, `custom_message`, `model_change`) for every `message_end` above.

- [ ] **Step 1: Capture fixtures** with the probe flow (a bash tool turn, an abort mid-tool, a bad-model `session.error`, a 403 assistant error) into `test/fixtures/opencode-turn.json` (payload arrays only, ids kept).
- [ ] **Step 2: Write failing tests**: `translates a tool turn into pi events in order` (asserts `agent_start`, `message_start`, `toolcall_start`, `tool_execution_end` with `result.details`, assistant `message_end` with `stopReason:"toolUse"`, toolResult `message_end`, final `agent_settled`); `plan tool metadata becomes details` (tool `plan`, metadata `{plan,events,ok}` → `normalizePiRpcEvent` yields `tool` end with `details.plan`); `403 assistant error → stopReason error and "Model error: 403: …"` (pipe through `normalizePiRpcEvent`, assert the block text); `session.error without a message → synthetic error message`; `abort → aborted`; `each message_end once even when message.updated repeats`; `omni-agent-result user text → custom message`.
- [ ] **Step 3: Run** `node --test test/opencode-events.test.mjs` — expect FAIL (module missing).
- [ ] **Step 4: Implement** `server/opencode-events.mjs`.
- [ ] **Step 5: Run** the test file — expect PASS.
- [ ] **Step 6: Commit** `feat(opencode): translate opencode events into pi rpc shapes`.

### Task 2: `OpencodeServer` (spawn, HTTP, global SSE)

**Files:**
- Create: `server/opencode-server.mjs`
- Test: `test/opencode-server.test.mjs` (a fake OpenCode on `node:http`: `/global/health`, `/global/event` SSE, `/session` routes)

**Interfaces:**
- Produces: `class OpencodeServer extends EventEmitter { constructor({ bin="opencode", configDir, env={}, log, spawn, url=null, password=null }); start() → Promise<void>; stop(); request(method, path, { directory, body, timeoutMs=120000 }) → Promise<any>; listen(sessionID, fn) → unsubscribe; get proc; get url }` — emits `"down"` (process exited/SSE lost) and `"up"` (healthy again).
- Produces: `sessionIdOf(payload) → string|null` (`properties.sessionID` ‖ `properties.info.sessionID` ‖ `properties.part.sessionID`).
- `start()`: spawns `<bin> serve --port 0 --hostname 127.0.0.1` with env `{...process.env, ...env, OPENCODE_CONFIG_DIR: configDir, OPENCODE_SERVER_PASSWORD: password}`, reads `opencode server listening on (http://\S+)` from stdout, then opens `/global/event`. `url` given → attach without spawning (tests).
- Auth header `Basic base64("opencode:" + password)` on every request (verify the username against the running server; adjust if it differs).
- Restart on unexpected exit with `restartDelay` from `server/watchdog.mjs`; SSE reconnects with back-off; listeners survive both.
- On Windows spawn `opencode.cmd` via `shell:true` with only fixed args (no user text in argv).

- [ ] **Step 1: Write failing tests**: `routes SSE payloads to the session's listener only`; `request adds directory and auth, throws Error(message) on 4xx/5xx JSON`; `reconnects the event stream and emits down/up`; `stop() does not restart`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS; also smoke-run against the real binary: `node -e` start → `request("GET","/global/health")` → stop.
- [ ] **Step 5: Commit** `feat(opencode): opencode serve supervisor and event bus`.

### Task 3: `OpencodeRpc` (the PiRpc stand-in) + JSONL mirror

**Files:**
- Create: `server/opencode-rpc.mjs`
- Test: `test/opencode-rpc.test.mjs` (fake `OpencodeServer`: records requests, lets the test push payloads)

**Interfaces:**
- Consumes: Task 1 `OpencodeTranslator`, `historyEntries`; Task 2 `OpencodeServer`.
- Produces: `class OpencodeRpc extends EventEmitter` with the PiRpc members listed in the explorer contract: `constructor({ server, cwd, model, provider, thinking, env, bus, meta, system="", tools=null, mirrorDir, compactAt=0 })`, `start()`, `waitReady()`, `stop()`, `startWatchdog()`, `stopWatchdog()`, `owns(file)`, `prompt(text,{images,echo,behavior})`, `abort()`, `newSession()`, `switchSession(file)`, `clone()`, `setModel(provider,id)`, `setThinking(level)`, `compact()`, `stats()`, `models()`, `entries()`, `messages()`, `refreshState()`, `thinkingLevels(model)`; props `sid`, `proc`, `cwd`, `state`, `streaming`, `inFlight`, `restoring`, `resumeFile`, `crashedSid`, `onRestart`, `lastEventAt`, `stopped`, `openTools`.
- `proc` is `{ pid: null, kill() {} }` while the server is up (background-agent tree-kill must never reach the shared server), `null` after `stop()` or while the server is down.
- `state = { sessionId, sessionFile, model: {provider, id, name, contextWindow, maxTokens, reasoning, variants}, thinkingLevel, isStreaming, sessionName }`; `refreshState()` emits the same `session` + `status` events PiRpc does.
- Mirror: `<mirrorDir>/<ISO-ts with : → ->_<sessionID>.jsonl`, first line `{type:"session", version:3, id:sessionID, cwd, timestamp, harness:"opencode"}`; appends Task 1 `entries`; `sessionFile` = that path.
- `start()` creates a session (`POST /session {}` in `cwd`) unless `switchSession` follows; `prompt()` → `POST /session/:id/prompt_async {parts, model:{providerID,modelID}, variant, system, tools, agent:"build"}`; images → `file` parts with `data:` URLs; `echo` emits the live user `msg` like PiRpc; resolves `{success:true}` on 2xx, `{success:false,error}` otherwise; waits for a running `compact()` first.
- Thinking: OpenCode `variants` of the model are the levels (`none`→`off`); `off` without a `none` variant sends no variant; a model without variants has `["off"]` labelled `{off: reasoning ? "auto" : "off"}`.
- `compact()` → `POST /session/:id/summarize {providerID, modelID}`, emitting `compaction_start/_end` rpc shapes; with `compactAt>0`, a settle whose last assistant context (`input+cacheRead`) exceeds it compacts before the next prompt.
- `switchSession(file)`: mirror header `harness:"opencode"` → attach to its id; otherwise Task 4.
- `clone()` → `POST /session/:id/fork {}`, new mirror file (copy of the current one with the new header), attach.
- Permission backstop: a `permission.asked`/`permission.updated` payload for this session is answered `POST /session/:id/permissions/:permissionID {response:"always"}`.
- Server `down` → `streaming=false`, emit `status{streaming:false}`, `restoring=true`, `crashedSid=sid`; `up` → reattach, `restoring=false`, `onRestart?.()`. Watchdog stall → `abort()` only.

- [ ] **Step 1: Write failing tests**: `start creates a session, writes the mirror header and announces sid pi:<id>`; `prompt posts prompt_async with model, variant and echo`; `a steer while streaming posts without waiting`; `events drive streaming and the bus (via translator)`; `mirror gets user/assistant/toolResult entries and the watcher's normalizePiEntry reads them back`; `clone forks and switches the mirror`; `switchSession(opencode mirror) attaches to that session`; `server down → streaming false, up → onRestart`; `proc has no pid`; `entries() returns the mirror's entries so latestPlan finds the plan`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement. Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(opencode): OpencodeRpc chat with pi-compatible contract and jsonl mirror`.

### Task 4: Watcher ids + continuing old pi chats

**Files:**
- Modify: `server/watchers.mjs` (`sidForFile`), `server/opencode-rpc.mjs` (`switchSession` import path)
- Test: `test/opencode-rpc.test.mjs`, `test/server.test.mjs` (watcher case)

**Interfaces:**
- `sidForFile("pi", ".../2026-10-23T00-00-00_ses_e99eaa6e3fferGKykKmPKDLWNM.jsonl") === "pi:ses_e99eaa6e3fferGKykKmPKDLWNM"` (also keep the uuid form).
- Importing a native pi file: new session; the new mirror starts with the pi file's entries copied verbatim (history stays visible), then `POST /session/:id/message {noReply:true, parts:[{type:"text", text}]}` where `text` = `"Earlier conversation, imported from pi (most recent last):\n" + tail of user/assistant/tool lines within 48 000 chars`.

- [ ] **Step 1: Failing tests**: `sid for an opencode mirror file`; `continuing a pi chat seeds a noReply transcript and copies history`.
- [ ] **Step 2–4:** run (FAIL), implement, run (PASS).
- [ ] **Step 5: Commit** `feat(opencode): opencode chat ids in the watcher; continue old pi chats`.

### Task 5: Wire the server to OpenCode

**Files:**
- Modify: `server/config.mjs` (`opencodeBin`, `opencodeConfigDir` = `~/.omni-agent/opencode`, `opencodeMirrorDir` = `<piSessionsDir>/opencode`, child env), `server/index.mjs` (`startPi`, `createPi` for agents, `/api/pi/models`, `/api/pi/thinking-levels`, `/api/pi/thinking` level validation, `restartPis` → re-write config + `server.request("POST","/global/dispose")`, judge/summarizer), `server/hook.mjs` (`runJudge` replaced by `runOnce`), `server/agents.mjs` (persona → `system`/`tools` options instead of `extraArgs`), `server/opencode-config.mjs` (new)
- Test: `test/server.test.mjs`, `test/hook.test.mjs`, `test/agents*.test.mjs` updates; `test/opencode-config.test.mjs`

**Interfaces:**
- `writeOpencodeConfig({ dir, root, mcpServers, omniMcp, providers }) → path` writes `<dir>/opencode.json`: `permission` allow for `edit`, `bash`, `webfetch`, `external_directory`, `doom_loop`; `tools: { question: false }`; `mcp` from Omni's MCP list (stdio → `{type:"local", command:[cmd,...args], environment}`, http → `{type:"remote", url, headers}`) plus `omnidroid` from `omniMcp`; `provider` from Omni's custom providers (Task 7). Also writes `<dir>/plugin/omni.js` shim (Task 6).
- `runOnce({ server, provider, model, system, input, cwd, session=null }) → Promise<string>` in `server/opencode-rpc.mjs`: one `POST /session/:id/message` with `system`, `tools: {"*": false}` (verify wildcard; else list tool ids from `/experimental/tool/ids` and set each false), returns joined text parts; `session` reuses a status-box conversation per goal, otherwise the session is deleted after.
- `/api/pi/models` → connected providers from `GET /provider` (`{provider, id, name, contextWindow, thinking, thinkingLabels, free: cost.input===0&&cost.output===0}`), skipping `status:"deprecated"`, filtered by `cfg.piModels` when set; the `opencode` provider always listed in full.
- `THINKING_LEVELS` already includes `max`; `/api/pi/thinking` clamps to the model's variant levels.

- [ ] **Step 1: Failing tests**: server test with a fake `OpencodeServer` (`cfg.opencodeServer`): `/api/pi/open` → `OpencodeRpc` chat, `/api/pi/prompt` posts `prompt_async`, `/api/pi/abort` aborts + cancels the goal, `/api/pi/models` lists connected providers, `/api/pi/model` persists the pick; `writeOpencodeConfig` output; hook `summarize` via `runOnce`.
- [ ] **Step 2–4:** run (FAIL), implement, run full `node --test` (PASS).
- [ ] **Step 5: Commit** `feat(opencode): run Omni chats, agents, judge and status box on opencode`.

### Task 6: The Omni OpenCode plugin

**Files:**
- Create: `integrations/opencode/omni-plugin.mjs` (factory, no package imports), `integrations/opencode/shim.js` (template copied to `<configDir>/plugin/omni.js`)
- Reuse: `ui/plan.js`, `integrations/pi/omni-agents-lib.mjs`, `integrations/pi/omni-context-lib.mjs`, `server/memory.mjs`
- Test: `test/opencode-plugin.test.mjs` (call the factory with a stub `tool` = identity and `tool.schema` = a tiny chainable stub; stub `client`; fake Omni HTTP)

**Interfaces:**
- `createOmniPlugin({ tool, root }) → Plugin` — `Plugin(input) → Hooks`; the shim: `import { tool } from "@opencode-ai/plugin"; import { createOmniPlugin } from "<file URL of omni-plugin.mjs>"; export const Omni = createOmniPlugin({ tool, root: "<repo>" });`
- Tools (args mirror the pi extensions; results `{output, metadata}`):
  - `plan` — loose schema (`action` enum + optional fields as in `integrations/pi/omni-plan.ts:24-38`), state per `ctx.sessionID` rebuilt lazily from `client.session.messages` (last `plan` tool part's `state.metadata`), `execute` = `applyPlanAction`, `metadata = {plan, events, ok, action}`.
  - `agent_start|agent_status|agent_wait|agent_message|agent_cancel|job_start|job_wait|job_output|job_kill` — `AgentsClient` from the agents lib against `OMNI_AGENT_URL`, identity `{parentSid: "pi:"+sessionID, parentSessionId: sessionID}` (the server derives depth, Task 5 adds `depth` from the parent agent record when absent).
  - `claude_task`, `memory_search|memory_recall|memory_save`, `graph_build|graph_query|graph_explain`, `omnidroid_wait_device`.
- Hooks: `experimental.chat.system.transform` appends `CONTEXT_GUIDANCE`, the plan tool guidelines, the graph note (when `<cwd>/graphify-out/graph.json` exists) and the omnidroid note; `experimental.chat.messages.transform` appends `planReminder(plan)` to the newest user message (not persisted) and runs `repairToolCallIds`-equivalent only if needed; `chat.message` clears a plan's `waiting` for a non-`<omni-hook` user message.
- Agent report delivery: one `DeliveryPoller` per session that has started agents; deliver = `client.session.promptAsync({ path:{id}, body:{ parts:[{type:"text", text:"[omni-agent-result] "+report}] } })` (the translator turns that into the system line, Task 1).

- [ ] **Step 1: Failing tests**: `plan tool applies actions and returns metadata`; `plan state survives a fresh plugin instance (rebuilt from messages)`; `system transform includes CONTEXT_GUIDANCE`; `messages transform appends the plan reminder`; `agent_start posts to /api/agents with parentSid pi:<sessionID>`; `delivery prompts the session with [omni-agent-result]`.
- [ ] **Step 2–4:** run (FAIL), implement, run (PASS); live check: start Omni's `OpencodeServer`, `GET /experimental/tool/ids` lists `plan` and `agent_start`.
- [ ] **Step 5: Commit** `feat(opencode): omni plugin (plan, agents, claude, memory, graph, omnidroid)`.

### Task 7: Providers (BYOK) and MCP dialogs write OpenCode config

**Files:**
- Modify: `server/providers.mjs` (OpenCode shape), `server/mcp.mjs`, `server/index.mjs` routes `/api/providers*`, `/api/mcp*`; `ui/settings.js` / `ui/mcp-settings.js` only where labels say pi
- Test: `test/providers.test.mjs`, `test/server.test.mjs`

**Interfaces:**
- Custom providers live in `~/.omni-agent/opencode-providers.json` (`{providers:{name:{baseUrl, apiKey, models:[{id,name,contextWindow,maxTokens,reasoning}]}}}`), rendered into `opencode.json` as `{npm:"@ai-sdk/openai-compatible", name, options:{baseURL, apiKey}, models:{id:{name, limit:{context, output}}}}`.
- A key for a built-in provider (`openrouter`, `anthropic`, `opencode` Zen, …) → `PUT /auth/:providerID {type:"api", key}`; `DELETE` removes it.
- First start migrates pi's `models.json` custom providers once (marker file) so the user's BYOK setup carries over.
- After a change: rewrite config, `POST /global/dispose` (OpenCode reloads config per instance), restart nothing else.

- [ ] **Steps:** failing tests (`provider saved → opencode.json provider entry`, `built-in key → PUT /auth`, `migration copies models.json once`), run FAIL, implement, run PASS, commit `feat(opencode): BYOK providers and MCP servers through opencode config`.

### Task 8: Install script, docs, user-visible strings

**Files:**
- Modify: `scripts/install.mjs` (OpenCode config dir, shim, personas to `<configDir>/agents/` read by `server/agents.mjs`, `opencode` presence check; drop pi extension copying), `README.md` (Run section: OpenCode instead of pi), `ui/*.js` strings that name pi to the user (composer caption, settings), `server/access.mjs` approval titles
- Test: `test/install.test.mjs`, `test/ui.test.mjs`

- [ ] **Steps:** update tests for the new install layout, run FAIL, implement, run PASS, commit `chore(opencode): install and docs for the opencode harness`.

### Task 9: Remove pi

**Files:**
- Delete: `server/pi-rpc.mjs`, `integrations/pi/*.ts`, `integrations/pi/subagent/`, pi-only tests (`test/pi-rpc.test.mjs`, `test/pi-thinking.test.mjs` cases that need a pi child), `server/pi-models.mjs` if unused
- Keep: `integrations/pi/*-lib.mjs` (imported by server and plugin), `integrations/pi/agents/*.md` (personas)
- Modify: `server/config.mjs` (drop `piCli`, `piBin`, `findPiCli`), `server/context-policy.mjs` (compactAt → `OpencodeRpc` option, no models.json caps)

- [ ] **Step 1:** `rg -n "PiRpc|piCli|piBin|pi-rpc" server scripts test ui` — every hit removed or switched.
- [ ] **Step 2:** `node --test` — PASS.
- [ ] **Step 3: End-to-end:** start Omni (`node server/index.mjs`), open a chat with `opencode/big-pickle`, send "run `echo hi` with bash", see streaming, tool card, answer; stop mid-run; set a `/goal` and watch the hook re-engage; reload the page and see the history; restart Omni and see the chat in the list.
- [ ] **Step 4: Commit** `refactor: remove the pi harness`.
