---
name: anti-debug-bypass
description: Detect and neutralize anti-debugger, anti-Frida, root-detection, and emulator-detection checks in an Android APK, in both smali and native code.
when_to_use: Use this skill when the user reports an app crashes/exits/shows a warning specifically when attached to a debugger or Frida, when running as root, or when running on an emulator — or asks generally to "disable root detection" or "bypass Frida detection".
allowed-tools: decompile_apk, build_code_graph, query_code_graph, search_smali, extract_strings, rabin2_info, disassemble_range, patch_smali_method, disassemble_patch_function, build_apk, sign_apk, verify_apk
---

# Anti-Debug / Anti-Frida / Root-Detection Bypass Skill

These checks share a pattern: they detect a condition, then either throw, silently corrupt state, or call `System.exit`/`Process.killProcess`. The detector is often easy to find; the important part is tracing what it does AFTER detecting, since patching only the detector while missing a second kill-switch leaves the crash in place.

## Step 1 — Decompile and index
`decompile_apk`, then `build_code_graph` if the app is large (see `code-graph-analysis`). Use `query_code_graph(query_type="string_refs", ...)` as your primary search tool — nearly all of these checks are anchored on a distinctive string.

## Step 2 — Search for detection patterns
Load `reference/detection-patterns.md` for the full list of smali search patterns (debugger, Frida, root, emulator) and native `extract_strings`/`rabin2_info` filters. Work through each category — apps frequently combine two or three of these.

## Step 3 — Trace what happens after detection
For every hit, `read_file_chunk` the surrounding method and look for what runs in the "detected" branch:
- `Ljava/lang/System;->exit(I)V`
- `Landroid/os/Process;->killProcess(I)V`
- `throw` of a custom exception
- A silent flag flip that corrupts a later computation (harder to spot — check if the flag feeds into a signature/license check, in which case treat it together with the `signature-bypass` skill)

## Step 4 — Patch
- **Simplest and most robust**: replace the *detector* method itself (e.g. `isDebuggerConnected`, `isFridaRunning`, `isRooted`) with a body that always returns the "safe" value (`patch_smali_method`, body `const/4 v0, 0x0` + `return v0` for a boolean detector that should say "not detected").
- If the kill-switch is inlined at the call site instead of behind a named detector method, patch the branch instead: turn the conditional (`if-nez`/`if-eqz`) into an unconditional path around the `exit`/`killProcess`/`throw`.
- **Native checks** (ptrace-based, TracerPid, Frida server port scan): find the function with `rabin2_info -s`/`-i`, read it with `disassemble_range`, and switch to `native-patching` to force it to return "not detected".

## Step 5 — Rebuild, sign, verify
`build_apk` → `sign_apk` → `verify_apk`.

## Critical Rules
- Checks frequently run on a background thread, in a loop (polling), or in native `JNI_OnLoad`/a JNI static initializer — not just in `onCreate`. If a patched app still exits a few seconds after launch, look for a background poller you missed.
- Killing the process (`System.exit`, `Process.killProcess`) is common — grep for these two calls directly and walk backward to find what condition guards them, even if you haven't found the "named" detector yet.
- Patch every category you find evidence for (debugger AND Frida AND root can all be present); don't stop after the first successful patch.
