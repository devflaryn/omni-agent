# Signature / Anti-Tamper Search Patterns

Try each of these with `search_smali` (they're regex patterns, so combine related ones with `|`, e.g. `getPackageManager|GET_SIGNATURES`). Also try the native equivalents with `extract_strings` on any .so files.

## Signature verification (smali)
- `getPackageManager`
- `GET_SIGNATURES`
- `getPackageInfo`
- `signatures`
- `verifySignature`
- `checkSignature`
- `PackageManager`
- `GET_SIGNING_CERTIFICATES`
- `PackageInfoCompat`

## Anti-tamper / integrity checks (smali)
- `checksum`
- `integrity`
- `tamper`
- `hash`
- `digest`
- `MessageDigest`
- `SHA`
- `MD5`
- `verifyIntegrity`
- `checkIntegrity`
- `crc32` / `CRC32`

## Root / emulator detection (smali) — often bundled with signature checks
- `Superuser`
- `test-keys`
- `RootBeer`
- `/system/bin/su`
- `isEmulator`
- `Build.FINGERPRINT`

## Native-layer equivalents (use `extract_strings` on the .so, filter_pattern set to any of these)
- `signature`
- `verify`
- `cert`
- `tamper`
- `checksum`
- `sha1` / `sha256`

## What to do with a hit
1. `read_file_chunk` around the matching line to see the full method.
2. Decide whether the method itself should always return the "safe" value (patch the method body) or whether a specific comparison inside a bigger method should be neutralized (patch just the branch — turn `if-eqz`/`if-nez` into an unconditional path, or replace the comparison operands).
3. If the check calls into a native function to compute the actual hash/signature, that native function is the real target — switch to `native-patching` for it once you have its symbol name and address.
