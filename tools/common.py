"""Shared helpers used across all tool modules.

Keeping these in one place avoids duplicating path-normalization and
pagination logic between filesystem.py, apk_tools.py, binary_analysis.py,
hex_patching.py and hash_tools.py.
"""
import base64
import os
import re
import shlex
import sys

def normalize_path(path):
    """Normalize a caller-supplied path to one relative to the project root.

    Commands run with the project folder as their working directory, so a
    relative path is what every tool wants. The model supplies paths in whatever
    shape it happens to use, so this accepts all of them and returns one:

      ``foo/bar.txt``            -> ``foo/bar.txt``
      ``./foo/bar.txt``          -> ``foo/bar.txt``
      ``/workspace/foo/bar.txt`` -> ``foo/bar.txt``   (legacy, see below)

    The ``/workspace`` prefix is a leftover from when tools ran in a container
    mounted there. It is stripped rather than rejected: the convention survives
    in old transcripts, cached tool results, and the model's own habits, and
    silently accepting it costs one comparison while rejecting it would turn a
    cosmetic mismatch into a failed tool call.
    """
    path = (path or "").strip()
    if path.startswith("/workspace"):
        path = path[len("/workspace"):]
    if path.startswith("/"):
        path = path[1:]
    while path.startswith("./"):
        path = path[2:]
    return path if path else "."


def wpath(path):
    """A caller-supplied path, ready to drop into a shell command.

    Normalized to project-relative (see normalize_path) and shell-quoted, so
    names containing spaces, quotes or ``$`` survive — real project trees are
    full of them ("Omni Apps", "My Project"), and an unquoted path silently
    turns one argument into several.

    Use this everywhere a path goes into a command string. It is idempotent with
    respect to normalize_path, so calling it on an already-normalized path (as
    most tools do) is fine.
    """
    return shlex.quote(normalize_path(path))


def clean_hex(hex_str):
    """Normalize a hex byte string ('1f 20', '\\x1f\\x20', '1F2003D5') to a
    lowercase, contiguous hex string and return (cleaned, byte_count).

    Accepts spaces and '\\x' escapes so callers can paste hex from a
    disassembler in whatever shape it came in. Raises ValueError on odd length
    or non-hex characters. Shared by the byte-level analysis/patching tools
    (find_byte_sequence_in_so, patch_at_offset_with_bytes) so they all validate
    hex the same way.
    """
    cleaned = (hex_str or "").replace("\\x", "").replace(" ", "").lower()
    if not cleaned:
        raise ValueError("empty hex string")
    if len(cleaned) % 2 != 0:
        raise ValueError("hex must have an even number of characters")
    try:
        bytes.fromhex(cleaned)
    except ValueError:
        raise ValueError("not a valid hex byte string")
    return cleaned, len(cleaned) // 2


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
    determined. Used by binary_editing.py and native_codegen.py so both the
    canned-patch tools and the assembler/compiler tools agree on arch names.
    """
    from host_exec import run_cmd
    res = run_cmd(f"readelf -h {wpath(so_path)} | grep Machine", timeout=10)
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


# Cross-toolchain commands for each supported architecture, used by
# native_codegen.py to assemble/compile a self-contained snippet into ELF
# machine code for an Android target.
#
# On macOS there is no `aarch64-linux-gnu-gcc` and the system `as`/`objdump`/
# `objcopy` are Mach-O-only, so a GNU-style cross toolchain would mean
# installing four separate cross-compilers. Clang is a cross-compiler by
# construction instead: `clang -target <triple> -c` emits ELF objects for any
# supported architecture out of the box, and llvm-objcopy/llvm-objdump read them
# regardless of the host. Since these tools NEVER link (see the module docstring
# in native_codegen.py — the snippet must be self-contained), no cross sysroot or
# cross libc is needed, which is exactly what makes this work with a plain clang.
#
# Elsewhere the classic GNU cross names are used, since that is what Linux
# distributions and MSYS2 package.
_CLANG_TARGETS = {
    "aarch64": "aarch64-linux-gnu",
    "arm": "arm-linux-gnueabi",
    "x86_64": "x86_64-linux-gnu",
    "x86": "i386-linux-gnu",
}

if sys.platform == "darwin":
    TOOLCHAINS = {
        arch: {
            # `clang -c` drives its integrated assembler for a .s input, so the
            # same command covers both the assemble and the compile path.
            "as": "clang -target %s -c" % triple,
            "gcc": "clang -target %s" % triple,
            "objcopy": "llvm-objcopy",
            "objdump": "llvm-objdump",
        }
        for arch, triple in _CLANG_TARGETS.items()
    }
else:
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


def encode_script(script):
    """base64-encode a script body for `... | base64 -d | python3 -`.

    Piping the source through base64 sidesteps shell escaping entirely: a script
    full of quotes, newlines, ``$`` and backticks arrives byte-for-byte. The
    scripts address files with paths RELATIVE to the project folder, which is
    the interpreter's working directory, so they need no path fixing.
    """
    return base64.b64encode(script.encode("utf-8")).decode("ascii")


def run_python_script(script_path, args, timeout):
    """Run a Python script file in the project folder, with args.

    Used for anything too involved for an inline shell one-liner (currently: the
    code graph indexer/query scripts). The script is base64-encoded so there are
    no shell-escaping issues, matching the same trick write_file uses for
    arbitrary content. Piping the source rather than invoking the file keeps it
    working no matter where the app itself is installed.
    """
    from host_exec import run_cmd
    with open(script_path, encoding="utf-8") as fh:
        script = fh.read()
    b64 = encode_script(script)
    arg_str = " ".join(shlex.quote(str(a)) for a in args)
    cmd = "echo '{b64}' | base64 -d | python3 - {args}".format(b64=b64, args=arg_str)
    return run_cmd(cmd, timeout=timeout)


def resolve_workspace_path(path):
    """Resolve a project-relative path to an absolute one.

    Used by tools that do real Python file I/O instead of shelling out — the
    Android emulator tools, the code-graph indexer, the web downloader. Both
    routes address the same files: a shell command gets the same folder as its
    working directory, so `foo/bar` means the same thing either way.
    """
    from host_exec import workspace_root
    rel = normalize_path(path)
    host_root = workspace_root()
    if host_root is None:
        # A remote device is active, so there is no local path for this file.
        raise RuntimeError(
            "no local workspace: a remote device is active, so this file has no "
            "path on this computer")
    if rel == ".":
        return host_root
    return os.path.normpath(os.path.join(host_root, rel))


def find_android_sdk_tools():
    """Locate the host Android SDK's adb/emulator/avdmanager — cross-platform
    (macOS / Linux / Windows).

    Resolution order: $ANDROID_SDK_ROOT or $ANDROID_HOME, then the OS default
    Android Studio SDK location — ~/Library/Android/sdk (macOS),
    ~/Android/Sdk (Linux), %LOCALAPPDATA%\\Android\\Sdk (Windows). Binary names
    are OS-appropriate (adb/emulator on POSIX, adb.exe/emulator.exe on Windows;
    avdmanager vs avdmanager.bat). Returns {"sdk_root","adb","emulator",
    "avdmanager"} — avdmanager may be None if no cmdline-tools package is present
    (only needed for first-time AVD creation; adb/emulator are required).

    Raises RuntimeError with a clear, actionable message if no SDK with both adb
    and emulator can be found.
    """
    is_nt = os.name == "nt"
    adb_name = "adb.exe" if is_nt else "adb"
    emu_name = "emulator.exe" if is_nt else "emulator"
    avd_names = ("avdmanager.bat",) if is_nt else ("avdmanager",)

    candidates = []
    for var in ("ANDROID_SDK_ROOT", "ANDROID_HOME"):
        v = os.environ.get(var)
        if v:
            candidates.append(v)
    home = os.path.expanduser("~")
    if is_nt:
        localappdata = os.environ.get("LOCALAPPDATA")
        if localappdata:
            candidates.append(os.path.join(localappdata, "Android", "Sdk"))
    elif sys.platform == "darwin":
        candidates.append(os.path.join(home, "Library", "Android", "sdk"))
    else:  # linux and other POSIX
        candidates.append(os.path.join(home, "Android", "Sdk"))

    for sdk_root in candidates:
        adb = os.path.join(sdk_root, "platform-tools", adb_name)
        emulator = os.path.join(sdk_root, "emulator", emu_name)
        if os.path.isfile(adb) and os.path.isfile(emulator):
            avdmanager = None
            for avd_name in avd_names:
                for sub in (
                    os.path.join("cmdline-tools", "latest", "bin", avd_name),
                    os.path.join("tools", "bin", avd_name),
                    os.path.join("cmdline-tools", "bin", avd_name),
                ):
                    cand = os.path.join(sdk_root, sub)
                    if os.path.isfile(cand):
                        avdmanager = cand
                        break
                if avdmanager:
                    break
            return {"sdk_root": sdk_root, "adb": adb, "emulator": emulator, "avdmanager": avdmanager}

    default_hint = (
        "%LOCALAPPDATA%\\Android\\Sdk" if is_nt
        else "~/Library/Android/sdk" if sys.platform == "darwin"
        else "~/Android/Sdk")
    raise RuntimeError(
        "Could not find an Android SDK with both %s and %s. Checked: " % (adb_name, emu_name)
        + (", ".join(candidates) if candidates else "(no ANDROID_SDK_ROOT/ANDROID_HOME set)")
        + ". Install Android Studio (its default SDK location is %s), " % default_hint
        + "or set the ANDROID_SDK_ROOT environment variable to your SDK's install location."
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
