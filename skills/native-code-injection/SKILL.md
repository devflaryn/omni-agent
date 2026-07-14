---
name: native-code-injection
description: Write and inject genuinely new native logic (custom algorithms, multi-branch checks, arithmetic) into a .so library by assembling real assembly or compiling freestanding C — for cases the canned patches in native-patching can't cover.
when_to_use: Use this skill when a native check needs to be replaced with new custom behavior, not just NOPed or forced to return a constant — e.g. a function needs to do a different calculation, validate against new criteria, or implement logic that doesn't exist in the original binary at all.
allowed-tools: extract_strings, rabin2_info, disassemble_range, readelf_info, assemble_and_patch, compile_c_and_patch, find_code_cave, compare_files_sha256
---

# Native Code Injection Skill

`nop_function`, `patch_function_return`, `patch_bytes_at_offset`, and `binary_patch` (covered in `native-patching`) all write bytes that are either already known (a NOP) or trivially canned (return true/0/null). This skill is for when the new logic itself is non-trivial: a real comparison, a small loop, custom arithmetic — something you'd naturally write as code, not encode by hand.

## Step 0 — Try the simple path first
If `native-patching`'s canned patches (NOP / force-return-true / force-return-false) actually satisfy the goal, use those — they're simpler and have zero relocation risk. Reach for this skill only when the task genuinely needs new computed behavior.

## Step 1 — Understand the constraint before writing any code
There is no linker in this pipeline. Whatever you write — assembly or C — gets assembled/compiled and only its raw `.text` bytes are extracted; nothing resolves calls to other functions or references to global data. That means:
- NO calls to external functions — no libc (no `printf`, `malloc`, `strcmp`, nothing), no calls to other functions in the target binary either.
- NO global or static variables, NO string literals.
- Only the function's own parameters, local variables, registers, and immediate values.
Both `assemble_and_patch` and `compile_c_and_patch` will refuse to produce code with unresolved relocations and will tell you exactly which symbol triggered it — treat that error as "rewrite this without the external reference," not as a bug to route around.

## Step 2 — Locate and size the target
1. `rabin2_info` (`-s`/`-i`) or `nm_symbols` to find the function's symbol and address; `readelf_info` (`-S`, `-l`) to map virtual address to file offset if needed (same as `native-patching`).
2. `disassemble_range` across the function to see roughly how many bytes it currently occupies — this is your budget unless you use a code cave (Step 4).

## Step 3 — Write and assemble/compile
- Prefer `compile_c_and_patch` when the logic is naturally arithmetic/branching (a custom checksum, a bespoke validation formula, a small state machine) — C is far less error-prone than hand-written assembly for this.
- Use `assemble_and_patch` when you need precise control over instruction selection, or the target architecture makes the C constraints (no globals, no calls) awkward to satisfy for what you're doing.
- ALWAYS do a dry run first (omit `file_offset`) and pass `max_bytes` set to the original function's size so you get an explicit warning if your new code won't fit before you touch anything.

## Step 4 — If the new code doesn't fit
Custom logic is often bigger than the trivial function it replaces. Options, in order of preference:
1. Simplify the code until it fits the original function's byte budget.
2. `find_code_cave` to locate a run of filler bytes (commonly `0x00` padding between sections or at a section's end) big enough to hold the full new code, patch the real logic there, then patch a short jump/branch (a `b`/`bl` on ARM, `jmp`/`call` on x86) at the ORIGINAL function's entry point into the cave — write that jump with `assemble_and_patch` too, it's just a few bytes.
3. Confirm the cave's section is safe to overwrite (not live data, not another function) via `readelf_info -S` before using it.

## Step 5 — Verify
- Dry-run output already shows you the exact bytes about to be written — review them.
- After patching, `disassemble_range` the same address range to confirm the new instructions are what you expect.
- `compare_files_sha256` the pre-patch backup against the patched file to confirm a change actually happened.
- Rebuild/re-sign the APK per `apk-modding`, and treat any resulting signature mismatch with `signature-bypass`.

## Critical Rules
- Back up the `.so` (`duplicate_file`) before any patch, same as `native-patching`.
- Never try to "work around" a relocation error by guessing an address to hardcode — a hardcoded address will be wrong the moment the library is loaded at a different base (ASLR), and silently corrupts execution instead of failing loudly.
- If the logic genuinely needs to call an existing function in the binary (not just do local computation), that's beyond what this tool supports (no linker means no way to correctly encode that call's target) — fall back to modifying the CALLER's logic instead (e.g. via `patch_bytes_at_offset`/`nop_function` around the call site) rather than trying to make the callee call out.
- ARM64 instructions are 4-byte aligned; don't patch a partial instruction. x86/x86_64 instructions are variable-length — check the exact byte length of what you're overwriting with `disassemble_range` first.
