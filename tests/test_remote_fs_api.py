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


def test_an_unreachable_host_does_not_look_like_an_empty_project(monkeypatch):
    # It used to swallow the error and return a bare empty tree, which is exactly
    # what a genuinely empty project folder looks like -- so a dead connection
    # read as "nothing here yet" and the user carried on working.
    monkeypatch.setattr(devices, "_active", devices.Device("i", "box", "h", "/r"))
    monkeypatch.setattr(agent, "run_cmd",
                        lambda cmd, timeout=None: {"stdout": "", "stderr": "boom",
                                                   "returncode": 1,
                                                   "error": "could not reach device"})
    tree = agent.build_file_tree("proj")
    # The shape the UI walks must still be intact, or the sidebar throws.
    assert tree["type"] == "dir" and isinstance(tree["children"], list)
    assert "error" in tree and "box" in tree["error"]
    assert "could not reach device" in tree["error"]
    # ...and it has to be visible in the sidebar, not only in a key no UI reads.
    assert len(tree["children"]) == 1
    node = tree["children"][0]
    assert node["path"] == agent.REMOTE_TREE_ERROR_PATH
    assert "box" in node["name"] and node["type"] == "dir"


def test_a_reachable_but_empty_project_is_still_reported_as_empty(monkeypatch):
    monkeypatch.setattr(devices, "_active", devices.Device("i", "box", "h", "/r"))
    monkeypatch.setattr(agent, "run_cmd",
                        lambda cmd, timeout=None: {"stdout": "d\t.\n", "stderr": "",
                                                   "returncode": 0})
    tree = agent.build_file_tree("proj")
    assert tree["children"] == [] and "error" not in tree


import base64


def _only_the_probe_ran(seen):
    """No file CONTENT command was issued.

    The probe itself now names `base64` -- it carries the binary sniff's first
    block back so the sniff costs no extra round trip -- so "base64 never appears"
    is no longer the right assertion. The real guarantee is stronger and is what
    is checked here: the path-resolving probe is the ONLY command that ran, so
    nothing cat'd or base64'd the whole file.
    """
    assert len(seen["cmds"]) == 1, f"a second command ran: {seen['cmds'][1:]}"
    assert "pwd -P" in seen["cmds"][0], "the one command must be the probe"


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
    _only_the_probe_ran(seen)


def test_remote_unresolved_dotdot_in_resolved_path_is_rejected(monkeypatch):
    # A resolver that could not fully canonicalize a symlink (a "..".relative
    # leaf target, or a 2+ level chain that only tier 3's single readlink hop
    # can partially follow) can leave a literal ".." segment in the resolved
    # path. The probe script refuses that outright -- a canonical path never
    # has one -- and reports OUTSIDE exactly like any other escape, before
    # ever issuing a transfer command.
    seen = _remote(monkeypatch, "OUTSIDE\n")
    res = agent.read_project_file("proj", "leak.txt")
    assert res["ok"] is False and "outside" in res["error"].lower()
    _only_the_probe_ran(seen)


def test_probe_script_rejects_dotdot_before_the_root_comparison(monkeypatch):
    # Ordering regression guard: the "resolved path still contains .." refusal
    # must run BEFORE the "$R"/* root-prefix comparison, or a path a resolver
    # left uncanonicalized could still slip through as a string-prefix match.
    # A mocked run_cmd can't see a reordering -- it just returns canned output
    # regardless of what the script says -- so this asserts on the generated
    # script text directly.
    monkeypatch.setattr(devices, "_active", devices.Device("i", "box", "h", "/r"))
    seen = {}

    def fake(cmd, timeout=None):
        seen["cmd"] = cmd
        return {"stdout": "MISSING\n", "stderr": "", "returncode": 0}

    monkeypatch.setattr(agent, "run_cmd", fake)
    agent.read_project_file("proj", "leak.txt")

    script = seen["cmd"]
    dotdot_pos = script.find('/../')
    root_check_pos = script.find('"$R"/*')
    assert dotdot_pos != -1, "the script must reject a literal .. segment"
    assert root_check_pos != -1, "the script must still do the root-prefix comparison"
    assert dotdot_pos < root_check_pos, "the .. rejection must run before the root comparison"

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
    _only_the_probe_ran(seen)
    # ...and the probe must not have read the file either: the sniff block is
    # skipped above the cap, so nothing at all is transferred.
    assert f'-le {agent.REMOTE_PREVIEW_MAX_BYTES}' in seen["cmds"][0]


def test_a_missing_remote_file_reports_cleanly(monkeypatch):
    _remote(monkeypatch, "MISSING\n")
    res = agent.read_project_file("proj", "nope.txt")
    assert res["ok"] is False and "error" in res


# --- the remote viewer must decline binaries, not mojibake them ---------------

def _head_b64(raw):
    return base64.b64encode(raw).decode("ascii")


def test_a_remote_binary_is_declined_not_catted_as_text(monkeypatch):
    # Under the 8 MB cap the old code `cat`'d an .so straight into the viewer as
    # garbage, while the LOCAL viewer returns a clean "unsupported" card for the
    # same file.
    seen = _remote(monkeypatch, lambda cmd: (
        "SIZE=2048\nHEAD=" + _head_b64(b"\x7fELF\x02\x01\x01\x00" + b"\x00" * 64) + "\n"
        if "pwd -P" in cmd else "garbage"))
    res = agent.read_project_file("proj", "libfoo.so")
    assert res["ok"] is True and res["kind"] == "unsupported"
    # Exactly the LOCAL payload's key names -- the frontend is not being changed.
    for key in ("kind", "path", "size", "label", "reason", "can_force_text"):
        assert key in res, key
    assert res["label"] == "ELF binary"
    assert "box" in res["reason"] and "remote" in res["reason"].lower()
    assert not any(c.strip().startswith("cat ") for c in seen["cmds"]), "must not transfer it"


def test_the_unsupported_payload_matches_the_local_viewers(monkeypatch):
    # Same keys AND same values-by-shape as _viewer_unsupported(), because
    # frontend/app.js reads one set of key names for both.
    _remote(monkeypatch, lambda cmd: (
        "SIZE=2048\nHEAD=" + _head_b64(b"\x7fELF\x02\x01\x01\x00") + "\n"
        if "pwd -P" in cmd else "garbage"))
    remote = agent.read_project_file("proj", "libfoo.so")
    local = agent._viewer_unsupported("libfoo.so", 2048, "ELF binary")
    assert set(remote) == set(local), (sorted(remote), sorted(local))
    assert remote["can_force_text"] is True and remote["ok"] is True


def test_a_remote_archive_is_declined_by_extension(monkeypatch):
    # Remote archive LISTING is a subsystem (one ssh round trip per member), not
    # a preview -- so an .apk gets the same unsupported card, never mojibake.
    _remote(monkeypatch, lambda cmd: (
        "SIZE=4096\nHEAD=" + _head_b64(b"PK\x03\x04" + b"junk" * 8) + "\n"
        if "pwd -P" in cmd else "garbage"))
    res = agent.read_project_file("proj", "app.apk")
    assert res["ok"] is True and res["kind"] == "unsupported"
    assert res["kind"] != "archive", "no remote archive listing in v1"
    assert "APK" in res["label"]


def test_the_sniff_rides_on_the_existing_probe(monkeypatch):
    # One round trip, not two: the head comes back from the same probe that
    # already resolves the path and reads the size.
    seen = _remote(monkeypatch,
                   lambda cmd: "SIZE=5\nHEAD=\n" if "pwd -P" in cmd else "hello")
    agent.read_project_file("proj", "a.txt")
    probes = [c for c in seen["cmds"] if "pwd -P" in c]
    assert len(probes) == 1
    assert "HEAD=" in probes[0] and "base64" in probes[0]


def test_force_text_still_shows_a_remote_binary_as_text(monkeypatch):
    # The "view as text anyway" escape hatch behaves like the local viewer's.
    _remote(monkeypatch, lambda cmd: (
        "SIZE=8\nHEAD=" + _head_b64(b"\x7fELF\x00\x00") + "\n"
        if "pwd -P" in cmd else "raw bytes"))
    res = agent.read_project_file("proj", "libfoo.so", force_text=True)
    assert res["kind"] == "text" and "raw bytes" in res["content"]


def test_a_remote_text_file_with_no_head_line_still_opens(monkeypatch):
    # A host whose head/dd both failed yields an empty HEAD; an empty head is a
    # perfectly fine empty text file, so the viewer must not start refusing.
    _remote(monkeypatch,
            lambda cmd: "SIZE=5\nHEAD=\n" if "pwd -P" in cmd else "hello")
    res = agent.read_project_file("proj", "a.txt")
    assert res["kind"] == "text" and "hello" in res["content"]


# --- CRITICAL 1: the fs_* family mutates the LOCAL disk -----------------------
# The tree shows the REMOTE box while _safe_abs resolves against the LOCAL picked
# folder, so an unguarded fs_delete of `config.json` trashes the LOCAL project's
# copy and then repaints the remote tree -- the destruction is invisible.

def _fs_api(tmp_root):
    from agent import AgentApi
    api = AgentApi.__new__(AgentApi)
    api.session = {"project": "proj", "root": tmp_root}
    api._window = None
    api._emit = lambda e: None
    api._refresh_tree = lambda force=False: None
    return api


# (method name, args) for every entry point that resolves through _safe_abs.
FS_CALLS = [
    ("fs_move", (["a.txt"], "sub")),
    ("fs_delete", (["a.txt"],)),
    ("fs_trash_empty", ()),
    ("fs_mkdir", ("newdir",)),
    ("fs_new_file", ("new.txt",)),
    ("fs_rename", ("a.txt", "b.txt")),
    ("fs_duplicate", ("a.txt",)),
    ("fs_write_upload", ("", "a.txt", "aGk=")),
    ("upload_files", ("",)),
    ("read_archive_member", ("app.apk", "AndroidManifest.xml")),
]


def _local_workspace():
    import tempfile
    root = tempfile.mkdtemp(prefix="fsguard-")
    with open(_os.path.join(root, "a.txt"), "w", encoding="utf-8") as f:
        f.write("local content")
    _os.makedirs(_os.path.join(root, "sub"), exist_ok=True)
    return root


def test_every_fs_mutation_refuses_when_a_device_is_active(monkeypatch):
    monkeypatch.setattr(devices, "_active",
                        devices.Device("i", "build-box", "berat@h", "/r"))
    root = _local_workspace()
    api = _fs_api(root)
    before = sorted(_os.listdir(root))
    bad = []
    for name, args in FS_CALLS:
        res = getattr(api, name)(*args)
        if not (isinstance(res, dict) and res.get("ok") is False
                and "build-box" in str(res.get("error", ""))
                and "This computer" in str(res.get("error", ""))):
            bad.append((name, res))
    assert not bad, f"these did not refuse (or did not name the device): {bad}"
    assert sorted(_os.listdir(root)) == before, "the LOCAL workspace was modified"
    with open(_os.path.join(root, "a.txt"), encoding="utf-8") as f:
        assert f.read() == "local content"


def test_safe_abs_itself_refuses_so_a_future_caller_inherits_the_guard(monkeypatch):
    monkeypatch.setattr(devices, "_active",
                        devices.Device("i", "build-box", "berat@h", "/r"))
    api = _fs_api(_local_workspace())
    try:
        api._safe_abs("a.txt")
        raise AssertionError("expected ValueError")
    except ValueError as e:
        assert "build-box" in str(e)
    # reveal_in_finder takes relative paths through _safe_abs; it must degrade to
    # a clean error rather than opening the LOCAL folder.
    res = api.reveal_in_finder("a.txt")
    assert res["ok"] is False and "build-box" in res["error"]


def test_the_fs_family_still_works_locally(monkeypatch):
    # The guard must refuse REMOTE only -- a local session keeps every operation.
    monkeypatch.setattr(devices, "_active", None)
    root = _local_workspace()
    api = _fs_api(root)
    monkeypatch.setattr(agent, "build_file_tree",
                        lambda p: {"name": p, "path": "", "type": "dir", "children": []})
    assert api.fs_mkdir("made")["ok"] is True
    assert _os.path.isdir(_os.path.join(root, "made"))
    assert api.fs_delete(["a.txt"])["ok"] is True
    assert not _os.path.exists(_os.path.join(root, "a.txt"))



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
             (test_an_unreachable_host_does_not_look_like_an_empty_project, True),
             (test_a_reachable_but_empty_project_is_still_reported_as_empty, True),
             (test_remote_text_file_is_returned_as_text, True),
             (test_remote_escape_outside_the_project_is_rejected, True),
             (test_remote_leaf_symlink_escape_is_rejected_without_transfer, True),
             (test_remote_unresolved_dotdot_in_resolved_path_is_rejected, True),
             (test_probe_script_rejects_dotdot_before_the_root_comparison, True),
             (test_remote_image_comes_back_base64, True),
             (test_a_file_over_the_cap_is_refused_not_transferred, True),
             (test_a_missing_remote_file_reports_cleanly, True),
             (test_a_remote_binary_is_declined_not_catted_as_text, True),
             (test_the_unsupported_payload_matches_the_local_viewers, True),
             (test_a_remote_archive_is_declined_by_extension, True),
             (test_the_sniff_rides_on_the_existing_probe, True),
             (test_force_text_still_shows_a_remote_binary_as_text, True),
             (test_a_remote_text_file_with_no_head_line_still_opens, True),
             (test_every_fs_mutation_refuses_when_a_device_is_active, True),
             (test_safe_abs_itself_refuses_so_a_future_caller_inherits_the_guard, True),
             (test_the_fs_family_still_works_locally, True)]
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
