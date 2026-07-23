# Parallel-by-Default Subagent Execution + Concurrency Dock — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the agent fire all independent plan steps of the active phase as one wide parallel wave (instead of one at a time), remove the key-count concurrency cap, and add an always-visible bottom-right timeline dock that proves the parallelism.

**Architecture:** Three coordinated changes. (1) A plan step gains an optional `depends_on` list; the active phase becomes a parallel batch — the harness pulls forward every ready delegated step and dispatches them in one wave. (2) `subagents._pool_size` drops the `keys-1` cap for a high configurable max, and `run_subagents_parallel` emits `wave_started`/`wave_done` events. (3) A `#concurrency-dock` in the frontend renders overlapping time-driven bars and a "wall vs summed → N× faster" line, driven off those events.

**Tech Stack:** Python 3 (stdlib `concurrent.futures`, `threading`, `uuid`), vanilla JS frontend (no framework), SSE event transport, Tailwind + inline CSS with `--term-*` theme vars. Backend tests: `pytest` (the `/tests` dir is gitignored — commit source only). Frontend pure-function tests: `node`.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-23-parallel-by-default-execution-design.md` — the source of truth.
- **`/tests` is gitignored.** Write and run backend tests there, but **commit source files only** (never `git add tests/`).
- **Writes always serialize** on `subagents._WORKSPACE_LOCK`; never dispatch two write subagents concurrently.
- **Phases stay sequential** — only steps *within* the active phase parallelize. Never run two waves at once.
- **Class is `AgentApi`** (not `Agent`); the active plan is `planning.get_active_plan()`; per-step delegation is gated by `session["delegation_enabled"]`.
- **Preserve back-compat:** `session["parallel_execution_enabled"]` (default `True`) must, when `False`, restore exact one-step-at-a-time behavior.
- **`depends_on` default is `[]`** (independent → eligible immediately). Foreign/self ids are ignored, never block.
- Keep `run_subagent`'s leak-safe key acquire/release inside try/finally and its unchanged string-return contract.
- New tool params must be threaded through `plan_tools.py`; new tool modules (none here) would need `tools/__init__.py` — not applicable.
- Run `graphify update .` after code changes land (AST-only, no API cost) — final step of the plan.

---

### Task 1: `depends_on` field + ready-set helper in `planning.py`

**Files:**
- Modify: `planning.py` — `Plan.add_item` (~line 110), `Plan.update_item` (~line 150), `Plan.to_dict` (~line 318), `Plan.to_markdown` (~line 395 delegate render); add new method `ready_delegatable_steps`.
- Test: `tests/test_planning_depends_on.py`

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `Plan.add_item(..., depends_on=None)` — stores `item["depends_on"]: list[str]` (defaults `[]`).
  - `Plan.update_item(..., depends_on=None)` — overwrites `depends_on` only when a value is given.
  - `Plan.ready_delegatable_steps(dispatched_ids: set[str]) -> list[dict]` — returns steps in the current phase that have a non-empty `delegate`, are `pending`/`in_progress`, whose id is not in `dispatched_ids`, and whose same-phase `depends_on` ids are all `completed`/`skipped`. Foreign/self dep ids ignored. Order preserved as in `self.items`.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_planning_depends_on.py
import planning


def _plan_with_phase():
    p = planning.Plan("mission")
    p.set_phases(["research"])
    return p


def test_add_item_defaults_depends_on_empty():
    p = _plan_with_phase()
    it = p.add_item("do a", delegate="researcher")
    assert it["depends_on"] == []


def test_add_and_update_depends_on():
    p = _plan_with_phase()
    a = p.add_item("a", delegate="researcher")
    b = p.add_item("b", delegate="researcher", depends_on=[a["id"]])
    assert b["depends_on"] == [a["id"]]
    p.update_item(b["id"], depends_on=[])
    assert p.find(b["id"])["depends_on"] == []
    # update without depends_on must NOT wipe it
    p.update_item(b["id"], depends_on=[a["id"]])
    p.update_item(b["id"], notes="x")
    assert p.find(b["id"])["depends_on"] == [a["id"]]


def test_ready_delegatable_steps_independent_all_ready():
    p = _plan_with_phase()
    a = p.add_item("a", delegate="researcher")
    b = p.add_item("b", delegate="researcher")
    ready = p.ready_delegatable_steps(set())
    assert {s["id"] for s in ready} == {a["id"], b["id"]}


def test_ready_delegatable_steps_respects_depends_on_and_dispatched():
    p = _plan_with_phase()
    a = p.add_item("a", delegate="researcher")
    b = p.add_item("b", delegate="researcher", depends_on=[a["id"]])
    # b blocked until a completes
    assert {s["id"] for s in p.ready_delegatable_steps(set())} == {a["id"]}
    # already-dispatched a is excluded; b still blocked (a not completed)
    assert p.ready_delegatable_steps({a["id"]}) == []
    p.update_item(a["id"], status="completed")
    assert {s["id"] for s in p.ready_delegatable_steps({a["id"]})} == {b["id"]}


def test_ready_ignores_non_delegated_and_foreign_deps():
    p = _plan_with_phase()
    p.add_item("plain step")  # no delegate -> excluded
    d = p.add_item("d", delegate="researcher", depends_on=["nonexistent", None])
    ready = p.ready_delegatable_steps(set())
    assert {s["id"] for s in ready} == {d["id"]}  # foreign dep ignored, not blocking
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "/Users/berat/Desktop/Omni Apps/omni-agent" && python -m pytest tests/test_planning_depends_on.py -q`
Expected: FAIL — `add_item()` has no `depends_on` kwarg / `ready_delegatable_steps` not defined.

- [ ] **Step 3: Implement in `planning.py`**

In `add_item`'s signature add `depends_on=None`, and in the `item = {...}` dict add (next to `"delegate"`):

```python
            # Steps this one waits for (same-phase ids). Empty => independent =>
            # eligible immediately, so the harness can dispatch it in parallel.
            "depends_on": _clean_id_list(depends_on),
```

In `update_item`'s signature add `depends_on=None`, and in the `for key, val in (...)` tuple append `("depends_on", _clean_id_list(depends_on) if depends_on is not None else None)`. (Because the loop only writes when `val is not None`, passing `None` leaves it untouched; a real list is normalized.)

Add a small normalizer near the other module helpers (after `_clean_list`):

```python
def _clean_id_list(v):
    """Normalize a depends_on value to a list of non-empty string ids."""
    if not v:
        return []
    if isinstance(v, str):
        v = [v]
    return [str(x).strip() for x in v if x and str(x).strip()]
```

Add the ready-set method to `Plan` (e.g. right after `active_item`):

```python
    def ready_delegatable_steps(self, dispatched_ids):
        """Steps in the current phase that are ready to hand to a subagent right
        now: they carry a `delegate`, aren't done or already dispatched, and every
        same-phase id in their `depends_on` is completed/skipped. Foreign/self dep
        ids are ignored (they never block). Returns them in plan order."""
        dispatched_ids = dispatched_ids or set()
        phase_ids = {it["id"] for it in self.items
                     if it.get("phase_id") == self.current_phase_id}
        done = {it["id"] for it in self.items if it["status"] in DONE_STATUSES}
        ready = []
        for it in self.items:
            if it.get("phase_id") != self.current_phase_id:
                continue
            if not (it.get("delegate") or "").strip():
                continue
            if it["status"] in DONE_STATUSES or it["id"] in dispatched_ids:
                continue
            deps = [d for d in it.get("depends_on", []) if d in phase_ids and d != it["id"]]
            if all(d in done for d in deps):
                ready.append(it)
        return ready
```

In `to_dict`, `items` is already returned wholesale (each item now carries `depends_on`) — no change needed. In `to_markdown`, after the delegate render line (`→ delegate to subagent: ...`), add:

```python
            if it.get("depends_on"):
                lines.append(f"    ↳ waits for: {', '.join(it['depends_on'])}")
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd "/Users/berat/Desktop/Omni Apps/omni-agent" && python -m pytest tests/test_planning_depends_on.py -q`
Expected: PASS (5 passed).

- [ ] **Step 5: Commit (source only — NOT tests)**

```bash
cd "/Users/berat/Desktop/Omni Apps/omni-agent"
git add planning.py
git commit -m "feat(planning): depends_on field + ready_delegatable_steps for parallel dispatch

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VH7Ti3qAaAAjRkvdYijyyJ"
```

---

### Task 2: Expose `depends_on` through `plan_tools.py`

**Files:**
- Modify: `tools/plan_tools.py` — `_add_step` (~line 27), `plan_add_task` (params_schema ~line 99 + signature ~line 104 + body ~line 109), `plan_update_task` (params_schema ~line 137 + signature ~line 142 + body ~line 148).
- Test: `tests/test_plan_tools_depends_on.py`

**Interfaces:**
- Consumes: `Plan.add_item(..., depends_on=...)`, `Plan.update_item(..., depends_on=...)` from Task 1.
- Produces: `plan_add_task(..., depends_on=None)` and `plan_update_task(..., depends_on=None)` tool signatures; `_add_step` forwards `step.get("depends_on")`.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_plan_tools_depends_on.py
import planning
import tools.plan_tools as pt


def _fresh():
    p = planning.Plan("m")
    p.set_phases(["research"])
    planning.set_active_plan(p) if hasattr(planning, "set_active_plan") else setattr(planning, "_active_plan", p)
    return p


def test_plan_add_task_sets_depends_on():
    p = _fresh()
    a = p.add_item("a", delegate="researcher")
    pt.plan_add_task("b", delegate="researcher", depends_on=[a["id"]])
    b = [it for it in p.items if it["content"] == "b"][0]
    assert b["depends_on"] == [a["id"]]


def test_plan_update_task_sets_depends_on():
    p = _fresh()
    a = p.add_item("a", delegate="researcher")
    b = p.add_item("b", delegate="researcher")
    pt.plan_update_task(b["id"], depends_on=[a["id"]])
    assert p.find(b["id"])["depends_on"] == [a["id"]]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "/Users/berat/Desktop/Omni Apps/omni-agent" && python -m pytest tests/test_plan_tools_depends_on.py -q`
Expected: FAIL — `plan_add_task()` got an unexpected keyword argument `depends_on`.

- [ ] **Step 3: Implement in `tools/plan_tools.py`**

In `_add_step`, add `depends_on=step.get("depends_on"),` to the `plan.add_item(...)` dict-branch call.

In `plan_add_task`: add to `params_schema` (after the `delegate` entry):
```python
        "depends_on": "array of strings (optional — ids of OTHER steps in the SAME phase that must finish before this one. Omit for independent steps: same-phase steps run IN PARALLEL by default, so only set this when this step truly needs another's result.)",
```
Change the signature to `def plan_add_task(content, purpose=None, expected=None, verification=None, fallback=None, after_id=None, explanation=None, delegate=None, depends_on=None):` and add `depends_on=depends_on` to the `plan.add_item(...)` call.

In `plan_update_task`: add to `params_schema`:
```python
        "depends_on": "array of strings (optional — replace this step's same-phase dependencies; pass [] to clear them).",
```
Change the signature to add `depends_on=None` and add `depends_on=depends_on` to the `plan.update_item(...)` call.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd "/Users/berat/Desktop/Omni Apps/omni-agent" && python -m pytest tests/test_plan_tools_depends_on.py -q`
Expected: PASS (2 passed).

- [ ] **Step 5: Commit (source only)**

```bash
cd "/Users/berat/Desktop/Omni Apps/omni-agent"
git add tools/plan_tools.py
git commit -m "feat(plan-tools): expose depends_on on plan_add_task/plan_update_task

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VH7Ti3qAaAAjRkvdYijyyJ"
```

---

### Task 3: Lift concurrency cap + emit wave events in `subagents.py`

**Files:**
- Modify: `subagents.py` — `_pool_size` (~line 44) + a new module constant; `run_subagents_parallel` (~line 464).
- Test: `tests/test_subagents_waves.py`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `SUBAGENT_MAX_CONCURRENCY` module constant (default 16, env `OMNI_SUBAGENT_MAX_CONCURRENCY`).
  - `_pool_size(n_specs) -> int` = `max(1, min(SUBAGENT_MAX_CONCURRENCY, n_specs))` (no longer key-count-bound).
  - `run_subagents_parallel(...)` emits, when `on_event` is given: `{"type": "wave_started", "wave_id", "size", "workers"}` before the pool and `{"type": "wave_done", "wave_id"}` in a `finally`.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_subagents_waves.py
import os
import subagents
from subagents import AgentDef


def _read_agent(name="researcher"):
    return AgentDef(name=name, system_prompt="you research", mode="read",
                    allowed_tools=set(), max_steps=1)


def test_pool_size_not_key_bound(monkeypatch):
    monkeypatch.setattr(subagents.llm, "active_key_pool", lambda: ["k1", "k2"])
    # 2 keys but 5 specs -> old code capped at keys-1=1; new code allows up to 5
    assert subagents._pool_size(5) == 5
    assert subagents._pool_size(50) == subagents.SUBAGENT_MAX_CONCURRENCY


def test_wave_events_bracket_run(monkeypatch):
    monkeypatch.setattr(subagents.llm, "active_key_pool", lambda: ["k1", "k2", "k3"])

    def fake_run_subagent(agent_def, task, context="", run_dir=None, on_event=None):
        return {"agent": agent_def.name, "ok": True, "report": "r", "steps": 1, "tokens": 5}

    monkeypatch.setattr(subagents, "run_subagent", fake_run_subagent)
    events = []
    specs = [(_read_agent("a"), "t1"), (_read_agent("b"), "t2")]
    subagents.run_subagents_parallel(specs, on_event=events.append)
    types = [e["type"] for e in events]
    assert types[0] == "wave_started"
    assert types[-1] == "wave_done"
    assert events[0]["size"] == 2 and events[0]["workers"] == 2
    assert events[0]["wave_id"] == events[-1]["wave_id"]


def test_wave_done_emitted_even_on_crash(monkeypatch):
    monkeypatch.setattr(subagents.llm, "active_key_pool", lambda: ["k1"])

    def boom(*a, **k):
        raise RuntimeError("kaboom")

    monkeypatch.setattr(subagents, "run_subagent", boom)
    events = []
    subagents.run_subagents_parallel([(_read_agent(), "t")], on_event=events.append)
    assert events[0]["type"] == "wave_started"
    assert events[-1]["type"] == "wave_done"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "/Users/berat/Desktop/Omni Apps/omni-agent" && python -m pytest tests/test_subagents_waves.py -q`
Expected: FAIL — `SUBAGENT_MAX_CONCURRENCY` undefined / no `wave_started` event.

- [ ] **Step 3: Implement in `subagents.py`**

Near the top constants, add:

```python
# Max subagents run at once in a single wave. Cost is not a constraint, so this is
# deliberately generous and DECOUPLED from the key count (keys are shared across
# concurrent subagents by KeyAllocator). Env-overridable for tuning against provider
# rate limits.
try:
    SUBAGENT_MAX_CONCURRENCY = max(1, int(os.environ.get("OMNI_SUBAGENT_MAX_CONCURRENCY", "16")))
except ValueError:
    SUBAGENT_MAX_CONCURRENCY = 16
```

(Ensure `import os` exists at the top of the file; add it if missing.)

Replace `_pool_size` body:

```python
def _pool_size(n_specs):
    """Concurrency for a read wave: up to SUBAGENT_MAX_CONCURRENCY, never more than
    the number of specs, floored at 1. Decoupled from the key count — keys are
    shared across concurrent subagents (cost is irrelevant), so parallelism is
    bounded by the work and the safety cap, not by how many keys exist."""
    return max(1, min(SUBAGENT_MAX_CONCURRENCY, n_specs))
```

In `run_subagents_parallel`, wrap the body with wave events. After computing `norm`/`read_idx`/`write_idx` and before the `if read_idx:` block, add:

```python
    import uuid
    wave_id = uuid.uuid4().hex[:8]
    workers = pool_size if pool_size is not None else _pool_size(max(1, len(read_idx)))
    _emit_event(on_event, {"type": "wave_started", "wave_id": wave_id,
                           "size": len(norm), "workers": max(1, min(workers, len(read_idx) or 1))})
    try:
```

Indent the existing read-wave + write-loop body under that `try:`, and before `return results` add:

```python
    finally:
        _emit_event(on_event, {"type": "wave_done", "wave_id": wave_id})
    return results
```

(The `return results` stays after the `finally`. Confirm indentation: the `finally` closes the `try` that wraps both the read fan-out and the write loop.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd "/Users/berat/Desktop/Omni Apps/omni-agent" && python -m pytest tests/test_subagents_waves.py -q`
Expected: PASS (3 passed).

- [ ] **Step 5: Commit (source only)**

```bash
cd "/Users/berat/Desktop/Omni Apps/omni-agent"
git add subagents.py
git commit -m "feat(subagents): decouple wave concurrency from key count + emit wave_started/wave_done

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VH7Ti3qAaAAjRkvdYijyyJ"
```

---

### Task 4: Parallel-by-default dispatch in `agent.py`

**Files:**
- Modify: `agent.py` — `_maybe_dispatch_delegated_steps` (~line 1353); session defaults (~line 2138, add `parallel_execution_enabled`).
- Test: `tests/test_parallel_dispatch.py`

**Interfaces:**
- Consumes: `Plan.ready_delegatable_steps` (Task 1); `subagents.run_subagents_parallel` wave events (Task 3); existing `self._run_delegated_read_wave`, `self._compose_delegate_task`, `self._compose_delegate_context`, `self._fold_delegate_result`, `self._emit`.
- Produces: `session["parallel_execution_enabled"]` (default `True`); rewritten `_maybe_dispatch_delegated_steps` that batches all ready read steps of the active phase into one wave and loops until no step is ready.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_parallel_dispatch.py
import types
import planning
import agent as agent_mod


class _StubReg:
    def __init__(self, agents):
        self._a = agents

    def get_agent(self, name):
        return self._a.get(name)


def _mk_agent(is_write=False):
    return types.SimpleNamespace(name="researcher", mode=("write" if is_write else "read"),
                                 is_write=is_write)


def _make_api(plan, dispatched_calls, parallel=True):
    api = agent_mod.AgentApi.__new__(agent_mod.AgentApi)
    api.session = {"delegation_enabled": True, "parallel_execution_enabled": parallel,
                   "dispatched_steps": set(), "messages": []}
    api._emit = lambda ev: None
    api._compose_delegate_task = lambda step: step["content"]
    api._compose_delegate_context = lambda plan: "ctx"
    api._fold_delegate_result = lambda plan, step, name, ad, result: \
        plan.update_item(step["id"], status="completed")
    # capture the batch handed to the read-wave

    def fake_wave(plan, reads):
        dispatched_calls.append([s["id"] for (s, _n, _ad) in reads])
        for step, name, ad in reads:
            api._fold_delegate_result(plan, step, name, ad, {"ok": True, "report": "r"})
    api._run_delegated_read_wave = fake_wave
    return api


def test_batches_all_independent_reads_into_one_wave(monkeypatch):
    p = planning.Plan("m"); p.set_phases(["research"])
    a = p.add_item("a", delegate="researcher", status="in_progress")
    b = p.add_item("b", delegate="researcher")
    c = p.add_item("c", delegate="researcher")
    planning._active_plan = p
    calls = []
    api = _make_api(p, calls)
    monkeypatch.setattr(agent_mod.plugins, "get_registry",
                        lambda: _StubReg({"researcher": _mk_agent()}))
    api._maybe_dispatch_delegated_steps()
    # ONE wave containing all three independent steps
    assert calls == [[a["id"], b["id"], c["id"]]]


def test_dependency_withheld_until_dep_done(monkeypatch):
    p = planning.Plan("m"); p.set_phases(["research"])
    a = p.add_item("a", delegate="researcher", status="in_progress")
    b = p.add_item("b", delegate="researcher", depends_on=[a["id"]])
    planning._active_plan = p
    calls = []
    api = _make_api(p, calls)
    monkeypatch.setattr(agent_mod.plugins, "get_registry",
                        lambda: _StubReg({"researcher": _mk_agent()}))
    api._maybe_dispatch_delegated_steps()
    # a dispatched first (wave 1), then b becomes ready and dispatches (wave 2)
    assert calls == [[a["id"]], [b["id"]]]


def test_disabled_flag_dispatches_single_step(monkeypatch):
    p = planning.Plan("m"); p.set_phases(["research"])
    a = p.add_item("a", delegate="researcher", status="in_progress")
    b = p.add_item("b", delegate="researcher")
    planning._active_plan = p
    calls = []
    api = _make_api(p, calls, parallel=False)
    monkeypatch.setattr(agent_mod.plugins, "get_registry",
                        lambda: _StubReg({"researcher": _mk_agent()}))
    api._maybe_dispatch_delegated_steps()
    # only the just-started step, one at a time
    assert calls == [[a["id"]]]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "/Users/berat/Desktop/Omni Apps/omni-agent" && python -m pytest tests/test_parallel_dispatch.py -q`
Expected: FAIL — current `_maybe_dispatch_delegated_steps` dispatches only steps already `in_progress`, so `test_batches_all_independent_reads_into_one_wave` sees `[[a_id]]`, not the batch.

- [ ] **Step 3: Implement in `agent.py`**

Add the session default (near line 2138, beside `"dispatched_steps": set(),`):

```python
            # Parallel-by-default execution: dispatch ALL ready independent delegated
            # steps of the active phase as one wide wave (vs one at a time). Kill
            # switch — False restores strict one-step dispatch.
            "parallel_execution_enabled": ADAPTIVE_PLANNING_DEFAULT,
```

Replace the body of `_maybe_dispatch_delegated_steps` (keep the docstring, update it) with:

```python
    def _maybe_dispatch_delegated_steps(self):
        """Dispatch delegated plan steps of the ACTIVE phase. Parallel-by-default:
        every ready independent READ step (deps satisfied) fans out in ONE wide wave
        via run_subagents_parallel; WRITE steps run serially behind the workspace
        lock. Loops until no step is ready (a completed dependency can unblock more).
        With session['parallel_execution_enabled'] False, falls back to dispatching
        only steps already marked in_progress, one at a time (legacy behavior).
        Only distilled reports fold back into the main context, never transcripts."""
        s = self.session
        if not s.get("delegation_enabled", True):
            return
        plan = s.get("plan") or planning.get_active_plan()
        if plan is None:
            return
        dispatched = s.setdefault("dispatched_steps", set())
        reg = plugins.get_registry()
        parallel = s.get("parallel_execution_enabled", True)

        def _resolve(step):
            """Return the AgentDef for a step's delegate, or None (and surface the
            unknown-agent nudge, marking it dispatched so we don't retry it)."""
            name = (step.get("delegate") or "").strip()
            ad = reg.get_agent(name)
            if ad is None:
                dispatched.add(step["id"])
                names = ", ".join(a.name for a in plugins.list_agents()) or "(none configured)"
                self._emit({"type": "system",
                            "content": f"Unknown delegate agent '{name}' — the agent will handle the step itself."})
                s["messages"].append({"role": "user", "content": (
                    f"[SYSTEM] Plan step ({step['id']}) is tagged delegate='{name}', but no such subagent "
                    f"exists (available: {names}). Do this step yourself, or fix/clear the delegate name.")})
                return None
            return ad

        # Bounded loop: each pass dispatches the currently-ready batch; a completed
        # dependency can make more steps ready on the next pass. Capped so a
        # pathological dependency cycle degrades to "nothing ready" instead of hanging.
        for _ in range(len(plan.items) + 1):
            if parallel:
                candidates = plan.ready_delegatable_steps(dispatched)
            else:
                # Legacy: only steps the model has explicitly started, untouched.
                candidates = [it for it in plan.items
                              if it.get("status") == "in_progress" and (it.get("delegate") or "").strip()
                              and it["id"] not in dispatched]
            if not candidates:
                return

            reads, writes = [], []
            for step in candidates:
                ad = _resolve(step)
                if ad is None:
                    continue
                dispatched.add(step["id"])
                if parallel and step.get("status") != "in_progress":
                    # Harness-initiated start of a pulled-forward step: mark it live so
                    # the plan/UI reflect it, exactly like a model-started step.
                    plan.update_item(step["id"], status="in_progress")
                (writes if ad.is_write else reads).append((step, ad.name, ad))
            planning.notify_updated()

            if reads:
                try:
                    self._run_delegated_read_wave(plan, reads)
                except Exception as e:
                    for step, _name, _ad in reads:
                        s["messages"].append({"role": "user", "content": (
                            f"[SYSTEM] Delegation of step ({step['id']}) failed to start ({e}). "
                            "Handle this step yourself.")})

            for step, name, ad in writes:
                try:
                    task = self._compose_delegate_task(step)
                    context = self._compose_delegate_context(plan)
                    self._emit({"type": "delegate_running", "agent": name, "mode": ad.mode,
                                "content": f"Delegating step ({step['id']}) to subagent '{name}' ({ad.mode})…"})
                    result = subagents.run_subagent(ad, task, context=context,
                                                    run_dir=getattr(self, "_delegate_run_dir", None))
                    self._fold_delegate_result(plan, step, name, ad, result)
                except Exception as e:
                    s["messages"].append({"role": "user", "content": (
                        f"[SYSTEM] Delegation of step ({step['id']}) failed to start ({e}). "
                        "Handle this step yourself.")})

            if not parallel:
                # Legacy path handled the started step(s) once; don't loop-pull more.
                return
```

Note: `_run_delegated_read_wave` already accepts a `reads` list of `(step, name, ad)` — it recomputes specs internally — so the widened batch flows through unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd "/Users/berat/Desktop/Omni Apps/omni-agent" && python -m pytest tests/test_parallel_dispatch.py -q`
Expected: PASS (3 passed).

- [ ] **Step 5: Run the full backend suite (guard against regressions)**

Run: `cd "/Users/berat/Desktop/Omni Apps/omni-agent" && python -m pytest -q`
Expected: Same pass count as the pre-existing baseline plus the new tests; **no NEW failures** (the ~19 pre-existing baseline failures noted in project memory are unrelated). If a delegation/dispatch test newly fails, reconcile it with the new batching semantics before committing.

- [ ] **Step 6: Commit (source only)**

```bash
cd "/Users/berat/Desktop/Omni Apps/omni-agent"
git add agent.py
git commit -m "feat(agent): parallel-by-default dispatch of ready delegated steps in the active phase

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VH7Ti3qAaAAjRkvdYijyyJ"
```

---

### Task 5: Teach the planner the parallel semantics (system prompt)

**Files:**
- Modify: `llm.py` — the plan mandate block (~lines 227-232).

**Interfaces:**
- Consumes: nothing (prose only).
- Produces: no code symbols; changes the guidance the model plans against.

- [ ] **Step 1: Edit the mandate**

In `llm.py`, replace the sentence beginning `Work top-to-bottom, ONE step at a time:` (line ~230) so it no longer implies strict sequencing, and add the parallel rule. Change:

```
  verification / fallback (fields on plan_add_task/plan_update_task). Work top-to-bottom, ONE step at a time: mark it
  in_progress when you start, completed ONLY once done AND its verification passed, skipped (with a note) if moot.
```

to:

```
  verification / fallback (fields on plan_add_task/plan_update_task). Mark a step in_progress when you start it,
  completed ONLY once done AND its verification passed, skipped (with a note) if moot.
- PARALLELISM: steps in the SAME phase run CONCURRENTLY by default — starting one delegated step fans out every
  independent delegated step in that phase at once. So GROUP independent research/probes into one phase to run them in
  parallel, and when a step truly needs another's result, either set its `depends_on` to that step's id (same phase) or
  put it in a LATER phase. Writes to the shared workspace are always serialized for you.
```

- [ ] **Step 2: Sanity-check the prompt still assembles**

Run: `cd "/Users/berat/Desktop/Omni Apps/omni-agent" && python -c "import llm; s = llm.get_static_system_prompt(native_tools=False); assert 'PARALLELISM' in s and 'depends_on' in s; print('ok, prompt len', len(s))"`
Expected: `ok, prompt len <number>` (no exception, both markers present).

- [ ] **Step 3: Commit**

```bash
cd "/Users/berat/Desktop/Omni Apps/omni-agent"
git add llm.py
git commit -m "docs(prompt): teach planner same-phase steps run in parallel; depends_on to sequence

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VH7Ti3qAaAAjRkvdYijyyJ"
```

---

### Task 6: Concurrency timeline dock — CSS

**Files:**
- Modify: `frontend/index.html` — replace the `/* --- subagent telemetry panel --- */` style block (~lines 315-339) with the dock styles.

**Interfaces:**
- Consumes: nothing.
- Produces: CSS classes used by Task 7: `#concurrency-dock`, `.cdock-collapsed`, `.cdock-header`, `.cdock-body`, `.cbar`, `.cbar-track`, `.cbar-fill`, `.cbar-fill.ok`, `.cbar-fill.failed`, `.cbar-label`, `.cdock-summary`.

- [ ] **Step 1: Replace the style block**

Delete the entire `/* --- subagent telemetry panel ... */` block (from `.subagent-panel {` through `.subagent-row.failed .sa-stats { ... }`) and insert:

```css
    /* --- concurrency dock: live parallel-wave timeline --- */
    #concurrency-dock {
      position: fixed; right: 16px; bottom: 16px; z-index: 40;
      width: 380px; max-width: calc(100vw - 32px);
      max-height: 40vh; display: flex; flex-direction: column;
      background: rgb(var(--term-panel)); color: rgb(var(--term-text));
      border: 1px solid rgb(var(--term-line)); border-radius: 10px;
      box-shadow: 0 8px 28px rgba(0,0,0,0.32);
      font-size: 11.5px; overflow: hidden;
    }
    #concurrency-dock.cdock-collapsed { width: auto; }
    #concurrency-dock.cdock-collapsed .cdock-body,
    #concurrency-dock.cdock-collapsed .cdock-summary { display: none; }
    .cdock-header {
      display: flex; align-items: center; gap: 8px; cursor: pointer;
      padding: 7px 11px; font-weight: 600;
      border-bottom: 1px solid rgb(var(--term-line));
    }
    #concurrency-dock.cdock-collapsed .cdock-header { border-bottom: none; }
    .cdock-header .cdock-count { color: rgb(var(--term-cyan)); font-variant-numeric: tabular-nums; }
    .cdock-body { padding: 8px 10px; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; }
    .cbar { display: flex; flex-direction: column; gap: 2px; }
    .cbar-label {
      display: flex; gap: 8px; color: rgb(var(--term-muted));
      font-variant-numeric: tabular-nums; white-space: nowrap;
    }
    .cbar-label .cbar-name { color: rgb(var(--term-text)); font-weight: 600; flex-shrink: 0; }
    .cbar-label .cbar-task { overflow: hidden; text-overflow: ellipsis; min-width: 0; flex: 1; }
    .cbar-label .cbar-key { flex-shrink: 0; }
    .cbar-track { position: relative; height: 8px; border-radius: 4px; background: rgb(var(--term-bg)); overflow: hidden; }
    .cbar-fill {
      position: absolute; top: 0; height: 100%; border-radius: 4px;
      background: rgb(var(--term-cyan)); transition: left .12s linear, width .12s linear;
    }
    .cbar-fill.ok { background: rgb(var(--term-green)); }
    .cbar-fill.failed { background: rgb(var(--term-red)); }
    .cdock-summary {
      padding: 7px 11px; border-top: 1px solid rgb(var(--term-line));
      color: rgb(var(--term-muted)); font-variant-numeric: tabular-nums;
    }
    .cdock-summary .cdock-speedup { color: rgb(var(--term-green)); font-weight: 600; }
```

- [ ] **Step 2: Verify the page still loads (no dangling CSS)**

Run: `cd "/Users/berat/Desktop/Omni Apps/omni-agent" && grep -c "subagent-panel\|subagent-row" frontend/index.html`
Expected: `0` (old panel CSS fully removed).

- [ ] **Step 3: Commit**

```bash
cd "/Users/berat/Desktop/Omni Apps/omni-agent"
git add frontend/index.html
git commit -m "feat(frontend): concurrency dock CSS (replaces inline subagent panel styles)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VH7Ti3qAaAAjRkvdYijyyJ"
```

---

### Task 7: Concurrency timeline dock — rendering + events

**Files:**
- Create: `frontend/wave_stats.js` — the pure `computeWaveStats` (no DOM, so node can import it and `app.js` can share it via a `<script>` tag).
- Modify: `frontend/index.html` — add `<script defer src="wave_stats.js"></script>` immediately before `<script src="app.js"></script>` (~line 709).
- Modify: `frontend/app.js` — remove the inline subagent panel block (~lines 514-579, `_subagentRows` through `subagentDone`); update `resetActivityState` (~line 224); add the dock module (calling `window.computeWaveStats`); update the `onEvent` switch (~lines 1136-1142).
- Test: `tests/frontend/test_wave_stats.mjs` (node; pure-function unit).

**Interfaces:**
- Consumes: backend events `wave_started`, `wave_done`, `subagent_started`, `subagent_progress`, `subagent_done` (Task 3 + existing).
- Produces: `computeWaveStats(bars) -> {n, peak, wallS, summedS, speedup}` (pure, in `wave_stats.js`, attached to `window`/`globalThis`); dock DOM keyed `#concurrency-dock`.

Why a separate file: `app.js` is loaded as a plain `<script>` and touches `document` at top level (line 6), so it throws on `import` under node. `computeWaveStats` lives in its own DOM-free file so it is unit-testable in node and still available to `app.js` as `window.computeWaveStats`.

- [ ] **Step 1: Write the failing pure-function test**

```javascript
// tests/frontend/test_wave_stats.mjs
import assert from 'node:assert';

// wave_stats.js is DOM-free and assigns to globalThis, so it imports cleanly.
await import('../../frontend/wave_stats.js');

const computeWaveStats = globalThis.computeWaveStats;
assert.equal(typeof computeWaveStats, 'function', 'computeWaveStats must be exported');

// Two bars fully overlapping 0..4s and 0..2s: wall=4, summed=6, peak=2, speedup=1.5
const bars = [
  { startOffsetMs: 0, endOffsetMs: 4000 },
  { startOffsetMs: 0, endOffsetMs: 2000 },
];
const s = computeWaveStats(bars);
assert.equal(s.n, 2);
assert.equal(s.peak, 2);
assert.equal(s.wallS, 4);
assert.equal(s.summedS, 6);
assert.equal(s.speedup, 1.5);

// Sequential bars 0..2s then 2..4s: wall=4, summed=4, peak=1, speedup=1.0
const seq = computeWaveStats([
  { startOffsetMs: 0, endOffsetMs: 2000 },
  { startOffsetMs: 2000, endOffsetMs: 4000 },
]);
assert.equal(seq.peak, 1);
assert.equal(seq.speedup, 1.0);
console.log('wave-stats ok');
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd "/Users/berat/Desktop/Omni Apps/omni-agent" && node tests/frontend/test_wave_stats.mjs`
Expected: FAIL — `Cannot find module .../frontend/wave_stats.js` (file not created yet).

- [ ] **Step 3a: Create `frontend/wave_stats.js`**

```javascript
// Pure wave statistics for the concurrency dock — DOM-free so it is unit-testable
// under node and shared with app.js via a plain <script> tag (window.computeWaveStats).
function computeWaveStats(bars) {
  const arr = bars.map(b => ({ s: b.startOffsetMs, e: b.endOffsetMs == null ? b.startOffsetMs : b.endOffsetMs }));
  const wallMs = arr.length ? Math.max(...arr.map(b => b.e)) - Math.min(...arr.map(b => b.s)) : 0;
  const summedMs = arr.reduce((t, b) => t + Math.max(0, b.e - b.s), 0);
  // peak concurrency via a sweep of +1/-1 edges
  const edges = [];
  arr.forEach(b => { edges.push([b.s, 1]); edges.push([b.e, -1]); });
  edges.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let cur = 0, peak = 0;
  edges.forEach(([, d]) => { cur += d; if (cur > peak) peak = cur; });
  const wallS = Math.round(wallMs / 100) / 10;
  const summedS = Math.round(summedMs / 100) / 10;
  const speedup = wallMs > 0 ? Math.round((summedMs / wallMs) * 10) / 10 : 1.0;
  return { n: arr.length, peak, wallS, summedS, speedup };
}
if (typeof globalThis !== 'undefined') globalThis.computeWaveStats = computeWaveStats;
if (typeof window !== 'undefined') window.computeWaveStats = computeWaveStats;
```

- [ ] **Step 3b: Wire it into `index.html`**

Immediately before `<script src="app.js"></script>` (~line 709) add:

```html
  <script defer src="wave_stats.js"></script>
```

- [ ] **Step 3c: Implement the dock module in `app.js`**

First, DELETE the old inline panel block (from `// ---------- subagent telemetry panel ----------` through the end of `subagentDone`, ~lines 514-579) and the `_subagentRows` references. In `resetActivityState` (~line 224) replace the line `for (const k in _subagentRows) delete _subagentRows[k]; ...` with `resetConcurrencyDock();`.

Add this module (place where the old panel was):

```javascript
// ---------- concurrency dock: live parallel-wave timeline ----------
// A pinned bottom-right dock proving parallelism: one time-driven bar per
// subagent on a shared wall-clock axis (overlap = provably concurrent), plus a
// wall-vs-summed speedup line when the wave finishes. Driven by wave_started /
// subagent_started|progress|done / wave_done. Bars grow via a local ticker, not
// per-step events, so they glide smoothly regardless of event cadence.
// computeWaveStats comes from wave_stats.js (loaded before this script).
let _wave = null;          // { originTs, bars: Map<rowKey,bar>, done, manualCollapsed }
let _waveTicker = null;

function _dock() {
  let el = document.getElementById('concurrency-dock');
  if (!el) {
    el = document.createElement('div');
    el.id = 'concurrency-dock';
    el.innerHTML =
      '<div class="cdock-header"><span>⚡</span><span class="cdock-title">Subagents</span>' +
      '<span class="cdock-count"></span></div>' +
      '<div class="cdock-body"></div><div class="cdock-summary" style="display:none"></div>';
    el.querySelector('.cdock-header').addEventListener('click', () => {
      if (_wave) _wave.manualCollapsed = !el.classList.contains('cdock-collapsed');
      el.classList.toggle('cdock-collapsed');
    });
    document.body.appendChild(el);
  }
  return el;
}

function _waveRowKey(ev) { return `${ev.wave_id || ''}::${ev.agent || ''}::${ev.key_label || ''}`; }

function resetConcurrencyDock() {
  if (_waveTicker) { clearInterval(_waveTicker); _waveTicker = null; }
  _wave = null;
  const el = document.getElementById('concurrency-dock');
  if (el) el.remove();
}

function _startWave() {
  if (_waveTicker) clearInterval(_waveTicker);
  _wave = { originTs: performance.now(), bars: new Map(), done: false, manualCollapsed: false };
  const el = _dock();
  el.classList.remove('cdock-collapsed');
  el.querySelector('.cdock-body').innerHTML = '';
  el.querySelector('.cdock-summary').style.display = 'none';
  _waveTicker = setInterval(_renderWave, 200);
  _renderWave();
}

function _ensureWave() { if (!_wave || _wave.done) _startWave(); }

function waveStarted(ev) { _startWave(); }

function subagentStarted(ev) {
  _ensureWave();
  const key = _waveRowKey(ev);
  const now = performance.now();
  const row = document.createElement('div');
  row.className = 'cbar';
  row.innerHTML =
    '<div class="cbar-label"><span class="cbar-name"></span><span class="cbar-task"></span>' +
    '<span class="cbar-key"></span><span class="cbar-stat"></span></div>' +
    '<div class="cbar-track"><div class="cbar-fill"></div></div>';
  row.querySelector('.cbar-name').textContent = ev.agent || '';
  row.querySelector('.cbar-task').textContent = ev.task || '';
  row.querySelector('.cbar-key').textContent = ev.key_label || '';
  _dock().querySelector('.cdock-body').appendChild(row);
  _wave.bars.set(key, { row, startOffsetMs: now - _wave.originTs, endOffsetMs: null,
                        ok: null, steps: 0, tokens: 0, name: ev.agent, running: true });
  _renderWave();
}

function subagentProgress(ev) {
  if (!_wave) return;
  const bar = _wave.bars.get(_waveRowKey(ev));
  if (!bar) return;
  bar.steps = ev.step; bar.tokens = ev.tokens;
  bar.row.querySelector('.cbar-stat').textContent = `${ev.tokens} tok · step ${ev.step}/${ev.max_steps}`;
}

function subagentDone(ev) {
  if (!_wave) return;
  const bar = _wave.bars.get(_waveRowKey(ev));
  if (!bar) return;
  bar.endOffsetMs = performance.now() - _wave.originTs;
  bar.ok = !!ev.ok; bar.running = false; bar.steps = ev.steps; bar.tokens = ev.tokens;
  bar.row.querySelector('.cbar-fill').classList.add(ev.ok ? 'ok' : 'failed');
  bar.row.querySelector('.cbar-stat').textContent =
    `${ev.ok ? '✓' : '✗'} ${ev.elapsed_s}s · ${ev.tokens} tok · ${ev.steps} steps`;
  _renderWave();
  // Singleton (write) waves have no wave_done: freeze when nothing is running.
  if (![..._wave.bars.values()].some(b => b.running)) _freezeWaveSoon();
}

let _freezeTimer = null;
function _freezeWaveSoon() {
  if (_freezeTimer) clearTimeout(_freezeTimer);
  // brief grace so a rapid next-start in the same wave doesn't prematurely freeze
  _freezeTimer = setTimeout(() => {
    if (_wave && ![..._wave.bars.values()].some(b => b.running)) waveDone({});
  }, 400);
}

function waveDone(ev) {
  if (!_wave || _wave.done) return;
  _wave.done = true;
  if (_waveTicker) { clearInterval(_waveTicker); _waveTicker = null; }
  _renderWave();
  const stats = window.computeWaveStats([..._wave.bars.values()]);
  const el = _dock();
  const sum = el.querySelector('.cdock-summary');
  sum.style.display = '';
  sum.innerHTML = `⚡ wave done · ${stats.n} agents · peak ${stats.peak} concurrent · ` +
    `${stats.wallS}s wall vs ${stats.summedS}s summed → ` +
    `<span class="cdock-speedup">${stats.speedup}× faster</span>`;
  el.querySelector('.cdock-count').textContent = '';
}

function _renderWave() {
  if (!_wave) return;
  const el = _dock();
  const bars = [..._wave.bars.values()];
  const now = performance.now();
  let span = 1;
  bars.forEach(b => { const end = b.endOffsetMs == null ? now - _wave.originTs : b.endOffsetMs; if (end > span) span = end; });
  const runningCount = bars.filter(b => b.running).length;
  el.querySelector('.cdock-count').textContent = _wave.done ? '' : `${runningCount} running`;
  bars.forEach(b => {
    const end = b.endOffsetMs == null ? now - _wave.originTs : b.endOffsetMs;
    const fill = b.row.querySelector('.cbar-fill');
    fill.style.left = `${(b.startOffsetMs / span) * 100}%`;
    fill.style.width = `${Math.max(1, ((end - b.startOffsetMs) / span) * 100)}%`;
  });
  if (!_wave.manualCollapsed) el.classList.remove('cdock-collapsed');
}
```

Then in the `onEvent` switch, replace the three `subagent_*` cases and add wave cases:

```javascript
      case 'wave_started': waveStarted(ev); break;
      case 'subagent_started': subagentStarted(ev); break;
      case 'subagent_progress': subagentProgress(ev); break;
      case 'subagent_done': subagentDone(ev); break;
      case 'wave_done': waveDone(ev); break;
```

- [ ] **Step 4: Run the pure-function test to verify it passes**

Run: `cd "/Users/berat/Desktop/Omni Apps/omni-agent" && node tests/frontend/test_wave_stats.mjs`
Expected: `wave-stats ok` (imports `wave_stats.js` cleanly — it has no DOM access).

- [ ] **Step 5: Commit (source only)**

```bash
cd "/Users/berat/Desktop/Omni Apps/omni-agent"
git add frontend/wave_stats.js frontend/index.html frontend/app.js
git commit -m "feat(frontend): live concurrency timeline dock (overlapping bars + speedup line)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VH7Ti3qAaAAjRkvdYijyyJ"
```

---

### Task 8: Dev demo trigger + visual verification

**Files:**
- Modify: `frontend/app.js` — add `window.__demoWave` near the dock module.

**Interfaces:**
- Consumes: the dock event handlers from Task 7 (`waveStarted`/`subagentStarted`/`subagentProgress`/`subagentDone`/`waveDone`) via `window.__agent.onEvent`.
- Produces: `window.__demoWave(n = 3)` — synthesizes a realistic staggered wave through the real event pipeline.

- [ ] **Step 1: Add the demo trigger**

```javascript
// Dev-only: fire a synthetic parallel wave so the dock can be verified without a
// real delegating task. Call __demoWave(3) from the browser console.
window.__demoWave = function (n = 3) {
  const send = ev => window.__agent.onEvent(ev);
  const wave_id = 'demo' + Math.floor(Math.random() * 1e4);
  send({ type: 'wave_started', wave_id, size: n, workers: n });
  for (let i = 0; i < n; i++) {
    const agent = `probe-${i + 1}`, key_label = `k${i + 1}`;
    const dur = 1500 + Math.round(Math.random() * 3500);
    const base = { wave_id, agent, key_label };
    send({ type: 'subagent_started', ...base, task: `investigating thing #${i + 1}`, mode: 'read' });
    let step = 0;
    const iv = setInterval(() => {
      step++;
      send({ type: 'subagent_progress', ...base, elapsed_s: step, tokens: step * 900, step, max_steps: 6 });
    }, dur / 5);
    setTimeout(() => {
      clearInterval(iv);
      send({ type: 'subagent_done', ...base, ok: Math.random() > 0.15,
             elapsed_s: Math.round(dur / 1000), tokens: 5400, steps: 5 });
    }, dur);
  }
  const total = 5200;
  setTimeout(() => send({ type: 'wave_done', wave_id }), total);
};
```

- [ ] **Step 2: Visual verification (manual)**

Launch the app (per the project's run method / `/run`), open the browser console, and run `__demoWave(4)`.
Confirm by eye:
- The dock appears bottom-right and shows `4 running` counting down as bars finish.
- Bars **overlap** on the shared axis (start near-together, different lengths) — the visual proof of concurrency.
- On completion the summary reads `⚡ wave done · 4 agents · peak N concurrent · Xs wall vs Ys summed → Z× faster` with `Z > 1`.
- Clicking the header collapses/expands the dock; it stays put (doesn't scroll with chat).
- Toggle the OS/app theme (light/dark) — the dock remains legible in both.

- [ ] **Step 3: Commit**

```bash
cd "/Users/berat/Desktop/Omni Apps/omni-agent"
git add frontend/app.js
git commit -m "feat(frontend): __demoWave dev trigger to verify the concurrency dock

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VH7Ti3qAaAAjRkvdYijyyJ"
```

---

### Task 9: End-to-end verification + graph refresh

**Files:**
- No source changes (verification + housekeeping).

- [ ] **Step 1: Full backend suite**

Run: `cd "/Users/berat/Desktop/Omni Apps/omni-agent" && python -m pytest -q`
Expected: new tests pass; no NEW failures vs the pre-existing baseline (~19 unrelated, per project memory).

- [ ] **Step 2: Live parallel proof (manual, real task)**

Launch the app and give it a task whose plan naturally has ≥3 independent research steps in one phase (e.g. "locate the root check, the signature check, and the license flow in this codebase"), with those steps tagged `delegate=<a read subagent>`. Confirm the dock shows **≥3 overlapping bars**, `peak ≥ 3`, and `speedup > 1.5×`. This is the acceptance criterion from spec §9.

- [ ] **Step 3: Kill-switch check (manual or quick REPL)**

Confirm that with `session["parallel_execution_enabled"] = False`, dispatch reverts to one step at a time (Task 4's `test_disabled_flag_dispatches_single_step` already covers this in unit form; note it here as the documented fallback).

- [ ] **Step 4: Refresh the knowledge graph**

Run: `cd "/Users/berat/Desktop/Omni Apps/omni-agent" && graphify update .`
Expected: graph updates (AST-only, no API cost).

- [ ] **Step 5: Final commit (if graph artifacts changed)**

```bash
cd "/Users/berat/Desktop/Omni Apps/omni-agent"
git add graphify-out
git commit -m "chore(graph): refresh knowledge graph after parallel-execution changes

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VH7Ti3qAaAAjRkvdYijyyJ" || echo "no graph changes to commit"
```

---

## Notes for the implementer

- **Commit source only.** `/tests` is gitignored; never `git add tests/`. Each task's test files stay local.
- **Baseline failures.** The suite has ~19 pre-existing, unrelated failures (project memory). Judge your work by "no NEW failures," not by a fully green suite.
- **`_run_delegated_read_wave` is reused unchanged** — it already accepts the `(step, name, ad)` list and builds specs + streams telemetry internally. Task 4 just hands it a wider batch.
- **One wave at a time still holds.** The dependency loop in Task 4 dispatches sequential batches within a phase; phases are sequential. This preserves the distinct-key-per-concurrent-subagent assumption the dock's row-keying relies on (now also namespaced by `wave_id`).
- **If live runs hit provider rate limits** under wide fan-out, that's the fast-follow: add jittered retry/backoff in `llm.py`'s request path (out of scope here — don't build speculatively).
