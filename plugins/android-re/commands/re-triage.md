---
name: re-triage
description: Run the canonical Android RE playbook end-to-end for a modding goal — decode, detect protections, map, locate the target guard, confirm it live with Frida, patch statically, then rebuild and verify. Delegates heavy steps to fresh contexts.
---
Run the standard reverse-engineering workflow for the current goal (a bypass, an unlock, a mod). Work in phases; delegate heavy steps so your own context stays lean (see the `tool-usage` and `context-hygiene` skills). For a big/ambiguous goal, run `plan-feature` first to commit a phased plan, then execute it with these steps.

**1. Orient (cheap, no plan needed yet).**
Identify the target APK and the exact objective. `decode_apk`, skim the manifest and entry points. State precisely what "done" means ("proxy sees HTTPS traffic", "app launches on a rooted device", "premium unlocked").

**2. Detect protections BEFORE diving in.**
Is it packed/obfuscated? Look for a stub `Application` + encrypted blobs / packer `.so` (→ load `dynamic-unpacking`: the real code isn't static, dump it first). Heavy string obfuscation? (→ `string-deobfuscation`). Knowing this now prevents hours wasted decompiling a stub.

**3. Map, don't scan.**
`query_code_graph(name="…")` with the terms that name your target (the guard's strings/classes/symbols). Never read files one-by-one to browse.

**4. Locate the target guard(s) — delegate in parallel.**
`dispatch_agents` a read-only wave for the INDEPENDENT questions (e.g. `researcher`/`native-analyst`: "locate the root check", "locate the signature check", "locate the SSL pinning"). Each returns just its `file:line`/offset evidence. Expect LAYERED defenses (Java + native, a check + a re-check) — find them all.

**5. Confirm dynamically (recommended).**
On the dev base, use `frida-dynamic-instrumentation` to prove which guard actually gates and what value means "pass" — flip it live and watch the app proceed. Now your static patch will be the right one in the right place.

**6. Patch statically — delegate the change.**
Load the matching skill (`ssl-pinning-bypass` / `root-detection-bypass` / `signature-bypass` / `anti-debug-bypass` / `smali-code-injection` / `native-patching`) and make the SMALLEST change that works. For a well-specified edit, tag a plan step `delegate="implementer"` so it runs serialized in its own context.

**7. Rebuild and VERIFY — non-negotiable.**
`recompile_apk` → `sign_apk` → `verify_apk`, then run `verify-work`: install + launch on the emulator, read logcat, confirm the app is past the gate — and that a second copy of the guard didn't take over. Downgrade any claim you can't runtime-verify to "patched — not runtime-verified".

**8. Record and advance.**
`record_finding` the confirmed guard locations and `record_test_result` the verification as you go (durable memory survives context resets). `plan_advance_phase` at each milestone. If an approach dead-ends, `plan_replan` for a different one — don't grind.
