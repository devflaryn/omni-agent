"""Offline tests for plan-driven delegation + the dispatch_agents fan-out.

No network/Docker. Plan-driven delegation is tested by driving the AgentApi
delegation methods directly with a stubbed subagent engine; the fan-out tool is
tested against the real engine with a scripted ask_llm.
"""
import sys as _sys, os as _os
_sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))

import threading

import agent
import planning
import investigation
import plugins
import subagents
import subagents as _subagents
import llm
from agent import AgentApi
from tools import delegation_tools
from tools.delegation_tools import dispatch_agents


def _bare_api(**session_over):
    api = AgentApi.__new__(AgentApi)
    api.emits = []
    api._emit = lambda e: api.emits.append(e)
    session = {
        "delegation_enabled": True,
        "dispatched_steps": set(),
        "messages": [],
        "unverified_change": None,
    }
    session.update(session_over)
    api.session = session
    return api


def _script(replies):
    box = {"i": 0}
    def fake(messages, temperature=0.3, **kw):
        i = box["i"]; box["i"] = min(i + 1, len(replies) - 1)
        return replies[i]
    return fake


def _final(text):
    return '{"type":"final_answer","content":"%s"}' % text


_ORIG_RUN_SUBAGENT = subagents.run_subagent


def _reset():
    planning.set_context(None)
    planning.clear_active_plan(notify=False)
    investigation.set_context(None)
    investigation.clear_active(notify=False)
    plugins.get_registry(reload=True)
    # Restore the real engine (the plan-driven tests stub it; the manual runner's
    # fake monkeypatch doesn't auto-revert like pytest's, so the fan-out tests that
    # need the real run_subagent must get it back).
    subagents.run_subagent = _ORIG_RUN_SUBAGENT


# --- plan-driven delegation --------------------------------------------------

def test_delegated_step_autodispatches_and_folds_report(monkeypatch):
    _reset()
    plan = planning.Plan("bypass the root check")
    plan.set_mission(success_criteria=["app launches on rooted device"])
    plan.set_phases(["Analyze"])
    step = plan.add_item("locate the root check", delegate="researcher", verification="file:line")
    plan.update_item(step["id"], status="in_progress")
    planning.set_active_plan(plan, notify=False)
    inv = investigation.ensure_active("bypass the root check")
    investigation.set_active(inv, notify=False)

    seen = {}
    def fake_run(agent_def, task, context="", run_dir=None, on_event=None, **kwargs):
        seen["agent"] = agent_def.name
        seen["task"] = task
        return {"agent": agent_def.name, "ok": True, "report": "root check at Root.smali:42",
                "artifacts": [], "verified": None, "steps": 3, "tools_used": []}
    monkeypatch.setattr(subagents, "run_subagent", fake_run)

    api = _bare_api()
    api._maybe_dispatch_delegated_steps()

    assert seen["agent"] == "researcher"
    assert "locate the root check" in seen["task"]
    # report folded into the MAIN context as a distilled message
    assert any("DELEGATE RESULT" in m["content"] and "Root.smali:42" in m["content"]
               for m in api.session["messages"])
    # step marked completed, dispatched-once tracked
    assert plan.find(step["id"])["status"] == "completed"
    assert step["id"] in api.session["dispatched_steps"]
    # persisted into durable investigation memory
    assert any("Root.smali:42" in f.get("text", "") for f in inv.data["findings"])


def test_delegated_write_sets_unverified_change(monkeypatch):
    _reset()
    plan = planning.Plan("patch the check")
    plan.set_phases(["Implement"])
    step = plan.add_item("force checkSig() true", delegate="implementer")
    plan.update_item(step["id"], status="in_progress")
    planning.set_active_plan(plan, notify=False)
    investigation.set_active(investigation.ensure_active("patch the check"), notify=False)

    monkeypatch.setattr(subagents, "run_subagent",
                        lambda ad, task, context="", run_dir=None, tier=None:
                        {"agent": ad.name, "ok": True, "report": "patched X.smali:10; verified via re-read",
                         "artifacts": [], "verified": True, "steps": 5, "tools_used": []})
    api = _bare_api()
    api._maybe_dispatch_delegated_steps()
    assert api.session["unverified_change"] and "implementer" in api.session["unverified_change"]
    assert plan.find(step["id"])["status"] == "completed"


def test_unknown_delegate_is_handled_not_crashed(monkeypatch):
    _reset()
    plan = planning.Plan("t")
    # Parallel-by-default dispatch reads ready_delegatable_steps(), which is
    # phase-scoped — a phase must be set for the step to be considered "in the
    # active phase" (sibling tests above already do this; this one predates it).
    plan.set_phases(["work"])
    step = plan.add_item("do a thing", delegate="does-not-exist")
    plan.update_item(step["id"], status="in_progress")
    planning.set_active_plan(plan, notify=False)
    api = _bare_api()
    api._maybe_dispatch_delegated_steps()
    assert any("no such subagent" in m["content"] for m in api.session["messages"])
    # step is NOT force-completed — the worker must handle it
    assert plan.find(step["id"])["status"] == "in_progress"


def test_delegation_disabled_does_nothing(monkeypatch):
    _reset()
    plan = planning.Plan("t")
    step = plan.add_item("x", delegate="researcher")
    plan.update_item(step["id"], status="in_progress")
    planning.set_active_plan(plan, notify=False)
    called = {"n": 0}
    monkeypatch.setattr(subagents, "run_subagent",
                        lambda *a, **k: called.__setitem__("n", called["n"] + 1) or {"ok": True, "report": "", "agent": "x"})
    api = _bare_api(delegation_enabled=False)
    api._maybe_dispatch_delegated_steps()
    assert called["n"] == 0 and not api.session["messages"]


# --- dispatch_agents fan-out -------------------------------------------------

def test_dispatch_agents_runs_read_wave_and_returns_reports():
    _reset()
    subagents.ask_llm = _script([_final("finding from the wave")])
    out = dispatch_agents(specs=[
        {"agent": "researcher", "task": "find the root check"},
        {"agent": "native-analyst", "task": "find the native guard"},
    ])
    text = out.get("stdout", "")
    assert "researcher" in text and "native-analyst" in text
    assert "finding from the wave" in text


def test_dispatch_agents_accepts_write_and_rejects_unknown():
    _reset()
    subagents.ask_llm = _script([_final("x")])
    out = dispatch_agents(specs=[
        {"agent": "implementer", "task": "patch it"},     # write -> accepted
        {"agent": "ghost", "task": "look"},               # unknown -> rejected
    ])
    assert "stdout" in out
    assert "implementer" in out["stdout"]
    assert "unknown agent 'ghost'" in out["stdout"]


def test_dispatch_agents_synthesize_merges():
    _reset()
    subagents.ask_llm = _script([_final("per-agent finding")])
    out = dispatch_agents(specs=[
        {"agent": "researcher", "task": "a"},
        {"agent": "researcher", "task": "b"},
    ], synthesize=True)
    assert "SYNTHESIZED SUMMARY" in out.get("stdout", "")


def test_dispatch_agents_forwards_tier_and_models(monkeypatch):
    captured = {}

    def fake_wave(specs, pool_size=None, run_dir=None, on_event=None):
        captured["specs"] = specs
        return [{"agent": "researcher", "ok": True, "report": "r", "steps": 1}
                for _ in specs]

    monkeypatch.setattr(delegation_tools, "run_subagents_parallel", fake_wave)
    ad = _subagents.AgentDef("researcher", "p", mode="read")
    monkeypatch.setattr(delegation_tools.plugins, "get_registry",
                        lambda: type("R", (), {"get_agent": staticmethod(lambda n: ad)})())
    out = delegation_tools.dispatch_agents([
        {"agent": "researcher", "task": "t1", "tier": "cheap"},
        {"agent": "researcher", "task": "t2", "models": ["glm"], "scope": ["src/**"]},
    ])
    assert "error" not in out
    assert captured["specs"][0]["tier"] == "cheap"
    assert captured["specs"][1]["models"] == ["glm"]
    assert captured["specs"][1]["scope"] == ["src/**"]


def test_ladder_hint_lists_configured_models(monkeypatch):
    monkeypatch.setattr(llm, "model_ladder", lambda: [
        {"rung": 0, "id": "c", "label": "L", "model": "kimi",
         "tier": "premium", "tagged": True},
        {"rung": 1, "id": "c", "label": "L", "model": "flash",
         "tier": "cheap", "tagged": False}])
    hint = delegation_tools._ladder_hint()
    assert "kimi" in hint and "premium" in hint
    assert "flash" in hint and "cheap" in hint


def test_ladder_hint_empty_when_unconfigured(monkeypatch):
    monkeypatch.setattr(llm, "model_ladder", lambda: [])
    assert delegation_tools._ladder_hint() == ""


# --- persona default tiers + subagents prompt --------------------------------

def test_agent_md_parses_tier_and_models(tmp_path):
    p = tmp_path / "x.md"
    p.write_text("---\nname: x\nmode: read\ntier: cheap\n"
                 "models: a, b\n---\nbody\n", encoding="utf-8")
    ad = plugins._load_agent_md(str(p))
    assert ad.tier == "cheap"
    assert ad.models == ["a", "b"]


def test_agent_md_without_tier_defaults_to_none(tmp_path):
    p = tmp_path / "y.md"
    p.write_text("---\nname: y\nmode: read\n---\nbody\n", encoding="utf-8")
    ad = plugins._load_agent_md(str(p))
    assert ad.tier is None and ad.models is None


def test_agents_prompt_shows_tier_and_ladder(monkeypatch):
    monkeypatch.setattr(llm, "model_ladder", lambda: [
        {"rung": 0, "id": "c", "label": "L", "model": "kimi",
         "tier": "premium", "tagged": False},
        {"rung": 1, "id": "c", "label": "L", "model": "flash",
         "tier": "cheap", "tagged": False}])
    reg = plugins.PluginRegistry()
    # Agent tier is deliberately DIFFERENT from every tier in the ladder fixture
    # (premium/cheap), so a ladder assertion below can never be accidentally
    # satisfied by the unrelated per-agent "[tier: ...]" tag line.
    reg.agents = {"r": _subagents.AgentDef("r", "p", mode="read",
                                           description="d", tier="standard")}
    text = reg.get_agents_prompt()
    assert "tier: standard" in text
    assert "MODEL LADDER" in text

    # Order: rung 0 (kimi, premium) must render BEFORE rung 1 (flash, cheap).
    # Catches a ladder loop that iterates in reverse (cheapest-first), which
    # would actively mislead the orchestrator about relative cost.
    assert text.index("kimi") < text.index("flash")

    # Per-row tier labels: each ladder row must carry ITS OWN tier — assert on
    # the specific line, not just that the word appears anywhere in the whole
    # prompt. Catches a ladder loop that dropped "— tier: {e['tier']}".
    lines = text.splitlines()
    kimi_line = next(l for l in lines if "kimi" in l)
    flash_line = next(l for l in lines if "flash" in l)
    assert "premium" in kimi_line
    assert "cheap" in flash_line


def test_agents_prompt_omits_ladder_section_when_unconfigured(monkeypatch):
    monkeypatch.setattr(llm, "model_ladder", lambda: [])
    reg = plugins.PluginRegistry()
    reg.agents = {"r": _subagents.AgentDef("r", "p", mode="read",
                                           description="d", tier="cheap")}
    text = reg.get_agents_prompt()
    assert "- r (read)" in text
    assert "MODEL LADDER" not in text


def test_researcher_persona_defaults_to_cheap():
    reg = plugins.get_registry()
    ad = reg.get_agent("researcher")
    assert ad is not None and ad.tier == "cheap"


if __name__ == "__main__":
    import types
    mp = types.SimpleNamespace(setattr=lambda o, n, v: setattr(o, n, v))
    tests = [
        lambda: test_delegated_step_autodispatches_and_folds_report(mp),
        lambda: test_delegated_write_sets_unverified_change(mp),
        lambda: test_unknown_delegate_is_handled_not_crashed(mp),
        lambda: test_delegation_disabled_does_nothing(mp),
        test_dispatch_agents_runs_read_wave_and_returns_reports,
        test_dispatch_agents_accepts_write_and_rejects_unknown,
        test_dispatch_agents_synthesize_merges,
    ]
    names = ["autodispatch", "write_unverified", "unknown_delegate", "disabled",
             "fanout_reads", "fanout_rejects", "fanout_synthesize"]
    failed = 0
    for name, t in zip(names, tests):
        try:
            t(); print(f"PASS {name}")
        except Exception as e:
            failed += 1
            import traceback; traceback.print_exc()
            print(f"FAIL {name}: {e}")
    print("OK" if not failed else f"{failed} FAILED")
    _sys.exit(1 if failed else 0)
