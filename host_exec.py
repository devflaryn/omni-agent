"""Command execution — the single place every tool goes to run a shell command.

Commands run DIRECTLY on the machine the app is running on, in the user's real
project folder, with real paths. There is no container, no virtual filesystem
root, and no path rewriting: the working directory is the project folder, so a
tool command names files exactly the way a person would in a terminal opened
there.

This replaced two earlier designs — a Docker container, then a "host sandbox"
that faked a `/workspace` root — and the simplification is the point. Paths in,
paths out, nothing in between to get out of sync.

Portability
-----------
Tool commands are written in POSIX shell (pipes, `&&`, `2>/dev/null`, single
quotes) and use GNU-style options, so a POSIX shell is required on every
platform:

  * macOS / Linux / BSD — `/bin/sh`.
  * Windows — `bash.exe` from Git for Windows, MSYS2, or WSL. cmd.exe and
    PowerShell are NOT substitutes: they would fail on nearly every command the
    tool layer emits, and failing loudly with an install hint beats emitting
    thousands of confusing syntax errors.

Everything else that varies by platform (where the toolchain lives, how a
process tree is killed) is handled here rather than in the tool modules.
"""

import os
import shutil
import subprocess
import sys
import threading
import time
import uuid

import devices

IS_WINDOWS = os.name == "nt"

# --- Timeout decision hook ----------------------------------------------------
# By default a command that outruns its timeout used to be hard-killed on the
# spot. Instead, callers (the agent) can register a "decider": when a command
# exceeds its timeout window we DON'T kill it — we ask the decider whether the
# process looks genuinely stuck (kill it) or is just a long job still making
# progress (keep waiting). The decider is called with:
#     decider(display_command, elapsed_seconds, base_timeout, round_number)
# and must return one of:
#     ("kill", None)        -> stop the process now
#     ("extend", seconds)   -> let it keep running for `seconds` more, then re-ask
# With no decider registered, run_cmd falls back to the old behavior (kill +
# timeout error), so tests and any non-agent caller are unaffected.
_timeout_decider = None

# Absolute backstop so a misbehaving decider can't extend a single command
# forever — after this many decision rounds we kill regardless.
_MAX_DECISION_ROUNDS = 1000


def set_timeout_decider(fn):
    """Register the callback consulted when a command exceeds its timeout (see
    the module note above). Pass None to restore hard-kill."""
    global _timeout_decider
    _timeout_decider = fn


# A stop predicate the app registers (agent.py passes `lambda: self._stop`) so a
# running tool subprocess can be aborted the INSTANT the user hits Stop, rather
# than blocking for the whole timeout window. Polled inside _run_polling.
_STOP_CHECK = None
# How often _run_polling checks the stop predicate while waiting on a process.
_STOP_POLL_SECONDS = 0.2


def set_stop_check(fn):
    """Register callable() -> bool that returns True when the user asked to stop.
    Lets _run_polling kill an in-flight command immediately. None clears it."""
    global _STOP_CHECK
    _STOP_CHECK = fn


def _stop_requested():
    fn = _STOP_CHECK
    if fn:
        try:
            return bool(fn())
        except Exception:
            return False
    return False


def _kill_proc(proc):
    """Kill the command AND anything it spawned.

    A tool command is usually a pipeline (`sh -c "a | b | c"`), so killing only
    the shell leaves the real workers running and holding the output pipes — the
    drain thread would then never finish. Commands are started in their own
    process group (POSIX) or console group (Windows) so the whole tree can be
    signalled at once."""
    if IS_WINDOWS:
        try:
            subprocess.run(["taskkill", "/T", "/F", "/PID", str(proc.pid)],
                           capture_output=True, timeout=15)
            return
        except (OSError, subprocess.SubprocessError):
            pass
    else:
        try:
            os.killpg(os.getpgid(proc.pid), 9)
            return
        except (OSError, AttributeError, ProcessLookupError):
            pass
    try:
        proc.kill()
    except Exception:
        pass


# Absolute path of the active project folder. Commands run with this as their
# working directory, and tools that do real Python file I/O resolve against it.
_workspace_root = None


def workspace_root():
    """Absolute path of the active project folder, or None when a remote device
    is active.

    None is deliberate: there is no host-side folder then, and this function's
    callers (tools/common.resolve_workspace_path, code_graph, web_tools) do
    in-process LOCAL file I/O on the returned path. None turns "silently operates
    on a path that does not exist here" into a refusal."""
    if devices.is_remote():
        return None
    if _workspace_root is None:
        raise RuntimeError("No active project folder — set_workspace() hasn't been called yet.")
    return _workspace_root


# ---------------------------------------------------------------------------
# Shell discovery
# ---------------------------------------------------------------------------

_shell_path = None


def _find_posix_shell():
    """Absolute path of a POSIX shell to run tool commands with, or None.

    On Windows this looks for the bash that ships with Git for Windows / MSYS2 /
    WSL. `git.exe` is the reliable anchor: its install carries `bin\\bash.exe`
    two directories up, and Git is present on virtually every Windows dev box."""
    global _shell_path
    if _shell_path:
        return _shell_path

    if not IS_WINDOWS:
        for cand in ("/bin/sh", "/usr/bin/sh", "/bin/bash"):
            if os.path.exists(cand):
                _shell_path = cand
                return _shell_path
        _shell_path = shutil.which("sh") or shutil.which("bash")
        return _shell_path

    found = shutil.which("bash")
    if found and "System32" not in found:  # skip the WSL launcher stub
        _shell_path = found
        return _shell_path
    git = shutil.which("git")
    if git:
        root = os.path.dirname(os.path.dirname(git))
        for rel in (os.path.join("bin", "bash.exe"), os.path.join("usr", "bin", "bash.exe")):
            cand = os.path.join(root, rel)
            if os.path.isfile(cand):
                _shell_path = cand
                return _shell_path
    for cand in (r"C:\Program Files\Git\bin\bash.exe",
                 r"C:\Program Files (x86)\Git\bin\bash.exe",
                 r"C:\msys64\usr\bin\bash.exe"):
        if os.path.isfile(cand):
            _shell_path = cand
            return _shell_path
    if found:  # the WSL stub, better than nothing
        _shell_path = found
    return _shell_path


NO_SHELL_MSG = (
    "No POSIX shell was found, so no command could run. The tools issue POSIX "
    "shell commands (pipes, &&, 2>/dev/null), which cmd.exe and PowerShell "
    "cannot interpret.\n"
    "Install Git for Windows (https://git-scm.com/download/win) — its bundled "
    "bash is detected automatically — or enable WSL."
)


# ---------------------------------------------------------------------------
# Environment
# ---------------------------------------------------------------------------

# Per-user directory the toolchain installer writes wrappers into. Kept first on
# PATH so the agent finds the tools it installed regardless of how the app was
# launched.
TOOLS_BIN = os.path.join(os.path.expanduser("~"), ".omni-agent", "bin")


def _tool_path_dirs():
    """Directories put at the FRONT of PATH for every command.

    Two jobs, and both are about making commands behave the same everywhere:

     1. Make the toolchain findable at all. A GUI-launched app (pywebview from
        Finder, Dock, or a Windows shortcut) inherits a minimal PATH, so the
        installed tools would be invisible without this.

     2. Give the commands a GNU userland. The tool layer uses GNU spellings
        throughout (`sha256sum`, `stat -c`, `sed -i` with no backup argument,
        `grep -P`, `find -printf`), which BSD/macOS userland rejects. On macOS
        the Homebrew gnubin directories supply them; on Linux they are already
        the default; on Windows they come from Git's usr/bin and MSYS2.

    Only these commands see this PATH — the user's own shell is never touched.
    """
    dirs = [TOOLS_BIN]

    if sys.platform == "darwin":
        for prefix in ("/opt/homebrew", "/usr/local"):  # Apple Silicon, Intel
            dirs += [
                f"{prefix}/opt/coreutils/libexec/gnubin",
                f"{prefix}/opt/gnu-sed/libexec/gnubin",
                f"{prefix}/opt/grep/libexec/gnubin",
                f"{prefix}/opt/findutils/libexec/gnubin",
                f"{prefix}/opt/gawk/libexec/gnubin",
                f"{prefix}/opt/make/libexec/gnubin",
                f"{prefix}/opt/llvm/bin",
                f"{prefix}/opt/binutils/bin",
                f"{prefix}/opt/openjdk@21/bin",
                f"{prefix}/bin",
                f"{prefix}/sbin",
            ]
        # Xcode's Command Line Tools carry llvm-objdump / llvm-nm but are not on
        # the default PATH. After Homebrew so a newer LLVM wins when present.
        dirs.append("/Library/Developer/CommandLineTools/usr/bin")
    elif IS_WINDOWS:
        git = shutil.which("git")
        if git:
            root = os.path.dirname(os.path.dirname(git))
            dirs += [os.path.join(root, "usr", "bin"), os.path.join(root, "mingw64", "bin")]
        dirs += [r"C:\msys64\usr\bin", r"C:\msys64\mingw64\bin"]
    else:  # Linux / BSD — GNU userland is already default; cover user installs
        home = os.path.expanduser("~")
        dirs += [os.path.join(home, ".local", "bin"), "/usr/local/bin", "/usr/local/sbin",
                 "/snap/bin"]
    return tuple(dirs)


_EXTRA_PATH_DIRS = _tool_path_dirs()


def _detect_java_home():
    """Best-effort JAVA_HOME so the JVM tools (apktool, jadx, apksigner, Ghidra's
    analyzeHeadless) launch under a supported JDK. Ghidra 11.x needs JDK 21,
    which is what the installer provides — and a newer system JDK would make it
    refuse to start, so an explicit 21 takes priority over whatever is default."""
    candidates = [
        "/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home",
        "/usr/local/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home",
        "/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home",
        "/usr/lib/jvm/java-21-openjdk-amd64",
        "/usr/lib/jvm/java-21-openjdk",
        "/usr/lib/jvm/temurin-21-jdk-amd64",
        r"C:\Program Files\Eclipse Adoptium\jdk-21",
        r"C:\Program Files\Java\jdk-21",
    ]
    for cand in candidates:
        if os.path.isdir(cand):
            return cand
    if sys.platform == "darwin":
        try:
            r = subprocess.run(["/usr/libexec/java_home", "-v", "21"],
                               capture_output=True, text=True, timeout=10)
            if r.returncode == 0 and r.stdout.strip():
                return r.stdout.strip()
        except (OSError, subprocess.SubprocessError):
            pass
    return None


def build_env():
    """Environment for commands: the app's own, plus the tool directories a
    GUI-launched process wouldn't otherwise see."""
    env = dict(os.environ)
    existing = env.get("PATH", "").split(os.pathsep)
    prefix = [d for d in _EXTRA_PATH_DIRS if d not in existing and os.path.isdir(d)]
    env["PATH"] = os.pathsep.join(prefix + [p for p in existing if p])
    if not env.get("JAVA_HOME"):
        java_home = _detect_java_home()
        if java_home:
            env["JAVA_HOME"] = java_home
    return env


# Tools the agent's command surface expects to find, mapped to what breaks
# without them. Reported (not enforced) by set_workspace so a missing install
# shows up as one clear line when the project opens, instead of as a confusing
# "command not found" in the middle of a task.
REQUIRED_TOOLS = {
    "java": "apktool / jadx / apksigner / Ghidra",
    "apktool": "decode_apk, recompile_apk",
    "jadx": "jadx_decompile",
    "r2": "rabin2 / radare2 binary analysis",
    "apksigner": "sign_apk",
    "zipalign": "sign_apk",
    "python3": "code graph indexer, scripted tools",
    "git": "repository tools",
}


def missing_tools():
    """Names from REQUIRED_TOOLS that aren't on PATH right now."""
    env_path = build_env()["PATH"]
    return [name for name in REQUIRED_TOOLS
            if shutil.which(name, path=env_path) is None]


def set_workspace(project_dir):
    """Make `project_dir` the active project folder: commands run there, and
    relative paths resolve against it.

    Selecting a different folder is just another call to this. Missing tools are
    REPORTED, not fatal — file, text and build work do not need Ghidra to be
    installed. Raises RuntimeError only when the folder itself is unusable."""
    global _workspace_root
    try:
        os.makedirs(project_dir, exist_ok=True)
    except OSError as e:
        raise RuntimeError(f"Could not open the selected project folder:\n  {project_dir}\n{e}")
    _workspace_root = os.path.abspath(project_dir)
    if not os.access(_workspace_root, os.R_OK | os.X_OK):
        raise RuntimeError(f"The selected project folder is not readable:\n  {_workspace_root}")

    print(f"[Workspace] {_workspace_root}")
    if not _find_posix_shell():
        print("[Workspace] No POSIX shell found — install Git for Windows or enable WSL.")
    missing = missing_tools()
    if missing:
        print("[Workspace] Missing tools (run scripts/install_tools.py): "
              + ", ".join(f"{n} ({REQUIRED_TOOLS[n]})" for n in missing))
    return _workspace_root


DEFAULT_TIMEOUT = 60  # seconds; callers can override for long-running tools

_NO_WORKSPACE_MSG = (
    "No project folder is active, so no command could run. Open or re-select a "
    "project folder in the app, then retry."
)

_WORKSPACE_GONE_MSG = (
    "The active project folder no longer exists:\n  {path}\n"
    "It was moved, renamed, or deleted. Re-select the project folder in the app, "
    "then retry — no command ran, so tools like decode_apk produced no output."
).format


# ssh's own failure modes, used to tell a transport error from a command that
# legitimately exited 255. The residual ambiguity — a command that exits 255 AND
# prints one of these — is accepted knowingly; there is no in-band way to
# separate them without polluting stdout.
_SSH_ERROR_SIGNATURES = (
    "ssh: connect to host",
    "Permission denied",
    "Connection closed by",
    "Connection timed out",
    "kex_exchange_identification",
    "Host key verification failed",
    "Could not resolve hostname",
)


def _spawn_reap(device, tag):
    """Kill the remote command in the background. Never blocks the Stop path —
    the user's Stop must feel instant even if the reap connection hangs."""
    def work():
        try:
            subprocess.run(devices.reap_argv(device, tag), timeout=20,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except Exception:
            pass
    threading.Thread(target=work, daemon=True).start()


def _run_remote(command, timeout, device):
    ssh = devices.find_ssh()
    if not ssh:
        # NEVER fall back to local: that would run the command on the wrong
        # machine, which is the one catastrophic failure this feature can cause.
        return {"stdout": "", "stderr": "no ssh client", "returncode": 127,
                "error": devices.NO_SSH_MSG}

    tag = uuid.uuid4().hex[:12]
    argv = devices.run_argv(device, command, tag, ssh_path=ssh)
    timeout_msg = ("Command timed out after {elapsed}s on device '" + device.name +
                   "'. Try a lighter command or break the task into smaller steps.")
    res = _run_polling(argv, timeout, display=command,
                       timeout_msg=timeout_msg, cwd=None)

    if res.get("stopped") or res.get("error"):
        _spawn_reap(device, tag)

    if res.get("returncode") == 255:
        err = res.get("stderr") or ""
        if any(sig in err for sig in _SSH_ERROR_SIGNATURES):
            res["error"] = (
                f"Could not reach device '{device.name}' ({device.target}):\n"
                f"  {err.strip().splitlines()[0] if err.strip() else 'connection failed'}\n"
                "No command ran. Check the host is up and your ssh key works "
                f"(`ssh {device.target} true`), then retry."
            )
    return res


def run_on(device, command, timeout=DEFAULT_TIMEOUT):
    """Run a command on an EXPLICIT device, regardless of which one is active.

    Exists so probing an unselected device cannot race the agent loop: the
    alternative — mutating the global active device around the call — would let a
    concurrent tool call land on the wrong machine."""
    return _run_remote(command, timeout, device)


def run_cmd(command, timeout=DEFAULT_TIMEOUT):
    """
    Execute a shell command in the active project folder. Returns a dict with
    stdout, stderr, and the return code.

    The working directory IS the project folder, so relative paths in the
    command mean what they say — the same as typing it in a terminal opened
    there.

    Health: if no folder is active, or it has been deleted out from under us, we
    return a CLEAR error dict rather than an empty result the caller would treat
    as "the tool produced nothing". A normal non-zero exit from the command
    itself is passed through untouched.

    On timeout the command is NOT killed outright: if a timeout decider is
    registered (see set_timeout_decider) it is asked whether to kill the
    still-running process or give it more time. Only when it decides to kill (or
    no decider is registered) does the process get terminated.
    """
    device = devices.active()
    if device is not None:
        return _run_remote(command, timeout, device)
    if _workspace_root is None:
        return {"stdout": "", "stderr": "no active project folder", "returncode": 1,
                "error": _NO_WORKSPACE_MSG}
    if not os.path.isdir(_workspace_root):
        return {"stdout": "", "stderr": "project folder missing", "returncode": 1,
                "error": _WORKSPACE_GONE_MSG(path=_workspace_root)}

    shell = _find_posix_shell()
    if not shell:
        return {"stdout": "", "stderr": "no POSIX shell", "returncode": 127,
                "error": NO_SHELL_MSG}

    timeout_msg = ("Command timed out after {elapsed}s. "
                   "Try a lighter command or break the task into smaller steps.")
    return _run_polling([shell, "-c", command], timeout, display=command,
                        timeout_msg=timeout_msg, cwd=_workspace_root)


def _run_polling(cmd, timeout, display, timeout_msg, cwd=None):
    """Run `cmd` (a list, no shell) draining its output, waiting in `timeout`-
    second windows. When a window elapses without the process finishing, consult
    the registered timeout decider instead of killing immediately. Returns the
    same shape as run_cmd. `display` is the human-readable command shown to the
    decider; `timeout_msg` is the error text used when we do kill (a "{elapsed}"
    placeholder is filled with the total seconds run)."""
    # Own process/console group so a timeout or Stop kills the whole pipeline,
    # not just the shell that launched it (see _kill_proc).
    group_kwargs = ({"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP}
                    if IS_WINDOWS else {"start_new_session": True})
    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                cwd=cwd, env=build_env(), **group_kwargs)
    except FileNotFoundError:
        # The interpreter/binary isn't available. Return an error dict (with a
        # non-zero returncode) instead of raising, so callers that fall back to
        # an in-process path (e.g. build_code_graph) can do so cleanly.
        return {"stdout": "", "stderr": f"executable not found: {cmd[0]}", "returncode": 127}
    except OSError as e:
        return {"stdout": "", "stderr": f"command failed to start: {e}", "returncode": 1}

    # Drain both pipes on a background thread so a chatty command can't deadlock
    # by filling the OS pipe buffer while we wait. communicate() also returns the
    # partial output captured so far once the process is killed.
    captured = {}

    def _drain():
        out, err = proc.communicate()
        captured["stdout"] = (out or b"").decode("utf-8", "replace")
        captured["stderr"] = (err or b"").decode("utf-8", "replace")

    reader = threading.Thread(target=_drain, daemon=True)
    reader.start()

    start = time.time()
    window = timeout
    rounds = 0
    while True:
        # Wait up to `window` seconds for the process, but poll the stop predicate
        # in short ticks so a user Stop aborts the command immediately instead of
        # blocking for the whole window. (The inner tick also ends early the moment
        # the process finishes.)
        waited = 0.0
        while waited < window:
            tick = min(_STOP_POLL_SECONDS, window - waited)
            reader.join(tick)
            if not reader.is_alive():
                break
            if _stop_requested():
                _kill_proc(proc)
                reader.join(2)
                return {
                    "stdout": captured.get("stdout", ""),
                    "stderr": "[stopped by user]",
                    "returncode": 130,
                    "stopped": True,
                }
            waited += tick

        if not reader.is_alive():
            # Process finished and its output has been fully drained.
            return {
                "stdout": captured.get("stdout", ""),
                "stderr": captured.get("stderr", ""),
                "returncode": proc.returncode,
            }

        elapsed = int(time.time() - start)
        decider = _timeout_decider
        rounds += 1

        action, extra = ("kill", None)
        if decider is not None and rounds <= _MAX_DECISION_ROUNDS:
            try:
                action, extra = decider(display, elapsed, timeout, rounds)
            except Exception:
                action, extra = ("kill", None)

        if action == "extend" and isinstance(extra, (int, float)) and extra > 0:
            window = float(extra)
            continue

        # Kill path: terminate, let the drain thread settle, return partial
        # output plus a clear timeout error the agent can react to.
        _kill_proc(proc)
        reader.join(5)
        return {
            "stdout": captured.get("stdout", ""),
            "stderr": captured.get("stderr", ""),
            "error": timeout_msg.format(elapsed=elapsed),
        }
