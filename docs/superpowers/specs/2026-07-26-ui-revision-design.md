# Omni Agent — UI Revision Design

Date: 2026-07-26
Status: **implemented** on branch `ui-revision`. See "Implementation notes" at the
end for where the build diverged from this design and what it uncovered.

## Problem

The frontend has grown organically. Six separate complaints, all real:

1. Typography and spacing are ad-hoc. `index.html` uses seven distinct font sizes
   (`10px`, `10.5px`, `11px`, `12px`, `12.5px`, `13px`, `14px`), four vertical
   paddings on sibling controls, and inline `style="width:130px"` /
   `style="right:3.75rem"` escapes. Nothing sits on a grid.
2. Several accent colors fail WCAG AA as small text on the panel surface
   (measured below). "Unreadable" is literally true in places.
3. The workspace picker is a single `<select>` — no way to see paths, recency,
   or manage the list.
4. The LLM providers modal is one long undifferentiated scroll.
5. The transcript speaks in internal identifiers (`list_directory`) and counts
   undifferentiated "tools". The `Thinking…` line's token figure is a
   `chars ÷ 4` estimate that resets on every auto-summarization.
6. The file tree is read-only. No upload by drop, no move, no delete, no
   context menu.

## Decisions locked (agreed before writing)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Sequencing | Three milestones, each spec → plan → implement |
| 2 | Token counter meaning | Total size of the **main conversation**, subagents excluded |
| 3 | Counter on summarization | **Keeps growing** — never drops |
| 4 | Group summary granularity | **6 core verbs** — Read / Changed / Ran / Searched / Delegated / Planned |
| 5 | Design intent | **Systematic refit, same visual identity** |
| 6 | "Resizings" means | Small-window audit + large-window audit + collapsible sidebar. **No draggable splitters.** |
| 7 | Where the design scale lives | CSS custom properties + semantic component classes in the existing `<style>` block. **No Tailwind rebuild in the edit loop.** |
| 8 | Where tool metadata lives | A `TOOL_META` table in `app.js`, guarded by a Python test against `tool_registry` |
| 9 | Token arithmetic | Per-turn delta of provider-reported usage (formula in §1.6) |

## Current architecture

- pywebview 6.2.1 desktop shell. `agent.py:1214 AgentApi` is the `js_api` object;
  every frontend↔backend call is `pywebview.api.<method>()`.
- Frontend is `frontend/index.html` (783 lines, markup + a ~390-line hand-written
  `<style>` block) and `frontend/app.js` (3382 lines, no modules, no build).
- `frontend/tailwind.css` is **precompiled and minified**. New Tailwind utility
  classes require `npx tailwindcss@3 -c tailwind.config.js -i tailwind.input.css
  -o tailwind.css --minify`. `index.html:209` documents that the `<style>` block
  exists specifically to avoid that rebuild; `.composer-input`,
  `.composer-model-btn`, `.composer-model-menu` already follow the pattern.
- Existing frontend test harness: `tests/frontend/*.mjs` load the real `app.js`
  into a Node `vm` over a minimal DOM shim. **Nothing currently runs them** — no
  pytest wrapper, no npm script.

---

# Milestone 1 — Design foundation + transcript readability

## 1.1 Design token layer

Add to the existing `:root` block in `index.html`, beside the color variables:

```css
/* spacing — 4px base grid */
--space-1: 4px;  --space-2: 8px;  --space-3: 12px;
--space-4: 16px; --space-5: 24px; --space-6: 32px;

/* type ramp — collapses today's seven sizes to six steps */
--text-2xs: 10px;  /* eyebrow labels, tree meta */
--text-xs:  11px;  /* secondary / muted */
--text-sm:  12px;  /* dense UI, tree rows, chat meta */
--text-base:13px;  /* body */
--text-lg:  15px;  /* panel + modal titles */
--text-xl:  20px;  /* start screen heading */

--leading-tight: 1.35;
--leading-normal: 1.55;

/* control heights — every button/input/select lands on one of these */
--control-h-sm: 26px; --control-h-md: 32px; --control-h-lg: 38px;

/* radii */
--radius-sm: 6px; --radius-md: 10px; --radius-lg: 14px; --radius-full: 999px;
```

### Contrast remediation

Measured ratios for the current palette (computed, not estimated):

| Color | Dark on `panel` | Light on `panel` |
|-------|-----------------|------------------|
| cyan (accent) | **4.24** ✗ | **3.77** ✗ |
| red | **4.46** ✗ | **4.43** ✗ |
| green | 4.80 ✓ | **3.81** ✗ |
| magenta | 5.42 ✓ | **3.85** ✗ |
| orange | 5.93 ✓ | **3.91** ✗ |
| gray | **3.69** ✗ | **3.39** ✗ |

AA for normal text is 4.5:1. Every accent is used as small text somewhere
(`text-term-cyan` at `text-[11px]` in the start screen and LLM modal, `text-term-red`
for errors, `text-term-gray` in the tree). The vivid values are correct for
*fills, borders and dots*; they are wrong for *text*.

Fix: add text-only variants used exclusively for foreground text, keeping the
existing variables for fills, borders and dots. Each was derived by holding hue
and saturation constant and moving lightness until the color clears 4.5:1 against
**both** `--term-panel` and `--term-bg` in its own theme:

```css
/* dark — lighten toward the surface */
--term-cyan-fg:    219 128  98;  /* #DB8062  panel 4.58  bg 5.25 */
--term-red-fg:     230 120 109;  /* #E6786D  panel 4.58  bg 5.25 */
--term-gray-fg:    154 152 145;  /* #9A9891  panel 4.58  bg 5.25 */
--term-green-fg:   133 165 113;  /* unchanged — already 4.80 / 5.50 */
--term-magenta-fg: 140 169 198;  /* unchanged — already 5.42 / 6.21 */
--term-orange-fg:  217 164  91;  /* unchanged — already 5.93 / 6.79 */

/* light — darken */
--term-cyan-fg:    171  81  51;  /* #AB5133  panel 4.57  bg 5.04 */
--term-red-fg:     189  64  53;  /* #BD4035  panel 4.58  bg 5.05 */
--term-green-fg:    82 116  66;  /* #527442  panel 4.59  bg 5.06 */
--term-magenta-fg:  81 110 141;  /* #516E8D  panel 4.56  bg 5.03 */
--term-orange-fg:  144  98  30;  /* #90621E  panel 4.57  bg 5.04 */
--term-gray-fg:    110 107 101;  /* #6E6B65  panel 4.57  bg 5.04 */
```

`--term-muted` already passes in both themes (4.70 / 4.58 on panel) and is left
alone. In dark mode three accents already passed and are aliased unchanged, so
the variable exists uniformly and callers never have to know which is which.

The test in §1.7 re-derives and asserts these, so the numbers cannot drift if the
surface colors are ever retuned.

### Semantic component classes

Added to the `<style>` block. Tailwind continues to own *layout* (`flex`, `grid`,
`gap`, `min-w-0`); these own *appearance and sizing*.

- `.btn` base + `.btn-primary` `.btn-ghost` `.btn-danger` `.btn-sm`
- `.icon-btn` — square, `--control-h-sm`, centered glyph
- `.field` — input / select / textarea, `--control-h-md`
- `.chip` — small status pill
- `.eyebrow` — uppercase micro-label
- `.panel-head` `.panel-body` `.panel-foot`
- `.modal-shell` `.modal-head` `.modal-body` `.modal-foot` — unifies the three
  modals (`#fileViewer`, `#exportModal`, `#llmModal`), which today each hand-roll
  their own chrome with different paddings and title sizes.

Migration removes the ad-hoc utility strings and inline `style=` escapes from
every widget these classes cover.

## 1.2 Responsive behavior

**Small window (down to the 980×600 `min_size`):**
- Every scroll region declares `overflow-y:auto; overflow-x:hidden` explicitly;
  only `<pre>` / code / diff regions get `overflow-x:auto`. The page body never
  scrolls horizontally.
- The 48px header (`#projectBadge`, `#planBadge`, two icon buttons, `change`)
  overflows at narrow widths. Below `1100px` the plan badge drops to its icon +
  count and the `change` button drops its label.
- Modals: `max-height: calc(100vh - var(--space-6) * 2)` with the body scrolling
  internally, never the shell. The LLM modal is the worst current offender.

**Large window:** chat already caps at `64rem`. The plan tab gets the same
measure cap so prose doesn't stretch to unreadable line lengths.

**Collapsible sidebar:** the `w-72` aside becomes `width: var(--sidebar-w)`.
A toggle in the sidebar header collapses it to zero width; when collapsed, a
matching expand button appears at the left of the main header. State persists in
`localStorage['omni-sidebar-collapsed']`. No drag-resize (explicitly out of scope).

## 1.3 Tool display names

`app.js` gains a single `TOOL_META` table:

```js
const TOOL_META = {
  list_directory:  { name: 'List Directory',  cat: 'search' },
  read_file_chunk: { name: 'Read File',       cat: 'read'   },
  run_command:     { name: 'Run Command',     cat: 'run'    },
  // … one entry per registered tool
};
```

`toolDisplayName(name)` returns `TOOL_META[name].name`, falling back to a
mechanical transform: split on `_`, Title-Case each word, then upper-case any
word in an acronym set (`APK, DEX, ELF, SO, ADB, URL, ID, UI, KG, JS, NM, PLT`).
No tool can ever render as raw `snake_case`, including one added tomorrow.

This replaces the existing `READ_FILE_TOOLS` / `CHANGE_FILE_TOOLS` sets at
`app.js:291` — those become derived views over `TOOL_META`.

## 1.4 Action-group summary line

Six categories. Every registered tool maps to exactly one:

| `cat` | Rendered | Counting unit |
|-------|----------|---------------|
| `read` | `Read 3 files` | distinct file paths |
| `change` | `Changed 2 files` | distinct file paths |
| `run` | `Ran 3 commands` | call count |
| `search` | `Searched 4 times` | call count |
| `delegate` | `Delegated to 3 subagents` | agents dispatched (from args), else call count |
| `plan` | `Planned 2 steps` | call count |

Rendered in that fixed order, `·`-joined, omitting zero segments. Path dedup for
`read`/`change` reuses the existing `toolPathKey(args)` helper.

A tool with no `TOOL_META` entry falls into an implicit `other` bucket rendered
as a trailing `Ran N tools`. The guard test in §1.7 keeps that bucket empty in
practice; it exists so a newly added tool degrades gracefully instead of vanishing
from the count.

The group's `title` attribute keeps the raw total (`6 tools`) for anyone who
wants it.

## 1.5 `Thinking…` line format

Current: `Thinking…  56k tokens  1h 55m 4s` (two space-separated fragments, tokens first).

Target: `Thinking… (1h 55m 4s · 56k tokens)` — parenthesized, elapsed first, joined
by a **small** middot. The dot gets its own span so it can be styled down:

```css
.think-dot { font-size: .8em; opacity: .65; margin: 0 .35em; vertical-align: .05em; }
```

Degenerate cases: if only one value is available, render `(1h 55m 4s)` or
`(56k tokens)` with no dot. If neither, render nothing (no empty parens).

## 1.6 Conversation token counter

**Why the current number is wrong.** `_emit_status` (`agent.py:3223`) emits
`ctx_tokens = session_context_tokens(s)`, which is
`sum(len(m["content"])) ÷ 4` over the *current* message list. Two defects:
it is an estimate, and `_maybe_summarize_context` physically replaces
`s["messages"]` with a summary, so the figure collapses mid-run.

Meanwhile `llm.py` already records real provider usage — `_record_usage` at
`llm.py:1449` (OpenAI shape) and `:1599` (Anthropic shape) — exposed via
`llm.take_last_usage()`. `subagents.py:472` consumes it. **The main loop never
does.** The accurate number is already on the table and being discarded.

**Arithmetic.** Session state gains `convo_tokens`, `_usage_prev_prompt`,
`_usage_prev_completion`. After each `ask_llm` call in `_get_model_response`:

```
u = llm.take_last_usage() or {}
prompt, completion = u.get('prompt', 0), u.get('completion', 0)
s['convo_tokens'] += max(0, prompt - (prev_prompt + prev_completion))  # new input
s['convo_tokens'] += completion                                        # the reply
prev_prompt, prev_completion = prompt, completion
```

- First call contributes the whole system prompt + first user message.
- Each later turn contributes only genuinely new content — tool results plus the
  reply. Nothing is double-counted the way raw cumulative billing would be.
- Monotonic by construction (`max(0, …)` plus a non-negative completion).

**Capture point.** Immediately after each of the two `ask_llm` call sites in
`_get_model_response` (`agent.py:3966` and `:3983`). This matters: the review
gate, strategy review and summarizer also call `ask_llm` on the main thread, and
their usage is *not* part of the conversation. Reading immediately after the
conversation's own call means auxiliary usage is never attributed to the counter.
Subagents are inherently excluded — `take_last_usage` is thread-local.

**Known limitation, accepted.** On the turn where auto-summarization fires,
`prompt` collapses below `prev_prompt + prev_completion`, the clamp yields `0`,
and that single turn's tool-result tokens go uncounted. This undercounts by a few
thousand tokens once per summarization. The alternative — filling the gap with a
`chars ÷ 4` estimate — reintroduces exactly the fake number being removed, so the
honest undercount is preferred.

**Transport.** `_emit_status` gains `convo_tokens`. `ctx_tokens` stays (it still
drives nothing user-facing but is cheap and useful for debugging). The frontend
reads `ev.convo_tokens ?? ev.ctx_tokens`, so transcripts saved before this change
still replay with their old number rather than showing zero.

**Lifecycle.** Included in `last_status` so it survives reload via the existing
persistence path. Reset to `0` in `clear_chat`.

## 1.7 Testing (M1)

- **Wire up the orphaned harness first.** `tests/test_frontend_js.py` discovers
  `tests/frontend/*.mjs` and runs each under `node`, failing the pytest run on a
  non-zero exit. The two existing `.mjs` files currently run nowhere.
- `tests/frontend/test_tool_naming.mjs` — `toolDisplayName` for curated entries,
  acronym handling, and the mechanical fallback for an unknown tool.
- `tests/frontend/test_group_summary.mjs` — drives real tool events through the
  actual group code and asserts the rendered line, including path dedup, fixed
  segment order, zero-segment omission, and the `other` fallback.
- `tests/frontend/test_thinking_meta.mjs` — all four format cases (both values,
  elapsed only, tokens only, neither).
- `tests/test_tool_meta_coverage.py` — imports `tool_registry`, parses `TOOL_META`
  out of `app.js`, fails if any registered tool lacks an entry. This is what keeps
  the frontend table honest as tools are added.
- `tests/test_conversation_tokens.py` — the delta arithmetic against a faked
  `take_last_usage` sequence: normal growth, monotonicity across a simulated
  summarization, and exclusion of auxiliary main-thread calls.
- `tests/frontend/test_contrast.mjs` — parses the `:root` and `html.light` blocks
  out of `index.html` and asserts every `-fg` variable clears 4.5:1 against both
  `--term-bg` and `--term-panel`. This test *defines* the remediated values.

---

# Milestone 2 — Screens

Specified at design level; details firm up in M2's own plan.

## 2.1 VS Code–style workspace picker

Replaces the single `#projectSelect` dropdown with a full-window two-pane screen.

- **Left rail** — brand, then primary actions: `Open Folder…` (existing
  `select_workspace`), `Import a copy…` (existing `import_workspace`).
- **Main pane** — `Recent` list. Each row: folder name, full path (middle-truncated,
  muted), last-opened relative time, saved-message count. Hover reveals row
  actions: Open · Reveal in Finder · Forget. Double-click opens.
- **Filter field** at the top of the list; `/` focuses it, `Esc` clears.
- **Keyboard**: `↑`/`↓` move selection, `Enter` opens.
- **Empty state** when there are no recents.

Backend: `get_projects` (`agent.py:2041`) extends each recent entry with
`last_opened` (epoch) and `message_count`. New `reveal_in_finder(path)`.

## 2.2 Composer effort selector

The model dropdown (`#modelMenu`) gains a footer section below the model list:
an `Effort` segmented control whose options come from the **existing**
`_REASONING_FAMILIES` / `detectReasoningFamily` machinery already in
`app.js:2064` — so a GLM model shows a thinking toggle, an OpenAI-style model
shows Off/Low/Medium/High/Max, and a model that always reasons shows nothing.

The trigger button gains a muted suffix: `glm-5.2 · High`.

Backend: new `set_model_effort(config_id, model, effort)` writing
`configs[i].model_settings[model].reasoning_effort` — the same field the LLM
settings modal already writes (verified present in `llm_config.json`).
`list_model_options()` extends each option with its current `reasoning_effort`
and resolved family so the menu renders the right control without a second call.

## 2.3 LLM providers settings redesign

Pure UI restructure — **the config data model does not change.**

Today it is a list view plus a single-column edit view that scrolls through
Name → provider tabs → keys → models → vision models → base URL → max tokens →
context window → temperature, with per-model ⚙ panels nested inside.

Target: master–detail.

- **Left column** — provider list, drag to reorder, with explicit priority
  numbers and a one-line explainer: *"Providers are tried top to bottom."*
- **Right column** — the selected provider in three labeled sections:
  1. **Connection** — preset tabs, base URL, API keys
  2. **Models** — the ladder, with `Text` / `Vision` as tabs inside the section;
     each row carries its inline effort, tier and test control
  3. **Limits** — max tokens, context window, temperature
- **Sticky footer** — Test · Cancel · Save.

---

# Milestone 3 — Workspace file tree

## 3.1 New backend APIs

All new `AgentApi` methods reuse the existing sandbox guard pattern from
`upload_files` (`agent.py:2808`): resolve against the session root, reject
anything not under `root + os.sep`.

| Method | Purpose |
|--------|---------|
| `fs_move(src_rels, dest_dir_rel)` | move files/folders (batch) |
| `fs_delete(rels)` | move to `.omni-trash/` inside the workspace — recoverable |
| `fs_trash_restore(rel)` / `fs_trash_empty()` | trash lifecycle |
| `fs_mkdir(rel)` | new folder |
| `fs_rename(rel, new_name)` | rename in place |
| `fs_duplicate(rel)` | copy beside |
| `fs_write_upload(dest_dir_rel, name, b64, first, last)` | chunked upload |
| `reveal_in_finder(rel)` | shared with M2 |

Deleting to an in-workspace `.omni-trash/` rather than hard-unlinking is
deliberate: a mis-drop on the trash node must be recoverable, and the agent's own
tools already treat the workspace as the unit of state.

**Bug fixed along the way:** `agent.py:2853` returns
`build_file_tree(project)` where `project` is undefined — `upload_files` raises
`NameError` on its success path today.

## 3.2 Drag-and-drop upload (host → app)

pywebview 6.2.1 exposes **no native file-drop event** (verified against the
installed `Window` class — no `file_drop`, no drag events). So host→app drop must
go through HTML5 `DataTransfer`:

- `dragover` / `drop` on `#fileTree` and on each folder row, with `preventDefault`
  so the webview doesn't navigate.
- `e.dataTransfer.items[i].webkitGetAsEntry()` to distinguish files from
  directories and walk directory trees recursively.
- Each `File` read via `FileReader` → base64 → sent in ≤512 KB chunks to
  `fs_write_upload`, which appends. Chunking is required: the pywebview JS bridge
  serializes arguments as JSON, so a whole large file in one call is a memory spike.
- Per-file size cap (100 MB) with an explicit error toast rather than a silent
  failure. Aggregate progress shown in a toast.

**This is the highest-risk item in the whole revision.** The plan for M3 must
start with a spike proving a folder drop round-trips through WKWebView before the
rest is built on it.

## 3.3 Drag to move / drag to trash

Tree rows become `draggable="true"`. Drop targets: folder rows (→ `fs_move`) and a
pinned Trash node at the bottom of the tree (→ `fs_delete`). Drop-target rows get
a highlight; dropping a folder into its own descendant is rejected client-side
with a message. Multi-select via `Ctrl`/`Cmd`-click and `Shift`-click; a drag
carries the whole selection.

## 3.4 Context menu

Right-click on a row opens a positioned `.ctx-menu`: Open · Rename · Duplicate ·
Delete · Reveal in Finder · New File · New Folder · Copy Path. The Trash node's
menu offers Empty Trash. Closes on outside click, `Esc`, or scroll.

## 3.5 Remove the export button

Remove `#exportWorkspaceBtn` from the sidebar header, plus `#exportModal` and its
`app.js` wiring (`openExportModal`, `closeExportModal`, `approveExport`,
`renderExportDiff`, `_exportDiffCache`).

The Python APIs `compute_export_diff` / `export_workspace` stay — they are the
second half of the documented import-a-copy workflow and are reachable outside
this button. The start screen's import explainer text, which currently points at
"export changes (in the workspace panel)", is updated so it no longer references
a button that has been removed.

## 3.6 Testing (M3)

- Python: path-traversal rejection for every `fs_*` method; move-into-own-descendant
  rejection; trash round-trip (delete → restore → identical bytes); chunked-upload
  reassembly including a multi-chunk file; the `upload_files` `NameError` regression.
- `tests/frontend/test_tree_dnd.mjs`: drop-payload construction, self-descendant
  guard, multi-select drag set, trash-drop routing.

---

## Out of scope

- Draggable panel splitters (explicitly declined).
- Any change to the visual identity — colors, fonts and overall look stay; only
  the scale, contrast and rhythm change.
- Any change to the LLM config file format.
- Cumulative *billing* telemetry (tokens across subagents) — the counter is
  main-conversation size only.

---

# Implementation notes

All three milestones landed. Where the build diverged from the design above, and
what it turned up:

## Corrections to this document

- **§1.1 wrongly implied `text-[10.5px]` was dead.** It is not: Tailwind escapes
  a `.` inside an arbitrary value as `\.`, which a naive grep misses. The class
  compiles fine. The real dead classes were three widths *introduced* by the new
  picker and LLM markup (`w-[300px]`, `w-[220px]`, `max-w-[320px]`, `w-[272px]`),
  caught by `test_tailwind_classes.mjs` and moved to inline styles.
- **The `-fg` colors are applied by overriding the `.text-term-*` utilities**, not
  by editing markup. `bg-`/`border-`/`fill-` keep the vivid base values, since
  only text ever had a contrast problem. This changed ~50 sites with 8 CSS rules.
- **`reveal_in_finder` takes either an absolute or a workspace-relative path.**
  The picker has no session and passes an absolute path; the file tree passes a
  relative one, which goes through `_safe_abs`.

## Bugs found while building

1. **`upload_files` raised `NameError` on its success path** (`build_file_tree(project)`,
   undefined) — as predicted in §3.1, now fixed and regression-tested.
2. **`tests/frontend/test_hud_integration.mjs` was already broken** and had been
   for some time; nothing ran it. The DOM shim lacked `remove()`.
3. **`list_model_options` could not represent "reasoning explicitly off".**
   `_ladder` deliberately flattens a per-model `off` to `''` so the request
   builder sends no reasoning params, so the UI could not distinguish it from
   "unset" and showed "Default". Models now carry a raw `effort_override`.
   The first fix attempt used `_norm_reasoning`, which collapses `off` the same
   way — per-model values need `_norm_model_effort`.
4. **`toolPathKey` only knew 14 argument names**, so 23 of the read/change tools
   could not dedupe by path at all. Found by a test that cross-checks the
   frontend's key list against the Python registry's declared parameters.
5. **Five LLM-settings call sites set status by replacing `className`**, which in
   the new shared footer also stripped layout classes.
6. **`el.className = 'a b'` was invisible to `classList.contains()`** in the test
   DOM shim — a latent source of false passes, fixed while adding the tree tests.

## Test surface added

`tests/frontend/*.mjs` is now wired into pytest via `tests/test_frontend_js.py`.
Nine frontend suites plus four Python ones; the whole suite runs **720 passed,
3 skipped** (baseline before this work: 636/3).

The four guards worth knowing about, because they encode constraints this
codebase cannot otherwise enforce:

| Test | Catches |
|------|---------|
| `test_boot.mjs` | `init()` throwing, or looking up an id the markup lacks — verified against a planted regression |
| `test_tailwind_classes.mjs` | arbitrary utilities absent from the precompiled sheet, which fail silently |
| `test_contrast.mjs` | any accent dropping below WCAG AA, re-derived from the shipped CSS |
| `test_tool_meta_coverage.py` | a registered tool with no display name, filtered by defining module so other suites' fixtures don't false-positive |

## Deliberate tradeoffs

- **`.omni-trash` lives inside the workspace**, so the agent's own `list_directory`
  and greps will see deleted files. Accepted: recoverability was the requirement,
  and the trash is visible rather than hidden state.
- **The conversation token counter undercounts by one turn's tool output per
  auto-summarization** (§1.6). Preferred over reintroducing a `chars ÷ 4` estimate.
- **No draggable panel splitters** — explicitly declined during design.
- **`compute_export_diff` / `export_workspace` remain in `agent.py`** with no UI
  entry point, since the import-a-copy workflow is their other half.
