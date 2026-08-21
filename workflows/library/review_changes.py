meta = {
    "name": "review-changes",
    "description": "Review a diff across independent dimensions, then adversarially verify every finding.",
    "when_to_use": "Reviewing a change set for bugs.",
    "phases": [{"title": "Review"}, {"title": "Verify"}],
    "args_schema": {"target": {"label": "Git ref or path to review",
                               "required": False, "placeholder": "HEAD"}},
}

TARGET = (args or {}).get("target", "the current working-tree changes")

FINDINGS = {
    "type": "object",
    "properties": {
        "findings": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "file": {"type": "string"},
                    "detail": {"type": "string"},
                },
                "required": ["title", "file", "detail"],
            },
        }
    },
    "required": ["findings"],
}

VERDICT = {
    "type": "object",
    "properties": {
        "real": {"type": "boolean"},
        "reason": {"type": "string"},
    },
    "required": ["real", "reason"],
}

DIMENSIONS = [
    {"key": "correctness", "ask": "correctness bugs: wrong logic, off-by-one, bad error handling"},
    {"key": "security", "ask": "security problems: injection, unsafe deserialization, leaked secrets"},
    {"key": "regression", "ask": "behaviour this change breaks for existing callers"},
]


def find(dim, _orig, _i):
    return agent(
        f"Review {TARGET} for {dim['ask']}. Report only defects you can point at "
        f"in the diff, with the file and a concrete failure.",
        label=f"review:{dim['key']}", phase="Review", schema=FINDINGS)


def verify(review, dim, _i):
    if not review:
        return []
    checks = []
    for f in review["findings"]:
        def one(f=f):
            v = agent(
                f"Try to REFUTE this claimed defect in {f['file']}: {f['title']} — "
                f"{f['detail']}. Default to real=false if you are uncertain.",
                label=f"verify:{f['file']}", phase="Verify", schema=VERDICT)
            return dict(f, verdict=v, dimension=dim["key"]) if v else None
        checks.append(one)
    return parallel(checks)


results = pipeline(DIMENSIONS, find, verify)

confirmed = []
for group in results:
    for item in (group or []):
        if item and item["verdict"]["real"]:
            confirmed.append(item)

log(f"{len(confirmed)} confirmed finding(s)")
return {"confirmed": confirmed}
