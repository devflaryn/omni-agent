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
    "f\t123\tREADME.md",
    "f\t456\tsrc/main.py",
    "f\t789\tsrc/util/helpers.py",
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


def test_file_nodes_carry_their_size():
    tree = agent._parse_find_output(FIND_OUTPUT, "proj")
    src = [c for c in tree["children"] if c["name"] == "src"][0]
    main = [c for c in src["children"] if c["name"] == "main.py"][0]
    assert main["size"] == 456
    readme = [c for c in tree["children"] if c["name"] == "README.md"][0]
    assert readme["size"] == 123


def test_remote_tree_shells_out_and_does_not_touch_local_disk(monkeypatch):
    monkeypatch.setattr(devices, "_active", devices.Device("i", "box", "h", "/r"))
    seen = {}

    def fake(cmd, timeout=None):
        seen["cmd"] = cmd
        return {"stdout": FIND_OUTPUT, "stderr": "", "returncode": 0}

    monkeypatch.setattr(agent, "run_cmd", fake)
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
    # "pwd -P" only appears in the probe script (the data-fetch call is a
    # plain `cat`/`base64`), so it's what actually distinguishes the two
    # run_cmd calls the fake needs to answer differently.
    _remote(monkeypatch, lambda cmd: "SIZE=12\n" if "pwd -P" in cmd else "hello world\n")
    res = agent.read_project_file("proj", "README.md")
    assert res["ok"] is True and res["kind"] == "text"
    assert "hello world" in res["content"]
    assert res["size"] == 12


def test_remote_escape_outside_the_project_is_rejected(monkeypatch):
    # The local viewer has this guard; the remote one needs its own or the
    # viewer can be walked out of the project root.
    _remote(monkeypatch, "OUTSIDE\n")
    res = agent.read_project_file("proj", "../../etc/passwd")
    assert res["ok"] is False and "outside" in res["error"].lower()


def test_remote_leaf_symlink_escape_is_rejected_without_transfer(monkeypatch):
    # A symlink whose LEAF component (not a parent directory) points outside
    # the project root must be caught too. `ln -s /etc/passwd leak.txt` has
    # dirname "." -- resolving only the directory part would trivially pass
    # the root check while the leaf itself points outside. The probe script
    # resolves the leaf (realpath/readlink -f/manual fallback) before the
    # root comparison, so it reports OUTSIDE here exactly like any other
    # escape, and must never get as far as cat/base64.
    seen = _remote(monkeypatch, "OUTSIDE\n")
    res = agent.read_project_file("proj", "leak.txt")
    assert res["ok"] is False and "outside" in res["error"].lower()
    assert len(seen["cmds"]) == 1, "must not issue a second command after OUTSIDE"
    assert not any("base64" in c for c in seen["cmds"])
    assert not any(c.strip().startswith("cat ") for c in seen["cmds"])


def test_remote_image_comes_back_base64(monkeypatch):
    payload = base64.b64encode(b"\x89PNG\r\n\x1a\nfake").decode()
    _remote(monkeypatch, lambda cmd: "SIZE=15\n" if "pwd -P" in cmd else payload)
    res = agent.read_project_file("proj", "shot.png")
    assert res["ok"] is True and res["kind"] == "image"
    assert res["mime"] == "image/png" and res["data"] == payload
    assert res["size"] == 15


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


if __name__ == "__main__":
    import types
    monkeypatch = types.SimpleNamespace(setattr=lambda o, n, v: setattr(o, n, v))
    _saved = (devices._active, _os.listdir)
    tests = [(test_find_output_becomes_a_nested_tree, False),
             (test_nested_directories_are_placed_correctly, False),
             (test_paths_are_project_relative, False),
             (test_directories_sort_before_files, False),
             (test_empty_output_yields_an_empty_root, False),
             (test_file_nodes_carry_their_size, False),
             (test_remote_tree_shells_out_and_does_not_touch_local_disk, True),
             (test_remote_tree_survives_a_failed_command, True),
             (test_remote_text_file_is_returned_as_text, True),
             (test_remote_escape_outside_the_project_is_rejected, True),
             (test_remote_leaf_symlink_escape_is_rejected_without_transfer, True),
             (test_remote_image_comes_back_base64, True),
             (test_a_file_over_the_cap_is_refused_not_transferred, True),
             (test_a_missing_remote_file_reports_cleanly, True)]
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
