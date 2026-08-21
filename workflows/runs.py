"""Readers over the on-disk run directories.

Nothing here writes. Every field these return was already persisted by run() —
the journal in particular holds each agent's result, model, tokens and elapsed
time, which is why per-agent inspection needed a reader rather than a new
transcript format.

Degradation is the design point: one corrupt directory must not cost the user
the whole history, and a run made before the summary fields existed must still
list. Same discipline as devices.load_devices.
"""
import json
import os
import re

# Production run ids are uuid4().hex[:12] (12 lowercase hex chars), but this
# guard's job is to keep a model- or UI-supplied id from reaching os.path.join
# as a traversal ("../../etc"), not to enforce that exact shape — so it accepts
# any plain alnum/underscore/hyphen id and rejects path separators and dots.
_RUN_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def _runs_dir(run_root=None):
    from . import get_run_root
    return os.path.join(run_root if run_root is not None else get_run_root(),
                        "workflows")


def _read_json(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def _count_journal_rows(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return sum(1 for line in f if line.strip())
    except OSError:
        return 0


def _summarise(d, run_id):
    meta_raw = _read_json(os.path.join(d, "meta.json"))
    if not isinstance(meta_raw, dict):
        return None                     # corrupt or missing: skip, do not raise
    meta = meta_raw.get("meta") or {}
    res = _read_json(os.path.join(d, "result.json")) or {}

    # Legacy runs predate the summary fields. Derive what we can and report the
    # rest as unknown — a blank column is honest; a guess is not.
    agent_count = res.get("agent_count")
    if agent_count is None:
        agent_count = _count_journal_rows(os.path.join(d, "journal.jsonl"))
    started = res.get("started")
    if started is None:
        try:
            started = os.path.getctime(d)
        except OSError:
            started = 0.0
    return {
        "run_id": run_id,
        "name": res.get("name") or meta.get("name") or "",
        "ok": res.get("ok"),
        "aborted": res.get("aborted"),
        "agent_count": agent_count,
        "elapsed_s": res.get("elapsed_s"),
        "started": started,
        "finished": res.get("finished"),
    }


def list_runs(limit=50, run_root=None):
    """Newest-first summaries of past runs. A corrupt directory is skipped."""
    base = _runs_dir(run_root)
    try:
        names = os.listdir(base)
    except OSError:
        return []
    out = []
    for name in names:
        d = os.path.join(base, name)
        if not os.path.isdir(d):
            continue
        row = _summarise(d, name)
        if row is not None:
            out.append(row)
    out.sort(key=lambda r: r.get("started") or 0, reverse=True)
    return out[:max(0, int(limit))]


def load_run(run_id, run_root=None):
    """The full record for one run: meta, every journal row, and the result."""
    if not _RUN_ID.match(str(run_id or "")):
        return {"ok": False, "error": f"invalid run id: {run_id!r}", "rows": []}
    d = os.path.join(_runs_dir(run_root), run_id)
    meta_raw = _read_json(os.path.join(d, "meta.json"))
    if not isinstance(meta_raw, dict):
        return {"ok": False, "error": f"no readable run {run_id!r}", "rows": []}

    rows = []
    try:
        with open(os.path.join(d, "journal.jsonl"), "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    rows.append(json.loads(line))
                except ValueError:
                    continue        # a torn final line from a kill; skip it
    except OSError:
        pass

    res = _read_json(os.path.join(d, "result.json")) or {}
    summary = _summarise(d, run_id) or {}
    return {"ok": True, "error": "", "run_id": run_id,
            "meta": meta_raw.get("meta") or {}, "args": meta_raw.get("args"),
            "rows": rows, "result": res.get("result"), "summary": summary}
