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
