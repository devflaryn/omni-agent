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
        assert _os.path.isfile(_os.path.join(root, "probe.txt")), \
            "the write landed somewhere other than the remote root"

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
