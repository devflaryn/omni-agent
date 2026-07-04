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
    """Builds and starts the Docker sandbox if it isn't running, attaching the specific project workspace."""
    global _workspace_host_path
    print(f"[Docker] Checking sandbox environment for workspace: {project_workspace_dir}...")

    # Ensure the project workspace folder exists. All project files live here directly.
    os.makedirs(project_workspace_dir, exist_ok=True)
    _workspace_host_path = os.path.abspath(project_workspace_dir)

    try:
        print("[Docker] Ensuring image is up to date (will use cache if unchanged)...")
        subprocess.run(["docker", "build", "-t", IMAGE_NAME, "."], check=True)

        # Check if container is running. If it is, kill it so we can mount the NEW project workspace
        subprocess.run(["docker", "rm", "-f", CONTAINER_NAME], stderr=subprocess.DEVNULL)

        print(f"[Docker] Starting sandbox container for this project: {CONTAINER_NAME}")
        subprocess.run([
            "docker", "run", "-d",
            "--name", CONTAINER_NAME,
            "-v", f"{_workspace_host_path}:/workspace",
            IMAGE_NAME,
            "tail", "-f", "/dev/null"  # Keep container alive
        ], check=True)

    except FileNotFoundError:
        print("\n[ERROR] Docker is not installed or not running.")
        print("Please ensure Docker Desktop is installed and currently running on your Windows machine.")
        print("You can download it from: https://docs.docker.com/desktop/install/windows-install/")
        exit(1)

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
