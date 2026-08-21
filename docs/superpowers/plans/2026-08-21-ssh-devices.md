# SSH Devices Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the agent run its toolset on another computer over SSH, by swapping the execution transport at `host_exec.run_cmd`.

**Architecture:** A new `devices.py` owns the device registry and builds `ssh` argv; `host_exec.run_cmd` dispatches local-vs-remote and hands the remote argv to the *existing* `_run_polling`, so process groups, Stop polling, the timeout decider and pipe draining all keep working unchanged. Paths need no translation because `normalize_path` already yields project-relative paths. Tools that bypass `run_cmd` refuse out loud rather than acting on the wrong machine.

**Tech Stack:** Python 3.14, stdlib only (`shlex`, `subprocess`, `json`, `threading`). The system `ssh` binary — no SSH library. Frontend is precompiled Tailwind + vanilla JS.

**Spec:** `docs/superpowers/specs/2026-08-21-ssh-devices-design.md` — read it before Task 1. The plan argues from the spec; both travel together.

## Global Constraints

Every task's requirements implicitly include this section.

- **No new Python dependencies.** stdlib only. `requirements.txt` must not change. No paramiko, no fabric.
- **Never silently fall back to local.** If a device is active and unreachable, commands fail loudly. A fallback runs the command on the wrong machine — the one catastrophic failure this feature can produce.
- **Nothing may bypass `host_exec.run_cmd`.** It is the single choke point; a second execution path breaks the whole design.
- **No secrets stored.** Auth is `~/.ssh/config` + agent + keys only. `BatchMode=yes` on every connection so a missing key fails fast instead of hanging on a prompt.
- **`ControlPath` must stay under 108 bytes** (the Unix-socket limit). `~/.omni-agent/ssh/%C` measures 95 and is verified to pass.
- **Prefer Git/MSYS `ssh` over Windows OpenSSH.** Windows OpenSSH 9.5p2 fails multiplexing with `getsockname failed: Not a socket`; Git/MSYS OpenSSH 10.2p1 works. Windows OpenSSH lives in `System32`, so the same `"System32" not in path` heuristic `_find_posix_shell()` already uses is the correct filter.
- **Tests run BOTH ways.** A test needing monkeypatching takes a parameter literally named `monkeypatch` (pytest fills it as its built-in fixture); the file's `if __name__ == "__main__":` runner passes a hand-rolled shim positionally. Never name it `mp` — pytest then fails collection with "fixture 'mp' not found". Every test file starts with the two-line `sys.path.insert` preamble.
- **Two verification commands.** Standalone: `.venv/Scripts/python.exe tests/test_x.py`. Whole suite: `.venv/Scripts/python.exe -m pytest tests/ -q --ignore=tests/frontend`.
- **The green bar is a FAILURE SET, not a count.** Exactly these three fail, pre-existing and environmental (they need `~/.omni-agent/bin`, never installed here):
  - `tests/test_fs_api.py::test_symlink_out_of_the_workspace_is_rejected`
  - `tests/test_host_exec.py::test_tool_directory_is_on_path[plain]`
  - `tests/test_host_exec.py::test_tool_directory_is_on_path[with space]`

  The passed count rises with every task — assert the failure SET, never a number.
- **`.gitignore` contains `/tests/`.** A new test file needs `git add -f` or it is silently never committed. Verify with `git ls-files --error-unmatch <path>`.
- **Frontend styling.** Component classes go in the `<style>` block of `frontend/index.html` (NOT `tailwind.input.css`, which is three `@tailwind` lines). Tailwind utilities are generated only from files in `tailwind.config.js`'s `content` globs. Rebuild from `frontend/`: `npx tailwindcss@3 -c tailwind.config.js -i tailwind.input.css -o tailwind.css --minify`.
- **Registering a tool takes three edits** (only relevant if a task adds one): `tool_registry.py` group map, `import tools.<mod>` in `tools/__init__.py`, and a `TOOL_META` entry in `frontend/app.js`.
- **Commit after every task.** Branch is `ssh-devices`.

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `devices.py` | Device dataclass, JSON registry, active-device state, ssh binary discovery, argv construction (run + reap), the connect probe, `require_local()`. Pure — imports nothing from `host_exec` (that direction only). |
| `tests/test_devices.py` | Registry, argv construction against a fake ssh, quoting torture. |
| `tests/test_host_exec_remote.py` | Dispatch, never-fall-back, reap, the 255 disambiguation. |
| `tests/test_local_only_guards.py` | `require_local`, the guarded tools, `workspace_root()` → `None`, remote `download_file`. |
| `tests/test_remote_fs_api.py` | Remote tree parsing and file reads. |

**Modified:**

| File | Change |
|---|---|
| `host_exec.py` | `run_cmd` dispatch; `_run_remote`; `workspace_root()` returns `None` when remote; background reap. |
| `tools/code_graph.py`, `tools/emulator_screen.py`, `tools/vision_tools.py`, `tools/frida_tools.py`, `tools/roblox_session.py`, `tools/hook_verification.py`, `tools/session_bootstrap.py` | One `require_local()` guard each at tool entry. |
| `tools/web_tools.py` | `download_file` uses `curl` through `run_cmd` when remote. |
| `agent.py` | Remote `build_file_tree` / `read_project_file`; device bridge methods; prompt line; transcript notice; persist the active device. |
| `frontend/index.html`, `frontend/app.js` | Device chip + picker. |
| `AGENTS.md` | A section explaining the transport and what does not go remote. |

---

### Task 1: The device registry

**Files:**
- Create: `devices.py`
- Test: `tests/test_devices.py`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `class Device` with attributes `id, name, target, remote_root, env_prelude, notes`, plus `to_dict()`.
  - `load_devices() -> list[Device]`, `save_devices(list[Device]) -> None`, `add_device(name, target, remote_root, env_prelude="", notes="") -> Device`, `remove_device(device_id) -> bool`, `get_device(device_id) -> Device | None`
  - `set_active(device_id_or_None) -> Device | None`, `active() -> Device | None`, `is_remote() -> bool`, `active_root() -> str | None`
  - `DEVICES_PATH`

- [ ] **Step 1: Write the failing test**

Create `tests/test_devices.py`:

```python
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/Scripts/python.exe tests/test_devices.py`
Expected: FAIL — `ModuleNotFoundError: No module named 'devices'`

- [ ] **Step 3: Write minimal implementation**

Create `devices.py`:

```python
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `.venv/Scripts/python.exe tests/test_devices.py`
Expected: 11 × `PASS`, then `OK`, exit 0

- [ ] **Step 5: Commit**

```bash
git add -f devices.py tests/test_devices.py
git commit -m "feat(devices): SSH device registry with no stored credentials"
```

---

### Task 2: ssh discovery and argv construction

**Files:**
- Modify: `devices.py`
- Modify: `tests/test_devices.py` (append tests + runner entries)

**Interfaces:**
- Consumes: `Device` from Task 1.
- Produces:
  - `find_ssh() -> str | None` — absolute path, preferring Git/MSYS over Windows OpenSSH.
  - `supports_multiplexing(ssh_path) -> bool`
  - `CONTROL_DIR`, `control_path() -> str`
  - `ssh_opts(ssh_path) -> list[str]`
  - `run_argv(device, command, tag, ssh_path=None) -> list[str]`
  - `reap_argv(device, tag, ssh_path=None) -> list[str]`
  - `NO_SSH_MSG`

- [ ] **Step 1: Write the failing test**

Append to `tests/test_devices.py` before the `__main__` block:

```python
import shlex


def _dev():
    return devices.Device("id1", "box", "berat@10.0.0.5", "/home/berat/my proj")


def test_control_path_is_under_the_108_byte_socket_limit():
    # MSYS ssh rejects a longer ControlPath outright ("ControlPath too long"),
    # which silently disables multiplexing and makes every tool call pay a full
    # handshake.
    cp = devices.control_path()
    resolved = cp.replace("%C", "c" * 64)   # %C expands to a 64-char hash
    assert len(resolved) < 108, f"{len(resolved)} bytes: {resolved}"


def test_multiplexing_is_disabled_for_windows_openssh():
    # Windows OpenSSH fails multiplexing with "getsockname failed: Not a socket".
    assert devices.supports_multiplexing(r"C:\Windows\System32\OpenSSH\ssh.exe") is False
    assert devices.supports_multiplexing("/usr/bin/ssh") is True


def test_opts_include_batchmode_so_a_missing_key_fails_fast():
    opts = devices.ssh_opts("/usr/bin/ssh")
    assert "BatchMode=yes" in opts


def test_opts_include_multiplexing_when_supported():
    opts = devices.ssh_opts("/usr/bin/ssh")
    joined = " ".join(opts)
    assert "ControlMaster=auto" in joined and "ControlPersist=" in joined


def test_opts_omit_multiplexing_on_windows_openssh():
    opts = devices.ssh_opts(r"C:\Windows\System32\OpenSSH\ssh.exe")
    joined = " ".join(opts)
    assert "ControlMaster" not in joined and "ControlPath" not in joined


def test_run_argv_shape():
    argv = devices.run_argv(_dev(), "ls -la", "tag123", ssh_path="/usr/bin/ssh")
    assert argv[0] == "/usr/bin/ssh"
    assert "berat@10.0.0.5" in argv
    # Everything after the target is ONE argument: ssh joins extra args with
    # spaces and hands them to the remote login shell, so a multi-arg command
    # would be re-split and break on any space.
    assert argv[-1].startswith("bash -c ")
    assert len(argv) == argv.index("berat@10.0.0.5") + 2


def test_remote_root_with_spaces_is_quoted():
    argv = devices.run_argv(_dev(), "ls", "t", ssh_path="/usr/bin/ssh")
    inner = shlex.split(argv[-1])[-1]     # the wrapper script
    assert "cd '/home/berat/my proj'" in inner


def test_command_with_quotes_and_dollars_survives():
    cmd = """grep -r "it's $HOME" . | head -5"""
    argv = devices.run_argv(_dev(), cmd, "t", ssh_path="/usr/bin/ssh")
    inner = shlex.split(argv[-1])[-1]
    assert cmd in inner, "the command must reach the remote shell unmodified"


def test_wrapper_records_its_pgid_and_traps_exit():
    argv = devices.run_argv(_dev(), "ls", "tag123", ssh_path="/usr/bin/ssh")
    inner = shlex.split(argv[-1])[-1]
    assert "tag123" in inner
    assert "trap" in inner and "EXIT" in inner


def test_wrapper_prepends_the_remote_tool_bin():
    argv = devices.run_argv(_dev(), "ls", "t", ssh_path="/usr/bin/ssh")
    inner = shlex.split(argv[-1])[-1]
    assert '$HOME/.omni-agent/bin' in inner


def test_wrapper_runs_env_prelude_when_set():
    d = devices.Device("i", "n", "h", "/r", env_prelude="source ~/.nvm/nvm.sh")
    inner = shlex.split(devices.run_argv(d, "ls", "t", ssh_path="/usr/bin/ssh")[-1])[-1]
    assert "source ~/.nvm/nvm.sh" in inner


def test_wrapper_aborts_when_cd_fails():
    # Without this the command would run in the remote HOME directory — the
    # wrong folder, silently.
    inner = shlex.split(devices.run_argv(_dev(), "rm -rf build", "t",
                                         ssh_path="/usr/bin/ssh")[-1])[-1]
    assert "|| exit 1" in inner


def test_reap_argv_targets_the_recorded_pgid():
    argv = devices.reap_argv(_dev(), "tag123", ssh_path="/usr/bin/ssh")
    inner = shlex.split(argv[-1])[-1]
    assert "tag123" in inner
    assert "kill -TERM" in inner and "kill -KILL" in inner


def test_reap_kills_the_group_then_falls_back_to_the_pid():
    # `kill -TERM -PID` signals the process GROUP, so children die too; but the
    # remote bash is only a group leader when sshd gave it its own session, so
    # the bare-PID fallback matters.
    inner = shlex.split(devices.reap_argv(_dev(), "t", ssh_path="/usr/bin/ssh")[-1])[-1]
    assert '-"$P"' in inner and '"$P"' in inner
```

Add all 14 names to the `__main__` runner list. Note these take no `monkeypatch`, so call them as `t()`; adjust the runner to a `(test, needs_monkeypatch)` list like `tests/test_workflow_tool.py` does.

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/Scripts/python.exe tests/test_devices.py`
Expected: FAIL — `AttributeError: module 'devices' has no attribute 'control_path'`

- [ ] **Step 3: Write minimal implementation**

Append to `devices.py`:

```python
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `.venv/Scripts/python.exe tests/test_devices.py`
Expected: 25 × `PASS`, then `OK`, exit 0

- [ ] **Step 5: Commit**

```bash
git add -f devices.py tests/test_devices.py
git commit -m "feat(devices): ssh discovery preferring MSYS, multiplexed argv, tag-and-reap"
```

---

### Task 3: Dispatch in `run_cmd`

**Files:**
- Modify: `host_exec.py` — imports, `workspace_root()` (line 121), `run_cmd` (line 354)
- Test: `tests/test_host_exec_remote.py`

**Interfaces:**
- Consumes: `devices.active()`, `devices.run_argv`, `devices.reap_argv`, `devices.find_ssh`, `devices.NO_SSH_MSG`.
- Produces: `host_exec.run_cmd` routes remote; `host_exec.workspace_root()` returns `None` when a device is active; `host_exec._SSH_ERROR_SIGNATURES`.

- [ ] **Step 1: Write the failing test**

Create `tests/test_host_exec_remote.py`:

```python
"""Offline tests for remote dispatch. A fake _run_polling captures the argv that
WOULD have run, so no ssh and no network are involved."""
import sys as _sys, os as _os
_sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))

import devices
import host_exec


def _remote(monkeypatch, **over):
    d = devices.Device("i1", "box", "berat@h", over.pop("root", "/remote/root"))
    monkeypatch.setattr(devices, "_active", d)
    monkeypatch.setattr(devices, "find_ssh", lambda: "/usr/bin/ssh")
    return d


def _capture(monkeypatch, result=None):
    seen = {}

    def fake(cmd, timeout, display, timeout_msg, cwd=None):
        seen["cmd"] = cmd
        seen["cwd"] = cwd
        seen["display"] = display
        return result if result is not None else {"stdout": "ok", "stderr": "", "returncode": 0}

    monkeypatch.setattr(host_exec, "_run_polling", fake)
    return seen


def test_local_path_is_unchanged_when_no_device_is_active(monkeypatch):
    monkeypatch.setattr(devices, "_active", None)
    monkeypatch.setattr(host_exec, "_workspace_root", _os.getcwd())
    seen = _capture(monkeypatch)
    host_exec.run_cmd("echo hi")
    assert seen["cwd"] == _os.getcwd(), "local runs still set cwd to the workspace"
    assert seen["cmd"][-1] == "echo hi"


def test_remote_builds_an_ssh_argv(monkeypatch):
    _remote(monkeypatch)
    seen = _capture(monkeypatch)
    host_exec.run_cmd("echo hi")
    assert seen["cmd"][0] == "/usr/bin/ssh"
    assert "berat@h" in seen["cmd"]
    assert seen["cwd"] is None, "cwd is meaningless for a remote command"


def test_remote_display_is_the_original_command(monkeypatch):
    # The timeout decider shows `display` to the user; an ssh argv would be noise.
    _remote(monkeypatch)
    seen = _capture(monkeypatch)
    host_exec.run_cmd("make -j8")
    assert seen["display"] == "make -j8"


def test_remote_does_not_require_a_local_workspace(monkeypatch):
    _remote(monkeypatch)
    monkeypatch.setattr(host_exec, "_workspace_root", None)
    seen = _capture(monkeypatch)
    res = host_exec.run_cmd("echo hi")
    assert res["returncode"] == 0
    assert seen["cmd"][0] == "/usr/bin/ssh"


def test_missing_ssh_never_falls_back_to_local(monkeypatch):
    # THE critical safety rule: a fallback would run the command on the WRONG
    # machine. It must fail loudly instead.
    _remote(monkeypatch)
    monkeypatch.setattr(devices, "find_ssh", lambda: None)
    ran = {"n": 0}
    monkeypatch.setattr(host_exec, "_run_polling",
                        lambda *a, **k: ran.__setitem__("n", ran["n"] + 1))
    res = host_exec.run_cmd("rm -rf build")
    assert ran["n"] == 0, "nothing may execute when ssh is unavailable"
    assert res["returncode"] != 0 and "error" in res


def test_workspace_root_is_none_when_remote(monkeypatch):
    # Its callers do LOCAL file I/O on the returned path; None turns "operates on
    # a path that does not exist here" into a clean refusal.
    monkeypatch.setattr(host_exec, "_workspace_root", "/local/root")
    monkeypatch.setattr(devices, "_active", None)
    assert host_exec.workspace_root() == "/local/root"
    _remote(monkeypatch)
    assert host_exec.workspace_root() is None


def test_ssh_transport_failure_is_reported_as_a_device_error(monkeypatch):
    _remote(monkeypatch)
    _capture(monkeypatch, result={"stdout": "", "returncode": 255,
                                  "stderr": "ssh: connect to host h port 22: Connection refused"})
    res = host_exec.run_cmd("echo hi")
    assert "error" in res and "box" in res["error"]


def test_a_genuine_255_exit_is_passed_through(monkeypatch):
    # A command may legitimately exit 255; only ssh's own stderr signatures mark
    # a transport failure.
    _remote(monkeypatch)
    _capture(monkeypatch, result={"stdout": "out", "returncode": 255,
                                  "stderr": "my tool failed"})
    res = host_exec.run_cmd("mytool")
    assert res["returncode"] == 255 and "error" not in res


def test_stop_fires_a_background_reap(monkeypatch):
    _remote(monkeypatch)
    _capture(monkeypatch, result={"stdout": "", "stderr": "[stopped by user]",
                                  "returncode": 130, "stopped": True})
    reaped = []
    monkeypatch.setattr(host_exec, "_spawn_reap", lambda dev, tag: reaped.append(tag))
    res = host_exec.run_cmd("sleep 999")
    assert res.get("stopped") is True
    assert len(reaped) == 1, "a stopped remote command must be reaped"


def test_timeout_fires_a_background_reap(monkeypatch):
    _remote(monkeypatch)
    _capture(monkeypatch, result={"stdout": "", "stderr": "",
                                  "error": "Command timed out after 60s."})
    reaped = []
    monkeypatch.setattr(host_exec, "_spawn_reap", lambda dev, tag: reaped.append(tag))
    host_exec.run_cmd("sleep 999")
    assert len(reaped) == 1


def test_a_successful_command_is_not_reaped(monkeypatch):
    _remote(monkeypatch)
    _capture(monkeypatch)
    reaped = []
    monkeypatch.setattr(host_exec, "_spawn_reap", lambda dev, tag: reaped.append(tag))
    host_exec.run_cmd("echo hi")
    assert reaped == []


if __name__ == "__main__":
    import types
    monkeypatch = types.SimpleNamespace(setattr=lambda o, n, v: setattr(o, n, v))
    _saved = {"active": devices._active, "polling": host_exec._run_polling,
              "root": host_exec._workspace_root, "find": devices.find_ssh}
    tests = [test_local_path_is_unchanged_when_no_device_is_active,
             test_remote_builds_an_ssh_argv, test_remote_display_is_the_original_command,
             test_remote_does_not_require_a_local_workspace,
             test_missing_ssh_never_falls_back_to_local,
             test_workspace_root_is_none_when_remote,
             test_ssh_transport_failure_is_reported_as_a_device_error,
             test_a_genuine_255_exit_is_passed_through,
             test_stop_fires_a_background_reap, test_timeout_fires_a_background_reap,
             test_a_successful_command_is_not_reaped]
    failed = 0
    for t in tests:
        try:
            t(monkeypatch); print(f"PASS {t.__name__}")
        except Exception as e:
            failed += 1
            import traceback; traceback.print_exc()
            print(f"FAIL {t.__name__}: {e}")
        finally:
            devices._active = _saved["active"]
            devices.find_ssh = _saved["find"]
            host_exec._run_polling = _saved["polling"]
            host_exec._workspace_root = _saved["root"]
    print("OK" if not failed else f"{failed} FAILED")
    _sys.exit(1 if failed else 0)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/Scripts/python.exe tests/test_host_exec_remote.py`
Expected: FAIL — `AttributeError: module 'host_exec' has no attribute '_spawn_reap'`

- [ ] **Step 3: Write minimal implementation**

In `host_exec.py`, add near the top imports:

```python
import uuid

import devices
```

Change `workspace_root()` (line 121) to:

```python
def workspace_root():
    """Absolute path of the active project folder, or None when a remote device
    is active.

    None is deliberate: there is no host-side folder then, and this function's
    callers (tools/common.resolve_workspace_path, code_graph, web_tools) do
    in-process LOCAL file I/O on the returned path. None turns "silently operates
    on a path that does not exist here" into a refusal."""
    if devices.is_remote():
        return None
    if _workspace_root is None:
        raise RuntimeError("No active project folder — set_workspace() hasn't been called yet.")
    return _workspace_root
```

The local branch is byte-for-byte the CURRENT body (it RAISES on `None` — do not
change that; callers catch `RuntimeError`). Only the remote branch is new.

Add above `run_cmd`:

```python
# ssh's own failure modes, used to tell a transport error from a command that
# legitimately exited 255. The residual ambiguity — a command that exits 255 AND
# prints one of these — is accepted knowingly; there is no in-band way to
# separate them without polluting stdout.
_SSH_ERROR_SIGNATURES = (
    "ssh: connect to host",
    "Permission denied",
    "Connection closed by",
    "Connection timed out",
    "kex_exchange_identification",
    "Host key verification failed",
    "Could not resolve hostname",
)


def _spawn_reap(device, tag):
    """Kill the remote command in the background. Never blocks the Stop path —
    the user's Stop must feel instant even if the reap connection hangs."""
    def work():
        try:
            subprocess.run(devices.reap_argv(device, tag), timeout=20,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except Exception:
            pass
    threading.Thread(target=work, daemon=True).start()


def _run_remote(command, timeout, device):
    ssh = devices.find_ssh()
    if not ssh:
        # NEVER fall back to local: that would run the command on the wrong
        # machine, which is the one catastrophic failure this feature can cause.
        return {"stdout": "", "stderr": "no ssh client", "returncode": 127,
                "error": devices.NO_SSH_MSG}

    tag = uuid.uuid4().hex[:12]
    argv = devices.run_argv(device, command, tag, ssh_path=ssh)
    timeout_msg = ("Command timed out after {elapsed}s on device '" + device.name +
                   "'. Try a lighter command or break the task into smaller steps.")
    res = _run_polling(argv, timeout, display=command,
                       timeout_msg=timeout_msg, cwd=None)

    if res.get("stopped") or res.get("error"):
        _spawn_reap(device, tag)

    if res.get("returncode") == 255:
        err = res.get("stderr") or ""
        if any(sig in err for sig in _SSH_ERROR_SIGNATURES):
            res["error"] = (
                f"Could not reach device '{device.name}' ({device.target}):\n"
                f"  {err.strip().splitlines()[0] if err.strip() else 'connection failed'}\n"
                "No command ran. Check the host is up and your ssh key works "
                f"(`ssh {device.target} true`), then retry."
            )
    return res
```

And dispatch at the top of `run_cmd`, BEFORE the local workspace checks:

```python
def run_cmd(command, timeout=DEFAULT_TIMEOUT):
    device = devices.active()
    if device is not None:
        return _run_remote(command, timeout, device)
    if _workspace_root is None:
        ...   # unchanged from here down
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/Scripts/python.exe tests/test_host_exec_remote.py`
Expected: 11 × `PASS`, then `OK`, exit 0

Run: `.venv/Scripts/python.exe -m pytest tests/ -q --ignore=tests/frontend`
Expected: exactly the 3 pre-existing environmental failures from Global Constraints and NO others.

Run: `.venv/Scripts/python.exe -c "import agent; print('agent imports ok')"`
Expected: `agent imports ok` (guards against an import cycle between `host_exec` and `devices`).

- [ ] **Step 5: Commit**

```bash
git add -f host_exec.py tests/test_host_exec_remote.py
git commit -m "feat(host_exec): dispatch run_cmd to a remote device, never falling back to local"
```

---

### Task 4: The connect probe

**Files:**
- Modify: `devices.py`
- Modify: `tests/test_devices.py`

**Interfaces:**
- Consumes: `host_exec.run_cmd` (imported INSIDE the function — `host_exec` imports `devices`, so a module-level import here would be a cycle).
- Produces: `probe(device) -> dict` with keys `ok, root, uname, missing, error`; `PROBE_TOOLS`.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_devices.py`:

```python
def test_probe_parses_root_uname_and_missing_tools(monkeypatch):
    out = "\n".join([
        "OMNI_ROOT=/home/berat/proj",
        "OMNI_UNAME=Linux buildbox 6.1.0 x86_64",
        "OMNI_HAVE=java",
        "OMNI_MISS=apktool",
        "OMNI_HAVE=git",
        "OMNI_MISS=curl",
    ])
    import host_exec
    monkeypatch.setattr(host_exec, "run_cmd",
                        lambda cmd, timeout=None: {"stdout": out, "stderr": "", "returncode": 0})
    res = devices.probe(devices.Device("i", "n", "h", "/home/berat/proj"))
    assert res["ok"] is True
    assert res["root"] == "/home/berat/proj"
    assert "Linux buildbox" in res["uname"]
    assert set(res["missing"]) == {"apktool", "curl"}


def test_probe_reports_failure_without_raising(monkeypatch):
    import host_exec
    monkeypatch.setattr(host_exec, "run_cmd",
                        lambda cmd, timeout=None: {"stdout": "", "stderr": "boom",
                                                   "returncode": 255,
                                                   "error": "could not reach device"})
    res = devices.probe(devices.Device("i", "n", "h", "/r"))
    assert res["ok"] is False and "could not reach" in res["error"]


def test_probe_checks_curl_for_remote_downloads():
    assert "curl" in devices.PROBE_TOOLS
```

Add the three names to the runner.

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/Scripts/python.exe tests/test_devices.py`
Expected: FAIL — `AttributeError: module 'devices' has no attribute 'probe'`

- [ ] **Step 3: Write minimal implementation**

Append to `devices.py`:

```python
# What the probe checks for on the remote host. host_exec.REQUIRED_TOOLS plus
# curl, which remote download_file needs.
PROBE_TOOLS = ("java", "apktool", "jadx", "r2", "apksigner", "zipalign",
               "python3", "git", "curl")


def probe(device):
    """Connect once and learn everything selecting this device needs to know:
    that the remote root exists, what the machine is, and which tools are absent.

    One round trip on purpose — each extra connection is a handshake unless
    multiplexing is up, and at probe time it is not yet."""
    from host_exec import run_cmd   # imported here: host_exec imports THIS module

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
    prev = _active
    try:
        # Probe the device being tested, which is not necessarily the active one
        # (the picker's "Test connection" runs against an unselected device).
        globals()["_active"] = device
        res = run_cmd(script, timeout=30)
    finally:
        globals()["_active"] = prev

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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `.venv/Scripts/python.exe tests/test_devices.py`
Expected: 28 × `PASS`, then `OK`

- [ ] **Step 5: Commit**

```bash
git add -f devices.py tests/test_devices.py
git commit -m "feat(devices): one-round-trip connect probe reporting root, uname and missing tools"
```

---

### Task 5: Local-only guards

**Files:**
- Modify: `devices.py` (add `require_local`)
- Modify: `tools/code_graph.py`, `tools/emulator_screen.py`, `tools/vision_tools.py`, `tools/frida_tools.py`, `tools/roblox_session.py`, `tools/hook_verification.py`, `tools/session_bootstrap.py`
- Test: `tests/test_local_only_guards.py`

**Interfaces:**
- Consumes: `devices.active()`.
- Produces: `devices.require_local(feature) -> dict | None`.

- [ ] **Step 1: Write the failing test**

Create `tests/test_local_only_guards.py`:

```python
"""These tools drive the LOCAL Android SDK or build a LOCAL index. With a remote
device active they must REFUSE, not silently act on the wrong machine."""
import sys as _sys, os as _os
_sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))

import devices
import tools  # noqa: F401 — registers every tool
from tool_registry import registry

LOCAL_ONLY = [
    "build_code_graph", "query_code_graph", "diff_code_graphs", "list_code_graphs",
    "observe_screen", "analyze_screen",
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
    assert "except (OSError, RuntimeError, zipfile.BadZipFile)" in src,         "the constraint check must degrade, not crash, when there is no local path"


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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/Scripts/python.exe tests/test_local_only_guards.py`
Expected: FAIL — `AttributeError: module 'devices' has no attribute 'require_local'`

- [ ] **Step 3: Write minimal implementation**

Append to `devices.py`:

```python
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
```

Then add, as the **first statement** of every tool function in the LOCAL_ONLY list and their siblings in the same modules:

```python
    _err = devices.require_local("observe_screen")   # <- this tool's own name
    if _err:
        return _err
```

with `import devices` at the top of each module. Apply to every registered tool in: `tools/code_graph.py` (4), `tools/emulator_screen.py` (2), `tools/vision_tools.py` (1), `tools/frida_tools.py` (4), `tools/roblox_session.py` (5), `tools/hook_verification.py` (1), `tools/session_bootstrap.py` (1).

**Then two more edits, which are NOT optional — without them a remote APK rebuild crashes instead of degrading.**

`workspace_root()` now returns `None` when remote (Task 3), and `tools/common.resolve_workspace_path()` does `os.path.join(host_root, rel)` with it — which raises `TypeError`, not the `OSError` its callers catch. Make the failure the one callers already handle:

```python
def resolve_workspace_path(path):
    from host_exec import workspace_root
    rel = normalize_path(path)
    host_root = workspace_root()
    if host_root is None:
        # A remote device is active, so there is no local path for this file.
        raise RuntimeError(
            "no local workspace: a remote device is active, so this file has no "
            "path on this computer")
    if rel == ".":
        return host_root
    return os.path.normpath(os.path.join(host_root, rel))
```

Then widen the catch in `tools/apk_tools.py` (around line 513) so the post-build constraint check degrades with its EXISTING message instead of crashing the rebuild:

```python
    except (OSError, RuntimeError, zipfile.BadZipFile) as e:
```

This matters because `apk_tools` is otherwise fully remote-capable (27 `run_cmd` calls against 3 local ones), and APK work is what this project exists for — a crash here would make the headline use case unusable on a device.

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/Scripts/python.exe tests/test_local_only_guards.py`
Expected: 7 × `PASS`, then `OK`

Run: `.venv/Scripts/python.exe -m pytest tests/ -q --ignore=tests/frontend`
Expected: exactly the 3 pre-existing failures, no others.

- [ ] **Step 5: Commit**

```bash
git add -f devices.py tools/ tests/test_local_only_guards.py
git commit -m "feat(devices): local-only tools refuse on a remote device instead of acting"
```

---

### Task 6: Remote `download_file`

**Files:**
- Modify: `tools/web_tools.py`
- Modify: `tests/test_local_only_guards.py`

**Interfaces:**
- Consumes: `devices.is_remote()`, `devices.active_root()`, `host_exec.run_cmd`, `tools.common.wpath`.
- Produces: no new names; `download_file` gains a remote branch.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_local_only_guards.py`:

```python
def test_download_file_uses_curl_on_the_device(monkeypatch):
    # Fetching with in-process requests would land the file on THIS machine —
    # the wrong one.
    _go_remote(monkeypatch)
    from tools import web_tools
    import host_exec
    seen = {}
    monkeypatch.setattr(host_exec, "run_cmd",
                        lambda cmd, timeout=None: seen.setdefault("cmd", cmd)
                        or {"stdout": "", "stderr": "", "returncode": 0})
    monkeypatch.setattr(web_tools, "run_cmd",
                        lambda cmd, timeout=None: seen.setdefault("cmd", cmd)
                        or {"stdout": "", "stderr": "", "returncode": 0})
    web_tools.download_file("https://example.com/a.apk", dest="downloads/a.apk")
    assert "curl" in seen["cmd"]
    assert "https://example.com/a.apk" in seen["cmd"]
    assert "downloads/a.apk" in seen["cmd"]


def test_download_file_still_uses_requests_when_local(monkeypatch):
    monkeypatch.setattr(devices, "_active", None)
    from tools import web_tools
    called = {"curl": 0}
    monkeypatch.setattr(web_tools, "run_cmd",
                        lambda *a, **k: called.__setitem__("curl", 1) or {})
    try:
        web_tools.download_file("https://example.invalid/x", dest="x")
    except Exception:
        pass
    assert called["curl"] == 0, "the local path must not shell out to curl"
```

Add both names to the runner.

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/Scripts/python.exe tests/test_local_only_guards.py`
Expected: FAIL — `KeyError: 'cmd'` (the remote branch does not exist yet)

- [ ] **Step 3: Write minimal implementation**

In `tools/web_tools.py`, add `import devices` and `from host_exec import run_cmd` at the top, then at the start of `download_file`'s body (after the `max_mb` parsing, before `workspace_root()` is consulted):

```python
    if devices.is_remote():
        # Fetch ON the device: an in-process download would put the file on this
        # machine, which is not where the agent is working.
        rel = normalize_path(dest) if dest else _os.path.basename(url) or "download"
        cmd = (f"mkdir -p \"$(dirname {wpath(rel)})\" && "
               f"curl -fL --max-filesize {max_bytes} "
               f"-o {wpath(rel)} {shlex.quote(url)}")
        res = run_cmd(cmd, timeout=600)
        if res.get("error") or res.get("returncode"):
            return {"error": (f"download_file failed on the device: "
                              f"{res.get('error') or res.get('stderr') or 'curl failed'}")}
        return {"ok": True, "path": rel, "device": devices.active().name,
                "note": "downloaded on the active device, not this computer"}
```

Import `shlex` at the top of the module if it is not already imported.

- [ ] **Step 4: Run test to verify it passes**

Run: `.venv/Scripts/python.exe tests/test_local_only_guards.py`
Expected: 9 × `PASS`, then `OK`

- [ ] **Step 5: Commit**

```bash
git add -f tools/web_tools.py tests/test_local_only_guards.py
git commit -m "feat(web_tools): download_file fetches on the active device via curl"
```

---

### Task 7: Remote file tree

**Files:**
- Modify: `agent.py` — `build_file_tree` (line 1030)
- Test: `tests/test_remote_fs_api.py`

**Interfaces:**
- Consumes: `devices.is_remote()`, `host_exec.run_cmd`.
- Produces: `agent._remote_file_tree(project_name) -> dict`, `agent._parse_find_output(text, project_name) -> dict` (pure, so it is testable without ssh).

- [ ] **Step 1: Write the failing test**

Create `tests/test_remote_fs_api.py`:

```python
"""The UI tree and viewer must follow the active device — a sidebar showing a
different machine than the agent is working on is worse than no sidebar."""
import sys as _sys, os as _os
_sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))

import agent
import devices

FIND_OUTPUT = "\n".join([
    "d\t.",
    "d\tsrc",
    "d\tsrc/util",
    "f\tREADME.md",
    "f\tsrc/main.py",
    "f\tsrc/util/helpers.py",
])


def test_find_output_becomes_a_nested_tree():
    tree = agent._parse_find_output(FIND_OUTPUT, "proj")
    assert tree["name"] == "proj" and tree["type"] == "dir"
    names = {c["name"]: c for c in tree["children"]}
    assert set(names) == {"src", "README.md"}
    assert names["src"]["type"] == "dir"
    assert names["README.md"]["type"] == "file"


def test_nested_directories_are_placed_correctly():
    tree = agent._parse_find_output(FIND_OUTPUT, "proj")
    src = [c for c in tree["children"] if c["name"] == "src"][0]
    util = [c for c in src["children"] if c["name"] == "util"][0]
    assert [c["name"] for c in util["children"]] == ["helpers.py"]


def test_paths_are_project_relative():
    tree = agent._parse_find_output(FIND_OUTPUT, "proj")
    src = [c for c in tree["children"] if c["name"] == "src"][0]
    assert src["path"] == "src"
    main = [c for c in src["children"] if c["name"] == "main.py"][0]
    assert main["path"] == "src/main.py"


def test_directories_sort_before_files():
    tree = agent._parse_find_output(FIND_OUTPUT, "proj")
    kinds = [c["type"] for c in tree["children"]]
    assert kinds == sorted(kinds, key=lambda k: 0 if k == "dir" else 1)


def test_empty_output_yields_an_empty_root():
    tree = agent._parse_find_output("", "proj")
    assert tree["children"] == [] and tree["type"] == "dir"


def test_remote_tree_shells_out_and_does_not_touch_local_disk(monkeypatch):
    monkeypatch.setattr(devices, "_active", devices.Device("i", "box", "h", "/r"))
    seen = {}
    monkeypatch.setattr(agent, "run_cmd",
                        lambda cmd, timeout=None: seen.setdefault("cmd", cmd)
                        or {"stdout": FIND_OUTPUT, "stderr": "", "returncode": 0})
    listed = []
    monkeypatch.setattr(_os, "listdir", lambda p: listed.append(p) or [])
    tree = agent.build_file_tree("proj")
    assert "find" in seen["cmd"]
    assert listed == [], "the remote tree must not read the local filesystem"
    assert [c["name"] for c in tree["children"]] == ["src", "README.md"]


def test_remote_tree_survives_a_failed_command(monkeypatch):
    monkeypatch.setattr(devices, "_active", devices.Device("i", "box", "h", "/r"))
    monkeypatch.setattr(agent, "run_cmd",
                        lambda cmd, timeout=None: {"stdout": "", "stderr": "boom",
                                                   "returncode": 1,
                                                   "error": "could not reach device"})
    tree = agent.build_file_tree("proj")
    assert tree["type"] == "dir" and tree["children"] == []


if __name__ == "__main__":
    import types
    monkeypatch = types.SimpleNamespace(setattr=lambda o, n, v: setattr(o, n, v))
    _saved = (devices._active, _os.listdir)
    tests = [(test_find_output_becomes_a_nested_tree, False),
             (test_nested_directories_are_placed_correctly, False),
             (test_paths_are_project_relative, False),
             (test_directories_sort_before_files, False),
             (test_empty_output_yields_an_empty_root, False),
             (test_remote_tree_shells_out_and_does_not_touch_local_disk, True),
             (test_remote_tree_survives_a_failed_command, True)]
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
            devices._active, _os.listdir = _saved
    print("OK" if not failed else f"{failed} FAILED")
    _sys.exit(1 if failed else 0)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/Scripts/python.exe tests/test_remote_fs_api.py`
Expected: FAIL — `AttributeError: module 'agent' has no attribute '_parse_find_output'`

- [ ] **Step 3: Write minimal implementation**

In `agent.py`, add `import devices` and ensure `run_cmd` is importable as `agent.run_cmd` (add `from host_exec import run_cmd` to the existing `host_exec` import list if absent). Then, above `build_file_tree`:

```python
# Depth and ignore list mirror the local walker, so switching machines does not
# silently change what the tree shows.
_REMOTE_TREE_DEPTH = 6
_REMOTE_TREE_IGNORE = (".git", "node_modules", "__pycache__", ".venv", "dist", "build")


def _remote_find_command():
    """Two `find` passes, one per type, each tagged with a leading d/f.

    Deliberately avoids `find -printf`, which is GNU-only. The local box assumes
    a GNU userland, but a remote host may be macOS or BSD, and a tree that fails
    on half the machines you connect to is not a tree."""
    prune = " -o ".join(f"-name {shlex.quote(n)}" for n in _REMOTE_TREE_IGNORE)
    base = f"find . -maxdepth {_REMOTE_TREE_DEPTH} \\( {prune} \\) -prune -o "
    d = base + r"-type d -print | sed 's|^|d\t|'"
    f = base + r"-type f -print | sed 's|^|f\t|'"
    return d + "; " + f


def _parse_find_output(text, project_name):
    """Turn the tagged find output into the SAME nested dict the local walker
    produces, so the frontend needs no changes."""
    root = {"name": project_name or "workspace", "path": "", "type": "dir", "children": []}
    dirs = {"": root}

    rows = []
    for line in (text or "").splitlines():
        if "\t" not in line:
            continue
        kind, _, raw = line.partition("\t")
        rel = raw[2:] if raw.startswith("./") else raw
        if rel in ("", "."):
            continue
        rows.append((kind, rel))

    # Directories first and shallowest-first, so a parent always exists before
    # its child is attached.
    rows.sort(key=lambda r: (0 if r[0] == "d" else 1, r[1].count("/"), r[1]))

    for kind, rel in rows:
        parent_rel, _, name = rel.rpartition("/")
        parent = dirs.get(parent_rel)
        if parent is None:
            continue          # its parent was pruned; skip rather than orphan it
        node = {"name": name, "path": rel, "type": "dir" if kind == "d" else "file"}
        if kind == "d":
            node["children"] = []
            dirs[rel] = node
        parent["children"].append(node)

    def sort_tree(node):
        node["children"].sort(key=lambda c: (0 if c["type"] == "dir" else 1, c["name"].lower()))
        for c in node["children"]:
            if c["type"] == "dir":
                sort_tree(c)

    sort_tree(root)
    return root


def _remote_file_tree(project_name):
    res = run_cmd(_remote_find_command(), timeout=60)
    if res.get("error") or res.get("returncode"):
        return {"name": project_name or "workspace", "path": "", "type": "dir",
                "children": []}
    return _parse_find_output(res.get("stdout") or "", project_name)
```

Then make `build_file_tree` dispatch as its first statement:

```python
def build_file_tree(project_name):
    if devices.is_remote():
        return _remote_file_tree(project_name)
    ...   # unchanged local walker from here
```

- [ ] **Step 4: Run test to verify it passes**

Run: `.venv/Scripts/python.exe tests/test_remote_fs_api.py`
Expected: 7 × `PASS`, then `OK`

- [ ] **Step 5: Commit**

```bash
git add -f agent.py tests/test_remote_fs_api.py
git commit -m "feat(ui): the file tree follows the active device"
```

---

### Task 8: Remote file viewer

**Files:**
- Modify: `agent.py` — `read_project_file` (line 1200)
- Modify: `tests/test_remote_fs_api.py`

**Interfaces:**
- Consumes: `devices.is_remote()`, `run_cmd`, `_parse_find_output` (not used here).
- Produces: `agent._remote_read_project_file(project_name, rel_path, force_text=False) -> dict`, `agent.REMOTE_PREVIEW_MAX_BYTES`.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_remote_fs_api.py`:

```python
import base64


def _remote(monkeypatch, stdout, returncode=0):
    monkeypatch.setattr(devices, "_active", devices.Device("i", "box", "h", "/r"))
    seen = {}

    def fake(cmd, timeout=None):
        seen.setdefault("cmds", []).append(cmd)
        out = stdout(cmd) if callable(stdout) else stdout
        return {"stdout": out, "stderr": "", "returncode": returncode}

    monkeypatch.setattr(agent, "run_cmd", fake)
    return seen


def test_remote_text_file_is_returned_as_text(monkeypatch):
    _remote(monkeypatch, lambda cmd: "SIZE=12\n" if "stat" in cmd else "hello world\n")
    res = agent.read_project_file("proj", "README.md")
    assert res["ok"] is True and res["kind"] == "text"
    assert "hello world" in res["content"]


def test_remote_escape_outside_the_project_is_rejected(monkeypatch):
    # The local viewer has this guard; the remote one needs its own or the
    # viewer can be walked out of the project root.
    _remote(monkeypatch, "OUTSIDE\n")
    res = agent.read_project_file("proj", "../../etc/passwd")
    assert res["ok"] is False and "outside" in res["error"].lower()


def test_remote_image_comes_back_base64(monkeypatch):
    payload = base64.b64encode(b"\x89PNG\r\n\x1a\nfake").decode()
    _remote(monkeypatch, lambda cmd: "SIZE=15\n" if "stat" in cmd else payload)
    res = agent.read_project_file("proj", "shot.png")
    assert res["ok"] is True and res["kind"] == "image"
    assert res["mime"] == "image/png" and res["data"] == payload


def test_a_file_over_the_cap_is_refused_not_transferred(monkeypatch):
    # base64 of a 50MB APK over ssh for a PREVIEW is not a reasonable thing to do.
    seen = _remote(monkeypatch, f"SIZE={agent.REMOTE_PREVIEW_MAX_BYTES + 1}\n")
    res = agent.read_project_file("proj", "big.apk")
    assert res["ok"] is False and "too large" in res["error"].lower()
    assert not any("base64" in c for c in seen["cmds"]), "must not transfer it"


def test_a_missing_remote_file_reports_cleanly(monkeypatch):
    _remote(monkeypatch, "MISSING\n")
    res = agent.read_project_file("proj", "nope.txt")
    assert res["ok"] is False and "error" in res
```

Add the five names to the runner.

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/Scripts/python.exe tests/test_remote_fs_api.py`
Expected: FAIL — `AttributeError: module 'agent' has no attribute 'REMOTE_PREVIEW_MAX_BYTES'`

- [ ] **Step 3: Write minimal implementation**

In `agent.py`, above `read_project_file`:

```python
# base64 over ssh is fine for a screenshot and absurd for an APK. Anything above
# this is refused rather than transferred for a preview nobody can use.
REMOTE_PREVIEW_MAX_BYTES = 8 * 1024 * 1024

_REMOTE_IMAGE_MIME = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
                      ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp"}


def _remote_read_project_file(project_name, rel_path, force_text=False):
    from tools.common import normalize_path, wpath
    rel = normalize_path(rel_path)

    # Same guard as the local viewer: resolve on the far side and confirm the
    # result is still inside the project root.
    probe = run_cmd(
        f'R=$(pwd -P); F=$(cd "$(dirname {wpath(rel)})" 2>/dev/null && pwd -P)/'
        f'"$(basename {wpath(rel)})"; '
        f'case "$F" in "$R"/*|"$R") ;; *) echo OUTSIDE; exit 0;; esac; '
        f'if [ ! -f {wpath(rel)} ]; then echo MISSING; exit 0; fi; '
        f'echo "SIZE=$(wc -c < {wpath(rel)} | tr -d " ")"',
        timeout=30)
    out = (probe.get("stdout") or "").strip()
    if probe.get("error"):
        return {"ok": False, "error": probe["error"]}
    if out.startswith("OUTSIDE"):
        return {"ok": False, "error": f"{rel_path} resolves outside the project folder."}
    if out.startswith("MISSING"):
        return {"ok": False, "error": f"No such file on device: {rel_path}"}

    size = 0
    for line in out.splitlines():
        if line.startswith("SIZE="):
            try:
                size = int(line[5:])
            except ValueError:
                size = 0
    if size > REMOTE_PREVIEW_MAX_BYTES:
        mb = REMOTE_PREVIEW_MAX_BYTES // (1024 * 1024)
        return {"ok": False,
                "error": f"{rel_path} is {size} bytes — too large to preview from a "
                         f"remote device (limit {mb} MB). Work with it through tools instead."}

    ext = _os.path.splitext(rel)[1].lower()
    if ext in _REMOTE_IMAGE_MIME and not force_text:
        res = run_cmd(f"base64 {wpath(rel)} | tr -d '\\n'", timeout=120)
        if res.get("error") or res.get("returncode"):
            return {"ok": False, "error": res.get("error") or "could not read the image"}
        return {"ok": True, "kind": "image", "mime": _REMOTE_IMAGE_MIME[ext],
                "data": (res.get("stdout") or "").strip(), "path": rel}

    res = run_cmd(f"cat {wpath(rel)}", timeout=120)
    if res.get("error") or res.get("returncode"):
        return {"ok": False, "error": res.get("error") or "could not read the file"}
    return {"ok": True, "kind": "text", "content": res.get("stdout") or "", "path": rel}
```

Then dispatch as the first statement of `read_project_file`:

```python
def read_project_file(project_name, rel_path, force_text=False):
    if devices.is_remote():
        return _remote_read_project_file(project_name, rel_path, force_text)
    ...   # unchanged local body
```

Archives (`.zip`/`.apk`) fall through to the text branch and will be refused by the size cap or return binary noise; that is acceptable for v1 and is stated in the spec.

- [ ] **Step 4: Run test to verify it passes**

Run: `.venv/Scripts/python.exe tests/test_remote_fs_api.py`
Expected: 12 × `PASS`, then `OK`

- [ ] **Step 5: Commit**

```bash
git add -f agent.py tests/test_remote_fs_api.py
git commit -m "feat(ui): the file viewer reads from the active device, with a preview size cap"
```

---

### Task 9: The device bridge in `agent.py`

**Files:**
- Modify: `agent.py` — `_persist_session` (line 1590), `_load_persisted` (line 1639), session dict (line 2838), `_refresh_system_prompt`, plus new `AgentApi` methods
- Test: `tests/test_device_session.py`

**Interfaces:**
- Consumes: `devices.*`.
- Produces: `AgentApi.list_devices()`, `AgentApi.add_device(name, target, remote_root, env_prelude="", notes="")`, `AgentApi.remove_device(device_id)`, `AgentApi.select_device(device_id_or_None)`, `AgentApi.test_device(device_id)`; module function `agent._device_prompt_segment(session) -> str`; session key `active_device`.

- [ ] **Step 1: Write the failing test**

Create `tests/test_device_session.py`:

```python
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


def test_test_device_returns_the_probe_result(monkeypatch):
    monkeypatch.setattr(devices, "get_device",
                        lambda _id: devices.Device("i", "n", "h", "/r"))
    monkeypatch.setattr(devices, "probe",
                        lambda d: {"ok": True, "root": "/r", "uname": "Linux x",
                                   "missing": ["apktool"], "error": ""})
    out = _api().test_device("i")
    assert out["ok"] is True and out["missing"] == ["apktool"]


if __name__ == "__main__":
    import types
    monkeypatch = types.SimpleNamespace(setattr=lambda o, n, v: setattr(o, n, v))
    _saved = (devices._active, devices.get_device, devices.set_active, devices.probe)
    tests = [(test_prompt_says_this_computer_when_local, False),
             (test_prompt_names_the_device_and_its_root, True),
             (test_selecting_a_device_records_it_in_the_transcript, True),
             (test_selecting_local_records_it_too, True),
             (test_active_device_is_persisted, True),
             (test_test_device_returns_the_probe_result, True)]
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
            devices._active, devices.get_device, devices.set_active, devices.probe = _saved
    print("OK" if not failed else f"{failed} FAILED")
    _sys.exit(1 if failed else 0)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/Scripts/python.exe tests/test_device_session.py`
Expected: FAIL — `AttributeError: module 'agent' has no attribute '_device_prompt_segment'`

- [ ] **Step 3: Write minimal implementation**

Add to `agent.py`, beside `_ultra_prompt_segment`:

```python
def _device_prompt_segment(session):
    """Tell the model which machine its commands land on. It has no tool to
    change this — the user selects the device — so the line is informational and
    must say so, or the model will hunt for a switch that does not exist."""
    d = devices.active()
    if d is None:
        return ("EXECUTION TARGET: this computer. Commands, file edits and builds "
                "all run locally.")
    return (
        f"EXECUTION TARGET: the remote device '{d.name}' ({d.target}). Every "
        f"command, file edit and build runs THERE, in {d.remote_root} — not on "
        f"this computer. You cannot change the target; the user selects it. "
        f"Emulator, screen-capture, Frida and code-graph tools are local-only and "
        f"will refuse while a device is active."
    )
```

Fold it into `_refresh_system_prompt`'s `section` string beside the ultra segment.

Add `"active_device": None,` to the session dict beside `"context_editing": True,`.

Add `"active_device": s.get("active_device"),` to `_persist_session`'s payload and restore it in `_load_persisted` (calling `devices.set_active(...)` inside a `try/except KeyError` so a deleted device degrades to local).

Add the bridge methods to `AgentApi`:

```python
    def list_devices(self):
        d = devices.active()
        return {"ok": True, "active": (d.id if d else None),
                "devices": [x.to_dict() for x in devices.load_devices()]}

    def add_device(self, name, target, remote_root, env_prelude="", notes=""):
        d = devices.add_device(name, target, remote_root, env_prelude, notes)
        return {"ok": True, "device": d.to_dict()}

    def remove_device(self, device_id):
        return {"ok": devices.remove_device(device_id)}

    def test_device(self, device_id):
        d = devices.get_device(device_id)
        if d is None:
            return {"ok": False, "error": "no such device"}
        return devices.probe(d)

    def select_device(self, device_id):
        """Switch the machine work happens on. Recorded in the transcript so a
        later reader is never left guessing which computer a command ran on."""
        try:
            d = devices.set_active(device_id)
        except KeyError:
            return {"ok": False, "error": "no such device"}
        self.session["active_device"] = (d.id if d else None)
        where = f"the device '{d.name}' ({d.target}), folder {d.remote_root}" if d \
            else "this computer"
        self._emit({"type": "system", "content": f"Execution target is now {where}."})
        self._emit({"type": "device_changed",
                    "device": (d.to_dict() if d else None)})
        self._refresh_system_prompt()
        return {"ok": True, "device": (d.to_dict() if d else None)}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/Scripts/python.exe tests/test_device_session.py`
Expected: 6 × `PASS`, then `OK`

Run: `.venv/Scripts/python.exe -m pytest tests/ -q --ignore=tests/frontend`
Expected: exactly the 3 pre-existing failures. `agent.py` is load-bearing — if `test_delegation.py`, `test_agent_delegation_wave.py`, `test_conversation_tokens.py` or `test_ultra_mode.py` break, that IS your regression.

- [ ] **Step 5: Commit**

```bash
git add -f agent.py tests/test_device_session.py
git commit -m "feat(agent): device bridge, prompt target line, transcript record and persistence"
```

---

### Task 10: The device chip and picker

**Files:**
- Modify: `frontend/index.html`, `frontend/app.js`
- Test: `tests/frontend/test_device_picker.mjs`

**Interfaces:**
- Consumes: `pywebview.api.list_devices/add_device/remove_device/select_device/test_device`, and the `device_changed` event.
- Produces: `deviceChanged(ev)`, `renderDeviceChip(state)`, `deviceState()`.

**Anchors** (`app.js` is 4,400+ lines — do not go hunting): the event switch is near `case 'workflow_started':`; header controls sit beside the existing tab row at `index.html:1114-1120`.

- [ ] **Step 1: Write the failing test**

Create `tests/frontend/test_device_picker.mjs`:

```javascript
// Drives the REAL frontend/device_view.js over the shared DOM shim.
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { El } from './_harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND = path.join(here, '..', '..', 'frontend');

function load() {
  const byId = new Map();
  for (const id of ['deviceChip', 'deviceChipName', 'devicePicker', 'deviceList']) {
    const el = new El('div'); el.id = id; byId.set(id, el);
  }
  const document = { getElementById: (id) => byId.get(id) || null,
                     createElement: (t) => new El(t), body: new El('div') };
  const ctx = { document, window: {}, console, setTimeout, clearTimeout };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(FRONTEND, 'device_view.js'), 'utf8'), ctx);
  return { ctx, byId };
}

{
  const { ctx, byId } = load();
  ctx.deviceChanged({ type: 'device_changed', device: null });
  assert.equal(ctx.deviceState().device, null);
  assert.ok(/this computer/i.test(byId.get('deviceChipName')._text
    || byId.get('deviceChipName')._html), 'local state names this computer');
  console.log('PASS local chip');
}

{
  const { ctx, byId } = load();
  ctx.deviceChanged({ type: 'device_changed',
    device: { id: 'i', name: 'build-box', target: 'berat@h', remote_root: '/r' } });
  const name = byId.get('deviceChipName');
  assert.ok(/build-box/.test(name._text || name._html), 'chip names the device');
  console.log('PASS remote chip names the device');
}

{
  // The remote state must be visually distinct — this is the guard against
  // running a destructive command believing you are local.
  const { ctx, byId } = load();
  ctx.deviceChanged({ type: 'device_changed',
    device: { id: 'i', name: 'box', target: 't', remote_root: '/r' } });
  assert.ok(byId.get('deviceChip')._classes.has('device-chip-remote'),
    'remote chip carries a distinct class');
  ctx.deviceChanged({ type: 'device_changed', device: null });
  assert.ok(!byId.get('deviceChip')._classes.has('device-chip-remote'),
    'switching back to local clears it');
  console.log('PASS remote chip is visually distinct');
}

{
  const { ctx } = load();
  ctx.deviceChanged({ device: { id: 'i', name: '<img src=x onerror=alert(1)>',
                                target: 't', remote_root: '/r' } });
  const html = ctx.deviceState().lastHtml || '';
  assert.ok(!html.includes('<img'), 'device names are escaped before innerHTML');
  console.log('PASS device name is escaped');
}

console.log('OK');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/frontend/test_device_picker.mjs`
Expected: FAIL — `ENOENT … frontend/device_view.js`

- [ ] **Step 3: Write minimal implementation**

Create `frontend/device_view.js` exposing `deviceChanged(ev)`, `renderDeviceChip()`, `deviceState()`, keeping state in a module-local object, escaping all interpolated text with the same `esc()` idiom `workflow_view.js` uses, toggling `device-chip-remote` on `#deviceChip`, and recording the last rendered HTML on the state object as `lastHtml` so the escaping test can inspect it.

In `frontend/index.html`: add the chip beside the tab row (`#deviceChip` containing `#deviceChipName`), a `#devicePicker` panel with `#deviceList` and an add-device form (name / ssh target / remote root / env prelude) plus a "Test connection" button, a `<script defer src="device_view.js"></script>` beside `workflow_view.js`, and the `device-chip`, `device-chip-remote`, `device-row`, `device-row-active` classes in the **`<style>` block** using only `--term-*` tokens.

In `frontend/tailwind.config.js`: add `'./device_view.js'` to `content`.

In `frontend/app.js`: add `case 'device_changed': deviceChanged(ev); break;` to the event switch, wire the chip click to open the picker, and call `pywebview.api.list_devices()` on boot to paint initial state.

Extend `tests/frontend/test_element_ids.mjs` and `test_tailwind_classes.mjs` to also scan `device_view.js`, exactly as they already scan `workflow_view.js`.

Rebuild: `cd frontend && npx tailwindcss@3 -c tailwind.config.js -i tailwind.input.css -o tailwind.css --minify`

- [ ] **Step 4: Run tests to verify they pass**

Run: `node tests/frontend/test_device_picker.mjs`
Expected: 4 × `PASS`, then `OK`

Run: `node tests/frontend/test_boot.mjs && node tests/frontend/test_element_ids.mjs && node tests/frontend/test_tailwind_classes.mjs && node tests/frontend/test_contrast.mjs && node tests/frontend/test_workflow_view.mjs`
Expected: `OK` from each.

- [ ] **Step 5: Commit**

```bash
git add -f frontend/device_view.js frontend/index.html frontend/app.js \
        frontend/tailwind.config.js frontend/tailwind.css \
        tests/frontend/test_device_picker.mjs tests/frontend/test_element_ids.mjs \
        tests/frontend/test_tailwind_classes.mjs
git commit -m "feat(ui): device chip and picker, visually distinct when remote"
```

---

### Task 11: Documentation and the optional integration test

**Files:**
- Modify: `AGENTS.md`
- Create: `tests/test_devices_integration.py`

- [ ] **Step 0: The optional localhost integration test**

Every other test in this plan uses doubles, so none of them proves a real ssh
connection works. This one does — and **skips cleanly** when no sshd is reachable,
because pretending CI has one produces a test that fails for the wrong reason.

```python
"""Optional end-to-end check against localhost. SKIPS unless `ssh localhost true`
already works — every other test in this suite uses doubles, so this is the only
one that proves the real transport."""
import sys as _sys, os as _os
_sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))

import subprocess
import tempfile

import devices
import host_exec


def _sshd_reachable():
    ssh = devices.find_ssh()
    if not ssh:
        return False
    try:
        r = subprocess.run([ssh, "-o", "BatchMode=yes", "-o", "ConnectTimeout=3",
                            "localhost", "true"], timeout=15,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return r.returncode == 0
    except Exception:
        return False


def test_round_trip_against_localhost():
    if not _sshd_reachable():
        print("SKIP  no reachable sshd on localhost")
        return
    root = tempfile.mkdtemp(prefix="omni-remote-")
    d = devices.Device("itest", "localhost", "localhost", root)
    prev = devices._active
    try:
        devices._active = d
        res = host_exec.run_cmd("pwd && echo marker-9f3a")
        assert res.get("returncode") == 0, res
        assert "marker-9f3a" in res["stdout"]

        host_exec.run_cmd("printf hello > probe.txt")
        assert _os.path.isfile(_os.path.join(root, "probe.txt")),             "the write landed somewhere other than the remote root"

        probe = devices.probe(d)
        assert probe["ok"] is True and probe["root"]
    finally:
        devices._active = prev


if __name__ == "__main__":
    failed = 0
    for t in [test_round_trip_against_localhost]:
        try:
            t(); print(f"PASS {t.__name__}")
        except Exception as e:
            failed += 1
            import traceback; traceback.print_exc()
            print(f"FAIL {t.__name__}: {e}")
    print("OK" if not failed else f"{failed} FAILED")
    _sys.exit(1 if failed else 0)
```

Run: `.venv/Scripts/python.exe tests/test_devices_integration.py`
Expected: either `PASS` (an sshd is reachable) or `SKIP  no reachable sshd on localhost` followed by `PASS` — both are green. It must NOT fail merely because no server is running.


- [ ] **Step 1: Add the section**

Append after the "Workflow engine" section, matching the file's voice (it explains WHY, names the traps, and points at the guards):

```markdown
## SSH devices (2026-08 upgrade)

`devices.py` lets the agent run its toolset on another machine. A device is a
host alias plus a remote project folder — no credentials are stored, because auth
is whatever the user's ssh already does.

Three things are load-bearing:

- **The transport is the `ssh` BINARY, not a library.** `run_cmd` builds an ssh
  argv and hands it to the same `_run_polling` a local command uses, so process
  groups, Stop polling, the timeout decider and pipe draining keep working
  verbatim. A library would mean reimplementing all of it.
- **Prefer Git/MSYS ssh over Windows OpenSSH.** Windows OpenSSH cannot multiplex
  ("getsockname failed: Not a socket"), and without multiplexing every tool call
  pays a fresh TCP+auth handshake. `ControlPath` must also stay under 108 bytes —
  `~/.omni-agent/ssh/%C` measures 95.
- **Never fall back to local.** If a device is unreachable the command fails
  loudly. A fallback would run it on the wrong machine, which is the one
  catastrophic failure this feature can cause.

Paths need no translation: `normalize_path` already returns project-relative
paths and commands run with cwd set to the project folder, so the command string
is valid on either machine.

**Not everything goes remote.** Tools that bypass `run_cmd` — emulator, screen
capture, vision, Frida, Roblox session, hook verification (they drive the LOCAL
Android SDK) and code-graph building (a local index of a remote project is
meaningless) — call `devices.require_local()` and REFUSE while a device is
active. `download_file` fetches with `curl` on the device instead. APK work is
unaffected: `apk_tools` goes through `run_cmd` 27 times against 3 local uses, and
those 3 already degrade cleanly.

Stop and timeout **reap** the remote command: each command's wrapper records its
process-group id to a tag-named file, and a second multiplexed ssh sends TERM
then KILL to that group. Reaping runs on a background thread so Stop stays
instant; if it fails, the result says the remote command may still be running.

`host_exec.workspace_root()` returns **None** when a device is active — its
callers do LOCAL file I/O, and None turns "operates on a path that does not exist
here" into a clean refusal.
```

- [ ] **Step 2: Verify the claims against the code**

Run: `.venv/Scripts/python.exe -c "import devices; print(devices.control_path()); print(devices.supports_multiplexing(r'C:\Windows\System32\OpenSSH\ssh.exe'))"`
Expected: a path ending `.omni-agent/ssh/%C`, then `False`.

- [ ] **Step 3: Commit**

```bash
git add -f AGENTS.md tests/test_devices_integration.py
git commit -m "docs: SSH devices — transport, multiplexing traps, and what stays local"
```

---

## Verification

From a cold shell, on the merged tree:

```bash
cd omni-agent
.venv/Scripts/python.exe tests/test_devices.py
.venv/Scripts/python.exe tests/test_host_exec_remote.py
.venv/Scripts/python.exe tests/test_local_only_guards.py
.venv/Scripts/python.exe tests/test_remote_fs_api.py
.venv/Scripts/python.exe tests/test_device_session.py
.venv/Scripts/python.exe -m pytest tests/ -q --ignore=tests/frontend
for t in test_device_picker test_workflow_view test_boot test_element_ids test_tailwind_classes test_contrast; do node tests/frontend/$t.mjs; done
.venv/Scripts/python.exe -c "import agent; print('agent imports ok')"
```

Green = exactly the three pre-existing environmental failures named in Global Constraints, and no others.

**Then a real end-to-end check**, which no offline test can substitute for — every test above uses doubles, so nothing proves an actual ssh connection works:

1. Register a device pointing at any box you can already `ssh` into.
2. Hit "Test connection" — expect the remote `uname` and a missing-tools list.
3. Select it. The chip turns remote; the transcript records the switch.
4. Ask the agent to `run_command("uname -a && pwd")` — it must report the REMOTE hostname and the remote project folder.
5. Ask it to write a file, then confirm the file exists on the device and NOT on this machine.
6. Start something long (`sleep 300`) and press Stop — confirm the ssh process ends promptly and, on the device, `ps` shows the sleep gone.
7. Try `observe_screen` — it must refuse and name the device.
