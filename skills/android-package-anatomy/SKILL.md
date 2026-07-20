---
name: android-package-anatomy
description: The mental model of what an Android APK actually is — a signed ZIP — and what every part inside it does (dex bytecode, native .so libraries and ABIs, the compiled manifest, resources.arsc, assets, the signing block). Foundational knowledge, not a task recipe.
when_to_use: Read this BEFORE modifying an unfamiliar APK, when a build behaves unexpectedly (missing class, crash on launch, install rejected), or any time you are unsure what a file inside an APK is for or whether it is safe to touch. Pairs with the apk-toolchain skill, which covers WHICH tool to reach for.
allowed-tools: inspect_apk, decode_apk, unzip_apk, get_apk_signature_hash, extract_manifest_info
---

# Android package anatomy

An APK is not a special binary format. **It is a ZIP archive** with a fixed
internal layout and a signature stapled on. Every mistake in APK modding traces
back to misunderstanding one of the members below — editing the wrong copy of a
file, breaking the signature, or touching a compiled blob as if it were text.

Internalize this layout and most "why did the build break" questions answer
themselves.

## What's inside — member by member

```
example.apk  (a ZIP)
├── AndroidManifest.xml     compiled BINARY XML — NOT the text you edit
├── classes.dex             app bytecode (Dalvik/ART), the primary dex
├── classes2.dex …          more bytecode — see "Multidex" below
├── resources.arsc          compiled resource table (string/id/style lookup)
├── res/                    compiled resources (drawables, layouts, values)
├── assets/                 raw files the app opens verbatim at runtime
├── lib/<abi>/*.so          native code, one folder PER CPU ARCHITECTURE
├── META-INF/               the signature (see "Signing")
│   ├── MANIFEST.MF, *.SF, *.RSA   (v1 / JAR signing)
│   └── ...
└── (APK Signing Block)     v2/v3 signature, lives between the ZIP entries
                            and the central directory — not a visible file
```

### AndroidManifest.xml — compiled, not text
Inside the APK this is **Android Binary XML (AXML)**, a compiled blob. If you
`unzip` an APK and open `AndroidManifest.xml`, you get binary garbage, not the
readable `<manifest>` you expect. Only a decoder (apktool) turns it back into
editable text and re-compiles it on rebuild. This is the single most common
"why can't I edit the manifest" trap. See the apk-toolchain skill.

### classes*.dex — the app's bytecode
Java/Kotlin compiles to `.class` files, which are then packed into **DEX**
(Dalvik Executable) files that ART runs on device. This is what you disassemble
to **smali** (human-readable DEX assembly) to patch app logic. You do not edit
`.dex` bytes directly — you disassemble → edit smali → reassemble.

### Multidex — why there are several classes*.dex
A single DEX file can reference at most **65,536 methods** (the "64K method
limit"). Large apps exceed this, so the build splits bytecode across
`classes.dex`, `classes2.dex`, `classes3.dex`, … There is no rule about which
class lands in which dex — the packer decides. **Consequences you must respect:**
- To find a class you may have to search every dex, not just the first.
- The number of dex files is a property of the app. If a rebuild produces
  FEWER dex files than the original (e.g. a `classes4.dex` silently vanishes),
  bytecode was dropped — that is a broken build, even if it installs.
- Adding code can push a build over the limit and force a new dex. Whether that
  is acceptable is a per-task decision — do not assume either way.

### lib/<abi>/*.so — native code, per architecture
Native libraries are compiled per **ABI** (Application Binary Interface = CPU
architecture). Each ABI gets its own folder:
- `arm64-v8a` — 64-bit ARM. **The modern standard; most devices and emulators.**
- `armeabi-v7a` — 32-bit ARM (older devices).
- `x86` / `x86_64` — emulators and a few Intel devices. Often provided only via
  a translation layer on ARM-only apps.

A `.so` in the wrong ABI folder, or a missing ABI the device needs, means the
app cannot load its native code and crashes on launch. If a target runs only
one ABI (e.g. `arm64-v8a`), the other folders are dead weight and can usually be
removed to shrink the APK — but only if nothing loads them.

**Adding or replacing a `.so` is a heavy, high-signal change.** A build that
gains a native library it did not have before is doing something significant;
never treat it as incidental.

### resources.arsc + res/ — compiled resources
`resources.arsc` is the compiled lookup table mapping resource IDs
(`R.string.app_name`) to values, and `res/` holds the compiled resource files.
Both are produced by the resource compiler (aapt2). Editing a string or a layout
means decoding these back to text, editing, and recompiling — not hand-editing
the compiled blob.

### assets/ — raw passthrough
Anything the app reads verbatim at runtime (config files, ML models, Lua/JS
bundles, fonts). Unlike `res/`, assets are **not** compiled or renamed — the
path you see is the path the app opens. Safe to read; edit only what you
understand the app expects.

### META-INF/ + the signing block — see next section

## Signing — the invariant you keep breaking

Android refuses to install an APK whose signature does not verify, and refuses
to **update** an installed app unless the new APK is signed with the SAME key.
There are three signature schemes, and a modern APK often carries several:

- **v1 (JAR signing):** hashes of each file live in `META-INF/MANIFEST.MF`,
  `*.SF`, `*.RSA`. Because it is per-file, it does not protect the ZIP
  structure itself.
- **v2 (APK Signature Scheme):** signs the entire archive as one blob, stored
  in the **APK Signing Block** (an invisible region between the file entries and
  the ZIP central directory — not a member you can see with `unzip -l`).
- **v3:** like v2, plus key-rotation support.

**The rule that governs every modification:** the moment you change *any* byte
of the APK, every existing signature is invalid. You **must re-sign** before the
APK will install. This is why the workflow is always `modify → rebuild → sign →
verify`, and why an unsigned or wrongly-signed rebuild "mysteriously" fails to
install. Signing is not optional polish; it is a hard gate.

`zipalign` (byte-aligning the ZIP for mmap efficiency) must run at the right
point relative to signing — see the apk-toolchain skill for the correct order.

## The one habit that prevents most breakage

Before you change anything, run `inspect_apk` and build a mental census:
how many dex files, which ABIs under `lib/`, is `resources.arsc` present, what
signature scheme. After you rebuild, that census should have changed **only in
the ways you intended**. A dex that disappeared, an ABI folder that appeared, a
new `.so` — if you did not mean to cause it, the build is wrong even if it runs.

## Related skills
- **apk-toolchain** — which tool does what, and the decode-vs-unzip decision.
- **apk-modding** — the end-to-end modify → rebuild → sign → verify workflow.
- **dex-multidex-handling** — fast targeted edits across multiple dex files.
- **manifest-resource-editing** — editing the (compiled) manifest and resources.
