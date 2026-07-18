---
name: root-detection-bypass
description: Find and neutralize Android root detection so an app runs on a rooted device/emulator — covers su-binary/file checks, dangerous-props and build-tags, the RootBeer library, package/Magisk checks, SafetyNet/Play-Integrity gating, and native root checks. Patches statically (smali/.so) after confirming which check fires.
when_to_use: When an app refuses to start, hides features, or shows a "device is rooted / not secure" message on a rooted device or emulator, or the user asks to bypass root detection / run on root. Distinct from anti-debug (debugger/ptrace) and signature verification — though apps often layer all three.
allowed-tools: decode_apk, query_code_graph, search_smali, grep_file, read_file_chunk, extract_strings, ghidra_decompile, patch_smali_method, insert_smali_code, patch_function_return, nop_function, recompile_apk, sign_apk, verify_apk, hide_root_from_app, frida_run_script
---

# Root detection bypass

Root detection is almost always LAYERED: a Java sweep (su paths, props, packages), often
the RootBeer library, sometimes a native re-check, and increasingly a server-side
SafetyNet/Play-Integrity verdict. Patch only one and the app still blocks. Find them all,
neutralize each, verify on a rooted base.

## Step 1 — Locate every check
`decode_apk`, then hunt by the signals (load `reference/root-signals.md` for the full
list of strings, classes, and search patterns):
- `query_code_graph(name="/system/xbin/su")`, `query_code_graph(name="isRooted")`,
  `query_code_graph(name="test-keys")`, `query_code_graph(name="RootBeer")` — bare-name
  searches land you on the exact `file:line`.
- `search_smali` for the su-path strings, `Build.TAGS`, `ro.debuggable`/`ro.secure`,
  known root-app package names, and `Runtime.exec("su")`.
- `extract_strings` on `.so` files — a native root check leaks the same su paths / prop
  names.

## Step 2 — Confirm which one actually gates (recommended)
Before patching, prove it with Frida on the dev base (see `frida-dynamic-instrumentation`):
override the suspected `isRooted()`/`checkRoot()` to return false, or use the one-shot
`hide_root_from_app`, and watch whether the app now proceeds. That tells you the real
gate and the value that means "clean" — so your static patch is correct.

## Step 3 — Patch each surface (static, permanent)
- **A boolean method** (`isRooted`/`isDeviceRooted`/`checkRoot` → Z): `patch_smali_method`
  to always `const/4 v0, 0x0` + `return v0` (false = not rooted). For RootBeer,
  `isRooted()` and the individual `checkFor*` methods.
- **A void guard that exits/blocks**: neutralize the branch that acts on the result, or
  make the detector return the safe value upstream so the guard never trips.
- **Native root check** (`.so`): `ghidra_decompile` to find the function, then
  `patch_function_return` (force the clean value) or `nop_function`. Note the exact
  offset from your Frida confirmation.
- **SafetyNet / Play Integrity**: this is validated server-side — you generally CANNOT
  patch it away in the client. Say so explicitly. The real-world path is hiding root from
  the detector (Magisk DenyList / Zygisk) at runtime, not an APK edit. Don't claim a
  static bypass you can't deliver.

## Step 4 — Rebuild, sign, verify
`recompile_apk` → `sign_apk` → `verify_apk`, then confirm behavior per
`verification-before-completion`: install and launch on the rooted base, read logcat,
confirm the app runs past the check — and that a SECOND check didn't take over.

## Critical Rules
- **Find them ALL before declaring done.** Java sweep + RootBeer + native + server check
  commonly coexist. A bypass that misses one is not a bypass.
- **Confirm dynamically, patch statically.** Use Frida/`hide_root_from_app` to prove the
  gate; ship the fix as a smali/.so patch (unless the user wants a runtime/Magisk
  solution).
- **Be honest about SafetyNet/Play-Integrity.** Client patching doesn't beat a server-side
  attestation — report that limitation instead of a false success.
- **Root detection ≠ anti-debug ≠ signature check.** If the app still blocks after root is
  handled, the gate may be one of those — switch to `anti-debug-bypass` /
  `signature-bypass`.
