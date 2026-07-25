---
name: apk-toolchain
description: The tools real reverse engineers use on APKs — apktool, APKEditor, jadx, baksmali/smali, aapt2, zipalign, apksigner — what each is FOR, and the single most important decision in APK work: full decode (apktool) versus raw unzip. Maps each industry tool to this agent's corresponding tool.
when_to_use: When you are about to unpack, decode, decompile, rebuild, or sign an APK and need to choose the right approach, or when a build broke and you suspect you used the wrong tool (e.g. unzipped when you should have decoded). Read alongside android-package-anatomy, which covers WHAT the pieces are.
allowed-tools: inspect_apk, decode_apk, unzip_apk, jadx_decompile, search_smali, search_java, recompile_apk, sign_apk, verify_apk, replace_file_in_apk, get_apk_signature_hash
---

# The APK toolchain

Reverse engineers do not have one "open APK" button. They pick a tool by **what
they intend to change**. Picking wrong is the most common cause of a bad build —
most often, unzipping an APK when the task required a full decode. This skill
gives you the expert's decision rule and maps each industry-standard tool to the
tool this agent exposes.

## The decision that governs everything: decode vs unzip

There are two fundamentally different ways to open an APK, and they are **not**
interchangeable:

| | **Full decode** (apktool) | **Raw unzip** |
|---|---|---|
| This agent's tool | `decode_apk` | `unzip_apk` |
| AndroidManifest.xml | → readable **text** XML | stays compiled binary (unreadable) |
| resources.arsc / res | → decoded `res/values/*.xml` | stays compiled |
| dex bytecode | → editable **smali** tree | stays packed `.dex` |
| Speed | slower (processes everything) | fast (just extracts files) |
| Rebuild | `recompile_apk` re-encodes everything | `recompile_apk` auto-detects the raw dir and re-zips |

**The rule:**

> **Any change to code, the manifest, or resources → `decode_apk` (full tree).**
> **Only whole-FILE swaps of already-compiled blobs → `unzip_apk`.**

Concretely:
- Patch app logic, add smali, edit `AndroidManifest.xml`, change a string or
  layout → **`decode_apk`**. `unzip_apk` gives you a compiled manifest you
  cannot edit and packed dex you cannot patch. This is the trap.
- Replace a whole `.so`, delete an unused ABI folder (`lib/x86`), swap a whole
  asset file → **`unzip_apk`** is legitimate and faster, because you are moving
  whole compiled files, not reading or editing their contents.

**Code modification always uses the full `decode_apk` tree — never a partial
unzip as the source of a rebuild.** A partial extraction (say, only `lib/`) is
not a valid basis for rebuilding an app whose code you changed: rebuilding from
a tree that never contained the dex/manifest is how bytecode silently goes
missing. If in doubt, decode fully.

**One decode per APK.** Do not scatter an APK across several half-extractions
(`foo_libs/`, `foo_res/`, `foo_decoded/`). Keep a single decoded tree per APK
and work in it. Multiple partial trees invite rebuilding from the wrong one.

## The industry tools, and how they map here

### apktool — the workhorse decoder → `decode_apk`
Decodes the manifest and resources to text and disassembles dex to smali;
rebuilds the lot. This is the default for almost any real modification. When an
expert says "decompile the APK" for editing, they usually mean apktool. Here:
`decode_apk` to open, `recompile_apk` to rebuild.

### APKEditor — an alternative decode/merge engine
Some pipelines prefer APKEditor for its resource handling and for merging split
APKs (app bundles). This agent's `decode_apk`/`recompile_apk` may use apktool or
an APKEditor-style backend under the hood; you do not choose the engine
directly — you choose decode (editable) vs unzip (raw).

### jadx — decompile to readable Java → `jadx_decompile`
apktool gives you **smali** (accurate, low-level, what you PATCH). jadx gives you
**Java** (approximate, high-level, what you READ to understand logic). Experts
read the app in jadx to find *what* to change, then patch the corresponding
**smali** from the apktool tree. jadx output is for comprehension; do not try to
"rebuild from jadx Java" — it is lossy and not meant to recompile. Here:
`jadx_decompile` to read, `search_java` to grep the decompiled Java,
`search_smali` to grep the patchable smali.

### baksmali / smali — DEX ⇄ smali assembler
The disassembler/assembler behind the smali tree. apktool wraps these, so a
normal `decode_apk` → edit → `recompile_apk` cycle already uses them. Reach for
them directly only for fast single-dex work (see the dex-multidex-handling
skill) rather than a full decode.

### aapt2 — the resource compiler
Compiles `res/` and `resources.arsc`. apktool invokes it during rebuild, so you
rarely call it yourself; know it exists so resource-compile errors during
`recompile_apk` make sense.

### zipalign + apksigner — finalize and sign → `sign_apk`
After rebuilding, the APK must be **aligned** (zipalign, so the OS can mmap
uncompressed entries) and **signed** (apksigner, v2/v3 scheme). Order matters:
align first, then sign with apksigner (modern apksigner can also align in one
step). Here, `sign_apk` handles this; **always** finish with `verify_apk` to
confirm the signature is valid before you trust or ship the APK. An unsigned or
mis-ordered build will not install — see android-package-anatomy › Signing.

## The canonical expert workflow

```
inspect_apk            # census: dex count, ABIs, resources, signature scheme
   │
   ├─ read to understand?     → jadx_decompile / search_java
   │
   ├─ change code/manifest/res? → decode_apk (FULL tree)
   │        edit smali / text XML / res in that ONE tree
   │        → recompile_apk → sign_apk → verify_apk
   │
   └─ swap a whole compiled file only (.so, asset, drop an ABI)?
            → unzip_apk (or replace_file_in_apk) → recompile_apk → sign_apk → verify_apk
```

Then re-run `inspect_apk` on the output and confirm it differs from the original
**only** as you intended (android-package-anatomy › "the one habit").

## Before you write a path or chase a crash — read the bundled references

Two lookups that prevent the most expensive mistakes on native-app targets
(Roblox/Arceus-style). Pull them with `read_skill_resource` when relevant:

- **`reference/decoded-tree-layout.md`** — the ACTUAL on-disk layout `decode_apk`
  produces. It has two backends: apktool (libs at `lib/<abi>/`) and APKEditor,
  which `decode_apk` auto-selects for multi-package apps **like Roblox** and which
  puts libs/assets/resources under **`root/`** (so ABIs are at `root/lib/<abi>/`).
  Read this before deleting an ABI, swapping a `.so`, or wondering why an edit
  "did nothing" — you were almost certainly writing the wrong layout's path.
- **`reference/known-traps.md`** — verified failure modes and their fixes:
  re-signing usually beats chasing a native "anti-tamper" patch (confirm the
  crash first); native `bl→RET` patches that break JNI `RegisterNatives`;
  `sign_apk` uses `apk_filename`; `$` in inner-class smali filenames; assembling a
  dex when the tool finds 0 files; verifying dex count after adding `classes4.dex`;
  and emulator account/signature-mismatch pitfalls.

## Related skills
- **android-package-anatomy** — what each member of the APK is and why signing breaks.
- **apk-modding** — the guided end-to-end modification workflow.
- **dex-multidex-handling** — the fast baksmali/smali path for one class.
- **manifest-resource-editing** — decode-first manifest and resource edits.
- **signature-bypass** — when the app itself checks its own signature.
