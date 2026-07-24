"""The Strategic Brief — a synthesized, decision-shaping strategic thesis.

Sibling of planning.py / investigation.py, same module-level-singleton shape
(this app runs one session at a time). planning owns "what I intend to do",
investigation owns "what I've established (evidence)"; strategy owns the SYNTHESIS
that shapes decisions: the goal, the protection diagnosis, the chosen attack and
why, the alternatives already rejected, the current top hypothesis, and the
kill-criteria that say when this strategy is wrong.

It is ORCHESTRATOR-SESSION STATE WITH EXACTLY ONE WRITER (the main loop). Subagents
never mutate it — that single-writer placement is what keeps the parallel
subagent stack unaffected (see subagents.py / agent.py delegation).

Kept free of any pywebview/Docker/LLM imports so it tests in isolation; agent.py
is the only bridge (AgentApi._on_strategy_update).
"""
import json
import os
import time

# The fields that make required_present() true (the diagnosis gate needs these).
REQUIRED = ("goal", "diagnosis", "strategy")

_active_brief = None
_memory_dir = None
_notify_callback = None  # fn(brief_dict_or_None) -> None, set by agent.py


def _clean_str(v):
    return str(v).strip() if v is not None else ""


def _clean_list(values):
    """A list of non-empty trimmed strings (used for rejected / kill_criteria)."""
    if not values:
        return []
    if isinstance(values, str):
        values = [values]
    out = []
    for v in values:
        s = str(v).strip()
        if s:
            out.append(s)
    return out


def _clean_diagnosis(values):
    """Normalize diagnosis into [{"claim": str, "evidence": str}, ...]. Accepts a
    bare string, a list of strings, or a list of {claim, evidence} dicts (mixed)."""
    if not values:
        return []
    if isinstance(values, (str, dict)):
        values = [values]
    out = []
    for v in values:
        if isinstance(v, dict):
            claim = _clean_str(v.get("claim") or v.get("protection") or v.get("name"))
            evidence = _clean_str(v.get("evidence") or v.get("where") or v.get("ref"))
        else:
            claim, evidence = _clean_str(v), ""
        if claim:
            out.append({"claim": claim, "evidence": evidence})
    return out


class StrategicBrief:
    def __init__(self, goal=""):
        self.goal = _clean_str(goal)
        self.diagnosis = []       # [{claim, evidence}, ...]
        self.strategy = ""
        self.rationale = ""
        self.rejected = []        # [str, ...] alternatives considered and ruled out
        self.hypothesis = ""      # current top hypothesis under test
        self.kill_criteria = []   # [str, ...] conditions that mean the strategy is wrong
        self.reviewed = False     # passed one strategy review since the last strategic edit
        self.created_at = time.time()
        self.updated_at = self.created_at

    def set(self, goal=None, diagnosis=None, strategy=None, rationale=None,
            rejected=None, hypothesis=None, kill_criteria=None):
        """Update any subset of fields. Any change to a STRATEGIC field (everything
        except hypothesis) clears `reviewed`, so the diagnosis gate forces a fresh
        strategy review before the next mutation. A hypothesis-only refinement does
        not (it's a tactical detail, not a change of plan)."""
        strategic_changed = any(x is not None for x in
                                (goal, diagnosis, strategy, rationale, rejected, kill_criteria))
        if goal is not None:
            self.goal = _clean_str(goal)
        if diagnosis is not None:
            self.diagnosis = _clean_diagnosis(diagnosis)
        if strategy is not None:
            self.strategy = _clean_str(strategy)
        if rationale is not None:
            self.rationale = _clean_str(rationale)
        if rejected is not None:
            self.rejected = _clean_list(rejected)
        if hypothesis is not None:
            self.hypothesis = _clean_str(hypothesis)
        if kill_criteria is not None:
            self.kill_criteria = _clean_list(kill_criteria)
        if strategic_changed:
            self.reviewed = False
        self.updated_at = time.time()

    def is_empty(self):
        return not (self.goal or self.diagnosis or self.strategy)

    def required_present(self):
        return all(getattr(self, f) for f in REQUIRED)

    def to_markdown(self):
        lines = []
        if self.goal:
            lines.append(f"Goal: {self.goal}")
        if self.diagnosis:
            lines.append("Diagnosis:")
            for d in self.diagnosis:
                ev = f" [{d['evidence']}]" if d.get("evidence") else ""
                lines.append(f"  - {d['claim']}{ev}")
        if self.strategy:
            r = f" — {self.rationale}" if self.rationale else ""
            lines.append(f"Strategy: {self.strategy}{r}")
        if self.rejected:
            lines.append("Rejected alternatives:")
            lines.extend(f"  - {a}" for a in self.rejected)
        if self.hypothesis:
            lines.append(f"Top hypothesis: {self.hypothesis}")
        if self.kill_criteria:
            lines.append("Kill-criteria (abandon the strategy if):")
            lines.extend(f"  - {k}" for k in self.kill_criteria)
        if not self.is_empty():
            lines.append(f"(strategy review: {'passed' if self.reviewed else 'PENDING'})")
        return "\n".join(lines)

    def to_dict(self):
        return {
            "goal": self.goal, "diagnosis": self.diagnosis, "strategy": self.strategy,
            "rationale": self.rationale, "rejected": self.rejected,
            "hypothesis": self.hypothesis, "kill_criteria": self.kill_criteria,
            "reviewed": self.reviewed,
            "created_at": self.created_at, "updated_at": self.updated_at,
        }

    @classmethod
    def from_dict(cls, data):
        b = cls(data.get("goal", ""))
        b.diagnosis = _clean_diagnosis(data.get("diagnosis"))
        b.strategy = _clean_str(data.get("strategy"))
        b.rationale = _clean_str(data.get("rationale"))
        b.rejected = _clean_list(data.get("rejected"))
        b.hypothesis = _clean_str(data.get("hypothesis"))
        b.kill_criteria = _clean_list(data.get("kill_criteria"))
        b.reviewed = bool(data.get("reviewed"))
        b.created_at = data.get("created_at", b.created_at)
        b.updated_at = data.get("updated_at", b.updated_at)
        return b


def set_context(memory_dir, notify_callback=None):
    global _memory_dir, _notify_callback
    _memory_dir = memory_dir
    _notify_callback = notify_callback


def set_active_brief(brief, notify=True):
    global _active_brief
    _active_brief = brief
    if notify:
        notify_updated()


def clear_active_brief(notify=True):
    global _active_brief
    _active_brief = None
    if notify:
        notify_updated()


def get_active():
    return _active_brief


def notify_updated():
    _save(_active_brief, _memory_dir)
    if _notify_callback:
        try:
            _notify_callback(_active_brief.to_dict() if _active_brief else None)
        except Exception:
            pass


def _save(brief, memory_dir):
    if not memory_dir:
        return
    path = os.path.join(memory_dir, "strategy_brief.json")
    if brief is None:
        try:
            if os.path.isfile(path):
                os.remove(path)
        except OSError:
            pass
        return
    try:
        os.makedirs(memory_dir, exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(brief.to_dict(), f, indent=2)
    except OSError:
        pass


def load_brief(memory_dir):
    path = os.path.join(memory_dir, "strategy_brief.json")
    if not os.path.isfile(path):
        return None
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return None
    return StrategicBrief.from_dict(data)
