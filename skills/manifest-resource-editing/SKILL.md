---
name: manifest-resource-editing
description: Edit AndroidManifest.xml (permissions, exported flags, application attributes) and apktool-decoded resources (res/values, res/xml) safely.
when_to_use: Use this skill when the user wants to add/remove a permission, change android:exported or android:debuggable, point the app at a network security config, edit strings.xml or another values resource, or otherwise change AndroidManifest.xml / res/*.xml content rather than smali logic.
allowed-tools: decompile_apk, grep_file, read_file_chunk, write_file, list_directory, build_apk, sign_apk, verify_apk
---

# Manifest & Resource Editing Skill

## Step 1 — Decompile first, always
`decompile_apk` (never `unzip_apk`) for any manifest or XML-resource edit. `unzip_apk` leaves `AndroidManifest.xml` in Android's compiled binary XML format, which is not human-editable; `decompile_apk` (via apktool) converts it to readable text XML and decodes `resources.arsc` into `res/values/*.xml`.

## Step 2 — Find the exact block to change
Use `grep_file` on `AndroidManifest.xml` for the attribute or tag you're after:
- Permissions: `uses-permission`
- Component export flags: `android:exported`
- App-level flags: `android:debuggable`, `android:usesCleartextTraffic`, `android:networkSecurityConfig`, `android:allowBackup`
- A specific activity/service/receiver/provider by its `android:name`

For values resources, `grep_file` the specific file under `res/values/` (e.g. `strings.xml`) for the resource name (e.g. `name="app_name"`).

Then `read_file_chunk` to see the full surrounding element before editing — manifest attributes are easy to misplace on the wrong tag (application-level vs. activity-level).

## Step 3 — Edit and write back
There is no line-patch tool for XML — `write_file` replaces a file's entire content. So: read the full file (it's normally small), construct the corrected complete text, and `write_file` it back in one shot. Double-check XML stays well-formed (matching tags, proper attribute quoting) since apktool's build step will fail on malformed XML.

### Adding a new resource file (e.g. a network security config)
1. `write_file` the new file under the correct `res/` subdirectory (e.g. `res/xml/network_security_config.xml`) — the directory determines the resource type, and the filename (without extension) becomes the resource name.
2. Reference it from the manifest with the matching `@xml/<filename>` (or `@string/`, `@drawable/`, etc. for other resource types).
3. `list_directory` on `res/xml/` to confirm the file landed where expected before rebuilding.

## Step 4 — Rebuild, sign, verify
`build_apk` (this is a decompile_apk-produced directory, so NEVER `repack_apk`) → `sign_apk` → `verify_apk`.

## Critical Rules
- Never hand-edit a binary `AndroidManifest.xml` extracted via `unzip_apk` — always `decompile_apk` first for manifest/resource work.
- A resource referenced from the manifest (e.g. `@xml/network_security_config`) must exist with a matching filename under the right `res/` subfolder, or the app will fail at runtime with a resource-not-found error that apktool's build step won't catch for you.
- Adding a permission to the manifest does not guarantee the app treats it as granted at runtime on API 23+ (runtime permissions) — if the app also does a runtime permission check in code, that's a smali-level change outside this skill's scope; treat it like any other behavioral check (see `signature-bypass` / `anti-debug-bypass` for the general pattern of patching a check's outcome).
- Changing `android:debuggable` to `true` can help with dynamic analysis but also changes the APK's attack surface — flag this explicitly to the user rather than doing it silently as a side effect of an unrelated edit.
