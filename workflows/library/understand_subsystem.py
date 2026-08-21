meta = {
    "name": "understand-subsystem",
    "description": "Read several parts of the codebase in parallel and return one structured map.",
    "when_to_use": "Getting oriented in unfamiliar code. args: {\"paths\": [\"src/a\", \"src/b\"]}",
    "phases": [{"title": "Read"}, {"title": "Synthesize"}],
    "args_schema": {"paths": {"label": "Paths to read (JSON list)",
                              "required": True, "placeholder": '["src/a", "src/b"]'}},
}

PATHS = (args or {}).get("paths") or ["."]

MAP = {
    "type": "object",
    "properties": {
        "purpose": {"type": "string"},
        "entry_points": {"type": "array", "items": {"type": "string"}},
        "depends_on": {"type": "array", "items": {"type": "string"}},
        "risks": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["purpose", "entry_points", "depends_on"],
}

phase("Read")
maps = parallel([
    (lambda p=p: agent(
        f"Read {p} and describe what it is for, its entry points, what it depends "
        f"on, and anything risky or surprising in it.",
        label=f"read:{p}", phase="Read", schema=MAP))
    for p in PATHS
])

pairs = [{"path": p, "map": m} for p, m in zip(PATHS, maps) if m]

phase("Synthesize")
summary = agent(
    "Merge these subsystem maps into ONE description of how the pieces fit "
    "together. Call out conflicts explicitly. Do not invent anything the maps "
    "do not support.\n\n" + str(pairs),
    label="synthesize", phase="Synthesize")

return {"maps": pairs, "summary": summary}
