---
name: signature-bypass
description: Find and bypass APK signature verification and anti-tamper checks in both smali and native code.
when_to_use: Use this skill when the user needs to bypass signature verification, integrity checks, anti-tamper, or root detection in an Android app after modifying it.
allowed-tools: get_apk_signature_hash, decompile_apk, build_code_graph, search_smali, read_file_chunk, patch_smali_method, build_apk, sign_apk, verify_apk
---

# Signature Bypass Skill

After modifying and re-signing an APK, the app may detect the signature change and refuse to run. This skill helps you find and neutralize those checks.

## Step 1 — Record the original signature
Call `get_apk_signature_hash` on the ORIGINAL (unmodified) APK to get the developer's SHA1/SHA256 fingerprint. Note these values — you'll grep for them or their comparison logic.

## Step 2 — Decompile the APK
Call `decompile_apk` to get smali code. If the APK is large, call `build_code_graph` first (see the `code-graph-analysis` skill) so you can query efficiently instead of grepping repeatedly.

## Step 3 — Find the checks
Load `reference/search-patterns.md` for the full list of `search_smali` patterns to try for signature verification, anti-tamper/integrity checks, and native-layer equivalents. For each hit, use `read_file_chunk` to read the surrounding method and understand the check logic before patching it.

## Step 4 — Patch the checks
In smali, common bypass patterns:
- **Return true from a boolean check**: replace the method body with `const/4 v0, 0x1` + `return v0`
- **Return false from a detection method**: replace with `const/4 v0, 0x0` + `return v0`
- **Skip a conditional branch**: change `if-eqz` / `if-nez` to `goto` the pass branch

Use `patch_smali_method` for method-body replacements — give it the method name and the full new smali body.

In native code, use the `native-patching` skill (NOP the check or force-return the desired value).

## Step 5 — Rebuild, sign, verify
1. `build_apk` to rebuild from decompiled directory
2. `sign_apk` to sign with the debug key
3. `verify_apk` to confirm the APK is valid

## Critical Rules
- There may be MULTIPLE checks in different locations. Search thoroughly (all patterns in `reference/search-patterns.md`) and patch ALL of them.
- Some checks run in a background thread or native init. Check `onCreate`, `attachBaseContext`, and JNI `JNI_OnLoad` in .so files.
- Google Play Integrity API checks cannot be bypassed locally — inform the user if you encounter them.
- If root detection is also present alongside signature checks, treat it as part of the same sweep — see `reference/search-patterns.md` for those patterns too, or use the `anti-debug-bypass` skill if root/debugger/Frida detection is the dominant concern.
