## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

When the user types `/graphify`, use the installed graphify skill or instructions before doing anything else.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- Dirty graphify-out/ files are expected after hooks or incremental updates; dirty graph files are not a reason to skip graphify. Only skip graphify if the task is about stale or incorrect graph output, or the user explicitly says not to use it.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

## Execution model: real paths on the real machine

Tools run **directly on the user's machine**, in the user's project folder, the
way a person would run them in a terminal opened there. `host_exec.py` is the
single entry point every tool shells through.

There is no container, no virtual filesystem root, and no path rewriting. Two
earlier designs had one — first Docker, then a "host sandbox" that faked a
`/workspace` root via a symlink — and both were removed because the translation
layer between *what the tool wrote* and *what actually ran* is where the bugs
lived. It produced failures that looked like nothing at all: `find /workspace`
returning zero files with exit code 0, scripts opening a root that did not exist,
the user's home directory leaking into the model's context.

What replaced it:

- **cwd is the project folder.** `run_cmd` sets it, so a relative path in a
  command means what it says. `run_command` needs no `cd` prologue.
- **Paths are shell-quoted** via `tools.common.wpath`. Real project folders
  contain spaces (this app lives in `~/Desktop/Omni Apps/`), and an unquoted path
  silently splits one argument into several — which surfaces as a confusing "No
  such file", not as a quoting error. `wpath` is for command ARGUMENTS only:
  result messages and `echo` text take the plain path, or the quotes end up in
  the model's transcript.
- **`normalize_path` still accepts a legacy `/workspace/...` prefix** and strips
  it. That convention outlives the container in old transcripts and in the
  model's habits; accepting it costs one comparison, rejecting it would turn a
  cosmetic mismatch into a failed tool call.

Guards live in `tests/test_host_exec.py`, and every path test runs twice — once
against a folder whose path contains a space.

**Portability.** Tool commands are POSIX shell with GNU-style options, so a POSIX
shell is required everywhere: `/bin/sh` on macOS/Linux, and on Windows the
`bash.exe` from Git for Windows / MSYS2 / WSL (cmd.exe and PowerShell cannot
interpret these commands, so `host_exec` detects the shell and says so plainly
rather than emitting thousands of syntax errors). The GNU userland is put first
on PATH for tool commands only — never the user's own shell — because the
commands use `sha256sum`, `stat -c`, `sed -i`, `grep -P`, `find -printf`, which
BSD/macOS userland rejects.

**The machine has to have the toolchain.** `scripts/install_tools.py` installs
it (idempotent; `--check` reports without changing anything) via Homebrew, apt/
dnf/pacman/zypper, or winget/choco as appropriate: JDK 21, apktool, jadx,
radare2, Ghidra, LLVM/binutils, Android build-tools, APKEditor, and the
baksmali/smali wrappers built from `shims/*.java`. Wrappers land in
`~/.omni-agent/bin`, which `host_exec` puts first on PATH. `set_workspace()`
reports anything missing when the project opens, instead of letting it surface as
"command not found" mid-task.

Three pins are load-bearing and will look like staleness to a future reader. All
three were found by running the tools, not by reading code:

- **Ghidra is pinned to 11.3.2.** `ghidra_decompile` drives Ghidra through
  `tools/_ghidra_decompile.py`, a *Jython* post-script. Ghidra 12 dropped bundled
  Jython for PyGhidra, so on 12.x analysis succeeds and then the script dies with
  "Ghidra was not started with PyGhidra" — yielding no output at all. Bumping the
  version requires porting that script first.
- **A separate apktool 2.9.3 jar backs the baksmali/smali shims.** apktool 3.x
  ships a minimized shaded jar that keeps `Baksmali` but strips `DexFileFactory`,
  `Opcodes`, `MultiDexContainer` and `SmaliMod` — the exact entry points
  `shims/*.java` call. The packaged apktool is still what decode/recompile use;
  only the shim classpath is pinned.
- **Ghidra's project cache lives outside the project folder** (see
  `_ghidra_project_root`). Ghidra refuses any path containing a dot-prefixed
  element, which rules out the old `.ghidra_proj` and any project that happens to
  sit under a hidden directory.

The tool cache (`tools/cache.py`) is global and keyed on file BYTES, so its
`_CACHE_VERSION` had to be bumped: entries written when tools reported a
`/workspace` root would otherwise be replayed verbatim into the model's context,
handing it paths that no longer resolve.

## Context & memory architecture (2026-07 upgrade)

Built to keep an hours-to-days run cheap and focused on a fixed model (GLM 5.2 +
DeepSeek fallback). See `FRAMEWORK_UPGRADE.md` for the full diagnosis.

**Progressive tool disclosure** (`tool_registry.py`, `tools/meta_tools.py`) — the
106 tools are split into always-on **core** + on-demand **domain toolsets**
(`apk`, `smali`, `native`, `emulator`, `frida`, `graph`, `web`). The prompt shows
core tools in full plus a one-line catalog of the rest; a domain tool still runs
if called and **auto-activates** its toolset, and `expand_tools()` loads one
proactively. This cut the first-message system prompt from ~39k to ~17k tokens
without hiding any capability. `get_tool_prompt(active_groups=None)` keeps the
legacy full render for isolated sub-agents/tests. The active set is persisted per
session and re-armed on use.

**Long-run context editing** (`agent.evict_old_tool_results`) — old, large
`TOOL RESULT` messages collapse to short stubs once past a recent-keep window, so
history stays lean between summaries (the plan + investigation + knowledge graph
retain what mattered). Toggle via the session `context_editing` flag.

**Build Ledger** (`ledger.py`, `tools/ledger_tools.py`) — the physical manifest
of a large, multi-artifact modification, kept separate from investigation memory
(which records *reasoning*). The ledger records the *build accounting*:
components planned vs done, files produced (path/bytes/sha), binary offsets
patched (keyed `target@offset`, deduped), and verifications (pass/fail). Its
prompt view is **aggregate-first and bounded** — it leads with completion as
numbers (`3/7 components done (43%) | artifacts: 12 files, 4.3 MB | patches: 5 |
verify: 2 pass / 1 fail`) and an OPEN/REMAINING worklist, and never dumps the
full set no matter how many artifacts a 10 MB build produces. It is a
module-level singleton persisted to `memory_dir/ledger.json`, folded into the
system prompt in `_refresh_system_prompt`, and **SURVIVES summarization/reset**
exactly like the plan and investigation memory, so a many-hour / many-subagent
build never loses track of what's built or what remains. `merge()` folds a
subagent's returned build delta into the authoritative ledger without
duplicating. This is what makes the agent *eligible* for very large modifications
— it answers "did I already patch this offset / is component Y done / how many MB
are built" from structured state instead of re-reading a 100 MB library or
trusting lossy prose. Write with `ledger_add_component` /
`ledger_set_component_status` / `ledger_record_artifact` / `ledger_record_patch`
/ `ledger_record_verification`; read the compact "where am I" view with
`ledger_status`. Offline tests: `tests/test_ledger.py`.

### Large modifications (10 MB+ / thousands of files)

For a very large change (e.g. injecting a complete Luau runtime, ~10 MB) the
build only stays coherent if durable structured state — not the transcript — is
the source of truth. The doctrine:

1. **Enumerate first.** Break the build into components in the Build Ledger
   (`ledger_add_component`) before touching code, so progress is countable.
2. **Fan out — including the writes.** Delegate bounded, independent components to
   parallel subagents (`dispatch_agents` / `run_subagents_parallel`); each returns a
   *distilled* report, and its build delta merges into the shared ledger. Cut the
   work by **ownership** and give every change step a `scope`, so disjoint writers
   build concurrently instead of queueing (see *Parallel execution & scoped
   writes*). Keep the orchestrator's own context lean.
3. **Record as you go.** After producing a file, patching an offset, or finishing
   a component, log it to the ledger immediately — that record, not the raw tool
   output (which is stubbed/evicted), is what survives the next reset.
4. **Author big files incrementally.** Never round-trip a large generated
   artifact through `write_file` (its whole body burns output tokens and caps
   out). Build it with `append_to_file` across many small, size-verified appends,
   or generate it with a script run via `run_command`.
5. **Read narrow.** In a huge decompiled tree, orient with the code graph
   (`build_code_graph` / `query_code_graph`) and page with `read_file_chunk`;
   let noisy-tool distillers keep logcat/build output out of context.
6. **Run longer between resets when safe.** A build carrying full state in the
   plan + investigation + ledger can raise `session["max_steps_before_summary"]`;
   the token/char pressure guard is still the hard ceiling.

**Code knowledge graph usability** (`tools/code_graph.py`, `tools/_kg_query.py`)
— the existing auto-derived code graph (`build_code_graph`/`query_code_graph`)
was capable but under-used because `query_type` was a required pick-one-of-ten.
`query_type` is now optional and defaults to a universal `search` across
classes + methods + strings, so the model can throw any identifier at it and get
file:line hits; empty/misdirected queries return guidance instead of nothing.

**Tighter behavioral prompt** — the plan/evidence guidance was de-duplicated and
an APK-modding playbook (decode → map → understand → patch smallest → rebuild →
verify; expect layered Java+native protections; confirm with frida before a
static patch) added, so a mid-tier model makes cleverer tool choices.

**Strategic Brief** (`strategy.py`, `tools/strategy_tools.py`) — a synthesized,
always-pinned thesis (goal / protection diagnosis with evidence / chosen strategy
+ rationale / rejected alternatives / top hypothesis / kill-criteria) that shapes
decisions where the passive plan + investigation memory did not. The model authors
it with `strategy_set` / `strategy_update`; it pins at the TOP of the system prompt
(above the plan and investigation memory). A diagnosis-phase gate blocks *mutating*
tools until a complete brief passes one independent **strategy review**
(`tools/reviewer.run_strategy_review`, reusing the reviewer engine); reads are never
gated. Phase advances and every Nth finding nudge a reconcile; a stall reminds of the
brief's kill-criteria. It is single-writer orchestrator state — subagents get only a
two-line read-only slice (chosen strategy + top hypothesis) and never the `strategy_*`
tools (they're in `tool_policy.SUBAGENT_EXCLUDED`), so parallel waves are unaffected.
Behind `strategy_brief_enabled` (default on); off is byte-identical to a pre-feature
build. Offline tests: `tests/test_strategy_*.py`.

## Workflow engine (2026-08 upgrade)

`workflows/` gives the orchestrator deterministic multi-agent control flow: a
workflow is a sandboxed Python script that fans subagents across phases, pipes
each item through stages, and resumes from a journal. `run_workflow` is the
model-facing entry; the six built-ins in `workflows/library/` are the common
path, and an authored `script` is the escape hatch.

Three decisions are load-bearing and will look arbitrary to a future reader:

- **Threads plus a semaphore, never a thread pool.** Submitting every `agent()`
  to one shared `ThreadPoolExecutor` DEADLOCKS: `parallel()` branches occupy
  every slot, then each calls `agent()` and waits for a slot only those blocked
  branches could free. So threads are unbounded (one per branch/item) and a
  semaphore inside `agent()` caps real LLM concurrency. The guard is
  `test_nested_parallel_inside_pipeline_does_not_deadlock_at_concurrency_one`.
- **Journal keys are content-addressed, not positional.** `parallel`/`pipeline`
  have no deterministic call ORDER, so an ordinal key restores the wrong cached
  result into the wrong branch on resume. Hashing (agent_type, prompt, opts) is
  order-independent and cascades correctly: a changed upstream result changes the
  downstream prompt, changes its key, and re-runs everything derived from it.
- **Every script is dry-run before it costs anything.** `agent()` returns
  schema-shaped stubs while the whole script executes, so `KeyError`s, late-bound
  lambdas and unscoped write agents surface for free rather than three stages in.
  This is what makes model-authored orchestration safe enough to allow.

`time`, `random` and `datetime` are unavailable inside a script — replay
determinism requires it; pass timestamps in via `args`. The sandbox is a
CORRECTNESS boundary, not a security one: the agent already runs arbitrary shell
through `host_exec`.

**Resume replays agent RESULTS, not workspace side effects.** Files a write agent
already changed stay changed and its work is not re-applied. `run_workflow` warns
when the resumed run contained writers.

Write agents are allowed inside a workflow but MUST declare `scope=[...]`;
`ScopedWorkspaceLock` then serializes only overlapping owners, so disjoint edits
genuinely run at once. An unscoped writer takes the whole workspace and would
silently serialize an entire fan-out, so it is rejected at dry-run.

A workflow can call another workflow inline via `workflow(name_or_path, args=)`
(`WorkflowRuntime.workflow` in `workflows/runtime.py`) — the child shares the
parent's semaphore, abort flag, journal and run directory rather than opening a
second concurrency budget, so a nested call cannot double the fleet. Nesting is
capped at exactly ONE level (a flat rule, not a depth counter to tune): a child's
`depth` starts at 1, and `workflow()` refuses to run when `depth >= 1`. The
child's journal keys are namespaced by its own name so an identical prompt in
parent and child cannot collide on replay, and its `agent_count` folds back into
the parent's in a `finally` so the total is never undercounted.

Ultra mode (`session["ultra"]`) gates autonomous orchestration: off, the agent
must be asked; on, it defaults to a workflow for substantive tasks. The keyword
`ultra` in a user message turns it on.

## Evidence-based workflow (planner → worker → reviewer)

The agent loop (`agent.AgentApi._run_agent_loop`) runs one model that plays three
disciplined roles, backed by durable structured state. Nothing here forks extra
model processes — it reuses the same provider/key via `llm.ask_llm`, and every
new behavior is gated by a per-session flag so lightweight/test sessions are
unaffected.

**Planner** — the live plan (`planning.py`, `tools/plan_tools.py`) decomposes a
task into small, *verifiable* steps. The system prompt requires each step to have
a "done when…" check. The plan is folded into the system prompt in real time and
survives context resets.

**Worker** — the loop executes one plan step at a time. Tool calls are validated
against each tool's real signature before running (`tool_registry.ToolRegistry.
_validate_args`), so a hallucinated/missing argument returns an actionable message
instead of an opaque `TypeError`. The main-loop sampling temperature is lowered
(`agent.MAIN_LOOP_TEMPERATURE = 0.3`) for steadier technical output; a
per-provider `temperature` in `llm_config.json` still overrides it.

**Reviewer** — when the worker emits a `final_answer`, an *independent* reviewer
(`tools/reviewer.run_review`) runs in a separate isolated context (same model/key,
read-only tools) and checks the conclusion for unsupported claims, contradictions
(it actively tries to disprove it), and incomplete/unverified work. On **revise**
the loop injects the reviewer's specific feedback and continues (the worker fixes
the gaps, then answers again); on **approve** the answer is accepted. Bounded by
`agent.MAX_REVIEW_ROUNDS` (default 2) so it can never deadlock. The worker can
also call `review_conclusion` itself to pressure-test an intermediate result.

**Evidence & investigation memory** (`investigation.py`,
`tools/investigation_tools.py`) — a structured, deduplicated, evidence-first
record separate from the raw transcript: confirmed findings (evidence required),
hypotheses (confidence + evidence, later confirmed/refuted), failed attempts,
decisions, modified files, open questions, test results, next steps. It's folded
into the system prompt and persisted to `investigation.json` in the project's
memory dir, so it **survives a context-window summarization/reset intact**.

**Guards** —
- *Repeat-failure guard*: an identical `(tool, args)` call that already failed
  earlier in the run is skipped once with a nudge (reconsider or bring new
  evidence) instead of being blindly re-run.
- *Validation gate*: a tool that mutates the workspace (`agent.MUTATING_TOOLS`)
  marks the change UNVERIFIED and nudges toward an objective check; a validation
  tool (`agent.VALIDATION_TOOLS`) or a recorded passing test clears it. Modified
  files are auto-recorded into investigation memory.

### Configuration knobs
- `agent.MAIN_LOOP_TEMPERATURE` — main-loop sampling temperature (default `0.3`).
- `agent.REVIEW_ENABLED_DEFAULT` — auto-review every final answer (default `True`).
- `agent.MAX_REVIEW_ROUNDS` — max revise rounds before accepting (default `2`).
- `agent.REVIEW_MAX_STEPS` — reviewer verification tool-call budget (default `8`).
- Per-provider `temperature` / `reasoning_effort` in `llm_config.json` still apply
  and override the loop default (see `llm.PROVIDERS` / `_openai_request`).

### Running / testing
- Launch the app: `python agent.py` (pywebview desktop UI).
- Fast, offline regression tests for this workflow (no network or RE toolchain needed):
  ```
  python tests/test_investigation_memory.py
  python tests/test_reviewer.py
  python tests/test_review_gate.py
  python tests/test_tool_arg_validation.py
  python tests/test_autonomous_loop.py
  python tests/test_tool_limits.py
  ```
  (Tests under `tests/` that need the host RE toolchain, a live LLM provider, or APK fixtures —
  e.g. `test_code_graph`, `test_llm_live`, `test_abi_contract` — are environment
  dependent and unrelated to this workflow.)

## Skills, plugins & delegation (Claude-Code-style capability layer)

Capability is **discovered from disk and declared**, not hard-coded into the tool
registry — so the base prompt stays small and the surface grows without edits to the
106-tool core.

**Skills** (`skills_loader.py`, `tools/skill_tools.py`, `skills/<name>/SKILL.md`) —
detailed, battle-tested workflows under progressive disclosure. The prompt shows only a
lightweight index (name + description + when-to-use + resource filenames); `use_skill`
pulls one skill's full body and **auto-activates its toolsets** (the tools it names
arrive with full schemas next turn), and `read_skill_resource` pulls a bundled
`reference/` file on demand. A skill's `allowed-tools` frontmatter both drives that
toolset activation and is checked against the live registry (`skill_tool_issues`) so a
typo surfaces instead of silently doing nothing. First-party skills cover APK modding,
smali/native patching, the bypasses (SSL, root, signature, anti-debug), Frida dynamic
instrumentation, string deobfuscation, dynamic unpacking of packed apps, dex/multidex,
manifest/resource editing, code-graph navigation, project scaffolding, and a
`tool-usage` meta-skill on wielding this agent's own arsenal.

**Plugins** (`plugins.py`, `plugins/<name>/`) — self-contained capability bundles
declaring any mix of: `plugin.json` (manifest, `enabled` toggled via `llm_config.json`'s
`plugins` map), `agents/*.md` (subagent personas), `skills/<name>/SKILL.md` (extra
skills merged into the index), `commands/*.md` (named workflows), and
`hooks/hooks.json` (lifecycle callbacks). A broken plugin is skipped with its error in
`.issues`, never raised. Shipped plugins: `omni-agents` (researcher / native-analyst /
implementer delegation personas), `planning-superpowers` (deep-planning skill + architect
/ brainstormer agents + `/plan-feature`), `gsd` (context-hygiene skill), `verification`
(verify-before-completion skill + verifier agent + `/verify-work` + a live on_final_answer
hook), and `android-re` (`/re-triage` end-to-end RE playbook).

**Subagents & delegation** (`subagents.py`, `tools/delegation_tools.py`) — the GSD
"fresh context per task" primitive: a persona runs in its OWN isolated conversation over
a mode-filtered tool surface (READ agents fan out in parallel; WRITE agents serialize
behind a workspace lock) and returns only a distilled report, so the orchestrator's
context never accumulates the sub-work. Two paths: a plan step tagged `delegate="<agent>"`
(auto-dispatched when marked in_progress) and `dispatch_agents([...])` for an ad-hoc
parallel read-only wave.

**Subagent model routing** (`llm.model_ladder`, `subagents.resolve_model_ladder`) — cost-aware
model selection layered on top of delegation. Ladder position IS cost: the provider order
(drag to reorder in LLM Settings) and the model order within a provider, flattened
most-expensive-first by `llm.model_ladder()`. Each model's tier is either an explicit tag
(`model_settings[<model>].tier`, set in the per-model ⚙ panel) or derived from position (top
rung `premium`, bottom rung `cheap`, everything between `standard`) — **a tagged model never
changes tier when providers/models are added or reordered**, only untagged models drift.
Tier names are open strings; the three builtins are advertised but a custom tier works with no
code change. Selection precedence, highest first: call `models` > call `tier` > agent `.md`
frontmatter `models` > frontmatter `tier` > `llm.DEFAULT_SUBAGENT_TIER` (`standard`). Routing
paths: a plan step (`delegate="researcher@cheap"`), a `dispatch_agents` spec (`"tier": "cheap"`
or `"models": [...]`), or a persona default (`tier:` in the agent's `.md` frontmatter). A
subagent's ladder always ends with the higher rungs appended as a last-resort tail, so it can
escalate rather than fail when everything at/below its tier is down; `subagents.escalate_ladder`
also steps a subagent ONE rung up after 2 consecutive JSON-protocol parse errors (at most once
per run — the existing 3-error salvage backstop still applies). Two bounded nudges push more
delegation: a solo-read streak in the orchestrator's own context (`OMNI_SOLO_READ_NUDGE`,
default 6, `0` disables) and a plan-shape check that flags 2+ untagged independent research
steps in the same phase. Both fire at most once per streak/phase. The solo-read streak nudge
has TEETH: when it trips it also runs the auto-tag + fan-out pass (`_maybe_dispatch_delegated_steps`),
so a long inline-read run that never touches the plan still gets its ready research/change
steps dispatched as a real wave — not just an advisory line. It's a no-op when no plan/step
qualifies (pure free-exploration stays advisory-only, since the harness can't author sub-tasks
with no plan). Dispatch otherwise only rides on a `plan_*` tool call.

**Spending premium** — the premium model is a SCARCE resource (usage limits) and
you (the orchestrator) run on a cheap model, so you decide when premium is worth
it by tagging a step or dispatch `@premium` (e.g. `delegate="engineer@premium"`,
or `"tier":"premium"` in `dispatch_agents`). A live `[premium budget: N/M ...]`
line shows what you have spent; over-budget `@premium` requests degrade to
standard automatically, so do not hoard — but do not waste it either.

Spend premium ONLY when at least one holds:
- the change is cross-cutting / multi-file with non-obvious interactions;
- a standard attempt already failed or was reverted;
- the decision is high-stakes and hard to reverse;
- correctness is subtle (concurrency, security, protocol/format edge cases).

Do NOT spend premium for: research, reads, search, summarization, mechanical or
localized edits, formatting, or anything a standard attempt has not yet been
given a shot at. Default is cheap; when unsure, try standard first and escalate
only on evidence it is insufficient.

**Using the full roster** — do not route everything to researcher + implementer:
- `engineer@<tier>` for general (non-RE) source edits; `@premium` for complex ones.
- `debugger@premium` for a stubborn failure a standard attempt already missed.
- `consultant@premium` when you face ONE hard decision — ask it, then act on the
  recommendation. This is the sanctioned way to get expensive reasoning into an
  otherwise-cheap run; judgment steps are still not auto-delegated.
- `brainstormer` / `architect` when a goal is big or ambiguous, BEFORE planning.
- `verifier` after a completion claim (the verification plugin also triggers it).

**Commands** (`tools/command_tools.py`) — a plugin's `commands/*.md` are surfaced as an
`AVAILABLE COMMANDS` index and loaded on demand with `use_command` (the workflow-loader;
distinct from the core `run_command` shell tool). A command is broader than a skill — it
orchestrates skills, subagents, and the plan end-to-end.

**Plugin hooks** (`agent.AgentApi._fire_plugin_hooks`) — enabled plugins can register
`pre_tool` / `post_tool` / `on_phase_change` / `on_final_answer` callbacks, fired live in
the run loop with durable runtime signals. Hooks are **advisory and bounded**: a hook may
return `{"inject": ...}` (a `[PLUGIN]` steering message the model sees next turn) or
`{"note": ...}` (a user-only line); they never crash the loop and are a zero-cost no-op
when no plugin hooks an event. The `on_final_answer` gate can send an answer back for more
work (bounded by `agent.MAX_FINAL_HOOK_NUDGES`), which is how the `verification` plugin
catches an unverified success claim before "done".

Offline tests: `tests/test_plugins.py`, `tests/test_subagents.py`,
`tests/test_delegation.py`, `tests/test_skill_toolsets.py`, `tests/test_new_skills.py`,
`tests/test_command_surface.py`, `tests/test_plugin_hooks_wired.py`,
`tests/test_context_hygiene.py`, `tests/test_planning_superpowers.py`,
`tests/test_model_ladder.py`, `tests/test_subagent_routing.py`,
`tests/test_delegation_nudges.py`, `tests/test_agent_delegation_wave.py`.

## Superpowers Mode (auto-brainstorm + subagent-driven-by-default)

A "just build it well, don't ask me" layer that wires the personas above to fire
**automatically** on a new task, so quality workflows don't depend on the
orchestrator remembering to reach for them. It reuses existing primitives — no new
personas, no new hook events. Behind `superpowers_enabled` (default on, env
`OMNI_SUPERPOWERS=0` disables); **OFF is byte-identical to a pre-feature build**.
Store + pure classifiers live in `superpowers.py` (sibling of `strategy.py` /
`planning.py`); the gates live in `agent.py`.

**Auto-brainstorm gate** (`agent._maybe_run_brainstorm_gate`) — the FIRST thing on
a genuinely new, **non-trivial** task (before the strategy/plan gates). It runs the
`brainstormer` persona synchronously with an **autonomy override**: it must NOT
defer to the user or emit OPEN QUESTIONS — it resolves each into a labeled
ASSUMPTION and picks ONE approach. The distilled result is parsed into a
**Design Brief** (`superpowers.DesignBrief`: clarified goal / chosen approach +
rationale / rejected alternatives / assumptions / risks), stored to
`<memory_dir>/design_brief.json`, and **pinned into the system prompt** just below
the Strategic Brief so the plan is built against it. Fires **once per task** (clears
its own `needs_brainstorm` up front), never blocks reads, and never raises — any
failure (missing persona, subagent error, unparseable report) degrades to an
**inline self-brainstorm** steering message instead. The brainstormer is
`tier: premium`, so it obeys the existing premium budget/degrade path.

**Architect gate** (`agent._maybe_run_architect_gate`) — runs immediately after the
brainstorm, before any planning. The orchestrator plans from whatever it happens to
have read, under its own context pressure, and reliably produces a **serial** list;
a serial plan then executes serially no matter how much parallel machinery sits
underneath it. So the `architect` persona (read-only, premium, inspects freely in
its own context) designs the plan instead and answers with a **JSON plan proposal**
in the plan's own vocabulary — phases, plus first-phase steps carrying
`delegate` / `depends_on` / `scope`, plus `components` for a multi-artifact build.
`superpowers.parse_plan_proposal` parses it and `_install_proposed_plan` installs it
as the live plan (seeding the ledger's components), so the parallel shape survives
into execution instead of being flattened by re-transcription. Fires **once per
task**, never in inline-only mode, and degrades at every step — no persona, a failed
run, or a prose answer all fall back to the orchestrator planning for itself (a
prose proposal is still handed over as text). Tests: `tests/test_architect_gate.py`.

**Subagent-driven execution by default** — when superpowers is on (and not
inline-only), the auto-delegate read floor drops from 2 to **1**
(`_auto_delegate_untagged_steps`), so even a lone independent research step fans out
to a subagent. Delegation becomes the normal path, not a threshold nudge. Explicit
`delegate=` tags are unchanged. Writes no longer serialize globally — see
**Parallel execution & scoped writes** below.

**Inline-only override** — `superpowers.detect_inline_only(text)` matches only
CLEAR phrasings ("inline only", "no subagents", "don't delegate", "do it yourself"),
setting a per-task `inline_only` flag. Effect: auto-tagging/auto-dispatch is
suppressed (execution stays in the orchestrator's context) and the auto-brainstorm
runs **inline** instead of dispatching a subagent. A passing mention of the word
"inline" does not trip it.

**Triviality escape** — `superpowers.is_trivial_task(text)` fails safe (unsure →
non-trivial): only short single-edit requests (rename/typo/one-line/bump/format)
skip the pipeline and run inline as before.

**Verify before done** — no new code; the `verification` plugin's `on_final_answer`
hook already sends an unverified completion claim back for a verifier pass.

Design spec: `docs/superpowers/specs/2026-07-27-superpowers-mode-design.md`.
Offline tests: `tests/test_superpowers.py`.

## Parallel execution & scoped writes

The plan is the parallelism primitive: **steps with no `depends_on` run at the same
time**, so the *width* of a phase largely decides how long a job takes. Phases are
dependency STAGES, not a to-do list.

**Plan wide, not long.** `plan_create` / `plan_replan` / `plan_add_tasks` all accept
full step objects (`delegate`, `depends_on`, `scope`, plus the evidence fields), and
a step may carry a local `key` that its siblings name in `depends_on` — so one call
can lay out a whole wave *and* its internal dependency graph before any id exists.
`plan_add_tasks` is the batch path: adding 30 steps one at a time costs 30 LLM
round-trips and yields a plan the harness can only run serially. `Plan.ready_steps()`
computes what may start right now, and `to_markdown()` prints it ("Ready NOW —
independent, may run concurrently"), calling out ready steps that carry no delegate.

**Scoped concurrent writes** (`subagents.ScopedWorkspaceLock`) — a write step
declares the workspace paths it owns (`scope: ["smali/com/foo/**"]`). Writers with
**disjoint** scopes run genuinely concurrently; overlapping ones queue; a write step
with **no** scope claims the whole workspace exclusively (the old behavior, still the
safe default). Overlap is computed by reducing each pattern to its literal prefix and
comparing at segment boundaries — deliberately *over*-approximating, so it may report
a collision that could not really happen but never misses one. The queue is fair, so
an exclusive writer can't be starved by a stream of scoped ones. `agent.py` routes
reads *and* scoped writes into one `_run_delegated_wave`; unscoped writes stay on the
serial path. For a large multi-package change, cut the work by **ownership** (one
step per package / `.so` / module, each scoped) so the pieces build in parallel.

**Long-running build subagents** — `MAX_STEPS_CAP` is 120 (env
`OMNI_SUBAGENT_MAX_STEPS_CAP`), sized for incremental authoring rather than lookups.
Crossing `CONTEXT_CHAR_LIMIT` no longer forces an immediate answer: the sub-run
**compacts** its own transcript (system prompt + task + recent tail kept, middle
elided with a "don't redo that work" marker) up to `OMNI_SUBAGENT_COMPACTIONS`
(default 4) times, because a build subagent's real output is on disk and in the
ledger, not in its messages. Once that budget is spent the original force-final
behavior remains.

**Multi-phase completion** — `Plan.is_complete()` is false while any phase is still
pending, so finishing phase 1 of 5 of a long build is no longer mistaken for
finishing the task (which previously made the next user message start a brand-new
task, re-brainstormed and re-planned). An explicit `plan_set_outcome "completed"`
still wins, and the final-answer gate already requires one.

Offline tests: `tests/test_plan_parallel_shape.py`, `tests/test_scoped_writes.py`,
`tests/test_large_build_budget.py`.
