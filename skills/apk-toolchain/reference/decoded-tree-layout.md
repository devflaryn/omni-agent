# The on-disk layout `decode_apk` actually produces

`decode_apk` has **two backends**, and they leave **two different directory
layouts** on disk. Guessing the wrong one is why edits land in the wrong place
or an ABI-strip deletes nothing. Always look at what's actually there before you
write a path.

## Backend 1 — apktool (the default)

Used for ordinary APKs. Output tree:

```
<output_dir>/
├── AndroidManifest.xml      ← readable TEXT xml (edit directly)
├── apktool.yml              ← build metadata (presence ⇒ apktool tree)
├── smali/                   ← primary dex → smali
├── smali_classes2/          ← classes2.dex → smali  (and _classes3, … for multidex)
├── res/                     ← decoded resources (values/*.xml editable)
├── lib/<abi>/*.so           ← native libs, at the TOP LEVEL
└── assets/
```

Here native libs are at **`<output_dir>/lib/<abi>/`**.

## Backend 2 — APKEditor (automatic fallback)

`decode_apk` **auto-switches to APKEditor** for APKs whose resources apktool
can't decode — notably apps with multiple app-defined resource packages. **Roblox
is one of these**, so any Roblox decode you do lands in this layout, not the
apktool one. Output tree:

```
<output_dir>/
├── .apkeditor_decoded       ← MARKER: presence ⇒ APKEditor tree
├── AndroidManifest.xml      ← readable TEXT xml (APKEditor gives real text, good)
├── smali/                   ← normalized to look like apktool: smali/, smali_classes2/, …
├── smali_classes2/          ← (decode_apk renames APKEditor's smali/classes → this)
└── root/                    ← ⚠ everything that ISN'T smali lives UNDER root/
    ├── lib/<abi>/*.so        ←  native libs are at root/lib/<abi>/  — NOT <output_dir>/lib/
    ├── assets/
    ├── resources.arsc
    └── res/
```

The **smali is normalized** to the familiar `smali/ smali_classes2/ …` layout, so
`search_smali`, `patch_smali_method`, and injecting into
`smali_classes2/com/.../ActivitySplash.smali` all work the same. **But
everything else — lib, assets, resources — sits under `root/`.**

## How to tell which layout you got (do this, don't assume)

```
find <output_dir> -maxdepth 1 -type d          # is there a root/ ?
ls <output_dir>/.apkeditor_decoded 2>/dev/null # marker present ⇒ APKEditor
ls <output_dir>/apktool.yml       2>/dev/null  # present ⇒ apktool
```

- `root/` exists or the marker is present → **APKEditor** → native libs at
  **`root/lib/<abi>/`**, assets at `root/assets/`.
- `apktool.yml` present, no `root/` → **apktool** → native libs at
  **`lib/<abi>/`**.

## Consequences for common edits

- **ABI strip** (delete all but arm64-v8a): on a Roblox/APKEditor tree the paths
  are `root/lib/armeabi-v7a/`, `root/lib/x86/`, `root/lib/x86_64/`. Deleting
  top-level `lib/` on an APKEditor tree silently does nothing.
- **Replace / patch a `.so`**: `root/lib/arm64-v8a/libfoo.so` on APKEditor,
  `lib/arm64-v8a/libfoo.so` on apktool.
- **Add a `classes4.dex`**: goes in the tree root next to `smali*`; confirm with a
  post-build `inspect_apk` that the dex count went up as intended.

## Rebuilding — you do NOT pick the builder

`recompile_apk` reads the `.apkeditor_decoded` marker and dispatches to
`APKEditor b` (temporarily de-normalizing the smali back to APKEditor's own
layout) or to `apktool b` accordingly. Point it at the same `<output_dir>` you
edited — never hand-rebuild. Then `sign_apk` → `verify_apk`.
