---
name: emulator-testing
description: Actually run a built/signed APK on a persistent Android emulator, watch what happens with automatic smart screenshot capture, pull logcat, and get a Markdown report describing what the test found — so patches can be verified by observation, not just by verify_apk's structural checks.
when_to_use: Use this skill any time you've built and signed a modified APK and want to confirm it actually WORKS — launches without crashing, the patched check is really bypassed at runtime, a new feature renders correctly — rather than only trusting that the build succeeded. Also use it when the user reports a bug/crash and wants you to reproduce and diagnose it.
allowed-tools: ensure_emulator_running, install_apk_on_emulator, launch_app_on_emulator, play_roblox, set_roblox_account, list_roblox_accounts, adb_shell, get_logcat, take_emulator_screenshot, record_and_capture_keyframes, analyze_keyframes, generate_test_report, run_apk_test_session, stop_emulator
---

# Emulator Testing Skill

`verify_apk` only checks that an APK is structurally valid (signed, aligned, has the required files) — it says nothing about whether the app actually runs correctly. This skill closes that gap by actually installing and launching the app on a real emulator and observing it.

## Architecture: omnidroid, native on the host
The emulator tools run NATIVELY on this host (macOS/Windows/Linux), not through the Linux Docker sandbox.

**One backend: omnidroid.** There is a single backend — the self-contained headless **omnidroid** engine (QEMU + a LineageOS **arm64** base that runs natively on Apple Silicon / arm64 hosts, no translation). The old `ldplayer` and `avd` backends and the x86 Bliss `base.qcow2` are GONE; any `backend` value other than `qemu` is coerced to omnidroid. The engine is resolved by `_find_qemu_manager`: the canonical `omnidroid/manager/omni.py` checkout beside `omni-agent` is preferred, so the agent always drives the current engine (thin username-keyed instances, `accounts.json`, the RGBX colour fix). Base images live in the external `OmniImages` dir, never bundled. On first use the engine self-bootstraps a portable QEMU; these tools call it for lifecycle and read the guest adb serial from its JSON, then use an ordinary host `adb` for screenshots/logcat/keyframes — so those steps are engine-agnostic.

**Accounts are Roblox logins, not disks.** An "instance" is a THIN (~0.4 MB) COW overlay of the shared base, auto-created and named for the account. A saved Roblox account is just its cookie in `accounts.json`, keyed by username (added by the human via `omni login`; the agent cannot log in — that needs a browser). For the Roblox flow, prefer `play_roblox(account="<username>", place_id=...)` — it boots a thin instance, resolves the cookie by username, and lands in-game with no menu/taps. `list_roblox_accounts()` shows which usernames are available. `install_apk_on_emulator` still works for testing a fresh Roblox build on the DEV base before it ships.

**A stock/unmodified Roblox APK CANNOT log in from a cookie.** The client's deep link (`roblox://experiences/start?placeId=...`) has no auth parameter — the session lives in Roblox's own WebView cookie jar, which only code running as Roblox can write. `play_roblox`/`set_roblox_account` will still report `"launched": true` and the kiosk log will show `OmniKiosk: joined place ... (host session)` — that only means the deep link fired, NOT that the account is logged in. A build only logs in if it was built with `decode_apk` -> `inject_session_bootstrap` -> `recompile_apk` -> `sign_apk` (see contracts/omni-session.md §4). Real confirmation is `OmniBootstrap: session cookie installed (N chars)` in `get_logcat`/`monitor_logcat` — if that line is missing after a join, the installed build has no bootstrap and is showing its own login screen underneath whatever the deep link opened; don't report login as working from the join result alone.

**Screenshots are window-state-independent by design.** `take_emulator_screenshot` and `record_and_capture_keyframes` both use `adb exec-out screencap -p`, which reads the emulated device's own framebuffer over the ADB protocol — the exact same mechanism used to screenshot a real phone. This does NOT look at the host desktop/window at all, so it keeps working correctly whether the emulator window is focused, in the background, or minimized. Never substitute a desktop window-capture approach (BitBlt/PrintWindow/mss on the emulator's Qt window) here — that class of approach reliably breaks or returns a blank image for a minimized window, which is exactly the failure mode this design avoids.

## Instances, reused
`ensure_emulator_running`/`install_apk_on_emulator`/etc. target an instance named by `device_name` (default `omniagent`); `play_roblox` names the instance for the account (`account="<username>"`). An instance is created once if missing — a THIN COW overlay of the shared base — and REUSED on later calls, never duplicated. `ensure_emulator_running(reset=true)` discards the overlay and makes a fresh one, so each test starts clean without rebuilding a VM. Two DIFFERENT names run side by side (two accounts at once). When done, `stop_emulator` tears the instance down (VMs run detached and outlive the agent, so stop them to free RAM/CPU; `purge=true` also deletes the thin overlay).

## Step 1 — The fast path: one call
For the common case ("test this APK and tell me how it performs"), call `run_apk_test_session(apk_path, package_name, ...)`. It runs the entire pipeline — boot/reset the emulator, install, launch, watch the screen for `duration_seconds`, describe what it saw, and write a report — and returns the report path. Then `read_file_chunk` that report and go to Step 5.

## Step 2 — The granular path (when you need control)
If you need to interleave manual actions (e.g. tap through a login flow) or re-run just one stage, drive the pipeline yourself:
1. `ensure_emulator_running(reset=true)` — the omnidroid engine; wait for `BOOT_OK` in its output before continuing. The FIRST launch on a machine downloads the portable QEMU runtime (a few minutes) — that's normal, not a hang. (For the Roblox flow, `play_roblox(account=..., place_id=...)` does boot + login + join in one call — use it instead of ensure+install+launch.)
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
- ABI: the base is arm64 (LineageOS, native on arm64 hosts), so `arm64-v8a` libraries run directly — no translation layer to fall short. `INSTALL_FAILED_NO_MATCHING_ABIS` means the APK ships no `arm64-v8a` (or armeabi-v7a) native libs; rebuild/patch it with an arm64 split rather than switching backends (there is no other backend).
- `duration_seconds` should cover the actual moment you care about — a 5-second window won't catch a slow crash on a 15-second cold start. Err longer for a first test of an unfamiliar app.
- The primary agent loop is text-only — it can't view the keyframe PNGs directly. The vision descriptions in the generated report ARE its eyes; don't skip `analyze_keyframes` and expect to reason about screen content from the raw image paths alone.
