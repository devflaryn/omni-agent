"""Dev-gated WebView remote-debugging patch.

Roblox gates setWebContentsDebuggingEnabled behind its own dev flag (ni/b->a()),
which is false in release. We add a SECOND, independent enable that fires only
when the guest system property `omni.webview.debug` == "1" — set by omnidroid
ONLY for account-factory launches, never for customers. The property is read
with android.os.SystemProperties.get, so the page/Arkose cannot influence it and
nothing is injected into the WebView's JS. Default (prop unset) = OFF.

We insert our block at the top of the method that already references
setWebContentsDebuggingEnabled, using two fresh local registers so we never clobber
the method's own registers. Idempotent via MARKER.
"""
import glob
import os
import re

from tool_registry import registry

MARKER = "# omni-webview-debug"
TARGET_REL = os.path.join("com", "roblox", "client", "c.smali")


def _find_target(decompiled_dir):
    # Prefer the known path; fall back to any smali that enables webview debug.
    for smali_root in glob.glob(os.path.join(decompiled_dir, "smali*")):
        cand = os.path.join(smali_root, TARGET_REL)
        if os.path.isfile(cand):
            return cand
    hits = []
    for smali_root in glob.glob(os.path.join(decompiled_dir, "smali*")):
        for path in glob.glob(os.path.join(smali_root, "**", "*.smali"), recursive=True):
            with open(path, encoding="utf-8", errors="ignore") as f:
                if "setWebContentsDebuggingEnabled" in f.read():
                    hits.append(path)
    if len(hits) == 1:
        return hits[0]
    return None


def _method_span(text, idx):
    """Return (start_body, locals_line_idx, regcount) for the .method enclosing
    char offset idx. start_body is the offset just after the .locals/.registers
    directive line."""
    mstart = text.rfind("\n.method", 0, idx)
    reg_re = re.compile(r"\n[ \t]*\.(locals|registers)[ \t]+(\d+)")
    m = reg_re.search(text, mstart)
    if not m:
        return None
    return m.end(), m.start(), int(m.group(2)), m


def _find_call_offset(text, call, gate_sig="Lni/b;->a()Z"):
    """Find the offset of 'call' to anchor the patch.

    If exactly one occurrence exists, return it.
    If multiple exist, return the one in a method containing gate_sig.
    If zero or multiple methods contain gate_sig, return None and set error reason.
    """
    occurrences = []
    start = 0
    while True:
        pos = text.find(call, start)
        if pos == -1:
            break
        occurrences.append(pos)
        start = pos + 1

    if len(occurrences) == 0:
        return None, "no call found"
    if len(occurrences) == 1:
        return occurrences[0], None

    # Multiple occurrences: filter by gate_sig in method
    valid_occurrences = []
    for ci in occurrences:
        mstart = text.rfind("\n.method", 0, ci)
        mend = text.find("\n.end method", ci)
        if mstart != -1 and mend != -1:
            method_body = text[mstart:mend]
            if gate_sig in method_body:
                valid_occurrences.append(ci)

    if len(valid_occurrences) == 1:
        return valid_occurrences[0], None
    elif len(valid_occurrences) == 0:
        return None, f"found {len(occurrences)} calls but none in a method with {gate_sig}"
    else:
        return None, f"found {len(valid_occurrences)} methods with both {call} and {gate_sig} (ambiguous)"


def patch_webview_debug(decompiled_dir):
    path = _find_target(decompiled_dir)
    if not path:
        return {"patched": False, "already": False, "smali_path": None,
                "error": "no smali references setWebContentsDebuggingEnabled"}
    with open(path, encoding="utf-8") as f:
        text = f.read()
    if MARKER in text:
        return {"patched": False, "already": True, "smali_path": path}

    call = "setWebContentsDebuggingEnabled(Z)V"
    ci, find_error = _find_call_offset(text, call)
    if ci is None:
        return {"patched": False, "already": False, "smali_path": path,
                "error": find_error}

    span = _method_span(text, ci)
    if not span:
        return {"patched": False, "already": False, "smali_path": path,
                "error": "could not locate .locals/.registers for target method"}
    insert_at, _regstart, regcount, m = span

    # Bump the method's local count by 2 (we use two fresh registers).
    directive = m.group(1)           # "locals" or "registers"

    # FIX 1: Guard against 4-bit register-operand overflow
    # Instructions const/4, if-eqz, and non-range invoke-static encode register in 4 bits (v0..v15 only)
    if regcount + 1 > 15:
        return {"patched": False, "already": False, "smali_path": path,
                "error": "target method has too many locals for a 4-bit-register patch"}

    # FIX 2: Guard against .registers methods clobbering parameters
    # .registers R means R total registers including parameters (params occupy top registers)
    # .locals N means N locals only (params are separate)
    # Bumping .registers would clobber the parameter registers
    if directive == "registers":
        return {"patched": False, "already": False, "smali_path": path,
                "error": "target method uses .registers; only .locals is supported"}

    new_count = regcount + 2
    a, b = f"v{regcount}", f"v{regcount + 1}"

    block = (
        f"\n    {MARKER}\n"
        f"    const-string {a}, \"omni.webview.debug\"\n"
        f"    invoke-static {{{a}}}, Landroid/os/SystemProperties;->"
        f"get(Ljava/lang/String;)Ljava/lang/String;\n"
        f"    move-result-object {a}\n"
        f"    const-string {b}, \"1\"\n"
        f"    invoke-virtual {{{a}, {b}}}, Ljava/lang/String;->"
        f"equals(Ljava/lang/Object;)Z\n"
        f"    move-result {a}\n"
        f"    if-eqz {a}, :omni_wvd_skip\n"
        f"    const/4 {b}, 0x1\n"
        f"    invoke-static {{{b}}}, Landroid/webkit/WebView;->{call}\n"
        f"    :omni_wvd_skip\n"
    )
    # Rewrite the register directive with the higher count, then insert the block
    # right after it (top of method body → registers are guaranteed free there).
    text = (text[:m.start()] + f"\n    .{directive} {new_count}" +
            block + text[insert_at:])
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    return {"patched": True, "already": False, "smali_path": path}


registry.register(
    name="patch_webview_debug",
    description="Insert a dev-gated (omni.webview.debug=1) WebView remote-debug "
                "enable into the Roblox client's WebView-setup smali. Default OFF.",
    params_schema={
        "decompiled_dir": "string (path to the decompiled APK tree, e.g., the A2 WORK directory containing smali_classes2/)"
    }
)(patch_webview_debug)
