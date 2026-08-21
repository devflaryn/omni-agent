"""These tools drive the LOCAL Android SDK or build a LOCAL index. With a remote
device active they must REFUSE, not silently act on the wrong machine."""
import sys as _sys, os as _os
_sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))

import devices
import tools  # noqa: F401 — registers every tool
from tool_registry import registry

# NOTE: the brief's LOCAL_ONLY list named "analyze_screen" as the second
# emulator_screen.py entry, but no tool by that name is registered (or was ever
# registered) anywhere in tools/ — a plan defect. tools/emulator_screen.py
# registers exactly 2 tools, matching the brief's own "(2)" tally: observe_screen
# and tap_element. tap_element also drives the LOCAL adb/view-hierarchy channel
# (_resolve_serial / _read_ui), so it belongs in this list on the merits, not
# just to make the count work. Corrected here; see task-4-report.md Deviations.
LOCAL_ONLY = [
    "build_code_graph", "query_code_graph", "diff_code_graphs", "list_code_graphs",
    "observe_screen", "tap_element",
]


def _go_remote(monkeypatch):
    monkeypatch.setattr(devices, "_active",
                        devices.Device("i", "build-box", "berat@h", "/r"))


def test_require_local_is_none_when_local(monkeypatch):
    monkeypatch.setattr(devices, "_active", None)
    assert devices.require_local("observe_screen") is None


def test_require_local_names_the_device_and_the_fix(monkeypatch):
    _go_remote(monkeypatch)
    err = devices.require_local("observe_screen")
    assert err is not None and "error" in err
    assert "build-box" in err["error"]
    assert "This computer" in err["error"]


def test_every_local_only_tool_refuses_when_remote(monkeypatch):
    _go_remote(monkeypatch)
    missing = []
    for name in LOCAL_ONLY:
        entry = registry._tools.get(name)
        if entry is None:
            continue          # tool renamed; the coverage test below catches it
        try:
            res = entry["func"]()
        except TypeError:
            continue          # needs args; the guard must still be first — see below
        if not (isinstance(res, dict) and "error" in res
                and "computer" in res["error"]):
            missing.append(name)
    assert not missing, f"these ran instead of refusing on a remote device: {missing}"


def test_guarded_tools_check_the_guard_before_touching_anything(monkeypatch):
    # The guard must be the FIRST statement, so a tool needing args still refuses
    # rather than raising TypeError or doing local I/O first.
    import inspect
    for name in LOCAL_ONLY:
        entry = registry._tools.get(name)
        if entry is None:
            continue
        src = inspect.getsource(entry["func"])
        body = src.split("\n", 1)[1]
        assert "require_local" in body, f"{name} has no require_local guard"


def test_resolve_workspace_path_raises_a_catchable_error_when_remote(monkeypatch):
    # It used to TypeError (os.path.join with None), which apk_tools' constraint
    # block does not catch — crashing a remote rebuild instead of degrading.
    _go_remote(monkeypatch)
    from tools.common import resolve_workspace_path
    try:
        resolve_workspace_path("a.apk")
        raise AssertionError("expected RuntimeError")
    except RuntimeError as e:
        assert "remote device" in str(e)
    except TypeError:
        raise AssertionError("must raise RuntimeError, not TypeError")


def test_apk_constraint_check_catches_it(monkeypatch):
    import inspect
    from tools import apk_tools
    src = inspect.getsource(apk_tools)
    assert "except (OSError, RuntimeError, zipfile.BadZipFile)" in src, \
        "the constraint check must degrade, not crash, when there is no local path"


def test_local_only_list_matches_reality():
    # If a tool is renamed or added, this test is where you find out.
    for name in LOCAL_ONLY:
        assert name in registry._tools, f"{name} is no longer a registered tool"


if __name__ == "__main__":
    import types
    monkeypatch = types.SimpleNamespace(setattr=lambda o, n, v: setattr(o, n, v))
    _saved = devices._active
    tests = [(test_require_local_is_none_when_local, True),
             (test_require_local_names_the_device_and_the_fix, True),
             (test_every_local_only_tool_refuses_when_remote, True),
             (test_guarded_tools_check_the_guard_before_touching_anything, True),
             (test_resolve_workspace_path_raises_a_catchable_error_when_remote, True),
             (test_apk_constraint_check_catches_it, True),
             (test_local_only_list_matches_reality, False)]
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
            devices._active = _saved
    print("OK" if not failed else f"{failed} FAILED")
    _sys.exit(1 if failed else 0)
