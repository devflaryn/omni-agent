"""Adaptive, evidence-driven plan-and-execute state for the agent.

A single active Plan is tracked per process — this app only ever runs one
session at a time, the same assumption docker_sandbox.py already makes for
the active container/workspace (module-level singleton, no session object
threaded through). tools/plan_tools.py mutates the active plan; agent.py
calls set_context() once per session so mutations autosave to the project's
memory dir and push a real-time update to the GUI + the live system prompt,
without either side needing that plumbing passed through tool arguments.

The plan is deliberately LAYERED so it can adapt without being rewritten
wholesale (see the behavioral mandate in llm.get_full_system_prompt):

  * MISSION — the stable top layer: the task, its success criteria, and the
    hard constraints. Rarely changes once established.
  * PHASES — the high-level milestones of the mission. Also fairly stable;
    the agent advances through them and only re-cuts them on a real replan.
  * STEPS (items) — the small, bounded, *current-phase* actions. This is the
    volatile layer: each important step carries not just a description but an
    action / purpose / expected result / verification method / fallback, so
    "done" is objectively checkable. Steps churn as work proceeds.
  * NEXT ACTION — exactly one precise next thing to do, so there is always an
    unambiguous smallest-next-move.
  * OUTCOME — active / completed / partial / blocked / needs_different_approach,
    so the end state of the task is explicit rather than implied.

Confirmed FACTS vs assumptions/hypotheses live in investigation.py (the
evidence memory), not here — planning owns "what I intend to do and how I'll
verify it", investigation owns "what I've established". The two are folded
into the system prompt side by side.

Kept intentionally free of any pywebview/Docker/LLM imports so it can be
tested and reasoned about in isolation — agent.py is the only place that
bridges it to the rest of the app (see AgentApi._on_plan_update).
"""
import json
import os
import time
import uuid

VALID_STATUSES = ("pending", "in_progress", "completed", "skipped")
DONE_STATUSES = ("completed", "skipped")

# The end-state of the whole task. "active" = still in progress; the rest are the
# terminal judgements the agent must choose between when it stops (see the mandate
# in llm.get_full_system_prompt). Kept distinct from per-step status above.
OUTCOMES = ("active", "completed", "partial", "blocked", "needs_different_approach")

_active_plan = None
_memory_dir = None
_notify_callback = None  # fn(plan_dict_or_None) -> None, set by agent.py


def _new_id():
    return uuid.uuid4().hex[:8]


def _coerce_title(v):
    """One list element -> a title string. A plain string passes through; a dict
    (some models send phases/criteria as objects like {"name": ..., "steps": [...]}
    despite the 'array of strings' schema) is reduced to its name/title/content
    field instead of being str()'d into a raw '{...}' blob that renders in the UI."""
    if isinstance(v, dict):
        for key in ("name", "title", "content", "description", "step", "text"):
            val = v.get(key)
            if isinstance(val, str) and val.strip():
                return val.strip()
        return ""   # a dict with no usable label -> drop it, don't render raw JSON
    return str(v).strip()


def _clean_list(values):
    """A list of non-empty trimmed strings, or [] — used for success criteria,
    constraints, and phase titles coming from tool args. Robust to dict elements
    (coerced to their name/title) so a mis-shaped tool arg never renders as raw JSON."""
    if not values:
        return []
    if isinstance(values, str):
        values = [values]
    if isinstance(values, dict):   # a single object instead of a list
        values = [values]
    return [t for t in (_coerce_title(v) for v in values) if t]


class Plan:
    def __init__(self, task):
        self.task = task
        self.created_at = time.time()
        self.updated_at = self.created_at
        self.items = []            # current-phase steps (the volatile layer)
        self.phases = []           # [{id, title, status, note, created_at, updated_at}, ...]
        self.current_phase_id = None
        self.success_criteria = []  # what "done" objectively looks like
        self.constraints = []       # hard boundaries the plan must respect
        # Orientation snapshot captured before planning (inspect state first):
        self.current_state = []     # what's known about the situation right now
        self.unknowns = []          # open questions to resolve
        self.assumptions = []       # assumptions the plan rests on (unconfirmed)
        self.next_action = ""       # the single precise next move
        self.outcome = "active"     # one of OUTCOMES
        self.outcome_note = ""
        self.replans = []           # [{reason, at}, ...] — replan history (for context)

    def _touch(self):
        self.updated_at = time.time()

    # --- steps (items) ---------------------------------------------------------
    def add_item(self, content, status="pending", after_id=None, notes=None,
                 action=None, purpose=None, expected=None, verification=None,
                 fallback=None, phase_id=None, explanation=None, delegate=None):
        item = {
            "id": _new_id(),
            "content": content,
            "status": status if status in VALID_STATUSES else "pending",
            "notes": notes or "",
            # Optional delegation: the name of a subagent that should execute this
            # step in its own isolated context (the harness auto-dispatches it when
            # the step is marked in_progress; only its distilled report returns).
            "delegate": delegate or "",
            # Evidence-driven step fields (all optional; important steps fill them).
            "action": action or "",
            "purpose": purpose or "",
            "expected": expected or "",
            "verification": verification or "",
            "fallback": fallback or "",
            # A short, first-person narration for THIS step (the "subprocess") — shown
            # to the user as a chat line when the step is started (marked in_progress),
            # which is what opens a new action group. e.g. "Now I'll scan the workspace
            # for data." Falls back to `content` when unset (see agent.py).
            "explanation": explanation or "",
            "phase_id": phase_id or self.current_phase_id or "",
            "created_at": time.time(),
            "updated_at": time.time(),
        }
        if after_id:
            idx = next((i for i, it in enumerate(self.items) if it["id"] == after_id), None)
            if idx is not None:
                self.items.insert(idx + 1, item)
                self._touch()
                return item
        self.items.append(item)
        self._touch()
        return item

    def find(self, item_id):
        return next((it for it in self.items if it["id"] == item_id), None)

    def update_item(self, item_id, status=None, content=None, notes=None,
                    action=None, purpose=None, expected=None, verification=None,
                    fallback=None, explanation=None, delegate=None):
        item = self.find(item_id)
        if not item:
            return None
        if status is not None:
            if status not in VALID_STATUSES:
                return None
            item["status"] = status
        if content is not None:
            item["content"] = content
        if notes is not None:
            item["notes"] = notes
        # Optional evidence fields — only overwrite when a value is actually given,
        # so refining status doesn't wipe an existing verification/fallback.
        for key, val in (("action", action), ("purpose", purpose), ("expected", expected),
                         ("verification", verification), ("fallback", fallback),
                         ("explanation", explanation), ("delegate", delegate)):
            if val is not None:
                item[key] = val
        item["updated_at"] = time.time()
        self._touch()
        return item

    def reorder(self, ordered_ids):
        by_id = {it["id"]: it for it in self.items}
        if set(ordered_ids) != set(by_id.keys()) or len(ordered_ids) != len(self.items):
            return False
        self.items = [by_id[i] for i in ordered_ids]
        self._touch()
        return True

    def active_item(self):
        return next((it for it in self.items if it["status"] == "in_progress"), None)

    def progress(self):
        total = len(self.items)
        done = sum(1 for it in self.items if it["status"] in DONE_STATUSES)
        return done, total

    # --- mission (stable top layer) -------------------------------------------
    def set_mission(self, success_criteria=None, constraints=None):
        if success_criteria is not None:
            self.success_criteria = _clean_list(success_criteria)
        if constraints is not None:
            self.constraints = _clean_list(constraints)
        self._touch()

    def set_orientation(self, current_state=None, unknowns=None, assumptions=None):
        """Record the pre-planning inspection snapshot: what's known now, what's
        still unknown, and the assumptions the plan rests on."""
        if current_state is not None:
            self.current_state = _clean_list(current_state)
        if unknowns is not None:
            self.unknowns = _clean_list(unknowns)
        if assumptions is not None:
            self.assumptions = _clean_list(assumptions)
        self._touch()

    # --- phases (high-level milestones) ---------------------------------------
    def find_phase(self, phase_id):
        return next((p for p in self.phases if p["id"] == phase_id), None)

    def add_phase(self, title, status="pending", note=None):
        phase = {
            "id": _new_id(),
            "title": str(title).strip(),
            "status": status if status in VALID_STATUSES else "pending",
            "note": note or "",
            "created_at": time.time(),
            "updated_at": time.time(),
        }
        self.phases.append(phase)
        self._touch()
        return phase

    def set_phases(self, titles):
        """Replace the phase list from an ordered list of titles, marking the first
        one in progress and making it current. Used when a plan/replan lays out the
        mission's milestones fresh."""
        self.phases = []
        for t in _clean_list(titles):
            self.add_phase(t)
        if self.phases:
            self.phases[0]["status"] = "in_progress"
            self.current_phase_id = self.phases[0]["id"]
        else:
            self.current_phase_id = None
        self._touch()
        return self.phases

    def update_phase(self, phase_id, status=None, title=None, note=None):
        phase = self.find_phase(phase_id)
        if not phase:
            return None
        if status is not None:
            if status not in VALID_STATUSES:
                return None
            phase["status"] = status
        if title is not None:
            phase["title"] = title
        if note is not None:
            phase["note"] = note
        phase["updated_at"] = time.time()
        self._touch()
        return phase

    def current_phase(self):
        return self.find_phase(self.current_phase_id) if self.current_phase_id else None

    def advance_phase(self, phase_id=None, note=None):
        """Complete the current phase and move to the next. If phase_id is given,
        that phase becomes current; otherwise the next pending phase is picked.
        Returns the new current phase (or None if there are no more)."""
        cur = self.current_phase()
        if cur is not None:
            cur["status"] = "completed"
            if note:
                cur["note"] = note
            cur["updated_at"] = time.time()
        if phase_id:
            nxt = self.find_phase(phase_id)
        else:
            nxt = next((p for p in self.phases if p["status"] == "pending"), None)
        if nxt is not None:
            nxt["status"] = "in_progress"
            self.current_phase_id = nxt["id"]
        else:
            self.current_phase_id = None
        self._touch()
        return nxt

    # --- next action + outcome ------------------------------------------------
    def set_next_action(self, next_action):
        self.next_action = str(next_action or "").strip()
        self._touch()

    def set_outcome(self, outcome, note=None):
        if outcome not in OUTCOMES:
            return None
        self.outcome = outcome
        # The note describes THIS outcome, so a new outcome replaces any prior note
        # (a stale "waiting on keys" must not cling to a later "completed").
        self.outcome_note = str(note).strip() if note else ""
        self._touch()
        return self.outcome

    def record_replan(self, reason):
        """Note that a (scoped or full) replan happened, keeping a short history so
        repeated replans are visible in context. Does not itself change steps — the
        caller decides what to preserve vs. re-cut."""
        self.replans.append({"reason": str(reason or "").strip(), "at": time.time()})
        self.outcome = "active"  # replanning means we're working again
        self._touch()

    # --- status ----------------------------------------------------------------
    def is_complete(self):
        """Whether the task is finished. True when explicitly marked 'completed',
        or (for a still-active plan with steps) when every step is done. A plan
        marked partial / blocked / needs_different_approach is NOT complete, so the
        agent resumes it to finish, replan, or change approach."""
        if self.outcome == "completed":
            return True
        if self.outcome != "active":
            return False
        return bool(self.items) and all(it["status"] in DONE_STATUSES for it in self.items)

    # --- serialization ---------------------------------------------------------
    def to_dict(self):
        done, total = self.progress()
        active = self.active_item()
        return {
            "task": self.task,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "items": self.items,
            "phases": self.phases,
            "current_phase_id": self.current_phase_id,
            "success_criteria": self.success_criteria,
            "constraints": self.constraints,
            "current_state": self.current_state,
            "unknowns": self.unknowns,
            "assumptions": self.assumptions,
            "next_action": self.next_action,
            "outcome": self.outcome,
            "outcome_note": self.outcome_note,
            "replans": self.replans,
            "progress": {"done": done, "total": total},
            "active_item_id": active["id"] if active else None,
        }

    def to_markdown(self, full=False):
        """Render the plan. By default only the CURRENT phase's steps are shown in
        full (older phases collapse to a count) so the plan stays compact in the
        live prompt across a long run; pass full=True (e.g. from plan_view) to list
        every step."""
        icon = {"pending": "[ ]", "in_progress": "[~]", "completed": "[x]", "skipped": "[-]"}
        lines = [f"Task: {self.task}"]
        if self.outcome and self.outcome != "active":
            note = f" — {self.outcome_note}" if self.outcome_note else ""
            lines.append(f"Outcome: {self.outcome.upper().replace('_', ' ')}{note}")
        if self.success_criteria:
            lines.append("Success criteria:")
            lines.extend(f"  - {c}" for c in self.success_criteria)
        if self.constraints:
            lines.append("Constraints:")
            lines.extend(f"  - {c}" for c in self.constraints)
        if self.unknowns:
            lines.append("Unknowns:")
            lines.extend(f"  - {u}" for u in self.unknowns)
        if self.assumptions:
            lines.append("Assumptions (unconfirmed):")
            lines.extend(f"  - {a}" for a in self.assumptions)

        if self.phases:
            lines.append("Phases:")
            for p in self.phases:
                marker = "  <- current" if p["id"] == self.current_phase_id else ""
                note = f" — {p['note']}" if p.get("note") else ""
                lines.append(f"  {icon.get(p['status'], '[ ]')} ({p['id']}) {p['title']}{note}{marker}")

        cur = self.current_phase()
        steps_header = "Steps" + (f" (current phase: {cur['title']})" if cur else "") + ":"
        lines.append(steps_header)
        # On a long, multi-phase run the step list grows without bound. Since STEPS
        # are the *current-phase* layer (older phases' steps are settled history),
        # render only the current phase's steps — plus any still-in-progress step —
        # in full, and summarize the rest as a one-line count. This keeps the plan
        # section that rides in the prompt small even after hundreds of steps. When
        # there are no phases at all, everything is "current".
        if full or not cur:
            shown = list(self.items)
        else:
            shown = [it for it in self.items
                     if it.get("phase_id") == self.current_phase_id or it["status"] == "in_progress"]
        hidden = [it for it in self.items if it not in shown]
        if hidden:
            hdone = sum(1 for it in hidden if it["status"] in DONE_STATUSES)
            lines.append(f"  (+{len(hidden)} steps from earlier phases — {hdone} done; use plan_view for the full list)")
        for it in shown:
            line = f"- {icon.get(it['status'], '[ ]')} ({it['id']}) {it['content']}"
            if it.get("notes"):
                line += f" — {it['notes']}"
            lines.append(line)
            # The step's user-facing narration (shown when it's started), if set.
            if it.get("explanation"):
                lines.append(f"    » {it['explanation']}")
            # A delegated step is executed by a subagent in its own context.
            if it.get("delegate"):
                lines.append(f"    → delegate to subagent: {it['delegate']}")
            # Fold the evidence fields onto a compact indented line when present, so
            # an important step reads as action/why/expect/verify/fallback.
            detail = []
            for label, key in (("purpose", "purpose"), ("expect", "expected"),
                               ("verify", "verification"), ("fallback", "fallback")):
                if it.get(key):
                    detail.append(f"{label}: {it[key]}")
            if detail:
                lines.append("    " + " | ".join(detail))

        if self.next_action:
            lines.append(f"Next action: {self.next_action}")
        done, total = self.progress()
        lines.append(f"Progress: {done}/{total} steps complete.")
        if self.replans:
            lines.append(f"(replanned {len(self.replans)}x — last: {self.replans[-1]['reason']})")
        return "\n".join(lines)

    @classmethod
    def from_dict(cls, data):
        plan = cls(data.get("task", ""))
        plan.created_at = data.get("created_at", plan.created_at)
        plan.updated_at = data.get("updated_at", plan.updated_at)
        plan.items = data.get("items", []) or []
        # Backfill the evidence/phase fields on steps restored from an older
        # on-disk plan that predates them, so rendering/serialization stay uniform.
        for it in plan.items:
            for key in ("action", "purpose", "expected", "verification", "fallback",
                        "phase_id", "notes", "explanation", "delegate"):
                it.setdefault(key, "")
        plan.phases = data.get("phases", []) or []
        plan.current_phase_id = data.get("current_phase_id")
        plan.success_criteria = data.get("success_criteria", []) or []
        plan.constraints = data.get("constraints", []) or []
        plan.current_state = data.get("current_state", []) or []
        plan.unknowns = data.get("unknowns", []) or []
        plan.assumptions = data.get("assumptions", []) or []
        plan.next_action = data.get("next_action", "") or ""
        plan.outcome = data.get("outcome", "active") or "active"
        if plan.outcome not in OUTCOMES:
            plan.outcome = "active"
        plan.outcome_note = data.get("outcome_note", "") or ""
        plan.replans = data.get("replans", []) or []
        return plan


def set_context(memory_dir, notify_callback=None):
    """Wires up where plan mutations autosave to and how they notify the rest
    of the app. Call once per session start (agent.py's start_session)."""
    global _memory_dir, _notify_callback
    _memory_dir = memory_dir
    _notify_callback = notify_callback


def set_active_plan(plan, notify=True):
    global _active_plan
    _active_plan = plan
    if notify:
        notify_updated()


def clear_active_plan(notify=True):
    global _active_plan
    _active_plan = None
    if notify:
        notify_updated()


def get_active_plan():
    return _active_plan


def notify_updated():
    """Persists the active plan to disk and pushes it to the registered
    callback. Called automatically after every mutating plan_* tool call."""
    _save(_active_plan, _memory_dir)
    if _notify_callback:
        try:
            _notify_callback(_active_plan.to_dict() if _active_plan else None)
        except Exception:
            pass


def _save(plan, memory_dir):
    if not memory_dir:
        return
    path = os.path.join(memory_dir, "plan_current.json")
    if plan is None:
        try:
            if os.path.isfile(path):
                os.remove(path)
        except OSError:
            pass
        return
    try:
        os.makedirs(memory_dir, exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(plan.to_dict(), f, indent=2)
    except OSError:
        pass


def load_plan(memory_dir):
    """Loads the last-persisted plan for a project, or None if none exists."""
    path = os.path.join(memory_dir, "plan_current.json")
    if not os.path.isfile(path):
        return None
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return None
    return Plan.from_dict(data)
