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
