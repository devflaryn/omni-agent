"""Plan-and-execute state for the agent's default workflow.

A single active Plan is tracked per process — this app only ever runs one
session at a time, the same assumption docker_sandbox.py already makes for
the active container/workspace (module-level singleton, no session object
threaded through). tools/plan_tools.py mutates the active plan; agent.py
calls set_context() once per session so mutations autosave to the project's
memory dir and push a real-time update to the GUI + the live system prompt,
without either side needing that plumbing passed through tool arguments.

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

_active_plan = None
_memory_dir = None
_notify_callback = None  # fn(plan_dict_or_None) -> None, set by agent.py


class Plan:
    def __init__(self, task):
        self.task = task
        self.created_at = time.time()
        self.updated_at = self.created_at
        self.items = []  # [{id, content, status, notes, created_at, updated_at}, ...]

    def _touch(self):
        self.updated_at = time.time()

    def add_item(self, content, status="pending", after_id=None, notes=None):
        item = {
            "id": uuid.uuid4().hex[:8],
            "content": content,
            "status": status if status in VALID_STATUSES else "pending",
            "notes": notes or "",
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

    def update_item(self, item_id, status=None, content=None, notes=None):
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

    def is_complete(self):
        return bool(self.items) and all(it["status"] in DONE_STATUSES for it in self.items)

    def to_dict(self):
        done, total = self.progress()
        active = self.active_item()
        return {
            "task": self.task,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "items": self.items,
            "progress": {"done": done, "total": total},
            "active_item_id": active["id"] if active else None,
        }

    def to_markdown(self):
        icon = {"pending": "[ ]", "in_progress": "[~]", "completed": "[x]", "skipped": "[-]"}
        lines = [f"Task: {self.task}"]
        for it in self.items:
            line = f"- {icon.get(it['status'], '[ ]')} ({it['id']}) {it['content']}"
            if it["notes"]:
                line += f" — {it['notes']}"
            lines.append(line)
        done, total = self.progress()
        lines.append(f"Progress: {done}/{total} tasks complete.")
        return "\n".join(lines)

    @classmethod
    def from_dict(cls, data):
        plan = cls(data.get("task", ""))
        plan.created_at = data.get("created_at", plan.created_at)
        plan.updated_at = data.get("updated_at", plan.updated_at)
        plan.items = data.get("items", [])
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
