# Large-Modification Scaling — design

Make the agent *eligible* for very large codebases and complex, multi-megabyte
modifications (e.g. injecting a complete Luau runtime, ~10 MB, thousands of
files) — not just the surgical ~hundreds-of-bytes webview/anti-tamper patch it
already does well.

## Problem

The framework already has strong context hygiene: an 80%-window
`summarize_memory` that resets to `HANDOFF.md`, `evict_old_tool_results`,
noisy-tool distillers, an evidence-first `investigation` memory that survives
resets, a live `plan` with phases, and parallel subagents. That is enough for a
short surgical job. It is **not** enough for a many-hour, many-subagent,
multi-artifact build, for three concrete reasons:

1. **No physical build accounting.** The only record of "what has actually been
   produced on disk" is prose: `investigation.modified_files` (capped at 12 in
   the prompt) and the free-text `HANDOFF.md` "Changed" section. Prose cannot
   answer, cheaply and reliably, *"of the 40 planned smali classes, how many are
   done? which offsets in libX are already patched? how many MB are built?"* At
   10 MB / hundreds of artifacts across dozens of summarizations, the agent
   loses track and re-does or skips work.

2. **Lossy telephone game across resets.** `summarize_memory` rebuilds
   `HANDOFF.md` from a message history that is itself already a post-reset
   compaction. Over a build that trips the 80% guard a dozen-plus times, the
   authoritative "what's built / what's owed" signal degrades because it is
   carried as prose, not structured state.

3. **Large artifacts round-trip through context.** `write_file(content=...)`
   passes the *entire* file body through the model's output tokens. A 200 KB
   generated smali family or a large table can't be authored in one call.
   `replace_in_file` helps for edits but still emits both strings.

## Goal

Add a durable, structured, **aggregate-first Build Ledger** that is the
authoritative manifest of a large change — components planned, artifacts
produced (path/bytes/sha), binary patches applied (target@offset), and
verifications run — that (a) survives every summarization exactly like
investigation memory, (b) folds a **bounded** view into the system prompt that
always states completion as numbers, (c) is written by the main agent *and*
subagents so parallel work merges into one source of truth, and (d) is
queryable so the agent answers "did I already patch X / is component Y done"
without re-reading files. Pair it with incremental large-file authoring so big
artifacts never round-trip through one context window.

## Non-goals (YAGNI)

- Not replacing investigation memory (reasoning/evidence) — the ledger is the
  complementary *physical build manifest*. Different bucket, different question.
- No new storage engine; JSON on disk in `memory_dir`, same as investigation.
- No automatic file-content diffing; the model records what it did.

## Design

### A. `ledger.py` (new module — mirrors `investigation.py`)

Module-level singleton `BuildLedger`, disk-persisted (`ledger.json`), notify
callback, `set_context/get_active/set_active/clear_active/ensure_active/load`.
Buckets (deduped upserts):

- `components` — planned build units: `{name, status, owner, bytes, note}`,
  status ∈ (planned, in_progress, done, blocked). The **progress spine**.
- `artifacts` — files produced: `{path, kind, bytes, sha, note}`, dedupe on path.
- `patches` — binary offset patches: `{target, offset, before, after, purpose}`,
  dedupe on `target@offset` (re-patching updates in place; the model can query
  "is this offset already patched" without re-diffing).
- `verifications` — checks run: `{name, outcome, details}`, outcome ∈
  (pass, fail, unknown), dedupe on name.

`to_markdown()` is **aggregate-first and bounded**: a header line of totals and
percent-complete, the full component worklist (bounded; incomplete-first when
large), an OPEN/REMAINING section (incomplete components + failing
verifications), and the last N artifacts/patches. It never dumps the full set —
that is on disk / in `to_dict()`.

`merge(other_dict)` folds a subagent's returned ledger delta into the
authoritative ledger via the same upserts.

### B. `tools/ledger_tools.py` (new — registered in `tools/__init__.py`)

`ledger_add_component`, `ledger_set_component_status`, `ledger_record_artifact`,
`ledger_record_patch`, `ledger_record_verification`, `ledger_status` (returns
the compact view + aggregates for a cheap "where am I" query). Subagents get
these too, so their output merges into the shared ledger.

### C. `append_to_file` (new tool in `tools/filesystem.py`)

Append UTF-8 text to a file (creating it if absent), size-verified like
`write_file`. Lets a big artifact be authored incrementally across many small
tool calls so no single call round-trips the whole payload through context.

### D. Wiring (`agent.py`)

- `import ledger`; in `start_session` wire `set_context` + resume `load`,
  mirroring investigation exactly.
- Fold `ledger.to_markdown()` into `_refresh_system_prompt` (below investigation)
  so it rides in the prompt and survives resets.
- `_on_ledger_update` notify bridge (mirrors `_on_investigation_update`).
- **Dynamic summary budget:** `_maybe_summarize_context` reads an optional
  `session["max_steps_before_summary"]` override (falls back to the constant),
  so a large build can run longer between resets when the ledger is carrying the
  durable state.

### E. Doctrine (`AGENTS.md`)

A "Large modifications" section: for a big multi-artifact change, first enumerate
components into the ledger, delegate bounded pieces to parallel subagents, record
every artifact/patch/verification into the ledger as you go, author large files
with `append_to_file`, and treat the ledger — not the transcript — as the source
of truth for "what's done / what's left."

## Testing (`tests/test_ledger.py`, offline, no Docker/LLM)

- upserts dedupe (component/artifact/patch/verification);
- `to_markdown` is bounded and states aggregates + percent complete + open items;
- round-trips through disk (`to_dict`/`from_dict`/`load`);
- `merge` folds a subagent delta without duplicating;
- ledger survives a simulated summarize (singleton outside messages);
- `append_to_file` builds a file incrementally and is size-verified.

## Config knobs

- `memory_dir/ledger.json` — persistence (auto).
- `session["max_steps_before_summary"]` — optional per-session override.
