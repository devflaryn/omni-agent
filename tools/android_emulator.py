"""Android emulator control + on-device testing tools.

IMPORTANT ARCHITECTURE NOTE: unlike every other tool in this project, these
do NOT go through docker_sandbox.run_cmd / the Linux sandbox. The emulator
runs NATIVELY on the host machine (macOS / Linux / Windows), so these tools
shell out directly to host executables via subprocess (resolved with
OS-appropriate names, e.g. `adb` vs `adb.exe`), and read/write files directly
on the host
filesystem via tools.common.resolve_workspace_path (which maps a
'/workspace/...'-style path onto the same bind-mounted directory the Linux
sandbox sees at /workspace — so a screenshot saved here is still reachable by
read_file_chunk etc. inside the sandbox, and an APK built by
recompile_apk/sign_apk in the sandbox is still reachable here for
install_apk_on_emulator).

ONE BACKEND: omnidroid (QEMU). Every "run the app on a VM" flow goes through the
self-contained headless **omnidroid** engine — a QEMU/Bliss-OS (Android 13,
x86_64, libndk ARM translation) runner on x86 hosts, and the LineageOS arm64
base on an arm64 host — driven through the FROZEN CONTRACT (omnidroid-api.md:
`omni create/start/install/...`, all `--json`). It needs no separately installed
emulator: on first use it self-bootstraps its config, resolves QEMU from the
product dir, and auto-registers the base image (base_x86 / base_arm). It is a
*per-account* model — each fresh test instance is a named account created from
an immutable base as a disposable copy-on-write overlay plus its own /data disk,
with three fixed loopback ports derived from the account index (adb 16001+i,
QMP 17001+i, VNC 18001+i). These tools drive lifecycle (create / start --wait /
stop / remove), derive the guest adb serial from the `--json` payload of
`start`/`list`, and do the adb-based work (screenshot, logcat, keyframes) with an
ordinary host adb. APK install goes through the contract's ABI-SAFE path
(`omni install --abi …`), which also sets the locked kiosk's launch target so
the app actually starts under Lock Task Mode.

The Android SDK emulator (`emulator.exe` + AVDs) and LDPlayer paths were REMOVED
(2026-07-09) — they were a pre-contract leftover that could reach for a stock
`emulator.exe` and an AVD (`omniagent_avd`) instead of omnidroid. There are NO
AVDs, ever. The `backend` parameter still exists on the tools for
call-compatibility but any value other than 'qemu' is coerced to omnidroid.

`device_name` is the omnidroid instance/account name ([A-Za-z0-9_-]+) — name it
the exact ROBLOX USERNAME under test (not display name); the engine keys instances
by username and resolves that account's cookie. Only fall back to the generic
'omniagent' when no Roblox account is in play. The SAME name is reused on each
call; with reset=True (the default) it is REMOVED and re-CREATED fresh from the base.
NOTE: a fresh account's first boot runs one-time provisioning + dexopt
(~3–15 min); pass reset=False to reuse an already-provisioned account and just
reinstall the APK — the fast path for iterating on a build. That opt-out exists
ONLY on ensure_emulator_running (interactive iteration): run_apk_test_session
FORCES reset=True and additionally VERIFIES the booted instance carries no
third-party packages (uninstalling any leftover) before installing the APK
under test, so every test session runs on a provably fresh instance.

Screenshot capture is window-state-independent. take_emulator_screenshot uses
`adb exec-out screencap -p` (reads the guest framebuffer over ADB — the omnidroid
instance is headless, so there is no host window to capture). record_and_capture_
keyframes PREFERS the engine's millisecond-precise `omni capture` (it observes
every VNC framebuffer update, so a loading screen shown for a few ms before a
black screen is caught with the true delta_ms) and falls back to adb-screencap
polling on an engine too old to advertise capture. Both paths feed the SAME
crash/exit diagnostics (tools/_emulator_diagnostics.py) so a black screen is
never confused with an app crash: crash/close is decided from the app's process
lifecycle + `logcat -b all -v epoch`, black is only a visual flag.
"""
import json
import os
import re
import shlex
import subprocess
import sys
import threading
import time

from tool_registry import registry
from tools.common import resolve_workspace_path, find_android_sdk_tools
from tools._emulator_frame_capture import capture_keyframes
from tools._emulator_vision_analyze import analyze_session
from tools._emulator_capture_contract import (
    capture_capability, load_capture_result, summarize_capture,
    normalize_capture_metadata, write_metadata_atomic,
)
from tools._emulator_diagnostics import analyze_logcat, merge_diagnostics, extract_crash_traces
from llm import get_openai_endpoint_config, get_vision_endpoint_config, has_vision_model

# omnidroid (QEMU against the base_x86/base_arm qcow2s, driven through the frozen
# contract) is the ONE AND ONLY VM backend. The old Android SDK emulator
# (emulator.exe + AVDs) and LDPlayer launch paths were REMOVED (2026-07-09): they
# were a pre-contract leftover that could reach for a stock `emulator.exe` and an
# AVD (`omniagent_avd`) instead of omnidroid. Every "run the app on a VM" flow now
# goes through `omni create/start` + the ABI-safe install. Any legacy `backend=`
# argument is coerced to qemu so nothing can ever fall back to an AVD.
_DEFAULT_BACKEND = "qemu"

# Frozen omnidroid contract version this harness codes against (omnidroid-api.md
# v1). The qemu backend does a `version --json` handshake and warns on mismatch.
_EXPECTED_CONTRACT = "1.0"
_DEFAULT_QEMU_SESSION = "omniagent"
# Workspace subfolder the always-on dev auto-screenshot recorder writes into
# (/workspace/screenshots/auto). read_auto_screenshots reads this by default.
_AUTOCAP_SESSION = "auto"
_DEFAULT_SYSTEM_IMAGE = None   # (removed) AVD-only; kept as a no-op for old callers
_DEFAULT_QEMU_MODE = "playable"

# Dev base (arm devkit disk) layout — MUST match the engine (omnidroid manager
# constants DEVKIT_MOUNT / DEVKIT_WORK). The dev environment is now base_arm PLUS
# an extra vdc disk (base_arm_devkit.qcow2) carrying the android-arm64 frida-server,
# Magisk, and the omni-* scripts. The engine mounts vdc read-only at DEVKIT_MOUNT
# and stages the exec-capable copy at DEVKIT_WORK on start; root is Magisk (`su`),
# NOT `adb root` (the LineageOS arm base is a 'user' build). See DEV-BASE.md.
_DEVKIT_MOUNT = "/mnt/omni-devkit"
_DEVKIT_WORK = "/data/local/tmp/omni-devkit"
_DEVKIT_MANIFEST = _DEVKIT_WORK + "/manifest.json"
_DEFAULT_FRIDA_PORT = 27142
# frida-server on the dev base is android-arm64 (native — no libndk), so the host
# binding must match this pinned version.
_DEV_FRIDA_VERSION = "17.15.4"


def _coerce_backend(backend):
    """omnidroid (qemu) is the only backend. Any other value (a legacy 'avd' /
    'ldplayer') is coerced to qemu so no flow can ever spawn the SDK emulator."""
    b = (backend or _DEFAULT_BACKEND).strip().lower()
    if b != "qemu":
        print(f"[emulator] backend '{b}' is no longer supported; using omnidroid "
              f"(qemu) — the SDK emulator/AVD path was removed.", file=sys.stderr)
    return "qemu"

# omnidroid's account-name rule (see omnidroid/HOWTO.md §5): the name must
# match [A-Za-z0-9_-]+ exactly (no dots, no globs, no paths). Bounded to 64 to
# stay well inside filesystem limits.
_SESSION_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def _truthy(v):
    return v in (True, "true", "True", 1, "1")


def _is_batch(path):
    return bool(path) and path.lower().endswith((".bat", ".cmd"))


def _run(cmd_list, timeout=30, input_text=None, env=None):
    """Runs a host executable directly (no shell), handling .bat files
    (avdmanager/sdkmanager on Windows) which need a 'cmd /c' wrapper."""
    if cmd_list and _is_batch(cmd_list[0]):
        cmd_list = ["cmd", "/c"] + cmd_list
    try:
        proc = subprocess.run(
            cmd_list, capture_output=True, text=True, encoding="utf-8",
            errors="replace", timeout=timeout, input=input_text, env=env,
        )
        return {"returncode": proc.returncode, "stdout": proc.stdout, "stderr": proc.stderr}
    except subprocess.TimeoutExpired:
        return {"error": f"Command timed out after {timeout}s: {' '.join(cmd_list)}"}
    except FileNotFoundError as e:
        return {"error": f"Executable not found: {e}"}


def _default_device_name(backend=None):
    # Single backend (omnidroid/qemu) -> the omnidroid account name.
    return _DEFAULT_QEMU_SESSION


def _validate_session_id(sid):
    """Returns an error string if sid isn't a valid omnidroid account name, else None."""
    if not sid or not _SESSION_ID_RE.match(sid):
        return (
            f"Invalid qemu account name {sid!r} — omnidroid account names must match "
            "[A-Za-z0-9_-]+ (letters, digits, '_' or '-'; no dots, spaces, or slashes)."
        )
    return None


# --------------------------------------------------------------------------
# omnidroid qemu-manager.exe control helpers (DEFAULT backend)
# --------------------------------------------------------------------------
#
# qemu-manager is the omnidroid engine (omnidroid/HOWTO.md documents
# it). The lifecycle commands we use (create/start/stop/remove/list) accept a
# `--json` flag that prints exactly one machine-readable JSON line on stdout with
# all human progress on stderr; errors become {"ok": false, "error": ...} with
# exit 1. We drive those for lifecycle, read the guest's adb serial out of the
# JSON, and reuse the ordinary host adb.exe for screenshots/logcat/shell — the
# same code path the other backends use. APK install/launch go back through the
# service (`omni install` / `omni run-app`) since provisioned accounts are locked
# kiosks; those subcommands are plain-text (no --json).

def _engine_project_dir(path):
    """Where the engine's config/accounts/qemu live for a resolved engine path.
    For a source checkout `<repo>/manager/omni.py` that is the REPO ROOT (the
    engine's _app_root() is manager/..); for a frozen exe it's the exe's own
    folder (it self-bootstraps configs/accounts next to itself)."""
    ap = os.path.abspath(path)
    parent = os.path.dirname(ap)
    if os.path.basename(ap) == "omni.py" and os.path.basename(parent) == "manager":
        return os.path.dirname(parent)          # repo root
    return parent


def _find_qemu_manager():
    """Locate the omnidroid engine. Returns (engine_path, project_dir).

    Resolution order — prefer the CANONICAL sibling checkout so the agent always
    drives the current engine (thin username-keyed instances, accounts.json,
    the RGBX colour fix, ...). A frozen bundle is only a fallback for a shipped
    agent that has no sibling checkout.
      1. QEMU_MANAGER_PATH env override (a .py or an exe) — explicit override.
      2. **Canonical `<Omni Apps>/omnidroid/manager/omni.py`** — the live engine
         (run with this interpreter). This is what a dev machine uses.
      3. Bundled `tools/omnidroid/omnidroid(.exe)` — self-contained fallback for
         a shipped agent with no canonical checkout beside it.
      4. Root `qemu-manager(.exe)`, then PATH.
    Staleness is caught LOUDLY: _ensure_qemu_running logs which engine it drives
    and the version handshake flags a contract mismatch. A stale bundle can no
    longer SHADOW the canonical engine — that was the bug where the agent kept
    using an old build (pre-thin-instances) even though a current checkout sat
    right beside it.
    """
    is_nt = os.name == "nt"
    tools_dir = os.path.dirname(os.path.abspath(__file__))
    repo_root = os.path.dirname(tools_dir)               # omni-agent/
    workspace_root = os.path.dirname(repo_root)          # Omni Apps/
    candidates = []
    env = os.environ.get("QEMU_MANAGER_PATH")
    if env:
        candidates.append(env)
    # Canonical checkout beside omni-agent — the live, current engine. Preferred.
    candidates.append(os.path.join(workspace_root, "omnidroid", "manager", "omni.py"))
    # Self-contained fallback: the agent's own bundled service engine.
    candidates.append(os.path.join(tools_dir, "omnidroid",
                                   "omnidroid.exe" if is_nt else "omnidroid"))
    candidates.append(os.path.join(repo_root,
                                   "qemu-manager.exe" if is_nt else "qemu-manager"))
    for cand in candidates:
        if cand and os.path.isfile(cand):
            return cand, _engine_project_dir(cand)
    from shutil import which
    found = which("omnidroid") or which("qemu-manager")
    if found:
        return found, _engine_project_dir(found)
    raise RuntimeError(
        "Could not find the omnidroid engine. Looked in: "
        + ", ".join(c for c in candidates if c)
        + ", and on PATH. Point QEMU_MANAGER_PATH at the canonical "
        "omnidroid/manager/omni.py (or a built omnidroid.exe)."
    )


def _parse_json_object(text):
    """qemu-manager --json prints one JSON value (object for create/start/stop,
    array for list) on stdout, but self-bootstrap can emit a few `[config] ...`
    progress lines before it. Parse defensively: try the whole thing, then the
    last line that parses as JSON, then a bracket-slice fallback."""
    text = (text or "").strip()
    if not text:
        return None
    try:
        return json.loads(text)
    except ValueError:
        pass
    for line in reversed(text.splitlines()):
        line = line.strip()
        if line and line[0] in "{[":
            try:
                return json.loads(line)
            except ValueError:
                continue
    for open_c, close_c in (("{", "}"), ("[", "]")):
        start, end = text.find(open_c), text.rfind(close_c)
        if start != -1 and end > start:
            try:
                return json.loads(text[start:end + 1])
            except ValueError:
                pass
    return None


def _omni_env():
    """Environment for every omnidroid call the AGENT makes.

    The engine hides its dev base (frida + Magisk root) from `bases`/`use-base`/
    `create` unless OMNI_DEV_MODE=1, so that the shipped product cannot list or
    switch to it — customers must not reach a rooted image. omni-agent is the
    devtool that base exists for, so it is the one caller that opts in."""
    env = dict(os.environ)
    env["OMNI_DEV_MODE"] = "1"
    return env


def _run_qemu(args, timeout=60):
    """Run an omnidroid subcommand. Returns (parsed_json_or_None, raw_result,
    project_dir). The frozen exe self-locates its project dir (its own folder),
    so we do NOT pass --project-dir (avoids any argparse global-vs-subcommand
    placement ambiguity) and simply rely on that documented default. If the
    resolved engine is a `.py` (e.g. QEMU_MANAGER_PATH points at the source
    checkout's manager/omni.py), it is run with the current interpreter."""
    exe, project_dir = _find_qemu_manager()
    prefix = [sys.executable, exe] if exe.endswith(".py") else [exe]
    res = _run(prefix + list(args), timeout=timeout, env=_omni_env())
    parsed = _parse_json_object(res.get("stdout"))
    return parsed, res, project_dir


def _qemu_extract_session(parsed, name):
    """Pull the dict describing one account out of any omnidroid --json shape:
    `create`/`start`/`stop` put the fields (including "name") at top level;
    `list --json` is an array of such dicts. Match on the account "name"."""
    if isinstance(parsed, list):
        for s in parsed:
            if isinstance(s, dict) and s.get("name") == name:
                return s
        return None
    if not isinstance(parsed, dict):
        return None
    # A single-account payload (create/start/stop) — only claim it if it is
    # actually about this account, or if it self-identifies with adb fields and
    # carries no conflicting name.
    if parsed.get("name") == name:
        return parsed
    if "name" not in parsed and any(k in parsed for k in ("adb_serial", "adb_port")):
        return parsed
    return None


def _qemu_serial_from(sess):
    if not isinstance(sess, dict):
        return None
    if sess.get("adb_serial"):
        return sess["adb_serial"]
    if sess.get("serial"):
        return sess["serial"]
    port = sess.get("adb_port")
    if port:
        return f"127.0.0.1:{port}"
    return None


def _qemu_is_running(sess):
    if not isinstance(sess, dict):
        return False
    if "running" in sess:
        return bool(sess["running"])
    status = str(sess.get("status") or sess.get("state") or "").lower()
    return status == "running"


def _qemu_adb(project_dir):
    """Resolve an adb.exe for the qemu backend. Prefer any platform-tools the
    omnidroid engine downloaded next to itself, then a host Android SDK's adb,
    then bare PATH adb (the engine requires adb on PATH, so this last one is the
    common case on Windows)."""
    exe = "adb.exe" if os.name == "nt" else "adb"
    for sub in (("qemu", "platform-tools"), ("runtime", "tools", "platform-tools"),
                ("platform-tools",)):
        cand = os.path.join(project_dir, *sub, exe)
        if os.path.isfile(cand):
            return cand
    try:
        return find_android_sdk_tools()["adb"]
    except RuntimeError:
        pass
    from shutil import which
    return which("adb") or which("adb.exe") or "adb"


def _qemu_get_account(name):
    """Look the account up via `list --json`. Returns its dict or None (and
    re-raises RuntimeError only if the engine can't be found)."""
    parsed, _res, _pd = _run_qemu(["list", "--json"], timeout=30)
    return _qemu_extract_session(parsed, name)


def _is_arm_abi(abi):
    return bool(abi and str(abi).startswith(("arm", "armeabi")))


def _qemu_account_arch(name, default="x86"):
    """The account's arch token ('x86' | 'arm') from `list --json` (contract
    §6.4). Determines which ABI path a test must exercise: x86 accounts run an
    arm APK via libndk TRANSLATION; arm accounts run it NATIVELY."""
    try:
        acct = _qemu_get_account(name)
        if isinstance(acct, dict) and acct.get("arch") in ("x86", "arm"):
            return acct["arch"]
    except RuntimeError:
        pass
    return default


def _qemu_contract_check():
    """Contract handshake (omnidroid-api.md §4). Returns (ok, info) where ok is
    True only if the engine reports the expected contract AND is arch_aware.
    Non-fatal: callers WARN + degrade on mismatch (an old engine also can't do
    the ABI-safe install, which then fails loudly on its own)."""
    try:
        parsed, _res, _pd = _run_qemu(["version", "--json"], timeout=30)
    except RuntimeError:
        return False, {"error": "engine_not_found"}
    if not (isinstance(parsed, dict) and parsed.get("ok")):
        return False, {"error": "no_version", "raw": parsed}
    ok = parsed.get("contract") == _EXPECTED_CONTRACT and parsed.get("arch_aware") is True
    return ok, parsed


def _qemu_readiness_check():
    """`doctor --json` preflight. Returns (ready, report). Used to FAIL FAST on a
    missing base image (our current deferred state: no base download_url set) so
    the caller returns a clear terminal error instead of the agent looping on
    'the download may be in progress' — enforcing the never-hang rule."""
    try:
        parsed, _res, _pd = _run_qemu(["doctor", "--json"], timeout=60)
    except RuntimeError as e:
        return False, {"error": str(e)}
    if isinstance(parsed, dict):
        return bool(parsed.get("ready")), parsed
    return False, {"error": "doctor returned no JSON"}


def _dev_base_enabled(dev=None):
    """Whether new omnidroid accounts should be created from the DEV base
    (base_arm + the base_arm_devkit.qcow2 extra disk: frida + Magisk + omni
    tools). True when the caller passes dev=True OR the OMNI_USE_DEV_BASE env var
    is truthy. omni-agent is a dev-only dependency, so it is the only thing that
    ever selects this base; the shipped bases (base_x86/base_arm) never carry the
    devkit disk."""
    if dev is not None:
        return _truthy(dev)
    return _truthy(os.environ.get("OMNI_USE_DEV_BASE", ""))


def _qemu_create(name, boot_timeout, log, dev=False):
    """Create disks for a fresh account (no boot — the first `start` provisions).
    Returns None on success or an {"error": ...} dict on failure. When dev=True
    the account is pinned to the 'dev' base (`create --base dev`) so it boots
    base_arm with the frida/Magisk devkit disk attached instead of a production
    base."""
    tag = " on the DEV base (frida+root-hiding)" if dev else ""
    log.append(f"Creating account '{name}'{tag} (disks only; first boot provisions)...")
    argv = ["create", name, "--no-provision", "--json"]
    if dev:
        argv += ["--base", "dev"]
    try:
        parsed, res, _pd = _run_qemu(argv, timeout=600)
    except RuntimeError as e:
        return {"error": str(e)}
    if res.get("error"):
        return {"error": res["error"]}
    if not (isinstance(parsed, dict) and parsed.get("ok", False)):
        detail = (res.get("stdout") or res.get("stderr") or "").strip()[:800]
        return {"error": f"omnidroid create failed. Output:\n{detail}"}
    return None


def _autocap_workspace_dir():
    """Where the always-on dev auto-screenshots land in the agent workspace:
    /workspace/screenshots/<current session>/ (read with read_auto_screenshots).
    The session name is 'auto' until an APK is installed, then it becomes
    '<apk_basename>_<DDMMHHMM>' so each install/test session gets its own folder."""
    return resolve_workspace_path(f"screenshots/{_AUTOCAP_SESSION}")


def _install_session_name(apk_path):
    """A per-install-session screenshot-folder name: the APK's base filename plus
    a DDMMHHMM stamp of when it was installed this session, e.g.
    'intermadiate_test_v4_19070641'. Sanitized to [A-Za-z0-9_-]."""
    base = os.path.splitext(os.path.basename(str(apk_path)))[0]
    base = re.sub(r"[^A-Za-z0-9_-]+", "_", base).strip("_") or "apk"
    return f"{base}_{time.strftime('%d%m%H%M')}"


def _begin_install_autocap_session(apk_path, name, log):
    """Point the always-on recorder at a fresh per-install screenshot folder named
    for this APK + timestamp, so the test session's frames don't mix with the
    boot's. Dev-base only (the engine no-ops autocap off-dev); best-effort."""
    global _AUTOCAP_SESSION
    _AUTOCAP_SESSION = _install_session_name(apk_path)
    try:
        os.environ["OMNI_AUTOCAP_DIR"] = _autocap_workspace_dir()
    except RuntimeError:
        pass
    # Re-ensure with the new --out; the engine repoints a running recorder when a
    # different dir is requested (omnidroid ensure_autocap).
    _agent_ensure_autocap(name, log)
    return _AUTOCAP_SESSION


def _agent_ensure_autocap(name, log):
    """Idempotently make sure the engine's always-on recorder is running and
    pointed at the workspace. Safe to call on every ensure-emulator (dev only);
    it never starts a second recorder. Best-effort — never fails the boot."""
    try:
        out_dir = _autocap_workspace_dir()
    except RuntimeError as e:
        log.append(f"[autocap] workspace path unresolved ({e}); skipping.")
        return
    os.makedirs(out_dir, exist_ok=True)
    try:
        parsed, res, _pd = _run_qemu(
            ["autocap", name, "--ensure", "--out", out_dir, "--json"], timeout=60)
    except RuntimeError as e:
        log.append(f"[autocap] ensure failed: {e}")
        return
    if isinstance(parsed, dict) and parsed.get("running"):
        state = "already ON" if parsed.get("already") else "STARTED"
        log.append(f"[autocap] always-on screenshots {state} -> "
                   f"/workspace/screenshots/{_AUTOCAP_SESSION}/ "
                   f"(read them with read_auto_screenshots).")
    else:
        why = (parsed or {}).get("reason") or (res.get("stderr") or "")[:120]
        log.append(f"[autocap] recorder not started ({why}).")


def _ensure_qemu_running(name, reset, boot_timeout, mode, mem, dev=False):
    err = _validate_session_id(name)
    if err:
        return {"error": err}
    log = []
    if dev:
        log.append("DEV BASE selected: new accounts boot base_arm with the "
                   "devkit disk (vdc: frida + Magisk + omni tools). Start frida "
                   "with ensure_frida_server; hide it with hide_root_from_app. "
                   "(Root needs a Magisk-patched boot: omni build-dev-base --patch-boot.)")
        # Point the engine's own boot-time auto-start (and our later ensure) at
        # the workspace so screenshots are captured automatically and readably,
        # with no explicit start call needed. Set BEFORE `start` runs.
        try:
            os.environ["OMNI_AUTOCAP_DIR"] = _autocap_workspace_dir()
        except RuntimeError:
            pass

    # Which engine + config are we actually driving? Surface it so a path/config
    # mismatch is diagnosable at a glance (this is exactly the class of bug where
    # the agent invoked a stale bundled engine pointing at the wrong images_dir).
    try:
        _exe, _pdir = _find_qemu_manager()
        log.append(f"omnidroid engine: {_exe}")
    except RuntimeError as e:
        return {"error": str(e)}

    # Contract handshake FIRST (omnidroid-api.md §4). Warn + degrade on a
    # mismatch rather than aborting — but make it loud, because an engine that
    # isn't arch-aware also can't do the ABI-safe install this harness relies on.
    ok_contract, ver = _qemu_contract_check()
    if ok_contract:
        log.append(f"Engine contract {ver.get('contract')} (arch_aware, host {ver.get('host_arch')}).")
    else:
        log.append(
            "WARNING: engine does not report the expected contract "
            f"{_EXPECTED_CONTRACT}/arch_aware ({ver}). The ABI-safe install "
            "path may not work — update omnidroid (see omnidroid-api.md)."
        )

    # READINESS PREFLIGHT — FAIL FAST, NEVER LOOP. If the base image is missing
    # (our current deferred state has no base download_url), this is a permanent
    # condition, not a transient "download in progress": return a hard terminal
    # error the caller must not retry, with the exact images_dir + fix.
    ready, rep = _qemu_readiness_check()
    if not ready:
        images_dir = rep.get("images_dir", "<unknown>")
        missing = rep.get("missing_files") or []
        return {"error": (
            "FATAL: omnidroid is not ready — the base image is missing and there "
            "is no configured base download source. This is NOT a transient "
            "condition (nothing is downloading); DO NOT retry ensure_emulator_running.\n"
            f"  engine   : {_exe}\n"
            f"  config   : {rep.get('config', '<unknown>')}\n"
            f"  images_dir: {images_dir}\n"
            f"  missing  : {', '.join(missing) if missing else '(see doctor)'}\n"
            "Fix: place base_x86.qcow2 + base_x86.kernel + base_x86.initrd.img "
            f"in {images_dir} (or set a base download URL), then run again."
        )}

    try:
        acct = _qemu_get_account(name)
    except RuntimeError as e:
        return {"error": str(e)}
    exists = acct is not None
    running = exists and _qemu_is_running(acct)

    # reset=True -> a truly fresh instance: destroy any old account, recreate it.
    if reset:
        if exists:
            log.append(f"Removing existing account '{name}' for a fresh instance (DESTRUCTIVE)...")
            try:
                _parsed_rm, res_rm, _pd = _run_qemu(["remove", name, "--json"], timeout=180)
            except RuntimeError as e:
                return {"error": str(e)}
            if res_rm.get("error"):
                return {"error": res_rm["error"]}
            exists = running = False
        err = _qemu_create(name, boot_timeout, log, dev=dev)
        if err:
            return err
        exists, running = True, False
    elif not exists:
        # reset=False but nothing to reuse yet — create it once.
        err = _qemu_create(name, boot_timeout, log, dev=dev)
        if err:
            return err
        exists = True

    # Reuse an already-running, already-provisioned account as-is.
    if running and not reset:
        serial = _qemu_serial_from(acct)
        log.append(f"Account '{name}' already running; reusing (reset=false). serial={serial or 'unknown'}")
        adb = _qemu_adb(_find_qemu_manager()[1])
        if serial:
            _run([adb, "connect", serial], timeout=10)
        if dev:
            _agent_ensure_autocap(name, log)
        log.append(f"BOOT_OK (serial={serial or 'unknown'})")
        return {"stdout": "\n".join(log)}

    # Cold-boot and block until Android reports boot_completed. A just-created
    # account provisions + dexopts on this first boot, which the engine bounds at
    # ~1500 s — give at least that so we don't time out mid-provision.
    wait_timeout = max(boot_timeout, 1500) if reset else boot_timeout
    args = ["start", name, "--wait", "--timeout", str(wait_timeout), "--json"]
    if mode:
        args += ["--mode", mode]
    if mem:
        args += ["--mem", str(mem)]
    log.append(
        f"Starting account '{name}' headless (wait up to {wait_timeout}s"
        + (", first boot provisions" if reset else "") + ")..."
    )
    try:
        parsed_s, res_s, project_dir = _run_qemu(args, timeout=wait_timeout + 120)
    except RuntimeError as e:
        return {"error": str(e)}
    if res_s.get("error"):
        return {"error": res_s["error"]}
    if not (isinstance(parsed_s, dict) and parsed_s.get("ok", False)):
        detail = (res_s.get("stdout") or res_s.get("stderr") or "").strip()[:800]
        return {"error": f"omnidroid start did not succeed. Output:\n{detail}"}

    serial = _qemu_serial_from(parsed_s)
    log.append(
        f"Started (pid={parsed_s.get('pid')}, adb_port={parsed_s.get('adb_port')}, "
        f"vnc_port={parsed_s.get('vnc_port')}, serial={serial})."
    )
    booted = parsed_s.get("booted", True)
    if not booted:
        log.append(f"BOOT_TIMEOUT after {wait_timeout}s (start returned booted=false).")
        return {"stdout": "\n".join(log)}

    # Idempotent adb connect so the adb-based tools can reach the guest.
    adb = _qemu_adb(project_dir)
    if serial:
        _run([adb, "connect", serial], timeout=10)
    bridge = parsed_s.get("native_bridge_ok")
    if bridge is False:
        log.append("WARNING: libndk ARM bridge did NOT verify — arm64-only APKs may fail to run.")
    if dev:
        # Engine already auto-starts the recorder on a dev --wait boot; this
        # idempotent ensure just confirms it and repoints to the workspace.
        _agent_ensure_autocap(name, log)
    log.append(f"BOOT_OK (serial={serial or 'unknown'})")
    return {"stdout": "\n".join(log)}


def _resolve_serial(backend, device_name=None):
    """Returns (adb_path, serial) for the currently active device of the
    given backend, or (None, error_dict) if it can't be resolved. Stateless
    by design — always re-derives the serial fresh (LDPlayer can reassign an
    instance's index across a recreate, so nothing about the serial is
    cached between calls)."""
    backend = _coerce_backend(backend)   # omnidroid (qemu) only
    device_name = device_name or _default_device_name()

    err = _validate_session_id(device_name)
    if err:
        return None, {"error": err}
    try:
        parsed, res, project_dir = _run_qemu(["list", "--json"], timeout=30)
    except RuntimeError as e:
        return None, {"error": str(e)}
    sess = _qemu_extract_session(parsed, device_name)
    if sess is None:
        return None, {"error": (
            f"omnidroid account '{device_name}' not found. Call ensure_emulator_running first. "
            f"(omnidroid list: {(res.get('stdout') or res.get('stderr') or '').strip()[:300]})"
        )}
    if not _qemu_is_running(sess):
        return None, {"error": f"omnidroid account '{device_name}' is not running. Call ensure_emulator_running first."}
    serial = _qemu_serial_from(sess)
    if not serial:
        return None, {"error": (
            f"omnidroid account '{device_name}' has no adb endpoint yet — it may still be booting. "
            "Re-run ensure_emulator_running (or wait for boot) and retry."
        )}
    adb = _qemu_adb(project_dir)
    _run([adb, "connect", serial], timeout=10)
    return adb, serial


@registry.register(
    name="ensure_emulator_running",
    description=(
        "Boots the project's Android VM through OMNIDROID (the only backend). Omnidroid is the "
        "self-contained headless QEMU/Bliss-OS runner driven via the frozen contract (omni create/"
        "start, --json); it needs NO separately installed emulator (NO Android SDK emulator.exe, NO "
        "AVDs — that path was removed), self-bootstraps QEMU + the base image on first use, and models "
        "each test instance as a named ACCOUNT (immutable base_x86/base_arm + disposable overlay/data). "
        "Creates the account once if needed and reuses that SAME one on every later call — never a "
        "duplicate. By default (reset=true) it REMOVES the old account and CREATES a fresh one from the "
        "base, then waits for Android to finish booting. NOTE: a fresh account's first boot runs "
        "one-time provisioning + dexopt (~3–15 min); pass reset=false to reuse an already-provisioned "
        "account (fast, ~35 s cold boot)."
    ),
    params_schema={
        "backend": "string (optional, default 'qemu' — omnidroid is the ONLY backend; any other value is coerced to omnidroid, there is no SDK-emulator/AVD/LDPlayer path)",
        "device_name": "string (the omnidroid instance/account name, must match [A-Za-z0-9_-]+). NAME IT THE ROBLOX USERNAME you are testing as — the exact username (NOT display name) from register_roblox_account / list_roblox_accounts. The engine keys instances by username and resolves that account's cookie automatically, so the same username always reuses the same instance. Only fall back to the generic 'omniagent' when there is no Roblox account in play. PREFER play_roblox, which sets this for you.)",
        "system_image": "string (IGNORED — was AVD-only; the base image is base_x86 on an x86 host / base_arm on an arm64 host)",
        "device_profile": "string (IGNORED — was AVD-only)",
        "reset": "boolean (optional, default true — remove+recreate the account (fresh instance, re-provisions on first boot). Set false to reuse the existing running/provisioned account as-is (much faster).",
        "boot_timeout": "integer (optional, default 300 seconds; a freshly-created account waits up to 1500 s to cover first-boot provisioning regardless of this value)",
        "mode": "string (optional, default 'playable' — RAM/CPU tier: 'playable' (4G/4c), 'hard' (3G/4c), or 'brutal' (2G/2c))",
        "ram_mb": "integer (optional — override guest RAM in MB, passed as --mem; overrides the mode's RAM. Engine defaults to the mode's tier if omitted)",
        "cpus": "integer (optional — IGNORED (vCPU count is set by 'mode'))",
        "headless": "boolean (IGNORED — omnidroid instances are always headless; view over the instance's localhost VNC port)",
        "dev": "boolean (optional, default false — boot the DEV base: base_arm plus the extra devkit disk (vdc = base_arm_devkit.qcow2) carrying an android-arm64 frida-server + Magisk + the omni-* tools, for reverse-engineering/runtime-hooking work. Requires `omni build-dev-base` to have produced the devkit disk (and `--patch-boot` to root it, so frida can attach). Also enablable globally via the OMNI_USE_DEV_BASE env var. Only affects a FRESH create (base is fixed per account); production bases are untouched. After BOOT_OK, use ensure_frida_server / hide_root_from_app.)"
    },
    output="A log of what happened (account creation/reset if needed, boot wait progress) ending in 'BOOT_OK (serial=...)' or 'BOOT_TIMEOUT after Ns'.",
    when_to_use="Call this FIRST, before install_apk_on_emulator/launch_app_on_emulator/any adb-based tool. Safe to call repeatedly — it always targets the same omnidroid account and (by default) resets it to a clean state each time. Fully self-contained (no Android Studio / SDK emulator / LDPlayer). Pass dev=true (or set OMNI_USE_DEV_BASE) to boot the frida/root-hiding dev base."
)
def ensure_emulator_running(backend=_DEFAULT_BACKEND, device_name=None, system_image=_DEFAULT_SYSTEM_IMAGE,
                             device_profile="pixel_5", reset=True, boot_timeout=300, headless=False,
                             ram_mb=None, cpus=None, mode=_DEFAULT_QEMU_MODE, dev=None):
    backend = _coerce_backend(backend)   # omnidroid (qemu) only — never an AVD
    device_name = device_name or _default_device_name()
    reset = _truthy(reset)
    dev = _dev_base_enabled(dev)
    try:
        boot_timeout = int(boot_timeout)
    except (TypeError, ValueError):
        boot_timeout = 300
    mode = (mode or _DEFAULT_QEMU_MODE).strip().lower()
    if mode not in ("playable", "hard", "brutal"):
        return {"error": "mode must be 'playable', 'hard', or 'brutal'."}
    # ALWAYS omnidroid: create/start an account on the base (base_x86 on x86,
    # base_arm on an arm64 host) via the frozen contract. system_image/
    # device_profile/headless are ignored (they were AVD-only).
    return _ensure_qemu_running(device_name, reset, boot_timeout, mode, ram_mb, dev=dev)


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
        "backend": "string (optional, default 'qemu' — must match whichever backend ensure_emulator_running booted)",
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


def _int_arg(value, name):
    """Coerce a coordinate/keycode arg to int, or return an {'error': ...} dict."""
    try:
        return int(value)
    except (TypeError, ValueError):
        return {"error": f"{name} must be an integer (got {value!r})."}


def _input_failure(res):
    """Return an {'error': ...} dict if an adb `input` _run result failed (a _run
    error, or a non-zero exit / stderr from adb itself), else None on success."""
    if isinstance(res, dict) and res.get("error"):
        return res
    if isinstance(res, dict) and res.get("returncode", 0) != 0:
        return {"error": f"adb input failed (exit {res.get('returncode')}): "
                         f"{(res.get('stderr') or res.get('stdout') or '').strip()[:300]}"}
    return None


@registry.register(
    name="set_emulator_ui",
    description=(
        "Switches a DEV instance's visible UI between the custom kiosk and the Magisk manager "
        "(root) app, via omnidroid 'dev-ui'. Dev instances boot to the SAME kiosk as production; "
        "use view='magisk' when you need to see/manage root in the Magisk app, then view='kiosk' "
        "to return to the kiosk/game. Dev base only (a normal instance has no Magisk UI)."
    ),
    params_schema={
        "view": "string — 'kiosk' (foreground the kiosk, stop the Magisk app) or 'magisk' (open the Magisk manager/root UI)",
        "device_name": "string (optional — the omnidroid instance/username; must match the running dev instance)"
    },
    output="JSON confirming which UI is now showing, or an error (not a dev instance / not running / Magisk not installed).",
    when_to_use="Use to peek at or manage root via the Magisk app during a dev test, then switch back to 'kiosk' so the game/kiosk is visible again for screenshots."
)
def set_emulator_ui(view="kiosk", device_name=None):
    view = (view or "kiosk").strip().lower()
    if view not in ("kiosk", "magisk"):
        return {"error": "view must be 'kiosk' or 'magisk'."}
    name = device_name or _default_device_name("qemu")
    err = _validate_session_id(name)
    if err:
        return {"error": err}
    try:
        parsed, res, _pd = _run_qemu(["dev-ui", name, "--show", view, "--json"], timeout=60)
    except RuntimeError as e:
        return {"error": str(e)}
    if res.get("error"):
        return {"error": res["error"]}
    if isinstance(parsed, dict) and not parsed.get("ok"):
        return {"error": parsed.get("message") or parsed.get("error") or "dev-ui failed"}
    return parsed if isinstance(parsed, dict) else {"stdout": (res.get("stdout") or "").strip()}


@registry.register(
    name="tap_screen",
    description=(
        "Taps the emulator screen at pixel (x, y) via 'adb shell input tap'. Coordinates are in "
        "SCREEN PIXELS from the top-left. WORKFLOW: first take_emulator_screenshot (or read the "
        "always-on auto-screenshots), read the pixel position of the button/field you want from "
        "that image, then tap it here. The screenshot and the device share the same pixel space."
    ),
    params_schema={
        "x": "integer (pixels from left)",
        "y": "integer (pixels from top)",
        "backend": "string (optional, default 'qemu' — must match ensure_emulator_running's backend)",
        "device_name": "string (optional — must match the device_name ensure_emulator_running used)"
    },
    output="Confirmation of the tap, or an adb error.",
    when_to_use="Use to click a button/menu/field whose on-screen position you read from a screenshot. Pair with take_emulator_screenshot to get coordinates first."
)
def tap_screen(x, y, backend=_DEFAULT_BACKEND, device_name=None):
    adb, serial_or_err = _resolve_serial(backend, device_name)
    if adb is None:
        return serial_or_err
    xi, yi = _int_arg(x, "x"), _int_arg(y, "y")
    if isinstance(xi, dict):
        return xi
    if isinstance(yi, dict):
        return yi
    res = _run([adb, "-s", serial_or_err, "shell", "input", "tap", str(xi), str(yi)], timeout=30)
    fail = _input_failure(res)
    if fail:
        return fail
    return {"ok": True, "tapped": [xi, yi], "detail": res}


@registry.register(
    name="type_text",
    description=(
        "Types a string into the currently focused text field via 'adb shell input text'. Tap the "
        "field first (tap_screen) so it has focus. Spaces are handled automatically; for Enter/Back "
        "use press_key. Note: 'input text' handles plain text — very unusual characters may not send."
    ),
    params_schema={
        "text": "string (the text to type into the focused field)",
        "backend": "string (optional, default 'qemu')",
        "device_name": "string (optional — must match ensure_emulator_running's device_name)"
    },
    output="Confirmation of the typed text, or an adb error.",
    when_to_use="Use after tapping a text field to enter a value (search terms, a Luau script name, credentials). Pair with tap_screen for focus."
)
def type_text(text, backend=_DEFAULT_BACKEND, device_name=None):
    adb, serial_or_err = _resolve_serial(backend, device_name)
    if adb is None:
        return serial_or_err
    if not isinstance(text, str) or text == "":
        return {"error": "text must be a non-empty string."}
    # `input text` treats spaces specially — encode them as %s. Pass as ONE arg so
    # the host shell doesn't split it; Android's input decodes the %s back to space.
    encoded = text.replace(" ", "%s")
    res = _run([adb, "-s", serial_or_err, "shell", "input", "text", encoded], timeout=30)
    fail = _input_failure(res)
    if fail:
        return fail
    return {"ok": True, "typed": text, "detail": res}


@registry.register(
    name="swipe_screen",
    description=(
        "Swipes/drags from (x1, y1) to (x2, y2) via 'adb shell input swipe', over an optional "
        "duration in ms (longer = slower drag; a long same-point swipe is a long-press). Coordinates "
        "are screen pixels read from a screenshot, same as tap_screen."
    ),
    params_schema={
        "x1": "integer (start x, pixels)",
        "y1": "integer (start y, pixels)",
        "x2": "integer (end x, pixels)",
        "y2": "integer (end y, pixels)",
        "duration_ms": "integer (optional, default 300 — swipe duration; larger = slower)",
        "backend": "string (optional, default 'qemu')",
        "device_name": "string (optional)"
    },
    output="Confirmation of the swipe, or an adb error.",
    when_to_use="Use to scroll a list, drag a slider, or long-press (same start/end with a large duration). Read start/end pixels from a screenshot."
)
def swipe_screen(x1, y1, x2, y2, duration_ms=300, backend=_DEFAULT_BACKEND, device_name=None):
    adb, serial_or_err = _resolve_serial(backend, device_name)
    if adb is None:
        return serial_or_err
    coords = []
    for val, nm in ((x1, "x1"), (y1, "y1"), (x2, "x2"), (y2, "y2")):
        iv = _int_arg(val, nm)
        if isinstance(iv, dict):
            return iv
        coords.append(iv)
    dur = _int_arg(duration_ms, "duration_ms")
    if isinstance(dur, dict):
        dur = 300
    dur = max(50, min(dur, 10000))
    res = _run([adb, "-s", serial_or_err, "shell", "input", "swipe",
                *[str(c) for c in coords], str(dur)], timeout=30)
    fail = _input_failure(res)
    if fail:
        return fail
    return {"ok": True, "swiped": {"from": coords[:2], "to": coords[2:], "duration_ms": dur}, "detail": res}


@registry.register(
    name="press_key",
    description=(
        "Presses a hardware/navigation key via 'adb shell input keyevent'. Accepts an Android "
        "keycode NUMBER (e.g. 4=BACK, 3=HOME, 66=ENTER, 187=APP_SWITCH, 26=POWER) or a keycode "
        "NAME (e.g. 'BACK', 'HOME', 'ENTER', 'DEL', 'TAB'). Use for navigation the touch tools "
        "can't express."
    ),
    params_schema={
        "key": "string|integer (a keycode number like 4, or a name like 'BACK'/'ENTER'/'HOME')",
        "backend": "string (optional, default 'qemu')",
        "device_name": "string (optional)"
    },
    output="Confirmation of the keyevent, or an adb error.",
    when_to_use="Use for Back/Home/Enter/App-switch and other hardware keys — e.g. Enter to submit after type_text, or Back to dismiss a dialog."
)
def press_key(key, backend=_DEFAULT_BACKEND, device_name=None):
    adb, serial_or_err = _resolve_serial(backend, device_name)
    if adb is None:
        return serial_or_err
    if key is None or (isinstance(key, str) and not key.strip()):
        return {"error": "key must be a keycode number or name (e.g. 4 or 'BACK')."}
    # adb accepts either a number or a KEYCODE name; pass through as a string.
    keycode = str(key).strip()
    res = _run([adb, "-s", serial_or_err, "shell", "input", "keyevent", keycode], timeout=30)
    fail = _input_failure(res)
    if fail:
        return fail
    return {"ok": True, "key": keycode, "detail": res}


@registry.register(
    name="install_apk_on_emulator",
    description=(
        "Installs an APK onto the running omnidroid VM via the service "
        "('omni install <account> <apk> --json'), which installs the APK AND sets it as the locked "
        "kiosk's launch target so it starts under Lock Task Mode. It is ABI-SAFE (omnidroid-api.md §5): "
        "a fat APK on an x86 account is installed as arm64-v8a so it exercises libndk ARM TRANSLATION "
        "(the real production path) instead of silently running native x86_64 and bypassing the bridge; "
        "on an arm account it runs native. The tool then reads native_bridge_used/abi_installed from "
        "the JSON and ASSERTS the intended path was actually exercised — a wrong ABI (e.g. forcing "
        "abi='x86_64' on an x86 account) FAILS with an 'ABI CONTRACT VIOLATION' error rather than "
        "passing silently."
    ),
    params_schema={
        "apk_path": "string (path to the .apk, relative to /workspace, e.g. 'modified.apk')",
        "backend": "string (optional, default 'qemu' — must match whichever backend ensure_emulator_running booted)",
        "device_name": "string (optional — must match the device_name ensure_emulator_running used, if you overrode it)",
        "replace": "boolean (optional, default true — adb backends only: adds -r to allow reinstalling over an existing install)",
        "grant_permissions": "boolean (optional, default true — adb backends only: adds -g to auto-grant all runtime permissions; on qemu the device-owner kiosk handles permissions)",
        "abi": "string (optional, qemu backend only — force a specific install ABI. Default: arm64-v8a on x86 accounts (exercise translation), none on arm accounts (native). Set to 'x86_64' to DELIBERATELY test the native/wrong path — on an x86 account that trips the ABI-contract assertion and FAILS, which is the intended guard.)",
        "require_translation": "boolean (optional, qemu backend, default true — on x86 accounts pass --require-translation so the engine itself also rejects a non-translated install)"
    },
    output="On qemu: an ABI-checked confirmation ('...native_bridge_used=<bool> — intended path exercised') on success, or an error — 'ABI CONTRACT VIOLATION ...' / 'omnidroid install failed (abi_not_translated ...)' — when the wrong ABI path was taken (this fails the test). On adb backends: adb install's output ('Success' or INSTALL_FAILED_*).",
    when_to_use="Call this after ensure_emulator_running, before launch_app_on_emulator, any time you have a newly built/signed APK to test. On qemu it guarantees the arm-translation path is what gets tested on x86."
)
def install_apk_on_emulator(apk_path, backend=_DEFAULT_BACKEND, device_name=None, replace=True,
                            grant_permissions=True, abi=None, require_translation=True):
    backend = _coerce_backend(backend)
    try:
        host_apk_path = resolve_workspace_path(apk_path)
    except RuntimeError as e:
        return {"error": str(e)}
    if not os.path.isfile(host_apk_path):
        return {"error": f"APK not found at resolved path: {host_apk_path}"}

    if backend == "qemu":
        # Route through the service so it records the APK, sets it as the kiosk's
        # launch target, and launches it under Lock Task Mode. ABI-SAFE per the
        # frozen contract (omnidroid-api.md §5): a fat APK on an x86 account must
        # exercise libndk ARM TRANSLATION (not run native x86_64 and bypass it);
        # an arm account runs it NATIVE. We install via `--json`, then ASSERT the
        # intended path was actually exercised — a wrong ABI FAILS the test.
        name = device_name or _default_device_name("qemu")
        err = _validate_session_id(name)
        if err:
            return {"error": err}
        arch = _qemu_account_arch(name)
        expect_bridge = (arch == "x86")   # x86 -> translation; arm -> native
        argv = ["install", name, host_apk_path, "--json"]
        if abi:                           # explicit override (e.g. "x86_64" forces the WRONG path)
            argv += ["--abi", str(abi)]
        elif arch == "arm":               # arm account: no pin, run native
            argv += ["--no-abi-pin"]
        # else x86 default: the engine implicitly pins arm64-v8a (translation).
        # Demand translation on the default x86 path; when the caller deliberately
        # forces a NON-arm ABI, skip it so the failure surfaces via our assertion
        # below with a clear, agent-side message.
        if expect_bridge and _truthy(require_translation) and not (abi and not _is_arm_abi(abi)):
            argv += ["--require-translation"]
        try:
            parsed, res, _pd = _run_qemu(argv, timeout=600)
        except RuntimeError as e:
            return {"error": str(e)}
        if res.get("error"):
            return {"error": res["error"]}
        # Contract error (abi_not_translated / install_failed) => ok=false: the
        # test FAILS here; it does NOT proceed to a passing report.
        if not (isinstance(parsed, dict) and parsed.get("ok")):
            code = parsed.get("error") if isinstance(parsed, dict) else None
            detail = (parsed.get("message") if isinstance(parsed, dict) else None) \
                or (res.get("stdout") or res.get("stderr") or "").strip()
            return {"error": f"omnidroid install failed ({code or 'unknown'}): {str(detail)[:800]}"}
        nbu = bool(parsed.get("native_bridge_used"))
        abi_installed = parsed.get("abi_installed")
        # ASSERT the intended ABI path was actually exercised.
        if nbu != expect_bridge:
            want = ("ARM translation via libndk (native_bridge_used=true)" if expect_bridge
                    else "native execution (native_bridge_used=false)")
            return {"error": (
                f"ABI CONTRACT VIOLATION on {arch} account '{name}': installed as abi={abi_installed} "
                f"with native_bridge_used={nbu}, but this account's intended path is {want}. "
                f"The APK was NOT tested on the intended path — failing the test.")}
        # Start a fresh per-install screenshot session named for this APK + time
        # (e.g. screenshots/<apk>_<DDMMHHMM>/), so this test's frames get their own
        # folder instead of piling into a single shared 'auto/'. Dev-base only.
        cap_log = []
        session = _begin_install_autocap_session(apk_path, name, cap_log)
        cap_note = f" Auto-screenshots -> /workspace/screenshots/{session}/ (read_auto_screenshots)."
        return {"stdout": (
            f"Installed {parsed.get('package')} on {arch} account '{name}': abi={abi_installed}, "
            f"native_bridge_used={nbu} — intended path exercised "
            f"({'ARM translation' if expect_bridge else 'native'}). Kiosk launching the app."
            + cap_note)}

    adb, serial_or_err = _resolve_serial(backend, device_name)
    if adb is None:
        return serial_or_err
    args = [adb, "-s", serial_or_err, "install"]
    if _truthy(replace):
        args.append("-r")
    if _truthy(grant_permissions):
        args.append("-g")
    args.append(host_apk_path)
    return _run(args, timeout=120)


@registry.register(
    name="launch_app_on_emulator",
    description=(
        "Launches an installed app on the emulator. On the default 'qemu' (omnidroid) backend it uses "
        "the service ('omni run-app <account> <package>'), which launches the package as the locked "
        "kiosk allows — note install_apk_on_emulator already auto-launches the freshly installed APK on "
        "qemu, so this is mainly to re-launch it. On 'ldplayer'/'avd', without an activity it uses "
        "'monkey' to fire the app's default launcher intent (works without knowing the exact activity "
        "name); with an activity, it starts that exact component via 'am start'. The 'activity' "
        "argument is only honored on the adb backends."
    ),
    params_schema={
        "package_name": "string (the app's package name, e.g. 'com.example.app' — find it with search_smali/grep_file on AndroidManifest.xml, or 'adb_shell pm list packages' after installing)",
        "activity": "string (optional, adb backends only, fully-qualified activity class, e.g. '.MainActivity' — omit to just launch the default launcher activity; ignored on qemu)",
        "backend": "string (optional, default 'qemu' — must match whichever backend ensure_emulator_running booted)",
        "device_name": "string (optional — must match the device_name ensure_emulator_running used, if you overrode it)"
    },
    output="adb's launch output — for the monkey path, a short log ending in the injected launch event; for am start, the ComponentInfo/status of the started activity, or an error if the package/activity doesn't exist or isn't exported. On qemu: the service's run-app output.",
    when_to_use="Call this after install_apk_on_emulator, right before record_and_capture_keyframes so the capture window covers the app's actual startup."
)
def launch_app_on_emulator(package_name, activity=None, backend=_DEFAULT_BACKEND, device_name=None):
    backend = _coerce_backend(backend)
    if backend == "qemu":
        name = device_name or _default_device_name("qemu")
        err = _validate_session_id(name)
        if err:
            return {"error": err}
        try:
            _parsed, res, _pd = _run_qemu(["run-app", name, package_name], timeout=60)
        except RuntimeError as e:
            return {"error": str(e)}
        if res.get("error"):
            return {"error": res["error"]}
        out = (res.get("stdout") or res.get("stderr") or "").strip()
        if res.get("returncode", 0) != 0:
            return {"error": f"omnidroid run-app failed (exit {res.get('returncode')}):\n{out[:800]}"}
        return {"stdout": out or f"Requested launch of {package_name} via omnidroid."}

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
        "backend": "string (optional, default 'qemu' — must match whichever backend ensure_emulator_running booted)",
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
        # -b all: clear the crash + system/events buffers too, not just main.
        _run([adb, "-s", serial_or_err, "logcat", "-b", "all", "-c"], timeout=15)
        return {"stdout": "Logcat buffer cleared (all buffers)."}
    try:
        max_lines = int(max_lines)
    except (TypeError, ValueError):
        max_lines = 300
    # -b all so a native crash (crash buffer) or a process-death event
    # (am_proc_died in system/events) is actually in the dump — the plain main
    # buffer misses both, which is exactly the evidence a crash hunt needs.
    args = [adb, "-s", serial_or_err, "logcat", "-b", "all", "-d"]
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


# Crash/ANR/native-fault/process-death extraction lives in the shared
# _emulator_diagnostics.extract_crash_traces (package-scoped, dedup'd, and it
# also catches am_proc_died / low-memory kills). monitor_logcat calls that
# directly — no local copy to drift out of sync.


@registry.register(
    name="monitor_logcat",
    description=(
        "Captures a real-time logcat WINDOW from the running emulator and returns ONLY the crash/ANR/"
        "process-death stack traces found in it — not the whole buffer — so you get the signal (why it "
        "crashed) without flooding context with routine log spam. It clears ALL buffers, watches for "
        "duration_seconds while the app runs, then extracts every FATAL EXCEPTION, native fault "
        "(SIGSEGV/abort/backtrace), ANR, and low-memory kill/process-death block with its stack trace, "
        "and hands back the most recent ones. Reads all buffers (-b all) so native crashes (crash "
        "buffer) and 'process has died' events (system/events buffer) are actually seen — the plain "
        "main buffer misses both. Pass package_name to scope detection to YOUR app so an unrelated "
        "system crash isn't misattributed. "
        "Typical loop: launch_app_on_emulator, then monitor_logcat to see if/why it died, patch, repeat."
    ),
    params_schema={
        "duration_seconds": "number (optional, default 15 — how long to watch after clearing the buffer; capped at 120)",
        "max_traces": "integer (optional, default 5 — how many of the most recent crash/ANR blocks to return)",
        "package_name": "string (optional but RECOMMENDED — scope crash/death detection to this app package so an unrelated process's crash isn't reported as yours)",
        "extra_pattern": "string (optional, Python regex — if set, also returns the last matching lines when NO crash block is detected, e.g. a tag you're tracking)",
        "clear_first": "boolean (optional, default true — clear the buffer before the window so only fresh events are captured)",
        "backend": "string (optional, default 'qemu' — must match ensure_emulator_running's backend)",
        "device_name": "string (optional — must match ensure_emulator_running's device_name if overridden)"
    },
    output="The most recent crash/ANR/process-death stack traces captured in the window, each as a self-contained block, with a count of how many were found. If none were detected, a note saying so (plus extra_pattern matches if you supplied one) — which usually means the app did NOT crash during the window.",
    when_to_use="Use this right after launching or interacting with the app to find out if it crashed and get the exact stack trace to fix — it keeps only the traces, so it's safe on context. For a full/unfiltered buffer dump, or to just grep the log, use get_logcat instead."
)
def monitor_logcat(duration_seconds=15, max_traces=5, package_name=None, extra_pattern=None,
                   clear_first=True, backend=_DEFAULT_BACKEND, device_name=None):
    adb, serial_or_err = _resolve_serial(backend, device_name)
    if adb is None:
        return serial_or_err
    try:
        duration_seconds = float(duration_seconds)
    except (TypeError, ValueError):
        duration_seconds = 15.0
    duration_seconds = max(1.0, min(duration_seconds, 120.0))
    try:
        max_traces = int(max_traces)
    except (TypeError, ValueError):
        max_traces = 5
    max_traces = max(1, min(max_traces, 20))

    if _truthy(clear_first):
        _run([adb, "-s", serial_or_err, "logcat", "-b", "all", "-c"], timeout=15)

    # Watch the window, then dump what accumulated. subprocess.run captures
    # all-or-nothing on timeout, so we sleep-then-dump rather than stream (the
    # same approach record_and_capture_keyframes uses for its logcat capture).
    # -b all -v epoch: include the crash + system/events buffers and epoch
    # timestamps, so native faults and 'am_proc_died' are captured too.
    time.sleep(duration_seconds)
    res = _run([adb, "-s", serial_or_err, "logcat", "-b", "all", "-v", "epoch", "-d"], timeout=60)
    if res.get("error"):
        return res
    text = res.get("stdout", "") or ""

    # Shared analyzer (also detects ANR, native faults, and process death; dedups
    # repeated tags; scopes to package_name when given).
    blocks, total = extract_crash_traces(text, max_traces=max_traces, package_name=package_name)
    header = f"=== monitor_logcat: watched {duration_seconds:.0f}s window ===\n"
    if blocks:
        shown = (
            f"{header}Found {total} crash/ANR block(s); showing the most recent {len(blocks)}:\n\n"
            + "\n\n----------\n\n".join(blocks)
        )
        return {"stdout": shown}

    # No crash detected — usually good news. Optionally surface tracked lines.
    note = header + "No crash/ANR/native-fault stack traces detected in this window (the app likely did NOT crash)."
    if extra_pattern:
        try:
            pat = re.compile(extra_pattern, re.IGNORECASE)
            matches = [l for l in text.splitlines() if pat.search(l)][-max_traces * 10:]
            if matches:
                note += f"\n\nLast lines matching '{extra_pattern}':\n" + "\n".join(matches)
            else:
                note += f"\n(No lines matched extra_pattern '{extra_pattern}' either.)"
        except re.error as e:
            note += f"\n(extra_pattern '{extra_pattern}' is not a valid regex: {e})"
    return {"stdout": note}


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
        "backend": "string (optional, default 'qemu' — must match whichever backend ensure_emulator_running booted)",
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


# --------------------------------------------------------------------------
# Capture: engine (millisecond-precise VNC) with an adb-polling fallback, both
# feeding the SAME crash/exit diagnostics so a black screen is never mistaken
# for a crash (and vice versa).
# --------------------------------------------------------------------------

def _qemu_capture_capability():
    """`version --json` handshake -> normalized capture capability. Returns a
    dict; `supported` is False on any engine that predates the `capture` command
    so callers transparently fall back to adb polling."""
    try:
        parsed, _res, _pd = _run_qemu(["version", "--json"], timeout=30)
    except RuntimeError:
        return {"supported": False}
    return capture_capability(parsed if isinstance(parsed, dict) else {})


def _adb_pidof(adb, serial, package):
    """Current pid of `package` in the guest (first one), or None."""
    if not package:
        return None
    res = _run([adb, "-s", serial, "shell", "pidof", package], timeout=10)
    for tok in (res.get("stdout") or "").split():
        if tok.isdigit():
            return int(tok)
    return None


class _PidTracker(threading.Thread):
    """Polls `pidof <package>` on a background thread during an adb-fallback
    capture, timing when the app process STARTS and (the key crash/close signal)
    DISAPPEARS. Events share the capture's monotonic start so they line up with
    frame t_ms. Emits merge_diagnostics-shaped events (app_started/app_restarted/
    app_exited)."""

    def __init__(self, adb, serial, package, start_ns, interval=0.5):
        super().__init__(name="agent-pid-tracker", daemon=True)
        self.adb, self.serial, self.package = adb, serial, package
        self.start_ns, self.interval = start_ns, interval
        self._stop = threading.Event()
        self.events = []
        self.last_pid = None
        self.ever_started = False

    def _t_ms(self):
        return max(0, int(round((time.monotonic_ns() - self.start_ns) / 1e6)))

    def run(self):
        while not self._stop.is_set():
            pid = _adb_pidof(self.adb, self.serial, self.package)
            t = self._t_ms()
            if pid and self.last_pid is None:
                self.events.append({"type": ("app_restarted" if self.ever_started
                                             else "app_started"), "t_ms": t, "pid": pid})
                self.ever_started = True
            elif pid and self.last_pid and pid != self.last_pid:
                self.events.append({"type": "app_restarted", "t_ms": t, "pid": pid})
            elif not pid and self.last_pid is not None:
                self.events.append({"type": "app_exited", "t_ms": t, "pid": self.last_pid})
            self.last_pid = pid
            self._stop.wait(self.interval)

    def stop(self):
        self._stop.set()


def _capture_verdict(meta):
    """One-line, plain-language verdict the TEXT-ONLY agent leads with: does the
    evidence say the app CRASHED, was CLOSED/killed, is merely on a BLACK screen
    while still alive, or ran fine? Crash/exit come from process+logcat evidence;
    black is only a visual flag — they are reported independently."""
    frames = meta.get("keyframes") or []
    last = frames[-1] if frames else {}
    last_black = bool(last.get("black_screen"))
    if meta.get("crash_detected"):
        crashes = meta.get("crashes") or []
        why = (crashes[-1].get("summary") if crashes and isinstance(crashes[-1], dict) else "")
        return "APP CRASHED during the capture window" + (f" — {why[:200]}" if why else "") \
            + (". The final frame is also black (the crash blanked the screen)." if last_black else ".")
    if meta.get("anr_detected"):
        return "APP NOT RESPONDING (ANR) during the capture window."
    if meta.get("exit_detected"):
        return ("APP PROCESS EXITED/was CLOSED during the capture window (the app is no "
                "longer running)" + (" and the screen is black" if last_black else "") + ".")
    if meta.get("app_state") == "not_started":
        return "The app process was NEVER seen running during the window (it did not start)."
    if last_black:
        state = meta.get("app_state")
        if state == "running":
            return ("Screen is BLACK but the app process is STILL ALIVE — this is NOT a crash "
                    "(likely a render/surface/black-splash issue, not a process death).")
        return "The final frame is BLACK; no crash/exit was detected in the process or logs."
    return f"App ran through the window (app_state={meta.get('app_state', 'unknown')}); no crash/exit detected."


def _apply_capture_diagnostics(session_dir, package_name, process_events, meta):
    """Fold logcat + process-lifecycle evidence into `meta` so every keyframe
    gets an app_state and crash/ANR/exit are detected INDEPENDENTLY of the
    black-screen visual flag. Reads the session's logcat.txt (written as
    `-b all -v epoch`), lets merge_diagnostics own per-frame app_state, then
    writes the enriched metadata.json. Returns the enriched meta."""
    logcat_path = os.path.join(session_dir, "logcat.txt")
    logcat_text = ""
    if os.path.isfile(logcat_path):
        with open(logcat_path, encoding="utf-8", errors="replace") as f:
            logcat_text = f.read()
    known_pids = [e.get("pid") for e in (process_events or []) if e.get("pid")]
    log_analysis = analyze_logcat(
        logcat_text, package_name=package_name,
        start_epoch_ms=meta.get("start_epoch_ms"), known_pids=known_pids)
    # When scoping to a package, the agent's package-scoped logcat analysis is
    # AUTHORITATIVE: drop the engine's BROAD crash flags/events (it flags any
    # FATAL/signal in the whole log) so an unrelated app's crash isn't
    # misattributed to ours. The engine's pid-lifecycle events stay — its poller
    # already tracked THIS package — but its non-scoped 'app_crashed' is dropped;
    # merge_diagnostics re-adds a package-scoped crash from log_analysis.
    if package_name:
        for k in ("crash_detected", "anr_detected", "exit_detected"):
            meta[k] = False
        meta["crashes"] = []
        process_events = [e for e in (process_events or []) if e.get("type") != "app_crashed"]
    # merge_diagnostics is authoritative for per-frame app_state — clear any
    # engine guess to 'unknown' so its timeline walk decides cleanly.
    for fr in meta.get("keyframes", []):
        fr["app_state"] = "unknown"
    meta = merge_diagnostics(meta, process_events or [], log_analysis,
                             package_name=package_name)
    write_metadata_atomic(os.path.join(session_dir, "metadata.json"), meta)
    return meta


def _capture_via_engine(name, session_dir, duration_seconds, package_name,
                        change_percent, black_threshold, sample_scale_w):
    """Run the engine's millisecond-precise `capture` and load its metadata.
    Returns (meta_dict, None) on success or (None, error_string)."""
    argv = ["capture", name, "--out", session_dir,
            "--duration", str(duration_seconds),
            "--change-percent", str(change_percent),
            "--black-threshold", str(black_threshold),
            "--sample-scale-w", str(int(sample_scale_w)), "--json"]
    if package_name:
        argv += ["--package", package_name]
    try:
        parsed, res, _pd = _run_qemu(argv, timeout=int(float(duration_seconds)) + 180)
    except RuntimeError as e:
        return None, str(e)
    if res.get("error"):
        return None, res["error"]
    if not (isinstance(parsed, dict) and parsed.get("ok")):
        detail = (parsed.get("message") if isinstance(parsed, dict) else None) \
            or (res.get("stdout") or res.get("stderr") or "").strip()
        return None, f"engine capture did not succeed: {str(detail)[:500]}"
    try:
        engine_path = _find_qemu_manager()[0]
    except RuntimeError:
        engine_path = None
    meta = load_capture_result(session_dir, parsed, provider="omnidroid",
                               engine_path=engine_path)
    return meta, None


@registry.register(
    name="record_and_capture_keyframes",
    description=(
        "Watches the emulator's screen for a fixed duration and keeps only the frames where the screen "
        "changed MEANINGFULLY — a small looping loading animation (a spinner, a pulsing icon) does NOT "
        "trigger a new keyframe, but a real page/screen transition does, and a move into/out of a black "
        "screen is always flagged. It also tracks the APP PROCESS and captures the full logcat window, "
        "so it can tell 'the app CRASHED/closed' apart from 'the screen is black but the app is still "
        "alive' — reported as an up-front VERDICT. "
        "PREFERS the omnidroid engine's MILLISECOND-PRECISE capture: it observes EVERY VNC framebuffer "
        "update (not a 1 Hz poll), so a loading screen shown for only a few milliseconds before a black "
        "screen is caught as two keyframes with the true gap (delta_ms) between them; it falls back to "
        "'adb exec-out screencap -p' polling on an engine too old to support capture. Logcat is captured "
        "as '-b all -v epoch' (all buffers, epoch timestamps) and clears right before the window so the "
        "screenshots and logs cover the exact same interval. "
        "Writes /workspace/screenshots/<session_name>/ (keyframe PNGs + metadata.json + logcat.txt) — "
        "call analyze_keyframes next for descriptions, then generate_test_report to assemble the report."
    ),
    params_schema={
        "session_name": "string (a name for this test session, e.g. 'login_flow_v2' — used as the output subfolder name)",
        "package_name": "string (optional but RECOMMENDED — the app package, e.g. 'com.example.app'. Enables process-lifecycle tracking so a crash/close is distinguished from a black screen; also scopes crash detection to THIS app so an unrelated system crash isn't misattributed)",
        "duration_seconds": "number (optional, default 20 — how long to watch the screen)",
        "interval_seconds": "number (optional, default 1.0 — adb-FALLBACK sampling period only; ignored by the engine path, which is event-driven at display rate)",
        "change_threshold": "number (optional, default 4 — mean per-pixel delta (0-255) vs the last KEPT keyframe to count as a change; a sensitivity backstop)",
        "black_threshold": "number (optional, default 10 — a frame with average brightness below this is flagged black_screen)",
        "sample_scale_w": "integer (optional, default 160 — downscale width for change detection; does NOT affect the SAVED keyframe PNGs, which are full-resolution)",
        "capture_logcat": "boolean (optional, default true — capture logcat for the window; the engine path always captures it)",
        "auto_analyze": "boolean (optional, default true — right after capture, run the VISION model over the kept keyframes and include a plain-language description of each in the result, so you SEE what happened without a second call. Set false to skip (e.g. to capture fast and analyze later, or when no vision model is configured).",
        "vision_max_frames": "integer (optional, default 16 — cap on how many kept keyframes get an auto vision call; first/last/black/crash/transition frames are prioritized).",
        "backend": "string (optional, default 'qemu' — must match whichever backend ensure_emulator_running booted)",
        "device_name": "string (optional — must match the device_name ensure_emulator_running used, if you overrode it)"
    },
    output="A VERDICT line first (crashed / exited / black-but-alive / ran-ok), the capture provider (omnidroid millisecond-precise vs adb polling), then per-keyframe index, timestamp t_ms and gap (+delta_ms), changed%, black-screen flag, app_state, and (when auto_analyze is on) a vision description of each kept frame. Full-resolution PNGs are also saved to disk.",
    when_to_use="Call this after launch_app_on_emulator to watch what happens as the app starts/you interact with it. Pass package_name so it can tell a crash from a black screen. With auto_analyze on (default) it also describes each significant frame with the vision model, so you can reason over what actually rendered before the next step."
)
def record_and_capture_keyframes(session_name, package_name=None, duration_seconds=20, interval_seconds=1.0,
                                  change_threshold=4, black_threshold=10, sample_scale_w=160, capture_logcat=True,
                                  auto_analyze=True, vision_max_frames=16,
                                  backend=_DEFAULT_BACKEND, device_name=None):
    adb, serial_or_err = _resolve_serial(backend, device_name)
    if adb is None:
        return serial_or_err
    try:
        session_dir = resolve_workspace_path(f"screenshots/{session_name}")
    except RuntimeError as e:
        return {"error": str(e)}
    os.makedirs(session_dir, exist_ok=True)

    try:
        duration_seconds = float(duration_seconds)
        interval_seconds = float(interval_seconds)
        change_threshold = float(change_threshold)
        black_threshold = float(black_threshold)
        sample_scale_w = int(sample_scale_w)
    except (TypeError, ValueError):
        return {"error": "duration_seconds/interval_seconds/change_threshold/black_threshold/sample_scale_w must be numeric."}

    device_name = device_name or _default_device_name()
    # Scene threshold as % of changed pixels — the engine's units. 2% is the
    # shared default across both capture paths: measured, it sits just above the
    # ~1% noise floor of an animating spinner/progress bar while still catching a
    # small popup (see omnidroid/manager/capture.py's DEFAULT_* rationale).
    change_percent = 2.0

    # --- Preferred path: engine millisecond-precise VNC capture --------------
    provider = "adb_fallback"
    meta = None
    engine_note = ""
    cap = _qemu_capture_capability() if backend == "qemu" else {"supported": False}
    if cap.get("supported"):
        meta, err = _capture_via_engine(
            device_name, session_dir, duration_seconds, package_name,
            change_percent, black_threshold, sample_scale_w)
        if meta is not None:
            provider = "omnidroid"
        else:
            engine_note = (f"\n[note] engine capture was advertised but failed ({err}); "
                           "fell back to adb screencap polling.")

    # --- Fallback path: adb screencap polling + a background PID tracker ------
    if meta is None:
        do_logcat = _truthy(capture_logcat)
        # -b all -v epoch: crash/exit lines (am_proc_died, 'has died') live in the
        # system/crash buffers and analyze_logcat needs epoch timestamps to place
        # them on the frame timeline. The old 'logcat -c' / 'logcat -d' (main
        # buffer, brief format) captured neither — that was the logcat gap.
        if do_logcat:
            _run([adb, "-s", serial_or_err, "logcat", "-b", "all", "-c"], timeout=15)
        start_ns = time.monotonic_ns()
        start_epoch_ms = time.time_ns() // 1_000_000
        tracker = None
        if package_name:
            tracker = _PidTracker(adb, serial_or_err, package_name, start_ns)
            tracker.start()
        try:
            capture_keyframes(adb, session_dir, duration_seconds, interval_seconds,
                              change_threshold, black_threshold, sample_scale_w,
                              serial=serial_or_err, change_percent=change_percent,
                              start_monotonic_ns=start_ns, start_epoch_ms=start_epoch_ms)
        except Exception as e:
            if tracker:
                tracker.stop()
            return {"error": f"Frame capture failed: {e}"}
        if tracker:
            tracker.stop()
            tracker.join(timeout=2)
        if do_logcat:
            logcat_res = _run([adb, "-s", serial_or_err, "logcat", "-b", "all", "-v", "epoch", "-d"], timeout=45)
            with open(os.path.join(session_dir, "logcat.txt"), "w", encoding="utf-8", errors="replace") as f:
                f.write(logcat_res.get("stdout", ""))
        # Reload the metadata the fallback wrote so both paths share the merge step.
        meta_path = os.path.join(session_dir, "metadata.json")
        with open(meta_path, encoding="utf-8") as f:
            meta = json.load(f)
        meta = normalize_capture_metadata(meta, provider="adb_fallback")
        meta["process_events"] = list(tracker.events) if tracker else []

    # --- Shared: fold crash/exit diagnostics into every keyframe -------------
    process_events = meta.get("process_events") or []
    meta = _apply_capture_diagnostics(session_dir, package_name, process_events, meta)

    verdict = _capture_verdict(meta)
    body = summarize_capture(meta)
    header = (f"VERDICT: {verdict}\n"
              f"Capture provider: {'omnidroid (millisecond-precise, every display update)' if provider == 'omnidroid' else 'adb screencap polling (fallback)'}"
              + (f" — every ~{interval_seconds:g}s" if provider != 'omnidroid' else "") + ".")
    if not package_name:
        header += ("\n[hint] pass package_name next time so a crash/close can be distinguished from a "
                   "black screen with process-lifecycle evidence.")

    # Auto-reason over the significant frames with the VISION model, so the caller
    # SEES what each big on-screen change was (menu opened, dialog, crash screen)
    # without a second tool call. Skipped when turned off or no vision model exists.
    vision_block = ""
    if _truthy(auto_analyze) and (meta.get("keyframes")):
        if not has_vision_model():
            vision_block = ("\n\n[vision] auto_analyze is on but no vision model is configured — "
                            "add one in LLM Settings (provider → 'vision models') to describe frames.")
        else:
            try:
                summary = _vision_analyze_session(session_dir, backend="auto",
                                                  max_frames=int(vision_max_frames))
                vision_block = "\n\nVISION (image-to-text) frame descriptions:\n" + summary
            except Exception as e:
                vision_block = f"\n\n[vision] auto analysis failed ({e}); run analyze_keyframes manually."
    return {"stdout": f"{header}\n\n{body}{engine_note}{vision_block}"}


# --------------------------------------------------------------------------
# Always-on dev auto-screenshots (DEV BASE ONLY) — read side
# --------------------------------------------------------------------------
# The recorder is NOT toggled by the agent: the omnidroid engine auto-starts a
# continuous `capture --auto` the moment a dev instance finishes booting (see
# _agent_ensure_autocap / OMNI_AUTOCAP_DIR), so screenshots are ALWAYS being
# captured to /workspace/screenshots/auto/ whenever a dev emulator is up. It
# drops a keyframe on EVERY big on-screen change (a spinner stays below
# threshold; a black->loading flip is always caught), flushes metadata.json
# live, and names files frame_<idx>_t<elapsed>ms_+<gap>ms_w<HHMMSS_mmm>.png so an
# INSTANT transition is distinguishable from one that TOOK TIME. This tool just
# READS that always-on feed; there is nothing to start or stop.

def _autocap_session_dir(session_name):
    err = _validate_session_id(session_name)
    if err:
        raise ValueError(err)
    return resolve_workspace_path(f"screenshots/{session_name}")


@registry.register(
    name="read_auto_screenshots",
    description=(
        "Reads the ALWAYS-ON auto-screenshot feed for the running dev emulator. You do NOT start or stop "
        "anything — whenever a dev instance is up (ensure_emulator_running(dev=True)), omnidroid is already "
        "capturing a full-resolution PNG on every big on-screen change into /workspace/screenshots/auto/. "
        "This returns whether the recorder is currently running plus a per-keyframe list (index, elapsed "
        "t_ms, gap +delta_ms since the previous kept frame, changed%, black-screen flag, reason, saved "
        "filename), so you can see what has rendered so far while frames keep accumulating. A spinner stays "
        "below threshold (not saved); a black->loading flip is always caught. Use since_index to see only "
        "frames newer than the last one you saw. Filenames encode elapsed + gap-since-previous + wall-clock, "
        "so an instant transition is distinguishable from one that took time."
    ),
    params_schema={
        "session_name": "string (optional, default 'auto' — the always-on feed. Only change this if you pointed a capture at a different screenshots/<name> folder)",
        "since_index": "integer (optional, default 0 — only report keyframes with index >= this, to poll for just the new ones)"
    },
    output="A running/stopped status line, counts (kept keyframes / display updates seen / elapsed ms), and one line per keyframe from since_index onward. Empty-but-running means nothing has changed on screen yet.",
    when_to_use="Call any time the dev emulator is up to see the screens captured so far (e.g. between adb interactions, or right after launching an app) — no setup needed. For a package-scoped crash/exit VERDICT over a bounded window, use record_and_capture_keyframes; for one frame right now, take_emulator_screenshot."
)
def read_auto_screenshots(session_name=_AUTOCAP_SESSION, since_index=0):
    try:
        session_dir = _autocap_session_dir(session_name)
    except (ValueError, RuntimeError) as e:
        return {"error": str(e)}
    meta_path = os.path.join(session_dir, "metadata.json")
    if not os.path.isfile(meta_path):
        return {"error": (f"No auto-screenshot feed at /workspace/screenshots/{session_name}/ yet. "
                          f"Make sure a DEV emulator is running (ensure_emulator_running(dev=True)); "
                          f"the recorder auto-starts on a dev boot.")}
    try:
        with open(meta_path, encoding="utf-8") as f:
            meta = json.load(f)
    except (OSError, ValueError) as e:
        return {"error": f"Could not read metadata.json (a live flush may be mid-write): {e}"}
    try:
        since_index = int(since_index)
    except (TypeError, ValueError):
        since_index = 0

    frames = meta.get("keyframes") or []
    shown = [fr for fr in frames if int(fr.get("index", 0)) >= since_index]
    running = bool(meta.get("running"))
    lines = [
        f"Session '{session_name}': recorder is {'RUNNING' if running else 'STOPPED'}.",
        f"Kept {meta.get('keyframe_count', len(frames))} keyframe(s) from "
        f"{meta.get('samples_taken', 0)} display update(s) over {meta.get('duration_ms', 0)} ms."
        + (f" Tracking {meta.get('package')}." if meta.get('package') else ""),
    ]
    if not shown:
        lines.append(f"(no keyframes at/after index {since_index} yet"
                     + (" — screen unchanged so far)" if running else ")"))
    for fr in shown:
        flag = " [BLACK]" if fr.get("black_screen") else ""
        lines.append(
            f"  frame {fr['index']}: t={fr['t_ms']}ms (+{fr['delta_ms']}ms) "
            f"changed={fr.get('changed_percent', 0):.2f}% reason={fr.get('reason')}"
            f" app={fr.get('app_state', 'unknown')}{flag} -> {fr.get('file')}")
    return {"stdout": "\n".join(lines)}


def _vision_analyze_session(session_dir, backend="auto", ollama_model="llava", prompt=None, max_frames=40):
    """Build the vision cfg (pointed at the configured VISION model) and describe
    the session's keyframes. Shared by analyze_keyframes and the capture tool's
    auto_analyze path. Returns the analyze_session summary string (or raises)."""
    # Route the "api" vision backend through the configured VISION (image-to-text)
    # model — a separate model from the main text LLM (the text model, e.g.
    # DeepSeek, usually can't read images). Falls back to the text endpoint only if
    # no vision model is set, then to local Ollama.
    _vis = get_vision_endpoint_config() or get_openai_endpoint_config()
    cfg = {
        "backend": backend,
        "prompt": prompt,
        "max_frames": max_frames,
        "cline_api_url": _vis["url"],
        "cline_api_key": _vis["key"],
        "cline_model": _vis["model"],
        "ollama_url": "http://localhost:11434",
        "ollama_model": ollama_model,
    }
    return analyze_session(session_dir, cfg)


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
        "prompt": "string (optional — override the default screenshot-description prompt sent to the vision model)",
        "max_frames": "integer (optional, default 40 — cap on how many keyframes get a vision call, to bound cost/latency on long captures. The first/last frame and every black-screen, crash, and state-transition frame are ALWAYS analyzed; low-signal near-duplicate frames past the cap are skipped and noted. Set 0 for no cap.)"
    },
    output="For each keyframe: which backend actually answered ('api' or 'ollama') and its description, or an error if both backends failed for that frame. Ends with an overall 'Analyzed N/M keyframe(s). Backend used: ...' summary line (noting any frames skipped under the budget).",
    when_to_use="Call this after record_and_capture_keyframes, before generate_test_report, so the report includes descriptions instead of just raw image links."
)
def analyze_keyframes(session_name, backend="auto", ollama_model="llava", prompt=None, max_frames=40):
    try:
        session_dir = resolve_workspace_path(f"screenshots/{session_name}")
    except RuntimeError as e:
        return {"error": str(e)}
    if not os.path.isdir(session_dir):
        return {"error": f"No session directory found at {session_dir} — run record_and_capture_keyframes first."}
    try:
        summary = _vision_analyze_session(session_dir, backend, ollama_model, prompt, max_frames)
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
    # Lead with the machine-readable VERDICT: this is the first (and sometimes
    # only) thing the text-only agent reads, so crash-vs-black must be up top.
    out.append("")
    out.append("## Verdict")
    out.append(f"**{_capture_verdict(meta)}**")
    out.append("")
    out.append(f"- app_state (final): `{meta.get('app_state', 'unknown')}`")
    out.append(f"- crash_detected: `{bool(meta.get('crash_detected'))}`  |  "
               f"anr_detected: `{bool(meta.get('anr_detected'))}`  |  "
               f"exit_detected: `{bool(meta.get('exit_detected'))}`")
    provider = meta.get("capture_provider", "unknown")
    coverage = meta.get("coverage", "")
    out.append(f"- capture: `{provider}`" + (f" ({coverage})" if coverage else "")
               + f", timing precision `{meta.get('timestamp_precision', 'milliseconds')}`")
    out.append("")
    if package_name:
        out.append(f"Package: {package_name}")
    if apk_path:
        out.append(f"APK: {apk_path}")
    out.append(f"Duration: {meta.get('duration_ms', 0)} ms")
    out.append(f"Samples/updates seen: {meta.get('samples_taken')} / Keyframes kept: {len(meta.get('keyframes', []))}")
    out.append(f"Vision backend used: {meta.get('vision_backend_used')}")

    # Process-lifecycle timeline (start/exit/crash) — the evidence behind the
    # verdict, with millisecond timing so a brief run-then-crash is visible.
    events = [e for e in (meta.get("events") or []) if e.get("type") in
              ("app_started", "app_restarted", "app_exited", "app_killed", "app_crashed", "anr")]
    if events:
        out.append("")
        out.append("## Process timeline")
        for e in events:
            t = e.get("t_ms")
            when = f"t={t}ms" if t is not None else "t=?"
            line = f"- {when}  **{e.get('type')}**" + (f" (pid {e.get('pid')})" if e.get("pid") else "")
            if e.get("summary"):
                line += f" — {e['summary'][:200]}"
            out.append(line)

    out.append("")
    out.append("## Keyframes")
    for kf in meta.get("keyframes", []):
        flags = []
        if kf.get("black_screen"):
            flags.append("BLACK SCREEN")
        if kf.get("crash"):
            flags.append("CRASH")
        flag = f" **[{' | '.join(flags)}]**" if flags else ""
        out.append(
            f"### Frame {kf['index']} -- t={kf.get('t_ms', 0)}ms (+{kf.get('delta_ms', 0)}ms since prev) "
            f"changed={kf.get('changed_percent', 0)}% app_state={kf.get('app_state', 'unknown')}{flag}")
        out.append(f"![frame](../screenshots/{session_name}/{kf['file']})")
        desc = kf.get("vision_description")
        if desc:
            out.append(f"Description ({kf.get('vision_backend')}): {desc}")
        else:
            err = kf.get("vision_error") or "not yet analyzed — run analyze_keyframes first"
            out.append(f"Description: (unavailable — {err})")
        out.append("")

    # Crash/ANR stack traces first (the actionable part), then a raw log tail.
    crashes = meta.get("crashes") or []
    if crashes:
        out.append("## Crash / ANR stack traces")
        for c in crashes[-3:]:
            out.append("```")
            out.append((c.get("trace") or c.get("summary") or "").strip()[:6000])
            out.append("```")
    out.append("## Logcat (last 400 lines captured during the test window)")
    out.append("```")
    out.append(logcat_text if logcat_text else "(no logcat captured)")
    out.append("```")

    report_path = os.path.join(report_dir, f"{session_name}.md")
    with open(report_path, "w", encoding="utf-8") as f:
        f.write("\n".join(out))
    return {"stdout": f"Report written to /workspace/test_reports/{session_name}.md"}


# Packages allowed to exist on a "fresh" instance. The omnidroid kiosk is a
# /system app on the x86 base (invisible to `pm list packages -3`) but ships in
# the provisioned /data pair on the arm base, so it is whitelisted explicitly.
_FRESH_INSTANCE_WHITELIST = {"com.omni.kiosk"}


def _verify_fresh_instance(backend=_DEFAULT_BACKEND, device_name=None):
    """FRESHNESS GUARANTEE for APK test sessions: assert the booted instance has
    NO third-party packages installed (beyond omnidroid's own kiosk). A truly
    fresh account (remove + create from the immutable base) cannot have any; if
    one somehow shows up anyway (an engine regression, a base with an app baked
    into its /data), it is uninstalled here so the APK under test NEVER runs
    beside leftovers from an earlier run. Returns {"stdout": ...} once the
    instance is verified clean, or {"error": ...} when freshness could not be
    verified/restored — in which case the session must ABORT rather than test
    on a dirty instance."""
    adb, serial_or_err = _resolve_serial(backend, device_name)
    if adb is None:
        return serial_or_err
    res = _run([adb, "-s", serial_or_err, "shell", "pm", "list", "packages", "-3"], timeout=30)
    if res.get("error") or res.get("returncode", 0) != 0:
        detail = res.get("error") or (res.get("stderr") or res.get("stdout") or "").strip()[:300]
        return {"error": f"could not list installed packages to verify freshness: {detail}"}
    leftovers = []
    for line in (res.get("stdout") or "").splitlines():
        line = line.strip()
        if line.startswith("package:"):
            pkg = line[len("package:"):].strip()
            if pkg and pkg not in _FRESH_INSTANCE_WHITELIST:
                leftovers.append(pkg)
    if not leftovers:
        return {"stdout": "Verified fresh: no third-party packages installed on the instance."}
    removed, failed = [], []
    for pkg in leftovers:
        r = _run([adb, "-s", serial_or_err, "shell", "pm", "uninstall", pkg], timeout=60)
        out = ((r.get("stdout") or "") + (r.get("stderr") or "")).strip()
        if r.get("error") or "Success" not in out:
            failed.append(f"{pkg} ({r.get('error') or out[:120] or 'no output'})")
        else:
            removed.append(pkg)
    if failed:
        return {"error": ("instance is NOT fresh and could not be cleaned — leftover package(s) "
                          "survived uninstall: " + ", ".join(failed))}
    return {"stdout": ("Instance had leftover third-party package(s) despite the reset — removed "
                       + ", ".join(removed) + ". Now verified fresh.")}


@registry.register(
    name="run_apk_test_session",
    description=(
        "One-shot orchestrator that runs the entire test pipeline: ensure_emulator_running -> "
        "install_apk_on_emulator -> launch_app_on_emulator -> record_and_capture_keyframes -> "
        "analyze_keyframes -> generate_test_report. Use this for the common case of 'test this APK "
        "and tell me how it performs' in a single call; use the individual tools instead when you "
        "need finer control (e.g. re-running analyze_keyframes with a different vision backend, or "
        "driving the app interactively with adb_shell between capture windows). Defaults to the "
        "self-contained 'qemu' emulator backend (no Android Studio / LDPlayer install required). "
        "FRESHNESS GUARANTEE: every session runs on a FRESH instance — the account is removed and "
        "recreated from the immutable base (reset is FORCED true; passing reset=false is ignored), "
        "and after boot the harness VERIFIES no third-party packages are installed (uninstalling any "
        "leftover) before the APK under test goes on. Nothing from a previous run can be present. "
        "NOT for Roblox: this pipeline has NO concept of accounts, cookies, or the session bootstrap — "
        "it does a plain install + launch_app_on_emulator (opens the app's own home/menu screen). Given a "
        "Roblox cookie/place id, it will silently land on Roblox's own login screen while still reporting "
        "install+launch as successful, on a throwaway 'omniagent'-named instance instead of one named for "
        "the account. For any Roblox cookie-login/join scenario use launch_roblox_build (or "
        "login_roblox_account + play_roblox) instead — never this."
    ),
    params_schema={
        "apk_path": "string (path to the .apk to test, relative to /workspace)",
        "package_name": "string (the app's package name, needed to launch it and label the report)",
        "activity": "string (optional, specific activity to launch; omit to use the default launcher activity)",
        "backend": "string (optional — omnidroid is the ONLY backend; any other value is coerced to it. No SDK emulator / AVD / LDPlayer)",
        "device_name": "string (optional — the reused omnidroid account name, default 'omniagent')",
        "system_image": "string (IGNORED — was AVD-only)",
        "device_profile": "string (IGNORED — was AVD-only)",
        "mode": "string (optional, qemu backend only, default 'playable' — RAM/CPU tier: 'playable'/'hard'/'brutal')",
        "ram_mb": "integer (optional, qemu backend only — override guest RAM in MB (--mem); defaults to the mode's tier)",
        "cpus": "integer (optional — IGNORED on qemu (vCPUs come from 'mode'); accepted for backend compatibility)",
        "duration_seconds": "number (optional, default 20 — how long to watch the screen after launch)",
        "vision_backend": "string (optional, default 'auto' — 'auto', 'api', or 'ollama', see analyze_keyframes)",
        "ollama_model": "string (optional, default 'llava')",
        "reset": "boolean (IGNORED — always coerced to true: a test session ALWAYS starts from a freshly recreated instance and verifies nothing is installed on it. Use the individual tools (ensure_emulator_running reset=false + install/launch) when you deliberately want to reuse a provisioned instance for fast iteration)",
        "boot_timeout": "integer (optional, default 300 seconds)",
        "abi": "string (optional, qemu backend — force the install ABI. Default exercises the intended path per account arch (x86 -> arm64-v8a translation, arm -> native). 'x86_64' on an x86 account deliberately trips the ABI-contract guard and FAILS the session.)",
        "dev": "boolean (optional, default false — run the session on the DEV base (base_arm + the vdc devkit disk: android-arm64 frida-server + Magisk + omni tools) instead of a production base. Also enablable via OMNI_USE_DEV_BASE. Use when the APK under test has frida/root detection and you need runtime hooking; call ensure_frida_server + hide_root_from_app between steps via the individual tools for full control.)"
    },
    output="A summary of each pipeline stage plus the path to the generated Markdown report — read that report with read_file_chunk for the full picture (keyframe descriptions + logcat). If the ABI-safe install fails/violates the contract, or the fresh-instance guarantee cannot be verified after boot, the session ABORTS with a FAILED summary and no pass is emitted.",
    when_to_use="Use this as the default way to test a freshly built/signed APK end-to-end. Fall back to the individual tools (ensure_emulator_running, install_apk_on_emulator, etc.) if you need to interleave manual adb_shell actions between steps, or re-run just one stage."
)
def run_apk_test_session(apk_path, package_name, activity=None, backend=_DEFAULT_BACKEND, device_name=None,
                          system_image=_DEFAULT_SYSTEM_IMAGE, device_profile="pixel_5",
                          duration_seconds=20, vision_backend="auto", ollama_model="llava",
                          reset=True, boot_timeout=300, ram_mb=None, cpus=None, mode=_DEFAULT_QEMU_MODE,
                          abi=None, require_translation=True, dev=None):
    session_name = f"{package_name.replace('.', '_')}_{int(time.time())}"
    log = []

    # FRESHNESS GUARANTEE: a test session ALWAYS runs on a freshly recreated
    # instance. `reset` is accepted only for call-compatibility — any falsy
    # value is overridden so no caller can test on an instance that might still
    # carry apps/state from an earlier run.
    if not _truthy(reset):
        log.append("[freshness] reset=false was requested but is IGNORED — "
                   "run_apk_test_session always recreates the instance fresh.")
    reset = True

    boot_res = ensure_emulator_running(
        backend=backend, device_name=device_name, system_image=system_image,
        device_profile=device_profile, reset=reset, boot_timeout=boot_timeout,
        ram_mb=ram_mb, cpus=cpus, mode=mode, dev=dev,
    )
    log.append("[ensure_emulator_running]\n" + (boot_res.get("stdout") or boot_res.get("error") or ""))
    if "BOOT_OK" not in (boot_res.get("stdout") or ""):
        return {"stdout": "Emulator failed to boot -- aborting test session.\n\n" + "\n\n".join(log)[:4000]}

    # Verify (and if needed restore) the fresh-instance guarantee BEFORE the
    # install: the APK under test must be the only third-party app present.
    fresh_res = _verify_fresh_instance(backend=backend, device_name=device_name)
    log.append("[verify_fresh_instance]\n" + (fresh_res.get("stdout") or fresh_res.get("error") or ""))
    if fresh_res.get("error"):
        return {"stdout": "Fresh-instance guarantee FAILED (could not verify a clean instance) -- "
                          "aborting test session; NOT emitting a pass.\n\n" + "\n\n".join(log)[:4000]}

    install_res = install_apk_on_emulator(apk_path, backend=backend, device_name=device_name,
                                          abi=abi, require_translation=require_translation)
    log.append("[install_apk_on_emulator]\n" + (install_res.get("stdout") or install_res.get("error") or ""))
    # ABI-safety gate (Finding B, client side): a failed or ABI-violating install
    # must FAIL the whole session — never fall through to a report that reads as a
    # pass while the app was tested on the wrong (native x86_64) path.
    if install_res.get("error"):
        return {"stdout": "APK install FAILED (ABI-contract violation or install error) -- aborting "
                          "test session; NOT emitting a pass.\n\n" + "\n\n".join(log)[:4000]}

    launch_res = launch_app_on_emulator(package_name, activity, backend=backend, device_name=device_name)
    log.append("[launch_app_on_emulator]\n" + (launch_res.get("stdout") or launch_res.get("error") or ""))

    # Pass package_name so capture tracks the process and can tell a CRASH from a
    # black screen (the verdict flows into the report the text-only agent reads).
    capture_res = record_and_capture_keyframes(session_name, package_name=package_name,
                                                 duration_seconds=duration_seconds,
                                                 backend=backend, device_name=device_name)
    log.append("[record_and_capture_keyframes]\n" + (capture_res.get("stdout") or capture_res.get("error") or ""))

    analyze_res = analyze_keyframes(session_name, backend=vision_backend, ollama_model=ollama_model)
    log.append("[analyze_keyframes]\n" + (analyze_res.get("stdout") or analyze_res.get("error") or ""))

    report_res = generate_test_report(session_name, package_name=package_name, apk_path=apk_path)
    log.append("[generate_test_report]\n" + (report_res.get("stdout") or report_res.get("error") or ""))

    report_path = f"/workspace/test_reports/{session_name}.md"
    # Surface the capture VERDICT in the one-shot summary too, so the model sees
    # crash/exit/black up front without having to open the report first.
    verdict_line = ""
    for _l in (capture_res.get("stdout") or "").splitlines():
        if _l.startswith("VERDICT:"):
            verdict_line = _l + "\n"
            break
    summary = (f"Test session '{session_name}' complete.\n{verdict_line}Report: {report_path}\n\n"
               + "\n\n".join(log))
    return {"stdout": summary[:6000] + f"\n\n[Read the full report with read_file_chunk on {report_path}]"}


@registry.register(
    name="stop_emulator",
    description=(
        "Stops the running emulator/account. For the default 'qemu' (omnidroid) backend this powers the "
        "instance OFF via the service ('omni stop': in-guest shutdown -> QMP quit -> hard kill), and "
        "with purge=true instead REMOVES the account entirely (deletes its overlay + /data + state so "
        "the next ensure_emulator_running builds a completely fresh, re-provisioned instance). For "
        "'ldplayer' it quits the instance via ldconsole; for 'avd' it sends 'adb emu kill'. qemu VMs "
        "run DETACHED and survive the agent process exiting, so call this when you're done testing to "
        "free RAM/CPU."
    ),
    params_schema={
        "backend": "string (optional, default 'qemu' — must match whichever backend you booted)",
        "device_name": "string (optional — must match the device_name/account name you booted, if overridden)",
        "purge": "boolean (optional, default false — qemu backend only: instead of just powering off, REMOVE the account (DESTRUCTIVE: deletes its /data + state)"
    },
    output="The service's stop/remove output (or the ldconsole/adb output for the other backends). Stopping something that isn't running is not an error.",
    when_to_use="Call when finished testing to release the emulator, or before a fresh run if you want an explicit teardown. Not required between run_apk_test_session calls — reset=true already builds a fresh account each time."
)
def stop_emulator(backend=_DEFAULT_BACKEND, device_name=None, purge=False):
    backend = _coerce_backend(backend)   # omnidroid (qemu) only
    device_name = device_name or _default_device_name()

    err = _validate_session_id(device_name)
    if err:
        return {"error": err}
    # purge -> remove the whole account; otherwise just power it off.
    args = ["remove", device_name, "--json"] if _truthy(purge) else ["stop", device_name, "--json"]
    try:
        parsed, res, _pd = _run_qemu(args, timeout=180)
    except RuntimeError as e:
        return {"error": str(e)}
    if res.get("error"):
        return {"error": res["error"]}
    out = (res.get("stdout") or res.get("stderr") or "").strip()
    if isinstance(parsed, dict) and not parsed.get("ok", True):
        detail = parsed.get("error") or out
        # An account that doesn't exist is already "stopped"/"removed" as far
        # as a teardown call is concerned — treat it as a benign no-op.
        if "no such account" in detail.lower():
            return {"stdout": f"Account '{device_name}' does not exist (nothing to {args[0]})."}
        return {"error": f"omnidroid {args[0]} failed: {detail[:500]}"}
    return {"stdout": out or ("Removed." if _truthy(purge) else "Stopped.")}


# --------------------------------------------------------------------------
# DEV BASE runtime helpers: frida + root/frida/Magisk hiding. The dev base is
# base_arm + the vdc devkit disk (base_arm_devkit.qcow2); root is Magisk (`su`)
# from a patched boot. These only work on an account booted from the dev base
# (ensure_emulator_running dev=true / OMNI_USE_DEV_BASE) whose boot is rooted. On
# a production or un-rooted account they return a clear, specific error.
# --------------------------------------------------------------------------

# Magisk's su on this all-read-only LineageOS lives in Magisk's own tmpfs, NOT
# in $PATH (a bare `su` is "inaccessible or not found"), so probe the known spots.
# The dev /data template pre-grants shell (Forever), so a granted su returns uid 0
# with no prompt.
_SU_CANDIDATES = ("/debug_ramdisk/su", "/sbin/su", "su")
_SU_CACHE = {}


def _resolve_su(adb, serial):
    """Working Magisk su path in the guest, or None if root is unavailable. Cached
    per serial (the path is stable for a boot)."""
    if serial in _SU_CACHE:
        return _SU_CACHE[serial]
    for cand in _SU_CANDIDATES:
        # Must go through `sh -c` (matches _ensure_devkit_activated's own
        # invocation below): MagiskSU's getopt permutes argv, so a bare
        # trailing `-u` (as in `su 0 id -u`) is misread as an unrecognized su
        # OPTION (usage/exit 2) instead of being passed to `id`.
        r = _run([adb, "-s", serial, "shell", cand, "0", "sh", "-c", "id -u"],
                 timeout=15)
        if (r.get("stdout") or "").strip().splitlines()[-1:] == ["0"]:
            _SU_CACHE[serial] = cand
            return cand
    return None


def _su_available(adb, serial):
    """True if Magisk root (`su`) works. The arm dev base is a LineageOS 'user'
    build: `adb root` is disabled, so root comes ONLY from the Magisk-patched
    boot. Returns False on an un-rooted (un-patched/ungranted) dev boot."""
    return _resolve_su(adb, serial) is not None


def _su_sh(adb, serial, script, timeout=45):
    """Run a shell snippet as root via Magisk su. Returns the _run dict (or an
    error dict if root is unavailable)."""
    su = _resolve_su(adb, serial)
    if not su:
        return {"returncode": 1, "stdout": "", "stderr": "Magisk su unavailable"}
    return _run([adb, "-s", serial, "shell", su, "0", "sh", "-c", script],
                timeout=timeout)


def _ensure_devkit_activated(adb, serial):
    """Idempotently mount the vdc devkit disk (read-only) and stage the omni-*
    tools + manifest into the exec-capable work dir. Mirrors the engine's
    _devkit_activate so frida tools work even if the account was started out of
    band. Needs Magisk root. Returns True if the manifest is present afterwards."""
    if not _su_available(adb, serial):
        return False
    script = (
        f"mkdir -p {_DEVKIT_MOUNT} {_DEVKIT_WORK}; "
        f"{{ grep -q ' {_DEVKIT_MOUNT} ' /proc/mounts || "
        f"mount -o ro /dev/block/vdc {_DEVKIT_MOUNT}; }}; "
        f"cp {_DEVKIT_MOUNT}/omni-* {_DEVKIT_WORK}/ 2>/dev/null; "
        f"cp {_DEVKIT_MOUNT}/manifest.json {_DEVKIT_WORK}/ 2>/dev/null; "
        f"chmod 755 {_DEVKIT_WORK}/omni-* 2>/dev/null; "
        f"[ -f {_DEVKIT_WORK}/manifest.json ] && echo OK || echo NO"
    )
    r = _su_sh(adb, serial, script)
    return "OK" in (r.get("stdout") or "")


def _dev_manifest(adb, serial):
    """Return the dev devkit manifest dict, or None if this is not a dev base.
    The manifest lives on the vdc devkit disk (arm dev base); it is read from the
    activated work copy, falling back to the read-only mount. If the account is a
    dev account but not yet activated (root present), activate it first."""
    for path in (_DEVKIT_MANIFEST, f"{_DEVKIT_MOUNT}/manifest.json"):
        r = _run([adb, "-s", serial, "shell", "cat", path], timeout=15)
        txt = (r.get("stdout") or "").strip()
        if txt and "No such file" not in txt and r.get("returncode", 1) == 0:
            try:
                return json.loads(txt)
            except ValueError:
                pass
    # Not staged yet — try to activate (needs Magisk root), then re-read.
    if _ensure_devkit_activated(adb, serial):
        r = _run([adb, "-s", serial, "shell", "cat", _DEVKIT_MANIFEST], timeout=15)
        txt = (r.get("stdout") or "").strip()
        if txt and "No such file" not in txt:
            try:
                return json.loads(txt)
            except ValueError:
                return None
    return None


def _is_dev_account(adb, serial):
    """Root-free dev-base signal: the devkit disk is attached as /dev/block/vdc.
    True even before activation (used to give a precise 'dev but not rooted'
    message instead of a generic 'not a dev base')."""
    r = _run([adb, "-s", serial, "shell", "ls", "/dev/block/vdc"], timeout=10)
    return "/dev/block/vdc" in (r.get("stdout") or "") and \
        "No such" not in (r.get("stdout") or "")


def _adb_root(adb, serial):
    """Ensure root is available for the dev toolkit. The arm dev base roots via
    Magisk (`su`), NOT `adb root` (it is a 'user' build). This activates the
    devkit (mount vdc + stage tools) and returns a short status string. Kept
    under this name for the frida_tools import."""
    if not _su_available(adb, serial):
        return ("no Magisk root (su unavailable) — the dev boot is not patched; "
                "run `omni build-dev-base --patch-boot`")
    _ensure_devkit_activated(adb, serial)
    return "Magisk root OK; devkit activated"


def _not_dev_base_error(adb, serial, tool):
    """Precise error for a frida/hide call on a non-usable account: distinguish
    'not a dev account' from 'dev account but not rooted (boot not patched)'."""
    if _is_dev_account(adb, serial):
        return {"error": (
            f"This is a DEV account (the vdc devkit disk is attached) but it is "
            f"NOT ROOTED — Magisk `su` is unavailable, so {tool} cannot run. The "
            f"dev system boot is not Magisk-patched. Root it once with: "
            f"`omni build-dev-base --patch-boot` (then recreate the account).")}
    return {"error": (
        f"This account is not a DEV base (no devkit disk / manifest). Boot it with "
        f"ensure_emulator_running(dev=true) (or set OMNI_USE_DEV_BASE=1), and make "
        f"sure `omni build-dev-base` has produced base_arm_devkit.qcow2.")}


@registry.register(
    name="ensure_frida_server",
    description=(
        "Starts the frida-server from the DEV-BASE devkit disk and sets up a host->guest port forward so "
        "you can attach with the host frida tools. Only works on an account booted from the dev base "
        "(ensure_emulator_running dev=true, or OMNI_USE_DEV_BASE=1) whose boot is Magisk-rooted. It uses "
        "Magisk `su` (the arm base is a 'user' build — `adb root` is unavailable), launches the hidden "
        "launcher `omni-fridad` (android-arm64 frida-server on a CUSTOM loopback port with a randomized "
        "process name — not the well-known 27042/'frida-server', so a naive port/name scan misses it), "
        "then `adb forward`s a host port onto that guest port. Returns the host endpoint to pass to frida "
        "as `-H 127.0.0.1:<host_port>` (the guest port is loopback-only inside the VM, so the forward is "
        "required). Idempotent: re-running reuses the running server."
    ),
    params_schema={
        "device_name": "string (optional — the omnidroid dev account name; must match the one ensure_emulator_running(dev=true) created, default 'omniagent')",
        "backend": "string (optional, default 'qemu' — omnidroid only)"
    },
    output="The host frida endpoint ('127.0.0.1:<host_port>') plus the guest port and server status, or an error if the account isn't a dev base / isn't rooted (build the dev base + `--patch-boot` with `omni build-dev-base`).",
    when_to_use="Call after ensure_emulator_running(dev=true) + BOOT_OK, before attaching frida/objection to hook the app under test. Pair with hide_root_from_app to also hide root/frida from the target's detection."
)
def ensure_frida_server(device_name=None, backend=_DEFAULT_BACKEND):
    adb, serial_or_err = _resolve_serial(backend, device_name)
    if adb is None:
        return serial_or_err
    serial = serial_or_err
    manifest = _dev_manifest(adb, serial)
    if manifest is None:
        return _not_dev_base_error(adb, serial, "frida-server")
    guest_port = int(manifest.get("frida_port") or _DEFAULT_FRIDA_PORT)
    # Start the hidden frida-server via Magisk su (idempotent — omni-fridad
    # no-ops if already up). Runs from the devkit work dir.
    start = _su_sh(adb, serial, f"{_DEVKIT_WORK}/omni-fridad", timeout=40)
    start_out = (start.get("stdout") or start.get("stderr") or "").strip()
    # Forward a host port onto the guest's loopback frida port. tcp:0 asks adb to
    # allocate a free host port and print it.
    fwd = _run([adb, "-s", serial, "forward", "tcp:0", f"tcp:{guest_port}"], timeout=15)
    host_port = (fwd.get("stdout") or "").strip()
    if not host_port.isdigit():
        # Fall back to a fixed host port if the allocator form isn't supported.
        host_port = str(guest_port)
        _run([adb, "-s", serial, "forward", f"tcp:{host_port}", f"tcp:{guest_port}"], timeout=15)
    return {"stdout": (
        f"frida-server (arm64) up on dev account '{device_name or _default_device_name()}'.\n"
        f"  guest port : 127.0.0.1:{guest_port} (loopback in the VM, hidden name)\n"
        f"  host attach: frida -H 127.0.0.1:{host_port}   (adb-forwarded)\n"
        f"  frida ver  : {manifest.get('frida_version')}\n"
        f"  launcher   : {start_out}\n"
        f"Tip: also run hide_root_from_app('<target.package>') so the app can't see root/frida.")}


@registry.register(
    name="hide_root_from_app",
    description=(
        "Best-effort hiding of ROOT, MAGISK, and FRIDA from a target app's detection on a DEV-BASE "
        "account, via the devkit `omni-hide` helper. It adds the package to the Magisk DenyList (Magisk "
        "unmounts its modifications + hides su/daemon for that app; stronger with the Shamiko module) and "
        "resetprop-spoofs the classic root/verified-boot 'tells' (build tags -> release-keys, "
        "verifiedbootstate -> green/locked, ro.debuggable -> 0, etc.) using Magisk's resetprop applet. "
        "Requires the dev boot to be Magisk-rooted. Run this AFTER ensure_frida_server and BEFORE "
        "launching the target. One-time Zygisk/DenyList enablement is done by `omni-magisk-setup`."
    ),
    params_schema={
        "package_name": "string (optional — the target app package to hide root/Magisk from; enables the per-app Magisk DenyList step. Omit to only apply the global prop spoofs.)",
        "device_name": "string (optional — the omnidroid dev account name, default 'omniagent')",
        "backend": "string (optional, default 'qemu' — omnidroid only)"
    },
    output="What omni-hide actually applied (resetprop keys set, Magisk DenyList result, frida sanity), or an error if the account isn't a dev base / isn't rooted.",
    when_to_use="Use when the APK under test has root/frida detection: call ensure_emulator_running(dev=true) -> ensure_frida_server -> hide_root_from_app('<pkg>') -> install/launch, then hook with frida."
)
def hide_root_from_app(package_name=None, device_name=None, backend=_DEFAULT_BACKEND):
    adb, serial_or_err = _resolve_serial(backend, device_name)
    if adb is None:
        return serial_or_err
    serial = serial_or_err
    if _dev_manifest(adb, serial) is None:
        return _not_dev_base_error(adb, serial, "omni-hide")
    cmd = f"{_DEVKIT_WORK}/omni-hide"
    if package_name:
        cmd += f" {shlex.quote(str(package_name))}"
    r = _su_sh(adb, serial, cmd, timeout=60)
    out = (r.get("stdout") or r.get("stderr") or "").strip()
    return {"stdout": out or "omni-hide ran (no output)."}
