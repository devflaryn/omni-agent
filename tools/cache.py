"""SHA256-keyed result cache for expensive, DETERMINISTIC APK tools.

Why this exists
---------------
Reverse-engineering the same APK over and over re-runs a handful of slow steps —
``unzip_apk``, ``decode_apk`` (apktool) and ``jadx_decompile`` — whose output is a
pure function of the INPUT FILE'S BYTES plus a couple of flags, and nothing else.
This module lets those tools skip the work when they've already produced the same
result for the same file.

The cache key is ``sha256(target file) + tool name + content-relevant args``. The
hash is recomputed from the ACTUAL file on every call, so:

  * If the file changes at all, its hash changes -> cache MISS -> the real command
    runs. There is no way to get a stale result for a changed file. This is exactly
    why directory-listing / file-reading / build / sign tools are NOT cached here:
    their output depends on mutable directory state that no single input-file hash
    captures (cache ``list_directory`` and an edit to the folder would be invisible).
  * The cache is FAIL-OPEN. Any problem whatsoever — no active project (offline
    tests), an unreadable file, a corrupt/half-written archive, an extract error —
    is swallowed and reported as a miss (lookup) or a no-op (store), so the caller
    always falls back to running the real command. Caching can only make things
    faster; it can never change or break a result.
  * Only SUCCESSFUL results are ever stored (the caller decides what "success" is,
    e.g. decode only caches when a smali tree was actually produced).

Two kinds of entry
------------------
* TEXT — the tool returns a result dict derived purely from the file
  (``get_apk_signature_hash``, ``extract_manifest_info``, ``inspect_apk``). We
  store and replay that dict.
* TREE — the tool ALSO writes an output directory into the project folder
  (``unzip_apk``, ``decode_apk``, ``jadx_decompile``). We archive that directory
  and, on a hit, restore it into the requested output dir BEFORE replaying the
  dict, so downstream tools (recompile / search / read) see the files exactly as a
  real run would have left them. Archiving and restoring read and write the
  project folder directly — the same files the tool commands operate on.

Environment knobs
-----------------
* ``OMNI_DISABLE_CACHE=1`` — turn the cache off entirely (always run the real tool).
* ``OMNI_CACHE_DIR=<path>`` — where entries live (default ``~/.omni_agent_cache``).
  The cache is content-addressed, so it is safe to share across projects.
"""

import os
import json
import shutil
import hashlib
import tarfile
import tempfile

# Bump to invalidate every existing entry if the format or semantics below change.
# v2: store() now caches the FULL result dict (was: only stdout/stderr/returncode).
# Bumping discards any v1 entries whose custom keys were dropped (e.g. broken vision
# cache entries) so they repopulate correctly on the next run.
# v3: tool output now names files with project-relative paths. The cache is global
# (~/.omni_agent_cache) and keyed on file BYTES, so entries written when tools
# reported a `/workspace/...` root would otherwise be replayed verbatim into the
# model's context — handing it paths that no longer resolve. A stale hit is
# indistinguishable from a fresh one, so the entries have to be retired by key.
_CACHE_VERSION = "v3"

_READ_CHUNK = 1024 * 1024  # 1 MiB — streaming hash/copy chunk


# ---------------------------------------------------------------------------
# Configuration / small helpers
# ---------------------------------------------------------------------------

def enabled():
    """False iff OMNI_DISABLE_CACHE is set to a truthy value."""
    return os.environ.get("OMNI_DISABLE_CACHE", "").strip().lower() not in ("1", "true", "yes", "on")


def _cache_home():
    override = os.environ.get("OMNI_CACHE_DIR")
    if override and override.strip():
        return override.strip()
    return os.path.join(os.path.expanduser("~"), ".omni_agent_cache")


def _entries_root():
    return os.path.join(_cache_home(), "entries")


def _host_path(rel_path):
    """Absolute path for a project-relative path, or None when no project is
    active (e.g. offline unit tests) — in which case caching is simply
    unavailable and the caller runs the real command."""
    try:
        from tools.common import resolve_workspace_path
        return resolve_workspace_path(rel_path)
    except Exception:
        return None


def file_sha256(rel_path):
    """SHA256 hex digest of a workspace file, read directly rather than shelled out
    to (fast — it is a plain local file). None if no workspace is active or the
    file can't be read; either way the caller treats it as 'cache unavailable'."""
    host = _host_path(rel_path)
    if not host or not os.path.isfile(host):
        return None
    try:
        h = hashlib.sha256()
        with open(host, "rb") as fh:
            for chunk in iter(lambda: fh.read(_READ_CHUNK), b""):
                h.update(chunk)
        return h.hexdigest()
    except OSError:
        return None


def _key(tool_name, file_hash, extra):
    """Content-addressed key for (tool, file bytes, content-relevant args)."""
    payload = json.dumps(
        {"v": _CACHE_VERSION, "tool": tool_name, "file": file_hash, "extra": extra or {}},
        sort_keys=True, separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:32]


def _entry_dir(key):
    return os.path.join(_entries_root(), key)


def _write_atomic(path, data_bytes):
    """Write bytes to path atomically (temp file in the same dir, then os.replace)."""
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


def _safe_rmtree(path):
    try:
        if os.path.isdir(path):
            shutil.rmtree(path, ignore_errors=True)
        elif os.path.exists(path):
            os.remove(path)
    except OSError:
        pass


def _read_meta(edir):
    try:
        with open(os.path.join(edir, "meta.json"), encoding="utf-8") as fh:
            meta = json.load(fh)
        return meta if isinstance(meta, dict) else None
    except (OSError, ValueError):
        return None


# ---------------------------------------------------------------------------
# Directory (TREE) archive / restore
# ---------------------------------------------------------------------------

def _archive_tree(dir_rel, edir):
    """Archive the project directory ``dir_rel`` into ``edir/tree.tar.gz``.
    Written atomically; returns True on success, False (and cleans up) on any error."""
    host = _host_path(dir_rel)
    if not host or not os.path.isdir(host):
        return False
    os.makedirs(edir, exist_ok=True)
    final = os.path.join(edir, "tree.tar.gz")
    fd, tmp = tempfile.mkstemp(dir=edir, suffix=".tar.gz")
    os.close(fd)
    try:
        # compresslevel=1: smali/Java trees compress heavily, and a fast level keeps
        # the one-time store cost (paid on the MISS) low relative to apktool/jadx.
        with tarfile.open(tmp, "w:gz", compresslevel=1) as tar:
            # arcname=entry so members are stored relative to the dir root (no
            # top-level folder), which restores cleanly into any target dir.
            for entry in sorted(os.listdir(host)):
                tar.add(os.path.join(host, entry), arcname=entry)
        os.replace(tmp, final)
        return True
    except Exception:
        try:
            os.remove(tmp)
        except OSError:
            pass
        return False


def _safe_extractall(tar, dest):
    """extractall with a path-traversal guard (defensive — we author the archives,
    but never trust a tar to stay inside its destination)."""
    dest_abs = os.path.abspath(dest)
    for member in tar.getmembers():
        target = os.path.abspath(os.path.join(dest, member.name))
        if target != dest_abs and not target.startswith(dest_abs + os.sep):
            raise ValueError("unsafe path in cache archive: %r" % member.name)
    tar.extractall(dest)


def _restore_tree(tar_path, dir_rel):
    """Restore ``tar_path`` into workspace directory ``dir_rel`` as an all-or-nothing
    swap: extract into a temp sibling, then replace the target. Returns True on
    success, False on any error (leaving the target untouched on failure)."""
    host = _host_path(dir_rel)
    if not host:
        return False
    norm = os.path.normpath(host)

    # Never wipe the workspace root itself — only ever a named sub-directory.
    ws = _host_path(".")
    if not ws or norm == os.path.normpath(ws):
        return False

    tmp = norm + ".omnicache_tmp"
    try:
        _safe_rmtree(tmp)
        os.makedirs(tmp, exist_ok=True)
        with tarfile.open(tar_path, "r:gz") as tar:
            _safe_extractall(tar, tmp)
        # Swap into place: drop any existing tree, then move the freshly-extracted
        # one over it (same parent dir => same filesystem => a cheap rename).
        _safe_rmtree(norm)
        os.replace(tmp, norm)
        return True
    except Exception:
        _safe_rmtree(tmp)
        return False


# ---------------------------------------------------------------------------
# Public API: lookup / store
# ---------------------------------------------------------------------------

def lookup(tool_name, target_rel, extra=None, restore_dir=None):
    """Return a cached result dict for (tool_name, sha256(target_rel), extra), or
    None on a miss / any problem.

    For TREE tools, pass ``restore_dir`` (a project-relative dir): the
    archived output tree is restored there as part of the hit, and the hit is only
    reported if that restore fully succeeds. The returned dict is a copy with a
    short ``[cache]`` banner appended to stdout so hits are visible in logs/UI."""
    if not enabled():
        return None
    file_hash = file_sha256(target_rel)
    if not file_hash:
        return None

    edir = _entry_dir(_key(tool_name, file_hash, extra))
    meta = _read_meta(edir)
    if meta is None:
        return None
    result = meta.get("result")
    if not isinstance(result, dict):
        return None

    if restore_dir is not None:
        tar_path = os.path.join(edir, "tree.tar.gz")
        if not os.path.isfile(tar_path):
            return None  # meta without its tree — treat as a miss
        if not _restore_tree(tar_path, restore_dir):
            return None  # restore failed -> miss -> caller runs the real command
        # Guard against a degenerate/empty cached tree being served as a "hit"
        # (which would look like the tool ran but produced nothing): if the
        # restored dir has no contents, treat it as a miss so the real tool runs.
        host = _host_path(restore_dir)
        if not host or not os.path.isdir(host) or not os.listdir(host):
            return None

    out = dict(result)
    label = os.path.basename(target_rel.rstrip("/\\")) or target_rel
    out["stdout"] = (out.get("stdout") or "") + (
        f"\n\n[cache] Served from cache (sha256 match on {label}; the real command was NOT re-run)."
    )
    return out


def store(tool_name, target_rel, result, extra=None, capture_dir=None):
    """Cache ``result`` under (tool_name, sha256(target_rel), extra). No-op on any
    error (fail-open). Errored results are never stored.

    For TREE tools, pass ``capture_dir`` (a project-relative dir) to also
    archive that produced directory; if the archive fails, nothing is written (so a
    meta.json never promises a tree that isn't there)."""
    if not enabled() or not isinstance(result, dict) or result.get("error"):
        return
    file_hash = file_sha256(target_rel)
    if not file_hash:
        return

    edir = _entry_dir(_key(tool_name, file_hash, extra))
    try:
        if capture_dir is not None and not _archive_tree(capture_dir, edir):
            _safe_rmtree(edir)
            return
        # Cache the FULL result dict, not just the canonical three keys. Whitelisting
        # stdout/stderr/returncode silently dropped every other key, which broke the
        # vision cache — a hit replayed a result missing its analysis payload, so the
        # caller saw a "cached" but empty answer. The canonical keys keep sensible
        # defaults so lookup() can always rely on them. The result must be
        # JSON-serializable; if a value isn't, json.dumps raises and the except-block
        # below fails open (no entry written) — consistent with the module's contract
        # that caching can only make things faster, never change or break a result.
        cached_result = dict(result)
        cached_result.setdefault("stdout", "")
        cached_result.setdefault("stderr", "")
        cached_result.setdefault("returncode", 0)
        meta = {
            "tool": tool_name,
            "file_sha256": file_hash,
            "extra": extra or {},
            "result": cached_result,
        }
        _write_atomic(os.path.join(edir, "meta.json"),
                      json.dumps(meta).encode("utf-8"))
    except Exception:
        # Never let a caching failure surface to the caller; don't leave a partial entry.
        _safe_rmtree(edir)


def purge():
    """Delete every cached entry. Returns a short status string. Safe to call any
    time — the cache is content-addressed, so this only reclaims disk (the next run
    of each tool simply repopulates it)."""
    root = _entries_root()
    if not os.path.isdir(root):
        return "cache already empty (%s)" % root
    _safe_rmtree(root)
    return "cleared tool cache at %s" % root
