# Omni-Agent framework upgrade — diagnosis & plan

Goal: cut context usage hard, make actions smarter, give the agent efficient
memory + knowledge-graph + planning for long (hours→days) APK-modding runs.
Model is fixed (GLM 5.2 primary, DeepSeek fallback) — the win must come from the
*framework*, not the model.

## Measured diagnosis (2026-07-14)

System prompt today (measured via `tool_registry.get_tool_prompt` +
`llm.get_full_system_prompt`):

| Part                         | chars   | ~tokens (4c/t) |
|------------------------------|---------|----------------|
| **Tool schemas (105 tools)** | 141,055 | **~35,300**    |
| Skills block                 | 6,263   | ~1,570         |
| Behavioral + intro           | 10,047  | ~2,510         |
| **FULL system prompt**       | 157,365 | **~39,300**    |

- The tool block is **90% of the system prompt** and is re-sent on **every**
  turn. On GLM's tokenizer (dense JSON/underscore-heavy schemas tokenize far
  worse than 4 chars/token) this is what makes the first message balloon toward
  the ~120k the user sees. A saved session's `system` message measured 165,734
  chars.
- Root cause of "actions aren't clever": **choice overload**. A mid-tier model
  picking 1 of 105 tools from 141k chars of overlapping descriptions (there are
  five+ near-duplicate byte-patch tools alone) makes worse choices than one
  shown a focused, relevant set.
- Tool results are capped at 8000 chars (stdout only) — OK, but they persist in
  history and only compact at 400 consecutive tool calls (very late).
- Many `[SYSTEM]` nudge messages accumulate in the transcript.

## The four fixes (priority order)

### 1. Progressive tool disclosure (biggest win) — DONE first
Split tools into a small always-on **core** + on-demand **domain toolsets**
(`apk`, `smali`, `native`, `emulator`, `frida`). Base prompt shows core tools in
full + a **one-line catalog** of everything else (name + purpose), grouped.
- The model can call ANY tool anytime — the registry still executes all 105.
- Calling a domain tool **auto-activates** that toolset, so its full schemas ride
  along on subsequent turns (usage-driven, zero new burden on the model).
- `expand_tools(group)` lets the model proactively pull a domain's full schemas.
- A malformed call to a domain tool returns **that tool's full schema** in the
  error, so the model self-corrects in one shot.
Expected base prompt: ~35k → ~7–9k tool tokens; mid-session (1–2 domains active)
~12–15k instead of a flat 35k. This is the "120k first message" fix.

### 2. Long-run memory (context editing)
- Evict/stub old tool results in the message history once they're N steps old and
  the finding they carried has been recorded — Anthropic-style "tool result
  clearing". Keeps overnight runs from dragging 100+ verbose results forever.
- Trim redundant behavioral prose (plan/evidence workflow is currently explained
  twice) and compress the verbose plan_/investigation_ tool schemas (their
  semantics already live in the behavioral block).

### 3. Knowledge graph — make the EXISTING one get used
The project already has a capable, auto-derived **code knowledge graph**
(`build_code_graph`/`query_code_graph`, backed by `_kg_indexer.py`/`_kg_query.py`:
classes, methods, call-edges, string-refs, native symbols). The real problem was
that the model *under-used* it: `query_type` was a required pick-one-of-ten, so a
wrong guess returned nothing and the model fell back to grep/read.
- Made `query_type` **optional**, defaulting to a new universal **`search`** that
  hits string literals + methods + classes + native symbols at once — so the model
  can just do `query_code_graph(name="isRooted")` / `query_code_graph(name="/system/
  xbin/su")` and get file:line hits without choosing an axis.
- A bare name (or an unrecognized `query_type` with a name) routes to `search`;
  empty/misdirected queries now return guidance instead of nothing.
- Rewrote the tool description to lead with copy-paste examples; pointed the
  behavioral prompt + the "reading files one-by-one" nudge at the simple call.
- (Reverted a wrong first attempt that added a *parallel* curated knowledge-graph
  subsystem — redundant with the existing graph and it would have been under-used
  for the same reason. The fix is usability of the one that exists.)

### 4. Tool audit / reimagining
- Collapse the overlapping byte-patch tools; remove or merge tools that cause
  misuse; tighten descriptions (also helps #1).
- Fold in the standard APK bypass workflow (Magisk DenyList, layered Java+native
  pinning, Frida hooks) confirmed by research.

## Safety
Every change is behind existing per-session flags where possible and validated
with the offline tests in `tests/`. `get_tool_prompt(active_groups=None)` keeps
its old full-render behavior so the reviewer/timeout sub-agents and existing
tests are unaffected.

## Status — DONE (2026-07-15)

All four fixes implemented and tested offline (test files green; new:
`test_progressive_tools`, `test_context_editing`, `test_prompt_integration`,
`test_code_graph_search`).

**Results**
- First-message system prompt: **~40,100 → ~17,600 tokens (57% cut)**. Mid-session
  it grows only by the 1–2 domain toolsets actually in use, instead of a flat 35k.
- Long-run history is bounded: stale tool results collapse to stubs
  (`evict_old_tool_results`), keeping the recent working set verbatim.
- The existing code knowledge graph is now usable by default: `query_code_graph`
  needs no `query_type` — a bare name searches strings+methods+classes+symbols and
  returns file:line hits, so the model reaches for it instead of grep/read.
- Behavioral prompt de-duplicated + APK-modding playbook added; confusable native
  patch/disasm tools got decision-guide catalog one-liners.
- Long-run plan stays compact: `Plan.to_markdown()` shows only the current phase's
  steps in the live prompt (`plan_view` shows all).

**Key files touched:** `tool_registry.py` (toolset model + catalog render),
`llm.py` (static/tools split + trimmed behavioral prompt + playbook), `agent.py`
(session `active_toolsets`/`context_editing`, `_refresh_system_prompt`
composition, usage-driven activation + schema self-correction, eviction),
`tools/_kg_query.py` + `tools/code_graph.py` (universal search default),
`planning.py` (compact current-phase render), new `tools/meta_tools.py`
(`expand_tools`).

**Not done (deliberately):** no tools were deleted — the overlapping byte-patch
tools are each referenced by shipped skills and progressive disclosure already
groups them under `native`, so deletion was higher risk than value. Confusion was
resolved via crisp catalog summaries instead.

**Config note (not a framework change):** `llm_config.json` runs GLM 5.2 with
`reasoning_effort:max` + `thinking`, DeepSeek V4 fallback — reasoning is on, and
`extract_json_action` strips `<think>` blocks before parsing, so max-reasoning is
safe. `max_tokens:16384` caps output; if tool-call JSON ever gets truncated after
a very long think, lowering effort to `high` is the lever (model/config, not code).

## Phase 6 — skills review + live plugin commands/hooks (2026-07-18)

Continuing the Phase 4/5 GSD capability layer. Reviewed the skill/plugin system,
closed real RE coverage gaps, and made two loaded-but-dead plugin subsystems live.

**Skills added (first-party, `skills/`)** — every one's `allowed-tools` resolves to real
registered tools (guarded by `tests/test_new_skills.py`):
- `frida-dynamic-instrumentation` (+ `reference/frida-recipes.md`) — the runtime
  hook/trace/confirm-then-bake-static workflow. Closed the biggest gap: the framework
  shipped frida tools + a native agent but no skill teaching the flow.
- `root-detection-bypass` (+ `reference/root-signals.md`) — su/props/RootBeer/Magisk/
  SafetyNet signals and the layered-patch discipline.
- `dynamic-unpacking` — recover the real DEX from packed apps (dump from memory/disk on
  the dev base, then analyze).
- `tool-usage` — meta-skill on wielding this agent's own arsenal (code-graph-first
  navigation, progressive disclosure, delegation, skills/commands, durable memory).

**Optimized skill calling** — de-hardcoded the skill-name enumerations baked into the
`list_skills`/`use_skill` tool descriptions (they rotted as skills were added); they now
point at the always-current `AVAILABLE SKILLS` index.

**Plugin commands — made live** (`tools/command_tools.py`,
`PluginRegistry.get_commands_prompt`, folded into `llm.get_static_system_prompt`).
Commands were parsed but never surfaced/executable. Now a plugin's `commands/*.md` show
as an `AVAILABLE COMMANDS` index and load on demand via `use_command` (distinct from the
core `run_command` shell tool). `/plan-feature` finally works, and two new commands ship:
`/verify-work` and `/re-triage` (the canonical end-to-end Android RE playbook).

**Plugin hooks — made live** (`agent.AgentApi._fire_plugin_hooks` + fire points for
`pre_tool` / `post_tool` / `on_phase_change` / `on_final_answer`). Hooks were parsed but
never fired. Now enabled plugins can steer the run with an advisory `{"inject": ...}` /
`{"note": ...}` return — bounded, never crash the loop, zero-cost no-op when no plugin
hooks an event. The `on_final_answer` gate can send an answer back for more work (bounded
by `MAX_FINAL_HOOK_NUDGES`).

**Plugins added** —
- `verification` (Superpowers `verification-before-completion` replica) — the first LIVE
  hook: an `on_final_answer` guard that catches a success claim (fixed/bypassed/works)
  with no objective check behind it — or a runtime-flagged unverified change — and sends
  it back to verify. Plus a read-only `verifier` subagent and the `/verify-work` command.
- `android-re` — the `/re-triage` command chaining the RE skills/agents/plan end-to-end.

**Key files touched:** `plugins.py` (commands prompt + `get_command`/`list_commands` +
`has_hooks` + command→plugin attribution), `tools/command_tools.py` (new), `tools/__init__.py`,
`llm.py` (commands index in prompt), `agent.py` (`_fire_plugin_hooks` + 4 fire points +
`MAX_FINAL_HOOK_NUDGES`), `tools/skill_tools.py` (de-hardcode). New tests:
`test_command_surface`, `test_plugin_hooks_wired`, `test_new_skills`.

**Safety:** every plugin subsystem is discovered/declared (a bad plugin is skipped, not
raised); hook firing is guarded by `plugins.has_hooks(event)` so setups without
hook-bearing plugins are byte-for-byte unaffected; all fire points are wrapped so a hook
can never break the loop. Offline test baseline stays green (the two full-suite failures,
`test_registration_binding` and `test_deep_build`, are pre-existing: cross-module test
dummies polluting the global registry, and a missing `tests/tools/_kg_indexer.py` — both
independent of this change, verified by running the guard alongside only these tests).
