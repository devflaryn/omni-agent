"""The workflow journal: every completed agent() call, appended as one JSON line.

Keys are CONTENT-ADDRESSED, not positional. That is the load-bearing decision in
this file. With parallel() and pipeline() there is no deterministic call ORDER —
the same script run twice issues its calls in whatever order threads win — so an
ordinal key would restore the wrong cached result into the wrong branch on
resume. Hashing (agent_type, prompt, opts) is order-independent, and it cascades
correctly for free: a changed upstream result changes the downstream prompt,
which changes its key, which re-runs it and everything derived from it.

An occurrence counter disambiguates genuinely repeated identical calls, which is
what a loop-until-dry pattern produces.
"""
import hashlib
import json
import os
import threading


def call_key(agent_type, prompt, opts=None):
    """16 hex chars identifying an agent call by its CONTENT."""
    canonical = json.dumps(opts or {}, sort_keys=True, default=str)
    blob = f"{agent_type or ''}\x00{prompt or ''}\x00{canonical}"
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:16]


class Journal:
    """Append-only writer plus an optional replay map loaded from a prior run.

    Thread-safe: agent() calls arrive from many branch threads at once."""

    def __init__(self, path, replay_from=None):
        self.path = path
        self._lock = threading.Lock()
        self._occ = {}          # key -> next occurrence index to WRITE
        self._replay = {}       # key -> [result, result, ...] in recorded order
        self._replay_occ = {}   # key -> next occurrence index to READ
        self.had_write_agents = False

        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        self._fh = open(path, "a", encoding="utf-8")

        if replay_from:
            self._load_replay(replay_from)

    def _load_replay(self, src):
        try:
            with open(src, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        entry = json.loads(line)
                    except ValueError:
                        continue    # a torn final line from a kill; skip it
                    key = entry.get("key")
                    if not key:
                        continue
                    self._replay.setdefault(key, []).append(entry.get("result"))
                    if entry.get("is_write"):
                        self.had_write_agents = True
        except OSError:
            pass    # no prior journal is simply a cold run

    def lookup(self, key):
        """(hit, result) for the NEXT occurrence of `key`. Consumes it."""
        with self._lock:
            bucket = self._replay.get(key)
            if not bucket:
                return (False, None)
            i = self._replay_occ.get(key, 0)
            if i >= len(bucket):
                return (False, None)
            self._replay_occ[key] = i + 1
            return (True, bucket[i])

    def next_occurrence(self, key):
        with self._lock:
            i = self._occ.get(key, 0)
            self._occ[key] = i + 1
            return i

    def record(self, key, occ, entry):
        """Append one completed call and FLUSH — a killed process must still
        resume everything that finished."""
        row = dict(entry)
        row["key"] = key
        row["occ"] = occ
        line = json.dumps(row, default=str, ensure_ascii=False)
        with self._lock:
            if entry.get("is_write"):
                self.had_write_agents = True
            self._fh.write(line + "\n")
            self._fh.flush()
            os.fsync(self._fh.fileno())

    def close(self):
        with self._lock:
            try:
                self._fh.close()
            except OSError:
                pass
