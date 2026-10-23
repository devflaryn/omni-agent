---
name: omnidroid-frida
description: Use when hooking, tracing, calling, patching or dumping native arm64 Android code (.so) with omnidroid's Frida-style lab over its MCP server — lab_load, call_function, intercept (record or replace_return), set_breakpoint/run_until_stop/resume, read_mem/write_mem, alloc_data, load_code, trace_syscalls, dump_module; and the RE workbench — lab_load_apk, lab_trace, lab_corpus, lab_diff, lab_build (rebuild a .so in C and prove it matches). Trigger on "frida", "hook/intercept this function", "call this native function", "patch the check", "dump the unpacked .so", "breakpoint in the lib", "reconstruct this .so", or any omnidroid_lab_* / lab debug tool. It runs one library in an isolated emulated address space, NOT attached to a running app (booting apps — omnidroid skill; old QEMU frida-server — omnidroid-qemu).
---

# omnidroid's Frida-style lab debugger

omnidroid's MCP server (`omni-mcp`) carries a debugger that sits **below** the guest code: the
library runs on omnidroid's own arm64 translator (dynarmic), so there is no `ptrace`, nothing the
library can detect, and the result is identical on Windows, Linux and macOS (the guest is always
arm64). It is the Frida toolkit re-done at the emulation layer — `Interceptor.attach` →
`intercept`, `Interceptor.replace` → `intercept replace_return` / `write_mem`,
`NativeFunction(...)()` → `call_function`, `Memory.read/write*` → `read_mem`/`write_mem`,
`Process.enumerateRanges` → `list_maps`, `Module.enumerateExports` → `list_symbols`.

**What it is not**: it does NOT attach to a live instance. `lab_load` puts ONE `.so` into a fresh,
empty address space with nothing else: no Android, no libc, no JVM, no game loop. You drive it by
calling its functions yourself.

Tool names: pi `omnidroid_<tool>`, Claude Code `mcp__omnidroid__<tool>`. Below they are written
bare. None present? See the omnidroid skill ("Reaching the tools").

**Where it runs**: the omnidroid app forwards lab calls, one at a time, to an `omni-mcp --lab`
process started at the first lab call. If that process dies it is started once more and **every
session and corpus is gone**: the next call answers `no lab session "default"; call
lab_load/lab_load_apk first`. Load again; never assume an earlier load survived an error.

**Sessions**: a lab holds named sessions. `lab_load` / `lab_load_apk` take `session` (default
`"default"`); loading replaces **that session only**. Every single-session tool below
(`list_symbols` ... `dump_module`) acts on `"default"` alone; only `lab_trace` and `lab_diff` take a
session name. So: probe in `"default"`, diff with `"original"` / `"candidate"`.

## The tools

| tool | args | returns / notes |
|---|---|---|
| `lab_load` | `path` (a `.so`), `name?` (default the file name), `session?` (accepted, not in the schema) | `{module, session, base, start, end, exported_symbols}`. Replaces that session: its modules, buffers, breakpoints, intercepts |
| `list_symbols` | `module?` (default the session's first), `limit?` (200) | `{module, symbols: [{name, address, kind (FUNC/OBJECT), size}]}` — exports only |
| `resolve_symbol` | `name` | `{name, address, size, kind, module}` — exported symbols only |
| `list_maps` | — | `{maps: [{start, end, perms, committed, what}]}` (`/proc/self/maps` shape) |
| `read_mem` | `address`, `len` (≤ 1 MiB) | `{address, len, hex}` |
| `write_mem` | `address`, `hex` | `{address, written}`; anywhere mapped, **including read-only code** (copy-on-write + translation cache invalidated) |
| `alloc_data` | `hex` or `len` | `{address, len}`: a fresh read-write buffer — how you hand a function its input |
| `load_code` | `words` (32-bit A64 encodings, numbers or hex strings) | `{address}`: a fresh executable snippet |
| `call_function` | `symbol` or `address`, `args?` (≤ 8 → X0..X7) | `{ret (X0), ret_u64, ret1 (X1), instructions, events}`. Runs to the return; breakpoints stepped over, intercepts fire |
| `set_breakpoint` | `symbol` or `address` | `{breakpoint}` — for `run_until_stop` / `resume` |
| `run_until_stop` | `symbol`/`address`, `args?` | `{stopped: "breakpoint", address, events}` or `{stopped: "returned", ret, instructions, events}` |
| `resume` | — | the same two shapes |
| `get_registers` | — | `{x: [x0..x30], sp, pc, nzcv, tpidr_el0}` (at a stop, or after the last call) |
| `backtrace` | — | `{frames: [return addresses]}` up the X29 chain |
| `intercept` | `symbol`/`address`, `record_entry?` (true), `record_exit?` (true), `replace_return?` (string) | `{intercept}`. Entry events carry X0..X7; with `replace_return` the body never runs and X0 is forced |
| `trace_syscalls` | `on?` (true) | `{trace_syscalls}`; every `SVC` in later calls becomes a `syscall` event (no kernel answers: the guest carries on) |
| `dump_module` | `name?` (default the session's first module), `out_path?` | `{module, bytes, out_path?}`: the image as it sits in memory `[start, end)` (headers, relocations applied, holes zero) |

Events: `{kind: enter|exit|syscall|replaced, address, regs: [hex...], syscall_nr}`.

**Numbers**: pass addresses and 64-bit values as strings, `"0x1a5369bc388"` or decimal; read
results from the hex strings (`ret`), not `ret_u64` (a JSON number loses precision above 2^53).
Addresses change on every `lab_load` — re-resolve, never reuse one from an earlier load.

## Rules learned by running it (2026-09-30, libz.so fixture)

1. **A breakpoint or intercept at the address a call STARTS at never fires.** The run begins by
   stepping over whatever is at its entry. So `intercept check_license` + `call_function
   check_license` does nothing (no event, body runs). Put the hook on a **callee** of the function
   you call, or on an address after the entry (`entry + 4`), or run a caller.
   - worked: `intercept adler32_z replace_return "0x1234"`, then `call_function adler32` →
     `ret 0x1234`, event `{kind: "replaced"}`
   - worked: `set_breakpoint adler32_z`, `run_until_stop adler32` → stopped at `adler32_z` with
     X0..X2 = the arguments; `resume` → returned
   - worked: `set_breakpoint <entry+4>`, `run_until_stop <entry>` → stopped
2. **Imports are not resolved.** Every call into libc/libm/liblog/another `.so` is bound to null,
   so a function that reaches one fails with `the guest did not return normally: the instruction
   at 0x0 faulted on a guest instruction fetch of 0x0`. The lab is for self-contained code:
   crypto, checksums, decoders, string/obfuscation routines, license and integrity checks,
   unpackers. When the target calls an import, `intercept` the internal function that calls it
   with `replace_return`, patch the call site with `write_mem`, or cut the routine out with
   `load_code`.
3. **Nothing runs on load.** `lab_load` maps and relocates; it does not run `.init_array`,
   `JNI_OnLoad` or any constructor. A packed library stays packed until you `call_function` its
   unpacker yourself; `dump_module` after that gives the unpacked image.
4. `call_function` has a budget of 200 M guest instructions; past it, "did not return".
5. `intercept` exit events can be missing when the hooked function is reached by a tail call
   (`b`, not `bl`): its return goes straight to the lab's sentinel.
6. There is no "clear" for breakpoints or intercepts: `lab_load` again to start clean.
7. Only integer/pointer arguments (X0..X7) and results (X0, X1). No floats, no stack arguments.
8. In pi, a call past `omniMcp.timeoutSec` (600 s) is **not** killed: pi answers "has run Ns
   without returning ... still alive" and posts the late result as a follow-up. Lab calls are
   serialized, so the next lab call waits behind the slow one.

## Recipes

**Get the `.so` out of an APK** (an APK is a zip; only `lib/arm64-v8a` is arm64):

```bash
unzip -o app.apk 'lib/arm64-v8a/*' -d /tmp/apk            # or: tar -xf app.apk lib/arm64-v8a  (Windows/macOS bsdtar)
python -c "import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2], [n for n in zipfile.ZipFile(sys.argv[1]).namelist() if n.startswith('lib/arm64-v8a/')])" app.apk out
```

**Call a function with a crafted buffer** (`adler32(1, buf, len)`):

```jsonc
lab_load      {"path": "C:/…/libz.so"}
alloc_data    {"hex": "48656c6c6f"}                          // "Hello" → {"address": "0x…d2000"}
call_function {"symbol": "adler32", "args": ["1", "0x…d2000", "5"]}   // → {"ret": "0x58c01f5", …}
```

A function that writes into an output buffer: `alloc_data {"len": 64}`, pass its address, then
`read_mem` it after the call. A function that returns a pointer: `read_mem` at `ret`
(`zlibVersion` → `ret` → `read_mem` → `312e332e30…` = "1.3.0…").

**Force a check's answer** — hook a callee:

```jsonc
intercept     {"symbol": "verify_signature", "replace_return": "0x1"}   // a function check_license calls
call_function {"symbol": "check_license", "args": ["0x…"]}              // events: [{"kind":"replaced",…}]
```

**Patch code in place** — `mov x0, #1 ; ret` is `200080d2 c0035fd6` (little-endian bytes):

```jsonc
resolve_symbol {"name": "crc32"}
write_mem      {"address": "0x…d2e8", "hex": "200080d2c0035fd6"}
call_function  {"symbol": "crc32", "args": ["0", "0", "0"]}   // → {"ret": "0x1", "instructions": 3}
```

**Run a hand-written snippet** (it needs a lab, so `lab_load` any library first; the snippet does
not have to touch it):

```jsonc
load_code     {"words": ["0xd2800020", "0xd65f03c0"]}    // mov x0,#1 ; ret
call_function {"address": "<the returned address>"}       // → ret 0x1
```

**Step through**: `set_breakpoint` on a callee or an inner address → `run_until_stop` →
`get_registers` / `backtrace` / `read_mem` at the stop → `resume` (repeat) until `returned`.

**Trace what it asks the kernel for**: `trace_syscalls {}` then `call_function`; each `SVC` is an
event `{kind: "syscall", syscall_nr, regs}` (arm64 numbers: 56 openat, 63 read, 64 write, 222
mmap, 172 getpid …). No kernel answers, so results after the first syscall are not meaningful.

**Dump**: `dump_module {"out_path": "C:/…/lib.dumped.so"}` — after running the unpacker if the
library is packed.

## A live app's native code

There is no frida-server for an app running on omnidroid's real-AOSP path: the guest kernel has no
`ptrace`, so nothing attaches to or injects into a live process. To hook what a running app runs,
take its library into the lab: the warm device's installed APKs are host files
(`<device dir>/data/app/*/<package>-*/base.apk`; `list_devices` gives each Android's `dir`, `shell
{command: "pm path <package>"}` the guest path), so unzip `lib/arm64-v8a/<lib>.so` from there and
`lab_load` it. Watch the live app itself through the omnidroid skill: its log in the device's host log file,
`shell` (dumpsys, its files as root) and `screenshot`. (The retired QEMU manager had a real frida-server: omnidroid-qemu.)

## The dynamic RE workbench

Reverse-engineer a `.so` and prove a **rebuilt** one behaves the same (`crates/omni-mcp/README.md`):

| tool | args | returns / notes |
|---|---|---|
| `lab_load_apk` | `apk` (an `.apk`, or a bare `.so`), `target?` (the `.so` file name; **required** for an APK), `session?` | `{session, target, modules, unresolved: [{name, kind, weak, library}]}`. Extracts every `lib/arm64-v8a/*.so`, co-loads the siblings first (one that fails to load is skipped silently) so the target's imports resolve against them; what stays `unresolved` you stub with `intercept`. Errors: `the APK has no lib/arm64-v8a/*.so`, `"x.so" is not in the APK's arm64 libs` |
| `lab_trace` | `symbol` or `address`, `arg_spec?`, `session?` | `{ret, ret_u64, ret1, instructions, out_buffers: [{index, hex}]}` — no `events`. `arg_spec` items: `{scalar: n}`, `{in_buffer: "hex"}`, `{out_buffer: len}`, `{inout_buffer: "hex"}`; buffers are allocated and their addresses passed in register order; out/inout buffers are read back. A zero-length out/inout buffer is refused |
| `lab_corpus` | `templates` (required), `seed?` (0), `count?` (16) | `{corpus_id: "corpus-N", count}`. Templates: `{kind: "scalar"}` (first inputs 0, 1, 2^64-1, then random), `{kind: "buffer", len}` (random input bytes), `{kind: "out_buffer", len}`, `{kind: "const", value}`. Same seed, same corpus |
| `lab_diff` | `symbol`, `corpus_id` (required), `original?` (`"original"`), `candidate?` (`"candidate"`) | `{total, matched, first_divergence: null or {index, observable, expected, got}}`; observable `ret` / `out_buffers` / `fault` / `symbol` (it does not resolve in one of them). Compares X0 and output buffers, **not X1**. An input on which **both** fault counts as matched |
| `lab_build` | `sources: [{name, text}]` (required), `flags?` (clang flags), `soname?` (`candidate.so`) | `{so_path, target}`, or, as a normal result rather than an error, `{error: "toolchain missing", looked_for}` (no arm64 clang: set `OMNI_NDK` / `ANDROID_NDK_HOME`, or put a `clang` with an `aarch64` target on `PATH`) or `{error: "compile", diagnostics}`. Check for `error` before using `so_path` |

The loop: `lab_load_apk {apk, target, session: "original"}` → write C → `lab_build` →
`lab_load {path: so_path, session: "candidate"}` → `lab_corpus` → `lab_diff {symbol, corpus_id}` →
fix the first divergence, repeat. **Equivalence is relative to the corpus**, never universal; and
since both-fault inputs match, `matched == total` where the original faults everywhere proves
nothing: `lab_trace` a few corpus-like inputs on `"original"` first and see real `ret`s. To use
the single-session tools on the original too (intercept, read_mem...), also load it into
`"default"`.

`lab_trace`'s schema types `address` as a number (the other tools: a string). Prefer `symbol`;
otherwise a number or a hex/decimal string both work (pi converts `"0x..."`).

A self-decrypting/packed `.so`: `call_function` (or `lab_trace`) its unpacker, then `dump_module`.
Functions that need real libc/JNI/global state do not run in isolation yet: resolve what you can,
`intercept` the rest, reconstruct the parts that do run.

## Reporting

Quote the tool's own result (`ret`, the `events`, the hex) with the inputs you passed. A value
you did not read back is not a result. When a call fails, the error text says why (a fault
address, "did not return", "no lab session") — report it, don't retry blindly.

## Scope

For analysing, dumping and interoperating with binaries the owner controls. Not for evading
Roblox's server-side detection, bypassing its security, or affecting other players.
