"""OpenAI function-calling schema generation for the tool registry.

Schemas are derived from LIVE function signatures (the signature IS the schema,
same principle as ToolRegistry._validate_args) and cached in-memory keyed by a
content hash of the signature + params text — a changed tool auto-invalidates, so
no stale schema is ever served after a code change.
"""
import hashlib
import inspect
import json
import re

from tool_registry import registry, CORE_GROUP

FINAL_ANSWER_TOOL = "final_answer"

_CACHE = {}  # name -> (fingerprint, schema)

# Minimal annotation -> JSON type mapping; unknown/absent annotations default to
# "string" (the model still passes structured values; execute() validates names).
_TYPE_MAP = {str: "string", int: "integer", float: "number", bool: "boolean",
             dict: "object", list: "array"}


def _fingerprint(name, func, params, description=""):
    try:
        sig = str(inspect.signature(func))
    except (TypeError, ValueError):
        sig = ""
    # `description` is included so a tool whose description is a callable (built
    # fresh at render time — e.g. dispatch_agents' live model-ladder hint) still
    # auto-invalidates the cache when the rendered text changes, same as a code
    # change to the signature/params does.
    return hashlib.sha256(
        (name + "|" + sig + "|" + json.dumps(params, sort_keys=True) + "|" + description).encode()
    ).hexdigest()


def _json_type(annotation):
    return _TYPE_MAP.get(annotation, "string")


# The registry's params_schema descriptions follow a "<type> (...)" convention
# (e.g. "array of strings (...)", "integer (...)", "boolean (...)"). Tool functions
# rarely carry real annotations, so we derive the JSON type from that leading word
# — otherwise every param defaults to "string" and a native-function-calling model
# passes arrays/objects in the wrong shape (e.g. plan_create's `phases`).
_DESC_TYPE_RE = re.compile(r"^\s*(array|object|integer|number|boolean|string|dict|list|bool|int|float)\b",
                           re.IGNORECASE)


def _prop_from_desc(annotation, desc):
    """Build the JSON-schema property for one param: prefer a real annotation, else
    infer the type from the leading word of the description. Arrays get an `items`
    schema ('array of strings' -> string items; a bare 'array' -> permissive)."""
    # A real annotation wins when present.
    if annotation is not None and annotation in _TYPE_MAP:
        jtype = _TYPE_MAP[annotation]
    else:
        m = _DESC_TYPE_RE.match(desc or "")
        word = (m.group(1).lower() if m else "string")
        jtype = {"array": "array", "list": "array", "object": "object", "dict": "object",
                 "integer": "integer", "int": "integer", "number": "number",
                 "float": "number", "boolean": "boolean", "bool": "boolean"}.get(word, "string")
    prop = {"type": jtype}
    if jtype == "array":
        # "array of strings/objects/..." pins the item type; a bare "array" (items
        # may be strings OR objects, as in plan_create's `steps`) stays permissive.
        mi = re.search(r"array of (\w+)", desc or "", re.IGNORECASE)
        if mi:
            item_word = mi.group(1).rstrip("s").lower()  # "strings" -> "string"
            prop["items"] = {"type": {"string": "string", "object": "object",
                                      "integer": "integer", "number": "number",
                                      "boolean": "boolean"}.get(item_word, "string")}
        else:
            prop["items"] = {}  # permissive: string or object element allowed
    return prop


def build_openai_schema(name):
    """The OpenAI `tools` entry for one registered tool, from its live signature."""
    data = registry._tools[name]
    func, params_text = data["func"], data.get("params") or {}
    description = registry._resolve_description(data)
    fp = _fingerprint(name, func, params_text, description)
    cached = _CACHE.get(name)
    if cached and cached[0] == fp:
        return cached[1]

    properties, required = {}, []
    try:
        sig_params = inspect.signature(func).parameters
    except (TypeError, ValueError):
        sig_params = {}
    for pname, p in sig_params.items():
        if p.kind in (p.VAR_KEYWORD, p.VAR_POSITIONAL):
            continue
        desc = params_text.get(pname)
        annotation = p.annotation if p.annotation is not p.empty else None
        prop = _prop_from_desc(annotation, str(desc) if desc else "")
        if desc:
            prop["description"] = str(desc)
        properties[pname] = prop
        if p.default is p.empty:
            required.append(pname)

    schema = {
        "type": "function",
        "function": {
            "name": name,
            "description": (description or "").strip(),
            "parameters": {"type": "object", "properties": properties, "required": required},
        },
    }
    _CACHE[name] = (fp, schema)
    return schema


def _final_answer_schema():
    return {
        "type": "function",
        "function": {
            "name": FINAL_ANSWER_TOOL,
            "description": "Deliver the final answer and end the task. Use ONLY when done.",
            "parameters": {
                "type": "object",
                "properties": {"content": {"type": "string", "description": "The final answer text."}},
                "required": ["content"],
            },
        },
    }


# Optional narration arg offered on every real tool (NOT final_answer) so the
# per-call "explanation" mechanism works over the native interface too. It's
# lifted out of args and stripped before the tool runs (see _openai_request), so
# the underlying function never receives it.
_NARRATION_PROP = {
    "type": "string",
    "description": "Optional: a one-sentence, first-person note when you START a new sub-step (narrates the chat).",
}


def _with_narration(schema):
    """A copy of `schema` with the optional `explanation` arg added, without
    mutating the cached base schema."""
    fn = schema["function"]
    params = fn["parameters"]
    props = dict(params.get("properties") or {})
    props["explanation"] = _NARRATION_PROP
    return {
        "type": "function",
        "function": {
            "name": fn["name"],
            "description": fn["description"],
            "parameters": {"type": "object", "properties": props,
                           "required": params.get("required", [])},
        },
    }


def openai_tools_for(active_groups):
    """Build the per-turn `tools=` array: core + active-group tools (progressive
    disclosure preserved — NOT all tools), plus expand_tools and final_answer.
    Every real tool also carries an optional `explanation` narration arg.
    active_groups=None means every registered tool (legacy/isolated callers)."""
    names = []
    for name in registry._tools:
        grp = registry.group_of(name)
        if active_groups is None or grp == CORE_GROUP or grp in active_groups:
            names.append(name)
    tools = [_with_narration(build_openai_schema(n)) for n in names]
    if not any(t["function"]["name"] == FINAL_ANSWER_TOOL for t in tools):
        tools.append(_final_answer_schema())
    return tools
