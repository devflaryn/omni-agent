---
name: emulator-testing
description: Actually run a built/signed APK on a persistent Android emulator, watch what happens with automatic smart screenshot capture, pull logcat, and get a Markdown report describing what the test found — so patches can be verified by observation, not just by verify_apk's structural checks.
when_to_use: Use this skill any time you've built and signed a modified APK and want to confirm it actually WORKS — launches without crashing, the patched check is really bypassed at runtime, a new feature renders correctly — rather than only trusting that the build succeeded. Also use it when the user reports a bug/crash and wants you to reproduce and diagnose it.
allowed-tools: ensure_emulator_running, install_apk_on_emulator, launch_app_on_emulator, adb_shell, get_logcat, take_emulator_screenshot, record_and_capture_keyframes, analyze_keyframes, generate_test_report, run_apk_test_session
---

# Emulator Testing Skill

`verify_apk` only checks that an APK is structurally valid (signed, aligned, has the required files) — it says nothing about whether the app actually runs correctly. This skill closes that gap by actually installing and launching the app on a real emulator and observing it.

## Architecture: the emulator runs on Windows, not in the sandbox
Unlike every other tool in this project, the emulator tools do NOT go through the Linux Docker sandbox. The Android emulator runs NATIVELY on this Windows machine (Android Studio's `emulator.exe`/`adb.exe`, auto-detected from `ANDROID_SDK_ROOT`/`ANDROID_HOME` or Android Studio's default `%LOCALAPPDATA%\Android\Sdk`). That means real hardware acceleration (no KVM/software-virtualization concerns), and a normal visible emulator window you can interact with or minimize like any other app.

**Screenshots are window-state-independent by design.** `take_emulator_screenshot` and `record_and_capture_keyframes` both use `adb exec-out screencap -p`, which reads the emulated device's own framebuffer over the ADB protocol — the exact same mechanism used to screenshot a real phone. This does NOT look at the host desktop/window at all, so it keeps working correctly whether the emulator window is focused, in the background, or minimized. Never substitute a desktop window-capture approach (BitBlt/PrintWindow/mss on the emulator's Qt window) here — that class of approach reliably breaks or returns a blank image for a minimized window, which is exactly the failure mode this design avoids.

## The one emulator, reused
Every tool here targets the SAME persistent virtual device (`avd_name`, default `omniagent_avd`) — it is created once if missing and REUSED on every later call, never recreated. By default, `ensure_emulator_running` also resets it (kills any running instance, `-wipe-data`) on every call, so each test starts from a clean factory state without the overhead of building a new virtual device from scratch. This matches "always fresh, never a duplicate VM."

## Step 1 — The fast path: one call
For the common case ("test this APK and tell me how it performs"), call `run_apk_test_session(apk_path, package_name, ...)`. It runs the entire pipeline — boot/reset the emulator, install, launch, watch the screen for `duration_seconds`, describe what it saw, and write a report — and returns the report path. Then `read_file_chunk` that report and go to Step 5.

## Step 2 — The granular path (when you need control)
If you need to interleave manual actions (e.g. tap through a login flow) or re-run just one stage, drive the pipeline yourself:
1. `ensure_emulator_running(avd_name=..., reset=true)` — wait for `BOOT_OK` in its output before continuing. If it errors that no SDK could be found, see `reference/troubleshooting.md`.
2. `install_apk_on_emulator(apk_path)` — watch for `INSTALL_FAILED_NO_MATCHING_ABIS`, which means the APK's native libraries don't match the emulator's system image architecture (see `reference/troubleshooting.md`).
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
- Match `system_image` to what the target APK's native libraries actually need — see `reference/troubleshooting.md` for the ABI mismatch symptom and fix.
- `duration_seconds` should cover the actual moment you care about — a 5-second window won't catch a slow crash on a 15-second cold start. Err longer for a first test of an unfamiliar app.
- The primary agent loop is text-only — it can't view the keyframe PNGs directly. The vision descriptions in the generated report ARE its eyes; don't skip `analyze_keyframes` and expect to reason about screen content from the raw image paths alone.
