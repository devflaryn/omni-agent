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
