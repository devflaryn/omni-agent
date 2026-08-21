meta = {
    "name": "design-panel",
    "description": "Generate several independent approaches, score them with independent judges, synthesize the winner.",
    "when_to_use": "An open design question with a wide solution space. args: {\"problem\": \"...\"}",
    "phases": [{"title": "Propose"}, {"title": "Judge"}, {"title": "Synthesize"}],
    "args_schema": {"problem": {"label": "Design question", "required": True,
                                "placeholder": "how should we cache"}},
}

PROBLEM = (args or {}).get("problem") or "the current design question"

SCORE = {
    "type": "object",
    "properties": {
        "score": {"type": "integer"},
        "strengths": {"type": "array", "items": {"type": "string"}},
        "weaknesses": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["score", "strengths", "weaknesses"],
}

# Deliberately different starting biases — identical prompts produce identical
# proposals, which defeats the panel.
ANGLES = [
    "the simplest thing that could possibly work; optimize for less code",
    "risk-first: assume this must survive failure, scale and hostile input",
    "user-first: optimize for the experience of whoever uses this daily",
]

phase("Propose")
proposals = parallel([
    (lambda a=a: agent(f"Propose an approach to: {PROBLEM}\n\nTake this stance: {a}. "
                       f"Be concrete about the mechanism and its trade-offs.",
                       label=f"propose:{a.split(':')[0][:16]}", phase="Propose"))
    for a in ANGLES
])
proposals = [p for p in proposals if p]

phase("Judge")
def score(proposal, _orig, _i):
    return agent(f"Score this approach to '{PROBLEM}' out of 10 and list its real "
                 f"strengths and weaknesses. Be sceptical.\n\n{proposal}",
                 label="judge", phase="Judge", schema=SCORE)

scores = pipeline(proposals, score)
ranked = sorted(
    [{"proposal": p, "score": s} for p, s in zip(proposals, scores) if s],
    key=lambda r: r["score"]["score"], reverse=True)

phase("Synthesize")
if not ranked:
    return {"winner": None, "ranked": [], "design": None}

design = agent(
    f"Write the final design for: {PROBLEM}\n\nBuild on the winning approach, but "
    f"graft in any genuinely better idea from the runners-up. Be explicit about "
    f"what you rejected and why.\n\nWINNER:\n{ranked[0]['proposal']}\n\n"
    f"OTHERS:\n" + "\n\n".join(str(r["proposal"]) for r in ranked[1:]),
    label="synthesize", phase="Synthesize")

return {"design": design, "ranked": ranked}
