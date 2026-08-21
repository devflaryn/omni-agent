# Workflow Library UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the workflow engine usable by hand — browse a library, launch with a real form, and inspect past runs down to what each agent returned.

**Architecture:** Four small backend additions (an optional `args_schema` in `meta`, summary fields in `result.json`, `list_runs`/`load_run` readers, and a live-branch cap), then a master-detail Workflow tab: a left rail owning *which run to show* (`workflow_library.js`, new) and the existing `workflow_view.js` owning *how to draw a run*. Click-through needs no new capture — the journal already stores every agent's result.

**Tech Stack:** Python 3.14, stdlib only. Frontend is vanilla JS + precompiled Tailwind, driven by a pywebview JS bridge.

**Spec:** `docs/superpowers/specs/2026-08-21-workflow-library-ui-design.md` — read it before Task 1.

## Global Constraints

Every task's requirements implicitly include this section.

- **No new dependencies**, Python or frontend. `requirements.txt` must not change; no CDN additions.
- **No asyncio.** The codebase is threads-only.
- **Tests run both ways.** A test needing monkeypatching takes a parameter literally named `monkeypatch` (pytest fills it as its built-in fixture); the file's `if __name__ == "__main__":` runner passes a hand-rolled shim positionally. Never `mp` — pytest then fails collection with "fixture 'mp' not found". Every test file starts with the two-line `sys.path.insert` preamble.
- **Two verification commands.** Standalone: `.venv/Scripts/python.exe tests/test_x.py`. Whole suite: `.venv/Scripts/python.exe -m pytest tests/ -q --ignore=tests/frontend`.
- **The green bar is a FAILURE SET, not a count.** Exactly these three fail, pre-existing and environmental (they need `~/.omni-agent/bin`, never installed here):
  - `tests/test_fs_api.py::test_symlink_out_of_the_workspace_is_rejected`
  - `tests/test_host_exec.py::test_tool_directory_is_on_path[plain]`
  - `tests/test_host_exec.py::test_tool_directory_is_on_path[with space]`

  The passed count rises with every task — assert the failure SET, never a number.
- **`.gitignore` contains `/tests/`.** New test files need `git add -f` or they are silently never committed. Verify with `git ls-files --error-unmatch <path>`.
- **Do not commit `__pycache__`/`.pyc`.** Check `git status --short` before committing.
- **Frontend styling.** Component classes go in the `<style>` block of `frontend/index.html`, NOT `tailwind.input.css` (three `@tailwind` lines) — that block is what `tests/frontend/test_tailwind_classes.mjs` reads. Tailwind utilities are generated only from `tailwind.config.js`'s `content` globs, currently `['./index.html', './app.js', './workflow_view.js', './device_view.js']`. Rebuild from `frontend/`: `npx tailwindcss@3 -c tailwind.config.js -i tailwind.input.css -o tailwind.css --minify`
- **Escape everything interpolated into `innerHTML`.** Stored agent results are model-authored text — the most attacker-adjacent string in this feature. `frontend/workflow_view.js` has the `esc()` idiom.
- **Determinism rules apply to workflow SCRIPTS, not the engine.** `workflows/__init__.py` may use `time`; a script may not.
- **Commit after every task.** Branch is `workflow-library-ui`.

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `workflows/runs.py` | `list_runs` / `load_run` — readers over the on-disk run directories. Kept out of `__init__.py`, which is already the engine's public entry and orchestration. |
| `frontend/workflow_library.js` | The left rail: library list, launch form, run history. Knows *which* run to draw. |
| `tests/test_workflow_runs.py`, `tests/test_workflow_meta_args.py`, `tests/test_workflow_launch.py`, `tests/frontend/test_workflow_library.mjs` | Coverage for the above. |

**Modified:**

| File | Change |
|---|---|
| `workflows/sandbox.py:26,97` | Accept and validate `args_schema`. |
| `workflows/__init__.py:189` | Write summary fields into `result.json`; re-export `list_runs`/`load_run`. |
| `workflows/runtime.py:29,250` | `MAX_LIVE_BRANCHES` + the in-flight branch counter. |
| `workflows/library/*.py` | Declare `args_schema` on all six. |
| `agent.py` | `AgentApi.list_runs` / `load_run` / `launch_workflow`. |
| `frontend/workflow_view.js` | Read `ev.group`; clickable agent rows; the detail panel; render a historical run. |
| `frontend/index.html`, `frontend/app.js`, `frontend/tailwind.config.js` | Master-detail layout, wiring, styles, globs. |
| `tools/workflow_tools.py` | Advertise `args_schema` in the tool description. |
| `tests/frontend/test_element_ids.mjs`, `test_tailwind_classes.mjs` | Scan `workflow_library.js`. |
| `AGENTS.md` | The launch path and the branch cap. |

---

### Task 1: `args_schema` in `meta`

**Files:**
- Modify: `workflows/sandbox.py` (near `_META_REQUIRED` at line 26, and the validation block at line 97)
- Test: `tests/test_workflow_meta_args.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `extract_meta` returns `meta` with a validated optional `args_schema`; `sandbox.validate_args_schema(schema) -> list[str]` (error strings, empty when valid).

- [ ] **Step 1: Write the failing test**

Create `tests/test_workflow_meta_args.py`:

```python
"""args_schema is what lets the launch form be a real labelled form instead of a
raw JSON box. It is read BEFORE the script runs, so it must be a pure literal and
must be validated at extraction time — a malformed schema would otherwise fail
confusingly at form-render time."""
import sys as _sys, os as _os
_sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))

from workflows import sandbox as SB

BASE = 'meta = {"name": "demo", "description": "d"%s}\nreturn 1\n'


def test_meta_without_args_schema_is_still_valid():
    meta = SB.extract_meta(BASE % "")
    assert meta["name"] == "demo"
    assert meta.get("args_schema") in (None, {})


def test_valid_args_schema_is_returned():
    src = BASE % (', "args_schema": {"target": {"label": "Git ref", '
                  '"required": True, "placeholder": "HEAD"}}')
    meta = SB.extract_meta(src)
    assert meta["args_schema"]["target"]["label"] == "Git ref"
    assert meta["args_schema"]["target"]["required"] is True


def test_args_schema_must_be_a_dict():
    try:
        SB.extract_meta(BASE % ', "args_schema": ["target"]')
        raise AssertionError("expected WorkflowScriptError")
    except SB.WorkflowScriptError as e:
        assert "args_schema" in str(e)


def test_each_arg_entry_must_be_a_dict():
    try:
        SB.extract_meta(BASE % ', "args_schema": {"target": "a string"}')
        raise AssertionError("expected WorkflowScriptError")
    except SB.WorkflowScriptError as e:
        assert "target" in str(e)


def test_arg_names_must_be_strings():
    try:
        SB.extract_meta(BASE % ', "args_schema": {1: {"label": "x"}}')
        raise AssertionError("expected WorkflowScriptError")
    except SB.WorkflowScriptError as e:
        assert "args_schema" in str(e)


def test_a_computed_args_schema_is_rejected_like_any_non_literal_meta():
    # meta is read before the script runs, so nothing in it may be computed.
    src = ('lbl = "x"\n'
           'meta = {"name": "d", "description": "d", "args_schema": {"a": {"label": lbl}}}\n'
           'return 1\n')
    try:
        SB.extract_meta(src)
        raise AssertionError("expected WorkflowScriptError")
    except SB.WorkflowScriptError as e:
        assert "literal" in str(e).lower()


def test_validate_args_schema_reports_every_problem_not_just_the_first():
    errs = SB.validate_args_schema({"a": "no", "b": 3})
    assert len(errs) == 2


def test_validate_args_schema_accepts_an_empty_schema():
    assert SB.validate_args_schema({}) == []


if __name__ == "__main__":
    tests = [test_meta_without_args_schema_is_still_valid,
             test_valid_args_schema_is_returned, test_args_schema_must_be_a_dict,
             test_each_arg_entry_must_be_a_dict, test_arg_names_must_be_strings,
             test_a_computed_args_schema_is_rejected_like_any_non_literal_meta,
             test_validate_args_schema_reports_every_problem_not_just_the_first,
             test_validate_args_schema_accepts_an_empty_schema]
    failed = 0
    for t in tests:
        try:
            t(); print(f"PASS {t.__name__}")
        except Exception as e:
            failed += 1
            import traceback; traceback.print_exc()
            print(f"FAIL {t.__name__}: {e}")
    print("OK" if not failed else f"{failed} FAILED")
    _sys.exit(1 if failed else 0)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/Scripts/python.exe tests/test_workflow_meta_args.py`
Expected: FAIL — `AttributeError: module 'workflows.sandbox' has no attribute 'validate_args_schema'`

- [ ] **Step 3: Write minimal implementation**

In `workflows/sandbox.py`, add above `extract_meta`:

```python
def validate_args_schema(schema):
    """Error strings for a meta['args_schema']; empty when valid.

    Returns ALL problems rather than raising on the first: an author fixing a
    schema wants the whole list, not one round trip per typo."""
    errors = []
    if not isinstance(schema, dict):
        return ["`args_schema` must be a dict of {arg_name: {…}}"]
    for key, entry in schema.items():
        if not isinstance(key, str):
            errors.append(f"`args_schema` key {key!r} must be a string")
            continue
        if not isinstance(entry, dict):
            errors.append(f"`args_schema['{key}']` must be a dict "
                          f"(e.g. {{'label': 'Git ref', 'required': True}})")
    return errors
```

and inside `extract_meta`, immediately after the existing `missing` check (line ~97-102):

```python
        if "args_schema" in meta:
            problems = validate_args_schema(meta["args_schema"])
            if problems:
                raise WorkflowScriptError(
                    "`meta['args_schema']` is malformed: " + "; ".join(problems))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `.venv/Scripts/python.exe tests/test_workflow_meta_args.py`
Expected: 8 × `PASS`, then `OK`

Run: `.venv/Scripts/python.exe -m pytest tests/ -q --ignore=tests/frontend`
Expected: exactly the 3 pre-existing environmental failures, no others.

- [ ] **Step 5: Commit**

```bash
git add -f workflows/sandbox.py tests/test_workflow_meta_args.py
git commit -m "feat(workflows): optional args_schema in meta, validated at extraction"
```

---

### Task 2: Declare `args_schema` on the six built-ins

**Files:**
- Modify: `workflows/library/review_changes.py`, `understand_subsystem.py`, `deep_research.py`, `exhaustive_audit.py`, `migrate.py`, `design_panel.py`
- Modify: `tests/test_workflow_library.py`

**Interfaces:**
- Consumes: `sandbox.validate_args_schema` from Task 1.
- Produces: every built-in's `meta` carries a valid `args_schema`.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_workflow_library.py`, before the `__main__` block:

```python
def test_every_builtin_declares_a_valid_args_schema():
    from workflows import sandbox as SB
    for w in library.list_workflows():
        meta = SB.extract_meta(library.load_source(w["name"]))
        schema = meta.get("args_schema")
        assert isinstance(schema, dict) and schema, \
            f"{w['name']} has no args_schema — the launch form cannot build a form for it"
        assert SB.validate_args_schema(schema) == []


def test_declared_args_match_the_args_each_workflow_actually_reads():
    # A schema advertising an arg the script ignores sends the user to fill in a
    # field that does nothing; the reverse hides a required input.
    import re
    for w in library.list_workflows():
        src = library.load_source(w["name"])
        from workflows import sandbox as SB
        declared = set(SB.extract_meta(src).get("args_schema") or {})
        used = set(re.findall(r"""\(args or \{\}\)\.get\(\s*["'](\w+)["']""", src))
        used |= set(re.findall(r"""args\[\s*["'](\w+)["']\s*\]""", src))
        assert declared == used, (
            f"{w['name']}: declared {sorted(declared)} but script reads {sorted(used)}")
```

Add both names to the `__main__` runner list (they take no `monkeypatch`).

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/Scripts/python.exe tests/test_workflow_library.py`
Expected: FAIL — `review-changes has no args_schema`

- [ ] **Step 3: Write minimal implementation**

Add an `args_schema` to each `meta`. The arg names must match what each script already reads — check each source rather than trusting this list:

`review_changes.py`:
```python
    "args_schema": {"target": {"label": "Git ref or path to review",
                               "required": False, "placeholder": "HEAD"}},
```
`understand_subsystem.py`:
```python
    "args_schema": {"paths": {"label": "Paths to read (JSON list)",
                              "required": True, "placeholder": '["src/a", "src/b"]'}},
```
`deep_research.py`:
```python
    "args_schema": {"question": {"label": "Question to research",
                                 "required": True, "placeholder": "how does X work"}},
```
`exhaustive_audit.py`:
```python
    "args_schema": {"target": {"label": "Path to audit",
                               "required": False, "placeholder": "src/"}},
```
`migrate.py`:
```python
    "args_schema": {
        "description": {"label": "The change to apply", "required": True,
                        "placeholder": "rename foo to bar"},
        "sites": {"label": "Files to change (JSON list, optional)",
                  "required": False, "placeholder": '["src/a.py"]'},
    },
```
`design_panel.py`:
```python
    "args_schema": {"problem": {"label": "Design question", "required": True,
                                "placeholder": "how should we cache"}},
```

- [ ] **Step 4: Run test to verify it passes**

Run: `.venv/Scripts/python.exe tests/test_workflow_library.py`
Expected: all `PASS`, then `OK`

Run: `.venv/Scripts/python.exe -m pytest tests/ -q --ignore=tests/frontend`
Expected: exactly the 3 pre-existing failures.

- [ ] **Step 5: Commit**

```bash
git add -f workflows/library tests/test_workflow_library.py
git commit -m "feat(workflows): declare args_schema on all six built-in workflows"
```

---

### Task 3: Persist the run summary

**Files:**
- Modify: `workflows/__init__.py` (the `result.json` write at line ~189, and `run()`'s start)
- Modify: `tests/test_workflow_run.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `result.json` gains `name`, `aborted`, `agent_count`, `elapsed_s`, `started`, `finished` alongside the existing `ok`, `error`, `result`.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_workflow_run.py`, before `__main__`:

```python
def test_result_json_carries_the_run_summary(monkeypatch):
    # A history list cannot report what was never persisted: agent_count, aborted
    # and elapsed are computed by run() and were previously thrown away.
    _install(monkeypatch)
    import json as _json
    root = _root()
    res = workflows.run(src=GOOD, run_root=root)
    path = _os.path.join(root, "workflows", res["run_id"], "result.json")
    saved = _json.load(open(path, encoding="utf-8"))
    assert saved["name"] == "demo"
    assert saved["agent_count"] == 3
    assert saved["aborted"] is False
    assert isinstance(saved["elapsed_s"], (int, float))
    assert saved["started"] > 0 and saved["finished"] >= saved["started"]


def test_the_summary_is_written_even_when_the_script_raises(monkeypatch):
    # The write lives in a finally; a crashed run must still be listable.
    _install(monkeypatch)
    import json as _json
    root = _root()
    bad = ('meta = {"name": "boom", "description": "d"}\n'
           'agent("one")\n'
           'raise ValueError("nope")\n')
    res = workflows.run(src=bad, run_root=root)
    assert res["ok"] is False
    path = _os.path.join(root, "workflows", res["run_id"], "result.json")
    saved = _json.load(open(path, encoding="utf-8"))
    assert saved["ok"] is False
    assert saved["agent_count"] == 1, "the agents that DID run must still be counted"
    assert saved["name"] == "boom"
```

Add both names (with `needs_monkeypatch=True`) to the `__main__` runner list.

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/Scripts/python.exe tests/test_workflow_run.py`
Expected: FAIL — `KeyError: 'name'`

- [ ] **Step 3: Write minimal implementation**

In `workflows/__init__.py`'s `run()`, capture wall-clock start beside the existing monotonic one:

```python
    started = time.monotonic()
    started_wall = time.time()
```

Then replace the `result.json` write inside the `finally` (line ~189). It must stay in the `finally` and must build the summary from `rt` and `started`, which are in scope there — `out` is computed after this block, so a crashed run would otherwise persist nothing:

```python
            with open(os.path.join(run_dir, "result.json"), "w", encoding="utf-8") as f:
                json.dump({
                    "ok": ok, "error": error, "result": value,
                    # Summary fields: run() computes these anyway, and a history
                    # list cannot report what was never written to disk.
                    "name": meta.get("name", ""),
                    "aborted": rt.aborted,
                    "agent_count": rt.agent_count,
                    "elapsed_s": round(time.monotonic() - started, 2),
                    "started": started_wall,
                    "finished": time.time(),
                }, f, indent=2, default=str)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `.venv/Scripts/python.exe tests/test_workflow_run.py`
Expected: all `PASS`, then `OK`

Run: `.venv/Scripts/python.exe -m pytest tests/ -q --ignore=tests/frontend`
Expected: exactly the 3 pre-existing failures.

- [ ] **Step 5: Commit**

```bash
git add -f workflows/__init__.py tests/test_workflow_run.py
git commit -m "feat(workflows): persist the run summary so past runs can be listed"
```

---

### Task 4: `list_runs` and `load_run`

**Files:**
- Create: `workflows/runs.py`
- Modify: `workflows/__init__.py` (re-export)
- Test: `tests/test_workflow_runs.py`

**Interfaces:**
- Consumes: `workflows.get_run_root()`.
- Produces: `workflows.list_runs(limit=50, run_root=None) -> list[dict]`, `workflows.load_run(run_id, run_root=None) -> dict`.

- [ ] **Step 1: Write the failing test**

Create `tests/test_workflow_runs.py`:

```python
"""Readers over the on-disk run directories. No new artifacts are written here —
the journal already holds every agent's result, model, tokens and elapsed time."""
import sys as _sys, os as _os
_sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))

import json
import tempfile

from workflows import runs as R


def _mkrun(root, run_id, *, name="demo", ok=True, rows=2, summary=True, mtime=None):
    d = _os.path.join(root, "workflows", run_id)
    _os.makedirs(d, exist_ok=True)
    with open(_os.path.join(d, "meta.json"), "w", encoding="utf-8") as f:
        json.dump({"meta": {"name": name, "description": "d"}, "args": {},
                   "resume_from": None}, f)
    payload = {"ok": ok, "error": "", "result": {"x": 1}}
    if summary:
        payload.update(name=name, aborted=False, agent_count=rows,
                       elapsed_s=1.5, started=1000.0, finished=1001.5)
    with open(_os.path.join(d, "result.json"), "w", encoding="utf-8") as f:
        json.dump(payload, f)
    with open(_os.path.join(d, "journal.jsonl"), "w", encoding="utf-8") as f:
        for i in range(rows):
            f.write(json.dumps({"key": f"k{i}", "occ": 0, "ok": True,
                                "result": f"r{i}", "phase": "Scan",
                                "label": f"agent {i}", "agent_type": "researcher",
                                "tokens": 10, "elapsed_s": 0.5,
                                "model": "m", "cached": False}) + "\n")
    if mtime:
        _os.utime(d, (mtime, mtime))
    return d


def _root():
    return tempfile.mkdtemp(prefix="wfruns-")


def test_empty_root_lists_nothing():
    assert R.list_runs(run_root=_root()) == []


def test_a_run_is_summarised():
    root = _root()
    _mkrun(root, "aaa111", name="review-changes", rows=3)
    got = R.list_runs(run_root=root)
    assert len(got) == 1
    r = got[0]
    assert r["run_id"] == "aaa111" and r["name"] == "review-changes"
    assert r["agent_count"] == 3 and r["ok"] is True and r["aborted"] is False


def test_runs_are_newest_first():
    root = _root()
    _mkrun(root, "old", mtime=1000)
    _mkrun(root, "new", mtime=9000)
    ids = [r["run_id"] for r in R.list_runs(run_root=root)]
    assert ids[0] == "new"


def test_limit_is_honoured():
    root = _root()
    for i in range(5):
        _mkrun(root, f"r{i}", mtime=1000 + i)
    assert len(R.list_runs(limit=2, run_root=root)) == 2


def test_a_corrupt_run_is_skipped_not_fatal():
    # One bad directory must not cost the user the whole list.
    root = _root()
    _mkrun(root, "good")
    bad = _os.path.join(root, "workflows", "bad")
    _os.makedirs(bad)
    with open(_os.path.join(bad, "meta.json"), "w", encoding="utf-8") as f:
        f.write("{not json")
    ids = [r["run_id"] for r in R.list_runs(run_root=root)]
    assert ids == ["good"]


def test_a_legacy_run_without_summary_fields_still_lists():
    # Runs made before the summary existed must not vanish from history.
    root = _root()
    _mkrun(root, "legacy", rows=4, summary=False)
    r = R.list_runs(run_root=root)[0]
    assert r["run_id"] == "legacy"
    assert r["agent_count"] == 4, "derived from counting journal lines"
    assert r["elapsed_s"] is None, "unknown, not guessed"
    assert r["aborted"] is None


def test_load_run_returns_meta_journal_and_result():
    root = _root()
    _mkrun(root, "aaa111", rows=2)
    rec = R.load_run("aaa111", run_root=root)
    assert rec["ok"] is True
    assert rec["meta"]["name"] == "demo"
    assert len(rec["rows"]) == 2
    assert rec["rows"][0]["label"] == "agent 0"
    assert rec["rows"][0]["result"] == "r0"
    assert rec["result"] == {"x": 1}


def test_load_run_tolerates_a_torn_journal():
    # A killed process leaves a half-written final line.
    root = _root()
    d = _mkrun(root, "torn", rows=2)
    with open(_os.path.join(d, "journal.jsonl"), "a", encoding="utf-8") as f:
        f.write('{"key": "half')
    rec = R.load_run("torn", run_root=root)
    assert len(rec["rows"]) == 2, "the intact rows still load"


def test_load_run_unknown_id_is_an_error_not_a_crash():
    rec = R.load_run("nope", run_root=_root())
    assert rec["ok"] is False and "nope" in rec["error"]


def test_load_run_rejects_a_traversing_id():
    rec = R.load_run("../../etc", run_root=_root())
    assert rec["ok"] is False


if __name__ == "__main__":
    tests = [test_empty_root_lists_nothing, test_a_run_is_summarised,
             test_runs_are_newest_first, test_limit_is_honoured,
             test_a_corrupt_run_is_skipped_not_fatal,
             test_a_legacy_run_without_summary_fields_still_lists,
             test_load_run_returns_meta_journal_and_result,
             test_load_run_tolerates_a_torn_journal,
             test_load_run_unknown_id_is_an_error_not_a_crash,
             test_load_run_rejects_a_traversing_id]
    failed = 0
    for t in tests:
        try:
            t(); print(f"PASS {t.__name__}")
        except Exception as e:
            failed += 1
            import traceback; traceback.print_exc()
            print(f"FAIL {t.__name__}: {e}")
    print("OK" if not failed else f"{failed} FAILED")
    _sys.exit(1 if failed else 0)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/Scripts/python.exe tests/test_workflow_runs.py`
Expected: FAIL — `ImportError: cannot import name 'runs'`

- [ ] **Step 3: Write minimal implementation**

Create `workflows/runs.py`:

```python
"""Readers over the on-disk run directories.

Nothing here writes. Every field these return was already persisted by run() —
the journal in particular holds each agent's result, model, tokens and elapsed
time, which is why per-agent inspection needed a reader rather than a new
transcript format.

Degradation is the design point: one corrupt directory must not cost the user
the whole history, and a run made before the summary fields existed must still
list. Same discipline as devices.load_devices.
"""
import json
import os
import re

_RUN_ID = re.compile(r"^[0-9a-f]{6,32}$")


def _runs_dir(run_root=None):
    from . import get_run_root
    return os.path.join(run_root if run_root is not None else get_run_root(),
                        "workflows")


def _read_json(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def _count_journal_rows(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return sum(1 for line in f if line.strip())
    except OSError:
        return 0


def _summarise(d, run_id):
    meta_raw = _read_json(os.path.join(d, "meta.json"))
    if not isinstance(meta_raw, dict):
        return None                     # corrupt or missing: skip, do not raise
    meta = meta_raw.get("meta") or {}
    res = _read_json(os.path.join(d, "result.json")) or {}

    # Legacy runs predate the summary fields. Derive what we can and report the
    # rest as unknown — a blank column is honest; a guess is not.
    agent_count = res.get("agent_count")
    if agent_count is None:
        agent_count = _count_journal_rows(os.path.join(d, "journal.jsonl"))
    started = res.get("started")
    if started is None:
        try:
            started = os.path.getctime(d)
        except OSError:
            started = 0.0
    return {
        "run_id": run_id,
        "name": res.get("name") or meta.get("name") or "",
        "ok": res.get("ok"),
        "aborted": res.get("aborted"),
        "agent_count": agent_count,
        "elapsed_s": res.get("elapsed_s"),
        "started": started,
        "finished": res.get("finished"),
    }


def list_runs(limit=50, run_root=None):
    """Newest-first summaries of past runs. A corrupt directory is skipped."""
    base = _runs_dir(run_root)
    try:
        names = os.listdir(base)
    except OSError:
        return []
    out = []
    for name in names:
        d = os.path.join(base, name)
        if not os.path.isdir(d):
            continue
        row = _summarise(d, name)
        if row is not None:
            out.append(row)
    out.sort(key=lambda r: r.get("started") or 0, reverse=True)
    return out[:max(0, int(limit))]


def load_run(run_id, run_root=None):
    """The full record for one run: meta, every journal row, and the result."""
    if not _RUN_ID.match(str(run_id or "")):
        return {"ok": False, "error": f"invalid run id: {run_id!r}", "rows": []}
    d = os.path.join(_runs_dir(run_root), run_id)
    meta_raw = _read_json(os.path.join(d, "meta.json"))
    if not isinstance(meta_raw, dict):
        return {"ok": False, "error": f"no readable run {run_id!r}", "rows": []}

    rows = []
    try:
        with open(os.path.join(d, "journal.jsonl"), "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    rows.append(json.loads(line))
                except ValueError:
                    continue        # a torn final line from a kill; skip it
    except OSError:
        pass

    res = _read_json(os.path.join(d, "result.json")) or {}
    summary = _summarise(d, run_id) or {}
    return {"ok": True, "error": "", "run_id": run_id,
            "meta": meta_raw.get("meta") or {}, "args": meta_raw.get("args"),
            "rows": rows, "result": res.get("result"), "summary": summary}
```

Then re-export from `workflows/__init__.py` (module level is safe — `runs.py` imports only stdlib plus a function-level `get_run_root`):

```python
from .runs import list_runs, load_run   # noqa: F401
```

- [ ] **Step 4: Run test to verify it passes**

Run: `.venv/Scripts/python.exe tests/test_workflow_runs.py`
Expected: 10 × `PASS`, then `OK`

Run: `.venv/Scripts/python.exe -m pytest tests/ -q --ignore=tests/frontend`
Expected: exactly the 3 pre-existing failures.

Run: `.venv/Scripts/python.exe -c "import agent; print('agent imports ok')"`
Expected: `agent imports ok` — the import-cycle guard.

- [ ] **Step 5: Commit**

```bash
git add -f workflows/runs.py workflows/__init__.py tests/test_workflow_runs.py
git commit -m "feat(workflows): list_runs/load_run readers over the on-disk run history"
```

---

### Task 5: The nested fan-out cap

**Files:**
- Modify: `workflows/runtime.py` (constant near line 29; `_spawn` at line 250)
- Modify: `tests/test_workflow_runtime.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `runtime.MAX_LIVE_BRANCHES = 1024`; `_spawn` raises `WorkflowScriptError` when the in-flight total would exceed it.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_workflow_runtime.py`, before `__main__`:

```python
def test_nested_fan_out_cannot_exceed_the_live_branch_cap(monkeypatch):
    # MAX_ITEMS bounds ONE call. The product is what was unbounded:
    # pipeline(256) whose stages each parallel(256) is ~65k threads.
    _install(monkeypatch, lambda ad, p, **k: {"ok": True, "report": "x",
                                              "raw_report": "x"})
    rt = _rt()
    monkeypatch.setattr(R, "MAX_LIVE_BRANCHES", 8)
    try:
        rt.pipeline(list(range(4)),
                    lambda item, orig, i: rt.parallel([lambda: 1] * 4))
        raise AssertionError("expected the cap to raise")
    except R.WorkflowScriptError as e:
        assert "1024" in str(e) or "8" in str(e), "the error must name the cap"


def test_the_live_branch_counter_returns_to_zero(monkeypatch):
    # A leaked counter would make every later fan-out fail for no reason.
    _install(monkeypatch, lambda ad, p, **k: {"ok": True, "report": "x",
                                              "raw_report": "x"})
    rt = _rt()
    rt.parallel([lambda: 1, lambda: 2])
    assert rt._live_branches == 0


def test_the_counter_returns_to_zero_even_when_a_branch_raises(monkeypatch):
    _install(monkeypatch, lambda ad, p, **k: {"ok": True, "report": "x",
                                              "raw_report": "x"})
    rt = _rt()

    def boom():
        raise ValueError("nope")

    rt.parallel([boom, lambda: 1])
    assert rt._live_branches == 0


def test_a_child_workflow_counts_against_the_same_budget(monkeypatch):
    # Child runtimes share _count_lock; they must share this budget too, or
    # nesting reopens the hole the cap exists to close.
    _install(monkeypatch, lambda ad, p, **k: {"ok": True, "report": "x",
                                              "raw_report": "x"})
    rt = _rt()
    child = R.WorkflowRuntime(rt.journal, run_dir=rt.run_dir)
    child._count_lock = rt._count_lock
    child._branch_owner = rt
    rt._live_branches = 5
    assert child._branch_owner._live_branches == 5
```

Add the four names (with `needs_monkeypatch=True`) to the `__main__` runner list.

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/Scripts/python.exe tests/test_workflow_runtime.py`
Expected: FAIL — `AttributeError: module 'workflows.runtime' has no attribute 'MAX_LIVE_BRANCHES'`

- [ ] **Step 3: Write minimal implementation**

In `workflows/runtime.py`, beside `MAX_ITEMS` (line 29):

```python
MAX_ITEMS = 256              # per parallel()/pipeline() call
# MAX_ITEMS bounds ONE call; this bounds the PRODUCT. pipeline(256) whose stages
# each parallel(256) is ~65k threads, which MAX_ITEMS alone permits.
MAX_LIVE_BRANCHES = 1024
```

In `WorkflowRuntime.__init__`, beside the other counters:

```python
        self._live_branches = 0
        # A nested workflow shares its parent's budget — see runtime.workflow(),
        # which already shares _count_lock. Without this, nesting reopens the
        # hole the cap exists to close.
        self._branch_owner = self
```

In `_spawn`, after the existing `MAX_ITEMS` check and before spawning:

```python
        owner = self._branch_owner
        with self._count_lock:
            if owner._live_branches + len(fns) > MAX_LIVE_BRANCHES:
                raise WorkflowScriptError(
                    f"too many concurrent branches: {owner._live_branches} already "
                    f"in flight plus {len(fns)} more exceeds the cap of "
                    f"{MAX_LIVE_BRANCHES}. Nested fan-out multiplies — a pipeline "
                    f"whose stages each call parallel() opens items x items "
                    f"branches. Reduce one of the two levels."
                )
            owner._live_branches += len(fns)
        try:
            ...   # the existing spawn + join body, unchanged
        finally:
            with self._count_lock:
                owner._live_branches -= len(fns)
```

In `workflow()`, where the child already inherits `_sem`, `_abort` and `_count_lock`, add:

```python
        child._branch_owner = self._branch_owner
```

- [ ] **Step 4: Run test to verify it passes**

Run: `.venv/Scripts/python.exe tests/test_workflow_runtime.py`
Expected: all `PASS`, then `OK`

Run it **three times** — these are threaded and flakiness here is a defect.

Run: `.venv/Scripts/python.exe -m pytest tests/ -q --ignore=tests/frontend`
Expected: exactly the 3 pre-existing failures.

- [ ] **Step 5: Commit**

```bash
git add -f workflows/runtime.py tests/test_workflow_runtime.py
git commit -m "feat(workflows): cap total live branches so nested fan-out cannot multiply"
```

---

### Task 6: The `AgentApi` bridge

**Files:**
- Modify: `agent.py` (new `AgentApi` methods near `select_device`/`set_ultra`)
- Test: `tests/test_workflow_launch.py`

**Interfaces:**
- Consumes: `workflows.list_runs`, `workflows.load_run`, `workflows.run`, `workflows.list_library`.
- Produces: `AgentApi.list_workflows()`, `AgentApi.list_runs(limit=50)`, `AgentApi.load_run(run_id)`, `AgentApi.launch_workflow(name, args=None, dry_run=False)`; module constants `agent.WORKFLOW_RESULT_PREFIX`, `agent.WORKFLOW_RESULT_CAP`.

- [ ] **Step 1: Write the failing test**

Create `tests/test_workflow_launch.py`:

```python
"""Launching a workflow from the UI. The result goes INTO the conversation so the
model can act on it — capped, because an exhaustive-audit result would otherwise
blow exactly the context budget the engine exists to protect."""
import sys as _sys, os as _os
_sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))

import agent as agent_mod
from agent import AgentApi


def _api(**over):
    api = AgentApi.__new__(AgentApi)
    api.emits = []
    api._emit = lambda e: api.emits.append(e)
    api._refresh_system_prompt = lambda: None
    api._busy = False
    import threading
    api._lock = threading.Lock()
    session = {"messages": [{"role": "system", "content": ""}],
               "base_system_prompt": "", "memory_dir": "", "project": "p",
               "original_task": None}
    session.update(over)
    api.session = session
    return api


def test_launch_refuses_when_the_agent_is_busy():
    api = _api()
    api._busy = True
    out = api.launch_workflow("review-changes", {"target": "HEAD"})
    assert out["ok"] is False and "busy" in out["error"].lower()


def test_launch_refuses_an_unknown_workflow(monkeypatch):
    import workflows
    monkeypatch.setattr(workflows, "list_library", lambda: [{"name": "review-changes"}])
    out = _api().launch_workflow("no-such-thing")
    assert out["ok"] is False and "no-such-thing" in out["error"]


def test_the_result_is_appended_as_a_user_message(monkeypatch):
    api = _api()
    api._workflow_result_into_conversation(
        {"ok": True, "run_id": "abc123", "name": "review-changes",
         "result": {"confirmed": ["a bug"]}, "agent_count": 4, "elapsed_s": 9.0,
         "warnings": []})
    msgs = api.session["messages"]
    assert msgs[-1]["role"] == "user"
    assert msgs[-1]["content"].startswith(agent_mod.WORKFLOW_RESULT_PREFIX)
    assert "review-changes" in msgs[-1]["content"]
    assert "abc123" in msgs[-1]["content"], "the run id is the pointer to the full record"
    assert "a bug" in msgs[-1]["content"]


def test_a_huge_result_is_capped_and_says_where_the_rest_is():
    api = _api()
    api._workflow_result_into_conversation(
        {"ok": True, "run_id": "abc123", "name": "exhaustive-audit",
         "result": {"confirmed": ["x" * 50000]}, "agent_count": 30,
         "elapsed_s": 60.0, "warnings": []})
    content = api.session["messages"][-1]["content"]
    assert len(content) <= agent_mod.WORKFLOW_RESULT_CAP + 400
    assert "abc123" in content, "capped output must still name the run to open"


def test_a_failed_run_is_reported_not_silently_dropped():
    api = _api()
    api._workflow_result_into_conversation(
        {"ok": False, "run_id": "", "name": "review-changes", "result": None,
         "error": "dry-run failed: KeyError: 'x'", "agent_count": 0,
         "elapsed_s": 0.2, "warnings": []})
    content = api.session["messages"][-1]["content"]
    assert "KeyError" in content


def test_warnings_are_carried_into_the_conversation():
    api = _api()
    api._workflow_result_into_conversation(
        {"ok": True, "run_id": "r", "name": "n", "result": {}, "agent_count": 1,
         "elapsed_s": 1.0, "warnings": ["resume replays agent RESULTS, not side effects"]})
    assert "side effects" in api.session["messages"][-1]["content"]


def test_list_runs_and_load_run_pass_through(monkeypatch):
    import workflows
    monkeypatch.setattr(workflows, "list_runs", lambda limit=50: [{"run_id": "a"}])
    monkeypatch.setattr(workflows, "load_run", lambda rid: {"ok": True, "run_id": rid})
    api = _api()
    assert api.list_runs()["runs"][0]["run_id"] == "a"
    assert api.load_run("a")["run_id"] == "a"


def test_list_workflows_exposes_args_schema(monkeypatch):
    # The form is built from this; without it the UI cannot render fields.
    import workflows
    monkeypatch.setattr(workflows, "list_library",
                        lambda: [{"name": "n", "description": "d",
                                  "when_to_use": "w", "file": "f",
                                  "args_schema": {"target": {"label": "T"}}}])
    out = _api().list_workflows()
    assert out["workflows"][0]["args_schema"]["target"]["label"] == "T"


if __name__ == "__main__":
    import types
    monkeypatch = types.SimpleNamespace(setattr=lambda o, n, v: setattr(o, n, v))
    import workflows as _wf
    _saved = (_wf.list_library, _wf.list_runs, _wf.load_run)
    failed = 0
    for t, needs in [(test_launch_refuses_when_the_agent_is_busy, False),
                     (test_launch_refuses_an_unknown_workflow, True),
                     (test_the_result_is_appended_as_a_user_message, True),
                     (test_a_huge_result_is_capped_and_says_where_the_rest_is, False),
                     (test_a_failed_run_is_reported_not_silently_dropped, False),
                     (test_warnings_are_carried_into_the_conversation, False),
                     (test_list_runs_and_load_run_pass_through, True),
                     (test_list_workflows_exposes_args_schema, True)]:
        try:
            t(monkeypatch) if needs else t()
            print(f"PASS {t.__name__}")
        except Exception as e:
            failed += 1
            import traceback; traceback.print_exc()
            print(f"FAIL {t.__name__}: {e}")
        finally:
            _wf.list_library, _wf.list_runs, _wf.load_run = _saved
    print("OK" if not failed else f"{failed} FAILED")
    _sys.exit(1 if failed else 0)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/Scripts/python.exe tests/test_workflow_launch.py`
Expected: FAIL — `AttributeError: 'AgentApi' object has no attribute 'launch_workflow'`

- [ ] **Step 3: Write minimal implementation**

Add module constants to `agent.py` beside the other prompt constants:

```python
# A user-launched workflow's result goes back into the conversation so the model
# can act on it. This follows the existing TOOL RESULT convention (user-role
# messages carrying tool output), rather than inventing a new channel.
WORKFLOW_RESULT_PREFIX = "WORKFLOW RESULT"
# An exhaustive-audit result can be enormous. Capping it protects exactly the
# context budget the workflow engine exists to protect; the run id is the
# pointer to the full record.
WORKFLOW_RESULT_CAP = 4000
```

Add to `AgentApi`, beside `select_device`:

```python
    def list_workflows(self):
        import workflows
        return {"ok": True, "workflows": workflows.list_library()}

    def list_runs(self, limit=50):
        import workflows
        return {"ok": True, "runs": workflows.list_runs(limit=limit)}

    def load_run(self, run_id):
        import workflows
        return workflows.load_run(run_id)

    def _workflow_result_into_conversation(self, res):
        """Append a finished run's result as a user-role message.

        User-role because this codebase already feeds tool output back that way
        ('TOOL RESULT:'), so the model reads it with machinery it already has."""
        import json as _json
        name = res.get("name") or "workflow"
        run_id = res.get("run_id") or "(no run id)"
        head = f"{WORKFLOW_RESULT_PREFIX} ({name}, run {run_id}):\n"
        if not res.get("ok"):
            body = f"The run FAILED: {res.get('error') or 'unknown error'}"
        else:
            try:
                body = _json.dumps(res.get("result"), indent=2, default=str)
            except (TypeError, ValueError):
                body = str(res.get("result"))
            if len(body) > WORKFLOW_RESULT_CAP:
                body = (body[:WORKFLOW_RESULT_CAP]
                        + f"\n… truncated. Open run {run_id} in the Workflow tab "
                          f"for the full result.")
        stats = (f"\n({res.get('agent_count', 0)} agents, "
                 f"{res.get('elapsed_s', 0)}s)")
        warn = ""
        for w in (res.get("warnings") or []):
            warn += f"\nWARNING: {w}"
        self.session["messages"].append(
            {"role": "user", "content": head + body + stats + warn})

    def launch_workflow(self, name, args=None, dry_run=False):
        """Run a workflow from the UI, then hand its result to the model."""
        import threading
        import workflows
        if not self.session:
            return {"ok": False, "error": "No active session. Start a project first."}
        known = [w["name"] for w in workflows.list_library()]
        if name not in known:
            return {"ok": False,
                    "error": f"no workflow named '{name}'. Available: {', '.join(known)}"}
        with self._lock:
            if self._busy:
                # Two things driving the conversation at once is incoherent.
                return {"ok": False,
                        "error": "The agent is busy. Finish or stop the current task first."}
            self._busy = True
            self._stop = False

        def work():
            try:
                res = workflows.run(name=name, args=args, on_event=self._emit,
                                    dry_run=bool(dry_run))
                if not dry_run:
                    self._workflow_result_into_conversation(res)
                    self._run_agent_loop()
                    return
                self._emit({"type": "system",
                            "content": f"Dry run of '{name}': "
                                       + ("passed" if res.get("ok")
                                          else res.get("error", "failed"))})
            except Exception as e:  # noqa: BLE001
                self._emit({"type": "error", "content": f"workflow launch failed: {e}"})
            finally:
                with self._lock:
                    self._busy = False

        threading.Thread(target=work, daemon=True).start()
        return {"ok": True, "started": True}
```

Note: `_run_agent_loop` sets and clears `_busy` itself in real sessions; the `finally` above is the safety net for the dry-run and error paths. If double-clearing causes a problem, clear `_busy` only on the paths that do not call `_run_agent_loop`, and report it as a deviation.

- [ ] **Step 4: Run test to verify it passes**

Run: `.venv/Scripts/python.exe tests/test_workflow_launch.py`
Expected: 8 × `PASS`, then `OK`

Run: `.venv/Scripts/python.exe -m pytest tests/ -q --ignore=tests/frontend`
Expected: exactly the 3 pre-existing failures. `agent.py` is load-bearing: any break in `test_delegation.py`, `test_ultra_mode.py`, `test_device_session.py` or `test_conversation_tokens.py` is your regression.

Run: `node tests/frontend/test_boot.mjs`
Expected: `boot: OK`

- [ ] **Step 5: Commit**

```bash
git add -f agent.py tests/test_workflow_launch.py
git commit -m "feat(agent): launch a workflow from the UI and feed its result to the model"
```

---

### Task 7: Tree grouping, clickable agents, historical runs

**Files:**
- Modify: `frontend/workflow_view.js`
- Modify: `tests/frontend/test_workflow_view.mjs`

**Interfaces:**
- Consumes: the `device_changed`-style event shape already in use; `ev.group` from `runtime.py:107`.
- Produces: globals `workflowRenderRecord(record)` (draw a historical run from `load_run`'s payload) and `workflowSelectAgent(runId, subId)`; the existing `workflowState()` gains `selectedAgent`.

- [ ] **Step 1: Write the failing test**

Append to `tests/frontend/test_workflow_view.mjs` (before the final `console.log('OK')`), and add the ids `workflowAgentDetail` to the harness id list at the top of the file:

```javascript
{
  // The runtime already emits `group` for a nested workflow; the tree rendered
  // it flat, silently lying about structure.
  const { ctx } = load();
  ctx.workflowStarted({ run_id: 'r1', name: 'parent', description: '', phases: [] });
  ctx.workflowAgentStarted({ run_id: 'r1', sub_id: 'a', phase: 'Work', label: 'outer' });
  ctx.workflowAgentStarted({ run_id: 'r1', sub_id: 'b', phase: 'Work', label: 'inner',
                             group: 'understand-subsystem' });
  const st = ctx.workflowState();
  const phase = st.runs.r1.phases.Work;
  assert.equal(phase.agents.a.group, undefined, 'a top-level agent has no group');
  assert.equal(phase.agents.b.group, 'understand-subsystem');
  assert.ok(st.runs.r1.groups.has
    ? st.runs.r1.groups.has('understand-subsystem')
    : Object.keys(st.runs.r1.groups).includes('understand-subsystem'),
    'the run tracks its nested groups');
  console.log('PASS nested agents carry their group');
}

{
  const { ctx } = load();
  ctx.workflowStarted({ run_id: 'r1', name: 'p', description: '', phases: [] });
  ctx.workflowAgentStarted({ run_id: 'r1', sub_id: 'a', phase: 'Work', label: 'x' });
  ctx.workflowAgentDone({ run_id: 'r1', sub_id: 'a', ok: true, cached: false,
                          tokens: 42, elapsed_s: 1.5, result: 'the answer' });
  ctx.workflowSelectAgent('r1', 'a');
  const sel = ctx.workflowState().selectedAgent;
  assert.equal(sel.sub_id, 'a');
  assert.equal(sel.tokens, 42);
  console.log('PASS an agent row can be selected');
}

{
  // A historical run comes from load_run, not from events, but must draw
  // through the SAME renderer.
  const { ctx, byId } = load();
  ctx.workflowRenderRecord({
    ok: true, run_id: 'old1',
    meta: { name: 'review-changes', description: 'd' },
    summary: { agent_count: 2, elapsed_s: 3.5, ok: true },
    rows: [
      { phase: 'Review', label: 'review:bugs', agent_type: 'researcher',
        tokens: 10, elapsed_s: 1.0, model: 'm', ok: true, cached: false,
        result: 'found one' },
      { phase: 'Verify', label: 'verify:a.py', agent_type: 'researcher',
        tokens: 5, elapsed_s: 0.5, model: 'm', ok: true, cached: true,
        result: 'confirmed' },
    ],
    result: { confirmed: ['one'] },
  });
  const html = byId.get('workflowTree')._html || '';
  assert.ok(/review:bugs/.test(html), 'historical rows render in the tree');
  assert.ok(/Verify/.test(html), 'historical phases render');
  console.log('PASS a historical run renders through the same tree');
}

{
  // Stored results are MODEL-AUTHORED text — the most attacker-adjacent string
  // in this feature.
  const { ctx, byId } = load();
  ctx.workflowRenderRecord({
    ok: true, run_id: 'x1', meta: { name: 'n', description: '' },
    summary: {}, result: null,
    rows: [{ phase: 'P', label: 'l', agent_type: 'researcher', tokens: 0,
             elapsed_s: 0, model: '', ok: true, cached: false,
             result: '<img src=x onerror=alert(1)>' }],
  });
  ctx.workflowSelectAgent('x1', 0);
  const detail = byId.get('workflowAgentDetail')._html || '';
  assert.ok(!detail.includes('<img'), 'a stored result is escaped before innerHTML');
  console.log('PASS stored results are escaped');
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/frontend/test_workflow_view.mjs`
Expected: FAIL — `ctx.workflowSelectAgent is not a function`

- [ ] **Step 3: Write minimal implementation**

In `frontend/workflow_view.js`:

1. `ensureRun` gains `groups: {}` and the module gains `let selectedAgent = null;`.
2. `workflowAgentStarted` records `group: ev.group || undefined` on the agent, and when present does `run.groups[ev.group] = true`.
3. `workflowAgentDone` stores `result: ev.result` when the event carries one.
4. `renderTree` renders agents whose `group` is set under a `▸ <group>` node inside their phase, top-level agents directly.
5. New `workflowSelectAgent(runId, subIdOrIndex)` sets `selectedAgent` from the run's agent (live) or the record's row (historical) and calls `renderAgentDetail()`.
6. New `renderAgentDetail()` writes into `#workflowAgentDetail`: label, agent_type, model, tokens, elapsed, a cached marker, and the stored `result` — every value through `esc()`.
7. New `workflowRenderRecord(record)` converts `load_run`'s `rows` into the same run shape (`phases` keyed by `row.phase`, agents keyed by index, `group` from `row.group` when present) and renders it read-only.
8. Export `workflowRenderRecord`, `workflowSelectAgent`, and add `selectedAgent` to `workflowState()`.

Agent rows already carry `data-sub-id`; add `data-run-id` so a click can be routed without ambiguity between a live and a historical run.

The two functions the tests pin most precisely, in full:

```javascript
  // A historical run arrives from load_run as flat journal rows, not events. It
  // must draw through the SAME renderer as a live run, or the two views drift.
  function workflowRenderRecord(record) {
    if (!record || !record.ok) return;
    const id = record.run_id || 'historical';
    const run = ensureRun(id);
    run.name = (record.meta && record.meta.name) || '';
    run.description = (record.meta && record.meta.description) || '';
    run.status = (record.summary && record.summary.aborted) ? 'aborted'
               : ((record.summary && record.summary.ok) === false ? 'failed' : 'done');
    run.historical = true;
    run.result = record.result;
    (record.rows || []).forEach((row, i) => {
      const phase = ensurePhase(run, row.phase);
      const key = String(i);          // journal rows have no sub_id
      if (!phase.agents[key]) phase.order.push(key);
      phase.agents[key] = {
        id: key, label: row.label || '', agent_type: row.agent_type || '',
        model: row.model || '', status: row.ok ? 'done' : 'failed',
        cached: !!row.cached, tokens: row.tokens || 0,
        elapsed_s: row.elapsed_s || 0, group: row.group || undefined,
        result: row.result,
      };
      if (row.group) run.groups[row.group] = true;
    });
    render(run);
  }

  function renderAgentDetail() {
    const el = document.getElementById('workflowAgentDetail');
    if (!el) return;
    const a = selectedAgent;
    if (!a) { el.innerHTML = ''; return; }
    const meta = [a.agent_type, a.model, a.tokens ? `${a.tokens} tok` : '',
                  a.elapsed_s ? `${a.elapsed_s}s` : '', a.cached ? 'cached' : '']
      .filter(Boolean).join(' · ');
    let body = a.result;
    if (body !== null && typeof body === 'object') {
      try { body = JSON.stringify(body, null, 2); } catch (e) { body = String(body); }
    }
    // A stored result is MODEL-AUTHORED text. esc() is not optional here.
    el.innerHTML =
      `<div class="wf-detail-head">${esc(a.label)}</div>` +
      `<div class="wf-detail-meta">${esc(meta)}</div>` +
      `<pre class="wf-detail-body">${esc(body == null ? '' : String(body))}</pre>`;
  }

  function workflowSelectAgent(runId, subId) {
    const run = runs[runId];
    if (!run) return;
    for (const key of run.order) {
      const a = run.phases[key].agents[String(subId)];
      if (a) { selectedAgent = Object.assign({ sub_id: String(subId) }, a); break; }
    }
    renderAgentDetail();
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/frontend/test_workflow_view.mjs`
Expected: all `PASS`, then `OK`

Run: `node tests/frontend/test_element_ids.mjs && node tests/frontend/test_tailwind_classes.mjs && node tests/frontend/test_contrast.mjs && node tests/frontend/test_boot.mjs`
Expected: `OK` from each. `#workflowAgentDetail` must exist in `index.html` or the id test fails.

- [ ] **Step 5: Commit**

```bash
git add -f frontend/workflow_view.js frontend/index.html tests/frontend/test_workflow_view.mjs
git commit -m "feat(ui): nested-run grouping, clickable agent rows, historical run rendering"
```

---

### Task 8: The library rail

**Files:**
- Create: `frontend/workflow_library.js`
- Modify: `frontend/index.html`, `frontend/app.js`, `frontend/tailwind.config.js`
- Modify: `tests/frontend/test_element_ids.mjs`, `test_tailwind_classes.mjs`
- Test: `tests/frontend/test_workflow_library.mjs`

**Interfaces:**
- Consumes: `pywebview.api.list_workflows/list_runs/load_run/launch_workflow`; `workflowRenderRecord` from Task 7.
- Produces: globals `renderLibrary(payload)`, `renderRunHistory(payload)`, `buildArgsForm(schema)`, `libraryState()`.

- [ ] **Step 1: Write the failing test**

Create `tests/frontend/test_workflow_library.mjs`:

```javascript
// Drives the REAL frontend/workflow_library.js over the shared DOM shim.
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { El } from './_harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND = path.join(here, '..', '..', 'frontend');

function load() {
  const byId = new Map();
  for (const id of ['workflowLibraryList', 'workflowRunList', 'workflowArgsForm',
                    'workflowLaunchName', 'workflowTree', 'workflowAgentDetail']) {
    const el = new El('div'); el.id = id; byId.set(id, el);
  }
  const document = { getElementById: (id) => byId.get(id) || null,
                     createElement: (t) => new El(t), body: new El('div') };
  const ctx = { document, window: {}, console, setTimeout, clearTimeout,
                workflowRenderRecord: (r) => { ctx.__rendered = r; } };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(FRONTEND, 'workflow_library.js'), 'utf8'), ctx);
  return { ctx, byId };
}

const LIB = [
  { name: 'review-changes', description: 'Review a diff', when_to_use: 'for bugs',
    args_schema: { target: { label: 'Git ref', required: false, placeholder: 'HEAD' } } },
  { name: 'deep-research', description: 'Research', when_to_use: 'open questions',
    args_schema: { question: { label: 'Question', required: true } } },
];

{
  const { ctx, byId } = load();
  ctx.renderLibrary({ ok: true, workflows: LIB });
  const html = byId.get('workflowLibraryList')._html || '';
  assert.ok(/review-changes/.test(html) && /deep-research/.test(html));
  assert.ok(/for bugs/.test(html), 'when_to_use is shown — it is how you choose one');
  console.log('PASS library renders');
}

{
  const { ctx, byId } = load();
  ctx.renderLibrary({ ok: true, workflows: LIB });
  ctx.buildArgsForm(LIB[0].args_schema);
  const html = byId.get('workflowArgsForm')._html || '';
  assert.ok(/Git ref/.test(html), 'the label comes from args_schema');
  assert.ok(/HEAD/.test(html), 'the placeholder is used');
  console.log('PASS form is built from args_schema');
}

{
  // A workflow without a schema must still be launchable.
  const { ctx, byId } = load();
  ctx.buildArgsForm(undefined);
  const html = byId.get('workflowArgsForm')._html || '';
  assert.ok(/textarea/i.test(html), 'falls back to a raw JSON box');
  console.log('PASS falls back to JSON without a schema');
}

{
  const { ctx, byId } = load();
  ctx.renderRunHistory({ ok: true, runs: [
    { run_id: 'aaa', name: 'review-changes', ok: true, aborted: false,
      agent_count: 4, elapsed_s: 9.2, started: 1000 },
    { run_id: 'bbb', name: 'migrate', ok: false, aborted: null,
      agent_count: 7, elapsed_s: null, started: 900 },
  ]});
  const html = byId.get('workflowRunList')._html || '';
  assert.ok(/review-changes/.test(html) && /migrate/.test(html));
  assert.ok(!/null/.test(html), 'unknown elapsed renders blank, not the word null');
  console.log('PASS history renders, unknown fields stay blank');
}

{
  // A required field left empty must be caught in the form, not by a dry-run
  // round trip.
  const { ctx } = load();
  ctx.buildArgsForm(LIB[1].args_schema);
  const out = ctx.libraryState().collectArgs();
  assert.equal(out.ok, false);
  assert.ok(/question/i.test(out.error), 'the error names the missing field');
  console.log('PASS required fields are validated in the form');
}

{
  // Workflow names and descriptions come from files on disk; escape anyway.
  const { ctx, byId } = load();
  ctx.renderLibrary({ ok: true, workflows: [
    { name: '<img src=x onerror=alert(1)>', description: 'd', when_to_use: 'w',
      args_schema: {} }]});
  const html = byId.get('workflowLibraryList')._html || '';
  assert.ok(!html.includes('<img'), 'names are escaped');
  console.log('PASS library entries are escaped');
}

console.log('OK');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/frontend/test_workflow_library.mjs`
Expected: FAIL — `ENOENT … frontend/workflow_library.js`

- [ ] **Step 3: Write minimal implementation**

Create `frontend/workflow_library.js` as an IIFE exposing `renderLibrary`, `renderRunHistory`, `buildArgsForm`, `libraryState`, using the same `esc()` idiom as `workflow_view.js`, where:

- `renderLibrary(payload)` lists each workflow's name, description and `when_to_use`, each row selectable; selecting one calls `buildArgsForm(w.args_schema)` and sets `#workflowLaunchName`.
- `buildArgsForm(schema)` renders one labelled input per entry (using `label`, `placeholder`, and marking `required`), or a single `<textarea>` for raw JSON when the schema is absent or empty.
- `libraryState()` returns `{selected, args_schema, collectArgs}` where `collectArgs()` returns `{ok: true, args}` or `{ok: false, error}` naming the first missing required field — validating in the form rather than spending a dry-run round trip on a blank field.
- `renderRunHistory(payload)` lists runs newest-first with name, status dot, agent count and elapsed; a `null` elapsed or aborted renders as blank, never the string "null". Clicking a run calls `pywebview.api.load_run(run_id)` and passes the record to `workflowRenderRecord`.

In `frontend/index.html`: restructure `#workflowTab` into a two-pane master-detail — a left rail containing `#workflowLibraryList`, `#workflowArgsForm`, `#workflowLaunchName`, Dry-run and Launch buttons, and `#workflowRunList`; and a right pane keeping `#workflowTree` plus a new `#workflowAgentDetail`. Add `<script defer src="workflow_library.js"></script>` beside `workflow_view.js` (line 1585). Define the new component classes in the **`<style>` block**.

In `frontend/tailwind.config.js`: add `'./workflow_library.js'` to `content`.

In `frontend/app.js`: wire the Dry-run and Launch buttons to `pywebview.api.launch_workflow(name, args, dryRun)`, and populate the rail on tab activation via `list_workflows()` + `list_runs()`.

Extend `tests/frontend/test_element_ids.mjs` and `test_tailwind_classes.mjs` to also scan `workflow_library.js`, exactly as they already scan `workflow_view.js` and `device_view.js`.

The two functions the tests pin most precisely, in full:

```javascript
  // Built from args_schema when there is one; a raw JSON box otherwise, so a
  // workflow without a schema is still launchable.
  function buildArgsForm(schema) {
    const el = document.getElementById('workflowArgsForm');
    if (!el) return;
    current.schema = schema && Object.keys(schema).length ? schema : null;
    if (!current.schema) {
      el.innerHTML =
        '<label class="wf-arg-label">Arguments (JSON)</label>' +
        '<textarea id="workflowArgsJson" class="wf-arg-input" rows="4" ' +
        'placeholder="{}"></textarea>';
      return;
    }
    el.innerHTML = Object.entries(current.schema).map(([name, spec]) => {
      const label = esc((spec && spec.label) || name);
      const req = (spec && spec.required) ? ' <span class="wf-arg-req">*</span>' : '';
      const ph = esc((spec && spec.placeholder) || '');
      return `<label class="wf-arg-label">${label}${req}</label>` +
             `<input class="wf-arg-input" data-arg="${esc(name)}" placeholder="${ph}">`;
    }).join('');
  }

  // Validate HERE rather than spending a dry-run round trip on a blank field.
  function collectArgs() {
    if (!current.schema) {
      const box = document.getElementById('workflowArgsJson');
      const raw = ((box && box.value) || '').trim();
      if (!raw) return { ok: true, args: {} };
      try { return { ok: true, args: JSON.parse(raw) }; }
      catch (e) { return { ok: false, error: 'Arguments must be valid JSON.' }; }
    }
    const out = {};
    for (const [name, spec] of Object.entries(current.schema)) {
      const field = document.querySelector
        ? document.querySelector(`[data-arg="${name}"]`) : null;
      const val = ((field && field.value) || '').trim();
      if (!val) {
        if (spec && spec.required) {
          return { ok: false, error: `"${name}" is required.` };
        }
        continue;
      }
      // A JSON-looking value is parsed so list args (paths, sites) arrive typed.
      if (val.startsWith('[') || val.startsWith('{')) {
        try { out[name] = JSON.parse(val); continue; }
        catch (e) { return { ok: false, error: `"${name}" is not valid JSON.` }; }
      }
      out[name] = val;
    }
    return { ok: true, args: out };
  }
```

Rebuild: `cd frontend && npx tailwindcss@3 -c tailwind.config.js -i tailwind.input.css -o tailwind.css --minify`

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/frontend/test_workflow_library.mjs`
Expected: 6 × `PASS`, then `OK`

Run: `node tests/frontend/test_workflow_view.mjs && node tests/frontend/test_device_picker.mjs && node tests/frontend/test_boot.mjs && node tests/frontend/test_element_ids.mjs && node tests/frontend/test_tailwind_classes.mjs && node tests/frontend/test_contrast.mjs`
Expected: `OK` from each.

Run: `.venv/Scripts/python.exe -m pytest tests/test_tool_meta_coverage.py -q`
Expected: all pass — it parses `app.js`, so a malformed edit there breaks it.

- [ ] **Step 5: Commit**

```bash
git add -f frontend/workflow_library.js frontend/index.html frontend/app.js \
        frontend/tailwind.config.js frontend/tailwind.css \
        tests/frontend/test_workflow_library.mjs tests/frontend/test_element_ids.mjs \
        tests/frontend/test_tailwind_classes.mjs
git commit -m "feat(ui): workflow library rail with launch form and run history"
```

---

### Task 9: Tool description and docs

**Files:**
- Modify: `tools/workflow_tools.py` (`_run_workflow_description`)
- Modify: `AGENTS.md`
- Modify: `tests/test_workflow_tool.py`

**Interfaces:**
- Consumes: `args_schema` from Tasks 1-2.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_workflow_tool.py`, before `__main__`:

```python
def test_description_advertises_declared_arg_names():
    # The model guesses arg names from prose today. Declared names are exact.
    text = workflow_tools._run_workflow_description()
    assert "target" in text, "review-changes' declared arg should appear"
    assert "question" in text, "deep-research' declared arg should appear"
```

Add the name to the `__main__` runner list (no `monkeypatch`).

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/Scripts/python.exe tests/test_workflow_tool.py`
Expected: FAIL — the declared names are not in the rendered description.

- [ ] **Step 3: Write minimal implementation**

In `tools/workflow_tools.py`'s `_run_workflow_description`, render each library entry's declared args after its hint:

```python
    lines = []
    for w in workflows.list_library():
        hint = w.get("when_to_use") or w.get("description") or ""
        schema = w.get("args_schema") or {}
        if schema:
            args = ", ".join(
                f"{k}{'' if (v or {}).get('required') else ' (optional)'}"
                for k, v in schema.items())
            hint = f"{hint} — args: {args}"
        lines.append(f"  - {w['name']}: {hint}")
```

Then append to `AGENTS.md`'s workflow-engine section:

```markdown
**Launching by hand.** The Workflow tab lists the library and past runs. A
workflow's `meta` may declare an optional `args_schema` — `{arg: {label,
required, placeholder}}` — which drives both the launch form and the arg names
advertised in `run_workflow`'s description. A user-launched run posts its result
back into the conversation as a user-role `WORKFLOW RESULT (...)` message, capped
at 4000 characters with the run id as the pointer to the full record, so the model
can act on findings without the context cost of a large result.

**Two caps, and they are not the same.** `MAX_ITEMS` (256) bounds ONE
`parallel`/`pipeline` call. `MAX_LIVE_BRANCHES` (1024) bounds the PRODUCT across
nesting — a pipeline whose stages each call `parallel()` opens items × items
branches, which `MAX_ITEMS` alone permits. A nested workflow shares its parent's
budget via `_branch_owner`.

Past runs are read by `workflows.list_runs` / `load_run` from the artifacts run()
already writes. There is no separate transcript format: the journal row IS the
per-agent record, carrying each agent's result, model, tokens and elapsed time.
```

- [ ] **Step 4: Verify**

Run: `.venv/Scripts/python.exe tests/test_workflow_tool.py`
Expected: all `PASS`, then `OK`

Run: `.venv/Scripts/python.exe -c "import workflows; [print(w['name'], sorted((w.get('args_schema') or {}).keys())) for w in workflows.list_library()]"`
Expected: six lines, each with its declared arg names — confirming the docs match reality.

- [ ] **Step 5: Commit**

```bash
git add -f tools/workflow_tools.py AGENTS.md tests/test_workflow_tool.py
git commit -m "feat(tools): advertise declared workflow args; docs for launching and the caps"
```

---

## Verification

From a cold shell:

```bash
cd omni-agent
for t in meta_args runs launch; do .venv/Scripts/python.exe tests/test_workflow_$t.py; done
.venv/Scripts/python.exe tests/test_workflow_runtime.py
.venv/Scripts/python.exe tests/test_workflow_run.py
.venv/Scripts/python.exe tests/test_workflow_library.py
.venv/Scripts/python.exe tests/test_workflow_tool.py
.venv/Scripts/python.exe -m pytest tests/ -q --ignore=tests/frontend
for t in test_workflow_library test_workflow_view test_device_picker test_boot test_element_ids test_tailwind_classes test_contrast; do node tests/frontend/$t.mjs; done
.venv/Scripts/python.exe -c "import agent; print('agent imports ok')"
```

Green = exactly the three pre-existing environmental failures named in Global Constraints, and no others.

**Then a real end-to-end check**, which no offline test substitutes for — every test above uses doubles:

1. Open the Workflow tab. The library lists six entries with their `when_to_use`.
2. Select `understand-subsystem`. The form shows a labelled **Paths** field, not a raw JSON box.
3. Press **Dry run** with the field blank — expect a form error naming `paths`, and no tokens spent.
4. Fill it in and **Dry run** again — expect "passed".
5. **Launch**. The tree fills live; when it finishes, a `WORKFLOW RESULT (…)` message appears in the chat and the model responds to it.
6. The run appears in **Recent runs**. Select it — the same tree renders read-only.
7. Click an agent row — its stored result, model, tokens and elapsed appear in the detail panel.
8. Launch again while the agent is still working — expect the busy refusal.
