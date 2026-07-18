"""verification plugin — on_final_answer guard.

Fires when the agent is about to finish. If the answer CLAIMS the task succeeded
(fixed / bypassed / works / patched / done) but nothing shows the claim was actually
VERIFIED with an objective check — or the runtime flagged an unverified change — it
returns an `inject` advisory. The agent loop turns that into a steering message and
sends the answer back for one more pass (bounded by MAX_FINAL_HOOK_NUDGES so it can
never deadlock).

Pure stdlib, no project imports: plugin hooks are loaded as isolated modules, so this
must stand on its own. Conservative by design — it stays silent on honest
"partial/blocked" answers and on claims that already cite a concrete check, so it
complements (doesn't duplicate) the built-in independent reviewer.
"""
import re

# Strong "I'm done and it worked" claims.
_CLAIM = re.compile(
    r"\b(successfully|success|works?\s+now|working\s+now|now\s+works|"
    r"fixed|resolved|bypassed|neutrali[sz]ed|defeated|"
    r"patched\s+(it|the|successfully)|"
    r"is\s+now\s+(working|bypassed|patched|complete)|"
    r"task\s+(is\s+)?(done|complete)|all\s+set|good\s+to\s+go)\b",
    re.I)

# Language that shows the claim was actually checked against reality.
_EVIDENCE = re.compile(
    r"\b(verified|confirmed|validated|tested|re-?tested|re-?checked|"
    r"installed\s+and|launched|ran\s+the\s+app|logcat|screenshot|"
    r"verify_apk|frida|reproduc|build\s+succeeded|recompiled\s+and|"
    r"objective\s+check|test\s+passed|passes\s+the\s+test|"
    r"disassembl(ed|y)\s+confirm|instructions?\s+confirm)\b",
    re.I)

# "Not actually done" answers we must NOT nag — they're already honest about status.
_NOT_DONE = re.compile(
    r"\b(blocked|couldn'?t|could\s+not|unable\s+to|failed\s+to|"
    r"partial(ly)?|still\s+(need|open|failing|unresolved)|"
    r"not\s+(yet\s+)?(done|verified|working|runtime-?verified)|"
    r"needs?\s+(a\s+)?different\s+approach|remains?\s+(open|unresolved)|"
    r"not\s+runtime-?verified)\b",
    re.I)


def _nudge(reason):
    return {
        "plugin": "verification",
        "inject": (
            "VERIFY BEFORE DONE — " + reason + " You're presenting this as complete, but I don't see an "
            "OBJECTIVE check behind the claim. Before finishing, prove it against reality and state the "
            "evidence: verify_apk after a rebuild; install + launch on the emulator and read logcat; a frida "
            "hook or a disassembly that confirms the patched value; or a passing test. If you already "
            "verified, say exactly HOW (the command and what it showed). If it genuinely can't be verified "
            "here (static-only, no runnable base), say so plainly and downgrade the claim from 'done' to "
            "'patched — not runtime-verified'. Don't assert a success you didn't check."
        ),
    }


def on_final_answer(ctx):
    """Return an inject-advisory dict to send the answer back, or None to let it through."""
    ctx = ctx or {}
    answer = str(ctx.get("answer") or "")
    # A runtime-flagged change that was never validated is the strongest signal.
    if ctx.get("unverified_change"):
        return _nudge("the runtime flagged a change that was never validated.")
    if not answer.strip():
        return None
    # An honest "not done / partial / blocked" answer is fine — never nag it.
    if _NOT_DONE.search(answer):
        return None
    # A confident success claim with no verification language behind it -> nudge once.
    if _CLAIM.search(answer) and not _EVIDENCE.search(answer):
        return _nudge("the answer asserts success without showing a check.")
    return None
