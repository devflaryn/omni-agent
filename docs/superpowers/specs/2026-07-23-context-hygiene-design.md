# Context Hygiene: Noisy-Output Distillation + Vision Cache — Design

**Date:** 2026-07-23
**Status:** Approved design, ready for implementation planning
**Scope:** Keep large/redundant tool output out of the main conversation. Two independent components: (A) curated noisy tools get distilled (summary into chat, full raw to a file); (B) byte-identical screenshots reuse a cached vision analysis instead of re-calling the vision model.

This is the deferred follow-up to the parallelism work (see `2026-07-23-genuine-parallelism-visibility-design.md`). It reuses that project's `subagents.py` engine for the LLM fallback summarizer.

## Problem

1. **Every tool result is blind-truncated at 8000 chars** in the main loop (`agent.py` ~line 794) and the truncated text stays in the conversation permanently. For noisy tools like `get_logcat` (up to 300 raw lines of mostly-irrelevant system spam), this both (a) floods context with noise and (b) can silently drop the one crash line that mattered past the 8000-char cut.
2. **Byte-identical screenshots are re-analyzed every time.** During emulator capture, many frames are byte-for-byte the same black screen, yet each triggers a fresh vision-model call (`_emulator_vision_analyze._analyze_with_api` / `analyze_image` → `llm.ask_vision`). Wasted latency and API cost on identical images.

### Facts (verified)

- `get_logcat` (`tools/android_emulator.py:1129`) returns up to `max_lines` raw log lines as `{"stdout": ...}`.
- Deterministic logcat distillers already exist and are battle-tested: `_emulator_diagnostics.extract_crash_traces` (crashes/ANR/native-fault/process-death, dedup'd) and `analyze_logcat` (event digest). `monitor_logcat` already uses them.
- `tools/cache.py` is a content-addressed cache: `lookup(tool_name, target_rel, extra=None)` / `store(tool_name, target_rel, result, extra=None)` key on `sha256` of the `/workspace`-relative file at `target_rel` plus `extra`. Fail-open (any error → miss / no-op). Gated by `cache.enabled()` (`OMNI_DISABLE_CACHE`).
- Both vision call sites have the image available **on disk as a file**: `vision_tools.analyze_image` resolves a path; the emulator keyframe analyzer works from saved keyframe PNGs. So `cache.py` (file-path-based) applies to both with minimal wiring.
- `subagents.run_subagent` + `AgentDef` provide an isolated read-only summarizer (same pattern as `delegation_tools._synthesizer`).

## Goals

1. A curated noisy tool's raw output never enters the main conversation; the model sees a tight summary plus a path to the full raw output it can read on demand.
2. Non-curated tools that overflow the char cap save their full raw to a file (path referenced) instead of silently losing the tail.
3. A byte-identical image with the same prompt is analyzed by the vision model at most once; repeats are served from cache.

Non-goals: a size-threshold auto-router for arbitrary tools (curated set only); streaming/partial distillation; changing what any tool computes.

---

## Component A — Noisy-tool output distillation

### A1. Distiller registry (`tools/output_distillers.py`, new)

- `NOISY_TOOLS: set[str]` — tool names whose output is always distilled. **Starts as `{"get_logcat"}`.** Adding `run_adb_shell`/`dumpsys` later is a one-line change.
- `DETERMINISTIC_DISTILLERS: dict[str, callable]` — `tool_name -> fn(raw_text: str, tool_args: dict) -> str | None`. Returns a summary string, or `None` to signal "no deterministic distiller — use the LLM fallback."
  - `get_logcat` entry: runs `extract_crash_traces(raw_text)` + `analyze_logcat(raw_text)` and formats a tight summary (crash/ANR/process-death traces first, then a short event digest). No LLM call.
- Public entry point:
  ```
  distill(tool_name, result, run_dir, task_context) -> dict  # {"stdout": summary_plus_path}
  ```

### A2. `distill()` behavior

1. Extract the raw output text from `result` (the `stdout` field, or the JSON-encoded dict as the main loop already does for stdout-less results).
2. **Small-output shortcut:** if the raw is trivially small (≤ the char cap, or an explicit empty marker like `"(no matching log lines)"`), return it unchanged — no file, no summarizer.
3. Write the full raw to `<run_dir>/raw/<tool>-<timestamp>.txt`.
4. Produce the summary:
   - if `tool_name in DETERMINISTIC_DISTILLERS` and it returns non-`None` → use that;
   - else → run the **LLM fallback summarizer** (A3).
5. Return `{"stdout": summary + "\n\n[full raw output saved to <path> — read it if you need a detail this summary dropped]"}`.

### A3. LLM fallback summarizer

A read-only `AgentDef`: `allowed_tools=set()`, `max_steps=1`, low temperature (mirrors `delegation_tools._synthesizer`). Given the raw output as context **plus the current task/goal** (`task_context`) so it distills toward relevance rather than generically. Its distilled report becomes the summary.

### A4. Interception in the main loop (`agent.py`)

In the tool-result formatting path (~line 780, where `output` is trimmed to 8000):
- **If `tool_name in NOISY_TOOLS`:** route the result through `distill(tool_name, result, run_dir, task_context)` and use its `stdout` as the feedback body (skip the blind-truncation branch).
- **Else (generic truncation fix):** if `output` exceeds the char cap, write the full raw to `<run_dir>/raw/<tool>-<timestamp>.txt`, show the capped head, and append `"[full raw output saved to <path>]"` instead of only the current "truncated at 8000 chars" warning. No LLM, no data loss.
- `run_dir` / `task_context` come from the session (the delegate run dir already exists as `_delegate_run_dir`; the current goal/plan is already on the session).

### A5. Error handling (A degrades gracefully — never breaks a tool call)

- Deterministic distiller raises OR LLM summarizer fails → fall back to the generic behavior (save raw to file + capped head + path). The model still gets the output.
- Raw-file write fails → fall back to the current inline-truncation behavior. A result is never lost or swallowed.

---

## Component B — Vision-analysis cache

### B1. Shared helper (`tools/vision_cache.py`, new — or a function beside the call sites)

```
cached_vision(image_path, prompt, compute_fn) -> (analysis_text, was_cached)
```
- `key`: `cache.lookup("vision_analyze", image_path, extra=prompt)` — content-addressed on the image file's sha256 + the prompt.
- On hit → return the stored analysis text, no vision call.
- On miss → `text = compute_fn()`, then `cache.store("vision_analyze", image_path, {"analysis": text}, extra=prompt)`, return `text`.
- Gated by `cache.enabled()`; when caching is off, `cached_vision` just calls `compute_fn()` (behavior identical to today).
- **Prompt is part of the key** so the same frame asked different questions stays correct, while the common case (same frame, same standard prompt) collapses to one call.

### B2. Wiring both entry points

- `vision_tools.analyze_image`: wrap the per-image `llm.ask_vision` call in `cached_vision(image_path, question_or_default, compute_fn)`. (Multi-image requests: key per image; a batch request caches on the combined key or falls back to per-image caching — implementation detail, but a single-image call MUST cache.)
- `tools/_emulator_vision_analyze.py`: at the keyframe-analysis site (which has the keyframe file path and the prompt), wrap the `_analyze_with_api` / `_analyze_with_ollama` call in `cached_vision(keyframe_path, prompt, compute_fn)`.

### B3. Error handling

Cache is a pure optimization: any lookup/store error → run the normal vision call (`cache.py` is already fail-open). Never blocks or corrupts an analysis.

---

## Testing

**Component A** (new `tests/test_output_distillers.py` + a main-loop interception test):
- `NOISY_TOOLS` routes `get_logcat` through `distill`; a non-noisy tool is untouched.
- The deterministic logcat distiller: given raw log text containing a crash, the summary contains the crash trace AND the raw file is written AND the returned text references the path.
- Small/empty output (`"(no matching log lines)"`, or under the cap) bypasses distillation entirely — no file, no summarizer call.
- LLM fallback: a noisy tool with no deterministic distiller (temporarily registered in the test) invokes the summarizer subagent (mocked `run_subagent`) and returns its report + path.
- Generic truncation fix: a non-curated tool emitting > cap chars writes the raw file and appends the path, instead of only the truncation warning.
- Degradation: deterministic distiller raising → falls back to raw-file-and-head (asserted), tool result never lost.

**Component B** (extend the vision/emulator tests):
- Byte-identical image + same prompt: second `cached_vision` call returns the cached text and the real `compute_fn` is invoked **exactly once** (assert on a call counter).
- Different image bytes → miss (compute_fn runs again). Same bytes + different prompt → miss.
- `cache.enabled()` false (`OMNI_DISABLE_CACHE=1`) → `compute_fn` runs every time (no caching).

## Risks / mitigations

- **LLM summary drops a needed detail.** Mitigated by A's raw-to-file: the model reads the exact raw on demand by path. Deterministic logcat distillation (the flagship) doesn't have this risk at all.
- **Vision cache serves a stale analysis after a model/prompt change.** The prompt is in the key; a different prompt misses. A model change isn't in the key, but analyses are advisory and the cache is purgeable (`cache.purge()` / `OMNI_DISABLE_CACHE`). Acceptable.
- **Image not under `/workspace`.** `cache.py` keys on a `/workspace`-relative path; if a screenshot lives elsewhere, the plan passes the on-disk path `cache.py` can hash, or adds a thin bytes-keyed shim. Fail-open means a non-cacheable path simply always computes — never an error.
```
