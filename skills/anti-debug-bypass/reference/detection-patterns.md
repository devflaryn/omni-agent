# Anti-Debug / Anti-Frida / Root / Emulator — Detection Pattern Reference

## Debugger detection (smali — search_smali / string_refs)
- `isDebuggerConnected`
- `Debug.waitingForDebugger`
- `Ldalvik/system/VMDebug;`
- `android.os.Debug`
- `ro.debuggable`
- `FLAG_DEBUGGABLE`

## Frida / instrumentation-framework detection (smali + native)
- `frida` (smali strings and native `extract_strings`)
- `gum-js-loop` / `gmain` (Frida's internal thread names)
- `re.frida.server`
- `frida-server`
- `LOCAL_SOCKET` scanning for `27042` / `27043` (Frida's default ports) — search smali/native for the literal port numbers
- `linjector` (a common Frida-adjacent injector name)
- native: `rabin2_info -i` filtered on `ptrace` (Frida attaches via ptrace on many builds)

## Root detection (smali)
- `Superuser`
- `RootBeer`
- `/system/bin/su`
- `/system/xbin/su`
- `test-keys` (in `Build.TAGS`)
- `Magisk`
- `isRooted` / `checkRoot` / `detectRoot`

## Emulator detection (smali)
- `Build.FINGERPRINT` combined with `generic` / `unknown` / `emulator`
- `Build.MODEL` combined with `google_sdk` / `Emulator` / `Android SDK`
- `Build.MANUFACTURER` combined with `Genymotion`
- `isEmulator`

## Native anti-debug (extract_strings / rabin2_info filters on .so files)
- `ptrace` — classic Linux anti-debug: a process ptraces itself so a second debugger attach fails; find the call to `ptrace(PTRACE_TRACEME, ...)` with `rabin2_info -i` then `disassemble_range` around the call site
- `TracerPid` — checks `/proc/self/status` for a nonzero TracerPid; search strings for `TracerPid` and `/proc/self/status`
- `gum-js-loop`, `frida`, `re.frida`
- `xposed`, `substrate` (other instrumentation frameworks apps sometimes also block)

## What runs after detection (search these directly, then walk backward to the guarding condition)
- `Ljava/lang/System;->exit(I)V`
- `Landroid/os/Process;->killProcess(I)V`
- `Ljava/lang/Runtime;->exit(I)V`
- A `throw` of a custom `SecurityException`/similar

## Patch template for a boolean detector method
```
.method public isRooted()Z
    .locals 1
    const/4 v0, 0x0
    return v0
.end method
```
Adjust the method name/signature to match exactly what you found — parameter and return types must match the original declaration.
