---
name: apk-modding
description: Complete workflow for modifying Android APKs — decompile, patch smali, rebuild, sign, and verify.
when_to_use: Use this skill when the user asks to modify, patch, bypass, or customize an Android APK (remove ads, bypass license checks, change app behavior, swap libraries, etc.)
allowed-tools: inspect_apk, unzip_apk, decode_apk, search_smali, patch_smali_method, build_code_graph, query_code_graph, recompile_apk, sign_apk, verify_apk
---

# APK Modding Skill

This skill guides you through the complete APK modification lifecycle. Follow these steps in order. It is the entry point for most APK tasks — if the target is a specific kind of check (signature, SSL pinning, anti-debug, obfuscated strings) or a specific edit (manifest/resources, multidex), use the more focused skill for that instead of improvising here; each is listed in "Related skills" below.

## Step 1 — Inspect the APK
Call `inspect_apk` to see what's inside the APK before deciding how to proceed.
Check for: number of .dex files, native .so libraries (and which ABIs), assets, and resources.arsc.

## Step 2 — Choose Your Approach

> Understanding the app first? If you need to READ and trace the app's logic before editing (large or obfuscated app, unclear where the target is), `jadx_decompile` gives readable Java (use `deobf=true` on obfuscated apps) — much faster to reason about than smali. Then search it with `grep_directory` / `find_files`. Make the actual EDIT in smali below, since jadx output isn't recompilable.

### Approach A: Whole-file edits (fast, no smali needed)
Use this when you only need to swap/delete/replace whole files (e.g. remove an architecture, replace a .so, change an asset).
1. `unzip_apk` to extract raw contents
2. Make your file changes (move_file, delete_path, duplicate_file, write_file)
3. `recompile_apk` to rebuild (it detects the raw directory and repacks with zip)
4. `sign_apk` to sign
5. `verify_apk` to confirm

### Approach B: Smali / resource / manifest edits (decode)
Use this when you need to modify Dalvik bytecode, XML resources, or AndroidManifest.xml.
1. `decode_apk` to get smali + readable resources
2. If the APK has many smali files, call `build_code_graph` once to index them, then use `query_code_graph` to navigate efficiently — see the `code-graph-analysis` skill
3. Use `search_smali` to find target code (signature checks, anti-tamper, specific API calls)
4. Edit smali with `patch_smali_method` (replace a method body) or `write_file` (whole-file edit)
5. `recompile_apk` to rebuild
6. `sign_apk` to sign
7. `verify_apk` to confirm

## Step 3 — Native library patching (if needed)
If the target logic is in a .so file, switch to the `native-patching` skill — it covers finding the function, disassembling it, and patching bytes precisely.

## Step 3b — Direct DEX editing (without full decompile)
If you only need to edit one .dex file, possibly among several (multidex), without decompiling the whole APK, switch to the `dex-multidex-handling` skill.

## Related skills
Pick the specific skill that matches the check you're actually bypassing or the edit you're actually making, rather than improvising it inline here:
- `signature-bypass` — APK signature / certificate / integrity verification checks
- `ssl-pinning-bypass` — certificate pinning (TrustManager, OkHttp CertificatePinner, network_security_config.xml)
- `anti-debug-bypass` — debugger, Frida, root, and emulator detection
- `string-deobfuscation` — encrypted/obfuscated string literals guarding a check
- `manifest-resource-editing` — AndroidManifest.xml permissions/flags, res/xml, res/values edits
- `native-patching` — patching a native .so library with canned patterns (NOP, force-return, string swap)
- `native-code-injection` — writing genuinely NEW native logic (custom algorithms/checks) via a real assembler/compiler, when native-patching's canned patterns aren't enough
- `smali-code-injection` — adding a brand-new method/field to a smali class, not just editing one that already exists
- `dex-multidex-handling` — editing one dex among several without a full apktool decompile
- `code-graph-analysis` — navigating a large decompiled codebase cheaply
- `emulator-testing` — actually running the built/signed APK on an emulator to confirm a patch works, instead of only trusting `verify_apk`'s structural checks

## Critical Rules
- ALWAYS call `verify_apk` after signing. Never report an APK as done until it passes all checks.
- `recompile_apk` is the single rebuild tool for BOTH paths: it auto-detects whether the directory is an `unzip_apk` raw tree (zip repack) or a `decode_apk` apktool tree (apktool build), so you don't pick the rebuild method — just point it at the directory you edited.
- After modifying a .so, recompile and re-sign the APK. The APK signature changes, so any signature verification in the app may need to be patched too — see `signature-bypass`.
- Use `get_apk_signature_hash` BEFORE modifying to record the original signature, then search smali for checks comparing against it.
