"""Guards for host_exec — how every tool command actually runs.

The contract is deliberately small now: commands execute in the user's real
project folder, with real paths, and nothing is rewritten on the way in or out.
Two earlier designs (a Docker container, then a fake `/workspace` root backed by
a symlink) were removed precisely because the translation layer between "what
the tool wrote" and "what ran" was where the bugs lived.

What is worth testing is what stayed subtle after the simplification:

  1. The working directory IS the project folder, so a relative path in a
     command means the same thing as in a file tool.
  2. Paths get shell-quoted. Real project folders contain spaces ("Omni Apps"),
     and an unquoted path silently splits one argument into several — a failure
     that shows up as a confusing "No such file" rather than as a quoting bug.
  3. A path the model supplies in legacy `/workspace/...` form still resolves,
     because that convention outlives the container in transcripts and habits.
  4. "Nothing ran" is distinguishable from "the tool found nothing" — the
     failure mode that once made decode_apk look like it silently did nothing.

No toolchain, no LLM, no network — real temp dirs and real subprocesses.

Run from the project root:
    python3 -m pytest tests/test_host_exec.py -q
"""

# Make this test runnable from the gitignored tests/ folder:
import sys as _sys, os as _os; _sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))

import os
import shutil
import tempfile

import pytest

import host_exec
from tools.common import normalize_path, wpath


@pytest.fixture(params=["with space", "plain"])
def workspace(request):
    """An active project folder, exercised BOTH with and without a space in its
    path. The space case is not hypothetical — the app's own home is
    "~/Desktop/Omni Apps/omni-agent" — and it is the one that catches quoting
    mistakes, so every path test runs against both."""
    prefix = "omni probe " if request.param == "with space" else "omniprobe"
    prev = host_exec._workspace_root
    ws = tempfile.mkdtemp(prefix=prefix)
    host_exec.set_workspace(ws)
    try:
        yield ws
    finally:
        shutil.rmtree(ws, ignore_errors=True)
        host_exec._workspace_root = prev


def _out(cmd, timeout=30):
    res = host_exec.run_cmd(cmd, timeout=timeout)
    assert res.get("returncode") == 0, f"{cmd!r} failed: {res}"
    return (res.get("stdout") or "").strip()


# --- Path normalization ------------------------------------------------------

def test_paths_normalize_to_project_relative():
    assert normalize_path("foo/bar.txt") == "foo/bar.txt"
    assert normalize_path("./foo/bar.txt") == "foo/bar.txt"
    assert normalize_path("") == "."
    assert normalize_path(None) == "."


def test_legacy_workspace_prefix_still_resolves():
    """`/workspace/...` is a leftover from the container era that survives in old
    transcripts and in the model's habits. Accepting it costs one comparison;
    rejecting it would turn a cosmetic mismatch into a failed tool call."""
    assert normalize_path("/workspace/foo/bar.txt") == "foo/bar.txt"
    assert normalize_path("/workspace") == "."


def test_paths_are_shell_quoted():
    """An unquoted path with a space becomes two arguments, and the command fails
    with a misleading 'No such file' instead of a quoting error."""
    quoted = wpath("My Folder/a b.txt")
    assert " " not in quoted.strip("'\"") or quoted != "My Folder/a b.txt"
    assert quoted != "My Folder/a b.txt", "wpath must quote"


def test_similar_prefixes_are_not_mistaken_for_the_legacy_root():
    """A real directory that merely starts with the same letters belongs to the
    user and must survive intact."""
    assert normalize_path("workspaces/foo") == "workspaces/foo"


# --- Executing in the project folder -----------------------------------------

def test_working_directory_is_the_project_folder(workspace):
    _out("mkdir -p a/b && echo hi > a/b/f.txt")
    assert os.path.isfile(os.path.join(workspace, "a", "b", "f.txt"))
    assert _out("cat a/b/f.txt") == "hi"


def test_recursive_traversal_finds_everything(workspace):
    _out("mkdir -p a/b && echo hi > a/b/f.txt && echo hi > top.txt")
    assert _out("find . -type f | wc -l").strip() == "2"
    assert _out("grep -rl hi . | wc -l").strip() == "2"


def test_a_path_with_a_space_round_trips(workspace):
    """The whole reason wpath exists. Written through a quoted path, read back
    through another, and confirmed on disk."""
    import tools  # noqa: F401  (registers the tools)
    from tool_registry import registry

    res = registry.execute("write_file", {"filepath": "My Dir/a b.txt", "content": "hello\n"})
    assert not res.get("error"), res
    assert os.path.isfile(os.path.join(workspace, "My Dir", "a b.txt"))
    out = registry.execute("read_file_chunk", {"filepath": "My Dir/a b.txt"})
    assert "hello" in (out.get("stdout") or ""), out


def test_command_exit_code_is_passed_through(workspace):
    """A failing command is the command's result, not a harness failure."""
    res = host_exec.run_cmd("exit 7")
    assert res.get("returncode") == 7 and not res.get("error")


# --- Telling "nothing ran" from "found nothing" ------------------------------

def test_no_active_project_is_an_error_not_an_empty_result(workspace):
    prev = host_exec._workspace_root
    host_exec._workspace_root = None
    try:
        res = host_exec.run_cmd("echo hi")
        assert res.get("error") and not res.get("stdout")
    finally:
        host_exec._workspace_root = prev


def test_deleted_project_folder_is_reported(workspace):
    """The folder can be moved or deleted out from under a running session."""
    prev = host_exec._workspace_root
    host_exec._workspace_root = os.path.join(workspace, "nope")
    try:
        res = host_exec.run_cmd("echo hi")
        assert res.get("error") and "no longer exists" in res["error"]
    finally:
        host_exec._workspace_root = prev


# --- Environment handed to commands ------------------------------------------

def test_tool_directory_is_on_path(workspace):
    """A GUI-launched app inherits a minimal PATH; without this the installed
    toolchain is invisible and every tool fails with 'command not found'."""
    assert host_exec.TOOLS_BIN in host_exec.build_env()["PATH"]


def test_a_posix_shell_is_available():
    """Tool commands are POSIX shell. On Windows this is what tells the user to
    install Git for Windows instead of emitting thousands of syntax errors."""
    assert host_exec._find_posix_shell(), host_exec.NO_SHELL_MSG


# --- Scripts shipped through base64 ------------------------------------------

def test_a_shipped_script_resolves_relative_paths(workspace):
    """Several tools ship a Python script by base64-ing it into the command line.
    Those scripts name files RELATIVE to the project folder and rely on it being
    the interpreter's working directory — under the old designs they hardcoded an
    absolute root, which is exactly what broke when the root stopped existing."""
    import tools  # noqa: F401
    from tool_registry import registry

    with open(os.path.join(workspace, "blob.bin"), "wb") as fh:
        fh.write(b"\x11" + b"\x00" * 128)
    res = registry.execute("find_code_cave", {"binary_path": "blob.bin", "min_size": 32})
    assert "length=128" in (res.get("stdout") or ""), res
