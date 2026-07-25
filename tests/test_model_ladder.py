import llm


def test_norm_tier_slugifies_and_blanks():
    assert llm._norm_tier("Premium") == "premium"
    assert llm._norm_tier("  CHEAP ") == "cheap"
    assert llm._norm_tier("my tier!") == "my-tier"
    assert llm._norm_tier("") == ""
    assert llm._norm_tier(None) == ""


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
