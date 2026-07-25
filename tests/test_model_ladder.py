import llm


def test_norm_tier_slugifies_and_blanks():
    assert llm._norm_tier("Premium") == "premium"
    assert llm._norm_tier("  CHEAP ") == "cheap"
    assert llm._norm_tier("my tier!") == "my-tier"
    assert llm._norm_tier("") == ""
    assert llm._norm_tier(None) == ""


def test_norm_tier_handles_non_string_input():
    """Non-string input must degrade gracefully to '', not raise."""
    assert llm._norm_tier(5) == ""
    assert llm._norm_tier([1]) == ""
    assert llm._norm_tier({"a": 1}) == ""
    assert llm._norm_tier(True) == ""


def test_norm_tier_no_trailing_hyphen_after_truncation():
    """A >32-char tier name with hyphens must not end in '-' after truncation."""
    # Create a tier name that's long and has hyphens at position 32+
    # "hello-world-this-is-a-long-tier-name-here" is ~43 chars
    long_tier = "hello-world-this-is-a-long-tier-name-here"
    result = llm._norm_tier(long_tier)
    assert len(result) <= 32
    assert not result.endswith("-"), f"Result '{result}' should not end with '-'"


def test_model_settings_preserves_tier():
    out = llm._norm_model_settings(
        {"m-1": {"reasoning_effort": "high", "tier": "Premium"},
         "m-2": {"tier": "cheap"}},
        model_ids=["m-1", "m-2"])
    assert out["m-1"]["tier"] == "premium"
    assert out["m-1"]["reasoning_effort"] == "high"
    assert out["m-2"] == {"tier": "cheap"}


def test_model_settings_drops_unusable_tier():
    out = llm._norm_model_settings({"m-1": {"tier": "   "}}, model_ids=["m-1"])
    assert out == {}


def test_tier_survives_effective_and_minimize_roundtrip():
    raw = {"id": "c1", "name": "n", "provider": "nvidia",
           "api_key": "k", "models": ["m-1", "m-2"],
           "model_settings": {"m-1": {"tier": "premium"}}}
    eff = llm._effective(raw)
    assert eff["model_settings"]["m-1"]["tier"] == "premium"
    saved = llm._minimize_entry(raw)
    assert saved["model_settings"]["m-1"]["tier"] == "premium"


def _ladder(*pairs):
    """Build a fake ladder: _ladder(("m-0", "premium"), ("m-1", ""), ...)."""
    entries = [{"rung": i, "id": "c1", "label": "L", "model": m,
                "tier": t, "tagged": bool(t)} for i, (m, t) in enumerate(pairs)]
    n = len(entries)
    for e in entries:
        if not e["tagged"]:
            e["tier"] = llm._derived_tier(e["rung"], n)
    return entries


def test_derived_tier_labels_every_rung():
    assert llm._derived_tier(0, 5) == "premium"
    assert llm._derived_tier(1, 5) == "standard"
    assert llm._derived_tier(3, 5) == "standard"
    assert llm._derived_tier(4, 5) == "cheap"


def test_derived_tier_degenerate_ladders():
    assert llm._derived_tier(0, 1) == "premium"
    assert llm._derived_tier(0, 2) == "premium"
    assert llm._derived_tier(1, 2) == "cheap"


def test_models_for_tier_body_then_reversed_tail():
    lad = _ladder(("m0", ""), ("m1", ""), ("m2", ""), ("m3", ""), ("m4", ""))
    # cheap starts at the last rung; tail escalates to the NEAREST higher rung first
    assert llm.models_for_tier("cheap", lad) == ["m4", "m3", "m2", "m1", "m0"]
    assert llm.models_for_tier("premium", lad) == ["m0", "m1", "m2", "m3", "m4"]
    assert llm.models_for_tier("standard", lad) == ["m1", "m2", "m3", "m4", "m0"]


def test_models_for_tier_honours_explicit_tags():
    lad = _ladder(("m0", ""), ("m1", "cheap"), ("m2", ""), ("m3", ""), ("m4", ""))
    # m1 is TAGGED cheap, so cheap starts at rung 1 even though m4 is last
    assert llm.models_for_tier("cheap", lad)[0] == "m1"


def test_models_for_tier_custom_tag_resolves():
    lad = _ladder(("m0", ""), ("m1", "fast"), ("m2", ""))
    assert llm.models_for_tier("fast", lad)[0] == "m1"


def test_models_for_tier_unknown_falls_back_to_default():
    lad = _ladder(("m0", ""), ("m1", ""), ("m2", ""))
    assert llm.models_for_tier("nonsense", lad) == llm.models_for_tier(
        llm.DEFAULT_SUBAGENT_TIER, lad)


def test_models_for_tier_empty_ladder():
    assert llm.models_for_tier("cheap", []) == []


def test_models_for_tier_single_model_ladder():
    lad = _ladder(("only", ""))
    assert llm.models_for_tier("cheap", lad) == ["only"]
    assert llm.models_for_tier("premium", lad) == ["only"]


def test_tagged_model_does_not_drift_when_ladder_grows():
    """The stability guarantee: a TAGGED model keeps its tier as models are added."""
    small = _ladder(("m0", ""), ("m1", "premium"), ("m2", ""))
    big = _ladder(("m0", ""), ("m1", "premium"), ("x", ""), ("y", ""), ("m2", ""))
    assert llm.models_for_tier("premium", small)[0] == "m1"
    assert llm.models_for_tier("premium", big)[0] == "m1"


def test_dual_match_tagged_heads_slice_untagged_same_tier_goes_to_tail():
    """When a tier has both TAGGED and untagged (derived) models, the tagged one
    heads the slice and the untagged same-tier model goes to last-resort tail.

    This pins the dual-match ordering: m0 derives premium at rung 0; m1 is
    explicitly tagged premium at rung 1. m0 must end up in the tail (after
    cheaper models) to preserve "never silently pay premium" — exhaust the
    cost tier fully before escalating."""
    big = _ladder(("m0", ""), ("m1", "premium"), ("x", ""), ("y", ""), ("m2", ""))
    # m0: rung 0, derived premium (untagged)
    # m1: rung 1, tagged premium
    # x:  rung 2, derived standard
    # y:  rung 3, derived standard
    # m2: rung 4, derived cheap
    result = llm.models_for_tier("premium", big)
    # Body starts at m1 (tagged wins): [m1, x, y, m2]
    # Tail: rungs before m1 in reverse: [m0]
    # Full result: [m1, x, y, m2, m0] — m0 lands last despite being same tier
    assert result == ["m1", "x", "y", "m2", "m0"]


def test_model_ladder_shape(monkeypatch):
    cfgs = [{"id": "c1", "provider": "nvidia", "base_url": "", "label": "nv",
             "api_keys": ["k"], "models": ["a", "b"], "vision_models": [],
             "model_settings": {"b": {"tier": "cheap"}}, "name": "nv"}]
    monkeypatch.setattr(llm, "get_effective_configs", lambda: cfgs)
    lad = llm.model_ladder()
    assert [e["model"] for e in lad] == ["a", "b"]
    assert [e["rung"] for e in lad] == [0, 1]
    assert lad[0]["tier"] == "premium" and lad[0]["tagged"] is False
    assert lad[1]["tier"] == "cheap" and lad[1]["tagged"] is True


def test_model_ladder_empty_when_unconfigured(monkeypatch):
    monkeypatch.setattr(llm, "get_effective_configs", lambda: [])
    assert llm.model_ladder() == []
