# Strategic Brief Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a synthesized, always-pinned, adversarially-reviewed Strategic Brief that fixes mis-strategization and thread-loss on long runs, without perturbing the subagent/delegation stack.

**Architecture:** A new `strategy.py` module (module-level singleton, exact mirror of `planning.py`) holds a per-session brief. New core-ish `strategy_*` tools let the model author it. It pins at the top of the orchestrator system prompt; a diagnosis-phase gate blocks *mutating* tools until a complete brief passes one adversarial strategy review (reusing the `tools/reviewer.py` engine). Re-synthesis and kill-criteria nudges keep it honest. The brief is single-writer orchestrator state — subagents get a two-line read-only slice and never the `strategy_*` tools — so parallel waves are unaffected. Everything is behind the `strategy_brief_enabled` session flag; OFF is byte-identical to today.

**Tech Stack:** Python 3, the existing `tool_registry` decorator-registration, `llm.ask_llm`, the isolated-subagent reviewer pattern, plain-function offline tests run via `python tests/test_*.py`.

## Global Constraints

- **Model is fixed** — GLM 5.2 primary + DeepSeek fallback. No model/provider/key changes. Reuse `llm.ask_llm`.
- **Behind a flag** — every new behavior is gated by the session flag `strategy_brief_enabled` (default `STRATEGY_BRIEF_DEFAULT = True`). With it OFF: the orchestrator system prompt, `resolve_allowed_tools` output for every subagent, and all existing test outcomes must be **byte-identical / unchanged** vs. today.
- **Single writer** — the active brief is mutated only from the main orchestrator loop. Subagents never receive `strategy_set` / `strategy_update` (they are in `tool_policy.SUBAGENT_EXCLUDED`).
- **Never deadlock, never raise into the loop** — the diagnosis gate blocks only `tool_policy.MUTATING_TOOLS` (reads always run); the strategy review is bounded by `MAX_STRATEGY_REVIEW_ROUNDS` and forces through on exhaustion; brief persistence failures degrade silently like `planning._save`.
- **New tool modules MUST be imported in `tools/__init__.py`** (registration side effect) — a repo rule.
- **Offline tests only** for this workflow — no Docker/network/LLM; scripts monkeypatch `module.ask_llm` with a scripted fake (see `tests/test_reviewer.py`).
- Match surrounding code style: module-level singleton with `set_context`, `notify_updated`, `_save`/`load_*`; `@registry.register(...)` decorators; compact `to_markdown()`.

---

### Task 1: `strategy.py` — the brief model + module singleton

**Files:**
- Create: `strategy.py`
- Test: `tests/test_strategy_brief.py`

**Interfaces:**
- Produces:
  - `class StrategicBrief` with attrs `goal:str`, `diagnosis:list[dict{claim,evidence}]`, `strategy:str`, `rationale:str`, `rejected:list[str]`, `hypothesis:str`, `kill_criteria:list[str]`, `reviewed:bool`, `created_at`, `updated_at`.
  - `StrategicBrief.set(goal=None, diagnosis=None, strategy=None, rationale=None, rejected=None, hypothesis=None, kill_criteria=None) -> None` (setting any *strategic* field — everything except `hypothesis` — sets `reviewed=False`).
  - `StrategicBrief.is_empty() -> bool`, `.required_present() -> bool` (goal AND diagnosis AND strategy all non-empty), `.to_markdown() -> str`, `.to_dict() -> dict`, `StrategicBrief.from_dict(d) -> StrategicBrief`.
  - Module singleton: `set_context(memory_dir, notify_callback=None)`, `set_active_brief(brief, notify=True)`, `clear_active_brief(notify=True)`, `get_active() -> StrategicBrief|None`, `notify_updated()`, `load_brief(memory_dir) -> StrategicBrief|None`. Persist file: `strategy_brief.json`.

- [ ] **Step 1: Write the failing test**

Create `tests/test_strategy_brief.py`:

```python
"""Tests for strategy.py — the Strategic Brief model + module singleton.

Covers: field coercion (diagnosis strings/dicts, rejected/kill lists), the
reviewed-latch (a strategic edit clears it, a hypothesis-only edit does not),
required_present() and is_empty(), compact markdown, and disk round-trip.

Run: python tests/test_strategy_brief.py
"""
import sys as _sys, os as _os
_sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))

import sys, tempfile, shutil
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import strategy
from strategy import StrategicBrief


def test_empty_and_required():
    b = StrategicBrief()
    assert b.is_empty() and not b.required_present()
    b.set(goal="Bypass root check")
    assert not b.is_empty() and not b.required_present()  # diagnosis+strategy still missing
    b.set(diagnosis="RootBeer + native su probe", strategy="Frida-first, then static")
    assert b.required_present()
    print("OK: empty / required_present transitions.")
    return True


def test_diagnosis_coercion():
    b = StrategicBrief()
    b.set(diagnosis="single string claim")
    assert b.diagnosis == [{"claim": "single string claim", "evidence": ""}]
    b.set(diagnosis=[{"claim": "RootBeer", "evidence": "Root.smali:42"}, "bare native probe"])
    assert b.diagnosis[0] == {"claim": "RootBeer", "evidence": "Root.smali:42"}
    assert b.diagnosis[1] == {"claim": "bare native probe", "evidence": ""}
    print("OK: diagnosis coercion (string + dict).")
    return True


def test_reviewed_latch():
    b = StrategicBrief()
    b.set(goal="g", diagnosis="d", strategy="s")
    b.reviewed = True
    b.set(hypothesis="maybe the check is in libfoo.so")   # non-strategic -> keep reviewed
    assert b.reviewed is True
    b.set(strategy="new plan")                            # strategic -> clears reviewed
    assert b.reviewed is False
    print("OK: reviewed latch clears on strategic edit, holds on hypothesis-only.")
    return True


def test_roundtrip_and_markdown():
    b = StrategicBrief()
    b.set(goal="Bypass root", diagnosis=[{"claim": "RootBeer", "evidence": "R.smali:42"}],
          strategy="Frida first", rationale="layered java+native", rejected=["blind static patch"],
          hypothesis="native probe in libcheck.so", kill_criteria=["frida hook has no effect after 2 tries"])
    b.reviewed = True
    md = b.to_markdown()
    assert "Bypass root" in md and "RootBeer" in md and "Kill-criteria" in md
    d = tempfile.mkdtemp()
    try:
        strategy.set_context(d)
        strategy.set_active_brief(b)
        loaded = strategy.load_brief(d)
        assert loaded.goal == "Bypass root" and loaded.reviewed is True
        assert loaded.diagnosis[0]["evidence"] == "R.smali:42"
        assert loaded.kill_criteria == ["frida hook has no effect after 2 tries"]
    finally:
        strategy.set_context(None, None)
        strategy.clear_active_brief(notify=False)
        shutil.rmtree(d, ignore_errors=True)
    print("OK: disk round-trip + markdown.")
    return True


if __name__ == "__main__":
    ok = all([test_empty_and_required(), test_diagnosis_coercion(),
              test_reviewed_latch(), test_roundtrip_and_markdown()])
    print("\nALL PASS" if ok else "\nFAILURES")
    sys.exit(0 if ok else 1)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python tests/test_strategy_brief.py`
Expected: FAIL — `ModuleNotFoundError: No module named 'strategy'`.

- [ ] **Step 3: Write minimal implementation**

Create `strategy.py`:

```python
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
        return bool(self.goal and self.diagnosis and self.strategy)

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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python tests/test_strategy_brief.py`
Expected: `ALL PASS`.

- [ ] **Step 5: Commit**

```bash
git add strategy.py tests/test_strategy_brief.py
git commit -m "feat(strategy): StrategicBrief model + module singleton"
```

---

### Task 2: `strategy_*` tools, its toolset group, subagent exclusion, and prompt suppression

**Files:**
- Create: `tools/strategy_tools.py`
- Modify: `tools/__init__.py` (add `import tools.strategy_tools`)
- Modify: `tool_registry.py` (`_GROUP_BY_MODULE`, `GROUP_LABELS`, `get_tool_prompt` gains `hidden_groups`)
- Modify: `llm.py:313` (`render_tools_section` gains `hidden_groups`)
- Modify: `tool_policy.py:95` (`SUBAGENT_EXCLUDED`)
- Test: `tests/test_strategy_tools.py`

**Interfaces:**
- Consumes: `strategy.get_active`, `strategy.set_active_brief`, `strategy.StrategicBrief` (Task 1).
- Produces:
  - Registered tools `strategy_set` and `strategy_update` (group `"strategy"`).
  - `registry.get_tool_prompt(..., hidden_groups=None)` — a set of group names to omit ENTIRELY (no full block, no catalog line, no native index line).
  - `llm.render_tools_section(active_groups=None, native=False, hidden_groups=None)`.
  - `tool_policy.SUBAGENT_EXCLUDED` now includes `"strategy_set"`, `"strategy_update"`.

- [ ] **Step 1: Write the failing test**

Create `tests/test_strategy_tools.py`:

```python
"""Tests for the strategy_* tools, their subagent exclusion, and prompt suppression.

Run: python tests/test_strategy_tools.py
"""
import sys as _sys, os as _os
_sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))

import sys
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import strategy
import tools  # noqa: F401  (registers strategy_set / strategy_update)
from tool_registry import registry
from tool_policy import SUBAGENT_EXCLUDED
from subagents import AgentDef, resolve_allowed_tools


def _reset():
    strategy.set_context(None, None)
    strategy.clear_active_brief(notify=False)


def test_strategy_set_and_update():
    _reset()
    registry.execute("strategy_set", {"goal": "bypass root", "diagnosis": "RootBeer",
                                       "strategy": "frida first", "rationale": "layered"})
    b = strategy.get_active()
    assert b is not None and b.required_present() and b.reviewed is False
    b.reviewed = True
    registry.execute("strategy_update", {"hypothesis": "native probe libcheck.so"})
    assert strategy.get_active().reviewed is True   # hypothesis-only keeps reviewed
    registry.execute("strategy_update", {"strategy": "static first"})
    assert strategy.get_active().reviewed is False  # strategic edit clears it
    _reset()
    print("OK: strategy_set/update mutate the active brief + reviewed latch.")
    return True


def test_registered_in_strategy_group():
    assert registry.group_of("strategy_set") == "strategy"
    assert registry.group_of("strategy_update") == "strategy"
    print("OK: strategy tools live in the 'strategy' toolset group.")
    return True


def test_subagent_never_sees_strategy_tools():
    assert "strategy_set" in SUBAGENT_EXCLUDED and "strategy_update" in SUBAGENT_EXCLUDED
    # A write agent with the widest surface still must not get them.
    wide = AgentDef("wideimpl", "impl", mode="write", toolsets=["apk", "native", "smali"])
    allowed = resolve_allowed_tools(wide)
    assert "strategy_set" not in allowed and "strategy_update" not in allowed
    print("OK: no subagent (even write) resolves strategy_* tools.")
    return True


def test_hidden_groups_suppresses_completely():
    on = registry.get_tool_prompt(active_groups={"strategy"})
    assert "strategy_set" in on
    off = registry.get_tool_prompt(active_groups=set(), hidden_groups={"strategy"})
    assert "strategy_set" not in off and "strategy_update" not in off
    assert "strategy" not in off.lower().split("end of tool list")[0].replace("strategy_", "")
    # native index path also honors hidden_groups
    off_native = registry.get_tool_prompt(active_groups=set(), native=True, hidden_groups={"strategy"})
    assert "strategy_set" not in off_native
    print("OK: hidden_groups removes the strategy group from every render path.")
    return True


if __name__ == "__main__":
    ok = all([test_strategy_set_and_update(), test_registered_in_strategy_group(),
              test_subagent_never_sees_strategy_tools(), test_hidden_groups_suppresses_completely()])
    print("\nALL PASS" if ok else "\nFAILURES")
    sys.exit(0 if ok else 1)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python tests/test_strategy_tools.py`
Expected: FAIL — `strategy_set` not registered / `group_of` raises or returns core / `hidden_groups` unexpected kwarg.

- [ ] **Step 3: Write minimal implementation**

Create `tools/strategy_tools.py`:

```python
"""Strategic Brief tools — the model authors and revises the synthesized thesis
that shapes its decisions. State lives in strategy.py's module-level active brief;
agent.py wires strategy.set_context(...) once per session so these autosave and
refresh the live prompt. Orchestrator-only: these are in tool_policy.SUBAGENT_EXCLUDED,
so no subagent ever sees or calls them (single-writer guarantee)."""
from tool_registry import registry
import strategy


def _render(action):
    b = strategy.get_active()
    body = b.to_markdown() if b is not None else "(no brief)"
    missing = []
    if b is None or not b.goal:
        missing.append("goal")
    if b is None or not b.diagnosis:
        missing.append("diagnosis")
    if b is None or not b.strategy:
        missing.append("strategy")
    tail = ""
    if missing:
        tail = ("\n\nStill required before you can start CHANGING the workspace: "
                + ", ".join(missing) + ".")
    elif b is not None and not b.reviewed:
        tail = ("\n\nThe brief is complete but not yet strategy-reviewed — it will be "
                "independently reviewed automatically before your first mutating tool runs.")
    return {"stdout": f"Strategic Brief {action}:\n{body}{tail}"}


@registry.register(
    name="strategy_set",
    description=(
        "Author (or fully replace) the STRATEGIC BRIEF — the synthesized thesis that steers the whole run "
        "and stays pinned at the top of your context. Do this after enough recon to actually diagnose the "
        "target, and BEFORE you start changing the workspace: a complete brief (goal + diagnosis + strategy) "
        "must pass an independent strategy review before any mutating tool will run. Keep it tight; back each "
        "diagnosis item with an evidence pointer."
    ),
    params_schema={
        "goal": "string — the mission in one line (your drift anchor)",
        "diagnosis": "array — what protection(s) are actually present; each item a string OR {claim, evidence} where evidence is a file:line/symbol/log pointer",
        "strategy": "string — the chosen attack and the order you'll run it",
        "rationale": "string (optional) — why this strategy over the alternatives",
        "rejected": "array of strings (optional) — strategies you considered and ruled out, so you don't re-litigate them",
        "hypothesis": "string (optional) — your current top hypothesis under test",
        "kill_criteria": "array of strings (optional) — the conditions under which this strategy is wrong and you must abandon it",
    },
    output="The rendered brief and what (if anything) is still required before mutations unlock.",
    when_to_use="Call once you can diagnose the target, before your first change. To tweak one field later use strategy_update.",
)
def strategy_set(goal="", diagnosis=None, strategy=None, rationale=None,
                 rejected=None, hypothesis=None, kill_criteria=None):
    import strategy as _strat
    b = _strat.get_active() or _strat.StrategicBrief()
    b.set(goal=goal, diagnosis=diagnosis, strategy=strategy, rationale=rationale,
          rejected=rejected, hypothesis=hypothesis, kill_criteria=kill_criteria)
    _strat.set_active_brief(b)
    return _render("set")


@registry.register(
    name="strategy_update",
    description=(
        "Revise one or more fields of the STRATEGIC BRIEF as evidence arrives. Changing any strategic field "
        "(goal / diagnosis / strategy / rationale / rejected / kill_criteria) re-opens the brief for an "
        "independent strategy review before the next mutation; updating only the hypothesis does not."
    ),
    params_schema={
        "goal": "string (optional)",
        "diagnosis": "array (optional) — replaces the diagnosis list; string or {claim, evidence} items",
        "strategy": "string (optional)",
        "rationale": "string (optional)",
        "rejected": "array of strings (optional) — replaces the rejected list",
        "hypothesis": "string (optional) — refine the current top hypothesis (does not force re-review)",
        "kill_criteria": "array of strings (optional) — replaces the kill-criteria list",
    },
    output="The rendered brief and what (if anything) is still required before mutations unlock.",
    when_to_use="Use to evolve an existing brief. To create it the first time use strategy_set.",
)
def strategy_update(goal=None, diagnosis=None, strategy=None, rationale=None,
                    rejected=None, hypothesis=None, kill_criteria=None):
    import strategy as _strat
    b = _strat.get_active() or _strat.StrategicBrief()
    b.set(goal=goal, diagnosis=diagnosis, strategy=strategy, rationale=rationale,
          rejected=rejected, hypothesis=hypothesis, kill_criteria=kill_criteria)
    _strat.set_active_brief(b)
    return _render("updated")
```

Add to `tools/__init__.py` (after the `import tools.investigation_tools` line):

```python
import tools.strategy_tools
```

In `tool_registry.py`, add to `_GROUP_BY_MODULE` (right after the `"investigation_tools": CORE_GROUP,` line):

```python
    "strategy_tools": "strategy",
```

In `tool_registry.py`, add to `GROUP_LABELS`:

```python
    "strategy": "author / revise the pinned Strategic Brief (goal + diagnosis + chosen strategy)",
```

In `tool_registry.py`, change the `get_tool_prompt` signature and add the hidden filter. Replace the signature line:

```python
    def get_tool_prompt(self, allowed_tools=None, active_groups=None, native=False, hidden_groups=None):
```

Immediately after the `def visible(name):` helper inside `get_tool_prompt`, wrap it so hidden groups are invisible everywhere:

```python
        hidden = set(hidden_groups or ())

        def visible(name):
            if allowed_tools is not None and name not in allowed_tools:
                return False
            if hidden and self.group_of(name) in hidden:
                return False
            return True
```

(Delete the old one-line `def visible` — the three render branches, native index, legacy full, and progressive, all already route through `visible(name)`, so no further edits are needed there. The native branch's `self.domain_groups()` loop still calls `visible()` per name, so a fully-hidden group emits no names and its header is skipped by the existing `if not names: continue`.)

In `llm.py`, thread the param through `render_tools_section` (line 313):

```python
def render_tools_section(active_groups=None, native=False, hidden_groups=None):
```

and its body:

```python
    return registry.get_tool_prompt(active_groups=active_groups, native=native,
                                    hidden_groups=hidden_groups)
```

In `tool_policy.py`, extend `SUBAGENT_EXCLUDED` (line 95):

```python
SUBAGENT_EXCLUDED = {"dispatch_agents", "ask_codebase", "review_conclusion",
                     "strategy_set", "strategy_update"}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python tests/test_strategy_tools.py`
Expected: `ALL PASS`.

- [ ] **Step 5: Run the progressive-tools regression to prove no collateral render change**

Run: `python tests/test_progressive_tools.py`
Expected: PASS (existing behavior for core/other groups unchanged; `hidden_groups` defaults to none).

- [ ] **Step 6: Commit**

```bash
git add tools/strategy_tools.py tools/__init__.py tool_registry.py llm.py tool_policy.py tests/test_strategy_tools.py
git commit -m "feat(strategy): strategy_set/update tools, 'strategy' group, subagent exclusion, hidden_groups prompt suppression"
```

---

### Task 3: pin the brief in the prompt, wire the session, and guarantee byte-identical-when-off

**Files:**
- Modify: `agent.py` — `_refresh_system_prompt`, `start_session` (flags + `set_context` + restore), teardown, add `_on_strategy_update`, add module constants + import.
- Test: `tests/test_strategy_prompt.py`

**Interfaces:**
- Consumes: `strategy` module (Task 1), `render_tools_section(..., hidden_groups=...)` (Task 2).
- Produces:
  - Module constants `STRATEGY_BRIEF_DEFAULT = True`, `MAX_STRATEGY_REVIEW_ROUNDS = 2`, `STRATEGY_RESYNC_FINDINGS = 5`.
  - Session flags `strategy_brief_enabled`, `strategy_review_rounds` (int, 0), `findings_since_brief_sync` (int, 0).
  - `AgentApi._on_strategy_update(brief_dict)` bridge (refreshes prompt + emits `strategy_update` event).
  - Composition contract: when `strategy_brief_enabled` and the brief is non-empty, a `STRATEGIC BRIEF` block renders **above** the plan and investigation blocks; when the flag is off, the `strategy` toolset is suppressed via `hidden_groups={"strategy"}` and the brief block is absent — the system message is byte-identical to today.

- [ ] **Step 1: Write the failing test**

Create `tests/test_strategy_prompt.py`:

```python
"""The Strategic Brief pins above plan/investigation when enabled, and vanishes
(byte-identical) when disabled. Drives AgentApi._refresh_system_prompt directly.

Run: python tests/test_strategy_prompt.py
"""
import sys as _sys, os as _os
_sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))

import sys
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import strategy, planning
import tools  # noqa: F401
from agent import AgentApi


def _mk(flag):
    api = AgentApi.__new__(AgentApi)          # no GUI
    api.session = {
        "base_system_prompt": "BASE.",
        "active_toolsets": set(),
        "native_tools": False,
        "strategy_brief_enabled": flag,
        "messages": [{"role": "system", "content": ""}],
    }
    return api


def _reset():
    strategy.set_context(None, None); strategy.clear_active_brief(notify=False)
    planning.set_context(None, None); planning.clear_active_plan(notify=False)


def test_off_is_byte_identical_and_hides_group():
    _reset()
    strategy.set_active_brief(_brief())         # a brief exists but flag is OFF
    api = _mk(False)
    api._refresh_system_prompt()
    off = api.session["messages"][0]["content"]
    assert "STRATEGIC BRIEF" not in off and "strategy_set" not in off
    _reset()
    print("OK: flag off -> no brief block, strategy group hidden.")
    return True


def test_on_pins_above_plan_and_investigation():
    _reset()
    strategy.set_active_brief(_brief())
    p = planning.Plan("bypass root"); planning.set_active_plan(p, notify=False)
    api = _mk(True)
    api._refresh_system_prompt()
    on = api.session["messages"][0]["content"]
    assert "STRATEGIC BRIEF" in on and "bypass root check" in on
    assert "strategy_set" in on                    # 'strategy' group rendered in full
    assert on.index("STRATEGIC BRIEF") < on.index("CURRENT PLAN")
    _reset()
    print("OK: flag on -> brief pinned above the plan; strategy tools rendered.")
    return True


def test_empty_brief_renders_no_block():
    _reset()
    strategy.set_active_brief(strategy.StrategicBrief())   # empty
    api = _mk(True)
    api._refresh_system_prompt()
    on = api.session["messages"][0]["content"]
    assert "STRATEGIC BRIEF" not in on            # empty brief -> no block (still tools shown)
    _reset()
    print("OK: empty brief renders no block.")
    return True


def _brief():
    b = strategy.StrategicBrief()
    b.set(goal="bypass root check", diagnosis="RootBeer", strategy="frida first")
    return b


if __name__ == "__main__":
    ok = all([test_off_is_byte_identical_and_hides_group(),
              test_on_pins_above_plan_and_investigation(),
              test_empty_brief_renders_no_block()])
    print("\nALL PASS" if ok else "\nFAILURES")
    sys.exit(0 if ok else 1)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python tests/test_strategy_prompt.py`
Expected: FAIL — `_refresh_system_prompt` renders no brief block / raises on the new flag.

- [ ] **Step 3: Write minimal implementation**

In `agent.py`, near the other workflow constants (by `REVIEW_ENABLED_DEFAULT = True`, line ~394), add:

```python
# Strategic Brief: a synthesized, pinned, adversarially-reviewed thesis that shapes
# decisions. Behind strategy_brief_enabled; OFF is byte-identical to today.
STRATEGY_BRIEF_DEFAULT = True
MAX_STRATEGY_REVIEW_ROUNDS = 2   # revise rounds before the gate forces a mutation through
STRATEGY_RESYNC_FINDINGS = 5     # new findings before nudging a brief reconcile
```

In `agent.py`, add the import beside `import investigation` (line 55):

```python
import strategy
```

Replace the body of `_refresh_system_prompt` (lines 1313-1336) so the brief pins first and the group is hidden when off. Change the `tools_section` line and insert the brief block:

```python
        strat_on = bool(self.session.get("strategy_brief_enabled"))
        # When the Strategic Brief is OFF, suppress its toolset entirely so the
        # prompt is byte-identical to a pre-feature build; when ON, render it in full.
        hidden = None if strat_on else {"strategy"}
        active = set(self.session.get("active_toolsets") or set())
        if strat_on:
            active = active | {"strategy"}
        tools_section = render_tools_section(active, native=native, hidden_groups=hidden)
        plan = planning.get_active_plan()
        section = ""
        # Strategic Brief pins FIRST (above plan + investigation) so it's the stable
        # north-star the model reasons against every turn.
        if strat_on:
            brief = strategy.get_active()
            if brief is not None and not brief.is_empty():
                section += (
                    "\n\nSTRATEGIC BRIEF (your synthesized thesis — keep it current with strategy_set / "
                    "strategy_update; a complete brief must pass an independent strategy review before you "
                    "may change the workspace):\n" + brief.to_markdown()
                )
```

(Leave the existing `if plan is not None:` and investigation blocks exactly as they are, appended after — so order becomes brief → plan → investigation. The final `self.session["messages"][0]["content"] = ...` line is unchanged.)

Add the bridge method after `_on_investigation_update` (line ~1350):

```python
    def _on_strategy_update(self, brief_dict):
        """Bridge from strategy.py's notify callback to the live prompt + event
        stream (mirrors _on_plan_update / _on_investigation_update)."""
        self._refresh_system_prompt()
        self._emit({"type": "strategy_update", "strategy": brief_dict})
```

In `start_session`, add the flags to the session dict (right after the `"review_enabled": ...` block, line ~2152):

```python
            # --- Strategic Brief workflow state ---
            "strategy_brief_enabled": STRATEGY_BRIEF_DEFAULT,
            "strategy_review_rounds": 0,        # strategy-review revise rounds this task
            "findings_since_brief_sync": 0,     # new findings since the last brief reconcile
```

In `start_session`, wire the context + restore beside the planning/investigation wiring (after line 2194, `investigation.set_context(...)`):

```python
        strategy.set_context(memory_dir, notify_callback=self._on_strategy_update)
        _restored_brief = strategy.load_brief(memory_dir)
        if _restored_brief is not None:
            strategy.set_active_brief(_restored_brief, notify=False)
```

In the teardown beside `planning.set_context(None, notify_callback=None)` (line 2764):

```python
        strategy.set_context(None, notify_callback=None)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python tests/test_strategy_prompt.py`
Expected: `ALL PASS`.

- [ ] **Step 5: Prove the OFF path is byte-identical against a saved-session prompt regression**

Run: `python tests/test_prompt_integration.py`
Expected: PASS (the default full-render / progressive prompt is unchanged when the strategy group is hidden; if this file asserts exact prompt bytes for a flag-off/legacy path, it must still pass).

- [ ] **Step 6: Commit**

```bash
git add agent.py tests/test_strategy_prompt.py
git commit -m "feat(strategy): pin the brief above plan/investigation; wire session; byte-identical when off"
```

---

### Task 4: `run_strategy_review` — the adversarial strategy reviewer

**Files:**
- Modify: `tools/reviewer.py` (add `_STRATEGY_REVIEWER_SYSTEM_PROMPT`, `_format_strategy_feedback`, `run_strategy_review`)
- Test: `tests/test_strategy_review.py`

**Interfaces:**
- Consumes: existing `tools/reviewer.py` helpers `_parse_response`, `_execute_readonly`, `_coerce_verdict`, `REVIEWER_TOOLS`, `SUBAGENT_TEMPERATURE`, `REVIEW_CONTEXT_CHAR_LIMIT`, `REPEAT_LIMIT`, `MAX_STEPS_CAP`, `ask_llm`.
- Produces: `run_strategy_review(brief_markdown, task="", extra_context="", max_steps=10) -> dict` with the same verdict shape as `run_review` (`approved`, `verdict`, `summary`, `unsupported_claims`, `contradictions`, `incomplete_work`, `required_actions`, `feedback`, `steps`). Never raises (conservative non-blocking approve on internal error, so the gate can't deadlock).

- [ ] **Step 1: Write the failing test**

Create `tests/test_strategy_review.py`:

```python
"""The adversarial strategy reviewer (tools.reviewer.run_strategy_review).
Scripted LLM replies, no network.

Run: python tests/test_strategy_review.py
"""
import sys as _sys, os as _os
_sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))

import sys
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import tools  # noqa: F401
from tools import reviewer
from tools.reviewer import run_strategy_review

BRIEF = ("Goal: bypass root check\nDiagnosis:\n  - RootBeer [Root.smali:42]\n"
         "Strategy: patch the smali boolean\n")


def _script(replies):
    state = {"i": 0}
    def fake(messages, temperature=0.7):
        i = state["i"]; state["i"] += 1
        return replies[i] if i < len(replies) else replies[-1]
    return fake


def test_approve():
    reviewer.ask_llm = _script(['{"type":"final_answer","content":{"verdict":"approve","summary":"sound"}}'])
    v = run_strategy_review(BRIEF, task="bypass root")
    assert v["approved"] is True and v["feedback"] == ""
    print("OK: approve verdict passes.")
    return True


def test_revise_gives_feedback():
    reviewer.ask_llm = _script(['{"type":"final_answer","content":{"verdict":"revise",'
                                '"contradictions":["a native probe in libcheck.so also gates root"],'
                                '"required_actions":["frida-trace the native path before static patching"]}}'])
    v = run_strategy_review(BRIEF, task="bypass root")
    assert v["approved"] is False
    assert "libcheck.so" in v["feedback"] and "STRATEG" in v["feedback"].upper()
    print("OK: revise verdict yields strategy feedback.")
    return True


def test_error_is_non_blocking():
    def boom(messages, temperature=0.7):
        raise RuntimeError("provider down")
    reviewer.ask_llm = boom
    v = run_strategy_review(BRIEF, task="bypass root")
    assert v["approved"] is True   # conservative: never deadlock the gate on infra
    print("OK: reviewer error -> non-blocking approve.")
    return True


if __name__ == "__main__":
    ok = all([test_approve(), test_revise_gives_feedback(), test_error_is_non_blocking()])
    print("\nALL PASS" if ok else "\nFAILURES")
    sys.exit(0 if ok else 1)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python tests/test_strategy_review.py`
Expected: FAIL — `cannot import name 'run_strategy_review'`.

- [ ] **Step 3: Write minimal implementation**

In `tools/reviewer.py`, after `_REVIEWER_SYSTEM_PROMPT` add a strategy-focused prompt:

```python
_STRATEGY_REVIEWER_SYSTEM_PROMPT = """You are an independent, skeptical STRATEGY REVIEWER in an isolated \
session. A worker agent is about to start CHANGING an app based on a STRATEGIC BRIEF: a diagnosis of the \
target's protections and a chosen attack. Your job is NOT to be agreeable — it is to find, BEFORE any change \
is made, whether the strategy is aimed wrong: a mis-diagnosed protection, a better/simpler attack it skipped, \
an attack order that will fail, or a diagnosis claim with no real evidence.

You share the worker's read-only view (code graph, grep/find, file read, disassembly, decompilation, and the \
worker's investigation memory). You cannot modify or run anything — you only verify the PLAN OF ATTACK.

HOW TO REVIEW THE STRATEGY:
1. EVIDENCE. For each diagnosis claim, check the cited evidence actually supports it (open the file:line, \
confirm the class/method/string/symbol). A protection claim with no checkable evidence is UNSUPPORTED.
2. BETTER-STRATEGY PASS. Actively look for a stronger or simpler attack the brief missed, or a second code \
path/protection layer the strategy does not cover (e.g. a native probe in a .so when the plan only patches \
smali). Spend at least one step trying to prove the strategy is not the best one.
3. ORDER & KILL-CRITERIA. Check the attack order is sound (e.g. confirm-with-frida before a static patch on \
layered protections) and that the kill-criteria are concrete enough to know when to abandon it.
4. Be fair: only demand a revision for a REAL problem (unsupported diagnosis, a materially better/necessary \
strategy, an order that will fail). If the strategy is well-diagnosed and sound, APPROVE it.

RESPONSE FORMAT — always a single raw JSON object, no markdown, no prose outside it.
To use a tool: {"type": "tool_call", "tool": "<name>", "args": { ... }}
Verdict: {"type": "final_answer", "content": {
  "verdict": "approve" | "revise",
  "summary": "<one or two sentences>",
  "unsupported_claims": ["<diagnosis claim lacking evidence>", ...],
  "contradictions": ["<a better strategy, missed layer, or wrong-order risk>", ...],
  "incomplete_work": ["<a gap the brief must fill before execution>", ...],
  "required_actions": ["<concrete change to the brief/strategy>", ...]
}}
Use "approve" ONLY when unsupported_claims, contradictions and incomplete_work are all empty (or truly \
negligible). Otherwise "revise" with concrete required_actions. Call one tool at a time; investigate before \
you rule."""


def _format_strategy_feedback(v):
    """Render a strategy-review verdict into the corrective message the worker gets."""
    lines = ["[STRATEGY REVIEWER — REVISION REQUIRED] An independent review of your STRATEGIC BRIEF found "
             "problems. Fix the brief with strategy_update before you start changing the workspace."]
    if v.get("summary"):
        lines.append(f"Summary: {v['summary']}")
    for label, key in (("Unsupported diagnosis (no checkable evidence)", "unsupported_claims"),
                       ("Better strategy / missed layer / wrong order", "contradictions"),
                       ("Gaps to fill before execution", "incomplete_work"),
                       ("Required changes to the brief", "required_actions")):
        items = v.get(key) or []
        if items:
            lines.append(label + ":")
            lines.extend(f"  - {it}" for it in items)
    lines.append("Revise the brief (strategy_update) to address these, then continue.")
    return "\n".join(lines)


def run_strategy_review(brief_markdown, task="", extra_context="", max_steps=DEFAULT_REVIEW_STEPS):
    """Independently review a STRATEGIC BRIEF before execution. Same verdict shape as
    run_review; never raises for review reasons (a failure yields a conservative,
    non-blocking approve so the diagnosis gate can never deadlock on infrastructure)."""
    brief_markdown = (brief_markdown or "").strip()
    if not brief_markdown:
        return {"approved": True, "verdict": "approve", "summary": "No brief to review.",
                "unsupported_claims": [], "contradictions": [], "incomplete_work": [],
                "required_actions": [], "feedback": "", "steps": 0}
    try:
        max_steps = max(1, min(int(max_steps), MAX_STEPS_CAP))
    except (TypeError, ValueError):
        max_steps = DEFAULT_REVIEW_STEPS

    tool_prompt = registry.get_tool_prompt(allowed_tools=REVIEWER_TOOLS)
    system_prompt = _STRATEGY_REVIEWER_SYSTEM_PROMPT + "\n\n" + tool_prompt
    user = "THE TASK:\n" + (task or "(not provided)") + "\n\n"
    user += "THE STRATEGIC BRIEF TO REVIEW (the plan of attack, before any change):\n" + brief_markdown + "\n"
    if (extra_context or "").strip():
        user += "\nADDITIONAL CONTEXT / INVESTIGATION MEMORY:\n" + extra_context.strip() + "\n"
    user += ("\nReview this strategy now. Verify the diagnosis evidence, run a better-strategy pass, check the "
             "order and kill-criteria, then return your verdict JSON.")

    messages = [{"role": "system", "content": system_prompt},
                {"role": "user", "content": user}]

    steps = 0
    last_sig = None
    repeats = 0
    parse_errors = 0
    try:
        while steps < max_steps:
            raw = ask_llm(messages, temperature=SUBAGENT_TEMPERATURE)
            rtype, payload = _parse_response(raw)
            messages.append({"role": "assistant", "content": raw})

            if rtype == "final_answer":
                v = _coerce_verdict(payload)
                v["steps"] = steps
                v["feedback"] = "" if v["approved"] else _format_strategy_feedback(v)
                return v

            if rtype == "error":
                parse_errors += 1
                if parse_errors >= 3:
                    v = _coerce_verdict(strip_reasoning(raw))
                    v["steps"] = steps
                    v["feedback"] = "" if v["approved"] else _format_strategy_feedback(v)
                    return v
                messages.append({"role": "user", "content": (
                    "Your last reply was not valid JSON. Reply with a single raw JSON object: either a "
                    'tool_call or your verdict {"type":"final_answer","content":{"verdict":...}}.')})
                continue
            parse_errors = 0

            tool_name = payload.get("tool")
            tool_args = payload.get("args", {}) or {}
            sig = (tool_name, json.dumps(tool_args, sort_keys=True, default=str))
            if sig == last_sig:
                repeats += 1
            else:
                repeats, last_sig = 1, sig
            if repeats >= REPEAT_LIMIT:
                messages.append({"role": "user", "content": (
                    f"[SYSTEM] You've called '{tool_name}' identically {repeats} times. Stop looping — "
                    "try a different check or give your verdict.")})
                repeats = 0
                continue

            steps += 1
            feedback = _execute_readonly(tool_name, tool_args)
            messages.append({"role": "user", "content": f"TOOL RESULT:\n{feedback}"})

            if _estimate_chars(messages) > REVIEW_CONTEXT_CHAR_LIMIT:
                break

        messages.append({"role": "user", "content": (
            "[SYSTEM] Review budget reached. Give your verdict now as "
            '{"type":"final_answer","content":{"verdict":...}} based on what you have checked.')})
        raw = ask_llm(messages, temperature=SUBAGENT_TEMPERATURE)
        _, payload = _parse_response(raw)
        v = _coerce_verdict(payload if payload else raw)
        v["steps"] = steps
        v["feedback"] = "" if v["approved"] else _format_strategy_feedback(v)
        return v
    except Exception as e:
        return {"approved": True, "verdict": "approve",
                "summary": f"Strategy review skipped (reviewer error: {e}).",
                "unsupported_claims": [], "contradictions": [], "incomplete_work": [],
                "required_actions": [], "feedback": "", "steps": 0}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python tests/test_strategy_review.py`
Expected: `ALL PASS`.

- [ ] **Step 5: Confirm the existing reviewer is untouched**

Run: `python tests/test_reviewer.py`
Expected: PASS (shared helpers unchanged; only additions made).

- [ ] **Step 6: Commit**

```bash
git add tools/reviewer.py tests/test_strategy_review.py
git commit -m "feat(strategy): adversarial run_strategy_review reusing the reviewer engine"
```

---

### Task 5: the diagnosis-phase gate — block mutations until a reviewed brief exists

**Files:**
- Modify: `agent.py` — insert the strategy gate into `_pre_tool_gates`; add `_run_strategy_review_gate`; import `run_strategy_review`.
- Test: `tests/test_strategy_gate.py`

**Interfaces:**
- Consumes: `strategy.get_active`, `MUTATING_TOOLS`, `MAX_STRATEGY_REVIEW_ROUNDS`, `run_strategy_review` (Task 4), `planning`, `investigation`.
- Produces:
  - `AgentApi._run_strategy_review_gate(s, brief) -> "continue"|None` — runs the strategy review; on approve sets `brief.reviewed=True` and returns `None` (allow); on revise injects `feedback`, increments `s["strategy_review_rounds"]`, returns `"continue"`; after `MAX_STRATEGY_REVIEW_ROUNDS` forces `reviewed=True` and returns `None` (never deadlock).
  - New gate in `_pre_tool_gates`: when `strategy_brief_enabled` and `tool_name in MUTATING_TOOLS` — if no brief or `not required_present()` → nudge + `"continue"`; elif `not brief.reviewed` → delegate to `_run_strategy_review_gate`. Reads are never gated.

- [ ] **Step 1: Write the failing test**

Create `tests/test_strategy_gate.py`:

```python
"""The diagnosis-phase gate: mutating tools are blocked until a complete brief
passes a strategy review; read tools are never blocked; the gate never deadlocks.

Run: python tests/test_strategy_gate.py
"""
import sys as _sys, os as _os
_sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))

import sys
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import strategy
import tools  # noqa: F401
import agent as agentmod
from agent import AgentApi
from tool_policy import MUTATING_TOOLS

A_MUTATING = sorted(MUTATING_TOOLS)[0]   # any real mutating tool name
A_READ = "read_file"


def _api(**flags):
    api = AgentApi.__new__(AgentApi)
    api._stop = False
    api.session = {"strategy_brief_enabled": True, "strategy_review_rounds": 0,
                   "messages": [], "evidence_guards": False, "needs_plan": False,
                   "original_task": "bypass root", **flags}
    api._emit = lambda ev: None
    return api


def _complete_brief():
    b = strategy.StrategicBrief()
    b.set(goal="g", diagnosis="RootBeer", strategy="frida first")
    strategy.set_active_brief(b, notify=False)
    return b


def _reset():
    strategy.set_context(None, None); strategy.clear_active_brief(notify=False)


def test_read_never_blocked():
    _reset()
    api = _api()
    assert api._pre_tool_gates(api.session, A_READ, {}, adaptive=True, is_plan_tool=False) is None
    print("OK: read tool passes the strategy gate with no brief.")
    return True


def test_mutation_blocked_without_brief():
    _reset()
    api = _api()
    out = api._pre_tool_gates(api.session, A_MUTATING, {}, adaptive=True, is_plan_tool=False)
    assert out == "continue"
    assert any("STRATEGIC BRIEF" in m["content"] for m in api.session["messages"])
    print("OK: mutation blocked until a brief exists.")
    return True


def test_mutation_blocked_when_unreviewed_then_allowed_on_approve():
    _reset()
    b = _complete_brief()
    agentmod.run_strategy_review = lambda *a, **k: {"approved": True, "summary": "sound", "feedback": ""}
    api = _api()
    out = api._pre_tool_gates(api.session, A_MUTATING, {}, adaptive=True, is_plan_tool=False)
    assert out is None and b.reviewed is True     # approved -> allowed through
    print("OK: complete+unreviewed brief -> review -> approve -> mutation allowed.")
    return True


def test_revise_blocks_and_injects_feedback():
    _reset()
    _complete_brief()
    agentmod.run_strategy_review = lambda *a, **k: {"approved": False, "summary": "missed native layer",
                                                    "feedback": "[STRATEGY REVIEWER] fix it"}
    api = _api()
    out = api._pre_tool_gates(api.session, A_MUTATING, {}, adaptive=True, is_plan_tool=False)
    assert out == "continue" and api.session["strategy_review_rounds"] == 1
    assert any("STRATEGY REVIEWER" in m["content"] for m in api.session["messages"])
    print("OK: revise blocks the mutation and injects feedback.")
    return True


def test_never_deadlocks_after_max_rounds():
    _reset()
    b = _complete_brief()
    agentmod.run_strategy_review = lambda *a, **k: {"approved": False, "summary": "no", "feedback": "x"}
    api = _api(strategy_review_rounds=agentmod.MAX_STRATEGY_REVIEW_ROUNDS)
    out = api._pre_tool_gates(api.session, A_MUTATING, {}, adaptive=True, is_plan_tool=False)
    assert out is None and b.reviewed is True     # forced through, no deadlock
    print("OK: gate forces the mutation through after the round cap.")
    return True


def test_disabled_flag_is_noop():
    _reset()
    api = _api(strategy_brief_enabled=False)
    out = api._pre_tool_gates(api.session, A_MUTATING, {}, adaptive=True, is_plan_tool=False)
    assert out is None   # no brief, but the gate is off -> mutation not blocked here
    print("OK: flag off -> strategy gate is a no-op.")
    return True


if __name__ == "__main__":
    ok = all([test_read_never_blocked(), test_mutation_blocked_without_brief(),
              test_mutation_blocked_when_unreviewed_then_allowed_on_approve(),
              test_revise_blocks_and_injects_feedback(), test_never_deadlocks_after_max_rounds(),
              test_disabled_flag_is_noop()])
    print("\nALL PASS" if ok else "\nFAILURES")
    sys.exit(0 if ok else 1)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python tests/test_strategy_gate.py`
Expected: FAIL — the strategy gate isn't in `_pre_tool_gates` yet (mutation returns `None`).

- [ ] **Step 3: Write minimal implementation**

In `agent.py`, extend the reviewer import (line 57):

```python
from tools.reviewer import run_review, run_strategy_review
```

In `_pre_tool_gates`, insert the strategy gate immediately AFTER the replan-gate block (after line 3059, before the `# Plan-and-execute gate` comment):

```python
        # Diagnosis-phase gate: before CHANGING the workspace, require a complete
        # Strategic Brief that has passed one independent strategy review. Reads are
        # never gated (recon stays free), so a read-only run can never deadlock here.
        if s.get("strategy_brief_enabled") and tool_name in MUTATING_TOOLS:
            brief = strategy.get_active()
            if brief is None or not brief.required_present():
                self._emit({"type": "system", "content": (
                    "About to change the workspace with no diagnosed strategy yet — asking for a "
                    "Strategic Brief first.")})
                s["messages"].append({"role": "user", "content": (
                    "[SYSTEM] STRATEGIC BRIEF REQUIRED before changing the workspace. You've done recon; "
                    "now synthesize it: call strategy_set with the goal, the diagnosis (each protection "
                    "with a file:line/symbol evidence pointer), and the chosen strategy (plus rationale, "
                    "rejected alternatives, and kill-criteria if you can). It will be independently reviewed "
                    "before your first change. Read/inspection tools remain free.")})
                return "continue"
            if not brief.reviewed:
                return self._run_strategy_review_gate(s, brief)
```

Add the gate method next to `_run_review_gate` (after line 3457):

```python
    def _run_strategy_review_gate(self, s, brief):
        """Independently review the Strategic Brief before the first mutation. On
        approve, mark it reviewed and return None (let the mutation proceed). On
        revise, inject the reviewer's feedback and return "continue" so the worker
        fixes the brief. Bounded by MAX_STRATEGY_REVIEW_ROUNDS — after the cap it
        forces the brief through (reviewed=True) so the gate can never deadlock."""
        if s.get("strategy_review_rounds", 0) >= MAX_STRATEGY_REVIEW_ROUNDS:
            brief.reviewed = True
            strategy.notify_updated()
            return None
        self._emit({"type": "system", "content": (
            "Independent strategy reviewer pressure-testing the brief (diagnosis, better-strategy, order)…")})
        ctx_parts = []
        _plan = planning.get_active_plan()
        if _plan is not None:
            ctx_parts.append("CURRENT PLAN:\n" + _plan.to_markdown())
        _inv = investigation.get_active()
        if _inv is not None and not _inv.is_empty():
            ctx_parts.append("INVESTIGATION MEMORY:\n" + _inv.to_markdown())
        ctx = "\n\n".join(ctx_parts)
        try:
            verdict = run_strategy_review(brief.to_markdown(), task=s.get("original_task") or "",
                                          extra_context=ctx, max_steps=REVIEW_MAX_STEPS)
        except Exception as e:
            verdict = {"approved": True, "summary": f"strategy review skipped ({e})", "feedback": ""}
        self._emit({"type": "strategy_review",
                    "verdict": "approve" if verdict.get("approved") else "revise",
                    "summary": verdict.get("summary", ""),
                    "unsupported_claims": verdict.get("unsupported_claims", []),
                    "contradictions": verdict.get("contradictions", []),
                    "incomplete_work": verdict.get("incomplete_work", []),
                    "required_actions": verdict.get("required_actions", [])})
        if verdict.get("approved"):
            brief.reviewed = True
            strategy.notify_updated()
            self._emit({"type": "system", "content": (
                f"Strategy approved: {verdict.get('summary', '')}")})
            return None
        s["strategy_review_rounds"] = s.get("strategy_review_rounds", 0) + 1
        s["messages"].append({"role": "user", "content": (
            verdict.get("feedback") or "[STRATEGY REVIEWER] Revise the brief before changing anything.")})
        return "continue"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python tests/test_strategy_gate.py`
Expected: `ALL PASS`.

- [ ] **Step 5: Confirm the existing gate behavior is intact**

Run: `python tests/test_review_gate.py && python tests/test_autonomous_loop.py`
Expected: PASS (the replan gate, plan gate, and repeat-failure guard are unchanged; the strategy gate is additive and flag-gated).

- [ ] **Step 6: Commit**

```bash
git add agent.py tests/test_strategy_gate.py
git commit -m "feat(strategy): diagnosis-phase gate blocks mutations until a reviewed brief exists"
```

---

### Task 6: subagent context slice — align delegated work without leaking the brief

**Files:**
- Modify: `agent.py` — `_compose_delegate_context` (lines 1506-1515)
- Test: `tests/test_strategy_delegate_slice.py`

**Interfaces:**
- Consumes: `strategy.get_active`, `self.session["strategy_brief_enabled"]`.
- Produces: `_compose_delegate_context(plan)` appends exactly two lines — `Chosen strategy: <strategy>` and `Current top hypothesis: <hypothesis>` — only when the flag is on AND a non-empty brief exists; never the diagnosis/rejected/kill-criteria/reviewed state. Off/empty → output unchanged from today.

- [ ] **Step 1: Write the failing test**

Create `tests/test_strategy_delegate_slice.py`:

```python
"""The delegate context carries only a two-line strategy slice — never the full
brief — and only when the flag is on with a non-empty brief.

Run: python tests/test_strategy_delegate_slice.py
"""
import sys as _sys, os as _os
_sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))

import sys
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import strategy, planning
import tools  # noqa: F401
from agent import AgentApi


def _api(flag):
    api = AgentApi.__new__(AgentApi)
    api.session = {"strategy_brief_enabled": flag}
    return api


def _brief():
    b = strategy.StrategicBrief()
    b.set(goal="bypass root", diagnosis=[{"claim": "RootBeer", "evidence": "R.smali:42"}],
          strategy="frida first, then static", rejected=["blind static patch"],
          hypothesis="native probe in libcheck.so", kill_criteria=["no frida effect after 2 tries"])
    strategy.set_active_brief(b, notify=False)


def _reset():
    strategy.set_context(None, None); strategy.clear_active_brief(notify=False)


def test_slice_present_and_bounded():
    _reset(); _brief()
    p = planning.Plan("bypass root")
    ctx = _api(True)._compose_delegate_context(p)
    assert "Chosen strategy: frida first, then static" in ctx
    assert "Current top hypothesis: native probe in libcheck.so" in ctx
    # never leak the internal fields
    assert "RootBeer" not in ctx and "R.smali:42" not in ctx
    assert "blind static patch" not in ctx and "Kill-criteria" not in ctx
    _reset()
    print("OK: two-line slice present; internals not leaked.")
    return True


def test_off_and_empty_add_nothing():
    _reset(); _brief()
    p = planning.Plan("bypass root")
    off = _api(False)._compose_delegate_context(p)
    assert "Chosen strategy" not in off
    _reset()
    strategy.set_active_brief(strategy.StrategicBrief(), notify=False)  # empty
    empty = _api(True)._compose_delegate_context(p)
    assert "Chosen strategy" not in empty
    _reset()
    print("OK: flag off or empty brief -> no slice added.")
    return True


if __name__ == "__main__":
    ok = all([test_slice_present_and_bounded(), test_off_and_empty_add_nothing()])
    print("\nALL PASS" if ok else "\nFAILURES")
    sys.exit(0 if ok else 1)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python tests/test_strategy_delegate_slice.py`
Expected: FAIL — no strategy slice in the delegate context.

- [ ] **Step 3: Write minimal implementation**

In `agent.py`, replace `_compose_delegate_context` (lines 1506-1515) so it appends the slice before returning:

```python
    def _compose_delegate_context(self, plan):
        bits = [f"Overall mission: {plan.task}"]
        if plan.success_criteria:
            bits.append("Success criteria: " + "; ".join(plan.success_criteria))
        if plan.constraints:
            bits.append("Constraints: " + "; ".join(plan.constraints))
        cur = plan.current_phase()
        if cur:
            bits.append(f"Current phase: {cur['title']}")
        # A minimal read-only slice of the Strategic Brief so a delegated subagent
        # pulls in the orchestrator's direction — NEVER the full brief (no diagnosis
        # internals, rejected alternatives, or kill-criteria) and never any strategy_*
        # tool. Subagents execute a scoped task; they do not re-strategize.
        if self.session and self.session.get("strategy_brief_enabled"):
            brief = strategy.get_active()
            if brief is not None and not brief.is_empty():
                if brief.strategy:
                    bits.append("Chosen strategy: " + brief.strategy)
                if brief.hypothesis:
                    bits.append("Current top hypothesis: " + brief.hypothesis)
        return "\n".join(bits)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python tests/test_strategy_delegate_slice.py`
Expected: `ALL PASS`.

- [ ] **Step 5: Confirm delegation is intact**

Run: `python tests/test_delegation.py && python tests/test_subagents.py`
Expected: PASS (the slice is additive and flag-gated; subagent tool surfaces already exclude `strategy_*`).

- [ ] **Step 6: Commit**

```bash
git add agent.py tests/test_strategy_delegate_slice.py
git commit -m "feat(strategy): two-line read-only brief slice in delegate context (no leak, flag-gated)"
```

---

### Task 7: keep the brief honest — re-synthesis triggers + kill-criteria reminder

**Files:**
- Modify: `agent.py` — phase-change reconcile (near line 2945-2950), after-N-findings nudge (post-tool bookkeeping), kill-criteria reminder (repeat-failure guard, lines 3104-3119)
- Test: `tests/test_strategy_resync.py`

**Interfaces:**
- Consumes: `strategy.get_active`, `strategy.notify_updated`, `STRATEGY_RESYNC_FINDINGS`, session `findings_since_brief_sync`.
- Produces: three additive, flag-gated behaviors —
  1. On `plan_advance_phase`: if enabled and a non-empty brief exists, set `brief.reviewed=False`, `notify_updated()`, and inject a reconcile nudge (so it is re-reviewed before the next mutation).
  2. On a successful `record_finding`: increment `findings_since_brief_sync`; at `>= STRATEGY_RESYNC_FINDINGS`, inject a reconcile nudge and reset the counter.
  3. In the repeat-failure guard: if enabled and the brief has `kill_criteria`, append a kill-criteria reminder line to that existing nudge.

- [ ] **Step 1: Write the failing test**

Create `tests/test_strategy_resync.py`:

```python
"""Re-synthesis triggers keep the brief honest: phase advance re-opens it for
review, N findings prompt a reconcile, and a stall reminds of kill-criteria.

Run: python tests/test_strategy_resync.py
"""
import sys as _sys, os as _os
_sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))

import sys
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import strategy
import tools  # noqa: F401
import agent as agentmod
from agent import AgentApi


def _api():
    api = AgentApi.__new__(AgentApi)
    api._stop = False
    api.session = {"strategy_brief_enabled": True, "findings_since_brief_sync": 0,
                   "strategy_review_rounds": 0, "messages": [], "evidence_guards": True,
                   "failed_sigs": {}, "failed_sig_warned": set()}
    api._emit = lambda ev: None
    return api


def _brief(reviewed=True, kill=None):
    b = strategy.StrategicBrief()
    b.set(goal="g", diagnosis="d", strategy="s", kill_criteria=kill or [])
    b.reviewed = reviewed
    strategy.set_active_brief(b, notify=False)
    return b


def _reset():
    strategy.set_context(None, None); strategy.clear_active_brief(notify=False)


def test_findings_trigger_reconcile():
    _reset(); _brief()
    api = _api()
    for _ in range(agentmod.STRATEGY_RESYNC_FINDINGS - 1):
        api._note_finding_for_brief()
    assert not any("reconcile" in m["content"].lower() for m in api.session["messages"])
    api._note_finding_for_brief()   # Nth finding
    assert any("reconcile" in m["content"].lower() for m in api.session["messages"])
    assert api.session["findings_since_brief_sync"] == 0
    _reset()
    print("OK: N findings trigger a reconcile nudge and reset the counter.")
    return True


def test_phase_advance_reopens_review():
    _reset(); b = _brief(reviewed=True)
    api = _api()
    api._reconcile_brief_on_phase_change()
    assert b.reviewed is False
    assert any("STRATEGIC BRIEF" in m["content"] for m in api.session["messages"])
    _reset()
    print("OK: phase advance re-opens the brief for review.")
    return True


def test_kill_criteria_reminder_on_repeat_failure():
    _reset(); _brief(kill=["frida hook has no effect after 2 tries"])
    api = _api()
    fsig = ("apply_patch", "{}")
    api.session["failed_sigs"] = {fsig: True}
    out = api._pre_tool_gates(api.session, "apply_patch", {}, adaptive=True, is_plan_tool=False)
    assert out == "continue"
    assert any("kill-criteri" in m["content"].lower() for m in api.session["messages"])
    _reset()
    print("OK: a repeat failure reminds of the brief's kill-criteria.")
    return True


if __name__ == "__main__":
    ok = all([test_findings_trigger_reconcile(), test_phase_advance_reopens_review(),
              test_kill_criteria_reminder_on_repeat_failure()])
    print("\nALL PASS" if ok else "\nFAILURES")
    sys.exit(0 if ok else 1)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python tests/test_strategy_resync.py`
Expected: FAIL — `_note_finding_for_brief` / `_reconcile_brief_on_phase_change` don't exist; no kill-criteria reminder.

- [ ] **Step 3: Write minimal implementation**

In `agent.py`, add two helper methods (place them right after `_run_strategy_review_gate`):

```python
    def _reconcile_brief_on_phase_change(self):
        """A phase advance is a natural re-synthesis point: re-open the Strategic
        Brief for an independent review (it will re-fire before the next mutation)
        and nudge the worker to reconcile it against the new evidence."""
        s = self.session
        if not s.get("strategy_brief_enabled"):
            return
        brief = strategy.get_active()
        if brief is None or brief.is_empty():
            return
        brief.reviewed = False
        strategy.notify_updated()
        s["messages"].append({"role": "user", "content": (
            "[SYSTEM] Phase advanced — reconcile your STRATEGIC BRIEF with what you've now established "
            "(strategy_update): is the diagnosis still right, and is this still the best strategy? It will "
            "be independently re-reviewed before your next change.")})

    def _note_finding_for_brief(self):
        """Count a new confirmed finding; every STRATEGY_RESYNC_FINDINGS, nudge a
        brief reconcile so the thesis keeps up with accumulating evidence."""
        s = self.session
        if not s.get("strategy_brief_enabled"):
            return
        brief = strategy.get_active()
        if brief is None or brief.is_empty():
            return
        s["findings_since_brief_sync"] = s.get("findings_since_brief_sync", 0) + 1
        if s["findings_since_brief_sync"] >= STRATEGY_RESYNC_FINDINGS:
            s["findings_since_brief_sync"] = 0
            s["messages"].append({"role": "user", "content": (
                "[SYSTEM] Several new findings since your last strategy sync — reconcile the STRATEGIC "
                "BRIEF (strategy_update): confirm the diagnosis and top hypothesis still hold, and adjust "
                "the strategy if the evidence has moved.")})
```

Wire the phase-change reconcile — in the block at line 2945, add the call right after the plugin hook fires:

```python
            if tool_name == "plan_advance_phase" and not tool_failed:
                self._maybe_reground(force=True)
                # Let plugins react to the milestone (e.g. a checkpoint/verify hook).
                _plan = planning.get_active_plan()
                _phase = (_plan.current_phase() or {}).get("title", "") if _plan else ""
                self._fire_plugin_hooks("on_phase_change", phase=_phase)
                self._reconcile_brief_on_phase_change()
```

Wire the findings counter — in the same plan-tool bookkeeping branch (the `if is_plan_tool:` side handles plan tools; `record_finding` is an investigation tool, so it falls to the `else` at line 2951). Add, at the very top of that `else:` block (right before `s["tools_since_plan_touch"] = ...`):

```python
            if tool_name == "record_finding" and not tool_failed:
                self._note_finding_for_brief()
```

Add the kill-criteria reminder — in the repeat-failure guard, extend the injected message (lines 3112-3118). Replace the `s["messages"].append({...})` call there with:

```python
                _kc_line = ""
                if s.get("strategy_brief_enabled"):
                    _b = strategy.get_active()
                    if _b is not None and _b.kill_criteria:
                        _kc_line = ("\nCheck your brief's kill-criteria — if one is now met, abandon this "
                                    "strategy (strategy_update) instead of retrying: "
                                    + "; ".join(_b.kill_criteria))
                s["messages"].append({"role": "user", "content": (
                    f"[SYSTEM] You already ran '{tool_name}' with these EXACT arguments earlier "
                    "in this run and it FAILED. Don't blindly repeat it. Either change the "
                    "approach, or — if you now have NEW evidence it should work — record that "
                    "evidence (record_finding) and note why this attempt differs, then proceed. "
                    "If it's a genuine dead end, log it with record_failed_attempt and switch "
                    "strategy." + _kc_line)})
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python tests/test_strategy_resync.py`
Expected: `ALL PASS`.

- [ ] **Step 5: Re-run the gate test to confirm the guard still passes cleanly**

Run: `python tests/test_strategy_gate.py`
Expected: `ALL PASS` (the repeat-failure guard change is additive; `strategy_gate` tests set `evidence_guards=False` so they're unaffected).

- [ ] **Step 6: Commit**

```bash
git add agent.py tests/test_strategy_resync.py
git commit -m "feat(strategy): re-synthesis triggers (phase + findings) + kill-criteria reminder"
```

---

### Task 8: full regression sweep + docs

**Files:**
- Modify: `AGENTS.md` (document the Strategic Brief under the context/memory architecture section)
- No code changes beyond docs.

- [ ] **Step 1: Run the full offline workflow suite**

Run:
```bash
cd "/Users/berat/Desktop/Omni Apps/omni-agent"
for t in test_strategy_brief test_strategy_tools test_strategy_prompt test_strategy_review \
         test_strategy_gate test_strategy_delegate_slice test_strategy_resync \
         test_investigation_memory test_reviewer test_review_gate test_tool_arg_validation \
         test_autonomous_loop test_tool_limits test_progressive_tools test_context_editing \
         test_prompt_integration test_subagents test_delegation test_skill_toolsets \
         test_plugins test_plugin_hooks_wired test_command_surface; do
  echo "=== $t ==="; python "tests/$t.py" || echo "FAILED: $t";
done
```
Expected: every listed test prints `ALL PASS` / `OK` with no `FAILED:` lines. (If `test_registration_binding` or `test_deep_build` are run and fail, that's the pre-existing baseline noted in FRAMEWORK_UPGRADE.md, unrelated to this change — do not run them as gates.)

- [ ] **Step 2: Prove OFF is inert end-to-end**

Run this ad-hoc check:
```bash
python -c "
import strategy, tools, agent as a
from agent import AgentApi
from subagents import AgentDef, resolve_allowed_tools
# a widest write subagent never gets strategy tools
w = AgentDef('w','impl',mode='write',toolsets=['apk','native','smali','emulator','frida'])
al = resolve_allowed_tools(w)
assert 'strategy_set' not in al and 'strategy_update' not in al
# flag-off prompt has no strategy footprint
api = AgentApi.__new__(AgentApi)
api.session={'base_system_prompt':'B.','active_toolsets':set(),'native_tools':False,
             'strategy_brief_enabled':False,'messages':[{'role':'system','content':''}]}
api._refresh_system_prompt()
c = api.session['messages'][0]['content']
assert 'STRATEGIC BRIEF' not in c and 'strategy_set' not in c
print('OFF is inert: no strategy tools to subagents, no prompt footprint.')
"
```
Expected: `OFF is inert: ...`.

- [ ] **Step 3: Document the feature**

In `AGENTS.md`, under the "Context & memory architecture" section, add a paragraph:

```markdown
**Strategic Brief** (`strategy.py`, `tools/strategy_tools.py`) — a synthesized,
always-pinned thesis (goal / protection diagnosis with evidence / chosen strategy
+ rationale / rejected alternatives / top hypothesis / kill-criteria) that shapes
decisions where the passive plan + investigation memory did not. The model authors
it with `strategy_set` / `strategy_update`; it pins at the TOP of the system prompt
(above the plan and investigation memory). A diagnosis-phase gate blocks *mutating*
tools until a complete brief passes one independent **strategy review**
(`tools/reviewer.run_strategy_review`, reusing the reviewer engine); reads are never
gated. Phase advances and every Nth finding nudge a reconcile; a stall reminds of the
brief's kill-criteria. It is single-writer orchestrator state — subagents get only a
two-line read-only slice (chosen strategy + top hypothesis) and never the `strategy_*`
tools (they're in `tool_policy.SUBAGENT_EXCLUDED`), so parallel waves are unaffected.
Behind `strategy_brief_enabled` (default on); off is byte-identical to a pre-feature
build. Offline tests: `tests/test_strategy_*.py`.
```

- [ ] **Step 4: Commit**

```bash
git add AGENTS.md
git commit -m "docs(strategy): document the Strategic Brief in AGENTS.md; regression sweep green"
```

---

## Self-Review

**Spec coverage:**
- Artifact & module (`strategy.py`, single-writer) → Task 1. ✓
- Model-written via `strategy_set`/`strategy_update` → Task 2. ✓
- Diagnosis-phase gate (mutating only) → Task 5. ✓
- Adversarial strategy review reusing reviewer machinery → Task 4 (engine) + Task 5 (gate wiring). ✓
- Re-synthesis triggers (phase + N findings) → Task 7. ✓
- Kill-criteria checks tied to existing stall signals → Task 7. ✓
- Pinned at top of prompt above plan/investigation → Task 3. ✓
- Subagent single-writer + two-line slice + no `strategy_*` tools → Tasks 2 (exclusion) + 6 (slice). ✓
- Strategy reviewer is an isolated read-only subagent → Task 4 (built on the reviewer's read-only engine). ✓
- Compatibility: flag-gated, byte-identical off, `get_tool_prompt(active_groups=None)` untouched, no new lock → Tasks 2/3 (`hidden_groups`, full-render path unchanged) + Task 8 (proof). ✓
- Config knobs (`strategy_brief_enabled`, N=5, review round cap) → Task 3 constants. ✓
- Testing mirrors `test_investigation_memory`/`test_reviewer` + regression row → Tasks 1-7 + Task 8. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; no "similar to Task N". ✓

**Type consistency:** `strategy.get_active()` (not `get_active_brief`) used everywhere; `StrategicBrief.set(...)`, `.required_present()`, `.is_empty()`, `.reviewed`, `.to_markdown()` consistent across Tasks 1-7; `run_strategy_review(brief_markdown, task, extra_context, max_steps)` signature matches its call in Task 5; `_run_strategy_review_gate(s, brief)` and helper method names match their tests; session flags `strategy_brief_enabled` / `strategy_review_rounds` / `findings_since_brief_sync` consistent; `hidden_groups` threaded identically through `get_tool_prompt` and `render_tools_section`. ✓
