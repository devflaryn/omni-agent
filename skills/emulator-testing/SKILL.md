---
name: emulator-testing
description: Actually run a built/signed APK on a persistent Android emulator, watch what happens with automatic smart screenshot capture, pull logcat, and get a Markdown report describing what the test found — so patches can be verified by observation, not just by verify_apk's structural checks.
when_to_use: Use this skill any time you've built and signed a modified APK and want to confirm it actually WORKS — launches without crashing, the patched check is really bypassed at runtime, a new feature renders correctly — rather than only trusting that the build succeeded. Also use it when the user reports a bug/crash and wants you to reproduce and diagnose it.
allowed-tools: ensure_emulator_running, install_apk_on_emulator, launch_app_on_emulator, adb_shell, get_logcat, take_emulator_screenshot, record_and_capture_keyframes, analyze_keyframes, generate_test_report, run_apk_test_session, stop_emulator
---

# Emulator Testing Skill

`verify_apk` only checks that an APK is structurally valid (signed, aligned, has the required files) — it says nothing about whether the app actually runs correctly. This skill closes that gap by actually installing and launching the app on a real emulator and observing it.

## Architecture: the emulator runs on Windows, not in the sandbox
Unlike every other tool in this project, the emulator tools do NOT go through the Linux Docker sandbox. The Android emulator runs NATIVELY on this Windows machine.

**Backends.** The default backend is `qemu`: a self-contained headless QEMU / Android-x86 (Bliss OS) runner driven through the bundled `qemu-manager.exe` at the project root (see `qemu-manager.md` for its full CLI). It requires NO separately installed emulator — on first use it downloads a portable QEMU build and Google's `adb` into `runtime/` next to the exe, then boots a fresh thin overlay off `base.qcow2` per session and forwards the guest's `adbd` to a loopback port. These tools call it for lifecycle (`launch` / `wait-boot` / `stop`) and read the guest's adb serial out of `qemu-manager status`, then use that serial with an ordinary host `adb.exe` for everything else — so all the screenshot/logcat/keyframe steps below are backend-agnostic. Two fallback backends remain for hosts already set up for them: `ldplayer` (LDPlayer via `ldconsole.exe`, strong arm64-v8a translation) and `avd` (Android Studio's `emulator.exe`, auto-detected from `ANDROID_SDK_ROOT`/`ANDROID_HOME` or `%LOCALAPPDATA%\Android\Sdk`).

> The `qemu` backend needs `base.qcow2` (an Android-x86/Bliss OS image with ADB-over-TCP enabled) sitting next to `qemu-manager.exe`. If a call fails with a missing-base-image error (exit code 4), that file isn't in place yet — see `qemu-manager.md` → Requirements. Override the exe location with the `QEMU_MANAGER_PATH` env var if it isn't at the project root.

**Screenshots are window-state-independent by design.** `take_emulator_screenshot` and `record_and_capture_keyframes` both use `adb exec-out screencap -p`, which reads the emulated device's own framebuffer over the ADB protocol — the exact same mechanism used to screenshot a real phone. This does NOT look at the host desktop/window at all, so it keeps working correctly whether the emulator window is focused, in the background, or minimized. Never substitute a desktop window-capture approach (BitBlt/PrintWindow/mss on the emulator's Qt window) here — that class of approach reliably breaks or returns a blank image for a minimized window, which is exactly the failure mode this design avoids.

## The one emulator, reused
Every tool here targets the SAME persistent virtual device/session (the `device_name` param — for the default `qemu` backend this is the qemu-manager session id, default `omniagent`; for `ldplayer`/`avd` it's the instance/AVD name, `omniagent_ld`/`omniagent_avd`). It is created once if missing and REUSED on every later call, never duplicated. By default, `ensure_emulator_running` also resets it on every call — qemu via `launch --force` (a brand-new overlay off `base.qcow2`, the old one discarded), LDPlayer via quit+recreate, AVD via `-wipe-data` — so each test starts from a clean state without the overhead of building a new VM from scratch. This matches "always fresh, never a duplicate VM." When you're done, `stop_emulator` tears the session down (qemu VMs run detached and outlive the agent, so stop them to free RAM/CPU; add `purge=true` to also delete the overlay disk).

## Step 1 — The fast path: one call
For the common case ("test this APK and tell me how it performs"), call `run_apk_test_session(apk_path, package_name, ...)`. It runs the entire pipeline — boot/reset the emulator, install, launch, watch the screen for `duration_seconds`, describe what it saw, and write a report — and returns the report path. Then `read_file_chunk` that report and go to Step 5.

## Step 2 — The granular path (when you need control)
If you need to interleave manual actions (e.g. tap through a login flow) or re-run just one stage, drive the pipeline yourself:
1. `ensure_emulator_running(reset=true)` — defaults to the `qemu` backend; wait for `BOOT_OK` in its output before continuing. The FIRST launch on a machine downloads the portable QEMU runtime (a few minutes) — that's normal, not a hang. If it errors that `qemu-manager.exe` or `base.qcow2` can't be found, see `reference/troubleshooting.md`.
2. `install_apk_on_emulator(apk_path)` — watch for `INSTALL_FAILED_NO_MATCHING_ABIS`, which means the APK's native libraries don't match the guest architecture (see `reference/troubleshooting.md`).
3. `launch_app_on_emulator(package_name)` (or with a specific `activity`).
4. Optionally drive the app manually with `adb_shell` (`input tap X Y`, `input keyevent 4` for back, `input text "..."` ) between capturing windows.
5. `record_and_capture_keyframes(session_name, duration_seconds=...)` around whatever window you want observed.
6. `analyze_keyframes(session_name)` to get descriptions of what each captured frame shows.
7. `generate_test_report(session_name, package_name=..., apk_path=...)`.

## Step 3 — Understanding the smart capture algorithm
`record_and_capture_keyframes` doesn't screenshot on a fixed schedule and dump everything on you — it samples frequently but only KEEPS a frame when the screen changed enough versus the last kept frame (`change_threshold`) or the screen just went black (`black_threshold`). A looping spinner or pulsing icon stays close to its own baseline forever, so it's correctly ignored; a real screen/page transition diverges immediately and gets kept as the new baseline. Tune `change_threshold` up if trivial animations are still triggering too many keyframes for a particular app, or down if you suspect a real transition was missed.

## Step 4 — Vision analysis backend
`analyze_keyframes` defaults to `backend="auto"`: it first tries sending the screenshot to the SAME GLM backend that powers this whole agent, formatted as a vision chat message. If that backend doesn't actually support images (returns an error, or a reply that doesn't describe an image), it automatically falls back to a local Ollama vision model on this same machine (`http://localhost:11434`) — this requires the user to have Ollama running with a vision model pulled (e.g. `ollama pull llava`). If you get `vision_backend_used: null` in a report, neither path worked — tell the user to install/run Ollama with a vision model if they want image descriptions; the report is still useful from logcat and timing/brightness data alone.

## Step 5 — Reading the report and deciding what to fix
`generate_test_report` produces `/workspace/test_reports/<session_name>.md` with every keyframe (image link + timestamp + diff score + black-screen flag + vision description) and the logcat captured during that exact window. Read it with `read_file_chunk`. Common findings and what to do next:
- **A crash / FATAL EXCEPTION in logcat** right after a keyframe → note which method/line the stack trace names, then go fix it with `patch_smali_method`/`native-patching` and re-test.
- **A black screen keyframe with no obvious logcat error** → often an ANR or an uncaught native crash the app swallowed; try `adb_shell dumpsys activity activities` or re-run with `get_logcat(priority="W")` for a broader window.
- **A signature/tamper/root-detection dialog appearing in the description** → the corresponding bypass skill (`signature-bypass`/`anti-debug-bypass`/`ssl-pinning-bypass`) wasn't fully applied; go back and patch the remaining check, then re-test.
- **The app appears to work fine** → this is your confirmation the patch didn't just build successfully but actually functions; report this to the user with the report path as evidence.

## Critical Rules
- Reset is on by default for a reason — don't set `reset=false` unless you deliberately want to preserve state between two calls (e.g. installing an app once, then running multiple short capture sessions against it without reinstalling).
- ABI matters for native libraries. On the `qemu` backend the guest architecture is whatever `base.qcow2` is (typically x86_64 Android-x86/Bliss, which has an ARM native-bridge but can't run every arm64-v8a lib); on `avd` you pick it via `system_image`. If an install fails with `INSTALL_FAILED_NO_MATCHING_ABIS`, see `reference/troubleshooting.md` — options include trying the `ldplayer` backend, whose ARM translation covers more arm64-v8a code.
- `duration_seconds` should cover the actual moment you care about — a 5-second window won't catch a slow crash on a 15-second cold start. Err longer for a first test of an unfamiliar app.
- The primary agent loop is text-only — it can't view the keyframe PNGs directly. The vision descriptions in the generated report ARE its eyes; don't skip `analyze_keyframes` and expect to reason about screen content from the raw image paths alone.
