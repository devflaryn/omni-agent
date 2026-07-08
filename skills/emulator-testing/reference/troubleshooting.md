# Emulator Testing — Troubleshooting Reference

> The default backend is `qemu` (driven by `qemu-manager.exe`). Those issues are covered first; the LDPlayer / AVD sections below apply only when you pass `backend="ldplayer"` or `backend="avd"`.

## qemu backend: "Could not find qemu-manager.exe"
`ensure_emulator_running` (default `backend="qemu"`) shells out to `qemu-manager.exe`. It's expected at the **project root** (next to `agent.py`). If it's elsewhere, set the `QEMU_MANAGER_PATH` environment variable to its full path and restart the agent process. On non-Windows hosts the binary is named `qemu-manager` (no `.exe`) and QEMU is taken from the host `PATH` — see `qemu-manager.md` → Platform notes.

## qemu backend: launch fails with `no_base_image` / exit code 4
The `qemu` backend boots a fresh overlay off `base.qcow2`, which must sit next to `qemu-manager.exe`. It is NOT downloaded automatically — it's the one thing you provide: an Android-x86 / Bliss OS x86_64 image with the game pre-installed and **ADB-over-TCP enabled** (adbd on tcp 5555, the Android-x86/Bliss default). See `qemu-manager.md` → Requirements. Until it's in place, use `backend="ldplayer"` or `backend="avd"` instead.

## qemu backend: first launch is slow / seems to hang
The very first `launch` on a machine downloads a portable QEMU build (and, on first adb use, Google's platform-tools) into `runtime/` next to the exe — this can take a few minutes on a slow connection. This is one-time; later launches reuse the cache. The tool's launch timeout is already generous (10 min). A genuine failure surfaces as exit code 3 (runtime download/extraction) with a message — check the internet connection and the URLs/checksums in `manifest.json`.

## qemu backend: `BOOT_TIMEOUT` even though QEMU started
QEMU's forwarded adb port accepts TCP as soon as the VM starts, before Android is actually up, so a timeout here means Android didn't reach `sys.boot_completed=1` in time, not that adb is unreachable. Options: raise `boot_timeout` (a cold first boot of a fresh overlay is the slowest); watch the boot live via any VNC viewer on `127.0.0.1:<vnc_port>` (the port is printed in the launch log); or read `instances/<session>/qemu.log` next to the exe (exit code 5 = QEMU died on launch, e.g. virtualization disabled or a corrupt base image). On Windows enable the *Windows Hypervisor Platform* feature for WHPX acceleration — without it QEMU falls back to slow TCG.

## "Could not find an Android SDK with both adb.exe and emulator.exe" from ensure_emulator_running
The tool auto-detects the SDK from (in order): `$ANDROID_SDK_ROOT`, `$ANDROID_HOME`, then `%LOCALAPPDATA%\Android\Sdk` (Android Studio's default install location on Windows). If none of those has both `platform-tools\adb.exe` and `emulator\emulator.exe`:
- Confirm Android Studio is actually installed and has downloaded the SDK (Settings → Languages & Frameworks → Android SDK shows the install path).
- If it's installed somewhere non-default, set the `ANDROID_SDK_ROOT` environment variable to that path and restart the agent process so it picks up the new env var.
- If `avdmanager` came back `None` in the tool's warning (no `cmdline-tools` package), AVD auto-creation won't work — either install the "Android SDK Command-line Tools" package via Android Studio's SDK Manager, or create the AVD once manually via Android Studio's Device Manager using the exact name you pass as `avd_name` (default `omniagent_avd`); `ensure_emulator_running` will then find and reuse it.

## `BOOT_TIMEOUT after Ns` from ensure_emulator_running
- Check the tail of the emulator log path printed in the tool's output (`/workspace/.emulator/emulator.log`, which is really `<project_workspace>\.emulator\emulator.log` on disk).
- Since the emulator now runs natively on Windows (not inside a container), this is usually a real problem rather than an acceleration issue: a crash on launch (check the log for a stack trace), the AVD being corrupted, or antivirus/Windows Defender interfering with `emulator.exe`. Confirm the AVD boots fine when launched manually from Android Studio's Device Manager as a baseline.
- If the AVD only boots very slowly the first time after `-wipe-data` (Android's first-boot setup can take longer than a later boot), raise `boot_timeout` for that one call rather than assuming something's broken.

## LDPlayer: `BOOT_TIMEOUT` with the device stuck at `offline` (not `device`) in `adb devices`
This is a real, observed failure mode distinct from a slow boot — `ensure_emulator_running` connects fine (the port is found correctly and a transport is established), but `adb -s <serial> shell ...` never becomes ready because the device sits in `offline` state indefinitely. Diagnose it directly:
```
adb_shell("devices")   # via the SDK's or LDPlayer's adb.exe, e.g. run the equivalent adb command manually
```
If it shows `127.0.0.1:PORT   offline` and stays that way for more than ~30-60s, this is NOT a code bug in this tool — the ADB transport connected but the handshake with the guest's `adbd` never completes. In order of likelihood:
1. **Antivirus / endpoint security doing deep packet inspection on loopback traffic** — some AV products intercept and mangle local TCP streams even on 127.0.0.1, which is enough to break the adb protocol handshake specifically while still allowing the raw TCP connect to succeed (which is why it doesn't fail outright). Try temporarily disabling real-time protection and reset+retry to confirm.
2. **A VPN client or local proxy tool** capturing loopback traffic (some corporate VPN/EDR tools do this deliberately). Same test: temporarily disable it and retry.
3. **LDPlayer's ADB debugging wasn't actually enabled** despite `ensure_emulator_running` calling `ldconsole modify --root 1` on a freshly created instance — open the LDPlayer window for this instance once and check Settings → Other Settings for an "ADB debugging" / "Root access" toggle, enable it manually, then let `ensure_emulator_running(reset=false)` reconnect without recreating the instance.
4. **adb client/server version mismatch** — this was ruled out in testing (both the Android SDK's newer adb.exe and LDPlayer's own bundled adb.exe hit the identical stuck-offline symptom against the same instance), but if you're on a very old or very new LDPlayer build, it's still worth trying `adb kill-server` then re-running with only LDPlayer's own `adb.exe` (`<LDPlayer install dir>\adb.exe`) as a sanity check.
If none of the above resolves it, fall back to `backend="avd"` (the Android Studio SDK emulator) for testing until the LDPlayer environment issue is sorted out — it's a completely independent code path.

## LDPlayer: the actual adb port isn't `5555 + 2*index`
Earlier LDPlayer 4.x automation guides commonly cite a fixed port formula (`5555 + 2*index`). This does NOT hold reliably across LDPlayer 9.x installs/configs — verified directly against a real install where the actual bound port was something else entirely. `ensure_emulator_running`/`adb_shell`/etc. now discover the real port dynamically per call, by finding which TCP port the instance's VM process (`vbox_pid` from `ldconsole list2`) is actually LISTENING on via `netstat`, falling back to the old formula only if that lookup fails outright. You shouldn't normally need to know this, but if you're debugging manually with a bare `adb connect 127.0.0.1:PORT`, don't assume the formula — check `netstat -ano | findstr LISTENING` for the instance's vbox_pid instead (visible via `adb_shell` isn't applicable here since this is a host-side lookup, not a device command).

## `INSTALL_FAILED_NO_MATCHING_ABIS` from install_apk_on_emulator
The APK's native `.so` libraries don't match what the running system image can execute. Options, in order of preference:
1. If the APK has multiple ABI folders (check with `inspect_apk filter_pattern='.so'`), the default x86_64 image's native-bridge translation covers a lot of ARM code but not all of it — if it still fails, that app's native code isn't translatable on this image.
2. Recreate the emulator against a matching ABI: call `ensure_emulator_running(avd_name=<same name>, system_image="system-images;android-33;google_apis;arm64-v8a", reset=true)`. NOTE: `system_image` only takes effect the first time an AVD is CREATED — if `avd_name` already exists as an x86_64 device, either delete it first (via Android Studio's Device Manager) or use a different `avd_name` (e.g. `omniagent_avd_arm64`) so you can keep both available.
3. Expect the arm64-v8a image to be noticeably slower, even with hardware acceleration — budget a longer `duration_seconds` for the app to finish loading.

## `vision_backend_used: null` in the generated report (no keyframe descriptions)
Both the API vision path and the local Ollama path failed for every frame. Check `analyze_keyframes`'s own tool output (not just the final report) — it lists the specific error for each frame attempt:
- If the API error mentions an HTTP error or "reply looked like it did not actually see the image": the GLM backend behind this agent doesn't support vision on this deployment — this is expected and not a bug to chase; rely on the Ollama fallback instead.
- If the Ollama error mentions a connection failure: the user needs Ollama running on THIS machine (`ollama serve`, or the Ollama desktop app) and reachable at `http://localhost:11434`, with a vision-capable model pulled (`ollama pull llava` is a safe default; `qwen2.5vl`/`moondream`/`bakllava` also work — pass the model name via `analyze_keyframes`'s `ollama_model` parameter).
- The report is still usable without descriptions — brightness/diff/black-screen flags plus logcat often already tell you what happened (e.g. a black-screen keyframe immediately followed by a FATAL EXCEPTION in logcat is a crash, no image description needed to conclude that).

## The app installs and launches but nothing shows up in captured keyframes
`record_and_capture_keyframes` only keeps a frame when the screen changes enough from the last KEPT one — if `duration_seconds` starts before the app is actually drawing anything (e.g. you called it immediately after `launch_app_on_emulator` with zero delay), the very first frame becomes the "baseline" and a slow app that finishes loading a few seconds later might undershoot `change_threshold` if the transition is subtle. Try a longer `duration_seconds`, or lower `change_threshold` a bit for that specific app.

## "Does minimizing the emulator window break screenshots?"
No — `take_emulator_screenshot`/`record_and_capture_keyframes` both use `adb exec-out screencap -p`, which reads the emulated device's own framebuffer over the ADB protocol, exactly like screenshotting a real phone. It does not care whether the emulator's window is focused, occluded, or minimized on the Windows desktop. If you ever see a genuinely blank/corrupt screenshot, the cause is elsewhere (e.g. the device isn't actually booted yet, or `adb` is talking to the wrong `-s <serial>`), not window visibility.
