---
name: frida-dynamic-instrumentation
description: Use Frida to observe and change an Android app at RUNTIME on the dev base — hook Java/native methods, trace calls, flip a check live, and dump decrypted values — so you confirm what a guard actually does BEFORE committing a static smali/.so patch.
when_to_use: When you need to prove which check fires (root/signature/SSL/anti-debug/license), watch real arguments/return values, defeat something dynamically to confirm the fix, or pull a value the app computes at runtime (a decrypted string, a derived key). Requires the dev base (emulator + frida-server); it does not modify the APK itself.
allowed-tools: ensure_emulator_running, ensure_frida_server, install_apk_on_emulator, launch_app_on_emulator, frida_list_processes, frida_trace, frida_run_script, frida_bypass_ssl_pinning, hide_root_from_app, get_logcat
---

# Frida dynamic instrumentation

Static patching (smali/.so) is where fixes are BAKED IN, but you should usually
*confirm dynamically first*: a live Frida hook proves which check fires and what
flipping it does, so the static patch you commit is the right one in the right place.
This runs on the DEV BASE (emulator + `frida-server`) — it observes/alters a running
process, it does not change the APK on disk.

## Step 1 — Bring up the base
`ensure_emulator_running` → `ensure_frida_server` (starts/validates frida-server on the
device). `install_apk_on_emulator` the target if it isn't installed. Confirm Frida
sees it: `frida_list_processes` (find the package / PID).

## Step 2 — Attach or spawn
- To catch startup checks (root/anti-debug/integrity usually run in `Application.onCreate`
  or a static initializer), you must **spawn** so the hook is in place before the check
  runs — `frida_run_script` with a spawn+resume script (see the reference).
- To inspect an already-running screen, attach to the live PID.

## Step 3 — Observe before you change
Start read-only. `frida_trace` on the suspect methods (or classes) to watch arguments
and return values as you drive the app. Read `get_logcat` in parallel — the check often
logs its own failure. Now you KNOW the method, the argument, and the value that means
"pass".

## Step 4 — Flip it live to confirm the fix
`frida_run_script` with a hook that forces the safe path — overload the Java method to
return `true`/`false`, replace a native function's return, or no-op it. Drive the app: does
the gate now pass (app launches, feature unlocks, traffic flows)? That's your confirmation.
Load `reference/frida-recipes.md` for ready hooks: Java method override, native
`Interceptor.attach`/`replace`, class enumeration, SSL unpinning, root-check flip,
anti-debug/`ptrace` bypass, and dumping a decrypted string.

For SSL specifically, `frida_bypass_ssl_pinning` is a one-shot universal unpinner —
use it to get a proxy working immediately; `hide_root_from_app` does the same for common
root checks.

## Step 5 — Bake the confirmed change into a static patch
Frida is not the deliverable (it needs root + frida-server; a shipped modded APK does
not). Once a hook proves the fix, translate it to a permanent patch and hand off:
- Java check → `smali-code-injection` / `patch_smali_method` on that exact method.
- Native check → `native-patching` (`patch_function_return` / `nop_function`) at that
  offset.
Then verify the static build with the `verification-before-completion` discipline
(rebuild → `verify_apk` → launch → logcat), because the static patch must stand on its
own without Frida.

## Critical Rules
- **Confirm, then commit.** Use Frida to *prove* which guard matters and what the safe
  value is; don't ship a Frida script as the fix unless the user explicitly wants a
  runtime/hooking deliverable.
- **Spawn for early checks.** Attaching after launch misses anything that ran in
  `onCreate` / a static initializer — you'll see nothing and wrongly conclude there's no
  check. Spawn+resume.
- **Layered defenses are normal.** Flipping one hook may reveal a SECOND check behind it
  (Java guard → native re-check). Keep tracing until the app is genuinely past the gate.
- **Match the static patch to the dynamic finding.** The offset/method you patch
  statically must be the SAME one your hook proved — note it precisely before switching
  to smali/native editing.
