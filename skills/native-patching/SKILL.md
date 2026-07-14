---
name: native-patching
description: Targeted patching of native .so libraries — find a function, disassemble it, patch bytes, verify.
when_to_use: Use this skill when the user needs to patch, NOP out, or modify behavior inside a native shared library (.so file) within an APK or standalone.
allowed-tools: extract_strings, rabin2_info, nm_symbols, disassemble_range, ghidra_decompile, nop_function, patch_function_return, patch_binary_string, patch_bytes_at_offset, binary_patch, compare_files_sha256
---

# Native Library Patching Skill

This skill guides you through locating and patching functions inside native .so libraries.

## Step 1 — Identify the target library
1. `inspect_apk` with filter `.so` to list all native libraries and their ABIs.
2. Pick the right ABI (usually arm64-v8a for modern devices). If multiple exist, you may need to patch all of them.

## Step 2 — Find the target function
1. `extract_strings` with a filter_pattern to find relevant strings (function names, log tags, error messages, URLs) that hint at the target code.
2. `rabin2_info` with mode `-s` to list exported symbols, or `-i` for imports (if stripped). Use filter_pattern to narrow down.
3. `nm_symbols` as an alternative for non-stripped binaries.
4. Note the function's ADDRESS (not just the name).

## Step 3 — Understand the function
1. `disassemble_range` with the function's start and end addresses to read its assembly.
2. If the disassembly is hard to follow, `ghidra_decompile` on the exact symbol name gives C-like pseudocode instead of raw assembly — much easier to reason about branch conditions. First run on a binary is slow (2-5 min) as Ghidra builds its analysis database; later calls are fast.
3. Look for: conditional branches (CBZ/CBNZ/B.cond on ARM64), comparison instructions, calls to verification functions.
4. Identify the bytes you need to change. Common opcodes (NOP, force-return-true/false, etc.) are in `reference/arm64-opcodes.md` — load it once you know which pattern you need.

## Step 4 — Apply the patch
Prefer the highest-level tool that does what you need — each one below finds the symbol's address and picks the correct architecture-specific bytes FOR you, so you don't need to hand-encode opcodes at all:
1. **Disable a function whose return value doesn't matter** (logging, telemetry, a flag-setter): `nop_function(so_path, function_name)`.
2. **Force a check to always pass/fail** (license check, root/debug detection, tamper check): `patch_function_return(so_path, function_name, return_value="true"|"false"|"zero"|"null")`.
3. **Change a hardcoded string** (URL, error message, feature flag) — same length or shorter only: `patch_binary_string(so_path, old_string, new_string)`.
4. **Anything more specific than the above** (an exact byte sequence you worked out yourself, or a partial-function patch): `patch_bytes_at_offset` when you have the file offset and the new hex bytes (it writes then reads back to verify), or `binary_patch` when you prefer to locate the exact byte SEQUENCE to find-and-replace (it disambiguates multiple matches). `reference/arm64-opcodes.md` has the raw hex for common patterns if you're doing this by hand.
5. **The new logic needs to actually compute something** (not just NOP/return-a-constant/swap-a-string) — switch to the `native-code-injection` skill, which assembles real assembly or compiles freestanding C into correct machine code instead of you hand-encoding it.

Always `duplicate_file` the .so to a backup path BEFORE any of the above.

## Step 5 — Verify
1. `disassemble_range` the same address range again to confirm the disassembly changed as expected.
2. `compare_files_sha256` the original backup vs the patched file to confirm they differ.

## Critical Rules
- ALWAYS back up the .so before patching (duplicate_file).
- File offset != virtual address. `nop_function`/`patch_function_return`/`patch_binary_string` resolve this for you from a symbol name; for the lower-level tools, check `readelf_info` (`-S`) to map virtual addresses to file offsets yourself.
- After patching a .so inside an APK, you must repack and re-sign the APK (see the `apk-modding` skill).
- Load `reference/arm64-opcodes.md` for the exact hex bytes of common patches (NOP, force-return-true, force-return-false) only when you need to hand-craft bytes yourself — for the common cases, `nop_function`/`patch_function_return` already do this correctly for whichever architecture the binary actually is.
