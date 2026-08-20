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
