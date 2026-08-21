"""Offline tests for the device registry: persistence, the active-device state,
and the local-only guard. No network, no ssh."""
import sys as _sys, os as _os
_sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))

import json
import tempfile

import devices


def _isolate(monkeypatch):
    """Point the registry at a throwaway file and start with no active device."""
    d = tempfile.mkdtemp(prefix="omnidev-")
    path = _os.path.join(d, "devices.json")
    monkeypatch.setattr(devices, "DEVICES_PATH", path)
    devices.set_active(None)
    return path


def test_registry_is_empty_when_no_file_exists(monkeypatch):
    _isolate(monkeypatch)
    assert devices.load_devices() == []


def test_added_device_round_trips(monkeypatch):
    _isolate(monkeypatch)
    d = devices.add_device("build-box", "berat@10.0.0.5", "/home/berat/proj")
    again = devices.load_devices()
    assert len(again) == 1
    assert again[0].id == d.id
    assert again[0].name == "build-box"
    assert again[0].target == "berat@10.0.0.5"
    assert again[0].remote_root == "/home/berat/proj"


def test_ids_are_unique(monkeypatch):
    _isolate(monkeypatch)
    a = devices.add_device("a", "h1", "/r")
    b = devices.add_device("b", "h2", "/r")
    assert a.id != b.id


def test_remove_device(monkeypatch):
    _isolate(monkeypatch)
    d = devices.add_device("a", "h1", "/r")
    assert devices.remove_device(d.id) is True
    assert devices.load_devices() == []
    assert devices.remove_device(d.id) is False


def test_no_secret_fields_are_persisted(monkeypatch):
    # The app stores NO credentials. If a password ever appears in this file it
    # is a design violation, not a feature.
    path = _isolate(monkeypatch)
    devices.add_device("a", "h1", "/r", notes="hi")
    raw = json.load(open(path, encoding="utf-8"))
    keys = set(raw["devices"][0])
    assert keys == {"id", "name", "target", "remote_root", "env_prelude", "notes"}


def test_active_defaults_to_none_meaning_local(monkeypatch):
    _isolate(monkeypatch)
    assert devices.active() is None
    assert devices.is_remote() is False
    assert devices.active_root() is None


def test_set_active_selects_a_device(monkeypatch):
    _isolate(monkeypatch)
    d = devices.add_device("a", "h1", "/remote/root")
    got = devices.set_active(d.id)
    assert got.id == d.id
    assert devices.is_remote() is True
    assert devices.active_root() == "/remote/root"


def test_set_active_none_returns_to_local(monkeypatch):
    _isolate(monkeypatch)
    d = devices.add_device("a", "h1", "/r")
    devices.set_active(d.id)
    assert devices.set_active(None) is None
    assert devices.is_remote() is False


def test_set_active_unknown_id_raises(monkeypatch):
    _isolate(monkeypatch)
    try:
        devices.set_active("nope")
        raise AssertionError("expected KeyError")
    except KeyError as e:
        assert "nope" in str(e)


def test_removing_the_active_device_returns_to_local(monkeypatch):
    # Otherwise the session keeps pointing at a device that no longer exists.
    _isolate(monkeypatch)
    d = devices.add_device("a", "h1", "/r")
    devices.set_active(d.id)
    devices.remove_device(d.id)
    assert devices.active() is None


def test_corrupt_registry_degrades_to_empty(monkeypatch):
    path = _isolate(monkeypatch)
    with open(path, "w", encoding="utf-8") as f:
        f.write("{not json")
    assert devices.load_devices() == []


if __name__ == "__main__":
    import types
    monkeypatch = types.SimpleNamespace(setattr=lambda o, n, v: setattr(o, n, v))
    _orig = devices.DEVICES_PATH
    tests = [test_registry_is_empty_when_no_file_exists, test_added_device_round_trips,
             test_ids_are_unique, test_remove_device, test_no_secret_fields_are_persisted,
             test_active_defaults_to_none_meaning_local, test_set_active_selects_a_device,
             test_set_active_none_returns_to_local, test_set_active_unknown_id_raises,
             test_removing_the_active_device_returns_to_local,
             test_corrupt_registry_degrades_to_empty]
    failed = 0
    for t in tests:
        try:
            t(monkeypatch); print(f"PASS {t.__name__}")
        except Exception as e:
            failed += 1
            import traceback; traceback.print_exc()
            print(f"FAIL {t.__name__}: {e}")
        finally:
            devices.DEVICES_PATH = _orig
            devices.set_active(None)
    print("OK" if not failed else f"{failed} FAILED")
    _sys.exit(1 if failed else 0)
