"""Tool policy — the single, neutral source of truth for *what a tool does to the
world*, independent of how it's disclosed (tool_registry.py) or who calls it
(agent.py, subagents.py, plugins.py).

Two orthogonal classifications live here:

  * MUTATING_TOOLS / VALIDATION_TOOLS — used by the main loop's validation gate
    and by the planning gate. A MUTATING call changes the workspace (source/binary
    edit, write, move, delete) and marks an UNVERIFIED change; a VALIDATION call
    (build/sign/install/launch/test/log) objectively checks a prior change.

  * READONLY_TOOLS — an ALLOWLIST of pure-inspection tools that are safe to hand
    to an isolated, possibly-parallel subagent: they read/search/disassemble but
    never write a source file, execute an arbitrary command, drive the emulator,
    hit the network, or recurse into another subagent. This is an allowlist (not
    "everything not mutating") on purpose — `run_command`, `adb_shell`,
    `radare2_cmd`, `decode_apk`, `download_file`, `ask_codebase` and the like are
    NOT read-only in the sense a background research agent needs.

Kept import-light (only a lazy `tool_registry` peek) so every layer can import it
without a circular dependency — the same discipline planning.py / skills_loader.py
follow.
"""

# --- Workspace mutation classification (moved here from agent.py) -------------
# Tools that MUTATE the workspace (source/binary edits, writes, moves, deletes).
# A successful call marks an UNVERIFIED change until a validation tool (or a
# recorded passing test) objectively checks it. The main loop's validation gate
# and the planning gate both key off this set.
MUTATING_TOOLS = {
    "write_file", "replace_in_file", "move_file", "delete_path",
    "patch_smali_method", "insert_smali_code",
    "patch_at_offset_with_bytes", "patch_bytes_at_offset", "patch_binary_string",
    "binary_patch", "nop_function", "patch_function_return",
    "assemble_and_patch", "compile_c_and_patch", "assemble_dex",
    "replace_file_in_apk",
}

# Tools whose success is an OBJECTIVE validation of a prior change (build/package/
# sign/install/launch/test/log/inspect). Their success — or a record_test_result —
# clears the unverified-change flag.
VALIDATION_TOOLS = {
    "recompile_apk", "sign_apk", "verify_apk",
    "install_apk_on_emulator", "launch_app_on_emulator", "run_apk_test_session",
    "get_logcat", "monitor_logcat", "generate_test_report", "record_test_result",
    "run_command", "adb_shell",
}

# --- Read-only inspection allowlist (for isolated subagents) ------------------
# Pure-inspection tools, verified against the live registry (112 tools as of
# 2026-07). Grouped by concern for readability; the set is what matters. Anything
# that writes a source/binary file, decodes/decompiles INTO the workspace,
# executes a shell/emulator/frida command, downloads over the network, or spawns
# another isolated agent is deliberately excluded.
READONLY_TOOLS = {
    # filesystem / text search (read)
    "read_file_chunk", "tail_file", "list_directory", "find_files",
    "grep_file", "grep_directory",
    # code knowledge graph (query + build-a-cache; never edits sources)
    "query_code_graph", "list_code_graphs", "build_code_graph", "diff_code_graphs",
    # code search over already-decoded/decompiled trees
    "search_java", "search_smali",
    # apk inspection (no decode/repack/sign)
    "inspect_apk", "extract_manifest_info", "get_apk_signature_hash",
    # native .so inspection (no patching / no radare2_cmd write)
    "analyze_function_calls", "disassemble_range", "extract_strings",
    "ghidra_decompile", "llvm_objdump_disasm", "nm_symbols", "rabin2_info",
    "readelf_info", "read_binary_range", "find_byte_sequence_in_so",
    "find_code_cave", "diff_binary_files",
    # dex inspection (no assemble / no smali patching)
    "disassemble_dex", "list_dex_classes",
    # hashing / comparison
    "compute_sha256", "compare_files_sha256", "compare_directories",
    # durable memory (read) + skills + tool meta
    "investigation_view", "plan_view", "list_skills", "use_skill",
    "read_skill_resource", "expand_tools",
}

# Read-only tools that reach OUTSIDE the workspace (network) or observe a running
# emulator/frida — safe to READ but off by default for a background research
# agent. An AgentDef opts into them by declaring the matching toolset (web /
# emulator / frida); they're never in the default read surface.
READONLY_OPTIN_TOOLS = {
    "read_webpage", "web_search",                       # web
    "take_emulator_screenshot", "get_logcat", "read_auto_screenshots",
    "analyze_image", "analyze_keyframes", "list_roblox_accounts",  # emulator (observe)
    "frida_list_processes",                              # frida (observe)
}


# Tools that spawn a nested isolated session / subagent wave. They are stripped
# from EVERY subagent's tool surface so delegation can't recurse (a subagent may
# not dispatch more subagents, ask_codebase, or run a review — that stays the
# orchestrator's job and keeps depth and cost bounded).
SUBAGENT_EXCLUDED = {"dispatch_agents", "ask_codebase", "review_conclusion",
                     "strategy_set", "strategy_update"}


def is_mutating_tool(name):
    """True iff a successful call to `name` changes the workspace (needs validation)."""
    return name in MUTATING_TOOLS


def is_readonly_tool(name, allow_optin=False):
    """True iff `name` is a pure-inspection tool safe for an isolated subagent.
    Allowlist semantics — an unknown/typo'd name is treated as NOT read-only.
    With allow_optin=True, the network/emulator/frida observation tools count too."""
    if name in READONLY_TOOLS:
        return True
    return allow_optin and name in READONLY_OPTIN_TOOLS
