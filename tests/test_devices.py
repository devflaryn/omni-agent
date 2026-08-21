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


def test_wrapper_records_the_process_GROUP_not_the_bare_pid():
    # `echo $$` records a PID. ssh hands `bash -c ...` to the remote LOGIN shell,
    # so this bash inherits that shell's pgid and is NOT a group leader —
    # `kill -TERM -$$` then fails and the reap falls back to killing bash alone,
    # leaving java/apktool/gradle children alive after Stop or a timeout.
    inner = shlex.split(devices.run_argv(_dev(), "ls", "t", ssh_path="/usr/bin/ssh")[-1])[-1]
    assert "pgid" in inner, "the wrapper must ask for the process-GROUP id"
    assert "ps -o pgid= -p $$" in inner
    first = [ln for ln in inner.splitlines() if ln.strip()][0]
    assert first.startswith("P=$("), "the pgid must be recorded before anything else runs"
    assert "echo $$ >" not in inner, "recording the bare pid is the bug"


def test_wrapper_falls_back_to_dollar_dollar_when_ps_is_unusable():
    # A host with no usable `ps` must degrade to the old bare-pid behaviour, not
    # write an empty/garbage id that `kill` would aim at an unrelated group.
    inner = shlex.split(devices.run_argv(_dev(), "ls", "t", ssh_path="/usr/bin/ssh")[-1])[-1]
    assert 'case "$P" in' in inner and "P=$$" in inner


def test_pgid_filename_cannot_carry_shell_syntax():
    # The tag is interpolated into a DOUBLE-quoted remote filename, where $ and `
    # are still live. Today's caller passes a hex uuid; the quoting must not
    # depend on that staying true.
    evil = 'a"; rm -rf ~; echo "$(id)`id`'
    name = devices._pgid_file(evil)
    assert name.startswith('"${TMPDIR:-/tmp}/.omni-') and name.endswith('.pgid"')
    body = name[len('"${TMPDIR:-/tmp}/.omni-'):-len('.pgid"')]
    assert all(c.isalnum() or c in "._-" for c in body), body
    # ...and the same tag must still produce the same name for run and reap, or
    # the reap looks for a file that was never written.
    assert devices._pgid_file(evil) == name


def test_ssh_target_starting_with_a_dash_is_rejected(monkeypatch):
    # `-oProxyCommand=...` is a valid ssh OPTION that runs an arbitrary command on
    # THIS machine. A device whose target ssh parses as an option never connects
    # anywhere — it executes locally, the exact wrong-machine failure.
    _isolate(monkeypatch)
    try:
        devices.add_device("evil", "-oProxyCommand=calc.exe", "/r")
        raise AssertionError("expected ValueError")
    except ValueError as e:
        assert "-" in str(e) and "option" in str(e).lower()
    assert devices.load_devices() == [] or all(
        not d.target.startswith("-") for d in devices.load_devices())


def test_an_ordinary_target_still_registers(monkeypatch):
    _isolate(monkeypatch)
    d = devices.add_device("box", "  berat@10.0.0.5 ", "/r")
    assert d.target == "berat@10.0.0.5", "the target is trimmed, not mangled"


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
    monkeypatch.setattr(host_exec, "run_on",
                        lambda dev, cmd, timeout=None: {"stdout": out, "stderr": "", "returncode": 0})
    res = devices.probe(devices.Device("i", "n", "h", "/home/berat/proj"))
    assert res["ok"] is True
    assert res["root"] == "/home/berat/proj"
    assert "Linux buildbox" in res["uname"]
    assert set(res["missing"]) == {"apktool", "curl"}


def test_probe_reports_failure_without_raising(monkeypatch):
    import host_exec
    monkeypatch.setattr(host_exec, "run_on",
                        lambda dev, cmd, timeout=None: {"stdout": "", "stderr": "boom",
                                                        "returncode": 255,
                                                        "error": "could not reach device"})
    res = devices.probe(devices.Device("i", "n", "h", "/r"))
    assert res["ok"] is False and "could not reach" in res["error"]


def test_probe_checks_curl_for_remote_downloads():
    assert "curl" in devices.PROBE_TOOLS


if __name__ == "__main__":
    import types
    monkeypatch = types.SimpleNamespace(setattr=lambda o, n, v: setattr(o, n, v))
    _orig = devices.DEVICES_PATH
    tests = [(test_registry_is_empty_when_no_file_exists, True),
             (test_added_device_round_trips, True),
             (test_ids_are_unique, True),
             (test_remove_device, True),
             (test_no_secret_fields_are_persisted, True),
             (test_active_defaults_to_none_meaning_local, True),
             (test_set_active_selects_a_device, True),
             (test_set_active_none_returns_to_local, True),
             (test_set_active_unknown_id_raises, True),
             (test_removing_the_active_device_returns_to_local, True),
             (test_corrupt_registry_degrades_to_empty, True),
             (test_control_path_is_under_the_108_byte_socket_limit, False),
             (test_multiplexing_is_disabled_for_windows_openssh, False),
             (test_opts_include_batchmode_so_a_missing_key_fails_fast, False),
             (test_opts_include_multiplexing_when_supported, False),
             (test_opts_omit_multiplexing_on_windows_openssh, False),
             (test_run_argv_shape, False),
             (test_remote_root_with_spaces_is_quoted, False),
             (test_command_with_quotes_and_dollars_survives, False),
             (test_wrapper_records_its_pgid_and_traps_exit, False),
             (test_wrapper_records_the_process_GROUP_not_the_bare_pid, False),
             (test_wrapper_falls_back_to_dollar_dollar_when_ps_is_unusable, False),
             (test_pgid_filename_cannot_carry_shell_syntax, False),
             (test_ssh_target_starting_with_a_dash_is_rejected, True),
             (test_an_ordinary_target_still_registers, True),
             (test_wrapper_prepends_the_remote_tool_bin, False),
             (test_wrapper_runs_env_prelude_when_set, False),
             (test_wrapper_aborts_when_cd_fails, False),
             (test_reap_argv_targets_the_recorded_pgid, False),
             (test_reap_kills_the_group_then_falls_back_to_the_pid, False),
             (test_probe_parses_root_uname_and_missing_tools, True),
             (test_probe_reports_failure_without_raising, True),
             (test_probe_checks_curl_for_remote_downloads, False)]
    failed = 0
    for t, needs_mp in tests:
        try:
            t(monkeypatch) if needs_mp else t()
            print(f"PASS {t.__name__}")
        except Exception as e:
            failed += 1
            import traceback; traceback.print_exc()
            print(f"FAIL {t.__name__}: {e}")
        finally:
            devices.DEVICES_PATH = _orig
            devices.set_active(None)
    print("OK" if not failed else f"{failed} FAILED")
    _sys.exit(1 if failed else 0)
