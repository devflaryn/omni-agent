"""Registered SSH devices — other machines the agent can run its toolset on.

A device is a host alias plus a remote project folder. NOTHING ELSE: this module
deliberately stores no credentials. Authentication is whatever the user's ssh
already does (agent, keys, ~/.ssh/config, jump hosts, ProxyCommand), which is
also why `target` may be a config alias rather than user@host.

This module must not import host_exec — the dependency runs the other way, so
that argv construction stays testable without touching process machinery.
"""
import json
import os
import threading
import uuid

DEVICES_PATH = os.path.join(os.path.expanduser("~"), ".omni-agent", "devices.json")

_FIELDS = ("id", "name", "target", "remote_root", "env_prelude", "notes")

# The active device is process-wide state, exactly like host_exec._workspace_root:
# one app, one place work happens at a time.
_active = None
_lock = threading.Lock()


class Device:
    """One registered machine. `target` is anything ssh accepts."""

    def __init__(self, id, name, target, remote_root, env_prelude="", notes=""):
        self.id = id
        self.name = name
        self.target = target
        self.remote_root = remote_root
        self.env_prelude = env_prelude or ""
        self.notes = notes or ""

    def to_dict(self):
        return {f: getattr(self, f) for f in _FIELDS}

    def __repr__(self):
        return f"<Device {self.name} ({self.target}):{self.remote_root}>"


def load_devices():
    """Every registered device. A missing or corrupt file yields [] — a broken
    registry must not stop the app from starting locally."""
    try:
        with open(DEVICES_PATH, "r", encoding="utf-8") as f:
            raw = json.load(f)
    except (OSError, ValueError):
        return []
    out = []
    for entry in (raw.get("devices") or []):
        try:
            out.append(Device(**{f: entry.get(f, "") for f in _FIELDS}))
        except TypeError:
            continue
    return out


def save_devices(devices):
    os.makedirs(os.path.dirname(DEVICES_PATH) or ".", exist_ok=True)
    tmp = DEVICES_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"version": 1, "devices": [d.to_dict() for d in devices]},
                  f, indent=2)
    os.replace(tmp, DEVICES_PATH)


def add_device(name, target, remote_root, env_prelude="", notes=""):
    d = Device(uuid.uuid4().hex[:12], name, target, remote_root, env_prelude, notes)
    all_ = load_devices()
    all_.append(d)
    save_devices(all_)
    return d


def get_device(device_id):
    for d in load_devices():
        if d.id == device_id:
            return d
    return None


def remove_device(device_id):
    all_ = load_devices()
    keep = [d for d in all_ if d.id != device_id]
    if len(keep) == len(all_):
        return False
    save_devices(keep)
    # A session pointing at a device that no longer exists would send commands
    # nowhere; drop back to local instead.
    with _lock:
        global _active
        if _active is not None and _active.id == device_id:
            _active = None
    return True


def set_active(device_id):
    """Select the machine work happens on. None means this computer."""
    global _active
    if device_id is None:
        with _lock:
            _active = None
        return None
    d = get_device(device_id)
    if d is None:
        raise KeyError(f"no such device: {device_id}")
    with _lock:
        _active = d
    return d


def active():
    return _active


def is_remote():
    return _active is not None


def active_root():
    """The REMOTE project folder, or None when running locally. Distinct from
    host_exec.workspace_root(), which is the LOCAL folder and returns None when
    a device is active."""
    return _active.remote_root if _active is not None else None
