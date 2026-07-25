import types
import planning
import agent as agent_mod


def _make_agent_with_plan(steps):
    """Build a real planning.Plan (parallel-by-default dispatch calls
    plan.ready_delegatable_steps(), which is phase-scoped and needs the real
    Plan machinery, not a bare items-list stub) with items matching the given
    (id, status, delegate) dicts, preserving caller-chosen ids."""
    a = agent_mod.AgentApi.__new__(agent_mod.AgentApi)   # bypass heavy __init__
    plan = planning.Plan("m")
    plan.set_phases(["work"])
    for st in steps:
        item = plan.add_item(st.get("desc", "task"), status=st.get("status", "pending"),
                              delegate=st.get("delegate"))
        item["id"] = st["id"]
    a.session = {"plan": plan, "dispatched_steps": set(), "messages": []}
    a._delegate_run_dir = None
    a._emitted = []
    a._emit = lambda ev: a._emitted.append(ev)
    a._compose_delegate_task = lambda step: step.get("desc", "task")
    a._compose_delegate_context = lambda plan: "ctx"
    a._folded = []
    a._fold_delegate_result = lambda plan, step, name, ad, res: (
        a._folded.append({"step": step["id"], "ok": res.get("ok"), "report": res.get("report")}),
        a._emitted.append({"type": "folded", "step": step["id"], "ok": res.get("ok")}),
    )
    return a, plan


def test_two_read_steps_run_as_one_wave(monkeypatch):
    calls = {"parallel": 0, "single": 0}

    def fake_parallel(specs, on_event=None):
        calls["parallel"] += 1
        return [{"ok": True, "agent": s["agent_def"].name, "report": "r", "steps": 1, "tokens": 5}
                for s in specs]

    def fake_single(ad, task, context="", run_dir=None, on_event=None):
        calls["single"] += 1
        return {"ok": True, "agent": ad.name, "report": "r", "steps": 1, "tokens": 5}

    monkeypatch.setattr(agent_mod.subagents, "run_subagents_parallel", fake_parallel)
    monkeypatch.setattr(agent_mod.subagents, "run_subagent", fake_single)

    read_ad = agent_mod.subagents.AgentDef(name="reader", system_prompt="x", mode="read", allowed_tools=set())
    monkeypatch.setattr(agent_mod.plugins, "get_registry",
                        lambda: types.SimpleNamespace(get_agent=lambda n: read_ad))

    steps = [
        {"id": "s1", "status": "in_progress", "delegate": "reader"},
        {"id": "s2", "status": "in_progress", "delegate": "reader"},
    ]
    a, plan = _make_agent_with_plan(steps)
    a._maybe_dispatch_delegated_steps()

    assert calls["parallel"] == 1
    assert calls["single"] == 0


def test_wave_level_exception_surfaces_every_read_step_as_failed(monkeypatch):
    """If run_subagents_parallel raises at the infrastructure level (e.g. pool-size
    lookup failing), every read step dispatched into that wave must still be folded
    as a failure — never left silently in_progress forever."""

    def fake_parallel_raises(specs, on_event=None):
        raise RuntimeError("active_key_pool() misconfigured")

    monkeypatch.setattr(agent_mod.subagents, "run_subagents_parallel", fake_parallel_raises)

    read_ad = agent_mod.subagents.AgentDef(name="reader", system_prompt="x", mode="read", allowed_tools=set())
    monkeypatch.setattr(agent_mod.plugins, "get_registry",
                        lambda: types.SimpleNamespace(get_agent=lambda n: read_ad))

    steps = [
        {"id": "s1", "status": "in_progress", "delegate": "reader"},
        {"id": "s2", "status": "in_progress", "delegate": "reader"},
    ]
    a, plan = _make_agent_with_plan(steps)
    a._maybe_dispatch_delegated_steps()

    folded_ids = {f["step"] for f in a._folded}
    assert folded_ids == {"s1", "s2"}, f"expected both steps folded as failed, got {a._folded}"
    assert all(f["ok"] is False for f in a._folded)


def test_split_delegate_parses_tier():
    assert agent_mod._split_delegate("researcher@cheap") == ("researcher", "cheap")
    assert agent_mod._split_delegate("  researcher @ CHEAP ") == ("researcher", "cheap")
    assert agent_mod._split_delegate("researcher") == ("researcher", None)
    assert agent_mod._split_delegate("researcher@") == ("researcher", None)
    assert agent_mod._split_delegate("") == ("", None)
    assert agent_mod._split_delegate(None) == ("", None)


def test_delegate_tier_reaches_write_subagent_call(monkeypatch):
    """End-to-end: a WRITE step tagged delegate="implementer@cheap" must reach
    run_subagent with tier="cheap" and the bare agent name "implementer" — not
    just split correctly in isolation. Would catch: forgetting to pass
    tier=tier into the run_subagent(...) call in the write loop."""
    captured = {}

    def fake_single(ad, task, context="", run_dir=None, tier=None):
        captured["name"] = ad.name
        captured["tier"] = tier
        return {"ok": True, "agent": ad.name, "report": "r", "steps": 1, "tokens": 5}

    monkeypatch.setattr(agent_mod.subagents, "run_subagent", fake_single)

    write_ad = agent_mod.subagents.AgentDef(name="implementer", system_prompt="x",
                                            mode="write", allowed_tools=set())
    monkeypatch.setattr(agent_mod.plugins, "get_registry",
                        lambda: types.SimpleNamespace(get_agent=lambda n: write_ad))

    steps = [{"id": "w1", "status": "in_progress", "delegate": "implementer@cheap"}]
    a, plan = _make_agent_with_plan(steps)
    a._maybe_dispatch_delegated_steps()

    assert captured["name"] == "implementer"
    assert captured["tier"] == "cheap"


def test_delegate_tier_reaches_read_wave_spec(monkeypatch):
    """End-to-end: a READ step tagged delegate="researcher@cheap" must produce a
    wave spec carrying tier="cheap" and agent_def named "researcher" — not just
    split correctly in isolation. Would catch: forgetting to thread tier into
    the dict spec built for run_subagents_parallel in _run_delegated_read_wave."""
    captured = {}

    def fake_parallel(specs, on_event=None):
        captured["specs"] = specs
        return [{"ok": True, "agent": s["agent_def"].name, "report": "r", "steps": 1, "tokens": 5}
                for s in specs]

    monkeypatch.setattr(agent_mod.subagents, "run_subagents_parallel", fake_parallel)

    read_ad = agent_mod.subagents.AgentDef(name="researcher", system_prompt="x", mode="read", allowed_tools=set())
    monkeypatch.setattr(agent_mod.plugins, "get_registry",
                        lambda: types.SimpleNamespace(get_agent=lambda n: read_ad))

    steps = [{"id": "r1", "status": "in_progress", "delegate": "researcher@cheap"}]
    a, plan = _make_agent_with_plan(steps)
    a._maybe_dispatch_delegated_steps()

    assert len(captured["specs"]) == 1
    spec = captured["specs"][0]
    assert spec["agent_def"].name == "researcher"
    assert spec["tier"] == "cheap"
