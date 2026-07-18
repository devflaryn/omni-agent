---
name: verify-work
description: Prove the current change actually works before calling it done — run the objective check that matches the claim and record the evidence, or delegate the verifier subagent.
---
Verify the work you just did, before you report it as complete:

1. State the exact claim you're about to make ("the SSL pinning is bypassed", "the app launches on a rooted device").
2. Load the `verification-before-completion` skill and pick the objective check that matches the claim.
3. Run the check that would FALSIFY the claim if it were wrong (adversarial): `verify_apk` on a rebuild; install + launch on the emulator and read `get_logcat`; disassemble the patched site to confirm the value; or a `frida` probe on the branch.
4. For an expensive or truly independent check, delegate the `verifier` subagent (it re-checks in a fresh context and returns VERIFIED / NOT VERIFIED + evidence).
5. `record_test_result` with what you ran and what you saw.
6. Only now finish. If it can't be verified here (static-only, no runnable base), downgrade the claim to "patched — not runtime-verified" and say why — don't assert success you didn't check.
