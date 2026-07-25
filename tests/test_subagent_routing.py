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


def _replies(monkeypatch, seq):
    """Feed ask_llm a fixed sequence of raw replies."""
    it = iter(seq)
    monkeypatch.setattr(subagents, "ask_llm", lambda messages, temperature=0.3: next(it))


def test_escalates_once_after_two_parse_errors(monkeypatch):
    _patch_ladder(monkeypatch)
    pins = []
    monkeypatch.setattr(llm, "active_key_pool", lambda: ["k1"])
    monkeypatch.setattr(llm, "set_subagent_context",
                        lambda pinned_key=None, models=None: pins.append((pinned_key, models)))
    monkeypatch.setattr(llm, "clear_subagent_context", lambda: None)
    monkeypatch.setattr(llm, "take_last_usage", lambda: {"total": 1})
    monkeypatch.setattr(llm, "take_last_model", lambda: None)
    _replies(monkeypatch, ["garbage", "still garbage",
                           '{"type":"final_answer","content":"ok now"}'])
    out = subagents.run_subagent(AgentDef("a", "p", allowed_tools=set()), "t", tier="cheap")
    assert out["ok"] is True
    assert out["escalated"] is True
    assert pins[0][1][0] == "flash"      # started cheap
    assert pins[1][1][0] == "glm"        # escalated exactly one rung up
    assert pins[0][0] == pins[1][0] == "k1"  # SAME key re-pinned — warm cache preserved
    assert "glm" in out["note"]


def test_no_escalation_when_already_top_rung(monkeypatch):
    _patch_ladder(monkeypatch)
    monkeypatch.setattr(llm, "active_key_pool", lambda: ["k1"])
    monkeypatch.setattr(llm, "set_subagent_context", lambda pinned_key=None, models=None: None)
    monkeypatch.setattr(llm, "clear_subagent_context", lambda: None)
    monkeypatch.setattr(llm, "take_last_usage", lambda: {"total": 1})
    monkeypatch.setattr(llm, "take_last_model", lambda: None)
    _replies(monkeypatch, ["garbage", "garbage",
                           '{"type":"final_answer","content":"ok"}'])
    out = subagents.run_subagent(AgentDef("a", "p", allowed_tools=set()), "t", tier="premium")
    assert out["escalated"] is False
    assert out["ok"] is True
    assert out["report"] == "ok"          # reached the REAL final answer, not a salvage
    assert "salvaged" not in out["note"]  # distinguishes from a threshold-off-by-one mutant


def test_three_parse_errors_salvage_at_top_rung(monkeypatch):
    """At the top rung, escalation is a no-op — the 3-error salvage backstop still fires."""
    _patch_ladder(monkeypatch)
    monkeypatch.setattr(llm, "active_key_pool", lambda: ["k1"])
    monkeypatch.setattr(llm, "set_subagent_context", lambda pinned_key=None, models=None: None)
    monkeypatch.setattr(llm, "clear_subagent_context", lambda: None)
    monkeypatch.setattr(llm, "take_last_usage", lambda: {"total": 1})
    monkeypatch.setattr(llm, "take_last_model", lambda: None)
    _replies(monkeypatch, ["bad one", "bad two", "bad three"])
    out = subagents.run_subagent(AgentDef("a", "p", allowed_tools=set()), "t", tier="premium")
    assert out["ok"] is True
    assert "salvaged" in out["note"]
    assert out["escalated"] is False   # never left the top rung


def test_three_parse_errors_still_salvage_after_escalation(monkeypatch):
    """The escalation must not consume the 3-error salvage backstop: after a
    SUCCESSFUL escalation at error #2, a 3rd consecutive error still salvages."""
    _patch_ladder(monkeypatch)
    monkeypatch.setattr(llm, "active_key_pool", lambda: ["k1"])
    monkeypatch.setattr(llm, "set_subagent_context", lambda pinned_key=None, models=None: None)
    monkeypatch.setattr(llm, "clear_subagent_context", lambda: None)
    monkeypatch.setattr(llm, "take_last_usage", lambda: {"total": 1})
    monkeypatch.setattr(llm, "take_last_model", lambda: None)
    _replies(monkeypatch, ["bad one", "bad two", "bad three"])
    out = subagents.run_subagent(AgentDef("a", "p", allowed_tools=set()), "t", tier="cheap")
    assert out["ok"] is True
    assert out["escalated"] is True
    assert "salvaged" in out["note"]


def test_escalation_guard_does_not_rearm_after_success(monkeypatch):
    """The once-per-run guard must stay tripped even after a later successful
    parse resets the consecutive-error counter."""
    _patch_ladder(monkeypatch)
    pins = []
    monkeypatch.setattr(llm, "active_key_pool", lambda: ["k1"])
    monkeypatch.setattr(llm, "set_subagent_context",
                        lambda pinned_key=None, models=None: pins.append(models))
    monkeypatch.setattr(llm, "clear_subagent_context", lambda: None)
    monkeypatch.setattr(llm, "take_last_usage", lambda: {"total": 1})
    monkeypatch.setattr(llm, "take_last_model", lambda: None)
    _replies(monkeypatch, [
        "garbage", "still garbage",                            # -> escalates on error #2
        '{"type":"tool_call","tool":"nope","args":{}}',        # successful parse, resets the counter
        "garbage again", "still garbage again",                # 2 more consecutive errors
        '{"type":"final_answer","content":"done"}',
    ])
    out = subagents.run_subagent(AgentDef("a", "p", allowed_tools=set()), "t", tier="cheap")
    assert out["ok"] is True
    assert out["escalated"] is True
    assert out["note"].count("escalated to") == 1   # only ONE escalation ever happened
    assert len(pins) == 2                            # initial pin + the one escalation re-pin


def test_non_consecutive_parse_errors_do_not_escalate(monkeypatch):
    """Two parse errors separated by a successful parse must NOT count as
    consecutive — the counter has to reset on success."""
    _patch_ladder(monkeypatch)
    pins = []
    monkeypatch.setattr(llm, "active_key_pool", lambda: ["k1"])
    monkeypatch.setattr(llm, "set_subagent_context",
                        lambda pinned_key=None, models=None: pins.append(models))
    monkeypatch.setattr(llm, "clear_subagent_context", lambda: None)
    monkeypatch.setattr(llm, "take_last_usage", lambda: {"total": 1})
    monkeypatch.setattr(llm, "take_last_model", lambda: None)
    _replies(monkeypatch, [
        "garbage",                                              # error #1
        '{"type":"tool_call","tool":"nope","args":{}}',        # success -> resets the counter
        "garbage again",                                        # error #1 again, NOT consecutive
        '{"type":"final_answer","content":"done"}',
    ])
    out = subagents.run_subagent(AgentDef("a", "p", allowed_tools=set()), "t", tier="cheap")
    assert out["ok"] is True
    assert out["escalated"] is False
    assert len(pins) == 1   # only the initial pin — escalation never triggered


def test_note_accumulates_unknown_models_and_escalation(monkeypatch):
    """result['note'] must carry BOTH the Task-4 unknown-model note and the
    Task-5 escalation note — one must not overwrite the other."""
    _patch_ladder(monkeypatch)
    monkeypatch.setattr(llm, "active_key_pool", lambda: ["k1"])
    monkeypatch.setattr(llm, "set_subagent_context", lambda pinned_key=None, models=None: None)
    monkeypatch.setattr(llm, "clear_subagent_context", lambda: None)
    monkeypatch.setattr(llm, "take_last_usage", lambda: {"total": 1})
    monkeypatch.setattr(llm, "take_last_model", lambda: None)
    _replies(monkeypatch, ["garbage", "still garbage",
                           '{"type":"final_answer","content":"ok now"}'])
    out = subagents.run_subagent(AgentDef("a", "p", allowed_tools=set()), "t",
                                 models=["ghost", "flash"])
    assert out["ok"] is True
    assert out["escalated"] is True
    assert "ghost" in out["note"]             # Task-4 unknown-model note survived
    assert "escalated to glm" in out["note"]  # Task-5 escalation note also present


def test_escalate_ladder_helper(monkeypatch):
    _patch_ladder(monkeypatch)
    assert subagents.escalate_ladder(["flash", "kimi"]) == ["glm", "flash", "kimi"]
    assert subagents.escalate_ladder(["kimi", "glm"]) is None
    assert subagents.escalate_ladder(["ghost"]) is None
    assert subagents.escalate_ladder([]) is None
