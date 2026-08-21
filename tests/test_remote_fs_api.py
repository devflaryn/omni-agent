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
