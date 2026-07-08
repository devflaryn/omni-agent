"""Android APK lifecycle tools.

Everything related to unpacking, decoding, rebuilding and re-signing APKs,
plus smali search and signature extraction. These are the core tools used by
the Android Reverse Engineer profile's "APK MODIFICATION WORKFLOW".

Reorganized out of the original ``reverse_engineering.py`` so APK tooling
lives in one focused, readable module.
"""

from tool_registry import registry
from tools.common import normalize_path
from docker_sandbox import run_cmd


# ---------------------------------------------------------------------------
# Unpack / decode
# ---------------------------------------------------------------------------

@registry.register(
    name="unzip_apk",
    description="Unzips an APK file to extract its raw contents (assets, lib, META-INF, etc). Use this as the FIRST step when you only need to add/remove/replace whole files or folders (e.g. deleting lib/x86, lib/x86_64, lib/armeabi-v7a). After editing, use repack_apk (NOT build_apk) to rebuild, then sign_apk.",
    params_schema={"apk_filename": "string (relative or absolute starting with /workspace)", "output_dir": "string"},
    output="The stdout/stderr of the unzip command listing every file extracted. If the APK is large this can take a moment. Returns an error dict if the APK path is wrong.",
    when_to_use="Use this when you need to modify WHOLE files inside the APK (swap a .so, delete an arch folder, replace an asset) and you do NOT need to edit smali/XML/manifest. For smali or resource edits, use decompile_apk instead."
)
def unzip_apk(apk_filename, output_dir):
    apk_filename = normalize_path(apk_filename)
    output_dir = normalize_path(output_dir)
    cmd = f"unzip -o /workspace/{apk_filename} -d /workspace/{output_dir}"
    return run_cmd(cmd, timeout=240)


@registry.register(
    name="decompile_apk",
    description="Decompiles an APK using apktool to get readable AndroidManifest.xml and smali source code. Use this ONLY when you need to edit smali, XML resources, or AndroidManifest.xml. For whole-file edits (lib folders, assets, .so files) use unzip_apk instead.",
    params_schema={"apk_filename": "string", "output_dir": "string", "no_resources": "boolean (optional, set to true if you get framework resource errors)"},
    output="apktool's decompile log showing each resource/smali file being decoded. The output_dir will contain AndroidManifest.xml, smali/ folders, res/, and apktool.yml. Can take several minutes on large APKs. NEXT STEP for anything non-trivial: run build_code_graph on output_dir ONCE, then navigate with query_code_graph — do NOT start reading smali files one by one.",
    when_to_use="Use this when you need to READ or EDIT Dalvik bytecode (smali), AndroidManifest.xml, or XML resources. If you only need to swap/delete whole files (like .so libs), unzip_apk is much faster. Right after decompiling a real app, build_code_graph on the output dir so you can query_code_graph instead of sweeping thousands of smali files."
)
def decompile_apk(apk_filename, output_dir, no_resources=False):
    apk_filename = normalize_path(apk_filename)
    output_dir = normalize_path(output_dir)
    res_flag = "-r " if no_resources else ""
    cmd = f"apktool d {res_flag}-f /workspace/{apk_filename} -o /workspace/{output_dir}"
    return run_cmd(cmd, timeout=420)  # apktool on large APKs can take several minutes


@registry.register(
    name="jadx_decompile",
    description=(
        "Decompiles an APK (or a .dex/.jar) to READABLE JAVA source using jadx. "
        "This is for UNDERSTANDING code, not for rebuilding — jadx Java is much easier to read than smali, "
        "especially in large or obfuscated apps. Use it to reverse-engineer app logic, then make the actual "
        "edit in smali via decompile_apk + patch_smali_method (you cannot recompile jadx's Java back into the APK). "
        "Set deobf=true to have jadx rename obfuscated a/b/c identifiers to stable readable names — very helpful on "
        "R8/ProGuard-obfuscated apps. Output goes to output_dir/sources (Java) and output_dir/resources. "
        "Read individual .java files with read_file_chunk, or search across them with grep_directory / find_files."
    ),
    params_schema={
        "apk_filename": "string (path to the APK/.dex/.jar, relative or absolute starting with /workspace)",
        "output_dir": "string (directory to write decompiled Java + resources to)",
        "deobf": "boolean (optional, default false; true renames obfuscated identifiers to stable readable names)",
        "no_resources": "boolean (optional, default false; true skips resource decoding for a faster, Java-only run)",
        "single_class": "string (optional; decompile only this fully-qualified class, e.g. 'com.example.Foo', for a fast targeted look)"
    },
    output="jadx's decompile log (it keeps going past individual class errors, which is normal for obfuscated apps). The output_dir gets a 'sources/' tree of .java files (by package) and, unless no_resources, a 'resources/' tree. Can take several minutes on large APKs; the first pass is the slow one.",
    when_to_use="Use this to READ an app's Java/Kotlin logic when smali is too tedious — tracing a feature, understanding an obfuscated check, or getting oriented in a large codebase. Pair with grep_directory to search the Java. For the edit itself, still use decompile_apk (smali) + build_apk, since jadx output isn't recompilable."
)
def jadx_decompile(apk_filename, output_dir, deobf=False, no_resources=False, single_class=None):
    apk_filename = normalize_path(apk_filename)
    output_dir = normalize_path(output_dir)
    flags = []
    if deobf in (True, "true", "True", 1, "1"):
        flags.append("--deobf")
    if no_resources in (True, "true", "True", 1, "1"):
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
    return run_cmd(cmd, timeout=600)


# ---------------------------------------------------------------------------
# Rebuild / sign
# ---------------------------------------------------------------------------

@registry.register(
    name="repack_apk",
    description="Repacks a raw extracted APK directory (created by unzip_apk) into an unsigned APK using zip. Use this AFTER unzip_apk-based edits such as removing lib folders or replacing assets. Then call sign_apk. Do NOT use this on directories created by decompile_apk.",
    params_schema={"input_dir": "string (path to the raw extracted APK directory)", "output_apk": "string (output apk filename)"},
    output="The zip command log showing files being added to the APK. Old META-INF signatures are removed first. The output APK is unsigned — you must call sign_apk next.",
    when_to_use="Use this to rebuild an APK from a directory that was created by unzip_apk (raw extracted contents). For directories created by decompile_apk (which have apktool.yml), use build_apk instead."
)
def repack_apk(input_dir, output_apk):
    input_dir = normalize_path(input_dir)
    output_apk = normalize_path(output_apk)
    cmd = (
        f"cd /workspace/{input_dir} && "
        # Remove old signatures so apksigner doesn't clash or fail
        "rm -f META-INF/*.RSA META-INF/*.SF META-INF/*.DSA META-INF/MANIFEST.MF && "
        # Build a fresh APK with correct compression: store uncompressed the file types Android requires uncompressed
        f"zip -r -X /workspace/{output_apk} . -x '*.DS_Store' '*.so' '*.arsc' '*.png' '*.jpg' '*.jpeg' '*.webp' '*.mp3' '*.mp4' '*.ogg' '*.wav' && "
        f"zip -r -X -0 /workspace/{output_apk} . -i '*.so' '*.arsc' '*.png' '*.jpg' '*.jpeg' '*.webp' '*.mp3' '*.mp4' '*.ogg' '*.wav'"
    )
    return run_cmd(cmd, timeout=240)


@registry.register(
    name="build_apk",
    description="Builds an APK from an apktool-decompiled directory using apktool. ONLY use this on directories created by decompile_apk (which contain apktool.yml). If the directory was created by unzip_apk, use repack_apk instead. Call this AFTER making smali/resource/manifest modifications.",
    params_schema={"input_dir": "string (path to the apktool-decompiled directory)", "output_apk": "string (output apk filename)"},
    output="apktool's build log. If apktool.yml is missing (i.e. the dir was made by unzip_apk), returns an explicit error telling you to use repack_apk instead. The output APK is unsigned — call sign_apk next.",
    when_to_use="Use this to rebuild an APK from a decompiled directory AFTER you have edited smali, resources, or AndroidManifest.xml. For raw-extracted dirs (unzip_apk), use repack_apk."
)
def build_apk(input_dir, output_apk):
    input_dir = normalize_path(input_dir)
    output_apk = normalize_path(output_apk)

    # Guard: apktool needs apktool.yml. If it's missing, the directory was probably created by
    # unzip_apk, in which case apktool b will fail. Steer the agent toward repack_apk instead.
    check_cmd = f"test -f /workspace/{input_dir}/apktool.yml"
    check_res = run_cmd(check_cmd, timeout=10)
    if check_res["returncode"] != 0:
        return {
            "stdout": "",
            "stderr": "",
            "error": (
                f"Directory '/workspace/{input_dir}' is not an apktool-decompiled directory "
                "(apktool.yml is missing). If you extracted the APK with unzip_apk, use repack_apk instead of build_apk."
            )
        }

    cmd = f"apktool b /workspace/{input_dir} -o /workspace/{output_apk}"
    return run_cmd(cmd, timeout=300)


@registry.register(
    name="sign_apk",
    description=(
        "Zipaligns and signs an APK using apksigner with a default debug keystore. "
        "Call this AFTER build_apk or repack_apk to produce a runnable APK. "
        "Uses v1+v2+v3 signing schemes for maximum Android version compatibility. "
        "IMPORTANT: After signing, ALWAYS call verify_apk to confirm the APK is valid before reporting it as done."
    ),
    params_schema={"apk_filename": "string (path to the built apk)"},
    output="The zipalign + apksigner command logs. On success the APK is signed and ready to install. A debug keystore is auto-created if none exists.",
    when_to_use="ALWAYS call this after build_apk or repack_apk to make the APK installable. Follow it with verify_apk to confirm validity."
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
    base = f"unzip -l /workspace/{apk_filename}"
    if filter_pattern:
        base += f" | grep -i '{filter_pattern}'"
    res = run_cmd(base, timeout=30)
    if res["returncode"] == 0 or res.get("stdout"):
        return {"stdout": f"=== Contents of {apk_filename} ===\n" + res.get("stdout", "")}
    return res


# ---------------------------------------------------------------------------
# Smali search / signature extraction
# ---------------------------------------------------------------------------

@registry.register(
    name="search_smali",
    description=(
        "Searches all .smali files in a decompiled APK directory for a pattern (regex). "
        "Use this to find signature verification code, anti-tamper checks, or any Dalvik bytecode references. "
        "Common patterns to search for: 'getPackageManager', 'GET_SIGNATURES', 'signatures', "
        "'PackageManager', 'verify', 'certificate', 'checksum', 'integrity', 'signature'. "
        "Returns file paths and matching lines."
    ),
    params_schema={
        "decompiled_dir": "string (path to the apktool-decompiled directory)",
        "pattern": "string (regex pattern to search for)",
        "max_results": "integer (optional, default 50)"
    },
    output="Each matching line as 'filepath:line_number: <matching smali line>'. Results are capped at max_results. If nothing matches, grep returns exit 1 which is normal (no error).",
    when_to_use="Use this to find signature verification code, anti-tamper checks, API calls, or any Dalvik bytecode pattern across all smali files. Common patterns: 'getPackageManager', 'GET_SIGNATURES', 'verify', 'checksum', 'integrity'."
)
def search_smali(decompiled_dir, pattern, max_results=50):
    decompiled_dir = normalize_path(decompiled_dir)
    cmd = f"grep -rn '{pattern}' /workspace/{decompiled_dir} --include='*.smali' | head -n {max_results}"
    return run_cmd(cmd, timeout=120)


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
    cmd = (
        f"cd /tmp && "
        f"unzip -o /workspace/{apk_path} 'META-INF/*.RSA' -d /tmp/sig_extract >/dev/null 2>&1 && "
        f"keytool -printcert -file /tmp/sig_extract/META-INF/*.RSA 2>/dev/null && "
        f"rm -rf /tmp/sig_extract"
    )
    return run_cmd(cmd, timeout=30)
