# Omni-Agent: Workflow Library UI — browse, launch, and inspect runs

**Date:** 2026-08-21
**Status:** DESIGN — approved in brainstorming, not yet implemented.
**Branch:** `workflow-library-ui` (off `main`)

## Goal

Make the workflow engine usable **by hand**. Today a workflow can only be started
by the model calling `run_workflow`, and a finished run vanishes from the UI the
moment the next one starts. This adds: a library you can browse and launch from,
a form built from each workflow's declared arguments, and a history of past runs
you can open and inspect down to what each individual agent returned.

It also closes the four items deferred out of the workflow engine's final fix
wave.

This is sub-project 3 of 4. Sub-projects 1 (workflow engine) and 2 (SSH devices)
are merged; sub-project 4 (the Google-style UI restyle) gets its own spec.

## Confirmed design decisions (user)

1. **Browse and launch, no in-app editor.** Authoring stays the model's job — it
   already writes scripts and every one is dry-run gated. No script editing, no
   syntax highlighting, no save format.
2. **All four deferred items are in scope:** run history, per-agent result
   click-through, nested-workflow grouping in the tree, and the nested fan-out cap.
3. **`args_schema` is added to `meta`** so the launch form can be a real labelled
   form rather than a raw JSON box.
4. **A user-launched run's result goes into the conversation**, so the model can
   act on it.

## What already exists (verified, not assumed)

- `frontend/workflow_view.js` is 203 lines and handles the LIVE run only: the
  phase tree, the inline chat card, and the tab badge. The Workflow tab is
  `#workflowEmpty` + `#workflowTree` and nothing else.
- **Run artifacts are already on disk**, per run, under
  `<run_root>/workflows/<run_id>/`: `script.py`, `meta.json`, `journal.jsonl`,
  `result.json`. Since the SSH-devices work, `agent.py` calls
  `workflows.set_run_root(memory_dir)`, so runs are per-project.
- **The journal IS the per-agent record.** Every `journal.record` row carries
  `ok`, `result` (the agent's actual return value), `phase`, `label`,
  `agent_type`, `tokens`, `elapsed_s`, `model`, `is_write` and `cached`. The
  engine spec's `agents/<sub_id>.jsonl` transcripts were never implemented and
  are **not needed** — click-through is a reader over data already written.
- `workflows/runtime.py:107` emits `ev["group"]` for a nested workflow's events.
  `workflow_view.js` never reads it, so the tree renders nested runs flat.
- There is **no** list-runs API, and `result.json` stores only `{ok, error,
  result}` — `aborted`, `agent_count` and `elapsed_s` are computed by `run()`
  and discarded. Those two are the backend gaps history needs closed.
- `MAX_ITEMS = 256` bounds each `parallel`/`pipeline` CALL, not the product, so
  `pipeline(256)` whose stages each `parallel(256)` can open ~65k threads.

## Non-goals

- **An in-app script editor.** Decision #1.
- **Saving ad-hoc scripts as named workflows.** A user library is a save format,
  a storage location and a name-collision policy; none of it is needed to make
  the built-ins usable.
- **Run deletion or a retention policy.** Runs are the user's data; the list is
  bounded by `limit`, not by pruning.
- **Scheduling.**
- **New per-agent transcript capture.** The journal already suffices.

---

## Backend

### `args_schema` in `meta`

One additive, optional field:

```python
meta = {
    "name": "review-changes",
    "description": "Review a diff across independent dimensions, then adversarially verify.",
    "args_schema": {
        "target": {"label": "Git ref or path", "required": True, "placeholder": "HEAD"},
    },
}
```

`sandbox.extract_meta` already requires `meta` to be a pure literal and
`ast.literal_eval`s it, so this validates for free — it needs only to accept and
pass the key through. All six built-ins declare theirs.

The payoff is double. The UI renders a labelled form; and `run_workflow`'s
render-time description can advertise exact argument names instead of the prose
it uses today (`args: {"target": "<git ref or path>"}`), which should improve the
model's arg-passing as much as the UI's.

**Validation:** `args_schema` must be a dict of `{str: dict}`. A malformed one is
an authoring error and is rejected by `extract_meta` with the same clarity as a
missing `name` — a form built from a malformed schema would fail confusingly at
render time instead.

### Reading past runs

**One small write is needed after all.** `result.json` currently stores only
`{ok, error, result}` and `meta.json` only `{meta, args, resume_from}` — so
`aborted`, `agent_count` and `elapsed_s` are computed by `run()` and then thrown
away. A history list cannot report what was never persisted.

Fix: `result.json` gains the summary `run()` already has in hand — `name`,
`aborted`, `agent_count`, `elapsed_s`, plus wall-clock `started` and `finished`.
Additive and written once at the end of a run, so it costs nothing per agent
call. (The determinism rules that forbid `time` apply to workflow SCRIPTS, not to
the engine; `workflows/__init__.py` already uses `time.monotonic()`.)

**Runs predating this change still list.** They lack the new fields, so the
reader falls back: `agent_count` from counting `journal.jsonl` lines, `started`
from the run directory's ctime, `finished` from `result.json`'s mtime, and
`elapsed_s`/`aborted` shown as unknown rather than guessed. An old run being
listed with two blank columns is right; a list that silently omits every run made
before today is not.

Two readers:

- `list_runs(limit=50) -> list[dict]` — walks `<run_root>/workflows/*/`, reads
  each `meta.json` (+ `result.json` when present), returns newest-first summaries:
  `run_id`, `name`, `started`, `ok`, `aborted`, `agent_count`, `elapsed_s`.
- `load_run(run_id) -> dict` — the full record: `meta`, the parsed `journal.jsonl`
  rows, and `result`.

**Degradation is the design point.** A run directory with a missing or corrupt
`meta.json` is SKIPPED from the listing rather than breaking it — the same rule
`devices.load_devices` follows, and for the same reason: one bad file must not
cost the user the whole list. A journal torn by a kill is parsed line-by-line for
what survived, which is already how `Journal._load_replay` behaves.

Sorting is by `started` when present and by directory ctime otherwise, so new
and old runs interleave correctly in one list.

### Launching from the UI

`AgentApi.launch_workflow(name, args)`:

1. **Refuses if the agent is busy**, exactly as `select_device` now does. Two
   things driving the conversation at once is incoherent, and the refusal names
   the reason.
2. Marks the session busy, then runs `workflows.run(...)` on a background thread
   with events funnelled through the existing single-threaded UI sink (the
   `_drain_to_ui` pattern in `tools/workflow_tools.py`).
3. On completion, appends a **user-role** message prefixed
   `WORKFLOW RESULT (<name>, run <run_id>):` and runs the normal agent loop, so
   the model responds to the findings.

User-role is the honest choice, not a workaround: this codebase already feeds
tool output back as user-role `TOOL RESULT:` messages (`subagents._format_tool_result`
and `agent.py`'s tool loop), so `WORKFLOW RESULT:` follows an established
convention rather than inventing one.

**The injected text is distilled and capped**, with the `run_id` as the pointer to
the full record. An `exhaustive-audit` result can be large, and pasting it whole
would blow exactly the context budget the engine exists to protect. Cap: 4000
characters, with a trailing note naming the run to open for the rest.

### The nested fan-out cap

`MAX_ITEMS` bounds a single call. The product is unbounded, so a nested
`pipeline` × `parallel` can open tens of thousands of threads.

Fix: a runtime-wide **in-flight branch counter**, guarded by the existing
`_count_lock`, capped at **`MAX_LIVE_BRANCHES = 1024`**. `_spawn` adds its batch
size before spawning and subtracts in a `finally`. Exceeding the cap raises
`WorkflowScriptError` naming the cap and the count in flight.

Child runtimes already share `_count_lock` (see `runtime.workflow()`), so a
nested workflow counts against the same budget — which is the entire point.

---

## The UI

### Layout: master-detail

The Workflow tab becomes a narrow left rail plus a detail pane, matching the
idiom this app already adopted when the LLM providers panel was restructured.

- **Left rail**, two collapsible sections: **Library** (the six built-ins) and
  **Recent runs**.
- **Detail pane** renders *a* run — the live one by default, or a historical one
  you select. One renderer, two sources.

### File split

`workflow_view.js` (203 lines) would roughly triple. Instead:

| File | Owns |
|---|---|
| `frontend/workflow_view.js` | event ingestion, run state, tree + card rendering. Extended to read `ev.group` and to make agent rows clickable. |
| `frontend/workflow_library.js` (new) | the left rail: library list, launch form, history list. Calls into `workflow_view` to render a selected historical run. |

The seam: one module knows **how to draw a run**, the other knows **which run to
draw**.

### The four deferred items, concretely

- **Nested grouping** — agents whose event carries `group` render under a
  `▸ <name>` node instead of flat. The runtime already emits it; this is a
  renderer change only.
- **History** — the rail lists runs newest-first with name, relative time, a
  status dot, agent count and elapsed. Selecting one calls `load_run` and renders
  it through the same tree, read-only.
- **Click-through** — clicking an agent row opens a detail panel showing its
  stored `result`, `model`, `tokens`, `elapsed_s` and a `cached` marker.
  Identical for live and historical runs, because both are journal rows.
- **Launch form** — labelled inputs built from `args_schema`, with **Dry run**
  beside **Launch**. Dry-run surfaces validation failures in the form without
  spending a token: it exposes the engine's existing pre-flight gate rather than
  adding one.

### Frontend rules that bite silently

All three have already caused failures in this repo, and each fails with every
test still green:

1. Component classes go in the **`<style>` block of `frontend/index.html`**, NOT
   `tailwind.input.css` (three `@tailwind` lines). That block is what
   `tests/frontend/test_tailwind_classes.mjs` reads.
2. `frontend/tailwind.config.js`'s `content` globs must include
   `'./workflow_library.js'`, or Tailwind utilities used only there are purged.
3. `tests/frontend/test_element_ids.mjs` and `test_tailwind_classes.mjs` must be
   extended to scan the new file, or it becomes the only UI file with no id or
   class guard.

Use only existing tokens — `--term-*`, the `--text-*` ramp, the 4px spacing
scale. `tests/frontend/test_contrast.mjs` asserts the palette in both themes.

**Escaping.** Every interpolated value goes through `esc()`, and one deserves
naming: **stored agent results are model-authored text** rendered into the
click-through panel. That is the most attacker-adjacent string in this feature.

---

## Error handling

| Case | Behaviour |
|---|---|
| Launch while the agent is busy | Clear refusal naming the reason; nothing starts |
| Dry-run fails | Traceback shown in the form; no launch, no tokens spent |
| Run directory with corrupt/missing `meta.json` | Skipped from the listing, list still renders |
| Journal torn by a kill | Parsed line-by-line for what survived |
| `load_run` on an unknown id | `ok: False` with a clear error; the rail stays usable |
| Nested fan-out exceeds the cap | `WorkflowScriptError` naming the cap and in-flight count |

## Testing

All offline, matching the existing suite's discipline.

| File | Covers |
|---|---|
| `tests/test_workflow_runs.py` | `list_runs`/`load_run` against a fabricated run root INCLUDING a corrupt directory and a torn journal; newest-first ordering; `limit`; unknown id; **a legacy run written before the summary fields existed still lists, with agent_count derived from the journal and elapsed/aborted marked unknown rather than guessed** |
| `tests/test_workflow_run.py` (extend) | `result.json` carries name/aborted/agent_count/elapsed_s/started/finished after a run |
| `tests/test_workflow_meta_args.py` | `args_schema` accepted as a literal; rejected when computed or malformed; absent is still valid |
| `tests/test_workflow_launch.py` | `launch_workflow` refuses while busy; the injected message's prefix, shape and 4000-char cap; the run id appears in it |
| `tests/test_workflow_runtime.py` (extend) | the nested-branch cap: nested `_spawn` exceeding `MAX_LIVE_BRANCHES` raises and names the cap; the counter returns to zero afterwards |
| `tests/test_workflow_library.py` (extend) | every built-in declares a valid `args_schema` |
| `tests/frontend/test_workflow_library.mjs` | library renders from a fake payload; form builds from `args_schema` and falls back to JSON without one; history renders and selection draws that run; escaping a `<img onerror>` stored result |
| `tests/frontend/test_workflow_view.mjs` (extend) | `group` nesting; agent rows clickable; the detail panel shows a stored result |

## Build order

1. `workflows/sandbox.py` — accept and validate `args_schema`
1a. `workflows/__init__.py` — write the summary fields into `result.json`
2. `workflows/library/*.py` — declare `args_schema` on all six
3. `workflows/__init__.py` — `list_runs` / `load_run`
4. `workflows/runtime.py` — the nested-branch cap
5. `agent.py` — `AgentApi.list_runs` / `load_run` / `launch_workflow`
6. `frontend/workflow_view.js` — `group` nesting + clickable agent rows + detail panel
7. `frontend/workflow_library.js` — the rail: library, form, history
8. `frontend/index.html` + `app.js` — master-detail layout, wiring, styles
9. `tools/workflow_tools.py` — advertise `args_schema` in the tool description
10. `AGENTS.md` — document the launch path and the branch cap

Steps 1-4 are backend-only and independently testable; 5-8 deliver the UI; 9-10
close the loop for the model and the next reader.
