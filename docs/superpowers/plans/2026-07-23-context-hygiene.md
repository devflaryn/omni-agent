# Context Hygiene Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep large/redundant tool output out of the main conversation — curated noisy tools (logcat) get distilled (summary in chat, raw to file); byte-identical screenshots reuse a cached vision analysis.

**Architecture:** A distiller registry (`tools/output_distillers.py`) maps noisy tool names to deterministic distiller functions (logcat → existing crash-extraction helpers), with a read-only LLM summarizer subagent as the generic fallback. The main loop intercepts flagged tools before their output enters context. A `cached_vision` helper reuses the content-addressed `tools/cache.py` to serve byte-identical images from cache at both vision call sites.

**Tech Stack:** Python 3, existing `subagents.py` engine, `tools/cache.py` (content-addressed), pytest.

## Global Constraints

- **`/tests/` is gitignored** (`.gitignore:38`) — commit SOURCE ONLY, never `git add tests/`. Reviewers read test files from the working tree.
- **Locate edits by SYMBOL/function name, not line number** — recent commits shifted line numbers.
- **Hygiene must never break a tool call.** Every distiller/cache path is fail-open: on any error, fall back to the plain result (Component A → save-raw-to-file-and-head, or inline truncation if even that fails; Component B → run the normal vision call).
- **`NOISY_TOOLS` starts as exactly `{"get_logcat"}`.** Do not add more tools in this plan.
- **A single-image `analyze_image` call MUST cache.** Multi-image batching may fall back to no-cache.
- **Do not change `execute_tool`'s existing return contract** for callers that don't pass the new params (default `None` → current behavior).
- Follow existing patterns: tools live in `tools/`; the main loop is `agent.py`; the cache is `tools/cache.py`; diagnostics helpers are `tools/_emulator_diagnostics.py`.

## Reference — verified signatures

- `tools/_emulator_diagnostics.extract_crash_traces(text, max_traces=5, package_name=None) -> list` (crash/ANR/native-fault/process-death, dedup'd).
- `tools/_emulator_diagnostics.analyze_logcat(text, package_name=None, start_epoch_ms=None, known_pids=None, max_events=20) -> dict` (event digest).
- `tools/cache.py`: `enabled() -> bool`; `lookup(tool_name, target_rel, extra=None) -> dict|None`; `store(tool_name, target_rel, result, extra=None) -> None`. Keys on `sha256` of the `/workspace`-relative file at `target_rel` + `extra`. Fail-open.
- `agent.execute_tool(tool_data, last_tool_call=None, repeat_threshold=..., return_result=False)` — module-level function; the trim-to-8000 formatting lives at its tail. Called once at the `AgentApi` loop (`execute_tool(payload, s["last_tool_call"], s["loop_repeat_threshold"], return_result=True)`), where `self.session` has `memory_dir` and `original_task`.
- `subagents.run_subagent(agent_def, task, context="", run_dir=None, on_event=None)`; `subagents.AgentDef(name, system_prompt, mode="read", allowed_tools=..., max_steps=..., temperature=...)`.

---

## File Structure

- **Create** `tools/output_distillers.py` — registry (`NOISY_TOOLS`, `DETERMINISTIC_DISTILLERS`), `_logcat_distiller`, `distill()`.
- **Create** `tools/vision_cache.py` — `cached_vision(image_path, prompt, compute_fn)`.
- **Modify** `agent.py` — `execute_tool`: intercept noisy tools + generic truncation fix; thread `run_dir`/`task_context` from the call site.
- **Modify** `tools/vision_tools.py` — wrap `analyze_image`'s vision call in `cached_vision`.
- **Modify** `tools/_emulator_vision_analyze.py` — wrap the keyframe vision call in `cached_vision`.
- **Create** test files under `tests/` (gitignored, working-tree only).

---

## Task 1: Distiller registry + deterministic logcat distiller (pure functions)

**Files:**
- Create: `tools/output_distillers.py`
- Test: `tests/test_output_distillers.py`

**Interfaces:**
- Consumes: `tools._emulator_diagnostics.extract_crash_traces`, `analyze_logcat`.
- Produces:
  - `NOISY_TOOLS: set[str]` (== `{"get_logcat"}`)
  - `DETERMINISTIC_DISTILLERS: dict[str, callable]`
  - `_logcat_distiller(raw_text: str, tool_args: dict) -> str | None`

- [ ] **Step 1: Write the failing test**

Create `tests/test_output_distillers.py`:

```python
from tools import output_distillers as od


def test_noisy_tools_starts_with_only_logcat():
    assert od.NOISY_TOOLS == {"get_logcat"}


def test_logcat_distiller_surfaces_a_crash():
    raw = "\n".join([
        "01-01 00:00:00.000  1000  1000 I ActivityManager: Start proc com.roblox.client",
        "01-01 00:00:01.000  1000  1000 E AndroidRuntime: FATAL EXCEPTION: main",
        "01-01 00:00:01.001  1000  1000 E AndroidRuntime: java.lang.NullPointerException: boom",
        "01-01 00:00:01.002  1000  1000 E AndroidRuntime: \tat com.roblox.client.Foo.bar(Foo.java:42)",
    ] + [f"01-01 00:00:02.{i:03d}  1000  1000 D Noise: chatter {i}" for i in range(200)])
    summary = od._logcat_distiller(raw, {})
    assert summary is not None
    assert "NullPointerException" in summary or "FATAL" in summary
    # A distilled summary must be far smaller than the raw noise.
    assert len(summary) < len(raw)


def test_logcat_distiller_registered():
    assert "get_logcat" in od.DETERMINISTIC_DISTILLERS
    assert od.DETERMINISTIC_DISTILLERS["get_logcat"] is od._logcat_distiller
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 -m pytest tests/test_output_distillers.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'tools.output_distillers'`.

- [ ] **Step 3: Write minimal implementation**

Create `tools/output_distillers.py`:

```python
"""Noisy-tool output distillation registry.

A curated set of tools (NOISY_TOOLS) produce large, mostly-irrelevant output
(logcat's flagship case). Their raw output is kept OUT of the main conversation:
the model sees a distilled summary plus a path to the full raw text on disk.

A tool listed in DETERMINISTIC_DISTILLERS is distilled without any LLM call
(logcat reuses the battle-tested crash-extraction helpers). Anything else in
NOISY_TOOLS falls back to a read-only summarizer subagent (see distill()).
"""
from tools._emulator_diagnostics import extract_crash_traces, analyze_logcat

NOISY_TOOLS = {"get_logcat"}


def _logcat_distiller(raw_text, tool_args):
    """Distill a raw logcat dump into crash traces + a short event digest, with
    NO LLM call. Returns a summary string, or None to defer to the LLM fallback."""
    if not (raw_text or "").strip():
        return None
    parts = []
    try:
        traces = extract_crash_traces(raw_text)
    except Exception:
        traces = []
    if traces:
        parts.append(f"CRASHES/ANRs/process-deaths ({len(traces)}):")
        for t in traces:
            parts.append(str(t).strip())
    try:
        analysis = analyze_logcat(raw_text)
    except Exception:
        analysis = None
    if analysis:
        parts.append("EVENT DIGEST:")
        parts.append(str(analysis).strip())
    if not parts:
        # Nothing notable extracted — let the caller decide (fall back / pass through).
        return None
    return "\n".join(parts)


DETERMINISTIC_DISTILLERS = {
    "get_logcat": _logcat_distiller,
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python3 -m pytest tests/test_output_distillers.py -v`
Expected: PASS (3 passed). If `analyze_logcat`/`extract_crash_traces` return a shape whose `str()` is unhelpful, format the fields explicitly, but keep the summary < raw and containing the crash signature.

- [ ] **Step 5: Commit**

```bash
git add tools/output_distillers.py
git commit -m "feat(hygiene): distiller registry + deterministic logcat distiller"
```

---

## Task 2: `distill()` orchestration (raw-to-file, shortcut, LLM fallback, degradation)

**Files:**
- Modify: `tools/output_distillers.py` (add `distill` + a `_save_raw` helper + the summarizer AgentDef)
- Test: `tests/test_output_distillers.py` (add)

**Interfaces:**
- Consumes: `subagents.run_subagent`, `subagents.AgentDef`; Task 1's registry.
- Produces: `distill(tool_name: str, result: dict, run_dir: str | None, task_context: str) -> dict` returning `{"stdout": <summary + raw-path note>}` (or the untouched small result).

- [ ] **Step 1: Write the failing test**

Add to `tests/test_output_distillers.py`:

```python
import os
from tools import output_distillers as od


def _raw_logcat_with_crash(n_noise=300):
    return "\n".join(
        ["01-01 00:00:01.000 1000 1000 E AndroidRuntime: FATAL EXCEPTION: main",
         "01-01 00:00:01.001 1000 1000 E AndroidRuntime: java.lang.NullPointerException: boom"]
        + [f"01-01 00:00:02.{i:03d} 1000 1000 D Noise: chatter {i}" for i in range(n_noise)])


def test_distill_writes_raw_file_and_references_path(tmp_path):
    raw = _raw_logcat_with_crash()
    out = od.distill("get_logcat", {"stdout": raw}, str(tmp_path), "find the crash")
    body = out["stdout"]
    assert "NullPointerException" in body or "FATAL" in body
    # A raw file was written and its path is referenced in the returned body.
    raw_dir = os.path.join(str(tmp_path), "raw")
    files = os.listdir(raw_dir)
    assert len(files) == 1
    assert files[0] in body
    # The full raw is on disk, intact.
    with open(os.path.join(raw_dir, files[0])) as f:
        assert f.read() == raw


def test_distill_small_output_passes_through(tmp_path):
    out = od.distill("get_logcat", {"stdout": "(no matching log lines)"}, str(tmp_path), "")
    assert out["stdout"] == "(no matching log lines)"
    assert not os.path.exists(os.path.join(str(tmp_path), "raw"))


def test_distill_llm_fallback_used_when_no_deterministic(monkeypatch, tmp_path):
    # A tool with NO deterministic distiller forces the LLM summarizer path.
    monkeypatch.setattr(od, "run_subagent",
                        lambda ad, task, context="", run_dir=None: {"ok": True, "report": "LLM SUMMARY"})
    big = "x" * 9000
    out = od.distill("some_noisy_tool", {"stdout": big}, str(tmp_path), "goal")
    assert "LLM SUMMARY" in out["stdout"]
    # raw still saved
    assert os.listdir(os.path.join(str(tmp_path), "raw"))


def test_distill_degrades_when_distiller_raises(monkeypatch, tmp_path):
    def boom(raw, args):
        raise RuntimeError("distiller broke")
    monkeypatch.setitem(od.DETERMINISTIC_DISTILLERS, "get_logcat", boom)
    raw = _raw_logcat_with_crash()
    out = od.distill("get_logcat", {"stdout": raw}, str(tmp_path), "")
    # Never raises; still returns the raw head + a path, no data lost.
    assert "raw" in out["stdout"].lower() or os.listdir(os.path.join(str(tmp_path), "raw"))
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 -m pytest tests/test_output_distillers.py -k distill -v`
Expected: FAIL — `AttributeError: module 'tools.output_distillers' has no attribute 'distill'`.

- [ ] **Step 3: Write minimal implementation**

Add to `tools/output_distillers.py` (imports at top, then the code):

```python
import os
import time

from subagents import run_subagent, AgentDef

# Below this size, distillation isn't worth a file or a subagent — pass through.
_SMALL_OUTPUT_CHARS = 8000
_HEAD_CHARS = 4000  # how much raw head to show when we can only degrade


def _summarizer_agent():
    return AgentDef(
        name="output_summarizer",
        system_prompt=(
            "You are an OUTPUT SUMMARIZER. You are given the raw output of a tool plus the "
            "orchestrator's current goal. Distill the output down to what matters FOR THAT GOAL: "
            "errors, failures, key state, and anything the orchestrator must act on. Drop routine "
            "noise. Be concrete (quote the exact lines that matter). Return just the summary."),
        mode="read", allowed_tools=set(), max_steps=1,
    )


def _extract_raw(result):
    if isinstance(result, dict):
        out = result.get("stdout")
        if out:
            return out if isinstance(out, str) else str(out)
        # stdout-less dict: mirror the main loop's JSON rendering.
        import json
        return json.dumps(result, indent=2, default=str)
    return str(result or "")


def _save_raw(run_dir, tool_name, raw_text):
    """Write raw output to <run_dir>/raw/<tool>-<ts>.txt. Returns the path, or None."""
    try:
        raw_dir = os.path.join(run_dir, "raw")
        os.makedirs(raw_dir, exist_ok=True)
        fname = f"{tool_name}-{int(time.time() * 1000)}.txt"
        path = os.path.join(raw_dir, fname)
        with open(path, "w") as f:
            f.write(raw_text)
        return path
    except Exception:
        return None


def _path_note(path):
    return f"\n\n[full raw output saved to {path} — read it if you need a detail this summary dropped]"


def distill(tool_name, result, run_dir, task_context):
    """Distill a noisy tool's output: summary into chat, full raw to a file.
    Fail-open — never raises; on any problem returns a usable (head + path) body."""
    raw = _extract_raw(result)
    # Small / empty output: not worth distilling.
    if len(raw) <= _SMALL_OUTPUT_CHARS or not raw.strip():
        return {"stdout": raw}

    path = _save_raw(run_dir, tool_name, raw) if run_dir else None

    summary = None
    distiller = DETERMINISTIC_DISTILLERS.get(tool_name)
    if distiller is not None:
        try:
            summary = distiller(raw, (result.get("args") if isinstance(result, dict) else {}) or {})
        except Exception:
            summary = None
    if summary is None:
        try:
            res = run_subagent(_summarizer_agent(),
                               task="Summarize the tool output below for the current goal.",
                               context=f"GOAL: {task_context}\n\nRAW OUTPUT:\n{raw}",
                               run_dir=run_dir)
            if res.get("ok"):
                summary = (res.get("report") or "").strip() or None
        except Exception:
            summary = None

    if summary is None:
        # Degrade: show the head so nothing critical is silently lost.
        head = raw[:_HEAD_CHARS]
        body = f"(could not distill; showing first {len(head)} of {len(raw)} chars)\n{head}"
        return {"stdout": body + (_path_note(path) if path else "")}

    return {"stdout": summary + (_path_note(path) if path else "")}
```

Note: the fallback test drives `distill("some_noisy_tool", ...)`, which has no deterministic distiller, so the LLM path runs regardless of `NOISY_TOOLS` membership — `distill` is only ever called for noisy tools by the main loop, where the registry gate lives.

- [ ] **Step 4: Run test to verify it passes**

Run: `python3 -m pytest tests/test_output_distillers.py -v`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add tools/output_distillers.py
git commit -m "feat(hygiene): distill() — raw-to-file, deterministic/LLM summary, fail-open degrade"
```

---

## Task 3: Main-loop interception + generic truncation fix (`agent.py`)

**Files:**
- Modify: `agent.py` (`execute_tool` signature + tail formatting; the call site in the `AgentApi` loop)
- Test: `tests/test_execute_tool_hygiene.py`

**Interfaces:**
- Consumes: `tools.output_distillers.NOISY_TOOLS`, `distill`.
- Produces: `execute_tool(tool_data, last_tool_call=None, repeat_threshold=..., return_result=False, run_dir=None, task_context="")`.

- [ ] **Step 1: Write the failing test**

Create `tests/test_execute_tool_hygiene.py`:

```python
import os
import agent as agent_mod
from tool_registry import registry


def test_noisy_tool_output_is_distilled(monkeypatch, tmp_path):
    # A fake noisy tool returning big output; register it and mark it noisy.
    big = "FATAL EXCEPTION\n" + ("noise line\n" * 2000)
    monkeypatch.setattr(agent_mod, "NOISY_TOOLS", {"faketool"})

    def fake_distill(tool_name, result, run_dir, task_context):
        return {"stdout": f"DISTILLED::{tool_name}::{run_dir}"}
    monkeypatch.setattr(agent_mod, "distill_output", fake_distill)
    monkeypatch.setattr(registry, "execute", lambda n, a: {"stdout": big})

    feedback, result = agent_mod.execute_tool(
        {"tool": "faketool", "args": {}}, return_result=True,
        run_dir=str(tmp_path), task_context="goal")
    assert "DISTILLED::faketool" in feedback


def test_non_noisy_oversized_output_saves_raw_file(monkeypatch, tmp_path):
    big = "x" * 12000
    monkeypatch.setattr(agent_mod, "NOISY_TOOLS", set())
    monkeypatch.setattr(registry, "execute", lambda n, a: {"stdout": big})
    feedback, result = agent_mod.execute_tool(
        {"tool": "plaintool", "args": {}}, return_result=True,
        run_dir=str(tmp_path), task_context="")
    raw_dir = os.path.join(str(tmp_path), "raw")
    files = os.listdir(raw_dir)
    assert len(files) == 1
    assert files[0] in feedback  # path referenced
    assert "x" * 100 in feedback  # head still shown


def test_backward_compatible_without_run_dir(monkeypatch):
    monkeypatch.setattr(agent_mod, "NOISY_TOOLS", set())
    monkeypatch.setattr(registry, "execute", lambda n, a: {"stdout": "small ok"})
    feedback = agent_mod.execute_tool({"tool": "plaintool", "args": {}})
    assert "small ok" in feedback
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 -m pytest tests/test_execute_tool_hygiene.py -v`
Expected: FAIL — `execute_tool` has no `run_dir` kwarg (`TypeError`), and `agent` has no `NOISY_TOOLS`/`distill_output`.

- [ ] **Step 3: Write minimal implementation**

**3a.** Add the import near the top of `agent.py` (with the other `from tools...` / `import` lines):

```python
from tools.output_distillers import NOISY_TOOLS, distill as distill_output
```

**3b.** Extend `execute_tool`'s signature:

```python
def execute_tool(tool_data, last_tool_call=None, repeat_threshold=LOOP_REPEAT_THRESHOLD,
                 return_result=False, run_dir=None, task_context=""):
```

**3c.** Replace the output-formatting tail (from `output = result.get("stdout", "")` through the truncation warning) so noisy tools are distilled and oversized non-noisy output is saved:

```python
    output = result.get("stdout", "")
    err = result.get("stderr", "")
    err_dict = result.get("error", "")

    if not output and not err and not err_dict and isinstance(result, dict) and result:
        output = json.dumps(result, indent=2, default=str)

    # --- Context hygiene -------------------------------------------------
    # A curated NOISY tool's output is distilled (summary in chat, full raw to a
    # file) instead of dumped. Any OTHER oversized output is saved to a file so
    # the tail is never silently lost to blind truncation.
    if tool_name in NOISY_TOOLS and (output or err_dict):
        try:
            distilled = distill_output(tool_name, result, run_dir, task_context)
            output = distilled.get("stdout", output)
            feedback = f"Tool '{tool_name}' executed.\n"
            if output:
                feedback += f"Output:\n{output}\n"
            if err:
                feedback += f"Stderr:\n{err[:2000]}\n"
            return (feedback, result) if return_result else feedback
        except Exception:
            pass  # fall through to the generic path — never break the call

    feedback = f"Tool '{tool_name}' executed.\n"
    if output:
        if len(output) > 8000:
            path = None
            if run_dir:
                try:
                    from tools.output_distillers import _save_raw
                    path = _save_raw(run_dir, tool_name, output)
                except Exception:
                    path = None
            feedback += f"Output:\n{output[:8000]}\n"
            if path:
                feedback += f"[Output truncated at 8000 of {len(output)} chars — full raw saved to {path}]\n"
            else:
                feedback += (f"[WARNING: Output truncated at 8000 chars. Total output was {len(output)} chars. "
                             "If this is a symbol/string listing, call the tool again with a higher 'skip' or "
                             "'page' offset to see more results.]\n")
        else:
            feedback += f"Output:\n{output}\n"
    if err:
        feedback += f"Stderr:\n{err[:2000]}\n"
    if err_dict:
        feedback += f"System Error:\n{err_dict}\n"

    return (feedback, result) if return_result else feedback
```

**3d.** At the call site in the `AgentApi` loop (the `execute_tool(payload, s["last_tool_call"], ...)` call), pass the run dir and goal from the session:

```python
                    tool_feedback, tool_result = execute_tool(
                        payload, s["last_tool_call"], s["loop_repeat_threshold"], return_result=True,
                        run_dir=s.get("memory_dir"), task_context=(s.get("original_task") or ""))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python3 -m pytest tests/test_execute_tool_hygiene.py -v`
Expected: PASS (3 passed).

- [ ] **Step 5: Regression check**

Run: `python3 -m pytest tests/ -k "execute_tool or agent or tool" -q`
Expected: no NEW failures vs. the repo's ~19-failure baseline (`.superpowers/sdd/baseline-failures.txt`). Existing `execute_tool` callers that don't pass `run_dir` still work (defaults).

- [ ] **Step 6: Commit**

```bash
git add agent.py
git commit -m "feat(hygiene): intercept noisy-tool output in the main loop + save-raw truncation fix"
```

---

## Task 4: `cached_vision` helper + wire `analyze_image`

**Files:**
- Create: `tools/vision_cache.py`
- Modify: `tools/vision_tools.py` (`analyze_image`)
- Test: `tests/test_vision_cache.py`

**Interfaces:**
- Consumes: `tools.cache` (`enabled`, `lookup`, `store`).
- Produces: `cached_vision(image_path: str, prompt: str, compute_fn: callable) -> tuple[str, bool]` returning `(analysis_text, was_cached)`.

- [ ] **Step 1: Write the failing test**

Create `tests/test_vision_cache.py`:

```python
from tools import vision_cache
from tools import cache as cache_mod


def test_identical_image_same_prompt_computes_once(monkeypatch, tmp_path):
    img = tmp_path / "frame.png"
    img.write_bytes(b"\x89PNG-black-screen-bytes")
    monkeypatch.setattr(cache_mod, "enabled", lambda: True)
    store = {}
    monkeypatch.setattr(cache_mod, "lookup", lambda t, rel, extra=None: store.get((rel, extra)))
    monkeypatch.setattr(cache_mod, "store", lambda t, rel, res, extra=None: store.__setitem__((rel, extra), res))

    calls = {"n": 0}
    def compute():
        calls["n"] += 1
        return "black screen"

    a, cached_a = vision_cache.cached_vision(str(img), "is this broken?", compute)
    b, cached_b = vision_cache.cached_vision(str(img), "is this broken?", compute)
    assert a == b == "black screen"
    assert calls["n"] == 1          # computed once
    assert cached_a is False and cached_b is True


def test_different_prompt_is_a_miss(monkeypatch, tmp_path):
    img = tmp_path / "frame.png"
    img.write_bytes(b"same-bytes")
    monkeypatch.setattr(cache_mod, "enabled", lambda: True)
    store = {}
    monkeypatch.setattr(cache_mod, "lookup", lambda t, rel, extra=None: store.get((rel, extra)))
    monkeypatch.setattr(cache_mod, "store", lambda t, rel, res, extra=None: store.__setitem__((rel, extra), res))
    calls = {"n": 0}
    def compute():
        calls["n"] += 1
        return f"analysis {calls['n']}"
    vision_cache.cached_vision(str(img), "q1", compute)
    vision_cache.cached_vision(str(img), "q2", compute)
    assert calls["n"] == 2


def test_cache_disabled_always_computes(monkeypatch, tmp_path):
    img = tmp_path / "frame.png"
    img.write_bytes(b"bytes")
    monkeypatch.setattr(cache_mod, "enabled", lambda: False)
    calls = {"n": 0}
    def compute():
        calls["n"] += 1
        return "x"
    vision_cache.cached_vision(str(img), "q", compute)
    vision_cache.cached_vision(str(img), "q", compute)
    assert calls["n"] == 2
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 -m pytest tests/test_vision_cache.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'tools.vision_cache'`.

- [ ] **Step 3: Write minimal implementation**

Create `tools/vision_cache.py`:

```python
"""Byte-identical image vision cache.

Screenshots (especially byte-for-byte black frames) get re-analyzed by the
vision model every time they recur. cached_vision serves an identical image
with the same prompt from the content-addressed cache instead — one vision
call per unique (image bytes, prompt). Fail-open: any cache problem just runs
the real vision call.
"""
from tools import cache as _cache

_CACHE_TOOL = "vision_analyze"


def cached_vision(image_path, prompt, compute_fn):
    """Return (analysis_text, was_cached). Keys on sha256(image_path) + prompt.

    compute_fn() runs the real vision call and returns the analysis text. It is
    called at most once per unique (image bytes, prompt) while caching is on."""
    prompt = prompt or ""
    if _cache.enabled():
        try:
            hit = _cache.lookup(_CACHE_TOOL, image_path, extra=prompt)
        except Exception:
            hit = None
        if hit and isinstance(hit, dict) and hit.get("analysis") is not None:
            return hit["analysis"], True

    text = compute_fn()

    if _cache.enabled() and text is not None:
        try:
            _cache.store(_CACHE_TOOL, image_path, {"analysis": text}, extra=prompt)
        except Exception:
            pass
    return text, False
```

Then wire `analyze_image` (`tools/vision_tools.py`). For the **single-image** case, wrap the `llm.ask_vision(...)` call:

```python
    # (after `content` is built and paths resolved)
    if len(paths) == 1:
        single_path = paths[0]

        def _compute():
            res = llm.ask_vision([{"role": "user", "content": content}])
            if not res.get("ok"):
                return None
            return res["content"].strip()

        from tools.vision_cache import cached_vision
        analysis, _was_cached = cached_vision(single_path, (question or "").strip() or _DEFAULT_QUESTION, _compute)
        if analysis is None:
            return {"error": "vision request failed"}
        out = analysis
        # ... continue building the existing return (prefix/model note), using `out` ...
    else:
        # existing multi-image path unchanged (no cache — allowed per constraints)
        res = llm.ask_vision([{"role": "user", "content": content}])
        if not res.get("ok"):
            return {"error": res.get("error", "vision request failed")}
        out = res["content"].strip()
```

Keep the existing model-note/prefix formatting; only the source of `out` changes for the single-image path. Read the real function body and adapt so the existing return shape (the `[vision: <model>...]` prefix) is preserved — if the model label isn't available on a cache hit, omit just that label, not the analysis.

- [ ] **Step 4: Run test to verify it passes**

Run: `python3 -m pytest tests/test_vision_cache.py -v`
Expected: PASS (3 passed).

- [ ] **Step 5: Regression check**

Run: `python3 -m pytest tests/ -k "vision" -q`
Expected: no new failures vs baseline.

- [ ] **Step 6: Commit**

```bash
git add tools/vision_cache.py tools/vision_tools.py
git commit -m "feat(hygiene): byte-identical image vision cache + wire analyze_image"
```

---

## Task 5: Wire the emulator keyframe vision path

**Files:**
- Modify: `tools/_emulator_vision_analyze.py` (the keyframe-analysis site that calls `_analyze_with_api` / `_analyze_with_ollama`)
- Test: `tests/test_emulator_vision_cache.py`

**Interfaces:**
- Consumes: `tools.vision_cache.cached_vision` (Task 4).
- Produces: no new public API — the keyframe analysis call routes through `cached_vision`.

- [ ] **Step 1: Write the failing test**

Create `tests/test_emulator_vision_cache.py`. Read `analyze_session` / `_select_frames_for_vision` first to construct a minimal keyframe input; the test asserts that two byte-identical keyframes with the same prompt cause exactly one underlying vision call:

```python
import tools._emulator_vision_analyze as eva
from tools import cache as cache_mod


def test_identical_keyframes_analyzed_once(monkeypatch, tmp_path):
    # Two keyframe files with identical bytes.
    f1 = tmp_path / "kf1.png"; f1.write_bytes(b"IDENTICAL-BLACK")
    f2 = tmp_path / "kf2.png"; f2.write_bytes(b"IDENTICAL-BLACK")

    monkeypatch.setattr(cache_mod, "enabled", lambda: True)
    store = {}
    monkeypatch.setattr(cache_mod, "lookup", lambda t, rel, extra=None: store.get((rel, extra)))
    monkeypatch.setattr(cache_mod, "store", lambda t, rel, res, extra=None: store.__setitem__((rel, extra), res))

    calls = {"n": 0}
    def fake_api(image_b64, prompt, cfg):
        calls["n"] += 1
        return "black screen", None
    monkeypatch.setattr(eva, "_analyze_with_api", fake_api)

    # Drive the smallest seam that analyzes one keyframe file (adapt to the real
    # helper name found when reading the module — e.g. _analyze_one_frame(path, prompt, cfg)).
    cfg = {"cline_model": "m", "mode": "api"}
    r1 = eva._analyze_one_frame(str(f1), eva._VISION_PROMPT, cfg)
    r2 = eva._analyze_one_frame(str(f2), eva._VISION_PROMPT, cfg)
    assert calls["n"] == 1  # second identical frame served from cache
```

NOTE: `_analyze_one_frame` is the seam this task introduces (Step 3). If the module already routes per-frame through a single helper, wrap that; otherwise add this thin helper and call it from `analyze_session`.

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 -m pytest tests/test_emulator_vision_cache.py -v`
Expected: FAIL — `_analyze_one_frame` doesn't exist yet (or isn't cached).

- [ ] **Step 3: Write minimal implementation**

Read `analyze_session` to find where each selected keyframe is base64-encoded and passed to `_analyze_with_api` / `_analyze_with_ollama`. Introduce a single per-frame seam that routes through `cached_vision`, keyed on the keyframe's file path + prompt:

```python
from tools.vision_cache import cached_vision

def _analyze_one_frame(frame_path, prompt, cfg):
    """Analyze one keyframe image, serving byte-identical frames from cache."""
    def _compute():
        import base64
        with open(frame_path, "rb") as fh:
            b64 = base64.b64encode(fh.read()).decode("ascii")
        if cfg.get("mode") == "ollama":
            text, _err = _analyze_with_ollama(b64, prompt, cfg)
        else:
            text, _err = _analyze_with_api(b64, prompt, cfg)
        return text
    text, _was_cached = cached_vision(frame_path, prompt, _compute)
    return text, None
```

Then replace the direct `_analyze_with_api(...)` / `_analyze_with_ollama(...)` call inside `analyze_session`'s per-frame loop with `_analyze_one_frame(frame_path, prompt, cfg)`. Use whatever the module already calls the prompt constant (`_VISION_PROMPT` or similar — read and match); if there is none named, extract the existing inline prompt string into a module constant so both the helper and any callers share it. Preserve the existing handling of the returned text and any error branch.

- [ ] **Step 4: Run test to verify it passes**

Run: `python3 -m pytest tests/test_emulator_vision_cache.py -v`
Expected: PASS.

- [ ] **Step 5: Regression check**

Run: `python3 -m pytest tests/ -k "emulator or vision or capture" -q`
Expected: no new failures vs baseline.

- [ ] **Step 6: Commit**

```bash
git add tools/_emulator_vision_analyze.py
git commit -m "feat(hygiene): cache byte-identical keyframes in the emulator vision path"
```

---

## Self-Review

**Spec coverage:**
- A1 registry → Task 1. ✓
- A2 distill() behavior (raw-to-file, shortcut, det/LLM) → Task 2. ✓
- A3 LLM fallback summarizer → Task 2 (`_summarizer_agent`). ✓
- A4 main-loop interception + generic truncation fix → Task 3. ✓
- A5 error degradation → Task 2 (`distill` fail-open) + Task 3 (try/except around distill). ✓
- B1 `cached_vision` → Task 4. ✓
- B2 wiring both entry points → Task 4 (analyze_image) + Task 5 (emulator keyframe). ✓
- B3 cache fail-open + `enabled()` gate → Task 4 (`cached_vision`). ✓
- Testing section → per-task tests with call-counter assertions. ✓

**Placeholder scan:** No TBD/TODO; all code steps show real code. Task 5's seam name (`_analyze_one_frame`) is defined in-task, and the test notes to adapt if the module already has a per-frame helper.

**Type consistency:** `distill(tool_name, result, run_dir, task_context) -> {"stdout": ...}`; `cached_vision(image_path, prompt, compute_fn) -> (text, was_cached)`; `execute_tool(..., run_dir=None, task_context="")`; `NOISY_TOOLS`/`DETERMINISTIC_DISTILLERS`/`_save_raw`/`_logcat_distiller` names are used consistently across Tasks 1–5. The `agent.py` import aliases `distill as distill_output` (Task 3), and the tests monkeypatch `agent_mod.distill_output`/`agent_mod.NOISY_TOOLS` accordingly.
