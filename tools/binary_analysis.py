"""Native binary analysis tools.

Fast, targeted inspection of ELF binaries (.so libraries) without forcing a
full-binary analysis that would hang on 100MB+ stripped shared libraries.
Includes: strings, rabin2, nm, objdump, readelf, targeted radare2, targeted
range disassembly, and Ghidra headless decompilation to C pseudocode.

Reorganized out of the original ``reverse_engineering.py`` so all binary
inspection tooling lives in one focused, readable module.
"""
import base64
import hashlib
import os
import re
import shlex

from tool_registry import registry
from tools.common import normalize_path, build_paginated_command, append_page_hint, clean_hex
from docker_sandbox import run_cmd

# Shell snippet that resolves the llvm-objdump binary (the `llvm` package ships an
# unversioned /usr/bin/llvm-objdump symlink, but fall back to the versioned name
# in case only that is present). Prepended to any command that shells out to
# llvm-objdump; if neither is installed it prints an actionable error and exits.
_LLVM_OBJDUMP_RESOLVE = (
    'LOBJ=$(command -v llvm-objdump 2>/dev/null || command -v llvm-objdump-14 2>/dev/null); '
    'if [ -z "$LOBJ" ]; then '
    'echo "ERROR: llvm-objdump is not installed in the sandbox. Rebuild the image '
    '(the Dockerfile installs the llvm package), or use disassemble_range (objdump) instead."; '
    'exit 1; fi; '
)

_HERE = os.path.dirname(os.path.abspath(__file__))
_GHIDRA_SCRIPT_PATH = os.path.join(_HERE, "_ghidra_decompile.py")


# ---------------------------------------------------------------------------
# Symbol / string / section listing (fast, paginated)
# ---------------------------------------------------------------------------

@registry.register(
    name="extract_strings",
    description=(
        "Extracts printable strings from a binary using the 'strings' command, with optional grep filtering. "
        "Fast and safe even on 100MB+ binaries. Use filter_pattern to focus on relevant strings "
        "(e.g. 'lua', 'http', 'roblox', 'error', 'signature', 'verify'). "
        "Use skip to paginate: skip=0 returns first max_lines, skip=200 returns next batch, etc. "
        "If output is truncated, call again with skip increased by max_lines."
    ),
    params_schema={
        "binary_path": "string",
        "min_length": "integer (optional, minimum string length, default 6)",
        "filter_pattern": "string (optional, grep pattern to filter results)",
        "max_lines": "integer (optional, max results to return, default 200)",
        "skip": "integer (optional, number of lines to skip for pagination, default 0)"
    },
    output="One printable string per line (optionally filtered by filter_pattern). A pagination hint at the end tells you the next skip value if more results exist.",
    when_to_use="Use this to find human-readable text inside a binary: URLs, error messages, API keys, function names embedded as strings, log tags. Safe on 100MB+ binaries."
)
def extract_strings(binary_path, min_length=6, filter_pattern=None, max_lines=200, skip=0):
    binary_path = normalize_path(binary_path)
    cmd = build_paginated_command(
        f"strings -n {min_length} /workspace/{binary_path}",
        filter_pattern=filter_pattern,
        max_lines=max_lines,
        skip=skip,
    )
    res = run_cmd(cmd, timeout=120)
    return append_page_hint(res, skip, max_lines)


@registry.register(
    name="rabin2_info",
    description=(
        "Runs rabin2 (from radare2 suite) on a binary for fast metadata extraction without loading r2. "
        "Much faster than radare2_cmd for symbol/string/section queries on large binaries. "
        "mode options: "
        "  '-s'  = symbol table (exported + imported functions), "
        "  '-z'  = strings from data sections only, "
        "  '-S'  = section names and sizes, "
        "  '-l'  = linked libraries, "
        "  '-i'  = imports, "
        "  '-e'  = entrypoints. "
        "Use filter_pattern to grep results. "
        "Use skip to paginate: skip=0 returns lines 1-300, skip=300 returns lines 301-600, etc. "
        "If output ends with a truncation warning, call again with skip increased by max_lines."
    ),
    params_schema={
        "binary_path": "string",
        "mode": "string (e.g. '-s', '-z', '-S', '-l', '-i', '-e')",
        "filter_pattern": "string (optional grep pattern)",
        "max_lines": "integer (optional, default 300)",
        "skip": "integer (optional, number of lines to skip for pagination, default 0)"
    },
    output="Depends on mode: '-s' lists symbols (addr type name), '-z' lists data-section strings, '-S' lists sections with sizes, '-l' lists linked libraries, '-i' lists imports, '-e' lists entrypoints. Results are paginated with a next-skip hint.",
    when_to_use="Use this for FAST metadata extraction from a binary. Much faster than radare2_cmd. Use '-s' to find function names, '-i' for imports of a stripped binary, '-S' for section layout."
)
def rabin2_info(binary_path, mode="-s", filter_pattern=None, max_lines=300, skip=0):
    binary_path = normalize_path(binary_path)
    cmd = build_paginated_command(
        f"rabin2 {mode} /workspace/{binary_path}",
        filter_pattern=filter_pattern,
        max_lines=max_lines,
        skip=skip,
    )
    res = run_cmd(cmd, timeout=120)
    return append_page_hint(res, skip, max_lines)


@registry.register(
    name="nm_symbols",
    description=(
        "Lists symbols in a binary using 'nm'. Faster than objdump for large files. "
        "Use filter_pattern to search for specific function names. "
        "Use skip to paginate: skip=0 returns first max_lines, skip=300 returns next batch, etc. "
        "Note: works best on non-stripped binaries; for stripped ones use rabin2_info with '-i' (imports) instead."
    ),
    params_schema={
        "binary_path": "string",
        "filter_pattern": "string (optional grep pattern, e.g. 'Lua', 'JNI', 'init')",
        "max_lines": "integer (optional, default 300)",
        "skip": "integer (optional, lines to skip for pagination, default 0)"
    },
    output="Symbol table lines: address, symbol type (T/D/B/etc.), and symbol name. Filtered by filter_pattern if set. Paginated with a next-skip hint.",
    when_to_use="Use this to list symbols in a NON-STRIPPED binary. For stripped binaries (no symbol table), use rabin2_info with '-i' (imports) instead. Faster than objdump for large files."
)
def nm_symbols(binary_path, filter_pattern=None, max_lines=300, skip=0):
    binary_path = normalize_path(binary_path)
    cmd = build_paginated_command(
        f"nm -D /workspace/{binary_path} 2>/dev/null",
        filter_pattern=filter_pattern,
        max_lines=max_lines,
        skip=skip,
    )
    res = run_cmd(cmd, timeout=120)
    return append_page_hint(res, skip, max_lines)


@registry.register(
    name="readelf_info",
    description="Uses readelf to get information from an ELF file (.so), such as sections, dynamic symbols, etc.",
    params_schema={"so_filename": "string", "args": "string (e.g. '-a' for all, '-d' for dynamic section, '-Ws' for symbols)"},
    output="readelf formatted output for the requested section type. '-d' shows the dynamic section (NEEDED libraries, SONAME, etc.), '-Ws' shows the symbol table, '-a' shows everything.",
    when_to_use="Use this to inspect ELF structure: which shared libraries a .so depends on (-d), its sections (-S), or its full symbol table (-Ws)."
)
def readelf_info(so_filename, args="-d"):
    so_filename = normalize_path(so_filename)
    cmd = f"readelf {args} /workspace/{so_filename}"
    return run_cmd(cmd, timeout=120)


# ---------------------------------------------------------------------------
# Disassembly / decompilation
# ---------------------------------------------------------------------------

@registry.register(
    name="radare2_cmd",
    summary="run SPECIFIC radare2 commands (escape hatch; never full 'aaa' on big binaries)",
    description=(
        "Runs radare2 commands on a binary. "
        "IMPORTANT: Never use 'aaa' or 'aaaa' on large binaries (>5MB) — they hang. "
        "For symbol listing use rabin2_info instead. "
        "For targeted disassembly use: r2_args='-c \"s sym.foo; pd 40\"'. "
        "Use 'aa' (not 'aaa') if analysis is needed. "
        "timeout_seconds controls how long the command is allowed to run (default 30)."
    ),
    params_schema={
        "binary_path": "string",
        "r2_args": "string (e.g., '-c \"s sym.foo; pd 40\"' or '-c \"aa; afl~main\"')",
        "timeout_seconds": "integer (optional, default 30, max 120)"
    },
    output="Whatever the radare2 command prints: disassembly (pd), function list (afl), or analysis output. If the command times out, a timeout error is returned.",
    when_to_use="Use this for targeted radare2 analysis: disassemble a specific function, list functions matching a pattern, or run analysis. NEVER use 'aaa'/'aaaa' on binaries >5MB (they hang). Use 'aa' instead. For simple symbol listing, rabin2_info is faster."
)
def radare2_cmd(binary_path, r2_args, timeout_seconds=30):
    binary_path = normalize_path(binary_path)
    timeout_seconds = max(5, min(int(timeout_seconds), 120))
    # -N skips auto-analysis on startup
    cmd = f"r2 -N -q {r2_args} /workspace/{binary_path}"
    return run_cmd(cmd, timeout=timeout_seconds)


@registry.register(
    name="disassemble_range",
    summary="objdump disassembly of a file-offset range (safe on huge .so)",
    description=(
        "Disassembles a specific address range in a binary using objdump. "
        "Safe on large binaries because it only reads the requested range. "
        "Use this instead of radare2_cmd for targeted disassembly of known addresses. "
        "Get the address of a symbol first with rabin2_info or nm_symbols."
    ),
    params_schema={
        "binary_path": "string",
        "start_address": "string (hex address, e.g. '0x1a2b3c')",
        "stop_address": "string (hex address, e.g. '0x1a2c00')"
    },
    output="objdump disassembly of the requested address range: address, hex bytes, and assembly instructions. Only the requested range is read, so it's safe on huge binaries.",
    when_to_use="Use this to disassemble a KNOWN address range (e.g. a function you found via rabin2_info or nm_symbols). Safer and faster than radare2_cmd for targeted disassembly."
)
def disassemble_range(binary_path, start_address, stop_address):
    binary_path = normalize_path(binary_path)
    cmd = (
        f"objdump -d --start-address={start_address} --stop-address={stop_address} "
        f"/workspace/{binary_path}"
    )
    return run_cmd(cmd, timeout=120)


# ---------------------------------------------------------------------------
# Ghidra headless decompilation (raw asm -> readable C pseudocode)
# ---------------------------------------------------------------------------

@registry.register(
    name="ghidra_decompile",
    description=(
        "Decompiles native function(s) in a .so to C-like pseudocode using Ghidra's headless analyzer. "
        "This is the single most useful tool for UNDERSTANDING obfuscated or crypto-shaped native code — "
        "loops with XOR/shift/table lookups, multi-branch checks, string decryptors — that are painful to "
        "follow in raw disassembly. "
        "Pass function_name as a case-insensitive substring of the symbol to decompile (e.g. 'checkLicense', "
        "'JNI_OnLoad', 'Java_com_example'); matching functions are returned as C. "
        "Leave function_name empty to instead LIST every function name in the binary so you can pick one "
        "(useful when the target isn't obvious). "
        "IMPORTANT: the FIRST call on a given binary is slow (2-5 min) while Ghidra builds and caches its "
        "analysis database under /workspace/.ghidra_proj; later calls on the same .so reuse that cache and "
        "are fast. Raise timeout_seconds for very large libraries."
    ),
    params_schema={
        "binary_path": "string (path to the .so file, relative to /workspace, e.g. 'lib/arm64-v8a/libfoo.so')",
        "function_name": "string (optional, case-insensitive substring of the function/symbol name to decompile; empty = list all function names instead)",
        "max_functions": "integer (optional, max matching functions to decompile in one call, default 5)",
        "timeout_seconds": "integer (optional, default 360; raise for large binaries whose first-time analysis is slow)"
    },
    output="C pseudocode for each matching function, each prefixed with '// ==== <name> @ <address> ===='. If function_name is empty, a list of function names instead. Ghidra's own analysis logging is stripped out; only the decompiled payload is returned. If nothing matches, a hint tells you to list names or use rabin2_info.",
    when_to_use="Use this when disassembly (disassemble_range/radare2_cmd) is too hard to follow and you need to understand what a native function actually DOES — reverse-engineering an obfuscated check, a string-decryption routine, or complex branch logic. For simple symbol/string listing, rabin2_info/extract_strings are faster; reach for Ghidra when you need to read the logic."
)
def ghidra_decompile(binary_path, function_name="", max_functions=5, timeout_seconds=360):
    binary_path = normalize_path(binary_path)
    try:
        timeout_seconds = max(60, min(int(timeout_seconds), 1800))
    except (TypeError, ValueError):
        timeout_seconds = 360
    try:
        max_functions = max(1, min(int(max_functions), 25))
    except (TypeError, ValueError):
        max_functions = 5

    target = (function_name or "").strip()

    # Ship the Ghidra Jython post-script into the sandbox (base64, same trick
    # write_file / the code-graph scripts use to dodge shell-escaping issues).
    try:
        with open(_GHIDRA_SCRIPT_PATH, encoding="utf-8") as fh:
            script = fh.read()
    except OSError as e:
        return {"error": f"Could not read the bundled Ghidra script: {e}"}
    b64_script = base64.b64encode(script.encode("utf-8")).decode("ascii")

    # One cached Ghidra project per binary so re-analysis only happens once.
    proj_dir = "/workspace/.ghidra_proj"
    proj_name = "gp_" + hashlib.md5(binary_path.encode("utf-8")).hexdigest()[:12]
    b64_target = base64.b64encode(target.encode("utf-8")).decode("ascii")

    # -import on the first run (analyze + cache); -process -noanalysis on later
    # runs to reuse the cached analysis database and stay fast.
    cmd = (
        f"set -e; mkdir -p {proj_dir}; "
        f"echo '{b64_script}' | base64 -d > /tmp/_ghidra_decompile.py; "
        f"TARGET=$(echo '{b64_target}' | base64 -d); "
        f"if [ -f {proj_dir}/{proj_name}.gpr ]; then "
        f"  MODE=\"-process $(basename /workspace/{binary_path}) -noanalysis\"; "
        f"else "
        f"  MODE=\"-import /workspace/{binary_path}\"; "
        f"fi; "
        f"/opt/ghidra/support/analyzeHeadless {proj_dir} {proj_name} $MODE "
        f"-scriptPath /tmp -postScript _ghidra_decompile.py \"$TARGET\" \"{max_functions}\" 2>&1"
    )
    res = run_cmd(cmd, timeout=timeout_seconds)
    out = res.get("stdout", "") or ""

    # Strip Ghidra's verbose logging: keep only our marked payload.
    if "GHIDRA_DECOMPILE_BEGIN" in out and "GHIDRA_DECOMPILE_END" in out:
        core = out.split("GHIDRA_DECOMPILE_BEGIN", 1)[1].split("GHIDRA_DECOMPILE_END", 1)[0].strip()
        return {"stdout": core}

    # No markers => Ghidra failed before the script ran. A failed run can leave a
    # half-created / lock-held project behind that would make the NEXT call take
    # the broken cached (-process) path — so wipe this project namespace and any
    # stale lock so a retry re-imports cleanly.
    run_cmd(
        f"rm -rf {proj_dir}/{proj_name}.gpr {proj_dir}/{proj_name}.rep "
        f"{proj_dir}/{proj_name}.lock {proj_dir}/{proj_name}.lock~ 2>/dev/null || true",
        timeout=30,
    )

    detail = (out or res.get("stderr", "") or "").strip()
    low = detail.lower()

    # A JDK version / JVM launch failure is the classic cause of an empty
    # .ghidra_proj (Ghidra 11.2+ needs JDK 21). Flag it explicitly so it's not
    # mistaken for a bad path — the sandbox image must be rebuilt with JDK 21.
    java_markers = ("unsupportedclassversionerror", "class file version",
                    "requires java", "requires jdk", "supported by java runtime",
                    "failed to find a suitable", "no java", "java_home")
    if any(m in low for m in java_markers):
        return {"error": (
            "Ghidra could not start its Java runtime (JDK version mismatch — Ghidra 11.2+ requires "
            "JDK 21). Rebuild the sandbox image so it has JDK 21 (the Dockerfile now installs "
            "openjdk-21-jdk and pins JAVA_HOME); restart the app to trigger the rebuild.\n\n"
            f"Ghidra output (tail):\n{detail[-1500:]}"
        )}

    if res.get("error") and not detail:
        return res
    return {"error": (
        "Ghidra did not produce decompiler output. Likely causes: the binary path is wrong, the file "
        "isn't a valid ELF, analysis ran out of time/memory, or Ghidra's JVM failed to launch (needs "
        "JDK 21). Confirm the path with inspect_apk/list_directory and raise timeout_seconds; if this "
        "keeps happening the sandbox image likely needs rebuilding with JDK 21.\n\n"
        f"Ghidra output (tail):\n{detail[-1500:] or '(no output captured)'}"
    )}


# ---------------------------------------------------------------------------
# Raw byte reading / byte-level diffing
# ---------------------------------------------------------------------------

# Accept an offset as a plain decimal ('4660') or a 0x-prefixed hex ('0x1234'),
# optionally signed. Anything else is rejected before it reaches the shell.
_OFFSET_RE = re.compile(r"[+-]?(0x[0-9a-fA-F]+|[0-9]+)$")


@registry.register(
    name="read_binary_range",
    description=(
        "Reads a specific byte range of a binary and returns it as HEX — the read counterpart to "
        "patch_bytes_at_offset. Give a start file offset and a length; you get back both a contiguous hex "
        "string (bytes at offset .. offset+length-1) and an annotated xxd dump (offset | hex | ASCII) for easy "
        "reading. Safe on huge binaries because it only reads the requested slice. Use it to inspect the exact "
        "bytes at a known offset before/after patching, confirm an instruction's encoding, or peek at a header."
    ),
    params_schema={
        "file_path": "string (path to the binary, relative to /workspace)",
        "offset": "integer or hex string (start byte offset, e.g. 4660 or '0x1234')",
        "length": "integer (number of bytes to read, e.g. 16; capped at 65536)"
    },
    output="A '--- hex ---' line with the contiguous hex string of the requested bytes, then an '--- annotated ---' xxd dump (offset | hex | ASCII). Errors if the file is missing or the offset/length is invalid; notes if the length was capped.",
    when_to_use="Use this to see the raw bytes at a known FILE offset (e.g. to confirm what patch_bytes_at_offset/binary_patch is about to overwrite, or verify a patch afterwards). To disassemble that range instead of dumping bytes, use disassemble_range."
)
def read_binary_range(file_path, offset, length):
    file_path = normalize_path(file_path)
    try:
        length = int(length)
    except (TypeError, ValueError):
        return {"error": "length must be an integer number of bytes."}
    if length <= 0:
        return {"error": "length must be a positive integer."}
    max_len = 65536
    capped = length > max_len
    if capped:
        length = max_len
    off = str(offset).strip()
    if not _OFFSET_RE.match(off):
        return {"error": "offset must be a decimal number or a 0x-prefixed hex value, e.g. 4660 or '0x1234'."}

    cmd = (
        f"if [ ! -f /workspace/{file_path} ]; then "
        f"  echo 'ERROR: file not found: /workspace/{file_path}'; exit 1; "
        f"fi; "
        f"echo '--- hex ({length} bytes @ {off}) ---'; "
        f"xxd -s {off} -l {length} -p /workspace/{file_path} | tr -d '\\n'; echo; "
        f"echo '--- annotated (offset | hex | ASCII) ---'; "
        f"xxd -s {off} -l {length} /workspace/{file_path}"
    )
    res = run_cmd(cmd, timeout=60)
    if capped and res.get("stdout"):
        res["stdout"] += f"\n[length was capped to {max_len} bytes — call again with a later offset for more]"
    return res


# Byte-level diff runs inside the sandbox. Reads both files, walks the overlapping
# region, and reports the offsets that differ with each side's byte in hex. The
# paths/limit are substituted (not f-string-formatted) so the script body's braces
# survive untouched.
_BINDIFF_SCRIPT = r'''
import sys
pa = "/workspace/__A__"
pb = "/workspace/__B__"
max_diff = __MAX__
try:
    with open(pa, "rb") as f:
        a = f.read()
except OSError as e:
    print("ERROR: cannot open " + pa + ": " + str(e)); sys.exit(1)
try:
    with open(pb, "rb") as f:
        b = f.read()
except OSError as e:
    print("ERROR: cannot open " + pb + ": " + str(e)); sys.exit(1)
la, lb = len(a), len(b)
n = min(la, lb)
total = 0
shown = []
for i in range(n):
    if a[i] != b[i]:
        total += 1
        if len(shown) < max_diff:
            shown.append((i, a[i], b[i]))
print("file A: " + pa + " (" + str(la) + " bytes)")
print("file B: " + pb + " (" + str(lb) + " bytes)")
if la != lb:
    print("SIZE DIFFERS by " + str(abs(la - lb)) + " bytes; the extra bytes past offset " + hex(n) + " in the longer file are not listed below.")
if total == 0 and la == lb:
    print("IDENTICAL: the two files are byte-for-byte equal.")
    sys.exit(0)
print("differing bytes in the overlapping region: " + str(total) + (" (showing first " + str(max_diff) + ")" if total > max_diff else ""))
for off, av, bv in shown:
    print("offset=" + hex(off) + " (" + str(off) + ")  A=" + format(av, "02x") + "  B=" + format(bv, "02x"))
if total > max_diff:
    print("[truncated at " + str(max_diff) + " of " + str(total) + " differing bytes — raise max_diff for more]")
'''


@registry.register(
    name="diff_binary_files",
    description=(
        "Compares TWO binary files byte-for-byte and lists the offsets where they differ, with each side's byte "
        "shown in hex (A=.. B=..). This is how you see EXACTLY what a patch changed: diff the pre-patch backup "
        "against the patched .so and you get every changed offset. Also reports a size difference if the files "
        "aren't the same length. For a plain identical/different verdict use compare_files_sha256; to read the "
        "bytes around a reported offset use read_binary_range."
    ),
    params_schema={
        "file1": "string (path to the first/old file, relative to /workspace)",
        "file2": "string (path to the second/new file, relative to /workspace)",
        "max_diff": "integer (optional, max differing offsets to list, default 200)"
    },
    output="File sizes for both inputs, a size-difference note if they differ in length, then one line per differing offset ('offset=0x.. (dec)  A=xx  B=yy'), capped at max_diff. Says 'IDENTICAL' if the files are byte-for-byte equal.",
    when_to_use="Use this to see which bytes changed between two versions of a binary (e.g. original vs patched .so, or two build outputs). For a yes/no equality check use compare_files_sha256; for whole-directory differences use compare_directories."
)
def diff_binary_files(file1, file2, max_diff=200):
    file1 = normalize_path(file1)
    file2 = normalize_path(file2)
    try:
        max_diff = int(max_diff)
    except (TypeError, ValueError):
        max_diff = 200
    max_diff = max(1, min(max_diff, 5000))
    script = (_BINDIFF_SCRIPT
              .replace("__A__", file1)
              .replace("__B__", file2)
              .replace("__MAX__", str(max_diff)))
    b64 = base64.b64encode(script.encode("utf-8")).decode("ascii")
    cmd = f"echo '{b64}' | base64 -d | python3 -"
    return run_cmd(cmd, timeout=120)


# ---------------------------------------------------------------------------
# llvm-objdump: clean ARM64 disassembly + call analysis
# ---------------------------------------------------------------------------

@registry.register(
    name="llvm_objdump_disasm",
    summary="clean AArch64 disassembly, resolves <sym@plt> calls — preferred for reading arm64 over disassemble_range/radare2",
    description=(
        "Disassembles a binary with LLVM's llvm-objdump — the clean-output counterpart to disassemble_range "
        "(objdump) and radare2_cmd. On ARM64 (aarch64) .so files it produces tidy AArch64 assembly and resolves "
        "call targets to symbol names (e.g. 'bl 0x950 <dlopen@plt>') WITHOUT the relocation/analysis noise "
        "radare2 injects, and it disassembles aarch64 code the sandbox's x86_64 binutils objdump often can't "
        "annotate at all. Give an optional start_address/stop_address (hex or decimal virtual addresses) to "
        "disassemble just one function's range — strongly recommended on large libraries. Leave the range empty "
        "to dump from the start of .text (capped by max_lines). Use filter_pattern to grep the disassembly and "
        "skip/max_lines to paginate."
    ),
    params_schema={
        "binary_path": "string (path to the .so, relative to /workspace)",
        "start_address": "string (optional, hex '0x838' or decimal virtual address to start at)",
        "stop_address": "string (optional, hex or decimal virtual address to stop at)",
        "arch": "string (optional, force a disassembly arch, e.g. 'arm64'; default 'auto' lets llvm-objdump detect it from the ELF header)",
        "filter_pattern": "string (optional grep pattern applied to the disassembly)",
        "max_lines": "integer (optional, default 300)",
        "skip": "integer (optional, lines to skip for pagination, default 0)"
    },
    output="llvm-objdump disassembly lines (address: raw bytes  mnemonic operands, with <symbol@plt> annotations on call/branch targets), paginated with a next-skip hint. If llvm-objdump is missing, an error tells you to rebuild the image or use disassemble_range.",
    when_to_use="Use this for readable AArch64 disassembly and to see which imported symbols a stretch of code calls, especially when radare2_cmd output is too noisy or objdump won't annotate the arch. For a symbol->pseudocode view use ghidra_decompile; to just read raw bytes use read_binary_range."
)
def llvm_objdump_disasm(binary_path, start_address=None, stop_address=None, arch="auto", filter_pattern=None, max_lines=300, skip=0):
    binary_path = normalize_path(binary_path)

    range_flags = ""
    for label, val in (("--start-address", start_address), ("--stop-address", stop_address)):
        if val in (None, "", False):
            continue
        v = str(val).strip()
        if not _OFFSET_RE.match(v):
            return {"error": f"{label} must be a decimal number or a 0x-prefixed hex value, e.g. 0x838. Got: {v}"}
        range_flags += f"{label}={v} "

    arch_flag = ""
    a = (arch or "auto").strip().lower()
    if a not in ("", "auto"):
        # llvm-objdump accepts --arch=arm64 for AArch64; pass whatever the caller
        # forced. Only shell-safe arch tokens are allowed through.
        if not re.match(r"^[a-z0-9_\-]+$", a):
            return {"error": "arch must be a simple token like 'arm64', 'aarch64', 'x86-64', or 'auto'."}
        arch_flag = f"--arch={a} "

    base = f'"$LOBJ" -d {arch_flag}{range_flags}/workspace/{binary_path}'
    cmd = _LLVM_OBJDUMP_RESOLVE + build_paginated_command(
        base, filter_pattern=filter_pattern, max_lines=max_lines, skip=skip)
    res = run_cmd(cmd, timeout=120)
    return append_page_hint(res, skip, max_lines)


# Imports that terminate the process or tear down/attack the app — the calls an
# agent most wants flagged when hunting a native "kill switch"/anti-tamper trap.
_KILL_SWITCH_IMPORTS = {
    "exit", "_exit", "_Exit", "abort", "kill", "tgkill", "tkill", "pthread_kill",
    "raise", "__stack_chk_fail", "__assert_fail", "__assert2", "ptrace",
    "dlopen", "dlsym", "dlclose", "system", "fork", "vfork", "execve", "execl",
    "longjmp", "siglongjmp", "pthread_exit", "syscall",
}


def _lookup_func_symbol(symtab_text, name):
    """Find a defined FUNC symbol in `readelf -sW` output. Returns
    (vaddr:int, size:int, clean_name:str) for an exact name match if present,
    else the first substring match, else (None, None, None). Version suffixes
    ('foo@@VERS_1.0') are stripped before matching."""
    exact = None
    substr = None
    for line in symtab_text.splitlines():
        parts = line.split()
        # Num: Value Size Type Bind Vis Ndx Name
        if len(parts) < 8 or parts[3] != "FUNC":
            continue
        if parts[6] == "UND":  # imported/undefined — has no body in this file
            continue
        raw = parts[7]
        cname = raw.split("@")[0]
        try:
            vaddr = int(parts[1], 16)
        except ValueError:
            continue
        try:
            size = int(parts[2])
        except ValueError:
            try:
                size = int(parts[2], 16)
            except ValueError:
                size = 0
        if cname == name and exact is None:
            exact = (vaddr, size, cname)
        if name in cname and substr is None:
            substr = (vaddr, size, cname)
    if exact:
        return exact
    if substr:
        return substr
    return (None, None, None)


def _parse_plt_calls(disasm_text):
    """Extract calls to imported functions from llvm-objdump output. Each PLT
    call/branch is annotated '<name@plt>'; returns an ordered, de-duplicated
    list of (import_name, plt_target_address) plus a count of indirect (blr)
    calls whose targets can't be resolved statically."""
    calls = []
    seen = set()
    indirect = 0
    for line in disasm_text.splitlines():
        # Indirect calls through a register (blr xN) — real target not known here.
        if re.search(r"\bblr\b", line):
            indirect += 1
        if "@plt>" not in line:
            continue
        lt = line.rfind("<")
        gt = line.rfind(">")
        if lt == -1 or gt == -1 or gt < lt:
            continue
        annot = line[lt + 1:gt]
        name = annot[:-4] if annot.endswith("@plt") else annot
        pre = line[:lt].strip()
        target = pre.split()[-1] if pre else ""
        if name in seen:
            continue
        seen.add(name)
        calls.append((name, target))
    return calls, indirect


@registry.register(
    name="analyze_function_calls",
    description=(
        "Lists the imported/external functions a specific function calls — the fast way to spot which library "
        "call inside a routine is the one that matters (e.g. a native kill switch calling exit/abort/kill/"
        "pthread_kill, or a loader calling dlopen/dlsym) without hand-tracing every branch. It looks the function "
        "up in the ELF symbol table to get its address+size, disassembles exactly that range with llvm-objdump, "
        "and reports every '<name@plt>' call target it finds, with the PLT address. Process-terminating / "
        "anti-tamper imports are flagged separately, and unresolved indirect (blr) calls are counted."
    ),
    params_schema={
        "binary_path": "string (path to the .so, relative to /workspace)",
        "function_name": "string (exact symbol name, or a substring if the exact name isn't found — version suffixes like '@@VERS_1.0' are ignored)",
        "max_window": "integer (optional, bytes to disassemble when the symbol has no size recorded, default 1024)"
    },
    output="A header line with the resolved function name/address/size, then one line per imported function it calls ('name  @ 0xADDR'), a 'kill-switch/anti-tamper' line flagging any exit/abort/kill/dlopen-style imports, and a count of unresolved indirect (blr) calls. Errors if the function isn't a defined symbol (with a hint to list symbols).",
    when_to_use="Use this after locating a suspicious function (via rabin2_info/nm_symbols/ghidra_decompile) to see which specific import triggers behaviour you care about — e.g. which call in a check routine actually kills the process. For full disassembly use llvm_objdump_disasm; for pseudocode use ghidra_decompile."
)
def analyze_function_calls(binary_path, function_name, max_window=1024):
    binary_path = normalize_path(binary_path)
    fn = (function_name or "").strip()
    if not fn:
        return {"error": "function_name is required (exact symbol name or a substring of it)."}
    try:
        max_window = max(64, min(int(max_window), 65536))
    except (TypeError, ValueError):
        max_window = 1024

    res = run_cmd(f"readelf -sW /workspace/{binary_path} 2>/dev/null", timeout=60)
    symtab = res.get("stdout", "")
    if not symtab.strip():
        return {"error": f"Could not read a symbol table from {binary_path} (readelf produced no output). Confirm the path with list_directory and that it is an ELF .so."}

    vaddr, size, cname = _lookup_func_symbol(symtab, fn)
    if vaddr is None:
        return {"error": (
            f"'{fn}' is not a defined FUNC symbol in {binary_path}. Use rabin2_info with '-s' or nm_symbols to "
            "list symbols and copy the exact name. If the binary is stripped and the function has no symbol, "
            "disassemble a known address range with llvm_objdump_disasm and read the <...@plt> targets directly."
        )}

    if size and size > 0:
        stop = vaddr + size
        bounded = False
    else:
        stop = vaddr + max_window
        bounded = True

    cmd = _LLVM_OBJDUMP_RESOLVE + (
        f'"$LOBJ" -d --start-address={hex(vaddr)} --stop-address={hex(stop)} /workspace/{binary_path}'
    )
    d = run_cmd(cmd, timeout=90)
    disasm = d.get("stdout", "")
    if not disasm.strip():
        detail = (d.get("error") or d.get("stderr") or "").strip()
        return {"error": f"llvm-objdump produced no disassembly for {cname} @ {hex(vaddr)}. {detail}".strip()}

    calls, indirect = _parse_plt_calls(disasm)

    lines = [f"{cname} @ {hex(vaddr)}, size {size if size else '?'} byte(s)"
             + (f" (no size in symbol table — scanned first {max_window} bytes)" if bounded else "")]
    if calls:
        lines.append(f"Imported functions called ({len(calls)}):")
        for name, target in calls:
            lines.append(f"  {name}  @ {target}" if target else f"  {name}")
    else:
        lines.append("Imported functions called: none found (no <...@plt> call targets in range).")

    flagged = [name for name, _ in calls if name in _KILL_SWITCH_IMPORTS]
    if flagged:
        lines.append("Kill-switch / anti-tamper imports here: " + ", ".join(flagged))
    if indirect:
        lines.append(f"Indirect (blr) calls not statically resolvable: {indirect}")

    return {"stdout": "\n".join(lines)}


# Scans a file for a raw byte pattern. Paths/pattern/range come in via argv
# (shlex-quoted) so the script body has no braces to escape and no injection
# surface. Offsets are reported relative to the whole file.
_FIND_BYTES_SCRIPT = r'''
import sys
pat = bytes.fromhex(sys.argv[1])
fp = sys.argv[2]
start = int(sys.argv[3])
end_arg = sys.argv[4]
ctx = int(sys.argv[5])
maxm = int(sys.argv[6])
try:
    with open(fp, "rb") as f:
        data = f.read()
except OSError as e:
    print("ERROR: cannot open " + fp + ": " + str(e)); sys.exit(1)
n = len(data)
if start < 0:
    start = 0
if start > n:
    print("ERROR: start offset " + hex(start) + " is past end of file (" + str(n) + " bytes)."); sys.exit(1)
end = n if end_arg == "-" else int(end_arg)
if end > n:
    end = n
region = data[start:end]
offs = []
pos = 0
while True:
    i = region.find(pat, pos)
    if i < 0:
        break
    offs.append(start + i)
    pos = i + 1
scope = ""
if start != 0 or end != n:
    scope = " within [" + hex(start) + ", " + hex(end) + ")"
print("pattern " + pat.hex() + " (" + str(len(pat)) + " byte(s)) found " + str(len(offs)) + " time(s) in " + fp.split("/workspace/")[-1] + scope)
for off in offs[:maxm]:
    c0 = max(0, off - ctx)
    c1 = min(n, off + len(pat) + ctx)
    pre = data[c0:off].hex()
    mid = data[off:off + len(pat)].hex()
    post = data[off + len(pat):c1].hex()
    print("offset=" + hex(off) + " (" + str(off) + ")  " + pre + "[" + mid + "]" + post)
if len(offs) > maxm:
    print("[showing first " + str(maxm) + " of " + str(len(offs)) + " matches — narrow the range or raise max_matches]")
'''


@registry.register(
    name="find_byte_sequence_in_so",
    description=(
        "Scans a binary for a raw BYTE PATTERN (given as hex) and returns every file offset where it occurs, each "
        "with a few bytes of surrounding context. This is how you locate an instruction pattern or a data "
        "signature by content — e.g. find every AArch64 'RET' (hex c0035fd6, little-endian for d65f03c0) to spot "
        "function epilogues, a hash-check comparison sequence, or the hook trampoline bytes in a custom native "
        "library. Optionally restrict the search to a [start, end) offset range to cut noise on large files. "
        "The reported offsets are FILE offsets you can feed straight into patch_at_offset_with_bytes or "
        "read_binary_range."
    ),
    params_schema={
        "so_path": "string (path to the binary, relative to /workspace)",
        "pattern": "string (hex byte sequence to find, e.g. 'c0035fd6' or 'c0 03 5f d6'; whitespace/\\x ignored)",
        "start": "string (optional, start file offset — decimal or 0x-hex; default 0)",
        "end": "string (optional, end file offset exclusive — decimal or 0x-hex; default end of file)",
        "context": "integer (optional, bytes of context to show on each side of a match, default 8)",
        "max_matches": "integer (optional, max matches to list, default 50)"
    },
    output="A summary line (pattern, byte count, number of matches, optional range) then one line per match: 'offset=0x.. (dec)  <pre-hex>[<match-hex>]<post-hex>'. Truncated with a hint if there are more matches than max_matches.",
    when_to_use="Use this to find a known byte/instruction pattern by content — a specific opcode sequence (RET, a comparison, a branch), a hook signature, or a magic constant — when you need every offset it appears at. If you know an offset and want to read/patch there, use read_binary_range / patch_at_offset_with_bytes; to patch a unique sequence in place use binary_patch."
)
def find_byte_sequence_in_so(so_path, pattern, start=0, end=None, context=8, max_matches=50):
    so_path = normalize_path(so_path)
    try:
        pat_clean, pat_len = clean_hex(pattern)
    except ValueError as e:
        return {"error": f"pattern invalid: {e}"}
    if pat_len == 0:
        return {"error": "pattern must be a non-empty hex byte sequence."}

    def _parse_off(v, default):
        if v in (None, "", False):
            return default, None
        s = str(v).strip()
        try:
            return (int(s, 16) if s.lower().startswith("0x") else int(s)), None
        except ValueError:
            return None, f"offset '{v}' must be a decimal number or 0x-prefixed hex."

    start_i, err = _parse_off(start, 0)
    if err:
        return {"error": err}
    end_i, err = _parse_off(end, None)
    if err:
        return {"error": err}

    try:
        context = max(0, min(int(context), 256))
    except (TypeError, ValueError):
        context = 8
    try:
        max_matches = max(1, min(int(max_matches), 5000))
    except (TypeError, ValueError):
        max_matches = 50

    args = [
        pat_clean,
        f"/workspace/{so_path}",
        str(start_i),
        "-" if end_i is None else str(end_i),
        str(context),
        str(max_matches),
    ]
    b64 = base64.b64encode(_FIND_BYTES_SCRIPT.encode("utf-8")).decode("ascii")
    arg_str = " ".join(shlex.quote(a) for a in args)
    cmd = f"echo '{b64}' | base64 -d | python3 - {arg_str}"
    return run_cmd(cmd, timeout=120)
