meta = {
    "name": "reconstruct-native-source",
    "description": "Turn a .so (obfuscated, up to ~10MB) back into source: inspect it, skip the statically-linked open-source libraries, and reconstruct only the custom functions with a cheap sourcing model — one fresh-context subagent per batch, each writing its files to reconstructed/.",
    "when_to_use": "You have an APK's native library (or a .so directly) and want readable C/C++ source back, not just a patch. Handles the size by partitioning: detected OSS (Luau, OpenSSL, Crypto++, STL, ...) is pointed at upstream; only the unattributed custom core is decompiled and sourced.",
    "phases": [{"title": "Triage"}, {"title": "Source"}, {"title": "Assemble"}],
    "args_schema": {
        "so": {"label": "Path to the .so (or leave blank and give an APK)",
               "required": False, "placeholder": "reconstructed/lib/arm64-v8a/libfoo.so"},
        "apk": {"label": "APK to extract the .so from (optional)",
                "required": False, "placeholder": "app.apk"},
        "arch": {"label": "ABI to extract from the APK",
                 "required": False, "placeholder": "arm64-v8a"},
        "sourcing_model": {"label": "Model id for the sourcing subagents",
                           "required": False, "placeholder": "deepseek-chat"},
        "max_functions": {"label": "Cap on custom functions to source",
                          "required": False, "placeholder": "400"},
    },
}

SO = ((args or {}).get("so") or "").strip()
APK = ((args or {}).get("apk") or "").strip()
ARCH = ((args or {}).get("arch") or "arm64-v8a").strip()
# The "sourcing with a model like deepseek v4 flash" knob: every reconstruction
# subagent is pinned to this model. Defaults to the persona's own deepseek
# default; override per-run to point at whatever cheap/fast model is configured.
SOURCING_MODEL = ((args or {}).get("sourcing_model") or "").strip() or None
try:
    MAX_FUNCTIONS = int((args or {}).get("max_functions") or 400)
except (TypeError, ValueError):
    MAX_FUNCTIONS = 400

# ---- Structured contracts between the stages -------------------------------

TRIAGE = {
    "type": "object",
    "properties": {
        "so_path": {"type": "string"},
        "detected_components": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"name": {"type": "string"},
                               "category": {"type": "string"},
                               "source_url": {"type": "string"}},
                "required": ["name", "source_url"],
            },
        },
        "library_function_count": {"type": "integer"},
        "custom_function_count": {"type": "integer"},
        "batches": {"type": "array", "items": {"type": "array", "items": {"type": "string"}}},
        "truncated": {"type": "boolean"},
        "dropped": {"type": "integer"},
        "notes": {"type": "string"},
    },
    "required": ["so_path", "batches", "custom_function_count"],
}

BATCH_RESULT = {
    "type": "object",
    "properties": {
        "file": {"type": "string"},
        "reconstructed": {"type": "integer"},
        "skipped_library": {"type": "integer"},
        "unrecoverable": {"type": "integer"},
        "glossary_additions": {"type": "array", "items": {"type": "string"}},
        "notes": {"type": "string"},
    },
    "required": ["file", "reconstructed"],
}

ASSEMBLED = {
    "type": "object",
    "properties": {"report_file": {"type": "string"}, "summary": {"type": "string"}},
    "required": ["report_file"],
}

# ---- Phase 1: Triage — inspect and partition -------------------------------

phase("Triage")
if not SO and not APK:
    log("no .so or apk given — nothing to reconstruct")
    return {"error": "Provide either `so` (a .so path) or `apk` (an APK to extract from)."}

target_desc = f"the .so at {SO}" if SO else f"the {ARCH} .so inside {APK}"
plan = agent(
    f"Triage {target_desc} for source reconstruction. "
    + (f"Extract the {ARCH} .so from the APK {APK} first. " if not SO else "")
    + "Call identify_native_components to detect the statically-linked open-source libraries, then "
      f"partition_native_functions(batch_size=12, max_functions={MAX_FUNCTIONS}) to split the functions "
      "into library (skip) vs custom (reconstruct) batches. Report the exact partition.",
    agent_type="native-triage", scope=["reconstructed/", "lib/"],
    label="triage", phase="Triage", schema=TRIAGE,
)
if not plan or not plan.get("so_path"):
    return {"error": "triage failed — could not inspect the binary. Confirm the .so path / APK and ABI, "
                     "then re-run.", "triage": plan}

so_path = plan["so_path"]
batches = plan.get("batches") or []
detected = plan.get("detected_components") or []
lib_count = plan.get("library_function_count", 0)
custom_count = plan.get("custom_function_count", len(batches) and sum(len(b) for b in batches))

log(f"{so_path}: {len(detected)} OSS component(s) detected, {lib_count} library fn skipped, "
    f"{custom_count} custom fn in {len(batches)} batch(es)"
    + (f" (TRUNCATED, {plan.get('dropped', 0)} dropped)" if plan.get("truncated") else ""))

if not batches:
    # Nothing custom to source — the binary is (as far as we can tell) all
    # attributable library code. That is a legitimate, useful result.
    log("no custom functions to reconstruct — binary appears to be entirely detected library code")
    report = agent(
        f"Write reconstructed/RECONSTRUCTION_REPORT.md for {so_path}. No custom functions were found — "
        f"the binary matched only known open-source components. List each detected component and its "
        f"upstream source_url so a reader can obtain the real source. Detected: {detected}.",
        agent_type="native-triage", scope=["reconstructed/RECONSTRUCTION_REPORT.md"],
        label="report", phase="Assemble", schema=ASSEMBLED,
    )
    return {"so_path": so_path, "detected_components": detected,
            "custom_functions": 0, "report": report}

so_base = so_path.replace("\\", "/").rsplit("/", 1)[-1]

# ---- Phase 2: Source — one subagent per batch, fresh context, cheap model ---
# pipeline (not a barrier): batch 1's source files land while batch 3 is still
# decompiling. Each writer is scoped to its OWN file stem so ScopedWorkspaceLock
# lets them run concurrently. The binary is never held in the orchestrator's
# context — every reconstruction lands on disk under reconstructed/custom/.

def source_batch(fn_names, _orig, idx):
    n = idx + 1
    stem = f"reconstructed/custom/{so_base}__batch_{n}"
    listing = ", ".join(fn_names)
    return agent(
        f"Reconstruct C/C++ source for these custom functions in {so_path} (batch {n}): {listing}. "
        f"Decompile each with ghidra_decompile, rewrite the pseudocode into readable, named, typed source, "
        f"and write the result to {stem}.c (use .cpp if it is clearly C++). Skip any that turn out to be "
        f"library code; flag any you cannot recover. Detected libraries (do not reconstruct these): "
        f"{[d['name'] for d in detected]}.",
        agent_type="source-reconstructor", scope=[stem],
        model=SOURCING_MODEL, label=f"source:batch_{n}", phase="Source",
        schema=BATCH_RESULT,
    )

phase("Source")
results = pipeline(batches, source_batch)

done = [r for r in results if r]
total_reconstructed = sum(r.get("reconstructed", 0) for r in done)
files = [r.get("file") for r in done if r.get("file")]
glossary = sorted({g for r in done for g in (r.get("glossary_additions") or [])})
failed_batches = len(batches) - len(done)
log(f"sourced {total_reconstructed} function(s) into {len(files)} file(s)"
    + (f"; {failed_batches} batch(es) failed" if failed_batches else ""))

# ---- Phase 3: Assemble — write the report + source-map -----------------------

phase("Assemble")
report = agent(
    "Write reconstructed/RECONSTRUCTION_REPORT.md summarizing this native source reconstruction. Include: "
    f"(1) the source .so ({so_path})" + (f" extracted from {APK}" if APK else "") + "; "
    f"(2) a THIRD-PARTY section listing each detected open-source component with its upstream source_url so "
    f"those parts can be obtained rather than reconstructed: {detected}; "
    f"(3) a CUSTOM section listing the reconstructed source files under reconstructed/custom/ "
    f"({len(files)} file(s), {total_reconstructed} function(s)): {files}; "
    f"(4) a shared glossary of recovered types/symbols: {glossary}; "
    f"(5) honest caveats — {failed_batches} batch(es) failed"
    + (f", and {plan.get('dropped', 0)} custom function(s) were dropped past the max_functions cap"
       if plan.get("truncated") else "") + ". "
    "Do not overstate confidence; this is decompiler-derived reconstruction.",
    agent_type="native-triage", scope=["reconstructed/RECONSTRUCTION_REPORT.md"],
    label="report", phase="Assemble", schema=ASSEMBLED,
)

return {
    "so_path": so_path,
    "detected_components": detected,
    "library_functions_skipped": lib_count,
    "custom_functions": custom_count,
    "reconstructed_functions": total_reconstructed,
    "source_files": files,
    "failed_batches": failed_batches,
    "truncated": bool(plan.get("truncated")),
    "dropped_custom_functions": plan.get("dropped", 0),
    "glossary": glossary,
    "report": report,
}
