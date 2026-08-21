meta = {
    "name": "exhaustive-audit",
    "description": "Keep hunting for problems until two consecutive rounds find nothing new, judging each by several distinct lenses.",
    "when_to_use": "A thorough audit where the number of issues is unknown. args: {\"target\": \"src/\"}",
    "phases": [{"title": "Find"}, {"title": "Judge"}],
}

TARGET = (args or {}).get("target") or "."
MAX_ROUNDS = 6

ISSUES = {
    "type": "object",
    "properties": {
        "issues": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"id": {"type": "string"},
                               "where": {"type": "string"},
                               "detail": {"type": "string"}},
                "required": ["id", "where", "detail"],
            },
        }
    },
    "required": ["issues"],
}

VERDICT = {
    "type": "object",
    "properties": {"real": {"type": "boolean"}, "reason": {"type": "string"}},
    "required": ["real", "reason"],
}

FINDERS = ["error handling and failure paths",
           "concurrency, ordering and shared state",
           "input validation and boundary conditions",
           "resource lifetime: files, sockets, locks, memory"]

LENSES = ["correctness", "security", "does-it-actually-reproduce"]

seen = set()
confirmed = []
dry_rounds = 0
round_no = 0

while dry_rounds < 2 and round_no < MAX_ROUNDS:
    round_no += 1
    phase("Find")
    found = parallel([
        (lambda f=f, r=round_no: agent(
            f"Audit {TARGET} for problems in {f}. Round {r}: do NOT repeat "
            f"issues already reported; look somewhere new.",
            label=f"find:{f[:18]}", phase="Find", schema=ISSUES))
        for f in FINDERS
    ])

    fresh = []
    for batch in found:
        for issue in (batch or {}).get("issues", []):
            k = issue["where"] + "::" + issue["id"]
            # Dedup against EVERYTHING seen, not against `confirmed` — deduping
            # against confirmed lets judge-rejected issues reappear every round
            # and the loop never converges.
            if k not in seen:
                seen.add(k)
                fresh.append(issue)

    if not fresh:
        dry_rounds += 1
        log(f"round {round_no}: nothing new ({dry_rounds}/2 dry)")
        continue

    dry_rounds = 0
    log(f"round {round_no}: {len(fresh)} new issue(s) to judge")

    phase("Judge")
    def judge(issue, _orig, _i):
        votes = parallel([
            (lambda lens=lens: agent(
                f"Judge this claimed issue through the {lens} lens — is it real? "
                f"{issue['where']}: {issue['detail']}",
                label=f"judge:{lens}", phase="Judge", schema=VERDICT))
            for lens in LENSES
        ])
        real = len([v for v in votes if v and v["real"]])
        return dict(issue, votes=real) if real >= 2 else None

    for kept in pipeline(fresh, judge):
        if kept:
            confirmed.append(kept)

log(f"{len(confirmed)} confirmed after {round_no} round(s)")
return {"confirmed": confirmed, "rounds": round_no, "considered": len(seen)}
