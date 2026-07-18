"""OpenAI function-calling schema generation for the tool registry.

Schemas are derived from LIVE function signatures (the signature IS the schema,
same principle as ToolRegistry._validate_args) and cached in-memory keyed by a
content hash of the signature + params text — a changed tool auto-invalidates, so
no stale schema is ever served after a code change.
"""
import hashlib
import inspect
import json

from tool_registry import registry, CORE_GROUP

FINAL_ANSWER_TOOL = "final_answer"

_CACHE = {}  # name -> (fingerprint, schema)

# Minimal annotation -> JSON type mapping; unknown/absent annotations default to
# "string" (the model still passes structured values; execute() validates names).
_TYPE_MAP = {str: "string", int: "integer", float: "number", bool: "boolean",
             dict: "object", list: "array"}


def _fingerprint(name, func, params):
    try:
        sig = str(inspect.signature(func))
    except (TypeError, ValueError):
        sig = ""
    return hashlib.sha256(
        (name + "|" + sig + "|" + json.dumps(params, sort_keys=True)).encode()
    ).hexdigest()


def _json_type(annotation):
    return _TYPE_MAP.get(annotation, "string")


def build_openai_schema(name):
    """The OpenAI `tools` entry for one registered tool, from its live signature."""
    data = registry._tools[name]
    func, params_text = data["func"], data.get("params") or {}
    fp = _fingerprint(name, func, params_text)
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
        prop = {"type": _json_type(p.annotation if p.annotation is not p.empty else None)}
        desc = params_text.get(pname)
        if desc:
            prop["description"] = str(desc)
        properties[pname] = prop
        if p.default is p.empty:
            required.append(pname)

    schema = {
        "type": "function",
        "function": {
            "name": name,
            "description": (data.get("description") or "").strip(),
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


def openai_tools_for(active_groups):
    """Build the per-turn `tools=` array: core + active-group tools (progressive
    disclosure preserved — NOT all tools), plus expand_tools and final_answer.
    active_groups=None means every registered tool (legacy/isolated callers)."""
    names = []
    for name in registry._tools:
        grp = registry.group_of(name)
        if active_groups is None or grp == CORE_GROUP or grp in active_groups:
            names.append(name)
    tools = [build_openai_schema(n) for n in names]
    if not any(t["function"]["name"] == FINAL_ANSWER_TOOL for t in tools):
        tools.append(_final_answer_schema())
    return tools
