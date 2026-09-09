# Omni Agent: continue any chat, Codex-style UI, live thinking meter, desktop window (2026-09-09)

Builds on `2026-09-09-omni-agent-design.md`. Four changes, one release.

## Goals
1. Every chat in the sidebar can be continued from Omni, whether it is running in a terminal right now or was closed days ago.
2. The UI looks and behaves like the Codex/ChatGPT desktop app: dark, three columns, collapsed "Worked for …" tool groups, an "Edited N files" card, a right panel with tabs, a rounded "Do anything" composer.
3. While a model streams, the turn shows `Thinking… 11m 20s · 15k tokens · 86 tok/sec`, live.
4. Double-clicking the desktop shortcut opens a native window (pywebview) with no console. The same server stays reachable from other devices on the LAN in a browser.

## Non-goals
Typing into a terminal process from Omni (impossible), Electron, a build step, npm dependencies, multi-user auth beyond the existing token.

---

## 1. Continue and resume any chat

### Decision table
The server decides how to attach, in `server/continue.mjs` (pure function `planContinue(session, ctx)` plus an `executeContinue` that runs it):

| Harness | Terminal still active | Closed / archived |
|---|---|---|
| Claude Code | `claude -p --resume <id> --fork-session` in the session's cwd. New session id. | `claude -p --resume <id>` in place. |
| pi | Omni's pi: `switch_session(file)` → `clone` → `prompt`. Continues in a new file. | `switch_session(file)` → `prompt`. Continues in place. |
| Omni-owned, alive | Existing behavior: pi prompt steers; Claude run cannot be prompted while alive (send = stop). | n/a |

"Terminal still active" = not owned by Omni **and** (`session.streaming` **or** the session file's mtime is within the last 30 s). The threshold is `cfg.liveWindowMs` (default 30000).

### Endpoint
`POST /api/sessions/:sid/continue` with body `{ message, memory, graph, model, autonomous, images }`.

- Resolves the session from the registry; 404 if unknown, 400 on an empty message.
- Applies the memory pack and repo-graph context the same way `/api/pi/prompt` and `/api/claude/run` do today (that code moves into a shared helper `composePrompt`).
- Claude: calls `claude.run({ prompt, cwd: session.cwd, resume: id, fork, model, autonomous })`. `ClaudeRunner.run` gains a `fork` option that appends `--fork-session`. Because the new id is only known when the `system.init` line arrives, the run is keyed by a temporary sid `claude:pending-<uuid>` and re-keyed on init; the runner emits `session` with `forkedFrom: <old sid>` and the UI follows it (see "Fork follow" below).
- pi: if Omni's pi is not running, start it in the session's cwd first. If Omni's pi is mid-turn, respond 409 `pi is busy; stop it or wait`. Then `switch_session`, optionally `clone`, then `prompt`. The response includes the resulting `sid`.
- Response: `{ sid, forked: boolean, forkedFrom?: sid }`.

`/api/pi/prompt` and `/api/claude/run` stay for the Home composer and owned sessions.

### Fork follow
When a continue returns a different sid, the UI selects the new session, keeps the old transcript visible above a divider "Forked from <title> · open original", and the new session's header shows "forked from …" with a link back. The registry stores `forkedFrom` on the new session so it survives reload.

### Composer state
`composerTarget()` returns one of: `owned-pi`, `owned-claude-running`, `continue` (any observed or ended session), `none`. The composer is never read-only; when pi is starting it shows "pi is starting…" and disables send until the state event arrives.

### Tests (`test/continue.test.mjs`)
- `planContinue` for the six cells of the table (owned alive, live terminal, closed) × (pi, claude).
- `ClaudeRunner.run` builds `--resume X --fork-session` when `fork` is set and `--resume X` otherwise (spawn stubbed).
- HTTP: continuing an unknown sid → 404; empty message → 400; continuing the fixture's closed Claude session with a stubbed runner returns `{ forked: false }`.

---

## 2. UI revamp

### Files
`ui/` becomes ES modules, still no build step. The static route in `server/index.mjs` serves any `ui/*.js|*.css|*.svg|*.png|*.ico`.

```
ui/index.html      shell: sidebar, main column, right panel, overlays
ui/styles.css      design tokens + layout + components
ui/app.js          boot, state, SSE handler, routing between views (type="module")
ui/lib.js          pure helpers: md(), fmtN, fmtDuration, tokRate, groupToolRuns, editedFiles, groupLabel
ui/sidebar.js      session list, search, new chat, collapse
ui/transcript.js   renders omni events into the chat column (moved and extended from app.js)
ui/composer.js     the composer card, access pill, model/thinking picker, + menu
ui/panel.js        right panel tab strip: Tokens, Memory, Graph, Files (the current views, moved)
```

`lib.js` has no DOM access so `test/ui.test.mjs` can import it under `node --test`.

### Layout
Three columns on a `#0d0d0d` ground, matching the screenshot:

- **Sidebar** (260 px, collapsible to 0 with a top-left icon; on phones it overlays). Brand row, **New chat** button, search field, then sessions grouped by Today / Yesterday / This week / month. Each row: harness dot (pi amber, Claude violet), title, pulse when live, "in Omni" tag when owned. Footer: pi status, LAN link.
- **Main column**. Header row (46 px): sidebar toggle, chat title, "…" menu (Fork from here, Open folder, Digest to vault, Copy session id), model pill, right-panel toggle. Below it either the Home view or the Chat view.
- **Right panel** (380 px, hidden by default on screens under 1100 px, toggled by the header icon). Tab strip with **Tokens, Memory, Graph, Files** and a close ×. Each tab hosts the existing feature's markup, restyled. The active tab and open/closed state persist in `localStorage`.

### Chat column
Max width 760 px, centered.

- **User message**: right-aligned card, `#1f1f1f`, 16 px radius, max 85 % width.
- **Assistant turn**: plain text on the ground, no border. Under each finished turn: small icon row (copy, fork from here, open in panel Tokens). Consecutive assistant/tool events between two user messages form one *turn*.
- **Work group**: consecutive `tool_call` / `tool_result` / `tool` events collapse into a row `Worked for 8m 4s ›` (duration from first tool start to last tool end, or "Working… 12s" while live). Expanding shows the tool cards as now (name, brief, status, args, output). Text blocks between tools stay inline and break the group.
- **Edited files card**: computed per turn by `editedFiles(events)` from tool calls named `Edit`, `Write`, `MultiEdit`, `NotebookEdit` (Claude Code) and `edit`, `write` (pi). Shows "Edited N files" with `+added −removed` totals (line counts from `old_string`/`new_string` or from `content` for writes), a list of the first three files with per-file counts, and "Show N more files ▾". Absent when no edits.
- **Run result**: the Claude `run` event renders as a muted footer line "Finished · 3 turns · $0.12" or an error card.
- **Compaction**: centered divider as now.
- Scrolling stays pinned to the bottom only when the user is already within 200 px of it.

### Composer
Rounded card (`#1a1a1a`, 20 px radius, 1 px `#2a2a2a` border), placeholder **Do anything**, auto-growing textarea. Bottom row:

- **+** button → menu: Reference a file (opens Files tab), Attach relevant memory (toggle), Attach repo graph (toggle). Toggles show as small pills next to + when on.
- **Access pill**: `Full access` (orange dot, `--dangerously-skip-permissions`) or `Ask` for Claude Code runs. Hidden for pi.
- **Model pill**: `Custom · Medium` style. Claude: model from the fixed list. pi: provider/model list from `/api/pi/models` and thinking level from `/api/pi/thinking-levels`; changing them calls `/api/pi/model` and `/api/pi/thinking`.
- Round **send** button (white). While the target is streaming it becomes a **stop** square.
- Enter sends, Shift+Enter newline. The header target line ("Claude Code · resume this session" today) becomes a small caption inside the card: "Continues this Claude Code session", "Forks the running terminal session", "Steers Omni's pi".

### Home
Same hero and composer, restyled with the new card, plus the recent-directory chips and the four cards. Cards open the corresponding right-panel tab or the chat.

### Tests (`test/ui.test.mjs`)
- `groupToolRuns(events)` splits a turn into text and work groups, computes durations, handles a still-open group.
- `editedFiles(events)` aggregates by path, counts lines, ignores non-edit tools, dedupes repeated edits to one file.
- `fmtDuration(ms)` → `12s`, `8m 4s`, `1h 02m`.
- `tokRate(tokens, ms)` → rounded tok/sec, 0 when ms is 0.
- `md()` regression cases carried over.

---

## 3. Live thinking meter

Per assistant turn, a status row above the content:

- **Live**: `Thinking… 11m 20s · 15k tokens · 86 tok/sec`. Starts at the first `block message_start` (or the first `delta` if none), updated every 250 ms by a single `setInterval` owned by `transcript.js` and cleared when the transcript view changes.
- **Tokens**: the running output-token count. Source priority: the latest `usage` event's `output` for this turn; before any usage arrives, `estimateTokens(streamedText + streamedThinking + streamedToolArgs)` (chars / 4). The row's `title` says "estimated" or "reported by provider".
- **tok/sec**: tokens ÷ elapsed seconds, shown after 2 s of elapsed time to avoid a wild first number.
- **Done**: on `status streaming:false`, `msg` for pi, or `run` for Claude, becomes `Thought for 11m 20s · 15k tokens` (or `Worked for …` when the turn contained tools and no thinking). Click toggles the reasoning text (all `thinking` blocks of the turn, italic, as now).
- **Observed terminal sessions** (whole messages, no deltas) show `Replied in 41s · 2.1k tokens` from consecutive message timestamps and reported usage, so the row exists for every source.
- Reduced-motion users get the same text without the pulsing dot.

---

## 4. Desktop window with pywebview

### Files
```
desktop/omni_desktop.pyw   Python launcher (pythonw, no console)
Omni Agent.cmd             one line: start "" pythonw "%~dp0desktop\omni_desktop.pyw" %*
start.cmd                  unchanged console mode
omni.log                   server stdout/stderr when started by the launcher (gitignored)
```

### Launcher behavior
1. Resolve `node` on PATH (or `OMNI_NODE`). If missing, show a native message box and exit.
2. If `http://127.0.0.1:<port>/api/state` already answers, reuse that server (a second click just opens a window).
3. Otherwise spawn `node server/index.mjs --cwd <arg or Desktop> --lan` with `CREATE_NO_WINDOW`, stdout/stderr appended to `omni.log`. Poll `/api/state` up to 20 s.
4. `webview.create_window("Omni Agent", url, width=1280, height=820, min_size=(720, 520))`, `webview.start()`. Window title updates from `document.title` so the current chat name shows in the title bar.
5. On window close: if this launcher started node, terminate it (`taskkill /T` on Windows) so no orphan keeps the port. If it reused a server, leave it running.
6. Fallbacks, each shown once via a message box: no `webview` module → `msedge --app=<url>` → default browser.

The `--lan` flag is on so phones and laptops can open the token link shown in the sidebar footer; `scripts\allow-lan.cmd` still handles the firewall rule once. Port and cwd come from `omni.config.json` or the `.cmd` argument as today.

### Server changes for the desktop mode
- No server flag is needed to detect the window: the launcher opens `url?desktop=1` and the UI reads that query flag to hide the "open in browser" hint and keep `document.title` in sync with the current chat.
- A `POST /api/shutdown` route, local-only, closes the app cleanly (stops pi, Claude runs, watchers). The launcher calls it on window close and only falls back to `taskkill` if the process is still alive after 3 s.

### Tests
- `test/desktop.test.mjs` runs `python desktop/omni_desktop.pyw --plan --port 0` which prints the spawn plan as JSON without launching anything; asserts the node args include `--lan` and `--cwd`. Skipped when `python` is not on PATH.
- Manual: double-click the shortcut, confirm no console appears, the window opens, a phone can open the LAN link, closing the window frees port 4400.

---

## Rollout
1. Section 1 (server) with tests.
2. Section 2 and 3 together (the transcript renderer is rewritten once).
3. Section 4.
4. README: replace the Run section (desktop launcher first, console mode second) and the "What you get" bullets.

## Risks
- `--fork-session` on a session whose terminal is mid-tool-call copies a transcript that ends in a dangling tool use; Claude Code tolerates this, but the forked chat's first turn may re-run that tool. Documented in the fork caption.
- pywebview on Windows uses WebView2 (Edge). If it is missing the launcher falls back to Edge app mode. Tested with Python 3.11, where `webview` is installed on this machine.
- The `pending` sid for forks means a fast page reload during the first second may briefly show a session with no title. The registry re-key fixes it on the next event.
