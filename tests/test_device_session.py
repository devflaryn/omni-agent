"""The session's device: prompt visibility, transcript record, persistence."""
import sys as _sys, os as _os
_sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))

import agent as agent_mod
import devices
from agent import AgentApi


def _api(**over):
    api = AgentApi.__new__(AgentApi)
    api.emits = []
    api._emit = lambda e: api.emits.append(e)
    api._refresh_system_prompt = lambda: None
    session = {"messages": [{"role": "system", "content": ""}],
               "base_system_prompt": "", "active_device": None}
    session.update(over)
    api.session = session
    return api


def test_prompt_says_this_computer_when_local():
    text = agent_mod._device_prompt_segment({"active_device": None})
    assert "this computer" in text.lower()


def test_prompt_names_the_device_and_its_root(monkeypatch):
    d = devices.Device("i", "build-box", "berat@10.0.0.5", "/home/berat/proj")
    monkeypatch.setattr(devices, "_active", d)
    text = agent_mod._device_prompt_segment({"active_device": "i"})
    assert "build-box" in text and "/home/berat/proj" in text
    assert "cannot" in text.lower() or "no tool" in text.lower(), \
        "the model must be told it cannot switch devices itself"


def test_selecting_a_device_records_it_in_the_transcript(monkeypatch):
    d = devices.Device("i", "build-box", "berat@h", "/r")
    monkeypatch.setattr(devices, "get_device", lambda _id: d)
    monkeypatch.setattr(devices, "set_active", lambda _id: d)
    api = _api()
    api.select_device("i")
    kinds = [e.get("type") for e in api.emits]
    assert "system" in kinds, "a device switch must be visible in the transcript"
    assert any("build-box" in str(e.get("content", "")) for e in api.emits)


def test_selecting_local_records_it_too(monkeypatch):
    monkeypatch.setattr(devices, "set_active", lambda _id: None)
    api = _api(active_device="i")
    api.select_device(None)
    assert api.session["active_device"] is None
    assert any("system" == e.get("type") for e in api.emits)


def test_active_device_is_persisted(monkeypatch):
    # Reopening a project must not silently drop back to the local machine.
    import json, tempfile
    mem = tempfile.mkdtemp(prefix="devsess-")
    api = _api(memory_dir=mem, project="p", active_device="dev123")
    api._persist_session()
    saved = json.load(open(_os.path.join(mem, agent_mod.CONVERSATION_FILENAME),
                           encoding="utf-8"))
    assert saved["active_device"] == "dev123"


def test_opening_a_project_without_a_saved_device_clears_a_stale_active_one(monkeypatch):
    """A project switch must not inherit the PREVIOUS project's device: opening a
    project whose saved state has no active_device (key absent) must assert the
    module-level devices._active back to local, not leave it pointed at whatever
    the last project selected. Regression for: gating the restore call on
    `saved_device is not None` left a truthy previous device untouched."""
    import json, tempfile
    stale = devices.Device("stale", "old-box", "berat@old", "/old")
    monkeypatch.setattr(devices, "_active", stale)
    mem = tempfile.mkdtemp(prefix="devsess-noactive-")
    with open(_os.path.join(mem, agent_mod.CONVERSATION_FILENAME), "w", encoding="utf-8") as f:
        json.dump({"messages": [{"role": "user", "content": "hi"}]}, f)
    api = AgentApi.__new__(AgentApi)
    api._load_persisted(mem)
    assert devices.active() is None, \
        "opening a project without a saved device left the PREVIOUS project's device active"
    assert api._restored_active_device is None


def test_test_device_returns_the_probe_result(monkeypatch):
    monkeypatch.setattr(devices, "get_device",
                        lambda _id: devices.Device("i", "n", "h", "/r"))
    monkeypatch.setattr(devices, "probe",
                        lambda d: {"ok": True, "root": "/r", "uname": "Linux x",
                                   "missing": ["apktool"], "error": ""})
    out = _api().test_device("i")
    assert out["ok"] is True and out["missing"] == ["apktool"]


# --- CRITICAL 3: the chip must repaint on every session start -----------------
# frontend/app.js paints the chip once at init() and then only from
# `device_changed`. _load_persisted() reinstates (or clears) devices._active for
# whichever project is being opened, and changeSessionBtn ends a session WITHOUT
# reloading the page -- so without an emit here, project A (local) -> change
# session -> project B (build box) leaves routing REMOTE while the chip still
# reads "this computer", and the user runs a destructive command believing it is
# local. It fails the same way in reverse.

def _session_api(monkeypatch, **over):
    api = _api(**over)
    api._busy = False
    monkeypatch.setattr(agent_mod, "build_file_tree",
                        lambda p: {"name": p, "path": "", "type": "dir", "children": []})
    monkeypatch.setattr(agent_mod, "_read_import_meta", lambda root: None)
    return api


def _device_events(api):
    return [e for e in api.emits if e.get("type") == "device_changed"]


def test_session_start_emits_device_changed_naming_the_device(monkeypatch):
    d = devices.Device("i", "build-box", "berat@h", "/r")
    monkeypatch.setattr(devices, "_active", d)
    api = _session_api(monkeypatch, project="p", root="/tmp/p", active_device="i")
    api._emit_session_started()
    evs = _device_events(api)
    assert len(evs) == 1, "the chip has no other way to learn the project changed"
    assert evs[0]["device"]["name"] == "build-box"
    assert evs[0]["device"]["target"] == "berat@h"


def test_session_start_emits_device_changed_for_LOCAL_too(monkeypatch):
    # The dangerous direction is remote -> local as much as local -> remote: a
    # chip left reading "build-box" on a local project is just as wrong.
    monkeypatch.setattr(devices, "_active", None)
    api = _session_api(monkeypatch, project="p", root="/tmp/p")
    api._emit_session_started()
    evs = _device_events(api)
    assert len(evs) == 1 and evs[0]["device"] is None


def test_device_changed_is_emitted_after_the_session_is_rebuilt(monkeypatch):
    # session_started rebuilds the whole chat; the chip repaint has to survive
    # it, so it must come after.
    monkeypatch.setattr(devices, "_active", devices.Device("i", "b", "h", "/r"))
    api = _session_api(monkeypatch, project="p", root="/tmp/p")
    api._emit_session_started()
    kinds = [e.get("type") for e in api.emits]
    assert kinds.index("device_changed") > kinds.index("session_started")


def test_the_frontend_handler_repaints_from_that_event():
    # The backend emit is only half the fix; app.js must route it and
    # device_view.js must re-render from it.
    root = _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__)))
    app = open(_os.path.join(root, "frontend", "app.js"), encoding="utf-8").read()
    view = open(_os.path.join(root, "frontend", "device_view.js"), encoding="utf-8").read()
    assert "case 'device_changed': deviceChanged(ev); break;" in app
    assert "function deviceChanged(ev)" in view and "renderDeviceChip()" in view


# --- one turn must not split across two machines ------------------------------

def test_select_device_refuses_while_the_agent_is_busy(monkeypatch):
    # Routing is read per tool call from a process-wide global, so a mid-turn
    # switch would build on the device and install here.
    d = devices.Device("i", "build-box", "berat@h", "/r")
    monkeypatch.setattr(devices, "get_device", lambda _id: d)
    switched = {"n": 0}
    monkeypatch.setattr(devices, "set_active",
                        lambda _id: switched.__setitem__("n", switched["n"] + 1))
    api = _api()
    api._busy = True
    res = api.select_device("i")
    assert res["ok"] is False
    assert "stop" in res["error"].lower() or "finish" in res["error"].lower()
    assert switched["n"] == 0, "the execution target was changed anyway"


def test_select_device_still_works_when_idle(monkeypatch):
    d = devices.Device("i", "build-box", "berat@h", "/r")
    monkeypatch.setattr(devices, "get_device", lambda _id: d)
    monkeypatch.setattr(devices, "set_active", lambda _id: d)
    api = _api()
    api._busy = False
    assert api.select_device("i")["ok"] is True


def test_add_device_surfaces_a_bad_target_as_an_error_not_a_crash(monkeypatch):
    # devices.add_device raises for a target ssh would read as an option; the
    # bridge must turn that into a message, not a pywebview traceback.
    res = _api().add_device("evil", "-oProxyCommand=calc.exe", "/r")
    assert res["ok"] is False and "option" in res["error"].lower()


if __name__ == "__main__":
    import types
    monkeypatch = types.SimpleNamespace(setattr=lambda o, n, v: setattr(o, n, v))
    _saved = (devices._active, devices.get_device, devices.set_active, devices.probe,
              agent_mod.build_file_tree, agent_mod._read_import_meta)
    tests = [(test_prompt_says_this_computer_when_local, False),
             (test_prompt_names_the_device_and_its_root, True),
             (test_selecting_a_device_records_it_in_the_transcript, True),
             (test_selecting_local_records_it_too, True),
             (test_active_device_is_persisted, True),
             (test_opening_a_project_without_a_saved_device_clears_a_stale_active_one, True),
             (test_test_device_returns_the_probe_result, True),
             (test_session_start_emits_device_changed_naming_the_device, True),
             (test_session_start_emits_device_changed_for_LOCAL_too, True),
             (test_device_changed_is_emitted_after_the_session_is_rebuilt, True),
             (test_the_frontend_handler_repaints_from_that_event, False),
             (test_select_device_refuses_while_the_agent_is_busy, True),
             (test_select_device_still_works_when_idle, True),
             (test_add_device_surfaces_a_bad_target_as_an_error_not_a_crash, True)]
    failed = 0
    for t, needs in tests:
        try:
            t(monkeypatch) if needs else t()
            print(f"PASS {t.__name__}")
        except Exception as e:
            failed += 1
            import traceback; traceback.print_exc()
            print(f"FAIL {t.__name__}: {e}")
        finally:
            (devices._active, devices.get_device, devices.set_active, devices.probe,
             agent_mod.build_file_tree, agent_mod._read_import_meta) = _saved
    print("OK" if not failed else f"{failed} FAILED")
    _sys.exit(1 if failed else 0)
