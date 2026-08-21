meta = {
    "name": "migrate",
    "description": "Find every site needing a change, edit each one in its own scope, then verify.",
    "when_to_use": "A mechanical change across many files.",
    "phases": [{"title": "Discover"}, {"title": "Edit"}, {"title": "Verify"}],
    "args_schema": {
        "description": {"label": "The change to apply", "required": True,
                        "placeholder": "rename foo to bar"},
        "sites": {"label": "Files to change (JSON list, optional)",
                  "required": False, "placeholder": '["src/a.py"]'},
    },
}

CHANGE = (args or {}).get("description") or "the requested change"
GIVEN = (args or {}).get("sites") or []

SITES = {
    "type": "object",
    "properties": {"sites": {"type": "array", "items": {"type": "string"}}},
    "required": ["sites"],
}

CHECK = {
    "type": "object",
    "properties": {"applied": {"type": "boolean"}, "detail": {"type": "string"}},
    "required": ["applied", "detail"],
}

if GIVEN:
    sites = GIVEN
    log(f"{len(sites)} site(s) supplied")
else:
    phase("Discover")
    found = agent(f"Find every file that needs this change: {CHANGE}. Return only "
                  f"paths you have confirmed contain the pattern.",
                  label="discover", phase="Discover", schema=SITES)
    sites = (found or {}).get("sites", [])
    log(f"discovered {len(sites)} site(s)")


def edit(site, _orig, _i):
    # scope= is MANDATORY for a writer inside a workflow. It is what lets these
    # edits run concurrently: ScopedWorkspaceLock serializes only overlapping
    # owners, so disjoint files genuinely proceed at the same time.
    return agent(f"Apply this change to {site} and nothing else: {CHANGE}",
                 agent_type="implementer", scope=[site],
                 label=f"edit:{site}", phase="Edit")


def verify(edited, site, _i):
    if edited is None:
        return None
    return agent(f"Check that this change was correctly applied to {site}: {CHANGE}. "
                 f"Report applied=false if anything is wrong or incomplete.",
                 label=f"verify:{site}", phase="Verify", schema=CHECK)


results = pipeline(sites, edit, verify)

applied = [s for s, r in zip(sites, results) if r and r["applied"]]
failed = [s for s, r in zip(sites, results) if not (r and r["applied"])]
log(f"{len(applied)} applied, {len(failed)} failed")
return {"applied": applied, "failed": failed}
