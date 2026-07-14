---
name: smali-code-injection
description: Add brand-new methods, fields, or logic blocks to an existing smali class — not just edit a method that already exists.
when_to_use: Use this skill when the task needs NEW behavior that doesn't map onto replacing an existing method's body — e.g. adding a helper method other code can call, adding a field to hold new state, hooking a constructor to run extra logic on top of what's already there, or wiring a new check into an app rather than bypassing an old one.
allowed-tools: decode_apk, search_smali, read_file_chunk, insert_smali_code, patch_smali_method, recompile_apk, sign_apk, verify_apk
---

# Smali Code Injection Skill

`patch_smali_method` only works when the method you're targeting already exists — it finds a `.method`/`.end method` block and replaces the whole body. It can't add a method or field that isn't there yet, and using it to declare a new method with an unused name will just silently do nothing (nothing matches). `insert_smali_code` is the tool for genuinely new additions.

## Step 1 — Decompile and locate the target class
`decode_apk`, then `search_smali` or `read_file_chunk` to find the exact `.smali` file for the class you want to extend. Read its header (the `.class`/`.super`/`.implements` lines) so any new method you write matches the class's actual package path and superclass.

## Step 2 — Write the new smali block
A minimal new method needs a `.method` header with the correct access modifier, exact name and signature, `.locals N` declaring how many local registers it uses, a body, and `.end method`. Load `reference/smali-cheatsheet.md` for register/type/invoke syntax if you're not confident writing raw smali by hand.

Example — a new no-arg method returning a boolean:
```
.method public isPatchedFeatureEnabled()Z
    .locals 1
    const/4 v0, 0x1
    return v0
.end method
```

A new instance field:
```
.field private patchedFlag:Z
```

## Step 3 — Insert it
Call `insert_smali_code(smali_file=..., code=..., anchor="end_of_class")` for a self-contained addition, or `anchor="after_method:<name>"` to place it next to a related method for readability. Both are equally valid — `end_of_class` is the safe default.

## Step 4 — Wire it in (if it needs to actually run)
A new method sitting unused in a class does nothing by itself. If the goal is for the new logic to actually execute:
- To make an EXISTING method call your new one, that existing method's body must change — use `patch_smali_method` on it, adding an `invoke-direct`/`invoke-static`/`invoke-virtual` to your new method into its body (see `reference/smali-cheatsheet.md` for the exact invoke syntax per case).
- To run something automatically at construction/startup, patch the class's `<init>` method (constructor) or `onCreate`/`attachBaseContext` to call your new method, rather than inventing a fictitious auto-run mechanism — smali has no equivalent of Java's static initializer running "for free" without a call site.

## Step 5 — Rebuild, sign, verify
`recompile_apk` → `sign_apk` → `verify_apk` (see `apk-modding`).

## Critical Rules
- NEVER insert a `.method` with the same name+signature as one that already exists in the class — smali/dex requires unique method signatures per class; a duplicate will fail to assemble (or worse, silently pick one at build time). Check with `search_smali` first.
- A new method is inert until something calls it. Always complete Step 4 — don't report the task done just because the method compiles.
- Match the method's return type and parameter types EXACTLY to how you intend to call it — a mismatched signature at the call site is one of the most common causes of a build failure or runtime `VerifyError`.
- For editing a check that ALREADY exists to bypass it, use `patch_smali_method` and the `signature-bypass`/`anti-debug-bypass`/`ssl-pinning-bypass` skills instead — this skill is specifically for adding logic that isn't there yet.
