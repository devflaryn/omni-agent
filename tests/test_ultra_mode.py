"""Ultra mode: the per-session flag, its prompt segment, and the keyword that
flips it on. Guards against a casual question fanning out fifteen agents."""
import sys as _sys, os as _os, threading as _threading
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
               "base_system_prompt": "", "ultra": False, "ultra_turn_only": False}
    session.update(over)
    api.session = session
    return api


def _full_api(**over):
    """Like _api(), but also wired for send_message()/_run_agent_loop(): the
    __new__-built api above skips AgentApi.__init__, so the lock/busy/stop/
    window/thread bookkeeping those two methods touch has to be added by hand.
    original_task defaults to None since send_message reads it unconditionally."""
    over.setdefault("original_task", None)
    api = _api(**over)
    api._lock = _threading.Lock()
    api._busy = False
    api._stop = False
    api._window = None
    api._thread = None
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


# --- the keyword arms ONE turn, the toggle is sticky (I5) -------------------
def test_the_keyword_arms_only_the_turn_that_asked_for_it(monkeypatch):
    """It used to latch on forever with nothing to clear it, so one message
    mentioning "ultra" left every later turn free to fan out. The spec scopes
    the keyword to THAT turn.

    This drives the REAL send_message() -> _run_agent_loop() path (not a
    re-implementation of it): only the LLM call and the end-of-run tree
    refresh are stubbed out; the keyword block (agent.py's send_message,
    ~3123-3133) and the ultra_turn_only clearing in _run_agent_loop's
    `finally` (~5295-5303) both run for real."""
    api = _full_api()
    monkeypatch.setattr(api, "_refresh_tree", lambda force=False: None)

    captured = {}

    def fake_get_model_response(s):
        # Runs in place of the real LLM call, from inside the real loop body —
        # this is the turn itself, so whatever `ultra` is here is what the
        # turn actually ran with.
        captured["ultra"] = s.get("ultra")
        captured["ultra_turn_only"] = s.get("ultra_turn_only")
        raise RuntimeError("test stub: no real LLM call")

    monkeypatch.setattr(api, "_get_model_response", fake_get_model_response)

    result = api.send_message("ultra: review this")
    assert result["ok"] is True
    api._thread.join(timeout=5)
    assert not api._thread.is_alive(), "the agent-loop thread never finished"

    # The turn that asked for it ran on the ON prompt...
    assert captured["ultra"] is True, "the keyword never armed this turn"
    assert captured["ultra_turn_only"] is True

    # ...and once the turn completed (via _run_agent_loop's finally), the flag
    # is cleared back off rather than latching on for every later turn.
    assert api.session["ultra"] is False, "the keyword latched on permanently"
    assert api.session["ultra_turn_only"] is False
    assert {"type": "ultra_mode", "ultra": True} in api.emits
    assert {"type": "ultra_mode", "ultra": False} in api.emits
    # the ON emit must precede the OFF emit (armed, then cleared — not the
    # reverse, and not just present twice).
    on_i = api.emits.index({"type": "ultra_mode", "ultra": True})
    off_i = api.emits.index({"type": "ultra_mode", "ultra": False})
    assert on_i < off_i


def test_a_sticky_toggle_survives_the_turn_that_used_it(monkeypatch):
    """The distinction the whole design rests on: set_ultra() (the header
    toggle) is STICKY. Unlike the keyword, a completed turn must NOT clear it,
    because set_ultra() never set ultra_turn_only in the first place."""
    api = _full_api()
    monkeypatch.setattr(api, "_refresh_tree", lambda force=False: None)
    api.set_ultra(True)
    assert api.session["ultra_turn_only"] is False

    captured = {}

    def fake_get_model_response(s):
        captured["ultra"] = s.get("ultra")
        raise RuntimeError("test stub: no real LLM call")

    monkeypatch.setattr(api, "_get_model_response", fake_get_model_response)

    result = api.send_message("do the thing")
    assert result["ok"] is True
    api._thread.join(timeout=5)
    assert not api._thread.is_alive(), "the agent-loop thread never finished"

    assert captured["ultra"] is True
    # Sticky: still on after the turn that used it completes.
    assert api.session["ultra"] is True
    assert api.session["ultra_turn_only"] is False


def test_the_toggle_is_sticky_and_clears_the_turn_scope():
    api = _api(ultra=True, ultra_turn_only=True)
    api.set_ultra(True)
    assert api.session["ultra_turn_only"] is False
    assert api.get_ultra()["ultra"] is True


def test_the_toggle_can_turn_it_back_off():
    api = _api(ultra=True)
    assert api.set_ultra(False)["ultra"] is False
    assert api.get_ultra()["ultra"] is False


def test_the_toggle_emits_so_the_header_chip_can_reflect_it():
    api = _api()
    api.set_ultra(True)
    assert {"type": "ultra_mode", "ultra": True} in api.emits


def test_get_ultra_without_a_session_does_not_raise():
    api = _api()
    api.session = None
    assert api.get_ultra()["ultra"] is False


# --- persistence (M7) -------------------------------------------------------
def test_ultra_is_written_into_the_persisted_session():
    import json
    import tempfile
    mem = tempfile.mkdtemp(prefix="ultra-persist-")
    api = _api(memory_dir=mem, messages=[{"role": "user", "content": "hi"}],
               transcript=[], project="p", original_task="t")
    api.set_ultra(True)
    api._persist_session()
    with open(_os.path.join(mem, agent_mod.CONVERSATION_FILENAME), encoding="utf-8") as f:
        assert json.load(f)["ultra"] is True


def test_a_keyword_armed_turn_is_not_persisted():
    """Persisting it would resurrect the latch M7 is meant to survive without."""
    import json
    import tempfile
    mem = tempfile.mkdtemp(prefix="ultra-persist-")
    api = _api(memory_dir=mem, messages=[{"role": "user", "content": "hi"}],
               transcript=[], project="p", original_task="t",
               ultra=True, ultra_turn_only=True)
    api._persist_session()
    with open(_os.path.join(mem, agent_mod.CONVERSATION_FILENAME), encoding="utf-8") as f:
        assert json.load(f)["ultra"] is False


def test_a_persisted_ultra_is_restored_on_the_next_open():
    import json
    import tempfile
    mem = tempfile.mkdtemp(prefix="ultra-restore-")
    with open(_os.path.join(mem, agent_mod.CONVERSATION_FILENAME), "w", encoding="utf-8") as f:
        json.dump({"project": "p", "original_task": "t", "ultra": True,
                   "messages": [{"role": "user", "content": "hi"}]}, f)
    api = _api()
    api._load_persisted(mem)
    assert api._restored_ultra is True


def test_no_persisted_flag_means_off():
    import tempfile
    api = _api()
    api._load_persisted(tempfile.mkdtemp(prefix="ultra-restore-"))
    assert api._restored_ultra is False


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
                        (test_aborting_workflows_never_raises, True),
                        (test_the_keyword_arms_only_the_turn_that_asked_for_it, True),
                        (test_a_sticky_toggle_survives_the_turn_that_used_it, True),
                        (test_the_toggle_is_sticky_and_clears_the_turn_scope, False),
                        (test_the_toggle_can_turn_it_back_off, False),
                        (test_the_toggle_emits_so_the_header_chip_can_reflect_it, False),
                        (test_get_ultra_without_a_session_does_not_raise, False),
                        (test_ultra_is_written_into_the_persisted_session, False),
                        (test_a_keyword_armed_turn_is_not_persisted, False),
                        (test_a_persisted_ultra_is_restored_on_the_next_open, False),
                        (test_no_persisted_flag_means_off, False)]:
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
