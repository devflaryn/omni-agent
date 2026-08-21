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


def test_run_on_targets_an_explicit_device_without_touching_global_state(monkeypatch):
    # Probing an unselected device must not swap the global active device: the
    # picker thread and the agent loop run concurrently, so that would route a
    # live tool call to the machine being TESTED.
    monkeypatch.setattr(devices, "_active", None)
    monkeypatch.setattr(devices, "find_ssh", lambda: "/usr/bin/ssh")
    seen = _capture(monkeypatch)
    other = devices.Device("other", "other-box", "root@other", "/srv/app")
    host_exec.run_on(other, "uname -a")
    assert "root@other" in seen["cmd"]
    assert devices.active() is None, "run_on must not mutate the active device"


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
             test_run_on_targets_an_explicit_device_without_touching_global_state,
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
