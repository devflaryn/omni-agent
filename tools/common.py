"""Shared helpers used across all tool modules.

Keeping these in one place avoids duplicating path-normalization and
pagination logic between filesystem.py, apk_tools.py, binary_analysis.py,
hex_patching.py and hash_tools.py.
"""
import base64
import os
import shlex

def normalize_path(path):
    """Normalize a path so it can be safely appended to ``/workspace``.

    The LLM sometimes hands us absolute sandbox paths (``/workspace/foo``)
    and sometimes relative ones (``foo``). Both should resolve to ``foo``
    so that ``/workspace/{path}`` always points at the right file inside
    the Docker sandbox.
    """
    path = (path or "").strip()
    if path.startswith("/workspace"):
        path = path[len("/workspace"):]
    if path.startswith("/"):
        path = path[1:]
    return path if path else "."


def build_paginated_command(base_cmd, filter_pattern=None, max_lines=300, skip=0):
    """Append optional grep filtering + pagination to a base shell command.

    Used by the binary-listing tools (rabin2, nm, strings) so that they all
    page through results in exactly the same way. ``base_cmd`` should be the
    raw command that produces a line-oriented list of results.
    """
    cmd = base_cmd
    if filter_pattern:
        cmd += f" | grep -i {filter_pattern!r}"
    if skip and int(skip) > 0:
        cmd += f" | tail -n +{int(skip) + 1}"
    cmd += f" | head -n {int(max_lines)}"
    return cmd


def append_page_hint(result, skip, max_lines):
    """Attach a 'call again with skip=...' hint to a paginated tool result."""
    if result.get("stdout"):
        result["stdout"] += (
            f"\n[Page: skip={skip}, max_lines={max_lines}. "
            f"If more results exist, call again with skip={int(skip) + int(max_lines)}]"
        )
    return result


def detect_elf_arch(so_path):
    """Detect the ELF machine architecture of a .so using readelf -h.

    Returns one of 'aarch64', 'x86_64', 'x86', 'arm', or None if it can't be
    determined. ``so_path`` should already be normalize_path()-relative to
    /workspace. Used by binary_editing.py and native_codegen.py so both the
    canned-patch tools and the assembler/compiler tools agree on arch names.
    """
    from docker_sandbox import run_cmd
    res = run_cmd(f"readelf -h /workspace/{so_path} | grep Machine", timeout=10)
    machine = res.get("stdout", "").lower()
    if "aarch64" in machine:
        return "aarch64"
    if "x86-64" in machine or "x86_64" in machine:
        return "x86_64"
    if "intel 80386" in machine or "x86" in machine:
        return "x86"
    if "arm" in machine:
        return "arm"
    return None


# Cross-toolchain binaries for each supported architecture. aarch64/arm use
# dedicated cross-binutils/cross-gcc packages (installed in the Dockerfile);
# x86_64/x86 reuse the sandbox's native host toolchain since the container
# itself is x86_64 Linux.
TOOLCHAINS = {
    "aarch64": {
        "as": "aarch64-linux-gnu-as",
        "gcc": "aarch64-linux-gnu-gcc",
        "objcopy": "aarch64-linux-gnu-objcopy",
        "objdump": "aarch64-linux-gnu-objdump",
    },
    "arm": {
        "as": "arm-linux-gnueabi-as",
        "gcc": "arm-linux-gnueabi-gcc",
        "objcopy": "arm-linux-gnueabi-objcopy",
        "objdump": "arm-linux-gnueabi-objdump",
    },
    "x86_64": {
        "as": "as",
        "gcc": "gcc",
        "objcopy": "objcopy",
        "objdump": "objdump",
    },
    "x86": {
        "as": "as --32",
        "gcc": "gcc -m32",
        "objcopy": "objcopy",
        "objdump": "objdump",
    },
}


def run_script_in_sandbox(script_path, args, timeout):
    """Ship a host-side Python script into the sandbox and run it with args.

    Used for anything too involved for an inline shell one-liner (currently:
    the code graph indexer/query scripts) — the script is base64-encoded so
    there are no shell-escaping issues, matching the same trick write_file
    uses for arbitrary content.
    """
    from docker_sandbox import run_cmd
    with open(script_path, encoding="utf-8") as fh:
        script = fh.read()
    b64 = base64.b64encode(script.encode("utf-8")).decode("ascii")
    arg_str = " ".join(shlex.quote(str(a)) for a in args)
    cmd = "echo '{b64}' | base64 -d | python3 - {args}".format(b64=b64, args=arg_str)
    return run_cmd(cmd, timeout=timeout)


def resolve_workspace_path(path):
    """Resolve a '/workspace'-relative path (the convention every docker-exec
    tool uses) to the equivalent absolute path on the HOST filesystem, via the
    bind-mounted project workspace directory.

    Used by tools that need real Python file I/O on the host rather than
    going through docker exec — currently the Android emulator tools, since
    the emulator itself runs natively on Windows (Android Studio / the SDK's
    emulator.exe) rather than inside the Linux sandbox used for APK static
    analysis/patching. The file still ends up visible at the same
    /workspace/<path> location inside the sandbox too, since it's the same
    bind-mounted directory on both sides.
    """
    from docker_sandbox import get_workspace_host_path
    rel = normalize_path(path)
    host_root = get_workspace_host_path()
    if rel == ".":
        return host_root
    return os.path.normpath(os.path.join(host_root, rel))


def find_android_sdk_tools():
    """Locate the Windows-native Android SDK's adb/emulator/avdmanager.

    Resolution order: $ANDROID_SDK_ROOT or $ANDROID_HOME env var, then Android
    Studio's default Windows install location (%LOCALAPPDATA%\\Android\\Sdk).
    Returns a dict {"sdk_root", "adb", "emulator", "avdmanager"} — avdmanager
    may be None if no cmdline-tools package is installed (only needed for
    first-time AVD creation; adb/emulator are required).

    Raises RuntimeError with a clear, actionable message if no SDK with both
    adb.exe and emulator.exe can be found.
    """
    candidates = []
    for var in ("ANDROID_SDK_ROOT", "ANDROID_HOME"):
        v = os.environ.get(var)
        if v:
            candidates.append(v)
    localappdata = os.environ.get("LOCALAPPDATA")
    if localappdata:
        candidates.append(os.path.join(localappdata, "Android", "Sdk"))

    for sdk_root in candidates:
        adb = os.path.join(sdk_root, "platform-tools", "adb.exe")
        emulator = os.path.join(sdk_root, "emulator", "emulator.exe")
        if os.path.isfile(adb) and os.path.isfile(emulator):
            avdmanager = None
            for sub in (
                os.path.join("cmdline-tools", "latest", "bin", "avdmanager.bat"),
                os.path.join("tools", "bin", "avdmanager.bat"),
                os.path.join("cmdline-tools", "bin", "avdmanager.bat"),
            ):
                cand = os.path.join(sdk_root, sub)
                if os.path.isfile(cand):
                    avdmanager = cand
                    break
            return {"sdk_root": sdk_root, "adb": adb, "emulator": emulator, "avdmanager": avdmanager}

    raise RuntimeError(
        "Could not find an Android SDK with both adb.exe and emulator.exe. Checked: "
        + (", ".join(candidates) if candidates else "(no ANDROID_SDK_ROOT/ANDROID_HOME set, and %LOCALAPPDATA% unavailable)")
        + ". Install Android Studio (its default SDK location is %LOCALAPPDATA%\\Android\\Sdk), "
        "or set the ANDROID_SDK_ROOT environment variable to your SDK's install location."
    )


def find_ldplayer_tools():
    """Locate LDPlayer's ldconsole.exe (its command-line automation tool) and,
    as a fallback if the Android SDK isn't separately available, its bundled
    adb.exe.

    LDPlayer is the default emulator backend for the Android testing tools
    (see tools/android_emulator.py) because it ships its own ARM/ARM64
    translation layer — a real x86_64-only AVD system image often can't run
    arm64-v8a native libraries at all, which LDPlayer handles much better on
    an x86_64 Windows host.

    Resolution order: $LDPLAYER_PATH env var, then the most common default
    install locations, then the Windows registry's uninstall keys for any
    product whose display name contains "ldplayer" (covers custom install
    drives/paths).

    Returns {"install_dir", "ldconsole", "adb"} — "adb" may be None if
    LDPlayer's own adb.exe isn't present (find_android_sdk_tools() is
    preferred for adb when available; this is only the fallback).

    Raises RuntimeError with a clear, actionable message if ldconsole.exe
    can't be found anywhere.
    """
    candidates = []
    env_path = os.environ.get("LDPLAYER_PATH")
    if env_path:
        candidates.append(env_path)
    candidates += [
        r"C:\LDPlayer\LDPlayer9",
        r"C:\LDPlayer\LDPlayer4",
        r"C:\Program Files\LDPlayer\LDPlayer9",
        r"C:\Program Files (x86)\LDPlayer\LDPlayer9",
        r"D:\LDPlayer\LDPlayer9",
    ]
    try:
        import winreg
        uninstall_keys = (
            (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
            (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"),
        )
        for hive, subkey in uninstall_keys:
            try:
                with winreg.OpenKey(hive, subkey) as key:
                    count = winreg.QueryInfoKey(key)[0]
                    for i in range(count):
                        try:
                            sub_name = winreg.EnumKey(key, i)
                        except OSError:
                            continue
                        try:
                            with winreg.OpenKey(key, sub_name) as sub:
                                try:
                                    display_name = winreg.QueryValueEx(sub, "DisplayName")[0]
                                except OSError:
                                    continue
                                if "ldplayer" in display_name.lower():
                                    try:
                                        install_loc = winreg.QueryValueEx(sub, "InstallLocation")[0]
                                        if install_loc:
                                            candidates.append(install_loc)
                                    except OSError:
                                        pass
                        except OSError:
                            continue
            except OSError:
                continue
    except ImportError:
        pass  # not on Windows — find_ldplayer_tools() will just report not-found below

    for install_dir in candidates:
        ldconsole = os.path.join(install_dir, "ldconsole.exe")
        if os.path.isfile(ldconsole):
            adb = os.path.join(install_dir, "adb.exe")
            return {
                "install_dir": install_dir,
                "ldconsole": ldconsole,
                "adb": adb if os.path.isfile(adb) else None,
            }

    raise RuntimeError(
        "Could not find LDPlayer's ldconsole.exe. Checked: "
        + (", ".join(candidates) if candidates else "(no default locations)")
        + ". If LDPlayer is installed somewhere else, set the LDPLAYER_PATH environment "
        "variable to its install directory (the folder containing ldconsole.exe)."
    )
