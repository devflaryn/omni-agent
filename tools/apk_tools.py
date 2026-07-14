"""Android APK lifecycle tools.

Everything related to unpacking, decoding, rebuilding and re-signing APKs,
plus smali search and signature extraction. These are the core tools used by
the Android Reverse Engineer profile's "APK MODIFICATION WORKFLOW".

Reorganized out of the original ``reverse_engineering.py`` so APK tooling
lives in one focused, readable module.
"""

import base64

from tool_registry import registry
from tools.common import normalize_path, build_paginated_command, append_page_hint
from tools import cache
from docker_sandbox import run_cmd


# ---------------------------------------------------------------------------
# Unpack / decode
# ---------------------------------------------------------------------------

@registry.register(
    name="unzip_apk",
    description="Unzips an APK file to extract its raw contents (assets, lib, META-INF, etc). This is a NARROW tool, NOT the decompile path: reach for it ONLY when the task is purely adding/removing/replacing WHOLE files or folders (e.g. deleting lib/x86, lib/x86_64, lib/armeabi-v7a, or swapping a .so/asset) and you do NOT need to read or edit code. For ANYTHING involving smali, XML, the manifest, or understanding the app, do NOT unzip — use decode_apk (apktool) for editable smali/resources, or jadx_decompile for readable Java. After whole-file edits, rebuild with recompile_apk (it auto-detects a raw unzipped directory), then sign_apk.",
    params_schema={"apk_filename": "string (relative or absolute starting with /workspace)", "output_dir": "string"},
    output="The stdout/stderr of the unzip command listing every file extracted. If the APK is large this can take a moment. Returns an error dict if the APK path is wrong.",
    when_to_use="Use this ONLY for whole-file swaps (replace a .so, delete an arch folder, replace an asset) where you do NOT need to read/edit smali/XML/manifest. This is not how you reverse-engineer or patch code: for smali/resource/manifest edits use decode_apk, and to read the app's Java logic use jadx_decompile. Prefer those unless the task is literally just swapping whole files."
)
def unzip_apk(apk_filename, output_dir):
    apk_filename = normalize_path(apk_filename)
    output_dir = normalize_path(output_dir)

    # Cache: keyed purely on the APK's bytes. On a hit, the previously-extracted
    # tree is restored into output_dir (via the bind mount) so downstream tools see
    # the same files without re-running unzip. Miss/any problem -> real unzip below.
    hit = cache.lookup("unzip_apk", apk_filename, restore_dir=output_dir)
    if hit is not None:
        return hit

    cmd = f"unzip -o /workspace/{apk_filename} -d /workspace/{output_dir}"
    res = run_cmd(cmd, timeout=240)
    if isinstance(res, dict) and not res.get("error") and res.get("returncode") == 0:
        cache.store("unzip_apk", apk_filename, res, capture_dir=output_dir)
    return res


def _auto_build_code_graph(target_dir):
    """Build (or refresh) a code knowledge graph over a freshly decompiled tree.

    This is the fix for the agent forgetting to index big decompiled apps: rather
    than relying on the model to remember build_code_graph, we build it right after
    a successful decompile. That GUARANTEES the .codegraph/<graph_id>/ folder is
    created (so the Graph tab in the UI has something to render) and that
    query_code_graph works from the very next turn. Non-fatal: any failure just
    yields a note, never breaks the decompile result. Returns a short summary str.
    """
    try:
        from tools.code_graph import build_code_graph
        res = build_code_graph(target_dir, include_so=True, force=False)
        return (res.get("stdout") or res.get("error") or "(no graph output)").strip()
    except Exception as e:  # never let graph bootstrap break the decompile
        return f"(auto code-graph build skipped due to an error: {e})"


def _append_graph_note(res, target_dir, kind):
    """Append the auto-built graph summary to a decompile result's stdout."""
    note = _auto_build_code_graph(target_dir)
    banner = (
        f"\n\n=== AUTO CODE-GRAPH BUILD ({kind}) ===\n"
        "A knowledge graph was built automatically so you can navigate this app with "
        "query_code_graph (search_classes / string_refs / callers / callees / hierarchy) "
        "and read_file_chunk ONLY the exact slices it points to — do NOT sweep the "
        "decompiled files one-by-one. It also populates the UI's Graph tab.\n"
        + note
    )
    if isinstance(res, dict):
        res["stdout"] = (res.get("stdout") or "") + banner
    return res


def _output_has_smali(output_dir):
    """True when apktool produced at least one ``smali*/`` directory in
    output_dir — the marker of a successful SOURCE decode (baksmali). A
    res-only folder (resource decoding threw before sources were disassembled)
    has none, so this is how we tell a full decode from a partial one."""
    res = run_cmd(f"ls -d /workspace/{output_dir}/smali* 2>/dev/null | head -1", timeout=20)
    return bool((res.get("stdout") or "").strip())


@registry.register(
    name="decode_apk",
    description="Decodes an APK with apktool (apktool's `d`/decode command) to get readable AndroidManifest.xml and smali source code. This is the PRIMARY tool for editing an app: use it whenever you need to read or edit smali, XML resources, or AndroidManifest.xml. For whole-file edits (lib folders, assets, .so files) use unzip_apk instead; to read the app's logic as Java use jadx_decompile. It ALWAYS produces the full smali code tree: if apktool can't decode the APK's resources (some apps use a shared-library resource package that makes apktool abort mid-resource-decode, leaving only res/), it automatically re-runs with resource decoding disabled so you still get complete smali. By default it AUTO-BUILDS a code knowledge graph over the output so you can immediately query_code_graph instead of reading smali one-by-one (set auto_graph=false to skip).",
    params_schema={"apk_filename": "string", "output_dir": "string", "no_resources": "boolean (optional, set to true to skip resource decoding up front — faster, and avoids resource-decode errors; you still get full smali + manifest/resources in raw form)", "auto_graph": "boolean (optional, default true — build a code knowledge graph over the decompiled output automatically so query_code_graph works right away and the UI Graph tab is populated)"},
    output="apktool's decompile log. On success the output_dir contains a smali/ tree (plus smali_classes2/ … for multidex), AndroidManifest.xml, res/, and apktool.yml. If resource decoding failed and it fell back to -r, a NOTE says so — you still get the full smali tree, but AndroidManifest.xml and res/ are left in raw form (read them with jadx_decompile). Can take several minutes on large APKs. Unless auto_graph=false, a code knowledge graph is then built automatically and its summary appended — navigate with query_code_graph, do NOT read smali files one by one.",
    when_to_use="Use this when you need to READ or EDIT Dalvik bytecode (smali), AndroidManifest.xml, or XML resources. If you only need to swap/delete whole files (like .so libs), unzip_apk is much faster. The graph is built for you automatically, so after this just call query_code_graph."
)
def decode_apk(apk_filename, output_dir, no_resources=False, auto_graph=True):
    apk_filename = normalize_path(apk_filename)
    output_dir = normalize_path(output_dir)
    want_no_res = no_resources in (True, "true", "True", 1, "1")

    def _decode(no_res):
        res_flag = "-r " if no_res else ""
        cmd = f"apktool d {res_flag}-f /workspace/{apk_filename} -o /workspace/{output_dir}"
        return run_cmd(cmd, timeout=600)  # apktool on large APKs can take several minutes

    # Cache: apktool decode is a pure function of the APK bytes + whether
    # resources are decoded, and it can take minutes — so key on those. `output_dir`
    # is NOT part of the key (it only changes WHERE the tree lands); auto_graph is
    # NOT either (the graph is (re)built below for both hit and miss). On a hit the
    # smali tree is restored into output_dir so recompile/search/read work as usual.
    extra = {"no_resources": want_no_res}
    hit = cache.lookup("decode_apk", apk_filename, extra, restore_dir=output_dir)
    if hit is not None:
        res = hit
        has_smali = _output_has_smali(output_dir)
    else:
        res = _decode(want_no_res)

        # A full decode MUST leave a smali*/ tree. Some APKs (notably ones using an
        # AAPT2 shared-library resource package — e.g. Roblox's
        # com.roblox.client.personasdk at pkgId 0x87) make apktool throw DURING
        # resource decoding; because it decodes resources BEFORE sources, it aborts
        # with only res/ and NO smali. That's the intermittent "res-only" folder.
        # When we attempted resource decoding and got no smali, retry with resource
        # decoding disabled (-r): baksmali then runs and produces the complete smali
        # tree (with AndroidManifest.xml/resources kept in raw form).
        fell_back = False
        if not want_no_res and not _output_has_smali(output_dir):
            fell_back = True
            res = _decode(True)

        if not isinstance(res, dict):
            return res
        has_smali = _output_has_smali(output_dir)

        if fell_back and has_smali:
            res["stdout"] = (res.get("stdout") or "") + (
                "\n\n=== NOTE: decoded WITHOUT resources (-r fallback) ===\n"
                "apktool could not decode this APK's resources (it uses a shared-library "
                "resource package - common in Roblox and runtime-resource-overlay apps), which "
                "aborts the whole decode and leaves only res/. To still give you the full code, "
                "the APK was re-decoded with resource decoding disabled: you now have the COMPLETE "
                "smali tree, but AndroidManifest.xml and res/ are in raw (binary) form. Edit smali "
                "normally and rebuild with recompile_apk. To READ the decoded manifest/resources, use "
                "jadx_decompile.\n"
            )
        elif not has_smali:
            res["stdout"] = (res.get("stdout") or "") + (
                "\n\n=== WARNING: no smali was produced ===\n"
                "Even after retrying with resource decoding disabled, apktool created no smali*/ "
                "tree. The APK may contain no Dalvik bytecode (a resource-only or native-only split "
                "APK), or apktool failed on it — see the log above. For a code view, try jadx_decompile.\n"
            )

        # Only cache a REAL decode that actually produced a smali tree. The stored
        # stdout excludes the graph note (added below), since the graph is rebuilt
        # per call against the restored output_dir.
        if has_smali:
            cache.store("decode_apk", apk_filename, res, extra, capture_dir=output_dir)

    if auto_graph in (True, "true", "True", 1, "1") and has_smali:
        res = _append_graph_note(res, output_dir, "smali")
    return res


@registry.register(
    name="jadx_decompile",
    description=(
        "Decompiles an APK (or a .dex/.jar) to READABLE JAVA source using jadx. "
        "This is for UNDERSTANDING code, not for rebuilding — jadx Java is much easier to read than smali, "
        "especially in large or obfuscated apps. Use it to reverse-engineer app logic, then make the actual "
        "edit in smali via decode_apk + patch_smali_method (you cannot recompile jadx's Java back into the APK). "
        "Set deobf=true to have jadx rename obfuscated a/b/c identifiers to stable readable names — very helpful on "
        "R8/ProGuard-obfuscated apps. Output goes to output_dir/sources (Java) and output_dir/resources. "
        "Read individual .java files with read_file_chunk, or search across them with grep_directory / find_files."
    ),
    params_schema={
        "apk_filename": "string (path to the APK/.dex/.jar, relative or absolute starting with /workspace)",
        "output_dir": "string (directory to write decompiled Java + resources to)",
        "deobf": "boolean (optional, default false; true renames obfuscated identifiers to stable readable names)",
        "no_resources": "boolean (optional, default false; true skips resource decoding for a faster, Java-only run)",
        "single_class": "string (optional; decompile only this fully-qualified class, e.g. 'com.example.Foo', for a fast targeted look)",
        "auto_graph": "boolean (optional, default true — build a code knowledge graph over the decompiled Java automatically so search_java/query_code_graph work right away and the UI Graph tab is populated. Automatically skipped for single_class runs.)"
    },
    output="jadx's decompile log (it keeps going past individual class errors, which is normal for obfuscated apps). The output_dir gets a 'sources/' tree of .java files (by package) and, unless no_resources, a 'resources/' tree. Can take several minutes on large APKs; the first pass is the slow one. Unless auto_graph=false or single_class was used, a code knowledge graph is then built automatically and its summary appended.",
    when_to_use="Use this to READ an app's Java/Kotlin logic when smali is too tedious — tracing a feature, understanding an obfuscated check, or getting oriented in a large codebase. Pair with search_java to search the Java. For the edit itself, still use decode_apk (smali) + recompile_apk, since jadx output isn't recompilable."
)
def jadx_decompile(apk_filename, output_dir, deobf=False, no_resources=False, single_class=None, auto_graph=True):
    apk_filename = normalize_path(apk_filename)
    output_dir = normalize_path(output_dir)
    deobf_on = deobf in (True, "true", "True", 1, "1")
    nores_on = no_resources in (True, "true", "True", 1, "1")
    # Graph is skipped for a single-class run (nothing to index) — otherwise auto-built.
    want_graph = auto_graph in (True, "true", "True", 1, "1") and not single_class

    # Cache: jadx output is a pure function of the APK bytes + these flags, and the
    # first pass is the slow one. Key on them (not output_dir / auto_graph). On a hit
    # the decompiled tree is restored into output_dir; the graph is rebuilt below.
    extra = {"deobf": deobf_on, "no_resources": nores_on, "single_class": single_class or None}
    hit = cache.lookup("jadx_decompile", apk_filename, extra, restore_dir=output_dir)
    if hit is not None:
        if want_graph:
            hit = _append_graph_note(hit, output_dir, "java")
        return hit

    flags = []
    if deobf_on:
        flags.append("--deobf")
    if nores_on:
        flags.append("--no-res")
    if single_class:
        # jadx matches on the fully-qualified class name; keep it as-is.
        flags.append(f"--single-class {single_class}")
    flag_str = (" ".join(flags) + " ") if flags else ""
    # --show-bad-code keeps partially-decompiled methods instead of dropping them,
    # which matters on obfuscated apps where some methods fail to fully decompile.
    cmd = (
        f"jadx {flag_str}--show-bad-code -d /workspace/{output_dir} /workspace/{apk_filename}"
    )
    res = run_cmd(cmd, timeout=600)
    ok = isinstance(res, dict) and not res.get("error") and res.get("returncode") == 0
    if ok:
        cache.store("jadx_decompile", apk_filename, res, extra, capture_dir=output_dir)
    if want_graph and ok:
        res = _append_graph_note(res, output_dir, "java")
    return res


# ---------------------------------------------------------------------------
# Rebuild / sign
# ---------------------------------------------------------------------------

def _zip_repack(input_dir, output_apk):
    """Repack a RAW extracted APK tree (from unzip_apk — no apktool.yml) into an
    unsigned APK with zip. Folded in from the former repack_apk tool so that
    recompile_apk is the single rebuild entry point for BOTH apktool-decoded
    directories and raw unzip_apk directories. `input_dir`/`output_apk` are
    already normalized by the caller (recompile_apk)."""
    cmd = (
        f"cd /workspace/{input_dir} && "
        # Remove old signatures so apksigner doesn't clash or fail
        "rm -f META-INF/*.RSA META-INF/*.SF META-INF/*.DSA META-INF/MANIFEST.MF && "
        # Build a fresh APK with correct compression: store uncompressed the file types Android requires uncompressed
        f"zip -r -X /workspace/{output_apk} . -x '*.DS_Store' '*.so' '*.arsc' '*.png' '*.jpg' '*.jpeg' '*.webp' '*.mp3' '*.mp4' '*.ogg' '*.wav' && "
        f"zip -r -X -0 /workspace/{output_apk} . -i '*.so' '*.arsc' '*.png' '*.jpg' '*.jpeg' '*.webp' '*.mp3' '*.mp4' '*.ogg' '*.wav'"
    )
    return run_cmd(cmd, timeout=240)


# Ensures apktool.yml keeps the memory-map-sensitive / already-compressed file
# types STORED (uncompressed) on rebuild. resources.arsc MUST be uncompressed on
# Android O+ (it's mmap'd zero-copy) and .so should stay stored when
# extractNativeLibs=false; the rest are the AOSP aapt "no-compress" defaults that
# are pointless to deflate and only bloat the APK. Path is substituted, not
# f-string-formatted, so the braces below survive.
_APKTOOL_YML_PATCH = r'''
import sys
p = "/workspace/__YMLPATH__"
required = ["resources.arsc", "arsc", "so", "png", "jpg", "jpeg", "gif", "webp", "bmp",
            "wav", "mp2", "mp3", "ogg", "aac", "mpg", "mpeg", "mid", "midi", "smf", "jet",
            "rtttl", "imy", "xmf", "mp4", "m4a", "m4v", "3gp", "3gpp", "3g2", "3gpp2",
            "amr", "awb", "wma", "wmv", "webm", "mkv"]
with open(p, encoding="utf-8") as f:
    lines = f.read().splitlines()
out, i, existing, found = [], 0, [], False
while i < len(lines):
    l = lines[i]
    if l.strip().startswith("doNotCompress:"):
        found = True
        i += 1
        while i < len(lines) and lines[i].lstrip().startswith("- "):
            existing.append(lines[i].strip()[2:].strip())
            i += 1
        merged = list(existing)
        added = 0
        for r in required:
            if r not in merged:
                merged.append(r); added += 1
        out.append("doNotCompress:")
        for e in merged:
            out.append("- " + e)
        print("doNotCompress: kept " + str(len(existing)) + " existing, added " + str(added) + " (total " + str(len(merged)) + ")")
        continue
    out.append(l)
    i += 1
if not found:
    out.append("doNotCompress:")
    for r in required:
        out.append("- " + r)
    print("doNotCompress: block was missing, created with " + str(len(required)) + " entries")
with open(p, "w", encoding="utf-8") as f:
    f.write("\n".join(out) + "\n")
'''


@registry.register(
    name="recompile_apk",
    description=(
        "Rebuilds an APK from a directory produced by EITHER decode_apk (apktool — the directory contains "
        "apktool.yml) OR unzip_apk (a raw extracted tree — no apktool.yml). It AUTO-DETECTS which kind of "
        "directory it is: with apktool.yml it runs apktool build; without it, it repacks the raw tree with zip. "
        "This is THE single tool to rebuild after any edit — it replaces the old build_apk and repack_apk. "
        "Either way it EXPLICITLY PRESERVES the compression of the files that matter — resources.arsc and native "
        ".so libraries (plus the usual already-compressed media types) are kept STORED (uncompressed), not "
        "re-deflated — because recompressing resources.arsc breaks Android O+'s zero-copy mmap (the app crashes "
        "at load) and needlessly deflating .so/media bloats the APK. On the apktool path it does this by "
        "normalizing apktool.yml's doNotCompress list before invoking apktool, then reports the resulting "
        "compression so you can confirm. Output is UNSIGNED — call sign_apk (then verify_apk) next."
    ),
    params_schema={
        "input_dir": "string (a decode_apk directory with apktool.yml, OR a raw unzip_apk directory)",
        "output_apk": "string (output apk filename)",
        "use_aapt2": "boolean (optional, default true — apktool path only: build with aapt2, which handles arsc/resources more reliably)",
        "original_apk": "string (optional — apktool path only: path to the original APK; if given, the size of the rebuilt APK is compared against it to flag unexpected bloat)"
    },
    output="For a decode_apk directory: the doNotCompress normalization result, apktool's build log, a compression summary for resources.arsc and each .so (Stored vs Defl), and — if original_apk was given — a size comparison. For a raw unzip_apk directory: the zip repack log (old META-INF signatures stripped, mmap-sensitive types kept stored). Either way the output is UNSIGNED; call sign_apk next.",
    when_to_use="Use this to rebuild an APK AFTER editing — it handles BOTH decode_apk directories (smali/resources/manifest edits) and raw unzip_apk directories (whole-file swaps), auto-selecting apktool build vs zip repack from the directory. It is compression-safe by default (no mmap/load crashes or size bloat). Then sign_apk (and verify_apk)."
)
def recompile_apk(input_dir, output_apk, use_aapt2=True, original_apk=None):
    input_dir = normalize_path(input_dir)
    output_apk = normalize_path(output_apk)

    # Auto-detect the directory type. apktool-decoded dirs carry apktool.yml and
    # must be rebuilt with `apktool b`; a raw unzip_apk tree has none, so it is
    # repacked with zip (the former repack_apk path, folded into _zip_repack).
    # This keeps unzip_apk's whole-file-swap workflow working now that the
    # separate repack_apk tool is gone.
    check = run_cmd(f"test -f /workspace/{input_dir}/apktool.yml", timeout=10)
    if check["returncode"] != 0:
        return _zip_repack(input_dir, output_apk)

    # 1) Normalize doNotCompress so the mmap-sensitive/media types stay stored.
    patch_script = _APKTOOL_YML_PATCH.replace("__YMLPATH__", f"{input_dir}/apktool.yml")
    b64 = base64.b64encode(patch_script.encode("utf-8")).decode("ascii")
    aapt2_flag = "--use-aapt2 " if use_aapt2 in (True, "true", "True", 1, "1") else ""
    size_cmp = ""
    if original_apk:
        orig = normalize_path(original_apk)
        size_cmp = (
            f' && echo "--- SIZE COMPARISON ---" '
            f'&& echo "original: $(stat -c%s /workspace/{orig} 2>/dev/null || echo ?) bytes" '
            f'&& echo "rebuilt:  $(stat -c%s /workspace/{output_apk} 2>/dev/null || echo ?) bytes"'
        )

    cmd = (
        f"echo '{b64}' | base64 -d | python3 - && "
        f"echo '--- APKTOOL BUILD ---' && "
        f"apktool b {aapt2_flag}/workspace/{input_dir} -o /workspace/{output_apk} && "
        f"echo '--- COMPRESSION SUMMARY (Stored = uncompressed, good for arsc/.so) ---' && "
        f"unzip -v /workspace/{output_apk} 2>/dev/null | grep -E 'resources\\.arsc|\\.so' | "
        f"awk '{{print $8\"  method=\"$2\"  length=\"$1\" bytes\"}}' | head -n 40"
        f"{size_cmp}"
    )
    return run_cmd(cmd, timeout=360)


@registry.register(
    name="sign_apk",
    description=(
        "Zipaligns and signs an APK using apksigner with a default debug keystore. "
        "Call this AFTER recompile_apk to produce a runnable APK. "
        "Uses v1+v2+v3 signing schemes for maximum Android version compatibility. "
        "IMPORTANT: After signing, ALWAYS call verify_apk to confirm the APK is valid before reporting it as done."
    ),
    params_schema={"apk_filename": "string (path to the built apk)"},
    output="The zipalign + apksigner command logs. On success the APK is signed and ready to install. A debug keystore is auto-created if none exists.",
    when_to_use="ALWAYS call this after recompile_apk to make the APK installable. Follow it with verify_apk to confirm validity."
)
def sign_apk(apk_filename):
    apk_filename = normalize_path(apk_filename)

    cmd = (
        f"zipalign -p -f 4 /workspace/{apk_filename} /workspace/{apk_filename}.aligned && "
        f"mv /workspace/{apk_filename}.aligned /workspace/{apk_filename} && "
        "if [ ! -f /workspace/debug.keystore ]; then "
        "keytool -genkey -v -keystore /workspace/debug.keystore -alias androiddebugkey "
        "-storepass android -keypass android -keyalg RSA -keysize 2048 -validity 10000 "
        "-dname \"CN=Android Debug,O=Android,C=US\"; "
        "fi && "
        f"apksigner sign --ks /workspace/debug.keystore --ks-pass pass:android --key-pass pass:android "
        f"--v1-signing-enabled true --v2-signing-enabled true --v3-signing-enabled true "
        f"/workspace/{apk_filename}"
    )
    return run_cmd(cmd, timeout=60)


@registry.register(
    name="verify_apk",
    description=(
        "Verifies that an APK is properly signed and zip-aligned. ALWAYS call this after sign_apk "
        "before reporting the APK as done. Checks: (1) apksigner signature verification, "
        "(2) zipalign alignment check, (3) presence of required files (AndroidManifest.xml, classes.dex, resources.arsc). "
        "If any check fails, the APK will crash on launch — fix the issue before delivering."
    ),
    params_schema={"apk_filename": "string (path to the apk to verify)"},
    output="Three check sections (signature, zipalign, required-files) each with PASS/FAIL, plus a SUMMARY line: 'ALL CHECKS PASSED' or 'ONE OR MORE CHECKS FAILED'. Read the summary to decide if the APK is ready.",
    when_to_use="ALWAYS call this after sign_apk before reporting the APK as done. If any check fails the APK will crash on launch — fix the issue first."
)
def verify_apk(apk_filename):
    apk_filename = normalize_path(apk_filename)
    results = []

    # 1. Signature verification
    sig_cmd = f"apksigner verify --verbose /workspace/{apk_filename}"
    sig_res = run_cmd(sig_cmd, timeout=30)
    results.append("=== SIGNATURE VERIFICATION ===")
    if sig_res["returncode"] == 0:
        results.append("PASS: " + sig_res.get("stdout", "").strip())
    else:
        results.append("FAIL: " + sig_res.get("stderr", "").strip() or sig_res.get("stdout", "").strip())

    # 2. Zipalign check
    align_cmd = f"zipalign -c -v 4 /workspace/{apk_filename}"
    align_res = run_cmd(align_cmd, timeout=30)
    results.append("\n=== ZIPALIGN CHECK ===")
    if align_res["returncode"] == 0:
        results.append("PASS: APK is properly zip-aligned")
    else:
        # zipalign -c outputs unaligned files to stderr
        unaligned = align_res.get("stderr", "").strip()
        results.append("FAIL: APK has alignment issues:\n" + unaligned[:2000])

    # 3. Required files check
    list_cmd = f"unzip -l /workspace/{apk_filename}"
    list_res = run_cmd(list_cmd, timeout=30)
    results.append("\n=== REQUIRED FILES CHECK ===")
    listing = list_res.get("stdout", "")
    required = ["AndroidManifest.xml", "classes.dex", "resources.arsc"]
    for req in required:
        if req in listing:
            results.append(f"  PASS: {req} found")
        else:
            results.append(f"  FAIL: {req} MISSING — APK will crash!")

    # Summary
    all_pass = (sig_res["returncode"] == 0 and align_res["returncode"] == 0
                and all(r in listing for r in required))
    results.append("\n=== SUMMARY ===")
    results.append("ALL CHECKS PASSED — APK is valid and should launch." if all_pass
                   else "ONE OR MORE CHECKS FAILED — fix issues before delivering the APK.")

    return {"stdout": "\n".join(results)}


@registry.register(
    name="inspect_apk",
    description=(
        "Lists the contents of an APK file (like unzip -l) with file sizes and compression info. "
        "Use this to check what files are inside an APK, verify DEX/native lib presence, "
        "or understand the APK structure before modifying it."
    ),
    params_schema={
        "apk_filename": "string (path to the apk)",
        "filter_pattern": "string (optional, show only files matching this substring, e.g. '.dex' or '.so')"
    },
    output="A table (unzip -l format) listing every file inside the APK with its size and compression ratio. If filter_pattern is set, only matching files are shown.",
    when_to_use="Use this to check what files are inside an APK, verify DEX/native lib presence, or understand the APK structure before deciding whether to unzip or decompile."
)
def inspect_apk(apk_filename, filter_pattern=None):
    apk_filename = normalize_path(apk_filename)

    # Cache: `unzip -l` output is a pure function of the APK's bytes (+ the filter).
    extra = {"filter_pattern": filter_pattern or None}
    hit = cache.lookup("inspect_apk", apk_filename, extra)
    if hit is not None:
        return hit

    base = f"unzip -l /workspace/{apk_filename}"
    if filter_pattern:
        base += f" | grep -i '{filter_pattern}'"
    res = run_cmd(base, timeout=30)
    if res["returncode"] == 0 or res.get("stdout"):
        out = {"stdout": f"=== Contents of {apk_filename} ===\n" + res.get("stdout", "")}
        cache.store("inspect_apk", apk_filename, out, extra)
        return out
    return res


# File types that MUST stay STORED (uncompressed) when written into an APK:
# resources.arsc is mmap'd zero-copy on Android O+, and .so libs are mmap'd when
# extractNativeLibs=false. Re-deflating either crashes the app at load. Anything
# with one of these extensions is added with `zip -0`.
_APK_STORED_EXTS = (".arsc", ".so", ".png", ".jpg", ".jpeg", ".webp", ".gif",
                    ".mp3", ".mp4", ".ogg", ".wav", ".m4a", ".webm", ".mkv")


@registry.register(
    name="replace_file_in_apk",
    description=(
        "Replaces (or adds) a SINGLE entry inside an existing APK/zip in place, without unzipping and "
        "repacking the whole archive — the fast way to swap one file: a patched classes.dex, a native .so, "
        "an asset, or a config. Give the APK, the entry path AS IT APPEARS INSIDE THE APK "
        "(e.g. 'classes.dex', 'lib/arm64-v8a/libfoo.so', 'assets/config.json'), and the workspace path of "
        "the replacement file. The tool stages the replacement at the correct internal path and updates just "
        "that entry, keeping the memory-map-sensitive types (resources.arsc, .so, images, media) STORED "
        "(uncompressed) so the app still loads. It strips the old signature, so the APK becomes UNSIGNED — "
        "call sign_apk (then verify_apk) next."
    ),
    params_schema={
        "apk_filename": "string (path to the APK to modify in place, relative to /workspace)",
        "entry_path": "string (the path of the entry INSIDE the APK to replace/add, e.g. 'classes.dex' or 'lib/arm64-v8a/libfoo.so')",
        "replacement_file": "string (workspace path of the file whose contents should become that entry)"
    },
    output="A confirmation naming the entry replaced and whether it was stored or deflated, followed by that entry's line from `unzip -l` so you can confirm the new size. The APK is left UNSIGNED — sign_apk next. Errors clearly if the APK or replacement file is missing.",
    when_to_use="Use this to swap ONE file inside an APK (a rebuilt .dex, a patched .so, a changed asset) instead of unzip_apk + recompile_apk on the whole archive. For many-file edits, or smali/resource edits, use decode_apk (or unzip_apk) + recompile_apk. Always sign_apk + verify_apk afterwards."
)
def replace_file_in_apk(apk_filename, entry_path, replacement_file):
    apk_filename = normalize_path(apk_filename)
    replacement_file = normalize_path(replacement_file)
    # The entry path is relative *inside* the zip; keep it clean but don't route it
    # through normalize_path (which would strip a leading '/workspace' it never has).
    entry = (entry_path or "").strip().lstrip("/")
    if not entry:
        return {"error": "entry_path must name a file inside the APK, e.g. 'classes.dex'."}

    stored = entry.lower().endswith(_APK_STORED_EXTS)
    store_flag = "-0 " if stored else ""
    # Stage the replacement at a temp root under the exact internal entry path, then
    # `zip` that one entry into the APK (zip updates the entry if it already exists,
    # adds it otherwise). Old META-INF signatures are removed since the APK must be
    # re-signed anyway. Finally echo the entry's `unzip -l` line back for confirmation.
    cmd = (
        f"set -e; "
        f"if [ ! -f /workspace/{apk_filename} ]; then echo 'ERROR: APK not found: /workspace/{apk_filename}'; exit 1; fi; "
        f"if [ ! -f /workspace/{replacement_file} ]; then echo 'ERROR: replacement file not found: /workspace/{replacement_file}'; exit 1; fi; "
        f"STAGE=$(mktemp -d); "
        f"mkdir -p \"$STAGE/$(dirname '{entry}')\"; "
        f"cp /workspace/{replacement_file} \"$STAGE/{entry}\"; "
        f"APK=$(readlink -f /workspace/{apk_filename}); "
        f"( cd \"$STAGE\" && zip {store_flag}-X \"$APK\" '{entry}' >/dev/null ); "
        f"zip -d \"$APK\" 'META-INF/*.RSA' 'META-INF/*.SF' 'META-INF/*.DSA' 'META-INF/MANIFEST.MF' >/dev/null 2>&1 || true; "
        f"rm -rf \"$STAGE\"; "
        f"echo \"Replaced entry '{entry}' in {apk_filename} ({'STORED/uncompressed' if stored else 'deflated'}). APK is now UNSIGNED — run sign_apk next.\"; "
        f"echo '--- entry in APK now ---'; "
        f"unzip -l \"$APK\" '{entry}' | sed -n '3,4p'"
    )
    return run_cmd(cmd, timeout=120)


# ---------------------------------------------------------------------------
# Smali search / signature extraction
# ---------------------------------------------------------------------------

@registry.register(
    name="search_smali",
    description=(
        "Recursively searches all .smali files under a decompiled APK directory for an EXTENDED-regex pattern "
        "and returns ONLY the matching line snippets (with file:line), never whole files — so it stays cheap on "
        "context even across thousands of smali files. "
        "Uses extended regex, so alternation works: pattern='verify|checksum|GET_SIGNATURES'. "
        "Use this to find signature verification code, anti-tamper checks, or any Dalvik bytecode reference. "
        "Common patterns: 'getPackageManager', 'GET_SIGNATURES', 'signatures', 'PackageManager', 'verify', "
        "'certificate', 'checksum', 'integrity'. Paginate large result sets with skip."
    ),
    params_schema={
        "decompiled_dir": "string (path to the apktool-decompiled directory, relative to /workspace)",
        "pattern": "string (EXTENDED regex; '|' alternation supported, e.g. 'verify|checksum')",
        "max_results": "integer (optional, max matching lines to return, default 50)",
        "skip": "integer (optional, matches to skip for pagination, default 0)",
        "case_insensitive": "boolean (optional, default false — smali is case-sensitive bytecode, so exact case usually matters)"
    },
    output="Each matching line as 'filepath:line_number: <matching smali line>'. Capped at max_results; a pagination hint gives the next skip value when more matches exist. If nothing matches it says '(no matches found)' — that is normal, not an error.",
    when_to_use="Use this to find signature verification code, anti-tamper checks, API calls, or any Dalvik bytecode pattern across all smali files. For Java/Kotlin (jadx) trees use search_java; for a single known file use grep_file; for arbitrary file types use grep_directory."
)
def search_smali(decompiled_dir, pattern, max_results=50, skip=0, case_insensitive=False):
    decompiled_dir = normalize_path(decompiled_dir)
    ci = "-i " if case_insensitive in (True, "true", "True", 1, "1") else ""
    # -E so alternation (verify|checksum) works; --include restricts to smali.
    base = f"grep -rnE {ci}--include='*.smali' '{pattern}' /workspace/{decompiled_dir}"
    cmd = build_paginated_command(base, max_lines=max_results, skip=skip)
    res = run_cmd(cmd, timeout=120)
    if res.get("returncode") == 0 or res.get("stdout"):
        out = f"--- search_smali '{pattern}' in {decompiled_dir} ---\n"
        out += res.get("stdout", "") or "(no matches found)\n"
        res["stdout"] = out
        return append_page_hint(res, skip, max_results)
    if res.get("returncode") == 1:
        return {"stdout": f"--- search_smali '{pattern}' in {decompiled_dir} ---\n(no matches found)\n"}
    return res


@registry.register(
    name="search_java",
    description=(
        "Recursively searches decompiled JAVA/KOTLIN source (a jadx 'sources' tree, or any .java/.kt files) "
        "for an EXTENDED-regex pattern and returns ONLY the matching line snippets (with file:line), never whole "
        "files — the readable-source counterpart to search_smali, and far cheaper on context than reading classes. "
        "Uses extended regex so alternation works: pattern='checkSignature|X509|MessageDigest'. "
        "Great for tracing app logic after jadx_decompile: find where a URL, license flag, crypto call, or "
        "obfuscated check lives, then read_file_chunk only that slice. Paginate with skip."
    ),
    params_schema={
        "decompiled_dir": "string (directory of jadx Java output, relative to /workspace, e.g. 'app_jadx/sources')",
        "pattern": "string (EXTENDED regex; '|' alternation supported)",
        "max_results": "integer (optional, max matching lines to return, default 50)",
        "skip": "integer (optional, matches to skip for pagination, default 0)",
        "case_insensitive": "boolean (optional, default false)"
    },
    output="Each matching line as 'filepath:line_number: <matching source line>'. Capped at max_results; a pagination hint gives the next skip value when more matches exist. If nothing matches it says '(no matches found)'.",
    when_to_use="Use this after jadx_decompile to search readable Java/Kotlin for logic (URLs, flags, crypto, checks). For smali bytecode use search_smali; for mixed file types (XML, assets, JSON) use grep_directory; for one known file use grep_file."
)
def search_java(decompiled_dir, pattern, max_results=50, skip=0, case_insensitive=False):
    decompiled_dir = normalize_path(decompiled_dir)
    ci = "-i " if case_insensitive in (True, "true", "True", 1, "1") else ""
    # Search both Java and Kotlin sources produced by jadx / other decompilers.
    base = (
        f"grep -rnE {ci}--include='*.java' --include='*.kt' "
        f"'{pattern}' /workspace/{decompiled_dir}"
    )
    cmd = build_paginated_command(base, max_lines=max_results, skip=skip)
    res = run_cmd(cmd, timeout=120)
    if res.get("returncode") == 0 or res.get("stdout"):
        out = f"--- search_java '{pattern}' in {decompiled_dir} ---\n"
        out += res.get("stdout", "") or "(no matches found)\n"
        res["stdout"] = out
        return append_page_hint(res, skip, max_results)
    if res.get("returncode") == 1:
        return {"stdout": f"--- search_java '{pattern}' in {decompiled_dir} ---\n(no matches found)\n"}
    return res


@registry.register(
    name="get_apk_signature_hash",
    description=(
        "Extracts the original APK's certificate fingerprint (SHA1/SHA256 hash) from the META-INF/*.RSA file. "
        "Use this BEFORE modifying an APK to save the original signature. "
        "The original hash can help locate signature verification code when searching in smali or native libraries."
    ),
    params_schema={"apk_path": "string (path to the original APK)"},
    output="The keytool certificate dump: owner, issuer, serial number, validity dates, and SHA1/SHA256 fingerprints of the signing certificate. This is the original developer's signature fingerprint.",
    when_to_use="Call this BEFORE modifying an APK to record the original signature fingerprint. You can then search smali/native code for checks that compare against this hash to find anti-tamper logic."
)
def get_apk_signature_hash(apk_path):
    apk_path = normalize_path(apk_path)

    # Cache: the signing certificate is fixed in the APK's bytes, so its fingerprint
    # is a pure function of the file — safe to serve from cache on a hash match.
    hit = cache.lookup("get_apk_signature_hash", apk_path)
    if hit is not None:
        return hit

    cmd = (
        f"cd /tmp && "
        f"unzip -o /workspace/{apk_path} 'META-INF/*.RSA' -d /tmp/sig_extract >/dev/null 2>&1 && "
        f"keytool -printcert -file /tmp/sig_extract/META-INF/*.RSA 2>/dev/null && "
        f"rm -rf /tmp/sig_extract"
    )
    res = run_cmd(cmd, timeout=30)
    if isinstance(res, dict) and not res.get("error") and res.get("returncode") == 0 and res.get("stdout"):
        cache.store("get_apk_signature_hash", apk_path, res)
    return res


# ---------------------------------------------------------------------------
# Manifest parsing
# ---------------------------------------------------------------------------

# Runs inside the sandbox. Handles BOTH a decoded (plain-text) AndroidManifest.xml
# from decode_apk AND a raw .apk (binary manifest decoded via aapt/aapt2). The
# path is substituted in (not f-string-formatted) so the many braces/backslashes
# below survive untouched.
_MANIFEST_SCRIPT = r'''
import sys, re, subprocess
import xml.etree.ElementTree as ET

path = "/workspace/__FILEPATH__"
AND = "{http://schemas.android.com/apk/res/android}"

def resolve(pkg, name):
    if not name:
        return name
    if name.startswith("."):
        return pkg + name
    if "." not in name:
        return pkg + "." + name
    return name

def emit(pkg, app_class, launchers, perms, vname, vcode, min_sdk, target_sdk, source):
    print("=== AndroidManifest info (" + source + ") ===")
    print("package: " + (pkg or "(not found)"))
    if app_class:
        print("application_class: " + resolve(pkg, app_class))
    else:
        print("application_class: (none declared -> default android.app.Application)")
    uniq = []
    for l in launchers:
        r = resolve(pkg, l)
        if r and r not in uniq:
            uniq.append(r)
    if uniq:
        print("launcher_activity: " + uniq[0])
        if len(uniq) > 1:
            print("other_launchers: " + ", ".join(uniq[1:]))
    else:
        print("launcher_activity: (none found - no MAIN/LAUNCHER intent-filter)")
    if vname or vcode:
        print("version: " + str(vname) + " (code " + str(vcode) + ")")
    if min_sdk or target_sdk:
        print("sdk: min=" + str(min_sdk) + " target=" + str(target_sdk))
    print("permissions: " + str(len(perms)))
    for p in perms[:40]:
        print("  - " + p)
    if len(perms) > 40:
        print("  ... (+" + str(len(perms) - 40) + " more)")

def parse_text_xml():
    root = ET.parse(path).getroot()
    pkg = root.get("package", "")
    vname = root.get(AND + "versionName", "")
    vcode = root.get(AND + "versionCode", "")
    min_sdk = target_sdk = ""
    us = root.find("uses-sdk")
    if us is not None:
        min_sdk = us.get(AND + "minSdkVersion", "")
        target_sdk = us.get(AND + "targetSdkVersion", "")
    perms = [p.get(AND + "name", "") for p in root.findall("uses-permission") if p.get(AND + "name")]
    app = root.find("application")
    app_class = app.get(AND + "name", "") if app is not None else ""
    launchers = []
    if app is not None:
        acts = list(app.findall("activity")) + list(app.findall("activity-alias"))
        for act in acts:
            for intent in act.findall("intent-filter"):
                actions = [a.get(AND + "name") for a in intent.findall("action")]
                cats = [c.get(AND + "name") for c in intent.findall("category")]
                if "android.intent.action.MAIN" in actions and "android.intent.category.LAUNCHER" in cats:
                    launchers.append(act.get(AND + "targetActivity") or act.get(AND + "name"))
    emit(pkg, app_class, launchers, perms, vname, vcode, min_sdk, target_sdk, "decoded XML")

def parse_aapt(apk):
    out = ""
    for cmd in (["aapt", "dump", "xmltree", apk, "AndroidManifest.xml"],
                ["aapt2", "dump", "xmltree", "--file", "AndroidManifest.xml", apk]):
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
            if r.returncode == 0 and r.stdout.strip():
                out = r.stdout
                break
        except Exception:
            pass
    if not out:
        print("ERROR: could not decode the binary AndroidManifest via aapt/aapt2. "
              "Decompile the APK first (decode_apk) and point this tool at the decoded AndroidManifest.xml.")
        sys.exit(1)
    stack = []
    elements = []
    for line in out.splitlines():
        s = line.strip()
        ind = len(line) - len(line.lstrip())
        if s.startswith("E: "):
            tag = s[3:].split(" ", 1)[0]
            while stack and stack[-1]["indent"] >= ind:
                stack.pop()
            node = {"indent": ind, "tag": tag, "attrs": {}, "parent": stack[-1] if stack else None}
            stack.append(node)
            elements.append(node)
        elif s.startswith("A: ") and stack:
            body = s[3:]
            m = re.match(r"([^(=]+)", body)
            if not m:
                continue
            name = m.group(1).strip().split(":")[-1]
            vm = re.search(r'="([^"]*)"', body)
            stack[-1]["attrs"][name] = vm.group(1) if vm else ""
    def find(tag):
        return [e for e in elements if e["tag"] == tag]
    man = find("manifest")
    pkg = man[0]["attrs"].get("package", "") if man else ""
    vname = man[0]["attrs"].get("versionName", "") if man else ""
    vcode = man[0]["attrs"].get("versionCode", "") if man else ""
    us = find("uses-sdk")
    min_sdk = us[0]["attrs"].get("minSdkVersion", "") if us else ""
    target_sdk = us[0]["attrs"].get("targetSdkVersion", "") if us else ""
    perms = [e["attrs"].get("name", "") for e in find("uses-permission") if e["attrs"].get("name")]
    apps = find("application")
    app_class = apps[0]["attrs"].get("name", "") if apps else ""
    launchers = []
    for e in elements:
        if e["tag"] == "category" and e["attrs"].get("name") == "android.intent.category.LAUNCHER":
            intent = e["parent"]
            if intent and intent["tag"] == "intent-filter":
                has_main = any(c["parent"] is intent and c["tag"] == "action"
                               and c["attrs"].get("name") == "android.intent.action.MAIN" for c in elements)
                if has_main and intent["parent"]:
                    act = intent["parent"]
                    launchers.append(act["attrs"].get("targetActivity") or act["attrs"].get("name"))
    emit(pkg, app_class, launchers, perms, vname, vcode, min_sdk, target_sdk, "aapt xmltree")

if path.lower().endswith(".apk"):
    parse_aapt(path)
else:
    try:
        with open(path, "rb") as f:
            head = f.read(4)
    except OSError as e:
        print("ERROR: cannot open " + path + ": " + str(e))
        sys.exit(1)
    if head[:2] == b"\x03\x00":
        print("ERROR: this looks like a BINARY AndroidManifest.xml. Point this tool at the .apk itself, "
              "or at a decoded AndroidManifest.xml from decode_apk.")
        sys.exit(1)
    parse_text_xml()
'''


@registry.register(
    name="extract_manifest_info",
    description=(
        "Parses an AndroidManifest.xml and pulls out the facts you almost always need first: the PACKAGE NAME, "
        "the main APPLICATION class (android:name on <application>), and the LAUNCHER Activity (the one with a "
        "MAIN/LAUNCHER intent-filter, resolving activity-alias targetActivity). Also reports version, min/target "
        "SDK, and the declared permissions — as a compact summary, not the raw XML. "
        "Accepts EITHER a decoded AndroidManifest.xml (from decode_apk) OR a raw .apk (its binary manifest is "
        "decoded with aapt/aapt2 automatically). Relative names like '.MainActivity' are expanded to the full "
        "package-qualified class."
    ),
    params_schema={
        "manifest_path": "string (path to a decoded AndroidManifest.xml, OR to an .apk, relative to /workspace)"
    },
    output="A compact summary: package, application_class, launcher_activity (+ any other launchers), version, sdk levels, and permission list (first 40). If given a binary manifest with no aapt available, an error tells you to decompile first.",
    when_to_use="Use this right after decode_apk (or on the APK directly) to learn the package name, entry Application class, and launcher Activity — e.g. to know what to launch on the emulator, where the app bootstraps, or which component to target. For arbitrary manifest attributes not summarized here, read the decoded AndroidManifest.xml with read_file_chunk."
)
def extract_manifest_info(manifest_path):
    manifest_path = normalize_path(manifest_path)

    # Cache: the summary is a pure function of the target file's bytes (a decoded
    # AndroidManifest.xml OR an .apk). If that file is later edited its hash changes
    # and this misses — so a hit is always for the exact bytes summarized before.
    hit = cache.lookup("extract_manifest_info", manifest_path)
    if hit is not None:
        return hit

    script = _MANIFEST_SCRIPT.replace("__FILEPATH__", manifest_path)
    b64 = base64.b64encode(script.encode("utf-8")).decode("ascii")
    cmd = f"echo '{b64}' | base64 -d | python3 -"
    res = run_cmd(cmd, timeout=90)
    if isinstance(res, dict) and not res.get("error") and res.get("returncode") == 0 and res.get("stdout"):
        cache.store("extract_manifest_info", manifest_path, res)
    return res
