"""Learn-and-apply: the learned-technique artifact primitive.

Component 4 of the enforcement work. The agent studies a working modified APK
against its base, then records — as a STRUCTURED artifact — what it understood
BEFORE it touches the target. This is the echo-back checkpoint and the plan the
apply phase follows. Constraint derivation (auto-arming the Component 2 gate) is
added in the neighbouring function `_derive_constraints` / the record path.

Pure module: no agent.py coupling, no sandbox I/O. Durable per-project
persistence of the artifact (write_file learned_technique.json) is done by the
skill, keeping this tool offline-testable."""
from tool_registry import registry

# Live handle for the current mission's learned technique (or None). A learn
# task REPLACES it wholesale; a non-learn task never reads it, so a stale value
# is harmless and needs no session reset.
_LEARNED = {"artifact": None}

_ARTIFACT_KEYS = ("technique", "mechanism", "hook_points", "entry_point",
                  "native_additions", "asset_additions", "notes")


def get_learned_technique():
    """A copy of the current mission's learned-technique artifact, or None."""
    a = _LEARNED["artifact"]
    return dict(a) if a else None


def reset_learned_technique():
    """Clear the stored artifact (test isolation; not wired to agent.py)."""
    _LEARNED["artifact"] = None


def _validate(technique, mechanism, hook_points):
    """Return an error string if the core fields are invalid, else None."""
    if not isinstance(technique, str) or not technique.strip():
        return "record_learned_technique needs a non-empty 'technique' label."
    if not isinstance(mechanism, str) or not mechanism.strip():
        return "record_learned_technique needs a non-empty 'mechanism'."
    if not isinstance(hook_points, list) or not hook_points:
        return ("record_learned_technique needs at least one hook_point "
                "{class, method, edit}.")
    for i, hp in enumerate(hook_points):
        if not isinstance(hp, dict) or not hp.get("class") or not hp.get("method"):
            return f"hook_point {i} needs at least 'class' and 'method'."
    return None


@registry.register(
    name="record_learned_technique",
    description=(
        "Record — as a structured artifact — the modification technique you "
        "learned from a working modified APK and its base, BEFORE you edit the "
        "target. This is a mandatory checkpoint in the learn-and-apply workflow: "
        "it echoes back what you understood (so a misread is caught early), it "
        "is the plan the apply phase follows, and it auto-declares the build "
        "constraints that verify your reconstruction. Do NOT edit the target "
        "before calling this."),
    params_schema={
        "technique": "string — short label, e.g. 'SSL-pinning bypass'.",
        "mechanism": "string — how it works in one or two sentences.",
        "hook_points": ("array of objects, each {\"class\": string, "
                        "\"method\": string, \"edit\": string, \"dex\": string "
                        "optional}. At least one. class+method are how the apply "
                        "phase RELOCATES the site in the target via the code "
                        "graph (name-based, not file path)."),
        "entry_point": "string (optional) — how the hook gets installed.",
        "native_additions": ("array of strings (optional) — .so files the "
                             "technique ADDS, e.g. ['libX.so']. Empty/omitted "
                             "means it adds none."),
        "asset_additions": "array of strings (optional) — assets added.",
        "notes": "string (optional).",
    },
    output=("A confirmation echoing the recorded technique and the constraints "
            "it armed, or an error naming the missing/invalid field."),
    when_to_use=(
        "In the learn-and-apply workflow, immediately AFTER you have understood "
        "the reference technique (via diff_code_graphs / query_code_graph / "
        "jadx) and BEFORE you edit the target. Never edit the target first."),
)
def record_learned_technique(technique=None, mechanism=None, hook_points=None,
                             entry_point=None, native_additions=None,
                             asset_additions=None, notes=None):
    hook_points = hook_points or []
    err = _validate(technique, mechanism, hook_points)
    if err:
        return {"error": err}
    artifact = {
        "technique": technique.strip(),
        "mechanism": mechanism.strip(),
        "hook_points": hook_points,
        "entry_point": entry_point or "",
        "native_additions": native_additions or [],
        "asset_additions": asset_additions or [],
        "notes": notes or "",
    }
    _LEARNED["artifact"] = artifact

    lines = [f"  - {hp['class']}->{hp['method']}: {hp.get('edit', '')}"
             for hp in hook_points]
    echo = ("Learned technique recorded:\n"
            f"  technique: {artifact['technique']}\n"
            f"  mechanism: {artifact['mechanism']}\n"
            "  hook points:\n" + "\n".join(lines))
    return {"message": echo}
