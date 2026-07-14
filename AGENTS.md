## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

When the user types `/graphify`, use the installed graphify skill or instructions before doing anything else.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- Dirty graphify-out/ files are expected after hooks or incremental updates; dirty graph files are not a reason to skip graphify. Only skip graphify if the task is about stale or incorrect graph output, or the user explicitly says not to use it.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

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
