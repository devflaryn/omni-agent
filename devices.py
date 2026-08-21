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


import shlex
import shutil

IS_WINDOWS = os.name == "nt"

# Multiplexing keeps one master connection alive so subsequent tool calls skip
# the TCP+auth handshake. Without it a workflow's hundreds of calls each pay it.
CONTROL_DIR = os.path.join(os.path.expanduser("~"), ".omni-agent", "ssh")
CONTROL_PERSIST = "600"
CONNECT_TIMEOUT = "10"

NO_SSH_MSG = (
    "No ssh client was found, so no command could run on the selected device.\n"
    "Install Git for Windows (which ships ssh) or OpenSSH, then reselect the device."
)

_ssh_path = None


def control_path():
    """ControlPath template. MUST resolve to under 108 bytes — the Unix-socket
    limit — or ssh refuses with 'ControlPath too long' and multiplexing silently
    never happens. `%C` is a 64-char hash of (local host, remote host, port,
    user), so the directory has to stay short."""
    return os.path.join(CONTROL_DIR, "%C")


def supports_multiplexing(ssh_path):
    """Windows OpenSSH cannot multiplex — it fails with 'getsockname failed: Not
    a socket'. It lives in System32, which is the same tell _find_posix_shell()
    uses to skip the WSL bash stub."""
    return "System32" not in (ssh_path or "").replace("/", "\\")


def find_ssh():
    """Absolute path of an ssh client, preferring the Git/MSYS one on Windows.

    Mirrors host_exec._find_posix_shell(): `git.exe` is the reliable anchor
    because its install carries usr/bin/ssh.exe, and Git is on virtually every
    Windows dev box. The System32 copy is a last resort — it works, but without
    connection multiplexing."""
    global _ssh_path
    if _ssh_path:
        return _ssh_path

    if not IS_WINDOWS:
        _ssh_path = shutil.which("ssh")
        return _ssh_path

    git = shutil.which("git")
    if git:
        root = os.path.dirname(os.path.dirname(git))
        for rel in (os.path.join("usr", "bin", "ssh.exe"), os.path.join("bin", "ssh.exe")):
            cand = os.path.join(root, rel)
            if os.path.isfile(cand):
                _ssh_path = cand
                return _ssh_path
    for cand in (r"C:\Program Files\Git\usr\bin\ssh.exe",
                 r"C:\msys64\usr\bin\ssh.exe"):
        if os.path.isfile(cand):
            _ssh_path = cand
            return _ssh_path
    _ssh_path = shutil.which("ssh")     # System32 fallback: no multiplexing
    return _ssh_path


def ssh_opts(ssh_path):
    opts = ["-o", "BatchMode=yes", "-o", f"ConnectTimeout={CONNECT_TIMEOUT}"]
    if supports_multiplexing(ssh_path):
        try:
            os.makedirs(CONTROL_DIR, exist_ok=True)
        except OSError:
            return opts
        opts += ["-o", "ControlMaster=auto",
                 "-o", f"ControlPath={control_path()}",
                 "-o", f"ControlPersist={CONTROL_PERSIST}"]
    return opts


def _pgid_file(tag):
    # Quoted for the REMOTE shell; ${TMPDIR:-/tmp} keeps it working on hosts
    # where /tmp is not the temp directory.
    return f'"${{TMPDIR:-/tmp}}/.omni-{tag}.pgid"'


def _wrapper(device, command, tag):
    """The script the remote bash runs. Order matters: record the pgid first so
    a reap can find us even if the command dies instantly."""
    f = _pgid_file(tag)
    lines = [
        f"echo $$ > {f}",
        f"trap 'rm -f {f}' EXIT",
        'export PATH="$HOME/.omni-agent/bin:$PATH"',
    ]
    prelude = (device.env_prelude or "").strip()
    if prelude:
        lines.append(prelude)
    # `|| exit 1` matters: without it a failed cd runs the command in the remote
    # HOME directory — the wrong folder, with no error.
    lines.append(f"cd {shlex.quote(device.remote_root)} || exit 1")
    lines.append(command)
    return "\n".join(lines)


def _one_remote_arg(script):
    """ssh joins every argument after the target with spaces and hands the result
    to the remote LOGIN shell, so the whole thing must be ONE already-quoted
    argument or it gets re-split on the far side."""
    return "bash -c " + shlex.quote(script)


def run_argv(device, command, tag, ssh_path=None):
    ssh = ssh_path or find_ssh()
    return [ssh, *ssh_opts(ssh), device.target, _one_remote_arg(_wrapper(device, command, tag))]


def reap_argv(device, tag, ssh_path=None):
    """Kill a still-running remote command by the process-group id its wrapper
    recorded. `kill -TERM -PID` signals the whole GROUP so children die too; the
    bare-PID fallback covers hosts where the remote bash is not a group leader."""
    ssh = ssh_path or find_ssh()
    f = _pgid_file(tag)
    script = (
        f'P=$(cat {f} 2>/dev/null); '
        f'if [ -n "$P" ]; then kill -TERM -"$P" 2>/dev/null || kill -TERM "$P" 2>/dev/null; fi; '
        f'sleep 1; '
        f'if [ -n "$P" ]; then kill -KILL -"$P" 2>/dev/null || kill -KILL "$P" 2>/dev/null; fi; '
        f'rm -f {f}; exit 0'
    )
    return [ssh, *ssh_opts(ssh), device.target, _one_remote_arg(script)]
