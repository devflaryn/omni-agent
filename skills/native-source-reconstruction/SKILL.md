---
name: native-source-reconstruction
description: Turn a native .so (obfuscated, up to ~10MB) from an APK back into readable C/C++ source — inspect it first, skip the statically-linked open-source libraries, and reconstruct only the custom core with a cheap sourcing model, one fresh-context subagent per batch.
when_to_use: Use when the goal is to RECOVER SOURCE from a native library (not just patch a guard) — "decompile this .so back to source", "reverse this libX.so", "what does this obfuscated native library actually do". Handles the size problem by partitioning library vs custom code.
allowed-tools: inspect_apk, unzip_apk, identify_native_components, partition_native_functions, extract_strings, rabin2_info, nm_symbols, readelf_info, ghidra_decompile, disassemble_range, llvm_objdump_disasm, analyze_function_calls, run_workflow, dispatch_agents, write_file, record_finding
---

# Native Source Reconstruction

Recovering source from a 10MB stripped, obfuscated `.so` is not one giant decompile — it is a **partition problem**. Most of that size is open-source code compiled in (a Luau/Lua VM, OpenSSL/BoringSSL, Crypto++, zlib, the C++ STL, protobuf, ...), which already has authoritative upstream source. The author's own logic is a much smaller custom core. The whole method is: figure out which is which, then spend the decompiler and the LLM only on the custom part.

Do NOT try to feed a 10MB binary — or even a whole function list — to any model. That is the mistake this skill exists to prevent. Work in the phases below; the `reconstruct-native-source` workflow automates them.

## Step 1 — Get the .so out of the APK
1. `inspect_apk` with filter `.so` to list the native libraries and their ABIs.
2. Pick the ABI (usually `arm64-v8a`). `unzip_apk` (or the workflow's triage step) extracts it. Note the path, e.g. `lib/arm64-v8a/libfoo.so`.

## Step 2 — INSPECT FIRST: identify the open-source components
Always do this before decompiling anything.
1. `identify_native_components(so_path)` fingerprints the statically-linked OSS from the binary's strings and symbols. Each hit comes back with a category and an **upstream `source_url`**. For a Roblox-adjacent target expect **Luau** almost always; commonly also OpenSSL/BoringSSL, Crypto++, zlib, and the C++ runtime.
2. Read the `custom_surface` estimate — that percentage of unattributed symbols is roughly how much real work remains. If it's tiny, most of the binary is just libraries and you're nearly done: point at the source_urls and stop.
3. If a library you expect isn't detected, confirm with `extract_strings` (version banners) / `nm_symbols` before assuming it's custom — sourcing library code by hand is wasted effort.

## Step 3 — Partition into batches
1. `partition_native_functions(so_path, batch_size=12, max_functions=400)` splits the function inventory into **library** (attributable — skipped) and **custom** (unattributed — the real target), returning the custom functions in small batches.
2. Check `truncated`: if there are more custom functions than `max_functions`, raise the cap deliberately (and know the run will cost more) rather than silently reconstructing a fraction.

## Step 4 — Source the custom core (delegate, one batch per subagent)
This is where context and memory management matter — never hold the binary or all the pseudocode in one context.
1. Prefer the workflow: `run_workflow("reconstruct-native-source", args={"so": "<path>", "sourcing_model": "<deepseek id>", "max_functions": 400})`. It pipelines each batch through a `source-reconstructor` subagent that: `ghidra_decompile`s each function, rewrites the pseudocode into named/typed/commented source, and `write_file`s the result to `reconstructed/custom/<so>__batch_<n>.c`. Fresh context per batch; only a short manifest returns to the orchestrator.
2. To do it by hand, `dispatch_agents` a wave of `source-reconstructor` agents (each scoped to its own output file) with the batches from Step 3. Pin them to the cheap **sourcing model** (deepseek-class) — reconstruction is high-volume, faithful rewriting, exactly what a cheap fast model is for. The decompiler does the hard analysis; the model just cleans it up.
3. Carry a shared **glossary** of recovered structs/types/globals between batches so the files agree on names.

## Step 5 — Assemble and be honest
1. The output tree: `reconstructed/custom/*.c|.cpp` (the reconstructed author code) and a `RECONSTRUCTION_REPORT.md` listing every detected library with its upstream source_url (the parts you did NOT reconstruct) plus the custom files and the glossary.
2. Mark confidence per function. Decompiler-derived source is a faithful reconstruction, **not** the original — never present it as the verbatim original. Flag low-confidence functions and any that were unrecoverable, and state if the custom set was truncated.

## Why this is cheap and tractable
A 10MB `.so` that is 80% Luau + OpenSSL + STL leaves maybe a few hundred custom functions. Sourcing those in ~12-function batches on a cheap model, in parallel, with each batch writing straight to disk, is what turns "reverse a 10MB obfuscated library" from impossible into a bounded, affordable run. The `identify_native_components` step is the lever — without it you'd pay a premium model to re-derive `std::string`.
