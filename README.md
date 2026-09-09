# Omni Agent

A local agentic OS for one person: every **pi harness** and **Claude Code** conversation
on this machine shows up live in one window, tokens animate in while a model streams,
whole messages just appear when it is not, and a personal **Obsidian vault** is the
memory both harnesses share. Node built-ins only. No npm install.

It continues and replaces `Desktop/pi/pi-gui`.

## Run

Double-click **Omni Agent** on the Desktop (a shortcut to `start.cmd`), or:

```
start.cmd                      # opens http://127.0.0.1:4400, pi works in Desktop
start.cmd "C:\some\project"    # pi works in that folder (the Graph tab uses this folder)
start.cmd . --lan              # also reachable from phones/laptops on your network
node server/index.mjs --no-pi  # observe only, don't start a pi child
```

### Use it from other devices on the network

1. Run once: `scripts\allow-lan.cmd` (adds a Windows Firewall rule for TCP 4400; it asks for the admin prompt itself).
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

- **Sessions rail**: pi and Claude Code sessions grouped by harness. A pulsing dot means it
  is working right now. "in Omni" marks sessions this app controls.
- **Transcript**: one renderer for four sources:
  - pi run from Omni (`pi --mode rpc`): token deltas, animated.
  - Claude Code run from Omni (`claude -p --output-format stream-json --include-partial-messages`): token deltas, animated.
  - pi run in a terminal: its session file is tailed, whole messages appear.
  - Claude Code run in a terminal: its project file is tailed, whole content blocks appear.
- **Composer**: sends to Omni's pi (steers it while it works), or resumes a Claude Code session.
  "Attach relevant memory" prefixes a small, token-budgeted pack of vault notes instead of
  whole files.
- **Memory tab**: search, edit, save notes; import Claude Code's auto-memory; rebuild the index;
  write a digest for the selected session now.
- **Tokens tab**: input, output, cache read/write, cost (Claude price table, pi provider cost),
  and a context bar that warns when a session should be compacted.
- **Files tab**: browse the selected session's working directory and reference a file in a prompt.

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

The pi extension is copied to `~/.pi/agent/extensions/omni-memory.ts` and reads
`~/.pi/agent/omni-agent.json` (`autoRecall`, `budgetTokens`). With auto recall on, every
pi prompt gets a small `<omni-memory>` pack appended to the system prompt.

## Config

`omni.config.json` in this folder (all optional): `port`, `cwd`, `vaultDir`, `piModel`,
`piProvider`, `autoStartPi`, `digestIdleSec`, `tailRecentHours`, `memoryBudgetTokens`,
`claudeBin`, `piCli`.

## Layout

```
server/index.mjs      HTTP + SSE + routes           server/pi-rpc.mjs        pi --mode rpc child
server/watchers.mjs   discovery, tailing, digests   server/claude-runner.mjs claude -p stream-json runs
server/normalize.mjs  four sources -> one event     server/memory.mjs        the vault
server/tokens.mjs     tally + prices                server/tailer.mjs / jsonl.mjs / bus.mjs / config.mjs
ui/                   index.html, app.js, styles.css (no build step)
integrations/         pi extension, Claude Code hook
```
