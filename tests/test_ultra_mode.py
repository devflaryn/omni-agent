"""Ultra mode: the per-session flag, its prompt segment, and the keyword that
flips it on. Guards against a casual question fanning out fifteen agents."""
import sys as _sys, os as _os
_sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))

import agent as agent_mod
from agent import AgentApi


def _api(**over):
    api = AgentApi.__new__(AgentApi)
    api.emits = []
    api._emit = lambda e: api.emits.append(e)
    # set_ultra() drives _refresh_system_prompt(), which (like every real
    # session) needs a system message slot to rewrite and a base prompt to
    # rewrite it from.
    session = {"messages": [{"role": "system", "content": ""}],
               "base_system_prompt": "", "ultra": False}
    session.update(over)
    api.session = session
    return api


def test_default_is_off():
    assert _api().get_ultra()["ultra"] is False


def test_set_ultra_toggles_and_persists_on_the_session():
    api = _api()
    api.set_ultra(True)
    assert api.session["ultra"] is True
    assert api.get_ultra()["ultra"] is True


def test_prompt_segment_off_tells_the_model_to_ask_first():
    text = agent_mod._ultra_prompt_segment({"ultra": False})
    assert "OFF" in text
    assert "ask" in text.lower() or "explicit" in text.lower()


def test_prompt_segment_on_tells_the_model_to_orchestrate():
    text = agent_mod._ultra_prompt_segment({"ultra": True})
    assert "ON" in text and "run_workflow" in text


def test_keyword_in_a_user_message_turns_it_on():
    assert agent_mod._ultra_keyword_requested("please ultra this refactor") is True
    assert agent_mod._ultra_keyword_requested("what is ultrasound") is False
    assert agent_mod._ultra_keyword_requested("just a normal question") is False


def test_stopping_aborts_every_active_workflow(monkeypatch):
    """Without this wiring, Stop cancels the shell command in flight but a
    running workflow keeps spawning agents."""
    import workflows
    called = {"n": 0}

    def fake_abort(run_id=None):
        called["n"] += 1
        return 2

    monkeypatch.setattr(workflows, "abort", fake_abort)
    api = _api()
    api._abort_active_workflows()
    assert called["n"] == 1
    assert any("2" in str(e.get("content", "")) for e in api.emits)


def test_aborting_workflows_never_raises(monkeypatch):
    # Stop must not be able to fail, whatever the engine is doing.
    import workflows

    def boom(run_id=None):
        raise RuntimeError("engine on fire")

    monkeypatch.setattr(workflows, "abort", boom)
    _api()._abort_active_workflows()      # must not raise


if __name__ == "__main__":
    import types
    import workflows as _wf
    monkeypatch = types.SimpleNamespace(setattr=lambda o, n, v: setattr(o, n, v))
    _orig_abort = _wf.abort
    failed = 0
    for t, needs_mp in [(test_default_is_off, False),
                        (test_set_ultra_toggles_and_persists_on_the_session, False),
                        (test_prompt_segment_off_tells_the_model_to_ask_first, False),
                        (test_prompt_segment_on_tells_the_model_to_orchestrate, False),
                        (test_keyword_in_a_user_message_turns_it_on, False),
                        (test_stopping_aborts_every_active_workflow, True),
                        (test_aborting_workflows_never_raises, True)]:
        try:
            t(monkeypatch) if needs_mp else t()
            print(f"PASS {t.__name__}")
        except Exception as e:
            failed += 1
            import traceback; traceback.print_exc()
            print(f"FAIL {t.__name__}: {e}")
        finally:
            _wf.abort = _orig_abort
    print("OK" if not failed else f"{failed} FAILED")
    _sys.exit(1 if failed else 0)
