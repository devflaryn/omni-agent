"""Structured investigation memory for the agent's evidence-based workflow.

A single active Investigation is tracked per process — the same singleton
pattern planning.py uses, and for the same reason: this app runs one session at
a time (see docker_sandbox.py's active-container assumption). It records what
the agent has actually ESTABLISHED, kept separate from the raw conversation, so
that:

  * confirmed findings, hypotheses, failed attempts, decisions, modified files,
    open questions, test results and next steps each live in their own bucket
    instead of being buried in a flat transcript;
  * every finding and hypothesis carries the EVIDENCE that supports it (a file,
    symbol, search result, command/build/test output, or runtime log), so a
    claim can always be traced back to something objective;
  * duplicates are collapsed (add-or-update on a normalized key) instead of the
    same fact piling up every time it's re-observed;
  * a compact markdown view can be folded into the system prompt — exactly like
    the live plan — so the structured state SURVIVES a context-window
    summarization/reset intact even though the raw messages are discarded; and
  * the loop can detect when the model is about to repeat an approach already
    recorded as failed, and demand new evidence before letting it retry.

Kept deliberately free of pywebview / Docker / LLM imports so it can be tested
and reasoned about in isolation. agent.py is the only place that bridges it to
the rest of the app (set_context + a notify callback), the same way it wires up
planning.py.
"""
import json
import os
import re
import time
import uuid

# The buckets an investigation is made of, in the order they render. Each maps to
# a list of entry dicts. Keeping them as an ordered tuple (not just dict keys)
# makes the render/serialize order deterministic and easy to reason about.
KINDS = (
    "findings",         # confirmed facts, each with evidence
    "assumptions",      # explicit working premises, later validated/invalidated
    "hypotheses",       # unproven ideas, each with confidence + evidence + status
    "failed_attempts",  # approaches that did NOT work, with why + evidence
    "decisions",        # choices made, with rationale
    "modified_files",   # files created/edited/deleted, with what changed
    "open_questions",   # unresolved questions
    "test_results",     # validation/test/build outcomes
    "next_steps",       # the immediate next actions
)

CONFIDENCE_LEVELS = ("low", "medium", "high")
HYPOTHESIS_STATUSES = ("open", "confirmed", "refuted")
ASSUMPTION_STATUSES = ("active", "validated", "invalidated")
TEST_OUTCOMES = ("pass", "fail", "unknown")

# Human labels for the markdown view.
_KIND_LABELS = {
    "findings": "CONFIRMED FINDINGS (evidence-backed)",
    "assumptions": "WORKING ASSUMPTIONS (not facts)",
    "hypotheses": "HYPOTHESES (unconfirmed)",
    "failed_attempts": "FAILED ATTEMPTS (do not repeat without new evidence)",
    "decisions": "DECISIONS",
    "modified_files": "MODIFIED FILES",
    "open_questions": "OPEN QUESTIONS",
    "test_results": "TEST / VALIDATION RESULTS",
    "next_steps": "NEXT STEPS",
}

# How many entries per bucket to show in the compact prompt view (newest first).
# The full set is always kept on disk / in to_dict(); this only bounds what gets
# folded into the system prompt so the permanent context stays small.
_PROMPT_ENTRIES_PER_KIND = 12

_active = None
_memory_dir = None
_notify_callback = None  # fn(investigation_dict_or_None) -> None, set by agent.py


def _now():
    return time.time()


def _norm(text):
    """Normalize text for duplicate detection and failed-approach matching:
    lowercase, drop punctuation, collapse whitespace. So 'Patch the return value.'
    and 'patch the return  value' collapse to the same key."""
    if not text:
        return ""
    t = re.sub(r"[^a-z0-9]+", " ", str(text).lower())
    return re.sub(r"\s+", " ", t).strip()


class Investigation:
    """The structured record for the current task. Bucketed entries, each with a
    stable id + timestamps; add operations DEDUPE on a normalized key so the same
    fact re-observed updates in place rather than piling up."""

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
                # Only overwrite with a non-empty value, so a re-observation that
                # omits (say) evidence doesn't wipe evidence we already had.
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

    def _find(self, kind, entry_id):
        return next((e for e in self.data[kind] if e.get("id") == entry_id), None)

    # --- typed writers ---------------------------------------------------------
    def add_finding(self, text, evidence):
        return self._upsert("findings", text, {"text": text, "evidence": evidence or ""})

    def add_assumption(self, text, rationale="", evidence="", status="active"):
        """Record a premise the plan currently relies on.

        Assumptions are deliberately separate from hypotheses: an assumption is a
        declared working premise used to make progress, while a hypothesis is a
        candidate explanation being investigated. Neither is a confirmed fact.
        """
        status = status if status in ASSUMPTION_STATUSES else "active"
        return self._upsert("assumptions", text, {
            "text": text, "rationale": rationale or "", "evidence": evidence or "",
            "status": status,
        })

    def set_assumption_status(self, entry_id, status, evidence=""):
        item = self._find("assumptions", entry_id)
        if item is None or status not in ASSUMPTION_STATUSES:
            return None
        # A premise may remain active without proof, but declaring it validated or
        # invalidated is an evidence-bearing conclusion.
        if status != "active" and not str(evidence or "").strip():
            return None
        item["status"] = status
        if evidence:
            item["evidence"] = evidence
        item["updated_at"] = _now()
        self._touch()
        if status == "validated":
            self.add_finding(item["text"], item.get("evidence", ""))
        return item

    def add_hypothesis(self, text, evidence="", confidence="medium", status="open"):
        confidence = confidence if confidence in CONFIDENCE_LEVELS else "medium"
        status = status if status in HYPOTHESIS_STATUSES else "open"
        return self._upsert("hypotheses", text, {
            "text": text, "evidence": evidence or "",
            "confidence": confidence, "status": status})

    def set_hypothesis_status(self, entry_id, status, evidence=""):
        item = self._find("hypotheses", entry_id)
        if item is None or status not in HYPOTHESIS_STATUSES:
            return None
        if status in ("confirmed", "refuted") and not str(evidence or "").strip():
            return None
        item["status"] = status
        if evidence:
            item["evidence"] = evidence
        item["updated_at"] = _now()
        self._touch()
        # A hypothesis proven true is promoted to a confirmed finding so the two
        # views stay coherent (the finding carries the same evidence).
        if status == "confirmed":
            self.add_finding(item["text"], item.get("evidence", ""))
        return item

    def add_failed_attempt(self, approach, reason="", evidence=""):
        return self._upsert("failed_attempts", approach, {
            "approach": approach, "reason": reason or "", "evidence": evidence or ""})

    def add_decision(self, decision, rationale=""):
        return self._upsert("decisions", decision, {"text": decision, "rationale": rationale or ""})

    def add_modified_file(self, path, change=""):
        return self._upsert("modified_files", path, {"path": path, "change": change or ""})

    def add_open_question(self, question):
        return self._upsert("open_questions", question, {"text": question})

    def resolve_open_question(self, entry_id, answer="", evidence=""):
        """Remove a resolved question and, when an answer is given, promote it to a
        confirmed finding so the resolution isn't lost."""
        item = self._find("open_questions", entry_id)
        if item is None:
            return None
        if answer and not str(evidence or "").strip():
            return None
        self.data["open_questions"] = [e for e in self.data["open_questions"] if e.get("id") != entry_id]
        if answer:
            self.add_finding(answer, evidence)
        self._touch()
        return item

    def add_test_result(self, name, outcome="unknown", details=""):
        outcome = outcome if outcome in TEST_OUTCOMES else "unknown"
        return self._upsert("test_results", name, {
            "name": name, "outcome": outcome, "details": details or ""})

    def set_next_steps(self, steps):
        """Replace the next-steps list wholesale (it's a rolling 'what now', not an
        append-only log)."""
        steps = [s for s in (steps or []) if str(s).strip()]
        self.data["next_steps"] = [
            {"id": uuid.uuid4().hex[:8], "_key": _norm(s), "text": str(s),
             "created_at": _now(), "updated_at": _now()}
            for s in steps
        ]
        self._touch()
        return self.data["next_steps"]

    # --- failed-approach guard -------------------------------------------------
    def find_failed_attempt(self, approach):
        """Return a recorded failed attempt matching `approach`, or None.

        Matches when the normalized approach text of a recorded failure and the
        candidate overlap substantially (one contains the other). Used by the loop
        to stop the model re-running an approach it already knows failed unless it
        brings new evidence. Deliberately conservative (requires a reasonably long
        key) so it never fires on trivial/near-empty strings."""
        cand = _norm(approach)
        if len(cand) < 8:
            return None
        for e in self.data["failed_attempts"]:
            key = e.get("_key") or ""
            if not key or len(key) < 8:
                continue
            if key in cand or cand in key:
                return e
        return None

    # --- counts / emptiness ----------------------------------------------------
    def counts(self):
        return {kind: len(self.data[kind]) for kind in KINDS}

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
            "data": {kind: [self._public(e) for e in self.data[kind]] for kind in KINDS},
        }

    @staticmethod
    def _public(entry):
        """A copy of an entry without the internal `_key` (dedup) field."""
        return {k: v for k, v in entry.items() if k != "_key"}

    @classmethod
    def from_dict(cls, d):
        inv = cls(d.get("task", ""), task_id=d.get("task_id", ""))
        inv.created_at = d.get("created_at", inv.created_at)
        inv.updated_at = d.get("updated_at", inv.updated_at)
        data = d.get("data") or {}
        for kind in KINDS:
            entries = data.get(kind) or []
            restored = []
            for e in entries:
                if not isinstance(e, dict):
                    continue
                e = dict(e)
                # Recompute the dedup key from whatever the entry's primary text is,
                # so a hand-edited or older on-disk file still dedupes correctly.
                primary = e.get("text") or e.get("approach") or e.get("path") or e.get("name") or ""
                e["_key"] = _norm(primary)
                e.setdefault("id", uuid.uuid4().hex[:8])
                restored.append(e)
            inv.data[kind] = restored
        return inv

    def to_markdown(self, per_kind=_PROMPT_ENTRIES_PER_KIND):
        """Compact markdown view for the system prompt. Only non-empty buckets are
        shown; each shows the newest `per_kind` entries."""
        if self.is_empty():
            return ""
        lines = []
        for kind in KINDS:
            bucket = self.data[kind]
            if not bucket:
                continue
            shown = bucket[-per_kind:]
            hidden = len(bucket) - len(shown)
            header = _KIND_LABELS[kind]
            if hidden > 0:
                header += f" (+{hidden} older)"
            lines.append(f"{header}:")
            for e in shown:
                lines.append("  - " + self._render_entry(kind, e))
        return "\n".join(lines)

    @staticmethod
    def _render_entry(kind, e):
        if kind == "findings":
            ev = e.get("evidence", "")
            return f"{e.get('text','')}" + (f"  [evidence: {ev}]" if ev else "  [evidence: NONE]")
        if kind == "assumptions":
            evidence = e.get("evidence", "")
            rationale = e.get("rationale", "")
            text = f"({e.get('status', 'active')}) {e.get('text', '')}"
            if rationale:
                text += f"  [why relied on: {rationale}]"
            if evidence:
                text += f"  [evidence: {evidence}]"
            return text
        if kind == "hypotheses":
            ev = e.get("evidence", "")
            bits = f"({e.get('confidence','medium')} confidence, {e.get('status','open')}) {e.get('text','')}"
            return bits + (f"  [evidence: {ev}]" if ev else "  [evidence: NONE]")
        if kind == "failed_attempts":
            reason = e.get("reason", "")
            return f"{e.get('approach','')}" + (f" — {reason}" if reason else "")
        if kind == "decisions":
            rat = e.get("rationale", "")
            return f"{e.get('text','')}" + (f" — because {rat}" if rat else "")
        if kind == "modified_files":
            ch = e.get("change", "")
            return f"{e.get('path','')}" + (f" — {ch}" if ch else "")
        if kind == "test_results":
            det = e.get("details", "")
            return f"[{e.get('outcome','unknown').upper()}] {e.get('name','')}" + (f" — {det}" if det else "")
        # open_questions, next_steps
        return e.get("text", "")


# --- module singleton + persistence (mirrors planning.py) --------------------
def set_context(memory_dir, notify_callback=None):
    """Wire up where investigation mutations autosave to and how they notify the
    rest of the app. Call once per session start (agent.py's start_session)."""
    global _memory_dir, _notify_callback
    _memory_dir = memory_dir
    _notify_callback = notify_callback


def get_active():
    return _active


def set_active(inv, notify=True):
    global _active
    _active = inv
    if notify:
        notify_updated()


def clear_active(notify=True):
    global _active
    _active = None
    if notify:
        notify_updated()


def ensure_active(task=""):
    """Return the active investigation, creating an empty one if none exists.
    Recording tools call this so the model never has to 'create' one first."""
    global _active
    if _active is None:
        _active = Investigation(task)
        notify_updated()
    return _active


def notify_updated():
    """Persist the active investigation and push it to the registered callback.
    Called automatically after every mutating investigation_* tool call."""
    saved = _save(_active, _memory_dir)
    if _notify_callback:
        try:
            _notify_callback(_active.to_dict() if _active else None)
        except Exception:
            pass
    return saved


def _save(inv, memory_dir):
    if not memory_dir:
        return True
    path = os.path.join(memory_dir, "investigation.json")
    if inv is None:
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
            json.dump(inv.to_dict(), f, indent=2)
        try:
            os.replace(tmp, path)
        except OSError:
            # Some restricted environments permit file writes but deny rename/
            # replace. Preserve functionality with a direct-write fallback; the
            # normal path remains atomic everywhere that supports it.
            with open(path, "w", encoding="utf-8") as f:
                json.dump(inv.to_dict(), f, indent=2)
        return True
    except OSError:
        return False


def load(memory_dir):
    """Load the last-persisted investigation for a project, or None."""
    path = os.path.join(memory_dir, "investigation.json")
    if not os.path.isfile(path):
        return None
    try:
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
    except (OSError, json.JSONDecodeError):
        return None
    return Investigation.from_dict(d)
