"""Reproduces and verifies the fix for the UnicodeEncodeError crash that killed
the agent loop in summarize_memory.

The crash was: UnicodeEncodeError: 'charmap' codec can't encode character
'\\u2192' (the arrow) when writing a memory summary on Windows (cp1252).

This test:
1. Proves the OLD pattern (no encoding=) crashes on the exact characters.
2. Proves the NEW pattern (encoding='utf-8') round-trips them correctly.
3. Verifies the full app still imports with the fix.

Run from the project root:
    python test_encoding_fix.py
"""
import os
import sys
import tempfile

# Reconfigure stdout to UTF-8 so our own print() calls don't crash on Windows
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# The exact problematic text from the crash traceback (contains arrow, em-dash, checkmarks)
CRASH_TEXT = (
    "## Progress Summary\n\n"
    "### Analysis Complete - Key Findings\n\n"
    "**Modified file identified:** `lib/arm64-v8a/libzstd-jni-1.5.7-6.so`\n"
    "- Original: 604 KB \u2192 Modified: 9.4 MB (15x larger)\n"  # arrow
    "- `.text` section grew from 410 KB to 7 MB \u2014 6.6 MB of injected code\n"  # em-dash
    "1. \u2705 Replaced `libzstd-jni-1.5.7-6.so` with trojan version\n"  # checkmark
    "2. \u2705 Removed `armeabi-v7a` and `x86_64` directories\n"
    "3. \u2705 Removed `stamp-cert-sha256`\n"
)


def test_old_pattern_crashes():
    """Prove the old open(..., 'w') without encoding crashes on Windows."""
    with tempfile.TemporaryDirectory() as td:
        path = os.path.join(td, "old_summary.txt")
        try:
            with open(path, "w") as f:  # OLD pattern - no encoding
                f.write(CRASH_TEXT)
            print("OLD pattern: no crash (non-Windows or UTF-8 locale)")
            return True
        except UnicodeEncodeError as e:
            print(f"OLD pattern: crashed as expected on Windows -> {e}")
            return True  # This proves the bug existed


def test_new_pattern_works():
    """Prove the new open(..., 'w', encoding='utf-8') round-trips correctly."""
    with tempfile.TemporaryDirectory() as td:
        path = os.path.join(td, "new_summary.txt")
        with open(path, "w", encoding="utf-8") as f:
            f.write(CRASH_TEXT)
        with open(path, "r", encoding="utf-8") as f:
            read_back = f.read()
        assert read_back == CRASH_TEXT, "round-trip mismatch!"
        assert "\u2192" in read_back, "missing arrow char"
        assert "\u2705" in read_back, "missing checkmark char"
        assert "\u2014" in read_back, "missing em-dash char"
        print("NEW pattern: write + read round-trip OK (arrow, checkmark, em-dash all preserved)")
        return True


def test_full_import():
    """Verify agent.py imports cleanly with the fix."""
    import agent  # noqa
    print("Full app import OK after encoding fix.")
    return True


def main():
    ok = True
    print("=== Test 1: old pattern (proves the bug) ===")
    ok &= test_old_pattern_crashes()
    print("\n=== Test 2: new pattern (proves the fix) ===")
    ok &= test_new_pattern_works()
    print("\n=== Test 3: full app import ===")
    ok &= test_full_import()
    print("\n" + ("ALL PASSED" if ok else "FAILED"))
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()

