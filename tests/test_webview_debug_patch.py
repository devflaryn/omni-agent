import os, tempfile, textwrap, shutil
from tools.webview_debug_patch import patch_webview_debug, MARKER

SMALI = textwrap.dedent('''\
.class public Lcom/roblox/client/c;
.super Landroidx/fragment/app/Fragment;
.method public setupWebView(Landroid/webkit/WebView;)V
    .locals 4
    .param p1
    invoke-static {}, Lni/b;->a()Z
    move-result v0
    if-eqz v0, :cond_1
    invoke-static {p1}, Landroid/webkit/WebView;->setWebContentsDebuggingEnabled(Z)V
    :cond_1
    return-void
.end method
''')

def _tree(body):
    d = tempfile.mkdtemp()
    p = os.path.join(d, "smali_classes2", "com", "roblox", "client")
    os.makedirs(p)
    fp = os.path.join(p, "c.smali")
    with open(fp, "w", encoding="utf-8") as f:
        f.write(body)
    return d, fp

def test_inserts_prop_gated_call():
    d, fp = _tree(SMALI)
    try:
        res = patch_webview_debug(d)
        assert res["patched"] is True and res["already"] is False
        out = open(fp, encoding="utf-8").read()
        assert MARKER in out
        assert "omni.webview.debug" in out
        assert "Landroid/os/SystemProperties;->get" in out
        # our own call to enable debugging exists in addition to Roblox's gated one
        assert out.count("setWebContentsDebuggingEnabled(Z)V") >= 2
        # ORDER: the new call must be inside the guard (if-eqz before it, :omni_wvd_skip after it)
        marker_idx = out.find(MARKER)
        # Find the if-eqz that comes after the marker (it's in our injected block)
        idx_if_eqz = out.find("if-eqz", marker_idx)
        # Find the setWebContentsDebuggingEnabled that comes after this if-eqz (must be ours)
        idx_our_call = out.find("invoke-static {v", idx_if_eqz)
        idx_our_call = out.find("setWebContentsDebuggingEnabled", idx_our_call)
        # Find the skip label that comes after the call
        idx_skip = out.find(":omni_wvd_skip", idx_our_call)
        assert idx_if_eqz < idx_our_call < idx_skip, \
            f"Guard order broken: if-eqz@{idx_if_eqz}, our-call@{idx_our_call}, skip@{idx_skip}"
    finally:
        shutil.rmtree(d, ignore_errors=True)

def test_idempotent():
    d, fp = _tree(SMALI)
    try:
        patch_webview_debug(d)
        res2 = patch_webview_debug(d)
        assert res2["already"] is True and res2["patched"] is False
        assert open(fp, encoding="utf-8").read().count(MARKER) == 1
    finally:
        shutil.rmtree(d, ignore_errors=True)

def test_anchors_to_gated_method():
    """Two methods, both with setWebContentsDebuggingEnabled; only one has Lni/b->a() gate.
    Patch must anchor to the one with the gate, not the other."""
    SMALI_TWO_METHODS = textwrap.dedent('''\
    .class public Lcom/roblox/client/c;
    .super Landroidx/fragment/app/Fragment;
    .method public setupWebViewUngated(Landroid/webkit/WebView;)V
        .locals 2
        .param p1
        invoke-static {p1}, Landroid/webkit/WebView;->setWebContentsDebuggingEnabled(Z)V
        return-void
    .end method
    .method public setupWebViewGated(Landroid/webkit/WebView;)V
        .locals 4
        .param p1
        invoke-static {}, Lni/b;->a()Z
        move-result v0
        if-eqz v0, :cond_1
        invoke-static {p1}, Landroid/webkit/WebView;->setWebContentsDebuggingEnabled(Z)V
        :cond_1
        return-void
    .end method
    ''')
    d, fp = _tree(SMALI_TWO_METHODS)
    try:
        res = patch_webview_debug(d)
        assert res["patched"] is True and res["already"] is False
        out = open(fp, encoding="utf-8").read()
        # Marker and omni_wvd_skip should be in the gated method, not the ungated one
        assert MARKER in out
        assert ":omni_wvd_skip" in out

        # Find both method blocks
        gated_start = out.find("setupWebViewGated")
        ungated_start = out.find("setupWebViewUngated")
        gated_end = out.find(".end method", gated_start)
        ungated_end = out.find(".end method", ungated_start)
        gated_block = out[gated_start:gated_end]
        ungated_block = out[ungated_start:ungated_end]

        # Marker must be in gated, not ungated
        assert MARKER in gated_block
        assert MARKER not in ungated_block
        assert ":omni_wvd_skip" in gated_block
        assert ":omni_wvd_skip" not in ungated_block
    finally:
        shutil.rmtree(d, ignore_errors=True)

def test_rejects_too_many_locals():
    """Method with .locals 15 has regcount=15, so regcount+1=16 which is outside 4-bit range (v0..v15).
    Patch must reject this to avoid generating invalid smali."""
    SMALI_MANY_LOCALS = textwrap.dedent('''\
    .class public Lcom/roblox/client/c;
    .super Landroidx/fragment/app/Fragment;
    .method public setupWebView(Landroid/webkit/WebView;)V
        .locals 15
        .param p1
        invoke-static {}, Lni/b;->a()Z
        move-result v0
        if-eqz v0, :cond_1
        invoke-static {p1}, Landroid/webkit/WebView;->setWebContentsDebuggingEnabled(Z)V
        :cond_1
        return-void
    .end method
    ''')
    d, fp = _tree(SMALI_MANY_LOCALS)
    try:
        res = patch_webview_debug(d)
        assert res["patched"] is False and res["already"] is False
        assert "error" in res
        assert "locals" in res["error"].lower() or "register" in res["error"].lower()
        # File must be unchanged
        assert MARKER not in open(fp, encoding="utf-8").read()
    finally:
        shutil.rmtree(d, ignore_errors=True)

def test_rejects_registers_directive():
    """Method with .registers instead of .locals would have parameters in top registers.
    Bumping .registers would clobber those parameters. Patch must reject."""
    SMALI_WITH_REGISTERS = textwrap.dedent('''\
    .class public Lcom/roblox/client/c;
    .super Landroidx/fragment/app/Fragment;
    .method public setupWebView(Landroid/webkit/WebView;)V
        .registers 6
        .param p1
        invoke-static {}, Lni/b;->a()Z
        move-result v0
        if-eqz v0, :cond_1
        invoke-static {p1}, Landroid/webkit/WebView;->setWebContentsDebuggingEnabled(Z)V
        :cond_1
        return-void
    .end method
    ''')
    d, fp = _tree(SMALI_WITH_REGISTERS)
    try:
        res = patch_webview_debug(d)
        assert res["patched"] is False and res["already"] is False
        assert "error" in res
        assert ".registers" in res["error"]
        # File must be unchanged
        assert MARKER not in open(fp, encoding="utf-8").read()
    finally:
        shutil.rmtree(d, ignore_errors=True)
