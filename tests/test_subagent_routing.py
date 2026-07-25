import llm
import subagents
from subagents import AgentDef


def _fake_ladder():
    return [{"rung": 0, "id": "c", "label": "L", "model": "kimi",
             "tier": "premium", "tagged": False},
            {"rung": 1, "id": "c", "label": "L", "model": "glm",
             "tier": "standard", "tagged": False},
            {"rung": 2, "id": "c", "label": "L", "model": "flash",
             "tier": "cheap", "tagged": False}]


def _patch_ladder(monkeypatch, ladder=None):
    lad = _fake_ladder() if ladder is None else ladder
    monkeypatch.setattr(llm, "model_ladder", lambda: lad)
    return lad


def test_explicit_models_win_over_everything(monkeypatch):
    _patch_ladder(monkeypatch)
    ad = AgentDef("a", "p", tier="premium", models=["kimi"])
    ladder, note = subagents.resolve_model_ladder(ad, tier="premium", models=["flash"])
    assert ladder[0] == "flash" and note == ""


def test_explicit_models_get_the_rest_appended(monkeypatch):
    _patch_ladder(monkeypatch)
    ladder, _ = subagents.resolve_model_ladder(AgentDef("a", "p"), models=["flash"])
    assert ladder == ["flash", "kimi", "glm"]


def test_explicit_tier_beats_frontmatter(monkeypatch):
    _patch_ladder(monkeypatch)
    ad = AgentDef("a", "p", tier="premium")
    ladder, _ = subagents.resolve_model_ladder(ad, tier="cheap")
    assert ladder[0] == "flash"


def test_frontmatter_models_beat_frontmatter_tier(monkeypatch):
    _patch_ladder(monkeypatch)
    ad = AgentDef("a", "p", tier="cheap", models=["glm"])
    ladder, _ = subagents.resolve_model_ladder(ad)
    assert ladder[0] == "glm"


def test_frontmatter_tier_used_when_call_is_silent(monkeypatch):
    _patch_ladder(monkeypatch)
    ladder, _ = subagents.resolve_model_ladder(AgentDef("a", "p", tier="cheap"))
    assert ladder[0] == "flash"


def test_default_tier_when_nothing_specified(monkeypatch):
    _patch_ladder(monkeypatch)
    ladder, _ = subagents.resolve_model_ladder(AgentDef("a", "p"))
    assert ladder == llm.models_for_tier(llm.DEFAULT_SUBAGENT_TIER, _fake_ladder())


def test_unknown_model_ids_are_dropped_with_a_note(monkeypatch):
    _patch_ladder(monkeypatch)
    ladder, note = subagents.resolve_model_ladder(
        AgentDef("a", "p"), models=["ghost", "flash"])
    assert ladder[0] == "flash"
    assert "ghost" in note


def test_all_unknown_models_fall_back_to_tier(monkeypatch):
    _patch_ladder(monkeypatch)
    ladder, note = subagents.resolve_model_ladder(
        AgentDef("a", "p", tier="cheap"), models=["ghost"])
    assert ladder[0] == "flash"
    assert "ghost" in note


def test_no_configured_models_returns_none(monkeypatch):
    _patch_ladder(monkeypatch, [])
    ladder, note = subagents.resolve_model_ladder(AgentDef("a", "p"), tier="cheap")
    assert ladder is None and note == ""


# --- precedence chain: pin EVERY rung against its neighbors ------------------
# (fix round 1: the original 4b code resolved `agent_def.models` in the same
# loop as call `models`, so it beat call `tier` — swapping rungs 2 and 3.)

def test_call_tier_beats_frontmatter_models(monkeypatch):
    _patch_ladder(monkeypatch)
    ad = AgentDef("a", "p", models=["glm"])
    ladder, _ = subagents.resolve_model_ladder(ad, tier="cheap")
    assert ladder[0] == "flash"


def test_call_models_beats_call_tier(monkeypatch):
    _patch_ladder(monkeypatch)
    ladder, _ = subagents.resolve_model_ladder(
        AgentDef("a", "p"), tier="cheap", models=["kimi"])
    assert ladder[0] == "kimi"


def test_frontmatter_models_beats_frontmatter_tier_explicit(monkeypatch):
    _patch_ladder(monkeypatch)
    ad = AgentDef("a", "p", tier="cheap", models=["kimi"])
    ladder, _ = subagents.resolve_model_ladder(ad)
    assert ladder[0] == "kimi"


def test_call_models_all_unknown_falls_through_to_call_tier_not_frontmatter_models(monkeypatch):
    _patch_ladder(monkeypatch)
    ad = AgentDef("a", "p", models=["glm"])
    ladder, note = subagents.resolve_model_ladder(ad, tier="cheap", models=["ghost"])
    assert ladder[0] == "flash"
    assert "ghost" in note


def test_notes_accumulate_across_call_and_frontmatter_unknown_ids(monkeypatch):
    _patch_ladder(monkeypatch)
    ad = AgentDef("a", "p", models=["ghost2"])
    ladder, note = subagents.resolve_model_ladder(ad, models=["ghost1"])
    assert ladder[0] == "glm"   # falls all the way to DEFAULT_SUBAGENT_TIER ("standard")
    assert "ghost1" in note and "ghost2" in note


def test_normalize_spec_shapes():
    ad = AgentDef("a", "p")
    assert subagents._normalize_spec((ad, "t")) == (ad, "t", "", None, None)
    assert subagents._normalize_spec((ad, "t", "c")) == (ad, "t", "c", None, None)
    assert subagents._normalize_spec(
        {"agent_def": ad, "task": "t", "tier": "cheap"}) == (ad, "t", "", "cheap", None)


def test_run_subagent_pins_the_resolved_ladder(monkeypatch):
    _patch_ladder(monkeypatch)
    seen = {}
    monkeypatch.setattr(llm, "active_key_pool", lambda: ["k1"])
    monkeypatch.setattr(llm, "set_subagent_context",
                        lambda pinned_key=None, models=None: seen.update(models=models))
    monkeypatch.setattr(llm, "clear_subagent_context", lambda: None)
    monkeypatch.setattr(subagents, "ask_llm",
                        lambda messages, temperature=0.3: '{"type":"final_answer","content":"done"}')
    monkeypatch.setattr(llm, "take_last_usage", lambda: {"total": 5})
    monkeypatch.setattr(llm, "take_last_model", lambda: "flash")
    out = subagents.run_subagent(AgentDef("a", "p", allowed_tools=set()), "task", tier="cheap")
    assert out["ok"] is True
    assert seen["models"][0] == "flash"
    assert out["model"] == "flash"


def test_run_subagent_emits_tier_and_model_telemetry(monkeypatch):
    _patch_ladder(monkeypatch)
    events = []
    monkeypatch.setattr(llm, "active_key_pool", lambda: ["k1"])
    monkeypatch.setattr(llm, "set_subagent_context", lambda pinned_key=None, models=None: None)
    monkeypatch.setattr(llm, "clear_subagent_context", lambda: None)
    monkeypatch.setattr(subagents, "ask_llm",
                        lambda messages, temperature=0.3: '{"type":"final_answer","content":"x"}')
    monkeypatch.setattr(llm, "take_last_usage", lambda: {"total": 1})
    monkeypatch.setattr(llm, "take_last_model", lambda: "flash")
    subagents.run_subagent(AgentDef("a", "p", allowed_tools=set()), "task",
                           tier="cheap", on_event=events.append)
    started = next(e for e in events if e["type"] == "subagent_started")
    done = next(e for e in events if e["type"] == "subagent_done")
    assert started["tier"] == "cheap" and started["model"] == "flash"
    assert done["model"] == "flash"
