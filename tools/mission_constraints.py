"""Mission-scoped build constraints: declaration, echo, and retry accounting.

The agent declares what the user asked for; the gate in recompile_apk checks
it. Declaration is explicit and echoed because translating natural language
into assertions is the step most likely to misread the user."""
from tool_registry import registry
from tools import constraints as _c

MAX_CONSTRAINT_RETRIES = 3

_DECLARED = []
_ATTEMPTS = {"failed": 0}


def get_mission_constraints():
    """The constraints declared for the current mission."""
    return list(_DECLARED)


def reset_mission_constraints():
    """Clear declarations and retry accounting. Called at session start."""
    _DECLARED.clear()
    _ATTEMPTS["failed"] = 0


@registry.register(
    name="declare_constraints",
    description=(
        "Record the build constraints the user stated for this mission, as a "
        "machine-checked list. Call this ONCE at mission start, before "
        "modifying anything, whenever the user said anything about what the "
        "built artifact must or must not contain. The declared list is echoed "
        "to the user for confirmation and is verified automatically against "
        "the finished APK — a violation fails the build instead of shipping."),
    params_schema={
        "constraints": ("array of objects, each {\"kind\": string, "
                        "\"pattern\": string}. kind is one of: "
                        "file_present, file_absent, no_new_files_matching, "
                        "file_set_unchanged, file_unmodified. pattern is an "
                        "fnmatch glob over APK member names, where * also "
                        "matches '/' (use '*.so', not 'lib/**/*.so')."),
    },
    output=("A confirmation echoing the compiled constraint list, or an error "
            "naming the invalid entry."),
    when_to_use=(
        "At mission start, whenever the user stated a requirement about the "
        "output artifact (\"it must contain X\", \"do not add a new Y\", "
        "\"leave Z untouched\"). Declaring nothing means nothing is checked."),
)
def declare_constraints(constraints):
    """Validate and store the mission's constraints, returning an echo."""
    if constraints is None:
        constraints = []
    if not isinstance(constraints, list):
        return {"error": "declare_constraints expects a list of "
                         "{kind, pattern} objects."}
    cleaned = []
    for i, c in enumerate(constraints):
        if not isinstance(c, dict):
            return {"error": f"entry {i} is not an object: {c!r}"}
        kind = c.get("kind")
        pattern = c.get("pattern")
        if kind not in _c.KINDS:
            return {"error": f"entry {i} has unknown kind {kind!r}; "
                             f"expected one of {_c.KINDS}"}
        if not isinstance(pattern, str) or not pattern:
            return {"error": f"entry {i} ({kind}) needs a non-empty "
                             f"string 'pattern'."}
        cleaned.append({"kind": kind, "pattern": pattern})

    _DECLARED.clear()
    _DECLARED.extend(cleaned)
    _ATTEMPTS["failed"] = 0

    if not cleaned:
        return {"message": "No constraints declared; the build will not be "
                           "constraint-checked."}
    lines = [f"  - {c['kind']}({c['pattern']!r})" for c in cleaned]
    return {"message": "Constraints recorded for this mission:\n"
                       + "\n".join(lines)
                       + "\n\nThe finished APK will be verified against these."}
