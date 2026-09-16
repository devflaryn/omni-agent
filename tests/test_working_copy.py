"""Offline scratch-directory and explicit publication regression tests."""
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from working_copy import WorkingCopy, WorkingCopyConflict


class WorkingCopyTests(unittest.TestCase):
    def setUp(self):
        self.area = tempfile.TemporaryDirectory(prefix="omni test ")
        self.base = Path(self.area.name)
        self.workspace = self.base / "original project"
        self.workspace.mkdir()
        self.memory = self.base / "memory"
        (self.workspace / "first.txt").write_text("first")
        (self.workspace / "second.txt").write_text("second")
        self.copy = WorkingCopy.open(self.workspace, self.memory)
        self.root = Path(self.copy.root)

    def tearDown(self):
        # Only the verified tempfile-owned roots allocated in setUp are removed.
        shutil.rmtree(self.root)
        self.area.cleanup()

    def test_isolation_selection_and_resume(self):
        (self.root / "first.txt").write_text("edited")
        (self.root / "new folder").mkdir()
        (self.root / "new folder/new.txt").write_text("new")
        self.assertEqual((self.workspace / "first.txt").read_text(), "first")
        reopened = WorkingCopy.open(self.workspace, self.memory)
        self.assertEqual(reopened.root, self.copy.root)
        self.assertEqual(reopened.changes(), [
            {"path": "first.txt", "status": "modified"},
            {"path": "new folder/new.txt", "status": "added"}])
        self.assertEqual(reopened.promote(["new folder/new.txt"]), [
            {"path": "new folder/new.txt", "status": "added"}])
        self.assertEqual((self.workspace / "first.txt").read_text(), "first")
        self.assertEqual((self.root / "new folder/new.txt").read_text(), "new")
        self.assertEqual(WorkingCopy.open(self.workspace, self.memory).changes(),
                         [{"path": "first.txt", "status": "modified"}])

    def test_conflict_validates_entire_batch_and_overwrite_is_explicit(self):
        (self.root / "first.txt").write_text("agent first")
        (self.root / "second.txt").write_text("agent second")
        (self.workspace / "second.txt").write_text("user second")
        with self.assertRaises(WorkingCopyConflict):
            self.copy.promote(["first.txt", "second.txt"])
        self.assertEqual((self.workspace / "first.txt").read_text(), "first")
        self.copy.promote(["second.txt"], overwrite=True)
        self.assertEqual((self.workspace / "second.txt").read_text(), "agent second")

    def test_deletion_requires_selection_and_conflicts(self):
        (self.root / "first.txt").unlink()
        self.assertEqual(self.copy.changes(), [{"path": "first.txt", "status": "deleted"}])
        self.copy.promote([])
        self.assertTrue((self.workspace / "first.txt").exists())
        (self.workspace / "first.txt").write_text("user edit")
        with self.assertRaises(WorkingCopyConflict):
            self.copy.promote(["first.txt"])
        self.copy.promote(["first.txt"], overwrite=True)
        self.assertFalse((self.workspace / "first.txt").exists())
        self.assertEqual(self.copy.changes(), [])

    def test_traversal_absolute_and_excluded_paths_rejected(self):
        (self.root / "first.txt").write_text("edited")
        for unsafe in ("../escape", "a/../../escape", str(self.workspace / "first.txt"),
                       "C:escape", "\\\\host\\share", "a/../first.txt", ".git/config",
                       "node_modules/a", "file:stream", "name.", "NUL", "a//b"):
            with self.subTest(unsafe=unsafe), self.assertRaises(ValueError):
                self.copy.promote(["first.txt", unsafe], overwrite=True)
        self.assertEqual((self.workspace / "first.txt").read_text(), "first")

    def test_new_file_upstream_conflict(self):
        (self.root / "new.txt").write_text("agent")
        (self.workspace / "new.txt").write_text("user")
        with self.assertRaises(WorkingCopyConflict):
            self.copy.promote(["new.txt"])

    def test_exclusions_and_metadata(self):
        (self.workspace / "node_modules").mkdir()
        (self.workspace / "node_modules/huge").write_text("ignored")
        other = WorkingCopy.open(self.workspace, self.workspace / "session-memory")
        try:
            self.assertFalse((Path(other.root) / "node_modules").exists())
            self.assertFalse((Path(other.root) / "session-memory").exists())
        finally:
            shutil.rmtree(other.root)

    def test_symlink_never_published_or_followed(self):
        external = self.base / "external"
        external.mkdir()
        (external / "secret").write_text("untouched")
        try:
            (self.root / "link").symlink_to(external, target_is_directory=True)
        except OSError:
            self.skipTest("Creating symlinks is unavailable on this host")
        with self.assertRaises(ValueError):
            self.copy.promote(["link/secret"], overwrite=True)
        (self.workspace / "link").symlink_to(external, target_is_directory=True)
        (self.root / "link").unlink()
        (self.root / "link").mkdir()
        (self.root / "link/secret").write_text("attack")
        with self.assertRaises(ValueError):
            self.copy.promote(["link/secret"], overwrite=True)
        self.assertEqual((external / "secret").read_text(), "untouched")
        other = WorkingCopy.open(self.workspace, self.base / "other memory")
        try:
            self.assertFalse((Path(other.root) / "link").exists())
        finally:
            shutil.rmtree(other.root)


if __name__ == "__main__":
    unittest.main()
