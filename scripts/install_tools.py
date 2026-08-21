#!/usr/bin/env python3
"""install_tools.py — install everything omni-agent's tools shell out to.

The agent runs its commands directly on this machine, so the reverse-engineering
toolchain has to exist here. This installs it and wires up the small wrapper
layer that makes every platform behave the same from the tool layer's point of
view.

Written in Python rather than as a shell script for one reason: it has to run on
macOS, Linux and Windows, and the three package managers, path layouts and
archive conventions differ enough that three parallel shell scripts would drift
apart. Python is already a hard requirement of this project.

What it sets up
---------------
  * A JDK 21 (Ghidra refuses to start on anything newer), radare2, apktool,
    jadx, LLVM/binutils, and — on macOS — the GNU userland, because the tool
    commands are written in GNU style (`stat -c`, `sha256sum`, `sed -i`,
    `grep -P`, `find -printf`) which BSD userland rejects.
  * Android build-tools (apksigner, zipalign) and platform-tools (adb).
  * Ghidra, with its headless analyzer exposed on PATH.
  * APKEditor, for APKs with multiple resource packages apktool can't decode.
  * baksmali/smali wrappers built from shims/*.java.

Everything the agent needs on PATH ends up in ~/.omni-agent/bin, which
host_exec.py puts at the front of PATH for every command it runs. Your shell
profile and system PATH are never modified.

Safe to re-run: every step is idempotent and skips work already done.

Usage:
    python3 scripts/install_tools.py [--check] [--yes]

      --check   report what is installed or missing, change nothing
      --yes     don't prompt before installing system packages
"""

import argparse
import json
import os
import platform
import shutil
import stat
import subprocess
import sys
import tempfile
import urllib.request
import zipfile

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OMNI_HOME = os.path.join(os.path.expanduser("~"), ".omni-agent")
BIN_DIR = os.path.join(OMNI_HOME, "bin")
LIB_DIR = os.path.join(OMNI_HOME, "lib")

IS_MAC = sys.platform == "darwin"
IS_WIN = os.name == "nt"
IS_LINUX = not IS_MAC and not IS_WIN

# Ghidra is PINNED, deliberately — do NOT bump without porting the post-script.
# ghidra_decompile drives Ghidra through tools/_ghidra_decompile.py, a JYTHON
# (Python 2) script. Ghidra 12 removed bundled Jython in favour of PyGhidra
# (CPython), so on 12.x every run analyzes the binary fine and then dies with
# "Ghidra was not started with PyGhidra. Python is not available" — producing no
# decompiler output at all. 11.3.2 still ships Jython.
GHIDRA_VERSION = "11.3.2"
GHIDRA_DATE = "20250415"
GHIDRA_URL = (f"https://github.com/NationalSecurityAgency/ghidra/releases/download/"
              f"Ghidra_{GHIDRA_VERSION}_build/ghidra_{GHIDRA_VERSION}_PUBLIC_{GHIDRA_DATE}.zip")

APKEDITOR_VERSION = "1.4.9"
APKEDITOR_URL = (f"https://github.com/REAndroid/APKEditor/releases/download/"
                 f"V{APKEDITOR_VERSION}/APKEditor-{APKEDITOR_VERSION}.jar")

# The shims are compiled against a PINNED apktool 2.9.3 jar, kept separate from
# whichever apktool the package manager installs for decode/build. apktool 3.x
# ships a MINIMIZED shaded jar: it keeps Baksmali and DexBuilder but strips
# DexFileFactory, Opcodes, MultiDexContainer and brut.androlib.mod.SmaliMod —
# exactly the entry points shims/*.java call — so they no longer compile against
# it. One extra 23MB jar is cheaper than chasing apktool's shading each release.
APKTOOL_SHIM_URL = ("https://github.com/iBotPeaches/Apktool/releases/download/"
                    "v2.9.3/apktool_2.9.3.jar")

problems = []


def say(msg):
    print(f"\n\033[1m==> {msg}\033[0m" if not IS_WIN else f"\n==> {msg}")


def info(msg):
    print(f"    {msg}")


def ok(msg):
    print(f"    \033[32mok\033[0m {msg}" if not IS_WIN else f"    ok {msg}")


def warn(msg):
    print(f"    \033[33m!  {msg}\033[0m" if not IS_WIN else f"    !  {msg}")


def fail(msg):
    print(f"    \033[31mx  {msg}\033[0m" if not IS_WIN else f"    x  {msg}")
    problems.append(msg)


def run(cmd, **kw):
    """Run a command, returning the CompletedProcess; never raises."""
    try:
        return subprocess.run(cmd, capture_output=True, text=True, **kw)
    except (OSError, subprocess.SubprocessError) as e:
        return subprocess.CompletedProcess(cmd, 1, "", str(e))


def have(name):
    return shutil.which(name) is not None


def download(url, dest, label):
    """Stream a URL to `dest`. Returns True on success."""
    info(f"downloading {label} ...")
    try:
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with urllib.request.urlopen(url, timeout=120) as resp, open(dest, "wb") as fh:
            shutil.copyfileobj(resp, fh)
        return True
    except Exception as e:
        try:
            os.remove(dest)
        except OSError:
            pass
        fail(f"could not download {label}: {e}")
        return False


# ---------------------------------------------------------------------------
# Package managers
# ---------------------------------------------------------------------------

def detect_package_manager():
    """(name, install_argv_prefix) for this machine, or (None, None)."""
    if IS_MAC:
        return ("brew", ["brew", "install"]) if have("brew") else (None, None)
    if IS_WIN:
        if have("winget"):
            return "winget", ["winget", "install", "--accept-package-agreements",
                              "--accept-source-agreements", "-e", "--id"]
        if have("choco"):
            return "choco", ["choco", "install", "-y"]
        return None, None
    for mgr, argv in (("apt-get", ["sudo", "apt-get", "install", "-y"]),
                      ("dnf", ["sudo", "dnf", "install", "-y"]),
                      ("pacman", ["sudo", "pacman", "-S", "--noconfirm"]),
                      ("zypper", ["sudo", "zypper", "install", "-y"])):
        if have(mgr):
            return mgr, argv
    return None, None


# Package names differ per manager. A value of None means "this manager has no
# package for it" — the tool is then either bundled elsewhere or reported
# missing, rather than silently attempting an install that cannot work.
PACKAGES = {
    #                brew              apt-get                    dnf                 pacman        winget/choco
    "jdk":          ("openjdk@21",     "openjdk-21-jdk",          "java-21-openjdk-devel", "jdk21-openjdk", "EclipseAdoptium.Temurin.21.JDK"),
    "radare2":      ("radare2",        "radare2",                 "radare2",          "radare2",     None),
    "apktool":      ("apktool",        "apktool",                 None,               "android-apktool", None),
    "jadx":         ("jadx",           None,                      None,               "jadx",        None),
    "binutils":     ("binutils",       "binutils",                "binutils",         "binutils",    None),
    "llvm":         (None,             "llvm",                    "llvm",             "llvm",        None),
    "coreutils":    ("coreutils",      None,                      None,               None,          None),
    "gnu-sed":      ("gnu-sed",        None,                      None,               None,          None),
    "grep":         ("grep",           None,                      None,               None,          None),
    "findutils":    ("findutils",      None,                      None,               None,          None),
    "gawk":         ("gawk",           None,                      None,               None,          None),
    "git":          ("git",            "git",                     "git",              "git",         "Git.Git"),
}

_MGR_INDEX = {"brew": 0, "apt-get": 1, "dnf": 2, "pacman": 3, "zypper": 2,
              "winget": 4, "choco": 4}


def package_for(key, mgr):
    idx = _MGR_INDEX.get(mgr)
    if idx is None:
        return None
    entry = PACKAGES.get(key)
    return entry[idx] if entry else None


def install_packages(mgr, argv, check_only, assume_yes):
    """Install every package this platform needs and can name."""
    say(f"System packages ({mgr or 'no package manager found'})")
    if not mgr:
        fail("no supported package manager found "
             + ("(install Homebrew: https://brew.sh)" if IS_MAC else
                "(install winget or Chocolatey)" if IS_WIN else
                "(expected apt-get, dnf, pacman or zypper)"))
        return

    # The GNU userland is only a separate install on macOS; Linux ships it and
    # on Windows it arrives with Git/MSYS2.
    keys = ["jdk", "git", "binutils", "radare2", "apktool", "jadx"]
    if IS_MAC:
        keys += ["coreutils", "gnu-sed", "grep", "findutils", "gawk"]
    else:
        keys += ["llvm"]

    wanted = []
    for key in keys:
        pkg = package_for(key, mgr)
        if not pkg:
            continue
        wanted.append((key, pkg))

    if check_only:
        for key, pkg in wanted:
            (ok if have_tool_for(key) else warn)(f"{key} ({pkg})")
        return

    todo = [(k, p) for k, p in wanted if not have_tool_for(k)]
    if not todo:
        ok("all system packages already present")
        return

    if not assume_yes and sys.stdin.isatty():
        print(f"    about to install: {', '.join(p for _, p in todo)}")
        if input("    proceed? [Y/n] ").strip().lower() in ("n", "no"):
            warn("skipped system packages at your request")
            return

    for key, pkg in todo:
        info(f"installing {pkg} ...")
        r = run(argv + [pkg])
        if r.returncode == 0 or have_tool_for(key):
            ok(pkg)
        else:
            fail(f"install failed: {pkg} ({(r.stderr or r.stdout or '').strip()[:160]})")


# What binary proves a package is present (a package name is not a command).
TOOL_FOR_KEY = {
    "jdk": "java", "radare2": "r2", "apktool": "apktool", "jadx": "jadx",
    "binutils": "readelf", "llvm": "llvm-objdump", "coreutils": "gsha256sum",
    "gnu-sed": "gsed", "grep": "ggrep", "findutils": "gfind", "gawk": "gawk",
    "git": "git",
}


def have_tool_for(key):
    tool = TOOL_FOR_KEY.get(key)
    if not tool:
        return False
    if shutil.which(tool):
        return True
    # Homebrew's keg-only formulas aren't on PATH; look where they land.
    for prefix in ("/opt/homebrew", "/usr/local"):
        for sub in ("bin", "opt/coreutils/libexec/gnubin", "opt/gnu-sed/libexec/gnubin",
                    "opt/grep/libexec/gnubin", "opt/findutils/libexec/gnubin",
                    "opt/binutils/bin", "opt/llvm/bin", "opt/openjdk@21/bin"):
            if os.path.exists(os.path.join(prefix, sub, tool.lstrip("g") if sub.endswith("gnubin") else tool)):
                return True
    return False


# ---------------------------------------------------------------------------
# Wrappers in ~/.omni-agent/bin
# ---------------------------------------------------------------------------

def write_wrapper(name, body_posix, body_windows=None):
    """Create an executable wrapper. On Windows a .cmd is written alongside the
    shell script, because a POSIX script is only callable from the bash the
    tools run under, while some callers resolve the .cmd."""
    os.makedirs(BIN_DIR, exist_ok=True)
    path = os.path.join(BIN_DIR, name)
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("#!/bin/sh\n# Generated by scripts/install_tools.py — do not edit.\n")
        fh.write(body_posix + "\n")
    os.chmod(path, os.stat(path).st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
    if IS_WIN and body_windows:
        with open(path + ".cmd", "w", encoding="utf-8") as fh:
            fh.write("@echo off\r\n" + body_windows + "\r\n")
    return path


def q(path):
    """Quote a path for embedding in a POSIX wrapper."""
    return '"' + str(path).replace("\\", "/").replace('"', '\\"') + '"'


def first_existing(*candidates):
    for c in candidates:
        if c and os.path.isfile(c):
            return c
    return None


def brew_prefixes():
    return ["/opt/homebrew", "/usr/local"]


def find_binary(names, extra_dirs=()):
    """Locate a binary by any of `names`, searching PATH then extra_dirs."""
    for n in names:
        p = shutil.which(n)
        if p:
            return p
    for d in extra_dirs:
        for n in names:
            for cand in (os.path.join(d, n), os.path.join(d, n + ".exe")):
                if os.path.isfile(cand):
                    return cand
    return None


def setup_binutils_wrappers(check_only):
    """readelf / objcopy / nm, pointed at ELF-capable implementations.

    macOS ships no readelf or objcopy at all, and its nm/objdump are Mach-O
    oriented — so Android .so analysis needs GNU binutils or LLVM's equivalents
    regardless of what the system provides."""
    say("Binary-analysis wrappers")
    prefix_dirs = []
    for p in brew_prefixes():
        prefix_dirs += [os.path.join(p, "opt", "binutils", "bin"),
                        os.path.join(p, "opt", "llvm", "bin")]
    prefix_dirs.append("/Library/Developer/CommandLineTools/usr/bin")

    plan = {
        "readelf": (["readelf", "llvm-readelf"], "readelf_info + .so architecture detection"),
        "objcopy": (["objcopy", "llvm-objcopy"], "assemble_and_patch / compile_c_and_patch"),
        "nm": (["nm", "llvm-nm"], "code-graph .so symbol tables"),
        "llvm-objdump": (["llvm-objdump", "objdump"], "llvm_objdump_disasm"),
    }
    for name, (candidates, breaks) in plan.items():
        if check_only:
            (ok if os.path.exists(os.path.join(BIN_DIR, name)) else warn)(name)
            continue
        found = find_binary(candidates, prefix_dirs)
        if found:
            write_wrapper(name, f'exec {q(found)} "$@"',
                          f'"{found}" %*')
            ok(f"{name} -> {found}")
        else:
            fail(f"no provider for {name} ({breaks})")


def setup_ghidra(check_only):
    say("Ghidra")
    target = os.path.join(OMNI_HOME, "ghidra", f"ghidra_{GHIDRA_VERSION}_PUBLIC")
    headless = os.path.join(target, "support",
                            "analyzeHeadless.bat" if IS_WIN else "analyzeHeadless")
    if os.path.isfile(headless):
        ok(f"analyzeHeadless: {headless}")
    elif check_only:
        warn("ghidra (not installed)")
        return None
    else:
        zip_path = os.path.join(OMNI_HOME, "ghidra", "download.zip")
        if not download(GHIDRA_URL, zip_path, f"Ghidra {GHIDRA_VERSION} (~400MB)"):
            return None
        info("extracting ...")
        try:
            with zipfile.ZipFile(zip_path) as zf:
                zf.extractall(os.path.join(OMNI_HOME, "ghidra"))
        except Exception as e:
            fail(f"could not extract Ghidra: {e}")
            return None
        finally:
            try:
                os.remove(zip_path)
            except OSError:
                pass
        # zipfile drops the executable bit that the launcher scripts need.
        for root, _dirs, files in os.walk(os.path.join(target, "support")):
            for f in files:
                p = os.path.join(root, f)
                os.chmod(p, os.stat(p).st_mode | stat.S_IEXEC)
        if not os.path.isfile(headless):
            fail("Ghidra extracted but analyzeHeadless is missing")
            return None
        ok(f"analyzeHeadless: {headless}")

    if not check_only:
        java_home = find_java_home()
        # Ghidra picks its JVM from JAVA_HOME first and refuses to start on a JDK
        # newer than it supports, so pin 21 rather than inheriting the default.
        pin = f'JAVA_HOME={q(java_home)}\nexport JAVA_HOME\n' if java_home else ""
        write_wrapper("analyzeHeadless", pin + f'exec {q(headless)} "$@"',
                      f'"{headless}" %*')
        ok("analyzeHeadless wrapper")
    return headless


def find_java_home():
    for cand in (
        "/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home",
        "/usr/local/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home",
        "/usr/lib/jvm/java-21-openjdk-amd64",
        "/usr/lib/jvm/java-21-openjdk",
        r"C:\Program Files\Eclipse Adoptium\jdk-21",
    ):
        if os.path.isdir(cand):
            return cand
    if IS_MAC:
        r = run(["/usr/libexec/java_home", "-v", "21"])
        if r.returncode == 0 and r.stdout.strip():
            return r.stdout.strip()
    return None


def setup_android_tools(check_only):
    """apksigner / zipalign / aapt2 from the Android SDK build-tools."""
    say("Android SDK tools")
    roots = []
    for env in ("ANDROID_SDK_ROOT", "ANDROID_HOME"):
        if os.environ.get(env):
            roots.append(os.environ[env])
    home = os.path.expanduser("~")
    if IS_MAC:
        roots.append(os.path.join(home, "Library", "Android", "sdk"))
        roots += [os.path.join(p, "share", "android-commandlinetools") for p in brew_prefixes()]
    elif IS_WIN:
        local = os.environ.get("LOCALAPPDATA")
        if local:
            roots.append(os.path.join(local, "Android", "Sdk"))
    else:
        roots.append(os.path.join(home, "Android", "Sdk"))

    build_tools = None
    for root in roots:
        bt = os.path.join(root, "build-tools")
        if not os.path.isdir(bt):
            continue
        for ver in sorted(os.listdir(bt), reverse=True):
            cand = os.path.join(bt, ver)
            exe = "apksigner.bat" if IS_WIN else "apksigner"
            if os.path.isfile(os.path.join(cand, exe)):
                build_tools = cand
                break
        if build_tools:
            break

    if not build_tools:
        msg = ("Android build-tools not found — sign_apk and verify_apk will be "
               "unavailable. Install Android Studio, or the command-line tools, then "
               "`sdkmanager \"build-tools;35.0.0\" platform-tools`.")
        warn(msg) if check_only else fail(msg)
        return
    ok(f"build-tools: {build_tools}")
    if check_only:
        return
    for tool in ("apksigner", "zipalign", "aapt2"):
        exe = first_existing(os.path.join(build_tools, tool),
                             os.path.join(build_tools, tool + ".bat"),
                             os.path.join(build_tools, tool + ".exe"))
        if exe:
            write_wrapper(tool, f'exec {q(exe)} "$@"', f'"{exe}" %*')
            ok(tool)


def setup_apkeditor(check_only):
    say("APKEditor")
    jar = os.path.join(LIB_DIR, "APKEditor.jar")
    if os.path.isfile(jar) and os.path.getsize(jar) > 0:
        ok("APKEditor.jar (already present)")
    elif check_only:
        warn("APKEditor.jar (not present)")
        return
    elif not download(APKEDITOR_URL, jar, f"APKEditor {APKEDITOR_VERSION}"):
        return
    if not check_only:
        write_wrapper("apkeditor", f'exec java -jar {q(jar)} "$@"',
                      f'java -jar "{jar}" %*')
        ok("apkeditor wrapper")


def setup_smali(check_only):
    say("baksmali / smali")
    jar = os.path.join(LIB_DIR, "apktool-shimlib.jar")
    classes = os.path.join(LIB_DIR, "omni-shims")
    if check_only:
        (ok if os.path.isfile(os.path.join(classes, "BaksmaliShim.class"))
         else warn)("shims compiled")
        return
    if not (os.path.isfile(jar) and os.path.getsize(jar) > 0):
        if not download(APKTOOL_SHIM_URL, jar, "apktool 2.9.3 shim library (23MB)"):
            return
    javac = find_binary(["javac"], [os.path.join(p, "opt", "openjdk@21", "bin")
                                    for p in brew_prefixes()])
    if not javac:
        fail("javac not found (baksmali/smali wrappers cannot be built)")
        return
    os.makedirs(classes, exist_ok=True)
    r = run([javac, "-nowarn", "-cp", jar, "-d", classes,
             os.path.join(REPO_ROOT, "shims", "BaksmaliShim.java"),
             os.path.join(REPO_ROOT, "shims", "SmaliShim.java")])
    if r.returncode != 0:
        fail(f"could not compile shims: {(r.stderr or r.stdout).strip()[:200]}")
        return
    ok("compiled BaksmaliShim + SmaliShim")

    sep = ";" if IS_WIN else ":"
    for name, shim in (("baksmali", "BaksmaliShim"), ("smali", "SmaliShim")):
        # Translate the real baksmali/smali CLI surface onto the shims'
        # positional arguments, so callers use the standard syntax.
        first = "d|x|disassemble" if name == "baksmali" else "a|assemble"
        write_wrapper(name, f"""set -e
case "$1" in {first}) shift ;; esac
input=""; out=""; api=26
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -a|--api-level) api="$2"; shift 2 ;;
    *) input="$1"; shift ;;
  esac
done
exec java -cp {q(jar + sep + classes)} {shim} "$input" "$out" "$api\"""")
    ok("baksmali + smali wrappers")


# ---------------------------------------------------------------------------
# Verification
# ---------------------------------------------------------------------------

VERIFY = ["java", "javac", "apktool", "jadx", "r2", "rabin2", "readelf", "objdump",
          "objcopy", "nm", "strings", "llvm-objdump", "baksmali", "smali", "apkeditor",
          "apksigner", "zipalign", "analyzeHeadless", "python3", "git", "make",
          "xxd", "unzip", "zip", "sha256sum", "sed", "grep", "find", "awk"]


def verify():
    """Resolve every tool the way host_exec does, so this reports what the agent
    will actually see rather than what the current shell happens to have."""
    say("Verification")
    sys.path.insert(0, REPO_ROOT)
    try:
        import host_exec
        path = host_exec.build_env()["PATH"]
    except Exception as e:
        warn(f"could not load host_exec ({e}); falling back to the current PATH")
        path = os.environ.get("PATH", "")

    missing = []
    for tool in VERIFY:
        found = shutil.which(tool, path=path)
        if found:
            ok(f"{tool:<16} {found}")
        else:
            missing.append(tool)
            fail(f"{tool} not found")

    if shutil.which("java", path=path):
        r = run(["java", "-version"], env={**os.environ, "PATH": path})
        info("java: " + (r.stderr or r.stdout or "").splitlines()[0] if (r.stderr or r.stdout) else "java: ?")

    # A package manager can pull in its own python3 that shadows the one running
    # this project, and it will not have the project's dependencies. The agent's
    # own shipped scripts are stdlib-only so it keeps working, but the user needs
    # to know before `python3 agent.py` fails with a confusing ImportError.
    py = shutil.which("python3", path=path) or shutil.which("python", path=path)
    if py and os.path.realpath(py) != os.path.realpath(sys.executable):
        r = run([py, "-c", "import requests"])
        if r.returncode != 0:
            warn(f"the python3 first on PATH ({py}) lacks this project's dependencies.")
            warn(f"Install them for it, or launch the app with {sys.executable}")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--check", action="store_true",
                    help="report what is installed or missing, change nothing")
    ap.add_argument("--yes", action="store_true",
                    help="don't prompt before installing system packages")
    args = ap.parse_args()

    print(f"omni-agent toolchain installer — {platform.platform()}")
    print(f"tools directory: {BIN_DIR}")
    if not args.check:
        os.makedirs(BIN_DIR, exist_ok=True)
        os.makedirs(LIB_DIR, exist_ok=True)

    if IS_WIN:
        sys.path.insert(0, REPO_ROOT)
        try:
            import host_exec
            if not host_exec._find_posix_shell():
                fail("no POSIX shell found. Install Git for Windows "
                     "(https://git-scm.com/download/win) — its bundled bash is "
                     "what the tool commands run in.")
        except Exception:
            pass

    mgr, argv = detect_package_manager()
    install_packages(mgr, argv, args.check, args.yes)
    setup_binutils_wrappers(args.check)
    setup_ghidra(args.check)
    setup_android_tools(args.check)
    setup_apkeditor(args.check)
    setup_smali(args.check)
    verify()

    if not problems:
        say("All tools are installed.")
        return 0
    say(f"Finished with {len(problems)} problem(s):")
    for p in problems:
        print(f"    - {p}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
