"""frontend/app.js carries a TOOL_META table mapping every tool to a human-facing
display name and a summary category. It lives in the frontend (next to the code
that renders it) rather than being pushed through the event schema, so nothing
structurally forces it to stay in sync with the Python registry.

This is that force: add a tool without a TOOL_META entry and the suite fails.
Without it the transcript silently regresses to showing `some_new_tool` and
counting it in a vague trailing "Ran N tools" bucket.
"""
import os
import re

import pytest

import tools  # noqa: F401  — importing registers every tool
from tool_registry import registry

APP_JS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                      "frontend", "app.js")

CATEGORIES = {"read", "change", "run", "search", "delegate", "plan"}

# Tools the frontend renders that the Python registry does not expose to the
# model — app-level APIs called straight from the UI.
FRONTEND_ONLY = {"read_archive_member"}


def _tool_meta():
    """Parse the TOOL_META object literal out of app.js into {tool: (name, cat)}."""
    src = open(APP_JS, encoding="utf-8").read()
    start = src.index("const TOOL_META = {")
    end = src.index("\n};", start)
    body = src[start:end]
    entries = re.findall(
        r"^\s{2}([a-z0-9_]+):\s*\{\s*name:\s*'([^']*)',\s*cat:\s*'([a-z]+)'\s*\},",
        body, re.M)
    return {tool: (name, cat) for tool, name, cat in entries}


def _real_tools():
    """Tools shipped by the project, i.e. those defined in the `tools` package.

    The registry is a process-wide singleton and several other test modules
    register throwaway fixtures into it (dummy_echo, fake_edit, ok_tool, ...).
    Those show up only in a full-suite run, so filtering on the defining module
    is what stops this test from passing alone and failing in CI.
    """
    return {name for name, _ in registry.list_tools()
            if getattr(registry._tools[name].get("func"), "__module__", "")
            .startswith("tools.")}


def test_real_tools_excludes_test_fixtures():
    """Guard the filter itself: it must keep the real tools and drop fixtures."""
    real = _real_tools()
    assert "read_file_chunk" in real and "run_command" in real
    assert len(real) > 100
    assert not {t for t in real if t.startswith(("dummy_", "fake_", "adaptive_"))}


def _tool_path_args():
    """The arg names app.js dedupes read/change counts by. Parsed rather than
    duplicated here so this test can never drift from the shipped list."""
    src = open(APP_JS, encoding="utf-8").read()
    start = src.index("const _TOOL_PATH_ARGS = [")
    end = src.index("\n];", start)
    return set(re.findall(r"'([a-z0-9_]+)'", src[start:end]))


def test_tool_path_args_parses():
    args = _tool_path_args()
    assert "filepath" in args and len(args) > 10, f"parsed only {args}"


def test_tool_meta_parses():
    meta = _tool_meta()
    assert len(meta) > 100, f"only parsed {len(meta)} entries — did the format change?"


def test_every_registered_tool_has_display_metadata():
    meta = _tool_meta()
    registered = _real_tools()
    missing = sorted(registered - set(meta))
    assert not missing, (
        "these tools have no TOOL_META entry in frontend/app.js, so the "
        "transcript would show their raw identifier:\n  " + "\n  ".join(missing))


def test_no_stale_entries():
    meta = _tool_meta()
    registered = _real_tools()
    stale = sorted(set(meta) - registered - FRONTEND_ONLY)
    assert not stale, (
        "TOOL_META names tools that are no longer registered:\n  " + "\n  ".join(stale))


def test_categories_are_known():
    bad = {t: c for t, (_, c) in _tool_meta().items() if c not in CATEGORIES}
    assert not bad, f"unknown categories (must be one of {sorted(CATEGORIES)}): {bad}"


def test_display_names_are_human_readable():
    offenders = {t: n for t, (n, _) in _tool_meta().items()
                 if "_" in n or not n[:1].isupper()}
    assert not offenders, f"display names must not look like identifiers: {offenders}"


@pytest.mark.parametrize("tool,expected", [
    ("list_directory", "List Directory"),
    ("read_file_chunk", "Read File"),
    ("run_command", "Run Command"),
])
def test_spot_checks(tool, expected):
    """The exact names called out in the UI request."""
    assert _tool_meta()[tool][0] == expected


def test_file_categories_dedupe_by_path_are_the_ones_with_path_args():
    """read/change are counted by distinct path, so every tool in those buckets
    should plausibly carry a path argument. A tool with no path arg silently
    falls back to a per-call key, which would over-count files."""
    meta = _tool_meta()
    path_keys = _tool_path_args()
    pathless = []
    for tool, (_, cat) in meta.items():
        if cat not in ("read", "change") or tool not in registry._tools:
            continue
        props = set(registry._tools[tool].get("params") or {})
        if props and not (props & path_keys):
            pathless.append(tool)
    assert not pathless, (
        "these read/change tools take no recognised path argument, so their file "
        "counts will not dedupe correctly — either recategorise them or extend "
        "toolPathKey in app.js:\n  " + "\n  ".join(sorted(pathless)))
