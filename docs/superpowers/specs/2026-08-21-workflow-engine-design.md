# Omni-Agent: Workflow Engine (ultracode-style orchestration)

**Date:** 2026-08-21
**Status:** DESIGN — approved in brainstorming, not yet implemented.
**Branch:** `ui-revision`

## Goal

Give omni-agent **deterministic multi-agent orchestration**: a workflow is a Python
script that fans subagents out across phases, pipes each item through stages without
a barrier, verifies findings adversarially, and loops until a discovery run goes dry.
Control flow is decided by *code*, not by the model re-deciding every turn.

This is the first of four sub-projects. The other three — **remote SSH devices**,
**workflow authoring & library UI**, and the **Google-style UI restyle** — get their
own specs. This one is load-bearing: the workflow library UI is unbuildable without
it, and remote devices become dramatically more useful with it (fan a workflow out
across machines).

## Scope decomposition (for the reader arriving later)

The originating request was: "update the omni agent to work like ultra code, add SSH
devices, add workflows, update the UI to a Google-ish style with vector icons instead
of emoji." That is four subsystems. Specced separately:

| # | Sub-project | Depends on |
|---|-------------|------------|
| 1 | **Workflow engine** (this document) | — |
| 2 | Remote SSH devices | — (independent; see "Why `run_cmd` is the seam") |
| 3 | Workflow authoring & library UI | 1 |
| 4 | Google-style UI restyle + icon system | — (independent) |

## Confirmed design decisions (user)

1. **Workflows are sandboxed Python scripts.** Not a declarative JSON DAG. Full
   control flow — loops, conditionals, loop-until-dry — is the point; a fixed graph
   cannot express the patterns that make ultracode worth having.
2. **Library-first, authoring allowed.** A set of built-in workflows the model
   invokes *by name* with args is the common path. Ad-hoc authoring stays available,
   gated behind a validation + dry-run pass that catches shape errors before any
   token is spent on agents.
3. **Opt-in triggering.** A keyword (`ultra`) in a user message or a UI toggle turns
   on orchestrate-by-default. Otherwise the agent must be asked.
4. **Write agents allowed, scope mandatory.** A workflow may spawn write-capable
   subagents, but each must declare the paths it owns; unscoped writers are rejected
   inside a workflow. This unlocks migrate/fix fan-outs.
5. **No budget controls.** Treat the token budget as unbounded. No `budget` global,
   no loop-until-budget pattern, no per-run ceiling.
6. **v1 includes:** live progress view in the UI, journal + resume, nested workflows.

## Existing foundations (reuse, don't reinvent)

The engine is an orchestration layer over machinery that already works. It must not
duplicate any of it.

- **`subagents.run_subagent`** — runs one persona to completion, returns a distilled
  result dict, never raises, pins an API key for warm prompt cache, isolates llm
  thread-local accounting, and emits `subagent_started` / `subagent_progress` /
  `subagent_done` telemetry. This stays the single way an agent runs.
- **`subagents.ScopedWorkspaceLock`** — writers with disjoint declared path prefixes
  genuinely run concurrently; overlapping or unscoped writers serialize. This is
  already the project's answer to parallel writes, which is why the engine does
  **not** add git-worktree isolation.
- **`subagents.KeyAllocator`** — least-loaded API key per run.
- **`subagents.resolve_model_ladder` / `effective_tier` / `escalate_ladder`** — the
  cost spine. `agent(model=…, tier=…)` forwards to these; the engine invents no
  routing of its own.
- **The subagent JSON protocol** — `_parse_response` already expects
  `{"type": "final_answer", "content": …}`. Structured output constrains `content`;
  it needs no provider JSON mode and no synthetic tool, so it works with whatever
  provider is configured (currently a "Cline Pass" entry).
- **`tools/delegation_tools._run_with_ui_telemetry`** — the queue pattern that lets
  worker threads emit telemetry while `subagents.ui_emit` is still only ever called
  from the agent-loop thread. Workflow events reuse it verbatim.
- **`host_exec.set_stop_check`** — the existing `self._stop` flag. Workflow abort
  reuses it rather than inventing a second cancellation path.
- **`tools/delegation_tools._dispatch_agents_description`** — the lazy,
  render-time-built tool description. `run_workflow` copies the pattern so adding a
  library workflow never means editing a prompt.

## Non-goals

- **Budget controls.** Explicitly declined by the user.
- **Git-worktree isolation.** `ScopedWorkspaceLock` is this repo's answer, and the
  user's project folder is not necessarily a git repo.
- **Remote / cloud execution.** Sub-project #2.
- **A visual workflow builder.** Sub-project #3 at the earliest, probably never.
- **Replacing `dispatch_agents`.** It stays as the cheap ad-hoc read-only fan-out.
  Workflows are for structured, multi-stage work.

---

## Architecture

### Module layout

A new `workflows/` package. Deliberately **not** in `agent.py`: that file is already
286 KB / ~5,200 lines and holds the pywebview bridge, session state, and the
orchestration gate. The engine touches it in exactly three places (below).

```
workflows/__init__.py       public entry: run(), resume(), list_library()
workflows/runtime.py        WorkflowRuntime: concurrency, abort, phases,
                            the agent()/parallel()/pipeline()/workflow()/log() primitives
workflows/sandbox.py        AST wrapping, meta extraction, determinism guards,
                            import whitelist, the script namespace
workflows/schema.py         dependency-free JSON-Schema subset validator,
                            the repair loop, dry-run stub generation
workflows/journal.py        journal.jsonl write/replay, content-addressed call keys
workflows/library/*.py      the six built-in workflows
tools/workflow_tools.py     the run_workflow tool the model calls
```

**Touch points in `agent.py`** — kept to three, and each is additive:

1. An `ultra` flag in per-project session state (persisted alongside the existing
   session flags such as `context_editing`).
2. One line in `_refresh_system_prompt` rendering ULTRA MODE: ON/OFF.
3. Passing the existing UI event sink through to `workflows.run()`.

### Concurrency model — threads plus a semaphore, never a pool

The codebase has **no asyncio anywhere**; it is threads throughout. The engine keeps
it that way.

The obvious design — run every `agent()` through one shared `ThreadPoolExecutor` —
**deadlocks**. `parallel()` branches occupy every worker slot, then each branch calls
`agent()` and blocks waiting for a slot that can never free, because the only threads
that could free one are the blocked branches themselves. This is the single most
important thing to get right, so the design inverts the relationship:

- **Threads are unbounded and cheap.** `parallel(thunks)` spawns one plain
  `threading.Thread` per branch and joins them. `pipeline(items, *stages)` spawns one
  thread per *item*, and that thread walks its stages in sequence.
- **A module-level `threading.Semaphore` caps real LLM concurrency**, acquired
  *inside* `agent()` — not by any pool. Default `min(16, cpu_count - 2)`, matching
  `subagents._pool_size`.

A branch thread parked on the semaphore costs a few KB of committed stack (Windows
reserves 1 MB but commits lazily), so hundreds are fine.

**Item cap: 256** per `parallel`/`pipeline` call. Exceeding it is an explicit error at
dry-run, not a silent truncation. If a workflow ever bounds coverage itself, it must
`log()` what it dropped.

**Wall-clock semantics.** `pipeline` has **no barrier between stages**: item A can be
in stage 3 while item B is still in stage 1. `parallel` *is* a barrier. This is the
whole reason both exist; the library favors `pipeline`.

### The sandbox

**Top-level `return`.** The agreed script form ends in `return {...}`, which is a
syntax error at Python module level. Handled by AST rewrite in `sandbox.py`:

1. `ast.parse(src)`.
2. Locate the module-level `meta = {…}` assignment and `ast.literal_eval` it. It must
   be a **pure literal** — no variables, calls, comprehensions, or f-strings — the
   same rule Claude Code's Workflow tool enforces, and for the same reason: `meta` is
   read for the progress UI and the library listing *before* the script runs.
   Required fields `name`, `description`; optional `when_to_use`, `phases`.
3. Wrap the remaining module body in a synthesized `def __workflow__():`,
   `ast.fix_missing_locations`, compile, exec, call. `return` is now legal and no
   fragile indentation rewriting happens.

Documented consequence: a nested `def` reassigning a top-level name needs `nonlocal`.
The authoring guide in the tool description says so, and the dry-run error message
names it when a script trips over it.

**Determinism guards.** Resume is worthless if replay can diverge, so the namespace
blocks `time`, `random`, `datetime.now`, `os.urandom` and friends, raising an
explicit error naming the fix ("pass timestamps in via `args`"). Imports are
whitelisted to `json`, `math`, `re`, `itertools`, `collections`, `textwrap`.

This is a **correctness** boundary, not a security one. The agent already executes
arbitrary shell through `host_exec`; pretending the sandbox is a security control
would be a lie that leads someone to trust it later.

**Namespace exposed to a script:**

| Name | Signature | Notes |
|---|---|---|
| `agent` | `agent(prompt, *, agent_type=None, label=None, phase=None, schema=None, model=None, tier=None, scope=None, context="")` | Blocks; returns text, or a validated dict when `schema` is given; `None` on failure. |
| `parallel` | `parallel(thunks) -> list` | Barrier. A thunk that raises resolves to `None`. |
| `pipeline` | `pipeline(items, *stages) -> list` | No barrier. Each stage gets `(prev, item, index)`. A raising stage drops that item to `None`. |
| `phase` | `phase(title)` | Starts a progress group. |
| `log` | `log(message)` | Narrator line above the progress tree. |
| `workflow` | `workflow(name_or_path, args=None)` | Nested run, one level deep. |
| `args` | value | Whatever the caller passed, verbatim. `None` if absent. |

Deliberately **absent**: `budget` (decision #5).

**Resolved details, so an implementer does not have to guess:**

- **`agent_type` omitted** → the `researcher` persona for a read call. There is no
  implicit write persona: a write agent must be named explicitly, which also means a
  script can never spawn a writer by accident.
- **`label` omitted** → the first 48 characters of the prompt, trimmed at a word
  boundary. Labels are display-only and never enter the journal key.
- **Return type** → `str` when no `schema` is given (the subagent's `report`), a
  validated `dict` when one is, `None` on failure in both cases.
- **Write detection at dry-run** → `agent_type` is resolved against
  `plugins.get_registry()` and its `AgentDef.is_write` consulted. An unknown
  `agent_type` is itself a dry-run failure, which catches typo'd persona names before
  the run rather than three stages in.
- **`phase()` vs `phase=`** → `phase()` mutates runtime-global state and is therefore
  only safe on the script's main thread. Inside a `parallel`/`pipeline` branch, two
  branches calling `phase()` would race and scramble each other's grouping, so
  branches must pass `phase=` on the `agent()` call instead. The runtime detects a
  `phase()` call from a non-main thread and raises with that explanation rather than
  producing a silently jumbled progress tree.

### Validation and dry-run — what makes model-authored scripts safe

Whatever model the user has configured must author correct Python on the first try,
and a bad lambda closure would otherwise waste a whole run. Before any token is spent:

1. `compile()` — syntax errors.
2. `meta` extraction — missing or non-literal `meta`.
3. **Dry-run**: the entire script executes with `agent()` returning a stub
   synthesized from its declared `schema` (and a short placeholder string when no
   schema is given) instead of calling an LLM. Every loop, comprehension, lambda
   closure, and dict access runs for free.
4. Workflow-specific policy checks, most importantly: **a write agent without
   `scope` is rejected here**, with a message telling it to declare its paths.

A script failing any step is returned to the model with the traceback and never
launched. Dry-run is also exposed directly as `run_workflow(dry_run=true)`.

Because the same schema walker generates stubs and validates real returns, dry-run
shapes match production shapes — the stub cannot lie about the contract.

### Structured output

`agent(prompt, schema=FINDINGS)` renders the schema into the subagent's contract
("your `final_answer` content MUST be JSON matching this schema"), then validates the
returned `content`. On mismatch the agent receives a repair message naming the
**specific** violations (path + expected + got) and retries; **3 attempts total**.
Persistent failure returns `None`, and scripts filter with
`[r for r in results if r]`.

The validator is a ~150-line dependency-free subset: `type` (object/array/string/
number/integer/boolean/null), `properties`, `required`, `items`, `enum`,
`additionalProperties`, `minItems`. `jsonschema` is deliberately **not** added —
`requirements.txt` documents why a portable lockfile is impractical here, and 7
pinned direct dependencies is worth protecting.

### Journal and resume

**Call keys are content-addressed, not positional:**

```
key = sha256(agent_type + "\x00" + prompt + "\x00" + canonical_json(opts))[:16]
occ = per-key occurrence counter   # loop-until-dry reissues identical prompts
```

Positional/ordinal keying is the tempting design and it is **wrong here**: with
`parallel` and `pipeline` there is no deterministic call order, so ordinals mis-key on
replay and a resumed run would restore the wrong results into the wrong branches.
Content addressing is order-independent, and it cascades correctly for free — a
changed upstream result changes the downstream prompt, which changes its key, which
re-runs it and everything derived from it.

**Run directory**, under the session's `memory_dir`:

```
<memory_dir>/workflows/<run_id>/
    script.py           the exact source that ran
    meta.json           extracted meta + args + start info
    journal.jsonl       one line per completed agent call
    agents/<sub_id>.jsonl   per-subagent transcript
    result.json         the workflow's return value
```

A journal line: `{key, occ, phase, label, agent_type, prompt_sha, ok, result, tokens,
elapsed_s, model}`. Appended and flushed per call, so a process killed mid-run still
resumes — which is the entire point for the hours-to-days runs this app targets.

**Resume**: `run_workflow(resume_from="<run_id>")` loads the journal into a replay
map; `agent()` checks `(key, occ)` first and returns the cached result instantly,
emitting `wf_agent_done` with `cached: true` so the progress tree shows it. Only
unmatched calls reach an LLM. Same script + same args = 100% cache hit.

**Documented caveat, surfaced at runtime.** Resume replays *agent results*, not
*workspace side effects*. If a write agent already edited files, replaying its cached
result does not re-apply the edit — normally correct, since the files are already
changed, but a resume after a `git checkout` would skip real work. `run_workflow`
warns when resuming a run that contained write agents.

### Nested workflows

`workflow(name_or_path, args)` runs inline, sharing the parent's semaphore, abort
flag, and run directory. Child journal keys are namespaced `name/<key>`, and its
agents appear under a `▸ name` group in the progress tree. **One level deep**: a
`workflow()` call inside a child raises, which bounds recursion without a depth
counter to tune.

### Abort

`workflows.abort()` sets a flag checked at every `agent()` entry and at each
`parallel`/`pipeline` stage boundary. In-flight subagents finish their current step
(they already honor `host_exec`'s stop check) and then unwind. The workflow returns
partial results with `aborted: true`, and the journal keeps everything completed —
so an aborted run is resumable.

### Live progress UI

Events ride the existing `subagents.ui_emit` sink, funneled through the
`_run_with_ui_telemetry` queue so the webview is still only ever poked from one
thread:

| Event | Payload |
|---|---|
| `workflow_started` | `run_id, name, description, phases, args_summary` |
| `wf_phase` | `run_id, title` |
| `wf_agent_started` | `run_id, sub_id, phase, label, agent_type, model` |
| `wf_agent_done` | `run_id, sub_id, ok, cached, tokens, elapsed_s` |
| `wf_log` | `run_id, message` |
| `workflow_done` | `run_id, ok, aborted, agent_count, elapsed_s, result_summary` |

Two surfaces:

1. **Inline chat card** — compact and collapsed by default: workflow name, phase
   pills, live counts (`Verify · 7 running · 12 done · 2 cached`), elapsed.
2. **A new "Workflow" tab** beside Chat / Plan / Knowledge Graph — the full phase
   tree, one row per agent with label, model, tokens and status, click-through to
   that agent's transcript, plus finished-run history so a completed run stays
   inspectable.

Both are built on the **existing** design tokens and inline SVG. When sub-project #4
(the Google restyle) lands they get retokenized, not rewritten.

### The model-facing tool

```
run_workflow(name=None, args=None, script=None, resume_from=None, dry_run=False)
```

- `name` — a library or saved workflow. The common path.
- `script` — ad-hoc source; always validated and dry-run first.
- `args` — passed through verbatim as the script's `args` global. Arrays/objects must
  be real JSON values, not JSON-encoded strings.
- `resume_from` — a prior `run_id`.
- `dry_run` — validate and exercise control flow without spending tokens.

Its description is built lazily at prompt-render time (the
`_dispatch_agents_description` pattern), listing each library workflow with its
`when_to_use`, so adding a library entry never requires touching a prompt.

Registered in a new `workflow` toolset alongside the existing domain toolsets, and
auto-activating on use like the others.

### Ultra mode

A per-project session flag `ultra`, persisted with the other session flags, settable
three ways: a header toggle in the UI, the keyword `ultra` in a user message (turns it
on for that turn), and an explicit request.

- **Off** — the system prompt tells the agent to orchestrate only when explicitly
  asked. `run_workflow` still works when the user names a workflow.
- **On** — the prompt tells it to default to a workflow for substantive tasks.

This is the guard against a casual question spawning fifteen agents and draining the
key pool.

---

## Built-in library (v1)

Six workflows, one per orchestration pattern, each dry-run tested in CI:

| Name | Shape |
|---|---|
| `review-changes` | dimensions → find (schema) → adversarial verify per finding. The canonical pipeline. |
| `understand-subsystem` | parallel readers over subsystems → structured map. |
| `deep-research` | multi-modal sweep → deep read → synthesize → completeness critic. |
| `exhaustive-audit` | loop-until-dry + perspective-diverse judge panel (distinct lenses, not N identical refuters). |
| `migrate` | discover sites → scoped write per site → verify. The write fan-out; every writer declares `scope`. |
| `design-panel` | N independent approaches → parallel judges → synthesis from the winner. |

`exhaustive-audit` deduplicates against **everything seen**, not against confirmed
findings — deduping against confirmed makes judge-rejected findings reappear every
round and the loop never converges.

---

## Testing

| File | Covers |
|---|---|
| `tests/test_workflow_sandbox.py` | AST wrap, top-level `return`, `meta` literal enforcement, determinism guards, import whitelist |
| `tests/test_workflow_runtime.py` | `parallel` barrier vs `pipeline` no-barrier semantics, error→`None` isolation, item cap, abort — against a fake `run_subagent` |
| `tests/test_workflow_schema.py` | validator subset, repair loop (3 attempts then `None`), stub generation matching validation |
| `tests/test_workflow_journal.py` | key stability under reordering, resume replay, cascade on changed upstream, crash-mid-run resume |
| `tests/test_workflow_library.py` | every built-in dry-runs clean |
| `tests/frontend/test_workflow_view.mjs` | progress tree renders from a recorded event stream |

**One test called out specifically — the deadlock regression guard:** a `pipeline`
whose every stage calls `parallel` of `agent`s, run with the semaphore pinned to 1.
That is precisely the failure the threads-plus-semaphore design exists to prevent, so
it gets a permanent guard rather than a comment.

All tests run offline against subagent doubles — no network, matching the existing
suite's discipline.

---

## Why `run_cmd` is the seam (note for sub-project #2)

Recorded here because it was discovered during this exploration and it shapes the
next spec: **`host_exec.run_cmd` is the single choke point for every tool.** Fourteen
tool modules shell through it, and `write_file` deliberately routes writes through it
rather than opening files directly (`tools/filesystem.py:109`). A transport swap at
`run_cmd` therefore takes essentially the entire ~106-tool surface remote at once,
instead of requiring remote variants per tool. Do not let anything in this workflow
work introduce a second execution path that bypasses it.

## Build order

1. `workflows/schema.py` — validator + stub generation (pure, no deps, easiest to test)
2. `workflows/sandbox.py` — AST wrap, meta, guards, namespace
3. `workflows/journal.py` — keys, write, replay
4. `workflows/runtime.py` — semaphore, `agent`/`parallel`/`pipeline`/`phase`/`log`, abort
5. `subagents.py` — `schema=` support on `run_subagent` via the repair loop
6. `workflows/library/` — the six built-ins, each dry-run tested as it lands
7. `tools/workflow_tools.py` — `run_workflow`, lazy description, `workflow` toolset
8. `agent.py` — the three touch points (ultra flag, prompt line, event sink)
9. Frontend — inline chat card, then the Workflow tab
10. `workflows/runtime.py` — nested `workflow()` last, once the single-level path is green
