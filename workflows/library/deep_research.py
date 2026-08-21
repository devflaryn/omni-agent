meta = {
    "name": "deep-research",
    "description": "Sweep a question from several angles, read the best leads deeply, synthesize, then ask what is missing.",
    "when_to_use": "An open question needing broad coverage. args: {\"question\": \"...\"}",
    "phases": [{"title": "Sweep"}, {"title": "Read"}, {"title": "Synthesize"}, {"title": "Critique"}],
    "args_schema": {"question": {"label": "Question to research",
                                 "required": True, "placeholder": "how does X work"}},
}

QUESTION = (args or {}).get("question") or "the current task"

LEADS = {
    "type": "object",
    "properties": {
        "leads": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"where": {"type": "string"},
                               "why": {"type": "string"}},
                "required": ["where", "why"],
            },
        }
    },
    "required": ["leads"],
}

# Each angle is blind to what the others surface — that is the point.
ANGLES = [
    "by name: search for the identifiers and symbols the question implies",
    "by behaviour: find where the described behaviour is actually produced",
    "by configuration: find the settings, flags and env vars that affect it",
    "by history: find tests, docs and comments that explain it",
]

phase("Sweep")
swept = parallel([
    (lambda a=a: agent(f"Investigate '{QUESTION}' {a}. Return the concrete places "
                       f"worth reading in full.",
                       label=f"sweep:{a.split(':')[0]}", phase="Sweep", schema=LEADS))
    for a in ANGLES
])

leads = []
seen = set()
for s in swept:
    for lead in (s or {}).get("leads", []):
        if lead["where"] not in seen:
            seen.add(lead["where"])
            leads.append(lead)

log(f"{len(leads)} distinct lead(s) to read")

phase("Read")
readings = parallel([
    (lambda l=l: agent(f"Read {l['where']} closely and answer: {QUESTION}. "
                       f"It was flagged because: {l['why']}",
                       label=f"read:{l['where']}", phase="Read"))
    for l in leads[:24]
])
if len(leads) > 24:
    log(f"read the first 24 of {len(leads)} leads")

phase("Synthesize")
answer = agent("Answer this question from the readings below. Cite where each "
               "claim comes from. Say plainly what remains unknown.\n\n"
               f"QUESTION: {QUESTION}\n\nREADINGS:\n"
               + "\n\n".join(str(r) for r in readings if r),
               label="synthesize", phase="Synthesize")

phase("Critique")
gaps = agent("Here is a research answer. What is MISSING — an angle never "
             "searched, a claim never verified, a source never read? List only "
             "gaps, not praise.\n\n" + str(answer),
             label="completeness-critic", phase="Critique")

return {"answer": answer, "gaps": gaps, "leads_read": len(readings)}
