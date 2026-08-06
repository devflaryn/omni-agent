"""Structured Build Ledger — the authoritative physical manifest of a large,
multi-artifact modification.

A single active BuildLedger is tracked per process — the same singleton pattern
planning.py / investigation.py use, and for the same reason: this app runs one
session at a time. Where investigation memory records the *reasoning* (evidence,
hypotheses, decisions), the ledger records the *physical build*: which components
are planned vs done, which files were produced (path/bytes/sha), which binary
offsets were patched, and which verifications passed. It exists so a many-hour,
many-subagent, multi-megabyte build (e.g. injecting a complete Luau runtime,
~10 MB, thousands of files) stays coherent across dozens of context-window
resets. Concretely it lets the agent answer, cheaply and reliably:

  * "of the N planned components, how many are done — what is left?"
  * "did I already patch this offset in libX?" (no re-diffing needed);
  * "how many MB / files have I actually produced so far?";

...all from structured state that SURVIVES a summarization/reset intact — exactly
like the plan and investigation memory — because a compact, AGGREGATE-FIRST
markdown view is folded into the system prompt while the raw messages are
discarded.

Kept deliberately free of pywebview / shell / LLM imports so it can be tested in
isolation. agent.py is the only place that bridges it to the rest of the app
(set_context + a notify callback), the same way it wires up investigation.py.
"""
import json
import os
import re
import time
import uuid

# The buckets a build ledger is made of, in render order.
KINDS = (
    "components",       # planned build units, each with a status (the progress spine)
    "artifacts",        # concrete files produced, with size + sha
    "patches",          # binary offset patches, keyed by target@offset
    "verifications",    # checks run against the build, with pass/fail
)

COMPONENT_STATUSES = ("planned", "in_progress", "done", "blocked")
VERIFY_OUTCOMES = ("pass", "fail", "unknown")

_KIND_LABELS = {
    "components": "COMPONENTS",
    "artifacts": "ARTIFACTS PRODUCED",
    "patches": "BINARY PATCHES APPLIED",
    "verifications": "VERIFICATIONS",
}

# How many artifacts / patches to show in the compact prompt view (newest first).
# Components are the bounded worklist and are shown in full up to _COMPONENT_CAP;
# the full set of everything is always kept on disk / in to_dict().
_RECENT_PER_KIND = 8
_COMPONENT_CAP = 40

_active = None
_memory_dir = None
_notify_callback = None  # fn(ledger_dict_or_None) -> None, set by agent.py


def _now():
    return time.time()


def _norm(text):
    """Normalize text for duplicate detection: lowercase, drop punctuation,
    collapse whitespace. So 'libLuau.so' and 'libluau so' collapse together."""
    if not text:
        return ""
    t = re.sub(r"[^a-z0-9]+", " ", str(text).lower())
    return re.sub(r"\s+", " ", t).strip()


def _coerce_bytes(v):
    """Best-effort int for a byte count; anything unparseable becomes 0 so a bad
    value never crashes an aggregate."""
    try:
        n = int(v)
        return n if n >= 0 else 0
    except (TypeError, ValueError):
        return 0


def _fmt_bytes(n):
    """Human-readable byte size, e.g. 2.1 MB. Bounded, no dependency."""
    n = _coerce_bytes(n)
    if n < 1024:
        return f"{n} B"
    kb = n / 1024
    if kb < 1024:
        return f"{kb:.1f} KB"
    mb = kb / 1024
    if mb < 1024:
        return f"{mb:.1f} MB"
    return f"{mb / 1024:.1f} GB"


class BuildLedger:
    """The physical build manifest for the current task. Bucketed entries, each
    with a stable id + timestamps; add operations DEDUPE on a normalized key so
    the same component/artifact/patch re-recorded updates in place rather than
    piling up (critical after a context reset, when the model may re-record work
    it already did)."""

    def __init__(self, task="", task_id=""):
        self.task = task or ""
        self.task_id = task_id or ""
        self.created_at = _now()
        self.updated_at = self.created_at
        self.data = {kind: [] for kind in KINDS}

    def _touch(self):
        self.updated_at = _now()

    # --- generic add-or-update -------------------------------------------------
    def _upsert(self, kind, key, fields):
        """Insert a new entry, or update the existing one whose normalized `key`
        matches (merging non-empty fields). Returns the entry dict."""
        norm_key = _norm(key)
        bucket = self.data[kind]
        existing = None
        if norm_key:
            existing = next((e for e in bucket if e.get("_key") == norm_key), None)
        if existing is not None:
            for k, v in fields.items():
                if v not in (None, "", []):
                    existing[k] = v
            existing["updated_at"] = _now()
            self._touch()
            return existing
        entry = {"id": uuid.uuid4().hex[:8], "_key": norm_key,
                 "created_at": _now(), "updated_at": _now()}
        entry.update(fields)
        bucket.append(entry)
        self._touch()
        return entry

    # --- typed writers ---------------------------------------------------------
    def add_component(self, name, status="planned", owner="", bytes=0, note=""):
        status = status if status in COMPONENT_STATUSES else "planned"
        return self._upsert("components", name, {
            "name": name, "status": status, "owner": owner,
            "bytes": _coerce_bytes(bytes), "note": note})

    def set_component_status(self, name, status, note="", bytes=None, owner=""):
        """Update a component's status (creating it if unknown, so the model
        never has to 'add' before 'set')."""
        status = status if status in COMPONENT_STATUSES else "planned"
        fields = {"name": name, "status": status, "note": note, "owner": owner}
        if bytes is not None:
            fields["bytes"] = _coerce_bytes(bytes)
        return self._upsert("components", name, fields)

    def record_artifact(self, path, kind="file", bytes=0, sha="", note=""):
        return self._upsert("artifacts", path, {
            "path": path, "kind": kind, "bytes": _coerce_bytes(bytes),
            "sha": (sha or "")[:16], "note": note})

    def record_patch(self, target, offset, before="", after="", purpose=""):
        key = f"{target}@{offset}"
        return self._upsert("patches", key, {
            "target": target, "offset": str(offset), "before": before,
            "after": after, "purpose": purpose})

    def record_verification(self, name, outcome="unknown", details=""):
        outcome = outcome if outcome in VERIFY_OUTCOMES else "unknown"
        return self._upsert("verifications", name, {
            "name": name, "outcome": outcome, "details": details})

    # --- aggregates ------------------------------------------------------------
    def counts(self):
        return {kind: len(self.data[kind]) for kind in KINDS}

    def component_progress(self):
        comps = self.data["components"]
        by = {s: 0 for s in COMPONENT_STATUSES}
        for c in comps:
            by[c.get("status", "planned")] = by.get(c.get("status", "planned"), 0) + 1
        total = len(comps)
        pct = int(round(100 * by["done"] / total)) if total else 0
        return {"total": total, "by_status": by, "pct_done": pct}

    def total_artifact_bytes(self):
        return sum(_coerce_bytes(a.get("bytes")) for a in self.data["artifacts"])

    def verify_tally(self):
        by = {o: 0 for o in VERIFY_OUTCOMES}
        for v in self.data["verifications"]:
            by[v.get("outcome", "unknown")] = by.get(v.get("outcome", "unknown"), 0) + 1
        return by

    def open_items(self):
        """The worklist that remains: incomplete components + failing/unknown
        verifications. This is the 'what's left' signal the whole ledger exists
        to keep alive across resets."""
        items = []
        for c in self.data["components"]:
            st = c.get("status", "planned")
            if st in ("planned", "in_progress", "blocked"):
                items.append(f"[{st}] {c.get('name','')}"
                             + (f" — {c.get('note')}" if c.get("note") else ""))
        for v in self.data["verifications"]:
            if v.get("outcome") == "fail":
                items.append(f"[verify FAIL] {v.get('name','')}"
                             + (f" — {v.get('details')}" if v.get("details") else ""))
        return items

    def is_empty(self):
        return all(len(self.data[kind]) == 0 for kind in KINDS)

    # --- serialization ---------------------------------------------------------
    def to_dict(self):
        return {
            "task": self.task,
            "task_id": self.task_id,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "counts": self.counts(),
            "progress": self.component_progress(),
            "data": {kind: [self._public(e) for e in self.data[kind]] for kind in KINDS},
        }

    @staticmethod
    def _public(entry):
        return {k: v for k, v in entry.items() if k != "_key"}

    @classmethod
    def from_dict(cls, d):
        lg = cls(d.get("task", ""), task_id=d.get("task_id", ""))
        lg.created_at = d.get("created_at", lg.created_at)
        lg.updated_at = d.get("updated_at", lg.updated_at)
        data = d.get("data") or {}
        for kind in KINDS:
            entries = data.get(kind) or []
            restored = []
            for e in entries:
                if not isinstance(e, dict):
                    continue
                e = dict(e)
                if kind == "patches":
                    primary = f"{e.get('target','')}@{e.get('offset','')}"
                else:
                    primary = e.get("name") or e.get("path") or ""
                e["_key"] = _norm(primary)
                e.setdefault("id", uuid.uuid4().hex[:8])
                restored.append(e)
            lg.data[kind] = restored
        return lg

    def merge(self, other):
        """Fold another ledger (dict or BuildLedger) into this one via the same
        deduping upserts — used to merge a subagent's returned build delta into
        the authoritative ledger. Non-empty fields win; nothing is duplicated."""
        d = other.to_dict() if isinstance(other, BuildLedger) else (other or {})
        data = (d.get("data") or {})
        for c in data.get("components", []):
            self.add_component(c.get("name", ""), c.get("status", "planned"),
                               c.get("owner", ""), c.get("bytes", 0), c.get("note", ""))
        for a in data.get("artifacts", []):
            self.record_artifact(a.get("path", ""), a.get("kind", "file"),
                                 a.get("bytes", 0), a.get("sha", ""), a.get("note", ""))
        for p in data.get("patches", []):
            self.record_patch(p.get("target", ""), p.get("offset", ""),
                              p.get("before", ""), p.get("after", ""), p.get("purpose", ""))
        for v in data.get("verifications", []):
            self.record_verification(v.get("name", ""), v.get("outcome", "unknown"),
                                     v.get("details", ""))
        return self

    # --- prompt view -----------------------------------------------------------
    def to_markdown(self):
        """Compact, AGGREGATE-FIRST markdown for the system prompt. Always states
        completion as numbers and lists what remains; bounded so the permanent
        context stays small no matter how many artifacts the build produces."""
        if self.is_empty():
            return ""
        prog = self.component_progress()
        by = prog["by_status"]
        arts = self.data["artifacts"]
        vt = self.verify_tally()
        header = (
            f"Progress: {by['done']}/{prog['total']} components done "
            f"({prog['pct_done']}%)"
            + (f", {by['in_progress']} in progress" if by["in_progress"] else "")
            + (f", {by['blocked']} BLOCKED" if by["blocked"] else "")
            + f"  |  artifacts: {len(arts)} files, {_fmt_bytes(self.total_artifact_bytes())}"
            + f"  |  patches: {len(self.data['patches'])}"
            + f"  |  verify: {vt['pass']} pass / {vt['fail']} fail"
            + (f" / {vt['unknown']} unknown" if vt["unknown"] else "")
        )
        lines = [header]

        comps = self.data["components"]
        if comps:
            lines.append(f"{_KIND_LABELS['components']}:")
            shown = comps
            hidden = 0
            if len(comps) > _COMPONENT_CAP:
                # When the worklist is huge, incomplete-first so 'what's left'
                # is never truncated away.
                incomplete = [c for c in comps if c.get("status") != "done"]
                done = [c for c in comps if c.get("status") == "done"]
                shown = (incomplete + done)[:_COMPONENT_CAP]
                hidden = len(comps) - len(shown)
            for c in shown:
                sz = f" ({_fmt_bytes(c['bytes'])})" if c.get("bytes") else ""
                note = f" — {c.get('note')}" if c.get("note") else ""
                lines.append(f"  - [{c.get('status','planned')}] {c.get('name','')}{sz}{note}")
            if hidden:
                lines.append(f"  - (+{hidden} more, mostly done — see ledger.json)")

        openi = self.open_items()
        if openi:
            lines.append("OPEN / REMAINING:")
            for it in openi[:_COMPONENT_CAP]:
                lines.append(f"  - {it}")

        for kind in ("artifacts", "patches"):
            bucket = self.data[kind]
            if not bucket:
                continue
            shown = bucket[-_RECENT_PER_KIND:]
            hidden = len(bucket) - len(shown)
            header_l = f"{_KIND_LABELS[kind]} (recent)"
            if hidden > 0:
                header_l += f" (+{hidden} earlier)"
            lines.append(header_l + ":")
            for e in shown:
                lines.append("  - " + self._render_entry(kind, e))
        return "\n".join(lines)

    @staticmethod
    def _render_entry(kind, e):
        if kind == "artifacts":
            sz = _fmt_bytes(e.get("bytes")) if e.get("bytes") else "?"
            sha = f" sha:{e['sha']}" if e.get("sha") else ""
            note = f" — {e.get('note')}" if e.get("note") else ""
            return f"{e.get('path','')} ({e.get('kind','file')}, {sz}{sha}){note}"
        if kind == "patches":
            purp = f" — {e.get('purpose')}" if e.get("purpose") else ""
            ba = ""
            if e.get("before") or e.get("after"):
                ba = f" [{e.get('before','?')}→{e.get('after','?')}]"
            return f"{e.get('target','')}@{e.get('offset','')}{ba}{purp}"
        return str(e)


# --- module singleton + persistence (mirrors investigation.py) ---------------
def set_context(memory_dir, notify_callback=None):
    """Wire up where ledger mutations autosave to and how they notify the rest of
    the app. Call once per session start (agent.py's start_session)."""
    global _memory_dir, _notify_callback
    _memory_dir = memory_dir
    _notify_callback = notify_callback


def get_active():
    return _active


def set_active(lg, notify=True):
    global _active
    _active = lg
    if notify:
        notify_updated()


def clear_active(notify=True):
    global _active
    _active = None
    if notify:
        notify_updated()


def ensure_active(task=""):
    """Return the active ledger, creating an empty one if none exists. Recording
    tools call this so the model never has to 'create' one first."""
    global _active
    if _active is None:
        _active = BuildLedger(task)
        notify_updated()
    return _active


def notify_updated():
    """Persist the active ledger and push it to the registered callback. Called
    automatically after every mutating ledger_* tool call."""
    saved = _save(_active, _memory_dir)
    if _notify_callback:
        try:
            _notify_callback(_active.to_dict() if _active else None)
        except Exception:
            pass
    return saved


def _save(lg, memory_dir):
    if not memory_dir:
        return True
    path = os.path.join(memory_dir, "ledger.json")
    if lg is None:
        try:
            if os.path.isfile(path):
                os.remove(path)
        except OSError:
            pass
        return True
    try:
        os.makedirs(memory_dir, exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(lg.to_dict(), f, indent=2)
        try:
            os.replace(tmp, path)
        except OSError:
            with open(path, "w", encoding="utf-8") as f:
                json.dump(lg.to_dict(), f, indent=2)
        return True
    except OSError:
        return False


def load(memory_dir):
    """Load the last-persisted ledger for a project, or None."""
    path = os.path.join(memory_dir, "ledger.json")
    if not os.path.isfile(path):
        return None
    try:
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
    except (OSError, json.JSONDecodeError):
        return None
    return BuildLedger.from_dict(d)
