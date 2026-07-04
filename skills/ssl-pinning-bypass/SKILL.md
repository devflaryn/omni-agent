---
name: ssl-pinning-bypass
description: Find and neutralize certificate/SSL pinning in an Android APK so the app accepts a proxy or self-signed certificate — covers Java TrustManager/HostnameVerifier code, OkHttp CertificatePinner, network_security_config.xml, and native pinning.
when_to_use: Use this skill when the user wants to intercept/proxy an app's HTTPS traffic, needs to bypass "certificate pinning" or "SSL pinning" errors, or reports that a modified/re-signed APK fails to connect only over HTTPS (a strong signal of pinning rather than signature verification).
allowed-tools: decompile_apk, search_smali, grep_file, read_file_chunk, write_file, patch_smali_method, build_apk, sign_apk, verify_apk
---

# SSL / Certificate Pinning Bypass Skill

Android apps validate TLS certificates in up to four independent places. You must check ALL of them — patching only one usually still leaves the connection blocked.

## Step 1 — Decompile
`decompile_apk` is required — pinning logic lives in smali and in XML resources, not in whole files you could just swap. If the app is large, build a code graph first (see `code-graph-analysis`) so `string_refs` and `search_smali` stay fast.

## Step 2 — Sweep all four pinning surfaces
Load `reference/pinning-search-patterns.md` for the exact `search_smali` patterns and example bypass smali for each of:
1. Custom `X509TrustManager` / `checkServerTrusted` overrides
2. `HostnameVerifier` overrides
3. OkHttp's `CertificatePinner`
4. `network_security_config.xml` `<pin-set>` declarations

Check the AndroidManifest for `android:networkSecurityConfig="@xml/..."` with `grep_file` — if present, that XML file (under `res/xml/`) is a pinning surface even if you find no code-level pinning at all.

## Step 3 — Patch each surface found
- **TrustManager**: replace `checkServerTrusted` (and `checkClientTrusted` if present) with an empty method body (`.method ... checkServerTrusted(...)V` / `return-void`) so it never throws.
- **HostnameVerifier**: replace `verify(...)Z` to always `const/4 v0, 0x1` + `return v0`.
- **CertificatePinner**: `patch_smali_method` on the `check` method (or `check$okhttp`) to return immediately without throwing.
- **network_security_config.xml**: `read_file_chunk` the file, then `write_file` a version with the `<pin-set>` element removed (or `<trust-anchors><certificates src="user"/></trust-anchors>` added so a proxy's user-installed CA is trusted).

## Step 4 — Native pinning (if code-level patches don't fix it)
If strings like `X509`, `SSL_CTX`, `pin`, or specific certificate hashes show up in a `.so` (`extract_strings`), the check is native — switch to the `native-patching` skill to force the verification function to return success.

## Step 5 — Rebuild, sign, verify
`build_apk` → `sign_apk` → `verify_apk` (see `apk-modding`).

## Critical Rules
- Patch ALL FOUR surfaces you find evidence of, not just the first one. Apps commonly combine an OkHttp `CertificatePinner` with a `network_security_config.xml` fallback.
- If the manifest references a `network_security_config.xml` that doesn't yet exist in `res/xml/`, don't invent pinning there — check first with `grep_file`/`list_directory` before assuming it's a factor.
- This agent only performs STATIC patching of the APK. It cannot run the app or a live MITM proxy — if the user needs a live interception setup (Frida script, mitmproxy config), say so explicitly rather than guessing whether the static patch alone is sufficient.
