"""Frida runtime hooking / dynamic-instrumentation tools for the DEV BASE.

These run NATIVELY on the Windows host (like tools/android_emulator.py), using
the host `frida` Python binding against the frida-server baked into
base-dev.qcow2. They ONLY work on an omnidroid account booted from the dev base
(ensure_emulator_running dev=true / OMNI_USE_DEV_BASE=1); on a production account
the frida-server is absent and every tool here returns a clear "not a dev base"
error.

Connection model: the baked frida-server listens on a CUSTOM loopback port inside
the guest (hidden — see omni-fridad), so frida's usb/adb transport (which probes
the default 27042) can't auto-find it. Each tool starts the hidden server if
needed, `adb forward`s a host port onto the guest's frida port, and attaches via
frida's remote-device transport. The forward is torn down after each call.

x86/ABI NOTE (important): the dev base is x86_64 Bliss; an arm64-only app runs in
an x86_64 process (app_process64) with its arm64 .so code executed by libndk
TRANSLATION. So JAVA/KOTLIN hooks (Java.use/Java.perform, via x86_64 libart) work
fully, but Interceptor/Stalker hooks of the app's own ARM64 native functions are
unreliable — x86_64 frida can't instrument translated arm64 instructions. Hook the
Java layer here; do native arm64 RE statically (Ghidra/r2) + static .so patching.
"""
import json
import os
import re
import threading
import time

from tool_registry import registry
from tools.common import resolve_workspace_path
# Reuse the dev-base plumbing already in android_emulator (serial resolution,
# adb-root, dev-manifest detection, host adb runner).
from tools.android_emulator import (
    _resolve_serial, _dev_manifest, _adb_root, _run, _default_device_name,
    _DEFAULT_BACKEND,
)


def _require_frida():
    try:
        import frida  # noqa: F401
        return frida, None
    except Exception as e:  # ImportError or loader error
        return None, {"error": (
            f"the host 'frida' Python binding is not importable ({e}). Install it "
            f"to match the dev base's frida-server: `pip install frida==17.15.4 "
            f"frida-tools`.")}


_BRIDGE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "frida_bridges")
_BRIDGE_CACHE = {}


def _bridge_source(name):
    if name not in _BRIDGE_CACHE:
        try:
            with open(os.path.join(_BRIDGE_DIR, f"{name}.js"), "r", encoding="utf-8") as f:
                _BRIDGE_CACHE[name] = f.read()
        except OSError:
            _BRIDGE_CACHE[name] = None
    return _BRIDGE_CACHE[name]


def _inject_bridges(js):
    """frida 17 removed the Java/ObjC runtime bridges from bare create_script
    sources, so a script using `Java.` fails with 'Java is not defined' (native
    Process/Interceptor/Memory still work). Restore Java the way the frida REPL
    does: evaluate the vendored bridge (tools/frida_bridges/java.js, which defines
    `bridge`) and bind it to globalThis.Java. Only prepended when the script
    references Java, so native-only agents stay lean. The vendored bridge tracks
    the pinned frida version (17.15.4)."""
    if not re.search(r"\bJava\b", js):
        return js
    src = _bridge_source("java")
    if not src:
        return js  # bridge missing; Java.* will error clearly at runtime
    return ("(function(){\n" + src +
            "\nObject.defineProperty(globalThis,'Java',"
            "{value:bridge,configurable:true,writable:true});\n})();\n") + js


def _connect(device_name=None, backend=_DEFAULT_BACKEND, start_server=True):
    """Ensure the dev account's hidden frida-server is up and return
    (frida_device, cleanup_fn, info_dict) or (None, None, error_dict)."""
    frida, err = _require_frida()
    if err:
        return None, None, err
    adb, serial_or_err = _resolve_serial(backend, device_name)
    if adb is None:
        return None, None, serial_or_err
    serial = serial_or_err
    _adb_root(adb, serial)
    manifest = _dev_manifest(adb, serial)
    if manifest is None:
        return None, None, {"error": (
            "This account is not a DEV base (no omni-devkit manifest / frida-server). "
            "Boot it with ensure_emulator_running(dev=true) or set OMNI_USE_DEV_BASE=1, "
            "and make sure `omni build-dev-base` produced base-dev.qcow2.")}
    guest_port = int(manifest.get("frida_port") or 27142)
    if start_server:
        _run([adb, "-s", serial, "shell", "omni-fridad"], timeout=40)
    # Forward a host port onto the guest's hidden frida port.
    fwd = _run([adb, "-s", serial, "forward", "tcp:0", f"tcp:{guest_port}"], timeout=15)
    host_port = (fwd.get("stdout") or "").strip()
    if not host_port.isdigit():
        host_port = str(guest_port)
        _run([adb, "-s", serial, "forward", f"tcp:{host_port}", f"tcp:{guest_port}"], timeout=15)

    def cleanup():
        try:
            _run([adb, "-s", serial, "forward", "--remove", f"tcp:{host_port}"], timeout=10)
        except Exception:
            pass

    try:
        dev = frida.get_device_manager().add_remote_device(f"127.0.0.1:{host_port}")
        # Touch it so a bad connection fails HERE with a clean message.
        dev.enumerate_processes()
    except Exception as e:
        cleanup()
        return None, None, {"error": f"could not reach frida-server via 127.0.0.1:{host_port}: {e}"}
    info = {"host_port": host_port, "guest_port": guest_port,
            "frida_version": manifest.get("frida_version"), "serial": serial}
    return dev, cleanup, info


def _resolve_target_pid(dev, package_name):
    """pid of a running process matching package_name (exact name first, then
    substring), or None."""
    procs = dev.enumerate_processes()
    for p in procs:
        if p.name == package_name:
            return p.pid
    for p in procs:
        if package_name in p.name:
            return p.pid
    return None


def _run_script_on_target(dev, package_name, js, mode, duration_seconds):
    """Spawn/attach the target, inject js, collect messages for duration.
    Returns (result_dict). Raises on hard frida errors (caller wraps)."""
    messages = []
    lock = threading.Lock()

    def on_message(message, data):
        with lock:
            t = message.get("type")
            if t == "send":
                messages.append(("send", message.get("payload")))
            elif t == "error":
                messages.append(("error", message.get("description") or message.get("stack")))
            elif t == "log":
                messages.append(("log", message.get("payload")))

    spawned_pid = None
    if mode == "spawn":
        spawned_pid = dev.spawn([package_name])
        session = dev.attach(spawned_pid)
    else:
        pid = _resolve_target_pid(dev, package_name)
        if pid is None:
            return {"error": (
                f"'{package_name}' is not running — attach needs a live process. "
                f"Launch it first (launch_app_on_emulator) or use mode='spawn'.")}
        session = dev.attach(pid)

    script = session.create_script(_inject_bridges(js))
    script.on("message", on_message)
    try:
        script.set_log_handler(lambda level, text: on_message({"type": "log", "payload": text}, None))
    except Exception:
        pass
    script.load()
    if spawned_pid is not None:
        dev.resume(spawned_pid)

    time.sleep(max(1, min(int(duration_seconds), 120)))

    # Is the target still alive (did the hook/app crash or self-kill)?
    still_alive = _resolve_target_pid(dev, package_name) is not None
    try:
        script.unload()
    except Exception:
        pass
    try:
        session.detach()
    except Exception:
        pass

    with lock:
        collected = list(messages)
    sends = [p for (k, p) in collected if k == "send"]
    logs = [p for (k, p) in collected if k == "log"]
    errors = [p for (k, p) in collected if k == "error"]
    return {"sends": sends, "logs": logs, "errors": errors,
            "target_alive": still_alive, "mode": mode}


def _format_result(info, res, header):
    if "error" in res:
        return {"error": res["error"]}
    lines = [header,
             f"  frida {info.get('frida_version')} via 127.0.0.1:{info.get('host_port')} "
             f"(hidden guest port {info.get('guest_port')}); mode={res.get('mode')}",
             f"  target still alive after run: {res.get('target_alive')}"]
    if res.get("errors"):
        lines.append("  SCRIPT ERRORS:")
        for e in res["errors"][:10]:
            lines.append("    " + str(e)[:500])
    body = res.get("sends", []) + res.get("logs", [])
    if body:
        lines.append(f"  OUTPUT ({len(body)} message(s), showing up to 200):")
        for m in body[:200]:
            lines.append("    " + (json.dumps(m) if not isinstance(m, str) else m)[:600])
    else:
        lines.append("  (no send()/console.log output captured in the window)")
    return {"stdout": "\n".join(lines)}


@registry.register(
    name="frida_list_processes",
    description=(
        "Lists processes/apps visible to the DEV-BASE frida-server (through the hidden port). Proves "
        "frida connectivity and gives you exact process names/pids to target with frida_run_script / "
        "frida_trace. Dev base only (ensure_emulator_running dev=true)."
    ),
    params_schema={
        "filter": "string (optional — case-insensitive substring to filter process names, e.g. 'roblox')",
        "device_name": "string (optional — the omnidroid dev account name, default 'omniagent')",
        "backend": "string (optional, default 'qemu')"
    },
    output="A list of pid + process name (optionally filtered), or an error if the account isn't a dev base.",
    when_to_use="Call after ensure_emulator_running(dev=true) to confirm frida is reachable and to find the exact process name/pid of the app under test."
)
def frida_list_processes(filter=None, device_name=None, backend=_DEFAULT_BACKEND):
    dev, cleanup, info = _connect(device_name, backend)
    if dev is None:
        return info
    try:
        procs = dev.enumerate_processes()
        rows = [(p.pid, p.name) for p in procs]
        if filter:
            f = str(filter).lower()
            rows = [r for r in rows if f in r[1].lower()]
        rows.sort(key=lambda r: r[1].lower())
        body = "\n".join(f"  {pid:>6}  {name}" for pid, name in rows) or "  (no matching processes)"
        return {"stdout": (f"frida {info['frida_version']} reachable (host 127.0.0.1:{info['host_port']} "
                           f"-> hidden guest {info['guest_port']}). {len(rows)} process(es):\n{body}")}
    except Exception as e:
        return {"error": f"enumerate_processes failed: {e}"}
    finally:
        cleanup()


@registry.register(
    name="frida_run_script",
    description=(
        "Injects a Frida JavaScript agent into an app on the DEV BASE and returns everything it emits. "
        "This is the core runtime-hooking tool: attach to (or spawn) the target, load your JS, run it for "
        "a window, and collect every send(...) payload, console.log line, and script error. Use send({...}) "
        "in your script to return structured data; console.log is also captured. mode='spawn' gates the "
        "app at startup so you can hook BEFORE its early code runs (anti-tamper/init) — the app is resumed "
        "right after the script loads. mode='attach' (default) hooks an already-running app. "
        "Java/Kotlin hooks (Java.perform/Java.use) work fully on the x86 base (libart is native x86_64); "
        "native Interceptor hooks of the app's own ARM64 .so are unreliable under libndk translation — "
        "prefer Java hooks, or hook x86_64 system libs."
    ),
    params_schema={
        "package_name": "string (the app package / process name, e.g. 'com.roblox.client')",
        "script": "string (optional — the Frida JS agent source, inline. Provide this OR script_path)",
        "script_path": "string (optional — /workspace-relative path to a .js agent file. Provide this OR script)",
        "mode": "string (optional, default 'attach' — 'attach' hooks the running app; 'spawn' launches it gated so you can hook startup, then resumes)",
        "duration_seconds": "integer (optional, default 12, max 120 — how long to keep the agent loaded and collect output)",
        "device_name": "string (optional — the omnidroid dev account name, default 'omniagent')",
        "backend": "string (optional, default 'qemu')"
    },
    output="The agent's captured output: send() payloads, console.log lines, and any script errors, plus whether the target stayed alive (a crash/self-kill right after injection is a strong sign the app detected instrumentation).",
    when_to_use="Use to dynamically hook/observe an app: bypass a Java-layer check, dump decrypted strings, trace auth/network calls, read return values, etc. Call ensure_emulator_running(dev=true) first (frida_run_script also auto-starts the hidden frida-server)."
)
def frida_run_script(package_name, script=None, script_path=None, mode="attach",
                     duration_seconds=12, device_name=None, backend=_DEFAULT_BACKEND):
    if not script and not script_path:
        return {"error": "provide either 'script' (inline JS) or 'script_path' (/workspace .js file)."}
    js = script
    if script_path:
        try:
            host_path = resolve_workspace_path(script_path)
        except RuntimeError as e:
            return {"error": str(e)}
        try:
            with open(host_path, "r", encoding="utf-8") as f:
                js = f.read()
        except OSError as e:
            return {"error": f"could not read script_path: {e}"}
    mode = (mode or "attach").strip().lower()
    if mode not in ("attach", "spawn"):
        return {"error": "mode must be 'attach' or 'spawn'."}
    dev, cleanup, info = _connect(device_name, backend)
    if dev is None:
        return info
    try:
        res = _run_script_on_target(dev, package_name, js, mode, duration_seconds)
        return _format_result(info, res, f"frida_run_script on '{package_name}':")
    except Exception as e:
        return {"error": f"frida_run_script failed: {type(e).__name__}: {e}"}
    finally:
        cleanup()


_JAVA_TRACE_TEMPLATE = r"""
Java.perform(function () {
  var targets = %TARGETS%;
  targets.forEach(function (t) {
    var idx = t.lastIndexOf('.');
    if (idx < 0) { send({hook_error: 'bad target (want fqcn.method): ' + t}); return; }
    var cls = t.substring(0, idx), meth = t.substring(idx + 1);
    try {
      var C = Java.use(cls);
      if (!C[meth]) { send({hook_error: 'no method ' + t}); return; }
      var ovs = C[meth].overloads;
      ovs.forEach(function (ov) {
        ov.implementation = function () {
          var a = Array.prototype.slice.call(arguments).map(function (x) {
            try { return String(x); } catch (e) { return '<?>'; } });
          var ret = ov.apply(this, arguments);
          var rs; try { rs = String(ret); } catch (e) { rs = '<?>'; }
          send({trace: t, args: a, ret: rs});
          return ret;
        };
      });
      send({hooked: t + ' (' + ovs.length + ' overload(s))'});
    } catch (e) { send({hook_error: 'hook failed ' + t + ': ' + e}); }
  });
});
"""

_NATIVE_TRACE_TEMPLATE = r"""
var specs = %TARGETS%;
specs.forEach(function (spec) {
  var parts = spec.split('!');
  var mod = parts.length > 1 ? parts[0] : null;
  var sym = parts.length > 1 ? parts[1] : parts[0];
  var addr = null;
  try { addr = Module.findExportByName(mod, sym); } catch (e) {}
  if (!addr) { send({hook_error: 'native symbol not found (x86_64 only): ' + spec}); return; }
  try {
    Interceptor.attach(addr, {
      onEnter: function (args) {
        this._s = spec;
        send({ntrace: spec, args: [String(args[0]), String(args[1]), String(args[2]), String(args[3])]});
      },
      onLeave: function (retval) { send({ntrace: this._s, ret: String(retval)}); }
    });
    send({hooked: spec});
  } catch (e) { send({hook_error: 'attach failed ' + spec + ': ' + e}); }
});
"""


@registry.register(
    name="frida_trace",
    description=(
        "Convenience wrapper over frida_run_script that auto-generates a tracing agent: it hooks the "
        "Java methods and/or native functions you name and logs every call's arguments and return value. "
        "Java methods are given as fully-qualified 'com.pkg.Class.method' (all overloads are hooked) and "
        "work fully on the x86 base. Native functions are 'libfoo.so!symbol' (or just 'symbol') and are "
        "hooked via Interceptor — reliable only for x86_64 modules (system libs, the app's x86_64 code); "
        "the app's own ARM64 .so under libndk translation generally won't resolve/attach cleanly."
    ),
    params_schema={
        "package_name": "string (the app package / process name)",
        "java_methods": "array of string (optional — fully-qualified 'com.pkg.Class.method' to trace; all overloads hooked)",
        "native_functions": "array of string (optional — 'module.so!symbol' or 'symbol'; x86_64 targets only)",
        "mode": "string (optional, default 'attach' — or 'spawn' to trace from process start)",
        "duration_seconds": "integer (optional, default 15, max 120)",
        "device_name": "string (optional — the omnidroid dev account name, default 'omniagent')",
        "backend": "string (optional, default 'qemu')"
    },
    output="Per-call trace lines (args + return value) for each hooked method, plus which hooks installed/failed and whether the target stayed alive.",
    when_to_use="Use to watch specific methods without writing a full agent: trace an auth check, a crypto call, a license validator, a URL builder, etc. For anything more custom, write the agent and use frida_run_script."
)
def frida_trace(package_name, java_methods=None, native_functions=None, mode="attach",
                duration_seconds=15, device_name=None, backend=_DEFAULT_BACKEND):
    java_methods = java_methods or []
    native_functions = native_functions or []
    if isinstance(java_methods, str):
        java_methods = [java_methods]
    if isinstance(native_functions, str):
        native_functions = [native_functions]
    if not java_methods and not native_functions:
        return {"error": "provide at least one of java_methods or native_functions."}
    parts = []
    if java_methods:
        parts.append(_JAVA_TRACE_TEMPLATE.replace("%TARGETS%", json.dumps(list(java_methods))))
    if native_functions:
        parts.append(_NATIVE_TRACE_TEMPLATE.replace("%TARGETS%", json.dumps(list(native_functions))))
    js = "\n".join(parts)
    return frida_run_script(package_name, script=js, mode=mode,
                            duration_seconds=duration_seconds,
                            device_name=device_name, backend=backend)


# A compact, widely-used Java-layer TLS-unpinning agent: neutralizes the default
# TrustManager, HostnameVerifier, OkHttp CertificatePinner, and TrustManagerImpl
# so an intercepting proxy's cert is accepted. Java layer => works on the x86 base.
_SSL_UNPIN_JS = r"""
Java.perform(function () {
  var count = 0;
  function ok(w) { count++; send({unpinned: w}); }
  // 1) Custom X509TrustManager that accepts everything.
  try {
    var X509TM = Java.use('javax.net.ssl.X509TrustManager');
    var SSLContext = Java.use('javax.net.ssl.SSLContext');
    var TrustManager = Java.registerClass({
      name: 'com.omni.Trust', implements: [X509TM],
      methods: {
        checkClientTrusted: function (c, a) {},
        checkServerTrusted: function (c, a) {},
        getAcceptedIssuers: function () { return []; }
      }
    });
    var tms = [TrustManager.$new()];
    var init = SSLContext.init.overload(
      '[Ljavax.net.ssl.KeyManager;', '[Ljavax.net.ssl.TrustManager;', 'java.security.SecureRandom');
    init.implementation = function (km, tm, sr) { ok('SSLContext.init'); init.call(this, km, tms, sr); };
  } catch (e) { send({unpin_skip: 'SSLContext: ' + e}); }
  // 2) OkHttp CertificatePinner.check -> no-op.
  ['okhttp3.CertificatePinner', 'com.squareup.okhttp.CertificatePinner'].forEach(function (cn) {
    try {
      var CP = Java.use(cn);
      CP.check.overload('java.lang.String', 'java.util.List').implementation = function () { ok(cn + '.check'); };
    } catch (e) {}
  });
  // 3) Conscrypt/Android TrustManagerImpl.verifyChain / checkTrusted.
  try {
    var TMI = Java.use('com.android.org.conscrypt.TrustManagerImpl');
    if (TMI.verifyChain) {
      TMI.verifyChain.implementation = function (chain) { ok('TrustManagerImpl.verifyChain'); return chain; };
    }
    if (TMI.checkTrustedRecursive) {
      TMI.checkTrustedRecursive.implementation = function () { ok('TrustManagerImpl.checkTrustedRecursive'); return Java.use('java.util.ArrayList').$new(); };
    }
  } catch (e) {}
  // 4) HostnameVerifier -> always true.
  try {
    var HUC = Java.use('javax.net.ssl.HttpsURLConnection');
    HUC.setDefaultHostnameVerifier.implementation = function (v) { ok('HttpsURLConnection.HV'); };
  } catch (e) {}
  send({ssl_unpin_ready: true});
});
"""


@registry.register(
    name="frida_bypass_ssl_pinning",
    description=(
        "Injects a ready-made Frida agent that disables common Android TLS certificate pinning "
        "(custom X509TrustManager, OkHttp CertificatePinner, Conscrypt TrustManagerImpl, HostnameVerifier) "
        "so traffic can be intercepted by a proxy for analysis. Java-layer, so it works on the x86 dev "
        "base. mode='spawn' installs it before the app makes any TLS call (recommended); the tool reports "
        "each pinning check it neutralized. This is for authorized security testing of the app under test."
    ),
    params_schema={
        "package_name": "string (the app package, e.g. 'com.example.app')",
        "mode": "string (optional, default 'spawn' — 'spawn' hooks before first network call; 'attach' hooks a running app)",
        "duration_seconds": "integer (optional, default 20, max 120 — how long to keep the hook active/collecting)",
        "device_name": "string (optional — the omnidroid dev account name, default 'omniagent')",
        "backend": "string (optional, default 'qemu')"
    },
    output="Which pinning mechanisms were neutralized (each 'unpinned' event), readiness confirmation, and whether the app stayed alive. Point the app at an intercepting proxy separately to capture the now-trusted traffic.",
    when_to_use="Use when you need to inspect an app's HTTPS traffic and it rejects your proxy's certificate. Pair with a proxy on the host; run in mode='spawn' so pinning is disabled before the first request."
)
def frida_bypass_ssl_pinning(package_name, mode="spawn", duration_seconds=20,
                             device_name=None, backend=_DEFAULT_BACKEND):
    return frida_run_script(package_name, script=_SSL_UNPIN_JS, mode=mode,
                            duration_seconds=duration_seconds,
                            device_name=device_name, backend=backend)
