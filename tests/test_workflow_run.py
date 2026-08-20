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
