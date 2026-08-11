# Emulator Testing — Troubleshooting Reference

There is ONE backend: the omnidroid engine (QEMU + a LineageOS **arm64** base).
The old `ldplayer` / `avd` backends and the x86 Bliss `base.qcow2` are gone — any
`backend` value other than `qemu` is coerced to omnidroid, and there is no
Android-Studio SDK / `emulator.exe` / AVD path to configure.

## "Could not find the omnidroid engine"
`_find_qemu_manager` looks, in order: `$QEMU_MANAGER_PATH`, the canonical
`<Omni Apps>/omnidroid/manager/omni.py` checkout beside `omni-agent` (preferred),
a bundled `tools/omnidroid/omnidroid(.exe)`, then `PATH`. On a dev machine the
canonical checkout is what runs. If it can't be found, either the sibling
`omnidroid/` checkout is missing or set `QEMU_MANAGER_PATH` to `omni.py`.

## launch fails with `no_base` / missing base image
The engine boots per-account THIN overlays of a shared base that lives in the
external `OmniImages` dir (`images_dir` in `omnidroid/configs/paths.json`;
`~/OmniImages` on Linux/macOS). The base is delivered out of band, not
downloaded. If a call reports no base, the `base_arm*` images aren't in
`OmniImages` yet — see `omnidroid/HOWTO.md`. (Production is `base_arm`; the dev
base with frida+Magisk is `--base dev`, gated by `OMNI_DEV_MODE`.)

## first launch is slow / seems to hang
The first launch on a machine downloads a portable QEMU build into the engine's
product dir — a few minutes, one-time, then cached. Not a hang; the launch
timeout is generous. A cold first boot of a fresh overlay is also the slowest
boot (Android first-run); later boots off the provisioned base are ~30–60 s.

## `BOOT_TIMEOUT` even though QEMU started
The forwarded adb port accepts TCP the moment QEMU starts, before Android is up,
so a timeout means Android didn't reach `sys.boot_completed=1` in time, not that
adb is unreachable. Options:
- Raise `boot_timeout`.
- Watch the boot live: any VNC viewer on `127.0.0.1:<vnc_port>` (printed in the
  launch log), or `omnidroid view <name>`.
- Read `omnidroid/accounts/<name>/qemu.log` and `serial.log`.
- **Acceleration:** on Apple Silicon the base runs arm64 natively under HVF (no
  translation) and boots in well under a minute. On an x86 host there is no
  matching production base — the product is arm. Without a hypervisor QEMU falls
  back to slow TCG; expect long boots.

## a fresh account stalls on "Allow USB debugging?"
Only relevant on an OLD base image. The current base ships
`androidboot.insecure_adb=1` (`ro.adb.secure=0`), so adbd accepts the host key
with no dialog on a fresh boot. If you see that dialog, the base predates the
fix — rebuild it with `omnidroid brand-base` (see `omnidroid/LOADING-SCREEN.md`).

## `INSTALL_FAILED_NO_MATCHING_ABIS` from install_apk_on_emulator
The base is arm64 (native, no translation layer), so `arm64-v8a` libs run
directly. This error means the APK ships no `arm64-v8a` (or `armeabi-v7a`)
native libs at all — `inspect_apk filter_pattern='.so'` to confirm. Fix the APK
(build/patch an arm64 split); there is no other backend to fall back to.

## Roblox: `no_token` from play_roblox
`play_roblox(account="<username>")` resolves the cookie from `accounts.json` by
username. `no_token` means that username isn't saved. `list_roblox_accounts()`
shows what IS saved. Adding an account is a **human** step — `omnidroid login` opens a
browser for the person to sign in; the agent cannot log in itself. Alternatively
pass a raw cookie via `token=...` (override path).

## Roblox: joined the place but it shows the login screen
The join (deep link) worked but the cookie didn't authenticate. Either the
saved cookie is stale (`list_roblox_accounts(verify=true)` — Roblox invalidates a
cookie on sign-out / password change) or the installed Roblox build lacks the
session bootstrap (`inject_session_bootstrap` before packaging). See
`contracts/omni-session.md`.

## `vision_backend_used: null` in the generated report (no keyframe descriptions)
Both the API vision path and the local Ollama path failed for every frame. Check
`analyze_keyframes`'s own tool output — it lists the per-frame error:
- API "reply looked like it did not actually see the image" → this agent's model
  doesn't support vision on this deployment; rely on the Ollama fallback.
- Ollama connection failure → the user needs Ollama running on THIS machine
  (`ollama serve`) at `http://localhost:11434` with a vision model pulled
  (`ollama pull llava`; pass others via `analyze_keyframes`'s `ollama_model`).
- The report is still usable: brightness/diff/black-screen flags plus logcat
  often already say what happened (a black keyframe then a FATAL EXCEPTION = a
  crash, no description needed).

## the app installs and launches but nothing shows up in captured keyframes
`record_and_capture_keyframes` only keeps a frame when the screen changes enough
from the last KEPT one. If you start capturing before the app draws, the first
frame becomes the baseline and a subtle later transition can undershoot the
threshold. Try a longer `duration_seconds`, or lower `change_threshold` a bit.

## does minimizing a viewer window break screenshots?
No — `take_emulator_screenshot`/`record_and_capture_keyframes` read the guest
framebuffer over adb (`screencap`) or the engine's VNC framebuffer, never the
host desktop window. Window focus/occlusion/minimize is irrelevant. A blank
screenshot means the device isn't booted yet or `adb -s <serial>` is wrong, not
window visibility. (Colours are correct: the engine's VNC decode was fixed to
RGBX — a red UI element is red, not blue.)
