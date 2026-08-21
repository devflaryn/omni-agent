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


def test_events_from_many_threads_are_funneled_through_a_single_emit_thread(monkeypatch):
    """parallel()/pipeline() spawn one thread per branch and fire on_event from
    each of them. self._emit is not thread-safe (transcript append/trim, dock
    mutation, evaluate_js). This must fail if the drain funnel is ever removed
    and workflows.run is handed self._emit directly again."""
    import threading as _threading
    import workflows

    def fake_run(name=None, args=None, on_event=None, dry_run=False, **kw):
        def branch(i):
            for j in range(20):
                on_event({"type": "wf_agent_done", "branch": i, "seq": j})
        threads = [_threading.Thread(target=branch, args=(i,)) for i in range(6)]
        for th in threads:
            th.start()
        for th in threads:
            th.join()
        return {"ok": True, "run_id": "abc", "name": name, "result": {},
                "agent_count": 6, "elapsed_s": 0.1, "warnings": []}

    monkeypatch.setattr(workflows, "run", fake_run)

    api = _api()
    idents = set()
    received = []
    emit_lock = _threading.Lock()

    def recording_emit(ev):
        with emit_lock:
            idents.add(_threading.get_ident())
            received.append(ev)

    api._emit = recording_emit

    res = api._run_workflow_with_ui_drain("review-changes", None, False)

    assert res["run_id"] == "abc"
    assert len(received) == 6 * 20, "every fanned-out event must still reach _emit"
    assert len(idents) == 1, (
        f"_emit was entered from {len(idents)} thread(s); it must be entered "
        "from exactly one, or the workflow's fan-out threads race on it")


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
    _saved = (_wf.list_library, _wf.list_runs, _wf.load_run, _wf.run)
    failed = 0
    for t, needs in [(test_launch_refuses_when_the_agent_is_busy, False),
                     (test_launch_refuses_an_unknown_workflow, True),
                     (test_the_result_is_appended_as_a_user_message, True),
                     (test_a_huge_result_is_capped_and_says_where_the_rest_is, False),
                     (test_a_failed_run_is_reported_not_silently_dropped, False),
                     (test_warnings_are_carried_into_the_conversation, False),
                     (test_list_runs_and_load_run_pass_through, True),
                     (test_events_from_many_threads_are_funneled_through_a_single_emit_thread, True),
                     (test_list_workflows_exposes_args_schema, True)]:
        try:
            t(monkeypatch) if needs else t()
            print(f"PASS {t.__name__}")
        except Exception as e:
            failed += 1
            import traceback; traceback.print_exc()
            print(f"FAIL {t.__name__}: {e}")
        finally:
            _wf.list_library, _wf.list_runs, _wf.load_run, _wf.run = _saved
    print("OK" if not failed else f"{failed} FAILED")
    _sys.exit(1 if failed else 0)
