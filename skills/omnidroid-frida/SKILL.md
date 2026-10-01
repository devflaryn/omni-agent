---
name: omnidroid-frida
description: Use when hooking, tracing, calling, patching or dumping native arm64 Android code (.so) with omnidroid's Frida-style lab debugger over its MCP server — lab_load a library, call_function with crafted inputs, intercept (record or replace_return), set_breakpoint/run_until_stop/resume, read_mem/write_mem, load_code, trace_syscalls, dump_module. Trigger on "frida", "hook this function", "intercept", "call this native function", "what does this .so return for X", "patch the check", "dump the decrypted/unpacked .so", "breakpoint in the lib", or any omnidroid_lab_* / mcp__omnidroid__* debug tool. It runs one library in an isolated emulated arm64 address space; it does NOT attach to a running game (for booting the game use the omnidroid skill; for the old QEMU frida-server use omnidroid-qemu).
---

# omnidroid's Frida-style lab debugger

omnidroid's MCP server (`omni-mcp`) carries a debugger that sits **below** the guest code: the
library runs on omnidroid's own arm64 translator (dynarmic), so there is no `ptrace`, nothing the
library can detect, and the result is identical on Windows, Linux and macOS (the guest is always
arm64). It is the Frida toolkit re-done at the emulation layer — `Interceptor.attach` →
`intercept`, `Interceptor.replace` → `intercept replace_return` / `write_mem`,
`NativeFunction(...)()` → `call_function`, `Memory.read/write*` → `read_mem`/`write_mem`,
`Process.enumerateRanges` → `list_maps`, `Module.enumerateExports` → `list_symbols`.

**What it is not**: it is not attached to a live instance. `lab_load` puts ONE `.so` into a fresh,
empty address space with nothing else: no Android, no libc, no JVM, no game loop. You drive it by
calling its functions yourself.

Tool names: pi `omnidroid_<tool>`, Claude Code `mcp__omnidroid__<tool>`. Below they are written
bare. None present? See the omnidroid skill ("The MCP tools").

## The tools

| tool | args | returns / notes |
|---|---|---|
| `lab_load` | `path`, `name?` | `{module, base, start, end, exported_symbols}`. **Replaces the whole lab** — every earlier module, buffer, breakpoint and intercept is gone. One library per lab |
| `list_symbols` | `module?`, `limit?` (200) | exports: `name`, `address`, `kind` (`FUNC`/`OBJECT`), `size` |
| `resolve_symbol` | `name` | `{address, size, kind, module}` — exported symbols only |
| `list_maps` | — | `/proc/self/maps`-shaped rows: `start`, `end`, `perms`, `committed`, `what` |
| `read_mem` | `address`, `len` (≤ 1 MiB) | `{hex}` |
| `write_mem` | `address`, `hex` | writes anywhere mapped, **including read-only code** (copy-on-write + the translation cache invalidated) |
| `alloc_data` | `hex` or `len` | a fresh read-write buffer: `{address}` — how you hand a function its input |
| `load_code` | `words` (32-bit A64 encodings) | a fresh executable snippet: `{address}` |
| `call_function` | `symbol` or `address`, `args?` (≤ 8 → X0..X7) | `{ret (X0), ret1 (X1), instructions, events}`. Runs to the return; breakpoints are stepped over, intercepts fire |
| `set_breakpoint` | `symbol` or `address` | for `run_until_stop` / `resume` |
| `run_until_stop` | `symbol`/`address`, `args?` | `{stopped: "breakpoint", address}` or `{stopped: "returned", ret}` |
| `resume` | — | continue from a breakpoint stop |
| `get_registers` | — | `x[0..30]`, `sp`, `pc`, `nzcv`, `tpidr_el0` (at a stop, or after the last call) |
| `backtrace` | — | return addresses up the X29 frame chain |
| `intercept` | `symbol`/`address`, `record_entry?`, `record_exit?`, `replace_return?` | entry events carry X0..X7; with `replace_return` the body never runs and X0 is forced |
| `trace_syscalls` | `on?` | record every `SVC` in the next calls as `syscall` events (there is no kernel: the guest just carries on) |
| `dump_module` | `name?`, `out_path?` | the module's bytes as they sit in memory `[start, end)` (headers, relocations applied, holes zero) |

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
8. In pi, a call that exceeds `omniMcp.timeoutSec` (600 s) restarts omni-mcp — the lab is gone,
   `lab_load` again.

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
(`<device dir>/data/app/*/<package>-*/base.apk`; `device_status` gives the device dir, or `shell
{command: "pm path <package>"}` the guest path), so unzip `lib/arm64-v8a/<lib>.so` from there and
`lab_load` it. Watch the live app itself through the omnidroid skill: its log in the device's host log file,
`shell` (dumpsys, its files as root) and `screenshot`. (The retired QEMU manager had a real frida-server: omnidroid-qemu.)

## The dynamic RE workbench

To reverse-engineer a `.so` and prove a **rebuilt** one behaves the same, the MCP server carries a
loop on top of the lab (see `crates/omni-mcp/README.md` in the omnidroid repo):

- `lab_load_apk {apk, target?, session?}` — load a target `.so` (from an APK, or a bare `.so`) into a
  named session, resolving imports against its co-loaded `lib/arm64-v8a` siblings; returns the
  loaded modules and every import still **unresolved** (stub those with `intercept`). For an APK,
  `target` names the `.so` to reconstruct.
- `lab_trace {symbol|address, arg_spec, session?}` — call via an **arg_spec**
  (`{scalar}` / `{in_buffer:hex}` / `{out_buffer:len}` / `{inout_buffer:hex}`): buffers are
  allocated and output buffers read back. Returns `ret`, `ret1`, instruction count, out-buffer bytes.
- `lab_corpus {templates, seed?, count?}` — a **reproducible** input corpus (`{kind:scalar}` /
  `{kind:buffer,len}` / `{kind:out_buffer,len}` / `{kind:const,value}`), stored by `corpus_id`;
  the same `seed` reproduces it.
- `lab_diff {symbol, corpus_id, original?, candidate?}` — differential-test the `original` session
  against the `candidate` over the corpus; returns `total`, `matched`, and the first divergence
  (`ret` / `out_buffers` / `fault`). **Equivalence is relative to the corpus**, never universal.
- `lab_build {sources:[{name,text}], flags?, soname?}` — compile candidate C into an arm64 `.so` the
  lab can load. Needs an arm64 clang on the host (`OMNI_NDK` / `ANDROID_NDK_HOME`, or a `clang` on
  `PATH` with an `aarch64` target); without one it returns `{error:"toolchain missing", looked_for}`
  rather than a wrong-arch artifact.

Set `session` to `"original"` / `"candidate"` on the loads so `lab_diff` has two sessions to compare.
A self-decrypting/packed `.so` is handled the lab way: `call_function` (or `lab_trace`) its unpacker,
then `dump_module` the now-decrypted image. Functions that need real libc/JNI/global state do not run
in isolation yet — resolve what you can, `intercept` the rest, and reconstruct the parts that do run.

## Reporting

Quote the tool's own result (`ret`, the `events`, the hex) with the inputs you passed. A value
you did not read back is not a result. When a call fails, the error text says why (a fault
address, "did not return", "no lab session") — report it, don't retry blindly.

## Scope

For analysing, dumping and interoperating with binaries the owner controls. Not for evading
Roblox's server-side detection, bypassing its security, or affecting other players.
