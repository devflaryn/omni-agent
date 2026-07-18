"""Meta tools — let the model manage its own tool context.

Progressive tool disclosure (see tool_registry.py) keeps the base prompt small
by showing on-demand toolsets as a one-line catalog. `expand_tools` lets the
model deliberately pull a whole toolset's full parameter schemas into context
before it starts a chunk of domain work, instead of discovering params via a
failed call. Calling any tool in a toolset ALSO auto-expands it (handled in
agent.py) — this tool is the explicit, proactive path.

The agent loop watches for a successful expand_tools call and adds the group to
the session's active toolset set so the full schemas persist on later turns; the
stdout returned here also surfaces them immediately on THIS turn.
"""
from tool_registry import registry, GROUP_LABELS, CORE_GROUP


@registry.register(
    name="expand_tools",
    description=(
        "Reveal the FULL parameter schemas for an on-demand toolset (or a single tool) shown only as a "
        "one-line catalog entry. Use it right before a chunk of domain work — e.g. expand_tools(\"native\") "
        "before native .so patching, expand_tools(\"emulator\") before installing/launching/testing on the "
        "emulator — so you see every tool's exact params and pick the best one instead of guessing. You do "
        "NOT strictly need this (calling any catalog tool works and auto-expands its toolset), but expanding "
        "first leads to cleverer tool choices. Toolsets: apk, smali, native, emulator, frida."
    ),
    params_schema={
        "group": "string — a toolset name (apk | smali | native | emulator | frida) to reveal all of its tools, OR a single tool name to reveal just that one.",
    },
    output="The full ### name / description / When / Params / Output block(s) for the requested toolset or tool. Those schemas then stay visible on subsequent turns for this session.",
    when_to_use="Before starting APK/native/emulator/frida work, to load that toolset's exact params up front. Not needed for core tools (already fully shown).",
    summary="reveal full params of an on-demand toolset (apk|smali|native|emulator|frida) before using it",
)
def expand_tools(group):
    key = (group or "").strip()
    if not key:
        return {"error": "expand_tools needs a 'group' (a toolset name like 'native', or a single tool name)."}

    # A specific tool name?
    if key in registry._tools:
        block = registry.full_tool_block(key)
        return {"stdout": f"Full schema for tool '{key}':\n{block}", "_expanded_group": registry.group_of(key)}

    # A toolset name?
    known = registry.domain_groups()
    if key in known:
        block = registry.group_full_blocks(key)
        label = GROUP_LABELS.get(key, key)
        return {"stdout": f"Toolset [{key}] — {label}. Full schemas:\n{block}", "_expanded_group": key}

    if key == CORE_GROUP:
        return {"stdout": "The 'core' toolset is always shown in full — nothing to expand."}

    return {"error": (
        f"Unknown toolset/tool '{key}'. On-demand toolsets are: {', '.join(known)}. "
        "Or pass an exact tool name to reveal just that one."
    )}
