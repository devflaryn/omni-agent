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
