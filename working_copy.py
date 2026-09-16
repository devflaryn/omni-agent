"""Persistent scratch copies with explicit, conflict-checked publication.

``WorkingCopy.open(workspace, memory_dir)`` creates or resumes a temporary copy.
``root`` and ``workspace`` are absolute path strings (scratch and original).
``changes()`` returns sorted ``{path, status}`` records, using relative POSIX
paths and statuses added/modified/deleted/unsafe. ``promote(paths,
overwrite=False)`` publishes only explicitly selected *files*, returns the same
records, and updates their baseline. Selected deleted files are deleted from the
original. Conflicts raise WorkingCopyConflict unless overwrite=True; unsafe
paths always raise ValueError. The complete batch is validated before writing.

This is a working directory, not a security sandbox. Publication assumes no
other process replaces directories during the operation. Runtime I/O failures
can leave a partially published batch; successfully published files retain an
updated baseline. Scratch files remain available after publishing.
"""

import hashlib
import json
import os
from pathlib import Path, PureWindowsPath
import shutil
import stat
import tempfile
import threading


EXCLUDED = frozenset({".git", "node_modules", ".venv", "venv", "__pycache__",
                      ".pytest_cache", ".mypy_cache", ".ruff_cache", ".cache"})
_LOCK = threading.RLock()


class WorkingCopyConflict(ValueError):
    """The original has changed since the copy or last publication."""


def _link(path):
    try:
        info = path.lstat()
    except FileNotFoundError:
        return False
    return stat.S_ISLNK(info.st_mode) or bool(
        getattr(info, "st_file_attributes", 0) & 0x400)  # Windows reparse points


def _safe_root(value):
    path = Path(os.path.abspath(value))
    for part in (path, *path.parents):
        if _link(part):
            raise ValueError(f"Symlink/junction is not allowed: {part}")
    return path


def _digest(path):
    if not path.exists():
        return None
    if not path.is_file():
        raise ValueError(f"Expected a regular file: {path}")
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _scan(root):
    files, unsafe = {}, set()
    for directory, dirs, names in os.walk(root, followlinks=False):
        parent = Path(directory)
        for name in list(dirs):
            child = parent / name
            if name in EXCLUDED or _link(child):
                dirs.remove(name)
                if _link(child):
                    unsafe.add(child.relative_to(root).as_posix())
        for name in names:
            child = parent / name
            relative = child.relative_to(root).as_posix()
            if name in EXCLUDED:
                continue
            if _link(child) or not child.is_file():
                unsafe.add(relative)
            else:
                files[relative] = _digest(child)
    return files, unsafe


class WorkingCopy:
    def __init__(self, workspace, root, manifest, baseline):
        self.workspace = str(workspace)
        self.root = str(root)
        self._manifest = manifest
        self._baseline = baseline

    @classmethod
    def open(cls, workspace, memory_dir):
        with _LOCK:
            source = _safe_root(workspace)
            if not source.is_dir():
                raise ValueError(f"Workspace is not a directory: {source}")
            memory = _safe_root(memory_dir)
            memory.mkdir(parents=True, exist_ok=True)
            identity = hashlib.sha256(os.path.normcase(str(source)).encode()).hexdigest()[:20]
            manifest = memory / f"working-copy-{identity}.json"
            if _link(manifest):
                raise ValueError("Working-copy metadata cannot be a symlink")
            if manifest.exists():
                data = json.loads(manifest.read_text(encoding="utf-8"))
                if data.get("version") != 1 or data.get("workspace") != str(source):
                    raise ValueError("Working-copy metadata does not match workspace")
                root = _safe_root(data["root"])
                if not root.is_dir():
                    raise ValueError("Saved working copy is missing; preserve its metadata and start a new session")
                if root == source or source in root.parents or root in source.parents:
                    raise ValueError("Working copy must be outside the workspace")
                instance = cls(source, root, manifest, data["baseline"])
                for relative in instance._baseline:
                    instance._relative(relative)
                return instance
            root = Path(tempfile.mkdtemp(prefix="omni-agent-work-"))
            if source == root or source in root.parents:
                raise ValueError("Temporary storage must be outside the workspace")
            baseline, _ = _scan(source)
            # Session metadata inside the project must never copy itself.
            baseline = {p: h for p, h in baseline.items()
                        if (memory == source or memory not in (source / p).parents)
                        and source / p != manifest}
            for relative in baseline:
                target = root / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source / relative, target)
                baseline[relative] = _digest(target)
            instance = cls(source, root, manifest, baseline)
            instance._save()
            return instance

    def _save(self):
        data = {"version": 1, "workspace": self.workspace, "root": self.root,
                "baseline": self._baseline}
        fd, temporary = tempfile.mkstemp(prefix="working-copy-", suffix=".tmp", dir=self._manifest.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                json.dump(data, stream, indent=2)
            os.replace(temporary, self._manifest)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    @staticmethod
    def _relative(value):
        if not isinstance(value, str) or not value or "\x00" in value:
            raise ValueError("Select a nonempty relative file path")
        value = value.replace("\\", "/")
        parts = value.split("/")
        if PureWindowsPath(value).drive or value.startswith("/") or any(
                part in ("", ".", "..") or part in EXCLUDED or ":" in part
                or part.endswith((".", " ")) or (
                    os.path.isreserved(part) if hasattr(os.path, "isreserved")
                    else PureWindowsPath(part).is_reserved())
                for part in parts):
            raise ValueError(f"Unsafe or excluded path: {value}")
        return "/".join(parts)

    def _file(self, base, relative):
        root = _safe_root(base)
        if not root.is_dir():
            raise ValueError(f"Working-copy directory is missing: {root}")
        target = root
        for part in relative.split("/"):
            target /= part
            if _link(target):
                raise ValueError(f"Symlink/junction is not allowed: {target}")
            if target != root / relative and target.exists() and not target.is_dir():
                raise ValueError(f"Parent is not a directory: {target}")
        return target

    def changes(self):
        with _LOCK:
            root = _safe_root(self.root)
            if not root.is_dir():
                raise ValueError(f"Working-copy directory is missing: {root}")
            current, unsafe = _scan(root)
            result = []
            for relative in sorted(set(current) | set(self._baseline) | unsafe):
                if relative in unsafe or any(relative.startswith(p + "/") for p in unsafe):
                    status = "unsafe"
                elif current.get(relative) == self._baseline.get(relative):
                    continue
                else:
                    status = ("deleted" if relative not in current else
                              "added" if relative not in self._baseline else "modified")
                result.append({"path": relative, "status": status})
            return result

    def promote(self, paths, overwrite=False):
        if not isinstance(paths, (list, tuple)):
            raise ValueError("paths must be a list of relative file paths")
        with _LOCK:
            prepared = []
            for relative in dict.fromkeys(self._relative(p) for p in paths):
                scratch = self._file(self.root, relative)
                original = self._file(self.workspace, relative)
                digest, upstream = _digest(scratch), _digest(original)
                baseline = self._baseline.get(relative)
                if digest is None and baseline is None:
                    raise ValueError(f"No working-copy file to publish: {relative}")
                if upstream != baseline and not overwrite:
                    raise WorkingCopyConflict(f"Workspace changed: {relative}")
                if digest == baseline and upstream == digest:
                    continue
                status = "deleted" if digest is None else "added" if baseline is None else "modified"
                prepared.append((relative, scratch, original, digest, status))
            results = []
            for relative, scratch, original, digest, status in prepared:
                if digest is None:
                    original.unlink(missing_ok=True)
                    self._baseline.pop(relative, None)
                else:
                    original.parent.mkdir(parents=True, exist_ok=True)
                    fd, temporary = tempfile.mkstemp(prefix=".omni-publish-", dir=original.parent)
                    os.close(fd)
                    try:
                        shutil.copy2(scratch, temporary)
                        os.replace(temporary, original)
                    finally:
                        if os.path.exists(temporary):
                            os.unlink(temporary)
                    self._baseline[relative] = digest
                self._save()
                results.append({"path": relative, "status": status})
            return results
