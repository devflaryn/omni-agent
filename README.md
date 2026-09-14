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

1. Start with `--lan` (or `"lan": true` in `omni.config.json`); the desktop launcher already does.
2. The window prints the LAN address, e.g. `http://192.168.0.15:4400/`. Open it on any device on the
   network. There is no login: anyone with the link can use Omni exactly like the local user, including
   browsing folders and driving pi, so keep it on a network you trust. If the firewall blocks it run
   `scripts/allow-lan.sh` (or `scripts\allow-lan.cmd`) once.

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

- **Home**: one container. "What should we work on?", the composer, the working directory (recent
  folders as chips). Sending starts Omni's pi in that folder and opens the chat.
- **Chat**: a **file explorer** on the left rooted at the chat's folder, the transcript in the middle.
  Click a file and a preview column opens beside the tree: text files as text, `.md` rendered (with a
  Raw toggle), images as images, and `.zip` / `.apk` / `.jar` as the list of entries inside, where a
  text or image entry opens in place. **Reference** drops `@path` into the prompt. The folder button
  in the top bar hides or shows the explorer.
- **Transcript**: pi streams token by token; chats run in a terminal appear whole. Each run of tool
  calls folds into one line such as "Edited files, ran commands"; open it for a row per tool and a
  row for its arguments and output. The status line `Thinking… 11m 20s · 15k tokens · 86 tok/sec`
  sits below the turn; click it for the model's reasoning.
- **History drawer** (☰ in the top bar): every pi and Claude Code chat on this machine, grouped by
  day, with a pulsing dot for a chat working right now. Hover for ✕ to delete (moves to
  `~/.omni-agent/trash/`). Claude Code chats open read-only; pi chats continue in Omni's pi, or fork
  when the chat is still open in a terminal (the composer caption says which). The drawer's other
  tabs are Memory (search, edit, import, digest), Graph (build and query a repo graph) and Tokens.
- **Providers** (⚙ in the top bar): pick a preset (OpenRouter, OpenAI, Anthropic, Google, DeepSeek,
  Groq, xAI, Mistral, Together, Fireworks, Ollama, LM Studio, or any OpenAI/Anthropic-compatible
  URL), paste the key, type the model ids one per line. The model picker lists only those models.
- **Composer**: "Do anything", + for a file reference, memory and repo-graph attachments, and the
  model / thinking picker. pi only: Claude Code is never launched from the UI.

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
node scripts/install.mjs                 # pi: memory_search / memory_recall / memory_save tools + auto recall,
                                         #     plus the omnidroid skills (skills/ -> ~/.pi/agent/skills/)
node scripts/install.mjs --claude-hook   # Claude Code: SessionStart hook that injects the memory index
node scripts/install.mjs --claude-skills # Claude Code: also copy the skills to ~/.claude/skills/
node scripts/install.mjs --openrouter    # pi: OpenRouter provider from openrouter.txt (see "Models")
node scripts/install.mjs --uninstall
```

`skills/omnidroid` and `skills/omnidroid-input` teach either model how to drive the omnidroid Android
VM engine (the sibling checkout in `Omni Apps/omnidroid`): launching accounts, the `--apk` cache,
`frida --restart`, `debug-info`, tapping and typing, and how to verify every step from text signals
when the model cannot see screenshots. `skills/omnidroid/reference/omni-cli.md` is the CLI reference.

Two pi extensions are copied to `~/.pi/agent/extensions/` and read `~/.pi/agent/omni-agent.json`:

- `omni-memory.ts` (`autoRecall`, `budgetTokens`): the memory tools. With auto recall on, every
  pi prompt gets a small `<omni-memory>` pack appended to the system prompt.
- `omni-claude.ts` (`port`): a `claude_task` tool so the pi model (your local Qwen) can hand a
  task to Claude Code and wait for the answer. The run shows up in Omni as its own chat
  ("Task from pi: …"); the tool returns Claude's final text plus a session id that can be passed
  back as `resume` for a follow-up. Omni Agent must be running.
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

Picking a model in the composer calls pi's `set_model` and writes `piProvider` / `piModel` to
`omni.config.json`, so the next pi child starts on it. Without any provider in `models.json` the
picker falls back to pi's own catalogue filtered by `piModels`.

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
`OPENROUTER_API_KEY` ← `openrouter.txt`), `claudeTaskTimeoutSec`.

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
