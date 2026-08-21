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


# --- resume must be idempotent across MANY resumes (C1) ---------------------
def test_a_double_resume_still_re_runs_nothing(monkeypatch):
    """A -> B -> C. B replayed A's journal but recorded nothing into its own, so
    C resumed from a 0-byte journal and re-ran (and re-paid for) every call A
    made. This targets hours-to-days runs, so a resume of a resume is the normal
    case, not an edge one."""
    calls = {"n": 0}

    def counter(ad, p, **k):
        calls["n"] += 1
        return {"ok": True, "report": p, "raw_report": p, "tokens": 1}

    _install(monkeypatch, counter)
    root = _root()
    a = workflows.run(src=GOOD, run_root=root)
    assert calls["n"] == 3

    b = workflows.run(src=GOOD, run_root=root, resume_from=a["run_id"])
    assert calls["n"] == 3, "resume B re-ran work"
    jb = _os.path.join(root, "workflows", b["run_id"], "journal.jsonl")
    assert _os.path.getsize(jb) > 0, "resume B wrote an empty journal"

    c = workflows.run(src=GOOD, run_root=root, resume_from=b["run_id"])
    assert calls["n"] == 3, "resume C re-ran work a resume already had"
    assert c["result"] == a["result"]

    # …and a fourth, to prove the history keeps carrying rather than decaying.
    d = workflows.run(src=GOOD, run_root=root, resume_from=c["run_id"])
    assert calls["n"] == 3 and d["result"] == a["result"]


def test_a_resumed_write_warning_survives_the_second_resume(monkeypatch):
    _install(monkeypatch)
    root = _root()
    src = ('meta = {"name": "w", "description": "d"}\n'
           'return agent("edit", agent_type="implementer", scope=["src/"])\n')
    a = workflows.run(src=src, run_root=root)
    b = workflows.run(src=src, run_root=root, resume_from=a["run_id"])
    c = workflows.run(src=src, run_root=root, resume_from=b["run_id"])
    assert any("write" in w.lower() for w in c["warnings"]), (
        "the write-side-effect warning was lost on the second resume")


def test_a_failed_call_is_retried_on_resume_not_replayed(monkeypatch):
    """The point of a resume is to recover from a transient failure. Caching
    ok=False made that impossible."""
    state = {"fail": True, "n": 0}

    def flaky(ad, p, **k):
        state["n"] += 1
        if state["fail"]:
            return {"ok": False, "report": "", "raw_report": "", "error": "boom"}
        return {"ok": True, "report": "recovered", "raw_report": "recovered"}

    _install(monkeypatch, flaky)
    src = ('meta = {"name": "flaky", "description": "d"}\n'
           'return agent("do it")\n')
    root = _root()
    first = workflows.run(src=src, run_root=root)
    assert first["result"] is None and state["n"] == 1

    state["fail"] = False
    second = workflows.run(src=src, run_root=root, resume_from=first["run_id"])
    assert state["n"] == 2, "the failed call was replayed instead of retried"
    assert second["result"] == "recovered"


# --- the run root is configured, not the CWD (I2) ---------------------------
def test_run_root_defaults_to_the_configured_root(monkeypatch):
    _install(monkeypatch)
    root = _root()
    prev = workflows.get_run_root()
    try:
        workflows.set_run_root(root)
        assert workflows.get_run_root() == root
        res = workflows.run(src=GOOD)          # no run_root= at all
        assert _os.path.isdir(_os.path.join(root, "workflows", res["run_id"]))
    finally:
        workflows.set_run_root(prev)


def test_set_run_root_falls_back_to_cwd_when_cleared(monkeypatch=None):
    prev = workflows.get_run_root()
    try:
        workflows.set_run_root(None)
        assert workflows.get_run_root() == "."
    finally:
        workflows.set_run_root(prev)


# --- validate() must not leak a temp dir (I6) -------------------------------
def test_validate_leaves_no_temp_directory_behind(monkeypatch):
    import glob as _glob
    import tempfile as _tf
    _install(monkeypatch)
    before = set(_glob.glob(_os.path.join(_tf.gettempdir(), "wfdry-*")))
    for _ in range(3):
        assert workflows.validate(GOOD)["ok"] is True
    after = set(_glob.glob(_os.path.join(_tf.gettempdir(), "wfdry-*")))
    assert after == before, f"validate leaked: {sorted(after - before)}"


def test_a_failing_dry_run_also_cleans_up(monkeypatch):
    import glob as _glob
    import tempfile as _tf
    _install(monkeypatch)
    bad = ('meta = {"name": "b", "description": "d"}\n'
           'return {"x": 1}["nope"]\n')
    before = set(_glob.glob(_os.path.join(_tf.gettempdir(), "wfdry-*")))
    assert workflows.validate(bad)["ok"] is False
    assert set(_glob.glob(_os.path.join(_tf.gettempdir(), "wfdry-*"))) == before


# --- resume_from is model-supplied and reaches os.path.join (M3) ------------
def test_a_malformed_resume_id_is_treated_as_no_journal(monkeypatch):
    _install(monkeypatch)
    root = _root()
    for bad in ["../../etc", "not a run id", "ABCDEF012345", "abc", ""]:
        res = workflows.run(src=GOOD, run_root=root, resume_from=bad)
        assert res["ok"] is True
        if bad:
            assert any("no journal found" in w for w in res["warnings"]), bad


# --- an aborted run returns partial results (M4) ----------------------------
ABORTS = '''
meta = {"name": "ab", "description": "d"}
phase("One")
first = agent("first call")
log("stopping now")
second = agent("second call")
return {"first": first, "second": second}
'''


def test_an_aborted_run_returns_partial_results_not_none(monkeypatch):
    """The spec: an aborted run 'returns partial results with aborted: true'."""
    seen = {"n": 0}

    def stopper(ad, p, **k):
        seen["n"] += 1
        if seen["n"] == 1:
            workflows.abort()          # the Stop button, mid-run
        return {"ok": True, "report": p, "raw_report": p, "tokens": 1}

    _install(monkeypatch, stopper)
    res = workflows.run(src=ABORTS, run_root=_root())
    assert res["aborted"] is True
    assert res["result"] is not None, "an aborted run threw away everything it did"
    assert res["result"]["aborted"] is True
    done = [p["result"] for p in res["result"]["partial"]]
    assert done == ["first call"]


def test_result_json_carries_the_run_summary(monkeypatch):
    # A history list cannot report what was never persisted: agent_count, aborted
    # and elapsed are computed by run() and were previously thrown away.
    _install(monkeypatch)
    import json as _json
    root = _root()
    res = workflows.run(src=GOOD, run_root=root)
    path = _os.path.join(root, "workflows", res["run_id"], "result.json")
    saved = _json.load(open(path, encoding="utf-8"))
    assert saved["name"] == "demo"
    assert saved["agent_count"] == 3
    assert saved["aborted"] is False
    assert isinstance(saved["elapsed_s"], (int, float))
    assert saved["started"] > 0 and saved["finished"] >= saved["started"]


def test_the_summary_is_written_even_when_the_script_raises(monkeypatch):
    # The write lives in a finally; a crashed run must still be listable.
    _install(monkeypatch)
    import json as _json
    root = _root()
    # validate() dry-runs the WHOLE script (deterministically) before a single
    # token is spent, so an unconditional raise would be caught there instead —
    # never reaching run_id creation. dry-run stubs agent() as "[dry-run:...]",
    # while the mocked real run echoes the prompt back, so gating on the
    # returned value is what makes this crash only the real run.
    bad = ('meta = {"name": "boom", "description": "d"}\n'
           'r = agent("one")\n'
           'if r == "one":\n'
           '    raise ValueError("nope")\n')
    res = workflows.run(src=bad, run_root=root)
    assert res["ok"] is False
    path = _os.path.join(root, "workflows", res["run_id"], "result.json")
    saved = _json.load(open(path, encoding="utf-8"))
    assert saved["ok"] is False
    assert saved["agent_count"] == 1, "the agents that DID run must still be counted"
    assert saved["name"] == "boom"


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
             test_args_reach_the_script, test_validate_reports_meta_without_running,
             test_a_workflow_can_call_a_library_workflow,
             test_child_agents_count_toward_the_parent,
             test_nesting_two_levels_deep_is_refused,
             test_child_events_carry_a_group_label,
             test_a_double_resume_still_re_runs_nothing,
             test_a_resumed_write_warning_survives_the_second_resume,
             test_a_failed_call_is_retried_on_resume_not_replayed,
             test_run_root_defaults_to_the_configured_root,
             test_set_run_root_falls_back_to_cwd_when_cleared,
             test_validate_leaves_no_temp_directory_behind,
             test_a_failing_dry_run_also_cleans_up,
             test_a_malformed_resume_id_is_treated_as_no_journal,
             test_an_aborted_run_returns_partial_results_not_none,
             test_result_json_carries_the_run_summary,
             test_the_summary_is_written_even_when_the_script_raises]
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
