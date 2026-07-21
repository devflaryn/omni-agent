---
name: learn-and-apply-modification
description: Learn a modification technique from a WORKING modified APK plus its plain base, then reconstruct it on a target APK — understanding the technique, not copying files. Records what it learned as a checkpoint that also arms the build-constraint gate.
when_to_use: Use when the user gives a working modified APK and its base and asks to learn the change/bypass and apply it to the base or a new target (e.g. "learn the bypass on this APK and add it to the base"). NOT for a from-scratch mod (use apk-modding) or a whole-file swap (use apk-toolchain's unzip path).
allowed-tools: decode_apk, compare_directories, diff_code_graphs, build_code_graph, query_code_graph, jadx_decompile, search_smali, record_learned_technique, clear_technique_constraints, patch_smali_method, insert_smali_code, recompile_apk, sign_apk, verify_apk, write_file
---

# Learn-and-apply modification

You are given a **reference modified APK** and its **plain base**, and a
**target** to reconstruct the change on (often the base itself, or a new
build). Your job is to UNDERSTAND what the reference did and rebuild it on the
target — **never blindly copy the changed files**, because the target is a
different build where copied files may not fit. Read
`android-package-anatomy` and `apk-toolchain` first if you are unsure of APK
internals or the decode-vs-unzip rule.

## The hard rule

**Do NOT edit the target before you have called `record_learned_technique`.**
That call is the checkpoint: it echoes back what you understood, becomes your
apply plan, and arms the constraint gate that verifies your result. Editing
first means you are guessing, not applying an understood technique.

## Phase 1 — Locate what changed

1. `decode_apk` the reference-modified APK and the reference-base into their
   canonical decode dirs.
2. `compare_directories` on the two decoded trees → the file-level change set
   (which smali files differ, which libs/assets were added).
3. `diff_code_graphs` on the two → the METHOD-level change set (which methods
   changed), which is what tells you where the technique actually lives.

## Phase 2 — Comprehend the technique

For each changed site: `query_code_graph` (by name), `jadx_decompile`, and
`search_smali` until you can state, in plain terms, WHAT the technique does and
HOW it is wired — which methods are hooked, what the edit is, how the hook is
installed, and whether any native `.so`/asset was added.

## Phase 3 — Record (the checkpoint)

Call `record_learned_technique` with: `technique`, `mechanism`, a `hook_points`
list ({class, method, edit, dex}), `entry_point`, and `native_additions` /
`asset_additions` (empty if none). This echoes your understanding and arms the
gate — e.g. `native_additions: []` means the gate will now REJECT a build that
adds a new `.so`. Then `write_file learned_technique.json` with the same
structure so a durable per-project copy exists for review.

## Phase 4 — Apply to the target

`decode_apk` the target into its own dir, then **`build_code_graph` over that
target dir with a DISTINCT `graph_id`** (e.g. `graph_id="target"`). This is
mandatory: Phase 1 already built graphs for the reference pair, and
`query_code_graph` defaults to the most-recently-built graph — so without an
explicit target graph you would resolve hook points against the REFERENCE tree
and reintroduce the exact reference-path bug the name-based approach exists to
avoid.

For EACH hook point, resolve the site in the target by **`query_code_graph`
with your target `graph_id`, on class+method NAME — never by the reference's
file path** (apktool/APKEditor can renumber smali paths between builds; the
graph finds the method wherever it landed). Apply the edit with
`patch_smali_method` or `insert_smali_code`. Reproduce the entry-point wiring
the same way.

## Phase 5 — Verify and hand off

`recompile_apk` the target **with `original_apk` set to the target's base** so
the constraint gate runs (constraints omitted with a base = unverified = the
tool refuses). The gate checks your reconstruction against what you recorded:
if you said "no new .so" and a `.so` slipped in, the build fails with the
delta — fix and rebuild (bounded retries). Once it passes, `sign_apk` +
`verify_apk`, then hand the signed APK to the normal on-device test flow to
confirm the technique works at runtime.

Finally, call **`clear_technique_constraints`** so the constraints this
technique auto-armed do not leak into a later, unrelated task in the same
session (it removes only the technique's own constraints, keeping any the user
stated). This skill's job ends at a structurally-verified, signed APK with the
technique constraints cleared.

## Related skills
- **android-package-anatomy** — what the APK members are; why signing breaks.
- **apk-toolchain** — decode vs unzip; the tool map.
- **apk-modding** — building a modification from scratch (no reference).
