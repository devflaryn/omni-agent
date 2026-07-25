import threading
import time

import llm


def teardown_function():
    llm.clear_subagent_context()


# --- _run_group: subagent thread must not touch global active-provider state --

class _FakeResponse:
    def __init__(self, status_code=200, json_data=None, text=""):
        self.status_code = status_code
        self.ok = 200 <= status_code < 300
        self._json = json_data or {}
        self.text = text

    def json(self):
        return self._json


def test_run_group_subagent_thread_skips_globals_and_notify(monkeypatch):
    """A SUBAGENT thread's successful _run_group must not mutate the global
    active-provider pointers or fire the active-provider notifier — only the
    MAIN thread's calls should. This is what keeps a subagent's internal key/model
    choice from clobbering the main-UI badge."""
    notified = []
    monkeypatch.setattr(llm, "_notify_active", lambda cfg: notified.append(cfg))
    monkeypatch.setattr(llm, "_one_request",
                        lambda cfg, messages, temperature: {"ok": True, "content": "hi"})
    group = {"provider": "test", "label": "Test", "keys": ["k1"],
             "models": [{"id": "m1", "name": "Model1", "model": "model-1", "cfg": {"model": "model-1"}}]}

    saved = (llm._ACTIVE_KEY, llm._ACTIVE_MODEL, llm._ACTIVE_CONFIG_ID)
    llm._ACTIVE_KEY = None
    llm._ACTIVE_MODEL = None
    llm._ACTIVE_CONFIG_ID = None
    try:
        # Subagent thread: globals untouched, no notify.
        llm.set_subagent_context(pinned_key="k1")
        res = llm._run_group(group, [{"role": "user", "content": "hi"}], 0.3)
        assert res["ok"] is True
        assert llm._ACTIVE_KEY is None
        assert llm._ACTIVE_MODEL is None
        assert llm._ACTIVE_CONFIG_ID is None
        assert notified == []
        llm.clear_subagent_context()

        # Main thread: DOES update the globals and DOES notify.
        res = llm._run_group(group, [{"role": "user", "content": "hi"}], 0.3)
        assert res["ok"] is True
        assert llm._ACTIVE_KEY == "k1"
        assert llm._ACTIVE_MODEL == "model-1"
        assert llm._ACTIVE_CONFIG_ID == "m1"
        assert len(notified) == 1
    finally:
        llm._ACTIVE_KEY, llm._ACTIVE_MODEL, llm._ACTIVE_CONFIG_ID = saved
        llm.clear_subagent_context()


# --- usage normalization from real provider envelope shapes ------------------

def test_openai_usage_normalization_from_real_envelope(monkeypatch):
    cfg = llm.get_effective_config(overrides={"provider": "openai", "api_key": "test-key",
                                               "model": "gpt-4o-mini"})
    envelope = {
        "choices": [{"message": {"content": "hello"}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 12, "completion_tokens": 4, "total_tokens": 16},
    }
    monkeypatch.setattr(llm.requests, "post", lambda *a, **k: _FakeResponse(json_data=envelope))
    llm.take_last_usage()  # clear any stale usage from another test
    res = llm._openai_request(cfg, [{"role": "user", "content": "hi"}], 0.3)
    assert res["ok"] is True and res["content"] == "hello"
    assert llm.take_last_usage() == {"prompt": 12, "completion": 4, "total": 16}


def test_anthropic_usage_normalization_from_real_envelope(monkeypatch):
    cfg = llm.get_effective_config(overrides={"provider": "claude", "api_key": "test-key",
                                               "model": "claude-x"})
    envelope = {
        "content": [{"type": "text", "text": "hello"}],
        "stop_reason": "end_turn",
        "usage": {"input_tokens": 20, "output_tokens": 7},
    }
    monkeypatch.setattr(llm.requests, "post", lambda *a, **k: _FakeResponse(json_data=envelope))
    llm.take_last_usage()
    res = llm._anthropic_request(cfg, [{"role": "user", "content": "hi"}], 0.3)
    assert res["ok"] is True and res["content"] == "hello"
    assert llm.take_last_usage() == {"prompt": 20, "completion": 7, "total": 27}


def test_live_keys_starts_at_pinned_key():
    llm.set_subagent_context(pinned_key="k3")
    ordered = llm._live_keys(["k0", "k1", "k2", "k3", "k4"], dead=set())
    assert ordered[0] == "k3"


def test_live_keys_falls_back_when_no_pin():
    llm.clear_subagent_context()
    ordered = llm._live_keys(["k0", "k1"], dead=set())
    assert ordered  # non-empty, no crash


def test_take_last_usage_roundtrip_and_clear():
    llm._record_usage({"prompt": 10, "completion": 5, "total": 15})
    assert llm.take_last_usage() == {"prompt": 10, "completion": 5, "total": 15}
    assert llm.take_last_usage() is None


def test_active_key_pool_returns_list():
    pool = llm.active_key_pool()
    assert isinstance(pool, list)


# --- _await_or_stop: thread-local context must survive the worker-thread hop --

def test_await_or_stop_propagates_pinned_key_and_ladder_to_worker():
    """fn() runs on a fresh daemon thread inside _await_or_stop. The caller's
    subagent pin/ladder must still be visible from inside fn() — before the fix,
    a fresh thread has no thread-locals at all, so these all read as unset."""
    seen = {}

    def fn():
        seen["pinned_key"] = llm._pinned_key()
        seen["is_subagent"] = llm._is_subagent_thread()
        seen["model_ladder"] = llm._thread_model_ladder()
        return "ok"

    llm.set_subagent_context(pinned_key="pin-1", models=["a", "b"])
    try:
        res = llm._await_or_stop(fn)
        assert res == "ok"
        assert seen == {"pinned_key": "pin-1", "is_subagent": True, "model_ladder": ["a", "b"]}
    finally:
        llm.clear_subagent_context()


def test_await_or_stop_propagates_last_model_and_usage_back_to_caller(monkeypatch):
    """take_last_model()/take_last_usage() read the CALLER's thread-local. Since
    _run_group's success branch sets these from inside fn() (which runs on the
    ephemeral worker thread), _await_or_stop must copy them back onto the
    caller's _TL — otherwise take_last_model() always returns None."""
    monkeypatch.setattr(llm, "_notify_active", lambda cfg: None)

    def fake_one_request(cfg, messages, temperature):
        llm._record_usage({"prompt": 3, "completion": 2, "total": 5})
        return {"ok": True, "content": "hi"}

    monkeypatch.setattr(llm, "_one_request", fake_one_request)
    group = {"provider": "test", "label": "Test", "keys": ["k1"],
             "models": [{"id": "m1", "name": "Model1", "model": "model-1", "cfg": {"model": "model-1"}}]}
    llm.take_last_model()
    llm.take_last_usage()
    res = llm._await_or_stop(
        lambda: llm._run_group(group, [{"role": "user", "content": "hi"}], 0.3))
    assert res["ok"] is True
    assert llm.take_last_model() == "model-1"
    assert llm.take_last_usage() == {"prompt": 3, "completion": 2, "total": 5}


def test_await_or_stop_subagent_context_propagates_and_isolates_globals(monkeypatch):
    """End-to-end through _await_or_stop (the real call path from ask_llm): a
    subagent-context caller must NOT mutate the main active-provider badge, but
    a main-thread caller must — and both must still see their own
    take_last_model() afterward."""
    notified = []
    monkeypatch.setattr(llm, "_notify_active", lambda cfg: notified.append(cfg))
    monkeypatch.setattr(llm, "_one_request",
                         lambda cfg, messages, temperature: {"ok": True, "content": "hi"})
    group = {"provider": "test", "label": "Test", "keys": ["k1"],
             "models": [{"id": "m1", "name": "Model1", "model": "model-1", "cfg": {"model": "model-1"}}]}

    saved = (llm._ACTIVE_KEY, llm._ACTIVE_MODEL, llm._ACTIVE_CONFIG_ID)
    llm._ACTIVE_KEY = None
    llm._ACTIVE_MODEL = None
    llm._ACTIVE_CONFIG_ID = None
    try:
        # Subagent-context caller: globals untouched, no notify, through the
        # real worker-thread hop.
        llm.set_subagent_context(pinned_key="k1")
        res = llm._await_or_stop(
            lambda: llm._run_group(group, [{"role": "user", "content": "hi"}], 0.3))
        assert res["ok"] is True
        assert llm._ACTIVE_KEY is None
        assert llm._ACTIVE_MODEL is None
        assert llm._ACTIVE_CONFIG_ID is None
        assert notified == []
        assert llm.take_last_model() == "model-1"  # caller still sees its own telemetry
        llm.clear_subagent_context()

        # Main-thread caller: DOES update the globals and DOES notify.
        res = llm._await_or_stop(
            lambda: llm._run_group(group, [{"role": "user", "content": "hi"}], 0.3))
        assert res["ok"] is True
        assert llm._ACTIVE_KEY == "k1"
        assert llm._ACTIVE_MODEL == "model-1"
        assert llm._ACTIVE_CONFIG_ID == "m1"
        assert len(notified) == 1
        assert llm.take_last_model() == "model-1"
    finally:
        llm._ACTIVE_KEY, llm._ACTIVE_MODEL, llm._ACTIVE_CONFIG_ID = saved
        llm.clear_subagent_context()


def test_await_or_stop_stopped_orphan_does_not_clobber_later_telemetry():
    """If a stop is requested mid-flight, _await_or_stop returns the stop
    sentinel immediately and abandons the worker. When that orphan eventually
    finishes in the background, it must NOT clobber telemetry recorded by a
    later, unrelated call on this thread."""
    release = threading.Event()

    def slow_fn():
        release.wait(2)
        llm._record_usage({"prompt": 99, "completion": 99, "total": 198})
        llm._TL.last_model = "orphan-model"
        return {"ok": True, "content": "late"}

    stop_flags = {"stop": True}
    llm.set_stop_check(lambda: stop_flags["stop"])
    try:
        res = llm._await_or_stop(slow_fn, poll=0.01)
        assert res == {"__stopped__": True}

        # A subsequent, unrelated request records its own telemetry.
        stop_flags["stop"] = False
        llm.take_last_model()
        llm.take_last_usage()
        llm._record_usage({"prompt": 1, "completion": 1, "total": 2})
        llm._TL.last_model = "real-model"

        # Now let the orphan finish.
        release.set()
        time.sleep(0.3)

        assert llm.take_last_model() == "real-model"
        assert llm.take_last_usage() == {"prompt": 1, "completion": 1, "total": 2}
    finally:
        llm.set_stop_check(None)
