# Workflow Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give omni-agent deterministic multi-agent orchestration — workflows written as sandboxed Python scripts that fan subagents across phases, pipeline items without barriers, verify findings adversarially, and resume from a journal.

**Architecture:** A new `workflows/` package layered over the existing `subagents.py` machinery. Concurrency is threads-plus-a-semaphore (never a thread pool — a pool deadlocks when `parallel()` branches each call `agent()`). Scripts are AST-wrapped so top-level `return` works, run with a whitelisted namespace, and validated by a token-free dry-run before launch. Every agent call is content-addressed into a journal so a killed run resumes.

**Tech Stack:** Python 3.14, stdlib only (`ast`, `threading`, `hashlib`, `json`). Frontend is precompiled Tailwind + vanilla JS. No new dependencies in either.

**Spec:** `docs/superpowers/specs/2026-08-21-workflow-engine-design.md` — read it before Task 1. The plan argues from the spec; both travel together.

## Global Constraints

Every task's requirements implicitly include this section.

- **No new Python dependencies.** `requirements.txt` stays at its 7 pinned direct deps. This rules out `jsonschema` — the validator is hand-written. `requirements.txt` documents why a portable lockfile is impractical here; do not add one.
- **No asyncio.** The codebase is threads-only. Do not introduce an event loop.
- **Tests run BOTH ways, and must keep doing so.** This repo's convention (see `tests/test_delegation.py`) is: a test needing monkeypatching takes a parameter literally named `monkeypatch` — pytest fills it with its built-in fixture — and the file's `if __name__ == "__main__":` runner passes a hand-rolled shim positionally. Name the parameter `monkeypatch`, never `monkeypatch`, or pytest collection fails with "fixture 'monkeypatch' not found". Every test file also starts with the two-line `sys.path.insert` preamble so standalone runs resolve imports.
- **Two verification commands, both required.** Standalone (fast, no deps): `.venv/Scripts/python.exe tests/test_x.py` — expect the PASS lines and `OK`. Whole suite (regression check): `.venv/Scripts/python.exe -m pytest tests/ -q --ignore=tests/frontend`.
- **The green baseline for the whole suite is 3 failed, 253 passed, 1 skipped** — NOT zero failures. The 3 are pre-existing and environmental: `test_fs_api.py::test_symlink_out_of_the_workspace_is_rejected` and both `test_host_exec.py::test_tool_directory_is_on_path` params (they need `~/.omni-agent/bin`, which this machine has not installed). Do not try to fix them; do not treat them as your regression. Your bar is: those same 3, and no others, with your new tests added to the passed count.
- **pytest is installed as a DEV tool only.** It is deliberately NOT in `requirements.txt` and must not be added there.
- **Frontend tests run as `node tests/frontend/test_x.mjs`** and load the real `frontend/app.js` through `tests/frontend/_harness.mjs`, asserting against shipped code rather than a reimplementation.
- **Tests are offline.** No network, no LLM calls. Use subagent doubles.
- **Do not add a second execution path.** Every tool shells through `host_exec.run_cmd`; nothing here may bypass it.
- **Item cap: 256** per `parallel`/`pipeline` call — an explicit error, never a silent truncation.
- **Schema repair: 3 attempts total**, then the call returns `None`.
- **Semaphore default: `min(16, cpu_count - 2)`**, floor 1.
- **Workflow nesting: exactly one level.** A `workflow()` call inside a child raises.
- **No budget controls.** No `budget` global, no per-run ceiling. Treat tokens as unbounded.
- **If you add new Tailwind utility classes**, rebuild: `npx tailwindcss@3 -c tailwind.config.js -i tailwind.input.css -o tailwind.css --minify` from `frontend/`.
- **Commit after every task.** Branch is `ui-revision`.

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `workflows/__init__.py` | Public entry: `run()`, `resume()`, `list_library()`, `abort()`. Owns the run directory and event emission. |
| `workflows/schema.py` | JSON-Schema subset validator, dry-run stub generation, contract rendering. Pure; no imports from the rest of the package. |
| `workflows/sandbox.py` | AST wrapping, `meta` extraction, determinism guards, import whitelist, namespace construction. |
| `workflows/journal.py` | Content-addressed call keys, `journal.jsonl` append + replay. |
| `workflows/runtime.py` | `WorkflowRuntime`: semaphore, abort flag, phase state, and the `agent`/`parallel`/`pipeline`/`phase`/`log`/`workflow` primitives. |
| `workflows/library/__init__.py` | Library discovery — name → source path + meta. |
| `workflows/library/*.py` | The six built-in workflows. |
| `tools/workflow_tools.py` | The `run_workflow` tool. |
| `frontend/workflow_view.js` | Workflow progress tree rendering (kept out of the 4,388-line `app.js`). |

**Modified:**

| File | Change |
|---|---|
| `subagents.py` | `schema=` support on `run_subagent` / `_build_messages` / `_run_loop`. |
| `tool_registry.py:17-45` | Map `workflow_tools` to `CORE_GROUP`. |
| `agent.py` | Three touch points: `ultra` session flag, one prompt line, event sink passthrough. |
| `frontend/app.js:2363-2381` | Six new cases in the event switch, delegating to `workflow_view.js`. |
| `frontend/index.html:1114-1116` | A fourth tab button + panel. |

**Deviation from the spec, recorded deliberately:** the spec says `run_workflow` goes in "a new `workflow` toolset". It goes in `CORE_GROUP` instead. An on-demand toolset shows the model only a one-line catalog entry, which contradicts ultra mode's "default to a workflow for substantive tasks" — the model cannot default to a tool whose parameters it cannot see. `delegation_tools` is already core for the same reason. One tool with a lazily-built description is a few hundred prompt tokens.

---

### Task 1: Schema validator, stubs, and contract rendering

**Files:**
- Create: `workflows/__init__.py` (empty for now), `workflows/schema.py`
- Test: `tests/test_workflow_schema.py`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `validate(value, schema, path="$") -> list[str]` — human-readable error strings, empty when valid.
  - `stub(schema) -> object` — a minimal value satisfying `schema`, for dry-run.
  - `render_contract(schema) -> str` — the prompt text telling a subagent what shape to return.

- [ ] **Step 1: Write the failing test**

Create `tests/test_workflow_schema.py`:

```python
"""Offline tests for the workflow JSON-Schema subset: validation, dry-run stub
generation, and contract rendering. No network, no LLM."""
import sys as _sys, os as _os
_sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))

from workflows import schema as S

FINDINGS = {
    "type": "object",
    "properties": {
        "findings": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "severity": {"type": "string", "enum": ["low", "high"]},
                },
                "required": ["title", "severity"],
            },
        }
    },
    "required": ["findings"],
}


def test_valid_object_passes():
    ok = {"findings": [{"title": "t", "severity": "high"}]}
    assert S.validate(ok, FINDINGS) == []


def test_missing_required_is_reported_with_path():
    errs = S.validate({"findings": [{"title": "t"}]}, FINDINGS)
    assert len(errs) == 1
    assert "$.findings[0]" in errs[0] and "severity" in errs[0]


def test_wrong_type_reports_expected_and_got():
    errs = S.validate({"findings": "nope"}, FINDINGS)
    assert len(errs) == 1
    assert "expected array" in errs[0] and "got str" in errs[0]


def test_enum_violation_is_reported():
    errs = S.validate({"findings": [{"title": "t", "severity": "medium"}]}, FINDINGS)
    assert len(errs) == 1 and "medium" in errs[0]


def test_additional_properties_false_is_enforced():
    sch = {"type": "object", "properties": {"a": {"type": "string"}},
           "additionalProperties": False}
    errs = S.validate({"a": "x", "b": 1}, sch)
    assert len(errs) == 1 and "b" in errs[0]


def test_integer_is_not_satisfied_by_bool():
    # bool is an int subclass in Python; a schema asking for integer must reject True.
    errs = S.validate(True, {"type": "integer"})
    assert len(errs) == 1


def test_stub_satisfies_its_own_schema():
    assert S.validate(S.stub(FINDINGS), FINDINGS) == []


def test_stub_array_is_non_empty_so_downstream_loops_execute():
    # A dry-run whose stub arrays were empty would never enter the loops that
    # consume them, defeating the point of dry-run.
    assert len(S.stub(FINDINGS)["findings"]) >= 1


def test_stub_uses_first_enum_value():
    assert S.stub({"type": "string", "enum": ["alpha", "beta"]}) == "alpha"


def test_render_contract_mentions_json_and_required_fields():
    text = S.render_contract(FINDINGS)
    assert "JSON" in text and "findings" in text


if __name__ == "__main__":
    tests = [test_valid_object_passes, test_missing_required_is_reported_with_path,
             test_wrong_type_reports_expected_and_got, test_enum_violation_is_reported,
             test_additional_properties_false_is_enforced,
             test_integer_is_not_satisfied_by_bool,
             test_stub_satisfies_its_own_schema,
             test_stub_array_is_non_empty_so_downstream_loops_execute,
             test_stub_uses_first_enum_value,
             test_render_contract_mentions_json_and_required_fields]
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

Run: `python tests/test_workflow_schema.py`
Expected: FAIL — `ModuleNotFoundError: No module named 'workflows'`

- [ ] **Step 3: Write minimal implementation**

Create `workflows/__init__.py` as an empty file (populated in Task 8).

Create `workflows/schema.py`:

```python
"""A deliberately small JSON-Schema subset: enough to constrain what a subagent
returns, small enough to carry no dependency.

`jsonschema` is NOT used on purpose — requirements.txt documents why a portable
lockfile is impractical for this project, and 7 pinned direct dependencies is
worth protecting. The supported keywords are exactly those the workflow library
needs: type, properties, required, items, enum, additionalProperties, minItems.

The same module both VALIDATES real returns and GENERATES dry-run stubs, so a
stub can never lie about the contract it stands in for.
"""
import json

_TYPE_CHECKS = {
    "object": lambda v: isinstance(v, dict),
    "array": lambda v: isinstance(v, list),
    "string": lambda v: isinstance(v, str),
    "number": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
    # bool is an int subclass in Python; an "integer" field must not accept True.
    "integer": lambda v: isinstance(v, int) and not isinstance(v, bool),
    "boolean": lambda v: isinstance(v, bool),
    "null": lambda v: v is None,
}


def _typename(v):
    return type(v).__name__


def validate(value, schema, path="$"):
    """Return a list of human-readable error strings; empty means valid.

    Errors name the PATH, the EXPECTATION and what was actually received, because
    they are fed back to the subagent verbatim as a repair message — a bare
    "invalid" gives it nothing to correct."""
    errors = []
    if not isinstance(schema, dict):
        return errors

    want = schema.get("type")
    if want:
        check = _TYPE_CHECKS.get(want)
        if check and not check(value):
            return [f"{path}: expected {want}, got {_typename(value)}"]

    if "enum" in schema and value not in schema["enum"]:
        allowed = ", ".join(json.dumps(e) for e in schema["enum"])
        return [f"{path}: {json.dumps(value)} is not one of [{allowed}]"]

    if isinstance(value, dict):
        props = schema.get("properties") or {}
        for req in schema.get("required") or []:
            if req not in value:
                errors.append(f"{path}: missing required property '{req}'")
        if schema.get("additionalProperties") is False:
            for key in value:
                if key not in props:
                    errors.append(f"{path}: unexpected property '{key}'")
        for key, sub in props.items():
            if key in value:
                errors.extend(validate(value[key], sub, f"{path}.{key}"))

    if isinstance(value, list):
        min_items = schema.get("minItems")
        if isinstance(min_items, int) and len(value) < min_items:
            errors.append(f"{path}: expected at least {min_items} items, got {len(value)}")
        item_schema = schema.get("items")
        if isinstance(item_schema, dict):
            for i, item in enumerate(value):
                errors.extend(validate(item, item_schema, f"{path}[{i}]"))

    return errors


def stub(schema):
    """A minimal value satisfying `schema`, used by dry-run so a script's control
    flow executes without spending a token.

    Arrays get ONE element rather than zero: an empty stub array would skip the
    very loops dry-run exists to exercise."""
    if not isinstance(schema, dict):
        return None
    if "enum" in schema and schema["enum"]:
        return schema["enum"][0]

    want = schema.get("type")
    if want == "object":
        out = {}
        props = schema.get("properties") or {}
        # Required first, then every declared property — a script commonly reads
        # optional fields, and a missing key would raise KeyError during dry-run.
        for key, sub in props.items():
            out[key] = stub(sub)
        for req in schema.get("required") or []:
            out.setdefault(req, "stub")
        return out
    if want == "array":
        item_schema = schema.get("items")
        count = max(1, int(schema.get("minItems") or 1))
        return [stub(item_schema) for _ in range(count)]
    if want == "string":
        return "stub"
    if want == "integer":
        return 1
    if want == "number":
        return 1.0
    if want == "boolean":
        return True
    if want == "null":
        return None
    return "stub"


def render_contract(schema):
    """The prompt fragment that tells a subagent what shape to return. Appended
    to its system prompt by subagents._build_messages."""
    return (
        "STRUCTURED OUTPUT REQUIRED.\n"
        "Your final_answer's \"content\" MUST be a JSON value matching this schema "
        "exactly. Do not wrap it in prose, markdown fences, or explanation:\n"
        + json.dumps(schema, indent=2)
    )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python tests/test_workflow_schema.py`
Expected: 10 × `PASS`, then `OK`, exit 0

- [ ] **Step 5: Commit**

```bash
git add workflows/__init__.py workflows/schema.py tests/test_workflow_schema.py
git commit -m "feat(workflows): dependency-free JSON-Schema subset with dry-run stub generation"
```

---

### Task 2: The sandbox — AST wrapping, meta extraction, determinism guards

**Files:**
- Create: `workflows/sandbox.py`
- Test: `tests/test_workflow_sandbox.py`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `class WorkflowScriptError(Exception)` — raised for any authoring fault; message is fed back to the model.
  - `extract_meta(src) -> dict` — the `meta` literal.
  - `compile_workflow(src, filename="<workflow>") -> code` — a code object that, when exec'd, defines `__workflow__`.
  - `make_namespace(primitives: dict, args) -> dict` — the globals a script runs with.
  - `ALLOWED_IMPORTS: frozenset[str]`, `BLOCKED_NAMES: frozenset[str]`.

- [ ] **Step 1: Write the failing test**

Create `tests/test_workflow_sandbox.py`:

```python
"""Offline tests for the workflow sandbox: AST wrapping (so top-level `return`
works), meta extraction, determinism guards, and the import whitelist."""
import sys as _sys, os as _os
_sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))

from workflows import sandbox as SB

GOOD = '''
meta = {"name": "demo", "description": "a demo", "phases": [{"title": "One"}]}

total = 0
for i in [1, 2, 3]:
    total += i
return {"total": total}
'''


def _run(src, primitives=None, args=None):
    code = SB.compile_workflow(src)
    ns = SB.make_namespace(primitives or {}, args)
    exec(code, ns)
    return ns["__workflow__"]()


def test_top_level_return_is_legal_and_returns_its_value():
    assert _run(GOOD) == {"total": 6}


def test_meta_is_extracted_without_running_the_script():
    meta = SB.extract_meta(GOOD)
    assert meta["name"] == "demo"
    assert meta["phases"] == [{"title": "One"}]


def test_missing_meta_is_rejected():
    try:
        SB.extract_meta("x = 1\n")
        raise AssertionError("expected WorkflowScriptError")
    except SB.WorkflowScriptError as e:
        assert "meta" in str(e)


def test_non_literal_meta_is_rejected():
    # meta is read BEFORE the script runs, so it cannot contain computed values.
    src = 'name = "x"\nmeta = {"name": name, "description": "d"}\n'
    try:
        SB.extract_meta(src)
        raise AssertionError("expected WorkflowScriptError")
    except SB.WorkflowScriptError as e:
        assert "literal" in str(e).lower()


def test_meta_missing_required_field_is_rejected():
    try:
        SB.extract_meta('meta = {"name": "x"}\n')
        raise AssertionError("expected WorkflowScriptError")
    except SB.WorkflowScriptError as e:
        assert "description" in str(e)


def test_syntax_error_is_wrapped_with_line_number():
    try:
        SB.compile_workflow('meta = {"name":"a","description":"b"}\nif True\n    pass\n')
        raise AssertionError("expected WorkflowScriptError")
    except SB.WorkflowScriptError as e:
        assert "line" in str(e).lower()


def test_primitives_are_callable_from_the_script():
    src = ('meta = {"name": "a", "description": "b"}\n'
           'log("hi")\n'
           'return "done"\n')
    seen = []
    assert _run(src, primitives={"log": seen.append}) == "done"
    assert seen == ["hi"]


def test_args_are_exposed():
    src = 'meta = {"name": "a", "description": "b"}\nreturn args["k"]\n'
    assert _run(src, args={"k": 42}) == 42


def test_args_is_none_when_not_provided():
    src = 'meta = {"name": "a", "description": "b"}\nreturn args\n'
    assert _run(src) is None


def test_whitelisted_import_works():
    src = ('meta = {"name": "a", "description": "b"}\n'
           'import json\n'
           'return json.dumps({"a": 1})\n')
    assert _run(src) == '{"a": 1}'


def test_blocked_import_raises_with_the_fix_named():
    src = ('meta = {"name": "a", "description": "b"}\n'
           'import random\n'
           'return 1\n')
    try:
        _run(src)
        raise AssertionError("expected WorkflowScriptError")
    except SB.WorkflowScriptError as e:
        assert "random" in str(e) and "args" in str(e)


def test_nondeterministic_builtin_is_blocked():
    # Resume replays cached results; a script that can diverge on replay makes
    # the journal meaningless.
    src = ('meta = {"name": "a", "description": "b"}\n'
           'import time\n'
           'return time.time()\n')
    try:
        _run(src)
        raise AssertionError("expected WorkflowScriptError")
    except SB.WorkflowScriptError:
        pass


def test_open_is_not_in_the_namespace():
    src = ('meta = {"name": "a", "description": "b"}\n'
           'return open("x")\n')
    try:
        _run(src)
        raise AssertionError("expected NameError or WorkflowScriptError")
    except (NameError, SB.WorkflowScriptError):
        pass


def test_safe_builtins_are_available():
    src = ('meta = {"name": "a", "description": "b"}\n'
           'return sorted(set([3, 1, 2]))[0] + len("ab") + max(1, 5)\n')
    assert _run(src) == 8


if __name__ == "__main__":
    tests = [test_top_level_return_is_legal_and_returns_its_value,
             test_meta_is_extracted_without_running_the_script,
             test_missing_meta_is_rejected, test_non_literal_meta_is_rejected,
             test_meta_missing_required_field_is_rejected,
             test_syntax_error_is_wrapped_with_line_number,
             test_primitives_are_callable_from_the_script, test_args_are_exposed,
             test_args_is_none_when_not_provided, test_whitelisted_import_works,
             test_blocked_import_raises_with_the_fix_named,
             test_nondeterministic_builtin_is_blocked,
             test_open_is_not_in_the_namespace, test_safe_builtins_are_available]
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

Run: `python tests/test_workflow_sandbox.py`
Expected: FAIL — `ImportError: cannot import name 'sandbox'`

- [ ] **Step 3: Write minimal implementation**

Create `workflows/sandbox.py`:

```python
"""Turning workflow SOURCE into something runnable.

Two problems this module exists to solve:

1. The agreed script form ends in `return {...}`, which is a SyntaxError at
   Python module level. Rather than ask authors to wrap everything in a function
   (and rather than rewrite indentation, which breaks on multi-line strings), the
   module body is lifted into a synthesized `def __workflow__():` at the AST
   level. `return` becomes legal and no source text is touched.

2. Resume replays cached agent results. A script that can produce different
   values on replay makes the journal a liar, so time/randomness are blocked and
   imports are whitelisted.

This is a CORRECTNESS boundary, not a security one. The agent already runs
arbitrary shell through host_exec; anyone reading this should not mistake it for
a sandbox that contains a hostile script.
"""
import ast

ALLOWED_IMPORTS = frozenset({"json", "math", "re", "itertools", "collections", "textwrap"})

# Blocked because they break replay determinism. The error names the fix.
BLOCKED_NAMES = frozenset({"time", "random", "datetime", "os", "sys", "secrets", "uuid"})

_META_REQUIRED = ("name", "description")

# A small, deliberate builtins surface. Everything a workflow legitimately needs
# for list/dict wrangling; nothing that touches the filesystem or the import
# system directly.
_SAFE_BUILTINS = {
    "abs": abs, "all": all, "any": any, "bool": bool, "dict": dict,
    "enumerate": enumerate, "filter": filter, "float": float, "int": int,
    "isinstance": isinstance, "len": len, "list": list, "map": map, "max": max,
    "min": min, "range": range, "repr": repr, "reversed": reversed,
    "round": round, "set": set, "setattr": setattr, "sorted": sorted, "str": str,
    "sum": sum, "tuple": tuple, "zip": zip, "print": print,
    "True": True, "False": False, "None": None,
    "Exception": Exception, "ValueError": ValueError, "KeyError": KeyError,
    "TypeError": TypeError, "IndexError": IndexError,
}


class WorkflowScriptError(Exception):
    """An authoring fault. The message is fed back to the model verbatim, so it
    must say what is wrong AND what to do instead."""


def _guarded_import(name, globals=None, locals=None, fromlist=(), level=0):
    root = name.split(".")[0]
    if root in BLOCKED_NAMES:
        raise WorkflowScriptError(
            f"'{root}' is not available inside a workflow: replay-determinism "
            f"requires that a script produce the same values on resume. "
            f"Pass timestamps, random seeds, or paths in via `args` instead."
        )
    if root not in ALLOWED_IMPORTS:
        raise WorkflowScriptError(
            f"'{root}' is not importable inside a workflow. Allowed: "
            f"{', '.join(sorted(ALLOWED_IMPORTS))}. Do the work in a subagent "
            f"via agent(...) rather than in the orchestration script."
        )
    return __import__(name, globals, locals, fromlist, level)


def _parse(src):
    try:
        return ast.parse(src)
    except SyntaxError as e:
        raise WorkflowScriptError(
            f"workflow script has a syntax error on line {e.lineno}: {e.msg}"
        ) from e


def extract_meta(src):
    """Read the module-level `meta = {...}` literal WITHOUT running the script.

    It must be a pure literal: meta is read to render the progress UI and the
    library listing before a single statement executes, so it cannot depend on
    anything the script computes."""
    tree = _parse(src)
    for node in tree.body:
        if not isinstance(node, ast.Assign):
            continue
        if not any(isinstance(t, ast.Name) and t.id == "meta" for t in node.targets):
            continue
        try:
            meta = ast.literal_eval(node.value)
        except (ValueError, SyntaxError) as e:
            raise WorkflowScriptError(
                "`meta` must be a pure literal dict — no variables, function "
                "calls, comprehensions, or f-strings. It is read before the "
                "script runs."
            ) from e
        if not isinstance(meta, dict):
            raise WorkflowScriptError("`meta` must be a dict literal.")
        missing = [f for f in _META_REQUIRED if not meta.get(f)]
        if missing:
            raise WorkflowScriptError(
                f"`meta` is missing required field(s): {', '.join(missing)}. "
                f"Required: {', '.join(_META_REQUIRED)}."
            )
        return meta
    raise WorkflowScriptError(
        "workflow script must start with a `meta = {...}` literal containing at "
        "least `name` and `description`."
    )


def compile_workflow(src, filename="<workflow>"):
    """Compile `src` into a code object that defines `__workflow__()`.

    The module body (minus the `meta` assignment, which is already extracted) is
    lifted wholesale into a synthesized function so top-level `return` is legal."""
    tree = _parse(src)
    body = [n for n in tree.body
            if not (isinstance(n, ast.Assign)
                    and any(isinstance(t, ast.Name) and t.id == "meta"
                            for t in n.targets))]
    if not body:
        body = [ast.Return(value=ast.Constant(value=None))]

    fn = ast.FunctionDef(
        name="__workflow__",
        args=ast.arguments(posonlyargs=[], args=[], vararg=None, kwonlyargs=[],
                           kw_defaults=[], kwarg=None, defaults=[]),
        body=body, decorator_list=[], returns=None, type_params=[],
    )
    module = ast.Module(body=[fn], type_ignores=[])
    ast.fix_missing_locations(module)
    try:
        return compile(module, filename, "exec")
    except SyntaxError as e:
        # e.g. `return` used somewhere the wrap cannot make legal.
        raise WorkflowScriptError(
            f"workflow script could not be compiled (line {e.lineno}): {e.msg}"
        ) from e


def make_namespace(primitives, args=None):
    """The globals a workflow script executes with: safe builtins, the guarded
    importer, the runtime primitives, and `args`."""
    builtins = dict(_SAFE_BUILTINS)
    builtins["__import__"] = _guarded_import
    ns = {"__builtins__": builtins, "args": args}
    ns.update(primitives)
    return ns
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python tests/test_workflow_sandbox.py`
Expected: 14 × `PASS`, then `OK`, exit 0

Note: `ast.FunctionDef` requires `type_params=[]` on Python 3.12+. This project runs 3.14, so it is mandatory — omitting it raises `TypeError` at construction.

- [ ] **Step 5: Commit**

```bash
git add workflows/sandbox.py tests/test_workflow_sandbox.py
git commit -m "feat(workflows): AST-wrapped script sandbox with meta extraction and determinism guards"
```

---

### Task 3: The journal — content-addressed keys, append, replay

**Files:**
- Create: `workflows/journal.py`
- Test: `tests/test_workflow_journal.py`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `call_key(agent_type, prompt, opts) -> str` — 16 hex chars.
  - `class Journal` with `lookup(key) -> (hit: bool, result)`, `record(key, occ, entry: dict)`, `close()`, and attribute `had_write_agents: bool`.
  - `Journal(path, replay_from=None)` — `replay_from` is a path to a prior `journal.jsonl`.

- [ ] **Step 1: Write the failing test**

Create `tests/test_workflow_journal.py`:

```python
"""Offline tests for the workflow journal: content-addressed keys, append-per-call
durability, and resume replay."""
import sys as _sys, os as _os
_sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))

import json
import tempfile

from workflows import journal as J


def _tmp(name="journal.jsonl"):
    d = tempfile.mkdtemp(prefix="wfjournal-")
    return _os.path.join(d, name)


def test_key_is_stable_for_identical_inputs():
    a = J.call_key("researcher", "find the thing", {"tier": "cheap"})
    b = J.call_key("researcher", "find the thing", {"tier": "cheap"})
    assert a == b


def test_key_ignores_opts_ordering():
    a = J.call_key("researcher", "p", {"tier": "cheap", "model": "m"})
    b = J.call_key("researcher", "p", {"model": "m", "tier": "cheap"})
    assert a == b


def test_key_changes_with_prompt():
    assert J.call_key("researcher", "a", {}) != J.call_key("researcher", "b", {})


def test_key_changes_with_agent_type():
    assert J.call_key("researcher", "p", {}) != J.call_key("implementer", "p", {})


def test_record_then_replay_returns_the_result():
    path = _tmp()
    j = J.Journal(path)
    k = J.call_key("researcher", "p", {})
    j.record(k, 0, {"ok": True, "result": {"v": 1}})
    j.close()

    j2 = J.Journal(_tmp("second.jsonl"), replay_from=path)
    hit, result = j2.lookup(k)
    assert hit is True and result == {"v": 1}


def test_unmatched_key_is_a_miss():
    path = _tmp()
    j = J.Journal(path)
    j.record(J.call_key("researcher", "p", {}), 0, {"ok": True, "result": 1})
    j.close()
    j2 = J.Journal(_tmp("second.jsonl"), replay_from=path)
    hit, _ = j2.lookup(J.call_key("researcher", "DIFFERENT", {}))
    assert hit is False


def test_repeated_identical_calls_replay_in_order():
    # loop-until-dry reissues the SAME prompt; each occurrence must replay its own
    # recorded result, not the first one repeatedly.
    path = _tmp()
    j = J.Journal(path)
    k = J.call_key("researcher", "same", {})
    j.record(k, 0, {"ok": True, "result": "first"})
    j.record(k, 1, {"ok": True, "result": "second"})
    j.close()

    j2 = J.Journal(_tmp("second.jsonl"), replay_from=path)
    assert j2.lookup(k) == (True, "first")
    assert j2.lookup(k) == (True, "second")
    assert j2.lookup(k)[0] is False   # third call was never recorded


def test_replay_is_order_independent():
    # parallel/pipeline have no deterministic call order, so a resumed run must
    # match on CONTENT, not on position. Look up in the reverse of record order.
    path = _tmp()
    j = J.Journal(path)
    ka = J.call_key("researcher", "A", {})
    kb = J.call_key("researcher", "B", {})
    j.record(ka, 0, {"ok": True, "result": "ra"})
    j.record(kb, 0, {"ok": True, "result": "rb"})
    j.close()

    j2 = J.Journal(_tmp("second.jsonl"), replay_from=path)
    assert j2.lookup(kb) == (True, "rb")
    assert j2.lookup(ka) == (True, "ra")


def test_journal_is_readable_after_a_crash_mid_run():
    # Each record is flushed immediately, so a killed process still resumes.
    path = _tmp()
    j = J.Journal(path)
    j.record(J.call_key("researcher", "p", {}), 0, {"ok": True, "result": 1})
    # deliberately NOT closed — simulating a kill
    with open(path, "r", encoding="utf-8") as f:
        lines = [json.loads(ln) for ln in f if ln.strip()]
    assert len(lines) == 1 and lines[0]["result"] == 1


def test_write_agent_presence_is_tracked_for_the_resume_warning():
    path = _tmp()
    j = J.Journal(path)
    j.record(J.call_key("implementer", "p", {}), 0,
             {"ok": True, "result": 1, "is_write": True})
    j.close()
    j2 = J.Journal(_tmp("second.jsonl"), replay_from=path)
    assert j2.had_write_agents is True


if __name__ == "__main__":
    tests = [test_key_is_stable_for_identical_inputs, test_key_ignores_opts_ordering,
             test_key_changes_with_prompt, test_key_changes_with_agent_type,
             test_record_then_replay_returns_the_result, test_unmatched_key_is_a_miss,
             test_repeated_identical_calls_replay_in_order,
             test_replay_is_order_independent,
             test_journal_is_readable_after_a_crash_mid_run,
             test_write_agent_presence_is_tracked_for_the_resume_warning]
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

Run: `python tests/test_workflow_journal.py`
Expected: FAIL — `ImportError: cannot import name 'journal'`

- [ ] **Step 3: Write minimal implementation**

Create `workflows/journal.py`:

```python
"""The workflow journal: every completed agent() call, appended as one JSON line.

Keys are CONTENT-ADDRESSED, not positional. That is the load-bearing decision in
this file. With parallel() and pipeline() there is no deterministic call ORDER —
the same script run twice issues its calls in whatever order threads win — so an
ordinal key would restore the wrong cached result into the wrong branch on
resume. Hashing (agent_type, prompt, opts) is order-independent, and it cascades
correctly for free: a changed upstream result changes the downstream prompt,
which changes its key, which re-runs it and everything derived from it.

An occurrence counter disambiguates genuinely repeated identical calls, which is
what a loop-until-dry pattern produces.
"""
import hashlib
import json
import os
import threading


def call_key(agent_type, prompt, opts=None):
    """16 hex chars identifying an agent call by its CONTENT."""
    canonical = json.dumps(opts or {}, sort_keys=True, default=str)
    blob = f"{agent_type or ''}\x00{prompt or ''}\x00{canonical}"
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:16]


class Journal:
    """Append-only writer plus an optional replay map loaded from a prior run.

    Thread-safe: agent() calls arrive from many branch threads at once."""

    def __init__(self, path, replay_from=None):
        self.path = path
        self._lock = threading.Lock()
        self._occ = {}          # key -> next occurrence index to WRITE
        self._replay = {}       # key -> [result, result, ...] in recorded order
        self._replay_occ = {}   # key -> next occurrence index to READ
        self.had_write_agents = False

        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        self._fh = open(path, "a", encoding="utf-8")

        if replay_from:
            self._load_replay(replay_from)

    def _load_replay(self, src):
        try:
            with open(src, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        entry = json.loads(line)
                    except ValueError:
                        continue    # a torn final line from a kill; skip it
                    key = entry.get("key")
                    if not key:
                        continue
                    self._replay.setdefault(key, []).append(entry.get("result"))
                    if entry.get("is_write"):
                        self.had_write_agents = True
        except OSError:
            pass    # no prior journal is simply a cold run

    def lookup(self, key):
        """(hit, result) for the NEXT occurrence of `key`. Consumes it."""
        with self._lock:
            bucket = self._replay.get(key)
            if not bucket:
                return (False, None)
            i = self._replay_occ.get(key, 0)
            if i >= len(bucket):
                return (False, None)
            self._replay_occ[key] = i + 1
            return (True, bucket[i])

    def next_occurrence(self, key):
        with self._lock:
            i = self._occ.get(key, 0)
            self._occ[key] = i + 1
            return i

    def record(self, key, occ, entry):
        """Append one completed call and FLUSH — a killed process must still
        resume everything that finished."""
        row = dict(entry)
        row["key"] = key
        row["occ"] = occ
        line = json.dumps(row, default=str, ensure_ascii=False)
        with self._lock:
            if entry.get("is_write"):
                self.had_write_agents = True
            self._fh.write(line + "\n")
            self._fh.flush()
            os.fsync(self._fh.fileno())

    def close(self):
        with self._lock:
            try:
                self._fh.close()
            except OSError:
                pass
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python tests/test_workflow_journal.py`
Expected: 10 × `PASS`, then `OK`, exit 0

- [ ] **Step 5: Commit**

```bash
git add workflows/journal.py tests/test_workflow_journal.py
git commit -m "feat(workflows): content-addressed journal with per-call durability and replay"
```

---

### Task 4: Structured output in `subagents.run_subagent`

**Files:**
- Modify: `subagents.py` — `_build_messages` (line 586), `_run_loop` final-answer branch (line 761), `run_subagent` signature (line 663), `_new_result` (line 580)
- Test: `tests/test_subagent_schema.py`

**Interfaces:**
- Consumes: `workflows.schema.validate`, `workflows.schema.render_contract`.
- Produces: `run_subagent(agent_def, task, ..., schema=None)`. When `schema` is given, the result dict gains `schema_ok: bool` and `raw_report` holds the **validated dict**. On persistent failure the result has `ok=False` and `note` naming the violations.

- [ ] **Step 1: Write the failing test**

Create `tests/test_subagent_schema.py`:

```python
"""Offline tests for schema-constrained subagent output: the contract goes into
the system prompt, a bad shape triggers a repair message, and three strikes fail
the call rather than returning a lie."""
import sys as _sys, os as _os
_sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))

import json

import subagents
from subagents import AgentDef

SCHEMA = {"type": "object",
          "properties": {"n": {"type": "integer"}},
          "required": ["n"]}


def _agent():
    return AgentDef(name="researcher", system_prompt="you research",
                    mode="read", allowed_tools=set(), max_steps=3)


def _script(replies, monkeypatch):
    """Replace ask_llm with a scripted sequence, capturing the messages it saw."""
    seen = {"messages": []}
    box = {"i": 0}

    def fake(messages, temperature=None, **kw):
        seen["messages"].append([dict(m) for m in messages])
        r = replies[min(box["i"], len(replies) - 1)]
        box["i"] += 1
        return r

    monkeypatch.setattr(subagents, "ask_llm", fake)
    return seen


def test_contract_is_injected_into_the_system_prompt(monkeypatch):
    seen = _script([json.dumps({"type": "final_answer", "content": {"n": 1}})], monkeypatch)
    subagents.run_subagent(_agent(), "task", schema=SCHEMA)
    system = seen["messages"][0][0]["content"]
    assert "STRUCTURED OUTPUT REQUIRED" in system
    assert '"n"' in system


def test_valid_structured_answer_is_returned_as_a_dict(monkeypatch):
    _script([json.dumps({"type": "final_answer", "content": {"n": 7}})], monkeypatch)
    res = subagents.run_subagent(_agent(), "task", schema=SCHEMA)
    assert res["ok"] is True
    assert res["schema_ok"] is True
    assert res["raw_report"] == {"n": 7}


def test_bad_shape_gets_a_repair_message_naming_the_violation(monkeypatch):
    seen = _script([
        json.dumps({"type": "final_answer", "content": {"n": "not-an-int"}}),
        json.dumps({"type": "final_answer", "content": {"n": 3}}),
    ], monkeypatch)
    res = subagents.run_subagent(_agent(), "task", schema=SCHEMA)
    assert res["ok"] is True and res["raw_report"] == {"n": 3}
    # The second call must have carried a repair message describing the error.
    repair = seen["messages"][1][-1]["content"]
    assert "expected integer" in repair and "$.n" in repair


def test_three_strikes_fails_the_call(monkeypatch):
    _script([json.dumps({"type": "final_answer", "content": {"n": "bad"}})], monkeypatch)
    res = subagents.run_subagent(_agent(), "task", schema=SCHEMA)
    assert res["ok"] is False
    assert res["schema_ok"] is False
    assert "schema" in (res.get("note") or "").lower()


def test_json_string_content_is_parsed_before_validation(monkeypatch):
    # Models routinely return the JSON as a STRING rather than a nested object.
    _script([json.dumps({"type": "final_answer", "content": '{"n": 5}'})], monkeypatch)
    res = subagents.run_subagent(_agent(), "task", schema=SCHEMA)
    assert res["ok"] is True and res["raw_report"] == {"n": 5}


def test_no_schema_keeps_the_legacy_text_behaviour(monkeypatch):
    _script([json.dumps({"type": "final_answer", "content": "just prose"})], monkeypatch)
    res = subagents.run_subagent(_agent(), "task")
    assert res["ok"] is True and res["report"] == "just prose"
    assert res.get("schema_ok") is None


if __name__ == "__main__":
    import types
    monkeypatch = types.SimpleNamespace(setattr=lambda o, n, v: setattr(o, n, v))
    tests = [test_contract_is_injected_into_the_system_prompt,
             test_valid_structured_answer_is_returned_as_a_dict,
             test_bad_shape_gets_a_repair_message_naming_the_violation,
             test_three_strikes_fails_the_call,
             test_json_string_content_is_parsed_before_validation,
             test_no_schema_keeps_the_legacy_text_behaviour]
    failed = 0
    _orig = subagents.ask_llm
    for t in tests:
        try:
            t(monkeypatch); print(f"PASS {t.__name__}")
        except Exception as e:
            failed += 1
            import traceback; traceback.print_exc()
            print(f"FAIL {t.__name__}: {e}")
        finally:
            subagents.ask_llm = _orig
    print("OK" if not failed else f"{failed} FAILED")
    _sys.exit(1 if failed else 0)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python tests/test_subagent_schema.py`
Expected: FAIL — `run_subagent() got an unexpected keyword argument 'schema'`

- [ ] **Step 3: Write minimal implementation**

Four edits to `subagents.py`.

**3a.** Add the import near the existing imports at the top:

```python
from workflows import schema as _wf_schema
```

**3b.** `_new_result` (line 580) — add the field so its absence is meaningful:

```python
def _new_result(agent_def):
    return {"agent": agent_def.name, "ok": False, "report": "", "raw_report": None,
            "artifacts": [], "verified": None, "steps": 0, "tools_used": [],
            "note": "", "tokens": 0, "model": None, "escalated": False,
            "schema_ok": None}
```

(Keep any existing keys not shown here — this adds `schema_ok` only.)

**3c.** `_build_messages` (line 586) — accept and append the contract:

```python
def _build_messages(agent_def, allowed, task, context, run_dir, schema=None):
    ...
    parts.append(tool_prompt)
    if schema:
        parts.append(_wf_schema.render_contract(schema))
    system_prompt = "\n\n".join(p for p in parts if p)
```

**3d.** `_run_loop` final-answer branch (line 761) — the repair loop:

```python
        if rtype == "final_answer":
            if schema:
                candidate = payload
                # Models routinely hand back the JSON as a STRING. Parse before
                # validating, or every structured call fails on shape.
                if isinstance(candidate, str):
                    try:
                        candidate = json.loads(strip_reasoning(candidate).strip())
                    except ValueError:
                        candidate = payload
                errors = _wf_schema.validate(candidate, schema)
                if errors:
                    schema_tries += 1
                    if schema_tries >= SCHEMA_MAX_TRIES:
                        note = "; ".join(p for p in (
                            result.get("note"),
                            "schema validation failed after "
                            f"{SCHEMA_MAX_TRIES} attempts: " + "; ".join(errors[:3])
                        ) if p)
                        result.update(ok=False, schema_ok=False, steps=steps,
                                      tools_used=tools_used, note=note, tokens=tokens)
                        return result
                    messages.append({"role": "user", "content": (
                        "[SYSTEM] Your final_answer did not match the required "
                        "schema. Fix these and answer again:\n- "
                        + "\n- ".join(errors[:8])
                    )})
                    continue
                result.update(ok=True, schema_ok=True,
                              report=_content_to_text(candidate),
                              raw_report=candidate, steps=steps,
                              tools_used=tools_used, tokens=tokens)
                return result
            result.update(ok=True, report=_content_to_text(payload), raw_report=payload,
                          steps=steps, tools_used=tools_used, tokens=tokens)
            return result
```

Also in `_run_loop`, add `schema=None` to the signature, and initialise `schema_tries = 0` beside the other counters near line 745. Add the module constant near the other caps:

```python
SCHEMA_MAX_TRIES = 3   # initial answer + 2 repairs
```

**Important:** the two paths that return `ok=True` WITHOUT going through the
final-answer branch — the 3-error `salvage` path and `_force_final` — must not
claim success under a schema. In both, when `schema` is set, mark the result:

```python
            if parse_errors >= 3:
                if schema:
                    result.update(ok=False, schema_ok=False, steps=steps,
                                  tools_used=tools_used, tokens=tokens,
                                  note="; ".join(p for p in (result.get("note"),
                                       "non-JSON output could not satisfy the schema") if p))
                    return result
                salvage = strip_reasoning(raw)
                ...
```

and pass `schema` into `_force_final` so it applies the same rule before returning.

**3e.** `run_subagent` (line 663) — thread it through:

```python
def run_subagent(agent_def, task, context="", run_dir=None, on_event=None,
                 tier=None, models=None, scope=None, schema=None):
    ...
        messages = _build_messages(agent_def, allowed, task, context, run_dir, schema=schema)
    ...
        out = _run_loop(agent_def, messages, allowed, temperature, max_steps, result,
                        on_event=on_event, agent_name=agent_def.name, max_steps_total=max_steps,
                        started=started, key_label=_mask(key), sub_id=sub_id,
                        ladder=ladder, key=key, schema=schema)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python tests/test_subagent_schema.py`
Expected: 6 × `PASS`, then `OK`, exit 0

Then confirm nothing regressed in the existing suite:

Run: `.venv/Scripts/python.exe -m pytest tests/ -q --ignore=tests/frontend`
Expected: **3 failed, 253 passed, 1 skipped** plus your new tests in the passed count. Those same 3 pre-existing environmental failures and NO others (see Global Constraints).

- [ ] **Step 5: Commit**

```bash
git add subagents.py tests/test_subagent_schema.py
git commit -m "feat(subagents): schema-constrained final answers with a bounded repair loop"
```

---

### Task 5: Runtime core — semaphore, `agent()`, `phase()`, `log()`

**Files:**
- Create: `workflows/runtime.py`
- Test: `tests/test_workflow_runtime.py` (created here, extended in Task 6)

**Interfaces:**
- Consumes: `workflows.journal.Journal`/`call_key`, `workflows.schema`, `subagents.run_subagent`, `plugins.get_agent`.
- Produces:
  - `class WorkflowAborted(Exception)`
  - `class WorkflowRuntime(journal, on_event=None, run_dir=None, dry_run=False, concurrency=None, run_id="", emit_prefix="")` with methods `agent`, `phase`, `log`, `abort`, `primitives()`, and attributes `agent_count`, `aborted`.
  - `default_concurrency() -> int`

- [ ] **Step 1: Write the failing test**

Create `tests/test_workflow_runtime.py`:

```python
"""Offline tests for the workflow runtime. A fake run_subagent stands in for the
LLM everywhere, so these are pure control-flow assertions."""
import sys as _sys, os as _os
_sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))

import tempfile
import threading

import subagents
from workflows import journal as J
from workflows import runtime as R


class FakeAgentDef:
    def __init__(self, name, is_write=False):
        self.name = name
        self.is_write = is_write
        self.mode = "write" if is_write else "read"


def _install(monkeypatch, handler, agents=("researcher", "implementer")):
    """Point the runtime at a fake subagent engine and a fake persona registry."""
    monkeypatch.setattr(R, "run_subagent", handler)
    monkeypatch.setattr(R, "get_agent",
               lambda n: FakeAgentDef(n, is_write=(n == "implementer"))
               if n in agents else None)


def _rt(dry_run=False, concurrency=None):
    d = tempfile.mkdtemp(prefix="wfrt-")
    j = J.Journal(_os.path.join(d, "journal.jsonl"))
    return R.WorkflowRuntime(j, run_dir=d, dry_run=dry_run, concurrency=concurrency)


def test_agent_returns_the_report_text(monkeypatch):
    _install(monkeypatch, lambda *a, **k: {"ok": True, "report": "hello", "raw_report": "hello",
                                  "tokens": 5, "model": "m"})
    rt = _rt()
    assert rt.agent("do a thing") == "hello"


def test_agent_returns_the_validated_dict_when_a_schema_is_given(monkeypatch):
    _install(monkeypatch, lambda *a, **k: {"ok": True, "report": "{}", "raw_report": {"n": 1},
                                  "schema_ok": True, "tokens": 5})
    rt = _rt()
    out = rt.agent("p", schema={"type": "object", "properties": {"n": {"type": "integer"}}})
    assert out == {"n": 1}


def test_failed_agent_returns_none_rather_than_raising(monkeypatch):
    _install(monkeypatch, lambda *a, **k: {"ok": False, "report": "boom", "raw_report": None})
    rt = _rt()
    assert rt.agent("p") is None


def test_unknown_agent_type_raises(monkeypatch):
    _install(monkeypatch, lambda *a, **k: {"ok": True, "report": "x"})
    rt = _rt()
    try:
        rt.agent("p", agent_type="nope")
        raise AssertionError("expected WorkflowScriptError")
    except Exception as e:
        assert "nope" in str(e)


def test_write_agent_without_scope_is_rejected(monkeypatch):
    _install(monkeypatch, lambda *a, **k: {"ok": True, "report": "x"})
    rt = _rt()
    try:
        rt.agent("edit it", agent_type="implementer")
        raise AssertionError("expected a scope error")
    except Exception as e:
        assert "scope" in str(e).lower()


def test_write_agent_with_scope_is_allowed(monkeypatch):
    _install(monkeypatch, lambda *a, **k: {"ok": True, "report": "done", "raw_report": "done"})
    rt = _rt()
    assert rt.agent("edit it", agent_type="implementer", scope=["src/"]) == "done"


def test_dry_run_never_calls_the_engine_and_returns_schema_stubs(monkeypatch):
    called = {"n": 0}

    def boom(*a, **k):
        called["n"] += 1
        raise AssertionError("dry-run must not reach the engine")

    _install(monkeypatch, boom)
    rt = _rt(dry_run=True)
    sch = {"type": "object", "properties": {"n": {"type": "integer"}}, "required": ["n"]}
    out = rt.agent("p", schema=sch)
    assert out == {"n": 1} and called["n"] == 0


def test_dry_run_without_schema_returns_a_string(monkeypatch):
    _install(monkeypatch, lambda *a, **k: {"ok": True, "report": "x"})
    rt = _rt(dry_run=True)
    assert isinstance(rt.agent("p"), str)


def test_cached_result_is_replayed_without_calling_the_engine(monkeypatch):
    d = tempfile.mkdtemp(prefix="wfrt-")
    path = _os.path.join(d, "journal.jsonl")
    j = J.Journal(path)
    k = J.call_key("researcher", "p", {})
    j.record(k, 0, {"ok": True, "result": "from-cache"})
    j.close()

    called = {"n": 0}

    def counter(*a, **kw):
        called["n"] += 1
        return {"ok": True, "report": "fresh", "raw_report": "fresh"}

    _install(monkeypatch, counter)
    j2 = J.Journal(_os.path.join(d, "second.jsonl"), replay_from=path)
    rt = R.WorkflowRuntime(j2, run_dir=d)
    assert rt.agent("p") == "from-cache"
    assert called["n"] == 0


def test_concurrency_never_exceeds_the_semaphore(monkeypatch):
    live = {"now": 0, "peak": 0}
    lock = threading.Lock()

    def slow(*a, **kw):
        with lock:
            live["now"] += 1
            live["peak"] = max(live["peak"], live["now"])
        # busy just long enough for overlap to be observable
        for _ in range(20000):
            pass
        with lock:
            live["now"] -= 1
        return {"ok": True, "report": "x", "raw_report": "x"}

    _install(monkeypatch, slow)
    rt = _rt(concurrency=2)
    threads = [threading.Thread(target=lambda i=i: rt.agent(f"p{i}")) for i in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert live["peak"] <= 2


def test_abort_stops_further_agent_calls(monkeypatch):
    _install(monkeypatch, lambda *a, **k: {"ok": True, "report": "x", "raw_report": "x"})
    rt = _rt()
    rt.agent("first")
    rt.abort()
    try:
        rt.agent("second")
        raise AssertionError("expected WorkflowAborted")
    except R.WorkflowAborted:
        pass


def test_phase_from_a_branch_thread_raises_with_the_fix_named(monkeypatch):
    _install(monkeypatch, lambda *a, **k: {"ok": True, "report": "x"})
    rt = _rt()
    err = {}

    def branch():
        try:
            rt.phase("Nope")
        except Exception as e:
            err["e"] = e

    t = threading.Thread(target=branch)
    t.start(); t.join()
    assert "phase=" in str(err.get("e", ""))


def test_events_are_emitted_for_started_and_done(monkeypatch):
    _install(monkeypatch, lambda *a, **k: {"ok": True, "report": "x", "raw_report": "x",
                                  "tokens": 3})
    events = []
    d = tempfile.mkdtemp(prefix="wfrt-")
    j = J.Journal(_os.path.join(d, "journal.jsonl"))
    rt = R.WorkflowRuntime(j, run_dir=d, on_event=events.append)
    rt.phase("Scan")
    rt.agent("p", label="my-label")
    kinds = [e["type"] for e in events]
    assert "wf_phase" in kinds
    assert "wf_agent_started" in kinds and "wf_agent_done" in kinds
    started = [e for e in events if e["type"] == "wf_agent_started"][0]
    assert started["label"] == "my-label" and started["phase"] == "Scan"


def test_label_defaults_to_a_trimmed_prompt(monkeypatch):
    _install(monkeypatch, lambda *a, **k: {"ok": True, "report": "x", "raw_report": "x"})
    events = []
    d = tempfile.mkdtemp(prefix="wfrt-")
    j = J.Journal(_os.path.join(d, "journal.jsonl"))
    rt = R.WorkflowRuntime(j, run_dir=d, on_event=events.append)
    rt.agent("a very long prompt " * 10)
    label = [e for e in events if e["type"] == "wf_agent_started"][0]["label"]
    assert 0 < len(label) <= 48


if __name__ == "__main__":
    import types
    monkeypatch = types.SimpleNamespace(setattr=lambda o, n, v: setattr(o, n, v))
    tests = [test_agent_returns_the_report_text,
             test_agent_returns_the_validated_dict_when_a_schema_is_given,
             test_failed_agent_returns_none_rather_than_raising,
             test_unknown_agent_type_raises,
             test_write_agent_without_scope_is_rejected,
             test_write_agent_with_scope_is_allowed,
             test_dry_run_never_calls_the_engine_and_returns_schema_stubs,
             test_dry_run_without_schema_returns_a_string,
             test_cached_result_is_replayed_without_calling_the_engine,
             test_concurrency_never_exceeds_the_semaphore,
             test_abort_stops_further_agent_calls,
             test_phase_from_a_branch_thread_raises_with_the_fix_named,
             test_events_are_emitted_for_started_and_done,
             test_label_defaults_to_a_trimmed_prompt]
    failed = 0
    _orig_run, _orig_get = R.run_subagent, R.get_agent
    for t in tests:
        try:
            t(monkeypatch); print(f"PASS {t.__name__}")
        except Exception as e:
            failed += 1
            import traceback; traceback.print_exc()
            print(f"FAIL {t.__name__}: {e}")
        finally:
            R.run_subagent, R.get_agent = _orig_run, _orig_get
    print("OK" if not failed else f"{failed} FAILED")
    _sys.exit(1 if failed else 0)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python tests/test_workflow_runtime.py`
Expected: FAIL — `ImportError: cannot import name 'runtime'`

- [ ] **Step 3: Write minimal implementation**

Create `workflows/runtime.py`:

```python
"""The workflow runtime: the primitives a script actually calls.

CONCURRENCY, and why it is not a thread pool
--------------------------------------------
The obvious design — submit every agent() to one shared ThreadPoolExecutor —
DEADLOCKS. parallel() branches occupy every worker slot, then each branch calls
agent() and blocks waiting for a slot that only those same blocked branches
could free. Nothing ever completes.

So the relationship is inverted:
  * threads are unbounded and cheap — parallel() spawns one per branch,
    pipeline() one per item;
  * a SEMAPHORE, acquired inside agent(), caps real LLM concurrency.
A branch parked on the semaphore costs a few KB of committed stack, so hundreds
are fine. tests/test_workflow_runtime.py pins this with a deadlock regression
test that runs nested parallel/pipeline with the semaphore set to 1.
"""
import os
import threading
import time

from plugins import get_agent
from subagents import run_subagent

from . import journal as _journal
from . import schema as _schema
from .sandbox import WorkflowScriptError

MAX_ITEMS = 256          # per parallel()/pipeline() call
LABEL_CHARS = 48


class WorkflowAborted(Exception):
    """Raised inside a workflow once abort() has been requested."""


def default_concurrency():
    try:
        cpus = os.cpu_count() or 4
    except NotImplementedError:
        cpus = 4
    return max(1, min(16, cpus - 2))


def _label_from(prompt):
    text = " ".join((prompt or "").split())
    if len(text) <= LABEL_CHARS:
        return text
    cut = text[:LABEL_CHARS]
    space = cut.rfind(" ")
    return (cut[:space] if space > 12 else cut).rstrip()


class WorkflowRuntime:
    def __init__(self, journal, on_event=None, run_dir=None, dry_run=False,
                 concurrency=None, run_id="", emit_prefix=""):
        self.journal = journal
        self.on_event = on_event
        self.run_dir = run_dir
        self.dry_run = bool(dry_run)
        self.run_id = run_id
        self.emit_prefix = emit_prefix        # set for a nested workflow
        self._sem = threading.Semaphore(concurrency or default_concurrency())
        self._abort = threading.Event()
        self._phase = None
        self._main_thread = threading.get_ident()
        self._count_lock = threading.Lock()
        self.agent_count = 0

    # --- lifecycle --------------------------------------------------------
    @property
    def aborted(self):
        return self._abort.is_set()

    def abort(self):
        self._abort.set()

    def _check_abort(self):
        if self._abort.is_set():
            raise WorkflowAborted("workflow aborted")

    def _emit(self, ev):
        if not self.on_event:
            return
        ev = dict(ev)
        ev["run_id"] = self.run_id
        if self.emit_prefix:
            ev["group"] = self.emit_prefix
        try:
            self.on_event(ev)
        except Exception:
            pass      # telemetry must never take down a run

    # --- primitives -------------------------------------------------------
    def phase(self, title):
        """Start a progress group.

        Only legal on the script's main thread: it mutates runtime-global state,
        so two parallel branches calling it would scramble each other's grouping.
        Inside a branch, pass phase= on the agent() call instead."""
        if threading.get_ident() != self._main_thread:
            raise WorkflowScriptError(
                "phase() may only be called from the workflow's main body — "
                "two parallel branches calling it would race and scramble the "
                "progress tree. Inside a parallel()/pipeline() stage, pass "
                "phase=\"<title>\" on the agent() call instead."
            )
        self._phase = str(title)
        self._emit({"type": "wf_phase", "title": self._phase})

    def log(self, message):
        self._emit({"type": "wf_log", "message": str(message)})

    def agent(self, prompt, agent_type=None, label=None, phase=None, schema=None,
              model=None, tier=None, scope=None, context=""):
        self._check_abort()
        agent_type = agent_type or "researcher"
        label = label or _label_from(prompt)
        phase = phase or self._phase

        agent_def = get_agent(agent_type)
        if agent_def is None:
            raise WorkflowScriptError(
                f"unknown agent_type '{agent_type}'. Name one of the personas "
                f"listed in the run_workflow tool description."
            )
        # Scope is MANDATORY for a writer inside a workflow: ScopedWorkspaceLock
        # serializes overlapping owners, but an UNSCOPED writer takes the whole
        # workspace and would silently serialize an entire fan-out.
        if getattr(agent_def, "is_write", False) and not scope:
            raise WorkflowScriptError(
                f"write agent '{agent_type}' must declare scope=[...] inside a "
                f"workflow — the paths it owns. Unscoped writers take the whole "
                f"workspace and would serialize the fan-out."
            )

        opts = {"schema": schema, "model": model, "tier": tier,
                "scope": list(scope) if scope else None, "context": context or ""}
        key = _journal.call_key(agent_type, prompt, opts)

        hit, cached = self.journal.lookup(key)
        if hit:
            with self._count_lock:
                self.agent_count += 1
            self._emit({"type": "wf_agent_started", "phase": phase, "label": label,
                        "agent_type": agent_type, "model": model, "sub_id": key})
            self._emit({"type": "wf_agent_done", "sub_id": key, "ok": True,
                        "cached": True, "tokens": 0, "elapsed_s": 0.0})
            return cached

        if self.dry_run:
            return _schema.stub(schema) if schema else f"[dry-run:{label}]"

        occ = self.journal.next_occurrence(key)
        started = time.monotonic()
        with self._count_lock:
            self.agent_count += 1
        self._emit({"type": "wf_agent_started", "phase": phase, "label": label,
                    "agent_type": agent_type, "model": model, "sub_id": key})

        with self._sem:
            self._check_abort()
            kwargs = {"context": context or "", "run_dir": self.run_dir,
                      "schema": schema}
            if model:
                kwargs["models"] = [model]
            if tier:
                kwargs["tier"] = tier
            if scope:
                kwargs["scope"] = list(scope)
            res = run_subagent(agent_def, prompt, **kwargs)

        ok = bool(res.get("ok"))
        value = res.get("raw_report") if schema else res.get("report")
        if not ok:
            value = None
        elapsed = round(time.monotonic() - started, 2)

        self.journal.record(key, occ, {
            "ok": ok, "result": value, "phase": phase, "label": label,
            "agent_type": agent_type, "tokens": res.get("tokens", 0),
            "elapsed_s": elapsed, "model": res.get("model"),
            "is_write": bool(getattr(agent_def, "is_write", False)),
        })
        self._emit({"type": "wf_agent_done", "sub_id": key, "ok": ok,
                    "cached": False, "tokens": res.get("tokens", 0),
                    "elapsed_s": elapsed})
        return value

    def primitives(self):
        """The names injected into a script's namespace. parallel/pipeline are
        added in Task 6, workflow() in Task 14."""
        return {"agent": self.agent, "phase": self.phase, "log": self.log}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python tests/test_workflow_runtime.py`
Expected: 14 × `PASS`, then `OK`, exit 0

- [ ] **Step 5: Commit**

```bash
git add workflows/runtime.py tests/test_workflow_runtime.py
git commit -m "feat(workflows): runtime agent() with semaphore-capped concurrency, journal replay and dry-run"
```

---

### Task 6: `parallel()` and `pipeline()` — plus the deadlock regression guard

**Files:**
- Modify: `workflows/runtime.py` (add methods, extend `primitives()`)
- Modify: `tests/test_workflow_runtime.py` (append tests + runner entries)

**Interfaces:**
- Consumes: `WorkflowRuntime.agent` from Task 5.
- Produces: `WorkflowRuntime.parallel(thunks) -> list`, `WorkflowRuntime.pipeline(items, *stages) -> list`. Both appear in `primitives()`.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_workflow_runtime.py` (before the `__main__` block):

```python
def test_parallel_returns_results_in_input_order(monkeypatch):
    _install(monkeypatch, lambda ad, p, **k: {"ok": True, "report": p, "raw_report": p})
    rt = _rt()
    out = rt.parallel([lambda i=i: rt.agent(f"p{i}") for i in range(5)])
    assert out == ["p0", "p1", "p2", "p3", "p4"]


def test_parallel_isolates_a_raising_thunk_as_none(monkeypatch):
    _install(monkeypatch, lambda ad, p, **k: {"ok": True, "report": p, "raw_report": p})
    rt = _rt()

    def boom():
        raise ValueError("nope")

    out = rt.parallel([lambda: rt.agent("ok"), boom])
    assert out[0] == "ok" and out[1] is None


def test_parallel_actually_runs_concurrently(monkeypatch):
    gate = threading.Barrier(3, timeout=5)

    def waits(ad, p, **k):
        gate.wait()          # deadlocks and raises BrokenBarrier if serialized
        return {"ok": True, "report": p, "raw_report": p}

    _install(monkeypatch, waits)
    rt = _rt(concurrency=3)
    out = rt.parallel([lambda i=i: rt.agent(f"p{i}") for i in range(3)])
    assert out == ["p0", "p1", "p2"]


def test_pipeline_threads_each_item_through_every_stage(monkeypatch):
    _install(monkeypatch, lambda ad, p, **k: {"ok": True, "report": p, "raw_report": p})
    rt = _rt()
    out = rt.pipeline(
        ["a", "b"],
        lambda item, orig, i: rt.agent(f"one:{item}"),
        lambda prev, orig, i: f"{prev}|two:{orig}:{i}",
    )
    assert out == ["one:a|two:a:0", "one:b|two:b:1"]


def test_pipeline_stage_receives_original_item_and_index(monkeypatch):
    _install(monkeypatch, lambda ad, p, **k: {"ok": True, "report": "r", "raw_report": "r"})
    rt = _rt()
    seen = []
    rt.pipeline(["x", "y"],
                lambda item, orig, i: seen.append((item, orig, i)) or "s1",
                lambda prev, orig, i: seen.append((prev, orig, i)) or "s2")
    assert ("x", "x", 0) in seen and ("s1", "y", 1) in seen


def test_pipeline_drops_a_failing_item_to_none_and_skips_its_rest(monkeypatch):
    _install(monkeypatch, lambda ad, p, **k: {"ok": True, "report": "r", "raw_report": "r"})
    rt = _rt()
    reached = []

    def stage1(item, orig, i):
        if item == "bad":
            raise ValueError("nope")
        return item

    def stage2(prev, orig, i):
        reached.append(orig)
        return prev

    out = rt.pipeline(["good", "bad"], stage1, stage2)
    assert out[0] == "good" and out[1] is None
    assert reached == ["good"]      # the failed item never reached stage 2


def test_pipeline_has_no_barrier_between_stages(monkeypatch):
    # Item A must be able to reach stage 2 while item B is still in stage 1.
    # If a barrier existed, A would wait for B and this barrier would break.
    cross = threading.Barrier(2, timeout=5)
    _install(monkeypatch, lambda ad, p, **k: {"ok": True, "report": "r", "raw_report": "r"})
    rt = _rt(concurrency=4)

    def stage1(item, orig, i):
        if orig == "slow":
            cross.wait()        # released only by 'fast' arriving in stage 2
        return orig

    def stage2(prev, orig, i):
        if orig == "fast":
            cross.wait()
        return prev

    out = rt.pipeline(["slow", "fast"], stage1, stage2)
    assert sorted(x for x in out if x) == ["fast", "slow"]


def test_item_cap_is_an_explicit_error_not_a_silent_truncation(monkeypatch):
    _install(monkeypatch, lambda ad, p, **k: {"ok": True, "report": "r", "raw_report": "r"})
    rt = _rt()
    try:
        rt.parallel([lambda: None] * (R.MAX_ITEMS + 1))
        raise AssertionError("expected an error")
    except Exception as e:
        assert str(R.MAX_ITEMS) in str(e)


def test_nested_parallel_inside_pipeline_does_not_deadlock_at_concurrency_one(monkeypatch):
    """THE deadlock regression guard.

    A shared ThreadPoolExecutor design fails here: pipeline items take every
    worker slot, then each calls parallel() whose branches call agent() and wait
    for a slot only the blocked items could free. Threads-plus-a-semaphore does
    not, because threads are unbounded and only the semaphore is contended."""
    _install(monkeypatch, lambda ad, p, **k: {"ok": True, "report": p, "raw_report": p})
    rt = _rt(concurrency=1)
    out = rt.pipeline(
        ["a", "b", "c"],
        lambda item, orig, i: rt.parallel([lambda o=orig: rt.agent(f"x:{o}"),
                                           lambda o=orig: rt.agent(f"y:{o}")]),
        lambda prev, orig, i: rt.parallel([lambda p=prev: rt.agent(f"z:{p[0]}")]),
    )
    assert len(out) == 3
    assert out[0] == ["z:x:a"]
```

And extend the `__main__` runner list with those nine names.

- [ ] **Step 2: Run test to verify it fails**

Run: `python tests/test_workflow_runtime.py`
Expected: FAIL — `'WorkflowRuntime' object has no attribute 'parallel'`

- [ ] **Step 3: Write minimal implementation**

Add to `WorkflowRuntime` in `workflows/runtime.py`, above `primitives()`:

```python
    def _spawn(self, fns):
        """Run each zero-arg fn on its own thread; return results in input order.

        A raising fn resolves to None rather than propagating: one bad branch
        must not take down the wave. Threads are deliberately unbounded here —
        the semaphore inside agent() is what caps real work. See the module
        docstring for why a pool would deadlock."""
        if len(fns) > MAX_ITEMS:
            raise WorkflowScriptError(
                f"too many items: {len(fns)} exceeds the per-call cap of "
                f"{MAX_ITEMS}. Batch the work or narrow the input; the cap is an "
                f"explicit error rather than a silent truncation."
            )
        results = [None] * len(fns)
        threads = []

        def runner(i, fn):
            try:
                results[i] = fn()
            except WorkflowAborted:
                results[i] = None
            except Exception as e:      # noqa: BLE001 — isolated per branch
                results[i] = None
                self.log(f"branch {i} failed: {type(e).__name__}: {e}")

        for i, fn in enumerate(fns):
            t = threading.Thread(target=runner, args=(i, fn), daemon=True)
            threads.append(t)
            t.start()
        for t in threads:
            t.join()
        return results

    def parallel(self, thunks):
        """Run every thunk concurrently and WAIT for all of them — a barrier.

        Use only when a later stage genuinely needs all results together (dedup
        across the full set, an early exit on a zero count). Otherwise prefer
        pipeline(), which has no barrier."""
        self._check_abort()
        return self._spawn(list(thunks))

    def pipeline(self, items, *stages):
        """Run each item through every stage independently — NO barrier between
        stages. Item A can be in stage 3 while item B is still in stage 1, so
        wall-clock is the slowest single chain rather than the sum of the
        slowest-per-stage.

        Every stage is called as stage(prev_result, original_item, index); the
        first stage receives the item itself as prev_result. A stage that raises
        drops that item to None and skips its remaining stages."""
        self._check_abort()
        items = list(items)

        def chain(item, index):
            def run():
                value = item
                for stage in stages:
                    self._check_abort()
                    value = stage(value, item, index)
                return value
            return run

        return self._spawn([chain(item, i) for i, item in enumerate(items)])
```

Update `primitives()`:

```python
    def primitives(self):
        return {"agent": self.agent, "phase": self.phase, "log": self.log,
                "parallel": self.parallel, "pipeline": self.pipeline}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python tests/test_workflow_runtime.py`
Expected: 23 × `PASS`, then `OK`, exit 0

- [ ] **Step 5: Commit**

```bash
git add workflows/runtime.py tests/test_workflow_runtime.py
git commit -m "feat(workflows): parallel() barrier and no-barrier pipeline(), with a deadlock regression guard"
```

---

### Task 7: The orchestrator entry — validation, dry-run, run directory, events

**Files:**
- Modify: `workflows/__init__.py`
- Test: `tests/test_workflow_run.py`

**Interfaces:**
- Consumes: everything from Tasks 1–6.
- Produces:
  - `run(src=None, name=None, args=None, run_root=".", on_event=None, resume_from=None, dry_run=False, concurrency=None) -> dict` with keys `ok, run_id, name, result, error, agent_count, aborted, elapsed_s, warnings`.
  - `validate(src) -> dict` — `{"ok": bool, "error": str, "meta": dict}`; runs compile + meta + a full dry-run.
  - `abort(run_id=None)`, `active_runs() -> list[str]`.

- [ ] **Step 1: Write the failing test**

Create `tests/test_workflow_run.py`:

```python
"""End-to-end tests for workflows.run(): validation, dry-run gating, the run
directory, event envelope, and resume."""
import sys as _sys, os as _os
_sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))

import json
import tempfile

import workflows
from workflows import runtime as R


class FakeAgentDef:
    def __init__(self, name, is_write=False):
        self.name = name
        self.is_write = is_write
        self.mode = "write" if is_write else "read"


def _install(monkeypatch, handler=None):
    handler = handler or (lambda ad, p, **k: {"ok": True, "report": p,
                                              "raw_report": p, "tokens": 1})
    monkeypatch.setattr(R, "run_subagent", handler)
    monkeypatch.setattr(R, "get_agent",
               lambda n: FakeAgentDef(n, is_write=(n == "implementer"))
               if n in ("researcher", "implementer") else None)


GOOD = '''
meta = {"name": "demo", "description": "d", "phases": [{"title": "Scan"}]}
phase("Scan")
out = parallel([lambda i=i: agent(f"look at {i}") for i in range(3)])
return {"seen": [o for o in out if o]}
'''


def _root():
    return tempfile.mkdtemp(prefix="wfrun-")


def test_run_executes_and_returns_the_scripts_value(monkeypatch):
    _install(monkeypatch)
    res = workflows.run(src=GOOD, run_root=_root())
    assert res["ok"] is True
    assert res["result"]["seen"] == ["look at 0", "look at 1", "look at 2"]
    assert res["agent_count"] == 3


def test_run_writes_the_run_directory(monkeypatch):
    _install(monkeypatch)
    root = _root()
    res = workflows.run(src=GOOD, run_root=root)
    d = _os.path.join(root, "workflows", res["run_id"])
    assert _os.path.exists(_os.path.join(d, "script.py"))
    assert _os.path.exists(_os.path.join(d, "meta.json"))
    assert _os.path.exists(_os.path.join(d, "journal.jsonl"))
    assert _os.path.exists(_os.path.join(d, "result.json"))


def test_a_syntax_error_never_reaches_the_engine(monkeypatch):
    called = {"n": 0}

    def counter(*a, **k):
        called["n"] += 1
        return {"ok": True, "report": "x"}

    _install(monkeypatch, counter)
    res = workflows.run(src='meta = {"name":"a","description":"b"}\nif True\n  pass\n',
                        run_root=_root())
    assert res["ok"] is False and "syntax" in res["error"].lower()
    assert called["n"] == 0


def test_a_runtime_shape_bug_is_caught_by_dry_run_before_any_token(monkeypatch):
    called = {"n": 0}

    def counter(*a, **k):
        called["n"] += 1
        return {"ok": True, "report": "x", "raw_report": {"findings": []}}

    _install(monkeypatch, counter)
    bad = ('meta = {"name": "a", "description": "b"}\n'
           'r = agent("p", schema={"type": "object", '
           '"properties": {"findings": {"type": "array"}}, "required": ["findings"]})\n'
           'return r["MISSING_KEY"]\n')
    res = workflows.run(src=bad, run_root=_root())
    assert res["ok"] is False and "MISSING_KEY" in res["error"]
    assert called["n"] == 0


def test_unscoped_write_agent_is_rejected_at_dry_run(monkeypatch):
    _install(monkeypatch)
    bad = ('meta = {"name": "a", "description": "b"}\n'
           'return agent("edit", agent_type="implementer")\n')
    res = workflows.run(src=bad, run_root=_root())
    assert res["ok"] is False and "scope" in res["error"].lower()


def test_dry_run_flag_returns_without_spending_tokens(monkeypatch):
    called = {"n": 0}

    def counter(*a, **k):
        called["n"] += 1
        return {"ok": True, "report": "x"}

    _install(monkeypatch, counter)
    res = workflows.run(src=GOOD, run_root=_root(), dry_run=True)
    assert res["ok"] is True and called["n"] == 0


def test_events_carry_start_and_done_with_the_run_id(monkeypatch):
    _install(monkeypatch)
    events = []
    res = workflows.run(src=GOOD, run_root=_root(), on_event=events.append)
    kinds = [e["type"] for e in events]
    assert kinds[0] == "workflow_started" and kinds[-1] == "workflow_done"
    assert all(e.get("run_id") == res["run_id"] for e in events)


def test_resume_replays_and_makes_no_new_calls(monkeypatch):
    calls = {"n": 0}

    def counter(ad, p, **k):
        calls["n"] += 1
        return {"ok": True, "report": p, "raw_report": p, "tokens": 1}

    _install(monkeypatch, counter)
    root = _root()
    first = workflows.run(src=GOOD, run_root=root)
    assert calls["n"] == 3
    second = workflows.run(src=GOOD, run_root=root, resume_from=first["run_id"])
    assert second["ok"] is True
    assert second["result"] == first["result"]
    assert calls["n"] == 3      # nothing re-ran


def test_resume_warns_when_the_prior_run_had_write_agents(monkeypatch):
    _install(monkeypatch)
    root = _root()
    src = ('meta = {"name": "w", "description": "d"}\n'
           'return agent("edit", agent_type="implementer", scope=["src/"])\n')
    first = workflows.run(src=src, run_root=root)
    second = workflows.run(src=src, run_root=root, resume_from=first["run_id"])
    assert any("side effect" in w.lower() or "write" in w.lower()
               for w in second["warnings"])


def test_args_reach_the_script(monkeypatch):
    _install(monkeypatch)
    src = ('meta = {"name": "a", "description": "b"}\n'
           'return agent(f"do {args[\'thing\']}")\n')
    res = workflows.run(src=src, run_root=_root(), args={"thing": "X"})
    assert res["result"] == "do X"


def test_validate_reports_meta_without_running(monkeypatch):
    _install(monkeypatch)
    out = workflows.validate(GOOD)
    assert out["ok"] is True and out["meta"]["name"] == "demo"


if __name__ == "__main__":
    import types
    monkeypatch = types.SimpleNamespace(setattr=lambda o, n, v: setattr(o, n, v))
    tests = [test_run_executes_and_returns_the_scripts_value,
             test_run_writes_the_run_directory,
             test_a_syntax_error_never_reaches_the_engine,
             test_a_runtime_shape_bug_is_caught_by_dry_run_before_any_token,
             test_unscoped_write_agent_is_rejected_at_dry_run,
             test_dry_run_flag_returns_without_spending_tokens,
             test_events_carry_start_and_done_with_the_run_id,
             test_resume_replays_and_makes_no_new_calls,
             test_resume_warns_when_the_prior_run_had_write_agents,
             test_args_reach_the_script, test_validate_reports_meta_without_running]
    failed = 0
    _orig_run, _orig_get = R.run_subagent, R.get_agent
    for t in tests:
        try:
            t(monkeypatch); print(f"PASS {t.__name__}")
        except Exception as e:
            failed += 1
            import traceback; traceback.print_exc()
            print(f"FAIL {t.__name__}: {e}")
        finally:
            R.run_subagent, R.get_agent = _orig_run, _orig_get
    print("OK" if not failed else f"{failed} FAILED")
    _sys.exit(1 if failed else 0)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python tests/test_workflow_run.py`
Expected: FAIL — `module 'workflows' has no attribute 'run'`

- [ ] **Step 3: Write minimal implementation**

Replace `workflows/__init__.py`:

```python
"""Public entry point for the workflow engine.

The order of operations matters and is the point of this module: a script is
COMPILED, its meta extracted, and then DRY-RUN to completion with schema-shaped
stubs — all before a single token is spent. Whatever model is configured has to
author correct orchestration on the first try, and a KeyError in stage 3 would
otherwise waste an entire run.
"""
import json
import os
import time
import traceback
import uuid

from . import journal as _journal
from . import sandbox as _sandbox
from .sandbox import WorkflowScriptError
# NOTE: `.runtime` is imported INSIDE the functions below, never here. It pulls in
# `subagents`, which imports `workflows.schema`, which executes this __init__ —
# a module-level import creates a real cycle that breaks `import subagents`
# app-wide. See the mandatory note in the task text.

_ACTIVE = {}        # run_id -> WorkflowRuntime


def list_library():
    from .library import list_workflows
    return list_workflows()


def _resolve_source(src, name):
    if src:
        return src
    if name:
        from .library import load_source
        return load_source(name)
    raise WorkflowScriptError("run() needs either src= or name=.")


def _dry_run(code, meta, args, concurrency):
    """Execute the whole script with agent() stubbed. Catches shape bugs, unknown
    personas, and unscoped writers for free."""
    from .runtime import WorkflowRuntime      # function-level: breaks the cycle
    import tempfile
    tmp = os.path.join(tempfile.mkdtemp(prefix="wfdry-"), "journal.jsonl")
    j = _journal.Journal(tmp)
    rt = WorkflowRuntime(j, run_dir=None, dry_run=True, concurrency=concurrency)
    ns = _sandbox.make_namespace(rt.primitives(), args)
    try:
        exec(code, ns)
        ns["__workflow__"]()
    finally:
        j.close()


def validate(src, args=None, concurrency=None):
    """compile + meta + full dry-run. Returns {"ok", "error", "meta"}."""
    try:
        meta = _sandbox.extract_meta(src)
        code = _sandbox.compile_workflow(src)
        _dry_run(code, meta, args, concurrency)
        return {"ok": True, "error": "", "meta": meta}
    except WorkflowScriptError as e:
        return {"ok": False, "error": str(e), "meta": {}}
    except Exception as e:  # noqa: BLE001 — a real bug in the script's control flow
        return {"ok": False,
                "error": f"dry-run failed: {type(e).__name__}: {e}\n"
                         + traceback.format_exc(limit=4),
                "meta": {}}


def run(src=None, name=None, args=None, run_root=".", on_event=None,
        resume_from=None, dry_run=False, concurrency=None):
    started = time.monotonic()
    warnings = []
    try:
        src = _resolve_source(src, name)
    except WorkflowScriptError as e:
        return {"ok": False, "error": str(e), "run_id": "", "name": name or "",
                "result": None, "agent_count": 0, "aborted": False,
                "elapsed_s": 0.0, "warnings": warnings}

    checked = validate(src, args, concurrency)
    if not checked["ok"]:
        return {"ok": False, "error": checked["error"], "run_id": "",
                "name": name or "", "result": None, "agent_count": 0,
                "aborted": False, "elapsed_s": round(time.monotonic() - started, 2),
                "warnings": warnings}

    meta = checked["meta"]
    if dry_run:
        return {"ok": True, "error": "", "run_id": "", "name": meta.get("name", ""),
                "result": None, "agent_count": 0, "aborted": False,
                "elapsed_s": round(time.monotonic() - started, 2),
                "warnings": ["dry run only — nothing executed"]}

    run_id = uuid.uuid4().hex[:12]
    run_dir = os.path.join(run_root, "workflows", run_id)
    os.makedirs(run_dir, exist_ok=True)
    with open(os.path.join(run_dir, "script.py"), "w", encoding="utf-8") as f:
        f.write(src)
    with open(os.path.join(run_dir, "meta.json"), "w", encoding="utf-8") as f:
        json.dump({"meta": meta, "args": args, "resume_from": resume_from},
                  f, indent=2, default=str)

    replay = None
    if resume_from:
        replay = os.path.join(run_root, "workflows", resume_from, "journal.jsonl")
        if not os.path.exists(replay):
            replay = None
            warnings.append(f"no journal found for run {resume_from}; running cold")

    j = _journal.Journal(os.path.join(run_dir, "journal.jsonl"), replay_from=replay)
    if j.had_write_agents:
        warnings.append(
            "the resumed run contained WRITE agents. Resume replays agent "
            "RESULTS, not workspace side effects — files those agents already "
            "changed stay changed, and their work will not be re-applied.")

    from .runtime import WorkflowRuntime       # function-level: breaks the cycle
    rt = WorkflowRuntime(j, on_event=on_event, run_dir=run_dir,
                         concurrency=concurrency, run_id=run_id)
    _ACTIVE[run_id] = rt

    if on_event:
        on_event({"type": "workflow_started", "run_id": run_id,
                  "name": meta.get("name", ""),
                  "description": meta.get("description", ""),
                  "phases": meta.get("phases", []),
                  "resumed": bool(replay)})

    ok, error, value = True, "", None
    try:
        from .runtime import WorkflowAborted   # function-level: breaks the cycle
        code = _sandbox.compile_workflow(src)
        ns = _sandbox.make_namespace(rt.primitives(), args)
        exec(code, ns)
        value = ns["__workflow__"]()
    except WorkflowAborted:
        ok, error = False, "aborted"
    except Exception as e:  # noqa: BLE001
        ok = False
        error = f"{type(e).__name__}: {e}\n" + traceback.format_exc(limit=6)
    finally:
        _ACTIVE.pop(run_id, None)
        try:
            with open(os.path.join(run_dir, "result.json"), "w", encoding="utf-8") as f:
                json.dump({"ok": ok, "error": error, "result": value},
                          f, indent=2, default=str)
        except OSError:
            pass
        j.close()

    out = {"ok": ok, "error": error, "run_id": run_id,
           "name": meta.get("name", ""), "result": value,
           "agent_count": rt.agent_count, "aborted": rt.aborted,
           "elapsed_s": round(time.monotonic() - started, 2),
           "warnings": warnings}
    if on_event:
        on_event({"type": "workflow_done", "run_id": run_id, "ok": ok,
                  "aborted": rt.aborted, "agent_count": rt.agent_count,
                  "elapsed_s": out["elapsed_s"], "error": error})
    return out


def abort(run_id=None):
    """Abort one run, or every active run when run_id is None."""
    targets = [_ACTIVE[run_id]] if run_id and run_id in _ACTIVE else list(_ACTIVE.values())
    for rt in targets:
        rt.abort()
    return len(targets)


def active_runs():
    return list(_ACTIVE.keys())
```

**MANDATORY — the circular import.** `workflows/runtime.py` imports `subagents`, and Task 4 made `subagents` import `workflows.schema`. Importing *any* submodule executes the package `__init__` first, so a module-level `from .runtime import ...` here creates a genuine cycle:

```
import subagents
  → from workflows import schema          # runs workflows/__init__.py
    → from .runtime import WorkflowRuntime
      → from subagents import run_subagent  # subagents is partially initialized
        → ImportError: cannot import name 'run_subagent'
```

This breaks `agent.py`'s import of `subagents` — the whole app, not just workflows. It has been reproduced; do not treat it as hypothetical.

**Therefore `workflows/__init__.py` must NOT import `.runtime` at module level.** Put `from .runtime import WorkflowRuntime, WorkflowAborted` *inside* `_dry_run()` and `run()` (both need it). `from . import journal` and `from . import sandbox` stay at module level — neither touches `subagents`. Function-level imports to break cycles are already this repo's idiom; see `tools/delegation_tools.py`.

Verify with:

```bash
python -c "import subagents; import workflows; print('no cycle')"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python tests/test_workflow_run.py`
Expected: 11 × `PASS`, then `OK`, exit 0

Re-run the earlier suites to confirm no regression:

Run: `python tests/test_workflow_runtime.py && python tests/test_workflow_journal.py && python tests/test_subagent_schema.py`
Expected: `OK` from each

- [ ] **Step 5: Commit**

```bash
git add workflows/__init__.py tests/test_workflow_run.py
git commit -m "feat(workflows): run/validate entry with pre-flight dry-run, run directory and resume"
```

---

### Task 8: The built-in library

**Files:**
- Create: `workflows/library/__init__.py`, and six workflow sources:
  `review_changes.py`, `understand_subsystem.py`, `deep_research.py`,
  `exhaustive_audit.py`, `migrate.py`, `design_panel.py`
- Test: `tests/test_workflow_library.py`

**Interfaces:**
- Consumes: `workflows.validate`.
- Produces: `list_workflows() -> list[dict]` (each `{name, description, when_to_use, file}`), `load_source(name) -> str`.

Library sources are `.py` files but are **never imported** — they are read as text and run through the sandbox. Keeping them as `.py` gets editor syntax highlighting for free.

- [ ] **Step 1: Write the failing test**

Create `tests/test_workflow_library.py`:

```python
"""Every built-in workflow must compile, expose valid meta, and survive a full
dry-run. This is the guard that a library entry cannot rot silently."""
import sys as _sys, os as _os
_sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))

import workflows
from workflows import library
from workflows import runtime as R

EXPECTED = {"review-changes", "understand-subsystem", "deep-research",
            "exhaustive-audit", "migrate", "design-panel"}

# Args each library workflow needs to dry-run meaningfully.
ARGS = {
    "review-changes": {"target": "HEAD"},
    "understand-subsystem": {"paths": ["src/a", "src/b"]},
    "deep-research": {"question": "how does X work"},
    "exhaustive-audit": {"target": "src/"},
    "migrate": {"description": "rename foo to bar", "sites": ["src/a.py"]},
    "design-panel": {"problem": "how should we cache"},
}


class FakeAgentDef:
    def __init__(self, name, is_write=False):
        self.name = name
        self.is_write = is_write
        self.mode = "write" if is_write else "read"


def _install(monkeypatch):
    monkeypatch.setattr(R, "get_agent", lambda n: FakeAgentDef(
        n, is_write=n in ("implementer", "engineer")))
    monkeypatch.setattr(R, "run_subagent",
               lambda *a, **k: (_ for _ in ()).throw(
                   AssertionError("dry-run must not reach the engine")))


def test_every_expected_workflow_is_listed():
    names = {w["name"] for w in library.list_workflows()}
    assert EXPECTED <= names, f"missing: {EXPECTED - names}"


def test_every_workflow_has_a_description_and_when_to_use():
    for w in library.list_workflows():
        assert w["description"], f"{w['name']} has no description"
        assert w["when_to_use"], f"{w['name']} has no when_to_use"


def test_every_workflow_dry_runs_clean(monkeypatch):
    _install(monkeypatch)
    for w in library.list_workflows():
        src = library.load_source(w["name"])
        out = workflows.validate(src, args=ARGS.get(w["name"], {}))
        assert out["ok"], f"{w['name']} failed dry-run: {out['error']}"


def test_migrate_declares_scope_on_its_writers(monkeypatch):
    # A write agent without scope would be rejected by the runtime; this asserts
    # the library entry does it right rather than relying on the error path.
    src = library.load_source("migrate")
    assert "scope=" in src


def test_unknown_name_is_a_clear_error():
    try:
        library.load_source("no-such-workflow")
        raise AssertionError("expected an error")
    except Exception as e:
        assert "no-such-workflow" in str(e)


if __name__ == "__main__":
    import types
    monkeypatch = types.SimpleNamespace(setattr=lambda o, n, v: setattr(o, n, v))
    _orig_run, _orig_get = R.run_subagent, R.get_agent
    failed = 0
    for t, needs_mp in [(test_every_expected_workflow_is_listed, False),
                        (test_every_workflow_has_a_description_and_when_to_use, False),
                        (test_every_workflow_dry_runs_clean, True),
                        (test_migrate_declares_scope_on_its_writers, True),
                        (test_unknown_name_is_a_clear_error, False)]:
        try:
            t(monkeypatch) if needs_mp else t()
            print(f"PASS {t.__name__}")
        except Exception as e:
            failed += 1
            import traceback; traceback.print_exc()
            print(f"FAIL {t.__name__}: {e}")
        finally:
            R.run_subagent, R.get_agent = _orig_run, _orig_get
    print("OK" if not failed else f"{failed} FAILED")
    _sys.exit(1 if failed else 0)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python tests/test_workflow_library.py`
Expected: FAIL — `ModuleNotFoundError: No module named 'workflows.library'`

- [ ] **Step 3: Write minimal implementation**

Create `workflows/library/__init__.py`:

```python
"""Discovery for the built-in workflows.

The .py files here are SOURCES, never imported as modules — they are read as
text and run through the sandbox like any authored script. Keeping the .py
extension buys editor highlighting and nothing else."""
import os

from ..sandbox import WorkflowScriptError, extract_meta

_HERE = os.path.dirname(os.path.abspath(__file__))


def _source_files():
    for fn in sorted(os.listdir(_HERE)):
        if fn.endswith(".py") and fn != "__init__.py":
            yield os.path.join(_HERE, fn)


def list_workflows():
    out = []
    for path in _source_files():
        try:
            with open(path, "r", encoding="utf-8") as f:
                meta = extract_meta(f.read())
        except (OSError, WorkflowScriptError):
            continue
        out.append({"name": meta.get("name", ""),
                    "description": meta.get("description", ""),
                    "when_to_use": meta.get("when_to_use", ""),
                    "file": path})
    return out


def load_source(name):
    for w in list_workflows():
        if w["name"] == name:
            with open(w["file"], "r", encoding="utf-8") as f:
                return f.read()
    known = ", ".join(sorted(w["name"] for w in list_workflows()))
    raise WorkflowScriptError(
        f"no workflow named '{name}'. Available: {known}")
```

Create `workflows/library/review_changes.py`:

```python
meta = {
    "name": "review-changes",
    "description": "Review a diff across independent dimensions, then adversarially verify every finding.",
    "when_to_use": "Reviewing a change set for bugs. args: {\"target\": \"<git ref or path>\"}",
    "phases": [{"title": "Review"}, {"title": "Verify"}],
}

TARGET = (args or {}).get("target", "the current working-tree changes")

FINDINGS = {
    "type": "object",
    "properties": {
        "findings": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "file": {"type": "string"},
                    "detail": {"type": "string"},
                },
                "required": ["title", "file", "detail"],
            },
        }
    },
    "required": ["findings"],
}

VERDICT = {
    "type": "object",
    "properties": {
        "real": {"type": "boolean"},
        "reason": {"type": "string"},
    },
    "required": ["real", "reason"],
}

DIMENSIONS = [
    {"key": "correctness", "ask": "correctness bugs: wrong logic, off-by-one, bad error handling"},
    {"key": "security", "ask": "security problems: injection, unsafe deserialization, leaked secrets"},
    {"key": "regression", "ask": "behaviour this change breaks for existing callers"},
]


def find(dim, _orig, _i):
    return agent(
        f"Review {TARGET} for {dim['ask']}. Report only defects you can point at "
        f"in the diff, with the file and a concrete failure.",
        label=f"review:{dim['key']}", phase="Review", schema=FINDINGS)


def verify(review, dim, _i):
    if not review:
        return []
    checks = []
    for f in review["findings"]:
        def one(f=f):
            v = agent(
                f"Try to REFUTE this claimed defect in {f['file']}: {f['title']} — "
                f"{f['detail']}. Default to real=false if you are uncertain.",
                label=f"verify:{f['file']}", phase="Verify", schema=VERDICT)
            return dict(f, verdict=v, dimension=dim["key"]) if v else None
        checks.append(one)
    return parallel(checks)


results = pipeline(DIMENSIONS, find, verify)

confirmed = []
for group in results:
    for item in (group or []):
        if item and item["verdict"]["real"]:
            confirmed.append(item)

log(f"{len(confirmed)} confirmed finding(s)")
return {"confirmed": confirmed}
```

Create `workflows/library/understand_subsystem.py`:

```python
meta = {
    "name": "understand-subsystem",
    "description": "Read several parts of the codebase in parallel and return one structured map.",
    "when_to_use": "Getting oriented in unfamiliar code. args: {\"paths\": [\"src/a\", \"src/b\"]}",
    "phases": [{"title": "Read"}, {"title": "Synthesize"}],
}

PATHS = (args or {}).get("paths") or ["."]

MAP = {
    "type": "object",
    "properties": {
        "purpose": {"type": "string"},
        "entry_points": {"type": "array", "items": {"type": "string"}},
        "depends_on": {"type": "array", "items": {"type": "string"}},
        "risks": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["purpose", "entry_points", "depends_on"],
}

phase("Read")
maps = parallel([
    (lambda p=p: agent(
        f"Read {p} and describe what it is for, its entry points, what it depends "
        f"on, and anything risky or surprising in it.",
        label=f"read:{p}", phase="Read", schema=MAP))
    for p in PATHS
])

pairs = [{"path": p, "map": m} for p, m in zip(PATHS, maps) if m]

phase("Synthesize")
summary = agent(
    "Merge these subsystem maps into ONE description of how the pieces fit "
    "together. Call out conflicts explicitly. Do not invent anything the maps "
    "do not support.\n\n" + str(pairs),
    label="synthesize", phase="Synthesize")

return {"maps": pairs, "summary": summary}
```

Create `workflows/library/deep_research.py`:

```python
meta = {
    "name": "deep-research",
    "description": "Sweep a question from several angles, read the best leads deeply, synthesize, then ask what is missing.",
    "when_to_use": "An open question needing broad coverage. args: {\"question\": \"...\"}",
    "phases": [{"title": "Sweep"}, {"title": "Read"}, {"title": "Synthesize"}, {"title": "Critique"}],
}

QUESTION = (args or {}).get("question") or "the current task"

LEADS = {
    "type": "object",
    "properties": {
        "leads": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"where": {"type": "string"},
                               "why": {"type": "string"}},
                "required": ["where", "why"],
            },
        }
    },
    "required": ["leads"],
}

# Each angle is blind to what the others surface — that is the point.
ANGLES = [
    "by name: search for the identifiers and symbols the question implies",
    "by behaviour: find where the described behaviour is actually produced",
    "by configuration: find the settings, flags and env vars that affect it",
    "by history: find tests, docs and comments that explain it",
]

phase("Sweep")
swept = parallel([
    (lambda a=a: agent(f"Investigate '{QUESTION}' {a}. Return the concrete places "
                       f"worth reading in full.",
                       label=f"sweep:{a.split(':')[0]}", phase="Sweep", schema=LEADS))
    for a in ANGLES
])

leads = []
seen = set()
for s in swept:
    for lead in (s or {}).get("leads", []):
        if lead["where"] not in seen:
            seen.add(lead["where"])
            leads.append(lead)

log(f"{len(leads)} distinct lead(s) to read")

phase("Read")
readings = parallel([
    (lambda l=l: agent(f"Read {l['where']} closely and answer: {QUESTION}. "
                       f"It was flagged because: {l['why']}",
                       label=f"read:{l['where']}", phase="Read"))
    for l in leads[:24]
])
if len(leads) > 24:
    log(f"read the first 24 of {len(leads)} leads")

phase("Synthesize")
answer = agent("Answer this question from the readings below. Cite where each "
               "claim comes from. Say plainly what remains unknown.\n\n"
               f"QUESTION: {QUESTION}\n\nREADINGS:\n"
               + "\n\n".join(str(r) for r in readings if r),
               label="synthesize", phase="Synthesize")

phase("Critique")
gaps = agent("Here is a research answer. What is MISSING — an angle never "
             "searched, a claim never verified, a source never read? List only "
             "gaps, not praise.\n\n" + str(answer),
             label="completeness-critic", phase="Critique")

return {"answer": answer, "gaps": gaps, "leads_read": len(readings)}
```

Create `workflows/library/exhaustive_audit.py`:

```python
meta = {
    "name": "exhaustive-audit",
    "description": "Keep hunting for problems until two consecutive rounds find nothing new, judging each by several distinct lenses.",
    "when_to_use": "A thorough audit where the number of issues is unknown. args: {\"target\": \"src/\"}",
    "phases": [{"title": "Find"}, {"title": "Judge"}],
}

TARGET = (args or {}).get("target") or "."
MAX_ROUNDS = 6

ISSUES = {
    "type": "object",
    "properties": {
        "issues": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"id": {"type": "string"},
                               "where": {"type": "string"},
                               "detail": {"type": "string"}},
                "required": ["id", "where", "detail"],
            },
        }
    },
    "required": ["issues"],
}

VERDICT = {
    "type": "object",
    "properties": {"real": {"type": "boolean"}, "reason": {"type": "string"}},
    "required": ["real", "reason"],
}

FINDERS = ["error handling and failure paths",
           "concurrency, ordering and shared state",
           "input validation and boundary conditions",
           "resource lifetime: files, sockets, locks, memory"]

LENSES = ["correctness", "security", "does-it-actually-reproduce"]

seen = set()
confirmed = []
dry_rounds = 0
round_no = 0

while dry_rounds < 2 and round_no < MAX_ROUNDS:
    round_no += 1
    phase("Find")
    found = parallel([
        (lambda f=f, r=round_no: agent(
            f"Audit {TARGET} for problems in {f}. Round {r}: do NOT repeat "
            f"issues already reported; look somewhere new.",
            label=f"find:{f[:18]}", phase="Find", schema=ISSUES))
        for f in FINDERS
    ])

    fresh = []
    for batch in found:
        for issue in (batch or {}).get("issues", []):
            k = issue["where"] + "::" + issue["id"]
            # Dedup against EVERYTHING seen, not against `confirmed` — deduping
            # against confirmed lets judge-rejected issues reappear every round
            # and the loop never converges.
            if k not in seen:
                seen.add(k)
                fresh.append(issue)

    if not fresh:
        dry_rounds += 1
        log(f"round {round_no}: nothing new ({dry_rounds}/2 dry)")
        continue

    dry_rounds = 0
    log(f"round {round_no}: {len(fresh)} new issue(s) to judge")

    phase("Judge")
    def judge(issue, _orig, _i):
        votes = parallel([
            (lambda lens=lens: agent(
                f"Judge this claimed issue through the {lens} lens — is it real? "
                f"{issue['where']}: {issue['detail']}",
                label=f"judge:{lens}", phase="Judge", schema=VERDICT))
            for lens in LENSES
        ])
        real = len([v for v in votes if v and v["real"]])
        return dict(issue, votes=real) if real >= 2 else None

    for kept in pipeline(fresh, judge):
        if kept:
            confirmed.append(kept)

log(f"{len(confirmed)} confirmed after {round_no} round(s)")
return {"confirmed": confirmed, "rounds": round_no, "considered": len(seen)}
```

Create `workflows/library/migrate.py`:

```python
meta = {
    "name": "migrate",
    "description": "Find every site needing a change, edit each one in its own scope, then verify.",
    "when_to_use": "A mechanical change across many files. args: {\"description\": \"...\", \"sites\": [\"path\", ...] (optional)}",
    "phases": [{"title": "Discover"}, {"title": "Edit"}, {"title": "Verify"}],
}

CHANGE = (args or {}).get("description") or "the requested change"
GIVEN = (args or {}).get("sites") or []

SITES = {
    "type": "object",
    "properties": {"sites": {"type": "array", "items": {"type": "string"}}},
    "required": ["sites"],
}

CHECK = {
    "type": "object",
    "properties": {"applied": {"type": "boolean"}, "detail": {"type": "string"}},
    "required": ["applied", "detail"],
}

if GIVEN:
    sites = GIVEN
    log(f"{len(sites)} site(s) supplied")
else:
    phase("Discover")
    found = agent(f"Find every file that needs this change: {CHANGE}. Return only "
                  f"paths you have confirmed contain the pattern.",
                  label="discover", phase="Discover", schema=SITES)
    sites = (found or {}).get("sites", [])
    log(f"discovered {len(sites)} site(s)")


def edit(site, _orig, _i):
    # scope= is MANDATORY for a writer inside a workflow. It is what lets these
    # edits run concurrently: ScopedWorkspaceLock serializes only overlapping
    # owners, so disjoint files genuinely proceed at the same time.
    return agent(f"Apply this change to {site} and nothing else: {CHANGE}",
                 agent_type="implementer", scope=[site],
                 label=f"edit:{site}", phase="Edit")


def verify(edited, site, _i):
    if edited is None:
        return None
    return agent(f"Check that this change was correctly applied to {site}: {CHANGE}. "
                 f"Report applied=false if anything is wrong or incomplete.",
                 label=f"verify:{site}", phase="Verify", schema=CHECK)


results = pipeline(sites, edit, verify)

applied = [s for s, r in zip(sites, results) if r and r["applied"]]
failed = [s for s, r in zip(sites, results) if not (r and r["applied"])]
log(f"{len(applied)} applied, {len(failed)} failed")
return {"applied": applied, "failed": failed}
```

Create `workflows/library/design_panel.py`:

```python
meta = {
    "name": "design-panel",
    "description": "Generate several independent approaches, score them with independent judges, synthesize the winner.",
    "when_to_use": "An open design question with a wide solution space. args: {\"problem\": \"...\"}",
    "phases": [{"title": "Propose"}, {"title": "Judge"}, {"title": "Synthesize"}],
}

PROBLEM = (args or {}).get("problem") or "the current design question"

SCORE = {
    "type": "object",
    "properties": {
        "score": {"type": "integer"},
        "strengths": {"type": "array", "items": {"type": "string"}},
        "weaknesses": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["score", "strengths", "weaknesses"],
}

# Deliberately different starting biases — identical prompts produce identical
# proposals, which defeats the panel.
ANGLES = [
    "the simplest thing that could possibly work; optimize for less code",
    "risk-first: assume this must survive failure, scale and hostile input",
    "user-first: optimize for the experience of whoever uses this daily",
]

phase("Propose")
proposals = parallel([
    (lambda a=a: agent(f"Propose an approach to: {PROBLEM}\n\nTake this stance: {a}. "
                       f"Be concrete about the mechanism and its trade-offs.",
                       label=f"propose:{a.split(':')[0][:16]}", phase="Propose"))
    for a in ANGLES
])
proposals = [p for p in proposals if p]

phase("Judge")
def score(proposal, _orig, _i):
    return agent(f"Score this approach to '{PROBLEM}' out of 10 and list its real "
                 f"strengths and weaknesses. Be sceptical.\n\n{proposal}",
                 label="judge", phase="Judge", schema=SCORE)

scores = pipeline(proposals, score)
ranked = sorted(
    [{"proposal": p, "score": s} for p, s in zip(proposals, scores) if s],
    key=lambda r: r["score"]["score"], reverse=True)

phase("Synthesize")
if not ranked:
    return {"winner": None, "ranked": [], "design": None}

design = agent(
    f"Write the final design for: {PROBLEM}\n\nBuild on the winning approach, but "
    f"graft in any genuinely better idea from the runners-up. Be explicit about "
    f"what you rejected and why.\n\nWINNER:\n{ranked[0]['proposal']}\n\n"
    f"OTHERS:\n" + "\n\n".join(str(r["proposal"]) for r in ranked[1:]),
    label="synthesize", phase="Synthesize")

return {"design": design, "ranked": ranked}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python tests/test_workflow_library.py`
Expected: 5 × `PASS`, then `OK`, exit 0

- [ ] **Step 5: Commit**

```bash
git add workflows/library tests/test_workflow_library.py
git commit -m "feat(workflows): six built-in workflows covering the core orchestration patterns"
```

---

### Task 9: The `run_workflow` tool

**Files:**
- Create: `tools/workflow_tools.py`
- Modify: `tool_registry.py:17-45` (add `"workflow_tools": CORE_GROUP`)
- Test: `tests/test_workflow_tool.py`

**Interfaces:**
- Consumes: `workflows.run`, `workflows.list_library`, `subagents.ui_emit`.
- Produces: the registered tool `run_workflow(name=None, script=None, args=None, resume_from=None, dry_run=False)`.

- [ ] **Step 1: Write the failing test**

Create `tests/test_workflow_tool.py`:

```python
"""Offline tests for the run_workflow tool: argument handling, the library
listing in its description, and telemetry funnelling."""
import sys as _sys, os as _os
_sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))

import workflows
from tools import workflow_tools
from tools.workflow_tools import run_workflow


def test_requires_name_or_script():
    out = run_workflow()
    assert "error" in out and ("name" in out["error"] or "script" in out["error"])


def test_unknown_name_lists_what_is_available():
    out = run_workflow(name="does-not-exist")
    assert "error" in out and "review-changes" in out["error"]


def test_description_lists_the_library():
    text = workflow_tools._run_workflow_description()
    assert "review-changes" in text and "migrate" in text


def test_name_is_forwarded_to_workflows_run(monkeypatch):
    seen = {}

    def fake_run(**kw):
        seen.update(kw)
        return {"ok": True, "run_id": "abc", "name": "review-changes", "result": {"x": 1},
                "agent_count": 3, "aborted": False, "elapsed_s": 1.0,
                "warnings": [], "error": ""}

    monkeypatch.setattr(workflow_tools, "_run", fake_run)
    out = run_workflow(name="review-changes", args={"target": "HEAD"})
    assert seen["name"] == "review-changes" and seen["args"] == {"target": "HEAD"}
    assert out["ok"] is True and out["run_id"] == "abc"


def test_failure_returns_the_error_for_self_correction(monkeypatch):
    monkeypatch.setattr(workflow_tools, "_run",
               lambda **kw: {"ok": False, "error": "dry-run failed: KeyError: 'x'",
                             "run_id": "", "name": "", "result": None,
                             "agent_count": 0, "aborted": False, "elapsed_s": 0.1,
                             "warnings": []})
    out = run_workflow(script="meta = {'name':'a','description':'b'}\nreturn 1\n")
    assert "error" in out and "KeyError" in out["error"]


def test_string_args_json_is_decoded(monkeypatch):
    # Models routinely pass a JSON-ENCODED string instead of an object.
    seen = {}

    def fake_run(**kw):
        seen.update(kw)
        return {"ok": True, "run_id": "r", "name": "n", "result": None,
                "agent_count": 0, "aborted": False, "elapsed_s": 0.0,
                "warnings": [], "error": ""}

    monkeypatch.setattr(workflow_tools, "_run", fake_run)
    run_workflow(name="review-changes", args='{"target": "HEAD"}')
    assert seen["args"] == {"target": "HEAD"}


def test_warnings_are_surfaced(monkeypatch):
    monkeypatch.setattr(workflow_tools, "_run",
               lambda **kw: {"ok": True, "error": "", "run_id": "r", "name": "n",
                             "result": None, "agent_count": 0, "aborted": False,
                             "elapsed_s": 0.0, "warnings": ["write side effects"]})
    out = run_workflow(name="review-changes", resume_from="old")
    assert "write side effects" in str(out.get("warnings"))


if __name__ == "__main__":
    import types
    monkeypatch = types.SimpleNamespace(setattr=lambda o, n, v: setattr(o, n, v))
    _orig = workflow_tools._run
    failed = 0
    for t, needs_mp in [(test_requires_name_or_script, False),
                        (test_unknown_name_lists_what_is_available, False),
                        (test_description_lists_the_library, False),
                        (test_name_is_forwarded_to_workflows_run, True),
                        (test_failure_returns_the_error_for_self_correction, True),
                        (test_string_args_json_is_decoded, True),
                        (test_warnings_are_surfaced, True)]:
        try:
            t(monkeypatch) if needs_mp else t()
            print(f"PASS {t.__name__}")
        except Exception as e:
            failed += 1
            import traceback; traceback.print_exc()
            print(f"FAIL {t.__name__}: {e}")
        finally:
            workflow_tools._run = _orig
    print("OK" if not failed else f"{failed} FAILED")
    _sys.exit(1 if failed else 0)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python tests/test_workflow_tool.py`
Expected: FAIL — `ModuleNotFoundError: No module named 'tools.workflow_tools'`

- [ ] **Step 3: Write minimal implementation**

Create `tools/workflow_tools.py`:

```python
"""The model-facing entry to the workflow engine.

Registered in CORE (not an on-demand toolset) deliberately: an on-demand toolset
shows the model only a one-line catalog entry, and ultra mode's "default to a
workflow for substantive tasks" cannot work if the model cannot see the tool's
parameters. delegation_tools is core for the same reason.
"""
import json
import queue as _queue
import threading as _threading

import subagents
import workflows
from tool_registry import registry

# Indirected so tests can substitute it without patching the workflows package.
_run = workflows.run


def _run_workflow_description():
    """Built at PROMPT-RENDER time so a newly added library workflow appears
    without editing this file or the prompt."""
    lines = []
    for w in workflows.list_library():
        hint = w.get("when_to_use") or w.get("description") or ""
        lines.append(f"  - {w['name']}: {hint}")
    catalog = "\n".join(lines)
    return (
        "Run a WORKFLOW: deterministic multi-agent orchestration. Unlike dispatch_agents "
        "(one flat parallel wave), a workflow runs MULTIPLE STAGES — fan out, pipe each "
        "result into the next stage, verify findings adversarially, loop until a search "
        "goes dry — with the control flow decided by code rather than by you re-deciding "
        "every turn.\n"
        "PREFER a library workflow by name; only write a `script` for work none of them "
        "cover.\nAVAILABLE WORKFLOWS:\n" + catalog + "\n"
        "Authoring a script: it is Python. Start with a literal "
        "`meta = {\"name\": ..., \"description\": ...}`, then use agent(prompt, "
        "agent_type=, label=, phase=, schema=, scope=), parallel([thunks]) (a barrier), "
        "pipeline(items, *stages) (NO barrier — prefer it), phase(title), log(msg), and "
        "`args`. End with `return <value>`. A write agent MUST pass scope=[paths]. "
        "time/random/datetime are unavailable — replay determinism requires it. "
        "Every script is dry-run with stub data before it costs anything, and you get "
        "the traceback back if it fails."
    )


def _drain_to_ui(run_fn):
    """Run `run_fn(on_event)` on a background thread and drain its events HERE.

    Workflow agents fire events from many branch threads at once; poking the
    webview from all of them would be a threading bug. Same pattern as
    delegation_tools._run_with_ui_telemetry."""
    q = _queue.Queue()
    SENTINEL = object()
    holder = {}

    def work():
        try:
            holder["result"] = run_fn(q.put)
        except Exception as e:  # noqa: BLE001
            holder["error"] = e
        finally:
            q.put(SENTINEL)

    t = _threading.Thread(target=work, daemon=True)
    t.start()
    while True:
        ev = q.get()
        if ev is SENTINEL:
            break
        subagents.ui_emit(ev)
    t.join()
    if holder.get("error") is not None:
        raise holder["error"]
    return holder.get("result")


def _coerce_args(args):
    """A model routinely passes a JSON-ENCODED STRING where an object was asked
    for. Decoding it here turns a confusing downstream KeyError into the object
    the script expected."""
    if isinstance(args, str):
        text = args.strip()
        if not text:
            return None
        try:
            return json.loads(text)
        except ValueError:
            return args
    return args


@registry.register(
    name="run_workflow",
    description=_run_workflow_description,
    params_schema={
        "name": "string (optional) — a workflow from AVAILABLE WORKFLOWS. The preferred path.",
        "script": "string (optional) — a Python workflow script, when no library entry fits.",
        "args": "object (optional) — passed to the script as `args`. Pass a real object, not a JSON string.",
        "resume_from": "string (optional) — a prior run_id; unchanged agent calls replay from its journal.",
        "dry_run": "boolean (optional, default false) — validate and exercise control flow without spending tokens.",
    },
    output=("{ok, run_id, name, result, agent_count, elapsed_s, warnings} on success; "
            "{error} with the traceback when validation or dry-run fails, so you can fix "
            "the script and retry."),
    when_to_use=(
        "Use for multi-stage work: review-then-verify, discover-then-migrate-then-check, "
        "sweep-then-read-then-synthesize, or any hunt that should continue until it stops "
        "finding new things. For ONE flat wave of independent read-only questions, "
        "dispatch_agents is cheaper."),
    summary="run a multi-stage, multi-agent workflow (library entry or authored script)",
)
def run_workflow(name=None, script=None, args=None, resume_from=None, dry_run=False):
    if not name and not script:
        available = ", ".join(w["name"] for w in workflows.list_library())
        return {"error": f"run_workflow needs either 'name' or 'script'. Available: {available}"}
    if name and not script:
        known = [w["name"] for w in workflows.list_library()]
        if name not in known:
            return {"error": f"no workflow named '{name}'. Available: {', '.join(known)}"}

    try:
        res = _drain_to_ui(lambda emit: _run(
            src=script, name=name, args=_coerce_args(args),
            run_root=".", on_event=emit, resume_from=resume_from,
            dry_run=bool(dry_run)))
    except Exception as e:  # noqa: BLE001
        return {"error": f"workflow crashed: {type(e).__name__}: {e}"}

    if not res.get("ok"):
        return {"error": res.get("error") or "workflow failed",
                "run_id": res.get("run_id", ""),
                "warnings": res.get("warnings", [])}
    return {"ok": True, "run_id": res["run_id"], "name": res["name"],
            "result": res["result"], "agent_count": res["agent_count"],
            "elapsed_s": res["elapsed_s"], "warnings": res.get("warnings", [])}
```

Then add one line to `_GROUP_BY_MODULE` in `tool_registry.py`, beside `"delegation_tools": CORE_GROUP,`:

```python
    "workflow_tools": CORE_GROUP,
```

Confirm `tools/__init__.py` imports the new module the way it imports the others — check how `delegation_tools` is pulled in and match it exactly.

- [ ] **Step 4: Run test to verify it passes**

Run: `python tests/test_workflow_tool.py`
Expected: 7 × `PASS`, then `OK`, exit 0

Run: `.venv/Scripts/python.exe -m pytest tests/test_tool_meta_coverage.py -q`
Expected: all pass — this suite asserts every registered tool has complete metadata, so it is the guard that `run_workflow` was registered properly.

- [ ] **Step 5: Commit**

```bash
git add tools/workflow_tools.py tool_registry.py tests/test_workflow_tool.py
git commit -m "feat(tools): run_workflow with a render-time library catalog and UI telemetry funnelling"
```

---

### Task 10: Ultra mode in `agent.py`

**Files:**
- Modify: `agent.py` — session defaults, `_refresh_system_prompt`, and a bridge method on `AgentApi`
- Test: `tests/test_ultra_mode.py`

**Interfaces:**
- Consumes: nothing new.
- Produces: `AgentApi.set_ultra(on: bool) -> dict`, `AgentApi.get_ultra() -> dict`, session key `ultra`, and the prompt segment function `_ultra_prompt_segment(session) -> str`.

- [ ] **Step 1: Write the failing test**

Create `tests/test_ultra_mode.py`:

```python
"""Ultra mode: the per-session flag, its prompt segment, and the keyword that
flips it on. Guards against a casual question fanning out fifteen agents."""
import sys as _sys, os as _os
_sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))

import agent as agent_mod
from agent import AgentApi


def _api(**over):
    api = AgentApi.__new__(AgentApi)
    api.emits = []
    api._emit = lambda e: api.emits.append(e)
    session = {"messages": [], "ultra": False}
    session.update(over)
    api.session = session
    return api


def test_default_is_off():
    assert _api().get_ultra()["ultra"] is False


def test_set_ultra_toggles_and_persists_on_the_session():
    api = _api()
    api.set_ultra(True)
    assert api.session["ultra"] is True
    assert api.get_ultra()["ultra"] is True


def test_prompt_segment_off_tells_the_model_to_ask_first():
    text = agent_mod._ultra_prompt_segment({"ultra": False})
    assert "OFF" in text
    assert "ask" in text.lower() or "explicit" in text.lower()


def test_prompt_segment_on_tells_the_model_to_orchestrate():
    text = agent_mod._ultra_prompt_segment({"ultra": True})
    assert "ON" in text and "run_workflow" in text


def test_keyword_in_a_user_message_turns_it_on():
    assert agent_mod._ultra_keyword_requested("please ultra this refactor") is True
    assert agent_mod._ultra_keyword_requested("what is ultrasound") is False
    assert agent_mod._ultra_keyword_requested("just a normal question") is False


def test_stopping_aborts_every_active_workflow(monkeypatch):
    """Without this wiring, Stop cancels the shell command in flight but a
    running workflow keeps spawning agents."""
    import workflows
    called = {"n": 0}

    def fake_abort(run_id=None):
        called["n"] += 1
        return 2

    monkeypatch.setattr(workflows, "abort", fake_abort)
    api = _api()
    api._abort_active_workflows()
    assert called["n"] == 1
    assert any("2" in str(e.get("content", "")) for e in api.emits)


def test_aborting_workflows_never_raises(monkeypatch):
    # Stop must not be able to fail, whatever the engine is doing.
    import workflows

    def boom(run_id=None):
        raise RuntimeError("engine on fire")

    monkeypatch.setattr(workflows, "abort", boom)
    _api()._abort_active_workflows()      # must not raise


if __name__ == "__main__":
    import types
    import workflows as _wf
    monkeypatch = types.SimpleNamespace(setattr=lambda o, n, v: setattr(o, n, v))
    _orig_abort = _wf.abort
    failed = 0
    for t, needs_mp in [(test_default_is_off, False),
                        (test_set_ultra_toggles_and_persists_on_the_session, False),
                        (test_prompt_segment_off_tells_the_model_to_ask_first, False),
                        (test_prompt_segment_on_tells_the_model_to_orchestrate, False),
                        (test_keyword_in_a_user_message_turns_it_on, False),
                        (test_stopping_aborts_every_active_workflow, True),
                        (test_aborting_workflows_never_raises, True)]:
        try:
            t(monkeypatch) if needs_mp else t()
            print(f"PASS {t.__name__}")
        except Exception as e:
            failed += 1
            import traceback; traceback.print_exc()
            print(f"FAIL {t.__name__}: {e}")
        finally:
            _wf.abort = _orig_abort
    print("OK" if not failed else f"{failed} FAILED")
    _sys.exit(1 if failed else 0)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python tests/test_ultra_mode.py`
Expected: FAIL — `module 'agent' has no attribute '_ultra_prompt_segment'`

- [ ] **Step 3: Write minimal implementation**

Add two module-level functions to `agent.py`, next to the other prompt-segment helpers:

```python
_ULTRA_ON = (
    "ULTRA MODE: ON. For any substantive task — a review, an audit, a migration, "
    "a research question, a design decision — reach for `run_workflow` BEFORE "
    "working through it turn by turn. Prefer a library workflow by name. Trivial "
    "or conversational turns still get a direct answer."
)
_ULTRA_OFF = (
    "ULTRA MODE: OFF. Do not start a workflow on your own judgement — a fan-out "
    "spends real money. Answer directly, or use dispatch_agents for a single "
    "parallel wave. If a task genuinely warrants multi-stage orchestration, say so "
    "and let the user turn ultra mode on. `run_workflow` still runs if they name one."
)

# Word-boundary match so 'ultrasound' / 'ultrasonic' do not trip it.
_ULTRA_RE = __import__("re").compile(r"\bultra\b", __import__("re").IGNORECASE)


def _ultra_prompt_segment(session):
    return _ULTRA_ON if (session or {}).get("ultra") else _ULTRA_OFF


def _ultra_keyword_requested(text):
    return bool(_ULTRA_RE.search(text or ""))
```

Fold the segment into `_refresh_system_prompt` where the other session-driven
segments (plan, investigation, ledger) are assembled — append
`_ultra_prompt_segment(self.session)` to the same parts list.

Add the session default wherever the session dict is built (`"ultra": False`), and add the bridge methods to `AgentApi` beside the other flag toggles:

```python
    def set_ultra(self, on):
        """Toggle ultra mode. Exposed to the webview as pywebview.api.set_ultra."""
        self.session["ultra"] = bool(on)
        self._refresh_system_prompt()
        self._emit({"type": "ultra_mode", "ultra": self.session["ultra"]})
        return {"ultra": self.session["ultra"]}

    def get_ultra(self):
        return {"ultra": bool(self.session.get("ultra"))}
```

Then, in the method that handles an incoming user message, flip the flag when the keyword appears (before the prompt is refreshed):

```python
        if _ultra_keyword_requested(content) and not self.session.get("ultra"):
            self.session["ultra"] = True
            self._emit({"type": "ultra_mode", "ultra": True})
```

Finally — **wire Stop to the engine**. Without this, pressing Stop cancels the shell command in flight but a running workflow keeps spawning agents, because `workflows.abort()` has no caller. Add this method to `AgentApi`:

```python
    def _abort_active_workflows(self):
        """Cancel every running workflow. Called from the same place that sets
        self._stop, so Stop remains the single cancellation path rather than the
        engine growing a second one."""
        try:
            import workflows
            n = workflows.abort()
            if n:
                self._emit({"type": "log",
                            "content": f"stopping {n} running workflow(s)…"})
        except Exception:
            pass    # stopping must never itself fail
```

Then call it where `self._stop = True` is set — the same flag published to `host_exec` via `set_stop_check` at `agent.py:1376`:

```python
        self._stop = True
        self._abort_active_workflows()
```

In-flight subagents finish their current step (they already honor `host_exec`'s stop check), then unwind. The journal keeps everything that completed, so an aborted run is resumable.

- [ ] **Step 4: Run test to verify it passes**

Run: `python tests/test_ultra_mode.py`
Expected: 7 × `PASS`, then `OK`, exit 0

Run the agent-touching suites to confirm nothing regressed:

Run: `.venv/Scripts/python.exe -m pytest tests/ -q --ignore=tests/frontend`
Expected: **3 failed, 253 passed, 1 skipped** plus your new tests in the passed count. Those same 3 pre-existing environmental failures and NO others (see Global Constraints).

- [ ] **Step 5: Commit**

```bash
git add agent.py tests/test_ultra_mode.py
git commit -m "feat(agent): ultra mode flag, prompt segment and keyword trigger"
```

---

### Task 11: Frontend — the workflow progress view

**Files:**
- Create: `frontend/workflow_view.js`
- Modify: `frontend/index.html` (script tag; tab button at line ~1116; tab panel), `frontend/app.js` (six cases in the event switch at ~2363)
- Test: `tests/frontend/test_workflow_view.mjs`

**Interfaces:**
- Consumes: the six event types from Task 7.
- Produces: globals `workflowStarted(ev)`, `workflowPhase(ev)`, `workflowAgentStarted(ev)`, `workflowAgentDone(ev)`, `workflowLog(ev)`, `workflowDone(ev)`, and `workflowState()` returning `{runs: {...}}` for assertions.

`workflow_view.js` is a separate file on purpose: `app.js` is already 4,388 lines, and the Workflow tab is self-contained state.

- [ ] **Step 1: Write the failing test**

Create `tests/frontend/test_workflow_view.mjs`:

```javascript
// Drives the REAL frontend/workflow_view.js over the shared DOM shim with a
// recorded event stream — the same events the Python runtime emits.
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { El } from './_harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND = path.join(here, '..', '..', 'frontend');

function load() {
  const root = new El('div');
  const byId = new Map();
  for (const id of ['workflowTree', 'workflowEmpty', 'workflowCard', 'workflowTabBadge']) {
    const el = new El('div');
    el.id = id;
    byId.set(id, el);
  }
  const document = {
    getElementById: (id) => byId.get(id) || null,
    createElement: (tag) => new El(tag),
    body: root,
  };
  const ctx = { document, window: {}, console, setTimeout, clearTimeout };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(FRONTEND, 'workflow_view.js'), 'utf8'), ctx);
  return { ctx, byId };
}

const RUN = 'run123';

function started(ctx) {
  ctx.workflowStarted({
    type: 'workflow_started', run_id: RUN, name: 'review-changes',
    description: 'review a diff', phases: [{ title: 'Review' }, { title: 'Verify' }],
  });
}

// --- tests ------------------------------------------------------------------
{
  const { ctx } = load();
  started(ctx);
  const st = ctx.workflowState();
  assert.equal(st.runs[RUN].name, 'review-changes', 'run is registered by id');
  console.log('PASS registers a run');
}

{
  const { ctx } = load();
  started(ctx);
  ctx.workflowAgentStarted({ run_id: RUN, sub_id: 'a1', phase: 'Review', label: 'review:bugs', agent_type: 'researcher' });
  const st = ctx.workflowState();
  assert.equal(st.runs[RUN].phases.Review.agents.a1.status, 'running');
  console.log('PASS groups an agent under its phase');
}

{
  const { ctx } = load();
  started(ctx);
  ctx.workflowAgentStarted({ run_id: RUN, sub_id: 'a1', phase: 'Review', label: 'l' });
  ctx.workflowAgentDone({ run_id: RUN, sub_id: 'a1', ok: true, cached: false, tokens: 120, elapsed_s: 2.5 });
  const a = ctx.workflowState().runs[RUN].phases.Review.agents.a1;
  assert.equal(a.status, 'done');
  assert.equal(a.tokens, 120);
  console.log('PASS marks an agent done with its tokens');
}

{
  const { ctx } = load();
  started(ctx);
  ctx.workflowAgentStarted({ run_id: RUN, sub_id: 'c1', phase: 'Review', label: 'l' });
  ctx.workflowAgentDone({ run_id: RUN, sub_id: 'c1', ok: true, cached: true, tokens: 0, elapsed_s: 0 });
  const st = ctx.workflowState();
  assert.equal(st.runs[RUN].phases.Review.agents.c1.cached, true);
  assert.equal(st.runs[RUN].counts.cached, 1, 'cached replays are counted separately');
  console.log('PASS distinguishes a cached replay');
}

{
  const { ctx } = load();
  started(ctx);
  for (const id of ['a', 'b', 'c']) {
    ctx.workflowAgentStarted({ run_id: RUN, sub_id: id, phase: 'Verify', label: id });
  }
  ctx.workflowAgentDone({ run_id: RUN, sub_id: 'a', ok: true, cached: false, tokens: 1, elapsed_s: 1 });
  const c = ctx.workflowState().runs[RUN].counts;
  assert.equal(c.running, 2, 'two still in flight');
  assert.equal(c.done, 1);
  console.log('PASS tracks running/done counts for the inline card');
}

{
  const { ctx } = load();
  started(ctx);
  ctx.workflowAgentStarted({ run_id: RUN, sub_id: 'x', phase: 'Review', label: 'l' });
  ctx.workflowAgentDone({ run_id: RUN, sub_id: 'x', ok: false, cached: false, tokens: 5, elapsed_s: 1 });
  assert.equal(ctx.workflowState().runs[RUN].counts.failed, 1);
  console.log('PASS counts a failed agent');
}

{
  const { ctx } = load();
  started(ctx);
  ctx.workflowDone({ run_id: RUN, ok: true, aborted: false, agent_count: 4, elapsed_s: 9.1 });
  const r = ctx.workflowState().runs[RUN];
  assert.equal(r.status, 'done');
  assert.equal(r.elapsed_s, 9.1);
  console.log('PASS finalizes the run');
}

{
  // An event for an unknown run must not throw — the UI can attach mid-run after
  // a webview refresh, exactly as the wave HUD already handles.
  const { ctx } = load();
  ctx.workflowAgentDone({ run_id: 'never-seen', sub_id: 'z', ok: true, cached: false, tokens: 0, elapsed_s: 0 });
  console.log('PASS tolerates events for an unknown run');
}

{
  const { ctx } = load();
  started(ctx);
  ctx.workflowLog({ run_id: RUN, message: '3 leads found' });
  assert.deepEqual(ctx.workflowState().runs[RUN].logs, ['3 leads found']);
  console.log('PASS records log lines');
}

console.log('OK');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/frontend/test_workflow_view.mjs`
Expected: FAIL — `ENOENT ... frontend/workflow_view.js`

- [ ] **Step 3: Write minimal implementation**

Create `frontend/workflow_view.js`:

```javascript
// Workflow progress: the phase tree in the Workflow tab and the compact inline
// card in the chat stream.
//
// Kept out of app.js (already 4,388 lines) because this is self-contained state
// driven by six event types. State is keyed by run_id so a nested workflow, or a
// second run started after a refresh, cannot scribble on the first one's tree.
(function () {
  const runs = Object.create(null);

  function emptyCounts() {
    return { running: 0, done: 0, failed: 0, cached: 0, tokens: 0 };
  }

  function ensureRun(id) {
    if (!runs[id]) {
      runs[id] = {
        id, name: '', description: '', status: 'running',
        phases: Object.create(null), order: [], logs: [],
        counts: emptyCounts(), elapsed_s: 0, agent_count: 0,
      };
    }
    return runs[id];
  }

  function ensurePhase(run, title) {
    const key = title || 'Work';
    if (!run.phases[key]) {
      run.phases[key] = { title: key, agents: Object.create(null), order: [] };
      run.order.push(key);
    }
    return run.phases[key];
  }

  function workflowStarted(ev) {
    const run = ensureRun(ev.run_id);
    run.name = ev.name || '';
    run.description = ev.description || '';
    run.resumed = !!ev.resumed;
    (ev.phases || []).forEach((p) => ensurePhase(run, p && p.title));
    render(run);
  }

  function workflowPhase(ev) {
    const run = ensureRun(ev.run_id);
    ensurePhase(run, ev.title);
    run.currentPhase = ev.title;
    render(run);
  }

  function workflowAgentStarted(ev) {
    const run = ensureRun(ev.run_id);
    const phase = ensurePhase(run, ev.phase || run.currentPhase);
    if (!phase.agents[ev.sub_id]) phase.order.push(ev.sub_id);
    phase.agents[ev.sub_id] = {
      id: ev.sub_id, label: ev.label || '', agent_type: ev.agent_type || '',
      model: ev.model || '', status: 'running', cached: false, tokens: 0, elapsed_s: 0,
    };
    run.counts.running += 1;
    render(run);
  }

  function findAgent(run, subId) {
    for (const key of run.order) {
      const a = run.phases[key].agents[subId];
      if (a) return a;
    }
    return null;
  }

  function workflowAgentDone(ev) {
    const run = runs[ev.run_id];
    if (!run) return;              // attached mid-run; nothing to update
    const a = findAgent(run, ev.sub_id);
    if (!a) return;
    a.status = ev.ok ? 'done' : 'failed';
    a.cached = !!ev.cached;
    a.tokens = ev.tokens || 0;
    a.elapsed_s = ev.elapsed_s || 0;
    run.counts.running = Math.max(0, run.counts.running - 1);
    if (ev.ok) run.counts.done += 1; else run.counts.failed += 1;
    if (ev.cached) run.counts.cached += 1;
    run.counts.tokens += a.tokens;
    render(run);
  }

  function workflowLog(ev) {
    const run = ensureRun(ev.run_id);
    run.logs.push(ev.message || '');
    render(run);
  }

  function workflowDone(ev) {
    const run = ensureRun(ev.run_id);
    run.status = ev.aborted ? 'aborted' : (ev.ok ? 'done' : 'failed');
    run.elapsed_s = ev.elapsed_s || 0;
    run.agent_count = ev.agent_count || 0;
    run.counts.running = 0;
    render(run);
  }

  // --- rendering ------------------------------------------------------------
  function statusDot(status) {
    if (status === 'running') return '<span class="wf-dot wf-dot-run"></span>';
    if (status === 'failed') return '<span class="wf-dot wf-dot-fail"></span>';
    if (status === 'aborted') return '<span class="wf-dot wf-dot-warn"></span>';
    return '<span class="wf-dot wf-dot-ok"></span>';
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function renderCard(run) {
    const card = document.getElementById('workflowCard');
    if (!card) return;
    const c = run.counts;
    const bits = [];
    if (run.currentPhase) bits.push(esc(run.currentPhase));
    if (c.running) bits.push(`${c.running} running`);
    if (c.done) bits.push(`${c.done} done`);
    if (c.cached) bits.push(`${c.cached} cached`);
    if (c.failed) bits.push(`${c.failed} failed`);
    card.innerHTML =
      `<div class="wf-card-head">${statusDot(run.status)}` +
      `<span class="wf-card-name">${esc(run.name)}</span>` +
      `<span class="wf-card-meta">${bits.join(' · ')}</span></div>`;
  }

  function renderTree(run) {
    const tree = document.getElementById('workflowTree');
    if (!tree) return;
    const empty = document.getElementById('workflowEmpty');
    if (empty) empty.classList.add('hidden');

    const parts = [
      `<div class="wf-run-head">${statusDot(run.status)}<span class="wf-run-name">${esc(run.name)}</span>` +
      `<span class="wf-run-desc">${esc(run.description)}</span></div>`,
    ];
    for (const key of run.order) {
      const phase = run.phases[key];
      parts.push(`<div class="wf-phase"><div class="wf-phase-title">${esc(phase.title)}</div>`);
      for (const id of phase.order) {
        const a = phase.agents[id];
        const meta = [a.agent_type, a.model, a.tokens ? `${a.tokens} tok` : '',
                      a.cached ? 'cached' : '', a.elapsed_s ? `${a.elapsed_s}s` : '']
          .filter(Boolean).join(' · ');
        parts.push(
          `<div class="wf-agent" data-sub-id="${esc(a.id)}">${statusDot(a.status)}` +
          `<span class="wf-agent-label">${esc(a.label)}</span>` +
          `<span class="wf-agent-meta">${esc(meta)}</span></div>`);
      }
      parts.push('</div>');
    }
    if (run.logs.length) {
      parts.push('<div class="wf-logs">' +
        run.logs.map((l) => `<div class="wf-log">${esc(l)}</div>`).join('') + '</div>');
    }
    tree.innerHTML = parts.join('');
  }

  function renderBadge(run) {
    const badge = document.getElementById('workflowTabBadge');
    if (!badge) return;
    const n = run.counts.running;
    badge.textContent = n ? String(n) : '';
    badge.classList.toggle('hidden', !n);
  }

  function render(run) {
    try {
      renderCard(run);
      renderTree(run);
      renderBadge(run);
    } catch (e) {
      // Rendering must never break the event stream.
    }
  }

  const api = {
    workflowStarted, workflowPhase, workflowAgentStarted, workflowAgentDone,
    workflowLog, workflowDone,
    workflowState: () => ({ runs }),
  };
  Object.assign(typeof window !== 'undefined' ? window : globalThis, api);
})();
```

Wire it into `frontend/index.html`:

- Beside the other `<script defer>` tags, before `app.js` is loaded: `<script defer src="workflow_view.js"></script>`
- A fourth tab button after `tabGraph` (line ~1116):

```html
<button id="tabWorkflow" class="llm-tab" role="tab" aria-selected="false" aria-controls="workflowTab">
  Workflow<span id="workflowTabBadge" class="wf-badge hidden"></span>
</button>
```

- A matching panel beside the existing `chatTab` / `planTab` / `graphTab` panels:

```html
<div id="workflowTab" class="scroll-y hidden flex-1 px-3 py-2" role="tabpanel">
  <div id="workflowEmpty" class="text-term-muted t-xs">No workflow has run yet.</div>
  <div id="workflowTree"></div>
</div>
```

- An inline card container in the chat stream area: `<div id="workflowCard" class="hidden"></div>`

Add the six cases to the event switch in `frontend/app.js` (~line 2381, beside `wave_started`):

```javascript
      case 'workflow_started': workflowStarted(ev); break;
      case 'wf_phase': workflowPhase(ev); break;
      case 'wf_agent_started': workflowAgentStarted(ev); break;
      case 'wf_agent_done': workflowAgentDone(ev); break;
      case 'wf_log': workflowLog(ev); break;
      case 'workflow_done': workflowDone(ev); break;
```

Register `tabWorkflow` / `workflowTab` with whatever function already switches between `tabChat`, `tabPlan` and `tabGraph` — follow that existing code exactly rather than adding a second mechanism.

Add the new classes to `frontend/tailwind.input.css` (`wf-dot`, `wf-dot-run`, `wf-dot-ok`, `wf-dot-fail`, `wf-dot-warn`, `wf-badge`, `wf-card-head`, `wf-card-name`, `wf-card-meta`, `wf-run-head`, `wf-run-name`, `wf-run-desc`, `wf-phase`, `wf-phase-title`, `wf-agent`, `wf-agent-label`, `wf-agent-meta`, `wf-logs`, `wf-log`) using the existing `--term-*` tokens, type ramp and 4px spacing scale — do not introduce new raw colors. Then rebuild:

```bash
cd frontend && npx tailwindcss@3 -c tailwind.config.js -i tailwind.input.css -o tailwind.css --minify
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node tests/frontend/test_workflow_view.mjs`
Expected: 9 × `PASS`, then `OK`

Run the frontend suites that guard the shared files you touched:

Run: `node tests/frontend/test_boot.mjs && node tests/frontend/test_element_ids.mjs && node tests/frontend/test_tailwind_classes.mjs && node tests/frontend/test_contrast.mjs`
Expected: `OK` from each. `test_element_ids.mjs` and `test_tailwind_classes.mjs` are the ones most likely to fail — they assert every id referenced by JS exists in the HTML and every class used is present in the compiled CSS. If either fails, you missed an element or the Tailwind rebuild.

- [ ] **Step 5: Commit**

```bash
git add frontend/workflow_view.js frontend/index.html frontend/app.js \
        frontend/tailwind.input.css frontend/tailwind.css \
        tests/frontend/test_workflow_view.mjs
git commit -m "feat(ui): workflow progress tree, inline run card and Workflow tab"
```

---

### Task 12: Nested workflows

**Files:**
- Modify: `workflows/runtime.py` (add `workflow()`, extend `primitives()`), `workflows/__init__.py` (pass a child factory into the runtime)
- Modify: `tests/test_workflow_run.py` (append tests + runner entries)

**Interfaces:**
- Consumes: everything prior.
- Produces: `WorkflowRuntime.workflow(name_or_path, args=None)` in `primitives()`. Nesting depth is exactly one.

Built last, deliberately: the single-level path must be green before recursion is introduced.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_workflow_run.py` (before `__main__`):

```python
CHILD_CALLER = '''
meta = {"name": "parent", "description": "calls a child"}
inner = workflow("understand-subsystem", {"paths": ["src/a"]})
return {"inner": inner}
'''


def test_a_workflow_can_call_a_library_workflow(monkeypatch):
    _install(monkeypatch)
    res = workflows.run(src=CHILD_CALLER, run_root=_root())
    assert res["ok"] is True, res["error"]
    assert res["result"]["inner"] is not None


def test_child_agents_count_toward_the_parent(monkeypatch):
    _install(monkeypatch)
    res = workflows.run(src=CHILD_CALLER, run_root=_root())
    # one child read + one child synthesize, at minimum
    assert res["agent_count"] >= 2


def test_nesting_two_levels_deep_is_refused(monkeypatch):
    """A child runtime must refuse to nest further. Asserted against the depth
    guard directly — driving it through two library workflows would depend on a
    library entry that itself nests, and would pass for the wrong reason if the
    inner name simply failed to resolve."""
    _install(monkeypatch)
    import tempfile
    from workflows import journal as _J
    d = tempfile.mkdtemp(prefix="wfnest-")
    j = _J.Journal(_os.path.join(d, "journal.jsonl"))
    child = R.WorkflowRuntime(j, run_dir=d)
    child.depth = 1
    child._source_loader = lambda name: 'meta = {"name":"x","description":"d"}\nreturn 1\n'
    try:
        child.workflow("anything")
        raise AssertionError("expected a nesting-depth error")
    except Exception as e:
        assert "one level" in str(e).lower() or "nested" in str(e).lower()


def test_child_events_carry_a_group_label(monkeypatch):
    _install(monkeypatch)
    events = []
    workflows.run(src=CHILD_CALLER, run_root=_root(), on_event=events.append)
    grouped = [e for e in events if e.get("group")]
    assert grouped and all(g["group"] == "understand-subsystem" for g in grouped)
```

Add those four names to the `__main__` runner list.

- [ ] **Step 2: Run test to verify it fails**

Run: `python tests/test_workflow_run.py`
Expected: FAIL — `NameError: name 'workflow' is not defined`

- [ ] **Step 3: Write minimal implementation**

Add to `WorkflowRuntime.__init__` in `workflows/runtime.py`:

```python
        self.depth = 0          # bumped for a child runtime
        self._source_loader = None   # set by workflows.run
```

Add the method, above `primitives()`:

```python
    def workflow(self, name_or_path, args=None):
        """Run another workflow inline, sharing this run's semaphore, abort flag,
        journal and run directory.

        ONE level only. Unbounded nesting would let a single script open an
        arbitrary number of concurrent runs, and a depth counter to tune is worse
        than a flat rule."""
        self._check_abort()
        if self.depth >= 1:
            raise WorkflowScriptError(
                "workflow() cannot be called from inside a nested workflow — "
                "nesting is one level deep. Inline the work with agent()/"
                "pipeline() instead."
            )
        if self._source_loader is None:
            raise WorkflowScriptError("nested workflows are unavailable in this context.")

        from . import sandbox as _sb
        src = self._source_loader(name_or_path)
        meta = _sb.extract_meta(src)
        code = _sb.compile_workflow(src, filename=f"<workflow:{meta['name']}>")

        child = WorkflowRuntime(
            self.journal, on_event=self.on_event, run_dir=self.run_dir,
            dry_run=self.dry_run, run_id=self.run_id,
            emit_prefix=meta.get("name", ""))
        # Share the parent's real concurrency budget and abort signal rather than
        # opening a second one — a child must not double the fleet.
        child._sem = self._sem
        child._abort = self._abort
        child._count_lock = self._count_lock
        child.depth = self.depth + 1
        child._source_loader = self._source_loader
        # Namespace the child's journal keys so an identical prompt in parent and
        # child cannot collide on replay.
        child._key_prefix = meta.get("name", "")

        ns = _sb.make_namespace(child.primitives(), args)
        exec(code, ns)
        try:
            return ns["__workflow__"]()
        finally:
            with self._count_lock:
                self.agent_count += child.agent_count
```

Add key namespacing to `agent()` — set `self._key_prefix = ""` in `__init__`, and change the key line:

```python
        key = _journal.call_key(agent_type, prompt, opts)
        if self._key_prefix:
            key = _journal.call_key(self._key_prefix, key, {})
```

Because the child shares `_count_lock` with its parent, `child.agent_count`
increments the shared counter's guard but its own field; the `finally` above
folds the child's total back in.

Extend `primitives()`:

```python
    def primitives(self):
        return {"agent": self.agent, "phase": self.phase, "log": self.log,
                "parallel": self.parallel, "pipeline": self.pipeline,
                "workflow": self.workflow}
```

In `workflows/__init__.py`, give both the dry-run and real runtimes a loader:

```python
def _loader(name_or_path):
    from .library import load_source
    return load_source(name_or_path)
```

and set `rt._source_loader = _loader` immediately after each `WorkflowRuntime(...)` construction (in `_dry_run` and in `run`).

- [ ] **Step 4: Run test to verify it passes**

Run: `python tests/test_workflow_run.py`
Expected: 15 × `PASS`, then `OK`, exit 0

Run the whole new suite together:

Run: `python tests/test_workflow_schema.py && python tests/test_workflow_sandbox.py && python tests/test_workflow_journal.py && python tests/test_subagent_schema.py && python tests/test_workflow_runtime.py && python tests/test_workflow_run.py && python tests/test_workflow_library.py && python tests/test_workflow_tool.py && python tests/test_ultra_mode.py`
Expected: `OK` from each, exit 0

Run the pre-existing suite to confirm no regression:

Run: `.venv/Scripts/python.exe -m pytest tests/ -q --ignore=tests/frontend`
Expected: **3 failed, 253 passed, 1 skipped** plus your new tests in the passed count. Those same 3 pre-existing environmental failures and NO others (see Global Constraints).

- [ ] **Step 5: Commit**

```bash
git add workflows/runtime.py workflows/__init__.py tests/test_workflow_run.py
git commit -m "feat(workflows): one-level nested workflows sharing the parent's concurrency and journal"
```

---

### Task 13: Documentation

**Files:**
- Modify: `AGENTS.md` (a new section after "Context & memory architecture"), `TOOLS.md` (the `run_workflow` entry)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing. This task exists because `AGENTS.md` is how the next reader — human or model — learns why the engine is shaped the way it is.

- [ ] **Step 1: Add the AGENTS.md section**

Append after the "Context & memory architecture" section, matching the existing voice (it explains *why*, names the traps, and points at the guards):

```markdown
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

Ultra mode (`session["ultra"]`) gates autonomous orchestration: off, the agent
must be asked; on, it defaults to a workflow for substantive tasks. The keyword
`ultra` in a user message turns it on.
```

- [ ] **Step 2: Add the TOOLS.md entry**

Follow the exact format of the neighbouring `dispatch_agents` entry — name, what it does, parameters, output, and when to choose it over `dispatch_agents` (multi-stage vs one flat wave).

- [ ] **Step 3: Verify the docs match the code**

Run: `python -c "import workflows; print([w['name'] for w in workflows.list_library()])"`
Expected: the six names, matching what you wrote in `TOOLS.md`.

- [ ] **Step 4: Commit**

```bash
git add AGENTS.md TOOLS.md
git commit -m "docs: workflow engine architecture, its three load-bearing decisions, and the run_workflow tool"
```

---

## Verification

After Task 13, the whole thing should be green from a cold shell:

```bash
cd omni-agent
for t in schema sandbox journal runtime run library tool; do .venv/Scripts/python.exe tests/test_workflow_$t.py || echo "FAILED: $t"; done
python tests/test_subagent_schema.py
python tests/test_ultra_mode.py
node tests/frontend/test_workflow_view.mjs
```

And the pre-existing suite must still pass — the only files this plan modifies that other tests cover are `subagents.py`, `tool_registry.py`, `agent.py`, `frontend/app.js` and `frontend/index.html`:

```bash
# Whole pre-existing suite. Green == 3 failed / 253 passed / 1 skipped + our new tests.
# The 3 failures are pre-existing and environmental; see Global Constraints.
.venv/Scripts/python.exe -m pytest tests/ -q --ignore=tests/frontend

node tests/frontend/test_boot.mjs
node tests/frontend/test_element_ids.mjs
node tests/frontend/test_tailwind_classes.mjs
node tests/frontend/test_contrast.mjs
```

Finally, a real end-to-end run with a configured provider — the tests all use doubles, so nothing above proves an actual LLM can satisfy a schema:

```
run_workflow(name="understand-subsystem", args={"paths": ["workflows"]})
```

Expect the Workflow tab to fill with a Read phase, one agent per path, then a Synthesize phase. If agents fail with `schema validation failed after 3 attempts`, the configured model is struggling with the JSON contract — check `render_contract`'s wording before assuming the engine is broken.
