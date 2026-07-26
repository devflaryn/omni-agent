"""The composer's inline effort menu and the LLM settings panel must be two views
of ONE value, not competing stores.

set_model_effort writes configs[i].model_settings[<model>].reasoning_effort — the
exact field the settings modal already edits — and list_model_options reports it
back along with the resolved reasoning STYLE, so the composer can render the right
control (a thinking toggle for GLM, a level list for OpenAI-style, nothing for a
model that always reasons) without a second round trip.
"""
import json

import pytest

import llm


@pytest.fixture
def cfg(tmp_path, monkeypatch):
    """Point llm at a throwaway config file so tests never touch the real one."""
    path = tmp_path / "llm_config.json"
    path.write_text(json.dumps({
        "version": 2,
        "configs": [
            {
                "id": "aaa",
                "name": "nvidia",
                "provider": "nvidia",
                "api_keys": ["nvapi-test"],
                "models": ["z-ai/glm-5.2", "deepseek-ai/deepseek-v4-pro"],
                "model_settings": {"z-ai/glm-5.2": {"reasoning_effort": "high"}},
            },
            {
                "id": "bbb",
                "name": "other",
                "provider": "nvidia",
                "base_url": "https://other.example/v1",
                "api_keys": ["k"],
                "models": ["some/model-x"],
            },
        ],
    }))
    monkeypatch.setattr(llm, "CONFIG_PATH", str(path), raising=False)
    monkeypatch.setattr(llm, "_CONFIG_PATH", str(path), raising=False)
    return path


def _read(path):
    return json.loads(path.read_text())


def _settings(path, cid, model):
    for c in _read(path)["configs"]:
        if c["id"] == cid:
            return (c.get("model_settings") or {}).get(model, {})
    raise AssertionError(f"no config {cid}")


def test_sets_effort_on_the_right_model(cfg):
    assert llm.set_model_effort("aaa", "deepseek-ai/deepseek-v4-pro", "max")
    assert _settings(cfg, "aaa", "deepseek-ai/deepseek-v4-pro")["reasoning_effort"] == "max"
    # The sibling model's existing override is untouched.
    assert _settings(cfg, "aaa", "z-ai/glm-5.2")["reasoning_effort"] == "high"


def test_overwrites_an_existing_effort(cfg):
    assert llm.set_model_effort("aaa", "z-ai/glm-5.2", "off")
    assert _settings(cfg, "aaa", "z-ai/glm-5.2")["reasoning_effort"] == "off"


def test_clearing_removes_the_override_and_leaves_no_residue(cfg):
    assert llm.set_model_effort("aaa", "z-ai/glm-5.2", "")
    for c in _read(cfg)["configs"]:
        if c["id"] == "aaa":
            # The empty {} and the empty model_settings map are both cleaned up,
            # so a cleared override is indistinguishable from never having set one.
            assert "z-ai/glm-5.2" not in (c.get("model_settings") or {})
            assert not c.get("model_settings")


def test_resolves_the_config_when_no_id_is_given(cfg):
    """The composer may not know which entry owns a model; the model name alone
    must be enough."""
    assert llm.set_model_effort("", "some/model-x", "low")
    assert _settings(cfg, "bbb", "some/model-x")["reasoning_effort"] == "low"


def test_unknown_model_is_rejected_rather_than_inventing_config(cfg):
    before = _read(cfg)
    assert llm.set_model_effort("aaa", "not/a-real-model", "high") is False
    assert _read(cfg) == before


def test_empty_model_is_rejected(cfg):
    before = _read(cfg)
    assert llm.set_model_effort("aaa", "", "high") is False
    assert llm.set_model_effort("aaa", None, "high") is False
    assert _read(cfg) == before


def test_wrong_config_id_does_not_write_to_a_different_entry(cfg):
    before = _read(cfg)
    assert llm.set_model_effort("bbb", "z-ai/glm-5.2", "max") is False
    assert _read(cfg) == before


def test_list_model_options_reports_effort_and_style(cfg):
    llm.set_model_effort("aaa", "deepseek-ai/deepseek-v4-pro", "max")
    by_model = {o["model"]: o for o in llm.list_model_options()}

    glm = by_model["z-ai/glm-5.2"]
    assert glm["reasoning_effort"] == "high"
    assert glm["reasoning_style"] == "thinking", "GLM must map to the thinking-toggle family"

    ds = by_model["deepseek-ai/deepseek-v4-pro"]
    assert ds["reasoning_effort"] == "max"
    assert ds["reasoning_style"] == "deepseek_v4"


def test_effort_round_trips_through_list_model_options(cfg):
    """What the composer writes is what it reads back — the property the whole
    feature rests on."""
    for level in ("off", "low", "high", "max"):
        assert llm.set_model_effort("aaa", "deepseek-ai/deepseek-v4-pro", level)
        opts = {o["model"]: o for o in llm.list_model_options()}
        assert opts["deepseek-ai/deepseek-v4-pro"]["reasoning_effort"] == level
