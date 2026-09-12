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

### Use it from other devices on the network

1. Run once if the firewall blocks it: `scripts/allow-lan.sh` on macOS (allows the node binary in the
   application firewall, asks for your password) or `scripts\allow-lan.cmd` on Windows (adds a Windows
   Firewall rule for TCP 4400; it asks for the admin prompt itself).
2. Start with `--lan` (or put `"lan": true` in `omni.config.json`). The window prints a link like
   `http://192.168.0.15:4400/?token=…`. Open it once on the other device; the token is then remembered in a cookie.
3. Local use never needs the token. Anyone on the network without it only sees a token page.
   The token lives in `omni.config.json`; delete it to rotate.

### Repo graphs (Graph tab)

**Build repo graph** runs your installed `graphify` on the selected session's working directory
(AST extraction plus clustering, no LLM, a few seconds) and writes an Obsidian-friendly slice into
`vault/Graphs/<repo>/`: one note per source file with wikilinks to the files it calls or imports, plus
an `_index` note listing every community. Open the vault in Obsidian and its graph view shows the repo.
The tab itself draws the best-connected nodes (filter, pan, zoom, click a node for its links) and
**Ask the graph** runs `graphify query` for a token-budgeted answer. Tick **Attach repo graph context**
in the composer to prepend that answer to a prompt, so the model reads the graph instead of the codebase.

Tests: `npm test`.

## What you get

- **Sidebar**: every pi and Claude Code chat on this machine, grouped by day. A pulsing dot means it
  is working right now; "in Omni" marks chats this app controls.
- **Chat**: one renderer for four sources (pi and Claude Code run from Omni stream token by token;
  chats run in a terminal appear whole). Each run of tool calls folds into one line such as
  "Used the browser, edited files, ran commands"; open it for a row per tool ("Ran git status",
  "Edited cli.py +3 −1", a subagent's task), and open a row for its arguments and output. The status
  line `Thinking… 11m 20s · 15k tokens · 86 tok/sec` always sits below the turn; click it to open the
  model's reasoning in a small scrollable drawer. That open/closed choice carries over to later
  turns, and the line is not clickable when the provider returned no reasoning.
- **Continue any chat**: type into a chat that is closed and it resumes in place
  (`claude -p --resume`, or Omni's pi switches to that session file). Type into a chat that is still
  open in a terminal and Omni forks it (`--fork-session` / pi `clone`) so the terminal copy is
  never touched. The composer caption says which will happen. "Fork into a new chat" in the ··· menu
  forces a fork.
- **Composer**: "Do anything", + for file references, memory and repo-graph attachments, an access
  pill (Full access / Ask) for Claude Code, and a model / thinking picker.
- **Right panel**: Tokens (usage, cost, context bar), Memory (search, edit, import, digest), Graph
  (build and query a repo graph), Files (browse the chat's folder).

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
node scripts/install.mjs               # pi: memory_search / memory_recall / memory_save tools + auto recall
node scripts/install.mjs --claude-hook # Claude Code: SessionStart hook that injects the memory index
node scripts/install.mjs --uninstall
```

Two pi extensions are copied to `~/.pi/agent/extensions/` and read `~/.pi/agent/omni-agent.json`:

- `omni-memory.ts` (`autoRecall`, `budgetTokens`): the memory tools. With auto recall on, every
  pi prompt gets a small `<omni-memory>` pack appended to the system prompt.
- `omni-claude.ts` (`port`): a `claude_task` tool so the pi model (your local Qwen) can hand a
  task to Claude Code and wait for the answer. The run shows up in Omni as its own chat
  ("Task from pi: …"); the tool returns Claude's final text plus a session id that can be passed
  back as `resume` for a follow-up. Omni Agent must be running.

## Config

`omni.config.json` in this folder (all optional): `port`, `cwd`, `vaultDir`, `piModel`,
`piProvider`, `autoStartPi`, `digestIdleSec`, `tailRecentHours`, `memoryBudgetTokens`,
`claudeBin`, `piCli`, `piModels` (model-picker allowlist, e.g. `["orca/*"]` to show only the local Qwen and
hide OpenRouter's catalogue), `claudeTaskTimeoutSec`.

## Layout

```
server/index.mjs      HTTP + SSE + routes           server/continue.mjs      resume-vs-fork decision
server/pi-rpc.mjs     pi --mode rpc child           server/claude-runner.mjs claude -p stream-json runs
server/watchers.mjs   discovery, tailing, digests   server/normalize.mjs     four sources -> one event
server/memory.mjs     the vault                     server/tokens.mjs        tally + prices
ui/                   index.html, styles.css, app.js + lib/transcript/composer/sidebar/panel modules
desktop/              pywebview launcher            integrations/            pi extension, Claude Code hook
```
