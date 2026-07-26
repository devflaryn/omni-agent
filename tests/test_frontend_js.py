"""Run the Node-based frontend tests as part of the normal pytest suite.

tests/frontend/*.mjs load the REAL frontend/app.js into a Node `vm` over a
minimal DOM shim, so they verify shipped behaviour rather than a reimplementation.
They existed before this file but nothing ever executed them — no pytest wrapper,
no npm script — so regressions in the chat renderer went unnoticed. This module
discovers them and fails the suite on a non-zero exit, surfacing the node output.
"""
import glob
import os
import shutil
import subprocess

import pytest

FRONTEND_TEST_DIR = os.path.join(os.path.dirname(__file__), "frontend")
NODE = shutil.which("node")


def _mjs_tests():
    return sorted(glob.glob(os.path.join(FRONTEND_TEST_DIR, "test_*.mjs")))


def test_frontend_test_files_are_discovered():
    """Guard the guard: if the glob ever silently matches nothing, the suite must
    fail loudly instead of reporting a vacuous pass."""
    assert _mjs_tests(), f"no test_*.mjs found under {FRONTEND_TEST_DIR}"


@pytest.mark.skipif(NODE is None, reason="node is not installed")
@pytest.mark.parametrize("script", _mjs_tests(), ids=lambda p: os.path.basename(p))
def test_frontend_js(script):
    proc = subprocess.run(
        [NODE, script],
        capture_output=True,
        text=True,
        timeout=120,
        cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    )
    if proc.returncode != 0:
        pytest.fail(
            f"{os.path.basename(script)} failed (exit {proc.returncode})\n"
            f"--- stdout ---\n{proc.stdout}\n--- stderr ---\n{proc.stderr}"
        )
