# ARM64 / x86 Common Patch Opcodes

Use these as the `new_hex_bytes` argument to `disassemble_patch_function` or `hex_patch_file`. Always confirm the instruction width at the target offset with `disassemble_range` first — overwriting only part of a wider instruction will corrupt the one after it.

## ARM64 (4 bytes per instruction)
| Purpose | Hex bytes | Meaning |
|---|---|---|
| NOP | `d503201f` | No-op, replaces any single instruction |
| Force return true (boolean/int 1) | `52800020` + `d65f03c0` | `MOV W0, #1` then `RET` |
| Force return false (boolean/int 0) | `2a1f03e0` + `d65f03c0` | `MOV W0, #0` (via `AND` trick) then `RET` — or simpler: `d2800000` (`MOV X0, #0`) + `d65f03c0` |
| Force return 0 (simplest form) | `d2800000` + `d65f03c0` | `MOV X0, #0` then `RET` |
| Unconditional branch (skip N bytes) | Use `B` with the correct offset — compute per-target, don't reuse a hardcoded value | — |
| Skip a conditional branch (CBZ/CBNZ/B.cond) | NOP it out (`d503201f`) so execution always falls through | — |

## x86 / x86_64 (variable length — check instruction size before patching)
| Purpose | Hex bytes | Meaning |
|---|---|---|
| NOP (1 byte) | `90` | Single-byte no-op; pad with multiple `90`s to cover a whole instruction |
| Force return true (eax=1) | `b801000000` + `c3` | `MOV EAX, 1` then `RET` |
| Force return false (eax=0) | `31c0` + `c3` | `XOR EAX, EAX` (zeroes eax) then `RET` |
| Jump always (short jmp) | `eb` + 1-byte relative offset | `JMP rel8` — compute the offset for the target |

## Notes
- ARM64 instructions are always 4 bytes aligned to 4-byte boundaries — never patch a partial instruction.
- x86/x86_64 instructions are variable length — always check with `disassemble_range` how many bytes the instruction you're replacing actually occupies, and pad with NOPs (`90`) if your replacement is shorter.
- After patching a function to always "return true"/"return false", also check whether the caller does anything with side effects (e.g. throws before returning) — a full function replacement via `disassemble_patch_function` covering the whole function body is safer than patching a single branch in ambiguous cases.
