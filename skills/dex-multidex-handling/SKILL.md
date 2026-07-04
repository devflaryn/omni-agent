---
name: dex-multidex-handling
description: Locate and edit a specific class inside a multidex APK (classes.dex, classes2.dex, ...) without a full apktool decompile.
when_to_use: Use this skill when the target class/method is somewhere in a multidex APK and you want to make a targeted smali edit quickly, or when you need to figure out which of several .dex files actually contains a given class before deciding how to edit it.
allowed-tools: inspect_apk, unzip_apk, list_dex_classes, disassemble_dex, patch_smali_method, insert_smali_code, assemble_dex, move_file, repack_apk, sign_apk, verify_apk
---

# DEX / Multidex Handling Skill

Full `decompile_apk` (apktool) processes every dex and every resource — correct but slow on large multidex apps when you only need one class. This skill is the fast path.

## Step 1 — Check how many dex files exist
`inspect_apk` with `filter_pattern='.dex'` — you'll see `classes.dex`, and possibly `classes2.dex`, `classes3.dex`, etc.

If there's only one `classes.dex`, this skill still works but you gain nothing over decompiling — consider going straight to `apk-modding`'s Approach B instead.

## Step 2 — Extract the dex files
`unzip_apk` to pull the raw APK contents out, including all the classes*.dex files, without decoding smali/resources.

## Step 3 — Find which dex has your target class
Before disassembling anything, run `list_dex_classes` on EACH dex file and check for your target's class descriptor (e.g. `Lcom/example/MainActivity;`). This is much cheaper than disassembling every dex just to search it.

## Step 4 — Disassemble only that one dex
`disassemble_dex` on the single dex file that contains your class. This produces smali files for just that dex's classes.

## Step 5 — Edit
`patch_smali_method` to replace an existing method's body, `insert_smali_code` to ADD a new method/field that doesn't exist yet (see `smali-code-injection`), or `write_file` for broader whole-file edits — same as any other smali edit.

## Step 6 — Reassemble and put it back
1. `assemble_dex` the edited smali directory back into a `.dex` file.
2. Give the rebuilt dex the EXACT SAME FILENAME it originally had (e.g. `classes2.dex` stays `classes2.dex`) — `move_file` it over the old one inside the unzipped directory.
3. `repack_apk` (this directory came from `unzip_apk`, so `repack_apk`, not `build_apk`).
4. `sign_apk` → `verify_apk`.

## Critical Rules
- ALWAYS run `list_dex_classes` before `disassemble_dex` — don't guess which dex holds the class, and don't disassemble every dex "just in case" on a large app.
- Keep the exact original dex filename and its position implied by that name (`classes.dex` is always the primary dex; `classesN.dex` order matters for some legacy MultiDex configurations) — renaming or reordering can break the app's dex loading at startup.
- If the class you need to edit is referenced (called) from other dex files but DEFINED in only one, you generally only need to patch the dex that DEFINES it — cross-dex calls resolve by class descriptor at the runtime verifier level, not by dex file identity.
- If you end up needing to touch many classes across many dex files, that's a sign to switch to the full `decompile_apk` (`apk-modding`) workflow instead of chasing individual dex files one at a time.
