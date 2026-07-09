import subprocess
import os

CONTAINER_NAME = "re_agent_sandbox"
IMAGE_NAME = "re_sandbox_env"

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
    Kills the command and returns an error dict if it exceeds `timeout` seconds.
    """
    cmd = ["docker", "exec", CONTAINER_NAME, "sh", "-c", command]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout)
        return {
            "stdout": result.stdout,
            "stderr": result.stderr,
            "returncode": result.returncode
        }
    except subprocess.TimeoutExpired:
        return {
            "stdout": "",
            "stderr": "",
            "error": f"Command timed out after {timeout}s. Try a lighter command or break the task into smaller steps."
        }
