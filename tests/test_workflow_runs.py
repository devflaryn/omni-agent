"""Readers over the on-disk run directories. No new artifacts are written here —
the journal already holds every agent's result, model, tokens and elapsed time."""
import sys as _sys, os as _os
_sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))

import json
import tempfile

from workflows import runs as R


def _mkrun(root, run_id, *, name="demo", ok=True, rows=2, summary=True, mtime=None):
    d = _os.path.join(root, "workflows", run_id)
    _os.makedirs(d, exist_ok=True)
    with open(_os.path.join(d, "meta.json"), "w", encoding="utf-8") as f:
        json.dump({"meta": {"name": name, "description": "d"}, "args": {},
                   "resume_from": None}, f)
    payload = {"ok": ok, "error": "", "result": {"x": 1}}
    if summary:
        payload.update(name=name, aborted=False, agent_count=rows,
                       elapsed_s=1.5, started=1000.0, finished=1001.5)
    with open(_os.path.join(d, "result.json"), "w", encoding="utf-8") as f:
        json.dump(payload, f)
    with open(_os.path.join(d, "journal.jsonl"), "w", encoding="utf-8") as f:
        for i in range(rows):
            f.write(json.dumps({"key": f"k{i}", "occ": 0, "ok": True,
                                "result": f"r{i}", "phase": "Scan",
                                "label": f"agent {i}", "agent_type": "researcher",
                                "tokens": 10, "elapsed_s": 0.5,
                                "model": "m", "cached": False}) + "\n")
    if mtime:
        _os.utime(d, (mtime, mtime))
    return d


def _root():
    return tempfile.mkdtemp(prefix="wfruns-")


def test_empty_root_lists_nothing():
    assert R.list_runs(run_root=_root()) == []


def test_a_run_is_summarised():
    root = _root()
    _mkrun(root, "aaa111", name="review-changes", rows=3)
    got = R.list_runs(run_root=root)
    assert len(got) == 1
    r = got[0]
    assert r["run_id"] == "aaa111" and r["name"] == "review-changes"
    assert r["agent_count"] == 3 and r["ok"] is True and r["aborted"] is False


def test_runs_are_newest_first():
    root = _root()
    _mkrun(root, "old", mtime=1000)
    _mkrun(root, "new", mtime=9000)
    ids = [r["run_id"] for r in R.list_runs(run_root=root)]
    assert ids[0] == "new"


def test_limit_is_honoured():
    root = _root()
    for i in range(5):
        _mkrun(root, f"r{i}", mtime=1000 + i)
    assert len(R.list_runs(limit=2, run_root=root)) == 2


def test_a_corrupt_run_is_skipped_not_fatal():
    # One bad directory must not cost the user the whole list.
    root = _root()
    _mkrun(root, "good")
    bad = _os.path.join(root, "workflows", "bad")
    _os.makedirs(bad)
    with open(_os.path.join(bad, "meta.json"), "w", encoding="utf-8") as f:
        f.write("{not json")
    ids = [r["run_id"] for r in R.list_runs(run_root=root)]
    assert ids == ["good"]


def test_a_legacy_run_without_summary_fields_still_lists():
    # Runs made before the summary existed must not vanish from history.
    root = _root()
    _mkrun(root, "legacy", rows=4, summary=False)
    r = R.list_runs(run_root=root)[0]
    assert r["run_id"] == "legacy"
    assert r["agent_count"] == 4, "derived from counting journal lines"
    assert r["elapsed_s"] is None, "unknown, not guessed"
    assert r["aborted"] is None


def test_load_run_returns_meta_journal_and_result():
    root = _root()
    _mkrun(root, "aaa111", rows=2)
    rec = R.load_run("aaa111", run_root=root)
    assert rec["ok"] is True
    assert rec["meta"]["name"] == "demo"
    assert len(rec["rows"]) == 2
    assert rec["rows"][0]["label"] == "agent 0"
    assert rec["rows"][0]["result"] == "r0"
    assert rec["result"] == {"x": 1}


def test_load_run_tolerates_a_torn_journal():
    # A killed process leaves a half-written final line.
    root = _root()
    d = _mkrun(root, "torn", rows=2)
    with open(_os.path.join(d, "journal.jsonl"), "a", encoding="utf-8") as f:
        f.write('{"key": "half')
    rec = R.load_run("torn", run_root=root)
    assert len(rec["rows"]) == 2, "the intact rows still load"


def test_load_run_unknown_id_is_an_error_not_a_crash():
    rec = R.load_run("nope", run_root=_root())
    assert rec["ok"] is False and "nope" in rec["error"]


def test_load_run_rejects_a_traversing_id():
    rec = R.load_run("../../etc", run_root=_root())
    assert rec["ok"] is False


if __name__ == "__main__":
    tests = [test_empty_root_lists_nothing, test_a_run_is_summarised,
             test_runs_are_newest_first, test_limit_is_honoured,
             test_a_corrupt_run_is_skipped_not_fatal,
             test_a_legacy_run_without_summary_fields_still_lists,
             test_load_run_returns_meta_journal_and_result,
             test_load_run_tolerates_a_torn_journal,
             test_load_run_unknown_id_is_an_error_not_a_crash,
             test_load_run_rejects_a_traversing_id]
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
