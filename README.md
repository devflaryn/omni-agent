# Omni Agent

A local agentic OS for one person: every **OpenCode** and **Claude Code** conversation
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
./start.sh                     # macOS/Linux: opens http://127.0.0.1:4400, OpenCode works in ~/Desktop
./start.sh /some/project       # OpenCode works in that folder (the Graph tab uses this folder)
./start.sh . --lan             # also reachable from other devices on your network
start.cmd "C:\some\project"    # the Windows equivalents
start.cmd . --lan
node server/index.mjs --no-pi  # observe only, don't start OpenCode (any OS)
```

Omni runs one shared `opencode serve` (OpenCode 1.18+; install it with `npm i -g opencode-ai`) and every
chat is a session on it. The `opencode` launcher is found on PATH; set `opencodeBin` in `omni.config.json`
to point at another one. Omni gives it its own config folder (`~/.omni-agent/opencode`, `opencodeConfigDir`),
which holds the `opencode.json` Omni writes (your MCP servers, custom providers), the plugin that adds
Omni's tools (plan, background agents, Claude Code, memory, graph, omnidroid) and the skills; your own
global OpenCode config still applies underneath.

**Models.** OpenCode's free models work without a key. Add your own providers and keys in the **Providers**
dialog (gear icon); MCP servers go in its **MCP servers** tab. Providers you had set up for pi
(`~/.pi/agent/models.json`) are copied over once at the first start.

The agent personas (`integrations/pi/agents/*.md`, or `personasDir`) are read from the repo, not from the
OpenCode config folder.

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
Omni chat on OpenCode going for days, re-engaging it toward the goal (the goal hook below) and reattaching
it when `opencode serve` crashes and is restarted (the chat resumes the same OpenCode session).
State lives in `vault/Runs/<run-id>/` (`run.json`, `ledger.md`, `events.jsonl`, `artifacts/`).
Resume after a reboot with `--resume <run-id>`. The desktop/browser GUI is a read-only
observer — open `http://127.0.0.1:4400` to watch; closing it never stops the run.

Omni's watchdog aborts the run of a chat that claims to be streaming but has produced no event for
`stallMs` (900000, 15 min; `toolStallMs`, 4 h, while a tool call is open). Make sure each model's context
window is right (OpenCode's catalog has it; for a custom provider, the Providers dialog), or compaction comes
too late or too often.

### Long runs: compaction, auto-continue, goals that survive a restart

What used to end long runs early (measured over every pi chat on this machine, before the switch to OpenCode):
with a model declared at 1M tokens compaction only came past ~975k, but the model itself started ending its turns
at 375k–900k claiming its "context is nearly exhausted" and writing handoffs for a fresh session. Nothing compacted,
nothing continued.

- **Compaction point** (`context.compactAt`, default 256000; Settings → Long runs). Once a chat's last turn used more
  context than this, Omni has OpenCode summarize the chat before its next prompt (`OpencodeRpc` `compactAt`; the
  same for background agents). A change applies to the running chats from their next prompt on, nothing restarts.
  Floor 100k (a compacted chat still holds the system prompt, the kept recent turns and the summary, ~60k); `0`
  leaves compaction to OpenCode alone (it compacts when the model's window is full).
- **Context is managed for the model**: the Omni plugin adds a static system-prompt block ("context size is never a
  reason to stop or hand off").
- **Auto-continue** (`context.autoContinue`, default on, even with the goal hook off): a turn that ends because the
  model *believes* its context or session is used up (`integrations/pi/omni-context-lib.mjs` `classifyStop`, also
  reading the model's reasoning) is compacted and re-engaged, up to `maxContextNudges` (3) in a row without
  progress. So are output-limit stops that cannot recover by themselves (all output spent on reasoning) and transient
  provider errors after the provider's own retries (409, connection resets, timeouts, 5xx — with a growing back-off).
  A handoff the user asked for, a real question to the user, and a finished answer are left alone.
- **Stop** halts the run and pauses that goal; it no longer switches the goal hook off for every later run.
- **Explicit goals** (`/goal`) are saved to `~/.omni-agent/goals.json` with their chat; after an Omni restart the
  newest unfinished one (active in the last 72 h, not stopped) is reopened and continued.
- The watchdog does not abort a chat whose tool call runs long and silent (`toolStallMs`, default 4 h).
- `node scripts/replay-stops.mjs [--hook on|off]` replays every recorded chat through the real normalizer and
  goal keeper (a fake chat, nothing executed) and counts what Omni now does at each point the original run stopped.

### Background agents, Claude Code agents and background jobs

An Omni chat can delegate while it keeps working (the Omni plugin's tools, run by the server's
`AgentManager` in `server/agents.mjs`):

| tool | what it does |
|---|---|
| `agent_start {task, kind: "pi"\|"claude", agent?, title?, cwd?, model?}` | starts a background OpenCode agent (`kind: "pi"`, the internal name; optionally a persona from `integrations/pi/agents/*.md`, `personasDir`) or a Claude Code session, and returns at once |
| `agent_status`, `agent_wait`, `agent_message`, `agent_cancel` | watch, wait for, steer or stop them |
| `job_start {command}`, `job_wait {id, until}`, `job_output`, `job_kill` | a shell command in the background (builds, device boots, waiting for a log line) instead of `sleep` loops |

When an agent or job finishes, its report arrives in the parent chat by itself as an `[omni-agent-result]` message
(it wakes an idle chat). An OpenCode agent is a chat of its own on the same shared `opencode serve`, with its
persona's system prompt and tool allowlist sent with each prompt and a *managed* goal: the goal keeper continues it
after context stops, errors and length stops, exactly like the main chat. A Claude agent runs
`claude -p --input-format stream-json --output-format stream-json` unattended (`--permission-prompts none`), can be
steered mid-run (`agent_message`) and resumed after it finished. Every agent shows up live in the UI as a child chat
nested under its parent, with a strip above the composer (status, Open, Stop). Limits in `omni.config.json`
`agents`: `maxConcurrent` (6, more queue), `maxDepth` (2), `maxMinutes` (360), `claudeModel`, `claudeMaxTurns`.
The registry lives in `~/.omni-agent/agents.json`; agents that were running when Omni stopped come back as
`interrupted` (their finished, undelivered reports are still delivered). `claude_task` is built on the same
path: it waits up to `timeoutMinutes` and leaves Claude running in the background after that. For quick parallel
lookups OpenCode's own `task` tool (its subagents) is there too.

## What you get

- **Home**: one container. "What should we work on?", the composer, the working directory (recent
  folders as chips). Sending opens a chat on OpenCode in that folder.
- **Chat**: a **file explorer** on the left rooted at the chat's folder, the transcript in the middle.
  Click a file and a preview column opens beside the tree: text files as text, `.md` rendered (with a
  Raw toggle), images as images, and `.zip` / `.apk` / `.jar` as the list of entries inside, where a
  text or image entry opens in place. **Reference** drops `@path` into the prompt. The folder button
  in the top bar hides or shows the explorer.
- **Transcript**: Omni's chats stream token by token; chats run in a terminal appear whole. Each run of tool
  calls folds into one line such as "Edited files, ran commands"; open it for a row per tool and a
  row for its arguments and output. Images the model reads (a `read` of a PNG) appear as small boxes
  under that line; click one for a large preview overlay. The status line
  `Thinking… 11m 20s · 15k tokens · 86 tok/sec` sits below the turn; the rate covers only the last
  five seconds of streamed output and disappears while the model waits on a tool. Click the line for
  the model's reasoning.
- **Planner** (the `plan` tool, from the Omni plugin): for any task bigger than a few tool calls the agent
  works the way the superpowers brainstorm → write-plan → execute flow does. **brainstorm** first:
  the goal in its own words and its scope, assumptions to check, at least two approaches with their
  trade-offs, the chosen one and why, and success criteria. The tool refuses a plan without this.
  Then **create**: milestones of small steps, each with a `done_when` check. Then execute one step at a
  time, marking it **done** only with evidence. **revise** (with a reason) keeps the finished steps and
  replaces the rest. **ask_user** parks the plan until you answer. While a plan is open, a short
  reminder of it (current milestone, current step, its check) is added to the newest message of each
  model call, so it survives compactions and does not break the prompt cache.
- **Goal hook** (model menu in the composer → *Goal hook*): the same idea as Claude Code's Stop hook,
  driven by the plan instead of a judge model. It acts only when the chat has really stopped (nothing
  running or queued). Every plan change reaches the server on the chat's event stream, so the hook knows without
  asking any model: unfinished steps → the agent is re-engaged at once on the current step and its check;
  every step done → the goal is closed for good; waiting on `ask_user` → it stays quiet until you
  reply. A `/goal` must be planned: until there is a plan, the agent is re-engaged to brainstorm and plan it.
  Work without a plan just ends when the agent stops; if it used tools, it is first asked once to confirm it
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
  summarizer in a side conversation of its own: one OpenCode session per goal (run in
  `~/.omni-agent/status-sessions/`), never the agent's chat. It writes only when the plan moves (plan
  written or revised, a milestone reached, the plan finished), never on timers or tool counts. It uses
  the chat's model unless *Status box model* (or `summaryProvider`/`summaryModel`) says otherwise.
  Re-engages restate the goal verbatim only every `restateEvery` (10) times and after a compaction.
  All of these are `hook` keys in `omni.config.json`.
- **History drawer** (☰ in the top bar): every Omni (OpenCode), older pi and Claude Code chat on this machine, grouped by
  day, with a pulsing dot for a chat working right now. Hover for ✕ to delete (moves to
  `~/.omni-agent/trash/`). Claude Code chats open read-only; Omni's chats continue on OpenCode (an old pi chat
  continues in a new OpenCode session that gets its history), or fork when the chat is still open in a terminal
  (the composer caption says which). The drawer's other
  tabs are Memory (search, edit, import, digest), Graph (build and query a repo graph) and Tokens.
- **Providers** (⚙ in the top bar): pick a preset (OpenRouter, OpenAI, Anthropic, Google, DeepSeek,
  Groq, xAI, Mistral, Together, Fireworks, Ollama, LM Studio, or any OpenAI/Anthropic-compatible
  URL), paste the key, type the model ids one per line. The model picker lists only those models.
  Drag the six-dot grip under a provider (or focus it and use the arrow keys) to set the order they are
  listed in. There is no automatic fallback: when a model returns an error, pick another one.
- **Composer**: "Do anything", + for a file reference, memory and repo-graph attachments, and the
  model / thinking picker. The attachment choices are remembered across reloads and shared by Home
  and Chat; a model or thinking level picked is saved in `omni.config.json` and the next chat starts
  with it. Omni's own chats only: Claude Code is never launched from the UI.
- **Graph tools for the model**: the Omni plugin adds `graph_build`, `graph_query` and `graph_explain`.
  The system prompt says whether the chat's folder already has a graph, so the model builds one on its
  own when a task spans several files and asks the graph instead of reading the whole tree.

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
node scripts/install.mjs                 # OpenCode: checks `opencode` is installed, copies the skills (skills/ -> <opencodeConfigDir>/skills/),
                                         #     writes ~/.pi/agent/omni-agent.json (the omnidroid bridge; your mcpServers are kept)
node scripts/install.mjs --claude-hook   # Claude Code: SessionStart hook that injects the memory index
node scripts/install.mjs --claude-skills # Claude Code: also copy the skills to ~/.claude/skills/
node scripts/install.mjs --claude-mcp    # Claude Code: register omnidroid's MCP server (tools mcp__omnidroid__*)
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

OpenCode loads Omni's tools through one plugin (`integrations/opencode/omni-plugin.mjs`). The server writes the
plugin shim and `opencode.json` into the OpenCode config folder itself, on every config change, so the installer
does not. What the plugin brings: the `plan` tool, background agents and jobs (`agent_start` …), `claude_task`,
the memory tools (`memory_search` / `memory_recall` / `memory_save`, plus the per-prompt memory pack the composer
attaches), `graph_build` / `graph_query` / `graph_explain` (they shell out to the local `graphify`; Omni must be
running) and the omnidroid tools. MCP servers and omnidroid's `omni-mcp` come from `~/.pi/agent/omni-agent.json`
(`omniMcp` and `mcpServers`), which the server renders into `opencode.json`:

- `mcpServers`: any MCP server. The block has Claude Code's
  `.mcp.json` shape, so a server's README snippet can be pasted as-is; each tool becomes an OpenCode tool
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
  one call. Edit
  the file and restart Omni's OpenCode, or use the **MCP servers** tab in the Providers dialog (⚙): add, edit,
  disable or remove a server, paste a README's JSON snippet to fill the form, and **Test connection**
  to see its tools before saving. Saving reloads OpenCode. Env and header values are
  masked in the dialog (a `${VAR}` reference is shown as-is) and kept when saved back unchanged.
  `install.mjs` keeps this block, including on `--uninstall`.

## Models

OpenCode's own models (the free ones need no key) and the providers you connect appear in the model picker.
The **Providers** dialog (gear icon) connects a provider with its API key, and adds custom OpenAI-compatible
or Anthropic/Google-style providers (a base URL, an API type, a key and the model ids you want to see); those
custom providers are stored in `~/.omni-agent/opencode-providers.json` and rendered into `opencode.json`
(`~/.omni-agent/opencode/`); saving reloads OpenCode. The dialog's second tab, **MCP servers**, edits the
tool servers OpenCode connects to (see `mcpServers` above).

Picking a model in the composer sets the chat's model and writes `piProvider` / `piModel` to
`omni.config.json` (the names are historical), so the next chat starts on it.

**Fallback.** There is no model fallback chain (pi's `omni-fallback` extension is gone); when a model
returns an error, pick another model in the picker.

OpenRouter is one more provider: add it (and its key) in the Providers dialog. `install.mjs --openrouter` is gone.
DeepSeek is not multimodal: the omnidroid skills carry a text-only verification loop for it; the production
Qwen reads screenshots.

### Headless runs

```
node scripts/headless.mjs --cwd workspace/deepseek-e2e --task-file workspace/deepseek-e2e/task.md --thinking low
node scripts/headless.mjs --cwd ~/proj --task "boot admn1b12farm9 with --no-window and report debug-info" --max-seconds 600
```

Drives an Omni chat on OpenCode the way the window does (tools, the Omni plugin, skills, memory with `--memory`)
with no GUI:
one line per tool call and result, the assistant's text, then a summary (tools used, tokens, cost) and the
full event log as JSONL under `workspace/`. Exit 0 when the agent settles, 2 at `--max-seconds` (0 = no cap).

## Config

`omni.config.json` in this folder (all optional): `port`, `cwd`, `vaultDir`, `piModel`,
`piProvider`, `autoStartPi`, `digestIdleSec`, `tailRecentHours`, `memoryBudgetTokens`,
`claudeBin`, `opencodeBin`, `opencodeConfigDir`, `opencodeProvidersFile` (the Providers dialog's custom providers),
`piAgentDir` / `piModelsFile` (pi's old `models.json`, copied into OpenCode once), `piModels` (model picker allowlist,
`provider/id` patterns), `stallMs` / `toolStallMs` (the watchdog), `context` (Settings → Long runs), `apiKeyFiles`
(`{ "ENV_NAME": "/path/key.txt" }` handed to Omni's `opencode serve` as env; default
`OPENROUTER_API_KEY` ← `openrouter.txt`), `claudeTaskTimeoutSec`, `hook` (`{ "enabled", "provider",
"model", "maxIdleNudges": 5, "graceMs": 2000 }`; the model menu writes it).

## Layout

```
server/index.mjs      HTTP + SSE + routes           server/continue.mjs      resume-vs-fork decision
server/opencode-*.mjs opencode serve, chats, config server/claude-runner.mjs claude -p stream-json runs
server/watchers.mjs   discovery, tailing, digests   server/normalize.mjs     four sources -> one event
server/memory.mjs     the vault                     server/tokens.mjs        tally + prices
server/providers.mjs  presets + custom providers     server/zip.mjs           .zip/.apk listing + entry read
ui/                   index.html, styles.css, app.js + lib/transcript/composer/explorer/settings/sidebar/panel
desktop/              pywebview launcher            integrations/            OpenCode plugin, Claude Code hook, personas
```
