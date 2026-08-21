"""General-purpose shell escape hatch.

Every other tool wraps a specific command. `run_command` is the catch-all for
the cases none of them cover: running a build (gradle, npm, make), a package
manager, a one-off python/awk/sed pipeline, a custom analysis script, or any CLI
that happens to be installed on the machine. It runs on the host, the same place
as the rest of the tools, with the project folder as the working directory, so
relative paths line up with what the file tools see.

Prefer a purpose-built tool when one exists (they give cleaner, paginated,
context-friendly output and steer you correctly) — reach for this only when
nothing else fits.
"""
import re as _re
from tool_registry import registry
from host_exec import run_cmd


# The agent bypassed the decode tools by shelling out — this is how the four
# partial decode trees in `fourth overnight` were created. Tool-level
# restriction alone is ineffective, so the shell is guarded too. The segment
# match stops at |, ; and & so only the clause naming the .apk is considered.
# 7z[ar]? catches the 7-Zip CLI variants 7z, 7za and 7zr — `\b7z\b` alone
# misses 7za/7zr because the trailing letter suppresses the word boundary.
_APK_DECODE_RE = _re.compile(
    r"\b(?:unzip|apktool|7z[ar]?|jar)\b[^|;&]*\.apk\b", _re.IGNORECASE)


def _decode_bypass(command):
    """Rejection message if `command` extracts/decodes an APK, else None."""
    if not _APK_DECODE_RE.search(command or ""):
        return None
    return ("Refused: this command extracts or decodes an APK through the "
            "shell. Use the decode_apk tool, which writes to the one canonical "
            "decode directory for that APK. Partial shell extractions produced "
            "four conflicting trees for a single APK in a previous run and are "
            "not a valid rebuild source.")


@registry.register(
    name="run_command",
    description=(
        "Runs an ARBITRARY shell command ON THE HOST MACHINE and returns its stdout/stderr and "
        "exit code. This is the general-purpose escape hatch for anything the specific tools don't cover: "
        "running a build (gradle/npm/make/python), a package manager, chained pipelines, or a custom analysis "
        "script. The command runs in a POSIX shell with the PROJECT FOLDER as the working directory, so relative "
        "paths match the other tools. It is non-interactive — commands that wait for input will hang until the "
        "timeout. The GNU userland (coreutils/sed/grep/findutils/gawk) is first on PATH, so GNU-style flags "
        "work. This is a REAL machine, not a disposable container — changes outside the project folder affect "
        "the user's actual system, so stay inside it. "
        "IMPORTANT: prefer a purpose-built tool when one exists (grep_directory, read_file_chunk, recompile_apk, "
        "extract_strings, etc.) — they return cleaner, paginated, context-friendly output and guide you toward "
        "the right workflow. Use run_command only when nothing else fits."
    ),
    params_schema={
        "command": "string (the shell command to run, e.g. 'cd myproj && ./gradlew assembleDebug' or 'python3 analyze.py foo.bin')",
        "timeout_seconds": "integer (optional, default 120, max 600 — how long to allow before the command is treated as timed out)"
    },
    output="The command's stdout and stderr plus its exit code. Output is returned as-is (it can be large — pipe through head/grep in the command itself to keep it focused). A non-zero exit code is reported, not treated as a tool failure.",
    when_to_use="Use this for build/run/scripting tasks or any CLI not covered by a dedicated tool. For searching files use grep_directory/search_smali, for reading use read_file_chunk, for APK/binary work use the apk_/binary_ tools — those are cheaper and clearer than raw shell."
)
def run_command(command, timeout_seconds=120):
    command = (command or "").strip()
    blocked = _decode_bypass(command)
    if blocked:
        return {"error": blocked}
    if not command:
        return {"error": "run_command requires a non-empty 'command'."}
    try:
        timeout_seconds = max(1, min(int(timeout_seconds), 600))
    except (TypeError, ValueError):
        timeout_seconds = 120
    # run_cmd already starts in the project folder, so the command needs no
    # prologue — relative paths line up with every other tool by construction.
    return run_cmd(command, timeout=timeout_seconds)
