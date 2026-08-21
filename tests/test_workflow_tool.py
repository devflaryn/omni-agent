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


def test_the_configured_run_root_is_forwarded_not_the_cwd(monkeypatch):
    """It hardcoded run_root=".", which wrote script.py/journal.jsonl INTO the
    source `workflows/` package and left resume_from run_ids unfindable after a
    relaunch. The spec puts them under <memory_dir>/workflows/<run_id>/."""
    seen = {}

    def fake_run(**kw):
        seen.update(kw)
        return {"ok": True, "error": "", "run_id": "r", "name": "n", "result": None,
                "agent_count": 0, "aborted": False, "elapsed_s": 0.0, "warnings": []}

    monkeypatch.setattr(workflow_tools, "_run", fake_run)
    prev = workflows.get_run_root()
    try:
        workflows.set_run_root("/some/memory/dir")
        run_workflow(name="review-changes")
        assert seen["run_root"] == "/some/memory/dir"
    finally:
        workflows.set_run_root(prev)


def test_an_aborted_run_still_reports_what_it_did(monkeypatch):
    """Without the counters the model cannot tell 'nothing ran' from 'eleven
    agents finished and then it was stopped'."""
    monkeypatch.setattr(workflow_tools, "_run",
               lambda **kw: {"ok": False, "error": "aborted", "run_id": "r7",
                             "name": "review-changes",
                             "result": {"aborted": True, "partial": [{"result": "x"}]},
                             "agent_count": 11, "aborted": True, "elapsed_s": 42.5,
                             "warnings": []})
    out = run_workflow(name="review-changes")
    assert out["agent_count"] == 11
    assert out["elapsed_s"] == 42.5
    assert out["name"] == "review-changes"
    assert out["run_id"] == "r7"          # so the model can resume_from it
    assert out["aborted"] is True
    assert out["result"]["partial"][0]["result"] == "x"


def test_the_session_points_the_run_root_at_memory_dir():
    """The setter is only useful if something CALLS it. agent.start_session is
    the one place memory_dir is known — the same pattern as
    subagents.set_ui_sink / host_exec.set_stop_check."""
    import inspect
    import agent as agent_mod
    src = inspect.getsource(agent_mod.AgentApi.start_session)
    assert "set_run_root(memory_dir)" in src,         "start_session no longer points workflow run dirs at the session memory_dir"


def test_description_advertises_declared_arg_names():
    # The model guesses arg names from prose today. Declared names are exact.
    text = workflow_tools._run_workflow_description()
    assert "target" in text, "review-changes' declared arg should appear"
    assert "question" in text, "deep-research' declared arg should appear"


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
                        (test_warnings_are_surfaced, True),
                        (test_the_configured_run_root_is_forwarded_not_the_cwd, True),
                        (test_an_aborted_run_still_reports_what_it_did, True),
                        (test_the_session_points_the_run_root_at_memory_dir, False),
                        (test_description_advertises_declared_arg_names, False)]:
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
