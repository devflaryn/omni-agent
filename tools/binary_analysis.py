"""Native binary analysis tools.

Fast, targeted inspection of ELF binaries (.so libraries) without forcing a
full-binary analysis that would hang on 100MB+ stripped shared libraries.
Includes: objdump, radare2, readelf, rabin2, nm, strings, targeted
disassembly, Ghidra headless decompilation, and a directory mapper.

Reorganized out of the original ``reverse_engineering.py`` so all binary
inspection tooling lives in one focused, readable module.
"""

from tool_registry import registry
from tools.common import normalize_path, build_paginated_command, append_page_hint
from docker_sandbox import run_cmd


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
    name="analyze_so_symbols",
    description="Extracts exported functions and symbols from a native .so library using objdump. Prefer rabin2_info for faster results on large files.",
    params_schema={"so_filename": "string"},
    output="objdump -T output: a table of exported symbols with their address, section flags, section name, and symbol name.",
    when_to_use="Use this to see all exported (dynamic) symbols of a .so. For large binaries, rabin2_info with '-s' is faster and paginated."
)
def analyze_so_symbols(so_filename):
    so_filename = normalize_path(so_filename)
    cmd = f"objdump -T /workspace/{so_filename}"
    return run_cmd(cmd, timeout=120)


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
