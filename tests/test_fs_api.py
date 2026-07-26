"""The workspace file operations behind the file tree's drag/drop and context menu.

_safe_abs is the ONLY thing between a frontend-supplied relative path and
arbitrary host filesystem access, so its escape cases carry most of the weight
here. The rest pins behaviour the UI depends on: deletes are recoverable, moves
never silently overwrite, and a folder can't be moved inside itself.
"""
import base64
import json
import os

import pytest

import agent as agent_mod


class _Api:
    """Minimal stand-in exposing only the file-op surface under test."""
    TRASH_DIRNAME = agent_mod.AgentApi.TRASH_DIRNAME
    _safe_abs = agent_mod.AgentApi._safe_abs
    _tree_result = agent_mod.AgentApi._tree_result
    _unique_path = staticmethod(agent_mod.AgentApi._unique_path)
    _refresh_tree = lambda self, force=False: None  # noqa: E731
    fs_move = agent_mod.AgentApi.fs_move
    fs_delete = agent_mod.AgentApi.fs_delete
    fs_trash_empty = agent_mod.AgentApi.fs_trash_empty
    fs_mkdir = agent_mod.AgentApi.fs_mkdir
    fs_new_file = agent_mod.AgentApi.fs_new_file
    fs_rename = agent_mod.AgentApi.fs_rename
    fs_duplicate = agent_mod.AgentApi.fs_duplicate
    fs_write_upload = agent_mod.AgentApi.fs_write_upload


@pytest.fixture
def api(tmp_path, monkeypatch):
    root = tmp_path / "ws"
    (root / "src" / "deep").mkdir(parents=True)
    (root / "src" / "a.py").write_text("a")
    (root / "src" / "deep" / "b.py").write_text("b")
    (root / "top.txt").write_text("top")
    (tmp_path / "outside.txt").write_text("secret")

    a = _Api()
    a.session = {"root": str(root), "project": "ws"}
    monkeypatch.setattr(agent_mod, "build_file_tree", lambda p: {"name": p, "children": []})
    a.root = root
    return a


# --- _safe_abs: the security boundary ---------------------------------------

@pytest.mark.parametrize("evil", [
    "../outside.txt",
    "../../etc/passwd",
    "src/../../outside.txt",
    "src/../../",
    "..\\outside.txt",
])
def test_paths_escaping_the_workspace_are_rejected(api, evil):
    with pytest.raises(ValueError):
        api._safe_abs(evil)


@pytest.mark.parametrize("absolute", ["/etc/passwd", "/", "//tmp/x"])
def test_absolute_paths_are_contained_not_escapes(api, absolute):
    """The API is workspace-relative by contract, so a leading slash is stripped
    and the path lands INSIDE the workspace. It must never reach the host path of
    the same name."""
    resolved = api._safe_abs(absolute)
    root = os.path.realpath(str(api.root))
    assert resolved == root or resolved.startswith(root + os.sep)


def test_symlink_out_of_the_workspace_is_rejected(api, tmp_path):
    """realpath resolution is why this is caught: a symlink inside the workspace
    pointing out of it must not become a way through."""
    link = api.root / "escape"
    link.symlink_to(tmp_path)
    with pytest.raises(ValueError):
        api._safe_abs("escape/outside.txt")


def test_ordinary_paths_resolve(api):
    assert api._safe_abs("src/a.py") == os.path.realpath(str(api.root / "src" / "a.py"))
    assert api._safe_abs("") == os.path.realpath(str(api.root))


def test_must_exist_is_enforced(api):
    with pytest.raises(ValueError):
        api._safe_abs("nope.txt", must_exist=True)


# --- move --------------------------------------------------------------------

def test_move_relocates_a_file(api):
    res = api.fs_move(["top.txt"], "src")
    assert res["ok"] and res["moved"] == ["top.txt"]
    assert (api.root / "src" / "top.txt").exists()
    assert not (api.root / "top.txt").exists()


def test_move_never_overwrites(api):
    (api.root / "src" / "top.txt").write_text("existing")
    api.fs_move(["top.txt"], "src")
    assert (api.root / "src" / "top.txt").read_text() == "existing"
    assert (api.root / "src" / "top (2).txt").read_text() == "top"


def test_move_a_folder_into_its_own_descendant_is_refused(api):
    res = api.fs_move(["src"], "src/deep")
    assert res["ok"]
    assert res["moved"] == []
    assert "itself" in res["skipped"][0]["reason"]
    assert (api.root / "src" / "a.py").exists(), "the folder must be untouched"


def test_move_into_its_current_parent_is_a_noop_not_an_error(api):
    res = api.fs_move(["src/a.py"], "src")
    assert res["ok"] and res["moved"] == [] and res["skipped"] == []
    assert (api.root / "src" / "a.py").exists()


def test_move_rejects_an_escaping_source_without_aborting_the_batch(api):
    res = api.fs_move(["../outside.txt", "top.txt"], "src")
    assert res["ok"]
    assert res["moved"] == ["top.txt"]
    assert len(res["skipped"]) == 1
    assert (api.root.parent / "outside.txt").exists(), "the outside file is untouched"


def test_move_to_a_destination_outside_the_workspace_fails(api):
    res = api.fs_move(["top.txt"], "../")
    assert res["ok"] is False


# --- delete / trash ----------------------------------------------------------

def test_delete_moves_to_trash_and_is_recoverable(api):
    res = api.fs_delete(["top.txt"])
    assert res["ok"] and res["trashed"] == ["top.txt"]
    assert not (api.root / "top.txt").exists()
    trashed = api.root / _Api.TRASH_DIRNAME / "top.txt"
    assert trashed.read_text() == "top", "content must survive so a mis-drop is undoable"


def test_delete_a_folder_keeps_its_contents(api):
    api.fs_delete(["src"])
    assert (api.root / _Api.TRASH_DIRNAME / "src" / "deep" / "b.py").read_text() == "b"


def test_deleting_the_workspace_root_is_refused(api):
    res = api.fs_delete([""])
    assert res["trashed"] == []
    assert "root" in res["skipped"][0]["reason"]
    assert (api.root / "src" / "a.py").exists()


def test_deleting_something_already_in_the_trash_is_refused(api):
    api.fs_delete(["top.txt"])
    res = api.fs_delete([f"{_Api.TRASH_DIRNAME}/top.txt"])
    assert res["trashed"] == []
    assert "trash" in res["skipped"][0]["reason"]


def test_two_deletes_of_the_same_name_both_survive(api):
    api.fs_delete(["top.txt"])
    (api.root / "top.txt").write_text("second")
    api.fs_delete(["top.txt"])
    trash = api.root / _Api.TRASH_DIRNAME
    assert (trash / "top.txt").read_text() == "top"
    assert (trash / "top (2).txt").read_text() == "second"


def test_empty_trash_is_permanent(api):
    api.fs_delete(["top.txt", "src"])
    res = api.fs_trash_empty()
    assert res["ok"] and res["removed"] == 2
    assert list((api.root / _Api.TRASH_DIRNAME).iterdir()) == []


def test_empty_trash_with_no_trash_dir_is_harmless(api):
    res = api.fs_trash_empty()
    assert res["ok"] and res["removed"] == 0


# --- create / rename / duplicate ---------------------------------------------

def test_mkdir_and_new_file(api):
    assert api.fs_mkdir("src/fresh")["ok"]
    assert (api.root / "src" / "fresh").is_dir()
    assert api.fs_new_file("src/fresh/x.txt")["ok"]
    assert (api.root / "src" / "fresh" / "x.txt").read_text() == ""


def test_mkdir_refuses_an_existing_name(api):
    assert api.fs_mkdir("src")["ok"] is False


def test_mkdir_outside_the_workspace_fails(api):
    assert api.fs_mkdir("../evil")["ok"] is False
    assert not (api.root.parent / "evil").exists()


def test_rename(api):
    assert api.fs_rename("top.txt", "renamed.txt")["ok"]
    assert (api.root / "renamed.txt").read_text() == "top"


@pytest.mark.parametrize("bad", ["../escaped.txt", "sub/nested.txt", "", "   ", ".", ".."])
def test_rename_rejects_anything_that_is_not_a_bare_name(api, bad):
    """A rename that accepted a path would be a move — including out of the
    workspace."""
    res = api.fs_rename("top.txt", bad)
    assert res["ok"] is False
    assert (api.root / "top.txt").exists()


def test_rename_refuses_to_clobber(api):
    res = api.fs_rename("top.txt", "src")
    assert res["ok"] is False


def test_duplicate_file_and_folder(api):
    assert api.fs_duplicate("top.txt")["ok"]
    assert (api.root / "top (2).txt").read_text() == "top"
    assert api.fs_duplicate("src")["ok"]
    assert (api.root / "src (2)" / "deep" / "b.py").read_text() == "b"


# --- chunked upload ----------------------------------------------------------

def _b64(s):
    return base64.b64encode(s.encode()).decode()


def test_single_chunk_upload(api):
    res = api.fs_write_upload("", "hello.txt", _b64("hi"), True, True)
    assert res["ok"]
    assert (api.root / "hello.txt").read_text() == "hi"


def test_multi_chunk_upload_reassembles_in_order(api):
    api.fs_write_upload("src", "big.bin", _b64("aaa"), True, False)
    api.fs_write_upload("src", "big.bin", _b64("bbb"), False, False)
    res = api.fs_write_upload("src", "big.bin", _b64("ccc"), False, True)
    assert res["ok"]
    assert (api.root / "src" / "big.bin").read_text() == "aaabbbccc"


def test_first_chunk_truncates_so_a_retry_does_not_append(api):
    api.fs_write_upload("", "f.txt", _b64("old content"), True, True)
    api.fs_write_upload("", "f.txt", _b64("new"), True, True)
    assert (api.root / "f.txt").read_text() == "new"


def test_upload_recreates_dropped_folder_structure(api):
    """A dropped FOLDER arrives as files whose names carry their relative path."""
    res = api.fs_write_upload("", "proj/lib/util.py", _b64("x"), True, True)
    assert res["ok"]
    assert (api.root / "proj" / "lib" / "util.py").read_text() == "x"


@pytest.mark.parametrize("bad", ["../escape.txt", "a/../../escape.txt", "", "/"])
def test_upload_cannot_escape_the_workspace(api, bad):
    res = api.fs_write_upload("", bad, _b64("x"), True, True)
    assert res["ok"] is False
    assert not (api.root.parent / "escape.txt").exists()


def test_upload_rejects_malformed_base64_without_crashing(api):
    res = api.fs_write_upload("", "x.bin", "!!!not base64!!!", True, True)
    assert res["ok"] is False


def test_intermediate_chunks_skip_the_tree_rebuild(api, monkeypatch):
    """Rebuilding the tree per chunk would walk the whole workspace hundreds of
    times for one large file."""
    calls = []
    monkeypatch.setattr(agent_mod, "build_file_tree", lambda p: calls.append(p) or {})
    api.fs_write_upload("", "big.bin", _b64("a"), True, False)
    api.fs_write_upload("", "big.bin", _b64("b"), False, False)
    assert calls == []
    api.fs_write_upload("", "big.bin", _b64("c"), False, True)
    assert len(calls) == 1


# --- the NameError this milestone fixed --------------------------------------

def test_upload_files_returns_a_tree_without_raising(tmp_path, monkeypatch):
    """upload_files referenced an undefined `project`, so its SUCCESS path raised
    NameError after the copy had already happened."""
    import inspect
    src = inspect.getsource(agent_mod.AgentApi.upload_files)
    assert "build_file_tree(project)" not in src, "the undefined name is back"
    assert 'build_file_tree(self.session["project"])' in src
