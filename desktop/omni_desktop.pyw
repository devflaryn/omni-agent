"""Omni Agent desktop launcher.

Starts the Node server hidden (no console), then opens a pywebview window on it.
Run with pythonw so no terminal appears:  pythonw desktop\\omni_desktop.pyw [cwd] [--port N]
  --plan   print the spawn plan as JSON and exit (used by the tests)
Falls back to Edge app mode, then the default browser, when pywebview is missing.
"""
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
WIN = sys.platform.startswith("win")
CREATE_NO_WINDOW = 0x08000000


def read_config():
    try:
        with open(os.path.join(ROOT, "omni.config.json"), "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def arg_value(argv, name, default=None):
    if name in argv:
        i = argv.index(name)
        if i + 1 < len(argv):
            return argv[i + 1]
    return default


def plan(argv):
    cfg = read_config()
    port = int(arg_value(argv, "--port", os.environ.get("OMNI_PORT") or cfg.get("port") or 4400))
    desktop = os.path.join(os.path.expanduser("~"), "Desktop")
    positional = [a for i, a in enumerate(argv) if not a.startswith("--") and (i == 0 or argv[i - 1] not in ("--port",))]
    cwd = positional[0] if positional else desktop
    if cwd == ".":
        cwd = desktop
    node = os.environ.get("OMNI_NODE") or shutil.which("node")
    passthrough = [a for a in argv if a.startswith("--") and a not in ("--plan", "--lan", "--port")]
    args = [node or "node", os.path.join(ROOT, "server", "index.mjs"), "--cwd", cwd, "--port", str(port), "--lan"] + passthrough
    return {"port": port, "url": f"http://127.0.0.1:{port}/?desktop=1", "node": node, "args": args, "log": os.path.join(ROOT, "omni.log"), "root": ROOT}


def alive(port, timeout=1.0):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/state", timeout=timeout) as r:
            return r.status == 200
    except Exception:
        return False


def msgbox(title, text):
    if WIN:
        try:
            import ctypes
            ctypes.windll.user32.MessageBoxW(0, text, title, 0x40)
            return
        except Exception:
            pass
    print(f"{title}: {text}", file=sys.stderr)


def kill_tree(proc):
    if WIN:
        subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], creationflags=CREATE_NO_WINDOW, capture_output=True)
    else:
        proc.terminate()


def start_server(p):
    log = open(p["log"], "ab")
    kwargs = {"cwd": p["root"], "stdout": log, "stderr": subprocess.STDOUT, "stdin": subprocess.DEVNULL}
    if WIN:
        kwargs["creationflags"] = CREATE_NO_WINDOW
    proc = subprocess.Popen(p["args"], **kwargs)
    deadline = time.time() + 20
    while time.time() < deadline:
        if alive(p["port"]):
            return proc
        if proc.poll() is not None:
            break
        time.sleep(0.25)
    if proc.poll() is None:
        kill_tree(proc)
    return None


def shutdown(p, proc):
    try:
        req = urllib.request.Request(f"http://127.0.0.1:{p['port']}/api/shutdown", method="POST", data=b"{}", headers={"content-type": "application/json"})
        urllib.request.urlopen(req, timeout=2).read()
    except Exception:
        pass
    deadline = time.time() + 3
    while proc.poll() is None and time.time() < deadline:
        time.sleep(0.1)
    if proc.poll() is None:
        kill_tree(proc)


def open_window(url):
    try:
        import webview
    except ImportError:
        return False
    window = webview.create_window("Omni Agent", url, width=1280, height=820, min_size=(720, 520))

    def sync_title():
        last = None
        failures = 0
        while True:
            time.sleep(2)
            try:
                title = window.evaluate_js("document.title")
                if title and title != last:
                    window.set_title(title)
                    last = title
                failures = 0
            except Exception:
                failures += 1
                if failures < 5:
                    continue
                return

    threading.Thread(target=sync_title, daemon=True).start()
    webview.start()
    return True


def fallback(url):
    candidates = [shutil.which("msedge"), r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe", r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"]
    edge = next((c for c in candidates if c and os.path.exists(c)), None)
    if edge:
        subprocess.Popen([edge, f"--app={url}"])
        msgbox("Omni Agent", "pywebview is not installed for this Python, so Omni opened in an Edge app window instead.\nInstall it with:  pip install pywebview\nThe Omni Agent server keeps running in the background; end the node.exe process to stop it.")
    else:
        webbrowser.open(url)
        msgbox("Omni Agent", "pywebview is not installed for this Python, so Omni opened in your browser instead.\nInstall it with:  pip install pywebview\nThe Omni Agent server keeps running in the background; end the node.exe process to stop it.")
    return True


def main(argv):
    p = plan(argv)
    if "--plan" in argv:
        print(json.dumps(p))
        return 0
    if not p["node"]:
        msgbox("Omni Agent", "Node.js was not found on PATH. Install Node 22+ or set OMNI_NODE to node.exe.")
        return 1
    started = None
    if not alive(p["port"]):
        started = start_server(p)
        if started is None:
            msgbox("Omni Agent", f"The server did not start on port {p['port']}. See omni.log in the Omni Agent folder.")
            return 1
    keep = False
    try:
        if not open_window(p["url"]):
            fallback(p["url"])
            keep = True
    except Exception as e:  # webview import worked but the window failed (e.g. no WebView2 runtime)
        msgbox("Omni Agent", f"The window could not be opened: {e}\nOpen {p['url']} in a browser instead.")
        return 1
    finally:
        if started is not None and not keep:
            shutdown(p, started)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
