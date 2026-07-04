---
name: string-deobfuscation
description: Recover or bypass checks guarded by encrypted/obfuscated string literals in ProGuard/R8-obfuscated or custom-packed Android code.
when_to_use: Use this skill when a check you need to bypass compares against a string that isn't a plain literal in smali — e.g. it's built from a byte array, decrypted at runtime, or passed through an obfuscated helper class before use — and plain search_smali/string_refs for the plaintext value finds nothing.
allowed-tools: decompile_apk, build_code_graph, query_code_graph, search_smali, read_file_chunk, ghidra_decompile, disassemble_range, patch_smali_method, hex_patch_file
---

# String Deobfuscation Skill

This agent works statically — it reads and patches code but cannot execute the app's Java/Dalvik bytecode. That shapes the whole approach: prefer bypassing the check over fully "decrypting" the string, unless the plaintext itself is what the user actually needs.

## Step 1 — Confirm the string really is obfuscated
Try the obvious thing first: `search_smali` or `query_code_graph(query_type="string_refs")` for the plaintext value you expect. If it's genuinely not a plain literal, you'll see the check instead reference a byte array (`fill-array-data`), a call to a small static helper class (commonly named `a`, `b`, `aa` after R8 obfuscation), or a native JNI call.

## Step 2 — Find the decrypt/decode routine
- If it's a Java/smali helper: `search_smali` for calls to the same helper method from many different call sites — a shared string-decoder is usually called dozens of times across the app, which is itself a strong signal you found it. `read_file_chunk` its body.
- If it's native: use `rabin2_info`/`nm_symbols` to find the JNI function, then `ghidra_decompile` it for C-like pseudocode — much easier to read than raw disassembly for crypto-shaped code (loops with XOR/shift/table lookups).

## Step 3 — Work out the algorithm by reading, not running
Common patterns to recognize:
- **XOR with a fixed key or with the string's own index** — look for a `xor-int` / `xor` loop over a byte array.
- **Base64 + AES/DES with a hardcoded key** — look for `javax/crypto/Cipher`, `SecretKeySpec`, and a suspicious short byte-array constant nearby (the key).
- **Simple character-shift / substitution table** — a lookup array indexed by the input byte.

Since you cannot execute the routine, reconstruct it by hand from the read code (or ask the user to run it dynamically with Frida/jadx's own string-decryption tooling if the algorithm is too complex to reason through statically — say so explicitly rather than guessing at a decrypted value).

## Step 4 — Prefer bypassing the check over decrypting everything
If the actual goal is "make this check pass" rather than "recover this exact string", it's almost always faster and more reliable to patch the COMPARISON that uses the decrypted string (make it always take the pass branch, or `patch_smali_method` the check to return the desired boolean) rather than fully reverse the encryption. Treat the check itself like a `signature-bypass` or `anti-debug-bypass` target once you've identified it.

## Step 5 — Narrow scope
Don't attempt to decrypt every obfuscated string in the app "just in case." Scope your effort to the specific string/check the task actually needs.

## Critical Rules
- If the key material is derived from something this agent can't observe statically (a hardware-bound ID, a server-provided value, a true RNG), say so — don't fabricate a plaintext guess.
- When in doubt between "recover the plaintext" and "bypass the check", bypass the check — it requires less certainty about the exact algorithm and is more robust to obfuscation variants.
