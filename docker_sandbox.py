import subprocess
import os
import time
import threading

CONTAINER_NAME = "re_agent_sandbox"
IMAGE_NAME = "re_sandbox_env"

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
    """Register the callback consulted when a sandbox command exceeds its
    timeout (see the module note above). Pass None to restore hard-kill."""
    global _timeout_decider
    _timeout_decider = fn


def _kill_proc(proc):
    try:
        proc.kill()
    except Exception:
        pass

# Absolute HOST path of the currently active project's workspace directory —
# the same directory that's bind-mounted to /workspace inside the sandbox.
# Set by setup_sandbox(); read by tools that need real Python file I/O on the
# host instead of going through docker exec (currently: the Android emulator
# tools, since the emulator itself runs natively on Windows rather than
# inside the Linux sandbox used for APK static analysis/patching).
_workspace_host_path = None


def get_workspace_host_path():
    """Returns the absolute host path of the active project's workspace dir."""
    if _workspace_host_path is None:
        raise RuntimeError("No active project workspace — setup_sandbox() hasn't been called yet.")
    return _workspace_host_path


def setup_sandbox(project_workspace_dir):
    """Build the sandbox image and (re)start the container with
    project_workspace_dir BIND-MOUNTED at /workspace.

    project_workspace_dir is the folder the USER PICKED at runtime — its own
    project root, mounted directly (no copy-in). Selecting a different folder
    just calls this again to re-run the container against the new mount. All
    build/test dependencies live in the container, so nothing installs on the
    host. Raises RuntimeError with an actionable message on any failure (Docker
    missing/stopped, image build, a non-Docker-shareable path, container start)
    rather than killing the process."""
    global _workspace_host_path
    os.makedirs(project_workspace_dir, exist_ok=True)
    _workspace_host_path = os.path.abspath(project_workspace_dir)
    print(f"[Docker] Preparing sandbox for workspace: {_workspace_host_path}")

    try:
        print("[Docker] Building image (cached if unchanged)...")
        subprocess.run(["docker", "build", "-t", IMAGE_NAME, "."], check=True)

        # One-line PREFLIGHT: is the picked host folder Docker-shareable? Docker
        # Desktop only bind-mounts folders on shared drives; an unshared path
        # otherwise fails with a cryptic mount error when the real container
        # starts. A quick throwaway run surfaces a clear message instead.
        pf = subprocess.run(
            ["docker", "run", "--rm", "-v", f"{_workspace_host_path}:/pf",
             IMAGE_NAME, "test", "-d", "/pf"],
            capture_output=True, text=True)
        if pf.returncode != 0:
            raise RuntimeError(
                f"The selected folder is not Docker-shareable:\n  {_workspace_host_path}\n"
                "Enable file sharing for its drive in Docker Desktop "
                "(Settings -> Resources -> File Sharing), or pick a folder on a "
                f"shared drive.\nDocker said: {(pf.stderr or pf.stdout).strip()[:300]}")

        # Kill any prior container so we can mount the NEW picked folder.
        subprocess.run(["docker", "rm", "-f", CONTAINER_NAME], stderr=subprocess.DEVNULL)
        print(f"[Docker] Starting container {CONTAINER_NAME} "
              f"(mount {_workspace_host_path} -> /workspace)")
        subprocess.run([
            "docker", "run", "-d",
            "--name", CONTAINER_NAME,
            "-v", f"{_workspace_host_path}:/workspace",
            IMAGE_NAME,
            "tail", "-f", "/dev/null"  # Keep container alive
        ], check=True)

    except FileNotFoundError:
        raise RuntimeError(
            "Docker is not installed or not running. Install and start Docker "
            "Desktop, then try again: https://docs.docker.com/desktop/")
    except subprocess.CalledProcessError as e:
        raise RuntimeError(f"Docker sandbox build/start failed: {e}")

DEFAULT_TIMEOUT = 60  # seconds; callers can override for long-running tools

def run_cmd(command, timeout=DEFAULT_TIMEOUT):
    """
    Executes a shell command inside the docker sandbox.
    Returns a dictionary with stdout, stderr, and the return code.

    On timeout the command is NOT killed outright: if a timeout decider is
    registered (see set_timeout_decider) it is asked whether to kill the
    still-running process or give it more time. Only when it decides to kill
    (or no decider is registered) does the process get terminated and an error
    dict returned.
    """
    cmd = ["docker", "exec", CONTAINER_NAME, "sh", "-c", command]
    return _run_polling(cmd, timeout, display=command,
                        timeout_msg=f"Command timed out after {{elapsed}}s. "
                        "Try a lighter command or break the task into smaller steps.")


def _run_polling(cmd, timeout, display, timeout_msg):
    """Run `cmd` (a list, no shell) draining its output, waiting in `timeout`-
    second windows. When a window elapses without the process finishing, consult
    the registered timeout decider instead of killing immediately. Returns the
    same shape as run_cmd. `display` is the human-readable command shown to the
    decider; `timeout_msg` is the error text used when we do kill (a "{elapsed}"
    placeholder is filled with the total seconds run)."""
    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except FileNotFoundError:
        # `docker` isn't installed / not on PATH. Return an error dict (with a
        # non-zero returncode) instead of raising, so callers that fall back to
        # a host-side path (e.g. build_code_graph) can do so cleanly.
        return {"stdout": "", "stderr": "docker executable not found", "returncode": 127}
    except OSError as e:
        return {"stdout": "", "stderr": f"docker exec failed: {e}", "returncode": 1}

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
        reader.join(window)
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
