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
