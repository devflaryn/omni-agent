"""General-purpose shell escape hatch.

Every other tool wraps a specific command. `run_command` is the catch-all for
the cases none of them cover: running a build (gradle, npm, make), a package
manager, a one-off python/awk/sed pipeline, a custom analysis script, or any CLI
that happens to be installed in the sandbox image. It runs INSIDE the same Linux
Docker sandbox as the rest of the tools, with the working directory at
`/workspace`, so relative paths line up with what the file tools see.

Prefer a purpose-built tool when one exists (they give cleaner, paginated,
context-friendly output and steer you correctly) — reach for this only when
nothing else fits.
"""
from tool_registry import registry
from docker_sandbox import run_cmd


@registry.register(
    name="run_command",
    description=(
        "Runs an ARBITRARY shell command inside the Linux Docker sandbox and returns its stdout/stderr and "
        "exit code. This is the general-purpose escape hatch for anything the specific tools don't cover: "
        "running a build (gradle/npm/make/python), a package manager, chained pipelines, or a custom analysis "
        "script. The command runs with `sh -c`; the working directory is `/workspace`, so relative paths match "
        "the other tools (write files under /workspace to keep them). It is non-interactive — commands that "
        "wait for input will hang until the timeout. "
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
    if not command:
        return {"error": "run_command requires a non-empty 'command'."}
    try:
        timeout_seconds = max(1, min(int(timeout_seconds), 600))
    except (TypeError, ValueError):
        timeout_seconds = 120
    # Run from /workspace so relative paths line up with every other tool.
    return run_cmd(f"cd /workspace && {command}", timeout=timeout_seconds)
