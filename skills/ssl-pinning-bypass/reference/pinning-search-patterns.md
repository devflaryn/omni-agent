# SSL/Certificate Pinning — Search Patterns & Bypass Snippets

## 1. Custom TrustManager (smali search_smali patterns)
- `X509TrustManager`
- `checkServerTrusted`
- `checkClientTrusted`
- `TrustManagerFactory`
- `SSLContext`

**Bypass**: replace the method body found with `patch_smali_method`:
```
.method public checkServerTrusted([Ljava/security/cert/X509Certificate;Ljava/lang/String;)V
    .locals 0
    return-void
.end method
```
(Match the exact signature of the method you found — parameter types must stay the same or the class won't verify.)

## 2. HostnameVerifier (smali search_smali patterns)
- `HostnameVerifier`
- `verify(Ljava/lang/String`
- `setHostnameVerifier`
- `ALLOW_ALL_HOSTNAME_VERIFIER`

**Bypass**:
```
.method public verify(Ljava/lang/String;Ljavax/net/ssl/SSLSession;)Z
    .locals 1
    const/4 v0, 0x1
    return v0
.end method
```

## 3. OkHttp CertificatePinner (smali search_smali patterns)
- `CertificatePinner`
- `okhttp3/CertificatePinner`
- `check$okhttp`
- `Builder;->add(`  (pin declarations, e.g. `.pin("sha256/...")`)

**Bypass**: find the `check` (or `check$okhttp`) method with `search_smali`, `read_file_chunk` to see its exact signature, then `patch_smali_method` it to `return-void` immediately (same shape as the TrustManager bypass above, adjusted to CertificatePinner's actual parameter types).

## 4. network_security_config.xml (resource, not smali)
1. `grep_file` on `AndroidManifest.xml` for `networkSecurityConfig` to get the referenced file, e.g. `@xml/network_security_config` → `res/xml/network_security_config.xml`.
2. `read_file_chunk` that file. Look for `<pin-set>` blocks like:
   ```xml
   <pin-set expiration="2027-01-01">
       <pin digest="SHA-256">AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=</pin>
   </pin-set>
   ```
3. `write_file` the file back WITHOUT the `<pin-set>` element, or add a `<trust-anchors>` entry trusting user-installed certs:
   ```xml
   <network-security-config>
       <base-config cleartextTrafficPermitted="false">
           <trust-anchors>
               <certificates src="system"/>
               <certificates src="user"/>
           </trust-anchors>
       </base-config>
   </network-security-config>
   ```
4. If the manifest has NO `networkSecurityConfig` attribute at all, this surface doesn't apply — don't add one speculatively unless the user specifically wants to trust a proxy CA at the OS level.

## Native pinning hints
`extract_strings` filter patterns worth trying on `.so` files: `pin`, `X509`, `SSL_CTX_set_verify`, `sha256/`, a literal base64 hash fragment copied from a code-level pin you already found (native code sometimes duplicates the same pin as a fallback).
