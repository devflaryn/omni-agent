"""Live test for the new tools against the Docker sandbox."""
import tools  # noqa
from tool_registry import registry


def run(name, args):
    print(f"\n=== {name} {args} ===")
    res = registry.execute(name, args)
    out = res.get("stdout", "") or str(res)
    print(out[:2000])
    return out


# 1. grep_file - create a test log and search it
registry.execute("write_file", {"filepath": "test_log.txt", "content":
    "INFO: Starting app\nERROR: NullPointer at line 42\nWARNING: Low memory\n"
    "FATAL: Crash in native code\nINFO: Restarting\nFATAL: SIGSEGV at 0xdead\n"
})
run("grep_file", {"filepath": "test_log.txt", "pattern": "FATAL|ERROR"})

# 2. tail_file
run("tail_file", {"filepath": "test_log.txt", "num_lines": 3})

# 3. compare_directories - create two dirs with a difference
registry.execute("write_file", {"filepath": "cmp_a/file1.txt", "content": "hello"})
registry.execute("write_file", {"filepath": "cmp_a/file2.txt", "content": "world"})
registry.execute("write_file", {"filepath": "cmp_b/file1.txt", "content": "hello"})
registry.execute("write_file", {"filepath": "cmp_b/file3.txt", "content": "new"})
run("compare_directories", {"dir_a": "cmp_a", "dir_b": "cmp_b"})

# 4. inspect_apk - use a test zip as proxy (no real APK handy)
import subprocess
subprocess.run(["docker", "exec", "re_agent_sandbox", "sh", "-c",
    "cd /workspace && echo test > AndroidManifest.xml && echo dex > classes.dex && "
    "zip test.apk AndroidManifest.xml classes.dex"], capture_output=True)
run("inspect_apk", {"apk_filename": "test.apk", "filter_pattern": ".dex"})

# 5. verify_apk - will fail (not properly signed) but should show the checks
run("verify_apk", {"apk_filename": "test.apk"})

# Cleanup
import subprocess
subprocess.run(["docker", "exec", "re_agent_sandbox", "sh", "-c",
    "rm -rf /workspace/test_log.txt /workspace/cmp_a /workspace/cmp_b /workspace/test.apk /workspace/AndroidManifest.xml /workspace/classes.dex"],
    capture_output=True)
print("\n>>> ALL NEW TOOL TESTS DONE. Cleaned up.")
