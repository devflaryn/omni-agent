# Omni Agent

A local agentic OS for one person: every **pi harness** and **Claude Code** conversation
on this machine shows up live in one window, tokens animate in while a model streams,
whole messages just appear when it is not, and a personal **Obsidian vault** is the
memory both harnesses share. Node built-ins only. No npm install.

It continues and replaces `Desktop/pi/pi-gui`.

## Run

Runs on macOS (Apple silicon and Intel), Windows and Linux. Needs Node 22+; the desktop window needs
Python 3.11+ with `pip install pywebview` (WKWebView on macOS, WebView2 on Windows); without pywebview
it falls back to an Edge app window on Windows, or your browser elsewhere.

**macOS:** double-click **Omni Agent.command** (or run `python3 desktop/omni_desktop.pyw`). It starts the
server hidden, opens a native window, and turns LAN access on so phones and laptops on your network can
open the link shown in the sidebar footer. The launcher finds Homebrew/nvm/fnm/volta `node` itself even when
started from Finder; set `OMNI_NODE` to point at another binary.

**Windows:** double-click **Omni Agent.cmd** (or a Desktop shortcut pointing at
`pythonw.exe "…\desktop\omni_desktop.pyw"`).

Console mode is still there:

```
./start.sh                     # macOS/Linux: opens http://127.0.0.1:4400, pi works in ~/Desktop
./start.sh /some/project       # pi works in that folder (the Graph tab uses this folder)
./start.sh . --lan             # also reachable from other devices on your network
start.cmd "C:\some\project"    # the Windows equivalents
start.cmd . --lan
node server/index.mjs --no-pi  # observe only, don't start a pi child (any OS)
```

pi is started as `node <pi>/dist/cli.js --mode rpc`; the entry point is found through the `pi` launcher
on PATH (a symlink on macOS/Linux npm installs), `%APPDATA%\npm` on Windows, or the usual global
`node_modules` prefixes. Set `piCli` in `omni.config.json` to override, or `piBin` to run a `pi` launcher
directly.

### Use it from another device or another network

Omni then runs as a small server: this computer is **the host**, everything else is **a remote browser**.

| | the host (this computer's window, `http://127.0.0.1:4400`) | a remote browser (`https://<address>:4443`) |
|---|---|---|
| login | none | the host's password |
| reading chats, files, memory, graphs | yes | yes (files only inside the chats' folders and the vault) |
| sending a message, any change | runs at once | **waits for Approve/Deny on the host**, then runs or is refused |
| Settings → Remote, shutdown | yes | never |

1. Start with `--remote` (or `"remote": true` in `omni.config.json`; `--lan` means the same); the desktop
   launcher already does. Omni keeps its own window on `127.0.0.1:4400` and adds a second listener on
   every interface, port `4443` (`remotePort`).
2. In the host's window open **Settings → Remote** and set a password (12+ characters). It is stored as a
   scrypt hash in `~/.omni-agent/remote-auth.json`.
3. On the same network, open the address Settings → Remote shows, e.g. `https://192.168.0.15:4443/`.
   From a different network, forward TCP 4443 on your router to this computer and open
   `https://<your public IP>:4443/`. If the firewall blocks it run `scripts\allow-lan.cmd` (or
   `scripts/allow-lan.sh`) once.
4. The remote listener speaks HTTPS with a self-signed certificate made by openssl on first start
   (`~/.omni-agent/tls/`; set `tlsCert`/`tlsKey` for your own). The browser warns once: check that it
   shows the SHA-256 fingerprint from Settings → Remote before typing the password. Without openssl it
   falls back to plain HTTP and says so.
5. Each message or change a remote browser sends appears in the host's window as a card saying what it
   asks for (the message text, the command an MCP server would run; secrets hidden) with **Approve** and
   **Deny**. It waits up to `remoteApprovalTimeoutSec` (300 s), then is refused.

#### From anywhere, without touching the router (VPS relay)

With `"relay": { "host": "<vps>" }` in `omni.config.json`, this PC keeps an outgoing SSH connection to
the VPS (`server/tunnel.mjs`), and `https://<vps>:4443/` reaches Omni from anywhere:

    browser ──TLS──▶ VPS :4443 omni-relay ──PROXY line + same TLS bytes──▶ ssh -R ──▶ PC 127.0.0.1:4444 (HTTPS)

- **The VPS cannot read the traffic.** The relay (`relay/omni-relay.mjs`) holds no certificate; TLS ends on
  this PC. The certificate a browser sees through the VPS has the same fingerprint as Settings → Remote shows.
- **The tunnel key can do one thing.** User `omni-tunnel` has no password and no shell; its key may only open
  the remote forward on the VPS's `127.0.0.1:14443`, enforced in `authorized_keys` and an sshd `Match` block
  (`relay/setup-vps.sh`). The VPS host key is pinned in `~/.omni-agent/relay/known_hosts`.
- **The relay drops** anything that does not start with a TLS handshake, more than 32 connections at once or
  120 a minute from one address, and idle connections after 15 minutes. It runs as a throwaway systemd
  `DynamicUser` with a read-only system; it logs counts only.
- **The visitor's real address** travels in the PROXY line, so the lockout below and the approval cards
  name the real address, not the tunnel. The local listener that reads PROXY lines is loopback-only.
- Setup: `ssh-keygen -t ed25519 -f ~/.omni-agent/relay/id_ed25519`, pin the VPS key in
  `~/.omni-agent/relay/known_hosts`, copy `relay/` to `/opt/omni-relay/` on the VPS, run
  `bash /opt/omni-relay/setup-vps.sh "<public key>"`, install `omni-relay.service`, and
  `systemctl enable --now omni-relay`.

**A new device needs your Approve once,** even with the right password (`remoteDeviceApproval`, on by
default): its sign-in waits as a card in the host's window, and once approved the device is remembered for
180 days (Settings → Remote lists and removes them). A leaked password alone therefore reads nothing.

Five wrong passwords from one address lock it out for 15 minutes; thirty from anywhere lock every remote
sign-in for 15 minutes. Remote sessions last `remoteSessionDays` (7) and end when the server restarts or
the password changes. A request that reaches the host's port through a local tunnel or reverse proxy, or
names a non-loopback `Host`, counts as remote too.

### Repo graphs (Graph tab)

**Build repo graph** runs your installed `graphify` on the selected session's working directory
(AST extraction plus clustering, no LLM, a few seconds) and writes an Obsidian-friendly slice into
`vault/Graphs/<repo>/`: one note per source file with wikilinks to the files it calls or imports, plus
an `_index` note listing every community. Open the vault in Obsidian and its graph view shows the repo.
The tab itself draws the best-connected nodes (filter, pan, zoom, click a node for its links) and
**Ask the graph** runs `graphify query` for a token-budgeted answer. Tick **Attach repo graph context**
in the composer to prepend that answer to a prompt, so the model reads the graph instead of the codebase.

Tests: `npm test`.

### Unattended multi-day runs

`node scripts/run.mjs --cwd <project> --goal "…"` starts a durable run: it keeps one
pi session alive for days, re-engaging it toward the goal, surviving crashes (it resumes
the same session), compacting without losing the goal, and offloading huge tool output.
State lives in `vault/Runs/<run-id>/` (`run.json`, `ledger.md`, `events.jsonl`, `artifacts/`).
Resume after a reboot with `--resume <run-id>`. The desktop/browser GUI is a read-only
observer — open `http://127.0.0.1:4400` to watch; closing it never stops the run.

Run `node scripts/install.mjs` once first so pi loads the `omni-run` extension
(context re-injection + durable compaction) and the recovering model fallback.

For weak small-context models, set in `~/.pi/agent/settings.json` a longer
`httpIdleTimeoutMs` (e.g. 600000) so pi's own HTTP retry runs before Omni's watchdog kills and
restarts the child. Keep it strictly BELOW Omni's `stallMs` (default 900000) — i.e.
`httpIdleTimeoutMs` 600000 < `stallMs` 900000 — so the watchdog only fires after pi's own retry
has had its chance. Also make sure each
model's `contextWindow` in `~/.pi/agent/models.json` matches reality (DeepSeek V4 Flash is
1.3M; the chat-dated DeepSeek is 128k — a wrong value makes pi compact too late or too often).

### Long runs: compaction, auto-continue, goals that survive a restart

What used to end long runs early (measured over every pi chat on this machine): with a model declared at 1M
tokens pi only compacts past ~975k, but the model itself started ending its turns at 375k–900k claiming its
"context is nearly exhausted" and writing handoffs for a fresh session. Nothing compacted, nothing continued.

- **Compaction point** (`context.compactAt`, default 256000; Settings → Long runs). pi compacts when a chat's prompt
  passes `contextWindow − compaction.reserveTokens`, so Omni caps each model's *effective* window in
  `~/.pi/agent/models.json` `providers.<P>.modelOverrides[<id>].contextWindow` = compactAt + reserveTokens before
  every pi start. The declared model entry is untouched; overrides you write by hand are never touched; Omni's
  own are tracked in `~/.omni-agent/context-caps.json`; `0` removes them. Floor 100k (a compacted chat still holds
  the system prompt, the kept recent turns and the summary, ~60k). pi compacts between turns and keeps working.
- **Context is managed for the model**: the `omni-context` extension adds a static system-prompt block ("context
  size is never a reason to stop or hand off") and, above 70% of the budget, a one-line note on the newest message.
- **Auto-continue** (`context.autoContinue`, default on, even with the goal hook off): a turn that ends because the
  model *believes* its context or session is used up (`integrations/pi/omni-context-lib.mjs` `classifyStop`, also
  reading the model's reasoning) is compacted and re-engaged, up to `maxContextNudges` (3) in a row without
  progress. So are output-limit stops that pi cannot recover (all output spent on reasoning) and transient
  provider errors after pi's own retries (409, connection resets, timeouts, 5xx — with a growing back-off).
  A handoff the user asked for, a real question to the user, and a finished answer are left alone.
- **Stop** halts the run and pauses that goal; it no longer switches the goal hook off for every later run.
- **Explicit goals** (`/goal`) are saved to `~/.omni-agent/goals.json` with their chat; after an Omni restart the
  newest unfinished one (active in the last 72 h, not stopped) is reopened and continued.
- The watchdog no longer kills a pi whose tool call runs long and silent (`toolStallMs`, default 4 h).
- `node scripts/replay-stops.mjs [--hook on|off]` replays every recorded pi session through the real normalizer and
  goal keeper (fake pi, nothing executed) and counts what Omni now does at each point the original run stopped.

### Background agents, Claude Code agents and background jobs

The pi agent can delegate while it keeps working (`integrations/pi/omni-agents.ts`, run by the server's
`AgentManager` in `server/agents.mjs`):

| tool | what it does |
|---|---|
| `agent_start {task, kind: "pi"\|"claude", agent?, title?, cwd?, model?}` | starts a background pi agent (optionally a persona from `~/.pi/agent/agents/*.md`) or a Claude Code session, and returns at once |
| `agent_status`, `agent_wait`, `agent_message`, `agent_cancel` | watch, wait for, steer or stop them |
| `job_start {command}`, `job_wait {id, until}`, `job_output`, `job_kill` | a shell command in the background (builds, device boots, waiting for a log line) instead of `sleep` loops |

When an agent or job finishes, its report arrives in the parent chat by itself as an `[omni-agent-result]` message
(it wakes an idle chat). A pi agent is a pi child of its own with a *managed* goal: the goal keeper continues it after
context stops, errors and length stops, exactly like the main chat. A Claude agent runs
`claude -p --input-format stream-json --output-format stream-json` unattended (`--permission-prompts none`), can be
steered mid-run (`agent_message`) and resumed after it finished. Every agent shows up live in the UI as a child chat
nested under its parent, with a strip above the composer (status, Open, Stop). Limits in `omni.config.json`
`agents`: `maxConcurrent` (6, more queue), `maxDepth` (2), `maxMinutes` (360), `claudeModel`, `claudeMaxTurns`.
The registry lives in `~/.omni-agent/agents.json`; agents that were running when Omni stopped come back as
`interrupted` (their finished, undelivered reports are still delivered). `claude_task` is now built on the same
path: it waits up to `timeoutMinutes` and leaves Claude running in the background after that, instead of dying at
pi's 10-minute HTTP timeout. The blocking `subagent` tool still exists for quick parallel lookups.

## What you get

- **Home**: one container. "What should we work on?", the composer, the working directory (recent
  folders as chips). Sending starts Omni's pi in that folder and opens the chat.
- **Chat**: a **file explorer** on the left rooted at the chat's folder, the transcript in the middle.
  Click a file and a preview column opens beside the tree: text files as text, `.md` rendered (with a
  Raw toggle), images as images, and `.zip` / `.apk` / `.jar` as the list of entries inside, where a
  text or image entry opens in place. **Reference** drops `@path` into the prompt. The folder button
  in the top bar hides or shows the explorer.
- **Transcript**: pi streams token by token; chats run in a terminal appear whole. Each run of tool
  calls folds into one line such as "Edited files, ran commands"; open it for a row per tool and a
  row for its arguments and output. Images the model reads (a `read` of a PNG) appear as small boxes
  under that line; click one for a large preview overlay. The status line
  `Thinking… 11m 20s · 15k tokens · 86 tok/sec` sits below the turn; the rate covers only the last
  five seconds of streamed output and disappears while the model waits on a tool. Click the line for
  the model's reasoning.
- **Planner** (the `plan` tool, `omni-plan.ts`): for any task bigger than a few tool calls the agent
  works the way the superpowers brainstorm → write-plan → execute flow does. **brainstorm** first:
  the goal in its own words and its scope, assumptions to check, at least two approaches with their
  trade-offs, the chosen one and why, and success criteria. The tool refuses a plan without this.
  Then **create**: milestones of small steps, each with a `done_when` check. Then execute one step at a
  time, marking it **done** only with evidence. **revise** (with a reason) keeps the finished steps and
  replaces the rest. **ask_user** parks the plan until you answer. While a plan is open, a short
  reminder of it (current milestone, current step, its check) is added to the newest message of each
  model call, so it survives compactions and does not break the prompt cache. `/plan` in a terminal pi
  prints it.
- **Goal hook** (model menu in the composer → *Goal hook*): the same idea as Claude Code's Stop hook,
  driven by the plan instead of a judge model. It acts only when pi has really stopped (nothing
  running or queued). Every plan change reaches the server on the RPC stream, so the hook knows without
  asking any model: unfinished steps → pi is re-engaged at once on the current step and its check;
  every step done → the goal is closed for good; waiting on `ask_user` → it stays quiet until you
  reply. A `/goal` must be planned: until there is a plan, pi is re-engaged to brainstorm and plan it.
  Work without a plan just ends when pi stops; if pi used tools, it is first asked once to confirm it
  is finished or plan the rest (`planlessNudges`, 1). The old judge is opt-in for that case only
  (`judgeFallback`). The chat shows one line, `Goal hook re-engaged the agent (#1): plan step 2.1 is
  not done (3/7)`, never the hook's message.
  Stops that were not the agent's choice are handled separately, because a plain "continue" would just
  fail again:
  - a reply cut off by the output limit (`length`, usually a long think) is re-engaged with "think
    briefly, make the tool call now";
  - a provider outage (5xx, 429, timeouts, `no upstreams available`) is retried after a back-off that
    doubles from `errorBackoffMs` (15 s) up to 10 min;
  - a rejected request (a 400, usually a context that grew too big or a malformed tail) is retried
    once, then the context is compacted (`errorCompactAfter`, 2). If it is still rejected after that,
    the goal pauses with a note instead of piling up re-engages.
  The same step stopping `loopK` (3) times in a row escalates ("try a different approach, revise or
  skip it"). `maxIdleNudges` (5) re-engages in a row without a tool call or plan change pause the goal;
  any message resumes it.
  **Goal box** (pinned above the chat): the goal, the phase and `x/y steps`, a progress bar with one
  segment per milestone, the current step with its check, and *Show plan* for the whole checklist.
  This updates live from the plan with no model call. Its status text comes from a separate
  summarizer in a side conversation of its own: one pi session per goal under
  `~/.omni-agent/status-sessions/`, never the agent's chat. It writes only when the plan moves (plan
  written or revised, a milestone reached, the plan finished), never on timers or tool counts. It uses
  the chat's model unless *Status box model* (or `summaryProvider`/`summaryModel`) says otherwise.
  Re-engages restate the goal verbatim only every `restateEvery` (10) times and after a compaction.
  All of these are `hook` keys in `omni.config.json`.
- **History drawer** (☰ in the top bar): every pi and Claude Code chat on this machine, grouped by
  day, with a pulsing dot for a chat working right now. Hover for ✕ to delete (moves to
  `~/.omni-agent/trash/`). Claude Code chats open read-only; pi chats continue in Omni's pi, or fork
  when the chat is still open in a terminal (the composer caption says which). The drawer's other
  tabs are Memory (search, edit, import, digest), Graph (build and query a repo graph) and Tokens.
- **Providers** (⚙ in the top bar): pick a preset (OpenRouter, OpenAI, Anthropic, Google, DeepSeek,
  Groq, xAI, Mistral, Together, Fireworks, Ollama, LM Studio, or any OpenAI/Anthropic-compatible
  URL), paste the key, type the model ids one per line. The model picker lists only those models.
  The list is also the **fallback order**: drag the six-dot grip under a provider (or focus it and
  use the arrow keys) to move it. When a model returns any error, pi switches to the next model
  below it and continues the turn — the failed model's error is never sent to the new model.
- **Composer**: "Do anything", + for a file reference, memory and repo-graph attachments, and the
  model / thinking picker. The attachment choices are remembered across reloads and shared by Home
  and Chat; a model or thinking level picked before pi runs is saved in `omni.config.json` and the
  next pi child starts with it. pi only: Claude Code is never launched from the UI.
- **Graph tools for the model**: pi has `graph_build`, `graph_query` and `graph_explain` (the
  `omni-graph.ts` extension). Every turn the system prompt says whether the chat's folder already has
  a graph, so the model builds one on its own when a task spans several files and asks the graph
  instead of reading the whole tree. Reinstall with `node scripts/install.mjs` after updating.

## The vault (`vault/`)

Open it in Obsidian (Open folder as vault). Layout:

```
MEMORY.md                 auto-generated index, one line per note
Memory/<slug>.md          one durable fact per note: frontmatter + body + [[links]]
Memory/claude/<project>/  notes imported from Claude Code auto-memory
Sessions/<harness>/…      digests written automatically when a session goes quiet
Projects/<name>.md        one per working directory, linked from digests
Inbox/                    drop anything here
```

## Wire the harnesses to the vault

```
node scripts/install.mjs                 # pi: memory_search / memory_recall / memory_save tools + auto recall, MCP clients,
                                         #     plus the omnidroid skills (skills/ -> ~/.pi/agent/skills/)
node scripts/install.mjs --claude-hook   # Claude Code: SessionStart hook that injects the memory index
node scripts/install.mjs --claude-skills # Claude Code: also copy the skills to ~/.claude/skills/
node scripts/install.mjs --claude-mcp    # Claude Code: register omnidroid's MCP server (tools mcp__omnidroid__*)
node scripts/install.mjs --openrouter    # pi: OpenRouter provider from openrouter.txt (see "Models")
node scripts/install.mjs --uninstall
```

The skills teach either model the omnidroid engine (the sibling checkout in `Omni Apps/omnidroid`):

- `skills/omnidroid` — running any APK through the omnidroid app's MCP tools
  (`start_instance {apk, count, options}` on its pool of warm Androids, one pool shared by every
  omnidroid window) or the `omnidroid` CLI (`omnidroid <app.apk> [xN] [plugin options]`, `aosp`,
  `play`), a plugin's options on a launch (`--cookie <account> --place <id>`: each instance signed in,
  then the link opened), the WebView tools, and looking inside the running app;
  `reference/omni-cli.md` holds every flag, switch and the MCP server's env.
- `skills/omnidroid-frida` — the Frida-style lab debugger over the same MCP server: load an arm64
  `.so`, call its functions with crafted inputs, intercept / `replace_return`, breakpoints, patch
  code, trace syscalls, dump the module; with the rules measured against the real server.
- `skills/omnidroid-qemu`, `skills/omnidroid-input` — the retired QEMU/Python VM manager
  (`Omni Apps/omnidroid-old`), kept for when it is asked for by name.

The pi extensions are copied to `~/.pi/agent/extensions/` and read `~/.pi/agent/omni-agent.json`:

- `omni-plan.ts` + `omni-plan-lib.mjs` (a copy of `ui/plan.js`, the state machine the server and the goal box share): the `plan` tool.
- `omni-memory.ts` (`autoRecall`, `budgetTokens`): the memory tools. With auto recall on, every
  prompt of a pi started from a terminal gets a small `<omni-memory>` pack appended to the system
  prompt. Omni's own pi child (spawned with `OMNI_MEMORY=server`) skips that: there the composer's
  "Attach relevant memory" checkbox decides per prompt and the server attaches the pack itself.
- `omni-claude.ts` (`port`): a `claude_task` tool so the pi model (your local Qwen) can hand a
  task to Claude Code and wait for the answer. The run shows up in Omni as its own chat
  ("Task from pi: …"); the tool returns Claude's final text plus a session id that can be passed
  back as `resume` for a follow-up. Omni Agent must be running.
- `omni-mcp.ts` (`omniMcp`): pi has no MCP client, so this is one. It starts omnidroid's
  `omni-mcp` (`<omnidroid>/target/release/omni-mcp[.exe]`, filled in by the installer; build it with
  `cargo build --release -p omni-mcp`) and registers each of its tools as `omnidroid_<tool>` —
  `start_instance` / `screenshot` / `list_instances` / `web_*` for a live instance, `lab_load` /
  `call_function` / `intercept` / `dump_module` … for the lab debugger. The server is kept across
  chat switches and closed when pi quits (which stops the instances it booted); a call past
  `timeoutSec` (600) restarts it. `omniMcp.env` is passed to the server (`OMNI_MCP_APK`,
  `OMNI_MCP_REPO`, `OMNIDROID_DYNARMIC_BUILD_DIR`, …).
- `omni-mcp-servers.ts` (`mcpServers`): any other MCP server. The block has Claude Code's
  `.mcp.json` shape, so a server's README snippet can be pasted as-is; each tool becomes a pi tool
  named `mcp__<server>__<tool>`, the same names Claude Code uses:

  ```json
  { "mcpServers": {
      "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/src"] },
      "github": { "type": "http", "url": "https://api.githubcopilot.com/mcp/",
                  "headers": { "Authorization": "Bearer ${GITHUB_TOKEN}" } },
      "parked": { "command": "…", "disabled": true } } }
  ```

  Transports are stdio (`command`, `args`, `env`, `cwd`) and Streamable HTTP (`"type": "http"`,
  `url`, `headers`). The old SSE transport and OAuth sign-in are not supported; put a token in
  `headers`. `${VAR}` / `${VAR:-default}` are read from the environment. `timeoutSec` (300) caps
  one call. Servers start with the pi session, survive a chat switch and close when pi quits; one
  that fails to start shows a warning and is listed as unavailable in the system prompt, and the
  others still load. A server's `tools/list_changed` adds its new tools mid-session. Edit
  the file and restart pi, or use the **MCP servers** tab in the Providers dialog (⚙): add, edit,
  disable or remove a server, paste a README's JSON snippet to fill the form, and **Test connection**
  to see its tools before saving. Saving restarts pi back onto its chat. Env and header values are
  masked in the dialog (a `${VAR}` reference is shown as-is) and kept when saved back unchanged.
  `install.mjs` keeps this block, including on `--uninstall`.
- `omni-graph.ts` (`port`): `graph_build`, `graph_query` and `graph_explain` tools so the pi model
  decides mid-turn to build a repo knowledge graph or read it instead of grinding through files.
  They shell out to the local `graphify` (no model call), so they work even with the pi model
  endpoint down. Omni Agent must be running.

## Models

Providers live in pi's own `~/.pi/agent/models.json`; the **Providers** dialog (⚙) edits it. Each
provider is a base URL, an API type (`openai-completions`, `openai-responses`, `anthropic-messages`,
`google-generative-ai`), a key and the model ids you want to see. Saving restarts Omni's pi child so it
reads the file, then switches it back to the session it had open. Fields the dialog does not show
(`compat`, `headers`, per-model `cost` or image input) are kept as they are.
The dialog's second tab, **MCP servers**, edits the tool servers pi connects to (see `omni-mcp-servers.ts` above).

Picking a model in the composer calls pi's `set_model` and writes `piProvider` / `piModel` to
`omni.config.json`, so the next pi child starts on it. Without any provider in `models.json` the
picker falls back to pi's own catalogue filtered by `piModels`.

**Fallback.** The `omni-fallback.ts` pi extension (installed by `scripts/install.mjs`) reads
`models.json` in file order — providers as the dialog lists them, each provider's model lines in
sequence — and treats it as a chain. When a run ends because the model returned an error (any
error: 4xx, 5xx, connection, empty body), the extension switches pi to the model below the current
one and continues the same turn on it at once; for a transient error pi's own retry simply runs on
the switched model. The errored assistant messages and the extension's "model error on a/x →
switched to b/y" notice are filtered out of the LLM context, so the new model sees the conversation
exactly as the failed one did. The chain stops at the bottom of the list: the last error stays
visible and the user picks a model or reorders. Dragging in the dialog posts
`/api/providers-order` and rewrites the provider order without restarting pi. The switch is per
session: a new chat starts back on the picked model, and Omni's top bar follows the switch.

`node scripts/install.mjs --openrouter` still seeds OpenRouter + DeepSeek V4 Flash from
`openrouter.txt` for a first run. The server also hands `OPENROUTER_API_KEY` (from `openrouter.txt`,
configurable via `apiKeyFiles`) to the pi child, so a `$OPENROUTER_API_KEY` reference in
`models.json` resolves too. DeepSeek is not multimodal: the omnidroid skills carry a text-only
verification loop for it; the production Qwen reads screenshots.

### Headless runs

```
node scripts/headless.mjs --cwd workspace/deepseek-e2e --task-file workspace/deepseek-e2e/task.md --thinking low
node scripts/headless.mjs --cwd ~/proj --task "boot admn1b12farm9 with --no-window and report debug-info" --max-seconds 600
```

Drives the same pi child the window uses (tools, extensions, skills, memory with `--memory`) with no GUI:
one line per tool call and result, the assistant's text, then a summary (tools used, tokens, cost) and the
full event log as JSONL under `workspace/`. Exit 0 when the agent settles, 2 at `--max-seconds` (0 = no cap).

## Config

`omni.config.json` in this folder (all optional): `port`, `cwd`, `vaultDir`, `piModel`,
`piProvider`, `autoStartPi`, `digestIdleSec`, `tailRecentHours`, `memoryBudgetTokens`,
`claudeBin`, `piCli`, `piBin`, `piAgentDir` / `piModelsFile` (where the Providers dialog writes; default
`~/.pi/agent/models.json`), `piModels` (fallback allowlist when `models.json` has no providers), `apiKeyFiles` (`{ "ENV_NAME": "/path/key.txt" }` handed to pi as env; default
`OPENROUTER_API_KEY` ← `openrouter.txt`), `claudeTaskTimeoutSec`, `hook` (`{ "enabled", "provider",
"model", "maxIdleNudges": 5, "graceMs": 2000 }`; the model menu writes it).

## Layout

```
server/index.mjs      HTTP + SSE + routes           server/continue.mjs      resume-vs-fork decision
server/pi-rpc.mjs     pi --mode rpc child           server/claude-runner.mjs claude -p stream-json runs
server/watchers.mjs   discovery, tailing, digests   server/normalize.mjs     four sources -> one event
server/memory.mjs     the vault                     server/tokens.mjs        tally + prices
server/providers.mjs  presets + models.json edits    server/zip.mjs           .zip/.apk listing + entry read
ui/                   index.html, styles.css, app.js + lib/transcript/composer/explorer/settings/sidebar/panel
desktop/              pywebview launcher            integrations/            pi extension, Claude Code hook
```
