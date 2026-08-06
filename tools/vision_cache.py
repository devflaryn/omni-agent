"""Byte-identical image vision cache.

Screenshots (especially byte-for-byte black frames) get re-analyzed by the
vision model every time they recur. cached_vision serves an identical image
with the same prompt from the content-addressed cache instead — one vision
call per unique (image bytes, prompt). Fail-open: any cache problem just runs
the real vision call.

This module is SELF-CONTAINED and does NOT go through tools/cache.py's
lookup()/store(). That module's store() hardcodes the persisted result to
{"stdout","stderr","returncode"} (it's built for APK-tool results shaped like
subprocess output) and silently drops any other key — so a naive
cache.store("vision_analyze", path, {"analysis": text}) call would write an
entry with no "analysis" in it, and every read would look like a miss. On top
of that, cache.py's keying resolves the target through
resolve_workspace_path(), which expects a project-relative path; vision
call sites pass host-absolute image paths, which resolve fragile-to-wrong.

Keying here is purely on the image BYTES (sha256) + the prompt, not the path,
so identically-named-differently (or differently-named-identically) frames
collide/miss correctly regardless of where they live on disk.
"""
import os
import json
import hashlib
import tempfile

from tools import cache as _cache


def _vision_cache_dir():
    home = os.environ.get("OMNI_CACHE_DIR", "").strip() or os.path.join(
        os.path.expanduser("~"), ".omni_agent_cache"
    )
    return os.path.join(home, "vision")


def _entry_key(image_bytes, prompt):
    image_sha = hashlib.sha256(image_bytes).hexdigest()
    payload = f"{image_sha}\x00{prompt}".encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def _entry_path(vdir, key):
    return os.path.join(vdir, key + ".json")


def _write_atomic(path, data_bytes):
    d = os.path.dirname(path)
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=d)
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data_bytes)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass


def cached_vision(image_path, prompt, compute_fn):
    """Return (analysis_text, was_cached). Keys on sha256(image bytes) + prompt.

    compute_fn() runs the real vision call and returns the analysis text. It is
    called at most once per unique (image bytes, prompt) while caching is on.
    Never raises — any cache problem (disabled, unreadable image, disk error)
    fails open to just running compute_fn()."""
    prompt = prompt or ""

    if not _cache.enabled():
        return compute_fn(), False

    try:
        with open(image_path, "rb") as fh:
            image_bytes = fh.read()
    except OSError:
        return compute_fn(), False

    vdir = _vision_cache_dir()
    key = _entry_key(image_bytes, prompt)
    entry_path = _entry_path(vdir, key)

    try:
        with open(entry_path, encoding="utf-8") as fh:
            entry = json.load(fh)
        if isinstance(entry, dict) and entry.get("analysis") is not None:
            return entry["analysis"], True
    except (OSError, ValueError):
        pass

    text = compute_fn()

    if text is not None:
        try:
            _write_atomic(entry_path, json.dumps({"analysis": text}).encode("utf-8"))
        except Exception:
            pass

    return text, False
