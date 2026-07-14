"""Investigation-memory tools — let the agent record what it has actually
established, separately from the raw conversation, in an evidence-first
structure it can carry across context resets.

These are the write surface for investigation.py's active Investigation (a
module-level singleton, same design as planning.py's active plan). agent.py
wires up investigation.set_context(...) once per session so these autosave to
the right memory dir and push a live update to the GUI + system prompt without
that plumbing being passed as tool arguments.

Design intent (matches the evidence-based workflow the system prompt mandates):
  * CONFIRMED FINDINGS must cite evidence — record_finding rejects an empty
    evidence field, because a "confirmed" fact with nothing behind it is exactly
    the unsupported conclusion this whole layer exists to prevent.
  * HYPOTHESES are explicitly unproven; they carry a confidence level and
    whatever partial evidence exists, and are later confirmed/refuted.
  * FAILED ATTEMPTS are first-class, so the loop can stop the model from
    repeating a known dead end without new evidence.
"""
from tool_registry import registry
import investigation
import planning


def _view():
    inv = investigation.get_active()
    if inv is None or inv.is_empty():
        return "Investigation memory is empty."
    return inv.to_markdown()


@registry.register(
    name="record_finding",
    description=(
        "Records a CONFIRMED finding — a technical fact you have actually established — into the "
        "investigation memory, together with the evidence that proves it. Evidence is REQUIRED: cite a "
        "concrete file:line, symbol/class/method name, search hit, command/build/test output, or runtime "
        "log. A finding without evidence is rejected on purpose (that's an assumption, not a finding — "
        "record it with record_hypothesis instead). Findings survive context-window resets, so this is "
        "how you keep hard-won facts from being lost when the conversation is summarized."
    ),
    params_schema={
        "finding": "string (the confirmed fact, stated precisely — e.g. 'the license check is enforced in com.app.Auth->verify() at Auth.smali:142')",
        "evidence": "string (REQUIRED — what proves it: file:line, symbol, search result, command/build/test output, or log line)"
    },
    output="A confirmation plus the current investigation-memory view, or an error if evidence is missing.",
    when_to_use="Call this the moment you PROVE something (not before). For an unproven idea use record_hypothesis; for a dead end use record_failed_attempt."
)
def record_finding(finding, evidence=""):
    finding = (finding or "").strip()
    evidence = (evidence or "").strip()
    if not finding:
        return {"error": "record_finding requires a non-empty 'finding'."}
    if not evidence:
        return {"error": (
            "record_finding requires 'evidence' — cite a file:line, symbol, search hit, or "
            "command/test/log output. If you cannot cite evidence yet, this is a hypothesis, not a "
            "finding: use record_hypothesis instead."
        )}
    inv = investigation.ensure_active()
    inv.add_finding(finding, evidence)
    investigation.notify_updated()
    return {"stdout": "Finding recorded.\n\n" + inv.to_markdown()}


@registry.register(
    name="record_assumption",
    description=(
        "Records an explicit WORKING ASSUMPTION that the current plan relies on, separately from both "
        "confirmed findings and hypotheses. An assumption is a premise accepted temporarily so work can "
        "move forward; a hypothesis is a possible explanation being tested. State why the premise is "
        "reasonable and later call update_assumption when evidence validates or invalidates it."
    ),
    params_schema={
        "assumption": "string (the working premise, stated narrowly)",
        "rationale": "string (optional; why it is reasonable to rely on for now)",
        "evidence": "string (optional; partial evidence, which does not make it a confirmed fact)"
    },
    output="A confirmation plus the investigation-memory view, including the assumption id.",
    when_to_use="Use when a plan must rely on something not yet proven. Do not record it as a finding until evidence validates it."
)
def record_assumption(assumption, rationale="", evidence=""):
    assumption = (assumption or "").strip()
    if not assumption:
        return {"error": "record_assumption requires a non-empty 'assumption'."}
    inv = investigation.ensure_active()
    item = inv.add_assumption(assumption, rationale=rationale, evidence=evidence)
    investigation.notify_updated()
    return {"stdout": f"Assumption recorded (id={item['id']}).\n\n" + inv.to_markdown()}


@registry.register(
    name="update_assumption",
    description=(
        "Updates a working assumption after checking it: 'validated' promotes it to an evidence-backed "
        "finding; 'invalidated' records that the premise was wrong; 'active' leaves it unresolved. Evidence "
        "is required for validated/invalidated. Set impact='major' only when invalidation makes the remaining "
        "mission or phase plan structurally wrong; otherwise use 'local' and revise only the affected step."
    ),
    params_schema={
        "assumption_id": "string (id returned by record_assumption / investigation_view)",
        "status": "string ('active', 'validated', or 'invalidated')",
        "evidence": "string (required when status is validated or invalidated)",
        "impact": "string (optional: 'local' default, or 'major')"
    },
    output="The updated memory; major invalidation also marks the active plan as requiring a replan.",
    when_to_use="Call as soon as evidence settles a premise, before continuing under an outdated assumption."
)
def update_assumption(assumption_id, status, evidence="", impact="local"):
    inv = investigation.get_active()
    if inv is None:
        return {"error": "No active investigation yet. Record an assumption first."}
    if impact not in ("local", "major"):
        return {"error": "impact must be 'local' or 'major'."}
    item = inv.set_assumption_status(assumption_id, status, evidence=evidence)
    if item is None:
        return {"error": (
            f"Assumption '{assumption_id}' was not found, the status is invalid, or evidence is missing. "
            "Use active/validated/invalidated and include evidence for a settled assumption."
        )}
    investigation.notify_updated()
    if status == "invalidated" and impact == "major":
        plan = planning.get_active_plan()
        if plan is not None and hasattr(plan, "request_replan"):
            plan.request_replan(
                f"Working assumption invalidated: {item.get('text', '')}",
                trigger="invalid_assumption", evidence=evidence,
            )
            planning.notify_updated()
    return {"stdout": "Assumption updated.\n\n" + inv.to_markdown()}


@registry.register(
    name="record_hypothesis",
    description=(
        "Records a HYPOTHESIS — a plausible but UNPROVEN idea — with a confidence level and whatever "
        "partial evidence you have. Keeps assumptions clearly separated from confirmed findings so you "
        "(and the reviewer) never mistake a guess for a fact. Later call update_hypothesis to mark it "
        "confirmed (which promotes it to a finding) or refuted."
    ),
    params_schema={
        "hypothesis": "string (the unproven idea, e.g. 'the anti-tamper check is triggered from JNI_OnLoad in libsecure.so')",
        "evidence": "string (optional but encouraged — the partial evidence pointing this way, if any)",
        "confidence": "string (optional: 'low', 'medium' (default), or 'high')"
    },
    output="A confirmation plus the investigation-memory view, including the new hypothesis's id (needed for update_hypothesis).",
    when_to_use="Use this for anything you SUSPECT but have not proven. Prove it (record_finding / update_hypothesis) before acting on it as fact."
)
def record_hypothesis(hypothesis, evidence="", confidence="medium"):
    hypothesis = (hypothesis or "").strip()
    if not hypothesis:
        return {"error": "record_hypothesis requires a non-empty 'hypothesis'."}
    inv = investigation.ensure_active()
    item = inv.add_hypothesis(hypothesis, evidence=evidence, confidence=confidence)
    investigation.notify_updated()
    return {"stdout": f"Hypothesis recorded (id={item['id']}).\n\n" + inv.to_markdown()}


@registry.register(
    name="update_hypothesis",
    description=(
        "Updates a hypothesis's status once you have evidence: 'confirmed' (it's proven — it is also "
        "promoted to a confirmed finding), 'refuted' (disproven), or 'open' (still unproven). Pass the "
        "new evidence you found."
    ),
    params_schema={
        "hypothesis_id": "string (the id from record_hypothesis / investigation_view)",
        "status": "string ('confirmed', 'refuted', or 'open')",
        "evidence": "string (optional — the evidence that settled it; strongly encouraged when confirming/refuting)"
    },
    output="A confirmation plus the investigation-memory view, or an error if the id/status is invalid.",
    when_to_use="Call this when an investigation step settles a suspicion either way, so the memory reflects proof rather than guesswork."
)
def update_hypothesis(hypothesis_id, status, evidence=""):
    inv = investigation.get_active()
    if inv is None:
        return {"error": "No active investigation yet. Record a hypothesis first."}
    item = inv.set_hypothesis_status(hypothesis_id, status, evidence=evidence)
    if item is None:
        return {"error": f"Hypothesis '{hypothesis_id}' not found, the status is invalid, or evidence "
                         f"is missing for a settled hypothesis (use 'confirmed', 'refuted', or 'open'). "
                         "Call investigation_view for ids."}
    investigation.notify_updated()
    return {"stdout": "Hypothesis updated.\n\n" + inv.to_markdown()}


@registry.register(
    name="record_failed_attempt",
    description=(
        "Records an approach that did NOT work, why it failed, and any evidence. This is first-class "
        "memory: the agent loop checks it, and will stop you from silently re-running an approach already "
        "recorded here unless you bring NEW evidence or a materially different variation. Recording dead "
        "ends is how a long run avoids grinding the same failing path for hours."
    ),
    params_schema={
        "approach": "string (what you tried, concretely — e.g. 'patch_smali_method to force verify() to return true')",
        "reason": "string (optional — why it failed: the error, the observed result, the reason it can't work)",
        "evidence": "string (optional — the error text / log / result that shows it failed)"
    },
    output="A confirmation plus the investigation-memory view.",
    when_to_use="Call this whenever something you tried fails or proves to be a dead end, BEFORE moving on — so you (and future context after a reset) don't repeat it."
)
def record_failed_attempt(approach, reason="", evidence=""):
    approach = (approach or "").strip()
    if not approach:
        return {"error": "record_failed_attempt requires a non-empty 'approach'."}
    inv = investigation.ensure_active()
    inv.add_failed_attempt(approach, reason=reason, evidence=evidence)
    investigation.notify_updated()
    return {"stdout": "Failed attempt recorded.\n\n" + inv.to_markdown()}


@registry.register(
    name="record_decision",
    description=(
        "Records a decision you made and the rationale behind it (e.g. 'patch in smali rather than the "
        ".so, because the check is only reachable from Java'). Keeps the reasoning behind choices in the "
        "durable record so it survives a context reset and the reviewer can evaluate it."
    ),
    params_schema={
        "decision": "string (the choice made)",
        "rationale": "string (optional — why this over the alternatives)"
    },
    output="A confirmation plus the investigation-memory view.",
    when_to_use="Call this at a genuine fork in the approach, so the 'why' isn't lost."
)
def record_decision(decision, rationale=""):
    decision = (decision or "").strip()
    if not decision:
        return {"error": "record_decision requires a non-empty 'decision'."}
    inv = investigation.ensure_active()
    inv.add_decision(decision, rationale=rationale)
    investigation.notify_updated()
    return {"stdout": "Decision recorded.\n\n" + inv.to_markdown()}


@registry.register(
    name="record_open_question",
    description=(
        "Records an unresolved question that matters to the task (e.g. 'which of the three .so files "
        "actually loads the check?'). Keeps track of what's still unknown so nothing is quietly dropped."
    ),
    params_schema={"question": "string (the unresolved question)"},
    output="A confirmation plus the investigation-memory view.",
    when_to_use="Call this when you hit something you can't resolve yet but must not forget."
)
def record_open_question(question):
    question = (question or "").strip()
    if not question:
        return {"error": "record_open_question requires a non-empty 'question'."}
    inv = investigation.ensure_active()
    inv.add_open_question(question)
    investigation.notify_updated()
    return {"stdout": "Open question recorded.\n\n" + inv.to_markdown()}


@registry.register(
    name="record_test_result",
    description=(
        "Records the outcome of a validation step — a syntax check, build, package, install, launch, "
        "test run, log inspection, or feature check — as pass / fail / unknown, with details. This is how "
        "'the change works' becomes an evidence-backed claim rather than an assumption: success is not "
        "confirmed until an objective check is recorded here as 'pass'."
    ),
    params_schema={
        "name": "string (what was validated, e.g. 'rebuild APK', 'apk installs on emulator', 'login screen loads')",
        "outcome": "string ('pass', 'fail', or 'unknown')",
        "details": "string (optional — the command run and the key output/log line that shows the outcome)"
    },
    output="A confirmation plus the investigation-memory view.",
    when_to_use="Call this after every validation step. Treat a change as unverified until its check is recorded here as 'pass'."
)
def record_test_result(name, outcome="unknown", details=""):
    name = (name or "").strip()
    if not name:
        return {"error": "record_test_result requires a non-empty 'name'."}
    inv = investigation.ensure_active()
    inv.add_test_result(name, outcome=outcome, details=details)
    investigation.notify_updated()
    return {"stdout": "Test result recorded.\n\n" + inv.to_markdown()}


@registry.register(
    name="set_next_steps",
    description=(
        "Replaces the 'next steps' list — the immediate next 1-3 actions you intend to take. Kept short "
        "and current (it's a rolling 'what now', not a log). Survives context resets, so after a "
        "summarization you can pick up exactly where you left off."
    ),
    params_schema={"steps": "array of strings (the ordered immediate next actions)"},
    output="A confirmation plus the investigation-memory view.",
    when_to_use="Call this before a natural pause, or whenever your plan for the immediate next actions changes, so the durable record always says what to do next."
)
def set_next_steps(steps):
    inv = investigation.ensure_active()
    inv.set_next_steps(steps or [])
    investigation.notify_updated()
    return {"stdout": "Next steps updated.\n\n" + inv.to_markdown()}


@registry.register(
    name="investigation_view",
    description=(
        "Returns the current investigation memory: confirmed findings (with evidence), working assumptions, hypotheses, "
        "failed attempts, decisions, modified files, open questions, test results, and next steps. Use it "
        "to re-orient after a context reset, to look up a hypothesis id, or to check what's already been "
        "proven/ruled out before spending tool calls re-deriving it."
    ),
    params_schema={},
    output="A compact, bucketed markdown view of everything recorded so far (or a note that it's empty).",
    when_to_use="Call this to re-orient yourself, avoid repeating work, or verify the record reflects reality before giving a final answer."
)
def investigation_view():
    return {"stdout": _view()}
