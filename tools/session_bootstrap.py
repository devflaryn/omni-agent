"""Inject the Omni session bootstrap into a decoded Roblox APK.

This is the step that makes token login work. Everything else in the session path
is already built (host -> kiosk -> deep-link join); the one thing that can log in
is a class running inside Roblox's own uid, because the client's session is a
.ROBLOSECURITY cookie in its WebView cookie jar and its deep-link scheme has no
auth parameter. See contracts/omni-session.md.

Pipeline position:

    decode_apk  ->  [inject_session_bootstrap]  ->  recompile_apk  ->  sign_apk

What it does to the decoded tree:

  1. reads AndroidManifest.xml for android:name on <application>
  2. adds com/omni/bootstrap/OmniBootstrap.smali (baksmali'd from the prebuilt
     omni-bootstrap.dex that omnidroid/bootstrap/build.sh produces)
  3. inserts ONE call at the top of that Application's onCreate():
       invoke-static {p0}, Lcom/omni/bootstrap/OmniBootstrap;->install(Landroid/content/Context;)V

Top-of-onCreate is safe: install() only posts to the main looper, so the real
work still happens after the app's own onCreate returns (which is what keeps it
clear of Roblox's WebView.setDataDirectorySuffix, if it makes one).
"""
import os
import re
import shlex
import shutil
import xml.etree.ElementTree as ET

from tool_registry import registry
from tools.android_emulator import _find_qemu_manager
from tools.common import resolve_workspace_path

ANDROID_NS = "{http://schemas.android.com/apk/res/android}"

BOOTSTRAP_CLASS = "Lcom/omni/bootstrap/OmniBootstrap;"
BOOTSTRAP_REL = os.path.join("com", "omni", "bootstrap")
INSTALL_CALL = ("    invoke-static {p0}, Lcom/omni/bootstrap/OmniBootstrap;->"
                "install(Landroid/content/Context;)V")
MARKER = "# omni-session bootstrap"


def _find_bootstrap_dex():
    """The prebuilt bootstrap dex from omnidroid/bootstrap/build.sh."""
    env = os.environ.get("OMNI_BOOTSTRAP_DEX")
    if env and os.path.isfile(env):
        return env
    try:
        _exe, project_dir = _find_qemu_manager()
    except Exception:
        project_dir = None
    roots = [project_dir] if project_dir else []
    roots += [os.path.join(os.path.dirname(os.path.abspath(__file__)),
                           os.pardir, os.pardir, "omnidroid")]
    for root in roots:
        cand = os.path.join(root, "bootstrap", "build", "omni-bootstrap.dex")
        if os.path.isfile(cand):
            return os.path.abspath(cand)
    return None


def _baksmali(dex_path, out_dir):
    """dex -> smali, via the `baksmali` wrapper on PATH (the same one
    decode_apk/recompile_apk reach for alongside apktool).

    `dex_path` is the prebuilt bootstrap dex from the omnidroid checkout, which
    lives OUTSIDE the workspace. Since tools run on the host now, both it and
    `out_dir` are addressed as plain absolute paths — no staging copy into the
    workspace and back out. Returns None on success, else an error string."""
    from host_exec import run_cmd
    if not os.path.isfile(dex_path):
        return f"bootstrap dex not found: {dex_path}"

    dex_q = shlex.quote(os.path.abspath(dex_path))
    out_q = shlex.quote(os.path.abspath(out_dir))
    cmd = f"rm -rf {out_q} && baksmali d {dex_q} -o {out_q}"
    res = run_cmd(cmd, timeout=180)
    if not isinstance(res, dict):
        return "baksmali failed: no result"
    if res.get("error"):
        return f"baksmali failed: {res['error']}"
    if res.get("returncode", 0) != 0:
        return f"baksmali failed: {(res.get('stderr') or res.get('stdout') or '').strip()[:300]}"
    if not os.path.isdir(out_dir):
        return "baksmali reported success but produced no output directory"
    return None


AXML_MAGIC = b"\x03\x00\x08\x00"


def _axml_application_name(path):
    """(app_class, package) out of a BINARY AndroidManifest.xml, or (None, None).

    apktool only writes a TEXT manifest when it decodes resources; `apktool d -r`
    leaves the manifest as binary AXML. Both shapes reach this tool, so it reads
    both rather than failing with an opaque XML parse error.

    Minimal reader: string pool + start tags. Attribute values are taken from the
    raw-value index (a string attribute always carries one).
    """
    import struct
    data = open(path, "rb").read()
    if data[:4] != AXML_MAGIC:
        return None, None

    def _len8(p):
        n = data[p]
        if n & 0x80:
            return ((n & 0x7F) << 8) | data[p + 1], p + 2
        return n, p + 1

    def _len16(p):
        n = struct.unpack_from("<H", data, p)[0]
        if n & 0x8000:
            n2 = struct.unpack_from("<H", data, p + 2)[0]
            return ((n & 0x7FFF) << 16) | n2, p + 4
        return n, p + 2

    pool, off = [], 8
    while off + 8 <= len(data):
        typ, hdr, size = struct.unpack_from("<HHI", data, off)
        if size == 0:
            break
        if typ == 0x0001:                                   # RES_STRING_POOL
            cnt, _sc, flags, start = struct.unpack_from("<IIII", data, off + 8)
            utf8 = bool(flags & (1 << 8))
            offs = struct.unpack_from("<%dI" % cnt, data, off + hdr)
            base = off + start
            for o in offs:
                p = base + o
                if utf8:
                    _n, p2 = _len8(p)
                    n2, p3 = _len8(p2)
                    pool.append(data[p3:p3 + n2].decode("utf-8", "replace"))
                else:
                    n, p2 = _len16(p)
                    pool.append(data[p2:p2 + n * 2].decode("utf-16-le", "replace"))
            break
        off += size

    def s(i):
        return pool[i] if 0 <= i < len(pool) else None

    pkg, app = None, None
    off = 8
    while off + 8 <= len(data):
        typ, hdr, size = struct.unpack_from("<HHI", data, off)
        if size == 0:
            break
        if typ == 0x0102:                                   # RES_XML_START_TAG
            name_i = struct.unpack_from("<I", data, off + 20)[0]
            tag = s(name_i)
            a_start, _a_sz, a_cnt = struct.unpack_from("<HHH", data, off + 24)
            ap = off + 16 + a_start
            attrs = {}
            for i in range(a_cnt):
                _ns, an, raw, _ts, _d = struct.unpack_from("<IIIII", data,
                                                           ap + i * 20)
                attrs[s(an)] = s(raw)
            if tag == "manifest" and pkg is None:
                pkg = attrs.get("package")
            elif tag == "application":
                app = attrs.get("name")
                break
        off += size
    return app, pkg


def _application_class(decompiled_dir):
    """(class_name, error). Handles apktool's text manifest AND a binary one."""
    man = os.path.join(decompiled_dir, "AndroidManifest.xml")
    if not os.path.isfile(man):
        return None, f"No AndroidManifest.xml in {decompiled_dir} — is this an apktool output dir?"
    with open(man, "rb") as fh:
        binary = fh.read(4) == AXML_MAGIC
    if binary:
        name, pkg = _axml_application_name(man)
        if not name:
            return None, ("binary AndroidManifest.xml has no <application "
                          "android:name>, so there is no Application subclass "
                          "to hook.")
    else:
        try:
            root = ET.parse(man).getroot()
        except ET.ParseError as e:
            return None, f"Could not parse AndroidManifest.xml: {e}"
        app = root.find("application")
        if app is None:
            return None, "AndroidManifest.xml has no <application>"
        name = app.get(ANDROID_NS + "name")
        pkg = root.get("package") or ""
        if not name:
            return None, ("<application> has no android:name, so there is no "
                          "Application subclass to hook. The bootstrap needs "
                          "one; add a stub Application (and point android:name "
                          "at it) before injecting.")
    if name.startswith("."):
        name = (pkg or "") + name
    return name, None


KIOSK_PACKAGE = "com.omni.kiosk"


def _add_queries_entry(decompiled_dir):
    """Make the kiosk VISIBLE to Roblox. Returns (changed, error).

    Android 11+ package-visibility filtering is why this is needed, and it is not
    theoretical: with the bootstrap injected and running, the provider query
    still returned null, and `dumpsys package queries` showed com.roblox.client
    could see only org.lineageos.*. A provider you cannot see does not exist —
    query() just returns null, with no permission error to point at the cause.

    Roblox targets SDK 35, declares its own <queries>, and has no
    QUERY_ALL_PACKAGES, so it needs an explicit entry for the kiosk.
    """
    man = os.path.join(decompiled_dir, "AndroidManifest.xml")
    with open(man, "rb") as fh:
        if fh.read(4) == AXML_MAGIC:
            return False, ("AndroidManifest.xml is binary (decoded with "
                           "`apktool d -r`), so the required <queries> entry "
                           "cannot be added. Re-decode WITH resources "
                           "(decode_apk / plain `apktool d`).")
    with open(man, "r", encoding="utf-8") as fh:
        text = fh.read()
    if re.search(r'<package\s+android:name="%s"' % re.escape(KIOSK_PACKAGE), text):
        return False, None                      # already there; idempotent
    pkg_el = '        <package android:name="%s"/>\n' % KIOSK_PACKAGE
    # <manifest> permits only ONE <queries>. Roblox already ships one, so append
    # into it rather than adding a second (which aapt2 rejects).
    m = re.search(r"<queries>", text)
    if m:
        text = text[:m.end()] + "\n" + pkg_el + text[m.end():]
    else:
        m = re.search(r"<application\b", text)
        if not m:
            return False, "AndroidManifest.xml has no <application> to anchor on"
        # <queries> is a direct child of <manifest>, before <application>.
        text = (text[:m.start()] + "<queries>\n" + pkg_el + "    </queries>\n    "
                + text[m.start():])
    with open(man, "w", encoding="utf-8") as fh:
        fh.write(text)
    return True, None


def _smali_path_for(decompiled_dir, class_name):
    """Locate a class's .smali across smali/, smali_classes2/, ... (apktool
    splits multidex APKs into one tree per dex; Roblox has three)."""
    rel = os.path.join(*class_name.split(".")) + ".smali"
    for entry in sorted(os.listdir(decompiled_dir)):
        if not entry.startswith("smali"):
            continue
        cand = os.path.join(decompiled_dir, entry, rel)
        if os.path.isfile(cand):
            return cand
    return None


def _insert_into_on_create(smali_text):
    """Insert the install() call at the top of onCreate()V.

    Returns (new_text, error). Uses p0 (`this`) only, so .locals never needs
    bumping — parameter registers exist regardless of the locals count.
    """
    if MARKER in smali_text:
        return smali_text, None          # already injected; idempotent
    m = re.search(r"^\.method\s+(?:public|protected)\s+onCreate\(\)V\s*$",
                  smali_text, re.M)
    if not m:
        return None, ("no onCreate()V in the Application class. The class "
                      "exists but does not override onCreate, so there is no "
                      "hook point; add the call to attachBaseContext instead.")
    # Insert after the .locals/.registers directive that opens the method body.
    tail = smali_text[m.end():]
    d = re.search(r"^\s*\.(locals|registers)\s+\d+\s*$", tail, re.M)
    if not d:
        return None, "onCreate()V has no .locals/.registers directive (unexpected smali shape)"
    at = m.end() + d.end()
    injected = f"\n\n    {MARKER}\n{INSTALL_CALL}\n"
    return smali_text[:at] + injected + smali_text[at:], None


@registry.register(
    name="inject_session_bootstrap",
    description=(
        "Inject the Omni session bootstrap into a DECODED Roblox APK so the build can log in from a "
        ".ROBLOSECURITY token instead of a typed password. Adds com/omni/bootstrap/OmniBootstrap.smali "
        "and one invoke-static at the top of the app's Application.onCreate(). At runtime the class "
        "reads the token from the kiosk's ContentProvider and installs it into Roblox's own WebView "
        "cookie jar — the only place the client's session lives, and one only Roblox's uid can write "
        "(its deep-link scheme has NO auth parameter). Idempotent. See contracts/omni-session.md."
    ),
    params_schema={
        "decompiled_dir": "string (REQUIRED — an apktool output dir, i.e. what decode_apk produced; must contain AndroidManifest.xml + smali*/)",
    },
    output=("JSON: {ok, application_class, smali_file, bootstrap_added, already_present}. "
            "On failure {error} explaining which step failed."),
    when_to_use=(
        "Run after decode_apk and before recompile_apk, on every Roblox build that omnidroid will "
        "ship or test. Without it `play_roblox` still joins the right place but Roblox shows its own "
        "login screen, so the session is not zero-click."
    ),
)
def inject_session_bootstrap(decompiled_dir):
    if not decompiled_dir:
        return {"error": "decompiled_dir not found: (empty)"}
    # Every other apk_tools function (decode_apk, recompile_apk, sign_apk, ...)
    # takes a path relative to the project root and resolves it to the host path via
    # resolve_workspace_path. This one did raw os.path.isdir() on whatever the
    # caller passed — since the agent process's OS cwd is NOT the selected
    # project workspace, a normal call using that same convention (e.g. the
    # output_dir decode_apk was just given) always failed with "decompiled_dir
    # not found", even though the directory genuinely existed.
    try:
        resolved_dir = resolve_workspace_path(decompiled_dir)
    except RuntimeError as e:
        return {"error": str(e)}
    if not os.path.isdir(resolved_dir):
        return {"error": f"decompiled_dir not found: {decompiled_dir}"}
    decompiled_dir = resolved_dir

    app_class, err = _application_class(decompiled_dir)
    if err:
        return {"error": err}
    smali_file = _smali_path_for(decompiled_dir, app_class)
    if not smali_file:
        return {"error": (f"Application class {app_class} is declared in the "
                          f"manifest but has no .smali under {decompiled_dir}. "
                          f"Was the APK decoded with --no-src?")}

    # 1. Put the bootstrap class in the FIRST smali tree (apktool packs that one
    #    as classes.dex; cross-dex refs resolve at runtime anyway).
    target_tree = os.path.join(decompiled_dir, "smali")
    dest_dir = os.path.join(target_tree, BOOTSTRAP_REL)
    already = os.path.isfile(os.path.join(dest_dir, "OmniBootstrap.smali"))
    if not already:
        dex = _find_bootstrap_dex()
        if not dex:
            return {"error": ("omni-bootstrap.dex not found. Build it first: "
                              "`bash omnidroid/bootstrap/build.sh` (or set "
                              "OMNI_BOOTSTRAP_DEX to its path).")}
        tmp = os.path.join(decompiled_dir, ".omni-bootstrap-smali")
        shutil.rmtree(tmp, ignore_errors=True)
        err = _baksmali(dex, tmp)
        if err:
            shutil.rmtree(tmp, ignore_errors=True)
            return {"error": err}
        src = os.path.join(tmp, BOOTSTRAP_REL)
        if not os.path.isdir(src):
            shutil.rmtree(tmp, ignore_errors=True)
            return {"error": f"baksmali output has no {BOOTSTRAP_REL} (bad dex?)"}
        os.makedirs(dest_dir, exist_ok=True)
        for fn in os.listdir(src):
            shutil.copy2(os.path.join(src, fn), os.path.join(dest_dir, fn))
        shutil.rmtree(tmp, ignore_errors=True)

    # 2. Make the kiosk visible to this app (Android 11+ package visibility).
    #    Without this the bootstrap runs but every provider query returns null.
    queries_added, qerr = _add_queries_entry(decompiled_dir)
    if qerr:
        return {"error": qerr}

    # 3. Hook the Application.
    with open(smali_file, "r", encoding="utf-8", errors="replace") as fh:
        text = fh.read()
    if MARKER in text:
        return {"ok": True, "application_class": app_class,
                "smali_file": smali_file, "bootstrap_added": not already,
                "queries_added": queries_added,
                "already_present": True,
                "note": "onCreate was already hooked; nothing to do."}
    new_text, err = _insert_into_on_create(text)
    if err:
        return {"error": err, "application_class": app_class,
                "smali_file": smali_file}
    with open(smali_file, "w", encoding="utf-8") as fh:
        fh.write(new_text)

    return {"ok": True, "application_class": app_class,
            "smali_file": smali_file, "bootstrap_added": True,
            "queries_added": queries_added,
            "already_present": False,
            "note": ("Injected. Now recompile_apk + sign_apk, and sign the "
                     "kiosk with the same key if you want the provider guarded "
                     "by signature rather than package name.")}
