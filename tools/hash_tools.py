"""Tools for verifying file integrity and equality using cryptographic hashes.

Currently provides a SHA256-based file comparison tool used by the Android
Reverse Engineer profile to confirm whether two APKs / .so libraries /
artifacts are byte-for-byte identical (handy after a rebuild or when
diffing two builds).
"""

from tool_registry import registry
from tools.common import normalize_path
from docker_sandbox import run_cmd


@registry.register(
    name="compare_files_sha256",
    description=(
        "Computes the SHA256 hash of two files and reports whether they are "
        "byte-for-byte identical. Use this to verify that a rebuilt/signed "
        "APK matches an expected reference, to confirm two .so libraries are "
        "the same build, or to check whether a patch actually changed a file. "
        "Returns a clear 'IDENTICAL' or 'DIFFERENT' verdict plus both SHA256 "
        "digests so you can record/compare them in notes."
    ),
    params_schema={
        "file_a": "string (path to the first file, relative to /workspace or absolute starting with /workspace)",
        "file_b": "string (path to the second file, relative to /workspace or absolute starting with /workspace)"
    },
    output="Three lines: VERDICT (IDENTICAL or DIFFERENT), SHA256 A (the digest of file_a), SHA256 B (the digest of file_b). If either file is missing, an ERROR line says which file does not exist.",
    when_to_use="Use this to verify a rebuilt/signed APK matches a reference, confirm two .so libs are the same build, or check whether a patch actually changed a file."
)
def compare_files_sha256(file_a, file_b):
    file_a = normalize_path(file_a)
    file_b = normalize_path(file_b)

    cmd = (
        # Bail out early with a clear message if either file is missing,
        # otherwise sha256sum/cmp would just fail opaquely.
        f"if [ ! -f /workspace/{file_a} ] || [ ! -f /workspace/{file_b} ]; then "
        f"  echo 'ERROR: One or both files do not exist.'; "
        f"  test -f /workspace/{file_a} && echo 'FILE_A (/workspace/{file_a}): exists' || echo 'FILE_A (/workspace/{file_a}): MISSING'; "
        f"  test -f /workspace/{file_b} && echo 'FILE_B (/workspace/{file_b}): exists' || echo 'FILE_B (/workspace/{file_b}): MISSING'; "
        f"  exit 1; "
        f"fi; "
        # cmp -s is a definitive byte-for-byte comparison (exit 0 => identical)
        f"cmp -s /workspace/{file_a} /workspace/{file_b} && verdict='IDENTICAL' || verdict='DIFFERENT'; "
        # sha256sum gives a human-readable digest for each file
        f"hash_a=$(sha256sum /workspace/{file_a} | awk '{{print $1}}'); "
        f"hash_b=$(sha256sum /workspace/{file_b} | awk '{{print $1}}'); "
        f"echo \"VERDICT: $verdict\"; "
        f"echo \"SHA256 A (/workspace/{file_a}): $hash_a\"; "
        f"echo \"SHA256 B (/workspace/{file_b}): $hash_b\""
    )
    return run_cmd(cmd, timeout=60)
