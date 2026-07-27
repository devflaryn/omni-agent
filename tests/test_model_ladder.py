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


import threading


def teardown_function():
    llm.clear_subagent_context()


def _groups():
    def mk(model):
        return {"id": "c", "name": "n", "model": model, "cfg": {"model": model}}
    return [
        {"provider": "cline", "label": "cline", "keys": ["k1"], "models": [mk("kimi")]},
        {"provider": "nvidia", "label": "nv", "keys": ["k2", "k3"],
         "models": [mk("glm"), mk("pro"), mk("flash")]},
    ]


def test_apply_model_override_honours_exact_order():
    out = llm._apply_model_override(_groups(), ["flash", "kimi"])
    assert [[m["model"] for m in g["models"]] for g in out] == [["flash"], ["kimi"]]


def test_apply_model_override_merges_consecutive_same_provider():
    out = llm._apply_model_override(_groups(), ["pro", "flash", "kimi"])
    assert [[m["model"] for m in g["models"]] for g in out] == [["pro", "flash"], ["kimi"]]
    assert out[0]["keys"] == ["k2", "k3"]   # key pool preserved for dead-key sharing


def test_apply_model_override_splits_non_consecutive_same_provider():
    out = llm._apply_model_override(_groups(), ["pro", "kimi", "flash"])
    assert [[m["model"] for m in g["models"]] for g in out] == [["pro"], ["kimi"], ["flash"]]


def test_apply_model_override_skips_unknown_ids():
    out = llm._apply_model_override(_groups(), ["nope", "glm"])
    assert [[m["model"] for m in g["models"]] for g in out] == [["glm"]]


def test_apply_model_override_all_unknown_returns_empty():
    assert llm._apply_model_override(_groups(), ["nope", "nada"]) == []


def test_apply_model_override_does_not_mutate_source_groups():
    src = _groups()
    llm._apply_model_override(src, ["pro", "flash"])
    assert [m["model"] for m in src[1]["models"]] == ["glm", "pro", "flash"]


def test_set_subagent_context_stores_and_clears_ladder():
    llm.set_subagent_context(pinned_key="k", models=["a", "b"])
    assert llm._thread_model_ladder() == ["a", "b"]
    llm.clear_subagent_context()
    assert llm._thread_model_ladder() is None


def test_take_last_model_roundtrip_and_clear():
    llm._TL.last_model = "some-model"
    assert llm.take_last_model() == "some-model"
    assert llm.take_last_model() is None


def test_override_is_thread_local(monkeypatch):
    """A subagent thread's ladder must never leak into the main thread."""
    llm.clear_subagent_context()
    seen = {}

    def worker():
        llm.set_subagent_context(pinned_key="k", models=["flash"])
        seen["sub"] = llm._thread_model_ladder()

    t = threading.Thread(target=worker)
    t.start()
    t.join()
    assert seen["sub"] == ["flash"]
    assert llm._thread_model_ladder() is None


def test_ask_llm_uses_override_on_subagent_thread(monkeypatch):
    """With an override set, ask_llm must try the overridden model and must NOT
    consult get_preferred_model()."""
    monkeypatch.setattr(llm, "get_effective_configs", lambda: [{"x": 1}])
    monkeypatch.setattr(llm, "_build_groups", lambda cfgs: _groups())
    monkeypatch.setattr(llm, "get_preferred_model",
                        lambda: (_ for _ in ()).throw(AssertionError("preference consulted")))
    tried = []

    def fake_run_group(group, messages, temperature, **kw):
        tried.append(group["models"][0]["model"])
        return {"ok": True, "content": "hi", "model": group["models"][0],
                "key": "k", "cfg": {}}

    monkeypatch.setattr(llm, "_run_group", fake_run_group)
    monkeypatch.setattr(llm, "_await_or_stop", lambda fn, poll=0.1: fn())
    llm.set_subagent_context(pinned_key="k", models=["flash"])
    assert llm.ask_llm([{"role": "user", "content": "hi"}]) == "hi"
    assert tried == ["flash"]


def test_ask_llm_falls_back_to_full_ladder_when_override_matches_nothing(monkeypatch):
    monkeypatch.setattr(llm, "get_effective_configs", lambda: [{"x": 1}])
    monkeypatch.setattr(llm, "_build_groups", lambda cfgs: _groups())
    monkeypatch.setattr(llm, "get_preferred_model", lambda: None)
    tried = []

    def fake_run_group(group, messages, temperature, **kw):
        tried.append(group["models"][0]["model"])
        return {"ok": True, "content": "hi", "model": group["models"][0],
                "key": "k", "cfg": {}}

    monkeypatch.setattr(llm, "_run_group", fake_run_group)
    monkeypatch.setattr(llm, "_await_or_stop", lambda fn, poll=0.1: fn())
    llm.set_subagent_context(pinned_key="k", models=["ghost"])
    assert llm.ask_llm([{"role": "user", "content": "hi"}]) == "hi"
    assert tried == ["kimi"]   # full ladder, not an empty group list


def test_prompt_contains_delegation_doctrine():
    p = llm.get_static_system_prompt()
    assert "DELEGATE BY DEFAULT" in p
    assert "dispatch_agents" in p
    assert "@cheap" in p


def test_prompt_keeps_parallel_wave_rule():
    p = llm.get_static_system_prompt()
    assert "parallel wave" in p.lower()


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
