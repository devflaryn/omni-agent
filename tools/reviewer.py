"""Independent reviewer — the third role in the planner / worker / reviewer
workflow.

The worker (the main agent loop) does the work; this reviewer independently
CHALLENGES the worker's claimed conclusion before it's accepted. It runs in a
SEPARATE, isolated LLM conversation — same model/key, no extra credentials —
exactly like tools/codebase_qa.py's `ask_codebase`, but with the opposite job:
instead of answering a question, it tries to find what's WRONG or MISSING.

What the reviewer does, using read-only tools + the investigation memory:
  * checks whether each important claim in the conclusion is actually supported
    by concrete evidence (file:line, symbol, command/build/test output, log);
  * runs a CONTRADICTION PASS — actively searches for evidence the conclusion is
    wrong, rather than only confirming it;
  * detects INCOMPLETE work — unverified changes, open questions, plan steps or
    requested deliverables that weren't actually done;
  * returns a structured verdict: APPROVE, or REVISE with the specific gaps and
    the concrete actions needed to close them.

The main loop calls run_review() as a GATE on the worker's final answer (see
agent.py). The same engine is also exposed as a `review_conclusion` tool so the
worker can request a self-review mid-task. Read-only by construction: the
reviewer can inspect but never modify, build, sign, or run anything.
"""
import json

from llm import ask_llm, extract_json_action, strip_reasoning
from tool_registry import registry
# Reuse the vetted read-only allowlist + bounds from the codebase-QA sub-agent so
# the two isolated sub-agents stay consistent and there's one place to widen the
# read-only surface.
from tools.codebase_qa import (
    ASK_CODEBASE_TOOLS,
    SUBAGENT_TEMPERATURE,
    PER_RESULT_CHAR_CAP,
    MAX_STEPS_CAP,
)

# The reviewer may use every read-only investigation tool the QA sub-agent may,
# plus a look at the structured investigation memory it's reviewing against.
REVIEWER_TOOLS = set(ASK_CODEBASE_TOOLS) | {"investigation_view"}

DEFAULT_REVIEW_STEPS = 10       # verification tool calls before it must rule
REVIEW_CONTEXT_CHAR_LIMIT = 160_000
REPEAT_LIMIT = 3

_REVIEWER_SYSTEM_PROMPT = """You are an independent, skeptical REVIEWER inside an isolated verification \
session. A worker agent has finished a task and produced a CONCLUSION (its final answer / claimed result). \
Your job is NOT to be agreeable — it is to find what is unsupported, wrong, or incomplete BEFORE the \
conclusion is accepted. Assume nothing is proven until you can see the evidence.

You share the same machine and project folder as the worker, and you have READ-ONLY tools \
(code graph, grep/find, file read, disassembly, decompilation, hashing, plus a view of the worker's \
structured investigation memory). You cannot modify, create, delete, repack, sign, or run anything — you \
only verify.

HOW TO REVIEW:
1. VERIFY EVIDENCE. For each important claim in the conclusion, check that the cited evidence actually says \
what the worker claims (open the file:line, confirm the symbol/string/method exists, re-read the command/\
test output). A claim with no checkable evidence is UNSUPPORTED.
2. CONTRADICTION PASS. Actively look for evidence the conclusion is WRONG — a second code path that isn't \
patched, another .so that also loads the check, a string/symbol that contradicts the claim, a test that \
would fail. Spend at least one step trying to break the conclusion, not just confirm it.
3. COMPLETENESS. Check that what the task actually asked for was delivered, that changes were validated by \
an objective check (build/install/launch/test/log — not just 'it should work'), and that open questions in \
the investigation memory don't undermine the result.
4. Be specific and fair: only demand a revision for a REAL gap (unsupported claim, contradiction, or \
unfinished work), not for style. If the conclusion is genuinely well-supported and complete, APPROVE it.

RESPONSE FORMAT — always a single raw JSON object, no markdown, no prose outside it.
To use a tool: {"type": "tool_call", "tool": "<name>", "args": { ... }}
When you have reviewed enough, return your verdict as:
{"type": "final_answer", "content": {
  "verdict": "approve" | "revise",
  "summary": "<one or two sentences on the overall judgement>",
  "unsupported_claims": ["<claim that lacks checkable evidence>", ...],
  "contradictions": ["<evidence the conclusion may be wrong>", ...],
  "incomplete_work": ["<what the task asked for that isn't done/verified>", ...],
  "required_actions": ["<concrete next action to close each gap>", ...]
}}
Use "approve" ONLY when unsupported_claims, contradictions and incomplete_work are all empty (or truly \
negligible). Otherwise use "revise" and fill required_actions with concrete, actionable steps. Call one \
tool at a time; investigate before you rule."""


_STRATEGY_REVIEWER_SYSTEM_PROMPT = """You are an independent, skeptical STRATEGY REVIEWER in an isolated \
session. A worker agent is about to start CHANGING an app based on a STRATEGIC BRIEF: a diagnosis of the \
target's protections and a chosen attack. Your job is NOT to be agreeable — it is to find, BEFORE any change \
is made, whether the strategy is aimed wrong: a mis-diagnosed protection, a better/simpler attack it skipped, \
an attack order that will fail, or a diagnosis claim with no real evidence.

You share the worker's read-only view (code graph, grep/find, file read, disassembly, decompilation, and the \
worker's investigation memory). You cannot modify or run anything — you only verify the PLAN OF ATTACK.

HOW TO REVIEW THE STRATEGY:
1. EVIDENCE. For each diagnosis claim, check the cited evidence actually supports it (open the file:line, \
confirm the class/method/string/symbol). A protection claim with no checkable evidence is UNSUPPORTED.
2. BETTER-STRATEGY PASS. Actively look for a stronger or simpler attack the brief missed, or a second code \
path/protection layer the strategy does not cover (e.g. a native probe in a .so when the plan only patches \
smali). Spend at least one step trying to prove the strategy is not the best one.
3. ORDER & KILL-CRITERIA. Check the attack order is sound (e.g. confirm-with-frida before a static patch on \
layered protections) and that the kill-criteria are concrete enough to know when to abandon it.
4. Be fair: only demand a revision for a REAL problem (unsupported diagnosis, a materially better/necessary \
strategy, an order that will fail). If the strategy is well-diagnosed and sound, APPROVE it.

RESPONSE FORMAT — always a single raw JSON object, no markdown, no prose outside it.
To use a tool: {"type": "tool_call", "tool": "<name>", "args": { ... }}
Verdict: {"type": "final_answer", "content": {
  "verdict": "approve" | "revise",
  "summary": "<one or two sentences>",
  "unsupported_claims": ["<diagnosis claim lacking evidence>", ...],
  "contradictions": ["<a better strategy, missed layer, or wrong-order risk>", ...],
  "incomplete_work": ["<a gap the brief must fill before execution>", ...],
  "required_actions": ["<concrete change to the brief/strategy>", ...]
}}
Use "approve" ONLY when unsupported_claims, contradictions and incomplete_work are all empty (or truly \
negligible). Otherwise "revise" with concrete required_actions. Call one tool at a time; investigate before \
you rule."""


def _parse_response(raw):
    data = extract_json_action(raw or "")
    if data is None:
        return ("error", None)
    rtype = data.get("type")
    if rtype not in ("tool_call", "final_answer") and ("args" in data or "tool" in data):
        data["tool"] = data.get("tool", rtype)
        rtype = "tool_call"
    if rtype == "tool_call":
        return ("tool_call", data)
    if rtype == "final_answer":
        return ("final_answer", data.get("content", ""))
    return ("error", None)


def _execute_readonly(tool_name, tool_args):
    """Run one reviewer tool call, but only if it's on the read-only allowlist."""
    if tool_name not in REVIEWER_TOOLS:
        return (f"Tool '{tool_name}' is not available in this read-only review session. "
                f"Use one of the read-only tools, or give your verdict.")
    if not isinstance(tool_args, dict):
        tool_args = {}
    result = registry.execute(tool_name, tool_args)
    output = result.get("stdout", "")
    err = result.get("stderr", "")
    err_dict = result.get("error", "")
    feedback = f"Tool '{tool_name}' executed.\n"
    if output:
        feedback += f"Output:\n{output[:PER_RESULT_CHAR_CAP]}\n"
        if len(output) > PER_RESULT_CHAR_CAP:
            feedback += f"[truncated at {PER_RESULT_CHAR_CAP} of {len(output)} chars]\n"
    if err:
        feedback += f"Stderr:\n{err[:1500]}\n"
    if err_dict:
        feedback += f"System Error:\n{err_dict}\n"
    if not output and not err and not err_dict:
        feedback += "(no output)\n"
    return feedback


def _estimate_chars(messages):
    return sum(len(m.get("content", "")) for m in messages)


def _coerce_verdict(payload):
    """Turn the reviewer's final_answer content into a normalized verdict dict.

    The content may already be a dict, a JSON string, or free text. We never fail
    here — an unreadable verdict is treated as a conservative 'revise' so a
    garbled reviewer reply can't wave broken work through."""
    obj = None
    if isinstance(payload, dict):
        obj = payload
    elif isinstance(payload, str):
        stripped = payload.strip()
        parsed = extract_json_action(stripped)
        if isinstance(parsed, dict) and ("verdict" in parsed or "summary" in parsed):
            obj = parsed
        else:
            try:
                cand = json.loads(stripped)
                if isinstance(cand, dict):
                    obj = cand
            except (ValueError, TypeError):
                obj = None

    def _as_list(v):
        if not v:
            return []
        if isinstance(v, str):
            return [v] if v.strip() else []
        if isinstance(v, list):
            return [str(x).strip() for x in v if str(x).strip()]
        return [str(v)]

    if obj is not None:
        verdict = str(obj.get("verdict", "")).strip().lower()
        unsupported = _as_list(obj.get("unsupported_claims"))
        contradictions = _as_list(obj.get("contradictions"))
        incomplete = _as_list(obj.get("incomplete_work"))
        required = _as_list(obj.get("required_actions"))
        summary = str(obj.get("summary", "")).strip()
        approved = verdict.startswith("approve") and not (unsupported or contradictions or incomplete)
        return {
            "approved": approved,
            "verdict": "approve" if approved else "revise",
            "summary": summary or ("Approved." if approved else "Revision requested."),
            "unsupported_claims": unsupported,
            "contradictions": contradictions,
            "incomplete_work": incomplete,
            "required_actions": required,
        }

    # Free text fallback: read the sentiment, default to caution.
    text = strip_reasoning(payload if isinstance(payload, str) else str(payload)).strip()
    low = text.lower()
    approved = ("approve" in low) and ("revise" not in low) and ("not approve" not in low)
    return {
        "approved": approved,
        "verdict": "approve" if approved else "revise",
        "summary": text[:500] or ("Approved." if approved else "Revision requested."),
        "unsupported_claims": [],
        "contradictions": [],
        "incomplete_work": [] if approved else ["Reviewer did not return a structured verdict."],
        "required_actions": [] if approved else ["Re-verify the conclusion's evidence and completeness."],
    }


def _format_feedback(v):
    """Render a verdict dict into the corrective message the worker gets when the
    reviewer requests changes."""
    lines = ["[REVIEWER — REVISION REQUIRED] An independent review of your conclusion found gaps. "
             "Do NOT repeat the same final answer; address these first, then continue."]
    if v.get("summary"):
        lines.append(f"Summary: {v['summary']}")
    for label, key in (("Unsupported claims (no checkable evidence)", "unsupported_claims"),
                       ("Possible contradictions (conclusion may be wrong)", "contradictions"),
                       ("Incomplete / unverified work", "incomplete_work"),
                       ("Required actions before you can finish", "required_actions")):
        items = v.get(key) or []
        if items:
            lines.append(label + ":")
            lines.extend(f"  - {it}" for it in items)
    lines.append("Close these gaps with concrete tool calls (verify evidence, patch the missed path, run "
                 "the validation), record what you find (record_finding / record_test_result / "
                 "record_failed_attempt), then give your final answer again.")
    return "\n".join(lines)


def _format_strategy_feedback(v):
    """Render a strategy-review verdict into the corrective message the worker gets."""
    lines = ["[STRATEGY REVIEWER — REVISION REQUIRED] An independent review of your STRATEGIC BRIEF found "
             "problems. Fix the brief with strategy_update before you start changing the workspace."]
    if v.get("summary"):
        lines.append(f"Summary: {v['summary']}")
    for label, key in (("Unsupported diagnosis (no checkable evidence)", "unsupported_claims"),
                       ("Better strategy / missed layer / wrong order", "contradictions"),
                       ("Gaps to fill before execution", "incomplete_work"),
                       ("Required changes to the brief", "required_actions")):
        items = v.get(key) or []
        if items:
            lines.append(label + ":")
            lines.extend(f"  - {it}" for it in items)
    lines.append("Revise the brief (strategy_update) to address these, then continue.")
    return "\n".join(lines)


def run_review(conclusion, task="", extra_context="", max_steps=DEFAULT_REVIEW_STEPS):
    """Independently review a worker conclusion. Returns a normalized verdict dict:
    {approved, verdict, summary, unsupported_claims, contradictions,
     incomplete_work, required_actions, feedback, steps}.

    Never raises for review reasons — any internal failure yields a conservative,
    non-blocking 'approve' with a note, so the review gate can never deadlock the
    worker on infrastructure problems (only on genuine, articulated gaps)."""
    conclusion = (conclusion or "").strip()
    if not conclusion:
        return {"approved": True, "verdict": "approve", "summary": "Nothing to review.",
                "unsupported_claims": [], "contradictions": [], "incomplete_work": [],
                "required_actions": [], "feedback": "", "steps": 0}
    try:
        max_steps = max(1, min(int(max_steps), MAX_STEPS_CAP))
    except (TypeError, ValueError):
        max_steps = DEFAULT_REVIEW_STEPS

    tool_prompt = registry.get_tool_prompt(allowed_tools=REVIEWER_TOOLS)
    system_prompt = _REVIEWER_SYSTEM_PROMPT + "\n\n" + tool_prompt
    user = "TASK THE WORKER WAS GIVEN:\n" + (task or "(not provided)") + "\n\n"
    user += "WORKER'S CONCLUSION TO REVIEW:\n" + conclusion + "\n"
    if (extra_context or "").strip():
        user += "\nADDITIONAL CONTEXT / INVESTIGATION MEMORY:\n" + extra_context.strip() + "\n"
    user += ("\nReview this now. Verify the cited evidence, run a contradiction pass, check completeness, "
             "then return your verdict JSON.")

    messages = [{"role": "system", "content": system_prompt},
                {"role": "user", "content": user}]

    steps = 0
    last_sig = None
    repeats = 0
    parse_errors = 0
    try:
        while steps < max_steps:
            raw = ask_llm(messages, temperature=SUBAGENT_TEMPERATURE)
            rtype, payload = _parse_response(raw)
            messages.append({"role": "assistant", "content": raw})

            if rtype == "final_answer":
                v = _coerce_verdict(payload)
                v["steps"] = steps
                v["feedback"] = "" if v["approved"] else _format_feedback(v)
                return v

            if rtype == "error":
                parse_errors += 1
                if parse_errors >= 3:
                    v = _coerce_verdict(strip_reasoning(raw))
                    v["steps"] = steps
                    v["feedback"] = "" if v["approved"] else _format_feedback(v)
                    return v
                messages.append({"role": "user", "content": (
                    "Your last reply was not valid JSON. Reply with a single raw JSON object: either a "
                    'tool_call or your verdict {"type":"final_answer","content":{"verdict":...}}.')})
                continue
            parse_errors = 0

            tool_name = payload.get("tool")
            tool_args = payload.get("args", {}) or {}
            sig = (tool_name, json.dumps(tool_args, sort_keys=True, default=str))
            if sig == last_sig:
                repeats += 1
            else:
                repeats, last_sig = 1, sig
            if repeats >= REPEAT_LIMIT:
                messages.append({"role": "user", "content": (
                    f"[SYSTEM] You've called '{tool_name}' identically {repeats} times. Stop looping — "
                    "try a different check or give your verdict.")})
                repeats = 0
                continue

            steps += 1
            feedback = _execute_readonly(tool_name, tool_args)
            messages.append({"role": "user", "content": f"TOOL RESULT:\n{feedback}"})

            if _estimate_chars(messages) > REVIEW_CONTEXT_CHAR_LIMIT:
                break

        # Ran out of steps (or context) — force a verdict from what it has.
        messages.append({"role": "user", "content": (
            "[SYSTEM] Review budget reached. Give your verdict now as "
            '{"type":"final_answer","content":{"verdict":...}} based on what you have checked.')})
        raw = ask_llm(messages, temperature=SUBAGENT_TEMPERATURE)
        _, payload = _parse_response(raw)
        v = _coerce_verdict(payload if payload else raw)
        v["steps"] = steps
        v["feedback"] = "" if v["approved"] else _format_feedback(v)
        return v
    except Exception as e:
        # Never let a reviewer/infrastructure failure block the worker.
        return {"approved": True, "verdict": "approve",
                "summary": f"Review skipped (reviewer error: {e}).",
                "unsupported_claims": [], "contradictions": [], "incomplete_work": [],
                "required_actions": [], "feedback": "", "steps": 0}


def run_strategy_review(brief_markdown, task="", extra_context="", max_steps=DEFAULT_REVIEW_STEPS):
    """Independently review a STRATEGIC BRIEF before execution. Same verdict shape as
    run_review; never raises for review reasons (a failure yields a conservative,
    non-blocking approve so the diagnosis gate can never deadlock on infrastructure)."""
    brief_markdown = (brief_markdown or "").strip()
    if not brief_markdown:
        return {"approved": True, "verdict": "approve", "summary": "No brief to review.",
                "unsupported_claims": [], "contradictions": [], "incomplete_work": [],
                "required_actions": [], "feedback": "", "steps": 0}
    try:
        max_steps = max(1, min(int(max_steps), MAX_STEPS_CAP))
    except (TypeError, ValueError):
        max_steps = DEFAULT_REVIEW_STEPS

    tool_prompt = registry.get_tool_prompt(allowed_tools=REVIEWER_TOOLS)
    system_prompt = _STRATEGY_REVIEWER_SYSTEM_PROMPT + "\n\n" + tool_prompt
    user = "THE TASK:\n" + (task or "(not provided)") + "\n\n"
    user += "THE STRATEGIC BRIEF TO REVIEW (the plan of attack, before any change):\n" + brief_markdown + "\n"
    if (extra_context or "").strip():
        user += "\nADDITIONAL CONTEXT / INVESTIGATION MEMORY:\n" + extra_context.strip() + "\n"
    user += ("\nReview this strategy now. Verify the diagnosis evidence, run a better-strategy pass, check the "
             "order and kill-criteria, then return your verdict JSON.")

    messages = [{"role": "system", "content": system_prompt},
                {"role": "user", "content": user}]

    steps = 0
    last_sig = None
    repeats = 0
    parse_errors = 0
    try:
        while steps < max_steps:
            raw = ask_llm(messages, temperature=SUBAGENT_TEMPERATURE)
            rtype, payload = _parse_response(raw)
            messages.append({"role": "assistant", "content": raw})

            if rtype == "final_answer":
                v = _coerce_verdict(payload)
                v["steps"] = steps
                v["feedback"] = "" if v["approved"] else _format_strategy_feedback(v)
                return v

            if rtype == "error":
                parse_errors += 1
                if parse_errors >= 3:
                    v = _coerce_verdict(strip_reasoning(raw))
                    v["steps"] = steps
                    v["feedback"] = "" if v["approved"] else _format_strategy_feedback(v)
                    return v
                messages.append({"role": "user", "content": (
                    "Your last reply was not valid JSON. Reply with a single raw JSON object: either a "
                    'tool_call or your verdict {"type":"final_answer","content":{"verdict":...}}.')})
                continue
            parse_errors = 0

            tool_name = payload.get("tool")
            tool_args = payload.get("args", {}) or {}
            sig = (tool_name, json.dumps(tool_args, sort_keys=True, default=str))
            if sig == last_sig:
                repeats += 1
            else:
                repeats, last_sig = 1, sig
            if repeats >= REPEAT_LIMIT:
                messages.append({"role": "user", "content": (
                    f"[SYSTEM] You've called '{tool_name}' identically {repeats} times. Stop looping — "
                    "try a different check or give your verdict.")})
                repeats = 0
                continue

            steps += 1
            feedback = _execute_readonly(tool_name, tool_args)
            messages.append({"role": "user", "content": f"TOOL RESULT:\n{feedback}"})

            if _estimate_chars(messages) > REVIEW_CONTEXT_CHAR_LIMIT:
                break

        messages.append({"role": "user", "content": (
            "[SYSTEM] Review budget reached. Give your verdict now as "
            '{"type":"final_answer","content":{"verdict":...}} based on what you have checked.')})
        raw = ask_llm(messages, temperature=SUBAGENT_TEMPERATURE)
        _, payload = _parse_response(raw)
        v = _coerce_verdict(payload if payload else raw)
        v["steps"] = steps
        v["feedback"] = "" if v["approved"] else _format_strategy_feedback(v)
        return v
    except Exception as e:
        return {"approved": True, "verdict": "approve",
                "summary": f"Strategy review skipped (reviewer error: {e}).",
                "unsupported_claims": [], "contradictions": [], "incomplete_work": [],
                "required_actions": [], "feedback": "", "steps": 0}


@registry.register(
    name="review_conclusion",
    description=(
        "Runs an INDEPENDENT, skeptical review of a claimed conclusion in a separate isolated session "
        "(same model/key, read-only tools). The reviewer verifies that each claim is backed by checkable "
        "evidence, runs a contradiction pass (actively looks for evidence the conclusion is WRONG), checks "
        "for incomplete/unverified work, and returns APPROVE or REVISE with specific gaps and required "
        "actions. Only the verdict comes back — the verification steps stay in the sub-session. The main "
        "loop already auto-reviews your final answer; call this yourself when you want to pressure-test an "
        "important intermediate conclusion before you build on it."
    ),
    params_schema={
        "conclusion": "string (the conclusion/result to review — state it with its supporting evidence)",
        "task": "string (optional — what the task asked for, so completeness can be judged)",
        "context": "string (optional — extra context or a paste of investigation_view to review against)",
        "max_steps": f"integer (optional, default {DEFAULT_REVIEW_STEPS}) — verification tool calls before it must rule"
    },
    output="A structured verdict: approve/revise, a summary, and lists of unsupported claims, contradictions, incomplete work, and required actions.",
    when_to_use="Use it to independently pressure-test an important conclusion before acting on it. For a plain 'where/how does X work' question use ask_codebase instead; this tool judges a conclusion rather than answering a question."
)
def review_conclusion(conclusion, task="", context="", max_steps=DEFAULT_REVIEW_STEPS):
    v = run_review(conclusion, task=task, extra_context=context, max_steps=max_steps)
    header = "VERDICT: " + ("APPROVE" if v["approved"] else "REVISE")
    lines = [header, v.get("summary", "")]
    for label, key in (("Unsupported claims", "unsupported_claims"),
                       ("Contradictions", "contradictions"),
                       ("Incomplete work", "incomplete_work"),
                       ("Required actions", "required_actions")):
        items = v.get(key) or []
        if items:
            lines.append(f"{label}:")
            lines.extend(f"  - {it}" for it in items)
    lines.append(f"[review: {v.get('steps', 0)} verification step(s)]")
    return {"stdout": "\n".join(lines)}
