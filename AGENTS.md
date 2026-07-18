## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

When the user types `/graphify`, use the installed graphify skill or instructions before doing anything else.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- Dirty graphify-out/ files are expected after hooks or incremental updates; dirty graph files are not a reason to skip graphify. Only skip graphify if the task is about stale or incorrect graph output, or the user explicitly says not to use it.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

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
- Fast, offline regression tests for this workflow (no Docker/network needed):
  ```
  python tests/test_investigation_memory.py
  python tests/test_reviewer.py
  python tests/test_review_gate.py
  python tests/test_tool_arg_validation.py
  python tests/test_autonomous_loop.py
  python tests/test_tool_limits.py
  ```
  (Tests under `tests/` that need Docker, a live LLM provider, or APK fixtures —
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
`tests/test_context_hygiene.py`, `tests/test_planning_superpowers.py`.
