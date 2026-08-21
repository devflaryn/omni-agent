"""A deliberately small JSON-Schema subset: enough to constrain what a subagent
returns, small enough to carry no dependency.

`jsonschema` is NOT used on purpose — requirements.txt documents why a portable
lockfile is impractical for this project, and 7 pinned direct dependencies is
worth protecting. The supported keywords are exactly those the workflow library
needs: type, properties, required, items, enum, additionalProperties, minItems.

The same module both VALIDATES real returns and GENERATES dry-run stubs, so a
stub can never lie about the contract it stands in for.
"""
import json

_TYPE_CHECKS = {
    "object": lambda v: isinstance(v, dict),
    "array": lambda v: isinstance(v, list),
    "string": lambda v: isinstance(v, str),
    "number": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
    # bool is an int subclass in Python; an "integer" field must not accept True.
    "integer": lambda v: isinstance(v, int) and not isinstance(v, bool),
    "boolean": lambda v: isinstance(v, bool),
    "null": lambda v: v is None,
}


def _typename(v):
    return type(v).__name__


def validate(value, schema, path="$"):
    """Return a list of human-readable error strings; empty means valid.

    Errors name the PATH, the EXPECTATION and what was actually received, because
    they are fed back to the subagent verbatim as a repair message — a bare
    "invalid" gives it nothing to correct."""
    errors = []
    if not isinstance(schema, dict):
        return errors

    want = schema.get("type")
    if want:
        check = _TYPE_CHECKS.get(want)
        if check and not check(value):
            return [f"{path}: expected {want}, got {_typename(value)}"]

    if "enum" in schema and value not in schema["enum"]:
        allowed = ", ".join(json.dumps(e) for e in schema["enum"])
        return [f"{path}: {json.dumps(value)} is not one of [{allowed}]"]

    if isinstance(value, dict):
        props = schema.get("properties") or {}
        for req in schema.get("required") or []:
            if req not in value:
                errors.append(f"{path}: missing required property '{req}'")
        if schema.get("additionalProperties") is False:
            for key in value:
                if key not in props:
                    errors.append(f"{path}: unexpected property '{key}'")
        for key, sub in props.items():
            if key in value:
                errors.extend(validate(value[key], sub, f"{path}.{key}"))

    if isinstance(value, list):
        min_items = schema.get("minItems")
        if isinstance(min_items, int) and len(value) < min_items:
            errors.append(f"{path}: expected at least {min_items} items, got {len(value)}")
        item_schema = schema.get("items")
        if isinstance(item_schema, dict):
            for i, item in enumerate(value):
                errors.extend(validate(item, item_schema, f"{path}[{i}]"))

    return errors


def stub(schema):
    """A minimal value satisfying `schema`, used by dry-run so a script's control
    flow executes without spending a token.

    Arrays get ONE element rather than zero: an empty stub array would skip the
    very loops dry-run exists to exercise."""
    if not isinstance(schema, dict):
        return None
    if "enum" in schema and schema["enum"]:
        return schema["enum"][0]

    want = schema.get("type")
    if want == "object":
        out = {}
        props = schema.get("properties") or {}
        # Required first, then every declared property — a script commonly reads
        # optional fields, and a missing key would raise KeyError during dry-run.
        for key, sub in props.items():
            out[key] = stub(sub)
        for req in schema.get("required") or []:
            out.setdefault(req, "stub")
        return out
    if want == "array":
        item_schema = schema.get("items")
        count = max(1, int(schema.get("minItems") or 1))
        return [stub(item_schema) for _ in range(count)]
    if want == "string":
        return "stub"
    if want == "integer":
        return 1
    if want == "number":
        return 1.0
    if want == "boolean":
        return True
    if want == "null":
        return None
    return "stub"


def render_contract(schema):
    """The prompt fragment that tells a subagent what shape to return. Appended
    to its system prompt by subagents._build_messages."""
    return (
        "STRUCTURED OUTPUT REQUIRED.\n"
        "Your final_answer's \"content\" MUST be a JSON value matching this schema "
        "exactly. Do not wrap it in prose, markdown fences, or explanation:\n"
        + json.dumps(schema, indent=2)
    )
