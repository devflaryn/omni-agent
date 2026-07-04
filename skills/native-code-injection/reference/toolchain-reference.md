# Native Codegen Toolchain Reference

## Supported `arch` values and what backs them
| arch | Assembler | Compiler | Notes |
|---|---|---|---|
| `aarch64` | `aarch64-linux-gnu-as` | `aarch64-linux-gnu-gcc` | Modern 64-bit Android ABI (arm64-v8a) — try this first for most current devices |
| `arm` | `arm-linux-gnueabi-as` | `arm-linux-gnueabi-gcc` | 32-bit ARM (armeabi-v7a). Assembles in ARM mode by default — add a `.thumb` directive at the top of `assembly_code` if you need Thumb encoding |
| `x86_64` | host `as` | host `gcc` | 64-bit x86 (rare on real devices, common on emulators) |
| `x86` | host `as --32` | host `gcc -m32` | 32-bit x86 (emulators) |

`arch` is auto-detected from the target `.so` via `readelf -h` if you don't pass it explicitly — only override it if detection fails or you're targeting a raw blob without ELF headers.

## Calling conventions (only relevant to how parameters/return values map to registers — you never call OUT to anything, but you do receive parameters and produce a return value the caller expects in the right place)

### AArch64 (aarch64)
- Integer/pointer args: `x0`–`x7` (or `w0`–`w7` for 32-bit values)
- Return value: `x0`/`w0`
- `ret` returns to the address in `x30` (the link register)

### ARM32 (arm)
- Integer/pointer args: `r0`–`r3`
- Return value: `r0`
- `bx lr` returns to the address in `lr`

### x86_64 (System V ABI, used on Linux/Android)
- Integer/pointer args: `rdi`, `rsi`, `rdx`, `rcx`, `r8`, `r9`
- Return value: `rax`
- `ret` returns using the return address on the stack

### x86 (cdecl-ish, but JNI typically uses whatever the compiler emits — verify with `disassemble_range` on the original function before assuming)
- Args are commonly stack-passed; check the original function's prologue with `disassemble_range` to see how it actually reads its arguments before writing a replacement
- Return value: `eax`

## Compile flags used by `compile_c_and_patch` (for reference — you don't need to pass these yourself)
```
<gcc> -c -O2 -ffreestanding -fno-pic -fno-plt -fno-stack-protector -fomit-frame-pointer -nostdlib -o patch.o patch.c
```
- `-ffreestanding` — tells GCC not to assume a hosted environment (no libc semantics for things like `main`)
- `-fno-pic -fno-plt` — avoids position-independent-code indirection that would otherwise require relocations
- `-nostdlib` — don't try to link against libc (there's no link step anyway, but this avoids GCC inserting startup-file assumptions)
- `-fno-stack-protector` — avoids a call to `__stack_chk_fail`, which would be an unresolved external symbol

## Why relocations are checked
Both `assemble_and_patch` and `compile_c_and_patch` run `objdump -r` on the compiled object before extracting bytes. A relocation entry means the code references something (a function, a global, a far jump target) that a linker would normally resolve to a real address. Since there's no linker here, extracting bytes with an unresolved relocation would silently write a call/jump to address 0 (or whatever placeholder the assembler used) — this fails at RUNTIME, often as a crash deep in unrelated code, which is much harder to debug than a clear compile-time error. Both tools refuse and report the exact unresolved symbol instead.
