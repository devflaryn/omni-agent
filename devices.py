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
import re
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


def validate_target(target):
    """Raise ValueError if ssh would read `target` as an option rather than a
    host. A leading '-' is the whole attack: `-oProxyCommand=...` is a valid ssh
    option that runs an arbitrary LOCAL command, so a device whose target starts
    with '-' would execute on THIS machine — the exact wrong-machine failure the
    feature exists to prevent."""
    t = (target or "").strip()
    if not t:
        raise ValueError("A device needs an ssh target (user@host or a ~/.ssh/config alias).")
    if t.startswith("-"):
        raise ValueError(
            "An ssh target cannot start with '-' — ssh would read it as an option "
            "(e.g. -oProxyCommand=...) and run it on this computer instead of "
            "connecting. Use user@host or a ~/.ssh/config alias.")
    return t


def add_device(name, target, remote_root, env_prelude="", notes=""):
    target = validate_target(target)
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


# Anything outside this set is replaced before `tag` reaches the remote shell.
# The tag is interpolated inside a double-quoted shell word, where $, `, \ and "
# are all still live; today's only caller passes a hex uuid, but a filename
# built from caller-supplied text must not be one refactor away from command
# injection on another machine.
_TAG_UNSAFE = re.compile(r"[^A-Za-z0-9._-]")


def _pgid_file(tag):
    # Quoted for the REMOTE shell; ${TMPDIR:-/tmp} keeps it working on hosts
    # where /tmp is not the temp directory. The tag is sanitized (not shlex-
    # quoted) because the surrounding word must stay double-quoted for ${TMPDIR}
    # to expand at all.
    safe = _TAG_UNSAFE.sub("_", str(tag or "x"))
    return '"${TMPDIR:-/tmp}/.omni-' + safe + '.pgid"'


def _wrapper(device, command, tag):
    """The script the remote bash runs. Order matters: record the pgid first so
    a reap can find us even if the command dies instantly.

    `echo $$` is NOT the pgid. ssh hands `bash -c ...` to the remote LOGIN shell,
    so this bash is a CHILD of that shell and inherits its process group — it is
    not a group leader, and `kill -TERM -$$` therefore fails with "no such
    process". The reap would then fall back to the bare pid and kill only bash,
    leaving java/apktool/gradle children running after Stop or a timeout, which
    breaks the promise that a reap takes the whole tree down.

    So ask the kernel for the real group id via `ps -o pgid=`, which is POSIX and
    present on Linux, macOS and the BSDs. The fallback is `$$`: on a host with no
    usable ps the reap degrades to exactly today's behaviour rather than writing
    a garbage id that would make `kill` target an unrelated group."""
    f = _pgid_file(tag)
    lines = [
        # `tr -dc 0-9` rather than trimming spaces: ps pads its output differently
        # on Linux vs the BSDs, and a pgid is digits and nothing else.
        'P=$(ps -o pgid= -p $$ 2>/dev/null | tr -dc 0-9)',
        # Non-numeric or empty output means ps is missing/odd — degrade to $$.
        'case "$P" in ""|*[!0-9]*) P=$$;; esac',
        f'echo "$P" > {f}',
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
    recorded. `kill -TERM -P` signals the whole GROUP so children (java, apktool,
    gradle) die too, which is what the wrapper's `ps -o pgid=` lookup exists to
    make possible. The bare-`P` fallback covers the wrapper's own fallback — a
    host with no usable `ps`, where the recorded number is a bare pid."""
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


# What the probe checks for on the remote host. host_exec.REQUIRED_TOOLS plus
# curl, which remote download_file needs.
PROBE_TOOLS = ("java", "apktool", "jadx", "r2", "apksigner", "zipalign",
               "python3", "git", "curl")


def probe(device):
    """Connect once and learn everything selecting this device needs to know:
    that the remote root exists, what the machine is, and which tools are absent.

    One round trip on purpose — each extra connection is a handshake unless
    multiplexing is up, and at probe time it is not yet."""
    from host_exec import run_on   # imported here: host_exec imports THIS module

    checks = "; ".join(
        f'command -v {t} >/dev/null 2>&1 && echo OMNI_HAVE={t} || echo OMNI_MISS={t}'
        for t in PROBE_TOOLS)
    script = (
        f"mkdir -p {shlex.quote(device.remote_root)} && "
        f"cd {shlex.quote(device.remote_root)} && "
        'echo "OMNI_ROOT=$(pwd)"; '
        'echo "OMNI_UNAME=$(uname -a 2>/dev/null || echo unknown)"; '
        + checks
    )
    # run_on takes the device EXPLICITLY. Do not swap the global active device
    # around this call: the picker runs on the pywebview thread while the agent
    # loop runs on its own, so a concurrent tool call would be routed to the
    # device being tested instead of the one selected — the wrong-machine failure
    # the whole design exists to prevent.
    res = run_on(device, script, timeout=30)

    if res.get("error") or res.get("returncode"):
        return {"ok": False, "root": "", "uname": "", "missing": [],
                "error": res.get("error") or res.get("stderr") or "probe failed"}

    root, uname, missing = "", "", []
    for line in (res.get("stdout") or "").splitlines():
        line = line.strip()
        if line.startswith("OMNI_ROOT="):
            root = line[len("OMNI_ROOT="):]
        elif line.startswith("OMNI_UNAME="):
            uname = line[len("OMNI_UNAME="):]
        elif line.startswith("OMNI_MISS="):
            missing.append(line[len("OMNI_MISS="):])
    return {"ok": True, "root": root, "uname": uname, "missing": missing, "error": ""}


def require_local(feature):
    """None when running locally; an error dict when a device is active.

    Some tools drive the LOCAL Android SDK or build a LOCAL index, so they cannot
    follow the session to another machine. Refusing out loud is the same safety
    rule as never falling back to local: the failure a user can see beats the one
    that quietly used the wrong computer."""
    d = active()
    if d is None:
        return None
    return {"error": (
        f"{feature} runs on this computer only — the active device is "
        f"'{d.name}' ({d.target}). Switch to This computer in the device picker, "
        f"or register that machine's own host as the device."
    )}
