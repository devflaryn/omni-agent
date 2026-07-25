import agent as agent_mod


class _Stub:
    """Minimal stand-in exposing only what the nudge methods touch."""
    _maybe_nudge_delegation = agent_mod.AgentApi._maybe_nudge_delegation


def _sess():
    return {"messages": [], "solo_read_streak": 0, "_solo_read_nudged": False}


def _sys_msgs(s):
    return [m for m in s["messages"] if m["content"].startswith("[SYSTEM]")]


def test_streak_nudge_fires_at_threshold():
    s, a = _sess(), _Stub()
    for _ in range(agent_mod.SOLO_READ_NUDGE):
        a._maybe_nudge_delegation(s, "read_file_chunk")
    msgs = _sys_msgs(s)
    assert len(msgs) == 1
    assert "dispatch_agents" in msgs[0]["content"]


def test_streak_nudge_fires_only_once_per_streak():
    s, a = _sess(), _Stub()
    for _ in range(agent_mod.SOLO_READ_NUDGE * 3):
        a._maybe_nudge_delegation(s, "grep_directory")
    assert len(_sys_msgs(s)) == 1


def test_delegation_resets_the_streak_and_rearms():
    s, a = _sess(), _Stub()
    for _ in range(agent_mod.SOLO_READ_NUDGE):
        a._maybe_nudge_delegation(s, "read_file_chunk")
    assert len(_sys_msgs(s)) == 1
    a._maybe_nudge_delegation(s, "dispatch_agents")
    assert s["solo_read_streak"] == 0
    for _ in range(agent_mod.SOLO_READ_NUDGE):
        a._maybe_nudge_delegation(s, "read_file_chunk")
    assert len(_sys_msgs(s)) == 2


def test_non_readonly_tools_do_not_advance_the_streak():
    s, a = _sess(), _Stub()
    for _ in range(agent_mod.SOLO_READ_NUDGE * 2):
        a._maybe_nudge_delegation(s, "write_file")
    assert s["solo_read_streak"] == 0
    assert _sys_msgs(s) == []


def test_zero_threshold_disables_the_nudge(monkeypatch):
    monkeypatch.setattr(agent_mod, "SOLO_READ_NUDGE", 0)
    s, a = _sess(), _Stub()
    for _ in range(20):
        a._maybe_nudge_delegation(s, "read_file_chunk")
    assert _sys_msgs(s) == []


import planning


class _PlanStub:
    def __init__(self, items, phase="p1"):
        self.items = items
        self.current_phase_id = phase


def _step(sid, content, delegate="", status="pending", deps=None):
    return {"id": sid, "content": content, "delegate": delegate,
            "status": status, "phase_id": "p1", "depends_on": deps or []}


class _Stub2:
    _maybe_nudge_plan_delegation = agent_mod.AgentApi._maybe_nudge_plan_delegation


def _sess2():
    return {"messages": [], "_delegation_phase_nudged": set()}


def test_looks_like_research_accepts_investigation():
    assert agent_mod._looks_like_research(_step(1, "locate the root check"))
    assert agent_mod._looks_like_research(_step(2, "map the license flow"))


def test_looks_like_research_rejects_changes():
    assert not agent_mod._looks_like_research(_step(3, "patch the root check"))
    assert not agent_mod._looks_like_research(_step(4, "rebuild and sign the apk"))


def test_plan_nudge_fires_for_two_untagged_research_steps(monkeypatch):
    plan = _PlanStub([_step(1, "locate the root check"),
                      _step(2, "locate the signature check")])
    monkeypatch.setattr(planning, "get_active_plan", lambda: plan)
    s, a = _sess2(), _Stub2()
    a._maybe_nudge_plan_delegation(s)
    msgs = _sys_msgs(s)
    assert len(msgs) == 1
    assert "researcher@cheap" in msgs[0]["content"]
    assert "1, 2" in msgs[0]["content"]


def test_plan_nudge_fires_once_per_phase(monkeypatch):
    plan = _PlanStub([_step(1, "locate the root check"),
                      _step(2, "locate the signature check")])
    monkeypatch.setattr(planning, "get_active_plan", lambda: plan)
    s, a = _sess2(), _Stub2()
    a._maybe_nudge_plan_delegation(s)
    a._maybe_nudge_plan_delegation(s)
    assert len(_sys_msgs(s)) == 1


def test_plan_nudge_ignores_already_tagged_steps(monkeypatch):
    plan = _PlanStub([_step(1, "locate the root check", delegate="researcher"),
                      _step(2, "locate the signature check", delegate="researcher")])
    monkeypatch.setattr(planning, "get_active_plan", lambda: plan)
    s, a = _sess2(), _Stub2()
    a._maybe_nudge_plan_delegation(s)
    assert _sys_msgs(s) == []


def test_plan_nudge_ignores_dependent_steps(monkeypatch):
    plan = _PlanStub([_step(1, "locate the root check"),
                      _step(2, "locate the signature check", deps=[1])])
    monkeypatch.setattr(planning, "get_active_plan", lambda: plan)
    s, a = _sess2(), _Stub2()
    a._maybe_nudge_plan_delegation(s)
    assert _sys_msgs(s) == []


def test_plan_nudge_needs_two_candidates(monkeypatch):
    plan = _PlanStub([_step(1, "locate the root check"),
                      _step(2, "patch the root check")])
    monkeypatch.setattr(planning, "get_active_plan", lambda: plan)
    s, a = _sess2(), _Stub2()
    a._maybe_nudge_plan_delegation(s)
    assert _sys_msgs(s) == []


def test_plan_nudge_no_plan_is_safe(monkeypatch):
    monkeypatch.setattr(planning, "get_active_plan", lambda: None)
    s, a = _sess2(), _Stub2()
    a._maybe_nudge_plan_delegation(s)
    assert _sys_msgs(s) == []


def test_plan_nudge_advancing_phase_allows_fresh_nudge(monkeypatch):
    """A phase id already nudged must not suppress the nudge for a DIFFERENT
    phase id — this is what actually exercises the 'keyed by phase id' claim;
    a single-phase test can't distinguish 'once per phase' from 'once ever'."""
    plan = _PlanStub([_step(1, "locate the root check"),
                      _step(2, "locate the signature check")], phase="p1")
    monkeypatch.setattr(planning, "get_active_plan", lambda: plan)
    s, a = _sess2(), _Stub2()
    a._maybe_nudge_plan_delegation(s)
    assert len(_sys_msgs(s)) == 1

    plan.current_phase_id = "p2"
    for it in plan.items:
        it["phase_id"] = "p2"
    a._maybe_nudge_plan_delegation(s)
    assert len(_sys_msgs(s)) == 2


def test_plan_nudge_skips_completed_and_skipped_steps(monkeypatch):
    """DONE_STATUSES steps must not count toward the 2-candidate threshold —
    this is what actually exercises the planning.DONE_STATUSES import (not
    hardcoded strings) and would catch a status filter that was dropped."""
    plan = _PlanStub([_step(1, "locate the root check", status="completed"),
                      _step(2, "locate the signature check", status="skipped"),
                      _step(3, "locate the crash handler")])
    monkeypatch.setattr(planning, "get_active_plan", lambda: plan)
    s, a = _sess2(), _Stub2()
    a._maybe_nudge_plan_delegation(s)
    assert _sys_msgs(s) == []


class _Stub3:
    """Exercises the REAL call-site sequence from agent.py's per-tool handler
    (reset flag -> nudge #1 -> _plan_bookkeeping_after_tool -> nudge #2 gated
    on #1), unlike the direct single-method calls above."""
    _maybe_nudge_delegation = agent_mod.AgentApi._maybe_nudge_delegation
    _plan_bookkeeping_after_tool = agent_mod.AgentApi._plan_bookkeeping_after_tool
    _maybe_nudge_plan_delegation = agent_mod.AgentApi._maybe_nudge_plan_delegation

    def _maybe_dispatch_delegated_steps(self):
        pass


def _sess3():
    return {"messages": [], "solo_read_streak": 0, "_solo_read_nudged": False,
            "_delegation_phase_nudged": set(), "tools_since_plan_touch": 0,
            "_plan_touch_nudge_sent": False}


def test_plan_view_tripping_both_nudges_fires_only_one(monkeypatch):
    """plan_view is the one plan tool that's also READ-ONLY, so both nudge #1
    (solo-read streak) and nudge #2 (plan shape) can become eligible in the
    SAME turn. Mirrors the real call-site sequence in agent.py (reset the
    per-turn flag, run nudge #1, then plan bookkeeping which must gate
    nudge #2 on it) and asserts only ONE [SYSTEM] delegation lecture lands."""
    plan = _PlanStub([_step(1, "locate the root check"),
                      _step(2, "locate the signature check")])
    monkeypatch.setattr(planning, "get_active_plan", lambda: plan)
    s, a = _sess3(), _Stub3()
    s["solo_read_streak"] = agent_mod.SOLO_READ_NUDGE - 1  # this call trips it

    s["_delegation_nudge_fired_this_turn"] = False
    a._maybe_nudge_delegation(s, "plan_view")
    a._plan_bookkeeping_after_tool(s, "plan_view", False)

    msgs = _sys_msgs(s)
    assert len(msgs) == 1
    assert "dispatch_agents" in msgs[0]["content"]  # nudge #1 won; #2 was suppressed


def test_plan_view_nudge_2_fires_alone_when_1_does_not(monkeypatch):
    """Sanity check for the guard: when nudge #1 does NOT fire this turn (streak
    below threshold), nudge #2 must still fire normally on plan_view."""
    plan = _PlanStub([_step(1, "locate the root check"),
                      _step(2, "locate the signature check")])
    monkeypatch.setattr(planning, "get_active_plan", lambda: plan)
    s, a = _sess3(), _Stub3()

    s["_delegation_nudge_fired_this_turn"] = False
    a._maybe_nudge_delegation(s, "plan_view")  # streak=1, well below threshold
    a._plan_bookkeeping_after_tool(s, "plan_view", False)

    msgs = _sys_msgs(s)
    assert len(msgs) == 1
    assert "researcher@cheap" in msgs[0]["content"]  # nudge #2 fired


def test_plan_nudge_ignores_steps_missing_optional_keys(monkeypatch):
    """A step dict missing keys other than id/content/status/phase_id/delegate/
    depends_on (e.g. no 'action' or 'purpose') must not raise — exercises the
    'never raises on steps missing optional keys' safety requirement."""
    bare = {"id": 1, "content": "locate the root check", "status": "pending",
            "phase_id": "p1"}
    plan = _PlanStub([bare, _step(2, "locate the signature check")])
    monkeypatch.setattr(planning, "get_active_plan", lambda: plan)
    s, a = _sess2(), _Stub2()
    a._maybe_nudge_plan_delegation(s)
    assert len(_sys_msgs(s)) == 1
