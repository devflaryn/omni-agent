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
