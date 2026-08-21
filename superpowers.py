"""Superpowers Mode — the Design Brief store.

Sibling of planning.py / investigation.py / strategy.py, same
module-level-singleton shape (this app runs one session at a time). This one owns
the DESIGN BRIEF: the autonomous brainstorm output that turns a fuzzy goal into a
chosen approach BEFORE a plan is committed — clarified goal, the approach picked
(with rationale), the alternatives rejected, the assumptions the agent resolved on
its own (in place of asking the user questions), and the risks.

It is ORCHESTRATOR-SESSION STATE WITH EXACTLY ONE WRITER (the main loop). Subagents
never mutate it — that single-writer placement is what keeps the parallel subagent
stack unaffected (see subagents.py / agent.py delegation). Subagents receive at most
a one-line read slice (the chosen approach) in their context, never the store.

Kept free of any pywebview/shell/LLM imports so it tests in isolation; agent.py is
the only bridge (AgentApi._on_design_brief_update). Byte-identical-when-off is the
caller's responsibility: agent.py never renders this block unless superpowers is on
and a brief exists.
"""
import json
import os
import re
import time


def _clean_str(v):
    return str(v).strip() if v is not None else ""


def _clean_list(values):
    """A list of non-empty trimmed strings."""
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


class DesignBrief:
    def __init__(self, clarified_goal=""):
        self.clarified_goal = _clean_str(clarified_goal)
        self.chosen_approach = ""
        self.rationale = ""
        self.rejected = []        # [str, ...] alternatives considered and ruled out
        self.assumptions = []     # [str, ...] resolved open questions (NOT asked of the user)
        self.risks = []           # [str, ...] key risks / unknowns
        self.source = "subagent"  # "subagent" (dispatched brainstormer) | "inline"
        self.created_at = time.time()
        self.updated_at = self.created_at

    def set(self, clarified_goal=None, chosen_approach=None, rationale=None,
            rejected=None, assumptions=None, risks=None, source=None):
        if clarified_goal is not None:
            self.clarified_goal = _clean_str(clarified_goal)
        if chosen_approach is not None:
            self.chosen_approach = _clean_str(chosen_approach)
        if rationale is not None:
            self.rationale = _clean_str(rationale)
        if rejected is not None:
            self.rejected = _clean_list(rejected)
        if assumptions is not None:
            self.assumptions = _clean_list(assumptions)
        if risks is not None:
            self.risks = _clean_list(risks)
        if source is not None:
            self.source = _clean_str(source) or "subagent"
        self.updated_at = time.time()

    def is_empty(self):
        return not (self.clarified_goal or self.chosen_approach)

    def one_line(self):
        """The single-line slice handed to subagents (they never see the full store)."""
        return self.chosen_approach or self.clarified_goal or ""

    def to_markdown(self):
        lines = []
        if self.clarified_goal:
            lines.append(f"Goal: {self.clarified_goal}")
        if self.chosen_approach:
            r = f" — {self.rationale}" if self.rationale else ""
            lines.append(f"Chosen approach: {self.chosen_approach}{r}")
        if self.rejected:
            lines.append("Rejected alternatives:")
            lines.extend(f"  - {a}" for a in self.rejected)
        if self.assumptions:
            lines.append("Assumptions (resolved without asking — correct me if wrong):")
            lines.extend(f"  - {a}" for a in self.assumptions)
        if self.risks:
            lines.append("Key risks / unknowns:")
            lines.extend(f"  - {r}" for r in self.risks)
        return "\n".join(lines)

    def to_dict(self):
        return {
            "clarified_goal": self.clarified_goal,
            "chosen_approach": self.chosen_approach,
            "rationale": self.rationale,
            "rejected": self.rejected,
            "assumptions": self.assumptions,
            "risks": self.risks,
            "source": self.source,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    @classmethod
    def from_dict(cls, data):
        b = cls(data.get("clarified_goal", ""))
        b.chosen_approach = _clean_str(data.get("chosen_approach"))
        b.rationale = _clean_str(data.get("rationale"))
        b.rejected = _clean_list(data.get("rejected"))
        b.assumptions = _clean_list(data.get("assumptions"))
        b.risks = _clean_list(data.get("risks"))
        b.source = _clean_str(data.get("source")) or "subagent"
        b.created_at = data.get("created_at", b.created_at)
        b.updated_at = data.get("updated_at", b.updated_at)
        return b


# ---- best-effort parse of the brainstormer's free-text report -----------------

_SECTION_KEYS = {
    "clarified goal": "clarified_goal",
    "clarified_goal": "clarified_goal",
    "goal": "clarified_goal",
    "recommendation": "chosen_approach",
    "chosen approach": "chosen_approach",
    "recommended approach": "chosen_approach",
    "approach": "chosen_approach",
    "rationale": "rationale",
    "why": "rationale",
    "rejected": "rejected",
    "rejected alternatives": "rejected",
    "alternatives": "rejected",
    "approaches": "rejected",         # the candidate list (the chosen one is RECOMMENDATION)
    "candidate approaches": "rejected",
    "assumptions": "assumptions",
    "open questions": "assumptions",  # autonomy override turns these into assumptions
    "hidden constraints": "risks",
    "constraints": "risks",
    "risks": "risks",
    "key risks": "risks",
    "risks / unknowns": "risks",
    "key risks / unknowns": "risks",
    "unknowns": "risks",
}

_LIST_FIELDS = {"rejected", "assumptions", "risks"}


def parse_brief_report(report, source="subagent"):
    """Turn a brainstormer's free-text report into a DesignBrief. Tolerant: it reads
    'LABEL: value' headers and bulleted bodies in the persona's output shape, and on
    any shortfall it never fails — a report with no recognizable sections becomes a
    brief whose chosen_approach is the whole report, which is still usable downstream.
    Returns a DesignBrief (never None) unless the report is entirely empty."""
    text = (report or "").strip()
    if not text:
        return None

    fields = {"clarified_goal": "", "chosen_approach": "", "rationale": "",
              "rejected": [], "assumptions": [], "risks": []}
    current = None  # the field key the current line's content belongs to

    import re as _re

    def _norm_label(raw):
        # Lowercase, drop a trailing colon and any "(parenthetical)", collapse spaces —
        # so "OPEN QUESTIONS (most decision-changing first):" -> "open questions".
        s = raw.strip().lower().rstrip(":").strip()
        s = _re.sub(r"\(.*?\)", "", s).strip()
        return _re.sub(r"\s+", " ", s)

    matched_any = False
    for raw_line in text.splitlines():
        stripped = raw_line.strip()
        if not stripped:
            continue
        bullet = stripped[:1] in ("-", "*", "•")
        body = stripped[1:].strip() if bullet else stripped

        # A "LABEL: value" header — only a NON-bullet line whose label part is short
        # (so bulleted content or prose containing a colon isn't misread as a header).
        if not bullet and ":" in stripped:
            label, _, rest = stripped.partition(":")
            norm = _norm_label(label)   # strips "(parenthetical)" before the length gate
            if len(norm) <= 40 and 1 <= len(norm.split()) <= 5:
                key = _SECTION_KEYS.get(norm)
                if key is not None:
                    current = key
                    matched_any = True
                    if rest.strip():
                        _assign(fields, current, rest.strip())
                else:
                    # A header we don't map (e.g. REQUIREMENTS) is still a section
                    # BREAK — drop its body rather than bleeding it into the previous
                    # field.
                    current = None
                continue

        # Not a header — attach to the current section (if any is open).
        if current is None:
            continue
        _assign(fields, current, body if bullet else stripped)

    if not matched_any:
        # No recognizable structure: keep the whole report as the approach so the
        # brief is still useful rather than empty.
        fields["chosen_approach"] = text

    b = DesignBrief(fields["clarified_goal"])
    b.set(chosen_approach=fields["chosen_approach"], rationale=fields["rationale"],
          rejected=fields["rejected"], assumptions=fields["assumptions"],
          risks=fields["risks"], source=source)
    return b


def _assign(fields, key, value):
    value = (value or "").strip()
    if not value:
        return
    if key in _LIST_FIELDS:
        # Split an inline "a; b; c" only for list fields; keep prose intact for scalars.
        parts = [p.strip() for p in value.split(";")] if ";" in value else [value]
        for p in parts:
            if p:
                fields[key].append(p)
    else:
        fields[key] = (fields[key] + " " + value).strip() if fields[key] else value


# ---- architect plan proposals -------------------------------------------------
# The architect subagent inspects the workspace and answers with a JSON PLAN
# PROPOSAL shaped exactly like plan_create's arguments. Parsing it structurally
# (rather than having the orchestrator re-type a prose proposal into plan_create)
# is what preserves the parallel shape: the delegate / depends_on / scope fields an
# architect assigns survive verbatim instead of being flattened into a serial list
# by a re-transcription step.

_PLAN_SCALARS = ("task", "next_action")
_PLAN_LISTS = ("success_criteria", "constraints", "phases", "components", "risks")
_STEP_SCALARS = ("content", "delegate", "purpose", "expected", "verification",
                 "fallback", "explanation", "action", "notes", "key")
_STEP_LISTS = ("depends_on", "scope")


def _extract_json_object(text):
    """The first balanced {...} in the text, preferring a fenced ```json block.
    Brace-matched rather than regex'd so a nested object doesn't truncate it, and
    string-aware so a brace inside a quoted value doesn't end the scan early."""
    if not text:
        return None
    fence = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    candidates = [fence.group(1)] if fence else []
    start = text.find("{")
    while start != -1:
        depth, in_str, esc = 0, False, False
        for i in range(start, len(text)):
            ch = text[i]
            if in_str:
                if esc:
                    esc = False
                elif ch == "\\":
                    esc = True
                elif ch == '"':
                    in_str = False
                continue
            if ch == '"':
                in_str = True
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    candidates.append(text[start:i + 1])
                    break
        break
    for c in candidates:
        try:
            obj = json.loads(c)
        except (ValueError, TypeError):
            continue
        if isinstance(obj, dict):
            return obj
    return None


def parse_plan_proposal(report):
    """Turn an architect's report into normalized plan_create-shaped arguments, or
    None if it carries no usable plan. Never raises: an architect that answers with
    prose (or malformed JSON) simply yields None, and the caller falls back to
    letting the orchestrator plan for itself."""
    data = _extract_json_object(report or "")
    if not isinstance(data, dict):
        return None

    out = {}
    for k in _PLAN_SCALARS:
        v = _clean_str(data.get(k))
        if v:
            out[k] = v
    for k in _PLAN_LISTS:
        v = _clean_list(data.get(k))
        if v:
            out[k] = v

    steps = data.get("steps")
    if isinstance(steps, dict):        # a single step object instead of a list
        steps = [steps]
    clean_steps = []
    for raw in (steps or []):
        if isinstance(raw, str):
            if raw.strip():
                clean_steps.append({"content": raw.strip()})
            continue
        if not isinstance(raw, dict):
            continue
        step = {}
        for k in _STEP_SCALARS:
            v = _clean_str(raw.get(k))
            if v:
                step[k] = v
        for k in _STEP_LISTS:
            v = _clean_list(raw.get(k))
            if v:
                step[k] = v
        if not step.get("content"):
            # Tolerate an architect that names the field differently rather than
            # dropping an otherwise complete step.
            for alt in ("step", "title", "description", "action"):
                v = _clean_str(raw.get(alt))
                if v:
                    step["content"] = v
                    break
        if step.get("content"):
            clean_steps.append(step)
    if clean_steps:
        out["steps"] = clean_steps

    # A proposal with neither steps nor phases isn't a plan, whatever else it said.
    if not out.get("steps") and not out.get("phases"):
        return None
    return out


# ---- module-singleton store (mirrors strategy.py) -----------------------------

_active_brief = None
_memory_dir = None
_notify_callback = None  # fn(brief_dict_or_None) -> None, set by agent.py


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
    path = os.path.join(memory_dir, "design_brief.json")
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
    path = os.path.join(memory_dir, "design_brief.json")
    if not os.path.isfile(path):
        return None
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return None
    return DesignBrief.from_dict(data)


# ---- task classification (pure, testable; used by agent.py gates) -------------

# Clear inline-only intent — only unambiguous phrasings, so a code task that merely
# mentions the word "inline" (e.g. "inline this function") does not trip it.
_INLINE_ONLY_MARKERS = (
    "inline only", "inline-only", "only inline", "inline exec", "inline execution",
    "no subagent", "no subagents", "without subagent", "without subagents",
    "don't use subagent", "dont use subagent", "do not use subagent",
    "don't delegate", "dont delegate", "do not delegate", "no delegation",
    "no delegate", "do it yourself", "do it inline", "run inline", "keep it inline",
)


def detect_inline_only(text):
    """True when the user has CLEARLY asked for inline (non-subagent) execution."""
    t = (text or "").lower()
    return any(m in t for m in _INLINE_ONLY_MARKERS)


# Trivial-task shape: short, single-edit requests that don't warrant a full
# brainstorm + subagent wave. Fails SAFE — when unsure, returns False (run the
# pipeline). Kept deliberately conservative.
_TRIVIAL_VERBS = (
    "rename", "typo", "spelling", "misspell", "comment", "uncomment",
    "bump", "format", "reformat", "lint", "indent", "whitespace",
    "capitalize", "lowercase", "uppercase",
)
_NONTRIVIAL_SIGNALS = (
    " and ", " then ", "\n", ";", " refactor", "architecture", "design",
    "feature", "implement", "build", "integrate", "migrate", "debug",
    "investigate", "why", "across", "multiple", "several", "pipeline",
    "system", "add support", "rewrite", "redesign", "test", "tests",
    "security", "performance", "optimi",
)
_TRIVIAL_MAX_WORDS = 12


def is_trivial_task(text):
    """True only for short, unambiguous single-edit requests. Anything with a
    multi-step / design / debugging signal, or longer than a short sentence, is
    NOT trivial (returns False → the full superpowers pipeline runs)."""
    t = (text or "").strip().lower()
    if not t:
        return False
    if len(t.split()) > _TRIVIAL_MAX_WORDS:
        return False
    if any(sig in t for sig in _NONTRIVIAL_SIGNALS):
        return False
    return any(v in t for v in _TRIVIAL_VERBS)
