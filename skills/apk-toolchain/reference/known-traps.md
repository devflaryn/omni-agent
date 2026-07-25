# Known APK-modding traps (verified the hard way)

Concrete failure modes seen in real runs on this project's targets, with the fix.
Read this before a Roblox/Arceus-style native-app mod so you don't rediscover
them one wasted hour at a time.

## 1. "Anti-tamper" is usually not the problem — re-signing is the fix

The reflex on a native game APK is to hunt a native integrity check and patch it.
On the Roblox target that was a **dead end and a huge time sink**: the plain,
re-signed APK **launched fine with NO native patch**. Order of operations:

1. Make your edits, `recompile_apk`, `sign_apk`, `verify_apk`.
2. **Install and launch it as-is. Observe whether it actually crashes.**
3. Only if it genuinely crashes on integrity — SIGABRT/SIGSEGV/SIGILL soon after
   launch, or a logcat integrity/hash message — do you go native.

Do not patch `libX.so` on the *assumption* it will crash. Confirm the symptom first.

### Native patches that BREAK the app (look like anti-tamper, aren't)
Patching a `bl` to `RET` / NOP inside `JNI_OnLoad` can knock out
`RegisterNatives`, giving `UnsatisfiedLinkError: No implementation found for
native method …`. That is **your patch breaking JNI registration**, not the app
defending itself. If a native patch turns a working app into an
`UnsatisfiedLinkError`, revert it — you hit the registration path, not a check.

## 2. `sign_apk` takes `apk_filename`, not `apk_path`

```
sign_apk(apk_filename="/workspace/app-modified.apk")   # correct
sign_apk(apk_path=...)                                  # WRONG — unknown arg
```
`verify_apk` and `replace_file_in_apk` also use `apk_filename`.

## 3. Inner-class smali files contain `$` — don't let the shell eat it

Files like `AXWebViewController$1.smali`, `CrashHandler$1.smali` have a literal
`$`. Creating them via a tool that goes through shell expansion can drop or
mangle the name (you get `AXWebViewController.smali` or an empty file). Fixes:
- Write via a **single-quoted heredoc** so nothing expands:
  `run_command("cat > 'com/axjava/AXWebViewController\$1.smali' <<'EOF'\n…\nEOF")`
  — quote the delimiter (`<<'EOF'`) and the filename.
- Verify each file exists and is non-empty afterward (`ls -l`, `grep .class`).
The inner-class name in the file (`Lcom/axjava/AXWebViewController$1;`) must match
the filename, so you can't just rename the `$` away.

## 4. Assembling a dex when the tool "finds 0 smali files"

If `assemble_dex(smali_dir, output_dex)` reports zero inputs, the directory root
usually isn't where it expects the package tree to start. Fall back to the CLI:
`run_command("smali assemble /workspace/axjava_smali -o /workspace/classes4.dex")`.
Common smali assembly errors and fixes:
- `missing .end annotation` → add the closing `.end annotation`.
- `mismatched input '0x80000000' expecting REGISTER` → a huge literal used where a
  register is expected; simplify the call (e.g. build the `LayoutParams(-1,-1)`
  form instead of passing raw flag constants inline).

## 5. Adding a new dex — put it in the tree AND verify the count

After building `classes4.dex`, add it to the decoded tree (or
`replace_file_in_apk(apk_filename=…, entry_path="classes4.dex",
replacement_file="/workspace/classes4.dex")`). Then **`inspect_apk` the built
APK** and confirm the dex count is what you intended. A dex that silently didn't
make it in installs fine but is missing your code (see
android-package-anatomy › Multidex).

## 6. App-startup injection point

To run your code at launch, inject a static call early in the app's startup
class — for Roblox that's a call in `ActivitySplash.onCreate` (right after the
`.locals` line) or the `Application` subclass. `inject_session_bootstrap`
automates the session/cookie bootstrap into the `Application` class; a manual
`invoke-static {p0}, Lcom/axjava/Main;->Start(Landroid/content/Context;)V`
covers a custom entry point. Verify the injected line with `grep_file` before
rebuilding.

## 7. Emulator account targeting

Emulator tools operate on a specific account/instance. If the account that holds
the cookie session (e.g. a saved farming account) differs from the default one
the tool drives, installing/launching your APK on the default instance won't use
that session, and installing over a pre-existing signed Roblox gives
`INSTALL_FAILED_UPDATE_INCOMPATIBLE` (signature mismatch) —
`DELETE_FAILED_INTERNAL_ERROR` if it's kiosk-pinned. Use the emulator-management
skill for cookie login / choosing the account / place-id launch rather than
fighting the default-account tools.
