"""Android emulator control + on-device testing tools.

IMPORTANT ARCHITECTURE NOTE: unlike every other tool in this project, these
do NOT go through docker_sandbox.run_cmd / the Linux sandbox. The emulator
runs NATIVELY on the Windows host, so these tools shell out directly to host
executables via subprocess, and read/write files directly on the host
filesystem via tools.common.resolve_workspace_path (which maps a
'/workspace/...'-style path onto the same bind-mounted directory the Linux
sandbox sees at /workspace — so a screenshot saved here is still reachable by
read_file_chunk etc. inside the sandbox, and an APK built by
build_apk/sign_apk in the sandbox is still reachable here for
install_apk_on_emulator).

TWO BACKENDS, same tool interface:
  - "ldplayer" (DEFAULT) — LDPlayer, driven via its ldconsole.exe automation
    tool for lifecycle (create/reset/launch an instance) plus standard adb
    for everything else. LDPlayer ships its own ARM/ARM64 translation layer,
    which matters a lot here: a real x86_64-only AVD system image often
    cannot run arm64-v8a native libraries AT ALL (INSTALL_FAILED_NO_MATCHING_ABIS
    or a runtime crash on first native call), whereas LDPlayer's translation
    handles a lot of arm64-v8a code that a stock AVD just can't run, at much
    better speed than a true arm64-v8a AVD system image would manage without
    hardware ARM acceleration. This is why it's the default now.
  - "avd" — the original Android Studio / SDK emulator.exe + avdmanager path,
    kept as a fallback for anyone who doesn't have LDPlayer installed, or
    specifically wants a "reference" Android Studio system image.
Every tool below takes a `backend` parameter (default "ldplayer") and a
`device_name` override (defaults to a fixed, always-reused name per backend:
'omniagent_ld' for LDPlayer, 'omniagent_avd' for the AVD backend).

One emulator, reused: for either backend, the SAME device_name is targeted on
every call. It's created once if missing, and on every call with reset=True
(the default) it's brought back to a fresh state before use — LDPlayer via a
full quit+recreate of the instance (see reference/troubleshooting.md in the
emulator-testing skill for the tradeoffs), the AVD backend via -wipe-data.
Never a second device created alongside the reused one.

Screenshot capture is window-state-independent: record_and_capture_keyframes
and take_emulator_screenshot both use `adb exec-out screencap -p`, which
reads the emulated device's own framebuffer over the ADB protocol — the same
mechanism used to screenshot a real phone. This is deliberately NOT a
desktop/window-capture API (no BitBlt/PrintWindow/mss against the emulator's
window), so it keeps working identically whether the emulator window is
focused, occluded, or MINIMIZED. This holds for LDPlayer too — its window can
be freely minimized without affecting capture.
"""
import json
import os
import re
import shlex
import subprocess
import time

from tool_registry import registry
from tools.common import resolve_workspace_path, find_android_sdk_tools, find_ldplayer_tools
from tools._emulator_frame_capture import capture_keyframes
from tools._emulator_vision_analyze import analyze_session
from llm import CLINE_API_URL, API_KEY, MODEL_NAME

_DEFAULT_BACKEND = "ldplayer"
_DEFAULT_AVD = "omniagent_avd"
_DEFAULT_LDPLAYER_INSTANCE = "omniagent_ld"
_DEFAULT_SYSTEM_IMAGE = "system-images;android-33;google_apis;x86_64"


def _truthy(v):
    return v in (True, "true", "True", 1, "1")


def _is_batch(path):
    return bool(path) and path.lower().endswith((".bat", ".cmd"))


def _run(cmd_list, timeout=30, input_text=None):
    """Runs a host executable directly (no shell), handling .bat files
    (avdmanager/sdkmanager on Windows) which need a 'cmd /c' wrapper."""
    if cmd_list and _is_batch(cmd_list[0]):
        cmd_list = ["cmd", "/c"] + cmd_list
    try:
        proc = subprocess.run(
            cmd_list, capture_output=True, text=True, encoding="utf-8",
            errors="replace", timeout=timeout, input=input_text,
        )
        return {"returncode": proc.returncode, "stdout": proc.stdout, "stderr": proc.stderr}
    except subprocess.TimeoutExpired:
        return {"error": f"Command timed out after {timeout}s: {' '.join(cmd_list)}"}
    except FileNotFoundError as e:
        return {"error": f"Executable not found: {e}"}


def _default_device_name(backend):
    return _DEFAULT_LDPLAYER_INSTANCE if backend == "ldplayer" else _DEFAULT_AVD


# --------------------------------------------------------------------------
# LDPlayer control (ldconsole.exe) helpers
# --------------------------------------------------------------------------

def _ld_list_instances(ldconsole):
    """Parses `ldconsole.exe list2` (index,title,top_hwnd,bind_hwnd,
    android_started,pid,vbox_pid,width,height,dpi) into a list of dicts."""
    res = _run([ldconsole, "list2"], timeout=15)
    instances = []
    for line in (res.get("stdout") or "").splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split(",")
        if len(parts) < 5:
            continue
        try:
            idx = int(parts[0])
        except ValueError:
            continue
        instances.append({
            "index": idx,
            "name": parts[1],
            "android_started": parts[4] == "1",
            "pid": parts[5] if len(parts) > 5 else None,        # dnplayer.exe launcher process
            "vbox_pid": parts[6] if len(parts) > 6 else None,   # the actual VM process — its adb port is discovered from THIS pid
        })
    return instances


def _ld_find_instance(ldconsole, name):
    for inst in _ld_list_instances(ldconsole):
        if inst["name"] == name:
            return inst
    return None


def _ld_discover_port(vbox_pid, index):
    """Finds the TCP port LDPlayer actually bound for this instance's ADB
    bridge, by looking at which port its VM process (vbox_pid) is LISTENING
    on via Windows' netstat.

    This is used INSTEAD OF a fixed port formula on purpose: the commonly
    cited "5555 + 2*index" scheme (used by older LDPlayer 4.x automation
    guides) does NOT hold for every LDPlayer 9.x install — verified
    empirically against a real install where the actual bound port was a
    completely different value discoverable only this way. Falls back to
    the classic formula only if netstat-based discovery finds nothing (e.g.
    running under a restricted account without netstat access).
    """
    if vbox_pid:
        try:
            res = subprocess.run(["netstat", "-ano"], capture_output=True, text=True, timeout=15)
            candidates = []
            for line in res.stdout.splitlines():
                parts = line.split()
                if len(parts) < 4 or parts[0] != "TCP" or parts[-2] != "LISTENING":
                    continue
                if parts[-1] != str(vbox_pid):
                    continue
                addr = parts[1]
                if ":" not in addr:
                    continue
                try:
                    candidates.append(int(addr.rsplit(":", 1)[1]))
                except ValueError:
                    continue
            if candidates:
                # Prefer a port that actually looks like an adb-ish port if
                # there are several; otherwise just take whatever was found.
                for p in candidates:
                    if p == 2222 or 5555 <= p <= 5700:
                        return p
                return candidates[0]
        except (subprocess.TimeoutExpired, OSError):
            pass
    return 5555 + index * 2


def _resolve_adb_path(ldplayer_adb=None):
    """Prefer the Android SDK's adb.exe (more consistently up to date);
    fall back to LDPlayer's own bundled adb.exe if the SDK isn't found."""
    try:
        return find_android_sdk_tools()["adb"], None
    except RuntimeError as sdk_err:
        if ldplayer_adb:
            return ldplayer_adb, None
        return None, {"error": (
            "No adb.exe found: neither the Android SDK's platform-tools nor LDPlayer's own bundled "
            f"adb.exe are available. ({sdk_err})"
        )}


def _resolve_serial(backend, device_name=None):
    """Returns (adb_path, serial) for the currently active device of the
    given backend, or (None, error_dict) if it can't be resolved. Stateless
    by design — always re-derives the serial fresh (LDPlayer can reassign an
    instance's index across a recreate, so nothing about the serial is
    cached between calls)."""
    device_name = device_name or _default_device_name(backend)

    if backend == "ldplayer":
        try:
            ld = find_ldplayer_tools()
        except RuntimeError as e:
            return None, {"error": str(e)}
        adb, err = _resolve_adb_path(ld.get("adb"))
        if err:
            return None, err
        inst = _ld_find_instance(ld["ldconsole"], device_name)
        if inst is None:
            return None, {"error": f"LDPlayer instance '{device_name}' not found. Call ensure_emulator_running first."}
        serial = f"127.0.0.1:{_ld_discover_port(inst.get('vbox_pid'), inst['index'])}"
        _run([adb, "connect", serial], timeout=10)
        return adb, serial

    # backend == "avd"
    try:
        sdk = find_android_sdk_tools()
    except RuntimeError as e:
        return None, {"error": str(e)}
    adb = sdk["adb"]
    devices_res = _run([adb, "devices"], timeout=15)
    serial = None
    for line in (devices_res.get("stdout") or "").splitlines():
        if line.startswith("emulator-") and "device" in line:
            serial = line.split()[0]
            break
    if not serial:
        return None, {"error": "No running AVD emulator found. Call ensure_emulator_running first."}
    return adb, serial


def _ensure_ldplayer_running(device_name, reset, boot_timeout):
    try:
        ld = find_ldplayer_tools()
    except RuntimeError as e:
        return {"error": str(e)}
    ldconsole = ld["ldconsole"]
    adb, err = _resolve_adb_path(ld.get("adb"))
    if err:
        return err

    log = []
    inst = _ld_find_instance(ldconsole, device_name)

    if reset and inst is not None:
        log.append(f"Resetting LDPlayer instance '{device_name}' for a fresh session (quit + recreate)...")
        # quit/remove are both async acks (return immediately, before the
        # underlying VM process/instance directory has actually gone away) —
        # calling `add` right after without polling can silently collide
        # with the not-yet-freed name. Poll each step to completion instead
        # of a fixed sleep.
        _run([ldconsole, "quit", "--name", device_name], timeout=30)
        for _ in range(20):
            cur = _ld_find_instance(ldconsole, device_name)
            if cur is None or not cur["android_started"]:
                break
            time.sleep(2)
        _run([ldconsole, "remove", "--name", device_name], timeout=30)
        for _ in range(20):
            if _ld_find_instance(ldconsole, device_name) is None:
                break
            time.sleep(2)
        inst = None

    if inst is None:
        log.append(f"Creating LDPlayer instance '{device_name}'...")
        create_res = _run([ldconsole, "add", "--name", device_name], timeout=60)
        # `add`'s own return code is unreliable (observed returncode=1 on a
        # run that actually succeeded) — always re-query list2 to find out
        # what really happened instead of trusting it.
        for _ in range(10):
            inst = _ld_find_instance(ldconsole, device_name)
            if inst is not None:
                break
            time.sleep(2)
        if inst is None:
            return {"error": f"Failed to create LDPlayer instance '{device_name}'. ldconsole output: {create_res}"}
        log.append(f"Created (index {inst['index']}).")
        # Enable root/adb debugging — some LDPlayer builds ship with this off
        # by default on a freshly created instance, which leaves adbd
        # unreachable even once the instance is fully booted.
        _run([ldconsole, "modify", "--name", device_name, "--root", "1"], timeout=15)

    if not inst["android_started"]:
        log.append(f"Launching LDPlayer instance '{device_name}' (index {inst['index']})...")
        _run([ldconsole, "launch", "--name", device_name], timeout=15)
    else:
        log.append(f"LDPlayer instance '{device_name}' already running.")

    start = time.time()
    booted = False
    serial = None
    while time.time() - start < boot_timeout:
        cur = _ld_find_instance(ldconsole, device_name)
        if cur is None:
            time.sleep(2)
            continue
        port = _ld_discover_port(cur.get("vbox_pid"), cur["index"])
        serial = f"127.0.0.1:{port}"
        _run([adb, "connect", serial], timeout=10)
        prop_res = _run([adb, "-s", serial, "shell", "getprop", "sys.boot_completed"], timeout=10)
        if (prop_res.get("stdout") or "").strip() == "1":
            booted = True
            break
        time.sleep(2)

    if booted:
        log.append(f"BOOT_OK (serial={serial})")
    else:
        log.append(f"BOOT_TIMEOUT after {boot_timeout}s (last tried serial={serial})")

    return {"stdout": "\n".join(log)}


def _ensure_avd_running(device_name, system_image, device_profile, reset, boot_timeout, headless):
    try:
        sdk = find_android_sdk_tools()
    except RuntimeError as e:
        return {"error": str(e)}
    adb, emulator, avdmanager = sdk["adb"], sdk["emulator"], sdk["avdmanager"]
    log = []

    # 1. Ensure the AVD exists — create it once, never recreate if present.
    if avdmanager:
        list_res = _run([avdmanager, "list", "avd"], timeout=30)
        if f"Name: {device_name}" not in (list_res.get("stdout") or ""):
            log.append(f"AVD '{device_name}' not found — creating it (system_image={system_image}, device={device_profile})...")
            create_res = _run(
                [avdmanager, "create", "avd", "-n", device_name, "-k", system_image, "--device", device_profile, "--force"],
                timeout=180, input_text="no\n",
            )
            log.append((create_res.get("stdout") or "") + (create_res.get("stderr") or "") + (create_res.get("error") or ""))
    else:
        log.append("WARNING: avdmanager not found in this SDK (no cmdline-tools package) — assuming the AVD already exists. Create it via Android Studio's Device Manager if it doesn't.")

    # 2. Reset: kill any running instance of this AVD before rebooting fresh.
    if reset:
        devices_res = _run([adb, "devices"], timeout=15)
        for line in (devices_res.get("stdout") or "").splitlines():
            if line.startswith("emulator-"):
                serial = line.split()[0]
                log.append(f"Killing existing emulator instance: {serial}")
                _run([adb, "-s", serial, "emu", "kill"], timeout=15)
        for _ in range(10):
            devices_res = _run([adb, "devices"], timeout=15)
            if not any(l.startswith("emulator-") for l in (devices_res.get("stdout") or "").splitlines()):
                break
            time.sleep(2)

    # 3. Launch fresh, as a normal visible window by default.
    launch_cmd = [emulator, "-avd", device_name, "-no-boot-anim"]
    if reset:
        launch_cmd.append("-wipe-data")
    if headless:
        launch_cmd += ["-no-window", "-no-audio"]
    else:
        launch_cmd += ["-gpu", "auto"]

    try:
        log_dir = resolve_workspace_path(".emulator")
    except RuntimeError:
        log_dir = os.path.join(os.path.expanduser("~"), ".omniagent_emulator")
    os.makedirs(log_dir, exist_ok=True)
    log_path = os.path.join(log_dir, "emulator.log")

    creationflags = 0
    if os.name == "nt":
        creationflags = subprocess.CREATE_NEW_PROCESS_GROUP | getattr(subprocess, "DETACHED_PROCESS", 0)
    with open(log_path, "wb") as logf:
        subprocess.Popen(
            launch_cmd, stdout=logf, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
            creationflags=creationflags, close_fds=True,
        )
    log.append(f"Launched: {' '.join(launch_cmd)}")
    log.append(f"Emulator log: {log_path}")

    # 4. Wait for boot completion.
    wait_res = _run([adb, "wait-for-device"], timeout=60)
    log.append(wait_res.get("stdout") or wait_res.get("error") or "")

    start = time.time()
    booted = False
    serial = None
    while time.time() - start < boot_timeout:
        devices_res = _run([adb, "devices"], timeout=15)
        for line in (devices_res.get("stdout") or "").splitlines():
            if line.startswith("emulator-") and "device" in line:
                serial = line.split()[0]
        if serial:
            prop_res = _run([adb, "-s", serial, "shell", "getprop", "sys.boot_completed"], timeout=10)
            if (prop_res.get("stdout") or "").strip() == "1":
                booted = True
                break
        time.sleep(2)

    if booted:
        log.append(f"BOOT_OK (serial={serial})")
    else:
        log.append(f"BOOT_TIMEOUT after {boot_timeout}s")
        try:
            with open(log_path, encoding="utf-8", errors="replace") as f:
                tail = f.readlines()[-40:]
            log.append("--- last 40 lines of emulator.log ---")
            log.append("".join(tail))
        except OSError:
            pass

    return {"stdout": "\n".join(log)}


@registry.register(
    name="ensure_emulator_running",
    description=(
        "Boots the project's Android emulator, running NATIVELY on this Windows machine (NOT inside "
        "the Linux sandbox). Two backends: 'ldplayer' (DEFAULT — LDPlayer, which ships its own "
        "ARM/ARM64 translation layer; use this for APKs with arm64-v8a native libraries, since a "
        "stock x86_64 AVD system image often can't run those at all) or 'avd' (the Android Studio SDK "
        "emulator.exe path). Creates the device once if it doesn't exist yet, and reuses that SAME "
        "device on every later call — this never creates a second/duplicate virtual device. By "
        "default (reset=true) it also resets it to a clean state before use — LDPlayer via a full "
        "quit+recreate of the instance, the AVD backend via -wipe-data. Waits for the device to "
        "finish booting before returning."
    ),
    params_schema={
        "backend": "string (optional, default 'ldplayer' — 'ldplayer' or 'avd')",
        "device_name": "string (optional — the persistent device name; always reused, never duplicated. Defaults to 'omniagent_ld' for backend='ldplayer' or 'omniagent_avd' for backend='avd')",
        "system_image": "string (optional, AVD backend only, default 'system-images;android-33;google_apis;x86_64'; only used the first time an AVD is created)",
        "device_profile": "string (optional, AVD backend only, default 'pixel_5' — an avdmanager device profile name)",
        "reset": "boolean (optional, default true — bring the device back to a clean state before use; set false to resume the existing running/saved instance as-is)",
        "boot_timeout": "integer (optional, default 300 seconds)",
        "headless": "boolean (optional, AVD backend only, default false — LDPlayer doesn't support a true headless launch via automation, but its window can be freely minimized without affecting screenshot capture either way)"
    },
    output="A log of what happened (device creation/reset if needed, the launch action, boot wait progress) ending in 'BOOT_OK (serial=...)' or 'BOOT_TIMEOUT after Ns'.",
    when_to_use="Call this FIRST, before install_apk_on_emulator/launch_app_on_emulator/any adb-based tool. Safe to call repeatedly — it always targets the same virtual device and (by default) resets it to a clean state each time rather than creating a new one. Prefer the default 'ldplayer' backend for APKs with arm64-v8a native code."
)
def ensure_emulator_running(backend=_DEFAULT_BACKEND, device_name=None, system_image=_DEFAULT_SYSTEM_IMAGE,
                             device_profile="pixel_5", reset=True, boot_timeout=300, headless=False):
    backend = (backend or _DEFAULT_BACKEND).strip().lower()
    if backend not in ("ldplayer", "avd"):
        return {"error": "backend must be 'ldplayer' or 'avd'."}
    device_name = device_name or _default_device_name(backend)
    reset = _truthy(reset)
    try:
        boot_timeout = int(boot_timeout)
    except (TypeError, ValueError):
        boot_timeout = 300

    if backend == "ldplayer":
        return _ensure_ldplayer_running(device_name, reset, boot_timeout)
    return _ensure_avd_running(device_name, system_image, device_profile, reset, boot_timeout, _truthy(headless))


@registry.register(
    name="adb_shell",
    description=(
        "Runs an arbitrary 'adb shell <command>' against the running emulator — a raw escape hatch "
        "for anything the higher-level tools don't cover: simulating taps/swipes/key presses "
        "('input tap 500 800', 'input keyevent 4' for back), listing packages ('pm list packages'), "
        "dumping activity/window state ('dumpsys activity activities'), reading properties "
        "('getprop ro.build.version.release'), etc."
    ),
    params_schema={
        "command": "string (the command to run after 'adb shell', e.g. 'input keyevent 4' or 'pm list packages -3')",
        "backend": "string (optional, default 'ldplayer' — must match whichever backend ensure_emulator_running booted)",
        "device_name": "string (optional — must match the device_name ensure_emulator_running used, if you overrode it)",
        "timeout_seconds": "integer (optional, default 30, max 180)"
    },
    output="Raw stdout/stderr of the adb shell command.",
    when_to_use="Use this for interactive device control (tap/swipe/back/home) or ad-hoc inspection not covered by install_apk_on_emulator/launch_app_on_emulator/get_logcat/take_emulator_screenshot."
)
def adb_shell(command, backend=_DEFAULT_BACKEND, device_name=None, timeout_seconds=30):
    adb, serial_or_err = _resolve_serial(backend, device_name)
    if adb is None:
        return serial_or_err
    try:
        timeout_seconds = max(5, min(int(timeout_seconds), 180))
    except (TypeError, ValueError):
        timeout_seconds = 30
    args = shlex.split(command)
    return _run([adb, "-s", serial_or_err, "shell"] + args, timeout=timeout_seconds)


@registry.register(
    name="install_apk_on_emulator",
    description="Installs an APK onto the running emulator via 'adb install'. Replaces an existing install of the same package by default, and grants all runtime permissions automatically so the app doesn't get stuck on a permission dialog during an unattended test.",
    params_schema={
        "apk_path": "string (path to the .apk, relative to /workspace, e.g. 'modified.apk')",
        "backend": "string (optional, default 'ldplayer' — must match whichever backend ensure_emulator_running booted)",
        "device_name": "string (optional — must match the device_name ensure_emulator_running used, if you overrode it)",
        "replace": "boolean (optional, default true — adds -r to allow reinstalling over an existing install)",
        "grant_permissions": "boolean (optional, default true — adds -g to auto-grant all runtime permissions)"
    },
    output="adb install's output — 'Success' on success, or the specific INSTALL_FAILED_* error (e.g. INSTALL_FAILED_NO_MATCHING_ABIS if the APK's native libraries don't match the emulator's supported architectures — try backend='ldplayer' if you're on 'avd' and hitting this with an arm64-v8a APK).",
    when_to_use="Call this after ensure_emulator_running, before launch_app_on_emulator, any time you have a newly built/signed APK to test."
)
def install_apk_on_emulator(apk_path, backend=_DEFAULT_BACKEND, device_name=None, replace=True, grant_permissions=True):
    adb, serial_or_err = _resolve_serial(backend, device_name)
    if adb is None:
        return serial_or_err
    try:
        host_apk_path = resolve_workspace_path(apk_path)
    except RuntimeError as e:
        return {"error": str(e)}
    if not os.path.isfile(host_apk_path):
        return {"error": f"APK not found at resolved path: {host_apk_path}"}
    args = [adb, "-s", serial_or_err, "install"]
    if _truthy(replace):
        args.append("-r")
    if _truthy(grant_permissions):
        args.append("-g")
    args.append(host_apk_path)
    return _run(args, timeout=120)


@registry.register(
    name="launch_app_on_emulator",
    description="Launches an installed app on the emulator. Without an activity, uses 'monkey' to fire the app's default launcher intent (works without knowing the exact activity name); with an activity, starts that exact component via 'am start'.",
    params_schema={
        "package_name": "string (the app's package name, e.g. 'com.example.app' — find it with search_smali/grep_file on AndroidManifest.xml, or 'adb_shell pm list packages' after installing)",
        "activity": "string (optional, fully-qualified activity class, e.g. '.MainActivity' or 'com.example.app.MainActivity' — omit to just launch the default launcher activity)",
        "backend": "string (optional, default 'ldplayer' — must match whichever backend ensure_emulator_running booted)",
        "device_name": "string (optional — must match the device_name ensure_emulator_running used, if you overrode it)"
    },
    output="adb's launch output — for the monkey path, a short log ending in the injected launch event; for am start, the ComponentInfo/status of the started activity, or an error if the package/activity doesn't exist or isn't exported.",
    when_to_use="Call this after install_apk_on_emulator, right before record_and_capture_keyframes so the capture window covers the app's actual startup."
)
def launch_app_on_emulator(package_name, activity=None, backend=_DEFAULT_BACKEND, device_name=None):
    adb, serial_or_err = _resolve_serial(backend, device_name)
    if adb is None:
        return serial_or_err
    if activity:
        target = activity if "/" in activity else f"{package_name}/{activity}"
        return _run([adb, "-s", serial_or_err, "shell", "am", "start", "-n", target], timeout=30)
    return _run([adb, "-s", serial_or_err, "shell", "monkey", "-p", package_name,
                 "-c", "android.intent.category.LAUNCHER", "1"], timeout=30)


@registry.register(
    name="get_logcat",
    description=(
        "Dumps the emulator's current logcat buffer, optionally filtered by a regex pattern and/or "
        "minimum priority. Use clear_first=true to wipe the buffer right before starting a test so a "
        "later dump only contains lines from that test window (record_and_capture_keyframes already "
        "does this automatically for its own session)."
    ),
    params_schema={
        "filter_pattern": "string (optional, Python regex, case-insensitive, e.g. 'FATAL|AndroidRuntime|Exception')",
        "max_lines": "integer (optional, default 300 — the LAST N matching lines are returned)",
        "clear_first": "boolean (optional, default false — if true, clears the buffer and returns immediately instead of dumping)",
        "priority": "string (optional, e.g. 'E' for error-and-above, 'W' for warning-and-above — passed as adb logcat's '*:PRIORITY' filter)",
        "backend": "string (optional, default 'ldplayer' — must match whichever backend ensure_emulator_running booted)",
        "device_name": "string (optional — must match the device_name ensure_emulator_running used, if you overrode it)"
    },
    output="The requested logcat lines (most recent last), or a confirmation message if clear_first was used.",
    when_to_use="Use this to inspect crashes/errors after a test, or to get a clean log window bracketing a specific manual action (adb_shell input tap, etc.)."
)
def get_logcat(filter_pattern=None, max_lines=300, clear_first=False, priority=None, backend=_DEFAULT_BACKEND, device_name=None):
    adb, serial_or_err = _resolve_serial(backend, device_name)
    if adb is None:
        return serial_or_err
    if _truthy(clear_first):
        _run([adb, "-s", serial_or_err, "logcat", "-c"], timeout=15)
        return {"stdout": "Logcat buffer cleared."}
    try:
        max_lines = int(max_lines)
    except (TypeError, ValueError):
        max_lines = 300
    args = [adb, "-s", serial_or_err, "logcat", "-d"]
    if priority:
        args.append(f"*:{priority}")
    res = _run(args, timeout=60)
    if res.get("error"):
        return res
    text = res.get("stdout", "")
    if filter_pattern:
        pat = re.compile(filter_pattern, re.IGNORECASE)
        lines = [l for l in text.splitlines() if pat.search(l)]
    else:
        lines = text.splitlines()
    tail = lines[-max_lines:]
    return {"stdout": "\n".join(tail) if tail else "(no matching log lines)"}


@registry.register(
    name="take_emulator_screenshot",
    description=(
        "Takes ONE screenshot of the emulator's current screen right now, on demand, via "
        "'adb exec-out screencap -p' — this reads the device's own framebuffer over the ADB "
        "protocol, so it works identically whether the emulator's window is focused, occluded, or "
        "MINIMIZED (it never looks at the host window at all). This is the simple/manual counterpart "
        "to record_and_capture_keyframes — use this when YOU decide a specific moment is worth "
        "capturing, rather than the automatic change-detection algorithm."
    ),
    params_schema={
        "label": "string (optional, a short label prefixed to the saved filename, e.g. 'after_login_tap')",
        "backend": "string (optional, default 'ldplayer' — must match whichever backend ensure_emulator_running booted)",
        "device_name": "string (optional — must match the device_name ensure_emulator_running used, if you overrode it)"
    },
    output="The saved file's /workspace-relative path and size in bytes.",
    when_to_use="Use this for a single targeted screenshot at a moment you choose. For an unattended test window where you want the interesting frames found automatically, use record_and_capture_keyframes instead."
)
def take_emulator_screenshot(label=None, backend=_DEFAULT_BACKEND, device_name=None):
    adb, serial_or_err = _resolve_serial(backend, device_name)
    if adb is None:
        return serial_or_err
    try:
        host_dir = resolve_workspace_path("screenshots/manual")
    except RuntimeError as e:
        return {"error": str(e)}
    os.makedirs(host_dir, exist_ok=True)
    ts = time.strftime("%Y%m%d_%H%M%S")
    label_part = f"{label}_" if label else ""
    fname = f"{label_part}{ts}.png"
    fpath = os.path.join(host_dir, fname)
    try:
        proc = subprocess.run([adb, "-s", serial_or_err, "exec-out", "screencap", "-p"], capture_output=True, timeout=30)
    except subprocess.TimeoutExpired:
        return {"error": "screencap timed out after 30s"}
    if proc.returncode != 0 or not proc.stdout:
        return {"error": f"screencap failed: {proc.stderr.decode('utf-8', 'replace')}"}
    with open(fpath, "wb") as f:
        f.write(proc.stdout)
    return {"stdout": f"Saved: /workspace/screenshots/manual/{fname} ({len(proc.stdout)} bytes)"}


@registry.register(
    name="record_and_capture_keyframes",
    description=(
        "Watches the emulator's screen for a fixed duration, sampling screenshots at a fixed interval "
        "via 'adb exec-out screencap -p' (window-state-independent — works even if the emulator "
        "window is minimized), and keeps only the frames where the screen changed MEANINGFULLY — a "
        "small looping loading animation (a spinner, a pulsing icon) does NOT trigger a new keyframe, "
        "but a real page/screen transition does, and a transition into a black screen is always "
        "flagged (a common crash signature). Also clears logcat right before starting and dumps it "
        "right after finishing, so the exact same window is captured in both screenshots and logs. "
        "Writes everything to /workspace/screenshots/<session_name>/ (each keyframe PNG + "
        "metadata.json + logcat.txt) — call analyze_keyframes next to get plain-language descriptions "
        "of each keyframe, then generate_test_report to assemble it all into a Markdown report."
    ),
    params_schema={
        "session_name": "string (a name for this test session, e.g. 'login_flow_v2' — used as the output subfolder name)",
        "duration_seconds": "number (optional, default 20 — how long to watch the screen)",
        "interval_seconds": "number (optional, default 1.0 — how often to sample a frame)",
        "change_threshold": "number (optional, default 14 — average per-pixel brightness difference (0-255 scale, on a downscaled grayscale frame) versus the last KEPT keyframe required to count as a real change)",
        "black_threshold": "number (optional, default 10 — a frame with average brightness below this is flagged black_screen even if the raw diff was modest)",
        "sample_scale_w": "integer (optional, default 160 — frames are downscaled to this width before diffing, for speed; this does not affect the resolution of the SAVED keyframe PNGs, which are always full-resolution)",
        "capture_logcat": "boolean (optional, default true — clear logcat before starting and dump it to logcat.txt in the session folder when done)",
        "backend": "string (optional, default 'ldplayer' — must match whichever backend ensure_emulator_running booted)",
        "device_name": "string (optional — must match the device_name ensure_emulator_running used, if you overrode it)"
    },
    output="A summary: how many raw samples were taken, how many keyframes were kept, and for each keyframe its index, timestamp, diff score, and whether it was flagged as a black screen. The actual images are NOT returned here (they're saved to disk) — use analyze_keyframes to get a description of each one.",
    when_to_use="Call this after launch_app_on_emulator to watch what happens as the app starts/you interact with it. This is the tool for 'test how it performs' — it decides on its own which moments were visually significant instead of you polling take_emulator_screenshot on a schedule."
)
def record_and_capture_keyframes(session_name, duration_seconds=20, interval_seconds=1.0, change_threshold=14,
                                  black_threshold=10, sample_scale_w=160, capture_logcat=True,
                                  backend=_DEFAULT_BACKEND, device_name=None):
    adb, serial_or_err = _resolve_serial(backend, device_name)
    if adb is None:
        return serial_or_err
    try:
        session_dir = resolve_workspace_path(f"screenshots/{session_name}")
    except RuntimeError as e:
        return {"error": str(e)}
    os.makedirs(session_dir, exist_ok=True)

    do_logcat = _truthy(capture_logcat)
    if do_logcat:
        _run([adb, "-s", serial_or_err, "logcat", "-c"], timeout=15)

    try:
        duration_seconds = float(duration_seconds)
        interval_seconds = float(interval_seconds)
        change_threshold = float(change_threshold)
        black_threshold = float(black_threshold)
        sample_scale_w = int(sample_scale_w)
    except (TypeError, ValueError):
        return {"error": "duration_seconds/interval_seconds/change_threshold/black_threshold/sample_scale_w must be numeric."}

    try:
        summary = capture_keyframes(adb, session_dir, duration_seconds, interval_seconds,
                                     change_threshold, black_threshold, sample_scale_w, serial=serial_or_err)
    except Exception as e:
        return {"error": f"Frame capture failed: {e}"}

    if do_logcat:
        logcat_res = _run([adb, "-s", serial_or_err, "logcat", "-d"], timeout=30)
        with open(os.path.join(session_dir, "logcat.txt"), "w", encoding="utf-8", errors="replace") as f:
            f.write(logcat_res.get("stdout", ""))

    return {"stdout": summary}


@registry.register(
    name="analyze_keyframes",
    description=(
        "Sends each keyframe PNG captured by record_and_capture_keyframes to a vision model for a "
        "plain-language description (what screen is shown, any visible error/crash dialog, whether "
        "it's blank/broken/misaligned), and writes the descriptions back into that session's "
        "metadata.json. backend='auto' (default) first tries the SAME GLM backend that powers this "
        "agent, formatted as a vision-style chat message; if that fails or the reply doesn't actually "
        "describe an image, it automatically falls back to a local Ollama vision model on this same "
        "machine (http://localhost:11434) — requires Ollama running with a vision model pulled (e.g. "
        "'ollama pull llava'). If both fail, keyframes are left undescribed and generate_test_report "
        "will still produce a report from timing/brightness data and logcat alone. NOTE: this "
        "'backend' parameter is the VISION backend (api/ollama/auto), unrelated to the emulator "
        "backend (ldplayer/avd) used by the other tools in this file."
    ),
    params_schema={
        "session_name": "string (must match a session_name already captured by record_and_capture_keyframes)",
        "backend": "string (optional: 'auto' (default, try API then Ollama), 'api' (GLM backend only), or 'ollama' (local Ollama only))",
        "ollama_model": "string (optional, default 'llava' — the local Ollama vision model to use, must already be pulled)",
        "prompt": "string (optional — override the default screenshot-description prompt sent to the vision model)"
    },
    output="For each keyframe: which backend actually answered ('api' or 'ollama') and its description, or an error if both backends failed for that frame. Ends with an overall 'Analyzed N/M keyframe(s). Backend used: ...' summary line.",
    when_to_use="Call this after record_and_capture_keyframes, before generate_test_report, so the report includes descriptions instead of just raw image links."
)
def analyze_keyframes(session_name, backend="auto", ollama_model="llava", prompt=None):
    try:
        session_dir = resolve_workspace_path(f"screenshots/{session_name}")
    except RuntimeError as e:
        return {"error": str(e)}
    if not os.path.isdir(session_dir):
        return {"error": f"No session directory found at {session_dir} — run record_and_capture_keyframes first."}
    cfg = {
        "backend": backend,
        "prompt": prompt,
        "cline_api_url": CLINE_API_URL,
        "cline_api_key": API_KEY,
        "cline_model": MODEL_NAME,
        "ollama_url": "http://localhost:11434",
        "ollama_model": ollama_model,
    }
    try:
        summary = analyze_session(session_dir, cfg)
    except FileNotFoundError:
        return {"error": f"metadata.json missing in {session_dir} — run record_and_capture_keyframes first."}
    return {"stdout": summary}


@registry.register(
    name="generate_test_report",
    description=(
        "Assembles a Markdown test report from a recorded session: every keyframe (with its image "
        "link, timestamp, diff score, black-screen flag, and vision description if analyze_keyframes "
        "was run) plus the last 400 lines of logcat captured during that same session window. Written "
        "to /workspace/test_reports/<session_name>.md — this is the file the TEXT-ONLY primary agent "
        "loop reads (via read_file_chunk) to decide what to fix, since it can't view the images "
        "itself; the vision descriptions inside the report are its window into what actually happened "
        "on screen."
    ),
    params_schema={
        "session_name": "string (must match a session_name already captured by record_and_capture_keyframes)",
        "package_name": "string (optional, included in the report header for context)",
        "apk_path": "string (optional, included in the report header for context)"
    },
    output="Confirmation of the report path written, e.g. 'Report written to /workspace/test_reports/<session_name>.md'.",
    when_to_use="Call this last, after record_and_capture_keyframes (and ideally analyze_keyframes). Then read_file_chunk the resulting .md to see what the test found and decide on fixes."
)
def generate_test_report(session_name, package_name=None, apk_path=None):
    try:
        session_dir = resolve_workspace_path(f"screenshots/{session_name}")
        report_dir = resolve_workspace_path("test_reports")
    except RuntimeError as e:
        return {"error": str(e)}
    os.makedirs(report_dir, exist_ok=True)
    meta_path = os.path.join(session_dir, "metadata.json")
    if not os.path.isfile(meta_path):
        return {"error": f"No metadata.json in {session_dir} — run record_and_capture_keyframes first."}
    with open(meta_path, encoding="utf-8") as f:
        meta = json.load(f)

    logcat_path = os.path.join(session_dir, "logcat.txt")
    logcat_text = ""
    if os.path.isfile(logcat_path):
        with open(logcat_path, encoding="utf-8", errors="replace") as f:
            logcat_text = "\n".join(f.read().splitlines()[-400:])

    out = [f"# APK Test Report -- {session_name}"]
    if package_name:
        out.append(f"Package: {package_name}")
    if apk_path:
        out.append(f"APK: {apk_path}")
    out.append(f"Duration: {meta.get('duration_seconds')}s (sampled every {meta.get('interval_seconds')}s)")
    out.append(f"Samples taken: {meta.get('samples_taken')} / Keyframes kept: {len(meta.get('keyframes', []))}")
    out.append(f"Vision backend used: {meta.get('vision_backend_used')}")
    out.append("")
    out.append("## Keyframes")
    for kf in meta.get("keyframes", []):
        flag = " **[BLACK SCREEN]**" if kf.get("black_screen") else ""
        out.append(f"### Frame {kf['index']} -- t={kf['t_seconds']}s (diff={kf['diff_score']}){flag}")
        out.append(f"![frame](../screenshots/{session_name}/{kf['file']})")
        desc = kf.get("vision_description")
        if desc:
            out.append(f"Description ({kf.get('vision_backend')}): {desc}")
        else:
            err = kf.get("vision_error") or "not yet analyzed — run analyze_keyframes first"
            out.append(f"Description: (unavailable — {err})")
        out.append("")
    out.append("## Logcat (last 400 lines captured during the test window)")
    out.append("```")
    out.append(logcat_text if logcat_text else "(no logcat captured)")
    out.append("```")

    report_path = os.path.join(report_dir, f"{session_name}.md")
    with open(report_path, "w", encoding="utf-8") as f:
        f.write("\n".join(out))
    return {"stdout": f"Report written to /workspace/test_reports/{session_name}.md"}


@registry.register(
    name="run_apk_test_session",
    description=(
        "One-shot orchestrator that runs the entire test pipeline: ensure_emulator_running -> "
        "install_apk_on_emulator -> launch_app_on_emulator -> record_and_capture_keyframes -> "
        "analyze_keyframes -> generate_test_report. Use this for the common case of 'test this APK "
        "and tell me how it performs' in a single call; use the individual tools instead when you "
        "need finer control (e.g. re-running analyze_keyframes with a different vision backend, or "
        "driving the app interactively with adb_shell between capture windows). Defaults to the "
        "'ldplayer' emulator backend (better arm64-v8a native library support on an x86_64 host)."
    ),
    params_schema={
        "apk_path": "string (path to the .apk to test, relative to /workspace)",
        "package_name": "string (the app's package name, needed to launch it and label the report)",
        "activity": "string (optional, specific activity to launch; omit to use the default launcher activity)",
        "backend": "string (optional, default 'ldplayer' — 'ldplayer' or 'avd', see ensure_emulator_running)",
        "device_name": "string (optional — the persistent, reused device name; defaults per backend)",
        "system_image": "string (optional, AVD backend only, default 'system-images;android-33;google_apis;x86_64'; only used the first time this AVD is created)",
        "device_profile": "string (optional, AVD backend only, default 'pixel_5')",
        "duration_seconds": "number (optional, default 20 — how long to watch the screen after launch)",
        "vision_backend": "string (optional, default 'auto' — 'auto', 'api', or 'ollama', see analyze_keyframes)",
        "ollama_model": "string (optional, default 'llava')",
        "reset": "boolean (optional, default true — reset the emulator to a clean state before this test)",
        "boot_timeout": "integer (optional, default 300 seconds)"
    },
    output="A summary of each pipeline stage plus the path to the generated Markdown report — read that report with read_file_chunk for the full picture (keyframe descriptions + logcat).",
    when_to_use="Use this as the default way to test a freshly built/signed APK end-to-end. Fall back to the individual tools (ensure_emulator_running, install_apk_on_emulator, etc.) if you need to interleave manual adb_shell actions between steps, or re-run just one stage."
)
def run_apk_test_session(apk_path, package_name, activity=None, backend=_DEFAULT_BACKEND, device_name=None,
                          system_image=_DEFAULT_SYSTEM_IMAGE, device_profile="pixel_5",
                          duration_seconds=20, vision_backend="auto", ollama_model="llava",
                          reset=True, boot_timeout=300):
    session_name = f"{package_name.replace('.', '_')}_{int(time.time())}"
    log = []

    boot_res = ensure_emulator_running(backend, device_name, system_image, device_profile, reset, boot_timeout)
    log.append("[ensure_emulator_running]\n" + (boot_res.get("stdout") or boot_res.get("error") or ""))
    if "BOOT_OK" not in (boot_res.get("stdout") or ""):
        return {"stdout": "Emulator failed to boot -- aborting test session.\n\n" + "\n\n".join(log)[:4000]}

    install_res = install_apk_on_emulator(apk_path, backend=backend, device_name=device_name)
    log.append("[install_apk_on_emulator]\n" + (install_res.get("stdout") or install_res.get("error") or ""))

    launch_res = launch_app_on_emulator(package_name, activity, backend=backend, device_name=device_name)
    log.append("[launch_app_on_emulator]\n" + (launch_res.get("stdout") or launch_res.get("error") or ""))

    capture_res = record_and_capture_keyframes(session_name, duration_seconds=duration_seconds,
                                                 backend=backend, device_name=device_name)
    log.append("[record_and_capture_keyframes]\n" + (capture_res.get("stdout") or capture_res.get("error") or ""))

    analyze_res = analyze_keyframes(session_name, backend=vision_backend, ollama_model=ollama_model)
    log.append("[analyze_keyframes]\n" + (analyze_res.get("stdout") or analyze_res.get("error") or ""))

    report_res = generate_test_report(session_name, package_name=package_name, apk_path=apk_path)
    log.append("[generate_test_report]\n" + (report_res.get("stdout") or report_res.get("error") or ""))

    report_path = f"/workspace/test_reports/{session_name}.md"
    summary = f"Test session '{session_name}' complete.\nReport: {report_path}\n\n" + "\n\n".join(log)
    return {"stdout": summary[:6000] + f"\n\n[Read the full report with read_file_chunk on {report_path}]"}
