# omni-agent Enforcement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Insert mechanical checks at the three points where omni-agent currently trusts the model's own belief that it succeeded — tool-call protocol, artifact constraints, and decode discipline.

**Architecture:** Three components, each repairing an existing subsystem rather than adding a parallel one. Component 1 widens the existing non-JSON salvage path in `llm.py` to cover the tag dialect GLM actually emits. Component 2 adds a declared-constraint manifest and a static verification gate between `recompile_apk` and delivery. Component 3 makes one canonical decode directory per APK and closes the shell bypass that currently defeats tool-level restriction.

**Tech Stack:** Python 3, pytest (no config file — tests import modules from repo root), stdlib only for new code (`re`, `os`, `zipfile`, `fnmatch`, `collections`).

## Global Constraints

- Run all tests from the repo root: `python3 -m pytest tests/<file> -q`. There is no `pytest.ini`/`pyproject.toml`; tests rely on repo-root imports (`import llm`, `from tools import ...`).
- `extract_json_action(text)` keeps its existing signature and return contract. Only its coverage widens. It is called by both the agent loop and the codebase-QA sub-agent.
- Constraint vocabulary is generic and app-agnostic. Nothing Roblox-specific (no hardcoded `classes4.dex`, no hardcoded `.so` rule) may enter the codebase. Domain knowledge lives in the user's mission prompt.
- Tools are registered with the `@registry.register(name=, description=, params_schema=, output=, when_to_use=)` decorator from `tool_registry`. Follow that pattern exactly for any new tool.
- **Tools execute inside a Docker sandbox** (`run_cmd` from `docker_sandbox`, working directory `/workspace`). Tests must never invoke `run_command` for real — test the pure helper functions and monkeypatch `run_cmd`.
- `tools/apk_tools.py` currently imports only `base64` from the stdlib. Any task using `os` or `zipfile` must add the import explicitly.
- `run_command` returns `{"error": "..."}` on rejection. Match that shape; do not introduce a `success` key.
- `fnmatch`'s `*` matches `/`. Use `*.so`, never `lib/**/*.so` — `**` is not fnmatch syntax.
- Retry cap for constraint failures: **3** attempts, then stop and report.
- `memory/` is gitignored (`.gitignore:28`). The corpus cannot be committed directly; Task 5 extracts a fixture into `tests/fixtures/`.
- Every task ends with a commit.

## Baseline (measured 2026-07-21)

Across `memory/*/conversation.json`, assistant messages containing `<tool_call` / `<function`:

| Metric | Count | % of 808 |
|---|---|---|
| Total tag-shaped messages | 808 | — |
| Unclosed tag | 742 | 91.8% |
| Multiple calls in one message | 350 | 43.3% |
| Prose before the tag | 350 | 43.3% |
| **Fail to parse today** | **733** | **90.7%** |
| Salvaged today | 75 | 9.3% |

Component 1's acceptance criterion is this number moving to ≥95% parsed (Task 5).

## File Structure

| File | Responsibility | Status |
|---|---|---|
| `llm.py` | Tag regex, non-JSON action normalization, salvage counter | Modify (`_TAG_RE` 893, `_normalize_nonjson_action` 917, `extract_json_action` 1025) |
| `tests/test_hardened_parser.py` | Parser unit tests | Modify — all 12 existing tests use a **closed** tag; that assumption is why the bug survived |
| `tests/fixtures/tag_shapes.json` | Deduplicated real-world tag corpus | Create (Task 5) |
| `tests/test_tag_corpus.py` | Corpus regression gate | Create (Task 5) |
| `tools/constraints.py` | Constraint vocabulary + evaluator (pure) | Create (Task 6) |
| `tools/mission_constraints.py` | `declare_constraints` tool, session storage, retry accounting | Create (Tasks 8, 9) |
| `tests/test_constraints.py` | Evaluator + real-artifact tests | Create (Task 6) |
| `tests/test_mission_constraints.py` | Declaration, echo, retry-cap tests | Create (Task 8) |
| `tools/apk_tools.py` | Canonical decode dir + gate on `recompile_apk` (440) | Modify (Tasks 10, 11) |
| `tools/shell.py` | `run_command` decode-bypass guard (`run_command` 38) | Modify (Task 12) |
| `tests/test_decode_discipline.py` | Canonical decode + shell guard tests | Create (Tasks 11, 12) |

---

## Component 1 — Tool-call salvage repair

### Task 1: Accept unclosed tags

**Files:**
- Modify: `llm.py:893-897` (`_TAG_RE`)
- Test: `tests/test_hardened_parser.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `_TAG_RE` with an optional closing tag; body terminates at the closing tag, the next tag opener, or end of string. Named groups `attr`, `eqname`, `body` unchanged.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_hardened_parser.py`:

```python
def test_unclosed_tool_call_tag():
    text = '<tool_call>{"name": "read_file_chunk", "arguments": {"path": "a.smali"}}'
    action = llm.extract_json_action(text)
    assert action["type"] == "tool_call"
    assert action["tool"] == "read_file_chunk"
    assert action["args"] == {"path": "a.smali"}


def test_closed_tag_still_works():
    text = '<tool_call>{"name": "read_file_chunk", "arguments": {"path": "a.smali"}}</tool_call>'
    action = llm.extract_json_action(text)
    assert action["tool"] == "read_file_chunk"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 -m pytest tests/test_hardened_parser.py::test_unclosed_tool_call_tag -q`
Expected: FAIL — `TypeError: 'NoneType' object is not subscriptable` (regex does not match, so `extract_json_action` returns `None`).

- [ ] **Step 3: Write minimal implementation**

Replace `llm.py:893-897` with:

```python
_TAG_NAMES = r"tool_call|function_call|function"
_TAG_OPEN = r"<(?:" + _TAG_NAMES + r")"
# The closing tag is OPTIONAL: GLM emits `<tool_call>name{json}` with no
# `</tool_call>` in 742 of 808 observed messages. An unclosed body runs to the
# next tag opener or to end of string.
_TAG_RE = re.compile(
    _TAG_OPEN
    + r"(?:\s+name\s*=\s*\"(?P<attr>[\w.]+)\")?"
    + r"(?:\s*=\s*(?P<eqname>[\w.]+))?\s*>"
    + r"(?P<body>.*?)"
    + r"(?:</(?:" + _TAG_NAMES + r")>|(?=" + _TAG_OPEN + r")|\Z)",
    re.DOTALL | re.IGNORECASE,
)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 -m pytest tests/test_hardened_parser.py -q`
Expected: PASS — 14 passed. All 12 pre-existing tests must stay green; they cover the closed-tag dialect, which this pattern still accepts.

- [ ] **Step 5: Commit**

```bash
git add llm.py tests/test_hardened_parser.py
git commit -m "fix(parser): accept unclosed tool_call tags

GLM emits <tool_call>... with no closing tag in 742 of 808 observed
messages. _TAG_RE required the close, so salvage never matched."
```

---

### Task 2: Resolve the tool name from a `name{json}` body

**Files:**
- Modify: `llm.py` (`_normalize_nonjson_action`, tag branch)
- Test: `tests/test_hardened_parser.py`

**Interfaces:**
- Consumes: `_TAG_RE` (Task 1).
- Produces: tag bodies shaped `toolname{"arg": 1}` resolve their name without requiring registration.

**Why registration is not required inside a tag:** the tag is already strong evidence of intent, and omni-agent uses progressive tool disclosure — a tool from an inactive toolset is legitimately unregistered. Requiring registration here would reintroduce the failure for exactly the calls that need to activate a toolset. The registration guard stays on the bare/leading name paths *outside* tags, where prose could be misread.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_hardened_parser.py`:

```python
def test_tag_body_name_then_json_with_prose_prefix():
    text = ('I\'ll start by inspecting the workspace, then create a plan.'
            '<tool_call>list_directory{"directory": "."}')
    action = llm.extract_json_action(text)
    assert action["type"] == "tool_call"
    assert action["tool"] == "list_directory"
    assert action["args"] == {"directory": "."}


def test_tag_body_name_only_unregistered():
    action = llm.extract_json_action("<tool_call>list_skills{}")
    assert action["tool"] == "list_skills"
    assert action["args"] == {}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 -m pytest tests/test_hardened_parser.py::test_tag_body_name_then_json_with_prose_prefix -q`
Expected: FAIL — the tag now matches (Task 1) but `name` stays `None`, so the branch yields nothing and `extract_json_action` returns `None`.

- [ ] **Step 3: Write minimal implementation**

In `llm.py`, inside `_normalize_nonjson_action`, replace:

```python
            if not name:
                lead = _BARE_NAME_RE.match(body)
                if lead and registry.is_registered(lead.group(1)):
                    name = lead.group(1)
```

with:

```python
            if not name:
                # Inside a tag the leading token IS the tool name — the tag is
                # the evidence, so no registration check (progressive
                # disclosure leaves inactive toolsets' tools unregistered).
                lead = _LEADING_NAME_RE.match(body) or _BARE_NAME_RE.match(body)
                if lead:
                    name = lead.group(1)
```

Both regexes expose the name as `group(1)`, so this is safe for either match.

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 -m pytest tests/test_hardened_parser.py -q`
Expected: PASS — 16 passed.

- [ ] **Step 5: Commit**

```bash
git add llm.py tests/test_hardened_parser.py
git commit -m "fix(parser): resolve tool name from name{json} tag bodies"
```

---

### Task 3: Parse every call in a message, not just the first

**Files:**
- Modify: `llm.py` (`_normalize_nonjson_action` → plural + singular wrapper)
- Test: `tests/test_hardened_parser.py`

**Interfaces:**
- Consumes: `_TAG_RE` (Task 1), name resolution (Task 2).
- Produces:
  - `_normalize_nonjson_actions(text) -> list[dict]` — every tag-shaped action, in order.
  - `_normalize_nonjson_action(text) -> dict | None` — unchanged contract, returns the first element.
  - With more than one call present, the returned action carries `action["_dropped_calls"] = [<tool names>]`.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_hardened_parser.py`:

```python
def test_multiple_calls_first_executed_rest_reported():
    text = ('Let me check things.'
            '<tool_call>list_skills{}'
            '<tool_call>list_directory{"directory": "."}')
    action = llm.extract_json_action(text)
    assert action["tool"] == "list_skills"
    assert action["_dropped_calls"] == ["list_directory"]


def test_single_call_has_no_dropped_key():
    action = llm.extract_json_action('<tool_call>list_skills{}')
    assert "_dropped_calls" not in action
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 -m pytest tests/test_hardened_parser.py::test_multiple_calls_first_executed_rest_reported -q`
Expected: FAIL — `KeyError: '_dropped_calls'`.

- [ ] **Step 3: Write minimal implementation**

In `llm.py`, replace the whole `_normalize_nonjson_action` function with:

```python
def _normalize_nonjson_actions(text):
    """Map every non-JSON tool-call shape in `text` onto canonical actions."""
    if not text:
        return []
    actions = []
    for m in _TAG_RE.finditer(text):
        body = (m.group("body") or "").strip()
        name = m.group("attr") or m.group("eqname")
        args = _coerce_args(body)
        if not name:
            for obj in _json_candidates(body):
                if isinstance(obj, dict) and isinstance(obj.get("name"), str):
                    name = obj["name"]
                    if (isinstance(args, dict) and args.get("name") == name
                            and "arguments" not in obj and "args" not in obj):
                        args = {k: v for k, v in args.items() if k != "name"}
                    break
        if not name:
            lead = _LEADING_NAME_RE.match(body) or _BARE_NAME_RE.match(body)
            if lead:
                name = lead.group(1)
        if name:
            actions.append({"type": "tool_call", "tool": name,
                            "args": args if isinstance(args, dict) else {}})
    if actions:
        return actions

    lead = _LEADING_NAME_RE.match(text)
    if lead and registry.is_registered(lead.group(1)):
        return [{"type": "tool_call", "tool": lead.group(1),
                 "args": _coerce_args(lead.group(2))}]

    bare = _BARE_NAME_RE.match(text)
    if bare and registry.is_registered(bare.group(1)):
        return [{"type": "tool_call", "tool": bare.group(1), "args": {}}]

    return []


def _normalize_nonjson_action(text):
    """First non-JSON action in `text`, or None.

    When the model stacked several calls into one message (43% of observed
    off-protocol messages), the extras are named in `_dropped_calls` so the
    loop can ask for them one per turn instead of losing them silently."""
    actions = _normalize_nonjson_actions(text)
    if not actions:
        return None
    first = actions[0]
    if len(actions) > 1:
        first["_dropped_calls"] = [a["tool"] for a in actions[1:]]
    return first
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 -m pytest tests/test_hardened_parser.py -q`
Expected: PASS — 18 passed.

- [ ] **Step 5: Commit**

```bash
git add llm.py tests/test_hardened_parser.py
git commit -m "feat(parser): extract all stacked tool calls, report the extras"
```

---

### Task 4: Count salvages so the failure is observable

**Files:**
- Modify: `llm.py` (module-level counter, `_normalize_nonjson_action`)
- Test: `tests/test_hardened_parser.py`

**Interfaces:**
- Consumes: `_normalize_nonjson_actions` (Task 3).
- Produces: `llm.SALVAGE_STATS` (a `collections.Counter` with keys `salvaged` and `dropped_calls`) and `llm.reset_salvage_stats()`.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_hardened_parser.py`:

```python
def test_salvage_stats_counted():
    llm.reset_salvage_stats()
    llm.extract_json_action('<tool_call>list_skills{}')
    llm.extract_json_action('<tool_call>a{}<tool_call>b{}')
    assert llm.SALVAGE_STATS["salvaged"] == 2
    assert llm.SALVAGE_STATS["dropped_calls"] == 1


def test_clean_json_does_not_count_as_salvage():
    llm.reset_salvage_stats()
    llm.extract_json_action('{"type": "tool_call", "tool": "x", "args": {}}')
    assert llm.SALVAGE_STATS["salvaged"] == 0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 -m pytest tests/test_hardened_parser.py::test_salvage_stats_counted -q`
Expected: FAIL — `AttributeError: module 'llm' has no attribute 'reset_salvage_stats'`.

- [ ] **Step 3: Write minimal implementation**

First check whether `llm.py` already imports `collections` (`grep -n "^import collections" llm.py`); add it only if absent. Then add near the other module-level definitions:

```python
# Off-protocol tool calls repaired this session. GLM emits tag-shaped calls
# instead of the JSON envelope; this makes the rate visible instead of only
# surfacing when a run dies.
SALVAGE_STATS = collections.Counter()


def reset_salvage_stats():
    """Zero the salvage counters. Called once per session start."""
    SALVAGE_STATS.clear()
```

Then in `_normalize_nonjson_action`, replace the body after `first = actions[0]` with:

```python
    SALVAGE_STATS["salvaged"] += 1
    if len(actions) > 1:
        first["_dropped_calls"] = [a["tool"] for a in actions[1:]]
        SALVAGE_STATS["dropped_calls"] += len(actions) - 1
    return first
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 -m pytest tests/test_hardened_parser.py -q`
Expected: PASS — 20 passed.

- [ ] **Step 5: Commit**

```bash
git add llm.py tests/test_hardened_parser.py
git commit -m "feat(parser): count salvaged off-protocol tool calls"
```

---

### Task 5: Corpus regression gate

**Files:**
- Create: `tests/fixtures/tag_shapes.json`
- Create: `tests/test_tag_corpus.py`

**Interfaces:**
- Consumes: the full Component 1 parser (Tasks 1–4).
- Produces: a committed fixture plus a parse-rate assertion. `memory/` is gitignored, so the corpus must be extracted to be reproducible.

- [ ] **Step 1: Generate the fixture from the live corpus**

Run from repo root:

```bash
python3 - <<'EOF'
import json, re, glob, os
open_re = re.compile(r'<(tool_call|function_call|function)\b')
seen, out = set(), []
for p in sorted(glob.glob('memory/*/conversation.json')):
    try:
        d = json.load(open(p))
    except Exception:
        continue
    for m in (d if isinstance(d, list) else d.get('messages', [])):
        if not isinstance(m, dict) or m.get('role') != 'assistant':
            continue
        c = m.get('content') or ''
        if isinstance(c, list):
            c = ' '.join(str(b.get('text', '')) for b in c if isinstance(b, dict))
        if not open_re.search(c):
            continue
        key = re.sub(r'\s+', ' ', c)[:200]
        if key in seen:
            continue
        seen.add(key)
        out.append(c[:4000])
os.makedirs('tests/fixtures', exist_ok=True)
json.dump(out, open('tests/fixtures/tag_shapes.json', 'w'), indent=1)
print(f"wrote {len(out)} deduplicated messages")
EOF
```

Expected: `wrote <N> deduplicated messages`, N between 150 and 808.

- [ ] **Step 2: Write the regression test**

Create `tests/test_tag_corpus.py`:

```python
"""Regression gate against real GLM output.

Baseline measured 2026-07-21, before the Component 1 repairs: 733 of 808
tag-shaped messages (90.7%) failed to parse. This asserts the repaired parser
recovers at least 95% of the corpus."""
import json
import os
import llm

FIXTURE = os.path.join(os.path.dirname(__file__), "fixtures", "tag_shapes.json")


def _corpus():
    with open(FIXTURE, encoding="utf-8") as f:
        return json.load(f)


def test_corpus_is_present_and_substantial():
    assert len(_corpus()) >= 150


def test_parse_rate_at_least_95_percent():
    corpus = _corpus()
    parsed = 0
    failures = []
    for text in corpus:
        try:
            action = llm.extract_json_action(text)
        except Exception:
            action = None
        if action and action.get("tool"):
            parsed += 1
        elif len(failures) < 5:
            failures.append(text[:200])
    rate = parsed / len(corpus)
    assert rate >= 0.95, (
        f"parse rate {rate:.1%} ({parsed}/{len(corpus)}); examples:\n"
        + "\n".join(failures)
    )
```

- [ ] **Step 3: Run the test**

Run: `python3 -m pytest tests/test_tag_corpus.py -q`
Expected: PASS — 2 passed. If the rate assertion fails it prints up to 5 unparsed samples; extend the parser to cover those shapes rather than lowering the threshold.

- [ ] **Step 4: Confirm the fixture is not gitignored**

Run: `git check-ignore -v tests/fixtures/tag_shapes.json; echo "exit=$?"`
Expected: `exit=1` with no preceding output — the file is NOT ignored. `.gitignore:28` ignores `memory/*`, not `tests/`.

- [ ] **Step 5: Commit**

```bash
git add tests/fixtures/tag_shapes.json tests/test_tag_corpus.py
git commit -m "test(parser): corpus regression gate at 95% parse rate

Baseline before repair: 75/808 parsed (9.3%)."
```

---

## Component 2 — Constraint manifest and verification gate

### Task 6: Constraint vocabulary and evaluator

**Files:**
- Create: `tools/constraints.py`
- Create: `tests/test_constraints.py`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `apk_members(path) -> list[str]` — sorted zip member names.
  - `evaluate(constraints, base_members, output_members) -> list[dict]` — one result per constraint: `{"kind", "pattern", "ok": bool, "detail": str}`.
  - `format_results(results) -> str`.
  - `all_passed(results) -> bool`.
  - `KINDS` — `("file_present", "file_absent", "no_new_files_matching", "file_set_unchanged", "file_unmodified")`.

- [ ] **Step 1: Write the failing test**

Create `tests/test_constraints.py`:

```python
import pytest
from tools import constraints

BASE = ["AndroidManifest.xml", "classes.dex", "classes2.dex",
        "lib/arm64-v8a/libroblox.so"]
OUT_OK = BASE + ["classes4.dex"]
OUT_BAD = ["AndroidManifest.xml", "classes.dex", "classes2.dex",
           "lib/arm64-v8a/libroblox.so", "lib/arm64-v8a/libomni-bypass.so"]


def test_file_present_pass():
    r = constraints.evaluate([{"kind": "file_present", "pattern": "classes4.dex"}],
                             BASE, OUT_OK)
    assert r[0]["ok"] is True


def test_file_present_fail_reports_pattern():
    r = constraints.evaluate([{"kind": "file_present", "pattern": "classes4.dex"}],
                             BASE, OUT_BAD)
    assert r[0]["ok"] is False
    assert "classes4.dex" in r[0]["detail"]


def test_no_new_files_matching_catches_added_so():
    r = constraints.evaluate([{"kind": "no_new_files_matching", "pattern": "*.so"}],
                             BASE, OUT_BAD)
    assert r[0]["ok"] is False
    assert "libomni-bypass.so" in r[0]["detail"]


def test_no_new_files_matching_passes_when_unchanged():
    r = constraints.evaluate([{"kind": "no_new_files_matching", "pattern": "*.so"}],
                             BASE, OUT_OK)
    assert r[0]["ok"] is True


def test_file_absent():
    r = constraints.evaluate([{"kind": "file_absent", "pattern": "*.bak"}],
                             BASE, OUT_OK)
    assert r[0]["ok"] is True


def test_file_set_unchanged_reports_both_directions():
    r = constraints.evaluate([{"kind": "file_set_unchanged", "pattern": "*.dex"}],
                             BASE, OUT_OK)
    assert r[0]["ok"] is False
    assert "classes4.dex" in r[0]["detail"]


def test_unknown_kind_fails_loudly():
    r = constraints.evaluate([{"kind": "wishful_thinking", "pattern": "x"}],
                             BASE, OUT_OK)
    assert r[0]["ok"] is False
    assert "unknown" in r[0]["detail"].lower()


def test_format_results_marks_failures():
    r = constraints.evaluate([{"kind": "file_present", "pattern": "classes4.dex"}],
                             BASE, OUT_BAD)
    assert "FAIL" in constraints.format_results(r)


def test_all_passed():
    ok = constraints.evaluate([{"kind": "file_present", "pattern": "classes.dex"}],
                              BASE, OUT_OK)
    assert constraints.all_passed(ok) is True
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 -m pytest tests/test_constraints.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'tools.constraints'`.

- [ ] **Step 3: Write minimal implementation**

Create `tools/constraints.py`:

```python
"""Machine-checked build constraints.

The vocabulary is deliberately app-agnostic: this module knows how to check a
stated constraint, never which constraints a given app needs. Domain knowledge
("this app needs classes4.dex") lives in the user's mission prompt.

fnmatch note: `*` matches `/`, so `*.so` matches `lib/arm64-v8a/libfoo.so`.
`**` is NOT fnmatch syntax."""
import fnmatch
import zipfile

KINDS = ("file_present", "file_absent", "no_new_files_matching",
         "file_set_unchanged", "file_unmodified")


def apk_members(path):
    """Sorted list of member names in an APK/zip."""
    with zipfile.ZipFile(path) as z:
        return sorted(i.filename for i in z.infolist())


def _matching(members, pattern):
    return {m for m in members if fnmatch.fnmatch(m, pattern)}


def evaluate(constraints, base_members, output_members):
    """Check each constraint against base vs output member lists."""
    results = []
    for c in constraints:
        kind = c.get("kind")
        pat = c.get("pattern", "")
        ok, detail = False, ""
        if kind == "file_present":
            ok = bool(_matching(output_members, pat))
            detail = "" if ok else f"no output member matches {pat!r}"
        elif kind == "file_absent":
            hits = sorted(_matching(output_members, pat))
            ok = not hits
            detail = "" if ok else f"present in output: {hits[:5]}"
        elif kind == "no_new_files_matching":
            new = sorted(_matching(output_members, pat)
                         - _matching(base_members, pat))
            ok = not new
            detail = "" if ok else f"added since base: {new}"
        elif kind == "file_set_unchanged":
            b = _matching(base_members, pat)
            o = _matching(output_members, pat)
            ok = b == o
            if not ok:
                detail = f"added: {sorted(o - b)} removed: {sorted(b - o)}"
        elif kind == "file_unmodified":
            in_base = pat in set(base_members)
            in_out = pat in set(output_members)
            ok = in_base and in_out
            if not ok:
                detail = f"{pat!r} in base={in_base} in output={in_out}"
        else:
            detail = f"unknown constraint kind {kind!r}; expected one of {KINDS}"
        results.append({"kind": kind, "pattern": pat, "ok": ok, "detail": detail})
    return results


def format_results(results):
    """Render results for the run report and for model feedback."""
    if not results:
        return "No constraints were declared for this mission."
    lines = []
    for r in results:
        mark = "PASS" if r["ok"] else "FAIL"
        line = f"[{mark}] {r['kind']}({r['pattern']!r})"
        if r["detail"]:
            line += f" — {r['detail']}"
        lines.append(line)
    failed = sum(1 for r in results if not r["ok"])
    lines.append(f"{len(results) - failed}/{len(results)} constraints satisfied.")
    return "\n".join(lines)


def all_passed(results):
    return all(r["ok"] for r in results)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 -m pytest tests/test_constraints.py -q`
Expected: PASS — 9 passed.

- [ ] **Step 5: Commit**

```bash
git add tools/constraints.py tests/test_constraints.py
git commit -m "feat(constraints): app-agnostic build constraint evaluator"
```

---

### Task 7: Pin the real regression as a fixture

**Files:**
- Modify: `tests/test_constraints.py`

**Interfaces:**
- Consumes: `apk_members`, `evaluate`, `all_passed` (Task 6).
- Produces: proof the evaluator catches the historical failure. Tests skip when the artifacts are absent so the suite stays green elsewhere.

- [ ] **Step 1: Write the test**

Append to `tests/test_constraints.py`:

```python
import os

ARTIFACTS = os.path.expanduser("~/Desktop/overnight tests/instance create")
BASE_APK = os.path.expanduser(
    "~/Desktop/overnight tests/fourth overnight/roblox-v2.726.apk")

requires_artifacts = pytest.mark.skipif(
    not (os.path.isdir(ARTIFACTS) and os.path.isfile(BASE_APK)),
    reason="historical overnight artifacts not present on this machine")


@requires_artifacts
def test_catches_the_real_regression():
    """roblox-final.apk dropped classes4.dex and added libomni-bypass.so."""
    base = constraints.apk_members(BASE_APK)
    out = constraints.apk_members(os.path.join(ARTIFACTS, "roblox-final.apk"))
    results = constraints.evaluate([
        {"kind": "file_present", "pattern": "classes4.dex"},
        {"kind": "no_new_files_matching", "pattern": "*.so"},
    ], base, out)
    assert results[0]["ok"] is False
    assert results[1]["ok"] is False
    assert "libomni-bypass.so" in results[1]["detail"]
    assert constraints.all_passed(results) is False


@requires_artifacts
def test_intermediate_build_keeps_classes4():
    base = constraints.apk_members(BASE_APK)
    out = constraints.apk_members(os.path.join(ARTIFACTS, "roblox-work.apk"))
    results = constraints.evaluate(
        [{"kind": "file_present", "pattern": "classes4.dex"}], base, out)
    assert results[0]["ok"] is True
```

- [ ] **Step 2: Run the tests**

Run: `python3 -m pytest tests/test_constraints.py -q`
Expected: PASS — 11 passed (or 9 passed, 2 skipped where the artifacts are absent).

- [ ] **Step 3: Commit**

```bash
git add tests/test_constraints.py
git commit -m "test(constraints): pin the real instance-create regression"
```

---

### Task 8: `declare_constraints` tool — compile and echo

**Files:**
- Create: `tools/mission_constraints.py`
- Create: `tests/test_mission_constraints.py`

**Interfaces:**
- Consumes: `constraints.KINDS`, `constraints.format_results` (Task 6).
- Produces:
  - `declare_constraints(constraints)` — registered tool. Validates each entry against `KINDS`, stores the list, returns an echo string for the user.
  - `get_mission_constraints() -> list[dict]`
  - `reset_mission_constraints()`

**Why a tool rather than automatic extraction:** compiling natural language into assertions is the one part of this component that can be wrong, so it is made explicit and echoed before anything depends on it.

- [ ] **Step 1: Write the failing test**

Create `tests/test_mission_constraints.py`:

```python
from tools import mission_constraints as mc


def setup_function():
    mc.reset_mission_constraints()


def test_declare_stores_and_echoes():
    res = mc.declare_constraints([
        {"kind": "file_present", "pattern": "classes4.dex"},
        {"kind": "no_new_files_matching", "pattern": "*.so"},
    ])
    assert len(mc.get_mission_constraints()) == 2
    assert "classes4.dex" in res["message"]
    assert "*.so" in res["message"]


def test_declare_rejects_unknown_kind():
    res = mc.declare_constraints([{"kind": "vibes", "pattern": "x"}])
    assert "error" in res
    assert mc.get_mission_constraints() == []


def test_declare_rejects_missing_pattern():
    res = mc.declare_constraints([{"kind": "file_present"}])
    assert "error" in res
    assert mc.get_mission_constraints() == []


def test_declare_replaces_previous_declaration():
    mc.declare_constraints([{"kind": "file_present", "pattern": "a"}])
    mc.declare_constraints([{"kind": "file_present", "pattern": "b"}])
    assert [c["pattern"] for c in mc.get_mission_constraints()] == ["b"]


def test_empty_declaration_is_allowed():
    res = mc.declare_constraints([])
    assert "error" not in res
    assert mc.get_mission_constraints() == []
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 -m pytest tests/test_mission_constraints.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'tools.mission_constraints'`.

- [ ] **Step 3: Write minimal implementation**

Create `tools/mission_constraints.py`:

```python
"""Mission-scoped build constraints: declaration, echo, and retry accounting.

The agent declares what the user asked for; the gate in recompile_apk checks
it. Declaration is explicit and echoed because translating natural language
into assertions is the step most likely to misread the user."""
from tool_registry import registry
from tools import constraints as _c

MAX_CONSTRAINT_RETRIES = 3

_DECLARED = []
_ATTEMPTS = {"failed": 0}


def get_mission_constraints():
    """The constraints declared for the current mission."""
    return list(_DECLARED)


def reset_mission_constraints():
    """Clear declarations and retry accounting. Called at session start."""
    _DECLARED.clear()
    _ATTEMPTS["failed"] = 0


@registry.register(
    name="declare_constraints",
    description=(
        "Record the build constraints the user stated for this mission, as a "
        "machine-checked list. Call this ONCE at mission start, before "
        "modifying anything, whenever the user said anything about what the "
        "built artifact must or must not contain. The declared list is echoed "
        "to the user for confirmation and is verified automatically against "
        "the finished APK — a violation fails the build instead of shipping."),
    params_schema={
        "constraints": ("array of objects, each {\"kind\": string, "
                        "\"pattern\": string}. kind is one of: "
                        "file_present, file_absent, no_new_files_matching, "
                        "file_set_unchanged, file_unmodified. pattern is an "
                        "fnmatch glob over APK member names, where * also "
                        "matches '/' (use '*.so', not 'lib/**/*.so')."),
    },
    output=("A confirmation echoing the compiled constraint list, or an error "
            "naming the invalid entry."),
    when_to_use=(
        "At mission start, whenever the user stated a requirement about the "
        "output artifact (\"it must contain X\", \"do not add a new Y\", "
        "\"leave Z untouched\"). Declaring nothing means nothing is checked."),
)
def declare_constraints(constraints):
    """Validate and store the mission's constraints, returning an echo."""
    if constraints is None:
        constraints = []
    if not isinstance(constraints, list):
        return {"error": "declare_constraints expects a list of "
                         "{kind, pattern} objects."}
    cleaned = []
    for i, c in enumerate(constraints):
        if not isinstance(c, dict):
            return {"error": f"entry {i} is not an object: {c!r}"}
        kind = c.get("kind")
        pattern = c.get("pattern")
        if kind not in _c.KINDS:
            return {"error": f"entry {i} has unknown kind {kind!r}; "
                             f"expected one of {_c.KINDS}"}
        if not isinstance(pattern, str) or not pattern:
            return {"error": f"entry {i} ({kind}) needs a non-empty "
                             f"string 'pattern'."}
        cleaned.append({"kind": kind, "pattern": pattern})

    _DECLARED.clear()
    _DECLARED.extend(cleaned)
    _ATTEMPTS["failed"] = 0

    if not cleaned:
        return {"message": "No constraints declared; the build will not be "
                           "constraint-checked."}
    lines = [f"  - {c['kind']}({c['pattern']!r})" for c in cleaned]
    return {"message": "Constraints recorded for this mission:\n"
                       + "\n".join(lines)
                       + "\n\nThe finished APK will be verified against these."}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 -m pytest tests/test_mission_constraints.py -q`
Expected: PASS — 5 passed.

- [ ] **Step 5: Commit**

```bash
git add tools/mission_constraints.py tests/test_mission_constraints.py
git commit -m "feat(constraints): declare_constraints tool with echo-back"
```

---

### Task 9: Retry accounting and failure feedback

**Files:**
- Modify: `tools/mission_constraints.py`
- Modify: `tests/test_mission_constraints.py`

**Interfaces:**
- Consumes: `MAX_CONSTRAINT_RETRIES`, `_ATTEMPTS` (Task 8), `constraints.format_results` (Task 6).
- Produces:
  - `record_failure() -> int` — increments and returns the failed-attempt count.
  - `retries_exhausted() -> bool` — True once the count reaches `MAX_CONSTRAINT_RETRIES`.
  - `failure_feedback(results) -> str` — the per-constraint report plus the attempt count and either a retry instruction or a stop instruction.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_mission_constraints.py`:

```python
from tools import constraints as c


FAILING = c.evaluate([{"kind": "file_present", "pattern": "classes4.dex"}],
                     ["classes.dex"], ["classes.dex"])


def test_record_failure_counts_up():
    assert mc.record_failure() == 1
    assert mc.record_failure() == 2


def test_retries_exhausted_at_cap():
    for _ in range(mc.MAX_CONSTRAINT_RETRIES - 1):
        mc.record_failure()
    assert mc.retries_exhausted() is False
    mc.record_failure()
    assert mc.retries_exhausted() is True


def test_feedback_names_the_failed_constraint():
    text = mc.failure_feedback(FAILING)
    assert "classes4.dex" in text
    assert "FAIL" in text


def test_feedback_says_retry_before_cap():
    mc.record_failure()
    assert "attempt 1 of 3" in mc.failure_feedback(FAILING)


def test_feedback_says_stop_at_cap():
    for _ in range(mc.MAX_CONSTRAINT_RETRIES):
        mc.record_failure()
    text = mc.failure_feedback(FAILING)
    assert "Stop" in text or "stop" in text


def test_reset_clears_attempts():
    mc.record_failure()
    mc.reset_mission_constraints()
    assert mc.retries_exhausted() is False
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 -m pytest tests/test_mission_constraints.py::test_record_failure_counts_up -q`
Expected: FAIL — `AttributeError: module 'tools.mission_constraints' has no attribute 'record_failure'`.

- [ ] **Step 3: Write minimal implementation**

Append to `tools/mission_constraints.py`:

```python
def record_failure():
    """Count one failed constraint check; returns the running total."""
    _ATTEMPTS["failed"] += 1
    return _ATTEMPTS["failed"]


def retries_exhausted():
    """True once the retry budget for constraint failures is spent."""
    return _ATTEMPTS["failed"] >= MAX_CONSTRAINT_RETRIES


def failure_feedback(results):
    """Actionable feedback for a failed constraint check."""
    report = _c.format_results(results)
    attempt = _ATTEMPTS["failed"]
    if retries_exhausted():
        tail = (f"\n\nThis was attempt {attempt} of {MAX_CONSTRAINT_RETRIES}; "
                "the retry budget is spent. Stop modifying the APK and report "
                "which constraints could not be satisfied and why.")
    else:
        tail = (f"\n\nThis was attempt {attempt} of {MAX_CONSTRAINT_RETRIES}. "
                "Fix the specific violations listed above and rebuild. Do not "
                "deliver this artifact.")
    return report + tail
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 -m pytest tests/test_mission_constraints.py -q`
Expected: PASS — 11 passed.

- [ ] **Step 5: Commit**

```bash
git add tools/mission_constraints.py tests/test_mission_constraints.py
git commit -m "feat(constraints): capped retry accounting and failure feedback"
```

---

### Task 10: Wire the gate into the build path

**Files:**
- Modify: `tools/apk_tools.py` (imports, `recompile_apk` at 440)
- Modify: `tests/test_constraints.py`

**Interfaces:**
- Consumes: `constraints.apk_members/evaluate/all_passed`, `mission_constraints.get_mission_constraints/record_failure/failure_feedback`.
- Produces: `recompile_apk(input_dir, output_apk, use_aapt2=True, original_apk=None, constraints_list=None)`. When `constraints_list` is `None` it falls back to the declared mission constraints. With constraints and an `original_apk`, the result dict gains `constraint_results` and `constraints_ok`, and its message carries the report. With neither, behavior is exactly what it is today.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_constraints.py`:

```python
def test_recompile_signature_accepts_constraints():
    import inspect
    from tools import apk_tools
    params = inspect.signature(apk_tools.recompile_apk).parameters
    assert "constraints_list" in params
    assert params["constraints_list"].default is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 -m pytest tests/test_constraints.py::test_recompile_signature_accepts_constraints -q`
Expected: FAIL — `AssertionError` (`constraints_list` not in the signature).

- [ ] **Step 3: Read the function before editing**

Run: `sed -n '440,500p' tools/apk_tools.py`

Note the exact local name of the result dict this function returns (the snippet below calls it `res`) and the exact `return` statement on the success path. Use the real name; do not rename it.

- [ ] **Step 4: Write minimal implementation**

`tools/apk_tools.py` imports only `base64` today. Add to the import block:

```python
import zipfile

from tools import constraints as _constraints
from tools import mission_constraints as _mission
```

Change the signature at line 440 to:

```python
def recompile_apk(input_dir, output_apk, use_aapt2=True, original_apk=None,
                  constraints_list=None):
```

Immediately before the successful `return`, insert (renaming `res` to the real result-dict name if it differs):

```python
    # Static constraint gate: a zip-member diff against the base APK. No
    # emulator is involved, so this is unaffected by omnidroid instance state.
    checks = constraints_list
    if checks is None:
        checks = _mission.get_mission_constraints()
    if checks and original_apk:
        try:
            results = _constraints.evaluate(
                checks,
                _constraints.apk_members(original_apk),
                _constraints.apk_members(output_apk))
        except (OSError, zipfile.BadZipFile) as e:
            res["constraint_results"] = []
            res["constraints_ok"] = False
            res["message"] = (res.get("message", "")
                              + f"\n\nConstraint check could not run: {e}").strip()
        else:
            res["constraint_results"] = results
            res["constraints_ok"] = _constraints.all_passed(results)
            if res["constraints_ok"]:
                res["message"] = (res.get("message", "") + "\n\n"
                                  + _constraints.format_results(results)).strip()
            else:
                _mission.record_failure()
                res["message"] = (res.get("message", "") + "\n\n"
                                  + _mission.failure_feedback(results)).strip()
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `python3 -m pytest tests/test_constraints.py tests/test_mission_constraints.py tests/test_build_fallback.py -q`
Expected: PASS. `test_build_fallback.py` must stay green — the new parameter defaults to `None` and the mission list is empty unless declared, so existing callers are unaffected.

- [ ] **Step 6: Commit**

```bash
git add tools/apk_tools.py tests/test_constraints.py
git commit -m "feat(constraints): static verification gate on recompile_apk"
```

---

## Component 3 — Decode discipline

### Task 11: One canonical decode directory per APK

**Files:**
- Modify: `tools/apk_tools.py` (add `import os`; add `canonical_decode_dir` above `decode_apk` at 180)
- Create: `tests/test_decode_discipline.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `canonical_decode_dir(apk_filename) -> str` — a deterministic directory name, `<stem>_decoded`, derived from the APK basename.

- [ ] **Step 1: Write the failing test**

Create `tests/test_decode_discipline.py`:

```python
from tools import apk_tools


def test_canonical_dir_is_deterministic():
    a = apk_tools.canonical_decode_dir("roblox-v2.726.apk")
    b = apk_tools.canonical_decode_dir("./roblox-v2.726.apk")
    assert a == b == "roblox-v2.726_decoded"


def test_canonical_dir_ignores_leading_path():
    assert (apk_tools.canonical_decode_dir("/workspace/sub/roblox.apk")
            == "roblox_decoded")


def test_canonical_dir_differs_per_apk():
    assert (apk_tools.canonical_decode_dir("roblox.apk")
            != apk_tools.canonical_decode_dir("codex.apk"))
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 -m pytest tests/test_decode_discipline.py -q`
Expected: FAIL — `AttributeError: module 'tools.apk_tools' has no attribute 'canonical_decode_dir'`.

- [ ] **Step 3: Write minimal implementation**

Add `import os` to the imports in `tools/apk_tools.py` (it is not currently imported), then add above `decode_apk`:

```python
def canonical_decode_dir(apk_filename):
    """The one decode directory for this APK.

    A single APK produced four decode trees in the `fourth overnight` run —
    `roblox_extract` (lib only), `roblox_apk_decoded` (res only),
    `roblox_decoded`, `roblox_decoded_full`. Rebuilding from a partial tree is
    a plausible cause of the dropped classes4.dex, so the path is derived
    rather than chosen."""
    stem = os.path.splitext(os.path.basename(apk_filename))[0]
    return f"{stem}_decoded"
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 -m pytest tests/test_decode_discipline.py -q`
Expected: PASS — 3 passed.

- [ ] **Step 5: Commit**

```bash
git add tools/apk_tools.py tests/test_decode_discipline.py
git commit -m "feat(apk): deterministic canonical decode directory"
```

---

### Task 12: Close the shell bypass

**Files:**
- Modify: `tools/shell.py` (`run_command` at 38)
- Modify: `tests/test_decode_discipline.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `_decode_bypass(command) -> str | None` — the rejection message if the command decodes/extracts an APK, else `None`. `run_command` returns `{"error": <message>}` without executing when it fires.

**Why this task exists:** the four partial trees were not created by the decode tools. From the transcript: `run_command{"command":"mkdir -p codex_extract roblox_extract && cd codex_extract && unzip -o ../codex-v2.726.apk 'lib/*' ..."}`. Guarding `unzip_apk` alone would have changed nothing.

**Testing note:** `run_command` executes inside a Docker sandbox via `run_cmd`. Tests must exercise `_decode_bypass` directly and monkeypatch `run_cmd` for the rejection path — never let a test shell out.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_decode_discipline.py`:

```python
from tools import shell


def test_bypass_flags_unzip_of_apk():
    assert shell._decode_bypass("unzip -o ../codex-v2.726.apk 'lib/*'")


def test_bypass_flags_apktool_on_apk():
    assert shell._decode_bypass("apktool d roblox-v2.726.apk -o mytree")


def test_bypass_flags_chained_unzip():
    assert shell._decode_bypass(
        "mkdir -p x && cd x && unzip -o ../roblox.apk 'lib/*'")


def test_bypass_allows_plain_zip():
    assert shell._decode_bypass("unzip -l archive.zip") is None


def test_bypass_allows_ordinary_commands():
    assert shell._decode_bypass("echo hello") is None
    assert shell._decode_bypass("ls -la /workspace") is None


def test_bypass_message_names_the_right_tool():
    assert "decode_apk" in shell._decode_bypass("unzip roblox.apk")


def test_run_command_rejects_without_executing(monkeypatch):
    called = []
    monkeypatch.setattr(shell, "run_cmd",
                        lambda *a, **k: called.append(a) or {})
    res = shell.run_command("unzip -o roblox.apk 'lib/*'")
    assert "error" in res
    assert "decode_apk" in res["error"]
    assert called == []
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 -m pytest tests/test_decode_discipline.py -q`
Expected: FAIL — `AttributeError: module 'tools.shell' has no attribute '_decode_bypass'`.

- [ ] **Step 3: Write minimal implementation**

Add to `tools/shell.py`, above the `@registry.register` decorator for `run_command`:

```python
import re as _re

# The agent bypassed the decode tools by shelling out — this is how the four
# partial decode trees in `fourth overnight` were created. Tool-level
# restriction alone is ineffective, so the shell is guarded too. The segment
# match stops at |, ; and & so only the clause naming the .apk is considered.
_APK_DECODE_RE = _re.compile(
    r"\b(?:unzip|apktool|7z|jar)\b[^|;&]*\.apk\b", _re.IGNORECASE)


def _decode_bypass(command):
    """Rejection message if `command` extracts/decodes an APK, else None."""
    if not _APK_DECODE_RE.search(command or ""):
        return None
    return ("Refused: this command extracts or decodes an APK through the "
            "shell. Use the decode_apk tool, which writes to the one canonical "
            "decode directory for that APK. Partial shell extractions produced "
            "four conflicting trees for a single APK in a previous run and are "
            "not a valid rebuild source.")
```

Then as the first statement inside `run_command`'s body, after the existing
`command = (command or "").strip()` line:

```python
    blocked = _decode_bypass(command)
    if blocked:
        return {"error": blocked}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 -m pytest tests/test_decode_discipline.py -q`
Expected: PASS — 10 passed.

- [ ] **Step 5: Run the full suite**

Run: `python3 -m pytest tests/ -q`
Expected: no new failures versus the pre-task baseline. Capture that baseline **before starting Task 1** with `python3 -m pytest tests/ -q 2>&1 | tail -5` so pre-existing failures are not misattributed.

- [ ] **Step 6: Commit**

```bash
git add tools/shell.py tests/test_decode_discipline.py
git commit -m "fix(shell): block APK decode bypass via run_command"
```

---

## Deferred to a separate plan

**Component 4 (diff-replay)** is specified in
`docs/superpowers/specs/2026-07-21-agent-enforcement-design.md` but is not
planned here. It is a new capability rather than a repair, nothing in
Components 1–3 depends on it, and its interface to the constraint gate is
concrete only once Tasks 6–10 exist. Planning it now would mean inventing
detail that has not been reviewed.

**Issue 3 (code graph underuse)** is resolved by Component 4, not by
Components 1–3. Per the spec: the graph goes unused because nothing in the
workflow requires it, and a previous ergonomic fix did not change adoption.
Diff-replay makes it load-bearing.
