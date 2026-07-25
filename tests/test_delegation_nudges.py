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
