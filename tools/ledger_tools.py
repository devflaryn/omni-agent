"""Build-ledger tools — let the agent (and subagents) record the PHYSICAL build
of a large modification: components planned vs done, files produced, binary
offsets patched, and verifications run.

These are the write surface for ledger.py's active BuildLedger (a module-level
singleton, same design as investigation.py's active Investigation). agent.py
wires up ledger.set_context(...) once per session so these autosave to the right
memory dir and push a live update to the GUI + system prompt.

Why this is separate from investigation memory: investigation records the
*reasoning* (evidence, hypotheses, decisions); the ledger records the *physical
build accounting* — the numbers that answer "how much of the 10 MB / N
components is actually done, and what's left" across dozens of context resets on
a many-hour, many-subagent build. Record here every time you produce a file,
patch a binary, finish a component, or run a check.
"""
from tool_registry import registry
import ledger


def _view():
    lg = ledger.get_active()
    if lg is None or lg.is_empty():
        return "Build ledger is empty."
    return lg.to_markdown()


@registry.register(
    name="ledger_add_component",
    description=(
        "Registers a planned build unit (component) in the build ledger — a bounded worklist item for a "
        "large modification, e.g. 'libluau.so native VM', 'com.omni.luau smali bridge', 'bytecode "
        "compiler', 'JNI glue'. Do this FIRST for a big multi-artifact change: enumerate the components so "
        "the ledger can track completion as numbers (X of N done) across context resets. Re-adding the same "
        "name updates it (deduped) rather than piling up."
    ),
    params_schema={
        "name": "string (the component name — stable, used as the dedupe key)",
        "status": "string (optional: planned|in_progress|done|blocked — default planned)",
        "owner": "string (optional — who is building it, e.g. 'main' or a subagent name)",
        "note": "string (optional — scope/detail, e.g. '40 smali classes')",
    },
    output="A confirmation plus the current build-ledger view.",
    when_to_use="Call this to enumerate the pieces of a large build before you start, so progress is tracked. For a small surgical change you don't need the ledger.",
)
def ledger_add_component(name, status="planned", owner="", note=""):
    name = (name or "").strip()
    if not name:
        return {"error": "ledger_add_component requires a non-empty 'name'."}
    lg = ledger.ensure_active()
    lg.add_component(name, status=status, owner=owner, note=note)
    ledger.notify_updated()
    return {"stdout": "Component recorded.\n\n" + lg.to_markdown()}


@registry.register(
    name="ledger_set_component_status",
    description=(
        "Updates a component's status in the build ledger (planned|in_progress|done|blocked). Creates the "
        "component if it doesn't exist yet, so you never have to add-before-set. Marking a component 'done' "
        "is what advances the ledger's completion percentage — the signal that survives summarization and "
        "tells you (and any resumed session) how much of the build remains."
    ),
    params_schema={
        "name": "string (the component name)",
        "status": "string (planned|in_progress|done|blocked)",
        "note": "string (optional — e.g. why blocked, or '18/40 classes done')",
        "bytes": "integer (optional — size produced so far, for the MB accounting)",
    },
    output="A confirmation plus the current build-ledger view.",
    when_to_use="Call this when you START a component (in_progress), FINISH it (done), or hit a wall (blocked).",
)
def ledger_set_component_status(name, status="planned", note="", bytes=None):
    name = (name or "").strip()
    if not name:
        return {"error": "ledger_set_component_status requires a non-empty 'name'."}
    lg = ledger.ensure_active()
    lg.set_component_status(name, status, note=note, bytes=bytes)
    ledger.notify_updated()
    return {"stdout": "Component status updated.\n\n" + lg.to_markdown()}


@registry.register(
    name="ledger_record_artifact",
    description=(
        "Records a file you actually produced (created/generated/assembled) into the build ledger, with its "
        "size — so the ledger accounts for the physical bytes and files of the build (the MB total) and you "
        "never lose track of what exists on disk after a context reset. Re-recording the same path updates "
        "its size/sha in place."
    ),
    params_schema={
        "path": "string (the file path produced, relative to the workspace)",
        "kind": "string (optional — e.g. smali|dex|so|asset|script|config — default 'file')",
        "bytes": "integer (optional — the file size in bytes)",
        "sha": "string (optional — a short content hash for change detection)",
        "note": "string (optional — what it is / which component it belongs to)",
    },
    output="A confirmation plus the current build-ledger view.",
    when_to_use="Call this right after you write/assemble a build output file (a smali family, a compiled dex, a native lib, a large asset). For tiny throwaway files you don't need to.",
)
def ledger_record_artifact(path, kind="file", bytes=0, sha="", note=""):
    path = (path or "").strip()
    if not path:
        return {"error": "ledger_record_artifact requires a non-empty 'path'."}
    lg = ledger.ensure_active()
    lg.record_artifact(path, kind=kind, bytes=bytes, sha=sha, note=note)
    ledger.notify_updated()
    return {"stdout": "Artifact recorded.\n\n" + lg.to_markdown()}


@registry.register(
    name="ledger_record_patch",
    description=(
        "Records a binary/offset patch you applied (target file, offset, before→after bytes, purpose) into "
        "the build ledger, keyed by target@offset. This is how you answer, cheaply and reliably across "
        "context resets, 'did I already patch this offset?' — instead of re-diffing a 100 MB library. "
        "Re-recording the same target@offset updates it in place."
    ),
    params_schema={
        "target": "string (the binary being patched, e.g. lib/arm64-v8a/libzstd-jni.so)",
        "offset": "string (the offset, e.g. 0x023826ec)",
        "before": "string (optional — the original bytes, e.g. 'cb 22 00 94')",
        "after": "string (optional — the new bytes, e.g. '00 00 80 52')",
        "purpose": "string (optional — why, e.g. 'neutralize anti-tamper bl')",
    },
    output="A confirmation plus the current build-ledger view.",
    when_to_use="Call this every time you patch bytes in a binary (patch_bytes_at_offset / binary_patch), so the offset ledger stays authoritative.",
)
def ledger_record_patch(target, offset, before="", after="", purpose=""):
    target = (target or "").strip()
    if not target or offset in (None, ""):
        return {"error": "ledger_record_patch requires 'target' and 'offset'."}
    lg = ledger.ensure_active()
    lg.record_patch(target, offset, before=before, after=after, purpose=purpose)
    ledger.notify_updated()
    return {"stdout": "Patch recorded.\n\n" + lg.to_markdown()}


@registry.register(
    name="ledger_record_verification",
    description=(
        "Records the outcome of a verification/check against the build (pass|fail|unknown) into the build "
        "ledger — e.g. 'app boots without crash', 'game engine starts', 'overlay visible 10s', 'apk "
        "signature valid'. Failing verifications show up in the ledger's OPEN/REMAINING list so they are "
        "never lost across a context reset."
    ),
    params_schema={
        "name": "string (the check, e.g. 'boot without crash')",
        "outcome": "string (pass|fail|unknown)",
        "details": "string (optional — evidence, e.g. a logcat line or screenshot path)",
    },
    output="A confirmation plus the current build-ledger view.",
    when_to_use="Call this after you run a check (emulator boot, screenshot, signature verify, smoke test). A FAIL keeps the item on the remaining-work list.",
)
def ledger_record_verification(name, outcome="unknown", details=""):
    name = (name or "").strip()
    if not name:
        return {"error": "ledger_record_verification requires a non-empty 'name'."}
    lg = ledger.ensure_active()
    lg.record_verification(name, outcome=outcome, details=details)
    ledger.notify_updated()
    return {"stdout": "Verification recorded.\n\n" + lg.to_markdown()}


@registry.register(
    name="ledger_status",
    description=(
        "Returns the current build-ledger view: aggregate progress (components done / total, percent, "
        "artifact count + total MB, patches applied, verify pass/fail) plus the OPEN/REMAINING worklist. "
        "The cheap way to answer 'where am I on this build / what's left' without re-reading files — "
        "especially right after a context reset or when a subagent hands work back."
    ),
    params_schema={},
    output="The compact build-ledger markdown, or a note that it's empty.",
    when_to_use="Call this to orient on a resumed/large build before deciding the next step. It never mutates anything.",
)
def ledger_status():
    return {"stdout": _view()}
