---
name: verification-before-completion
description: The discipline of proving a claim before calling it done — never assert "fixed / bypassed / works" without an objective check (verify_apk, emulator launch + logcat, disassembly, frida probe, or a passing test) and the evidence behind it.
when_to_use: Right before you give a final answer, mark a plan step/phase complete, or tell the user something is done/fixed/bypassed — especially after any patch, rebuild, or bypass.
allowed-tools: verify_apk, inspect_apk, get_apk_signature_hash, disassemble_range, llvm_objdump_disasm, install_apk_on_emulator, launch_app_on_emulator, get_logcat, take_emulator_screenshot, frida_trace, frida_run_script, dispatch_agents, record_test_result
---

# Verification before completion — evidence before assertions

The failure mode this prevents: declaring victory on a change you never actually
checked. "I patched the return, so the check is bypassed" is a HYPOTHESIS, not a
result. On a mid-tier model over a long run, unverified success claims are the most
expensive mistake — the user acts on them, and they're wrong.

**Rule: no completion claim without an objective check and the evidence stated.**

## What counts as an objective check (match it to the claim)

| You're claiming… | Verify with… |
|---|---|
| The APK rebuilt/signed cleanly | `verify_apk`, `get_apk_signature_hash` |
| A static patch landed correctly | disassemble the exact site (`disassemble_range` / `llvm_objdump_disasm`) or read the patched smali and confirm the value/offset |
| A check is bypassed at runtime | `install_apk_on_emulator` → `launch_app_on_emulator` → `get_logcat` / `take_emulator_screenshot`; or a `frida_trace`/`frida_run_script` probe on the branch |
| The app runs / no longer crashes | launch on the emulator and read logcat past the failure point |
| A guard is fully removed | confirm the SAME defense isn't ALSO present elsewhere (layered protection) |

Editing the file verifies the **edit**. Only running it verifies the **behavior** —
be explicit about which one you actually confirmed.

## The check, every time

1. State the claim precisely ("the root check at `Root.smali:42` no longer triggers").
2. Run the check that would FALSIFY it if it were wrong (adversarial, not confirmatory).
3. Record the result with `record_test_result` (what you ran, what you saw).
4. Only then say it's done — and cite the evidence. For an expensive/independent
   check, delegate the `verifier` subagent (or `dispatch_agents`) so the verification
   runs in a fresh context and returns just VERIFIED / NOT VERIFIED + evidence.

## When you genuinely can't verify here

Static-only environment, no runnable base? Say so plainly and **downgrade the claim**:
"patched — not runtime-verified" instead of "bypassed". An honest, scoped result beats
a confident wrong one. Never paper over an unchecked claim with certain-sounding words.

## Red flags you're about to over-claim

- "should work now", "that fixes it", "the check is bypassed" — with no tool output cited.
- Marking a phase complete right after an edit, before any build/launch/test.
- A rebuilt APK you never ran `verify_apk` on.
- Bypassing one copy of a check without looking for the second.
