"""Text analysis and log-handling tools.

These help the agent work with large text files (crash logs, decompiler output,
build logs) without dumping thousands of lines into the context window:
  - grep_file    : regex search inside a file, paginated
  - tail_file    : last N lines of a file (crash logs, build output)
  - compare_directories : diff two directories to find what files differ
"""
from tool_registry import registry
from tools.common import normalize_path, build_paginated_command, append_page_hint, wpath
from host_exec import run_cmd


@registry.register(
    name="grep_file",
    description=(
        "Searches inside a single file for lines matching a regex pattern. "
        "Use this for log files, decompiler output, or any large text file — "
        "it returns only matching lines (with line numbers) instead of the whole file, saving context. "
        "Supports pagination via skip/max_lines for files with many matches. "
        "Example: grep_file filepath='crash.log' pattern='FATAL|Exception' to find crash lines."
    ),
    params_schema={
        "filepath": "string (path to the file to search, relative to the project root)",
        "pattern": "string (regex pattern to match, e.g. 'FATAL|Exception|Error')",
        "max_lines": "integer (optional, max matching lines to return, default 100)",
        "skip": "integer (optional, number of matches to skip for pagination, default 0)",
        "case_insensitive": "boolean (optional, default true)"
    },
    output="Each matching line prefixed with its line number ('filepath:linenum: line'). A pagination hint tells you the next skip value. If no matches, it says '(no matches found)'.",
    when_to_use="Use this to search inside a single large text file (logs, decompiler output, build logs) for specific patterns without reading the whole file. For searching across many smali files, use search_smali instead."
)
def grep_file(filepath, pattern, max_lines=100, skip=0, case_insensitive=True):
    filepath = normalize_path(filepath)
    ci_flag = "-i" if case_insensitive in (True, "true", "True", 1, "1") else ""
    # -E for extended regex so | works as alternation (e.g. 'FATAL|ERROR')
    base = f"grep -nE {ci_flag} '{pattern}' {wpath(filepath)}"
    cmd = build_paginated_command(base, max_lines=max_lines, skip=skip)
    res = run_cmd(cmd, timeout=60)
    if res["returncode"] == 0 or res.get("stdout"):
        out = f"--- grep '{pattern}' in {filepath} (matches below) ---\n"
        out += res.get("stdout", "")
        if not res.get("stdout"):
            out += "(no matches found)\n"
        res["stdout"] = out
        return append_page_hint(res, skip, max_lines)
    # grep returns exit code 1 when no matches — that's not an error
    if res["returncode"] == 1:
        return {"stdout": f"--- grep '{pattern}' in {filepath} ---\n(no matches found)\n"}
    return res


@registry.register(
    name="tail_file",
    description=(
        "Returns the last N lines of a file. Use this for crash logs, build output, "
        "or any file where the important info is at the end (errors usually appear last). "
        "Much more efficient than read_file_chunk when you just need to see how a log ends."
    ),
    params_schema={
        "filepath": "string (path to the file, relative to the project root)",
        "num_lines": "integer (optional, number of lines from the end, default 100)"
    },
    output="A header showing total line count, followed by the last N lines of the file. Much more efficient than read_file_chunk when you only need the tail.",
    when_to_use="Use this for crash logs, build output, or any file where the important info (errors, stack traces) is at the END."
)
def tail_file(filepath, num_lines=100):
    filepath = normalize_path(filepath)
    try:
        num_lines = int(num_lines)
    except Exception:
        num_lines = 100
    count_cmd = f"wc -l < {wpath(filepath)}"
    count_res = run_cmd(count_cmd, timeout=10)
    total = count_res["stdout"].strip() if count_res["returncode"] == 0 else "?"
    cmd = f"tail -n {num_lines} {wpath(filepath)}"
    res = run_cmd(cmd, timeout=60)
    if res["returncode"] != 0:
        return res
    out = f"--- Last {num_lines} lines of {filepath} (Total lines: {total}) ---\n"
    out += res["stdout"]
    return {"stdout": out}



@registry.register(
    name="grep_directory",
    description=(
        "Recursively searches a directory tree for lines matching a regex, across ANY file type — "
        "not just smali (that's search_smali) and not just one file (that's grep_file). "
        "This is the general search tool for large codebases: find a string/pattern anywhere in a "
        "decompiled or jadx-decompiled app — smali, Java, XML resources, AndroidManifest, JSON/JS/HTML "
        "assets, native strings dumped to text, config files. "
        "Use include_glob to restrict to certain files (e.g. '*.java', '*.xml') and exclude_glob to skip "
        "noise (e.g. '*.png'). Results are paginated with skip/max_lines."
    ),
    params_schema={
        "directory": "string (directory to search under, relative to the project root, e.g. 'app_jadx/sources')",
        "pattern": "string (regex pattern to match, e.g. 'https?://|api_key|Base64')",
        "include_glob": "string (optional, only search files matching this glob, e.g. '*.java' or '*.xml')",
        "exclude_glob": "string (optional, skip files matching this glob, e.g. '*.png')",
        "max_lines": "integer (optional, max matching lines to return, default 100)",
        "skip": "integer (optional, matches to skip for pagination, default 0)",
        "case_insensitive": "boolean (optional, default true)"
    },
    output="Each match as 'filepath:linenum: line'. A pagination hint gives the next skip value if more matches exist. If nothing matches, says '(no matches found)'.",
    when_to_use="Use this to search across a whole decompiled/jadx tree or any mixed-file-type folder. For smali-only searches search_smali is a shortcut; for a single known file use grep_file. Restrict with include_glob on big trees to keep it fast."
)
def grep_directory(directory, pattern, include_glob=None, exclude_glob=None,
                   max_lines=100, skip=0, case_insensitive=True):
    directory = normalize_path(directory)
    ci_flag = "-i " if case_insensitive in (True, "true", "True", 1, "1") else ""
    inc = f"--include={include_glob!r} " if include_glob else ""
    exc = f"--exclude={exclude_glob!r} " if exclude_glob else ""
    base = f"grep -rnE {ci_flag}{inc}{exc}'{pattern}' {wpath(directory)}"
    cmd = build_paginated_command(base, max_lines=max_lines, skip=skip)
    res = run_cmd(cmd, timeout=180)
    if res["returncode"] == 0 or res.get("stdout"):
        out = f"--- grep -r '{pattern}' in {directory} ---\n"
        out += res.get("stdout", "") or "(no matches found)\n"
        res["stdout"] = out
        return append_page_hint(res, skip, max_lines)
    # grep exit 1 = no matches (not an error); >1 = real error
    if res.get("returncode") == 1:
        return {"stdout": f"--- grep -r '{pattern}' in {directory} ---\n(no matches found)\n"}
    return res


@registry.register(
    name="compare_directories",
    description=(
        "Compares two directories in the workspace and reports which files differ, "
        "which exist only in one, and which are identical. Use this to compare two "
        "extracted/decompiled APKs, two versions of a codebase, or any two folder trees. "
        "Returns a compact summary (file paths + status) — not file contents."
    ),
    params_schema={
        "dir_a": "string (first directory, relative to the project root)",
        "dir_b": "string (second directory, relative to the project root)",
        "max_results": "integer (optional, max differences to report, default 200)"
    },
    output="A header with file counts for each directory, then a list of differences: 'Files dir_a/file and dir_b/file differ', 'Only in dir_a: file', etc. If identical, says 'Directories are identical.'",
    when_to_use="Use this to compare two extracted/decompiled APKs, two versions of a codebase, or any two folder trees to find what changed."
)
def compare_directories(dir_a, dir_b, max_results=200):
    dir_a = normalize_path(dir_a)
    dir_b = normalize_path(dir_b)
    try:
        max_results = int(max_results)
    except Exception:
        max_results = 200
    cmd = f"diff -rq {wpath(dir_a)} {wpath(dir_b)} | head -n {max_results}"
    res = run_cmd(cmd, timeout=120)
    count_a = run_cmd(f"find {wpath(dir_a)} -type f | wc -l", timeout=30)
    count_b = run_cmd(f"find {wpath(dir_b)} -type f | wc -l", timeout=30)
    n_a = count_a["stdout"].strip() if count_a["returncode"] == 0 else "?"
    n_b = count_b["stdout"].strip() if count_b["returncode"] == 0 else "?"
    if res["returncode"] == 0 and not res.get("stdout"):
        return {"stdout": f"Directories are identical.\n{dir_a}: {n_a} files\n{dir_b}: {n_b} files"}
    out = f"--- Comparing {dir_a} ({n_a} files) vs {dir_b} ({n_b} files) ---\n"
    out += res.get("stdout", "")
    if res.get("stderr"):
        out += f"\n[stderr] {res['stderr'][:500]}"
    return {"stdout": out}