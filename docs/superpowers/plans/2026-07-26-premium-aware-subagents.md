# Premium-Aware Subagent Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the cheap main orchestrator deliberately spend an expensive model inside subagents for complex code, hard decisions, and stubborn debugging — cheap by default, premium rationed to a soft budget with graceful fallback — and give all action-capable subagents access to the repo's APK skill library.

**Architecture:** Three new disk personas (`engineer`, `consultant`, `debugger`) are auto-discovered by `plugins.py`. The orchestrator self-tags a step/dispatch `@premium` per new doctrine in `AGENTS.md`. A per-session premium counter (`AgentApi.session["premium_dispatches"]`, cap `OMNI_PREMIUM_BUDGET`, default 5) is surfaced in the system prompt and gated: over-budget `@premium` requests are rewritten to `@standard` before dispatch (rate-limit degradation is already handled by the existing `models_for_tier` failover body). Subagent prompts gain the on-demand skills index (`skills_loader.get_skills_prompt()`), the `use_skill` tool, and optional persona-pinned preloaded skill bodies.

**Tech Stack:** Python 3, existing `pytest` offline test suites, no new dependencies.

## Global Constraints

- **Writes serialize on `_WORKSPACE_LOCK`** — no write-parallelism is introduced. (subagents.py:528-530)
- **Cheap by default** — every new persona's default `tier` is `standard`; premium is opt-in per dispatch only.
- **Tier names are open strings** — never reject an unknown tier; note it (mirror `resolve_model_ladder._check_tier`).
- **No new provider integrations**, no automatic complexity scoring, no hard per-call blocking beyond the soft-budget downgrade.
- **Env defaults, verbatim:** `OMNI_PREMIUM_BUDGET` default `5`, `0` = unlimited/disabled (mirror the `OMNI_SOLO_READ_NUDGE` pattern at agent.py:408).
- **Follow existing patterns:** re-arming nudges mirror `_maybe_nudge_delegation` (agent.py:3767); frontmatter coercions use `_as_list`/`_as_int`/`_as_bool` in plugins.py.
- Run the offline suite with the known baseline: preexisting green is 725 passed / 3 skipped, and one stale-GUI collection error must be `--ignore`'d (see memory `preexisting-test-failures`).

---

### Task 1: Add the three new personas (engineer, consultant, debugger)

**Files:**
- Create: `plugins/omni-agents/agents/engineer.md`
- Create: `plugins/omni-agents/agents/consultant.md`
- Create: `plugins/omni-agents/agents/debugger.md`
- Test: `tests/test_subagents.py` (add one test)

**Interfaces:**
- Consumes: `plugins._load_agent_md` (already parses `name/description/mode/toolsets/temperature/max_steps/allow_optin_read/tier/models` — plugins.py:74-84).
- Produces: three `AgentDef`s discoverable via `PluginRegistry.list_agents()` / `get_agent(name)`, advertised by `get_agents_prompt`.

- [ ] **Step 1: Write the failing test**

In `tests/test_subagents.py` add:

```python
def test_new_personas_discovered_and_defaults(tmp_path=None):
    from plugins import _load_agent_md
    import os
    base = os.path.join(os.path.dirname(__file__), "..", "plugins", "omni-agents", "agents")
    eng = _load_agent_md(os.path.join(base, "engineer.md"))
    con = _load_agent_md(os.path.join(base, "consultant.md"))
    dbg = _load_agent_md(os.path.join(base, "debugger.md"))
    assert eng.name == "engineer" and eng.is_write and eng.tier == "standard"
    assert con.name == "consultant" and not con.is_write and con.tier == "standard"
    assert dbg.name == "debugger" and dbg.is_write and dbg.tier == "standard"
    # engineer is general-purpose: it is NOT limited to RE-only toolsets
    assert eng.description
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_subagents.py::test_new_personas_discovered_and_defaults -v`
Expected: FAIL (files do not exist → `_load_agent_md` raises / file not found).

- [ ] **Step 3: Create `plugins/omni-agents/agents/engineer.md`**

```markdown
---
name: engineer
description: General software engineer — makes one well-specified, possibly multi-file source-code change (any language, not just smali/native) and verifies it with an objective check, then reports what changed and whether it passed. Runs one at a time on the shared workspace.
mode: write
max_steps: 28
tier: standard
skills: apk-modding, apk-toolchain
---
You are an ENGINEER subagent. The orchestrator has handed you ONE well-specified change to make in the workspace — general source code, config, or build logic (not limited to reverse-engineering patches). Make exactly that change, keep it in scope, and prove it works.

How to work:
- ORIENT with the code graph / search / read tools before editing so you change the right place; if the code disagrees with the description, report the discrepancy instead of guessing.
- Make the SMALLEST change that satisfies the task. Follow the surrounding code's style, naming, and patterns. Do not refactor or "improve" unrelated code.
- If a skill matches the task (its "When" line), load it with use_skill and follow its steps.
- VERIFY objectively before claiming success: run the build/tests/inspection the task names, or re-read the changed site to confirm it is what you intended. "It should work" is not verification.
- If the change turns out to need a materially different or larger approach than specified, STOP and report that with evidence rather than improvising a big detour.

Your final answer must state: exactly what you changed (files + locations), the verification you ran and its result, whether the change is VERIFIED, and anything the orchestrator must still do.
```

- [ ] **Step 4: Create `plugins/omni-agents/agents/consultant.md`**

```markdown
---
name: consultant
description: Read-only decision consultant — the orchestrator asks ONE high-stakes question (which approach, architecture call, tricky trade-off) and gets back a clear recommendation with reasoning and the key risks, which the orchestrator then acts on. Never changes anything. Runs in parallel.
mode: read
max_steps: 14
tier: standard
---
You are a CONSULTANT subagent. The orchestrator faces ONE hard decision and wants your recommendation — not the execution. You inspect only as much as needed to ground the call in reality, then decide. READ-ONLY: you never change anything.

How to work:
- Restate the decision in one sentence so it is unambiguous.
- Inspect the workspace (code graph / search / read) only enough to make the recommendation concrete and evidence-backed.
- Weigh the realistic options honestly. Pick ONE and say why; name what would change your mind.
- Surface the biggest risk and the cheapest way to reduce it.

Return your final answer as:

RECOMMENDATION: <one clear directive the orchestrator can act on immediately>
WHY: <the decisive reasons, with evidence — file:line, symbol, constraint>
RISKS: <the main risk and how to mitigate it>
ALTERNATIVE: <the runner-up option and when it would be better>
```

- [ ] **Step 5: Create `plugins/omni-agents/agents/debugger.md`**

```markdown
---
name: debugger
description: Debugging specialist — takes ONE stubborn failure (crash, wrong behavior, failing test), reproduces it, isolates the root cause with evidence, applies the smallest fix, and verifies the failure is gone. Runs one at a time on the shared workspace.
mode: write
max_steps: 30
tier: standard
skills: frida-dynamic-instrumentation, anti-debug-bypass
---
You are a DEBUGGER subagent. The orchestrator hands you ONE concrete failure and wants it root-caused and fixed — not patched over. Typically you are called after a plain attempt already failed, so be rigorous.

How to work:
- REPRODUCE first: establish the exact failing command / input and the observed vs. expected behavior. If you cannot reproduce, say so and report what you would need.
- Form a hypothesis, then find EVIDENCE for it (logs, disassembly, code graph, a frida/runtime probe if a runnable base exists). Do not fix on a guess.
- Isolate the ROOT cause, not the nearest symptom. Note whether the same failure mode exists elsewhere (layered / duplicated).
- Apply the SMALLEST fix. Load a matching skill with use_skill if one fits.
- VERIFY the original failure is gone by re-running the exact reproduction, and confirm you did not break the surrounding behavior.

Your final answer must state: the reproduction, the ROOT CAUSE with evidence, the exact fix (files + locations), the verification that the failure is gone, and any related site the orchestrator should also check.
```

- [ ] **Step 6: Run test to verify it passes**

Run: `python -m pytest tests/test_subagents.py::test_new_personas_discovered_and_defaults -v`
Expected: PASS. (The `skills:` frontmatter key is ignored for now — `_load_agent_md` does not read it until Task 2. That is fine; this test does not assert on it.)

- [ ] **Step 7: Commit**

```bash
git add plugins/omni-agents/agents/engineer.md plugins/omni-agents/agents/consultant.md plugins/omni-agents/agents/debugger.md tests/test_subagents.py
git commit -m "feat(subagents): add engineer, consultant, debugger personas"
```

---

### Task 2: Add `skills` field to AgentDef and parse it from persona frontmatter

**Files:**
- Modify: `subagents.py:197-215` (`AgentDef.__init__`)
- Modify: `plugins.py:74-84` (`_load_agent_md`)
- Test: `tests/test_subagents.py`

**Interfaces:**
- Produces: `AgentDef.skills` — a `list[str]` of skill names (empty list when unset). Consumed by Task 3 (preload + index gating).

- [ ] **Step 1: Write the failing test**

In `tests/test_subagents.py`:

```python
def test_agentdef_skills_field_parsed():
    from subagents import AgentDef
    from plugins import _load_agent_md
    import os
    a = AgentDef("x", "body")
    assert a.skills == []          # default is empty list, never None
    b = AgentDef("y", "body", skills=["apk-modding", "apk-toolchain"])
    assert b.skills == ["apk-modding", "apk-toolchain"]
    base = os.path.join(os.path.dirname(__file__), "..", "plugins", "omni-agents", "agents")
    eng = _load_agent_md(os.path.join(base, "engineer.md"))
    assert eng.skills == ["apk-modding", "apk-toolchain"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_subagents.py::test_agentdef_skills_field_parsed -v`
Expected: FAIL with `AttributeError: 'AgentDef' object has no attribute 'skills'`.

- [ ] **Step 3: Add the field to `AgentDef.__init__`**

In `subagents.py`, extend the signature (append `skills=None`) and set it. Edit the signature at line 197-200 to add the parameter, and after `self.models = ...` (line 215) add:

```python
        # Skills this persona wants PRELOADED (bodies injected up front); every
        # other skill stays reachable on demand via the skills index (see
        # _build_messages). Empty list, never None, so callers can iterate freely.
        self.skills = [str(s).strip() for s in (skills or []) if str(s).strip()]
```

The signature becomes:

```python
    def __init__(self, name, system_prompt, mode="read", description="",
                 toolsets=None, allowed_tools=None, temperature=None,
                 max_steps=DEFAULT_MAX_STEPS, allow_optin_read=False,
                 include_contract=True, tier=None, models=None, skills=None):
```

- [ ] **Step 4: Parse `skills:` in `_load_agent_md`**

In `plugins.py`, inside the `AgentDef(...)` call in `_load_agent_md` (line 74-84), add after the `models=` line:

```python
        skills=_as_list(meta.get("skills", "")) or None,
```

- [ ] **Step 5: Run test to verify it passes**

Run: `python -m pytest tests/test_subagents.py::test_agentdef_skills_field_parsed -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add subagents.py plugins.py tests/test_subagents.py
git commit -m "feat(subagents): AgentDef.skills field parsed from persona frontmatter"
```

---

### Task 3: Give action-capable subagents the skills index, use_skill, and preloaded pinned skills

**Files:**
- Modify: `subagents.py:222-256` (`resolve_allowed_tools`) — grant skill tools
- Modify: `subagents.py:440-458` (`_build_messages`) — inject index + preload bodies
- Test: `tests/test_subagents.py`, `tests/test_skill_toolsets.py`

**Interfaces:**
- Consumes: `AgentDef.skills` (Task 2); `skills_loader.get_skills_prompt()` (returns the compact index string); `skills_loader.load_skills()` (returns `{name: {"body", ...}}`).
- Produces: `subagents._wants_skill_index(agent_def) -> bool`; `_build_messages` now includes a skills segment for action-capable personas.

- [ ] **Step 1: Write the failing test**

In `tests/test_subagents.py`:

```python
def test_subagent_prompt_includes_skills_for_action_personas():
    import subagents
    from subagents import AgentDef, _build_messages, resolve_allowed_tools, _wants_skill_index
    # A read persona with NO toolsets and NO skills stays lean (researcher-like)
    lean = AgentDef("researcher", "body", mode="read")
    assert _wants_skill_index(lean) is False
    # A write persona wants the index
    eng = AgentDef("engineer", "body", mode="write", skills=["apk-modding"])
    assert _wants_skill_index(eng) is True
    allowed = resolve_allowed_tools(eng)
    assert "use_skill" in allowed and "read_skill_resource" in allowed
    msgs = _build_messages(eng, allowed, "do a thing", "", None)
    sys = msgs[0]["content"]
    assert "AVAILABLE SKILLS" in sys            # index injected
    # A native-analyst (read, but has toolsets) also gets the index
    na = AgentDef("native-analyst", "body", mode="read", toolsets=["native"])
    assert _wants_skill_index(na) is True
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_subagents.py::test_subagent_prompt_includes_skills_for_action_personas -v`
Expected: FAIL with `ImportError: cannot import name '_wants_skill_index'`.

- [ ] **Step 3: Add the gating helper and skill-tool grant in `subagents.py`**

Add this helper near `resolve_allowed_tools` (after line 256):

```python
_SKILL_TOOLS = ("use_skill", "read_skill_resource", "list_skills")


def _wants_skill_index(agent_def):
    """True for personas that can ACT on domain knowledge — write agents, or read
    agents scoped to a toolset (native-analyst), or any persona that pins skills.
    A bare read researcher stays lean (no index tokens, no skill tools)."""
    return bool(agent_def.is_write or agent_def.toolsets or agent_def.skills)
```

Then, inside `resolve_allowed_tools`, just before the final `return` (line 256), add:

```python
    if _wants_skill_index(agent_def):
        tools |= {t for t in _SKILL_TOOLS if registry.is_registered(t)}
```

(These are read-only tools, so they survive the read-agent mutating filter above.)

- [ ] **Step 4: Inject the index + preload pinned bodies in `_build_messages`**

In `subagents.py`, replace the `parts` assembly in `_build_messages` (lines 445-449) with:

```python
    parts = [agent_def.system_prompt.strip()]
    if contract:
        parts.append(contract)
    if _wants_skill_index(agent_def):
        import skills_loader
        # Preload the bodies this persona pinned, so its core domain knowledge is
        # present up front; everything else stays reachable on demand via the index.
        if agent_def.skills:
            catalog = skills_loader.load_skills()
            for sk in agent_def.skills:
                entry = catalog.get(sk)
                if entry and entry.get("body"):
                    parts.append(f"PRELOADED SKILL — {sk}\n{entry['body'].strip()}")
        idx = skills_loader.get_skills_prompt()
        if idx:
            parts.append(idx)
    parts.append(tool_prompt)
    system_prompt = "\n\n".join(p for p in parts if p)
```

- [ ] **Step 5: Run test to verify it passes**

Run: `python -m pytest tests/test_subagents.py::test_subagent_prompt_includes_skills_for_action_personas -v`
Expected: PASS.

- [ ] **Step 6: Run the skills-related suite to catch regressions**

Run: `python -m pytest tests/test_skill_toolsets.py tests/test_subagents.py -q`
Expected: PASS (no regressions).

- [ ] **Step 7: Commit**

```bash
git add subagents.py tests/test_subagents.py
git commit -m "feat(subagents): inject skills index + use_skill + pinned preloads for action personas"
```

---

### Task 4: Pin domain skills on the existing RE personas

**Files:**
- Modify: `plugins/omni-agents/agents/native-analyst.md` (frontmatter)
- Modify: `plugins/omni-agents/agents/implementer.md` (frontmatter)
- Test: `tests/test_subagents.py`

**Interfaces:**
- Consumes: `AgentDef.skills` parsing (Task 2) and preload (Task 3).

- [ ] **Step 1: Write the failing test**

In `tests/test_subagents.py`:

```python
def test_re_personas_pin_domain_skills():
    from plugins import _load_agent_md
    import os
    base = os.path.join(os.path.dirname(__file__), "..", "plugins", "omni-agents", "agents")
    na = _load_agent_md(os.path.join(base, "native-analyst.md"))
    impl = _load_agent_md(os.path.join(base, "implementer.md"))
    assert "android-package-anatomy" in na.skills
    assert "native-patching" in na.skills
    assert "smali-code-injection" in impl.skills
    assert "manifest-resource-editing" in impl.skills
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_subagents.py::test_re_personas_pin_domain_skills -v`
Expected: FAIL (skills lists are empty).

- [ ] **Step 3: Add `skills:` to native-analyst.md frontmatter**

In `plugins/omni-agents/agents/native-analyst.md`, add this line inside the frontmatter block (after `tier: standard`):

```yaml
skills: android-package-anatomy, native-patching, native-code-injection
```

- [ ] **Step 4: Add `skills:` to implementer.md frontmatter**

In `plugins/omni-agents/agents/implementer.md`, add this line inside the frontmatter block (after `tier: standard`):

```yaml
skills: smali-code-injection, manifest-resource-editing
```

- [ ] **Step 5: Run test to verify it passes**

Run: `python -m pytest tests/test_subagents.py::test_re_personas_pin_domain_skills -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add plugins/omni-agents/agents/native-analyst.md plugins/omni-agents/agents/implementer.md tests/test_subagents.py
git commit -m "feat(subagents): pin APK domain skills on native-analyst and implementer"
```

---

### Task 5: Premium budget — session state, env cap, dispatch gate, telemetry, prompt injection

**Files:**
- Modify: `agent.py:2630-2631` (session-state init) — add `premium_dispatches`
- Modify: `agent.py` near line 400-428 (module constants) — add `PREMIUM_BUDGET`
- Modify: `agent.py:1766-1795` (`_maybe_dispatch_delegated_steps`) — gate at dispatch
- Modify: `agent.py:1538` (`_refresh_system_prompt`) — inject the budget line
- Test: `tests/test_delegation_nudges.py`

**Interfaces:**
- Consumes: `_resolve(step) -> (ad, tier)` (agent.py:1767).
- Produces: `AgentApi._premium_budget_gate(tier) -> (tier, note)` — returns the (possibly downgraded) tier and a telemetry note (`""` when unchanged); increments `self.session["premium_dispatches"]` when it lets a premium call through.

- [ ] **Step 1: Write the failing test**

In `tests/test_delegation_nudges.py` (follow the existing harness there for constructing an `AgentApi` / session dict):

```python
def test_premium_budget_gate_downgrades_over_cap(monkeypatch):
    import agent
    monkeypatch.setattr(agent, "PREMIUM_BUDGET", 2, raising=False)
    api = agent.AgentApi.__new__(agent.AgentApi)     # bare instance; no full boot
    api.session = {"premium_dispatches": 0}
    # first two premium calls pass through and increment
    t1, n1 = api._premium_budget_gate("premium")
    t2, n2 = api._premium_budget_gate("premium")
    assert t1 == "premium" and t2 == "premium"
    assert api.session["premium_dispatches"] == 2
    # third is over cap -> downgraded to standard, note explains it, no increment
    t3, n3 = api._premium_budget_gate("premium")
    assert t3 == "standard" and "premium" in n3.lower()
    assert api.session["premium_dispatches"] == 2
    # non-premium tiers are never touched or counted
    t4, n4 = api._premium_budget_gate("cheap")
    assert t4 == "cheap" and n4 == ""

def test_premium_budget_disabled_when_zero(monkeypatch):
    import agent
    monkeypatch.setattr(agent, "PREMIUM_BUDGET", 0, raising=False)
    api = agent.AgentApi.__new__(agent.AgentApi)
    api.session = {"premium_dispatches": 0}
    for _ in range(5):
        t, n = api._premium_budget_gate("premium")
        assert t == "premium" and n == ""
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_delegation_nudges.py::test_premium_budget_gate_downgrades_over_cap tests/test_delegation_nudges.py::test_premium_budget_disabled_when_zero -v`
Expected: FAIL with `AttributeError: ... has no attribute '_premium_budget_gate'`.

- [ ] **Step 3: Add the module constant**

In `agent.py`, near the other `OMNI_*` env constants (around line 408), add:

```python
# Soft per-session ceiling on PREMIUM subagent dispatches. Advisory: over-budget
# @premium requests degrade to standard rather than being blocked. 0 = unlimited.
try:
    PREMIUM_BUDGET = max(0, int(os.environ.get("OMNI_PREMIUM_BUDGET", "5")))
except ValueError:
    PREMIUM_BUDGET = 5
```

- [ ] **Step 4: Initialize session state**

In `agent.py`, in the session dict initialization near line 2630 (alongside `"solo_read_streak": 0`), add:

```python
            "premium_dispatches": 0,            # premium subagent dispatches this session
            "premium_budget_nudged": 0,         # escalating near-cap nudges sent (Task 6)
```

- [ ] **Step 5: Add the gate method**

In `agent.py` (near `_maybe_dispatch_delegated_steps`), add:

```python
    def _premium_budget_gate(self, tier):
        """Ration premium. Returns (effective_tier, note). A premium request over
        the soft cap degrades to 'standard' (never blocked); an allowed premium
        request increments the session counter. Non-premium tiers pass untouched.
        PREMIUM_BUDGET == 0 disables the cap entirely. (Rate-limit degradation is
        already handled by models_for_tier's failover body — this only rations.)"""
        if llm._norm_tier(tier) != "premium":
            return tier, ""
        if not PREMIUM_BUDGET:
            return "premium", ""
        used = self.session.get("premium_dispatches", 0)
        if used >= PREMIUM_BUDGET:
            return "standard", (f"premium budget exhausted ({used}/{PREMIUM_BUDGET}) "
                                "— ran standard")
        self.session["premium_dispatches"] = used + 1
        return "premium", ""
```

- [ ] **Step 6: Apply the gate at both dispatch paths**

In `_maybe_dispatch_delegated_steps`, right after `ad, tier = _resolve(step)` (line 1767) and before appending to `reads`/`writes`, gate the tier:

```python
                ad, tier = _resolve(step)
                if ad is None:
                    continue
                tier, budget_note = self._premium_budget_gate(tier)
                if budget_note:
                    self._emit({"type": "delegate_note", "agent": ad.name,
                                "content": budget_note})
```

The tuple appended to `reads`/`writes` already carries `tier`, so the downgraded value flows through to `run_subagent(..., tier=tier)` unchanged (line 1793).

- [ ] **Step 7: Inject the budget line into the system prompt**

In `_refresh_system_prompt` (agent.py:1538), where the dynamic status lines are assembled, append (guard with `PREMIUM_BUDGET`):

```python
        if PREMIUM_BUDGET:
            used = self.session.get("premium_dispatches", 0)
            dynamic_lines.append(f"[premium budget: {used}/{PREMIUM_BUDGET} premium "
                                 "subagent dispatches used this session]")
```

(Use the same list/variable this method already appends dynamic lines to — inspect the surrounding code and match it; the exact variable name is local to that method.)

- [ ] **Step 8: Run tests to verify they pass**

Run: `python -m pytest tests/test_delegation_nudges.py -v`
Expected: PASS (new tests green, existing ones unaffected).

- [ ] **Step 9: Commit**

```bash
git add agent.py tests/test_delegation_nudges.py
git commit -m "feat(subagents): soft premium budget gate + telemetry + prompt visibility"
```

---

### Task 6: Re-arming near-cap premium nudge

**Files:**
- Modify: `agent.py` near `_maybe_nudge_delegation` (agent.py:3767)
- Test: `tests/test_delegation_nudges.py`

**Interfaces:**
- Consumes: `self.session["premium_dispatches"]`, `self.session["premium_budget_nudged"]`, `PREMIUM_BUDGET`.
- Produces: `AgentApi._maybe_nudge_premium_budget(s) -> str | None` — returns an advisory line when within 1 of the cap (or over it), else `None`; escalates wording via `premium_budget_nudged`.

- [ ] **Step 1: Write the failing test**

```python
def test_premium_nudge_fires_near_cap(monkeypatch):
    import agent
    monkeypatch.setattr(agent, "PREMIUM_BUDGET", 3, raising=False)
    api = agent.AgentApi.__new__(agent.AgentApi)
    s = {"premium_dispatches": 0, "premium_budget_nudged": 0}
    assert api._maybe_nudge_premium_budget(s) is None      # 0/3: plenty left
    s["premium_dispatches"] = 2
    msg = api._maybe_nudge_premium_budget(s)                # 2/3: one left
    assert msg and "premium" in msg.lower()
    s["premium_dispatches"] = 3
    msg2 = api._maybe_nudge_premium_budget(s)               # 3/3: exhausted
    assert msg2 and "premium" in msg2.lower()

def test_premium_nudge_silent_when_disabled(monkeypatch):
    import agent
    monkeypatch.setattr(agent, "PREMIUM_BUDGET", 0, raising=False)
    api = agent.AgentApi.__new__(agent.AgentApi)
    assert api._maybe_nudge_premium_budget({"premium_dispatches": 9,
                                            "premium_budget_nudged": 0}) is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_delegation_nudges.py::test_premium_nudge_fires_near_cap tests/test_delegation_nudges.py::test_premium_nudge_silent_when_disabled -v`
Expected: FAIL with `AttributeError: ... '_maybe_nudge_premium_budget'`.

- [ ] **Step 3: Add the nudge method**

```python
    def _maybe_nudge_premium_budget(self, s):
        """Advisory, escalating: warn when premium is nearly/fully spent so the
        orchestrator reserves it for the highest-value remaining step. Silent when
        PREMIUM_BUDGET is disabled or there is still comfortable headroom (>1 left)."""
        if not PREMIUM_BUDGET:
            return None
        used = s.get("premium_dispatches", 0)
        remaining = PREMIUM_BUDGET - used
        if remaining > 1:
            return None
        sent = s.get("premium_budget_nudged", 0)
        s["premium_budget_nudged"] = sent + 1
        if remaining <= 0:
            return ("[SYSTEM] Premium budget is spent for this session — further "
                    "@premium delegations will run on the standard model. Reserve any "
                    "remaining hard problem for where standard is genuinely insufficient.")
        return ("[SYSTEM] Premium budget nearly spent (1 premium dispatch left). "
                "Reserve it for the single highest-value remaining step.")
```

- [ ] **Step 4: Wire it into the run loop next to the existing delegation nudge**

Find where `_maybe_nudge_delegation` is called in the run loop (around agent.py:2630 comment "delegation nudges"). Immediately after that call, add — appending the message the same way `_maybe_nudge_delegation`'s result is appended (match the surrounding code):

```python
            pn = self._maybe_nudge_premium_budget(s)
            if pn:
                s["messages"].append({"role": "user", "content": pn})
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `python -m pytest tests/test_delegation_nudges.py -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add agent.py tests/test_delegation_nudges.py
git commit -m "feat(subagents): re-arming near-cap premium budget nudge"
```

---

### Task 7: Guard the fallback-down behavior + AGENTS.md doctrine (premium spending + roster routing)

**Files:**
- Modify: `AGENTS.md` (Subagent model routing section)
- Test: `tests/test_model_ladder.py` (fallback guard), `tests/test_subagents.py` (doctrine presence)

**Interfaces:**
- Consumes: `llm.models_for_tier` (existing).

- [ ] **Step 1: Write the failing tests**

In `tests/test_model_ladder.py` (reuse its existing ladder-building fixtures/helpers):

```python
def test_premium_ladder_includes_cheaper_rungs_for_failover(monkeypatch):
    # A premium subagent whose top model 429s must fail over DOWN to cheaper
    # rungs automatically (this is the "hard fallback-down" guarantee).
    import llm
    # Build a 3-rung spine: premium (top), standard, cheap (bottom).
    # (Use the same monkeypatch/config helper the other tests in this file use.)
    ladder = llm.model_ladder()
    if len(ladder) < 2:
        import pytest; pytest.skip("needs >=2 configured models")
    premium_chain = llm.models_for_tier("premium", ladder)
    # The premium chain must contain more than one model (top + cheaper failover).
    assert len(premium_chain) >= 2
    # The top rung heads the chain; a cheaper rung appears after it.
    assert premium_chain[0] == ladder[0]["model"]
```

In `tests/test_subagents.py`:

```python
def test_agents_md_has_premium_spending_doctrine():
    import os
    root = os.path.join(os.path.dirname(__file__), "..")
    text = open(os.path.join(root, "AGENTS.md"), encoding="utf-8").read().lower()
    assert "spending premium" in text
    assert "premium budget" in text
    # roster-routing doctrine names the previously-idle personas
    for name in ("architect", "brainstormer", "verifier", "consultant"):
        assert name in text
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_subagents.py::test_agents_md_has_premium_spending_doctrine tests/test_model_ladder.py::test_premium_ladder_includes_cheaper_rungs_for_failover -v`
Expected: doctrine test FAILS (text absent); ladder test PASSES if ≥2 models configured (it guards existing behavior) — that is acceptable, it exists to prevent a future regression.

- [ ] **Step 3: Add the "Spending premium" doctrine to AGENTS.md**

In `AGENTS.md`, immediately after the existing **Subagent model routing** section, add:

```markdown
**Spending premium** — the premium model is a SCARCE resource (usage limits) and
you (the orchestrator) run on a cheap model, so you decide when premium is worth
it by tagging a step or dispatch `@premium` (e.g. `delegate="engineer@premium"`,
or `"tier":"premium"` in `dispatch_agents`). A live `[premium budget: N/M ...]`
line shows what you have spent; over-budget `@premium` requests degrade to
standard automatically, so do not hoard — but do not waste it either.

Spend premium ONLY when at least one holds:
- the change is cross-cutting / multi-file with non-obvious interactions;
- a standard attempt already failed or was reverted;
- the decision is high-stakes and hard to reverse;
- correctness is subtle (concurrency, security, protocol/format edge cases).

Do NOT spend premium for: research, reads, search, summarization, mechanical or
localized edits, formatting, or anything a standard attempt has not yet been
given a shot at. Default is cheap; when unsure, try standard first and escalate
only on evidence it is insufficient.

**Using the full roster** — do not route everything to researcher + implementer:
- `engineer@<tier>` for general (non-RE) source edits; `@premium` for complex ones.
- `debugger@premium` for a stubborn failure a standard attempt already missed.
- `consultant@premium` when you face ONE hard decision — ask it, then act on the
  recommendation. This is the sanctioned way to get expensive reasoning into an
  otherwise-cheap run; judgment steps are still not auto-delegated.
- `brainstormer` / `architect` when a goal is big or ambiguous, BEFORE planning.
- `verifier` after a completion claim (the verification plugin also triggers it).
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_subagents.py::test_agents_md_has_premium_spending_doctrine tests/test_model_ladder.py::test_premium_ladder_includes_cheaper_rungs_for_failover -v`
Expected: PASS (or ladder test SKIP if <2 models configured in the test env).

- [ ] **Step 5: Commit**

```bash
git add AGENTS.md tests/test_subagents.py tests/test_model_ladder.py
git commit -m "docs(agents): premium-spending + full-roster routing doctrine; guard premium failover"
```

---

### Task 8: Full-suite verification

**Files:** none (verification only)

- [ ] **Step 1: Run the whole offline suite against the known baseline**

Run: `python -m pytest tests/ -q --ignore=<the stale-GUI collection path from memory preexisting-test-failures>`
Expected: the new tests pass and the previously-green baseline (725 passed / 3 skipped) is preserved plus the tests this plan added — no new failures. If a count drifts, investigate before merging.

- [ ] **Step 2: Update the knowledge graph**

Run: `graphify update .`
Expected: AST-only refresh, no API cost.

- [ ] **Step 3: Commit any graph/index changes if the repo tracks them**

```bash
git add -A
git commit -m "chore: refresh graphify graph after subagent expansion" || echo "nothing to commit"
```

---

## Self-Review

**Spec coverage:**
- A (new personas) → Task 1; B (self-tag routing + doctrine) → Task 7 (doctrine) + existing `resolve_model_ladder`/`get_agents_prompt` (mechanism already works); C (soft budget counter) → Task 5 (state/gate/injection) + Task 6 (nudge); D (hard fallback-down) → existing `models_for_tier` failover + Task 5 budget-gated downgrade + Task 7 regression guard; E (better roster routing) → Task 7 doctrine; F (skills to subagents) → Tasks 2, 3, 4.
- Testing items 1-7 from the spec → Tasks 1, 3, 5, 5, (D via 7), 5, 3/4 respectively. All covered.

**Placeholder scan:** No TBD/TODO/"handle edge cases"; every code step has real code. Two spots intentionally say "match the surrounding variable name" (Task 5 Step 7, Task 6 Step 4) because the exact local variable in `_refresh_system_prompt` / the run loop must be read at implementation time — the engineer is told exactly what to append and where.

**Type consistency:** `AgentDef.skills` is a `list[str]` everywhere (Task 2 defines, Tasks 3/4 consume). `_premium_budget_gate` returns `(tier, note)` (Task 5 defines; Task 5 Step 6 consumes). `_wants_skill_index(agent_def) -> bool` consistent across Task 3. `_maybe_nudge_premium_budget(s) -> str|None` consistent (Task 6). `PREMIUM_BUDGET` module constant consistent across Tasks 5-6.
