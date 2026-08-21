"""Offline tests for the workflow runtime. A fake run_subagent stands in for the
LLM everywhere, so these are pure control-flow assertions."""
import sys as _sys, os as _os
_sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))

import json as _json
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


# --- the result rides on wf_agent_done (click-through, live AND historical) ---
def test_wf_agent_done_carries_the_agents_result(monkeypatch):
    """Click-through is specified as "identical for live and historical runs,
    because both are journal rows". The frontend stores ev.result on the row so
    a later click can render it; this event never carried one, so clicking an
    agent during or after a LIVE run rendered an EMPTY body while the very same
    run reopened from history rendered it fine."""
    _install(monkeypatch, lambda *a, **k: {"ok": True, "report": "the answer",
                                           "raw_report": "the answer", "tokens": 3})
    events = []
    d = tempfile.mkdtemp(prefix="wfrt-")
    j = J.Journal(_os.path.join(d, "journal.jsonl"))
    rt = R.WorkflowRuntime(j, run_dir=d, on_event=events.append)
    rt.agent("p", label="my-label")
    done = [e for e in events if e["type"] == "wf_agent_done"][0]
    assert "result" in done, "wf_agent_done must carry the agent's result"
    assert done["result"] == "the answer"


def test_a_cache_hit_also_carries_its_replayed_result(monkeypatch):
    """The replay path emits its own wf_agent_done. A resumed run's rows must
    click through to the same body a cold run's rows do."""
    _install(monkeypatch, lambda *a, **k: {"ok": True, "report": "x", "raw_report": "x"})
    d = tempfile.mkdtemp(prefix="wfrt-")
    old = _os.path.join(d, "old.jsonl")
    j = J.Journal(old)
    k = J.call_key("researcher", "p", {})
    j.record(k, 0, {"ok": True, "result": "from-cache"})
    j.close()

    events = []
    j2 = J.Journal(_os.path.join(d, "new.jsonl"), replay_from=old)
    rt = R.WorkflowRuntime(j2, run_dir=d, on_event=events.append)
    assert rt.agent("p") == "from-cache"
    done = [e for e in events if e["type"] == "wf_agent_done"][0]
    assert done["cached"] is True
    assert "result" in done, "a replayed wf_agent_done must carry its result too"
    assert done["result"] == "from-cache"


def test_a_huge_result_is_truncated_on_the_event_but_not_in_the_journal(monkeypatch):
    """Every wf_agent_done crosses the JS bridge. An audit finding can be tens
    of KB, so the EVENT carries a capped copy — the journal (and therefore
    load_run) keeps the whole thing."""
    big = "y" * 50000
    _install(monkeypatch, lambda *a, **k: {"ok": True, "report": big, "raw_report": big})
    events = []
    d = tempfile.mkdtemp(prefix="wfrt-")
    path = _os.path.join(d, "journal.jsonl")
    j = J.Journal(path)
    rt = R.WorkflowRuntime(j, run_dir=d, on_event=events.append)
    rt.agent("p")
    j.close()
    done = [e for e in events if e["type"] == "wf_agent_done"][0]
    assert len(done["result"]) < len(big), "a huge result must not cross the bridge whole"
    assert len(done["result"]) <= R.MAX_EVENT_RESULT_CHARS + 200
    assert "truncated" in done["result"], "truncation must be marked, not silent"

    rows = [_json.loads(l) for l in open(path, encoding="utf-8") if l.strip()]
    assert rows[0]["result"] == big, "the journal keeps the FULL result"


def test_a_structured_result_small_enough_crosses_intact(monkeypatch):
    _install(monkeypatch, lambda *a, **k: {"ok": True, "report": "x",
                                           "raw_report": {"confirmed": ["a bug"]}})
    events = []
    d = tempfile.mkdtemp(prefix="wfrt-")
    j = J.Journal(_os.path.join(d, "journal.jsonl"))
    rt = R.WorkflowRuntime(j, run_dir=d, on_event=events.append)
    rt.agent("p", schema={"confirmed": "list"})
    done = [e for e in events if e["type"] == "wf_agent_done"][0]
    assert done["result"] == {"confirmed": ["a bug"]}


def test_label_defaults_to_a_trimmed_prompt(monkeypatch):
    _install(monkeypatch, lambda *a, **k: {"ok": True, "report": "x", "raw_report": "x"})
    events = []
    d = tempfile.mkdtemp(prefix="wfrt-")
    j = J.Journal(_os.path.join(d, "journal.jsonl"))
    rt = R.WorkflowRuntime(j, run_dir=d, on_event=events.append)
    rt.agent("a very long prompt " * 10)
    label = [e for e in events if e["type"] == "wf_agent_started"][0]["label"]
    assert 0 < len(label) <= 48


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


# --- sub_id uniqueness (I3) -------------------------------------------------
def test_two_concurrent_identical_prompts_get_distinct_sub_ids(monkeypatch):
    """sub_id used to BE the journal key, which is content-addressed — so two
    branches asking the identical question emitted the same id. The frontend
    keys its agent rows by sub_id, so one row overwrote the other, running/done
    were double-counted, and findAgent could update the wrong phase.
    review-changes hits this whenever two dimensions report the same finding."""
    _install(monkeypatch, lambda *a, **k: {"ok": True, "report": "r", "raw_report": "r",
                                           "tokens": 1})
    events = []
    d = tempfile.mkdtemp(prefix="wfrt-")
    j = J.Journal(_os.path.join(d, "journal.jsonl"))
    rt = R.WorkflowRuntime(j, run_dir=d, on_event=events.append)
    rt.parallel([lambda: rt.agent("the same prompt"),
                 lambda: rt.agent("the same prompt")])
    ids = [e["sub_id"] for e in events if e["type"] == "wf_agent_started"]
    assert len(ids) == 2
    assert ids[0] != ids[1], f"identical prompts collided on sub_id: {ids}"
    # Every done event must address a started one, or the UI row never settles.
    done = [e["sub_id"] for e in events if e["type"] == "wf_agent_done"]
    assert sorted(done) == sorted(ids)


def test_sub_id_carries_the_journal_key_and_its_occurrence(monkeypatch):
    _install(monkeypatch, lambda *a, **k: {"ok": True, "report": "r", "raw_report": "r"})
    events = []
    d = tempfile.mkdtemp(prefix="wfrt-")
    rt = R.WorkflowRuntime(J.Journal(_os.path.join(d, "journal.jsonl")),
                           run_dir=d, on_event=events.append)
    rt.agent("p")
    sub_id = [e for e in events if e["type"] == "wf_agent_started"][0]["sub_id"]
    assert sub_id == J.call_key("researcher", "p", {}) + ":0"


# --- replay is re-recorded (C1) ---------------------------------------------
def test_a_replayed_result_is_recorded_into_the_new_journal(monkeypatch):
    """A resume writes a FRESH journal. If a cache hit records nothing, that
    journal holds only the delta this run executed and the NEXT resume re-runs
    (and re-pays for) everything the first run did."""
    d = tempfile.mkdtemp(prefix="wfrt-")
    old = _os.path.join(d, "old.jsonl")
    j = J.Journal(old)
    k = J.call_key("researcher", "p", {})
    j.record(k, 0, {"ok": True, "result": "from-cache"})
    j.close()

    _install(monkeypatch, lambda *a, **kw: {"ok": True, "report": "fresh",
                                            "raw_report": "fresh"})
    new = _os.path.join(d, "new.jsonl")
    j2 = J.Journal(new, replay_from=old)
    rt = R.WorkflowRuntime(j2, run_dir=d)
    assert rt.agent("p") == "from-cache"
    j2.close()

    rows = [_json.loads(l) for l in open(new, encoding="utf-8") if l.strip()]
    assert len(rows) == 1, "the replayed call was not carried into the new journal"
    assert rows[0]["key"] == k and rows[0]["occ"] == 0
    assert rows[0]["result"] == "from-cache"
    assert rows[0]["cached"] is True and rows[0]["ok"] is True


# --- nested-run group is persisted to the journal (fix round 1) -------------
# runtime.py's _emit sets ev["group"] = self.emit_prefix for every event of a
# nested workflow — Task 7's frontend grouping reads that live. The journal
# row load_run hands back must carry the SAME value, or a historical view of
# a nested run renders flat while the live run it came from grouped
# correctly. Covers both journal.record() call sites in agent().
def test_nested_workflow_group_is_persisted_to_the_journal(monkeypatch):
    _install(monkeypatch, lambda *a, **k: {"ok": True, "report": "x", "raw_report": "x",
                                            "tokens": 1})
    d = tempfile.mkdtemp(prefix="wfrt-")
    path = _os.path.join(d, "journal.jsonl")
    j = J.Journal(path)
    top = R.WorkflowRuntime(j, run_dir=d)
    top.agent("top level call")
    child = R.WorkflowRuntime(j, run_dir=d, emit_prefix="understand-subsystem")
    child.agent("nested call")
    j.close()

    rows = [_json.loads(l) for l in open(path, encoding="utf-8") if l.strip()]
    assert len(rows) == 2
    assert rows[0].get("group") is None,         "a top-level agent's journal row must not carry a group"
    assert rows[1].get("group") == "understand-subsystem",         "a nested workflow's journal row must carry the same group its live event carried"


def test_a_replayed_nested_workflow_agent_keeps_its_group(monkeypatch):
    """The cache-hit path (a resume) re-records the replayed result into a
    fresh journal — it must carry `group` too, or resuming a nested run loses
    the grouping the original run had."""
    _install(monkeypatch, lambda *a, **k: {"ok": True, "report": "x", "raw_report": "x"})
    d = tempfile.mkdtemp(prefix="wfrt-")
    old = _os.path.join(d, "old.jsonl")
    j = J.Journal(old)
    k = J.call_key("researcher", "p", {})
    j.record(k, 0, {"ok": True, "result": "from-cache"})
    j.close()

    new = _os.path.join(d, "new.jsonl")
    j2 = J.Journal(new, replay_from=old)
    child = R.WorkflowRuntime(j2, run_dir=d, emit_prefix="understand-subsystem")
    assert child.agent("p") == "from-cache"
    j2.close()

    rows = [_json.loads(l) for l in open(new, encoding="utf-8") if l.strip()]
    assert len(rows) == 1
    assert rows[0]["cached"] is True
    assert rows[0].get("group") == "understand-subsystem",         "a replayed nested-workflow call must keep its group in the new journal"


# --- partial results on abort (M4) ------------------------------------------
def test_completed_results_survive_as_partials(monkeypatch):
    _install(monkeypatch, lambda ad, p, **k: {"ok": True, "report": p, "raw_report": p})
    rt = _rt()
    rt.agent("one")
    rt.agent("two")
    got = [r["result"] for r in rt.partial_results()]
    assert got == ["one", "two"]


def test_nested_fan_out_cannot_exceed_the_live_branch_cap(monkeypatch):
    # MAX_ITEMS bounds ONE call. The product is what was unbounded:
    # pipeline(256) whose stages each parallel(256) is ~65k threads.
    #
    # A raising branch is isolated by _spawn's runner (result -> None, logged,
    # the rest of the wave keeps going — see its docstring: "one bad branch
    # must not take down the wave"). That isolation is existing behavior, not
    # part of this cap, so a WorkflowScriptError from the cap never escapes
    # pipeline()/parallel() when it fires inside a nested branch — it surfaces
    # as a dropped item plus a logged wf_log event instead. This asserts on
    # that observable effect rather than a raise out of pipeline().
    _install(monkeypatch, lambda ad, p, **k: {"ok": True, "report": "x",
                                              "raw_report": "x"})
    events = []
    d = tempfile.mkdtemp(prefix="wfrt-")
    j = J.Journal(_os.path.join(d, "journal.jsonl"))
    rt = R.WorkflowRuntime(j, run_dir=d, on_event=events.append)
    monkeypatch.setattr(R, "MAX_LIVE_BRANCHES", 8)

    # 4 pipeline branches reserve 4 slots; only 1 of the 4 nested parallel(4)
    # calls fits in the remaining 4, so the other 3 must be capped.
    #
    # "must" needs a gate to be true. The winner releases its 4 slots as soon
    # as its thunks return, so with instant thunks a loser could arrive AFTER
    # that release, find 4 free slots and succeed — count(None) would be 2.
    # The gate makes the ordering explicit instead of hoping for it: every
    # thunk parks until all four branches have finished their cap check, so
    # the winner provably still holds its slots while the losers check.
    gate = threading.Event()
    arrived = set()
    arrived_lock = threading.Lock()

    def arrive(i):
        with arrived_lock:
            arrived.add(i)
            if len(arrived) == 4:
                gate.set()          # all four checks are done; let the winner finish

    def stage(value, orig, i):
        def thunk():
            arrive(i)               # reached only by the branch that RESERVED
            assert gate.wait(30), "the four branches never all reached the cap check"
            return 1
        try:
            return rt.parallel([thunk] * 4)
        except R.WorkflowScriptError:
            arrive(i)               # this branch checked, and lost
            raise

    out = rt.pipeline(list(range(4)), stage)
    assert out.count(None) == 3, "exactly 3 of 4 nested fan-outs must be capped"
    logs = [e["message"] for e in events if e.get("type") == "wf_log"]
    assert any("too many concurrent branches" in m and "8" in m for m in logs), (
        "the error must name the cap")


def test_the_live_branch_counter_returns_to_zero(monkeypatch):
    # A leaked counter would make every later fan-out fail for no reason.
    _install(monkeypatch, lambda ad, p, **k: {"ok": True, "report": "x",
                                              "raw_report": "x"})
    rt = _rt()
    rt.parallel([lambda: 1, lambda: 2])
    assert rt._live_branches == 0


def test_the_counter_returns_to_zero_even_when_a_branch_raises(monkeypatch):
    _install(monkeypatch, lambda ad, p, **k: {"ok": True, "report": "x",
                                              "raw_report": "x"})
    rt = _rt()

    def boom():
        raise ValueError("nope")

    rt.parallel([boom, lambda: 1])
    assert rt._live_branches == 0


def test_a_child_workflow_counts_against_the_same_budget(monkeypatch):
    # Child runtimes share _count_lock; they must share this budget too, or
    # nesting reopens the hole the cap exists to close.
    _install(monkeypatch, lambda ad, p, **k: {"ok": True, "report": "x",
                                              "raw_report": "x"})
    rt = _rt()
    child = R.WorkflowRuntime(rt.journal, run_dir=rt.run_dir)
    child._count_lock = rt._count_lock
    child._branch_owner = rt
    rt._live_branches = 5
    assert child._branch_owner._live_branches == 5


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
             test_wf_agent_done_carries_the_agents_result,
             test_a_cache_hit_also_carries_its_replayed_result,
             test_a_huge_result_is_truncated_on_the_event_but_not_in_the_journal,
             test_a_structured_result_small_enough_crosses_intact,
             test_label_defaults_to_a_trimmed_prompt,
             test_parallel_returns_results_in_input_order,
             test_parallel_isolates_a_raising_thunk_as_none,
             test_parallel_actually_runs_concurrently,
             test_pipeline_threads_each_item_through_every_stage,
             test_pipeline_stage_receives_original_item_and_index,
             test_pipeline_drops_a_failing_item_to_none_and_skips_its_rest,
             test_pipeline_has_no_barrier_between_stages,
             test_item_cap_is_an_explicit_error_not_a_silent_truncation,
             test_nested_parallel_inside_pipeline_does_not_deadlock_at_concurrency_one,
             test_two_concurrent_identical_prompts_get_distinct_sub_ids,
             test_sub_id_carries_the_journal_key_and_its_occurrence,
             test_a_replayed_result_is_recorded_into_the_new_journal,
             test_nested_workflow_group_is_persisted_to_the_journal,
             test_a_replayed_nested_workflow_agent_keeps_its_group,
             test_completed_results_survive_as_partials,
             test_nested_fan_out_cannot_exceed_the_live_branch_cap,
             test_the_live_branch_counter_returns_to_zero,
             test_the_counter_returns_to_zero_even_when_a_branch_raises,
             test_a_child_workflow_counts_against_the_same_budget]
    failed = 0
    _orig_run, _orig_get = R.run_subagent, R.get_agent
    _orig_cap = R.MAX_LIVE_BRANCHES
    for t in tests:
        try:
            t(monkeypatch); print(f"PASS {t.__name__}")
        except Exception as e:
            failed += 1
            import traceback; traceback.print_exc()
            print(f"FAIL {t.__name__}: {e}")
        finally:
            # MAX_LIVE_BRANCHES too: the cap test lowers it to 8 and this
            # runner's monkeypatch has no undo, so without this every LATER
            # test in the list would run against the lowered cap.
            R.run_subagent, R.get_agent = _orig_run, _orig_get
            R.MAX_LIVE_BRANCHES = _orig_cap
    print("OK" if not failed else f"{failed} FAILED")
    _sys.exit(1 if failed else 0)
