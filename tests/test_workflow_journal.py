"""Offline tests for the workflow journal: content-addressed keys, append-per-call
durability, and resume replay."""
import sys as _sys, os as _os
_sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))

import json
import tempfile

from workflows import journal as J


def _tmp(name="journal.jsonl"):
    d = tempfile.mkdtemp(prefix="wfjournal-")
    return _os.path.join(d, name)


def test_key_is_stable_for_identical_inputs():
    a = J.call_key("researcher", "find the thing", {"tier": "cheap"})
    b = J.call_key("researcher", "find the thing", {"tier": "cheap"})
    assert a == b


def test_key_ignores_opts_ordering():
    a = J.call_key("researcher", "p", {"tier": "cheap", "model": "m"})
    b = J.call_key("researcher", "p", {"model": "m", "tier": "cheap"})
    assert a == b


def test_key_changes_with_prompt():
    assert J.call_key("researcher", "a", {}) != J.call_key("researcher", "b", {})


def test_key_changes_with_agent_type():
    assert J.call_key("researcher", "p", {}) != J.call_key("implementer", "p", {})


def test_record_then_replay_returns_the_result():
    path = _tmp()
    j = J.Journal(path)
    k = J.call_key("researcher", "p", {})
    j.record(k, 0, {"ok": True, "result": {"v": 1}})
    j.close()

    j2 = J.Journal(_tmp("second.jsonl"), replay_from=path)
    hit, result = j2.lookup(k)
    assert hit is True and result == {"v": 1}


def test_unmatched_key_is_a_miss():
    path = _tmp()
    j = J.Journal(path)
    j.record(J.call_key("researcher", "p", {}), 0, {"ok": True, "result": 1})
    j.close()
    j2 = J.Journal(_tmp("second.jsonl"), replay_from=path)
    hit, _ = j2.lookup(J.call_key("researcher", "DIFFERENT", {}))
    assert hit is False


def test_repeated_identical_calls_replay_in_order():
    # loop-until-dry reissues the SAME prompt; each occurrence must replay its own
    # recorded result, not the first one repeatedly.
    path = _tmp()
    j = J.Journal(path)
    k = J.call_key("researcher", "same", {})
    j.record(k, 0, {"ok": True, "result": "first"})
    j.record(k, 1, {"ok": True, "result": "second"})
    j.close()

    j2 = J.Journal(_tmp("second.jsonl"), replay_from=path)
    assert j2.lookup(k) == (True, "first")
    assert j2.lookup(k) == (True, "second")
    assert j2.lookup(k)[0] is False   # third call was never recorded


def test_replay_is_order_independent():
    # parallel/pipeline have no deterministic call order, so a resumed run must
    # match on CONTENT, not on position. Look up in the reverse of record order.
    path = _tmp()
    j = J.Journal(path)
    ka = J.call_key("researcher", "A", {})
    kb = J.call_key("researcher", "B", {})
    j.record(ka, 0, {"ok": True, "result": "ra"})
    j.record(kb, 0, {"ok": True, "result": "rb"})
    j.close()

    j2 = J.Journal(_tmp("second.jsonl"), replay_from=path)
    assert j2.lookup(kb) == (True, "rb")
    assert j2.lookup(ka) == (True, "ra")


def test_journal_is_readable_after_a_crash_mid_run():
    # Each record is flushed immediately, so a killed process still resumes.
    path = _tmp()
    j = J.Journal(path)
    j.record(J.call_key("researcher", "p", {}), 0, {"ok": True, "result": 1})
    # deliberately NOT closed — simulating a kill
    with open(path, "r", encoding="utf-8") as f:
        lines = [json.loads(ln) for ln in f if ln.strip()]
    assert len(lines) == 1 and lines[0]["result"] == 1


def test_write_agent_presence_is_tracked_for_the_resume_warning():
    path = _tmp()
    j = J.Journal(path)
    j.record(J.call_key("implementer", "p", {}), 0,
             {"ok": True, "result": 1, "is_write": True})
    j.close()
    j2 = J.Journal(_tmp("second.jsonl"), replay_from=path)
    assert j2.had_write_agents is True


# --- failures are history, never a cached answer (I7) ------------------------
def test_a_failed_entry_is_not_replayed_so_a_resume_retries_it():
    """Recording ok=False and replaying its None froze a transient failure in
    permanently: no resume could ever recover from it, which is the exact
    opposite of what resume is for."""
    path = _tmp("failed.jsonl")
    j = J.Journal(path)
    k = J.call_key("researcher", "p", {})
    j.record(k, 0, {"ok": False, "result": None})
    j.close()

    j2 = J.Journal(_tmp("second.jsonl"), replay_from=path)
    hit, value = j2.lookup(k)
    assert hit is False, "a failed call was replayed instead of retried"
    assert value is None


def test_a_failed_write_still_raises_the_side_effect_warning():
    """It is skipped as a REPLAY, not ignored — a write agent that failed may
    still have touched the workspace, so the resume warning must survive."""
    path = _tmp("failedwrite.jsonl")
    j = J.Journal(path)
    j.record(J.call_key("implementer", "p", {}), 0,
             {"ok": False, "result": None, "is_write": True})
    j.close()
    assert J.Journal(_tmp("second2.jsonl"), replay_from=path).had_write_agents is True


def test_a_successful_entry_beside_a_failed_one_still_replays():
    path = _tmp("mixed.jsonl")
    j = J.Journal(path)
    bad = J.call_key("researcher", "bad", {})
    good = J.call_key("researcher", "good", {})
    j.record(bad, 0, {"ok": False, "result": None})
    j.record(good, 0, {"ok": True, "result": "kept"})
    j.close()
    j2 = J.Journal(_tmp("second3.jsonl"), replay_from=path)
    assert j2.lookup(good) == (True, "kept")
    assert j2.lookup(bad)[0] is False


if __name__ == "__main__":
    tests = [test_key_is_stable_for_identical_inputs, test_key_ignores_opts_ordering,
             test_key_changes_with_prompt, test_key_changes_with_agent_type,
             test_record_then_replay_returns_the_result, test_unmatched_key_is_a_miss,
             test_repeated_identical_calls_replay_in_order,
             test_replay_is_order_independent,
             test_journal_is_readable_after_a_crash_mid_run,
             test_write_agent_presence_is_tracked_for_the_resume_warning,
             test_a_failed_entry_is_not_replayed_so_a_resume_retries_it,
             test_a_failed_write_still_raises_the_side_effect_warning,
             test_a_successful_entry_beside_a_failed_one_still_replays]
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
